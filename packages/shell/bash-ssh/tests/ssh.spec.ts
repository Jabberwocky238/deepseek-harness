import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SshBashExecutor from '../src/index.ts'
import { sshServer } from './ssh-server.ts'

let server: Awaited<ReturnType<typeof sshServer>> | undefined
let ctx: Context | undefined

afterEach(async () => {
  // The fixture owns forced cleanup only for failed assertions; the provider has no such fallback.
  await server?.close()
  await ctx?.fiber.dispose()
  server = undefined
  ctx = undefined
})

async function setup() {
  server = await sshServer()
  ctx = new Context()
  const fiber = ctx.plugin(SshBashExecutor, server.config)
  await fiber
  return { ctx, server, fiber }
}

// Real remote Bash/PTY behavior requires a POSIX fixture host.
describe.skipIf(process.platform === 'win32')('SSH Bash provider', () => {
  it('executes multiline scripts with literal quoting, stdin, environment scrub, and fresh shells', async () => {
    const { ctx, server } = await setup()
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: 'printf \'%s\\n\' "it\'s literal" \'$HOME $(touch injected)\' "$KEPT" "$DSH_CURRENT" "${DSH_STALE-unset}" "${SECRET_FOR_TEST-unset}"\ncat\nprintf error >&2\nexit 7',
      stdin: 'input without newline', env: { KEPT: "value'\nnext", DSH_CURRENT: 'wrong' }, dshEnv: { DSH_CURRENT: 'current' },
    }))
    expect(result.exitCode).toBe(7)
    expect(result.stdout.text).toBe("it's literal\n$HOME $(touch injected)\nvalue'\nnext\ncurrent\nunset\nunset\ninput without newlineerror")
    expect(result.stderr.text).toBe('')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect((await ctx.shell.run(ctx.shell.resolve({ command: 'export KEPT=old; cd /' }))).exitCode).toBe(0)
    const fresh = await ctx.shell.run(ctx.shell.resolve({ command: 'printf "%s|%s" "$PWD" "${KEPT-unset}"' }))
    expect(fresh.stdout.text).toBe(`${server.root}|unset`)
  })

  it('interrupts background work with Ctrl-C and consumes each output once', async () => {
    const { ctx, server } = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: "trap 'printf interrupted; exit 0' INT; printf ready; while :; do sleep 1; done" }))
    let output = ''
    await expect.poll(() => { output += proc.readOutput().delta; return output }).toContain('ready')
    expect(proc.kill()).toBe(true)
    expect(proc.kill()).toBe(false)
    await proc.done
    output += proc.readOutput().delta
    expect(output).toContain('interrupted')
    expect(server.interrupts).toContain('\x03')
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toBe('')
  })

  it('leaves an interrupted command pending until Bash itself exits', async () => {
    const { ctx, server } = await setup()
    const release = join(server.root, 'release')
    const proc = ctx.shell.start(ctx.shell.resolve({ command: `trap 'printf interrupted' INT; printf ready; while [ ! -f '${release}' ]; do sleep 0.05; done; printf released` }))
    let output = ''
    let settled = false
    void proc.done.then(() => { settled = true })
    await expect.poll(() => { output += proc.readOutput().delta; return output }).toContain('ready')
    proc.kill()
    await expect.poll(() => { output += proc.readOutput().delta; return output }).toContain('interrupted')
    expect(settled).toBe(false)
    await writeFile(release, '')
    await proc.done
    expect(proc.readOutput().delta).toContain('released')
  })

  it('sends Ctrl-C during plugin disposal and unregisters the provider after settlement', async () => {
    const { ctx, server, fiber } = await setup()
    const proc = ctx.shell.start(ctx.shell.resolve({ command: "trap 'exit 0' INT; printf ready; while :; do sleep 1; done" }))
    let output = ''
    await expect.poll(() => { output += proc.readOutput().delta; return output }).toContain('ready')
    await fiber.dispose()
    expect(proc.status).toBe('killed')
    expect(server.interrupts).toContain('\x03')
    expect(ctx.get('shell')).toBeUndefined()
  })

  it('enforces a foreground timeout inside Bash with SIGINT', async () => {
    const { ctx, server } = await setup()
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: "trap 'printf interrupted; exit 0' INT; printf ready; while :; do sleep 1; done",
      timeoutMs: 100,
    }))
    expect(result.stdout.text).toContain('ready')
    expect(result.stdout.text).toContain('interrupted')
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(server.interrupts).toEqual([])
  })

  it('preserves cancellation even when the remote interrupt handler exits successfully', async () => {
    const { ctx, server } = await setup()
    const controller = new AbortController()
    const ready = join(server.root, 'ready')
    const result = ctx.shell.run(ctx.shell.resolve({
      command: `trap 'exit 0' INT; touch '${ready}'; while :; do sleep 1; done`,
      signal: controller.signal,
    }))
    await expect.poll(async () => (await import('node:fs/promises')).stat(ready).then(() => true, () => false)).toBe(true)
    controller.abort()
    expect(await result).toMatchObject({ exitCode: 0, aborted: true, timedOut: false })
  })

  it('refuses an untrusted server key', async () => {
    server = await sshServer()
    ctx = new Context()
    await ctx.plugin(SshBashExecutor, { ...server.config, hostKeySha256: '0'.repeat(64) })
    await expect(ctx.shell.run(ctx.shell.resolve({ command: 'echo should-not-run' }))).rejects.toThrow(/Host denied/)
  })
})
