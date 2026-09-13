/** Authenticated IM directory, contact-based group creation, and conversation messages. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImService, ParticipantId, Conversation, ConversationId, ImMessageId, ImMessage } from '@deepseek-ai/dsh-im'
import type { FriendProfile } from './friends.ts'
import type { AccountUser } from './account-types.ts'
/**
 * Read the user's IM directory and history, or mutate a selected authorized conversation.
 * @param im - mounted persistent IM service.
 * @param user - identity resolved from the server session.
 * @param url - directory request or selected contact/group history request.
 * @param peers - durably accepted account friendships to project into IM.
 * @param form - optional authenticated group creation or message form.
 * @param reply - optional model reply consumer for the default contact.
 * @returns JSON data containing no authentication tokens or other users' directories.
 */
export async function readImView(
  im: ImService, user: AccountUser, url: URL, peers: FriendProfile[] = [], form?: URLSearchParams,
  reply?: (room: Conversation, input: ImMessage) => Promise<void>,
): Promise<unknown> {
  const owner = brandString<ParticipantId>(`webwjkj:${user.id}`)
  try {
    im.participant(owner)
  }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'IM participant not found')
      throw error
    await im.addParticipant({ id: owner, kind: 'human', name: user.name, namespace: 'webwjkj' })
  }
  const defaultAgent = brandString<ParticipantId>('webwjkj:default-agent')
  await im.addParticipant({ id: defaultAgent, name: 'default agent', kind: 'ai', namespace: 'webwjkj' })
  if (!im.contacts(owner).some(contact => contact.id === defaultAgent))
    await im.addContact(owner, owner, defaultAgent)
  for (const peer of peers) {
    const id = brandString<ParticipantId>(`webwjkj:${peer.id}`)
    try {
      im.participant(id)
    }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'IM participant not found')
        throw error
      await im.addParticipant({ id, kind: 'human', name: peer.name, namespace: 'webwjkj' })
    }
    if (!im.contacts(owner).some(contact => contact.id === id))
      await im.addContact(owner, owner, id)
  }
  const contacts = im.contacts(owner)
  if (url.pathname === '/account/im/group' && form) {
    const name = z.string().trim().min(1).max(40).parse(form.get('name'))
    const ids = z.array(z.string()).min(1).max(100).parse(JSON.parse(form.get('members') ?? 'null'))
    if (new Set(ids).size !== ids.length || ids.some(id => !contacts.some(contact => contact.id === id)))
      throw new Error('Group members must be current contacts')
    const id = brandString<ConversationId>(randomUUID())
    await im.addConversation({
      id, name, namespace: 'webwjkj', kind: 'group', owner, members: [owner, ...ids.map(id => brandString<ParticipantId>(id))], maxAiMessages: 0,
    })
    return { id, name, kind: 'group' }
  }
  const rooms = im.conversations(owner, 'webwjkj').filter(room => room.members.includes(owner))
  const groups = rooms.filter(room => room.kind === 'group')
  const latest = im.conversationActivity(owner, 'webwjkj')
  const direct = new Map<ParticipantId, Conversation>()
  for (const room of rooms) {
    if (room.kind !== 'direct')
      continue
    for (const member of room.members) {
      const previous = direct.get(member)
      if (!previous || (latest.get(room.id) ?? 0) > (latest.get(previous.id) ?? 0))
        direct.set(member, room)
    }
  }
  if (url.pathname === '/account/im') {
    const entries = [
      ...contacts.map((contact) => {
        const room = direct.get(contact.id)
        return {
          id: contact.id, name: contact.name, kind: 'contact' as const, order: room ? latest.get(room.id) ?? 0 : 0,
        }
      }),
      ...groups.map(group => ({
        id: group.id, name: group.name, kind: 'group' as const, order: latest.get(group.id) ?? 0,
      })),
    ]
    entries.sort((a, b) => b.order - a.order || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id))
    return { entries: entries.map(({ id, name, kind }) => ({ id, name, kind })) }
  }
  const id = url.searchParams.get('id')
  const kind = url.searchParams.get('kind')
  const contact = kind === 'contact' ? contacts.find(item => item.id === id) : undefined
  const group = kind === 'group' ? groups.find(item => item.id === id) : undefined
  const selected = contact ?? group
  if (!selected)
    throw new Error('IM selection is not in the current directory')
  let room = group ?? (contact ? direct.get(contact.id) : undefined)
  let agentError = false
  if (url.pathname === '/account/im/message' && form) {
    const text = z.string().trim().min(1).parse(form.get('text'))
    if (!room && contact) {
      room = {
        id: brandString<ConversationId>(randomUUID()), name: contact.name, namespace: 'webwjkj', kind: 'direct', owner, members: [owner, contact.id], maxAiMessages: 0,
      }
      await im.addConversation(room)
    }
    if (!room)
      throw new Error('Missing conversation')
    const sent = await im.send({
      id: brandString<ImMessageId>(z.uuid().parse(form.get('messageId'))), conversation: room.id, sender: owner, recipients: room.members.filter(member => member !== owner), text, attachments: [], mode: 'queue',
    })
    if (contact?.id === defaultAgent) {
      try {
        if (!reply) throw new Error('Default agent is unavailable')
        await reply(room, sent)
      } catch {
        // Delivery is durable; report model failure without claiming the send failed.
        agentError = true
      }
    }
  }
  return {
    name: selected.name,
    ...agentError ? { agentError: true } : {},
    messages: room ? im.history(room.id, owner, 0).map(message => ({
      id: message.id, sender: im.participant(message.sender).name, text: message.text, own: message.sender === owner,
    })) : [],
  }
}
