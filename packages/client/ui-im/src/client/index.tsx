/** Register the native IM sidebar entry and central panel with the host Remote API. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import remote from '@deepseek-ai/dsh-client-ui-im/remote'
import { ImPanel, type ImPanelApi } from './panel.tsx'
import { zh, en, type ImKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { im: ImKey }
}

/** Layout slots, copy, and the typed Remote carrier are required. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount native IM navigation and its API contribution.
 * @param ctx - browser plugin owner.
 * @returns after the Remote namespace is ready and slots are registered.
 */
export async function apply(ctx: Context): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(remote)
  ctx.effect(() => disposeRemote)
  ctx.effect(() => ctx.locale.register('im', { zh, en }))
  const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const api: ImPanelApi = {
    snapshot: async () => value(await ctx.remote.imPanel.snapshot()),
    addContact: async (...args) => value(await ctx.remote.imPanel.addContact(...args)),
    createConversation: async (...args) => value(await ctx.remote.imPanel.createConversation(...args)),
    messages: async (...args) => value(await ctx.remote.imPanel.messages(...args)),
    send: async (...args) => value(await ctx.remote.imPanel.send(...args)),
    download: async (...args) => value(await ctx.remote.imPanel.download(...args)),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'im', locale: 'im', inject: () => ({ api }) }, ImPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'im', locale: 'im', label: () => ctx.locale.bind('im')('title') }, ImIcon))
}

function ImIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z" /><path d="M8 8h8M8 12h6" /></svg>
}
