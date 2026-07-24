import { useCallback, useEffect, useState } from "react";
import { configuredServerURL, isServerMode } from "../lib/serverMode";
import "./HostAvailabilityBanner.css";

type AvailabilityFailure =
  | { kind: "offline" }
  | { kind: "server"; message: string };

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 8_000;

export function HostAvailabilityBanner() {
  const [failure, setFailure] = useState<AvailabilityFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const serverURL = configuredServerURL();

  const check = useCallback(async () => {
    if (!isServerMode() || serverURL == null) {
      setFailure(null);
      return;
    }
    if (navigator.onLine === false) {
      setFailure({ kind: "offline" });
      return;
    }

    setChecking(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${serverURL}/api/health`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Health check failed (${response.status}).`);
      }
      setFailure(null);
    } catch (error) {
      setFailure({
        kind: "server",
        message:
          error instanceof DOMException && error.name === "AbortError"
            ? "The server did not respond before the connection timed out."
            : error instanceof Error
              ? error.message
              : "The server could not be reached.",
      });
    } finally {
      window.clearTimeout(timeout);
      setChecking(false);
    }
  }, [serverURL]);

  useEffect(() => {
    if (!isServerMode() || serverURL == null) return;
    void check();
    const interval = window.setInterval(
      () => void check(),
      HEALTH_CHECK_INTERVAL_MS,
    );
    const handleOnline = () => void check();
    const handleOffline = () => setFailure({ kind: "offline" });
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [attempt, check, serverURL]);

  if (failure == null) return null;

  const offline = failure.kind === "offline";
  return (
    <aside
      className={`host-availability${offline ? " is-offline" : ""}`}
      role="alert"
      aria-live="assertive"
    >
      <div>
        <strong>{offline ? "This device is offline" : "Server connection lost"}</strong>
        <p>
          {offline
            ? "Reconnect this device to the internet or your home network, then retry."
            : `${failure.message} The host may be asleep, powered off, or unavailable on this network.`}
        </p>
        {!offline && (
          <p>
            Keep the server awake for remote streaming. For access away from
            home, follow Settings &gt; Server &gt; Remote access.
          </p>
        )}
      </div>
      <button
        type="button"
        className="host-availability-retry"
        disabled={checking}
        onClick={() => setAttempt((current) => current + 1)}
      >
        {checking ? "Checking" : "Retry"}
      </button>
    </aside>
  );
}
