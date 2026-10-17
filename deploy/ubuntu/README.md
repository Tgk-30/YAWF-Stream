# Run DebridStreamer on an Ubuntu server

Three supported ways to run the self-host server on Ubuntu (22.04 / 24.04, amd64
or arm64). Docker is the easiest; the native and `.deb` paths are for hosts that
prefer not to run Docker.

All three serve the web app **and** API on one port (default `43110`) and keep
state in a single SQLite database, so any device on your network - or a phone via
the PWA - can connect to the same server.

---

## Option A - Docker Compose, prebuilt image (recommended)

No source build: pulls the multi-arch image published to GitHub Container
Registry (`ghcr.io/tgk-30/yawf-stream:latest`, built for linux/amd64 +
linux/arm64 on every release).

```bash
# 1. Install Docker Engine + the compose plugin (official convenience script).
curl -fsSL https://get.docker.com | sh

# 2. Fetch the compose file and an env template into an empty directory.
mkdir -p ~/debridstreamer && cd ~/debridstreamer
curl -fsSLO https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/main/deploy/compose/docker-compose.ghcr.yml
curl -fsSL  https://raw.githubusercontent.com/Tgk-30/YAWF-Stream/main/deploy/compose/.env.example -o .env

# 3. Set at least DS_SERVER_SECRET_KEY (and DS_SERVER_SETUP_TOKEN) in .env:
#    openssl rand -base64 32   # -> DS_SERVER_SECRET_KEY
#    openssl rand -base64 24   # -> DS_SERVER_SETUP_TOKEN
nano .env

# 4. Start it.
docker compose -f docker-compose.ghcr.yml up -d
```

Update to the latest published build:

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

For opt-in unattended stable updates, use the separately published
`yawf-server-updater_X.Y.Z.tar.gz` host bundle. It registers this exact Compose
service, pins immutable release digests, snapshots the stopped named data
volume and opaque `.env`, and rolls both back on failure. See
[`../updater/README.md`](../updater/README.md). It is disabled until the host
operator runs `sudo yawf-server-update enable`; the application never receives
the Docker socket.

To build the image from source instead of pulling it, use
`deploy/compose/docker-compose.yml` (`docker compose up -d --build`).

---

## Option B - Native Node + systemd (no Docker)

For a lightweight VPS. Requires **Node.js 24+** (the server bundle targets
`node24` and uses the built-in `node:sqlite`).

```bash
# 1. Install Node 24 (NodeSource).
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Get the source and build the server + web app.
sudo git clone https://github.com/Tgk-30/YAWF-Stream /opt/debridstreamer-src
cd /opt/debridstreamer-src
( cd web && npm ci && npm run build )
( cd server && npm ci && npm run build )

# 3. Lay out the runtime files where the unit expects them.
sudo mkdir -p /opt/debridstreamer/server /opt/debridstreamer/web-dist
sudo cp -r server/dist /opt/debridstreamer/server/dist
sudo cp -r web/dist/*  /opt/debridstreamer/web-dist/

# 4. Create the service user, data dir, and env file.
sudo useradd --system --home /var/lib/debridstreamer --shell /usr/sbin/nologin debridstreamer || true
sudo mkdir -p /var/lib/debridstreamer /etc/debridstreamer
sudo chown -R debridstreamer:debridstreamer /var/lib/debridstreamer
sudo cp deploy/compose/.env.example /etc/debridstreamer/debridstreamer.env
sudo nano /etc/debridstreamer/debridstreamer.env   # set DS_SERVER_SECRET_KEY etc.

# 5. Install + start the service.
sudo cp deploy/systemd/debridstreamer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now debridstreamer
sudo systemctl status debridstreamer
```

`deploy/ubuntu/install.sh` runs steps 2–5 for you (see the script header).

The server now listens on `http://<server-ip>:43110`. Put a reverse proxy
(Caddy, nginx, or a Cloudflare/Tailscale tunnel) in front for HTTPS and set
`DS_SERVER_COOKIE_SECURE=true`, `DS_SERVER_TRUST_PROXY=true` in the env file.

---

## Option C - Debian/Ubuntu package (`.deb`)

Each tagged release attaches `debridstreamer-server_all.deb` (Architecture:
`all` - the server is a Node bundle + static assets, so one package runs on
amd64 and arm64). It installs the built server + web app to
`/opt/debridstreamer`, drops the env file at
`/etc/debridstreamer/debridstreamer.env`, and registers the systemd service.

```bash
# Requires Node.js 24+ (see Option B step 1 for NodeSource) - the package
# depends on `nodejs (>= 24)`.
curl -fsSLO https://github.com/Tgk-30/YAWF-Stream/releases/download/v2.3.8/debridstreamer-server_2.3.8_all.deb
sudo apt-get install -y ./debridstreamer-server_2.3.8_all.deb

# Set the secret key, then start.
sudo nano /etc/debridstreamer/debridstreamer.env
sudo systemctl enable --now debridstreamer
```

Upgrade by installing a newer `.deb`; your `/etc/debridstreamer/debridstreamer.env`
and `/var/lib/debridstreamer` data are preserved. After installation, restart the
existing service and reload the app once online to load the updated Server Mode UI:

```sh
sudo systemctl restart debridstreamer
```

Server-only releases use explicit versioned downloads. GitHub
`releases/latest` remains reserved for the multi-platform desktop release, so it
can contain an older server package.

Automatic installation currently supports the published Docker Compose path.
Native systemd and `.deb` operators continue to install a newer package
manually; Settings reports that distinction instead of presenting desktop OTA
controls as a server updater.

---

## First run

Open `http://<server-ip>:43110` and complete the owner setup (paste the
`DS_SERVER_SETUP_TOKEN` if you set one), then add your TMDB + debrid keys under
Settings. Invite household profiles from Settings → Server. See the in-app
"Getting started" guide any time from ⌘K → *Show welcome tour*.
