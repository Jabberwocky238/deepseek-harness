import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SqlSessionManager, { SESSION_MANAGER_SQL_SCHEMA_VERSION, type SessionInteractionRecord } from '../src/index.ts'
import { openPsqlStore } from '../src/adaptors/psql/store.ts'

/**
 * PostgreSQL runs only against a real server: set DSH_TEST_POSTGRES_URL to a
 * database the test may create and drop schemas in. Without it the suite skips.
 */
const url = process.env['DSH_TEST_POSTGRES_URL']

let schema: string

beforeEach(() => {
  schema = `dsh_test_${randomBytes(6).toString('hex')}`
})

afterEach(async () => {
  if (url === undefined) return
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await client.end()
  }
})

/** Start a harness with the backend on PostgreSQL, the connection string served by a stub credential provider. */
async function setup(connection: string | null = url ?? null, openAt: 'startup' | 'never' = 'startup') {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.provide('credentials', {
    resolve: async () => connection === null ? undefined : { value: connection, source: 'test' },
  } as never)
  const fiber = await ctx.plugin(SqlSessionManager, {
    driver: 'postgres',
    postgres: { connectionStringEnv: 'DSH_TEST_PG', schema, maxConnections: 2 },
    openAt,
  })
  return { ctx, manager: ctx.sessionManager, fiber }
}

/** Let the coordinator's microtask flush reach the store. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe.skipIf(url === undefined)('SqlSessionManager on PostgreSQL', () => {
  it('stores the conversation and reads it back with the seam vocabulary intact', async () => {
    const { ctx, manager, fiber } = await setup()
    const session = ctx.sessions.create(SessionId('pg-1'), { meta: {} })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello postgres' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [{ type: 'reasoning', text: 'greet back' }, { type: 'text', text: 'hi' }],
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    await settle()

    const records = await manager.read({ sessionId: session.id })
    expect(records.map(record => record.kind)).toEqual([
      'session-header', 'session-event', 'user-message', 'assistant-message', 'thinking',
    ])
    expect(records.every(record => typeof record.time === 'number' && record.time > 2 ** 31)).toBe(true)
    expect((await manager.read({ sessionId: session.id, kinds: ['thinking'] })).map(record => record.text)).toEqual(['greet back'])
    expect((await manager.read({ sessionId: session.id, sinceSeq: 2 as never })).map(record => record.kind))
      .toEqual(['assistant-message', 'thinking'])
    expect((await manager.read({ sessionId: session.id, sourceKinds: ['user'], limit: 1 })).map(record => record.text))
      .toEqual(['hello postgres'])

    const log = await manager.readSession(session.id)
    expect(log?.header.id).toBe('pg-1')
    expect(log?.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'assistant/message'])
    await fiber.dispose()
  })

  it('keeps one row per identity when a batch is recorded twice', async () => {
    const { manager, fiber } = await setup()
    const record: SessionInteractionRecord = {
      sessionId: SessionId('pg-2'), seq: 9 as never, ordinal: 0, time: Date.now(),
      kind: 'thinking', sourceKind: 'model', text: 'once', body: { text: 'once' },
    }
    await manager.record([record])
    await manager.record([{ ...record, text: 'rewritten', body: { text: 'rewritten' } }])
    expect((await manager.read({ sessionId: SessionId('pg-2') })).map(row => row.text)).toEqual(['rewritten'])
    await fiber.dispose()
    await expect(manager.read({ sessionId: SessionId('pg-2') })).rejects.toThrow('closed')
  })

  it('lets several processes migrate the same schema at once', async () => {
    const options = { connectionString: url!, schema, maxConnections: 1 }
    const stores = await Promise.all([openPsqlStore(options), openPsqlStore(options), openPsqlStore(options)])
    await Promise.all(stores.map(store => store.close()))
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      const { rows } = await client.query<{ version: number }>(`SELECT version FROM "${schema}".schema_migrations ORDER BY version`)
      expect(rows.map(row => row.version)).toEqual([1, 2, 3])
    } finally {
      await client.end()
    }
  })

  it('refuses a schema written by a newer build', async () => {
    const store = await openPsqlStore({ connectionString: url!, schema, maxConnections: 1 })
    await store.close()
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(`INSERT INTO "${schema}".schema_migrations VALUES ($1, 'future', 0)`, [SESSION_MANAGER_SQL_SCHEMA_VERSION + 1])
    } finally {
      await client.end()
    }
    await expect(openPsqlStore({ connectionString: url!, schema, maxConnections: 1 })).rejects.toThrow(/newer than this build/)
  })

  it('fails loud when the connection credential is not configured', async () => {
    const { manager, fiber } = await setup(null, 'never')
    await expect(manager.read({ sessionId: SessionId('pg-3') })).rejects.toThrow(/credential DSH_TEST_PG is not configured/)
    await fiber.dispose()
  })
})

describe('SqlSessionManager configuration', () => {
  it('requires the engine-specific fields when the plugin loads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(SqlSessionManager, { driver: 'postgres' })).rejects.toThrow(/requires postgres.connectionStringEnv/)
    await expect(ctx.plugin(SqlSessionManager, {})).rejects.toThrow(/requires path/)
  })
})
