---
description: "管理 Docker 容器并查询其发布的 SSH 地址，无需安装容器内软件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-playground

[English](README.md) | 中文

## 概述

创建、列出、启动、停止和删除镜像提供 SSH 的 Docker 容器。镜像与 SSH 账户由你选择；Playground 不安装容器内软件，也不要求 Bash、Node.js、Python、SFTP 或 E2B 运行时。插件卸载和应用重启会保留容器。Docker 保存容器状态及归属标签。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

在现有 `dsh` profile 组合中以插件行挂载 `@deepseek-ai/dsh-playground`。显式设置所有部署字段：`socketPath` 是 Docker Engine Unix 套接字或 Windows 命名管道，`namespace` 标识管理的容器，`sshHost` 是客户端可达的 Docker 主机，`bindAddress` 是 Docker 发布 SSH 的 IP。`requestTimeoutMs` 限制每次 Docker 请求的时长；`stopTimeoutSeconds` 指定 Docker 停止容器的宽限时间。本地访问使用回环地址绑定。无效配置会拒绝插件激活；Docker 守护进程不可达时首次操作失败。

```yaml
- name: '@deepseek-ai/dsh-playground'
  config:
    socketPath: /var/run/docker.sock
    namespace: local-playground
    sshHost: 127.0.0.1
    bindAddress: 127.0.0.1
    requestTimeoutMs: 30000
    stopTimeoutSeconds: 10
```

消费者声明 `inject: ['playground']` 并调用 `ctx.playground`。`create()` 接受已有镜像、容器内的 `sshPort` 和已有 `username`，还可指定 Docker 名称、命令参数和显式环境变量。它返回已创建但未启动容器的完整 id。镜像保留 ENTRYPOINT，未指定命令时也保留 CMD；凭据和 SSH 配置由镜像或其显式启动输入负责。不复制宿主环境变量。镜像必须已经存在于 Docker 中。

`start()` 返回 Docker 状态及动态分配的 SSH 地址。容器运行并不证明 SSH 已就绪或认证能够成功。`get()` 和 `list()` 刷新这些观测；停止的容器不返回 SSH 地址。客户端负责认证和主机密钥校验。重复启动或停止均成功。`remove()` 要求容器已经停止，并保留其卷。

服务只操作带有配置命名空间标签的容器。重载后复用同一命名空间即可发现相同资源。卸载拒绝新操作，等待已接受的请求结束，并保留容器。Docker 请求超时或响应丢失可能使操作结果未知；重试创建前应先检查或列出容器。名称可以帮助定位此类资源。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[控制器](src/index.ts) 通过配置的套接字使用 dockerode，并验证 Docker 响应。归属及 SSH 元数据保存在 Docker 标签中；修改操作先检查归属，再使用不可变的完整容器 id。标签隔离管理清单，但 Docker 守护进程的访问权限仍决定谁能修改任意容器。不发布运行时 invariant 配套入口，因为 Docker 是唯一状态所有者，插件没有独立的容器投影。

</details>

<a id="further-exploration"></a>
## 深入探索

- [Playground 子系统](../../../docs/subsystems/playground.zh.md)
- [Docker 生命周期决策](../../../.agents/notes/implemented/architecture/2026-09-13-playground-docker-ssh.zh.md)
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-playground)

<a id="model-experience"></a>
## 模型体验

### 容器管理

#### 模型看到的内容

无；`playground` 插件不注册模型工具、提示词片段或 Session 事件。

#### Token 影响

无；容器操作不增加模型输入。

#### KV Cache 影响

无；容器操作不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此包仅提供后端服务，不挂载 Web 页面、模型工具、SSH 执行器、文件系统提供者或 Session 绑定。
- 镜像、SSH 账户、认证、卷和镜像分发由部署方负责。不提供默认镜像、镜像构建或拉取、容器内初始化。
- Docker 访问使用显式本地套接字或命名管道。不解析 Docker context 或远程 TLS/SSH Docker 传输。
- 每次操作读取实时 Docker 状态，不使用跨进程锁。外部启动、停止、删除或网络变化可能与返回的观测并发；重启后发布的 SSH 端口可能变化。

<a id="dev-note"></a>
### 开发备注

无。
