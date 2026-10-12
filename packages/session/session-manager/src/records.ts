/**
 * The interaction record vocabulary and the mapping from session events to records.
 *
 * One session event produces zero or more records. Every assistant thinking
 * block becomes its own record, so reasoning is addressable and searchable
 * independently of the visible reply, and every tool call and tool result
 * becomes one record carrying the model's own input JSON and the tool's
 * model-facing output.
 *
 * @module @deepseek-ai/dsh-session-manager/records
 */

import type { AssistantStreamRecord, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** What one record captures in the session's interaction history. */
export type SessionInteractionKind =
  | 'session-header'
  | 'session-event'
  | 'user-message'
  | 'assistant-message'
  | 'assistant-attempt'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'

/**
 * One durable interaction record — the unit a storage backend writes and reads
 * back. `(sessionId, seq, ordinal)` is its identity, so an event handed to a
 * backend twice (a re-adopted session, a retried batch) writes the same rows
 * instead of duplicating them.
 */
export interface SessionInteractionRecord {
  /** Session the interaction belongs to. */
  sessionId: SessionId
  /** Sequence number of the source session event. */
  seq: SessionSeq
  /** Position of this record within its source event, counted from zero. */
  ordinal: number
  /** Source event append time, Unix epoch milliseconds. */
  time: number
  /** Turn the interaction belongs to; absent on events outside a turn. */
  turn?: number
  /** Step the interaction belongs to; absent on events outside a step. */
  step?: number
  /** What this record captures. */
  kind: SessionInteractionKind
  /**
   * `source.kind` of the message the record came from — `user` for a human
   * prompt, `model` for assistant output, `tool` for a tool result, and any
   * merge-extensible producer kind (for example `runtime-context` or
   * `time-context` for injected context that still arrives as `user/message`).
   * Absent where the source event carries no source.
   */
  sourceKind?: string
  /** Tool call pairing a call with its result; present on tool records. */
  callId?: string
  /** Tool name; present on `tool-call`. */
  name?: string
  /**
   * The record's searchable text: a message's visible text, one thinking
   * block, the raw tool arguments JSON exactly as the model produced it, or a
   * tool result's model-facing text.
   */
  text?: string
  /** Complete payload for reconstruction, JSON-serializable and owned by the record. */
  body: JsonValue
  /**
   * Raw source event JSON, present on the FIRST record of each event and absent
   * on every later record of the same event. It is what makes an exact rebuild
   * possible: the normalized `body` of a record drops fields the canonical log
   * needs (an assistant message's timed `stream`, surface metadata).
   */
  event?: string
}

/** Visible text of one content block list; non-text blocks contribute nothing. */
function visibleText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      default:
        // Merge-extensible block vocabulary: reasoning is captured as its own
        // record, and every other block carries no visible reply text.
        break
    }
  }
  return parts.join('')
}

/**
 * Ordinal reserved for the one record that is not part of its event's own
 * ordering — the session header, which sorts before the event it borrows.
 */
export const HEADER_ORDINAL = -1

/** One thinking block and the position it occupies in its source. */
interface Thinking {
  /** Index of the block within the assistant message content or attempt stream. */
  readonly blockIndex: number
  /** The reasoning text, joined exactly as the stream or message delivered it. */
  readonly text: string
}

/** Thinking blocks of one assembled assistant message, in content order. */
function messageThinking(content: readonly ContentBlock[]): Thinking[] {
  const found: Thinking[] = []
  content.forEach((block, blockIndex) => {
    if (block.type === 'reasoning') found.push({ blockIndex, text: block.text })
  })
  return found
}

/**
 * Thinking blocks of one attempt stream, in first-appearance order. An attempt
 * committed no surface message, so this is the only place its reasoning survives.
 */
function attemptThinking(stream: readonly AssistantStreamRecord[]): Thinking[] {
  const index = new Map<number, string>()
  for (const record of stream) {
    if (record.type !== 'reasoning-chunks') continue
    index.set(record.index, (index.get(record.index) ?? '') + record.texts.join(''))
  }
  return [...index].map(([blockIndex, text]) => ({ blockIndex, text }))
}

/**
 * Deep-copy one payload into the record body. The round trip proves the value
 * is JSON-serializable — the same property `Session.append` enforces on event
 * data — and detaches the body from the event the session store still owns.
 */
function bodyOf(payload: object): JsonValue {
  return JSON.parse(JSON.stringify(payload)) as JsonValue
}

/** Record builders that keep ordinal assignment in one place. */
class RecordBatch {
  private readonly records: SessionInteractionRecord[] = []

  /**
   * @param sessionId - session every record in this batch belongs to.
   * @param event - envelope supplying `seq` and `time`.
   */
  constructor(private readonly sessionId: SessionId, private readonly event: SessionEvent) {}

  /**
   * Append one record, taking the next ordinal.
   * @param record - the record body without identity fields.
   * @returns nothing; records are read back through {@link take}.
   */
  add(record: Omit<SessionInteractionRecord, 'sessionId' | 'seq' | 'ordinal' | 'time'>): void {
    this.records.push({
      sessionId: this.sessionId,
      seq: this.event.seq,
      ordinal: this.records.length,
      time: this.event.time,
      ...this.records.length === 0 ? { event: JSON.stringify(this.event) } : {},
      ...record,
    })
  }

  /**
   * @returns the batch's records in append order.
   */
  take(): SessionInteractionRecord[] {
    return this.records
  }
}

/**
 * Build the one record that carries a session's header.
 *
 * The header is not an event, so the record borrows the sequence number of the
 * first event this store observed and takes the ordinal `-1`: it sorts before
 * that event's own records without occupying a sequence number of its own. A
 * restored log needs it, because the canonical file's first frame is the header.
 * @param sessionId - session the header belongs to.
 * @param header - the session's header, as the session store holds it.
 * @param time - capture time, Unix epoch milliseconds.
 * @param seq - sequence number of the first observed event.
 * @returns the header record.
 */
export function headerRecord(
  sessionId: SessionId,
  header: object,
  time: number,
  seq: SessionSeq,
): SessionInteractionRecord {
  return {
    sessionId,
    seq,
    ordinal: HEADER_ORDINAL,
    time,
    kind: 'session-header',
    body: bodyOf(header),
  }
}

/**
 * Build the one record that carries an event with no interaction of its own.
 *
 * Turn, step, header, and plugin events are not interactions, but an exact
 * rebuild must reproduce them, so each still gets a row holding its raw JSON.
 * @param sessionId - session the event belongs to.
 * @param event - the appended event.
 * @returns the record carrying the event verbatim.
 */
export function eventRecord(sessionId: SessionId, event: SessionEvent): SessionInteractionRecord {
  return {
    sessionId,
    seq: event.seq,
    ordinal: 0,
    time: event.time,
    kind: 'session-event',
    body: bodyOf(event.data),
    event: JSON.stringify(event),
  }
}

/**
 * Map one session event to its interaction records.
 *
 * Recognized events: `user/message`, `assistant/message`, `assistant/attempt`,
 * `tool/call`, and `tool/result`. Boundary, header, system, developer, and
 * plugin events produce no records here — they carry no human or model
 * interaction of their own, and the coordinator records them through
 * {@link eventRecord} instead.
 * @param sessionId - session the event belongs to.
 * @param event - the canonical event as appended to the session log.
 * @returns the records this event contributes, in order; empty when the event
 *   carries no interaction.
 */
export function mapSessionEvent(sessionId: SessionId, event: SessionEvent): SessionInteractionRecord[] {
  const batch = new RecordBatch(sessionId, event)
  switch (event.type) {
    case 'user/message':
      batch.add({
        kind: 'user-message',
        sourceKind: event.data.source.kind,
        text: visibleText(event.data.content),
        body: bodyOf({ message: event.data }),
      })
      break
    case 'assistant/message':
      batch.add({
        kind: 'assistant-message',
        sourceKind: event.data.message.source.kind,
        turn: event.data.turn,
        step: event.data.step,
        text: visibleText(event.data.message.content),
        body: bodyOf({ message: event.data.message, usage: event.data.usage, interrupted: event.data.interrupted }),
      })
      for (const thinking of messageThinking(event.data.message.content)) {
        batch.add({
          kind: 'thinking',
          sourceKind: event.data.message.source.kind,
          turn: event.data.turn,
          step: event.data.step,
          text: thinking.text,
          body: bodyOf({ text: thinking.text, blockIndex: thinking.blockIndex, source: 'message' }),
        })
      }
      break
    case 'assistant/attempt':
      batch.add({
        kind: 'assistant-attempt',
        turn: event.data.turn,
        step: event.data.step,
        body: bodyOf({ stream: event.data.stream }),
      })
      for (const thinking of attemptThinking(event.data.stream)) {
        batch.add({
          kind: 'thinking',
          turn: event.data.turn,
          step: event.data.step,
          text: thinking.text,
          body: bodyOf({ text: thinking.text, blockIndex: thinking.blockIndex, source: 'attempt' }),
        })
      }
      break
    case 'tool/call':
      // A tool call's event carries no source of its own; the model requested it.
      batch.add({
        kind: 'tool-call',
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.callId,
        name: event.data.name,
        text: event.data.arguments,
        body: bodyOf({ name: event.data.name, arguments: event.data.arguments }),
      })
      break
    case 'tool/result':
      batch.add({
        kind: 'tool-result',
        sourceKind: event.data.message.source.kind,
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.message.toolCallId,
        text: visibleText(event.data.message.content),
        body: bodyOf({ message: event.data.message, error: event.data.error, meta: event.data.meta }),
      })
      break
    default:
      // Every other event type is a boundary marker, header, or context record
      // with no interaction of its own.
      break
  }
  return batch.take()
}
