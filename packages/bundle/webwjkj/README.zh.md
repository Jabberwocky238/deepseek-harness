---
description: "独立 webwjkj 首页应用的安装、运行和维护说明。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-webwjkj

[English](README.md) | 中文

## 概述

webwjkj 是独立网页应用：公开首页、短信、账号密码、邮箱与微信登录、UUID 用户资料、邮箱与微信绑定，以及登录后的多面板工作台。它使用专用 profile，不依赖官方 Web 应用，浏览和账号登录不需要模型密钥。

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

启动配置前运行 `pnpm run build:webwjkj-workbench`。该命令将直接维护的 [UI 源码](../../../vendor/webwjkj/README.md) 编译至本包的 `lib/workbench` 目录。构建只接纳浏览器 UI 组件，拒绝完整工作台、编辑器引擎、扩展宿主、服务端与外部运行时依赖。`workbenchRoot: bundled` 选择此产物；显式路径可选择经过相同资源校验的其他构建。

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

登录入口 `/login` 顶部通过文字 Tab 切换短信验证码与账号密码，下方通过邮箱和微信图标切换相应登录方式，每次只显示一个表单，验证后进入 `/workspace`。短信、邮箱和微信首次验证创建 UUID 用户；在 `/account` 设置 3–30 位登录账号与 12–128 位密码后可使用账号登录，修改已有密码需要当前密码。手机号、邮箱和微信可在账号设置中验证绑定，同一已绑定身份的登录使用原 UUID。未绑定的不同身份不会自动合并。

活动栏左下角为设置，个人资料入口紧邻其上方。个人资料通过原生弹窗展示并支持编辑，退出登录返回登录页。账号与安全打开工作区标签，使用工作台主题、分类导航和面板内表单结果。直接访问 `/account` 也会打开此标签，微信授权绑定后返回这里。点击联系人或群聊打开带文字历史和消息编辑器的会话标签。每个账号默认拥有 `default agent` 好友。向它发送私聊消息会调用已配置的模型并显示回复。默认模型读取共享的 `agent-default-model` 设置，未设置时采用 profile 中的 `deepseek-official / deepseek-flash`。DeepSeek 适配器使用共享设置和凭据提供方，包括 `DEEPSEEK_API_KEY`。IM 消息与群聊通过共享存储服务持久化至 `$DSH_HOME/webwjkj/im`。

应用复用克隆的 VS Code 网格、分隔条、动作栏、图标与对话框 UI 源码，标签、联系人列表、消息面板和设置由 webwjkj 提供。联系人按钮打开合并的联系人与群聊列表，最近通信的对象排在前面。下方与右侧工作区初始关闭，打开时为空白，标签可拖动到不同区域。应用不包含状态栏、VS Code Chat、终端、命令面板、文件浏览器、扩展安装、远程执行或扩展宿主。

左侧栏提供添加好友、发起群聊、通知与刷新按钮。按 UUID、已验证手机号或已验证邮箱精确搜索，在上方工作区打开公开资料，不返回联系方式。好友申请可以附带打招呼消息，只有收件人能够接受或拒绝。申请持久化在版本 3 的账号 SQLite 数据库中，接受后的关系幂等投影为 IM 双向联系人。创建群聊只能选择当前账号的联系人。设置提供亮色、暗色与跟随系统选项，默认跟随系统，手动选择按用户 UUID 保存在浏览器中。

本地测试可在个人 profile 的 `cordis.patch.yml` 显式设置以下配置，使用 `admin / 123123` 登录。它不包含在默认 bundle 配置中；仅接受本机监听和本机地址，`NODE_ENV=production` 会拒绝启用。测试数据库位于 `$DSH_HOME/webwjkj/local-test`，普通模式使用原目录，不读取测试账号。首次创建后重启不会重置密码；关闭开关即可返回普通数据库。

```yaml
- id: webwjkj-home
  config:
    workbenchRoot: bundled
    auth:
      root: !!js dshHomePath('webwjkj')
      publicOrigin: http://127.0.0.1:3081
      localTestAccount: true
- id: webwjkj-storage-json
  config:
    root: !!js dshHomePath('webwjkj', 'local-test', 'im')
```

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

账号与登录会话保存在 `$DSH_HOME/webwjkj/accounts.sqlite`，签名密钥位于同目录的 `auth-secret`，备份需保留数据库及该密钥。省略插件 `auth` 配置可只提供公开首页。发送间隔、每日发送限额、验证码有效期、尝试次数、会话有效期和请求大小由 [Config](src/auth-config.ts) 管理。 数据库版本 1 在启动时以事务升级到版本 2，增加可空的唯一登录账号字段并保留已有 UUID；更高版本数据库被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[补丁](cordis.patch.yml) 挂载 HTTP 服务、页面插件、JSON 存储、IM 服务和工具注册表为空的模型内核。[默认 agent 消费方](src/default-agent.ts) 在每个私聊内串行生成回复，将每次模型轮次记录在 `$DSH_HOME/webwjkj/sessions`。它只提供该对话中配置数量以内的近期消息，并将完整回复写入 IM。根据用户消息生成的回复 ID 保证成功重试幂等。模型失败时保留用户消息，在聊天中显示重试提示。配置超时或插件关闭会中止并等待活动轮次结束。账号使用 Better Auth 与 Node SQLite，腾讯云官方 SDK 发送短信，SMTP 验证邮箱，微信接口交换授权码并获取用户资料。账号操作通过跨进程文件锁串行执行，防止同一个验证码并发消费；数据库版本只允许单调升级。

首页和账号表单由服务端生成；浏览器通过独立的 Host 与 Client 编译配置加载 webwjkj 与仅含 UI 的源码构建。UI 资源清单严格匹配输出文件名和摘要，旧工作台与扩展路由返回 404。工作台 CSP 禁止脚本内联执行、字符串求值以及 worker 和 frame。账号路由验证会话和写操作来源。卸载先移除路由，再排空请求并关闭数据库。此包不发布 invariant companion：SQLite 唯一约束和认证操作直接维护账号关系，没有独立副本需要交叉验证。

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

### 默认 agent 聊天

#### 模型看到的内容

默认 agent 收到由已授权私聊的近期消息组成的 JSON 数组，按时间排序，每条包含角色和文本字段。完整输入和模型回复记录在专用 Session 中。profile 不提供执行或文件系统工具，其他账号和会话被排除在外。公开首页和认证请求不调用模型。

#### Token 影响

每次发送包含至多 `historyMessages` 条近期消息，并通过 `maxTokens` 限制输出；两者均在 `webwjkj-default-agent` 上配置。

#### KV Cache 影响

每次回复使用新的日志 Session 和有限的会话窗口。提供方可以缓存前缀，但应用不保证窗口移动后前缀仍可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 默认 agent 支持文字私聊，未启用群聊自动回复、流式增量回复和附件。每次请求使用配置的近期历史窗口；更早消息仍可在 IM 中查看，但不进入模型上下文。打开的标签与面板位置不会跨页面刷新恢复。主题选择保存在浏览器中，不跨设备同步。短信、邮件和微信需要服务配置；本地测试替换外部服务，不能证明真实投递成功。源码变化后，启动前需重新构建 UI。

<a id="dev-note"></a>
### 开发备注

None.
