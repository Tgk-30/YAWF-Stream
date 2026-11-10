// In-app player.
//
// Two-backend playback:
//   1. In-webview <video> for HLS (.m3u8, via hls.js when the browser lacks
//      native HLS) and progressive MP4/WebM - the browser path.
//   2. Native hand-off for containers/codecs the webview cannot decode. Desktop
//      uses VLC/mpv/IINA, while Android uses a system ACTION_VIEW chooser. A
//      plain browser shows an open-externally note instead.
//
// `kind` lets the caller force the external path (e.g. an MKV stream); otherwise
// the extension is sniffed from the URL.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
// Type-only: the runtime module is imported on demand inside the HLS effect
// below, so this import contributes no bytes to the chunk.
import type HlsType from "hls.js";
type HlsInstance = InstanceType<typeof HlsType>;
export const WEBVIEW_STARTUP_TIMEOUT_MS = 20_000;
export const SERVER_HLS_STARTUP_TIMEOUT_MS = 45_000;
export const WEBVIEW_FALLBACK_TIMEOUT_MS = 8_000;
const NATIVE_HLS_SEEK_CONFIRM_TIMEOUT_MS = 1_200;
const SERVER_OPTIMIZED_REQUEST_TIMEOUT_MS = 8_000;
const SERVER_SOURCE_INFO_RETRY_DELAY_MS = 5_000;
const MAX_SOURCE_DURATION_SECONDS = 86_400;
const SERVER_OPTIMIZED_RETRY_BASE_MS = 500;
const SERVER_OPTIMIZED_RETRY_MAX_MS = 4_000;
const TOUCH_DOUBLE_TAP_MS = 320;
const PRE_BACKGROUND_PAUSE_CORRELATION_MS = 1_000;
const FOREGROUND_BUFFERLESS_TIMEOUT_MS = 3_000;
import { Icon } from "./Icon";
import { useVideoPresentation, type VideoPresentation } from "./useVideoPresentation";
import {
  isTauri,
  isDesktopTauri,
  openInExternalPlayer,
  playWithMpv,
  mpvStop,
} from "../lib/tauri";
import { deviceKind, isStandaloneDisplay } from "../lib/platform";
import { containerFullscreenExit, containerFullscreenRequest, ipadSafariPageUrl } from "../lib/playerFullscreen";
import {
  isAndroidAppUiContext,
  isAndroidExternalPlayerEligible,
  isAndroidServerExternalPlayerEligible,
  openAndroidExternalPlayer,
  openAndroidServerExternalPlayer,
} from "../lib/androidExternalPlayer";
import {
  browserExternalCapability,
  browserExternalGuidance,
  browserExternalFileHint,
  browserExternalPlayerLinks,
  type BrowserExternalPlayerLink,
} from "../lib/browserExternalPlayers";
import type { SubtitleClient } from "../services/subtitles/OpenSubtitlesClient";
import type { Translator } from "../services/subtitles/SubtitleTranslator";
import { useSubtitleTracks } from "./player/useSubtitleTracks";
import { useScrubThumbnails } from "./player/useScrubThumbnails";
import { useWakeLock } from "./player/useWakeLock";
import { useTVRemotePlayback } from "./player/useTVRemotePlayback";
import { ScrubBar } from "./player/ScrubBar";
import { AdjustmentRange } from "./player/AdjustmentRange";
import { CaptionsMenu, type EmbeddedCaptions } from "./player/CaptionsMenu";
import { EmbeddedPlayer } from "./EmbeddedPlayer";
import { CastControls } from "./CastControls";
import { predictEpisodeEnd } from "../lib/endPredictor";
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
import {
  findPreferredLanguageMatch,
  normalizeLanguagePreference,
} from "../lib/languagePreference";
import { audioTrackLabel } from "../lib/audioTrackLabel";
import { captionLayout, type CaptionRect } from "../lib/captionLayout";
import { configuredServerURL } from "../lib/serverMode";
import {
  PlaybackStallWatchdog,
  PlaybackRecoveryProgress,
  playbackExpectedToAdvance,
  type PlaybackStallState,
  withFreshStreamResolutionTimeout,
} from "../lib/playbackStall";
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
import { renewServerHlsLease, serverHlsLeaseTarget } from "../lib/serverApi";
import { notifyUnauthorized } from "../lib/serverSession";
import type {
  ServerAudioInventoryLoadOptions,
  ServerAudioTrack,
  ServerOptimizedSource,
  ServerStreamSourceInfo,
  ServerTranscodeQuality,
} from "../lib/serverApi";
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

export interface PlaybackHandoffState {
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  /** Transient logical selection, independent of per-title persistence. */
  audioPreference?: AudioPreference | null;
}

type WebviewRecoverySnapshot = {
  position: number;
  state: PlaybackHandoffState;
};
type WebviewRecoveryContext = WebviewRecoverySnapshot | (() => WebviewRecoverySnapshot);
type PendingRecoverySeek = WebviewRecoverySnapshot & {
  video: HTMLVideoElement;
  sequence: number;
  originPosition: number;
  healthyMediaTime: number | null;
};

type ServerOptimizedPositionIntent = "follow-current" | "fixed";
type ServerOptimizationPurpose = "ordinary" | "native-hls-seek" | "remembered-audio" | "automatic-default" | "recovery";
type PendingNativeHlsSeek = {
  sequence: number;
  absoluteTarget: number;
  localTarget: number;
  paused: boolean;
  playbackIntent: "play" | "pause" | null;
  fallbackStarted: boolean;
  timer: number | null;
};

function applyMediaPlaybackRate(video: HTMLMediaElement, playbackRate: number): void {
  // The media load algorithm can reset playbackRate to defaultPlaybackRate.
  // Keep both aligned so an asynchronous HLS attachment cannot discard the
  // saved or handoff speed that was applied before the source load begins.
  video.defaultPlaybackRate = playbackRate;
  video.playbackRate = playbackRate;
}

interface VideoPlayerProps {
  url: string;
  /** Changes when a fresh resolution returns the same URL string. */
  sourceRevision?: number;
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
  /** Terminal write hook. Fired at real EOF before the player unmounts. */
  onEnded?: (
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
  /** Resolve the currently playing source again. This must mint a new provider
   * URL and, in Server Mode, a new stream session rather than reload `url`. */
  refreshCurrentSource?: (
    absolutePositionSeconds: number,
    handoffState: PlaybackHandoffState,
  ) => Promise<void>;
  /** Runtime controls captured before a fresh source replacement. */
  initialHandoffState?: PlaybackHandoffState | null;
  /** Whether the card auto-plays after a countdown (false under Data Saver - 
   *  nothing plays without a click). */
  autoCountdown?: boolean;
  /** Chosen external player name (Settings). Passed to the VLC/IINA/mpv hand-off
   *  so it opens the user's preferred app first. "" / undefined = auto order. */
  preferredPlayer?: string;
  /** Desktop only: use the in-window libmpv player for containers the webview
   *  cannot decode. When false, use the bundled mpv or an external player. */
  useBuiltInPlayer?: boolean;
  /** Server Mode only. Kept optional so older servers and Local Mode retain the
   * original-device player without rendering unavailable controls. */
  serverOptimized?: {
    qualities: readonly ServerTranscodeQuality[];
    loadAudioTracks?: (
      options?: ServerAudioInventoryLoadOptions,
    ) => Promise<ServerAudioTrack[]>;
    loadSourceInfo?: (options?: Pick<
      ServerAudioInventoryLoadOptions,
      "retryFailed" | "signal"
    >) => Promise<{
      durationSeconds: number | null;
      tracks?: ServerAudioTrack[];
    }>;
    /** Legacy server-transcode preference, applied only after Device Original
     * has started and an optimized manifest is safely prepared. */
    defaultQuality?: ServerTranscodeQuality | null;
    request: (
      quality: ServerTranscodeQuality,
      absolutePositionSeconds: number,
      audioTrack?: number,
    ) => Promise<ServerOptimizedSource>;
  };
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

function androidTVContentType(
  engine: PlaybackEngine,
  url: string,
  sourceFileName?: string | null,
): string | null {
  if (engine === "webview-hls-transcode") {
    // This is Media3's HLS MIME type. application/vnd.apple.mpegurl is for
    // browser capability probing and does not select Media3's HLS source.
    return "application/x-mpegURL";
  }
  const pathname = (() => {
    try {
      return new URL(sourceFileName?.trim() || url).pathname;
    } catch {
      return sourceFileName?.trim() || url;
    }
  })().toLowerCase();
  if (/\.(?:m3u8|m3u)(?:$|[?#])/.test(pathname)) {
    return "application/x-mpegURL";
  }
  if (/\.(?:mp4|m4v|mov)(?:$|[?#])/.test(pathname)) return "video/mp4";
  if (/\.mkv(?:$|[?#])/.test(pathname)) return "video/x-matroska";
  if (/\.webm(?:$|[?#])/.test(pathname)) return "video/webm";
  if (/\.avi(?:$|[?#])/.test(pathname)) return "video/x-msvideo";
  if (/\.(?:ts|mts|m2ts)(?:$|[?#])/.test(pathname)) return "video/mp2t";
  return null;
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

function shouldUseNativeHls(video: HTMLVideoElement): boolean {
  // Native HLS commonly hides alternate audio tracks from web content even
  // when it reports that the manifest is playable. Prefer hls.js everywhere it
  // can use MSE so the player gets a real track inventory. iOS remains native
  // because WebKit does not expose MSE there. If hls.js later reports MSE as
  // unavailable, the attach effect falls back to this native capability.
  const kind = deviceKind();
  return (
    kind === "ios" &&
    video.canPlayType("application/vnd.apple.mpegurl") !== ""
  );
}

const WEBKIT_EXACT_ZERO_FRAGMENT_SECONDS = 0.001;

function nativeHlsSourceWithExactStart(
  url: string,
  startPositionSeconds: number | null | undefined,
): string {
  const target = Number.isFinite(startPositionSeconds)
    ? Math.max(0, startPositionSeconds as number)
    : 0;
  // WebKit applies a temporal media fragment after HAVE_CURRENT_DATA, but its
  // media element implementation ignores a fragment whose start is exactly 0.
  // Clamp sub-millisecond targets to a decimal NPT value that WebKit accepts;
  // one millisecond remains within the exact handoff tolerance.
  const fragmentTarget = target < WEBKIT_EXACT_ZERO_FRAGMENT_SECONDS
    ? WEBKIT_EXACT_ZERO_FRAGMENT_SECONDS
    : target;
  const hashIndex = url.indexOf("#");
  if (hashIndex < 0) return `${url}#t=${fragmentTarget}`;
  const separator = hashIndex === url.length - 1 || url.endsWith("&") ? "" : "&";
  // Keep existing non-time fragment parameters. Media fragment processing
  // uses the last valid temporal parameter, so this exact target wins.
  return `${url}${separator}t=${fragmentTarget}`;
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

/** Fullscreen must include the header, transport and sibling player dialogs,
 * not just the video stage. Keep every entry point on the same DOM owner. */
function playerFullscreenContainer(video: HTMLVideoElement): HTMLElement | null {
  const container = video.closest(".player");
  return container instanceof HTMLElement ? container : null;
}

/** Prefer complete-player fullscreen; keep genuine video-only WebKit fallback. */
function toggleFullscreen(el: HTMLElement, video?: HTMLVideoElement): void {
  const d = document as WebKitDocument;
  const active = document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  if (active != null) {
    try {
      const exit = containerFullscreenExit(d)?.();
      if (exit != null) void exit.catch(() => {});
    } catch {
      // Browser rejected the gesture or exposes a partial fullscreen API.
    }
    return;
  }
  const request = containerFullscreenRequest(el);
  if (request != null) {
    try {
      const result = request();
      if (result != null) void result.then(lockLandscapeOrientation).catch(() => {});
      else lockLandscapeOrientation();
    } catch {
      // Do not switch APIs after a rejected request or leave this user gesture.
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
    // The custom scrub slider owns its arrows and Home/End, like native ranges.
    role === "slider" ||
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

/** Session cookies belong only on the current app/server's canonical stream
 * route. A provider CDN can legitimately contain the same path text, so path
 * matching alone must never opt it into credentialed CORS. */
function isTrustedServerStreamURL(rawUrl: string): boolean {
  try {
    const target = new URL(rawUrl, window.location.href);
    const matchesMountedStreamPath = (basePath: string) => {
      const normalizedBase = basePath.replace(/\/+$/, "");
      const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `^${escapedBase}/api/stream/[^/?#]+(?:/|$)`,
        "i",
      ).test(target.pathname);
    };
    if (
      target.origin === window.location.origin &&
      matchesMountedStreamPath("")
    ) {
      return true;
    }
    const configured = configuredServerURL();
    if (configured != null) {
      const server = new URL(configured, window.location.href);
      return target.origin === server.origin && matchesMountedStreamPath(server.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

function isTrustedServerHlsManifestURL(rawUrl: string): boolean {
  if (!isTrustedServerStreamURL(rawUrl)) return false;
  try {
    const target = new URL(rawUrl, window.location.href);
    return /(?:^|\/)api\/stream\/[^/?#]+\/index\.m3u8$/i.test(target.pathname);
  } catch {
    return false;
  }
}

function serverOptimizedQualityFromURL(
  rawUrl: string,
  qualities: readonly ServerTranscodeQuality[],
): ServerTranscodeQuality | null {
  if (!isTrustedServerHlsManifestURL(rawUrl)) return null;
  try {
    const quality = new URL(rawUrl, window.location.href).searchParams.get("quality");
    return qualities.find((candidate) => candidate === quality) ?? null;
  } catch {
    return null;
  }
}

function serverOptimizedAudioFromURL(rawUrl: string): number | null {
  if (!isTrustedServerHlsManifestURL(rawUrl)) return null;
  try {
    const rawAudio = new URL(rawUrl, window.location.href).searchParams.get("audio");
    if (rawAudio == null || !/^\d+$/.test(rawAudio)) return null;
    const audioTrack = Number(rawAudio);
    return Number.isInteger(audioTrack) && audioTrack >= 0 && audioTrack < 32
      ? audioTrack
      : null;
  } catch {
    return null;
  }
}

function normalizedServerAudioTracks(
  tracks: readonly ServerAudioTrack[] | undefined,
): ServerAudioTrack[] {
  if (!Array.isArray(tracks)) return [];
  const seen = new Set<number>();
  return tracks.filter((track) => {
    if (
      !Number.isInteger(track.index) ||
      track.index < 0 ||
      track.index >= 32 ||
      seen.has(track.index)
    ) {
      return false;
    }
    seen.add(track.index);
    return true;
  }).slice(0, 32);
}

function sourceInfoHttpStatus(error: unknown): number | null {
  if (error == null || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function webviewStartupTimeout(engine: PlaybackEngine, sourceUrl: string): number {
  return engine === "webview-hls-transcode" &&
    isTrustedServerHlsManifestURL(sourceUrl)
    ? SERVER_HLS_STARTUP_TIMEOUT_MS
    : WEBVIEW_STARTUP_TIMEOUT_MS;
}

function promiseWithinTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error == null) resolve(value as T);
      else reject(error);
    };
    const timer = window.setTimeout(() => {
      onTimeout?.();
      finish(null, new Error(timeoutMessage));
    }, timeoutMs);
    void promise.then(
      (value) => finish(value),
      (error) => finish(null, error),
    );
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestFallbackWithinTimeout(
  request: () => Promise<string | null>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(
      () => finish(null),
      WEBVIEW_FALLBACK_TIMEOUT_MS,
    );
    Promise.resolve()
      .then(request)
      .then((value) => finish(value), () => finish(null));
  });
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

function durationClockLabel(seconds: number | null): string {
  return seconds == null ? "--:--" : clockLabel(seconds);
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
  id: string;
  label: string;
  language: string | null;
  logicalLabel?: string | null;
  isDefault?: boolean;
}

interface AudioPreference {
  id: string | null;
  language: string | null;
  label?: string | null;
}

function normalizedSourceAudioLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

function retainedServerAudioMatch(
  preference: AudioPreference | null,
  tracks: readonly HlsAudioChoice[],
): HlsAudioChoice | null {
  if (preference == null) return null;
  const language = normalizeLanguagePreference(preference.language);
  const label = normalizedSourceAudioLabel(preference.label);
  const languageMatches = language == null
    ? []
    : tracks.filter(
        (track) => normalizeLanguagePreference(track.language) === language,
      );
  if (label != null) {
    const labeledMatches = (language == null ? tracks : languageMatches).filter(
      (track) => normalizedSourceAudioLabel(track.logicalLabel) === label,
    );
    if (labeledMatches.length === 1) return labeledMatches[0]!;
    return null;
  }
  return languageMatches.length === 1 ? languageMatches[0]! : null;
}

function manualServerAudioScope(
  sourceFileName: string | null | undefined,
  scrobbleContext: TraktScrobbleContext | null,
  imdbId: string | null | undefined,
  season: number | null | undefined,
  episode: number | null | undefined,
  title: string,
  subtitle: string | null | undefined,
): string | null {
  // Fresh stream URLs and numeric track indexes are generation-local. Retain
  // only a semantic choice for the same media file and content identity.
  const file = sourceFileName?.trim();
  if (!file) return null;
  const content = scrobbleContext == null
    ? imdbId?.trim()
      ? ["imdb", imdbId.trim(), season ?? null, episode ?? null]
      : ["metadata", title.trim(), subtitle?.trim() ?? null, season ?? null, episode ?? null]
    : [
        "tmdb",
        scrobbleContext.type,
        scrobbleContext.tmdbId,
        scrobbleContext.season ?? null,
        scrobbleContext.episode ?? null,
      ];
  return JSON.stringify([content, file]);
}

/** Safari and some embedded WebViews expose the non-standard AudioTrackList
 * API. Chromium does not, so every access must remain capability-gated. */
interface BrowserAudioTrack {
  id?: string;
  label?: string;
  language?: string;
  enabled: boolean;
}

interface BrowserAudioTrackList extends EventTarget {
  readonly length: number;
  readonly [index: number]: BrowserAudioTrack;
  item?(index: number): BrowserAudioTrack | null;
}

interface BrowserAudioVideoElement extends HTMLVideoElement {
  readonly audioTracks?: BrowserAudioTrackList;
}

/** Keep media-clock updates local to the scrub bar. Browser `timeupdate` fires
 * about four times per second; captions, help controls, and the video shell do
 * not need to reconcile for each tick. */
const WebviewScrubber = memo(
  forwardRef<
    WebviewScrubberHandle,
    Omit<React.ComponentProps<typeof ScrubBar>, "currentTime" | "onSeekPreview"> & { active: boolean }
  >(function WebviewScrubber({ duration, active, ...props }, ref) {
    const [currentTime, setCurrentTime] = useState(0);
    const latestTimeRef = useRef(0);
    const activeRef = useRef(active);
    activeRef.current = active;
    // ScrubBar owns the transient thumb/time preview. Only onSeek may commit
    // release or keyboard input to media; pointer preview must remain local.
    const keepPreviewLocal = useCallback(() => {}, []);

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

    return <ScrubBar {...props} duration={duration} currentTime={currentTime} onSeekPreview={keepPreviewLocal} />;
  }),
);

export function VideoPlayer({
  url,
  sourceRevision = 0,
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
  onEnded,
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
  refreshCurrentSource,
  initialHandoffState = null,
  autoCountdown = true,
  playerPreferences = null,
  preferredPlayer,
  useBuiltInPlayer = true,
  serverOptimized,
}: VideoPlayerProps) {
  const requestedEngine = engine ?? inferEngine(url, kind);
  const serverAudioRetentionScope = manualServerAudioScope(
    sourceFileName,
    scrobbleContext,
    imdbId,
    season,
    episode,
    title,
    subtitle,
  );
  const [manualServerAudioPreference, setManualServerAudioPreference] = useState<{
    scope: string;
    preference: AudioPreference;
  } | null>(null);
  const [manualServerOptimizedQuality, setManualServerOptimizedQuality] = useState<{
    scope: string;
    originOwner: string;
    quality: ServerTranscodeQuality;
  } | null>(null);
  const retainedServerOptimizedQuality =
    serverAudioRetentionScope != null &&
    manualServerOptimizedQuality?.scope === serverAudioRetentionScope &&
    serverOptimized?.qualities.includes(manualServerOptimizedQuality.quality)
      ? manualServerOptimizedQuality.quality
      : null;
  const retainedServerAudioPreference =
    serverAudioRetentionScope != null &&
    manualServerAudioPreference?.scope === serverAudioRetentionScope
      ? manualServerAudioPreference.preference
      : null;
  useLayoutEffect(() => {
    setManualServerAudioPreference((current) =>
      current?.scope === serverAudioRetentionScope ? current : null,
    );
    setManualServerOptimizedQuality((current) =>
      current?.scope === serverAudioRetentionScope ? current : null,
    );
  }, [serverAudioRetentionScope]);
  const rememberManualServerAudioPreference = useCallback((preference: AudioPreference) => {
    if (serverAudioRetentionScope == null) return;
    setManualServerAudioPreference({
      scope: serverAudioRetentionScope,
      preference,
    });
  }, [serverAudioRetentionScope]);
  type ScopedOptimizedSource = ServerOptimizedSource & {
    originOwner: string;
    requestSequence: number;
    intentEpoch: number;
    audioPreference?: AudioPreference;
    partialTimeline: boolean;
    leaseTarget: string | null;
  };
  type ScopedPosition = {
    originOwner: string;
    position: number;
  };
  type ScopedDuration = {
    originOwner: string;
    duration: number;
  };
  type ScopedSourceAudio = {
    originOwner: string;
    tracks: ServerAudioTrack[];
    defaultTrack: number | null;
  };
  const [fallbackSource, setFallbackSource] = useState<{
    originUrl: string;
    originEngine: PlaybackEngine;
    url: string;
    recovery?: WebviewRecoverySnapshot;
  } | null>(null);
  const [optimizedSource, setOptimizedSource] = useState<ScopedOptimizedSource | null>(null);
  const [sourceSwitchPosition, setSourceSwitchPosition] = useState<ScopedPosition | null>(null);
  const [sourceSwitchState, setSourceSwitchState] = useState<PlaybackHandoffState | null>(null);
  const [knownAbsoluteDuration, setKnownAbsoluteDuration] = useState<ScopedDuration | null>(null);
  const [knownSourceAudio, setKnownSourceAudio] = useState<ScopedSourceAudio | null>(null);
  const [serverOptimizationError, setServerOptimizationError] = useState<string | null>(null);
  const [serverOptimizationPending, setServerOptimizationPending] = useState(false);
  const latestAbsolutePositionRef = useRef(0);
  const autoOptimizationAttemptedRef = useRef<string | null>(null);
  const [verifiedPlaybackProgressOwner, setVerifiedPlaybackProgressOwner] = useState<string | null>(null);
  const playbackOwner = `${requestedEngine}\u0000${sourceRevision}\u0000${url}`;
  // Stable content/file identity survives internal generations and fresh URLs.
  // Without a file identity, retain only within the original playback owner.
  const [videoPresentation, changeVideoPresentation] = useVideoPresentation(
    serverAudioRetentionScope ?? playbackOwner,
  );
  // The original URL, engine, and caller-issued revision define media identity.
  // Internal optimized/fallback URLs never change this owner, while a fresh
  // external resolution cannot inherit duration from an older file by accident.
  const durationOwner = playbackOwner;
  const activeKnownAbsoluteDuration =
    knownAbsoluteDuration?.originOwner === durationOwner
      ? knownAbsoluteDuration.duration
      : null;
  const activeFallback =
    fallbackSource?.originUrl === url &&
    fallbackSource.originEngine === requestedEngine
      ? fallbackSource
      : null;
  const activeOptimized =
    optimizedSource?.originOwner === playbackOwner
      ? optimizedSource
      : null;
  const originalSourceIsServerOptimized =
    serverOptimized != null &&
    requestedEngine === "webview-hls-transcode" &&
    isTrustedServerHlsManifestURL(url);
  const initialServerOptimizedTimeline =
    activeOptimized == null &&
    originalSourceIsServerOptimized;
  const initialServerOptimizedQuality = initialServerOptimizedTimeline
    ? serverOptimizedQualityFromURL(url, serverOptimized?.qualities ?? [])
    : null;
  const reportVerifiedPlaybackProgress = useCallback(() => {
    if (!originalSourceIsServerOptimized) return;
    setVerifiedPlaybackProgressOwner((current) =>
      current === playbackOwner ? current : playbackOwner,
    );
  }, [originalSourceIsServerOptimized, playbackOwner]);
  const explicitInitialServerAudioTrack = initialServerOptimizedTimeline
    ? serverOptimizedAudioFromURL(url)
    : null;
  const activeKnownSourceAudio = knownSourceAudio?.originOwner === playbackOwner
    ? knownSourceAudio
    : null;
  const initialServerAudioTrack = explicitInitialServerAudioTrack ??
    activeKnownSourceAudio?.defaultTrack ??
    null;
  const activeSourceSwitchPosition =
    sourceSwitchPosition?.originOwner === playbackOwner
      ? sourceSwitchPosition.position
      : null;
  const activeSourceSwitchState =
    sourceSwitchPosition?.originOwner === playbackOwner
      ? sourceSwitchState
      : initialHandoffState;
  const effectiveUrl = activeFallback?.url ?? activeOptimized?.url ?? url;
  const effectiveEngine: PlaybackEngine = activeFallback
    ? "webview-hls-transcode"
    : activeOptimized != null
      ? "webview-hls-transcode"
      : requestedEngine;
  // An explicit null is an availability fence from Server Mode: its protected
  // player URL must never be handed to an app that cannot inherit web cookies.
  // Undefined retains the legacy/local behavior of using the playable source.
  const externalTarget = externalPlaybackUrl === null
    ? null
    : externalPlaybackUrl?.trim() || effectiveUrl;
  const effectiveTimelineOffsetSeconds = activeOptimized?.timelineOffsetSeconds ?? timelineOffsetSeconds;
  const effectiveStartPositionSeconds = activeOptimized?.startPositionSeconds ?? (
    activeSourceSwitchPosition == null
      ? startPositionSeconds
      : Math.max(0, activeSourceSwitchPosition - timelineOffsetSeconds)
  );
  const underTauri = isTauri();
  const androidAppUi = isAndroidAppUiContext();
  // The in-window native player and desktop hand-off exist only on desktop.
  // Android uses a separate, narrowly granted system video chooser.
  const desktopTauri = !androidAppUi && isDesktopTauri();
  // A mobile source can still arrive tagged native-mpv from old persisted state
  // or a stale caller. Never expose that desktop engine on Android or iOS.
  // Trying it in the webview lets the normal media-error path request HLS.
  const mobileTauri = androidAppUi || (underTauri && !desktopTauri);
  const dk = deviceKind();
  const browserExternalTarget = !underTauri && !androidAppUi
    ? browserExternalCapability(externalTarget)
    : null;
  const browserExternalLinks = useMemo(
    () => browserExternalPlayerLinks(
      browserExternalTarget,
      title,
      dk,
      isStandaloneDisplay(),
      browserExternalFileHint(sourceFileName),
    ),
    [browserExternalTarget, dk, sourceFileName, title],
  );
  const browserExternalHelp = browserExternalTarget == null
    ? null
    : browserExternalGuidance(dk, isStandaloneDisplay());
  const androidTauri = isAndroidExternalPlayerEligible();
  const androidServerPlayer = isAndroidServerExternalPlayerEligible(externalTarget);
  const androidNativeChooser = androidTauri || androidServerPlayer;
  const externalPlaybackAvailable = externalTarget != null && (
    underTauri || androidAppUi || browserExternalTarget != null
  );
  const mode: Playability =
    effectiveEngine === "native-mpv" && !mobileTauri ? "external" : "webview";
  // In-window native player: the DEFAULT desktop path for containers/codecs the
  // webview can't decode (MKV/HEVC). Renders libmpv on a native surface behind the
  // transparent window (see EmbeddedPlayer): macOS = CAOpenGLLayer render API,
  // Windows/Linux = mpv wid-embed. If the surface can't init (e.g. Wayland, or a
  // missing libmpv) the player offers a one-click external hand-off; when the user
  // opts out it's the external hand-off (VLC/IINA/…) directly.
  const useEmbedded =
    underTauri &&
    (dk === "mac" || dk === "windows" || dk === "linux") &&
    mode === "external" &&
    useBuiltInPlayer;
  const [externalStatus, setExternalStatus] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [detailsSection, setDetailsSection] = useState<"info" | "shortcuts" | null>(null);
  const detailsTriggerRef = useRef<{ element: HTMLButtonElement; owner: string } | null>(null);
  const detailsWasOpenRef = useRef(false);
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
  const externalHandoffVideoRef = useRef<HTMLVideoElement | null>(null);
  const externalHandoffPauseRef = useRef<((video: HTMLVideoElement) => boolean) | null>(null);
  const ownedWebviewStateRef = useRef<{ video: HTMLVideoElement; source: { key: string }; read: () => PlaybackHandoffState | null } | null>(null);
  const pauseWebviewForExternalHandoff = useCallback(() => {
    const video = externalHandoffVideoRef.current;
    if (video != null && externalHandoffPauseRef.current?.(video) !== true) video.pause();
  }, []);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [castSuspended, setCastSuspended] = useState(false);
  const [webMenuOpen, setWebMenuOpen] = useState(false);
  const [webRecoveryPending, setWebRecoveryPending] = useState(false);
  const [manualRecoveryPending, setManualRecoveryPending] = useState(false);
  const [scopedExternalActionStatus, setScopedExternalActionStatus] = useState<{
    owner: string;
    target: string;
    message: string;
  } | null>(null);
  const externalActionStatus =
    scopedExternalActionStatus?.owner === playbackOwner &&
    externalTarget != null &&
    scopedExternalActionStatus.target === externalTarget
      ? scopedExternalActionStatus.message
      : null;
  const setExternalActionStatus = useCallback((message: string | null) => {
    setScopedExternalActionStatus(
      message == null || externalTarget == null
        ? null
        : { owner: playbackOwner, target: externalTarget, message },
    );
  }, [externalTarget, playbackOwner]);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const webviewSourceKey = `${effectiveUrl}:${sourceRevision}:${playbackAttempt}:${activeSourceSwitchPosition ?? "initial"}:${activeOptimized?.requestSequence ?? "original"}`;
  // A new keyed media owner starts pending, even before its effects run. Use
  // an identity token so callbacks from an earlier visit to the same URL cannot
  // change the current source's presentation readiness.
  const webviewSource = useMemo(() => ({ key: webviewSourceKey }), [webviewSourceKey]);
  const retainedPhysicalReaderRef = useRef<{ key: string; owner: string; scope: string; handoff: PlaybackHandoffState; adopted: boolean } | null>(null);
  const physicalContentScope = serverAudioRetentionScope ?? JSON.stringify([imdbId, season, episode, sourceFileName, title, subtitle]);
  const retainedReader = retainedPhysicalReaderRef.current;
  const retainPhysicalReader = retainedReader != null && retainedReader.scope === physicalContentScope &&
    (retainedReader.owner === playbackOwner || (!retainedReader.adopted && initialHandoffState === retainedReader.handoff));
  const physicalReaderKey = retainPhysicalReader ? retainedReader.key : webviewSourceKey;
  const physicalReaderKeyRef = useRef(physicalReaderKey);
  useLayoutEffect(() => {
    physicalReaderKeyRef.current = physicalReaderKey;
    if (retainedPhysicalReaderRef.current !== retainedReader || retainedReader == null) return;
    if (!retainPhysicalReader) { retainedPhysicalReaderRef.current = null; return; }
    if (retainedReader.owner !== playbackOwner) { retainedReader.owner = playbackOwner; retainedReader.adopted = true; }
  }, [physicalReaderKey, playbackOwner, retainPhysicalReader, retainedReader]);
  const currentWebviewSourceRef = useRef(webviewSource);
  const failedWebviewRecoveryRef = useRef<{
    owner: string;
    source: { key: string };
    snapshot: WebviewRecoverySnapshot;
    message: string;
  } | null>(null);
  useLayoutEffect(() => {
    currentWebviewSourceRef.current = webviewSource;
  }, [webviewSource]);
  const [webviewReadiness, setWebviewReadiness] = useState<{
    source: typeof webviewSource;
    pending: boolean;
  } | null>(null);
  const reportWebviewPending = useCallback((pending: boolean) => {
    if (currentWebviewSourceRef.current !== webviewSource) return;
    setWebviewReadiness((current) =>
      current?.source === webviewSource && current.pending === pending
        ? current
        : { source: webviewSource, pending },
    );
  }, [webviewSource]);
  const webviewPending = webviewReadiness?.source !== webviewSource || webviewReadiness.pending;
  const [serverLeaseExpired, setServerLeaseExpired] = useState(false);
  const activeWebSourceRef = useRef(effectiveUrl);
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [androidTVError, setAndroidTVError] = useState<string | null>(null);
  const [webScrubbing, setWebScrubbing] = useState(false);
  const playbackOwnerRef = useRef(playbackOwner);
  const playerMountedRef = useRef(false);
  const recoveryRequestSequenceRef = useRef(0);
  const recoveryPendingRef = useRef<{ owner: string; request: number } | null>(null);
  const optimizationRequestSequenceRef = useRef(0);
  const explicitOptimizationIntentRef = useRef(0);
  // Failure recovery and an explicit Original choice both suppress automatic
  // audio replacement until a fresh user intent or committed owner reset.
  const automaticAudioIntentFenceRef = useRef<{ owner: string; intentEpoch: number } | null>(null);
  const optimizationPendingRef = useRef<{
    owner: string;
    request: number;
    controller: AbortController;
    purpose: ServerOptimizationPurpose;
    failureState?: () => PlaybackHandoffState;
  } | null>(null);
  const sourceInfoLoadOwnerRef = useRef<string | null>(null);
  const sourceInfoGenerationRef = useRef(0);
  const sourceInfoRetryRef = useRef<{
    owner: string;
    generation: number;
    timer: number | null;
    controller: AbortController | null;
    retryStarted: boolean;
  } | null>(null);
  const cancelSourceInfoRetry = useCallback((owner?: string) => {
    const pending = sourceInfoRetryRef.current;
    if (pending == null || (owner != null && pending.owner !== owner)) return;
    if (pending.timer != null) window.clearTimeout(pending.timer);
    pending.controller?.abort();
    sourceInfoRetryRef.current = null;
  }, []);
  // Async ownership follows the committed player, not a replacement render
  // that React can suspend or abandon while the old owner remains mounted.
  useLayoutEffect(() => {
    activeWebSourceRef.current = effectiveUrl;
    playbackOwnerRef.current = playbackOwner;
  }, [effectiveUrl, playbackOwner]);
  const invalidateManualServerAudioPreference = useCallback((
    owner: string,
    preference: AudioPreference,
  ) => {
    if (playbackOwnerRef.current !== owner) return;
    setManualServerAudioPreference((current) =>
      current?.scope === serverAudioRetentionScope && current.preference === preference
        ? null
        : current,
    );
  }, [serverAudioRetentionScope]);
  useLayoutEffect(() => {
    playerMountedRef.current = true;
    return () => {
      playerMountedRef.current = false;
      recoveryRequestSequenceRef.current += 1;
      recoveryPendingRef.current = null;
      failedWebviewRecoveryRef.current = null;
      optimizationRequestSequenceRef.current += 1;
      optimizationPendingRef.current?.controller.abort();
      optimizationPendingRef.current = null;
      sourceInfoGenerationRef.current += 1;
      sourceInfoLoadOwnerRef.current = null;
      cancelSourceInfoRetry();
    };
  }, [cancelSourceInfoRetry]);
  useLayoutEffect(() => {
    recoveryRequestSequenceRef.current += 1;
    recoveryPendingRef.current = null;
    failedWebviewRecoveryRef.current = null;
    optimizationRequestSequenceRef.current += 1;
    optimizationPendingRef.current?.controller.abort();
    optimizationPendingRef.current = null;
    sourceInfoGenerationRef.current += 1;
    cancelSourceInfoRetry();
    setServerOptimizationPending(false);
    setServerOptimizationError(null);
    autoOptimizationAttemptedRef.current = null;
    explicitOptimizationIntentRef.current = 0;
    automaticAudioIntentFenceRef.current = null;
    setWebRecoveryPending(false);
    setExternalActionStatus(null);
    setExternalError(null);
    setServerLeaseExpired(false);
    setManualRecoveryPending(false);
  }, [cancelSourceInfoRetry, playbackOwner]);
  const androidTVNative = hasAndroidTVBridge();
  const sharedTouchPlayer =
    mode === "webview" &&
    !androidTVNative &&
    ((dk === "ios" && !underTauri) || androidAppUi);
  const webviewChildShown = mode === "webview" && externalError == null;
  useLayoutEffect(() => {
    if (!webviewChildShown) retainedPhysicalReaderRef.current = null;
  }, [webviewChildShown]);
  const webviewChildMenuOpen = webviewChildShown && (captionsOpen || webMenuOpen);
  const touchMenuOpen = sharedTouchPlayer && webviewChildMenuOpen;
  const androidOnCloseRef = useRef(onClose);
  const androidOnProgressRef = useRef(onProgress);
  androidOnCloseRef.current = onClose;
  androidOnProgressRef.current = onProgress;
  const [chromeHovered, setChromeHovered] = useState(false);
  const [chromeFocused, setChromeFocused] = useState(false);
  const chromeInputModalityRef = useRef<"keyboard" | "pointer" | null>(null);
  const chromeHoveredOwnerRef = useRef<HTMLElement | null>(null);
  const chromeFocusedOwnerRef = useRef<HTMLElement | null>(null);
  const chromePointerFocusTargetRef = useRef<Element | null>(null);
  const chromePointerFocusTimerRef = useRef<number | undefined>(undefined);
  const chromeExplicitPointerFocusRef = useRef(false);
  const chromeHideTimer = useRef<number | undefined>(undefined);
  const chromeControlPointerHoldRef = useRef<{
    owner: string;
    source: typeof webviewSource;
    pointerId: number;
    target: HTMLElement;
  } | null>(null);
  const chromeControlPointerTimerRef = useRef<number | undefined>(undefined);
  const lastChromeNudgeAt = useRef(Number.NEGATIVE_INFINITY);
  const webviewErrorPanelShown = mode === "webview" && externalError != null;
  const chromePinned =
    webviewErrorPanelShown || webviewPending || webviewPaused || webScrubbing || webviewChildMenuOpen || detailsSection != null || chromeHovered || chromeFocused;
  const chromePinnedRef = useRef(chromePinned);
  useLayoutEffect(() => {
    chromePinnedRef.current = chromePinned;
  }, [chromePinned]);
  const playerDialogRef = useModalA11y<HTMLDivElement>(
    onClose,
    !useEmbedded,
    webviewChildMenuOpen || detailsSection != null,
  );

  const reportAbsolutePosition = useCallback((next: number) => {
    if (Number.isFinite(next)) latestAbsolutePositionRef.current = Math.max(0, next);
  }, []);

  const rememberAbsoluteDuration = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return;
    setKnownAbsoluteDuration((current) =>
      current?.originOwner === durationOwner && current.duration === next
        ? current
        : { originOwner: durationOwner, duration: next },
    );
  }, [durationOwner]);

  const reportProgress = useCallback((
    currentSeconds: number,
    durationSeconds: number | null,
    prefs?: PlaybackPrefs,
  ) => {
    if (
      activeOptimized == null &&
      activeFallback == null &&
      !initialServerOptimizedTimeline &&
      durationSeconds != null
    ) {
      rememberAbsoluteDuration(durationSeconds);
    }
    onProgress?.(
      currentSeconds,
      activeKnownAbsoluteDuration ?? durationSeconds,
      prefs,
    );
  }, [
    activeFallback,
    activeKnownAbsoluteDuration,
    activeOptimized,
    initialServerOptimizedTimeline,
    onProgress,
    rememberAbsoluteDuration,
  ]);

  const reportEnded = useCallback((
    currentSeconds: number,
    durationSeconds: number | null,
    prefs?: PlaybackPrefs,
  ) => {
    onEnded?.(
      currentSeconds,
      activeKnownAbsoluteDuration ?? durationSeconds,
      prefs,
    );
  }, [activeKnownAbsoluteDuration, onEnded]);

  const currentWebviewHandoffState = useCallback((
    fallback?: PlaybackHandoffState | null,
  ): PlaybackHandoffState | null => {
    const video = externalHandoffVideoRef.current;
    if (video == null) return fallback ?? null;
    const reader = ownedWebviewStateRef.current;
    if (reader?.video === video && reader.source === currentWebviewSourceRef.current) {
      const state = reader.read();
      if (state != null) return state;
    }
    return {
      paused: video.paused,
      volume: Number.isFinite(video.volume)
        ? Math.min(1, Math.max(0, video.volume))
        : fallback?.volume ?? 1,
      muted: video.muted,
      playbackRate:
        Number.isFinite(video.playbackRate) && video.playbackRate > 0
          ? video.playbackRate
          : fallback?.playbackRate ?? 1,
    };
  }, []);

  const automaticStallRecoveryAttemptedRef = useRef(false);
  const automaticStallRecoverySourceRef = useRef<typeof webviewSource | null>(null);
  const stallRecoveryPendingRef = useRef(false);
  const freshStreamRequestRef = useRef<{ owner: string; source: typeof webviewSource } | null>(null);
  const lastStallContextRef = useRef<{
    position: number;
    handoff: PlaybackHandoffState;
  } | null>(null);

  useLayoutEffect(() => {
    // Only a committed media replacement retires an in-flight resolution.
    // A suspended render must leave the current source's request authoritative.
    freshStreamRequestRef.current = null;
    stallRecoveryPendingRef.current = false;
    lastStallContextRef.current = null;
    setWebRecoveryPending(false);
    setManualRecoveryPending(false);
    return () => {
      freshStreamRequestRef.current = null;
      stallRecoveryPendingRef.current = false;
    };
  }, [playbackOwner, webviewSource]);

  const reportRecoveryPlaybackHealthy = useCallback((video: HTMLVideoElement): boolean => {
    if (externalHandoffVideoRef.current !== video || !video.isConnected || !playerMountedRef.current || playbackOwnerRef.current !== playbackOwner ||
        currentWebviewSourceRef.current !== webviewSource || freshStreamRequestRef.current != null ||
        stallRecoveryPendingRef.current || !automaticStallRecoveryAttemptedRef.current ||
        automaticStallRecoverySourceRef.current == null || automaticStallRecoverySourceRef.current === webviewSource) return false;
    automaticStallRecoveryAttemptedRef.current = false;
    automaticStallRecoverySourceRef.current = null;
    recordDiagnostic("player", "stall.refresh_rearmed");
    return true;
  }, [playbackOwner, webviewSource]);

  const reportNativeRecoveryPlaybackHealthy = useCallback((): boolean => {
    if (!playerMountedRef.current || playbackOwnerRef.current !== playbackOwner ||
        currentWebviewSourceRef.current !== webviewSource || freshStreamRequestRef.current != null ||
        stallRecoveryPendingRef.current || !automaticStallRecoveryAttemptedRef.current ||
        automaticStallRecoverySourceRef.current == null || automaticStallRecoverySourceRef.current === webviewSource) return false;
    automaticStallRecoveryAttemptedRef.current = false;
    automaticStallRecoverySourceRef.current = null;
    recordDiagnostic("player", "stall.refresh_rearmed");
    return true;
  }, [playbackOwner, webviewSource]);

  const recoverPostStartStall = useCallback(async (
    absolutePositionSeconds: number,
    handoff: PlaybackHandoffState,
  ): Promise<boolean> => {
    const owner = playbackOwner;
    const source = webviewSource;
    const ownsSource = () => playerMountedRef.current && playbackOwnerRef.current === owner &&
      currentWebviewSourceRef.current === source;
    if (!ownsSource()) return false;
    const position = Number.isFinite(absolutePositionSeconds)
      ? Math.max(0, absolutePositionSeconds)
      : latestAbsolutePositionRef.current;
    latestAbsolutePositionRef.current = position;
    lastStallContextRef.current = { position, handoff };
    if (
      refreshCurrentSource == null ||
      automaticStallRecoveryAttemptedRef.current ||
      stallRecoveryPendingRef.current
    ) {
      setExternalError(
        "Playback stopped making progress. Retry to request a fresh stream, or choose another source.",
      );
      return false;
    }
    const request = { owner, source };
    retainedPhysicalReaderRef.current = { key: physicalReaderKeyRef.current, owner, scope: physicalContentScope, handoff, adopted: false };
    freshStreamRequestRef.current = request;
    const ownsRequest = () => ownsSource() && freshStreamRequestRef.current === request;
    automaticStallRecoveryAttemptedRef.current = true;
    automaticStallRecoverySourceRef.current = source;
    stallRecoveryPendingRef.current = true;
    setWebRecoveryPending(true);
    recordDiagnostic("player", "stall.refresh_started", "warning");
    try {
      await withFreshStreamResolutionTimeout(refreshCurrentSource(position, handoff));
      if (ownsRequest()) recordDiagnostic("player", "stall.refresh_ready");
      return true;
    } catch {
      if (!ownsRequest()) return false;
      setExternalError(
        "A fresh stream could not be prepared. Retry, or choose another source.",
      );
      recordDiagnostic("player", "stall.refresh_failed", "error");
      return false;
    } finally {
      if (ownsRequest()) {
        freshStreamRequestRef.current = null;
        stallRecoveryPendingRef.current = false;
        setWebRecoveryPending(false);
      }
    }
  }, [physicalContentScope, playbackOwner, refreshCurrentSource, webviewSource]);

  const retryFreshStream = useCallback(async (): Promise<void> => {
    const context = lastStallContextRef.current;
    const owner = playbackOwner;
    const source = webviewSource;
    const ownsSource = () => playerMountedRef.current && playbackOwnerRef.current === owner &&
      currentWebviewSourceRef.current === source;
    if (!ownsSource() || refreshCurrentSource == null || context == null || manualRecoveryPending || freshStreamRequestRef.current != null) return;
    const request = { owner, source };
    freshStreamRequestRef.current = request;
    const ownsRequest = () => ownsSource() && freshStreamRequestRef.current === request;
    setManualRecoveryPending(true);
    recordDiagnostic("player", "stall.manual_retry_started");
    try {
      await withFreshStreamResolutionTimeout(
        refreshCurrentSource(context.position, context.handoff),
      );
      if (!ownsRequest()) return;
      // A successful resolver must publish a new source owner. Until then an
      // expired generation cannot be remounted under its old URL.
      if (!serverLeaseExpired) setExternalError(null);
      recordDiagnostic("player", "stall.manual_retry_ready");
    } catch {
      if (!ownsRequest()) return;
      setExternalError(
        "A fresh stream could not be prepared. Retry, or choose another source.",
      );
      recordDiagnostic("player", "stall.manual_retry_failed", "error");
    } finally {
      if (ownsRequest()) {
        freshStreamRequestRef.current = null;
        setManualRecoveryPending(false);
      }
    }
  }, [manualRecoveryPending, playbackOwner, refreshCurrentSource, serverLeaseExpired, webviewSource]);

  const expireServerGeneration = useCallback((
    source: string,
    position: number,
    handoff: PlaybackHandoffState,
  ) => {
    if (!playerMountedRef.current || playbackOwnerRef.current !== playbackOwner ||
      activeWebSourceRef.current !== source || optimizationPendingRef.current != null) return;
    lastStallContextRef.current = { position, handoff };
    setServerLeaseExpired(true);
    setExternalError(refreshCurrentSource == null
      ? "This stream has expired. Choose another source or close the player."
      : "This stream has expired. Retry to request a fresh stream, or choose another source.");
    recordDiagnostic("player", "server_generation.expired", "warning");
    if (refreshCurrentSource != null && !automaticStallRecoveryAttemptedRef.current &&
      freshStreamRequestRef.current == null) {
      void recoverPostStartStall(position, handoff);
    }
  }, [playbackOwner, recoverPostStartStall, refreshCurrentSource]);

  // State is scoped below for render-time safety. Reset it too, so a completed
  // previous source cannot leave stale errors or an automatic-mode latch on the
  // next episode.
  useEffect(() => {
    latestAbsolutePositionRef.current = Math.max(0, startPositionSeconds ?? 0) + timelineOffsetSeconds;
    setFallbackSource(null);
    setOptimizedSource(null);
    setSourceSwitchPosition(null);
    setSourceSwitchState(null);
    setServerOptimizationError(null);
    setServerOptimizationPending(false);
  }, [requestedEngine, sourceRevision, url]);

  useEffect(() => {
    setKnownAbsoluteDuration(null);
  }, [durationOwner]);

  const rememberServerSourceInfo = useCallback((
    owner: string,
    sourceInfo: {
      durationSeconds: number | null;
      tracks?: ServerAudioTrack[];
    },
    generation?: number,
  ) => {
    if (
      !playerMountedRef.current ||
      playbackOwnerRef.current !== owner ||
      (generation != null && sourceInfoGenerationRef.current !== generation)
    ) {
      return;
    }
    const pendingRetry = sourceInfoRetryRef.current;
    if (
      pendingRetry?.owner === owner &&
      (generation == null || pendingRetry.generation === generation)
    ) {
      if (pendingRetry.timer != null) window.clearTimeout(pendingRetry.timer);
      pendingRetry.controller?.abort();
      sourceInfoRetryRef.current = null;
    }
    const durationSeconds = sourceInfo.durationSeconds;
    if (
      typeof durationSeconds === "number" &&
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0 &&
      durationSeconds <= MAX_SOURCE_DURATION_SECONDS
    ) {
      setKnownAbsoluteDuration((current) =>
        current?.originOwner === owner
          ? current
          : { originOwner: owner, duration: durationSeconds },
      );
    }
    if (Array.isArray(sourceInfo.tracks)) {
      const tracks = normalizedServerAudioTracks(sourceInfo.tracks);
      const defaults = tracks.filter((track) => track.default);
      setKnownSourceAudio({
        originOwner: owner,
        tracks,
        defaultTrack: defaults.length === 1 ? defaults[0]!.index : null,
      });
    }
  }, []);
  const rememberCurrentServerSourceInfo = useCallback(
    (sourceInfo: ServerStreamSourceInfo) => {
      const generation = sourceInfoGenerationRef.current;
      rememberServerSourceInfo(playbackOwner, sourceInfo, generation);
    },
    [playbackOwner, rememberServerSourceInfo],
  );

  useEffect(() => {
    const loadSourceInfo = serverOptimized?.loadSourceInfo;
    if (
      (mode !== "webview" && !useEmbedded) ||
      loadSourceInfo == null ||
      sourceInfoLoadOwnerRef.current === playbackOwner
    ) {
      return;
    }
    const owner = playbackOwner;
    const generation = sourceInfoGenerationRef.current;
    sourceInfoLoadOwnerRef.current = owner;
    const retry = {
      owner,
      generation,
      timer: null as number | null,
      controller: null as AbortController | null,
      retryStarted: false,
    };
    sourceInfoRetryRef.current = retry;
    void promiseWithinTimeout(
      Promise.resolve().then(() => loadSourceInfo()),
      SERVER_OPTIMIZED_REQUEST_TIMEOUT_MS,
      "Source information timed out.",
    ).then((sourceInfo) => {
      rememberServerSourceInfo(owner, sourceInfo, generation);
    }).catch((error: unknown) => {
      // Source metadata is an optional enhancement. Playback remains usable
      // with an unknown total when probing is unavailable or times out.
      if (
        sourceInfoHttpStatus(error) !== 409 ||
        sourceInfoRetryRef.current !== retry ||
        !playerMountedRef.current ||
        playbackOwnerRef.current !== owner ||
        sourceInfoGenerationRef.current !== generation
      ) {
        if (sourceInfoRetryRef.current === retry) sourceInfoRetryRef.current = null;
        return;
      }
      retry.timer = window.setTimeout(() => {
        retry.timer = null;
        if (
          sourceInfoRetryRef.current !== retry ||
          retry.retryStarted ||
          !playerMountedRef.current ||
          playbackOwnerRef.current !== owner ||
          sourceInfoGenerationRef.current !== generation
        ) {
          return;
        }
        retry.retryStarted = true;
        const controller = new AbortController();
        retry.controller = controller;
        // Do not wrap the server's extended retry lane in the ordinary eight
        // second metadata budget. The server owns its 15-second retry probe.
        void Promise.resolve().then(() => loadSourceInfo({
          retryFailed: true,
          signal: controller.signal,
        })).then((sourceInfo) => {
          rememberServerSourceInfo(owner, sourceInfo, generation);
        }).catch(() => {
          // A failed retry is terminal for this playback owner.
          if (sourceInfoRetryRef.current === retry) sourceInfoRetryRef.current = null;
        });
      }, SERVER_SOURCE_INFO_RETRY_DELAY_MS);
    });
  }, [mode, playbackOwner, rememberServerSourceInfo, serverOptimized?.loadSourceInfo, useEmbedded]);

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
      const hold = chromeControlPointerHoldRef.current;
      const ownsControlPointer = hold != null && hold.owner === playbackOwnerRef.current &&
        hold.source === currentWebviewSourceRef.current && hold.target.isConnected;
      if (!chromePinnedRef.current && !ownsControlPointer) setWebChromeVisible(false);
    }, 3200);
  }, [clearChromeTimer, mode]);
  const clearChromeControlPointerHold = useCallback((restartIdle = true) => {
    const hold = chromeControlPointerHoldRef.current;
    if (hold == null) return;
    chromeControlPointerHoldRef.current = null;
    window.clearTimeout(chromeControlPointerTimerRef.current);
    chromeControlPointerTimerRef.current = undefined;
    if (restartIdle && playerMountedRef.current && hold.owner === playbackOwnerRef.current &&
        hold.source === currentWebviewSourceRef.current) {
      // A terminal event starts a full idle window, independent of move throttling.
      clearChromeTimer();
      nudgeChrome();
    }
  }, [clearChromeTimer, nudgeChrome]);
  useEffect(() => {
    const finishControlPointer = (event: PointerEvent) => {
      if (chromeControlPointerHoldRef.current?.pointerId === event.pointerId) clearChromeControlPointerHold();
    };
    const cancelControlPointer = () => clearChromeControlPointerHold();
    window.addEventListener("pointerup", finishControlPointer, true);
    window.addEventListener("pointercancel", finishControlPointer, true);
    window.addEventListener("blur", cancelControlPointer);
    return () => {
      window.removeEventListener("pointerup", finishControlPointer, true);
      window.removeEventListener("pointercancel", finishControlPointer, true);
      window.removeEventListener("blur", cancelControlPointer);
      clearChromeControlPointerHold(false);
    };
  }, [clearChromeControlPointerHold]);
  useLayoutEffect(() => () => clearChromeControlPointerHold(false),
    [clearChromeControlPointerHold, playbackOwner, webviewSource]);
  const clearChromePointerFocus = useCallback(() => {
    window.clearTimeout(chromePointerFocusTimerRef.current);
    chromePointerFocusTimerRef.current = undefined;
    chromePointerFocusTargetRef.current = null;
  }, []);
  useEffect(() => {
    const finishPointer = () => {
      window.clearTimeout(chromePointerFocusTimerRef.current);
      // Let the same input turn deliver native focus/click, but do not retain
      // pointer classification when a drag ends without a click.
      chromePointerFocusTimerRef.current = window.setTimeout(clearChromePointerFocus, 0);
    };
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", clearChromePointerFocus);
    window.addEventListener("blur", clearChromePointerFocus);
    return () => {
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", clearChromePointerFocus);
      window.removeEventListener("blur", clearChromePointerFocus);
      clearChromePointerFocus();
    };
  }, [clearChromePointerFocus]);
  useLayoutEffect(() => {
    if (chromeHoveredOwnerRef.current?.isConnected === false) {
      chromeHoveredOwnerRef.current = null;
      setChromeHovered(false);
    }
    const focused = chromeFocusedOwnerRef.current;
    if (focused != null && (!focused.isConnected || document.activeElement !== focused)) {
      chromeFocusedOwnerRef.current = null;
      setChromeFocused(false);
    }
    if (chromePointerFocusTargetRef.current?.isConnected === false) clearChromePointerFocus();
  }, [clearChromePointerFocus, webviewSource]);
  const holdChrome = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Touch and pen can enter controls without ever delivering a hover leave.
    if (event.pointerType !== "mouse") return;
    chromeHoveredOwnerRef.current = event.currentTarget;
    setChromeHovered(true);
    nudgeChrome();
  }, [nudgeChrome]);
  const releaseChrome = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse" || chromeHoveredOwnerRef.current !== event.currentTarget) return;
    chromeHoveredOwnerRef.current = null;
    setChromeHovered(false);
    nudgeChrome();
  }, [nudgeChrome]);
  const noteChromePointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    clearChromePointerFocus();
    chromeInputModalityRef.current = "pointer";
    chromePointerFocusTargetRef.current = event.target instanceof Element ? event.target : null;
    chromeFocusedOwnerRef.current = null;
    setChromeFocused(false);
    if (event.pointerType !== "mouse") {
      chromeHoveredOwnerRef.current = null;
      setChromeHovered(false);
    }
    if (event.isPrimary === false || event.button > 0) return;
    const control = event.target instanceof Element
      ? event.target.closest("button, a[href], select, [role='button'], [role='switch']") : null;
    if (!(control instanceof HTMLElement) || !event.currentTarget.contains(control) ||
        control.matches(":disabled, [aria-disabled='true']") || !Number.isSafeInteger(event.pointerId)) {
      clearChromeControlPointerHold();
      return;
    }
    clearChromeControlPointerHold(false);
    const hold = { owner: playbackOwner, source: webviewSource, pointerId: event.pointerId, target: control };
    chromeControlPointerHoldRef.current = hold;
    clearChromeTimer();
    nudgeChrome();
    // Lost UP/CANCEL cannot leave a control lease pinned indefinitely. This is
    // one fixed safety bound, not an extension of the ordinary 3.2-second idle.
    chromeControlPointerTimerRef.current = window.setTimeout(() => {
      if (chromeControlPointerHoldRef.current === hold) clearChromeControlPointerHold();
    }, 10_000);
  }, [clearChromeControlPointerHold, clearChromePointerFocus, clearChromeTimer, nudgeChrome, playbackOwner, webviewSource]);
  const noteChromeClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (chromePointerFocusTargetRef.current != null || event.detail > 0) {
      chromeInputModalityRef.current = "pointer";
    } else if (chromeInputModalityRef.current === "pointer") {
      chromeInputModalityRef.current = null;
    }
    const hold = chromeControlPointerHoldRef.current;
    if (hold != null && event.target instanceof Node && hold.target.contains(event.target)) clearChromeControlPointerHold();
  }, [clearChromeControlPointerHold]);
  const noteChromeKeyboard = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    clearChromePointerFocus();
    chromeInputModalityRef.current = "keyboard";
    // A keyboard can take over an already touch-focused control without a new
    // focus event. Keep that control visible, including on hybrid devices.
    const focused = document.activeElement;
    const ownsFocus = focused instanceof HTMLElement && event.currentTarget.contains(focused) &&
      focused.closest(".player-bar, .player-osd, .player-touch-transport") != null;
    chromeFocusedOwnerRef.current = ownsFocus ? focused : null;
    setChromeFocused(ownsFocus);
    nudgeChrome();
  }, [clearChromePointerFocus, nudgeChrome]);
  const focusChrome = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const target = event.target;
    const pointer = chromePointerFocusTargetRef.current;
    const pointerFocus = chromeExplicitPointerFocusRef.current || (pointer != null &&
      (target.contains(pointer) || pointer.contains(target)));
    // Only a current pointer gesture or an explicitly scoped menu restoration
    // suppresses focus pinning. Later independent/assistive focus is not a tap.
    chromeFocusedOwnerRef.current = pointerFocus ? null : target;
    setChromeFocused(!pointerFocus);
    nudgeChrome();
  }, [nudgeChrome]);
  const focusChromeControl = useCallback((target: HTMLElement | null) => {
    if (target == null || !target.isConnected) return;
    const pointerFocus = chromeInputModalityRef.current === "pointer";
    chromeExplicitPointerFocusRef.current = pointerFocus;
    try {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) {
        // Modal cleanup may already have focused this exact trigger, so a new
        // focus event is not guaranteed. Apply this operation's own intent.
        chromeFocusedOwnerRef.current = pointerFocus ? null : target;
        setChromeFocused(!pointerFocus);
      }
    } finally {
      chromeExplicitPointerFocusRef.current = false;
    }
  }, []);
  const blurChrome = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      const focused = chromeFocusedOwnerRef.current;
      if (focused != null && !event.currentTarget.contains(focused)) return;
      chromeFocusedOwnerRef.current = null;
      setChromeFocused(false);
      nudgeChrome();
    },
    [nudgeChrome],
  );
  useEffect(() => {
    const open = detailsSection != null;
    const wasOpen = detailsWasOpenRef.current;
    detailsWasOpenRef.current = open;
    if (!wasOpen || open) return;
    const origin = detailsTriggerRef.current;
    detailsTriggerRef.current = null;
    const player = playerDialogRef.current;
    // The child popover's modal cleanup restores first. Reconcile only this
    // actual header operation, never a shortcut or a retired player's origin.
    if (origin == null || origin.owner !== playbackOwner ||
        origin.owner !== playbackOwnerRef.current || !origin.element.isConnected ||
        player == null || !player.isConnected || origin.element.closest(".player") !== player) return;
    focusChromeControl(origin.element);
  }, [detailsSection, focusChromeControl, playbackOwner, playerDialogRef]);

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
    setManualRecoveryPending(false);
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

  const resolveWebviewFallbackForRequest = useCallback(async (
    owner: string,
    request: number,
    fallbackRequest: (() => Promise<string | null>) | undefined,
    recovery?: WebviewRecoveryContext,
  ): Promise<boolean | null> => {
    if (fallbackRequest == null) {
      recordDiagnostic("player", "native.fallback_unavailable", "warning");
      return false;
    }
    recordDiagnostic("player", "native.fallback_started");
    const hlsUrl = await requestFallbackWithinTimeout(fallbackRequest);
    const stillOwned =
      playerMountedRef.current &&
      playbackOwnerRef.current === owner &&
      recoveryPendingRef.current?.owner === owner &&
      recoveryPendingRef.current.request === request;
    if (!stillOwned) return null;
    if (hlsUrl == null || hlsUrl.length === 0) {
      recordDiagnostic("player", "native.fallback_failed", "error");
      return false;
    }
    const snapshot = typeof recovery === "function" ? recovery() : recovery;
    if (snapshot != null) {
      latestAbsolutePositionRef.current = snapshot.position;
      setSourceSwitchPosition({ originOwner: owner, position: snapshot.position });
      setSourceSwitchState(snapshot.state);
    }
    setFallbackSource({
      originUrl: url,
      originEngine: requestedEngine,
      url: hlsUrl,
      recovery: snapshot,
    });
    recordDiagnostic("player", "native.fallback_ready");
    return true;
  }, [requestedEngine, url]);

  const recoverNativeInWebview = useCallback(async (
    _error: Error,
    recovery?: WebviewRecoverySnapshot,
  ): Promise<boolean> => {
    const owner = playbackOwner;
    if (
      !playerMountedRef.current ||
      playbackOwnerRef.current !== owner ||
      recoveryPendingRef.current?.owner === owner
    ) {
      return false;
    }
    const request = ++recoveryRequestSequenceRef.current;
    recoveryPendingRef.current = { owner, request };
    setWebRecoveryPending(true);
    setExternalActionStatus("Preparing a browser-compatible stream…");
    const recovered = await resolveWebviewFallbackForRequest(
      owner,
      request,
      requestWebviewFallback,
      recovery,
    );
    if (
      !playerMountedRef.current ||
      playbackOwnerRef.current !== owner ||
      recoveryPendingRef.current?.owner !== owner ||
      recoveryPendingRef.current.request !== request
    ) {
      return false;
    }
    recoveryPendingRef.current = null;
    setWebRecoveryPending(false);
    setExternalActionStatus(null);
    return recovered === true;
  }, [
    playbackOwner,
    requestWebviewFallback,
    resolveWebviewFallbackForRequest,
    setExternalActionStatus,
  ]);

  /** Prepare the server manifest before replacing the currently playing source.
   * This keeps Device Original running when ffmpeg is busy, unavailable, or
   * fails to start. HLS session cookies stay in the webview fetch path. */
  const switchToServerOptimized = useCallback(
    async (
      quality: ServerTranscodeQuality,
      absolutePositionSeconds: number,
      handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
      audioTrack?: number,
      audioPreference?: AudioPreference,
      positionIntent: ServerOptimizedPositionIntent = "follow-current",
      retainAudioPreference = false,
      purpose: ServerOptimizationPurpose = "ordinary",
    ): Promise<boolean> => {
      const owner = playbackOwner;
      if (
        serverOptimized == null ||
        !playerMountedRef.current ||
        playbackOwnerRef.current !== owner
      ) {
        return false;
      }
      const blockedIntent = automaticAudioIntentFenceRef.current;
      if ((purpose === "remembered-audio" || purpose === "recovery") && blockedIntent?.owner === owner &&
        blockedIntent.intentEpoch === explicitOptimizationIntentRef.current) return false;
      if (optimizationPendingRef.current?.owner === owner) {
        if (purpose === "native-hls-seek") {
          setServerOptimizationError(
            "Another playback change is still being prepared. Try seeking again.",
          );
        }
        return false;
      }
      const position = Number.isFinite(absolutePositionSeconds)
        ? Math.max(0, absolutePositionSeconds)
        : 0;
      const request = ++optimizationRequestSequenceRef.current;
      const intentEpoch = explicitOptimizationIntentRef.current;
      const controller = new AbortController();
      optimizationPendingRef.current?.controller.abort();
      optimizationPendingRef.current = { owner, request, controller, purpose };
      const ownsRequest = () =>
        playerMountedRef.current &&
        playbackOwnerRef.current === owner &&
        optimizationPendingRef.current?.owner === owner &&
        optimizationPendingRef.current.request === request;
      setServerOptimizationPending(true);
      setServerOptimizationError(null);
      try {
        latestAbsolutePositionRef.current = position;
        // Resolve the job URL quickly, then give the trusted server manifest
        // the same cold-start budget as hls.js. Device Original remains active
        // throughout preparation and transient server-busy retries.
        const next = await promiseWithinTimeout(
          Promise.resolve().then(() =>
            audioTrack == null
              ? serverOptimized.request(quality, position)
              : serverOptimized.request(quality, position, audioTrack),
          ),
          SERVER_OPTIMIZED_REQUEST_TIMEOUT_MS,
          "Server optimized playback timed out before preparation began.",
        );
        if (!ownsRequest()) return false;
        if (!isTrustedServerHlsManifestURL(next.url)) {
          throw new Error("The server returned an untrusted optimized playback URL.");
        }
        const manifestDeadline = Date.now() + SERVER_HLS_STARTUP_TIMEOUT_MS;
        let retryDelayMs = SERVER_OPTIMIZED_RETRY_BASE_MS;
        let manifest: string | null = null;
        let preparedAudioTrack = purpose === "recovery" ? next.audioTrack : audioTrack ?? next.audioTrack;
        while (manifest == null) {
          if (!ownsRequest() || controller.signal.aborted) return false;
          const remainingMs = manifestDeadline - Date.now();
          if (remainingMs <= 0) {
            controller.abort();
            throw new Error("Server optimized playback timed out.");
          }
          const response = await promiseWithinTimeout(
            fetch(next.url, {
              credentials: "include",
              headers: { accept: "application/vnd.apple.mpegurl" },
              signal: controller.signal,
            }),
            remainingMs,
            "Server optimized playback timed out.",
            () => controller.abort(),
          );
          if (!ownsRequest()) return false;
          if (response.status === 503 || response.status === 504) {
            const retryRemainingMs = manifestDeadline - Date.now();
            if (retryRemainingMs <= 0) {
              controller.abort();
              throw new Error("Server optimized playback timed out.");
            }
            await abortableDelay(
              Math.min(retryDelayMs, retryRemainingMs),
              controller.signal,
            );
            retryDelayMs = Math.min(retryDelayMs * 2, SERVER_OPTIMIZED_RETRY_MAX_MS);
            continue;
          }
          if (!response.ok) {
            throw new Error(`The server could not prepare ${quality} playback (${response.status}).`);
          }
          const responseAudioTrack = response.headers.get("x-yawf-transcode-audio");
          if (/^(?:0|[1-9]|[12][0-9]|3[01])$/.test(responseAudioTrack ?? "")) {
            preparedAudioTrack = Number(responseAudioTrack);
          }
          const textRemainingMs = manifestDeadline - Date.now();
          if (textRemainingMs <= 0) {
            controller.abort();
            throw new Error("Server optimized playback timed out.");
          }
          manifest = await promiseWithinTimeout(
            response.text(),
            textRemainingMs,
            "Server optimized playback timed out.",
            () => controller.abort(),
          );
        }
        if (!ownsRequest()) return false;
        if (!manifest.startsWith("#EXTM3U")) {
          throw new Error("The server did not return a playable HLS manifest.");
        }
        if (!ownsRequest()) return false;
        // Ordinary quality switches follow playback while the manifest warms.
        // An explicit out-of-window seek instead owns its requested position;
        // a late clock event from the old media must not undo that user action.
        const activationPosition = positionIntent === "fixed"
          ? position
          : latestAbsolutePositionRef.current;
        // A user seek can move before an already-prepared audio generation.
        // Keep the original source rather than clamp that newer intent forward.
        if (purpose === "remembered-audio" && activationPosition < next.timelineOffsetSeconds) {
          return false;
        }
        latestAbsolutePositionRef.current = activationPosition;
        const activationStart = Math.max(
          0,
          activationPosition - next.timelineOffsetSeconds,
        );
        const requestedHandoffState = typeof handoffState === "function"
          ? handoffState()
          : handoffState ?? null;
        if (!ownsRequest()) return false;
        const currentHandoffState = currentWebviewHandoffState(requestedHandoffState);
        const failureState = optimizationPendingRef.current?.failureState?.();
        const activationHandoffState =
          failureState != null
            ? { ...failureState, audioPreference: requestedHandoffState?.audioPreference }
            : purpose === "recovery" && requestedHandoffState != null
            ? requestedHandoffState
            : (purpose === "native-hls-seek" || purpose === "remembered-audio") &&
          requestedHandoffState != null && currentHandoffState != null
            ? { ...currentHandoffState, paused: requestedHandoffState.paused }
            : currentHandoffState;
        const requestedAudioConfirmed =
          audioPreference != null &&
          audioTrack != null &&
          preparedAudioTrack === audioTrack;
        if (purpose === "recovery" && audioTrack != null && !requestedAudioConfirmed) {
          throw new Error("Optimized playback could not preserve the selected audio track. Open an external player or choose another source.");
        }
        if (retainAudioPreference && requestedAudioConfirmed) {
          rememberManualServerAudioPreference(audioPreference);
        }
        const appliedTrack = preparedAudioTrack == null
          ? null
          : activeKnownSourceAudio?.tracks.find(
              (track) => track.index === preparedAudioTrack,
            ) ?? null;
        const appliedAudioPreference = requestedAudioConfirmed
          ? audioPreference
          : preparedAudioTrack == null
            ? undefined
            : {
                id: String(preparedAudioTrack),
                language: appliedTrack?.language?.trim() || null,
                label: appliedTrack?.label?.trim() || null,
              };
        if ((purpose === "ordinary" || purpose === "native-hls-seek") && retainedPhysicalReaderRef.current?.owner === owner) {
          retainedPhysicalReaderRef.current = null;
        }
        setFallbackSource(null);
        setSourceSwitchPosition({
          originOwner: owner,
          position: activationPosition,
        });
        setSourceSwitchState(activationHandoffState);
        setOptimizedSource({
          ...next,
          audioTrack: preparedAudioTrack,
          audioPreference: appliedAudioPreference,
          leaseTarget: serverHlsLeaseTarget(next.url, manifest),
          partialTimeline: /(?:^|\n)#EXT-X-PLAYLIST-TYPE:EVENT(?:\r?$|\s)/m.test(manifest),
          startPositionSeconds: activationStart,
          originOwner: owner,
          requestSequence: request,
          intentEpoch,
        });
        recordDiagnostic("player", "server_optimized.ready", "info", quality);
        return true;
      } catch (error) {
        if (!ownsRequest()) return false;
        const message = error instanceof Error ? error.message : "The server could not prepare optimized playback.";
        setServerOptimizationError(message);
        recordDiagnostic("player", "server_optimized.failed", "warning", message);
        if (optimizationPendingRef.current?.failureState != null) setExternalError(message);
        if (purpose === "recovery") throw new Error(message);
        return false;
      } finally {
        if (ownsRequest()) {
          optimizationPendingRef.current = null;
          setServerOptimizationPending(false);
        }
      }
    },
    [
      currentWebviewHandoffState,
      activeKnownSourceAudio,
      playbackOwner,
      rememberManualServerAudioPreference,
      serverOptimized,
    ],
  );

  const cancelNativeHlsSeekOptimization = useCallback(() => {
    const pending = optimizationPendingRef.current;
    if (pending?.purpose !== "native-hls-seek") return;
    optimizationRequestSequenceRef.current += 1;
    pending.controller.abort();
    optimizationPendingRef.current = null;
    setServerOptimizationPending(false);
  }, []);

  const switchToDeviceOriginal = useCallback((
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => {
    const position = Number.isFinite(absolutePositionSeconds)
      ? Math.max(0, absolutePositionSeconds)
      : 0;
    setFallbackSource(null);
    setOptimizedSource(null);
    setSourceSwitchPosition({
      originOwner: playbackOwner,
      position,
    });
    setSourceSwitchState(handoffState ?? null);
    setServerOptimizationError(null);
    recordDiagnostic("player", "server_optimized.disabled");
  }, [playbackOwner]);

  // The deferred default is a startup policy, not a command. Only a current
  // owner's explicit quality, audio or mode control consumes it. Automatic
  // seek, remembered audio and recovery continue through the raw callbacks.
  const claimExplicitServerOptimizationChoice = useCallback((freshAttempt = false) => {
    if (
      !playerMountedRef.current ||
      playbackOwnerRef.current !== playbackOwner
    ) {
      return false;
    }
    if (freshAttempt) {
      if (optimizationPendingRef.current?.owner === playbackOwner) return false;
      explicitOptimizationIntentRef.current += 1;
    }
    autoOptimizationAttemptedRef.current = playbackOwner;
    return true;
  }, [playbackOwner]);

  const selectServerOptimized = useCallback((
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
    audioTrack?: number,
    audioPreference?: AudioPreference,
    positionIntent: ServerOptimizedPositionIntent = "follow-current",
    retainAudioPreference = false,
  ): Promise<void> => {
    if (!claimExplicitServerOptimizationChoice(true)) return Promise.resolve();
    return switchToServerOptimized(
      quality,
      absolutePositionSeconds,
      handoffState,
      audioTrack,
      audioPreference,
      positionIntent,
      retainAudioPreference,
    ).then((activated) => {
      if (activated && !retainAudioPreference && serverAudioRetentionScope != null &&
        playbackOwnerRef.current === playbackOwner) {
        setManualServerOptimizedQuality({ scope: serverAudioRetentionScope, originOwner: playbackOwner, quality });
      }
    });
  }, [claimExplicitServerOptimizationChoice, playbackOwner, serverAudioRetentionScope, switchToServerOptimized]);

  const selectDeviceOriginal = useCallback((
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => {
    if (!claimExplicitServerOptimizationChoice()) return;
    automaticAudioIntentFenceRef.current = {
      owner: playbackOwner,
      intentEpoch: ++explicitOptimizationIntentRef.current,
    };
    // Original is also cancellation, so it must remain admissible while a
    // generation is pending. Late completion cannot replace this newer choice.
    const pending = optimizationPendingRef.current;
    if (pending?.owner === playbackOwner) {
      optimizationRequestSequenceRef.current += 1;
      pending.controller.abort();
      optimizationPendingRef.current = null;
      setServerOptimizationPending(false);
    }
    if (retainedPhysicalReaderRef.current?.owner === playbackOwner) retainedPhysicalReaderRef.current = null;
    switchToDeviceOriginal(absolutePositionSeconds, handoffState);
  }, [claimExplicitServerOptimizationChoice, playbackOwner, switchToDeviceOriginal]);

  const updatePendingHandoffPaused = useCallback((paused: boolean) => {
    if (
      playbackOwnerRef.current !== playbackOwner ||
      sourceSwitchPosition?.originOwner !== playbackOwner
    ) return;
    setSourceSwitchState((current) => {
      if (current == null || current.paused === paused) return current;
      return { ...current, paused };
    });
  }, [playbackOwner, sourceSwitchPosition?.originOwner]);

  useEffect(() => {
    const identity = playbackOwner;
    const quality = serverOptimized?.defaultQuality ?? null;
    if (
      quality == null ||
      (originalSourceIsServerOptimized &&
        (verifiedPlaybackProgressOwner !== playbackOwner ||
          initialServerOptimizedQuality === quality)) ||
      activeOptimized != null ||
      serverOptimizationPending ||
      autoOptimizationAttemptedRef.current === identity
    ) {
      return;
    }
    autoOptimizationAttemptedRef.current = identity;
    void switchToServerOptimized(quality, latestAbsolutePositionRef.current,
      undefined, undefined, undefined, "follow-current", false, "automatic-default");
  }, [
    activeOptimized,
    originalSourceIsServerOptimized,
    initialServerOptimizedQuality,
    playbackOwner,
    serverOptimizationPending,
    serverOptimized?.defaultQuality,
    switchToServerOptimized,
    verifiedPlaybackProgressOwner,
  ]);

  const handleWebviewPlaybackError = useCallback(
    async (message: string, exactHandoffPending: boolean, recovery?: WebviewRecoveryContext) => {
      const owner = playbackOwner;
      if (!playerMountedRef.current || playbackOwnerRef.current !== owner ||
        currentWebviewSourceRef.current !== webviewSource) return;
      recordDiagnostic("player", "webview.playback_failed", "error", message);
      if (activeOptimized != null) {
        // Fence the failed intent before restoring/remounting its original
        // source. A remembered preference is not permission to retry failure.
        automaticAudioIntentFenceRef.current = { owner, intentEpoch: activeOptimized.intentEpoch };
        autoOptimizationAttemptedRef.current = owner;
        const latestElementState = currentWebviewHandoffState(activeSourceSwitchState);
        const restoredState = latestElementState == null
          ? activeSourceSwitchState ?? undefined
          : {
              ...latestElementState,
              // Exact synchronization pauses the optimized element internally.
              // Preserve pre-handoff play/pause intent only while that internal
              // pause is still active. After synchronization, the element's
              // latest pause state is user-owned like volume, mute, and speed.
              // Cast suspension is another internal pause, so keep the owned
              // intent until local playback is allowed to apply it.
              paused: exactHandoffPending || castSuspended
                ? activeSourceSwitchState?.paused ?? latestElementState.paused
                : latestElementState.paused,
            };
        switchToDeviceOriginal(latestAbsolutePositionRef.current, restoredState);
        const restoredCopy = originalSourceIsServerOptimized
          ? "The previous stream was restored."
          : "Device Original was restored.";
        setServerOptimizationError(
          exactHandoffPending
            ? `Server Optimized could not synchronize. ${restoredCopy}`
            : `Server Optimized failed after synchronization. ${restoredCopy}`,
        );
        recordDiagnostic(
          "player",
          exactHandoffPending
            ? "server_optimized.handoff_failed"
            : "server_optimized.post_handoff_failed",
          "warning",
        );
        return;
      }
      const blockedRecovery = automaticAudioIntentFenceRef.current;
      if (effectiveEngine === "webview-direct" && blockedRecovery?.owner === owner &&
        blockedRecovery.intentEpoch === explicitOptimizationIntentRef.current) {
        setExternalError(message);
        return;
      }
      const pendingForCurrentOwner = recoveryPendingRef.current?.owner === owner;
      if (pendingForCurrentOwner) return;
      if (
        effectiveEngine === "webview-direct" &&
        activeFallback == null &&
        (serverOptimized != null || requestWebviewFallback != null)
      ) {
        const readRecovery = (): WebviewRecoverySnapshot => typeof recovery === "function" ? recovery() : recovery ?? {
            position: latestAbsolutePositionRef.current,
            state: currentWebviewHandoffState(activeSourceSwitchState) ?? {
              paused: webviewPaused, volume: 1, muted: false, playbackRate: 1,
            },
          };
        const preparing = optimizationPendingRef.current;
        if (preparing?.owner === owner) {
          if (preparing.purpose !== "automatic-default" && preparing.purpose !== "remembered-audio") {
            // An actual failure does not cancel a user's chosen quality/audio.
            // Preserve that operation while replacing its decoder-lost state.
            preparing.failureState = () => readRecovery().state;
            return;
          }
          optimizationRequestSequenceRef.current += 1;
          preparing.controller.abort();
          optimizationPendingRef.current = null;
          setServerOptimizationPending(false);
        }
        const request = ++recoveryRequestSequenceRef.current;
        const intentEpoch = explicitOptimizationIntentRef.current;
        recoveryPendingRef.current = { owner, request };
        setWebRecoveryPending(true);
        setExternalActionStatus("Preparing a browser-compatible stream…");
        let recovered: boolean | null = false;
        if (serverOptimized != null) {
          const snapshot = readRecovery();
          const preference = snapshot.state.audioPreference ?? retainedServerAudioPreference;
          const selected = retainedServerAudioMatch(preference, (activeKnownSourceAudio?.tracks ?? []).map((track) => ({
            index: track.index, id: String(track.index),
            label: track.label ?? `Audio ${track.index + 1}`,
            logicalLabel: track.label, language: track.language,
          })));
          const quality = serverOptimized.defaultQuality != null && serverOptimized.qualities.includes(serverOptimized.defaultQuality)
            ? serverOptimized.defaultQuality
            : serverOptimized.qualities.includes("480p") ? "480p" : serverOptimized.qualities[0];
          if (preference != null && selected == null) {
            message = "Optimized playback could not preserve the selected audio track. Open an external player or choose another source.";
          } else if (quality != null) {
            // Start a short offset generation at the owned failure point. A
            // full-from-zero fallback cannot recover an hour-long seek quickly.
            try {
              recovered = await switchToServerOptimized(
                quality, snapshot.position, () => readRecovery().state,
                selected?.index, preference ?? undefined, "fixed", false, "recovery",
              );
            } catch (error) {
              message = error instanceof Error ? error.message : "Optimized playback could not be prepared.";
            }
          }
        } else {
          recovered = await resolveWebviewFallbackForRequest(owner, request, requestWebviewFallback, readRecovery);
        }
        if (
          !playerMountedRef.current ||
          playbackOwnerRef.current !== owner ||
          recoveryPendingRef.current?.owner !== owner ||
          recoveryPendingRef.current.request !== request
        ) {
          return;
        }
        recoveryPendingRef.current = null;
        setWebRecoveryPending(false);
        setExternalActionStatus(null);
        if (explicitOptimizationIntentRef.current !== intentEpoch) return;
        if (recovered) {
          failedWebviewRecoveryRef.current = null;
          setExternalError(null);
          return;
        }
        // Error UI unmounts the failed element. Keep its owned recovery point
        // instead of making Retry remount Device Original at its initial zero.
        failedWebviewRecoveryRef.current = { owner, source: webviewSource, snapshot: readRecovery(), message };
      }
      setExternalError(message);
    }, [
      activeFallback,
      activeOptimized,
      activeSourceSwitchState,
      activeKnownSourceAudio,
      castSuspended,
      currentWebviewHandoffState,
      effectiveEngine,
      originalSourceIsServerOptimized,
      playbackOwner,
      resolveWebviewFallbackForRequest,
      requestWebviewFallback,
      retainedServerAudioPreference,
      serverOptimized,
      setExternalActionStatus,
      switchToDeviceOriginal,
      switchToServerOptimized,
      webviewSource,
      webviewPaused,
    ],
  );

  const retryFailedWebviewRecovery = useCallback(async (): Promise<void> => {
    const failed = failedWebviewRecoveryRef.current;
    if (failed == null || failed.owner !== playbackOwner || failed.source !== webviewSource ||
      !playerMountedRef.current || playbackOwnerRef.current !== failed.owner ||
      manualRecoveryPending || recoveryPendingRef.current?.owner === failed.owner) return;
    setManualRecoveryPending(true);
    explicitOptimizationIntentRef.current += 1;
    recordDiagnostic("player", "webview.retry_requested");
    try {
      // Leave the error surface mounted while capacity is unavailable. Only a
      // prepared, synchronized compatible source may replace it.
      await handleWebviewPlaybackError(failed.message, false, failed.snapshot);
    } finally {
      if (playerMountedRef.current && playbackOwnerRef.current === failed.owner) setManualRecoveryPending(false);
    }
  }, [handleWebviewPlaybackError, manualRecoveryPending, playbackOwner, webviewSource]);

  const externalTargetRef = useRef(externalTarget);
  externalTargetRef.current = externalTarget;
  const externalActionOwnerRef = useRef(playbackOwner);
  externalActionOwnerRef.current = playbackOwner;
  const externalActionRequestRef = useRef(0);
  const serverExternalRequestRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    serverExternalRequestRef.current?.abort();
    serverExternalRequestRef.current = null;
    externalActionRequestRef.current += 1;
    setExternalActionStatus(null);
    return () => {
      serverExternalRequestRef.current?.abort();
      serverExternalRequestRef.current = null;
      externalActionRequestRef.current += 1;
    };
  }, [externalTarget, playbackOwner, setExternalActionStatus]);
  const openExternalPlayback = useCallback(async () => {
    if (externalTarget == null) return;
    const request = ++externalActionRequestRef.current;
    const target = externalTarget;
    const owner = playbackOwner;
    serverExternalRequestRef.current?.abort();
    serverExternalRequestRef.current = null;
    const ownsRequest = () =>
      playerMountedRef.current &&
      playbackOwnerRef.current === owner &&
      externalActionOwnerRef.current === owner &&
      externalTargetRef.current === target &&
      externalActionRequestRef.current === request;
    setExternalActionStatus(null);
    try {
      if (desktopTauri) {
        const status = await openInExternalPlayer(
          target,
          preferredPlayer,
          // A distinct cookie-free capability must not enter the native
          // authenticated-URL proxy, which only accepts /api/stream/:id.
          target === effectiveUrl ? playbackAuthorization : undefined,
        );
        if (!ownsRequest()) return;
        setExternalActionStatus(status);
        recordDiagnostic("player", "external.started");
      } else if (androidTauri) {
        if (!ownsRequest()) return;
        setExternalActionStatus("Opening Android player chooser…");
        // Stop local audio at the owned handoff boundary. Copying the link is
        // intentionally separate and must not interrupt in-window playback.
        pauseWebviewForExternalHandoff();
        const status = await openAndroidExternalPlayer(target, ownsRequest);
        if (status == null || !ownsRequest()) return;
        setExternalActionStatus(status);
        recordDiagnostic("player", "external.chooser_opened");
        return;
      } else if (androidServerPlayer) {
        if (!ownsRequest()) return;
        const controller = new AbortController();
        serverExternalRequestRef.current = controller;
        setExternalActionStatus("Waiting for Android confirmation…");
        const status = await openAndroidServerExternalPlayer(
          target,
          ownsRequest,
          controller.signal,
          () => {
            if (ownsRequest()) pauseWebviewForExternalHandoff();
          },
        );
        if (serverExternalRequestRef.current === controller) {
          serverExternalRequestRef.current = null;
        }
        if (status == null || !ownsRequest()) return;
        setExternalActionStatus(
          status === "External player opened."
            ? "Player chooser opened. If playback did not start, finish the selected player's setup and try again."
            : status,
        );
        recordDiagnostic(
          "player",
          status === "External player opened."
            ? "external.chooser_opened"
            : "external.chooser_cancelled",
        );
        return;
      } else if (mobileTauri) {
        if (navigator.clipboard == null) {
          if (!ownsRequest()) return;
          setExternalActionStatus(
            "Native player selection is not enabled in this build. Use the stream link below with VLC or another player.",
          );
          return;
        }
        await navigator.clipboard.writeText(target);
        if (!ownsRequest()) return;
        setExternalActionStatus(
          "Stream link copied. Paste it into VLC or another player. Native player selection is not enabled in this build.",
        );
        recordDiagnostic("player", "external.link_copied");
      } else {
        if (browserExternalTarget == null) return;
        downloadExternalPlaylist(browserExternalTarget, title);
        if (!ownsRequest()) return;
        setExternalActionStatus("Player playlist downloaded. Open it with an installed video player.");
        recordDiagnostic("player", "external.playlist_downloaded");
      }
    } catch {
      if (!ownsRequest()) return;
      setExternalActionStatus(
        androidNativeChooser
          ? "The Android player chooser could not be opened. Copy the stream link or use the selectable link below."
          : mobileTauri
            ? "The stream link could not be copied. Use the selectable link below."
            : "The external player could not be opened. Try again.",
      );
      recordDiagnostic("player", "external.start_failed", "error");
    }
  }, [
    externalTarget,
    effectiveUrl,
    playbackOwner,
    playbackAuthorization,
    preferredPlayer,
    title,
    desktopTauri,
    androidTauri,
    androidServerPlayer,
    androidNativeChooser,
    mobileTauri,
    browserExternalTarget,
    pauseWebviewForExternalHandoff,
    setExternalActionStatus,
  ]);

  const copyExternalPlaybackLink = useCallback(async () => {
    const copyTarget = !underTauri && !androidAppUi
      ? browserExternalTarget
      : externalTarget;
    if (copyTarget == null) return;
    serverExternalRequestRef.current?.abort();
    serverExternalRequestRef.current = null;
    const request = ++externalActionRequestRef.current;
    const target = copyTarget;
    const owner = playbackOwner;
    const ownsRequest = () =>
      playerMountedRef.current &&
      playbackOwnerRef.current === owner &&
      externalActionOwnerRef.current === owner &&
      externalTargetRef.current === target &&
      externalActionRequestRef.current === request;
    setExternalActionStatus(null);
    try {
      if (navigator.clipboard == null) {
        if (!ownsRequest()) return;
        setExternalActionStatus(
          "Clipboard access is unavailable. Use the selectable stream link below.",
        );
        return;
      }
      if (!ownsRequest()) return;
      setExternalActionStatus("Copying stream link…");
      await navigator.clipboard.writeText(target);
      if (!ownsRequest()) return;
      setExternalActionStatus("Stream link copied. Paste it into VLC or another player.");
      recordDiagnostic("player", "external.link_copied");
    } catch {
      if (!ownsRequest()) return;
      setExternalActionStatus(
        "The stream link could not be copied. Use the selectable link below.",
      );
      recordDiagnostic("player", "external.copy_failed", "error");
    }
  }, [
    androidAppUi,
    browserExternalTarget,
    externalTarget,
    playbackOwner,
    setExternalActionStatus,
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
    if (mode !== "external" || !desktopTauri || useEmbedded) return;
    let cancelled = false;
    startedMpvRef.current = false;
    setExternalStatus(null);
    setExternalError(null);

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
        if (externalTarget == null) {
          setExternalError("External playback is not available for this protected stream.");
          return;
        }
        openInExternalPlayer(
          externalTarget,
          preferredPlayer,
          externalTarget === effectiveUrl ? playbackAuthorization : undefined,
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
    desktopTauri,
    effectiveUrl,
    externalTarget,
    preferredPlayer,
    playbackAuthorization,
    useEmbedded,
    sourceRevision,
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
    if (
      effectiveEngine !== "webview-hls-transcode" &&
      externalPlaybackUrl === null
    ) {
      setAndroidTVError(
        "External playback is unavailable until this server provides a stream capability. Retry playback or choose another source.",
      );
      return;
    }
    // An HLS fallback is the playable rendition. The external capability is
    // only for direct sources, where it avoids handing the TV an app cookie.
    const playbackURL = effectiveEngine === "webview-hls-transcode"
      ? effectiveUrl
      : externalPlaybackUrl?.trim() || effectiveUrl;
    const started = startAndroidTVPlayback({
      url: playbackURL,
      contentType: androidTVContentType(
        effectiveEngine,
        effectiveUrl,
        sourceFileName,
      ),
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
    effectiveEngine,
    externalPlaybackUrl,
    playbackAuthorization,
    playerPreferences?.defaultAudioLanguage,
    playerPreferences?.defaultSubtitleBehavior,
    playerPreferences?.defaultSubtitleLanguage,
    startPositionSeconds,
    sourceRevision,
    sourceFileName,
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
        key={`${effectiveUrl}:${sourceRevision}`}
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
        onPlaybackStall={refreshCurrentSource == null ? undefined : recoverPostStartStall}
        onRecoveryPlaybackHealthy={reportNativeRecoveryPlaybackHealthy}
        onRetryFreshStream={refreshCurrentSource == null ? undefined : retryFreshStream}
        startPositionSeconds={effectiveStartPositionSeconds}
        sourceSwitchState={activeSourceSwitchState}
        timelineOffsetSeconds={effectiveTimelineOffsetSeconds}
        knownAbsoluteDurationSeconds={activeKnownAbsoluteDuration}
        serverOptimized={serverOptimized}
        activeServerOptimizedQuality={activeOptimized?.quality ?? null}
        serverOptimizationPending={serverOptimizationPending}
        serverOptimizationError={serverOptimizationError}
        onSwitchServerOptimized={selectServerOptimized}
        onSwitchDeviceOriginal={selectDeviceOriginal}
        onAbsolutePositionChange={reportAbsolutePosition}
        onOpenExternalPlayer={externalPlaybackAvailable ? openExternalPlayback : undefined}
        externalActionStatus={externalPlaybackAvailable ? externalActionStatus : null}
        playbackDecision={playbackDecisionFor(effectiveEngine, effectiveUrl)}
        onProgress={reportProgress}
        onEnded={reportEnded}
        autoCountdown={autoCountdown}
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
        className={`player${sharedTouchPlayer ? " is-touch-player" : ""}${touchMenuOpen ? " has-touch-menu" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Playing ${title}`}
        tabIndex={-1}
        onClick={(e) => { clearChromePointerFocus(); e.stopPropagation(); }}
        onClickCapture={mode === "webview" ? noteChromeClick : undefined}
        onPointerDownCapture={mode === "webview" ? noteChromePointer : undefined}
        onKeyDownCapture={mode === "webview" ? noteChromeKeyboard : undefined}
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
          ref={(element) => element?.toggleAttribute("inert", touchMenuOpen)}
          className={`player-bar${webChromeShown ? " is-visible" : ""}`}
          aria-hidden={hiddenWebChrome || touchMenuOpen || undefined}
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
              onClick={(event) => {
                const trigger = event.currentTarget;
                focusChromeControl(trigger);
                detailsTriggerRef.current = trigger.isConnected
                  ? { element: trigger, owner: playbackOwner }
                  : null;
                setDetailsSection((section) => section === "info" ? null : "info");
              }}
              aria-label="Player details and shortcuts"
              aria-haspopup="dialog"
              aria-expanded={detailsSection != null}
              title="Player details and shortcuts (?)"
              tabIndex={hiddenWebChrome ? -1 : undefined}
            >
              <Icon name="info" size={17} />
              <span className="player-bar-action-label">Details</span>
            </button>
            <button
              type="button"
              className="player-close"
              onClick={onClose}
              aria-label="Close player"
              tabIndex={hiddenWebChrome ? -1 : undefined}
            >
              <Icon name="xmark" size={18} />
              <span className="player-bar-action-label">Close</span>
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

        {webviewChildShown ? (
          <WebviewPlayer
            key={physicalReaderKey}
            sourceIdentity={webviewSource}
            ownedPlaybackStateRef={ownedWebviewStateRef}
            presentation={videoPresentation}
            onPresentationChange={changeVideoPresentation}
            url={effectiveUrl}
            engine={effectiveEngine}
            title={title}
            subtitle={subtitle}
            nowPlaying={nowPlaying}
            detailsOpen={detailsSection != null}
            touchPlayer={sharedTouchPlayer}
            chromeVisible={webChromeShown}
            onChromeEnter={holdChrome}
            onChromeLeave={releaseChrome}
            onChromeFocus={focusChrome}
            onChromeControlFocus={focusChromeControl}
            onChromeBlur={blurChrome}
            onActivity={nudgeChrome}
            onPausedChange={setWebviewPaused}
            onPlaybackPendingChange={reportWebviewPending}
            onPendingHandoffPausedChange={updatePendingHandoffPaused}
            onVerifiedPlaybackProgress={reportVerifiedPlaybackProgress}
            onRecoveryPlaybackHealthy={reportRecoveryPlaybackHealthy}
            onCaptionsOpenChange={setCaptionsOpen}
            onMenuOpenChange={setWebMenuOpen}
            onScrubbingChange={setWebScrubbing}
            onCastLocalPlaybackChange={setCastSuspended}
            suspended={castSuspended}
            onActiveSubtitleUrlChange={setActiveSubtitleUrl}
            onOpenShortcuts={() => {
              detailsTriggerRef.current = null;
              setDetailsSection("shortcuts");
            }}
            onSourceSize={setSourceSize}
            onTechnicalStats={updateWebTechnicalStats}
            onProgress={reportProgress}
            onEnded={reportEnded}
            savedPrefs={savedPrefs}
            playerPreferences={playerPreferences}
            startPositionSeconds={effectiveStartPositionSeconds}
            timelineOffsetSeconds={effectiveTimelineOffsetSeconds}
            knownAbsoluteDurationSeconds={activeKnownAbsoluteDuration}
            onSourceDurationKnown={activeOptimized == null &&
              activeFallback == null &&
              !initialServerOptimizedTimeline
              ? rememberAbsoluteDuration
              : undefined}
            onServerSourceInfoKnown={rememberCurrentServerSourceInfo}
            sourceSwitchState={activeSourceSwitchState}
            exactHandoff={activeOptimized != null || activeFallback?.recovery != null}
            optimizedTimelineIsPartial={activeOptimized?.partialTimeline ?? initialServerOptimizedTimeline}
            externalHandoffVideoRef={externalHandoffVideoRef}
            externalHandoffPauseRef={externalHandoffPauseRef}
            serverOptimized={serverOptimized}
            preparedLeaseTarget={activeOptimized?.leaseTarget}
            onServerLeaseExpired={expireServerGeneration}
            serverAudioOwner={playbackOwner}
            initialServerAudioTracks={activeKnownSourceAudio?.tracks}
            activeServerOptimizedQuality={activeOptimized?.quality ?? initialServerOptimizedQuality}
            activeServerAudioTrack={activeOptimized?.audioTrack ?? initialServerAudioTrack}
            initialServerAudioTrackExplicit={
              activeOptimized == null && explicitInitialServerAudioTrack != null
            }
            activeServerAudioPreference={activeOptimized?.audioPreference ?? null}
            retainedServerAudioPreference={retainedServerAudioPreference}
            retainedServerOptimizedQuality={manualServerOptimizedQuality?.originOwner === playbackOwner
              ? null : retainedServerOptimizedQuality}
            onRetainedServerAudioPreferenceUnavailable={
              invalidateManualServerAudioPreference
            }
            serverOptimizationPending={serverOptimizationPending}
            serverOptimizationError={serverOptimizationError}
            onSwitchServerOptimized={switchToServerOptimized}
            onCancelNativeHlsSeekOptimization={cancelNativeHlsSeekOptimization}
            onSelectServerOptimized={selectServerOptimized}
            onSelectDeviceOriginal={selectDeviceOriginal}
            onAbsolutePositionChange={reportAbsolutePosition}
            onPlaybackError={(message, exactHandoffPending, recovery) =>
              void handleWebviewPlaybackError(message, exactHandoffPending, recovery)
            }
            onPlaybackStall={recoverPostStartStall}
            canRefreshSource={refreshCurrentSource != null}
            onOpenExternalPlayer={() => void openExternalPlayback()}
            onCopyExternalLink={mobileTauri || browserExternalTarget != null
              ? () => void copyExternalPlaybackLink()
              : undefined}
            nativeExternalChooser={androidNativeChooser}
            externalPlaybackAvailable={externalPlaybackAvailable}
            externalActionStatus={externalActionStatus}
            manualExternalUrl={mobileTauri ? externalTarget : null}
            browserExternalLinks={browserExternalLinks}
            browserExternalGuidance={browserExternalHelp}
            subtitleClient={subtitleClient ?? null}
            translator={translator ?? null}
            imdbId={imdbId ?? null}
            season={season ?? null}
            episode={episode ?? null}
            scrobbleContext={scrobbleContext}
            upNext={upNext}
            onPlayNext={upNext != null ? onPlayNext : undefined}
            onRemoteClose={onClose}
            autoCountdown={autoCountdown}
          />
        ) : (
          <ExternalPanel
            underTauri={desktopTauri}
            externalPlaybackAvailable={externalPlaybackAvailable}
            status={externalStatus}
            error={externalError}
            externalStatus={externalActionStatus}
            onOpenExternal={() => void openExternalPlayback()}
            onCopyExternal={mobileTauri || browserExternalTarget != null
              ? () => void copyExternalPlaybackLink()
              : undefined}
            nativeExternalChooser={androidNativeChooser}
            manualExternalUrl={mobileTauri ? externalTarget : null}
            browserExternalLinks={browserExternalLinks}
            browserExternalGuidance={browserExternalHelp}
            onTryNextSource={onTryNextSource}
            onRetry={
              mode === "webview" && externalError != null
                ? serverLeaseExpired && refreshCurrentSource == null
                  ? undefined
                  : !serverLeaseExpired && failedWebviewRecoveryRef.current?.owner === playbackOwner &&
                    failedWebviewRecoveryRef.current.source === webviewSource
                  ? retryFailedWebviewRecovery
                  : lastStallContextRef.current != null && refreshCurrentSource != null
                  ? retryFreshStream
                  : () => {
                      recordDiagnostic("player", "webview.retry_requested");
                      setExternalError(null);
                      explicitOptimizationIntentRef.current += 1;
                      if (retainedPhysicalReaderRef.current?.owner === playbackOwner) retainedPhysicalReaderRef.current = null;
                      setPlaybackAttempt((attempt) => attempt + 1);
                    }
                : undefined
            }
            freshResolutionRequired={serverLeaseExpired}
            retryPending={manualRecoveryPending || (serverLeaseExpired && webRecoveryPending)}
          />
        )}
        {webRecoveryPending && (
          <div className="player-compatibility-status" role="status">
            <Icon name="refresh" size={22} />
            <span>Preparing a fresh stream…</span>
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
  sourceIdentity,
  ownedPlaybackStateRef,
  presentation,
  onPresentationChange,
  url,
  engine,
  title,
  subtitle,
  nowPlaying,
  detailsOpen,
  touchPlayer,
  chromeVisible,
  onChromeEnter,
  onChromeLeave,
  onChromeFocus,
  onChromeControlFocus,
  onChromeBlur,
  onActivity,
  onPausedChange,
  onPlaybackPendingChange,
  onPendingHandoffPausedChange,
  onVerifiedPlaybackProgress,
  onRecoveryPlaybackHealthy,
  onCaptionsOpenChange,
  onMenuOpenChange,
  onScrubbingChange,
  onCastLocalPlaybackChange,
  suspended,
  onActiveSubtitleUrlChange,
  onOpenShortcuts,
  onSourceSize,
  onTechnicalStats,
  onProgress,
  onEnded,
  savedPrefs,
  playerPreferences,
  startPositionSeconds,
  timelineOffsetSeconds,
  knownAbsoluteDurationSeconds,
  onSourceDurationKnown,
  onServerSourceInfoKnown,
  sourceSwitchState,
  exactHandoff,
  optimizedTimelineIsPartial,
  externalHandoffVideoRef,
  externalHandoffPauseRef,
  onPlaybackError,
  onPlaybackStall,
  canRefreshSource,
  onOpenExternalPlayer,
  onCopyExternalLink,
  nativeExternalChooser,
  externalPlaybackAvailable,
  externalActionStatus,
  manualExternalUrl,
  browserExternalLinks,
  browserExternalGuidance,
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
  serverOptimized,
  serverAudioOwner,
  preparedLeaseTarget,
  onServerLeaseExpired,
  initialServerAudioTracks,
  activeServerOptimizedQuality,
  activeServerAudioTrack,
  initialServerAudioTrackExplicit,
  activeServerAudioPreference,
  retainedServerAudioPreference,
  retainedServerOptimizedQuality,
  onRetainedServerAudioPreferenceUnavailable,
  serverOptimizationPending,
  serverOptimizationError,
  onSwitchServerOptimized,
  onCancelNativeHlsSeekOptimization,
  onSelectServerOptimized,
  onSelectDeviceOriginal,
  onAbsolutePositionChange,
}: {
  sourceIdentity: { key: string };
  ownedPlaybackStateRef: { current: { video: HTMLVideoElement; source: { key: string }; read: () => PlaybackHandoffState | null } | null };
  presentation: VideoPresentation;
  onPresentationChange: (patch: Partial<VideoPresentation>) => void;
  url: string;
  engine: PlaybackEngine;
  title: string;
  subtitle?: string | null;
  nowPlaying?: NowPlayingMetadata | null;
  detailsOpen: boolean;
  touchPlayer: boolean;
  chromeVisible: boolean;
  onChromeEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onChromeLeave: (event: React.PointerEvent<HTMLElement>) => void;
  onChromeFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onChromeControlFocus: (target: HTMLElement | null) => void;
  onChromeBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onActivity: () => void;
  onPausedChange: (paused: boolean) => void;
  onPlaybackPendingChange: (pending: boolean) => void;
  onPendingHandoffPausedChange: (paused: boolean) => void;
  onVerifiedPlaybackProgress: () => void;
  onRecoveryPlaybackHealthy: (video: HTMLVideoElement) => boolean;
  onCaptionsOpenChange: (open: boolean) => void;
  onMenuOpenChange: (open: boolean) => void;
  onScrubbingChange: (scrubbing: boolean) => void;
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
  onEnded?: (
    currentSeconds: number,
    durationSeconds: number | null,
    prefs?: PlaybackPrefs,
  ) => void;
  savedPrefs?: PlaybackPrefs | null;
  playerPreferences?: PlayerPreferenceDefaults | null;
  startPositionSeconds?: number;
  timelineOffsetSeconds: number;
  knownAbsoluteDurationSeconds: number | null;
  onSourceDurationKnown?: (durationSeconds: number) => void;
  onServerSourceInfoKnown: (sourceInfo: ServerStreamSourceInfo) => void;
  sourceSwitchState: PlaybackHandoffState | null;
  exactHandoff: boolean;
  optimizedTimelineIsPartial: boolean;
  externalHandoffVideoRef: { current: HTMLVideoElement | null };
  externalHandoffPauseRef: { current: ((video: HTMLVideoElement) => boolean) | null };
  onPlaybackError: (message: string, exactHandoffPending: boolean, recovery?: WebviewRecoveryContext) => void;
  onPlaybackStall: (
    absolutePositionSeconds: number,
    handoffState: PlaybackHandoffState,
  ) => Promise<boolean>;
  canRefreshSource: boolean;
  onOpenExternalPlayer: () => void;
  onCopyExternalLink?: () => void;
  nativeExternalChooser: boolean;
  externalPlaybackAvailable: boolean;
  externalActionStatus: string | null;
  manualExternalUrl: string | null;
  browserExternalLinks: BrowserExternalPlayerLink[];
  browserExternalGuidance: string | null;
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
  serverOptimized?: VideoPlayerProps["serverOptimized"];
  serverAudioOwner: string;
  preparedLeaseTarget?: string | null;
  onServerLeaseExpired: (source: string, position: number, handoff: PlaybackHandoffState) => void;
  initialServerAudioTracks?: readonly ServerAudioTrack[];
  activeServerOptimizedQuality: ServerTranscodeQuality | null;
  activeServerAudioTrack: number | null;
  initialServerAudioTrackExplicit: boolean;
  activeServerAudioPreference: AudioPreference | null;
  retainedServerAudioPreference: AudioPreference | null;
  retainedServerOptimizedQuality: ServerTranscodeQuality | null;
  onRetainedServerAudioPreferenceUnavailable: (
    owner: string,
    preference: AudioPreference,
  ) => void;
  serverOptimizationPending: boolean;
  serverOptimizationError: string | null;
  onSwitchServerOptimized: (
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
    audioTrack?: number,
    audioPreference?: AudioPreference,
    positionIntent?: ServerOptimizedPositionIntent,
    retainAudioPreference?: boolean,
    purpose?: ServerOptimizationPurpose,
  ) => Promise<boolean>;
  onCancelNativeHlsSeekOptimization: () => void;
  onSelectServerOptimized: (
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
    audioTrack?: number,
    audioPreference?: AudioPreference,
    positionIntent?: ServerOptimizedPositionIntent,
    retainAudioPreference?: boolean,
  ) => Promise<void>;
  onSelectDeviceOriginal: (
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => void;
  onAbsolutePositionChange: (absolutePositionSeconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const committedSourceRef = useRef(sourceIdentity);
  const sourceLoadRef = useRef<{ source: typeof sourceIdentity; reused: boolean; started: boolean; expected: string | null }>({ source: sourceIdentity, reused: false, started: true, expected: null });
  function ownsSource(video: HTMLVideoElement): boolean {
    return videoRef.current === video && committedSourceRef.current === sourceIdentity;
  }
  function mediaEventsCurrent(video: HTMLVideoElement): boolean {
    return ownsSource(video) && sourceLoadRef.current.source === sourceIdentity && sourceLoadRef.current.started;
  }
  function currentMediaEvent(video: HTMLVideoElement, minimumReadyState = 0): boolean {
    return mediaEventsCurrent(video) && (!sourceLoadRef.current.reused || video.readyState >= minimumReadyState);
  }
  const assignedSourceRef = useRef<{ source: typeof sourceIdentity; url: string } | null>(null);
  const terminalRecoverySourceRef = useRef<typeof sourceIdentity | null>(null);
  function terminalRecoveryOwns(video: HTMLVideoElement): boolean {
    return ownsSource(video) && terminalRecoveryVideoRef.current === video && terminalRecoverySourceRef.current === sourceIdentity;
  }
  const terminalRecoveryVideoRef = useRef<HTMLVideoElement | null>(null);
  const terminalRecoveryStateRef = useRef<PlaybackHandoffState | null>(null);
  const captionViewportRef = useRef<HTMLDivElement | null>(null);
  const captionControlsRef = useRef<HTMLDivElement | null>(null);
  const setVideoElement = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    externalHandoffVideoRef.current = element;
  }, [externalHandoffVideoRef]);
  const hlsRef = useRef<HlsInstance | null>(null);
  const lastAudibleVolumeRef = useRef(1);
  const playerPreferencesRef = useRef(playerPreferences);
  playerPreferencesRef.current = playerPreferences;
  const appliedHlsAudioPreferenceRef = useRef(false);
  const appliedBrowserAudioPreferenceRef = useRef(false);
  const reconcilingBrowserAudioSelectionRef = useRef(false);
  const audioPreferenceRef = useRef<AudioPreference>({ id: null, language: null });
  const serverAudioModeRef = useRef(serverOptimized?.loadAudioTracks != null);
  serverAudioModeRef.current = serverOptimized?.loadAudioTracks != null;
  const appliedServerAudioPreferenceRef = useRef(false);
  const appliedRetainedServerQualityOwnerRef = useRef<string | null>(null);
  const autoplayAttemptedRef = useRef(false);
  const playbackAttemptRef = useRef(0);
  const foregroundPlaybackRef = useRef<{ video: HTMLVideoElement; source: string; play: boolean; returnedPosition?: number } | null>(null);
  const preBackgroundPauseRef = useRef<{ video: HTMLVideoElement; source: string; attempt: number; pausedAt: number } | null>(null);
  const foregroundIdleRecoveryRef = useRef<{ video: HTMLVideoElement; source: string; attempt: number; token: object | null; timer: number } | null>(null);
  const playbackSourceRef = useRef(url);
  useLayoutEffect(() => { playbackSourceRef.current = url; }, [sourceIdentity, url]);
  const pausedForCastRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const documentSuspendedRef = useRef(document.visibilityState === "hidden");
  const backgroundBlocksPlayback = (video: HTMLVideoElement | null) =>
    (documentSuspendedRef.current || document.visibilityState === "hidden") &&
    !(video != null && (document.pictureInPictureElement === video ||
      (video as WebKitVideoElement).webkitPresentationMode === "picture-in-picture"));
  const stallWatchdogRef = useRef<PlaybackStallWatchdog | null>(null);
  const recoveryProgressWindowRef = useRef<PlaybackRecoveryProgress | null>(null);
  const rearmHlsRecoveryRef = useRef<((video: HTMLVideoElement) => void) | null>(null);
  const startupReadyRef = useRef(false);
  const stallStateRef = useRef<PlaybackStallState>({
    started: false,
    paused: true,
    seeking: false,
    suspended,
    ended: false,
    tearingDown: false,
  });
  const scrubberRef = useRef<WebviewScrubberHandle | null>(null);
  const absoluteSeekRef = useRef<(targetSeconds: number) => void>(() => {});
  const lastClockSecondRef = useRef(-1);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const upNextDismissedRef = useRef(false);
  const upNextWarningShownRef = useRef(false);
  const autoCountdownRef = useRef(autoCountdown);
  autoCountdownRef.current = autoCountdown;
  const autoAdvanceFiredRef = useRef(false);
  const onPlayNextForEndRef = useRef(onPlayNext);
  onPlayNextForEndRef.current = onPlayNext;
  const previousPositionRef = useRef(0);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const menuOpen = optionsOpen || captionsOpen;
  const touchMenuOpen = touchPlayer && menuOpen;
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuWasOpenRef = useRef(false);
  const optionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const audioShortcutRef = useRef<HTMLButtonElement | null>(null);
  const optionsOriginRef = useRef<"settings" | "audio" | null>(null);
  const optionsWasOpenRef = useRef(false);
  const optionsDialogRef = useModalA11y<HTMLDivElement>(
    () => setOptionsOpen(false),
    optionsOpen,
  );
  const nestedDialogOpen = optionsOpen || captionsOpen || detailsOpen;
  const audioOptionsRequestedRef = useRef(false);
  const audioHeadingRef = useRef<HTMLSpanElement | null>(null);
  const { fit: videoFit, zoom: videoZoom, panX: videoPanX, panY: videoPanY } = presentation;
  const [subtitlePosition, setSubtitlePosition] = useState(
    () => savedPrefs?.subtitlePosition ?? 90,
  );
  const subtitlePositionRef = useRef(subtitlePosition);
  subtitlePositionRef.current = subtitlePosition;
  const [paused, setPaused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const normalizedTimelineOffset = Number.isFinite(timelineOffsetSeconds)
    ? Math.max(0, timelineOffsetSeconds)
    : 0;
  const displayedDuration = knownAbsoluteDurationSeconds != null &&
    Number.isFinite(knownAbsoluteDurationSeconds) &&
    knownAbsoluteDurationSeconds > 0
    ? knownAbsoluteDurationSeconds
    : !optimizedTimelineIsPartial && duration > 0
      ? duration + normalizedTimelineOffset
      : null;
  const displayedPosition = Math.max(0, currentPosition + normalizedTimelineOffset);
  useEffect(() => {
    const video = videoRef.current;
    if (video == null || clockRef.current == null) return;
    clockRef.current.textContent = `${clockLabel(video.currentTime + normalizedTimelineOffset)} / ${durationClockLabel(displayedDuration)}`;
  }, [displayedDuration, normalizedTimelineOffset]);
  const requiresExactHandoff = exactHandoff || sourceSwitchState != null;
  const requiresExactHandoffRef = useRef(requiresExactHandoff);
  requiresExactHandoffRef.current = requiresExactHandoff;
  const exactHandoffPendingRef = useRef(requiresExactHandoff);
  const sourceSwitchStateRef = useRef(sourceSwitchState);
  sourceSwitchStateRef.current = sourceSwitchState;
  const pendingHandoffPlaybackIntentRef = useRef<"play" | "pause" | null>(null);
  const cancelForegroundIdleRecovery = useCallback((video: HTMLVideoElement) => {
    const pending = foregroundIdleRecoveryRef.current;
    if (pending?.video !== video) return;
    window.clearTimeout(pending.timer);
    foregroundIdleRecoveryRef.current = null;
  }, []);
  const clearReturnedPlayback = useCallback((video: HTMLVideoElement) => {
    cancelForegroundIdleRecovery(video);
    if (preBackgroundPauseRef.current?.video === video) preBackgroundPauseRef.current = null;
    const pending = foregroundPlaybackRef.current;
    if (pending?.video === video && pending.returnedPosition != null) {
      foregroundPlaybackRef.current = null;
      pendingHandoffPlaybackIntentRef.current = null;
    }
  }, [cancelForegroundIdleRecovery]);
  const nativeControlsOwnPlayback = (video: HTMLVideoElement) =>
    document.pictureInPictureElement === video || document.fullscreenElement === video ||
    (video as WebKitVideoElement).webkitPresentationMode === "picture-in-picture" ||
    (video as WebKitVideoElement).webkitPresentationMode === "fullscreen";
  const pendingNativeHlsSeekSequenceRef = useRef(0);
  const pendingNativeHlsSeekRef = useRef<PendingNativeHlsSeek | null>(null);
  const verifiedPlaybackProgressReportedRef = useRef(false);
  const verifiedPlaybackPlayingRef = useRef(false);
  const lastObservedMediaTimeRef = useRef(0);
  const ownedPlaybackPausedRef = useRef(sourceSwitchState?.paused ?? false);
  const explicitPlaybackIntentRef = useRef(false);
  const backgroundPauseVideoRef = useRef<HTMLVideoElement | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<"starting" | "buffering" | "seeking" | null>(
    requiresExactHandoff ? "seeking" : "starting",
  );
  // Loading presentation is independent of the requested Play/Pause intent.
  // Reuse the status cleared by current-data/confirmed-handoff paths, not a
  // successful play() request or an initial metadata event alone.
  useEffect(() => {
    onPlaybackPendingChange(playbackStatus != null);
  }, [onPlaybackPendingChange, playbackStatus]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(() => {
    if (
      sourceSwitchState != null &&
      Number.isFinite(sourceSwitchState.playbackRate) &&
      sourceSwitchState.playbackRate >= 0.5 &&
      sourceSwitchState.playbackRate <= 2
    ) {
      return sourceSwitchState.playbackRate;
    }
    const saved = playerPreferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs?.playbackSpeed;
    const preferred = saved ?? playerPreferences?.defaultPlaybackSpeed;
    return preferred != null && Number.isFinite(preferred) && preferred >= 0.5 && preferred <= 2
      ? preferred
      : 1;
  });
  const [scrubbing, setScrubbing] = useState(false);
  const updateScrubbing = useCallback((next: boolean) => {
    setScrubbing(next);
    onScrubbingChange(next);
  }, [onScrubbingChange]);
  useEffect(() => () => onScrubbingChange(false), [onScrubbingChange]);
  const rendererSeekingRef = useRef(false);
  const pendingRecoverySeekRef = useRef<PendingRecoverySeek | null>(null);
  const recoverySeekSequenceRef = useRef(0);
  const pendingRecoverySeekFor = (video: HTMLVideoElement) => {
    const pending = pendingRecoverySeekRef.current;
    return pending?.video === video && pending.sequence === recoverySeekSequenceRef.current ? pending : null;
  };
  const recoveryClockWasReset = (video: HTMLVideoElement): boolean => {
    if (!ownsSource(video)) return true;
    if (pendingRecoverySeekFor(video) != null || pendingNativeHlsSeekRef.current != null ||
        exactHandoffPendingRef.current || video.seeking || rendererSeekingRef.current) return false;
    const reset = lastObservedMediaTimeRef.current > 0 &&
      (video.currentTime === 0 || (backgroundPauseVideoRef.current === video &&
        video.currentTime < lastObservedMediaTimeRef.current - 0.25));
    // Once an unsolicited reset is observed, a few seconds of replay are not
    // a new clock. A real seek or return to the owned timeline releases it.
    if (reset) backgroundPauseVideoRef.current = video;
    return reset;
  };
  const scrubbingRef = useRef(false);
  useLayoutEffect(() => {
    if (committedSourceRef.current === sourceIdentity) return;
    committedSourceRef.current = sourceIdentity;
    sourceLoadRef.current = { source: sourceIdentity, reused: true, started: false, expected: null };
    const video = videoRef.current;
    if (video != null) cancelForegroundIdleRecovery(video);
    terminalRecoveryVideoRef.current = null;
    terminalRecoverySourceRef.current = null;
    terminalRecoveryStateRef.current = null;
    foregroundPlaybackRef.current = null;
    preBackgroundPauseRef.current = null;
    backgroundPauseVideoRef.current = null;
    autoplayAttemptedRef.current = false;
    playbackAttemptRef.current += 1;
    pendingHandoffPlaybackIntentRef.current = null;
    pendingNativeHlsSeekSequenceRef.current += 1;
    if (pendingNativeHlsSeekRef.current?.timer != null) window.clearTimeout(pendingNativeHlsSeekRef.current.timer);
    pendingNativeHlsSeekRef.current = null;
    recoverySeekSequenceRef.current += 1;
    pendingRecoverySeekRef.current = null;
    exactHandoffPendingRef.current = requiresExactHandoffRef.current;
    didSeekRef.current = false;
    explicitInitialSeekRef.current = null;
    nativeExactHlsFragmentRef.current = false;
    rendererSeekingRef.current = false;
    verifiedPlaybackProgressReportedRef.current = false;
    verifiedPlaybackPlayingRef.current = false;
    ownedPlaybackPausedRef.current = sourceSwitchStateRef.current?.paused ?? false;
    explicitPlaybackIntentRef.current = false;
    startupReadyRef.current = false;
    lastObservedMediaTimeRef.current = 0;
    appliedHlsAudioPreferenceRef.current = false;
    appliedBrowserAudioPreferenceRef.current = false;
    appliedServerAudioPreferenceRef.current = false;
    audioPreferenceRef.current = sourceSwitchStateRef.current?.audioPreference ?? { id: null, language: null };
    setDuration(0);
    setPaused(ownedPlaybackPausedRef.current);
    setPlaying(!ownedPlaybackPausedRef.current);
  }, [cancelForegroundIdleRecovery, sourceIdentity]);
  // Set when the video reaches its natural end - drives the Up-next card.
  const [ended, setEnded] = useState(false);
  const endPrediction = useMemo(() => predictEpisodeEnd({
    position: displayedPosition,
    duration: displayedDuration ?? 0,
    playing: playing && !paused && !suspended,
    eligible: upNext != null && onPlayNext != null,
    dismissed: upNextDismissed,
  }), [displayedDuration, displayedPosition, onPlayNext, paused, playing, suspended, upNext, upNextDismissed]);
  useEffect(() => {
    if (endPrediction.show) upNextWarningShownRef.current = true;
  }, [endPrediction.show]);
  useEffect(() => {
    scrubbingRef.current = scrubbing;
    if (scrubbing || suspended) {
      recoveryProgressWindowRef.current?.reset();
      if (videoRef.current != null) clearReturnedPlayback(videoRef.current);
    }
    stallStateRef.current = {
      ...stallStateRef.current,
      suspended: suspended || documentSuspendedRef.current || document.visibilityState === "hidden",
      seeking: scrubbing || rendererSeekingRef.current,
    };
    stallWatchdogRef.current?.update(stallStateRef.current);
  }, [clearReturnedPlayback, scrubbing, suspended]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (ended || endPrediction.show)) {
        event.preventDefault();
        upNextDismissedRef.current = true;
        setUpNextDismissed(true);
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [endPrediction.show, ended]);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [systemFullscreen, setSystemFullscreen] = useState(false);
  const [safariPageUrl, setSafariPageUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [airPlayAvailable, setAirPlayAvailable] = useState(false);
  const [remotePlaybackAvailable, setRemotePlaybackAvailable] = useState(false);
  const [hlsLevels, setHlsLevels] = useState<HlsLevelChoice[]>([]);
  const [hlsLevel, setHlsLevel] = useState(-1);
  const [hlsAudioTracks, setHlsAudioTracks] = useState<HlsAudioChoice[]>([]);
  const [hlsAudioTrack, setHlsAudioTrack] = useState(-1);
  const [hlsAudioInventoryKnown, setHlsAudioInventoryKnown] = useState(false);
  const [nativeHlsPlayback, setNativeHlsPlayback] = useState(false);
  const nativeHlsPlaybackRef = useRef(false);
  nativeHlsPlaybackRef.current = nativeHlsPlayback;
  const [browserAudioTracks, setBrowserAudioTracks] = useState<HlsAudioChoice[]>([]);
  const [browserAudioTrack, setBrowserAudioTrack] = useState(-1);
  const [browserAudioApiAvailable, setBrowserAudioApiAvailable] = useState(false);
  const [serverAudioTracks, setServerAudioTracks] = useState<HlsAudioChoice[]>([]);
  const [serverAudioInventoryStatus, setServerAudioInventoryStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable"
  >("idle");
  const serverAudioLoadSequenceRef = useRef(0);
  const serverAudioLoadPendingRef = useRef(false);
  const serverAudioLoadControllerRef = useRef<AbortController | null>(null);
  const serverAudioLoaderRef = useRef(serverOptimized?.loadAudioTracks);
  serverAudioLoaderRef.current = serverOptimized?.loadAudioTracks;
  const serverAudioLoaderAvailable = serverOptimized?.loadAudioTracks != null;
  const defaultServerAudioTracks = serverAudioTracks.filter((track) => track.isDefault);
  const resolvedServerAudioTrack = activeServerAudioTrack ?? (
    defaultServerAudioTracks.length === 1 ? defaultServerAudioTracks[0].index : null
  );
  const videoPointerGestureRef = useRef<{
    pointerId: number;
    touchLike: boolean;
    chromeWasHidden: boolean;
  } | null>(null);
  const touchTapRef = useRef<{
    zone: "back" | "forward";
    at: number;
    timer: number;
  } | null>(null);
  const touchFeedbackTimerRef = useRef<number | null>(null);
  const [touchSeekFeedback, setTouchSeekFeedback] = useState<"back" | "forward" | null>(null);
  const volumeIsSilent = muted || volume === 0;
  const underTauri = isTauri();
  const mediaArtist = nowPlaying?.episodeLabel ?? subtitle ?? "";
  const mediaArtworkUrl = nowPlaying?.posterUrl ?? "";

  const clearPendingTouchTap = useCallback(() => {
    if (touchTapRef.current != null) {
      window.clearTimeout(touchTapRef.current.timer);
      touchTapRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (nestedDialogOpen || !touchPlayer) clearPendingTouchTap();
  }, [clearPendingTouchTap, nestedDialogOpen, touchPlayer]);

  useEffect(() => {
    clearPendingTouchTap();
    videoPointerGestureRef.current = null;
  }, [clearPendingTouchTap, engine, serverAudioOwner, timelineOffsetSeconds, url]);

  useEffect(() => () => {
    clearPendingTouchTap();
    videoPointerGestureRef.current = null;
    if (touchFeedbackTimerRef.current != null) window.clearTimeout(touchFeedbackTimerRef.current);
  }, [clearPendingTouchTap]);

  const applyOwnedPlayback = useCallback((video: HTMLVideoElement, shouldPlay: boolean) => {
    if (!ownsSource(video) || playbackSourceRef.current !== url) return;
    const attempt = ++playbackAttemptRef.current;
    video.autoplay = false;
    if (terminalRecoveryOwns(video)) {
      if (!video.paused) video.pause();
      return;
    }
    if (backgroundBlocksPlayback(video) || suspendedRef.current ||
        exactHandoffPendingRef.current || pendingNativeHlsSeekRef.current != null) {
      foregroundPlaybackRef.current = { video, source: url, play: shouldPlay };
      pendingHandoffPlaybackIntentRef.current = shouldPlay ? "play" : "pause";
      if (!shouldPlay && !video.paused) video.pause();
      return;
    }
    const pending = foregroundPlaybackRef.current;
    if (shouldPlay && !video.paused && pending?.video === video && pending.source === url &&
        !nativeControlsOwnPlayback(video)) {
      // Foreground can precede a delayed platform pause. Keep this one owned
      // intent until an actual forward frame or a physical play attempt.
      pending.returnedPosition ??= video.currentTime;
      const idle = foregroundIdleRecoveryRef.current;
      if (idle?.video === video && idle.source === url && idle.token === pending) idle.attempt = attempt;
      return;
    }
    // Consume before the platform call, including synchronous media callbacks.
    foregroundPlaybackRef.current = null;
    pendingHandoffPlaybackIntentRef.current = null;
    autoplayAttemptedRef.current = true;
    if (shouldPlay && video.paused) {
      const onRejected = () => {
        if (!ownsSource(video) || playbackSourceRef.current !== url ||
            playbackAttemptRef.current !== attempt || foregroundPlaybackRef.current?.video === video || !video.paused) return;
        if (preBackgroundPauseRef.current?.video === video) preBackgroundPauseRef.current = null;
        ownedPlaybackPausedRef.current = true;
        setPaused(true);
        setPlaying(false);
        onPausedChange(true);
      };
      try { void video.play().catch(onRejected); } catch { onRejected(); }
    } else if (!shouldPlay && !video.paused) {
      video.pause();
    }
  }, [onPausedChange, sourceIdentity, url]);

  const requestPlaybackState = useCallback((shouldPlay: boolean) => {
    const video = videoRef.current;
    if (video == null || !ownsSource(video)) return;
    explicitPlaybackIntentRef.current = true;
    clearReturnedPlayback(video);
    playbackAttemptRef.current += 1;
    video.autoplay = false;
    // Play/Pause changes intent, not ownership of a decoder-reset clock.
    ownedPlaybackPausedRef.current = !shouldPlay;
    if (terminalRecoveryOwns(video)) {
      if (terminalRecoveryStateRef.current != null) terminalRecoveryStateRef.current.paused = !shouldPlay;
      setPaused(!shouldPlay);
      setPlaying(shouldPlay);
      onPausedChange(!shouldPlay);
      if (!video.paused) video.pause();
      return;
    }
    const pendingRecoverySeek = pendingRecoverySeekFor(video);
    if (pendingRecoverySeek != null) pendingRecoverySeek.state.paused = !shouldPlay;
    const pendingNativeSeek = pendingNativeHlsSeekRef.current;
    if (pendingNativeSeek != null) {
      pendingNativeSeek.playbackIntent = shouldPlay ? "play" : "pause";
      // A requested Play is an intent, not permission to decode from the stale
      // position while native HLS has not confirmed the seek.
      if (!video.paused) video.pause();
      setPaused(true);
      setPlaying(false);
      onPausedChange(true);
      return;
    }
    if (
      exactHandoffPendingRef.current ||
      backgroundBlocksPlayback(video) ||
      foregroundPlaybackRef.current?.video === video ||
      (suspendedRef.current && pendingHandoffPlaybackIntentRef.current != null)
    ) {
      pendingHandoffPlaybackIntentRef.current = shouldPlay ? "play" : "pause";
      onPendingHandoffPausedChange(!shouldPlay);
      setPaused(!shouldPlay);
      setPlaying(shouldPlay);
      onPausedChange(!shouldPlay);
      if (!exactHandoffPendingRef.current) applyOwnedPlayback(video, shouldPlay);
      else if (!shouldPlay && !video.paused) video.pause();
      return;
    }
    if (shouldPlay) {
      try {
        void video.play().catch(() => {});
      } catch {
        // Older WebKit versions can throw synchronously instead of rejecting.
      }
    } else {
      video.pause();
    }
  }, [applyOwnedPlayback, clearReturnedPlayback, onPausedChange, onPendingHandoffPausedChange]);

  useLayoutEffect(() => {
    const pauseOwnedReader = (video: HTMLVideoElement) => {
      if (!ownsSource(video) || playbackSourceRef.current !== url) return false;
      requestPlaybackState(false);
      return true;
    };
    externalHandoffPauseRef.current = pauseOwnedReader;
    return () => {
      if (externalHandoffPauseRef.current === pauseOwnedReader) externalHandoffPauseRef.current = null;
    };
  }, [externalHandoffPauseRef, requestPlaybackState, sourceIdentity, url]);

  const applyDeferredHandoffPlayback = useCallback((
    video: HTMLVideoElement,
    shouldPlay: boolean,
  ) => {
    setPaused(!shouldPlay);
    setPlaying(shouldPlay);
    onPausedChange(!shouldPlay);
    applyOwnedPlayback(video, shouldPlay);
  }, [applyOwnedPlayback, onPausedChange]);

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    const reader = { video, source: sourceIdentity, read: () => {
      if (!ownsSource(video)) return null;
      const { audioPreference, ...state } = currentRecoveryState(video);
      const intent = pendingHandoffPlaybackIntentRef.current;
      return { ...state, ...(audioPreference == null ? {} : { audioPreference }),
        paused: intent === "play" ? false : intent === "pause" ? true : state.paused };
    } };
    ownedPlaybackStateRef.current = reader;
    return () => { if (ownedPlaybackStateRef.current === reader) ownedPlaybackStateRef.current = null; };
  }, [ownedPlaybackStateRef, sourceIdentity]);

  const togglePlaybackState = useCallback(() => {
    const video = videoRef.current;
    if (video == null) return;
    const pendingNativeSeek = pendingNativeHlsSeekRef.current;
    if (pendingNativeSeek != null) {
      const wantsPlayback = pendingNativeSeek.playbackIntent === "play" ||
        (pendingNativeSeek.playbackIntent == null && !pendingNativeSeek.paused);
      requestPlaybackState(!wantsPlayback);
      return;
    }
    const pendingIntent = pendingHandoffPlaybackIntentRef.current;
    const hasDeferredHandoffIntent = exactHandoffPendingRef.current ||
      foregroundPlaybackRef.current?.video === video ||
      terminalRecoveryOwns(video) ||
      (suspendedRef.current && pendingIntent != null);
    if (terminalRecoveryOwns(video)) {
      requestPlaybackState(ownedPlaybackPausedRef.current);
      return;
    }
    const wantsPlayback = hasDeferredHandoffIntent
      ? pendingIntent === "play" ||
        (pendingIntent == null && sourceSwitchStateRef.current?.paused !== true)
      : !video.paused;
    requestPlaybackState(!wantsPlayback);
  }, [requestPlaybackState]);

  const startServerAudioInventoryLoad = useCallback((retryFailed: boolean) => {
    const load = serverAudioLoaderRef.current;
    if (load == null || serverAudioLoadPendingRef.current) return;
    const request = ++serverAudioLoadSequenceRef.current;
    serverAudioLoadPendingRef.current = true;
    setServerAudioInventoryStatus("loading");
    const controller = retryFailed ? new AbortController() : null;
    serverAudioLoadControllerRef.current?.abort();
    serverAudioLoadControllerRef.current = controller;
    let loading: Promise<ServerAudioTrack[]>;
    try {
      loading = retryFailed
        ? load({
            retryFailed: true,
            signal: controller!.signal,
            onSourceInfo: (sourceInfo) => {
              if (serverAudioLoadSequenceRef.current === request) {
                onServerSourceInfoKnown(sourceInfo);
              }
            },
          })
        : load();
    } catch {
      if (serverAudioLoadControllerRef.current === controller) {
        serverAudioLoadControllerRef.current = null;
      }
      serverAudioLoadPendingRef.current = false;
      if (serverAudioLoadSequenceRef.current === request) {
        setServerAudioInventoryStatus("unavailable");
      }
      return;
    }
    void loading.then(
      (tracks) => {
        if (serverAudioLoadControllerRef.current === controller) {
          serverAudioLoadControllerRef.current = null;
        }
        if (serverAudioLoadSequenceRef.current !== request) return;
        serverAudioLoadPendingRef.current = false;
        const choices = normalizedServerAudioTracks(tracks)
          .map((track) => ({
            index: track.index,
            id: String(track.index),
            label: audioTrackLabel(
              track.label,
              track.language,
              `Audio ${track.index + 1}`,
            ),
            language: track.language?.trim() || null,
            logicalLabel: track.label?.trim() || null,
            isDefault: track.default,
          }));
        setServerAudioTracks(choices);
        setServerAudioInventoryStatus("ready");
      },
      () => {
        if (serverAudioLoadControllerRef.current === controller) {
          serverAudioLoadControllerRef.current = null;
        }
        if (serverAudioLoadSequenceRef.current === request) {
          serverAudioLoadPendingRef.current = false;
          setServerAudioInventoryStatus("unavailable");
        }
      },
    );
  }, [onServerSourceInfoKnown]);

  useEffect(() => {
    serverAudioLoadControllerRef.current?.abort();
    serverAudioLoadControllerRef.current = null;
    serverAudioLoadSequenceRef.current += 1;
    serverAudioLoadPendingRef.current = false;
    const choices = normalizedServerAudioTracks(initialServerAudioTracks).map((track) => ({
      index: track.index,
      id: String(track.index),
      label: audioTrackLabel(
        track.label,
        track.language,
        `Audio ${track.index + 1}`,
      ),
      language: track.language?.trim() || null,
      logicalLabel: track.label?.trim() || null,
      isDefault: track.default,
    }));
    setServerAudioTracks(choices);
    setServerAudioInventoryStatus(
      initialServerAudioTracks != null ? "ready" : "idle",
    );
    // A successful optimized switch carries the audio preference that produced
    // this exact URL. Treat it like an explicit URL audio selection on remount,
    // otherwise stale saved preferences can immediately switch the new stream
    // back to its previous/default track.
    appliedServerAudioPreferenceRef.current =
      activeServerAudioPreference != null ||
      (initialServerAudioTrackExplicit && retainedServerAudioPreference == null);
  }, [
    activeServerAudioPreference,
    initialServerAudioTrackExplicit,
    initialServerAudioTracks,
    retainedServerAudioPreference,
    serverAudioOwner,
  ]);

  useEffect(() => () => {
    serverAudioLoadSequenceRef.current += 1;
    serverAudioLoadControllerRef.current?.abort();
    serverAudioLoadControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!optionsOpen || !serverAudioLoaderAvailable || serverAudioInventoryStatus !== "idle") return;
    startServerAudioInventoryLoad(false);
  }, [
    optionsOpen,
    serverAudioInventoryStatus,
    serverAudioLoaderAvailable,
    serverAudioOwner,
    startServerAudioInventoryLoad,
  ]);

  if (serverOptimized != null && resolvedServerAudioTrack != null) {
    const selected = serverAudioTracks.find(
      (track) => track.index === resolvedServerAudioTrack,
    );
    audioPreferenceRef.current = {
      id: activeServerAudioPreference?.id ?? selected?.id ?? String(resolvedServerAudioTrack),
      language: activeServerAudioPreference?.language ?? selected?.language ?? null,
    };
  }

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

  useLayoutEffect(() => {
    onCaptionsOpenChange(captionsOpen);
  }, [captionsOpen, onCaptionsOpenChange]);

  useLayoutEffect(() => {
    onMenuOpenChange(optionsOpen);
  }, [onMenuOpenChange, optionsOpen]);

  const subs = useSubtitleTracks(subtitleClient, translator);
  const subsRef = useRef(subs);
  subsRef.current = subs;
  const [embeddedCaptionState, setEmbeddedCaptionState] = useState<
    Omit<EmbeddedCaptions, "setActiveTrack">
  >({ tracks: [], activeTrackId: null });
  const captionControllerRef = useRef<{
    refresh: () => void;
    selectEmbedded: (id: string | null) => void;
    selectDownloaded: (id: string | null) => void;
    updateDownloaded: (id: string | null) => void;
  } | null>(null);
  const selectDownloadedCaption = useCallback((id: string | null) => {
    captionControllerRef.current?.selectDownloaded(id);
  }, []);
  const selectEmbeddedCaption = useCallback((id: string | null) => {
    captionControllerRef.current?.selectEmbedded(id);
  }, []);

  // Observe the media owner's actual subtitle inventory, including late HLS
  // renditions and Safari TextTrackList changes. Downloaded tracks are owned by
  // their <track> identity, never by a potentially colliding display label.
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    const list = video.textTracks;
    let active = true;
    let updating = false;
    let nextId = 0;
    const identities = new WeakMap<object, string>();
    const identity = (track: object, prefix: string) => {
      let id = identities.get(track);
      if (id == null) {
        id = `${prefix}:${nextId++}`;
        identities.set(track, id);
      }
      return id;
    };
    type Choice = {
      id: string;
      label: string;
      language: string;
      hlsIndex?: number;
      textTrack?: TextTrack;
      name: string;
    };
    let downloadedId = subsRef.current.activeTrackId;
    let mode: "auto" | "off" | "embedded" | "downloaded" = "auto";
    let preferencePending = true;
    const ownedTrack = (track: TextTrack) =>
      Array.from(video.querySelectorAll("track")).find(
        (element) => element.track === track,
      )?.dataset.subtitleTrackId ?? null;
    const textTracks = () => Array.from(list).filter(
      (track) => track.kind === "subtitles" || track.kind === "captions",
    );
    const label = (name: string, language: string) => {
      const friendly = name.trim();
      return /^subtitle[_ -]?\d+$/i.test(friendly)
        ? "Embedded subtitles"
        : friendly || language.trim() || "Embedded subtitles";
    };
    const inventory = (): Choice[] => {
      const hlsChoices = (hlsRef.current?.subtitleTracks ?? []).map((track, index) => ({
        id: identity(track, "hls"),
        label: label(track.name ?? "", track.lang ?? ""),
        name: track.name ?? "",
        language: track.lang ?? "",
        hlsIndex: index,
      }));
      const nativeChoices = textTracks().filter((track) =>
        ownedTrack(track) == null && !hlsChoices.some((choice) =>
          choice.name === track.label && choice.language === track.language,
        ),
      ).map((track) => ({
        id: identity(track, "native"),
        label: label(track.label, track.language),
        name: track.label,
        language: track.language,
        textTrack: track,
      }));
      return [...hlsChoices, ...nativeChoices];
    };
    const setMode = (track: TextTrack, next: TextTrackMode) => {
      if (track.mode !== next) track.mode = next;
    };
    const disableHls = () => {
      const hls = hlsRef.current;
      if (hls == null) return;
      if (hls.subtitleDisplay) hls.subtitleDisplay = false;
      if (hls.subtitleTrack !== -1) hls.subtitleTrack = -1;
    };
    const show = (choice: Choice) => {
      const hls = hlsRef.current;
      if (choice.hlsIndex != null && hls != null) {
        hls.subtitleDisplay = true;
        hls.subtitleTrack = choice.hlsIndex;
      } else {
        disableHls();
      }
      for (const track of textTracks()) {
        const selected = ownedTrack(track) == null && (
          track === choice.textTrack || (choice.hlsIndex != null &&
            track.label === choice.name && track.language === choice.language)
        );
        setMode(track, selected ? "showing" : "disabled");
      }
    };
    const refresh = () => {
      if (!active || !ownsSource(video) || updating) return;
      updating = true;
      try {
        const choices = inventory();
        if (preferencePending && downloadedId == null) {
          const preferences = playerPreferencesRef.current;
          const remembered = preferences?.rememberPerTitleTrackChoices === false
            ? null : savedPrefs?.preferredSubId;
          const matchLanguage = (language: unknown) =>
            findPreferredLanguageMatch(language, choices, (choice) => choice.language) ??
            findPreferredLanguageMatch(language, choices, (choice) => choice.name);
          const rememberedMatch = remembered === "no" ? null : matchLanguage(remembered);
          const preferredMatch = preferences?.defaultSubtitleBehavior === "preferred"
            ? matchLanguage(preferences.defaultSubtitleLanguage) : null;
          const preferred = rememberedMatch ?? preferredMatch;
          if (remembered === "no") {
            mode = "off";
            preferencePending = false;
          } else if (preferred != null) {
            mode = "embedded";
            preferencePending = false;
            show(preferred);
          } else if (preferences?.defaultSubtitleBehavior === "off" ||
            preferences?.defaultSubtitleBehavior === "preferred") {
            // Do not substitute a manifest's unknown/default language when the
            // requested language has not appeared. Keep listening for it.
            mode = "off";
          }
        }
        if (mode === "off" || mode === "downloaded") {
          disableHls();
          for (const track of textTracks()) {
            const owner = ownedTrack(track);
            setMode(track, owner != null && owner === downloadedId ? "showing" : "disabled");
          }
        }
        const showing = textTracks().find((track) =>
          ownedTrack(track) == null && track.mode === "showing",
        );
        const hls = hlsRef.current;
        const selected = showing != null
          ? choices.find((choice) => choice.textTrack === showing || (
            choice.hlsIndex != null && choice.name === showing.label &&
            choice.language === showing.language
          ))
          : choices.find((choice) => choice.hlsIndex != null &&
            choice.hlsIndex === hls?.subtitleTrack && hls.subtitleDisplay &&
            !textTracks().some((track) => ownedTrack(track) == null &&
              track.label === choice.name && track.language === choice.language),
          );
        const next = {
          tracks: choices.map(({ id, label }) => ({ id, label })),
          activeTrackId: selected?.id ?? null,
        };
        setEmbeddedCaptionState((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
      } finally {
        updating = false;
      }
    };
    const controller = {
      refresh,
      selectEmbedded: (id: string | null) => {
        if (!active || !ownsSource(video)) return;
        const choice = id == null ? null : inventory().find((track) => track.id === id);
        if (id != null && choice == null) return;
        preferencePending = false;
        downloadedId = null;
        mode = choice == null ? "off" : "embedded";
        updating = true;
        try {
          subsRef.current.setActiveTrack(null);
          if (choice != null) show(choice);
        } finally {
          updating = false;
        }
        refresh();
      },
      selectDownloaded: (id: string | null) => {
        if (!active || !ownsSource(video)) return;
        preferencePending = false;
        downloadedId = id;
        mode = id == null ? "off" : "downloaded";
        subsRef.current.setActiveTrack(id);
        refresh();
      },
      updateDownloaded: (id: string | null) => {
        if (!active) return;
        if (id != null) {
          preferencePending = false;
          mode = "downloaded";
        } else if (downloadedId != null) {
          mode = "off";
        }
        downloadedId = id;
        refresh();
      },
    };
    captionControllerRef.current = controller;
    for (const event of ["addtrack", "removetrack", "change"]) {
      list.addEventListener?.(event, refresh);
    }
    video.addEventListener("loadedmetadata", refresh);
    refresh();
    return () => {
      active = false;
      for (const event of ["addtrack", "removetrack", "change"]) {
        list.removeEventListener?.(event, refresh);
      }
      video.removeEventListener("loadedmetadata", refresh);
      if (captionControllerRef.current === controller) captionControllerRef.current = null;
    };
  }, [engine, sourceIdentity, url]);
  useEffect(() => {
    captionControllerRef.current?.updateDownloaded(subs.activeTrackId);
  }, [subs.activeTrackId, subs.tracks]);

  const captionLayoutOptionsRef = useRef({ chromeVisible, videoFit, videoZoom, subtitlePosition });
  captionLayoutOptionsRef.current = { chromeVisible, videoFit, videoZoom, subtitlePosition };
  const refreshCaptionLayoutRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const video = videoRef.current;
    const viewport = captionViewportRef.current;
    const controls = captionControlsRef.current;
    if (video == null || viewport == null) return;
    let active = true;
    let nativeFullscreen = false;
    type PositionedCue = TextTrackCue & Pick<VTTCue,
      "line" | "snapToLines" | "lineAlign" | "position" | "positionAlign" | "size" | "vertical" | "region" | "text">;
    type Geometry = Pick<PositionedCue, "line" | "snapToLines" | "lineAlign" | "position" | "positionAlign" | "size">;
    const originals = new Map<PositionedCue, { track: TextTrack; geometry: Geometry }>();
    const trackListeners = new Map<TextTrack, () => void>();
    const oldFont = video.style.getPropertyValue("--player-caption-font-size");
    const restore = (cue: PositionedCue, geometry: Geometry) => {
      try { Object.assign(cue, geometry); } catch { /* A browser may have disposed an expired native cue. */ }
    };
    const apply = () => {
      if (!active || !ownsSource(video) || !video.isConnected) return;
      const tracks = new Set(Array.from(video.textTracks));
      for (const [track, listener] of trackListeners) {
        if (tracks.has(track)) continue;
        track.removeEventListener("cuechange", listener);
        trackListeners.delete(track);
      }
      for (const track of tracks) {
        if (!trackListeners.has(track)) {
          track.addEventListener("cuechange", apply);
          trackListeners.set(track, apply);
        }
      }
      const currentCues = new Set<PositionedCue>();
      for (const track of tracks) {
        if (track.mode !== "showing" || !["subtitles", "captions"].includes(track.kind)) continue;
        for (const cue of Array.from(track.cues ?? [])) {
          if (!("line" in cue) || !("snapToLines" in cue)) continue;
          const positioned = cue as PositionedCue;
          currentCues.add(positioned);
          if (!originals.has(positioned)) {
            originals.set(positioned, { track, geometry: {
              line: positioned.line, snapToLines: positioned.snapToLines,
              lineAlign: positioned.lineAlign, position: positioned.position,
              positionAlign: positioned.positionAlign, size: positioned.size,
            } });
          }
        }
      }
      for (const [cue, original] of originals) {
        if (currentCues.has(cue)) continue;
        restore(cue, original.geometry);
        originals.delete(cue);
      }
      const nativeMode = (video as WebKitVideoElement).webkitPresentationMode;
      if (nativeFullscreen || document.pictureInPictureElement === video ||
          (nativeMode != null && nativeMode !== "inline")) {
        // Browser-owned presentation has no measurable inline cue viewport.
        for (const [cue, original] of originals) restore(cue, original.geometry);
        if (oldFont) video.style.setProperty("--player-caption-font-size", oldFont);
        else video.style.removeProperty("--player-caption-font-size");
        return;
      }
      const options = captionLayoutOptionsRef.current;
      const rootStyle = getComputedStyle(document.documentElement);
      const fontScale = Number.parseFloat(rootStyle.getPropertyValue("--sub-font-scale"));
      const fullscreen = document.fullscreenElement ?? (document as WebKitDocument).webkitFullscreenElement;
      const box = (fullscreen?.contains(video) ? fullscreen : viewport).getBoundingClientRect();
      const controlsVisible = options.chromeVisible &&
        (fullscreen == null || (controls != null && fullscreen.contains(controls)));
      const visual = window.visualViewport;
      let visible: CaptionRect = box;
      if (visual != null && visual.width > 0 && visual.height > 0) {
        const left = Math.max(box.left, visual.offsetLeft);
        const top = Math.max(box.top, visual.offsetTop);
        visible = { left, top,
          width: Math.min(box.right, visual.offsetLeft + visual.width) - left,
          height: Math.min(box.bottom, visual.offsetTop + visual.height) - top,
        };
      }
      const bounds = {
        video: video.getBoundingClientRect(), viewport: visible,
        controls: controlsVisible ? controls?.getBoundingClientRect() : null,
        mediaWidth: video.videoWidth, mediaHeight: video.videoHeight,
        fit: options.videoFit, position: options.subtitlePosition,
        fontScale, zoom: options.videoZoom,
      };
      for (const [cue, original] of originals) {
        // Safari (and hls.js on Safari) can expose automatic defaults as -1/50.
        // A literal authored -1/50 is indistinguishable from those defaults.
        // Other authored line/vertical/region/position layouts remain authored.
        const geometry = original.geometry;
        const automaticLine = geometry.line === "auto" ||
          (geometry.line === -1 && geometry.snapToLines && geometry.lineAlign === "start");
        if (!automaticLine || cue.vertical || cue.region != null ||
            (geometry.position !== "auto" && geometry.position !== 50) || geometry.size !== 100) continue;
        const layout = captionLayout({ ...bounds, text: cue.text });
        if (layout == null) { restore(cue, geometry); continue; }
        video.style.setProperty("--player-caption-font-size", `${layout.fontSize}px`);
        cue.snapToLines = false;
        cue.line = layout.line;
        cue.lineAlign = layout.lineAlign;
        cue.position = layout.position;
        cue.positionAlign = "center";
        cue.size = layout.size;
      }
    };
    const beginNativeFullscreen = () => { nativeFullscreen = true; apply(); };
    const endNativeFullscreen = () => { nativeFullscreen = false; apply(); };
    refreshCaptionLayoutRef.current = apply;
    const list = video.textTracks;
    for (const event of ["addtrack", "removetrack", "change"]) list.addEventListener?.(event, apply);
    for (const event of ["loadedmetadata", "resize", "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"]) video.addEventListener(event, apply);
    video.addEventListener("webkitbeginfullscreen", beginNativeFullscreen);
    video.addEventListener("webkitendfullscreen", endNativeFullscreen);
    for (const event of ["resize", "orientationchange"]) window.addEventListener(event, apply);
    document.addEventListener("fullscreenchange", apply);
    document.addEventListener("webkitfullscreenchange", apply);
    const visual = window.visualViewport;
    visual?.addEventListener("resize", apply);
    visual?.addEventListener("scroll", apply);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resize?.observe(viewport);
    resize?.observe(video);
    if (controls != null) resize?.observe(controls);
    const appearance = new MutationObserver(apply);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    apply();
    return () => {
      active = false;
      if (refreshCaptionLayoutRef.current === apply) refreshCaptionLayoutRef.current = null;
      for (const event of ["addtrack", "removetrack", "change"]) list.removeEventListener?.(event, apply);
      for (const event of ["loadedmetadata", "resize", "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"]) video.removeEventListener(event, apply);
      video.removeEventListener("webkitbeginfullscreen", beginNativeFullscreen);
      video.removeEventListener("webkitendfullscreen", endNativeFullscreen);
      for (const event of ["resize", "orientationchange"]) window.removeEventListener(event, apply);
      document.removeEventListener("fullscreenchange", apply);
      document.removeEventListener("webkitfullscreenchange", apply);
      visual?.removeEventListener("resize", apply);
      visual?.removeEventListener("scroll", apply);
      resize?.disconnect();
      appearance.disconnect();
      for (const [track, listener] of trackListeners) track.removeEventListener("cuechange", listener);
      for (const [cue, original] of originals) restore(cue, original.geometry);
      if (oldFont) video.style.setProperty("--player-caption-font-size", oldFont);
      else video.style.removeProperty("--player-caption-font-size");
    };
  }, [engine, sourceIdentity, url]);
  useLayoutEffect(() => {
    refreshCaptionLayoutRef.current?.();
  }, [chromeVisible, videoFit, videoZoom, videoPanX, videoPanY, subtitlePosition,
    subs.activeTrackId, subs.tracks, embeddedCaptionState]);
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
    const deferredIntent = pendingHandoffPlaybackIntentRef.current;
    if (!exactHandoffPendingRef.current && deferredIntent != null) {
      pendingHandoffPlaybackIntentRef.current = null;
      pausedForCastRef.current = false;
      applyDeferredHandoffPlayback(video, deferredIntent === "play");
      return;
    }
    if (pausedForCastRef.current) {
      pausedForCastRef.current = false;
      void video.play().catch(() => {});
    }
  }, [applyDeferredHandoffPlayback, suspended]);
  // Thumbnails only work on a progressive source the browser can re-open and
  // seek (MP4/WebM). For HLS the manifest URL can't drive a second <video>
  // reliably, so gate them to non-HLS in-webview sources.
  const isHls = url.split("?")[0].toLowerCase().endsWith(".m3u8");
  const thumbs = useScrubThumbnails(url, !isHls);

  // Safari/native-HLS and a few embedded browsers expose AudioTrackList on the
  // media element instead of through hls.js. Chromium intentionally does not,
  // so capability detection and the unavailable message in the menu are both
  // required. Track-list events can arrive before or after loadedmetadata.
  useEffect(() => {
    const video = videoRef.current as BrowserAudioVideoElement | null;
    if (video == null) return;
    const list = video.audioTracks;
    const listEventsAvailable =
      list != null &&
      typeof list.addEventListener === "function" &&
      typeof list.removeEventListener === "function";
    appliedBrowserAudioPreferenceRef.current = false;
    setBrowserAudioTracks([]);
    setBrowserAudioTrack(-1);
    setBrowserAudioApiAvailable(listEventsAvailable);
    reconcilingBrowserAudioSelectionRef.current = false;
    if (list == null || !listEventsAvailable) return;

    const trackAt = (index: number): BrowserAudioTrack | null =>
      list[index] ?? list.item?.(index) ?? null;
    const choices = (): HlsAudioChoice[] => {
      const next: HlsAudioChoice[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const track = trackAt(index);
        if (track == null) continue;
        next.push({
          index,
          id: track.id?.trim() || String(index),
          label: audioTrackLabel(
            track.label,
            track.language,
            `Audio ${index + 1}`,
          ),
          language: track.language?.trim() || null,
        });
      }
      return next;
    };
    const selectTrack = (index: number, available: HlsAudioChoice[]) => {
      const selected = available.find((track) => track.index === index) ?? null;
      setBrowserAudioTrack(selected?.index ?? -1);
      audioPreferenceRef.current = {
        id: selected?.id ?? null,
        language: selected?.language ?? null,
      };
      reconcilingBrowserAudioSelectionRef.current = true;
      try {
        for (let candidate = 0; candidate < list.length; candidate += 1) {
          const track = trackAt(candidate);
          const shouldEnable = candidate === index;
          if (track != null && track.enabled !== shouldEnable) {
            track.enabled = shouldEnable;
          }
        }
      } finally {
        reconcilingBrowserAudioSelectionRef.current = false;
      }
    };
    const sync = () => {
      if (!mediaEventsCurrent(video) || reconcilingBrowserAudioSelectionRef.current) return;
      const available = choices();
      setBrowserAudioTracks(available);
      const enabled = available.filter((choice) => trackAt(choice.index)?.enabled);
      let selected = enabled[0] ?? null;
      if (enabled.length > 1 && appliedBrowserAudioPreferenceRef.current) {
        const preference = audioPreferenceRef.current;
        const previous =
          available.find((track) => track.id === preference.id) ??
          findPreferredLanguageMatch(
            preference.language,
            available,
            (track) => track.language,
          );
        if (previous != null) {
          selectTrack(previous.index, available);
          return;
        }
      }
      if (!appliedBrowserAudioPreferenceRef.current && available.length > 0) {
        const preferences = playerPreferencesRef.current;
        const perTitlePrefs = preferences?.rememberPerTitleTrackChoices === false
          ? null
          : savedPrefs;
        const match =
          findPreferredLanguageMatch(
            sourceSwitchStateRef.current?.audioPreference?.language,
            available,
            (track) => track.language,
          ) ??
          (sourceSwitchStateRef.current?.audioPreference?.language == null
            ? available.find((track) => track.id === sourceSwitchStateRef.current?.audioPreference?.id)
            : null) ??
          findPreferredLanguageMatch(
            perTitlePrefs?.preferredAudioLang,
            available,
            (track) => track.language,
          ) ??
          available.find((track) => track.id === perTitlePrefs?.preferredAudioId) ??
          findPreferredLanguageMatch(
            preferences?.defaultAudioLanguage,
            available,
            (track) => track.language,
          ) ??
          findPreferredLanguageMatch(
            preferences?.defaultAudioLanguage,
            available,
            (track) => track.label,
          );
        if (match != null) {
          appliedBrowserAudioPreferenceRef.current = true;
          selectTrack(match.index, available);
          return;
        }
      }
      setBrowserAudioTrack(selected?.index ?? -1);
      audioPreferenceRef.current = {
        id: selected?.id ?? null,
        language: selected?.language ?? null,
      };
    };

    sync();
    list.addEventListener("addtrack", sync);
    list.addEventListener("removetrack", sync);
    list.addEventListener("change", sync);
    video.addEventListener("loadedmetadata", sync);
    return () => {
      reconcilingBrowserAudioSelectionRef.current = false;
      list.removeEventListener("addtrack", sync);
      list.removeEventListener("removetrack", sync);
      list.removeEventListener("change", sync);
      video.removeEventListener("loadedmetadata", sync);
    };
  }, [savedPrefs, sourceIdentity, url]);

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
      const knownDuration = knownAbsoluteDurationRef.current;
      if (knownDuration == null && optimizedTimelineIsPartial) return;
      const offset = knownDuration == null ? 0 : timelineOffsetRef.current;
      const mediaDuration = knownDuration ?? video.duration;
      const currentTime = video.currentTime + offset;
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
      absoluteSeekRef.current(time);
    };
    const currentAbsolutePosition = () => video.currentTime + (
      knownAbsoluteDurationRef.current != null || optimizedTimelineIsPartial
        ? timelineOffsetRef.current
        : 0
    );
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
      requestPlaybackState(true);
    });
    setActionHandler("pause", () => requestPlaybackState(false));
    setActionHandler("seekbackward", () => seek(currentAbsolutePosition() - 10));
    setActionHandler("seekforward", () => seek(currentAbsolutePosition() + 10));
    setActionHandler("seekto", (details) => {
      if (details.seekTime != null) seek(details.seekTime);
    });
    setActionHandler("stop", () => {
      requestPlaybackState(false);
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
  }, [
    mediaArtist,
    mediaArtworkUrl,
    optimizedTimelineIsPartial,
    requestPlaybackState,
    title,
    url,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    const container = video == null ? null : playerFullscreenContainer(video);
    if (video == null || container == null) return;
    const webkitVideo = video as WebKitVideoElement;
    const syncFullscreenSupport = () => {
      const supportsContainerFullscreen = containerFullscreenRequest(container) != null;
      const supportsWebKitFullscreen =
        webkitVideo.webkitSupportsFullscreen === true &&
        typeof webkitVideo.webkitEnterFullscreen === "function";
      setFullscreenSupported(supportsContainerFullscreen || supportsWebKitFullscreen);
      setSystemFullscreen(!supportsContainerFullscreen && supportsWebKitFullscreen);
      setSafariPageUrl(supportsContainerFullscreen ? null : ipadSafariPageUrl(
        window.location, navigator, isStandaloneDisplay(),
        deviceKind() === "ios" && !isTauri() && !isAndroidAppUiContext(),
      ));
    };
    const readinessEvents = ["loadedmetadata", "canplay", "emptied"];
    readinessEvents.forEach((event) => video.addEventListener(event, syncFullscreenSupport));
    syncFullscreenSupport();

    const setFullscreenState = (next: boolean) => {
      setIsFullscreen(next);
      if (next) lockLandscapeOrientation();
      else unlockOrientation();
    };
    const syncFullscreenState = () => {
      const doc = document as WebKitDocument;
      const fullscreenElement = document.fullscreenElement ?? doc.webkitFullscreenElement;
      setFullscreenState(fullscreenElement === container || fullscreenElement === video);
    };
    const onWebKitBeginFullscreen = () => setFullscreenState(true);
    const onWebKitEndFullscreen = () => setFullscreenState(false);

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    video.addEventListener("webkitbeginfullscreen", onWebKitBeginFullscreen);
    video.addEventListener("webkitendfullscreen", onWebKitEndFullscreen);
    syncFullscreenState();
    return () => {
      readinessEvents.forEach((event) => video.removeEventListener(event, syncFullscreenSupport));
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
    const supportsStandardPiP =
      document.pictureInPictureEnabled === true &&
      typeof video.requestPictureInPicture === "function";
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
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onSourceSizeRef = useRef(onSourceSize);
  onSourceSizeRef.current = onSourceSize;
  // Stable ref for the HLS-unsupported callback so the source-attach effect does
  // NOT list a fresh inline arrow in its deps. Detail re-renders every ~5s (the
  // progress → recordResume → refreshHistory loop), and a changing callback
  // identity would otherwise re-run that effect and reload video.src - restarting
  // playback from 0 every few seconds.
  const onPlaybackErrorRef = useRef(onPlaybackError);
  onPlaybackErrorRef.current = onPlaybackError;
  const onPlaybackStallRef = useRef(onPlaybackStall);
  onPlaybackStallRef.current = onPlaybackStall;
  const onRecoveryPlaybackHealthyRef = useRef(onRecoveryPlaybackHealthy);
  onRecoveryPlaybackHealthyRef.current = onRecoveryPlaybackHealthy;
  const canRefreshSourceRef = useRef(canRefreshSource);
  canRefreshSourceRef.current = canRefreshSource;
  // Resume position is captured in a ref + a one-shot guard so we seek exactly
  // once, when metadata first loads, without re-subscribing the effect.
  const startPositionRef = useRef(startPositionSeconds);
  startPositionRef.current = startPositionSeconds;
  const nativeExactHlsFragmentRef = useRef(false);
  const timelineOffsetRef = useRef(
    Number.isFinite(timelineOffsetSeconds)
      ? Math.max(0, timelineOffsetSeconds)
      : 0,
  );
  timelineOffsetRef.current = Number.isFinite(timelineOffsetSeconds)
    ? Math.max(0, timelineOffsetSeconds)
    : 0;
  const optimizedTimelineIsPartialRef = useRef(optimizedTimelineIsPartial);
  optimizedTimelineIsPartialRef.current = optimizedTimelineIsPartial;
  const knownAbsoluteDurationRef = useRef<number | null>(null);
  knownAbsoluteDurationRef.current = knownAbsoluteDurationSeconds != null &&
    Number.isFinite(knownAbsoluteDurationSeconds) &&
    knownAbsoluteDurationSeconds > 0
    ? knownAbsoluteDurationSeconds
    : null;
  const onSourceDurationKnownRef = useRef(onSourceDurationKnown);
  onSourceDurationKnownRef.current = onSourceDurationKnown;
  const absoluteDurationFor = (localDuration: number): number | null => {
    if (knownAbsoluteDurationRef.current != null) return knownAbsoluteDurationRef.current;
    if (optimizedTimelineIsPartial) return null;
    return Number.isFinite(localDuration) && localDuration > 0
      ? localDuration + timelineOffsetRef.current
      : null;
  };
  const didSeekRef = useRef(false);
  const explicitInitialSeekRef = useRef<number | null>(null);
  const claimInitialSeek = useCallback((localTarget: number) => {
    backgroundPauseVideoRef.current = null;
    onAbsolutePositionChange(localTarget + timelineOffsetRef.current);
    if (didSeekRef.current) return;
    if (exactHandoffPendingRef.current) {
      explicitInitialSeekRef.current = localTarget;
      nativeExactHlsFragmentRef.current = false;
    } else {
      didSeekRef.current = true;
    }
  }, [onAbsolutePositionChange]);
  const invalidatePendingNativeHlsSeek = useCallback(() => {
    pendingNativeHlsSeekSequenceRef.current += 1;
    const pending = pendingNativeHlsSeekRef.current;
    if (pending?.timer != null) window.clearTimeout(pending.timer);
    pendingNativeHlsSeekRef.current = null;
    onCancelNativeHlsSeekOptimization();
  }, [onCancelNativeHlsSeekOptimization]);

  const confirmPendingNativeHlsSeek = useCallback((video: HTMLVideoElement) => {
    const pending = pendingNativeHlsSeekRef.current;
    if (
      pending == null ||
      pending.fallbackStarted ||
      !ownsSource(video) ||
      video.seeking ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !Number.isFinite(video.currentTime) ||
      Math.abs(video.currentTime - pending.localTarget) > 0.25
    ) {
      return pending == null;
    }
    if (pending.timer != null) window.clearTimeout(pending.timer);
    pendingNativeHlsSeekRef.current = null;
    onAbsolutePositionChange(pending.absoluteTarget);
    scrubberRef.current?.setCurrentTime(pending.absoluteTarget);
    setPlaybackStatus(null);
    const shouldPlay = pending.playbackIntent === "play" ||
      (pending.playbackIntent == null && !pending.paused);
    applyDeferredHandoffPlayback(video, shouldPlay);
    return true;
  }, [applyDeferredHandoffPlayback, onAbsolutePositionChange]);

  const settleNativeHlsSeekReplacement = useCallback((
    pending: PendingNativeHlsSeek,
    video: HTMLVideoElement,
    activated: boolean,
  ) => {
    if (
      activated ||
      pendingNativeHlsSeekRef.current !== pending ||
      pendingNativeHlsSeekSequenceRef.current !== pending.sequence ||
      !ownsSource(video)
    ) {
      return;
    }
    if (pending.timer != null) window.clearTimeout(pending.timer);
    pendingNativeHlsSeekRef.current = null;
    if (!video.paused) video.pause();
    setPlaybackStatus(null);
    setPaused(true);
    setPlaying(false);
    onPausedChange(true);
  }, [onPausedChange, sourceIdentity]);

  useEffect(() => () => {
    invalidatePendingNativeHlsSeek();
  }, [
    engine,
    episode,
    imdbId,
    invalidatePendingNativeHlsSeek,
    season,
    serverAudioOwner,
    subtitle,
    title,
    sourceIdentity,
    url,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    let active = true;
    let recoveryProgressReported = false;
    let recoveryBuffering = false;
    const recoveryProgress = new PlaybackRecoveryProgress();
    recoveryProgressWindowRef.current = recoveryProgress;
    let lastPosition = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    let lastBufferedFrontier = Number.NaN;
    const watchdog = new PlaybackStallWatchdog(() => {
      if (!active || !ownsSource(video) || stallWatchdogRef.current !== watchdog ||
        terminalRecoveryOwns(video)) return;
      if (quarantineResetClock()) return;
      const liveState = {
        ...stallStateRef.current,
        paused: video.paused,
        seeking: video.seeking || rendererSeekingRef.current || scrubbingRef.current,
        suspended: suspendedRef.current || documentSuspendedRef.current || document.visibilityState === "hidden",
        ended: video.ended,
      };
      stallStateRef.current = liveState;
      if (!playbackExpectedToAdvance(liveState)) {
        watchdog.update(liveState);
        return;
      }
      // Media events can be delayed while the renderer clock keeps advancing.
      // Re-check the owned element before replacing an otherwise healthy source.
      const livePosition = video.currentTime;
      if (Number.isFinite(livePosition) && Math.abs(livePosition - lastPosition) >= 0.05) {
        lastPosition = livePosition;
        watchdog.update(liveState);
        return;
      }
      const snapshot = captureRecoverySnapshot(video);
      void onPlaybackStallRef.current(snapshot.position, snapshot.state);
    });
    stallWatchdogRef.current = watchdog;
    stallStateRef.current = {
      started: false,
      paused: true,
      seeking: false,
      suspended: suspendedRef.current || documentSuspendedRef.current || document.visibilityState === "hidden",
      ended: false,
      tearingDown: false,
    };

    const sync = (patch: Partial<PlaybackStallState> = {}) => {
      stallStateRef.current = {
        ...stallStateRef.current, ...patch,
        suspended: suspendedRef.current || documentSuspendedRef.current || document.visibilityState === "hidden",
      };
      watchdog.update(stallStateRef.current);
    };
    const queueOwnedForegroundPlayback = () => {
      if (active && ownsSource(video) && backgroundBlocksPlayback(video) &&
          verifiedPlaybackProgressReportedRef.current && !ownedPlaybackPausedRef.current && !video.ended &&
          !nativeControlsOwnPlayback(video)) {
        backgroundPauseVideoRef.current = video;
        foregroundPlaybackRef.current = { video, source: url, play: true };
        pendingHandoffPlaybackIntentRef.current = "play";
      }
    };
    const quarantineResetClock = (): boolean => {
      if (terminalRecoveryOwns(video)) {
        if (!video.paused) video.pause();
        return true;
      }
      if (!active || !ownsSource(video) || !verifiedPlaybackProgressReportedRef.current ||
          !recoveryClockWasReset(video)) return false;
      recoveryProgress.reset();
      // Retain intent, but never let a replay clock earn health or keep decoding.
      if (!video.paused) video.pause();
      if (backgroundBlocksPlayback(video) || suspendedRef.current) return true;
      if (recoverTerminalPlayback(video, true)) {
        foregroundPlaybackRef.current = null;
        pendingHandoffPlaybackIntentRef.current = null;
      }
      return true;
    };
    const bufferedFrontier = () => {
      const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        const start = video.buffered.start(index);
        const end = video.buffered.end(index);
        if (start <= position + 0.25 && end >= position - 0.25) return end;
      }
      return Number.NaN;
    };
    const decodedFrameCount = (): number | null => {
      try {
        const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
        return count != null && Number.isSafeInteger(count) && count >= 0 ? count : null;
      } catch { return null; }
    };
    const foregroundReturnOwned = () =>
      active && ownsSource(video) && video.isConnected && playbackSourceRef.current === url &&
        canRefreshSourceRef.current && verifiedPlaybackProgressReportedRef.current &&
        !ownedPlaybackPausedRef.current && !video.paused && !video.ended && video.error == null &&
        !terminalRecoveryOwns(video) && !video.controls && !nativeControlsOwnPlayback(video) &&
        !video.seeking && !rendererSeekingRef.current && !scrubbingRef.current && pendingRecoverySeekFor(video) == null &&
        !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null && !suspendedRef.current &&
        !backgroundBlocksPlayback(video) && document.visibilityState === "visible" && document.hasFocus();
    const bufferlessReturnEligible = () => {
      const total = absoluteDurationFor(video.duration);
      return foregroundReturnOwned() && verifiedPlaybackPlayingRef.current &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && video.networkState === HTMLMediaElement.NETWORK_IDLE &&
        Number.isFinite(video.currentTime) && !Number.isFinite(bufferedFrontier()) &&
        total != null && total - (video.currentTime + timelineOffsetRef.current) >= 5;
    };
    const armForegroundIdleRecovery = () => {
      cancelForegroundIdleRecovery(video);
      const frames = decodedFrameCount();
      if (frames == null || !foregroundReturnOwned() || !Number.isFinite(video.currentTime)) return;
      const position = video.currentTime;
      const pending = { video, source: url, attempt: playbackAttemptRef.current, token: foregroundPlaybackRef.current,
        timer: window.setTimeout(() => {
        if (foregroundIdleRecoveryRef.current !== pending) return;
        // Consume before entering the existing terminal/source-resolution fence.
        foregroundIdleRecoveryRef.current = null;
        if (!bufferlessReturnEligible() || playbackAttemptRef.current !== pending.attempt ||
            Math.abs(video.currentTime - position) > 0.01 || decodedFrameCount() !== frames) return;
        recoverTerminalPlayback(video);
      }, FOREGROUND_BUFFERLESS_TIMEOUT_MS) };
      foregroundIdleRecoveryRef.current = pending;
    };
    const onPlaying = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA) || (sourceLoadRef.current.reused && video.paused)) return;
      if (quarantineResetClock()) return;
      recoveryBuffering = false;
      recoveryProgress.reset();
      const next = video.currentTime;
      const advanced = Number.isFinite(next) && Math.abs(next - lastPosition) >= 0.05;
      if (advanced) lastPosition = next;
      sync({ started: true, paused: false });
      if (advanced) watchdog.noteProgress();
    };
    const onPlayForWatchdog = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && video.paused)) return;
      if (!active || !ownsSource(video) || backgroundBlocksPlayback(video) || suspendedRef.current ||
          exactHandoffPendingRef.current || pendingNativeHlsSeekRef.current != null || video.seeking || rendererSeekingRef.current) return;
      if (quarantineResetClock()) return;
      // A resumed play request can stall before playing. Keep its existing
      // deadline live without awarding readiness or healthy progress.
      sync({ paused: video.paused });
    };
    const onPause = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && !video.paused)) return;
      queueOwnedForegroundPlayback(); recoveryProgress.reset(); sync({ paused: true });
    };
    const onEndedForWatchdog = () => { if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && !video.ended)) return; clearReturnedPlayback(video); if (quarantineResetClock()) return; recoveryProgress.reset(); sync({ ended: true, paused: true }); };
    const onNativeControls = () => { if (ownsSource(video)) clearReturnedPlayback(video); };
    const onNativeFullscreen = () => { if (ownsSource(video) && document.fullscreenElement === video) clearReturnedPlayback(video); };
    const onWaiting = () => { if (!currentMediaEvent(video)) return; recoveryBuffering = true; recoveryProgress.reset(); };
    const onSeeking = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && !video.seeking)) return;
      clearReturnedPlayback(video);
      recoveryProgress.reset();
      rendererSeekingRef.current = true;
      sync({ seeking: true });
    };
    const onSeeked = () => {
      if (!active || !currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      recoveryProgress.reset();
      lastPosition = Number.isFinite(video.currentTime) ? video.currentTime : lastPosition;
      const frontier = bufferedFrontier();
      lastBufferedFrontier = Number.isFinite(frontier) ? frontier : lastPosition;
      if (video.error == null && Number.isFinite(video.currentTime) && !recoveryClockWasReset(video)) {
        lastObservedMediaTimeRef.current = video.currentTime;
      }
      rendererSeekingRef.current = false;
      const pending = pendingRecoverySeekFor(video);
      if (pending != null && video.error == null && !video.seeking &&
        Math.abs(video.currentTime + timelineOffsetRef.current - pending.position) <= 0.25) {
        pendingRecoverySeekRef.current = null;
      }
      sync({ seeking: scrubbingRef.current });
    };
    const onBufferProgress = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      if (quarantineResetClock()) return;
      const next = bufferedFrontier();
      if (!Number.isFinite(next)) {
        lastBufferedFrontier = Number.NaN;
        return;
      }
      if (!Number.isFinite(lastBufferedFrontier)) {
        lastBufferedFrontier = next;
        if (next > video.currentTime + 0.05) watchdog.noteProgress();
        return;
      }
      if (next < lastBufferedFrontier - 0.05) {
        lastBufferedFrontier = next;
        return;
      }
      if (next > lastBufferedFrontier + 0.05) {
        cancelForegroundIdleRecovery(video);
        lastBufferedFrontier = next;
        watchdog.noteProgress();
      }
    };
    const onClockProgress = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      if (quarantineResetClock()) return;
      if (Math.abs(video.currentTime - lastPosition) > 0.01) cancelForegroundIdleRecovery(video);
      const pending = pendingRecoverySeekFor(video);
      if (pending != null) {
        const healthy = active && ownsSource(video) && !terminalRecoveryOwns(video) &&
          video.error == null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          verifiedPlaybackProgressReportedRef.current && verifiedPlaybackPlayingRef.current &&
          !video.paused && !video.ended && !video.seeking && !scrubbingRef.current &&
          !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null && !recoveryBuffering &&
          !suspendedRef.current && !documentSuspendedRef.current && document.visibilityState !== "hidden";
        const next = video.currentTime;
        const absolute = next + timelineOffsetRef.current;
        // A seeked event can be missing or report a clamped position. Require
        // forward playback from a clock closer to this seek than its origin,
        // not an ignored backward seek's still-running old clock.
        if (healthy && Number.isFinite(next) &&
          (pending.healthyMediaTime != null || Math.abs(absolute - pending.position) <= 0.25 ||
            Math.abs(absolute - pending.position) < Math.abs(pending.originPosition - pending.position))) {
          if (pending.healthyMediaTime != null && next > pending.healthyMediaTime + 0.01 &&
            absolute >= pending.position - 0.25) {
            pendingRecoverySeekRef.current = null;
            rendererSeekingRef.current = false;
            sync({ seeking: scrubbingRef.current });
          } else {
            pending.healthyMediaTime = next;
          }
        } else {
          pending.healthyMediaTime = null;
        }
      }
      const eligible = active && ownsSource(video) && !terminalRecoveryOwns(video) &&
        video.error == null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        verifiedPlaybackProgressReportedRef.current && verifiedPlaybackPlayingRef.current &&
        !video.paused && !video.ended && !video.seeking && !rendererSeekingRef.current && !scrubbingRef.current &&
        !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null && !recoveryBuffering &&
        !suspendedRef.current && !documentSuspendedRef.current && document.visibilityState !== "hidden";
      if (recoveryProgress.note(performance.now(), video.currentTime, video.playbackRate, eligible)) {
        rearmHlsRecoveryRef.current?.(video);
        if (!recoveryProgressReported) recoveryProgressReported = onRecoveryPlaybackHealthyRef.current(video);
      }
      const next = video.currentTime;
      if (Number.isFinite(next) && Math.abs(next - lastPosition) >= 0.05) {
        lastPosition = next;
        sync({ started: true });
        watchdog.noteProgress();
      }
    };
    let pageHidden = false;
    const onDocumentLifecycle = () => {
      if (!active || !ownsSource(video)) return;
      const next = pageHidden || document.visibilityState === "hidden";
      const returning = documentSuspendedRef.current && !next;
      if (next === documentSuspendedRef.current &&
          (next || foregroundPlaybackRef.current?.video !== video)) return;
      documentSuspendedRef.current = next;
      if (next) cancelForegroundIdleRecovery(video);
      if (next && backgroundBlocksPlayback(video)) {
        const pause = preBackgroundPauseRef.current;
        preBackgroundPauseRef.current = null;
        const age = pause == null ? Number.NaN : performance.now() - pause.pausedAt;
        if (pause?.video === video && pause.source === url && playbackSourceRef.current === url &&
            pause.attempt === playbackAttemptRef.current && age >= 0 && age <= PRE_BACKGROUND_PAUSE_CORRELATION_MS &&
            video.paused && video.error == null && !video.ended && !video.controls && !video.seeking &&
            !rendererSeekingRef.current && !scrubbingRef.current && !suspendedRef.current &&
            !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null &&
            !terminalRecoveryOwns(video) && !nativeControlsOwnPlayback(video)) {
          // WebKit can pause just before reporting hidden. Correlate only this
          // imminent transition; an ordinary visible pause still takes effect.
          ownedPlaybackPausedRef.current = false;
        }
        video.autoplay = false;
        queueOwnedForegroundPlayback();
      }
      if (!next && quarantineResetClock()) return;
      recoveryProgress.reset();
      if (next && !ownedPlaybackPausedRef.current) backgroundPauseVideoRef.current = video;
      if (!next) {
        // Background wall time is not a playback stall. Rebaseline the owned
        // clock and grant a full foreground progress window on resume.
        lastPosition = Number.isFinite(video.currentTime) ? video.currentTime : lastPosition;
        lastBufferedFrontier = bufferedFrontier();
      }
      sync({
        paused: video.paused,
        seeking: video.seeking || rendererSeekingRef.current || scrubbingRef.current,
        ended: video.ended,
      });
      if (!next) watchdog.noteProgress();
      const pendingPlayback = foregroundPlaybackRef.current;
      if (!next && pendingPlayback?.video === video && pendingPlayback.source === url &&
          !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        applyOwnedPlayback(video, pendingPlayback.play);
      }
      if (returning) armForegroundIdleRecovery();
    };
    const onPageHide = () => { pageHidden = true; onDocumentLifecycle(); };
    const onPageShow = () => { pageHidden = false; onDocumentLifecycle(); };

    video.addEventListener("playing", onPlaying);
    for (const event of ["error", "enterpictureinpicture", "webkitbeginfullscreen", "webkitpresentationmodechanged"]) video.addEventListener(event, onNativeControls);
    document.addEventListener("fullscreenchange", onNativeFullscreen);
    video.addEventListener("play", onPlayForWatchdog);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("ended", onEndedForWatchdog);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", onClockProgress);
    video.addEventListener("progress", onBufferProgress);
    video.addEventListener("canplay", onDocumentLifecycle);
    video.addEventListener("loadeddata", onDocumentLifecycle);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onDocumentLifecycle);
    return () => {
      cancelForegroundIdleRecovery(video);
      active = false;
      recoveryProgress.reset();
      if (recoveryProgressWindowRef.current === recoveryProgress) recoveryProgressWindowRef.current = null;
      sync({ tearingDown: true });
      watchdog.stop();
      if (stallWatchdogRef.current === watchdog) stallWatchdogRef.current = null;
      video.removeEventListener("playing", onPlaying);
      for (const event of ["error", "enterpictureinpicture", "webkitbeginfullscreen", "webkitpresentationmodechanged"]) video.removeEventListener(event, onNativeControls);
      document.removeEventListener("fullscreenchange", onNativeFullscreen);
      video.removeEventListener("play", onPlayForWatchdog);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("ended", onEndedForWatchdog);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onClockProgress);
      video.removeEventListener("progress", onBufferProgress);
      video.removeEventListener("canplay", onDocumentLifecycle);
      video.removeEventListener("loadeddata", onDocumentLifecycle);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onDocumentLifecycle);
    };
  }, [applyOwnedPlayback, cancelForegroundIdleRecovery, clearReturnedPlayback, sourceIdentity, url]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    didSeekRef.current = false;
    recoverySeekSequenceRef.current += 1;
    pendingRecoverySeekRef.current = null;
    explicitInitialSeekRef.current = null;
    exactHandoffPendingRef.current = requiresExactHandoffRef.current;
    pendingHandoffPlaybackIntentRef.current = null;
    verifiedPlaybackProgressReportedRef.current = false;
    verifiedPlaybackPlayingRef.current = false;
    ownedPlaybackPausedRef.current = sourceSwitchStateRef.current?.paused ?? false;
    explicitPlaybackIntentRef.current = false;
    preBackgroundPauseRef.current = null;
    backgroundPauseVideoRef.current = null;
    lastObservedMediaTimeRef.current = !sourceLoadRef.current.started ? 0 : Number.isFinite(video.currentTime)
      ? video.currentTime
      : 0;
    onSourceSizeRef.current(null);

    const report = () => {
      const offset = timelineOffsetRef.current;
      onProgressRef.current?.(
        video.currentTime + offset,
        absoluteDurationFor(video.duration),
        {
        preferredAudioId: audioPreferenceRef.current.id,
        preferredAudioLang: audioPreferenceRef.current.language,
        playbackSpeed:
          Number.isFinite(video.playbackRate) && video.playbackRate > 0
            ? video.playbackRate
            : 1,
        subtitlePosition: subtitlePositionRef.current,
        },
      );
    };
    const exactTarget = () => Math.max(0, explicitInitialSeekRef.current ?? startPositionRef.current ?? 0);
    const targetIsAvailable = (target: number) => {
      for (let index = 0; index < video.seekable.length; index += 1) {
        if (
          target >= video.seekable.start(index) - 0.25 &&
          target <= video.seekable.end(index) + 0.25
        ) {
          return true;
        }
      }
      return video.seekable.length === 0 &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        target <= video.duration + 0.25;
    };
    const targetWasReached = (target: number) =>
      Number.isFinite(video.currentTime) && Math.abs(video.currentTime - target) <= 0.25;
    const finishExactHandoff = () => {
      if (!exactHandoffPendingRef.current) return;
      exactHandoffPendingRef.current = false;
      didSeekRef.current = true;
      startupReadyRef.current = true;
      setPlaybackStatus(null);
      const handoff = sourceSwitchStateRef.current;
      const pendingIntent = pendingHandoffPlaybackIntentRef.current;
      const shouldPlay = pendingIntent === "play" ||
        (pendingIntent == null && handoff?.paused !== true);
      if (suspendedRef.current) {
        setPaused(!shouldPlay);
        setPlaying(shouldPlay);
        onPausedChange(!shouldPlay);
        pendingHandoffPlaybackIntentRef.current = shouldPlay ? "play" : "pause";
        return;
      }
      pendingHandoffPlaybackIntentRef.current = null;
      applyDeferredHandoffPlayback(video, shouldPlay);
    };
    const confirmExactHandoff = () => {
      if (!exactHandoffPendingRef.current) return true;
      const target = exactTarget();
      if (
        video.seeking ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !targetIsAvailable(target) ||
        !targetWasReached(target)
      ) return false;
      finishExactHandoff();
      return true;
    };
    const onTimeUpdate = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      // A failed decoder's reset clock is not confirmed playback or history.
      if (video.error != null) return;
      // A decoder reset is not an owned seek to zero or a new resume decision.
      // Requested zero/backward seeks retain their sequence until confirmation.
      if (recoveryClockWasReset(video)) return;
      if (pendingNativeHlsSeekRef.current != null && !confirmPendingNativeHlsSeek(video)) {
        setPlaybackStatus("seeking");
        video.pause();
        return;
      }
      if (exactHandoffPendingRef.current && !confirmExactHandoff()) {
        setPlaybackStatus("seeking");
        video.pause();
        return;
      }
      // An initial media clock is not yet the saved resume decision. A
      // committed user seek claims that decision, including an explicit zero.
      if (!didSeekRef.current && (startPositionRef.current ?? 0) > 5) return;
      // Actual clock progress is stronger readiness evidence than a successful
      // play() dispatch and covers WebViews that omit an early canplay event.
      if (video.currentTime > 0) {
        startupReadyRef.current = true;
      }
      onAbsolutePositionChange(video.currentTime + timelineOffsetRef.current);
      const previousMediaTime = lastObservedMediaTimeRef.current;
      if (!video.paused && video.currentTime > previousMediaTime + 0.01 && preBackgroundPauseRef.current?.video === video) {
        preBackgroundPauseRef.current = null;
      }
      const returnedPlayback = foregroundPlaybackRef.current;
      if (returnedPlayback?.video === video && returnedPlayback.source === url &&
          returnedPlayback.returnedPosition != null && video.currentTime > returnedPlayback.returnedPosition + 0.01 &&
          !video.paused && !video.seeking && !rendererSeekingRef.current && !scrubbingRef.current &&
          !suspendedRef.current && !backgroundBlocksPlayback(video)) clearReturnedPlayback(video);
      lastObservedMediaTimeRef.current = video.currentTime;
      if (!video.paused && !documentSuspendedRef.current && document.visibilityState !== "hidden") {
        backgroundPauseVideoRef.current = null;
      }
      if (
        !verifiedPlaybackProgressReportedRef.current &&
        verifiedPlaybackPlayingRef.current &&
        !video.paused &&
        video.currentTime > previousMediaTime + 0.01
      ) {
        verifiedPlaybackProgressReportedRef.current = true;
        onVerifiedPlaybackProgress();
      }
      scrubberRef.current?.setCurrentTime(
        knownAbsoluteDurationRef.current == null
          ? video.currentTime
          : video.currentTime + timelineOffsetRef.current,
      );
      if (video.currentTime < previousPositionRef.current - 2) {
        upNextDismissedRef.current = false;
        setUpNextDismissed(false);
      }
      previousPositionRef.current = video.currentTime;
      if (Number.isFinite(video.duration) && video.duration > 0 &&
          video.currentTime >= video.duration - 300) {
        setCurrentPosition((current) =>
          Math.floor(current) === Math.floor(video.currentTime) ? current : video.currentTime,
        );
      }
      const wholeSecond = Math.floor(video.currentTime);
      if (wholeSecond !== lastClockSecondRef.current) {
        lastClockSecondRef.current = wholeSecond;
        if (clockRef.current != null) {
          const offset = timelineOffsetRef.current;
          clockRef.current.textContent = `${clockLabel(video.currentTime + offset)} / ${durationClockLabel(absoluteDurationFor(video.duration))}`;
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
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_METADATA) || didSeekRef.current) return;
      const start = explicitInitialSeekRef.current ?? startPositionRef.current ?? 0;
      const recoveryHandoff = requiresExactHandoffRef.current;
      if (recoveryHandoff) {
        if (confirmExactHandoff()) return;
        setPlaybackStatus("seeking");
        video.pause();
        // Native WebKit HLS gets its exact initial position through a temporal
        // media fragment. Let WebKit apply that fragment once current data is
        // available instead of issuing an earlier seek that HLS startup can
        // overwrite with the live edge.
        if (nativeExactHlsFragmentRef.current) return;
        // Readiness events can arrive before an accepted seek finishes. Let it
        // settle before retrying; seeked can still retry a clamped wrong target.
        if (video.seeking) return;
        if (!targetIsAvailable(start)) return;
        try {
          video.currentTime = start;
          // A live EVENT playlist may clamp an early seek. Only seeked or a
          // later clock event can confirm the exact target and finish handoff.
        } catch {
          // Retry as the live seekable range grows.
        }
        return;
      }
      if (!recoveryHandoff && start <= 5) {
        didSeekRef.current = true; // nothing meaningful to resume to
        return;
      }
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (d <= 0) return; // duration unknown yet (HLS) - retry on durationchange
      if (!recoveryHandoff && start >= d - 10) {
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
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_METADATA)) return;
      if (Number.isFinite(video.duration)) {
        setDuration(video.duration);
        const sourceDuration = video.duration + timelineOffsetRef.current;
        if (sourceDuration > 0) onSourceDurationKnownRef.current?.(sourceDuration);
      }
      if (clockRef.current != null) {
        const offset = timelineOffsetRef.current;
        clockRef.current.textContent = `${clockLabel(video.currentTime + offset)} / ${durationClockLabel(absoluteDurationFor(video.duration))}`;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      onSourceSizeRef.current(
        width > 0 && height > 0 ? { width, height } : null,
      );
      applyResume();
    };
    const onDurationChange = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_METADATA)) return;
      if (Number.isFinite(video.duration)) {
        setDuration(video.duration);
        const sourceDuration = video.duration + timelineOffsetRef.current;
        if (sourceDuration > 0) onSourceDurationKnownRef.current?.(sourceDuration);
      }
      applyResume();
    };
    const onSeekedForResume = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      if (pendingNativeHlsSeekRef.current != null) {
        confirmPendingNativeHlsSeek(video);
        if (pendingNativeHlsSeekRef.current != null) return;
      }
      if (!confirmExactHandoff()) applyResume();
    };
    const onProgressForResume = () => applyResume();
    const progressPct = () => {
      const offset = timelineOffsetRef.current;
      return playbackProgressPct(
        video.currentTime + offset,
        absoluteDurationFor(video.duration) ?? Number.NaN,
      );
    };
    const onVideoEnded = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && !video.ended)) return;
      // A queued EOS from this failed reader cannot complete or advance its title.
      if (terminalRecoveryOwns(video)) return;
      if (exactHandoffPendingRef.current) {
        applyResume();
        return;
      }
      const absolutePosition = video.currentTime + timelineOffsetRef.current;
      const absoluteDuration = absoluteDurationFor(video.duration);
      if (
        (optimizedTimelineIsPartial && absoluteDuration == null) ||
        (absoluteDuration != null && absolutePosition < absoluteDuration - 10)
      ) {
        if (recoverTerminalPlayback(video)) return;
        onAbsolutePositionChange(absolutePosition);
        onPlaybackErrorRef.current(
          optimizedTimelineIsPartial
            ? "Server Optimized ended before the original media completed."
            : "Playback ended before the original media completed.",
          false,
        );
        return;
      }
      // An ended event is also conclusive evidence that this source became
      // playable, including very short clips that never advanced a whole tick.
      startupReadyRef.current = true;
      setPlaybackStatus(null);
      const terminalProgress = {
        playbackSpeed: video.playbackRate,
        subtitlePosition: subtitlePositionRef.current,
      };
      if (onEndedRef.current != null) {
        onEndedRef.current(
          absolutePosition,
          absoluteDuration,
          terminalProgress,
        );
      } else {
        report();
      }
      setEnded(true);
      setPlaying(false);
      if (
        autoCountdownRef.current &&
        upNextWarningShownRef.current &&
        !upNextDismissedRef.current &&
        !autoAdvanceFiredRef.current
      ) {
        autoAdvanceFiredRef.current = true;
        onPlayNextForEndRef.current?.();
      }
      if (scrobbleContext != null) scrobblePlaybackStop(scrobbleContext, progressPct());
    };
    const onPause = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && !video.paused)) return;
      const returnedPlayback = foregroundPlaybackRef.current;
      const retainsReturnedPlay = returnedPlayback?.video === video && returnedPlayback.source === url &&
        playbackSourceRef.current === url && returnedPlayback.play && returnedPlayback.returnedPosition != null;
      if (!retainsReturnedPlay && video.error == null && !video.ended && !suspendedRef.current &&
          !documentSuspendedRef.current && document.visibilityState !== "hidden" &&
          backgroundPauseVideoRef.current !== video && !recoveryClockWasReset(video) &&
          !video.seeking && !rendererSeekingRef.current &&
          !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null) {
        if (!ownedPlaybackPausedRef.current && verifiedPlaybackPlayingRef.current && verifiedPlaybackProgressReportedRef.current &&
            playbackSourceRef.current === url && !terminalRecoveryOwns(video) &&
            !scrubbingRef.current && !video.controls && !nativeControlsOwnPlayback(video)) {
          preBackgroundPauseRef.current = { video, source: url, attempt: playbackAttemptRef.current, pausedAt: performance.now() };
        }
        ownedPlaybackPausedRef.current = true;
      }
      verifiedPlaybackPlayingRef.current = false;
      if (returnedPlayback?.video === video && returnedPlayback.source === url && returnedPlayback.play &&
          returnedPlayback.returnedPosition != null && !ownedPlaybackPausedRef.current && video.error == null &&
          !video.ended && !video.seeking && !rendererSeekingRef.current && !scrubbingRef.current &&
          !exactHandoffPendingRef.current && pendingNativeHlsSeekRef.current == null &&
          !suspendedRef.current && !backgroundBlocksPlayback(video) && !nativeControlsOwnPlayback(video) &&
          !recoveryClockWasReset(video) && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        applyDeferredHandoffPlayback(video, true);
        return;
      }
      if (pendingNativeHlsSeekRef.current != null) {
        setPaused(true);
        setPlaying(false);
        onPausedChange(true);
        return;
      }
      if (terminalRecoveryOwns(video)) {
        const wantsPlay = !ownedPlaybackPausedRef.current;
        setPaused(!wantsPlay);
        setPlaying(wantsPlay);
        onPausedChange(!wantsPlay);
        return;
      }
      if (exactHandoffPendingRef.current || foregroundPlaybackRef.current?.video === video) {
        const pendingIntent = pendingHandoffPlaybackIntentRef.current;
        const shouldPlay = pendingIntent === "play" ||
          (pendingIntent == null && sourceSwitchStateRef.current?.paused !== true);
        setPaused(!shouldPlay);
        setPlaying(shouldPlay);
        onPausedChange(!shouldPlay);
        return;
      }
      setPaused(true);
      setPlaying(false);
      onPausedChange(true);
      if (!video.ended && scrobbleContext != null) {
        scrobblePlaybackPause(scrobbleContext, progressPct());
      }
    };
    const onPlay = () => {
      if (!currentMediaEvent(video) || (sourceLoadRef.current.reused && video.paused)) return;
      if (preBackgroundPauseRef.current?.video === video) preBackgroundPauseRef.current = null;
      if (terminalRecoveryOwns(video)) {
        if (!video.paused) video.pause();
        return;
      }
      if (video.error == null && !documentSuspendedRef.current && document.visibilityState !== "hidden") {
        ownedPlaybackPausedRef.current = false;
      }
      if (
        suspendedRef.current ||
        exactHandoffPendingRef.current ||
        pendingNativeHlsSeekRef.current != null
      ) {
        video.pause();
        if (pendingNativeHlsSeekRef.current != null) {
          setPaused(true);
          setPlaying(false);
          onPausedChange(true);
          setPlaybackStatus("seeking");
        } else if (exactHandoffPendingRef.current) {
          const pendingIntent = pendingHandoffPlaybackIntentRef.current;
          const shouldPlay = pendingIntent === "play" ||
            (pendingIntent == null && sourceSwitchStateRef.current?.paused !== true);
          setPaused(!shouldPlay);
          setPlaying(shouldPlay);
          onPausedChange(!shouldPlay);
          setPlaybackStatus("seeking");
        }
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
      if (!ownsSource(video)) return;
      if (video.volume > 0) lastAudibleVolumeRef.current = video.volume;
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onRateChange = () => { if (ownsSource(video)) setPlaybackRate(video.playbackRate); };
    const onLoadStart = () => {
      if (!ownsSource(video)) return;
      const load = sourceLoadRef.current;
      if (!load.started && load.expected != null) {
        try {
          const actual = new URL(video.currentSrc), expected = new URL(load.expected);
          actual.hash = ""; expected.hash = "";
          if (actual.href === expected.href) load.started = true;
        } catch { /* Wait for the current native resource selection. */ }
      }
      if (mediaEventsCurrent(video)) setPlaybackStatus(exactHandoffPendingRef.current ? "seeking" : "starting");
    };
    // Network stalled can occur while buffered media is still playing. Keep
    // readiness unchanged until waiting actually reports buffer starvation.
    const onWaiting = () => { if (currentMediaEvent(video)) setPlaybackStatus(
      exactHandoffPendingRef.current ? "seeking" : "buffering",
    ); };
    const onPlaying = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA) ||
          (sourceLoadRef.current.reused && video.paused) || video.error != null || terminalRecoveryOwns(video)) return;
      if (exactHandoffPendingRef.current || pendingNativeHlsSeekRef.current != null) {
        video.pause();
        setPlaybackStatus("seeking");
        return;
      }
      if (preBackgroundPauseRef.current?.video === video) preBackgroundPauseRef.current = null;
      verifiedPlaybackPlayingRef.current = true;
      if (Number.isFinite(video.currentTime) && !recoveryClockWasReset(video)) {
        lastObservedMediaTimeRef.current = video.currentTime;
      }
      startupReadyRef.current = true;
      setPlaybackStatus(null);
    };
    const onCanPlay = () => {
      if (!currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      if (exactHandoffPendingRef.current || pendingNativeHlsSeekRef.current != null) {
        setPlaybackStatus("seeking");
        return;
      }
      startupReadyRef.current = true;
      setPlaybackStatus(null);
    };
    const handoff = sourceSwitchStateRef.current;
    if (handoff != null) {
      video.volume = Math.min(1, Math.max(0, handoff.volume));
      video.muted = handoff.muted;
      applyMediaPlaybackRate(video, handoff.playbackRate);
    }
    const preferences = playerPreferencesRef.current;
    const perTitlePrefs = preferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs;
    const preferredRate = perTitlePrefs?.playbackSpeed ?? preferences?.defaultPlaybackSpeed;
    if (
      handoff == null &&
      preferredRate != null &&
      Number.isFinite(preferredRate) &&
      preferredRate >= 0.5 &&
      preferredRate <= 2
    ) {
      applyMediaPlaybackRate(video, preferredRate);
    }
    const configuredVolume = preferences?.defaultVolume;
    if (handoff == null && configuredVolume != null && Number.isFinite(configuredVolume)) {
      const volumePercent = Math.round(Math.min(100, Math.max(0, configuredVolume)));
      video.volume = volumePercent / 100;
      video.muted = volumePercent === 0;
    }
    const attemptAutoplay = () => {
      if (
        !currentMediaEvent(video, HTMLMediaElement.HAVE_CURRENT_DATA) ||
        autoplayAttemptedRef.current ||
        suspendedRef.current ||
        exactHandoffPendingRef.current ||
        pendingNativeHlsSeekRef.current != null
      ) return;
      const pending = foregroundPlaybackRef.current;
      const intent = pendingHandoffPlaybackIntentRef.current;
      const shouldPlay = pending?.video === video && pending.source === url ? pending.play
        : intent === "play" ? true : intent === "pause" ? false : sourceSwitchStateRef.current?.paused !== true;
      // Stream resolution is asynchronous, so some browsers no longer treat
      // the later player mount as part of the original click. Retry explicitly
      // when media is playable. If policy still blocks it, the Play control is
      // already visible and no external-player decision interrupts the flow.
      applyOwnedPlayback(video, shouldPlay);
    };
    setEnded(false); // a new URL is a new playback - clear any stale end state
    setCurrentPosition(0);
    previousPositionRef.current = 0;
    upNextDismissedRef.current = false;
    upNextWarningShownRef.current = false;
    autoAdvanceFiredRef.current = false;
    setUpNextDismissed(false);
    lastClockSecondRef.current = -1;
    setPaused(handoff?.paused ?? false);
    setPlaying(handoff != null && !handoff.paused);
    onVolumeChange();
    onPausedChange(handoff?.paused ?? false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    video.addEventListener("loadeddata", applyResume);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("seeked", onSeekedForResume);
    video.addEventListener("progress", onProgressForResume);
    video.addEventListener("canplay", applyResume);
    video.addEventListener("canplay", attemptAutoplay);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onVideoEnded);
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ratechange", onRateChange);
    return () => {
      if (preBackgroundPauseRef.current?.video === video) preBackgroundPauseRef.current = null;
      const pendingPlayback = foregroundPlaybackRef.current;
      if (pendingPlayback?.video === video && pendingPlayback.source === url) foregroundPlaybackRef.current = null;
      pendingHandoffPlaybackIntentRef.current = null;
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMeta);
      video.removeEventListener("loadeddata", applyResume);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("seeked", onSeekedForResume);
      video.removeEventListener("progress", onProgressForResume);
      video.removeEventListener("canplay", applyResume);
      video.removeEventListener("canplay", attemptAutoplay);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("ended", onVideoEnded);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ratechange", onRateChange);
      if (
        committedSourceRef.current === sourceIdentity &&
        !exactHandoffPendingRef.current &&
        onProgressRef.current != null &&
        video.currentTime > 0
      ) report();
      if (committedSourceRef.current === sourceIdentity && scrobbleContext != null) scrobblePlaybackStop(scrobbleContext, progressPct());
    };
  }, [
    applyDeferredHandoffPlayback,
    applyOwnedPlayback,
    clearReturnedPlayback,
    confirmPendingNativeHlsSeek,
    onAbsolutePositionChange,
    onPausedChange,
    onVerifiedPlaybackProgress,
    scrobbleContext,
    sourceIdentity,
    url,
  ]);

  useEffect(() => {
    startupReadyRef.current = false;
    setPlaybackStatus(exactHandoffPendingRef.current ? "seeking" : "starting");
  }, [sourceIdentity, url]);

  useEffect(() => {
    if (suspended || startupReadyRef.current) return;
    const timeoutMs = webviewStartupTimeout(engine, url);
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active || suspendedRef.current || startupReadyRef.current) return;
      onPlaybackErrorRef.current(
        "Playback did not become ready. Retry playback, choose another source, or open this stream externally.",
        exactHandoffPendingRef.current,
      );
    }, timeoutMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [engine, sourceIdentity, suspended, url]);

  const needsServerPreparation = isHls && serverOptimized != null && isTrustedServerHlsManifestURL(url);
  const [initialLeasePreparation, setInitialLeasePreparation] = useState<{ source: string; identity: typeof sourceIdentity; target: string | null } | null>(null);
  const leasePreparationReady = !needsServerPreparation || preparedLeaseTarget !== undefined || (initialLeasePreparation?.source === url && initialLeasePreparation.identity === sourceIdentity);
  const leaseTarget = preparedLeaseTarget !== undefined
    ? preparedLeaseTarget
    : (initialLeasePreparation?.source === url && initialLeasePreparation.identity === sourceIdentity) ? initialLeasePreparation.target : null;
  const leaseExpiredCallbackRef = useRef(onServerLeaseExpired);
  useLayoutEffect(() => {
    leaseExpiredCallbackRef.current = onServerLeaseExpired;
  }, [onServerLeaseExpired]);
  const stopLeaseRef = useRef<() => void>(() => {});
  const leaseLastAttemptRef = useRef<{ target: string; at: number } | null>(null);

  useEffect(() => {
    if (!needsServerPreparation || preparedLeaseTarget !== undefined) return;
    const video = videoRef.current;
    if (video == null) return;
    const controller = new AbortController();
    let active = true;
    const owns = () => active && !controller.signal.aborted && ownsSource(video);
    const deadline = Date.now() + SERVER_HLS_STARTUP_TIMEOUT_MS;
    void (async () => {
      let delay = SERVER_OPTIMIZED_RETRY_BASE_MS;
      while (owns()) {
        const response = await promiseWithinTimeout(fetch(url, {
          credentials: "include", cache: "no-store", redirect: "error",
          headers: { accept: "application/vnd.apple.mpegurl" }, signal: controller.signal,
        }), Math.max(1, deadline - Date.now()), "Server optimized playback timed out.", () => controller.abort());
        if (!owns()) return;
        if ((response.status === 503 || response.status === 504) && Date.now() < deadline) {
          await abortableDelay(Math.min(delay, Math.max(1, deadline - Date.now())), controller.signal);
          delay = Math.min(delay * 2, SERVER_OPTIMIZED_RETRY_MAX_MS);
          if (Date.now() >= deadline) throw new Error("Server optimized playback timed out.");
          continue;
        }
        if (!response.ok) throw new Error(`The server could not prepare playback (${response.status}).`);
        const manifest = await promiseWithinTimeout(response.text(), Math.max(1, deadline - Date.now()),
          "Server optimized playback timed out.", () => controller.abort());
        if (!owns()) return;
        if (!manifest.startsWith("#EXTM3U")) throw new Error("The server did not return a playable HLS manifest.");
        setInitialLeasePreparation({ source: url, identity: sourceIdentity, target: serverHlsLeaseTarget(url, manifest) });
        return;
      }
    })().catch((error: unknown) => {
      if (active && ownsSource(video)) {
        onPlaybackErrorRef.current(error instanceof Error ? error.message : "Server playback preparation failed.", exactHandoffPendingRef.current);
      }
    });
    return () => { active = false; controller.abort(); };
  }, [needsServerPreparation, preparedLeaseTarget, sourceIdentity, url]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null || !leasePreparationReady || leaseTarget == null || suspended || ended || serverOptimizationPending) return;
    let active = true;
    let dormant = false;
    let terminal = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let lastAttempt = leaseLastAttemptRef.current?.target === leaseTarget
      ? leaseLastAttemptRef.current.at : -Infinity;
    const owns = () => active && ownsSource(video);
    const stop = () => {
      terminal = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
    stopLeaseRef.current = stop;
    const expired = () => {
      if (!owns()) return;
      stop();
      const snapshot = captureRecoverySnapshot(video);
      leaseExpiredCallbackRef.current(url, snapshot.position, snapshot.state);
    };
    const renew = async () => {
      if (!owns() || dormant || terminal || controller != null) return;
      window.clearTimeout(timer);
      const remaining = 30_000 - (Date.now() - lastAttempt);
      if (remaining > 0) { timer = window.setTimeout(() => void renew(), remaining); return; }
      lastAttempt = Date.now();
      leaseLastAttemptRef.current = { target: leaseTarget, at: lastAttempt };
      const request = new AbortController();
      controller = request;
      try {
        const status = await promiseWithinTimeout(renewServerHlsLease(leaseTarget, request.signal),
          5_000, "Stream retention timed out.", () => request.abort());
        if (!owns() || dormant || terminal || request.signal.aborted) return;
        if (status === 401) { stop(); notifyUnauthorized(); }
        else if (status === 404 || status === 403) expired();
        else if (status === 405) stop(); // Older reverse proxies can omit HEAD support.
      } catch {
        // A transient failure never polls the master, reloads media or bypasses the cadence.
      } finally {
        if (controller === request) controller = null;
        if (owns() && !dormant && !terminal) timer = window.setTimeout(() => void renew(), Math.max(0, 30_000 - (Date.now() - lastAttempt)));
      }
    };
    const onPageHide = () => { dormant = true; window.clearTimeout(timer); controller?.abort(); };
    const onPageShow = () => { dormant = false; void renew(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void renew(); };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    void renew();
    return () => {
      active = false;
      stop();
      if (stopLeaseRef.current === stop) stopLeaseRef.current = () => {};
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ended, leasePreparationReady, leaseTarget, serverOptimizationPending, sourceIdentity, suspended, url]);

  // Wire hls.js for HLS streams when the browser can't play them natively.
  useEffect(() => {
    const video = videoRef.current;
    if (video == null || !leasePreparationReady) return;
    nativeExactHlsFragmentRef.current = false;
    const forceReload = assignedSourceRef.current != null && assignedSourceRef.current.source !== sourceIdentity && assignedSourceRef.current.url === url;
    assignedSourceRef.current = { source: sourceIdentity, url };
    const assignNativeSource = (sourceUrl: string) => {
      if (!ownsSource(video)) return;
      sourceLoadRef.current.expected = sourceUrl;
      if (video.src !== sourceUrl) video.src = sourceUrl;
      if (forceReload) video.load();
    };

    if (!isHls) {
      setNativeHlsPlayback(false);
      // Only (re)assign on an actual URL change - reassigning the same src
      // invokes the media load algorithm and restarts playback from 0.
      assignNativeSource(url);
      return;
    }
    if (shouldUseNativeHls(video)) {
      setNativeHlsPlayback(true);
      // WKWebView/Safari owns HLS loading here. Make its manifest and segment
      // requests use the authenticated webview cookie jar, not URL credentials.
      if (isTrustedServerStreamURL(url)) {
        video.crossOrigin = "use-credentials";
      } else {
        video.removeAttribute("crossorigin");
      }
      const sourceUrl = requiresExactHandoffRef.current
        ? nativeHlsSourceWithExactStart(url, startPositionRef.current)
        : url;
      nativeExactHlsFragmentRef.current = requiresExactHandoffRef.current;
      assignNativeSource(sourceUrl);
      return;
    }

    // hls.js is ~151 KB gz and is reachable ONLY here: an .m3u8 the browser
    // cannot play natively. A static import pinned it into this chunk, so every
    // player open paid for it - including the native-mpv and direct-file paths
    // that return above and never touch it. Fetch it on demand instead.
    let cancelled = false;
    let instance: HlsInstance | null = null;
    let removeCaptionListeners = () => {};
    let rearmRecovery: ((video: HTMLVideoElement) => void) | null = null;
    setNativeHlsPlayback(false);
    appliedHlsAudioPreferenceRef.current = false;
    setHlsAudioInventoryKnown(false);
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
        matchLanguage(sourceSwitchStateRef.current?.audioPreference?.language) ??
        (sourceSwitchStateRef.current?.audioPreference?.language == null
          ? tracks.find((track) => track.id === sourceSwitchStateRef.current?.audioPreference?.id)
          : null) ??
        matchLanguage(perTitlePrefs?.preferredAudioLang) ??
        matchLanguage(preferences?.defaultAudioLanguage);
      if (match == null) return;
      appliedHlsAudioPreferenceRef.current = true;
      instance.audioTrack = match.index;
      setHlsAudioTrack(match.index);
      if (!serverAudioModeRef.current) {
        audioPreferenceRef.current = {
          id: match.id,
          language: match.language,
        };
      }
    };
    void import("hls.js").then(({ default: Hls }) => {
      // The effect can be torn down (or the URL swapped) while the chunk is in
      // flight; without this we would attach a player to a stale <video>.
      if (cancelled || committedSourceRef.current !== sourceIdentity) return;
      const element = videoRef.current;
      if (element == null || !ownsSource(element)) return;
      if (!Hls.isSupported()) {
        if (element.canPlayType("application/vnd.apple.mpegurl") !== "") {
          setNativeHlsPlayback(true);
          if (isTrustedServerStreamURL(url)) {
            element.crossOrigin = "use-credentials";
          } else {
            element.removeAttribute("crossorigin");
          }
          const sourceUrl = requiresExactHandoffRef.current
            ? nativeHlsSourceWithExactStart(url, startPositionRef.current)
            : url;
          nativeExactHlsFragmentRef.current = requiresExactHandoffRef.current;
          assignNativeSource(sourceUrl);
          return;
        }
        onPlaybackErrorRef.current(
          "This browser cannot play HLS. Try an external player or choose another source.",
          exactHandoffPendingRef.current,
        );
        return;
      }
      // Bound the media buffers - hls.js defaults to backBufferLength: Infinity,
      // which retains every played segment: a 2h stream grows to GBs in the
      // WebContent process. 60s behind + 30s (up to 120s) ahead keeps seeks snappy
      // without the balloon.
      const manifestTimeoutMs = webviewStartupTimeout(engine, url);
      const configuredStartPosition = startPositionRef.current;
      // hls.js uses -1 as live-edge startup for EVENT playlists. An exact
      // handoff instead owns its local target, including a target of zero.
      const exactHlsStartPosition = requiresExactHandoffRef.current
        ? Number.isFinite(configuredStartPosition)
          ? Math.max(0, configuredStartPosition as number)
          : 0
        : null;
      instance = new Hls({
        ...(exactHlsStartPosition == null
          ? {}
          : { startPosition: exactHlsStartPosition }),
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: manifestTimeoutMs,
            maxLoadTimeMs: manifestTimeoutMs,
            timeoutRetry: null,
            errorRetry: null,
          },
        },
        // Server Mode may be a different HTTPS origin from the installed app.
        // Manifest and segment requests must carry the app session and, when
        // present, the Cloudflare Access browser cookie.
        xhrSetup: (xhr, requestUrl) => {
          xhr.withCredentials = isTrustedServerStreamURL(requestUrl ?? url);
        },
      });
      hlsRef.current = instance;
      const ownedInstance = instance;
      instance.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!cancelled && ownsSource(element) && hlsRef.current === ownedInstance) sourceLoadRef.current.started = true;
      });
      rearmRecovery = (video) => {
        if (cancelled || video !== element || !ownsSource(element) ||
            hlsRef.current !== ownedInstance || retryTimer != null) return;
        recovery.networkRetries = 0;
        recovery.mediaRecoveries = 0;
      };
      rearmHlsRecoveryRef.current = rearmRecovery;
      const refreshCaptions = () => {
        if (!cancelled && ownsSource(element) && hlsRef.current === instance) captionControllerRef.current?.refresh();
      };
      instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshCaptions);
      instance.on(Hls.Events.SUBTITLE_TRACK_SWITCH, refreshCaptions);
      const captionInstance = instance;
      removeCaptionListeners = () => {
        captionInstance.off(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshCaptions);
        captionInstance.off(Hls.Events.SUBTITLE_TRACK_SWITCH, refreshCaptions);
      };
      refreshCaptions();
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled || !data.fatal || instance == null || hlsRef.current !== instance || !ownsSource(element)) return;
        // Each fault must earn a fresh contiguous healthy window, not reuse
        // playback credit accumulated before this recovery attempt.
        recoveryProgressWindowRef.current?.reset();
        const action = nextHlsRecovery(data.type, recovery);
        if (action === "retry-network") {
          recovery.networkRetries += 1;
          recordDiagnostic("player", "hls.network_recovery", "warning");
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(
            () => {
              retryTimer = undefined;
              if (cancelled || instance == null || hlsRef.current !== instance || !ownsSource(element)) return;
              if (
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
              ) {
                instance?.loadSource(url);
              } else {
                instance?.startLoad();
              }
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
        stopLeaseRef.current();
        recordDiagnostic("player", "hls.fatal", "error", data.type);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverTerminalPlayback(element)) return;
        onPlaybackErrorRef.current(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "The stream stopped responding after two retries. Try again or choose another stream."
            : "The stream could not be decoded. Try again or choose another stream.",
          exactHandoffPendingRef.current,
        );
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled || !ownsSource(element) || hlsRef.current !== ownedInstance) return;
        refreshCaptions();
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
          id: String(index),
          label: audioTrackLabel(track.name, track.lang, `Audio ${index + 1}`),
          language: track.lang ?? null,
        })) ?? [];
        setHlsAudioInventoryKnown(true);
        setHlsAudioTracks(audioChoices);
        applyHlsAudioPreference(audioChoices);
        setHlsLevel(instance?.currentLevel ?? -1);
        const selectedAudioTrack = instance?.audioTrack ?? -1;
        setHlsAudioTrack(selectedAudioTrack);
        const selectedAudioChoice = audioChoices.find(
          (track) => track.index === selectedAudioTrack,
        );
        if (selectedAudioChoice != null) {
          if (!serverAudioModeRef.current) {
            audioPreferenceRef.current = {
              id: selectedAudioChoice.id,
              language: selectedAudioChoice.language,
            };
          }
        }
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        if (cancelled || !ownsSource(element) || hlsRef.current !== ownedInstance) return;
        setHlsLevel(data.level);
      });
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (cancelled || !ownsSource(element) || hlsRef.current !== ownedInstance) return;
        const audioChoices = instance?.audioTracks.map((track, index) => ({
          index,
          id: String(index),
          label: audioTrackLabel(track.name, track.lang, `Audio ${index + 1}`),
          language: track.lang ?? null,
        })) ?? [];
        setHlsAudioInventoryKnown(true);
        setHlsAudioTracks(audioChoices);
        applyHlsAudioPreference(audioChoices);
      });
      instance.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        if (cancelled || !ownsSource(element) || hlsRef.current !== ownedInstance) return;
        setHlsAudioTrack(data.id);
        const selected = instance?.audioTracks[data.id];
        if (!serverAudioModeRef.current) {
          audioPreferenceRef.current = {
            id: String(data.id),
            language: selected?.lang ?? null,
          };
        }
      });
      instance.loadSource(url);
      instance.attachMedia(element);
    }).catch(() => {
      if (!cancelled) {
        onPlaybackErrorRef.current(
          "The HLS player could not be loaded. Retry playback or open this stream externally.",
          exactHandoffPendingRef.current,
        );
      }
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      if (rearmHlsRecoveryRef.current === rearmRecovery) rearmHlsRecoveryRef.current = null;
      removeCaptionListeners();
      instance?.destroy();
      if (hlsRef.current === instance) hlsRef.current = null;
      setHlsLevels([]);
      setHlsAudioTracks([]);
      setHlsAudioInventoryKnown(false);
    };
  }, [engine, sourceIdentity, url, isHls, leasePreparationReady]);

  const beginConfirmedNativeHlsSeek = (
    video: HTMLVideoElement,
    localTarget: number,
    absoluteTarget: number,
    allowPreparation: boolean,
  ): boolean => {
    if (
      !allowPreparation ||
      !nativeHlsPlaybackRef.current ||
      !video.paused ||
      exactHandoffPendingRef.current ||
      serverOptimized == null ||
      activeServerOptimizedQuality == null
    ) {
      return false;
    }

    const previousPending = pendingNativeHlsSeekRef.current;
    invalidatePendingNativeHlsSeek();
    const sequence = ++pendingNativeHlsSeekSequenceRef.current;
    const pending = {
      sequence,
      absoluteTarget,
      localTarget,
      paused: previousPending?.paused ?? true,
      playbackIntent: previousPending?.playbackIntent ?? null,
      fallbackStarted: false,
      timer: null as number | null,
    };
    pendingNativeHlsSeekRef.current = pending;
    setPlaybackStatus("seeking");
    try {
      video.currentTime = localTarget;
    } catch {
      // The confirmation deadline owns recovery when WebKit rejects the seek.
    }
    scrubberRef.current?.setCurrentTime(absoluteTarget);
    pending.timer = window.setTimeout(() => {
      if (
        pendingNativeHlsSeekRef.current !== pending ||
        pendingNativeHlsSeekSequenceRef.current !== sequence ||
        !ownsSource(video) ||
        !nativeHlsPlaybackRef.current
      ) {
        return;
      }
      pending.timer = null;
      if (
        !video.seeking &&
        Number.isFinite(video.currentTime) &&
        Math.abs(video.currentTime - pending.localTarget) <= 0.25
      ) {
        if (confirmPendingNativeHlsSeek(video)) return;
      }
      pending.fallbackStarted = true;
      if (!video.paused) video.pause();
      setPlaybackStatus("seeking");
      const selected = serverAudioTracks.find(
        (track) => track.index === resolvedServerAudioTrack,
      );
      void onSwitchServerOptimized(
        activeServerOptimizedQuality,
        pending.absoluteTarget,
        () => ({
          paused: pending.playbackIntent === "play"
            ? false
            : pending.playbackIntent === "pause"
              ? true
              : pending.paused,
          volume: video.volume,
          muted: video.muted,
          playbackRate: video.playbackRate,
        }),
        resolvedServerAudioTrack ?? undefined,
        activeServerAudioPreference ?? (selected == null ? undefined : {
          id: selected.id,
          language: selected.language,
          label: selected.logicalLabel,
        }),
        "fixed",
        false,
        "native-hls-seek",
      ).then((activated) => {
        settleNativeHlsSeekReplacement(pending, video, activated);
      });
    }, NATIVE_HLS_SEEK_CONFIRM_TIMEOUT_MS);
    return true;
  };

  const currentRecoveryState = (video: HTMLVideoElement): PlaybackHandoffState => ({
    paused: video.error == null && !video.ended && !verifiedPlaybackProgressReportedRef.current &&
      !explicitPlaybackIntentRef.current && sourceSwitchStateRef.current == null
      ? video.paused : ownedPlaybackPausedRef.current,
    volume: Number.isFinite(video.volume) ? Math.min(1, Math.max(0, video.volume)) : 1,
    muted: video.muted,
    playbackRate: Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
    audioPreference: audioPreferenceRef.current.id != null || audioPreferenceRef.current.language != null
      ? { ...audioPreferenceRef.current }
      : null,
  });
  const captureRecoverySnapshot = (video: HTMLVideoElement): WebviewRecoverySnapshot => {
    const pending = pendingRecoverySeekFor(video);
    const nativeSeek = pendingNativeHlsSeekRef.current;
    const current = currentRecoveryState(video);
    // A bookmark not yet applied before metadata is still owned intent. A
    // committed user seek consumes that initial decision, including zero.
    const initialTarget = !didSeekRef.current && (requiresExactHandoffRef.current ||
      explicitInitialSeekRef.current != null || (startPositionRef.current ?? 0) > 5)
      ? explicitInitialSeekRef.current ?? startPositionRef.current ?? 0
      : null;
    return {
      position: nativeSeek?.absoluteTarget ?? pending?.position ?? Math.max(0,
        (initialTarget ?? (!(verifiedPlaybackProgressReportedRef.current &&
          (video.error?.code === 2 || video.error?.code === 3 || video.error?.code === 4)) && !recoveryClockWasReset(video) &&
          Number.isFinite(video.currentTime) && video.currentTime > 0
          ? video.currentTime
          : lastObservedMediaTimeRef.current)) + timelineOffsetRef.current,
      ),
      state: {
        ...current,
        paused: nativeSeek != null
          ? nativeSeek.playbackIntent === "play" ? false : nativeSeek.playbackIntent === "pause" ? true : nativeSeek.paused
          : pending?.state.paused ?? current.paused,
      },
    };
  };
  const recoverTerminalPlayback = (video: HTMLVideoElement, allowMissingResolver = false): boolean => {
    if (
      (!canRefreshSourceRef.current && !allowMissingResolver) ||
      !ownsSource(video) ||
      !verifiedPlaybackProgressReportedRef.current ||
      exactHandoffPendingRef.current ||
      pendingNativeHlsSeekRef.current != null
    ) return false;
    // A terminal transport failure is not a codec incompatibility. Re-resolve
    // through the same owner-fenced, one-shot recovery used by the watchdog,
    // instead of preparing another decoder against the potentially dead grant.
    // Fence synchronously: the browser can queue error, pause and ended before
    // the asynchronous parent resolver publishes a replacement.
    if (terminalRecoveryOwns(video)) return true;
    terminalRecoveryVideoRef.current = video;
    terminalRecoverySourceRef.current = sourceIdentity;
    const snapshot = captureRecoverySnapshot(video);
    terminalRecoveryStateRef.current = snapshot.state;
    stopLeaseRef.current();
    stallWatchdogRef.current?.stop();
    void onPlaybackStallRef.current(snapshot.position, snapshot.state);
    return true;
  };
  const assignRequestedSeek = (video: HTMLVideoElement, localTarget: number, absoluteTarget: number) => {
    // A failed decoder can reset currentTime before error is delivered. Keep
    // the last point this owned seek actually requested until healthy playback
    // confirms a newer clock for this reader and seek sequence.
    pendingRecoverySeekRef.current = {
      position: absoluteTarget, state: currentRecoveryState(video), video,
      sequence: ++recoverySeekSequenceRef.current,
      originPosition: (Number.isFinite(video.currentTime) ? video.currentTime : lastObservedMediaTimeRef.current) + timelineOffsetRef.current,
      healthyMediaTime: null,
    };
    video.currentTime = localTarget;
  };

  const seekAbsolute = (t: number, allowPreparation = true) => {
    const video = videoRef.current;
    if (video == null || !Number.isFinite(t)) return;
    const knownDuration = knownAbsoluteDurationRef.current;
    if (knownDuration == null && !optimizedTimelineIsPartial) {
      const localDuration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Number.POSITIVE_INFINITY;
      const localTarget = Math.min(Math.max(t, 0), localDuration);
      if (allowPreparation) claimInitialSeek(localTarget);
      if (!beginConfirmedNativeHlsSeek(video, localTarget, localTarget, allowPreparation)) {
        assignRequestedSeek(video, localTarget, localTarget);
      }
      scrubberRef.current?.setCurrentTime(localTarget);
      return;
    }
    const absoluteTarget = knownDuration == null
      ? Math.max(t, 0)
      : Math.min(Math.max(t, 0), knownDuration);
    const windowStart = timelineOffsetRef.current;
    const localTarget = absoluteTarget - windowStart;
    const windowDuration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : null;
    let hasSeekableRanges = false;
    let withinSeekableRange = false;
    if (localTarget >= 0) {
      try {
        hasSeekableRanges = video.seekable.length > 0;
        for (let index = 0; index < video.seekable.length; index += 1) {
          if (
            localTarget >= video.seekable.start(index) &&
            localTarget <= video.seekable.end(index)
          ) {
            withinSeekableRange = true;
            break;
          }
        }
      } catch {
        // A source swap can invalidate TimeRanges between length and access.
      }
    }
    if (
      localTarget >= 0 &&
      (
        (!hasSeekableRanges && localTarget === 0) ||
        (hasSeekableRanges
          ? withinSeekableRange
          : windowDuration != null && localTarget <= windowDuration)
      )
    ) {
      if (allowPreparation) claimInitialSeek(localTarget);
      if (!beginConfirmedNativeHlsSeek(video, localTarget, absoluteTarget, allowPreparation)) {
        assignRequestedSeek(video, localTarget, absoluteTarget);
      }
      scrubberRef.current?.setCurrentTime(
        knownDuration == null ? localTarget : absoluteTarget,
      );
      return;
    }
    // Pointer movement previews the local window without starting a server job.
    // Only the final release may replace it with a new optimized generation.
    if (!allowPreparation || serverOptimized == null || activeServerOptimizedQuality == null) return;
    const pendingNativeSeek = pendingNativeHlsSeekRef.current;
    const nativePausedServerSeek = nativeHlsPlaybackRef.current &&
      video.paused &&
      !exactHandoffPendingRef.current;
    let replacementPending = pendingNativeSeek;
    if (nativePausedServerSeek) {
      invalidatePendingNativeHlsSeek();
      replacementPending = {
        sequence: ++pendingNativeHlsSeekSequenceRef.current,
        absoluteTarget,
        localTarget,
        paused: pendingNativeSeek?.paused ?? true,
        playbackIntent: pendingNativeSeek?.playbackIntent ?? null,
        fallbackStarted: true,
        timer: null,
      };
      pendingNativeHlsSeekRef.current = replacementPending;
      setPlaybackStatus("seeking");
    }
    const selected = serverAudioTracks.find(
      (track) => track.index === resolvedServerAudioTrack,
    );
    const replacement = onSwitchServerOptimized(
      activeServerOptimizedQuality,
      absoluteTarget,
      () => ({
        paused: replacementPending?.playbackIntent === "play"
          ? false
          : replacementPending?.playbackIntent === "pause"
            ? true
            : replacementPending?.paused ?? video.paused,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate,
      }),
      resolvedServerAudioTrack ?? undefined,
      activeServerAudioPreference ?? (selected == null ? undefined : {
        id: selected.id,
        language: selected.language,
        label: selected.logicalLabel,
      }),
      "fixed",
      false,
      nativePausedServerSeek ? "native-hls-seek" : "ordinary",
    );
    if (nativePausedServerSeek && replacementPending != null) {
      void replacement.then((activated) => {
        settleNativeHlsSeekReplacement(replacementPending, video, activated);
      });
    }
  };

  const seek = (t: number, allowPreparation = true) => {
    const video = videoRef.current;
    if (video == null || !Number.isFinite(t)) return;
    if (knownAbsoluteDurationRef.current != null) {
      seekAbsolute(t, allowPreparation);
      return;
    }
    const localDuration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : Number.POSITIVE_INFINITY;
    const localTarget = Math.min(Math.max(t, 0), localDuration);
    if (allowPreparation) claimInitialSeek(localTarget);
    const absoluteTarget = localTarget + (
      optimizedTimelineIsPartialRef.current ? timelineOffsetRef.current : 0
    );
    if (!beginConfirmedNativeHlsSeek(video, localTarget, absoluteTarget, allowPreparation)) {
      assignRequestedSeek(video, localTarget, absoluteTarget);
    }
    scrubberRef.current?.setCurrentTime(localTarget);
  };
  absoluteSeekRef.current = seekAbsolute;

  const relativeSeek = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video == null) return;
    const knownDuration = knownAbsoluteDurationRef.current;
    const current = video.currentTime + (
      knownDuration != null || optimizedTimelineIsPartialRef.current
        ? timelineOffsetRef.current
        : 0
    );
    const target = Math.max(0, current + delta);
    absoluteSeekRef.current(
      knownDuration == null ? target : Math.min(knownDuration, target),
    );
  }, []);

  const toggleOptions = () => {
    onChromeControlFocus(optionsTriggerRef.current);
    if (!optionsOpen) menuTriggerRef.current = optionsTriggerRef.current?.isConnected ? optionsTriggerRef.current : null;
    if (!optionsOpen) optionsOriginRef.current = "settings";
    audioOptionsRequestedRef.current = false;
    setCaptionsOpen(false);
    setOptionsOpen((open) => !open);
  };

  const togglePlayerFullscreen = () => {
    const video = videoRef.current;
    if (video == null) return;
    const container = playerFullscreenContainer(video);
    if (container != null) toggleFullscreen(container, video);
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
      // Nested dialogs own all keyboard input, including Escape through their
      // modal hooks. Do not let a focused dialog container drive playback.
      if (nestedDialogOpen) return;
      onActivity();
      if (shouldIgnoreShortcut(e.target, video)) return;
      const knownDuration = knownAbsoluteDurationRef.current;
      const dur = knownDuration ?? (
        !optimizedTimelineIsPartial && Number.isFinite(video.duration)
          ? video.duration
          : 0
      );
      const seekTo = (t: number) => {
        absoluteSeekRef.current(t);
      };
      const seekBy = (delta: number) => {
        const current = video.currentTime + (
          knownDuration != null || optimizedTimelineIsPartial
            ? timelineOffsetRef.current
            : 0
        );
        seekTo(current + delta);
      };
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlaybackState();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(5);
          break;
        case "j":
        case "J":
          e.preventDefault();
          seekBy(-10);
          break;
        case "l":
        case "L":
          e.preventDefault();
          seekBy(10);
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
          const ids = [null, ...embeddedCaptionState.tracks.map((track) => track.id),
            ...subs.tracks.map((track) => track.id)];
          const current = ids.indexOf(embeddedCaptionState.activeTrackId ?? subs.activeTrackId);
          const next = ids[(current + 1) % ids.length] ?? null;
          if (next != null && embeddedCaptionState.tracks.some((track) => track.id === next)) {
            selectEmbeddedCaption(next);
          } else {
            selectDownloadedCaption(next);
          }
          break;
        }
        case "<":
          e.preventDefault();
          {
            const next = Math.max(0.5, video.playbackRate - 0.25);
            applyMediaPlaybackRate(video, next);
            setPlaybackRate(next);
          }
          break;
        case ">":
          e.preventDefault();
          {
            const next = Math.min(2, video.playbackRate + 0.25);
            applyMediaPlaybackRate(video, next);
            setPlaybackRate(next);
          }
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
          const container = playerFullscreenContainer(video);
          if (container != null) toggleFullscreen(container, video);
          break;
        }
        case "Home":
          e.preventDefault();
          if (dur > 0) seekTo(0);
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
    optimizedTimelineIsPartial,
    subs.activeTrackId,
    selectDownloadedCaption,
    selectEmbeddedCaption,
    embeddedCaptionState,
    nestedDialogOpen,
    subs.tracks,
    togglePlaybackState,
  ]);

  const resumePlayback = useCallback(() => {
    setPaused(false);
    requestPlaybackState(true);
  }, [requestPlaybackState]);

  const togglePlayback = togglePlaybackState;

  const handleVideoPointerDown = useCallback((event: React.PointerEvent<HTMLVideoElement>) => {
    videoPointerGestureRef.current = {
      pointerId: event.pointerId,
      touchLike: event.pointerType === "touch" ||
        event.pointerType === "pen" ||
        window.matchMedia?.("(pointer: coarse)").matches === true,
      // Pointer movement can reveal chrome before this gesture's click. Its
      // initial visibility still owns whether the click is reveal-only.
      chromeWasHidden: !chromeVisible,
    };
  }, [chromeVisible]);

  const handleVideoPointerCancel = useCallback((event: React.PointerEvent<HTMLVideoElement>) => {
    if (videoPointerGestureRef.current?.pointerId === event.pointerId) {
      videoPointerGestureRef.current = null;
    }
  }, []);

  const showTouchSeekFeedback = useCallback((zone: "back" | "forward") => {
    if (touchFeedbackTimerRef.current != null) {
      window.clearTimeout(touchFeedbackTimerRef.current);
    }
    setTouchSeekFeedback(zone);
    touchFeedbackTimerRef.current = window.setTimeout(() => {
      touchFeedbackTimerRef.current = null;
      setTouchSeekFeedback(null);
    }, 700);
  }, []);

  const handleVideoClick = useCallback((event: React.MouseEvent<HTMLVideoElement>) => {
    const gesture = videoPointerGestureRef.current;
    videoPointerGestureRef.current = null;
    const touchLike =
      gesture?.touchLike ||
      window.matchMedia?.("(pointer: coarse)").matches === true;
    if (nestedDialogOpen) return;
    if (touchLike && (gesture?.chromeWasHidden ?? !chromeVisible)) {
      onActivity();
      return;
    }
    if (touchPlayer && touchLike) {
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = rect.width > 0
        ? (event.clientX - rect.left) / rect.width
        : 0.5;
      const zone = ratio < 0.38 ? "back" : ratio > 0.62 ? "forward" : null;
      if (zone != null) {
        const now = performance.now();
        const pending = touchTapRef.current;
        if (pending != null && pending.zone === zone && now - pending.at <= TOUCH_DOUBLE_TAP_MS) {
          clearPendingTouchTap();
          relativeSeek(zone === "back" ? -10 : 10);
          showTouchSeekFeedback(zone);
          onActivity();
          return;
        }
        if (pending != null) clearPendingTouchTap();
        const timer = window.setTimeout(() => {
          if (touchTapRef.current?.timer !== timer) return;
          touchTapRef.current = null;
          togglePlayback();
        }, TOUCH_DOUBLE_TAP_MS);
        touchTapRef.current = { zone, at: now, timer };
        return;
      }
      clearPendingTouchTap();
    }
    togglePlayback();
  }, [chromeVisible, clearPendingTouchTap, nestedDialogOpen, onActivity, relativeSeek, showTouchSeekFeedback, togglePlayback, touchPlayer]);

  const handleVideoDoubleClick = useCallback(() => {
    if (nestedDialogOpen) return;
    if (touchPlayer) return;
    togglePlayerFullscreen();
  }, [nestedDialogOpen, togglePlayerFullscreen, touchPlayer]);

  const absolutePlaybackPosition = useCallback(() => {
    const current = videoRef.current?.currentTime ?? 0;
    return Math.max(0, current + timelineOffsetRef.current);
  }, []);

  const playbackHandoffState = useCallback((): PlaybackHandoffState => {
    const video = videoRef.current;
    const pendingIntent = pendingHandoffPlaybackIntentRef.current;
    return {
      paused: pendingIntent === "play" ? false : pendingIntent === "pause" ? true
        : video != null && ownsSource(video) ? currentRecoveryState(video).paused : paused,
      volume: video?.volume ?? volume,
      muted: video?.muted ?? muted,
      playbackRate: video?.playbackRate ?? playbackRate,
    };
  }, [muted, paused, playbackRate, sourceIdentity, volume]);

  const selectServerOptimizedQuality = useCallback((quality: ServerTranscodeQuality) => {
    const selected = serverAudioTracks.find(
      (track) => track.index === resolvedServerAudioTrack,
    );
    void onSelectServerOptimized(
      quality,
      absolutePlaybackPosition(),
      playbackHandoffState,
      resolvedServerAudioTrack ?? undefined,
      activeServerAudioPreference ?? (selected == null ? undefined : {
        id: selected.id,
        language: selected.language,
      }),
    );
  }, [
    absolutePlaybackPosition,
    activeServerAudioPreference,
    resolvedServerAudioTrack,
    onSelectServerOptimized,
    playbackHandoffState,
    serverAudioTracks,
  ]);

  const selectDeviceOriginal = useCallback(() => {
    onSelectDeviceOriginal(absolutePlaybackPosition(), playbackHandoffState());
  }, [absolutePlaybackPosition, onSelectDeviceOriginal, playbackHandoffState]);

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
    applyMediaPlaybackRate(video, next);
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
    const selected = hlsAudioTracks.find((track) => track.index === next) ?? null;
    if (!serverAudioModeRef.current) {
      audioPreferenceRef.current = {
        id: selected?.id ?? null,
        language: selected?.language ?? null,
      };
    }
  };

  const changeBrowserAudioTrack = (next: number) => {
    const video = videoRef.current as BrowserAudioVideoElement | null;
    const list = video?.audioTracks;
    if (list == null) return;
    const selected = browserAudioTracks.find((track) => track.index === next) ?? null;
    appliedBrowserAudioPreferenceRef.current = true;
    setBrowserAudioTrack(selected?.index ?? -1);
    audioPreferenceRef.current = {
      id: selected?.id ?? null,
      language: selected?.language ?? null,
    };
    reconcilingBrowserAudioSelectionRef.current = true;
    try {
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index] ?? list.item?.(index) ?? null;
        const shouldEnable = index === next;
        if (track != null && track.enabled !== shouldEnable) {
          track.enabled = shouldEnable;
        }
      }
    } finally {
      reconcilingBrowserAudioSelectionRef.current = false;
    }
  };

  const changeServerAudioTrack = (next: number) => {
    const selected = serverAudioTracks.find((track) => track.index === next) ?? null;
    if (selected == null || serverOptimized == null) return;
    const quality = activeServerOptimizedQuality ?? serverOptimized.defaultQuality ?? "480p";
    const preference = {
      id: selected.id,
      language: selected.language,
      label: selected.logicalLabel,
    };
    void onSelectServerOptimized(
      quality,
      absolutePlaybackPosition(),
      playbackHandoffState,
      next,
      preference,
      "follow-current",
      true,
    );
  };

  const matchedRetainedServerAudio = useMemo(
    () => retainedServerAudioMatch(retainedServerAudioPreference, serverAudioTracks),
    [retainedServerAudioPreference, serverAudioTracks],
  );

  useEffect(() => {
    if (
      retainedServerAudioPreference == null ||
      serverAudioInventoryStatus !== "ready" ||
      serverOptimizationPending ||
      matchedRetainedServerAudio != null
    ) {
      return;
    }
    onRetainedServerAudioPreferenceUnavailable(
      serverAudioOwner,
      retainedServerAudioPreference,
    );
  }, [
    matchedRetainedServerAudio,
    onRetainedServerAudioPreferenceUnavailable,
    retainedServerAudioPreference,
    serverAudioInventoryStatus,
    serverAudioOwner,
    serverOptimizationPending,
  ]);

  useEffect(() => {
    if (retainedServerOptimizedQuality != null && retainedServerOptimizedQuality === activeServerOptimizedQuality) {
      appliedRetainedServerQualityOwnerRef.current = serverAudioOwner;
    }
    const restoreRetainedQuality = appliedRetainedServerQualityOwnerRef.current !== serverAudioOwner &&
      retainedServerOptimizedQuality != null && retainedServerOptimizedQuality !== activeServerOptimizedQuality;
    if (
      (appliedServerAudioPreferenceRef.current && !restoreRetainedQuality) ||
      serverAudioInventoryStatus !== "ready" ||
      serverAudioTracks.length === 0 ||
      serverOptimizationPending
    ) {
      return;
    }
    const preferences = playerPreferencesRef.current;
    const perTitlePrefs = preferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs;
    const selected =
      (appliedServerAudioPreferenceRef.current
        ? serverAudioTracks.find((track) => track.index === resolvedServerAudioTrack)
        : null) ?? matchedRetainedServerAudio ?? findPreferredLanguageMatch(
        perTitlePrefs?.preferredAudioLang,
        serverAudioTracks,
        (track) => track.language,
      ) ??
      serverAudioTracks.find((track) => track.id === perTitlePrefs?.preferredAudioId) ??
      findPreferredLanguageMatch(
        preferences?.defaultAudioLanguage,
        serverAudioTracks,
        (track) => track.language,
      ) ??
      findPreferredLanguageMatch(
        preferences?.defaultAudioLanguage,
        serverAudioTracks,
        (track) => track.label,
      ) ??
      serverAudioTracks.find((track) => track.isDefault) ??
      serverAudioTracks[0];
    const audioMatches = selected.index === resolvedServerAudioTrack;
    if ((audioMatches && !restoreRetainedQuality) || serverOptimized == null) {
      appliedServerAudioPreferenceRef.current = true;
      return;
    }
    const video = videoRef.current;
    let position = absolutePlaybackPosition();
    if (!didSeekRef.current) {
      const start = explicitInitialSeekRef.current ?? startPositionRef.current ?? 0;
      const offset = timelineOffsetRef.current;
      if (exactHandoffPendingRef.current) {
        position = Math.max(0, start + offset);
      } else if (start > 5) {
        const localDuration = video != null && Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : knownAbsoluteDurationSeconds == null ? 0 : knownAbsoluteDurationSeconds - offset;
        // The ordinary resume policy must decide whether this is a completed
        // item before remembered audio can replace its initial source.
        if (localDuration <= 0) return;
        position = (start >= localDuration - 10 ? 0 : start) + offset;
      }
    }
    appliedServerAudioPreferenceRef.current = true;
    appliedRetainedServerQualityOwnerRef.current = serverAudioOwner;
    const quality = retainedServerOptimizedQuality ?? activeServerOptimizedQuality ?? serverOptimized.defaultQuality ?? "480p";
    // A quality-only restore keeps an implicit server default implicit. An
    // explicit track, including zero, and a retained audio choice remain owned.
    const implicitAudio = audioMatches && matchedRetainedServerAudio == null &&
      activeServerAudioPreference == null && !initialServerAudioTrackExplicit;
    void onSwitchServerOptimized(
      quality,
      position,
      () => {
        const state = playbackHandoffState();
        if (!exactHandoffPendingRef.current) return state;
        const intent = pendingHandoffPlaybackIntentRef.current;
        return { ...state, paused: intent === "play" ? false : intent === "pause" ? true
          : sourceSwitchStateRef.current?.paused ?? state.paused };
      },
      implicitAudio ? undefined : selected.index,
      implicitAudio ? undefined : { id: selected.id, language: selected.language, label: selected.logicalLabel },
      "follow-current",
      false,
      "remembered-audio",
    );
  }, [
    resolvedServerAudioTrack,
    activeServerOptimizedQuality,
    activeServerAudioPreference,
    initialServerAudioTrackExplicit,
    serverAudioOwner,
    retainedServerOptimizedQuality,
    matchedRetainedServerAudio,
    duration,
    knownAbsoluteDurationSeconds,
    onSwitchServerOptimized,
    savedPrefs,
    serverAudioInventoryStatus,
    serverAudioTracks,
    serverOptimizationPending,
    serverOptimized,
  ]);

  const serverAudioInventoryKnown = serverAudioInventoryStatus === "ready";
  const audioChoices = serverAudioInventoryKnown
    ? serverAudioTracks
    : hlsAudioInventoryKnown
      ? hlsAudioTracks
      : browserAudioTracks;
  const activeAudioTrack = serverAudioInventoryKnown
    ? resolvedServerAudioTrack
    : hlsAudioInventoryKnown
      ? hlsAudioTrack
      : browserAudioTrack;
  const audioInventoryPending =
    serverAudioInventoryStatus === "loading" ||
    (serverOptimized?.loadAudioTracks == null && isHls && !nativeHlsPlayback && !hlsAudioInventoryKnown);
  const audioSelectionUnavailable =
    serverAudioInventoryStatus === "unavailable" ||
    (!serverAudioInventoryKnown && !hlsAudioInventoryKnown && !browserAudioApiAvailable);
  const touchUnavailableAudioShortcut =
    touchPlayer &&
    audioChoices.length === 0 &&
    audioSelectionUnavailable &&
    !serverAudioLoaderAvailable;
  const touchServerAudioRetryShortcut =
    touchPlayer &&
    serverAudioLoaderAvailable &&
    serverAudioInventoryStatus === "unavailable";
  const audioShortcutAvailable = touchUnavailableAudioShortcut ||
    touchServerAudioRetryShortcut ||
    audioChoices.length > 1 || (
      serverAudioLoaderAvailable && (
        (serverAudioInventoryStatus === "idle" && initialServerAudioTracks == null) ||
        serverAudioInventoryStatus === "loading" ||
        (optionsOpen && optionsOriginRef.current === "audio")
      )
    );
  const activeAudioChoice = audioChoices.find((track) => track.index === activeAudioTrack) ?? null;
  const audioShortcutLabel = activeAudioChoice == null
    ? "Audio tracks"
    : `Audio track, ${activeAudioChoice.label}`;

  useEffect(() => {
    if (!optionsOpen || !audioOptionsRequestedRef.current) return;
    audioOptionsRequestedRef.current = false;
    audioHeadingRef.current?.focus();
    audioHeadingRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [optionsOpen]);

  const openAudioOptions = () => {
    onChromeControlFocus(audioShortcutRef.current);
    menuTriggerRef.current = audioShortcutRef.current?.isConnected ? audioShortcutRef.current : null;
    optionsOriginRef.current = "audio";
    audioOptionsRequestedRef.current = true;
    setCaptionsOpen(false);
    setOptionsOpen(true);
  };

  useLayoutEffect(() => {
    const wasOpen = optionsWasOpenRef.current;
    optionsWasOpenRef.current = optionsOpen;
    if (!wasOpen || optionsOpen) return;
    const origin = optionsOriginRef.current;
    optionsOriginRef.current = null;
    if (origin === "audio" && !audioShortcutAvailable) {
      onChromeControlFocus(optionsTriggerRef.current);
    }
  }, [audioShortcutAvailable, onChromeControlFocus, optionsOpen]);
  useEffect(() => {
    // Restore after modal cleanup and after the background controls are no longer
    // inert. Touch browsers need not focus a button when it is tapped.
    if (menuWasOpenRef.current && !menuOpen) {
      const trigger = menuTriggerRef.current;
      menuTriggerRef.current = null;
      if (trigger?.isConnected) onChromeControlFocus(trigger);
    }
    menuWasOpenRef.current = menuOpen;
  }, [menuOpen, onChromeControlFocus]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    // Declare retirement last so final progress, listener/watchdog/seek
    // cancellation and HLS destruction finish before resetting this owner.
    return () => {
      // StrictMode replay and Suspense hiding can clean up effects while the
      // same media remains connected. They are not physical retirement.
      if (video.isConnected) return;
      try { video.pause(); } catch { /* Continue releasing an already-closing element. */ }
      try { video.removeAttribute("src"); } catch { /* Still attempt the media reset. */ }
      try { video.load(); } catch { /* Cleanup must not break another owner's teardown. */ }
    };
  }, []);
  const touchAudioSheet = touchPlayer && optionsOriginRef.current === "audio";
  const touchAudioFallbackSheet = touchAudioSheet && touchUnavailableAudioShortcut;

  return (
    <div
      className={`webview-player${touchPlayer ? " is-touch-player" : ""}${touchMenuOpen ? " has-touch-menu" : ""}${suspended ? " is-casting" : ""}`}
      ref={captionViewportRef}
      onPointerMove={onActivity}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        Playback speed {playbackRate} times. Subtitles{" "}
        {activeSubtitle?.label ?? embeddedCaptionState.tracks.find(
          (track) => track.id === embeddedCaptionState.activeTrackId,
        )?.label ?? "off"}.
        {activeSubtitle != null
          ? ` Subtitle delay ${(activeSubtitle.delayMs / 1000).toFixed(1)} seconds.`
          : ""}
      </span>
      <div className="player-stage">
        <video
          ref={setVideoElement}
          className="player-video"
          style={{
            objectFit: videoFit,
            transform: `translate(${videoPanX}%, ${videoPanY}%) scale(${videoZoom})`,
          }}
          autoPlay={!requiresExactHandoff && !autoplayAttemptedRef.current &&
            pendingHandoffPlaybackIntentRef.current !== "pause" &&
            (!explicitPlaybackIntentRef.current || !ownedPlaybackPausedRef.current) &&
            !backgroundBlocksPlayback(videoRef.current)}
          playsInline
          crossOrigin={isTrustedServerStreamURL(url) ? "use-credentials" : undefined}
          x-webkit-airplay="allow"
          onPointerDown={handleVideoPointerDown}
          onPointerCancel={handleVideoPointerCancel}
          onClick={handleVideoClick}
          onDoubleClick={handleVideoDoubleClick}
          onError={(event) => {
            // hls.js owns its media errors and bounded recovery. Native HLS and
            // direct files still surface the media element's error here.
            if (isHls && hlsRef.current != null) {
              return;
            }
            if (!currentMediaEvent(event.currentTarget)) return;
            const mediaError = event.currentTarget.error;
            // Older Android WebViews can emit an `error` event while trying to
            // resolve their internal default poster URI, without setting a
            // MediaError on the playable video. Treat only a real MediaError as
            // a playback failure; later readiness/progress remains authoritative.
            if (mediaError == null) return;
            const failedVideo = event.currentTarget;
            if ((mediaError.code === 2 || mediaError.code === 3 || mediaError.code === 4) && recoverTerminalPlayback(failedVideo)) return;
            stopLeaseRef.current();
            onPlaybackErrorRef.current(
              mediaErrorMessage(mediaError),
              exactHandoffPendingRef.current,
              () => captureRecoverySnapshot(failedVideo),
            );
          }}
        >
          {subs.tracks.map((t) => (
            <track
              key={t.id}
              kind="subtitles"
              data-subtitle-track-id={t.id}
              src={t.vttUrl}
              srcLang={t.language}
              label={t.label}
              default={t.id === subs.activeTrackId}
            />
          ))}
        </video>
      </div>

      {playbackStatus != null && !suspended && (
        <div className="player-playback-status" role="status" aria-live="polite">
          <Icon name="refresh" size={18} />
          <span>{playbackStatus === "starting"
            ? "Starting playback…"
            : playbackStatus === "seeking"
              ? "Synchronizing playback…"
              : "Buffering…"}</span>
        </div>
      )}

      {suspended && (
        <div className="cast-local-placeholder" aria-hidden="true">
          <Icon name="cast" size={36} />
          <span>Playing on your cast device</span>
        </div>
      )}

      {!touchPlayer && paused && !ended && subs.activeTrackId == null && embeddedCaptionState.activeTrackId == null &&
        !captionsOpen && !optionsOpen && !detailsOpen && !scrubbing && (
        <PlayerPauseOverlay
          title={title}
          nowPlaying={nowPlaying}
          onResume={resumePlayback}
        />
      )}

      {touchSeekFeedback != null && (
        <div className={`player-touch-seek-feedback is-${touchSeekFeedback}`} role="status" aria-live="polite">
          <Icon name={touchSeekFeedback === "back" ? "rewind" : "forward"} size={24} />
          <span>{touchSeekFeedback === "back" ? "Back 10 seconds" : "Forward 10 seconds"}</span>
        </div>
      )}

      {!touchPlayer ? (
      <div
        className={`player-osd${chromeVisible ? " is-visible" : ""}`}
        ref={captionControlsRef}
        aria-hidden={!chromeVisible || undefined}
        onPointerEnter={onChromeEnter}
        onPointerLeave={onChromeLeave}
        onFocusCapture={onChromeFocus}
        onBlurCapture={onChromeBlur}
      >
        <WebviewScrubber
          key={`${url}:${engine}`}
          ref={scrubberRef}
          active={chromeVisible}
          duration={displayedDuration ?? 0}
          preview={thumbs.available ? thumbs.preview : null}
          onHover={thumbs.onHover}
          onLeave={thumbs.onLeave}
          onSeek={seek}
          onScrubbingChange={updateScrubbing}
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
              0:00 / {durationClockLabel(displayedDuration)}
            </span>
            {audioShortcutAvailable && (
              <button
                ref={audioShortcutRef}
                type="button"
                className={`chip player-audio-shortcut${optionsOpen ? " is-active" : ""}`}
                onClick={openAudioOptions}
                aria-label={audioShortcutLabel}
                aria-haspopup="dialog"
                aria-expanded={optionsOpen}
                title={audioShortcutLabel}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="audio" size={17} />
                <span className="player-audio-shortcut-label">Audio</span>
              </button>
            )}
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
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                  <option value={speed} key={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`chip player-osd-icon-button${captionsOpen || subs.activeTrackId != null || embeddedCaptionState.activeTrackId != null ? " is-active" : ""}`}
              onClick={(event) => {
                onChromeControlFocus(event.currentTarget);
                if (!captionsOpen) menuTriggerRef.current = event.currentTarget.isConnected ? event.currentTarget : null;
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
              {(subs.activeTrackId != null || embeddedCaptionState.activeTrackId != null) && <span className="captions-active-dot" />}
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
              ref={optionsTriggerRef}
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
                aria-label={systemFullscreen ? (isFullscreen ? "Exit system fullscreen" : "Enter system fullscreen") : (isFullscreen ? "Exit fullscreen" : "Enter fullscreen")}
                aria-pressed={isFullscreen}
                title={systemFullscreen ? "System fullscreen uses device controls instead of YAWF controls" : (isFullscreen ? "Exit fullscreen" : "Enter fullscreen")}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name={isFullscreen ? "fullscreen-exit" : "fullscreen"} size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      ) : (
        <div
          className="player-touch-controls"
          ref={(element) => element?.toggleAttribute("inert", touchMenuOpen)}
          aria-hidden={touchMenuOpen || undefined}
        >
          <div
            className={`player-touch-transport${chromeVisible ? " is-visible" : ""}`}
            aria-hidden={!chromeVisible || undefined}
            onPointerEnter={onChromeEnter}
            onPointerLeave={onChromeLeave}
            onFocusCapture={onChromeFocus}
            onBlurCapture={onChromeBlur}
          >
            <button
              type="button"
              className="chip player-touch-skip"
              onClick={(event) => {
                onChromeControlFocus(event.currentTarget);
                relativeSeek(-10);
              }}
              aria-label="Back 10 seconds"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="rewind" size={23} />
              <span>Back 10</span>
            </button>
            <button
              type="button"
              className="chip player-touch-play"
              onClick={(event) => {
                onChromeControlFocus(event.currentTarget);
                togglePlayback();
              }}
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name={playing ? "pause" : "play"} size={30} />
            </button>
            <button
              type="button"
              className="chip player-touch-skip"
              onClick={(event) => {
                onChromeControlFocus(event.currentTarget);
                relativeSeek(10);
              }}
              aria-label="Forward 10 seconds"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="forward" size={23} />
              <span>Forward 10</span>
            </button>
          </div>

          <div
            className={`player-osd player-touch-osd${chromeVisible ? " is-visible" : ""}`}
            ref={captionControlsRef}
            aria-hidden={!chromeVisible || undefined}
            onPointerEnter={onChromeEnter}
            onPointerLeave={onChromeLeave}
            onFocusCapture={onChromeFocus}
            onBlurCapture={onChromeBlur}
          >
            <WebviewScrubber
              key={`${url}:${engine}`}
              ref={scrubberRef}
              active={chromeVisible}
              duration={displayedDuration ?? 0}
              preview={thumbs.available ? thumbs.preview : null}
              onHover={thumbs.onHover}
              onLeave={thumbs.onLeave}
              onSeek={seek}
              onScrubbingChange={updateScrubbing}
              disabled={!chromeVisible}
              touchPresentation
            />
            <div className="player-touch-action-row" role="toolbar" aria-label="Playback actions">
              <div className="player-touch-actions">
                {audioShortcutAvailable && (
                  <button
                    ref={audioShortcutRef}
                    type="button"
                    className={`chip player-touch-action${optionsOpen && optionsOriginRef.current === "audio" ? " is-active" : ""}`}
                    onClick={openAudioOptions}
                    aria-label={audioShortcutLabel}
                    aria-haspopup="dialog"
                    aria-expanded={optionsOpen && optionsOriginRef.current === "audio"}
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    <Icon name="audio" size={18} />
                    <span className="player-touch-action-label">Audio</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`chip player-touch-action${captionsOpen || subs.activeTrackId != null || embeddedCaptionState.activeTrackId != null ? " is-active" : ""}`}
                  onClick={(event) => {
                    onChromeControlFocus(event.currentTarget);
                    if (!captionsOpen) menuTriggerRef.current = event.currentTarget.isConnected ? event.currentTarget : null;
                    setOptionsOpen(false);
                    setCaptionsOpen((open) => !open);
                  }}
                  aria-label="Subtitles"
                  aria-haspopup="dialog"
                  aria-expanded={captionsOpen}
                  tabIndex={chromeVisible ? undefined : -1}
                >
                  <Icon name="captions" size={18} />
                  <span className="player-touch-action-label">CC</span>
                </button>
                <label className="chip player-touch-action player-touch-speed">
                  <span className="player-touch-action-label">Speed</span>
                  <select
                    aria-label="Playback speed"
                    value={playbackRate}
                    onChange={(event) => changePlaybackRate(Number(event.target.value))}
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                      <option value={speed} key={speed}>{speed}×</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="chip player-touch-action"
                  onClick={() => onPresentationChange({ fit: videoFit === "contain" ? "cover" : videoFit === "cover" ? "fill" : "contain" })}
                  aria-label={`Video fit, ${videoFit === "contain" ? "Fit" : videoFit === "cover" ? "Fill" : "Stretch"}`}
                  tabIndex={chromeVisible ? undefined : -1}
                >
                  <Icon name="sliders" size={18} />
                  <span className="player-touch-action-label">Screen</span>
                  <span className="player-touch-action-value">{videoFit === "contain" ? "Fit" : videoFit === "cover" ? "Fill" : "Stretch"}</span>
                </button>
                {underTauri ? (
                  <CastControls
                    media={{ url, title, subtitleUrl: castSubtitleUrl }}
                    buttonClassName="chip player-touch-action player-mobile-optional player-touch-cast"
                    onLocalPlaybackChange={onCastLocalPlaybackChange}
                  />
                ) : browserCastAvailable ? (
                  <button
                    type="button"
                    className="chip player-touch-action player-mobile-optional"
                    onClick={showBrowserCastPicker}
                    aria-label={airPlayAvailable ? "AirPlay" : "Cast to a device"}
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    <Icon name="cast" size={18} />
                    <span className="player-touch-action-label">{airPlayAvailable ? "AirPlay" : "Cast"}</span>
                  </button>
                ) : null}
                {pictureInPictureSupported && (
                  <button
                    type="button"
                    className={`chip player-touch-action player-mobile-optional${isPictureInPicture ? " is-active" : ""}`}
                    onClick={togglePictureInPicture}
                    aria-label={isPictureInPicture ? "Exit picture in picture" : "Picture in picture"}
                    aria-pressed={isPictureInPicture}
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    <Icon name="picture-in-picture" size={18} />
                    <span className="player-touch-action-label">PiP</span>
                  </button>
                )}
                {fullscreenSupported && (
                  <button
                    type="button"
                    className={`chip player-touch-action${isFullscreen ? " is-active" : ""}`}
                    onClick={togglePlayerFullscreen}
                    aria-label={systemFullscreen ? (isFullscreen ? "Exit system fullscreen" : "Enter system fullscreen") : (isFullscreen ? "Exit fullscreen" : "Enter fullscreen")}
                    aria-pressed={isFullscreen}
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    <Icon name={isFullscreen ? "fullscreen-exit" : "fullscreen"} size={18} />
                    <span className="player-touch-action-label">{systemFullscreen ? "System fullscreen" : "Fullscreen"}</span>
                  </button>
                )}
                {onPlayNext != null && (
                  <button
                    type="button"
                    className="chip player-touch-action"
                    onClick={onPlayNext}
                    aria-label="Next episode"
                    tabIndex={chromeVisible ? undefined : -1}
                  >
                    <Icon name="skip-next" size={18} />
                    <span className="player-touch-action-label">Next</span>
                  </button>
                )}
              </div>
              <button
                ref={optionsTriggerRef}
                type="button"
                className={`chip player-touch-action player-touch-more${optionsOpen && optionsOriginRef.current === "settings" ? " is-active" : ""}`}
                onClick={toggleOptions}
                aria-label="Playback settings"
                aria-haspopup="dialog"
                aria-expanded={optionsOpen && optionsOriginRef.current === "settings"}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="sliders" size={18} />
                <span className="player-touch-action-label">More</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {touchMenuOpen && (
        <button
          type="button"
          className="player-touch-menu-scrim"
          aria-label="Dismiss player menu"
          tabIndex={-1}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            setOptionsOpen(false);
            setCaptionsOpen(false);
          }}
        />
      )}

      {optionsOpen && (
        <div
          ref={optionsDialogRef}
          className={`player-options-menu glass-lit${touchAudioSheet ? " is-touch-audio-sheet" : touchPlayer ? " is-touch-settings" : ""}${touchAudioFallbackSheet ? " has-audio-fallback" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={touchAudioSheet ? "Audio tracks" : "Playback settings"}
          tabIndex={-1}
        >
          <div className="player-options-head">
            <strong>{touchAudioSheet ? "Audio tracks" : "Playback settings"}</strong>
            <button
              type="button"
              className="player-close"
              onClick={() => setOptionsOpen(false)}
              aria-label={touchAudioSheet ? "Close audio tracks" : "Close playback settings"}
            >
              <Icon name="xmark" size={15} />
            </button>
          </div>
          <div className="player-options-section player-audio-options-section" aria-labelledby="player-audio-track-heading">
            <span
              ref={audioHeadingRef}
              className="t-secondary"
              id="player-audio-track-heading"
              role="heading"
              aria-level={2}
              tabIndex={-1}
            >
              Audio track
            </span>
            {audioChoices.length > 0 && (
              <div className="player-options-choice-row">
                {audioChoices.map((track) => (
                  <button
                    type="button"
                    className={`chip${activeAudioTrack === track.index ? " is-active" : ""}`}
                    aria-pressed={activeAudioTrack === track.index}
                    onClick={() => {
                      if (serverAudioInventoryKnown) changeServerAudioTrack(track.index);
                      else if (hlsAudioInventoryKnown) changeHlsAudioTrack(track.index);
                      else changeBrowserAudioTrack(track.index);
                    }}
                    key={track.id}
                  >
                    {track.label}
                  </button>
                ))}
              </div>
            )}
            {audioInventoryPending ? (
              <p className="player-options-status" role="status">
                Loading audio tracks…
              </p>
            ) : serverAudioInventoryStatus === "unavailable" && serverAudioLoaderAvailable ? (
              <>
                <p className="player-options-status" role="status">
                  Audio track inventory is temporarily unavailable.
                </p>
                <button
                  type="button"
                  className="player-options-action"
                  onClick={() => startServerAudioInventoryLoad(true)}
                >
                  Retry audio tracks
                </button>
              </>
            ) : audioChoices.length === 1 ? (
              <p className="player-options-status" role="status">
                This stream reports one audio track.
              </p>
            ) : audioChoices.length === 0 && audioSelectionUnavailable ? (
              <p className="player-options-status" role="status">
                This browser does not expose alternate audio tracks. If this source contains more than one, use an external player.
              </p>
            ) : audioChoices.length === 0 ? (
              <p className="player-options-status" role="status">
                This stream does not report selectable audio tracks.
              </p>
            ) : null}
          </div>
          {(systemFullscreen || safariPageUrl != null) && (
            <div className="player-options-section" aria-label="Fullscreen options">
              <span className="t-secondary">Fullscreen</span>
              {systemFullscreen && (
                <p className="player-options-status">
                  System fullscreen uses your device's controls instead of YAWF controls.
                </p>
              )}
              {safariPageUrl != null && (
                <div className="player-options-status">
                  <strong>YAWF fullscreen in Safari</strong>
                  <p>For fullscreen with YAWF controls, open Safari and enter this server address. Sign in and resume playback there if needed.</p>
                  <code style={{ display: "block", overflowWrap: "anywhere" }}>{safariPageUrl}</code>
                </div>
              )}
            </div>
          )}
          <div
            className="player-options-section player-options-external"
            aria-labelledby="player-external-heading"
          >
            <span
              className="t-secondary"
              id="player-external-heading"
              role="heading"
              aria-level={2}
            >
              External player
            </span>
            {browserExternalLinks.map((link) => (
              <a
                className="player-options-action"
                href={link.href}
                key={link.id}
                onClick={() => recordDiagnostic("player", "external.intent_requested")}
              >
                <Icon name="play" size={17} />
                <span>
                  <strong>{link.label}</strong>
                  <small>{link.description}</small>
                </span>
              </a>
            ))}
            {externalPlaybackAvailable ? (
              <button
                type="button"
                className="player-options-action"
                onClick={onOpenExternalPlayer}
              >
                <Icon name="play" size={17} />
                <span>
                  <strong>
                    {browserExternalGuidance != null
                      ? "Download player playlist (.m3u)"
                      : nativeExternalChooser || manualExternalUrl == null
                      ? "Open in external player"
                      : "Copy stream link"}
                  </strong>
                  <small>
                    {browserExternalGuidance != null
                      ? "Save a playlist to open with an installed desktop or mobile player"
                      : nativeExternalChooser
                      ? "Choose VLC or another installed video app"
                      : manualExternalUrl == null
                      ? "VLC, IINA, mpv, or your device player"
                      : "Paste into VLC or another player"}
                  </small>
                </span>
              </button>
            ) : (
              <p className="player-options-status" role="status">
                External playback is not available for this protected stream. Retry playback or choose another source.
              </p>
            )}
            {browserExternalGuidance != null && (
              <p className="player-options-status">{browserExternalGuidance}</p>
            )}
            {externalPlaybackAvailable && onCopyExternalLink != null &&
              (nativeExternalChooser || browserExternalGuidance != null) && (
              <button
                type="button"
                className="player-options-action"
                onClick={onCopyExternalLink}
              >
                <Icon name="copy" size={17} />
                <span>
                  <strong>Copy stream link</strong>
                  <small>Paste it into an installed player</small>
                </span>
              </button>
            )}
            {externalActionStatus && (
              <p className="player-options-status" role="status">{externalActionStatus}</p>
            )}
            {manualExternalUrl != null && (
              <a
                className="player-options-manual-link"
                href={manualExternalUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Selectable stream link
              </a>
            )}
          </div>
          <div className="player-options-section player-fit-options-section">
            <span className="t-secondary">Video fit</span>
            <div className="player-options-choice-row">
              {(["contain", "cover", "fill"] as const).map((fit) => (
                <button
                  type="button"
                  className={`chip${videoFit === fit ? " is-active" : ""}`}
                  aria-pressed={videoFit === fit}
                  onClick={() => onPresentationChange({ fit })}
                  key={fit}
                >
                  {fit === "contain" ? "Fit" : fit === "cover" ? "Fill screen" : "Stretch"}
                </button>
              ))}
            </div>
          </div>
          {serverOptimized != null && (
            <div className="player-options-section">
              <span className="t-secondary">Streaming mode</span>
              <div className="player-options-choice-row">
                <button
                  type="button"
                  className={`chip${activeServerOptimizedQuality == null ? " is-active" : ""}`}
                  aria-pressed={activeServerOptimizedQuality == null}
                  disabled={serverOptimizationPending}
                  onClick={selectDeviceOriginal}
                >
                  Device Original
                </button>
                <span className="player-options-mode-label">Server Optimized</span>
              </div>
              <div className="player-options-choice-row">
                {serverOptimized.qualities.map((quality) => (
                  <button
                    type="button"
                    className={`chip${activeServerOptimizedQuality === quality ? " is-active" : ""}`}
                    aria-pressed={activeServerOptimizedQuality === quality}
                    disabled={serverOptimizationPending}
                    onClick={() => selectServerOptimizedQuality(quality)}
                    key={quality}
                  >
                    {quality === "auto" ? "Auto" : quality}
                  </button>
                ))}
              </div>
              <small className="t-secondary">
                Server Optimized reduces data use and needs server processing. Device Original keeps the source quality.
              </small>
              {serverOptimizationPending && (
                <p className="player-options-status" role="status">Preparing optimized playback while the current stream continues…</p>
              )}
              {serverOptimizationError != null && (
                <p className="player-options-status" role="alert">{serverOptimizationError}</p>
              )}
            </div>
          )}
          <div className="player-options-section player-options-sliders">
            <label>
              <span className="t-secondary">Zoom</span>
              <span className="player-options-output">{Math.round(videoZoom * 100)}%</span>
              <AdjustmentRange
                min={1}
                max={2.5}
                step={0.05}
                value={videoZoom}
                onValueChange={(value) => onPresentationChange({ zoom: value })}
              />
            </label>
            <label>
              <span className="t-secondary">Pan horizontally</span>
              <span className="player-options-output">{videoPanX}%</span>
              <AdjustmentRange
                min={-50}
                max={50}
                step={1}
                value={videoPanX}
                onValueChange={(value) => onPresentationChange({ panX: value })}
              />
            </label>
            <label>
              <span className="t-secondary">Pan vertically</span>
              <span className="player-options-output">{videoPanY}%</span>
              <AdjustmentRange
                min={-50}
                max={50}
                step={1}
                value={videoPanY}
                onValueChange={(value) => onPresentationChange({ panY: value })}
              />
            </label>
            <label>
              <span className="t-secondary">Subtitle position</span>
              <span className="player-options-output">{subtitlePosition}%</span>
              <AdjustmentRange
                min={10}
                max={95}
                step={1}
                value={subtitlePosition}
                onValueChange={setSubtitlePosition}
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
        </div>
      )}

      {!upNextDismissed && !autoAdvanceFiredRef.current && (ended || endPrediction.show) && upNext != null && onPlayNext != null && (
        <UpNextOverlay
          label={upNext.label}
          auto={autoCountdown && (ended || endPrediction.earlyAutoAdvance)}
          paused={paused || suspended}
          countdownSeconds={endPrediction.cancelWindowSeconds}
          onDismiss={() => {
            upNextDismissedRef.current = true;
            setUpNextDismissed(true);
          }}
          onPlayNext={onPlayNext}
        />
      )}

      {captionsOpen && (
        <CaptionsMenu
          subs={{ ...subs, setActiveTrack: selectDownloadedCaption }}
          embedded={{ ...embeddedCaptionState, setActiveTrack: selectEmbeddedCaption }}
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
  paused,
  countdownSeconds,
  onDismiss,
  onPlayNext,
}: {
  label: string;
  auto: boolean;
  paused: boolean;
  countdownSeconds: number;
  onDismiss: () => void;
  onPlayNext: () => void;
}) {
  const [remaining, setRemaining] = useState(countdownSeconds);
  // The countdown fires through a ref so re-renders during the countdown
  // (polls, seasons landing) always reach the LATEST handler - an interval
  // closure would capture a stale one.
  const onPlayNextRef = useRef(onPlayNext);
  const firedRef = useRef(false);
  onPlayNextRef.current = onPlayNext;
  const playNow = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onPlayNextRef.current();
  };
  useEffect(() => {
    if (!auto || paused) return;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timer);
          playNow();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    // Cleared on unmount AND on the dismiss re-run - no timer leak, and a
    // dismissed card can never fire.
    return () => clearInterval(timer);
  }, [auto, paused]);
  useEffect(() => setRemaining(countdownSeconds), [countdownSeconds]);
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
          <span className="player-upnext-count t-secondary" role="status" aria-live="polite">
            Playing in {remaining}s
          </span>
        )}
        <div className="player-upnext-actions">
          <button type="button" className="btn btn-prominent" onClick={playNow}>
            <Icon name="play" size={14} />
            Play now
          </button>
          <button type="button" className="btn" onClick={onDismiss} autoFocus>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalPanel({
  underTauri,
  externalPlaybackAvailable,
  status,
  error,
  externalStatus,
  onOpenExternal,
  onCopyExternal,
  nativeExternalChooser,
  manualExternalUrl,
  browserExternalLinks,
  browserExternalGuidance,
  onTryNextSource,
  onRetry,
  retryPending = false,
  freshResolutionRequired = false,
}: {
  underTauri: boolean;
  externalPlaybackAvailable: boolean;
  status: string | null;
  error: string | null;
  externalStatus: string | null;
  onOpenExternal: () => void;
  onCopyExternal?: () => void;
  nativeExternalChooser: boolean;
  manualExternalUrl: string | null;
  browserExternalLinks: BrowserExternalPlayerLink[];
  browserExternalGuidance: string | null;
  onTryNextSource?: () => Promise<void>;
  onRetry?: () => void | Promise<void>;
  retryPending?: boolean;
  freshResolutionRequired?: boolean;
}) {
  const [tryNextState, setTryNextState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  if (onRetry != null || freshResolutionRequired) {
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
          {onRetry != null && (
            <button
              type="button"
              className="btn btn-prominent"
              disabled={retryPending}
              onClick={() => void onRetry()}
            >
              {retryPending ? "Preparing fresh stream" : "Retry playback"}
            </button>
          )}
          {browserExternalLinks.map((link) => (
            <a
              className="btn"
              href={link.href}
              key={link.id}
              onClick={() => recordDiagnostic("player", "external.intent_requested")}
            >
              {link.label}
            </a>
          ))}
          {externalPlaybackAvailable ? (
            <button type="button" className="btn" onClick={onOpenExternal}>
              {browserExternalGuidance != null
                ? "Download player playlist (.m3u)"
                : nativeExternalChooser || manualExternalUrl == null
                ? "Open in external player"
                : "Copy stream link"}
            </button>
          ) : (
            <p className="player-external-sub" role="status">
              External playback is not available for this protected stream. Retry playback or choose another source.
            </p>
          )}
          {externalPlaybackAvailable && onCopyExternal != null &&
            (nativeExternalChooser || browserExternalGuidance != null) && (
            <button type="button" className="btn" onClick={onCopyExternal}>
              Copy stream link
            </button>
          )}
        </div>
        {browserExternalGuidance != null && (
          <p className="player-external-sub t-secondary">{browserExternalGuidance}</p>
        )}
        {manualExternalUrl != null && (
          <a
            className="btn player-direct-link"
            href={manualExternalUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Selectable stream link
          </a>
        )}
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
        error ? (
          <>
            <h3 className="player-external-title">Could not open a player</h3>
            <p className="player-external-err" role="alert">{error}</p>
            {externalPlaybackAvailable ? (
              <button type="button" className="btn" onClick={onOpenExternal}>
                Try external player again
              </button>
            ) : (
              <p className="player-external-sub" role="status">
                External playback is not available for this protected stream. Retry playback or choose another source.
              </p>
            )}
            {externalPlaybackAvailable && nativeExternalChooser && onCopyExternal != null && (
              <button type="button" className="btn" onClick={onCopyExternal}>
                Copy stream link
              </button>
            )}
            {manualExternalUrl != null && (
              <a
                className="btn player-direct-link"
                href={manualExternalUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Selectable stream link
              </a>
            )}
          </>
        ) : (
          <>
            <h3 className="player-external-title">Opening in the bundled player</h3>
            <p className="player-external-sub t-secondary">
              {status ??
                "This file (MKV/HEVC) plays in the bundled mpv player. Starting…"}
            </p>
          </>
        )
      ) : (
        <>
          <h3 className="player-external-title">Use an external player</h3>
          <p className="player-external-sub t-secondary">
            {error ??
              "This file (MKV/HEVC) needs an external player or another compatible source."}
          </p>
          {externalPlaybackAvailable ? (
            <>
              <div className="player-external-actions">
                {browserExternalLinks.map((link) => (
                  <a
                    className="btn"
                    href={link.href}
                    key={link.id}
                    onClick={() => recordDiagnostic("player", "external.intent_requested")}
                  >
                    {link.label}
                  </a>
                ))}
                <button type="button" className="btn" onClick={onOpenExternal}>
                  Download player playlist (.m3u)
                </button>
                {onCopyExternal != null && (
                  <button type="button" className="btn" onClick={onCopyExternal}>
                    Copy stream link
                  </button>
                )}
              </div>
              {browserExternalGuidance != null && (
                <p className="player-external-sub t-secondary">{browserExternalGuidance}</p>
              )}
            </>
          ) : (
            <p className="player-external-sub" role="status">
              External playback is not available for this protected stream. Retry playback or choose another source.
            </p>
          )}
          {externalStatus && <p className="player-external-sub" role="status">{externalStatus}</p>}
        </>
      )}
    </div>
  );
}
