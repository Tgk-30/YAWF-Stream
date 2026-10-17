// UpdateBanner - the in-app auto-update prompt.
//
// Mounted once from App.tsx. On mount it runs the launch-time update check
// (checkForUpdates), which is a no-op in a plain browser (isTauri-gated inside
// updater.ts) - so in the browser this component renders nothing and has no
// effect. Under the desktop Tauri shell, when a newer signed release is
// available it slides a small non-blocking glass toast in from the bottom-right.
// A hosted server bundle newer than the native package instead gets a blocking,
// non-dismissible compatibility update so native commands cannot drift behind
// the UI that invokes them. Installing downloads + applies the update
// (showing a determinate progress bar, or an indeterminate one when the server
// didn't send a content length) and then relaunches the app. Failures surface a
// dismissible "Update failed" state; the user can dismiss at any point.

import { useEffect, useRef, useState } from "react";
import {
  checkForUpdates,
  markUpdateChecked,
  updateCheckAgeMs,
  WEEKLY_UPDATE_CHECK_MS,
  type PendingUpdate,
} from "../lib/updater";
import { isNetworkAllowed } from "../lib/networkPolicy";
import type { NetworkMode } from "../lib/networkPolicy";
import {
  compareAppVersions,
  getNativeAppVersion,
} from "../lib/appVersion";
import { isDesktopTauri, isTauri } from "../lib/tauri";
import { Icon } from "./Icon";
import "./UpdateBanner.css";

type Phase = "checking" | "idle" | "installing" | "error";

type CompatibilityRequirement = {
  currentVersion: string;
  requiredVersion: string;
};

// How often the running app re-evaluates whether a weekly check is due. The
// actual network check is gated on WEEKLY_UPDATE_CHECK_MS having elapsed, so
// this poll interval only bounds how promptly a long-running instance notices
// the week has passed - it does not itself hit the network every 6h.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

export function UpdateBanner({
  autoCheck,
  autoInstall,
  networkMode = "standard",
  requiredVersion = __APP_VERSION__,
}: {
  autoCheck: boolean;
  autoInstall: boolean;
  networkMode?: NetworkMode;
  /** Version of the currently rendered UI bundle. On a server-hosted page this
   * is the server release, while getNativeAppVersion reads the laptop binary. */
  requiredVersion?: string;
}) {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [compatibility, setCompatibility] =
    useState<CompatibilityRequirement | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /** 0..1 install fraction, or null for an indeterminate (unknown-size) bar. */
  const [progress, setProgress] = useState<number | null>(0);

  // The version the user dismissed this session - so the weekly re-check doesn't
  // re-surface the SAME version, but a LATER one still gets through. A ref (not
  // state) so the check closure reads the current value without re-running.
  const dismissedVersionRef = useRef<string | null>(null);
  // True while an update is actively surfaced/installing so the weekly poll
  // doesn't re-check over the top of it. Cleared on dismiss so the poll resumes.
  const pendingRef = useRef(false);

  // Check on launch, then re-check weekly for long-running instances. A hosted
  // server bundle newer than the native package is a mandatory compatibility
  // update: it checks and installs even when optional automatic checks or
  // installs are disabled. The active network privacy mode is still honored.
  useEffect(() => {
    // Native Android owns its independent APK channel, never the server version.
    if (isTauri() && !isDesktopTauri()) return;
    let cancelled = false;

    const beginInstall = (
      pending: PendingUpdate,
      requirement: CompatibilityRequirement | null,
    ) => {
      setPhase("installing");
      setProgress(0);
      void pending.install((fraction) => setProgress(fraction)).catch(() => {
        if (!cancelled) {
          setCompatibility(requirement);
          setPhase("error");
        }
      });
    };

    const runCheck = async (
      requirement: CompatibilityRequirement | null = null,
    ) => {
      const updateNetworkAllowed = isNetworkAllowed("updates", networkMode);
      if (requirement == null && (!autoCheck || !updateNetworkAllowed)) return;
      if (requirement != null) {
        setCompatibility(requirement);
        setPhase(updateNetworkAllowed ? "checking" : "error");
        if (!updateNetworkAllowed) return;
      }
      markUpdateChecked();
      const pending = await checkForUpdates();
      if (cancelled) return;
      if (pending == null) {
        if (requirement != null) setPhase("error");
        return;
      }
      // A release older than the server bundle cannot satisfy its native
      // command contract. Keep the blocking recovery UI instead of relaunching
      // into another known-incompatible package.
      if (
        requirement != null &&
        compareAppVersions(pending.version, requirement.requiredVersion) < 0
      ) {
        setPhase("error");
        return;
      }
      // Don't re-surface a version the user already dismissed this session; a
      // newer version still gets through. Compatibility updates are never
      // dismissible, so they deliberately ignore this optional-update state.
      if (
        requirement == null &&
        pending.version === dismissedVersionRef.current
      ) {
        return;
      }
      pendingRef.current = true;
      setUpdate(pending);
      if (requirement != null || autoInstall) {
        beginInstall(pending, requirement);
      } else {
        setPhase("idle");
      }
    };

    void getNativeAppVersion().then((nativeVersion) => {
      if (cancelled) return;
      const requirement =
        nativeVersion != null &&
        compareAppVersions(nativeVersion, requiredVersion) < 0
          ? { currentVersion: nativeVersion, requiredVersion }
          : null;
      void runCheck(requirement);
    });

    // Weekly cadence: poll periodically but only actually hit the network when
    // the window is visible, nothing is already pending, and a week has elapsed
    // since the last check. Robust to timer drift/suspend - the elapsed-time
    // gate is the real control, not the interval.
    const poll = setInterval(() => {
      if (
        autoCheck &&
        !document.hidden &&
        !pendingRef.current &&
        isNetworkAllowed("updates", networkMode) &&
        updateCheckAgeMs() >= WEEKLY_UPDATE_CHECK_MS
      ) {
        void runCheck();
      }
    }, UPDATE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [autoCheck, autoInstall, networkMode, requiredVersion, retryNonce]);

  if (update == null && compatibility == null) return null;

  async function install() {
    if (update == null) return;
    setPhase("installing");
    setProgress(0);
    try {
      // On success the app relaunches and this never resolves.
      await update.install((fraction) => setProgress(fraction));
    } catch {
      setPhase("error");
    }
  }

  const checking = phase === "checking";
  const installing = phase === "installing";
  const errored = phase === "error";
  // A determinate bar when we have a fraction; otherwise an indeterminate sweep.
  const pct =
    progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;

  const banner = (
    <div
      className={`update-banner glass-raised glass-lit${compatibility != null ? " is-compatibility" : ""}`}
      role={compatibility != null ? "alertdialog" : "status"}
      aria-modal={compatibility != null ? true : undefined}
      aria-label={compatibility != null ? "Desktop update required" : undefined}
      aria-live="polite"
    >
      <div className="update-banner-icon">
        <Icon name={errored ? "info" : "sparkles"} size={18} className="t-accent" />
      </div>

      <div className="update-banner-body">
        {checking ? (
          <>
            <span className="update-banner-title">Checking desktop update…</span>
            <span className="update-banner-sub t-secondary">
              Server v{compatibility?.requiredVersion} requires a newer desktop app.
            </span>
          </>
        ) : errored ? (
          <>
            <span className="update-banner-title">
              {compatibility != null ? "Desktop update required" : "Update failed"}
            </span>
            <span className="update-banner-sub t-secondary">
              {compatibility != null
                ? `Desktop v${compatibility.currentVersion} cannot run the server v${compatibility.requiredVersion} native features. Check your connection or network privacy mode, then retry.`
                : `Couldn't install v${update?.version}. Try again later.`}
            </span>
          </>
        ) : installing ? (
          <>
            <span className="update-banner-title">
              {pct != null ? `Installing… ${pct}%` : "Installing…"}
            </span>
            <div
              className={`update-banner-progress${pct == null ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
            >
              <div
                className="update-banner-progress-fill"
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
          </>
        ) : (
          <>
            <span className="update-banner-title">
              Update v{update?.version} available
            </span>
            <span className="update-banner-sub t-secondary">
              A new version of YAWF Stream is ready to install.
            </span>
          </>
        )}
      </div>

      <div className="update-banner-actions">
        {errored ? (
          <button
            type="button"
            className="btn btn-prominent update-banner-install"
            onClick={() => {
              if (update != null) {
                void install();
              } else {
                setRetryNonce((value) => value + 1);
              }
            }}
          >
            Retry
          </button>
        ) : (
          !checking && !installing && (
            <button
              type="button"
              className="btn btn-prominent update-banner-install"
              onClick={() => void install()}
            >
              Install
            </button>
          )
        )}

        {!checking && !installing && compatibility == null && (
          <button
            type="button"
            className="update-banner-dismiss"
            onClick={() => {
              // Remember this version so the weekly poll won't re-surface it, and
              // free the poll to look for a later one.
              dismissedVersionRef.current = update?.version ?? null;
              pendingRef.current = false;
              setUpdate(null);
            }}
            aria-label="Dismiss update notification"
            title="Dismiss"
          >
            <Icon name="xmark" size={15} />
          </button>
        )}
      </div>
    </div>
  );

  return compatibility != null ? (
    <div className="update-compatibility-backdrop">{banner}</div>
  ) : (
    banner
  );
}
