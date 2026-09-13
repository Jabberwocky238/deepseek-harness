/**
 * Configured data-lake service for disk/S3 indexing and agent-authored summaries.
 * @module @deepseek-ai/dsh-data-lake
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { S3Client } from '@aws-sdk/client-s3'
import { isAbsolute, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { LakeIndexer } from './catalog.ts'
import { DiskLakeSource } from './disk.ts'
import { S3LakeSource } from './s3.ts'
import type { LakeCatalog, LakeRoot, LakeSummary } from './types.ts'

export type { LakeCatalog, LakeChange, LakeDirectoryRecord, LakeEntry, LakeIndexEntry, LakeMapLocation, LakeRoot, LakeSource, LakeSummary } from './types.ts'

/** Identity of a configured lake, independent of its root URI. */
export type LakeId = Branded<'LakeId'>
/** Apply the lake identity brand to a configured name. */
export const LakeId = brandString<LakeId>

/** Configuration for one lake; indexing runs only when requested. */
export interface LakeConfig {
  /** Unique name used by service consumers and model tools. */
  id: string
  /** Absolute directory path or s3://bucket/prefix/ root. */
  root: string
  /** Required for S3 roots. */
  region?: string
  /** Optional S3-compatible service endpoint. */
  endpoint?: string
  /** Use path-style S3 addressing. */
  forcePathStyle?: boolean
  /** Maximum entries accepted by a complete scan. */
  maxEntries: number
}

/** Multiple independently indexed roots mounted by one service. */
export interface Config {
  /** Each lake owns exactly one root index and its directory maps. */
  lakes: LakeConfig[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dataLake: DataLake
  }
}

/**
 * Resolve the configured root and reject options inappropriate for its medium.
 * @param config - Validated plugin configuration.
 * @returns explicit source identity without credentials.
 */
export function resolveRoot(config: LakeConfig): LakeRoot {
  if (config.root.startsWith('s3://')) {
    const url = new URL(config.root)
    if (!url.hostname || url.username || url.password || url.port || url.search || url.hash || !config.region) {
      throw new Error('data-lake: S3 root requires a bucket, region, and optional path prefix only')
    }
    const prefix = decodeURIComponent(url.pathname.slice(1)).replace(/\/?$/, '/')
    return {
      kind: 's3', bucket: url.hostname, prefix: prefix === '/' ? '' : prefix, region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    }
  }
  if (!isAbsolute(config.root)) throw new Error('data-lake: disk root must be absolute')
  if (config.region || config.endpoint || config.forcePathStyle !== undefined) throw new Error('data-lake: S3 options require an S3 root')
  return { kind: 'disk', path: resolve(config.root) }
}

/** Owns each lake's operation queue and waits for all source IO on unload. */
export class DataLake extends Service {
  static Config: z<Config> = z.object({
    lakes: z.array(z.object({
      id: z.string().required(), root: z.string().required(), region: z.string(), endpoint: z.string(), forcePathStyle: z.boolean(),
      maxEntries: z.number().min(1).step(1).required(),
    })).required(),
  })

  private readonly lifetime = new AbortController()
  private readonly lakes = new Map<LakeId, { root: LakeRoot; indexer: LakeIndexer; tail: Promise<unknown> }>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dataLake')
    const resolved = config.lakes.map(lake => ({ id: LakeId(lake.id), root: resolveRoot(lake), maxEntries: lake.maxEntries }))
    const ids = new Set<string>()
    const roots = new Set<string>()
    for (const lake of resolved) {
      if (!lake.id.trim() || ids.has(lake.id)) throw new Error('data-lake: lake IDs must be nonblank and unique')
      const key = JSON.stringify(lake.root)
      if (roots.has(key)) throw new Error('data-lake: each configured lake requires a distinct root')
      ids.add(lake.id)
      roots.add(key)
    }
    const clients: S3Client[] = []
    for (const lake of resolved) {
      const { root } = lake
      let source: DiskLakeSource | S3LakeSource
      if (root.kind === 'disk') source = new DiskLakeSource(root.path)
      else {
        const client = new S3Client({
          region: root.region,
          ...(root.endpoint ? { endpoint: root.endpoint } : {}),
          ...(root.forcePathStyle !== undefined ? { forcePathStyle: root.forcePathStyle } : {}),
        })
        clients.push(client)
        source = new S3LakeSource(root, client)
      }
      this.lakes.set(lake.id, { root, indexer: new LakeIndexer(source, root, lake.maxEntries), tail: Promise.resolve() })
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('data-lake: service disposed'))
      await Promise.all([...this.lakes.values()].map(lake => lake.tail))
      for (const client of clients) client.destroy()
    })
  }

  private run<T>(id: LakeId, operation: (indexer: LakeIndexer, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lake = this.lakes.get(id)
    if (!lake) return Promise.reject(new Error(`data-lake: unknown lake ${JSON.stringify(id)}`))
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const job = lake.tail.then(() => {
      combined.throwIfAborted()
      return operation(lake.indexer, combined)
    })
    lake.tail = job.then(() => undefined, () => undefined)
    return job
  }

  /**
   * List configured lakes without scanning their roots.
   * @returns lake IDs and credential-free source identities.
   */
  list(): readonly { id: LakeId; root: LakeRoot }[] {
    return [...this.lakes].map(([id, lake]) => ({ id, root: lake.root }))
  }

  /**
   * Scan one lake and publish its complete root index.
   * @param id - Configured lake ID.
   * @param signal - Optional caller cancellation.
   * @returns the published catalog; summaries are authored separately by agents.
   */
  scan(id: LakeId, signal?: AbortSignal): Promise<LakeCatalog> {
    return this.run(id, (indexer, current) => indexer.scan(current), signal)
  }

  /**
   * Read one lake's last published root index.
   * @param id - Configured lake ID.
   * @param signal - Optional caller cancellation.
   * @returns the catalog, or null before the first scan.
   */
  catalog(id: LakeId, signal?: AbortSignal): Promise<LakeCatalog | null> {
    return this.run(id, (indexer, current) => indexer.catalog(current), signal)
  }

  /**
   * Read one directory's direct entries, changes, and summary.
   * @param id - Configured lake ID.
   * @param path - Root-relative directory with trailing slash, or empty root.
   * @param signal - Optional caller cancellation.
   * @returns the directory record, or null when it is not indexed.
   */
  directory(id: LakeId, path: string, signal?: AbortSignal): ReturnType<LakeIndexer['directory']> {
    return this.run(id, (indexer, current) => indexer.directory(path, current), signal)
  }

  /**
   * Persist agent-authored prose against the current indexed directory revision.
   * @param id - Configured lake ID.
   * @param path - Root-relative directory path.
   * @param revision - Revision returned by the directory map.
   * @param text - Agent's summary of contents and changes.
   * @param signal - Optional caller cancellation.
   * @returns the persisted summary; rejects an outdated revision.
   */
  summarize(id: LakeId, path: string, revision: string, text: string, signal?: AbortSignal): Promise<LakeSummary> {
    return this.run(id, (indexer, current) => indexer.summarize(path, revision, text, current), signal)
  }
}

export default DataLake
