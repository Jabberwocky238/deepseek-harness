/** Server-rendered login and account forms with locale-owned copy. */
import type { Locale } from './locales.ts'
import type { AccountUser } from './account-types.ts'
import type { AuthConfig } from './auth-config.ts'
import { styles } from './styles.ts'
import { loginStyles } from './login-styles.ts'

const zh = {
  loginSubtitle: '登录以进入你的工作台。', language: 'English',
  signIn: '登录 webwjkj', passwordLogin: '账号登录', emailLogin: '邮箱登录', wechatLogin: '微信登录', loginName: '登录账号', password: '密码', currentPassword: '当前密码', newPassword: '新密码（12–128 位）', savePassword: '保存密码', saveLoginName: '保存登录账号', loginHint: '首次使用短信、邮箱或微信验证创建账号，在账号设置中开通账号密码。登录账号为 3–30 位字母、数字、下划线或点。', emailIntro: '邮箱验证后登录，首次验证自动创建账号。', wechatSignIn: '微信扫码登录', wechatLoginInfo: '扫码授权后登录，首次授权自动创建账号。', phoneBind: '绑定手机', verifyPhone: '验证并绑定手机',
  login: '短信登录', account: '我的账号', back: '返回首页', workspace: '返回工作台', intro: '使用短信验证码登录，首次验证自动创建账号。',
  phone: '手机号码', code: '验证码', send: '发送验证码', verify: '验证并登录', sent: '验证码已发送，请查收。',
  invalid: '操作未完成，请检查输入或重新获取验证码。', limited: '操作过于频繁，请稍后重试。',
  unavailable: '该服务尚未开通，请稍后再试。', saved: '修改已保存。',
  profile: '个人资料', username: '用户名', avatar: '头像链接（HTTPS）', save: '保存资料',
  userId: '用户 ID', email: '邮箱', emailCode: '邮箱验证码', bindEmail: '验证并绑定邮箱',
  boundEmail: '已绑定邮箱', unbound: '未绑定', wechat: '微信', bindWechat: '微信扫码绑定',
  wechatInfo: '前往微信授权页面，扫码并确认后完成绑定。', bound: '已绑定', logout: '退出登录',
  smsMissing: '短信登录尚未开通。', mailMissing: '邮箱验证尚未开通。', wechatMissing: '微信绑定尚未开通。',
}
const copy: Record<Locale, typeof zh> = { zh, en: {
  loginSubtitle: 'Sign in to your workspace.', language: '中文',
  signIn: 'Sign in to webwjkj', passwordLogin: 'Account sign in', emailLogin: 'Email sign in', wechatLogin: 'WeChat sign in', loginName: 'Login username', password: 'Password', currentPassword: 'Current password', newPassword: 'New password (12–128 characters)', savePassword: 'Save password', saveLoginName: 'Save login username', loginHint: 'Create an account through phone, email, or WeChat verification, then configure a password in account settings. Login usernames use 3–30 letters, digits, underscores, or dots.', emailIntro: 'Sign in with an email code. First verification creates an account.', wechatSignIn: 'Sign in with WeChat QR code', wechatLoginInfo: 'Scan and authorize to sign in. First authorization creates an account.', phoneBind: 'Bind phone', verifyPhone: 'Verify and bind phone',
  login: 'SMS sign in', account: 'My account', back: 'Back home', workspace: 'Back to workbench', intro: 'Sign in with a phone verification code. Your first sign-in creates an account.',
  phone: 'Phone number', code: 'Verification code', send: 'Send code', verify: 'Verify and sign in', sent: 'Verification code sent. Check your messages.',
  invalid: 'Could not complete the request. Check your input or request a new code.', limited: 'Too many requests. Please try again later.',
  unavailable: 'This service is not available yet. Please try again later.', saved: 'Changes saved.',
  profile: 'Profile', username: 'Username', avatar: 'Avatar URL (HTTPS)', save: 'Save profile',
  userId: 'User ID', email: 'Email', emailCode: 'Email verification code', bindEmail: 'Verify and bind email',
  boundEmail: 'Bound email', unbound: 'Not bound', wechat: 'WeChat', bindWechat: 'Bind with WeChat QR code',
  wechatInfo: 'Continue to WeChat, scan the QR code, and confirm to bind your account.', bound: 'Bound', logout: 'Sign out',
  smsMissing: 'SMS sign-in is not available yet.', mailMissing: 'Email verification is not available yet.', wechatMissing: 'WeChat binding is not available yet.',
} }

/** Login form selected by navigation or its preceding submission. */
export type LoginMethod = 'sms' | 'password' | 'email' | 'wechat'

/** Localized outcome rendered after an account action. */
export type AccountNotice = 'sent' | 'saved' | 'invalid' | 'limited' | 'unavailable'

/**
 * Escape text before including it in HTML content or double-quoted attributes.
 * @param value - text or attribute value.
 * @returns HTML-escaped text.
 */
export function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, character => entities[character] ?? character)
}

/**
 * Render a public login form or the authenticated user's profile and bindings.
 * @param locale - page language.
 * @param user - authenticated user, or null for login.
 * @param config - deployment provider availability.
 * @param notice - localized outcome from a preceding action.
 * @param phone - phone form value to preserve after sending a code.
 * @param email - email form value to preserve after sending a code.
 * @param method - initially selected login method, retained after form submission.
 * @returns complete script-free HTML document.
 */
export function renderAccount(locale: Locale, user: AccountUser | null, config: AuthConfig, notice?: AccountNotice, phone = '', email = '', method: LoginMethod = 'sms'): string {
  const t = copy[locale]
  const lang = `<input type="hidden" name="lang" value="${locale}">`
  const disabled = (available: unknown) => available ? '' : ' disabled'
  const input = (label: string, name: string, value: string, type = 'text', attributes = '') => `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${attributes}></label>`
  const title = user ? t.account : t.signIn
  const content = user ? `
<section class="card" id="profile"><h2>${t.profile}</h2><div class="identity">${user.image ? `<img class="avatar" src="${escapeHtml(user.image)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar placeholder" aria-hidden="true">${escapeHtml(user.name.slice(0,1))}</span>`}<div><strong>${escapeHtml(user.name)}</strong><p>${escapeHtml(user.phone)}</p></div></div><dl><dt>${t.userId}</dt><dd><code>${user.id}</code></dd></dl>
<form method="post" action="/account/profile">${lang}${input(t.username,'name',user.name,'text','required maxlength="40" autocomplete="nickname"')}${input(t.avatar,'image',user.image ?? '','url','maxlength="2048"')}<button>${t.save}</button></form></section>
<section class="card" id="security"><h2>${t.passwordLogin}</h2><p>${t.loginHint}</p><form method="post" action="/account/username">${lang}${input(t.loginName,'username',user.loginName ?? '','text','required minlength="3" maxlength="30" autocomplete="username"')}<button>${t.saveLoginName}</button></form><form method="post" action="/account/password">${lang}${user.hasPassword ? input(t.currentPassword,'currentPassword','','password',`required autocomplete="current-password" minlength="${config.localTestAccount ? 6 : 12}" maxlength="128"`) : ''}${input(t.newPassword,'newPassword','','password','required autocomplete="new-password" minlength="12" maxlength="128"')}<button>${t.savePassword}</button></form></section>
<section class="card"><h2>${t.phoneBind}</h2><p>${escapeHtml(user.phone || t.unbound)}</p><form method="post" action="/account/phone/verify">${lang}${input(t.phone,'phone',phone,'tel','required maxlength="16" autocomplete="tel"')}${input(t.code,'code','','text','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"')}<div class="form-actions"><button formaction="/account/phone/send"${disabled(config.sms)}>${t.send}</button><button${disabled(config.sms)}>${t.verifyPhone}</button></div></form></section>
<section class="card"><h2>${t.email}</h2><p>${t.boundEmail}: ${escapeHtml(user.email ?? t.unbound)}</p>${config.mail ? '' : `<p>${t.mailMissing}</p>`}<form method="post" action="/account/email/verify">${lang}${input(t.email,'newEmail',email,'email','required maxlength="254" autocomplete="email"')}${input(t.emailCode,'otp','','text','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"')}<div class="form-actions"><button formaction="/account/email/send"${disabled(config.mail)}>${t.send}</button><button${disabled(config.mail)}>${t.bindEmail}</button></div></form></section>
<section class="card"><h2>${t.wechat}</h2><p>${user.wechat ? t.bound : t.wechatInfo}</p>${config.wechat ? '' : `<p>${t.wechatMissing}</p>`}<form method="post" action="/account/wechat">${lang}<button${disabled(config.wechat && !user.wechat)}>${user.wechat ? t.bound : t.bindWechat}</button></form></section>
<form method="post" action="/account/logout">${lang}<button class="secondary-button">${t.logout}</button></form>` : `
<section class="card"><h2>${t.login}</h2><p>${t.intro}</p>${config.sms ? '' : `<p role="status">${t.smsMissing}</p>`}<form method="post" action="/account/sms/verify">${lang}${input(t.phone,'phone',phone,'tel','required placeholder="+86" autocomplete="tel" maxlength="16"')}${input(t.code,'code','','text','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"')}<div class="form-actions"><button formaction="/account/sms/send"${disabled(config.sms)}>${t.send}</button><button${disabled(config.sms)}>${t.verify}</button></div></form></section>`
  const loginMethods = user ? '' : `
<section class="card method-password"><h2>${t.passwordLogin}</h2><p>${t.loginHint}</p><form method="post" action="/account/login/password">${lang}${input(t.loginName,'username','','text','required autocomplete="username" minlength="3" maxlength="30"')}${input(t.password,'password','','password',`required autocomplete="current-password" minlength="${config.localTestAccount ? 6 : 12}" maxlength="128"`)}<button>${t.passwordLogin}</button></form></section>
<section class="card method-email"><h2>${t.emailLogin}</h2><p>${t.emailIntro}</p>${config.mail ? '' : `<p>${t.mailMissing}</p>`}<form method="post" action="/account/login/email/verify">${lang}${input(t.email,'email',email,'email','required autocomplete="email" maxlength="254"')}${input(t.emailCode,'otp','','text','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"')}<div class="form-actions"><button formaction="/account/login/email/send"${disabled(config.mail)}>${t.send}</button><button${disabled(config.mail)}>${t.emailLogin}</button></div></form></section>
<section class="card method-wechat"><h2>${t.wechatLogin}</h2><p>${t.wechatLoginInfo}</p>${config.wechat ? '' : `<p>${t.wechatMissing}</p>`}<form method="post" action="/account/login/wechat">${lang}<button${disabled(config.wechat)}>${t.wechatSignIn}</button></form></section>`
  const methods: [LoginMethod, string][] = [['sms', t.login], ['password', t.passwordLogin], ['email', t.emailLogin], ['wechat', t.wechatLogin]]
  const selectors = methods.map(([key, label]) => `<input class="method-radio" type="radio" name="login-method" id="method-${key}" aria-label="${label}"${method === key ? ' checked' : ''}>`).join('')
  const mailIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>'
  const wechatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 10.5C15.5 6.9 12.5 4 8.8 4S2 6.6 2 9.8c0 1.8 1 3.4 2.6 4.5L4 17l3.2-1.5M22 15c0 2.8-2.7 5-6 5l-2-.3-2.8 1 .6-2.2C10.7 17.6 10 16.4 10 15c0-2.8 2.7-5 6-5s6 2.2 6 5Z"/><circle cx="6.5" cy="9" r=".6"/><circle cx="10.5" cy="9" r=".6"/><circle cx="14" cy="14.5" r=".6"/><circle cx="18" cy="14.5" r=".6"/></svg>'
  const login = `<div class="login-methods">${selectors}<div class="login-tabs"><label for="method-sms">${t.login}</label><label for="method-password">${t.passwordLogin}</label></div><div class="login-panels">${content.replace('<section class="card">', '<section class="card method-sms">')}${loginMethods}</div><div class="login-icons"><label for="method-email" title="${t.emailLogin}" aria-label="${t.emailLogin}">${mailIcon}</label><label for="method-wechat" title="${t.wechatLogin}" aria-label="${t.wechatLogin}">${wechatIcon}</label></div></div>`
  const accountStyles = '.account{max-width:640px;padding:36px 0 60px}.account h1{font-size:36px;letter-spacing:-1px}.account h2{font-size:22px;margin:0 0 20px}.account .card{margin:22px 0}.account label{display:block;margin:20px 0 8px;font-size:14px}.account input{display:block;width:100%;padding:12px;margin-top:8px;border:1px solid #ccd5cd;border-radius:8px;font:inherit;background:#fff;color:#202b27}.account button{padding:12px 18px;border:0;border-radius:8px;background:#274d3e;color:white;font:inherit;cursor:pointer}.account button:disabled{opacity:.45;cursor:not-allowed}.form-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}.notice{padding:14px;background:#e6eee4;border-radius:8px}.identity{display:flex;gap:16px;align-items:center}.avatar{height:64px;width:64px;border-radius:50%;object-fit:cover}.placeholder{display:grid;place-items:center;background:#e6eee4;font-size:24px}.account dd{margin:5px 0;overflow-wrap:anywhere}.account dt{font-size:13px;color:#69746d}.account input:focus-visible,.account button:focus-visible{outline:3px solid #72987d;outline-offset:3px}'
  const feedback = notice ? `<p class="notice" role="status">${t[notice]}</p>` : ''
  const body = user
    ? `<main class="wrap account"><a href="/workspace?lang=${locale}">← ${t.workspace}</a><h1>${title}</h1>${feedback}${content}</main>`
    : `<header class="login-titlebar"><span>webwjkj</span><a href="/login?lang=${locale === 'zh' ? 'en' : 'zh'}&method=${method}" lang="${locale === 'zh' ? 'en' : 'zh-CN'}">${t.language}</a></header><main class="login-page"><header class="login-heading"><div class="login-mark" aria-hidden="true">W</div><h1>${title}</h1><p>${t.loginSubtitle}</p></header>${feedback}${login}</main>`
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · webwjkj</title><style>${user ? styles + accountStyles : loginStyles}</style></head><body>${body}</body></html>\n`
}
