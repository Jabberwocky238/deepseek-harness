import { randomUUID } from 'node:crypto'
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3'
import { expect, it } from 'vitest'
import { LakeIndexer } from '../src/catalog.ts'
import { S3LakeSource } from '../src/s3.ts'

const endpoint = process.env.DSH_DATA_LAKE_FALS3Y_ENDPOINT

it.skipIf(!endpoint)('indexes independent fals3y buckets, all S3 pages, and directory summaries', async () => {
  const client = new S3Client({
    endpoint: endpoint!, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'fals3y', secretAccessKey: 'fals3y' },
  })
  const buckets: string[] = []
  const signal = AbortSignal.timeout(45000)
  const makeLake = async () => {
    const bucket = `dsh-lake-${randomUUID()}`
    await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal })
    buckets.push(bucket)
    const root = { kind: 's3' as const, bucket, region: 'us-east-1', prefix: '', endpoint: endpoint!, forcePathStyle: true }
    return { bucket, indexer: new LakeIndexer(new S3LakeSource(root, client), root, 2000) }
  }
  try {
    const documents = await makeLake()
    const archive = await makeLake()
    // More than one S3 page proves the real server's continuation-token path.
    for (let index = 0; index < 1001; index++) {
      await client.send(new PutObjectCommand({
        Bucket: documents.bucket, Key: `records/item-${index}.txt`, Body: `record ${index}`,
      }), { abortSignal: signal })
    }
    await client.send(new PutObjectCommand({ Bucket: documents.bucket, Key: 'notes/nested/note.txt', Body: 'first' }), { abortSignal: signal })
    await client.send(new PutObjectCommand({ Bucket: archive.bucket, Key: 'archive.txt', Body: 'archive' }), { abortSignal: signal })
    const catalog = await documents.indexer.scan(signal)
    expect(catalog.index.filter(entry => entry.kind === 'file')).toHaveLength(1002)
    expect(catalog.maps.map(map => map.directory)).toEqual(['', 'notes/', 'notes/nested/', 'records/'])
    const folder = (await documents.indexer.directory('notes/nested/', signal))!
    await documents.indexer.summarize('notes/nested/', folder.map.revision, 'One new note.', signal)
    const location = catalog.maps.find(map => map.directory === 'notes/nested/')!
    const stored = await client.send(new GetObjectCommand({ Bucket: documents.bucket, Key: location.summaryPath }), { abortSignal: signal })
    expect(await stored.Body?.transformToString()).toContain('One new note.')
    const rootIndex = await client.send(new GetObjectCommand({ Bucket: documents.bucket, Key: '.dsh-data-lake/index.json' }), { abortSignal: signal })
    expect(await rootIndex.Body?.transformToString()).toContain(location.mapPath)
    expect(await archive.indexer.catalog(signal)).toBeNull()
    await archive.indexer.scan(signal)
    expect((await archive.indexer.catalog(signal))?.index.map(entry => entry.path)).toEqual(['archive.txt'])
    await client.send(new PutObjectCommand({ Bucket: documents.bucket, Key: 'notes/nested/note.txt', Body: 'changed content' }), { abortSignal: signal })
    await client.send(new DeleteObjectCommand({ Bucket: documents.bucket, Key: 'records/item-0.txt' }), { abortSignal: signal })
    await documents.indexer.scan(signal)
    expect((await documents.indexer.directory('notes/nested/', signal))?.summary).toBeNull()
    await expect(documents.indexer.summarize('notes/nested/', folder.map.revision, 'stale', signal)).rejects.toThrow('stale')
    expect((await documents.indexer.catalog(signal))?.index.some(entry => entry.path === 'records/item-0.txt')).toBe(false)
  } finally {
    try {
      for (const bucket of buckets) {
        // Drain each current first page so deletion never invalidates a continuation token.
        while (true) {
          const page = await client.send(new ListObjectsV2Command({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10000) })
          if (!page.Contents?.length) break
          for (const object of page.Contents) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key! }), { abortSignal: AbortSignal.timeout(10000) })
          }
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10000) })
      }
    } finally {
      client.destroy()
    }
  }
}, 60000)
