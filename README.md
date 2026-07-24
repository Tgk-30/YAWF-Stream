# YAWF Stream

YAWF Stream is an open-source streaming hub for the services you already use.
It supports desktop, browser/PWA, Android TV, Google TV, and self-hosted Server
Mode.

## What It Is

- **Desktop app**: released Tauri builds for macOS and Linux. Windows remains
  held until its Authenticode signing gate passes.
- **Server Mode**: a self-hosted backend with login, profiles, separate history,
  invite links, shared credentials, profile credential overrides, and stream
  forwarding.
- **Account self-service**: users can change their own password and keep
  personal credential overrides without needing an admin to edit shared secrets;
  they can also review and revoke signed-in devices.
- **Usage visibility**: server-forwarded playback records per-profile bandwidth
  so admins can see who is using the hosted network path.
- **Admin diagnostics**: self-host admins can inspect server health, active
  sessions, active stream sessions, stream bytes/status, warnings, and audit
  events.
- **Playback controls**: each profile can prefer cached-only streams, cap visible
  quality, and hide oversized torrent results before playback.
- **Desktop Host Mode**: the desktop app can supervise the Server Mode backend
  and open the hosted PWA for other devices.
- **PWA**: install your self-hosted server on iPhone, iPad, Android, and desktop
  browsers.
- **Every screen**: use the ten-foot `/tv` interface in a television browser,
  pair `/remote` on a phone without moving the stream through the phone, or use
  the signed Android TV and Google TV app with native Media3 playback.
- **Portable profiles**: export and restore Server Mode profiles, or migrate a
  Local Mode backup into selected server profiles with merge or replace
  controls.
- **Localization**: choose interface language separately from metadata language
  and region, with safe fallback for unknown provider language values.
- **Host and invite recovery**: get clear host-sleep and network guidance, and
  reissue an invite while revoking its previous active link.
- **OTA updates**: desktop builds use signed `latest.json` metadata from GitHub
  Releases and can prompt or auto-install signed updates.

## Download

Latest desktop, server, and Android TV builds are published on GitHub Releases:

```text
https://github.com/Tgk-30/YAWF-Stream/releases/latest
```

The public product website lives in `website-app/` and is deployed under
`https://tgk30.com/debridstreamer/`.

## Run Server Mode Locally

```sh
cd server
npm install
npm run dev

cd ../web
VITE_DEBRIDSTREAMER_SERVER_URL=http://localhost:43110 npm run dev
```

Open `http://127.0.0.1:5173` and create the owner account.

## Docker

```sh
cd deploy/compose
cp .env.example .env
openssl rand -base64 32
# paste the value into DS_SERVER_SECRET_KEY in .env
# optional before exposing first setup:
# openssl rand -base64 24
# paste the value into DS_SERVER_SETUP_TOKEN in .env
docker compose up -d --build
```

Open `http://localhost:43110`.

## Desktop Host Resources

Release builds package the server bundle, hosted PWA assets, and a Node runtime
so Settings -> Install -> Host from this desktop can start Server Mode locally.
When hosting is running, the app shows the best setup URL, copy/share controls,
and a QR code for phones and tablets. Set `DEBRIDSTREAMER_DESKTOP_SHARE_URL`
before launching the app if you want the card to prefer a Tailscale or
Cloudflare Tunnel URL.

Owners/admins can create invite links from Settings -> Server. Invite links open
the hosted app, create an isolated profile account, and sign the new user in.
Each profile can also use Settings -> Playback to keep stream results cached-only
or limit quality/file size for lower-risk remote viewing.
Settings -> Server includes password changes and personal credential overrides
for users who want their own debrid/API keys instead of shared server defaults.

For local packaging checks:

```sh
cd server && npm run build
cd ../web && npm run build
cd .. && node scripts/prepare_tauri_server_resources.mjs
```

## Verify

```sh
cd server && npm run typecheck && npm test && npm run build
cd web && npm run typecheck && npm test && npm run build
cargo check --manifest-path web/src-tauri/Cargo.toml
node scripts/check_release_readiness.mjs
```

## Documentation

- Self-hosting architecture: `docs/SELF_HOSTING_DESIGN.md`
- Release and OTA updates: `docs/RELEASE_AND_UPDATES.md`
- Docker server setup: `docs/DOCKER.md`
- Recovery, backup, and owner reset: `docs/recovery.md`
- Desktop packaging: `web/PACKAGING.md`
- Docker Compose: `deploy/compose/README.md`

## License

Released under the [MIT License](LICENSE).
