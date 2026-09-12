---
description: "将企业微信智能机器人接入支持文本、图片和文件的 DSH 对话。"
---

# 通过企微对话

[English](wecom.md) | 中文

使用配置了 API 长连接模式的智能机器人。此集成需要机器人 ID、密钥、已选模型且可运行的 DSH Web profile，以及允许发送任务的用户范围。[企微 SDK 文档](https://github.com/WecomTeam/aibot-node-sdk)说明机器人凭据及传输操作。

源码检出包含[可选覆盖层](../../../apps/cli/config/examples/wecom/cordis.yml)。可选的 `WECOM_WS_URL` 可选择自定义端点。将 `WECOM_ALLOWED_USERS` 设为 `*` 可允许所有能访问机器人的用户，也可填写以逗号分隔的准确用户 ID。它从进程环境读取 `WECOM_BOT_ID` 和 `WECOM_ALLOWED_USERS`，通过凭据服务解析 `WECOM_BOT_SECRET`，并使用当前工作目录。请将密钥保存在凭据提供方或本地环境文件中。

构建源码并设置上述变量后，使用该覆盖层启动 Web profile：

```sh
pnpm dsh web --patch ./apps/cli/config/examples/wecom/cordis.yml --no-open
```

要在同一进程运行第二个机器人，请设置 `WECOM_BOT_2_ID` 和 `WECOM_BOT_2_SECRET`，再添加[第二个机器人覆盖层](../../../apps/cli/config/examples/wecom/second-bot.cordis.yml)。两个机器人共用 `WECOM_ALLOWED_USERS`，对话历史各自独立：

```sh
pnpm dsh web --patch ./apps/cli/config/examples/wecom/cordis.yml --patch ./apps/cli/config/examples/wecom/second-bot.cordis.yml --no-open
```

覆盖层还启用 `im_context`，用于查询自身身份和私有联系人，并启用 `talk`，用于向当前聊天发送文本、图片和文件。可让机器人调用 `im_context` 查看身份，或使用 `talk` 发送消息。这些身份不会暴露其他用户的聊天。要让指定机器人互为联系人，在两个条目上配置相同的 `imBotContacts` 列表，填写机器人 ID 和名称，且必须包含各条目自身的机器人。以同一用户向两个机器人发消息后，让它们分别调用 `im_context`；联系人中会包含对方 Agent，会话中会包含双方共享的私聊。接入受 [IM 配置和投递限制](../../../packages/interaction/wecom/README.zh.md#use-this-package)约束。

机器人使用 `standard` Agent 预设及 `workspace-write` 权限预设。它没有企微审批界面，需要审批的操作依赖组合中的应答器。连接前请确定工作目录及允许访问的用户。

在单聊中发送文本、图片或文件，或在群里调用机器人。图文混排保留原始顺序。图片理解需要支持视觉的模型；文件保存后可供 Agent 的文件工具读取，后续文本可说明如何处理文件。机器人先显示处理状态，随后在生成文本时更新同一条回复，并在 Agent 活动结束时完成回复。插件运行期间的后续文本保留上下文；每位群成员使用独立历史。插件重载后开启新对话。

本地测试使用回环企微服务器和脚本模型。请使用部署凭据验证真实认证和消息投递。接纳上限、去重及失败语义见[包参考](../../../packages/interaction/wecom/README.zh.md)。
