# Remote Access

By default your server is reachable only on your local network
(`http://<server-ip>:43110`). To watch from anywhere - your phone on cellular, a
friend's house - you need to reach it remotely **without** exposing an open,
unauthenticated port to the internet.

The two recommended ways are **Tailscale** (private mesh VPN) and **Cloudflare
Tunnel** (public HTTPS hostname). Both avoid port-forwarding.

> Do **not** simply forward port `43110` to the public internet over plain HTTP.
> Anyone could find it. Use one of the methods below.

---

## Why route through the server at all (the single-IP rationale)

When you stream **through** your DebridStreamer server, your indexers and debrid
provider see **one IP address - the server's** - no matter how many people watch
or where they are.

Why that matters:

- **Privacy:** your viewers' home and mobile IPs are never exposed to debrid
  providers or indexers. Only the server talks to them.
- **Account safety:** debrid providers often flag accounts used from many
  different IPs at once. A single egress IP looks like one normal user.
- **Simplicity:** family members never touch a debrid token; the server holds
  the credentials and proxies the bytes.

This is the core reason to self-host rather than have every device call debrid
directly. Remote access just lets people reach that single egress point safely.

> The server still sends the full video bytes to each viewer - relaying does not
> reduce a viewer's own data usage. Use the per-profile **cached-only / max
> quality / max file size** playback controls to limit heavy remote playback.

---

## Option A: Tailscale (private - easiest, recommended)

Tailscale puts your devices and your server on a private encrypted mesh network.
Nothing is exposed to the public internet; only your own devices can reach the
server.

Best for: your own household and devices.

### Steps

1. **Install Tailscale on the server** (the NAS/VPS/Pi/desktop running
   DebridStreamer) and sign in. Each machine joins your *tailnet*.
   - Docs: <https://tailscale.com/kb/1017/install>
2. **Install Tailscale on each viewing device** (phone, tablet, laptop) and sign
   in with the **same account**.
3. Find the server's Tailscale name or IP (the `100.x.y.z` address, or its
   MagicDNS name like `myserver`).
   - MagicDNS: <https://tailscale.com/kb/1081/magicdns>
4. From any device on the tailnet, open:

   ```text
   http://myserver:43110
   ```

   Install it to the home screen as a PWA and you're done.

Because traffic stays inside the tailnet, you can leave it on plain HTTP - the
tailnet itself is the encryption layer. No environment changes are required for
a basic setup.

> To share access with someone outside your household without adding them to
> your tailnet, prefer Cloudflare Tunnel (below), or use Tailscale's sharing
> features: <https://tailscale.com/kb/1084/sharing>

---

## Option B: Cloudflare Tunnel (public HTTPS hostname)

Cloudflare Tunnel gives your server a real `https://stream.example.com` address
with a valid certificate, **without** opening any inbound port on your router.
The tunnel makes an outbound connection to Cloudflare; Cloudflare routes traffic
back through it.

Best for: a stable public URL, sharing with people who aren't on your tailnet,
or putting an auth wall (Cloudflare Access) in front.

### Steps

1. You need a domain on Cloudflare. Then install `cloudflared` on the server and
   authenticate it:
   - Install / get started:
     <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/>
2. Create a tunnel and route a hostname (e.g. `stream.example.com`) to your local
   service `http://localhost:43110`:
   - Create a tunnel:
     <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/>
3. Because Cloudflare terminates HTTPS and forwards to your server, tell the
   server it's behind a trusted HTTPS proxy. Set:

   ```env
   DS_SERVER_COOKIE_SECURE=true
   DS_SERVER_TRUST_PROXY=true
   ```

   (In Docker, add these to your `.env` and restart.)
   For an internet-facing household server, also enable the public deployment
   protections documented in [Self-hosting](self-hosting.md#public-server-security).
4. Open your public URL:

   ```text
   https://stream.example.com
   ```

   Install it as a PWA on any device.

### Optional: Cloudflare Access (auth wall)

You can put Cloudflare Access in front of the hostname so only approved emails
can even load the page:

- <https://developers.cloudflare.com/cloudflare-one/policies/access/>

The desktop app keeps a separate browser session from Chrome, Safari, and
Firefox. If the server is protected by Cloudflare Access, YAWF Stream detects
the Access redirect and offers **Sign in to Cloudflare Access**. Complete that
sign-in in the desktop window, close it after the server loads, then select
**Retry** in the main app. Opening the URL in an external browser does not sign
in the desktop app because the two applications do not share cookies.

VLC, IINA, mpv, and operating-system players also cannot present Cloudflare
Access browser cookies. YAWF Stream's **Open in external player** action uses a
short-lived, stream-scoped capability URL instead. Add a Cloudflare Access
bypass policy for the exact path `/api/external-stream/*` so the selected
player can fetch it. Do not bypass `/api/*` or the whole site. The capability is
tied to the current profile and session expiry and can be revoked server-side.

> **Important:** Cloudflare Access and Tailscale are *outer* protection layers.
> They control who can reach the server. They do **not** replace DebridStreamer's
> own logins and profiles, which keep each person's history, credentials, and
> sessions separate. Always create real profiles per person - see
> [Multi-user & profiles](multi-user-and-profiles.md).

---

## Pointing the desktop "host" card at your tunnel

If you host from the desktop app and also expose it via Tailscale or Cloudflare,
set this before launching the app so the share card / QR prefers your remote URL:

```sh
DEBRIDSTREAMER_DESKTOP_SHARE_URL=https://stream.example.com
```

---

## TV mode, Android TV, and the phone remote

Server Mode exposes two device-specific routes:

```text
https://stream.example.com/tv
https://stream.example.com/remote
```

- Open `/tv` in a television browser for the ten-foot interface and D-pad
  navigation. The TV shows a six-digit, single-use pairing code.
- Open `/remote` on a signed-in phone, enter that code, and control the browser
  TV player. The phone sends play, pause, seek, volume, fullscreen, next-source,
  and close commands. Video bytes continue flowing to the TV, not through the
  phone.
- On Android TV or Google TV, install the signed YAWF Stream TV APK and enter
  the base server URL. The app loads `/tv` and moves playback into the native
  Android Media3 player. The phone remote currently controls browser TV mode;
  native Android TV playback uses the physical remote.

The TV and phone must reach the same YAWF Stream server and sign in to the same
viewer profile. Pairing codes expire quickly and can be replaced from the TV.
For a TV outside the home, Tailscale is the simplest route because it does not
require an interactive Cloudflare Access login inside the TV app. Use HTTPS for
any publicly reachable hostname.

---

## Choosing between them

| | Tailscale | Cloudflare Tunnel |
| --- | --- | --- |
| Exposure | Private mesh, your devices only | Public HTTPS hostname |
| Setup | Install app on each device | Domain + `cloudflared` on server |
| HTTPS | Not needed (encrypted tailnet) | Yes, with a real certificate |
| Best for | Your own household | Sharing widely / stable public URL |
| Extra auth | N/A | Optional Cloudflare Access |

Either way, keep DebridStreamer's profiles and passwords in place as the in-app
boundary.
