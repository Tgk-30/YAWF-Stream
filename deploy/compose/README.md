# DebridStreamer Docker Compose

This runs Server Mode and serves the built PWA from the same container.

## Quick Start

### Recommended - prebuilt image (no source build)

Pulls the published multi-arch image (linux/amd64 + linux/arm64) from GHCR, so
an Ubuntu VPS / home server just needs Docker. Uses `docker-compose.ghcr.yml`.

```sh
cp .env.example .env
openssl rand -base64 32
# paste that value into DS_SERVER_SECRET_KEY in .env
docker compose -f docker-compose.ghcr.yml up -d
```

Update later with:

```sh
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

### Alternative - build from source

Uses `docker-compose.yml` to build the image locally from this checkout.

```sh
cp .env.example .env
openssl rand -base64 32
# paste that value into DS_SERVER_SECRET_KEY in .env
docker compose up -d --build
```

Open:

```text
http://localhost:43110
```

For non-Docker Ubuntu installs (native Node + systemd, or the `.deb` package),
see [`../ubuntu/README.md`](../ubuntu/README.md).

First launch requires the one-time owner setup token from
`docker compose logs debridstreamer`. Phone and tablet users can open the same
URL and install it to their home screen.

Server-forwarded playback records per-profile bandwidth. Owners and admins can
review recent usage in Settings -> Server.

Direct P2P remains disabled unless `DS_SERVER_ENABLE_DIRECT_TORRENT=true` is
set deliberately. It is not a debrid fallback. Swarm peers can see the server's
public IP, playback depends on seeders, and transfers can upload data and use
disk and bandwidth. Enabling it opens BitTorrent TCP and UDP sockets without
changing router mappings, and networks may block or throttle the traffic. Users
must confirm those risks for every Direct P2P play and must have the rights to
the content. See `server/README.md` in the source tree for the bounded defaults
and first-slice limitations. Pending metadata registrations and active sessions
have global and per-profile caps. Accepted inbound TCP sockets have a global cap
that includes both pending and established connections.

Owners and admins can also create invite links in Settings -> Server. Invite
links let a new user create their own password and isolated history without the
admin manually sharing credentials.

Each profile can use Settings -> Playback to show cached streams only, cap the
maximum visible quality, or hide oversized torrent results. These controls reduce
accidental heavy remote playback, but they are not server-side transcoding.

Users can change their own password and save personal credential overrides from
Settings -> Server. Admin-shared credentials remain the default when no profile
override exists.

## Tailscale

Run this compose stack on a machine already joined to your tailnet, then open:

```text
http://machine-name:43110
```

For a public or semi-public deployment, put HTTPS and an auth wall in front of
the service before sharing it outside your private network.

## Public HTTPS with Caddy

The included Caddy stack obtains and renews a Let's Encrypt certificate. Point
the DNS record in `YAWF_DOMAIN` at the server, make ports 80 and 443 reachable,
then run:

```sh
cp .env.example .env
# Set YAWF_DOMAIN and DS_SERVER_SECRET_KEY in .env first.
docker compose -f docker-compose.caddy.yml up -d
```

This profile does not publish port 43110. It enables secure cookies, trusted
proxy handling, public mode profile passwords, and optional User-Agent session
binding. The application container runs as an unprivileged user with a
read-only root filesystem, all Linux capabilities dropped, and only `/data`
and `/tmp` writable.

On bind-mounted storage, make the data directory writable by container UID
1000 before starting. Named volumes need no permission changes.

## Cloudflare Access

Use Cloudflare Tunnel or another reverse proxy to expose port `43110`, then set:

```env
DS_SERVER_COOKIE_SECURE=true
DS_SERVER_TRUST_PROXY=true
```

Cloudflare Access is an outer protection layer. DebridStreamer profiles and
sessions still provide the in-app boundary.

External players cannot present Cloudflare Access browser cookies. To keep VLC,
IINA, mpv, and device-player handoff working, add a Cloudflare Access bypass
policy for the exact path `/api/external-stream/*`. Do not bypass `/api/*` or
the site as a whole. That route still requires a short-lived, stream-scoped
capability tied to the profile, session expiry, and server-side revocation.

## Public deployment security settings

Recommended values behind any HTTPS reverse proxy:

```env
DS_SERVER_COOKIE_SECURE=true
DS_SERVER_TRUST_PROXY=true
DS_SERVER_PUBLIC_MODE=true
DS_SERVER_BIND_SESSION_USER_AGENT=true
DS_SERVER_SESSION_TTL_SECONDS=604800
DS_SERVER_ALLOW_RAW_STREAM_URLS=false
```

Fresh installs always require a one-time owner setup token. If
`DS_SERVER_SETUP_TOKEN` is blank, the server generates one and prints it once
to the container log while setup is required:

```sh
docker compose logs debridstreamer
```

The default compose profiles also run the application container as non-root,
with a read-only root filesystem, dropped capabilities, and
`no-new-privileges`. Keep those controls when adapting the stack.

## Desktop App Connected to This Server

The easiest cross-device path is to open this server URL directly and install it
as a PWA. If you want the separately bundled desktop app to connect to this
server API, expose the server over HTTPS and allow the desktop app origin:

```env
DS_SERVER_CORS_ORIGIN=http://tauri.localhost,tauri://localhost
DS_SERVER_COOKIE_SECURE=true
DS_SERVER_COOKIE_SAMESITE=none
DS_SERVER_TRUST_PROXY=true
```

Keep `DS_SERVER_COOKIE_SAMESITE=lax` when users open the server URL directly in
their browser or as a PWA.
