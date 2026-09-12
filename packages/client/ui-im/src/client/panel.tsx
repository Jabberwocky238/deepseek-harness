/** Human-visible native chat history, recipient selection, and attachment presentation. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationId, DeliveryMode, ImMessage, ImMessageId, Participant, ParticipantId } from '@deepseek-ai/dsh-im/types'
import type { ImDownload, ImPanelSnapshot, ImUpload } from '../types.ts'
import css from './panel.module.css'

/** Promise API supplied by the generated Remote adapter. */
export interface ImPanelApi {
  snapshot(): Promise<ImPanelSnapshot>
  addContact(name: string, kind: 'human' | 'ai'): Promise<Participant>
  createConversation(name: string, members: ParticipantId[], kind: 'direct' | 'group'): Promise<ConversationId>
  messages(conversation: ConversationId, after: number): Promise<ImMessage[]>
  send(
    id: ImMessageId, conversation: ConversationId, recipients: ParticipantId[], text: string, mode: DeliveryMode, uploads: ImUpload[],
  ): Promise<ImMessage>
  download(conversation: ConversationId, message: ImMessageId, index: number): Promise<ImDownload>
}

/** Four-share panel props; all application data comes from the injected API. */
export type ImPanelProps = PropsRuntime & PropsLocale<'im'> & { api: ImPanelApi }

/**
 * Render the native IM workspace without mixing in external platform chats.
 * @param props - localized labels and the bound local-human API.
 * @returns contacts, conversation lists, and persisted message/attachment views.
 */
export function ImPanel({ api, t }: ImPanelProps) {
  const [snapshot, setSnapshot] = useState<ImPanelSnapshot>()
  const [selected, setSelected] = useState<ConversationId>()
  const [messages, setMessages] = useState<ImMessage[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'human' | 'ai'>('human')
  const [members, setMembers] = useState<ParticipantId[]>([])
  const [recipients, setRecipients] = useState<ParticipantId[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<DeliveryMode>('queue')
  const [uploads, setUploads] = useState<ImUpload[]>([])
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const pendingId = useRef<ImMessageId>()
  const group = snapshot?.conversations.find(value => value.id === selected)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const next = await api.snapshot()
        const history = selected === undefined ? [] : await api.messages(selected, 0)
        if (stopped) return
        setSnapshot(next)
        setMessages(history)
        timer = setTimeout(() => { void refresh() }, next.pollIntervalMs)
      } catch {
        if (!stopped) setError(true)
      }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, selected])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(false)
    try { await action(); setSnapshot(await api.snapshot()) } catch { setError(true) }
    finally { sending.current = false; setBusy(false) }
  }
  const open = (id: ConversationId): void => {
    setSelected(id)
    setMessages([])
    setDraft('')
    setUploads([])
    pendingId.current = undefined
    const conversation = snapshot?.conversations.find(value => value.id === id)
    setRecipients(conversation?.members.filter(value => value !== snapshot?.viewer.id) ?? [])
  }
  const toggle = (values: ParticipantId[], id: ParticipantId): ParticipantId[] =>
    values.includes(id) ? values.filter(value => value !== id) : [...values, id]

  return <section className={css.panel} aria-label={t('title')}>
    <aside className={css.navigation}>
      <h2>{t('title')}</h2>
      <p>{t('inbox')} · {snapshot?.inbox.length ?? 0}</p>
      <h3>{t('contacts')}</h3>
      <Input aria-label={t('name')} value={name} onChange={(event) => { setName(event.target.value) }} />
      <select aria-label={t('members')} value={kind} onChange={(event) => { setKind(event.target.value as 'human' | 'ai') }}>
        <option value="human">{t('human')}</option><option value="ai">{t('ai')}</option>
      </select>
      <Button disabled={busy || name.trim() === ''} onClick={() => { void run(async () => { await api.addContact(name, kind); setName('') }) }}>{t('add')}</Button>
      {snapshot?.contacts.map(contact => <label className={css.contact} key={contact.id}>
        <input type="checkbox" checked={members.includes(contact.id)} onChange={() => { setMembers(toggle(members, contact.id)) }} />
        <span>{contact.name} <small>{t(contact.kind)}</small></span>
      </label>)}
      <Button disabled={busy || members.length === 0} onClick={() => { void run(async () => {
        const chosen = snapshot?.contacts.filter(contact => members.includes(contact.id)) ?? []
        const id = await api.createConversation(name.trim() || chosen.map(contact => contact.name).join(', '), members, members.length === 1 ? 'direct' : 'group')
        setSelected(id); setRecipients(members); setMembers([]); setName(''); setMessages([])
      }) }}>{t('create')}</Button>
      {(['direct', 'group'] as const).map(chatKind => <div key={chatKind}>
        <h3>{t(chatKind === 'group' ? 'groups' : 'direct')}</h3>
        {snapshot?.conversations.filter(chat => chat.kind === chatKind).map(chat => (
          <Button key={chat.id} aria-pressed={selected === chat.id} onClick={() => { open(chat.id) }}>{chat.name}</Button>
        ))}
      </div>)}
    </aside>
    <main className={css.chat}>
      <header><h2>{group?.name ?? t('choose')}</h2>{group && <p>{t('members')} · {group.members.length}</p>}</header>
      {error && <p role="alert">{t('error')}</p>}
      <div className={css.messages} role="log" aria-label={t('message')}>
        {selected !== undefined && messages.length === 0 && <p>{t('empty')}</p>}
        {messages.map(message => <article className={css.message} key={message.id}>
          <strong>{message.sender === snapshot?.viewer.id
            ? snapshot.viewer.name
            : snapshot?.contacts.find(contact => contact.id === message.sender)?.name ?? message.sender}</strong>
          {message.text && <p>{message.text}</p>}
          {message.attachments.map((attachment, index) => <Attachment key={index} api={api} message={message} index={index} name={attachment.attachment.name ?? attachment.attachment.attachmentId} image={attachment.type === 'image'} label={t('download')} />)}
          <small>{Object.entries(message.deliveries).map(([id, status]) => `${snapshot?.contacts.find(contact => contact.id === id)?.name ?? id}: ${t(status)}`).join(' · ')}</small>
        </article>)}
      </div>
      {group && <form className={css.composer} onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          pendingId.current ??= randomUUID() as ImMessageId
          await api.send(pendingId.current, group.id, recipients, draft, mode, uploads)
          pendingId.current = undefined; setDraft(''); setUploads([])
          setMessages(await api.messages(group.id, 0))
        })
      }}>
        <fieldset><legend>{t('recipients')}</legend>{group.members.filter(id => id !== snapshot?.viewer.id).map(id => <label key={id}>
          <input type="checkbox" checked={recipients.includes(id)} onChange={() => { setRecipients(toggle(recipients, id)); pendingId.current = undefined }} />
          {snapshot?.contacts.find(contact => contact.id === id)?.name ?? id}
        </label>)}</fieldset>
        <textarea aria-label={t('message')} value={draft} onChange={(event) => { setDraft(event.target.value); pendingId.current = undefined }} />
        <div className={css.actions}>
          <select aria-label={t('send')} value={mode} onChange={(event) => { setMode(event.target.value as DeliveryMode); pendingId.current = undefined }}>
            <option value="queue">{t('queue')}</option><option value="interrupt">{t('interrupt')}</option>
          </select>
          <label>{t('attach')}<input type="file" multiple aria-label={t('attach')} onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            void run(async () => { setUploads(await Promise.all(files.map(readUpload))); pendingId.current = undefined })
          }} /></label>
          <Button variant="primary" type="submit" disabled={busy || recipients.length === 0 || (draft.trim() === '' && uploads.length === 0)}>{t('send')}</Button>
        </div>
        {uploads.map((file, index) => <span key={index}>{file.name}</span>)}
      </form>}
    </main>
  </section>
}

function Attachment({ api, message, index, name, image, label }: {
  api: ImPanelApi
  message: ImMessage
  index: number
  name: string
  image: boolean
  label: string
}) {
  const [download, setDownload] = useState<ImDownload>()
  useEffect(() => {
    let stopped = false
    void api.download(message.conversation, message.id, index).then((value) => { if (!stopped) setDownload(value) }, () => {})
    return () => { stopped = true }
  }, [api, message.conversation, message.id, index])
  const url = download === undefined ? undefined : `data:${download.mediaType};base64,${download.data}`
  return <div>{image && url && <img className={css.image} src={url} alt={name} />}<a href={url} download={name}>{label}: {name}</a></div>
}

async function readUpload(file: File): Promise<ImUpload> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result).split(',')[1] ?? '') }
    reader.onerror = () => { reject(reader.error) }
    reader.readAsDataURL(file)
  })
  const mediaType = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp' || file.type === 'image/gif' ? file.type : 'application/octet-stream'
  return { kind: mediaType === 'application/octet-stream' ? 'file' : 'image', name: file.name, data, mediaType }
}
