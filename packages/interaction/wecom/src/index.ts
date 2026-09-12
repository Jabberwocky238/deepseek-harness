/** WeCom text and attachment ingress with streaming replies over owned Agent activity intervals. */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { WSClient } from '@wecom/aibot-node-sdk'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createReplyStream } from './reply-stream.ts'
import { admitMessageContent } from './attachments.ts'
import { limitReply, messageSchema, messageParts, type InboundMessage } from './message.ts'

/** Cordis function-plugin name. */
export const name = 'wecom'
/** Services required before the bot accepts messages. */
export const inject = ['agents', 'sessions', 'credentials', 'agentDefaultModel', 'permissionPresets', 'attachments']

/** Connection, admission, and Agent settings for one WeCom bot. */
export interface Config {
  /** Bot identifier issued by WeCom. */
  botId: string
  /** Credential reference containing the bot secret. */
  secretEnv: string
  /** Exact WeCom user ids allowed to invoke the Agent; "*" allows everyone and an empty list denies everyone. */
  allowedUsers: string[]
  /** Existing absolute working directory shared by this bot's Agents. */
  workspacePath: string
  /** Permission preset applied before the first input is admitted. */
  permissionPreset: string
  /** Optional Agent preset; omission uses globally mounted capabilities. */
  agentPreset?: string
  /** WeCom endpoint; unencrypted connections are permitted only on loopback. */
  wsUrl: string
  /** Maximum retained conversations until plugin reload. */
  maxConversations: number
  /** Maximum accepted messages across active and queued work. */
  maxPendingMessages: number
  /** Number of completed message ids retained for process-local deduplication. */
  maxRecentMessages: number
  /** Maximum UTF-8 input bytes admitted to the Agent. */
  maxInputBytes: number
  /** Maximum total decrypted attachment bytes admitted from one message. */
  maxAttachmentBytes: number
  /** Maximum image or file parts admitted from one message. */
  maxAttachmentsPerMessage: number
  /** Total attachment download and admission deadline in milliseconds. */
  attachmentTimeoutMs: number
  /** Maximum complete reply bytes, including a truncation marker. */
  maxReplyBytes: number
  /** Interval in milliseconds for coalescing changed streaming reply text. */
  replyIntervalMs: number
  /** Maximum active Agent interval in milliseconds; expiry cancels and drains it. */
  runTimeoutMs: number
  /** SDK reconnection base delay in milliseconds. */
  reconnectIntervalMs: number
  /** Maximum SDK reconnection attempts. */
  maxReconnectAttempts: number
  /** Maximum SDK authentication attempts. */
  maxAuthFailureAttempts: number
  /** SDK heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number
  /** Language of transport status replies. */
  language: 'zh' | 'en'
}

export const Config: z<Config> = z.object({
  botId: z.string().required(),
  secretEnv: z.string().role('credential-ref').required(),
  allowedUsers: z.array(z.string()).required(),
  workspacePath: z.string().required(),
  permissionPreset: z.string().required(),
  agentPreset: z.string(),
  wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  maxConversations: z.number().step(1).min(1).default(100),
  maxPendingMessages: z.number().step(1).min(1).default(32),
  maxRecentMessages: z.number().step(1).min(1).default(1000),
  maxInputBytes: z.number().step(1).min(1).default(16384),
  maxAttachmentBytes: z.number().step(1).min(1).default(20971520),
  maxAttachmentsPerMessage: z.number().step(1).min(1).default(20),
  attachmentTimeoutMs: z.number().step(1).min(1).max(300000).default(30000),
  maxReplyBytes: z.number().step(1).min(4).max(20480).default(20480),
  replyIntervalMs: z.number().step(1).min(1).default(500),
  runTimeoutMs: z.number().step(1).min(1).max(300000).default(120000),
  reconnectIntervalMs: z.number().step(1).min(1).default(1000),
  maxReconnectAttempts: z.number().step(1).min(0).default(10),
  maxAuthFailureAttempts: z.number().step(1).min(1).default(5),
  heartbeatIntervalMs: z.number().step(1).min(1).default(30000),
  language: z.union(['zh', 'en']).default('zh'),
})

const replies = {
  zh: { attachmentFailed: '附件处理失败，请检查文件大小或重新发送。', processing: '正在处理中…', busy: '当前任务较多，请稍后重试。', failed: '任务未完成，请稍后重试。', timeout: '任务处理超时，已停止。', empty: '本次任务没有文本回复。', large: '消息过长，请缩短后重试。' },
  en: { attachmentFailed: 'The attachment could not be processed. Check its size or send it again.', processing: 'Working…', busy: 'The bot is busy. Please try again later.', failed: 'The task did not complete. Please try again later.', timeout: 'The task timed out and was stopped.', empty: 'This task produced no text reply.', large: 'The message is too long. Please shorten it and try again.' },
}

interface Conversation {
  handle?: AgentHandle
  tail: Promise<void>
}

/**
 * Connect one bot and own its queued work, Agents, and callback listeners.
 * @param ctx - plugin context carrying Agent and credential services.
 * @param config - validated bot configuration.
 * @returns after local configuration and dependencies are validated and connection starts.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const identifiers = [config.botId, config.permissionPreset, ...config.allowedUsers]
  if (config.agentPreset !== undefined) identifiers.push(config.agentPreset)
  for (const value of identifiers) {
    if (value.trim() === '' || value.trim() !== value) throw new Error('wecom identifiers must be non-empty and trimmed')
  }
  const url = new URL(config.wsUrl)
  if (url.username !== '' || url.password !== '' || !(url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('wecom wsUrl must use wss, or ws on loopback, without URL credentials')
  }
  if (!isAbsolute(config.workspacePath) || !(await stat(config.workspacePath)).isDirectory()) {
    throw new Error('wecom workspacePath must name an existing absolute directory')
  }
  ctx.permissionPresets.resolve(config.permissionPreset)
  const presets = ctx.get('agentPresets')
  let mountPreset: ((agentCtx: Context) => Promise<unknown>) | undefined
  if (config.agentPreset !== undefined) {
    if (presets === undefined) throw new Error('wecom agentPreset requires the agent-presets plugin')
    await presets.resolve(config.agentPreset)
    await presets.standingKeyFor(config.agentPreset)
    const presetId = config.agentPreset
    mountPreset = agentCtx => presets.mount(agentCtx, presetId)
  }
  const credential = await ctx.credentials.resolve(credentialRef(config.secretEnv))
  if (credential === undefined) throw new Error(`wecom credential ${config.secretEnv} is not configured`)
  const lifetime = new AbortController()
  const stopped = (): boolean => lifetime.signal.aborted
  const conversations = new Map<string, Conversation>()
  const pending = new Set<string>()
  const recent = new Set<string>()
  const jobs = new Set<Promise<void>>()
  const allowed = new Set(config.allowedUsers)
  const copy = replies[config.language]
  // SDK diagnostics can contain callback bodies; expose only fixed transport notices.
  const client = new WSClient({
    botId: config.botId,
    secret: credential.value,
    wsUrl: config.wsUrl,
    reconnectInterval: config.reconnectIntervalMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
    maxAuthFailureAttempts: config.maxAuthFailureAttempts,
    heartbeatInterval: config.heartbeatIntervalMs,
    maxReplyQueueSize: config.maxPendingMessages,
    logger: { debug() {}, info() {}, warn() { ctx.logger.warn('wecom transport warning') }, error() { ctx.logger.warn('wecom transport error') } },
  })

  const track = (job: Promise<void>): void => {
    jobs.add(job)
    void job.then(() => { jobs.delete(job) })
  }
  const reply = async (message: InboundMessage, text: string, streamId = randomUUID(), finish = true): Promise<void> => {
    if (stopped()) return
    try {
      await client.replyStream(message, streamId, limitReply(text, config.maxReplyBytes), finish)
    } catch {
      // SDK failures may embed callback frames; never log their payload or resend Agent work.
      ctx.logger.warn('wecom reply delivery failed')
    }
  }
  const run = async (conversation: Conversation, message: InboundMessage, stream: ReturnType<typeof createReplyStream>): Promise<void> => {
    if (stopped()) return
    let content: ContentBlock[]
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.attachmentTimeoutMs)])
      content = await admitMessageContent(ctx.attachments, messageParts(message), config.maxAttachmentBytes, signal)
    } catch {
      ctx.logger.warn('wecom attachment admission failed')
      await stream.finish(copy.attachmentFailed)
      return
    }
    if (conversation.handle === undefined) {
      const selection = ctx.agentDefaultModel.currentSelection()
      const handle = await ctx.agents.create({
        sessionId: SessionId(`wecom-${randomUUID()}`),
        signal: lifetime.signal,
        meta: { cwd: config.workspacePath, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await mountPreset?.(agentCtx)
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        },
      })
      try {
        lifetime.signal.throwIfAborted()
        ctx.permissionPresets.set(handle.agent.session, config.permissionPreset)
        conversation.handle = handle
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
    }
    const { agent } = conversation.handle
    await agent.whenIdle()
    if (stopped()) return
    const outcome: { text: string; reason?: TurnEndReason; timedOut: boolean } = { text: '', timedOut: false }
    let preview = ''
    const stopStream = ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source !== agent) return
      switch (frame.type) {
        case 'start':
          preview = ''
          stream.update(copy.processing)
          break
        case 'chunk':
          if (frame.chunk.type === 'text-delta') {
            preview = limitReply(preview + frame.chunk.text, config.maxReplyBytes)
            stream.update(preview)
          }
          break
        case 'end':
          if (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt') {
            stream.update(copy.processing)
          }
          break
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default:
          assertNever(frame)
      }
    })
    const stop = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'assistant/message') {
        outcome.text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        stream.update(outcome.text || copy.processing)
      }
      if (event.type === 'turn/end') outcome.reason = event.data.reason
    })
    const timeout = setTimeout(() => {
      outcome.timedOut = true
      agent.cancel({ kind: 'user' })
    }, config.runTimeoutMs)
    try {
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await agent.whenIdle()
    } finally {
      clearTimeout(timeout)
      stop()
      stopStream()
    }
    await ctx.sessions.flush(agent.session)
    await stream.finish(outcome.timedOut ? copy.timeout : outcome.reason?.kind === 'completed' ? outcome.text || copy.empty : copy.failed)
  }
  const receive = (frame: unknown): void => {
    const parsed = messageSchema.safeParse(frame)
    if (!parsed.success) return
    const message = parsed.data
    const body = message.body
    if (body.aibotid !== config.botId || !(allowed.has('*') || allowed.has(body.from.userid))) return
    if (pending.has(body.msgid) || recent.has(body.msgid)) return
    const parts = messageParts(message)
    const textBytes = parts.reduce((bytes, part) => bytes + (part.msgtype === 'text' ? Buffer.byteLength(part.text.content) : 0), 0)
    const attachments = parts.filter(part => part.msgtype !== 'text').length
    if (attachments > config.maxAttachmentsPerMessage) {
      if (jobs.size < config.maxPendingMessages) track(reply(message, copy.attachmentFailed))
      return
    }
    if (textBytes > config.maxInputBytes) {
      if (jobs.size < config.maxPendingMessages) track(reply(message, copy.large))
      return
    }
    const key = JSON.stringify([body.chattype, body.chattype === 'group' ? body.chatid : null, body.from.userid])
    let conversation = conversations.get(key)
    if (pending.size >= config.maxPendingMessages || (conversation === undefined && conversations.size >= config.maxConversations)) {
      if (jobs.size < config.maxPendingMessages) track(reply(message, copy.busy))
      return
    }
    if (conversation === undefined) {
      conversation = { tail: Promise.resolve() }
      conversations.set(key, conversation)
    }
    pending.add(body.msgid)
    const owned = conversation
    const streamId = randomUUID()
    const stream = createReplyStream((text, finish) => reply(message, text, streamId, finish), copy.processing, config.replyIntervalMs)
    const job = owned.tail.then(async () => {
      await using ownedStream = stream
      try {
        await run(owned, message, ownedStream)
      } catch {
        ctx.logger.warn('wecom Agent task failed')
        await ownedStream.finish(copy.failed)
      }
    }).finally(() => {
      pending.delete(body.msgid)
      recent.add(body.msgid)
      if (recent.size > config.maxRecentMessages) {
        for (const id of recent) {
          recent.delete(id)
          break
        }
      }
    })
    owned.tail = job
    track(job)
  }

  ctx.effect(() => {
    client.on('message', receive)
    client.on('error', () => { ctx.logger.warn('wecom connection failed; check bot credentials and network') })
    client.on('authenticated', () => { ctx.logger.info('wecom connected') })
    client.connect()
    return async () => {
      lifetime.abort()
      client.removeAllListeners()
      const closed = client.isConnected
        ? new Promise<void>((resolve) => { client.once('disconnected', () => { resolve() }) })
        : Promise.resolve()
      client.disconnect()
      const disposed = await Promise.allSettled([...conversations.values()].map(async (conversation) => {
        await conversation.handle?.dispose()
      }))
      await Promise.all(jobs)
      await closed
      client.removeAllListeners()
      conversations.clear()
      pending.clear()
      recent.clear()
      const failures = disposed.filter(result => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason as unknown), 'wecom Agent disposal failed')
    }
  }, 'wecom connection and conversations')
}
