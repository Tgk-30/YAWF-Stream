import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NetworkMode } from "../lib/networkPolicy";
import { isNetworkAllowed } from "../lib/networkPolicy";
import { isTauri } from "../lib/tauri";
import { getPlayerMounted } from "../lib/attention";
import { isPlayerNavigationPending } from "../store/AppStore";
import {
  BROWSER_APP_UPDATE_CHECK_CADENCE_MS,
  checkBrowserAppUpdate,
  type BrowserAppUpdate,
} from "../lib/browserAppUpdate";
import {
  assertBrowserAppRefreshAllowed,
  prepareBrowserAppRefresh,
  reloadBrowserAppPage,
} from "../lib/browserAppRefresh";
import "./BrowserUpdateBanner.css";

export function BrowserUpdateBanner({
  autoCheck,
  networkMode,
  playerMounted,
  playerPending,
  currentVersion = __APP_VERSION__,
}: {
  autoCheck: boolean;
  networkMode: NetworkMode;
  playerMounted: boolean;
  playerPending: boolean;
  currentVersion?: string;
}) {
  const [update, setUpdate] = useState<BrowserAppUpdate | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const dismissedEntryRef = useRef<string | null>(null);
  const lastCheckAtRef = useRef(-Infinity);
  const inFlightRef = useRef<Promise<BrowserAppUpdate | null> | null>(null);
  const actionRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(false);
  const eligibilityRef = useRef({ autoCheck, networkMode, playerMounted, playerPending });
  useLayoutEffect(() => {
    eligibilityRef.current = { autoCheck, networkMode, playerMounted, playerPending };
  }, [autoCheck, networkMode, playerMounted, playerPending]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const playerIsBusy = useCallback(() => {
    const current = eligibilityRef.current;
    return getPlayerMounted() || isPlayerNavigationPending() || current.playerMounted || current.playerPending;
  }, []);

  const updateIsEligible = useCallback(() => {
    const current = eligibilityRef.current;
    return mountedRef.current && !isTauri() && current.autoCheck && isNetworkAllowed("updates", current.networkMode);
  }, []);

  useEffect(() => {
    if (isTauri() || !autoCheck || !isNetworkAllowed("updates", networkMode)) {
      setUpdate(null);
      setStatus(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const runCheck = (force = false) => {
      if (!active || document.visibilityState === "hidden") return;
      const current = eligibilityRef.current;
      if (!current.autoCheck || !isNetworkAllowed("updates", current.networkMode)) return;
      const now = Date.now();
      if (!force && now - lastCheckAtRef.current < BROWSER_APP_UPDATE_CHECK_CADENCE_MS) return;
      if (inFlightRef.current != null) return;
      lastCheckAtRef.current = now;
      const request = checkBrowserAppUpdate({ signal: controller.signal });
      inFlightRef.current = request;
      void request.then((next) => {
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        if (next == null || next.target.path === dismissedEntryRef.current) {
          setUpdate(null);
          return;
        }
        setStatus(null);
        setUpdate(next);
      }).catch(() => {
        // A background check is advisory. Offline, timeout and malformed pages
        // stay silent and can be retried at a later foreground cadence.
      }).finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
    };
    const onForeground = () => {
      if (document.visibilityState === "visible") runCheck();
    };
    runCheck(true);
    const cadenceTimer = window.setInterval(() => runCheck(), BROWSER_APP_UPDATE_CHECK_CADENCE_MS);
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("pageshow", onForeground);
    return () => {
      active = false;
      window.clearInterval(cadenceTimer);
      controller.abort();
      if (inFlightRef.current != null) inFlightRef.current = null;
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("pageshow", onForeground);
    };
  }, [autoCheck, networkMode]);

  const applyUpdate = () => {
    if (update == null || actionRef.current != null || !updateIsEligible()) return;
    if (playerIsBusy()) {
      setStatus("Close the active player before updating the app.");
      return;
    }
    setApplying(true);
    setStatus("Preparing the app update…");
    const operation = Promise.resolve().then(async () => {
      if (!updateIsEligible()) return;
      if (playerIsBusy()) {
        if (mountedRef.current) setStatus("Close the active player before updating the app.");
        return;
      }
      await prepareBrowserAppRefresh();
      if (!updateIsEligible()) return;
      if (playerIsBusy()) {
        setStatus("Close the active player before updating the app.");
        return;
      }
      assertBrowserAppRefreshAllowed();
      if (!updateIsEligible()) return;
      if (playerIsBusy()) {
        setStatus("Close the active player before updating the app.");
        return;
      }
      reloadBrowserAppPage();
    });
    actionRef.current = operation;
    void operation.catch(() => {
      if (mountedRef.current) setStatus("The app could not update. Check your connection and privacy mode, then try again.");
    }).finally(() => {
      if (actionRef.current === operation) actionRef.current = null;
      if (mountedRef.current) setApplying(false);
    });
  };

  if (isTauri() || !autoCheck || !isNetworkAllowed("updates", networkMode) || update == null || playerMounted || playerPending || getPlayerMounted() || isPlayerNavigationPending()) return null;

  return (
    <aside className="browser-update-banner" role="status" aria-live="polite">
      <div className="browser-update-banner-body">
        <strong>Different web app build available</strong>
        <p>
          Web version {currentVersion} is open. The server is offering a different app build.
          Save any unsaved changes before updating. Reloading does not clear saved profiles or offline files.
        </p>
        {status != null && <span className="browser-update-banner-status">{status}</span>}
      </div>
      <div className="browser-update-banner-actions">
        <button type="button" className="btn btn-primary" disabled={applying} onClick={applyUpdate}>
          {applying ? "Preparing…" : "Update app"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={applying}
          onClick={() => {
            dismissedEntryRef.current = update.target.path;
            setUpdate(null);
            setStatus(null);
          }}
        >
          Later
        </button>
      </div>
    </aside>
  );
}
