import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_MANAGER_SQL_SCHEMA_VERSION, openInteractionDatabase } from '../src/schema.ts'

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-session-manager-migrations-'))
  path = join(directory, 'interactions.sqlite')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Ledger rows, read through an independent connection. */
function ledger(storePath = path): { version: number; name: string; applied_at: number }[] {
  const db = new DatabaseSync(storePath)
  try {
    return db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all() as unknown as { version: number; name: string; applied_at: number }[]
  } finally {
    db.close()
  }
}

/** Columns of the record table, in declaration order. */
function columns(storePath = path): string[] {
  const db = new DatabaseSync(storePath)
  try {
    const rows = db.prepare('PRAGMA table_info(session_interaction)').all() as unknown as { name: string }[]
    return rows.map(row => row.name)
  } finally {
    db.close()
  }
}

/** Open a connection to run one operator statement, then close it. */
function exec(statement: string, storePath = path): void {
  const db = new DatabaseSync(storePath)
  try {
    db.exec(statement)
  } finally {
    db.close()
  }
}

/** One stored row, to prove a migration never rebuilds existing data. */
function seedRow(storePath = path): void {
  exec(`INSERT INTO session_interaction
    (session_id, seq, ordinal, time, kind, source_kind, text, body)
    VALUES ('s-keep', 1, 0, 1, 'user-message', 'user', 'kept', '{}')`, storePath)
}

/** Rows still present, counted independently. */
function rowCount(storePath = path): number {
  const db = new DatabaseSync(storePath)
  try {
    return (db.prepare('SELECT count(*) AS n FROM session_interaction').get() as unknown as { n: number }).n
  } finally {
    db.close()
  }
}

describe('schema migrations', () => {
  it('applies and records every migration on a fresh database', async () => {
    const db = await openInteractionDatabase(path, 'wal')
    db.close()

    expect(columns()).toContain('source_kind')
    const rows = ledger()
    expect(rows.map(row => row.version)).toEqual([1, 2, 3])
    expect(rows.every(row => row.name !== '' && row.applied_at > 0)).toBe(true)
    expect(SESSION_MANAGER_SQL_SCHEMA_VERSION).toBe(3)

    const version = new DatabaseSync(path)
    try {
      expect(version.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    } finally {
      version.close()
    }
  })

  it('records nothing twice when the database is reopened', async () => {
    const first = await openInteractionDatabase(path, 'wal')
    first.close()
    const second = await openInteractionDatabase(path, 'wal')
    second.close()

    expect(ledger().map(row => row.version)).toEqual([1, 2, 3])
  })

  it('upgrades a ledger-less v1 database in place instead of rebuilding it', async () => {
    const db = await openInteractionDatabase(path, 'wal')
    db.close()
    seedRow()
    // Simulate the earlier build: no ledger, v1 shape, reported version 1.
    exec('DROP INDEX session_interaction_source')
    exec('ALTER TABLE session_interaction DROP COLUMN source_kind')
    exec('ALTER TABLE session_interaction DROP COLUMN event')
    exec('DROP TABLE schema_migrations')
    exec('PRAGMA user_version = 1')

    const upgraded = await openInteractionDatabase(path, 'wal')
    upgraded.close()

    expect(columns()).toContain('source_kind')
    expect(ledger().map(row => row.version)).toEqual([1, 2, 3])
    expect(rowCount()).toBe(1)
  })

  it('baselines a ledger-less database already at the current version', async () => {
    const db = await openInteractionDatabase(path, 'wal')
    db.close()
    seedRow()
    exec('DROP TABLE schema_migrations')

    const reopened = await openInteractionDatabase(path, 'wal')
    reopened.close()

    expect(ledger().map(row => row.version)).toEqual([1, 2, 3])
    expect(rowCount()).toBe(1)
  })

  it('refuses a database written by a newer build', async () => {
    const db = await openInteractionDatabase(path, 'wal')
    db.close()
    exec('PRAGMA user_version = 99')

    await expect(openInteractionDatabase(path, 'wal')).rejects.toThrow(/newer than this build/)
  })

  it('refuses a database belonging to another application', async () => {
    exec('PRAGMA application_id = 12345')
    await expect(openInteractionDatabase(path, 'wal')).rejects.toThrow(/another application/)
  })
})
