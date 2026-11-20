import { useCallback, useEffect, useId, useRef, useState } from "react";
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

export function TVPairingDock({ covered = false }: { covered?: boolean }) {
  const session = useTVRemoteSession();
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [expiredSessionId, setExpiredSessionId] = useState<string | null>(null);
  const newCodeHintId = useId();
  const refreshInFlight = useRef(false);
  const pairingDeadline = session == null ? NaN : Date.parse(session.pairingExpiresAt);
  const codeExpired = session != null && (
    expiredSessionId === session.id || !Number.isFinite(pairingDeadline) || pairingDeadline <= Date.now()
  );

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
    if (!covered && session == null && !refreshInFlight.current) void refresh();
  }, [covered, refresh, session]);

  useEffect(() => {
    if (session == null || codeExpired) return;
    // The deadline belongs to the one-time code, not the paired controller.
    // Hide the code locally without revoking or recreating the viewer session.
    const timer = window.setTimeout(
      () => setExpiredSessionId(session.id),
      Math.max(0, pairingDeadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [codeExpired, pairingDeadline, session]);

  useEffect(() => {
    if (covered) setCollapsed(true);
  }, [covered]);

  // Keep the session active for an already paired phone, but never draw the
  // dock over Detail or a modal that owns input.
  if (covered) return null;

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
              {codeExpired ? (
                <p role="status">The pairing code has expired.</p>
              ) : (
                <>
                  <strong className="tv-pairing-code">{session.pairingCode}</strong>
                  <p>Open <b>/remote</b> on your phone and enter this one-time code.</p>
                </>
              )}
              <p id={newCodeHintId}>Creating a new code disconnects any paired phone.</p>
              <button
                type="button"
                className="btn"
                aria-describedby={newCodeHintId}
                onClick={() => void refresh()}
              >
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
