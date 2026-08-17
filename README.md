# @jabberwocky238/cordis

A plugin framework built on context, effects, and fiber lifecycle — [Cordis](https://github.com/cordiverse/cordis), merged from its nine upstream packages into one.

A plugin is a module exporting `apply(ctx)`. Everything it registers through `ctx` is released when the plugin unloads, so replacing or removing a plugin at runtime is safe.

## Install

```sh
npm install @jabberwocky238/cordis
```

## Use

Compose the application in `cordis.yml`:

```yaml
- id: logger
  name: '@jabberwocky238/cordis/logger-console'
- id: timer
  name: '@jabberwocky238/cordis/timer'
- id: hello
  name: './hello.ts'
```

Write a plugin:

```ts
import type { Context } from '@jabberwocky238/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const handle = setInterval(() => ctx.logger('hello').info('tick'), 1000)
    return () => clearInterval(handle)
  })
}
```

Start it from your own entry point:

```ts
import { start } from '@jabberwocky238/cordis'

await start({ config: './cordis.yml' })
```

`start()` creates a root context, mounts the loader, and mounts the config file as its plugin tree; it returns the context once the tree has settled. Pass `baseDir` to resolve config-relative paths against somewhere other than `process.cwd()`.

## What `ctx` gives a plugin

- `ctx.effect(setup)` — register a side effect and return its disposer. Unloading runs every collected disposer, so a plugin needs no teardown logic of its own.
- `ctx.on(event, listener)` — a listener owned by this plugin, removed on unload.
- `ctx.plugin(plugin, config)` — mount a child plugin; disposing the parent disposes it.
- `inject` — declare required services. A plugin whose injected service has no provider stays PENDING and does not run; it activates when the provider appears, and reloads when the provider is replaced.

Expose a capability to other plugins with a service:

```ts
import { Service, type Context } from '@jabberwocky238/cordis'

declare module '@jabberwocky238/cordis' {
  interface Context {
    greeter: Greeter
  }
}

export class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string) {
    return `hello ${who}`
  }
}

export default Greeter
```

The `declare module` block is declaration merging: it types `ctx.greeter` for every consumer. Registration itself happens in `super(ctx, 'greeter')`, as an effect.

## Built-in plugins

Each is a subpath export, named in a config file the same way an application names its own plugins.

| Import | Purpose |
| --- | --- |
| `@jabberwocky238/cordis/loader` | plugin tree built from configuration |
| `@jabberwocky238/cordis/include` | config-file includes and patch overlays |
| `@jabberwocky238/cordis/group` | nested plugin groups |
| `@jabberwocky238/cordis/timer` | timers released with their owner |
| `@jabberwocky238/cordis/hmr` | hot module replacement |
| `@jabberwocky238/cordis/logger-console` | console log exporter |

With `hmr` mounted, editing a plugin file reloads it in place: the old instance unloads, its effects run their disposers, and the new code mounts.

## Source

`src/` is vendored upstream source, merged and patched. [FRAMEWORK.md](FRAMEWORK.md) carries the manifest with upstream commits, the exhaustive local-modification log, and the sync procedure.

## License

MIT
