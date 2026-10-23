#!/usr/bin/env bash
# Eenmalig (herhaalbaar): systemd-timer die elke 5 minuten scripts/auto-update.sh draait.
#   sudo /home/administrator/mimir-tunnel/scripts/install-auto-update.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "FOUT: draai dit script met sudo." >&2; exit 1; }

SRC="$(realpath "$(dirname "$0")/..")"
NAME=mimir-tunnel-autoupdate

cat > "/etc/systemd/system/$NAME.service" <<UNIT
[Unit]
Description=Mimir-Tunnel: update.sh bij nieuwe commit op origin/master
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=MIMIR_SRC=$SRC
ExecStart=/bin/bash $SRC/scripts/auto-update.sh
UNIT

cat > "/etc/systemd/system/$NAME.timer" <<UNIT
[Unit]
Description=Mimir-Tunnel elke 5 minuten op updates controleren

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now "$NAME.timer"
systemctl list-timers "$NAME.timer" --no-pager
