---
description: "独立 webwjkj 首页应用的安装、运行和维护说明。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-webwjkj

[English](README.md) | 中文

## 概述

webwjkj 提供独立的响应式首页，包括介绍卡片、关于区域和中英文切换。它只挂载 HTTP 服务和自己的页面插件，无需模型密钥。该本地开发模块使用专用 profile，不依赖官方 Web 应用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

构建仓库后，在 `$DSH_HOME/profiles/webwjkj/package.json` 中准备以下独立 profile 清单（默认 home 为 `~/.dsh`），然后从仓库根目录安装本地模块。

```json
{
  "name": "dsh-profile-webwjkj",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [], "patchReload": "live" } }
}
```

```sh
pnpm dsh plugin --profile webwjkj add link:./packages/bundle/webwjkj
pnpm dsh --profile webwjkj
```

打开 `http://127.0.0.1:3081/` 查看中文首页，`/en` 查看英文首页。安装命令将模块加入 profile 的 bundle 列表。已有清单不应被覆盖；专用 profile 的 bundle 列表只应包含 `@deepseek-ai/dsh-webwjkj`。

在 profile 的 `cordis.patch.yml` 中覆盖 `webwjkj-server` 行可更改监听地址和端口；配置替换整行 config，需同时提供 host 和 port。端口冲突会导致启动失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[补丁](cordis.patch.yml) 挂载两个插件。[入口](src/index.ts) 通过 effect 注册精确路由；[页面](src/homepage.ts) 使用[类型化文案](src/locales.ts)和[样式](src/styles.ts)生成 HTML。页面无需脚本、外部字体或静态资源请求。

GET 和 HEAD 返回首页，其他方法返回 405，未知路径返回 404。卸载插件会移除两个路由。此包不发布 invariant companion：路由仅由 HTTP 注册表保存，没有独立状态需要交叉验证。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [HTTP server](../../host/webserver/README.zh.md)
- [Application launch](../../../docs/architecture.zh.md#application-launch)
- [webwjkj decision](../../../.agents/notes/implemented/architecture/2026-09-13-webwjkj-homepage.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 首页

#### 模型看到的内容

None；`GET /` 和 `GET /en` 仅向浏览器提供 HTML。此应用不挂载 Agent、模型、工具或 Session 服务。

#### Token 影响

None；不添加模型上下文。

#### KV Cache 影响

None；没有模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 首版仅提供公开的静态首页，没有聊天、认证、业务 API 或数据存储。添加私有数据之前需引入访问控制。该模块尚未发布到 npm，源码改动需重新构建并重启应用。

<a id="dev-note"></a>
### 开发备注

None.
