/** Validated deployment settings for webwjkj account authentication. */
import z from '@deepseek-ai/schemastery'

/** Tencent Cloud SMS template and credential references. */
export interface SmsConfig {
  /** Tencent SMS application ID. */
  sdkAppId: string
  /** Approved SMS signature. */
  signName: string
  /** Approved template containing one verification-code parameter. */
  templateId: string
  /** Tencent Cloud API region. */
  region: string
  /** Environment reference for the CAM SecretId. */
  secretIdEnv: string
  /** Environment reference for the CAM SecretKey. */
  secretKeyEnv: string
}

/** SMTP delivery settings for email binding. */
export interface MailConfig {
  /** SMTP hostname. */
  host: string
  /** SMTP port. */
  port: number
  /** Implicit TLS; false requires STARTTLS. */
  secure: boolean
  /** SMTP username. */
  user: string
  /** Environment reference for the SMTP password. */
  passwordEnv: string
  /** Verified sender mailbox. */
  from: string
}

/** WeChat Open Platform website application. */
export interface WechatConfig {
  /** Website application AppID. */
  appId: string
  /** Environment reference for its AppSecret. */
  secretEnv: string
}

/** Account runtime settings; omitted providers explicitly disable their action. */
export interface AuthConfig {
  /** Private directory containing the authentication database and signing key. */
  root: string
  /** Canonical browser origin; HTTPS except for loopback development. */
  publicOrigin: string
  /** Verification-code lifetime in seconds. */
  otpSeconds: number
  /** Failed verification attempts allowed for one code. */
  otpAttempts: number
  /** Minimum seconds between sends to one phone or mailbox. */
  resendSeconds: number
  /** Maximum sends per recipient per rolling 24-hour window. */
  dailySendLimit: number
  /** Login session lifetime in seconds. */
  sessionSeconds: number
  /** Maximum authentication requests per peer per minute. */
  requestsPerMinute: number
  /** Provider request timeout in milliseconds. */
  providerTimeoutMs: number
  /** Maximum accepted form body size in bytes. */
  maxBodyBytes: number
  /** Time allowed to acquire the cross-process authentication lock. */
  lockWaitMs: number
  /** Optional Tencent Cloud SMS provider. */
  sms?: SmsConfig | undefined
  /** Optional SMTP provider for verified email binding. */
  mail?: MailConfig | undefined
  /** Optional WeChat website OAuth provider. */
  wechat?: WechatConfig | undefined
}

/** Homepage plugin settings. */
export interface Config {
  /** When absent, serve only the public homepage. */
  auth?: AuthConfig | undefined
}

const required = () => z.string().min(1).required()
/** Loader validation for account settings and provider completeness. */
export const Config: z<Config> = z.object({
  auth: z.union([z.const(undefined), z.object({
    root: required(), publicOrigin: required(),
    otpSeconds: z.natural().min(30).default(300),
    otpAttempts: z.natural().min(1).max(10).default(3),
    resendSeconds: z.natural().min(1).default(60),
    dailySendLimit: z.natural().min(1).default(10),
    sessionSeconds: z.natural().min(60).default(604800),
    requestsPerMinute: z.natural().min(1).default(60),
    providerTimeoutMs: z.natural().min(100).default(10000),
    maxBodyBytes: z.natural().min(1024).default(16384),
    lockWaitMs: z.natural().min(100).default(15000),
    sms: z.union([z.const(undefined), z.object({
      sdkAppId: required(), signName: required(), templateId: required(), region: required(),
      secretIdEnv: required(), secretKeyEnv: required(),
    })]),
    mail: z.union([z.const(undefined), z.object({
      host: required(), port: z.natural().min(1).max(65535).required(), secure: z.boolean().required(),
      user: required(), passwordEnv: required(), from: required(),
    })]),
    wechat: z.union([z.const(undefined), z.object({ appId: required(), secretEnv: required() })]),
  })]),
})
