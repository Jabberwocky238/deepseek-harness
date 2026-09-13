/**
 * Validation of data-lake metadata read from disk or S3.
 * @module @deepseek-ai/dsh-data-lake/records
 */
import { z } from 'zod'
import type { LakeCatalog, LakeDirectoryRecord, LakeSummary } from './types.ts'

/** Reserved directory excluded from source listings at every depth. */
export const METADATA = '.dsh-data-lake'
/** Root index is the sole publication point of a complete scan. */
export const INDEX_PATH = `${METADATA}/index.json`

/**
 * Admit a portable root-relative path without traversal or reserved components.
 * @param value - File or directory path supplied by a caller or source listing.
 * @returns the unchanged path, rejecting absolute paths and dot segments.
 */
export function lakePath(value: string): string {
  const parts = value.replace(/\/$/, '').split('/')
  if (value !== '' && parts.some(part => !part || part === '.' || part === '..' || part === METADATA)) {
    throw new Error(`data-lake: invalid relative path ${JSON.stringify(value)}`)
  }
  if (/[\\\x00]/.test(value) || /^[a-z]:/i.test(value)) {
    throw new Error(`data-lake: invalid relative path ${JSON.stringify(value)}`)
  }
  return value
}

const path = z.string().transform(lakePath)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const entry = z.object({
  path, name: z.string(), kind: z.enum(['file', 'directory', 'symlink', 'other']),
  bytes: z.number().nonnegative().finite(), modifiedAt: z.string().optional(),
  etag: z.string().optional(), revision: revision.optional(),
})
const root = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disk'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('s3'), bucket: z.string().min(1), prefix: z.string(), region: z.string().min(1),
    endpoint: z.string().url().optional(), forcePathStyle: z.boolean().optional(),
  }),
])

/** Agent summary schema validated at metadata reads. */
export const summarySchema: z.ZodType<LakeSummary> = z.object({ version: z.literal(1), revision, text: z.string().min(1) })
/** Directory map schema validated at metadata reads. */
export const mapSchema: z.ZodType<LakeDirectoryRecord> = z.object({
  version: z.literal(1), path, parent: path.nullable(), depth: z.number().int().nonnegative(), revision,
  entries: z.array(entry), changes: z.array(z.object({ path, kind: z.enum(['added', 'modified', 'removed']) })),
  previousSummary: summarySchema.nullable(),
})
/** Root catalog schema validated before resolving metadata references. */
export const catalogSchema: z.ZodType<LakeCatalog> = z.object({
  version: z.literal(1), root,
  index: z.array(z.object({ path, kind: entry.shape.kind, mapPath: z.string() })),
  maps: z.array(z.object({ directory: path, revision, mapPath: z.string(), summaryPath: z.string() })),
})
