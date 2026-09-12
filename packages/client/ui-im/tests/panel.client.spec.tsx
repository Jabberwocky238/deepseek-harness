// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Participant, ParticipantId, ConversationId, ImMessageId } from '@deepseek-ai/dsh-im/types'
import { ImPanel, type ImPanelApi } from '../src/client/panel.tsx'
import { zh } from '../src/client/locales.ts'
import type { ImPanelSnapshot } from '../src/types.ts'

const t: Parameters<typeof ImPanel>[0]['t'] = makeTranslate(zh, commonZh)
afterEach(cleanup)
const person = (id: string, kind: 'human' | 'ai'): Participant => ({ id: brandString<ParticipantId>(id), name: id, kind, namespace: 'im' })
const me = person('Me', 'human')
const bot = person('Bot', 'ai')
const room = brandString<ConversationId>('room')

function fixture() {
  const snapshot: ImPanelSnapshot = {
    viewer: me, contacts: [bot], people: [me, bot], pollIntervalMs: 60000, attachmentLimits: { maxBytes: 1024, maxCount: 2 }, inbox: [],
    conversations: [{ id: room, name: 'Friends', namespace: 'im', kind: 'group', owner: me.id, members: [me.id, bot.id], maxAiMessages: 10 }],
  }
  const api: ImPanelApi = {
    snapshot: vi.fn(async () => snapshot), addContact: vi.fn(async () => bot), createConversation: vi.fn(async () => room),
    messages: vi.fn(async () => []), acknowledge: vi.fn(async () => {}), removeContact: vi.fn(async () => {}),
    renameGroup: vi.fn(async () => {}), invite: vi.fn(async () => {}), removeMember: vi.fn(async () => {}),
    download: vi.fn(async () => ({ name: 'hello.txt', mediaType: 'application/octet-stream', data: 'aGVsbG8=' })),
    send: vi.fn<ImPanelApi['send']>(async (id, conversation, recipients, text, mode, uploads) => ({
      id, conversation, recipients, text, mode, attachments: [], sequence: uploads.length + 1, sender: me.id, deliveries: {},
    })),
  }
  return { api, snapshot }
}

it('sends a group message to its members without requiring individual recipient selection', async () => {
  const { api } = fixture()
  render(<ImPanel api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /Friends/ }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.message }), { target: { value: 'Hello group' } })
  fireEvent.click(screen.getByRole('button', { name: zh.send }))
  await waitFor(() => { expect(api.send).toHaveBeenCalledWith(expect.any(String), room, [bot.id], 'Hello group', 'queue', []) })
  expect(screen.queryByRole('group', { name: zh.recipients })).toBeNull()
})

it('shows a file sent by an AI and downloads it only when requested', async () => {
  const { api } = fixture()
  api.messages = vi.fn<ImPanelApi['messages']>(async () => [{
    id: brandString<ImMessageId>('file-message'), conversation: room, sender: bot.id, recipients: [me.id], text: 'Here is your file',
    attachments: [{ type: 'file', attachment: { attachmentId: brandString<AttachmentId>('file'), name: 'hello.txt', bytes: 5 } }],
    mode: 'queue', sequence: 1, deliveries: { Me: 'pending' },
  }])
  render(<ImPanel api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /Friends/ }))
  expect(await screen.findByText('Here is your file')).toBeTruthy()
  expect(api.download).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /hello.txt/ }))
  const link = await screen.findByRole('link', { name: /hello.txt/ })
  expect(link.getAttribute('download')).toBe('hello.txt')
  expect(link.getAttribute('href')).toBe('data:application/octet-stream;base64,aGVsbG8=')
})

it('starts a private conversation from contacts and offers group creation separately', async () => {
  const { api } = fixture()
  render(<ImPanel api={api} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.contacts }))
  fireEvent.click(await screen.findByRole('button', { name: zh.message }))
  await waitFor(() => { expect(api.createConversation).toHaveBeenCalledWith('Bot', [bot.id], 'direct') })
})
