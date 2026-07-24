# Server-Mode Features

When you open DebridStreamer from a self-hosted server (in a browser or as an
installed PWA), you're in **Server Mode**. It runs the **same UI** as the
desktop app, but the heavy lifting - catalog lookups, search, debrid resolution,
AI, subtitles - happens on the server using the server's stored credentials, and
playback is proxied through the server.

This page lists what works in Server Mode and the current limitations.

---

## What works in Server Mode

### Browse, search, discover

- **Discover** home rails (trending and curated rows).
- **Search** across the catalog.
- **Catalog categories** and **filtered discover** (genre, type, etc.).
- **Genres** list and **media detail** (cast, recommendations, seasons,
  episodes).
- **Calendar** of upcoming releases.

These use the server's metadata provider (e.g. a shared TMDB key). With no
metadata key configured, a built-in catalog is used.

### Your library and viewing data (per profile)

- **Watchlist** - add/remove, kept separate per profile.
- **History** and **resume points** - "Continue Watching" with real resume
  positions, recorded as you watch.
- **Library** with **folders** - create, rename, delete folders and organize
  saved titles.

All of this is **profile-scoped**: each person's data is private to them. See
[Multi-user & profiles](multi-user-and-profiles.md).

### AI assistant + mood curate

- The **Assistant** screen works in Server Mode (it is no longer hidden) - it
  routes to the server, which uses the stored AI provider key.
- **Discover → "Describe a vibe"** mood curation also runs server-side: the AI
  recommends titles, and the server resolves each one to a real catalog item to
  show as posters.

The server picks the first configured AI provider in this order: **Anthropic,
OpenAI, then Ollama.** For Anthropic/OpenAI the credential is an API key; for
Ollama it's the endpoint URL. (A local Ollama endpoint only works when the
operator has enabled raw/private URLs - see
[Self-hosting](self-hosting.md#about-ds_server_allow_raw_stream_urls).)

### Subtitles (search, download, AI translate)

- **Search** subtitles via OpenSubtitles using the server's stored key.
- **Download** a chosen subtitle - the server decodes it to WebVTT and hands it
  to the player.
- **AI-translate** a subtitle track into another language, reusing the profile's
  AI credential, preserving timing.

### Playback through the single-IP debrid proxy

- The server queries indexers, resolves the chosen stream through the effective
  debrid credential, creates a **short-lived, profile-owned stream session**, and
  the client plays from `/api/stream/<id>`.
- The proxy supports **HTTP Range**, so seeking works, and it aborts the upstream
  fetch when you stop watching.
- Indexers and debrid providers see only the **server's IP**, not each viewer's.
- Per-profile **bandwidth is recorded** for admin visibility.
- The proxy validates upstream URLs (and every redirect) to refuse private/
  reserved addresses (SSRF protection), unless the operator explicitly enabled
  raw URLs on a trusted box.

### Per-profile playback controls (data-conscious viewing)

In **Settings → Playback**, each profile can:

- Show **cached-only** streams,
- **Cap the maximum visible quality**,
- **Hide oversized** torrent results before a stream is resolved.

These reduce accidental heavy remote playback. (They are stream *selection*
filters, not server-side transcoding.)

### Accounts, profiles, and admin

- Login/logout, per-device **session listing and revocation**, self-service
  **password change**.
- **Household sub-profiles** - one account can keep several viewer profiles (kids,
  guests, a shared TV) with separate history/watchlist/library, and switch between
  them with the **"Who's watching?"** picker without re-signing-in. See
  [Multi-user & profiles](multi-user-and-profiles.md#household-sub-profiles-whos-watching).
- Owner/admin: **invites**, **profile management**, **shared + per-profile
  credentials**, **usage**, **active streams** (with one-click **Terminate** to
  kill a stuck or unwanted stream), **health/warnings**, and an **audit log**.

### Install anywhere (PWA)

The hosted app is installable on iPhone, iPad, Android, and desktop browsers via
**Add to Home Screen** / the browser's install prompt.

### TV mode and phone remote

- `/tv` presents a ten-foot layout with D-pad spatial navigation and a
  single-use pairing code.
- `/remote` turns a signed-in phone into a private controller for the browser TV
  player. Playback stays on the television.
- The signed Android TV and Google TV app loads the same server library and uses
  Android Media3 for native playback, resume, preferred audio and subtitle
  languages, buffering status, and subtitle selection.

### Portability, language, and family recovery

- Server profiles can be exported and imported with explicit merge or replace
  behavior. A Local Mode backup can be migrated into selected Server Mode
  profiles, with skipped data reported instead of silently discarded.
- Interface language, metadata language, and metadata region are separate
  settings. Unknown or unavailable locale values fall back safely.
- Owners can reissue an invite while preserving its role and limits. Reissuing
  revokes the previous active link and reveals the replacement token once.
- Server availability warnings distinguish a signed-out device from an
  unreachable host and explain host sleep, power, network, and remote-access
  recovery.

---

## Current limitations

- **Debrid Library screen is desktop-only.** The dedicated "Debrid" file-library
  browser is a desktop (Tauri) feature and is hidden in Server Mode. Streaming
  itself still works through the proxy.
- **Server-side transcoding requires FFmpeg and server CPU.** Official Docker and
  Debian/Ubuntu deployments include FFmpeg and enable the capability. The hosted
  web app uses an adaptive 1080p, 720p, and 480p H.264/AAC ladder for
  browser-incompatible sources, or a bounded 480p profile in Data Saver mode.
  Compatible MP4/WebM sources remain direct at original quality. Resume can
  start the server job at the saved offset, embedded subtitles are exposed as a
  WebVTT sidecar when FFprobe is available, and HDR tone mapping is offered only
  when FFmpeg reports the required `zscale` filter. Operators can choose `libx264`,
  `h264_videotoolbox`, `h264_nvenc`, or `h264_qsv`; unsupported selections fall
  back to detected `libx264`. CPU-constrained operators can set
  `DS_SERVER_ENABLE_TRANSCODE=false`.
- **Hardware acceleration depends on the host.** Settings reports the configured
  and active encoder plus detected Apple VideoToolbox, NVIDIA NVENC, Intel Quick
  Sync, or CPU software support. A missing hardware encoder falls back to
  `libx264` rather than failing playback.
- **A feature needs its credential configured.** Each capability requires the
  matching credential to be present (shared or per-profile): metadata needs a
  TMDB key, AI needs an AI provider key, subtitles need an OpenSubtitles key,
  streaming needs a debrid provider. Without it, that feature is simply
  unavailable for that profile.
- **Some Simple-mode hiding still applies.** Assistant and Calendar are hidden in
  Simple mode regardless of Server Mode; switch to Advanced to reveal them (see
  [Skill tiers](skill-tiers.md)).
- **Hard per-profile bandwidth budgets** are not enforced yet - usage is recorded
  and visible, but not capped.

---

## At a glance

| Capability | Server Mode |
| --- | --- |
| Discover / Search / Catalog / Genres / Detail / Calendar | Works |
| Watchlist / History / Resume (per profile) | Works |
| Library + Folders (per profile) | Works |
| AI Assistant + mood curate | Works (needs AI key) |
| Subtitle search / download / AI translate | Works (needs OpenSubtitles + AI keys) |
| Debrid streaming via single-IP proxy (Range/seek) | Works |
| Per-profile cached-only / quality / size filters | Works |
| TV browser mode + phone remote | Works |
| Native Android TV / Google TV player | Works |
| Profile export / import + Local-to-Server migration | Works |
| Interface + metadata language and region | Works |
| Debrid Library file browser | Desktop only |
| Server-side transcoding (adaptive HLS) | Opt-in (operator flag + FFmpeg) |
