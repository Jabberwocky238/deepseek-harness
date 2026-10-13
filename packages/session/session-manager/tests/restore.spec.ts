import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SqlSessionManager from '../src/index.ts'

const SESSION = SessionId('wecom-restore-fixture')

let directory: string
let sessionsRoot: string
let storePath: string
const contexts: Context[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-session-manager-restore-'))
  sessionsRoot = join(directory, 'sessions')
  storePath = join(directory, 'interactions.sqlite')
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(directory, { recursive: true, force: true })
})

/** Mount the session store, the shipped JSONL persistence backend, and the recording adapter. */
async function boot(restoreSessions?: string[]): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(SqlSessionManager, {
    path: storePath,
    ...restoreSessions === undefined ? {} : { restoreSessions },
  })
  return ctx
}

/** Append one scripted exchange: a prompt, an assistant reply with thinking, and a tool result. */
function converse(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '统计一下这个月的支出' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'deepseek-official', model: 'deepseek-flash' },
      content: [{ type: 'reasoning', text: '先问清楚口径' }, { type: 'text', text: '好的，我先看数据' }],
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** The stored log, read through the shipped persistence backend. */
async function storedLog(ctx: Context, id = SESSION): Promise<{ header: unknown; events: SessionEvent[] }> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read()
    return { header: handle.header, events: [...events] }
  } finally {
    await handle.close()
  }
}

/** Let the coordinator's microtask flush reach the store. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('restore from the interaction store', () => {
  it('rebuilds a deleted session log so the agent can resume it', async () => {
    const recorder = await boot()
    const session = recorder.sessions.create(SESSION, { meta: {} })
    const write = await recorder.sessionPersistence.create(session.header)
    converse(session)
    await recorder.sessionPersistence.flush()
    await write.close()
    await settle()
    const original = await storedLog(recorder)

    // Lose the canonical log the way a wiped disk would.
    await recorder.fiber.dispose()
    await rm(sessionsRoot, { recursive: true, force: true })
    await expect(boot().then(ctx => ctx.sessionPersistence.open(SESSION, 'read'))).rejects.toThrow()

    // Restore it from the store alone.
    const restored = await boot([SESSION])
    expect(await storedLog(restored)).toEqual(original)
    expect(restored.sessionPersistence.open(SESSION, 'read')).toBeTruthy()
  })

  it('keeps the recorded rows usable after the restore', async () => {
    const recorder = await boot()
    const session = recorder.sessions.create(SESSION, { meta: {} })
    const write = await recorder.sessionPersistence.create(session.header)
    converse(session)
    await recorder.sessionPersistence.flush()
    await write.close()
    await settle()
    const probe = await recorder.sessionManager.read({ sessionId: SESSION })
    expect(probe.map(record => record.kind)).toContain('session-header')
    await recorder.fiber.dispose()

    const restored = await boot([SESSION])
    expect((await restored.sessionManager.read({ sessionId: SESSION })).map(record => record.kind))
      .toContain('thinking')
  })

  it('fills events the live bus never carried', async () => {
    const recorder = new Context()
    contexts.push(recorder)
    await recorder.plugin(SessionStore)
    await recorder.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' })
    const session = recorder.sessions.create(SESSION, { meta: {} })
    const write = await recorder.sessionPersistence.create(session.header)
    converse(session)
    await recorder.sessionPersistence.flush()
    await write.close()

    // Mount the recorder only now: it never saw any of those events.
    await recorder.plugin(SqlSessionManager, { path: storePath })
    expect(await recorder.sessionManager.read({ sessionId: SESSION })).toHaveLength(0)

    await recorder.sessions.flush(session)
    await vi.waitFor(async () => {
      expect((await recorder.sessionManager.read({ sessionId: SESSION })).length).toBeGreaterThan(0)
    })
    const stored = await recorder.sessionManager.read({ sessionId: SESSION })
    // Every appended event is present, so the canonical log can be rebuilt.
    const log = await storedLog(recorder)
    const seqs = stored.filter(record => record.event !== undefined).map(record => record.seq)
    expect(new Set(seqs)).toEqual(new Set(log.events.map(event => event.seq)))
  })

  it('fails loud when the store never captured the session header', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const foreign = join(directory, 'empty.sqlite')
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' })
    await expect(ctx.plugin(SqlSessionManager, { path: foreign, restoreSessions: ['never-seen'] }))
      .rejects.toThrow(/no stored history for session never-seen/)
  })
})
