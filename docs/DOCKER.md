# Docker Server Setup

Use Docker when DebridStreamer should run on a NAS, home server, Raspberry Pi,
VPS, or other always-on device.

## Image

CI publishes multi-arch images to GHCR for:

- `linux/amd64`
- `linux/arm64`

```text
ghcr.io/tgk-30/yawf-stream:latest
```

Tags are created from `main` and Git tags by `.github/workflows/docker-image.yml`.

To pin the Server Mode UI and API to this server release, use
`ghcr.io/tgk-30/yawf-stream:2.3.8`. The server release updates the Docker `latest`
tag independently of the multi-platform desktop release.

## Quick Start

```sh
cd deploy/compose
cp .env.example .env
openssl rand -base64 32
```

Paste the generated value into `DS_SERVER_SECRET_KEY` in `.env`.

If the server will be reachable from another device before you create the owner
account, also set `DS_SERVER_SETUP_TOKEN`:

```sh
openssl rand -base64 24
```

Paste that value into `.env`, then start:

```sh
docker compose up -d --build
```

Open:

```text
http://localhost:43110
```

Create the owner account on first launch. If `DS_SERVER_SETUP_TOKEN` is set,
paste the same token into the setup form.

## Use Published Image

The default compose file builds locally from the repo. To pull GHCR instead,
replace the service `build:` block with:

```yaml
image: ghcr.io/tgk-30/yawf-stream:latest
```

Then run:

```sh
docker compose pull
docker compose up -d
```

## Persistent Data

The container stores SQLite data and the generated server key under `/data`.
The compose file mounts that path as `debridstreamer-data`.

Back up both:

- the SQLite files in `/data`
- `server.key`, unless you provide `DS_SERVER_SECRET_KEY`

Without the same secret key, encrypted credentials cannot be decrypted after a
restore.

## Network Access

Recommended private access paths:

- LAN-only: `http://server-ip:43110`
- Tailscale: `http://machine-name:43110`
- Cloudflare Tunnel or reverse proxy: terminate HTTPS before forwarding to
  `43110`

When exposing through HTTPS, set:

```env
DS_SERVER_COOKIE_SECURE=true
DS_SERVER_TRUST_PROXY=true
```

For an internet-facing deployment, start the included hardened Caddy profile:

```sh
cd deploy/compose
cp .env.example .env
# Set YAWF_DOMAIN and DS_SERVER_SECRET_KEY.
docker compose -f docker-compose.caddy.yml up -d
docker compose -f docker-compose.caddy.yml logs debridstreamer
```

Caddy obtains and renews HTTPS certificates, and this profile does not publish
port `43110`. The log command shows the one-time setup token on a fresh server.
See [`deploy/compose/README.md`](../deploy/compose/README.md) for all public-mode
security settings.

When Cloudflare Access protects the site, add a bypass policy only for
`/api/external-stream/*`. External media players cannot send Access browser
cookies. This path still requires YAWF Stream's short-lived, stream-scoped
capability and remains subject to profile and session revocation.

Use DebridStreamer profiles even when Cloudflare Access or Tailscale protects
the outer network. Those layers are additional protection, not a replacement for
per-profile history, credentials, and session boundaries.

## Updates

For local builds:

```sh
git pull
docker compose up -d --build
```

For GHCR images:

```sh
docker compose pull
docker compose up -d
```

Publishing an image does not update an existing running container. Pull and
recreate it using the commands above, preserving the data volume and server
secret, then reload the app once online so open clients load the new UI.
Do not remove the data volume during an update.
