/**
 * S3 directory-prefix listings and colocated JSON metadata using the AWS SDK.
 * @module @deepseek-ai/dsh-data-lake/s3
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { METADATA, lakePath } from './records.ts'
import type { LakeEntry, LakeRoot, LakeSource } from './types.ts'

/** S3 provider; credentials come from the AWS SDK credential provider chain. */
export class S3LakeSource implements LakeSource {
  constructor(
    private readonly root: Extract<LakeRoot, { kind: 's3' }>,
    private readonly client: S3Client,
  ) {}

  async list(directory: string, signal: AbortSignal): Promise<readonly LakeEntry[]> {
    lakePath(directory)
    const prefix = this.root.prefix + directory
    const entries = new Map<string, LakeEntry>()
    let token: string | undefined
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.root.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token,
      }), { abortSignal: signal })
      for (const child of page.CommonPrefixes ?? []) {
        if (!child.Prefix?.startsWith(prefix)) throw new Error('data-lake: S3 returned an invalid prefix')
        const name = child.Prefix.slice(prefix.length, -1)
        if (name === METADATA) continue
        if (!name || name.includes('/')) throw new Error('data-lake: S3 returned a non-direct prefix')
        const path = lakePath(directory + name + '/')
        entries.set(path, { path, name, kind: 'directory', bytes: 0 })
      }
      for (const object of page.Contents ?? []) {
        if (object.Key === prefix) continue
        if (!object.Key?.startsWith(prefix)) throw new Error('data-lake: S3 returned an invalid object key')
        const name = object.Key.slice(prefix.length)
        if (name === METADATA) continue
        if (!name || name.includes('/')) throw new Error('data-lake: S3 returned a non-direct object')
        if (object.Size === undefined) throw new Error('data-lake: S3 omitted object size')
        const path = lakePath(directory + name)
        entries.set(path, {
          path, name, kind: 'file', bytes: object.Size,
          ...(object.LastModified ? { modifiedAt: object.LastModified.toISOString() } : {}),
          ...(object.ETag ? { etag: object.ETag } : {}),
        })
      }
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token)) {
        throw new Error('data-lake: S3 pagination did not advance')
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token !== undefined)
    return [...entries.values()]
  }

  async read(path: string, signal: AbortSignal): Promise<unknown> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.root.bucket, Key: this.root.prefix + path }), { abortSignal: signal },
      )
      if (!object.Body) throw new Error('data-lake: S3 metadata object has no body')
      return JSON.parse(await object.Body.transformToString()) as unknown
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return undefined
      throw error
    }
  }

  async write(path: string, value: unknown, signal: AbortSignal): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.root.bucket, Key: this.root.prefix + path,
      Body: `${JSON.stringify(value)}\n`, ContentType: 'application/json',
    }), { abortSignal: signal })
  }
}
