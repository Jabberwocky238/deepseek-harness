---
kind: upgrade-guide
description: "The SQL session-manager backend moves from `@deepseek-ai/dsh-session-manager-adapter-sql` into `@deepseek-ai/dsh-session-manager`, its class is renamed, and it now requires a mounted `credentials` service."
---

# Session-manager SQL backend: package merge and rename

English | [中文](guide.zh.md)

## Change

This affects deployments that mount the session interaction store and TypeScript code that imports it.

- The package `@deepseek-ai/dsh-session-manager-adapter-sql` is removed. Its backend is now the default export of `@deepseek-ai/dsh-session-manager`, which also gained a `postgres` driver.
- The class `SqliteSessionManager` is renamed `SqlSessionManager`.
- The backend now waits for both `sessions` and `credentials` before it activates. A composition without a `credentials` provider leaves the row pending instead of activating it.
- Existing configuration keys keep their meaning; `driver` defaults to `sqlite`, so an unchanged `path` row opens the same database file. The SQLite schema version is unchanged.

## Migration

1. In `cordis.yml`, change the session-manager row's `name` from `@deepseek-ai/dsh-session-manager-adapter-sql` to `@deepseek-ai/dsh-session-manager`, and install that package in the profile instead of the removed one.
2. Replace imports of `SqliteSessionManager` from `@deepseek-ai/dsh-session-manager-adapter-sql` with `SqlSessionManager` from `@deepseek-ai/dsh-session-manager`.
3. Mount a `credentials` provider in custom compositions that lack one; the shipped `dsh-base` bundle already mounts it.
4. To move to PostgreSQL, set `driver: postgres` and `postgres.connectionStringEnv` to a credential holding `postgres://user:password@host:port/database`, optionally with `postgres.schema`. Each flush backfills a session's events from its canonical log; remove `restoreSessions` entries whose history exists only in the old SQLite file, or copy those rows first.
5. Confirm: restart, check the startup log has no `session-manager` entry that did not activate, and query `session_interaction` after one turn.
