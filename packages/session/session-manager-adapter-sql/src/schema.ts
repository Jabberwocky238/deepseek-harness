/** SQLite schema and forward-only migrations for recorded session interactions. */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { decodeRows, rowInteger } from './rows.ts'

/** Application id stored in `PRAGMA application_id`, protecting an unrelated database from this table set. */
export const SESSION_MANAGER_SQL_APPLICATION_ID = 0x4453484d

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** One forward-only migration; versions are monotonic and applied in ascending order. */
interface Migration {
  /** Schema version this migration produces, stored in `schema_migrations` and `PRAGMA user_version`. */
  version: number
  /** What the migration changes, recorded for the operator reading `schema_migrations`. */
  name: string
  /** Statements applied together in one transaction. */
  statements: readonly string[]
}

/** Interaction records before `source_kind` existed. */
const CREATE_INTERACTION = `
  CREATE TABLE session_interaction (
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    ordinal    INTEGER NOT NULL,
    time       INTEGER NOT NULL,
    turn       INTEGER,
    step       INTEGER,
    kind       TEXT    NOT NULL,
    call_id    TEXT,
    tool_name  TEXT,
    text       TEXT,
    body       TEXT    NOT NULL,
    PRIMARY KEY (session_id, seq, ordinal)
  ) STRICT
`

/** Every migration this build knows, in application order. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'session_interaction table and kind index',
    statements: [
      CREATE_INTERACTION,
      'CREATE INDEX session_interaction_kind ON session_interaction (session_id, kind, seq)',
    ],
  },
  {
    version: 2,
    name: 'source_kind column and source index',
    statements: [
      'ALTER TABLE session_interaction ADD COLUMN source_kind TEXT',
      'CREATE INDEX session_interaction_source ON session_interaction (session_id, source_kind, seq)',
    ],
  },
  {
    version: 3,
    name: 'raw event column for exact rebuilds',
    statements: ['ALTER TABLE session_interaction ADD COLUMN event TEXT'],
  },
]

/** Newest schema version this build applies. */
export const SESSION_MANAGER_SQL_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

/** Migration ledger; created before any migration runs, so it is not itself a migration. */
const CREATE_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT
`

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * @param path - resolved filesystem path of the database.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Versions already recorded in the migration ledger. */
function migratedVersions(db: DatabaseSync): Set<number> {
  return new Set(decodeRows(db.prepare('SELECT version FROM schema_migrations').all(), row => rowInteger(row, 'version')))
}

/** Record one migration as applied now. */
function recordMigration(db: DatabaseSync, migration: Migration): void {
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(migration.version, migration.name, Date.now())
}

/**
 * Bring one database up to {@link SESSION_MANAGER_SQL_SCHEMA_VERSION}.
 *
 * A database written by a newer build is refused rather than narrowed. A
 * database that predates the ledger — one carrying only `PRAGMA user_version`
 * — is recorded as already migrated instead of re-applied, so its existing
 * tables are never rebuilt.
 * @param db - open handle to migrate.
 */
function migrate(db: DatabaseSync): void {
  db.exec(CREATE_MIGRATIONS)
  const applied = migratedVersions(db)
  const { user_version: baseline } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const newest = Math.max(baseline, ...applied, 0)
  if (newest > SESSION_MANAGER_SQL_SCHEMA_VERSION) {
    throw new Error(
      `session interaction database is at schema version ${newest}, newer than this build's `
      + `${SESSION_MANAGER_SQL_SCHEMA_VERSION}; upgrade the harness instead of downgrading the store`,
    )
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= baseline && !applied.has(migration.version)) {
      // Already present in a pre-ledger database; record it without re-running.
      recordMigration(db, migration)
      continue
    }
    if (applied.has(migration.version)) continue
    db.exec('BEGIN')
    try {
      for (const statement of migration.statements) db.exec(statement)
      recordMigration(db, migration)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const settled = Math.max(...migratedVersions(db), 0)
  db.exec(`PRAGMA user_version = ${settled}`)
}

/**
 * Open and migrate the interaction store.
 *
 * The table keys a record by `(session_id, seq, ordinal)`, so a rehanded batch
 * updates the same row instead of appending a duplicate.
 * @param path - database path, or `:memory:` for an ephemeral store.
 * @param journalMode - validated SQLite journal mode; `:memory:` ignores it.
 * @returns the migrated handle, owned by the caller.
 */
export async function openInteractionDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (applicationId !== 0 && applicationId !== SESSION_MANAGER_SQL_APPLICATION_ID) {
      throw new Error(`session interaction database at "${actual}" belongs to another application`)
    }
    if (actual !== ':memory:') db.exec(`PRAGMA journal_mode = ${journalMode}`)
    migrate(db)
    db.exec(`PRAGMA application_id = ${SESSION_MANAGER_SQL_APPLICATION_ID}`)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}
