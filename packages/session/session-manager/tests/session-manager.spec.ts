import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type AssistantStreamRecord,
} from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  SessionManagerCoordinator,
  mapSessionEvent,
  type SessionInteractionRecord,
  type SessionManagerSink,
} from '../src/index.ts'

/** Model source shared by the assistant fixtures. */
const MODEL_SOURCE = { provider: 'deepseek-official', model: 'deepseek-flash' }

class FakeBackend implements SessionManagerSink {
  batches: SessionInteractionRecord[][] = []
  readResult: SessionInteractionRecord[] = []
  recordError: Error | undefined
  shutdownCalls = 0

  async record(records: readonly SessionInteractionRecord[]): Promise<void> {
    if (this.recordError !== undefined) throw this.recordError
    this.batches.push([...records])
  }

  async read(): Promise<SessionInteractionRecord[]> {
    return this.readResult
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1
  }

  /** Every record handed over, in handoff order. */
  records(): SessionInteractionRecord[] {
    return this.batches.flat()
  }
}

async function setup(backend = new FakeBackend()) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  let coordinator!: SessionManagerCoordinator
  const fiber = await ctx.plugin({
    name: 'fake-session-manager',
    inject: ['sessions'],
    apply: (inner: Context) => {
      coordinator = new SessionManagerCoordinator(inner, backend)
    },
  })
  return { ctx, backend, coordinator, fiber }
}

async function liveSession(ctx: Context, id = `s-${Math.random().toString(36).slice(2)}`): Promise<Session> {
  return ctx.sessions.create(SessionId(id), { meta: {} })
}

describe('mapSessionEvent', () => {
  it('records a user message with its visible text', () => {
    const session = SessionId('s-1')
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const records = mapSessionEvent(session, {
      type: 'user/message', seq: 1 as never, time: 7, data: message, surfaceOp: 'append',
    })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'user-message', sourceKind: 'user', text: 'hello', seq: 1, ordinal: 0, time: 7,
    })
  })

  it('records every thinking block separately, in content order, after the message', () => {
    const session = SessionId('s-2')
    const message = createAssistantMessage({
      source: MODEL_SOURCE,
      content: [
        { type: 'reasoning', text: 'first thought' },
        { type: 'text', text: 'the reply' },
        { type: 'reasoning', text: 'second thought' },
      ],
    })
    const records = mapSessionEvent(session, {
      type: 'assistant/message',
      seq: 4 as never,
      time: 9,
      data: { turn: 1, step: 2, message, stream: [] },
      surfaceOp: 'append',
    })
    expect(records.map(record => [record.kind, record.ordinal, record.text])).toEqual([
      ['assistant-message', 0, 'the reply'],
      ['thinking', 1, 'first thought'],
      ['thinking', 2, 'second thought'],
    ])
    expect(records.every(record => record.turn === 1 && record.step === 2)).toBe(true)
    expect(records.map(record => record.sourceKind)).toEqual(['model', 'model', 'model'])
  })

  it('records the tool call input verbatim and the tool result output', () => {
    const session = SessionId('s-3')
    const callId = ToolCallId('call-1')
    const call = mapSessionEvent(session, {
      type: 'tool/call', seq: 5 as never, time: 11,
      data: { turn: 1, step: 2, callId, name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(call).toHaveLength(1)
    expect(call[0]).toMatchObject({ kind: 'tool-call', callId: 'call-1', name: 'bash', text: '{"command":"ls"}' })

    const result = mapSessionEvent(session, {
      type: 'tool/result',
      seq: 6 as never,
      time: 12,
      data: {
        turn: 1,
        step: 2,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'file-a\nfile-b' }] }),
      },
      surfaceOp: 'append',
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'tool-result', callId: 'call-1', text: 'file-a\nfile-b' })
  })

  it('records the thinking of an attempt that committed no message', () => {
    const session = SessionId('s-4')
    const stream: AssistantStreamRecord[] = [
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [1, 2], texts: ['half ', 'a thought'] },
      { type: 'text-chunks', time0: 3, index: 1, dt: [1], texts: ['never shown'] },
    ]
    const records = mapSessionEvent(session, {
      type: 'assistant/attempt', seq: 8 as never, time: 13, data: { turn: 2, step: 1, stream },
    })
    expect(records.map(record => [record.kind, record.ordinal, record.text])).toEqual([
      ['assistant-attempt', 0, undefined],
      ['thinking', 1, 'half a thought'],
    ])
    expect(records[1]?.body).toMatchObject({ source: 'attempt', blockIndex: 0 })
  })

  it('keeps the producer kind of injected context that arrives as a user message', () => {
    const session = SessionId('s-6')
    const message = createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context.' }],
      source: { kind: 'runtime-context' } as never,
    })
    const records = mapSessionEvent(session, {
      type: 'user/message', seq: 2 as never, time: 8, data: message, surfaceOp: 'append',
    })
    expect(records.map(record => record.sourceKind)).toEqual(['runtime-context'])
  })

  it('contributes nothing for boundary and header events', () => {
    expect(mapSessionEvent(SessionId('s-5'), {
      type: 'turn/start', seq: 0 as never, time: 1, data: { turn: 1 },
    })).toEqual([])
  })
})

describe('SessionManagerCoordinator', () => {
  it('hands one batch per appended event with stable record identity', async () => {
    const { ctx, backend, coordinator } = await setup()
    const session = await liveSession(ctx)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await coordinator.flush()

    const records = backend.records()
    expect(records.map(record => [record.kind, record.seq, record.ordinal])).toEqual([
      ['session-header', 0, -1],
      ['session-event', 0, 0],
      ['user-message', 1, 0],
    ])
    expect(records[2]).toMatchObject({ sessionId: session.id, kind: 'user-message' })
  })

  it('keeps identity stable when the same event is captured twice', async () => {
    const { ctx, backend, coordinator } = await setup()
    const session = await liveSession(ctx)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'again' }], source: { kind: 'user' },
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    await coordinator.flush()
    // A rehanded batch carries the same identity, which is what makes storage idempotent.
    await coordinator.flush()
    expect(backend.records().map(record => [record.seq, record.ordinal])).toEqual([[0, -1], [0, 0]])
  })

  it('contains a rejected batch, logs it, and keeps later batches flowing', async () => {
    const { ctx, backend, coordinator } = await setup()
    backend.recordError = new Error('database down')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = await liveSession(ctx)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'lost' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await coordinator.flush()
    expect(warn).toHaveBeenCalled()

    backend.recordError = undefined
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'kept' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await coordinator.flush()
    expect(backend.records().filter(record => record.kind === 'user-message').map(record => record.text))
      .toEqual(['kept'])
  })

  it('drains the buffer and shuts the backend down once on disposal', async () => {
    const { ctx, backend, fiber } = await setup()
    const session = await liveSession(ctx)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tail' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await fiber.dispose()
    expect(backend.records().filter(record => record.kind === 'user-message').map(record => record.text))
      .toEqual(['tail'])
    expect(backend.shutdownCalls).toBe(1)
  })
})
