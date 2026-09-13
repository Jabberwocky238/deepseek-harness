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

The `/login` page offers four parallel methods: SMS code, login username and password, email code, and WeChat QR authorization. Each successful login opens `/workspace`. First phone, email, or WeChat verification creates a UUID user; configure a 3–30 character login username and 12–128 character password in `/account` to enable password login. Changing an existing password requires the current password. Phone, email, and WeChat identities can be verified and bound in account settings; linked identities sign in to the same UUID. Unlinked identities are not automatically merged.

Dockview provides sidebars around two equal central work areas; tabs can be moved, closed, split, and reopened, and dividers resize groups. Layouts and notes are stored per user UUID in the current browser; narrow screens start with the two central groups. `/account` manages usernames, HTTPS avatar URLs, email verification, and WeChat QR binding.

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

The [patch](cordis.patch.yml) mounts the HTTP carrier and page plugin. Accounts use Better Auth and Node SQLite; the official Tencent SDK sends SMS, SMTP verifies email, and WeChat endpoints exchange authorization codes and retrieve profiles. A cross-process file lock serializes account operations against concurrent OTP consumption; database versions advance monotonically.

Homepage and account forms render on the server; the workbench loads a standalone Dockview browser artifact with separate Host and Client compiler configurations. Account and workspace routes check sessions, mutations check origins, and only required forms and the WeChat callback expose authentication operations. Unloading removes routes, drains requests, and closes the database. No invariant companion is published: SQLite uniqueness constraints and authentication operations directly maintain account relationships without independent copies to cross-check.

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

- The workbench provides welcome, notes, guide, and account overview panels, without code-server editors, terminals, or extensions. Layouts and notes do not synchronize across browsers. SMS, email, and WeChat require valid provider configuration; local tests replace external services and do not prove live delivery. Source changes require rebuilding and restarting.

<a id="dev-note"></a>
### Dev Note

None.
