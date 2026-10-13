/**
 * PostgreSQL implementation of the interaction store, on `pg`.
 *
 * @module @deepseek-ai/dsh-session-manager/adaptors/psql/store
 */

import type { Pool } from 'pg'
import { decodeRow, decodeRows, rowInteger, rowNullableInteger, rowText } from '../../rows.ts'
import { type InteractionStore, RECORD_COLUMNS, UPDATED_COLUMNS, queryClause, recordFromRow, recordValues } from '../../store.ts'
import { migrate, quoteIdentifier } from './schema.ts'

/** Connection settings for a PostgreSQL store. */
export interface PsqlStoreOptions {
  /** libpq-style connection string, `postgres://user:password@host:port/database?sslmode=…`. */
  connectionString: string
  /** Schema holding `session_interaction` and its migration ledger. */
  schema: string
  /** Upper bound on pooled connections. */
  maxConnections: number
}

/** PostgreSQL type oid of `BIGINT` (`int8`). */
const INT8_OID = 20

/**
 * Parse a `BIGINT` as a number. `pg` returns `int8` as a string so no value is
 * silently rounded; the stored sequence numbers and millisecond times are safe
 * integers, and a value that is not fails loud instead.
 * @param value - the column's text representation.
 * @returns the integer.
 */
function parseInt8(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`stored bigint ${value} is not a safe integer`)
  return parsed
}

/**
 * Open, migrate and return a PostgreSQL interaction store.
 * @param options - connection string, schema and pool size.
 * @returns the open store, owned by the caller.
 */
export async function openPsqlStore(options: PsqlStoreOptions): Promise<InteractionStore> {
  const { default: pg } = await import('pg')
  // `pg` types the built-in parser lookup loosely; every parser takes the column text.
  const builtin = pg.types.getTypeParser as (oid: number, format?: 'text' | 'binary') => (value: string) => unknown
  const getTypeParser = (oid: number, format?: 'text' | 'binary'): ((value: string) => unknown) =>
    oid === INT8_OID && format !== 'binary' ? parseInt8 : builtin(oid, format)
  const pool: Pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    types: { getTypeParser: getTypeParser as typeof pg.types.getTypeParser },
  })
  // An idle client's network error surfaces on the pool; without a listener it would crash the process.
  pool.on('error', () => {})
  const schema = quoteIdentifier(options.schema)
  const table = `${schema}.session_interaction`
  const insert = `
    INSERT INTO ${table} (${RECORD_COLUMNS.join(', ')})
    VALUES (${RECORD_COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
    ON CONFLICT (session_id, seq, ordinal) DO UPDATE SET
      ${UPDATED_COLUMNS.map(column => `${column} = EXCLUDED.${column}`).join(',\n      ')}
  `
  try {
    const client = await pool.connect()
    try {
      await migrate(client, options.schema)
    } finally {
      client.release()
    }
  } catch (error: unknown) {
    await pool.end()
    throw error
  }
  let closed = false
  return {
    async upsert(records) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          for (const record of records) await client.query(insert, recordValues(record))
          await client.query('COMMIT')
        } catch (error: unknown) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
    async query(query) {
      const { sql, values } = queryClause(query, n => `$${n}`)
      return decodeRows((await pool.query(`SELECT * FROM ${table}${sql}`, values)).rows, recordFromRow)
    },
    async firstMissingSeq(sessionId) {
      const result = await pool.query(`
        SELECT MIN(candidate) AS missing FROM (
          SELECT 0::bigint AS candidate
          UNION
          SELECT seq + 1 FROM ${table} WHERE session_id = $1 AND event IS NOT NULL
        ) AS candidates WHERE candidate NOT IN (
          SELECT seq FROM ${table} WHERE session_id = $1 AND event IS NOT NULL
        )
      `, [sessionId])
      return decodeRow(result.rows[0], row => rowNullableInteger(row, 'missing')) ?? 0
    },
    async eventSeqs(sessionId) {
      const result = await pool.query(`SELECT seq FROM ${table} WHERE session_id = $1 AND event IS NOT NULL`, [sessionId])
      return decodeRows(result.rows, row => rowInteger(row, 'seq'))
    },
    async header(sessionId) {
      const result = await pool.query(
        `SELECT body FROM ${table} WHERE session_id = $1 AND kind = 'session-header' ORDER BY seq LIMIT 1`,
        [sessionId],
      )
      return decodeRow(result.rows[0], row => rowText(row, 'body'))
    },
    async events(sessionId) {
      const result = await pool.query(
        `SELECT event FROM ${table} WHERE session_id = $1 AND event IS NOT NULL ORDER BY seq, ordinal`,
        [sessionId],
      )
      return decodeRows(result.rows, row => rowText(row, 'event'))
    },
    async close() {
      if (closed) return
      closed = true
      await pool.end()
    },
  }
}
