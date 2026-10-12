import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInteractionRecord } from '@deepseek-ai/dsh-session-manager'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SqliteSessionManager from '../src/index.ts'

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-session-manager-'))
  path = join(directory, 'interactions.sqlite')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Start a harness with the adapter mounted on a file-backed store. */
async function setup(storePath = path) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SqliteSessionManager, { path: storePath })
  return { ctx, manager: ctx.sessionManager, fiber }
}

/** Let the coordinator's microtask flush reach the store. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** One stored row, as SQLite returns it. */
interface StoredRow {
  kind: string
  seq: number
  ordinal: number
  text: string | null
  source_kind: string | null
}

/** Rows as stored, read through an independent connection. */
function storedRows(storePath = path): StoredRow[] {
  const db = new DatabaseSync(storePath)
  try {
    return db.prepare('SELECT kind, seq, ordinal, text, source_kind FROM session_interaction ORDER BY seq, ordinal')
      .all() as unknown as StoredRow[]
  } finally {
    db.close()
  }
}

/** Append one message with thinking, one tool call, and its result. */
function appendInteraction(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'list the files' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'deepseek-official', model: 'deepseek-flash' },
      content: [{ type: 'reasoning', text: 'the user wants a listing' }, { type: 'text', text: 'running ls' }],
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  const callId = ToolCallId('call-1')
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"ls"}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'a.txt\nb.txt' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

describe('SqliteSessionManager', () => {
  it('stores every interaction kind in the one table', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('s-1'), { meta: {} })
    appendInteraction(session)
    await settle()

    expect(storedRows()).toEqual([
      { kind: 'session-header', seq: 0, ordinal: -1, text: null, source_kind: null },
      { kind: 'session-event', seq: 0, ordinal: 0, text: null, source_kind: null },
      { kind: 'user-message', seq: 1, ordinal: 0, text: 'list the files', source_kind: 'user' },
      { kind: 'assistant-message', seq: 2, ordinal: 0, text: 'running ls', source_kind: 'model' },
      { kind: 'thinking', seq: 2, ordinal: 1, text: 'the user wants a listing', source_kind: 'model' },
      { kind: 'tool-call', seq: 3, ordinal: 0, text: '{"command":"ls"}', source_kind: null },
      { kind: 'tool-result', seq: 4, ordinal: 0, text: 'a.txt\nb.txt', source_kind: 'tool' },
    ])
  })

  it('reads records back with the seam vocabulary intact', async () => {
    const { ctx, manager } = await setup()
    const session = ctx.sessions.create(SessionId('s-2'), { meta: {} })
    appendInteraction(session)
    await settle()

    const records = await manager.read({ sessionId: session.id })
    expect(records.map(record => record.kind)).toEqual([
      'session-header', 'session-event', 'user-message', 'assistant-message', 'thinking', 'tool-call', 'tool-result',
    ])
    const call = records.find(record => record.kind === 'tool-call')
    expect(call).toMatchObject({ callId: 'call-1', name: 'bash', turn: 1, step: 1 })
    expect(records.every(record => typeof record.body === 'object')).toBe(true)
  })

  it('filters reads by kind, sequence, and limit', async () => {
    const { ctx, manager } = await setup()
    const session = ctx.sessions.create(SessionId('s-3'), { meta: {} })
    appendInteraction(session)
    await settle()

    const thinking = await manager.read({ sessionId: session.id, kinds: ['thinking'] })
    expect(thinking.map(record => record.text)).toEqual(['the user wants a listing'])

    const after = await manager.read({ sessionId: session.id, sinceSeq: 3 as never })
    expect(after.map(record => record.kind)).toEqual(['tool-call', 'tool-result'])

    const first = await manager.read({ sessionId: session.id, limit: 1 })
    expect(first.map(record => record.kind)).toEqual(['session-header'])

    const human = await manager.read({ sessionId: session.id, sourceKinds: ['user'] })
    expect(human.map(record => record.text)).toEqual(['list the files'])
    const model = await manager.read({ sessionId: session.id, sourceKinds: ['model'] })
    expect(model.map(record => record.kind)).toEqual(['assistant-message', 'thinking'])
  })

  it('keeps one row per identity when a batch is recorded twice', async () => {
    const { manager } = await setup()
    const record: SessionInteractionRecord = {
      sessionId: SessionId('s-4'),
      seq: 9 as never,
      ordinal: 0,
      time: 1,
      kind: 'thinking',
      sourceKind: 'model',
      text: 'once',
      body: { text: 'once' },
    }
    await manager.record([record])
    await manager.record([{ ...record, text: 'rewritten', body: { text: 'rewritten' } }])

    expect(storedRows()).toEqual([
      { kind: 'thinking', seq: 9, ordinal: 0, text: 'rewritten', source_kind: 'model' },
    ])
  })

  it('supports an ephemeral store and closes on disposal', async () => {
    const { ctx, manager, fiber } = await setup(':memory:')
    const session = ctx.sessions.create(SessionId('s-5'), { meta: {} })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'in memory' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    expect((await manager.read({ sessionId: session.id })).filter(record => record.kind === 'user-message')
      .map(record => record.text)).toEqual(['in memory'])

    await fiber.dispose()
    await expect(manager.read({ sessionId: session.id })).rejects.toThrow('closed')
  })
})
