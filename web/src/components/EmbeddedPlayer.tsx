// EmbeddedPlayer - the built-in libmpv player. Video renders on a native
// Metal/GL surface BEHIND the transparent webview; this component draws a
// premium control layer on top and drives libmpv over IPC (tauri-plugin-libmpv).
// Handles any container (MKV/HEVC/AV1) losslessly, unlike the <video> webview.
//
// Beyond a basic player: audio/subtitle track menus, playback speed, chapter
// navigation (with scrubber markers), buffered range, hover scrub preview,
// subtitle + audio sync, real fullscreen, gestures, and a full keyboard map.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  init,
  destroy,
  command,
  setProperty,
  getProperty,
  observeProperties,
  setVideoMarginRatio,
  addSubtitleTrack,
  setAudioPassthrough,
  setHdrPolicy,
  type MpvConfig,
  type MpvObservableProperty,
} from "../lib/renderPlayer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openInExternalPlayer } from "../lib/tauri";
import {
  findPreferredLanguageMatch,
  normalizeLanguagePreference,
} from "../lib/languagePreference";
import type { PlayerPreferenceDefaults } from "./VideoPlayer";
import {
  currentViewportPixelSize,
  type PixelSize,
  type PlaybackEngine,
} from "../lib/playbackEngine";
import type { PlaybackPrefs } from "../storage/models";
import type { SubtitleClient } from "../services/subtitles/OpenSubtitlesClient";
import type { Translator } from "../services/subtitles/SubtitleTranslator";
import { cuesToVTT } from "../services/subtitles/cues";
import { Icon } from "./Icon";
import { predictEpisodeEnd, type EndPrediction } from "../lib/endPredictor";
import type { ServerTranscodeQuality } from "../lib/serverApi";
import { CastControls } from "./CastControls";
import { CaptionsMenu } from "./player/CaptionsMenu";
import { useSubtitleTracks } from "./player/useSubtitleTracks";
import { PlayerInfoPopover } from "./player/PlayerInfoPopover";
import {
  PlayerPauseOverlay,
  type NowPlayingMetadata,
} from "./player/PlayerPauseOverlay";
import {
  scrobblePlaybackPause,
  scrobblePlaybackStart,
  scrobblePlaybackStop,
  type TraktScrobbleContext,
} from "../data/traktScrobble";
import "./EmbeddedPlayer.css";

interface PlaybackHandoffState {
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
}

interface Props {
  url: string;
  title: string;
  /** Optional secondary line (e.g. "S2 · E5 · Episode title"). */
  subtitle?: string | null;
  /** Optional Detail metadata used by the paused now-playing treatment. */
  nowPlaying?: NowPlayingMetadata | null;
  /** Raw resolved source name. Keep it in Playback information, not the title
   * bar, so human media metadata remains the playback context. */
  sourceFileName?: string | null;
  /** Short-lived server stream capability, passed outside the media URL. */
  playbackAuthorization?: string;
  startPositionSeconds?: number;
  /** Runtime state passed during an optimized-to-native backend switch. */
  sourceSwitchState?: PlaybackHandoffState | null;
  /** Original-media time represented by native time zero for a seek-offset
   * server transcode. */
  timelineOffsetSeconds?: number;
  /** Remembered audio/subtitle/speed for this title, restored after load. */
  savedPrefs?: PlaybackPrefs | null;
  /** Optional global defaults supplied by Settings. This component does not persist them. */
  playerPreferences?: PlayerPreferenceDefaults | null;
  /** Subtitle search and translation providers shared with the web player. */
  subtitleClient?: SubtitleClient | null;
  translator?: Translator | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Throttled progress + the current player prefs - feeds Continue Watching and
   * persists the audio/sub/speed choices for next time. */
  onProgress?: (current: number, duration: number, prefs?: PlaybackPrefs) => void;
  /** Terminal progress callback, before an EOF endcard can be dismissed. */
  onEnded?: (current: number, duration: number, prefs?: PlaybackPrefs) => void;
  /** Whether early trusted-credit playback may transition automatically. */
  autoCountdown?: boolean;
  /** Present for a series with a next episode - shows an "Up next" affordance. */
  onPlayNext?: () => void;
  /** Continue at the current position with the next compatible instant source. */
  onTryNextSource?: () => Promise<void>;
  nextLabel?: string | null;
  /** Renderer identity shown in the permanent playback-info popover. */
  engine?: PlaybackEngine;
  playbackDecision?: "Direct Play" | "Transcode";
  /** Give the parent one chance to switch to a compatible webview source when
   * native initialization or loading fails. Returning true means it recovered. */
  onPlaybackError?: (error: Error) => boolean | Promise<boolean>;
  /** Server Mode selector. Selecting a rendition transfers this native player
   * to credentialed webview HLS only after the manifest is ready. */
  serverOptimized?: {
    qualities: readonly ServerTranscodeQuality[];
  };
  activeServerOptimizedQuality?: ServerTranscodeQuality | null;
  serverOptimizationPending?: boolean;
  serverOptimizationError?: string | null;
  onSwitchServerOptimized?: (
    quality: ServerTranscodeQuality,
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => Promise<void>;
  onSwitchDeviceOriginal?: (
    absolutePositionSeconds: number,
    handoffState?: PlaybackHandoffState,
  ) => void;
  onAbsolutePositionChange?: (absolutePositionSeconds: number) => void;
  /** Immutable TMDB playback identity, snapshotted by Detail when Play opens. */
  scrobbleContext?: TraktScrobbleContext | null;
  onClose: () => void;
}

/** One selectable mpv track (audio or subtitle). */
interface Track {
  id: number;
  type: "audio" | "sub" | "video";
  title: string;
  lang: string | null;
  selected: boolean;
  codec: string | null;
  external: boolean;
  sourceUrl: string | null;
}
interface Chapter {
  title: string;
  time: number;
}
interface AudioDevice {
  name: string;
  description: string;
}

interface NativeUpNextState {
  reason: EndPrediction["reason"];
  earlyAutoAdvance: boolean;
  cancelWindowSeconds: number;
}

const OBSERVED: readonly MpvObservableProperty[] = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  // paused-for-cache is true ONLY when playback stalls waiting for the network
  // cache (the real "debrid is buffering" signal). We deliberately do NOT observe
  // core-idle: it's also true on every user pause + at EOF, which made the
  // buffering spinner appear over paused frames.
  ["paused-for-cache", "flag"],
  ["volume", "double", "none"],
  ["mute", "flag"],
  ["speed", "double", "none"],
  ["demuxer-cache-time", "double", "none"],
  ["aid", "string", "none"],
  ["sid", "string", "none"],
  ["track-list/count", "int64", "none"],
  ["eof-reached", "flag"],
  // Raw decoded dimensions power the permanent diagnostics. dwidth/dheight are
  // retained as a fallback for mpv builds that do not emit video-params subkeys.
  ["video-params/w", "int64", "none"],
  ["video-params/h", "int64", "none"],
  ["dwidth", "int64", "none"],
  ["dheight", "int64", "none"],
  ["container-fps", "double", "none"],
  ["estimated-vf-fps", "double", "none"],
  ["decoder-frame-drop-count", "int64", "none"],
  ["frame-drop-count", "int64", "none"],
  ["hwdec-current", "string", "none"],
  ["video-params/primaries", "string", "none"],
  ["video-params/gamma", "string", "none"],
  ["audio-device", "string", "none"],
];

const MPV_CONFIG: MpvConfig = {
  initialOptions: {
    // Video output, hardware decode, scaling, debanding, cache and subtitle
    // pickup are all chosen PER-OS by the Rust core (best_in_class_options) - a JS
    // override here would silently win over the platform-correct default (that's
    // the bug that pinned macOS to auto-safe software decode + a 150MiB cache).
    // Only set options the Rust side does NOT own:
    "keep-open": "yes", // don't tear down the render surface at EOF (end card)
    "sub-font-size": 44, // plain SRT/text subs; ASS keeps its own styling
    terminal: "no",
  },
  observedProperties: OBSERVED,
};

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] as const;
/** No reserved margin - the video fills edge-to-edge and centers; the control
 *  bar overlays it on a gradient scrim (like every modern streaming player). */
const VIDEO_MARGIN_BOTTOM = 0;

/** A file mpv ACCEPTS (loadfile succeeds) can still never decode a frame - no
 *  time-pos ever arrives - when the data is corrupt or the codec is one this
 *  build can't handle. The initial spinner would then spin forever with no error
 *  and no fallback. If we're still pre-first-frame this long after loadfile, we
 *  treat it as a native failure and hand off to the webview HLS transcode. This
 *  is the backstop; an mpv end-file ERROR event closes the common case faster.
 *  25s (not 10): a high-bitrate 4K debrid stream through a home-server proxy
 *  legitimately needs longer to probe and fill before the first frame, and the
 *  timer is re-armed whenever demuxer data is still flowing, so this only ever
 *  fires for genuinely dead streams. */
const FIRST_FRAME_WATCHDOG_MS = 25_000;
/** The native event stream may run at display cadence. The seek UI does not
 * need that precision, and keeping it at 5Hz leaves the rest of the chrome
 * completely out of the playback hot path. */
const SCRUBBER_UPDATE_INTERVAL_MS = 200;

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Return the Trakt percentage at a lifecycle event, never from a progress tick. */
function playbackProgressPct(current: number, duration: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (current / duration) * 100));
}

/** Parse mpv's `track-list` node into our typed tracks. */
function parseTracks(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const out: Track[] = [];
  for (const t of raw as Array<Record<string, unknown>>) {
    const type = t.type;
    if (type !== "audio" && type !== "sub" && type !== "video") continue;
    const id = typeof t.id === "number" ? t.id : Number(t.id);
    if (!Number.isFinite(id)) continue;
    const lang = typeof t.lang === "string" ? t.lang : null;
    const rawTitle = typeof t.title === "string" ? t.title : "";
    out.push({
      id,
      type,
      title: rawTitle,
      lang,
      selected: t.selected === true,
      codec: typeof t.codec === "string" ? t.codec : null,
      external: t.external === true,
      sourceUrl:
        typeof t["external-filename"] === "string" &&
        /^https?:\/\//i.test(t["external-filename"])
          ? t["external-filename"]
          : null,
    });
  }
  return out;
}

/** Match language metadata first, then fall back to the human track title.
 * Providers often emit `und` even when a useful title is present. */
function findPreferredTrack(
  preference: unknown,
  tracks: readonly Track[],
): Track | null {
  return findPreferredLanguageMatch(preference, tracks, (track) => track.lang)
    ?? findPreferredLanguageMatch(preference, tracks, (track) => track.title);
}

/** A human label for a track: its title, else language, else "Track N". */
function trackLabel(t: Track, index: number): string {
  const bits: string[] = [];
  if (t.title) bits.push(t.title);
  if (t.lang) bits.push(t.lang.toUpperCase());
  if (bits.length === 0) bits.push(`Track ${index + 1}`);
  const suffix = t.codec ? ` · ${t.codec}` : "";
  return bits.join(" · ") + suffix;
}

function parseChapters(raw: unknown): Chapter[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>)
    .map((c, i) => ({
      title: typeof c.title === "string" && c.title ? c.title : `Chapter ${i + 1}`,
      time: typeof c.time === "number" ? c.time : Number(c.time) || 0,
    }))
    .filter((c) => Number.isFinite(c.time));
}

function parseAudioDevices(raw: unknown): AudioDevice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (value == null || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || row.name.length === 0) return [];
    return [{
      name: row.name,
      description:
        typeof row.description === "string" && row.description.length > 0
          ? row.description
          : row.name,
    }];
  });
}

/** Let focused sliders, menu buttons, and text inputs keep their native keys.
 * Escape remains global so overlay layering is predictable. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el == null) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.tagName === "BUTTON" ||
    el.isContentEditable
  );
}

type MenuId = "audio" | "sub" | "speed" | "chapters" | "settings" | null;

interface NativeScrubberHandle {
  updatePlayback(
    next: Partial<{ pos: number; bufferedTo: number }>,
    immediate?: boolean,
  ): void;
}

interface NativeScrubberProps {
  duration: number;
  timelineOffsetSeconds: number;
  chapters: Chapter[];
  active: boolean;
  onSeek: (time: number) => void;
  onScrubbingChange?: (scrubbing: boolean) => void;
}

/**
 * The only player-chrome leaf which updates while playback advances. mpv can
 * report time and cache changes independently and much faster than a seek bar
 * can visibly change, so merge both into one capped state update here. When
 * the controls are hidden we retain only the latest refs and do no React work;
 * showing the controls flushes that latest value immediately.
 */
const NativeScrubber = memo(
  forwardRef<NativeScrubberHandle, NativeScrubberProps>(function NativeScrubber(
    {
      duration,
      timelineOffsetSeconds,
      chapters,
      active,
      onSeek,
      onScrubbingChange,
    },
    ref,
  ) {
    const [playback, setPlayback] = useState({ pos: 0, bufferedTo: 0 });
    const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
    const [showTotalDuration, setShowTotalDuration] = useState(false);
    const scrubRef = useRef<HTMLDivElement | null>(null);
    const pendingRef = useRef(playback);
    const activeRef = useRef(active);
    const timerRef = useRef<number | undefined>(undefined);

    activeRef.current = active;

    const flush = useCallback(() => {
      timerRef.current = undefined;
      if (!activeRef.current) return;
      const next = pendingRef.current;
      setPlayback((current) =>
        current.pos === next.pos && current.bufferedTo === next.bufferedTo
          ? current
          : next,
      );
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        updatePlayback(next, immediate = false) {
          pendingRef.current = { ...pendingRef.current, ...next };
          if (!activeRef.current && !immediate) return;
          if (immediate) {
            window.clearTimeout(timerRef.current);
            flush();
            return;
          }
          if (timerRef.current == null) {
            timerRef.current = window.setTimeout(flush, SCRUBBER_UPDATE_INTERVAL_MS);
          }
        },
      }),
      [flush],
    );

    useEffect(() => {
      if (active) flush();
      else window.clearTimeout(timerRef.current);
    }, [active, flush]);
    useEffect(
      () => () => window.clearTimeout(timerRef.current),
      [],
    );

    const timeAtClientX = useCallback(
      (clientX: number): number => {
        const el = scrubRef.current;
        if (el == null || duration <= 0) return 0;
        const rect = el.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return fraction * duration;
      },
      [duration],
    );
    const pct = (value: number) =>
      duration > 0 ? Math.min(100, Math.max(0, (value / duration) * 100)) : 0;

    return (
      <div className="embed-scrub-row">
        <span className="embed-time">
          {fmt(playback.pos + timelineOffsetSeconds)}
        </span>
        <div
          className="embed-scrub"
          ref={scrubRef}
          onPointerDown={(event) => {
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            onScrubbingChange?.(true);
            onSeek(timeAtClientX(event.clientX));
          }}
          onPointerMove={(event) => {
            const time = timeAtClientX(event.clientX);
            if (event.buttons === 1) onSeek(time);
            setHover({ x: event.clientX, t: time });
          }}
          onPointerUp={() => onScrubbingChange?.(false)}
          onPointerCancel={() => onScrubbingChange?.(false)}
          onPointerLeave={(event) => {
            setHover(null);
            if (event.buttons !== 1) onScrubbingChange?.(false);
          }}
          role="slider"
          aria-label="Seek"
          aria-valuemin={Math.round(timelineOffsetSeconds)}
          aria-valuemax={Math.round(duration + timelineOffsetSeconds)}
          aria-valuenow={Math.round(playback.pos + timelineOffsetSeconds)}
          tabIndex={0}
        >
          <div className="embed-scrub-track">
            <div
              className="embed-scrub-buffered"
              style={{ width: `${pct(Math.max(playback.bufferedTo, playback.pos))}%` }}
            />
            <div className="embed-scrub-played" style={{ width: `${pct(playback.pos)}%` }} />
            {chapters.length > 1 &&
              chapters.map((chapter, index) => (
                <span
                  key={index}
                  className="embed-scrub-chapter"
                  style={{ left: `${pct(chapter.time)}%` }}
                  title={chapter.title}
                />
              ))}
            <div className="embed-scrub-thumb" style={{ left: `${pct(playback.pos)}%` }} />
          </div>
          {hover && (
            <div
              className="embed-scrub-hover"
              style={{ left: `${Math.min(100, Math.max(0, pct(hover.t)))}%` }}
            >
              {fmt(hover.t + timelineOffsetSeconds)}
            </div>
          )}
        </div>
        <button
          type="button"
          className="embed-time embed-time-toggle"
          onClick={() => setShowTotalDuration((showingTotal) => !showingTotal)}
          aria-label={showTotalDuration ? "Show remaining time" : "Show total duration"}
          title={showTotalDuration ? "Show remaining time" : "Show total duration"}
        >
          {showTotalDuration
            ? fmt(duration + timelineOffsetSeconds)
            : `-${fmt(Math.max(0, duration - playback.pos))}`}
        </button>
      </div>
    );
  }),
);

function chapterIndexAt(pos: number, chapters: readonly Chapter[]): number {
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    if (pos >= chapters[index].time) return index;
  }
  return -1;
}

export function EmbeddedPlayer({
  url,
  title,
  subtitle,
  nowPlaying,
  sourceFileName,
  playbackAuthorization,
  startPositionSeconds = 0,
  sourceSwitchState = null,
  timelineOffsetSeconds = 0,
  savedPrefs,
  playerPreferences = null,
  subtitleClient = null,
  translator = null,
  imdbId = null,
  season = null,
  episode = null,
  onProgress,
  onEnded,
  autoCountdown = true,
  onPlayNext,
  onTryNextSource,
  nextLabel,
  engine = "native-mpv",
  playbackDecision = "Direct Play",
  onPlaybackError,
  serverOptimized,
  activeServerOptimizedQuality = null,
  serverOptimizationPending = false,
  serverOptimizationError = null,
  onSwitchServerOptimized,
  onSwitchDeviceOriginal,
  onAbsolutePositionChange,
  scrobbleContext = null,
  onClose,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [dur, setDur] = useState(0);
  const [buffering, setBuffering] = useState(true);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState<MenuId>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [activeAid, setActiveAid] = useState<string>("auto");
  const [activeSid, setActiveSid] = useState<string>("auto");
  const [subDelay, setSubDelay] = useState(() => savedPrefs?.subtitleDelay ?? 0);
  const [subPosition, setSubPosition] = useState(
    () => savedPrefs?.subtitlePosition ?? 90,
  );
  const [audioDelay, setAudioDelay] = useState(0);
  const [subScale, setSubScale] = useState(1);
  const [videoZoom, setVideoZoom] = useState(0);
  const [videoPanX, setVideoPanX] = useState(0);
  const [videoPanY, setVideoPanY] = useState(0);
  const [videoAspect, setVideoAspect] = useState("-1");
  const [ended, setEnded] = useState(false);
  // This state is intentionally transition-only. The mpv clock can emit many
  // events per second, so its hot path compares refs and only re-renders when
  // the up-next card changes visibility or policy.
  const [upNextState, setUpNextState] = useState<NativeUpNextState | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [activeChapterIndex, setActiveChapterIndex] = useState(-1);
  const [detailsSection, setDetailsSection] = useState<"info" | "shortcuts" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [castSuspended, setCastSuspended] = useState(false);
  const [captionsSearchOpen, setCaptionsSearchOpen] = useState(false);
  const [subtitleAttachError, setSubtitleAttachError] = useState<string | null>(null);
  const [playbackSettingError, setPlaybackSettingError] = useState<string | null>(null);
  const [nativeReadyUrl, setNativeReadyUrl] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [audioDevice, setAudioDevice] = useState("auto");
  const [audioPassthrough, setAudioPassthroughEnabled] = useState(false);
  const [hdrPolicy, setHdrPolicyValue] = useState<"auto" | "preserve" | "tone-map">("auto");
  const onAbsolutePositionChangeRef = useRef(onAbsolutePositionChange);
  onAbsolutePositionChangeRef.current = onAbsolutePositionChange;
  const [containerFps, setContainerFps] = useState(0);
  const [outputFps, setOutputFps] = useState(0);
  const [decoderDrops, setDecoderDrops] = useState(0);
  const [displayDrops, setDisplayDrops] = useState(0);
  const [hardwareDecoder, setHardwareDecoder] = useState("");
  const [colorPrimaries, setColorPrimaries] = useState("");
  const [transferFunction, setTransferFunction] = useState("");
  const subtitleSearch = useSubtitleTracks(subtitleClient, translator);
  // Source dimensions are diagnostic only. Player chrome is deliberately never
  // fitted to this rectangle: it belongs to the window, while mpv owns genuine
  // source-aspect letterboxing inside its full-window native surface.
  const [sourceW, setSourceW] = useState(0);
  const [sourceH, setSourceH] = useState(0);
  const [videoW, setVideoW] = useState(0);
  const [videoH, setVideoH] = useState(0);
  const [displaySize, setDisplaySize] = useState<PixelSize | null>(() =>
    currentViewportPixelSize(),
  );
  const displaySizeRef = useRef<PixelSize | null>(displaySize);

  const startedRef = useRef(false);
  // Cleared once the first frame is shown; until then the initial buffering=true
  // (the debrid fetch) stays up, and an early paused-for-cache=false can't clear it.
  const firstFrameRef = useRef(false);
  const lastReportRef = useRef(0);
  const posRef = useRef(0);
  const durRef = useRef(0);
  const timelineOffsetRef = useRef(0);
  timelineOffsetRef.current =
    Number.isFinite(timelineOffsetSeconds) && timelineOffsetSeconds > 0
      ? timelineOffsetSeconds
      : 0;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onPlayNextRef = useRef(onPlayNext);
  onPlayNextRef.current = onPlayNext;
  const onPlaybackErrorRef = useRef(onPlaybackError);
  onPlaybackErrorRef.current = onPlaybackError;
  const playerPreferencesRef = useRef(playerPreferences);
  playerPreferencesRef.current = playerPreferences;
  const sourceSwitchStateRef = useRef(sourceSwitchState);
  sourceSwitchStateRef.current = sourceSwitchState;
  const hideTimer = useRef<number | undefined>(undefined);
  const stageClickTimer = useRef<number | undefined>(undefined);
  const scrubberRef = useRef<NativeScrubberHandle | null>(null);
  const activeChapterIndexRef = useRef(-1);
  const pausedRef = useRef(paused);
  const endedRef = useRef(false);
  const lastAudibleVolume = useRef(100);
  const menuOpenRef = useRef(false);
  const nativeSubtitleIdsRef = useRef<Map<string, number>>(new Map());
  const nativeCustomSubtitleActiveRef = useRef(false);
  const wasCastSuspendedRef = useRef(false);
  const castSuspendedRef = useRef(castSuspended);
  const pausedBeforeCastRef = useRef(false);
  menuOpenRef.current =
    menu != null || detailsSection != null || captionsSearchOpen;
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const upNextStateRef = useRef<NativeUpNextState | null>(null);
  const upNextDismissedRef = useRef(false);
  const upNextWarningShownRef = useRef(false);
  const autoCountdownRef = useRef(autoCountdown);
  autoCountdownRef.current = autoCountdown;

  const setPredictiveUpNext = (next: NativeUpNextState | null) => {
    const previous = upNextStateRef.current;
    if (
      previous?.reason === next?.reason &&
      previous?.earlyAutoAdvance === next?.earlyAutoAdvance &&
      previous?.cancelWindowSeconds === next?.cancelWindowSeconds
    ) return;
    upNextStateRef.current = next;
    if (next != null && next.reason !== "eof") upNextWarningShownRef.current = true;
    setUpNextState(next);
  };
  const evaluatePredictiveUpNext = () => {
    const prediction = predictEpisodeEnd({
      position: posRef.current,
      duration: durRef.current,
      playing: !pausedRef.current && !endedRef.current,
      eligible: onPlayNextRef.current != null,
      chapters: chaptersRef.current,
      dismissed: upNextDismissedRef.current,
    });
    setPredictiveUpNext(prediction.show
      ? {
          reason: prediction.reason,
          earlyAutoAdvance: prediction.earlyAutoAdvance,
          cancelWindowSeconds: prediction.cancelWindowSeconds,
        }
      : null);
  };

  durRef.current = dur;
  pausedRef.current = paused;
  castSuspendedRef.current = castSuspended;

  const reportedPosition = () =>
    posRef.current + timelineOffsetRef.current;
  const reportedDuration = () =>
    durRef.current > 0
      ? durRef.current + timelineOffsetRef.current
      : durRef.current;
  const reportedProgressPct = () =>
    playbackProgressPct(reportedPosition(), reportedDuration());
  const handoffState = (): PlaybackHandoffState => ({
    paused: pausedRef.current,
    volume: Math.min(1, Math.max(0, volume / 100)),
    muted,
    playbackRate: speed,
  });

  const audioTracks = useMemo(() => tracks.filter((t) => t.type === "audio"), [tracks]);
  const volumeIsSilent = muted || volume === 0;
  const subTracks = useMemo(() => tracks.filter((t) => t.type === "sub"), [tracks]);
  const activeSubtitleUrl = useMemo(
    () =>
      subTracks.find((track) => String(track.id) === activeSid)?.sourceUrl ??
      null,
    [activeSid, subTracks],
  );

  useEffect(() => {
    if (castSuspended && !wasCastSuspendedRef.current) {
      pausedBeforeCastRef.current = pausedRef.current;
      void setProperty("pause", true).catch(() => {});
    } else if (!castSuspended && wasCastSuspendedRef.current) {
      if (!pausedBeforeCastRef.current) {
        void setProperty("pause", false).catch(() => {});
      }
    }
    wasCastSuspendedRef.current = castSuspended;
  }, [castSuspended]);

  // Page transparent + app UI hidden so the native mpv surface shows through.
  useEffect(() => {
    document.documentElement.classList.add("mpv-active");
    return () => document.documentElement.classList.remove("mpv-active");
  }, []);

  // Track the full-window native surface for the diagnostic popover. Backing
  // pixels make this directly comparable to mpv's decoded source dimensions.
  // Browser resize events can arrive in bursts, so coalesce them and skip state
  // work when the native surface's backing-pixel geometry has not changed.
  useEffect(() => {
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const next = currentViewportPixelSize();
      const previous = displaySizeRef.current;
      if (
        previous?.width === next?.width &&
        previous?.height === next?.height
      ) {
        return;
      }
      displaySizeRef.current = next;
      setDisplaySize(next);
    };
    const scheduleMeasure = () => {
      if (frame == null) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Refresh the track + chapter lists from mpv (after load, and on menu open).
  const refreshTracks = useCallback(async () => {
    try {
      const raw = await getProperty("track-list", "node");
      setTracks(parseTracks(raw));
    } catch {
      /* ignore - menu just shows "none" */
    }
  }, []);
  const refreshChapters = useCallback(async () => {
    try {
      const raw = await getProperty("chapter-list", "node");
      const nextChapters = parseChapters(raw);
      setChapters(nextChapters);
      const nextChapterIndex = chapterIndexAt(posRef.current, nextChapters);
      if (activeChapterIndexRef.current !== nextChapterIndex) {
        activeChapterIndexRef.current = nextChapterIndex;
        setActiveChapterIndex(nextChapterIndex);
      }
    } catch {
      /* ignore */
    }
  }, []);
  const refreshAudioDevices = useCallback(async () => {
    try {
      const raw = await getProperty("audio-device-list", "node");
      setAudioDevices(parseAudioDevices(raw));
    } catch {
      setAudioDevices([]);
    }
  }, []);

  // A URL change creates a new mpv instance and removes the old process-owned
  // subtitle directory. Clear the old id map before the attachment effect runs
  // so an active searched track is materialized again for the new source.
  useEffect(() => {
    nativeSubtitleIdsRef.current.clear();
    nativeCustomSubtitleActiveRef.current = false;
    setSubtitleAttachError(null);
  }, [url]);

  // OpenSubtitles and translated tracks are generated as browser Blob URLs by
  // the shared subtitle hook. Materialize each active WebVTT track through the
  // dedicated native command once, then select the returned mpv track id.
  useEffect(() => {
    let cancelled = false;
    if (nativeReadyUrl !== url) return;
    const active = subtitleSearch.tracks.find(
      (track) => track.id === subtitleSearch.activeTrackId,
    );
    if (active == null) {
      if (nativeCustomSubtitleActiveRef.current) {
        nativeCustomSubtitleActiveRef.current = false;
        setActiveSid("no");
        void setProperty("sid", "no");
      }
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        let nativeId = nativeSubtitleIdsRef.current.get(active.id);
        if (nativeId == null) {
          nativeId = await addSubtitleTrack(
            cuesToVTT(active.cues),
            active.label,
            normalizeLanguagePreference(active.language) ?? "und",
          );
          nativeSubtitleIdsRef.current.set(active.id, nativeId);
          await refreshTracks();
        }
        if (cancelled) return;
        nativeCustomSubtitleActiveRef.current = true;
        setSubtitleAttachError(null);
        setActiveSid(String(nativeId));
        setSubDelay(active.delayMs / 1000);
        await Promise.all([
          setProperty("sid", String(nativeId)),
          setProperty("sub-delay", active.delayMs / 1000),
        ]);
      } catch (error) {
        if (!cancelled) {
          setSubtitleAttachError(
            error instanceof Error
              ? error.message
              : "The subtitle track could not be attached.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    refreshTracks,
    nativeReadyUrl,
    subtitleSearch.activeTrackId,
    subtitleSearch.tracks,
    url,
  ]);

  // ── libmpv lifecycle: init → observe → load; destroy on unmount ────────────
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBuffering(true);
    setPaused(false);
    setNativeReadyUrl(null);
    // A single gate so the three native-failure signals - an init/loadfile throw,
    // an mpv end-file ERROR event, and the first-frame watchdog - can each request
    // the webview fallback, but only the FIRST one does (later ones no-op).
    let fallbackTried = false;
    // Armed after loadfile; fires if no first frame arrives in time.
    let watchdog: number | undefined;
    let retryTimer: number | undefined;
    let trackRefreshTimer: number | undefined;
    firstFrameRef.current = false; // new file: show the initial spinner again
    startedRef.current = false;
    lastReportRef.current = 0;
    endedRef.current = false;
    autoAdvanceFiredRef.current = false;
    upNextDismissedRef.current = false;
    upNextWarningShownRef.current = false;
    setUpNextDismissed(false);
    setPredictiveUpNext(null);
    posRef.current = 0;
    durRef.current = 0;
    scrubberRef.current?.updatePlayback({ pos: 0, bufferedTo: 0 }, true);
    activeChapterIndexRef.current = -1;
    setActiveChapterIndex(-1);
    setSourceW(0);
    setSourceH(0);
    setVideoW(0);
    setVideoH(0);
    setContainerFps(0);
    setOutputFps(0);
    setDecoderDrops(0);
    setDisplayDrops(0);
    setHardwareDecoder("");
    setColorPrimaries("");
    setTransferFunction("");
    let unlisten: (() => void) | undefined;

    // Route every native-failure signal through one place: ask the parent to
    // switch to a compatible webview source (the HLS transcode, which is handed
    // the SAME startPositionSeconds, so resume is preserved across the swap), and
    // only when it can't recover fall through to the built-in error card. Runs at
    // most once per file - a decode error and the watchdog can't double-fire it.
    const triggerNativeFallback = async (err: Error): Promise<void> => {
      if (cancelled || fallbackTried) return;
      fallbackTried = true;
      window.clearTimeout(watchdog); // a concrete signal supersedes the watchdog
      let recovered = false;
      if (onPlaybackErrorRef.current != null) {
        try {
          recovered = (await onPlaybackErrorRef.current(err)) === true;
        } catch {
          // The native error card remains the terminal fallback.
        }
      }
      if (!cancelled && !recovered) setError(err.message);
    };

    // (Re-)arm the first-frame watchdog. Called after loadfile and again on
    // every demuxer-progress event, so only a genuinely stalled stream trips
    // it - slow-but-flowing 4K debrid links keep resetting the clock.
    const armWatchdog = (): void => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (cancelled || firstFrameRef.current) return;
        void triggerNativeFallback(
          new Error("Native playback produced no frame in time"),
        );
      }, FIRST_FRAME_WATCHDOG_MS);
    };

    void (async () => {
      try {
        await init(MPV_CONFIG);
        if (cancelled) {
          return;
        }
        await setVideoMarginRatio({ bottom: VIDEO_MARGIN_BOTTOM });
        const observedUnlisten = await observeProperties(
          OBSERVED,
          (ev: { name: string; data: unknown }) => {
            // A late event can arrive after unmount (before unlisten lands) or
            // after the guarded teardown - never touch state on a dead component.
            if (cancelled) return;
            switch (ev.name) {
              case "pause":
                setPaused(Boolean(ev.data));
                if (ev.data === false) evaluatePredictiveUpNext();
                if (scrobbleContext != null) {
                  if (ev.data === true && !endedRef.current) {
                    scrobblePlaybackPause(
                      scrobbleContext,
                      reportedProgressPct(),
                    );
                  } else if (ev.data === false && startedRef.current) {
                    scrobblePlaybackStart({
                      ...scrobbleContext,
                      progressPct: reportedProgressPct(),
                    });
                  }
                }
                break;
              case "time-pos":
                if (typeof ev.data === "number") {
                  // Keep command/keyboard math exact at native event cadence,
                  // while NativeScrubber coalesces its React state to 5Hz.
                  const previousPosition = posRef.current;
                  posRef.current = ev.data;
                  onAbsolutePositionChangeRef.current?.(reportedPosition());
                  if (ev.data < previousPosition - 2) {
                    upNextDismissedRef.current = false;
                    setUpNextDismissed(false);
                  }
                  evaluatePredictiveUpNext();
                  scrubberRef.current?.updatePlayback({ pos: ev.data });
                  if (chaptersRef.current.length > 0) {
                    const nextChapterIndex = chapterIndexAt(
                      ev.data,
                      chaptersRef.current,
                    );
                    if (activeChapterIndexRef.current !== nextChapterIndex) {
                      activeChapterIndexRef.current = nextChapterIndex;
                      setActiveChapterIndex(nextChapterIndex);
                    }
                  }
                  // First position report ≈ first frame shown → drop the
                  // initial-load spinner and stand the watchdog down.
                  if (!firstFrameRef.current) {
                    firstFrameRef.current = true;
                    setBuffering(false);
                    window.clearTimeout(watchdog);
                    if (scrobbleContext != null) {
                      scrobblePlaybackStart({
                        ...scrobbleContext,
                        progressPct: reportedProgressPct(),
                      });
                    }
                  }
                  const now = Date.now();
                  if (
                    startedRef.current &&
                    durRef.current > 0 &&
                    now - lastReportRef.current >= 5000
                  ) {
                    lastReportRef.current = now;
                    onProgressRef.current?.(
                      reportedPosition(),
                      reportedDuration(),
                      prefsRef.current,
                    );
                  }
                }
                break;
              case "duration":
                if (typeof ev.data === "number") {
                  durRef.current = ev.data;
                  setDur(ev.data);
                  evaluatePredictiveUpNext();
                }
                break;
              case "paused-for-cache":
                // Only a real cache stall (after playback has started) toggles the
                // spinner; before the first frame the initial spinner owns it.
                if (firstFrameRef.current) setBuffering(Boolean(ev.data));
                break;
              case "volume":
                if (typeof ev.data === "number") {
                  const nextVolume = Math.round(ev.data);
                  setVolume(nextVolume);
                  if (nextVolume > 0) lastAudibleVolume.current = nextVolume;
                }
                break;
              case "mute":
                setMuted(Boolean(ev.data));
                break;
              case "speed":
                if (typeof ev.data === "number") setSpeed(ev.data);
                break;
              case "demuxer-cache-time":
                // Absolute timestamp of the last buffered demuxer data (the
                // time-ahead quantity is demuxer-cache-duration, a different
                // property), so it maps directly onto the seek bar.
                if (typeof ev.data === "number") {
                  scrubberRef.current?.updatePlayback({
                    bufferedTo: Math.max(0, ev.data),
                  });
                  // Data is still flowing: the stream is alive, just slow.
                  // Re-arm the first-frame watchdog so big debrid remuxes get
                  // their full probe time instead of a false failure.
                  if (!firstFrameRef.current) armWatchdog();
                }
                break;
              case "aid":
                setActiveAid(ev.data == null ? "no" : String(ev.data));
                break;
              case "sid":
                setActiveSid(ev.data == null ? "no" : String(ev.data));
                break;
              case "track-list/count":
                void refreshTracks();
                break;
              case "eof-reached":
                if (ev.data === true) {
                  endedRef.current = true;
                  setPredictiveUpNext(
                    onPlayNextRef.current == null
                      ? null
                      : { reason: "eof", earlyAutoAdvance: false, cancelWindowSeconds: 10 },
                  );
                  if (onEndedRef.current != null) {
                    onEndedRef.current(
                      reportedPosition(), reportedDuration(), prefsRef.current,
                    );
                  } else {
                    onProgressRef.current?.(
                      reportedPosition(), reportedDuration(), prefsRef.current,
                    );
                  }
                  setEnded(true);
                  if (
                    autoCountdownRef.current &&
                    upNextWarningShownRef.current &&
                    !upNextDismissedRef.current &&
                    !autoAdvanceFiredRef.current
                  ) {
                    autoAdvanceFiredRef.current = true;
                    onPlayNextRef.current?.();
                  }
                  if (scrobbleContext != null) {
                    scrobblePlaybackStop(
                      scrobbleContext,
                      reportedProgressPct(),
                    );
                  }
                }
                break;
              // A genuine playback FAILURE reported by mpv AFTER loadfile
              // succeeded (corrupt data / an undecodable codec) - the case the
              // init try/catch can't see, because loadfile returns success and the
              // decode error only surfaces here. Only reason=ERROR reaches us (the
              // Rust core never forwards a normal EOF/stop/quit/redirect), so any
              // end-file event is a hand-off to the webview transcode.
              case "end-file": {
                const d = ev.data as { error?: boolean; code?: number } | null;
                if (d?.error) {
                  void triggerNativeFallback(
                    new Error(
                      `Native playback failed (mpv error ${d.code ?? "unknown"})`,
                    ),
                  );
                }
                break;
              }
              case "video-params/w":
                if (typeof ev.data === "number") setSourceW(ev.data);
                break;
              case "video-params/h":
                if (typeof ev.data === "number") setSourceH(ev.data);
                break;
              case "dwidth":
                if (typeof ev.data === "number") setVideoW(ev.data);
                break;
              case "dheight":
                if (typeof ev.data === "number") setVideoH(ev.data);
                break;
              case "container-fps":
                if (typeof ev.data === "number") setContainerFps(ev.data);
                break;
              case "estimated-vf-fps":
                if (typeof ev.data === "number") setOutputFps(ev.data);
                break;
              case "decoder-frame-drop-count":
                if (typeof ev.data === "number") setDecoderDrops(ev.data);
                break;
              case "frame-drop-count":
                if (typeof ev.data === "number") setDisplayDrops(ev.data);
                break;
              case "hwdec-current":
                setHardwareDecoder(typeof ev.data === "string" ? ev.data : "");
                break;
              case "video-params/primaries":
                setColorPrimaries(typeof ev.data === "string" ? ev.data : "");
                break;
              case "video-params/gamma":
                setTransferFunction(typeof ev.data === "string" ? ev.data : "");
                break;
              case "audio-device":
                setAudioDevice(
                  typeof ev.data === "string" && ev.data.length > 0
                    ? ev.data
                    : "auto",
                );
                break;
            }
          },
        );
        if (cancelled) {
          observedUnlisten();
          return;
        }
        unlisten = observedUnlisten;
        const resumeSeconds =
          Number.isFinite(startPositionSeconds) && startPositionSeconds > 5
            ? Math.floor(startPositionSeconds)
            : null;
        setEnded(false);
        // mpv 0.38 inserted a playlist-index argument before the per-file options
        // argument. Even with `replace`, the ignored index slot must be present or
        // `start=+N` is parsed as an integer index and rejected with Raw(-4).
        const loadArgs =
          resumeSeconds == null
            ? [url]
            : [url, "replace", "-1", `start=+${resumeSeconds}`];
        const loadOnce = () =>
          playbackAuthorization == null
            ? command("loadfile", loadArgs)
            : command("loadfile", loadArgs, playbackAuthorization);
        try {
          await loadOnce();
        } catch {
          // One silent retry: debrid CDNs and proxies throw transient errors on
          // first touch (cold cache, 502s) that a fresh attempt clears, and
          // these used to count as instant player failures.
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, 800);
          });
          retryTimer = undefined;
          if (cancelled) return;
          await loadOnce();
        }
        const configuredPreferences = playerPreferencesRef.current;
        const configuredVolume = configuredPreferences?.defaultVolume;
        if (configuredVolume != null && Number.isFinite(configuredVolume)) {
          const initialVolume = Math.round(Math.min(100, Math.max(0, configuredVolume)));
          setVolume(initialVolume);
          setMuted(initialVolume === 0);
          if (initialVolume > 0) lastAudibleVolume.current = initialVolume;
          await setProperty("volume", initialVolume);
          await setProperty("mute", initialVolume === 0);
        }
        const titleSpeed = configuredPreferences?.rememberPerTitleTrackChoices === false
          ? null
          : savedPrefs?.playbackSpeed;
        const initialSpeed = titleSpeed ?? configuredPreferences?.defaultPlaybackSpeed;
        if (initialSpeed != null && Number.isFinite(initialSpeed) && initialSpeed > 0) {
          setSpeed(initialSpeed);
          await setProperty("speed", initialSpeed);
        }
        const restoredSubDelay = savedPrefs?.subtitleDelay;
        if (restoredSubDelay != null && Number.isFinite(restoredSubDelay)) {
          setSubDelay(restoredSubDelay);
          await setProperty("sub-delay", restoredSubDelay);
        }
        const restoredSubPosition = savedPrefs?.subtitlePosition;
        if (
          restoredSubPosition != null &&
          Number.isFinite(restoredSubPosition) &&
          restoredSubPosition >= 0 &&
          restoredSubPosition <= 100
        ) {
          setSubPosition(restoredSubPosition);
          await setProperty("sub-pos", restoredSubPosition);
        }
        // A backend switch overrides saved defaults only after the native source
        // has loaded. This preserves the viewer's in-session controls rather
        // than resetting them while returning from optimized HLS.
        const handoff = sourceSwitchStateRef.current;
        if (handoff != null) {
          const handoffVolume = Math.round(Math.min(1, Math.max(0, handoff.volume)) * 100);
          const handoffRate = Number.isFinite(handoff.playbackRate) && handoff.playbackRate > 0
            ? handoff.playbackRate
            : 1;
          setVolume(handoffVolume);
          setMuted(handoff.muted);
          setSpeed(handoffRate);
          setPaused(handoff.paused);
          if (handoffVolume > 0) lastAudibleVolume.current = handoffVolume;
          await setProperty("volume", handoffVolume);
          await setProperty("mute", handoff.muted);
          await setProperty("speed", handoffRate);
          await setProperty("pause", handoff.paused);
        } else {
          // Configure gain before unpausing so a non-default stream never emits a
          // frame of loud audio while the volume preference is still in flight.
          await setProperty("pause", false);
        }
        if (castSuspendedRef.current) {
          await setProperty("pause", true);
        }
        startedRef.current = true;
        setNativeReadyUrl(url);
        // Arm the first-frame watchdog. loadfile has been accepted, but mpv can
        // still stall forever without ever decoding a frame; if we're still
        // pre-first-frame after the window (and no demuxer progress re-arms
        // it), hand off to the webview transcode.
        armWatchdog();
        // Tracks/chapters populate a beat after the file loads.
        trackRefreshTimer = window.setTimeout(() => {
          trackRefreshTimer = undefined;
          if (!cancelled) {
            void refreshTracks();
            void refreshChapters();
          }
        }, 700);
      } catch (e) {
        const playbackError = e instanceof Error ? e : new Error(String(e));
        await triggerNativeFallback(playbackError);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      window.clearTimeout(retryTimer);
      window.clearTimeout(trackRefreshTimer);
      unlisten?.();
      void destroy().catch(() => {});
      if (scrobbleContext != null) {
        scrobblePlaybackStop(
          scrobbleContext,
          reportedProgressPct(),
        );
      }
    };
  }, [
    url,
    playbackAuthorization,
    startPositionSeconds,
    refreshTracks,
    refreshChapters,
    scrobbleContext,
  ]);

  // Keep the current player prefs in a ref so the throttled/unmount progress
  // writes can persist them without re-subscribing on every track/speed change.
  const prefsRef = useRef<PlaybackPrefs>({});
  useEffect(() => {
    prefsRef.current = {
      preferredAudioId: activeAid,
      preferredAudioLang:
        audioTracks.find((t) => String(t.id) === activeAid)?.lang ?? null,
      preferredSubId: activeSid,
      playbackSpeed: speed,
      subtitleDelay: subDelay,
      subtitlePosition: subPosition,
    };
  }, [activeAid, activeSid, speed, subDelay, subPosition, audioTracks]);

  // ── Auto-hide controls + cursor while playing (kept up while a menu is open)
  const nudgeControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (
        pausedRef.current ||
        menuOpenRef.current ||
        !posRef.current ||
        durRef.current === 0
      ) {
        return;
      }
      setControlsVisible(false);
    }, 3200);
  }, []);
  useEffect(() => {
    nudgeControls();
    return () => window.clearTimeout(hideTimer.current);
  }, [nudgeControls]);
  useEffect(() => {
    if (paused) {
      window.clearTimeout(hideTimer.current);
      setControlsVisible(true);
      return;
    }
    nudgeControls();
  }, [paused, nudgeControls]);

  // ── Playback controls ──────────────────────────────────────────────────────
  const togglePause = useCallback(() => {
    if (ended) {
      setEnded(false);
      endedRef.current = false;
      void command("seek", [0, "absolute"]);
      void setProperty("pause", false);
      return;
    }
    setPaused((current) => !current);
    void setProperty("pause", !paused);
    nudgeControls();
  }, [paused, ended, nudgeControls]);

  const seekTo = useCallback((to: number) => {
    const next = Math.max(0, to);
    posRef.current = next;
    scrubberRef.current?.updatePlayback({ pos: next }, true);
    const nextChapterIndex = chapterIndexAt(next, chaptersRef.current);
    if (activeChapterIndexRef.current !== nextChapterIndex) {
      activeChapterIndexRef.current = nextChapterIndex;
      setActiveChapterIndex(nextChapterIndex);
    }
    setEnded(false);
    endedRef.current = false;
    void command("seek", [next, "absolute"]);
  }, []);

  const relSeek = useCallback(
    (delta: number) => {
      setEnded(false);
      endedRef.current = false;
      void command("seek", [delta, "relative"]);
      nudgeControls();
    },
    [nudgeControls],
  );

  const changeVolume = useCallback((v: number) => {
    const next = Math.min(130, Math.max(0, Math.round(v)));
    setVolume(next);
    setMuted(next === 0);
    if (next > 0) lastAudibleVolume.current = next;
    void setProperty("volume", next);
    void setProperty("mute", next === 0);
  }, []);
  const toggleMute = useCallback(() => {
    if (volumeIsSilent) {
      const restored = volume > 0 ? volume : Math.max(1, lastAudibleVolume.current);
      lastAudibleVolume.current = restored;
      setMuted(false);
      setVolume(restored);
      void setProperty("mute", false);
      void setProperty("volume", restored);
      return;
    }
    lastAudibleVolume.current = volume;
    setMuted(true);
    void setProperty("mute", true);
  }, [volume, volumeIsSilent]);

  const applySpeed = useCallback((s: number) => {
    setSpeed(s);
    void setProperty("speed", s);
  }, []);

  const selectAudio = useCallback((id: string) => {
    setActiveAid(id);
    void setProperty("aid", id);
  }, []);
  const selectSub = useCallback((id: string) => {
    nativeCustomSubtitleActiveRef.current = false;
    subtitleSearch.setActiveTrack(null);
    setActiveSid(id);
    void setProperty("sid", id);
  }, [subtitleSearch.setActiveTrack]);

  // Restore remembered audio/subtitle/speed once, after the track list loads.
  const restoredAudioRef = useRef(false);
  const restoredSubtitleRef = useRef(false);
  useEffect(() => {
    restoredAudioRef.current = false;
    restoredSubtitleRef.current = false;
  }, [url]);
  useEffect(() => {
    const perTitlePrefs = playerPreferences?.rememberPerTitleTrackChoices === false
      ? null
      : savedPrefs;

    if (!restoredAudioRef.current) {
      const rememberedLanguage = perTitlePrefs?.preferredAudioLang;
      const rememberedId = perTitlePrefs?.preferredAudioId;
      const defaultLanguage = playerPreferences?.defaultAudioLanguage;
      const needsAudioTracks =
        normalizeLanguagePreference(rememberedLanguage) != null ||
        (typeof rememberedId === "string" && rememberedId.length > 0) ||
        normalizeLanguagePreference(defaultLanguage) != null;
      if (!needsAudioTracks || audioTracks.length > 0) {
        const rememberedByLanguage = findPreferredTrack(rememberedLanguage, audioTracks);
        const rememberedById = rememberedId != null
          ? audioTracks.find((track) => String(track.id) === rememberedId) ?? null
          : null;
        const defaultMatch = findPreferredTrack(defaultLanguage, audioTracks);
        const wantedAudio = rememberedByLanguage ?? rememberedById ?? defaultMatch;
        if (wantedAudio != null) selectAudio(String(wantedAudio.id));
        restoredAudioRef.current = true;
      }
    }

    if (!restoredSubtitleRef.current) {
      const rememberedSubtitle = perTitlePrefs?.preferredSubId;
      const defaultBehavior = playerPreferences?.defaultSubtitleBehavior;
      const defaultLanguage = playerPreferences?.defaultSubtitleLanguage;
      if (rememberedSubtitle === "no") {
        selectSub("no");
        restoredSubtitleRef.current = true;
      } else {
        const needsRememberedSubtitle =
          typeof rememberedSubtitle === "string" && rememberedSubtitle.length > 0;
        const needsDefaultSubtitle =
          defaultBehavior === "preferred" &&
          normalizeLanguagePreference(defaultLanguage) != null;
        if (
          (!needsRememberedSubtitle && !needsDefaultSubtitle) ||
          subTracks.length > 0
        ) {
          const rememberedById = rememberedSubtitle != null
            ? subTracks.find((track) => String(track.id) === rememberedSubtitle) ?? null
            : null;
          const rememberedByLanguage = findPreferredTrack(rememberedSubtitle, subTracks);
          const rememberedMatch = rememberedById ?? rememberedByLanguage;
          if (rememberedMatch != null) {
            selectSub(String(rememberedMatch.id));
          } else if (defaultBehavior === "off" || defaultLanguage === "") {
            selectSub("no");
          } else if (defaultBehavior === "preferred") {
            const defaultMatch = findPreferredTrack(defaultLanguage, subTracks);
            if (defaultMatch != null) selectSub(String(defaultMatch.id));
          }
          restoredSubtitleRef.current = true;
        }
      }
    }
  }, [
    savedPrefs,
    playerPreferences,
    audioTracks,
    subTracks,
    selectAudio,
    selectSub,
  ]);

  const jumpChapter = useCallback((time: number) => {
    seekTo(time);
    setMenu(null);
  }, [seekTo]);

  const applySubDelay = useCallback((d: number) => {
    setSubDelay(d);
    void setProperty("sub-delay", d);
  }, []);
  const applyAudioDelay = useCallback((d: number) => {
    setAudioDelay(d);
    void setProperty("audio-delay", d);
  }, []);
  const applySubScale = useCallback((s: number) => {
    setSubScale(s);
    void setProperty("sub-scale", s);
  }, []);
  const applySubPosition = useCallback((position: number) => {
    setSubPosition(position);
    void setProperty("sub-pos", position);
  }, []);
  const applyVideoZoom = useCallback((zoom: number) => {
    setVideoZoom(zoom);
    void setProperty("video-zoom", zoom);
  }, []);
  const applyVideoPanX = useCallback((pan: number) => {
    setVideoPanX(pan);
    void setProperty("video-pan-x", pan);
  }, []);
  const applyVideoPanY = useCallback((pan: number) => {
    setVideoPanY(pan);
    void setProperty("video-pan-y", pan);
  }, []);
  const applyVideoAspect = useCallback((aspect: string) => {
    setVideoAspect(aspect);
    void setProperty("video-aspect-override", aspect);
  }, []);
  const applyAudioDevice = useCallback((device: string) => {
    setAudioDevice(device);
    setPlaybackSettingError(null);
    void setProperty("audio-device", device).catch((error) => {
      setPlaybackSettingError(
        `Audio output could not be changed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, []);
  const applyAudioPassthrough = useCallback((enabled: boolean) => {
    setAudioPassthroughEnabled(enabled);
    setPlaybackSettingError(null);
    void setAudioPassthrough(enabled).catch((error) => {
      setAudioPassthroughEnabled(!enabled);
      setPlaybackSettingError(
        `Audio passthrough could not be changed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, []);
  const applyHdrPolicy = useCallback((policy: "auto" | "preserve" | "tone-map") => {
    setHdrPolicyValue(policy);
    setPlaybackSettingError(null);
    void setHdrPolicy(policy).catch((error) => {
      setPlaybackSettingError(
        `HDR policy could not be changed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, []);

  const syncFullscreen = useCallback(async () => {
    const actual = await getCurrentWindow().isFullscreen();
    setFullscreen(actual);
    return actual;
  }, []);

  const toggleFullscreen = useCallback(() => {
    void (async () => {
      try {
        // Read the native state immediately before toggling. The green window
        // control and Escape can change it independently of React state.
        const current = await syncFullscreen();
        const next = !current;
        await getCurrentWindow().setFullscreen(next);
        setFullscreen(next);
        setFullscreenError(null);
      } catch (error) {
        // Surface a bridge or ACL failure instead of leaving an optimistic icon
        // that claims the window entered fullscreen when it did not.
        setFullscreenError(
          `Fullscreen could not be changed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          await syncFullscreen();
        } catch {
          // The visible error above is the actionable diagnostic.
        }
      }
    })();
  }, [syncFullscreen]);

  // Delay a stage click just long enough to distinguish a single click from a
  // double click. Without this, a double click pauses before entering
  // fullscreen, which reads as a flicker in the native surface.
  const handleStageClick = useCallback(() => {
    if (menu != null) {
      setMenu(null);
      return;
    }
    if (detailsSection != null) {
      setDetailsSection(null);
      return;
    }
    window.clearTimeout(stageClickTimer.current);
    stageClickTimer.current = window.setTimeout(() => {
      togglePause();
    }, 220);
  }, [detailsSection, menu, togglePause]);
  const handleStageDoubleClick = useCallback(() => {
    window.clearTimeout(stageClickTimer.current);
    toggleFullscreen();
  }, [toggleFullscreen]);
  useEffect(
    () => () => window.clearTimeout(stageClickTimer.current),
    [],
  );

  const dismissUpNext = useCallback(() => {
    upNextDismissedRef.current = true;
    setUpNextDismissed(true);
    setPredictiveUpNext(null);
  }, []);

  const autoAdvanceFiredRef = useRef(false);
  useEffect(() => {
    if (
      upNextState == null ||
      !autoCountdown ||
      paused ||
      upNextDismissed ||
      onPlayNext == null ||
      (!upNextState.earlyAutoAdvance && !ended)
    ) return;
    const timer = window.setTimeout(() => {
      if (pausedRef.current || upNextDismissedRef.current || autoAdvanceFiredRef.current) return;
      autoAdvanceFiredRef.current = true;
      onPlayNextRef.current?.();
    }, Math.max(10, upNextState.cancelWindowSeconds) * 1000);
    return () => window.clearTimeout(timer);
  }, [autoCountdown, ended, onPlayNext, paused, upNextDismissed, upNextState]);

  const doClose = useCallback(() => {
    if (fullscreen) {
      void getCurrentWindow().setFullscreen(false).catch((error) => {
        setFullscreenError(
          `Fullscreen could not be changed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    if (startedRef.current && durRef.current > 0) {
      onProgress?.(
        reportedPosition(),
        reportedDuration(),
        prefsRef.current,
      );
    }
    if (scrobbleContext != null) {
      scrobblePlaybackStop(
        scrobbleContext,
        reportedProgressPct(),
      );
    }
    onClose();
  }, [onClose, onProgress, fullscreen, scrobbleContext]);

  // Keep the current window's real fullscreen state in sync (Esc, green button).
  useEffect(() => {
    let disposed = false;
    let frame: number | undefined;
    let unlisten: (() => void) | undefined;
    const scheduleFullscreenSync = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        void syncFullscreen().catch(() => {});
      });
    };
    scheduleFullscreenSync();
    void getCurrentWindow()
      .onResized(scheduleFullscreenSync)
      .then((nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (frame != null) window.cancelAnimationFrame(frame);
      unlisten?.();
    };
  }, [syncFullscreen]);

  const openMenu = useCallback(
    (id: Exclude<MenuId, null>) => {
      setMenu((cur) => (cur === id ? null : id));
      if (id === "audio" || id === "sub") void refreshTracks();
      if (id === "chapters") void refreshChapters();
      if (id === "settings") void refreshAudioDevices();
      nudgeControls();
    },
    [refreshTracks, refreshChapters, refreshAudioDevices, nudgeControls],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (castSuspendedRef.current) return;
      // Escape owns the player-level dismissal ladder. Capture it before a
      // hidden chrome control or the transparent native-video surface can let
      // the WebView's default Escape handling consume the first press.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (upNextStateRef.current != null) dismissUpNext();
        else if (detailsSection != null) setDetailsSection(null);
        else if (menu != null) setMenu(null);
        else if (fullscreen) toggleFullscreen();
        else doClose();
        return;
      }
      if (isInteractiveTarget(e.target)) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePause();
          break;
        case "ArrowRight":
          e.preventDefault();
          relSeek(e.shiftKey ? 60 : 5);
          break;
        case "ArrowLeft":
          e.preventDefault();
          relSeek(e.shiftKey ? -60 : -5);
          break;
        case "l":
          relSeek(10);
          break;
        case "j":
          relSeek(-10);
          break;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(Math.min(130, volume + 5));
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(Math.max(0, volume - 5));
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "c":
          // Cycle subtitle track (off → first → next …).
          void command("cycle", ["sub"]);
          void refreshTracks();
          break;
        case "<":
        case ",":
          applySpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) - 1)] ?? 1);
          break;
        case ">":
        case ".":
          applySpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1)] ?? 1);
          break;
        case "?":
          setDetailsSection((section) =>
            section === "shortcuts" ? null : "shortcuts",
          );
          break;
        default:
          if (/^[0-9]$/.test(e.key) && durRef.current > 0) {
            seekTo((Number(e.key) / 10) * durRef.current);
          }
      }
      nudgeControls();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    togglePause, relSeek, changeVolume, volume, toggleMute, toggleFullscreen,
    applySpeed, speed, doClose, seekTo, nudgeControls, menu, fullscreen,
    detailsSection, refreshTracks, dismissUpNext,
  ]);

  const nativeSourceSize = useMemo<PixelSize | null>(() => {
    const width = sourceW > 0 ? sourceW : videoW;
    const height = sourceH > 0 ? sourceH : videoH;
    return width > 0 && height > 0 ? { width, height } : null;
  }, [sourceW, sourceH, videoW, videoH]);
  const selectedVideoCodec =
    tracks.find((track) => track.type === "video" && track.selected)?.codec ??
    tracks.find((track) => track.type === "video")?.codec ??
    "";
  const selectedAudioCodec =
    audioTracks.find((track) => String(track.id) === activeAid)?.codec ??
    audioTracks.find((track) => track.selected)?.codec ??
    "";
  const nativeTechnicalStats = useMemo<Array<readonly [string, string]>>(() => {
    const stats: Array<readonly [string, string]> = [];
    if (selectedVideoCodec) stats.push(["Video codec", selectedVideoCodec]);
    if (selectedAudioCodec) stats.push(["Audio codec", selectedAudioCodec]);
    if (containerFps > 0) stats.push(["Source frame rate", `${containerFps.toFixed(3)} fps`]);
    if (outputFps > 0) stats.push(["Output frame rate", `${outputFps.toFixed(3)} fps`]);
    stats.push(["Dropped frames", `${decoderDrops + displayDrops}`]);
    if (hardwareDecoder) stats.push(["Hardware decode", hardwareDecoder]);
    if (colorPrimaries || transferFunction) {
      stats.push([
        "Color",
        [colorPrimaries, transferFunction].filter(Boolean).join(" / "),
      ]);
    }
    stats.push([
      "HDR policy",
      hdrPolicy === "tone-map"
        ? "Tone map to SDR"
        : hdrPolicy === "preserve"
          ? "Preserve HDR"
          : "Automatic",
    ]);
    return stats;
  }, [
    colorPrimaries,
    containerFps,
    decoderDrops,
    displayDrops,
    hardwareDecoder,
    hdrPolicy,
    outputFps,
    selectedAudioCodec,
    selectedVideoCodec,
    transferFunction,
  ]);

  if (error) {
    return createPortal(
      <div className="embed-player show-controls">
        <div className="embed-stage" />
        <div className="embed-error" role="alert">
          <Icon name="info" size={26} className="t-warning" />
          <p>Couldn’t play this stream in the built-in player.</p>
          <p className="embed-error-detail">{error}</p>
          <div className="embed-error-actions">
            {onTryNextSource != null && (
              <button
                type="button"
                className="btn btn-prominent"
                onClick={() => {
                  setError("Preparing the next compatible source.");
                  void onTryNextSource().catch((nextError) => {
                    setError(
                      nextError instanceof Error
                        ? nextError.message
                        : String(nextError),
                    );
                  });
                }}
              >
                Try next source
              </button>
            )}
            <button
              type="button"
              className={onTryNextSource == null ? "btn btn-prominent" : "btn"}
              onClick={() => {
                void (async () => {
                  try {
                    await openInExternalPlayer(
                      url,
                      undefined,
                      playbackAuthorization,
                    );
                    onClose(); // handed off - close the built-in player.
                  } catch (err) {
                    // The fallback failed too (no external player, not under
                    // Tauri): keep the card open and tell the user, don't
                    // silently vanish.
                    setError(
                      `No external player available either - install mpv or VLC. (${
                        err instanceof Error ? err.message : String(err)
                      })`,
                    );
                  }
                })();
              }}
            >
              Open in external player
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // This is a full-window layer, so keep it outside filtered, inset, or scrolled
  // app overlays that would otherwise become its fixed-position containing block.
  return createPortal(
    <div
      className={`embed-player${castSuspended ? " is-casting" : ""}${
        controlsVisible ||
        menu != null ||
        detailsSection != null ||
        fullscreenError != null ||
        castSuspended
          ? " show-controls"
          : ""
      }`}
      onMouseMove={nudgeControls}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {ended
          ? "Playback ended"
          : buffering
            ? "Playback buffering"
            : paused
              ? "Playback paused"
              : "Playback playing"}
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        Playback speed {speed} times. Audio{" "}
        {audioTracks.find((track) => String(track.id) === activeAid)?.title ??
          audioTracks.find((track) => String(track.id) === activeAid)?.lang ??
          (activeAid === "auto" ? "automatic" : activeAid)}. Subtitles{" "}
        {subTracks.find((track) => String(track.id) === activeSid)?.title ??
          subTracks.find((track) => String(track.id) === activeSid)?.lang ??
          (activeSid === "no" ? "off" : activeSid)}. Subtitle delay{" "}
        {subDelay.toFixed(1)} seconds.
      </span>
      {/* Transparent stage - the native mpv surface shows through. Clicking it
          (not the controls) toggles play/pause. */}
      <div
        className="embed-stage"
        onClick={castSuspended ? undefined : handleStageClick}
        onDoubleClick={castSuspended ? undefined : handleStageDoubleClick}
      />

      {buffering && !ended && !paused && (
        <div className="embed-spinner" aria-label="Buffering">
          <span />
        </div>
      )}

      {/* Up-next can arm during verified credits, but generic predictions wait
          for real EOF before any automatic transition. */}
      {upNextState != null && onPlayNext != null && (
        <div className="embed-endcard" role="dialog" aria-label={`Next episode: ${nextLabel ?? "Up next"}`}>
          <span className="embed-endcard-eyebrow">Up next</span>
          {nextLabel && <span className="embed-endcard-title">{nextLabel}</span>}
          {autoCountdown && (upNextState.earlyAutoAdvance || ended) && (
            <span className="embed-endcard-count">Auto-play is ready</span>
          )}
          <button type="button" className="btn btn-prominent" onClick={onPlayNext}>
            <Icon name="play" size={16} filled />
            Play now
          </button>
          <button type="button" className="btn" onClick={dismissUpNext}>Dismiss</button>
        </div>
      )}
      {ended && upNextState == null && (
        <div className="embed-endcard">
          <button type="button" className="btn btn-prominent" onClick={togglePause}>
            <Icon name="refresh" size={16} />
            Replay
          </button>
        </div>
      )}

      {paused && !ended && menu == null && detailsSection == null && !scrubbing && (
        <PlayerPauseOverlay
          title={title}
          nowPlaying={nowPlaying}
          onResume={togglePause}
        />
      )}

      <div className="embed-controls">
        {/* Top bar */}
        <div className="embed-top">
          <div className="embed-titles">
            <span className="embed-title" title={title}>
              {title}
            </span>
            {subtitle && <span className="embed-subtitle">{subtitle}</span>}
          </div>
          <div className="embed-top-actions">
            <button
              type="button"
              className="embed-icon-btn"
              onClick={() =>
                setDetailsSection((section) => section === "info" ? null : "info")
              }
              aria-label="Player details and shortcuts"
              aria-haspopup="dialog"
              aria-expanded={detailsSection != null}
              title="Player details and shortcuts (?)"
            >
              <Icon name="info" size={19} />
            </button>
            <button
              type="button"
              className="embed-icon-btn"
              onClick={doClose}
              aria-label="Close player"
              title="Close player (Esc)"
            >
              <Icon name="xmark" size={20} />
            </button>
          </div>
        </div>

        {detailsSection != null && (
          <PlayerInfoPopover
            engine={engine}
            playbackDecision={playbackDecision}
            sourceSize={nativeSourceSize}
            displaySize={displaySize}
            sourceFileName={sourceFileName}
            technicalStats={nativeTechnicalStats}
            section={detailsSection}
            onSectionChange={setDetailsSection}
            shortcuts={NATIVE_SHORTCUTS}
            onClose={() => setDetailsSection(null)}
          />
        )}

        {fullscreenError && (
          <div className="embed-fullscreen-error" role="status">
            {fullscreenError}
          </div>
        )}

        {/* Bottom control bar */}
        <div className="embed-bottom">
          <NativeScrubber
            ref={scrubberRef}
            duration={dur}
            timelineOffsetSeconds={timelineOffsetRef.current}
            chapters={chapters}
            active={controlsVisible || menu != null || detailsSection != null}
            onSeek={seekTo}
            onScrubbingChange={setScrubbing}
          />

          {/* Buttons row: equal flexible side columns keep the transport group
              (center) centered on the frame regardless of side widths. */}
          <div className="embed-buttons">
            <div className="embed-buttons-left">
              <div
                className="embed-volume"
                onWheel={(e) => {
                  changeVolume((volumeIsSilent ? lastAudibleVolume.current : volume) + (e.deltaY < 0 ? 5 : -5));
                }}
              >
                <button
                  type="button"
                  className="embed-icon-btn"
                  onClick={toggleMute}
                  aria-label={volumeIsSilent ? "Unmute" : "Mute"}
                  aria-pressed={volumeIsSilent}
                  title={volumeIsSilent ? "Unmute (M)" : "Mute (M)"}
                >
                  <Icon name={volumeIsSilent ? "volume-muted" : "volume"} size={20} />
                </button>
                <input
                  className="embed-vol-range"
                  type="range"
                  min={0}
                  max={130}
                  value={volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  aria-label="Volume"
                  title="Volume (Up / Down or scroll)"
                  style={{ ["--v" as string]: `${volume / 1.3}%` }}
                />
              </div>
            </div>

            <div className="embed-buttons-center">
              <button
                type="button"
                className="embed-icon-btn"
                onClick={() => relSeek(-10)}
                aria-label="Back 10 seconds"
                title="Back 10 seconds (Left)"
              >
                <Icon name="rewind" size={20} />
                <span className="embed-skip-num">10</span>
              </button>
              <button
                type="button"
                className="embed-play-btn"
                onClick={togglePause}
                aria-label={paused ? "Play" : "Pause"}
                title={paused ? "Play (Space)" : "Pause (Space)"}
              >
                {paused || ended ? (
                  <Icon name="play" size={26} filled />
                ) : (
                  <span className="embed-pause-glyph" aria-hidden>
                    <i />
                    <i />
                  </span>
                )}
              </button>
              <button
                type="button"
                className="embed-icon-btn"
                onClick={() => relSeek(10)}
                aria-label="Forward 10 seconds"
                title="Forward 10 seconds (Right)"
              >
                <Icon name="forward" size={20} />
                <span className="embed-skip-num">10</span>
              </button>
            </div>

            <div className="embed-buttons-right">
              <CastControls
                media={{ url, title, subtitleUrl: activeSubtitleUrl }}
                buttonClassName="embed-icon-btn"
                onLocalPlaybackChange={setCastSuspended}
              />
              {onPlayNext != null && (
                <button
                  type="button"
                  className="embed-next-btn"
                  onClick={onPlayNext}
                  aria-label="Next episode"
                  title={nextLabel ? `Next episode: ${nextLabel}` : "Next episode"}
                >
                  <span>Next</span>
                  <Icon name="skip-next" size={17} />
                </button>
              )}
              <MenuButton
                label="Speed"
                active={menu === "speed"}
                onClick={() => openMenu("speed")}
                badge={speed !== 1 ? `${speed}×` : undefined}
              >
                <Icon name="speed" size={18} />
              </MenuButton>
              <MenuButton
                label="Audio"
                active={menu === "audio"}
                onClick={() => openMenu("audio")}
              >
                <Icon name="audio" size={18} />
              </MenuButton>
              <MenuButton
                label="Subtitles"
                active={menu === "sub"}
                onClick={() => openMenu("sub")}
                badge={activeSid !== "no" && subTracks.length > 0 ? "CC" : undefined}
              >
                <Icon name="captions" size={18} />
              </MenuButton>
              {chapters.length > 1 && (
                <MenuButton
                  label="Chapters"
                  active={menu === "chapters"}
                  onClick={() => openMenu("chapters")}
                >
                  <Icon name="library" size={18} />
                </MenuButton>
              )}
              <MenuButton
                label="Settings"
                active={menu === "settings"}
                onClick={() => openMenu("settings")}
              >
                <Icon name="sliders" size={18} />
              </MenuButton>
              <button
                type="button"
                className="embed-icon-btn"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
              >
                <Icon name={fullscreen ? "fullscreen-exit" : "fullscreen"} size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Popover menus */}
        {menu === "speed" && (
          <Popover onClose={() => setMenu(null)} className="embed-menu-speed">
            <div className="embed-menu-title">Playback speed</div>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={"embed-menu-item" + (speed === s ? " is-active" : "")}
                role="menuitemradio"
                aria-checked={speed === s}
                onClick={() => {
                  applySpeed(s);
                  setMenu(null);
                }}
              >
                {s === 1 ? "Normal" : `${s}×`}
                {speed === s && <Icon name="check" size={14} />}
              </button>
            ))}
          </Popover>
        )}

        {menu === "audio" && (
          <Popover onClose={() => setMenu(null)}>
            <div className="embed-menu-title">Audio</div>
            {audioTracks.length === 0 && (
              <div className="embed-menu-empty">No audio tracks</div>
            )}
            {audioTracks.map((t, i) => {
              const on = activeAid === String(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={"embed-menu-item" + (on ? " is-active" : "")}
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    selectAudio(String(t.id));
                    setMenu(null);
                  }}
                >
                  {trackLabel(t, i)}
                  {on && <Icon name="check" size={14} />}
                </button>
              );
            })}
          </Popover>
        )}

        {menu === "sub" && (
          <Popover onClose={() => setMenu(null)}>
            <div className="embed-menu-title">Subtitles</div>
            <button
              type="button"
              className={"embed-menu-item" + (activeSid === "no" ? " is-active" : "")}
              role="menuitemradio"
              aria-checked={activeSid === "no"}
              onClick={() => {
                selectSub("no");
                setMenu(null);
              }}
            >
              Off
              {activeSid === "no" && <Icon name="check" size={14} />}
            </button>
            {subTracks.map((t, i) => {
              const on = activeSid === String(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={"embed-menu-item" + (on ? " is-active" : "")}
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    selectSub(String(t.id));
                    setMenu(null);
                  }}
                >
                  {trackLabel(t, i)}
                  {on && <Icon name="check" size={14} />}
                </button>
              );
            })}
            <button
              type="button"
              className="embed-menu-item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setCaptionsSearchOpen(true);
              }}
            >
              <span>Search and translate subtitles</span>
              <Icon name="search" size={14} />
            </button>
            {subtitleAttachError != null && (
              <p className="embed-menu-error" role="alert">
                {subtitleAttachError}
              </p>
            )}
          </Popover>
        )}

        {menu === "chapters" && (
          <Popover onClose={() => setMenu(null)} className="embed-menu-chapters">
            <div className="embed-menu-title">Chapters</div>
            {chapters.map((c, i) => (
              <button
                key={i}
                type="button"
                className={
                  "embed-menu-item embed-chapter-item" +
                  (activeChapterIndex === i ? " is-active" : "")
                }
                role="menuitem"
                onClick={() => jumpChapter(c.time)}
              >
                <span className="embed-chapter-name">{c.title}</span>
                <span className="embed-chapter-time">{fmt(c.time)}</span>
              </button>
            ))}
          </Popover>
        )}

        {menu === "settings" && (
          <Popover onClose={() => setMenu(null)} className="embed-menu-settings">
            <div className="embed-menu-title">Playback settings</div>
            {serverOptimized != null && onSwitchServerOptimized != null && onSwitchDeviceOriginal != null && (
              <div className="embed-setting">
                <span className="embed-setting-head">
                  <span>Streaming mode</span>
                  <span className="embed-setting-val">
                    {activeServerOptimizedQuality == null
                      ? "Device Original"
                      : `Server Optimized ${activeServerOptimizedQuality === "auto" ? "Auto" : activeServerOptimizedQuality}`}
                  </span>
                </span>
                <div className="embed-menu-choice-row">
                  <button
                    type="button"
                    className={`chip${activeServerOptimizedQuality == null ? " is-active" : ""}`}
                    aria-pressed={activeServerOptimizedQuality == null}
                    disabled={serverOptimizationPending}
                    onClick={() => onSwitchDeviceOriginal(reportedPosition(), handoffState())}
                  >
                    Device Original
                  </button>
                  {serverOptimized.qualities.map((quality) => (
                    <button
                      type="button"
                      className={`chip${activeServerOptimizedQuality === quality ? " is-active" : ""}`}
                      aria-pressed={activeServerOptimizedQuality === quality}
                      disabled={serverOptimizationPending}
                      onClick={() => void onSwitchServerOptimized(quality, reportedPosition(), handoffState())}
                      key={quality}
                    >
                      {quality === "auto" ? "Auto" : quality}
                    </button>
                  ))}
                </div>
                <small>Server Optimized reduces data use and switches to webview HLS after the manifest is ready.</small>
                {serverOptimizationPending && (
                  <p className="embed-menu-error" role="status">Preparing optimized playback while the current stream continues…</p>
                )}
                {serverOptimizationError != null && (
                  <p className="embed-menu-error" role="alert">{serverOptimizationError}</p>
                )}
              </div>
            )}
            <Slider
              label="Subtitle size"
              value={subScale}
              min={0.5}
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={applySubScale}
            />
            <Slider
              label="Subtitle delay"
              value={subDelay}
              min={-10}
              max={10}
              step={0.1}
              format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}s`}
              onChange={applySubDelay}
            />
            <Slider
              label="Subtitle position"
              value={subPosition}
              min={0}
              max={100}
              step={1}
              format={(v) => `${Math.round(v)}%`}
              onChange={applySubPosition}
            />
            <Slider
              label="Audio delay"
              value={audioDelay}
              min={-10}
              max={10}
              step={0.1}
              format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}s`}
              onChange={applyAudioDelay}
            />
            <Slider
              label="Zoom"
              value={videoZoom}
              min={-1}
              max={2}
              step={0.05}
              format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
              onChange={applyVideoZoom}
            />
            <Slider
              label="Pan horizontally"
              value={videoPanX}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={applyVideoPanX}
            />
            <Slider
              label="Pan vertically"
              value={videoPanY}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={applyVideoPanY}
            />
            <div className="embed-setting">
              <span className="embed-setting-head">
                <span>Aspect ratio</span>
                <span className="embed-setting-val">
                  {videoAspect === "-1" ? "Auto" : videoAspect}
                </span>
              </span>
              <div className="embed-menu-choice-row">
                {[
                  ["-1", "Auto"],
                  ["1.777778", "16:9"],
                  ["1.333333", "4:3"],
                  ["2.333333", "21:9"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    className={`chip${videoAspect === value ? " is-active" : ""}`}
                    onClick={() => applyVideoAspect(value)}
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="embed-setting">
              <span className="embed-setting-head">
                <span>Audio output device</span>
              </span>
              <select
                className="embed-setting-select"
                value={audioDevice}
                onChange={(event) => applyAudioDevice(event.target.value)}
              >
                <option value="auto">System default</option>
                {audioDevices.map((device) => (
                  <option value={device.name} key={device.name}>
                    {device.description}
                  </option>
                ))}
              </select>
            </label>
            <label className="embed-setting embed-setting-toggle">
              <span>
                <strong>Audio passthrough</strong>
                <small>Send Dolby and DTS bitstreams to a compatible receiver.</small>
              </span>
              <input
                type="checkbox"
                checked={audioPassthrough}
                onChange={(event) => applyAudioPassthrough(event.target.checked)}
              />
            </label>
            <div className="embed-setting">
              <span className="embed-setting-head">
                <span>HDR output</span>
                <span className="embed-setting-val">
                  {hdrPolicy === "tone-map"
                    ? "Tone map"
                    : hdrPolicy === "preserve"
                      ? "Preserve"
                      : "Auto"}
                </span>
              </span>
              <div className="embed-menu-choice-row">
                {[
                  ["auto", "Auto"],
                  ["preserve", "Preserve HDR"],
                  ["tone-map", "Tone map to SDR"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    className={`chip${hdrPolicy === value ? " is-active" : ""}`}
                    onClick={() =>
                      applyHdrPolicy(value as "auto" | "preserve" | "tone-map")
                    }
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {playbackSettingError != null && (
              <p className="embed-menu-error" role="alert">
                {playbackSettingError}
              </p>
            )}
          </Popover>
        )}
        {captionsSearchOpen && (
          <CaptionsMenu
            subs={subtitleSearch}
            seedTitle={title}
            seedImdbId={imdbId}
            seedSeason={season}
            seedEpisode={episode}
            onClose={() => setCaptionsSearchOpen(false)}
          />
        )}
      </div>

    </div>,
    document.body,
  );
}

/** A control-bar button that opens a popover; shows an optional value badge. */
function MenuButton({
  label,
  active,
  onClick,
  badge,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={"embed-icon-btn embed-menu-btn" + (active ? " is-active" : "")}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
      {badge && <span className="embed-menu-badge">{badge}</span>}
    </button>
  );
}

/** A dismissible popover anchored above the control bar. */
function Popover({
  children,
  onClose,
  className,
}: {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLElement>(
      ".embed-menu-item.is-active, .embed-menu-item",
    );
    firstItem?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".embed-menu-item"),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        type="button"
        className="embed-menu-scrim"
        aria-label="Close menu"
        onClick={onClose}
      />
      <div
        ref={menuRef}
        className={"embed-menu glass-lit" + (className ? " " + className : "")}
        role="menu"
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="embed-setting">
      <span className="embed-setting-head">
        <span>{label}</span>
        <span className="embed-setting-val">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

const NATIVE_SHORTCUTS: Array<[string, string]> = [
  ["Space / K", "Play / pause"],
  ["← / →", "Seek ∓5s"],
  ["J / L", "Seek ∓10s"],
  ["↑ / ↓", "Volume"],
  ["0 – 9", "Jump to 0–90%"],
  ["< / >", "Speed down / up"],
  ["C", "Cycle subtitles"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
  ["Esc", "Back / close"],
  ["?", "This help"],
];
