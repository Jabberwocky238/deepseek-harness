/** Better Auth lifecycle and the dedicated, versioned account database. */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { phoneNumber, emailOTP, username } from 'better-auth/plugins'
import { getMigrations } from 'better-auth/db/migration'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { acceptedFriends, friendInput, friendOperation, type FriendProfile } from './friends.ts'
import { createDelivery, wechatProvider } from './providers.ts'
import type { AuthConfig } from './auth-config.ts'
import type { AccountUser, UserId } from './account-types.ts'

/** Physical schema version; successors must increase it and preserve existing users. */
export const AUTH_SCHEMA_VERSION = 3

/** Username accepted from the account form. */
export const usernameSchema = z.string().trim().min(1).max(40)
/** Avatar references are HTTPS URLs, with no credentials or script schemes. */
export const avatarSchema = z.union([z.literal(''), z.url().max(2048).refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
})])

/** Internal account runtime; all operations use the shared cross-process lock. */
export interface AccountRuntime {
  /** Validated deployment settings. */
  config: AuthConfig
  /** Execute one request against Better Auth, without publishing its other endpoints. */
  handle(request: Request): Promise<Response>
  /** Set the first password for a recently authenticated account. */
  setPassword(headers: Headers, newPassword: string): Promise<Response>
  /** Read a safe user view for a browser cookie. */
  user(headers: Headers): Promise<AccountUser | null>
  /**
   * Search public profiles or manage the authenticated account's friend applications.
   * @param owner - authenticated UUID.
   * @param input - parsed operation fields.
   * @returns public result without contact details or credentials.
   */
  friends(owner: UserId, input: z.infer<typeof friendInput>): Promise<unknown>
  /**
   * Read accepted contacts for IM projection.
   * @param owner - authenticated UUID.
   * @returns public peer profiles.
   */
  acceptedFriends(owner: UserId): Promise<FriendProfile[]>
  /** Unregister callers before closing; drains all acquired operations. */
  close(): Promise<void>
}

/**
 * Open private authentication storage and configure verified login and linking.
 * @param config - validated deployment settings.
 * @returns runtime whose close drains requests before closing providers and SQLite.
 */
export async function createAccountRuntime(config: AuthConfig): Promise<AccountRuntime> {
  const origin = new URL(config.publicOrigin)
  if (origin.origin !== config.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('webwjkj: publicOrigin must be an HTTPS origin or a loopback HTTP origin')
  }
  if (config.localTestAccount && (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('webwjkj: local test account is forbidden in production or with a public origin')
  }
  const root = config.localTestAccount ? resolve(config.root, 'local-test') : resolve(config.root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const filename = join(root, 'accounts.sqlite')
  const lock = <T>(operation: () => Promise<T>) => withFileLock(filename, operation, { waitMs: config.lockWaitMs })
  return lock(async () => {
    const secretPath = join(root, 'auth-secret')
    try { await writeFile(secretPath, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }) } catch (error) {
      // Exclusive creation can lose to another initializer; its existing key remains authoritative.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const secret = await readFile(secretPath, 'utf8')
    if (secret.length < 32) throw new Error('webwjkj: auth-secret must contain at least 32 characters')
    const file = await open(filename, 'a', 0o600)
    await file.close()
    const delivery = createDelivery(config)
    const db = new DatabaseSync(filename)
    try {
      const version = db.prepare('PRAGMA user_version').get()?.['user_version']
      if (version !== 0 && version !== 1 && version !== 2 && version !== AUTH_SCHEMA_VERSION) throw new Error('webwjkj: unsupported authentication schema version')
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
      function reserveSend(recipient: string) {
        db.prepare('DELETE FROM wjkj_send_limits WHERE windowStart < ?').run(Date.now() - 86400000)
        const key = createHmac('sha256', secret).update(recipient).digest('hex')
        const now = Date.now()
        const row = db.prepare('SELECT lastSent, windowStart, count FROM wjkj_send_limits WHERE key = ?').get(key)
        const fresh = !row || now - Number(row['windowStart']) >= 86400000
        if (row && (now - Number(row['lastSent']) < config.resendSeconds * 1000 || (!fresh && Number(row['count']) >= config.dailySendLimit))) {
          throw new APIError('TOO_MANY_REQUESTS', { code: 'SEND_LIMIT', message: 'Verification delivery limit reached' })
        }
        db.prepare('INSERT INTO wjkj_send_limits VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET lastSent=excluded.lastSent, windowStart=excluded.windowStart, count=excluded.count')
          .run(key, now, fresh ? now : Number(row['windowStart']), fresh ? 1 : Number(row['count']) + 1)
      }
      const auth = betterAuth({
        appName: 'webwjkj', baseURL: config.publicOrigin, basePath: '/api/auth', secret, database: db,
        trustedOrigins: [config.publicOrigin],
        emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
        advanced: { cookiePrefix: 'webwjkj', database: { generateId: () => randomUUID() }, ipAddress: { ipAddressHeaders: ['x-webwjkj-peer-ip'] } },
        session: { expiresIn: config.sessionSeconds, cookieCache: { enabled: false } },
        rateLimit: { enabled: true, storage: 'database', window: 60, max: config.requestsPerMinute },
        account: { encryptOAuthTokens: true, accountLinking: { enabled: true, trustedProviders: ['wechat'], allowDifferentEmails: true, disableImplicitLinking: true } },
        databaseHooks: {
          user: { update: { before: (user) => {
            if (user.name !== undefined) usernameSchema.parse(user.name)
            if (user.image != null) avatarSchema.parse(user.image)
            return Promise.resolve({ data: user })
          } } },

        },
        plugins: [
          username({ displayUsername: false }),
          phoneNumber({
            expiresIn: config.otpSeconds, allowedAttempts: config.otpAttempts,
            phoneNumberValidator: value => /^\+86[1][3-9]\d{9}$/.test(value),
            signUpOnVerification: { getTempEmail: phone => `${createHmac('sha256', secret).update(phone).digest('hex')}@phone.webwjkj.invalid`, getTempName: () => 'webwjkj' },
            async sendOTP({ phoneNumber: phone, code }) { reserveSend(`sms:${phone}`); await delivery.sms(phone, code) },
          }),
          emailOTP({
            expiresIn: config.otpSeconds, allowedAttempts: config.otpAttempts, storeOTP: 'hashed', disableSignUp: false,
            changeEmail: { enabled: true },
            async sendVerificationOTP({ email, otp }) { reserveSend(`email:${email.toLowerCase()}`); await delivery.email(email, otp) },
          }),
          ...config.wechat ? [wechatProvider(config.wechat, config.providerTimeoutMs)] : [],
        ],
        logger: { disabled: true },
      })
      if (version === 1) {
        db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE user ADD COLUMN username TEXT;
          CREATE UNIQUE INDEX user_username_unique ON user(username);
          PRAGMA user_version = 2;
          COMMIT;`)
      }
      const migration = await getMigrations(auth.options)
      if (version === 0) {
        await migration.runMigrations()
        db.exec(`CREATE TABLE IF NOT EXISTS wjkj_send_limits (key TEXT PRIMARY KEY, lastSent INTEGER NOT NULL, windowStart INTEGER NOT NULL, count INTEGER NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS wjkj_one_wechat_per_user ON account(userId) WHERE providerId = 'wechat';
          CREATE UNIQUE INDEX IF NOT EXISTS wjkj_wechat_owner ON account(providerId, accountId) WHERE providerId = 'wechat';
          PRAGMA user_version = 2;`)
      } else if (migration.toBeCreated.length || migration.toBeAdded.length) {
        throw new Error('webwjkj: authentication schema does not match this build')
      }
      if (version !== AUTH_SCHEMA_VERSION) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS wjkj_friend_requests (id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES user(id), recipient TEXT NOT NULL REFERENCES user(id), greeting TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')), updatedAt INTEGER NOT NULL, CHECK(sender<>recipient));
          CREATE UNIQUE INDEX IF NOT EXISTS wjkj_friend_pair ON wjkj_friend_requests(min(sender,recipient),max(sender,recipient));
          PRAGMA user_version = ${AUTH_SCHEMA_VERSION};
          COMMIT;`)
      }
      const authContext = await auth.$context
      if (config.localTestAccount && !db.prepare('SELECT id FROM user WHERE username = ?').get('admin')) {
        const userId = randomUUID()
        const now = Date.now()
        const password = await authContext.password.hash('123123')
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,username) VALUES (?,?,?,?,?,?,?)')
            .run(userId, 'admin', 'admin@local.webwjkj.invalid', 0, now, now, 'admin')
          db.prepare('INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
            .run(randomUUID(), userId, 'credential', userId, password, now, now)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
      let closed = false
      const pending = new Set<Promise<unknown>>()
      function run<T>(operation: () => Promise<T>): Promise<T> {
        if (closed) return Promise.reject(new Error('webwjkj authentication is closed'))
        const work = lock(operation)
        pending.add(work)
        void work.then(() => pending.delete(work), () => pending.delete(work))
        return work
      }
      return {
        config,
        acceptedFriends: owner => run(() => Promise.resolve(acceptedFriends(db, owner))),
        friends: (owner, input) => run(() => {
          const parsed = friendInput.parse(input)
          if (parsed.action !== 'list') {
            const key = createHmac('sha256', secret).update(`friends:${owner}`).digest('hex')
            const now = Date.now()
            const row = db.prepare('SELECT windowStart,count FROM wjkj_send_limits WHERE key=?').get(key)
            const fresh = !row || now - Number(row['windowStart']) >= 60000
            if (!fresh && Number(row['count']) >= config.requestsPerMinute) throw new Error('Friend request rate exceeded')
            db.prepare('INSERT INTO wjkj_send_limits VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET lastSent=excluded.lastSent,windowStart=excluded.windowStart,count=excluded.count').run(key, now, fresh ? now : Number(row['windowStart']), fresh ? 1 : Number(row['count']) + 1)
          }
          return Promise.resolve(friendOperation(db, owner, parsed))
        }),
        handle: request => run(() => auth.handler(request)),
        setPassword: (headers, newPassword) => run(() => auth.api.setPassword({ headers, body: { newPassword }, asResponse: true })),
        user: headers => run(async () => {
          const session = await auth.api.getSession({ headers })
          if (!session) return null
          const user = session.user
          const id = brandString<UserId>(z.uuid().parse(user.id))
          const accounts = await auth.api.listUserAccounts({ headers })
          return { id, name: user.name, loginName: user.username ?? null, hasPassword: accounts.some(account => account.providerId === 'credential'), phone: user.phoneNumber ?? '', email: user.emailVerified ? user.email : null, image: user.image ?? null, wechat: accounts.some(account => account.providerId === 'wechat') }
        }),
        async close() { closed = true; await Promise.allSettled([...pending]); delivery.close(); db.close() },
      }
    } catch (error) { delivery.close(); db.close(); throw error }
  })
}
