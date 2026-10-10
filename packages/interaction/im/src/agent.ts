/** AI recipient admission, private IM discovery, and permission-checked messaging. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { agentPageSchema, conversationIdSchema, imMessageIdSchema } from './model.ts'
import type { ImAttachment, ParticipantId } from './model.ts'
import type { ImService } from './index.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** IM identities committed as model-visible user input. */
    imReceipts: string[]
  }
}

const receipts: ProjectionDefinition<'imReceipts'> = {
  key: 'imReceipts', stateVersion: 1, stateSchema: z.array(z.string()), init: () => [],
  apply(state, event) {
    if (event.type !== 'user/message') return state
    const id = event.data.id
    return (id.startsWith('im:') || id.startsWith('im-notice:')) && !state.includes(id) ? [...state, id] : state
  },
}

/**
 * Bind one AI identity to an externally owned Agent; ordinary model replies are not forwarded to other AIs.
 * Queue delivery preserves running tools and prevents unstarted tools until the new input reaches a model request.
 * @param ctx - owning plugin context; must provide Sessions, tools, and Session projections.
 * @param im - persistent message distributor.
 * @param participant - AI identity used for private discovery and messaging authority.
 * @param agent - dedicated Agent for this participant and conversation.
 * @returns a disposer that removes tools, guards, and receiver admission; the caller still owns Agent disposal.
 */
export function attachAgent(
  ctx: Context, im: ImService, participant: ParticipantId, agent: Agent,
): () => Promise<void> {
  if (im.participant(participant).kind !== 'ai') throw new Error('IM Agent binding requires an AI participant')
  const projections = ctx.sessionProjections
  const removeProjection = projections.register(receipts)
  const acknowledgements = new Set<Promise<void>>()
  const removeEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'user/message' || !event.data.id.startsWith('im:')) return
    const id = imMessageIdSchema.parse(event.data.id.slice(3))
    const job = (async () => {
      await ctx.sessions.flush(session)
      await im.acceptMessage(id, participant)
    })().catch(() => { ctx.logger.warn('IM input acknowledgement remains pending') })
    acknowledgements.add(job)
    void job.then(() => { acknowledgements.delete(job) })
  })
  const removeGuard = agent.ctx.tools.guard(() => agent.inbox.nextStep.some(message => message.id.startsWith('im:'))
    ? 'New conversation input is waiting. Read it before choosing another tool call.'
    : undefined)
  const removeTool = agent.ctx.tools.register(defineTool({
    name: 'talk',
    description: 'Send IM replies, text, images, or files in a joined conversation. Use talk for every outgoing IM message; ordinary assistant text is private. People in the conversation can see your message and attachments. Messages are visible to all members of the selected chat. Direct chats require a mutual contact. Group members can communicate in their group. Delivery does not stop a tool already running.',
    parameters: {
      conversation: { type: 'string', description: 'Joined conversation id from im_context; omission uses your selected page.' },
      message: { type: 'string', required: true, description: 'Message text; may be empty when sending attachments.' },
      files: {
        type: 'array', description: 'Workspace files to publish without interpreting their contents.',
        items: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', required: true, description: 'Path in your filesystem.' },
          kind: { type: 'string', enum: ['file', 'image'], required: true },
          media_type: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], description: 'Required for images.' },
        } },
      },
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'string', required: true }, sequence: { type: 'number', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('talk must execute as its bound AI participant')
      const attachments: ImAttachment[] = []
      const limits = im.attachmentLimits()
      if ((args.files?.length ?? 0) > limits.maxCount) throw new Error('IM attachment count exceeded')
      let remaining = limits.maxBytes
      for (const file of args.files ?? []) {
        const fs = agent.ctx.get('fs')
        const store = ctx.get('attachments')
        if (fs === undefined || store === undefined) throw new Error('talk files require filesystem and attachment services')
        const target = await fs.resolve(file.path, {
          ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }, signal: exec.signal,
        })
        const data = await fs.readBytes(target, exec.signal, remaining)
        remaining -= data.byteLength
        switch (file.kind) {
          case 'file':
            attachments.push({ type: 'file', attachment: await store.saveFile({ data, name: basename(file.path) }) })
            break
          case 'image':
            if (file.media_type === undefined) throw new Error('talk images require media_type')
            attachments.push({ type: 'image', attachment: await store.saveImage({ data, name: basename(file.path), mediaType: file.media_type }) })
            break
        }
      }
      const page = im.agentPage(participant)
      const joined = im.conversations(participant, im.participant(participant).namespace)
      const selected = page.kind === 'group' ? page.id : page.kind === 'contact'
        ? joined.find(chat => chat.kind === 'direct' && chat.members.includes(page.id))?.id : undefined
      const destination = args.conversation === undefined ? selected : conversationIdSchema.parse(args.conversation)
      if (destination === undefined) throw new Error('Select a conversation with im_context or provide conversation to talk')
      const room = im.conversations(participant, im.participant(participant).namespace).find(value => value.id === destination)
      if (room === undefined) throw new Error('IM conversation membership required')
      const recipients = room.members.filter(id => id !== participant)
      const sent = await im.send({
        id: imMessageIdSchema.parse(randomUUID()), conversation: destination, sender: participant,
        recipients, text: args.message, mode: 'queue', attachments,
      })
      return { id: sent.id, sequence: sent.sequence }
    },
  }))
  let removeReceiver: () => Promise<void>
  let removeContext: (() => void) | undefined
  try {
    const person = {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        kind: { type: 'string', enum: ['human', 'ai'], required: true },
        namespace: { type: 'string', required: true },
      },
    } as const
    removeContext = agent.ctx.tools.register(defineTool({
      name: 'im_context',
      description: 'See your own IM identity, contacts, and joined direct chats and groups. Contact ids address participants; conversation ids identify chats. Contacts authorize private communication in both directions. Group members can communicate in their group. Use conversation ids with talk to select a joined chat. Set page to view a group or contact; unread content on that page enters your queue before the next tool. Set page kind to none to leave all pages and receive only sender/count notifications.',
      parameters: {
        page: {
          type: 'object', description: 'Set the page in front of you: group or contact with its id, or none to leave all pages.',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['none', 'group', 'contact'], required: true },
            id: { type: 'string', description: 'Required for a group or contact page.' },
          },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            self: { ...person, required: true },
            page: {
              type: 'object', required: true, additionalProperties: false,
              properties: { kind: { type: 'string', required: true }, id: { type: 'string' } },
            },
            unread: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  conversation: { type: 'string', required: true }, sender: { type: 'string', required: true },
                  name: { type: 'string', required: true }, count: { type: 'number', required: true },
                },
              },
            },
            contacts: { type: 'array', items: person, required: true },
            conversations: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  kind: { type: 'string', enum: ['direct', 'group'], required: true },
                  members: { type: 'array', items: person, required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent !== agent) throw new Error('im_context must execute as its bound AI participant')
        if (args.page !== undefined) await im.setAgentPage(participant, agentPageSchema.parse(args.page))
        const self = im.participant(participant)
        const unread = new Map<string, { conversation: string; sender: string; name: string; count: number }>()
        for (const message of im.inbox(participant)) {
          const key = JSON.stringify([message.conversation, message.sender])
          const summary = unread.get(key)
          if (summary === undefined) unread.set(key, {
            conversation: message.conversation, sender: message.sender, name: im.participant(message.sender).name, count: 1,
          })
          else summary.count++
        }
        return {
          self, page: im.agentPage(participant), unread: [...unread.values()],
          contacts: im.contacts(participant),
          conversations: im.conversations(participant, self.namespace).map(chat => ({
            id: chat.id, name: chat.name, kind: chat.kind, members: chat.members.map(id => im.participant(id)),
          })),
        }
      },
    }))
    removeReceiver = im.registerParticipant(participant, async (message, signal) => {
      signal.throwIfAborted()
      const page = im.agentPage(participant)
      const chat = im.conversations(participant, im.participant(participant).namespace).find(value => value.id === message.conversation)
      const viewing = (page.kind === 'group' && page.id === message.conversation)
        || (page.kind === 'contact' && chat?.kind === 'direct' && chat.members.includes(page.id))
      const noticePrefix = `im-notice:${JSON.stringify([message.conversation, message.sender])}:`
      const id = MessageId(viewing ? `im:${message.id}` : `${noticePrefix}${message.id}`)
      const accepted = projections.stateOf(agent.session, 'imReceipts')
      if (accepted === undefined) throw new Error('IM receipt projection is missing')
      if (accepted.includes(id)) return viewing ? undefined : 'queued'
      for (const target of ['next-step', 'next-turn'] as const) {
        const inbox = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
        for (let index = inbox.length - 1; index >= 0; index--) {
          const pending = inbox[index]
          if (pending?.id === id || pending?.id.startsWith(noticePrefix)) agent.inbox.splice(target, index, 1, [])
        }
      }
      const sender = im.participant(message.sender)
      const notification = {
        conversation: message.conversation, conversationName: chat?.name, sender: sender.id, name: sender.name,
        count: im.inbox(participant).filter(value => value.conversation === message.conversation && value.sender === message.sender).length,
      }
      const input = freezeMessage({
        id, role: 'user' as const,
        source: viewing && sender.kind === 'human' ? { kind: 'user' as const } : { kind: 'plugin' as const, plugin: 'im', form: 'relay' as const },
        content: viewing
          ? [{ type: 'text' as const, text: JSON.stringify({ conversation: message.conversation, sender: sender.id, name: sender.name, text: message.text }) }, ...message.attachments]
          : [{ type: 'text' as const, text: JSON.stringify({ notification, action: 'You may ignore this notification or open its page with im_context.' }) }],
      })
      switch (viewing ? 'queue' : message.mode) {
        case 'interrupt':
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          agent.steer(input)
          break
        case 'queue':
          agent.steer(input)
          break
      }
      await ctx.sessions.flush(agent.session)
      return 'queued'
    })
  } catch (error: unknown) {
    removeContext?.()
    removeTool()
    removeGuard()
    removeProjection()
    removeEvents()
    throw error
  }
  return async () => {
    await removeReceiver()
    removeEvents()
    await Promise.all(acknowledgements)
    removeContext()
    removeTool()
    removeGuard()
    removeProjection()
  }
}
