/**
 * Capture coordinator for the session-manager capability. It subscribes to the
 * session event firehose, maps each event to interaction records, and hands
 * them to the backend in append order. Composed by a backend in its
 * constructor so the backend owns only storage.
 *
 * Every handler is self-contained: cordis `emit` is stop-on-throw, so a failing
 * backend must never starve other subscribers or reach the agent loop. A
 * rejected or unmappable batch is logged and dropped — the coordinator does not
 * retry, and the record identity `(sessionId, seq, ordinal)` lets a backend or
 * a later reader repair a gap from the canonical session log.
 *
 * @module @deepseek-ai/dsh-session-manager/coordinator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { eventRecord, headerRecord, mapSessionEvent, type SessionInteractionRecord } from './records.ts'
import type { SessionManagerSink } from './backend.ts'

/**
 * Install interaction capture for one backend.
 *
 * Records accumulate for the remainder of the current microtask queue, so one
 * appended event — a message with its thinking blocks, or one tool call —
 * reaches the backend as one batch without the coordinator holding a timer.
 * Disposal drains the buffer and then awaits the backend's own shutdown; a
 * failure there warns instead of throwing, because recording must not fail
 * application teardown.
 */
export class SessionManagerCoordinator {
  /** Buffered records not yet handed to the backend. */
  private pending: SessionInteractionRecord[] = []
  /** Serializes backend writes so batches reach storage in append order. */
  private writes: Promise<void> = Promise.resolve()
  /** Whether a microtask flush is already scheduled for the current buffer. */
  private scheduled = false
  /** Set once disposal ran, so late events append nothing. */
  private disposed = false
  /** Sessions whose header record was already captured. */
  private readonly adopted = new WeakSet<Session>()

  /**
   * @param ctx - the composing backend's context; listeners bind to its fiber.
   * @param sink - the backend receiving record batches; owned elsewhere, never
   *   disposed here beyond `shutdown()` forwarding.
   */
  constructor(private readonly ctx: Context, private readonly sink: SessionManagerSink) {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.contain(() => {
        this.capture(session, event)
      })
    })
    ctx.effect(() => async () => {
      await this.drainAndShutdown()
    }, 'session manager capture')
  }

  /**
   * Run one handler so its failure cannot interrupt other subscribers.
   * @param handler - the capture work for one session event.
   */
  private contain(handler: () => void): void {
    try {
      handler()
    } catch (error: unknown) {
      this.ctx.logger.warn('session manager: capture failed: %o', error)
    }
  }

  /**
   * Map one appended event and buffer its records.
   * @param session - the session the event was appended to.
   * @param event - the appended event.
   */
  private capture(session: Session, event: SessionEvent): void {
    if (this.disposed) return
    const records: SessionInteractionRecord[] = []
    if (!this.adopted.has(session)) {
      // A restored log needs the header as its first frame, so it is captured
      // at the first event this store sees for the session.
      this.adopted.add(session)
      records.push(headerRecord(session.id, session.header, event.time, event.seq))
    }
    const mapped = mapSessionEvent(session.id, event)
    // An event with no interaction still keeps its raw JSON, so a rebuild
    // reproduces the canonical log rather than a gap where a turn began.
    records.push(...mapped.length > 0 ? mapped : [eventRecord(session.id, event)])
    this.pending.push(...records)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.flush()
    })
  }

  /**
   * Hand every buffered record to the backend. Safe to call directly at a turn
   * boundary or from a test; concurrent callers serialize behind each other.
   * @returns resolves after the batch reaches the backend, or after the backend
   *   rejects and the failure is logged.
   */
  async flush(): Promise<void> {
    const batch = this.pending
    if (batch.length === 0) return this.writes
    this.pending = []
    this.writes = this.writes
      .then(() => this.sink.record(batch))
      .catch((error: unknown) => {
        this.ctx.logger.warn('session manager: storing %d interaction records failed: %o', batch.length, error)
      })
    return this.writes
  }

  /**
   * Flush the tail and close the backend exactly once.
   * @returns resolves when the backend has quiesced.
   */
  async drainAndShutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.flush()
    try {
      await this.sink.shutdown()
    } catch (error: unknown) {
      this.ctx.logger.warn('session manager: backend shutdown failed: %o', error)
    }
  }
}
