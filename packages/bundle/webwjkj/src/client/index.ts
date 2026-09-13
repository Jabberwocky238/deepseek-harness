/** Independent account and IM UI built on the cloned VS Code grid and dialog widgets. */
import { z } from 'zod'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { locale, t } from './copy.ts'
import { node, type Ui, type View, type Disposable } from './ui.ts'
const selection = z.object({ id: z.string(), name: z.string(), kind: z.enum(['contact', 'group']) })
const directorySchema = z.object({ entries: z.array(selection) })
const profileSchema = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() })
const accountSchema = profileSchema.extend({ phone: z.string(), email: z.string().nullable(), wechat: z.boolean() })
const inboxSchema = z.object({
  requests: z.array(z.object({
    id: z.uuid(), sender: z.uuid(), recipient: z.uuid(), greeting: z.string(), name: z.string(), status: z.enum(['pending', 'accepted', 'rejected']),
  })),
})
const historySchema = z.object({
  messages: z.array(z.object({ sender: z.string(), text: z.string(), own: z.boolean() })),
})
type Selection = z.infer<typeof selection>
type Panel = {
  id: string
  title: string
  render(element: HTMLElement): void | Promise<void>
}
type Group = {
  view: View
  tabs: HTMLElement
  body: HTMLElement
  panels: Panel[]
  active?: string | undefined
}
const userId = z.uuid().parse(document.body.dataset['userId'])
async function request(path: string, form?: Record<string, string>): Promise<Response> {
  const result = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', ...form ? { method: 'POST', body: new URLSearchParams({ ...form, lang: locale }) } : {},
  })
  if (result.status === 401 || path !== '/account/logout' && result.redirected && new URL(result.url).pathname === '/login') {
    location.assign(`/login?lang=${locale}`)
    throw new Error('Login required')
  }
  if (!result.ok)
    throw new Error('Account operation failed')
  return result
}
async function json(path: string, form?: Record<string, string>): Promise<unknown> {
  return (await request(path, form)).json() as Promise<unknown>
}
async function boot(): Promise<void> {
  const source = '/workspace/ui/ui.js'
  const ui = await import(source) as Ui
  const disposables: Disposable[] = []
  const shell = node('div', 'wj-workbench')
  const header = node('header', 'titlebar')
  const heading = node('span', 'window-title', 'webwjkj')
  const activity = node('nav', 'activitybar')
  activity.ariaLabel = t.contacts
  const activities = node('div', 'activities')
  const personal = node('div', 'personal')
  activity.append(activities, personal)
  const workspace = node('main', 'workspace')
  const titleActions = node('div', 'title-actions')
  header.append(node('span', 'brand', 'WE'), heading, titleActions)
  shell.append(header, activity, workspace)
  document.body.replaceChildren(shell)
  let theme: 'system' | 'light' | 'dark' = 'system'
  const themeKey = `webwjkj:${userId}:theme`
  try {
    const saved = localStorage.getItem(themeKey)
    if (saved === 'light' || saved === 'dark')
      theme = saved
  }
  catch { /* Storage can be unavailable in private browser contexts. */
  }
  const media = matchMedia('(prefers-color-scheme: dark)')
  function applyTheme(): void {
    document.documentElement.dataset['theme'] = theme === 'system' ? media.matches ? 'dark' : 'light' : theme
  }
  applyTheme()
  media.addEventListener('change', applyTheme)
  disposables.push({ dispose: () => {
    media.removeEventListener('change', applyTheme)
  } })
  const dialog = (title: string, buttons: string[], detail?: string, inputs?: {
    placeholder: string
    value?: string
  }[], renderBody?: (element: HTMLElement) => void) => ui.showDialog(shell, {
    title, buttons, cancelId: buttons.length - 1,
    ...detail !== undefined ? { detail } : {}, ...inputs ? { inputs } : {}, ...renderBody ? { renderBody } : {},
  })
  function run(work: () => void | Promise<void>): void {
    void Promise.resolve().then(work).catch(() => dialog(t.failed, [t.close]))
  }
  function button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const result = node('button', 'wj-button', label)
    result.type = 'button'
    result.addEventListener('click', () => {
      result.disabled = true
      run(async () => {
        try {
          await action()
        }
        finally {
          result.disabled = false
        }
      })
    })
    return result
  }
  function icons(container: HTMLElement, items: {
    title: string
    icon: string
    run: () => void
  }[], vertical = false): void {
    const bar = new ui.ActionBar(container, { orientation: vertical ? 1 : 0 })
    disposables.push(bar)
    for (const item of items) {
      const action = new ui.Action(item.title, item.title, `codicon codicon-${item.icon}`, true, item.run)
      disposables.push(action)
      bar.push(action, { icon: true, label: false })
    }
  }
  function view(element: HTMLElement, width = 160): View {
    return {
      element, minimumWidth: width, maximumWidth: Infinity, minimumHeight: 100, maximumHeight: Infinity, onDidChange: ui.Event.None,
      layout(w, h) {
        element.style.width = `${w}px`
        element.style.height = `${h}px`
      },
    }
  }
  const groups: Group[] = []
  let dragged: {
    group: Group
    panel: Panel
  } | undefined
  function activate(group: Group, panel?: Panel): void {
    group.active = panel?.id
    group.tabs.replaceChildren()
    group.body.replaceChildren()
    for (const item of group.panels) {
      const tab = node('div', `editor-tab${item.id === panel?.id ? ' active' : ''}`)
      tab.role = 'tab'
      tab.tabIndex = 0
      tab.setAttribute('aria-selected', String(item.id === panel?.id))
      tab.draggable = true
      tab.append(node('span', '', item.title))
      const close = node('button', 'tab-close codicon codicon-close')
      close.ariaLabel = `${t.close} ${item.title}`
      close.onclick = (event) => {
        event.stopPropagation()
        group.panels = group.panels.filter(value => value !== item)
        activate(group, group.panels.at(-1))
      }
      tab.append(close)
      tab.onclick = () => {
        activate(group, item)
      }
      tab.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate(group, item)
        }
      }
      tab.ondragstart = (event) => {
        dragged = { group, panel: item }
        event.dataTransfer?.setData('text/plain', item.id)
      }
      tab.ondragend = () => {
        dragged = undefined
      }
      group.tabs.append(tab)
    }
    heading.textContent = panel ? `${panel.title} — webwjkj` : 'webwjkj'
    document.title = heading.textContent
    if (panel)
      run(() => panel.render(group.body))
    else if (groups[0] === group)
      group.body.append(node('div', 'empty-workspace', t.empty))
  }
  function makeGroup(): Group {
    const element = node('section', 'editor-group')
    const tabs = node('div', 'editor-tabs')
    tabs.role = 'tablist'
    const body = node('div', 'editor-body')
    element.append(tabs, body)
    const group: Group = { view: view(element), tabs, body, panels: [] }
    groups.push(group)
    element.ondragover = (event) => {
      if (dragged)
        event.preventDefault()
    }
    element.ondrop = (event) => {
      if (!dragged)
        return
      event.preventDefault()
      const { group: previous, panel } = dragged
      previous.panels = previous.panels.filter(item => item !== panel)
      group.panels.push(panel)
      activate(previous, previous.panels.at(-1))
      activate(group, panel)
      dragged = undefined
    }
    activate(group)
    return group
  }
  const top = makeGroup()
  const editorGrid = new ui.Grid(top.view)
  disposables.push(editorGrid)
  const center = view(editorGrid.element)
  center.layout = (w, h) => {
    editorGrid.layout(w, h)
  }
  const grid = new ui.Grid(center)
  disposables.push(grid)
  workspace.append(grid.element)
  const sidebar = node('aside', 'sidebar')
  const sideView = view(sidebar, 200)
  const sidebarHeader = node('div', 'sidebar-title')
  sidebarHeader.append(node('strong', '', t.contacts))
  const sideActions = node('div', 'sidebar-actions')
  sidebarHeader.append(sideActions)
  const search = node('input', 'contact-search')
  search.placeholder = t.search
  search.ariaLabel = t.search
  const contacts = node('div', 'contact-list')
  contacts.role = 'list'
  sidebar.append(sidebarHeader, search, contacts)
  grid.layout(workspace.clientWidth, workspace.clientHeight)
  grid.addView(sideView, 300, center, ui.Direction.Left)
  let sidebarOpen = true
  let right: Group | undefined
  let bottom: Group | undefined
  const resize = new ResizeObserver(() => {
    grid.layout(workspace.clientWidth, workspace.clientHeight)
  })
  resize.observe(workspace)
  disposables.push({ dispose: () => {
    resize.disconnect()
  } })
  function split(kind: 'right' | 'bottom'): void {
    const existing = kind === 'right' ? right : bottom
    if (existing) {
      editorGrid.removeView(existing.view)
      for (const panel of existing.panels)
        top.panels.push(panel)
      activate(top, top.panels.at(-1))
      existing.panels = []
      groups.splice(groups.indexOf(existing), 1)
      if (kind === 'right')
        right = undefined
      else
        bottom = undefined
      return
    }
    const added = makeGroup()
    editorGrid.addView(added.view, ui.Sizing.Distribute, top.view, kind === 'right' ? ui.Direction.Right : ui.Direction.Down)
    if (kind === 'right')
      right = added
    else
      bottom = added
  }
  function open(panel: Panel): void {
    for (const group of groups) {
      const found = group.panels.find(item => item.id === panel.id)
      if (found) {
        activate(group, found)
        return
      }
    }
    top.panels.push(panel)
    activate(top, panel)
  }
  let entries: Selection[] = []
  function renderContacts(): void {
    contacts.replaceChildren()
    const filtered = entries.filter(item => item.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))
    for (const item of filtered) {
      const row = button(item.name, () => {
        openChat(item)
      })
      row.className = 'contact-row'
      row.role = 'listitem'
      row.prepend(node('span', `contact-avatar codicon codicon-${item.kind === 'group' ? 'organization' : item.id === 'webwjkj:default-agent' ? 'hubot' : 'account'}`))
      if (item.kind === 'group')
        row.append(node('small', '', t.groups))
      contacts.append(row)
    }
    if (!filtered.length)
      contacts.append(node('p', 'muted', t.emptyContacts))
  }
  async function refresh(): Promise<void> {
    entries = directorySchema.parse(await json('/account/im')).entries
    renderContacts()
  }
  search.oninput = renderContacts
  function openChat(item: Selection): void {
    open({
      id: `${item.kind}:${item.id}`, title: item.name, async render(element) {
        const messages = node('div', 'messages')
        const composer = node('form', 'composer')
        const input = node('textarea')
        input.placeholder = t.message
        input.ariaLabel = t.message
        const send = node('button', 'wj-button', t.send)
        send.type = 'submit'
        composer.append(input, send)
        element.append(messages, composer)
        const query = new URLSearchParams({ kind: item.kind, id: item.id })
        function history(data: unknown): void {
          messages.replaceChildren()
          const records = historySchema.parse(data).messages
          for (const record of records) {
            const article = node('article', record.own ? 'own' : '')
            article.append(node('small', '', record.sender), node('p', '', record.text))
            messages.append(article)
          }

          if (!records.length)
            messages.append(node('p', 'muted', t.noMessages))
          messages.scrollTop = messages.scrollHeight
        }
        history(await json(`/account/im/history?${query}`))
        composer.onsubmit = (event) => {
          event.preventDefault()
          if (!input.value.trim())
            return
          send.disabled = true
          run(async () => {
            try {
              history(await json(`/account/im/message?${query}`, { text: input.value, messageId: randomUUID() }))
              input.value = ''
              await refresh()
            }
            finally {
              send.disabled = false
            }
          })
        }
      },
    })
  }
  async function addFriend(): Promise<void> {
    const response = await dialog(t.add, [t.search, t.cancel], undefined, [{ placeholder: t.find }])
    if (response.button !== 0)
      return
    const result = z.object({ profile: profileSchema.nullable() }).parse(await json('/account/friends', { action: 'search', query: response.values?.[0] ?? '' }))
    if (!result.profile) {
      await dialog(t.missing, [t.close])
      return
    }
    const found = result.profile
    open({
      id: `profile:${found.id}`, title: found.name, render(element) {
        const body = node('div', 'detail-page')
        body.append(node('h1', '', found.name), node('p', 'muted', found.id))
        const greeting = node('textarea')
        greeting.placeholder = t.greeting
        greeting.ariaLabel = t.greeting
        greeting.maxLength = 500
        const send = button(t.request, async () => {
          await json('/account/friends', { action: 'request', target: found.id, greeting: greeting.value })
          body.replaceChildren(node('h1', '', found.name), node('p', '', t.requested))
        })
        body.append(greeting, send)
        element.append(body)
      },
    })
  }
  function notifications(): void {
    open({
      id: 'notifications', title: t.notifications, async render(element) {
        const body = node('div', 'detail-page')
        element.append(body)
        body.append(node('h1', '', t.notifications))
        const inbox = inboxSchema.parse(await json('/account/friends', { action: 'list' }))
        for (const item of inbox.requests) {
          const row = node('article', 'request-row')
          row.append(node('h2', '', item.name), node('p', '', item.greeting), node('p', 'muted', t[item.status]))
          body.append(row)
          if (item.recipient === userId && item.status === 'pending')
            for (const action of ['accept', 'reject'] as const)
              row.append(button(t[action], async () => {
                await json('/account/friends', { action, requestId: item.id })
                await refresh()
                const group = groups.find(group => group.active === 'notifications')
                if (group)
                  activate(group, group.panels.find(panel => panel.id === 'notifications'))
              }))
        }
        if (!inbox.requests.length)
          body.append(node('p', 'muted', t.emptyNotifications))
      },
    })
  }
  async function createGroup(): Promise<void> {
    await refresh()
    const members = new Set<string>()
    const result = await dialog(t.createGroup, [t.createGroup, t.cancel], t.selectMembers, [{ placeholder: t.groupName }], (body) => {
      const list = node('div', 'member-list')
      body.append(list)
      for (const person of entries.filter(entry => entry.kind === 'contact')) {
        const label = node('label')
        const check = node('input')
        check.type = 'checkbox'
        check.onchange = () => {
          if (check.checked)
            members.add(person.id)
          else
            members.delete(person.id)
        }
        label.append(check, document.createTextNode(person.name))
        list.append(label)
      }
    })
    if (result.button !== 0)
      return
    const group = selection.parse(await json('/account/im/group', { name: result.values?.[0] ?? '', members: JSON.stringify([...members]) }))
    await refresh()
    openChat(group)
  }
  async function profile(): Promise<void> {
    const account = accountSchema.parse(await json('/account/me'))
    const result = await dialog(t.profile, [t.edit, t.security, t.logout, t.close], undefined, undefined, (body) => {
      const details = node('div', 'profile-details')
      if (account.image) {
        const avatar = node('img', 'profile-avatar')
        avatar.src = account.image
        avatar.alt = ''
        avatar.referrerPolicy = 'no-referrer'
        details.append(avatar)
      }
      details.append(node('h2', '', account.name))
      for (const [label, value] of [
        [t.uuid, account.id], [t.phone, account.phone || t.unbound],
        [t.email, account.email || t.unbound], [t.wechat, account.wechat ? t.bound : t.unbound],
      ])
        details.append(node('p', '', `${label}: ${value}`))
      body.append(details)
    })
    if (result.button === 0) {
      const edited = await dialog(t.edit, [t.save, t.cancel], undefined, [
        { placeholder: t.name, value: account.name }, { placeholder: t.avatar, value: account.image ?? '' },
      ])
      if (edited.button === 0) {
        await request('/account/profile', { name: edited.values?.[0] ?? '', image: edited.values?.[1] ?? '' })
        await profile()
      }
    }
    else if (result.button === 1)
      location.assign(`/account?lang=${locale}#security`)
    else if (result.button === 2) {
      await request('/account/logout', {})
      location.assign(`/login?lang=${locale}`)
    }
  }
  async function settings(): Promise<void> {
    const result = await dialog(t.settings, [t.system, t.light, t.dark, t.security, t.close], `${t.theme}: ${t[theme]}`)
    if (result.button < 3) {
      theme = result.button === 0 ? 'system' : result.button === 1 ? 'light' : 'dark'
      applyTheme()
      try {
        localStorage.setItem(themeKey, theme)
      }
      catch { /* Browser storage policy can prevent persisting the selected theme. */
      }
    }
    else if (result.button === 3)
      location.assign(`/account?lang=${locale}#security`)
  }
  icons(activities, [
    {
      title: t.contacts, icon: 'organization', run: () => {
        if (!sidebarOpen) {
          grid.addView(sideView, 300, center, ui.Direction.Left)
          sidebarOpen = true
        }

        search.focus()
        run(refresh)
      },
    },
  ], true)
  icons(personal, [
    { title: t.profile, icon: 'account', run: () => {
      run(profile)
    } }, { title: t.settings, icon: 'settings-gear', run: () => {
      run(settings)
    } },
  ], true)
  icons(sideActions, [
    { title: t.add, icon: 'person-add', run: () => {
      run(addFriend)
    } }, { title: t.createGroup, icon: 'add', run: () => {
      run(createGroup)
    } }, { title: t.notifications, icon: 'bell', run: () => {
      run(notifications)
    } }, { title: t.refresh, icon: 'refresh', run: () => {
      run(refresh)
    } },
  ])
  icons(titleActions, [
    { title: t.splitDown, icon: 'layout-panel', run: () => {
      split('bottom')
    } }, { title: t.splitRight, icon: 'layout-sidebar-right', run: () => {
      split('right')
    } },
  ])
  window.addEventListener('pagehide', () => {
    for (const disposable of disposables.reverse())
      disposable.dispose()
  }, { once: true })
  await refresh()
}
void boot().catch((error: unknown) => {
  console.error(error)
  document.body.replaceChildren(node('p', '', t.failed))
})
