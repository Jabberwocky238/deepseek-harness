/** Durable participants, conversations, and directed text messages. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { ParticipantId, ConversationId, ImMessageId, AuthorizationId, Participant, Conversation, Authorization, ImMessage, AgentBinding, ImAttachment } from './types.ts'
export type * from './types.ts'

/** Validates participant identifiers at transport and durable reads. */
export const participantIdSchema = z.string().min(1).transform(value => brandString<ParticipantId>(value))
/** Validates conversation identifiers at transport and durable reads. */
export const conversationIdSchema = z.string().min(1).transform(value => brandString<ConversationId>(value))
/** Validates message identifiers at transport and durable reads. */
export const imMessageIdSchema = z.string().min(1).transform(value => brandString<ImMessageId>(value))
/** Validates authorization identifiers at transport and durable reads. */
export const authorizationIdSchema = z.string().min(1).transform(value => brandString<AuthorizationId>(value))

const participantSchema = z.object({ id: participantIdSchema, kind: z.enum(['human', 'ai']), name: z.string().min(1), namespace: z.string().min(1) })
const conversationSchema = z.object({
  id: conversationIdSchema,
  namespace: z.string().min(1),
  kind: z.enum(['direct', 'group']),
  name: z.string().min(1),
  owner: participantIdSchema,
  members: z.array(participantIdSchema).min(2),
  maxAiMessages: z.number().int().nonnegative(),
})
const contactSchema = z.object({ owner: participantIdSchema, contacts: z.array(participantIdSchema) })
const bindingSchema = z.object({
  conversation: conversationIdSchema, participant: participantIdSchema,
  sessionId: z.string().transform(SessionId), enabled: z.boolean(),
})
const attachmentId = z.string().min(1).transform(value => brandString<AttachmentId>(value))
/** Stored binary references; message bodies retain no local paths or expiring URLs. */
export const imAttachmentSchema: z.ZodType<ImAttachment> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), attachment: z.object({ attachmentId, name: z.string(), bytes: z.number().int().nonnegative() }) }),
  z.object({ type: z.literal('image'), attachment: z.object({
    attachmentId, name: z.string().optional(), bytes: z.number().int().nonnegative(),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    width: z.number().int().positive(), height: z.number().int().positive(),
    originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  }).transform(({ name, originalDimensions, ...rest }) => ({
    ...rest, ...name === undefined ? {} : { name }, ...originalDimensions === undefined ? {} : { originalDimensions },
  })) }),
])
const authorizationSchema = z.object({
  id: authorizationIdSchema,
  conversation: conversationIdSchema,
  from: participantIdSchema,
  to: participantIdSchema,
  direction: z.enum(['one-way', 'two-way']),
})
const messageSchema = z.object({
  id: imMessageIdSchema,
  conversation: conversationIdSchema,
  sender: participantIdSchema,
  recipients: z.array(participantIdSchema).min(1),
  text: z.string(),
  attachments: z.array(imAttachmentSchema),
  mode: z.enum(['interrupt', 'queue']),
  sequence: z.number().int().positive(),
  deliveries: z.record(z.string(), z.enum(['pending', 'queued', 'accepted', 'failed'])),
})

/** The storage owner of IM membership, history, and pending delivery. */
export const imDomain = defineDomain({
  name: 'im', version: 1,
  tables: {
    participants: domainTable<ParticipantId, Participant>(participantSchema),
    conversations: domainTable<ConversationId, Conversation>(conversationSchema),
    authorizations: domainTable<AuthorizationId, Authorization>(authorizationSchema),
    contacts: domainTable<ParticipantId, z.infer<typeof contactSchema>>(contactSchema),
    bindings: domainTable<string, AgentBinding>(bindingSchema),
    messages: domainTable<ImMessageId, ImMessage>(messageSchema),
  },
})
