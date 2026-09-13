---
description: "Run the existing Bash tool on an SSH host with a remote workspace and terminal interruption."
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-ssh

English | [中文](README.zh.md)

## Summary

Run the existing `bash` tool on a remote host without asking the model to manage SSH connections. Each call starts a fresh Bash in the configured remote workspace, and background jobs use the existing job controls. The remote host needs Bash, `stty`, and GNU `timeout`; authentication uses a private key or an explicit SSH agent socket.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Replace the composition's local Bash executor with this provider and keep `dsh-tool-bash` and `dsh-shell-env` mounted. Only one provider registers `ctx.shell`; the shipped executors remain the defaults. Configure `host`, `username`, `hostKeySha256`, and the remote `cwd`, plus exactly one of `privateKeyFile` and `agentSocket`. The pinned fingerprint is the server public key's SHA-256 digest in lowercase hexadecimal, not the OpenSSH base64 display format. Disable `dsh-permission-presets` when replacing a sandboxing executor: its local sandbox presets require a confining shell and cannot govern SSH access.

`localWorkspaceRoot` maps that local prefix onto the remote `cwd`, including nested directories. Other absolute paths refer directly to the remote host; relative provider requests resolve against remote `cwd`. Set this mapping when the Bash tool supplies a local Session workspace path that differs from the remote mount. File tools, LSP, and persistent terminals retain their own providers.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-bash-ssh) owns the complete field list. The [Loader composition test](tests/loader.spec.ts) mounts this provider with the existing tool and exercises an authenticated SSH server.

Foreground execution uses `timeout --signal=INT` inside remote Bash. Cancellation, `job_kill`, and provider disposal send Ctrl-C through the PTY and wait for exit. There is no external execution timer, grace period, connection deadline, or forced-kill fallback: a remote command that ignores interruption can keep the call and disposal pending indefinitely. Background commands have no timeout.

Each call receives the remote environment after credential-shaped and stale `DSH_*` names are removed, then explicit environment entries and the current managed facts. Commands receive the same color and pager settings as local Bash. Remote stdout and stderr share the PTY output; SSH diagnostics remain separate. Output retains a bounded tail without a spill file.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider uses `ssh2` for authenticated connections and PTY channels. Scripts, paths, and explicit environment values are quoted through the remote login shell; command stdin is supplied independently from the terminal input used for Ctrl-C. The Bash tool owns schemas, result rendering, and job registration. No runtime invariant companion is published because this provider retains no independently published projection of its connection state.

See [execution](src/index.ts), [remote commands](src/command.ts), and [bounded output](src/output.ts).

The local SSH integration tests require Bash and GNU `timeout` on the test host; on macOS, `brew install coreutils` supplies `timeout`.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-bash`, which renders foreground results, background output, and execution failures using its existing schema and result format.

#### KV Cache effect

The provider adds no prompt section or tool. Replacing a sandboxing executor removes the Bash tool's conditional escalation parameters; stable compositions retain a stable tool schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- PTY output merges remote stdout and stderr; truncated output has no full-output file.
- GNU `timeout` reserves exit code 124 for timeout reporting; a command that itself exits 124 is indistinguishable from an elapsed timeout.
- Ctrl-C targets the terminal foreground group. Ignored signals, detached processes, or lost connectivity can prevent settlement; the provider does not enforce remote process-tree termination.
- SSH authentication and remote permissions govern access. The local file sandbox does not confine remote commands, and this provider does not advertise sandbox escalation.
- Each provider instance uses one fixed destination. Container provisioning, per-Agent routing, shared filesystem mounting, password prompts, and OpenSSH config-file interpretation are outside this package.

<a id="dev-note"></a>
### Dev Note

None.
