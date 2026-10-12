/**
 * SessionManagerBackend Service Definition for the DeepSeek Harness.
 *
 * This package owns the CAPTURE side of session interaction recording: which
 * session events carry an interaction, how each becomes a record, the record
 * vocabulary, and the handoff to a storage backend. Everything downstream of
 * {@link SessionManagerSink.record} — connection, schema, batching for the
 * store, retention — belongs to the backend and is deliberately not modelled
 * here. Capture and backend responsibilities are documented in the
 * [Session manager reference](../README.md#understand-the-implementation).
 *
 * @module @deepseek-ai/dsh-session-manager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionInteractionKind, SessionInteractionRecord } from './records.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionManager: SessionManagerBackend
  }
}

/**
 * Which records to read back. Absent fields do not filter: a query with only
 * `sessionId` reads the whole recorded history of that session in identity
 * order.
 */
export interface SessionInteractionQuery {
  /** Session whose records are read. */
  sessionId: SessionId
  /** Read only records at or after this source event sequence number. */
  sinceSeq?: SessionSeq
  /** Read only these kinds; every kind when absent. */
  kinds?: readonly SessionInteractionKind[]
  /** Read only records from these `source.kind` values; every source when absent. */
  sourceKinds?: readonly string[]
  /** Maximum records to return; unbounded when absent. */
  limit?: number
}

/**
 * One session's stored history, complete enough to rebuild its canonical log.
 */
export interface SessionInteractionLog {
  /** The session's header — the canonical log's first frame. */
  header: SessionHeader
  /** Stored events in sequence order, contiguous from the session's first event. */
  events: readonly SessionEvent[]
}

/**
 * The minimum backend contract the coordinator requires.
 * {@link SessionManagerBackend} is its service-registered form; tests compose
 * the coordinator with a bare implementation of this interface.
 */
export interface SessionManagerSink {
  /**
   * Store one batch of records. Records repeat when a session is re-adopted
   * or a batch is retried, so an implementation MUST treat
   * `(sessionId, seq, ordinal)` as the record identity and write idempotently.
   * Rejection is contained by the coordinator and logged; it never reaches the
   * agent loop, and the batch is not retried by the coordinator.
   * @param records - the batch to store, in source order; owned by the backend after the call.
   * @returns resolves when the batch is durable.
   */
  record(records: readonly SessionInteractionRecord[]): Promise<void>
  /**
   * Read recorded interactions back.
   * @param query - which records to read; see {@link SessionInteractionQuery}.
   * @returns the matching records in identity order.
   */
  read(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]>
  /**
   * Read one session's stored history for an exact rebuild.
   *
   * The returned values are parsed from this backend's own earlier writes, and
   * the consumer that re-appends them (`sessionPersistence`) re-validates them,
   * so a damaged row fails loud at restore instead of producing a bad log.
   * @param sessionId - session to read.
   * @returns the header and events, or undefined when this store never captured
   *   the session's header (it was mounted after the session began).
   */
  readSession(sessionId: SessionId): Promise<SessionInteractionLog | undefined>
  /**
   * Flush whatever is buffered and release the backend's own resources.
   * Awaited by the coordinator's disposal; a rejection is logged as a warning
   * and never fails application teardown.
   * @returns resolves when the backend has quiesced.
   */
  shutdown(): Promise<void>
}

/**
 * Loadable form of the backend contract: one implementation per context — the
 * cordis `Service` registration under the `sessionManager` key throws on a
 * duplicate, cordis' standard behavior. A backend composes a
 * {@link SessionManagerCoordinator} in its constructor to install the capture
 * side.
 */
export abstract class SessionManagerBackend extends Service implements SessionManagerSink {
  /**
   * @param ctx - the context this service registers on.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionManager')
  }

  /**
   * See {@link SessionManagerSink.record} — that declaration is the contract's one home.
   * @param records - the batch to store, in source order; owned by the backend after the call.
   */
  abstract record(records: readonly SessionInteractionRecord[]): Promise<void>

  /**
   * See {@link SessionManagerSink.read} — that declaration is the contract's one home.
   * @param query - which records to read; see {@link SessionInteractionQuery}.
   * @returns the matching records in identity order.
   */
  abstract read(query: SessionInteractionQuery): Promise<SessionInteractionRecord[]>

  /**
   * See {@link SessionManagerSink.readSession} — that declaration is the contract's one home.
   * @param sessionId - session to read.
   * @returns the header and events, or undefined when this store never captured the session's header.
   */
  abstract readSession(sessionId: SessionId): Promise<SessionInteractionLog | undefined>

  /**
   * See {@link SessionManagerSink.shutdown} — that declaration is the contract's one home.
   */
  abstract shutdown(): Promise<void>
}

export { SessionManagerCoordinator } from './coordinator.ts'
export {
  eventRecord,
  headerRecord,
  mapSessionEvent,
  type SessionInteractionKind,
  type SessionInteractionRecord,
} from './records.ts'
