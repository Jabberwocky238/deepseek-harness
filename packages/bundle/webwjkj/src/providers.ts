/** Tencent SMS, SMTP, and WeChat website authorization adapters. */
import { sms } from 'tencentcloud-sdk-nodejs-sms'
import nodemailer from 'nodemailer'
import { genericOAuth } from 'better-auth/plugins'
import { z } from 'zod'
import type { AuthConfig, WechatConfig } from './auth-config.ts'

/**
 * Resolve a configured credential without exposing its contents in errors.
 * @param name - environment-variable reference.
 * @returns non-empty credential value.
 */
export function credential(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`webwjkj: missing credential environment variable ${name}`)
  return value
}

/**
 * Create provider send functions; unconfigured providers fail explicitly.
 * @param config - validated deployment settings.
 * @returns provider functions whose completion means the delivery service accepted the message.
 */
export function createDelivery(config: AuthConfig) {
  const client = config.sms && new sms.v20210111.Client({
    credential: { secretId: credential(config.sms.secretIdEnv), secretKey: credential(config.sms.secretKeyEnv) },
    region: config.sms.region,
    profile: { httpProfile: { reqTimeout: Math.ceil(config.providerTimeoutMs / 1000) } },
  })
  const mailer = config.mail && nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    requireTLS: !config.mail.secure,
    auth: { user: config.mail.user, pass: credential(config.mail.passwordEnv) },
    connectionTimeout: config.providerTimeoutMs, greetingTimeout: config.providerTimeoutMs,
    socketTimeout: config.providerTimeoutMs,
  })
  return {
    async sms(phoneNumber: string, code: string) {
      if (!client || !config.sms) throw new Error('SMS_UNAVAILABLE')
      const result = await client.SendSms({
        SmsSdkAppId: config.sms.sdkAppId, SignName: config.sms.signName,
        TemplateId: config.sms.templateId, TemplateParamSet: [code], PhoneNumberSet: [phoneNumber],
      })
      if (result.SendStatusSet?.length !== 1 || result.SendStatusSet[0]?.Code !== 'Ok') throw new Error('SMS_DELIVERY_FAILED')
    },
    async email(email: string, code: string) {
      if (!mailer || !config.mail) throw new Error('EMAIL_UNAVAILABLE')
      const result = await mailer.sendMail({
        from: config.mail.from, to: email,
        subject: 'webwjkj 验证码 / Verification code',
        text: `webwjkj 验证码 / Verification code: ${code}\n有效期 / Expires in: ${config.otpSeconds} seconds.`,
      })
      if (result.accepted.length !== 1 || result.rejected.length !== 0) throw new Error('EMAIL_DELIVERY_FAILED')
    },
    close() { mailer?.close() },
  }
}

/**
 * Configure WeChat's GET token exchange and profile API for explicit account linking.
 * @param config - website application credentials.
 * @param timeoutMs - bound on each provider request.
 * @returns Better Auth OAuth plugin with signup disabled.
 */
export function wechatProvider(config: WechatConfig, timeoutMs: number) {
  const secret = credential(config.secretEnv)
  const tokenSchema = z.object({ access_token: z.string().min(1), openid: z.string().min(1), expires_in: z.number().positive() })
  const profileSchema = z.object({ openid: z.string().min(1), nickname: z.string(), headimgurl: z.string().optional() })
  async function get(path: string, params: Record<string, string>) {
    const url = new URL(path, 'https://api.weixin.qq.com')
    url.search = new URLSearchParams(params).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!response.ok) throw new Error('WECHAT_PROVIDER_FAILED')
    return response.json() as Promise<unknown>
  }
  return genericOAuth({ config: [{
    providerId: 'wechat', clientId: config.appId,
    authorizationUrl: 'https://open.weixin.qq.com/connect/qrconnect#wechat_redirect',
    authorizationUrlParams: { appid: config.appId }, scopes: ['snsapi_login'],
    pkce: false, disableSignUp: true,
    async getToken({ code }) {
      const token = tokenSchema.parse(await get('/sns/oauth2/access_token', {
        appid: config.appId, secret, code, grant_type: 'authorization_code',
      }))
      return { accessToken: token.access_token, accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000), scopes: ['snsapi_login'], raw: token }
    },
    async getUserInfo(tokens) {
      const token = tokenSchema.parse(tokens.raw)
      const profile = profileSchema.parse(await get('/sns/userinfo', {
        access_token: token.access_token, openid: token.openid, lang: 'zh_CN',
      }))
      if (profile.openid !== token.openid) throw new Error('WECHAT_IDENTITY_MISMATCH')
      return { id: profile.openid, name: profile.nickname, image: profile.headimgurl, emailVerified: false }
    },
  }] })
}
