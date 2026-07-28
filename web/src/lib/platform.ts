// Platform / install-surface detection, shared by the Settings Install tab
// and the mobile InstallPrompt card. Moved verbatim from screens/Settings.tsx - 
// the iPad-as-Mac detection via maxTouchPoints is intentional, do not "fix".

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type DeviceKind =
  | "ios"
  | "android"
  | "mac"
  | "windows"
  | "linux"
  | "desktop"
  | "unknown";

export function deviceKind(): DeviceKind {
  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();
  const touchPoints = navigator.maxTouchPoints ?? 0;
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (platform.includes("mac") && touchPoints > 1) return "ios";
  if (ua.includes("android")) return "android";
  if (platform.includes("mac") || ua.includes("mac os")) return "mac";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("x11")) return "linux";
  if (/desktop|cros/.test(ua)) return "desktop";
  return "unknown";
}

export function isStandaloneDisplay(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

/** A phone/tablet browser session - the only place the install card belongs. */
export function isMobileBrowser(): boolean {
  const k = deviceKind();
  return k === "ios" || k === "android";
}

/**
 * Whether the page can be installed at all.
 *
 * Chromium refuses to register a service worker or fire `beforeinstallprompt`
 * outside a secure context, and only localhost is exempt from needing TLS. A
 * server reached over plain HTTP at a LAN address is therefore never
 * installable on Android, and the browser menu simply has no install entry -
 * so telling the user to look for one sends them hunting for something that
 * does not exist. iOS Safari's Add to Home Screen is not gated this way.
 *
 * Treated as secure when the browser does not expose the flag at all, so an
 * unexpected environment degrades to the previous guidance rather than
 * accusing a working setup of being insecure.
 */
export function isSecureContextForInstall(): boolean {
  if (typeof window === "undefined") return true;
  return window.isSecureContext !== false;
}
