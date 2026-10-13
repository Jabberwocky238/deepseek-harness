---
description: "面向模型的 talk 与 talk_peers 工具：部署内的一个会话给另一个会话发消息，对方在下一步之前读到或为它开一轮，并且只能用 talk 回复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-talk

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-talk` 让同一部署内的会话互相发消息，效果类似 Claude Code 的队友消息。`talk_peers` 列出调用方能联系到的地址，`talk` 给某个地址发一条消息。对方在下一步之前读到这条消息，空闲时则为它开一轮，并能看到是哪个会话发来的；它只能用 `talk` 回复，普通回复文字既不会送到发送方，也不会发到任何聊天。本包定义工具所调用的 `talk` 服务，由宿主提供。在按会话建号的企微 bot 里，由 `dsh-wecom` 提供，地址就是各会话的容器登录名，例如 `qingang0003`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 `tools` 与 `talk` 服务的 profile 里挂载本插件。没有 `talk` 提供方时它什么都不注册。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMessageChars` | `20000` | 一次 `talk` 调用最多携带的字符数 |

宿主实现 `TalkDirectory`：`peers(caller)` 列出可联系的地址并把调用方标为 `self`；`send(caller, address, text)` 投递一条消息，目标正在运行时报告 `queued`，消息开启了一轮时报告 `woken`。宿主用 `createTalkMessage` 构造投递内容，因此每个目标看到的措辞一致，并在其会话日志里记下来源 `{ kind: 'talk-message', form: 'relay', senderSessionId, senderAddress }`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具从执行中的 Agent 得到调用方，把它的 Session id 交给服务；模型不会自报身份。投递归宿主负责，因为只有宿主拥有目标的 Agent：它可能需要先恢复目标，并决定被唤醒那一轮的回复不发往任何聊天。投递内容是一条普通的 user 角色消息，以 steer 送进目标，所以它和其它输入一样记在目标的会话日志里。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与投递的消息

#### 模型看到什么

模型看到 [`talk` 与 `talk_peers` 的 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-talk)。`talk_peers` 没有参数，返回 `{"peers":[{"address","self"}]}`。`talk` 接收 `to` 与 `message`，返回 `{"address","delivery"}`；地址不存在、发给自己、消息为空或过长、目标拒收时，返回写明原因的错误结果。目标收到两段文本：`Message from Session <sender> (sent with talk). Your ordinary reply is not delivered to it; answer with talk to <sender> if a reply is needed.`，后面是消息本身。

#### Token 影响

工具可见时，两个定义是每次请求的固定开销。每次调用给发送方增加参数和一个很小的结果；每次投递给目标增加那行说明和消息本身，被唤醒的目标还要承担它这一轮的开销。

#### KV Cache 影响

定义及其可见性不变时前缀稳定。投递只在目标历史末尾追加一条 user 消息，不替换此前的消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明工具不做什么。它们是当前的约束，不是待办清单。

- **必须由宿主提供 `talk`。** 本包只定义服务和消息措辞；可达范围、恢复目标与拒收都归宿主。
- **只有文本。** 消息不带附件；文件通过目标自己的工具传递。
- **不等待回复。** `talk` 在消息投递后即返回，回复（如果有）之后以另一条 `talk` 消息到达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
