# Agent Note: webwjkj accounts and workbench

Status: implemented

English | [中文](2026-09-13-webwjkj-accounts-workbench.zh.md)

## Problem

The independent webwjkj application needs verified phone identities, optional email and WeChat binding, and an extensible workbench whose central upper and lower areas can display the same panel types.

## Decision

[webwjkj](../../../../packages/bundle/webwjkj/README.md) owns a dedicated SQLite account database and uses Better Auth for sessions and verification, the Tencent Cloud SDK for SMS, SMTP for email, and Open Platform website OAuth for WeChat. User IDs are UUIDs. Authenticated forms expose only required operations; a cross-process lock serializes code verification, and unique indexes enforce one WeChat account per user and one owner per WeChat account. Production origins require HTTPS.

Four parallel login methods use verified phone or email codes, username/password credentials, or WeChat OAuth. New verified identities create UUID users; explicit bindings reuse an existing UUID. Username login uses Better Auth’s username plugin and password hashing, with no public password signup endpoint. Schema version 2 adds the nullable unique username field through a transactional migration from version 1. WeChat signup uses an unverified internal placeholder email because its profile API does not supply email addresses; that placeholder never appears as a bound email.

Dockview owns browser tabs, splits, resizing, and layout serialization. The browser entry has its own compiler configuration and artifact; it does not use the official Web composition. The initial layout places two equal central work groups between sidebars, with per-user local browser layout and note storage. Account settings remain a separately protected page.

## Alternatives considered

**Full code-server integration.** Its VS Code workbench includes filesystem access, terminals, and extensions. Those capabilities are outside the requested application panel framework; the maintained Dockview package supplies the needed layout behavior without owning a VS Code fork.

**Custom authentication and docking implementations.** Maintaining OTP sessions, OAuth state, draggable tabs, and splitter behavior duplicates supported libraries. Application code owns provider adaptation, exposed operations, persistence constraints, and panel content.

## Consequences

Provider credentials and approved Tencent and WeChat application settings are deployment requirements. Tests use the real Loader, HTTP server, Better Auth, and SQLite while replacing external delivery and OAuth calls; owner-local HTML snapshots cover account and workbench output. Live provider delivery requires separate credentialed verification. The independent homepage decision remains active; this decision adds authenticated behavior without changing the official Web application.

Nodemailer declares [MIT-0](https://spdx.org/licenses/MIT-0.html), whose grant permits use, modification, and redistribution without an attribution requirement. The notice generator recognizes this SPDX identifier as permissive; unknown identifiers and copyleft conjunctions remain rejected.
