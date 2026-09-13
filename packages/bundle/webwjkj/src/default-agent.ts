/** Conversation-isolated model replies for the webwjkj default contact. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Conversation, ImMessage, ImMessageId } from '@deepseek-ai/dsh-im'

/** Cordis plugin name. */
export const name = 'webwjkj-default-agent'
/** Model, durable transcript, and IM dependencies for the reply consumer. */
export const inject = ['im', 'agents', 'agentLoop', 'agentDefaultModel', 'sessions', 'sessionPersistence']
/** Deployment limits for each isolated model request. */
export interface Config {
  /** Maximum time for model creation and reply generation. */
  timeoutMs: number
  /** Maximum recent conversation messages supplied to the model. */
  historyMessages: number
  /** Maximum output tokens per reply. */
  maxTokens: number
  /** Maximum AI messages permitted in each default-agent conversation. */
  maxAiMessages: number
}
/** Validated reply limits. */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(100).max(2147483647).required(),
  historyMessages: z.natural().min(1).required(),
  maxTokens: z.natural().min(1).required(),
  maxAiMessages: z.natural().min(1).required(),
})
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owns bounded model turns for authorized default-agent direct messages. */
    webwjkjAgent: { reply(room: Conversation, input: ImMessage): Promise<void> }
  }
}
/**
 * Register the default-agent reply consumer with per-conversation serialization.
 * @param ctx - composed model and persistent messaging services.
 * @param config - deployment limits.
 */
export function apply(ctx: Context, config: Config): void {
  const lifetime = new AbortController()
  const pending = new Map<string, Promise<void>>()
  ctx.provide('webwjkjAgent', { reply(room, input) {
    const prior = pending.get(room.id) ?? Promise.resolve()
    const job = prior.catch(() => { /* A failed earlier reply must not block later messages. */ }).then(async () => {
      lifetime.signal.throwIfAborted()
      const recipient = input.recipients[0]
      if (room.namespace !== 'webwjkj' || room.kind !== 'direct' || room.owner !== input.sender
        || input.conversation !== room.id || input.recipients.length !== 1 || recipient !== 'webwjkj:default-agent') {
        throw new Error('Default agent requires an authorized direct conversation')
      }
      const digest = createHash('sha256').update(`webwjkj-reply:${input.id}`).digest('hex')
      const replyId = brandString<ImMessageId>(`${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`)
      const history = ctx.im.history(room.id, input.sender, 0)
      if (history.some(message => message.id === replyId)) {
        await ctx.im.acceptMessage(input.id, recipient)
        return
      }
      await ctx.im.setAiMessageLimit(room.id, room.owner, config.maxAiMessages)
      const selection = ctx.agentDefaultModel.currentSelection()
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.timeoutMs)])
      const handle = await ctx.agents.create({
        sessionId: SessionId(`webwjkj-${randomUUID()}`), signal,
        agentOptions: { ...selection, maxTokens: config.maxTokens },
        setup(agentCtx) { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
      })
      let text = ''
      let completed = false
      const remove = ctx.on('session/event', (session, event) => {
        if (session !== handle.agent.session) return
        if (event.type === 'assistant/message' && !event.data.interrupted) {
          text += event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('')
        }
        if (event.type === 'turn/end') completed = event.data.reason.kind === 'completed' || event.data.reason.kind === 'max-tokens'
      })
      const cancel = () => handle.agent.cancel({ kind: 'user' })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        const messages = history.filter(message => message.sequence <= input.sequence).slice(-config.historyMessages)
          .map(message => ({ role: message.sender === recipient ? 'assistant' : 'user', text: message.text }))
        handle.agent.followup(createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify(messages) }],
        }))
        // This handle belongs exclusively to this request; no other caller can add work.
        await handle.agent.whenIdle()
        signal.throwIfAborted()
        await ctx.sessions.flush(handle.agent.session)
        if (!completed || !text.trim()) throw new Error('Default agent did not produce a reply')
        await ctx.im.send({ id: replyId, conversation: room.id, sender: recipient, recipients: [input.sender], text, attachments: [], mode: 'queue' })
        await ctx.im.acceptMessage(input.id, recipient)
      } finally {
        signal.removeEventListener('abort', cancel)
        remove()
        await handle.dispose()
      }
    })
    pending.set(room.id, job)
    void job.finally(() => {
      if (pending.get(room.id) === job) pending.delete(room.id)
    }).catch(() => { /* The HTTP caller owns reply failures. */ })
    return job
  } })
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending.values()])
  })
}
