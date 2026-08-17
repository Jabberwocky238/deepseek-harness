# Cordis Template

A minimal [Cordis](https://github.com/cordiverse/cordis) application: the framework core plus the loader stack, with every plugin removed.

Cordis is a plugin framework built around context, effects, and fiber lifecycle. A plugin is a module exporting `apply(ctx)`; everything it registers through `ctx` is released when the plugin unloads.

## Layout

```
vendor/           the @jabberwocky238/cordis package source
  src/core/         context, fiber, events, registry, service, logger
  src/cosmokit/     shared utilities
  src/schemastery/  config schema and validation
  src/loader/       plugin tree from configuration
  src/plugins/      include, group, timer, hmr, logger-console
  src/index.ts      aggregate exports and start()
src/main.ts       application entry
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

## Starting from your own code

The entry point is a library, not a bin. `src/main.ts` is two lines:

```ts
import { start } from '@jabberwocky238/cordis'

await start({ config: './cordis.yml' })
```

`start()` creates a root context, mounts the loader, and mounts the config file as its plugin tree; it returns the context once the tree has settled. Pass `baseDir` to resolve config-relative paths against somewhere other than `process.cwd()`. The same module re-exports the framework surface (`Context`, `Service`, `Schema`, `FiberState`, …), so a host application needs one import.

## Writing a plugin

```ts
import type { Context } from '@jabberwocky238/cordis'

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

## Publishing

The framework publishes as one package, `@jabberwocky238/cordis`. Tagging `v<version>` runs the publish workflow, which verifies the tag matches `vendor/package.json` and publishes with npm provenance. Set the `NPM_TOKEN` repository secret first.

Built-in plugins are subpath exports (`@jabberwocky238/cordis/timer`, `/hmr`, `/group`, `/include`, `/logger-console`), so a config file names them the same way an application names its own.

## License

MIT
