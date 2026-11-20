// Keep one bounded in-memory frame through a manual reader replacement. This
// does not hold the previous decoder, alter media events or export a bitmap.
const MAX_FRAME_EDGE = 960;
const COVER_TIMEOUT_MS = 1000;
const COVER_WARMUP_MS = 38;
const COVER_WARMUP_DEADLINE_MS = 96;

type Cover = {
  canvas: HTMLCanvasElement;
  outgoing: HTMLVideoElement;
  timer: number;
  cancelWarmup?: () => void;
  cancelPaint?: () => void;
  cancelVideoFrame?: () => void;
};

export function createQualityHandoffCover() {
  let current: Cover | null = null;

  function clear() {
    const cover = current;
    if (cover == null) return;
    current = null;
    window.clearTimeout(cover.timer);
    cover.cancelWarmup?.();
    cover.cancelPaint?.();
    cover.cancelVideoFrame?.();
    const { canvas } = cover;
    canvas.ownerDocument.removeEventListener("visibilitychange", clearWhenHidden);
    window.removeEventListener("pagehide", clear);
    canvas.hidden = true;
    canvas.width = 0;
    canvas.height = 0;
  }

  function clearWhenHidden() {
    if (current?.canvas.ownerDocument.visibilityState === "hidden") clear();
  }

  function capture(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    clear();
    const { ownerDocument: doc } = canvas;
    const presentation = video as HTMLVideoElement & {
      webkitDisplayingFullscreen?: boolean;
      webkitPresentationMode?: string;
    };
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!canvas.isConnected || !video.isConnected || doc.visibilityState === "hidden" ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking || video.error != null ||
        width <= 0 || height <= 0 || doc.pictureInPictureElement === video ||
        doc.fullscreenElement === video || presentation.webkitDisplayingFullscreen ||
        (presentation.webkitPresentationMode != null && presentation.webkitPresentationMode !== "inline")) return;
    try {
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (context == null) throw new Error("Canvas unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      // Drawing is optional. A blocked capture must not delay the new reader.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    canvas.style.objectFit = video.style.objectFit;
    canvas.style.transform = video.style.transform;
    current = { canvas, outgoing: video, timer: window.setTimeout(clear, COVER_TIMEOUT_MS) };
    doc.addEventListener("visibilitychange", clearWhenHidden);
    window.addEventListener("pagehide", clear);
    canvas.hidden = false;
    return current;
  }

  // Leave the outgoing reader connected while WebKit presents the bitmap.
  // A timeout abandons the optional cover, not the requested quality change.
  function prepare(canvas: HTMLCanvasElement, video: HTMLVideoElement, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(false);
    const cover = capture(canvas, video);
    if (cover == null) return;
    return new Promise<boolean>((resolve) => {
      let raf = 0;
      let paints = 0;
      const startedAt = performance.now();
      const finish = (proceed: boolean, keepPicture = false) => {
        window.cancelAnimationFrame(raf);
        window.clearTimeout(deadline);
        signal.removeEventListener("abort", invalidate);
        video.removeEventListener("seeking", invalidate);
        cover.cancelWarmup = undefined;
        if (!keepPicture && current === cover) clear();
        resolve(proceed);
      };
      const invalidate = () => finish(false);
      const deadline = window.setTimeout(() => finish(true), COVER_WARMUP_DEADLINE_MS);
      cover.cancelWarmup = invalidate;
      signal.addEventListener("abort", invalidate);
      video.addEventListener("seeking", invalidate);
      const painted = () => {
        if (++paints >= 2 && performance.now() - startedAt >= COVER_WARMUP_MS) finish(true, true);
        else raf = window.requestAnimationFrame(painted);
      };
      raf = window.requestAnimationFrame(painted);
    });
  }

  function waitingFor(video: HTMLVideoElement) {
    return current != null && current.outgoing !== video &&
      current.cancelPaint == null && current.cancelVideoFrame == null;
  }

  function reveal(video: HTMLVideoElement, pausedIntent: boolean, canReveal: () => boolean) {
    const cover = current;
    if (cover == null || !waitingFor(video) || !canReveal()) return;

    const afterPaint = (twoFrames = false) => {
      if (current !== cover) return;
      const id = window.requestAnimationFrame(() => {
        if (current !== cover) return;
        cover.cancelPaint = undefined;
        if (!canReveal()) return;
        if (twoFrames) afterPaint();
        else clear();
      });
      cover.cancelPaint = () => window.cancelAnimationFrame(id);
    };

    if (typeof video.requestVideoFrameCallback === "function" && !pausedIntent) {
      const id = video.requestVideoFrameCallback(() => {
        if (current !== cover) return;
        cover.cancelVideoFrame = undefined;
        // The frame callback can precede the compositor consuming that frame.
        // Leave the old picture through the next paint opportunity.
        if (canReveal()) afterPaint();
      });
      cover.cancelVideoFrame = () => video.cancelVideoFrameCallback?.(id);
    } else {
      // A deliberately paused reader may have presented its only seek frame
      // before readiness. Confirm its data and settle through two paints.
      afterPaint(true);
    }
  }

  return { capture, clear, prepare, reveal, waitingFor };
}
