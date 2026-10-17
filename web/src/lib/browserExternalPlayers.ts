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
  id: "vlc" | "infuse";
  label: string;
  description: string;
  href: string;
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
      {
        id: "infuse",
        label: "Open in Infuse",
        description: "Requires Infuse",
        href: `infuse://x-callback-url/play?url=${encodedTarget}&filename=${encodedTitle}`,
      },
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
    return [{
      id: "infuse",
      label: "Open in Infuse",
      description: "Requires Infuse for Mac",
      href: `infuse://x-callback-url/play?url=${encodedTarget}&filename=${encodedTitle}`,
    }];
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
  return "Download a playlist for an installed player, or copy the stream link and paste it into one." + protectedServerNote;
}
