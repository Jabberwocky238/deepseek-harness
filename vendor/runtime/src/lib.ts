import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'

export * from '@deepseek-ai/cordis'
export { default as Schema } from '@deepseek-ai/schemastery'
export { default as Loader } from '@deepseek-ai/cordis-plugin-loader'

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
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    config: { path: config },
  })
  return ctx
}
