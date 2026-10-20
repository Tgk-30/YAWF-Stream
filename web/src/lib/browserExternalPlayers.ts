import { canonicalServerCapability } from "./androidExternalPlayer";

export type BrowserExternalDevice =
  | "ios"
  | "android"
  | "mac"
  | "windows"
  | "linux"
  | "desktop"
  | "unknown";

export interface BrowserExternalPlayerLink {
  id: "vlc" | "infuse" | "iina";
  label: string;
  description: string;
  href: string;
}

export type BrowserExternalFileHint = "video-file" | "hls-playlist" | "unknown";

/** A filename hint, not response MIME or verified player compatibility. Never
 * infer it from an extensionless capability or a browser-transcode rendition. */
export function browserExternalFileHint(
  sourceFileName: string | null | undefined,
): BrowserExternalFileHint {
  const name = sourceFileName?.trim() ?? "";
  if (/\.m3u8?$/i.test(name)) return "hls-playlist";
  if (/\.(?:mp4|m4v|mov|mkv|avi|webm|ts|m2ts|mts|mpg|mpeg|wmv|flv|ogv|3gp)$/i.test(name)) {
    return "video-file";
  }
  return "unknown";
}

/**
 * Browser hand-offs must never receive a provider URL or an authenticated
 * stream route. Only the same-origin, cookie-free external-stream capability
 * is suitable for a custom scheme, clipboard, or downloaded playlist.
 */
export function browserExternalCapability(rawUrl: string | null): string | null {
  if (rawUrl == null) return null;
  try {
    return canonicalServerCapability(rawUrl);
  } catch {
    return null;
  }
}

function externalTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim() || "YAWF Stream";
}

export function browserExternalPlayerLinks(
  rawUrl: string | null,
  title: string,
  device: BrowserExternalDevice,
  _standalone: boolean,
  originalHint: BrowserExternalFileHint = "unknown",
): BrowserExternalPlayerLink[] {
  const target = browserExternalCapability(rawUrl);
  if (target == null) return [];

  const encodedTarget = encodeURIComponent(target);
  const encodedTitle = encodeURIComponent(externalTitle(title));
  if (device === "ios") {
    return [
      {
        id: "vlc",
        label: "Open in VLC",
        description: "Requires VLC for iPhone or iPad",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodedTarget}`,
      },
      ...(originalHint === "video-file" ? [{
        id: "infuse" as const,
        label: "Open in Infuse",
        description: "Requires Infuse; filename compatibility hint only",
        href: `infuse://x-callback-url/play?url=${encodedTarget}&filename=${encodedTitle}`,
      }] : []),
    ];
  }

  if (device === "android") {
    const parsed = new URL(target);
    return [{
      id: "vlc",
      label: "Open in VLC",
      description: "Requires the VLC Android app",
      href: `intent://${parsed.host}${parsed.pathname}#Intent;scheme=${parsed.protocol.slice(0, -1)};package=org.videolan.vlc;type=video/*;end`,
    }];
  }

  if (device === "mac") {
    return [
      {
        id: "iina",
        label: "Open in IINA",
        description: "Requires IINA 1.4.4 or newer for Mac",
        // Only these fixed parameters are permitted. In particular, never
        // forward provider query values, titles or mpv options into this scheme.
        href: `iina://open?url=${encodedTarget}&new_window=1`,
      },
      ...(originalHint === "video-file" ? [{
        id: "infuse" as const,
        label: "Open in Infuse",
        description: "Requires Infuse for Mac; filename compatibility hint only",
        href: `infuse://x-callback-url/play?url=${encodedTarget}&filename=${encodedTitle}`,
      }] : []),
    ];
  }

  return [];
}

export function browserExternalGuidance(
  device: BrowserExternalDevice,
  _standalone: boolean,
): string {
  const protectedServerNote =
    " Browser-login-protected servers also require the operator to allow the external-stream capability route; no login cookie is placed in this link.";
  if (device === "windows") {
    return "Windows web apps cannot reliably launch a specific desktop player. Download the playlist or copy the link into an installed player." + protectedServerNote;
  }
  if (device === "mac") {
    return "Choose an installed player above. IINA 1.4.4 or newer supports the direct handoff; Infuse is shown only when the original filename looks like a video file; playback compatibility is not verified. Downloading a playlist and copying the link remain separate fallbacks." + protectedServerNote;
  }
  return "Download a playlist for an installed player, or copy the stream link and paste it into one." + protectedServerNote;
}
