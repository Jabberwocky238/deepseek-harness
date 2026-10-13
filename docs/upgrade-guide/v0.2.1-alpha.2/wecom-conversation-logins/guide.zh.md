---
kind: upgrade-guide
description: "会话级企微 bot 的建号脚本多了第三个参数（部署登录名），两个会话配置键被删除，入站附件改存到各会话的家目录。"
---

# 企微会话登录：建号脚本参数、删除的配置键、inbox 位置

[English](guide.md) | 中文

## 变更

影响同时设置了 `sessionHomeRoot` 与 `sessionSshHost` 的企微 bot；单工作区 bot 不受影响。

- 容器内的建号脚本 `dsh-session-user` 原先按 `dsh-session-user <登录名> <家目录>` 调用，并把每个家目录放进写死的 `dsh-admin` 组，再让 `agent` 登录入组。现在按 `dsh-session-user <登录名> <家目录> <部署登录>` 调用：插件从 `sessionSshHost` 的有效连接中读出部署登录，每个家目录的属组改为该登录自己的主组，权限 750。容器里若还是旧脚本，不会报错，但会忽略第三个参数，新建的家目录仍是 `dsh-admin` 组。
- `wecom` 条目下的 `sessionHelper` 与 `sessionHelperHash` 两个键被删除。它们配置的是插件已不再挂载的按会话 ssh 提供者；`cordis.yml` 里残留的值会被忽略。
- 会话登录名的入站附件原先存到 `inboundDir`，即挂进容器的宿主目录。现在存到 `<家目录>/inbox/`，归 root 所有、权限 755 与 644，会话能读但不能修改。`inboundDir` 与 `inboundHostDir` 只对单工作区 bot 生效。

## 迁移

1. 以 root 把包里自带的建号脚本装进每个 bot 的容器：`install -m 755 assets/dsh-session-user.sh /usr/local/sbin/dsh-session-user`（该文件在 profile 的 `node_modules/@jabberwocky238/dsh-wecom/assets/dsh-session-user.sh`）。
2. 从 `cordis.yml` 的 `wecom` 条目里删掉 `sessionHelper` 与 `sessionHelperHash`。
3. 会话级 bot 可以去掉容器的 `inboundDir` 挂载和 `inboundHostDir`（可选）；已经在那里的文件仍可读，但不会再出现在提示里。
4. 确认：重启 bot，给它发一个文件，检查提示里给出的是 `/home/u_…/inbox/<文件名>`，并在容器里用 `ls -ld /home/u_…` 确认家目录属组是部署登录的组。
