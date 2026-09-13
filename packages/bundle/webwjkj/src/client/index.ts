/** Browser workbench using Dockview's resizable, draggable panel groups. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createDockview, themeDark, type IContentRenderer, type GroupPanelPartInitParameters, type SerializedDockview } from 'dockview'

const zh = {
  welcome: '欢迎', notes: '便笺', guide: '使用说明', explorer: '工作区', details: '账号概览',
  hello: '欢迎来到 webwjkj', intro: '选择一个面板开始。上下工作区都可以显示任意内容；拖动标签即可移动或拆分面板。',
  noteHint: '在此记录想法…', localNote: '便笺仅保存在当前浏览器。',
  guideText: '拖动标签到另一组可合并面板，拖到边缘可创建分屏。拖动面板之间的分隔线可调整大小。使用顶部菜单打开新面板，或重置为左右侧栏、中间上下分屏。',
  username: '用户名', userId: '用户 ID', account: '管理个人资料与绑定', privacy: '账号信息由当前登录会话提供。',
  storageFailed: '浏览器无法保存本地数据。', resetFailed: '已恢复默认布局。', close: '关闭面板',
}
const en: typeof zh = {
  welcome: 'Welcome', notes: 'Notes', guide: 'Layout guide', explorer: 'Workspace', details: 'Account overview',
  hello: 'Welcome to webwjkj', intro: 'Open a panel to begin. Both work areas can display any content. Drag tabs to move or split panels.',
  noteHint: 'Write your thoughts here…', localNote: 'Notes are saved only in this browser.',
  guideText: 'Drag a tab into another group to merge panels, or to an edge to split them. Drag the divider between panels to resize them. Open new panels from the top menu or reset to sidebars around two central work areas.',
  username: 'Username', userId: 'User ID', account: 'Manage profile and linked accounts', privacy: 'Account details come from your current session.',
  storageFailed: 'This browser could not save local data.', resetFailed: 'Default layout restored.', close: 'Close panel',
}
const t = document.documentElement.lang === 'en' ? en : zh
const locale = document.documentElement.lang === 'en' ? 'en' : 'zh'
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing workspace page data')
  return value
}
const userId = required(document.body.dataset['userId'])
const userName = required(document.body.dataset['userName'])
const storageKey = `webwjkj:${userId}:layout:v1`
const container = required(document.querySelector<HTMLElement>('#workbench'))
const status = required(document.querySelector<HTMLElement>('footer span:last-child'))
const kinds = ['welcome', 'notes', 'guide', 'explorer', 'details'] as const
type Kind = typeof kinds[number]
function isKind(value: string): value is Kind { return kinds.some(kind => kind === value) }
function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { status.textContent = t.storageFailed; return null }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { status.textContent = t.storageFailed }
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; return node
}
class Panel implements IContentRenderer {
  readonly element = document.createElement('section')
  constructor(private readonly kind: Kind) { this.element.className = 'wjkj-panel' }
  init(parameters: GroupPanelPartInitParameters): void {
    const node = this.element
    if (this.kind === 'notes') {
      node.append(element('p', t.localNote))
      const input = element('textarea', '')
      input.placeholder = t.noteHint; input.setAttribute('aria-label', t.notes)
      const key = `webwjkj:${userId}:note:${parameters.api.id}`
      input.value = read(key) ?? ''
      input.addEventListener('input', () =>{  save(key, input.value) })
      node.append(input)
    } else if (this.kind === 'explorer') {
      node.append(element('h2', t.explorer))
      const nav = element('nav', '')
      for (const kind of ['welcome', 'notes', 'guide'] as const) {
        const button = element('button', t[kind]); button.onclick = () =>{  openPanel(kind) }; nav.append(button)
      }
      const link = element('a', t.account); link.href = `/account?lang=${locale}`; nav.append(link); node.append(nav)
    } else if (this.kind === 'details') {
      node.append(element('h2', t.details), element('p', t.username), element('strong', userName), element('p', t.userId), element('code', userId), element('p', t.privacy))
    } else {
      const eyebrow = element('p', 'webwjkj'); eyebrow.className = 'eyebrow'
      node.append(eyebrow, element('h1', this.kind === 'welcome' ? t.hello : t.guide), element('p', this.kind === 'welcome' ? t.intro : t.guideText))
    }
  }
}
container.replaceChildren()
const api = createDockview(container, {
  theme: themeDark, disableFloatingGroups: true,
  messages: { closeTab: title => `${t.close}: ${title}`, closeTabPlain: () => t.close },
  createComponent(options) {
    if (!isKind(options.name)) throw new Error('Unknown workspace panel')
    return new Panel(options.name)
  },
})
function openPanel(kind: Kind): void {
  api.addPanel({ id: randomUUID(), component: kind, title: t[kind] })
}
function reset(): void {
  api.clear()
  api.layout(container.clientWidth, container.clientHeight)
  const upper = api.addPanel({ id: 'welcome', component: 'welcome', title: t.welcome })
  api.addPanel({ id: 'notes', component: 'notes', title: t.notes, position: { referencePanel: upper.id, direction: 'below' } })
  api.addPanel({ id: 'guide', component: 'guide', title: t.guide, position: { referencePanel: upper.id, direction: 'within' }, inactive: true })
  if (container.clientWidth > 700) {
    api.addPanel({ id: 'explorer', component: 'explorer', title: t.explorer, position: { direction: 'left' }, initialWidth: 220 })
    api.addPanel({ id: 'details', component: 'details', title: t.details, position: { direction: 'right' }, initialWidth: 250 })
  }
  api.getPanel('explorer')?.api.setSize({ width: 220 })
  api.getPanel('details')?.api.setSize({ width: 250 })
  upper.api.setSize({ height: Math.floor(container.clientHeight / 2) })
  upper.api.setActive()
}
const stored = read(storageKey)
if (stored) {
  try { api.fromJSON(JSON.parse(stored) as SerializedDockview) } catch { reset(); status.textContent = t.resetFailed }
} else reset()
api.onDidLayoutChange(() =>{  save(storageKey, JSON.stringify(api.toJSON())) })
required(document.querySelector<HTMLButtonElement>('#open-panel')).onclick = () => {
  const kind = required(document.querySelector<HTMLSelectElement>('#panel-kind')).value
  if (isKind(kind)) openPanel(kind)
}
required(document.querySelector<HTMLButtonElement>('#reset-layout')).onclick = reset
