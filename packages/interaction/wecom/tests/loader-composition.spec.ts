import { once } from 'node:events'
import { mkdtemp, rm, copyFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
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
import * as Im from '@deepseek-ai/dsh-im'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

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
  responses: ((options: GenerateOptions) => AsyncIterable<StreamChunk>)[] = []

  override providerInfo() { return { id: 'mock', name: 'Mock' } }
  override listModels() { return Promise.resolve([]) }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const, context: { contextWindow: 8192 } })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response !== undefined) { yield* response(options); return }
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
  options: {
    missingSecret?: boolean
    rejectReplies?: boolean
    preset?: boolean
    secondBot?: boolean
    missingIm?: boolean
    rejectUpload?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecom-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const configFile = join(root, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configFile)
  if (options.secondBot) await writeFile(configFile, (await readFile(configFile, 'utf8')) + "- id: wecom-two\n  name: '@deepseek-ai/dsh-wecom'\n  config: !!js ctx.wecomSecondTestConfig\n")
  if (overrides.imMaxAiMessages !== undefined && !options.missingIm) {
    const imConfig = await readFile(new URL('../../im/tests/fixtures/cordis.yml', import.meta.url), 'utf8')
    await writeFile(configFile, imConfig + await readFile(configFile, 'utf8'))
  }
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
  let rejectUpload = options.rejectUpload ?? false
  server.on('connection', (client) => {
    socket = client
    client.on('message', (data) => {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')) as Frame
      frames.push(frame)
      if (frame.cmd === 'aibot_subscribe') sockets.set(String(frame.body?.['bot_id']), client)
      const rejected = (frame.cmd === 'aibot_subscribe' && !authenticate) || (frame.cmd === 'aibot_respond_msg' && options.rejectReplies)
        || (frame.cmd === 'aibot_upload_media_finish' && rejectUpload)
      client.send(JSON.stringify({ headers: frame.headers, errcode: rejected ? 1 : 0,
        ...(frame.cmd === 'aibot_upload_media_init' ? { body: { upload_id: 'upload' } } : {}),
        ...(frame.cmd === 'aibot_upload_media_finish' ? { body: { media_id: 'media', type: 'file', created_at: 1 } } : {}),
      }))
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
      if (overrides.imMaxAiMessages !== undefined) {
        await child.plugin(Storage)
        await child.plugin(JsonStorage, { root: join(root, 'data') })
        await child.plugin(StorageDomain, { backend: 'json' })
      }
      await child.plugin(LocalFileSystem, { cwd: root })
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
      if (specifier === '@deepseek-ai/dsh-im') return Im
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
    ctx, model, events, send, replies, updates, waitReplies, server, frames, root,
    setUploadRejection(value: boolean) { rejectUpload = value },
    sendSecond(id: string) { sockets.get('bot-two')!.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: id }, body: { msgid: id, aibotid: 'bot-two', from: { userid: 'alice' }, chattype: 'single', msgtype: 'text', text: { content: `hello ${id}` } } })) },
    sendRaw(value: string) { socket!.send(value) },
    setAuthentication(value: boolean) { authenticate = value },
  }
}

describe('WeCom through Loader and a real WebSocket', () => {
  it('lists configured bots as mutual contacts while keeping other users outside their shared namespace', async () => {
    const h = await harness({
      imMaxAiMessages: 10,
      imBotContacts: [{ botId: 'bot', name: 'Agent One' }, { botId: 'bot-two', name: 'Agent Two' }],
    }, { secondBot: true })
    h.send('contacts-one')
    await h.waitReplies(1)
    const first = h.ctx.agents.list()[0]!
    h.sendSecond('contacts-two')
    await h.waitReplies(2)
    const second = h.ctx.agents.list().find(agent => agent !== first)!
    const discover = async (agent: typeof first) => {
      const result = await h.ctx.tools.execute({ name: 'im_context', arguments: {}, callId: ToolCallId('contacts'), agent, signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      return JSON.parse(result.content.find(block => block.type === 'text')!.text) as {
        self: { id: string; name: string; namespace: string }
        contacts: { id: string; name: string }[]
        conversations: { id: string; members: { id: string }[] }[]
      }
    }
    const one = await discover(first)
    const two = await discover(second)
    await expect(JSON.stringify({ one, two }, null, 2) + '\n').toMatchFileSnapshot('./expected/bot-contacts.json')
    expect(one.contacts).toContainEqual(expect.objectContaining({ id: two.self.id, name: 'Agent Two' }))
    expect(two.contacts).toContainEqual(expect.objectContaining({ id: one.self.id, name: 'Agent One' }))
    expect(one.self.namespace).toBe(two.self.namespace)
    const shared = one.conversations.find(room => room.members.some(member => member.id === two.self.id))!
    expect(two.conversations.some(room => room.id === shared.id)).toBe(true)
    const published = await h.ctx.tools.execute({
      name: 'talk', arguments: { conversation: shared.id, message: 'contact message' },
      callId: ToolCallId('contact-talk'), agent: first, signal: new AbortController().signal,
    })
    expect(published.isError).not.toBe(true)
    await waitFor(() => { expect(h.model.requests).toHaveLength(3) })
    await second.whenIdle()
    expect(JSON.stringify(h.model.requests[2]?.messages)).toContain(one.self.id)
    h.send('contacts-other-user', 'bob')
    await h.waitReplies(3)
    const other = await discover(h.ctx.agents.list().find(agent => agent !== first && agent !== second)!)
    expect(other.self.namespace).not.toBe(one.self.namespace)
    expect(other.contacts.map(contact => contact.id)).not.toContain(two.self.id)
  })

  it('reports missing IM services before admitting input to the model', async () => {
    const h = await harness({ imMaxAiMessages: 10 }, { missingIm: true })
    h.send('missing-im')
    await h.waitReplies(1)
    expect(h.replies()[0]?.body?.stream?.content).toContain('did not complete')
    expect(h.model.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toHaveLength(0)
  })
  it('gives both bots private IM discovery and sends talk messages to the authenticated chat', async () => {
    const h = await harness({ imMaxAiMessages: 10 }, { secondBot: true })
    const call = (name: string, args: object) => async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    h.model.responses.push(call('im_context', {}), call('talk', { message: 'hello from IM' }))
    h.send('im-first')
    await h.waitReplies(1)
    await waitFor(() => { expect(h.frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(1) })
    expect(h.frames.find(frame => frame.cmd === 'aibot_send_msg')?.body).toMatchObject({ chatid: 'alice', markdown: { content: 'hello from IM' } })
    const firstResults = h.events.filter(row => row.event.type === 'tool/result')
    expect(JSON.stringify(firstResults)).toContain('contacts')
    expect(JSON.stringify(firstResults)).toContain('alice')
    expect(JSON.stringify(firstResults)).not.toContain('test-secret')
    h.model.responses.push(call('im_context', {}))
    h.sendSecond('im-second')
    await h.waitReplies(2)
    const discoveries = h.events.filter(row => row.event.type === 'tool/result' && JSON.stringify(row).includes('contacts'))
    expect(discoveries).toHaveLength(2)
    expect(discoveries[0]?.sessionId).not.toBe(discoveries[1]?.sessionId)
    const namespaces = discoveries.map(row => JSON.stringify(row).match(/wecom:[a-f0-9]{64}/)?.[0])
    expect(namespaces.every(value => value !== undefined)).toBe(true)
    expect(new Set(namespaces).size).toBe(2)
    const inputs = h.model.requests.filter(request => JSON.stringify(request.messages).includes('contacts'))
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    const botOne = [...h.ctx.loader.entries()].find(entry => entry.options.id === 'wecom')!
    await botOne.fiber!.dispose()
    h.model.responses.push(call('talk', { message: 'second bot remains connected' }))
    h.sendSecond('im-after-unload')
    await h.waitReplies(3)
    await waitFor(() => { expect(h.frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(2) })
  })

  it('uploads durable files and images to the originating group and acknowledges their delivery', async () => {
    const h = await harness({ imMaxAiMessages: 10 })
    h.send('group-media', 'alice', { chattype: 'group', chatid: 'group-id' })
    await h.waitReplies(1)
    const agent = h.ctx.agents.list()[0]!
    const result = await h.ctx.tools.execute({ name: 'im_context', arguments: {}, callId: ToolCallId('discover'), agent, signal: new AbortController().signal })
    const data = JSON.parse(result.content.find(block => block.type === 'text')!.text) as { self: { id: string }; conversations: { id: string }[]; contacts: { id: string }[] }
    const file = await h.ctx.attachments.saveFile({ data: Buffer.from('published file'), name: 'report.txt' })
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ff' } }).png().toBuffer()
    const image = await h.ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
    const conversation = Im.conversationIdSchema.parse(data.conversations[0]!.id)
    const sender = Im.participantIdSchema.parse(data.self.id)
    const human = Im.participantIdSchema.parse(data.contacts[0]!.id)
    const sent = await h.ctx.im.send({
      id: Im.imMessageIdSchema.parse('outbound-media'), conversation, sender, recipients: [human],
      mode: 'queue', text: '', attachments: [{ type: 'file', attachment: file }, { type: 'image', attachment: image }],
    })
    await waitFor(() => { expect(h.ctx.im.history(conversation, human, 0).find(value => value.id === sent.id)?.deliveries[human]).toBe('accepted') })
    const outbound = h.frames.filter(frame => frame.cmd === 'aibot_send_msg')
    expect(outbound.map(frame => frame.body)).toEqual([
      { chatid: 'group-id', msgtype: 'file', file: { media_id: 'media' } },
      { chatid: 'group-id', msgtype: 'image', image: { media_id: 'media' } },
    ])
    expect(h.frames.filter(frame => frame.cmd === 'aibot_upload_media_chunk')).toHaveLength(2)
    h.send('other-member', 'bob', { chattype: 'group', chatid: 'group-id' })
    await h.waitReplies(2)
    const other = h.ctx.agents.list().find(value => value !== agent)!
    const hidden = await h.ctx.tools.execute({ name: 'im_context', arguments: {}, callId: ToolCallId('other'), agent: other, signal: new AbortController().signal })
    expect(JSON.stringify(hidden.content)).not.toContain(sender)
    expect(JSON.stringify(hidden.content)).not.toContain('alice')
  })

  it.each([false, true])('uploads workspace files through talk with failed delivery=%s and explicit retry', async (rejectUpload) => {
    const h = await harness({ imMaxAiMessages: 10 }, { rejectUpload })
    const bytes = Buffer.alloc(600000, 42)
    await writeFile(join(h.root, 'report.bin'), bytes)
    h.send('upload-tool')
    await h.waitReplies(1)
    const agent = h.ctx.agents.list()[0]!
    const result = await h.ctx.tools.execute({
      name: 'talk', arguments: { message: '', files: [{ path: 'report.bin', kind: 'file' }] },
      callId: ToolCallId('upload'), agent, signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    const sent = JSON.parse(result.content.find(block => block.type === 'text')!.text) as { id: string }
    const context = await h.ctx.tools.execute({ name: 'im_context', arguments: {}, callId: ToolCallId('context'), agent, signal: new AbortController().signal })
    const data = JSON.parse(context.content.find(block => block.type === 'text')!.text) as { conversations: { id: string }[]; contacts: { id: string }[] }
    const conversation = Im.conversationIdSchema.parse(data.conversations[0]!.id)
    const human = Im.participantIdSchema.parse(data.contacts[0]!.id)
    const stored = () => h.ctx.im.history(conversation, human, 0).find(value => value.id === sent.id)!
    await waitFor(() => { expect(stored().deliveries[human]).toBe(rejectUpload ? 'failed' : 'accepted') })
    const init = h.frames.find(frame => frame.cmd === 'aibot_upload_media_init')!
    expect(init.body).toMatchObject({ type: 'file', filename: 'report.bin', total_size: bytes.length, total_chunks: 2 })
    const chunks = h.frames.filter(frame => frame.cmd === 'aibot_upload_media_chunk')
      .sort((a, b) => Number(a.body?.['chunk_index']) - Number(b.body?.['chunk_index']))
    expect(Buffer.concat(chunks.map(frame => Buffer.from(String(frame.body?.['base64_data']), 'base64')))).toEqual(bytes)
    if (rejectUpload) {
      expect(h.frames.filter(frame => frame.cmd === 'aibot_send_msg')).toHaveLength(0)
      h.setUploadRejection(false)
      await h.ctx.im.retry(Im.imMessageIdSchema.parse(sent.id), human)
      await waitFor(() => { expect(stored().deliveries[human]).toBe('accepted') })
    }
    expect(h.frames.filter(frame => frame.cmd === 'aibot_send_msg').map(frame => frame.body)).toEqual([
      { chatid: 'alice', msgtype: 'file', file: { media_id: 'media' } },
    ])
    expect(stored().attachments[0]).toMatchObject({ type: 'file', attachment: { name: 'report.bin', bytes: bytes.length } })
  })

  it('rejects stored file bytes exceeding the IM budget before starting an upload', async () => {
    const h = await harness({ imMaxAiMessages: 10 })
    h.send('oversized-storage')
    await h.waitReplies(1)
    const agent = h.ctx.agents.list()[0]!
    const result = await h.ctx.tools.execute({ name: 'im_context', arguments: {}, callId: ToolCallId('context'), agent, signal: new AbortController().signal })
    const data = JSON.parse(result.content.find(block => block.type === 'text')!.text) as { self: { id: string }; conversations: { id: string }[]; contacts: { id: string }[] }
    const conversation = Im.conversationIdSchema.parse(data.conversations[0]!.id)
    const human = Im.participantIdSchema.parse(data.contacts[0]!.id)
    const file = await h.ctx.attachments.saveFile({ data: Buffer.from('small'), name: 'report.txt' })
    // A storage provider can return bytes that disagree with persisted reference metadata.
    const reader = vi.spyOn(h.ctx.attachments, 'readFileStream').mockImplementation(async function* () {
      yield Buffer.alloc(h.ctx.im.attachmentLimits().maxBytes)
      yield Buffer.from('overflow')
    })
    try {
      const sent = await h.ctx.im.send({
        id: Im.imMessageIdSchema.parse('oversized-storage'), conversation,
        sender: Im.participantIdSchema.parse(data.self.id), recipients: [human], mode: 'queue', text: '',
        attachments: [{ type: 'file', attachment: file }],
      })
      await waitFor(() => { expect(h.ctx.im.history(conversation, human, 0).find(value => value.id === sent.id)?.deliveries[human]).toBe('failed') })
      expect(h.frames.filter(frame => frame.cmd.startsWith('aibot_upload_media') || frame.cmd === 'aibot_send_msg')).toEqual([])
    } finally {
      reader.mockRestore()
    }
  })

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
    [{ imBotContacts: [{ botId: 'bot', name: 'Agent' }] }, 'imBotContacts'],
    [{ imMaxAiMessages: 10, imBotContacts: [{ botId: 'peer', name: 'Agent' }] }, 'imBotContacts'],
    [{ imMaxAiMessages: 10, imBotContacts: [{ botId: 'bot', name: 'One' }, { botId: 'bot', name: 'Two' }] }, 'imBotContacts'],
    [{ imMaxAiMessages: 10, imBotContacts: [{ botId: 'bot', name: ' ' }] }, 'imBotContacts'],
    [{ imMaxAiMessages: 10, imBotContacts: [{ botId: 'bot', name: ' Agent' }] }, 'imBotContacts'],
    [{ botId: ' ' }, 'identifiers'],
    [{ workspacePath: 'relative' }, 'workspacePath'],
    [{ workspacePath: new URL('../package.json', import.meta.url).pathname }, 'workspacePath'],
    [{ permissionPreset: 'missing' }, 'unknown'],
    [{ agentPreset: 'standard' }, 'agent-presets'],
    [{ wsUrl: 'ws://example.com' }, 'wsUrl'],
    [{ wsUrl: 'wss://user:secret@example.com' }, 'wsUrl'],
  ] satisfies [Partial<Wecom.Config>, string][])('rejects invalid deployment configuration %#', async (config, diagnostic) => {
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
