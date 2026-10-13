/**
 * One container login per WeCom conversation.
 *
 * A bot's container is an ordinary Linux host: each conversation gets its own
 * login and home directory, and the conversation's Agent runs its commands and
 * file operations as that login through the deployment's ssh service. The
 * container-side provisioner allocates the login as a prefix plus a four-digit
 * sequence number (`qingang0001`) and records the Session id in the login's
 * passwd comment field, so the same conversation finds the same login across
 * restarts. Each home is mode 770 with the deployment login's primary group, so
 * the deployment login can still seal the conversation's inbox, while no other
 * conversation login in the container can read it.
 *
 * @module @deepseek-ai/dsh-wecom/session-user
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'

const run = promisify(execFile)

/** One conversation's login and home directory. */
export interface SessionIdentity {
  /** Container login the conversation's commands run as. */
  user: string
  /** That login's home directory; also the conversation's working directory. */
  home: string
}

/** Connection facts the provisioner needs from the deployment's own alias. */
export interface SshTarget {
  /** Login the deployment's own connection authenticates as. */
  login: string
  /** Public key of the alias's identity, installed for every conversation's login. */
  publicKey: string
}

/**
 * Read the effective login and public key of a deployment-owned OpenSSH alias.
 * @param host - alias the deployment's own ssh service uses.
 * @returns login and public key of that alias.
 */
export async function resolveSshTarget(host: string): Promise<SshTarget> {
  const { stdout } = await run('ssh', ['-G', host])
  // `ssh -G` merges the deployment's own configuration; the first value of an
  // option is the one the deployment set.
  const value = (key: string): string | undefined => stdout.match(new RegExp(`^${key} (.+)$`, 'mu'))?.[1]
  const login = value('user')
  const identityFile = value('identityfile')
  if (login === undefined || identityFile === undefined) {
    throw new Error(`wecom: ssh alias ${host} resolves no login and identity file`)
  }
  const key = identityFile.replace(/^~(?=\/)/u, homedir())
  return { login, publicKey: (await readFile(`${key}.pub`, 'utf8')).trim() }
}

/**
 * Quote one argument for the container's shell. Single quotes neutralize every
 * metacharacter the remote shell would otherwise interpret — spaces, `;`,
 * `$(...)` and backticks included — so a path or login name reaches the
 * provisioner verbatim. An embedded single quote is closed, escaped and reopened.
 * @param value - argument to pass to the container-side provisioner.
 * @returns the argument, single-quoted for the container's shell.
 */
export function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Read the identity the provisioner reports on its last output line,
 * `ready <login> <home>`.
 * @param stdout - the provisioner's standard output.
 * @returns the conversation's login and home.
 * @throws when the last line does not report a login and an absolute home.
 */
export function parseProvisioned(stdout: string): SessionIdentity {
  const last = stdout.trim().split('\n').at(-1) ?? ''
  const match = /^ready ([a-z_][a-z0-9_-]{0,31}) (\/\S+)$/u.exec(last)
  if (match === null) throw new Error(`wecom: the provisioner reported no login: ${JSON.stringify(last)}`)
  return { user: match[1] as string, home: match[2] as string }
}

/** What the provisioner needs to find or create one conversation's login. */
export interface SessionUserRequest {
  /** Session id, recorded in the login's passwd comment field. */
  sessionId: string
  /** Login name prefix; the provisioner appends a four-digit sequence number. */
  prefix: string
  /** Absolute directory the homes live under. */
  homeRoot: string
  /** Container-side provisioner, run as root. */
  script: string
}

/**
 * Find or create the conversation's login, home and login key. Idempotent, so
 * a resumed conversation repeats it and gets the same login back.
 * @param shell - deployment-wide shell provider that reaches the container as the deployment login.
 * @param request - Session id, login prefix, home root and provisioner path.
 * @param target - the deployment login, admitted to the home, and the key installed for the conversation's login.
 * @param timeoutMs - deadline for the provisioning command.
 * @returns the conversation's login and home.
 */
export async function ensureSessionUser(
  shell: ShellExecutor,
  request: SessionUserRequest,
  target: SshTarget,
  timeoutMs: number,
): Promise<SessionIdentity> {
  const arguments_ = [request.script, request.sessionId, request.prefix, request.homeRoot, target.login].map(quoteArgument).join(' ')
  const execution = await shell.execute(shell.resolve({
    command: `sudo -n ${arguments_}`,
    // The executor would otherwise fall back to the harness process's own cwd,
    // which is a host path the container does not have.
    workdir: request.homeRoot,
    stdin: `${target.publicKey}\n`,
    timeoutMs,
    onExpiry: 'kill',
    stdoutMaxBytes: 4096,
  }))
  const result = await execution.result()
  if (result.exitCode !== 0) {
    throw new Error(`wecom: provisioning a login for ${request.sessionId} failed: ${result.stderr.text.trim() || `exit ${String(result.exitCode)}`}`)
  }
  return parseProvisioned(result.stdout.text)
}
