---
description: "通过 SSH 主机运行现有 Bash 工具，支持远端工作目录和终端中断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-ssh

[English](README.md) | 中文

## 概述

在远端主机上运行现有 `bash` 工具，无需模型管理 SSH 连接。每次调用都在配置的远端工作目录启动新的 Bash，后台任务使用现有任务控制工具。远端需要 Bash、`stty` 和 GNU `timeout`；认证使用私钥或显式指定的 SSH agent 套接字。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

用本提供者替换组合中的本地 Bash 执行器，保留 `dsh-tool-bash` 和 `dsh-shell-env`。只能由一个提供者注册 `ctx.shell`；出厂默认执行器保持不变。配置 `host`、`username`、`hostKeySha256` 和远端 `cwd`，并在 `privateKeyFile` 与 `agentSocket` 中选且仅选一个。固定指纹使用服务器公钥 SHA-256 摘要的小写十六进制形式，不是 OpenSSH 显示的 base64 格式。 替换沙箱执行器时需禁用 `dsh-permission-presets`：其本地沙箱预设要求 Shell 提供约束能力，不能管理 SSH 访问。

`localWorkspaceRoot` 将指定的本地路径前缀及其子目录映射到远端 `cwd`。其他绝对路径直接指向远端主机；提供者收到的相对路径基于远端 `cwd` 解析。当 Bash 工具传入的本地 Session 工作目录与远端挂载路径不同时，需配置此映射。文件工具、LSP 和持久终端仍使用各自的提供者。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-bash-ssh)记录完整字段。[Loader 组合测试](tests/loader.spec.ts)将此提供者与现有工具一起挂载，并通过认证后的 SSH 服务执行命令。

前台执行在远端 Bash 内使用 `timeout --signal=INT`。取消、`job_kill` 和提供者卸载会通过 PTY 发送 Ctrl-C 并等待退出。没有外部执行计时器、宽限期、连接截止时间或强制终止兜底：远端命令忽略中断时，调用和卸载都可以无限等待。后台命令没有超时。

每次调用先从远端环境中清除凭据特征变量和过期的 `DSH_*` 变量，再加入显式环境变量和当前托管信息。命令使用与本地 Bash 相同的颜色和分页器设置。远端 stdout 与 stderr 共用 PTY 输出，SSH 诊断信息单独保留。输出仅保留有界尾部，不写溢出文件。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供者通过 `ssh2` 建立认证连接和 PTY 通道。脚本、路径和显式环境变量值经过引用后交给远端登录 Shell；命令的标准输入与用于 Ctrl-C 的终端输入分开提供。Bash 工具负责 schema、结果渲染和任务注册。本包不发布运行时不变量伴随模块，因为它不维护独立发布的连接状态投影。

参见[执行实现](src/index.ts)、[远端命令](src/command.ts)和[有界输出](src/output.ts)。

本地 SSH 集成测试要求测试主机安装 Bash 和 GNU `timeout`；macOS 上可通过 `brew install coreutils` 提供 `timeout`。

</details>

<a id="model-experience"></a>
## 模型体验

间接通过 `dsh-tool-bash`，使用现有 schema 和结果格式渲染前台结果、后台输出及执行错误。

#### KV Cache 影响

提供者不添加提示词段落或工具。替换沙箱执行器会移除 Bash 工具的条件性提权参数；组合不变时，工具 schema 保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- PTY 输出合并远端 stdout 和 stderr；截断输出没有完整输出文件。
- GNU `timeout` 使用退出码 124 表示超时；命令自身退出码为 124 时无法区分。
- Ctrl-C 作用于终端前台进程组。忽略信号、脱离终端的进程或连接丢失可能阻止调用结束；提供者不强制终止远端进程树。
- SSH 认证和远端权限决定访问范围。本地文件沙箱不约束远端命令，此提供者不提供沙箱提权能力。
- 每个提供者实例使用一个固定目标。容器创建、按 Agent 路由、共享文件系统挂载、密码提示和 OpenSSH 配置文件解析不属于本包。

<a id="dev-note"></a>
### 开发备注

无。
