import { mkdtemp, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as Im from '../src/index.ts'

const human = Im.participantIdSchema.parse('human')
const other = Im.participantIdSchema.parse('other')
const alice = Im.participantIdSchema.parse('alice')
const bob = Im.participantIdSchema.parse('bob')
const room = Im.conversationIdSchema.parse('room')
const grant = Im.authorizationIdSchema.parse('grant')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 10000 })

class Model extends LlmAdapter {
  requests: GenerateOptions[] = []
  responses: ((options: GenerateOptions) => AsyncIterable<StreamChunk>)[] = []
  override providerInfo() { return { id: 'mock', name: 'Mock' } }
  override listModels() { return Promise.resolve([]) }
  override resolveModel(provider: string, id: string) {
    return Promise.resolve({ provider, id, name: id, inputModalities: ['text'] as const, context: { contextWindow: 8192 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const respond = this.responses.shift()
    if (respond === undefined) {
      yield* text('done')
    } else yield* respond(options)
  }
}

async function* text(value: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* calls(names: string[]): AsyncIterable<StreamChunk> {
  for (const [index, name] of names.entries()) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`call-${String(index)}`), name, arguments: '{}' } }
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function harness(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-im-'))
  if (existingRoot === undefined) cleanups.push(() => rm(root, { recursive: true, force: true }))
  const configFile = join(root, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configFile)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new Model()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], model))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-im') return Im
      throw new Error(`Unexpected import ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configFile).href } })
  await ctx.loader.await()
  for (const [id, kind] of [[human, 'human'], [other, 'human'], [alice, 'ai'], [bob, 'ai']] as const) {
    await ctx.im.addParticipant({ id, kind, name: id, namespace: 'im' })
  }
  await ctx.im.addConversation({ id: room, namespace: 'im', kind: 'group', name: 'Room', owner: human, members: [human, other, alice, bob], maxAiMessages: 10 })
  return {
    ctx, root, model,
    async agent(participant = alice) {
      const handle = await ctx.agents.create({ sessionId: SessionId(`im-${participant}`), agentOptions: { provider: 'mock', model: 'mock' } })
      cleanups.push(() => handle.dispose())
      const remove = Im.attachAgent(ctx, ctx.im, room, participant, handle.agent)
      cleanups.push(remove)
      return handle.agent
    },
    send(id: string, sender = human, recipient = alice, mode: Im.DeliveryMode = 'queue') {
      return ctx.im.send({
        id: Im.imMessageIdSchema.parse(id), conversation: room, sender, recipients: [recipient], text: id, mode, attachments: [],
      })
    },
  }
}

it('persists human messages, resumes offline delivery, and deduplicates ids', async () => {
  const h = await harness()
  await h.send('hello', human, other)
  expect(h.ctx.im.history(room, other, 0)[0]?.deliveries[other]).toBe('pending')
  await h.ctx.fiber.dispose()
  const reopened = await harness(h.root)
  const received: string[] = []
  cleanups.push(reopened.ctx.im.register(room, other, async (message) => { received.push(message.text) }))
  await waitFor(() => { expect(received).toEqual(['hello']) })
  await reopened.send('hello', human, other)
  expect(reopened.ctx.im.history(room, human, 0)).toHaveLength(1)
  await expect(reopened.send('hello', other, human)).rejects.toThrow('id conflict')
  expect(reopened.ctx.im.history(room, human, 1)).toEqual([])
  expect(() => reopened.ctx.im.history(room, Im.participantIdSchema.parse('outsider'), 0)).toThrow('membership')
})

it('enforces dynamic one-way and two-way external authorizations at send time', async () => {
  const h = await harness()
  await expect(h.send('denied', alice, bob)).rejects.toThrow('not authorized')
  const authorization = { id: grant, conversation: room, from: alice, to: bob, direction: 'one-way' as const }
  await expect(h.ctx.im.grantAuthorization(alice, authorization)).rejects.toThrow('external human')
  await h.ctx.im.grantAuthorization(human, authorization)
  await h.send('forward', alice, bob)
  await expect(h.send('reverse-denied', bob, alice)).rejects.toThrow('not authorized')
  await h.ctx.im.updateAuthorization(human, grant, { from: alice, to: bob, direction: 'two-way' })
  await h.send('reverse', bob, alice)
  await h.ctx.im.revokeAuthorization(human, grant)
  await expect(h.send('revoked', alice, bob)).rejects.toThrow('not authorized')
  expect(h.ctx.im.history(room, human, 0).map(message => message.text)).toEqual(['forward', 'reverse'])
})

it('queues input during a running tool, completes that tool, and replans before the next tool', async () => {
  const h = await harness()
  const running = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const executed: string[] = []
  let signal: AbortSignal | undefined
  h.ctx.tools.register(defineContentToolFixture({ name: 'first', description: 'first', parameters: {}, async execute(_args, exec) {
    signal = exec.signal
    executed.push('first-start')
    running.resolve(undefined)
    await release.promise
    executed.push('first-end')
    return [{ type: 'text', text: 'first finished' }]
  } }))
  for (const name of ['stale', 'replacement']) h.ctx.tools.register(defineContentToolFixture({
    name, description: name, parameters: {}, execute: async () => { executed.push(name); return [{ type: 'text', text: name }] },
  }))
  h.model.responses.push(() => calls(['first', 'stale']), async function*(options) {
    expect(JSON.stringify(options.messages)).toContain('change plan')
    yield* calls(['replacement'])
  })
  const agent = await h.agent()
  cleanups.push(async () => { release.resolve(undefined) })
  await h.send('start')
  await running.promise
  await h.send('change plan')
  await waitFor(() => { expect(agent.inbox.nextStep).toHaveLength(1) })
  expect(signal?.aborted).toBe(false)
  expect(executed).toEqual(['first-start'])
  release.resolve(undefined)
  await agent.whenIdle()
  expect(executed).toEqual(['first-start', 'first-end', 'replacement'])
  expect(h.model.requests).toHaveLength(3)
})

it('interrupt mode cancels active work while preserving queued messages', async () => {
  const h = await harness()
  const started = Promise.withResolvers<undefined>()
  let signal: AbortSignal | undefined
  h.model.responses.push(async function*(options) {
    signal = options.signal
    started.resolve(undefined)
    await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
    yield* text('interrupted')
  })
  const agent = await h.agent()
  await h.send('start')
  await started.promise
  await h.send('queued')
  await h.send('interrupt', human, alice, 'interrupt')
  await waitFor(() => { expect(h.model.requests.length).toBeGreaterThan(1) })
  await agent.whenIdle()
  expect(signal?.aborted).toBe(true)
  expect(JSON.stringify(h.model.requests.slice(1))).toContain('queued')
  expect(JSON.stringify(h.model.requests.slice(1))).toContain('interrupt')
})

it('talk uses its bound AI identity and rechecks authorization on every execution', async () => {
  const h = await harness()
  const agent = await h.agent()
  const delivered: string[] = []
  cleanups.push(h.ctx.im.register(room, bob, async (message) => { delivered.push(message.text) }))
  const talk = () => h.ctx.tools.execute({ name: 'talk', arguments: { to: bob, message: 'hello bob' }, callId: ToolCallId('talk-test'), agent, signal: new AbortController().signal })
  expect((await talk()).isError).toBe(true)
  await h.ctx.im.grantAuthorization(human, { id: grant, conversation: room, from: alice, to: bob, direction: 'one-way' })
  expect((await talk()).isError).not.toBe(true)
  await waitFor(() => { expect(delivered).toEqual(['hello bob']) })
  await h.ctx.im.revokeAuthorization(human, grant)
  expect((await talk()).isError).toBe(true)
})
