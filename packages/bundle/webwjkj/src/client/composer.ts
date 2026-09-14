/** Shared one-to-six-line message composer with image and file selection. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { node } from './ui.ts'
import { t } from './copy.ts'

/**
 * Mount the same text and attachment composer on desktop, tablet, and phone.
 * @param container - conversation body.
 * @param sendMessage - send selected bytes and text; false preserves the message for an idempotent retry.
 */
export function mountComposer(container: HTMLElement, sendMessage: (form: FormData) => Promise<boolean>): void {
  const area = node('div', 'compose-area')
  const form = node('form', 'composer')
  const input = node('textarea')
  input.rows = 1
  input.placeholder = t.message
  input.ariaLabel = t.message
  const send = node('button', 'compose-icon send-icon codicon codicon-arrow-up')
  send.type = 'submit'
  send.ariaLabel = t.send
  send.title = t.send
  send.disabled = true
  const add = node('button', 'compose-icon add-icon codicon codicon-add')
  add.type = 'button'
  add.ariaLabel = t.attachments
  add.title = t.attachments
  add.setAttribute('aria-expanded', 'false')
  const drawer = node('section', 'attachment-drawer')
  drawer.hidden = true
  drawer.ariaLabel = t.attachments
  const selected = node('div', 'selected-files')
  const actions = node('div', 'attachment-actions')
  drawer.append(selected, actions)
  const status = node('p', 'compose-status')
  status.role = 'status'
  status.hidden = true
  let files: File[] = []
  let pending: { id: string; text: string; files: File[] } | undefined
  function grow(): void {
    input.style.height = 'auto'
    const style = getComputedStyle(input)
    const max = 6 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2
    input.style.height = `${Math.min(input.scrollHeight + 2, max)}px`
    input.style.overflowY = input.scrollHeight + 2 > max ? 'auto' : 'hidden'
    send.disabled = !input.value.trim() && !files.length
  }
  function listFiles(): void {
    selected.replaceChildren()
    for (const [index, file] of files.entries()) {
      const chip = node('div', 'selected-file')
      const remove = node('button', 'codicon codicon-close')
      remove.type = 'button'
      remove.ariaLabel = `${t.removeFile} ${file.name}`
      remove.onclick = () => { files.splice(index, 1); listFiles(); grow() }
      chip.append(node('span', '', file.name), remove)
      selected.append(chip)
    }
  }
  for (const [label, glyph, accept] of [[t.images, 'device-camera', 'image/png,image/jpeg,image/webp,image/gif'], [t.files, 'file', '']] as const) {
    const picker = node('input')
    picker.type = 'file'
    picker.multiple = true
    picker.accept = accept
    picker.hidden = true
    picker.ariaLabel = label
    const button = node('button', 'attachment-action')
    button.type = 'button'
    button.append(node('span', `codicon codicon-${glyph}`), node('span', '', label))
    button.onclick = () =>{  picker.click() }
    picker.onchange = () => {
      files.push(...picker.files ?? [])
      picker.value = ''
      listFiles()
      grow()
    }
    actions.append(button, picker)
  }
  add.onclick = () => {
    drawer.hidden = !drawer.hidden
    add.setAttribute('aria-expanded', String(!drawer.hidden))
  }
  input.oninput = grow
  form.onsubmit = (event) => {
    event.preventDefault()
    if ((!input.value.trim() && !files.length) || send.disabled) return
    const filesChanged = !pending || files.length !== pending.files.length || files.some((file, index) => file !== pending?.files[index])
    if (!pending || pending.text !== input.value || filesChanged) {
      pending = { id: randomUUID(), text: input.value, files: [...files] }
    }
    const payload = new FormData()
    payload.set('text', pending.text)
    payload.set('messageId', pending.id)
    for (const file of pending.files) payload.append('attachments', file, file.name)
    const buttons = [...area.querySelectorAll<HTMLButtonElement>('button')]
    for (const button of buttons) button.disabled = true
    input.disabled = true
    status.textContent = t.sending
    status.hidden = false
    void sendMessage(payload).then((ok) => {
      if (!ok) return
      files = []
      pending = undefined
      input.value = ''
      listFiles()
      drawer.hidden = true
      add.setAttribute('aria-expanded', 'false')
    }).catch(() => {
      status.textContent = t.failed
    }).finally(() => {
      if (status.textContent === t.sending) status.hidden = true
      for (const button of buttons) button.disabled = false
      input.disabled = false
      grow()
    })
  }
  form.append(input, send, add)
  area.append(form, status, drawer)
  container.append(area)
}
