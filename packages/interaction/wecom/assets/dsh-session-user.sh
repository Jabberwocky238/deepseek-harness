#!/bin/bash
# 为一个 DSH 会话准备普通 Linux 用户：家目录 + 登录公钥。以 root 运行。
# 用法: dsh-session-user <user> <home> [pubkey 文件...]   （不给文件则从 stdin 读公钥）
set -eu
user="${1:?用法: dsh-session-user <user> <home> [pubkey...]}"
home="${2:?用法: dsh-session-user <user> <home> [pubkey...]}"
shift 2

if ! id -u "$user" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$home" --shell /bin/bash "$user"
fi
# UsePAM no 时，sshd 把 shadow 里的 "!"（无密码）当成锁定账号直接拒。镜像里的 agent 用户
# 密码字段是空的，这里照做：清空密码即可登录（PermitEmptyPasswords 默认 no，仍只能走公钥）。
if [ "$(awk -F: -v u="$user" '$1 == u { print $2 }' /etc/shadow)" != "" ]; then
  passwd -d "$user" >/dev/null
fi
# 管理连接（agent）要能穿过会话家目录（working-directory / agent-instructions 属 profile 级，
# 用的是管理连接）。共享组仅在容器内，其它会话用户不在组里，隔离不受影响。
groupadd -f dsh-admin
id -nG agent | grep -qw dsh-admin || usermod -aG dsh-admin agent
chgrp dsh-admin "$home"
chmod 750 "$home"

install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
if [ "$#" -gt 0 ]; then cat "$@"; else cat; fi >"$home/.ssh/authorized_keys"
chown "$user:$user" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
echo "ready $user $home"
