/** Asset admission rejects complete-workbench builds and files outside the UI manifest. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { workspaceAssets } from '../src/workspace-assets.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('serves only digest-verified UI outputs and rejects extension, remote, and filesystem paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webwjkj-ui-')); roots.push(root)
  const build = join(root, 'build'); await mkdir(build)
  const contents = { 'ui.js': 'export const ui = true;', 'ui.css': ':root{}' }
  for (const [file, text] of Object.entries(contents)) await writeFile(join(build, file), text)
  const metadata = { mode: 'ui-only', inputs: ['vendor/webwjkj/vscode/src/vs/webwjkj/ui.ts'], files: Object.fromEntries(Object.entries(contents).map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')])) }
  const marker = join(build, 'ui-build.json'); await writeFile(marker, JSON.stringify(metadata))
  const read = await workspaceAssets(build)
  expect((await read('/workspace/ui/ui.js'))?.content.toString()).toBe(contents['ui.js'])
  for (const path of ['/workspace/ui/../private.json', '/workspace/ui/%2e%2e/private.json', '/workspace/extension/extension.js', '/workspace/code-server/out/vs/workbench/workbench.web.main.internal.js', '/workspace/ui/terminal.js']) expect(await read(path)).toBeUndefined()
  await writeFile(marker, JSON.stringify({ ...metadata, inputs: ['vendor/webwjkj/vscode/src/vs/workbench/workbench.common.main.ts'] }))
  await expect(workspaceAssets(build)).rejects.toThrow('Non-UI source')
  await writeFile(marker, JSON.stringify({ ...metadata, files: { ...metadata.files, 'extension.js': metadata.files['ui.js'] } }))
  await expect(workspaceAssets(build)).rejects.toThrow('Non-UI asset')
  await writeFile(marker, JSON.stringify(metadata))
  await writeFile(join(build, 'ui.js'), 'changed')
  await expect(workspaceAssets(build)).rejects.toThrow('digest mismatch')
  await rm(join(build, 'ui.js'))
  await writeFile(join(root, 'private.js'), contents['ui.js'])
  await symlink(join(root, 'private.js'), join(build, 'ui.js'))
  await expect(workspaceAssets(build)).rejects.toThrow('escapes build directory')
})
