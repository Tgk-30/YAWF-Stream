import { recordDiagnostic } from "./diagnostics";
import type { PlaybackEngine } from "./playbackEngine";

const MEDIA_EVENTS = [
  "play", "playing", "pause", "waiting", "stalled", "suspend", "emptied",
  "error", "ended", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "seeking", "seeked", "durationchange", "ratechange", "timeupdate",
  "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged",
  "webkitbeginfullscreen", "webkitendfullscreen",
] as const;
const MAX_SECONDS = 100_000_000;
const SAMPLE_MS = 15_000;

type Presentation = "inline" | "fullscreen" | "picture-in-picture";
type Snapshot = {
  currentTime: number | null;
  bufferAhead: number | null;
  readyState: number | null;
  networkState: number | null;
  paused: boolean | null;
  ended: boolean | null;
  seeking: boolean | null;
  totalVideoFrames: number | null;
  droppedVideoFrames: number | null;
  visibility: "visible" | "hidden" | "prerender" | null;
  presentation: Presentation | null;
  pictureInPicture: boolean | null;
  engine: Exclude<PlaybackEngine, "native-mpv"> | null;
};

function read<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}
function number(value: unknown, max: number, integer = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bounded = Math.max(0, Math.min(max, value));
  return integer ? Math.floor(bounded) : Math.round(bounded * 1000) / 1000;
}
function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Like the player's Buffer health display, only the range containing the clock
// counts. Future ranges do not bridge an unbuffered gap. Unknown is not zero.
function bufferAhead(video: HTMLVideoElement, time: number | null): number | null {
  if (time == null) return null;
  return read(() => {
    const ranges = video.buffered;
    const length = ranges.length;
    if (!Number.isInteger(length) || length < 0 || length > 64) return null;
    for (let index = 0; index < length; index += 1) {
      const start = ranges.start(index), end = ranges.end(index);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
      if (start <= time && end >= time) return number(end - time, MAX_SECONDS);
    }
    return 0;
  }) ?? null;
}

function snapshot(video: HTMLVideoElement, engine: unknown): Snapshot {
  const doc = video.ownerDocument;
  const time = number(read(() => video.currentTime), MAX_SECONDS);
  const quality = read(() => video.getVideoPlaybackQuality?.());
  const visibility = read(() => doc.visibilityState);
  const mode = read(() => (video as HTMLVideoElement & { webkitPresentationMode?: unknown }).webkitPresentationMode);
  const pip = read(() => doc.pictureInPictureElement);
  const fullscreen = read(() => doc.fullscreenElement);
  return {
    currentTime: time,
    bufferAhead: bufferAhead(video, time),
    readyState: number(read(() => video.readyState), 4, true),
    networkState: number(read(() => video.networkState), 3, true),
    paused: boolean(read(() => video.paused)),
    ended: boolean(read(() => video.ended)),
    seeking: boolean(read(() => video.seeking)),
    totalVideoFrames: number(read(() => quality?.totalVideoFrames), Number.MAX_SAFE_INTEGER, true),
    droppedVideoFrames: number(read(() => quality?.droppedVideoFrames), Number.MAX_SAFE_INTEGER, true),
    visibility: visibility === "visible" || visibility === "hidden" || visibility === "prerender" ? visibility : null,
    presentation: mode === "inline" || mode === "fullscreen" || mode === "picture-in-picture" ? mode
      : fullscreen === video ? "fullscreen" : pip === video ? "picture-in-picture" : null,
    pictureInPicture: mode === "picture-in-picture" || pip === video ? true
      : mode === "inline" || mode === "fullscreen" || pip === null ? false : null,
    engine: engine === "webview-direct" || engine === "webview-hls-transcode" ? engine : null,
  };
}

/** Read-only, event-driven facts, not buffering diagnoses or user-intent signals.
 * No source/title/identifier reads, media writes, timers, requests or persistence.
 * The caller owns the source fence; cleanup also silences already-queued callbacks.
 */
export function observePlaybackDiagnostics(
  video: HTMLVideoElement,
  engine: PlaybackEngine,
  isCurrent: () => boolean,
): () => void {
  let active = true;
  let lastSample = -Infinity;
  let last: { event: string; detail: string; at: number } | undefined;
  const listeners: Array<() => void> = [];
  const record = (event: string) => {
    if (!active || !isCurrent()) return;
    const now = performance.now();
    if (event === "timeupdate" && now - lastSample < SAMPLE_MS) return;
    const detail = JSON.stringify(snapshot(video, engine));
    if (last?.event === event && last.detail === detail && now - last.at < 1000) return;
    // All strings in the snapshot are fixed enums. Keep the structured JSON
    // within the existing diagnostic detail bound instead of truncating it.
    recordDiagnostic("player", `media.${event}`, "info", detail);
    if (event === "timeupdate") lastSample = now;
    last = { event, detail, at: now };
  };
  const listen = (target: EventTarget, event: string) => {
    const handler = () => record(event);
    target.addEventListener(event, handler, { passive: true });
    listeners.push(() => target.removeEventListener(event, handler));
  };
  for (const event of MEDIA_EVENTS) listen(video, event);
  listen(video.ownerDocument, "visibilitychange");
  listen(video.ownerDocument, "fullscreenchange");
  const win = video.ownerDocument.defaultView;
  if (win != null) {
    listen(win, "pagehide");
    listen(win, "pageshow");
  }
  record("attached");
  return () => {
    active = false;
    for (const remove of listeners) remove();
  };
}
