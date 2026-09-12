/** Recoverable Agent ownership for native IM participants, independent of external chat platforms. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { attachAgent } from './agent.ts'
import { imMessageIdSchema } from './model.ts'
import type { ConversationId, ParticipantId } from './model.ts'
import type {} from './index.ts'

/** Cordis function-plugin name. */
export const name = 'im-runtime'
/** The runtime requires durable Sessions and composed model/permission services. */
export const inject = ['im', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'tools', 'agentDefaultModel', 'permissionPresets']

/** Deployment-owned Agent environment; conversation data lives in the IM domain. */
export interface Config {
  /** Working directory shared by these AI participants. */
  workspacePath: string
  /** Permission policy applied to every owned Agent. */
  permissionPreset: string
  /** Optional scoped Agent capability preset. */
  agentPreset?: string
}

/** Validated runtime deployment configuration. */
export const Config: z<Config> = z.object({
  workspacePath: z.string().required(), permissionPreset: z.string().required(), agentPreset: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Context { imRuntime: ImRuntime }
}

interface Connected { handle: AgentHandle; detach: () => Promise<void> }

/** Owns one independently resumable Agent per AI and chat conversation. */
export class ImRuntime {
  private readonly connected = new Map<string, Connected>()
  private tail = Promise.resolve()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /**
   * Bring one AI online and replay its durable inbox. The Session identity survives disconnect and restart.
   * @param conversation - chat containing the AI.
   * @param participant - AI to connect.
   * @returns after the restored or new Agent can accept messages.
   */
  connect(conversation: ConversationId, participant: ParticipantId): Promise<void> {
    const job = this.tail.then(async () => {
      this.lifetime.signal.throwIfAborted()
      const key = JSON.stringify([conversation, participant])
      if (this.connected.has(key)) return
      const selection = this.ctx.agentDefaultModel.currentSelection()
      const prior = this.ctx.im.agentBindings().find(value => value.conversation === conversation && value.participant === participant)
      const binding = { conversation, participant, sessionId: prior?.sessionId ?? SessionId(`im-${randomUUID()}`), enabled: true }
      await this.ctx.im.setAgentBinding(binding)
      const setup = async (agentCtx: Context): Promise<void> => {
        if (this.config.agentPreset !== undefined) {
          const presets = this.ctx.get('agentPresets')
          if (presets === undefined) throw new Error('IM agentPreset requires the preset service')
          await presets.mount(agentCtx, this.config.agentPreset)
        }
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      }
      const options = { setup, signal: this.lifetime.signal, agentOptions: { provider: selection.provider, model: selection.model } }
      const exists = await this.ctx.sessionPersistence.stat(binding.sessionId)
      const handle = exists === undefined
        ? await this.ctx.agents.create({ ...options, sessionId: binding.sessionId, meta: { cwd: this.config.workspacePath } })
        : await this.ctx.agents.resume({ ...options, resumeSessionId: binding.sessionId })
      try {
        this.lifetime.signal.throwIfAborted()
        this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset)
        const detach = attachAgent(this.ctx, this.ctx.im, conversation, participant, handle.agent)
        const jobs = new Set<Promise<void>>()
        const removeReplies = this.ctx.on('session/event', (session, event) => {
          if (session !== handle.agent.session || event.type !== 'assistant/message') return
          const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
          if (text === '') return
          const group = this.ctx.im.conversations(participant, this.ctx.im.participant(participant).namespace)
            .find(value => value.id === conversation)
          const recipients = group?.members.filter(id => this.ctx.im.participant(id).kind === 'human') ?? []
          if (recipients.length === 0) return
          const job = this.ctx.im.send({
            id: imMessageIdSchema.parse(`reply:${session.id}:${String(event.seq)}`), conversation, sender: participant,
            recipients, text, attachments: [], mode: 'queue',
          }).then(() => {}, () => { this.ctx.logger.warn('IM assistant reply could not be published') })
          jobs.add(job)
          void job.then(() => { jobs.delete(job) })
        })
        this.connected.set(key, { handle, detach: async () => { removeReplies(); await detach(); await Promise.all(jobs) } })
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
    })
    this.tail = job.then(() => {}, () => {})
    return job
  }

  /**
   * Take an AI offline without deleting its inbox, history, or Session association.
   * @param conversation - chat containing the AI.
   * @param participant - AI to disconnect.
   * @returns after its active work stops and owned resources drain.
   */
  async disconnect(conversation: ConversationId, participant: ParticipantId): Promise<void> {
    await this.tail
    const binding = this.ctx.im.agentBindings().find(value => value.conversation === conversation && value.participant === participant)
    if (binding === undefined) throw new Error('IM Agent binding not found')
    await this.ctx.im.setAgentBinding({ ...binding, enabled: false })
    const key = JSON.stringify([conversation, participant])
    const connected = this.connected.get(key)
    this.connected.delete(key)
    if (connected !== undefined) {
      await connected.detach()
      await connected.handle.dispose()
    }
  }

  /**
   * Stop live Agents while retaining their configured online state for restart.
   * @returns after all creation and execution work reaches quiescence.
   */
  async close(): Promise<void> {
    this.lifetime.abort()
    await this.tail
    const connected = [...this.connected.values()]
    this.connected.clear()
    await Promise.all(connected.map(async (value) => { await value.detach(); await value.handle.dispose() }))
  }
}

/**
 * Restore enabled native IM Agents through the normal profile's services.
 * @param ctx - fully composed IM and Agent context.
 * @param config - deployment-owned execution environment.
 * @returns after previously online AI participants reconnect.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.permissionPresets.resolve(config.permissionPreset)
  const runtime = new ImRuntime(ctx, config)
  ctx.effect(() => () => runtime.close())
  ctx.provide('imRuntime', runtime)
  for (const binding of ctx.im.agentBindings()) {
    if (binding.enabled) await runtime.connect(binding.conversation, binding.participant)
  }
}
