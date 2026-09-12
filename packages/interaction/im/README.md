---
description: "Native messaging and private identity discovery for humans and AI participants."
kind: "package-reference"
---

# @deepseek-ai/dsh-im

English | [中文](README.zh.md)

## Summary

Store native IM identities, contacts, conversations, messages, and pending deliveries. A bound Agent can discover its identity and relationships and send messages through permission-checked tools. Native IM records remain separate from WeCom chats.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The host manages participants, contacts, groups, and AI communication grants through `ctx.im`. `attachAgent` binds one AI identity across its conversations to an existing Agent; its tools belong to `agent.ctx` and disappear when detached or disposed. The runtime entry owns creation and resumption of these Agents.

Call `im_context` with `{}` to discover `self`, `page`, `unread`, `contacts`, and `conversations`. Participant entries contain an ID, name, human/AI kind, and namespace. Conversations contain an ID, name, direct/group kind, and member identities. Each call reads current durable records for the bound identity; callers cannot supply another identity. Contact IDs are native IM addresses, not telephone numbers or external platform credentials.

Contacts are mutual communication authorization. Adding or removing a contact changes both participants' lists and private messaging permission. The grant, update, and revoke interfaces operate on this same relationship; there is no direction field. Group membership permits messages within that group without a contact relationship. Removing a contact does not leave groups, and leaving a group does not remove contacts.

Use `im_context({page: {kind: "group", id: "group-id"}})` or a `contact` page with its participant ID to open a page. `im_context({page: {kind: "none"}})` leaves all pages. The selection persists per AI. Content on the current page is queued before the next unstarted tool, even for an interrupt-marked message; other chats supply coalesced sender/count notifications without text or attachments. Notifications do not acknowledge unread content. Opening a page admits its unread messages. Explicit interrupt delivery outside the selected page can cancel active work while retaining unread messages.

`talk` sends to the selected page or an explicitly named joined conversation. All group members receive the message. Ordinary assistant text remains private, so ignoring a notification does not post a group reply.

<a id="model-experience"></a>
## Model Experience

### IM discovery and communication

#### What the model sees

Bound Agents receive `im_context` and `talk` schemas; sender/count notifications and selected-page messages are logged inputs. Discovery returns JSON text through the ordinary logged tool result; the next model request includes that result. The generic tool presentation exposes the same returned text to people viewing the Session. No private contact list is inserted into an unrelated Agent's prompt.

#### Token effect

Tool schemas and returned identities consume context tokens. Discovery includes the full contact and joined-conversation lists, bounded by the configured participant and conversation limits.

#### KV Cache effect

Discovery appends a tool result to the Session; it does not rewrite earlier messages or add a system prompt. Attaching tools changes the Agent's available schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The optional IM Web overlay and panel require assembled-browser validation. Contact membership does not expose external platform addresses. Package tests cover rendered output and scripted-model logging; shipped-profile recorded Session replay and exhaustive runtime recovery coverage remain outstanding.

<a id="dev-note"></a>
### Dev Note

The [Agent-bound discovery decision](../../../.agents/notes/implemented/feature/2026-09-12-im-agent-discovery.md) owns identity selection and visibility. No invariant companion is published for discovery: results read the durable IM service directly without maintaining a second relationship projection.
