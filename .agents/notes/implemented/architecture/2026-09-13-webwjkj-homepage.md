# Agent Note: Independent webwjkj homepage

Status: implemented

English | [中文](2026-09-13-webwjkj-homepage.zh.md)

## Problem

webwjkj needs an independently developed homepage without inheriting the official Web application's chat interface or model composition.

## Decision

The [webwjkj bundle](../../../../packages/bundle/webwjkj/README.md) owns its homepage, typed locale dictionaries, and responsive styles. The homepage uses the existing HTTP carrier and one page plugin; the bundle also mounts storage and IM for authenticated workspaces. The application starts through a dedicated dsh profile, following the [application launch rule](../../../../docs/architecture.md).

## Alternatives considered

**Another official Web profile.** This retains the official interface and application composition rather than giving webwjkj an independent homepage.

**Copying the official Web application.** A static homepage does not need chat, RPC, model configuration, or duplicated client infrastructure.

## Consequences

The homepage runs without model credentials and can evolve independently. Its public routes contain no user data; private features need an explicit access-control design. It provides no chat; private accounts and workspace behavior follow the [account and workbench decision](2026-09-13-webwjkj-accounts-workbench.md). The package owns HTML expected outputs and a real Loader/HTTP test that verifies both languages, method handling, and disposal. Existing profile and HTTP composition decisions remain active; this module supersedes none of them.
