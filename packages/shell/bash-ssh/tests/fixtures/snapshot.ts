/** Loopback SSH composition for the shipped headless profile's recorded Bash turn. @module */
import type { Context } from '@deepseek-ai/cordis'
import SshBashExecutor from '../../src/index.ts'
import { sshServer } from '../ssh-server.ts'

/** Own the fixture SSH host before publishing its shell provider. @param ctx - fixture composition context. */
export async function apply(ctx: Context): Promise<void> {
  const server = await sshServer()
  ctx.effect(() => () => server.close(), 'snapshot SSH server')
  await ctx.plugin(SshBashExecutor, { ...server.config, localWorkspaceRoot: process.cwd() })
}
