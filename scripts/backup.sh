#!/usr/bin/env bash
# Encrypted backup of the bot's state (data/) and env files.
# Encrypts to an age public key, so this machine can write backups but cannot read them;
# the matching private key lives off the server and is only needed to restore.
#   TREERING_BACKUP_PUBKEY   file with the age recipient (default ~/.config/treering/backup.pub)
#   TREERING_BACKUP_DIR      local archive dir (default ~/backups/treering), keeps the newest TREERING_BACKUP_KEEP (14)
#   TREERING_BACKUP_REMOTE   optional rclone destination, e.g. "b2:my-bucket/treering"
# Restore: age -d -i backup-identity.txt treering-*.tar.age | tar -xz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUB="${TREERING_BACKUP_PUBKEY:-$HOME/.config/treering/backup.pub}"
DIR="${TREERING_BACKUP_DIR:-$HOME/backups/treering}"
KEEP="${TREERING_BACKUP_KEEP:-14}"
[ -s "$PUB" ] || { echo "no age public key at $PUB" >&2; exit 1; }
umask 077
mkdir -p "$DIR"
out="$DIR/treering-$(date -u +%Y%m%d-%H%M).tar.age"
files=(data)
for f in .env.agent .env.alerts config.json; do [ -e "$ROOT/$f" ] && files+=("$f"); done
tar -C "$ROOT" -cz "${files[@]}" | age -R "$PUB" -o "$out.tmp"
mv "$out.tmp" "$out"
ls -1t "$DIR"/treering-*.tar.age | tail -n +"$((KEEP + 1))" | xargs -r rm --
if [ -n "${TREERING_BACKUP_REMOTE:-}" ]; then
  rclone copy "$out" "$TREERING_BACKUP_REMOTE" --no-traverse
fi
echo "wrote $out ($(du -h "$out" | cut -f1))"
