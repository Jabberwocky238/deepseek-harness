---
description: "Index multiple disk directories or S3 prefixes with one root catalog per lake, directory-local maps, and agent-authored summaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-data-lake

English | [中文](README.zh.md)

## Summary

Index multiple independent data lakes, each backed by one disk directory or S3 bucket prefix. Every lake has one root index locating its files and directory maps. Each directory stores its own single-level map and agent-authored summary. Rescanning detects inventory changes and marks affected summaries, including ancestor summaries, as outdated without modifying source files.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile composition. Configure `lakes` with distinct IDs and roots; each entry requires `id`, `root`, and a positive `maxEntries` scan limit. A disk root is an absolute directory path. An S3 root is `s3://bucket/prefix/` and additionally requires `region`; `endpoint` and `forcePathStyle` select an S3-compatible service. S3 credentials come from the AWS SDK credential provider chain, not catalog records.

Call `ctx.dataLake.list()` to discover lakes, then `scan(lakeId)` to build one lake's catalog. `catalog(lakeId)` reads its root index; `directory(lakeId, path)` reads one map and its summary. Directory paths are root-relative and end in `/`; the empty string selects the root. `summarize(lakeId, path, revision, text)` records the agent's prose and rejects a revision that differs from the current index. These methods accept an optional final cancellation signal.

The source root must already exist and permit metadata writes. Metadata lives under `.dsh-data-lake/` at each indexed directory. Only the lake root contains `.dsh-data-lake/index.json`; directory maps and summaries live in `maps/<revision>.json` and `summaries/<revision>.json` under that directory's metadata folder. The root index records these locations. Metadata folders never become source entries.

A map contains only direct children, plus its parent, depth, revision, changes since its preceding indexed map, and the last available summary. The current summary is separate and absent until an agent writes it. Agents use the map, changes, previous summary, and source content to summarize each affected directory, working upward from changed leaves. Scanning itself calls no model and does not generate prose.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns independent operation queues for configured lakes. The indexer consumes a source interface implemented by the disk and S3 providers. It gathers listings, computes child revisions before parents, writes maps, and publishes the root index last. A failed scan leaves the preceding index in place; metadata written before failure may remain. Disposal cancels queued and active work and awaits settlement before releasing S3 clients.

Disk listings use file size and modification time; S3 listings additionally retain ETags. Symbolic links are indexed without traversal. S3 listings follow every continuation page and preserve the distinction between an object named `a` and a prefix named `a/`. The model-facing consumer is separate from the service.

No runtime invariant companion is published: the catalog is read from its medium per operation, with reference and revision validation. There is no independently mutable in-process projection to compare; source changes are observations made by scans.

</details>

<a id="model-experience"></a>
## Model Experience

### Catalog records

#### What the model sees

Nothing directly. `ctx.dataLake` contributes no tool or prompt; consumers select catalog records to expose through their own logged tool results.

#### Token effect

No direct model requests or request tokens.

#### KV Cache effect

No direct request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Scans enumerate the full lake and retain its catalog in memory, bounded by each lake's configured `maxEntries`. There is no filesystem watcher, S3 notification subscription, or automatic agent scheduler.
- Changes reflect source metadata, not a full content hash. A same-size disk rewrite retaining the same modification time may be missed; summaries describe the last indexed revision, not unscanned source changes.
- One live writer owns each root. Independent processes and overlapping physical roots are not coordinated. Source mutation during a scan can produce a mixed-time inventory or an IO error.
- Old map and summary files remain; automatic retention is not implemented. S3 prefixes retained by metadata remain navigable even after their source objects are removed.
- Paths containing dot segments, backslashes, or the reserved metadata component are rejected. S3-compatible behavior is tested through HTTP fixtures; a live deployment requires its own credentials and verification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [decision record](../../../.agents/notes/implemented/feature/2026-09-13-data-lake.md).

</details>
