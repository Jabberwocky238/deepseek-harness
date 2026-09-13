/** Docker-backed container management; never executes commands inside a container. */
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import Docker from 'dockerode'
import { z } from 'zod'
import type { CreateContainerRequest, PlaygroundContainer, PlaygroundContainerId } from './types.ts'

export type * from './types.ts'

/** Deployment settings for one independently managed Docker namespace. */
export interface Config {
  /** Docker Engine Unix socket or Windows named pipe; Docker contexts are not inferred. */
  socketPath: string
  /** Persistent ownership label; reuse it after reload to discover the same containers. */
  namespace: string
  /** Address returned to SSH clients; must reach the configured published interface. */
  sshHost: string
  /** Docker-host IP on which SSH ports are published. */
  bindAddress: string
  /** Per-Docker-request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Grace period Docker grants a container before killing it during stop. */
  stopTimeoutSeconds: number
}

const OWNER = 'ai.deepseek.dsh.playground.namespace'
const SSH_PORT = 'ai.deepseek.dsh.playground.ssh-port'
const USERNAME = 'ai.deepseek.dsh.playground.username'
const port = z.number().int().min(1).max(65535)
const configSchema = z.object({
  socketPath: z.string().min(1),
  namespace: z.string().min(1),
  sshHost: z.string().min(1),
  bindAddress: z.union([z.ipv4(), z.ipv6()]),
  requestTimeoutMs: z.number().int().positive(),
  stopTimeoutSeconds: z.number().int().nonnegative(),
})
const inspectSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Name: z.string(),
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Status: z.string(), Running: z.boolean() }),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()),
  }),
})
const metadataSchema = z.object({
  [SSH_PORT]: z.string().regex(/^\d+$/).transform(Number).pipe(port),
  [USERNAME]: z.string().min(1),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    playground: PlaygroundController
  }
}

/** Manages labeled Docker containers that persist independently of plugin lifetime. */
export class PlaygroundController extends Service {
  static Config: schema<Config> = schema.object({
    socketPath: schema.string().required(),
    namespace: schema.string().required(),
    sshHost: schema.string().required(),
    bindAddress: schema.string().required(),
    requestTimeoutMs: schema.number().required(),
    stopTimeoutSeconds: schema.number().required(),
  })

  private readonly docker: Docker
  private readonly config: Config
  /** Service method access can rebind this.ctx to the caller; lifetime belongs to the provider. */
  private readonly owner: Context['fiber']
  private readonly pending = new Set<Promise<unknown>>()
  private closing = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'playground')
    this.owner = ctx.fiber
    this.config = configSchema.parse(config)
    this.docker = new Docker({ socketPath: this.config.socketPath, timeout: this.config.requestTimeoutMs })
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.pending])
    }, 'drain playground Docker requests')
  }

  /**
   * Create a stopped container, publishing only its declared SSH port on first start.
   * The image owns SSH setup. A failed or timed-out response may still leave a Docker resource.
   * @param request - Image, SSH metadata, and optional image startup inputs.
   * @returns Canonical container id; use list() to recover ambiguous Docker outcomes.
   */
  create(request: CreateContainerRequest): Promise<PlaygroundContainerId> {
    return this.run(async () => {
      const tcp = `${port.parse(request.sshPort)}/tcp`
      if (request.image.length === 0 || request.username.length === 0) throw new Error('playground: image and SSH username must be non-empty')
      const container = await this.docker.createContainer({
        Image: request.image,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.command === undefined ? {} : { Cmd: [...request.command] }),
        ...(request.env === undefined ? {} : { Env: Object.entries(request.env).map(([key, value]) => `${key}=${value}`) }),
        Labels: { [OWNER]: this.config.namespace, [SSH_PORT]: String(request.sshPort), [USERNAME]: request.username },
        ExposedPorts: { [tcp]: {} },
        HostConfig: { PortBindings: { [tcp]: [{ HostIp: this.config.bindAddress, HostPort: '' }] } },
      })
      return brandString<PlaygroundContainerId>(z.string().regex(/^[a-f0-9]{64}$/).parse(container.id))
    })
  }

  /**
   * List fresh observations of containers bearing this namespace's ownership label.
   * @returns Running and stopped containers; concurrent removals are omitted.
   */
  list(): Promise<PlaygroundContainer[]> {
    return this.run(async () => {
      const rows = z.array(z.object({ Id: z.string() })).parse(await this.docker.listContainers({
        all: true, filters: { label: [`${OWNER}=${this.config.namespace}`] },
      }))
      const result: PlaygroundContainer[] = []
      for (const row of rows) {
        try {
          result.push(await this.inspect(row.Id))
        } catch (error) {
          if (!hasStatus(error, 404)) throw error
        }
      }
      return result
    })
  }

  /**
   * Read a container and enforce namespace ownership.
   * @param id - Full Docker id returned by this service.
   * @returns Current Docker state and its published SSH destination, if running.
   */
  get(id: PlaygroundContainerId): Promise<PlaygroundContainer> {
    return this.run(() => this.inspect(id))
  }

  /**
   * Start an owned container; already-running containers succeed.
   * @param id - Full Docker id returned by this service.
   * @returns Fresh Docker state; the SSH server may still be starting.
   */
  start(id: PlaygroundContainerId): Promise<PlaygroundContainer> {
    return this.run(async () => {
      const owned = await this.inspect(id)
      await acceptUnchanged(() => this.docker.getContainer(owned.id).start())
      return this.inspect(owned.id)
    })
  }

  /**
   * Stop an owned container using the configured Docker grace period; already-stopped succeeds.
   * @param id - Full Docker id returned by this service.
   * @returns Fresh Docker state after stop.
   */
  stop(id: PlaygroundContainerId): Promise<PlaygroundContainer> {
    return this.run(async () => {
      const owned = await this.inspect(id)
      await acceptUnchanged(() => this.docker.getContainer(owned.id).stop({ t: this.config.stopTimeoutSeconds }))
      return this.inspect(owned.id)
    })
  }

  /**
   * Delete an owned stopped container. Docker refuses running containers; volumes are retained.
   * @param id - Full Docker id returned by this service.
   */
  remove(id: PlaygroundContainerId): Promise<void> {
    return this.run(async () => {
      const owned = await this.inspect(id)
      await this.docker.getContainer(owned.id).remove({ force: false, v: false })
    })
  }

  private async inspect(id: string): Promise<PlaygroundContainer> {
    const data = inspectSchema.parse(await this.docker.getContainer(id).inspect())
    if (data.Config.Labels[OWNER] !== this.config.namespace) throw new Error('playground: container belongs to another namespace')
    const metadata = metadataSchema.parse(data.Config.Labels)
    const sshPort = metadata[SSH_PORT]
    const username = metadata[USERNAME]
    const binding = data.NetworkSettings.Ports[`${sshPort}/tcp`]?.find(item => item.HostIp === this.config.bindAddress)
    const ssh = data.State.Running && binding !== undefined
      ? { host: this.config.sshHost, port: port.parse(Number(binding.HostPort)), username }
      : null
    return { id: brandString<PlaygroundContainerId>(data.Id), name: data.Name.replace(/^\//, ''),
      image: data.Config.Image, status: data.State.Status, sshPort, username, ssh }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.owner.state === FiberState.UNLOADING || this.owner.state === FiberState.DISPOSED) {
      return Promise.reject(new Error('playground: service is disposing'))
    }
    const pending = Promise.resolve().then(operation)
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }
}

/** Inspect Docker's error response without interpreting application errors as HTTP statuses. */
function hasStatus(error: unknown, status: number): boolean {
  return error instanceof Error && 'statusCode' in error && error.statusCode === status
}

/** Docker reports idempotent start and stop requests as HTTP 304. */
async function acceptUnchanged(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (!hasStatus(error, 304)) throw error
  }
}

export default PlaygroundController
