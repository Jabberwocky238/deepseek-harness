import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SshBashExecutor from '../src/index.ts'
import { sshServer } from './ssh-server.ts'

let server: Awaited<ReturnType<typeof sshServer>> | undefined
let ctx: Context | undefined
afterEach(async () => {
  await server?.close()
  await ctx?.fiber.dispose()
  server = undefined
  ctx = undefined
})

describe.skipIf(process.platform === 'win32')('SSH backend through the Bash Loader composition', () => {
  it('keeps the bash name, arguments, and model result renderer', async () => {
    server = await sshServer()
    const configPath = join(server.root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-shell-env'",
      "- name: '@deepseek-ai/dsh-bash-ssh'",
      `  config: ${JSON.stringify(server.config)}`,
      "- name: '@deepseek-ai/dsh-tool-bash'",
      '',
    ].join('\n'))
    ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-shell-env', ShellEnv], ['@deepseek-ai/dsh-bash-ssh', SshBashExecutor],
      ['@deepseek-ai/dsh-tool-bash', BashTool],
    ])
    ctx.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected plugin: ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['bash'])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('ssh-loader'), name: 'bash',
      arguments: { command: 'printf BASH_OK; exit 7', description: 'Check remote Bash execution' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'BASH_OK\n[exit code: 7]' }])
  })
})
