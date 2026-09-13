import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'
import { S3LakeSource } from '../src/s3.ts'
import { LakeIndexer } from '../src/catalog.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function listen(server: Server): Promise<string> {
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

it('follows S3 pages and writes each map beneath its own prefix with one root index', async () => {
  const objects = new Map<string, string>()
  const seen: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''))
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks).toString())
      response.end()
    } else if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix')!
      seen.push(prefix + ':' + (url.searchParams.get('continuation-token') ?? ''))
      const body = prefix === 'data/'
        ? url.searchParams.has('continuation-token')
          ? '<IsTruncated>false</IsTruncated><Contents><Key>data/b.txt</Key><Size>2</Size></Contents>'
          : '<IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken><CommonPrefixes><Prefix>data/folder/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>data/.dsh-data-lake/</Prefix></CommonPrefixes>'
        : '<IsTruncated>false</IsTruncated><Contents><Key>data/folder/a.txt</Key><Size>1</Size></Contents>'
      response.setHeader('Content-Type', 'application/xml')
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</ListBucketResult>`)
    } else if (objects.has(key)) {
      response.end(objects.get(key))
    } else {
      response.writeHead(404, { 'Content-Type': 'application/xml' })
      response.end('<Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>')
    }
  })
  const endpoint = await listen(server)
  const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  cleanup.push(() => client.destroy())
  const root = { kind: 's3' as const, bucket: 'bucket', prefix: 'data/', region: 'us-east-1', endpoint, forcePathStyle: true }
  const indexer = new LakeIndexer(new S3LakeSource(root, client), root, 100)
  const signal = new AbortController().signal
  const catalog = await indexer.scan(signal)
  expect(seen).toEqual(['data/:', 'data/:page2', 'data/folder/:'])
  expect(catalog.index.map(entry => entry.path)).toEqual(['b.txt', 'folder/', 'folder/a.txt'])
  expect([...objects.keys()].filter(key => key.endsWith('/index.json'))).toEqual(['data/.dsh-data-lake/index.json'])
  const folder = catalog.maps.find(map => map.directory === 'folder/')!
  expect(objects.has(`data/${folder.mapPath}`)).toBe(true)
  await indexer.summarize('folder/', folder.revision, 'One file in this folder.', signal)
  expect((await indexer.directory('folder/', signal))?.summary?.text).toBe('One file in this folder.')
})
