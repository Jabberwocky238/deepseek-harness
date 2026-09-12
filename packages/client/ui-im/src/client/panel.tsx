/** Native chat navigation, mutual contacts, group management, and human-visible attachments. */

import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationId, DeliveryMode, ImMessage, ImMessageId, Participant, ParticipantId } from '@deepseek-ai/dsh-im/types'
import type { ImDownload, ImPanelSnapshot, ImUpload } from '../types.ts'
import type {} from './locales.ts'
import css from './panel.module.css'

/** Promise API supplied by the generated Remote adapter. */
export interface ImPanelApi {
  snapshot(this: void): Promise<ImPanelSnapshot>
  addContact(this: void, name: string, kind: 'human' | 'ai'): Promise<Participant>
  createConversation(this: void, name: string, members: ParticipantId[], kind: 'direct' | 'group'): Promise<ConversationId>
  messages(this: void, conversation: ConversationId, after: number): Promise<ImMessage[]>
  send(this: void,
    id: ImMessageId, conversation: ConversationId, recipients: ParticipantId[], text: string, mode: DeliveryMode, uploads: ImUpload[],
  ): Promise<ImMessage>
  download(this: void, conversation: ConversationId, message: ImMessageId, index: number): Promise<ImDownload>
  acknowledge(this: void, conversation: ConversationId, through: number): Promise<void>
  removeContact(this: void, participant: ParticipantId): Promise<void>
  renameGroup(this: void, conversation: ConversationId, name: string): Promise<void>
  invite(this: void, conversation: ConversationId, participant: ParticipantId): Promise<void>
  removeMember(this: void, conversation: ConversationId, participant: ParticipantId): Promise<void>
}

/** Locale, runtime, and the authenticated owner's API. */
export type ImPanelProps = PropsLocale<'im'> & { api: ImPanelApi }

/**
 * Render the native IM workspace.
 * @param props - locale and the API bound to the human profile owner.
 * @returns chat navigation, contacts, group controls, and message history.
 */
export function ImPanel({ api, t }: ImPanelProps) {
  const [snapshot, setSnapshot] = useState<ImPanelSnapshot>()
  const [selected, setSelected] = useState<ConversationId>()
  const [messages, setMessages] = useState<ImMessage[]>([])
  const [tab, setTab] = useState<'chats' | 'contacts'>('chats')
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'human' | 'ai'>('ai')
  const [members, setMembers] = useState<ParticipantId[]>([])
  const [groupName, setGroupName] = useState('')
  const [invitee, setInvitee] = useState('')
  const [details, setDetails] = useState(false)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<DeliveryMode>('queue')
  const [uploads, setUploads] = useState<ImUpload[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const sending = useRef(false)
  const pendingId = useRef<ImMessageId>()
  const pollInterval = useRef<number>()
  const group = snapshot?.conversations.find(value => value.id === selected)
  const person = (id: ParticipantId): string => snapshot?.people.find(value => value.id === id)?.name
    ?? snapshot?.contacts.find(value => value.id === id)?.name ?? id

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const next = await api.snapshot()
        pollInterval.current = next.pollIntervalMs
        const history = selected === undefined ? [] : await api.messages(selected, 0)
        if (stopped) return
        setSnapshot(next)
        setMessages(history)
        const last = history.at(-1)
        if (selected !== undefined && last !== undefined && next.inbox.some(message => message.conversation === selected)) {
          await api.acknowledge(selected, last.sequence)
        }
      } catch {
        if (!stopped) setError(t('error'))
      } finally {
        if (!stopped && pollInterval.current !== undefined) timer = setTimeout(() => { void refresh() }, pollInterval.current)
      }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, selected, revision, t])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(undefined)
    try { await action(); setRevision(value => value + 1) }
    catch { setError(t('error')) }
    finally { sending.current = false; setBusy(false) }
  }
  const open = (id: ConversationId): void => {
    setSelected(id); setMessages([]); setDraft(''); setUploads([]); setDetails(false); setTab('chats')
    setGroupName(''); setInvitee(''); pendingId.current = undefined
  }
  const toggle = (id: ParticipantId): void => {
    setMembers(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  }
  const matching = (value: string): boolean => value.toLocaleLowerCase().includes(search.toLocaleLowerCase())

  return <section className={css.panel} aria-label={t('title')}>
    <aside className={css.navigation}>
      <header><h2>{t('title')}</h2><small aria-label={t('identity')}>{snapshot?.viewer.name}</small></header>
      <nav className={css.tabs}>
        <Button aria-pressed={tab === 'chats'} onClick={() => { setTab('chats') }}>{t('chats')}</Button>
        <Button aria-pressed={tab === 'contacts'} onClick={() => { setTab('contacts') }}>{t('contacts')}</Button>
      </nav>
      <Input aria-label={t('search')} placeholder={t('search')} value={search} onChange={(event) => { setSearch(event.target.value) }} />
      {tab === 'chats' ? <div className={css.list}>
        {snapshot?.conversations.filter(chat => matching(chat.name)).map(chat => <Button
          key={chat.id} aria-pressed={selected === chat.id} onClick={() => { open(chat.id) }}
        >
          <span>{chat.name}</span><small>{t(chat.kind === 'group' ? 'groups' : 'direct')}</small>
          {snapshot.inbox.some(message => message.conversation === chat.id)
            && <strong>{snapshot.inbox.filter(message => message.conversation === chat.id).length}</strong>}
        </Button>)}
        {snapshot?.conversations.length === 0 && <p>{t('choose')}</p>}
      </div> : <>
        <form className={css.newContact} onSubmit={(event) => {
          event.preventDefault()
          void run(async () => { await api.addContact(name, kind); setName('') })
        }}>
          <Input aria-label={t('name')} placeholder={t('name')} value={name} onChange={(event) => { setName(event.target.value) }} />
          <select aria-label={t('members')} value={kind} onChange={(event) => { setKind(event.target.value as 'human' | 'ai') }}>
            <option value="human">{t('human')}</option><option value="ai">{t('ai')}</option>
          </select>
          <Button type="submit" disabled={busy || name.trim() === ''}>{t('add')}</Button>
        </form>
        <div className={css.list}>{snapshot?.contacts.filter(contact => matching(contact.name)).map(contact => <div key={contact.id}>
          <label><input type="checkbox" checked={members.includes(contact.id)} onChange={() => { toggle(contact.id) }} />
            <span>{contact.name} <small>{t(contact.kind)}</small></span>
          </label>
          <Button disabled={busy} onClick={() => { void run(async () => {
            open(await api.createConversation(contact.name, [contact.id], 'direct'))
          }) }}>{t('message')}</Button>
          <Button disabled={busy} onClick={() => { void run(async () => {
            await api.removeContact(contact.id); setMembers(values => values.filter(value => value !== contact.id))
          }) }}>{t('remove')}</Button>
        </div>)}</div>
        <Input aria-label={t('groupName')} placeholder={t('groupName')} value={groupName} onChange={(event) => { setGroupName(event.target.value) }} />
        <Button disabled={busy || members.length === 0 || groupName.trim() === ''} onClick={() => { void run(async () => {
          open(await api.createConversation(groupName, members, 'group')); setMembers([])
        }) }}>{t('createGroup')}</Button>
      </>}
    </aside>
    <main className={css.chat}>
      <header className={css.chatHeader}>
        <h2>{group?.name ?? t('choose')}</h2>
        {group?.kind === 'group' && <Button aria-expanded={details} onClick={() => { setDetails(value => !value) }}>{t('groupDetails')}</Button>}
      </header>
      {error !== undefined && <div role="alert">{error}<Button onClick={() => { setError(undefined); setRevision(value => value + 1) }}>{t('retry')}</Button></div>}
      {details && group?.kind === 'group' && <section className={css.details} aria-label={t('groupDetails')}>
        <p>{t('members')} · {group.members.length}</p>
        {group.members.map(id => <div key={id}>{person(id)}
          {group.owner === snapshot?.viewer.id && id !== group.owner && group.members.length > 2 && <Button disabled={busy} onClick={() => {
            void run(() => api.removeMember(group.id, id))
          }}>{t('removeMember')}</Button>}
        </div>)}
        {group.owner === snapshot?.viewer.id && <>
          <Input aria-label={t('groupName')} value={groupName} placeholder={group.name} onChange={(event) => { setGroupName(event.target.value) }} />
          <Button disabled={busy || groupName.trim() === ''} onClick={() => { void run(() => api.renameGroup(group.id, groupName)) }}>{t('rename')}</Button>
          <select aria-label={t('invite')} value={invitee} onChange={(event) => { setInvitee(event.target.value) }}>
            <option value="">{t('choose')}</option>
            {snapshot.contacts.filter(contact => !group.members.includes(contact.id)).map(contact => (
              <option key={contact.id} value={contact.id}>{contact.name}</option>
            ))}
          </select>
          <Button disabled={busy || invitee === ''} onClick={() => { void run(async () => {
            await api.invite(group.id, invitee as ParticipantId); setInvitee('')
          }) }}>{t('invite')}</Button>
        </>}
      </section>}
      <div className={css.messages} role="log" aria-label={t('message')}>
        {selected !== undefined && messages.length === 0 && <p>{t('empty')}</p>}
        {messages.map(message => <article
          className={message.sender === snapshot?.viewer.id ? css.ownMessage : css.message} key={message.id}
        >
          <strong>{person(message.sender)}</strong>
          {message.text !== '' && <p>{message.text}</p>}
          {message.attachments.map((attachment, index) => <Attachment
            key={index} api={api} message={message} index={index}
            name={attachment.attachment.name ?? attachment.attachment.attachmentId} image={attachment.type === 'image'}
            label={t('download')} errorLabel={t('error')}
          />)}
        </article>)}
      </div>
      {group && <form className={css.composer} onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          pendingId.current ??= randomUUID() as ImMessageId
          await api.send(pendingId.current, group.id, group.members.filter(id => id !== snapshot?.viewer.id), draft, mode, uploads)
          pendingId.current = undefined; setDraft(''); setUploads([])
        })
      }}>
        <textarea aria-label={t('message')} placeholder={t('message')} value={draft} onChange={(event) => {
          setDraft(event.target.value); pendingId.current = undefined
        }} />
        <div className={css.actions}>
          <select aria-label={t('sendMode')} value={mode} onChange={(event) => { setMode(event.target.value as DeliveryMode); pendingId.current = undefined }}>
            <option value="queue">{t('queue')}</option><option value="interrupt">{t('interrupt')}</option>
          </select>
          <label>{t('attach')}<input type="file" multiple aria-label={t('attach')} onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            const limits = snapshot?.attachmentLimits
            if (limits === undefined || files.length > limits.maxCount
              || files.reduce((sum, file) => sum + file.size, 0) > limits.maxBytes) {
              setError(t('fileLimit')); return
            }
            void run(async () => { setUploads(await Promise.all(files.map(readUpload))); pendingId.current = undefined })
          }} /></label>
          <Button variant="primary" type="submit" disabled={busy || (draft.trim() === '' && uploads.length === 0)}>{t('send')}</Button>
        </div>
        {uploads.map((file, index) => <span key={index}>{file.name}</span>)}
      </form>}
    </main>
  </section>
}

function Attachment({ api, message, index, name, image, label, errorLabel }: {
  api: ImPanelApi
  message: ImMessage
  index: number
  name: string
  image: boolean
  label: string
  errorLabel: string
}) {
  const [download, setDownload] = useState<ImDownload>()
  const [requested, setRequested] = useState(image)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!requested) return
    let stopped = false
    void api.download(message.conversation, message.id, index).then(
      (value) => { if (!stopped) setDownload(value) },
      () => { if (!stopped) setFailed(true) },
    )
    return () => { stopped = true }
  }, [api, message.conversation, message.id, index, requested])
  const url = download === undefined ? undefined : `data:${download.mediaType};base64,${download.data}`
  return <div>
    {image && url && <img className={css.image} src={url} alt={name} />}
    {url ? <a href={url} download={name}>{label}: {name}</a> : <Button onClick={() => { setRequested(true) }}>{label}: {name}</Button>}
    {failed && <span role="alert">{errorLabel}</span>}
  </div>
}

async function readUpload(file: File): Promise<ImUpload> {
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
  const mediaType = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp' || file.type === 'image/gif'
    ? file.type : 'application/octet-stream'
  return { kind: mediaType === 'application/octet-stream' ? 'file' : 'image', name: file.name, data, mediaType }
}
