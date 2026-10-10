---
description: "Manage Docker containers and discover their published SSH destinations without installing guest software."
kind: "package-reference"
---

# @deepseek-ai/dsh-playground

English | [中文](README.zh.md)

## Summary

Create, list, start, stop, and delete Docker containers whose images provide SSH. Choose any image and SSH account; Playground installs no guest software and requires no Bash, Node.js, Python, SFTP, or E2B runtime. Containers survive plugin unload and application restart. Docker keeps their state and ownership labels.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-playground` as a plugin row in an existing `dsh` profile composition. Set every deployment field explicitly: `socketPath` is the Docker Engine Unix socket or Windows named pipe, `namespace` identifies the managed containers, `sshHost` is the client-reachable Docker host, and `bindAddress` is the IP on which Docker publishes SSH. `requestTimeoutMs` bounds each Docker request; `stopTimeoutSeconds` gives Docker its stop grace period. Use a loopback bind for local access. Invalid configuration rejects plugin activation; an unreachable Docker daemon rejects the first operation.

```yaml
- name: '@deepseek-ai/dsh-playground'
  config:
    socketPath: /var/run/docker.sock
    namespace: local-playground
    sshHost: 127.0.0.1
    bindAddress: 127.0.0.1
    requestTimeoutMs: 30000
    stopTimeoutSeconds: 10
```

Consumers declare `inject: ['playground']` and call `ctx.playground`. `create()` takes an existing image, container-side `sshPort`, and existing `username`, with optional Docker name, command argv, and explicit environment. It returns the full id of a stopped container. The image retains its ENTRYPOINT and, unless supplied, its CMD; credentials and SSH configuration belong to that image or its explicit startup inputs. No host environment is copied. Images must already be available to Docker.

`start()` returns Docker state and the dynamically assigned SSH destination. A running container does not prove that SSH is ready or authentication will succeed. `get()` and `list()` refresh these observations; stopped containers report no SSH destination. Clients own authentication and host-key verification. Repeated start and stop operations succeed. `remove()` requires a stopped container and retains its volumes.

The service only operates on containers labeled with its configured namespace. Reusing that namespace after reload discovers the same resources. Unloading rejects new operations, waits for accepted requests to settle, and leaves containers intact. A Docker request timeout or lost response can leave an operation's outcome unknown; inspect or list before retrying creation. Names can help locate such resources.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The controller](src/index.ts) uses dockerode over the configured socket and validates Docker responses. Ownership and SSH metadata live in Docker labels; mutations inspect ownership before addressing the immutable full container id. Labels separate managed inventories, but access to the Docker daemon remains the authority to alter any container. No runtime invariant companion is published because Docker is the sole state owner and the plugin keeps no independent container projection.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Playground subsystem](../../../docs/subsystems/playground.md)
- [Docker lifecycle decision](../../../.agents/notes/implemented/architecture/2026-09-13-playground-docker-ssh.md)
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-playground)

<a id="model-experience"></a>
## Model Experience

### Container management

#### What the model sees

Nothing; the `playground` plugin registers no model tool, prompt section, or Session event.

#### Token effect

None; container operations add no model input.

#### KV Cache effect

None; container operations do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package exposes a backend service only. It does not mount a Web page, model tool, SSH executor, filesystem provider, or Session binding.
- Images, SSH accounts, authentication, volumes, and image distribution remain deployment responsibilities. No default image, image build/pull, or guest setup is provided.
- Docker access uses an explicit local socket or named pipe. Docker contexts and remote TLS/SSH Docker transports are not resolved.
- Each operation reads live Docker state without a cross-process lock. External starts, stops, removals, and network changes may race a returned observation; published SSH ports can change after restart.

<a id="dev-note"></a>
### Dev Note

None.
