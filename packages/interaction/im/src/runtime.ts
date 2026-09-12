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
import type { ParticipantId } from './model.ts'
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

/** Owns one resumable Agent per AI identity across its joined chats. */
export class ImRuntime {
  private readonly connected = new Map<string, Connected>()
  private tail = Promise.resolve()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /**
   * Bring one AI online and replay its durable inbox. The Session identity survives disconnect and restart.
   * @param participant - AI to connect.
   * @returns after the restored or new Agent can accept messages.
   */
  connect(participant: ParticipantId): Promise<void> {
    const job = this.tail.then(async () => {
      this.lifetime.signal.throwIfAborted()
      const key = JSON.stringify([participant])
      if (this.connected.has(key)) return
      const selection = this.ctx.agentDefaultModel.currentSelection()
      const prior = this.ctx.im.agentBindings().find(value => value.participant === participant)
      const binding = { participant, sessionId: prior?.sessionId ?? SessionId(`im-${randomUUID()}`), enabled: true }
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
        const detach = attachAgent(this.ctx, this.ctx.im, participant, handle.agent)
        this.connected.set(key, { handle, detach })
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
   * @param participant - AI to disconnect.
   * @returns after its active work stops and owned resources drain.
   */
  async disconnect(participant: ParticipantId): Promise<void> {
    await this.tail
    const binding = this.ctx.im.agentBindings().find(value => value.participant === participant)
    if (binding === undefined) throw new Error('IM Agent binding not found')
    await this.ctx.im.setAgentBinding({ ...binding, enabled: false })
    const key = JSON.stringify([participant])
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
    if (binding.enabled) await runtime.connect(binding.participant)
  }
}
