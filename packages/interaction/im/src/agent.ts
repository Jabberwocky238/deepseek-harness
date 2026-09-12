/** AI recipient admission and the scoped, permission-checked talk tool. */

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
import { imMessageIdSchema, participantIdSchema } from './model.ts'
import type { ConversationId, ImAttachment, ParticipantId } from './model.ts'
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
    return id.startsWith('im:') && !state.includes(id) ? [...state, id] : state
  },
}

/**
 * Bind one AI in one conversation to an externally owned Agent; ordinary model replies are not forwarded to other AIs.
 * Queue delivery preserves running tools and prevents unstarted tools until the new input reaches a model request.
 * @param ctx - owning plugin context; must provide Sessions, tools, and Session projections.
 * @param im - persistent message distributor.
 * @param conversation - explicit conversation membership.
 * @param participant - AI identity whose authority the talk tool uses.
 * @param agent - dedicated Agent for this participant and conversation.
 * @returns a disposer that removes tools, guards, and receiver admission; the caller still owns Agent disposal.
 */
export function attachAgent(
  ctx: Context, im: ImService, conversation: ConversationId, participant: ParticipantId, agent: Agent,
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
    description: 'Publish text, images, or files in this conversation. People in the conversation can see your message and attachments. Set to to address an authorized AI; omit it to address the human members. AI-to-AI contact requires explicit permission. Delivery does not stop a tool already running.',
    parameters: {
      to: { type: 'string', description: 'Participant id of the recipient; omission addresses the human members.' },
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
      const room = im.conversations(participant, im.participant(participant).namespace).find(value => value.id === conversation)
      if (room === undefined) throw new Error('IM conversation membership required')
      const recipients = args.to === undefined
        ? room.members.filter(id => im.participant(id).kind === 'human')
        : [participantIdSchema.parse(args.to)]
      const sent = await im.send({
        id: imMessageIdSchema.parse(randomUUID()), conversation, sender: participant,
        recipients, text: args.message, mode: 'queue', attachments,
      })
      return { id: sent.id, sequence: sent.sequence }
    },
  }))
  let removeReceiver: () => Promise<void>
  try {
    removeReceiver = im.register(conversation, participant, async (message, signal) => {
      signal.throwIfAborted()
      const id = MessageId(`im:${message.id}`)
      const accepted = projections.stateOf(agent.session, 'imReceipts')
      if (accepted === undefined) throw new Error('IM receipt projection is missing')
      if (accepted.includes(id)) return
      for (const target of ['next-step', 'next-turn'] as const) {
        const inbox = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
        const index = inbox.findIndex(value => value.id === id)
        if (index >= 0) agent.inbox.splice(target, index, 1, [])
      }
      const sender = im.participant(message.sender)
      const input = freezeMessage({
        id, role: 'user' as const,
        source: sender.kind === 'human' ? { kind: 'user' as const } : { kind: 'plugin' as const, plugin: 'im', form: 'relay' as const },
        content: [{ type: 'text' as const, text: JSON.stringify({ sender: sender.id, name: sender.name, text: message.text }) }, ...message.attachments],
      })
      switch (message.mode) {
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
    removeTool()
    removeGuard()
    removeProjection()
  }
}
