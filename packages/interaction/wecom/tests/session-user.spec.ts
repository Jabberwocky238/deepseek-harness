import { describe, expect, it } from 'vitest'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { ensureSessionUser, parseProvisioned } from '../src/session-user.ts'

/** A shell that records the one command it is asked to run and answers with fixed output. */
function fakeShell(stdout: string, exitCode = 0, stderr = '') {
  const requests: Record<string, unknown>[] = []
  const shell = {
    resolve: (request: Record<string, unknown>) => request,
    execute: async (spec: Record<string, unknown>) => {
      requests.push(spec)
      return { result: async () => ({ exitCode, stdout: { text: stdout }, stderr: { text: stderr } }) }
    },
  } as unknown as ShellExecutor
  return { shell, requests }
}

const request = { sessionId: 'wecom-9b900b64', prefix: 'qingang', homeRoot: '/home', script: '/usr/local/sbin/dsh-session-user' }
const target = { login: 'agent', publicKey: 'ssh-ed25519 AAAA test' }

describe('conversation login provisioning', () => {
  it('reads the login and home the provisioner reports on its last line', () => {
    expect(parseProvisioned('useradd: warning\nready qingang0007 /home/qingang0007\n')).toEqual({ user: 'qingang0007', home: '/home/qingang0007' })
  })

  it('refuses output that names no login', () => {
    expect(() => parseProvisioned('done\n')).toThrow('reported no login')
    expect(() => parseProvisioned('ready Bad;Name /home/x')).toThrow('reported no login')
    expect(() => parseProvisioned('ready qingang0001 relative/home')).toThrow('reported no login')
  })

  it('runs the provisioner as root with the Session id, prefix, home root and deployment login', async () => {
    const { shell, requests } = fakeShell('ready qingang0001 /home/qingang0001\n')
    expect(await ensureSessionUser(shell, request, target, 5000)).toEqual({ user: 'qingang0001', home: '/home/qingang0001' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      command: "sudo -n '/usr/local/sbin/dsh-session-user' 'wecom-9b900b64' 'qingang' '/home' 'agent'",
      workdir: '/home',
      stdin: 'ssh-ed25519 AAAA test\n',
      timeoutMs: 5000,
    })
  })

  it('quotes arguments so the container shell receives them verbatim', async () => {
    const { shell, requests } = fakeShell('ready qingang0001 /home/qingang0001\n')
    await ensureSessionUser(shell, { ...request, homeRoot: "/home/it's here" }, target, 5000)
    expect(requests[0]?.command).toContain("'/home/it'\\''s here'")
  })

  it('reports the provisioner failure', async () => {
    const { shell } = fakeShell('', 1, 'useradd: cannot lock /etc/passwd')
    await expect(ensureSessionUser(shell, request, target, 5000)).rejects.toThrow('useradd: cannot lock /etc/passwd')
  })
})
