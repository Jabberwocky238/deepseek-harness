---
kind: upgrade-guide
description: "A conversation-scoped WeCom bot's provisioner takes the deployment login as a third argument, two session config keys are removed, and inbound attachments move to each conversation's home."
---

# WeCom conversation logins: provisioner argument, removed keys, inbox location

English | [中文](guide.zh.md)

## Change

This affects WeCom bots that set `sessionHomeRoot` and `sessionSshHost`; single-workspace bots are unaffected.

- The container-side provisioner `dsh-session-user` was called as `dsh-session-user <login> <home>` and put every home in a hard-coded `dsh-admin` group joined by the `agent` login. It is now called as `dsh-session-user <login> <home> <deployment-login>`, where the plugin reads the deployment login from the effective connection of `sessionSshHost`, and each home gets that login's own primary group at mode 750. An old script installed in the container rejects nothing but ignores the third argument, so new homes keep the `dsh-admin` group.
- The `sessionHelper` and `sessionHelperHash` keys under the `wecom` row are removed. They configured per-conversation ssh providers the plugin no longer mounts; a value left in `cordis.yml` is ignored.
- Inbound attachments of a conversation login went to `inboundDir`, a host directory bound into the container. They now go to `<home>/inbox/`, root-owned at modes 755 and 644, so the conversation reads but cannot change them. `inboundDir` and `inboundHostDir` apply only to single-workspace bots.

## Migration

1. Install the provisioner shipped in the package into each bot's container, as root: `install -m 755 assets/dsh-session-user.sh /usr/local/sbin/dsh-session-user` (the file is `node_modules/@jabberwocky238/dsh-wecom/assets/dsh-session-user.sh` in the profile).
2. Delete `sessionHelper` and `sessionHelperHash` from the `wecom` row in `cordis.yml`.
3. Optionally drop the container's `inboundDir` mount and `inboundHostDir` for conversation-scoped bots; files already there stay readable but are no longer named in prompts.
4. Confirm: restart the bot, send it a file, and check that the prompt names `/home/u_…/inbox/<name>` and that `ls -ld /home/u_…` inside the container shows the deployment login's group.
