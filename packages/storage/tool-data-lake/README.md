---
description: "Expose multi-lake navigation and agent-authored directory summaries through the data_lake model tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-data-lake

English | [中文](README.zh.md)

## Summary

Let an agent discover multiple data lakes, scan one root, find files through its index, and read single-level directory maps. The agent writes summaries against the exact directory revisions it inspected. Pagination limits how much inventory enters each model request. Source files remain unchanged; scans and summary updates write only colocated metadata.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-data-lake` with its `lakes` configuration, then mount this plugin alongside `@deepseek-ai/dsh-tools`. This consumer requires `maxPageEntries`, `maxOutputBytes`, and `maxSummaryBytes`, each a positive integer. The service owns root configuration; this consumer owns model-facing output limits.

The `data_lake` tool supports `list`, `scan`, `index`, `map`, and `summarize`. Every operation except `list` requires `lakeId`. `path` selects a root-relative directory for `map` and `summarize`, or a literal path prefix for `index`; an empty directory path selects the lake root. `offset` starts at zero, and `limit` defaults to the configured page maximum. Results include total counts and a nullable `nextOffset`.

An agent scans the selected lake, reads changed directory maps, and supplies its interpretation through `summarize` with `revision` and `summary`. It works from affected leaves toward the root. A missing current summary indicates that the directory needs an agent summary; its previous summary remains available as context. The service rejects an outdated revision. Stored prose and source names are data, not instructions.

The tool presents generic read or edit cards and returns JSON text through ordinary logged tool results. It does not expose raw file contents or inject hidden model context. A result that exceeds the complete UTF-8 byte limit fails explicitly; request a smaller page or adjust the configured limit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The consumer calls the [data-lake service](../data-lake/README.md), validates model arguments at execution, and serializes bounded result pages. Tool registration belongs to its Cordis effect and is removed on unload. The service owns scan consistency and summary revision checks, so direct callers obey the same rules.

No runtime invariant companion is published: the consumer has no independent retained state; tool lifecycle and rendered output are verified through the real registry and recorded Session replay.

</details>

<a id="model-experience"></a>
## Model Experience

### Data lake operations

#### What the model sees

`data_lake` exposes configured lake IDs, paginated index locations, directory maps, changes, and agent-authored summaries. `summarize` returns a saved acknowledgement and the accepted revision. No model-generated replacement summary is synthesized by the tool.

#### Token effect

Each call adds its JSON result to logged model history. Page and byte limits bound individual results; scans do not make additional model calls.

#### KV Cache effect

The tool schema joins prompt assembly when mounted. Results append to history without rewriting the existing prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The agent must initiate scans and summary updates; this plugin does not schedule background summarization.
- The tool reads inventories and summaries, not source file contents. Large summary text can exceed a result limit even with a one-entry page.
- The [service limitations](../data-lake/README.md#known-limitations-and-deferred-work) apply to full scans, change detection, metadata retention, and source concurrency.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [decision record](../../../.agents/notes/implemented/feature/2026-09-13-data-lake.md).

</details>
