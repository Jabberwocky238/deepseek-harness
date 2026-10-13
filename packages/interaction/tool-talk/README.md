---
description: "Model-facing talk and talk_peers tools: one Session of a deployment messages another, which reads the message before its next step or starts a turn for it and answers only with talk."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-talk

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-talk` lets the Sessions of one deployment message each other, as Claude Code teammates do. `talk_peers` lists the addresses the caller can reach, and `talk` sends one message to an address. The target reads it before its next step, or starts a turn of its own when idle, sees which Session sent it, and answers only with `talk`: its ordinary reply text reaches neither the sender nor any chat. The package defines the `talk` service the tools call; a host provides it. In a conversation-scoped WeCom bot, `dsh-wecom` provides it and the addresses are the conversations' container logins, such as `qingang0003`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that provides `tools` and a `talk` service. Without a `talk` provider it registers nothing.

| Field | Default | Meaning |
|---|---|---|
| `maxMessageChars` | `20000` | Longest message one `talk` call carries |

A host implements `TalkDirectory`: `peers(caller)` lists reachable addresses with the caller marked `self`, and `send(caller, address, text)` delivers one message and reports `queued` when the target was running or `woken` when the message started a turn. Hosts build the delivered input with `createTalkMessage`, so every target sees the same wording and the source `{ kind: 'talk-message', form: 'relay', senderSessionId, senderAddress }` in its Session log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tools resolve the caller from the executing Agent and pass its Session id to the service; the model never names itself. Delivery belongs to the host because only the host owns the target's Agent: it may have to resume it, and it decides that a woken turn's reply goes to no chat. The delivered input is an ordinary user-role message steered into the target, so it is in the target's Session log like any other input.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and delivered messages

#### What the model sees

The model sees the [`talk` and `talk_peers` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-talk). `talk_peers` takes no arguments and returns `{"peers":[{"address","self"}]}`. `talk` takes `to` and `message` and returns `{"address","delivery"}`; an unknown address, the caller's own address, an empty or oversized message, or a target that refuses more messages fails with an error result naming the problem. The target receives two text blocks: `Message from Session <sender> (sent with talk). Your ordinary reply is not delivered to it; answer with talk to <sender> if a reply is needed.` followed by the message.

#### Token effect

The two definitions are a fixed per-request cost while the tools are visible. Each call adds its arguments and a small result to the sender; each delivery adds the header line and the message to the target, and a woken target pays for the turn it runs.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged. A delivery appends a user message to the target's history without replacing earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the tools do not do. They are current constraints, not a task backlog.

- **A host must provide `talk`.** The package defines the service and the message wording only; reachability, resumption and refusal are the host's.
- **Text only.** A message carries no attachments; files travel through the target's own tools.
- **No reply is awaited.** `talk` returns once the message is delivered, and an answer, if any, arrives later as a `talk` message of its own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
