/** Real account persistence and HTTP flows; only external delivery is mocked. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Im from '@deepseek-ai/dsh-im'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { createAccountRuntime } from '../src/auth-runtime.ts'
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

async function harness(localTestAccount = false) {
  root ??= await mkdtemp(join(tmpdir(), 'webwjkj-auth-'))
  vi.stubEnv('WJKJ_TEST_SECRET', 'test-secret-value-not-a-real-provider-key')
  const file = join(root, `cordis-${contexts.length}.yml`)
  await writeFile(file, `- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config: { root: ${JSON.stringify(join(root, 'im'))} }
- name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json }
- name: '@deepseek-ai/dsh-im'
  config: { maxParticipants: 20, maxConversations: 20, maxMessages: 100, maxTextBytes: 16384, maxAttachmentBytes: 1048576, maxAttachments: 10 }
- name: '@deepseek-ai/dsh-host-webserver'
  config: { host: 127.0.0.1, port: 0 }
- name: '@deepseek-ai/dsh-webwjkj'
  config:
    auth:
      root: ${JSON.stringify(root)}
      localTestAccount: ${localTestAccount}
      publicOrigin: !!js ('http://127.0.0.1:' + ctx.webServer.port)
      sms: { sdkAppId: test, signName: test, templateId: test, region: ap-guangzhou, secretIdEnv: WJKJ_TEST_SECRET, secretKeyEnv: WJKJ_TEST_SECRET }
      mail: { host: smtp.example.test, port: 465, secure: true, user: test, passwordEnv: WJKJ_TEST_SECRET, from: no-reply@example.test }
      wechat: { appId: wx-test, secretEnv: WJKJ_TEST_SECRET }
`)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-im', Im], ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-webwjkj', Homepage]])
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
        return { status: response.status, referrerPolicy: response.headers.get('referrer-policy'), location: response.headers.get('location'), body: await response.text(), cookies: response.headers.getSetCookie() }
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
  expect((await browser.request('/workspace')).body).toContain('/workspace/ui/ui.css')
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

it('creates an email identity and enables password and phone login for the same UUID', async () => {
  const app = await harness()
  const browser = app.browser()
  const login = await browser.request('/login')
  expect(login.referrerPolicy).toBe('same-origin')
  for (const title of ['短信登录', '账号登录', '邮箱登录', '微信登录']) expect(login.body).toContain(`<h2>${title}</h2>`)
  const emailSent = await browser.request('/account/login/email/send', { email: 'login@example.test' })
  expect(emailSent.status).toBe(200)
  expect(emailSent.body).toContain('id="method-email" aria-label="邮箱登录" checked')
  const code = delivery.email.get('login@example.test')!
  expect((await browser.request('/account/login/email/verify', { email: 'login@example.test', otp: '000000' === code ? '111111' : '000000' })).status).toBe(400)
  expect((await browser.request('/account/login/email/verify', { email: 'login@example.test', otp: code })).location).toBe('/workspace?lang=zh')
  const account = await browser.request('/account')
  const id = /<code>([a-f0-9-]+)<\/code>/.exec(account.body)![1]!
  expect((await browser.request('/account/username', { username: 'test.user' })).status).toBe(200)
  const password = 'testing-password-only-1234'
  const configured = await browser.request('/account/password', { newPassword: password })
  expect(configured.status, configured.body).toBe(200)
  expect((await browser.request('/account/password', { currentPassword: 'wrong-password-123', newPassword: 'changed-password-123' })).status).toBeGreaterThanOrEqual(400)
  expect((await browser.request('/account/phone/send', { phone: '13800138000' })).status).toBe(200)
  expect((await browser.request('/account/phone/verify', { phone: '13800138000', code: delivery.sms.get('+8613800138000')! })).status).toBe(303)
  expect((await browser.request('/account')).body).toContain(id)
  await browser.request('/account/logout', {})
  expect((await browser.request('/account/login/password', { username: 'test.user', password: 'wrong-password-123' })).status).toBeGreaterThanOrEqual(400)
  expect((await browser.request('/account/login/password', { username: 'TEST.USER', password })).location).toBe('/workspace?lang=zh')
  expect((await browser.request('/account')).body).toContain(id)
  const anonymous = app.browser()
  expect((await anonymous.request('/account/password', { newPassword: password })).status).toBe(303)
  const db = new DatabaseSync(join(root!, 'accounts.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('SELECT id FROM user').all()).toEqual([{ id }])
    const credential = db.prepare("SELECT password FROM account WHERE providerId='credential'").get()!
    expect(credential['password']).not.toBe(password)
    expect(typeof credential['password']).toBe('string')
  } finally { db.close() }
})

it('creates and reuses a WeChat login identity without requiring a phone session', async () => {
  const app = await harness()
  const browser = app.browser()
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== 'api.weixin.qq.com') return realFetch(input, init)
    return Response.json(url.pathname.endsWith('access_token') ? { access_token: 'test-token', openid: 'wechat-login', expires_in: 7200 } : { openid: 'wechat-login', nickname: 'Wechat login' })
  })
  let id = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = await browser.request('/account/login/wechat', {})
    expect(start.status, start.body).toBe(303)
    const state = new URL(start.location!).searchParams.get('state')!
    const callback = await browser.request(`/api/auth/callback/wechat?code=provider-code&state=${encodeURIComponent(state)}`)
    expect(callback.location, callback.body).toBe('/workspace?lang=zh')
    const account = await browser.request('/account')
    const current = /<code>([a-f0-9-]+)<\/code>/.exec(account.body)![1]!
    if (id) expect(current).toBe(id)
    id = current
    expect(account.body).not.toContain('@wechat.webwjkj.invalid')
    await browser.request('/account/logout', {})
    await browser.request(`/api/auth/callback/wechat?code=provider-code&state=${encodeURIComponent(state)}`)
    expect((await browser.request('/workspace')).status).toBe(303)
  }
})

it('upgrades the version-one account table without replacing existing users', async () => {
  const app = await harness()
  const browser = app.browser()
  await browser.request('/account/sms/send', { phone: '13800138000' })
  await browser.request('/account/sms/verify', { phone: '13800138000', code: delivery.sms.get('+8613800138000')! })
  await app.ctx.fiber.dispose()
  const db = new DatabaseSync(join(root!, 'accounts.sqlite'))
  let id: unknown
  try {
    id = db.prepare('SELECT id FROM user').get()!['id']
    // This fixture reconstructs the released v1 table, which has no username column.
    db.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE user_v1 (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL, phoneNumber TEXT UNIQUE, phoneNumberVerified INTEGER);
      INSERT INTO user_v1 SELECT id,name,email,emailVerified,image,createdAt,updatedAt,phoneNumber,phoneNumberVerified FROM user;
      DROP TABLE user;
      ALTER TABLE user_v1 RENAME TO user;
      PRAGMA user_version=1;` )
  } finally { db.close() }
  const restarted = await harness()
  expect((await restarted.browser().request('/login')).status).toBe(200)
  const upgraded = new DatabaseSync(join(root!, 'accounts.sqlite'), { readOnly: true })
  try {
    expect(upgraded.prepare('PRAGMA user_version').get()!['user_version']).toBe(3)
    expect(upgraded.prepare('SELECT id, username FROM user').all()).toEqual([{ id, username: null }])
  } finally { upgraded.close() }
})


it('seeds a local admin once, preserves changed passwords, and keeps it out of ordinary storage', async () => {
  const local = await harness(true)
  const browser = local.browser()
  expect((await browser.request('/account/login/password', { username: 'admin', password: '123123' })).location).toBe('/workspace?lang=zh')
  const account = await browser.request('/account')
  const id = /<code>([a-f0-9-]+)<\/code>/.exec(account.body)![1]!
  expect((await browser.request('/account/password', { currentPassword: '123123', newPassword: 'local-changed-password' })).status).toBe(200)
  await local.ctx.fiber.dispose()
  const restarted = await harness(true)
  const client = restarted.browser()
  expect((await client.request('/account/login/password', { username: 'admin', password: '123123' })).status).toBeGreaterThanOrEqual(400)
  expect((await client.request('/account/login/password', { username: 'admin', password: 'local-changed-password' })).status).toBe(303)
  expect((await client.request('/account')).body).toContain(id)
  await restarted.ctx.fiber.dispose()
  const ordinary = await harness()
  expect((await ordinary.browser().request('/account/login/password', { username: 'admin', password: '123123' })).status).toBeGreaterThanOrEqual(400)
  const db = new DatabaseSync(join(root!, 'accounts.sqlite'), { readOnly: true })
  try { expect(db.prepare('SELECT id FROM user').all()).toEqual([]) } finally { db.close() }
})

it('rejects the local fixture in production and for public origins before opening storage', async () => {
  const config = { root: '/unused', publicOrigin: 'https://example.test', localTestAccount: true, otpSeconds: 300, otpAttempts: 3, resendSeconds: 60, dailySendLimit: 10, sessionSeconds: 3600, requestsPerMinute: 60, providerTimeoutMs: 10000, maxBodyBytes: 16384, lockWaitMs: 15000 }
  await expect(createAccountRuntime(config)).rejects.toThrow('forbidden in production or with a public origin')
  vi.stubEnv('NODE_ENV', 'production')
  await expect(createAccountRuntime({ ...config, publicOrigin: 'http://127.0.0.1' })).rejects.toThrow('forbidden in production or with a public origin')
})


it('projects only the signed-in user’s IM contacts, groups, and permitted conversation history', async () => {
  const app = await harness(true)
  const alice = app.browser(), bob = app.browser()
  await alice.request('/account/login/password', { username: 'admin', password: '123123' })
  await bob.request('/account/sms/send', { phone: '13800138000' })
  await bob.request('/account/sms/verify', { phone: '13800138000', code: delivery.sms.get('+8613800138000')! })
  const accountId = async (browser: ReturnType<typeof app.browser>) => Im.participantIdSchema.parse(`webwjkj:${/<code>([a-f0-9-]+)<\/code>/.exec((await browser.request('/account')).body)![1]!}`)
  const a = await accountId(alice), b = await accountId(bob)
  expect((await alice.request('/account/im')).status).toBe(200)
  expect((await bob.request('/account/im')).status).toBe(200)
  const friend = Im.participantIdSchema.parse('fixture-friend')
  await app.ctx.im.addParticipant({ id: friend, kind: 'human', name: '小林', namespace: 'webwjkj' })
  await app.ctx.im.addContact(a, a, friend)
  const team = Im.conversationIdSchema.parse('fixture-team'), privateRoom = Im.conversationIdSchema.parse('fixture-private')
  await app.ctx.im.addConversation({ id: team, kind: 'group', namespace: 'webwjkj', name: '项目群', owner: a, members: [a, friend], maxAiMessages: 0 })
  await app.ctx.im.addConversation({ id: privateRoom, kind: 'group', namespace: 'webwjkj', name: '私有群', owner: b, members: [b, friend], maxAiMessages: 0 })
  await app.ctx.im.send({ id: Im.imMessageIdSchema.parse('fixture-message'), conversation: team, sender: friend, recipients: [a], text: '你好', attachments: [], mode: 'queue' })
  const directory = await alice.request('/account/im?userId=' + b)
  expect(JSON.parse(directory.body)).toEqual({ entries: [{ id: team, name: '项目群', kind: 'group' }, { id: friend, name: '小林', kind: 'contact' }, { id: 'webwjkj:default-agent', name: 'default agent', kind: 'contact' }] })
  const direct = Im.conversationIdSchema.parse('fixture-direct')
  await app.ctx.im.addConversation({ id: direct, kind: 'direct', namespace: 'webwjkj', name: '小林', owner: a, members: [a, friend], maxAiMessages: 0 })
  const reply = { id: Im.imMessageIdSchema.parse('fixture-reply'), conversation: direct, sender: a, recipients: [friend], text: '回复', attachments: [], mode: 'queue' as const }
  await app.ctx.im.send(reply)
  expect((JSON.parse((await alice.request('/account/im')).body) as { entries: { id: string }[] }).entries.map((entry: { id: string }) => entry.id)).toEqual([friend, team, 'webwjkj:default-agent'])
  await app.ctx.im.send({ id: Im.imMessageIdSchema.parse('fixture-newest'), conversation: team, sender: friend, recipients: [a], text: '最新群消息', attachments: [], mode: 'queue' })
  await app.ctx.im.send(reply)
  expect((JSON.parse((await alice.request('/account/im')).body) as { entries: { id: string }[] }).entries.map((entry: { id: string }) => entry.id)).toEqual([team, friend, 'webwjkj:default-agent'])
  const history = await alice.request('/account/im/history?kind=group&id=' + team)
  expect(JSON.parse(history.body)).toEqual({ name: '项目群', messages: [{ id: 'fixture-message', sender: '小林', text: '你好', own: false }, { id: 'fixture-newest', sender: '小林', text: '最新群消息', own: false }] })
  expect((await alice.request('/account/im/history?kind=group&id=' + privateRoom)).status).toBe(403)
  expect((await bob.request('/account/im/history?kind=contact&id=' + friend)).status).toBe(403)
  expect((await app.browser().request('/account/im')).status).toBe(401)
  await app.ctx.fiber.dispose()
  const restarted = await harness(true)
  const restored = restarted.browser()
  await restored.request('/account/login/password', { username: 'admin', password: '123123' })
  expect((JSON.parse((await restored.request('/account/im')).body) as { entries: { id: string }[] }).entries.map((entry: { id: string }) => entry.id)).toEqual([team, friend, 'webwjkj:default-agent'])
})

it('discovers exact verified identities and persists recipient-approved friendships and greetings', async () => {
  const app = await harness()
  const friendResult = (text: string) => z.object({ requests: z.array(z.object({
    id: z.uuid(), sender: z.uuid(), recipient: z.uuid(), greeting: z.string(), status: z.string(),
  })) }).parse(JSON.parse(text))
  const contactsResult = (text: string) => z.object({
    entries: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  }).parse(JSON.parse(text))
  const alice = app.browser(); const bob = app.browser(); const stranger = app.browser()
  async function login(browser: ReturnType<typeof app.browser>, phone: string): Promise<string> {
    await browser.request('/account/sms/send', { phone })
    expect((await browser.request('/account/sms/verify', { phone, code: delivery.sms.get(`+86${phone}`)! })).status).toBe(303)
    return /<code>([a-f0-9-]+)<\/code>/.exec((await browser.request('/account')).body)![1]!
  }
  const aliceId = await login(alice, '13800138101')
  const bobId = await login(bob, '13800138102')
  await login(stranger, '13800138103')
  await bob.request('/account/profile', { name: 'Bob', image: '' })
  await bob.request('/account/email/send', { newEmail: 'bob@example.test' })
  expect((await bob.request('/account/email/verify', { newEmail: 'bob@example.test', otp: delivery.email.get('bob@example.test')! })).status).toBe(200)
  for (const query of [bobId, '13800138102', '+8613800138102', 'BOB@example.test']) {
    const result = await alice.request('/account/friends', { action: 'search', query })
    expect(result.status, result.body).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ profile: { id: bobId, name: 'Bob', image: null } })
    expect(result.body).not.toContain('phoneNumber')
  }
  expect(JSON.parse((await alice.request('/account/friends', { action: 'search', query: '13800138' })).body)).toEqual({ profile: null })
  expect((await alice.request('/account/friends', { action: 'request', target: aliceId, greeting: '' })).status).toBe(400)
  expect((await alice.request('/account/friends', { action: 'request', target: bobId, greeting: 'hello' }, true)).status).toBe(403)
  const submitted = await alice.request('/account/friends', { action: 'request', target: bobId, greeting: '<hello>你好' })
  expect(submitted.status, submitted.body).toBe(200)
  const requestId = friendResult(submitted.body).requests[0]!.id
  expect(contactsResult((await alice.request('/account/im')).body).entries).toEqual([{ id: 'webwjkj:default-agent', name: 'default agent', kind: 'contact' }])
  expect((await stranger.request('/account/friends', { action: 'accept', requestId })).status).toBe(400)
  expect((await alice.request('/account/friends', { action: 'accept', requestId })).status).toBe(400)
  const inbox = friendResult((await bob.request('/account/friends', { action: 'list' })).body)
  expect(inbox.requests.map(({ greeting, status }) => ({ greeting, status }))).toMatchInlineSnapshot(`
    [
      {
        "greeting": "<hello>你好",
        "status": "pending",
      },
    ]
  `)
  expect(inbox.requests[0]).toMatchObject({ id: requestId, sender: aliceId, recipient: bobId, greeting: '<hello>你好', status: 'pending' })
  expect((await bob.request('/account/friends', { action: 'reject', requestId })).status).toBe(200)
  expect(contactsResult((await alice.request('/account/im')).body).entries).toEqual([{ id: 'webwjkj:default-agent', name: 'default agent', kind: 'contact' }])
  await alice.request('/account/friends', { action: 'request', target: bobId, greeting: '再次申请' })
  expect((await bob.request('/account/friends', { action: 'accept', requestId })).status).toBe(200)
  expect((await bob.request('/account/friends', { action: 'accept', requestId })).status).toBe(200)
  expect(contactsResult((await alice.request('/account/im')).body).entries).toEqual([{ id: `webwjkj:${bobId}`, name: 'Bob', kind: 'contact' }, { id: 'webwjkj:default-agent', name: 'default agent', kind: 'contact' }])
  expect(contactsResult((await bob.request('/account/im')).body).entries.find(entry => entry.id !== 'webwjkj:default-agent')!.id).toBe(`webwjkj:${aliceId}`)
  expect(friendResult((await stranger.request('/account/friends', { action: 'list' })).body).requests).toEqual([])
  expect((await bob.request('/account/username', { username: 'friend_bob' })).status).toBe(200)
  expect((await bob.request('/account/password', { newPassword: 'friend-test-password' })).status).toBe(200)
  await app.ctx.fiber.dispose()
  const restarted = await harness()
  const restored = restarted.browser()
  expect((await restored.request('/account/login/password', { username: 'friend_bob', password: 'friend-test-password' })).status).toBe(303)
  expect(friendResult((await restored.request('/account/friends', { action: 'list' })).body).requests[0]).toMatchObject({ id: requestId, status: 'accepted', greeting: '再次申请' })
  expect(contactsResult((await restored.request('/account/im')).body).entries.find(entry => entry.id !== 'webwjkj:default-agent')!.id).toBe(`webwjkj:${aliceId}`)
})

it('provides the default agent and creates private groups only from the caller’s contacts', async () => {
  const app = await harness(true)
  const owner = app.browser(), other = app.browser()
  await owner.request('/account/login/password', { username: 'admin', password: '123123' })
  await other.request('/account/sms/send', { phone: '13800138120' })
  await other.request('/account/sms/verify', { phone: '13800138120', code: delivery.sms.get('+8613800138120')! })
  const agent = 'webwjkj:default-agent'
  expect(JSON.parse((await owner.request('/account/im')).body)).toMatchInlineSnapshot(`
    {
      "entries": [
        {
          "id": "webwjkj:default-agent",
          "kind": "contact",
          "name": "default agent",
        },
      ],
    }
  `)
  const selected = '/account/im/history?kind=contact&id=' + agent
  expect(JSON.parse((await owner.request(selected)).body)).toEqual({ name: 'default agent', messages: [] })
  const groupForm = { name: '工作群', members: JSON.stringify([agent]) }
  expect((await owner.request('/account/im/group', groupForm, true)).status).toBe(403)
  expect((await owner.request('/account/im/group', { ...groupForm, members: '["unknown"]' })).status).toBe(400)
  expect((await owner.request('/account/im/group', { ...groupForm, members: JSON.stringify([agent, agent]) })).status).toBe(400)
  const response = await owner.request('/account/im/group', groupForm)
  expect(response.status, response.body).toBe(200)
  const group = z.object({ id: z.uuid(), name: z.string(), kind: z.literal('group') }).parse(JSON.parse(response.body))
  const history = `/account/im/history?kind=group&id=${group.id}`
  expect((await other.request(history)).status).toBe(403)
  const message = { messageId: '11111111-1111-4111-8111-111111111111', text: '工作群消息' }
  expect((await other.request(`/account/im/message?kind=group&id=${group.id}`, message)).status).toBe(400)
  expect((await owner.request(`/account/im/message?kind=group&id=${group.id}`, message)).status).toBe(200)
  expect((await owner.request(`/account/im/message?kind=group&id=${group.id}`, message)).status).toBe(200)
  const records = z.object({ messages: z.array(z.object({ text: z.string() })) }).parse(JSON.parse((await owner.request(history)).body))
  expect(records.messages).toEqual([{ text: '工作群消息' }])
  expect((await app.browser().request('/account/me')).status).toBe(401)
  const me = z.object({ id: z.uuid(), name: z.string() }).parse(JSON.parse((await owner.request('/account/me')).body))
  expect(me.name).toBe('admin')
  const signedOut = await owner.request('/account/logout', {})
  expect(signedOut.location).toBe('/login?lang=zh')
  expect((await owner.request('/account/me')).status).toBe(401)
  await app.ctx.fiber.dispose()
  const restarted = await harness(true), restored = restarted.browser()
  await restored.request('/account/login/password', { username: 'admin', password: '123123' })
  expect((await restored.request(history)).status).toBe(200)
})
