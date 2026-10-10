import { afterEach, expect, it } from 'vitest'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import Playground from '../src/index.ts'
import type { Config, PlaygroundContainerId } from '../src/index.ts'
import { dockerServer } from './docker-server.ts'

const id = brandString<PlaygroundContainerId>('a'.repeat(64))
const labels = {
  'ai.deepseek.dsh.playground.namespace': 'test',
  'ai.deepseek.dsh.playground.ssh-port': '2222',
  'ai.deepseek.dsh.playground.username': 'guest',
}
const inspect = (running: boolean, owner = labels) => ({
  Id: id, Name: '/test-container', Config: { Image: 'ssh-only:test', Labels: owner },
  State: { Status: running ? 'running' : 'created', Running: running },
  NetworkSettings: { Ports: { '2222/tcp': running ? [{ HostIp: '127.0.0.1', HostPort: '32123' }] : null } },
})
let server: Awaited<ReturnType<typeof dockerServer>> | undefined
let ctx: Context | undefined
afterEach(async () => {
  server?.disconnect()
  try { await ctx?.fiber.dispose() } finally { await server?.close() }
  ctx = undefined
  server = undefined
})

async function boot(overrides: Partial<Config> = {}) {
  server = await dockerServer()
  ctx = new Context()
  ctx.provide('playgroundTestConfig', {
    socketPath: server.socketPath, namespace: 'test', sshHost: 'localhost', bindAddress: '127.0.0.1',
    requestTimeoutMs: 30_000, stopTimeoutSeconds: 2, ...overrides,
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (name !== '@deepseek-ai/dsh-playground') throw new Error(`unexpected plugin ${name}`)
    return Playground
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  // Loader persists entry state; each test owns its writable composition file.
  const configPath = join(server.root, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configPath)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-playground')?.fiber
  if (fiber === undefined) throw new Error('playground Loader entry did not activate')
  return { service: ctx.playground, server, ctx, fiber }
}

it('creates from the supplied image without injecting a command, runtime, credentials, or host environment', async () => {
  const { service, server } = await boot()
  server.handle((_req, res) => res.writeHead(201).end(JSON.stringify({ Id: id, Warnings: [] })))
  expect(await service.create({ image: 'ssh-only:test', sshPort: 2222, username: 'guest' })).toBe(id)
  expect(server.calls).toHaveLength(1)
  expect(new URL(server.calls[0]!.path, 'http://docker').pathname).toBe('/containers/create')
  expect(server.calls[0]?.method).toBe('POST')
  expect(server.calls[0]?.body).toEqual({
    Image: 'ssh-only:test', Labels: labels, ExposedPorts: { '2222/tcp': {} },
    HostConfig: { PortBindings: { '2222/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
  })
})

it('passes only explicitly supplied image startup inputs', async () => {
  const { service, server } = await boot()
  server.handle((_req, res) => res.writeHead(201).end(JSON.stringify({ Id: id })))
  await service.create({ image: 'custom', sshPort: 2222, username: 'guest', name: 'mine', command: ['sshd', '-D'], env: { PUBLIC_KEY: 'public-key' } })
  expect(new URL(server.calls[0]!.path, 'http://docker').searchParams.get('name')).toBe('mine')
  expect(server.calls[0]?.body).toMatchObject({ Cmd: ['sshd', '-D'], Env: ['PUBLIC_KEY=public-key'] })
})

it('discovers stopped containers and current published SSH addresses through the Loader composition', async () => {
  const { service, server } = await boot()
  let running = false
  server.handle((req, res) => {
    const url = new URL(req.url!, 'http://docker')
    if (url.pathname === '/containers/json') {
      expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ label: ['ai.deepseek.dsh.playground.namespace=test'] })
      expect(url.searchParams.get('all')).toBe('true')
      res.end(JSON.stringify([{ Id: id }]))
    } else if (url.pathname.endsWith('/json')) res.end(JSON.stringify(inspect(running)))
    else if (url.pathname.endsWith('/start')) { running = true; res.writeHead(204).end() }
    else if (url.pathname.endsWith('/stop')) { running = false; expect(url.searchParams.get('t')).toBe('2'); res.writeHead(204).end() }
    else { expect(req.method).toBe('DELETE'); expect(url.searchParams.get('force')).toBe('false'); expect(url.searchParams.get('v')).toBe('false'); res.writeHead(204).end() }
  })
  expect(await service.list()).toEqual([{ id, name: 'test-container', image: 'ssh-only:test', status: 'created', username: 'guest', sshPort: 2222, ssh: null }])
  expect((await service.start(id)).ssh).toEqual({ host: 'localhost', port: 32123, username: 'guest' })
  expect((await service.stop(id)).ssh).toBeNull()
  await service.remove(id)
})

it('refuses every direct operation on another namespace without sending a mutation', async () => {
  const { service, server } = await boot()
  server.handle((_req, res) => res.end(JSON.stringify(inspect(false, { ...labels, 'ai.deepseek.dsh.playground.namespace': 'other' }))))
  for (const operation of [() => service.get(id), () => service.start(id), () => service.stop(id), () => service.remove(id)]) {
    await expect(operation()).rejects.toThrow('another namespace')
  }
  expect(server.calls.every(call => call.method === 'GET')).toBe(true)
})

it('accepts Docker already-started and already-stopped responses', async () => {
  const { service, server } = await boot()
  server.handle((req, res) => {
    if (req.method === 'POST') res.writeHead(304).end()
    else res.end(JSON.stringify(inspect(false)))
  })
  await service.start(id)
  await service.stop(id)
})

it('does not treat a failed Docker start as already-running', async () => {
  const { service, server } = await boot()
  server.handle((req, res) => {
    if (req.method === 'POST') res.writeHead(500).end(JSON.stringify({ message: 'start failed' }))
    else res.end(JSON.stringify(inspect(false)))
  })
  await expect(service.start(id)).rejects.toThrow('start failed')
})

it('propagates Docker failures and refuses malformed metadata and invalid listener ports', async () => {
  const { service, server } = await boot()
  await expect(service.create({ image: 'ssh', sshPort: 70000, username: 'guest' })).rejects.toThrow()
  await expect(service.create({ image: '', sshPort: 22, username: 'guest' })).rejects.toThrow('non-empty')
  expect(server.calls).toHaveLength(0)
  server.handle((_req, res) => res.writeHead(409).end(JSON.stringify({ message: 'container is running' })))
  await expect(service.get(id)).rejects.toThrow('container is running')
  server.handle((_req, res) => res.end(JSON.stringify(inspect(false, { ...labels, 'ai.deepseek.dsh.playground.ssh-port': 'garbage' }))))
  await expect(service.get(id)).rejects.toThrow()
})

it('omits a container removed during listing but propagates other inspect failures', async () => {
  const { service, server } = await boot()
  let status = 404
  server.handle((req, res) => {
    if (req.url!.startsWith('/containers/json')) res.end(JSON.stringify([{ Id: id }]))
    else res.writeHead(status).end(JSON.stringify({ message: 'unavailable' }))
  })
  expect(await service.list()).toEqual([])
  status = 500
  await expect(service.list()).rejects.toThrow('unavailable')
})

it('waits for accepted work on disposal, rejects new work, and retains Docker containers', async () => {
  const { service, server, ctx, fiber } = await boot()
  const received = Promise.withResolvers<() => void>()
  server.handle((_req, res) => { received.resolve(() => { res.end(JSON.stringify(inspect(false))) }) })
  const pending = service.get(id)
  const release = await received.promise
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  try {
    await expect(service.list()).rejects.toThrow('disposing')
    expect(disposed).toBe(false)
  } finally { release() }
  await pending
  await disposal
  expect(ctx.get('playground')).toBeUndefined()
  expect(server.calls.map(call => call.method)).toEqual(['GET'])
})
