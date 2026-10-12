#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo "Run this installer with sudo." >&2; exit 1; fi
node_major="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 24 ]]; then echo "Node.js 24 or newer is required." >&2; exit 1; fi
command -v docker >/dev/null || { echo "Docker with Compose is required." >&2; exit 1; }
command -v flock >/dev/null || { echo "util-linux flock is required." >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -m 0755 /usr/lib/yawf-server-updater /usr/local/sbin
install -m 0755 "$root/yawf-server-update.mjs" /usr/lib/yawf-server-updater/yawf-server-update.mjs
install -m 0755 "$root/yawf-server-update" /usr/local/sbin/yawf-server-update
install -m 0644 "$root/volume-copy.mjs" /usr/lib/yawf-server-updater/volume-copy.mjs
install -m 0644 "$root/yawf-server-update.service" /etc/systemd/system/yawf-server-update.service
install -m 0644 "$root/yawf-server-update.timer" /etc/systemd/system/yawf-server-update.timer
systemctl daemon-reload
echo "Installed disabled. Register a root-owned Compose deployment explicitly:"
echo "  sudo yawf-server-update register /absolute/path/docker-compose.ghcr.yml"
echo "  sudo yawf-server-update enable"
