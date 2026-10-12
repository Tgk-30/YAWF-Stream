import { assertNetworkAllowed, isRequestExempt } from "./networkPolicy";
import { deviceKind } from "./platform";
import { isTauri } from "./tauri";

const MAX_EXTERNAL_PLAYER_URL_BYTES = 8 * 1024;

function isAndroidTauriRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_TAURI_ANDROID__?: unknown;
  };
  return runtime.__YAWF_TAURI_ANDROID__ === true || deviceKind() === "android";
}

/** Identify the Android app's WebView for UI-only routing decisions.
 *
 * Remote Server Mode documents cannot use local-only Tauri commands, but the
 * native read-only safe-area provider is still injected into their owned
 * WebView. Checking for its zero-argument getter lets those documents retain
 * mobile copy and webview-player behavior without invoking the getter or
 * widening any command eligibility.
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

  return hasNativeSafeAreaGetter || (isTauri() && isAndroidTauriRuntime());
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

/** The Android chooser command is local-only. A remote Server Mode document
 * can retain Tauri runtime markers, but its origin is intentionally outside
 * the command ACL and must receive only the manual copy fallback. */
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

/** Open Android's ACTION_VIEW chooser for a cookie-free stream capability.
 * The ownership callback is checked immediately before the native invoke and
 * after it settles so a replaced or unmounted player cannot launch or update
 * UI for an older source. A null result means ownership was lost. */
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
    // Rust owns the only cancellable deadline, immediately before Android's
    // irreversible startActivity boundary. A JS timer cannot cancel an invoke
    // delayed before Rust begins and could falsely report failure before a late
    // chooser appears.
    const status = await invoke<string>("mobile_open_external_player", { url });
    return ownsRequest() ? status : null;
  } catch {
    throw new Error("The Android player chooser could not be opened.");
  }
}
