/** Opt-in real Docker lifecycle and authenticated SSH; use the adjacent test-only image. */
import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Docker from 'dockerode'
import { Client } from 'ssh2'
import Playground from '../src/index.ts'
import type { PlaygroundContainerId, SshEndpoint } from '../src/index.ts'

const socketPath = process.env.DSH_PLAYGROUND_TEST_SOCKET
const image = process.env.DSH_PLAYGROUND_TEST_IMAGE

/** Authenticate against the disposable fixture; no shell or command is requested. */
async function authenticate(endpoint: SshEndpoint): Promise<void> {
  const client = new Client()
  const closed = new Promise<void>(resolve => client.once('close', resolve))
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve).once('error', reject)
      client.connect({ host: endpoint.host, port: endpoint.port, username: endpoint.username,
        password: 'playground-test', readyTimeout: 5_000,
        // The fixture is a fresh, loopback-only container owned by this test.
        hostVerifier: () => true,
      })
    })
  } finally {
    client.destroy()
    await closed
  }
}

it.skipIf(!socketPath || !image)('retains containers across plugin reload and exposes authenticated SSH without executing a container command', async () => {
  const docker = new Docker({ socketPath, timeout: 30_000 })
  const namespace = `playground-test-${randomUUID()}`
  const config = { socketPath: socketPath!, namespace, sshHost: '127.0.0.1', bindAddress: '127.0.0.1', requestTimeoutMs: 30_000, stopTimeoutSeconds: 1 }
  const ctx = new Context()
  let id: PlaygroundContainerId | undefined
  try {
    const fiber = await ctx.plugin(Playground, config)
    id = await ctx.playground.create({ image: image!, name: namespace, sshPort: 22, username: 'playground' })
    expect((await ctx.playground.get(id)).ssh).toBeNull()
    const started = await ctx.playground.start(id)
    expect(started.ssh).not.toBeNull()
    // SSH readiness is external to Docker's running state; poll the actual handshake.
    await expect.poll(() => authenticate(started.ssh!), { timeout: 15_000 }).toBeUndefined()
    await expect(ctx.playground.remove(id)).rejects.toThrow()
    await fiber.dispose()
    expect((await docker.getContainer(id).inspect()).State.Running).toBe(true)
    await ctx.plugin(Playground, config)
    expect((await ctx.playground.list()).map(row => row.id)).toContain(id)
    await ctx.playground.stop(id)
    await ctx.playground.stop(id)
    expect((await docker.getContainer(id).inspect()).State.Running).toBe(false)
    await ctx.playground.remove(id)
    await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 })
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      // A failed assertion must not leak the test-owned container.
      const remaining = await docker.listContainers({ all: true, filters: { label: [`ai.deepseek.dsh.playground.namespace=${namespace}`] } })
      await Promise.all(remaining.map(row => docker.getContainer(row.Id).remove({ force: true, v: true })))
    }
  }
})
