/** Script-free account HTTP forms over the private authentication runtime. */
import { friendInput } from './friends.ts'
import { readFile } from 'node:fs/promises'
import { renderWorkspace } from './workspace-page.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { avatarSchema, usernameSchema, type AccountRuntime } from './auth-runtime.ts'
import { renderAccount, type AccountNotice, type LoginMethod } from './account-page.ts'
import type { AccountUser } from './account-types.ts'
import type { Locale } from './locales.ts'

const phoneSchema = z.string().transform(value => value.replace(/[\s-]/g, '')).transform(value => value.startsWith('+') ? value : `+86${value}`).pipe(z.string().regex(/^\+861[3-9]\d{9}$/))
const codeSchema = z.string().regex(/^\d{6}$/)
const passwordSchema = z.string().min(12).max(128)
const loginNameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/)
const emailSchema = z.email().max(254).transform(value => value.toLowerCase())

/**
 * Handle account forms and the WeChat callback without exposing other auth endpoints.
 * @param runtime - account service and deployment policy.
 * @param req - browser request; peer address comes from the socket, not proxy headers.
 * @param res - response receiving private HTML and HttpOnly login cookies.
 * @param readIm - optional authenticated IM directory and history projection.
 * @param assets - reader confined to the installed upstream browser artifacts.
 */
export async function handleAccount(
  runtime: AccountRuntime, req: IncomingMessage, res: ServerResponse,
  readIm?: (user: AccountUser, url: URL, form?: URLSearchParams) => Promise<unknown>,
  assets?: (path: string) => Promise<{ content: Buffer; type: string } | undefined>,
): Promise<void> {
  const config = runtime.config
  const url = new URL(req.url ?? '/', config.publicOrigin)
  const headers = fromNodeHeaders(req.headers)
  headers.set('x-webwjkj-peer-ip', req.socket.remoteAddress ?? 'unknown')
  let locale: Locale = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
  let phone = ''
  let email = ''
  function redirect(path: string) { res.writeHead(303, { Location: path, 'Cache-Control': 'no-store' }); res.end() }
  async function page(notice?: AccountNotice, status = 200) {
    const user = await runtime.user(headers)
    const requested = url.searchParams.get('method')
    const method: LoginMethod = url.pathname.includes('/login/email/') ? 'email'
      : url.pathname.endsWith('/login/password') ? 'password'
        : url.pathname.includes('wechat') ? 'wechat'
          : requested === 'email' || requested === 'password' || requested === 'wechat' ? requested : 'sms'
    const html = renderAccount(locale, user, config, notice, phone, email, method)
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : html)
  }
  async function call(path: string, body: Record<string, unknown>) {
    const authHeaders = new Headers(headers)
    authHeaders.set('content-type', 'application/json')
    authHeaders.delete('content-length')
    const response = await runtime.handle(new Request(`${config.publicOrigin}/api/auth${path}`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(body),
    }))
    const cookies = response.headers.getSetCookie()
    if (cookies.length) res.setHeader('Set-Cookie', cookies)
    return response
  }
  try {
    if (url.pathname === '/api/auth/callback/wechat' && req.method === 'GET') {
      if (!config.wechat) { redirect(`/login?lang=${locale}`); return }
      const response = await runtime.handle(new Request(url, { headers }))
      const cookies = response.headers.getSetCookie()
      if (cookies.length) res.setHeader('Set-Cookie', cookies)
      const location = response.headers.get('location')
      const target = location ? new URL(location, config.publicOrigin) : null
      if (target?.origin === config.publicOrigin && ['/account', '/workspace', '/login'].includes(target.pathname)) { redirect(target.pathname + target.search); return }
      await page('invalid', 400)
      return
    }
    if ((url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) && (req.method === 'GET' || req.method === 'HEAD')) {
      const user = await runtime.user(headers)
      if (!user) { redirect(`/login?lang=${locale}`); return }
      let content: string | Buffer
      let type: string
      if (url.pathname === '/workspace' || url.pathname === '/workspace/') {
        content = renderWorkspace(locale, user)
        type = 'text/html; charset=utf-8'
      } else if (url.pathname === '/workspace/assets/client.css') {
        content = await readFile(new URL('./lib/client.css', import.meta.resolve('@deepseek-ai/dsh-webwjkj/package.json')))
        type = 'text/css; charset=utf-8'
      } else if (url.pathname === '/workspace/assets/client.js') {
        content = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-webwjkj/client')))
        type = 'text/javascript; charset=utf-8'
      } else if (url.pathname.startsWith('/workspace/ui/')) {
        const asset = await assets?.(url.pathname)
        if (!asset) { res.writeHead(404); res.end(); return }
        content = asset.content; type = asset.type
      } else { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'none'; base-uri 'self'; frame-ancestors 'self'",
        'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : content)
      return
    }
    if (req.method === 'GET' && url.pathname === '/account/me') {
      const user = await runtime.user(headers)
      if (!user) { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(user)); return
    }
    if (req.method === 'GET' && (url.pathname === '/account/im' || url.pathname === '/account/im/history')) {
      const user = await runtime.user(headers)
      if (!user) { res.writeHead(401); res.end(); return }
      if (!readIm) { res.writeHead(503); res.end(); return }
      try {
        const data = await readIm(user, url)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(JSON.stringify(data))
      } catch { res.writeHead(403); res.end() }
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!['/account', '/account/settings', '/login'].includes(url.pathname)) { res.writeHead(404); res.end(); return }
      if (url.pathname !== '/login' && !(await runtime.user(headers))) { redirect(`/login?lang=${locale}`); return }
      if (url.pathname === '/account') {
        redirect(`/workspace?lang=${locale}&panel=security${url.searchParams.has('error') ? '&error=account' : ''}`)
        return
      }
      await page(url.searchParams.has('error') ? 'invalid' : undefined)
      return
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end(); return }
    if (req.headers.origin !== config.publicOrigin) { res.writeHead(403); res.end(); return }
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { res.writeHead(415); res.end(); return }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += bytes.length
      if (size > config.maxBodyBytes) { res.writeHead(413); res.end(); return }
      chunks.push(bytes)
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    locale = form.get('lang') === 'en' ? 'en' : 'zh'
    const user = await runtime.user(headers)
    const isSms = url.pathname === '/account/sms/send' || url.pathname === '/account/sms/verify'
    const isLogin = ['/account/login/password', '/account/login/email/send', '/account/login/email/verify', '/account/login/wechat'].includes(url.pathname)
    if (!isSms && !isLogin && !user) { redirect(`/login?lang=${locale}`); return }
    if ((url.pathname === '/account/im/group' || url.pathname === '/account/im/message') && user) {
      if (!readIm) { res.writeHead(503); res.end(); return }
      try {
        const data = await readIm(user, url, form)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data))
      } catch { res.writeHead(400); res.end() }
      return
    }
    if (url.pathname === '/account/friends') {
      if (!user) { res.writeHead(401); res.end(); return }
      try {
        const data = await runtime.friends(user.id, friendInput.parse(Object.fromEntries(form)))
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(data))
      } catch { res.writeHead(400); res.end() }
      return
    }
    let result: Response
    let notice: AccountNotice = 'saved'
    switch (url.pathname) {
      case '/account/sms/send':
      case '/account/sms/verify':
      case '/account/phone/send':
      case '/account/phone/verify': {
        if (!config.sms) { await page('unavailable', 503); return }
        phone = phoneSchema.parse(form.get('phone'))
        const send = url.pathname.endsWith('/send')
        result = await call(send ? '/phone-number/send-otp' : '/phone-number/verify', send ? { phoneNumber: phone } : { phoneNumber: phone, code: codeSchema.parse(form.get('code')), ...url.pathname.startsWith('/account/phone/') ? { updatePhoneNumber: true } : {} })
        if (result.ok && !send) { redirect(`/workspace?lang=${locale}`); return }
        notice = 'sent'
        break
      }
      case '/account/login/password':
        result = await call('/sign-in/username', { username: loginNameSchema.parse(form.get('username')), password: z.string().min(config.localTestAccount ? 6 : 12).max(128).parse(form.get('password')) })
        if (result.ok) { redirect(`/workspace?lang=${locale}`); return }
        break
      case '/account/login/email/send':
      case '/account/login/email/verify': {
        if (!config.mail) { await page('unavailable', 503); return }
        email = emailSchema.parse(form.get('email'))
        const send = url.pathname.endsWith('/send')
        result = await call(send ? '/email-otp/send-verification-otp' : '/sign-in/email-otp', send ? { email, type: 'sign-in' } : { email, otp: codeSchema.parse(form.get('otp')), name: 'webwjkj' })
        if (result.ok && !send) { redirect(`/workspace?lang=${locale}`); return }
        notice = 'sent'
        break
      }
      case '/account/username':
        result = await call('/update-user', { username: loginNameSchema.parse(form.get('username')) })
        break
      case '/account/password': {
        const newPassword = passwordSchema.parse(form.get('newPassword'))
        result = user?.hasPassword
          ? await call('/change-password', { newPassword, currentPassword: z.string().min(config.localTestAccount ? 6 : 12).max(128).parse(form.get('currentPassword')), revokeOtherSessions: true })
          : await runtime.setPassword(headers, newPassword)
        const cookies = result.headers.getSetCookie()
        if (cookies.length) res.setHeader('Set-Cookie', cookies)
        break
      }
      case '/account/profile':
        result = await call('/update-user', { name: usernameSchema.parse(form.get('name')), image: avatarSchema.parse(form.get('image')) || null })
        break
      case '/account/email/send':
      case '/account/email/verify': {
        if (!config.mail) { await page('unavailable', 503); return }
        email = emailSchema.parse(form.get('newEmail'))
        const send = url.pathname.endsWith('/send')
        result = await call(send ? '/email-otp/request-email-change' : '/email-otp/change-email', send ? { newEmail: email } : { newEmail: email, otp: codeSchema.parse(form.get('otp')) })
        notice = send ? 'sent' : 'saved'
        break
      }
      case '/account/login/wechat':
      case '/account/wechat': {
        if (!config.wechat) { await page('unavailable', 503); return }
        const signingIn = url.pathname === '/account/login/wechat'
        if (!signingIn && user?.wechat) { await page('invalid', 409); return }
        result = await call(signingIn ? '/sign-in/social' : '/link-social', { provider: 'wechat', callbackURL: `/${signingIn ? 'workspace' : 'account'}?lang=${locale}`, errorCallbackURL: `/${signingIn ? 'login' : 'account'}?lang=${locale}${signingIn ? '&method=wechat' : ''}` })
        if (result.ok) {
          const data = z.object({ url: z.url() }).parse(await result.json())
          if (new URL(data.url).origin !== 'https://open.weixin.qq.com') throw new Error('Unexpected authorization URL')
          redirect(data.url)
          return
        }
        break
      }
      case '/account/logout':
        result = await call('/sign-out', {})
        if (result.ok) { redirect(`/login?lang=${locale}`); return }
        break
      default: res.writeHead(404); res.end(); return
    }
    await page(result.ok ? notice : result.status === 429 ? 'limited' : 'invalid', result.ok ? 200 : result.status)
  } catch (error) {
    if (res.headersSent) { res.destroy(); return }
    await page(error instanceof z.ZodError ? 'invalid' : 'unavailable', error instanceof z.ZodError ? 400 : 503)
  }
}
