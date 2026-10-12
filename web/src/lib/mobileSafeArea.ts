import { deviceKind } from "./platform";
import { isTauri } from "./tauri";

interface PhysicalSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const CSS_SIDES = ["top", "right", "bottom", "left"] as const;

export function applyPhysicalSafeAreaInsets(
  insets: PhysicalSafeAreaInsets,
  pixelRatio = window.devicePixelRatio,
): void {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const root = document.documentElement;
  for (const side of CSS_SIDES) {
    const physicalPixels = insets[side];
    const cssPixels =
      Number.isFinite(physicalPixels) && physicalPixels > 0
        ? physicalPixels / ratio
        : 0;
    root.style.setProperty(`--native-safe-area-${side}`, `${cssPixels}px`);
  }
}

/**
 * Mirrors Android WindowInsets into CSS variables. Android WebView currently
 * leaves env(safe-area-inset-*) at zero in an edge-to-edge activity, so CSS
 * alone cannot keep content out from under the status bar and display cutout.
 */
export function installMobileSafeAreaInsets(): () => void {
  if (!isTauri() || deviceKind() !== "android") return () => {};

  let stopped = false;
  let frame: number | null = null;
  let refreshRevision = 0;
  let refreshRunning = false;
  let refreshQueued = false;
  const timers = new Set<number>();

  const update = async () => {
    if (refreshRunning || stopped) return;
    refreshRunning = true;
    do {
      refreshQueued = false;
      const requestRevision = refreshRevision;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const insets = await invoke<PhysicalSafeAreaInsets>(
          "mobile_safe_area_insets",
        );
        if (!stopped && requestRevision === refreshRevision) {
          applyPhysicalSafeAreaInsets(insets);
        }
      } catch {
        if (!stopped && requestRevision === refreshRevision) {
          console.warn("[YAWF Stream] Could not refresh native safe-area insets.");
        }
      }
    } while (!stopped && refreshQueued);
    refreshRunning = false;
  };

  const queueRefresh = () => {
    refreshRevision += 1;
    refreshQueued = true;
    if (!refreshRunning) {
      void update();
    }
  };

  const schedule = () => {
    if (stopped) return;
    // Every viewport signal invalidates an older native response immediately,
    // even when several signals coalesce into one animation-frame refresh.
    refreshRevision += 1;
    refreshQueued = true;
    if (frame != null || refreshRunning) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      queueRefresh();
    });
  };

  schedule();
  for (const delay of [250, 1000]) {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      schedule();
    }, delay);
    timers.add(timer);
  }
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);

  return () => {
    stopped = true;
    refreshRevision += 1;
    refreshQueued = false;
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    if (frame != null) window.cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}
