# AGENTS.md

This repository is the `@jabberwocky238/cordis` package: the Cordis framework and its foundation libraries, merged from nine upstream packages into one publishable source tree.

Layout under `src/`:

- `core/` — context, fiber lifecycle, events, registry, service, logger
- `cosmokit/` — shared utilities
- `schemastery/` — config schema and validation
- `loader/` — plugin tree built from configuration
- `plugins/` — include, group, timer, hmr, logger-console
- `index.ts` — aggregate exports and `start()`

**Do NOT edit `src/` casually.** Every divergence from upstream must be logged in [FRAMEWORK.md](FRAMEWORK.md) under "Local modifications". Imports between the merged areas are relative paths; upstream's cross-package specifiers no longer resolve.

Adding a built-in plugin means adding its subpath to `exports` in `package.json` and its row to the table in `README.md`; a config file can only name what `exports` publishes.

## Commands

```sh
pnpm install
pnpm run build      # tsc: lib/ runtime, lib/types/ declarations
pnpm run typecheck
pnpm pack           # the tarball CI boots as a real consumer
```

Publishing is tag-driven: push `v<version>` matching `package.json`, and the publish workflow builds and publishes with npm provenance.
