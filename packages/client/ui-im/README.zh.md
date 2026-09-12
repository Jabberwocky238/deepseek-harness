---
description: "面向人的原生 IM 联系人、聊天、群和附件界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-im

[English](README.md) | 中文

## 概述

查看联系人、打开私聊、创建和管理群，并查看人或 AI 参与者发送的文字、图片和文件。面板绑定到 profile 的本地人类身份；Agent 的页面选择独立于此浏览器视图。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

可选的 [IM 配置](../../../apps/cli/config/examples/im/cordis.yml)在 Web profile 中启用 IM 服务、Agent 运行时和面板。查看者身份、轮询间隔和会话上限均为显式配置。[IM](../../interaction/im/README.zh.md)负责联系人权限和 Agent 的提醒及页面行为。

从联系人打开私聊，选择联系人创建群。群主可以修改群名、邀请联系人和移除成员，同时保留群主和至少两个成员。删除联系人保留聊天记录和群成员关系。通过可见消息下载文件，图片在消息内展示。获得配置间隔后，轮询在失败后重试；首次连接失败可以使用重试按钮。

## 模型体验

<a id="model-experience"></a>

### 人类消息

#### 模型看到什么

面板通过 IM 服务发送消息。绑定 Agent 的页面决定它收到正文还是发送者计数提醒。

#### Token 影响

导航和附件下载不会创建模型请求；IM 投递负责模型输入。

#### KV Cache 影响

浏览器导航不改变 Agent 的当前页面或模型历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 完整浏览器和录制 Session 验证尚未完成。面板代表一个本地 profile 所有者，不提供多用户登录。聊天记录按服务的存储上限整份读取。

<a id="dev-note"></a>
### 开发备注

宿主 Remote API 将每个请求绑定到配置的查看者，并在读取消息或附件前检查会话可见性。不发布 invariant 配套入口：面板读取权威 IM 服务，不维护另一份权威关系状态。
