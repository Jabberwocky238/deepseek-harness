#!/bin/bash
# 为一个 DSH 会话准备普通 Linux 用户：家目录 + 登录公钥。以 root 运行。
# 用法: dsh-session-user <user> <home> <admin-login> [pubkey 文件...]   （不给文件则从 stdin 读公钥）
set -eu
usage='用法: dsh-session-user <user> <home> <admin-login> [pubkey...]'
user="${1:?$usage}"
home="${2:?$usage}"
admin="${3:?$usage}"
shift 3

if ! id -u "$user" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$home" --shell /bin/bash "$user"
fi
# UsePAM no 时，sshd 把 shadow 里的 "!"（无密码）当成锁定账号直接拒。镜像里的登录用户
# 密码字段是空的，这里照做：清空密码即可登录（PermitEmptyPasswords 默认 no，仍只能走公钥）。
if [ "$(awk -F: -v u="$user" '$1 == u { print $2 }' /etc/shadow)" != "" ]; then
  passwd -d "$user" >/dev/null
fi
# 管理连接要能穿过会话家目录（working-directory / agent-instructions 属 profile 级，用的是管理连接）。
# 共享组取管理登录自己的主组 —— 不另造组名，也不猜它的名字：该组里只有管理登录，
# 其它会话用户各自成组、不在其中，所以隔离不受影响。
if ! id -u "$admin" >/dev/null 2>&1; then
  echo "dsh-session-user: 管理登录 $admin 在容器里不存在" >&2
  exit 1
fi
chgrp "$(id -gn "$admin")" "$home"
chmod 750 "$home"

install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
if [ "$#" -gt 0 ]; then cat "$@"; else cat; fi >"$home/.ssh/authorized_keys"
chown "$user:$user" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
echo "ready $user $home"
