import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPrefix, FileStore, isBoxName, normalizePrefix, type FileStoreConfig } from '../src/file-store.ts'

/** In-memory bucket standing in for the S3-compatible endpoint. */
const bucket = new Map<string, Uint8Array>()

/** Test control over the managed upload: every started upload, and how it settles. */
const uploads: { key: string; partSize: number; queueSize: number; aborted: boolean }[] = []
const gate = { hold: false, fail: false, release: [] as (() => void)[] }

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    readonly #record: (typeof uploads)[number]
    readonly #body: Uint8Array
    constructor(options: { params: { Key: string; Body: Uint8Array }; partSize: number; queueSize: number }) {
      this.#record = { key: options.params.Key, partSize: options.partSize, queueSize: options.queueSize, aborted: false }
      this.#body = options.params.Body
      uploads.push(this.#record)
    }
    async done(): Promise<void> {
      if (gate.hold) await new Promise<void>((resolve) => { gate.release.push(resolve) })
      if (this.#record.aborted) throw new Error('aborted')
      if (gate.fail) throw new Error('upload refused')
      bucket.set(this.#record.key, new Uint8Array(this.#body))
    }
    async abort(): Promise<void> {
      this.#record.aborted = true
      for (const resolve of gate.release.splice(0)) resolve()
    }
  },
}))

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    ListObjectsV2Command: class extends Command {},
    HeadObjectCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    S3Client: class {
      async send(command: Command): Promise<unknown> {
        const input = command.input as { Key?: string; Prefix?: string }
        switch (command.constructor.name) {
          case 'ListObjectsV2Command':
            return {
              Contents: [...bucket]
                .filter(([key]) => key.startsWith(input.Prefix!))
                .map(([key, data]) => ({ Key: key, Size: data.byteLength })),
            }
          case 'HeadObjectCommand':
            if (bucket.has(input.Key!)) return {}
            throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } })
          default: {
            const data = bucket.get(input.Key!)!
            return { Body: { transformToByteArray: async () => data } }
          }
        }
      }
    },
  }
})

const base: FileStoreConfig = {
  mode: 's3only',
  s3: { endpoint: 'http://127.0.0.1:9000', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
  prefix: '@scope/pkg',
  partSize: 5242880,
  partConcurrency: 3,
  uploadConcurrency: 1,
}
const roots: string[] = []
const errors: string[] = []
const store = (config: Partial<FileStoreConfig> = {}): FileStore =>
  new FileStore({ ...base, ...config }, (message) => { errors.push(message) })

afterEach(async () => {
  bucket.clear()
  uploads.length = 0
  errors.length = 0
  Object.assign(gate, { hold: false, fail: false })
  for (const resolve of gate.release.splice(0)) resolve()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('per-session file store', () => {
  it('accepts only single plain path segments as names', () => {
    expect(isBoxName('report.pdf')).toBe(true)
    expect(isBoxName('报告（终稿）.docx')).toBe(true)
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\nb']) expect(isBoxName(name)).toBe(false)
    expect(() => store().key('wecom-1', 'inbox', '../escape')).toThrow(/not a plain file name/)
    expect(() => { store().enqueue('wecom-1', 'inbox', '../escape', new Uint8Array(1)) }).toThrow(/not a plain file name/)
  })

  it('keys every object under the prefix, which defaults to the package name and must stay inside the bucket', async () => {
    expect(store().key('wecom-1', 'inbox', 'a.txt')).toBe('@scope/pkg/wecom-1/inbox/a.txt')
    expect(await defaultPrefix()).toBe('@deepseek-ai/dsh-wecom')
    expect(normalizePrefix('/@jabberwocky238/dsh-wecom/')).toBe('@jabberwocky238/dsh-wecom')
    for (const prefix of ['', '/', 'a//b', '../up', 'a/..']) expect(() => normalizePrefix(prefix)).toThrow(/not a usable key prefix/)
  })

  it('uploads through the managed multipart upload with the configured part size and concurrency', async () => {
    expect(await store().put('wecom-1', 'inbox', 'a.txt', new TextEncoder().encode('hi'))).toEqual({ key: '@scope/pkg/wecom-1/inbox/a.txt' })
    expect(uploads).toEqual([{ key: '@scope/pkg/wecom-1/inbox/a.txt', partSize: 5242880, queueSize: 3, aborted: false }])
    expect([...bucket.keys()]).toEqual(['@scope/pkg/wecom-1/inbox/a.txt'])
  })

  it('writes the local mirror before the upload, so a failed upload keeps the local copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wecom-store-'))
    roots.push(root)
    gate.fail = true
    const mirrored = store({ mode: 'mirror', localRoot: root })
    await expect(mirrored.put('wecom-1', 'outbox', 'b.txt', new TextEncoder().encode('bye'))).rejects.toThrow('upload refused')
    expect(await readFile(join(root, 'wecom-1', 'outbox', 'b.txt'), 'utf8')).toBe('bye')
  })

  it('returns from enqueue at once and stores the file in the background', async () => {
    const files = store()
    gate.hold = true
    files.enqueue('wecom-1', 'inbox', 'a.txt', new Uint8Array(4))
    expect(bucket.size).toBe(0)
    const drained = files.drain(5000)
    await vi.waitFor(() => { expect(uploads).toHaveLength(1) })
    for (const resolve of gate.release.splice(0)) resolve()
    expect(await drained).toBe(0)
    expect(bucket.has('@scope/pkg/wecom-1/inbox/a.txt')).toBe(true)
  })

  it('keeps at most uploadConcurrency files in flight', async () => {
    const files = store({ uploadConcurrency: 2 })
    gate.hold = true
    for (const name of ['1', '2', '3', '4']) files.enqueue('wecom-1', 'outbox', name, new Uint8Array(1))
    await vi.waitFor(() => { expect(uploads).toHaveLength(2) })
    gate.hold = false
    for (const resolve of gate.release.splice(0)) resolve()
    expect(await files.drain(5000)).toBe(0)
    expect(bucket.size).toBe(4)
  })

  it('reports a failed background upload without throwing to the caller', async () => {
    const files = store()
    gate.fail = true
    files.enqueue('wecom-1', 'inbox', 'a.txt', new Uint8Array(1))
    expect(await files.drain(5000)).toBe(0)
    expect(errors).toEqual(['wecom inbox storage failed for a.txt'])
  })

  it('abandons the remainder at the shutdown deadline, aborting what is in flight', async () => {
    const files = store()
    gate.hold = true
    files.enqueue('wecom-1', 'outbox', 'slow.bin', new Uint8Array(1))
    files.enqueue('wecom-1', 'outbox', 'queued.bin', new Uint8Array(1))
    await vi.waitFor(() => { expect(uploads).toHaveLength(1) })
    expect(await files.drain(20)).toBe(2)
    expect(uploads[0]!.aborted).toBe(true)
    await vi.waitFor(() => { expect(errors).toHaveLength(2) })
    expect(errors).toContain('wecom outbox storage abandoned for queued.bin')
    expect(bucket.size).toBe(0)
  })

  it('lists and checks one box from metadata, keeping sessions and boxes apart', async () => {
    const files = store()
    await files.put('wecom-1', 'inbox', 'a.txt', new Uint8Array(3))
    await files.put('wecom-1', 'outbox', 'b.txt', new Uint8Array(5))
    await files.put('wecom-2', 'inbox', 'c.txt', new Uint8Array(7))
    expect(await files.list('wecom-1', 'inbox')).toEqual([{ name: 'a.txt', size: 3 }])
    expect(await files.exists('wecom-1', 'inbox', 'a.txt')).toBe(true)
    expect(await files.exists('wecom-1', 'inbox', 'c.txt')).toBe(false)
    expect(await files.get('wecom-2', 'inbox', 'c.txt')).toHaveLength(7)
  })
})
