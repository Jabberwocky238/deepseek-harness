# Cordis Template

A minimal [Cordis](https://github.com/cordiverse/cordis) application: the framework core plus the loader stack, with every plugin removed.

Cordis is a plugin framework built around context, effects, and fiber lifecycle. A plugin is a module exporting `apply(ctx)`; everything it registers through `ctx` is released when the plugin unloads.

## Layout

```
vendor/           pinned framework source
  cordis/           context, fiber, events, registry, service, logger
  cosmokit/         shared utilities
  schemastery/      config schema and validation
  loader/           plugin tree from configuration
  include/          config-file includes and patch overlays
  group/            nested plugin groups
  timer/            disposal-aware timers
  hmr/              hot module replacement
  logger-console/   console exporter
src/hello.ts      example plugin
cordis.yml        application composition
```

## Usage

```sh
pnpm install
pnpm start
```

Expected output — the example plugin logs once per second, and HMR watches `src/`:

```
2026-08-17 12:46:12 [I] hmr watching [ './src' ]
2026-08-17 12:46:13 [I] hello tick
```

Edit `src/hello.ts` while it runs; the plugin reloads in place. The tick stays at one per second because unloading the old instance ran the effect's cleanup.

`pnpm build` typechecks and emits declarations for the vendored sources.

## Writing a plugin

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['timer']

export function apply(ctx: Context) {
  ctx.effect(() => {
    const handle = setInterval(() => ctx.logger('my-plugin').info('working'), 1000)
    return () => clearInterval(handle)
  })
}
```

Register it in `cordis.yml`:

```yaml
- id: my-plugin
  name: './src/my-plugin.ts'
```

`inject` names the services that must exist before `apply` runs. A plugin whose injected service has no provider stays PENDING and logs nothing — that is a legitimate state, not an error.

Every registration goes through `ctx.effect()` or `ctx.on()` and returns a disposer, so unloading a plugin undoes everything it contributed.

## Package naming

The vendored packages are rescoped to `@deepseek-ai/*` (`cordis` → `@deepseek-ai/cordis`, `@cordisjs/plugin-<x>` → `@deepseek-ai/cordis-plugin-<x>`). Upstream directory names and version numbers are unchanged. Packages published under the upstream `@cordisjs` scope are not interchangeable with these.

## License

MIT
