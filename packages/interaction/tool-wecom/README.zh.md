---
description: "面向模型的企微文件工具：sendfile 把 Agent 自己文件系统里的附件投递到调用它的那个 Session 所在的会话，syncbox 列出、检查并取回该 Session 已存的文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-wecom

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-wecom` 注册 `sendfile`，把 Agent 自己文件系统里的附件投递到调用它的那个 Session 所在的企微会话。它只带附件：人们读的是普通回复正文，多一条文本通道只会把正文说两遍。会话不是由模型指定的——投递 seam 从 Session 解析目标——所以一次调用无法发往机器人没有连接的会话。机器人存储文件时，`syncbox` 列出、检查并取回该 Session 已存的 inbox 与 outbox。与企微机器人和文件系统提供方一起挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 `tools`、企微连接和文件系统提供方的 profile 里挂载本插件。它注册 `sendfile`，机器人存储文件时还注册 `syncbox`；没有配置字段。

```json
{"files":[{"path":"report.pdf","kind":"file"},{"path":"chart.png","kind":"image","media_type":"image/png"}]}
```

每一项给出一个由文件系统提供方解析的路径——相对路径以该 Session 的工作目录为基准——以及会话应当按哪种类型处理。图片还必须给 `media_type`。附件按给定顺序到达，名字取路径的最后一段。

一次调用最多发布 20 个附件、合计 20 MiB，所以更大的批次要分几次调用。结果报告发布了多少个附件。

当企微插件启用 `fileStore` 时，本包还会为调用方 Session 的已存文件注册 `syncbox`。`list` 返回 `inbox` 或 `outbox` 里的每个文件及其大小，`exists` 把给定文件名分成存在与缺失两组；两者都只读对象元数据。`pull` 把文件复制到 `<工作目录>/<box>/`：给定的文件名，或该目录里还没有的所有已存文件，已存在的跳过；20 MiB 的预算在下载前就按列出的大小检查。`sendfile` 投递的每个附件也会存进 outbox。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

这个工具只负责一次转换：文件系统的字节进，已发布的附件出。它先经 `ctx.fs` 读完所有请求的文件，再发布其中的任何一个，所以中途失败的调用什么都不会发出去；读完的字节交给 `ctx.wecom.send`，由它解析该 Session 所属的会话。机器人不拥有的 Session 没有投递目标，调用会失败，而不是凭空造一个。

返回的对象只带已发布的数量。投递 seam 报告的内容比模型需要的多，把那个对象直接返回会在附件已经发进会话之后违反结果的 `additionalProperties: false`：调用被读成失败，模型于是重试，每试一次就把同一个文件重发一次。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与投递结果

#### 模型看到的内容

模型看到的是 [`sendfile` 的 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-wecom)：必填的 `files` 数组，元素形如 `{ path, kind }`，`kind` 取 `file` 或 `image`，是图片时还必须给 `media_type`（`image/png`、`image/jpeg`、`image/webp` 或 `image/gif`）。它的描述要求发送文档、表格、演示、PDF 和图片，并说明正文由普通回复承载。成功的调用追加一条工具结果，内容为 `{"files":<数量>}`；图片没给媒体类型、列表为空、或路径文件系统提供方读不了时，调用以失败结果结束，其文本点明问题所在。

#### Token 影响

工具可见期间，工具定义是每请求的固定开销。每次调用累加它的参数和一个单字段结果，投递本身不再改动对话。

#### KV 缓存影响

定义及其可见性不变时前缀稳定。调用追加普通的调用与结果历史，不替换已有消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明这个工具不做什么。它们是当前的约束，不是待办清单。

- **只送附件。** 按设计没有文本参数：多一条文本通道会把人们已经在读的正文说两遍。
- **三个服务必须在位。** 缺了 `tools`、`wecom`、`fs` 中任何一个，插件根本不会注册工具。
- **一次调用最多 20 个附件、合计 20 MiB。** 更大的投递要分几次调用，每次调用都各自计入参数和结果。
- **路径的含义由文件系统提供方决定。** 在远程部署里那个提供方是容器的文件系统，不是宿主机的，所以运维在宿主机上看到的路径，Agent 未必解析得到。
- **结果是已发布的数量，不是逐收件人投递。** 工具只报告会话接受了多少附件，不说明谁读过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
