import { assertNetworkAllowed } from "./networkPolicy";

type RefreshServiceWorker = Pick<ServiceWorkerContainer, "getRegistration">;
const BROWSER_APP_REFRESH_TIMEOUT_MS = 12_000;

export class BrowserAppRefreshTimeoutError extends Error {
  constructor(stage: "lookup" | "update") {
    super(
      stage === "lookup"
        ? "The browser did not finish finding its service worker. Try again."
        : "The service worker did not finish checking app files. Try again.",
    );
    this.name = "BrowserAppRefreshTimeoutError";
  }
}

function boundedWorkerRequest<T>(
  request: Promise<T>,
  stage: "lookup" | "update",
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new BrowserAppRefreshTimeoutError(stage)),
      timeoutMs,
    );
    void request.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/** Keep browser app refreshes inside the same update privacy boundary as the
 * native updater. Call this again immediately before reloading after async work. */
export function assertBrowserAppRefreshAllowed(): void {
  assertNetworkAllowed("updates", "browser app refresh");
}

/** Ask the service worker controlling this page to check for changed app files.
 * Browsers without a registration can reload the server-delivered page directly. */
export async function prepareBrowserAppRefresh(
  serviceWorker: RefreshServiceWorker | undefined =
    typeof navigator === "undefined" ? undefined : navigator.serviceWorker,
  timeoutMs = BROWSER_APP_REFRESH_TIMEOUT_MS,
): Promise<void> {
  assertBrowserAppRefreshAllowed();
  if (serviceWorker == null) return;
  const registration = await boundedWorkerRequest(
    serviceWorker.getRegistration(),
    "lookup",
    timeoutMs,
  );
  if (registration == null) return;
  // Privacy mode may change while getRegistration is pending. Check again at
  // the last synchronous boundary before update() can make a network request.
  assertBrowserAppRefreshAllowed();
  await boundedWorkerRequest(registration.update(), "update", timeoutMs);
}

/** Reload only the current page. This does not clear caches, workers, storage,
 * profiles, or authentication, and it does not claim that a new build exists. */
export function reloadBrowserAppPage(
  reload: () => void = () => window.location.reload(),
): void {
  reload();
}
