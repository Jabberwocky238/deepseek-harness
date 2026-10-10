# Agent Note: Docker Playground with SSH-only guest requirements

Status: implemented

[English](2026-09-13-playground-docker-ssh.md) | 中文

## 问题

容器管理必须接受用户选择的、提供 SSH 的镜像，不要求容器内具备特定语言运行时、Shell 工具集或沙盒平台。

## 决策

`dsh-playground` 是位于 `packages/playground/playground` 的单个 Docker 控制器。它使用 dockerode 执行创建、列出、检查、启动、停止和删除操作。镜像提供 SSH 账户和配置。控制器在 Docker 标签中记录命名空间、SSH 端口和用户名，并返回发布的地址，不执行容器内命令，也不声称 SSH 已就绪。

Docker 是权威清单。插件卸载后容器保留；卸载停止接收新操作并等待已接受的操作结束。修改操作验证命名空间归属，并使用不可变的完整 Docker id，因此名称复用不能将已经检查的修改重定向到其他容器。删除要求容器已停止，并保留卷。命名空间标签区分管理范围，不提供 Docker 授权隔离。套接字、主机、绑定地址及超时等部署参数均显式配置。

## 考虑过的替代方案

**自托管 E2B：** 它要求自身的沙盒基础设施及运行时协议，超出了容器仅需 SSH 的要求。

**复用 bash-ssh 作为管理器：** 该执行器既不创建容器，也不接受仅支持 SSH 的环境；它要求 Bash、stty 和 GNU timeout。

**卸载时自动删除：** 插件重载会破坏仍有独立用途的容器。显式停止和删除操作保留操作方的控制权。

## 影响

容器管理不需要修改模型、Web 或 Session。Docker 镜像分发、认证、容器内初始化和执行适配器继续独立负责。Docker 请求超时不能证明服务端修改已取消；客户端通过列出带标签的清单恢复。控制器不保存重复容器状态，因此没有 invariant 配套入口。

Loader 测试覆盖 Docker 请求、命名空间隔离、地址投影、幂等操作、失败及卸载。按需启用的 Docker 测试对仅安装 OpenSSH 的夹具进行 SSH 认证，并验证插件重载时保留容器，以及显式停止和删除。
