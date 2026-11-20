// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQualityHandoffCover } from "./qualityHandoffCover";

describe("manual quality picture cover", () => {
  const cover = createQualityHandoffCover();
  let canvas: HTMLCanvasElement;
  let video: HTMLVideoElement;
  let target: HTMLVideoElement;
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => ({ drawImage }) as unknown as CanvasRenderingContext2D);
    canvas = document.createElement("canvas");
    canvas.hidden = true;
    video = document.createElement("video");
    target = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: 4 }, videoWidth: { value: 1080 }, videoHeight: { value: 1920 },
    });
    video.style.objectFit = "cover";
    video.style.transform = "scale(1.2)";
    document.body.append(canvas, video, target);
  });

  afterEach(() => {
    cover.clear();
    canvas.remove();
    video.remove();
    target.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("bounds the bitmap, shares viewport fit and frees it if the decoder never presents", () => {
    cover.capture(canvas, video);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 540, 960);
    expect(canvas.style.objectFit).toBe("cover");
    expect(canvas.style.transform).toBe("scale(1.2)");
    expect(cover.waitingFor(video)).toBe(false);
    expect(cover.waitingFor(target)).toBe(true);
    vi.advanceTimersByTime(999);
    expect(canvas.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect([canvas.hidden, canvas.width, canvas.height]).toEqual([true, 0, 0]);
  });

  it("ignores a stale callback after an intervening source and immediately discards on pagehide", () => {
    const frames: VideoFrameRequestCallback[] = [];
    const cancel = vi.fn();
    Object.defineProperties(target, {
      requestVideoFrameCallback: { value: (fn: VideoFrameRequestCallback) => { frames.push(fn); return frames.length; } },
      cancelVideoFrameCallback: { value: cancel },
    });
    cover.capture(canvas, video);
    cover.reveal(target, false, () => true);
    const stale = frames[0];
    cover.capture(canvas, video);
    cover.reveal(target, false, () => true);
    stale(0, {} as VideoFrameCallbackMetadata);
    vi.advanceTimersByTime(100);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(canvas.hidden).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(canvas.hidden).toBe(true);
    expect(cancel).toHaveBeenLastCalledWith(2);
  });

  it("uses two paints for a deliberately paused reader and skips a blocked capture", () => {
    drawImage.mockImplementationOnce(() => { throw new DOMException("Protected", "SecurityError"); });
    cover.capture(canvas, video);
    expect([canvas.hidden, canvas.width, canvas.height]).toEqual([true, 0, 0]);
    cover.capture(canvas, video);
    cover.reveal(target, true, () => true);
    vi.advanceTimersToNextFrame();
    expect(canvas.hidden).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(canvas.hidden).toBe(true);
  });

  it("warms the transparent picture across paints before retiring the outgoing reader", async () => {
    const resolved = vi.fn();
    const ready = cover.prepare(canvas, video, new AbortController().signal);
    expect(ready).not.toBeUndefined();
    void ready?.then(resolved);
    expect(canvas.hidden).toBe(false);
    expect(video.isConnected).toBe(true);
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    await expect(ready).resolves.toBe(true);
    expect(canvas.hidden).toBe(false);
  });

  it("does not retire the outgoing reader after a seek, abort, or replacement during warmup", async () => {
    const signal = new AbortController();
    const seeking = cover.prepare(canvas, video, signal.signal);
    video.dispatchEvent(new Event("seeking"));
    await expect(seeking).resolves.toBe(false);
    expect(canvas.hidden).toBe(true);
    const aborted = cover.prepare(canvas, video, signal.signal);
    signal.abort();
    await expect(aborted).resolves.toBe(false);
    expect(canvas.hidden).toBe(true);
    const replaced = cover.prepare(canvas, video, new AbortController().signal);
    cover.capture(canvas, video);
    await expect(replaced).resolves.toBe(false);
    expect(canvas.hidden).toBe(false);
  });

  it("does not block adoption on a throttled paint and discards its stale pixels", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(9);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const ready = cover.prepare(canvas, video, new AbortController().signal);
    vi.advanceTimersByTime(100);
    await expect(ready).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith(9);
    expect([canvas.hidden, canvas.width, canvas.height]).toEqual([true, 0, 0]);
  });

  it("does not cover native fullscreen or an unready or invalidated replacement", () => {
    Object.defineProperty(video, "webkitDisplayingFullscreen", { configurable: true, value: true });
    cover.capture(canvas, video);
    expect(drawImage).not.toHaveBeenCalled();
    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: false });
    cover.capture(canvas, video);
    const canReveal = vi.fn(() => false);
    cover.reveal(target, true, canReveal);
    vi.advanceTimersToNextFrame();
    expect(canvas.hidden).toBe(false);
    canReveal.mockReturnValue(true);
    cover.reveal(target, true, canReveal);
    canReveal.mockReturnValue(false);
    vi.advanceTimersToNextFrame();
    expect(canvas.hidden).toBe(false);
    expect(cover.waitingFor(target)).toBe(true);
  });
});
