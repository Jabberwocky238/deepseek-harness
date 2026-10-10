import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SshBashExecutor from '../src/index.ts'

const wire = vi.hoisted(() => ({ clients: [] as unknown[] }))
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: { Client: class extends EventEmitter {
    options: unknown
    callback?: (error: Error | undefined, stream?: unknown) => void
    end = vi.fn(() => { this.emit('close') })
    connect(options: unknown) { this.options = options; wire.clients.push(this) }
    exec(_command: string, _options: unknown, callback: (error: Error | undefined, stream?: unknown) => void) { this.callback = callback }
  } } }
})

interface FakeClient extends EventEmitter {
  options: { readyTimeout: number; keepaliveInterval: number; agent: string }
  callback: (error: Error | undefined, stream?: FakeChannel) => void
  end: ReturnType<typeof vi.fn>
}
class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  write = vi.fn()
}
const roots: Context[] = []
afterEach(async () => {
  for (const value of wire.clients) (value as FakeClient).emit('close')
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  wire.clients.length = 0
})
const baseConfig = { host: 'host', username: 'agent', hostKeySha256: 'a'.repeat(64), cwd: '/remote' }
const config = { ...baseConfig, agentSocket: '/agent.sock' }
async function setup() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SshBashExecutor, config)
  return ctx
}
function client(): FakeClient { return wire.clients.at(-1) as FakeClient }
function admit() {
  const connection = client()
  connection.emit('ready')
  const channel = new FakeChannel()
  connection.callback(undefined, channel)
  return { connection, channel }
}
function finish(channel: FakeChannel, code: number | null = 0, signal?: string) {
  channel.emit('exit', code, signal)
  channel.emit('close')
}

describe('SSH lifecycle and invalid deployment inputs', () => {
  it.each([
    { host: '' }, { username: '\0' }, { cwd: 'relative' }, { hostKeySha256: 'bad' },
    { localWorkspaceRoot: 'relative' }, { agentSocket: '' }, { agentSocket: '\0' },
    { privateKeyFile: '/key' }, { agentSocket: undefined }, { port: 0 }, { port: 65536 },
    { port: 1.5 }, { timeoutMs: 0 }, { maxTimeoutMs: -1 }, { maxOutputBytes: 0 },
  ])('rejects invalid configuration %j', async (override) => {
    const ctx = new Context()
    roots.push(ctx)
    const { agentSocket, ...input } = { ...config, ...override }
    await expect(Promise.resolve(ctx.plugin(SshBashExecutor, {
      ...input, ...(agentSocket === undefined ? {} : { agentSocket }),
    }))).rejects.toThrow('bash-ssh:')
  })

  it('validates output budgets at request resolution', async () => {
    const ctx = await setup()
    expect(() => ctx.shell.resolve({ command: 'true', stdoutMaxBytes: 0 })).toThrow('stdoutMaxBytes')
    expect(ctx.shell.resolve({ command: 'true', timeoutMs: 900_000, stdoutMaxBytes: 10 })).toMatchObject({ timeoutMs: 600_000, stdoutMaxBytes: 10 })
  })

  it('does not close the connection when cancellation is ignored', async () => {
    const ctx = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'wait' }))
    const { connection, channel } = admit()
    expect(connection.options).toMatchObject({ readyTimeout: 0, keepaliveInterval: 0, agent: '/agent.sock' })
    expect(proc.kill()).toBe(true)
    expect(channel.write).toHaveBeenCalledExactlyOnceWith('\x03')
    expect(connection.end).not.toHaveBeenCalled()
    channel.emit('data', Buffer.from('still running'))
    expect(proc.readOutput()).toEqual({ delta: 'still running', lossy: false })
    expect(proc.status).toBe('running')
    finish(channel)
    await proc.done
    expect(proc.kill()).toBe(false)
  })

  it('delivers cancellation queued while the PTY request is pending', async () => {
    const ctx = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'wait' }))
    const connection = client()
    connection.emit('ready')
    proc.kill()
    const channel = new FakeChannel()
    connection.callback(undefined, channel)
    expect(channel.write).toHaveBeenCalledWith('\x03')
    finish(channel)
    await proc.done
  })

  it('does not admit a remote command cancelled before authentication', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    const result = ctx.shell.run(ctx.shell.resolve({ command: 'true', signal: controller.signal }))
    controller.abort()
    client().emit('ready')
    expect(await result).toMatchObject({ aborted: true, timedOut: false })
  })

  it('reports remote signal exits and separate transport diagnostics', async () => {
    const ctx = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'wait' }))
    const { channel } = admit()
    channel.emit('data', Buffer.from('out'))
    channel.stderr.emit('data', Buffer.from('diagnostic'))
    expect(proc.readOutput().delta).toBe('out\n[stderr]\ndiagnostic')
    finish(channel, null, 'TERM')
    await proc.done
    expect(proc).toMatchObject({ status: 'killed', signal: 'SIGTERM' })
  })

  it('rejects foreground exec admission errors', async () => {
    const ctx = await setup()
    const result = ctx.shell.run(ctx.shell.resolve({ command: 'true' }))
    client().emit('ready')
    client().callback(new Error('PTY refused'))
    await expect(result).rejects.toThrow('PTY refused')
  })

  it('settles background transport failures and consumes the diagnostic once', async () => {
    const ctx = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'true' }))
    const { channel } = admit()
    channel.emit('error', new Error('channel lost'))
    await proc.done
    expect(proc.readOutput().delta).toContain('channel lost')
    expect(proc.readOutput().delta).toBe('')
    expect(proc.status).toBe('killed')
  })

  it('rejects a connection that closes without an exit status', async () => {
    const ctx = await setup()
    const result = ctx.shell.run(ctx.shell.resolve({ command: 'true' }))
    client().emit('close')
    await expect(result).rejects.toThrow('without a remote exit status')
  })

  it('does not connect when cancellation arrives while reading the private key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-key-'))
    try {
      const key = join(root, 'key')
      await writeFile(key, 'test private key')
      const ctx = new Context()
      roots.push(ctx)
      await ctx.plugin(SshBashExecutor, { ...baseConfig, privateKeyFile: key })
      const controller = new AbortController()
      const result = ctx.shell.run(ctx.shell.resolve({ command: 'true', signal: controller.signal }))
      controller.abort()
      expect(await result).toMatchObject({ aborted: true, timedOut: false })
      expect(wire.clients).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing private-key file before connecting', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SshBashExecutor, { ...baseConfig, privateKeyFile: '/dev/null/missing-key' })
    await expect(ctx.shell.run(ctx.shell.resolve({ command: 'true' }))).rejects.toThrow()
    expect(wire.clients).toHaveLength(0)
  })
})
