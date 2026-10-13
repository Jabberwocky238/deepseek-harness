/** Per-session WeCom file storage: an S3-compatible bucket with an optional local mirror. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Which side a stored file travelled: user-to-Agent or Agent-to-user. */
export type FileDirection = 'inbox' | 'outbox'

/** Validated file-store configuration, present only when the feature is enabled. */
export interface FileStoreConfig {
  /** `mirror` keeps a local copy beside the bucket; `s3only` writes only the bucket. */
  mode: 'mirror' | 's3only'
  /** S3-compatible endpoint, bucket and static credentials. */
  s3: {
    endpoint: string
    bucket: string
    region?: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle?: boolean
  }
  /** Host-side root of the local mirror; required in `mirror` mode. */
  localRoot?: string
  /** Key prefix every stored object sits under, without leading or trailing `/`. */
  prefix: string
  /** Multipart part size in bytes; a file no larger than one part is a single upload. */
  partSize: number
  /** Parts of one file uploaded concurrently. */
  partConcurrency: number
  /** Files uploaded concurrently by the background queue. */
  uploadConcurrency: number
}

/** Where one stored file landed. */
export interface StoredFile {
  /** Bucket key, `<prefix>/<session>/<direction>/<name>`. */
  key: string
  /** Local mirror path, present only in `mirror` mode. */
  local?: string
}

/** One stored object's name and size, read from a listing without its bytes. */
export interface StoredEntry {
  /** File name within its box. */
  name: string
  /** Object size in bytes. */
  size: number
}

/**
 * Per-session file storage as the `wecom` service exposes it to tools. Listing
 * and existence checks read object metadata only; `pull` downloads just the
 * named files the conversation's working directory does not already hold.
 * Uploads run in the background, so a file stored moments ago may not be
 * listed yet.
 */
export interface WecomFiles {
  /**
   * List one box of a session.
   * @param session - the calling Session's id.
   * @param box - inbox or outbox.
   * @returns every stored file with its size, without downloading any.
   */
  list(session: string, box: FileDirection): Promise<StoredEntry[]>
  /**
   * Check which named files a box holds.
   * @param session - the calling Session's id.
   * @param box - inbox or outbox.
   * @param names - file names to check.
   * @returns the names found and the names missing.
   */
  exists(session: string, box: FileDirection, names: readonly string[]): Promise<{ found: string[]; missing: string[] }>
  /**
   * Copy stored files into `<working directory>/<box>/`, skipping files already
   * present there.
   * @param session - the calling Session's id.
   * @param box - inbox or outbox.
   * @param names - files to copy; omitted copies every file the directory lacks.
   * @param maxBytes - inclusive byte cap across the files copied in this call.
   * @returns the directory written, the names copied, and the names skipped as already present.
   */
  pull(
    session: string,
    box: FileDirection,
    names: readonly string[] | undefined,
    maxBytes: number,
  ): Promise<{ directory: string; pulled: string[]; skipped: string[] }>
}

/** The S3 operations this store needs, so the SDK stays behind a lazy import. */
interface S3Client {
  put(key: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  list(prefix: string): Promise<{ key: string; size: number }[]>
  exists(key: string): Promise<boolean>
  get(key: string): Promise<Uint8Array>
}

/**
 * Build the client against a static-credential S3-compatible endpoint. The AWS
 * SDK is loaded here, not at plugin activation, so a deployment that keeps the
 * store off never pays for it. Uploads go through the SDK's managed upload: a
 * body larger than one part is sent as a multipart upload with its parts in
 * flight concurrently, and an aborted upload removes the parts already sent.
 */
async function client(config: FileStoreConfig): Promise<S3Client> {
  const [{ GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client }, { Upload }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/lib-storage'),
  ])
  const s3 = new S3Client({
    endpoint: config.s3.endpoint,
    ...(config.s3.region === undefined ? {} : { region: config.s3.region }),
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    ...(config.s3.forcePathStyle === undefined ? {} : { forcePathStyle: config.s3.forcePathStyle }),
  })
  return {
    put: async (key, data, signal) => {
      const upload = new Upload({
        client: s3,
        params: { Bucket: config.s3.bucket, Key: key, Body: Buffer.from(data.buffer, data.byteOffset, data.byteLength) },
        partSize: config.partSize,
        queueSize: config.partConcurrency,
        leavePartsOnError: false,
      })
      const abort = (): void => { void upload.abort() }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await upload.done()
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
    list: async (prefix) => {
      const objects: { key: string; size: number }[] = []
      let token: string | undefined
      do {
        const response = await s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }))
        for (const object of response.Contents ?? []) {
          if (object.Key !== undefined) objects.push({ key: object.Key, size: object.Size ?? 0 })
        }
        token = response.IsTruncated === true ? response.NextContinuationToken : undefined
      } while (token !== undefined)
      return objects
    },
    exists: async (key) => {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }))
        return true
      } catch (error: unknown) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
        throw error
      }
    },
    get: async (key) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
      return response.Body === undefined ? new Uint8Array() : await response.Body.transformToByteArray()
    },
  }
}

/**
 * Whether a name is one plain path segment: non-empty, at most 200 characters,
 * no separators or control characters, and not `.` or `..`.
 * @param name - candidate file name.
 * @returns true when the name can be used as a box entry.
 */
export function isBoxName(name: string): boolean {
  return name !== '' && name.length <= 200 && name !== '.' && name !== '..' && !/[\u0000-\u001f\u007f/\\]/u.test(name)
}

/**
 * The default key prefix: this package's own published name, read from the
 * manifest beside the running code, so a release under another scope stores
 * under that scope's name without a configured value.
 * @returns the `name` field of the package's `package.json`.
 */
export async function defaultPrefix(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown }
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('wecom file store: the package manifest has no name')
  return manifest.name
}

/**
 * Normalize a key prefix: surrounding `/` are dropped, and every segment must be
 * a plain path segment, so the prefix can neither be empty nor climb out.
 * @param prefix - configured or default prefix.
 * @returns the prefix without leading or trailing `/`.
 * @throws when the prefix is empty or has an empty, `.` or `..` segment.
 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/gu, '')
  if (trimmed === '' || !trimmed.split('/').every(isBoxName)) {
    throw new Error(`wecom file store: ${JSON.stringify(prefix)} is not a usable key prefix`)
  }
  return trimmed
}

/** One file waiting in the background upload queue. */
interface UploadJob {
  session: string
  direction: FileDirection
  name: string
  data: Uint8Array
}

/**
 * Per-session inbox/outbox file storage.
 *
 * {@link enqueue} is the path message handling uses: it returns at once and the
 * file is stored in the background, at most `uploadConcurrency` files at a
 * time, so neither an inbound message nor an outbound delivery waits on the
 * bucket. A failed background upload is reported through `onError` and never
 * retried. {@link drain} is the owner's shutdown step.
 */
export class FileStore {
  readonly #config: FileStoreConfig
  readonly #onError: (message: string, error: unknown) => void
  #client: Promise<S3Client> | undefined
  readonly #queue: UploadJob[] = []
  readonly #inFlight = new Set<AbortController>()
  readonly #idleWaiters: (() => void)[] = []

  /**
   * @param config - validated store configuration, with the secret key resolved.
   * @param onError - reports a background upload that failed or was abandoned.
   */
  constructor(config: FileStoreConfig, onError: (message: string, error: unknown) => void) {
    this.#config = config
    this.#onError = onError
  }

  /**
   * The bucket key one file occupies, independent of the selected mode.
   * @throws when `name` is not a single plain path segment, so no key or mirror
   *   path can escape its session's box.
   */
  key(session: string, direction: FileDirection, name: string): string {
    if (!isBoxName(name)) throw new Error(`wecom file store: ${JSON.stringify(name)} is not a plain file name`)
    return `${this.#config.prefix}/${session}/${direction}/${name}`
  }

  #use(): Promise<S3Client> {
    this.#client ??= client(this.#config)
    return this.#client
  }

  /**
   * Store one file under a session's inbox or outbox and wait for it. In
   * `mirror` mode the local copy is written first, at a path that mirrors the
   * bucket key below its prefix, so the host keeps the file even when the
   * upload fails.
   * @param session - the conversation's Session id, the key's first segment.
   * @param direction - inbox for inbound files, outbox for outbound files.
   * @param name - one path segment naming the file in the bucket.
   * @param data - exact file bytes.
   * @param signal - aborts the upload, removing any parts already sent.
   * @returns the bucket key, and the local path when mirroring.
   */
  async put(session: string, direction: FileDirection, name: string, data: Uint8Array, signal?: AbortSignal): Promise<StoredFile> {
    const key = this.key(session, direction, name)
    let local: string | undefined
    if (this.#config.mode === 'mirror' && this.#config.localRoot !== undefined) {
      local = resolve(this.#config.localRoot, session, direction, name)
      await mkdir(dirname(local), { recursive: true })
      await writeFile(local, data)
    }
    await (await this.#use()).put(key, data, signal)
    return local === undefined ? { key } : { key, local }
  }

  /**
   * Queue one file for background storage and return at once.
   * @param session - the conversation's Session id.
   * @param direction - inbox for inbound files, outbox for outbound files.
   * @param name - one path segment naming the file; checked before queueing.
   * @param data - exact file bytes, held until the upload finishes.
   * @throws when `name` is not a plain file name.
   */
  enqueue(session: string, direction: FileDirection, name: string, data: Uint8Array): void {
    this.key(session, direction, name)
    this.#queue.push({ session, direction, name, data })
    setImmediate(() => { this.#pump() })
  }

  #pump(): void {
    while (this.#inFlight.size < this.#config.uploadConcurrency) {
      const job = this.#queue.shift()
      if (job === undefined) break
      const controller = new AbortController()
      this.#inFlight.add(controller)
      void this.put(job.session, job.direction, job.name, job.data, controller.signal)
        .catch((error: unknown) => { this.#onError(`wecom ${job.direction} storage failed for ${job.name}`, error) })
        .finally(() => {
          this.#inFlight.delete(controller)
          this.#pump()
          if (this.#inFlight.size === 0 && this.#queue.length === 0) {
            for (const resolveIdle of this.#idleWaiters.splice(0)) resolveIdle()
          }
        })
    }
  }

  /**
   * Wait for queued and in-flight uploads, up to a deadline; then abort what is
   * still running and drop what never started.
   * @param deadlineMs - longest wait before abandoning the remainder.
   * @returns how many files were abandoned; each is also reported through `onError`.
   */
  async drain(deadlineMs: number): Promise<number> {
    if (this.#inFlight.size === 0 && this.#queue.length === 0) return 0
    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([
      new Promise<true>((resolveIdle) => { this.#idleWaiters.push(() => { resolveIdle(true) }) }),
      new Promise<false>((resolveTimeout) => { timer = setTimeout(() => { resolveTimeout(false) }, deadlineMs) }),
    ])
    clearTimeout(timer)
    if (settled) return 0
    const dropped = this.#queue.splice(0)
    for (const job of dropped) this.#onError(`wecom ${job.direction} storage abandoned for ${job.name}`, new Error('shutdown deadline reached'))
    const aborted = this.#inFlight.size
    for (const controller of this.#inFlight) controller.abort()
    return dropped.length + aborted
  }

  /**
   * List the files stored under one session's inbox or outbox, without
   * downloading any bytes.
   * @returns one entry per stored object directly inside the box.
   */
  async list(session: string, direction: FileDirection): Promise<StoredEntry[]> {
    const prefix = `${this.#config.prefix}/${session}/${direction}/`
    const objects = await (await this.#use()).list(prefix)
    return objects
      .map(object => ({ name: object.key.slice(prefix.length), size: object.size }))
      .filter(entry => entry.name !== '' && !entry.name.includes('/'))
  }

  /** Whether one named file exists under a session's inbox or outbox. */
  async exists(session: string, direction: FileDirection, name: string): Promise<boolean> {
    return (await this.#use()).exists(this.key(session, direction, name))
  }

  /** Download one named file's bytes; on-demand, never the whole box. */
  async get(session: string, direction: FileDirection, name: string): Promise<Uint8Array> {
    return (await this.#use()).get(this.key(session, direction, name))
  }
}
