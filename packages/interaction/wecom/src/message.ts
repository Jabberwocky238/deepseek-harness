/** Validation of WeCom callback frames and UTF-8 reply limits. */

import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

type WecomUserId = Branded<'WecomUserId'>
type WecomMessageId = Branded<'WecomMessageId'>
type WecomChatId = Branded<'WecomChatId'>
type WecomBotId = Branded<'WecomBotId'>
type WecomRequestId = Branded<'WecomRequestId'>

const identifier = z.string().min(1).refine(value => value.trim() === value)
const identity = z.object({
  msgid: identifier.transform(value => brandString<WecomMessageId>(value)),
  aibotid: identifier.transform(value => brandString<WecomBotId>(value)),
  from: z.object({ userid: identifier.transform(value => brandString<WecomUserId>(value)) }),
})

const textPart = z.object({
  msgtype: z.literal('text'),
  text: z.object({ content: z.string().min(1).refine(value => value.trim() !== '') }),
})
const media = z.object({
  url: z.url().refine((value) => {
    const url = new URL(value)
    return url.username === '' && url.password === ''
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  }),
  aeskey: z.string().regex(/^[A-Za-z0-9+/]{43}=?$/).optional(),
})
const imagePart = z.object({ msgtype: z.literal('image'), image: media })
const part = z.discriminatedUnion('msgtype', [textPart, imagePart, z.object({ msgtype: z.literal('file'), file: media })])
const payload = z.union([
  part,
  z.object({ msgtype: z.literal('mixed'), mixed: z.object({ msg_item: z.array(z.discriminatedUnion('msgtype', [textPart, imagePart])).min(1) }) }),
])

/** Callback identities and supported message content; unused fields are stripped. */
export const messageSchema = z.object({
  headers: z.object({ req_id: identifier.transform(value => brandString<WecomRequestId>(value)) }),
  body: z.intersection(z.discriminatedUnion('chattype', [
    identity.extend({ chattype: z.literal('single') }),
    identity.extend({ chattype: z.literal('group'), chatid: identifier.transform(value => brandString<WecomChatId>(value)) }),
  ]), payload),
})

/** Parsed callback; download URLs and keys are consumed only by attachment admission. */
export type InboundMessage = z.infer<typeof messageSchema>
/** One ordered text, image, or file input from a callback. */
export type MessagePart = z.infer<typeof part>

/**
 * Preserve the order of text and attachments in an admitted callback.
 * @param message - validated callback.
 * @returns individual input parts in their original order.
 */
export function messageParts(message: InboundMessage): readonly MessagePart[] {
  return message.body.msgtype === 'mixed' ? message.body.mixed.msg_item : [message.body]
}

/**
 * Bound a complete reply to WeCom's UTF-8 limit without splitting a code point.
 * @param text - complete model or status text.
 * @param maxBytes - positive configured limit of at least four bytes.
 * @returns text, or a truncated prefix with an ellipsis included in the limit.
 */
export function limitReply(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let result = ''
  let bytes = 3
  for (const character of text) {
    bytes += Buffer.byteLength(character)
    if (bytes > maxBytes) break
    result += character
  }
  return result + '…'
}
