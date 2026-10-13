/** WeCom text and attachment ingress with streaming replies over owned Agent activity intervals. */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
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
import { sendToChat, type WecomDelivered, type WecomOutbound } from './send.ts'
import { limitReply, messageSchema, messageParts, type InboundMessage } from './message.ts'
import { ensureSessionAlias, ensureSessionUser, resolveSshTarget, sessionIdentity, type SessionIdentity } from './session-user.ts'

/** Cordis function-plugin name. */
export const name = 'wecom'

/** Services required before the bot accepts messages. */
export const inject = ['agents', 'sessions', 'credentials', 'agentDefaultModel', 'permissionPresets', 'attachments', 'sessionProjections', 'tools']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Proactive outbound delivery, addressed by the Session that owns the chat.
     * A tool package publishes through this seam instead of holding the bot's
     * transport, and a Session the bot does not own has no target.
     */
    wecom: {
      send(sessionId: SessionId, outbound: WecomOutbound): Promise<WecomDelivered>
    }
  }
}

/** Connection, admission, and Agent settings for one WeCom bot. */
export interface Config {
  /** Bot identifier issued by WeCom. */
  botId: string
  /** Credential reference containing the bot secret. */
  secretEnv: string
  /** Exact WeCom user ids allowed to invoke the Agent; "*" allows everyone and an empty list denies everyone. */
  allowedUsers: string[]
  /**
   * Absolute root under which each conversation gets its own login and home
   * directory. Configured together with {@link sessionSshHost}, it switches this
   * bot to one container login per conversation; leaving both unset keeps every
   * conversation in {@link workspacePath}.
   */
  sessionHomeRoot?: string
  /**
   * Deployment-owned OpenSSH alias addressing this bot's container. Each
   * conversation's alias is generated from it, and its public key is installed
   * for every conversation's login.
   */
  sessionSshHost?: string
  /** Container-side provisioner creating a conversation's login, home and key. */
  sessionUserScript?: string
  /** Remote ssh helper entry each conversation's connection launches. */
  sessionHelper?: string
  /** SHA-256 of that helper; required in conversation-scoped mode. */
  sessionHelperHash?: string
  /** Host-side OpenSSH include file receiving one alias per conversation. */
  sessionSshConfig?: string
  /** Existing absolute working directory shared by this bot's Agents, in single-workspace mode. */
  workspacePath?: string
  /** Permission preset applied before the first input is admitted. */
  permissionPreset: string
  /** Optional Agent preset; omission uses globally mounted capabilities. */
  agentPreset?: string
  /**
   * Resume each conversation's persisted Session across restarts instead of
   * starting a fresh one. Off by default: the ids a conversation maps to are
   * then random and process-local, so a reload begins a new conversation.
   * Turning this on derives the Session id from the WeCom conversation itself,
   * so a mounted Session persistence restores the earlier history on the next
   * start.
   */
  resumeConversations?: boolean
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
  /**
   * Absolute directory inside the Agent's own filesystem where inbound
   * attachments are saved and named in the prompt, so the Agent can open the
   * bytes with its tools whatever their format is.
   */
  inboundDir: string
  /**
   * Host-side path bound to {@link inboundDir}. The plugin writes attachments
   * here; the provider's filesystem has no binary write, so the bytes reach the
   * container through the deployment's own mount. Omission keeps inbound
   * attachments in the attachment store only.
   */
  inboundHostDir?: string
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
  sessionHomeRoot: z.string(),
  sessionSshHost: z.string(),
  sessionUserScript: z.string().default('/usr/local/sbin/dsh-session-user'),
  sessionHelper: z.string().default('/opt/dsh-ssh-helper/dsh-ssh-helper'),
  sessionHelperHash: z.string(),
  sessionSshConfig: z.string().default('~/.ssh/dsh-sessions.conf'),
  workspacePath: z.string(),
  permissionPreset: z.string().required(),
  agentPreset: z.string(),
  resumeConversations: z.boolean().default(false),
  wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  maxConversations: z.number().step(1).min(1).default(100),
  maxPendingMessages: z.number().step(1).min(1).default(32),
  maxRecentMessages: z.number().step(1).min(1).default(1000),
  maxInputBytes: z.number().step(1).min(1).default(16384),
  maxAttachmentBytes: z.number().step(1).min(1).default(20971520),
  inboundDir: z.string().default('/home/agent/inbox'),
  inboundHostDir: z.string(),
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
  zh: { attachmentFailed: '附件处理失败，请检查文件大小或重新发送。', processing: '正在处理中…', busy: '当前任务较多，请稍后重试。', failed: '任务未完成，请稍后重试。', timeout: '任务处理超时，已停止。', empty: '本次任务没有文本回复。', large: '消息过长，请缩短后重试。', done: '已发送。', interrupted: '用户打断回复。' },
  en: { attachmentFailed: 'The attachment could not be processed. Check its size or send it again.', processing: 'Working…', busy: 'The bot is busy. Please try again later.', failed: 'The task did not complete. Please try again later.', timeout: 'The task timed out and was stopped.', empty: 'This task produced no text reply.', large: 'The message is too long. Please shorten it and try again.', done: 'Sent.', interrupted: 'Interrupted by a newer message.' },
}

/**
 * The turn currently answering one conversation. A newer inbound message
 * interrupts it so its unfinished reply block leaves the chat instead of
 * holding the newest position while the next answer waits behind it.
 */
interface ActiveTurn {
  /** Cancel the answering turn; its block is cleared by {@link ActiveTurn.clear}. */
  interrupt(): void
  /** Remove this turn's reply block from the chat. */
  clear(): Promise<void>
}

interface Conversation {
  handle?: AgentHandle
  tail: Promise<void>
  /** The answering turn, present only while one is running. */
  active?: ActiveTurn | undefined
  /**
   * Session identity derived from this conversation, present only while
   * `resumeConversations` is on. It outlives the process: the same WeCom
   * conversation recomputes the same id on the next start.
   */
  sessionId?: SessionId
  /**
   * Container login this conversation works as, present only in
   * conversation-scoped mode. Derived from the same key as {@link sessionId},
   * so it is stable across restarts too.
   */
  identity?: SessionIdentity
}

/**
 * Stable Session id for one WeCom conversation, derived from the bot and the
 * conversation key this plugin already tracks. Used only when
 * `resumeConversations` is on: the same conversation then recomputes the same
 * id on a later start, so a mounted Session persistence resumes its history
 * instead of opening a new conversation.
 */
function conversationSessionId(botId: string, key: string): SessionId {
  const digest = createHash('sha256').update(JSON.stringify([botId, key])).digest('hex')
  return SessionId(`wecom-${digest}`)
}

/**
 * Mount the conversation's own execution providers inside its Agent scope: the
 * ssh providers connect as {@link SessionIdentity.user} to
 * {@link SessionIdentity.home}, so the Bash and filesystem tools this Agent
 * mounts resolve them instead of the deployment-wide providers the plugin
 * itself uses to provision logins.
 * @param agentCtx - the Agent's unpublished scope.
 * @param identity - conversation identity to connect as.
 * @param config - configuration as validated by {@link Config}.
 */
/** Service names this Agent's providers replace, so one conversation cannot reach another's. */
const SESSION_SERVICES = ['ssh', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'shell'] as const

async function mountSessionProviders(agentCtx: Context, identity: SessionIdentity, config: Config): Promise<void> {
  const [ssh, fs, subprocess, sandbox, shell] = await Promise.all([
    import('@deepseek-ai/dsh-ssh'),
    import('@deepseek-ai/dsh-fs-ssh'),
    import('@deepseek-ai/dsh-subprocess-ssh'),
    import('@deepseek-ai/dsh-sandbox-ssh'),
    import('@deepseek-ai/dsh-bash-sandbox'),
  ])
  await agentCtx.plugin(ssh.default, {
    host: identity.alias,
    launch: { kind: 'executable' },
    helper: config.sessionHelper ?? '/opt/dsh-ssh-helper/dsh-ssh-helper',
    helperHash: config.sessionHelperHash ?? '',
    workspace: identity.home,
  })
  await agentCtx.plugin(fs.default)
  await agentCtx.plugin(subprocess.default)
  await agentCtx.plugin(sandbox.default)
  // The shell provider closes the chain: the Bash tool resolves `ctx.shell`
  // here, and this executor spawns through the conversation's own providers.
  await agentCtx.plugin(shell.default, { timeoutMs: 60_000 })
}

/**
 * Working directory of one conversation's Agent.
 * @param config - configuration as validated by {@link Config}.
 * @param identity - conversation identity, absent in single-workspace mode.
 * @returns the conversation's home in conversation-scoped mode, else the shared workspace.
 */
function conversationCwd(config: Config, identity: SessionIdentity | undefined): string {
  if (identity !== undefined) return identity.home
  if (config.workspacePath === undefined) throw new Error('wecom: no working directory is configured')
  return config.workspacePath
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
  // Only the shape is checked here. The directory belongs to whichever
  // filesystem provider is composed -- a remote SSH provider has no local
  // path to stat, and the provider reports a missing directory on first use.
  const perConversation = config.sessionHomeRoot !== undefined || config.sessionSshHost !== undefined
  if (perConversation) {
    if (config.sessionHomeRoot === undefined || config.sessionSshHost === undefined) {
      throw new Error('wecom sessionHomeRoot and sessionSshHost must be configured together')
    }
    if (!isAbsolute(config.sessionHomeRoot)) throw new Error('wecom sessionHomeRoot must be an absolute path')
  } else if (config.workspacePath === undefined) {
    throw new Error('wecom workspacePath is required unless sessionHomeRoot and sessionSshHost are configured')
  } else if (!isAbsolute(config.workspacePath)) {
    throw new Error('wecom workspacePath must be an absolute path')
  }
  if (config.inboundHostDir !== undefined && !(isAbsolute(config.inboundDir) && isAbsolute(config.inboundHostDir))) {
    throw new Error('wecom inbound directories must be absolute paths')
  }
  // Conversation-scoped bots address their container through generated aliases
  // that copy this deployment alias, so its effective connection is read once.
  const sshTarget = config.sessionHomeRoot === undefined || config.sessionSshHost === undefined
    ? undefined
    : await resolveSshTarget(config.sessionSshHost)
  // Provisioning runs through the deployment-wide shell provider. `ctx.get`
  // reads the global service store, where the property proxy would not.
  const sessionShell = sshTarget === undefined ? undefined : ctx.get('shell')
  if (sshTarget !== undefined && sessionShell === undefined) {
    throw new Error('wecom: conversation-scoped conversations require a mounted shell provider')
  }
  const sshConfigPath = config.sessionSshConfig ?? '~/.ssh/dsh-sessions.conf'
  // Inbound attachments are published into the Agent's filesystem through a
  // deployment-provided mount, so the plugin writes its host side.
  const inbox = config.inboundHostDir === undefined
    ? undefined
    : { agentDir: config.inboundDir, hostDir: config.inboundHostDir }
  ctx.permissionPresets.resolve(config.permissionPreset)
  const presets = ctx.get('agentPresets')
  let mountPreset: ((agentCtx: Context) => Promise<unknown>) | undefined
  // The registry hands out a standing scope per preset; this plugin holds it for
  // its own lifetime so every session it creates joins the same mounted tree.
  let presetScope: AsyncDisposable | undefined
  if (config.agentPreset !== undefined) {
    if (presets === undefined) throw new Error('wecom agentPreset requires the agent-preset registry plugin')
    const preset = await presets.resolve(config.agentPreset)
    presetScope = await presets.acquireScope(preset.id)
    mountPreset = agentCtx => presets.mount(agentCtx, preset.id)
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
  /**
   * The outbound surface a tool package publishes through: one authenticated
   * chat per live Session. A Session the bot does not own finds no target, so a
   * tool cannot address a chat this process is not connected to.
   */
  const sendTargets = new Map<string, { client: WSClient; chatid: string; delivered: boolean }>()
  ctx.provide('wecom', {
    send: async (sessionId: string, outbound: WecomOutbound): Promise<WecomDelivered> => {
      const target = sendTargets.get(sessionId)
      if (target === undefined) throw new Error('wecom: this Session is not an authenticated WeCom conversation')
      const delivered = await sendToChat(target.client, target.chatid, outbound)
      // A tool already put this turn's attachments in the chat, so the closing
      // text has to follow them instead of completing the anchored reply.
      if (delivered.files > 0) target.delivered = true
      return delivered
    },
  })
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
  /**
   * Register this turn as the conversation's answering turn, so a newer message
   * can cancel it, and keep that registration until the turn unwinds.
   */
  const run = async (conversation: Conversation, message: InboundMessage, stream: ReturnType<typeof createReplyStream>): Promise<void> => {
    if (stopped()) return
    let interrupted = false
    const turn: ActiveTurn = {
      interrupt: () => {
        interrupted = true
        conversation.handle?.agent.cancel({ kind: 'user' })
      },
      // WeCom offers no way to remove a stream block: an empty finish leaves
      // the block rendering the platform's own streaming status, a zero-width
      // finish does the same, and emptying the content in a separate live frame
      // before closing replaces it with platform text. The one behaviour the
      // platform does honour is a non-empty final content, so the interrupted
      // turn is closed with a notice that says why it stopped.
      clear: () => stream.finish(copy.interrupted),
    }
    conversation.active = turn
    try {
      await answer(conversation, message, stream, () => interrupted)
    } finally {
      if (conversation.active === turn) conversation.active = undefined
    }
  }
  const answer = async (
    conversation: Conversation,
    message: InboundMessage,
    stream: ReturnType<typeof createReplyStream>,
    interrupted: () => boolean,
  ): Promise<void> => {
    if (stopped()) return
    let content: ContentBlock[]
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.attachmentTimeoutMs)])
      content = await admitMessageContent(ctx.attachments, messageParts(message), config.maxAttachmentBytes, signal, inbox)
    } catch {
      ctx.logger.warn('wecom attachment admission failed')
      if (!interrupted()) await stream.finish(copy.attachmentFailed)
      return
    }
    if (conversation.handle === undefined) {
      const selection = ctx.agentDefaultModel.currentSelection()
      const identity = conversation.identity
      const cwd = conversationCwd(config, identity)
      const setup = async (agentCtx: Context): Promise<void> => {
        // The deployment-wide providers already hold these names, so the
        // conversation's own providers are mounted below an isolated scope and
        // the Agent's preset joins that scope: its tools then resolve the
        // conversation's connections instead of the deployment-wide ones.
        let scope = agentCtx
        if (identity !== undefined && sshTarget !== undefined && sessionShell !== undefined) {
          // The login must exist before its providers connect, and the alias
          // before those connections resolve.
          await ensureSessionUser(sessionShell, identity,
            config.sessionUserScript ?? '/usr/local/sbin/dsh-session-user', sshTarget.publicKey, config.attachmentTimeoutMs)
          await ensureSessionAlias(identity, sshTarget, sshConfigPath)
          scope = SESSION_SERVICES.reduce((inner, name) => inner.isolate(name), agentCtx)
          await mountSessionProviders(scope, identity, config)
        }
        await mountPreset?.(scope)
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      }
      const agentOptions = { provider: selection.provider, model: selection.model }
      // No persisted conversation takes the random-id path, and a resumed one
      // falls back to creation while its log is still absent.
      const sessionId = conversation.sessionId ?? SessionId(`wecom-${randomUUID()}`)
      const handle = conversation.sessionId === undefined
        ? await ctx.agents.create({
          sessionId,
          signal: lifetime.signal,
          meta: { cwd, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
          agentOptions,
          setup,
        })
        : await ctx.agents.resume({ resumeSessionId: sessionId, signal: lifetime.signal, agentOptions, setup })
          .catch(() => ctx.agents.create({
            sessionId,
            signal: lifetime.signal,
            meta: { cwd, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
            agentOptions,
            setup,
          }))
      try {
        lifetime.signal.throwIfAborted()
        ctx.permissionPresets.set(handle.agent.session, config.permissionPreset)
        conversation.handle = handle
        // The chat this Session answers in: a group's own id, or the user id of
        // a direct chat. Outbound tools address this Session, never a raw chat.
        sendTargets.set(handle.agent.session.id, {
          client,
          chatid: message.body.chattype === 'group'
            ? message.body.chatid ?? message.body.from.userid
            : message.body.from.userid,
          delivered: false,
        })
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
    }
    const { agent } = conversation.handle
    // 本轮是否已用主动消息发过附件，决定收尾文字走流式还是主动消息。
    const target = sendTargets.get(agent.session.id)
    if (target !== undefined) target.delivered = false
    await agent.whenIdle()
    if (stopped()) return
    const outcome: { text: string; reason?: TurnEndReason; timedOut: boolean } = { text: '', timedOut: false }
    let preview = ''
    /** Block index the live preview belongs to; a new block replaces it wholesale. */
    let previewBlock = -1
    const stopStream = ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source !== agent) return
      switch (frame.type) {
        case 'start':
          preview = ''
          previewBlock = -1
          stream.update(copy.processing)
          break
        case 'chunk':
          // Whatever the model emits — its reasoning and its reply alike — goes
          // to the chat verbatim, as the one live block. Nothing here invents
          // text of its own, and a new block replaces the previous block's text
          // instead of appending to it.
          if (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta') {
            if (frame.chunk.index !== previewBlock) {
              previewBlock = frame.chunk.index
              preview = ''
            }
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
    // A newer message already cleared this block and owns the chat now.
    if (interrupted()) return
    const closing = outcome.timedOut ? copy.timeout : outcome.reason?.kind === 'completed' ? outcome.text || copy.empty : copy.failed
    if (target?.delivered === true && outcome.reason?.kind === 'completed' && outcome.text) {
      // 附件已经是主动消息，排在流式回复之后；文字也发成主动消息，顺序才是
      // 「文件 → 文字」。流式回复只留一句进度说明。
      await stream.finish(copy.done)
      await sendToChat(target.client, target.chatid, { text: closing })
    } else {
      await stream.finish(closing)
    }
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
      conversation = {
        tail: Promise.resolve(),
        ...config.resumeConversations ? { sessionId: conversationSessionId(config.botId, key) } : {},
        ...config.sessionHomeRoot === undefined || config.sessionSshHost === undefined
          ? {}
          : { identity: sessionIdentity(config.botId, key, config.sessionHomeRoot, config.sessionSshHost) },
      }
      conversations.set(key, conversation)
    }
    const answering = conversation.active
    if (answering !== undefined) {
      answering.interrupt()
      void answering.clear()
    }
    pending.add(body.msgid)
    const owned = conversation
    const streamId = randomUUID()
    const stream = createReplyStream((text, finish) => reply(message, text, streamId, finish), copy.processing, config.replyIntervalMs)
    const job = owned.tail.then(async () => {
      await using ownedStream = stream
      try {
        await run(owned, message, ownedStream)
      } catch (error: unknown) {
        // A turn that throws still owes the chat the fixed failure status.
        ctx.logger.warn('wecom Agent task failed: %o', error)
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
      sendTargets.clear()
      await presetScope?.[Symbol.asyncDispose]()
      const failures = disposed.filter(result => result.status === 'rejected')
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'wecom Agent disposal failed')
    }
  }, 'wecom connection and conversations')
}
