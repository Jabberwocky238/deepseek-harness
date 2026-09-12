/** Platform-neutral IM records shared by host services and human panels. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable person or AI identity. */
export type ParticipantId = Branded<'ImParticipantId'>
/** Stable chat identity, independent of Agent Sessions and external platform chats. */
export type ConversationId = Branded<'ImConversationId'>
/** Sender-supplied message idempotency identity. */
export type ImMessageId = Branded<'ImMessageId'>
/** Identity of an externally managed AI communication grant. */
export type AuthorizationId = Branded<'ImAuthorizationId'>
/** Immediate interruption or admission before the next unstarted tool. */
export type DeliveryMode = 'interrupt' | 'queue'
/** Person or AI belonging to one explicit platform namespace. */
export interface Participant {
  id: ParticipantId
  kind: 'human' | 'ai'
  name: string
  namespace: string
}
/** Human-managed direct chat or group with a bounded AI publication budget. */
export interface Conversation {
  id: ConversationId
  namespace: string
  kind: 'direct' | 'group'
  name: string
  owner: ParticipantId
  members: ParticipantId[]
  maxAiMessages: number
}
/** Directional permission independent of contact lists and group membership. */
export interface Authorization {
  id: AuthorizationId
  conversation: ConversationId
  from: ParticipantId
  to: ParticipantId
  direction: 'one-way' | 'two-way'
}
/** Picture or verbatim file that human readers can view or download. */
export type ImAttachment = { type: 'file'; attachment: FileAttachmentRef } | { type: 'image'; attachment: ImageAttachmentRef }
/** Durable chat content plus each recipient's independent inbox receipt. */
export interface ImMessage {
  id: ImMessageId
  conversation: ConversationId
  sender: ParticipantId
  recipients: ParticipantId[]
  text: string
  attachments: ImAttachment[]
  mode: DeliveryMode
  sequence: number
  deliveries: Record<string, 'pending' | 'queued' | 'accepted' | 'failed'>
}
/** Caller-owned message input; the distributor assigns order and receipts. */
export type MessageInput = Omit<ImMessage, 'sequence' | 'deliveries'>
/** Dedicated resumable Session for one AI and conversation. */
export interface AgentBinding {
  conversation: ConversationId
  participant: ParticipantId
  sessionId: SessionId
  enabled: boolean
}
