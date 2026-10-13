/**
 * PostgreSQL implementation of the interaction store, on `pg`.
 *
 * @module @deepseek-ai/dsh-session-manager/adaptors/psql/store
 */

import type { Pool } from 'pg'
import { decodeRow, decodeRows, rowNullableInteger, rowText } from '../../rows.ts'
import { type InteractionStore, insertStatement, queryClause, recordFromRow, recordValues } from '../../store.ts'
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
    async write(records, onConflict) {
      const insert = insertStatement(table, n => `$${n}`, onConflict)
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
    async lastEventSeq(sessionId, before) {
      const result = await pool.query(`SELECT MAX(seq) AS last FROM ${table} WHERE session_id = $1 AND seq < $2 AND event IS NOT NULL`, [sessionId, before])
      return decodeRow(result.rows[0], row => rowNullableInteger(row, 'last')) ?? undefined
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
