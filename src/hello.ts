import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const handle = setInterval(() => ctx.logger('hello').info('tick'), 1000)
    return () => clearInterval(handle)
  })
}
