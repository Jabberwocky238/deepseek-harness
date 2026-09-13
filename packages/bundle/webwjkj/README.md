---
description: "Install and run the independent webwjkj homepage application with Chinese and English pages."
kind: "package-bundle"
---

# @deepseek-ai/dsh-webwjkj

English | [中文](README.zh.md)

## Summary

webwjkj provides an independent responsive homepage with introduction cards, an about section, and Chinese/English navigation. It mounts only the HTTP carrier and its own page plugin, requiring no model key. This local development module uses a dedicated profile without depending on the official Web application.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

After building the repository, prepare this independent profile manifest at `$DSH_HOME/profiles/webwjkj/package.json` (the default home is `~/.dsh`), then install the local module from the repository root.

```json
{
  "name": "dsh-profile-webwjkj",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [], "patchReload": "live" } }
}
```

```sh
pnpm dsh plugin --profile webwjkj add link:./packages/bundle/webwjkj
pnpm dsh --profile webwjkj
```

Open `http://127.0.0.1:3081/` for Chinese or `/en` for English. Installation adds the module to the profile bundle list. Do not overwrite an existing manifest; the dedicated profile should list only `@deepseek-ai/dsh-webwjkj` as its bundle.

Override the `webwjkj-server` row in the profile’s `cordis.patch.yml` to change the listening address and port; replacement config must include both host and port. A port conflict fails startup.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) mounts two plugins. The [entry](src/index.ts) registers exact routes through effects; the [page](src/homepage.ts) renders HTML from [typed copy](src/locales.ts) and [styles](src/styles.ts). Pages need no scripts, external fonts, or asset requests.

GET and HEAD serve the homepage, other methods return 405, and unknown paths return 404. Unloading removes both routes. No invariant companion is published: the HTTP registry owns the routes and there is no independently maintained state to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [HTTP server](../../host/webserver/README.md)
- [Application launch](../../../docs/architecture.md#application-launch)
- [webwjkj decision](../../../.agents/notes/implemented/architecture/2026-09-13-webwjkj-homepage.md)

-----

<a id="model-experience"></a>
## Model Experience

### Homepage

#### What the model sees

None; this application mounts no agent, model, tool, or Session service.

#### Token effect

None; no model context is added.

#### KV Cache effect

None; there are no model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The first version serves a public static homepage only, with no chat, authentication, business APIs, or data storage. Private data requires access control before exposure. This module is not published to npm; source changes require rebuilding and restarting the application.

<a id="dev-note"></a>
### Dev Note

None.
