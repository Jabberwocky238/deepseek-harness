# webwjkj UI source

English | [中文](README.zh.md)

## Summary

This directory is the editable source of webwjkj’s VS Code UI primitives. The source was cloned from code-server and its pinned VS Code revision, then reduced to the UI dependency graph. The exact upstream revisions are recorded in [upstream.json](upstream.json). These files are source inputs, not an npm workspace or a patch overlay.

## Build

Run `pnpm run build:webwjkj-workbench` from the repository root. It compiles `vscode/src/vs/webwjkj/ui.ts` directly into `packages/bundle/webwjkj/lib/workbench`. The build checks every transitive input and rejects sources outside browser/common UI code, the localization helper, and this UI entry. It also rejects external imports. No upstream download, patch application, server build, or extension build runs.

## Maintained source

The retained upstream files provide Grid, Sash, ActionBar, Dialog, Codicons, and their browser/common dependencies. Workbench, editor engine, platform services, server, extension-host, extension packages, tests, and upstream build tooling are absent. code-server contributes its preserved license; its server implementation is not part of the UI application.

Local changes are confined to `vscode/src/vs/webwjkj/ui.ts`, which exposes the selected widgets, supplies application theme variables to Dialog, and emits Codicon glyph rules without the platform theme service. The Codicon font is from `@vscode/codicons` version `0.0.46-39`; its license is retained alongside the upstream licenses. Trailing whitespace in `CODICONS-LICENSE` and the extra final blank line in `vscode/src/vs/base/common/observableInternal/transaction.ts` are normalized for the repository whitespace check. Other retained source files are unchanged.

To update, clone the desired upstream revision outside this tree, copy only the admitted UI dependency closure, update `upstream.json` and this modification record, then run the source build, UI dependency tests, and webwjkj browser flow. Added workbench or server dependencies must fail the source check.
