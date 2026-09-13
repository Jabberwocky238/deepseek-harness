# Agent Note: 独立 webwjkj 首页

Status: implemented

[English](2026-09-13-webwjkj-homepage.md) | 中文

## Problem

webwjkj 需要独立开发的首页，不继承官方 Web 应用的聊天界面或模型组合。

## Decision

[webwjkj bundle](../../../../packages/bundle/webwjkj/README.zh.md) 自行维护首页、类型化语言字典和响应式样式。完整插件树仅包含现有 HTTP 服务和一个页面插件。应用通过专用 dsh profile 启动，遵循[应用启动规则](../../../../docs/architecture.zh.md#application-launch)。

## Alternatives considered

**另建官方 Web profile。** 这会保留官方界面和应用组合，无法提供独立的 webwjkj 首页。

**复制官方 Web 应用。** 静态首页不需要聊天、RPC、模型配置或重复的客户端基础设施。

## Consequences

首页无需模型凭据即可运行，并可独立演进。公开路由不包含用户数据；私有功能需要明确的访问控制设计。首版不提供聊天或持久化。包内 HTML 预期输出及真实 Loader/HTTP 测试验证两种语言、请求方法处理和卸载。现有 profile 和 HTTP 组合决策继续有效；本模块不取代它们。
