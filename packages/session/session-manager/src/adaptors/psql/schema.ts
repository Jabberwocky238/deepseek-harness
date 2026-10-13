/**
 * PostgreSQL schema and forward-only migrations for recorded session
 * interactions, kept version-for-version in step with the SQLite store.
 *
 * @module @deepseek-ai/dsh-session-manager/adaptors/psql/schema
 */

import type { PoolClient } from 'pg'
import { SESSION_MANAGER_SQL_SCHEMA_VERSION } from '../sqlite/schema.ts'

/** One forward-only migration; the version and name match the SQLite migration of the same number. */
interface Migration {
  /** Schema version this migration produces, stored in `schema_migrations`. */
  version: number
  /** What the migration changes, recorded for the operator reading `schema_migrations`. */
  name: string
  /** Statements applied in the migrating transaction, given the quoted schema name. */
  statements: (schema: string) => readonly string[]
}

/** Every migration this build knows, in application order. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'session_interaction table and kind index',
    statements: schema => [
      `CREATE TABLE ${schema}.session_interaction (
        session_id TEXT    NOT NULL,
        seq        BIGINT  NOT NULL,
        ordinal    INTEGER NOT NULL,
        time       BIGINT  NOT NULL,
        turn       INTEGER,
        step       INTEGER,
        kind       TEXT    NOT NULL,
        call_id    TEXT,
        tool_name  TEXT,
        text       TEXT,
        body       TEXT    NOT NULL,
        PRIMARY KEY (session_id, seq, ordinal)
      )`,
      `CREATE INDEX session_interaction_kind ON ${schema}.session_interaction (session_id, kind, seq)`,
    ],
  },
  {
    version: 2,
    name: 'source_kind column and source index',
    statements: schema => [
      `ALTER TABLE ${schema}.session_interaction ADD COLUMN source_kind TEXT`,
      `CREATE INDEX session_interaction_source ON ${schema}.session_interaction (session_id, source_kind, seq)`,
    ],
  },
  {
    version: 3,
    name: 'raw event column for exact rebuilds',
    statements: schema => [`ALTER TABLE ${schema}.session_interaction ADD COLUMN event TEXT`],
  },
]

/** Newest schema version this build applies; equal to the SQLite store's by construction. */
export const PSQL_SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0)
/* v8 ignore next 3 -- a build-time invariant: the two engines must agree on the schema version */
if (PSQL_SCHEMA_VERSION !== SESSION_MANAGER_SQL_SCHEMA_VERSION) {
  throw new Error(`session manager: PostgreSQL schema version ${PSQL_SCHEMA_VERSION} differs from SQLite ${SESSION_MANAGER_SQL_SCHEMA_VERSION}`)
}

/**
 * Quote one SQL identifier.
 * @param name - schema name as configured.
 * @returns the identifier, double-quoted with embedded quotes doubled.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Bring one schema up to {@link PSQL_SCHEMA_VERSION} in a single transaction.
 *
 * Several processes may open the same database at once, so the transaction
 * first takes an advisory lock keyed by the schema name; a second migrator
 * waits and then finds every migration recorded. The schema is created only
 * when missing, because `CREATE SCHEMA IF NOT EXISTS` still demands the
 * database-level `CREATE` privilege. A schema written by a newer build is
 * refused rather than narrowed.
 * @param client - a pooled connection, released by the caller.
 * @param schema - unquoted schema name.
 */
export async function migrate(client: PoolClient, schema: string): Promise<void> {
  const quoted = quoteIdentifier(schema)
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dsh-session-manager:${schema}`])
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])
    if (exists.rowCount === 0) await client.query(`CREATE SCHEMA ${quoted}`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${quoted}.schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at BIGINT  NOT NULL
    )`)
    const applied = new Set((await client.query<{ version: number }>(`SELECT version FROM ${quoted}.schema_migrations`)).rows.map(row => row.version))
    const newest = Math.max(0, ...applied)
    if (newest > PSQL_SCHEMA_VERSION) {
      throw new Error(
        `session interaction schema "${schema}" is at version ${newest}, newer than this build's `
        + `${PSQL_SCHEMA_VERSION}; upgrade the harness instead of downgrading the store`,
      )
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      for (const statement of migration.statements(quoted)) await client.query(statement)
      await client.query(
        `INSERT INTO ${quoted}.schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, Date.now()],
      )
    }
    await client.query('COMMIT')
  } catch (error: unknown) {
    await client.query('ROLLBACK')
    throw error
  }
}
