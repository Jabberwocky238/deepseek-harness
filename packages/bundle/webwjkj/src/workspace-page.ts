/** Authenticated entry for the real VS Code browser workbench shipped by code-server. */
import type { Locale } from './locales.ts'
import type { AccountUser } from './account-types.ts'
import { escapeHtml } from './account-page.ts'

const copy: Record<Locale, { title: string; loading: string }> = {
  zh: { title: '工作台', loading: '正在加载工作台…' }, en: { title: 'Workbench', loading: 'Loading workbench…' },
}

/**
 * Render the code-server workbench bootstrap with session-scoped profile data.
 * @param locale - display language.
 * @param user - authenticated identity; no tokens are embedded in HTML.
 * @returns complete HTML document loading the installed upstream workbench.
 */
export function renderWorkspace(locale: Locale, user: AccountUser): string {
  const t = copy[locale]
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title} · webwjkj</title><link rel="stylesheet" href="/workspace/ui/ui.css"><link rel="stylesheet" href="/workspace/assets/client.css"><style>html,body{margin:0;width:100%;height:100%;background:#181818;color:#ccc;overflow:hidden}#loading{padding:24px;font:14px system-ui}</style><script type="module" src="/workspace/assets/client.js"></script></head><body data-user-id="${user.id}" data-user-name="${escapeHtml(user.name)}"><p id="loading">${t.loading}</p></body></html>\n`
}
