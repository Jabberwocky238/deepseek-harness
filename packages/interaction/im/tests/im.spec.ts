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
      const remove = Im.attachAgent(ctx, ctx.im, participant, handle.agent)
      cleanups.push(remove)
      return handle.agent
    },
    send(id: string, sender = human, recipient = alice, mode: Im.DeliveryMode = 'queue', conversation = room) {
      return ctx.im.send({
        id: Im.imMessageIdSchema.parse(id), conversation, sender, recipients: [recipient], text: id, mode, attachments: [],
      })
    },
  }
}

async function privateChat(h: Awaited<ReturnType<typeof harness>>) {
  const id = Im.conversationIdSchema.parse('ai-direct')
  await h.ctx.im.addConversation({
    id, namespace: 'im', kind: 'direct', name: 'AI direct', owner: human, members: [alice, bob], maxAiMessages: 10,
  })
  return id
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

it('uses external authorization APIs to create, replace, and remove mutual contacts', async () => {
  const h = await harness()
  const direct = await privateChat(h)
  const send = (id: string, from = alice, to = bob) => h.send(id, from, to, 'queue', direct)
  await expect(send('denied', alice, bob)).rejects.toThrow('requires a contact')
  const authorization = { id: grant, from: alice, to: bob }
  await expect(h.ctx.im.grantAuthorization(alice, authorization)).rejects.toThrow('external human')
  await h.ctx.im.grantAuthorization(human, authorization)
  expect(h.ctx.im.contacts(alice).map(contact => contact.id)).toEqual([bob])
  expect(h.ctx.im.contacts(bob).map(contact => contact.id)).toEqual([alice])
  await send('forward', alice, bob)
  await h.ctx.im.updateAuthorization(human, grant, { from: bob, to: alice })
  expect(h.ctx.im.contacts(bob).map(contact => contact.id)).toEqual([alice])
  await send('reverse', bob, alice)
  await h.ctx.im.revokeAuthorization(human, grant)
  expect(h.ctx.im.contacts(alice)).toEqual([])
  expect(h.ctx.im.contacts(bob)).toEqual([])
  await expect(send('revoked', alice, bob)).rejects.toThrow('requires a contact')
  expect(h.ctx.im.history(direct, human, 0).map(message => message.text)).toEqual(['forward', 'reverse'])
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
  await h.ctx.im.setAgentPage(alice, { kind: 'group', id: room })
  const agent = await h.agent()
  cleanups.push(async () => { release.resolve(undefined) })
  await h.send('start')
  await running.promise
  await h.send('change plan', human, alice, 'interrupt')
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
  expect(h.ctx.im.inbox(alice).map(message => message.text)).toEqual(['start', 'queued', 'interrupt'])
  expect(JSON.stringify(h.model.requests.slice(1))).toContain('interrupt')
})

it('talk uses its bound AI identity and rechecks authorization on every execution', async () => {
  const h = await harness()
  const direct = await privateChat(h)
  const agent = await h.agent()
  const delivered: string[] = []
  cleanups.push(h.ctx.im.register(direct, bob, async (message) => { delivered.push(message.text) }))
  const talk = () => h.ctx.tools.execute({ name: 'talk', arguments: { conversation: direct, to: bob, message: 'hello bob' }, callId: ToolCallId('talk-test'), agent, signal: new AbortController().signal })
  expect((await talk()).isError).toBe(true)
  await h.ctx.im.grantAuthorization(human, { id: grant, from: alice, to: bob })
  expect((await talk()).isError).not.toBe(true)
  await waitFor(() => { expect(delivered).toEqual(['hello bob']) })
  await h.ctx.im.revokeAuthorization(human, grant)
  expect((await talk()).isError).toBe(true)
})


it('discovers the bound identity, live private contacts, and joined chats with contact-based permission', async () => {
  const h = await harness()
  const agent = await h.agent()
  const peer = await h.agent(bob)
  await h.ctx.im.addContact(human, alice, bob)
  await h.ctx.im.addContact(human, bob, other)
  const hidden = Im.conversationIdSchema.parse('private')
  await h.ctx.im.addConversation({
    id: hidden, namespace: 'im', kind: 'direct', name: 'Private', owner: human, members: [human, bob], maxAiMessages: 10,
  })
  const discover = (actor = agent) => h.ctx.tools.execute({
    name: 'im_context', arguments: {}, callId: ToolCallId('discover'), agent: actor, signal: new AbortController().signal,
  })
  const result = await discover()
  expect(result.isError).not.toBe(true)
  await expect(JSON.stringify(result.content, null, 2) + '\n').toMatchFileSnapshot('./expected/im-context.json')
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({
    self: h.ctx.im.participant(alice), page: { kind: 'none' }, unread: [], contacts: [h.ctx.im.participant(bob)],
    conversations: [{ id: room, name: 'Room', kind: 'group', members: [human, other, alice, bob].map(id => h.ctx.im.participant(id)) }],
  }) }])
  expect(JSON.stringify((await discover(peer)).content)).toContain('Private')
  expect(JSON.stringify(result.content)).not.toContain('Private')
  await h.ctx.im.removeContact(human, alice, bob)
  expect((await discover()).content.find(block => block.type === 'text')?.text).toContain('"contacts":[]')
  expect((await h.ctx.tools.execute({
    name: 'talk', arguments: { conversation: hidden, to: bob, message: 'hello' }, callId: ToolCallId('denied'), agent,
    signal: new AbortController().signal,
  })).isError).toBe(true)
  const stranger = await h.ctx.agents.create({
    sessionId: SessionId('unbound'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  cleanups.push(() => stranger.dispose())
  expect((await discover(stranger.agent)).isError).toBe(true)
})

it('logs discovery output before the next model request', async () => {
  const h = await harness()
  await h.ctx.im.addContact(human, alice, bob)
  h.model.responses.push(() => calls(['im_context']))
  const agent = await h.agent()
  await h.send('who am I')
  await waitFor(() => { expect(h.model.requests).toHaveLength(2) })
  await agent.whenIdle()
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(JSON.stringify(results)).toContain('conversations')
  expect(JSON.stringify(h.model.requests[1])).toContain('conversations')
})


it('uses the same durable contact relation for sending and authorization APIs across conversations', async () => {
  const h = await harness()
  const direct = await privateChat(h)
  await h.ctx.im.addContact(human, alice, bob)
  await h.send('contact permits', alice, bob)
  await h.send('reverse contact permits', bob, alice)
  await h.ctx.im.addContact(human, bob, alice)
  await h.send('mutual', bob, alice)
  await expect(h.ctx.im.grantAuthorization(human, {
    id: grant, from: alice, to: bob,
  })).rejects.toThrow('already exists')
  const second = Im.conversationIdSchema.parse('second')
  await h.ctx.im.addConversation({
    id: second, namespace: 'im', kind: 'group', name: 'Second', owner: human, members: [human, alice, bob], maxAiMessages: 10,
  })
  await h.ctx.im.send({
    id: Im.imMessageIdSchema.parse('another room'), conversation: second, sender: alice, recipients: [bob],
    text: 'same contacts', attachments: [], mode: 'queue',
  })
  await h.ctx.im.removeGroupMember(human, second, bob)
  expect(h.ctx.im.contacts(alice).map(contact => contact.id)).toEqual([bob])
  await h.ctx.fiber.dispose()
  const reopened = await harness(h.root)
  expect(reopened.ctx.im.contacts(alice).map(contact => contact.id)).toEqual([bob])
  await reopened.ctx.im.removeContact(human, alice, bob)
  await expect(reopened.send('removed', alice, bob, 'queue', direct)).rejects.toThrow('requires a contact')
  await expect(reopened.send('reverse removed', bob, alice, 'queue', direct)).rejects.toThrow('requires a contact')
  await reopened.ctx.im.removeContact(human, bob, alice)
  expect(reopened.ctx.im.contacts(bob)).toEqual([])
})


it('keeps content unread until im_context opens its page and supports leaving all pages', async () => {
  const h = await harness()
  const agent = await h.agent()
  const send = (id: string, body: string) => h.ctx.im.send({
    id: Im.imMessageIdSchema.parse(id), conversation: room, sender: human, recipients: [alice], text: body, attachments: [], mode: 'queue',
  })
  await send('notice-1', 'private body before opening')
  await waitFor(() => { expect(h.model.requests).toHaveLength(1) })
  await agent.whenIdle()
  expect(JSON.stringify(h.model.requests)).not.toContain('private body before opening')
  expect(h.ctx.im.inbox(alice)).toHaveLength(1)
  const page = (value: Im.AgentPage) => h.ctx.tools.execute({
    name: 'im_context', arguments: { page: value }, callId: ToolCallId('page'), agent, signal: new AbortController().signal,
  })
  expect((await page({ kind: 'group', id: room })).isError).not.toBe(true)
  await waitFor(() => { expect(JSON.stringify(h.model.requests)).toContain('private body before opening') })
  await agent.whenIdle()
  await waitFor(() => { expect(h.ctx.im.inbox(alice)).toEqual([]) })
  expect((await page({ kind: 'none' })).isError).not.toBe(true)
  await send('notice-2', 'private body after leaving')
  await waitFor(() => { expect(h.model.requests).toHaveLength(3) })
  await agent.whenIdle()
  expect(JSON.stringify(h.model.requests)).not.toContain('private body after leaving')
  expect(h.ctx.im.agentPage(alice)).toEqual({ kind: 'none' })
  expect(h.ctx.im.inbox(alice)).toHaveLength(1)
  expect((await page({ kind: 'contact', id: bob })).isError).toBe(true)
  expect((await page({ kind: 'group', id: Im.conversationIdSchema.parse('unknown') })).isError).toBe(true)
})
