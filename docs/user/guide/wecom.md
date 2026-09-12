---
description: "Connect an Enterprise WeChat intelligent bot to DSH conversations with text, images, and files."
---

# Chat from WeCom

English | [中文](wecom.zh.md)

Use an intelligent bot configured for API long connections. This integration needs its bot ID and secret, a working DSH Web profile with a selected model, and a choice of who may send tasks. The [WeCom SDK documentation](https://github.com/WecomTeam/aibot-node-sdk) describes bot credentials and supported transport operations.

The source checkout includes an [optional overlay](../../../apps/cli/config/examples/wecom/cordis.yml). An optional `WECOM_WS_URL` selects a custom endpoint. Set `WECOM_ALLOWED_USERS` to `*` to allow everyone who can reach the bot, or to comma-separated exact user IDs. It reads `WECOM_BOT_ID` and `WECOM_ALLOWED_USERS` from the process environment, resolves `WECOM_BOT_SECRET` through the credential service, and uses the current working directory. Keep the secret in the credential provider or a local environment file.

After building the checkout and setting those variables, launch the Web profile with this overlay:

```sh
pnpm dsh web --patch ./apps/cli/config/examples/wecom/cordis.yml --no-open
```

To run a second bot in the same process, set `WECOM_BOT_2_ID` and `WECOM_BOT_2_SECRET`, then add the [second-bot overlay](../../../apps/cli/config/examples/wecom/second-bot.cordis.yml). Both bots use `WECOM_ALLOWED_USERS`, with separate conversation histories:

```sh
pnpm dsh web --patch ./apps/cli/config/examples/wecom/cordis.yml --patch ./apps/cli/config/examples/wecom/second-bot.cordis.yml --no-open
```

The overlays also enable `im_context` for private identity and contact discovery and `talk` for sending text, images, and files to the current chat. Ask the bot to call `im_context` to inspect its identity, or to use `talk` to send a message. These identities do not expose other users’ chats. To make selected bots mutual contacts, configure the same `imBotContacts` list of bot IDs and names on both rows. The list must include each row’s own bot. After messaging both bots as the same user, ask each to call `im_context`; its contacts include the other Agent and its conversations include their shared private chat. [IM configuration and delivery limits](../../../packages/interaction/wecom/README.md#use-this-package) apply.

The bot uses the `standard` Agent preset and `workspace-write` permission preset. It has no WeCom approval interface, so operations requiring approval depend on the composed answerers. Choose the workspace and allowed users before connecting.

Send text, an image, or a file in a direct conversation, or invoke the bot in a group. Mixed text and images retain their order. Image understanding requires a vision-capable model; files are saved for the Agent’s file tools, and follow-up text can specify what to do with them. The bot first shows a processing status, updates the same reply as text is generated, and ends it when Agent activity settles. Follow-up text retains context while the plugin runs; each group member has separate history. A plugin reload starts fresh conversations.

Local tests use a loopback WeCom server and scripted model. Verify live authentication and message delivery with your deployment credentials. See the [package reference](../../../packages/interaction/wecom/README.md) for admission limits, deduplication, and failure semantics.
