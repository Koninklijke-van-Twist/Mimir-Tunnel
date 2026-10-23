#!/usr/bin/env bash
# Draait update.sh als origin/master een nieuwe commit heeft. Voor de systemd-timer (root).
set -euo pipefail

SRC="${MIMIR_SRC:-/home/administrator/mimir-tunnel}"
BRANCH="${MIMIR_BRANCH:-master}"
GIT_USER="${MIMIR_GIT_USER:-$(stat -c '%U' "$SRC")}"

exec 9>/run/mimir-tunnel-autoupdate.lock
flock -n 9 || { echo "Vorige run loopt nog; overgeslagen."; exit 0; }

run_git() { sudo -u "$GIT_USER" -- git -C "$SRC" "$@"; }

run_git fetch --quiet --prune origin "$BRANCH"
head="$(run_git rev-parse HEAD)"
remote="$(run_git rev-parse "origin/$BRANCH")"
if [[ "$head" == "$remote" ]]; then
  exit 0
fi
echo "Nieuwe commit ${remote:0:7} (nu ${head:0:7}); update.sh $BRANCH starten."
exec "$SRC/scripts/update.sh" "$BRANCH"
