/** Standalone webwjkj homepage routes over the shared HTTP carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { renderHomepage } from './homepage.ts'
import type { Locale } from './locales.ts'
import { Config } from './auth-config.ts'
import { createAccountRuntime } from './auth-runtime.ts'
import { handleAccount } from './account-routes.ts'

export { Config } from './auth-config.ts'

/** Cordis plugin name. */
export const name = 'webwjkj'
/** The homepage only requires the HTTP carrier. */
export const inject = ['webServer']

/**
 * Register the Chinese and English homepage routes with effect-owned disposal.
 * @param ctx - context providing the listening HTTP server.
 * @param config - optional account services and deployment settings.
 * @returns resolution after all configured routes activate.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const pages: [string, Locale][] = [['/', 'zh'], ['/en', 'en']]
  for (const [path, locale] of pages) {
    const html = renderHomepage(locale, config.auth !== undefined)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path,
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Language': locale === 'zh' ? 'zh-CN' : 'en',
          'Content-Length': Buffer.byteLength(html),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      },
    }))
  }
  if (config.auth) {
    const runtime = await createAccountRuntime(config.auth)
    const pending = new Set<Promise<void>>()
    try {
      ctx.effect(() => {
        const disposers: (() => void)[] = []
        let accepting = true
        try {
          for (const [path, kind] of [['/account', 'prefix'], ['/login', 'exact'], ['/workspace', 'prefix'], ['/api/auth/callback/wechat', 'exact']] as const) {
            disposers.push(ctx.webServer.register({ kind, path, handler(req, res) {
              if (!accepting) { res.writeHead(503); res.end(); return }
              const work = handleAccount(runtime, req, res)
              pending.add(work)
              void work.then(() => pending.delete(work), () => pending.delete(work))
              return work
            } }))
          }
        } catch (error) { for (const dispose of disposers) dispose(); throw error }
        return async () => {
          accepting = false
          for (const dispose of disposers) dispose()
          await Promise.allSettled([...pending])
          await runtime.close()
        }
      })
    } catch (error) { await runtime.close(); throw error }
  }
}
