/** Workbench presentation of the server-owned account security forms. */
import { locale, t } from './copy.ts'
import { node } from './ui.ts'

/**
 * Render account security inside an editor panel and keep form results in that panel.
 * @param container - owning editor body.
 * @param request - authenticated request helper; allowFailure retains localized validation responses.
 * @returns after the initial account form response is rendered.
 */
export async function renderSecurity(
  container: HTMLElement,
  request: (path: string, form?: Record<string, string>, allowFailure?: boolean) => Promise<Response>,
): Promise<void> {
  const page = node('section', 'settings-page')
  const heading = node('header', 'settings-heading')
  heading.append(node('h1', '', t.security), node('p', 'muted', t.securityIntro))
  const status = node('p', 'settings-notice')
  status.role = 'status'
  status.hidden = true
  const layout = node('div', 'settings-layout')
  const navigation = node('nav', 'settings-navigation')
  navigation.ariaLabel = t.security
  const content = node('div', 'settings-content')
  layout.append(navigation, content)
  page.append(heading, status, layout)
  container.append(page)
  let active = 0
  function render(html: string): void {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const sections = [...document.querySelectorAll<HTMLElement>('#security, #security ~ section.card')]
    if (!sections.length) throw new Error('Account security forms are missing')
    content.replaceChildren()
    navigation.replaceChildren()
    const notice = document.querySelector('[role=status]')?.textContent
    status.textContent = notice ?? ''
    status.hidden = !notice
    for (const [index, source] of sections.entries()) {
      const section = window.document.importNode(source, true)
      section.className = 'settings-section'
      section.removeAttribute('id')
      const title = section.querySelector('h2')?.textContent ?? ''
      const button = node('button', 'settings-category', title)
      button.type = 'button'
      function select(): void {
        active = index
        for (const item of navigation.children) item.removeAttribute('aria-current')
        button.setAttribute('aria-current', 'true')
        content.scrollTo({ top: section.offsetTop, behavior: 'instant' })
      }
      button.onclick = select
      if (index === active) button.setAttribute('aria-current', 'true')
      navigation.append(button)
      content.append(section)
      for (const form of section.querySelectorAll('form')) {
        form.onsubmit = (event) => {
          // OAuth must navigate to WeChat; its callback returns to this workbench panel.
          if (new URL(form.action).pathname === '/account/wechat') return
          event.preventDefault()
          active = index
          const submitter = event.submitter
          const path = submitter instanceof HTMLButtonElement && submitter.hasAttribute('formaction')
            ? submitter.formAction : form.action
          const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>
          const controls = [...content.querySelectorAll<HTMLButtonElement>('button')]
          const enabled = controls.filter(button => !button.disabled)
          for (const button of enabled) button.disabled = true
          status.textContent = t.loading
          status.hidden = false
          void request(new URL(path).pathname, values, true).then(async (response) => {
            render(await response.text())
            navigation.querySelectorAll<HTMLButtonElement>('button')[active]?.click()
          }).catch(() => {
            status.textContent = t.failed
            status.hidden = false
          }).finally(() => {
            for (const button of enabled) button.disabled = false
          })
        }
      }
    }
  }
  const error = new URLSearchParams(location.search).has('error') ? '&error=account' : ''
  render(await (await request(`/account/settings?lang=${locale}${error}`)).text())
}
