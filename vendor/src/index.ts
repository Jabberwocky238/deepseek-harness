import { Context } from './core/index.ts'
import { pathToFileURL } from 'node:url'
import Loader from './loader/index.ts'
import Include from './plugins/include.ts'

export * from './core/index.ts'
export * from './cosmokit/index.ts'
export { default as Schema } from './schemastery/index.ts'
export { default as Loader } from './loader/index.ts'
export { default as Include } from './plugins/include.ts'
export { default as Group } from './plugins/group.ts'
export { default as Timer } from './plugins/timer.ts'
export { default as HMR } from './plugins/hmr/index.ts'
export { default as LoggerConsole } from './plugins/logger-console/index.ts'

/** Options for {@link start}. */
export interface StartOptions {
  /** Config file mounted as the application root. Defaults to `./cordis.yml`. */
  config?: string
  /** Directory relative paths in the config resolve against. Defaults to `process.cwd()`. */
  baseDir?: string
}

/**
 * Create a root context and mount a config file as its plugin tree.
 *
 * @param options — config path and resolution base.
 * @returns the root context, with the tree mounted and settled.
 */
export async function start(options: StartOptions = {}): Promise<Context> {
  const { config = './cordis.yml', baseDir = process.cwd() } = options
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(baseDir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Include, { path: config })
  return ctx
}
