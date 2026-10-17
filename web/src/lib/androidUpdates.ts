import { isTauri } from "./tauri";

/** This local marker grants no privilege; the command ACL independently excludes remote pages. */
export function hasLocalAndroidUpdater(): boolean {
  if (!isTauri() || (window as unknown as Record<string, unknown>).__YAWF_TAURI_ANDROID__ !== true) return false;
  try {
    const url = new URL(window.location.href);
    return !url.username && !url.password &&
      ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(url.origin === "null" ? url.protocol + "//" + url.host : url.origin);
  } catch { return false; }
}

/** Open a native consent dialog, never pass a URL or APK metadata from JavaScript. */
export async function checkAndroidAppUpdates(): Promise<void> {
  if (!hasLocalAndroidUpdater()) throw new Error("Open the Android app in standalone mode to manage APK updates.");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mobile_check_android_updates");
}
