---
description: "为人类和 AI 参与者提供原生消息与私有身份查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-im

[English](README.md) | 中文

## 概述

存储原生 IM 身份、联系人、会话、消息和待投递记录。绑定的 Agent 可以查询自身身份和关系，并通过检查授权的工具发送消息。原生 IM 记录与 WeCom 聊天保持独立。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

宿主通过 `ctx.im` 管理参与者、联系人、群和 AI 通信授权。`attachAgent` 将一个 AI 身份及其所有会话绑定到现有 Agent；工具属于 `agent.ctx`，解绑或销毁后移除。runtime 入口负责创建和恢复这些 Agent。

以 `{}` 调用 `im_context`，查询 `self`、`page`、`unread`、`contacts` 和 `conversations`。参与者记录包含 ID、名称、人类或 AI 类型以及命名空间。会话包含 ID、名称、单聊或群聊类型以及成员身份。每次调用读取绑定身份对应的最新持久化记录；调用方不能指定其他身份。联系人 ID 是原生 IM 地址，不是电话号码或外部平台凭据。

联系人关系就是双向通信授权。添加或删除联系人同时改变双方列表和私聊权限。授权、修改和撤销接口操作同一份关系，不存在方向字段。同群成员可以在群内交流，无需成为联系人。删联系人不退群，退群也不删联系人。

调用 `im_context({page: {kind: "group", id: "group-id"}})` 或携带参与者 ID 的 `contact` 页面打开页面。`im_context({page: {kind: "none"}})` 离开全部页面。每个 AI 的页面选择独立持久化。当前页面的正文在下一次尚未启动的工具之前排队进入，即使消息带有打断标记；其他会话只提供合并后的发送者和数量提醒，不包含正文和附件。提醒不确认正文已读。打开页面后，其未读消息进入队列。当前页面之外的明确打断投递可以取消活动任务，但保留未读消息。

`talk` 向当前页面或明确指定的已加入会话发送消息。所有群成员都会收到群消息。普通 assistant 文本保持私有，因此忽略提醒不会自动向群里回复。

<a id="model-experience"></a>
## 模型体验

### IM 查询与通信

#### 模型看到什么

绑定的 Agent 获得 `im_context` 和 `talk` 工具定义；发送者计数提醒和当前页面消息都是持久化输入。查询通过普通的持久化工具结果返回 JSON 文本；下次模型请求包含该结果。通用工具展示向查看 Session 的人呈现同一份返回文本。其他 Agent 的提示词不会插入此私有联系人列表。

#### Token 影响

工具定义和返回的身份占用上下文 token。查询包含完整联系人及已加入会话列表，其大小受配置的参与者和会话数量上限约束。

#### KV Cache 影响

查询向 Session 追加工具结果，不改写此前消息或添加系统提示词。绑定工具会改变 Agent 可用的工具定义。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 联系人关系不暴露外部平台地址。包内测试覆盖展示输出和脚本模型日志；正式 profile 的录制 Session 回放和完整运行时恢复测试尚未完成。

<a id="dev-note"></a>
### 开发备注

[Agent 绑定查询决策](../../../.agents/notes/implemented/feature/2026-09-12-im-agent-discovery.zh.md)说明身份选择和可见性。查询不发布 invariant 配套入口：结果直接读取持久化 IM 服务，不维护另一份关系投影。
