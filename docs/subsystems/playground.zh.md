# Playground

[English](playground.md) | 中文

[Playground 包](../../packages/playground/playground/README.zh.md) 通过 `ctx.playground` 管理 Docker 容器。Docker 保存其状态和标签。命名空间选择管理清单；每次修改均验证归属并使用完整 Docker id。标签不限制其他 Docker 客户端。

镜像提供 SSH 服务和账户。服务发布配置的 TCP 端口并返回当前地址，不执行容器内命令，也不验证 SSH 就绪状态。插件卸载等待请求结束并保留容器。认证与主机密钥校验由 SSH 客户端负责。

## 容器数据

```ts type-equiv
/** Full Docker id of a container owned by a Playground namespace. */
type PlaygroundContainerId = Branded<'PlaygroundContainerId'>
```

```ts type-equiv
/** Inputs for creating a stopped container from an existing image. */
interface CreateContainerRequest {
  /** Image already available to the Docker daemon; no image is selected or pulled implicitly. */
  image: string
  /** Optional Docker name; Docker rejects duplicates. */
  name?: string
  /** TCP port on which the image's SSH server listens. */
  sshPort: number
  /** Existing SSH account; Playground does not create accounts or install credentials. */
  username: string
  /** Optional argv replacing the image CMD, with its ENTRYPOINT preserved. */
  command?: string[]
  /** Explicit image environment; the Harness process environment is never copied. */
  env?: Record<string, string>
}
```

```ts type-equiv
/** Published SSH destination; does not assert server readiness or successful authentication. */
interface SshEndpoint {
  /** Configured address of the Docker host reachable by the caller. */
  host: string
  /** Docker-assigned published TCP port. */
  port: number
  /** Image account supplied during creation. */
  username: string
}
```

```ts type-equiv
/** Fresh Docker observation, without image environment or authentication material. */
interface PlaygroundContainer {
  /** Canonical immutable Docker id, used for all subsequent mutations. */
  id: PlaygroundContainerId
  /** Docker name without its leading slash. */
  name: string
  /** Image reference recorded in the container configuration. */
  image: string
  /** Docker's reported state, including states unknown to this build. */
  status: string
  /** Container-side SSH listener port recorded at creation. */
  sshPort: number
  /** Existing SSH account recorded at creation. */
  username: string
  /** Published destination while running; null when Docker reports no running endpoint. */
  ssh: SshEndpoint | null
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplayground--playgroundcontroller"></a>

### `ctx.playground` — `PlaygroundController`

Manages labeled Docker containers that persist independently of plugin lifetime.

```ts cordis-catalog
/**
 * Create a stopped container, publishing only its declared SSH port on first start.
 * The image owns SSH setup. A failed or timed-out response may still leave a Docker resource.
 * @param request - Image, SSH metadata, and optional image startup inputs.
 * @returns Canonical container id; use list() to recover ambiguous Docker outcomes.
 */
create(request: CreateContainerRequest): Promise<PlaygroundContainerId>

/**
 * List fresh observations of containers bearing this namespace's ownership label.
 * @returns Running and stopped containers; concurrent removals are omitted.
 */
list(): Promise<PlaygroundContainer[]>

/**
 * Read a container and enforce namespace ownership.
 * @param id - Full Docker id returned by this service.
 * @returns Current Docker state and its published SSH destination, if running.
 */
get(id: PlaygroundContainerId): Promise<PlaygroundContainer>

/**
 * Start an owned container; already-running containers succeed.
 * @param id - Full Docker id returned by this service.
 * @returns Fresh Docker state; the SSH server may still be starting.
 */
start(id: PlaygroundContainerId): Promise<PlaygroundContainer>

/**
 * Stop an owned container using the configured Docker grace period; already-stopped succeeds.
 * @param id - Full Docker id returned by this service.
 * @returns Fresh Docker state after stop.
 */
stop(id: PlaygroundContainerId): Promise<PlaygroundContainer>

/**
 * Delete an owned stopped container. Docker refuses running containers; volumes are retained.
 * @param id - Full Docker id returned by this service.
 */
remove(id: PlaygroundContainerId): Promise<void>
```

Source: [`packages/playground/playground/src/index.ts`](../../packages/playground/playground/src/index.ts)
<!-- END GENERATED cordis-surface -->
