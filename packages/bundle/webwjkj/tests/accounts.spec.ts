/** Real account persistence and HTTP flows; only external delivery is mocked. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import * as Homepage from '../src/index.ts'

const delivery = vi.hoisted(() => ({ sms: new Map<string, string>(), email: new Map<string, string>(), fail: false }))
vi.mock('tencentcloud-sdk-nodejs-sms', () => ({ sms: { v20210111: { Client: class {
  async SendSms(input: { PhoneNumberSet: string[]; TemplateParamSet: string[] }) {
    if (delivery.fail) return { SendStatusSet: [{ Code: 'Failed' }] }
    delivery.sms.set(input.PhoneNumberSet[0]!, input.TemplateParamSet[0]!)
    return { SendStatusSet: [{ Code: 'Ok' }] }
  }
} } } }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({
  async sendMail(input: { to: string; text: string }) {
    delivery.email.set(input.to, /code: (\d+)/.exec(input.text)![1]!)
    return { accepted: [input.to], rejected: [] }
  }, close() {},
}) } }))

let root: string | undefined
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  delivery.sms.clear(); delivery.email.clear(); delivery.fail = false
})

async function harness() {
  root ??= await mkdtemp(join(tmpdir(), 'webwjkj-auth-'))
  vi.stubEnv('WJKJ_TEST_SECRET', 'test-secret-value-not-a-real-provider-key')
  const file = join(root, `cordis-${contexts.length}.yml`)
  await writeFile(file, `- name: '@deepseek-ai/dsh-host-webserver'
  config: { host: 127.0.0.1, port: 0 }
- name: '@deepseek-ai/dsh-webwjkj'
  config:
    auth:
      root: ${JSON.stringify(root)}
      publicOrigin: !!js ('http://127.0.0.1:' + ctx.webServer.port)
      sms: { sdkAppId: test, signName: test, templateId: test, region: ap-guangzhou, secretIdEnv: WJKJ_TEST_SECRET, secretKeyEnv: WJKJ_TEST_SECRET }
      mail: { host: smtp.example.test, port: 465, secure: true, user: test, passwordEnv: WJKJ_TEST_SECRET, from: no-reply@example.test }
      wechat: { appId: wx-test, secretEnv: WJKJ_TEST_SECRET }
`)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-webwjkj', Homepage]])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`Unexpected module ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  function browser() {
    const cookies = new Map<string, string>()
    return {
      async request(path: string, form?: Record<string, string>, foreign = false) {
        const response = await fetch(origin + path, {
          method: form ? 'POST' : 'GET', redirect: 'manual',
          headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...form ? { Origin: foreign ? 'https://untrusted.test' : origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {} },
          ...form ? { body: new URLSearchParams(form).toString() } : {},
        })
        for (const cookie of response.headers.getSetCookie()) {
          const part = cookie.split(';')[0]!
          const equals = part.indexOf('=')
          cookies.set(part.slice(0, equals), part.slice(equals + 1))
        }
        return { status: response.status, location: response.headers.get('location'), body: await response.text(), cookies: response.headers.getSetCookie() }
      },
    }
  }
  return { ctx, origin, browser }
}

it('logs in once, persists a UUID profile and verified email, and rejects unsafe account mutations', async () => {
  const app = await harness()
  const browser = app.browser()
  expect((await browser.request('/account')).location).toBe('/login?lang=zh')
  const sent = await browser.request('/account/sms/send', { phone: '13800138000' })
  expect(sent.status, sent.body).toBe(200)
  const code = delivery.sms.get('+8613800138000')!
  expect(code).toMatch(/^\d{6}$/)
  expect(sent.body).not.toContain(code)
  expect((await browser.request('/account/sms/verify', { phone: '13800138000', code: '000000' === code ? '111111' : '000000' })).status).toBe(400)
  const verified = await browser.request('/account/sms/verify', { phone: '13800138000', code })
  expect(verified.status, verified.body).toBe(303)
  expect(verified.location).toBe('/workspace?lang=zh')
  expect((await browser.request('/workspace')).body).toContain('id="workbench"')
  expect((await app.browser().request('/workspace')).location).toBe('/login?lang=zh')
  expect((await app.browser().request('/workspace/assets/client.js')).status).toBe(303)
  expect(verified.cookies.join(';')).toContain('HttpOnly')
  expect((await browser.request('/account/sms/verify', { phone: '13800138000', code })).status).toBe(400)
  const account = await browser.request('/account')
  const id = /<code>([a-f0-9-]+)<\/code>/.exec(account.body)![1]!
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  expect((await browser.request('/account/profile', { name: '<img onerror=alert(1)>', image: 'https://example.test/avatar.png' })).status).toBe(200)
  expect((await browser.request('/account')).body).toContain('&lt;img onerror=alert(1)&gt;')
  expect((await browser.request('/account/profile', { name: 'name', image: 'javascript:alert(1)' })).status).toBe(400)
  expect((await browser.request('/account/profile', { name: 'name', image: '' }, true)).status).toBe(403)
  expect((await browser.request('/account/email/send', { newEmail: 'person@example.test' })).status).toBe(200)
  const emailCode = delivery.email.get('person@example.test')!
  expect((await browser.request('/account/email/verify', { newEmail: 'person@example.test', otp: emailCode })).status).toBe(200)
  expect((await browser.request('/account')).body).toContain('person@example.test')
  expect((await browser.request('/account')).body).toContain(id)
  expect((await browser.request('/account/email/verify', { newEmail: 'person@example.test', otp: emailCode })).status).toBe(400)
  expect((await browser.request('/api/auth/sign-up/email', {})).status).toBe(404)
  expect((await browser.request('/account/logout', {})).status).toBe(303)
  expect((await browser.request('/account')).status).toBe(303)
  await app.ctx.fiber.dispose()
  const restarted = await harness()
  const db = new DatabaseSync(join(root!, 'accounts.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('SELECT id, email FROM user').all()).toEqual([expect.objectContaining({ id, email: 'person@example.test' })])
  } finally { db.close() }
  expect((await restarted.browser().request('/login')).status).toBe(200)
})

it('binds WeChat through provider exchange and refuses callbacks without matching state', async () => {
  const app = await harness()
  const browser = app.browser()
  await browser.request('/account/sms/send', { phone: '13900139000' })
  await browser.request('/account/sms/verify', { phone: '13900139000', code: delivery.sms.get('+8613900139000')! })
  const link = await browser.request('/account/wechat', {})
  expect(link.status, link.body).toBe(303)
  const authorize = new URL(link.location!)
  expect(authorize.origin).toBe('https://open.weixin.qq.com')
  expect(authorize.searchParams.get('appid')).toBe('wx-test')
  expect(authorize.searchParams.get('scope')).toBe('snsapi_login')
  const realFetch = globalThis.fetch
  let calls = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== 'api.weixin.qq.com') return realFetch(input, init)
    calls++
    return Response.json(url.pathname.endsWith('access_token') ? { access_token: 'test-token', openid: 'wechat-user', expires_in: 7200 } : { openid: 'wechat-user', nickname: 'WeChat user', headimgurl: 'https://example.test/avatar.png' })
  })
  await browser.request('/api/auth/callback/wechat?code=provider-code&state=wrong')
  expect(calls).toBe(0)
  const state = authorize.searchParams.get('state')!
  const result = await browser.request(`/api/auth/callback/wechat?code=provider-code&state=${encodeURIComponent(state)}`)
  expect(result.status, result.body).toBe(303)
  expect(calls).toBe(2)
  expect((await browser.request('/account')).body).toContain('已绑定')
  expect((await browser.request('/account/wechat', {})).status).toBe(409)
  await browser.request(`/api/auth/callback/wechat?code=provider-code&state=${encodeURIComponent(state)}`)
  expect(calls).toBe(2)
})

it('limits recipient sends and never reports a failed Tencent delivery as sent', async () => {
  const app = await harness()
  const browser = app.browser()
  expect((await browser.request('/account/sms/send', { phone: '13800138000' })).status).toBe(200)
  expect((await browser.request('/account/sms/send', { phone: '13800138000' })).status).toBe(429)
  delivery.fail = true
  const failed = await browser.request('/account/sms/send', { phone: '13900139000' })
  expect(failed.status).toBeGreaterThanOrEqual(400)
  expect(failed.body).not.toContain('验证码已发送，请查收。')
})

it('consumes a phone code once under concurrent requests and exhausts incorrect attempts', async () => {
  const app = await harness()
  const browser = app.browser()
  await browser.request('/account/sms/send', { phone: '13800138000' })
  const code = delivery.sms.get('+8613800138000')!
  const results = await Promise.all([app.browser(), app.browser()].map(client => client.request('/account/sms/verify', { phone: '13800138000', code })))
  expect(results.map(result => result.status).sort()).toEqual([303, 400])
  await browser.request('/account/sms/send', { phone: '13900139000' })
  const other = delivery.sms.get('+8613900139000')!
  const wrong = other === '000000' ? '111111' : '000000'
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await browser.request('/account/sms/verify', { phone: '13900139000', code: wrong })).status).toBe(400)
  }
  expect((await browser.request('/account/sms/verify', { phone: '13900139000', code: other })).status).toBe(403)
})
