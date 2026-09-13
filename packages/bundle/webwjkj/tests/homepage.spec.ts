/** Real Loader and HTTP coverage for the independent homepage composition. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import * as Homepage from '../src/index.ts'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('serves both languages and removes its routes on disposal', async () => {
  const ctx = context = new Context()
  root = await mkdtemp(join(tmpdir(), 'webwjkj-'))
  const configPath = join(root, 'cordis.yml')
  // Loader persists disabled rows when their fibers dispose; each run owns its copy.
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configPath)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-webwjkj', Homepage],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected plugin: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  expect('default' in Homepage).toBe(false)
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber)).toEqual([])
  const url = `http://127.0.0.1:${ctx.webServer.port}`
  for (const [path, language] of [['/', 'zh-CN'], ['/en', 'en']] as const) {
    const response = await fetch(url + path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-language')).toBe(language)
    const html = await response.text()
    expect(html).toContain(`lang="${language}"`)
    expect(html).not.toContain('<script')
    await expect(html).toMatchFileSnapshot(`./expected/${language}.html`)
    const head = await fetch(url + path, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(html)))
    expect(await head.text()).toBe('')
  }
  const denied = await fetch(url, { method: 'POST' })
  expect(denied.status).toBe(405)
  expect(denied.headers.get('allow')).toBe('GET, HEAD')
  expect((await fetch(url + '/missing')).status).toBe(404)
  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'homepage')
  expect(entry?.fiber).toBeDefined()
  await entry!.fiber!.dispose()
  expect((await fetch(url)).status).toBe(404)
  expect((await fetch(url + '/en')).status).toBe(404)
})
