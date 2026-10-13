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

### One container login per conversation

By default every conversation of a bot works in the single directory named by `workspacePath`. Setting `sessionHomeRoot` and `sessionSshHost` together switches the bot to an ordinary Linux layout instead: each conversation gets its own login (`u_<name>_<hash>`, derived from the same key as its Session id), its own home directory under `sessionHomeRoot`, and its own OpenSSH alias generated from `sessionSshHost`. The plugin creates those; it does not mount ssh providers per conversation, so an Agent's commands run as the deployment's own login. Each home is mode 750 and belongs to that login's own group, which is what lets the deployment-wide connection traverse a home while no other login in the container can read it. What separates two conversations of a bot is therefore their working directory, Session and reply stream, not the login their commands run under.

The container provides the provisioner shipped in `assets/`, installed as root:

```sh
install -m 755 assets/dsh-session-user.sh /usr/local/sbin/dsh-session-user
```

Run it as `dsh-session-user <login> <home> <deployment-login>` with the public key on standard input. It creates the login, unlocks it (the image's own login carries an empty password field, which `UsePAM no` requires), installs that key, and gives the home the deployment login's own group at mode 750 so the deployment-wide connection traverses it. The deployment login is an argument rather than an assumed name: the plugin reads it from the effective connection of `sessionSshHost`. Admitting the logins to sshd is the container's own configuration, not this script's.

A conversation login's inbound attachments are published to `<home>/inbox/` and named there in the prompt. The plugin writes them as root through the deployment-wide shell, after the login exists: the directory is root-owned at mode 755 and each file root-owned at 644, so the conversation reads its attachments but cannot change or remove them, and a repeated name becomes a sibling such as `report-1.docx`. `inboundDir` and `inboundHostDir` apply only to single-workspace bots.

### Per-session file storage

Setting `fileStore.enabled` stores every conversation's files in an S3-compatible bucket: an inbound attachment under `<prefix>/<session>/inbox/<name>`, and each attachment `sendfile` delivers under `<prefix>/<session>/outbox/<name>`, where `<session>` is the conversation's Session id. `fileStore.prefix` keeps the bucket root free of files; it defaults to the package's published name, read from its own manifest, so the fork's release stores under `@jabberwocky238/dsh-wecom/`. `fileStore.s3` names the endpoint, bucket, optional region, access key id, and `secretAccessKeyEnv`, a credential reference holding the secret key; `forcePathStyle` defaults to on, as MinIO expects; Tencent COS refuses path-style requests, so set it off there. `mode: s3only` writes only the bucket; `mode: mirror` also writes the same bytes to `<localRoot>/<session>/<inbox|outbox>/<name>` on the host, before the upload. Storage runs in a background queue: neither the inbound message nor the delivery waits for it, at most `uploadConcurrency` files (default 2) upload at a time, and a file larger than `partSize` (default 8 MiB, at least 5 MiB) goes up as a multipart upload with `partConcurrency` parts (default 4) in flight. A failed upload is logged and not retried; on unload the queue gets `attachmentTimeoutMs` to finish before the rest is abandoned, which mirror mode still holds locally. A file stored moments ago may not be listed yet. With `resumeConversations` off, the Session id is random per process, so a restarted bot stores a conversation under a new prefix.

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
- Logins, homes and their contents live in the container's writable layer: recreating the container drops them, and a deployment that needs them to survive has to mount that path.

<a id="dev-note"></a>
### Dev Note

See the [decision record](../../../.agents/notes/implemented/feature/2026-09-12-wecom-owned-conversations.md).
