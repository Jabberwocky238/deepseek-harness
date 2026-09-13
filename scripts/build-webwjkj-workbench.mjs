/** Compile the checked-in VS Code UI source; no patching, downloads, or extension compilation. */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyWorkbenchSource } from './webwjkj-workbench-source.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(repo, 'packages/bundle/webwjkj/lib/workbench')
const result = await build({
  absWorkingDir: repo, entryPoints: { ui: 'vendor/webwjkj/vscode/src/vs/webwjkj/ui.ts' },
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outdir: output, write: false, metafile: true,
  loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]',
})
const inputs = Object.keys(result.metafile.inputs).sort()
const externals = Object.values(result.metafile.outputs).flatMap(item => item.imports.filter(item => item.external).map(item => item.path))
verifyWorkbenchSource(inputs, externals)
const files = Object.fromEntries(result.outputFiles.map(file => [relative(output, file.path), createHash('sha256').update(file.contents).digest('hex')]))
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const file of result.outputFiles) await writeFile(file.path, file.contents)
await writeFile(resolve(output, 'ui-build.json'), JSON.stringify({ mode: 'ui-only', inputs, files }, null, 2) + '\n')
await cp(resolve(repo, 'packages/bundle/webwjkj/src/client/style.css'), resolve(output, '../client.css'))
console.log(`Built ${inputs.length} UI source files into ${output}; no workbench, editor engine, extension host, or server dependencies.`)
