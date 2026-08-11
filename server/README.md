# DebridStreamer Server

Self-hosted Server Mode foundation for DebridStreamer.

## What Exists Now

- First-run owner setup.
- Cookie sessions with CSRF-protected mutations.
- Current-user session listing and revocation.
- In-memory abuse limits for login/setup/invite and stream-session mutations.
- Admin health diagnostics for sessions, streams, credentials, invites, and
  deployment flags.
- Admin active-stream dashboard data with profile, bytes, status, and expiry.
- User/profile creation.
- Profile-scoped watchlist and watch history.
- Encrypted server credentials and profile credential overrides.
- Redacted effective credential lookup.
- Short-lived protected stream sessions.
- Range-capable stream proxy.
- Optional, explicit Direct P2P playback for Server Mode. It is disabled by
  default and never acts as a fallback from debrid.

The React client can connect through Server Mode using the same-origin hosted
PWA or `VITE_DEBRIDSTREAMER_SERVER_URL` during development.

## Run Locally

```sh
cd server
npm install
npm run dev
```

The server listens on `0.0.0.0:43110` by default.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `43110` | HTTP port |
| `HOST` | `0.0.0.0` | Bind host |
| `DS_SERVER_DATA_DIR` | `./data` | Data directory |
| `DS_SERVER_DB_PATH` | `./data/debridstreamer.sqlite` | SQLite database path |
| `DS_SERVER_SECRET_KEY` | generated in `server.key` | Secret encryption key |
| `DS_SERVER_COOKIE_SECURE` | production only | Secure cookie flag |
| `DS_SERVER_SESSION_TTL_SECONDS` | 30 days | Session lifetime |
| `DS_SERVER_ALLOW_RAW_STREAM_URLS` | non-production only | Enable raw upstream stream-session endpoint |
| `DS_SERVER_ENABLE_DIRECT_TORRENT` | `false` | Enable explicit per-play Direct P2P actions |
| `DS_SERVER_DIRECT_TORRENT_MAX_ACTIVE` | `2` | Maximum active torrent hashes |
| `DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS` | `8` | Maximum pending plus active sessions across all profiles |
| `DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS_PER_PROFILE` | `2` | Maximum pending plus active sessions for one profile |
| `DS_SERVER_DIRECT_TORRENT_METADATA_TIMEOUT_MS` | `30000` | Metadata wait limit |
| `DS_SERVER_DIRECT_TORRENT_MAX_PEERS` | `24` | Outbound peer target and inbound TCP connection cap |
| `DS_SERVER_DIRECT_TORRENT_MAX_BYTES` | 30 GiB | Maximum size of one active torrent |
| `DS_SERVER_DIRECT_TORRENT_DOWNLOAD_BPS` | 25 MiB/s | Aggregate download rate cap |
| `DS_SERVER_DIRECT_TORRENT_UPLOAD_BPS` | 2 MiB/s | Aggregate upload rate cap |
| `DS_SERVER_DIRECT_TORRENT_IDLE_TIMEOUT_MS` | 15 minutes | Idle session cleanup limit |
| `DS_SERVER_TRUST_PROXY` | `false` | Trust reverse proxy headers |
| `DS_SERVER_CORS_ORIGIN` | localhost dev only | Comma-separated browser origins allowed to call the API with cookies |

For local web development against the server:

```sh
cd server
npm run dev

cd ../web
VITE_DEBRIDSTREAMER_SERVER_URL=http://localhost:43110 npm run dev
```

## Verify

```sh
npm run typecheck
npm test
npm run build
```

Node currently prints an ExperimentalWarning for built-in `node:sqlite`.

## Direct P2P risk and scope

Direct P2P is a Server Mode only first slice. When the flag is false, the
server does not load WebTorrent or create a torrent client, socket, cache
directory, registry timer, or NAT mapping. Existing resolve requests still use
debrid by default, and a debrid error never falls back to P2P.

When enabled, users see a separate Direct P2P action and must acknowledge the
risk for each play. Swarm peers can see the server's public IP. Playback depends
on seeders and can upload data, use disk space, and consume download and upload
bandwidth. Use it only for content you have the rights to access. The server
accepts only a validated 40-character info hash that is bound to the selected
title. It does not accept client trackers, web seeds, peer addresses, torrent
URLs, or filesystem paths. Trackers, LSD, Web Seeds, peer exchange, UPnP/PMP,
WebRTC, and uTP are disabled. Discovery uses the public DHT only, and private,
special-use, documentation, multicast, and reserved IPv4 peer ranges are
blocked. This narrower discovery mode can find fewer peers than a full torrent
client. The TCP accept guard permits public IPv4 peers only, rejects malformed,
private, and special-use remote addresses before WebTorrent creates a peer, and
counts pending and established inbound sockets against the peer cap.

Pending metadata registrations count against both session limits. Repeated
requests for a shared hash do not bypass the limits. For a series play, the
request must include a valid season and episode, the bound indexer result cannot
be tagged for another episode, and torrent metadata must contain an exact
episode-tagged playable file.

Enabling the engine opens TCP and UDP BitTorrent sockets even before a play,
although it never changes router mappings. Firewalls and ISPs can block or
throttle that traffic. Pieces downloaded for playback may upload while the
session remains active and until its idle cleanup. There is no durable or
indefinite background-seeding mode. Temporary data lives under
`DS_SERVER_DATA_DIR/direct-torrent`, is removed when the last session for a
torrent closes, and stale crash data is cleared the next time the engine starts.

Direct P2P does not provide HLS transcoding, durable downloads, browser-side
torrenting, native app torrent engines, or automatic fallback. Browser
compatibility therefore depends on the selected file format.
