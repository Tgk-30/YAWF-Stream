# Self-Hosting Guide

Run your own DebridStreamer server so your household can stream from their own
devices, with separate histories, one shared set of provider credentials, and a
single debrid-facing IP address.

This guide is for a **technical-but-not-expert** self-hoster.

---

## What the server is

The server (the `server/` folder in the repo) is a small **Node.js + Fastify +
SQLite** backend. It:

- Serves the DebridStreamer web app (the same UI as the desktop app) so any
  browser or phone can open it.
- Handles **login, sessions, and household profiles**.
- Stores shared settings and **encrypted provider credentials**.
- Resolves debrid streams **server-side** and proxies the video to your devices,
  so providers see only the server's IP (see
  [Remote access](remote-access.md)).

You do **not** need a server to use DebridStreamer - a single user can run the
desktop app entirely on-device. A server is for sharing across people and
devices.

---

## Where you can run it

Pick whichever you already have running.

### 1. Always-on desktop (embedded server)

The desktop app (Mac / Windows / Linux) ships with the server bundled in. In the
app, go to **Settings → Install & setup → Host from this desktop**. The app
starts the server, shows you the local URL, a LAN address, a QR code for phones,
and copy/share controls.

Best for: "I already leave my Mac/PC on - let my family use it." No terminal
required.

### 2. Docker on a NAS or VPS

Run the published container on a Synology/QNAP/Unraid NAS, a Linux home server,
or a cloud VPS. This is the recommended always-on option.

```sh
cd deploy/compose
cp .env.example .env
openssl rand -base64 32       # copy the output...
# ...paste it into DS_SERVER_SECRET_KEY in .env
docker compose up -d --build
```

Then open `http://localhost:43110` (or `http://<server-ip>:43110`).

To use the prebuilt multi-arch image instead of building locally, replace the
service `build:` block in `docker-compose.yml` with:

```yaml
image: ghcr.io/tgk-30/yawf-stream:latest
```

See [`DOCKER.md`](DOCKER.md) for the full Docker reference.

For a public server with automatic HTTPS, use the included Caddy stack instead:

```sh
cd deploy/compose
cp .env.example .env
# Set YAWF_DOMAIN and DS_SERVER_SECRET_KEY in .env.
docker compose -f docker-compose.caddy.yml up -d
docker compose -f docker-compose.caddy.yml logs debridstreamer
```

The final command shows the one-time setup token for a fresh server. The Caddy
profile does not publish the application port directly.

### 3. Raspberry Pi

A Raspberry Pi (ARM64, e.g. Pi 4 / Pi 5 running 64-bit Raspberry Pi OS) works
the same way as Docker above - the container is published for `linux/arm64`, so
`docker compose up -d` pulls the right architecture automatically.

Best for: a cheap, low-power, always-on box for a small household.

---

## Running the server from source

If you're developing or running directly with Node instead of Docker:

```sh
cd server
npm install
npm run dev        # start with live reload (development)
```

For a production build:

```sh
npm run build      # compile
npm start          # run the compiled server
```

The server listens on `0.0.0.0:43110` by default. To also run the web app
against it during development:

```sh
cd web
VITE_DEBRIDSTREAMER_SERVER_URL=http://localhost:43110 npm run dev
# open http://127.0.0.1:5173
```

When you run the packaged container or the desktop-hosted server, the web app is
served from the **same** origin, so you just open the server URL directly.

---

## Configuration (environment variables)

All settings are optional - the defaults work for local use. Set them as
environment variables (or in your Docker `.env`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `43110` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DS_SERVER_DATA_DIR` | `./data` | Where the database and key live. |
| `DS_SERVER_DB_PATH` | `<dataDir>/debridstreamer.sqlite` | SQLite file path. |
| `DS_SERVER_SECRET_KEY` | generated into `data/server.key` | Encrypts stored credentials at rest. **Back this up.** |
| `DS_SERVER_COOKIE_SECURE` | on in production | Marks session cookies HTTPS-only. Set `true` behind HTTPS. |
| `DS_SERVER_COOKIE_SAMESITE` | `lax` | Cookie SameSite policy (`lax`, `strict`, `none`). |
| `DS_SERVER_SESSION_TTL_SECONDS` | 30 days | How long a sign-in lasts. |
| `DS_SERVER_BIND_SESSION_USER_AGENT` | `false` | Revoke a session if its browser or app User-Agent changes. Recommended for public deployments. |
| `DS_SERVER_TRUST_PROXY` | `false` | Set `true` behind a trusted reverse proxy / tunnel. |
| `DS_SERVER_PUBLIC_MODE` | `false` | Require passwords on every profile and show public deployment warnings. |
| `DS_SERVER_ALLOW_INSECURE_PUBLIC` | `false` | Explicitly acknowledge a public bind without secure proxy settings. Use only on a protected private network. |
| `DS_SERVER_UPDATE_CHECK` | `true` | Let admins see whether a newer published server version is available. |
| `DS_SERVER_CORS_ORIGIN` | unset | Comma-separated browser origins allowed to call the API with cookies. Usually leave blank when the server also serves the web app. |
| `DS_SERVER_ALLOW_RAW_STREAM_URLS` | off in production | Lets the server fetch raw upstream URLs, **including private/LAN/loopback addresses**. Keep **disabled** on any public deployment - see warning below. |
| `DS_SERVER_ENABLE_TRANSCODE` | `true` in official deployments, otherwise `false` | Enables FFmpeg HLS fallback for browser-incompatible streams. FFprobe enables embedded-subtitle preservation. Set `false` on CPU-constrained hosts. |
| `DS_SERVER_MAX_TRANSCODES` | `2` | Maximum simultaneous FFmpeg HLS jobs, including a staged quality switch. |
| `DS_SERVER_TRANSCODE_VIDEO_ENCODER` | `libx264` | Preferred H.264 encoder: `libx264`, `h264_videotoolbox`, `h264_nvenc`, or `h264_qsv`. The server detects FFmpeg support and falls back to `libx264` when available. |
| `DS_SERVER_TRANSCODE_START_TIMEOUT_MS` | `30000` | Maximum startup wait for the first HLS manifest and segment. |

## Public server security

For an internet-facing deployment behind an HTTPS reverse proxy, use:

```env
DS_SERVER_COOKIE_SECURE=true
DS_SERVER_TRUST_PROXY=true
DS_SERVER_PUBLIC_MODE=true
DS_SERVER_BIND_SESSION_USER_AGENT=true
DS_SERVER_SESSION_TTL_SECONDS=604800
DS_SERVER_ALLOW_RAW_STREAM_URLS=false
```

Fresh production installs require a one-time owner setup token. If
`DS_SERVER_SETUP_TOKEN` is blank, the server generates it and prints it once to
the server or container log while setup is required.

The included compose profiles run the service as a non-root user with a
read-only root filesystem, dropped Linux capabilities, and
`no-new-privileges`. The application also applies security headers, progressive
login lockout, rate limits on expensive routes, account-wide session revocation,
and optional authenticator-app two-factor authentication for owners and admins.

If Cloudflare Access protects the site, external media players need a bypass
policy for the exact path `/api/external-stream/*`. Do not bypass all API
routes. See [Remote access](remote-access.md#optional-cloudflare-access-auth-wall).

### About `DS_SERVER_SECRET_KEY`

If you don't provide one, the server generates a random key and saves it to
`data/server.key`. Encrypted credentials (debrid tokens, API keys) can only be
decrypted with that exact key. **If you lose it, every saved credential is
unrecoverable.** Provide a fixed value via env (recommended for Docker), or back
up `server.key` alongside your database.

Generate a strong one with:

```sh
openssl rand -base64 32
```

### About `DS_SERVER_ALLOW_RAW_STREAM_URLS`

This is a development convenience. When **off** (the production default), the
server refuses to fetch private, loopback, or reserved IP addresses for streams,
AI (Ollama), and subtitle downloads - protecting your internal network from
being probed (SSRF protection). Turn it on only on a trusted local box where you
need, for example, a localhost Ollama endpoint. **Never enable it on a public
server.**

---

## First-run owner setup

The first person to open a fresh server creates the **owner** account:

1. Open the server URL (`http://<server>:43110`).
2. You'll be prompted to create the owner account (username + password).
3. That account is the top-level admin: it can create profiles, invite links,
   and manage shared credentials.

After setup, add at least one **metadata provider** (a TMDB key for the live
catalog) and a **debrid provider** so streams can resolve. Then create profiles
or invite links for everyone else - see
[Multi-user & profiles](multi-user-and-profiles.md).

---

## Where your data lives

Everything persists under the **data directory** (`DS_SERVER_DATA_DIR`, default
`server/data/`, mounted as `/data` in Docker):

- `debridstreamer.sqlite` - accounts, profiles, watchlists, history, library,
  settings, encrypted credentials, audit log.
- `server.key` - the encryption key (unless you set `DS_SERVER_SECRET_KEY`).

This directory is **gitignored** - it is your private data and never committed.

### Backup

Back up the whole data directory, **or** at minimum:

- the SQLite database file, **and**
- `server.key` (or your fixed `DS_SERVER_SECRET_KEY`).

Restoring the database without the matching key leaves credentials undecryptable.

---

## Verify it's working

After the server is up:

- Open the URL in a browser and complete owner setup.
- From a phone on the same network (or over a tunnel - see
  [Remote access](remote-access.md)), open the same URL and install it to the
  home screen.
- Sign in, pick a title, and play - the video streams **through** the server.
