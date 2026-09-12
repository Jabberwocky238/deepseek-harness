# Agent Note: WeCom owned conversations

Status: implemented

English | [中文](2026-09-12-wecom-owned-conversations.zh.md)

## Problem

WeCom users need multi-turn Agent conversations and replies on the originating transport. The webhook runtime creates independent Sessions without tracking completion, so it cannot own this conversation lifecycle.

## Decision

The [WeCom plugin](../../../../packages/interaction/wecom/README.md) uses the maintained WeCom SDK for long-connection transport. The plugin owns a bounded map of conversation queues and Agent handles. A direct conversation belongs to one user; a group conversation belongs to a group and user pair. An explicit allowlist gates message admission before any Agent is created; `*` admits every sender for this bot, while an empty list denies everyone. The wildcard retains bot identity validation and per-user histories.

Each queue owns an idle-to-idle activity interval. One WeCom stream starts with a processing status and receives coalesced text previews from `agent/assistant-stream`; its final update uses the last committed assistant text. Failed attempts clear tentative previews, and errors or timeouts end the stream with a status. Reasoning and tool-call chunks remain private. Each message retains only its latest unsent preview and one outstanding acknowledgement. It does not claim causal attribution to one follow-up. The [owned-run decision](../architecture/2026-07-30-followup-enqueue-and-owned-runs.md) remains authoritative. The [webhook decision](2026-08-22-fire-and-forget-webhook-sessions.md) remains unchanged because it owns independent delivery-triggered Sessions. Neither record is superseded.

Native HTTP downloads enforce a byte budget and cancellation before SDK decryption. This avoids the SDK download helper’s unbounded buffering and missing cancellation input. The attachment service validates image batches and stores files verbatim; logged messages retain only durable references, never expiring URLs or decryption keys. The existing model request projection owns image delivery and file-handle text.

Message ids remain pending until processing settles, then enter a bounded completed-id set. Reply failure never reruns a task. Session persistence owns Agent logs, while conversation mappings and deduplication remain process-local. Plugin unload stops admission, disconnects the transport, disposes owned Agents, and drains queued work.

## Alternatives considered

**Reuse the webhook runtime.** Its fire-and-forget semantics do not provide multi-turn ownership or completion replies. Extending it for chat would change an unrelated public responsibility.

**Share one Agent across a group.** That lets one member read another member’s conversational context. Per-member histories provide explicit isolation while retaining the deployment’s shared workspace.

**Persist mappings and an outbox immediately.** Durable replay and delivery introduce separate transaction and retry guarantees. The first implementation instead states its restart and delivery limits explicitly.

## Consequences

The transport can reconnect without discarding live conversation history. Reloads start new conversations, and old message ids can be admitted after eviction or restart. Multiple plugin rows keep separate bot connections, conversation maps, and message-id sets. Completed replies use committed text; local tests cover the real SDK over loopback together with the real Agent loop. Live credentials are still required to verify deployment authentication and delivery.
