import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTVRemoteSession,
  revokeTVRemoteSession,
} from "../lib/serverApi";
import { isServerMode } from "../lib/serverMode";
import {
  setTVRemoteSession,
  useTVRemoteSession,
} from "../lib/tvRemoteSession";
import "./TVRemote.css";

export function TVPairingDock() {
  const session = useTVRemoteSession();
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!isServerMode() || refreshInFlight.current) return;
    refreshInFlight.current = true;
    const previous = session;
    setError(null);
    setTVRemoteSession(null);
    try {
      if (previous != null) {
        await revokeTVRemoteSession(previous.id).catch(() => {});
      }
      const next = await createTVRemoteSession();
      setTVRemoteSession(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      refreshInFlight.current = false;
    }
  }, [session]);

  useEffect(() => {
    if (session == null && !refreshInFlight.current) void refresh();
  }, [refresh, session]);

  useEffect(() => {
    if (session == null) return;
    const expiresAt = Date.parse(session.pairingExpiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => void refresh(),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [refresh, session]);

  if (!isServerMode()) {
    return (
      <aside className="tv-pairing-dock glass-raised">
        TV mode needs Server Mode. Open this screen from your YAWF Stream server.
      </aside>
    );
  }

  return (
    <aside
      className={`tv-pairing-dock glass-raised${collapsed ? " is-collapsed" : ""}`}
      aria-label="Phone remote pairing"
    >
      <button
        type="button"
        className="tv-pairing-toggle"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        {collapsed ? "Show phone remote code" : "Hide phone remote code"}
      </button>
      {!collapsed && (
        <>
          <span className="tv-pairing-eyebrow">Phone remote</span>
          {session != null ? (
            <>
              <strong className="tv-pairing-code">{session.pairingCode}</strong>
              <p>
                Open <b>/remote</b> on your phone and enter this one-time code.
              </p>
              <button type="button" className="btn" onClick={() => void refresh()}>
                New code
              </button>
            </>
          ) : error == null ? (
            <p>Creating a private pairing code…</p>
          ) : (
            <>
              <p role="alert">{error}</p>
              <button type="button" className="btn" onClick={() => void refresh()}>
                Retry
              </button>
            </>
          )}
        </>
      )}
    </aside>
  );
}
