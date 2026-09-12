import { once } from 'node:events'
import { mkdtemp, rm, copyFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import Approval from '@deepseek-ai/dsh-user-approval'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { mediaPeer } from './media-peer.ts'
import * as Wecom from '../src/index.ts'

interface Frame {
  cmd: string
  headers: { req_id: string }
  body?: { stream?: { id: string; content: string; finish: boolean }; [key: string]: unknown }
}

class Model extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  block: Promise<void> | undefined
  hang = false
  answer: string | undefined
  afterDelta: Promise<void> | undefined
  failAfterDelta = false
  reasoning = false

  override providerInfo() { return { id: 'mock', name: 'Mock' } }
  override listModels() { return Promise.resolve([]) }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const, context: { contextWindow: 8192 } })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.block
    if (this.hang) {
      if (!options.signal?.aborted) await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      throw new Error('model cancelled')
    }
    const text = this.answer ?? `answer ${String(this.requests.length)}`
    if (this.reasoning) {
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: 'private reasoning' }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'private reasoning' } }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    await this.afterDelta
    if (this.failAfterDelta) throw new Error('model failed after preview')
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const cleanups: (() => Promise<void>)[] = []
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10000 })
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function harness(
  overrides: Partial<Wecom.Config> = {},
  options: { missingSecret?: boolean; rejectReplies?: boolean; preset?: boolean; secondBot?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecom-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const configFile = join(root, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configFile)
  if (options.secondBot) await writeFile(configFile, (await readFile(configFile, 'utf8')) + "- id: wecom-two\n  name: '@deepseek-ai/dsh-wecom'\n  config: !!js ctx.wecomSecondTestConfig\n")
  if (options.preset) {
    await mkdir(join(root, 'presets', 'test'), { recursive: true })
    await writeFile(join(root, 'presets', 'test', 'agent.cordis.yml'), '[]\n')
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('missing listener address')
  const frames: Frame[] = []
  let socket: WebSocket | undefined
  const sockets = new Map<string, WebSocket>()
  let authenticate = true
  server.on('connection', (client) => {
    socket = client
    client.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')) as Frame
      frames.push(frame)
      if (frame.cmd === 'aibot_subscribe') sockets.set(String(frame.body?.['bot_id']), client)
      const rejected = (frame.cmd === 'aibot_subscribe' && !authenticate) || (frame.cmd === 'aibot_respond_msg' && options.rejectReplies)
      client.send(JSON.stringify({ headers: frame.headers, errcode: rejected ? 1 : 0 }))
    })
  })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const model = new Model()
  const events: { sessionId: string; event: SessionEvent }[] = []
  const rawConfig: Wecom.Config = {
    botId: 'bot', secretEnv: 'WECOM_TEST_SECRET', allowedUsers: ['alice', 'bob'], workspacePath: root,
    maxConversations: 100, maxPendingMessages: 32, maxRecentMessages: 1000,
    maxAttachmentBytes: 20971520, maxAttachmentsPerMessage: 20, attachmentTimeoutMs: 30000,
    maxInputBytes: 16384, maxReplyBytes: 20480, replyIntervalMs: 500,
    runTimeoutMs: 120000, reconnectIntervalMs: 1000, maxReconnectAttempts: 10, maxAuthFailureAttempts: 5, heartbeatIntervalMs: 30000,
    permissionPreset: 'read-only', wsUrl: `ws://127.0.0.1:${String(address.port)}`, language: 'en', ...overrides,
  }
  const config = Wecom.Config(rawConfig)
  const dependencies = {
    name: 'test-runtime',
    async apply(child: Context) {
      await mountAgentLoopTestDependencies(child)
      await child.plugin(LocalAttachments, { dshHome: root })
      await child.plugin(AgentLoop, { agents: [] })
      await child.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
      if (options.preset) {
        await child.plugin(AgentPresets, {
          default: 'test', roots: [{ path: join(root, 'presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false,
        })
      }
      await child.plugin(Approval, { policy: 'never' })
      child.provide('shell', {
        sandboxMode: 'read-only',
        resolve() { throw new Error('text fixture has no shell tool') },
        run() { throw new Error('text fixture has no shell tool') },
        start() { throw new Error('text fixture has no shell tool') },
      })
      await child.plugin(PermissionPresets, { presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } }, defaultPreset: 'read-only' })
      // Credential lookup is an external boundary; the Agent and permission services stay real.
      child.provide('credentials', { resolve: async () => options.missingSecret ? undefined : { value: 'test-secret', source: 'test' } } as never)
      child.effect(() => child.get('llm')!.registerAdapter(['mock'], model))
      child.on('session/event', (session, event) => { events.push({ sessionId: session.id, event }) })
    },
  }
  ctx.provide('wecomTestConfig', config)
  ctx.provide('wecomSecondTestConfig', Wecom.Config(Object.assign({}, rawConfig, { botId: 'bot-two' })))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === 'test-runtime') return dependencies
      if (specifier === '@deepseek-ai/dsh-wecom') return Wecom
      throw new Error(`unexpected import ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'test-runtime' })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configFile).href } })
  await ctx.loader.await()
  await waitFor(() => { expect(frames.filter(frame => frame.cmd === 'aibot_subscribe')).toHaveLength(options.secondBot ? 2 : 1) })
  const send = (id: string, user = 'alice', extra: Record<string, unknown> = {}) => {
    sockets.get(config.botId)!.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: id }, body: { msgid: id, aibotid: 'bot', from: { userid: user }, chattype: 'single', msgtype: 'text', text: { content: `hello ${id}` }, ...extra } }))
  }
  const updates = () => frames.filter(frame => frame.cmd === 'aibot_respond_msg')
  const replies = () => updates().filter(frame => frame.body?.stream?.finish === true)
  const waitReplies = async (count: number) => { await waitFor(() => { expect(replies()).toHaveLength(count) }) }
  return {
    ctx, model, events, send, replies, updates, waitReplies, server, frames,
    sendSecond(id: string) { sockets.get('bot-two')!.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: id }, body: { msgid: id, aibotid: 'bot-two', from: { userid: 'alice' }, chattype: 'single', msgtype: 'text', text: { content: `hello ${id}` } } })) },
    sendRaw(value: string) { socket!.send(value) },
    setAuthentication(value: boolean) { authenticate = value },
  }
}

describe('WeCom through Loader and a real WebSocket', () => {

  it('logs durable images and files and passes image content to the model', async () => {
    const h = await harness()
    await using peer = await mediaPeer()
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ff' } }).png().toBuffer()
    const image = peer.add(bytes, { encrypted: true })
    h.send('image', 'alice', { msgtype: 'mixed', mixed: { msg_item: [
      { msgtype: 'text', text: { content: 'describe this image' } }, { msgtype: 'image', image },
    ] } })
    await h.waitReplies(1)
    expect(h.model.requests[0]?.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(true)
    const file = peer.add(Buffer.from('report contents'), { encrypted: true, disposition: 'attachment; filename="report.txt"' })
    h.send('file', 'alice', { msgtype: 'file', file })
    await h.waitReplies(2)
    const messages = h.events.filter(row => row.event.type === 'user/message')
    expect(JSON.stringify(messages)).toContain('report.txt')
    expect(JSON.stringify(messages)).not.toContain(image.url)
    expect(JSON.stringify(messages)).not.toContain(image.aeskey)
    expect(h.model.requests).toHaveLength(2)
  })

  it('reports attachment admission failures without starting a model request', async () => {
    const h = await harness({ maxAttachmentBytes: 1, maxAttachmentsPerMessage: 1 })
    await using peer = await mediaPeer()
    const file = peer.add(Buffer.from('too large'))
    h.send('file', 'alice', { msgtype: 'file', file })
    await h.waitReplies(1)
    h.send('too-many', 'alice', { msgtype: 'mixed', mixed: { msg_item: [
      { msgtype: 'image', image: file }, { msgtype: 'image', image: file },
    ] } })
    await h.waitReplies(2)
    expect(h.replies().every(frame => frame.body?.stream?.content.includes('attachment'))).toBe(true)
    expect(h.model.requests).toHaveLength(0)
    expect(peer.requests).toBe(1)
  })

  it('ends a stalled attachment download at its configured deadline', async () => {
    const h = await harness({ attachmentTimeoutMs: 20 })
    await using peer = await mediaPeer()
    h.send('file', 'alice', { msgtype: 'file', file: peer.add(Buffer.alloc(0), { hang: true }) })
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('attachment')
    expect(h.model.requests).toHaveLength(0)
  })

  it('cancels downloads and closes the socket when the owning bot unloads', async () => {
    const h = await harness()
    await using peer = await mediaPeer()
    h.send('file', 'alice', { msgtype: 'file', file: peer.add(Buffer.alloc(0), { hang: true }) })
    await waitFor(() => { expect(peer.requests).toBe(1) })
    await [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')!.fiber!.dispose()
    await waitFor(() => { expect(h.server.clients.size).toBe(0) })
    expect(h.model.requests).toHaveLength(0)
    expect(h.replies()).toHaveLength(0)
  })


  it('publishes text before completion and ends the same stream with committed text', async () => {
    const h = await harness({ replyIntervalMs: 1 })
    const release = Promise.withResolvers<undefined>()
    h.model.afterDelta = release.promise
    h.model.reasoning = true
    cleanups.push(async () => { release.resolve(undefined) })
    h.send('stream')
    await waitFor(() => { expect(h.updates().some(frame => frame.body?.stream?.content === 'answer 1')).toBe(true) })
    expect(h.replies()).toHaveLength(0)
    expect(h.events.some(row => row.event.type === 'assistant/message')).toBe(false)
    expect(h.updates()[0]?.body?.stream).toMatchObject({ content: 'Working…', finish: false })
    release.resolve(undefined)
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream).toMatchObject({ content: 'answer 1', finish: true })
    expect(new Set(h.updates().map(frame => frame.body?.stream?.id)).size).toBe(1)
    expect(JSON.stringify(h.updates())).not.toContain('private reasoning')
  })


  it('replaces a failed attempt preview with a final failure on the same stream', async () => {
    const h = await harness({ replyIntervalMs: 1 })
    const release = Promise.withResolvers<undefined>()
    h.model.afterDelta = release.promise
    h.model.failAfterDelta = true
    cleanups.push(async () => { release.resolve(undefined) })
    h.send('failed-stream')
    await waitFor(() => { expect(h.updates().some(frame => frame.body?.stream?.content === 'answer 1')).toBe(true) })
    release.resolve(undefined)
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('did not complete')
    expect(new Set(h.updates().map(frame => frame.body?.stream?.id)).size).toBe(1)
  })

  it('keeps two bots connected and isolates their histories and duplicate ids', async () => {
    const h = await harness({}, { secondBot: true })
    expect(h.server.clients.size).toBe(2)
    h.send('same')
    h.sendSecond('same')
    await h.waitReplies(2)
    expect(h.model.requests).toHaveLength(2)
    expect(new Set(h.events.filter(row => row.event.type === 'user/message').map(row => row.sessionId)).size).toBe(2)
    await [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')!.fiber!.dispose()
    await waitFor(() => { expect(h.server.clients.size).toBe(1) })
    h.sendSecond('followup')
    await h.waitReplies(3)
    expect(h.model.requests[2]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]))
  })

  it.each([['alice', 'bob'], ['*']])('reuses history, isolates users and group members, and deduplicates with allowlist %j', async (...allowedUsers) => {
    const h = await harness({ allowedUsers })
    h.send('wrong', 'alice', { aibotid: 'other' })
    h.send('one')
    await h.waitReplies(1)
    h.send('one')
    h.send('two')
    await h.waitReplies(2)
    expect(h.model.requests).toHaveLength(2)
    expect(h.model.requests[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]))
    h.send('three', 'bob')
    h.send('four', 'alice', { chattype: 'group', chatid: 'team' })
    h.send('five', 'bob', { chattype: 'group', chatid: 'team' })
    await h.waitReplies(5)
    expect(new Set(h.events.filter(row => row.event.type === 'user/message').map(row => row.sessionId)).size).toBe(4)
    expect(h.replies()[0]).toMatchObject({ headers: { req_id: 'one' }, body: { stream: { content: 'answer 1', finish: true } } })
    expect(h.events.some(row => row.event.type === 'permission/preset')).toBe(true)
  })

  it('serializes pending work and drops duplicate in-flight callbacks', async () => {
    const h = await harness()
    const barrier = Promise.withResolvers<undefined>()
    h.model.block = barrier.promise
    cleanups.push(async () => { barrier.resolve(undefined) })
    h.send('one')
    await waitFor(() => { expect(h.model.requests).toHaveLength(1) })
    h.send('one')
    h.send('two')
    barrier.resolve(undefined)
    await h.waitReplies(2)
    expect(h.replies().map(frame => frame.headers.req_id)).toEqual(['one', 'two'])
    expect(h.model.requests).toHaveLength(2)
  })

  it('rejects unknown users, wrong bots and oversized messages before model admission', async () => {
    const h = await harness({ maxInputBytes: 12 })
    h.send('ignored', 'mallory')
    h.send('wrong', 'alice', { aibotid: 'other' })
    h.send('large', 'alice', { text: { content: 'x'.repeat(13) } })
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('too long')
    expect(h.model.requests).toHaveLength(0)
  })

  it('bounds retained conversations and allows follow-ups on existing ones', async () => {
    const h = await harness({ maxConversations: 1 })
    h.send('one')
    await h.waitReplies(1)
    h.send('two', 'bob')
    await h.waitReplies(2)
    expect(h.replies()[1]?.body?.stream?.content).toContain('busy')
    h.send('three')
    await h.waitReplies(3)
    expect(h.model.requests).toHaveLength(2)
  })

  it('cancels a timed out model and reports failure without partial output', async () => {
    const h = await harness({ runTimeoutMs: 30 })
    h.model.hang = true
    h.send('timeout')
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('timed out')
    expect(h.model.requests[0]?.signal?.aborted).toBe(true)
  })

  it('unloads while the model is active, drains it and closes the connection', async () => {
    const h = await harness()
    h.model.hang = true
    h.send('dispose')
    await waitFor(() => { expect(h.model.requests).toHaveLength(1) })
    const entry = [...h.ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-wecom')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    await waitFor(() => { expect(h.server.clients.size).toBe(0) })
    expect(h.model.requests[0]?.signal?.aborted).toBe(true)
    expect(h.replies()).toHaveLength(0)
  })

  it.each([
    [{ botId: ' ' }, 'identifiers'],
    [{ workspacePath: 'relative' }, 'workspacePath'],
    [{ workspacePath: new URL('../package.json', import.meta.url).pathname }, 'workspacePath'],
    [{ permissionPreset: 'missing' }, 'unknown'],
    [{ agentPreset: 'standard' }, 'agent-presets'],
    [{ wsUrl: 'ws://example.com' }, 'wsUrl'],
    [{ wsUrl: 'wss://user:secret@example.com' }, 'wsUrl'],
  ] as const)('rejects invalid deployment configuration %#', async (config, diagnostic) => {
    await expect(harness(config)).rejects.toThrow(new RegExp(diagnostic, 'i'))
  })

  it('fails before connecting when the bot secret is absent', async () => {
    await expect(harness({}, { missingSecret: true })).rejects.toThrow('WECOM_TEST_SECRET is not configured')
  })

  it('returns a status for an empty completed response', async () => {
    const h = await harness()
    h.model.answer = ''
    h.send('empty')
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('no text reply')
  })

  it('does not rerun a completed task when WeCom rejects its reply', async () => {
    const h = await harness({}, { rejectReplies: true })
    h.send('one')
    await h.waitReplies(1)
    h.send('one')
    h.send('two')
    await h.waitReplies(2)
    expect(h.model.requests).toHaveLength(2)
  })

  it('evicts completed ids at the configured deduplication bound', async () => {
    const h = await harness({ maxRecentMessages: 1 })
    h.send('one')
    await h.waitReplies(1)
    h.send('two')
    await h.waitReplies(2)
    h.send('one')
    await h.waitReplies(3)
    expect(h.model.requests).toHaveLength(3)
  })

  it('drops excess work during saturation without starting additional Agents', async () => {
    const h = await harness({ maxPendingMessages: 1 })
    const barrier = Promise.withResolvers<undefined>()
    h.model.block = barrier.promise
    cleanups.push(async () => { barrier.resolve(undefined) })
    h.send('one')
    await waitFor(() => { expect(h.model.requests).toHaveLength(1) })
    h.send('two', 'bob')
    h.send('large', 'alice', { text: { content: 'x'.repeat(20000) } })
    h.send('many', 'alice', { msgtype: 'mixed', mixed: {
      msg_item: Array.from({ length: 21 }, () => ({ msgtype: 'image', image: { url: 'http://127.0.0.1/not-fetched' } })),
    } })
    h.sendRaw('{invalid')
    h.sendRaw(JSON.stringify({ cmd: 'aibot_msg_callback', headers: {}, body: { msgtype: 'text' } }))
    barrier.resolve(undefined)
    await h.waitReplies(1)
    expect(h.model.requests).toHaveLength(1)
  })

  it('disposes a newly created Agent if permission setup fails', async () => {
    const h = await harness()
    const permissions = h.ctx.get('permissionPresets')!
    const set = vi.spyOn(permissions, 'set').mockImplementationOnce(() => { throw new Error('permission unavailable') })
    try {
      h.send('one')
      await h.waitReplies(1)
      expect(h.replies()[0]?.body?.stream?.content).toContain('did not complete')
      expect(h.model.requests).toHaveLength(0)
      h.send('two')
      await h.waitReplies(2)
      expect(h.model.requests).toHaveLength(1)
    } finally {
      set.mockRestore()
    }
  })

  it('reports exhausted authentication retries without admitting a task', async () => {
    const h = await harness({ maxAuthFailureAttempts: 1, reconnectIntervalMs: 1 })
    h.setAuthentication(false)
    for (const socket of h.server.clients) socket.terminate()
    await waitFor(() => { expect(h.frames.filter(frame => frame.cmd === 'aibot_subscribe').length).toBeGreaterThanOrEqual(2) })
    await waitFor(() => { expect(h.server.clients.size).toBe(0) })
    expect(h.model.requests).toHaveLength(0)
  })

  it('mounts the configured Agent preset before model input', async () => {
    const h = await harness({ agentPreset: 'test' }, { preset: true })
    h.send('preset')
    await h.waitReplies(1)
    expect(h.model.requests).toHaveLength(1)
  })

  it('discards queued work when its owner unloads', async () => {
    const h = await harness()
    h.model.hang = true
    h.send('one')
    h.send('two')
    await waitFor(() => { expect(h.model.requests).toHaveLength(1) })
    await [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')?.fiber?.dispose()
    expect(h.model.requests).toHaveLength(1)
    expect(h.replies()).toHaveLength(0)
  })

  it('does not admit input after unloading during the initial idle wait', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    const stop = h.ctx.on('agent/created', ({ agent }) => {
      vi.spyOn(agent, 'whenIdle').mockImplementationOnce(() => {
        entered.resolve(undefined)
        return release.promise.then(() => {})
      })
    })
    try {
      h.send('one')
      await entered.promise
      const disposing = [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')!.fiber!.dispose()
      await waitFor(() => { expect(h.server.clients.size).toBe(0) })
      release.resolve(undefined)
      await disposing
      expect(h.model.requests).toHaveLength(0)
      expect(h.replies()).toHaveLength(0)
    } finally {
      stop()
    }
  })

  it('closes transport even when an Agent reports a teardown failure', async () => {
    const h = await harness()
    h.send('one')
    await h.waitReplies(1)
    const agent = h.ctx.get('agents')!.get(SessionId(h.events[0]!.sessionId))!
    const idle = vi.spyOn(agent, 'whenIdle').mockRejectedValueOnce(new Error('teardown failure'))
    try {
      await [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')!.fiber!.dispose()
      await waitFor(() => { expect(h.server.clients.size).toBe(0) })
      expect(h.ctx.get('agents')!.get(agent.id)).toBeUndefined()
    } finally {
      idle.mockRestore()
    }
  })
})
