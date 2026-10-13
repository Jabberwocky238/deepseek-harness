/**
 * SQLite implementation of the interaction store, on `node:sqlite`.
 *
 * @module @deepseek-ai/dsh-session-manager/adaptors/sqlite/store
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { decodeRow, decodeRows, rowInteger, rowNullableInteger, rowText } from '../../rows.ts'
import { type JournalMode, openInteractionDatabase } from './schema.ts'
import { type InteractionStore, insertStatement, queryClause, recordFromRow, recordValues } from '../../store.ts'

/**
 * Run a synchronous `node:sqlite` operation behind the asynchronous store
 * interface, turning a thrown error into a rejection.
 * @param operation - the synchronous work.
 * @returns its result, settled.
 */
function settle<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation())
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Open and migrate a SQLite interaction store.
 * @param path - database file, or `:memory:` for an ephemeral store.
 * @param journalMode - SQLite journal mode; `:memory:` ignores it.
 * @returns the open store, owned by the caller.
 */
export async function openSqliteStore(path: string, journalMode: JournalMode): Promise<InteractionStore> {
  const db = await openInteractionDatabase(path, journalMode)
  let closed = false
  return {
    write: (records, onConflict) => settle(() => {
      const insert = db.prepare(insertStatement('session_interaction', () => '?', onConflict))
      db.exec('BEGIN')
      try {
        for (const record of records) insert.run(...recordValues(record))
        db.exec('COMMIT')
      } catch (error: unknown) {
        db.exec('ROLLBACK')
        throw error
      }
    }),
    query: query => settle(() => {
      const { sql, values } = queryClause(query, () => '?')
      return decodeRows(db.prepare(`SELECT * FROM session_interaction${sql}`).all(...values), recordFromRow)
    }),
    firstMissingSeq: (sessionId: SessionId) => settle(() => {
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
    }),
    eventSeqs: sessionId => settle(() => decodeRows(
      db.prepare('SELECT seq FROM session_interaction WHERE session_id = ? AND event IS NOT NULL').all(sessionId),
      row => rowInteger(row, 'seq'),
    )),
    header: sessionId => settle(() => decodeRow(db.prepare(
      `SELECT body FROM session_interaction
        WHERE session_id = ? AND kind = 'session-header' ORDER BY seq LIMIT 1`,
    ).get(sessionId), row => rowText(row, 'body'))),
    events: sessionId => settle(() => decodeRows(db.prepare(
      `SELECT event FROM session_interaction
        WHERE session_id = ? AND event IS NOT NULL ORDER BY seq, ordinal`,
    ).all(sessionId), row => rowText(row, 'event'))),
    close: () => settle(() => {
      if (closed) return
      closed = true
      db.close()
    }),
  }
}
