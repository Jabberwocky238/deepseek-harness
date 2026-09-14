/** Responsive touch navigation that reuses the desktop contact and editor elements. */
import { node } from './ui.ts'
import { t } from './copy.ts'

type Tab = 'chats' | 'contacts' | 'notifications' | 'me'
/** Shared workbench actions and DOM owners used across viewport sizes. */
export interface ResponsiveOptions {
  shell: HTMLElement
  sidebar: HTMLElement
  editor: HTMLElement
  layoutDesktop(this: void): void
  contacts(this: void): void
  notifications(this: void): void
  profile(this: void): Promise<void>
  settings(this: void): Promise<void>
  security(this: void): void
  addFriend(this: void): Promise<void>
  createGroup(this: void): Promise<void>
  account(this: void): Promise<{ name: string; id: string; image: string | null }>
}
/**
 * Install phone stack navigation and tablet split layout without duplicating panels or APIs.
 * @param options - existing workbench elements and actions.
 * @returns active-panel navigation and a disposer restoring the desktop DOM.
 */
export function responsiveWorkbench(options: ResponsiveOptions): { show(element: HTMLElement, title: string): void; dispose(): void } {
  const compact = matchMedia('(max-width: 1023px), (pointer: coarse)')
  const phone = matchMedia('(max-width: 767px)')
  const root = node('section', 'touch-shell')
  const bar = node('header', 'touch-topbar')
  const back = icon('chevron-left', t.back, () => {
    if (hasDetailHistory()) history.back()
    else { detail = false; update() }
  })
  back.classList.add('touch-back')
  const heading = node('strong', 'touch-title', 'webwjkj')
  const more = node('details', 'touch-more')
  const summary = node('summary', 'codicon codicon-add')
  summary.ariaLabel = t.more
  const menu = node('div', 'touch-menu')
  menu.append(row(t.add, 'person-add', options.addFriend), row(t.createGroup, 'organization', options.createGroup))
  more.append(summary, menu)
  bar.append(back, heading, more)
  const body = node('div', 'touch-body')
  const list = node('div', 'touch-list')
  const editor = node('div', 'touch-editor')
  const me = node('div', 'touch-me')
  body.append(list, editor, me)
  const nav = node('nav', 'touch-nav')
  nav.ariaLabel = t.mobileNavigation
  const tabs = new Map<Tab, HTMLButtonElement>()
  for (const [id, label, glyph] of [
    ['chats', t.chats, 'comment-discussion'], ['contacts', t.addressBook, 'organization'],
    ['notifications', t.notifications, 'bell'], ['me', t.me, 'account'],
  ] as const) {
    const button = icon(glyph, label, () =>{  select(id) })
    button.append(node('span', 'touch-nav-label', label))
    nav.append(button)
    tabs.set(id, button)
  }
  root.append(bar, body, nav)
  options.shell.append(root)
  const markers = new Map<HTMLElement, Comment>()
  let current = options.editor
  let title = ''
  let tab: Tab = 'chats'
  let detail = false
  let selecting = false
  let alive = true
  function hasDetailHistory(): boolean {
    const state: unknown = history.state
    return typeof state === 'object' && state !== null && 'webwjkjDetail' in state && state.webwjkjDetail === true
  }
  function icon(glyph: string, label: string, action: () => void): HTMLButtonElement {
    const button = node('button', 'touch-icon')
    button.type = 'button'
    button.ariaLabel = label
    button.append(node('span', `codicon codicon-${glyph}`))
    button.onclick = action
    return button
  }
  function row(label: string, glyph: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = icon(glyph, label, () => {
      more.open = false
      void Promise.resolve().then(action).catch(() => {
        const status = node('p', 'touch-error', t.failed)
        status.role = 'status'
        me.append(status)
      })
    })
    button.classList.add('touch-menu-row')
    button.append(node('span', '', label), node('span', 'codicon codicon-chevron-right'))
    return button
  }
  function move(element: HTMLElement, target: HTMLElement): void {
    if (element.parentElement === target) return
    if (!markers.has(element)) {
      const marker = document.createComment('workbench-view')
      element.before(marker)
      markers.set(element, marker)
    }
    target.append(element)
  }
  function restore(element: HTMLElement): void {
    const marker = markers.get(element)
    if (!marker) return
    marker.replaceWith(element)
    markers.delete(element)
  }
  async function renderMe(): Promise<void> {
    me.replaceChildren()
    const account = await options.account()
    if (!alive) return
    const card = row(account.name, 'account', options.profile)
    card.classList.add('touch-profile-card')
    if (account.image) {
      const image = node('img', 'touch-profile-image')
      image.src = account.image
      image.alt = ''
      image.referrerPolicy = 'no-referrer'
      card.firstElementChild?.replaceWith(image)
    }
    const identity = node('small', 'touch-user-id', `${t.uuid}: ${account.id}`)
    card.append(identity)
    me.append(card, row(t.profile, 'account', options.profile), row(t.security, 'shield', options.security), row(t.settings, 'settings-gear', options.settings))
  }
  function select(next: Tab): void {
    tab = next
    detail = false
    selecting = true
    if (next === 'chats' || next === 'contacts') options.contacts()
    else if (next === 'notifications') options.notifications()
    else void renderMe().catch(() => { me.replaceChildren(node('p', 'touch-error', t.failed)) })
    selecting = false
    update()
  }
  function update(): void {
    const mode = !compact.matches ? 'desktop' : phone.matches ? 'phone' : 'tablet'
    options.shell.dataset['layout'] = mode
    root.dataset['tab'] = tab
    root.dataset['detail'] = String(detail)
    heading.textContent = detail ? title : tab === 'chats' ? 'webwjkj' : t[tab === 'contacts' ? 'addressBook' : tab]
    for (const [id, button] of tabs) button.setAttribute('aria-current', String(id === tab))
    if (mode === 'desktop') {
      for (const element of [...markers.keys()]) restore(element)
      options.layoutDesktop()
    } else {
      move(options.sidebar, list)
      move(current, editor)
    }
    const height = window.visualViewport?.height ?? window.innerHeight
    options.shell.style.setProperty('--touch-height', `${height}px`)
  }
  function popped(): void { detail = false; update() }
  compact.addEventListener('change', update)
  phone.addEventListener('change', update)
  window.visualViewport?.addEventListener('resize', update)
  window.addEventListener('popstate', popped)
  update()
  return {
    show(element, label) {
      if (current !== element) restore(current)
      current = element
      title = label
      if (!selecting) {
        if (!detail && compact.matches && phone.matches) history.pushState({ webwjkjDetail: true }, '', location.href)
        detail = true
      }
      update()
    },
    dispose() {
      alive = false
      compact.removeEventListener('change', update)
      phone.removeEventListener('change', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.removeEventListener('popstate', popped)
      for (const element of [...markers.keys()]) restore(element)
      root.remove()
    },
  }
}
