#!/usr/bin/env bash
set -euo pipefail
version="${1:?usage: build_server_updater_bundle.sh <version>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid updater version." >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/yawf-server-updater_${version}"
install -d "$bundle"
install -m 0755 "$root/deploy/updater/yawf-server-update.mjs" "$bundle/"
install -m 0755 "$root/deploy/updater/yawf-server-update" "$bundle/"
install -m 0644 "$root/deploy/updater/volume-copy.mjs" "$bundle/"
install -m 0755 "$root/deploy/updater/install.sh" "$bundle/"
install -m 0644 "$root/deploy/updater/yawf-server-update.service" "$bundle/"
install -m 0644 "$root/deploy/updater/yawf-server-update.timer" "$bundle/"
install -m 0644 "$root/deploy/updater/README.md" "$bundle/"
install -d "$root/dist-deb"
tar -C "$stage" --owner=0 --group=0 -czf "$root/dist-deb/yawf-server-updater_${version}.tar.gz" "yawf-server-updater_${version}"
echo "Built dist-deb/yawf-server-updater_${version}.tar.gz"
