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
const SERVER_OPTIMIZED_REQUEST_TIMEOUT_MS = 8_000;
const SERVER_SOURCE_INFO_RETRY_DELAY_MS = 5_000;
const MAX_SOURCE_DURATION_SECONDS = 86_400;
const SERVER_OPTIMIZED_RETRY_BASE_MS = 500;
const SERVER_OPTIMIZED_RETRY_MAX_MS = 4_000;
const TOUCH_DOUBLE_TAP_MS = 320;
import { Icon } from "./Icon";
import {
  isTauri,
  isDesktopTauri,
  openInExternalPlayer,
  playWithMpv,
  mpvStop,
} from "../lib/tauri";
import { deviceKind, isStandaloneDisplay } from "../lib/platform";
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
import { findPreferredLanguageMatch } from "../lib/languagePreference";
import { audioTrackLabel } from "../lib/audioTrackLabel";
import { captionLayout, type CaptionRect } from "../lib/captionLayout";
import { configuredServerURL } from "../lib/serverMode";
import {
  PlaybackStallWatchdog,
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
}

type ServerOptimizedPositionIntent = "follow-current" | "fixed";

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
  isDefault?: boolean;
}

interface AudioPreference {
  id: string | null;
  language: string | null;
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
  type ScopedOptimizedSource = ServerOptimizedSource & {
    originOwner: string;
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
  const optimizationPendingRef = useRef<{
    owner: string;
    request: number;
    controller: AbortController;
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
  useLayoutEffect(() => {
    playerMountedRef.current = true;
    return () => {
      playerMountedRef.current = false;
      recoveryRequestSequenceRef.current += 1;
      recoveryPendingRef.current = null;
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
    optimizationRequestSequenceRef.current += 1;
    optimizationPendingRef.current?.controller.abort();
    optimizationPendingRef.current = null;
    sourceInfoGenerationRef.current += 1;
    cancelSourceInfoRetry();
    setServerOptimizationPending(false);
    setServerOptimizationError(null);
    autoOptimizationAttemptedRef.current = null;
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
  const androidOnCloseRef = useRef(onClose);
  const androidOnProgressRef = useRef(onProgress);
  androidOnCloseRef.current = onClose;
  androidOnProgressRef.current = onProgress;
  const [chromeHovered, setChromeHovered] = useState(false);
  const [chromeFocused, setChromeFocused] = useState(false);
  const chromeHideTimer = useRef<number | undefined>(undefined);
  const lastChromeNudgeAt = useRef(Number.NEGATIVE_INFINITY);
  const chromePinned =
    webviewPaused || webScrubbing || captionsOpen || webMenuOpen || detailsSection != null || chromeHovered || chromeFocused;
  const chromePinnedRef = useRef(chromePinned);
  chromePinnedRef.current = chromePinned;
  const playerDialogRef = useModalA11y<HTMLDivElement>(
    onClose,
    !useEmbedded,
    captionsOpen || webMenuOpen || detailsSection != null,
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
  const stallRecoveryPendingRef = useRef(false);
  const lastStallContextRef = useRef<{
    position: number;
    handoff: PlaybackHandoffState;
  } | null>(null);

  const recoverPostStartStall = useCallback(async (
    absolutePositionSeconds: number,
    handoff: PlaybackHandoffState,
  ): Promise<boolean> => {
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
    automaticStallRecoveryAttemptedRef.current = true;
    stallRecoveryPendingRef.current = true;
    setWebRecoveryPending(true);
    recordDiagnostic("player", "stall.refresh_started", "warning");
    try {
      await withFreshStreamResolutionTimeout(refreshCurrentSource(position, handoff));
      recordDiagnostic("player", "stall.refresh_ready");
      return true;
    } catch {
      setExternalError(
        "A fresh stream could not be prepared. Retry, or choose another source.",
      );
      recordDiagnostic("player", "stall.refresh_failed", "error");
      return false;
    } finally {
      stallRecoveryPendingRef.current = false;
      setWebRecoveryPending(false);
    }
  }, [refreshCurrentSource]);

  const retryFreshStream = useCallback(async (): Promise<void> => {
    const context = lastStallContextRef.current;
    if (refreshCurrentSource == null || context == null || manualRecoveryPending) return;
    const owner = playbackOwnerRef.current;
    const source = activeWebSourceRef.current;
    const ownsLeaseRecovery = () => !serverLeaseExpired || (playerMountedRef.current &&
      playbackOwnerRef.current === owner && activeWebSourceRef.current === source);
    setManualRecoveryPending(true);
    recordDiagnostic("player", "stall.manual_retry_started");
    try {
      await withFreshStreamResolutionTimeout(
        refreshCurrentSource(context.position, context.handoff),
      );
      if (!ownsLeaseRecovery()) return;
      // A successful resolver must publish a new source owner. Until then an
      // expired generation cannot be remounted under its old URL.
      if (!serverLeaseExpired) setExternalError(null);
      recordDiagnostic("player", "stall.manual_retry_ready");
    } catch {
      if (!ownsLeaseRecovery()) return;
      setExternalError(
        "A fresh stream could not be prepared. Retry, or choose another source.",
      );
      recordDiagnostic("player", "stall.manual_retry_failed", "error");
    } finally {
      if (ownsLeaseRecovery()) setManualRecoveryPending(false);
    }
  }, [manualRecoveryPending, refreshCurrentSource, serverLeaseExpired]);

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
  }, [playbackOwner, refreshCurrentSource]);

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
      mode !== "webview" ||
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
  }, [mode, playbackOwner, rememberServerSourceInfo, serverOptimized?.loadSourceInfo]);

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
    setFallbackSource({
      originUrl: url,
      originEngine: requestedEngine,
      url: hlsUrl,
    });
    recordDiagnostic("player", "native.fallback_ready");
    return true;
  }, [requestedEngine, url]);

  const recoverNativeInWebview = useCallback(async (): Promise<boolean> => {
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
    ) => {
      const owner = playbackOwner;
      if (
        serverOptimized == null ||
        !playerMountedRef.current ||
        playbackOwnerRef.current !== owner ||
        optimizationPendingRef.current?.owner === owner
      ) {
        return;
      }
      const position = Number.isFinite(absolutePositionSeconds)
        ? Math.max(0, absolutePositionSeconds)
        : 0;
      const request = ++optimizationRequestSequenceRef.current;
      const controller = new AbortController();
      optimizationPendingRef.current?.controller.abort();
      optimizationPendingRef.current = { owner, request, controller };
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
        if (!ownsRequest()) return;
        if (!isTrustedServerHlsManifestURL(next.url)) {
          throw new Error("The server returned an untrusted optimized playback URL.");
        }
        const manifestDeadline = Date.now() + SERVER_HLS_STARTUP_TIMEOUT_MS;
        let retryDelayMs = SERVER_OPTIMIZED_RETRY_BASE_MS;
        let manifest: string | null = null;
        let preparedAudioTrack = audioTrack ?? next.audioTrack;
        while (manifest == null) {
          if (!ownsRequest() || controller.signal.aborted) return;
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
          if (!ownsRequest()) return;
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
        if (!ownsRequest()) return;
        if (!manifest.startsWith("#EXTM3U")) {
          throw new Error("The server did not return a playable HLS manifest.");
        }
        if (!ownsRequest()) return;
        // Ordinary quality switches follow playback while the manifest warms.
        // An explicit out-of-window seek instead owns its requested position;
        // a late clock event from the old media must not undo that user action.
        const activationPosition = positionIntent === "fixed"
          ? position
          : latestAbsolutePositionRef.current;
        latestAbsolutePositionRef.current = activationPosition;
        const activationStart = Math.max(
          0,
          activationPosition - next.timelineOffsetSeconds,
        );
        const requestedHandoffState = typeof handoffState === "function"
          ? handoffState()
          : handoffState ?? null;
        if (!ownsRequest()) return;
        const activationHandoffState = currentWebviewHandoffState(requestedHandoffState);
        setFallbackSource(null);
        setSourceSwitchPosition({
          originOwner: owner,
          position: activationPosition,
        });
        setSourceSwitchState(activationHandoffState);
        setOptimizedSource({
          ...next,
          audioTrack: preparedAudioTrack,
          audioPreference,
          leaseTarget: serverHlsLeaseTarget(next.url, manifest),
          partialTimeline: /(?:^|\n)#EXT-X-PLAYLIST-TYPE:EVENT(?:\r?$|\s)/m.test(manifest),
          startPositionSeconds: activationStart,
          originOwner: owner,
        });
        recordDiagnostic("player", "server_optimized.ready", "info", quality);
      } catch (error) {
        if (!ownsRequest()) return;
        const message = error instanceof Error ? error.message : "The server could not prepare optimized playback.";
        setServerOptimizationError(message);
        recordDiagnostic("player", "server_optimized.failed", "warning", message);
      } finally {
        if (ownsRequest()) {
          optimizationPendingRef.current = null;
          setServerOptimizationPending(false);
        }
      }
    },
    [currentWebviewHandoffState, playbackOwner, serverOptimized],
  );

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
  // owner's explicit quality or mode control consumes it. Automatic seek,
  // audio, and error-recovery switches continue through the raw callbacks.
  const claimExplicitServerOptimizationChoice = useCallback(() => {
    if (
      !playerMountedRef.current ||
      playbackOwnerRef.current !== playbackOwner
    ) {
      return false;
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
  ): Promise<void> => {
    if (!claimExplicitServerOptimizationChoice()) return Promise.resolve();
    return switchToServerOptimized(
      quality,
      absolutePositionSeconds,
      handoffState,
      audioTrack,
      audioPreference,
      positionIntent,
    );
  }, [claimExplicitServerOptimizationChoice, switchToServerOptimized]);

  const selectDeviceOriginal = useCallback((
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => {
    if (!claimExplicitServerOptimizationChoice()) return;
    switchToDeviceOriginal(absolutePositionSeconds, handoffState);
  }, [claimExplicitServerOptimizationChoice, switchToDeviceOriginal]);

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
    void switchToServerOptimized(quality, latestAbsolutePositionRef.current);
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
    async (message: string, exactHandoffPending: boolean) => {
      const owner = playbackOwner;
      if (!playerMountedRef.current || playbackOwnerRef.current !== owner) return;
      recordDiagnostic("player", "webview.playback_failed", "error", message);
      if (activeOptimized != null) {
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
      const pendingForCurrentOwner = recoveryPendingRef.current?.owner === owner;
      if (pendingForCurrentOwner) return;
      if (
        effectiveEngine === "webview-direct" &&
        activeFallback == null &&
        requestWebviewFallback != null
      ) {
        const request = ++recoveryRequestSequenceRef.current;
        recoveryPendingRef.current = { owner, request };
        setWebRecoveryPending(true);
        setExternalActionStatus("Preparing a browser-compatible stream…");
        const recovered = await resolveWebviewFallbackForRequest(
          owner,
          request,
          requestWebviewFallback,
        );
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
        if (recovered) return;
      }
      setExternalError(message);
    }, [
      activeFallback,
      activeOptimized,
      activeSourceSwitchState,
      castSuspended,
      currentWebviewHandoffState,
      effectiveEngine,
      originalSourceIsServerOptimized,
      playbackOwner,
      resolveWebviewFallbackForRequest,
      requestWebviewFallback,
      setExternalActionStatus,
      switchToDeviceOriginal,
    ],
  );

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
        externalHandoffVideoRef.current?.pause();
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
            if (ownsRequest()) externalHandoffVideoRef.current?.pause();
          },
        );
        if (serverExternalRequestRef.current === controller) {
          serverExternalRequestRef.current = null;
        }
        if (status == null || !ownsRequest()) return;
        setExternalActionStatus(status);
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
        onPlaybackStall={recoverPostStartStall}
        onRetryFreshStream={refreshCurrentSource == null ? undefined : retryFreshStream}
        startPositionSeconds={effectiveStartPositionSeconds}
        sourceSwitchState={activeSourceSwitchState}
        timelineOffsetSeconds={effectiveTimelineOffsetSeconds}
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
        className={`player${sharedTouchPlayer ? " is-touch-player" : ""}`}
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

        {mode === "webview" && externalError == null ? (
          <WebviewPlayer
            key={`${effectiveUrl}:${sourceRevision}:${playbackAttempt}:${activeSourceSwitchPosition ?? "initial"}`}
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
            onChromeBlur={blurChrome}
            onActivity={nudgeChrome}
            onPausedChange={setWebviewPaused}
            onPendingHandoffPausedChange={updatePendingHandoffPaused}
            onVerifiedPlaybackProgress={reportVerifiedPlaybackProgress}
            onCaptionsOpenChange={setCaptionsOpen}
            onMenuOpenChange={setWebMenuOpen}
            onScrubbingChange={setWebScrubbing}
            onCastLocalPlaybackChange={setCastSuspended}
            suspended={castSuspended}
            onActiveSubtitleUrlChange={setActiveSubtitleUrl}
            onOpenShortcuts={() => setDetailsSection("shortcuts")}
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
            exactHandoff={activeOptimized != null}
            optimizedTimelineIsPartial={activeOptimized?.partialTimeline ?? initialServerOptimizedTimeline}
            externalHandoffVideoRef={externalHandoffVideoRef}
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
            serverOptimizationPending={serverOptimizationPending}
            serverOptimizationError={serverOptimizationError}
            onSwitchServerOptimized={switchToServerOptimized}
            onSelectServerOptimized={selectServerOptimized}
            onSelectDeviceOriginal={selectDeviceOriginal}
            onAbsolutePositionChange={reportAbsolutePosition}
            onPlaybackError={(message, exactHandoffPending) =>
              void handleWebviewPlaybackError(message, exactHandoffPending)
            }
            onPlaybackStall={recoverPostStartStall}
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
            onPlayNext={onPlayNext}
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
                  : lastStallContextRef.current != null && refreshCurrentSource != null
                  ? retryFreshStream
                  : () => {
                      recordDiagnostic("player", "webview.retry_requested");
                      setExternalError(null);
                      setPlaybackAttempt((attempt) => attempt + 1);
                    }
                : undefined
            }
            freshResolutionRequired={serverLeaseExpired}
            retryPending={manualRecoveryPending}
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
  onChromeBlur,
  onActivity,
  onPausedChange,
  onPendingHandoffPausedChange,
  onVerifiedPlaybackProgress,
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
  onPlaybackError,
  onPlaybackStall,
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
  serverOptimizationPending,
  serverOptimizationError,
  onSwitchServerOptimized,
  onSelectServerOptimized,
  onSelectDeviceOriginal,
  onAbsolutePositionChange,
}: {
  url: string;
  engine: PlaybackEngine;
  title: string;
  subtitle?: string | null;
  nowPlaying?: NowPlayingMetadata | null;
  detailsOpen: boolean;
  touchPlayer: boolean;
  chromeVisible: boolean;
  onChromeEnter: () => void;
  onChromeLeave: () => void;
  onChromeFocus: () => void;
  onChromeBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onActivity: () => void;
  onPausedChange: (paused: boolean) => void;
  onPendingHandoffPausedChange: (paused: boolean) => void;
  onVerifiedPlaybackProgress: () => void;
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
  onPlaybackError: (message: string, exactHandoffPending: boolean) => void;
  onPlaybackStall: (
    absolutePositionSeconds: number,
    handoffState: PlaybackHandoffState,
  ) => Promise<boolean>;
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
  serverOptimizationPending: boolean;
  serverOptimizationError: string | null;
  onSwitchServerOptimized: (
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
    audioTrack?: number,
    audioPreference?: AudioPreference,
    positionIntent?: ServerOptimizedPositionIntent,
  ) => Promise<void>;
  onSelectServerOptimized: (
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState | (() => PlaybackHandoffState),
    audioTrack?: number,
    audioPreference?: AudioPreference,
    positionIntent?: ServerOptimizedPositionIntent,
  ) => Promise<void>;
  onSelectDeviceOriginal: (
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => void;
  onAbsolutePositionChange: (absolutePositionSeconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const autoplayAttemptedRef = useRef(false);
  const pausedForCastRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const stallWatchdogRef = useRef<PlaybackStallWatchdog | null>(null);
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
  const verifiedPlaybackProgressReportedRef = useRef(false);
  const verifiedPlaybackPlayingRef = useRef(false);
  const lastObservedMediaTimeRef = useRef(0);
  const [playbackStatus, setPlaybackStatus] = useState<"starting" | "buffering" | "seeking" | null>(
    requiresExactHandoff ? "seeking" : "starting",
  );
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
  const updateScrubbing = useCallback((next: boolean) => {
    setScrubbing(next);
    onScrubbingChange(next);
  }, [onScrubbingChange]);
  useEffect(() => () => onScrubbingChange(false), [onScrubbingChange]);
  const rendererSeekingRef = useRef(false);
  const scrubbingRef = useRef(false);
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
    stallStateRef.current = {
      ...stallStateRef.current,
      suspended,
      seeking: scrubbing || rendererSeekingRef.current,
    };
    stallWatchdogRef.current?.update(stallStateRef.current);
  }, [scrubbing, suspended]);
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
  const touchLikePointerRef = useRef(false);
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
  }, [clearPendingTouchTap, engine, serverAudioOwner, timelineOffsetSeconds, url]);

  useEffect(() => () => {
    clearPendingTouchTap();
    if (touchFeedbackTimerRef.current != null) window.clearTimeout(touchFeedbackTimerRef.current);
  }, [clearPendingTouchTap]);

  const requestPlaybackState = useCallback((shouldPlay: boolean) => {
    const video = videoRef.current;
    if (video == null) return;
    if (
      exactHandoffPendingRef.current ||
      (suspendedRef.current && pendingHandoffPlaybackIntentRef.current != null)
    ) {
      pendingHandoffPlaybackIntentRef.current = shouldPlay ? "play" : "pause";
      onPendingHandoffPausedChange(!shouldPlay);
      setPaused(!shouldPlay);
      setPlaying(shouldPlay);
      onPausedChange(!shouldPlay);
      if (!shouldPlay && !video.paused) video.pause();
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
  }, [onPausedChange, onPendingHandoffPausedChange]);

  const applyDeferredHandoffPlayback = useCallback((
    video: HTMLVideoElement,
    shouldPlay: boolean,
  ) => {
    autoplayAttemptedRef.current = true;
    setPaused(!shouldPlay);
    setPlaying(shouldPlay);
    onPausedChange(!shouldPlay);
    if (shouldPlay && video.paused) {
      try {
        void video.play().catch(() => {});
      } catch {
        // Older WebKit versions can throw synchronously instead of rejecting.
      }
    } else if (!shouldPlay && !video.paused) {
      video.pause();
    }
  }, [onPausedChange]);

  const togglePlaybackState = useCallback(() => {
    const video = videoRef.current;
    if (video == null) return;
    const pendingIntent = pendingHandoffPlaybackIntentRef.current;
    const hasDeferredHandoffIntent = exactHandoffPendingRef.current ||
      (suspendedRef.current && pendingIntent != null);
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
      initialServerAudioTrackExplicit || activeServerAudioPreference != null;
  }, [
    activeServerAudioPreference,
    initialServerAudioTrackExplicit,
    initialServerAudioTracks,
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

  useEffect(() => {
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
      if (!active || videoRef.current !== video || updating) return;
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
        if (!active || videoRef.current !== video) return;
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
        if (!active || videoRef.current !== video) return;
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
  }, [engine, url]);
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
      if (!active || videoRef.current !== video || !video.isConnected) return;
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
  }, [engine, url]);
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
      if (reconcilingBrowserAudioSelectionRef.current) return;
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
  }, [savedPrefs, url]);

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
  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    let lastPosition = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    let lastBufferedFrontier = Number.NaN;
    const watchdog = new PlaybackStallWatchdog(() => {
      const position = Math.max(0, video.currentTime + timelineOffsetRef.current);
      const handoff: PlaybackHandoffState = {
        paused: false,
        volume: video.volume,
        muted: video.muted,
        playbackRate:
          Number.isFinite(video.playbackRate) && video.playbackRate > 0
            ? video.playbackRate
            : 1,
      };
      void onPlaybackStallRef.current(position, handoff);
    });
    stallWatchdogRef.current = watchdog;
    stallStateRef.current = {
      started: false,
      paused: true,
      seeking: false,
      suspended: suspendedRef.current,
      ended: false,
      tearingDown: false,
    };

    const sync = (patch: Partial<PlaybackStallState> = {}) => {
      stallStateRef.current = { ...stallStateRef.current, ...patch };
      watchdog.update(stallStateRef.current);
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
    const onPlaying = () => sync({ started: true, paused: false });
    const onPause = () => sync({ paused: true });
    const onEndedForWatchdog = () => sync({ ended: true, paused: true });
    const onSeeking = () => {
      rendererSeekingRef.current = true;
      sync({ seeking: true });
    };
    const onSeeked = () => {
      lastPosition = Number.isFinite(video.currentTime) ? video.currentTime : lastPosition;
      const frontier = bufferedFrontier();
      lastBufferedFrontier = Number.isFinite(frontier) ? frontier : lastPosition;
      rendererSeekingRef.current = false;
      sync({ seeking: scrubbingRef.current });
    };
    const onBufferProgress = () => {
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
        lastBufferedFrontier = next;
        watchdog.noteProgress();
      }
    };
    const onClockProgress = () => {
      const next = video.currentTime;
      if (Number.isFinite(next) && Math.abs(next - lastPosition) >= 0.05) {
        lastPosition = next;
        sync({ started: true });
        watchdog.noteProgress();
      }
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEndedForWatchdog);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", onClockProgress);
    video.addEventListener("progress", onBufferProgress);
    return () => {
      sync({ tearingDown: true });
      watchdog.stop();
      if (stallWatchdogRef.current === watchdog) stallWatchdogRef.current = null;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEndedForWatchdog);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onClockProgress);
      video.removeEventListener("progress", onBufferProgress);
    };
  }, [url]);

  useEffect(() => {
    const video = videoRef.current;
    if (video == null) return;
    didSeekRef.current = false;
    exactHandoffPendingRef.current = requiresExactHandoffRef.current;
    pendingHandoffPlaybackIntentRef.current = null;
    verifiedPlaybackProgressReportedRef.current = false;
    verifiedPlaybackPlayingRef.current = false;
    lastObservedMediaTimeRef.current = Number.isFinite(video.currentTime)
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
    const exactTarget = () => Math.max(0, startPositionRef.current ?? 0);
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
      if (exactHandoffPendingRef.current && !confirmExactHandoff()) {
        setPlaybackStatus("seeking");
        video.pause();
        return;
      }
      // Actual clock progress is stronger readiness evidence than a successful
      // play() dispatch and covers WebViews that omit an early canplay event.
      if (video.currentTime > 0) {
        startupReadyRef.current = true;
      }
      onAbsolutePositionChange(video.currentTime + timelineOffsetRef.current);
      const previousMediaTime = lastObservedMediaTimeRef.current;
      lastObservedMediaTimeRef.current = video.currentTime;
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
      if (didSeekRef.current) return;
      const start = startPositionRef.current ?? 0;
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
      if (Number.isFinite(video.duration)) {
        setDuration(video.duration);
        const sourceDuration = video.duration + timelineOffsetRef.current;
        if (sourceDuration > 0) onSourceDurationKnownRef.current?.(sourceDuration);
      }
      applyResume();
    };
    const onSeekedForResume = () => {
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
      if (exactHandoffPendingRef.current) {
        applyResume();
        return;
      }
      const absolutePosition = video.currentTime + timelineOffsetRef.current;
      const absoluteDuration = absoluteDurationFor(video.duration);
      if (
        optimizedTimelineIsPartial &&
        (absoluteDuration == null || absolutePosition < absoluteDuration - 10)
      ) {
        onAbsolutePositionChange(absolutePosition);
        onPlaybackErrorRef.current(
          "Server Optimized ended before the original media completed.",
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
      verifiedPlaybackPlayingRef.current = false;
      if (exactHandoffPendingRef.current) {
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
      if (suspendedRef.current || exactHandoffPendingRef.current) {
        video.pause();
        if (exactHandoffPendingRef.current) {
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
      if (video.volume > 0) lastAudibleVolumeRef.current = video.volume;
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onRateChange = () => setPlaybackRate(video.playbackRate);
    const onLoadStart = () => setPlaybackStatus(
      exactHandoffPendingRef.current ? "seeking" : "starting",
    );
    const onWaiting = () => setPlaybackStatus(
      exactHandoffPendingRef.current ? "seeking" : "buffering",
    );
    const onPlaying = () => {
      if (exactHandoffPendingRef.current) {
        video.pause();
        setPlaybackStatus("seeking");
        return;
      }
      verifiedPlaybackPlayingRef.current = true;
      lastObservedMediaTimeRef.current = Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0;
      startupReadyRef.current = true;
      setPlaybackStatus(null);
    };
    const onCanPlay = () => {
      if (exactHandoffPendingRef.current) {
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
        autoplayAttemptedRef.current ||
        suspendedRef.current ||
        exactHandoffPendingRef.current ||
        sourceSwitchStateRef.current?.paused === true
      ) return;
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
        !exactHandoffPendingRef.current &&
        onProgressRef.current != null &&
        video.currentTime > 0
      ) report();
      if (scrobbleContext != null) scrobblePlaybackStop(scrobbleContext, progressPct());
    };
  }, [
    applyDeferredHandoffPlayback,
    onAbsolutePositionChange,
    onPausedChange,
    onVerifiedPlaybackProgress,
    scrobbleContext,
    url,
  ]);

  useEffect(() => {
    startupReadyRef.current = false;
    setPlaybackStatus(exactHandoffPendingRef.current ? "seeking" : "starting");
  }, [url]);

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
  }, [engine, suspended, url]);

  const needsServerPreparation = isHls && serverOptimized != null && isTrustedServerHlsManifestURL(url);
  const [initialLeasePreparation, setInitialLeasePreparation] = useState<{ source: string; target: string | null } | null>(null);
  const leasePreparationReady = !needsServerPreparation || preparedLeaseTarget !== undefined || initialLeasePreparation?.source === url;
  const leaseTarget = preparedLeaseTarget !== undefined
    ? preparedLeaseTarget
    : initialLeasePreparation?.source === url ? initialLeasePreparation.target : null;
  const leaseExpiredCallbackRef = useRef(onServerLeaseExpired);
  useLayoutEffect(() => {
    leaseExpiredCallbackRef.current = onServerLeaseExpired;
  }, [onServerLeaseExpired]);
  const stopLeaseRef = useRef<() => void>(() => {});
  const leaseLastAttemptRef = useRef<{ target: string; at: number } | null>(null);

  useEffect(() => {
    if (!needsServerPreparation || preparedLeaseTarget !== undefined) return;
    const video = videoRef.current;
    const controller = new AbortController();
    let active = true;
    const owns = () => active && !controller.signal.aborted && videoRef.current === video;
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
        setInitialLeasePreparation({ source: url, target: serverHlsLeaseTarget(url, manifest) });
        return;
      }
    })().catch((error: unknown) => {
      if (active && videoRef.current === video) {
        onPlaybackErrorRef.current(error instanceof Error ? error.message : "Server playback preparation failed.", exactHandoffPendingRef.current);
      }
    });
    return () => { active = false; controller.abort(); };
  }, [needsServerPreparation, preparedLeaseTarget, url]);

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
    const owns = () => active && videoRef.current === video;
    const stop = () => {
      terminal = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
    stopLeaseRef.current = stop;
    const expired = () => {
      stop();
      leaseExpiredCallbackRef.current(url, Math.max(0, video.currentTime + timelineOffsetRef.current), {
        paused: video.paused, volume: video.volume, muted: video.muted, playbackRate: video.playbackRate,
      });
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
  }, [ended, leasePreparationReady, leaseTarget, serverOptimizationPending, suspended, url]);

  // Wire hls.js for HLS streams when the browser can't play them natively.
  useEffect(() => {
    const video = videoRef.current;
    if (video == null || !leasePreparationReady) return;
    nativeExactHlsFragmentRef.current = false;

    if (!isHls) {
      setNativeHlsPlayback(false);
      // Only (re)assign on an actual URL change - reassigning the same src
      // invokes the media load algorithm and restarts playback from 0.
      if (video.src !== url) video.src = url;
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
      if (video.src !== sourceUrl) video.src = sourceUrl;
      return;
    }

    // hls.js is ~151 KB gz and is reachable ONLY here: an .m3u8 the browser
    // cannot play natively. A static import pinned it into this chunk, so every
    // player open paid for it - including the native-mpv and direct-file paths
    // that return above and never touch it. Fetch it on demand instead.
    let cancelled = false;
    let instance: HlsInstance | null = null;
    let removeCaptionListeners = () => {};
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
      if (cancelled) return;
      const element = videoRef.current;
      if (element == null) return;
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
          if (element.src !== sourceUrl) element.src = sourceUrl;
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
      const refreshCaptions = () => {
        if (!cancelled && hlsRef.current === instance) captionControllerRef.current?.refresh();
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
        if (cancelled || !data.fatal || instance == null) return;
        const action = nextHlsRecovery(data.type, recovery);
        if (action === "retry-network") {
          recovery.networkRetries += 1;
          recordDiagnostic("player", "hls.network_recovery", "warning");
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(
            () => {
              retryTimer = undefined;
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
        onPlaybackErrorRef.current(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "The stream stopped responding after two retries. Try again or choose another stream."
            : "The stream could not be decoded. Try again or choose another stream.",
          exactHandoffPendingRef.current,
        );
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
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
        setHlsLevel(data.level);
      });
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
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
      removeCaptionListeners();
      instance?.destroy();
      if (hlsRef.current === instance) hlsRef.current = null;
      setHlsLevels([]);
      setHlsAudioTracks([]);
      setHlsAudioInventoryKnown(false);
    };
  }, [engine, url, isHls, leasePreparationReady]);

  const seekAbsolute = (t: number, allowPreparation = true) => {
    const video = videoRef.current;
    if (video == null || !Number.isFinite(t)) return;
    const knownDuration = knownAbsoluteDurationRef.current;
    if (knownDuration == null && !optimizedTimelineIsPartial) {
      const localDuration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Number.POSITIVE_INFINITY;
      const localTarget = Math.min(Math.max(t, 0), localDuration);
      video.currentTime = localTarget;
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
      video.currentTime = localTarget;
      scrubberRef.current?.setCurrentTime(
        knownDuration == null ? localTarget : absoluteTarget,
      );
      return;
    }
    // Pointer movement previews the local window without starting a server job.
    // Only the final release may replace it with a new optimized generation.
    if (!allowPreparation || serverOptimized == null || activeServerOptimizedQuality == null) return;
    const selected = serverAudioTracks.find(
      (track) => track.index === resolvedServerAudioTrack,
    );
    void onSwitchServerOptimized(
      activeServerOptimizedQuality,
      absoluteTarget,
      () => ({
        paused: video.paused,
        volume: video.volume,
        muted: video.muted,
        playbackRate: video.playbackRate,
      }),
      resolvedServerAudioTrack ?? undefined,
      activeServerAudioPreference ?? (selected == null ? undefined : {
        id: selected.id,
        language: selected.language,
      }),
      "fixed",
    );
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
    video.currentTime = localTarget;
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
    optionsTriggerRef.current?.focus({ preventScroll: true });
    if (!optionsOpen) optionsOriginRef.current = "settings";
    audioOptionsRequestedRef.current = false;
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
          applyMediaPlaybackRate(video, Math.max(0.5, video.playbackRate - 0.25));
          break;
        case ">":
          e.preventDefault();
          applyMediaPlaybackRate(video, Math.min(2, video.playbackRate + 0.25));
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
    touchLikePointerRef.current =
      event.pointerType === "touch" ||
      event.pointerType === "pen" ||
      window.matchMedia?.("(pointer: coarse)").matches === true;
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
    const touchLike =
      touchLikePointerRef.current ||
      window.matchMedia?.("(pointer: coarse)").matches === true;
    touchLikePointerRef.current = false;
    if (nestedDialogOpen) return;
    if (touchLike && !chromeVisible) {
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
    return {
      paused: video?.paused ?? paused,
      volume: video?.volume ?? volume,
      muted: video?.muted ?? muted,
      playbackRate: video?.playbackRate ?? playbackRate,
    };
  }, [muted, paused, playbackRate, volume]);

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
    void onSwitchServerOptimized(
      quality,
      absolutePlaybackPosition(),
      playbackHandoffState,
      next,
      { id: selected.id, language: selected.language },
    );
  };

  useEffect(() => {
    if (
      appliedServerAudioPreferenceRef.current ||
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
      findPreferredLanguageMatch(
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
    appliedServerAudioPreferenceRef.current = true;
    if (selected.index === resolvedServerAudioTrack || serverOptimized == null) return;
    const quality = activeServerOptimizedQuality ?? serverOptimized.defaultQuality ?? "480p";
    void onSwitchServerOptimized(
      quality,
      absolutePlaybackPosition(),
      playbackHandoffState,
      selected.index,
      { id: selected.id, language: selected.language },
    );
  }, [
    resolvedServerAudioTrack,
    activeServerOptimizedQuality,
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
  const audioShortcutAvailable = audioChoices.length > 1 || (
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
    audioShortcutRef.current?.focus({ preventScroll: true });
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
      optionsTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [audioShortcutAvailable, optionsOpen]);
  const touchAudioSheet = touchPlayer && optionsOriginRef.current === "audio";

  return (
    <div
      className={`webview-player${touchPlayer ? " is-touch-player" : ""}${suspended ? " is-casting" : ""}`}
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
          autoPlay
          playsInline
          crossOrigin={isTrustedServerStreamURL(url) ? "use-credentials" : undefined}
          x-webkit-airplay="allow"
          onPointerDown={handleVideoPointerDown}
          onClick={handleVideoClick}
          onDoubleClick={handleVideoDoubleClick}
          onError={(event) => {
            // hls.js owns its media errors and bounded recovery. Native HLS and
            // direct files still surface the media element's error here.
            if (isHls && hlsRef.current != null) {
              return;
            }
            const mediaError = event.currentTarget.error;
            // Older Android WebViews can emit an `error` event while trying to
            // resolve their internal default poster URI, without setting a
            // MediaError on the playable video. Treat only a real MediaError as
            // a playback failure; later readiness/progress remains authoritative.
            if (mediaError == null) return;
            stopLeaseRef.current();
            onPlaybackErrorRef.current(
              mediaErrorMessage(mediaError),
              exactHandoffPendingRef.current,
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

      {paused && !ended && subs.activeTrackId == null && embeddedCaptionState.activeTrackId == null &&
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
          onSeekPreview={(time) => seek(time, false)}
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
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                  <option value={speed} key={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`chip player-osd-icon-button${captionsOpen || subs.activeTrackId != null || embeddedCaptionState.activeTrackId != null ? " is-active" : ""}`}
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
      ) : (
        <div className="player-touch-controls">
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
              onClick={() => relativeSeek(-10)}
              aria-label="Back 10 seconds"
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name="rewind" size={23} />
              <span>Back 10</span>
            </button>
            <button
              type="button"
              className="chip player-touch-play"
              onClick={togglePlayback}
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
              tabIndex={chromeVisible ? undefined : -1}
            >
              <Icon name={playing ? "pause" : "play"} size={30} />
            </button>
            <button
              type="button"
              className="chip player-touch-skip"
              onClick={() => relativeSeek(10)}
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
              onSeekPreview={(time) => seek(time, false)}
              onScrubbingChange={updateScrubbing}
              disabled={!chromeVisible}
              touchPresentation
            />
            <div className="player-touch-actions" role="toolbar" aria-label="Playback actions">
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
                onClick={() => {
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
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                    <option value={speed} key={speed}>{speed}×</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="chip player-touch-action"
                onClick={() => setVideoFit((fit) => fit === "contain" ? "cover" : fit === "cover" ? "fill" : "contain")}
                aria-label={`Video fit, ${videoFit === "contain" ? "Fit" : videoFit === "cover" ? "Fill" : "Stretch"}`}
                tabIndex={chromeVisible ? undefined : -1}
              >
                <Icon name="sliders" size={18} />
                <span className="player-touch-action-label">Fit</span>
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
                  aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  aria-pressed={isFullscreen}
                  tabIndex={chromeVisible ? undefined : -1}
                >
                  <Icon name={isFullscreen ? "fullscreen-exit" : "fullscreen"} size={18} />
                  <span className="player-touch-action-label">Fullscreen</span>
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
              <button
                ref={optionsTriggerRef}
                type="button"
                className={`chip player-touch-action${optionsOpen && optionsOriginRef.current === "settings" ? " is-active" : ""}`}
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

      {optionsOpen && (
        <div
          ref={optionsDialogRef}
          className={`player-options-menu glass-lit${touchAudioSheet ? " is-touch-audio-sheet" : touchPlayer ? " is-touch-settings" : ""}`}
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
                  onClick={() => setVideoFit(fit)}
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
