/** Exact asset admission for the source-built UI bundle. */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

const manifest = z.object({ mode: z.literal('ui-only'), inputs: z.array(z.string()).min(1), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) })
/**
 * Validate and load the complete UI asset allowlist; old workbench and extension URLs are absent.
 * @param root - directory compiled directly from the checked-in UI source.
 * @returns reader serving only admitted, digest-verified UI assets.
 */
export async function workspaceAssets(root: string): Promise<(path: string) => Promise<{ content: Buffer; type: string } | undefined>> {
  const base = await realpath(root)
  const build = manifest.parse(JSON.parse(await readFile(resolve(base, 'ui-build.json'), 'utf8')))
  if (build.inputs.some(file => !/^vendor\/webwjkj\/vscode\/src\/vs\/(?:base\/(?:browser|common)\/|nls(?:\.messages)?\.ts$|webwjkj\/ui\.ts$)/.test(file))) throw new Error('Non-UI source in workbench build')
  if (!build.files['ui.js'] || !build.files['ui.css']) throw new Error('Missing UI assets')
  const assets = new Map<string, { content: Buffer; type: string }>()
  for (const [file, digest] of Object.entries(build.files)) {
    if (!/^(?:ui\.(?:js|css)|codicon-[A-Z0-9]+\.ttf)$/.test(file)) throw new Error('Non-UI asset in workbench build')
    const path = await realpath(resolve(base, file))
    if (!path.startsWith(base + sep)) throw new Error('UI asset escapes build directory')
    const content = await readFile(path)
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('UI asset digest mismatch')
    assets.set(`/workspace/ui/${file}`, { content, type: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'font/ttf' })
  }
  return path => Promise.resolve(assets.get(path))
}
