#!/usr/bin/env bash
# Build a Debian/Ubuntu package for the DebridStreamer self-host server.
#
#   scripts/build_deb.sh <version>
#
# The server ships as a Node bundle (server/dist/index.cjs) plus the static web
# app (web/dist) - no native code - so the package is Architecture: all: one
# .deb runs on amd64 and arm64 alike (it depends on Node.js and FFmpeg). Run
# `(cd web && npm ci && npm run build)` and `(cd server && npm ci && npm run
# build)` first; this script only packages the already-built output. Needs
# dpkg-deb (present on Ubuntu / any Debian host and CI runner).
set -euo pipefail

VERSION="${1:?usage: build_deb.sh <version>}"
PKG="debridstreamer-server"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -f "${ROOT}/server/dist/index.cjs" ] || { echo "server/dist/index.cjs missing - run the server build first." >&2; exit 1; }
[ -d "${ROOT}/web/dist" ] || { echo "web/dist missing - run the web build first." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

# ── filesystem layout ────────────────────────────────────────────────────────
install -d "${STAGE}/DEBIAN"
install -d "${STAGE}/opt/debridstreamer/server"
install -d "${STAGE}/opt/debridstreamer/web-dist"
install -d "${STAGE}/etc/debridstreamer"
install -d "${STAGE}/lib/systemd/system"

cp -r "${ROOT}/server/dist" "${STAGE}/opt/debridstreamer/server/dist"
cp -r "${ROOT}/web/dist/." "${STAGE}/opt/debridstreamer/web-dist/"
cp "${ROOT}/deploy/systemd/debridstreamer.service" "${STAGE}/lib/systemd/system/debridstreamer.service"
cp "${ROOT}/deploy/compose/.env.example" "${STAGE}/etc/debridstreamer/debridstreamer.env"
chmod 600 "${STAGE}/etc/debridstreamer/debridstreamer.env"

# ── control metadata ─────────────────────────────────────────────────────────
INSTALLED_KB="$(du -sk "${STAGE}/opt" "${STAGE}/etc" "${STAGE}/lib" | awk '{s+=$1} END {print s}')"
cat > "${STAGE}/DEBIAN/control" <<EOF
Package: ${PKG}
Version: ${VERSION}
Architecture: all
Maintainer: DebridStreamer <noreply@users.noreply.github.com>
Depends: nodejs (>= 24), ffmpeg
Section: web
Priority: optional
Installed-Size: ${INSTALLED_KB}
Homepage: https://github.com/Tgk-30/YAWF-Stream
Description: DebridStreamer self-host server
 Self-hosted debrid streaming server: serves the built web app and JSON API on
 one port (default 43110) with multi-profile households, storing state in
 SQLite. Ships as a Node bundle plus static assets; requires Node.js 24+.
EOF

# Preserve the admin's env file across upgrades.
echo "/etc/debridstreamer/debridstreamer.env" > "${STAGE}/DEBIAN/conffiles"

cat > "${STAGE}/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if ! id -u debridstreamer >/dev/null 2>&1; then
  useradd --system --home /var/lib/debridstreamer --shell /usr/sbin/nologin debridstreamer
fi
mkdir -p /var/lib/debridstreamer
chown -R debridstreamer:debridstreamer /var/lib/debridstreamer
# Seed a strong secret key on first install so a boot is never insecure-by-default.
if ! grep -q '^DS_SERVER_SECRET_KEY=..*' /etc/debridstreamer/debridstreamer.env 2>/dev/null; then
  KEY="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  sed -i "s#^DS_SERVER_SECRET_KEY=.*#DS_SERVER_SECRET_KEY=${KEY}#" /etc/debridstreamer/debridstreamer.env || true
fi
chmod 600 /etc/debridstreamer/debridstreamer.env || true
systemctl daemon-reload || true
systemctl enable debridstreamer >/dev/null 2>&1 || true
echo "DebridStreamer installed. Review /etc/debridstreamer/debridstreamer.env, then:"
echo "  sudo systemctl start debridstreamer   # http://<server-ip>:43110"
EOF

cat > "${STAGE}/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  systemctl stop debridstreamer >/dev/null 2>&1 || true
  systemctl disable debridstreamer >/dev/null 2>&1 || true
fi
EOF

cat > "${STAGE}/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
systemctl daemon-reload || true
EOF

chmod 0755 "${STAGE}/DEBIAN/postinst" "${STAGE}/DEBIAN/prerm" "${STAGE}/DEBIAN/postrm"

# ── build ────────────────────────────────────────────────────────────────────
OUT="${ROOT}/dist-deb"
install -d "${OUT}"
DEB="${OUT}/${PKG}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "${STAGE}" "${DEB}"
echo "Built ${DEB}"

# The Docker host updater is a separate, default-off host artifact. Building it
# beside the deb keeps release checksums and publication on one server channel
# without granting the application container any host privilege.
bash "${ROOT}/scripts/build_server_updater_bundle.sh" "${VERSION}"
