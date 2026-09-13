/** Deterministic user-visible pages complement the Loader authentication flows. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Config } from '../src/auth-config.ts'
import type { AccountUser, UserId } from '../src/account-types.ts'
import { renderAccount } from '../src/account-page.ts'
import { renderWorkspace } from '../src/workspace-page.ts'

it('records both languages for login, account settings, and the authenticated workbench', async () => {
  const config = Config({ auth: { root: '/test/accounts', publicOrigin: 'https://example.test', otpSeconds: 300, otpAttempts: 3, resendSeconds: 60, dailySendLimit: 10, sessionSeconds: 3600, requestsPerMinute: 60, providerTimeoutMs: 10000, maxBodyBytes: 16384, lockWaitMs: 15000 } }).auth!
  const user: AccountUser = { id: brandString<UserId>('e20dadb0-7ab8-4e4e-ae32-0f7d1b34fd41'), name: 'webwjkj', phone: '+8613800138000', email: null, image: null, wechat: false }
  for (const locale of ['zh', 'en'] as const) {
    await expect(renderAccount(locale, null, config)).toMatchFileSnapshot(`./expected/login-${locale}.html`)
    await expect(renderAccount(locale, user, config)).toMatchFileSnapshot(`./expected/account-${locale}.html`)
    await expect(renderWorkspace(locale, user)).toMatchFileSnapshot(`./expected/workspace-${locale}.html`)
  }
})
