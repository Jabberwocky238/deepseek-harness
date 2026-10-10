/** Remote Bash command construction; SSH passes this string through the login shell. @module */
import { posix, relative, isAbsolute } from 'node:path'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'

function quote(value: string): string {
  if (value.includes('\0')) throw new Error('bash-ssh: command, path, and environment values must not contain NUL')
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Map a local workspace path to the configured remote root; other absolute paths stay remote.
 * @param workdir - caller directory, possibly omitted or relative.
 * @param cwd - absolute remote default directory.
 * @param localWorkspaceRoot - optional local prefix corresponding to cwd.
 * @returns an absolute POSIX remote path.
 */
export function remoteWorkdir(workdir: string | undefined, cwd: string, localWorkspaceRoot?: string): string {
  if (workdir === undefined) return cwd
  if (localWorkspaceRoot !== undefined && isAbsolute(workdir)) {
    const suffix = relative(localWorkspaceRoot, workdir)
    if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'))) {
      return posix.join(cwd, ...suffix.split(/[\\/]/))
    }
  }
  return posix.resolve(cwd, workdir)
}

/**
 * Build a fresh remote Bash command with terminal interrupt handling and explicit environment.
 * @param spec - resolved remote execution request.
 * @param foreground - wrap foreground commands in remote GNU timeout.
 * @returns shell-quoted SSH command; command stdin is independent of the PTY control stream.
 */
export function remoteCommand(spec: ShellExecSpec, foreground: boolean): string {
  const env = Object.entries({ NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', ...spec.env })
    .filter(([key]) => !key.toUpperCase().startsWith('DSH_'))
  env.push(...Object.entries(spec.dshEnv ?? {}))
  for (const [key] of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`bash-ssh: invalid environment variable name: ${key}`)
  }
  // The remote parent owns its own environment; apply the same credential scrub as local subprocesses.
  const scrub = 'for __dsh_name in $(compgen -e); do case "$__dsh_name" in '
    + `${SENSITIVE_ENV_PATTERN.source.split('|').map(key => `*${key.split('').map(c => `[${c}${c.toLowerCase()}]`).join('')}*`).join('|')}|[Dd][Ss][Hh]_*) unset "$__dsh_name" || exit;; esac; done`
  const run = `${foreground ? `timeout --signal=INT ${spec.timeoutMs / 1000}s ` : ''}bash -c ${quote(spec.command)}`
  const script = [
    "stty -echo -onlcr isig intr '^C' || exit",
    `cd -- ${quote(spec.workdir)} || exit`,
    scrub,
    `export ${env.map(([key, value]) => `${key}=${quote(value)}`).join(' ')}`,
    spec.stdin === undefined ? `exec ${run} </dev/null` : `printf %s ${quote(spec.stdin)} | ${run}`,
  ].join('\n')
  return `exec bash -c ${quote(script)}`
}
