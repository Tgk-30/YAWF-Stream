const SERVER_URL_STORAGE_KEY = "debridstreamer.server.url";
const SERVER_FOLLOW_STORAGE_KEY = "debridstreamer.server.follow";
const LOCAL_MODE_FOLLOW_VALUE = "local";
const ANDROID_LOCAL_ENTRY_HASH = "#yawf-local-mode";
let localEntryForCurrentDocument = false;

function bundledAndroidDocument(): URL | null {
  if (typeof window === "undefined") return null;
  const runtime = window as unknown as Record<string, unknown>;
  if (runtime.__YAWF_TAURI_ANDROID__ !== true || runtime.__TAURI_INTERNALS__ == null) return null;
  try {
    const page = new URL(window.location.href);
    return page.protocol === "http:" && page.hostname === "tauri.localhost" &&
      page.port === "" && page.username === "" && page.password === "" ? page : null;
  } catch {
    return null;
  }
}

function savedLocalModeOverride(): boolean {
  if (bundledAndroidDocument() == null) return false;
  if (localEntryForCurrentDocument) return true;
  try {
    return globalThis.localStorage?.getItem(SERVER_FOLLOW_STORAGE_KEY) === LOCAL_MODE_FOLLOW_VALUE;
  } catch {
    return false;
  }
}

/** Consume only the fixed native Android Local Mode destination, before boot
 * follows a saved server. The URL bookmark and all profile/credential data stay
 * untouched; the existing follow preference records the explicit Local choice. */
export function consumeAndroidLocalModeEntry(): boolean {
  const page = bundledAndroidDocument();
  if (page == null || page.pathname !== "/" || page.search !== "" || page.hash !== ANDROID_LOCAL_ENTRY_HASH) return false;
  localEntryForCurrentDocument = true;
  try {
    globalThis.localStorage?.setItem(SERVER_FOLLOW_STORAGE_KEY, LOCAL_MODE_FOLLOW_VALUE);
  } catch {
    // Keep this document local even when persistence is unavailable.
  }
  try {
    window.history.replaceState(window.history.state, "", page.pathname);
  } catch {
    // Re-consuming the same fixed marker is safe if history cannot be updated.
  }
  return true;
}

declare global {
  var __DEBRIDSTREAMER_SERVER_URL__: string | null | undefined;
  var __DEBRIDSTREAMER_SERVER_MODE_ENV__: Record<string, string> | undefined;
}

function envValue(key: string): string {
  const env =
    (globalThis as { __DEBRIDSTREAMER_SERVER_MODE_ENV__?: Record<string, string> })
      .__DEBRIDSTREAMER_SERVER_MODE_ENV__ ??
    (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  return env?.[key]?.trim() ?? "";
}

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "/") return "";
  return trimmed.replace(/\/+$/, "");
}

export function configuredServerURL(): string | null {
  const explicit = envValue("VITE_DEBRIDSTREAMER_SERVER_URL");
  if (explicit.length > 0) return normalizeBaseURL(explicit);

  const injected = globalThis.__DEBRIDSTREAMER_SERVER_URL__?.trim();
  if (injected != null && injected.length > 0) return normalizeBaseURL(injected);

  if (savedLocalModeOverride()) return null;

  try {
    const stored = globalThis.localStorage?.getItem(SERVER_URL_STORAGE_KEY);
    if (stored != null && stored.trim().length > 0) {
      return normalizeBaseURL(stored);
    }
  } catch {
    // Ignore private-mode/localStorage failures and stay in Local Mode.
  }

  return null;
}

export function configuredServerURLSource(): "env" | "same-origin" | "saved" | null {
  const explicit = envValue("VITE_DEBRIDSTREAMER_SERVER_URL");
  if (explicit.length > 0) return "env";

  const injected = globalThis.__DEBRIDSTREAMER_SERVER_URL__?.trim();
  if (injected != null && injected.length > 0) return "same-origin";

  if (savedLocalModeOverride()) return null;

  try {
    const stored = globalThis.localStorage?.getItem(SERVER_URL_STORAGE_KEY);
    if (stored != null && stored.trim().length > 0) return "saved";
  } catch {
    // Ignore private-mode/localStorage failures and report Local Mode.
  }

  return null;
}

export function isServerMode(): boolean {
  return configuredServerURL() != null;
}

export function saveServerURL(url: string | null, options?: { follow?: boolean }): void {
  try {
    if (url == null || url.trim().length === 0) {
      globalThis.localStorage?.removeItem(SERVER_URL_STORAGE_KEY);
      globalThis.localStorage?.removeItem(SERVER_FOLLOW_STORAGE_KEY);
    } else {
      const leavingLocalMode = savedLocalModeOverride();
      globalThis.localStorage?.setItem(SERVER_URL_STORAGE_KEY, normalizeBaseURL(url));
      if (options?.follow === true) {
        globalThis.localStorage?.setItem(SERVER_FOLLOW_STORAGE_KEY, "1");
      } else if (options?.follow === false || leavingLocalMode) {
        globalThis.localStorage?.removeItem(SERVER_FOLLOW_STORAGE_KEY);
      }
    }
    localEntryForCurrentDocument = false;
  } catch {
    // Non-fatal; callers can still use the current in-memory session.
  }
}

/** The URL a first-run "Connect to a server" handed the window to, when the
 * user chose that flow. Boot follows it once so the app reopens ON the server
 * instead of asking for the address again. Distinct from the Settings API-mode
 * connection, which must stay on the current origin. */
export function followServerURL(): string | null {
  if (savedLocalModeOverride()) return null;
  try {
    if (globalThis.localStorage?.getItem(SERVER_FOLLOW_STORAGE_KEY) !== "1") {
      return null;
    }
    const stored = globalThis.localStorage?.getItem(SERVER_URL_STORAGE_KEY);
    if (stored != null && stored.trim().length > 0) {
      return normalizeBaseURL(stored);
    }
  } catch {
    // Ignore private-mode/localStorage failures and boot normally.
  }
  return null;
}
