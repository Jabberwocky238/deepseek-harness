import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DataLake, { LakeId } from '../src/index.ts'
import { LakeIndexer } from '../src/catalog.ts'
import { DiskLakeSource } from '../src/disk.ts'
import { INDEX_PATH } from '../src/records.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lake-'))
  roots.push(root)
  const source = new DiskLakeSource(root)
  return { root, source, indexer: new LakeIndexer(source, { kind: 'disk', path: root }, 100), signal: new AbortController().signal }
}

describe('colocated directory maps', () => {
  it('indexes all levels, locates maps, preserves summaries on unchanged scans, and invalidates ancestors on change', async () => {
    const { root, indexer, signal } = await fixture()
    await mkdir(join(root, 'a/empty'), { recursive: true })
    await writeFile(join(root, 'a/note.txt'), 'first')
    await writeFile(join(root, 'root.txt'), 'root')
    const first = await indexer.scan(signal)
    expect(first.maps.map(map => map.directory)).toEqual(['', 'a/', 'a/empty/'])
    const a = (await indexer.directory('a/', signal))!
    expect(a.map.entries.map(entry => entry.path)).toEqual(['a/empty/', 'a/note.txt'])
    expect(a.summary).toBeNull()
    const location = first.maps.find(map => map.directory === 'a/')!
    expect(JSON.parse(await readFile(join(root, location.mapPath), 'utf8')).path).toBe('a/')
    await indexer.summarize('a/', a.map.revision, 'One note and an empty directory.', signal)
    const originalRoot = (await indexer.directory('', signal))!
    await indexer.summarize('', originalRoot.map.revision, 'Root contents.', signal)
    expect(await indexer.scan(signal)).toEqual(first)
    expect((await indexer.directory('a/', signal))!.summary?.text).toBe('One note and an empty directory.')
    await writeFile(join(root, 'a/note.txt'), 'second and longer')
    await rm(join(root, 'root.txt'))
    await indexer.scan(signal)
    const updated = (await indexer.directory('a/', signal))!
    expect(updated.map.changes).toEqual([{ path: 'a/note.txt', kind: 'modified' }])
    expect(updated.map.previousSummary?.text).toBe('One note and an empty directory.')
    expect(updated.summary).toBeNull()
    expect((await indexer.directory('', signal))!.summary).toBeNull()
    expect((await indexer.catalog(signal))!.index.some(entry => entry.path.includes('.dsh-data-lake'))).toBe(false)
    await expect(indexer.summarize('a/', a.map.revision, 'stale', signal)).rejects.toThrow('stale')
    expect((await indexer.catalog(signal))!.index.some(entry => entry.path === 'root.txt')).toBe(false)
  })

  it('does not publish an incomplete scan, and rejects traversal and corrupt map references', async () => {
    const { root, source, indexer, signal } = await fixture()
    await indexer.scan(signal)
    const before = await readFile(join(root, INDEX_PATH), 'utf8')
    await writeFile(join(root, 'one'), '1')
    await writeFile(join(root, 'two'), '2')
    const limited = new LakeIndexer(source, { kind: 'disk', path: root }, 1)
    await expect(limited.scan(signal)).rejects.toThrow('maxEntries')
    expect(await readFile(join(root, INDEX_PATH), 'utf8')).toBe(before)
    await expect(indexer.directory('../', signal)).rejects.toThrow('relative path')
    const broken = JSON.parse(before)
    broken.maps[0].mapPath = '../secret.json'
    await writeFile(join(root, INDEX_PATH), JSON.stringify(broken))
    await expect(indexer.catalog(signal)).rejects.toThrow('map location')
  })

  it('indexes symlinks without following them and refuses metadata symlinks', async () => {
    const { root, indexer, signal } = await fixture()
    const external = await fixture()
    await symlink(external.root, join(root, 'outside'), 'junction')
    const catalog = await indexer.scan(signal)
    expect(catalog.index.map(entry => entry.kind)).toEqual(['symlink'])
    expect(catalog.maps).toHaveLength(1)
    await rm(join(root, '.dsh-data-lake'), { recursive: true })
    await symlink(external.root, join(root, '.dsh-data-lake'), 'junction')
    await expect(indexer.scan(signal)).rejects.toThrow('symlink')
  })

  it('keeps two lakes independent through the same service and rejects work after disposal', async () => {
    const a = await fixture()
    const b = await fixture()
    await writeFile(join(a.root, 'alpha'), 'a')
    await writeFile(join(b.root, 'beta'), 'b')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(DataLake, { lakes: [
      { id: 'a', root: a.root, maxEntries: 100 }, { id: 'b', root: b.root, maxEntries: 100 },
    ] })
    const service = ctx.dataLake
    expect(service.list().map(lake => lake.id)).toEqual(['a', 'b'])
    await Promise.all([service.scan(LakeId('a')), service.scan(LakeId('b'))])
    expect((await service.catalog(LakeId('a')))!.index.map(entry => entry.path)).toEqual(['alpha'])
    expect((await service.catalog(LakeId('b')))!.index.map(entry => entry.path)).toEqual(['beta'])
    await expect(service.catalog(LakeId('missing'))).rejects.toThrow('unknown lake')
    await ctx.fiber.dispose()
    await expect(service.scan(LakeId('a'))).rejects.toThrow('disposed')
  })
})
