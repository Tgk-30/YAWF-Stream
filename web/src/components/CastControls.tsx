import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  castController,
  useCastState,
  type CastMedia,
  type CastPhase,
} from "../lib/cast";
import { isTauri, type CastDevice } from "../lib/tauri";
import { Icon } from "./Icon";
import "./CastControls.css";

interface CastControlsProps {
  media: CastMedia;
  buttonClassName: string;
  onLocalPlaybackChange?: (suspended: boolean) => void;
}

export interface CastDevicePickerProps {
  phase: Extract<CastPhase, "discovering" | "selecting" | "loading" | "error">;
  devices: CastDevice[];
  device: CastDevice | null;
  error: string | null;
  onSelect: (device: CastDevice) => void;
  onRetry: () => void;
  onClose: () => void;
}

/** Pure picker surface, exported so its list, empty state, and retry stay testable. */
export function CastDevicePicker({
  phase,
  devices,
  device,
  error,
  onSelect,
  onRetry,
  onClose,
}: CastDevicePickerProps) {
  const busy = phase === "discovering" || phase === "loading";
  return (
    <div className="cast-picker-scrim" onClick={busy ? undefined : onClose}>
      <section
        className="cast-picker glass-raised"
        role="dialog"
        aria-modal="true"
        aria-label="Cast to a device"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="cast-picker-heading">
          <div>
            <span className="cast-eyebrow">DLNA / UPnP</span>
            <h2>Cast to a device</h2>
          </div>
          {!busy && (
            <button
              type="button"
              className="cast-icon-button"
              onClick={onClose}
              aria-label="Close cast device picker"
            >
              <Icon name="xmark" size={18} />
            </button>
          )}
        </div>

        {phase === "discovering" && (
          <div className="cast-picker-message" role="status">
            <span className="cast-spinner" aria-hidden />
            Searching your network for TVs and media renderers...
          </div>
        )}

        {phase === "loading" && (
          <div className="cast-picker-message" role="status">
            <span className="cast-spinner" aria-hidden />
            Connecting to {device?.name ?? "device"}...
          </div>
        )}

        {phase === "selecting" && devices.length > 0 && (
          <div className="cast-device-list" role="list">
            {devices.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="cast-device-row"
                onClick={() => onSelect(candidate)}
              >
                <span className="cast-device-icon">
                  <Icon name="cast" size={19} />
                </span>
                <span>{candidate.name}</span>
                <Icon name="play" size={14} />
              </button>
            ))}
          </div>
        )}

        {phase === "selecting" && devices.length === 0 && (
          <div className="cast-picker-empty">
            <Icon name="cast" size={28} />
            <p>No cast devices found on your network</p>
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={14} />
              Retry
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="cast-picker-empty" role="alert">
            <Icon name="info" size={26} />
            <p>{error ?? "Could not connect to the cast device."}</p>
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={14} />
              Retry discovery
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function CastingBar() {
  const state = useCastState();
  if (state.phase !== "casting" || state.device == null) return null;
  const playing = state.status?.state === "PLAYING";
  const position = state.status?.positionSecs ?? 0;
  const duration = state.status?.durationSecs ?? 0;
  return (
    <aside className="casting-bar" aria-label={`Casting to ${state.device.name}`}>
      <div className="casting-device">
        <span className="casting-indicator">
          <Icon name="cast" size={18} />
        </span>
        <span>
          <strong>CASTING</strong>
          <span>{state.device.name}</span>
        </span>
      </div>

      <div className="casting-transport">
        <button
          type="button"
          className="cast-icon-button"
          onClick={() => void castController.control(playing ? "pause" : "play")}
          aria-label={playing ? "Pause cast" : "Play cast"}
        >
          <Icon name={playing ? "pause" : "play"} size={18} filled={!playing} />
        </button>
        <span className="casting-time">{formatTime(position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          value={Math.min(position, Math.max(1, duration))}
          onChange={(event) =>
            void castController.control("seek", Number(event.target.value))
          }
          aria-label="Cast position"
        />
        <span className="casting-time">{formatTime(duration)}</span>
      </div>

      <div className="casting-actions">
        {state.device.renderingControlUrl != null && (
          <label className="casting-volume">
            <Icon name="volume" size={16} />
            <input
              type="range"
              min={0}
              max={100}
              value={state.volume}
              onChange={(event) =>
                void castController.setVolume(Number(event.target.value))
              }
              aria-label="Cast volume"
            />
          </label>
        )}
        <button
          type="button"
          className="btn cast-stop-button"
          onClick={() => void castController.stop()}
        >
          Stop casting
        </button>
      </div>
      {state.error != null && (
        <span className="casting-error" role="status">
          {state.error}
        </span>
      )}
    </aside>
  );
}

export function CastControls({
  media,
  buttonClassName,
  onLocalPlaybackChange,
}: CastControlsProps) {
  const state = useCastState();
  const available = isTauri();
  const localSuspended = state.phase === "loading" || state.phase === "casting";
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [portalOwner, setPortalOwner] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!available) return;
    // Resolve after mount: an already-active cast must not escape a player pane
    // whose parent ref was still null during render. The same owner works before
    // and during standard fullscreen, without moving or duplicating controls.
    const player = buttonRef.current?.closest(".player");
    setPortalOwner(player instanceof HTMLElement ? player : document.body);
  }, [available]);

  useEffect(() => {
    onLocalPlaybackChange?.(localSuspended);
    return () => onLocalPlaybackChange?.(false);
  }, [localSuspended, onLocalPlaybackChange]);

  if (!available) return null;
  const pickerPhase: CastDevicePickerProps["phase"] | null =
    state.phase === "discovering" ||
    state.phase === "selecting" ||
    state.phase === "loading" ||
    state.phase === "error"
      ? state.phase
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${buttonClassName}${state.phase === "casting" ? " is-active" : ""}`}
        onClick={() => {
          if (state.phase === "idle") void castController.discover();
        }}
        aria-label={
          state.phase === "casting"
            ? `Casting to ${state.device?.name ?? "device"}`
            : "Cast to a device"
        }
        aria-pressed={state.phase === "casting"}
        title="Cast to a DLNA device"
      >
        <Icon name="cast" size={18} />
      </button>

      {pickerPhase != null && portalOwner != null &&
        createPortal(
          <CastDevicePicker
            phase={pickerPhase}
            devices={state.devices}
            device={state.device}
            error={state.error}
            onSelect={(device) => void castController.load(device, media)}
            onRetry={() => void castController.discover()}
            onClose={() => castController.dismissPicker()}
          />,
          portalOwner,
        )}

      {state.phase === "casting" && portalOwner != null &&
        createPortal(<CastingBar />, portalOwner)}
    </>
  );
}

// MVP scope: only TV-reachable public HTTP debrid stream URLs are cast. Local
// downloaded files need a local media server and are intentionally out of scope.
