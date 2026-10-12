import { assertNetworkAllowed, isRequestExempt } from "./networkPolicy";
import { deviceKind } from "./platform";
import { isTauri } from "./tauri";

const MAX_EXTERNAL_PLAYER_URL_BYTES = 8 * 1024;
const SERVER_PLAYER_BRIDGE_NAME = "__YAWF_SERVER_PLAYER__";
const SERVER_CAPABILITY_PATH = /^(?:\/[A-Za-z0-9._~-]{1,64})*\/api\/external-stream\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{32,128}$/;

export interface ServerPlayerMessageEvent {
  data?: unknown;
}

export interface AndroidServerPlayerBridge {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: ServerPlayerMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: ServerPlayerMessageEvent) => void): void;
}

function isAndroidTauriRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_TAURI_ANDROID__?: unknown;
  };
  return runtime.__YAWF_TAURI_ANDROID__ === true || deviceKind() === "android";
}

export function serverPlayerBridge(): AndroidServerPlayerBridge | null {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_SERVER_PLAYER__?: unknown;
  };
  const candidate = runtime[SERVER_PLAYER_BRIDGE_NAME as "__YAWF_SERVER_PLAYER__"];
  if (candidate == null || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return null;
  }
  const bridge = candidate as Partial<AndroidServerPlayerBridge>;
  return typeof bridge.postMessage === "function" &&
    typeof bridge.addEventListener === "function" &&
    typeof bridge.removeEventListener === "function"
    ? bridge as AndroidServerPlayerBridge
    : null;
}

/** Identify the Android app's WebView for UI-only routing decisions.
 *
 * Remote Server Mode documents cannot use local-only Tauri commands. They can
 * use the origin-attested WebMessageListener provider when present. The
 * read-only safe-area provider remains a UI marker and is never invoked here.
 */
export function isAndroidAppUiContext(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_NATIVE_SAFE_AREA__?: unknown;
  };
  const provider = runtime.__YAWF_NATIVE_SAFE_AREA__;
  const hasNativeSafeAreaGetter =
    provider != null &&
    (typeof provider === "object" || typeof provider === "function") &&
    typeof (provider as { getInsets?: unknown }).getInsets === "function";

  return serverPlayerBridge() != null ||
    hasNativeSafeAreaGetter ||
    (isTauri() && isAndroidTauriRuntime());
}

function isTrustedBundledDocumentOrigin(): boolean {
  let page: URL;
  try {
    page = new URL(globalThis.location.href);
  } catch {
    return false;
  }
  if (page.username.length > 0 || page.password.length > 0) return false;
  if (page.protocol === "tauri:") {
    return page.hostname === "localhost" && page.port === "";
  }
  return (
    page.protocol === "http:" &&
    page.hostname === "tauri.localhost" &&
    page.port === ""
  );
}

/** The existing Tauri command remains local-only. Remote Server Mode never
 * receives command eligibility even if partial Tauri globals survive. */
export function isAndroidExternalPlayerEligible(): boolean {
  return isTauri() && isAndroidTauriRuntime() && isTrustedBundledDocumentOrigin();
}

function canonicalHttpUrl(raw: string): string {
  if (
    raw.length === 0 ||
    new TextEncoder().encode(raw).byteLength > MAX_EXTERNAL_PLAYER_URL_BYTES ||
    raw.trim() !== raw ||
    Array.from(raw).some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    throw new Error("The stream link is not a valid HTTP(S) URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The stream link is not a valid HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("The stream link is not a valid HTTP(S) URL.");
  }
  return parsed.href;
}

export function canonicalServerCapability(raw: string): string {
  const canonical = canonicalHttpUrl(raw);
  let page: URL;
  let target: URL;
  try {
    page = new URL(globalThis.location.href);
    target = new URL(canonical);
  } catch {
    throw new Error("The external stream capability is unavailable.");
  }
  if (
    !["http:", "https:"].includes(page.protocol) ||
    page.username.length > 0 ||
    page.password.length > 0 ||
    target.origin !== page.origin ||
    target.search !== "" ||
    target.hash !== "" ||
    canonical !== raw ||
    target.pathname.includes("%") ||
    target.pathname.includes("\\") ||
    target.pathname.includes("//") ||
    !SERVER_CAPABILITY_PATH.test(target.pathname)
  ) {
    throw new Error("The external stream capability is unavailable.");
  }
  return canonical;
}

/** A remote handoff is available only when Android injected the
 * origin-attested WebMessageListener object and the current same-origin target
 * is the existing cookie-free external-stream capability route. */
export function isAndroidServerExternalPlayerEligible(rawUrl: string | null): boolean {
  if (rawUrl == null || isTrustedBundledDocumentOrigin() || serverPlayerBridge() == null) {
    return false;
  }
  try {
    canonicalServerCapability(rawUrl);
    return true;
  } catch {
    return false;
  }
}

/** Ask the native WebView host to confirm and launch a same-origin Server Mode
 * capability. Aborting posts a fixed cancel action and removes the document's
 * listener. The handoff callback runs only at the native challenge boundary,
 * immediately before the acknowledgement that permits ACTION_VIEW.
 */
export async function openAndroidServerExternalPlayer(
  rawUrl: string,
  ownsRequest: () => boolean,
  signal: AbortSignal,
  onHandoff: () => void,
): Promise<string | null> {
  const remote = await import("./androidServerExternalPlayer");
  return remote.openAndroidServerExternalPlayer(rawUrl, ownsRequest, signal, onHandoff);
}

/** Open Android's ACTION_VIEW chooser for a cookie-free stream capability.
 * This is the existing local-only Tauri command path. Remote documents use the
 * separately origin-attested WebMessageListener bridge above. */
export async function openAndroidExternalPlayer(
  rawUrl: string,
  ownsRequest: () => boolean,
): Promise<string | null> {
  if (!isAndroidExternalPlayerEligible()) {
    throw new Error("The native player chooser is available only from the bundled Android app.");
  }

  const url = canonicalHttpUrl(rawUrl);
  if (!isRequestExempt(url)) {
    assertNetworkAllowed("streaming", "Android external player");
  }
  if (!ownsRequest()) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  if (!ownsRequest()) return null;
  try {
    const status = await invoke<string>("mobile_open_external_player", { url });
    return ownsRequest() ? status : null;
  } catch {
    throw new Error("The Android player chooser could not be opened.");
  }
}
