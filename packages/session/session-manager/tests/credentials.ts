import type { Context } from '@deepseek-ai/cordis'

/**
 * Provide a `credentials` service that answers every reference with one value.
 * @param ctx - the context to provide it on.
 * @param value - the secret every reference resolves to; `undefined` resolves nothing.
 */
export function provideCredentials(ctx: Context, value?: string): void {
  // The backend calls only `resolve`; the rest of the service is not exercised.
  ctx.provide('credentials', {
    resolve: async () => value === undefined ? undefined : { value, source: 'test' },
  } as never)
}
