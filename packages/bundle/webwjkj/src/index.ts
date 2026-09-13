/** Standalone webwjkj homepage routes over the shared HTTP carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { renderHomepage } from './homepage.ts'
import type { Locale } from './locales.ts'

/** Cordis plugin name. */
export const name = 'webwjkj'
/** The homepage only requires the HTTP carrier. */
export const inject = ['webServer']

/**
 * Register the Chinese and English homepage routes with effect-owned disposal.
 * @param ctx - context providing the listening HTTP server.
 */
export function apply(ctx: Context): void {
  const pages: [string, Locale][] = [['/', 'zh'], ['/en', 'en']]
  for (const [path, locale] of pages) {
    const html = renderHomepage(locale)
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
}
