# webwjkj UI 源码

English | [中文](README.zh.md)

## 摘要

此目录直接维护 webwjkj 使用的 VS Code UI 组件源码。源码来自克隆的 code-server 及其固定版本 VS Code，随后裁剪为 UI 依赖图。确切上游版本记录在 [upstream.json](upstream.json) 中。这些文件是源码输入，不是 npm 工作区或补丁覆盖层。

## 构建

在仓库根目录运行 `pnpm run build:webwjkj-workbench`。命令直接将 `vscode/src/vs/webwjkj/ui.ts` 编译至 `packages/bundle/webwjkj/lib/workbench`。构建检查全部传递依赖，只允许浏览器与通用 UI 代码、本地化辅助模块和此 UI 入口，并拒绝外部导入。构建不会下载上游、应用补丁、编译服务端或编译扩展。

## 维护的源码

保留的上游文件提供 Grid、Sash、ActionBar、Dialog、Codicons 及其浏览器与通用依赖。完整工作台、编辑器引擎、平台服务、服务端、扩展宿主、扩展包、测试和上游构建工具均不在此树中。code-server 保留许可证，其服务端实现不属于 UI 应用。

本地修改仅位于 `vscode/src/vs/webwjkj/ui.ts`：导出选定组件，为 Dialog 提供应用主题变量，并在不使用平台主题服务的情况下生成 Codicon 字形规则。Codicon 字体来自 `@vscode/codicons` 版本 `0.0.46-39`，许可证与上游许可证一起保留。为符合仓库空白检查，规范化 `CODICONS-LICENSE` 的行尾空白和 `vscode/src/vs/base/common/observableInternal/transaction.ts` 的文件末尾多余空行。其他保留源码没有修改。

更新时，在此目录之外克隆目标上游版本，只复制获准的 UI 依赖闭包，更新 `upstream.json` 与本修改记录，然后运行源码构建、UI 依赖测试和 webwjkj 浏览器流程。新增工作台或服务端依赖必须使源码检查失败。
