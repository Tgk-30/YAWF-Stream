interface VitePreloadErrorEvent extends Event {
  payload?: unknown;
}

const taggedPreloadFailures = new WeakSet<object>();

const STALE_ASSET_MESSAGES = [
  /Unable to preload CSS for (?:https?:\/\/[^\s/]+)?\/assets\/[^\s]+\.css(?:\?|$)/i,
  /Failed to fetch dynamically imported module: (?:https?:\/\/[^\s/]+)?\/assets\/[^\s]+\.js(?:\?|$)/i,
];

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "";
}

/** Recognize only Vite's explicit preload signal or its asset-specific failures. */
export function isStaleAssetLoadError(value: unknown): boolean {
  if (
    (typeof value === "object" && value != null) ||
    typeof value === "function"
  ) {
    if (taggedPreloadFailures.has(value as object)) return true;
  }
  const message = errorMessage(value);
  return STALE_ASSET_MESSAGES.some((pattern) => pattern.test(message));
}

/** Tag Vite preload failures before React mounts. Do not prevent the error:
 * the nearest ErrorBoundary must remain responsible for visible recovery. */
export function installStaleAssetFailureCapture(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const capture = (event: Event) => {
    const payload = (event as VitePreloadErrorEvent).payload;
    if (
      (typeof payload === "object" && payload != null) ||
      typeof payload === "function"
    ) {
      taggedPreloadFailures.add(payload as object);
    }
  };
  target.addEventListener("vite:preloadError", capture);
  return () => target.removeEventListener("vite:preloadError", capture);
}
