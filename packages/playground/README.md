---
description: "Docker container management and SSH destination discovery packages."
kind: "package-group"
---

# playground/ — Docker containers

English | [中文](README.zh.md)

## Summary

Manage Docker containers whose images accept SSH. This family keeps container lifecycle separate from remote command execution. Container software and credentials remain deployment choices.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

The controller supplies the container operations.

| Package | Role |
|---|---|
| [playground](playground/README.md) | Docker container lifecycle and published SSH destinations |

<a id="related-documentation"></a>
## Related documentation

- [Playground subsystem](../../docs/subsystems/playground.md) — ownership and service API.

<a id="dev-note"></a>
## Dev Note

None.
