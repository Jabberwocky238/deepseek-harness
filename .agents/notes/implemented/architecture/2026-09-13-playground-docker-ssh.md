# Agent Note: Docker Playground with SSH-only guest requirements

Status: implemented

English | [中文](2026-09-13-playground-docker-ssh.zh.md)

## Problem

Container management must accept user-selected images that provide SSH without requiring a specific language runtime, shell utility set, or sandbox platform inside the container.

## Decision

`dsh-playground` is one Docker-specific controller under `packages/playground/playground`. It uses dockerode for create, list, inspect, start, stop, and remove operations. The image supplies SSH accounts and configuration. The controller records its namespace, SSH port, and username in Docker labels and returns the published endpoint without guest commands or readiness claims.

Docker is the authoritative inventory. Containers survive plugin disposal; disposal stops admission and drains accepted operations. Mutations verify namespace ownership and use immutable full Docker ids, so a reused name cannot redirect a checked mutation. Deletion requires a stopped container and retains volumes. Namespace labels partition management, not Docker authorization. Deployment-varying socket, host, bind address, and timeouts are explicit configuration.

## Alternatives considered

**E2B self-hosting:** it requires its own sandbox infrastructure and runtime protocol, exceeding the SSH-only guest requirement.

**Reusing bash-ssh as the manager:** that executor neither provisions containers nor accepts an SSH-only guest; it requires Bash, stty, and GNU timeout.

**Automatic deletion on unload:** plugin reload would destroy independently useful containers. Explicit stop and remove operations preserve operator control.

## Consequences

Container management requires no model, Web, or Session changes. Docker image distribution, authentication, guest provisioning, and execution adapters remain independent responsibilities. Docker request timeouts cannot prove a server-side mutation was cancelled; clients recover by listing the labeled inventory. The controller keeps no duplicated container state and therefore has no invariant companion.

Loader tests cover Docker requests, namespace isolation, endpoint projection, idempotent operations, failures, and disposal. The opt-in Docker test authenticates over SSH against an OpenSSH-only fixture and verifies retention across plugin reload plus explicit stop and removal.
