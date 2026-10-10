/** Outbound text, image and file delivery over the authenticated bot transport. */

import type { WSClient } from '@wecom/aibot-node-sdk'

/** One outbound attachment, already read out of the agent's filesystem. */
export interface WecomOutboundFile {
  /** Exact file bytes. */
  data: Uint8Array
  /** Name the recipient sees. */
  name: string
  /** Media kind the upload declares and the message repeats. */
  kind: 'file' | 'image'
}

/** One proactive message to a chat: text, attachments, or both. */
export interface WecomOutbound {
  /** Markdown text; omitted or empty sends no text message. */
  text?: string | undefined
  /** Attachments to publish in order. */
  files?: readonly WecomOutboundFile[] | undefined
}

/** What one delivery actually sent, so a caller can report it. */
export interface WecomDelivered {
  /** Whether a text message was sent. */
  text: boolean
  /** How many attachments were uploaded and published. */
  files: number
}

/**
 * Publish one proactive message into a chat the bot is authenticated for.
 *
 * Each attachment uploads through the SDK's own init/chunk/finish exchange, so
 * no caller needs to know that protocol. `chatid` is the WeCom chat the
 * conversation already belongs to: a group's id, or the user id of a direct
 * chat.
 *
 * @param client - the authenticated bot transport that owns this chat.
 * @param chatid - destination chat id.
 * @param outbound - text and attachments to publish.
 * @returns what was delivered.
 */
export async function sendToChat(
  client: WSClient,
  chatid: string,
  outbound: WecomOutbound,
): Promise<WecomDelivered> {
  const text = outbound.text?.trim() ?? ''
  if (text) await client.sendMessage(chatid, { msgtype: 'markdown', markdown: { content: text } })
  let files = 0
  for (const file of outbound.files ?? []) {
    const uploaded = await client.uploadMedia(Buffer.from(file.data), {
      type: file.kind,
      filename: file.name,
    })
    await client.sendMessage(chatid, file.kind === 'image'
      ? { msgtype: 'image', image: { media_id: uploaded.media_id } }
      : { msgtype: 'file', file: { media_id: uploaded.media_id } })
    files += 1
  }
  return { text: Boolean(text), files }
}
