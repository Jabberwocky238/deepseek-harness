# AGENTS.md — Framework Source

This directory is the `@jabberwocky238/cordis` package: the Cordis framework and its foundation libraries, merged from nine upstream packages into one publishable source tree. See `README.md` for the manifest, the local-modification log, and the upstream sync procedure.

Layout under `src/`:

- `core/` — context, fiber lifecycle, events, registry, service, logger
- `cosmokit/` — shared utilities
- `schemastery/` — config schema and validation
- `loader/` — plugin tree built from configuration
- `plugins/` — include, group, timer, hmr, logger-console
- `index.ts` — aggregate exports and `start()`

**Do NOT edit `src/` casually.** Every divergence from upstream must be logged in `README.md` under "Local modifications". Imports between the merged areas are relative paths; upstream's cross-package specifiers no longer resolve.
