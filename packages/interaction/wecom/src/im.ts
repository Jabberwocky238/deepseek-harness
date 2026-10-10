/** Conversation-scoped IM tools and acknowledged WeCom outbound delivery. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { attachAgent, conversationIdSchema, participantIdSchema } from '@deepseek-ai/dsh-im'
import type { WSClient } from '@wecom/aibot-node-sdk'
import { limitReply, type InboundMessage } from './message.ts'

/**
 * Attach IM tools to an authenticated WeCom conversation without sharing other users' contact lists.
 * @param ctx - bot context providing IM, Session projections, Sessions, and attachment storage.
 * @param agent - Agent owned by this bot and conversation.
 * @param client - authenticated bot transport; the bot owns its disconnection.
 * @param inbound - validated callback selecting the user or group destination.
 * @param maxAiMessages - durable publication budget for this conversation.
 * @param maxReplyBytes - maximum outbound text bytes.
 * @param contacts - optional trusted bot roster including this bot; matching rosters share contacts for one user and chat.
 * @returns a function selecting the authenticated chat before its next input; Agent disposal drains outbound delivery.
 */
export async function bindImConversation(
  ctx: Context, agent: Agent, client: WSClient, inbound: InboundMessage, maxAiMessages: number, maxReplyBytes: number,
  contacts?: { botId: string; name: string }[],
): Promise<() => Promise<void>> {
  const im = ctx.get('im')
  if (im === undefined || ctx.get('sessionProjections') === undefined) throw new Error('wecom IM tools require im and sessionProjections')
  const body = inbound.body
  const destination = body.chattype === 'group' ? body.chatid : body.from.userid
  const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const roster = contacts
  const namespace = `wecom:${digest([roster?.map(bot => bot.botId).sort() ?? body.aibotid, body.chattype, destination, body.from.userid])}`
  const human = participantIdSchema.parse(`${namespace}:user`)
  const suffix = roster === undefined ? '' : `:${digest(body.aibotid)}`
  const participant = participantIdSchema.parse(`${namespace}:agent${suffix}`)
  const conversation = conversationIdSchema.parse(`${namespace}:conversation${suffix}`)
  await im.addParticipant({ id: human, kind: 'human', name: body.from.userid, namespace })
  if (roster === undefined) await im.addParticipant({ id: participant, kind: 'ai', name: 'WeCom Agent', namespace })
  else {
    for (const bot of roster) {
      await im.addParticipant({ id: participantIdSchema.parse(`${namespace}:agent:${digest(bot.botId)}`), kind: 'ai', name: bot.name, namespace })
    }
    for (const bot of roster) {
      if (bot.botId === body.aibotid) continue
      const peer = participantIdSchema.parse(`${namespace}:agent:${digest(bot.botId)}`)
      const members = [participant, peer].sort()
      await im.addContact(human, participant, peer)
      await im.addConversation({
        id: conversationIdSchema.parse(`${namespace}:contacts:${digest(members)}`), namespace, kind: 'direct',
        name: 'WeCom Agent contacts', owner: human, members, maxAiMessages,
      })
    }
  }
  await im.addConversation({
    id: conversation, namespace, kind: body.chattype === 'group' ? 'group' : 'direct',
    name: 'WeCom conversation', owner: human, members: [human, participant], maxAiMessages,
  })
  await im.addContact(human, participant, human)
  await im.addContact(human, human, participant)
  agent.ctx.effect(function* () {
    yield attachAgent(ctx, im, participant, agent)
    yield im.register(conversation, human, async (message, signal) => {
      signal.throwIfAborted()
      let remaining = im.attachmentLimits().maxBytes
      if (message.text !== '') {
        await client.sendMessage(destination, { msgtype: 'markdown', markdown: { content: limitReply(message.text, maxReplyBytes) } })
      }
      for (const part of message.attachments) {
        signal.throwIfAborted()
        const chunks: Uint8Array[] = []
        const append = (chunk: Uint8Array): void => {
          remaining -= chunk.byteLength
          if (remaining < 0) throw new Error('WeCom upload exceeds the IM attachment byte limit')
          chunks.push(chunk)
        }
        if (part.type === 'image') append((await ctx.attachments.readImage(part.attachment)).data)
        else for await (const chunk of ctx.attachments.readFileStream(part.attachment)) {
          signal.throwIfAborted()
          append(chunk)
        }
        signal.throwIfAborted()
        const media = await client.uploadMedia(Buffer.concat(chunks), {
          type: part.type, filename: part.attachment.name ?? part.attachment.attachmentId,
        })
        signal.throwIfAborted()
        await client.sendMediaMessage(destination, part.type, media.media_id)
      }
    })
  }, 'wecom IM tools and outbound delivery')
  return () => im.setAgentPage(participant, body.chattype === 'group' ? { kind: 'group', id: conversation } : { kind: 'contact', id: human })
}
