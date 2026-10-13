/** OpenSSH connection owner for version-matched POSIX helpers, one per login, and their independent forwarded streams. */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'

type Hello = z.infer<typeof helloSchema>

/** Installed helper invocation; script deployments may also install a PTC bootstrap. */
export type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
  /** Idle time after which a connection opened for a bound login closes; it reopens on the next request. */
  loginIdleMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

/** Remote login names a bound Agent may run as. */
const LOGIN = /^[a-z_][a-z0-9_-]{0,31}$/

/** Requests that address a handle an earlier request on the same helper created. */
const HANDLE_METHODS = new Set([
  'process.start', 'process.done', 'process.wait', 'process.terminate',
  'terminal.resize', 'terminal.write', 'terminal.inspect', 'terminal.activity', 'terminal.signal',
  'fs.next', 'fs.streamClose',
])

/**
 * One non-reconnecting OpenSSH master and the helper behind it, as the alias's
 * own login or as a named login on the same alias.
 */
class SshChannel {
  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  /** Requests and forwarded sockets in flight, which keep an idle login channel open. */
  active = 0
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private nextSocket = 0
  /** The helper's verified hello, once startup completes. */
  remote: Hello | undefined

  /**
   * @param config - validated connection configuration.
   * @param login - remote login to authenticate as instead of the alias's own; undefined keeps the alias's.
   * @param onFailure - observer of the channel's first failure.
   */
  constructor(
    private readonly config: Required<Config>,
    private readonly login: string | undefined,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.ready = this.start()
    // Startup uses Node I/O, local validation, and Error-valued RPC failures.
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
  }

  /** Whether the channel failed or is closing, so it accepts no new work. */
  get unusable(): boolean { return this.closed || this.failure !== undefined }

  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    this.assertOpen()
    this.active++
    try {
      await this.ready
      this.assertOpen()
      const bounded = wait ? signal : signal === undefined
        ? AbortSignal.timeout(this.config.requestTimeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
      return await (this.rpc as SshRpcPeer).request(method, params, result, bounded)
    } finally { this.active-- }
  }

  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return this.track(this.establishStream(endpoint, signal))
  }

  private async establishStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal.throwIfAborted()
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    const cancelForward = async (): Promise<void> => {
      // An unavailable master already removed its forwarding listeners.
      if (!this.closed) await this.controlCommand(['-O', 'cancel', '-L', forward]).catch(() => {})
      await rm(local, { force: true })
    }
    try {
      await this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward], signal)
    } catch (error) { await cancelForward(); throw error }
    signal.throwIfAborted()
    const socket = createConnection({ path: local, allowHalfOpen: true })
    this.sockets.add(socket)
    this.active++
    socket.once('close', () => {
      this.sockets.delete(socket)
      this.active--
      void this.track(cancelForward()).catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', aborted)
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('SSH connection closed before stream establishment')) }
      const aborted = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
      signal.addEventListener('abort', aborted, { once: true })
    })
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, signal)
    this.sockets.add(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    authenticated.once('close', () => { this.sockets.delete(authenticated) })
    return authenticated
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      // TLS wrappers release their reads before their underlying sockets close.
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await Promise.all(socketClosures)
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    }
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  /** The destination arguments that name the remote login and alias. */
  private destination(): string[] { return this.login === undefined ? [this.config.host] : ['-l', this.login, this.config.host] }

  private assertOpen(): void {
    if (this.closed) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private async controlCommand(args: string[], signal?: AbortSignal): Promise<void> {
    const signals = [this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const result = Promise.withResolvers<undefined>()
    const command = execFile('ssh', ['-S', this.controlPath(), ...args, ...this.destination()], {
      signal: combined, maxBuffer: 64 * 1024,
    }, (error) => { if (error === null) result.resolve(undefined); else result.reject(error) })
    const closed = new Promise<void>((resolve) => { command.once('close', () => { resolve() }) })
    let force: NodeJS.Timeout | undefined
    const escalate = (): void => {
      force = setTimeout(() => { command.kill('SIGKILL') }, this.config.requestTimeoutMs)
      force.unref()
    }
    combined.addEventListener('abort', escalate, { once: true })
    try { await result.promise }
    finally {
      await closed
      combined.removeEventListener('abort', escalate)
      if (force !== undefined) clearTimeout(force)
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    this.child?.kill('SIGTERM')
    this.onFailure(error)
  }

  private async start(): Promise<Hello> {
    this.directory = await mkdtemp('/tmp/dsh-ssh-')
    if (this.closed) throw new Error('SSH connection closed before startup')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const launch = this.config.launch
    let command: string
    let bootstrapPath: string | undefined
    let bootstrapHash: string | undefined
    switch (launch.kind) {
      case 'node-script':
        command = [launch.node, '--disable-sigusr1', this.config.helper].map(quote).join(' ')
        bootstrapPath = launch.bootstrapPath
        bootstrapHash = launch.bootstrapHash
        break
      case 'executable':
        command = `NODE_OPTIONS='--disable-sigusr1' ${quote(this.config.helper)}`
        break
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
    const child = spawn('ssh', [
      '-T', '-M', '-S', this.controlPath(), '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', ...this.destination(), command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      ...(bootstrapPath === undefined ? {} : { bootstrapPath }),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.kind !== launch.kind) throw new Error('SSH helper runtime differs from the configured launch kind')
    if (hello.bootstrapHash !== bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    let heartbeatPending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { heartbeatPending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

/**
 * The deployment's SSH service. Every operation runs on the alias's own login
 * unless the Agent driving it was bound to another login with
 * {@link SshConnection.bindLogin}; that Agent's operations then run on a
 * connection authenticated as the bound login, opened on first use and closed
 * after `loginIdleMs` without work. A process, terminal or text stream stays on
 * the connection that created it, whoever later observes or cancels it.
 */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), helper: schema.string().required(),
    launch: schema.union([
      schema.object({ kind: schema.const('node-script').required(), node: schema.string().required(), bootstrapPath: schema.string(), bootstrapHash: schema.string() }),
      schema.object({ kind: schema.const('executable').required() }),
    ]).required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    requestTimeoutMs: schema.number().default(30_000), maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128), leaseMs: schema.number().default(30_000),
    loginIdleMs: schema.number().default(600_000),
  })

  /** Verified remote helper coordinates of the alias's own login; callers must await this before launch. */
  readonly ready: Promise<Hello>
  private readonly config: Required<Config>
  private readonly primary: SshChannel
  /** Login each bound Agent runs as. */
  private readonly bindings = new WeakMap<object, string>()
  private readonly logins = new Map<string, SshChannel>()
  private readonly idle = new Map<SshChannel, NodeJS.Timeout>()
  /** Helper-issued handle ids and the channel whose helper issued them. */
  private readonly handles = new Map<string, SshChannel>()
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      launch: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node-script'), node: z.string().startsWith('/'),
          bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired'),
        z.object({ kind: z.literal('executable') }).strict(),
      ]),
      helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive().max(2_147_483_647),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024), maxPending: z.number().int().positive().max(128),
      leaseMs: z.number().int().min(3000).max(600_000),
      loginIdleMs: z.number().int().positive().max(2_147_483_647),
    }).strict().parse(config) as Required<Config>
    this.primary = new SshChannel(this.config, undefined, () => {})
    this.ready = this.primary.ready
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Verified remote PTC launch configuration; script deployments require a verified bootstrap. */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string } {
    const remote = this.primary.remote
    if (remote === undefined) throw new Error('SSH helper is not ready')
    const launch = this.config.launch
    switch (launch.kind) {
      case 'executable': return { kind: 'embedded', executable: remote.executable }
      case 'node-script':
        if (launch.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
        return { kind: 'node-script', executable: remote.executable, bootstrapPath: launch.bootstrapPath }
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
  }

  /**
   * Run every operation an Agent drives as `login` instead of the alias's own
   * login. The remote host must accept the alias's key for that login. An
   * Agent's operations are those made while it is the current initiator
   * (`ctx.agents.currentInitiator()`); operations outside any initiator, or
   * inside `ctx.agents.withoutInitiator()`, keep the alias's own login.
   * @param agent - the Agent to bind; a child Agent it creates is not bound.
   * @param login - remote login name.
   * @returns a disposer that removes the binding; register it as an effect of the Agent's context.
   * @throws when `login` is not a valid login name or the Agent is already bound.
   */
  bindLogin(agent: object, login: string): () => void {
    if (!LOGIN.test(login)) throw new Error(`SSH login ${JSON.stringify(login)} is not a valid login name`)
    if (this.bindings.has(agent)) throw new Error('SSH login is already bound for this Agent')
    this.bindings.set(agent, login)
    return () => { this.bindings.delete(agent) }
  }

  /**
   * Send a helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    const handle = HANDLE_METHODS.has(method) ? handleOf(params) : undefined
    const channel = (handle === undefined ? undefined : this.handles.get(handle)) ?? this.channelForInitiator()
    const value = await channel.request(method, params, result, signal, wait)
    if (channel !== this.primary) {
      if (method === 'process.prepare') this.handles.set(handleOf(value) as string, channel)
      else if (method === 'fs.stream' && typeof value === 'string') this.handles.set(value, channel)
    }
    if (handle !== undefined && (method === 'process.terminate' || method === 'fs.streamClose' || (method === 'fs.next' && isDone(value)))) {
      this.handles.delete(handle)
    }
    if (channel !== this.primary) this.scheduleIdle(channel)
    return value
  }

  /**
   * Forward one authenticated stream through an independent SSH channel.
   * @param endpoint - private coordinates issued by one of this service's helpers.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const channel = [...this.logins.values()].find((candidate) => {
      const root = candidate.remote?.root
      return root !== undefined && endpoint.path.startsWith(`${root}/`)
    }) ?? this.primary
    const socket = await channel.connectStream(endpoint, signal)
    if (channel !== this.primary) socket.once('close', () => { this.scheduleIdle(channel) })
    return socket
  }

  /** Tear down every helper's remote managed ranges before releasing their SSH masters when reachable. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    for (const timer of this.idle.values()) clearTimeout(timer)
    this.idle.clear()
    // Every channel stops admitting work before this call returns.
    const logins = [...this.logins.values()].map(channel => channel.dispose())
    const primary = this.primary.dispose()
    this.logins.clear()
    this.handles.clear()
    this.disposal = Promise.allSettled(logins).then(() => primary)
    return this.disposal
  }

  /** The channel for the Agent driving the current operation. */
  private channelForInitiator(): SshChannel {
    if (this.closed) return this.primary
    const agent = this.ctx.get('agents')?.currentInitiator()
    const login = agent === undefined ? undefined : this.bindings.get(agent)
    if (login === undefined) return this.primary
    let channel = this.logins.get(login)
    if (channel === undefined || channel.unusable) {
      // A failed login channel is replaced; its handles fail with it.
      const opened: SshChannel = new SshChannel(this.config, login, () => {
        if (this.logins.get(login) === opened) this.logins.delete(login)
        for (const [id, owner] of this.handles) if (owner === opened) this.handles.delete(id)
      })
      channel = opened
      this.logins.set(login, channel)
    }
    const timer = this.idle.get(channel)
    if (timer !== undefined) { clearTimeout(timer); this.idle.delete(channel) }
    return channel
  }

  /** Close a login channel once it holds no work and no handles for `loginIdleMs`. */
  private scheduleIdle(channel: SshChannel): void {
    if (this.closed || channel.active > 0 || [...this.handles.values()].includes(channel)) return
    const previous = this.idle.get(channel)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.idle.delete(channel)
      if (channel.active > 0 || [...this.handles.values()].includes(channel)) return
      for (const [login, owner] of this.logins) if (owner === channel) this.logins.delete(login)
      void channel.dispose().catch(() => {})
    }, this.config.loginIdleMs)
    timer.unref()
    this.idle.set(channel, timer)
  }
}

/** The handle id a request addresses or a prepare result carries. */
function handleOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined
  return typeof value.id === 'string' ? value.id : undefined
}

/** Whether an `fs.next` result reports the end of its stream. */
function isDone(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'done' in value && value.done === true
}

export default SshConnection
