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
   * Insert records, replacing a stored row that has the same identity; the
   * batch commits or fails as one transaction.
   * @param records - records to store.
   */
  upsert(records: readonly SessionInteractionRecord[]): Promise<void>
  /**
   * Read records matching a query, ordered by `(seq, ordinal)`.
   * @param query - session, lower sequence bound, kind and source filters, and limit.
   * @returns the matching records.
   */
  query(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]>
  /**
   * Smallest sequence number with no stored event, counting from zero.
   * @param sessionId - session to inspect.
   * @returns the first missing sequence number, or the one after the tail.
   */
  firstMissingSeq(sessionId: SessionId): Promise<number>
  /**
   * Every sequence number that has a stored event.
   * @param sessionId - session to inspect.
   * @returns the sequence numbers, in no particular order.
   */
  eventSeqs(sessionId: SessionId): Promise<number[]>
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

/** Columns an upsert overwrites when the identity already exists. */
export const UPDATED_COLUMNS = RECORD_COLUMNS.slice(3)

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
