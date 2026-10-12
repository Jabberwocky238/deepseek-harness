---
description: "The session-interaction capture seam: it turns committed Session events into searchable interaction records and hands them to a storage backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-manager

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-session-manager` defines what a Session interaction record is, which committed events produce one, and how a backend receives them. One event yields zero or more records: every assistant thinking block becomes its own record, and every tool call and tool result becomes one record carrying the model's own arguments and the tool's model-facing output. A backend implements `record`, `read`, `readSession`, and `shutdown`; the seam owns capture, batching, and the vocabulary, and the backend owns connection, schema, batching for its store, and retention. The shipped [SQLite backend](../session-manager-adapter-sql/README.md) stores one row per record.

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

Mount one backend. It registers itself as `ctx.sessionManager` — one implementation per context, and cordis throws on a duplicate, as it does for any service key. A backend is a `SessionManagerBackend` subclass; its constructor composes a `SessionManagerCoordinator`, which subscribes to `session/event` and installs the capture listeners on the backend's fiber. No other composition changes: the coordinator observes the events the Agent loop already commits.

A consumer reads interactions back through the service:

```ts
const records = await ctx.sessionManager.read({ sessionId, kinds: ['thinking'], limit: 50 })
const log = await ctx.sessionManager.readSession(sessionId)   // header plus every stored event
```

`read` answers questions about one session's recorded history, filtered by kind, `source.kind`, and starting sequence. `readSession` returns the stored header and events complete enough to rebuild the canonical log, so a consumer such as session persistence can restore a session whose log was lost.

### What a record identity means

`(sessionId, seq, ordinal)` is a record's identity. An event handed to a backend twice — a re-adopted session, a retried batch — must write the same rows instead of duplicating them, so every backend treats `record` as an upsert.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Capture is one coordinator per backend, and it is deliberately fork-free: handling happens on the emitting fiber, buffering happens in the coordinator's own array, and nothing waits on a promise the Agent loop needs to finish a turn.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionManagerBackend`, `SessionManagerSink`, the query and log types, and the `ctx.sessionManager` registration |
| [`src/records.ts`](src/records.ts) | The record vocabulary and the session-event mapping |
| [`src/coordinator.ts`](src/coordinator.ts) | Capture, buffering, serialized writes, and disposal |

### Batching and containment

One appended event usually produces several records — a message with its thinking blocks, or one tool call with its result. The coordinator buffers them and hands the batch to the backend on the next microtask, so one event reaches storage as one batch without the coordinator holding a timer. Writes serialize behind each other, which is what keeps batches in append order.

Every handler is self-contained because cordis `emit` is stop-on-throw: a failing backend must neither starve other `session/event` subscribers nor reach the Agent loop. A rejected or unmappable batch is logged and dropped, and the coordinator does not retry it. The `(sessionId, seq, ordinal)` identity is what lets a backend or a later reader repair such a gap from the canonical log.

### Disposal

Disposal drains the buffer and then awaits the backend's `shutdown`; a failure there warns instead of throwing, because recording must not fail application teardown. After disposal, late events append nothing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you are choosing a store or wiring the restored history back into a session.

- [SQLite backend](../session-manager-adapter-sql/README.md) — the shipped backend and its migration ledger.
- [Session persistence](../session-persistence/README.md) — the canonical log the seam reads and `readSession` rebuilds.
- [Session](../../core/session/README.md) — the event stream this seam observes.

-----

-----

<a id="model-experience"></a>
## Model Experience

None, as the seam observes the session stream and hands records to a storage backend; it registers no prompt, tool, or result.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the seam does not promise. They are current constraints, not a task backlog.

- **Capture is best-effort by design.** A backend failure is logged and dropped rather than retried, and nothing in the Agent loop waits for storage. A deployment that needs every record has to reconcile against the canonical log.
- **No backend ships with the seam.** Mounting is the deployment's decision; without a backend there is no `ctx.sessionManager` and capture does not happen.
- **`readSession` rebuilds only what a backend stored.** It returns nothing when the store never captured the session's header, which happens when the backend was mounted after the session began.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
