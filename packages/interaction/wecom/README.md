---
description: "Chat with a DSH Agent through an Enterprise WeChat intelligent bot."
kind: "package-reference"
---

# @deepseek-ai/dsh-wecom

English | [中文](README.zh.md)

## Summary

Chat with an Agent from WeCom using an intelligent bot with a long connection. Conversations with text, images, and files retain context while the plugin runs. An explicit user allowlist or wildcard controls admission, and each group member has separate history. Bot credentials and a configured model are required for live use.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a profile that provides Agents, credentials, a default model, Sessions, permission presets, and attachment storage. See the [WeCom guide](../../../docs/user/guide/wecom.md) and the [optional overlay](../../../apps/cli/config/examples/wecom/cordis.yml). The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-wecom) owns the complete field reference.

Set `allowedUsers` to exact user IDs or `['*']` to allow everyone who can reach the bot; an empty list denies everyone. Allowed users can send text, images, mixed text and images, or files in a direct conversation or through group bot interaction. Direct history is keyed by user; group history is keyed by group and user. The plugin submits one message at a time per conversation and opens a reply with “Working…” (`en`) or “正在处理中…” (`zh`). Text previews replace that reply during generation; the final update contains the last committed assistant text in its activity interval. Other conversations run independently.

Mount multiple rows with distinct IDs and bot credentials to run bots together; each instance owns separate conversations and deduplication.

The bot secret is resolved at activation; reload the plugin after rotating it. The plugin applies the configured permission preset before submitting input. An optional Agent preset supplies scoped capabilities; without one, the Agent uses globally mounted capabilities. No approval or question-answer UI is provided in WeCom. Permission requests retain the composed policy and answerers.

Image and file downloads share a per-message byte budget and an admission deadline. Direct HTTPS links are required; loopback HTTP supports local tests, and redirects are rejected. The SDK decrypts encrypted bytes. Attachment storage validates images and stores files verbatim before any input reaches the Agent. Failures return an attachment status; unload cancels pending downloads.

Input text and complete replies have UTF-8 byte limits. Oversized input is rejected; oversized replies end with an ellipsis within the limit. A timed-out task is cancelled and drained before a timeout reply. Failed tasks return a fixed status without exposing internal error details.

Mount IM storage and set `imMaxAiMessages` to enable `im_context` and `talk`; omission leaves them disabled. The example overlays enable both tools. Without a contact roster, each bot, user, and group/user conversation gets isolated IM identities and contacts. Set identical `imBotContacts` rosters on selected bots, including every bot’s ID and stable display name, to make their Agents mutual contacts for the same user and chat. An empty roster keeps bots separate. Each Agent retains its own human chat and can discover a shared AI chat through `im_context`; `talk` selects it by conversation ID. The peer starts receiving when that user has messaged its bot. Other users and groups remain separate. `talk` stores its message before sending Markdown, images, or files to the originating WeCom chat. Its result confirms durable admission, not recipient delivery. Failed deliveries remain in IM storage for explicit retry; a partially delivered message can duplicate earlier parts on retry. The budget survives restart and must match the stored conversation configuration.

Outbound uploads count actual attachment bytes against the IM message budget before buffering each chunk. `talk` accepts workspace paths in `files`, for example `{"message":"","files":[{"path":"report.pdf","kind":"file"}]}`. The filesystem provider resolves relative paths from the Agent workspace. The SDK uploads the stored bytes in chunks and sends the returned media ID to the originating user or group; upload failure leaves the durable delivery failed and sends no media message for that attachment.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each admitted message keeps one stream ID. Changed previews are coalesced at `replyIntervalMs`; only one update waits for acknowledgement at a time. A final update discards unsent previews and ends the same stream. Failed attempts and timeouts replace tentative text with a status. Reasoning and tool-call payloads are never forwarded.

The WeCom SDK owns authentication, heartbeats, reconnection, and reply acknowledgements. The plugin validates callback data, serializes owned Agent intervals, and observes committed Session events for the reply. Cordis effects own listeners, queued work, and Agent disposal.

No runtime invariant companion is published: the plugin owns no independently exposed projection of Session state; Agent and Session invariants own those relationships. Transport admission, ordering, and teardown are checked by the [Loader composition tests](tests/loader-composition.spec.ts).

</details>

<a id="model-experience"></a>
## Model Experience

### Accepted text input

#### What the model sees

Each admitted callback contributes ordered content as a logged `user/message`. Text preserves `text.content`; images and files become durable `image` and `file` references. Vision-capable models receive image input. File references become [readable file handles](../../llm/llm/README.md) through the existing request projection and file tools. The plugin adds no system prompt. Enabled IM tools add schemas and logged discovery or messaging results. Bot secrets, attachment URLs and decryption keys, callback headers, and unconsumed payload fields are not included in model input.

#### Token effect

Accepted text, image input, file handles, enabled IM tool schemas and results, and accumulated conversation history consume context tokens; rejected or duplicate callbacks create no model request.

#### KV Cache effect

Ordinary follow-ups append to the existing Session. Preset and model providers own other cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Conversation mappings and bounded completed-message deduplication are process-local. Reload starts fresh conversations; mounted Session persistence can retain their logs but does not restore these mappings.
- Voice, video, quoted payloads, interactive cards, and WeCom approval answers are not implemented. Files use the existing file tools; this plugin does not itself extract PDF or Office document text.
- Conversation and pending-message caps bound live work. Reaching the conversation cap requires a reload to admit new conversations. Saturation can drop additional callbacks without a reply.
- A failed update is logged without rerunning the Agent or retrying that update; subsequent text and the final update are still attempted. Streaming replies have no durable outbox or exactly-once delivery guarantee.
- All conversations share the configured working directory and capabilities. Separate history does not isolate filesystem changes.
- Live WeCom authentication and delivery require deployment credentials; local tests use a loopback WeCom server and a scripted model.

<a id="dev-note"></a>
### Dev Note

See the [decision record](../../../.agents/notes/implemented/feature/2026-09-12-wecom-owned-conversations.md).
