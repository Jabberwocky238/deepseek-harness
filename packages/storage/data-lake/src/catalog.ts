/**
 * Catalog publication and revision-bound agent summaries over a lake source.
 * @module @deepseek-ai/dsh-data-lake/catalog
 */
import { createHash } from 'node:crypto'
import { catalogSchema, INDEX_PATH, lakePath, mapSchema, METADATA, summarySchema } from './records.ts'
import type { LakeCatalog, LakeChange, LakeDirectoryRecord, LakeEntry, LakeMapLocation, LakeRoot, LakeSource, LakeSummary } from './types.ts'

/**
 * Derive colocated metadata locations from a directory and its content revision.
 * @param directory - Root-relative directory with trailing slash, or empty root.
 * @param revision - SHA-256 revision of the directory's direct entries.
 * @returns the physical map and summary paths relative to the configured root.
 */
export function mapLocation(directory: string, revision: string): LakeMapLocation {
  return {
    directory, revision,
    mapPath: `${directory}${METADATA}/maps/${revision}.json`,
    summaryPath: `${directory}${METADATA}/summaries/${revision}.json`,
  }
}

function fingerprint(entries: readonly LakeEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function changes(previous: readonly LakeEntry[], current: readonly LakeEntry[]): LakeChange[] {
  const old = new Map(previous.map(entry => [entry.path, entry]))
  const result: LakeChange[] = []
  for (const entry of current) {
    const before = old.get(entry.path)
    if (!before) result.push({ path: entry.path, kind: 'added' })
    else if (JSON.stringify(before) !== JSON.stringify(entry)) result.push({ path: entry.path, kind: 'modified' })
    old.delete(entry.path)
  }
  for (const path of old.keys()) result.push({ path, kind: 'removed' })
  return result
}

/** Catalog operations; the caller serializes mutations and owns source disposal. */
export class LakeIndexer {
  constructor(private readonly source: LakeSource, private readonly root: LakeRoot, private readonly maxEntries: number) {}

  /**
   * Read the last complete index and validate every metadata reference.
   * @param signal - Cancellation of source IO.
   * @returns the catalog, or null before the first successful scan.
   */
  async catalog(signal: AbortSignal): Promise<LakeCatalog | null> {
    const raw = await this.source.read(INDEX_PATH, signal)
    if (raw === undefined) return null
    const catalog = catalogSchema.parse(raw)
    if (JSON.stringify(catalog.root) !== JSON.stringify(this.root)) throw new Error('data-lake: index belongs to a different root')
    const locations = new Set<string>()
    for (const location of catalog.maps) {
      if (location.directory && !location.directory.endsWith('/')) throw new Error('data-lake: invalid directory path')
      if (locations.has(location.directory)) throw new Error('data-lake: duplicate directory map')
      locations.add(location.directory)
      const expected = mapLocation(location.directory, location.revision)
      if (expected.mapPath !== location.mapPath || expected.summaryPath !== location.summaryPath) {
        throw new Error('data-lake: invalid map location')
      }
    }
    if (!locations.has('')) throw new Error('data-lake: root map is missing')
    const mapPaths = new Set(catalog.maps.map(location => location.mapPath))
    if (catalog.index.some(entry => !mapPaths.has(entry.mapPath))) throw new Error('data-lake: dangling map reference')
    return catalog
  }

  private async readMap(location: LakeMapLocation, signal: AbortSignal): Promise<LakeDirectoryRecord> {
    const map = mapSchema.parse(await this.source.read(location.mapPath, signal))
    if (map.path !== location.directory || map.revision !== location.revision || fingerprint(map.entries) !== map.revision) {
      throw new Error('data-lake: map does not match its indexed revision')
    }
    return map
  }

  private async readSummary(location: LakeMapLocation, signal: AbortSignal): Promise<LakeSummary | null> {
    const raw = await this.source.read(location.summaryPath, signal)
    if (raw === undefined) return null
    const summary = summarySchema.parse(raw)
    if (summary.revision !== location.revision) throw new Error('data-lake: summary revision mismatch')
    return summary
  }

  /**
   * Load one directory and its current agent-authored summary.
   * @param directory - Root-relative directory path, empty for root.
   * @param signal - Cancellation of source IO.
   * @returns map and summary, or null when the directory is not indexed.
   */
  async directory(directory: string, signal: AbortSignal): Promise<{ map: LakeDirectoryRecord; summary: LakeSummary | null } | null> {
    lakePath(directory)
    const catalog = await this.catalog(signal)
    const location = catalog?.maps.find(item => item.directory === directory)
    if (!location) return null
    return { map: await this.readMap(location, signal), summary: await this.readSummary(location, signal) }
  }

  /**
   * Scan every directory and publish the root index after all maps are written.
   * @param signal - Cancellation; unpublished maps can remain after failure.
   * @returns the complete index, whose missing summaries require agent updates.
   */
  async scan(signal: AbortSignal): Promise<LakeCatalog> {
    const previous = await this.catalog(signal)
    const previousLocations = new Map(previous?.maps.map(location => [location.directory, location]))
    const pending = [{ path: '', parent: null as string | null, depth: 0 }]
    const listings: { path: string; parent: string | null; depth: number; entries: LakeEntry[] }[] = []
    let total = 0
    for (const directory of pending) {
      signal.throwIfAborted()
      const entries = [...await this.source.list(directory.path, signal)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      total += entries.length
      if (total > this.maxEntries) throw new Error(`data-lake: scan exceeds maxEntries (${this.maxEntries})`)
      listings.push({ ...directory, entries })
      for (const entry of entries) {
        if (entry.kind === 'directory') pending.push({ path: entry.path, parent: directory.path, depth: directory.depth + 1 })
      }
    }
    const maps = new Map<string, LakeMapLocation>()
    const index: LakeCatalog['index'][number][] = []
    for (const directory of listings.reverse()) {
      signal.throwIfAborted()
      const entries = directory.entries.map((entry) => {
        if (entry.kind !== 'directory') return entry
        const child = maps.get(entry.path)
        if (child === undefined) throw new Error(`data-lake: child directory map is missing: ${entry.path}`)
        return { ...entry, revision: child.revision }
      })
      const revision = fingerprint(entries)
      const location = mapLocation(directory.path, revision)
      const before = previousLocations.get(directory.path)
      if (before?.revision !== revision) {
        const old = before ? await this.readMap(before, signal) : null
        const previousSummary = before ? await this.readSummary(before, signal) ?? old?.previousSummary ?? null : null
        const record: LakeDirectoryRecord = {
          version: 1, path: directory.path, parent: directory.parent, depth: directory.depth, revision, entries,
          changes: changes(old?.entries ?? [], entries), previousSummary,
        }
        await this.source.write(location.mapPath, record, signal)
      }
      maps.set(directory.path, location)
      for (const entry of entries) index.push({ path: entry.path, kind: entry.kind, mapPath: location.mapPath })
    }
    const catalog: LakeCatalog = {
      version: 1, root: this.root,
      index: index.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      maps: [...maps.values()].sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0),
    }
    await this.source.write(INDEX_PATH, catalog, signal)
    return catalog
  }

  /**
   * Save agent prose only for the current indexed directory revision.
   * @param directory - Root-relative directory path.
   * @param revision - Revision read by the agent before writing its summary.
   * @param text - Agent-authored summary of contents and changes.
   * @param signal - Cancellation of source IO.
   * @returns the saved summary; rejects a stale revision.
   */
  async summarize(directory: string, revision: string, text: string, signal: AbortSignal): Promise<LakeSummary> {
    lakePath(directory)
    const catalog = await this.catalog(signal)
    const location = catalog?.maps.find(item => item.directory === directory)
    if (!location || location.revision !== revision) throw new Error('data-lake: stale directory revision; read the current map before summarizing')
    const summary = summarySchema.parse({ version: 1, revision, text })
    await this.source.write(location.summaryPath, summary, signal)
    return summary
  }
}
