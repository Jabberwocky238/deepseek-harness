---
kind: upgrade-guide
description: "A conversation-scoped WeCom bot now runs each conversation as its own login named by a configured prefix and sequence number, its provisioner takes new arguments, three session config keys are removed or added, and inbound attachments move to each conversation's home."
---

# WeCom conversation logins: own execution login, provisioner arguments, config keys, inbox location

English | [中文](guide.zh.md)

## Change

This affects WeCom bots that set `sessionHomeRoot` and `sessionSshHost`; single-workspace bots are unaffected.

- Each conversation's Agent ran its commands and file operations as the deployment login. It now runs them as the conversation's own login: the plugin binds the Agent to that login through `ctx.ssh.bindLogin`, which requires the `ssh` service of `@jabberwocky238/dsh-ssh`.
- Conversation logins were `u_<kind>_<hash>`, derived on the host. They are now `<sessionLoginPrefix><nnnn>`, such as `qingang0001`, allocated in the container; the login's passwd comment field holds the Session id.
- The provisioner `dsh-session-user` was called as `dsh-session-user <login> <home>`. It is now called as `dsh-session-user <session-id> <login-prefix> <home-root> <deployment-login>` and prints `ready <login> <home>`; each home gets the deployment login's primary group at mode 770.
- `sessionLoginPrefix` is new and required with `sessionHomeRoot`. `sessionSshConfig`, `sessionHelper` and `sessionHelperHash` are removed, and the plugin no longer writes per-conversation OpenSSH aliases; a value left in `cordis.yml` is ignored.
- Inbound attachments of a conversation login went to `inboundDir`. They now go to `<home>/inbox/`, root-owned at modes 755 and 644.

## Migration

1. Install the provisioner from the package into each bot's container, as root: `install -m 755 assets/dsh-session-user.sh /usr/local/sbin/dsh-session-user`.
2. Admit the new logins to the container's sshd, for example `AllowUsers agent qingang????`, then reload sshd.
3. In `cordis.yml`, set `sessionLoginPrefix` on the `wecom` row, delete the removed keys, and name the `ssh` row `@jabberwocky238/dsh-ssh` with the same `host` as `sessionSshHost`.
4. Rename each existing conversation login before restarting: `usermod -l <new> -d <home-root>/<new> -m -c <session-id> <old>` and `groupmod -n <new> <old>`, numbering from 0001 per prefix. Then rewrite `cwd` in each such Session's log header to the new home and move its log directory to the one that cwd encodes; otherwise the resumed Session works in the old path.
5. Confirm: restart the bot, ask it to run `id` and to create a file in its working directory, and check that both report the conversation's own login.
