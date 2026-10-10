/** Bounded WeCom downloads, SDK decryption, and durable prompt attachment admission. */

import { decryptFile } from '@wecom/aibot-node-sdk'
import { parse } from 'content-disposition'
import sharp from 'sharp'
import type { AttachmentStore, AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MessagePart } from './message.ts'

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
  return { data, ...name === undefined ? {} : { name } }
}

/**
 * Save callback attachments before admitting any model-visible message.
 * @param store - attachment provider shared with the model and file tools.
 * @param parts - validated text and attachment references in message order.
 * @param maxBytes - aggregate decrypted attachment byte limit for this message.
 * @param signal - cancellation and deadline covering downloads and admission.
 * @returns ordered content carrying durable references, with no download URLs or keys.
 * @throws on download, decryption, size, image-validation, storage, or cancellation failure.
 */
export async function admitMessageContent(
  store: AttachmentStore, parts: readonly MessagePart[], maxBytes: number, signal: AbortSignal,
): Promise<ContentBlock[]> {
  const content: AttachmentAdmissionPart[] = []
  let remaining = maxBytes
  for (const part of parts) {
    signal.throwIfAborted()
    switch (part.msgtype) {
      case 'text':
        content.push({ type: 'text', text: part.text.content })
        break
      case 'image': {
        const input = await download(part.image, remaining, signal)
        remaining -= input.data.byteLength
        const { format } = await sharp(input.data, { limitInputPixels: store.imageLimits.maxImagePixels }).metadata()
        if (format !== 'png' && format !== 'jpeg' && format !== 'webp' && format !== 'gif') {
          throw new Error('WeCom attachment uses an unsupported image format')
        }
        content.push({ type: 'image', data: input.data.toString('base64'), mediaType: `image/${format}`, ...input.name === undefined ? {} : { name: input.name } })
        break
      }
      case 'file': {
        const input = await download(part.file, remaining, signal)
        remaining -= input.data.byteLength
        content.push({ type: 'file', attachment: await store.saveFile(input) })
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
