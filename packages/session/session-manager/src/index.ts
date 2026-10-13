/**
 * Session interaction recording for the DeepSeek Harness: the session-manager
 * capability and its SQL storage backend.
 *
 * The capture side — which session events carry an interaction, how each
 * becomes a record, and the handoff to storage — lives in
 * {@link SessionManagerCoordinator} and the record vocabulary. The default
 * export, {@link SqlSessionManager}, is the `ctx.sessionManager` service that
 * stores those records in SQLite (`adaptors/sqlite`) or PostgreSQL
 * (`adaptors/psql`).
 *
 * @module @deepseek-ai/dsh-session-manager
 */

import { SqlSessionManager } from './sql.ts'

export {
  SessionManagerBackend,
  type SessionInteractionLog,
  type SessionInteractionQuery,
  type SessionManagerSink,
} from './backend.ts'
export { SessionManagerCoordinator } from './coordinator.ts'
export {
  eventRecord,
  headerRecord,
  mapSessionEvent,
  type SessionInteractionKind,
  type SessionInteractionRecord,
} from './records.ts'
export { SqlSessionManager, type Config } from './sql.ts'
export {
  SESSION_MANAGER_SQL_APPLICATION_ID,
  SESSION_MANAGER_SQL_SCHEMA_VERSION,
  type JournalMode,
} from './adaptors/sqlite/schema.ts'

export default SqlSessionManager
