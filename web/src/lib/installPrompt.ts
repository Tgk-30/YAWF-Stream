// Early beforeinstallprompt capture, module-cached. The browser fires the
// event once, often BEFORE React commits App - so main.tsx registers this at
// module eval and consumers read/subscribe to the cache instead of racing to
// add their own listeners.

import type { BeforeInstallPromptEvent } from "./platform";
import { isMobileBrowser, isStandaloneDisplay } from "./platform";
import { isAndroidAppUiContext } from "./androidExternalPlayer";
import { hasAndroidTVBridge } from "./androidTV";
import { isTauri } from "./tauri";

/** Static platform gate: browser-only, never an app WebView or standalone. */
export function isInstallPromptEligible(): boolean {
  return (
    !isTauri() &&
    !isAndroidAppUiContext() &&
    !hasAndroidTVBridge() &&
    !isStandaloneDisplay() &&
    isMobileBrowser()
  );
}


let deferred: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<(e: BeforeInstallPromptEvent | null) => void>();

/** Idempotent; MUST run at module-eval time in main.tsx, before createRoot(). */
export function initInstallPromptCapture(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    for (const l of listeners) l(deferred);
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    for (const l of listeners) l(null);
  });
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferred;
}

export function subscribeInstallPrompt(
  cb: (e: BeforeInstallPromptEvent | null) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function consumeInstallPrompt(): void {
  deferred = null;
}
