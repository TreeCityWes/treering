# Run Treering as a hardened system service

The simple install (`deploy/treering.service`) runs the bot as you, from your checkout. That is fine on a
machine only you use. On a shared server, or one where AI agents or other software run under your login,
anything running as you can read the trading key and change the bot's code.

This layout closes that gap:

| What | Where | Who can touch it |
|---|---|---|
| Code | `/opt/treering` | root only (changed with `sudo treering-deploy`) |
| Secrets | `/etc/treering/agent.env`, `alerts.env` | root only, mode 0600; systemd hands them to the bot |
| Settings | `/etc/treering/config.json` (optional) | root writes, anyone reads |
| State, history | `/var/lib/treering` | the `treering` user, and operators in the `treering` group |
| Backups | `/var/backups/treering` | root only |

The bot itself runs as the unprivileged `treering` user with a read-only filesystem apart from its state directory.

## Install (as root)

```sh
useradd --system --home-dir /var/lib/treering --shell /usr/sbin/nologin treering
install -d -o treering -g treering -m 2770 /var/lib/treering
install -d -m 0755 /etc/treering && install -d -m 0700 /var/backups/treering
usermod -aG treering,systemd-journal <you>          # log in again for it to take effect

# Secrets: KEY=value lines, no quotes, no spaces around "="
install -m 0600 /dev/null /etc/treering/agent.env    # X1_ACCOUNT_ADDRESS, X1_AGENT_PRIVATE_KEY, X1_NETWORK
install -m 0600 /dev/null /etc/treering/alerts.env   # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional)

git clone https://github.com/TreeCityWes/treering /opt/treering
cd /opt/treering && npm ci --omit=dev --ignore-scripts
install -m 0755 deploy/system/treering /usr/local/bin/treering
install -m 0755 deploy/system/treering-deploy /usr/local/sbin/treering-deploy
install -m 0644 deploy/system/*.service deploy/system/*.timer /etc/systemd/system/
visudo -cf deploy/system/sudoers-treering && install -m 0440 deploy/system/sudoers-treering /etc/sudoers.d/treering
systemctl daemon-reload
systemctl enable --now treering.service treering-watchdog.timer treering-backup.timer
```

Backups need an [age](https://age-encryption.org) public key at `/etc/treering/backup.pub`; keep the private key off the server.
For an offsite copy put `TREERING_BACKUP_REMOTE=<rclone destination>` in `/etc/treering/backup.env`.

## Day to day

```sh
treering tui            # dashboard
treering status         # or: pnl, pause, resume, live on|off, flatten, logs -f
treering restart        # no password
sudo treering-deploy    # pull origin/main, run the tests, restart between cycles
```
