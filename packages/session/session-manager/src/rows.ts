/**
 * Reading stored rows without casting them.
 *
 * Both SQL engines return rows as untyped records. A store is a durable boundary:
 * the file may have been written by another process, by an older schema, or by
 * hand, so every column is checked where it is read instead of being asserted
 * into a shape. A value of the wrong SQLite type fails loud here, naming the
 * column, rather than reaching a record that silently disagrees with its event.
 *
 * @module @deepseek-ai/dsh-session-manager/rows
 */

/** One returned row, before any of its columns is trusted. */
export type StoredRow = Record<string, unknown>

/**
 * Read one column of a row.
 * @param value - a value returned by `StatementSync.get` or one element of `all`.
 * @param column - column name to report when the value is not a row.
 * @returns the row, or undefined when the statement matched nothing.
 */
function asRow(value: unknown, column: string): StoredRow | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new Error(`stored row for ${column} is not an object`)
  return value as StoredRow
}

/**
 * Decode one row returned by `StatementSync.get`.
 * @param value - the statement's return value.
 * @param decode - reads the columns this caller needs.
 * @returns the decoded value, or undefined when the statement matched nothing.
 */
export function decodeRow<R>(value: unknown, decode: (row: StoredRow) => R): R | undefined {
  const row = asRow(value, 'get')
  return row === undefined ? undefined : decode(row)
}

/**
 * Decode every row returned by `StatementSync.all`.
 * @param values - the statement's return value.
 * @param decode - reads the columns this caller needs from each row.
 * @returns the decoded values in the statement's own order.
 */
export function decodeRows<R>(values: readonly unknown[], decode: (row: StoredRow) => R): R[] {
  return values.map((value) => {
    const row = asRow(value, 'all')
    /* v8 ignore next -- `all` never includes the absent row `get` can return */
    if (row === undefined) throw new Error('stored row is empty')
    return decode(row)
  })
}

/**
 * Read a `TEXT` column.
 * @param row - row being decoded.
 * @param column - column name.
 * @returns the stored string, or throws when the column holds anything else.
 */
export function rowText(row: StoredRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`stored column ${column} is not text`)
  return value
}

/**
 * Read a nullable `TEXT` column.
 * @param row - row being decoded.
 * @param column - column name.
 * @returns the stored string, or null when the column holds SQL NULL.
 */
export function rowNullableText(row: StoredRow, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`stored column ${column} is not text or null`)
  return value
}

/**
 * Read an `INTEGER` column.
 * @param row - row being decoded.
 * @param column - column name.
 * @returns the stored integer, or throws when the column holds anything else.
 */
export function rowInteger(row: StoredRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`stored column ${column} is not an integer`)
  return value
}

/**
 * Read a nullable `INTEGER` column.
 * @param row - row being decoded.
 * @param column - column name.
 * @returns the stored integer, or null when the column holds SQL NULL.
 */
export function rowNullableInteger(row: StoredRow, column: string): number | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`stored column ${column} is not an integer or null`)
  return value
}
