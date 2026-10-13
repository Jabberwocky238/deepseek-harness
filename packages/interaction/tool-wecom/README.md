---
description: "Model-facing WeCom file tools: sendfile delivers attachments from the Agent's filesystem into the chat the calling Session answers in, and syncbox lists, checks and pulls the Session's stored files."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-wecom

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-wecom` registers `sendfile`, which delivers attachments from the Agent's own filesystem into the WeCom chat the calling Session answers in. It carries attachments only: the ordinary reply text is what the people read, so there is no text parameter to duplicate it. The model never names a conversation — the delivery seam resolves the target from the Session — so a call cannot address a chat the bot is not connected to. When the bot stores files, `syncbox` lists, checks and pulls the Session's stored inbox and outbox. Mount it beside a WeCom bot and a filesystem provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that provides `tools`, a WeCom connection, and a filesystem provider. It registers `sendfile`, plus `syncbox` when the bot stores files, and has no configuration fields.

```json
{"files":[{"path":"report.pdf","kind":"file"},{"path":"chart.png","kind":"image","media_type":"image/png"}]}
```

Each entry names a path the filesystem provider resolves — a relative path resolves against the Session's working directory — together with the kind the chat should treat it as. Images also require `media_type`. Attachments arrive in the order given, named by the path's last segment.

One call publishes at most 20 attachments within a 20 MiB budget, so a larger batch is several calls. The result reports how many attachments were published.

When the WeCom plugin enables `fileStore`, the package also registers `syncbox` for the calling Session's stored files. `list` returns every file in the `inbox` or `outbox` with its size, and `exists` splits given names into found and missing; both read object metadata only. `pull` copies files into `<working directory>/<box>/`: the names given, or every stored file that directory lacks, skipping files already present, within a 20 MiB budget checked against the listed sizes before any download. Each delivered `sendfile` attachment is also stored in the outbox.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool owns one translation: filesystem bytes in, published attachments out. It reads every requested file through `ctx.fs` before publishing any of them, so a call that fails partway delivers nothing, and it hands the collected bytes to `ctx.wecom.send`, which resolves the chat that owns the Session. A Session the bot does not own has no target, and the call fails rather than inventing one.

The returned object carries only the published count. The delivery seam reports more than the model needs, and returning that object would fail the result's `additionalProperties: false` after the attachments were already in the chat: the call would read as failed and the model would retry, re-delivering the same file on every attempt.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema and delivery result

#### What the model sees

The model sees the [`sendfile` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-wecom): a required `files` array of `{ path, kind }` entries, where `kind` is `file` or `image` and an image also requires `media_type` (`image/png`, `image/jpeg`, `image/webp`, or `image/gif`). Its description asks for documents, spreadsheets, presentations, PDFs, and images, and states that the ordinary reply carries the text. A successful call appends one tool result holding `{"files":<count>}`; a call that asks for an image without a media type, an empty list, or a path the filesystem provider cannot read fails with an error result whose text names the problem.

#### Token effect

The tool definition is a fixed per-request cost while the tool is visible. Each call adds its arguments and a one-field result, and delivery does not otherwise change the conversation.

#### KV Cache effect

Prefix-stable while the definition and its visibility are unchanged. A call appends ordinary call-and-result history without replacing earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the tool does not do. They are current constraints, not a task backlog.

- **Attachments only.** There is no text parameter, by design: a second text channel would duplicate the reply people already read.
- **Three services must be present.** Without `tools`, `wecom`, and `fs`, the plugin does not register a tool at all.
- **One call is capped at 20 attachments and 20 MiB.** A larger delivery is several calls, and each call is charged its own arguments and result.
- **The filesystem provider decides what a path means.** In a remote deployment that provider is the container's filesystem, not the host's, so a path an operator sees on the host may not resolve for the Agent.
- **The result is a published count, not per-recipient delivery.** The tool reports what the chat accepted, and says nothing about who read it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
