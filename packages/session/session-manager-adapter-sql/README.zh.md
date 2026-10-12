---
description: "会话交互 seam 随包发布的 SQLite 后端：一条交互记录一行，并可选地从已存事件精确重建丢失的会话日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-manager-adapter-sql

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-session-manager-adapter-sql` 把 [session-manager seam](../session-manager/README.zh.md) 采集到的交互记录存进一张以 `(session_id, seq, ordinal)` 为键的 SQLite 表，所以重复收到的批次只会更新原有的行而不会写重。它在构造函数里组合 seam 的 coordinator，也就是说后端只拥有存储。除了记录，它还能在启动时用已存事件重建一份规范会话日志，并在每次会话 flush 时把表与那份日志对账，于是实时事件总线带不到的事件同样会落进表里。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在提供 Sessions 的 profile 里挂载这个插件，它注册 `ctx.sessionManager`。

```yaml
- id: session-manager
  name: '@deepseek-ai/dsh-session-manager-adapter-sql'
  config:
    path: !!js dshHomePath('interactions.sqlite')
    restoreSessions:
      - wecom-…
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | SQLite 数据库文件，或 `:memory:` 表示临时存储 |
| `openAt` | `startup` | 在激活时打开；填 `never` 则推迟到第一条记录时打开 |
| `journalMode` | `wal` | SQLite journal 模式；`:memory:` 会忽略它 |
| `restoreSessions` | `[]` | 激活时要重建的会话 id，早于任何 Agent 恢复它们 |

### 还原日志已丢失的会话

`restoreSessions` 用来在规范日志已经不在之后把会话找回来——迁移过来的对话、被清掉的日志目录、灾后重建。激活时每个列出的 id 都通过 `readSession` 读回，再经已挂载的 session persistence 后端追加到一份新日志里，于是这段对话恢复得像从未离开过。这个选项要求已挂载持久化后端，缺了会直接报错；某个 id 没有已存 header 也会直接报错，而不是还原出一个残片。日志仍在的会话由持久化后端报告并跳过，所以一条过期的 `restoreSessions` 条目不会造成破坏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 后端本体：record、read、readSession、reconcile、restore 与 shutdown |
| [`src/schema.ts`](src/schema.ts) | 打开数据库、表结构与迁移账本 |

### 一张表，两种行

`session_interaction` 装着全部记录，外加每个会话一行 header，用 `kind` 区分：`session-header` 行以 `ordinal = -1` 写入，header JSON 放在 `body`；其余行把记录的载荷放在 `body`、把原始来源事件放在 `event`。只有带 `event` 的行参与重建，这正是 `readSession` 能精确的原因——记录里规整过的 `body` 会丢掉规范日志需要的字段，例如助手消息带时序的 stream 和它的 surface 元数据。

`ordinal = -1` 也是 header 能和该会话第一条事件共用同一个 `seq` 而不冲突的原因。

### 对账

实时事件总线并不携带每一个已存事件：恢复会话时追加的 `session/end-seed` 就在总线之外。因此每次 `session/flush` 都会让表与规范日志对账，从表里没有事件的最小序号开始，把采集看不到的写进去。采集已经写过的记录会被跳过而不是覆盖，所以对账不会让内容更丰富的交互行降级。

### 表版本

`SCHEMA_VERSION` 单调递增，`schema_migrations` 账本记录每一步；随包发布的版本加上了重建所依赖的原始事件列。已有的库会就地迁移。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

在决定交互记录存哪里、或要接一次恢复时读这几页。

- [Session manager](../session-manager/README.zh.md) —— 本后端实现的 seam。
- [会话持久化](../session-persistence/README.zh.md) —— 对账要读、恢复要写的规范日志。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该后端只存储并读回 seam 交给它的记录；它不注册任何提示词、工具或结果。

#### KV Cache 影响

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了这个后端不合适用在什么地方。它们是当前的约束，不是待办清单。

- **一次恢复只写还没有日志的会话。** 重建已有日志会被持久化后端明确拒绝，所以要把会话往前接，得先删掉它的日志。
- **`restoreSessions` 只在激活时生效。** 没有运行时重建会话的操作；改这张列表需要重启。
- **行永远不会被清理。** 没有任何记录会过期，也没有任何整理数据库的机制，所以长期运行的部署会让文件无限增长。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
