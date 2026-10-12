import { deviceKind } from "./platform";
import { isTauri } from "./tauri";

interface PhysicalSafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface AndroidSafeAreaSnapshotBridge {
  getInsets: () => unknown;
}

const CSS_SIDES = ["top", "right", "bottom", "left"] as const;
const NATIVE_SAFE_AREA_CHANGE_EVENT = "yawf-native-safe-area-change";

function isNativeAndroidWebView(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_TAURI_ANDROID__?: unknown;
  };
  return runtime.__YAWF_TAURI_ANDROID__ === true || deviceKind() === "android";
}

function nativeSnapshotProvider(): (() => unknown) | null {
  const runtime = globalThis as typeof globalThis & {
    __YAWF_NATIVE_SAFE_AREA__?: Partial<AndroidSafeAreaSnapshotBridge>;
  };
  const bridge = runtime.__YAWF_NATIVE_SAFE_AREA__;
  return bridge != null && typeof bridge.getInsets === "function"
    ? () => bridge.getInsets?.()
    : null;
}

function validatedPhysicalSafeAreaInsets(
  value: unknown,
): PhysicalSafeAreaInsets | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "bottom,left,right,top") return null;
  if (
    !CSS_SIDES.every(
      (side) =>
        typeof record[side] === "number" &&
        Number.isFinite(record[side]) &&
        Number.isInteger(record[side]) &&
        record[side] >= 0,
    )
  ) {
    return null;
  }
  return {
    top: record.top as number,
    right: record.right as number,
    bottom: record.bottom as number,
    left: record.left as number,
  };
}

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
  const snapshotProvider = nativeSnapshotProvider();
  const useTauriCommand = isTauri() && isNativeAndroidWebView();
  if (snapshotProvider == null && !useTauriCommand) return () => {};

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
        const rawInsets = snapshotProvider != null
          ? snapshotProvider()
          : await (async () => {
              const { invoke } = await import("@tauri-apps/api/core");
              return invoke<PhysicalSafeAreaInsets>("mobile_safe_area_insets");
            })();
        const insets = validatedPhysicalSafeAreaInsets(rawInsets);
        if (insets == null) throw new Error("invalid native inset snapshot");
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

  if (snapshotProvider != null) {
    window.addEventListener(NATIVE_SAFE_AREA_CHANGE_EVENT, schedule);
  }
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
    window.removeEventListener(NATIVE_SAFE_AREA_CHANGE_EVENT, schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    if (frame != null) window.cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
}
