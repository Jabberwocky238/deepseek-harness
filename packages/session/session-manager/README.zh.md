---
description: "会话交互记录的采集 seam：把已提交的 Session 事件变成可检索的交互记录，并交给存储后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-manager

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-session-manager` 定义什么是会话交互记录、哪些已提交事件会产生记录、以及后端如何收到它们。一个事件产生零条或多条记录：助手每段思考各成一条记录，每次工具调用和工具结果各成一条，分别带着模型自己产出的参数和工具面向模型的输出。后端只实现 `record`、`read`、`readSession` 和 `shutdown`；采集、批处理和记录词汇由 seam 拥有，连接、表结构、落库批处理与保留策略由后端拥有。本包还以默认导出提供 `SqlSessionManager`，它把每条记录在 SQLite 或 PostgreSQL 里存成一行。

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

挂载一个后端即可，它自己注册为 `ctx.sessionManager`——每个上下文只允许一个实现，重复注册会被 cordis 拒绝，这与其它服务键一致。后端是 `SessionManagerBackend` 的子类，在构造函数里组合一个 `SessionManagerCoordinator`，由后者订阅 `session/event` 并把采集监听器装在后端的 fiber 上。组合里的其它部分都不用改：coordinator 观察的正是 Agent loop 已经提交的那些事件。

消费者通过服务读回交互记录：

```ts
const records = await ctx.sessionManager.read({ sessionId, kinds: ['thinking'], limit: 50 })
const log = await ctx.sessionManager.readSession(sessionId)   // header plus every stored event
```

`read` 回答关于某个会话已记录历史的问题，可按 kind、`source.kind` 和起始序号过滤。`readSession` 返回的已存 header 和事件完整到足以重建规范日志，因此像 session persistence 这样的消费者可以还原一个日志已经丢失的会话。

### 记录标识意味着什么

`(sessionId, seq, ordinal)` 是一条记录的标识。同一个事件被交给后端两次——重新接管的会话、重试的批次——必须写成同样的行而不是重复行，所以每个后端都要把 `record` 当成 upsert。

### 挂载 SQL 后端

`SqlSessionManager` 在 `driver` 选定的引擎上维护一张 `session_interaction` 表。它在 `sessions` 和 `credentials` 都挂载后才激活；PostgreSQL 通过 `credentials` 读取连接串，因此密钥不进 `cordis.yml`：

```yaml
- id: session-manager
  name: '@deepseek-ai/dsh-session-manager'
  config:
    driver: postgres
    postgres:
      connectionStringEnv: SESSION_MANAGER_PG_URL   # postgres://user:password@host:port/database
      schema: dsh_sessions
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `driver` | `sqlite` | `sqlite` 或 `postgres` |
| `path` | `sqlite` 时必填 | SQLite 数据库文件，或 `:memory:` 表示临时存储 |
| `journalMode` | `wal` | SQLite 日志模式；`:memory:` 忽略它 |
| `postgres.connectionStringEnv` | `postgres` 时必填 | 存放连接串的凭据引用 |
| `postgres.schema` | `public` | 存放表及其 `schema_migrations` 账本的 schema；不存在时自动创建 |
| `postgres.maxConnections` | `4` | 连接池大小 |
| `openAt` | `startup` | 激活时打开，或 `never` 表示首次写入时才打开 |
| `restoreSessions` | `[]` | 激活时要从存储重建的会话 id |

两种引擎执行同一套单调递增的迁移；PostgreSQL 在 advisory lock 下执行，所以多个进程可以共用一个 schema。由更新版本写过的存储会被拒绝。每次 `session/flush` 都会拿规范日志对账，因此采集漏掉的事件、以及后端挂载之前就已开始的会话，都会从日志补齐。`restoreSessions` 通过已挂载的持久化后端重建所列会话的日志；没有已存 header 的 id 会直接报错，仍有日志的会话会被报告并跳过。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个后端一个 coordinator，而且刻意不派生分支：处理发生在发出事件的 fiber 上，缓冲放在 coordinator 自己的数组里，没有任何东西等着 Agent loop 必须等才能结束回合的 promise。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/backend.ts`](src/backend.ts) | `SessionManagerBackend`、`SessionManagerSink`、查询与日志类型，以及 `ctx.sessionManager` 注册 |
| [`src/records.ts`](src/records.ts) | 记录词汇与会话事件映射 |
| [`src/coordinator.ts`](src/coordinator.ts) | 采集、缓冲、串行写入与销毁 |
| [`src/index.ts`](src/index.ts) | 默认导出 `SqlSessionManager`：配置、对账、恢复与关闭；并重新导出 seam |
| [`src/store.ts`](src/store.ts) | 与引擎无关的 `InteractionStore`，以及共用的列与查询映射 |
| [`src/adaptors/sqlite/`](src/adaptors/sqlite/) | 基于 `node:sqlite` 的 SQLite 表结构、迁移与存储 |
| [`src/adaptors/psql/`](src/adaptors/psql/) | 基于 `pg` 的 PostgreSQL 表结构、迁移与存储，仅在 `postgres` driver 下加载 |

### 批处理与失败隔离

一个追加事件通常产生多条记录——一条带思考块的消息，或一次工具调用连同它的结果。coordinator 把它们缓冲起来，在下一个微任务里整批交给后端，于是一个事件作为一批到达存储，而 coordinator 不需要持有定时器。写入彼此串行，这正是批次保持追加顺序的原因。

每个处理函数都自成一体，因为 cordis 的 `emit` 一旦抛错就停止：失败的后端既不能饿死其它 `session/event` 订阅者，也不能波及 Agent loop。被拒绝或无法映射的批次会被记录日志后丢弃，coordinator 不重试。`(sessionId, seq, ordinal)` 这组标识让后端或后续的读者可以从规范日志里补上这段空缺。

### 销毁

销毁会先排空缓冲，再等待后端的 `shutdown`；这里失败只记警告而不抛出，因为记录不该让应用退出失败。销毁之后再来的事件不会再追加任何东西。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

在选择存储、或把恢复出来的历史接回会话时读这几页。

- [会话持久化](../session-persistence/README.zh.md) —— seam 读取、且 `readSession` 要重建的那份规范日志。
- [Session](../../core/session/README.zh.md) —— 本 seam 观察的事件流。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 seam 只观察会话事件流并把记录交给存储后端；它不注册任何提示词、工具或结果。

#### KV Cache 影响

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了 seam 不承诺什么。它们是当前的约束，不是待办清单。

- **采集按设计就是尽力而为。** 后端失败只记日志、不重试，Agent loop 里也没有任何环节等存储。要求一条不落落的部署得自己拿规范日志对账。
- **挂不挂后端是部署的决定。** 没有挂载后端就没有 `ctx.sessionManager`，也不会发生采集。
- **`readSession` 只能重建后端存下来的东西。** 当存储从未采集到该会话的 header（后端在会话开始之后才挂上）时它返回不了任何内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
