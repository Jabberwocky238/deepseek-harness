# Agent Note: SSH Bash with remote-owned interruption

Status: implemented

English | [中文](2026-09-13-bash-ssh-executor.zh.md)

## Problem

Agents need to execute Bash in remote container workspaces while retaining the existing tool and background-job interface. A local SSH process deadline can close a connection without establishing that the remote command stopped.

## Decision

The [SSH executor](../../../../packages/shell/bash-ssh/README.md) implements the existing shell service and leaves the Bash tool unchanged. Each call creates an authenticated SSH PTY and a fresh Bash. Deployment configuration owns the destination, authentication, host-key pin, and workspace mapping; model arguments contain no SSH credentials or routing fields.

Foreground commands run under remote GNU `timeout --signal=INT`. Cancellation and disposal write Ctrl-C and await the remote exit. No external deadline, grace timer, forced transport closure, or SIGKILL fallback enforces settlement. A command that ignores interruption can keep execution and disposal pending indefinitely. Background jobs omit the timeout wrapper.

## Alternatives considered

- A second model-facing SSH tool duplicates the Bash interface and exposes deployment concerns in model requests.
- Killing a local SSH client or introducing an external grace timer cannot establish remote termination and contradicts remote-owned interruption.
- A Python supervisor introduces a remote runtime beyond Bash and standard command-line utilities. The executor uses the PTY's foreground signal delivery instead.

## Consequences

The same Bash schema, rendering, and job controls work with an SSH destination. PTY output merges remote stdout and stderr; retained tails have no spill file. Exit code 124 follows GNU timeout's convention and cannot distinguish a command that independently returns 124. Host filesystem tools and LSP do not move with the shell provider, so deployments must align their execution worlds separately.

Authenticated loopback SSH tests exercise real PTYs, quoting, input, environment scrubbing, foreground timeout, Ctrl-C, and disposal. A release-file barrier proves that interruption does not resolve a command that remains running. The [headless scenario](../../../../snapshots/session/bash-ssh-turn/snapshot.yml) owns the recorded Bash result. Existing capability-seam and local-executor decisions remain active; this addition does not supersede them.
