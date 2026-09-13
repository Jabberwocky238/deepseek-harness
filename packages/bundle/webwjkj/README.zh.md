---
description: "独立 webwjkj 首页应用的安装、运行和维护说明。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-webwjkj

[English](README.md) | 中文

## 概述

webwjkj 是独立网页应用：公开首页、腾讯云短信登录、UUID 用户资料、邮箱与微信绑定，以及登录后的多面板工作台。它使用专用 profile，不依赖官方 Web 应用，也不需要模型密钥。

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

登录入口是 `/login`，登录成功进入 `/workspace`。Dockview 提供左右侧栏和中间上下两个同等工作区；标签可以拖动、关闭、拆分和重新打开，分隔线可调整尺寸。布局和便笺按用户 UUID 保存在当前浏览器，窄屏默认只显示中间两组。`/account` 管理用户名、HTTPS 头像链接、邮箱验证和微信扫码绑定。

在启动进程的环境中配置以下变量；密钥仅存放在本地环境或密钥管理服务中。未配置的服务显示未开通，填写不完整的配置会导致加载失败。生产环境使用 HTTPS，并将 `WEBWJKJ_PUBLIC_ORIGIN` 设置为对外地址。

```sh
WEBWJKJ_PUBLIC_ORIGIN=https://web.example.com
WEBWJKJ_SMS_APP_ID=your-sdk-app-id
WEBWJKJ_SMS_SIGN=your-approved-sign
WEBWJKJ_SMS_TEMPLATE_ID=your-approved-template-id
WEBWJKJ_SMS_REGION=ap-guangzhou
TENCENTCLOUD_SECRET_ID=your-secret-id
TENCENTCLOUD_SECRET_KEY=your-secret-key
WEBWJKJ_SMTP_HOST=smtp.example.com
WEBWJKJ_SMTP_PORT=465
WEBWJKJ_SMTP_SECURE=true
WEBWJKJ_SMTP_USER=your-smtp-user
WEBWJKJ_SMTP_PASSWORD=your-smtp-password
WEBWJKJ_SMTP_FROM=no-reply@example.com
WEBWJKJ_WECHAT_APP_ID=your-website-app-id
WEBWJKJ_WECHAT_APP_SECRET=your-app-secret
```

腾讯云短信模板需要一个验证码参数，首版仅支持中国大陆 `+86` 手机号。邮箱通过 SMTP 向新邮箱发送验证码，验证后绑定。微信使用开放平台网站应用 `snsapi_login` 授权，回调为 `${WEBWJKJ_PUBLIC_ORIGIN}/api/auth/callback/wechat`，需在微信平台配置授权域名；每个用户最多绑定一个微信，同一个微信不能绑定多个用户。

账号与登录会话保存在 `$DSH_HOME/webwjkj/accounts.sqlite`，签名密钥位于同目录的 `auth-secret`，备份需保留数据库及该密钥。省略插件 `auth` 配置可只提供公开首页。发送间隔、每日发送限额、验证码有效期、尝试次数、会话有效期和请求大小由 [Config](src/auth-config.ts) 管理。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[补丁](cordis.patch.yml) 挂载 HTTP 服务和页面插件。账号使用 Better Auth 与 Node SQLite，腾讯云官方 SDK 发送短信，SMTP 验证邮箱，微信接口交换授权码并获取用户资料。账号操作通过跨进程文件锁串行执行，防止同一个验证码并发消费；数据库版本只允许单调升级。

首页和账号表单由服务端生成；工作台加载独立 Dockview 浏览器产物，Host 与 Client 使用独立编译配置。账号和工作台路由检查会话，写操作检查来源，认证端点只开放所需表单和微信回调。卸载先移除路由，再排空请求并关闭数据库。此包不发布 invariant companion：SQLite 唯一约束和认证操作直接维护账号关系，没有独立副本需要交叉验证。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [HTTP server](../../host/webserver/README.zh.md)
- [Application launch](../../../docs/architecture.zh.md)
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

- 工作台提供欢迎、便笺、说明和账号概览面板，不包含 code-server 编辑器、终端或扩展。布局与便笺不跨浏览器同步。短信、邮件和微信需要有效服务配置；本地测试仅替换外部服务，不能证明真实账号投递成功。源码改动需要重新构建并重启。

<a id="dev-note"></a>
### 开发备注

None.
