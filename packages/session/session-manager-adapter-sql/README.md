---
description: "The shipped SQLite backend for the session-interaction seam: one row per interaction record, plus an optional exact rebuild of a lost session log."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-manager-adapter-sql

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-session-manager-adapter-sql` stores the interaction records the [session-manager seam](../session-manager/README.md) captures in one SQLite table keyed by `(session_id, seq, ordinal)`, so a rehanded batch updates its rows instead of duplicating them. It composes the seam's coordinator in its constructor, which means the backend owns storage and nothing else. On top of recording it can rebuild a canonical session log from stored events at activation, and it reconciles its rows against that log whenever a session flushes, so records the live event bus does not carry still reach the table.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that provides Sessions. It registers `ctx.sessionManager`.

```yaml
- id: session-manager
  name: '@deepseek-ai/dsh-session-manager-adapter-sql'
  config:
    path: !!js dshHomePath('interactions.sqlite')
    restoreSessions:
      - wecom-…
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | required | SQLite database file, or `:memory:` for an ephemeral store |
| `openAt` | `startup` | Open during activation, or `never` to open on the first record |
| `journalMode` | `wal` | SQLite journal mode; `:memory:` ignores it |
| `restoreSessions` | `[]` | Session ids to rebuild from the store during activation, before any Agent can resume them |

### Restoring a session whose log was lost

`restoreSessions` is what brings a session back after its canonical log is gone — a migrated conversation, a wiped log directory, a disaster rebuild. At activation, each listed id is read back through `readSession` and appended to a fresh log through the mounted session persistence backend, so the conversation resumes as if it had never left. The option requires a mounted persistence backend and fails loud when one is missing; an id with no stored header fails loud too, rather than restoring a fragment. A session that still has a log is reported and skipped by the persistence backend, so a stale `restoreSessions` entry is not destructive.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The backend: record, read, readSession, reconcile, restore, and shutdown |
| [`src/schema.ts`](src/schema.ts) | Opening the database, the schema, and the migration ledger |

### One table, two kinds of rows

`session_interaction` holds every record plus one header row per session, distinguished by `kind`: a `session-header` row, written with `ordinal = -1`, carries the header JSON in `body`; every other row carries the record's payload in `body` and the raw source event in `event`. Only rows with an `event` participate in rebuilds, which is what makes `readSession` exact — a record's normalized `body` drops fields the canonical log needs, such as an assistant message's timed stream and its surface metadata.

`ordinal = -1` is also why the header and the session's first event can share `seq` without colliding.

### Reconciliation

The live event bus does not carry every stored event: a resume appends `session/end-seed` outside it. Each `session/flush` therefore reconciles the store against the canonical log, starting at the first sequence the store has no event for, and writes whatever capture could not see. Records capture already wrote are skipped rather than overwritten, so reconciliation never degrades the richer interaction rows.

### Schema versions

`SCHEMA_VERSION` is monotonic and the ledger in `schema_migrations` records each applied step; the shipped version adds the raw-event column that rebuilds depend on. An existing database is migrated in place.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you are choosing where interactions go or wiring a restore.

- [Session manager](../session-manager/README.md) — the seam this backend implements.
- [Session persistence](../session-persistence/README.md) — the canonical log that reconciliation reads and restore writes.

-----

-----

<a id="model-experience"></a>
## Model Experience

None, as the backend stores and reads back records the seam hands it; it registers no prompt, tool, or result.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this backend is not the right store. They are current constraints, not a task backlog.

- **A restore only writes sessions that have no log.** Rebuilding an existing log is deliberately refused by the persistence backend, so bringing a session forward means removing its log first.
- **`restoreSessions` is activation-time only.** There is no runtime operation to rebuild a session later; changing the list requires a restart.
- **Rows are never pruned.** Nothing expires records, and nothing compacts the database, so a long-lived deployment grows the file without bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
