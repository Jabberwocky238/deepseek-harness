#!/bin/bash
# 为一个 DSH 会话准备普通 Linux 用户：家目录 + 登录公钥。以 root 运行。
# 用法: dsh-session-user <session-id> <login-prefix> <home-root> <admin-login> [pubkey 文件...]   （不给文件则从 stdin 读公钥）
# 输出最后一行: ready <login> <home>
#
# 登录名 = 前缀 + 四位序号（qingang0001），序号在本容器内按已有同前缀登录名的最大值加 1 分配。
# 会话 id 记在该用户 passwd 的注释字段里：同一会话再来时按它找回原登录名，所以重启、续接都不变。
set -eu
usage='用法: dsh-session-user <session-id> <login-prefix> <home-root> <admin-login> [pubkey...]'
session="${1:?$usage}"
prefix="${2:?$usage}"
root="${3:?$usage}"
admin="${4:?$usage}"
shift 4

# 注释字段不能含 ':' 或 ','；登录名总长不超过 32。
case "$session" in *[!A-Za-z0-9_.-]*) echo "dsh-session-user: 会话 id 含非法字符: $session" >&2; exit 2 ;; esac
if ! printf '%s' "$prefix" | grep -Eq '^[a-z_][a-z0-9_-]{0,27}$'; then
  echo "dsh-session-user: 登录名前缀不合法: $prefix" >&2; exit 2
fi
case "$root" in /*) ;; *) echo "dsh-session-user: 家目录根必须是绝对路径: $root" >&2; exit 2 ;; esac
if ! id -u "$admin" >/dev/null 2>&1; then
  echo "dsh-session-user: 管理登录 $admin 在容器里不存在" >&2
  exit 1
fi

# 分配序号要串行：两个会话同时建号时不能拿到同一个号。
exec 9>/run/dsh-session-user.lock
flock 9

user="$(getent passwd | awk -F: -v s="$session" '$5 == s { print $1; exit }')"
if [ -z "$user" ]; then
  last="$(getent passwd | awk -F: -v p="$prefix" '
    index($1, p) == 1 && substr($1, length(p) + 1) ~ /^[0-9][0-9][0-9][0-9]$/ {
      n = substr($1, length(p) + 1) + 0; if (n > m) m = n
    }
    END { print m + 0 }')"
  next=$((last + 1))
  if [ "$next" -gt 9999 ]; then echo "dsh-session-user: 前缀 $prefix 的序号已用尽" >&2; exit 1; fi
  user="$(printf '%s%04d' "$prefix" "$next")"
  useradd --create-home --home-dir "$root/$user" --shell /bin/bash --comment "$session" "$user"
fi
home="$(getent passwd "$user" | cut -d: -f6)"

# UsePAM no 时，sshd 把 shadow 里的 "!"（无密码）当成锁定账号直接拒。镜像里的登录用户
# 密码字段是空的，这里照做：清空密码即可登录（PermitEmptyPasswords 默认 no，仍只能走公钥）。
if [ "$(awk -F: -v u="$user" '$1 == u { print $2 }' /etc/shadow)" != "" ]; then
  passwd -d "$user" >/dev/null
fi
# 会话的命令以会话自己的登录执行；管理登录只需穿过家目录（profile 级的
# working-directory / agent-instructions 用管理连接），写 inbox 走 sudo。家目录不能组可写：
# sshd 的 StrictModes 会因此拒绝其中的 authorized_keys。共享组取管理登录自己的主组 ——
# 不另造组名，也不猜它的名字：该组里只有管理登录，其它会话用户各自成组、不在其中。
chgrp "$(id -gn "$admin")" "$home"
chmod 750 "$home"

install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
if [ "$#" -gt 0 ]; then cat "$@"; else cat; fi >"$home/.ssh/authorized_keys"
chown "$user:$user" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
echo "ready $user $home"
