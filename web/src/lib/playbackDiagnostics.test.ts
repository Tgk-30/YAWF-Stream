// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { defaultSettings } from "../data/settings";
import { buildDiagnosticsReport, clearDiagnostics, recentDiagnostics } from "./diagnostics";
import { observePlaybackDiagnostics } from "./playbackDiagnostics";
import type { PlaybackEngine } from "./playbackEngine";

const disposers: Array<() => void> = [];
beforeEach(clearDiagnostics);
afterEach(() => { for (const stop of disposers.splice(0)) stop(); vi.restoreAllMocks(); });
function media() {
  const video = document.createElement("video");
  const state = { currentTime: 12, paused: false, ended: false, seeking: false, readyState: 4, networkState: 1 };
  for (const key of Object.keys(state) as Array<keyof typeof state>) {
    Object.defineProperty(video, key, { configurable: true, get: () => state[key] });
  }
  ranges(video, [[0, 42]]);
  return { video, state };
}
function ranges(video: HTMLVideoElement, values: Array<[number, number]>) {
  Object.defineProperty(video, "buffered", { configurable: true, value: {
    length: values.length, start: (i: number) => values[i]![0], end: (i: number) => values[i]![1],
  } });
}
function start(video: HTMLVideoElement, current = () => true, engine: PlaybackEngine = "webview-direct") {
  const stop = observePlaybackDiagnostics(video, engine, current); disposers.push(stop); return stop;
}
function emit(video: HTMLVideoElement, event: string) { video.dispatchEvent(new Event(event)); }
function latest() { return JSON.parse(recentDiagnostics().at(-1)!.detail!); }
function codes() { return recentDiagnostics().map((e) => e.code); }
function exported() { return buildDiagnosticsReport({ appVersion: "2.3.111", runtime: "browser", platform: "test", serverMode: false, settings: defaultSettings() }); }

describe("event-only playback diagnostics", () => {
  it("records waiting then playing and pause as facts, with empty and full containing buffers", () => {
    const { video, state } = media(); start(video);
    ranges(video, []); emit(video, "waiting");
    expect(latest()).toMatchObject({ currentTime: 12, bufferAhead: 0, paused: false, ended: false, readyState: 4, networkState: 1 });
    ranges(video, [[0, 42]]); emit(video, "playing");
    expect(latest().bufferAhead).toBe(30);
    state.paused = true; emit(video, "pause");
    expect(latest().paused).toBe(true);
    expect(codes()).toEqual(["media.attached", "media.waiting", "media.playing", "media.pause"]);
    expect(JSON.stringify(exported())).not.toMatch(/user.intent|buffering/);
  });

  it("keeps stalled, suspend, emptied, error, ended and seek events distinct", () => {
    const { video, state } = media(); start(video);
    for (const event of ["stalled", "suspend", "emptied", "error", "seeking", "seeked", "ended"]) {
      state.seeking = event === "seeking"; state.ended = event === "ended";
      emit(video, event); expect(codes().at(-1)).toBe(`media.${event}`);
    }
    expect(latest()).toMatchObject({ ended: true, seeking: false, bufferAhead: 30 });
  });

  it("does not bridge gaps or use the last range instead of the clock's range", () => {
    const { video, state } = media(); start(video);
    ranges(video, [[0, 5], [10, 20], [40, 60]]); emit(video, "waiting");
    expect(latest().bufferAhead).toBe(8);
    state.currentTime = 30; emit(video, "waiting"); expect(latest().bufferAhead).toBe(0);
    state.currentTime = 20; emit(video, "waiting"); expect(latest().bufferAhead).toBe(0);
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 65, start: vi.fn(), end: vi.fn() } });
    emit(video, "waiting"); expect(latest().bufferAhead).toBeNull();
  });

  it("uses null for unsupported, nonfinite and throwing media values without serializing errors", () => {
    const { video } = media(); start(video);
    for (const key of ["currentTime", "paused", "ended", "seeking", "readyState", "networkState", "buffered"]) {
      Object.defineProperty(video, key, { configurable: true, get: () => { throw new Error("https://private.invalid/token=private"); } });
    }
    Object.defineProperty(video, "getVideoPlaybackQuality", { configurable: true, value: () => { throw new Error("private"); } });
    emit(video, "error");
    expect(latest()).toMatchObject({ currentTime: null, bufferAhead: null, paused: null, ended: null, seeking: null, readyState: null, networkState: null, totalVideoFrames: null, droppedVideoFrames: null });
    Object.defineProperty(video, "currentTime", { configurable: true, value: Infinity });
    Object.defineProperty(video, "readyState", { configurable: true, value: NaN });
    Object.defineProperty(video, "networkState", { configurable: true, value: "https://private.invalid" });
    emit(video, "waiting"); expect(latest().currentTime).toBeNull(); expect(latest().networkState).toBeNull();
    expect(JSON.stringify(exported())).not.toContain("private");
  });

  it.each([[[NaN, 20]], [[0, Infinity]], [[20, 10]]])("refuses malformed buffer range %j", (range) => {
    const { video } = media(); start(video); ranges(video, [range as [number, number]]); emit(video, "waiting");
    expect(latest().bufferAhead).toBeNull();
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, start: () => { throw new Error("bad range"); } } });
    emit(video, "pause"); expect(latest().bufferAhead).toBeNull();
  });

  it("clamps numeric values and retains valid bounded JSON through the existing export", () => {
    const { video, state } = media(); state.currentTime = 1e20; state.readyState = 99; state.networkState = -5;
    Object.defineProperty(video, "getVideoPlaybackQuality", { value: () => ({ totalVideoFrames: 1e30, droppedVideoFrames: -2 }) });
    start(video, () => true, "webview-hls-transcode");
    expect(latest()).toMatchObject({ currentTime: 100_000_000, readyState: 4, networkState: 0, totalVideoFrames: Number.MAX_SAFE_INTEGER, droppedVideoFrames: 0, engine: "webview-hls-transcode" });
    const detail = exported().events.at(-1)!.detail!;
    expect(detail.length).toBeLessThanOrEqual(500); expect(JSON.parse(detail)).toEqual(latest());
  });

  it("never reads sources, titles or IDs and discards injected strings, event data and arbitrary shapes", () => {
    const { video } = media(); const forbidden = vi.fn(() => { throw new Error("private source"); });
    for (const key of ["src", "currentSrc", "title", "id", "error"]) Object.defineProperty(video, key, { configurable: true, get: forbidden });
    Object.defineProperty(video, "webkitPresentationMode", { configurable: true, value: "https://private.invalid/secret" });
    Object.defineProperty(video, "getVideoPlaybackQuality", { value: () => ({ totalVideoFrames: { toJSON: () => "injected" }, droppedVideoFrames: "https://private.invalid/secret", source: "private" }) });
    start(video, () => true, "https://private.invalid/secret" as PlaybackEngine);
    video.dispatchEvent(new CustomEvent("error", { detail: { url: "https://private.invalid/secret" } }));
    const text = JSON.stringify(exported());
    expect(forbidden).not.toHaveBeenCalled(); expect(text).not.toMatch(/private|injected/);
    expect(latest()).toMatchObject({ presentation: null, totalVideoFrames: null, droppedVideoFrames: null, engine: null });
    expect(Object.keys(latest())).toEqual(["currentTime", "bufferAhead", "readyState", "networkState", "paused", "ended", "seeking", "totalVideoFrames", "droppedVideoFrames", "visibility", "presentation", "pictureInPicture", "engine"]);
  });

  it("records only allowlisted visibility, PiP and presentation observations", () => {
    const { video } = media(); start(video);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    Object.defineProperty(video, "webkitPresentationMode", { configurable: true, value: "picture-in-picture" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(latest()).toMatchObject({ visibility: "hidden", presentation: "picture-in-picture", pictureInPicture: true });
    Object.defineProperty(video, "webkitPresentationMode", { configurable: true, value: "fullscreen" });
    emit(video, "webkitbeginfullscreen"); expect(latest().presentation).toBe("fullscreen");
    Object.defineProperty(video, "webkitPresentationMode", { configurable: true, value: "inline" });
    emit(video, "webkitendfullscreen"); expect(latest().presentation).toBe("inline");
    window.dispatchEvent(new Event("pagehide")); expect(codes().at(-1)).toBe("media.pagehide");
  });

  it("deduplicates immediate identical events but never the first changed state or event", () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { video, state } = media(); start(video);
    emit(video, "waiting"); emit(video, "waiting"); expect(codes().filter((x) => x === "media.waiting")).toHaveLength(1);
    state.readyState = 2; emit(video, "waiting"); expect(codes().filter((x) => x === "media.waiting")).toHaveLength(2);
    ranges(video, []); emit(video, "waiting"); expect(codes().filter((x) => x === "media.waiting")).toHaveLength(3);
    emit(video, "playing"); expect(codes().at(-1)).toBe("media.playing");
    clock = 1001; emit(video, "playing"); expect(codes().filter((x) => x === "media.playing")).toHaveLength(2);
  });

  it("samples timeupdate no more than once per15s of wall time, not media time, with no scheduled sampling", () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { video, state } = media(); start(video);
    for (let tick = 0; tick <= 1200; tick += 1) {
      clock = tick * 250; state.currentTime = tick * 10; emit(video, "timeupdate");
    }
    expect(codes().filter((x) => x === "media.timeupdate")).toHaveLength(21);
    const count = recentDiagnostics().length; clock += 60_000;
    expect(recentDiagnostics()).toHaveLength(count);
    emit(video, "pause"); expect(codes().at(-1)).toBe("media.pause");
  });

  it("uses the existing100-event ring, not a second unbounded history", () => {
    const { video } = media(); start(video);
    for (let i = 0; i < 150; i += 1) emit(video, i % 2 ? "waiting" : "playing");
    expect(recentDiagnostics()).toHaveLength(100); expect(exported().events).toHaveLength(100);
    expect(codes()).not.toContain("media.attached");
  });

  it("removes every listener and fences queued handlers, stale owners and replaced videos", () => {
    const { video } = media(); const add = vi.spyOn(video, "addEventListener");
    const remove = vi.spyOn(video, "removeEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener"); const winRemove = vi.spyOn(window, "removeEventListener");
    let current = true; const stop = start(video, () => current); const callbacks = [...add.mock.calls];
    current = false; emit(video, "pause"); expect(codes()).toEqual(["media.attached"]);
    stop(); current = true;
    for (const [, handler] of callbacks) (handler as EventListener)(new Event("pause"));
    emit(video, "waiting"); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pagehide"));
    expect(codes()).toEqual(["media.attached"]);
    for (const [event, handler] of callbacks) expect(remove).toHaveBeenCalledWith(event, handler);
    expect(docRemove.mock.calls.map(([name]) => name)).toEqual(["visibilitychange", "fullscreenchange"]);
    expect(winRemove.mock.calls.map(([name]) => name)).toEqual(["pagehide", "pageshow"]);
    const next = media().video; start(next); emit(video, "waiting"); emit(next, "playing");
    expect(codes()).toEqual(["media.attached", "media.attached", "media.playing"]);
  });

  it("does not schedule work, mutate playback, contact a service or persist data", () => {
    const { video } = media(); const timer = vi.spyOn(window, "setTimeout"); const interval = vi.spyOn(window, "setInterval");
    const animation = vi.spyOn(window, "requestAnimationFrame"); const fetch = vi.spyOn(globalThis, "fetch");
    const beacon = vi.fn(); Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const local = vi.spyOn(Storage.prototype, "setItem");
    const play = vi.spyOn(video, "play"); const pause = vi.spyOn(video, "pause"); const load = vi.spyOn(video, "load");
    const stop = start(video); emit(video, "waiting"); emit(video, "timeupdate"); emit(video, "playing"); stop();
    for (const mock of [timer, interval, animation, fetch, beacon, local, play, pause, load]) expect(mock).not.toHaveBeenCalled();
    const source = readFileSync("src/lib/playbackDiagnostics.ts", "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|fetch\(|sendBeacon|localStorage|sessionStorage|currentSrc|\.src\b/);
    delete (navigator as unknown as Record<string, unknown>).sendBeacon;
  });
});
