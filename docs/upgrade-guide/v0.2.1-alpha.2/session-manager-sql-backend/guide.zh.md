---
kind: upgrade-guide
description: "SQL 会话记录后端从 `@deepseek-ai/dsh-session-manager-adapter-sql` 并入 `@jabberwocky238/dsh-session-manager`，类改名，并且现在要求已挂载 `credentials` 服务。"
---

# Session-manager SQL 后端：包合并与改名

[English](guide.md) | 中文

## 变更

影响挂载会话交互存储的部署，以及导入它的 TypeScript 代码。

- 删除 `@deepseek-ai/dsh-session-manager-adapter-sql` 包。它的后端现在是 `@jabberwocky238/dsh-session-manager` 的默认导出，并新增了 `postgres` driver。
- 类 `SqliteSessionManager` 改名为 `SqlSessionManager`。
- 后端现在要等 `sessions` 和 `credentials` 都挂载后才激活。没有 `credentials` provider 的组合会让这一行停在 pending，而不是激活。
- 原有配置键含义不变；`driver` 默认为 `sqlite`，因此不改的 `path` 行仍打开同一个数据库文件。SQLite 的 schema 版本不变。

## 迁移

1. 在 `cordis.yml` 里把 session-manager 行的 `name` 从 `@deepseek-ai/dsh-session-manager-adapter-sql` 改为 `@jabberwocky238/dsh-session-manager`，并在 profile 里安装该包，替换被删除的包。
2. 把从 `@deepseek-ai/dsh-session-manager-adapter-sql` 导入的 `SqliteSessionManager` 换成从 `@jabberwocky238/dsh-session-manager` 导入的 `SqlSessionManager`。
3. 自定义组合若没有 `credentials` provider，需要挂载一个；随发布的 `dsh-base` bundle 已经挂载。
4. 要改用 PostgreSQL，设置 `driver: postgres`，并把 `postgres.connectionStringEnv` 设为存放 `postgres://user:password@host:port/database` 的凭据，可选设置 `postgres.schema`。每次 flush 会从规范日志补齐该会话的事件；历史只存在于旧 SQLite 文件里的 `restoreSessions` 条目要删掉，或先把那些行复制过去。
5. 确认：重启后启动日志里没有未激活的 `session-manager`，跑完一轮后查询 `session_interaction` 有数据。
