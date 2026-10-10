---
description: "Docker 容器管理及 SSH 地址查询包。"
kind: "package-group"
---

# playground/ — Docker 容器

[English](README.md) | 中文

## 概述

管理镜像支持 SSH 的 Docker 容器。此包组将容器生命周期与远程命令执行分开。容器内软件及凭据由部署方选择。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

控制器提供容器操作。

| 包 | 职责 |
|---|---|
| [playground](playground/README.zh.md) | Docker 容器生命周期及发布的 SSH 地址 |

<a id="related-documentation"></a>
## 相关文档

- [Playground 子系统](../../docs/subsystems/playground.zh.md) — 归属及服务 API。

<a id="dev-note"></a>
## 开发备注

无。
