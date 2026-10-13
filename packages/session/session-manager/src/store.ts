/**
 * The storage operations the session-manager backend needs, independent of the
 * SQL engine underneath, plus the row decoding both engines share.
 *
 * @module @deepseek-ai/dsh-session-manager/store
 */

import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionInteractionQuery } from './backend.ts'
import type { SessionInteractionRecord } from './records.ts'
import { rowInteger, rowNullableInteger, rowNullableText, rowText, type StoredRow } from './rows.ts'

/**
 * One engine's storage of interaction records in the `session_interaction`
 * table, keyed by `(session_id, seq, ordinal)`.
 */
export interface InteractionStore {
  /**
   * Insert records; the batch commits or fails as one transaction.
   * @param records - records to store.
   * @param onConflict - `replace` overwrites a stored row with the same
   *   identity; `keep` leaves it and skips the record.
   */
  write(records: readonly SessionInteractionRecord[], onConflict: ConflictPolicy): Promise<void>
  /**
   * Read records matching a query, ordered by `(seq, ordinal)`.
   * @param query - session, lower sequence bound, kind and source filters, and limit.
   * @returns the matching records.
   */
  query(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]>
  /**
   * Highest sequence number below `before` with a stored event.
   * @param sessionId - session to inspect.
   * @param before - exclusive upper bound on the sequence number.
   * @returns that sequence number, or `undefined` when no stored event lies below the bound.
   */
  lastEventSeq(sessionId: SessionId, before: number): Promise<number | undefined>
  /**
   * The stored session header, as its serialized JSON.
   * @param sessionId - session to read.
   * @returns the header body, or undefined when none is stored.
   */
  header(sessionId: SessionId): Promise<string | undefined>
  /**
   * Every stored event of a session, serialized, in `(seq, ordinal)` order.
   * @param sessionId - session to read.
   * @returns the serialized events.
   */
  events(sessionId: SessionId): Promise<string[]>
  /** Release the connection or file handle. Idempotent. */
  close(): Promise<void>
}

/** Column list shared by every insert, in parameter order. */
export const RECORD_COLUMNS = [
  'session_id', 'seq', 'ordinal', 'time', 'turn', 'step', 'kind',
  'source_kind', 'call_id', 'tool_name', 'text', 'body', 'event',
] as const

/** Columns a `replace` write overwrites when the identity already exists. */
export const UPDATED_COLUMNS = RECORD_COLUMNS.slice(3)

/** What a write does with a record whose identity is already stored. */
export type ConflictPolicy = 'replace' | 'keep'

/**
 * Statement text inserting one record into `table`.
 * @param table - the table name, already quoted where the engine needs it.
 * @param placeholder - the engine's placeholder for the 1-based parameter `n`.
 * @param onConflict - whether a stored row with the same identity is overwritten or kept.
 * @returns the `INSERT … ON CONFLICT` statement; both engines accept the same syntax.
 */
export function insertStatement(table: string, placeholder: (n: number) => string, onConflict: ConflictPolicy): string {
  const action = onConflict === 'replace'
    ? `DO UPDATE SET ${UPDATED_COLUMNS.map(column => `${column} = excluded.${column}`).join(', ')}`
    : 'DO NOTHING'
  return `INSERT INTO ${table} (${RECORD_COLUMNS.join(', ')}) VALUES (${RECORD_COLUMNS.map((_, index) => placeholder(index + 1)).join(', ')}) ON CONFLICT (session_id, seq, ordinal) ${action}`
}

/**
 * The parameter values of one record, in {@link RECORD_COLUMNS} order.
 * @param record - the record to store.
 * @returns the values bound to the insert statement.
 */
export function recordValues(record: SessionInteractionRecord): (string | number | null)[] {
  return [
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
  ]
}

/**
 * Decode one stored row into a record, checking every column.
 * @param row - a `session_interaction` row.
 * @returns the record it holds.
 */
export function recordFromRow(row: StoredRow): SessionInteractionRecord {
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
}

/**
 * The `WHERE`/`LIMIT` tail and bound values of a query, with placeholders made
 * by `placeholder` so each engine supplies its own syntax.
 * @param query - the query to translate.
 * @param placeholder - returns the placeholder for the n-th bound value, from 1.
 * @returns the SQL after `FROM session_interaction` and its values.
 */
export function queryClause(
  query: SessionInteractionQuery,
  placeholder: (n: number) => string,
): { sql: string; values: (string | number)[] } {
  const values: (string | number)[] = [query.sessionId]
  const bind = (value: string | number): string => {
    values.push(value)
    return placeholder(values.length)
  }
  const where = [`session_id = ${placeholder(1)}`]
  if (query.sinceSeq !== undefined) where.push(`seq >= ${bind(query.sinceSeq)}`)
  if (query.kinds !== undefined && query.kinds.length > 0) {
    where.push(`kind IN (${query.kinds.map(kind => bind(kind)).join(', ')})`)
  }
  if (query.sourceKinds !== undefined && query.sourceKinds.length > 0) {
    where.push(`source_kind IN (${query.sourceKinds.map(kind => bind(kind)).join(', ')})`)
  }
  let sql = ` WHERE ${where.join(' AND ')} ORDER BY seq, ordinal`
  if (query.limit !== undefined) sql += ` LIMIT ${bind(query.limit)}`
  return { sql, values }
}
