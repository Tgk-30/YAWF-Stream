// In-app player.
//
// Two-backend playback:
//   1. In-webview <video> for HLS (.m3u8, via hls.js when the browser lacks
//      native HLS) and progressive MP4/WebM - the browser path.
//   2. Desktop hand-off to a native player (VLC/mpv/IINA) for containers/codecs
//      the webview can't decode (MKV / HEVC) - only when running under Tauri,
//      via the `open_in_external_player` Rust command. In a plain browser this
//      path shows an "open externally" note instead.
//
// `kind` lets the caller force the external path (e.g. an MKV stream); otherwise
// the extension is sniffed from the URL.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
// Type-only: the runtime module is imported on demand inside the HLS effect
// below, so this import contributes no bytes to the chunk.
import type HlsType from "hls.js";
type HlsInstance = InstanceType<typeof HlsType>;
import { Icon } from "./Icon";
import {
  isTauri,
  openInExternalPlayer,
  playWithMpv,
  mpvStop,
} from "../lib/tauri";
import { deviceKind } from "../lib/platform";
import type { SubtitleClient } from "../services/subtitles/OpenSubtitlesClient";
import type { Translator } from "../services/subtitles/SubtitleTranslator";
import { useSubtitleTracks } from "./player/useSubtitleTracks";
import { useScrubThumbnails } from "./player/useScrubThumbnails";
import { useWakeLock } from "./player/useWakeLock";
import { useTVRemotePlayback } from "./player/useTVRemotePlayback";
import { ScrubBar } from "./player/ScrubBar";
import { CaptionsMenu } from "./player/CaptionsMenu";
import { EmbeddedPlayer } from "./EmbeddedPlayer";
import { CastControls } from "./CastControls";
import type { PlaybackPrefs } from "../storage/models";
import {
  currentViewportPixelSize,
  type PixelSize,
  type PlaybackEngine,
} from "../lib/playbackEngine";
import { PlayerInfoPopover } from "./player/PlayerInfoPopover";
import {
  PlayerPauseOverlay,
  type NowPlayingMetadata,
} from "./player/PlayerPauseOverlay";
import { registerPlayerMount } from "../lib/attention";
import { recordDiagnostic } from "../lib/diagnostics";
import { mediaErrorMessage, nextHlsRecovery } from "../lib/playerReliability";
import { findPreferredLanguageMatch } from "../lib/languagePreference";
import { useModalA11y } from "./useModalA11y";
import {
  scrobblePlaybackPause,
  scrobblePlaybackStart,
  scrobblePlaybackStop,
  type TraktScrobbleContext,
} from "../data/traktScrobble";
import {
  hasAndroidTVBridge,
  startAndroidTVPlayback,
  stopAndroidTVPlayback,
  type AndroidTVPlaybackProgress,
} from "../lib/androidTV";
import "./VideoPlayer.css";

type Playability = "webview" | "external";

/**
 * Optional global defaults supplied by Settings. Per-title values take
 * precedence only when `rememberPerTitleTrackChoices` is enabled.
 */
export interface PlayerPreferenceDefaults {
  defaultAudioLanguage?: string | null;
  defaultSubtitleLanguage?: string | null;
  defaultSubtitleBehavior?: "off" | "preferred";
  defaultPlaybackSpeed?: number | null;
  /** 0 through 100. The web player converts this to HTMLMediaElement's 0..1. */
  defaultVolume?: number | null;
  rememberPerTitleTrackChoices?: boolean;
}

interface VideoPlayerProps {
  url: string;
  /** Human-facing media metadata. Never pass the raw resolved file here when
   * metadata is available. */
  title: string;
  /** Series context shown beneath the show title. */
  subtitle?: string | null;
  /** Optional Detail metadata used by the paused now-playing treatment. */
  nowPlaying?: NowPlayingMetadata | null;
  /** Raw resolved filename, confined to Playback information. */
  sourceFileName?: string | null;
  /** Short-lived server stream capability for native playback only. */
  playbackAuthorization?: string;
  /** Force a path; when omitted it's sniffed from the URL extension. */
  kind?: Playability;
  /** Explicit renderer identity. Detail always supplies this; inference remains
   * for isolated callers and backwards compatibility. */
  engine?: PlaybackEngine;
  /** Native built-in failure fallback. Called only after libmpv fails, never on
   * the normal native path, so lossless playback starts without transcode delay. */
  requestWebviewFallback?: () => Promise<string | null>;
  /** Cookie-free, stream-scoped URL for a native player launched by the hosted
   * web app. Server Mode uses `/api/external-stream/*`; local mode may pass the
   * resolved source directly. */
  externalPlaybackUrl?: string | null;
  onClose: () => void;
  /** Reports playback progress (seconds watched + total duration) so the store
   * can persist a resume position. Called periodically and on close. */
  onProgress?: (
    currentSeconds: number,
    durationSeconds: number | null,
    prefs?: PlaybackPrefs,
  ) => void;
  /** Resume position (seconds) from the saved watch history. The in-webview
   * player seeks here once, on first metadata load - making cross-device resume
   * actually pick up where you left off. 0/undefined starts from the beginning. */
  startPositionSeconds?: number;
  /** Original-media time represented by time zero in a seek-offset server
   * transcode. Progress, clocks, and scrobbling are mapped back to the original
   * timeline while the media element continues to seek within the HLS window. */
  timelineOffsetSeconds?: number;
  /** Remembered audio/subtitle/speed for this title (in-window player only). */
  savedPrefs?: PlaybackPrefs | null;
  /** Optional global player defaults. Settings owns persistence and supplies this. */
  playerPreferences?: PlayerPreferenceDefaults | null;
  /** Subtitle source (local OpenSubtitles client or the Server-Mode client) when
   * available - powers subtitle search. Null disables the search UI. */
  subtitleClient?: SubtitleClient | null;
  /** Subtitle translator (local or Server-Mode) when available - powers subtitle
   * translation. Null hides the translate action. */
  translator?: Translator | null;
  /** Auto-seed context for the captions search. */
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Immutable TMDB playback identity, snapshotted by Detail when Play opens. */
  scrobbleContext?: TraktScrobbleContext | null;
  /** Next-episode context: when set, an "Up next" card appears at video end.
   *  Null/omitted (movies, finale, setting off) renders nothing. */
  upNext?: { label: string } | null;
  /** Play the next episode (the card's action + the countdown target). */
  onPlayNext?: () => void;
  /** Resolve and continue with the next compatible instant source after a
   * playback failure. */
  onTryNextSource?: () => Promise<void>;
  /** Whether the card auto-plays after a countdown (false under Data Saver - 
   *  nothing plays without a click). */
  autoCountdown?: boolean;
  /** Chosen external player name (Settings). Passed to the VLC/IINA/mpv hand-off
   *  so it opens the user's preferred app first. "" / undefined = auto order. */
  preferredPlayer?: string;
  /** Desktop only: use the in-window libmpv player for containers the webview
   *  cannot decode. When false, use the bundled mpv or an external player. */
  useBuiltInPlayer?: boolean;
}

function playbackDecisionFor(
  engine: PlaybackEngine,
  url: string,
): "Direct Play" | "Transcode" {
  if (
    engine === "webview-hls-transcode" ||
    /\/api\/stream\/[^/?#]+\/index\.m3u8(?:[?#]|$)/i.test(url)
  ) {
    return "Transcode";
  }
  return "Direct Play";
}

interface WebKitVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitSetPresentationMode?: (
    mode: "inline" | "picture-in-picture" | "fullscreen",
  ) => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
  webkitShowPlaybackTargetPicker?: () => void;
}

interface WebKitDocument extends Document {
  webkitFullscreenElement?: Element | null;
}

interface WebKitPlaybackTargetAvailabilityEvent extends Event {
  availability?: "available" | "not-available";
}

interface LockableScreenOrientation extends ScreenOrientation {
  lock?: (orientation: "landscape") => Promise<void>;
}

function lockLandscapeOrientation(): void {
  const kind = deviceKind();
  if (kind !== "ios" && kind !== "android") return;
  const orientation = screen.orientation as LockableScreenOrientation | undefined;
  if (typeof orientation?.lock === "function") {
    try {
      void orientation.lock("landscape").catch(() => {});
    } catch {
      // Orientation locking is optional and commonly permission-gated.
    }
  }
}

function unlockOrientation(): void {
  const orientation = screen.orientation as LockableScreenOrientation | undefined;
  if (typeof orientation?.unlock === "function") {
    try {
      orientation.unlock();
    } catch {
      // Best-effort cleanup for engines with a partial orientation API.
    }
  }
}

/** Toggle fullscreen on the player stage. iPhone Safari exposes its video-only
 * WebKit API instead of the standard container fullscreen API. */
function toggleFullscreen(el: HTMLElement, video?: HTMLVideoElement): void {
  const d = document as WebKitDocument;
  const active = document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  if (active != null) {
    const exit = document.exitFullscreen?.();
    if (exit != null) void exit.catch(() => {});
    return;
  }
  if (typeof el.requestFullscreen === "function") {
    try {
      void el.requestFullscreen().then(lockLandscapeOrientation).catch(() => {});
    } catch {
      // Browser rejected the gesture or exposes a partial fullscreen API.
    }
    return;
  }
  const webkitVideo = video as WebKitVideoElement | undefined;
  if (
    webkitVideo?.webkitSupportsFullscreen === true &&
    typeof webkitVideo.webkitEnterFullscreen === "function"
  ) {
    // Must remain in this gesture-triggered path: iPhone rejects delayed calls.
    try {
      webkitVideo.webkitEnterFullscreen();
      lockLandscapeOrientation();
    } catch {
      // WebKit can reject this when the media is not ready for native fullscreen.
    }
  }
}

/** True when a keystroke should be left to the focused control: a text field, or
 * the <video> itself whose native controls already handle the key. */
function shouldIgnoreShortcut(
  target: EventTarget | null,
  video: HTMLVideoElement,
): boolean {
  if (target === video) return true;
  const el = target as HTMLElement | null;
  if (el == null) return false;
  const tag = el.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    // A focused button/link owns Space/Enter - don't hijack it for play/pause.
    tag === "BUTTON" ||
    tag === "A" ||
    el.isContentEditable
  ) {
    return true;
  }
  const role = el.getAttribute?.("role");
  return (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "checkbox" ||
    role === "switch" ||
    role === "tab"
  );
}

/** Decide whether the webview can plausibly play this URL or whether it needs a
 * native player. MKV / HEVC / AVI etc. are handed off; HLS / MP4 / WebM play
 * in-webview. */
function classify(url: string): Playability {
  const lower = url.split("?")[0].toLowerCase();
  if (lower.endsWith(".m3u8") || lower.endsWith(".mp4") || lower.endsWith(".m4v") || lower.endsWith(".webm") || lower.endsWith(".mov")) {
    return "webview";
  }
  if (lower.endsWith(".mkv") || lower.endsWith(".avi") || lower.endsWith(".ts") || lower.endsWith(".wmv") || lower.endsWith(".flv")) {
    return "external";
  }
  // Unknown extension (e.g. a debrid direct link without one): attempt webview.
  return "webview";
}

function inferEngine(url: string, kind?: Playability): PlaybackEngine {
  const mode = kind ?? classify(url);
  if (mode === "external") return "native-mpv";
  return url.split("?")[0].toLowerCase().endsWith(".m3u8")
    ? "webview-hls-transcode"
    : "webview-direct";
}

function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

/** Browsers cannot spawn arbitrary local executables. A tiny M3U file is the
 * interoperable handoff understood by VLC, IINA, mpv frontends, and the OS
 * "open with" picker. Its URL is a stream-scoped capability, never a session
 * cookie or debrid credential. */
function downloadExternalPlaylist(url: string, title: string): void {
  const safeTitle = title.replace(/[\r\n]+/g, " ").trim() || "YAWF Stream";
  const body = `#EXTM3U\n#EXTINF:-1,${safeTitle}\n${url}\n`;
  const blob = new Blob([body], { type: "audio/x-mpegurl" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${safeTitle.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "yawf-stream"}.m3u`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/** Return the Trakt percentage at a lifecycle event, never a progress-tick. */
function playbackProgressPct(current: number, duration: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (current / duration) * 100));
}

interface WebviewScrubberHandle {
  setCurrentTime(time: number): void;
}

interface HlsLevelChoice {
  index: number;
  label: string;
}

interface HlsAudioChoice {
  index: number;
  label: string;
  language: string | null;
}

/** Keep media-clock updates local to the scrub bar. Browser `timeupdate` fires
 * about four times per second; captions, help controls, and the video shell do
 * not need to reconcile for each tick. */
const WebviewScrubber = memo(
  forwardRef<
    WebviewScrubberHandle,
    Omit<React.ComponentProps<typeof ScrubBar>, "currentTime"> & { active: boolean }
  >(function WebviewScrubber({ duration, active, ...props }, ref) {
    const [currentTime, setCurrentTime] = useState(0);
    const latestTimeRef = useRef(0);
    const activeRef = useRef(active);
    activeRef.current = active;

    const flush = useCallback(() => {
      const next = latestTimeRef.current;
      setCurrentTime((current) => (current === next ? current : next));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setCurrentTime(time) {
          latestTimeRef.current = time;
          if (activeRef.current) flush();
        },
      }),
      [flush],
    );

    useEffect(() => {
      if (active) flush();
    }, [active, flush]);

    return <ScrubBar {...props} duration={duration} currentTime={currentTime} />;
  }),
);

export function VideoPlayer({
  url,
  title,
  subtitle,
  nowPlaying,
  sourceFileName,
  playbackAuthorization,
  kind,
  engine,
  requestWebviewFallback,
  externalPlaybackUrl,
  onClose,
  onProgress,
  startPositionSeconds,
  timelineOffsetSeconds = 0,
  savedPrefs,
  subtitleClient,
  translator,
  imdbId,
  season,
  episode,
  scrobbleContext = null,
  upNext = null,
  onPlayNext,
  onTryNextSource,
  autoCountdown = true,
  playerPreferences = null,
  preferredPlayer,
  useBuiltInPlayer = true,
}: VideoPlayerProps) {
  const requestedEngine = engine ?? inferEngine(url, kind);
  const [fallbackSource, setFallbackSource] = useState<{
    originUrl: string;
    originEngine: PlaybackEngine;
    url: string;
  } | null>(null);
  const activeFallback =
    fallbackSource?.originUrl === url &&
    fallbackSource.originEngine === requestedEngine
      ? fallbackSource
      : null;
  const effectiveUrl = activeFallback?.url ?? url;
  const effectiveEngine: PlaybackEngine = activeFallback
    ? "webview-hls-transcode"
    : requestedEngine;
  const mode: Playability =
    effectiveEngine === "native-mpv" ? "external" : "webview";
  const underTauri = isTauri();
  // In-window native player: the DEFAULT desktop path for containers/codecs the
  // webview can't decode (MKV/HEVC). Renders libmpv on a native surface behind the
  // transparent window (see EmbeddedPlayer): macOS = CAOpenGLLayer render API,
  // Windows/Linux = mpv wid-embed. If the surface can't init (e.g. Wayland, or a
  // missing libmpv) the player offers a one-click external hand-off; when the user
  // opts out it's the external hand-off (VLC/IINA/…) directly.
  const dk = deviceKind();
  const useEmbedded =
    underTauri &&
    (dk === "mac" || dk === "windows" || dk === "linux") &&
    mode === "external" &&
    useBuiltInPlayer;
  const [externalStatus, setExternalStatus] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [detailsSection, setDetailsSection] = useState<"info" | "shortcuts" | null>(null);
  const [sourceSize, setSourceSize] = useState<PixelSize | null>(null);
  const [webTechnicalStats, setWebTechnicalStats] = useState<
    ReadonlyArray<readonly [string, string]>
  >([]);
  const updateWebTechnicalStats = useCallback(
    (next: ReadonlyArray<readonly [string, string]>) => {
      setWebTechnicalStats((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    },
    [],
  );
  const [displaySize, setDisplaySize] = useState<PixelSize | null>(() =>
    currentViewportPixelSize(),
  );
  const [webChromeVisible, setWebChromeVisible] = useState(true);
  const [webviewPaused, setWebviewPaused] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [castSuspended, setCastSuspended] = useState(false);
  const [webMenuOpen, setWebMenuOpen] = useState(false);
  const [webRecoveryPending, setWebRecoveryPending] = useState(false);
  const [externalActionStatus, setExternalActionStatus] = useState<string | null>(null);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [androidTVError, setAndroidTVError] = useState<string | null>(null);
  const androidTVNative = hasAndroidTVBridge();
  const androidOnCloseRef = useRef(onClose);
  const androidOnProgressRef = useRef(onProgress);
  androidOnCloseRef.current = onClose;
  androidOnProgressRef.current = onProgress;
  const [chromeHovered, setChromeHovered] = useState(false);
  const [chromeFocused, setChromeFocused] = useState(false);
  const chromeHideTimer = useRef<number | undefined>(undefined);
  const lastChromeNudgeAt = useRef(Number.NEGATIVE_INFINITY);
  const chromePinned =
    webviewPaused || captionsOpen || webMenuOpen || detailsSection != null || chromeHovered || chromeFocused;
  const chromePinnedRef = useRef(chromePinned);
  chromePinnedRef.current = chromePinned;
  const playerDialogRef = useModalA11y<HTMLDivElement>(
    onClose,
    !useEmbedded,
    captionsOpen || detailsSection != null,
  );

  const clearChromeTimer = useCallback(() => {
    window.clearTimeout(chromeHideTimer.current);
    chromeHideTimer.current = undefined;
  }, []);
  const nudgeChrome = useCallback(() => {
    if (mode !== "webview") return;
    // Pointermove can fire hundreds of times per second. Coalesce timer resets
    // so showing the controls stays immediate without making playback compete
    // with constant timeout allocation and cleanup.
    const now = performance.now();
    if (
      chromeHideTimer.current != null &&
      now - lastChromeNudgeAt.current < 100
    ) {
      return;
    }
    lastChromeNudgeAt.current = now;
    setWebChromeVisible(true);
    clearChromeTimer();
    chromeHideTimer.current = window.setTimeout(() => {
      chromeHideTimer.current = undefined;
      if (!chromePinnedRef.current) setWebChromeVisible(false);
    }, 3200);
  }, [clearChromeTimer, mode]);
  const holdChrome = useCallback(() => {
    setChromeHovered(true);
    nudgeChrome();
  }, [nudgeChrome]);
  const releaseChrome = useCallback(() => {
    setChromeHovered(false);
    nudgeChrome();
  }, [nudgeChrome]);
  const focusChrome = useCallback(() => {
    setChromeFocused(true);
    nudgeChrome();
  }, [nudgeChrome]);
  const blurChrome = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
        return;
      }
      setChromeFocused(false);
      nudgeChrome();
    },
    [nudgeChrome],
  );

  useEffect(() => {
    recordDiagnostic("player", "session.started", "info", requestedEngine);
    const unregister = registerPlayerMount();
    return () => {
      recordDiagnostic("player", "session.closed");
      unregister();
    };
  }, [requestedEngine]);
  useEffect(() => {
    if (mode !== "webview") {
      clearChromeTimer();
      setWebChromeVisible(true);
      return;
    }
    nudgeChrome();
    return clearChromeTimer;
  }, [clearChromeTimer, mode, nudgeChrome]);
  useEffect(() => {
    if (mode !== "webview") return;
    if (chromePinned) {
      clearChromeTimer();
      setWebChromeVisible(true);
      return;
    }
    nudgeChrome();
  }, [chromePinned, clearChromeTimer, mode, nudgeChrome]);
  const webChromeShown = mode !== "webview" || webChromeVisible || chromePinned;
  const hiddenWebChrome = mode === "webview" && !webChromeShown;

  useEffect(() => {
    setSourceSize(null);
    setWebTechnicalStats([]);
    setDetailsSection(null);
  }, [effectiveUrl]);

  useEffect(() => {
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      setDisplaySize(currentViewportPixelSize());
    };
    const scheduleMeasure = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const recoverNativeInWebview = useCallback(async (): Promise<boolean> => {
    if (requestWebviewFallback == null) {
      recordDiagnostic("player", "native.fallback_unavailable", "warning");
      return false;
    }
    recordDiagnostic("player", "native.fallback_started");
    let hlsUrl: string | null = null;
    try {
      hlsUrl = await requestWebviewFallback();
    } catch {
      hlsUrl = null;
    }
    if (hlsUrl == null || hlsUrl.length === 0) {
      recordDiagnostic("player", "native.fallback_failed", "error");
      return false;
    }
    setFallbackSource({
      originUrl: url,
      originEngine: requestedEngine,
      url: hlsUrl,
    });
    recordDiagnostic("player", "native.fallback_ready");
    return true;
  }, [requestWebviewFallback, requestedEngine, url]);

  const recoveryPendingRef = useRef(false);
  const handleWebviewPlaybackError = useCallback(
    async (message: string) => {
      recordDiagnostic("player", "webview.playback_failed", "error", message);
      if (
        effectiveEngine === "webview-direct" &&
        activeFallback == null &&
        requestWebviewFallback != null &&
        !recoveryPendingRef.current
      ) {
        recoveryPendingRef.current = true;
        setWebRecoveryPending(true);
        setExternalActionStatus("Preparing a browser-compatible stream…");
        const recovered = await recoverNativeInWebview();
        recoveryPendingRef.current = false;
        setWebRecoveryPending(false);
        setExternalActionStatus(null);
        if (recovered) return;
      }
      setExternalError(message);
    }, [
      activeFallback,
      effectiveEngine,
      recoverNativeInWebview,
      requestWebviewFallback,
    ],
  );

  const externalTarget = externalPlaybackUrl?.trim() || effectiveUrl;
  const openExternalPlayback = useCallback(async () => {
    setExternalActionStatus(null);
    try {
      if (underTauri) {
        const status = await openInExternalPlayer(
          externalTarget,
          preferredPlayer,
          playbackAuthorization,
        );
        setExternalActionStatus(status);
      } else {
        downloadExternalPlaylist(externalTarget, title);
        setExternalActionStatus("Player file downloaded. Open it with VLC, IINA, or mpv.");
      }
      recordDiagnostic("player", "external.started");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExternalActionStatus(message);
      recordDiagnostic("player", "external.start_failed", "error");
    }
  }, [
    externalTarget,
    playbackAuthorization,
    preferredPlayer,
    title,
    underTauri,
  ]);

  // Native hand-off when running under Tauri and the in-window player is off.
  // Primary path is the BUNDLED mpv sidecar (shipped + app-controlled over IPC);
  // if mpv isn't available we fall back to the raw VLC/IINA hand-off. On macOS
  // mpv's `--wid` in-window embedding is unreliable, so mpv typically opens its
  // own window - see src-tauri/src/player.rs. mpv is stopped when this closes.
  const startedMpvRef = useRef(false);
  const castSuspendedRef = useRef(castSuspended);
  castSuspendedRef.current = castSuspended;
  useEffect(() => {
    if (mode !== "external" || !underTauri || useEmbedded) return;
    let cancelled = false;
    startedMpvRef.current = false;

    playWithMpv(effectiveUrl, playbackAuthorization)
      .then((res) => {
        if (cancelled) return;
        startedMpvRef.current = true;
        if (castSuspendedRef.current) {
          void import("../lib/tauri")
            .then(({ mpvPause }) => mpvPause())
            .catch(() => {});
        }
        setExternalStatus(
          res.embedded
            ? "Playing in the bundled mpv (in-window embedding attempted)."
            : "Playing in the bundled mpv player.",
        );
        recordDiagnostic("player", "mpv.started");
      })
      .catch(() => {
        // mpv missing / failed to spawn - fall back to the VLC/IINA hand-off.
        if (cancelled) return;
        recordDiagnostic("player", "mpv.start_failed", "warning");
        openInExternalPlayer(
          effectiveUrl,
          preferredPlayer,
          playbackAuthorization,
        )
          .then((status) => {
            if (!cancelled) {
              setExternalStatus(status);
              recordDiagnostic("player", "external.started");
            }
          })
          .catch((err) => {
            if (!cancelled) {
              setExternalError(err instanceof Error ? err.message : String(err));
              recordDiagnostic("player", "external.start_failed", "error");
            }
          });
      });

    return () => {
      cancelled = true;
      // Tear down the bundled mpv if we started it (no-op for the VLC fallback).
      if (startedMpvRef.current) {
        mpvStop().catch(() => {});
      }
    };
  }, [
    mode,
    underTauri,
    effectiveUrl,
    preferredPlayer,
    playbackAuthorization,
    useEmbedded,
  ]);

  useEffect(() => {
    if (mode !== "external" || useEmbedded || !startedMpvRef.current) return;
    void import("../lib/tauri")
      .then(({ mpvPause, mpvResume }) =>
        castSuspended ? mpvPause() : mpvResume(),
      )
      .catch(() => {});
  }, [castSuspended, mode, useEmbedded]);

  useEffect(() => {
    if (!androidTVNative) return;
    setAndroidTVError(null);
    const playbackURL = externalPlaybackUrl ?? effectiveUrl;
    const started = startAndroidTVPlayback({
      url: playbackURL,
      title,
      subtitle: subtitle ?? null,
      startPositionSeconds: Math.max(0, startPositionSeconds ?? 0),
      authorization: playbackAuthorization ?? null,
      audioLanguage: playerPreferences?.defaultAudioLanguage ?? null,
      subtitleLanguage: playerPreferences?.defaultSubtitleLanguage ?? null,
      subtitlesEnabled:
        playerPreferences?.defaultSubtitleBehavior === "preferred",
    });
    if (!started) {
      setAndroidTVError("The Android TV player could not be opened.");
      return;
    }

    const readProgress = (event: Event): AndroidTVPlaybackProgress | null => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (detail == null || typeof detail !== "object") return null;
      const candidate = detail as Partial<AndroidTVPlaybackProgress>;
      if (
        typeof candidate.positionSeconds !== "number" ||
        !Number.isFinite(candidate.positionSeconds) ||
        !(
          candidate.durationSeconds == null ||
          (typeof candidate.durationSeconds === "number" &&
            Number.isFinite(candidate.durationSeconds))
        )
      ) {
        return null;
      }
      return {
        positionSeconds: Math.max(0, candidate.positionSeconds),
        durationSeconds:
          candidate.durationSeconds == null
            ? null
            : Math.max(0, candidate.durationSeconds),
      };
    };
    const handleProgress = (event: Event) => {
      const progress = readProgress(event);
      if (progress == null) return;
      androidOnProgressRef.current?.(
        progress.positionSeconds + timelineOffsetSeconds,
        progress.durationSeconds == null
          ? null
          : progress.durationSeconds + timelineOffsetSeconds,
      );
    };
    const handleClosed = (event: Event) => {
      handleProgress(event);
      androidOnCloseRef.current();
    };
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      setAndroidTVError(
        typeof detail?.message === "string" && detail.message.length > 0
          ? detail.message
          : "Android TV playback stopped unexpectedly.",
      );
    };
    window.addEventListener("yawf-android-tv-progress", handleProgress);
    window.addEventListener("yawf-android-tv-closed", handleClosed);
    window.addEventListener("yawf-android-tv-error", handleError);
    return () => {
      window.removeEventListener("yawf-android-tv-progress", handleProgress);
      window.removeEventListener("yawf-android-tv-closed", handleClosed);
      window.removeEventListener("yawf-android-tv-error", handleError);
      stopAndroidTVPlayback();
    };
  }, [
    androidTVNative,
    effectiveUrl,
    externalPlaybackUrl,
    playbackAuthorization,
    playerPreferences?.defaultAudioLanguage,
    playerPreferences?.defaultSubtitleBehavior,
    playerPreferences?.defaultSubtitleLanguage,
    startPositionSeconds,
    subtitle,
    timelineOffsetSeconds,
    title,
  ]);

  if (androidTVNative) {
    return createPortal(
      <div className="player-backdrop">
        <div
          className="player player-native-tv-status"
          role="dialog"
          aria-modal="true"
          aria-label={`Playing ${title} on Android TV`}
        >
          <span className="player-title">{title}</span>
          {androidTVError == null ? (
            <p>Playing in the native Android TV player.</p>
          ) : (
            <>
              <p role="alert">{androidTVError}</p>
              {onTryNextSource != null && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void onTryNextSource()}
                >
                  Try next source
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => stopAndroidTVPlayback()}
          >
            Close player
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  // In-window native player takes over the whole window (transparent surface +
  // hidden app chrome), so render it standalone - outside the modal frame.
  if (useEmbedded) {
    const epLabel =
      season != null && episode != null
        ? `S${season} · E${episode}`
        : null;
    return (
      <EmbeddedPlayer
        savedPrefs={savedPrefs}
        playerPreferences={playerPreferences}
        subtitleClient={subtitleClient}
        translator={translator}
        imdbId={imdbId ?? null}
        season={season ?? null}
        episode={episode ?? null}
        url={effectiveUrl}
        title={title}
        subtitle={subtitle ?? epLabel}
        nowPlaying={nowPlaying}
        sourceFileName={sourceFileName}
        playbackAuthorization={playbackAuthorization}
        engine={effectiveEngine}
        onPlaybackError={recoverNativeInWebview}
        startPositionSeconds={startPositionSeconds}
        timelineOffsetSeconds={timelineOffsetSeconds}
        playbackDecision={playbackDecisionFor(effectiveEngine, effectiveUrl)}
        onProgress={(current, duration, prefs) =>
          onProgress?.(current, duration, prefs)
        }
        scrobbleContext={scrobbleContext}
        onPlayNext={upNext != null ? onPlayNext : undefined}
        onTryNextSource={onTryNextSource}
        nextLabel={upNext?.label ?? null}
        onClose={onClose}
      />
    );
  }

  // Detail is a fixed, nav-inset surface with backdrop-filter. Filters establish
  // a containing block for fixed descendants, so mounting this shell there would
  // make inset:0 mean "the Detail rect", not the window. Portal every webview and
  // external shell to body, just as EmbeddedPlayer does for its HTML controls.
  return createPortal(
    <div className="player-backdrop" onClick={onClose}>
      <div
        ref={playerDialogRef}
        className="player"
        role="dialog"
        aria-modal="true"
        aria-label={`Playing ${title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onPointerMove={mode === "webview" ? nudgeChrome : undefined}
      >
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {externalError != null
            ? "Playback stopped because of an error"
            : webRecoveryPending
              ? "Preparing a compatible stream"
              : mode === "webview"
                ? webviewPaused
                  ? "Playback paused"
                  : "Playback playing"
                : "Opening native playback"}
        </span>
        <div
          className={`player-bar${webChromeShown ? " is-visible" : ""}`}
          aria-hidden={hiddenWebChrome || undefined}
          onPointerEnter={holdChrome}
          onPointerLeave={releaseChrome}
          onFocusCapture={focusChrome}
          onBlurCapture={blurChrome}
        >
          <div className="player-title-group">
            <span className="player-title">{title}</span>
            {subtitle && <span className="player-subtitle">{subtitle}</span>}
          </div>
          <div className="player-bar-actions">
            {mode !== "webview" && (
              <CastControls
                media={{
                  url: effectiveUrl,
                  title,
                  subtitleUrl: activeSubtitleUrl,
                }}
                buttonClassName="player-info-button"
                onLocalPlaybackChange={setCastSuspended}
              />
            )}
            <button
              type="button"
              className="player-info-button"
              onClick={() =>
                setDetailsSection((section) => section === "info" ? null : "info")
              }
              aria-label="Player details and shortcuts"
              aria-haspopup="dialog"
              aria-expanded={detailsSection != null}
              title="Player details and shortcuts (?)"
              tabIndex={hiddenWebChrome ? -1 : undefined}
            >
              <Icon name="info" size={17} />
            </button>
            <button
              type="button"
              className="player-close"
              onClick={onClose}
              aria-label="Close player"
              tabIndex={hiddenWebChrome ? -1 : undefined}
            >
              <Icon name="xmark" size={18} />
            </button>
          </div>
        </div>

        {detailsSection != null && (
          <PlayerInfoPopover
            engine={effectiveEngine}
            sourceSize={sourceSize}
            displaySize={displaySize}
            sourceFileName={sourceFileName}
            technicalStats={webTechnicalStats}
            playbackDecision={playbackDecisionFor(effectiveEngine, effectiveUrl)}
            section={detailsSection}
            onSectionChange={setDetailsSection}
            shortcuts={WEBVIEW_SHORTCUTS}
            onClose={() => setDetailsSection(null)}
          />
        )}

        {mode === "webview" && externalError == null ? (
          <WebviewPlayer
            key={`${effectiveUrl}:${playbackAttempt}`}
            url={effectiveUrl}
            title={title}
            subtitle={subtitle}
            nowPlaying={nowPlaying}
            detailsOpen={detailsSection != null}
            chromeVisible={webChromeShown}
            onChromeEnter={holdChrome}
            onChromeLeave={releaseChrome}
            onChromeFocus={focusChrome}
            onChromeBlur={blurChrome}
            onActivity={nudgeChrome}
            onPausedChange={setWebviewPaused}
            onCaptionsOpenChange={setCaptionsOpen}
            onMenuOpenChange={setWebMenuOpen}
            onCastLocalPlaybackChange={setCastSuspended}
            suspended={castSuspended}
            onActiveSubtitleUrlChange={setActiveSubtitleUrl}
            onOpenShortcuts={() => setDetailsSection("shortcuts")}
            onSourceSize={setSourceSize}
            onTechnicalStats={updateWebTechnicalStats}
            onProgress={onProgress}
            savedPrefs={savedPrefs}
            playerPreferences={playerPreferences}
            startPositionSeconds={startPositionSeconds}
            timelineOffsetSeconds={timelineOffsetSeconds}
            onPlaybackError={(message) => void handleWebviewPlaybackError(message)}
            onOpenExternalPlayer={() => void openExternalPlayback()}
            externalActionStatus={externalActionStatus}
            subtitleClient={subtitleClient ?? null}
            translator={translator ?? null}
            imdbId={imdbId ?? null}
            season={season ?? null}
            episode={episode ?? null}
            scrobbleContext={scrobbleContext}
            upNext={upNext}
            onPlayNext={onPlayNext}
            onRemoteClose={onClose}
            autoCountdown={autoCountdown}
          />
        ) : (
          <ExternalPanel
            underTauri={underTauri}
            url={effectiveUrl}
            status={externalStatus}
            error={externalError}
            externalStatus={externalActionStatus}
            onOpenExternal={() => void openExternalPlayback()}
            onTryNextSource={onTryNextSource}
            onRetry={
              mode === "webview" && externalError != null
                ? () => {
                    recordDiagnostic("player", "webview.retry_requested");
                    setExternalError(null);
                    setPlaybackAttempt((attempt) => attempt + 1);
                  }
                : undefined
            }
          />
        )}
        {webRecoveryPending && (
          <div className="player-compatibility-status" role="status">
            <Icon name="refresh" size={22} />
            <span>Preparing a browser-compatible stream…</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The in-webview `<video>` path with the custom scrub-thumbnail bar + captions
 * OSD. Split out so the subtitle/thumbnail hooks mount only on this path (never
 * for the external mpv/VLC hand-off, where there's no frame source). */
function WebviewPlayer({
  url,
  title,
  subtitle,
  nowPlaying,
  detailsOpen,
  chromeVisible,
  onChromeEnter,
  onChromeLeave,
  onChromeFocus,
  onChromeBlur,
  onActivity,
  onPausedChange,
  onCaptionsOpenChange,
  onMenuOpenChange,
  onCastLocalPlaybackChange,
  suspended,
  onActiveSubtitleUrlChange,
  onOpenShortcuts,
  onSourceSize,
  onTechnicalStats,
  onProgress,
  savedPrefs,
  playerPreferences,
  startPositionSeconds,
  timelineOffsetSeconds,
  onPlaybackError,
  onOpenExternalPlayer,
  externalActionStatus,
  subtitleClient,
  translator,
  imdbId,
  season,
  episode,
  scrobbleContext,
  upNext = null,
  onPlayNext,
  onRemoteClose,
  autoCountdown = true,
}: {
  url: string;
  title: string;
  subtitle?: string | null;
  nowPlaying?: NowPlayingMetadata | null;
  detailsOpen: boolean;
  chromeVisible: boolean;
  onChromeEnter: () => void;
  onChromeLeave: () => void;
  onChromeFocus: () => void;
  onChromeBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onActivity: () => void;
  onPausedChange: (paused: boolean) => void;
  onCaptionsOpenChange: (open: boolean) => void;
  onMenuOpenChange: (open: boolean) => void;
  onCastLocalPlaybackChange: (suspended: boolean) => void;
  suspended: boolean;
  onActiveSubtitleUrlChange: (url: string | null) => void;
  onOpenShortcuts: () => void;
  onSourceSize: (size: PixelSize | null) => void;
  onTechnicalStats: (
    stats: ReadonlyArray<readonly [string, string]>,
  ) => void;
  onProgress?: (
    currentSeconds: number,
    durationSeconds: number | null,
    prefs?: PlaybackPrefs,
  ) => void;
  savedPrefs?: PlaybackPrefs | null;
  playerPreferences?: PlayerPreferenceDefaults | null;
  startPositionSeconds?: number;
  timelineOffsetSeconds: number;
  onPlaybackError: (message: string) => void;
  onOpenExternalPlayer: () => void;
  externalActionStatus: string | null;
  subtitleClient: SubtitleClient | null;
  translator: Translator | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  scrobbleContext: TraktScrobbleContext | null;
  upNext?: { label: string } | null;
  onPlayNext?: () => void;
  onRemoteClose: () => void;
  autoCountdown?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const lastAudibleVolumeRef = useRef(1);
  const playerPreferencesRef = useRef(playerPreferences);
  playerPreferencesRef.current = playerPreferences;
  const appliedHlsAudioPreferenceRef = useRef(false);
  const autoplayAttemptedRef = useRef(false);
  const pausedForCastRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const scrubberRef = useRef<WebviewScrubberHandle | null>(null);
  const lastClockSecondRef = useRef(-1);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [videoFit, setVideoFit] = useState<"contain" | "cover" | "fill">("contain");
  const [videoZoom, setVideoZoom] = useState(1);
  const [videoPanX, setVideoPanX] = useState(0);
  const [videoPanY, setVideoPanY] = useState(0);
  const [subtitlePosition, setSubtitlePosition] = useState(
    () => savedPrefs?.subtitlePosition ?? 90,
  );
  const subtitlePositionRef = useRef(subtitlePosition);
  subtitlePositionRef.current = subtitlePosition;
  const [paused, setPaused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(() => {
    const saved = playerPreferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs?.playbackSpeed;
    const preferred = saved ?? playerPreferences?.defaultPlaybackSpeed;
    return preferred != null && Number.isFinite(preferred) && preferred >= 0.5 && preferred <= 2
      ? preferred
      : 1;
  });
  const [scrubbing, setScrubbing] = useState(false);
  // Set when the video reaches its natural end - drives the Up-next card.
  const [ended, setEnded] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [remotePlaybackAvailable, setRemotePlaybackAvailable] = useState(false);
  const [hlsLevels, setHlsLevels] = useState<HlsLevelChoice[]>([]);
  const [hlsLevel, setHlsLevel] = useState(-1);
  const [hlsAudioTracks, setHlsAudioTracks] = useState<HlsAudioChoice[]>([]);
  const [hlsAudioTrack, setHlsAudioTrack] = useState(-1);
  const volumeIsSilent = muted || volume === 0;
  const underTauri = isTauri();
  const mediaArtist = nowPlaying?.episodeLabel ?? subtitle ?? "";
  const mediaArtworkUrl = nowPlaying?.posterUrl ?? "";

  useTVRemotePlayback({
    videoRef,
    title,
    subtitle,
    onClose: onRemoteClose,
    onNext: onPlayNext,
  });

  useEffect(() => {
    if (!detailsOpen) {
      onTechnicalStats([]);
      return;
    }
    const video = videoRef.current;
    if (video == null) return;
    const report = () => {
      const stats: Array<readonly [string, string]> = [];
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        stats.push([
          "Video",
          `${video.videoWidth} × ${video.videoHeight} px`,
        ]);
      }
      let bufferedAhead = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (
          video.buffered.start(index) <= video.currentTime &&
          video.buffered.end(index) >= video.currentTime
        ) {
          bufferedAhead = video.buffered.end(index) - video.currentTime;
          break;
        }
      }
      stats.push(["Buffer health", `${bufferedAhead.toFixed(1)} s`]);
      const quality = video.getVideoPlaybackQuality?.();
      if (quality != null) {
        stats.push(["Decoded frames", String(quality.totalVideoFrames)]);
        stats.push(["Dropped frames", String(quality.droppedVideoFrames)]);
      }
      const hls = hlsRef.current;
      if (hls != null) {
        const level = hls.levels[hls.currentLevel];
        if (level != null) {
          const rendition =
            level.height > 0
              ? `${level.height}p`
              : level.bitrate > 0
                ? `${Math.round(level.bitrate / 1000)} kbps`
                : `Level ${hls.currentLevel + 1}`;
          stats.push(["HLS rendition", rendition]);
        } else {
          stats.push(["HLS rendition", "Automatic"]);
        }
        if (hls.bandwidthEstimate > 0) {
          stats.push([
            "Estimated bandwidth",
            `${(hls.bandwidthEstimate / 1_000_000).toFixed(1)} Mbps`,
          ]);
        }
      }
      if (timelineOffsetSeconds > 0) {
        stats.push([
          "Resume offset",
          clockLabel(timelineOffsetSeconds),
        ]);
      }
      onTechnicalStats(stats);
    };
    report();
    const timer = window.setInterval(report, 1000);
    return () => window.clearInterval(timer);
  }, [
    detailsOpen,
    onTechnicalStats,
    timelineOffsetSeconds,
    url,
  ]);

  // A wake lock is acquired only after the media element emits play, rather
  // than merely while the player is open or autoplay is being attempted.
  useWakeLock(playing && !suspended);

  useEffect(() => {
    onCaptionsOpenChange(captionsOpen);
  }, [captionsOpen, onCaptionsOpenChange]);

  useEffect(() => {
    onMenuOpenChange(optionsOpen);
  }, [onMenuOpenChange, optionsOpen]);

  const subs = useSubtitleTracks(subtitleClient, translator);
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    const apply = () => {
      for (const track of Array.from(video.textTracks)) {
        if (track.mode !== "showing" || track.cues == null) continue;
        for (const cue of Array.from(track.cues)) {
          const positioned = cue as TextTrackCue & {
            line?: number | "auto";
            snapToLines?: boolean;
          };
          positioned.snapToLines = false;
          positioned.line = subtitlePosition;
        }
      }
    };
    const tracks = Array.from(video.textTracks);
    for (const track of tracks) track.addEventListener("cuechange", apply);
    apply();
    return () => {
      for (const track of tracks) track.removeEventListener("cuechange", apply);
    };
  }, [subtitlePosition, subs.activeTrackId]);
  useEffect(() => {
    const activeTrack = subs.tracks.find(
      (track) => track.id === subs.activeTrackId,
    );
    const subtitleUrl =
      activeTrack != null && /^https?:\/\//i.test(activeTrack.vttUrl)
        ? activeTrack.vttUrl
        : null;
    onActiveSubtitleUrlChange(subtitleUrl);
    return () => onActiveSubtitleUrlChange(null);
  }, [onActiveSubtitleUrlChange, subs.activeTrackId, subs.tracks]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    if (suspended) {
      pausedForCastRef.current = !video.paused;
      video.pause();
      return;
    }
    if (pausedForCastRef.current) {
      pausedForCastRef.current = false;
      void video.play().catch(() => {});
    }
  }, [suspended]);
  // Thumbnails only work on a progressive source the browser can re-open and
  // seek (MP4/WebM). For HLS the manifest URL can't drive a second <video>
  // reliably, so gate them to non-HLS in-webview sources.
  const isHls = url.split("?")[0].toLowerCase().endsWith(".m3u8");
  const thumbs = useScrubThumbnails(url, !isHls);

  // Lock-screen / hardware-media controls. A browser can expose Media Session
  // while supporting only a subset of actions, so every handler registration
  // is isolated behind a try/catch.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const video = videoRef.current;
    if (video == null) return;

    const mediaSession = navigator.mediaSession;
    let lastPositionUpdate = 0;
    const setMetadata = () => {
      if (typeof MediaMetadata !== "function") return;
      try {
        mediaSession.metadata = new MediaMetadata({
          title,
          artist: mediaArtist,
          album: "YAWF Stream",
          artwork: mediaArtworkUrl
            ? [{ src: mediaArtworkUrl, sizes: "512x512", type: "image/png" }]
            : [],
        });
      } catch {
        // A partial Media Session implementation must not affect playback.
      }
    };
    const setPlaybackState = () => {
      try {
        mediaSession.playbackState = video.paused ? "paused" : "playing";
      } catch {
        // See partial-implementation note above.
      }
    };
    const setPositionState = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPositionUpdate < 1000) return;
      const mediaDuration = video.duration;
      const currentTime = video.currentTime;
      if (
        !Number.isFinite(mediaDuration) ||
        mediaDuration <= 0 ||
        !Number.isFinite(currentTime)
      ) {
        return;
      }
      lastPositionUpdate = now;
      try {
        mediaSession.setPositionState({
          duration: mediaDuration,
          position: Math.min(Math.max(currentTime, 0), mediaDuration),
          playbackRate:
            Number.isFinite(video.playbackRate) && video.playbackRate > 0
              ? video.playbackRate
              : 1,
        });
      } catch {
        // Some engines expose Media Session but reject position state for live
        // streams or an as-yet-unseekable source.
      }
    };
    const seek = (time: number) => {
      if (!Number.isFinite(time)) return;
      const mediaDuration = video.duration;
      video.currentTime = Number.isFinite(mediaDuration) && mediaDuration > 0
        ? Math.min(Math.max(time, 0), mediaDuration)
        : Math.max(time, 0);
    };
    const setActionHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // The action is not implemented by this browser's Media Session API.
      }
    };
    const onLoadedMetadata = () => setPositionState(true);
    const onTimeUpdate = () => setPositionState();

    setMetadata();
    setPlaybackState();
    setPositionState(true);
    setActionHandler("play", () => {
      void video.play().catch(() => {});
    });
    setActionHandler("pause", () => video.pause());
    setActionHandler("seekbackward", () => seek(video.currentTime - 10));
    setActionHandler("seekforward", () => seek(video.currentTime + 10));
    setActionHandler("seekto", (details) => {
      if (details.seekTime != null) seek(details.seekTime);
    });
    setActionHandler("stop", () => {
      video.pause();
      seek(0);
    });

    video.addEventListener("loadedmetadata", setMetadata);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", setPlaybackState);
    video.addEventListener("pause", setPlaybackState);
    return () => {
      video.removeEventListener("loadedmetadata", setMetadata);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", setPlaybackState);
      video.removeEventListener("pause", setPlaybackState);
      (["play", "pause", "seekbackward", "seekforward", "seekto", "stop"] as MediaSessionAction[])
        .forEach((action) => {
          try {
            mediaSession.setActionHandler(action, null);
          } catch {
            // See the subset-support note above.
          }
        });
      try {
        mediaSession.playbackState = "none";
        mediaSession.metadata = null;
      } catch {
        // The session can already be invalidated during a browser teardown.
      }
    };
  }, [mediaArtist, mediaArtworkUrl, title, url]);

  useEffect(() => {
    const video = videoRef.current;
    const stage = video?.closest(".player-stage");
    if (video == null || !(stage instanceof HTMLElement)) return;
    const webkitVideo = video as WebKitVideoElement;
    const supportsContainerFullscreen = typeof stage.requestFullscreen === "function";
    const supportsWebKitFullscreen =
      webkitVideo.webkitSupportsFullscreen === true &&
      typeof webkitVideo.webkitEnterFullscreen === "function";
    setFullscreenSupported(supportsContainerFullscreen || supportsWebKitFullscreen);

    const setFullscreenState = (next: boolean) => {
      setIsFullscreen(next);
      if (next) lockLandscapeOrientation();
      else unlockOrientation();
    };
    const syncFullscreenState = () => {
      const doc = document as WebKitDocument;
      const fullscreenElement = document.fullscreenElement ?? doc.webkitFullscreenElement;
      setFullscreenState(fullscreenElement === stage || fullscreenElement === video);
    };
    const onWebKitBeginFullscreen = () => setFullscreenState(true);
    const onWebKitEndFullscreen = () => setFullscreenState(false);

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    video.addEventListener("webkitbeginfullscreen", onWebKitBeginFullscreen);
    video.addEventListener("webkitendfullscreen", onWebKitEndFullscreen);
    syncFullscreenState();
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
      video.removeEventListener("webkitbeginfullscreen", onWebKitBeginFullscreen);
      video.removeEventListener("webkitendfullscreen", onWebKitEndFullscreen);
      unlockOrientation();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    const webkitVideo = video as WebKitVideoElement;
    const supportsStandardPiP = document.pictureInPictureEnabled === true;
    const supportsWebKitPiP = typeof webkitVideo.webkitSetPresentationMode === "function";
    setPictureInPictureSupported(supportsStandardPiP || supportsWebKitPiP);

    const syncPictureInPicture = () => {
      setIsPictureInPicture(
        document.pictureInPictureElement === video ||
          webkitVideo.webkitPresentationMode === "picture-in-picture",
      );
    };
    const leavePictureInPicture = () => setIsPictureInPicture(false);

    video.addEventListener("enterpictureinpicture", syncPictureInPicture);
    video.addEventListener("leavepictureinpicture", leavePictureInPicture);
    video.addEventListener("webkitpresentationmodechanged", syncPictureInPicture);
    syncPictureInPicture();
    return () => {
      video.removeEventListener("enterpictureinpicture", syncPictureInPicture);
      video.removeEventListener("leavepictureinpicture", leavePictureInPicture);
      video.removeEventListener("webkitpresentationmodechanged", syncPictureInPicture);
    };
  }, []);

  useEffect(() => {
    if (underTauri) return;
    const video = videoRef.current;
    if (video == null) return;
    const webkitVideo = video as WebKitVideoElement;
    const supportsAirPlay =
      typeof webkitVideo.webkitShowPlaybackTargetPicker === "function";
    const onAirPlayAvailability = (event: Event) => {
      setAirPlayAvailable(
        (event as WebKitPlaybackTargetAvailabilityEvent).availability === "available",
      );
    };
    if (supportsAirPlay) {
      video.addEventListener(
        "webkitplaybacktargetavailabilitychanged",
        onAirPlayAvailability,
      );
    }

    const supportsRemotePlayback = "remote" in HTMLMediaElement.prototype;
    let availabilityWatchId: number | null = null;
    let cancelled = false;
    if (supportsRemotePlayback && typeof video.remote?.watchAvailability === "function") {
      try {
        void video.remote.watchAvailability((available) => {
          if (!cancelled) setRemotePlaybackAvailable(available);
        }).then((id) => {
          if (cancelled) {
            void video.remote.cancelWatchAvailability(id).catch(() => {});
          } else {
            availabilityWatchId = id;
          }
        }).catch(() => {});
      } catch {
        // The remote route watcher is optional (and can reject during teardown).
      }
    }

    return () => {
      cancelled = true;
      if (supportsAirPlay) {
        video.removeEventListener(
          "webkitplaybacktargetavailabilitychanged",
          onAirPlayAvailability,
        );
      }
      if (availabilityWatchId != null) {
        void video.remote.cancelWatchAvailability(availabilityWatchId).catch(() => {});
      }
    };
  }, [underTauri]);

  // Report playback progress (throttled to ~once / 5s) + keep currentTime/
  // duration in sync for the custom scrub bar.
  const lastReportRef = useRef(0);
  // Keep the latest onProgress in a ref so the effect doesn't re-subscribe each
  // render (onProgress identity changes every render → re-subscribe loop).
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onSourceSizeRef = useRef(onSourceSize);
  onSourceSizeRef.current = onSourceSize;
  // Stable ref for the HLS-unsupported callback so the source-attach effect does
  // NOT list a fresh inline arrow in its deps. Detail re-renders every ~5s (the
  // progress → recordResume → refreshHistory loop), and a changing callback
  // identity would otherwise re-run that effect and reload video.src - restarting
  // playback from 0 every few seconds.
  const onPlaybackErrorRef = useRef(onPlaybackError);
  onPlaybackErrorRef.current = onPlaybackError;
  // Resume position is captured in a ref + a one-shot guard so we seek exactly
  // once, when metadata first loads, without re-subscribing the effect.
  const startPositionRef = useRef(startPositionSeconds);
  startPositionRef.current = startPositionSeconds;
  const timelineOffsetRef = useRef(
    Number.isFinite(timelineOffsetSeconds)
      ? Math.max(0, timelineOffsetSeconds)
      : 0,
  );
  timelineOffsetRef.current = Number.isFinite(timelineOffsetSeconds)
    ? Math.max(0, timelineOffsetSeconds)
    : 0;
  const didSeekRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    didSeekRef.current = false;
    onSourceSizeRef.current(null);

    const report = () => {
      const d = Number.isFinite(video.duration) ? video.duration : null;
      const offset = timelineOffsetRef.current;
      onProgressRef.current?.(
        video.currentTime + offset,
        d == null ? null : d + offset,
        {
        playbackSpeed:
          Number.isFinite(video.playbackRate) && video.playbackRate > 0
            ? video.playbackRate
            : 1,
        subtitlePosition: subtitlePositionRef.current,
        },
      );
    };
    const onTimeUpdate = () => {
      scrubberRef.current?.setCurrentTime(video.currentTime);
      const wholeSecond = Math.floor(video.currentTime);
      if (wholeSecond !== lastClockSecondRef.current) {
        lastClockSecondRef.current = wholeSecond;
        if (clockRef.current != null) {
          const offset = timelineOffsetRef.current;
          clockRef.current.textContent = `${clockLabel(video.currentTime + offset)} / ${clockLabel(video.duration + offset)}`;
        }
      }
      const now = Date.now();
      if (onProgressRef.current != null && now - lastReportRef.current >= 5000) {
        lastReportRef.current = now;
        report();
      }
    };
    // Cross-device resume: seek to the saved position once, but only if it's a
    // meaningful offset and not basically at the end (so a finished item still
    // starts fresh). HLS reports `duration` AFTER loadedmetadata, so when the
    // duration isn't known yet we wait and let the durationchange handler retry
    // - seeking into an unknown/zero seekable range just gets clamped to 0 and,
    // since we'd have marked it done, would never resume.
    const applyResume = () => {
      if (didSeekRef.current) return;
      const start = startPositionRef.current ?? 0;
      if (start <= 5) {
        didSeekRef.current = true; // nothing meaningful to resume to
        return;
      }
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (d <= 0) return; // duration unknown yet (HLS) - retry on durationchange
      if (start >= d - 10) {
        didSeekRef.current = true; // basically finished - don't resume
        return;
      }
      try {
        video.currentTime = start;
        // Only mark the resume done once the seek was accepted - if the element
        // rejects an early seek we leave the guard unset so a later canplay /
        // durationchange retries instead of silently dropping the resume.
        didSeekRef.current = true;
      } catch {
        // Not seekable yet; a subsequent canplay/durationchange will retry.
      }
    };
    const onLoadedMeta = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
      if (clockRef.current != null) {
        const offset = timelineOffsetRef.current;
        clockRef.current.textContent = `${clockLabel(video.currentTime + offset)} / ${clockLabel(video.duration + offset)}`;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      onSourceSizeRef.current(
        width > 0 && height > 0 ? { width, height } : null,
      );
      applyResume();
    };
    const onDurationChange = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
      applyResume();
    };
    const progressPct = () => {
      const offset = timelineOffsetRef.current;
      return playbackProgressPct(
        video.currentTime + offset,
        video.duration + offset,
      );
    };
    const onEnded = () => {
      setEnded(true);
      setPlaying(false);
      if (scrobbleContext != null) scrobblePlaybackStop(scrobbleContext, progressPct());
    };
    const onPause = () => {
      setPaused(true);
      setPlaying(false);
      onPausedChange(true);
      if (!video.ended && scrobbleContext != null) {
        scrobblePlaybackPause(scrobbleContext, progressPct());
      }
    };
    const onPlay = () => {
      if (suspendedRef.current) {
        video.pause();
        return;
      }
      setPaused(false);
      setPlaying(true);
      onPausedChange(false);
      if (scrobbleContext != null) {
        scrobblePlaybackStart({ ...scrobbleContext, progressPct: progressPct() });
      }
    };
    const onVolumeChange = () => {
      if (video.volume > 0) lastAudibleVolumeRef.current = video.volume;
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onRateChange = () => setPlaybackRate(video.playbackRate);
    const preferences = playerPreferencesRef.current;
    const perTitlePrefs = preferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs;
    const preferredRate = perTitlePrefs?.playbackSpeed ?? preferences?.defaultPlaybackSpeed;
    if (
      preferredRate != null &&
      Number.isFinite(preferredRate) &&
      preferredRate >= 0.5 &&
      preferredRate <= 2
    ) {
      video.playbackRate = preferredRate;
    }
    const configuredVolume = preferences?.defaultVolume;
    if (configuredVolume != null && Number.isFinite(configuredVolume)) {
      const volumePercent = Math.round(Math.min(100, Math.max(0, configuredVolume)));
      video.volume = volumePercent / 100;
      video.muted = volumePercent === 0;
    }
    const attemptAutoplay = () => {
      if (autoplayAttemptedRef.current || suspendedRef.current) return;
      autoplayAttemptedRef.current = true;
      if (!video.paused) return;
      // Stream resolution is asynchronous, so some browsers no longer treat
      // the later player mount as part of the original click. Retry explicitly
      // when media is playable. If policy still blocks it, the Play control is
      // already visible and no external-player decision interrupts the flow.
      try {
        void video.play().catch(() => {});
      } catch {
        // Older WebKit versions can throw synchronously instead of rejecting.
      }
    };
    setEnded(false); // a new URL is a new playback - clear any stale end state
    lastClockSecondRef.current = -1;
    setPaused(false);
    setPlaying(false);
    onVolumeChange();
    onPausedChange(false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("canplay", applyResume);
    video.addEventListener("canplay", attemptAutoplay);
    video.addEventListener("ended", onEnded);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ratechange", onRateChange);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("canplay", applyResume);
      video.removeEventListener("canplay", attemptAutoplay);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ratechange", onRateChange);
      if (onProgressRef.current != null && video.currentTime > 0) report();
      if (scrobbleContext != null) scrobblePlaybackStop(scrobbleContext, progressPct());
    };
  }, [onPausedChange, scrobbleContext, url]);

  // Wire hls.js for HLS streams when the browser can't play them natively.
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;

    if (!isHls) {
      // Only (re)assign on an actual URL change - reassigning the same src
      // invokes the media load algorithm and restarts playback from 0.
      if (video.src !== url) video.src = url;
      return;
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      if (video.src !== url) video.src = url;
      return;
    }

    // hls.js is ~151 KB gz and is reachable ONLY here: an .m3u8 the browser
    // cannot play natively. A static import pinned it into this chunk, so every
    // player open paid for it - including the native-mpv and direct-file paths
    // that return above and never touch it. Fetch it on demand instead.
    let cancelled = false;
    let instance: HlsInstance | null = null;
    appliedHlsAudioPreferenceRef.current = false;
    let retryTimer: number | undefined;
    const recovery = { networkRetries: 0, mediaRecoveries: 0 };
    const applyHlsAudioPreference = (tracks: HlsAudioChoice[]) => {
      if (appliedHlsAudioPreferenceRef.current || instance == null) return;
      const preferences = playerPreferencesRef.current;
      const perTitlePrefs = preferences?.rememberPerTitleTrackChoices === false
        ? null
        : savedPrefs;
      const matchLanguage = (preference: unknown) =>
        findPreferredLanguageMatch(
          preference,
          tracks,
          (track) => track.language,
        ) ?? findPreferredLanguageMatch(
          preference,
          tracks,
          (track) => track.label,
        );
      // A stale remembered language should not suppress the global fallback.
      const match =
        matchLanguage(perTitlePrefs?.preferredAudioLang) ??
        matchLanguage(preferences?.defaultAudioLanguage);
      if (match == null) return;
      appliedHlsAudioPreferenceRef.current = true;
      instance.audioTrack = match.index;
      setHlsAudioTrack(match.index);
    };
    void import("hls.js").then(({ default: Hls }) => {
      // The effect can be torn down (or the URL swapped) while the chunk is in
      // flight; without this we would attach a player to a stale <video>.
      if (cancelled) return;
      const element = videoRef.current;
      if (element == null) return;
      if (!Hls.isSupported()) {
        onPlaybackErrorRef.current(
          "This browser cannot play HLS. Try the desktop app.",
        );
        return;
      }
      // Bound the media buffers - hls.js defaults to backBufferLength: Infinity,
      // which retains every played segment: a 2h stream grows to GBs in the
      // WebContent process. 60s behind + 30s (up to 120s) ahead keeps seeks snappy
      // without the balloon.
      instance = new Hls({
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        // Server Mode may be a different HTTPS origin from the installed app.
        // Manifest and segment requests must carry the app session and, when
        // present, the Cloudflare Access browser cookie.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hlsRef.current = instance;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled || !data.fatal || instance == null) return;
        const action = nextHlsRecovery(data.type, recovery);
        if (action === "retry-network") {
          recovery.networkRetries += 1;
          recordDiagnostic("player", "hls.network_recovery", "warning");
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(
            () => {
              retryTimer = undefined;
              instance?.startLoad();
            },
            recovery.networkRetries * 500,
          );
          return;
        }
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
        if (action === "recover-media") {
          recovery.mediaRecoveries += 1;
          recordDiagnostic("player", "hls.media_recovery", "warning");
          instance.recoverMediaError();
          return;
        }
        recordDiagnostic("player", "hls.fatal", "error", data.type);
        onPlaybackErrorRef.current(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "The stream stopped responding after two retries. Try again or choose another stream."
            : "The stream could not be decoded. Try again or choose another stream.",
        );
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        setHlsLevels(
          instance?.levels.map((level, index) => ({
            index,
            label: level.height > 0
              ? `${level.height}p`
              : level.bitrate > 0
                ? `${Math.round(level.bitrate / 1000)} kbps`
                : `Quality ${index + 1}`,
          })) ?? [],
        );
        const audioChoices = instance?.audioTracks.map((track, index) => ({
          index,
          label: track.name || track.lang || `Audio ${index + 1}`,
          language: track.lang ?? null,
        })) ?? [];
        setHlsAudioTracks(audioChoices);
        applyHlsAudioPreference(audioChoices);
        setHlsLevel(instance?.currentLevel ?? -1);
        setHlsAudioTrack(instance?.audioTrack ?? -1);
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setHlsLevel(data.level);
      });
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        const audioChoices = instance?.audioTracks.map((track, index) => ({
          index,
          label: track.name || track.lang || `Audio ${index + 1}`,
          language: track.lang ?? null,
        })) ?? [];
        setHlsAudioTracks(audioChoices);
        applyHlsAudioPreference(audioChoices);
      });
      instance.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        setHlsAudioTrack(data.id);
      });
      instance.loadSource(url);
      instance.attachMedia(element);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      instance?.destroy();
      if (hlsRef.current === instance) hlsRef.current = null;
      setHlsLevels([]);
      setHlsAudioTracks([]);
    };
  }, [url, isHls]);

  // Reflect the active subtitle track onto the <video>'s text tracks: show only
  // the active one, hide the rest. Match by label (our <track> elements carry
  // label={t.label}) rather than by index, because hls.js can inject its own
  // in-band subtitle tracks that desync a positional pairing. Tracks that don't
  // correspond to one of ours (e.g. hls.js-injected) are left untouched.
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i += 1) {
      const tt = list[i];
      if (tt.kind !== "subtitles") continue;
      const match = subs.tracks.find((t) => t.label === tt.label);
      if (match == null) continue; // not one of ours (hls.js-injected) - leave it
      tt.mode = match.id === subs.activeTrackId ? "showing" : "hidden";
    }
  }, [subs.tracks, subs.activeTrackId]);

  const seek = (t: number) => {
    const video = videoRef.current;
    if (video != null && Number.isFinite(t)) {
      video.currentTime = t;
      scrubberRef.current?.setCurrentTime(t);
    }
  };

  const relativeSeek = (delta: number) => {
    const video = videoRef.current;
    if (video == null) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : Number.POSITIVE_INFINITY;
    seek(Math.min(limit, Math.max(0, video.currentTime + delta)));
  };

  const toggleOptions = () => {
    setCaptionsOpen(false);
    setOptionsOpen((open) => !open);
  };

  const togglePlayerFullscreen = () => {
    const video = videoRef.current;
    if (video == null) return;
    const stage = video.closest(".player-stage");
    toggleFullscreen(stage instanceof HTMLElement ? stage : video, video);
  };

  const togglePictureInPicture = () => {
    const video = videoRef.current;
    if (video == null) return;
    const webkitVideo = video as WebKitVideoElement;
    if (
      document.pictureInPictureEnabled === true &&
      typeof video.requestPictureInPicture === "function"
    ) {
      try {
        if (document.pictureInPictureElement != null) {
          const exit = document.exitPictureInPicture?.();
          if (exit != null) void exit.catch(() => {});
        } else {
          void video.requestPictureInPicture().catch(() => {});
        }
      } catch {
        // A just-removed source can reject PiP before returning a promise.
      }
      return;
    }
    if (typeof webkitVideo.webkitSetPresentationMode === "function") {
      try {
        webkitVideo.webkitSetPresentationMode(
          webkitVideo.webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture",
        );
      } catch {
        // The iOS presentation mode can be unavailable for a given stream.
      }
    }
  };

  const showBrowserCastPicker = () => {
    const video = videoRef.current;
    if (video == null) return;
    const webkitVideo = video as WebKitVideoElement;
    if (
      airPlayAvailable &&
      typeof webkitVideo.webkitShowPlaybackTargetPicker === "function"
    ) {
      try {
        webkitVideo.webkitShowPlaybackTargetPicker();
      } catch {
        // The route can disappear between availability and this click.
      }
      return;
    }
    if (
      remotePlaybackAvailable &&
      "remote" in HTMLMediaElement.prototype &&
      typeof video.remote?.prompt === "function"
    ) {
      try {
        void video.remote.prompt().catch(() => {});
      } catch {
        // The route can disappear just before the prompt opens.
      }
    }
  };

  const activeSubtitle = subs.tracks.find(
    (track) => track.id === subs.activeTrackId,
  );
  const castSubtitleUrl =
    activeSubtitle != null && /^https?:\/\//i.test(activeSubtitle.vttUrl)
      ? activeSubtitle.vttUrl
      : null;
  const browserCastAvailable = airPlayAvailable || remotePlaybackAvailable;

  // Keyboard shortcuts (invisible power-user nicety). Active only while this
  // in-app player is mounted. Ignored when typing in a field (the CaptionsMenu
  // search, the ⌘K palette) or when a modifier is held (so ⌘K still toggles the
  // palette), and yields to the native <video> controls when the video itself is
  // focused. space/k: play-pause · ←/→: ∓5s · j/l: ∓10s · ↑/↓: volume · m: mute
  // · f: fullscreen · 0-9: seek to N0% · Home/End: start/end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (video == null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (suspendedRef.current) return;
      onActivity();
      if (shouldIgnoreShortcut(e.target, video)) return;
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const seekTo = (t: number) => {
        video.currentTime = dur > 0 ? Math.min(Math.max(t, 0), dur) : Math.max(t, 0);
      };
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          if (video.paused) void video.play();
          else video.pause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(video.currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(video.currentTime + 5);
          break;
        case "j":
        case "J":
          e.preventDefault();
          seekTo(video.currentTime - 10);
          break;
        case "l":
        case "L":
          e.preventDefault();
          seekTo(video.currentTime + 10);
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, Math.round((video.volume + 0.1) * 100) / 100);
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, Math.round((video.volume - 0.1) * 100) / 100);
          break;
        case "m":
        case "M":
          e.preventDefault();
          video.muted = !video.muted;
          break;
        case "c":
        case "C": {
          e.preventDefault();
          const ids = [null, ...subs.tracks.map((track) => track.id)];
          const current = ids.indexOf(subs.activeTrackId);
          subs.setActiveTrack(ids[(current + 1) % ids.length] ?? null);
          break;
        }
        case "<":
          e.preventDefault();
          video.playbackRate = Math.max(0.5, video.playbackRate - 0.25);
          break;
        case ">":
          e.preventDefault();
          video.playbackRate = Math.min(2, video.playbackRate + 0.25);
          break;
        case "n":
        case "N":
          if (onPlayNext != null) {
            e.preventDefault();
            onPlayNext();
          }
          break;
        case "f":
        case "F": {
          e.preventDefault();
          const stage = video.closest(".player-stage");
          toggleFullscreen(stage instanceof HTMLElement ? stage : video, video);
          break;
        }
        case "Home":
          e.preventDefault();
          seekTo(0);
          break;
        case "End":
          e.preventDefault();
          if (dur > 0) seekTo(dur);
          break;
        case "?":
          e.preventDefault();
          onOpenShortcuts();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && dur > 0) {
            e.preventDefault();
            seekTo((Number(e.key) / 10) * dur);
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onActivity,
    onOpenShortcuts,
    onPlayNext,
    subs.activeTrackId,
    subs.setActiveTrack,
    subs.tracks,
  ]);

  const resumePlayback = useCallback(() => {
    setPaused(false);
    void videoRef.current?.play();
  }, []);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (video == null) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const toggleMuted = useCallback(() => {
    const video = videoRef.current;
    if (video == null) return;
    if (video.muted || video.volume === 0) {
      const restored = video.volume > 0
        ? video.volume
        : Math.max(0.05, lastAudibleVolumeRef.current);
      video.volume = restored;
      video.muted = false;
      lastAudibleVolumeRef.current = restored;
      setVolume(restored);
      setMuted(false);
      return;
    }
    lastAudibleVolumeRef.current = video.volume;
    video.muted = true;
    setMuted(true);
  }, []);

  const changeVolume = useCallback((next: number) => {
    const video = videoRef.current;
    if (video == null) return;
    const clamped = Math.max(0, Math.min(1, next));
    if (clamped > 0) lastAudibleVolumeRef.current = clamped;
    video.volume = clamped;
    video.muted = clamped === 0;
    setVolume(clamped);
    setMuted(video.muted);
  }, []);

  const changePlaybackRate = useCallback((next: number) => {
    const video = videoRef.current;
    if (video == null || !Number.isFinite(next)) return;
    video.playbackRate = next;
    setPlaybackRate(next);
  }, []);

  const changeHlsLevel = (next: number) => {
    const hls = hlsRef.current;
    if (hls == null) return;
    hls.currentLevel = next;
    setHlsLevel(next);
  };

  const changeHlsAudioTrack = (next: number) => {
    const hls = hlsRef.current;
    if (hls == null) return;
    hls.audioTrack = next;
    setHlsAudioTrack(next);
  };

  return (
    <div
      className={`webview-player${suspended ? " is-casting" : ""}`}
      onPointerMove={onActivity}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        Playback speed {playbackRate} times. Subtitles{" "}
        {activeSubtitle == null ? "off" : activeSubtitle.label}.
        {activeSubtitle != null
          ? ` Subtitle delay ${(activeSubtitle.delayMs / 1000).toFixed(1)} seconds.`
          : ""}
      </span>
      <div className="player-stage">
        <video
          ref={videoRef}
          className="player-video"
          style={{
            objectFit: videoFit,
            transform: `translate(${videoPanX}%, ${videoPanY}%) scale(${videoZoom})`,
          }}
          autoPlay
          playsInline
          crossOrigin={url.includes("/api/stream/") ? "use-credentials" : undefined}
          x-webkit-airplay="allow"
          onClick={togglePlayback}
          onDoubleClick={togglePlayerFullscreen}
          onError={(event) => {
            // hls.js owns its media errors and bounded recovery. Native HLS and
            // direct files still surface the media element's error here.
            if (
              isHls &&
              !event.currentTarget.canPlayType("application/vnd.apple.mpegurl")
            ) {
              return;
            }
            onPlaybackErrorRef.current(mediaErrorMessage(event.currentTarget.error));
          }}
        >
          {subs.tracks.map((t) => (
            <track
              key={t.id}
              kind="subtitles"
              src={t.vttUrl}
              srcLang={t.language}
              label={t.label}
              default={t.id === subs.activeTrackId}
            />
          ))}
        </video>
      </div>

      {suspended && (
        <div className="cast-local-placeholder" aria-hidden="true">
          <Icon name="cast" size={36} />
          <span>Playing on your cast device</span>
        </div>
      )}

      {paused && !ended && !captionsOpen && !optionsOpen && !detailsOpen && !scrubbing && (
        <PlayerPauseOverlay
          title={title}
          nowPlaying={nowPlaying}
          onResume={resumePlayback}
        />
      )}

      <div
        className={`player-osd${chromeVisible ? " is-visible" : ""}`}
        aria-hidden={!chromeVisible || undefined}
        onPointerEnter={onChromeEnter}
        onPointerLeave={onChromeLeave}
        onFocusCapture={onChromeFocus}
        onBlurCapture={onChromeBlur}
      >
        <WebviewScrubber
          key={url}
          ref={scrubberRef}
          active={chromeVisible}
          duration={duration}
          preview={thumbs.available ? thumbs.preview : null}
          onHover={thumbs.onHover}
          onLeave={thumbs.onLeave}
          onSeek={seek}
          onScrubbingChange={setScrubbing}
          disabled={!chromeVisible}
        />
        <div className="player-osd-row">
          <div className="player-osd-group player-osd-audio">
            <button
              type="button"
              className="chip player-osd-icon-button"
              onClick={toggleMuted}
              aria-label={volumeIsSilent ? "Unmute" : "Mute"}
              aria-pressed={volumeIsSilent}
              title={volumeIsSilent ? "Unmute" : "Mute"}
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name={volumeIsSilent ? "volume-muted" : "volume"} size={17} />
            </button>
            <label className="player-volume-control" aria-label="Volume">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(event) => changeVolume(Number(event.target.value))}
                tabIndex={chromeVisible ? undefined : -1}
              />
            </label>
            <span ref={clockRef} className="player-time" aria-label="Playback time">
              0:00 / {clockLabel(duration)}
            </span>
          </div>

          <div className="player-osd-group player-osd-transport">
            <button
              type="button"
              className="chip player-osd-icon-button player-skip-button"
              onClick={() => relativeSeek(-10)}
              aria-label="Back 10 seconds"
              title="Back 10 seconds"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="rewind" size={18} />
              <span aria-hidden="true">10</span>
            </button>
            <button
              type="button"
              className="chip player-osd-icon-button player-primary-play"
              onClick={togglePlayback}
              aria-label={playing ? "Pause" : "Play"}
              title={playing ? "Pause" : "Play"}
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name={playing ? "pause" : "play"} size={19} />
            </button>
            <button
              type="button"
              className="chip player-osd-icon-button player-skip-button"
              onClick={() => relativeSeek(10)}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="forward" size={18} />
              <span aria-hidden="true">10</span>
            </button>
          </div>

          <div className="player-osd-group player-osd-actions">
            {onPlayNext != null && (
              <button
                type="button"
                className="chip player-osd-icon-button"
                onClick={onPlayNext}
                aria-label="Next episode"
                title={upNext?.label ? `Next episode: ${upNext.label}` : "Next episode"}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="skip-next" size={18} />
              </button>
            )}
            <label className="player-speed-control">
              <span className="sr-only">Playback speed</span>
              <select
                aria-label="Playback speed"
                value={playbackRate}
                onChange={(event) => changePlaybackRate(Number(event.target.value))}
                tabIndex={chromeVisible ? undefined : -1}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                  <option value={speed} key={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`chip player-osd-icon-button${captionsOpen || subs.activeTrackId != null ? " is-active" : ""}`}
              onClick={() => {
                setOptionsOpen(false);
                setCaptionsOpen((open) => !open);
              }}
              aria-label="Subtitles"
              aria-haspopup="dialog"
              aria-expanded={captionsOpen}
              title="Subtitles"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="captions" size={17} />
              {subs.activeTrackId != null && <span className="captions-active-dot" />}
            </button>
            {underTauri ? (
              <CastControls
                media={{ url, title, subtitleUrl: castSubtitleUrl }}
                buttonClassName="chip player-osd-icon-button player-mobile-optional"
                onLocalPlaybackChange={onCastLocalPlaybackChange}
              />
            ) : browserCastAvailable ? (
              <button
                type="button"
                className="chip player-osd-icon-button player-mobile-optional"
                onClick={showBrowserCastPicker}
                aria-label="Cast to a device"
                title={airPlayAvailable ? "AirPlay" : "Cast to a device"}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="cast" size={17} />
              </button>
            ) : null}
            {pictureInPictureSupported && (
              <button
                type="button"
                className={`chip player-osd-icon-button player-mobile-optional${isPictureInPicture ? " is-active" : ""}`}
                onClick={togglePictureInPicture}
                aria-label={isPictureInPicture ? "Exit picture in picture" : "Picture in picture"}
                aria-pressed={isPictureInPicture}
                title={isPictureInPicture ? "Exit picture in picture" : "Picture in picture"}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="picture-in-picture" size={17} />
              </button>
            )}
            <button
              type="button"
              className={`chip player-osd-icon-button${optionsOpen ? " is-active" : ""}`}
              onClick={toggleOptions}
              aria-label="Playback settings"
              aria-haspopup="dialog"
              aria-expanded={optionsOpen}
              title="Playback settings"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="sliders" size={17} />
            </button>
            {fullscreenSupported && (
              <button
                type="button"
                className={`chip player-osd-icon-button${isFullscreen ? " is-active" : ""}`}
                onClick={togglePlayerFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                aria-pressed={isFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name={isFullscreen ? "fullscreen-exit" : "fullscreen"} size={17} />
              </button>
            )}
          </div>
        </div>
      </div>

      {optionsOpen && (
        <div className="player-options-menu glass-lit" role="dialog" aria-label="Playback settings">
          <div className="player-options-head">
            <strong>Playback settings</strong>
            <button
              type="button"
              className="player-close"
              onClick={() => setOptionsOpen(false)}
              aria-label="Close playback settings"
            >
              <Icon name="xmark" size={15} />
            </button>
          </div>
          <div className="player-options-section">
            <span className="t-secondary">Video fit</span>
            <div className="player-options-choice-row">
              {(["contain", "cover", "fill"] as const).map((fit) => (
                <button
                  type="button"
                  className={`chip${videoFit === fit ? " is-active" : ""}`}
                  aria-pressed={videoFit === fit}
                  onClick={() => setVideoFit(fit)}
                  key={fit}
                >
                  {fit === "contain" ? "Fit" : fit === "cover" ? "Fill screen" : "Stretch"}
                </button>
              ))}
            </div>
          </div>
          <div className="player-options-section player-options-sliders">
            <label>
              <span className="t-secondary">Zoom</span>
              <span className="player-options-output">{Math.round(videoZoom * 100)}%</span>
              <input
                type="range"
                min={1}
                max={2.5}
                step={0.05}
                value={videoZoom}
                onChange={(event) => setVideoZoom(Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span className="t-secondary">Pan horizontally</span>
              <span className="player-options-output">{videoPanX}%</span>
              <input
                type="range"
                min={-50}
                max={50}
                step={1}
                value={videoPanX}
                onChange={(event) => setVideoPanX(Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span className="t-secondary">Pan vertically</span>
              <span className="player-options-output">{videoPanY}%</span>
              <input
                type="range"
                min={-50}
                max={50}
                step={1}
                value={videoPanY}
                onChange={(event) => setVideoPanY(Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span className="t-secondary">Subtitle position</span>
              <span className="player-options-output">{subtitlePosition}%</span>
              <input
                type="range"
                min={10}
                max={95}
                step={1}
                value={subtitlePosition}
                onChange={(event) =>
                  setSubtitlePosition(Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
          {hlsLevels.length > 1 && (
            <div className="player-options-section">
              <span className="t-secondary">Quality</span>
              <div className="player-options-choice-row">
                <button
                  type="button"
                  className={`chip${hlsLevel === -1 ? " is-active" : ""}`}
                  aria-pressed={hlsLevel === -1}
                  onClick={() => changeHlsLevel(-1)}
                >
                  Auto
                </button>
                {hlsLevels.map((level) => (
                  <button
                    type="button"
                    className={`chip${hlsLevel === level.index ? " is-active" : ""}`}
                    aria-pressed={hlsLevel === level.index}
                    onClick={() => changeHlsLevel(level.index)}
                    key={level.index}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {hlsAudioTracks.length > 1 && (
            <div className="player-options-section">
              <span className="t-secondary">Audio track</span>
              <div className="player-options-choice-row">
                {hlsAudioTracks.map((track) => (
                  <button
                    type="button"
                    className={`chip${hlsAudioTrack === track.index ? " is-active" : ""}`}
                    aria-pressed={hlsAudioTrack === track.index}
                    onClick={() => changeHlsAudioTrack(track.index)}
                    key={track.index}
                  >
                    {track.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            className="player-options-action"
            onClick={onOpenExternalPlayer}
          >
            <Icon name="play" size={17} />
            <span>
              <strong>Open in external player</strong>
              <small>VLC, IINA, mpv, or your device player</small>
            </span>
          </button>
          <button
            type="button"
            className="player-options-action"
            onClick={() => {
              setOptionsOpen(false);
              onOpenShortcuts();
            }}
          >
            <Icon name="help" size={17} />
            <span>
              <strong>Keyboard shortcuts</strong>
              <small>Transport, seeking, volume, and fullscreen</small>
            </span>
          </button>
          {externalActionStatus && (
            <p className="player-options-status" role="status">{externalActionStatus}</p>
          )}
        </div>
      )}

      {ended && upNext != null && onPlayNext != null && (
        <UpNextOverlay
          label={upNext.label}
          auto={autoCountdown}
          onPlayNext={onPlayNext}
        />
      )}

      {captionsOpen && (
        <CaptionsMenu
          subs={subs}
          seedTitle={title}
          seedImdbId={imdbId}
          seedSeason={season}
          seedEpisode={episode}
          onClose={() => setCaptionsOpen(false)}
        />
      )}
    </div>
  );
}

/** A small, dismissible reference for the player keyboard shortcuts. Surfaced
 * by the "?" key or the "?" OSD button - invisible otherwise. */
const WEBVIEW_SHORTCUTS: Array<[string, string]> = [
  ["Space / K", "Play / pause"],
  ["← / →", "Back / forward 5s"],
  ["J / L", "Back / forward 10s"],
  ["↑ / ↓", "Volume up / down"],
  ["M", "Mute"],
  ["C", "Cycle subtitles"],
  ["< / >", "Speed down / up"],
  ["N", "Next episode"],
  ["F", "Fullscreen"],
  ["0 – 9", "Jump to 0–90%"],
  ["Home / End", "Start / end"],
  ["?", "Toggle this help"],
];

/** "Up next" card at the end of a series episode: shows the next episode's
 * label with Play now / Dismiss. With `auto` (the auto-advance setting, minus
 * Data Saver) it counts down 10s and plays; without, it waits for a click. */
function UpNextOverlay({
  label,
  auto,
  onPlayNext,
}: {
  label: string;
  auto: boolean;
  onPlayNext: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [remaining, setRemaining] = useState(10);
  // The countdown fires through a ref so re-renders during the countdown
  // (polls, seasons landing) always reach the LATEST handler - an interval
  // closure would capture a stale one.
  const onPlayNextRef = useRef(onPlayNext);
  onPlayNextRef.current = onPlayNext;
  useEffect(() => {
    if (!auto || dismissed) return;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timer);
          onPlayNextRef.current();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    // Cleared on unmount AND on the dismiss re-run - no timer leak, and a
    // dismissed card can never fire.
    return () => clearInterval(timer);
  }, [auto, dismissed]);
  if (dismissed) return null;
  return (
    <div className="player-shortcuts-scrim">
      <div
        className="player-upnext glass-raised"
        role="dialog"
        aria-modal="true"
        aria-label={`Next episode: ${label}`}
      >
        <span className="player-upnext-title t-secondary">Up next</span>
        <span className="player-upnext-label">{label}</span>
        {auto && (
          <span className="player-upnext-count t-secondary">
            Playing in {remaining}s
          </span>
        )}
        <div className="player-upnext-actions">
          <button type="button" className="btn btn-prominent" onClick={onPlayNext}>
            <Icon name="play" size={14} />
            Play now
          </button>
          <button type="button" className="btn" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalPanel({
  underTauri,
  url,
  status,
  error,
  externalStatus,
  onOpenExternal,
  onTryNextSource,
  onRetry,
}: {
  underTauri: boolean;
  url: string;
  status: string | null;
  error: string | null;
  externalStatus: string | null;
  onOpenExternal: () => void;
  onTryNextSource?: () => Promise<void>;
  onRetry?: () => void;
}) {
  const [tryNextState, setTryNextState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  if (onRetry != null) {
    return (
      <div className="player-external">
        <Icon name="info" size={36} className="t-warning" />
        <h3 className="player-external-title">Playback interrupted</h3>
        <p className="player-external-err" role="alert">
          {error ?? "Playback could not continue."}
        </p>
        <div className="player-external-actions">
          {onTryNextSource != null && (
            <button
              type="button"
              className="btn btn-prominent"
              disabled={tryNextState.kind === "loading"}
              onClick={() => {
                setTryNextState({ kind: "loading" });
                void onTryNextSource().catch((nextError) => {
                  setTryNextState({
                    kind: "error",
                    message:
                      nextError instanceof Error
                        ? nextError.message
                        : String(nextError),
                  });
                });
              }}
            >
              {tryNextState.kind === "loading"
                ? "Preparing next source"
                : "Try next source"}
            </button>
          )}
          <button type="button" className="btn btn-prominent" onClick={onRetry}>
            Retry playback
          </button>
          <button type="button" className="btn" onClick={onOpenExternal}>
            Open in external player
          </button>
        </div>
        {tryNextState.kind === "error" && (
          <p className="player-external-err" role="alert">
            {tryNextState.message}
          </p>
        )}
        {externalStatus && <p className="player-external-sub" role="status">{externalStatus}</p>}
      </div>
    );
  }

  return (
    <div className="player-external">
      <Icon name="play" size={36} className="t-accent" />
      {underTauri ? (
        <>
          <h3 className="player-external-title">Opening in the bundled player</h3>
          <p className="player-external-sub t-secondary">
            {status ??
              "This file (MKV/HEVC) plays in the bundled mpv player. Starting…"}
          </p>
          {error && <p className="player-external-err" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <h3 className="player-external-title">Open externally</h3>
          <p className="player-external-sub t-secondary">
            {error ??
              "This file (MKV/HEVC) needs a native player. In the desktop app it opens in VLC/mpv automatically; in the browser, copy the link into your player."}
          </p>
          <button type="button" className="btn" onClick={onOpenExternal}>
            Open in external player
          </button>
          <a className="btn player-direct-link" href={url} target="_blank" rel="noreferrer noopener">
            Open direct link
          </a>
          {externalStatus && <p className="player-external-sub" role="status">{externalStatus}</p>}
        </>
      )}
    </div>
  );
}
