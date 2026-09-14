/** Upload admission and authenticated download of conversation-owned attachments. */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImService, ImAttachment, ConversationId, ParticipantId } from '@deepseek-ai/dsh-im'
import type { AccountUser } from './account-types.ts'

/** File bytes supplied by the bounded multipart request parser. */
export interface UploadedFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}
/** Authorized attachment response; filenames are display values, never paths. */
export interface AttachmentDownload { content: Uint8Array; type: string; inline: boolean }
/**
 * Validate aggregate limits and store uploaded files with the existing attachment provider.
 * @param im - conversation attachment limits.
 * @param store - durable attachment provider.
 * @param files - bounded multipart files.
 * @returns verified references for the message commit.
 */
export async function admitUploads(im: ImService, store: AttachmentStore, files: UploadedFile[]): Promise<ImAttachment[]> {
  const limits = im.attachmentLimits()
  if (files.length > limits.maxCount || files.reduce((sum, file) => sum + file.size, 0) > limits.maxBytes) {
    throw new Error('IM attachment limits exceeded')
  }
  const attachments: ImAttachment[] = []
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer())
    const mediaType = file.type
    if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif') {
      attachments.push({ type: 'image', attachment: await store.saveImage({ data, name: file.name, mediaType }) })
    } else {
      attachments.push({ type: 'file', attachment: await store.saveFile({ data, name: file.name }) })
    }
  }
  return attachments
}
/**
 * Read an attachment only after checking the requesting account's conversation membership.
 * @param im - durable conversation service.
 * @param store - private binary storage.
 * @param user - authenticated account.
 * @param url - message and attachment position, never a storage object identifier.
 * @returns bytes and verified response media type.
 */
export async function readImAttachment(im: ImService, store: AttachmentStore, user: AccountUser, url: URL): Promise<AttachmentDownload> {
  const owner = brandString<ParticipantId>(`webwjkj:${user.id}`)
  const conversation = brandString<ConversationId>(url.searchParams.get('conversation') ?? '')
  const message = im.history(conversation, owner, 0).find(item => item.id === url.searchParams.get('message'))
  const index = Number(url.searchParams.get('index'))
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid attachment index')
  const part = message?.attachments[index]
  if (!part) throw new Error('Attachment not found')
  if (part.type === 'image') return { content: (await store.readImage(part.attachment)).data, type: part.attachment.mediaType, inline: true }
  const chunks: Uint8Array[] = []
  for await (const chunk of store.readFileStream(part.attachment)) chunks.push(chunk)
  return { content: Buffer.concat(chunks), type: 'application/octet-stream', inline: false }
}
