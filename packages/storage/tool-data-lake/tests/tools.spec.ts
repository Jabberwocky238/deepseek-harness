import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DataLake, { LakeId } from '@deepseek-ai/dsh-data-lake'
import * as plugin from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(config: Partial<plugin.Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lake-tool-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DataLake, { lakes: [{ id: 'docs', root, maxEntries: 100 }] })
  const fiber = await ctx.plugin(plugin, { maxPageEntries: 2, maxOutputBytes: 10000, maxSummaryBytes: 100, ...config })
  const call = (args: unknown) => ctx.tools.execute({
    name: 'data_lake', arguments: args, callId: ToolCallId('lake-call'), signal: new AbortController().signal,
  })
  return { ctx, root, call, fiber }
}

it('navigates catalogs with pagination and persists the agent summary', async () => {
  const { ctx, root, call, fiber } = await fixture()
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, name), name)
  expect(await call({ action: 'list' })).toMatchObject({ isError: false, value: '{"items":[{"lakeId":"docs","kind":"disk"}],"total":1,"nextOffset":null}' })
  expect((await call({ action: 'scan', lakeId: 'docs' })).isError).toBe(false)
  const index = await call({ action: 'index', lakeId: 'docs', offset: 2 })
  expect(index.isError).toBe(false)
  if (index.isError) throw new Error('index failed')
  expect(index.value).toContain('"path":"c"')
  expect(index.value).not.toContain('"path":"a"')
  const map = await call({ action: 'map', lakeId: 'docs' })
  expect(map.isError).toBe(false)
  const directory = (await ctx.dataLake.directory(LakeId('docs'), ''))!
  expect((await call({ action: 'summarize', lakeId: 'docs', revision: directory.map.revision, summary: 'Three newly added files.' })).isError).toBe(false)
  const location = (await ctx.dataLake.catalog(LakeId('docs')))!.maps[0]!
  expect(await readFile(join(root, location.summaryPath), 'utf8')).toContain('Three newly added files.')
  await fiber.dispose()
  expect(ctx.tools.schemas().some(tool => tool.name === 'data_lake')).toBe(false)
})

it('rejects invalid calls, stale summaries, and oversized multibyte summaries at execution', async () => {
  const { call } = await fixture({ maxSummaryBytes: 3 })
  for (const args of [
    { action: 'map' }, { action: 'map', lakeId: 'docs' }, { action: 'index', lakeId: 'docs' },
    { action: 'list', limit: 3 }, { action: 'list', offset: -1 },
    { action: 'summarize', lakeId: 'docs' },
    { action: 'summarize', lakeId: 'docs', revision: 'old', summary: '好好' },
    { action: 'summarize', lakeId: 'docs', revision: 'old', summary: 'ok' },
  ]) expect((await call(args)).isError).toBe(true)
})

it('bounds the complete rendered result', async () => {
  const { call } = await fixture({ maxOutputBytes: 1 })
  const result = await call({ action: 'list' })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('output byte limit'))).toBe(true)
})
