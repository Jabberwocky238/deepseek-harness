/**
 * SQLite storage backend for the session-manager capability.
 *
 * One table holds every recorded interaction, keyed by
 * `(session_id, seq, ordinal)` so a rehanded batch updates its rows instead of
 * duplicating them. Records arrive through the seam's coordinator, which this
 * backend composes in its constructor: the backend owns storage only.
 *
 * @module @deepseek-ai/dsh-session-manager-adapter-sql
 */

import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import {
  SessionManagerBackend,
  SessionManagerCoordinator,
  eventRecord,
  type SessionInteractionLog,
  type SessionInteractionQuery,
  type SessionInteractionRecord,
} from '@deepseek-ai/dsh-session-manager'
import { decodeRow, decodeRows, rowInteger, rowNullableInteger, rowNullableText, rowText } from './rows.ts'
import { type JournalMode, openInteractionDatabase } from './schema.ts'

export {
  SESSION_MANAGER_SQL_APPLICATION_ID,
  SESSION_MANAGER_SQL_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Backend configuration as authored in `cordis.yml`. */
export interface Config {
  /** SQLite database file, or `:memory:` for an ephemeral store. */
  path: string
  /** Open the database during activation (`startup`) or on the first record (`never`). */
  openAt?: 'startup' | 'never'
  /** SQLite journal mode; `:memory:` ignores it. */
  journalMode?: JournalMode
  /**
   * Session ids to rebuild from the store during activation, before any agent
   * can resume them. Use it to bring back a session whose canonical log was
   * lost. Requires a mounted session persistence backend.
   */
  restoreSessions?: string[]
}

/** Validated configuration with every default applied. */
interface ResolvedConfig {
  path: string
  openAt: 'startup' | 'never'
  journalMode: JournalMode
  restoreSessions: string[]
}

/** Statement text: one row per interaction, upserted on its identity. */
const INSERT_RECORD = `
  INSERT INTO session_interaction
    (session_id, seq, ordinal, time, turn, step, kind, source_kind, call_id, tool_name, text, body, event)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (session_id, seq, ordinal) DO UPDATE SET
    time = excluded.time,
    turn = excluded.turn,
    step = excluded.step,
    kind = excluded.kind,
    source_kind = excluded.source_kind,
    call_id = excluded.call_id,
    tool_name = excluded.tool_name,
    text = excluded.text,
    body = excluded.body,
    event = excluded.event
`

/**
 * Apply defaults to authored configuration.
 * @param config - configuration as validated by {@link SqliteSessionManager.Config}.
 * @returns the configuration with every optional field resolved.
 */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    restoreSessions: config.restoreSessions ?? [],
  }
}

/** SQLite owner of the `ctx.sessionManager` service. */
export class SqliteSessionManager extends SessionManagerBackend {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    restoreSessions: z.array(z.string()).default([]),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private opening: Promise<DatabaseSync> | undefined
  private closed = false
  /** Mounted session persistence, captured through an injection so it stays optional. */
  private persistence: SessionPersistence | undefined
  /** Injection fiber holding {@link persistence} for this service's lifetime. */
  private readonly persistenceFiber: Fiber

  /**
   * @param ctx - the context this service registers on.
   * @param config - database path, open timing, and journal mode.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    this.persistenceFiber = ctx.inject(['sessionPersistence'], (inner: Context) => {
      this.persistence = inner.sessionPersistence
      inner.effect(() => () => {
        this.persistence = undefined
      }, 'sessionManagerSql.persistenceBinding')
    })
    ctx.effect(() => () => this.persistenceFiber.dispose(), 'sessionManagerSql.optionalPersistence')
    // The live event bus does not carry every stored event (a resume appends
    // `session/end-seed` outside it), so each flush reconciles the store against
    // the canonical log and fills whatever capture could not see.
    ctx.on('session/flush', (session: Session) => {
      void this.reconcile(session).catch((error: unknown) => {
        this.ctx.logger.warn('session manager: reconciliation failed: %o', error)
      })
    })
    new SessionManagerCoordinator(ctx, this)
    ctx.effect(() => async () => this.shutdown(), 'sessionManagerSql.close')
  }

  /** Open the database during activation only when configuration asks for it. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this.handle()
    await this.restore()
  }

  /**
   * Open the store once and reuse the handle.
   * @returns the open database handle.
   */
  private handle(): Promise<DatabaseSync> {
    if (this.closed) return Promise.reject(new Error('session manager store is closed'))
    this.opening ??= openInteractionDatabase(this.config.path, this.config.journalMode)
    return this.opening
  }

  /** See {@link SessionManagerBackend.record} — that declaration is the contract's one home. */
  override async record(records: readonly SessionInteractionRecord[]): Promise<void> {
    if (records.length === 0) return
    const db = await this.handle()
    const insert = db.prepare(INSERT_RECORD)
    db.exec('BEGIN')
    try {
      for (const record of records) {
        insert.run(
          record.sessionId,
          record.seq,
          record.ordinal,
          record.time,
          record.turn ?? null,
          record.step ?? null,
          record.kind,
          record.sourceKind ?? null,
          record.callId ?? null,
          record.name ?? null,
          record.text ?? null,
          JSON.stringify(record.body),
          record.event ?? null,
        )
      }
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** See {@link SessionManagerBackend.read}. */
  override async read(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]> {
    const db = await this.handle()
    const where = ['session_id = ?']
    const values: (string | number)[] = [query.sessionId]
    if (query.sinceSeq !== undefined) {
      where.push('seq >= ?')
      values.push(query.sinceSeq)
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`)
      values.push(...query.kinds)
    }
    if (query.sourceKinds !== undefined && query.sourceKinds.length > 0) {
      where.push(`source_kind IN (${query.sourceKinds.map(() => '?').join(', ')})`)
      values.push(...query.sourceKinds)
    }
    let sql = `SELECT * FROM session_interaction WHERE ${where.join(' AND ')} ORDER BY seq, ordinal`
    if (query.limit !== undefined) {
      sql += ' LIMIT ?'
      values.push(query.limit)
    }
    return decodeRows(db.prepare(sql).all(...values), (row) => {
      const record: SessionInteractionRecord = {
        sessionId: SessionId(rowText(row, 'session_id')),
        seq: SessionSeq(rowInteger(row, 'seq')),
        ordinal: rowInteger(row, 'ordinal'),
        time: rowInteger(row, 'time'),
        kind: rowText(row, 'kind') as SessionInteractionRecord['kind'],
        body: JSON.parse(rowText(row, 'body')) as SessionInteractionRecord['body'],
      }
      const sourceKind = rowNullableText(row, 'source_kind')
      if (sourceKind !== null) record.sourceKind = sourceKind
      const turn = rowNullableInteger(row, 'turn')
      if (turn !== null) record.turn = turn
      const step = rowNullableInteger(row, 'step')
      if (step !== null) record.step = step
      const callId = rowNullableText(row, 'call_id')
      if (callId !== null) record.callId = callId
      const name = rowNullableText(row, 'tool_name')
      if (name !== null) record.name = name
      const text = rowNullableText(row, 'text')
      if (text !== null) record.text = text
      const event = rowNullableText(row, 'event')
      if (event !== null) record.event = event
      return record
    })
  }

  /**
   * Smallest sequence number this store has no event for, counting from zero.
   * @param sessionId - session to inspect.
   * @returns the first missing sequence number, or the next one after the tail.
   */
  private async firstMissingSeq(sessionId: SessionId): Promise<number> {
    const db = await this.handle()
    const missing = decodeRow(db.prepare(`
      SELECT MIN(candidate) AS missing FROM (
        SELECT 0 AS candidate
        UNION
        SELECT seq + 1 FROM session_interaction WHERE session_id = ?1 AND event IS NOT NULL
      ) WHERE candidate NOT IN (
        SELECT seq FROM session_interaction WHERE session_id = ?1 AND event IS NOT NULL
      )
    `).get(sessionId), row => rowNullableInteger(row, 'missing'))
    return missing ?? 0
  }

  /**
   * Fill the store from the canonical log, starting at the first sequence this
   * store lacks. Events already stored are skipped so a later reconciliation
   * never overwrites the interaction rows an earlier capture wrote.
   * @param session - the flushed session.
   */
  private async reconcile(session: Session): Promise<void> {
    const persistence = this.persistence
    if (persistence === undefined) return
    const from = await this.firstMissingSeq(session.id)
    const db = await this.handle()
    const known = new Set(
      decodeRows(
        db.prepare('SELECT seq FROM session_interaction WHERE session_id = ? AND event IS NOT NULL').all(session.id),
        row => rowInteger(row, 'seq'),
      ),
    )
    const handle = await persistence.open(session.id, 'read')
    try {
      const { events } = await handle.read(SessionLogOffset(from))
      const missing = events.filter(event => !known.has(event.seq))
      if (missing.length === 0) return
      await this.record(missing.map(event => eventRecord(session.id, event)))
    } finally {
      await handle.close()
    }
  }

  /** See {@link SessionManagerBackend.readSession}. */
  override async readSession(sessionId: SessionId): Promise<SessionInteractionLog | undefined> {
    const db = await this.handle()
    const header = decodeRow(db.prepare(
      `SELECT body FROM session_interaction
        WHERE session_id = ? AND kind = 'session-header' ORDER BY seq LIMIT 1`,
    ).get(sessionId), row => rowText(row, 'body'))
    if (header === undefined) return undefined
    const events = decodeRows(db.prepare(
      `SELECT event FROM session_interaction
        WHERE session_id = ? AND event IS NOT NULL ORDER BY seq, ordinal`,
    ).all(sessionId), row => rowText(row, 'event'))
    return {
      header: JSON.parse(header) as SessionInteractionLog['header'],
      events: events.map(event => JSON.parse(event) as SessionInteractionLog['events'][number]),
    }
  }

  /**
   * Rebuild each configured session's canonical log through the mounted
   * persistence backend, so the session can be resumed as if it never left.
   * A session with no stored header fails loud instead of restoring a fragment;
   * a session whose log already exists is reported and skipped by the backend.
   */
  private async restore(): Promise<void> {
    if (this.config.restoreSessions.length === 0) return
    const persistence = this.persistence
    if (persistence === undefined) {
      throw new Error('restoreSessions requires a mounted session persistence backend')
    }
    for (const raw of this.config.restoreSessions) {
      const log = await this.readSession(SessionId(raw))
      if (log === undefined) throw new Error(`no stored history for session ${raw}; cannot restore it`)
      try {
        const handle = await persistence.create(log.header)
        try {
          await handle.append([...log.events])
          await handle.flush()
        } finally {
          await handle.close()
        }
        this.ctx.logger.info('session manager: restored %d events for session %s', log.events.length, raw)
      } catch (error: unknown) {
        // A session that still has a log is left standing; every other refusal
        // is reported so an operator can see the restore did not happen.
        this.ctx.logger.warn('session manager: could not restore session %s: %o', raw, error)
      }
    }
  }

  /** See {@link SessionManagerBackend.shutdown}. */
  override async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const open = this.opening
    this.opening = undefined
    if (open === undefined) return
    const db = await open.catch(() => undefined)
    db?.close()
  }
}

export default SqliteSessionManager
