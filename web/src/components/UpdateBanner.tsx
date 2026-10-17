// UpdateBanner - the in-app auto-update prompt.
//
// Mounted once from App.tsx. On mount it runs the launch-time update check
// (checkForUpdates), which is a no-op in a plain browser (isTauri-gated inside
// updater.ts) - so in the browser this component renders nothing and has no
// effect. Under the desktop Tauri shell, when a newer signed release is
// available it slides a small non-blocking glass toast in from the bottom-right.
// A hosted server bundle whose audited native ABI floor is newer than the native
// package gets a blocking, non-dismissible compatibility update. Server or
// Android-only version bumps do not raise that floor. Installing applies the
// update and then relaunches the app. Optional failures remain dismissible;
// compatibility failures stay blocking until native compatibility is restored.

import { useEffect, useRef, useState } from "react";
import {
  checkForUpdates,
  markUpdateChecked,
  updateCheckAgeMs,
  WEEKLY_UPDATE_CHECK_MS,
  type PendingUpdate,
  type UpdateCheckResult,
} from "../lib/updater";
import { isNetworkAllowed } from "../lib/networkPolicy";
import type { NetworkMode } from "../lib/networkPolicy";
import {
  compareAppVersions,
  DESKTOP_NATIVE_COMPATIBILITY_FLOOR,
  getNativeAppVersion,
  requiresDesktopNativeUpdate,
} from "../lib/appVersion";
import { isDesktopTauri, isTauri } from "../lib/tauri";
import { Icon } from "./Icon";
import "./UpdateBanner.css";

type Phase = "checking" | "idle" | "installing" | "error";

type CompatibilityRequirement = {
  currentVersion: string;
  compatibilityFloor: string;
};

type FailureReason =
  | "no-compatible-release"
  | "privacy-blocked"
  | "check-failed"
  | "install-failed";

// How often the running app re-evaluates whether a weekly check is due. The
// actual network check is gated on WEEKLY_UPDATE_CHECK_MS having elapsed, so
// this poll interval only bounds how promptly a long-running instance notices
// the week has passed - it does not itself hit the network every 6h.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

export function UpdateBanner({
  autoCheck,
  autoInstall,
  networkMode = "standard",
  nativeCompatibilityFloor = DESKTOP_NATIVE_COMPATIBILITY_FLOOR,
}: {
  autoCheck: boolean;
  autoInstall: boolean;
  networkMode?: NetworkMode;
  /** Audited native ABI floor, independent from the rendered UI version. */
  nativeCompatibilityFloor?: string;
}) {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [compatibility, setCompatibility] =
    useState<CompatibilityRequirement | null>(null);
  const [failureReason, setFailureReason] = useState<FailureReason | null>(null);
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
  // Share an in-flight feed request across effect refreshes and foreground
  // signals. This prevents duplicate network checks without accepting stale UI.
  const checkPromiseRef = useRef<Promise<UpdateCheckResult> | null>(null);
  // Installation is not safely repeatable. Keep one operation even if a user
  // double-clicks or an automatic path races a foreground signal.
  const installPromiseRef = useRef<Promise<void> | null>(null);
  // A queued install is still preventable when privacy changes before the
  // updater plugin starts. Once the plugin call has begun, changing policy
  // cannot truthfully claim to cancel that physical operation.
  const installStartedRef = useRef(false);
  // Event handlers from a prior render can remain queued or retained. Read the
  // current policy through a ref rather than trusting their captured props.
  const networkModeRef = useRef(networkMode);
  networkModeRef.current = networkMode;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const beginInstall = (
    pending: PendingUpdate,
    requirement: CompatibilityRequirement | null,
  ) => {
    if (installPromiseRef.current != null) return installPromiseRef.current;
    const suspendForPrivacy = () => {
      pendingRef.current = false;
      if (!mountedRef.current) return;
      setUpdate(null);
      setCompatibility(requirement);
      setFailureReason(requirement == null ? null : "privacy-blocked");
      setPhase(requirement == null ? "idle" : "error");
    };
    if (!isNetworkAllowed("updates", networkModeRef.current)) {
      suspendForPrivacy();
      return Promise.resolve();
    }
    setFailureReason(null);
    setPhase("installing");
    setProgress(0);
    const operation = Promise.resolve().then(async () => {
      // Re-check immediately before entering the updater plugin. This closes
      // the gap between a click/auto-install decision and its queued microtask.
      if (!isNetworkAllowed("updates", networkModeRef.current)) {
        suspendForPrivacy();
        return;
      }
      installStartedRef.current = true;
      await pending.install((fraction) => {
        if (mountedRef.current) setProgress(fraction);
      });
    });
    installPromiseRef.current = operation;
    void operation
      .catch(() => {
        if (!isNetworkAllowed("updates", networkModeRef.current)) {
          suspendForPrivacy();
          return;
        }
        if (mountedRef.current) {
          setCompatibility(requirement);
          setFailureReason("install-failed");
          setPhase("error");
        }
      })
      .finally(() => {
        installStartedRef.current = false;
        if (installPromiseRef.current === operation) {
          installPromiseRef.current = null;
        }
      });
    return operation;
  };

  // Hide an optional update as soon as its download becomes disallowed. Keep
  // a mandatory compatibility gate visible with the precise privacy reason.
  // An updater call that already started remains represented as installing,
  // because a policy change cannot cancel work already admitted to the plugin.
  useEffect(() => {
    if (
      isNetworkAllowed("updates", networkMode) ||
      installStartedRef.current
    ) {
      return;
    }
    pendingRef.current = false;
    setUpdate(null);
    if (compatibility == null) {
      setFailureReason(null);
      setPhase("idle");
    } else {
      setFailureReason("privacy-blocked");
      setPhase("error");
    }
  }, [compatibility, networkMode]);

  // Check on launch, then re-check weekly for long-running instances. A hosted
  // bundle only blocks when its audited native ABI floor is above the installed
  // desktop. A mandatory recovery check can bypass autoCheck, but installation
  // still follows autoInstall and network privacy is always honored.
  useEffect(() => {
    // Native Android owns its independent APK channel, never the server version.
    if (isTauri() && !isDesktopTauri()) return;
    let cancelled = false;

    const sharedCheck = (): Promise<UpdateCheckResult> => {
      const existing = checkPromiseRef.current;
      if (existing != null) return existing;
      const request = checkForUpdates(networkMode);
      checkPromiseRef.current = request;
      void request.finally(() => {
        if (checkPromiseRef.current === request) checkPromiseRef.current = null;
      });
      return request;
    };

    const runCheck = async (
      requirement: CompatibilityRequirement | null = null,
    ) => {
      if (installStartedRef.current) return;
      const updateNetworkAllowed = isNetworkAllowed("updates", networkMode);
      if (requirement == null && (!autoCheck || !updateNetworkAllowed)) return;
      if (requirement != null) {
        setCompatibility(requirement);
        setUpdate(null);
        if (!updateNetworkAllowed) {
          setFailureReason("privacy-blocked");
          setPhase("error");
          return;
        }
        setFailureReason(null);
        setPhase("checking");
      }
      const result = await sharedCheck();
      if (cancelled) return;
      if (result.status !== "privacy-blocked" && result.status !== "unsupported") {
        markUpdateChecked();
      }
      if (result.status === "privacy-blocked") {
        if (requirement != null) {
          setFailureReason("privacy-blocked");
          setPhase("error");
        }
        return;
      }
      if (result.status === "check-failed") {
        if (requirement != null) {
          setFailureReason("check-failed");
          setPhase("error");
        }
        return;
      }
      if (result.status === "unsupported") return;
      if (result.status === "no-update") {
        if (requirement != null) {
          setFailureReason("no-compatible-release");
          setPhase("error");
        }
        return;
      }
      const pending = result.update;
      // A release older than the server bundle cannot satisfy its native
      // command contract. Keep the blocking recovery UI instead of relaunching
      // into another known-incompatible package.
      if (
        requirement != null &&
        compareAppVersions(pending.version, requirement.compatibilityFloor) < 0
      ) {
        setFailureReason("no-compatible-release");
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
      setFailureReason(null);
      setUpdate(pending);
      if (autoInstall) {
        void beginInstall(pending, requirement);
      } else {
        setPhase("idle");
      }
    };

    void getNativeAppVersion().then((nativeVersion) => {
      if (cancelled || installStartedRef.current) return;
      const requirement =
        nativeVersion != null &&
        requiresDesktopNativeUpdate(nativeVersion, nativeCompatibilityFloor)
          ? {
              currentVersion: nativeVersion,
              compatibilityFloor: nativeCompatibilityFloor,
            }
          : null;
      if (requirement == null) {
        setCompatibility(null);
        setFailureReason(null);
      }
      void runCheck(requirement);
    });

    // Weekly cadence: poll periodically but only actually hit the network when
    // the window is visible, nothing is already pending, and a week has elapsed
    // since the last check. Robust to timer drift/suspend - the elapsed-time
    // gate is the real control, not the interval.
    const checkIfDue = () => {
      if (
        autoCheck &&
        !document.hidden &&
        !pendingRef.current &&
        isNetworkAllowed("updates", networkMode) &&
        updateCheckAgeMs() >= WEEKLY_UPDATE_CHECK_MS
      ) {
        void runCheck();
      }
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) checkIfDue();
    };
    const poll = setInterval(checkIfDue, UPDATE_POLL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", checkIfDue);

    return () => {
      cancelled = true;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", checkIfDue);
    };
  }, [autoCheck, autoInstall, networkMode, nativeCompatibilityFloor, retryNonce]);

  if (update == null && compatibility == null) return null;

  const checking = phase === "checking";
  const installing = phase === "installing";
  const errored = phase === "error";
  // A determinate bar when we have a fraction; otherwise an indeterminate sweep.
  const pct =
    progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
  const failureMessage = (() => {
    if (compatibility == null) {
      return `Couldn't install v${update?.version}. Try again later.`;
    }
    switch (failureReason) {
      case "no-compatible-release":
        return `No signed desktop update compatible with native floor v${compatibility.compatibilityFloor} is published yet. Desktop v${compatibility.currentVersion} remains blocked.`;
      case "privacy-blocked":
        return "Desktop update checks are blocked by Network Privacy mode. Allow update checks, then retry.";
      case "check-failed":
        return "The signed desktop release feed could not be checked. Check your network, then retry.";
      case "install-failed":
        return `Desktop update v${update?.version} could not be installed. Retry the signed update.`;
      default:
        return `Desktop v${compatibility.currentVersion} is below the required native compatibility floor v${compatibility.compatibilityFloor}.`;
    }
  })();

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
              Desktop v{compatibility?.currentVersion} is below native
              compatibility floor v{compatibility?.compatibilityFloor}.
            </span>
          </>
        ) : errored ? (
          <>
            <span className="update-banner-title">
              {compatibility != null ? "Desktop update required" : "Update failed"}
            </span>
            <span className="update-banner-sub t-secondary">
              {failureMessage}
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
              {compatibility != null
                ? `Install this signed update to meet native compatibility floor v${compatibility.compatibilityFloor}.`
                : "A new version of YAWF Stream is ready to install."}
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
              if (failureReason === "install-failed" && update != null) {
                void beginInstall(update, compatibility);
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
              onClick={() => {
                if (update != null) void beginInstall(update, compatibility);
              }}
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
