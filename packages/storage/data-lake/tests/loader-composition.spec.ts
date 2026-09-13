import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import DataLake, { LakeId } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-data-lake-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n').replace('OWNED_ROOT', JSON.stringify(root)))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-data-lake', DataLake]])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('data lake through Loader', () => {
  it('mounts configured lakes and persists a root map', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-data-lake'",
      '  config:',
      '    lakes:',
      '      - id: documents',
      '        root: OWNED_ROOT',
      '        maxEntries: 10',
    ])
    expect(loaded.dataLake.list()[0]?.id).toBe('documents')
    const catalog = await loaded.dataLake.scan(LakeId('documents'))
    expect(catalog.index.map(entry => entry.path)).toEqual(['cordis.yml'])
    expect((await loaded.dataLake.directory(LakeId('documents'), ''))?.map.entries[0]?.name).toBe('cordis.yml')
    await expect(loaded.dataLake.catalog(LakeId('missing'))).rejects.toThrow('unknown lake')
  })
})
