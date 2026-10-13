/** Bounded WeCom downloads, SDK decryption, container inbox materialization, and durable prompt attachment admission. */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { decryptFile } from '@wecom/aibot-node-sdk'
import { parse } from 'content-disposition'
import sharp from 'sharp'
import type { AttachmentStore, AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MessagePart } from './message.ts'
import type { FileStore } from './file-store.ts'

/** The image formats the model can be shown directly, with their admitted media type and inbox extension. */
const VISION_FORMATS: Record<string, { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; extension: string }> = {
  png: { mediaType: 'image/png', extension: 'png' },
  jpeg: { mediaType: 'image/jpeg', extension: 'jpg' },
  webp: { mediaType: 'image/webp', extension: 'webp' },
  gif: { mediaType: 'image/gif', extension: 'gif' },
}

/**
 * Where inbound attachments are published for the Agent to read. `publish`
 * writes one file without overwriting an earlier one — a name already present
 * becomes a sibling (`report-1.docx`) — and returns the path the Agent opens.
 */
export interface InboundInbox {
  /**
   * Publish one attachment.
   * @param name - one plain path segment, the preferred file name.
   * @param data - exact file bytes.
   * @returns the path, in the Agent's own filesystem, of the file written.
   */
  publish(name: string, data: Uint8Array): Promise<string>
}

/** Split a file name into the stem and extension sibling names are built from. */
export function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: '' }
}

/**
 * An inbox the plugin writes on the host, bound into the Agent's filesystem by
 * the deployment (single-workspace mode).
 * @param agentDir - the directory as the Agent sees it, named in the prompt.
 * @param hostDir - the same directory on the host, where the bytes are written.
 * @returns the inbox.
 */
export function hostInbox(agentDir: string, hostDir: string): InboundInbox {
  return {
    publish: async (name, data) => {
      await mkdir(hostDir, { recursive: true })
      const { stem, extension } = splitName(name)
      for (let attempt = 0; ; attempt += 1) {
        const unique = attempt === 0 ? name : `${stem}-${attempt}${extension}`
        try {
          await writeFile(join(hostDir, unique), data, { flag: 'wx' })
          return join(agentDir, unique)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error
        }
      }
    },
  }
}

async function download(media: { url: string; aeskey?: string | undefined }, maxBytes: number, signal: AbortSignal) {
  const response = await fetch(media.url, { signal, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('WeCom attachment download failed')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength
    // WeCom encrypts with PKCS#7 padding to a 32-byte block.
    if (bytes > maxBytes + 32) throw new Error('WeCom attachment exceeds the byte limit')
    chunks.push(chunk)
  }
  const encoded = Buffer.concat(chunks)
  const data = media.aeskey === undefined ? encoded : decryptFile(encoded, media.aeskey)
  if (data.byteLength > maxBytes) throw new Error('WeCom attachment exceeds the byte limit')
  const disposition = response.headers.get('content-disposition')
  const name = disposition === null ? undefined : parse(disposition).parameters['filename']
  return { data, ...name === undefined ? {} : { name: decodePercent(name) } }
}

/**
 * WeCom sends the plain `filename` parameter percent-encoded (`Jingyu%2BShen.pdf`,
 * `%E6%8A%A5%E5%91%8A.pdf`), so a name carrying escapes is decoded. A name whose
 * `%` is not a valid escape (`50%off.pdf`) is kept as given; separators a decode
 * may produce are removed afterwards by {@link safeBaseName}.
 */
function decodePercent(name: string): string {
  if (!/%[0-9A-Fa-f]{2}/u.test(name)) return name
  try {
    return decodeURIComponent(name)
  } catch {
    // URIError: a stray `%` beside valid escapes; the name is not an encoding.
    return name
  }
}

/** Reduce a callback filename to one path segment the inbox may hold. */
function safeBaseName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().replace(/^\.+/, '')
  return cleaned === '' ? fallback : cleaned.slice(0, 120)
}

/**
 * Publish one attachment into the inbox and return the path the Agent reads.
 * When a file store is configured, the same bytes are also queued for its inbox
 * under the conversation's Session id and the published file name; the upload
 * runs in the background, so the message is admitted without waiting for it.
 */
async function materialize(
  inbox: InboundInbox,
  name: string,
  data: Uint8Array,
  fileStore?: FileStore,
  session?: string,
): Promise<string> {
  const path = await inbox.publish(name, data)
  if (fileStore !== undefined && session !== undefined) fileStore.enqueue(session, 'inbox', basename(path), data)
  return path
}

/** The prompt part that tells the Agent where one delivered attachment landed. */
function inboxNote(path: string, label: string, data: Uint8Array): AttachmentAdmissionPart {
  return { type: 'text', text: `[附件已保存：${path}（${label}，${data.byteLength} 字节）]` }
}

/**
 * Detect a vision-capable image format.
 * @returns the format entry, or undefined when the payload is not an image this
 *   build can show — an undecodable or oversized payload is not a failure, it
 *   is simply delivered as a file like every other format.
 */
async function visionFormat(data: Uint8Array, store: AttachmentStore) {
  try {
    const { format } = await sharp(data, { limitInputPixels: store.imageLimits.maxImagePixels }).metadata()
    return format === undefined ? undefined : VISION_FORMATS[format]
  } catch {
    return undefined
  }
}

/**
 * Save callback attachments before admitting any model-visible message.
 *
 * Media the callback delivers by URL (image, file, video) is written into the
 * configured inbox first and named in the prompt, so the Agent can open the
 * bytes with its own tools whatever the format is. Without an inbox the bytes
 * stay in the attachment store instead, which the model sees only as an opaque
 * reference. Images whose format `sharp` recognizes are additionally admitted
 * for vision; an unrecognized image is still delivered as a file. WeCom sends
 * voice as recognized text with no audio URL, so a voice part is admitted as
 * that text.
 * @param store - attachment provider shared with the model and file tools.
 * @param parts - validated text, voice and attachment references in message order.
 * @param maxBytes - aggregate decrypted attachment byte limit for this message.
 * @param signal - cancellation and deadline covering downloads and admission.
 * @param inbox - where attachments are published for the Agent, when configured;
 *   the path it returns is the one the prompt names.
 * @param fileStore - per-session inbox/outbox storage, when enabled. Each
 *   materialized attachment is also queued for `session`'s inbox.
 * @param session - the conversation's Session id keying the stored file.
 * @returns ordered content carrying durable references, with no download URLs or keys.
 * @throws on download, decryption, size, storage, inbox-write, or cancellation failure.
 */
export async function admitMessageContent(
  store: AttachmentStore,
  parts: readonly MessagePart[],
  maxBytes: number,
  signal: AbortSignal,
  inbox?: InboundInbox,
  fileStore?: FileStore,
  session?: string,
): Promise<ContentBlock[]> {
  const content: AttachmentAdmissionPart[] = []
  let remaining = maxBytes
  for (const part of parts) {
    signal.throwIfAborted()
    switch (part.msgtype) {
      case 'text':
        content.push({ type: 'text', text: part.text.content })
        break
      case 'voice':
        content.push({
          type: 'text',
          text: part.voice.content.trim() === ''
            ? '[用户发来语音，未能转写为文字]'
            : `[用户发来语音，转写文字：${part.voice.content}]`,
        })
        break
      case 'image': {
        const input = await download(part.image, remaining, signal)
        remaining -= input.data.byteLength
        const format = await visionFormat(input.data, store)
        if (inbox !== undefined) {
          content.push(inboxNote(
            await materialize(inbox, safeBaseName(input.name, format === undefined ? 'image.bin' : `image.${format.extension}`), input.data, fileStore, session),
            '图片',
            input.data,
          ))
        }
        if (format !== undefined) {
          content.push({ type: 'image', data: input.data.toString('base64'), mediaType: format.mediaType, ...input.name === undefined ? {} : { name: input.name } })
        } else if (inbox === undefined) {
          // No inbox and no vision: the attachment store is the only delivery left.
          content.push({ type: 'file', attachment: await store.saveFile(input) })
        }
        break
      }
      case 'file':
      case 'video': {
        const video = part.msgtype === 'video'
        const input = await download(video ? part.video : part.file, remaining, signal)
        remaining -= input.data.byteLength
        content.push(inbox === undefined
          ? { type: 'file', attachment: await store.saveFile(input) }
          : inboxNote(
            await materialize(inbox, safeBaseName(input.name, video ? 'video.mp4' : 'file'), input.data, fileStore, session),
            video ? '视频' : '文件',
            input.data,
          ))
        break
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(part)
    }
  }
  signal.throwIfAborted()
  const admitted = await store.admitPromptContent(content)
  signal.throwIfAborted()
  return admitted
}
