import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPhoneRemoteState,
  pairPhoneRemote,
  sendPhoneRemoteCommand,
  type PhoneRemoteSession,
  type RemoteCommandType,
  type RemotePlaybackState,
} from "../lib/serverApi";
import { useServerSession } from "../lib/ServerSessionContext";
import "./TVRemote.css";

const STORAGE_KEY = "yawf_phone_remote";

function loadSession(): PhoneRemoteSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<PhoneRemoteSession>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.controllerToken !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      parsed.state == null
    ) {
      return null;
    }
    return parsed as PhoneRemoteSession;
  } catch {
    return null;
  }
}

function saveSession(session: PhoneRemoteSession | null): void {
  try {
    if (session == null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A private browsing session can remain usable without persistence.
  }
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function PhoneRemote() {
  const account = useServerSession();
  const [code, setCode] = useState("");
  const [remote, setRemote] = useState<PhoneRemoteSession | null>(loadSession);
  const [state, setState] = useState<RemotePlaybackState | null>(
    () => remote?.state ?? null,
  );
  const [status, setStatus] = useState<string | null>(null);

  const pair = async () => {
    setStatus("Pairing…");
    try {
      const next = await pairPhoneRemote({
        code,
        controllerName:
          (
            navigator as Navigator & {
              userAgentData?: { platform?: string };
            }
          ).userAgentData?.platform || navigator.platform || "Phone remote",
      });
      setRemote(next);
      setState(next.state);
      saveSession(next);
      setStatus("Connected");
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (remote == null) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await fetchPhoneRemoteState(remote);
        if (!stopped) {
          setState(next);
          setStatus("Connected");
        }
      } catch (reason) {
        if (!stopped) {
          setStatus(reason instanceof Error ? reason.message : String(reason));
          setRemote(null);
          saveSession(null);
        }
        return;
      }
      if (!stopped) timer = window.setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [remote]);

  const send = useCallback(
    async (type: RemoteCommandType, value?: number | boolean) => {
      if (remote == null) return;
      try {
        await sendPhoneRemoteCommand(remote, {
          type,
          ...(value === undefined ? {} : { value }),
        });
      } catch (reason) {
        setStatus(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [remote],
  );

  const progress = useMemo(() => {
    if (state?.durationSeconds == null || state.durationSeconds <= 0) return 0;
    return Math.min(100, Math.max(0, (state.positionSeconds / state.durationSeconds) * 100));
  }, [state]);

  if (account == null) return null;

  return (
    <main className="phone-remote">
      <header>
        <span className="tv-pairing-eyebrow">YAWF Stream</span>
        <h1>Phone remote</h1>
        <p>Control a TV browser without sending its stream through this phone.</p>
      </header>

      {remote == null ? (
        <section className="phone-remote-card glass-raised">
          <label htmlFor="pairing-code">Code shown on the TV</label>
          <input
            id="pairing-code"
            className="phone-remote-code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            placeholder="000000"
          />
          <button
            type="button"
            className="btn btn-prominent"
            disabled={code.length !== 6}
            onClick={() => void pair()}
          >
            Pair remote
          </button>
          {status != null && <p role="status">{status}</p>}
        </section>
      ) : (
        <section className="phone-remote-card glass-raised">
          <div className="phone-remote-now">
            <span className="tv-pairing-eyebrow">Now playing</span>
            <h2>{state?.title ?? "Nothing playing"}</h2>
            {state?.subtitle != null && <p>{state.subtitle}</p>}
          </div>
          <div
            className="phone-remote-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state?.durationSeconds ?? 0}
            aria-valuenow={state?.positionSeconds ?? 0}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="phone-remote-clock">
            <span>{formatClock(state?.positionSeconds ?? 0)}</span>
            <span>{formatClock(state?.durationSeconds ?? 0)}</span>
          </div>
          <div className="phone-remote-controls">
            <button type="button" onClick={() => void send("seek-relative", -10)}>
              −10s
            </button>
            <button
              type="button"
              className="phone-remote-primary"
              onClick={() => void send(state?.playing ? "pause" : "play")}
            >
              {state?.playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => void send("seek-relative", 10)}>
              +10s
            </button>
            <button
              type="button"
              onClick={() => void send("volume", Math.max(0, (state?.volume ?? 1) - 0.1))}
            >
              Volume −
            </button>
            <button
              type="button"
              onClick={() => void send("mute", !(state?.muted ?? false))}
            >
              {state?.muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              onClick={() => void send("volume", Math.min(1, (state?.volume ?? 1) + 0.1))}
            >
              Volume +
            </button>
            <button type="button" onClick={() => void send("fullscreen")}>
              Fullscreen
            </button>
            <button type="button" onClick={() => void send("next")}>
              Next
            </button>
            <button type="button" onClick={() => void send("close")}>
              Close player
            </button>
          </div>
          <button
            type="button"
            className="btn phone-remote-disconnect"
            onClick={() => {
              setRemote(null);
              setState(null);
              saveSession(null);
            }}
          >
            Disconnect this phone
          </button>
          {status != null && <p role="status">{status}</p>}
        </section>
      )}
    </main>
  );
}
