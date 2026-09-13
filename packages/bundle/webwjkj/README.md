---
description: "Install and run the independent webwjkj homepage application with Chinese and English pages."
kind: "package-bundle"
---

# @deepseek-ai/dsh-webwjkj

English | [中文](README.zh.md)

## Summary

webwjkj is an independent web application with a public homepage, SMS, password, email, and WeChat login, UUID profiles, email and WeChat binding, and an authenticated multi-panel workbench. It uses a dedicated profile without the official Web application or model credentials.

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

Run `pnpm run build:webwjkj-workbench` before starting this profile. It compiles the directly maintained [UI source](../../../vendor/webwjkj/README.md) into this package’s `lib/workbench` directory. The build admits only browser UI primitives and rejects workbench, editor-engine, extension-host, server, and external runtime dependencies. `workbenchRoot: bundled` selects this output; an explicit path selects another build subject to the same asset validation.

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

The `/login` page switches between SMS and password forms through text tabs, with email and WeChat icons below for the other methods. Only the selected form is visible. Each successful login opens `/workspace`. First phone, email, or WeChat verification creates a UUID user; configure a 3–30 character login username and 12–128 character password in `/account` to enable password login. Changing an existing password requires the current password. Phone, email, and WeChat identities can be verified and bound in account settings; linked identities sign in to the same UUID. Unlinked identities are not automatically merged.

The activity bar places Profile directly above Settings at the bottom left. Profile opens a native dialog with account details and editing; signing out returns to login. Selecting a contact or group opens a conversation tab with text history and a message composer. Every account has a `default agent` contact. IM messages and groups persist through the shared storage service in `$DSH_HOME/webwjkj/im`.

The application uses the cloned VS Code grid, splitter, action-bar, icon, and dialog UI sources. webwjkj owns tabs, contact lists, message panels, and settings. The Contacts activity opens the combined contact/group list, most recent communication first. Lower and right work areas start closed and open empty; tabs can be dragged between them. There is no status bar, VS Code Chat, terminal, command palette, file explorer, extension installation, remote execution, or extension host.

The sidebar provides Add Friend, Create Group, Notifications, and Refresh buttons. Exact UUID, verified phone, or verified email search opens a public profile in the upper work area without exposing contact details. Friend applications carry a greeting; only the recipient may accept or reject them. Applications persist in account SQLite schema 3, and accepted relationships project idempotently into mutual IM contacts. Group creation accepts only the caller’s current contacts. Settings offers light, dark, and system themes, with system following enabled by default and the manual choice stored per user UUID.

For local testing, explicitly configure the personal profile’s `cordis.patch.yml` as below and sign in with `admin / 123123`. The shipped bundle does not enable this fixture. It requires a loopback listener and origin, and rejects `NODE_ENV=production`. Test storage lives in `$DSH_HOME/webwjkj/local-test`; ordinary mode uses the original directory without loading this account. Restarting preserves changed passwords; disabling the flag returns to ordinary storage.

```yaml
- id: webwjkj-home
  config:
    workbenchRoot: bundled
    auth:
      root: !!js dshHomePath('webwjkj')
      publicOrigin: http://127.0.0.1:3081
      localTestAccount: true
- id: webwjkj-storage-json
  config:
    root: !!js dshHomePath('webwjkj', 'local-test', 'im')
```

Configure these variables in the launch environment; keep credentials in local environment settings or a secret manager. Unconfigured services display as unavailable; incomplete configuration fails loading. Use HTTPS in production and set `WEBWJKJ_PUBLIC_ORIGIN` to the public origin.

```sh
WEBWJKJ_PUBLIC_ORIGIN=https://web.example.com
WEBWJKJ_SMS_APP_ID=your-sdk-app-id
WEBWJKJ_SMS_SIGN=your-approved-sign
WEBWJKJ_SMS_TEMPLATE_ID=your-approved-template-id
WEBWJKJ_SMS_REGION=ap-guangzhou
TENCENTCLOUD_SECRET_ID=your-secret-id
TENCENTCLOUD_SECRET_KEY=your-secret-key
WEBWJKJ_SMTP_HOST=smtp.example.com
WEBWJKJ_SMTP_PORT=465
WEBWJKJ_SMTP_SECURE=true
WEBWJKJ_SMTP_USER=your-smtp-user
WEBWJKJ_SMTP_PASSWORD=your-smtp-password
WEBWJKJ_SMTP_FROM=no-reply@example.com
WEBWJKJ_WECHAT_APP_ID=your-website-app-id
WEBWJKJ_WECHAT_APP_SECRET=your-app-secret
```

The Tencent SMS template takes one verification-code parameter; this version accepts mainland China `+86` numbers. SMTP delivers a code to the new email address before binding. WeChat uses Open Platform website `snsapi_login` authorization with callback `${WEBWJKJ_PUBLIC_ORIGIN}/api/auth/callback/wechat`; configure its authorization domain in WeChat. Each user can bind one WeChat account, and each WeChat account belongs to one user.

Accounts and login sessions persist in `$DSH_HOME/webwjkj/accounts.sqlite`; the signing key is the adjacent `auth-secret`. Back up both the database and key. Omitting plugin `auth` configuration serves only the public homepage. [Config](src/auth-config.ts) owns delivery intervals, daily limits, code lifetime, attempt limits, session lifetime, and request size. Schema version 1 upgrades transactionally to version 2 on startup, adding a nullable unique login username while preserving existing UUIDs; newer database versions are rejected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) mounts the HTTP carrier, page plugin, JSON storage, and IM service. Accounts use Better Auth and Node SQLite; the official Tencent SDK sends SMS, SMTP verifies email, and WeChat endpoints exchange authorization codes and retrieve profiles. A cross-process file lock serializes account operations against concurrent OTP consumption; database versions advance monotonically.

Homepage and account forms render on the server; the browser loads webwjkj and the UI-only source bundle through separate Host and Client compiler configurations. The UI asset manifest admits exact output filenames and hashes; old workbench and extension routes return 404. Workspace scripts cannot execute inline code, evaluate code strings, or create workers or frames under their CSP. Account routes check sessions and mutation origins. Unloading removes routes, drains requests, and closes the database. No invariant companion is published: SQLite uniqueness constraints and authentication operations directly maintain account relationships without independent copies to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [HTTP server](../../host/webserver/README.md)
- [Application launch](../../../docs/architecture.md)
- [webwjkj decision](../../../.agents/notes/implemented/architecture/2026-09-13-webwjkj-homepage.md)

-----

<a id="model-experience"></a>
## Model Experience

### Homepage

#### What the model sees

None; `GET /` and `GET /en` serve browser-only HTML. This application mounts no agent, model, tool, or Session service.

#### Token effect

None; no model context is added.

#### KV Cache effect

None; there are no model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The default agent entry opens a conversation and stores messages; this bundle does not start a model provider or generate agent replies. Open tabs and pane positions are not restored across page reloads. Theme choice persists in the browser and does not synchronize across devices. SMS, email, and WeChat require provider configuration; local tests replace external services and do not prove live delivery. Rebuild the UI source before launching after source changes.

<a id="dev-note"></a>
### Dev Note

None.
