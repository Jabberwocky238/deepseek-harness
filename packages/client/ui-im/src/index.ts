/** Host IM panel API, bound to the profile's local human identity. */

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-im/runtime'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ConversationId, DeliveryMode, ImAttachment, ImMessage, ImMessageId, Participant, ParticipantId } from '@deepseek-ai/dsh-im/types'
import type { ImDownload, ImPanelSnapshot, ImUpload } from './types.ts'

/** The profile owner shown in the native IM panel. */
export interface Config {
  /** Stable identity of the local human; remote callers cannot override it. */
  viewerId: string
  /** Display name used when creating the local human identity. */
  viewerName: string
  /** Refresh interval for live IM views. */
  pollIntervalMs: number
  /** Maximum AI publications in each newly created conversation. */
  maxAiMessages: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { imPanel: ImPanelService }
}

/** Native IM API for one authenticated local Harness owner; external platforms use their own adapters. */
export class ImPanelService extends TypertRemoteService {
  static inject = ['im', 'imRuntime', 'attachments']
  static Config: z<Config> = z.object({
    viewerId: z.string().required(), viewerName: z.string().required(),
    pollIntervalMs: z.number().step(1).min(100).required(),
    maxAiMessages: z.number().step(1).min(1).required(),
  })
  private readonly viewer: ParticipantId

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'imPanel')
    this.viewer = brandString<ParticipantId>(config.viewerId)
  }

  protected async [Service.init](): Promise<void> {
    await this.ctx.im.addParticipant({ id: this.viewer, name: this.config.viewerName, kind: 'human', namespace: 'im' })
  }

  /**
   * Read the local human's native IM contacts, chats, and offline inbox.
   * @returns the persisted navigation and configured refresh interval.
   */
  @Remote('snapshot')
  snapshot(): ImPanelSnapshot {
    const conversations = this.ctx.im.conversations(this.viewer, 'im')
    const people = [...new Set(conversations.flatMap(chat => chat.members))].map(id => this.ctx.im.participant(id))
    return {
      people, attachmentLimits: this.ctx.im.attachmentLimits(),
      viewer: this.ctx.im.participant(this.viewer), contacts: this.ctx.im.contacts(this.viewer),
      conversations: this.ctx.im.conversations(this.viewer, 'im'), inbox: this.ctx.im.inbox(this.viewer), pollIntervalMs: this.config.pollIntervalMs,
    }
  }

  /**
   * Add a locally managed human or AI contact, independent of WeCom contact relationships.
   * @param name - displayed participant name.
   * @param kind - person or AI.
   * @returns the new durable native identity.
   */
  @Remote('addContact')
  async addContact(name: string, kind: 'human' | 'ai'): Promise<Participant> {
    if (name.trim() === '') throw new Error('IM contact name must not be empty')
    const participant: Participant = { id: brandString<ParticipantId>(randomUUID()), name, kind, namespace: 'im' }
    await this.ctx.im.addParticipant(participant)
    await this.ctx.im.addContact(this.viewer, this.viewer, participant.id)
    return participant
  }

  /**
   * Create a native direct chat or group and connect its AI members.
   * @param name - displayed chat name.
   * @param members - selected native contacts; the local human is included automatically.
   * @param kind - direct chat or group.
   * @returns its durable identity; group membership permits group messages; direct messages require a mutual contact.
   */
  @Remote('createConversation')
  async createConversation(name: string, members: ParticipantId[], kind: 'direct' | 'group'): Promise<ConversationId> {
    if (name.trim() === '') throw new Error('IM conversation name must not be empty')
    const participants = [...new Set([this.viewer, ...members])]
    if (members.some(member => !this.ctx.im.contacts(this.viewer).some(contact => contact.id === member))) {
      throw new Error('IM conversation creation requires contacts')
    }
    const existing = kind === 'direct' ? this.ctx.im.conversations(this.viewer, 'im').find(chat =>
      chat.kind === 'direct' && chat.members.length === participants.length && participants.every(member => chat.members.includes(member))) : undefined
    if (existing !== undefined) return existing.id
    const id = brandString<ConversationId>(randomUUID())
    await this.ctx.im.addConversation({ id, namespace: 'im', name, kind, owner: this.viewer, members: participants, maxAiMessages: this.config.maxAiMessages })
    for (const member of participants) if (this.ctx.im.participant(member).kind === 'ai') await this.ctx.imRuntime.connect(member)
    return id
  }

  /**
   * Read ordered persisted messages in a native conversation visible to the local human.
   * @param conversation - selected chat.
   * @param after - exclusive sequence cursor.
   * @returns messages with durable image and file references.
   */
  @Remote('messages')
  messages(conversation: ConversationId, after: number): ImMessage[] {
    this.requireNativeConversation(conversation)
    return this.ctx.im.history(conversation, this.viewer, after)
  }

  /**
   * Persist text and uploaded attachments before distributing them to the selected chat members.
   * @param id - browser-created idempotency identity, reused after ambiguous failures.
   * @param conversation - native chat.
   * @param recipients - explicit recipients to notify, including any AIs to wake.
   * @param text - message text, optionally empty with attachments.
   * @param mode - interrupt or queue before the next unstarted tool.
   * @param uploads - base64 files or validated raster images.
   * @returns the durable chat message.
   */
  @Remote('send')
  async send(
    id: ImMessageId, conversation: ConversationId, recipients: ParticipantId[], text: string, mode: DeliveryMode, uploads: ImUpload[],
  ): Promise<ImMessage> {
    this.requireNativeConversation(conversation)
    const limits = this.ctx.im.attachmentLimits()
    if (uploads.length > limits.maxCount) throw new Error('IM attachment count exceeded')
    const attachments: ImAttachment[] = []
    let remaining = limits.maxBytes
    for (const upload of uploads) {
      if (upload.data.length > Math.ceil(remaining / 3) * 4) throw new Error('IM attachment bytes exceeded')
      const data = Buffer.from(upload.data, 'base64')
      if (data.toString('base64') !== upload.data || data.byteLength > remaining) throw new Error('IM attachment encoding or size is invalid')
      remaining -= data.byteLength
      if (upload.kind === 'image') {
        if (upload.mediaType === 'application/octet-stream') throw new Error('IM image media type required')
        attachments.push({ type: 'image', attachment: await this.ctx.attachments.saveImage({ data, name: upload.name, mediaType: upload.mediaType }) })
      } else attachments.push({ type: 'file', attachment: await this.ctx.attachments.saveFile({ data, name: upload.name }) })
    }
    return this.ctx.im.send({ id, conversation, sender: this.viewer, recipients, text, mode, attachments })
  }

  /**
   * Read one attachment through its visible message; callers cannot request arbitrary storage objects.
   * @param conversation - native chat visible to the viewer.
   * @param messageId - message containing the attachment.
   * @param index - attachment position in that message.
   * @returns verified bytes for image display or download.
   */
  @Remote('download')
  async download(conversation: ConversationId, messageId: ImMessageId, index: number): Promise<ImDownload> {
    const attachment = this.messages(conversation, 0).find(message => message.id === messageId)?.attachments[index]
    if (attachment === undefined) throw new Error('IM attachment is not visible')
    if (attachment.type === 'image') {
      const image = await this.ctx.attachments.readImage(attachment.attachment)
      return { name: attachment.attachment.name ?? attachment.attachment.attachmentId, mediaType: attachment.attachment.mediaType, data: Buffer.from(image.data).toString('base64') }
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of this.ctx.attachments.readFileStream(attachment.attachment)) chunks.push(chunk)
    return { name: attachment.attachment.name, mediaType: 'application/octet-stream', data: Buffer.concat(chunks).toString('base64') }
  }

  /**
   * Acknowledge messages displayed in the local human's panel.
   * @param conversation - visible native conversation.
   * @param through - last displayed sequence.
   * @returns after the inbox acknowledgement is durable.
   */
  @Remote('acknowledge')
  async acknowledge(conversation: ConversationId, through: number): Promise<void> {
    this.requireNativeConversation(conversation)
    await this.ctx.im.acceptInbox(conversation, this.viewer, through)
  }

  /**
   * Remove a mutual contact without deleting chat history or group membership.
   * @param participant - existing contact.
   * @returns after both contact lists are updated.
   */
  @Remote('removeContact')
  async removeContact(participant: ParticipantId): Promise<void> {
    await this.ctx.im.removeContact(this.viewer, this.viewer, participant)
  }

  /**
   * Rename a group owned by the local human.
   * @param conversation - owned group.
   * @param name - new display name.
   * @returns after durable replacement.
   */
  @Remote('renameGroup')
  async renameGroup(conversation: ConversationId, name: string): Promise<void> {
    this.requireNativeConversation(conversation)
    await this.ctx.im.renameGroup(this.viewer, conversation, name)
  }

  /**
   * Add a contact to an owned group and connect an AI participant.
   * @param conversation - owned group.
   * @param participant - contact to invite.
   * @returns after membership and AI admission are ready.
   */
  @Remote('invite')
  async invite(conversation: ConversationId, participant: ParticipantId): Promise<void> {
    this.requireNativeConversation(conversation)
    if (!this.ctx.im.contacts(this.viewer).some(contact => contact.id === participant)) throw new Error('IM invitation requires a contact')
    await this.ctx.im.addGroupMember(this.viewer, conversation, participant)
    if (this.ctx.im.participant(participant).kind === 'ai') await this.ctx.imRuntime.connect(participant)
  }

  /**
   * Remove a member from an owned group or leave a group as the local human.
   * @param conversation - visible group.
   * @param participant - member to remove.
   * @returns after membership is removed; contacts and history are retained.
   */
  @Remote('removeMember')
  async removeMember(conversation: ConversationId, participant: ParticipantId): Promise<void> {
    this.requireNativeConversation(conversation)
    await this.ctx.im.removeGroupMember(this.viewer, conversation, participant)
  }

  private requireNativeConversation(id: ConversationId): void {
    if (!this.ctx.im.conversations(this.viewer, 'im').some(value => value.id === id)) throw new Error('Native IM conversation required')
  }
}

export default ImPanelService
