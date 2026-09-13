/** SSH PTY Bash provider; execution deadlines and interruption belong to remote Bash. @module */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { isAbsolute, posix } from 'node:path'
import ssh2 from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import { remoteCommand, remoteWorkdir } from './command.ts'
import { TailOutput } from './output.ts'

/** Fixed SSH identity, remote workspace, and remote execution limits. */
export interface Config {
  /** SSH server hostname or address. */
  host: string
  /** SSH login user. */
  username: string
  /** Pinned server public-key SHA-256 fingerprint: 64 lowercase hexadecimal characters. */
  hostKeySha256: string
  /** Absolute POSIX working directory on the remote host. */
  cwd: string
  /** Private key file on the host running dsh; use this or agentSocket. */
  privateKeyFile?: string
  /** Explicit SSH authentication-agent socket; use this or privateKeyFile. */
  agentSocket?: string
  /** Local workspace prefix mapped onto cwd; omit when absolute paths match. */
  localWorkspaceRoot?: string
  /** SSH server port (default 22). */
  port?: number
  /** Foreground timeout in milliseconds, enforced by remote GNU timeout with SIGINT. */
  timeoutMs?: number
  /** Maximum foreground timeout in milliseconds. */
  maxTimeoutMs?: number
  /** Per-stream retained output bytes; remote stdout/stderr share one PTY stream. */
  maxOutputBytes?: number
}

type ResolvedConfig = Config & Required<Pick<Config, 'port' | 'timeoutMs' | 'maxTimeoutMs' | 'maxOutputBytes'>>

function validate(config: ResolvedConfig): void {
  for (const key of ['host', 'username', 'cwd'] as const) {
    if (!config[key].trim() || config[key].includes('\0')) throw new Error(`bash-ssh: ${key} must be non-empty and contain no NUL`)
  }
  if (!/^[a-f0-9]{64}$/.test(config.hostKeySha256)) throw new Error('bash-ssh: hostKeySha256 must contain 64 lowercase hexadecimal characters')
  if (!posix.isAbsolute(config.cwd)) throw new Error('bash-ssh: cwd must be an absolute remote POSIX path')
  if (config.localWorkspaceRoot !== undefined && !isAbsolute(config.localWorkspaceRoot)) throw new Error('bash-ssh: localWorkspaceRoot must be absolute')
  if ((config.privateKeyFile === undefined) === (config.agentSocket === undefined)) throw new Error('bash-ssh: configure exactly one of privateKeyFile and agentSocket')
  for (const key of ['privateKeyFile', 'agentSocket'] as const) {
    const value = config[key]
    if (value !== undefined && (!value.trim() || value.includes('\0'))) throw new Error(`bash-ssh: ${key} must be a non-empty path without NUL`)
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('bash-ssh: port must be between 1 and 65535')
  for (const key of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`bash-ssh: ${key} must be a positive integer`)
  }
}

/**
 * Runs fresh Bash commands through SSH PTYs. Timeout sends SIGINT inside the remote
 * shell; cancellation writes Ctrl-C. Ignored interrupts leave calls and disposal waiting.
 */
export class SshBashExecutor extends ShellExecutor {
  static Config: z<Config> = z.object({
    host: z.string().required(), username: z.string().required(), hostKeySha256: z.string().required(),
    cwd: z.string().required(), privateKeyFile: z.string(), agentSocket: z.string(), localWorkspaceRoot: z.string(),
    port: z.number().default(22), timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000), maxOutputBytes: z.number().default(64_000),
  })

  private readonly config: ResolvedConfig
  private readonly active = new Set<ShellProcess>()
  private readonly lifecycle = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    validate(this.config)
    ctx.effect(() => async () => {
      this.lifecycle.abort()
      await Promise.all([...this.active].map(proc => proc.done))
    }, 'bash-ssh Ctrl-C and settlement')
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes <= 0) throw new Error('bash-ssh: stdoutMaxBytes must be a positive integer')
    return {
      ...request,
      workdir: remoteWorkdir(request.workdir, this.config.cwd, this.config.localWorkspaceRoot),
      timeoutMs: clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'bash-ssh: timeoutMs'),
      stdoutMaxBytes,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const operation = this.launch(spec, true)
    await operation.proc.done
    if (operation.failure() !== undefined) throw operation.failure()
    const aborted = operation.cancelled()
    return {
      exitCode: operation.proc.exitCode, signal: operation.proc.signal,
      timedOut: !aborted && operation.proc.exitCode === 124,
      aborted, timeoutMs: spec.timeoutMs,
      stdout: operation.stdout.final(), stderr: operation.stderr.final(),
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.launch(spec, false).proc
  }

  private launch(spec: ShellExecSpec, foreground: boolean) {
    const signal = AbortSignal.any([this.lifecycle.signal, ...spec.signal === undefined ? [] : [spec.signal]])
    signal.throwIfAborted()
    const command = remoteCommand(spec, foreground)
    const connection = new ssh2.Client()
    const stdout = new TailOutput(foreground ? spec.stdoutMaxBytes : this.config.maxOutputBytes)
    const stderr = new TailOutput(this.config.maxOutputBytes)
    const settled = Promise.withResolvers<void>()
    let channel: ClientChannel | undefined
    let cancelled = false
    let failure: unknown
    let stdoutOffset = 0
    let stderrOffset = 0
    const interrupt = (): boolean => {
      if (proc.status !== 'running' || cancelled) return false
      cancelled = true
      // No timer or transport-close fallback: an unresponsive remote command remains pending.
      if (channel !== undefined) channel.write('\x03')
      return true
    }
    const abort = () => { interrupt() }
    const proc: ShellProcess = {
      status: 'running', exitCode: null, signal: null,
      done: settled.promise.finally(() => {
        signal.removeEventListener('abort', abort)
        this.active.delete(proc)
      }),
      kill: interrupt,
      readOutput: () => {
        const out = stdout.read(stdoutOffset)
        const err = stderr.read(stderrOffset)
        stdoutOffset = out.offset
        stderrOffset = err.offset
        return {
          delta: out.text + (err.text ? `${out.text && !out.text.endsWith('\n') ? '\n' : ''}[stderr]\n${err.text}` : ''),
          lossy: out.lossy || err.lossy,
        }
      },
    }
    const fail = (error: Error): void => {
      failure ??= error
      stderr.push(Buffer.from(`SSH transport failed: ${error.message}\n`))
      connection.end()
    }
    connection.on('error', fail)
    connection.on('close', () => {
      stdout.seal()
      stderr.seal()
      if (!cancelled && proc.exitCode === null && proc.signal === null && failure === undefined) {
        failure = new Error('SSH connection closed without a remote exit status')
        stderr.push(Buffer.from('SSH connection closed without a remote exit status\n'))
      }
      proc.status = cancelled || failure !== undefined || proc.signal !== null ? 'killed' : 'completed'
      settled.resolve()
    })
    connection.on('ready', () => {
      // Cancellation before channel admission owns no remote command to interrupt.
      if (cancelled) { connection.end(); return }
      connection.exec(command, { pty: { term: 'dumb', modes: { ECHO: 0, ISIG: 1, VINTR: 3, ONLCR: 0 } } }, (error, stream) => {
        if (error !== undefined) { fail(error); return }
        channel = stream
        stream.on('data', (data: Buffer) => { stdout.push(data) })
        stream.stderr.on('data', (data: Buffer) => { stderr.push(data) })
        stream.on('error', fail)
        stream.on('exit', (code: number | null, name?: string) => {
          proc.exitCode = code
          if (name !== undefined) proc.signal = `SIG${name}` as NodeJS.Signals
        })
        stream.on('close', () => { connection.end() })
        if (cancelled) stream.write('\x03')
      })
    })
    this.active.add(proc)
    signal.addEventListener('abort', abort, { once: true })
    const connect = async (): Promise<void> => {
      const privateKey = this.config.privateKeyFile === undefined ? undefined : await readFile(this.config.privateKeyFile)
      if (cancelled) {
        proc.status = 'killed'
        settled.resolve()
        return
      }
      connection.connect({
        host: this.config.host, port: this.config.port, username: this.config.username,
        hostHash: 'sha256', hostVerifier: (hash: string) => hash === this.config.hostKeySha256,
        ...this.config.agentSocket === undefined ? { privateKey: privateKey as Buffer } : { agent: this.config.agentSocket },
        readyTimeout: 0, keepaliveInterval: 0,
      })
    }
    void connect().catch((error: unknown) => {
      failure = error
      stderr.push(Buffer.from(`SSH setup failed: ${String(error)}\n`))
      proc.status = 'killed'
      connection.end()
      settled.resolve()
    })
    return { proc, stdout, stderr, failure: () => failure, cancelled: () => cancelled }
  }
}

export default SshBashExecutor
