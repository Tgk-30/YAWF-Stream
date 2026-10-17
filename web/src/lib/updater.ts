// In-app auto-update check + install.
//
// Runs on launch and then weekly for long-running instances (via the
// UpdateBanner component, mounted from App.tsx). It
// is a deliberate no-op in a plain browser - the updater plugin only exists in
// the desktop Tauri shell - so it's guarded by `isTauri()` and never throws into
// the UI. When running under Tauri it asks the updater plugin whether a newer
// signed release is available (resolved from the `plugins.updater.endpoints`
// `latest.json` in tauri.conf.json) and, when one is, surfaces a small
// non-blocking glass banner ("Update vX.Y available - Install"). Installing
// downloads + applies the update (with progress) then relaunches the app.
//
// Releases are signed with the updater keypair (public key in tauri.conf.json,
// private key + password supplied to CI as TAURI_SIGNING_PRIVATE_KEY /
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD); the plugin verifies that signature
// before reporting an update, so an unsigned/forged `latest.json` is ignored.

import { isDesktopTauri } from "./tauri";
import { isNetworkAllowed } from "./networkPolicy";
import { recordDiagnostic } from "./diagnostics";

const LAST_CHECK_KEY = "ds_last_update_check";

/** Record that an update check just ran - drives the weekly re-check cadence for
 * long-running app instances (a fresh launch always checks regardless). */
export function markUpdateChecked(now = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(LAST_CHECK_KEY, String(now));
  } catch {
    // best-effort; without persistence every poll simply reads as "due".
  }
}

/** Milliseconds since the last recorded update check, or Infinity when never
 * checked / unreadable (so the first eligible poll is always "due"). */
export function updateCheckAgeMs(now = Date.now()): number {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_CHECK_KEY);
    const at = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(at)) return Infinity;
    return Math.max(0, now - at);
  } catch {
    return Infinity;
  }
}

/** How often a long-running instance re-checks for updates (the user's "check
 * every week" cadence). A fresh launch always checks immediately regardless. */
export const WEEKLY_UPDATE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** A pending desktop update, with the version + an install action. The install
 * action downloads + applies the update (reporting byte progress) and then
 * relaunches the app; it never resolves on success (the process restarts). */
export interface PendingUpdate {
  version: string;
  currentVersion: string;
  /** Release notes, when the `latest.json` carried a `notes` field. */
  notes: string | null;
  /** Download + install the update, then relaunch. `onProgress` (0..1, or null
   * when the total size is unknown) is called as bytes arrive. Rejects on
   * failure; on success the app relaunches and this never resolves. */
  install: (onProgress?: (fraction: number | null) => void) => Promise<void>;
}

/** Check for an available desktop update. Resolves to a {@link PendingUpdate}
 * when a newer signed release is available, else `null`. Never throws - a flaky
 * network, a missing release, or running in a plain browser all resolve to
 * `null` (with a console warning) so launch is never degraded. */
export async function checkForUpdates(): Promise<PendingUpdate | null> {
  if (!isNetworkAllowed("updates")) return null;
  if (!isDesktopTauri()) return null;

  try {
    // Imported dynamically so the browser bundle never resolves the Tauri
    // updater runtime at module-eval time (it's only present on the desktop).
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update == null) {
      // eslint-disable-next-line no-console
      console.info("[updater] App is up to date.");
      return null;
    }

    // eslint-disable-next-line no-console
    console.info(
      `[updater] Update available: ${update.version} (current ${update.currentVersion}).`,
      update.body ?? "",
    );

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? null,
      install: async (onProgress) => {
        let downloaded = 0;
        let contentLength = 0;
        // downloadAndInstall streams progress events; translate them to a 0..1
        // fraction (or null when the server didn't send a content length).
        try {
          await update.downloadAndInstall((event) => {
            switch (event.event) {
              case "Started":
                contentLength = event.data.contentLength ?? 0;
                onProgress?.(contentLength > 0 ? 0 : null);
                break;
              case "Progress":
                downloaded += event.data.chunkLength;
                onProgress?.(
                  contentLength > 0 ? downloaded / contentLength : null,
                );
                break;
              case "Finished":
                onProgress?.(1);
                break;
            }
          });
        } catch (error) {
          recordDiagnostic(
            "update",
            "install.failed",
            "error",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
        // Apply by relaunching the freshly-installed binary.
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch (err) {
    recordDiagnostic(
      "update",
      "check.failed",
      "warning",
      err instanceof Error ? err.message : String(err),
    );
    // eslint-disable-next-line no-console
    console.warn("[updater] Update check failed (ignored):", err);
    return null;
  }
}
