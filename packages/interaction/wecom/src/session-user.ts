/**
 * One container login per WeCom conversation.
 *
 * A bot's container is an ordinary Linux host: each conversation gets its own
 * login and home directory, and reaches the container over its own OpenSSH
 * alias. The alias is what keeps the login and home apart, not the login the
 * Agent's commands run as: the ssh providers stay the deployment's own, so
 * every conversation's commands execute as that login. Each home is mode 750
 * and belongs to that login's own group, which admits the deployment-wide
 * connection while no other login in the container can read it. Login and home
 * derive from the conversation key, so they are stable across restarts and
 * match the Session id.
 *
 * @module @deepseek-ai/dsh-wecom/session-user
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'

const run = promisify(execFile)

/** One conversation's login, home directory and OpenSSH alias. */
export interface SessionIdentity {
  /** Container login the conversation's commands run as. */
  user: string
  /** That login's home directory; also the conversation's working directory. */
  home: string
  /** OpenSSH alias addressing the container as that login. */
  alias: string
}

/** Connection facts a generated alias copies from the deployment's own alias. */
export interface SshTarget {
  /** Host the deployment alias resolves to. */
  hostName: string
  /** Port the deployment alias uses. */
  port: string
  /** Login the deployment's own connection authenticates as. */
  login: string
  /** Private key the deployment alias authenticates with, expanded. */
  identityFile: string
  /** Matching public key, installed for every conversation's login. */
  publicKey: string
}

/**
 * Read the effective connection of a deployment-owned OpenSSH alias.
 * @param host - alias the deployment's own ssh providers use.
 * @returns login, host, port, key and public key of that alias.
 */
export async function resolveSshTarget(host: string): Promise<SshTarget> {
  const { stdout } = await run('ssh', ['-G', host])
  // `ssh -G` merges the deployment's own configuration, so generated aliases
  // agree with it instead of repeating it; the first value of an option is the
  // one the deployment set.
  const value = (key: string): string | undefined => stdout.match(new RegExp(`^${key} (.+)$`, 'mu'))?.[1]
  const hostName = value('hostname')
  const port = value('port')
  const login = value('user')
  const identityFile = value('identityfile')
  if (hostName === undefined || port === undefined || login === undefined || identityFile === undefined) {
    throw new Error(`wecom: ssh alias ${host} resolves no login, host name, port and identity file`)
  }
  const key = identityFile.replace(/^~(?=\/)/u, homedir())
  return { hostName, port, login, identityFile: key, publicKey: (await readFile(`${key}.pub`, 'utf8')).trim() }
}

/**
 * Derive one conversation's container identity.
 * @param botId - bot the conversation belongs to.
 * @param key - conversation key, as the plugin derives it from the callback.
 * @param homeRoot - absolute root the logins and homes live under.
 * @param sshHost - deployment alias the generated alias extends.
 * @returns the login, its home and the conversation's own OpenSSH alias.
 */
export function sessionIdentity(botId: string, key: string, homeRoot: string, sshHost: string): SessionIdentity {
  const digest = createHash('sha256').update(JSON.stringify([botId, key])).digest('hex')
  // The key is `[chattype, chatid | null, userid]`. Its first string is always
  // the conversation kind, so the readable segment is `single` or `group`; the
  // digest, computed over the whole key, is what keeps two conversations apart.
  const parts: unknown = JSON.parse(key)
  const named = Array.isArray(parts) ? parts.find(part => typeof part === 'string' && part !== '') : undefined
  const readable = String(named ?? '').toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_').replaceAll(/^_+|_+$/gu, '').slice(0, 16)
  const slug = `${readable === '' ? '' : `${readable}_`}${digest.slice(0, 8)}`
  return { user: `u_${slug}`, home: `${homeRoot}/u_${slug}`, alias: `${sshHost}-${slug}` }
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
 * Ensure the conversation's login, home and login key exist. Idempotent, so a
 * resumed conversation repeats it harmlessly.
 * @param shell - deployment-wide shell provider that reaches the container.
 * @param identity - conversation identity to create.
 * @param script - container-side provisioner, run as root.
 * @param target - connection facts of the deployment's own alias, whose login
 * the provisioner needs to admit to the conversation's home.
 * @param timeoutMs - deadline for the provisioning command.
 */
export async function ensureSessionUser(
  shell: ShellExecutor,
  identity: SessionIdentity,
  script: string,
  target: SshTarget,
  timeoutMs: number,
): Promise<void> {
  const arguments_ = [script, identity.user, identity.home, target.login].map(quoteArgument).join(' ')
  const execution = await shell.execute(shell.resolve({
    command: `sudo -n ${arguments_}`,
    // The executor would otherwise fall back to the harness process's own cwd,
    // which is a host path the container does not have. The login's home does
    // not exist until the provisioner makes it, so run from its parent.
    workdir: dirname(identity.home),
    stdin: `${target.publicKey}\n`,
    timeoutMs,
    onExpiry: 'kill',
    stdoutMaxBytes: 4096,
  }))
  const result = await execution.result()
  if (result.exitCode !== 0) {
    throw new Error(`wecom: provisioning ${identity.user} failed: ${result.stderr.text.trim() || `exit ${String(result.exitCode)}`}`)
  }
}

/**
 * Ensure the conversation's OpenSSH alias exists in the deployment's include file.
 * @param identity - conversation identity to address.
 * @param target - connection facts copied from the deployment's own alias.
 * @param configPath - include file receiving one alias block per conversation.
 */
export async function ensureSessionAlias(identity: SessionIdentity, target: SshTarget, configPath: string): Promise<void> {
  const path = configPath.replace(/^~(?=\/)/u, homedir())
  const existing = await readFile(path, 'utf8').catch(() => '')
  if (existing.split('\n').includes(`Host ${identity.alias}`)) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${existing === '' ? '' : '\n'}${[
    `Host ${identity.alias}`,
    `    HostName ${target.hostName}`,
    `    Port ${target.port}`,
    `    User ${identity.user}`,
    `    IdentityFile ${target.identityFile}`,
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking yes',
    '',
    '',
  ].join('\n')}`)
}
