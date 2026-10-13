---
kind: upgrade-guide
description: "按会话建号的企微 bot 现在让每个会话以自己的登录名执行，登录名由配置的前缀加序号构成；建号脚本参数变了；会话相关配置键有增删；入站附件改存到各会话的家目录。"
---

# 企微会话登录：独立执行身份、建号脚本参数、配置键、inbox 位置

[English](guide.md) | 中文

## 变更

影响配置了 `sessionHomeRoot` 与 `sessionSshHost` 的企微 bot；单工作区 bot 不受影响。

- 每个会话的 Agent 原先以部署登录执行命令和文件操作，现在以该会话自己的登录名执行：插件通过 `ctx.ssh.bindLogin` 把 Agent 绑定到它的登录名，这需要 `@jabberwocky238/dsh-ssh` 提供的 `ssh` 服务。
- 会话登录名原先是在宿主侧推算的 `u_<类型>_<哈希>`，现在是在容器里分配的 `<sessionLoginPrefix><nnnn>`，例如 `qingang0001`；该登录名 passwd 的注释字段记着 Session id。
- 建号脚本 `dsh-session-user` 原先按 `dsh-session-user <登录名> <家目录>` 调用，现在按 `dsh-session-user <会话 id> <登录名前缀> <家目录根> <部署登录>` 调用，并输出 `ready <登录名> <家目录>`；每个家目录的属组是部署登录的主组，权限 750。
- 新增 `sessionLoginPrefix`，与 `sessionHomeRoot` 一起必填。删除 `sessionSshConfig`、`sessionHelper` 与 `sessionHelperHash`，插件也不再生成按会话的 OpenSSH 别名；`cordis.yml` 里残留的值会被忽略。
- 会话登录的入站附件原先写到 `inboundDir`，现在写到 `<home>/inbox/`，归 root 所有、权限 755 与 644。

## 迁移

1. 以 root 把包里的建号脚本装进每个 bot 的容器：`install -m 755 assets/dsh-session-user.sh /usr/local/sbin/dsh-session-user`。
2. 让容器的 sshd 接纳新登录名，例如 `AllowUsers agent qingang????`，然后重载 sshd。
3. 在 `cordis.yml` 的 `wecom` 行设置 `sessionLoginPrefix`，删掉已移除的键，并把 `ssh` 行的名称改为 `@jabberwocky238/dsh-ssh`，其 `host` 与 `sessionSshHost` 相同。
4. 重启之前先给每个已有会话登录改名：`usermod -l <新名> -d <家目录根>/<新名> -m -c <会话 id> <旧名>` 以及 `groupmod -n <新名> <旧名>`，每个前缀从 0001 开始编号。再把这些 Session 日志头里的 `cwd` 改成新家目录，并把日志目录挪到该 cwd 编码出的目录下；否则续接后的 Session 仍在旧路径工作。
5. 确认：重启 bot，让它执行 `id` 并在工作目录里建一个文件，确认两者都显示该会话自己的登录名。
