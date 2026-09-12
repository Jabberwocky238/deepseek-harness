/** Persistent directed messaging shared by human and AI channel adapters. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { imDomain } from './model.ts'
import type { AgentBinding, Authorization, AuthorizationId, Conversation, ConversationId, ImMessage, ImMessageId, MessageInput, Participant, ParticipantId } from './model.ts'

export * from './model.ts'
export { attachAgent } from './agent.ts'

/** Cordis function-plugin name. */
export const name = 'im'
/** Durable domain storage must be mounted before accepting messages. */
export const inject = ['storageDomain']

/** Deployment limits on retained IM records and admitted text. */
export interface Config {
  /** Maximum number of participants retained by this service. */
  maxParticipants: number
  /** Maximum number of conversations retained by this service. */
  maxConversations: number
  /** Maximum number of messages retained across conversations. */
  maxMessages: number
  /** Maximum UTF-8 bytes in one text message. */
  maxTextBytes: number
  /** Maximum attachment bytes per message, before storing or reading a file. */
  maxAttachmentBytes: number
  /** Maximum attachment count per message. */
  maxAttachments: number
}

/** Explicit deployment limits; reaching a limit rejects new records without deleting history. */
export const Config: z<Config> = z.object({
  maxParticipants: z.number().step(1).min(2).required(),
  maxConversations: z.number().step(1).min(1).required(),
  maxMessages: z.number().step(1).min(1).required(),
  maxTextBytes: z.number().step(1).min(1).required(),
  maxAttachmentBytes: z.number().step(1).min(1).required(),
  maxAttachments: z.number().step(1).min(1).required(),
})

/** A channel accepts a committed message; acceptance is not a human read receipt. */
export type MessageReceiver = (message: ImMessage, signal: AbortSignal) => Promise<void | 'queued'>

interface Receiver {
  receive: MessageReceiver
  lifetime: AbortController
  tail: Promise<void>
  scheduled: Set<ImMessageId>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    im: ImService
  }
}

/** Trusted host API; adapters authenticate identities before calling it. */
export class ImService {
  private tail = Promise.resolve()
  private readonly receivers = new Map<string, Receiver>()
  private closed = false

  constructor(
    private readonly domain: Domain<typeof imDomain>, private readonly config: Config, private readonly reportFailure: () => void,
  ) {}

  /**
   * Admit an identity, or return its identical existing record. Changes reject.
   * @param participant - authenticated person or composition-owned AI.
   * @returns after durable registration.
   */
  addParticipant(participant: Participant): Promise<void> {
    return this.mutate(async () => {
      const table = this.domain.table('participants')
      const prior = table.get(participant.id)
      if (prior !== undefined) {
        if (prior.kind !== participant.kind || prior.name !== participant.name || prior.namespace !== participant.namespace) throw new Error('IM participant identity conflict')
        return
      }
      if (table.size >= this.config.maxParticipants) throw new Error('IM participant limit reached')
      await table.put(participant.id, structuredClone(participant))
    })
  }

  /**
   * Create a conversation with explicit existing members; repeated identical creation is idempotent.
   * @param conversation - fixed membership shared by people and AIs.
   * @returns after durable creation; rejects unknown or duplicate members.
   */
  addConversation(conversation: Conversation): Promise<void> {
    return this.mutate(async () => {
      if (conversation.members.length < 2 || new Set(conversation.members).size !== conversation.members.length) {
        throw new Error('IM conversation requires distinct members')
      }
      for (const member of conversation.members) {
        if (this.participant(member).namespace !== conversation.namespace) throw new Error('IM conversation cannot cross platform namespaces')
      }
      if (this.participant(conversation.owner).kind !== 'human' || this.participant(conversation.owner).namespace !== conversation.namespace
        || (conversation.kind === 'group' && !conversation.members.includes(conversation.owner))) throw new Error('IM conversation requires a same-platform human owner; group owners must be members')
      if (conversation.kind === 'direct' && conversation.members.length !== 2) throw new Error('IM direct conversation requires exactly two members')
      const table = this.domain.table('conversations')
      const prior = table.get(conversation.id)
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(conversation)) throw new Error('IM conversation membership conflict')
        return
      }
      if (table.size >= this.config.maxConversations) throw new Error('IM conversation limit reached')
      await table.put(conversation.id, structuredClone(conversation))
    })
  }

  /**
   * Commit one directed message before scheduling recipient acceptance. AI recipients are explicit.
   * @param input - authenticated sender, same-conversation recipients, and delivery mode.
   * @returns the durable message; duplicate ids require identical content and routing.
   */
  async send(input: MessageInput): Promise<ImMessage> {
    const message = await this.mutate(async () => {
      this.requireMember(input.conversation, input.sender)
      if (input.recipients.length === 0 || new Set(input.recipients).size !== input.recipients.length) throw new Error('IM recipients must be distinct and nonempty')
      for (const recipient of input.recipients) {
        this.requireMember(input.conversation, recipient)
        if (recipient === input.sender) throw new Error('IM messages cannot target their sender')
      }
      if ((input.text.trim() === '' && input.attachments.length === 0) || Buffer.byteLength(input.text) > this.config.maxTextBytes) throw new Error('IM message is empty or text exceeds the byte limit')
      if (input.attachments.length > this.config.maxAttachments
        || input.attachments.reduce((total, item) => total + item.attachment.bytes, 0) > this.config.maxAttachmentBytes) throw new Error('IM attachments exceed the configured limit')
      const table = this.domain.table('messages')
      const prior = table.get(input.id)
      if (prior !== undefined) {
        if (prior.conversation !== input.conversation || prior.sender !== input.sender || prior.text !== input.text
          || prior.mode !== input.mode || JSON.stringify(prior.recipients) !== JSON.stringify(input.recipients)
          || JSON.stringify(prior.attachments) !== JSON.stringify(input.attachments)) throw new Error('IM message id conflict')
        return prior
      }
      if (table.size >= this.config.maxMessages) throw new Error('IM message limit reached')
      const conversation = this.domain.table('conversations').get(input.conversation)
      if (conversation === undefined) throw new Error('IM conversation is missing')
      if (this.participant(input.sender).kind === 'ai') {
        for (const recipient of input.recipients) {
          if (this.participant(recipient).kind === 'ai'
            && !this.isAuthorized(input.conversation, input.sender, recipient)) throw new Error('IM AI communication is not authorized')
        }
        const used = [...table.entries()].filter(([, row]) => row.conversation === input.conversation
          && this.participant(row.sender).kind === 'ai').length
        if (used >= conversation.maxAiMessages) throw new Error('IM conversation AI message budget exhausted')
      }
      let sequence = 1
      for (const [, row] of table.entries()) {
        if (row.conversation === input.conversation) sequence = Math.max(sequence, row.sequence + 1)
      }
      const created: ImMessage = {
        ...structuredClone(input), sequence,
        deliveries: Object.fromEntries(input.recipients.map(id => [id, 'pending' as const])),
      }
      await table.put(created.id, created)
      return created
    })
    for (const recipient of message.recipients) this.schedule(message, recipient)
    return structuredClone(message)
  }

  /**
   * Read ordered chat history visible to a member, including messages addressed to other members.
   * @param conversation - conversation to read.
   * @param member - authenticated member requesting history.
   * @param after - exclusive sequence cursor; zero starts at the beginning.
   * @returns immutable-by-ownership copies in conversation order.
   */
  history(conversation: ConversationId, member: ParticipantId, after: number): ImMessage[] {
    if (this.domain.table('conversations').get(conversation)?.owner !== member) this.requireMember(conversation, member)
    return [...this.domain.table('messages').entries()].map(([, message]) => message)
      .filter(message => message.conversation === conversation && message.sequence > after)
      .sort((a, b) => a.sequence - b.sequence).map(message => structuredClone(message))
  }

  /**
   * Read an admitted identity for channel presentation and Agent admission.
   * @param id - participant identity.
   * @returns an owned copy; rejects an unknown identity.
   */
  participant(id: ParticipantId): Participant {
    const participant = this.domain.table('participants').get(id)
    if (participant === undefined) throw new Error('IM participant not found')
    return structuredClone(participant)
  }

  /**
   * List a member's conversations within exactly one platform namespace.
   * @param member - externally authenticated participant.
   * @param namespace - native IM or an adapter-owned platform namespace.
   * @returns owned conversation copies; platform groups remain separate.
   */
  conversations(member: ParticipantId, namespace: string): Conversation[] {
    if (this.participant(member).namespace !== namespace) throw new Error('IM participant belongs to another namespace')
    return [...this.domain.table('conversations').entries()].map(([, value]) => value)
      .filter(value => value.namespace === namespace && (value.members.includes(member) || value.owner === member))
      .map(value => structuredClone(value))
  }

  /**
   * Add one same-platform identity to a human's private contact list; this grants no AI communication permission.
   * @param human - externally authenticated contact-list owner.
   * @param contact - existing human or AI identity.
   * @returns after durable insertion; repeats are idempotent.
   */
  addContact(human: ParticipantId, ownerId: ParticipantId, contact: ParticipantId): Promise<void> {
    return this.mutate(async () => {
      const owner = this.participant(ownerId)
      if (this.participant(human).kind !== 'human' || this.participant(human).namespace !== owner.namespace
        || ownerId === contact || owner.namespace !== this.participant(contact).namespace) throw new Error('IM contacts require external human administration and distinct same-platform participants')
      const table = this.domain.table('contacts')
      const current = table.get(ownerId)?.contacts ?? []
      if (!current.includes(contact)) await table.put(ownerId, { owner: ownerId, contacts: [...current, contact] })
    })
  }

  /**
   * Remove a private contact without removing conversation membership or authorization.
   * @param human - externally authenticated human list owner.
   * @param contact - identity to remove.
   * @returns after durable removal; absent contacts are ignored.
   */
  removeContact(human: ParticipantId, ownerId: ParticipantId, contact: ParticipantId): Promise<void> {
    return this.mutate(async () => {
      if (this.participant(human).kind !== 'human') throw new Error('IM contacts require a human owner')
      const table = this.domain.table('contacts')
      if (this.participant(human).namespace !== this.participant(ownerId).namespace) throw new Error('IM contact administrator belongs to another namespace')
      const current = table.get(ownerId)
      if (current?.contacts.includes(contact)) {
        await table.put(ownerId, { owner: ownerId, contacts: current.contacts.filter(id => id !== contact) })
      }
    })
  }

  /**
   * Read an authenticated human's private contact list.
   * @param human - externally authenticated list owner.
   * @returns owned participant copies; contacts do not imply group membership.
   */
  contacts(human: ParticipantId): Participant[] {
    this.participant(human)
    return (this.domain.table('contacts').get(human)?.contacts ?? []).map(id => this.participant(id))
  }

  /**
   * Rename an owned group.
   * @param human - externally authenticated group owner.
   * @param id - existing group identity.
   * @param name - nonempty displayed group name.
   * @returns after durable replacement.
   */
  renameGroup(human: ParticipantId, id: ConversationId, name: string): Promise<void> {
    return this.mutate(async () => {
      this.requireGroupOwner(id, human)
      if (name.trim() === '') throw new Error('IM group name must not be empty')
      await this.domain.table('conversations').update(id, current => ({ ...current, name }))
    })
  }

  /**
   * Add one existing same-platform participant to an owned group.
   * @param human - externally authenticated group owner.
   * @param id - group identity.
   * @param member - human or AI identity; AI permissions remain independent.
   * @returns after durable membership update; existing membership is unchanged.
   */
  addGroupMember(human: ParticipantId, id: ConversationId, member: ParticipantId): Promise<void> {
    return this.mutate(async () => {
      const group = this.requireGroupOwner(id, human)
      if (this.participant(member).namespace !== group.namespace) throw new Error('IM group cannot cross platform namespaces')
      if (!group.members.includes(member)) await this.domain.table('conversations').put(id, { ...group, members: [...group.members, member] })
    })
  }

  /**
   * Remove a member or let a member leave; the owner must remain and groups retain at least two members.
   * @param actor - externally authenticated owner, or the leaving member.
   * @param id - group identity.
   * @param member - member to remove.
   * @returns after durable removal; future history, sends, and queued channel admission reject membership loss.
   */
  removeGroupMember(actor: ParticipantId, id: ConversationId, member: ParticipantId): Promise<void> {
    return this.mutate(async () => {
      this.requireMember(id, actor)
      const group = this.domain.table('conversations').get(id)
      if (group === undefined) throw new Error('IM conversation is missing')
      if (group.kind !== 'group' || (actor !== member && actor !== group.owner)) throw new Error('IM group owner required')
      if (member === group.owner || group.members.length <= 2) throw new Error('IM group must retain its owner and two members')
      for (const [key, authorization] of this.domain.table('authorizations').entries()) {
        if (authorization.conversation === id && (authorization.from === member || authorization.to === member)) await this.domain.table('authorizations').delete(key)
      }
      await this.domain.table('conversations').put(id, { ...group, members: group.members.filter(value => value !== member) })
    })
  }

  /**
   * Grant AI communication permission. Only externally authenticated human members can administer it.
   * @param human - human identity authenticated by the external caller.
   * @param authorization - two AI members and the permitted direction.
   * @returns after durable creation; duplicate authorization ids reject.
   */
  grantAuthorization(human: ParticipantId, authorization: Authorization): Promise<void> {
    return this.mutate(async () => {
      this.validateAuthorization(human, authorization)
      const table = this.domain.table('authorizations')
      if (table.get(authorization.id) !== undefined) throw new Error('IM authorization already exists')
      await table.put(authorization.id, structuredClone(authorization))
    })
  }

  /**
   * Replace the endpoints or direction of an existing authorization in its original conversation.
   * @param human - externally authenticated human member.
   * @param id - existing authorization identity.
   * @param changes - complete new endpoints and direction.
   * @returns after durable replacement; subsequent sends use the replacement.
   */
  updateAuthorization(human: ParticipantId, id: AuthorizationId, changes: Pick<Authorization, 'from' | 'to' | 'direction'>): Promise<void> {
    return this.mutate(async () => {
      const table = this.domain.table('authorizations')
      const prior = table.get(id)
      if (prior === undefined) throw new Error('IM authorization not found')
      const updated = { ...prior, ...structuredClone(changes) }
      this.validateAuthorization(human, updated)
      await table.put(id, updated)
    })
  }

  /**
   * Remove one permission without retracting messages already committed under it.
   * @param human - externally authenticated human member.
   * @param id - existing authorization identity.
   * @returns after durable removal; subsequent sends require another applicable grant.
   */
  revokeAuthorization(human: ParticipantId, id: AuthorizationId): Promise<void> {
    return this.mutate(async () => {
      const table = this.domain.table('authorizations')
      const prior = table.get(id)
      if (prior === undefined) throw new Error('IM authorization not found')
      this.validateAuthorization(human, prior)
      await table.delete(id)
    })
  }

  /**
   * Register one conversation recipient and resume its pending deliveries. Own this registration with ctx.effect().
   * @param conversation - conversation whose messages the adapter accepts.
   * @param recipient - authenticated member served by the adapter.
   * @param receive - resolves on acceptance, not on AI completion or human reading.
   * @returns an async disposer that stops admission and drains outstanding acceptance.
   */
  register(conversation: ConversationId, recipient: ParticipantId, receive: MessageReceiver): () => Promise<void> {
    this.requireMember(conversation, recipient)
    if (this.closed) throw new Error('IM service is closed')
    const key = JSON.stringify([conversation, recipient])
    if (this.receivers.has(key)) throw new Error('IM recipient already registered')
    const receiver: Receiver = { receive, lifetime: new AbortController(), tail: Promise.resolve(), scheduled: new Set() }
    this.receivers.set(key, receiver)
    for (const message of this.history(conversation, recipient, 0)) this.schedule(message, recipient)
    return async () => {
      this.receivers.delete(key)
      receiver.lifetime.abort()
      await receiver.tail
    }
  }

  /**
   * Retry a failed delivery without recreating the chat message; channels must deduplicate ambiguous acknowledgements.
   * @param id - committed message to retry.
   * @param recipient - target member whose acceptance failed.
   * @returns after durable requeue, before channel acceptance.
   */
  async retry(id: ImMessageId, recipient: ParticipantId): Promise<void> {
    const message = await this.mutate(async () => this.domain.table('messages').update(id, (current) => {
      if (current.deliveries[recipient] !== 'failed') throw new Error('IM delivery is not failed')
      return { ...current, deliveries: { ...current.deliveries, [recipient]: 'pending' } }
    }))
    this.schedule(message, recipient)
  }

  /**
   * Stop all recipient delivery and drain storage before releasing the domain.
   * @returns after receiver callbacks and durable writes settle.
   */
  async close(): Promise<void> {
    this.closed = true
    const receivers = [...this.receivers.values()]
    this.receivers.clear()
    for (const receiver of receivers) receiver.lifetime.abort()
    await Promise.all(receivers.map(receiver => receiver.tail))
    await this.tail
    await this.domain.close()
  }

  private requireMember(conversation: ConversationId, member: ParticipantId): void {
    if (!this.domain.table('conversations').get(conversation)?.members.includes(member)) throw new Error('IM conversation membership required')
  }

  private validateAuthorization(human: ParticipantId, authorization: Authorization): void {
    if (this.participant(human).kind !== 'human') throw new Error('IM authorization requires an external human')
    if (this.domain.table('conversations').get(authorization.conversation)?.owner !== human) throw new Error('IM authorization requires the conversation owner')
    for (const member of [authorization.from, authorization.to]) {
      this.requireMember(authorization.conversation, member)
      if (this.participant(member).kind !== 'ai') throw new Error('IM authorization endpoints must be AI participants')
    }
    if (authorization.from === authorization.to) throw new Error('IM authorization endpoints must differ')
  }

  /**
   * Read a recipient's durable inbox, including offline and failed deliveries.
   * @param recipient - externally authenticated human or AI identity.
   * @returns unaccepted messages in per-conversation sequence order.
   */
  inbox(recipient: ParticipantId): ImMessage[] {
    const rooms = this.conversations(recipient, this.participant(recipient).namespace)
    return rooms.flatMap(room => this.history(room.id, recipient, 0))
      .filter(message => message.recipients.includes(recipient) && message.deliveries[recipient] !== 'accepted')
  }

  /**
   * Resolve the attachment budget before a channel reads or uploads bytes.
   * @returns the deployment's per-message byte and count limits.
   */
  attachmentLimits(): { maxBytes: number; maxCount: number } {
    return { maxBytes: this.config.maxAttachmentBytes, maxCount: this.config.maxAttachments }
  }

  /**
   * List the persisted Agent associations for runtime recovery.
   * @returns owned bindings, including explicitly offline AIs.
   */
  agentBindings(): AgentBinding[] {
    return [...this.domain.table('bindings').entries()].map(([, binding]) => structuredClone(binding))
  }

  /**
   * Persist an Agent association before admission; only the owning runtime calls this method.
   * @param binding - dedicated Session identity and desired online state.
   * @returns after durable replacement; an established Session identity cannot change.
   */
  setAgentBinding(binding: AgentBinding): Promise<void> {
    return this.mutate(async () => {
      this.requireMember(binding.conversation, binding.participant)
      if (this.participant(binding.participant).kind !== 'ai') throw new Error('IM binding requires an AI')
      const table = this.domain.table('bindings')
      const key = JSON.stringify([binding.conversation, binding.participant])
      const prior = table.get(key)
      if (prior !== undefined && prior.sessionId !== binding.sessionId) throw new Error('IM Agent Session identity cannot change')
      await table.put(key, structuredClone(binding))
    })
  }

  /**
   * Mark messages observed by a human panel as accepted; this does not claim the human has read them.
   * @param conversation - displayed conversation.
   * @param recipient - authenticated human recipient.
   * @param through - highest displayed sequence.
   * @returns after durable receipt updates.
   */
  acceptInbox(conversation: ConversationId, recipient: ParticipantId, through: number): Promise<void> {
    return this.mutate(async () => {
      this.requireMember(conversation, recipient)
      if (this.participant(recipient).kind !== 'human') throw new Error('IM panel acceptance requires a human')
      for (const message of this.history(conversation, recipient, 0)) {
        if (message.sequence <= through && message.recipients.includes(recipient) && message.deliveries[recipient] !== 'accepted') {
          await this.domain.table('messages').update(message.id, current => ({ ...current, deliveries: { ...current.deliveries, [recipient]: 'accepted' } }))
        }
      }
    })
  }

  /**
   * Acknowledge a message after an AI commits it as model input, or a human adapter accepts it.
   * @param id - message identity.
   * @param recipient - receiving identity.
   * @returns after the inbox receipt is durable.
   */
  acceptMessage(id: ImMessageId, recipient: ParticipantId): Promise<void> {
    return this.mutate(async () => {
      await this.domain.table('messages').update(id, (current) => {
        if (!current.recipients.includes(recipient)) throw new Error('IM recipient not found on message')
        return { ...current, deliveries: { ...current.deliveries, [recipient]: 'accepted' } }
      })
    })
  }

  private isAuthorized(conversation: ConversationId, from: ParticipantId, to: ParticipantId): boolean {
    return [...this.domain.table('authorizations').entries()].some(([, grant]) => grant.conversation === conversation
      && ((grant.from === from && grant.to === to) || (grant.direction === 'two-way' && grant.from === to && grant.to === from)))
  }

  private requireGroupOwner(id: ConversationId, human: ParticipantId): Conversation {
    this.requireMember(id, human)
    const group = this.domain.table('conversations').get(id)
    if (group === undefined) throw new Error('IM conversation is missing')
    if (group.kind !== 'group' || group.owner !== human) throw new Error('IM group owner required')
    return group
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('IM service is closed'))
    const job = this.tail.then(operation)
    this.tail = job.then(() => {}, () => {})
    return job
  }

  private schedule(message: ImMessage, recipient: ParticipantId): void {
    if (this.closed || !['pending', 'queued'].includes(message.deliveries[recipient] ?? '')) return
    const receiver = this.receivers.get(JSON.stringify([message.conversation, recipient]))
    if (receiver === undefined || receiver.scheduled.has(message.id)) return
    receiver.scheduled.add(message.id)
    receiver.tail = receiver.tail.then(async () => {
      if (receiver.lifetime.signal.aborted) return
      let status: 'accepted' | 'queued' | 'failed' = 'accepted'
      try {
        this.requireMember(message.conversation, recipient)
        status = await receiver.receive(structuredClone(message), receiver.lifetime.signal) ?? 'accepted'
      } catch {
        // Channel acceptance failures remain durable and are retried explicitly.
        status = 'failed'
      }
      await this.domain.table('messages').update(message.id, current => ({
        ...current, deliveries: { ...current.deliveries, [recipient]: current.deliveries[recipient] === 'accepted' ? 'accepted' : status },
      }))
    }).catch(() => {
      // A failed durable acknowledgement leaves the delivery pending for recovery.
      this.reportFailure()
    }).finally(() => { receiver.scheduled.delete(message.id) })
  }
}

/**
 * Mount the persistent IM service.
 * @param ctx - context carrying domain storage.
 * @param config - explicit deployment limits.
 * @returns after durable records load and the service becomes available.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const service = new ImService(await ctx.storageDomain.open(imDomain), config, () => { ctx.logger.warn('IM delivery acknowledgement could not be persisted') })
  ctx.effect(() => () => service.close())
  ctx.provide('im', service)
}
