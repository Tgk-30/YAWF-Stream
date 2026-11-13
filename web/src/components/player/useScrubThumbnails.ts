// Scrub-bar thumbnail previews for the IN-WEBVIEW player.
//
// On hover over the scrub bar, generate a preview frame by seeking a HIDDEN,
// offscreen `<video>` (a second element pointed at the same source) to the
// hovered time and drawing it to a small `<canvas>`. The canvas is exported to a
// data URL shown in a tooltip above the bar. Frames are cached by quantized time
// bucket (so re-hovering nearby is instant) and generation is throttled so a
// fast scrub doesn't queue dozens of seeks.
//
// This is gated to the in-webview `<video>` path by the caller - there is no
// frame source for the external mpv/VLC hand-off, so the tooltip is hidden
// there. Cross-origin debrid streams may taint the canvas (a SecurityError on
// export); we catch that and simply show the time label without an image.

import { useCallback, useEffect, useRef, useState } from "react";

/** A generated preview: a data-URL image (or null if unavailable) + the time. */
export interface ScrubPreview {
  /** Data-URL of the frame, or null when none could be drawn (taint / no seek). */
  image: string | null;
  /** The preview time in seconds. */
  time: number;
}

const THUMB_WIDTH = 168; // capped canvas width for performance
const BUCKET_SECONDS = 5; // quantize hovered time into 5s buckets for caching
const THROTTLE_MS = 120; // min gap between seek-driven captures
const SEEK_TIMEOUT_MS = 3000; // give up on a seek that never reports 'seeked'
const MAX_CACHED_THUMBNAILS = 120;

interface UseScrubThumbnails {
  /** The currently-previewed frame, or null when not hovering. */
  preview: ScrubPreview | null;
  /** Call on pointer move over the scrub bar with the hovered time (seconds). */
  onHover: (timeSeconds: number) => void;
  /** Call on pointer leave to clear the tooltip. */
  onLeave: () => void;
  /** Whether previews are available (a source + the hidden video exist). */
  available: boolean;
}

/**
 * @param sourceUrl The video src to capture from (same as the main player).
 * @param enabled   Gate - pass false for the external player path so no hidden
 *                  video is created and `available` is false.
 */
export function useScrubThumbnails(
  sourceUrl: string,
  enabled: boolean,
): UseScrubThumbnails {
  const [preview, setPreview] = useState<ScrubPreview | null>(null);
  const [ready, setReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Two hours of scrubbing otherwise creates about 1,440 base64 JPEG buckets.
  const cacheRef = useRef<Map<number, string | null>>(new Map());
  const lastCaptureRef = useRef(-Infinity);
  const sourceOwnerRef = useRef<string | null>(null);
  const sourceAttachedRef = useRef(false);
  const hoveringRef = useRef(false);
  const pendingTimeRef = useRef<number | null>(null);
  const seekingRef = useRef(false);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Cancel the in-flight seek watchdog, if any. */
  const clearSeekTimer = useCallback(() => {
    if (seekTimerRef.current != null) {
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
  }, []);

  // Build the hidden capture video + canvas once (browser only, when enabled).
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "none";
    // No crossOrigin: debrid hosts send no CORS headers, so requesting CORS
    // would abort the load entirely and break thumbnails (loadedmetadata/seeked
    // never fire). Load no-CORS like the main player; if the canvas is then
    // tainted, the draw try/catch below falls back to a time-only label.
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    videoRef.current = video;
    canvasRef.current = canvas;
    sourceOwnerRef.current = sourceUrl;
    sourceAttachedRef.current = false;
    hoveringRef.current = false;
    lastCaptureRef.current = -Infinity;
    cacheRef.current.clear();

    const onMeta = () => {
      if (videoRef.current !== video || !sourceAttachedRef.current) return;
      setReady(Number.isFinite(video.duration));
      if (hoveringRef.current && document.visibilityState !== "hidden" && pendingTimeRef.current != null) {
        const next = pendingTimeRef.current;
        pendingTimeRef.current = null;
        requestCapture(next);
      }
    };
    const onSeeked = () => {
      if (videoRef.current !== video) return;
      clearSeekTimer();
      seekingRef.current = false;
      captureCurrentFrame();
      // If the user moved on while we were seeking, chase the latest time.
      if (pendingTimeRef.current != null) {
        const next = pendingTimeRef.current;
        pendingTimeRef.current = null;
        void requestCapture(next);
      }
    };
    // A media error means no 'seeked' will ever arrive for the in-flight seek.
    // Drop the in-flight flag so later hovers are not coalesced forever.
    const onError = () => {
      if (videoRef.current !== video) return;
      clearSeekTimer();
      seekingRef.current = false;
      pendingTimeRef.current = null;
    };
    const onVisibility = () => {
      if (videoRef.current !== video || document.visibilityState !== "hidden") return;
      hoveringRef.current = false;
      lastCaptureRef.current = -Infinity;
      pendingTimeRef.current = null;
      seekingRef.current = false;
      clearSeekTimer();
      if (sourceAttachedRef.current) {
        video.removeAttribute("src");
        video.load();
        sourceAttachedRef.current = false;
      }
      setReady(false);
      setPreview(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("loadeddata", onMeta);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    return () => {
      clearSeekTimer();
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("loadeddata", onMeta);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      if (sourceAttachedRef.current) {
        video.removeAttribute("src");
        video.load();
      }
      sourceAttachedRef.current = false;
      sourceOwnerRef.current = null;
      hoveringRef.current = false;
      videoRef.current = null;
      canvasRef.current = null;
      cacheRef.current.clear();
      seekingRef.current = false;
      pendingTimeRef.current = null;
      setReady(false);
      setPreview(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, enabled]);

  /** Draw the hidden video's current frame to the canvas → data URL (cached). */
  const captureCurrentFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video == null || canvas == null || !hoveringRef.current || document.visibilityState === "hidden") return;
    // Guard videoWidth too: a corrupt stream can report height>0 with width 0,
    // which would make the ratio Infinity and canvas.height Infinity.
    const ratio =
      video.videoHeight > 0 && video.videoWidth > 0
        ? video.videoHeight / video.videoWidth
        : 9 / 16;
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.round(THUMB_WIDTH * ratio);
    const ctx = canvas.getContext("2d");
    if (ctx == null) return;
    let image: string | null = null;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      image = canvas.toDataURL("image/jpeg", 0.6);
    } catch {
      // Cross-origin taint - show the time label without an image.
      image = null;
    }
    const bucket = Math.round(video.currentTime / BUCKET_SECONDS);
    cacheRef.current.set(bucket, image);
    if (cacheRef.current.size > MAX_CACHED_THUMBNAILS) {
      const oldestBucket = cacheRef.current.keys().next().value;
      if (oldestBucket != null) cacheRef.current.delete(oldestBucket);
    }
    setPreview({ image, time: video.currentTime });
  }, []);

  /** Seek the hidden video toward `timeSeconds` to drive a capture. */
  const requestCapture = useCallback(
    (timeSeconds: number) => {
      const video = videoRef.current;
      if (video == null || !sourceAttachedRef.current || !hoveringRef.current || document.visibilityState === "hidden") return;
      if (!Number.isFinite(video.duration)) {
        pendingTimeRef.current = timeSeconds;
        return;
      }
      const t = Math.max(0, Math.min(timeSeconds, video.duration - 0.1));
      if (seekingRef.current) {
        pendingTimeRef.current = t; // coalesce while a seek is in flight
        return;
      }
      pendingTimeRef.current = null;
      // If we're already at this frame, no 'seeked' event would fire - capture
      // once current frame data arrives; metadata alone is not drawable.
      if (Math.abs(t - video.currentTime) < 0.05) {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          pendingTimeRef.current = t;
          return;
        }
        captureCurrentFrame();
        return;
      }
      seekingRef.current = true;
      clearSeekTimer();
      seekTimerRef.current = setTimeout(() => {
        // The seek never reported back (stalled or dropped stream). Drop the
        // in-flight flag so the next hover can drive a fresh capture.
        seekTimerRef.current = null;
        seekingRef.current = false;
        pendingTimeRef.current = null;
      }, SEEK_TIMEOUT_MS);
      video.currentTime = t;
    },
    [captureCurrentFrame, clearSeekTimer],
  );

  const onHover = useCallback(
    (timeSeconds: number) => {
      const video = videoRef.current;
      if (!enabled || !sourceUrl || sourceOwnerRef.current !== sourceUrl || video == null ||
          !Number.isFinite(timeSeconds) || document.visibilityState === "hidden") return;
      hoveringRef.current = true;
      // Serve from cache instantly when we have a nearby bucket.
      const bucket = Math.round(timeSeconds / BUCKET_SECONDS);
      const cached = cacheRef.current.get(bucket);
      if (cached !== undefined) {
        setPreview({ image: cached, time: timeSeconds });
      } else {
        // Still show the time label immediately, image fills in after the seek.
        setPreview((p) => ({ image: p?.image ?? null, time: timeSeconds }));
      }
      if (!sourceAttachedRef.current) {
        // Source assignment itself can fetch. Do it only for a real preview,
        // with listeners installed and the latest requested time retained.
        sourceAttachedRef.current = true;
        pendingTimeRef.current = timeSeconds;
        video.preload = "auto";
        video.src = sourceUrl;
        video.load();
      }
      const now = Date.now();
      if (now - lastCaptureRef.current < THROTTLE_MS) {
        pendingTimeRef.current = timeSeconds;
        return;
      }
      lastCaptureRef.current = now;
      requestCapture(timeSeconds);
    },
    [enabled, sourceUrl, requestCapture],
  );

  const onLeave = useCallback(() => {
    hoveringRef.current = false;
    lastCaptureRef.current = -Infinity;
    pendingTimeRef.current = null;
    setPreview(null);
  }, []);

  return { preview, onHover, onLeave, available: enabled && ready };
}
