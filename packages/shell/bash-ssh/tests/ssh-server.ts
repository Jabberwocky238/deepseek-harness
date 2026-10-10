/** Loopback SSH server backed by real PTYs; all endpoints and keys belong to one test. @module */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'

/** @returns an authenticated SSH fixture and its quiescent cleanup operation. */
export async function sshServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bash-ssh-'))
  const ctx = new Context()
  const terminals = new Set<SubprocessTerminalHandle>()
  const clients = new Set<Connection>()
  const errors: Error[] = []
  const interrupts: string[] = []
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  const parsed = ssh2.utils.parseKey(key.privateKey)
  if (parsed instanceof Error) throw parsed
  const identity = join(root, 'identity')
  await writeFile(identity, key.privateKey, { mode: 0o600 })
  const hostKeySha256 = createHash('sha256').update(parsed.getPublicSSH()).digest('hex')
  await ctx.plugin(LocalSubprocess)
  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, (client) => {
    clients.add(client)
    client.on('error', (error) => { errors.push(error) })
    client.on('close', () => clients.delete(client))
    client.on('authentication', (auth) => {
      if (auth.method === 'publickey' && auth.key.data.equals(parsed.getPublicSSH())) auth.accept()
      else auth.reject()
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => { acceptPty?.() })
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        const launch = async () => {
          const terminal = await ctx.subprocess.spawnTerminal({
            argv: ['bash', '-c', info.command], cwd: root,
            env: { TERM: 'dumb', DSH_STALE: 'stale', SECRET_FOR_TEST: 'secret', PATH: process.env.PATH ?? '/usr/bin:/bin' },
            rows: 24, cols: 80, graceMs: 100,
          })
          terminals.add(terminal)
          terminal.output.on('data', (data: Buffer) => { stream.write(data) })
          stream.on('data', (data: Buffer) => {
            interrupts.push(data.toString())
            void terminal.write(data.toString()).catch((error: unknown) => { errors.push(error as Error) })
          })
          const outcome = await terminal.done
          stream.exit(outcome.exitCode ?? 128)
          stream.end()
        }
        void launch().catch((error: unknown) => { errors.push(error as Error); stream.exit(1); stream.end() })
      })
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing SSH TCP address')
  return {
    root, errors, interrupts,
    config: { host: '127.0.0.1', port: address.port, username: 'agent', privateKeyFile: identity, hostKeySha256, cwd: root },
    async close() {
      await Promise.all([...terminals].map(terminal => terminal.terminate()))
      for (const client of clients) client.end()
      await new Promise<void>(resolve => server.close(() =>{  resolve() }))
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
