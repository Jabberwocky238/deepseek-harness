/**
 * Data-lake listings, directory maps, and agent-authored summaries.
 * @module @deepseek-ai/dsh-data-lake/types
 */

/** Root directory or S3 prefix containing data and its catalog metadata. */
export type LakeRoot =
  | { readonly kind: 'disk'; readonly path: string }
  | {
    readonly kind: 's3'
    readonly bucket: string
    readonly prefix: string
    readonly region: string
    readonly endpoint?: string | undefined
    readonly forcePathStyle?: boolean | undefined
  }

/** One direct child; directory paths end with a slash, except the empty root. */
export interface LakeEntry {
  readonly path: string
  readonly name: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly bytes: number
  readonly modifiedAt?: string | undefined
  readonly etag?: string | undefined
  /** Child map revision, so descendant changes invalidate ancestor summaries. */
  readonly revision?: string | undefined
}

/** Source IO used by the indexer; metadata writes stay inside the reserved directory. */
export interface LakeSource {
  /**
   * List direct children, excluding reserved metadata directories.
   * @param directory - Root-relative directory path.
   * @param signal - Cancellation of source IO.
   * @returns the complete listing, including every remote page.
   */
  list(directory: string, signal: AbortSignal): Promise<readonly LakeEntry[]>
  /**
   * Read a catalog record.
   * @param path - Root-relative metadata path.
   * @param signal - Cancellation of source IO.
   * @returns parsed JSON, or undefined only when the object is missing.
   */
  read(path: string, signal: AbortSignal): Promise<unknown>
  /**
   * Replace one complete catalog record atomically.
   * @param path - Root-relative metadata path.
   * @param value - JSON-serializable record.
   * @param signal - Cancellation before publication; a committed write may finish after cancellation.
   * @returns resolution after publication.
   */
  write(path: string, value: unknown, signal: AbortSignal): Promise<void>
}

/** Difference between this map and the preceding indexed map. */
export interface LakeChange {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'removed'
}

/** Immutable single-level map; summaries are separate agent-owned records. */
export interface LakeDirectoryRecord {
  readonly version: 1
  readonly path: string
  readonly parent: string | null
  readonly depth: number
  readonly revision: string
  readonly entries: readonly LakeEntry[]
  readonly changes: readonly LakeChange[]
  readonly previousSummary: LakeSummary | null
}

/** Summary written by an agent against one exact directory revision. */
export interface LakeSummary {
  readonly version: 1
  readonly revision: string
  readonly text: string
}

/** Physical locations of one directory's map and summary under the lake root. */
export interface LakeMapLocation {
  readonly directory: string
  readonly revision: string
  readonly mapPath: string
  readonly summaryPath: string
}

/** Global file lookup pointing to its containing map. */
export interface LakeIndexEntry {
  readonly path: string
  readonly kind: LakeEntry['kind']
  readonly mapPath: string
}

/** Root index published after every referenced map is durable. */
export interface LakeCatalog {
  readonly version: 1
  readonly root: LakeRoot
  readonly index: readonly LakeIndexEntry[]
  readonly maps: readonly LakeMapLocation[]
}
