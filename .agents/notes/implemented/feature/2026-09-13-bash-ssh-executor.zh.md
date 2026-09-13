# Agent Note: 由远端负责中断的 SSH Bash

Status: implemented

[English](2026-09-13-bash-ssh-executor.md) | 中文

## Problem

Agent 需要在远端容器工作目录中执行 Bash，同时保留现有工具和后台任务接口。本地 SSH 进程的截止时间可以关闭连接，却不能证明远端命令已经停止。

## Decision

[SSH 执行器](../../../../packages/shell/bash-ssh/README.zh.md)实现现有 Shell 服务，保持 Bash 工具不变。每次调用都创建经过认证的 SSH PTY 和新的 Bash。部署配置负责目标、认证、主机密钥固定及工作目录映射；模型参数不包含 SSH 凭据或路由字段。

前台命令通过远端 GNU `timeout --signal=INT` 运行。取消和卸载写入 Ctrl-C 并等待远端退出。没有外部截止时间、宽限计时器、强制关闭连接或 SIGKILL 兜底来强制结束。忽略中断的命令可以使执行和卸载无限等待。后台任务不使用 timeout 包装。

## Alternatives considered

- 增加另一个面向模型的 SSH 工具会重复 Bash 接口，并将部署细节暴露到模型请求中。
- 终止本地 SSH 客户端或增加外部宽限计时器无法证明远端终止，也违背由远端负责中断的要求。
- Python 监督进程会增加 Bash 和标准命令行工具之外的远端运行时依赖。执行器使用 PTY 的前台信号投递。

## Consequences

相同的 Bash schema、渲染和任务控制可用于 SSH 目标。PTY 输出合并远端 stdout 和 stderr；保留的尾部没有溢出文件。退出码 124 遵循 GNU timeout 约定，无法区分命令自行返回 124 的情况。宿主机文件工具和 LSP 不会随 Shell 提供者一起迁移，因此部署需要另行对齐它们的执行环境。

经过认证的回环 SSH 测试覆盖真实 PTY、引用、输入、环境清理、前台超时、Ctrl-C 和卸载。释放文件屏障证明中断不会结束仍在运行的命令。[无界面场景](../../../../snapshots/session/bash-ssh-turn/snapshot.yml)负责记录 Bash 结果。现有能力接口和本地执行器决策保持有效；此新增功能不取代它们。
