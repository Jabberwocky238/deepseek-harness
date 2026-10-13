/**
 * SQL storage backend for the session-manager capability, on SQLite or
 * PostgreSQL.
 *
 * One table holds every recorded interaction, keyed by
 * `(session_id, seq, ordinal)` so a rehanded batch updates its rows instead of
 * duplicating them. Records arrive through the seam's coordinator, which this
 * backend composes in its constructor: the backend owns storage only. The
 * engine is chosen by `driver`; both keep the same table and migrations.
 *
 * @module @deepseek-ai/dsh-session-manager/sql
 */

import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import { SessionManagerBackend, type SessionInteractionLog, type SessionInteractionQuery } from './backend.ts'
import { SessionManagerCoordinator } from './coordinator.ts'
import { eventRecord, type SessionInteractionRecord } from './records.ts'
import type { JournalMode } from './adaptors/sqlite/schema.ts'
import type { InteractionStore } from './store.ts'

/** Backend configuration as authored in `cordis.yml`. */
export interface Config {
  /** Storage engine: a local SQLite file, or a PostgreSQL database. */
  driver?: 'sqlite' | 'postgres'
  /** SQLite database file, or `:memory:` for an ephemeral store; required with the `sqlite` driver. */
  path?: string
  /** SQLite journal mode; `:memory:` ignores it. */
  journalMode?: JournalMode
  /** PostgreSQL connection; required with the `postgres` driver. */
  postgres?: {
    /** Credential reference holding the connection string, `postgres://user:password@host:port/database`; required with the `postgres` driver. */
    connectionStringEnv?: string
    /** Schema holding `session_interaction` and its migration ledger. */
    schema: string
    /** Upper bound on pooled connections. */
    maxConnections: number
  }
  /** Open the store during activation (`startup`) or on the first record (`never`). */
  openAt?: 'startup' | 'never'
  /**
   * Session ids to rebuild from the store during activation, before any agent
   * can resume them. Use it to bring back a session whose canonical log was
   * lost. Requires a mounted session persistence backend.
   */
  restoreSessions?: string[]
}

/** Validated configuration with every default applied. */
type ResolvedConfig =
  & { openAt: 'startup' | 'never'; restoreSessions: string[] }
  & (
    | { driver: 'sqlite'; path: string; journalMode: JournalMode }
    | { driver: 'postgres'; postgres: { connectionStringEnv: string; schema: string; maxConnections: number } }
  )

/**
 * Apply defaults and check the engine-specific fields, so a misconfigured row
 * fails when the plugin loads.
 * @param config - configuration as validated by {@link SqlSessionManager.Config}.
 * @returns the configuration with every optional field resolved.
 * @throws when the chosen driver's own fields are missing.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const common = { openAt: config.openAt ?? 'startup', restoreSessions: config.restoreSessions ?? [] }
  if (config.driver === 'postgres') {
    const postgres = config.postgres
    if (postgres?.connectionStringEnv === undefined) throw new Error('session manager: the postgres driver requires postgres.connectionStringEnv')
    return {
      ...common,
      driver: 'postgres',
      postgres: { connectionStringEnv: postgres.connectionStringEnv, schema: postgres.schema, maxConnections: postgres.maxConnections },
    }
  }
  if (config.path === undefined) throw new Error('session manager: the sqlite driver requires path')
  return { ...common, driver: 'sqlite', path: config.path, journalMode: config.journalMode ?? 'wal' }
}

/** SQL owner of the `ctx.sessionManager` service. */
export class SqlSessionManager extends SessionManagerBackend {
  static inject = ['sessions', 'credentials']

  static Config: z<Config> = z.object({
    driver: z.union(['sqlite', 'postgres'] as const).default('sqlite'),
    path: z.string(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    postgres: z.object({
      connectionStringEnv: z.string().role('credential-ref'),
      schema: z.string().default('public'),
      maxConnections: z.number().step(1).min(1).default(4),
    }),
    openAt: z.union(['startup', 'never'] as const).default('startup'),
    restoreSessions: z.array(z.string()).default([]),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private opening: Promise<InteractionStore> | undefined
  private closed = false
  /** Mounted session persistence, captured through an injection so it stays optional. */
  private persistence: SessionPersistence | undefined
  /** Injection fiber holding {@link persistence} for this service's lifetime. */
  private readonly persistenceFiber: Fiber

  /**
   * @param ctx - the context this service registers on.
   * @param config - engine, its connection, open timing, and sessions to restore.
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

  /** Open the store during activation only when configuration asks for it. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this.store()
    await this.restore()
  }

  /**
   * Open the store once and reuse it.
   * @returns the open store.
   */
  private store(): Promise<InteractionStore> {
    if (this.closed) return Promise.reject(new Error('session manager store is closed'))
    this.opening ??= this.open()
    return this.opening
  }

  /** Open the configured engine; the PostgreSQL driver is loaded only when chosen. */
  private async open(): Promise<InteractionStore> {
    const config = this.config
    if (config.driver === 'sqlite') {
      const { openSqliteStore } = await import('./adaptors/sqlite/store.ts')
      return openSqliteStore(config.path, config.journalMode)
    }
    const credential = await this.ctx.credentials.resolve(credentialRef(config.postgres.connectionStringEnv))
    if (credential === undefined) throw new Error(`session manager: credential ${config.postgres.connectionStringEnv} is not configured`)
    const { openPsqlStore } = await import('./adaptors/psql/store.ts')
    return openPsqlStore({
      connectionString: credential.value,
      schema: config.postgres.schema,
      maxConnections: config.postgres.maxConnections,
    })
  }

  /** See {@link SessionManagerBackend.record} — that declaration is the contract's one home. */
  override async record(records: readonly SessionInteractionRecord[]): Promise<void> {
    if (records.length === 0) return
    await (await this.store()).upsert(records)
  }

  /** See {@link SessionManagerBackend.read}. */
  override async read(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]> {
    return (await this.store()).query(query)
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
    const store = await this.store()
    const from = await store.firstMissingSeq(session.id)
    const known = new Set(await store.eventSeqs(session.id))
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
    const store = await this.store()
    const header = await store.header(sessionId)
    if (header === undefined) return undefined
    const events = await store.events(sessionId)
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
    const store = await open.catch(() => undefined)
    await store?.close()
  }
}

export default SqlSessionManager
