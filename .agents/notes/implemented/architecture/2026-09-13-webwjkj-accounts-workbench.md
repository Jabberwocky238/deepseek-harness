# Agent Note: webwjkj accounts and workbench

Status: implemented

English | [中文](2026-09-13-webwjkj-accounts-workbench.zh.md)

## Problem

The independent webwjkj application needs verified phone identities, optional email and WeChat binding, and an extensible workbench whose central upper and lower areas can display the same panel types.

Friend applications use account SQLite schema 3 and an unordered unique user pair. Exact verified-identity search returns UUID, display name, and avatar only. Only the authenticated recipient can decide an application. Accepted rows project idempotently into IM contacts on directory reads.

## Decision

[webwjkj](../../../../packages/bundle/webwjkj/README.md) owns a dedicated SQLite account database and uses Better Auth for sessions and verification, the Tencent Cloud SDK for SMS, SMTP for email, and Open Platform website OAuth for WeChat. User IDs are UUIDs. Authenticated forms expose only required operations; a cross-process lock serializes code verification, and unique indexes enforce one WeChat account per user and one owner per WeChat account. Production origins require HTTPS. Account pages use a same-origin referrer policy so browser form submissions retain their Origin header for CSRF validation.

Four parallel login methods use verified phone or email codes, username/password credentials, or WeChat OAuth. New verified identities create UUID users; explicit bindings reuse an existing UUID. Username login uses Better Auth’s username plugin and password hashing, with no public password signup endpoint. Schema version 2 adds the nullable unique username field through a transactional migration from version 1. WeChat signup uses an unverified internal placeholder email because its profile API does not supply email addresses; that placeholder never appears as a bound email.

The application compiles directly maintained UI source cloned from code-server’s VS Code revision. The repository retains only the transitive Grid, Sash, ActionBar, Dialog, and Codicon source closure. The build rejects workbench, editor, platform, server, extension-host, and external runtime imports. UI asset admission checks exact filenames and hashes; unsupported workbench and extension URLs return 404. There is no source-patch application or precompiled workbench installation.

The left activity bar anchors Settings at the bottom and Profile immediately above it. Profile opens an application-owned native dialog, and sign-out returns directly to login. The right and lower work areas open empty. The contact sidebar uses authenticated `webwjkj:<user UUID>` identities, includes default agent, and supports approved friendships and contact-only group creation. Text history and outgoing messages remain scoped to joined conversations.

webwjkj owns tabs, tab dragging, conversation panels, friend applications, notifications, and profile operations. VS Code contributes UI widgets only. Light, dark, and system themes share the same dialogs; manual theme choice is stored per UUID. No model provider or agent runtime is started by the default agent contact.

## Alternatives considered

**A full VS Code workbench with removed icons.** Transitive contributions can restore commands and views, including Chat and development tools. The application excludes the runtime and builds only UI dependencies.

**Custom authentication and splitter implementations.** Better Auth owns sessions and verification; the cloned Grid and Sash own resizing. webwjkj owns its account and messaging operations.

The optional local test fixture seeds `admin / 123123` through the normal hashed credential store in a separate `local-test` subdirectory. It requires explicit configuration and loopback HTTP composition, and rejects production mode. Ordinary startup neither seeds nor reads the fixture directory, so provider failures cannot activate default credentials. Existing fixture passwords remain authoritative across restarts.

## Consequences

Provider credentials and approved Tencent and WeChat application settings are deployment requirements. Tests use the real Loader, HTTP server, Better Auth, and SQLite while replacing external delivery and OAuth calls; owner-local HTML snapshots cover account and workbench output. Live provider delivery requires separate credentialed verification. The independent homepage decision remains active; this decision adds authenticated behavior without changing the official Web application.

Nodemailer declares [MIT-0](https://spdx.org/licenses/MIT-0.html), whose grant permits use, modification, and redistribution without an attribution requirement. The notice generator recognizes this SPDX identifier as permissive; unknown identifiers and copyleft conjunctions remain rejected.

The notices generator discloses the source-only UI separately from npm workspaces and requires the retained code-server, VS Code, and Codicons license files. Missing or empty licenses fail generation.
