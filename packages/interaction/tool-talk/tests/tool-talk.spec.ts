import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as toolTalk from '../src/index.ts'
import { createTalkMessage, type TalkDirectory } from '../src/index.ts'

const contexts = new Set<Context>()
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/**
 * Two Agents and a `talk` service that delivers the way a host does: find the
 * target's live Agent and steer the talk message into it.
 */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0], config: Partial<toolTalk.Config> = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const alice = await ctx.agentLoop.create(SessionId('talk-alice'), { provider: 'mock', model: 'mock' })
  const bob = await ctx.agentLoop.create(SessionId('talk-bob'), { provider: 'mock', model: 'mock' })
  const addresses = new Map([['alice0001', alice], ['bob0002', bob]])
  const sent: { caller: string; address: string; text: string }[] = []
  const directory: TalkDirectory = {
    peers: async caller => [...addresses].map(([address, agent]) => ({ address, self: agent.session.id === caller })),
    send: async (caller, address, text) => {
      const target = addresses.get(address)
      if (target === undefined) throw new Error(`no Session has the address ${address}`)
      const sender = [...addresses].find(([, agent]) => agent.session.id === caller)?.[0] as string
      sent.push({ caller, address, text })
      const idle = target.status === 'idle'
      target.steer(createTalkMessage(caller, sender, text))
      return { address, delivery: idle ? 'woken' : 'queued' }
    },
  }
  ctx.provide('talk', directory)
  await ctx.plugin(toolTalk, { maxMessageChars: 20_000, ...config })
  return { ctx, alice, bob, adapter, sent }
}

function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`talk-call-${++callNumber}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('dsh-tool-talk', () => {
  it('lists the reachable Sessions with the caller marked', async () => {
    const { ctx, alice } = await setup([])
    const result = await execute(ctx, alice, 'talk_peers', {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({ peers: [{ address: 'alice0001', self: true }, { address: 'bob0002', self: false }] })
  })

  it('wakes an idle target with a message attributed to the sender', async () => {
    const { ctx, alice, bob, adapter } = await setup([textResponse('noted')])
    const result = await execute(ctx, alice, 'talk', { to: 'bob0002', message: 'please check the report' })
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({ address: 'bob0002', delivery: 'woken' })
    await bob.whenIdle()
    const delivered = bob.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
      .find(message => message.source.kind === 'talk-message')
    expect(delivered?.source).toEqual({ kind: 'talk-message', form: 'relay', senderSessionId: alice.session.id, senderAddress: 'alice0001' })
    expect(delivered?.content).toEqual([
      { type: 'text', text: 'Message from Session alice0001 (sent with talk). Your ordinary reply is not delivered to it; answer with talk to alice0001 if a reply is needed.' },
      { type: 'text', text: 'please check the report' },
    ])
    // The target ran a turn of its own for the message.
    expect(adapter.requests).toHaveLength(1)
    expect(bob.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('refuses empty, oversized and Agent-less messages without delivering them', async () => {
    const { ctx, alice, sent } = await setup([], { maxMessageChars: 5 })
    expect(text(await execute(ctx, alice, 'talk', { to: 'bob0002', message: '   ' }))).toContain('non-empty message')
    expect(text(await execute(ctx, alice, 'talk', { to: 'bob0002', message: 'too long' }))).toContain('at most 5 characters')
    expect(text(await execute(ctx, undefined, 'talk', { to: 'bob0002', message: 'hi' }))).toContain('Agent-bound call')
    expect(sent).toEqual([])
  })

  it('reports a refusal from the service', async () => {
    const { ctx, alice } = await setup([])
    const result = await execute(ctx, alice, 'talk', { to: 'carol0003', message: 'hi' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no Session has the address carol0003')
  })
})
