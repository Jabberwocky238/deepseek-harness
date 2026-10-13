/** Operations an Agent drives run on a connection authenticated as the login bound to it. */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), directory: vi.fn(), remove: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.exec }))
vi.mock('node:fs/promises', () => ({ mkdtemp: transport.directory, rm: transport.remove }))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  closed = false
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const config: Config = {
  host: 'test-alias', launch: { kind: 'node-script', node: '/remote/node' }, helper: '/remote/helper.js', helperHash: 'a'.repeat(64), workspace: '/remote/workspace',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000, loginIdleMs: 600_000,
}

/** One spawned helper: its ssh arguments, process, and the requests it served. */
interface Spawned { args: string[]; child: Child; calls: string[]; peer: SshRpcPeer }

function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  let initiator: object | undefined
  ctx.provide('agents', { currentInitiator: () => initiator } as never)
  const spawned: Spawned[] = []
  transport.directory.mockImplementation(async () => `/virtual/ssh-${spawned.length}`)
  transport.remove.mockResolvedValue(undefined)
  transport.spawn.mockImplementation((_file: string, args: string[]) => {
    const child = new Child()
    const index = spawned.length
    const calls: string[] = []
    const peer = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method) => {
      calls.push(method)
      if (method === 'hello') return {
        protocol: 2, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
        kind: 'node-script', executable: '/canonical/node', root: `/tmp/remote-${index}`, workspace: '/canonical/workspace',
      }
      if (method === 'which') return index
      if (method === 'process.prepare') return { id: randomUUID(), streams: {} }
      if (method === 'process.wait') return true
      if (method === 'process.terminate' || method === 'heartbeat' || method === 'close') return null
      throw new Error(`unexpected helper request ${method}`)
    })
    spawned.push({ args, child, calls, peer })
    return child
  })
  transport.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    const command = new Child()
    queueMicrotask(() => { callback(null); command.kill() })
    return command
  })
  const service = new SshConnection(ctx, { ...config, ...overrides })
  onTestFinished(async () => {
    try { await service.dispose() }
    finally {
      for (const { peer, child } of spawned) { peer.close(); child.kill() }
      await ctx.fiber.dispose()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  const which = () => service.request('which', {}, z.number())
  return { service, spawned, which, as: (agent: object | undefined) => { initiator = agent } }
}

describe.skipIf(process.platform === 'win32')('SSH login channels', () => {
  it('keeps operations outside a bound Agent on the alias login', async () => {
    const test = setup()
    await test.service.ready
    test.as({})
    expect(await test.which()).toBe(0)
    expect(test.spawned).toHaveLength(1)
    expect(test.spawned[0]?.args.at(-2)).toBe('test-alias')
    expect(test.spawned[0]?.args).not.toContain('-l')
  })

  it('opens one connection per bound login and reuses it', async () => {
    const test = setup()
    await test.service.ready
    const first = {}, second = {}
    test.service.bindLogin(first, 'qingang0001')
    test.service.bindLogin(second, 'qingang0002')
    test.as(first)
    expect(await test.which()).toBe(1)
    expect(await test.which()).toBe(1)
    test.as(second)
    expect(await test.which()).toBe(2)
    test.as(undefined)
    expect(await test.which()).toBe(0)
    expect(test.spawned[0]?.args).not.toContain('-l')
    expect(test.spawned.slice(1).map(({ args }) => args.slice(-4, -1))).toEqual([
      ['-l', 'qingang0001', 'test-alias'],
      ['-l', 'qingang0002', 'test-alias'],
    ])
  })

  it('refuses an invalid login and a second binding, and unbinds through the disposer', async () => {
    const test = setup()
    await test.service.ready
    const agent = {}
    expect(() => test.service.bindLogin(agent, 'Root; rm')).toThrow('not a valid login name')
    const unbind = test.service.bindLogin(agent, 'qingang0001')
    expect(() => test.service.bindLogin(agent, 'qingang0002')).toThrow('already bound')
    test.as(agent)
    expect(await test.which()).toBe(1)
    unbind()
    expect(await test.which()).toBe(0)
  })

  it('keeps a process on the connection that created it, whoever observes it later', async () => {
    const test = setup()
    await test.service.ready
    const agent = {}
    test.service.bindLogin(agent, 'qingang0001')
    test.as(agent)
    const prepared = await test.service.request('process.prepare', {}, z.object({ id: z.string(), streams: z.object({}) }))
    test.as(undefined)
    await test.service.request('process.wait', { id: prepared.id }, z.boolean(), undefined, true)
    await test.service.request('process.terminate', { id: prepared.id }, z.null())
    expect(test.spawned[1]?.calls).toEqual(['hello', 'process.prepare', 'process.wait', 'process.terminate'])
    expect(test.spawned[0]?.calls).toEqual(['hello'])
  })

  it('closes an idle login connection and reopens it on the next operation', async () => {
    const test = setup({ loginIdleMs: 20 })
    await test.service.ready
    const agent = {}
    test.service.bindLogin(agent, 'qingang0001')
    test.as(agent)
    expect(await test.which()).toBe(1)
    await vi.waitFor(() => { expect(test.spawned[1]?.calls).toContain('close') })
    expect(await test.which()).toBe(2)
    expect(test.spawned[2]?.args).toContain('qingang0001')
  })

  it('replaces a login connection whose helper disconnected', async () => {
    const test = setup()
    await test.service.ready
    const agent = {}
    test.service.bindLogin(agent, 'qingang0001')
    test.as(agent)
    expect(await test.which()).toBe(1)
    test.spawned[1]?.child.kill()
    await vi.waitFor(async () => { expect(await test.which()).toBe(2) })
    expect(await test.service.request('which', {}, z.number())).toBe(2)
  })
})
