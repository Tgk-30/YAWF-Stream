// @vitest-environment jsdom
//
// useScrubThumbnails: build/teardown of the hidden capture video+canvas, the
// hover->cache->throttle->seek->capture flow, the no-op-seek direct capture, the
// in-flight coalescing via pendingTime, cross-origin taint fallback, and cleanup.
//
// The hook calls document.createElement("video"/"canvas") directly, so we stub
// createElement to hand back controllable fakes whose getContext/toDataURL/
// currentTime/duration/dispatchEvent we can drive from the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrubThumbnails } from "./useScrubThumbnails";

// --- Fake DOM elements ------------------------------------------------------

interface FakeVideo {
  src: string;
  muted: boolean;
  preload: string;
  playsInline: boolean;
  duration: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  crossOrigin?: string;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  removeAttribute: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  __listeners: Record<string, Array<() => void>>;
  __fire: (type: string) => void;
  __currentTimeSets: number[];
  __sourceSets: string[];
}

function makeFakeVideo(): FakeVideo {
  const listeners: Record<string, Array<() => void>> = {};
  let currentTime = 0;
  const currentTimeSets: number[] = [];
  let src = "";
  const sourceSets: string[] = [];
  const v: FakeVideo = {
    src: "",
    muted: false,
    preload: "",
    playsInline: false,
    duration: NaN,
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 0,
    __listeners: listeners,
    __currentTimeSets: currentTimeSets,
    __sourceSets: sourceSets,
    addEventListener: (type: string, cb: () => void) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb);
    },
    removeAttribute: vi.fn(),
    load: vi.fn(),
    __fire: (type: string) => {
      (listeners[type] ?? []).slice().forEach((f) => f());
    },
  };
  Object.defineProperty(v, "src", {
    get: () => src,
    set: (value: string) => { src = value; sourceSets.push(value); },
  });
  Object.defineProperty(v, "currentTime", {
    get: () => currentTime,
    set: (val: number) => {
      currentTime = val;
      currentTimeSets.push(val);
    },
    configurable: true,
  });
  return v;
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
  __ctx: { drawImage: ReturnType<typeof vi.fn> };
}

function makeFakeCanvas(opts: { taint?: boolean; noCtx?: boolean } = {}): FakeCanvas {
  const ctx = { drawImage: vi.fn() };
  return {
    width: 0,
    height: 0,
    __ctx: ctx,
    getContext: vi.fn(() => (opts.noCtx ? null : ctx)),
    toDataURL: vi.fn(() => {
      if (opts.taint) throw new Error("SecurityError: tainted canvas");
      return "data:image/jpeg;base64,AAAA";
    }),
  };
}

// Install a createElement stub that returns our fakes. Returns the most-recently
// created video/canvas via accessors for assertions.
function installDom(canvasOpts: { taint?: boolean; noCtx?: boolean } = {}) {
  const created: { video: FakeVideo | null; canvas: FakeCanvas | null } = {
    video: null,
    canvas: null,
  };
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "video") {
      created.video = makeFakeVideo();
      return created.video as unknown as HTMLElement;
    }
    if (tag === "canvas") {
      created.canvas = makeFakeCanvas(canvasOpts);
      return created.canvas as unknown as HTMLElement;
    }
    return realCreate(tag);
  });
  return created;
}

const SRC = "https://debrid.example/stream.mkv";

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useScrubThumbnails", () => {
  it("does not create a hidden video and is unavailable when disabled", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, false));
    expect(created.video).toBeNull();
    expect(result.current.available).toBe(false);
    // onHover is a no-op when disabled: no preview is set.
    act(() => result.current.onHover(10));
    expect(result.current.preview).toBeNull();
  });

  it("creates the hidden capture video configured for no-CORS, muted load", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    act(() => result.current.onHover(10));
    expect(v.src).toBe(SRC);
    expect(v.muted).toBe(true);
    expect(v.preload).toBe("auto");
    expect(v.playsInline).toBe(true);
    // No crossOrigin set (debrid hosts send no CORS headers).
    expect(v.crossOrigin).toBeUndefined();
  });

  it("becomes available only after loadedmetadata with a finite duration", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    expect(result.current.available).toBe(false);
    const v = created.video!;
    act(() => result.current.onHover(10));
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));
    expect(result.current.available).toBe(true);
  });

  it("stays unavailable when duration is not finite at loadedmetadata", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    act(() => result.current.onHover(10));
    v.duration = Infinity;
    act(() => v.__fire("loadedmetadata"));
    expect(result.current.available).toBe(false);
  });

  it("on hover seeks the hidden video, then captures a frame on 'seeked'", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    const c = created.canvas!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));

    act(() => result.current.onHover(30));
    // Time label shows immediately.
    expect(result.current.preview).toEqual({ image: null, time: 30 });
    // It seeked toward 30 (clamped to duration-0.1).
    expect(v.__currentTimeSets).toEqual([30]);

    // Now the seek completes -> draw + export.
    act(() => v.__fire("seeked"));
    expect(c.__ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(c.width).toBe(168);
    // ratio 1080/1920 = 0.5625 -> round(168*0.5625) = 95
    expect(c.height).toBe(95);
    expect(c.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.6);
    expect(result.current.preview).toEqual({
      image: "data:image/jpeg;base64,AAAA",
      time: 30,
    });
  });

  it("clamps the seek target to >=0 and <= duration-0.1", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 100;
    act(() => v.__fire("loadedmetadata"));

    act(() => result.current.onHover(999));
    expect(v.__currentTimeSets).toEqual([99.9]);
  });

  it("serves a cached frame's image instantly on re-hover of the same bucket", async () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));

    // First hover at 30 (bucket round(30/5)=6) -> seek -> seeked -> cache holds
    // the data-URL for bucket 6.
    act(() => result.current.onHover(30));
    act(() => v.__fire("seeked"));

    // Wait out the throttle window (THROTTLE_MS=120) with a comfortable margin
    // so the assertion isn't flaky under load / timer imprecision.
    await new Promise((r) => setTimeout(r, 250));

    // Hover at 31 -> same bucket 6 -> the cached image is shown IMMEDIATELY
    // (synchronously, before any new 'seeked'), with the live hovered time.
    act(() => result.current.onHover(31));
    expect(result.current.preview).toEqual({
      image: "data:image/jpeg;base64,AAAA",
      time: 31,
    });
  });

  it("evicts the first thumbnail when the 121st bucket is inserted", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    const c = created.canvas!;
    v.duration = 1_000;
    let now = 0;
    let captures = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    c.toDataURL.mockImplementation(() => `data:image/jpeg;base64,${++captures}`);
    act(() => v.__fire("loadedmetadata"));

    for (let bucket = 0; bucket <= 120; bucket += 1) {
      now += 121;
      act(() => result.current.onHover(bucket * 5));
      if (bucket > 0) act(() => v.__fire("seeked"));
    }
    expect(captures).toBe(121);

    // Bucket 0 has been evicted, so its hover keeps the most recent image until
    // the new seek completes rather than serving the original cached data URL.
    now += 121;
    act(() => result.current.onHover(0));
    expect(result.current.preview).toEqual({
      image: "data:image/jpeg;base64,121",
      time: 0,
    });
    act(() => v.__fire("seeked"));
  });

  it("throttles rapid hovers: the second within the window stores a pending time and does not seek again", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 600;
    act(() => v.__fire("loadedmetadata"));

    // Hover at 100 (bucket 20) -> seek begins.
    act(() => result.current.onHover(100));
    expect(v.__currentTimeSets).toEqual([100]);

    // Immediately hover at 200 (bucket 40, uncached) within THROTTLE_MS:
    // throttled -> records pendingTime, no second seek yet.
    act(() => result.current.onHover(200));
    expect(v.__currentTimeSets).toEqual([100]);
    // Time label still updated to the latest hovered time.
    expect(result.current.preview?.time).toBe(200);

    // The first seek completes -> capture, then chase the pending (200).
    act(() => v.__fire("seeked"));
    expect(v.__currentTimeSets).toEqual([100, 200]);
  });

  it("coalesces a hover that arrives while a seek is in flight (seekingRef)", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 600;
    act(() => v.__fire("loadedmetadata"));

    // Start a seek to 100. seekingRef is now true (no 'seeked' yet).
    act(() => result.current.onHover(100));
    expect(v.__currentTimeSets).toEqual([100]);

    // Force the throttle to be open so requestCapture actually runs, then hover
    // far away. Because seekingRef is set, it coalesces into pendingTime rather
    // than issuing a second concurrent seek.
    // (Date.now throttle: advance real time past THROTTLE_MS.)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        act(() => result.current.onHover(300));
        // No new seek issued while one is in flight.
        expect(v.__currentTimeSets).toEqual([100]);
        // Completing the first seek chases the coalesced pending time.
        act(() => v.__fire("seeked"));
        expect(v.__currentTimeSets).toEqual([100, 300]);
        resolve();
      }, 250); // > THROTTLE_MS (120) with margin - de-flake under load
    });
  });

  it("captures directly on a no-op seek (target within 0.05 of currentTime)", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    const c = created.canvas!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));

    // currentTime is 0; hover at 0.0 -> |0-0|<0.05 -> capture directly, no seek.
    act(() => result.current.onHover(0));
    expect(v.__currentTimeSets).toEqual([]);
    // Captured immediately without waiting for a 'seeked' event.
    expect(c.__ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(result.current.preview?.image).toBe("data:image/jpeg;base64,AAAA");
  });

  it("falls back to a null image (time-only) when the canvas is tainted", () => {
    const created = installDom({ taint: true });
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));

    act(() => result.current.onHover(40));
    act(() => v.__fire("seeked"));
    expect(result.current.preview).toEqual({ image: null, time: 40 });
  });

  it("recovers from a media error during a seek so later hovers still capture", async () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 600;
    act(() => v.__fire("loadedmetadata"));
    act(() => result.current.onHover(100));
    expect(v.__currentTimeSets).toEqual([100]);
    // The stream errors: no 'seeked' will ever arrive for that seek.
    act(() => v.__fire("error"));
    await new Promise((r) => setTimeout(r, 250)); // clear the throttle window
    act(() => result.current.onHover(300));
    expect(v.__currentTimeSets).toEqual([100, 300]);
  });

  it("recovers via the seek watchdog when 'seeked' never fires", () => {
    vi.useFakeTimers();
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 600;
    act(() => v.__fire("loadedmetadata"));
    act(() => result.current.onHover(100));
    expect(v.__currentTimeSets).toEqual([100]);
    // No 'seeked' ever arrives. After SEEK_TIMEOUT_MS the flag must drop.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => result.current.onHover(300));
    expect(v.__currentTimeSets).toEqual([100, 300]);
  });

  it("resets in-flight seek state when the source url changes", async () => {
    const created = installDom();
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useScrubThumbnails(url, true),
      { initialProps: { url: SRC } },
    );
    const first = created.video!;
    first.duration = 600;
    act(() => first.__fire("loadedmetadata"));
    act(() => result.current.onHover(100)); // seek in flight, never completes
    rerender({ url: "https://debrid.example/other.mkv" });
    const second = created.video!;
    second.duration = 600;
    act(() => second.__fire("loadedmetadata"));
    await new Promise((r) => setTimeout(r, 250)); // lastCaptureRef survives the rebuild
    act(() => result.current.onHover(200));
    expect(second.__currentTimeSets).toEqual([200]);
  });

  it("bails out of capture when getContext returns null", () => {
    const created = installDom({ noCtx: true });
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    const c = created.canvas!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));

    act(() => result.current.onHover(50));
    act(() => v.__fire("seeked"));
    // No draw/export happened and no preview was set from the capture.
    expect(c.toDataURL).not.toHaveBeenCalled();
  });

  it("uses a 9/16 fallback ratio when videoWidth/Height are unavailable", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    const c = created.canvas!;
    v.duration = 120;
    v.videoWidth = 0;
    v.videoHeight = 0;
    act(() => v.__fire("loadedmetadata"));

    act(() => result.current.onHover(0));
    // round(168 * 9/16) = round(94.5) = 95 (videoHeight>0 false -> 9/16).
    expect(c.height).toBe(95);
  });

  it("onLeave clears the preview and pending time", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));
    act(() => result.current.onHover(30));
    expect(result.current.preview).not.toBeNull();

    act(() => result.current.onLeave());
    expect(result.current.preview).toBeNull();
  });

  it("ignores hover before metadata is loaded (no finite duration -> no seek)", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    // duration is NaN (no loadedmetadata fired yet).
    act(() => result.current.onHover(30));
    // Time label still set, but no seek attempted.
    expect(result.current.preview).toEqual({ image: null, time: 30 });
    expect(v.__currentTimeSets).toEqual([]);
  });

  it("tears down listeners and resets the hidden video on unmount", () => {
    const created = installDom();
    const { result, unmount } = renderHook(() => useScrubThumbnails(SRC, true));
    const v = created.video!;
    v.duration = 120;
    act(() => v.__fire("loadedmetadata"));
    act(() => result.current.onHover(30));

    unmount();
    expect(v.removeAttribute).toHaveBeenCalledWith("src");
    expect(v.load).toHaveBeenCalled();
    // Listeners were removed.
    expect(v.__listeners["seeked"]).toEqual([]);
    expect(v.__listeners["loadedmetadata"]).toEqual([]);
    expect(v.__listeners["loadeddata"]).toEqual([]);
  });

  it("rebuilds the hidden video when the source url changes", () => {
    const created = installDom();
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useScrubThumbnails(url, true),
      { initialProps: { url: SRC } },
    );
    const first = created.video!;
    rerender({ url: "https://debrid.example/other.mkv" });
    const second = created.video!;
    expect(second).not.toBe(first);
    expect(second.src).toBe("");
    act(() => result.current.onHover(20));
    expect(second.src).toBe("https://debrid.example/other.mkv");
    // The unused previous video never acquired a source.
    expect(first.load).not.toHaveBeenCalled();
  });
  it("does not acquire a source or load media before the first preview interaction", () => {
    const created = installDom();
    const { unmount } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    expect(video.src).toBe("");
    expect(video.__sourceSets).toEqual([]);
    expect(video.preload).toBe("none");
    expect(video.load).not.toHaveBeenCalled();
    unmount();
    expect(video.load).not.toHaveBeenCalled();
  });

  it("acquires once on first hover and seeks the latest pending preview after metadata", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    act(() => result.current.onHover(10));
    expect(video.src).toBe(SRC);
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual({ image: null, time: 10 });
    act(() => result.current.onHover(35));
    expect(video.load).toHaveBeenCalledTimes(1);
    expect(video.__sourceSets).toEqual([SRC]);
    expect(video.__currentTimeSets).toEqual([]);
    expect(result.current.preview).toEqual({ image: null, time: 35 });
    video.duration = 120;
    act(() => video.__fire("loadedmetadata"));
    expect(video.__currentTimeSets).toEqual([35]);
    act(() => video.__fire("seeked"));
    expect(result.current.preview).toEqual({ image: "data:image/jpeg;base64,AAAA", time: 35 });
  });

  it("does not resume a metadata-pending request after pointer leave", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    act(() => result.current.onHover(30));
    act(() => result.current.onLeave());
    video.duration = 120;
    act(() => video.__fire("loadedmetadata"));
    expect(video.__currentTimeSets).toEqual([]);
    expect(created.canvas!.__ctx.drawImage).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    // A fresh interaction still works; leaving must not disable the owner.
    act(() => result.current.onHover(40));
    expect(video.__currentTimeSets).toEqual([40]);
    act(() => video.__fire("seeked"));
    expect(result.current.preview?.time).toBe(40);
  });

  it("does not revive a tooltip or chase pending seeks after pointer leave", () => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    video.duration = 120;
    act(() => result.current.onHover(30));
    act(() => result.current.onHover(40));
    act(() => result.current.onLeave());
    act(() => video.__fire("seeked"));
    expect(result.current.preview).toBeNull();
    expect(video.__currentTimeSets).toEqual([30]);
    expect(created.canvas!.__ctx.drawImage).not.toHaveBeenCalled();
  });

  it("rejects stale source callbacks and does not carry pending metadata into a new source", () => {
    const created = installDom();
    const { result, rerender } = renderHook(({ url }) => useScrubThumbnails(url, true), { initialProps: { url: SRC } });
    const first = created.video!;
    const oldHover = result.current.onHover;
    act(() => oldHover(30));
    const lateMetadata = first.__listeners.loadedmetadata[0];
    rerender({ url: "https://debrid.example/other.mkv" });
    const second = created.video!;
    act(() => oldHover(50));
    first.duration = 120;
    act(() => lateMetadata());
    expect(second.__sourceSets).toEqual([]);
    expect(second.load).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    act(() => result.current.onHover(60));
    second.duration = 120;
    act(() => second.__fire("loadedmetadata"));
    expect(second.__sourceSets).toEqual(["https://debrid.example/other.mkv"]);
    expect(second.__currentTimeSets).toEqual([60]);
  });

  it("does not acquire or seek in a hidden document and needs a fresh hover after visibility returns", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    act(() => result.current.onHover(20));
    expect(video.__sourceSets).toEqual([]);
    expect(video.load).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    visibility.mockReturnValue("visible");
    act(() => result.current.onHover(30));
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.load).toHaveBeenCalledTimes(2); // acquisition, then cancellation
    video.duration = 120;
    act(() => video.__fire("loadedmetadata"));
    act(() => video.__fire("seeked"));
    expect(video.__currentTimeSets).toEqual([]);
    expect(result.current.preview).toBeNull();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(video.load).toHaveBeenCalledTimes(2);
    act(() => result.current.onHover(50));
    expect(video.load).toHaveBeenCalledTimes(3);
    expect(video.__currentTimeSets).toEqual([50]);
  });

  it("does not issue deferred work or accept a hover after unmount or disable", () => {
    const created = installDom();
    const { result, unmount, rerender } = renderHook(({ enabled }) => useScrubThumbnails(SRC, enabled), { initialProps: { enabled: true } });
    const video = created.video!;
    const hover = result.current.onHover;
    act(() => hover(30));
    const lateMetadata = video.__listeners.loadedmetadata[0];
    const lateSeeked = video.__listeners.seeked[0];
    rerender({ enabled: false });
    unmount();
    video.duration = 120;
    act(() => { hover(50); lateMetadata(); lateSeeked(); });
    expect(video.__sourceSets).toEqual([SRC]);
    expect(video.load).toHaveBeenCalledTimes(2); // acquisition, then cleanup
    expect(video.__currentTimeSets).toEqual([]);
    expect(created.canvas!.__ctx.drawImage).not.toHaveBeenCalled();
  });

  it.each([0, 0.03])("waits for current frame data after cold first hover at %s", (time) => {
    const created = installDom();
    const { result } = renderHook(() => useScrubThumbnails(SRC, true));
    const video = created.video!;
    const canvas = created.canvas!;
    video.readyState = 0;
    act(() => result.current.onHover(time));
    video.duration = 120;
    video.readyState = 1; // HAVE_METADATA, but no drawable current frame yet
    act(() => video.__fire("loadedmetadata"));
    expect(video.__currentTimeSets).toEqual([]);
    expect(canvas.__ctx.drawImage).not.toHaveBeenCalled();
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    expect(result.current.preview).toEqual({ image: null, time });
    act(() => video.__fire("loadeddata"));
    expect(canvas.__ctx.drawImage).not.toHaveBeenCalled();
    video.readyState = 2; // HAVE_CURRENT_DATA, with the pointer still in place
    act(() => video.__fire("loadeddata"));
    expect(canvas.__ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(canvas.toDataURL).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual({ image: "data:image/jpeg;base64,AAAA", time: 0 });
    expect(video.__sourceSets).toEqual([SRC]);
    expect(video.load).toHaveBeenCalledTimes(1);
    // Repeated readiness notifications must not recapture a completed request.
    act(() => video.__fire("loadeddata"));
    expect(canvas.__ctx.drawImage).toHaveBeenCalledTimes(1);
  });

});
