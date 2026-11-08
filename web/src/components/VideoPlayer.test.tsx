// @vitest-environment jsdom
//
// Control-UI + effect tests for the in-app VideoPlayer. Real playback (codec
// decode, HLS networking, native mpv hand-off) is mocked away; we exercise the
// branch selection (webview vs external), the CC popover toggle, the OSD row,
// the HLS source attach and recovery paths, and the mpv lifecycle effect.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, Suspense, startTransition, useState } from "react";
import { readFileSync } from "node:fs";
import type {
  ServerAudioInventoryLoadOptions,
  ServerAudioTrack,
  ServerTranscodeQuality,
} from "../lib/serverApi";

// ---- Mocks for heavy / environment-bound deps -----------------------------

// A gated observer for one callback ownership test. Every useRef invocation
// always forwards its original arguments to the real hook unchanged.
const failureRefObserver = vi.hoisted(() => ({
  enabled: false,
  refs: [] as Array<{ current: (message: string, exactHandoffPending: boolean) => void }>,
}));
const stallRecoveryObserver = vi.hoisted(() => ({
  enabled: false,
  callbacks: [] as Array<(position: number, state: { paused: boolean; volume: number; muted: boolean; playbackRate: number }) => Promise<boolean>>,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useCallback: ((...args: Parameters<typeof actual.useCallback>) => {
      const callback = actual.useCallback(...args);
      const observed = callback as (typeof stallRecoveryObserver.callbacks)[number];
      if (stallRecoveryObserver.enabled && callback.toString().includes("stall.refresh_started") && !stallRecoveryObserver.callbacks.includes(observed)) {
        stallRecoveryObserver.callbacks.push(observed);
      }
      return callback;
    }) as typeof actual.useCallback,
    useRef: ((...args: unknown[]) => {
      const ref = Reflect.apply(actual.useRef, undefined, args);
      const initial = args[0];
      if (failureRefObserver.enabled && typeof initial === "function" && initial.name === "onPlaybackError" && !failureRefObserver.refs.includes(ref)) {
        failureRefObserver.refs.push(ref);
      }
      return ref;
    }) as typeof actual.useRef,
  };
});

// hls.js: default export with the static helpers the source touches. The shared
// state is created via vi.hoisted so the hoisted vi.mock factory can close over
// it without a temporal-dead-zone error.
const { hlsInstances, hlsIsSupported } = vi.hoisted(() => ({
  hlsInstances: [] as Array<{
    config: {
      startPosition?: number;
      xhrSetup?: (xhr: XMLHttpRequest, url?: string) => void;
      manifestLoadPolicy?: {
        default: {
          maxTimeToFirstByteMs: number;
          maxLoadTimeMs: number;
        };
      };
    };
    levels: Array<{ height?: number; bitrate?: number; name?: string }>;
    audioTracks: Array<{ name?: string; lang?: string }>;
    currentLevel: number;
    audioTrack: number;
    subtitleTracks: Array<{ name: string; lang?: string }>;
    subtitleTrack: number;
    subtitleDisplay: boolean;
    off: ReturnType<typeof vi.fn>;
    emit: (event: string, data?: unknown) => void;
    loadSource: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
    recoverMediaError: ReturnType<typeof vi.fn>;
  }>,
  hlsIsSupported: vi.fn(() => true),
}));
const scrubBarMock = vi.hoisted(() => vi.fn((props: {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  onSeekPreview?: (time: number) => void;
  onScrubbingChange?: (scrubbing: boolean) => void;
}) => (
  <div
    data-testid="scrub-bar"
    data-current-time={props.currentTime}
    data-duration={props.duration}
    onPointerDown={() => props.onScrubbingChange?.(true)}
    onPointerUp={() => props.onScrubbingChange?.(false)}
  />
)));
const iconMock = vi.hoisted(() => vi.fn(({ name }: { name: string }) => <span data-icon={name} />));
const recordDiagnosticMock = vi.hoisted(() => vi.fn());
const { scrobbleStartMock, scrobblePauseMock, scrobbleStopMock } = vi.hoisted(() => ({
  scrobbleStartMock: vi.fn(),
  scrobblePauseMock: vi.fn(),
  scrobbleStopMock: vi.fn(),
}));
vi.mock("../lib/diagnostics", () => ({
  recordDiagnostic: (...args: unknown[]) => recordDiagnosticMock(...args),
}));
vi.mock("../data/traktScrobble", () => ({
  scrobblePlaybackStart: (...args: unknown[]) => scrobbleStartMock(...args),
  scrobblePlaybackPause: (...args: unknown[]) => scrobblePauseMock(...args),
  scrobblePlaybackStop: (...args: unknown[]) => scrobbleStopMock(...args),
}));
vi.mock("./CastControls", () => ({
  CastControls: ({ onLocalPlaybackChange, buttonClassName }: {
    onLocalPlaybackChange: (suspended: boolean) => void;
    buttonClassName: string;
  }) => (
    <>
      <button type="button" className={buttonClassName} aria-label="Cast to a device">
        <span>Cast</span>
      </button>
      <button type="button" onClick={() => onLocalPlaybackChange(true)}>
        test suspend playback
      </button>
      <button type="button" onClick={() => onLocalPlaybackChange(false)}>
        test resume playback
      </button>
    </>
  ),
}));
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported = hlsIsSupported;
    static Events = {
      ERROR: "hlsError",
      MANIFEST_PARSED: "manifestParsed",
      LEVEL_SWITCHED: "levelSwitched",
      AUDIO_TRACKS_UPDATED: "audioTracksUpdated",
      AUDIO_TRACK_SWITCHED: "audioTrackSwitched",
      SUBTITLE_TRACKS_UPDATED: "subtitleTracksUpdated",
      SUBTITLE_TRACK_SWITCH: "subtitleTrackSwitch",
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError" };
    static ErrorDetails = {
      MANIFEST_LOAD_ERROR: "manifestLoadError",
      MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
    };
    config: {
      startPosition?: number;
      xhrSetup?: (xhr: XMLHttpRequest, url?: string) => void;
      manifestLoadPolicy?: {
        default: {
          maxTimeToFirstByteMs: number;
          maxLoadTimeMs: number;
        };
      };
    };
    levels: Array<{ height?: number; bitrate?: number; name?: string }> = [];
    audioTracks: Array<{ name?: string; lang?: string }> = [];
    currentLevel = -1;
    audioTrack = 0;
    subtitleTracks: Array<{ name: string; lang?: string }> = [];
    private selectedSubtitle = -1;
    private displaySubtitles = true;
    private media: HTMLMediaElement | null = null;
    get subtitleTrack() { return this.selectedSubtitle; }
    set subtitleTrack(id: number) {
      this.selectedSubtitle = id;
      this.reflectSubtitleModes();
      this.emit("subtitleTrackSwitch", { id });
    }
    get subtitleDisplay() { return this.displaySubtitles; }
    set subtitleDisplay(display: boolean) {
      this.displaySubtitles = display;
      this.reflectSubtitleModes();
    }
    private reflectSubtitleModes() {
      const selected = this.subtitleTracks[this.selectedSubtitle];
      for (const track of Array.from(this.media?.textTracks ?? [])) {
        if (track.kind !== "subtitles") continue;
        const matches = selected != null && track.label === selected.name &&
          track.language === (selected.lang ?? "");
        track.mode = matches ? this.displaySubtitles ? "showing" : "hidden" : "disabled";
      }
    }
    private listeners = new Map<string, Set<(event: string, data: unknown) => void>>();
    emit = (event: string, data: unknown = {}) => {
      for (const listener of this.listeners.get(event) ?? []) listener(event, data);
    };
    loadSource = vi.fn();
    attachMedia = vi.fn((media: HTMLMediaElement) => {
      this.media = media;
      // Real media attachment runs the media load algorithm, which resets the
      // current speed to defaultPlaybackRate on affected Android WebViews.
      media.playbackRate = media.defaultPlaybackRate;
    });
    destroy = vi.fn();
    on = vi.fn((event: string, callback: (event: string, data: unknown) => void) => {
      const callbacks = this.listeners.get(event) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(event, callbacks);
    });
    off = vi.fn((event: string, callback: (event: string, data: unknown) => void) => {
      this.listeners.get(event)?.delete(callback);
    });
    startLoad = vi.fn();
    recoverMediaError = vi.fn();
    constructor(config: FakeHls["config"]) {
      this.config = config;
      hlsInstances.push(this);
    }
  }
  return { default: FakeHls };
});

// Tauri bridge - start in the browser (not under Tauri) by default; individual
// tests flip isTauri.
const isTauriMock = vi.fn(() => false);
const playWithMpvMock = vi.fn(async (_url: string, _authorization?: string) => ({
  embedded: false,
  status: "ok",
}));
const openInExternalPlayerMock = vi.fn(
  async (_url: string, _preferred?: string, _authorization?: string) =>
    "VLC hand-off",
);
const openAndroidExternalPlayerMock = vi.fn<
  (url: string, ownsRequest: () => boolean) => Promise<string | null>
>(
  async (_url: string, _ownsRequest: () => boolean) =>
    "Player chooser opened. Select a video app to continue.",
);
const openAndroidServerExternalPlayerMock = vi.fn<
  (
    url: string,
    ownsRequest: () => boolean,
    signal: AbortSignal,
    onHandoff: () => void,
  ) => Promise<string | null>
>(
  async (_url, _ownsRequest, _signal, onHandoff) => {
    onHandoff();
    return "External player opened.";
  },
);
const isAndroidExternalPlayerEligibleOverride = vi.fn<() => boolean | undefined>(
  () => undefined,
);
const mpvStopMock = vi.fn(async () => {});
vi.mock("../lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  isDesktopTauri: () => {
    const markers = window as unknown as Record<string, unknown>;
    return isTauriMock() &&
      markers.__YAWF_TAURI_MOBILE__ !== true &&
      !["android", "ios"].includes(deviceKindMock());
  },
  playWithMpv: (url: string, authorization?: string) =>
    playWithMpvMock(url, authorization),
  openInExternalPlayer: (
    url: string,
    preferred?: string,
    authorization?: string,
  ) => openInExternalPlayerMock(url, preferred, authorization),
  mpvStop: () => mpvStopMock(),
}));
vi.mock("../lib/androidExternalPlayer", async (orig) => {
  const actual = await orig<typeof import("../lib/androidExternalPlayer")>();
  return {
    ...actual,
    isAndroidExternalPlayerEligible: () =>
      isAndroidExternalPlayerEligibleOverride() ??
      actual.isAndroidExternalPlayerEligible(),
    openAndroidExternalPlayer: (url: string, ownsRequest: () => boolean) =>
      openAndroidExternalPlayerMock(url, ownsRequest),
    openAndroidServerExternalPlayer: (
      url: string,
      ownsRequest: () => boolean,
      signal: AbortSignal,
      onHandoff: () => void,
    ) => openAndroidServerExternalPlayerMock(url, ownsRequest, signal, onHandoff),
  };
});

// Platform - the in-window player is macOS-gated; report mac so the built-in
// player tests exercise it (external-handoff tests pass useBuiltInPlayer=false).
const deviceKindMock = vi.fn<() => string>(() => "mac");
vi.mock("../lib/platform", async (orig) => ({
  ...(await orig<typeof import("../lib/platform")>()),
  deviceKind: () => deviceKindMock(),
}));

// AppStore - VideoPlayer doesn't read it directly, but its captions menu does;
// stub it so nothing transitively touches a real store.
vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({ settings: { subtitleFontScale: 1, subtitleTextColor: "#ffffff", subtitleBgOpacity: 0.55 }, updateSettings: vi.fn() }),
}));

// Subtitle hook - return a controllable shape; default = no tracks.
const subsState: {
  tracks: Array<{
    id: string;
    label: string;
    language: string;
    vttUrl: string;
  }>;
  activeTrackId: string | null;
} = { tracks: [], activeTrackId: null };
vi.mock("./player/useSubtitleTracks", async () => {
  const { useReducer } = await import("react");
  return { useSubtitleTracks: () => {
    const [, render] = useReducer((value: number) => value + 1, 0);
    return ({
    tracks: subsState.tracks,
    activeTrackId: subsState.activeTrackId,
    setActiveTrack: (id: string | null) => { subsState.activeTrackId = id; render(); },
    results: [],
    searching: false,
    searchError: null,
    canSearch: false,
    search: vi.fn(),
    loadingFileId: null,
    loadResult: vi.fn(),
    setDelay: vi.fn(),
    canTranslate: false,
    translatingTrackId: null,
    translateProgress: null,
    translateTrack: vi.fn(),
    });
  } };
});

// Scrub thumbnails - no hidden capture video.
vi.mock("./player/useScrubThumbnails", () => ({
  useScrubThumbnails: () => ({
    preview: null,
    onHover: vi.fn(),
    onLeave: vi.fn(),
    available: false,
  }),
}));

// Child components we don't drive directly - render identifiable stubs.
const scrubBarMode = vi.hoisted(() => ({ actual: false }));
vi.mock("./player/ScrubBar", async (original) => {
  const actual = await original<typeof import("./player/ScrubBar")>();
  return {
    ScrubBar: (props: Parameters<typeof actual.ScrubBar>[0]) => scrubBarMode.actual
      ? <actual.ScrubBar {...props} />
      : scrubBarMock(props),
  };
});
const captionMenuMode = vi.hoisted(() => ({ actual: false }));
vi.mock("./player/CaptionsMenu", async (original) => {
  const actual = await original<typeof import("./player/CaptionsMenu")>();
  return {
    CaptionsMenu: (props: Parameters<typeof actual.CaptionsMenu>[0]) => captionMenuMode.actual
      ? <actual.CaptionsMenu {...props} />
      : <div data-testid="captions-menu"><button type="button" onClick={props.onClose}>close-captions</button></div>,
  };
});
vi.mock("./Icon", () => ({
  Icon: iconMock,
}));

// Built-in libmpv player - a native surface that can't render in jsdom, so stub
// it. These tests only assert WHICH path VideoPlayer chooses (embedded vs the
// external hand-off), not the player internals (covered by its own concerns).
const embeddedModeIntentObserver = vi.hoisted(() => ({
  enabled: false,
  props: [] as Array<{
    onSwitchServerOptimized?: (quality: ServerTranscodeQuality, position: number) => Promise<void>;
    onSwitchDeviceOriginal?: (position: number) => void;
    serverOptimizationPending?: boolean;
  }>,
}));
vi.mock("./EmbeddedPlayer", () => ({
  EmbeddedPlayer: (props: {
    title: string;
    url: string;
    engine: string;
    playbackAuthorization?: string;
    onPlaybackError?: (error: Error) => boolean | Promise<boolean>;
    onOpenExternalPlayer?: () => void | Promise<void>;
    externalActionStatus?: string | null;
    onSwitchServerOptimized?: (quality: ServerTranscodeQuality, position: number) => Promise<void>;
    onSwitchDeviceOriginal?: (position: number) => void;
    serverOptimizationPending?: boolean;
  }) => {
    if (embeddedModeIntentObserver.enabled) embeddedModeIntentObserver.props.push(props);
    return (
    <div
      data-testid="embedded-player"
      data-url={props.url}
      data-engine={props.engine}
      data-has-playback-authorization={String(props.playbackAuthorization != null)}
    >
      {props.title}
      <button
        type="button"
        onClick={() => void props.onPlaybackError?.(new Error("native failed"))}
      >
        simulate native failure
      </button>
      {props.onOpenExternalPlayer != null && (
        <button type="button" onClick={() => void props.onOpenExternalPlayer?.()}>
          open embedded external player
        </button>
      )}
      {props.externalActionStatus != null && (
        <span data-testid="embedded-external-status">{props.externalActionStatus}</span>
      )}
    </div>
    );
  },
}));

import { VideoPlayer } from "./VideoPlayer";
import {
  FRESH_STREAM_RESOLUTION_TIMEOUT_MS,
  POST_START_STALL_TIMEOUT_MS,
} from "../lib/playbackStall";

function replaceProperty<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  value: unknown,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  return () => {
    if (descriptor != null) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<PropertyKey, unknown>)[key];
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installRemoteServerPlayerProvider(): void {
  Object.defineProperty(window, "__YAWF_SERVER_PLAYER__", {
    configurable: true,
    value: {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

function fireMediaError(video: HTMLMediaElement, code = 3): void {
  Object.defineProperty(video, "error", {
    configurable: true,
    value: { code, message: "Test media failure" },
  });
  fireEvent.error(video);
}

// jsdom does not advance readyState when a synthetic media event is fired.
// Handoff tests set the minimum state only when they model current frame data.
function markCurrentMediaDataReady(video: HTMLMediaElement): void {
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_CURRENT_DATA,
  });
}

// jsdom's <video> has no play/pause/load/canPlayType implementations.
beforeEach(() => {
  vi.stubGlobal("location", new URL("tauri://localhost/"));
  // Initial server HLS owners now prepare their master before media attach.
  // Keep all HTTP synthetic; individual transport tests supply real fixture URIs.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n")));
  recordDiagnosticMock.mockClear();
  scrobbleStartMock.mockClear();
  scrobblePauseMock.mockClear();
  scrobbleStopMock.mockClear();
  globalThis.__DEBRIDSTREAMER_SERVER_URL__ = undefined;
  hlsInstances.length = 0;
  hlsIsSupported.mockReturnValue(true);
  isTauriMock.mockReturnValue(false);
  playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
  openInExternalPlayerMock.mockResolvedValue("VLC hand-off");
  openAndroidExternalPlayerMock.mockResolvedValue(
    "Player chooser opened. Select a video app to continue.",
  );
  openAndroidServerExternalPlayerMock.mockImplementation(
    async (_url, _ownsRequest, _signal, onHandoff) => {
      onHandoff();
      return "External player opened.";
    },
  );
  isAndroidExternalPlayerEligibleOverride.mockReturnValue(undefined);
  captionMenuMode.actual = false;
  scrubBarMode.actual = false;
  subsState.tracks = [];
  subsState.activeTrackId = null;
  scrubBarMock.mockClear();
  iconMock.mockClear();

  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ""),
  });
});

afterEach(() => {
  globalThis.__DEBRIDSTREAMER_SERVER_URL__ = undefined;
  delete window.YawfAndroidTV;
  delete (window as unknown as Record<string, unknown>).__YAWF_TAURI_MOBILE__;
  delete (window as unknown as Record<string, unknown>).__YAWF_TAURI_ANDROID__;
  delete (window as unknown as Record<string, unknown>).__YAWF_NATIVE_SAFE_AREA__;
  delete (window as unknown as Record<string, unknown>).__YAWF_SERVER_PLAYER__;
  delete (HTMLMediaElement.prototype as HTMLMediaElement & { audioTracks?: unknown }).audioTracks;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(false);
  deviceKindMock.mockReturnValue("mac");
  vi.useRealTimers();
});

// ---- Top-level shell + branch selection -----------------------------------

describe("VideoPlayer shell", () => {
  it("uses the shared touch player only for iOS browsers and marked Android app documents", () => {
    deviceKindMock.mockReturnValue("ios");
    const ios = render(
      <VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />,
    );
    expect(document.querySelector(".player")).toHaveClass("is-touch-player");
    expect(screen.getByRole("button", { name: "Back 10 seconds" })).toHaveTextContent("Back 10");
    expect(screen.getByRole("button", { name: "Forward 10 seconds" })).toHaveTextContent("Forward 10");
    expect(screen.getByRole("button", { name: "Video fit, Fit" })).toBeInTheDocument();
    expect(screen.getByText("Speed", { selector: ".player-touch-action-label" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Volume")).toBeNull();
    ios.unmount();

    deviceKindMock.mockReturnValue("mac");
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true,
      value: { getInsets: vi.fn() },
    });
    const androidApp = render(
      <VideoPlayer url="https://x/movie.mp4" title="Android app" onClose={() => {}} />,
    );
    expect(document.querySelector(".player")).toHaveClass("is-touch-player");
    androidApp.unmount();

    delete (window as unknown as Record<string, unknown>).__YAWF_NATIVE_SAFE_AREA__;
    deviceKindMock.mockReturnValue("android");
    render(<VideoPlayer url="https://x/movie.mp4" title="Browser" onClose={() => {}} />);
    expect(document.querySelector(".player")).not.toHaveClass("is-touch-player");
    expect(document.querySelector(".player-touch-controls")).toBeNull();
    expect(screen.getByLabelText("Volume")).toBeInTheDocument();
  });

  it("omits decorative pause artwork only from the shared touch webview", () => {
    deviceKindMock.mockReturnValue("ios");
    const touch = render(
      <VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />,
    );
    fireEvent.pause(document.querySelector("video.player-video")!);
    expect(document.querySelector(".player-pause-screen")).toBeNull();
    expect(document.querySelector(".player-title")).toHaveTextContent("Touch film");
    expect(screen.getByRole("button", { name: "Player details and shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    touch.unmount();

    deviceKindMock.mockReturnValue("mac");
    render(<VideoPlayer url="https://x/movie.mp4" title="Desktop film" onClose={() => {}} />);
    fireEvent.pause(document.querySelector("video.player-video")!);
    expect(document.querySelector(".player-pause-screen")).not.toBeNull();
  });

  it.each([
    ["ios", "Audio tracks", "Close audio tracks"],
    ["ios", "Playback settings", "Close playback settings"],
    ["ios", "Subtitles", "Close subtitles menu"],
    ["android", "Audio tracks", "Close audio tracks"],
    ["android", "Playback settings", "Close playback settings"],
    ["android", "Subtitles", "Close subtitles menu"],
  ] as const)("isolates %s touch %s menus without changing playback", async (device, menuName, closeName) => {
    deviceKindMock.mockReturnValue(device);
    if (device === "android") {
      Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
        configurable: true, value: { getInsets: vi.fn() },
      });
    }
    captionMenuMode.actual = true;
    const onClose = vi.fn();
    const view = render(<VideoPlayer url="https://x/movie.mp4" title="Touch modal" onClose={onClose}
      serverOptimized={{
        qualities: ["480p"],
        loadAudioTracks: vi.fn(async () => [
          { index: 0, label: "English", language: "eng", default: true },
          { index: 1, label: "Japanese", language: "jpn", default: false },
        ] satisfies ServerAudioTrack[]),
        request: vi.fn(),
      }} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video);
    expect(video.play).toHaveBeenCalledTimes(1);
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 42, writable: true },
      paused: { configurable: true, value: device === "android" },
    });
    const src = video.src;
    const playCalls = vi.mocked(video.play).mock.calls.length;
    const pauseCalls = vi.mocked(video.pause).mock.calls.length;
    const loadCalls = vi.mocked(video.load).mock.calls.length;
    const pane = screen.getByRole("dialog", { name: "Playing Touch modal" });
    const header = pane.querySelector(".player-bar")!;
    const controls = pane.querySelector(".player-touch-controls")!;
    const trigger = screen.getByRole("button", { name: menuName });
    const assertMediaUnchanged = () => {
      expect(document.querySelector("video.player-video")).toBe(video);
      expect(video.src).toBe(src);
      expect(video.currentTime).toBe(42);
      expect(video.paused).toBe(device === "android");
      expect(video.play).toHaveBeenCalledTimes(playCalls);
      expect(video.pause).toHaveBeenCalledTimes(pauseCalls);
      expect(video.load).toHaveBeenCalledTimes(loadCalls);
      expect(onClose).not.toHaveBeenCalled();
    };
    for (const dismiss of ["outside", "Escape", "Close"]) {
      await userEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: menuName });
      expect(pane).toHaveClass("has-touch-menu");
      expect(header).toHaveAttribute("inert");
      expect(header).toHaveAttribute("aria-hidden", "true");
      expect(controls).toHaveAttribute("inert");
      expect(controls).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("button", { name: "Close player" })).toBeNull();
      const scrim = screen.getByRole("button", { name: "Dismiss player menu" });
      expect(scrim).toHaveAttribute("tabindex", "-1");
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      await userEvent.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      fireEvent.pointerDown(scrim, { pointerType: "touch" });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      if (dismiss === "outside") await userEvent.click(scrim);
      else if (dismiss === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else await userEvent.click(within(dialog).getByRole("button", { name: closeName }));
      expect(screen.queryByRole("dialog", { name: menuName })).toBeNull();
      expect(pane).not.toHaveClass("has-touch-menu");
      expect(header).not.toHaveAttribute("inert");
      expect(controls).not.toHaveAttribute("inert");
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Dismiss player menu" })).toBeNull();
      assertMediaUnchanged();
    }
    view.unmount();
    delete (window as unknown as Record<string, unknown>).__YAWF_NATIVE_SAFE_AREA__;
    deviceKindMock.mockReturnValue("mac");
    render(<VideoPlayer url="https://x/desktop.mp4" title="Desktop modal" onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("dialog", { name: "Playback settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close player" })).toBeInTheDocument();
    expect(document.querySelector(".player-bar")).not.toHaveAttribute("inert");
    expect(document.querySelector(".player")).not.toHaveClass("has-touch-menu");
    expect(screen.queryByRole("button", { name: "Dismiss player menu" })).toBeNull();
  });

  it("layers touch menu isolation and bottom-left tablet sheets without changing desktop rules", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(/\.player-touch-menu-scrim\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*17;[^}]*background:\s*rgba\(0, 0, 0, 0\.6[0-9]\)/s);
    expect(css).toMatch(/\.player\.is-touch-player\.has-touch-menu > \.player-bar,[^{}]*\.webview-player\.is-touch-player\.has-touch-menu \.player-touch-controls\s*\{[^}]*visibility:\s*hidden;/s);
    expect(css).toMatch(/\.player\.is-touch-player \.player-options-menu,\s*\.player\.is-touch-player \.captions-menu\s*\{[^}]*z-index:\s*18;/s);
    expect(css.match(/\.player-touch-menu-scrim\s*\{[^}]*\}/s)?.[0]).not.toMatch(/(?:backdrop-)?filter:/);
    expect(css).toMatch(/\.player\.is-touch-player \.player-options-menu\.is-touch-audio-sheet\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*max\(calc\(12px \* var\(--density-scale\)\),\s*var\(--safe-area-bottom\)\)/s);
    expect(css).toMatch(/@media \(min-width: 768px\) and \(min-height: 501px\)\s*\{[^{}]*\.player\.is-touch-player \.player-options-menu:is\(\.is-touch-audio-sheet, \.is-touch-settings\),[^{}]*\.player\.is-touch-player \.captions-menu\s*\{[^}]*top:\s*auto;[^}]*right:\s*auto;[^}]*bottom:\s*max\([^}]*left:\s*max\([^}]*width:\s*min\(\s*440px/s);
    expect(css).not.toContain(":has(");
  });

  it("labels the touch fit category separately from its current value", async () => {
    deviceKindMock.mockReturnValue("ios");
    render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);

    const fit = screen.getByRole("button", { name: "Video fit, Fit" });
    expect(within(fit).getByText("Screen")).toHaveClass("player-touch-action-label");
    expect(within(fit).getByText("Fit")).toHaveClass("player-touch-action-value");
    await userEvent.click(fit);
    const fill = screen.getByRole("button", { name: "Video fit, Fill" });
    expect(within(fill).getByText("Screen")).toBeInTheDocument();
    expect(within(fill).getByText("Fill")).toHaveClass("player-touch-action-value");
  });

  it("routes touch transport, speed, fit, captions, settings, and next through existing handlers", async () => {
    deviceKindMock.mockReturnValue("ios");
    const onPlayNext = vi.fn();
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="Touch film"
        upNext={{ label: "S1 E2" }}
        onPlayNext={onPlayNext}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 50, writable: true },
      duration: { configurable: true, value: 100 },
      playbackRate: { configurable: true, value: 1, writable: true },
      defaultPlaybackRate: { configurable: true, value: 1, writable: true },
    });

    await userEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    expect(video.currentTime).toBe(40);
    await userEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(video.currentTime).toBe(50);

    await userEvent.selectOptions(screen.getByLabelText("Playback speed"), "1.5");
    expect(video.playbackRate).toBe(1.5);
    await userEvent.click(screen.getByRole("button", { name: "Video fit, Fit" }));
    expect(screen.getByRole("button", { name: "Video fit, Fill" })).toBeInTheDocument();
    expect(video).toHaveStyle({ objectFit: "cover" });

    await userEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    expect(screen.getByTestId("captions-menu")).toBeInTheDocument();
    await userEvent.click(screen.getByText("close-captions"));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("dialog", { name: "Playback settings" })).toHaveClass("is-touch-settings");
    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    await userEvent.click(screen.getByRole("button", { name: "Next episode" }));
    expect(onPlayNext).toHaveBeenCalledTimes(1);
  });

  it("opens a focused, scrollable touch audio sheet instead of the advanced settings flow", async () => {
    deviceKindMock.mockReturnValue("ios");
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, label: "English", language: "eng", default: true },
      { index: 1, label: "French", language: "fra", default: false },
    ] satisfies ServerAudioTrack[]);
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="Touch film"
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks,
          request: vi.fn(async () => ({
            url: "https://x/optimized.m3u8",
            timelineOffsetSeconds: 0,
            startPositionSeconds: 0,
            quality: "480p" as const,
          })),
        }}
        onClose={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Audio tracks" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Audio tracks" });
    expect(dialog).toHaveClass("is-touch-audio-sheet");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(loadAudioTracks).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close audio tracks" }));
    expect(trigger).toHaveFocus();
  });

  it("offers the existing Android chooser from the honest unavailable-audio sheet", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    Object.defineProperty(window, "__YAWF_TAURI_ANDROID__", {
      configurable: true,
      value: true,
    });
    openAndroidExternalPlayerMock
      .mockRejectedValueOnce(new Error("chooser unavailable"))
      .mockResolvedValueOnce("Player chooser opened. Select a video app to continue.");
    render(
      <VideoPlayer
        url="https://x/progressive.mp4"
        title="Android progressive"
        onClose={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Audio tracks" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Audio tracks" });
    expect(dialog).toHaveClass("is-touch-audio-sheet", "has-audio-fallback");
    expect(within(dialog).getByText(
      "This browser does not expose alternate audio tracks. If this source contains more than one, use an external player.",
    )).toBeInTheDocument();

    const chooser = within(dialog).getByRole("button", { name: /Open in external player/ });
    expect(chooser).toBeVisible();
    await userEvent.click(chooser);
    expect(await within(dialog).findByText(
      "The Android player chooser could not be opened. Copy the stream link or use the selectable link below.",
    )).toBeInTheDocument();
    await userEvent.click(chooser);
    expect(await within(dialog).findByText(
      "Player chooser opened. Select a video app to continue.",
    )).toBeInTheDocument();
    expect(openAndroidExternalPlayerMock).toHaveBeenCalledTimes(2);
    expect(openAndroidExternalPlayerMock.mock.calls[0]?.[0]).toBe("https://x/progressive.mp4");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close audio tracks" }));
    expect(screen.queryByRole("dialog", { name: "Audio tracks" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps an unavailable protected Android stream honest without a fake chooser", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    Object.defineProperty(window, "__YAWF_TAURI_ANDROID__", {
      configurable: true,
      value: true,
    });
    render(
      <VideoPlayer
        url="https://server.example/api/stream/protected"
        externalPlaybackUrl={null}
        title="Protected Android stream"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    const dialog = screen.getByRole("dialog", { name: "Audio tracks" });
    expect(within(dialog).getByText(
      "This browser does not expose alternate audio tracks. If this source contains more than one, use an external player.",
    )).toBeInTheDocument();
    expect(within(dialog).getByText(
      "External playback is not available for this protected stream. Retry playback or choose another source.",
    )).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /external player/i })).toBeNull();
    expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("keeps failed server audio inventory retry reachable in the focused touch sheet", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    Object.defineProperty(window, "__YAWF_TAURI_ANDROID__", {
      configurable: true,
      value: true,
    });
    const loadAudioTracks = vi.fn()
      .mockRejectedValueOnce(new Error("inventory unavailable"))
      .mockResolvedValueOnce([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        externalPlaybackUrl={null}
        title="Protected server audio"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    expect(await screen.findByText(
      "Audio track inventory is temporarily unavailable.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry audio tracks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /external player/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close audio tracks" }));

    const audio = screen.getByRole("button", { name: "Audio tracks" });
    expect(audio).toHaveFocus();
    await userEvent.click(audio);
    await userEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close audio tracks" }));
    expect(screen.getByRole("button", { name: "Audio track, English" })).toBeInTheDocument();
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
    expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("shows touch PiP and fullscreen only when their browser APIs are implemented", () => {
    deviceKindMock.mockReturnValue("ios");
    const first = render(
      <VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Picture in picture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter fullscreen" })).toBeNull();
    first.unmount();

    const restoreFullscreen = replaceProperty(
      HTMLElement.prototype,
      "requestFullscreen",
      vi.fn().mockResolvedValue(undefined),
    );
    const restorePipEnabled = replaceProperty(document, "pictureInPictureEnabled", true);
    const restoreRequestPip = replaceProperty(
      HTMLVideoElement.prototype,
      "requestPictureInPicture",
      vi.fn().mockResolvedValue(undefined),
    );
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      expect(screen.getByRole("button", { name: "Picture in picture" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeInTheDocument();
    } finally {
      restoreRequestPip();
      restorePipEnabled();
      restoreFullscreen();
    }
  });

  it("performs one side-zone double-tap seek without play or fullscreen side effects", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    const restoreRequestFullscreen = replaceProperty(
      HTMLElement.prototype,
      "requestFullscreen",
      vi.fn().mockResolvedValue(undefined),
    );
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 40, writable: true },
        duration: { configurable: true, value: 120 },
      });
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      const play = vi.mocked(video.play);
      const pause = vi.mocked(video.pause);
      play.mockClear();
      pause.mockClear();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      act(() => vi.advanceTimersByTime(120));
      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      act(() => vi.advanceTimersByTime(400));

      expect(video.currentTime).toBe(50);
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(HTMLElement.prototype.requestFullscreen).not.toHaveBeenCalled();
      expect(document.querySelector(".player-touch-seek-feedback")).toHaveTextContent("Forward 10 seconds");
    } finally {
      restoreRequestFullscreen();
      vi.useRealTimers();
    }
  });

  it("recognizes a late double tap across the complete declared window", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 40, writable: true },
        duration: { configurable: true, value: 120 },
      });
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      const play = vi.mocked(video.play);
      const pause = vi.mocked(video.pause);
      play.mockClear();
      pause.mockClear();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      act(() => vi.advanceTimersByTime(300));
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      act(() => vi.advanceTimersByTime(400));

      expect(video.currentTime).toBe(50);
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits one side-zone single tap only after the double-tap window expires", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      const play = vi.mocked(video.play);
      play.mockClear();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      act(() => vi.advanceTimersByTime(319));
      expect(play).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(play).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(400));
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending side-zone single tap when a player modal opens", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      const play = vi.mocked(video.play);
      play.mockClear();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 90 });
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("dialog", { name: "Playback settings" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(500));
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses current server request, audio, and timeline state for a same-key double tap", async () => {
    deviceKindMock.mockReturnValue("ios");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    const sourceInfo = deferred<{ durationSeconds: number | null; tracks?: ServerAudioTrack[] }>();
    const loadSourceInfo = vi.fn(() => sourceInfo.promise);
    const loadAudioTracks = vi.fn(async () => [] as ServerAudioTrack[]);
    const oldRequest = vi.fn(() => new Promise<never>(() => {}));
    const currentRequest = vi.fn(() => new Promise<never>(() => {}));
    const url = "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=100";
    const base = {
      url,
      engine: "webview-hls-transcode" as const,
      title: "Current seek owner",
      onClose: () => {},
    };
    const view = render(
      <VideoPlayer
        {...base}
        timelineOffsetSeconds={100}
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, loadAudioTracks, request: oldRequest }}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 5, writable: true },
      duration: { configurable: true, value: 12 },
      paused: { configurable: true, value: true },
    });
    video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    fireEvent.loadedMetadata(video);

    view.rerender(
      <VideoPlayer
        {...base}
        timelineOffsetSeconds={500}
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, loadAudioTracks, request: currentRequest }}
      />,
    );
    await act(async () => {
      sourceInfo.resolve({
        durationSeconds: 1_000,
        tracks: [
          { index: 0, label: "English", language: "eng", default: false },
          { index: 1, label: "French", language: "fra", default: true },
        ],
      });
      await sourceInfo.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Audio track, French" })).toBeInTheDocument());
    expect(document.querySelector("video.player-video")).toBe(video);

    fireEvent.pointerDown(video, { pointerType: "touch" });
    fireEvent.click(video, { clientX: 90 });
    fireEvent.pointerDown(video, { pointerType: "touch" });
    fireEvent.click(video, { clientX: 90 });

    await waitFor(() => expect(currentRequest).toHaveBeenCalledWith("480p", 515, 1));
    expect(oldRequest).not.toHaveBeenCalled();
  });

  it("pins touch chrome for the complete scrub gesture", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="Touch film" onClose={() => {}} />);
      fireEvent.canPlay(document.querySelector("video.player-video")!);
      const osd = document.querySelector(".player-osd") as HTMLElement;
      const scrubber = screen.getByTestId("scrub-bar");
      fireEvent.pointerDown(scrubber);
      act(() => vi.advanceTimersByTime(7_000));
      expect(osd).toHaveClass("is-visible");
      fireEvent.pointerUp(scrubber);
      act(() => vi.advanceTimersByTime(3_200));
      expect(osd).not.toHaveClass("is-visible");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never invokes desktop players for a stale native engine on Android", () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");

    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        engine="native-mpv"
        title="T"
        onClose={() => {}}
      />,
    );

    expect(document.querySelector("video.player-video")).not.toBeNull();
    expect(playWithMpvMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("hands native Android TV an HLS fallback URL and explicit MIME type", async () => {
    const play = vi.fn();
    const stop = vi.fn();
    const onProgress = vi.fn();
    const onClose = vi.fn();
    window.YawfAndroidTV = { play, stop };
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session/index.m3u8"
        externalPlaybackUrl="https://server.example/api/external-stream/capability"
        playbackAuthorization={`Bearer ${"A".repeat(43)}`}
        engine="webview-hls-transcode"
        title="TV film"
        subtitle="Director's cut"
        startPositionSeconds={42}
        onProgress={onProgress}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(JSON.parse(play.mock.calls[0]![0])).toEqual({
      url: "https://server.example/api/stream/session/index.m3u8",
      contentType: "application/x-mpegURL",
      title: "TV film",
      subtitle: "Director's cut",
      startPositionSeconds: 42,
      authorization: `Bearer ${"A".repeat(43)}`,
      audioLanguage: null,
      subtitleLanguage: null,
      subtitlesEnabled: false,
    });
    expect(
      screen.getByText("Playing in the native Android TV player."),
    ).toBeInTheDocument();
    expect(document.querySelector(".player-touch-controls")).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("yawf-android-tv-progress", {
          detail: { positionSeconds: 50, durationSeconds: 100 },
        }),
      );
    });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("yawf-android-tv-closed", {
          detail: { positionSeconds: 55, durationSeconds: 100 },
        }),
      );
    });
    expect(onProgress).toHaveBeenLastCalledWith(55, 100);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the external capability for a direct Android TV source", async () => {
    const play = vi.fn();
    const stop = vi.fn();
    window.YawfAndroidTV = { play, stop };

    render(
      <VideoPlayer
        url="https://server.example/api/stream/session"
        externalPlaybackUrl="https://server.example/api/external-stream/capability"
        playbackAuthorization={`Bearer ${"A".repeat(43)}`}
        sourceFileName="Film.mkv"
        engine="webview-direct"
        title="TV film"
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(JSON.parse(play.mock.calls[0]![0])).toMatchObject({
      url: "https://server.example/api/external-stream/capability",
      contentType: "video/x-matroska",
    });
  });

  it("renders the title and a close button", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="My Movie" onClose={() => {}} />,
    );
    expect(screen.getByText("My Movie")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close player" }),
    ).toBeInTheDocument();
  });

  it("keeps media metadata in the fallback title bar and exposes the raw file only in info", async () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="Obsession (2026)"
        subtitle="S2 E5 - The Arrival"
        sourceFileName="Obsession.2026.2160p.WEB-DL.H265.MP4"
        onClose={() => {}}
      />,
    );
    expect(document.querySelector(".player-title")).toHaveTextContent("Obsession (2026)");
    expect(document.querySelector(".player-subtitle")).toHaveTextContent(
      "S2 E5 - The Arrival",
    );
    expect(document.querySelector(".player-title-group")).not.toHaveTextContent(
      "2160p",
    );

    await userEvent.click(screen.getByRole("button", { name: "Player details and shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Player details and shortcuts" })).toHaveTextContent(
      "Obsession.2026.2160p.WEB-DL.H265.MP4",
    );
  });

  it("invokes onClose from the close button", async () => {
    const onClose = vi.fn();
    render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={onClose} />,
    );
    const backdrop = document.querySelector(".player-backdrop") as HTMLElement;
    await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close when the inner panel is clicked (stopPropagation)", async () => {
    const onClose = vi.fn();
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={onClose} />,
    );
    const panel = document.querySelector(".player") as HTMLElement;
    await userEvent.click(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("portals out of the nav-inset, filtered Detail containing block", () => {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.style.cssText =
      "position:fixed;inset:0 0 0 78px;backdrop-filter:blur(28px);";
    document.body.appendChild(detail);
    const { unmount } = render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
      { container: detail },
    );

    const backdrop = document.querySelector<HTMLElement>(".player-backdrop");
    expect(backdrop?.parentElement).toBe(document.body);
    expect(detail).not.toContainElement(backdrop);

    unmount();
    detail.remove();
  });

  it("classifies an .mp4 URL as the in-webview path", () => {
    render(
      <VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />,
    );
    expect(document.querySelector("video.player-video")).not.toBeNull();
    expect(document.querySelector(".player-external")).toBeNull();
  });

  it("classifies an .mkv URL as the external path", () => {
    render(
      <VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />,
    );
    expect(document.querySelector("video.player-video")).toBeNull();
    expect(document.querySelector(".player-external")).not.toBeNull();
  });

  it("honours an explicit kind override over the URL extension", () => {
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        kind="external"
        title="T"
        onClose={() => {}}
      />,
    );
    // mp4 would normally be webview, but kind forces external.
    expect(document.querySelector(".player-external")).not.toBeNull();
  });

  it("treats an extensionless URL as the webview path", () => {
    render(
      <VideoPlayer url="https://debrid/direct/abc123" title="T" onClose={() => {}} />,
    );
    expect(document.querySelector("video.player-video")).not.toBeNull();
  });

  it("keeps the webview stage and video on the full window with aspect-safe contain", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(/\.player-backdrop\s*\{[^}]*inset:\s*0;[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.player\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
    expect(css).toMatch(/\.player-stage\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    expect(css).toMatch(
      /\.player-video\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*aspect-ratio:\s*auto;[^}]*object-fit:\s*contain;/s,
    );
  });

  it("keeps settings scrollable by touch in mobile and short landscape viewports", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(
      /\.player-options-menu\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*-webkit-overflow-scrolling:\s*touch;[^}]*touch-action:\s*pan-y;/s,
    );
    expect(css).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)[\s\S]*?\.player-options-menu,[\s\S]*?bottom:[^;]+;[\s\S]*?overflow-y:\s*auto;/,
    );
    expect(css).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.scrubbar\s*\{[^}]*min-height:\s*44px;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 560px\)\s*\{(?:(?!@media)[\s\S])*?\.scrubbar\s*\{[^}]*min-height:\s*44px;/,
    );
    expect(css).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)\s*\{(?:(?!@media)[\s\S])*?\.scrubbar\s*\{[^}]*min-height:\s*44px;/,
    );
  });

  it("fits touch caption search into two shrinkable rows without changing desktop layout", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    const row = css.match(/\.player\.is-touch-player \.captions-search-row\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(row).toMatch(/display:\s*grid;/);
    expect(row).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/);
    expect(row).toMatch(/width:\s*100%;/);
    expect(row).toMatch(/min-width:\s*0;/);
    expect(css).toMatch(/\.player\.is-touch-player \.captions-search-row > input\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
    const controls = css.match(/\.player\.is-touch-player \.captions-search-row > input,\s*\.player\.is-touch-player \.captions-search-row > select,\s*\.player\.is-touch-player \.captions-search-row > button\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const declaration of ["box-sizing: border-box;", "width: 100%;", "min-width: 0;", "max-width: 100%;", "min-height: 44px;"]) {
      expect(controls.split("\n").map((line) => line.trim())).toContain(declaration);
    }
    expect(css.match(/\n\.captions-search-row\s*\{([^}]*)\}/)?.[1]).toMatch(/display:\s*flex;/);
  });

  it("keeps only the focused touch Audio sheet content-height and safe-area bounded", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(
      /\.player\.is-touch-player \.player-options-menu\.is-touch-audio-sheet\s*\{[^}]*top:\s*auto;[^}]*bottom:\s*max\(calc\(12px \* var\(--density-scale\)\),\s*var\(--safe-area-bottom\)\);[^}]*height:\s*auto;[^}]*max-height:\s*calc\([^}]*100%[^}]*var\(--safe-area-top\)[^}]*var\(--safe-area-bottom\)[^}]*\);[^}]*overflow-y:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.player\.is-touch-player \.player-options-menu,\s*\.player\.is-touch-player \.captions-menu\s*\{[^}]*bottom:\s*max\(calc\(12px \* var\(--density-scale\)\),\s*var\(--safe-area-bottom\)\);[^}]*max-height:\s*none;/s,
    );
  });

  it("keeps the labelled Audio shortcut compact below tablet width", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(
      /\.player-audio-shortcut\s*\{[^}]*min-height:\s*34px;[^}]*padding-inline:/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 767px\)\s*\{[\s\S]*?\.player-audio-shortcut-label\s*\{[^}]*display:\s*none;/,
    );
    expect(css).toMatch(
      /@media \(pointer: coarse\)\s*\{[\s\S]*?\.player-osd \.chip,[\s\S]*?min-height:\s*44px;/,
    );
  });

  it("gives the absolute-only scrub track a shrink-safe flexible width", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(/\.scrubbar\s*\{[^}]*display:\s*flex;/s);
    expect(css).toMatch(
      /\.scrubbar-track\s*\{[^}]*flex:\s*1\s+1\s+0%;[^}]*min-width:\s*0;/s,
    );
    expect(css).toMatch(/\.scrubbar-fill\s*\{[^}]*position:\s*absolute;/s);
    expect(css).toMatch(/\.scrubbar-hover\s*\{[^}]*position:\s*absolute;/s);
  });

  it("reserves fine and coarse webview OSDs with webview-only compact hiding rules", () => {
    const playerCss = readFileSync("src/components/VideoPlayer.css", "utf8");
    const pauseCss = readFileSync(
      "src/components/player/PlayerPauseOverlay.css",
      "utf8",
    );
    const tallCoarseMedia =
      "@media (pointer: coarse) and (min-width: 561px) and (min-height: 501px)";

    expect(playerCss).toMatch(
      /\.webview-player\s*\{[^}]*--player-compact-osd-reserve:\s*calc\([^}]*\+ 24px[^}]*\+ var\(--sp-xs\)[^}]*\+ 38px[^}]*var\(--safe-area-bottom\)/,
    );
    expect(playerCss).toContain(tallCoarseMedia);
    expect(playerCss).toMatch(
      /@media \(pointer: coarse\) and \(min-width: 561px\) and \(min-height: 501px\)\s*\{[\s\S]*?\.webview-player\s*\{[^}]*--player-compact-osd-reserve:\s*calc\([^}]*\+ 44px[^}]*\+ var\(--sp-xs\)[^}]*\+ 44px[^}]*var\(--safe-area-bottom\)/,
    );
    expect(playerCss).toMatch(
      /@media \(max-width: 560px\)\s*\{[\s\S]*?\.webview-player\s*\{[^}]*--player-compact-osd-reserve:\s*calc\([^}]*\+ 44px[^}]*\+ var\(--sp-xs\)[^}]*\+ 92px[^}]*var\(--safe-area-bottom\)/,
    );
    expect(playerCss).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)\s*\{[\s\S]*?\.webview-player\s*\{[^}]*--player-compact-osd-reserve:\s*calc\([^}]*\+ 44px[^}]*\+ var\(--sp-xs\)[^}]*\+ 44px[^}]*var\(--safe-area-bottom\)/,
    );
    expect(pauseCss).toMatch(
      /\.webview-player \.player-pause-content\s*\{[^}]*max-height:\s*calc\(\s*100vh[^}]*var\(--player-compact-osd-reserve\)[^}]*max-height:\s*calc\(\s*100dvh[^}]*var\(--player-compact-osd-reserve\)[^}]*margin-bottom:\s*calc\([^}]*var\(--player-compact-osd-reserve\)[^}]*overflow:\s*hidden;/,
    );
    expect(pauseCss).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)\s*\{[\s\S]*?\.webview-player \.player-pause-content\s*\{[^}]*max-height:\s*calc\(\s*100vh[^}]*var\(--player-compact-osd-reserve\)[^}]*max-height:\s*calc\(\s*100dvh/,
    );
    expect(pauseCss).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)\s*\{[\s\S]*?\.webview-player \.player-pause-content h2\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    );
    expect(pauseCss).toMatch(
      /@media \(min-width: 561px\) and \(max-width: 950px\) and \(max-height: 500px\)\s*\{[\s\S]*?\.webview-player \.player-pause-meta,\s*\.webview-player \.player-pause-overview\s*\{[^}]*display:\s*none;/,
    );
  });

  it("shows explicit engine, source, and display dimensions in the info popover", async () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        engine="webview-direct"
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
      currentTime: { configurable: true, value: 10 },
      buffered: {
        configurable: true,
        value: {
          length: 1,
          start: () => 0,
          end: () => 25,
        },
      },
      getVideoPlaybackQuality: {
        configurable: true,
        value: () => ({
          creationTime: 0,
          totalVideoFrames: 240,
          droppedVideoFrames: 2,
          corruptedVideoFrames: 0,
        }),
      },
    });
    fireEvent(video, new Event("loadedmetadata"));

    await userEvent.click(
      screen.getByRole("button", { name: "Player details and shortcuts" }),
    );
    const info = screen.getByRole("dialog", { name: "Player details and shortcuts" });
    expect(info).toHaveTextContent("Webview direct");
    expect(info).toHaveTextContent("1920 × 1080 px");
    expect(info).toHaveTextContent("Buffer health");
    expect(info).toHaveTextContent("15.0 s");
    expect(info).toHaveTextContent("Dropped frames");
    expect(info).toHaveTextContent("2");
    expect(info).toHaveTextContent(
      `${Math.round(window.innerWidth * window.devicePixelRatio)} × ${Math.round(window.innerHeight * window.devicePixelRatio)} px`,
    );
  });
});

// ---- Webview player: video element + OSD -----------------------------------

describe("WebviewPlayer", () => {
  it("renders one custom control surface without duplicate native controls", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute("controls");
    expect(screen.getByTestId("scrub-bar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1");
    // CC button lives in the OSD row.
    expect(screen.getByRole("button", { name: "Subtitles" })).toBeInTheDocument();
  });

  it("retries autoplay when the resolved media becomes playable", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    fireEvent.canPlay(video);
    fireEvent.canPlay(video);

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("restores and changes playback speed in the web player", async () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        savedPrefs={{ playbackSpeed: 1.25 }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const speed = screen.getByRole("combobox", { name: "Playback speed" });
    expect(video.defaultPlaybackRate).toBe(1.25);
    expect(video.playbackRate).toBe(1.25);
    expect(speed).toHaveValue("1.25");

    await userEvent.selectOptions(speed, "1.5");

    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);
    expect(speed).toHaveValue("1.5");
  });

  it("preserves a handoff speed when hls.js attachment resets the current media rate", async () => {
    render(
      <VideoPlayer
        url="https://x/stream/index.m3u8"
        engine="webview-hls-transcode"
        title="T"
        initialHandoffState={{
          paused: false,
          volume: 1,
          muted: false,
          playbackRate: 1.5,
        }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    await waitFor(() => expect(hlsInstances[0]?.attachMedia).toHaveBeenCalledWith(video));

    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(video.playbackRate).toBe(1.5);
  });

  it("converts Settings volume percent and applies the configured web playback speed", () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        playerPreferences={{ defaultVolume: 35, defaultPlaybackSpeed: 1.25 }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.volume).toBeCloseTo(0.35);
    expect(screen.getByRole("slider", { name: "Volume" })).toHaveValue("0.35");
    expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1.25");
  });

  it("changes browser playback volume from the custom control", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
      target: { value: "0.35" },
    });

    expect(video.volume).toBeCloseTo(0.35);
  });

  it("reflects programmatic volume and mute changes without losing the actual slider value", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const slider = screen.getByRole("slider", { name: "Volume" });

    video.volume = 0.35;
    video.muted = true;
    fireEvent.volumeChange(video);
    expect(slider).toHaveValue("0.35");
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    video.volume = 0;
    video.muted = false;
    fireEvent.volumeChange(video);
    expect(slider).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.35);
  });

  it("keeps recovery inside the player without leaking a provider URL", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    fireMediaError(video);

    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /external player/ })).toBeNull();
    expect(screen.getByText(/External playback is not available/)).toBeInTheDocument();
  });

  it("ignores an error event without a MediaError and accepts later playback readiness", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.error ?? null).toBeNull();

    fireEvent.error(video);
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(screen.queryByText("Playback interrupted")).toBeNull();

    fireEvent.canPlay(video);
    video.currentTime = 1;
    fireEvent.timeUpdate(video);
    expect(screen.queryByText("Starting playback…")).toBeNull();
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("automatically switches a failed direct source to its browser-compatible HLS fallback", async () => {
    const requestWebviewFallback = vi.fn().mockResolvedValue("https://x/stream/index.m3u8");
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        requestWebviewFallback={requestWebviewFallback}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    fireMediaError(video);

    await waitFor(() => expect(requestWebviewFallback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith("https://x/stream/index.m3u8");
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("keeps the owned fallback alive when another media error arrives while it is pending", async () => {
    const pending = deferred<string | null>();
    const requestWebviewFallback = vi.fn(() => pending.promise);
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        requestWebviewFallback={requestWebviewFallback}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireMediaError(video);
    await waitFor(() => expect(requestWebviewFallback).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".player-compatibility-status")).not.toBeNull();

    fireMediaError(video);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    expect(requestWebviewFallback).toHaveBeenCalledTimes(1);

    pending.resolve("https://x/recovered.m3u8");
    await waitFor(() => expect(hlsInstances.some(
      (instance) => instance.loadSource.mock.calls.some(([value]) => value === "https://x/recovered.m3u8"),
    )).toBe(true));
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it.each([
    [true, "seek"], [false, "seek"], [true, "live clock"], [false, "live clock"],
    [true, "reset clock"], [false, "reset clock"],
    [true, "confirmed seek reset"], [false, "confirmed seek reset"],
  ] as const)("retains paused=%s and %s position through direct media-error fallback", async (wasPaused, positionOrigin) => {
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true, value: { getInsets: vi.fn() },
    });
    const pending = deferred<string | null>();
    const loadStream = vi.fn(() => pending.promise);
    render(<VideoPlayer url="https://x/seek-error.mp4" title="Seek recovery"
      engine="webview-direct" requestWebviewFallback={loadStream} onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    let originalTime = 11;
    let originalPaused = wasPaused;
    Object.defineProperties(original, {
      currentTime: { configurable: true, get: () => originalTime, set: (value: number) => {
        originalTime = positionOrigin === "seek" ? 0 : value;
      } },
      duration: { configurable: true, get: () => 180 },
      readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, get: () => originalPaused },
    });
    original.volume = 0.4;
    original.muted = true;
    original.playbackRate = 1.5;
    fireEvent.loadedMetadata(original);
    fireEvent.timeUpdate(original);
    if (wasPaused) fireEvent.pause(original);
    else fireEvent.play(original);
    // The decoder can lose its current clock as the seek fails. The owned
    // requested point is stronger evidence than that reset media clock.
    if (positionOrigin === "seek" || positionOrigin === "confirmed seek reset") {
      act(() => { scrubBarMock.mock.lastCall![0].onSeek(73.1); });
      fireEvent.seeking(original);
      if (positionOrigin === "confirmed seek reset") fireEvent.seeked(original);
    } else {
      // No timeupdate has reported this live clock to the parent yet.
      originalTime = 73.1;
    }
    if (positionOrigin === "reset clock" || positionOrigin === "confirmed seek reset") {
      fireEvent.timeUpdate(original);
      originalTime = 0;
      originalPaused = true;
      Object.defineProperty(original, "error", { configurable: true, value: { code: 3 } });
      fireEvent.pause(original);
      fireEvent.timeUpdate(original);
    }
    fireMediaError(original);
    await waitFor(() => expect(loadStream).toHaveBeenCalledTimes(1));
    expect(document.querySelector("video.player-video")).toBe(original);
    await act(async () => { pending.resolve("https://x/seek-recovery/index.m3u8"); });
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(recovered).not.toBe(original);
    expect(hlsInstances[0].config.startPosition).toBe(73.1);
    expect(recovered.autoplay).toBe(false);
    expect(recovered.volume).toBe(0.4);
    expect(recovered.muted).toBe(true);
    expect(recovered.playbackRate).toBe(1.5);
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    let localTime = 0;
    let duration = 18;
    let readyState: number = HTMLMediaElement.HAVE_METADATA;
    let seeking = false;
    let paused = true;
    const writes = vi.fn((value: number) => { localTime = value; seeking = true; });
    Object.defineProperties(recovered, {
      currentTime: { configurable: true, get: () => localTime, set: writes },
      duration: { configurable: true, get: () => duration },
      readyState: { configurable: true, get: () => readyState },
      seeking: { configurable: true, get: () => seeking },
      paused: { configurable: true, get: () => paused },
    });
    play.mockImplementation(function (this: HTMLMediaElement) {
      expect(this).toBe(recovered);
      expect(localTime).toBe(73.1);
      paused = false;
      fireEvent.play(this);
      fireEvent.playing(this);
      return Promise.resolve();
    });
    fireEvent.loadedMetadata(recovered);
    fireEvent.canPlay(recovered);
    expect(play).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    duration = 180;
    fireEvent.durationChange(recovered);
    expect(writes).toHaveBeenLastCalledWith(73.1);
    expect(play).not.toHaveBeenCalled();
    readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    seeking = false;
    fireEvent.seeked(recovered);
    expect(play).toHaveBeenCalledTimes(wasPaused ? 0 : 1);
    expect(recovered.currentTime).toBe(73.1);
    expect(recovered.paused).toBe(wasPaused);
    expect(screen.queryByText("Synchronizing playback…")).toBeNull();
  });

  it("retains transient audio through direct media-error fallback without enabling per-title persistence", async () => {
    const tracks = Object.assign(new EventTarget(), {
      0: { id: "en", label: "English", language: "eng", enabled: true },
      1: { id: "jp", label: "Japanese", language: "jpn", enabled: false },
      length: 2,
      item(index: number) { return this[index as 0 | 1] ?? null; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true, get: () => tracks,
    });
    const preferences = { defaultAudioLanguage: "eng", rememberPerTitleTrackChoices: false };
    render(<VideoPlayer url="https://x/audio-error.mp4" title="Audio recovery"
      playerPreferences={preferences} requestWebviewFallback={async () => "https://x/audio-recovery.m3u8"}
      onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(original, "paused", { configurable: true, value: true });
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Japanese" }));
    expect(tracks[1].enabled).toBe(true);
    fireMediaError(original);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    act(() => {
      hlsInstances[0].audioTracks = [{ name: "English", lang: "eng" }, { name: "Japanese", lang: "jpn" }];
      hlsInstances[0].emit("audioTracksUpdated");
    });
    expect(hlsInstances[0].audioTrack).toBe(1);
    expect(preferences).toEqual({ defaultAudioLanguage: "eng", rememberPerTitleTrackChoices: false });
  });

  it.each([true, false])("retains explicit zero and updated paused=%s intent during deferred media-error fallback", async (finalPaused) => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const restore = replaceProperty(navigator, "mediaSession", {
      metadata: null, playbackState: "none", setPositionState: vi.fn(),
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => handlers.set(action, handler),
    });
    try {
      const pending = deferred<string | null>();
      const loadStream = vi.fn(() => pending.promise);
      render(<VideoPlayer url="https://x/zero-error.mp4" title="Zero recovery"
        requestWebviewFallback={loadStream} onClose={() => {}} />);
      const original = document.querySelector("video.player-video") as HTMLVideoElement;
      let position = 73.1;
      let paused = !finalPaused;
      Object.defineProperties(original, {
        currentTime: { configurable: true, get: () => position, set: (value: number) => { position = value; } },
        duration: { configurable: true, value: 180 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        paused: { configurable: true, get: () => paused },
      });
      fireEvent.loadedMetadata(original);
      fireEvent.timeUpdate(original);
      if (paused) fireEvent.pause(original); else fireEvent.play(original);
      act(() => { scrubBarMock.mock.lastCall![0].onSeek(0); });
      fireEvent.seeking(original);
      fireEvent.seeked(original);
      Object.defineProperty(original, "error", { configurable: true, value: { code: 3 } });
      paused = true;
      fireEvent.pause(original);
      fireEvent.error(original);
      await waitFor(() => expect(loadStream).toHaveBeenCalledTimes(1));
      const action = finalPaused ? "pause" : "play";
      act(() => { handlers.get(action)?.({ action }); });
      await act(async () => { pending.resolve("https://x/zero-recovery.m3u8"); });
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      expect(hlsInstances[0].config.startPosition).toBe(0);
      const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(recovered.autoplay).toBe(false);
      expect(recovered.currentTime).toBe(0);
      Object.defineProperties(recovered, {
        duration: { configurable: true, value: 180 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(recovered);
      expect(play).toHaveBeenCalledTimes(finalPaused ? 0 : 1);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
    } finally { restore(); }
  });

  it.each([
    [true, null], [false, null], [true, "play"], [false, "pause"],
  ] as const)("recovers the hour-offset source paused=%s with late %s intent", async (initialPaused, lateAction) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true, value: { getInsets: vi.fn() },
    });
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const restore = replaceProperty(navigator, "mediaSession", {
      metadata: null, playbackState: "none", setPositionState: vi.fn(),
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => handlers.set(action, handler),
    });
    try {
      const pending = deferred<{
        url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: "480p";
      }>();
      const request = vi.fn(() => pending.promise);
      const legacy = vi.fn(async () => "https://server.example/api/stream/from-zero/index.m3u8");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment0.ts\n")));
      render(<VideoPlayer url="https://server.example/api/stream/original" title="Hour recovery"
        engine="webview-direct" serverOptimized={{ qualities: ["480p"], request }}
        requestWebviewFallback={legacy} onClose={() => {}} />);
      const original = document.querySelector("video.player-video") as HTMLVideoElement;
      let position = 3600;
      let paused = initialPaused;
      Object.defineProperties(original, {
        currentTime: { configurable: true, get: () => position },
        duration: { configurable: true, value: 7200 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        paused: { configurable: true, get: () => paused },
      });
      original.playbackRate = 1.25;
      fireEvent.loadedMetadata(original);
      fireEvent.timeUpdate(original);
      if (paused) fireEvent.pause(original); else fireEvent.play(original);
      position = 0;
      paused = true;
      Object.defineProperty(original, "error", { configurable: true, value: { code: 3 } });
      fireEvent.pause(original);
      fireEvent.error(original);
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 3600));
      if (lateAction != null) act(() => { handlers.get(lateAction)?.({ action: lateAction }); });
      await act(async () => { pending.resolve({
        url: "https://server.example/api/stream/offset/index.m3u8",
        timelineOffsetSeconds: 3600, startPositionSeconds: 0, quality: "480p",
      }); });
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      expect(legacy).not.toHaveBeenCalled();
      expect(hlsInstances[0].config.startPosition).toBe(0);
      const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(recovered.autoplay).toBe(false);
      expect(recovered.playbackRate).toBe(1.25);
      Object.defineProperties(recovered, {
        duration: { configurable: true, value: 18 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(recovered);
      const finalPaused = lateAction == null ? initialPaused : lateAction === "pause";
      expect(play).toHaveBeenCalledTimes(finalPaused ? 0 : 1);
      fireEvent.timeUpdate(recovered);
      expect(scrubBarMock.mock.lastCall![0].currentTime).toBe(3600);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
    } finally { restore(); }
  });

  it.each([true, false])("preserves offset recovery audio only with known inventory=%s", async (knownInventory) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const tracks = Object.assign(new EventTarget(), {
      0: { id: "en", label: "English", language: "eng", enabled: false },
      1: { id: "jp", label: "Japanese", language: "jpn", enabled: true },
      length: 2,
      item(index: number) { return this[index as 0 | 1] ?? null; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true, get: () => tracks,
    });
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/audio-offset/index.m3u8",
      timelineOffsetSeconds: 3600, startPositionSeconds: 0, quality: "480p" as const, audioTrack: 1,
    }));
    const legacy = vi.fn();
    const loadSourceInfo = vi.fn(async () => ({ durationSeconds: 7200, tracks: [
      { index: 0, codec: "aac", language: "eng", label: "English", default: false, channels: 2 },
      { index: 1, codec: "aac", language: "jpn", label: "Japanese", default: true, channels: 2 },
    ] }));
    render(<VideoPlayer url="https://server.example/api/stream/audio-original" title="Mapped audio"
      serverOptimized={{ qualities: ["480p"], request, loadSourceInfo: knownInventory ? loadSourceInfo : undefined }}
      requestWebviewFallback={legacy} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(original, {
      currentTime: { configurable: true, value: 3600, writable: true },
      duration: { configurable: true, value: 7200 },
    });
    fireEvent.timeUpdate(original);
    fireMediaError(original);
    if (knownInventory) {
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 3600, 1));
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
    } else {
      await waitFor(() => expect(screen.getByText(/could not preserve the selected audio track/)).toBeInTheDocument());
      expect(request).not.toHaveBeenCalled();
    }
    expect(legacy).not.toHaveBeenCalled();
  });

  it("does not fall back to a from-zero transcode after offset recovery fails", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => { throw new Error("Preparation unavailable"); });
    const legacy = vi.fn(async () => "https://server.example/api/stream/slow/index.m3u8");
    render(<VideoPlayer url="https://server.example/api/stream/failed-original" title="Failed offset"
      serverOptimized={{ qualities: ["480p"], request }} requestWebviewFallback={legacy} onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(original, "currentTime", { configurable: true, value: 3600 });
    fireMediaError(original);
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 3600));
    await waitFor(() => expect(screen.getByText("Playback interrupted")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
    expect(document.querySelector(".player-compatibility-status")).toBeNull();
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each(["automatic default", "explicit quality", "explicit failure"])("keeps error recovery owned while %s preparation is pending", async (kind) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const pending = deferred<{ url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: ServerTranscodeQuality }>();
    let requestCount = 0;
    const request = vi.fn((quality: ServerTranscodeQuality, position: number) => ++requestCount === 1
      ? pending.promise : Promise.resolve({ url: "https://server.example/api/stream/recovery-fixed/index.m3u8",
        timelineOffsetSeconds: position, startPositionSeconds: 0, quality }));
    const legacy = vi.fn();
    render(<VideoPlayer url="https://server.example/api/stream/pending-original" title="Pending recovery"
      serverOptimized={{ qualities: ["480p", "360p"], defaultQuality: kind === "automatic default" ? "480p" : null, request }}
      requestWebviewFallback={legacy} onClose={() => {}} />);
    if (kind === "automatic default") await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0));
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    let position = 3600;
    let paused = false;
    Object.defineProperties(original, {
      currentTime: { configurable: true, get: () => position },
      duration: { configurable: true, value: 7200 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, get: () => paused },
    });
    fireEvent.loadedMetadata(original); fireEvent.timeUpdate(original); fireEvent.play(original);
    if (kind !== "automatic default") {
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "360p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("360p", 3600));
    }
    position = 0; paused = true;
    Object.defineProperty(original, "error", { configurable: true, value: { code: 3 } });
    fireEvent.pause(original); fireEvent.error(original);
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    if (kind === "automatic default") {
      await waitFor(() => expect(request).toHaveBeenLastCalledWith("480p", 3600));
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
    } else expect(request).toHaveBeenCalledTimes(1);
    if (kind === "explicit failure") {
      await act(async () => { pending.reject(new Error("Chosen quality could not be prepared")); });
      await waitFor(() => expect(screen.getByText("Playback interrupted")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
      return;
    }
    await act(async () => { pending.resolve({
      url: `https://server.example/api/stream/${kind === "automatic default" ? "stale-warmup" : "chosen-quality"}/index.m3u8`,
      timelineOffsetSeconds: kind === "automatic default" ? 0 : 3600,
      startPositionSeconds: 0, quality: kind === "automatic default" ? "480p" : "360p",
    }); });
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(kind === "automatic default"
      ? "https://server.example/api/stream/recovery-fixed/index.m3u8"
      : "https://server.example/api/stream/chosen-quality/index.m3u8");
    expect(hlsInstances[0].config.startPosition).toBe(0);
    const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(recovered, {
      duration: { configurable: true, value: 18 }, readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });
    const play = vi.mocked(HTMLMediaElement.prototype.play); play.mockClear();
    fireEvent.loadedMetadata(recovered);
    expect(play).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each(["metadata mismatch", "header mismatch", "unconfirmed"])("rejects %s audio during offset recovery before mounting default audio", async (caseName) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", {
      headers: caseName === "header mismatch" ? { "x-yawf-transcode-audio": "0" } : {},
    })));
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/wrong-audio/index.m3u8", timelineOffsetSeconds: 3600,
      startPositionSeconds: 0, quality: "480p" as const,
      audioTrack: caseName === "metadata mismatch" ? 0 : caseName === "unconfirmed" ? undefined : 1,
    }));
    const legacy = vi.fn();
    render(<VideoPlayer url="https://server.example/api/stream/audio-original" title="Audio confirmation"
      serverOptimized={{ qualities: ["480p"], request, loadSourceInfo: async () => ({ durationSeconds: 7200, tracks: [
        { index: 0, language: "eng", label: "English", default: false },
        { index: 1, language: "jpn", label: "Japanese", default: true },
      ] }) }} requestWebviewFallback={legacy} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(original, "currentTime", { configurable: true, value: 3600 });
    fireMediaError(original);
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 3600, 1));
    await waitFor(() => expect(screen.getByText("Playback interrupted")).toBeInTheDocument());
    expect(screen.getByText(/could not preserve the selected audio track/)).toBeInTheDocument();
    expect(hlsInstances).toHaveLength(0);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("supersedes remembered-audio warmup after backward zero seek and media error", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const pending = deferred<{ url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: ServerTranscodeQuality; audioTrack: number }>();
    let count = 0;
    const request = vi.fn((quality: ServerTranscodeQuality, position: number, audioTrack = 0) => ++count === 1
      ? pending.promise : Promise.resolve({
        url: `https://server.example/api/stream/fixed-zero-${count}/index.m3u8`,
        timelineOffsetSeconds: position, startPositionSeconds: 0, quality, audioTrack,
      }));
    const legacy = vi.fn();
    render(<VideoPlayer url="https://server.example/api/stream/remembered-original" title="Remembered recovery"
      startPositionSeconds={16} savedPrefs={{ preferredAudioLang: "jpn" }}
      serverOptimized={{ qualities: ["480p"], request, loadSourceInfo: async () => ({ durationSeconds: 7200, tracks: [
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "jpn", label: "Japanese", default: false },
      ] }) }} requestWebviewFallback={legacy} onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    let position = 16;
    Object.defineProperties(original, {
      currentTime: { configurable: true, get: () => position, set: (value: number) => { position = value; } },
      duration: { configurable: true, value: 7200 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, value: true },
    });
    fireEvent.loadedMetadata(original); fireEvent.timeUpdate(original); fireEvent.pause(original);
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 16, 1));
    act(() => { scrubBarMock.mock.lastCall![0].onSeek(0); });
    fireEvent.seeking(original); fireEvent.seeked(original);
    fireMediaError(original);
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(1));
    expect(request.mock.calls.slice(1).every(([, target]) => target === 0)).toBe(true);
    await waitFor(() => expect(hlsInstances.length).toBeGreaterThan(0));
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
    await act(async () => { pending.resolve({
      url: "https://server.example/api/stream/stale-remembered/index.m3u8",
      timelineOffsetSeconds: 16, startPositionSeconds: 0, quality: "480p", audioTrack: 1,
    }); });
    expect(document.querySelector("video.player-video")).toBe(recovered);
    expect(hlsInstances.some((instance) => instance.loadSource.mock.calls.some(
      ([source]) => source === "https://server.example/api/stream/stale-remembered/index.m3u8",
    ))).toBe(false);
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    expect(recovered.autoplay).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });

  it.each([true, false])("retries busy offset recovery at the retained point with paused=%s", async (wasPaused) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const pending = deferred<{ url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: "480p"; audioTrack: number }>();
    let calls = 0;
    const request = vi.fn(() => ++calls === 1 ? Promise.reject(new Error("Server is busy")) : pending.promise);
    const legacy = vi.fn();
    render(<VideoPlayer url="https://server.example/api/stream/busy-original" title="Busy retry"
      serverOptimized={{ qualities: ["480p"], request, loadSourceInfo: async () => ({ durationSeconds: 7200, tracks: [
        { index: 1, language: "jpn", label: "Japanese", default: true },
      ] }) }} requestWebviewFallback={legacy} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    let position = 3600;
    let paused = wasPaused;
    Object.defineProperties(original, {
      currentTime: { configurable: true, get: () => position }, duration: { configurable: true, value: 7200 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, get: () => paused },
    });
    original.volume = 0.35; original.muted = true; original.playbackRate = 1.25;
    fireEvent.loadedMetadata(original); fireEvent.timeUpdate(original);
    if (paused) fireEvent.pause(original); else fireEvent.play(original);
    position = 0; paused = true;
    Object.defineProperty(original, "error", { configurable: true, value: { code: 3 } });
    fireEvent.pause(original); fireEvent.error(original);
    await waitFor(() => expect(screen.getByText("Playback interrupted")).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith("480p", 3600, 1);
    const retry = screen.getByRole("button", { name: "Retry playback" });
    await userEvent.click(retry);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("480p", 3600, 1);
    expect(document.querySelector("video.player-video")).toBeNull();
    fireEvent.click(retry);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve({
      url: "https://server.example/api/stream/busy-recovered/index.m3u8", timelineOffsetSeconds: 3600,
      startPositionSeconds: 0, quality: "480p", audioTrack: 1,
    }); });
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const recovered = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(recovered.autoplay).toBe(false);
    expect(recovered.volume).toBe(0.35); expect(recovered.muted).toBe(true); expect(recovered.playbackRate).toBe(1.25);
    let recoveredPaused = true;
    Object.defineProperties(recovered, {
      duration: { configurable: true, value: 18 }, readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, get: () => recoveredPaused },
    });
    const play = vi.mocked(HTMLMediaElement.prototype.play); play.mockClear();
    play.mockImplementation(function (this: HTMLMediaElement) {
      recoveredPaused = false; fireEvent.play(this); fireEvent.playing(this); return Promise.resolve();
    });
    fireEvent.loadedMetadata(recovered); fireEvent.timeUpdate(recovered);
    expect(play).toHaveBeenCalledTimes(wasPaused ? 0 : 1);
    expect(recovered.paused).toBe(wasPaused);
    expect(scrubBarMock.mock.lastCall![0].currentTime).toBe(3600);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("does not commit a failed-recovery Retry after its playback owner changes", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const pending = deferred<{ url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: "480p" }>();
    let calls = 0;
    const requestA = vi.fn(() => ++calls === 1 ? Promise.reject(new Error("Server is busy")) : pending.promise);
    const requestB = vi.fn();
    const view = render(<VideoPlayer url="https://server.example/api/stream/retry-A" title="Retry A"
      serverOptimized={{ qualities: ["480p"], request: requestA }} onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(original, "currentTime", { configurable: true, value: 73.1 });
    fireMediaError(original);
    await waitFor(() => expect(screen.getByText("Playback interrupted")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await waitFor(() => expect(requestA).toHaveBeenCalledTimes(2));
    view.rerender(<VideoPlayer url="https://server.example/api/stream/retry-B" title="Retry B" sourceRevision={1}
      serverOptimized={{ qualities: ["480p"], request: requestB }} onClose={() => {}} />);
    const current = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(current.src).toBe("https://server.example/api/stream/retry-B");
    await act(async () => { pending.resolve({
      url: "https://server.example/api/stream/stale-retry/index.m3u8", timelineOffsetSeconds: 73.1,
      startPositionSeconds: 0, quality: "480p",
    }); });
    expect(document.querySelector("video.player-video")).toBe(current);
    expect(requestB).not.toHaveBeenCalled();
    expect(hlsInstances).toHaveLength(0);
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("keeps the known saved start when Original fails before metadata", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (quality: ServerTranscodeQuality, position: number) => ({
      url: "https://server.example/api/stream/start-recovery/index.m3u8",
      timelineOffsetSeconds: position, startPositionSeconds: 0, quality,
    }));
    render(<VideoPlayer url="https://server.example/api/stream/start-original" title="Known resume"
      startPositionSeconds={3600} serverOptimized={{ qualities: ["480p"], request }} onClose={() => {}} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(original.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
    expect(original.currentTime).toBe(0);
    fireMediaError(original);
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 3600));
  });

  it.each(["explicit start", "committed seek"])("keeps %s zero over an older saved start before metadata", async (intent) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (quality: ServerTranscodeQuality, position: number) => ({
      url: "https://server.example/api/stream/zero-start-recovery/index.m3u8",
      timelineOffsetSeconds: position, startPositionSeconds: 0, quality,
    }));
    const props = { url: "https://server.example/api/stream/zero-start-original", title: "Zero resume",
      startPositionSeconds: 3600, serverOptimized: { qualities: ["480p"] as ServerTranscodeQuality[], request }, onClose: vi.fn() };
    const view = render(<VideoPlayer {...props} />);
    if (intent === "explicit start") view.rerender(<VideoPlayer {...props} startPositionSeconds={0} />);
    else {
      act(() => { scrubBarMock.mock.lastCall![0].onSeek(0); });
      fireEvent.seeked(document.querySelector("video.player-video")!);
    }
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(original.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
    fireMediaError(original);
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0));
  });

  it("ignores a stale fallback success while the current source recovery stays pending", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const requestA = vi.fn(() => first.promise);
    const requestB = vi.fn(() => second.promise);
    const { rerender } = render(
      <VideoPlayer url="https://x/a.mp4" title="T" requestWebviewFallback={requestA} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
    await waitFor(() => expect(requestA).toHaveBeenCalledTimes(1));

    rerender(
      <VideoPlayer url="https://x/b.mp4" title="T" requestWebviewFallback={requestB} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
    await waitFor(() => expect(requestB).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".player-compatibility-status")).not.toBeNull();

    await act(async () => {
      first.resolve("https://x/stale-a.m3u8");
      await first.promise;
    });
    expect(document.querySelector(".player-compatibility-status")).not.toBeNull();
    expect(screen.queryByText("Playback interrupted")).toBeNull();

    second.resolve("https://x/current-b.m3u8");
    await waitFor(() => expect(hlsInstances.some(
      (instance) => instance.loadSource.mock.calls.some(([value]) => value === "https://x/current-b.m3u8"),
    )).toBe(true));
    expect(hlsInstances.some(
      (instance) => instance.loadSource.mock.calls.some(([value]) => value === "https://x/stale-a.m3u8"),
    )).toBe(false);
  });

  it("ignores a stale fallback failure without clearing the current source recovery", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const { rerender } = render(
      <VideoPlayer url="https://x/a.mp4" title="T" requestWebviewFallback={() => first.promise} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);

    rerender(
      <VideoPlayer url="https://x/b.mp4" title="T" requestWebviewFallback={() => second.promise} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
    expect(document.querySelector(".player-compatibility-status")).not.toBeNull();

    await act(async () => {
      first.resolve(null);
      await first.promise;
    });
    expect(document.querySelector(".player-compatibility-status")).not.toBeNull();
    expect(screen.queryByText("Playback interrupted")).toBeNull();

    await act(async () => {
      second.resolve(null);
      await second.promise;
    });
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
  });

  it("lets a new source recover while the previous fallback request never settles", async () => {
    const never = new Promise<string | null>(() => {});
    const requestB = vi.fn(async () => "https://x/current-b.m3u8");
    const { rerender } = render(
      <VideoPlayer url="https://x/a.mp4" title="T" requestWebviewFallback={() => never} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);

    rerender(
      <VideoPlayer url="https://x/b.mp4" title="T" requestWebviewFallback={requestB} onClose={() => {}} />,
    );
    fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);

    await waitFor(() => expect(requestB).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hlsInstances.some(
      (instance) => instance.loadSource.mock.calls.some(([value]) => value === "https://x/current-b.m3u8"),
    )).toBe(true));
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("bounds startup fallback preparation and restores usable recovery actions", async () => {
    vi.useFakeTimers();
    try {
      const requestWebviewFallback = vi.fn(() => new Promise<string | null>(() => {}));
      render(
        <VideoPlayer
          url="https://x/stuck.mp4"
          title="T"
          requestWebviewFallback={requestWebviewFallback}
          onClose={() => {}}
        />,
      );
      await act(async () => {
        vi.advanceTimersByTime(20_000);
        await Promise.resolve();
      });
      expect(requestWebviewFallback).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".player-compatibility-status")).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(8_000);
        await Promise.resolve();
      });
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /external player/ })).toBeNull();
      expect(screen.getByText(/External playback is not available/)).toBeInTheDocument();
      expect(document.querySelector(".player-compatibility-status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the stream-scoped external handoff in the playback settings menu", async () => {
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const createObjectURL = vi.fn((_blob: Blob) => "blob:player-list");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const restoreCreate = replaceProperty(URL, "createObjectURL", createObjectURL);
    const restoreRevoke = replaceProperty(URL, "revokeObjectURL", revokeObjectURL);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl={`https://server.example/api/external-stream/session-1/${"A".repeat(43)}`}
          title="Example Movie"
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Download player playlist/ }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const playlist = createObjectURL.mock.calls[0][0] as Blob;
      await expect(playlist.text()).resolves.toContain(
        `https://server.example/api/external-stream/session-1/${"A".repeat(43)}`,
      );
      expect(click).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Player playlist downloaded/)).toBeInTheDocument();
      expect(recordDiagnosticMock).toHaveBeenCalledWith(
        "player",
        "external.playlist_downloaded",
      );
      expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
        "player",
        "external.started",
      );
    } finally {
      click.mockRestore();
      restoreCreate();
      restoreRevoke();
    }
  });

  it("offers explicit iOS VLC and Infuse anchors without claiming either app opened", async () => {
    deviceKindMock.mockReturnValue("ios");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"B".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={target}
        sourceFileName="Film & Friends.mp4"
        title="Film & Friends"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const vlc = screen.getByRole("link", { name: /Open in VLC/ });
    const infuse = screen.getByRole("link", { name: /Open in Infuse/ });
    expect(vlc).toHaveAttribute(
      "href",
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(target)}`,
    );
    expect(infuse).toHaveAttribute(
      "href",
      `infuse://x-callback-url/play?url=${encodeURIComponent(target)}&filename=Film%20%26%20Friends`,
    );
    fireEvent.click(vlc);
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "player",
      "external.intent_requested",
    );
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.started",
    );
  });

  it("places direct iOS players immediately after Audio and before playlist fallbacks", async () => {
    deviceKindMock.mockReturnValue("ios");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"E".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={target}
        sourceFileName="Film.mp4"
        title="Film"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const dialog = screen.getByRole("dialog", { name: "Playback settings" });
    const audio = within(dialog).getByRole("heading", { name: "Audio track" })
      .closest<HTMLElement>(".player-options-section");
    const external = within(dialog).getByText("External player")
      .closest<HTMLElement>(".player-options-section");
    const fit = within(dialog).getByText("Video fit")
      .closest<HTMLElement>(".player-options-section");
    const vlc = within(dialog).getByRole("link", { name: /Open in VLC/ });
    const playlist = within(dialog).getByRole("button", { name: /Download player playlist/ });

    expect(audio).not.toBeNull();
    expect(external).not.toBeNull();
    expect(fit).not.toBeNull();
    expect(audio!.compareDocumentPosition(external!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(external!.compareDocumentPosition(fit!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(vlc.compareDocumentPosition(playlist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(vlc).toHaveAttribute(
      "href",
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(target)}`,
    );
  });

  it("keeps Playback settings as the active modal and restores its exact trigger", async () => {
    const onClose = vi.fn();
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="Focus test"
        onClose={onClose}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Playback settings" });
    trigger.blur();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Playback settings" });
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: /Keyboard shortcuts/ })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Playback settings" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Playing Focus test" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("opens eligible multitrack Audio directly and announces the selected track", async () => {
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "fra", label: "French", default: false },
    ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="Audio test"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Audio tracks" });
    expect(trigger).toHaveTextContent("Audio");
    fireEvent.click(trigger);

    const heading = await screen.findByRole("heading", { name: "Audio track" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    expect(loadAudioTracks).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Audio track, English" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Playback settings" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("expands code-only labels from the initial server inventory without changing track indices", async () => {
    const loadSourceInfo = vi.fn(async () => ({
      durationSeconds: 600,
      tracks: [
        { index: 0, language: "eng", label: "eng", default: true },
        { index: 1, language: "fre", label: "fre", default: false },
      ],
    }));
    const request = vi.fn(async (_quality: string, _position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&audio=${audioTrack}`,
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
        title="Initial audio labels"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
        onClose={() => {}}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Audio track, English" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "French" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "French" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));
  });

  it("expands asynchronously loaded server codes while preserving a custom title", async () => {
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "eng", default: true },
      { index: 1, language: "eng", label: "English commentary 5.1", default: false },
      { index: 2, language: "jpn", label: "", default: false },
    ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="Loaded audio labels"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    expect(await screen.findByRole("button", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English commentary 5.1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Japanese" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audio track, English" })).toBeInTheDocument();
  });

  it("removes the Audio shortcut after a single-track inventory and restores Settings focus", async () => {
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "English", default: true },
    ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="Single audio test"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    expect(await screen.findByText("This stream reports one audio track.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audio track, English" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    expect(screen.queryByRole("button", { name: "Audio track, English" })).toBeNull();
    expect(screen.getByRole("button", { name: "Playback settings" })).toHaveFocus();
  });

  it("removes an unavailable Audio shortcut while retaining retry in Settings", async () => {
    const loadAudioTracks = vi.fn(async () => {
      throw new Error("inventory unavailable");
    });
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="Unavailable audio test"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    expect(await screen.findByText("Audio track inventory is temporarily unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    expect(screen.queryByRole("button", { name: "Audio tracks" })).toBeNull();
    const settings = screen.getByRole("button", { name: "Playback settings" });
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(screen.getByRole("button", { name: "Retry audio tracks" })).toBeInTheDocument();
    expect(loadAudioTracks).toHaveBeenCalledTimes(1);
  });

  it("restores the multitrack Audio shortcut after a successful Settings retry", async () => {
    const loadAudioTracks = vi.fn()
      .mockRejectedValueOnce(new Error("inventory unavailable"))
      .mockResolvedValueOnce([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="Recovered audio test"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
    expect(await screen.findByText("Audio track inventory is temporarily unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
    expect(screen.queryByRole("button", { name: "Audio tracks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    const audio = screen.getByRole("button", { name: "Audio track, English" });
    fireEvent.click(audio);
    await waitFor(() => expect(
      screen.getByRole("heading", { name: "Audio track" }),
    ).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(audio).toHaveFocus();
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
  });

  it("offers the exact Mac IINA settings anchor without claiming the app opened", async () => {
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"I".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={target}
        sourceFileName="Film.mp4"
        title="Film & mpv-options=--script=/tmp/nope"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const iina = screen.getByRole("link", { name: /Open in IINA/ });
    expect(iina).toHaveAttribute(
      "href",
      `iina://open?url=${encodeURIComponent(target)}&new_window=1`,
    );
    expect(iina.getAttribute("href")).not.toContain("Film");
    expect(iina.getAttribute("href")).not.toContain("mpv-options");
    expect(screen.getByRole("link", { name: /Open in Infuse/ })).toHaveAttribute(
      "href",
      `infuse://x-callback-url/play?url=${encodeURIComponent(target)}` +
        "&filename=Film%20%26%20mpv-options%3D--script%3D%2Ftmp%2Fnope",
    );

    fireEvent.click(iina);
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "player",
      "external.intent_requested",
    );
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.started",
    );
  });

  it("keeps the same direct IINA action and honest playlist fallback in Mac recovery", async () => {
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"R".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/video.mp4"
        externalPlaybackUrl={target}
        sourceFileName="Film.m3u8"
        title="Film"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const settingsHref = screen.getByRole("link", { name: /Open in IINA/ }).getAttribute("href");
    expect(settingsHref).toBe(`iina://open?url=${encodeURIComponent(target)}&new_window=1`);

    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireMediaError(video);

    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in IINA" })).toHaveAttribute(
      "href",
      settingsHref,
    );
    expect(screen.queryByRole("link", { name: /Open in Infuse/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Download player playlist (.m3u)" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in external player" })).toBeNull();
  });

  it("removes stale Infuse when only the original filename changes from progressive to HLS", async () => {
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"S".repeat(43)}`;
    const sourceUrl = "https://server.example/api/stream/session-1";
    const { rerender } = render(
      <VideoPlayer
        url={sourceUrl}
        externalPlaybackUrl={target}
        sourceFileName="Film.mp4"
        title="Film"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const originalIinaHref = screen.getByRole("link", { name: /Open in IINA/ })
      .getAttribute("href");
    expect(screen.getByRole("link", { name: /Open in Infuse/ })).toBeInTheDocument();

    rerender(
      <VideoPlayer
        url={sourceUrl}
        externalPlaybackUrl={target}
        sourceFileName="Film.m3u8"
        title="Film"
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("link", { name: /Open in IINA/ })).toHaveAttribute(
      "href",
      originalIinaHref,
    );
    expect(screen.queryByRole("link", { name: /Open in Infuse/ })).toBeNull();
  });

  it("replaces stale Mac IINA and Infuse links when the target and original filename change", async () => {
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const first = `https://server.example/api/external-stream/first/${"C".repeat(43)}`;
    const second = `https://server.example/api/external-stream/second/${"D".repeat(43)}`;
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/first"
        externalPlaybackUrl={first}
        sourceFileName="Film.mkv"
        title="Film"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("link", { name: /Open in IINA/ })).toHaveAttribute(
      "href",
      expect.stringContaining(encodeURIComponent(first)),
    );
    expect(screen.getByRole("link", { name: /Open in Infuse/ })).toBeInTheDocument();

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/second"
        externalPlaybackUrl={second}
        sourceFileName="Film.m3u8"
        title="Film"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const replacement = screen.getByRole("link", { name: /Open in IINA/ });
    expect(replacement).toHaveAttribute(
      "href",
      `iina://open?url=${encodeURIComponent(second)}&new_window=1`,
    );
    expect(replacement.getAttribute("href")).not.toContain(encodeURIComponent(first));
    expect(screen.queryByRole("link", { name: /Open in Infuse/ })).toBeNull();

    rerender(
      <VideoPlayer
        url="https://provider.example/private-file.mkv"
        externalPlaybackUrl="https://provider.example/private-file.mkv?authorization=secret"
        title="Film"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: /Open in IINA/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Open in Infuse/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Download player playlist/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy stream link/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain("authorization=secret");
  });

  it("opens the Android chooser with the cookie-free capability and keeps copy fallback", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl="https://server.example/api/external-stream/session-1/capability"
          title="T"
          onClose={() => {}}
        />,
      );
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      pause.mockClear();
      openAndroidExternalPlayerMock.mockImplementation(async () => {
        expect(pause).toHaveBeenCalledTimes(1);
        return "Player chooser opened. Select a video app to continue.";
      });
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

      expect(pause).toHaveBeenCalledTimes(1);
      expect(openAndroidExternalPlayerMock).toHaveBeenCalledTimes(1);
      expect(openAndroidExternalPlayerMock.mock.calls[0][0]).toBe(
        "https://server.example/api/external-stream/session-1/capability",
      );
      expect(openAndroidExternalPlayerMock.mock.calls[0][1]()).toBe(true);
      expect(screen.getByText(/Player chooser opened/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));

      expect(writeText).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/session-1/capability",
      );
      expect(pause).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Stream link copied/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
        "href",
        "https://server.example/api/external-stream/session-1/capability",
      );
      expect(openInExternalPlayerMock).not.toHaveBeenCalled();
    } finally {
      restoreClipboard();
    }
  });

  it("offers copy without invoking or pausing when the Android page origin is remote", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl="https://server.example/api/external-stream/session-1/capability"
          title="T"
          onClose={() => {}}
        />,
      );
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      pause.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));

      expect(screen.queryByRole("button", { name: /Open in external player/ })).toBeNull();
      expect(screen.getByText("Paste into VLC or another player")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /^Copy stream link/ }));

      expect(writeText).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/session-1/capability",
      );
      expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(screen.getByText(/Stream link copied/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
      fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Open in external player/ })).toBeNull();
      const pausesAfterErrorRetirement = pause.mock.calls.length;
      await userEvent.click(screen.getByRole("button", { name: "Copy stream link" }));
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
      expect(pause).toHaveBeenCalledTimes(pausesAfterErrorRetirement);
    } finally {
      restoreClipboard();
    }
  });

  it("opens remote Server Mode in Android with provider-only detection and pauses at confirmation", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/yawf/watch"));
    installRemoteServerPlayerProvider();
    const native = deferred<string | null>();
    const captured: { handoff?: () => void; signal?: AbortSignal } = {};
    openAndroidServerExternalPlayerMock.mockImplementation(
      async (_url, _ownsRequest, signal, onHandoff) => {
        captured.handoff = onHandoff;
        captured.signal = signal;
        return native.promise;
      },
    );
    render(
      <VideoPlayer
        url="https://server.example/yawf/api/stream/session-1"
        externalPlaybackUrl={`https://server.example/yawf/api/external-stream/session-1/${"A".repeat(43)}`}
        engine="native-mpv"
        title="T"
        onClose={() => {}}
      />,
    );
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

    expect(openAndroidServerExternalPlayerMock).toHaveBeenCalledWith(
      `https://server.example/yawf/api/external-stream/session-1/${"A".repeat(43)}`,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
    expect(screen.getByText("Waiting for Android confirmation…")).toBeInTheDocument();
    expect(pause).not.toHaveBeenCalled();
    expect(captured.signal?.aborted).toBe(false);

    act(() => captured.handoff?.());
    expect(pause).toHaveBeenCalledTimes(1);
    await act(async () => {
      native.resolve("External player opened.");
      await native.promise;
    });
    expect(screen.getByText(
      "Player chooser opened. If playback did not start, finish the selected player's setup and try again.",
    )).toBeInTheDocument();
    expect(screen.queryByText("External player opened.")).toBeNull();
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "player",
      "external.chooser_opened",
    );
  });

  it("cancels a remote Server Mode request when the source is replaced", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    installRemoteServerPlayerProvider();
    const never = new Promise<string | null>(() => {});
    const captured: { signal?: AbortSignal } = {};
    openAndroidServerExternalPlayerMock.mockImplementation(
      async (_url, _ownsRequest, signal) => {
        captured.signal = signal;
        return never;
      },
    );
    const token = "B".repeat(43);
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/a"
        externalPlaybackUrl={`https://server.example/api/external-stream/a/${token}`}
        title="T"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
    expect(captured.signal?.aborted).toBe(false);

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/b"
        externalPlaybackUrl={`https://server.example/api/external-stream/b/${token}`}
        title="T"
        onClose={() => {}}
      />,
    );

    expect(captured.signal?.aborted).toBe(true);
    expect(screen.queryByText("Waiting for Android confirmation…")).toBeNull();
  });

  it("reports a remote native cancellation without treating it as a launch failure", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    installRemoteServerPlayerProvider();
    openAndroidServerExternalPlayerMock.mockResolvedValue(
      "External player request canceled.",
    );
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={`https://server.example/api/external-stream/session-1/${"C".repeat(43)}`}
        title="T"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

    expect(screen.getByText("External player request canceled.")).toBeInTheDocument();
    expect(screen.queryByText(/Player chooser opened\./)).toBeNull();
    expect(screen.queryByText("External player opened.")).toBeNull();
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.chooser_opened",
    );
    expect(recordDiagnosticMock).toHaveBeenCalledWith(
      "player",
      "external.chooser_cancelled",
    );
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.start_failed",
      "error",
    );
  });

  it("uses mobile copy UI for a remote provider-only Android WebView", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const getInsets = vi.fn(() => '{"top":0,"right":0,"bottom":0,"left":0}');
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true,
      value: { getInsets },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/protected-session"
          externalPlaybackUrl="https://server.example/api/external-stream/capability"
          engine="native-mpv"
          title="T"
          onClose={() => {}}
        />,
      );
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      pause.mockClear();

      expect(document.querySelector("video.player-video")).not.toBeNull();
      expect(getInsets).not.toHaveBeenCalled();
      expect(playWithMpvMock).not.toHaveBeenCalled();
      expect(openInExternalPlayerMock).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.queryByRole("button", { name: /Open in external player/ })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: /^Copy stream link/ }));

      expect(writeText).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/capability",
      );
      expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
      expect(openInExternalPlayerMock).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
        "href",
        "https://server.example/api/external-stream/capability",
      );
    } finally {
      restoreClipboard();
    }
  });

  it("keeps partial desktop Tauri globals on the provider-backed webview path", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true,
      value: { getInsets: vi.fn(() => '{"top":0,"right":0,"bottom":0,"left":0}') },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });

    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/protected-session"
          externalPlaybackUrl="https://server.example/api/external-stream/capability"
          engine="native-mpv"
          title="T"
          onClose={() => {}}
        />,
      );

      expect(document.querySelector("video.player-video")).not.toBeNull();
      expect(screen.queryByTestId("embedded-player")).toBeNull();
      expect(playWithMpvMock).not.toHaveBeenCalled();
      expect(openInExternalPlayerMock).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /^Copy stream link/ }));
      expect(writeText).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/capability",
      );
      expect(openInExternalPlayerMock).not.toHaveBeenCalled();
      expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
    } finally {
      restoreClipboard();
    }
  });

  it("withholds protected proxy URLs in a provider-only Android WebView", async () => {
    isTauriMock.mockReturnValue(false);
    deviceKindMock.mockReturnValue("mac");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true,
      value: { getInsets: vi.fn(() => '{"top":0,"right":0,"bottom":0,"left":0}') },
    });
    installRemoteServerPlayerProvider();

    render(
      <VideoPlayer
        url="https://server.example/api/stream/protected-session"
        externalPlaybackUrl={null}
        engine="native-mpv"
        title="T"
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByText(
      "External playback is not available for this protected stream",
      { exact: false },
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy stream link/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Selectable stream link" })).toBeNull();
    expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
    expect(openAndroidServerExternalPlayerMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("shows and invokes the Android chooser for a desktop-looking marked WebView", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("mac");
    Object.defineProperty(window, "__YAWF_TAURI_MOBILE__", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, "__YAWF_TAURI_ANDROID__", {
      configurable: true,
      value: true,
    });

    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl="https://server.example/api/external-stream/session-1/capability"
        title="T"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

    expect(openAndroidExternalPlayerMock).toHaveBeenCalledWith(
      "https://server.example/api/external-stream/session-1/capability",
      expect.any(Function),
    );
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Player chooser opened/)).toBeInTheDocument();
  });

  it("keeps visible chooser progress until native dispatch settles", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    vi.useFakeTimers();
    const pending = deferred<string | null>();
    openAndroidExternalPlayerMock.mockReturnValue(pending.promise);
    render(
      <VideoPlayer
        url="https://server.example/stream"
        externalPlaybackUrl="https://server.example/capability"
        title="T"
        onClose={() => {}}
      />,
    );
    fireEvent.canPlay(document.querySelector("video.player-video") as HTMLVideoElement);
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
    expect(screen.getByText("Opening Android player chooser…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText("Opening Android player chooser…")).toBeInTheDocument();

    await act(async () => {
      pending.resolve("Player chooser opened. Select a video app to continue.");
      await pending.promise;
    });
    expect(screen.getByText(/Player chooser opened/)).toBeInTheDocument();
  });

  it("ignores deferred Android chooser completion for a same-target source revision", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const pending = deferred<string | null>();
    openAndroidExternalPlayerMock.mockReturnValue(pending.promise);
    const props = {
      url: "https://server.example/stream",
      externalPlaybackUrl: "https://server.example/capability",
      title: "T",
      onClose: () => {},
    };
    const { rerender } = render(<VideoPlayer {...props} sourceRevision={1} />);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
    expect(screen.getByText("Opening Android player chooser…")).toBeInTheDocument();

    rerender(<VideoPlayer {...props} sourceRevision={2} />);
    expect(openAndroidExternalPlayerMock.mock.calls[0][1]()).toBe(false);
    expect(screen.queryByText("Opening Android player chooser…")).toBeNull();
    await act(async () => {
      pending.resolve("Player chooser opened. Select a video app to continue.");
      await pending.promise;
    });
    expect(screen.queryByText(/Player chooser opened/)).toBeNull();
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.chooser_opened",
    );
  });

  it("clears completed status and fences copy completion for a same-target source revision", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const pendingCopy = deferred<void>();
    const writeText = vi.fn().mockReturnValue(pendingCopy.promise);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    const props = {
      url: "https://server.example/stream",
      externalPlaybackUrl: "https://server.example/capability",
      title: "T",
      onClose: () => {},
    };
    try {
      const { rerender } = render(<VideoPlayer {...props} sourceRevision={1} />);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
      expect(screen.getByText(/Player chooser opened/)).toBeInTheDocument();

      rerender(<VideoPlayer {...props} sourceRevision={2} />);
      expect(screen.queryByText(/Player chooser opened/)).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      expect(screen.getByText("Copying stream link…")).toBeInTheDocument();

      rerender(<VideoPlayer {...props} sourceRevision={3} />);
      expect(screen.queryByText("Copying stream link…")).toBeNull();
      await act(async () => {
        pendingCopy.resolve();
        await pendingCopy.promise;
      });
      expect(screen.queryByText(/Stream link copied/)).toBeNull();
      expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
        "player",
        "external.link_copied",
      );
    } finally {
      restoreClipboard();
    }
  });

  it("ignores a deferred Android chooser result after the source changes", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const pending = deferred<string | null>();
    openAndroidExternalPlayerMock.mockReturnValue(pending.promise);
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/a"
        externalPlaybackUrl="https://server.example/capability-a"
        title="T"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
    expect(openAndroidExternalPlayerMock).toHaveBeenCalledTimes(1);

    rerender(
      <VideoPlayer
        url="https://server.example/b"
        externalPlaybackUrl="https://server.example/capability-b"
        title="T"
        onClose={() => {}}
      />,
    );
    expect(openAndroidExternalPlayerMock.mock.calls[0][1]()).toBe(false);
    await act(async () => {
      pending.resolve("Player chooser opened. Select a video app to continue.");
      await pending.promise;
    });
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.queryByText(/Player chooser opened/)).toBeNull();
    expect(recordDiagnosticMock).not.toHaveBeenCalledWith(
      "player",
      "external.chooser_opened",
    );
  });

  it("surfaces a sanitized Android chooser failure with manual fallbacks", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    openAndroidExternalPlayerMock.mockRejectedValue(
      new Error("private-stream-marker native detail"),
    );
    render(
      <VideoPlayer
        url="https://server.example/stream"
        externalPlaybackUrl="https://server.example/private-stream-marker"
        title="T"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

    expect(screen.getByText(/Android player chooser could not be opened/)).toBeInTheDocument();
    expect(screen.queryByText(/private-stream-marker native detail/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Copy stream link/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
      "href",
      "https://server.example/private-stream-marker",
    );
  });

  it("offers Android chooser and manual stream fallbacks after playback interruption", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl="https://server.example/api/external-stream/capability-1"
          title="T"
          onClose={() => {}}
        />,
      );
      fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
        "href",
        "https://server.example/api/external-stream/capability-1",
      );

      await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));
      expect(openAndroidExternalPlayerMock).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/capability-1",
        expect.any(Function),
      );
      await userEvent.click(screen.getByRole("button", { name: "Copy stream link" }));
      expect(writeText).toHaveBeenCalledWith(
        "https://server.example/api/external-stream/capability-1",
      );
    } finally {
      restoreClipboard();
    }
  });

  it("clears a completed mobile copy result when the capability target changes", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      const { rerender } = render(
        <VideoPlayer
          url="https://server.example/a"
          externalPlaybackUrl="https://server.example/capability-a"
          title="T"
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      expect(screen.getByText(/Stream link copied/)).toBeInTheDocument();

      rerender(
        <VideoPlayer
          url="https://server.example/b"
          externalPlaybackUrl="https://server.example/capability-b"
          title="T"
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.queryByText(/Stream link copied/)).toBeNull();
      expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
        "href",
        "https://server.example/capability-b",
      );
    } finally {
      restoreClipboard();
    }
  });

  it("ignores deferred mobile copy resolution and rejection from older targets", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const first = deferred<void>();
    const second = deferred<void>();
    const writeText = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      const { rerender } = render(
        <VideoPlayer url="https://x/a" externalPlaybackUrl="https://x/cap-a" title="T" onClose={() => {}} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      rerender(
        <VideoPlayer url="https://x/b" externalPlaybackUrl="https://x/cap-b" title="T" onClose={() => {}} />,
      );
      await act(async () => { first.resolve(); await first.promise; });
      expect(screen.queryByText(/Stream link copied/)).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      rerender(
        <VideoPlayer url="https://x/c" externalPlaybackUrl="https://x/cap-c" title="T" onClose={() => {}} />,
      );
      await act(async () => { second.reject(new Error("copy failed")); await second.promise.catch(() => {}); });
      expect(screen.queryByText(/could not be copied/)).toBeNull();
      expect(recordDiagnosticMock.mock.calls.some(
        ([scope, event]) => scope === "player" && String(event).startsWith("external."),
      )).toBe(false);
    } finally {
      restoreClipboard();
    }
  });

  it("shows manual mobile copy recovery only for a rejection owned by the current target", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const writeText = vi.fn().mockRejectedValue(new Error("copy failed"));
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      render(
        <VideoPlayer url="https://x/current" externalPlaybackUrl="https://x/current-cap" title="T" onClose={() => {}} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      expect(screen.getByText(/could not be copied/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Selectable stream link" })).toHaveAttribute(
        "href",
        "https://x/current-cap",
      );
    } finally {
      restoreClipboard();
    }
  });

  it("does not commit a deferred mobile copy after player unmount", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const pending = deferred<void>();
    const writeText = vi.fn().mockReturnValue(pending.promise);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    try {
      const { unmount } = render(
        <VideoPlayer url="https://x/a" externalPlaybackUrl="https://x/cap-a" title="T" onClose={() => {}} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Copy stream link/ }));
      recordDiagnosticMock.mockClear();
      unmount();
      await act(async () => { pending.resolve(); await pending.promise; });
      expect(recordDiagnosticMock.mock.calls.some(
        ([scope, event]) => scope === "player" && String(event).startsWith("external."),
      )).toBe(false);
    } finally {
      restoreClipboard();
    }
  });

  describe("quality handoff browser autoplay", () => {
    // jsdom does not run HTML's native autoplay algorithm. Model its permitted
    // HAVE_ENOUGH_DATA action separately from script play(): new media starts
    // eligible, and both play() and pause() clear the can-autoplay flag.
    // https://html.spec.whatwg.org/multipage/media.html#ready-states
    function observeBrowserAutoplay() {
      const states = new WeakMap<HTMLMediaElement, {
        paused: boolean;
        canAutoplay: boolean;
        readyState: number;
        currentTime: number;
      }>();
      const observe = (video: HTMLVideoElement) => {
        const state = { paused: true, canAutoplay: true, readyState: 0, currentTime: 0 };
        states.set(video, state);
        Object.defineProperties(video, {
          paused: { configurable: true, get: () => state.paused },
          readyState: { configurable: true, get: () => state.readyState },
          currentTime: {
            configurable: true,
            get: () => state.currentTime,
            set: (value: number) => { state.currentTime = value; },
          },
          duration: { configurable: true, get: () => state.readyState > 0 ? 600 : Number.NaN },
          seeking: { configurable: true, value: false },
          seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 600 } },
        });
        return state;
      };
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
        const state = states.get(this);
        if (state == null) throw new Error("Unobserved media play");
        state.canAutoplay = false;
        if (state.paused) {
          state.paused = false;
          fireEvent.play(this);
          fireEvent.playing(this);
        }
        return Promise.resolve();
      });
      vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (this: HTMLMediaElement) {
        const state = states.get(this);
        if (state == null) throw new Error("Unobserved media pause");
        state.canAutoplay = false;
        if (!state.paused) {
          state.paused = true;
          fireEvent.pause(this);
        }
      });
      const enoughData = (video: HTMLVideoElement) => {
        const state = states.get(video);
        if (state == null) throw new Error("Unobserved media readiness");
        state.readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
        // This is the allowed browser-native action, not video.play().
        if (state.canAutoplay && state.paused && video.autoplay) {
          state.paused = false;
          fireEvent.play(video);
          fireEvent.playing(video);
        }
        fireEvent.canPlay(video);
        fireEvent.canPlayThrough(video);
      };
      return { observe, enoughData };
    }

    async function prepareQualityHandoff(nativeHls: boolean, initiallyPaused: boolean) {
      deviceKindMock.mockReturnValue(nativeHls ? "ios" : "android");
      if (!nativeHls) {
        Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
          configurable: true, value: { getInsets: vi.fn() },
        });
      }
      vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue(nativeHls ? "probably" : "");
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const browser = observeBrowserAutoplay();
      const request = vi.fn(async () => ({
        url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=339",
        timelineOffsetSeconds: 339,
        startPositionSeconds: 0,
        quality: "480p" as const,
      }));
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n", { status: 200 },
      )));
      render(<VideoPlayer
        url="https://server.example/api/stream/session-1"
        title="Quality autoplay"
        serverOptimized={{ qualities: ["480p"], request }}
        onClose={() => {}}
      />);
      const original = document.querySelector("video.player-video") as HTMLVideoElement;
      const originalState = browser.observe(original);
      // Positive control: ordinary startup still permits browser autoplay.
      expect(original.autoplay).toBe(true);
      browser.enoughData(original);
      fireEvent.loadedMetadata(original);
      expect(original.paused).toBe(false);
      originalState.currentTime = 339;
      fireEvent.timeUpdate(original);
      if (initiallyPaused) await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(original.paused).toBe(initiallyPaused);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      const video = await waitFor(() => {
        const current = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(current).not.toBe(original);
        return current;
      });
      expect(request).toHaveBeenCalledWith("480p", 339);
      if (nativeHls) expect(hlsInstances).toHaveLength(0);
      else await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const state = browser.observe(video);
      return { browser, video, state };
    }

    it.each([false, true])("holds paused explicit quality selection after exact sync and later native autoplay readiness (native HLS: %s)", async (nativeHls) => {
      const { browser, video, state } = await prepareQualityHandoff(nativeHls, true);
      // A queued metadata event can arrive with current data already ready.
      // Exact zero is confirmed without a pause() call on already-paused media.
      state.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      fireEvent.loadedMetadata(video);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(state.canAutoplay).toBe(true);
      expect(video.paused).toBe(true);
      browser.enoughData(video);
      expect(video.paused).toBe(true);
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });

    it.each(["playing", "explicit-play", "explicit-pause", "early-autoplay"] as const)("preserves %s quality handoff controls", async (intent) => {
      const { browser, video, state } = await prepareQualityHandoff(false, intent !== "playing");
      if (intent === "early-autoplay") browser.enoughData(video);
      if (intent === "explicit-play" || intent === "explicit-pause") {
        await userEvent.click(screen.getByRole("button", { name: "Play" }));
        expect(video.paused).toBe(true);
        if (intent === "explicit-pause") await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      }
      state.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      fireEvent.loadedMetadata(video);
      browser.enoughData(video);
      const shouldPlay = intent === "playing" || intent === "explicit-play";
      expect(video.paused).toBe(!shouldPlay);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      if (shouldPlay) {
        await userEvent.click(screen.getByRole("button", { name: "Pause" }));
        browser.enoughData(video);
        expect(video.paused).toBe(true);
        expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      }
    });
  });

  it("defaults to Device Original and exposes Server Optimized qualities only when supported", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=360p&start=120",
      timelineOffsetSeconds: 120,
      startPositionSeconds: 0,
      quality: "360p" as const,
    }));
    const fetchMock = vi.fn(async () => new Response("#EXTM3U\n", { status: 200 }));
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["auto", "720p", "480p", "360p"], request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(video, "currentTime", { configurable: true, value: 120 });
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("button", { name: "Device Original" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "360p" })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "360p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("360p", 120));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(hlsInstances[0]?.loadSource).toHaveBeenCalledWith(
        "https://server.example/api/stream/session-1/index.m3u8?quality=360p&start=120",
      ));
      fireEvent.canPlay(document.querySelector("video.player-video") as HTMLVideoElement);
      expect(play).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("button", { name: "360p" })).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(screen.getByRole("button", { name: "Device Original" }));
      await waitFor(() => expect(
        (document.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe("https://server.example/api/stream/session-1"));
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      play.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("pins an exact zero HLS handoff so EVENT startup cannot choose the live edge", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=9",
      timelineOffsetSeconds: 9,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 9));
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      expect(hlsInstances[0].config.startPosition).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pins a nonzero exact HLS handoff at its local target", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=4",
      timelineOffsetSeconds: 4,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 9));
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      expect(hlsInstances[0].config.startPosition).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pins an exact zero native HLS handoff with a WebKit media fragment", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=9",
      timelineOffsetSeconds: 9,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native zero movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 9));
      const player = screen.getByRole("dialog", { name: "Playing Native zero movie" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe(
        "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=9#t=0.001",
      ));
      expect(hlsInstances).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pins a nonzero exact native HLS handoff with a WebKit media fragment", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=4",
      timelineOffsetSeconds: 4,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native nonzero movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 9));
      const player = screen.getByRole("dialog", { name: "Playing Native nonzero movie" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe(
        "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=4#t=5",
      ));
      expect(hlsInstances).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the decimal zero anchor for a sub-millisecond exact native HLS target", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0.0000001",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native near-zero movie"
          startPositionSeconds={0.0000001}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0.0000001));
      const player = screen.getByRole("dialog", { name: "Playing Native near-zero movie" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe(
        "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0.0000001#t=0.001",
      ));
      expect(hlsInstances).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves native HLS query and fragment bytes before the exact target", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const optimizedUrl =
      "https://server.example/api/stream/session-1/index.m3u8?quality=480p&capability=A%2BB%2F%3D#track=audio&t=7";
    const request = vi.fn(async () => ({
      url: optimizedUrl,
      timelineOffsetSeconds: 9,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const fetchMock = vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native fragment preservation movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      const player = screen.getByRole("dialog", {
        name: "Playing Native fragment preservation movie",
      });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe(`${optimizedUrl}&t=0.001`));
      expect(fetchMock).toHaveBeenCalledWith(
        optimizedUrl,
        expect.objectContaining({ credentials: "include" }),
      );
      expect(hlsInstances).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for the native WebKit fragment seek without assigning currentTime", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=9",
      timelineOffsetSeconds: 9,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native gate movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      const player = screen.getByRole("dialog", { name: "Playing Native gate movie" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("/index.m3u8?quality=480p&start=9"));

      const video = player.querySelector("video.player-video") as HTMLVideoElement;
      const assignedTimes: number[] = [];
      let currentTime = 0;
      let readyState: number = HTMLMediaElement.HAVE_METADATA;
      let seeking = true;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { assignedTimes.push(value); },
        },
        duration: { configurable: true, value: Number.POSITIVE_INFINITY },
        paused: { configurable: true, value: true },
        readyState: { configurable: true, get: () => readyState },
        seeking: { configurable: true, get: () => seeking },
        seekable: {
          configurable: true,
          value: {
            length: 1,
            start: () => 0,
            end: () => Number.POSITIVE_INFINITY,
          },
        },
      });
      vi.mocked(HTMLMediaElement.prototype.play).mockClear();

      fireEvent.loadedMetadata(video);
      expect(assignedTimes).toEqual([]);
      expect(within(player).getByRole("status").textContent).toContain("Synchronizing playback");

      currentTime = 9;
      readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      seeking = false;
      fireEvent.loadedData(video);
      expect(assignedTimes).toEqual([]);
      expect(within(player).getByRole("status").textContent).toContain("Synchronizing playback");

      currentTime = 0.001;
      seeking = true;
      fireEvent.seeking(video);
      fireEvent.loadedData(video);
      expect(within(player).getByRole("status").textContent).toContain("Synchronizing playback");

      seeking = false;
      fireEvent.seeked(video);
      expect(within(player).queryByText("Synchronizing playback…")).toBeNull();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores Device Original when an exact native HLS handoff fails", async () => {
    deviceKindMock.mockReturnValue("ios");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=9",
      timelineOffsetSeconds: 9,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Native fallback movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      const player = screen.getByRole("dialog", { name: "Playing Native fallback movie" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("#t=0.001"));

      fireMediaError(player.querySelector("video.player-video") as HTMLVideoElement);
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe("https://server.example/api/stream/session-1"));
      expect(recordDiagnosticMock).toHaveBeenCalledWith(
        "player",
        "server_optimized.handoff_failed",
        "warning",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not complete exact handoff before current data or while a seek is active", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=4",
      timelineOffsetSeconds: 4,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          startPositionSeconds={9}
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );

      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      let readyState: number = HTMLMediaElement.HAVE_METADATA;
      let seeking = false;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        duration: { configurable: true, value: 12 },
        paused: { configurable: true, value: true },
        readyState: { configurable: true, get: () => readyState },
        seeking: { configurable: true, get: () => seeking },
      });

      fireEvent.loadedMetadata(video);
      expect(currentTime).toBe(5);
      fireEvent.progress(video);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");

      readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      seeking = true;
      fireEvent.seeking(video);
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");

      seeking = false;
      fireEvent.loadedData(video);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("paused native HLS seek confirmation", () => {
    const nativeHlsSeekConfirmTimeoutMs = 1_200;
    const press = (key: string) => {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    };

    async function setupNativePausedSeek(
      acceptAssignments: boolean,
      initialPlaybackRate = 1.25,
    ) {
      deviceKindMock.mockReturnValue("ios");
      (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
        () => "probably",
      );
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
        url: `https://server.example/api/stream/session-2/index.m3u8?quality=480p&start=${position}&audio=${audioTrack}`,
        timelineOffsetSeconds: position,
        startPositionSeconds: 0,
        audioTrack,
        quality: "480p" as const,
      }));
      const view = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0&audio=1"
          engine="webview-hls-transcode"
          title="Paused native HLS"
          startPositionSeconds={0}
          initialHandoffState={{
            paused: true,
            volume: 0.6,
            muted: false,
            playbackRate: initialPlaybackRate,
          }}
          serverOptimized={{
            qualities: ["720p", "480p"],
            loadSourceInfo: async () => ({
              durationSeconds: 30,
              tracks: [
                { index: 0, language: "eng", label: "English", default: true },
                { index: 1, language: "jpn", label: "Japanese", default: false },
              ],
            }),
            request,
          }}
          onClose={() => {}}
        />,
      );
      const player = screen.getByRole("dialog", { name: "Playing Paused native HLS" });
      await waitFor(() => expect(
        (player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("#t=0.001"));
      await waitFor(() => expect(screen.getByTestId("scrub-bar")).toHaveAttribute(
        "data-duration",
        "30",
      ));
      const video = player.querySelector("video.player-video") as HTMLVideoElement;
      const assigned: number[] = [];
      let currentTime = 0.001;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (next: number) => {
            assigned.push(next);
            if (acceptAssignments) currentTime = next;
          },
        },
        duration: { configurable: true, value: 30 },
        paused: { configurable: true, value: true },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        seeking: { configurable: true, value: false },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 30 },
        },
      });
      video.volume = 0.6;
      video.muted = false;
      video.defaultPlaybackRate = initialPlaybackRate;
      video.playbackRate = initialPlaybackRate;
      fireEvent.loadedMetadata(video);
      fireEvent.seeked(video);
      vi.mocked(HTMLMediaElement.prototype.play).mockClear();
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
      return {
        assigned,
        player,
        request,
        setCurrentTime: (next: number) => { currentTime = next; },
        video,
        view,
      };
    }

    it("recovers one ignored paused seek at the exact target without playing the stale origin", async () => {
      const probe = await setupNativePausedSeek(false);
      probe.setCurrentTime(0);
      vi.useFakeTimers();

      press("3");
      expect(probe.assigned.at(-1)).toBe(9);
      fireEvent.seeked(probe.video);
      fireEvent.timeUpdate(probe.video);
      press(" ");
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });
      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(probe.request).toHaveBeenCalledWith("480p", 9, 1);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      vi.useRealTimers();
      await waitFor(() => expect(
        (probe.player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("start=9&audio=1#t=0.001"));
      const replacement = probe.player.querySelector("video.player-video") as HTMLVideoElement;
      expect(replacement).not.toBe(probe.video);
      expect(replacement.volume).toBeCloseTo(0.6);
      expect(replacement.playbackRate).toBe(1.25);
      expect(replacement.paused).toBe(true);
      expect(within(probe.player).getByRole("button", { name: "Pause" })).toBeInTheDocument();

      Object.defineProperties(replacement, {
        currentTime: { configurable: true, value: 0.001, writable: true },
        duration: { configurable: true, value: 21 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        seeking: { configurable: true, value: false },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 21 },
        },
      });
      fireEvent.seeked(replacement);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
      expect(probe.request).toHaveBeenCalledTimes(1);
    });

    it("keeps the latest speed and its control in sync across a paused fallback replacement", async () => {
      const probe = await setupNativePausedSeek(false, 1);
      probe.setCurrentTime(0);
      Object.defineProperties(probe.video, {
        defaultPlaybackRate: { configurable: true, value: 1, writable: true },
        playbackRate: { configurable: true, value: 1, writable: true },
      });
      probe.video.volume = 0.35;
      probe.video.muted = true;
      fireEvent.volumeChange(probe.video);
      vi.useFakeTimers();

      press("3");
      press(">");
      press(" ");
      expect(probe.video.playbackRate).toBe(1.25);
      expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1.25");
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });
      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(probe.request).toHaveBeenCalledWith("480p", 9, 1);

      vi.useRealTimers();
      await waitFor(() => expect(
        (probe.player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("start=9&audio=1#t=0.001"));
      const replacement = probe.player.querySelector("video.player-video") as HTMLVideoElement;
      expect(replacement).not.toBe(probe.video);

      expect(replacement.volume).toBeCloseTo(0.35);
      expect(replacement.muted).toBe(true);
      expect(replacement.playbackRate).toBe(1.25);
      expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1.25");
      expect(replacement.paused).toBe(true);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      Object.defineProperties(replacement, {
        currentTime: { configurable: true, value: 0.001, writable: true },
        duration: { configurable: true, value: 21 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        seeking: { configurable: true, value: false },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 21 },
        },
      });
      fireEvent.seeked(replacement);

      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
      expect(replacement.playbackRate).toBe(1.25);
      expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1.25");
      expect(probe.request).toHaveBeenCalledTimes(1);

      Object.defineProperties(replacement, {
        defaultPlaybackRate: { configurable: true, value: 1.25, writable: true },
        playbackRate: { configurable: true, value: 1.25, writable: true },
      });
      press(">");
      press(">");
      expect(replacement.playbackRate).toBe(1.75);
      expect(screen.getByRole("option", { name: "1.75×" })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1.75");
    });

    it("accepts an independently observed native seek without a server fallback", async () => {
      const probe = await setupNativePausedSeek(true);
      let seeking = true;
      Object.defineProperty(probe.video, "seeking", {
        configurable: true,
        get: () => seeking,
      });
      vi.useFakeTimers();

      press("3");
      expect(probe.assigned.at(-1)).toBe(9);
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
      fireEvent.timeUpdate(probe.video);
      press(" ");
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      seeking = false;
      fireEvent.seeked(probe.video);
      expect(within(probe.player).queryByText("Synchronizing playback…")).toBeNull();
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs * 2);
      expect(probe.request).not.toHaveBeenCalled();
    });

    it("accepts a stable nonseeking readback at the deadline when WebKit omits events", async () => {
      const probe = await setupNativePausedSeek(true);
      vi.useFakeTimers();

      press("3");
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });
      expect(probe.request).not.toHaveBeenCalled();
      expect(within(probe.player).queryByText("Synchronizing playback…")).toBeNull();
    });

    it("falls back when the deadline readback lacks decoded media readiness", async () => {
      const probe = await setupNativePausedSeek(true);
      Object.defineProperty(probe.video, "readyState", {
        configurable: true,
        value: HTMLMediaElement.HAVE_METADATA,
      });
      vi.useFakeTimers();

      press("3");
      expect(probe.assigned.at(-1)).toBe(9);
      press(" ");
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });

      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(probe.request).toHaveBeenCalledWith("480p", 9, 1);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it("releases a failed recovery without playing and allows a later explicit play", async () => {
      const probe = await setupNativePausedSeek(false);
      probe.request.mockRejectedValueOnce(new Error("seek recovery rejected"));
      probe.setCurrentTime(0);
      vi.useFakeTimers();

      press("3");
      press(" ");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });

      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(within(probe.player).queryByText("Synchronizing playback…")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent("seek recovery rejected");
      fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

      press(" ");
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    });

    it("releases a refused recovery while another playback change is pending", async () => {
      const probe = await setupNativePausedSeek(false);
      const ordinary = deferred<{
        url: string;
        timelineOffsetSeconds: number;
        startPositionSeconds: number;
        audioTrack: number | undefined;
        quality: "480p";
      }>();
      probe.request.mockImplementationOnce(() => ordinary.promise);
      probe.setCurrentTime(0);

      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "720p" }));
      await act(async () => Promise.resolve());
      expect(probe.request).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
      vi.useFakeTimers();

      press("3");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });

      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(within(probe.player).queryByText("Synchronizing playback…")).toBeNull();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Another playback change is still being prepared. Try seeking again.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

      press("4");
      expect(probe.assigned.at(-1)).toBe(12);
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
    });

    it("lets the newest seek supersede stale confirmation and fallback work", async () => {
      const probe = await setupNativePausedSeek(false);
      const first = deferred<{
        url: string;
        timelineOffsetSeconds: number;
        startPositionSeconds: number;
        audioTrack: number | undefined;
        quality: "480p";
      }>();
      const second = deferred<{
        url: string;
        timelineOffsetSeconds: number;
        startPositionSeconds: number;
        audioTrack: number | undefined;
        quality: "480p";
      }>();
      probe.request
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      probe.setCurrentTime(0);
      vi.useFakeTimers();

      press("3");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });
      expect(probe.request).toHaveBeenNthCalledWith(1, "480p", 9, 1);

      press("6");
      probe.setCurrentTime(9);
      fireEvent.seeked(probe.video);
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs);
      });
      expect(probe.request).toHaveBeenCalledTimes(2);
      expect(probe.request).toHaveBeenNthCalledWith(2, "480p", 18, 1);

      await act(async () => {
        first.resolve({
          url: "https://server.example/api/stream/stale/index.m3u8?quality=480p&start=9&audio=1",
          timelineOffsetSeconds: 9,
          startPositionSeconds: 0,
          audioTrack: 1,
          quality: "480p",
        });
        await first.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
      press(" ");
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      await act(async () => {
        second.resolve({
          url: "https://server.example/api/stream/current/index.m3u8?quality=480p&start=18&audio=1",
          timelineOffsetSeconds: 18,
          startPositionSeconds: 0,
          audioTrack: 1,
          quality: "480p",
        });
        await second.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      vi.useRealTimers();
      await waitFor(() => expect(
        (probe.player.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toContain("/current/index.m3u8?quality=480p&start=18&audio=1"));
      expect((probe.player.querySelector("video.player-video") as HTMLVideoElement).src)
        .not.toContain("/stale/");
    });

    it("supersedes an ignored in-window seek with the latest committed out-of-window target", async () => {
      const probe = await setupNativePausedSeek(false);
      const replacement = deferred<{
        url: string;
        timelineOffsetSeconds: number;
        startPositionSeconds: number;
        audioTrack: number | undefined;
        quality: "480p";
      }>();
      probe.request.mockImplementationOnce(() => replacement.promise);
      Object.defineProperty(probe.video, "seekable", {
        configurable: true,
        value: { length: 1, start: () => 0, end: () => 15 },
      });
      probe.setCurrentTime(0);
      vi.useFakeTimers();

      press("3");
      press(" ");
      const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
      if (scrub == null) throw new Error("Scrub bar props were not captured");
      if (scrub.onSeekPreview == null) throw new Error("Scrub preview was not captured");
      act(() => scrub.onSeekPreview?.(24));
      expect(probe.request).not.toHaveBeenCalled();

      press("8");
      await act(async () => Promise.resolve());
      expect(probe.request).toHaveBeenCalledTimes(1);
      expect(probe.request).toHaveBeenCalledWith("480p", 24, 1);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs * 2);
      expect(probe.request).toHaveBeenCalledTimes(1);
    });

    it("invalidates the confirmation deadline when the player is torn down", async () => {
      const probe = await setupNativePausedSeek(false);
      vi.useFakeTimers();
      press("3");
      expect(within(probe.player).getByRole("status")).toHaveTextContent(
        "Synchronizing playback",
      );
      probe.view.unmount();
      await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs * 2);
      expect(probe.request).not.toHaveBeenCalled();
    });

    it.each([
      ["ordinary MP4", "https://server.example/movie.mp4"],
      ["hls.js", "https://server.example/api/stream/session-1/index.m3u8?quality=480p"],
    ])("leaves %s paused seeks on their existing local path", async (_label, url) => {
      deviceKindMock.mockReturnValue("mac");
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const request = vi.fn(async () => ({
        url: "https://server.example/api/stream/replacement/index.m3u8?quality=480p&start=9",
        timelineOffsetSeconds: 9,
        startPositionSeconds: 0,
        quality: "480p" as const,
      }));
      render(
        <VideoPlayer
          url={url}
          title="Unaffected local seek"
          serverOptimized={{
            qualities: ["480p"],
            loadSourceInfo: async () => ({ durationSeconds: 30 }),
            request,
          }}
          onClose={() => {}}
        />,
      );
      if (url.endsWith("480p")) await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (next: number) => { currentTime = next; },
        },
        duration: { configurable: true, value: 30 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 30 },
        },
      });
      await waitFor(() => expect(screen.getByTestId("scrub-bar")).toHaveAttribute(
        "data-duration",
        "30",
      ));
      vi.useFakeTimers();
      press("3");
      expect(currentTime).toBe(9);
      await vi.advanceTimersByTimeAsync(nativeHlsSeekConfirmTimeoutMs * 2);
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("loads server audio inventory and restarts the owned optimized stream at the current position", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "fra", label: "French", default: false },
    ]);
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}&audio=${audioTrack}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
          onProgress={onProgress}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(video, "currentTime", { configurable: true, value: 42 });
      Object.defineProperty(video, "paused", { configurable: true, value: true });

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "French" }));

      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 42, 1));
      await waitFor(() => expect(hlsInstances.some((instance) =>
        instance.loadSource.mock.calls.some(([source]) => String(source).includes("audio=1")),
      )).toBe(true));
      const switchedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(switchedVideo, "currentTime", { configurable: true, value: 0 });
      Object.defineProperty(switchedVideo, "duration", { configurable: true, value: 100 });
      markCurrentMediaDataReady(switchedVideo);
      fireEvent.durationChange(switchedVideo);
      fireEvent.canPlay(switchedVideo);
      fireEvent.timeUpdate(switchedVideo);
      expect(onProgress).toHaveBeenLastCalledWith(
        expect.any(Number),
        142,
        expect.objectContaining({ preferredAudioId: "1", preferredAudioLang: "fra" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps confirmed semantic audio metadata through a same-track quality switch", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "fra", label: "French", default: false },
    ]);
    const request = vi.fn(async (
      quality: ServerTranscodeQuality,
      position: number,
      audioTrack?: number,
    ) => ({
      url: `https://server.example/api/stream/session-${String(request.mock.calls.length)}/index.m3u8?quality=${quality}&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality,
      audioTrack,
    }));
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-0/index.m3u8?quality=480p&audio=0"
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p", "720p"],
          defaultQuality: "480p",
          loadAudioTracks,
          request,
        }}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    const initialVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "French" }));
    await waitFor(() => expect(request).toHaveBeenNthCalledWith(1, "480p", 0, 1));
    const frenchVideo = await waitFor(() => {
      const current = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(current).not.toBe(initialVideo);
      return current;
    });

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "720p" }));
    await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "720p", 0, 1));
    const qualityVideo = await waitFor(() => {
      const current = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(current).not.toBe(frenchVideo);
      return current;
    });
    Object.defineProperties(qualityVideo, {
      currentTime: { configurable: true, value: 0 },
      duration: { configurable: true, value: 100 },
    });
    markCurrentMediaDataReady(qualityVideo);
    fireEvent.loadedData(qualityVideo);
    const reportClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    fireEvent.timeUpdate(qualityVideo);
    reportClock.mockRestore();

    expect(onProgress).toHaveBeenLastCalledWith(
      0,
      100,
      expect.objectContaining({ preferredAudioId: "1", preferredAudioLang: "fra" }),
    );
  });

  it("finishes a deferred server inventory when its inline loader identity changes", async () => {
    const inventory = deferred<Array<{
      index: number;
      language: string;
      label: string;
      default: boolean;
    }>>();
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack: 0,
    }));
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks: () => inventory.promise,
          request,
        }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByText("Loading audio tracks…")).toBeInTheDocument();

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks: () => inventory.promise,
          request,
        }}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      inventory.resolve([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
      await inventory.promise;
    });
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    expect(screen.queryByText("Loading audio tracks…")).toBeNull();
  });

  it("places the functional Audio track section before Video fit and Zoom", async () => {
    const loadAudioTracks = vi.fn()
      .mockRejectedValueOnce(new Error("probe unavailable"))
      .mockResolvedValueOnce([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await screen.findByText("Audio track inventory is temporarily unavailable.");
    const dialog = screen.getByRole("dialog", { name: "Playback settings" });
    const audio = within(dialog).getByText("Audio track").closest<HTMLElement>(".player-options-section");
    const fit = within(dialog).getByText("Video fit").closest<HTMLElement>(".player-options-section");
    const zoom = within(dialog).getByText("Zoom").closest<HTMLElement>(".player-options-section");
    expect(audio).not.toBeNull();
    expect(fit).not.toBeNull();
    expect(zoom).not.toBeNull();
    expect(
      audio!.compareDocumentPosition(fit!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      audio!.compareDocumentPosition(zoom!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.click(within(audio!).getByRole("button", { name: "Retry audio tracks" }));
    expect(await within(audio!).findByRole("button", { name: "French" })).toBeInTheDocument();
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
  });

  it("retries failed server audio inventory only after one explicit gesture", async () => {
    const replacement = deferred<Array<{
      index: number;
      language: string;
      label: string;
      default: boolean;
    }>>();
    const loadAudioTracks = vi.fn()
      .mockRejectedValueOnce(new Error("probe unavailable"))
      .mockImplementationOnce(() => replacement.promise);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(await screen.findByText("Audio track inventory is temporarily unavailable.")).toBeInTheDocument();
    expect(loadAudioTracks.mock.calls).toEqual([[]]);

    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(loadAudioTracks).toHaveBeenCalledTimes(1);

    const retry = screen.getByRole("button", { name: "Retry audio tracks" });
    act(() => {
      retry.click();
      retry.click();
    });
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
    expect(loadAudioTracks.mock.calls[0]).toEqual([]);
    expect(loadAudioTracks.mock.calls[1]?.[0]).toMatchObject({
      retryFailed: true,
      signal: expect.any(AbortSignal),
      onSourceInfo: expect.any(Function),
    });
    expect(screen.getByText("Loading audio tracks…")).toBeInTheDocument();

    await act(async () => {
      replacement.resolve([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
      await replacement.promise;
    });
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry audio tracks" })).toBeNull();
  });

  it("adopts duration and tracks from the current owner's single explicit retry response", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const replacement = deferred<ServerAudioTrack[]>();
    let retryOptions: ServerAudioInventoryLoadOptions | undefined;
    const loadAudioTracks = vi.fn((options?: ServerAudioInventoryLoadOptions) => {
      if (loadAudioTracks.mock.calls.length === 1) {
        return Promise.reject(new Error("probe unavailable"));
      }
      retryOptions = options;
      return replacement.promise;
    });
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        engine="webview-hls-transcode"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: Number.POSITIVE_INFINITY,
    });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 3 });
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:03 / --:--");

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await screen.findByText("Audio track inventory is temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    expect(retryOptions).toMatchObject({
      retryFailed: true,
      signal: expect.any(AbortSignal),
      onSourceInfo: expect.any(Function),
    });
    expect(retryOptions?.signal?.aborted).toBe(false);

    const tracks: ServerAudioTrack[] = [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "fra", label: "French", default: false },
    ];
    await act(async () => {
      retryOptions?.onSourceInfo?.({
        tracks,
        durationSeconds: 596.457379,
      });
      replacement.resolve(tracks);
      await replacement.promise;
    });

    expect(document.querySelector(".player-time")).toHaveTextContent("0:03 / 9:56");
    expect(screen.getByTestId("scrub-bar").getAttribute("data-duration")).toBe("596.457379");
    expect(await screen.findByRole("button", { name: "French" })).toBeInTheDocument();
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts a retry owner that changes and ignores its late metadata", async () => {
    const stale = deferred<ServerAudioTrack[]>();
    let staleOptions: ServerAudioInventoryLoadOptions | undefined;
    const firstLoad = vi.fn((options?: ServerAudioInventoryLoadOptions) => {
      if (firstLoad.mock.calls.length === 1) {
        return Promise.reject(new Error("probe unavailable"));
      }
      staleOptions = options;
      return stale.promise;
    });
    const currentLoad = vi.fn(async () => [] as ServerAudioTrack[]);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-a/index.m3u8"
        sourceRevision={1}
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks: firstLoad, request }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await screen.findByText("Audio track inventory is temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    expect(staleOptions?.signal?.aborted).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/session-b/index.m3u8"
        sourceRevision={2}
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks: currentLoad, request }}
        onClose={() => {}}
      />,
    );
    expect(staleOptions?.signal?.aborted).toBe(true);
    await act(async () => {
      staleOptions?.onSourceInfo?.({
        tracks: [{ index: 0, language: "old", label: "Old owner", default: true }],
        durationSeconds: 600,
      });
      stale.resolve([{ index: 0, language: "old", label: "Old owner", default: true }]);
      await stale.promise;
    });
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / --:--");
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.queryByRole("button", { name: "Old owner" })).toBeNull();
  });

  it("keeps known duration when an explicit retry reports null with a successful empty inventory", async () => {
    let retryOptions: ServerAudioInventoryLoadOptions | undefined;
    let loadAttempts = 0;
    const loadAudioTracks = vi.fn((options?: ServerAudioInventoryLoadOptions) => {
      loadAttempts += 1;
      if (loadAttempts === 1) {
        return Promise.reject(new Error("probe unavailable"));
      }
      retryOptions = options;
      options?.onSourceInfo?.({ tracks: [], durationSeconds: null });
      return Promise.resolve([]);
    });
    const loadSourceInfo = vi.fn(async () => ({ durationSeconds: 600 }));
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks,
          loadSourceInfo,
          request,
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(document.querySelector(".player-time")).toHaveTextContent(
      "0:00 / 10:00",
    ));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await screen.findByText("Audio track inventory is temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    await waitFor(() => expect(retryOptions?.retryFailed).toBe(true));
    expect(await screen.findByText(
      "This stream does not report selectable audio tracks.",
    )).toBeInTheDocument();
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / 10:00");
    expect(screen.queryByRole("button", { name: "Retry audio tracks" })).toBeNull();
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed explicit audio retry terminal without starting a loop", async () => {
    const loadAudioTracks = vi.fn(async () => {
      throw new Error("probe unavailable");
    });
    const loadSourceInfo = vi.fn(async () => ({ durationSeconds: 600 }));
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks,
          loadSourceInfo,
          request,
        }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(document.querySelector(".player-time")).toHaveTextContent(
      "0:00 / 10:00",
    ));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await screen.findByText("Audio track inventory is temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    await waitFor(() => expect(loadAudioTracks).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Audio track inventory is temporarily unavailable.")).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / 10:00");

    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(loadAudioTracks).toHaveBeenCalledTimes(2);
  });

  it("treats a successful empty server inventory as known instead of retryable", async () => {
    const loadAudioTracks = vi.fn(async () => []);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(await screen.findByText("This stream does not report selectable audio tracks.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry audio tracks" })).toBeNull();
    expect(loadAudioTracks.mock.calls).toEqual([[]]);
  });

  it("ignores stale audio inventory when the playback owner changes", async () => {
    const first = deferred<Array<{
      index: number;
      language: string;
      label: string;
      default: boolean;
    }>>();
    const second = deferred<Array<{
      index: number;
      language: string;
      label: string;
      default: boolean;
    }>>();
    const firstLoad = vi.fn(() => first.promise);
    const secondLoad = vi.fn(() => second.promise);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        engine="webview-direct"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks: firstLoad, request }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(firstLoad).toHaveBeenCalledTimes(1);

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        engine="webview-hls-transcode"
        title="T"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks: secondLoad, request }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(secondLoad).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve([
        { index: 0, language: "eng", label: "Old owner", default: true },
      ]);
      await first.promise;
    });
    expect(screen.queryByRole("button", { name: "Old owner" })).toBeNull();

    await act(async () => {
      second.resolve([
        { index: 0, language: "fra", label: "Current owner", default: true },
      ]);
      await second.promise;
    });
    expect(await screen.findByRole("button", { name: "Current owner" })).toBeInTheDocument();
  });

  it("uses the server-reported non-first default audio after optimized activation", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack: 0,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", {
      status: 200,
      headers: { "x-yawf-transcode-audio": "1" },
    })));
    const onProgress = vi.fn();
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        title="T"
        serverOptimized={{
          qualities: ["480p"],
          defaultQuality: "480p",
          loadAudioTracks: async () => [
            { index: 0, language: "eng", label: "English", default: false },
            { index: 1, language: "fra", label: "French", default: true },
          ],
          request,
        }}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0));
    await waitFor(() => expect(hlsInstances.some((instance) =>
      instance.loadSource.mock.calls.some(([source]) => String(source).includes("quality=480p")),
    )).toBe(true));
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 0 });
    markCurrentMediaDataReady(video);
    fireEvent.durationChange(video);
    fireEvent.canPlay(video);
    fireEvent.timeUpdate(video);
    expect(onProgress).toHaveBeenLastCalledWith(
      0,
      100,
      expect.objectContaining({ preferredAudioId: "1", preferredAudioLang: null }),
    );
  });

  it.each([
    "metadata-before-inventory",
    "inventory-before-metadata-before-activation",
    "inventory-and-activation-before-metadata",
    "ordinary-resume-before-metadata",
    "ordinary-clock-before-activation",
    "zero-during-preparation",
    "backward-during-preparation",
    "backward-before-clock-during-preparation",
    "zero-before-clock-during-preparation",
    "rebased-handoff-before-metadata",
    "zero-offset-generation-before-metadata",
    "ordinary-rebased-completed-before-metadata",
    "ordinary-unknown-duration-before-metadata",
    "ordinary-completed-before-metadata",
    "startup-zero-before-inventory",
    "ordinary-zero-before-inventory",
    "resume-then-zero-before-inventory",
    "pending-play-intent-before-metadata",
    "advance-during-preparation",
  ] as const)("preserves startup position and remembered audio intent: %s", async (order) => {
    deviceKindMock.mockReturnValue("ios");
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockImplementation((type) =>
      type === "application/vnd.apple.mpegurl" ? "probably" : "",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const ordinary = order.startsWith("ordinary-");
    const completed = order === "ordinary-completed-before-metadata";
    const explicitZero = order === "startup-zero-before-inventory" ||
      order === "ordinary-zero-before-inventory" || order === "resume-then-zero-before-inventory" ||
      order === "zero-during-preparation" || order === "zero-before-clock-during-preparation";
    const backwardPreparation = order === "zero-during-preparation" || order === "backward-during-preparation" ||
      order === "backward-before-clock-during-preparation" || order === "zero-before-clock-during-preparation";
    const backwardTarget = order === "zero-during-preparation" || order === "zero-before-clock-during-preparation" ? 0 : 5;
    const wantsPlay = order === "pending-play-intent-before-metadata";
    const offset = order.includes("rebased") ? 10 : 0;
    const expectedPosition = completed || order === "ordinary-rebased-completed-before-metadata" ? offset : explicitZero ? 0 : order === "advance-during-preparation" ? 18 : 16 + offset;
    const tracks = [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese", default: false },
    ] satisfies ServerAudioTrack[];
    const inventory = deferred<{ durationSeconds: number | null; tracks: ServerAudioTrack[] }>();
    const loadSourceInfo = vi.fn(() => inventory.promise);
    const prepared = deferred<{
      url: string; timelineOffsetSeconds: number; startPositionSeconds: number;
      quality: "480p"; audioTrack: number;
    }>();
    const request = vi.fn((_quality: ServerTranscodeQuality, _position: number, _audio?: number) => prepared.promise);
    const master = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS=\"avc1.4d401f,mp4a.40.2\"\n480p.m3u8?generation=transcode-audio69\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(master, {
      status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", "x-yawf-transcode-audio": "1" },
    })));
    const onProgress = vi.fn();
    render(<VideoPlayer
      url="https://server.example/api/stream/session-1"
      engine="webview-direct"
      title="Paused remembered audio"
      startPositionSeconds={completed ? 31 : 16}
      timelineOffsetSeconds={offset}
      initialHandoffState={ordinary ? null : { paused: !wantsPlay, volume: 0.35, muted: true, playbackRate: 1.25 }}
      savedPrefs={{ preferredAudioId: "1", preferredAudioLang: "jpn" }}
      serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
      onProgress={onProgress}
      onClose={() => {}}
    />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    // Model only public media observations. Before metadata, duration is unknown
    // and currentTime is 0. Native HLS applies the actual product temporal fragment.
    const media = (video: HTMLVideoElement, duration: number) => {
      // Queued metadata belongs to this resource even after its retired element
      // has been emptied. Do not reload or read a new URL from that old node.
      const mediaSource = video.src;
      let time = 0;
      let ready: number = HTMLMediaElement.HAVE_NOTHING;
      let knownDuration = Number.NaN;
      Object.defineProperties(video, {
        currentTime: { configurable: true, get: () => time, set: (value: number) => { time = value; } },
        duration: { configurable: true, get: () => knownDuration },
        readyState: { configurable: true, get: () => ready },
        paused: { configurable: true, value: true },
        seekable: { configurable: true, get: () => ({ length: ready > 0 ? 1 : 0, start: () => 0, end: () => duration }) },
      });
      return () => {
        knownDuration = duration;
        ready = HTMLMediaElement.HAVE_METADATA;
        const fragment = Number(new URL(mediaSource).hash.replace(/^#t=/, ""));
        if (mediaSource.includes("#t=")) time = fragment <= 0.001 ? 0 : fragment;
        fireEvent.loadedMetadata(video);
        ready = HTMLMediaElement.HAVE_CURRENT_DATA;
        fireEvent.loadedData(video);
        fireEvent.canPlay(video);
        fireEvent.seeked(video);
        fireEvent.timeUpdate(video);
      };
    };
    const originalMetadata = media(original, 36 - offset);
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(1));
    const metadataFirst = order === "metadata-before-inventory" ||
      order === "resume-then-zero-before-inventory" || order === "advance-during-preparation" ||
      order === "backward-during-preparation" || order === "backward-before-clock-during-preparation" ||
      order === "zero-before-clock-during-preparation";
    if (metadataFirst) originalMetadata();
    if (explicitZero && !backwardPreparation) {
      const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
      if (scrub == null) throw new Error("Scrub bar props were not captured");
      act(() => scrub.onSeek(0));
    }
    await act(async () => {
      inventory.resolve({ durationSeconds: order === "ordinary-unknown-duration-before-metadata" ? null : 36, tracks });
      await inventory.promise;
    });
    if (order === "ordinary-unknown-duration-before-metadata") {
      expect(request).not.toHaveBeenCalled();
      originalMetadata();
    }
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (order === "inventory-before-metadata-before-activation") originalMetadata();
    if (order === "ordinary-clock-before-activation") fireEvent.timeUpdate(original);
    if (backwardPreparation) {
      const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
      if (scrub == null) throw new Error("Scrub bar props were not captured");
      act(() => scrub.onSeek(backwardTarget));
      if (!order.includes("before-clock")) fireEvent.timeUpdate(original);
    }
    if (order === "advance-during-preparation") {
      original.currentTime = 18;
      fireEvent.timeUpdate(original);
    }
    const requestedPosition = request.mock.calls[0]![1];
    const preparedOffset = order === "zero-offset-generation-before-metadata" ? 0 : requestedPosition;
    const initialPlayCalls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    if (backwardPreparation) {
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByText("Preparing optimized playback while the current stream continues…")).toBeInTheDocument();
    }
    await act(async () => {
      prepared.resolve({
        url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${preparedOffset}&audio=1`,
        timelineOffsetSeconds: preparedOffset,
        startPositionSeconds: 0,
        quality: "480p", audioTrack: 1,
      });
      await prepared.promise;
    });
    if (backwardPreparation) {
      await waitFor(() => expect(screen.queryByText("Preparing optimized playback while the current stream continues…")).not.toBeInTheDocument());
      originalMetadata();
      expect(document.querySelector("video.player-video")).toBe(original);
      expect(original.currentTime).toBe(backwardTarget);
      if (order === "zero-during-preparation") expect(onProgress.mock.calls.at(-1)?.[0]).toBe(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(initialPlayCalls);
      return;
    }
    const switched = await waitFor(() => {
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(video).not.toBe(original);
      return video;
    });
    media(switched, 36 - preparedOffset)();
    if (wantsPlay) {
      Object.defineProperty(switched, "paused", { configurable: true, value: false });
      fireEvent.play(switched);
      fireEvent.timeUpdate(switched);
    }
    const source = switched.src;
    const progress = onProgress.mock.calls.at(-1);
    // A removed source may still dispatch queued native events. They must not
    // change the active source, position, request count, or retained audio.
    originalMetadata();
    expect(document.querySelector("video.player-video")).toBe(switched);
    expect(switched.src).toBe(source);
    expect(onProgress.mock.calls.at(-1)).toEqual(progress);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[2]).toBe(1);
    expect(hlsInstances).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(initialPlayCalls + (wantsPlay ? 1 : 0));
    expect(switched.paused).toBe(!wantsPlay);
    expect(switched.volume).toBeCloseTo(ordinary ? 1 : 0.35);
    expect(switched.muted).toBe(!ordinary);
    expect(switched.playbackRate).toBe(ordinary ? 1 : 1.25);
    if (completed || order === "ordinary-rebased-completed-before-metadata") expect(requestedPosition).toBe(offset);
    else if (explicitZero) expect(requestedPosition).toBe(0);
    else if (metadataFirst || order === "ordinary-unknown-duration-before-metadata") expect(requestedPosition).toBe(16);
    else expect([offset, 16 + offset]).toContain(requestedPosition);
    expect({
      requestedPosition,
      timelineOffset: Number(new URL(source).searchParams.get("start")),
      localPosition: switched.currentTime,
      localDuration: switched.duration,
      absolutePosition: progress?.[0],
      absoluteDuration: progress?.[1],
      audio: progress?.[2]?.preferredAudioLang,
    }).toEqual({
      requestedPosition,
      timelineOffset: preparedOffset,
      localPosition: expectedPosition - preparedOffset,
      localDuration: 36 - preparedOffset,
      absolutePosition: expectedPosition,
      absoluteDuration: 36,
      audio: "jpn",
    });
  });

  describe("failed optimized audio recovery intent fence", () => {
    const resumePosition = 54.817215;
    const originalUrl = "https://server.example/api/stream/recovery-original";
    const tracks = [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese", default: false },
    ];
    async function flushRecovery() {
      await act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); });
    }
    function readyOriginal(video: HTMLVideoElement) {
      Object.defineProperties(video, {
        duration: { configurable: true, value: 180 },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        paused: { configurable: true, value: true },
        seeking: { configurable: true, value: false },
        seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 180 } },
      });
      fireEvent.loadedMetadata(video);
      fireEvent.loadedData(video);
      fireEvent.seeked(video);
      fireEvent.timeUpdate(video);
    }
    async function setupRecovery(remembered = false) {
      deviceKindMock.mockReturnValue("ios");
      vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n", {
        headers: { "x-yawf-transcode-audio": new URL(String(input)).searchParams.get("audio") ?? "0" },
      })));
      const request = vi.fn(async (_quality: ServerTranscodeQuality, position: number, audioTrack?: number) => ({
        url: `https://server.example/api/stream/recovery-jp/index.m3u8?quality=480p&start=${position}${audioTrack == null ? "" : `&audio=${audioTrack}`}`,
        timelineOffsetSeconds: position,
        startPositionSeconds: 0,
        audioTrack,
        quality: "480p" as const,
      }));
      const loadSourceInfo = vi.fn(async () => ({ durationSeconds: 180, tracks }));
      const serverOptimized = { qualities: ["480p"] as ServerTranscodeQuality[], loadSourceInfo, request };
      const props = {
        url: originalUrl, title: "Recovery fixture", sourceFileName: "Synthetic.Fixture.Movie.mkv",
        startPositionSeconds: resumePosition,
        initialHandoffState: { paused: true, volume: 0.35, muted: true, playbackRate: 1.25 },
        savedPrefs: remembered ? { preferredAudioId: "1", preferredAudioLang: "jpn" } : undefined,
        serverOptimized, onClose: vi.fn(),
      };
      const view = render(<VideoPlayer {...props} />);
      const original = document.querySelector("video.player-video") as HTMLVideoElement;
      readyOriginal(original);
      await flushRecovery();
      if (!remembered) {
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
        await flushRecovery();
      }
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenLastCalledWith("480p", resumePosition, 1);
      const optimized = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimized).not.toBe(original);
      expect(optimized.src).toContain("/recovery-jp/index.m3u8");
      return { view, props, request, optimized };
    }

    it.each(["immediate-error", "startup-timeout", "deferred-default"])("restores once and blocks automatic remembered audio after %s", async (failure) => {
      vi.useFakeTimers();
      try {
        const { view, props, request, optimized } = await setupRecovery(failure === "deferred-default");
        if (failure === "deferred-default") view.rerender(<VideoPlayer {...props}
          serverOptimized={{ ...props.serverOptimized, defaultQuality: "480p" }} />);
        vi.mocked(HTMLMediaElement.prototype.play).mockClear();
        if (failure === "startup-timeout") {
          await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
        } else fireMediaError(optimized, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(1);
        const restored = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(restored).not.toBe(optimized);
        expect(restored.src).toBe(originalUrl);
        readyOriginal(restored);
        await flushRecovery();
        expect(restored.currentTime).toBeCloseTo(resumePosition, 6);
        expect(restored.volume).toBe(0.35);
        expect(restored.muted).toBe(true);
        expect(restored.playbackRate).toBe(1.25);
        expect(screen.getByText("Playback paused")).toBeInTheDocument();
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        fireEvent.pointerMove(restored);
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Device Original was restored");
        expect(screen.getByRole("button", { name: "Japanese" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "480p" })).toBeEnabled();
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(request).toHaveBeenCalledTimes(1);
        expect(document.querySelector("video.player-video")).toBe(restored);
        expect(recordDiagnosticMock.mock.calls.filter(([, code]) => code === "server_optimized.disabled")).toHaveLength(1);
      } finally { vi.useRealTimers(); }
    });

    it("allows one fresh explicit Japanese retry without erasing the failure fence intent", async () => {
      vi.useFakeTimers();
      try {
        const { request, optimized } = await setupRecovery();
        fireMediaError(optimized, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(1);
        const restored = document.querySelector("video.player-video") as HTMLVideoElement;
        readyOriginal(restored);
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Device Original was restored");
        fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("480p", resumePosition, 1);
        const retried = document.querySelector("video.player-video") as HTMLVideoElement;
        fireMediaError(retried, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe(originalUrl);
      } finally { vi.useRealTimers(); }
    });

    it("allows explicit playback Retry to reapply retained Japanese only once", async () => {
      vi.useFakeTimers();
      try {
        const { request, optimized } = await setupRecovery();
        fireMediaError(optimized, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(1);
        const restored = document.querySelector("video.player-video") as HTMLVideoElement;
        readyOriginal(restored);
        fireMediaError(restored, 4);
        fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("480p", resumePosition, 1);
        const retried = document.querySelector("video.player-video") as HTMLVideoElement;
        fireMediaError(retried, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
      } finally { vi.useRealTimers(); }
    });

    it("rejects a captured prior-attempt parent error callback after a newer attempt commits", async () => {
      vi.useFakeTimers();
      failureRefObserver.enabled = true;
      failureRefObserver.refs.length = 0;
      const captured = failureRefObserver.refs;
      try {
        const { request } = await setupRecovery();
        expect(captured).toHaveLength(2); // Original child, then optimized child.
        const previousRef = captured[1]!;
        const previousError = previousRef.current;
        expect(previousError).toEqual(expect.any(Function));
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect(captured).toHaveLength(3);
        const currentRef = captured[2]!;
        expect(currentRef).not.toBe(previousRef);
        const current = document.querySelector("video.player-video");
        await act(async () => { previousError("Previous attempt failed", true); });
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect(document.querySelector("video.player-video")).toBe(current);
        expect(screen.queryByText(/Device Original was restored/)).toBeNull();
        // The current callback still owns normal failure recovery and fencing.
        await act(async () => { currentRef.current("Current attempt failed", true); });
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe(originalUrl);
      } finally { failureRefObserver.enabled = false; vi.useRealTimers(); }
    });

    it("gives identical-URL manual attempts separate media ownership before old errors arrive", async () => {
      vi.useFakeTimers();
      try {
        const { request, optimized } = await setupRecovery();
        const optimizedSource = optimized.src;
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        const current = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(current.src).toBe(optimizedSource);
        expect(current).not.toBe(optimized);
        fireMediaError(optimized, 4);
        await flushRecovery();
        expect(document.querySelector("video.player-video")).toBe(current);
        expect(request).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(/Device Original was restored/)).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("releases a failed owner only for a genuinely committed new source", async () => {
      vi.useFakeTimers();
      try {
        const { view, props, request, optimized } = await setupRecovery();
        fireMediaError(optimized, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(1);
        view.rerender(<VideoPlayer {...props} url="https://server.example/api/stream/new-owner" sourceRevision={1} />);
        const nextOriginal = document.querySelector("video.player-video") as HTMLVideoElement;
        readyOriginal(nextOriginal);
        fireMediaError(optimized, 4);
        await flushRecovery();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("480p", resumePosition, 1);
        expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toContain("/recovery-jp/index.m3u8");
      } finally { vi.useRealTimers(); }
    });
  });

  it("restores remembered server audio and does not persist a failed switch", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "fra", label: "French", default: false },
    ]);
    const request = vi.fn().mockRejectedValue(new Error("transcode failed"));
    const onProgress = vi.fn();
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8"
        title="T"
        savedPrefs={{ preferredAudioId: "1", preferredAudioLang: "fra" }}
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request }}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));
    fireEvent.timeUpdate(document.querySelector("video.player-video") as HTMLVideoElement);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.any(Number),
      null,
      expect.objectContaining({ preferredAudioId: "0", preferredAudioLang: "eng" }),
    );
  });

  it("holds an automatic optimized handoff until the advancing target is exactly seekable", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const prepared = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    const request = vi.fn(() => prepared.promise);
    const fetchMock = vi.fn(async () => new Response("#EXTM3U\n", { status: 200 }));
    const onEnded = vi.fn();
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{
            qualities: ["480p"],
            defaultQuality: "480p",
            request,
          }}
          onEnded={onEnded}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0));
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      let originalTime = 25;
      Object.defineProperty(originalVideo, "duration", { configurable: true, get: () => 3_600 });
      Object.defineProperty(originalVideo, "currentTime", {
        configurable: true,
        get: () => originalTime,
        set: (value: number) => { originalTime = value; },
      });
      Object.defineProperty(originalVideo, "paused", {
        configurable: true,
        value: false,
      });
      fireEvent.timeUpdate(originalVideo);

      await act(async () => {
        prepared.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
          timelineOffsetSeconds: 0,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await prepared.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      let duration = 6;
      let clampLimit = 6;
      let optimizedTime = 0;
      Object.defineProperty(optimizedVideo, "duration", {
        configurable: true,
        get: () => duration,
      });
      Object.defineProperty(optimizedVideo, "currentTime", {
        configurable: true,
        get: () => optimizedTime,
        set: (value: number) => { optimizedTime = Math.min(value, clampLimit); },
      });
      play.mockClear();

      fireEvent.loadedMetadata(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      fireEvent.timeUpdate(optimizedVideo);
      expect(optimizedTime).toBe(0);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
      expect(play).not.toHaveBeenCalled();

      duration = 30;
      fireEvent.durationChange(optimizedVideo);
      expect(optimizedTime).toBe(6);
      fireEvent.canPlay(optimizedVideo);
      fireEvent.timeUpdate(optimizedVideo);
      fireEvent.ended(optimizedVideo);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
      expect(onEnded).not.toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();

      clampLimit = 30;
      fireEvent.progress(optimizedVideo);
      expect(optimizedTime).toBe(25);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.seeked(optimizedVideo);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers an explicit Play during exact handoff and resumes once the target is ready", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Deferred play movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(play).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      fireEvent.play(video);
      fireEvent.pause(video);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

      markCurrentMediaDataReady(video);
      fireEvent.loadedData(video);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the latest explicit Pause during a pending exact handoff", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Deferred pause movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 0, writable: true },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      markCurrentMediaDataReady(video);
      fireEvent.loadedData(video);

      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(play).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not carry pending exact-handoff Play intent into a superseding source", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      const { rerender } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={1}
          title="Superseded handoff movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const staleVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(staleVideo, {
        currentTime: { configurable: true, value: 0, writable: true },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      expect(play).not.toHaveBeenCalled();

      rerender(
        <VideoPlayer
          url="https://server.example/api/stream/session-2"
          sourceRevision={2}
          title="Superseded handoff movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const currentVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(currentVideo).not.toBe(staleVideo);
      markCurrentMediaDataReady(staleVideo);
      fireEvent.loadedData(staleVideo);

      expect(play).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies pending exact-handoff Play after cast suspension releases", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Cast handoff movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 0, writable: true },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
      markCurrentMediaDataReady(video);
      fireEvent.loadedData(video);
      expect(play).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "test resume playback" }));
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets a later explicit Pause override deferred cast handoff Play", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Cast pause movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 0, writable: true },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
      markCurrentMediaDataReady(video);
      fireEvent.loadedData(video);
      await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "test resume playback" }));
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears cast-deferred exact Play when a source is superseded", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      const { rerender } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={1}
          title="Cast supersession movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(hlsInstances).toHaveLength(1));
      const staleVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(staleVideo, {
        currentTime: { configurable: true, value: 0, writable: true },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
      markCurrentMediaDataReady(staleVideo);
      fireEvent.loadedData(staleVideo);
      expect(play).not.toHaveBeenCalled();

      rerender(
        <VideoPlayer
          url="https://server.example/api/stream/session-2"
          sourceRevision={2}
          title="Cast supersession movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      expect(document.querySelector("video.player-video")).not.toBe(staleVideo);
      fireEvent.click(screen.getByRole("button", { name: "test resume playback" }));

      expect(play).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("captures pause mute volume and speed when optimized playback actually activates", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const prepared = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    const request = vi.fn(() => prepared.promise);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      let originalPaused = false;
      Object.defineProperty(originalVideo, "paused", {
        configurable: true,
        get: () => originalPaused,
      });
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

      originalPaused = true;
      originalVideo.volume = 0.35;
      originalVideo.muted = true;
      originalVideo.playbackRate = 1.5;
      fireEvent.pause(originalVideo);
      fireEvent.volumeChange(originalVideo);
      fireEvent.rateChange(originalVideo);

      await act(async () => {
        prepared.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
          timelineOffsetSeconds: 0,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await prepared.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      await waitFor(() => {
        expect(optimizedVideo.volume).toBeCloseTo(0.35);
        expect(optimizedVideo.muted).toBe(true);
        expect(optimizedVideo.playbackRate).toBe(1.5);
      });
      Object.defineProperty(optimizedVideo, "duration", {
        configurable: true,
        value: 120,
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores Device Original at the owned target when exact optimized seek times out", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 3_600 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: false });
      originalVideo.currentTime = 25;
      fireEvent.canPlay(originalVideo);
      fireEvent.timeUpdate(originalVideo);

      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      Object.defineProperty(optimizedVideo, "duration", { configurable: true, value: 6 });
      Object.defineProperty(optimizedVideo, "currentTime", {
        configurable: true,
        get: () => 0,
        set: () => {},
      });
      fireEvent.loadedMetadata(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");

      await act(async () => {
        vi.advanceTimersByTime(45_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      const restoredVideo = document.querySelector<HTMLVideoElement>("video.player-video");
      expect(restoredVideo).not.toBeNull();
      if (restoredVideo == null) throw new Error("Device Original was not restored");
      expect(restoredVideo).not.toBe(optimizedVideo);
      expect(restoredVideo.src).toBe("https://server.example/api/stream/session-1");
      expect(screen.queryByText("Playback interrupted")).toBeNull();
      Object.defineProperty(restoredVideo, "duration", { configurable: true, value: 3_600 });
      Object.defineProperty(restoredVideo, "paused", { configurable: true, value: true });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(restoredVideo);
      expect(restoredVideo.currentTime).toBe(25);
      markCurrentMediaDataReady(restoredVideo);
      fireEvent.seeked(restoredVideo);
      expect(play).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(restoredVideo);
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Server Optimized could not synchronize. Device Original was restored.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("after synchronization");
      expect(screen.getByRole("button", { name: "Device Original" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("preserves pause when an unreachable optimized handoff falls back after 45 seconds", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 3_600 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: true });
      originalVideo.currentTime = 25;
      fireEvent.canPlay(originalVideo);
      fireEvent.timeUpdate(originalVideo);

      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      Object.defineProperty(optimizedVideo, "duration", { configurable: true, value: 6 });
      Object.defineProperty(optimizedVideo, "paused", { configurable: true, value: true });
      Object.defineProperty(optimizedVideo, "currentTime", {
        configurable: true,
        get: () => 0,
        set: () => {},
      });
      fireEvent.loadedMetadata(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");

      await act(async () => {
        vi.advanceTimersByTime(45_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      const restoredVideo = document.querySelector<HTMLVideoElement>("video.player-video");
      expect(restoredVideo).not.toBeNull();
      if (restoredVideo == null) throw new Error("Device Original was not restored");
      expect(restoredVideo.src).toBe("https://server.example/api/stream/session-1");
      Object.defineProperty(restoredVideo, "duration", { configurable: true, value: 3_600 });
      Object.defineProperty(restoredVideo, "paused", { configurable: true, value: true });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(restoredVideo);

      expect(restoredVideo.currentTime).toBe(25);
      expect(play).not.toHaveBeenCalled();
      fireEvent.pointerMove(restoredVideo);
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Server Optimized could not synchronize. Device Original was restored.",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("restores Device Original with a user pause made after exact optimized sync", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 395,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onProgress={onProgress}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: false });
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 533 });
      originalVideo.currentTime = 395;
      fireEvent.loadedMetadata(originalVideo);
      fireEvent.canPlay(originalVideo);
      fireEvent.timeUpdate(originalVideo);
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      let optimizedPaused = false;
      Object.defineProperty(optimizedVideo, "paused", {
        configurable: true,
        get: () => optimizedPaused,
      });
      Object.defineProperty(optimizedVideo, "duration", { configurable: true, value: 120 });
      optimizedVideo.currentTime = 0;
      fireEvent.loadedMetadata(optimizedVideo);
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      fireEvent.seeked(optimizedVideo);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();

      optimizedVideo.currentTime = 12;
      fireEvent.timeUpdate(optimizedVideo);
      optimizedPaused = true;
      fireEvent.pause(optimizedVideo);
      const errorRegistration = hlsInstances.at(-1)?.on.mock.calls.find(
        ([event]) => event === "hlsError",
      );
      if (errorRegistration == null) throw new Error("HLS error handler missing");
      const handleHlsError = errorRegistration[1] as (
        event: string,
        data: { fatal: boolean; type: string },
      ) => void;
      act(() => handleHlsError("hlsError", { fatal: true, type: "mediaError" }));
      act(() => handleHlsError("hlsError", { fatal: true, type: "mediaError" }));

      const restoredVideo = document.querySelector<HTMLVideoElement>("video.player-video");
      expect(restoredVideo).not.toBeNull();
      if (restoredVideo == null) throw new Error("Device Original was not restored");
      expect(restoredVideo).not.toBe(optimizedVideo);
      Object.defineProperty(restoredVideo, "duration", { configurable: true, value: Number.NaN });
      Object.defineProperty(restoredVideo, "paused", { configurable: true, value: true });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(restoredVideo);
      expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / 8:53");
      Object.defineProperty(restoredVideo, "duration", { configurable: true, value: 533 });
      fireEvent.durationChange(restoredVideo);
      expect(restoredVideo.currentTime).toBe(407);
      markCurrentMediaDataReady(restoredVideo);
      fireEvent.seeked(restoredVideo);
      fireEvent.canPlay(restoredVideo);
      expect(play).not.toHaveBeenCalled();
      fireEvent.timeUpdate(restoredVideo);
      expect(document.querySelector(".player-time")).toHaveTextContent("6:47 / 8:53");
      expect(onProgress).toHaveBeenLastCalledWith(
        407,
        533,
        expect.objectContaining({ playbackSpeed: 1 }),
      );
      fireEvent.pointerMove(restoredVideo);
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Server Optimized failed after synchronization. Device Original was restored.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("could not synchronize");
      expect(screen.queryByText("Playback interrupted")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("describes fallback to an already optimized outer source as restoring the previous stream", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const outerUrl =
      "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=20";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=360p&start=25",
      timelineOffsetSeconds: 25,
      startPositionSeconds: 0,
      quality: "360p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url={outerUrl}
          engine="webview-hls-transcode"
          title="Already optimized movie"
          timelineOffsetSeconds={20}
          serverOptimized={{ qualities: ["480p", "360p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "currentTime", { configurable: true, value: 5 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: true });
      fireEvent.timeUpdate(originalVideo);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "360p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("360p", 25));
      const replacement = await waitFor(() => {
        const current = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(current).not.toBe(originalVideo);
        return current;
      });

      const errorRegistration = hlsInstances.at(-1)?.on.mock.calls.find(
        ([event]) => event === "hlsError",
      );
      if (errorRegistration == null) throw new Error("HLS error handler missing");
      const handleHlsError = errorRegistration[1] as (
        event: string,
        data: { fatal: boolean; type: string },
      ) => void;
      act(() => handleHlsError("hlsError", { fatal: true, type: "mediaError" }));
      act(() => handleHlsError("hlsError", { fatal: true, type: "mediaError" }));
      const restored = await waitFor(() => {
        const current = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(current).not.toBe(replacement);
        return current;
      });
      fireEvent.pointerMove(restored);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Server Optimized could not synchronize. The previous stream was restored.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("Device Original");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the original total when a partial optimized EVENT playlist reaches its local end", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=395",
      timelineOffsetSeconds: 395,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const onProgress = vi.fn();
    const onEnded = vi.fn();
    const onPlayNext = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onProgress={onProgress}
          onEnded={onEnded}
          upNext={{ label: "Next episode" }}
          onPlayNext={onPlayNext}
          scrobbleContext={{ tmdbId: 123, type: "movie" }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 533 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: true });
      originalVideo.currentTime = 395;
      fireEvent.loadedMetadata(originalVideo);
      fireEvent.timeUpdate(originalVideo);

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 395));
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(optimizedVideo).not.toBe(originalVideo);
      let optimizedTime = 0;
      Object.defineProperty(optimizedVideo, "duration", { configurable: true, value: 12 });
      Object.defineProperty(optimizedVideo, "currentTime", {
        configurable: true,
        get: () => optimizedTime,
        set: (value: number) => { optimizedTime = value; },
      });
      Object.defineProperty(optimizedVideo, "paused", { configurable: true, value: true });
      fireEvent.loadedMetadata(optimizedVideo);
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      fireEvent.seeked(optimizedVideo);

      optimizedTime = 12;
      fireEvent.timeUpdate(optimizedVideo);
      expect(document.querySelector(".player-time")).toHaveTextContent("6:47 / 8:53");
      expect(onProgress).toHaveBeenLastCalledWith(
        407,
        533,
        expect.objectContaining({ playbackSpeed: 1 }),
      );

      fireEvent.ended(optimizedVideo);
      await waitFor(() => expect(
        (document.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe("https://server.example/api/stream/session-1"));
      expect(onEnded).not.toHaveBeenCalled();
      expect(onPlayNext).not.toHaveBeenCalled();
      expect(scrobbleStopMock).toHaveBeenCalled();
      expect(scrobbleStopMock.mock.calls.every(([, progress]) => Number(progress) < 100)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("scrubs the absolute total and restarts optimized windows for out-of-window seeks", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 1_000 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: true });
      originalVideo.currentTime = 395;
      fireEvent.loadedMetadata(originalVideo);
      fireEvent.timeUpdate(originalVideo);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(1, "480p", 395));

      const firstWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      let firstWindowTime = 0;
      Object.defineProperty(firstWindow, "duration", { configurable: true, value: 12 });
      Object.defineProperty(firstWindow, "currentTime", {
        configurable: true,
        get: () => firstWindowTime,
        set: (value: number) => { firstWindowTime = value; },
      });
      Object.defineProperty(firstWindow, "paused", { configurable: true, value: true });
      fireEvent.loadedMetadata(firstWindow);
      markCurrentMediaDataReady(firstWindow);
      fireEvent.canPlay(firstWindow);
      fireEvent.seeked(firstWindow);
      firstWindowTime = 7;
      fireEvent.timeUpdate(firstWindow);
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-duration", "1000");
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "402");

      const firstScrub = scrubBarMock.mock.calls.at(-1)?.[0];
      if (firstScrub == null) throw new Error("Scrub bar props were not captured");
      act(() => firstScrub.onSeek(400));
      expect(firstWindowTime).toBe(5);
      expect(request).toHaveBeenCalledTimes(1);

      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      act(() => firstScrub.onSeek(100));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "480p", 100));
      const secondWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(secondWindow).not.toBe(firstWindow);
      Object.defineProperty(secondWindow, "duration", { configurable: true, value: 12 });
      Object.defineProperty(secondWindow, "paused", { configurable: true, value: true });
      secondWindow.currentTime = 0;
      fireEvent.loadedMetadata(secondWindow);
      markCurrentMediaDataReady(secondWindow);
      fireEvent.canPlay(secondWindow);
      fireEvent.seeked(secondWindow);
      fireEvent.timeUpdate(secondWindow);
      expect(play).not.toHaveBeenCalled();
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-duration", "1000");
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "100");

      const secondScrub = scrubBarMock.mock.calls.at(-1)?.[0];
      if (secondScrub == null) throw new Error("Replacement scrub bar props were not captured");
      act(() => secondScrub.onSeek(800));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(3, "480p", 800));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function prepareRealTouchScrub() {
    scrubBarMode.actual = true;
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const prepared = (position: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    });
    let releasePreparation!: (value: ReturnType<typeof prepared>) => void;
    let requestCount = 0;
    const request = vi.fn((_quality: string, position: number) => ++requestCount === 1
      ? Promise.resolve(prepared(position))
      : new Promise<ReturnType<typeof prepared>>((resolve) => { releasePreparation = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n")));
    const view = render(<VideoPlayer
      url="https://server.example/api/stream/session-1"
      title="Touch seek"
      serverOptimized={{ qualities: ["480p"], request }}
      onClose={() => {}}
    />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(original, "duration", { configurable: true, value: 1_000 });
    Object.defineProperty(original, "paused", { configurable: true, value: true });
    original.currentTime = 395;
    fireEvent.loadedMetadata(original);
    fireEvent.timeUpdate(original);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "480p" }));
    await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(original));
    const current = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(current, "duration", { configurable: true, value: 12 });
    Object.defineProperty(current, "paused", { configurable: true, value: true });
    fireEvent.loadedMetadata(current);
    markCurrentMediaDataReady(current);
    fireEvent.canPlay(current);
    fireEvent.seeked(current);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    slider.setPointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);
    slider.releasePointerCapture = vi.fn();
    return { slider, current, request, view, prepared, release: (position: number) => releasePreparation(prepared(position)) };
  }

  it.each(["hls.js", "native Safari"])(
    "commits the real touch scrub release target with deferred %s preparation",
    async (renderer) => {
      if (renderer === "native Safari") {
        deviceKindMock.mockReturnValue("ios");
        vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
      }
      const { slider, current, request, release } = await prepareRealTouchScrub();
      fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
      fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 50 });
      fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 75 });
      expect(request).toHaveBeenCalledTimes(1);
      expect(slider).toHaveAttribute("aria-valuenow", "750");
      current.currentTime = 5;
      fireEvent.timeUpdate(current);
      expect(slider).toHaveAttribute("aria-valuenow", "750");
      fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "480p", 800));
      expect(request).toHaveBeenCalledTimes(2);
      expect(document.querySelector("video.player-video")).toBe(current);
      await act(async () => release(800));
      await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(current));
      const replacement = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(replacement, "duration", { configurable: true, value: 12 });
      fireEvent.loadedMetadata(replacement);
      markCurrentMediaDataReady(replacement);
      fireEvent.canPlay(replacement);
      fireEvent.seeked(replacement);
      fireEvent.timeUpdate(replacement);
      expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("aria-valuenow", "800");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "cancels real touch preparation on %s without a late release commit",
    async (eventName) => {
      const { slider, current, request } = await prepareRealTouchScrub();
      fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
      fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
      fireEvent[eventName](slider, { pointerId: 7 });
      fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
      await act(async () => { await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(1);
      expect(document.querySelector("video.player-video")).toBe(current);
    },
  );

  it.each(["source replacement", "unmount"])(
    "disposes a real touch gesture on %s before any remote preparation",
    async (action) => {
      const { slider, request, view } = await prepareRealTouchScrub();
      fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
      fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
      if (action === "unmount") view.unmount();
      else view.rerender(<VideoPlayer url="https://x/replacement.mp4" title="New owner" onClose={() => {}} />);
      fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
      await act(async () => { await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(1);
      expect(slider.releasePointerCapture).toHaveBeenCalledWith(7);
    },
  );

  it("disposes a real touch gesture on a committed same-URL engine replacement", async () => {
    scrubBarMode.actual = true;
    const props = { url: "https://x/movie.m3u8", title: "Engine owner", onClose: () => {} };
    const { rerender } = render(<VideoPlayer {...props} engine="webview-direct" />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 1_000 });
    fireEvent.loadedMetadata(video);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    slider.setPointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);
    slider.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    rerender(<VideoPlayer {...props} engine="webview-hls-transcode" />);
    expect(screen.getByRole("slider", { name: "Seek" })).not.toBe(slider);
    expect(slider.releasePointerCapture).toHaveBeenCalledWith(7);
    const positionBeforeLateRelease = video.currentTime;
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
    expect(video.currentTime).toBe(positionBeforeLateRelease);
    await waitFor(() => expect(hlsInstances).toHaveLength(2));
  });

  function realLocalScrub(wasPaused = false, layout: "desktop" | "touch" = "desktop") {
    scrubBarMode.actual = true;
    deviceKindMock.mockReturnValue(layout === "touch" ? "ios" : "mac");
    const request = vi.fn();
    const props = { url: "https://x/preview.mp4", title: "Local preview owner", onClose: () => {}, serverOptimized: { qualities: ["480p"] as const, request } };
    const view = render(<VideoPlayer {...props} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    let currentTime = 100;
    const writes = vi.fn((value: number) => { currentTime = value; });
    Object.defineProperties(video, {
      duration: { configurable: true, value: 1_000 },
      currentTime: { configurable: true, get: () => currentTime, set: writes },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      paused: { configurable: true, value: wasPaused },
    });
    fireEvent.loadedMetadata(video); fireEvent.canPlay(video);
    if (wasPaused) fireEvent.pause(video);
    else { fireEvent.play(video); fireEvent.playing(video); }
    fireEvent.timeUpdate(video);
    writes.mockClear();
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    const captures = new Set<number>();
    slider.setPointerCapture = vi.fn((id: number) => { captures.add(id); });
    slider.hasPointerCapture = vi.fn((id: number) => captures.has(id));
    slider.releasePointerCapture = vi.fn((id: number) => { captures.delete(id); });
    return { video, slider, writes, request, view, props, nativeClock: (time: number) => { currentTime = time; fireEvent.timeUpdate(video); } };
  }

  for (const layout of ["desktop", "touch"] as const) {
    it.each([true, false])(`[preview] keeps ${layout} pointer motion media-free while paused=%s and commits only its owner release`, (wasPaused) => {
      const { video, slider, writes, request, nativeClock } = realLocalScrub(wasPaused, layout);
      const playCalls = vi.mocked(video.play).mock.calls.length, pauseCalls = vi.mocked(video.pause).mock.calls.length;
      fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
      expect(writes).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
      expect(slider).toHaveAttribute("aria-valuenow", "200");
      fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
      expect(writes).not.toHaveBeenCalled(); expect(video.currentTime).toBe(100);
      expect(slider).toHaveAttribute("aria-valuenow", "800");
      expect(slider.querySelector(".scrubbar-fill")).toHaveStyle({ transform: "scaleX(0.8)" });
      nativeClock(101);
      expect(slider).toHaveAttribute("aria-valuenow", "800");
      // A second pointer cannot commit or steal the original gesture.
      fireEvent.pointerDown(slider, { pointerId: 8, pointerType: "touch", clientX: 90 });
      fireEvent.pointerUp(slider, { pointerId: 8, pointerType: "touch", clientX: 90 });
      expect(writes).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
      expect(slider).toHaveAttribute("aria-valuenow", "800");
      fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 85 });
      expect(writes.mock.calls).toEqual([[850]]); expect(video.currentTime).toBe(850);
      expect(slider).toHaveAttribute("aria-valuenow", "850");
      expect(request).not.toHaveBeenCalled(); expect(video.paused).toBe(wasPaused);
      expect(video.play).toHaveBeenCalledTimes(playCalls); expect(video.pause).toHaveBeenCalledTimes(pauseCalls);
    });
  }

  it.each(["hls.js", "native Safari"])("[preview] leaves in-window %s media and preparation untouched until release", async (renderer) => {
    if (renderer === "native Safari") {
      deviceKindMock.mockReturnValue("ios");
      vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    }
    const { slider, current, request } = await prepareRealTouchScrub();
    let localTime = current.currentTime;
    const writes = vi.fn((value: number) => { localTime = value; });
    Object.defineProperty(current, "currentTime", { configurable: true, get: () => localTime, set: writes });
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 40 });
    fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 40.2 });
    expect(writes).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    expect(slider).toHaveAttribute("aria-valuenow", "402");
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 40.6 });
    expect(writes).toHaveBeenCalledTimes(1); expect(writes.mock.calls[0][0]).toBeCloseTo(11);
    expect(request).toHaveBeenCalledTimes(1); expect(current.paused).toBe(true);
    fireEvent.seeked(current);
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)("[preview] abandons %s without any media write or late commit", (terminal) => {
    const { slider, writes, request } = realLocalScrub(false, "touch");
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
    expect(writes).not.toHaveBeenCalled();
    fireEvent[terminal](slider, { pointerId: 7, pointerType: "touch" });
    expect(slider).toHaveAttribute("aria-valuenow", "100");
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
    expect(writes).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it.each(["source replacement", "unmount"] as const)("[preview] retires %s without committing the old rail's pointer intent", (action) => {
    const { slider, writes, request, view, props } = realLocalScrub();
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
    expect(writes).not.toHaveBeenCalled();
    if (action === "unmount") view.unmount();
    else view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
    expect(slider.isConnected).toBe(false);
    expect(slider.releasePointerCapture).toHaveBeenCalledWith(7);
    const successor = document.querySelector("video.player-video") as HTMLVideoElement | null;
    const successorTime = successor?.currentTime;
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
    expect(writes).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(successor?.currentTime).toBe(successorTime);
  });

  it.each([[-20, 0], [140, 1_000]])("[preview] commits a clamped tap release at x=%s exactly once", (clientX, expected) => {
    const { slider, writes, video } = realLocalScrub(true);
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX });
    expect(writes).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX });
    expect(writes.mock.calls).toEqual([[expected]]); expect(video.paused).toBe(true);
  });

  it("[preview] pins real scrubbing chrome then disables the canceled rail without a late commit", () => {
    vi.useFakeTimers();
    const { slider, writes } = realLocalScrub(false, "touch");
    const bar = document.querySelector(".player-bar")!;
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    expect(writes).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3_201));
    expect(bar).toHaveClass("is-visible");
    fireEvent.pointerCancel(slider, { pointerId: 7, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(3_201));
    expect(bar).not.toHaveClass("is-visible"); expect(slider).toHaveAttribute("tabindex", "-1");
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 90 });
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps real local touch previews and keyboard seeks immediate", () => {
    scrubBarMode.actual = true;
    render(<VideoPlayer url="https://x/movie.mp4" title="Local touch" onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 1_000 });
    fireEvent.loadedMetadata(video);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    expect(video.currentTime).toBe(0);
    expect(slider).toHaveAttribute("aria-valuenow", "200");
    fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
    expect(video.currentTime).toBe(0);
    expect(slider).toHaveAttribute("aria-valuenow", "800");
    fireEvent.pointerUp(slider, { pointerId: 7, pointerType: "touch", clientX: 85 });
    expect(video.currentTime).toBe(850);
    fireEvent.timeUpdate(video);
    const seekWrites: number[] = [];
    let currentTime = video.currentTime;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => { currentTime = value; seekWrites.push(value); },
    });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(seekWrites).toEqual([845]);
    expect(video.currentTime).toBe(845);
  });

  it("keeps global seeking outside the real scrub slider and yields to editable controls", () => {
    scrubBarMode.actual = true;
    render(<>
      <VideoPlayer url="https://x/movie.mp4" title="Keyboard" onClose={() => {}} />
      <input aria-label="Editable input" />
      <textarea aria-label="Editable text area" />
      <select aria-label="Editable select"><option>One</option></select>
    </>);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 1_000 });
    video.currentTime = 500;
    fireEvent.loadedMetadata(video);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(video.currentTime).toBe(505);
    for (const label of ["Editable input", "Editable text area", "Editable select"]) {
      fireEvent.keyDown(screen.getByLabelText(label), { key: "ArrowLeft" });
      expect(video.currentTime).toBe(505);
    }
  });

  it("pins a deferred paused Back 10 seek against late progress from the old window", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const replacement = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    let requestCount = 0;
    const request = vi.fn((_quality: string, _position: number) => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=395",
          timelineOffsetSeconds: 395,
          startPositionSeconds: 0,
          quality: "480p" as const,
        });
      }
      return replacement.promise;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const originalVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(originalVideo, "duration", { configurable: true, value: 1_000 });
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: true });
      originalVideo.currentTime = 395;
      fireEvent.loadedMetadata(originalVideo);
      fireEvent.timeUpdate(originalVideo);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(1, "480p", 395));

      const firstWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      let firstWindowTime = 0;
      Object.defineProperty(firstWindow, "duration", { configurable: true, value: 12 });
      Object.defineProperty(firstWindow, "currentTime", {
        configurable: true,
        get: () => firstWindowTime,
        set: (value: number) => { firstWindowTime = value; },
      });
      Object.defineProperty(firstWindow, "paused", { configurable: true, value: true });
      fireEvent.loadedMetadata(firstWindow);
      fireEvent.canPlay(firstWindow);
      firstWindowTime = 7;
      fireEvent.timeUpdate(firstWindow);

      fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "480p", 392));

      // The old media can report one final clock event while the replacement
      // manifest warms. It must not replace the explicit seek target.
      firstWindowTime = 8;
      fireEvent.timeUpdate(firstWindow);
      await act(async () => {
        replacement.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=392",
          timelineOffsetSeconds: 392,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await replacement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });

      const secondWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(secondWindow).not.toBe(firstWindow);
      let secondWindowTime = 0;
      Object.defineProperty(secondWindow, "duration", { configurable: true, value: 12 });
      Object.defineProperty(secondWindow, "currentTime", {
        configurable: true,
        get: () => secondWindowTime,
        set: (value: number) => { secondWindowTime = value; },
      });
      Object.defineProperty(secondWindow, "paused", { configurable: true, value: true });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(secondWindow);

      expect(secondWindowTime).toBe(0);
      markCurrentMediaDataReady(secondWindow);
      fireEvent.loadedData(secondWindow);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(play).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the absolute unknown-total EVENT clock for paused Back 10 and pins the replacement", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const replacement = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    const secondReplacement = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    let requestCount = 0;
    const request = vi.fn((_quality: string, _position: number) => {
      requestCount += 1;
      return requestCount === 1 ? replacement.promise : secondReplacement.promise;
    });
    const loadSourceInfo = vi.fn(async () => ({ durationSeconds: null }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=531"
          engine="webview-hls-transcode"
          title="Example Movie"
          timelineOffsetSeconds={531}
          serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(1));
      const firstWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      let firstWindowTime = 3;
      Object.defineProperties(firstWindow, {
        duration: { configurable: true, value: 12 },
        currentTime: {
          configurable: true,
          get: () => firstWindowTime,
          set: (value: number) => { firstWindowTime = value; },
        },
        paused: { configurable: true, value: true },
      });
      fireEvent.loadedMetadata(firstWindow);
      fireEvent.timeUpdate(firstWindow);
      fireEvent.pause(firstWindow);
      expect(document.querySelector(".player-time")).toHaveTextContent("8:54 / --:--");

      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(1, "480p", 524));

      firstWindowTime = 4;
      fireEvent.timeUpdate(firstWindow);
      await act(async () => {
        replacement.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=524",
          timelineOffsetSeconds: 524,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await replacement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });

      const secondWindow = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(secondWindow).not.toBe(firstWindow);
      let secondWindowTime = 0;
      Object.defineProperties(secondWindow, {
        duration: { configurable: true, value: 12 },
        currentTime: {
          configurable: true,
          get: () => secondWindowTime,
          set: (value: number) => { secondWindowTime = value; },
        },
        paused: { configurable: true, value: true },
      });
      fireEvent.loadedMetadata(secondWindow);
      expect(secondWindowTime).toBe(0);
      markCurrentMediaDataReady(secondWindow);
      fireEvent.loadedData(secondWindow);
      fireEvent.timeUpdate(secondWindow);

      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(document.querySelector(".player-time")).toHaveTextContent("8:44 / --:--");
      expect(play).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
      await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "480p", 514));
      await act(async () => {
        secondReplacement.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=514",
          timelineOffsetSeconds: 514,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await secondReplacement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps unknown-total EVENT seeks local in-window and restarts Forward 10 only across the window", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const replacement = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    const request = vi.fn((_quality: string, _position: number) => replacement.promise);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    const { unmount } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=531"
        engine="webview-hls-transcode"
        title="Example Movie"
        timelineOffsetSeconds={531}
        serverOptimized={{ qualities: ["480p"], request }}
        onClose={() => {}}
      />,
    );
    const firstWindow = document.querySelector("video.player-video") as HTMLVideoElement;
    let firstWindowTime = 1;
    Object.defineProperties(firstWindow, {
      duration: { configurable: true, value: Number.POSITIVE_INFINITY },
      currentTime: {
        configurable: true,
        get: () => firstWindowTime,
        set: (value: number) => { firstWindowTime = value; },
      },
      paused: { configurable: true, value: true },
      seekable: {
        configurable: true,
        value: {
          length: 2,
          start: (index: number) => [1, 6][index],
          end: (index: number) => [4, 12][index],
        },
      },
    });
    fireEvent.loadedMetadata(firstWindow);
    fireEvent.timeUpdate(firstWindow);

    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    expect(firstWindowTime).toBe(11);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "11");

    const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
    if (scrub == null) throw new Error("Scrub bar props were not captured");
    act(() => scrub.onSeek(2));
    expect(firstWindowTime).toBe(2);
    expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "2");
    expect(request).not.toHaveBeenCalled();

    firstWindowTime = 11;
    fireEvent.timeUpdate(firstWindow);
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 552));
    await act(async () => {
      replacement.resolve({
        url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=552",
        timelineOffsetSeconds: 552,
        startPositionSeconds: 0,
        quality: "480p",
      });
      await replacement.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    unmount();

    const zeroOffsetRequest = vi.fn(async (_quality: string, position: number) => ({
      url: `https://server.example/api/stream/session-2/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-2/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{ qualities: ["480p"], request: zeroOffsetRequest }}
        onClose={() => {}}
      />,
    );
    const zeroWindow = document.querySelector("video.player-video") as HTMLVideoElement;
    let zeroWindowTime = 3;
    Object.defineProperties(zeroWindow, {
      duration: { configurable: true, value: Number.POSITIVE_INFINITY },
      currentTime: {
        configurable: true,
        get: () => zeroWindowTime,
        set: (value: number) => { zeroWindowTime = value; },
      },
      paused: { configurable: true, value: true },
    });
    fireEvent.loadedMetadata(zeroWindow);
    fireEvent.timeUpdate(zeroWindow);
    fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    expect(zeroWindowTime).toBe(0);
    expect(zeroOffsetRequest).not.toHaveBeenCalled();

    const zeroScrub = scrubBarMock.mock.calls.at(-1)?.[0];
    if (zeroScrub == null) throw new Error("Zero-offset scrub bar props were not captured");
    act(() => zeroScrub.onSeek(2));
    expect(zeroWindowTime).toBe(2);
    expect(zeroOffsetRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["an excluded lower boundary", 10, [[2, 10]], "back", 531],
    ["a seekable gap", 0, [[0, 4], [6, 10]], "right", 536],
  ] as const)("restarts an unknown-total Infinity EVENT seek across %s", async (
    _label,
    initialTime,
    ranges,
    action,
    expectedPosition,
  ) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=531"
          engine="webview-hls-transcode"
          title="Example Movie"
          timelineOffsetSeconds={531}
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime: number = initialTime;
      Object.defineProperties(video, {
        duration: { configurable: true, value: Number.POSITIVE_INFINITY },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        paused: { configurable: true, value: true },
        seekable: {
          configurable: true,
          value: {
            length: ranges.length,
            start: (index: number) => ranges[index]?.[0] ?? 0,
            end: (index: number) => ranges[index]?.[1] ?? 0,
          },
        },
      });
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);

      if (action === "back") {
        fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
      } else {
        act(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }));
        });
      }
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", expectedPosition));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not promote an initial zero-offset optimized EVENT window to the media total", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const onProgress = vi.fn();
    const onEnded = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], defaultQuality: "480p", request }}
          onProgress={onProgress}
          onEnded={onEnded}
          scrobbleContext={{ tmdbId: 456, type: "movie" }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0));
      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      let optimizedTime = 0;
      Object.defineProperty(optimizedVideo, "duration", { configurable: true, value: 12 });
      Object.defineProperty(optimizedVideo, "currentTime", {
        configurable: true,
        get: () => optimizedTime,
        set: (value: number) => { optimizedTime = value; },
      });
      fireEvent.loadedMetadata(optimizedVideo);
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.canPlay(optimizedVideo);
      fireEvent.seeked(optimizedVideo);
      optimizedTime = 5;
      fireEvent.timeUpdate(optimizedVideo);

      expect(onProgress).toHaveBeenLastCalledWith(
        5,
        null,
        expect.objectContaining({ playbackSpeed: 1 }),
      );
      expect(document.querySelector(".player-time")).toHaveTextContent("0:05 / --:--");
      fireEvent.ended(optimizedVideo);
      await waitFor(() => expect(
        (document.querySelector("video.player-video") as HTMLVideoElement).src,
      ).toBe("https://server.example/api/stream/session-1"));
      expect(onEnded).not.toHaveBeenCalled();
      expect(scrobbleStopMock.mock.calls.every(([, progress]) => Number(progress) < 100)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers the preferred quality for an initial trusted HLS until real playback progresses", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=auto&start=1.25",
      timelineOffsetSeconds: 1.25,
      startPositionSeconds: 0,
      quality: "auto" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0"
          engine="webview-hls-transcode"
          title="Example Movie"
          serverOptimized={{ qualities: ["auto", "480p"], defaultQuality: "auto", request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      let paused = true;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        paused: { configurable: true, get: () => paused },
      });
      fireEvent.loadedMetadata(video);
      await act(async () => { await Promise.resolve(); });
      expect(request).not.toHaveBeenCalled();

      currentTime = 1;
      fireEvent.pause(video);
      fireEvent.timeUpdate(video);
      expect(request).not.toHaveBeenCalled();

      paused = false;
      currentTime = 1.1;
      fireEvent.timeUpdate(video);
      expect(request).not.toHaveBeenCalled();

      fireEvent.playing(video);
      fireEvent.timeUpdate(video);
      expect(request).not.toHaveBeenCalled();

      currentTime = 1.25;
      fireEvent.timeUpdate(video);
      await waitFor(() => expect(request).toHaveBeenCalledWith("auto", 1.25));
      await waitFor(() => expect(hlsInstances).toHaveLength(2));

      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      let optimizedTime = 0;
      let optimizedPaused = true;
      Object.defineProperties(optimizedVideo, {
        currentTime: {
          configurable: true,
          get: () => optimizedTime,
          set: (value: number) => { optimizedTime = value; },
        },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, get: () => optimizedPaused },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.loadedData(optimizedVideo);
      optimizedPaused = false;
      fireEvent.playing(optimizedVideo);
      optimizedTime = 0.25;
      fireEvent.timeUpdate(optimizedVideo);
      await act(async () => { await Promise.resolve(); });

      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a manual quality selected before deferred initial-HLS optimization", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (
      quality: ServerTranscodeQuality,
      position: number,
    ) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=${quality}&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0"
          engine="webview-hls-transcode"
          title="Manual quality movie"
          serverOptimized={{
            qualities: ["auto", "480p", "360p"],
            defaultQuality: "auto",
            request,
          }}
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "360p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("360p", 0));
      await waitFor(() => expect(hlsInstances).toHaveLength(2));

      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      let paused = true;
      Object.defineProperties(video, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, get: () => paused },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      markCurrentMediaDataReady(video);
      fireEvent.loadedData(video);
      paused = false;
      currentTime = 0.25;
      fireEvent.timeUpdate(video);
      await act(async () => { await Promise.resolve(); });

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalledWith("auto", expect.any(Number));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Device Original after a manual quality toggle cancels deferred initial-HLS optimization", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const initialUrl =
      "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0";
    const request = vi.fn(async (
      quality: ServerTranscodeQuality,
      position: number,
    ) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=${quality}&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    try {
      render(
        <VideoPlayer
          url={initialUrl}
          engine="webview-hls-transcode"
          title="Manual mode movie"
          serverOptimized={{
            qualities: ["auto", "480p", "360p"],
            defaultQuality: "auto",
            request,
          }}
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "360p" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("360p", 0));
      await waitFor(() => expect(hlsInstances).toHaveLength(2));

      const optimizedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 0;
      let paused = true;
      Object.defineProperties(optimizedVideo, {
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (value: number) => { currentTime = value; },
        },
        duration: { configurable: true, value: 120 },
        paused: { configurable: true, get: () => paused },
        seekable: {
          configurable: true,
          value: { length: 1, start: () => 0, end: () => 120 },
        },
      });
      markCurrentMediaDataReady(optimizedVideo);
      fireEvent.loadedData(optimizedVideo);
      paused = false;
      fireEvent.playing(optimizedVideo);
      currentTime = 0.25;
      fireEvent.timeUpdate(optimizedVideo);
      await act(async () => { await Promise.resolve(); });
      expect(request).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "Device Original" }));
      await waitFor(() => expect(hlsInstances[2]?.loadSource).toHaveBeenCalledWith(initialUrl));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(request.mock.calls).toEqual([["360p", 0]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads source duration once for initial partial HLS and seeks outside its local window", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const loadSourceInfo = vi.fn(async () => ({
      durationSeconds: 600,
      tracks: [
        { index: 0, language: "en", label: "English", default: false },
        { index: 1, language: "fr", label: "French", default: true },
      ],
    }));
    const request = vi.fn(async (_quality: string, position: number, _audio?: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    const player = (loader: () => Promise<{ durationSeconds: number | null }>) => (
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: loader, request }}
        onClose={() => {}}
      />
    );
    const { rerender } = render(player(() => loadSourceInfo()));
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 5 });
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);

    await waitFor(() => expect(document.querySelector(".player-time")?.textContent).toContain(
      "0:05 / 10:00",
    ));
    expect(screen.getByTestId("scrub-bar").getAttribute("data-duration")).toBe("600");
    expect(screen.getByTestId("scrub-bar").getAttribute("data-current-time")).toBe("5");
    rerender(player(() => loadSourceInfo()));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(loadSourceInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "French" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("false");

    const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
    if (scrub == null) throw new Error("Scrub bar props were not captured");
    act(() => scrub.onSeek(450));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 450, 1));
    expect(video.currentTime).toBe(5);
    await waitFor(() => expect(
      document.querySelector("video.player-video"),
    ).not.toBe(video));
    expect(loadSourceInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps a manual audio zero after an optimized remount instead of restoring stale preferences", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestedUrl = new URL(String(input));
      return new Response("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n", {
        status: 200,
        headers: {
          "x-yawf-transcode-audio": requestedUrl.searchParams.get("audio") ?? "1",
        },
      });
    }));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=0"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Example Movie"
        savedPrefs={{ preferredAudioId: "1", preferredAudioLang: "fr" }}
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => ({
            durationSeconds: 600,
            tracks: [
              { index: 0, language: "en", label: "English", default: false },
              { index: 1, language: "fr", label: "French", default: true },
            ],
          }),
          request,
        }}
        onClose={() => {}}
      />,
    );
    const initialVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(initialVideo, "duration", { configurable: true, value: 12 });
    Object.defineProperty(initialVideo, "currentTime", { configurable: true, value: 5 });
    initialVideo.volume = 0.35;
    initialVideo.muted = true;
    await waitFor(() => expect(
      screen.getByTestId("scrub-bar").getAttribute("data-duration"),
    ).toBe("600"));

    const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
    if (scrub == null) throw new Error("Scrub bar props were not captured");
    act(() => scrub.onSeek(450));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 450, 1));
    const frenchVideo = await waitFor(() => {
      const current = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(current).not.toBe(initialVideo);
      return current;
    });
    Object.defineProperty(frenchVideo, "duration", { configurable: true, value: 12 });
    Object.defineProperty(frenchVideo, "currentTime", { configurable: true, value: 5 });
    expect(frenchVideo.volume).toBeCloseTo(0.35);
    expect(frenchVideo.muted).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "French" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(request).toHaveBeenNthCalledWith(2, "480p", 455, 0));
    const englishVideo = await waitFor(() => {
      const current = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(current).not.toBe(frenchVideo);
      return current;
    });
    expect(englishVideo.volume).toBeCloseTo(0.35);
    expect(englishVideo.muted).toBe(true);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
    expect(request).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("restores a manual logical audio choice after the same source gets a fresh server stream", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/optimized/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    const initialTracks = [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese", default: false },
    ] satisfies ServerAudioTrack[];
    const refreshedTracks = [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 3, language: "jpn", label: "Japanese", default: false },
    ] satisfies ServerAudioTrack[];
    const player = (
      sourceRevision: number,
      sourceUrl: string,
      tracks: readonly ServerAudioTrack[],
      sourceFileName = "same-fixture.mkv",
    ) => (
      <VideoPlayer
        url={sourceUrl}
        sourceRevision={sourceRevision}
        engine="webview-hls-transcode"
        title="Example Movie"
        sourceFileName={sourceFileName}
        scrobbleContext={{ tmdbId: 42, type: "movie" }}
        timelineOffsetSeconds={sourceRevision === 1 ? 0 : 10}
        initialHandoffState={sourceRevision === 1
          ? null
          : { paused: true, volume: 1, muted: false, playbackRate: 1 }}
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => ({ durationSeconds: 30, tracks: [...tracks] }),
          loadAudioTracks: async () => [...tracks],
          request,
        }}
        onClose={() => {}}
      />
    );
    const view = render(player(
      1,
      "https://server.example/api/stream/old/index.m3u8?quality=480p&audio=0",
      initialTracks,
    ));

    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Japanese" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));

    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
    view.rerender(player(
      2,
      "https://server.example/api/stream/fresh/index.m3u8?quality=480p&start=10&audio=0",
      refreshedTracks,
    ));

    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 10, 3));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    request.mockClear();
    view.rerender(player(
      3,
      "https://server.example/api/stream/fresh-2/index.m3u8?quality=480p&start=10&audio=0",
      [{ index: 0, language: "eng", label: "English", default: true }],
    ));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect((await screen.findByRole("button", { name: "English" })).getAttribute(
      "aria-pressed",
    )).toBe("true");
    expect(request).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));

    view.rerender(player(
      4,
      "https://server.example/api/stream/different/index.m3u8?quality=480p&start=10&audio=0",
      refreshedTracks,
      "different-fixture.mkv",
    ));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect((await screen.findByRole("button", { name: "Japanese" })).getAttribute(
      "aria-pressed",
    )).toBe("false");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the genuine source label to distinguish same-language tracks after retry reordering", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/optimized/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    const player = (
      revision: number,
      tracks: readonly ServerAudioTrack[],
    ) => (
      <VideoPlayer
        url={`https://server.example/api/stream/${revision}/index.m3u8?quality=480p&audio=0`}
        sourceRevision={revision}
        engine="webview-hls-transcode"
        title="Example Movie"
        sourceFileName="same-fixture.mkv"
        scrobbleContext={{ tmdbId: 42, type: "movie" }}
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => ({ durationSeconds: 30, tracks: [...tracks] }),
          loadAudioTracks: async () => [...tracks],
          request,
        }}
        onClose={() => {}}
      />
    );
    const view = render(player(1, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese Commentary", default: false },
      { index: 2, language: "jpn", label: "Japanese Main", default: false },
    ]));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Japanese Main" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 2));

    view.rerender(player(2, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 3, language: "jpn", label: "Japanese Commentary", default: false },
      { index: 4, language: "jpn", label: "Japanese Main", default: false },
    ]));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 4));
    expect(request).not.toHaveBeenCalledWith("480p", 0, 3);
  });

  it("invalidates a labeled manual choice when only a different same-language track remains", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const sourceInfoLoaded = vi.fn();
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/optimized/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    const player = (revision: number, tracks: readonly ServerAudioTrack[]) => (
      <VideoPlayer
        url={`https://server.example/api/stream/${revision}/index.m3u8?quality=480p&audio=0`}
        sourceRevision={revision}
        engine="webview-hls-transcode"
        title="Example Movie"
        sourceFileName="same-fixture.mkv"
        scrobbleContext={{ tmdbId: 42, type: "movie" }}
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => {
            sourceInfoLoaded(revision);
            return { durationSeconds: 30, tracks: [...tracks] };
          },
          loadAudioTracks: async () => [...tracks],
          request,
        }}
        onClose={() => {}}
      />
    );
    const view = render(player(1, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese Commentary", default: false },
      { index: 2, language: "jpn", label: "Japanese Main", default: false },
    ]));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Japanese Commentary" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));

    request.mockClear();
    view.rerender(player(2, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 3, language: "jpn", label: "Japanese Main", default: false },
    ]));
    await waitFor(() => expect(sourceInfoLoaded).toHaveBeenCalledWith(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();

    view.rerender(player(3, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 4, language: "jpn", label: "Japanese Commentary", default: false },
    ]));
    await waitFor(() => expect(sourceInfoLoaded).toHaveBeenCalledWith(3));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("invalidates a retained manual language after a complete same-source inventory omits it", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const sourceInfoLoaded = vi.fn();
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/optimized/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    const player = (revision: number, tracks: readonly ServerAudioTrack[]) => (
      <VideoPlayer
        url={`https://server.example/api/stream/${revision}/index.m3u8?quality=480p&audio=0`}
        sourceRevision={revision}
        engine="webview-hls-transcode"
        title="Example Movie"
        sourceFileName="same-fixture.mkv"
        scrobbleContext={{ tmdbId: 42, type: "movie" }}
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => {
            sourceInfoLoaded(revision);
            return { durationSeconds: 30, tracks: [...tracks] };
          },
          loadAudioTracks: async () => [...tracks],
          request,
        }}
        onClose={() => {}}
      />
    );
    const view = render(player(1, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 1, language: "jpn", label: "Japanese", default: false },
    ]));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Japanese" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));

    request.mockClear();
    view.rerender(player(2, [
      { index: 0, language: "eng", label: "English", default: true },
    ]));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(await screen.findByRole("button", { name: "English" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
    expect(request).not.toHaveBeenCalled();

    view.rerender(player(3, [
      { index: 0, language: "eng", label: "English", default: true },
      { index: 4, language: "jpn", label: "Japanese", default: false },
    ]));
    await waitFor(() => expect(sourceInfoLoaded).toHaveBeenCalledWith(3));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not retain a requested language when the server authoritatively applies another track", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const sourceInfoLoaded = vi.fn();
    const onProgress = vi.fn();
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/optimized/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", {
      status: 200,
      headers: { "x-yawf-transcode-audio": "0" },
    })));
    const player = (revision: number, japaneseIndex: number) => {
      const tracks = [
        { index: 0, language: "eng", label: "English", default: true },
        { index: japaneseIndex, language: "jpn", label: "Japanese", default: false },
      ] satisfies ServerAudioTrack[];
      return (
        <VideoPlayer
          url={`https://server.example/api/stream/${revision}/index.m3u8?quality=480p&audio=0`}
          sourceRevision={revision}
          engine="webview-hls-transcode"
          title="Example Movie"
          sourceFileName="same-fixture.mkv"
          scrobbleContext={{ tmdbId: 42, type: "movie" }}
          serverOptimized={{
            qualities: ["480p"],
            loadSourceInfo: async () => {
              sourceInfoLoaded(revision);
              return { durationSeconds: 30, tracks };
            },
            loadAudioTracks: async () => tracks,
            request,
          }}
          onProgress={onProgress}
          onClose={() => {}}
        />
      );
    };
    const view = render(player(1, 1));
    const initialVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Japanese" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 0, 1));
    const appliedVideo = await waitFor(() => {
      const current = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(current).not.toBe(initialVideo);
      return current;
    });
    Object.defineProperty(appliedVideo, "currentTime", { configurable: true, value: 0 });
    Object.defineProperty(appliedVideo, "duration", { configurable: true, value: 30 });
    markCurrentMediaDataReady(appliedVideo);
    fireEvent.loadedData(appliedVideo);
    const reportClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    fireEvent.timeUpdate(appliedVideo);
    reportClock.mockRestore();
    expect(onProgress).toHaveBeenLastCalledWith(
      0,
      30,
      expect.objectContaining({ preferredAudioId: "0", preferredAudioLang: "eng" }),
    );

    request.mockClear();
    view.rerender(player(2, 3));
    await waitFor(() => expect(sourceInfoLoaded).toHaveBeenCalledWith(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps an explicit initial audio zero when source metadata defaults to another track", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}&audio=${String(audioTrack)}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&audio=0"
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: async () => ({
            durationSeconds: 600,
            tracks: [
              { index: 0, language: "en", label: "English", default: false },
              { index: 1, language: "fr", label: "French", default: true },
            ],
          }),
          request,
        }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 5 });
    await waitFor(() => expect(
      screen.getByTestId("scrub-bar").getAttribute("data-duration"),
    ).toBe("600"));
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "French" }).getAttribute("aria-pressed")).toBe("false");

    const scrub = scrubBarMock.mock.calls.at(-1)?.[0];
    if (scrub == null) throw new Error("Scrub bar props were not captured");
    act(() => scrub.onSeek(450));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 450, 0));
  });

  it("omits initial audio selection while source metadata is still unknown", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const sourceInfo = deferred<{
      durationSeconds: number | null;
      tracks?: Array<{
        index: number;
        language: string | null;
        label: string | null;
        default: boolean;
      }>;
    }>();
    const request = vi.fn(async (_quality: string, position: number, audioTrack?: number) => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
      audioTrack,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("#EXTM3U\n", { status: 200 })));
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo: () => sourceInfo.promise,
          request,
        }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 5 });
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: "480p" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 5));
    expect(request.mock.calls[0]).toHaveLength(2);
    await act(async () => {
      sourceInfo.resolve({ durationSeconds: null });
      await sourceInfo.promise;
    });
  });

  it.each([
    ["null", null],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
    ["over-limit", 86_401],
  ])("rejects %s source-info duration without replacing the unknown total", async (
    _label,
    durationSeconds,
  ) => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const loadSourceInfo = vi.fn(async () => ({ durationSeconds }));
    render(
      <VideoPlayer
        url={`https://server.example/api/stream/session-${String(durationSeconds)}/index.m3u8?quality=480p`}
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo,
          request: async () => ({
            url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
            timelineOffsetSeconds: 0,
            startPositionSeconds: 0,
            quality: "480p",
          }),
        }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    video.currentTime = 5;
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
    expect(document.querySelector(".player-time")?.textContent).toContain("0:05 / --:--");
  });

  it("ignores source-info completion after the original URL or revision changes", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const staleInfo = deferred<{ durationSeconds: number | null }>();
    const currentInfo = deferred<{ durationSeconds: number | null }>();
    const loadSourceInfo = vi.fn()
      .mockImplementationOnce(() => staleInfo.promise)
      .mockImplementationOnce(() => currentInfo.promise);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-a/index.m3u8?quality=480p"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(1));
    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/session-b/index.m3u8?quality=480p"
        sourceRevision={2}
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(2));
    await act(async () => {
      staleInfo.resolve({ durationSeconds: 600 });
      await staleInfo.promise;
    });
    expect(document.querySelector(".player-time")?.textContent).toContain("0:00 / --:--");
  });

  it("times out source-info loading without accepting a late result or interrupting playback", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const sourceInfo = deferred<{ durationSeconds: number | null }>();
    const loadSourceInfo = vi.fn(() => sourceInfo.promise);
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo,
          request: async () => ({
            url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
            timelineOffsetSeconds: 0,
            startPositionSeconds: 0,
            quality: "480p",
          }),
        }}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(8_000);
      await Promise.resolve();
    });
    await act(async () => {
      sourceInfo.resolve({ durationSeconds: 600 });
      await sourceInfo.promise;
    });
    expect(loadSourceInfo).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".player-time")?.textContent).toContain("0:00 / --:--");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits five seconds, then retries source metadata once with the extended server lane across handler rerenders", async () => {
    vi.useFakeTimers();
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const firstHandler = vi.fn(async (options?: { retryFailed?: boolean; signal?: AbortSignal }) => {
      if (options?.retryFailed) {
        return {
          durationSeconds: 596,
          tracks: [{ index: 0, language: "eng", label: "English", default: true }],
        };
      }
      throw conflict();
    });
    const replacementHandler = vi.fn(async () => ({ durationSeconds: 1 }));
    const request = vi.fn();
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/session-409/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Retry source metadata"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: firstHandler, request }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(firstHandler).toHaveBeenCalledTimes(1);

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/session-409/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Retry source metadata"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: replacementHandler, request }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(firstHandler).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(firstHandler).toHaveBeenCalledTimes(2);
    expect(firstHandler.mock.calls[1]?.[0]).toMatchObject({
      retryFailed: true,
      signal: expect.any(AbortSignal),
    });
    expect(replacementHandler).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["401", 401],
    ["403", 403],
    ["404", 404],
    ["410", 410],
    ["network", undefined],
  ])("does not retry source metadata after a %s or unknown failure", async (_label, status) => {
    vi.useFakeTimers();
    const loadSourceInfo = vi.fn(async () => {
      const error = new Error("not retryable") as Error & { status?: number };
      if (status != null) error.status = status;
      throw error;
    });
    render(
      <VideoPlayer
        url={`https://server.example/api/stream/no-retry-${String(status)}/index.m3u8?quality=480p`}
        engine="webview-hls-transcode"
        title="No metadata retry"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(loadSourceInfo).toHaveBeenCalledTimes(1);
  });

  it("cancels the delayed source-info retry on unmount and owner replacement", async () => {
    vi.useFakeTimers();
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const firstOwner = vi.fn(async () => { throw conflict(); });
    const secondOwner = vi.fn(async () => { throw conflict(); });
    const { unmount } = render(
      <VideoPlayer
        url="https://server.example/api/stream/unmount/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Unmount metadata retry"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: firstOwner, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(firstOwner).toHaveBeenCalledTimes(1);

    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/owner-a/index.m3u8?quality=480p"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Owner replacement"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: firstOwner, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/owner-b/index.m3u8?quality=480p"
        sourceRevision={2}
        engine="webview-hls-transcode"
        title="Owner replacement"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo: secondOwner, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(firstOwner).toHaveBeenCalledTimes(2);
    // The replacement owner gets its own first retry; the canceled A owner
    // never gets one after it is replaced.
    expect(secondOwner).toHaveBeenCalledTimes(2);
  });

  it("rejects a delayed A-to-B-to-A retry result from the stale owner generation", async () => {
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const initial = deferred<{ durationSeconds: number }>();
    const retry = deferred<{ durationSeconds: number }>();
    const loadSourceInfo = vi.fn((options?: { retryFailed?: boolean }) =>
      options?.retryFailed ? retry.promise : initial.promise,
    );
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/owner-a/index.m3u8?quality=480p"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Stale retry"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    await act(async () => {
      initial.reject(conflict());
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(loadSourceInfo).toHaveBeenCalledTimes(2);
    expect(loadSourceInfo.mock.calls[1]?.[0]).toMatchObject({
      retryFailed: true,
      signal: expect.any(AbortSignal),
    });
    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/owner-b/index.m3u8?quality=480p"
        sourceRevision={2}
        engine="webview-hls-transcode"
        title="Stale retry"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    vi.useRealTimers();
    await waitFor(() => expect(hlsInstances).toHaveLength(2));
    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/owner-a/index.m3u8?quality=480p"
        sourceRevision={1}
        engine="webview-hls-transcode"
        title="Stale retry"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(3));
    await act(async () => {
      retry.resolve({ durationSeconds: 596 });
      await retry.promise;
    });
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / --:--");
  });

  it("adopts retried duration and audio without remounting or replacing playback", async () => {
    vi.useFakeTimers();
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const request = vi.fn();
    const loadSourceInfo = vi.fn(async (options?: { retryFailed?: boolean }) => {
      if (!options?.retryFailed) throw conflict();
      return {
        durationSeconds: 596,
        tracks: [
          { index: 0, language: "eng", label: "English", default: true },
          { index: 1, language: "fra", label: "French", default: false },
        ],
      };
    });
    render(
      <VideoPlayer
        url="https://server.example/api/stream/adopt/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Adopt metadata"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: Number.POSITIVE_INFINITY });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 3 });
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:03 / 9:56");
    expect(screen.getByTestId("scrub-bar").getAttribute("data-duration")).toBe("596");
    const settingsButton = document.querySelector(
      'button[aria-label="Playback settings"]',
    ) as HTMLButtonElement;
    fireEvent.click(settingsButton);
    expect(screen.getByRole("button", { name: "French" })).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("lets successful manual source recovery supersede the delayed automatic retry", async () => {
    vi.useFakeTimers();
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const loadSourceInfo = vi.fn(async () => { throw conflict(); });
    const loadAudioTracks = vi.fn((options?: ServerAudioInventoryLoadOptions) => {
      if (!options?.retryFailed) return Promise.reject(new Error("inventory unavailable"));
      options?.onSourceInfo?.({
        durationSeconds: 596,
        tracks: [
          { index: 0, language: "eng", label: "English", default: true },
          { index: 1, language: "fra", label: "French", default: false },
        ],
      });
      return Promise.resolve([
        { index: 0, language: "eng", label: "English", default: true },
        { index: 1, language: "fra", label: "French", default: false },
      ]);
    });
    render(
      <VideoPlayer
        url="https://server.example/api/stream/manual-recovery/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Manual metadata recovery"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, loadAudioTracks, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(loadSourceInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "French" })).toBeInTheDocument();
  });

  it("stops after one failed automatic source-info retry", async () => {
    vi.useFakeTimers();
    const conflict = () => Object.assign(new Error("metadata is still warming"), { status: 409 });
    const loadSourceInfo = vi.fn(async () => { throw conflict(); });
    render(
      <VideoPlayer
        url="https://server.example/api/stream/retry-once/index.m3u8?quality=480p"
        engine="webview-hls-transcode"
        title="Retry once"
        serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
        onClose={() => {}}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
    expect(loadSourceInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps the initial source-info result through StrictMode effect replay", async () => {
    const sourceInfo = deferred<{
      durationSeconds: number;
      tracks: ServerAudioTrack[];
    }>();
    const loadSourceInfo = vi.fn(() => sourceInfo.promise);
    render(
      <StrictMode>
        <VideoPlayer
          url="https://server.example/api/stream/strict-source/video.mp4"
          engine="webview-direct"
          title="Strict source info"
          serverOptimized={{ qualities: ["480p"], loadSourceInfo, request: vi.fn() }}
          onClose={() => {}}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(loadSourceInfo).toHaveBeenCalled());
    await act(async () => {
      sourceInfo.resolve({
        durationSeconds: 596,
        tracks: [{ index: 0, language: "eng", label: "English", default: true }],
      });
      await sourceInfo.promise;
      await Promise.resolve();
    });
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / 9:56");
  });

  it("rejects old manual A metadata after A-to-B-to-A owner reuse", async () => {
    const oldRetry = deferred<ServerAudioTrack[]>();
    let oldOptions: ServerAudioInventoryLoadOptions | undefined;
    let retryCalls = 0;
    const loadAudioTracks = vi.fn((options?: ServerAudioInventoryLoadOptions) => {
      if (!options?.retryFailed) return Promise.reject(new Error("inventory unavailable"));
      retryCalls += 1;
      if (retryCalls === 1) {
        oldOptions = options;
        return oldRetry.promise;
      }
      return Promise.reject(new Error("later retry unavailable"));
    });
    const player = (owner: "a" | "b", revision: number) => (
      <VideoPlayer
        url={`https://server.example/api/stream/manual-${owner}/index.m3u8?quality=480p`}
        sourceRevision={revision}
        engine="webview-hls-transcode"
        title="Manual generation fence"
        serverOptimized={{ qualities: ["480p"], loadAudioTracks, request: vi.fn() }}
        onClose={() => {}}
      />
    );
    const { rerender } = render(player("a", 1));
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Retry audio tracks" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(oldOptions?.onSourceInfo).toBeTypeOf("function");

    rerender(player("b", 2));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rerender(player("a", 1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      oldOptions!.onSourceInfo!({
        durationSeconds: 596,
        tracks: [{ index: 0, language: "eng", label: "English", default: true }],
      });
      oldRetry.resolve([{ index: 0, language: "eng", label: "English", default: true }]);
      await oldRetry.promise;
      await Promise.resolve();
    });
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / --:--");
  });

  it("prefers an original video duration over later source metadata", async () => {
    const sourceInfo = deferred<{ durationSeconds: number | null }>();
    const loadSourceInfo = vi.fn(() => sourceInfo.promise);
    render(
      <VideoPlayer
        url="https://x/original.mkv"
        engine="webview-direct"
        title="Example Movie"
        serverOptimized={{
          qualities: ["480p"],
          loadSourceInfo,
          request: async () => ({
            url: "https://server.example/api/stream/session/index.m3u8?quality=480p",
            timelineOffsetSeconds: 0,
            startPositionSeconds: 0,
            quality: "480p",
          }),
        }}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 533 });
    video.currentTime = 20;
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
    expect(document.querySelector(".player-time")?.textContent).toContain("0:20 / 8:53");
    await act(async () => {
      sourceInfo.resolve({ durationSeconds: 600 });
      await sourceInfo.promise;
    });
    expect(document.querySelector(".player-time")?.textContent).toContain("0:20 / 8:53");
  });

  it("retains Device Original when optimized manifest preparation fails", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const fetchMock = vi.fn(async () => new Response("failed", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl="https://server.example/api/external-stream/session-1/capability"
          title="Example Movie"
          serverOptimized={{ qualities: ["auto", "480p"], request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(video.src).toContain("/api/stream/session-1");
      expect(screen.getByRole("alert")).toHaveTextContent("could not prepare 480p playback");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries transient optimized manifest busy responses within the cold-start budget", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("warming", { status: 504 }))
      .mockResolvedValueOnce(new Response("#EXTM3U\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(hlsInstances.some((instance) => instance.loadSource.mock.calls.some(
        ([value]) => value === "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      ))).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("allows a trusted optimized manifest to finish after a 30 second cold start", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const manifest = deferred<Response>();
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=720p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "720p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(() => manifest.promise));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["720p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "720p" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      fireEvent.canPlay(document.querySelector("video.player-video") as HTMLVideoElement);

      await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); });
      expect(screen.queryByRole("alert")).toBeNull();
      expect((document.querySelector("video.player-video") as HTMLVideoElement).src)
        .toContain("/api/stream/session-1");

      await act(async () => {
        manifest.resolve(new Response("#EXTM3U\n", { status: 200 }));
        await manifest.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(hlsInstances.some((instance) => instance.loadSource.mock.calls.some(
        ([value]) => value === "https://server.example/api/stream/session-1/index.m3u8?quality=720p",
      ))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the optimized manifest preparation deadline fixed at 45 seconds", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      fireEvent.canPlay(document.querySelector("video.player-video") as HTMLVideoElement);

      await act(async () => { vi.advanceTimersByTime(44_999); await Promise.resolve(); });
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
      expect(screen.getByRole("alert")).toHaveTextContent("timed out");
      expect((document.querySelector("video.player-video") as HTMLVideoElement).src)
        .toContain("/api/stream/session-1");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("rejects an untrusted or noncanonical optimized manifest before fetching it", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example/yawf";
    const request = vi.fn()
      .mockResolvedValueOnce({
        url: "https://provider.example/api/stream/session-1/index.m3u8?next=https://server.example",
        timelineOffsetSeconds: 0,
        startPositionSeconds: 0,
        quality: "480p" as const,
      })
      .mockResolvedValueOnce({
        url: "https://server.example/wrong/api/stream/session-1/index.m3u8",
        timelineOffsetSeconds: 0,
        startPositionSeconds: 0,
        quality: "480p" as const,
      });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = render(
        <VideoPlayer
          url="https://server.example/yawf/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("untrusted"));
      first.unmount();

      render(
        <VideoPlayer
          url="https://server.example/yawf/api/stream/session-2"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("untrusted"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds optimized warm-up while Device Original remains usable", async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise<never>(() => {}));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Preparing optimized playback/)).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(8_000);
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("timed out");
      expect((document.querySelector("video.player-video") as HTMLVideoElement).src)
        .toContain("/api/stream/session-1");
      expect(screen.getByRole("button", { name: "480p" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a deferred optimized fetch from the previous same-URL revision", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const staleFetch = deferred<Response>();
    const request = vi.fn()
      .mockResolvedValueOnce({
        url: "https://server.example/api/stream/stale/index.m3u8",
        timelineOffsetSeconds: 0,
        startPositionSeconds: 0,
        quality: "480p" as const,
      })
      .mockResolvedValueOnce({
        url: "https://server.example/api/stream/current/index.m3u8",
        timelineOffsetSeconds: 0,
        startPositionSeconds: 0,
        quality: "480p" as const,
      });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(staleFetch.promise)
      .mockResolvedValueOnce(new Response("#EXTM3U\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { rerender } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={1}
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      rerender(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={2}
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(hlsInstances.some(
        (instance) => instance.loadSource.mock.calls.some(
          ([value]) => value === "https://server.example/api/stream/current/index.m3u8",
        ),
      )).toBe(true));

      await act(async () => {
        staleFetch.resolve(new Response("#EXTM3U\n", { status: 200 }));
        await staleFetch.promise;
      });
      expect(hlsInstances.some(
        (instance) => instance.loadSource.mock.calls.some(
          ([value]) => value === "https://server.example/api/stream/stale/index.m3u8",
        ),
      )).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores deferred optimized manifest text after a same-URL revision change", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const manifestText = deferred<string>();
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/stale-text/index.m3u8",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    const text = vi.fn(() => manifestText.promise);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text,
    })));
    try {
      const { rerender } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={1}
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(text).toHaveBeenCalledTimes(1));

      rerender(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          sourceRevision={2}
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      await act(async () => {
        manifestText.resolve("#EXTM3U\n");
        await manifestText.promise;
      });
      expect(hlsInstances.some(
        (instance) => instance.loadSource.mock.calls.some(
          ([value]) => value === "https://server.example/api/stream/stale-text/index.m3u8",
        ),
      )).toBe(false);
      expect(screen.queryByText("Preparing optimized playback while the current stream continues…"))
        .toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts an in-flight optimized manifest fetch when the player unmounts", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/unmount/index.m3u8",
      timelineOffsetSeconds: 0,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    let fetchSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }));
    try {
      const { unmount } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          title="Example Movie"
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireEvent.click(screen.getByRole("button", { name: "480p" }));
      await waitFor(() => expect(fetchSignal).not.toBeNull());

      unmount();
      expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("syncs Media Session metadata, transport handlers, and playback position", () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const setActionHandler = vi.fn(
      (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        handlers.set(action, handler);
      },
    );
    const setPositionState = vi.fn();
    const mediaSession = {
      metadata: null as MediaMetadata | null,
      playbackState: "none" as MediaSessionPlaybackState,
      setActionHandler,
      setPositionState,
    } as unknown as MediaSession;
    const MediaMetadataMock = vi.fn(function (
      this: Record<string, unknown>,
      init: MediaMetadataInit,
    ) {
      Object.assign(this, init);
    });
    const restoreMediaSession = replaceProperty(navigator, "mediaSession", mediaSession);
    vi.stubGlobal("MediaMetadata", MediaMetadataMock);

    try {
      const { unmount } = render(
        <VideoPlayer
          url="https://x/test.mp4"
          title="The Show"
          subtitle="S2 · E5"
          nowPlaying={{
            episodeLabel: "S2 E5 - The Arrival",
            posterUrl: "https://image.test/poster.png",
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 30;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 120 },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (next: number) => {
            currentTime = next;
          },
        },
        playbackRate: { configurable: true, value: 1.25 },
        paused: { configurable: true, value: false },
      });

      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);
      expect(MediaMetadataMock).toHaveBeenCalled();
      expect(mediaSession.metadata).toMatchObject({
        title: "The Show",
        artist: "S2 E5 - The Arrival",
        album: "YAWF Stream",
        artwork: [
          {
            src: "https://image.test/poster.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      });
      expect(setPositionState).toHaveBeenCalledWith({
        duration: 120,
        position: 30,
        playbackRate: 1.25,
      });
      expect(handlers.get("play")).toEqual(expect.any(Function));
      expect(handlers.get("seekbackward")).toEqual(expect.any(Function));
      expect(handlers.get("seekforward")).toEqual(expect.any(Function));
      expect(handlers.get("seekto")).toEqual(expect.any(Function));
      expect(handlers.get("stop")).toEqual(expect.any(Function));

      handlers.get("seekforward")?.({ action: "seekforward" });
      expect(currentTime).toBe(40);
      handlers.get("seekto")?.({ action: "seekto", seekTime: 75 });
      expect(currentTime).toBe(75);
      handlers.get("stop")?.({ action: "stop" });
      expect(video.pause).toHaveBeenCalled();
      expect(currentTime).toBe(0);

      unmount();
      expect(setActionHandler).toHaveBeenCalledWith("play", null);
      expect(setActionHandler).toHaveBeenCalledWith("stop", null);
      expect(mediaSession.metadata).toBeNull();
    } finally {
      restoreMediaSession();
      vi.unstubAllGlobals();
    }
  });

  it("publishes and seeks the full known timeline through Media Session for a partial stream", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const setPositionState = vi.fn();
    const mediaSession = {
      metadata: null,
      playbackState: "none",
      setActionHandler: vi.fn((
        action: MediaSessionAction,
        handler: MediaSessionActionHandler | null,
      ) => handlers.set(action, handler)),
      setPositionState,
    } as unknown as MediaSession;
    const restoreMediaSession = replaceProperty(navigator, "mediaSession", mediaSession);
    const request = vi.fn(async (_quality: string, position: number) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
      timelineOffsetSeconds: position,
      startPositionSeconds: 0,
      quality: "480p" as const,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
          engine="webview-hls-transcode"
          title="Example Movie"
          serverOptimized={{
            qualities: ["480p"],
            loadSourceInfo: async () => ({ durationSeconds: 600 }),
            request,
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: { configurable: true, value: 5, writable: true },
        playbackRate: { configurable: true, value: 1, writable: true },
        paused: { configurable: true, value: true },
      });
      await waitFor(() => expect(
        screen.getByTestId("scrub-bar").getAttribute("data-duration"),
      ).toBe("600"));
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);
      expect(setPositionState).toHaveBeenLastCalledWith({
        duration: 600,
        position: 5,
        playbackRate: 1,
      });

      handlers.get("seekto")?.({ action: "seekto", seekTime: 450 });
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 450));
      expect(video.currentTime).toBe(5);
    } finally {
      restoreMediaSession();
    }
  });

  it("uses the unknown-total EVENT offset for Media Session relative seeks", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const setPositionState = vi.fn();
    const mediaSession = {
      metadata: null,
      playbackState: "none",
      setActionHandler: vi.fn((
        action: MediaSessionAction,
        handler: MediaSessionActionHandler | null,
      ) => handlers.set(action, handler)),
      setPositionState,
    } as unknown as MediaSession;
    const restoreMediaSession = replaceProperty(navigator, "mediaSession", mediaSession);
    const replacement = deferred<{
      url: string;
      timelineOffsetSeconds: number;
      startPositionSeconds: number;
      quality: "480p";
    }>();
    const request = vi.fn((_quality: string, _position: number) => replacement.promise);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
      { status: 200 },
    )));
    try {
      const { unmount } = render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=531"
          engine="webview-hls-transcode"
          title="Example Movie"
          timelineOffsetSeconds={531}
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: { configurable: true, value: 3, writable: true },
        paused: { configurable: true, value: true },
      });
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);
      expect(setPositionState).not.toHaveBeenCalled();

      act(() => handlers.get("seekbackward")?.({ action: "seekbackward" }));
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 524));
      await act(async () => {
        replacement.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=524",
          timelineOffsetSeconds: 524,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await replacement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      unmount();
    } finally {
      restoreMediaSession();
      vi.unstubAllGlobals();
    }
  });

  it("does not publish a partial local window as the Media Session total", () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const setPositionState = vi.fn();
    const mediaSession = {
      metadata: null,
      playbackState: "none",
      setActionHandler: vi.fn(),
      setPositionState,
    } as unknown as MediaSession;
    const restoreMediaSession = replaceProperty(navigator, "mediaSession", mediaSession);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
          engine="webview-hls-transcode"
          title="Example Movie"
          serverOptimized={{
            qualities: ["480p"],
            request: async () => ({
              url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p",
              timelineOffsetSeconds: 0,
              startPositionSeconds: 0,
              quality: "480p",
            }),
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: { configurable: true, value: 5, writable: true },
      });
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);
      expect(setPositionState).not.toHaveBeenCalled();
    } finally {
      restoreMediaSession();
    }
  });

  function mockPlayerFullscreen() {
    const request = vi.fn(function(this: HTMLElement) {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: this });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    const exit = vi.fn(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    const restores = [
      replaceProperty(HTMLElement.prototype, "requestFullscreen", request),
      replaceProperty(document, "fullscreenElement", null),
      replaceProperty(document, "exitFullscreen", exit),
    ];
    return { request, exit, restore: () => restores.reverse().forEach((restore) => restore()) };
  }

  it("fullscreens the complete desktop player pane without replacing or reloading the media", async () => {
    const fullscreen = mockPlayerFullscreen();
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
      const pane = screen.getByRole("dialog", { name: "Playing T" });
      const video = pane.querySelector("video.player-video") as HTMLVideoElement;
      await waitFor(() => expect(video.src).toBe("https://x/test.mp4"));
      video.currentTime = 42;
      const restorePaused = replaceProperty(video, "paused", false);
      fireEvent.play(video);
      const src = video.src;
      vi.mocked(HTMLMediaElement.prototype.load).mockClear();
      vi.mocked(HTMLMediaElement.prototype.play).mockClear();
      vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
      try {
        await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
        expect(fullscreen.request.mock.instances[0], "fullscreen receiver must own all HTML player controls").toBe(pane);
        expect(document.fullscreenElement).toBe(pane);
        expect(pane).toContainElement(pane.querySelector(".player-stage"));
        expect(pane).toContainElement(pane.querySelector(".player-osd"));
        for (const name of ["Close player", "Player details and shortcuts", "Back 10 seconds", "Forward 10 seconds", "Subtitles", "Playback settings", "Mute", "Exit fullscreen"]) {
          expect(document.fullscreenElement, `fullscreen must include ${name}`).toContainElement(screen.getByRole("button", { name }));
        }
        await userEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
        expect(fullscreen.exit).toHaveBeenCalledTimes(1);
        expect(document.fullscreenElement).toBeNull();
        expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeInTheDocument();
        expect(document.querySelector("video.player-video")).toBe(video);
        expect(video.src).toBe(src);
        expect(video.currentTime).toBe(42);
        expect(video.paused).toBe(false);
        expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
      } finally { restorePaused(); }
    } finally { fullscreen.restore(); }
  });

  it("keeps touch transport, audio, settings, captions and details inside the fullscreen pane", async () => {
    deviceKindMock.mockReturnValue("android");
    Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
      configurable: true, value: { getInsets: vi.fn() },
    });
    const fullscreen = mockPlayerFullscreen();
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Touch T" onClose={() => {}}
        serverOptimized={{
          qualities: ["480p"],
          loadAudioTracks: vi.fn(async () => [
            { index: 0, label: "English", language: "eng", default: true },
            { index: 1, label: "French", language: "fra", default: false },
          ] satisfies ServerAudioTrack[]),
          request: vi.fn(async () => ({ url: "https://x/optimized.m3u8", quality: "480p" as const, timelineOffsetSeconds: 0, startPositionSeconds: 0 })),
        }} />);
      const pane = screen.getByRole("dialog", { name: "Playing Touch T" });
      await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
      expect(fullscreen.request.mock.instances[0], "touch fullscreen must own header and custom transport").toBe(pane);
      expect(document.fullscreenElement).toContainElement(pane.querySelector(".player-touch-controls"));
      for (const name of ["Close player", "Back 10 seconds", "Forward 10 seconds", "Audio tracks", "Subtitles", "Playback settings", "Exit fullscreen"]) {
        expect(document.fullscreenElement, `fullscreen must include ${name}`).toContainElement(screen.getByRole("button", { name }));
      }
      await userEvent.click(screen.getByRole("button", { name: "Audio tracks" }));
      expect(document.fullscreenElement).toContainElement(await screen.findByRole("dialog", { name: "Audio tracks" }));
      await userEvent.click(screen.getByRole("button", { name: "Close audio tracks" }));
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(document.fullscreenElement).toContainElement(screen.getByRole("dialog", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      expect(document.fullscreenElement).toContainElement(screen.getByTestId("captions-menu"));
      await userEvent.click(screen.getByText("close-captions"));
      await userEvent.click(screen.getByRole("button", { name: "Player details and shortcuts" }));
      expect(document.fullscreenElement).toContainElement(screen.getByRole("dialog", { name: "Player details and shortcuts" }));
    } finally { fullscreen.restore(); }
  });

  it("uses the full player pane for keyboard fullscreen and tracks browser exit without changing media", () => {
    const fullscreen = mockPlayerFullscreen();
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Keyboard T" onClose={() => {}} />);
      const pane = screen.getByRole("dialog", { name: "Playing Keyboard T" });
      const video = pane.querySelector("video.player-video");
      fireEvent.keyDown(document, { key: "f" });
      expect(fullscreen.request.mock.instances[0], "keyboard fullscreen must use the same full-pane owner").toBe(pane);
      expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeInTheDocument();
      act(() => { void fullscreen.exit(); });
      expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeInTheDocument();
      expect(document.querySelector("video.player-video")).toBe(video);
    } finally { fullscreen.restore(); }
  });

  it("detects fullscreen capability on the full player pane rather than the video-only stage", async () => {
    const fullscreen = mockPlayerFullscreen();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      get() { return this.classList.contains("player") ? fullscreen.request : undefined; },
    });
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Capability T" onClose={() => {}} />);
      const pane = screen.getByRole("dialog", { name: "Playing Capability T" });
      const enter = screen.queryByRole("button", { name: "Enter fullscreen" });
      expect(enter, "fullscreen capability must be detected on the full pane, not its stage").not.toBeNull();
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      for (const event of ["loadedmetadata", "canplay", "emptied"]) {
        fireEvent(video, new Event(event));
        expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeInTheDocument();
      }
      expect(fullscreen.request).not.toHaveBeenCalled();
      await userEvent.click(enter!);
      expect(fullscreen.request.mock.instances[0], "capability and request must agree on the full-pane target").toBe(pane);
    } finally { fullscreen.restore(); }
  });

  it.each(["loadedmetadata", "canplay"])("refreshes delayed WebKit fullscreen support on %s without remount", async (event) => {
    deviceKindMock.mockReturnValue("ios");
    const enter = vi.fn();
    const restores = [
      replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", false),
      replaceProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", enter),
    ];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Delayed fullscreen" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      const src = video.src;
      expect(screen.queryByRole("button", { name: "Enter system fullscreen" })).toBeNull();
      Object.defineProperty(video, "webkitSupportsFullscreen", { configurable: true, value: true });
      fireEvent(video, new Event(event));
      expect(screen.getByRole("button", { name: "Enter system fullscreen" })).toBeInTheDocument();
      expect(document.querySelector("video.player-video")).toBe(video);
      expect(video.src).toBe(src);
      expect(enter).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Enter system fullscreen" }));
      expect(enter).toHaveBeenCalledTimes(1);
      expect(enter.mock.instances[0]).toBe(video);
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it("refreshes WebKit fullscreen support when a source empties and metadata returns", () => {
    const enter = vi.fn();
    const restores = [
      replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", true),
      replaceProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", enter),
    ];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Changing fullscreen" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(screen.getByRole("button", { name: "Enter system fullscreen" })).toBeInTheDocument();
      Object.defineProperty(video, "webkitSupportsFullscreen", { configurable: true, value: false });
      fireEvent.emptied(video);
      expect(screen.queryByRole("button", { name: "Enter system fullscreen" })).toBeNull();
      Object.defineProperty(video, "webkitSupportsFullscreen", { configurable: true, value: true });
      fireEvent.loadedMetadata(video);
      expect(screen.getByRole("button", { name: "Enter system fullscreen" })).toBeInTheDocument();
      expect(enter).not.toHaveBeenCalled();
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it("cleans fullscreen readiness listeners before a later player owns capability", () => {
    let available = false;
    const reads = vi.fn(() => available);
    const enter = vi.fn();
    const restores = [
      replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", false),
      replaceProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", enter),
    ];
    Object.defineProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", { configurable: true, get: reads });
    const add = vi.spyOn(HTMLVideoElement.prototype, "addEventListener");
    const view = render(<VideoPlayer url="https://x/first.mp4" title="First" onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const remove = vi.spyOn(video, "removeEventListener");
    try {
      const registrations = ["loadedmetadata", "canplay", "emptied"].map((event) => {
        const listener = add.mock.calls.find(([name, handler], index) =>
          name === event && add.mock.contexts[index] === video &&
          typeof handler === "function" && handler.name === "syncFullscreenSupport",
        )?.[1];
        expect(listener).toEqual(expect.any(Function));
        return [event, listener] as const;
      });
      view.rerender(<VideoPlayer url="https://x/second.mp4" title="Second" onClose={() => {}} />);
      for (const [event, listener] of registrations) expect(remove).toHaveBeenCalledWith(event, listener);
      const next = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(next).not.toBe(video);
      reads.mockClear();
      available = true;
      act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
      expect(reads).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Enter system fullscreen" })).toBeNull();
      fireEvent.loadedMetadata(next);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Enter system fullscreen" })).toBeInTheDocument();
      expect(enter).not.toHaveBeenCalled();
      const nextRemove = vi.spyOn(next, "removeEventListener");
      const nextRegistrations = add.mock.calls.filter(([name, handler], index) =>
        ["loadedmetadata", "canplay", "emptied"].includes(name) && add.mock.contexts[index] === next &&
        typeof handler === "function" && handler.name === "syncFullscreenSupport",
      );
      view.unmount();
      for (const [event, listener] of nextRegistrations) expect(nextRemove).toHaveBeenCalledWith(event, listener);
      nextRemove.mockRestore();
    } finally {
      view.unmount();
      remove.mockRestore();
      add.mockRestore();
      restores.reverse().forEach((restore) => restore());
    }
  });

  it("uses the iPhone WebKit fullscreen fallback when container fullscreen is unavailable", async () => {
    const enterWebKitFullscreen = vi.fn();
    const restoreSupportsFullscreen = replaceProperty(
      HTMLVideoElement.prototype,
      "webkitSupportsFullscreen",
      true,
    );
    const restoreEnterFullscreen = replaceProperty(
      HTMLVideoElement.prototype,
      "webkitEnterFullscreen",
      enterWebKitFullscreen,
    );
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Enter system fullscreen" }));
      expect(enterWebKitFullscreen).toHaveBeenCalledWith();
    } finally {
      restoreSupportsFullscreen();
      restoreEnterFullscreen();
    }
  });

  it("[71] uses the full player for prefixed container entry and exit", async () => {
    const request = vi.fn(function(this: HTMLElement) {
      Object.defineProperty(document, "webkitFullscreenElement", { configurable: true, value: this });
      document.dispatchEvent(new Event("webkitfullscreenchange"));
    });
    const exit = vi.fn(() => {
      Object.defineProperty(document, "webkitFullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("webkitfullscreenchange"));
    });
    const restores = [replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLElement.prototype, "webkitRequestFullscreen", request),
      replaceProperty(document, "exitFullscreen", undefined), replaceProperty(document, "webkitExitFullscreen", exit),
      replaceProperty(document, "webkitFullscreenElement", null)];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Prefix owner" onClose={() => {}} />);
      const pane = screen.getByRole("dialog", { name: "Playing Prefix owner" });
      const video = pane.querySelector("video") as HTMLVideoElement;
      const src = video.src;
      await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
      expect(request.mock.instances[0]).toBe(pane);
      expect(pane).toContainElement(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(document.querySelector("video")).toBe(video);
      expect(video.src).toBe(src);
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it("[71] keeps standard priority without retrying another API after rejection", async () => {
    const standard = vi.fn().mockRejectedValue(new Error("gesture rejected"));
    const prefix = vi.fn(), native = vi.fn();
    const restores = [replaceProperty(HTMLElement.prototype, "requestFullscreen", standard),
      replaceProperty(HTMLElement.prototype, "webkitRequestFullscreen", prefix),
      replaceProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", true),
      replaceProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", native)];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="Priority" onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
      expect(standard).toHaveBeenCalledTimes(1);
      expect(prefix).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it("[71] explains genuine video-only System fullscreen without promising Safari on iPhone", async () => {
    deviceKindMock.mockReturnValue("ios");
    const enter = vi.fn();
    const restores = [replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLElement.prototype, "webkitRequestFullscreen", undefined),
      replaceProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", true),
      replaceProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", enter),
      replaceProperty(navigator, "userAgent", "iPhone"), replaceProperty(navigator, "standalone", true)];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="System" onClose={() => {}} />);
      expect(screen.getByRole("button", { name: "Enter system fullscreen" })).toHaveTextContent("System fullscreen");
      await userEvent.click(screen.getByRole("button", { name: "Enter system fullscreen" }));
      expect(enter.mock.instances[0]).toBe(document.querySelector("video"));
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByText("System fullscreen uses your device's controls instead of YAWF controls.")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Open YAWF in browser/ })).toBeNull();
      expect(screen.queryByText("YAWF fullscreen in Safari")).toBeNull();
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it.each(["iPad", "Macintosh"])("[71] displays safe manual Safari guidance without browser handoff for %s PWA", async (ua) => {
    deviceKindMock.mockReturnValue("ios");
    vi.stubGlobal("location", new URL("https://user:password@server.example/yawf/watch?session=omit#capability-omit"));
    const restores = [replaceProperty(navigator, "userAgent", ua), replaceProperty(navigator, "platform", "MacIntel"),
      replaceProperty(navigator, "maxTouchPoints", 5), replaceProperty(navigator, "standalone", true),
      replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLElement.prototype, "webkitRequestFullscreen", undefined)];
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const close = vi.fn();
    try {
      render(<VideoPlayer url="https://provider.example/api/stream/capability.m3u8?token=omit" title="Safari page" onClose={close} />);
      const video = document.querySelector("video") as HTMLVideoElement;
      const src = video.src; video.currentTime = 23;
      vi.mocked(video.pause).mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByText("YAWF fullscreen in Safari")).toBeInTheDocument();
      expect(screen.getByText("For fullscreen with YAWF controls, open Safari and enter this server address. Sign in and resume playback there if needed.")).toBeInTheDocument();
      const address = screen.getByText("https://server.example/yawf/watch");
      expect(address.tagName).toBe("CODE");
      expect(address).toHaveStyle({ display: "block", overflowWrap: "anywhere" });
      expect(address.closest("a, button")).toBeNull();
      expect(address.parentElement).not.toHaveTextContent(/password|session=|capability|provider\.example/);
      expect(screen.queryByRole("link", { name: /Open YAWF in browser/ })).toBeNull();
      expect(open).not.toHaveBeenCalled();
      expect(video.pause).not.toHaveBeenCalled();
      expect(video.currentTime).toBe(23); expect(video.src).toBe(src);
      expect(document.querySelector("video")).toBe(video); expect(close).not.toHaveBeenCalled();
    } finally { open.mockRestore(); restores.reverse().forEach((restore) => restore()); }
  });

  it.each([
    { label: "iPhone PWA", ua: "iPhone", touch: 5, standalone: true, container: false },
    { label: "iPad Safari", ua: "iPad", touch: 5, standalone: false, container: false },
    { label: "desktop Mac PWA", ua: "Macintosh", touch: 0, standalone: true, container: false },
    { label: "prefixed container iPad PWA", ua: "iPad", touch: 5, standalone: true, container: true },
  ])("[71] withholds manual Safari guidance for $label", async ({ ua, touch, standalone, container }) => {
    deviceKindMock.mockReturnValue("ios"); vi.stubGlobal("location", new URL("https://server.example/"));
    const restores = [replaceProperty(navigator, "userAgent", ua), replaceProperty(navigator, "platform", "MacIntel"),
      replaceProperty(navigator, "maxTouchPoints", touch), replaceProperty(navigator, "standalone", standalone),
      replaceProperty(HTMLElement.prototype, "requestFullscreen", undefined),
      replaceProperty(HTMLElement.prototype, "webkitRequestFullscreen", container ? vi.fn() : undefined)];
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="No promise" onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.queryByRole("link", { name: /Open YAWF in browser/ })).toBeNull();
      expect(screen.queryByText("YAWF fullscreen in Safari")).toBeNull();
      expect(screen.queryByText("https://server.example/")).toBeNull();
    } finally { restores.reverse().forEach((restore) => restore()); }
  });

  it("offers Picture-in-Picture only with a supported API and tracks its active state", async () => {
    const requestPictureInPicture = vi.fn().mockResolvedValue(undefined);
    const restoreEnabled = replaceProperty(document, "pictureInPictureEnabled", true);
    const restoreElement = replaceProperty(document, "pictureInPictureElement", null);
    const restoreRequest = replaceProperty(
      HTMLVideoElement.prototype,
      "requestPictureInPicture",
      requestPictureInPicture,
    );
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      const pip = screen.getByRole("button", { name: "Picture in picture" });
      await userEvent.click(pip);
      expect(requestPictureInPicture).toHaveBeenCalledWith();

      Object.defineProperty(document, "pictureInPictureElement", {
        configurable: true,
        value: video,
      });
      fireEvent(video, new Event("enterpictureinpicture"));
      expect(screen.getByRole("button", { name: "Exit picture in picture" })).toBeInTheDocument();
    } finally {
      restoreEnabled();
      restoreElement();
      restoreRequest();
    }
  });

  it("reveals the WebKit cast control only after an AirPlay route is available", async () => {
    const showPlaybackTargetPicker = vi.fn();
    const restoreAirPlay = replaceProperty(
      HTMLVideoElement.prototype,
      "webkitShowPlaybackTargetPicker",
      showPlaybackTargetPicker,
    );
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(screen.queryByRole("button", { name: "Cast to a device" })).toBeNull();
      const event = new Event("webkitplaybacktargetavailabilitychanged") as Event & {
        availability?: string;
      };
      event.availability = "available";
      fireEvent(video, event);
      await userEvent.click(screen.getByRole("button", { name: "Cast to a device" }));
      expect(showPlaybackTargetPicker).toHaveBeenCalledWith();
    } finally {
      restoreAirPlay();
    }
  });

  it("uses the Remote Playback availability watcher for Chromium casting", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const cancelWatchAvailability = vi.fn().mockResolvedValue(undefined);
    const watchAvailability = vi.fn((callback: RemotePlaybackAvailabilityCallback) => {
      callback(true);
      return Promise.resolve(7);
    });
    const restoreRemote = replaceProperty(HTMLMediaElement.prototype, "remote", {
      prompt,
      watchAvailability,
      cancelWatchAvailability,
    });
    try {
      const { unmount } = render(
        <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
      );
      const cast = await screen.findByRole("button", { name: "Cast to a device" });
      await userEvent.click(cast);
      expect(prompt).toHaveBeenCalledWith();
      unmount();
      await waitFor(() => expect(cancelWatchAvailability).toHaveBeenCalledWith(7));
    } finally {
      restoreRemote();
    }
  });

  it("keeps timeupdate renders inside the scrubber leaf", async () => {
    render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    scrubBarMock.mockClear();
    iconMock.mockClear();
    Object.defineProperty(video, "currentTime", { configurable: true, value: 42 });

    fireEvent.timeUpdate(video);

    await waitFor(() =>
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "42"),
    );
    expect(scrubBarMock).toHaveBeenCalled();
    expect(iconMock).not.toHaveBeenCalled();
  });

  it("maps seek-offset HLS progress back to the original media timeline", () => {
    const onProgress = vi.fn();
    render(
      <VideoPlayer
        url="https://x/movie.m3u8"
        title="T"
        timelineOffsetSeconds={700}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 12,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });

    fireEvent.timeUpdate(video);

    expect(onProgress).toHaveBeenCalledWith(
      712,
      800,
      expect.objectContaining({ playbackSpeed: 1 }),
    );
    expect(document.querySelector(".player-time")).toHaveTextContent(
      "11:52 / 13:20",
    );
  });

  it("resets the remembered total for a query-distinct file and a fresh source revision", () => {
    const { rerender } = render(
      <VideoPlayer
        url="https://x/download?fileId=A"
        sourceRevision={1}
        title="Shared episode title"
        subtitle="S1 E1"
        scrobbleContext={{ tmdbId: 123, type: "series", season: 1, episode: 1 }}
        onClose={() => {}}
      />,
    );
    const firstVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(firstVideo, "duration", { configurable: true, value: 533 });
    firstVideo.currentTime = 395;
    fireEvent.loadedMetadata(firstVideo);
    fireEvent.timeUpdate(firstVideo);
    expect(document.querySelector(".player-time")).toHaveTextContent("6:35 / 8:53");

    rerender(
      <VideoPlayer
        url="https://x/download?fileId=B"
        sourceRevision={1}
        title="Shared episode title"
        subtitle="S1 E1"
        scrobbleContext={{ tmdbId: 123, type: "series", season: 1, episode: 1 }}
        onClose={() => {}}
      />,
    );
    const refreshedVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(refreshedVideo).not.toBe(firstVideo);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / --:--");
    Object.defineProperty(refreshedVideo, "duration", { configurable: true, value: 222 });
    refreshedVideo.currentTime = 20;
    fireEvent.loadedMetadata(refreshedVideo);
    fireEvent.timeUpdate(refreshedVideo);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:20 / 3:42");

    rerender(
      <VideoPlayer
        url="https://x/download?fileId=B"
        sourceRevision={2}
        title="Shared episode title"
        subtitle="S1 E1"
        scrobbleContext={{ tmdbId: 123, type: "series", season: 1, episode: 1 }}
        onClose={() => {}}
      />,
    );
    const secondVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(secondVideo).not.toBe(refreshedVideo);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:00 / --:--");
    Object.defineProperty(secondVideo, "duration", { configurable: true, value: 120 });
    secondVideo.currentTime = 15;
    fireEvent.loadedMetadata(secondVideo);
    fireEvent.timeUpdate(secondVideo);
    expect(document.querySelector(".player-time")).toHaveTextContent("0:15 / 2:00");
  });

  describe("current-source readiness chrome", () => {
    it.each(["waiting", "canplay"])("keeps committed %s readiness authoritative during an uncommitted replacement", async (event) => {
      vi.useFakeTimers();
      try {
        let choose: (pending: boolean) => void = () => { throw new Error("Scenario not mounted"); };
        let speculativeRenders = 0;
        const pendingRender = new Promise<void>(() => {});
        function Gate({ pending }: { pending: boolean }) {
          if (pending) { speculativeRenders += 1; throw pendingRender; }
          return null;
        }
        function Scenario() {
          const [pending, setPending] = useState(false);
          choose = setPending;
          return <Suspense fallback={<div>Readiness replacement pending</div>}>
            <VideoPlayer url={pending ? "https://x/speculative.mp4" : "https://x/committed.mp4"}
              title="Committed readiness" onClose={() => {}} />
            <Gate pending={pending} />
          </Suspense>;
        }
        render(<Scenario />);
        const committed = document.querySelector("video.player-video") as HTMLVideoElement;
        if (event === "waiting") {
          fireEvent.canPlay(committed);
          act(() => vi.advanceTimersByTime(3_200));
          expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        }
        act(() => { startTransition(() => choose(true)); });
        await act(async () => { await Promise.resolve(); });
        expect(speculativeRenders).toBeGreaterThan(0);
        expect(document.querySelector("video.player-video")).toBe(committed);
        expect(committed.isConnected).toBe(true);
        expect(screen.queryByText("Readiness replacement pending")).toBeNull();
        fireEvent(committed, new Event(event));
        act(() => vi.advanceTimersByTime(4_000));
        if (event === "waiting") {
          expect(screen.getByRole("status")).toHaveTextContent("Buffering");
          expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
        } else {
          expect(screen.queryByText("Starting playback…")).toBeNull();
          expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        }
        act(() => choose(false));
        expect(document.querySelector("video.player-video")).toBe(committed);
      } finally { vi.useRealTimers(); }
    });

    it("does not turn buffered stalled progress into false permanent buffering", () => {
      vi.useFakeTimers();
      try {
        render(<VideoPlayer url="https://x/buffered.mp4" title="Buffered" onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        Object.defineProperties(video, {
          duration: { configurable: true, value: 120 },
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
          paused: { configurable: true, value: false },
          seeking: { configurable: true, value: false },
        });
        fireEvent.loadedMetadata(video);
        fireEvent.canPlay(video);
        fireEvent.play(video);
        video.currentTime = 1;
        fireEvent.timeUpdate(video);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        vi.mocked(video.play).mockClear();
        vi.mocked(video.pause).mockClear();
        fireEvent.stalled(video);
        // Buffered media continues advancing without another canplay/playing.
        for (const time of [2, 3, 4]) {
          video.currentTime = time;
          fireEvent.timeUpdate(video);
          act(() => vi.advanceTimersByTime(1_200));
        }
        expect(screen.queryByText("Buffering…")).toBeNull();
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        expect(screen.getByText("Playback playing")).toBeInTheDocument();
        expect(video.currentTime).toBe(4);
        expect(video.play).not.toHaveBeenCalled();
        expect(video.pause).not.toHaveBeenCalled();
        Object.defineProperty(video, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
        fireEvent.waiting(video);
        act(() => vi.advanceTimersByTime(4_000));
        expect(screen.getByRole("status")).toHaveTextContent("Buffering");
        expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
        fireEvent.canPlay(video);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
      } finally { vi.useRealTimers(); }
    });

    it("keeps startup controls available without changing playing or paused intent", () => {
      vi.useFakeTimers();
      try {
        render(<VideoPlayer url="https://x/slow.mp4" title="Slow" onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        const bar = document.querySelector(".player-bar")!;
        expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Playing Slow" }));
        fireEvent.play(video);
        vi.mocked(video.play).mockClear();
        vi.mocked(video.pause).mockClear();
        fireEvent.stalled(video);
        act(() => vi.advanceTimersByTime(4_000));
        expect(screen.getByRole("status")).toHaveTextContent("Starting playback");
        expect(bar).toHaveClass("is-visible");
        expect(screen.getByRole("button", { name: "Close player" })).toBeInTheDocument();
        expect(screen.getByText("Playback playing")).toBeInTheDocument();
        expect(video.pause).not.toHaveBeenCalled();
        fireEvent.pause(video);
        fireEvent.canPlay(video);
        vi.mocked(video.play).mockClear();
        act(() => vi.advanceTimersByTime(3_200));
        expect(bar).toHaveClass("is-visible");
        expect(screen.getByText("Playback paused")).toBeInTheDocument();
        expect(video.play).not.toHaveBeenCalled();
        fireEvent.play(video);
        act(() => vi.advanceTimersByTime(3_200));
        expect(bar).not.toHaveClass("is-visible");
      } finally { vi.useRealTimers(); }
    });

    it("keeps native HLS controls pending until the exact handoff target is confirmed", () => {
      vi.useFakeTimers();
      deviceKindMock.mockReturnValue("ios");
      vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
      try {
        render(<VideoPlayer url="https://x/native.m3u8" title="Native readiness"
          startPositionSeconds={9}
          initialHandoffState={{ paused: false, volume: 0.6, muted: false, playbackRate: 1.25 }}
          onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        Object.defineProperties(video, {
          duration: { configurable: true, value: 30 },
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
          seeking: { configurable: true, value: false },
          seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 30 } },
        });
        fireEvent.loadedMetadata(video);
        fireEvent.canPlay(video);
        fireEvent.stalled(video);
        act(() => vi.advanceTimersByTime(4_000));
        expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
        expect(document.querySelector(".player-touch-transport")).toHaveClass("is-visible");
        expect(screen.getByText("Playback playing")).toBeInTheDocument();
        markCurrentMediaDataReady(video);
        video.currentTime = 0;
        fireEvent.timeUpdate(video);
        act(() => vi.advanceTimersByTime(4_000));
        expect(document.querySelector(".player-touch-transport")).toHaveClass("is-visible");
        expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
        video.currentTime = 9;
        fireEvent.seeked(video);
        expect(screen.queryByText("Synchronizing playback…")).toBeNull();
        expect(video.volume).toBe(0.6);
        expect(video.playbackRate).toBe(1.25);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-touch-transport")).not.toHaveClass("is-visible");
      } finally { vi.useRealTimers(); }
    });

    it("keeps controls available through waiting without a pause event", () => {
      vi.useFakeTimers();
      try {
        deviceKindMock.mockReturnValue("ios");
        render(<VideoPlayer url="https://x/buffer.mp4" title="Buffer" onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        fireEvent.canPlay(video);
        fireEvent.play(video);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-touch-transport")).not.toHaveClass("is-visible");
        vi.mocked(video.pause).mockClear();
        fireEvent.waiting(video);
        act(() => vi.advanceTimersByTime(4_000));
        expect(screen.getByRole("status")).toHaveTextContent("Buffering");
        expect(document.querySelector(".player-touch-transport")).toHaveClass("is-visible");
        expect(screen.getByText("Playback playing")).toBeInTheDocument();
        expect(video.pause).not.toHaveBeenCalled();
        fireEvent.playing(video);
        act(() => vi.advanceTimersByTime(3_199));
        expect(document.querySelector(".player-touch-transport")).toHaveClass("is-visible");
        act(() => vi.advanceTimersByTime(1));
        expect(document.querySelector(".player-touch-transport")).not.toHaveClass("is-visible");
      } finally { vi.useRealTimers(); }
    });

    it.each(["url", "revision"])("pins a pending replacement after a hidden ready %s source", (replacement) => {
      vi.useFakeTimers();
      try {
        const props = { url: "https://x/first.mp4", sourceRevision: 0, title: "Replacement", onClose: () => {} };
        const view = render(<VideoPlayer {...props} />);
        const oldVideo = document.querySelector("video.player-video") as HTMLVideoElement;
        fireEvent.canPlay(oldVideo);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        view.rerender(<VideoPlayer {...props} {...(replacement === "url" ? { url: "https://x/second.mp4" } : { sourceRevision: 1 })} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(video).not.toBe(oldVideo);
        act(() => vi.advanceTimersByTime(4_000));
        expect(screen.getByRole("status")).toHaveTextContent("Starting playback");
        expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
        fireEvent.canPlay(video);
        act(() => vi.advanceTimersByTime(3_200));
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
      } finally { vi.useRealTimers(); }
    });

    it("ignores old source readiness callbacks in both directions, including a returned URL", () => {
      vi.useFakeTimers();
      const add = vi.spyOn(HTMLVideoElement.prototype, "addEventListener");
      try {
        const props = { url: "https://x/first.mp4", title: "Ownership", onClose: () => {} };
        const view = render(<VideoPlayer {...props} />);
        const oldVideo = document.querySelector("video.player-video") as HTMLVideoElement;
        const oldCallbacks = ["canplay", "waiting"].map((event) => {
          const name = event === "canplay" ? "onCanPlay" : "onWaiting";
          const listener = add.mock.calls.find(([type, handler], index) =>
            type === event && add.mock.contexts[index] === oldVideo && typeof handler === "function" && handler.name === name,
          )?.[1];
          expect(listener).toEqual(expect.any(Function));
          return listener as EventListener;
        });
        fireEvent.canPlay(oldVideo);
        act(() => vi.advanceTimersByTime(3_200));
        view.rerender(<VideoPlayer {...props} url="https://x/second.mp4" />);
        view.rerender(<VideoPlayer {...props} />);
        const current = document.querySelector("video.player-video") as HTMLVideoElement;
        expect(current).not.toBe(oldVideo);
        act(() => {
          oldCallbacks[0]!(new Event("canplay"));
          fireEvent.canPlay(oldVideo);
          vi.advanceTimersByTime(4_000);
        });
        expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
        fireEvent.canPlay(current);
        act(() => {
          oldCallbacks[1]!(new Event("waiting"));
          fireEvent.waiting(oldVideo);
          vi.advanceTimersByTime(3_200);
        });
        expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
        expect(screen.queryByText("Buffering…")).toBeNull();
      } finally { add.mockRestore(); vi.useRealTimers(); }
    });
  });

  describe("chrome input modality", () => {
    function pointer(element: Element, type: "pointerover" | "pointerout" | "pointerdown" | "pointerup" | "pointercancel", pointerType: string) {
      const event = new MouseEvent(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      fireEvent(element, event);
    }
    function setup(layout: "desktop" | "touch" = "touch") {
      vi.useFakeTimers();
      deviceKindMock.mockReturnValue(layout === "touch" ? "ios" : "mac");
      const props = { url: "https://x/chrome.mp4", title: "Chrome input", onClose: () => {} };
      const view = render(<VideoPlayer {...props} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let paused = false;
      Object.defineProperties(video, {
        paused: { configurable: true, get: () => paused },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
        duration: { configurable: true, value: 900 },
      });
      vi.mocked(video.play).mockImplementation(async () => {
        paused = false; fireEvent.play(video); fireEvent.playing(video);
      });
      vi.mocked(video.pause).mockImplementation(() => { paused = true; fireEvent.pause(video); });
      fireEvent.canPlay(video);
      fireEvent.play(video); fireEvent.playing(video);
      const bar = document.querySelector(".player-bar") as HTMLElement;
      const osd = document.querySelector(".player-osd") as HTMLElement;
      const region = document.querySelector(layout === "touch" ? ".player-touch-transport" : ".player-osd") as HTMLElement;
      const advance = () => act(() => vi.advanceTimersByTime(3_201));
      return { video, bar, osd, region, advance, view, props };
    }

    it.each(["hover", "focus"] as const)("drops a disconnected child %s pin after a committed source remount", (kind) => {
      const { video, bar, region, advance, view, props } = setup();
      if (kind === "hover") pointer(region, "pointerover", "mouse");
      else act(() => screen.getByRole("button", { name: "Pause" }).focus());
      advance(); expect(bar).toHaveClass("is-visible");
      view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
      const next = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(next).not.toBe(video); expect(region.isConnected).toBe(false);
      fireEvent.canPlay(next);
      advance(); expect(bar).not.toHaveClass("is-visible");
    });

    it.each(["hover", "focus"] as const)("retains a connected parent header %s pin through a committed source remount", (kind) => {
      const { bar, advance, view, props } = setup();
      const close = screen.getByRole("button", { name: "Close player" });
      if (kind === "hover") pointer(bar, "pointerover", "mouse");
      else act(() => close.focus());
      advance(); expect(bar).toHaveClass("is-visible");
      view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
      fireEvent.canPlay(document.querySelector("video.player-video")!);
      expect(bar.isConnected).toBe(true);
      if (kind === "focus") expect(document.activeElement).toBe(close);
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("drops a connected header focus pin when focus moved without a delivered blur before remount", () => {
      const { bar, advance, view, props } = setup();
      const close = screen.getByRole("button", { name: "Close player" });
      act(() => close.focus());
      advance(); expect(bar).toHaveClass("is-visible");
      const outside = document.createElement("button");
      document.body.append(outside);
      const suppressBlur = (event: FocusEvent) => {
        if (event.target === close) event.stopPropagation();
      };
      window.addEventListener("focusout", suppressBlur, true);
      try {
        act(() => outside.focus());
        expect(close.isConnected).toBe(true);
        expect(document.activeElement).toBe(outside);
        view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
        fireEvent.canPlay(document.querySelector("video.player-video")!);
        advance(); expect(bar).not.toHaveClass("is-visible");
      } finally {
        window.removeEventListener("focusout", suppressBlur, true);
        outside.remove();
      }
    });

    it.each(["pointerup", "pointercancel"] as const)("allows independent programmatic focus after touch %s without a click", (terminal) => {
      const { bar, advance } = setup();
      const play = screen.getByRole("button", { name: "Pause" });
      pointer(play, "pointerdown", "touch"); act(() => play.focus());
      pointer(play, terminal, "touch");
      act(() => vi.advanceTimersByTime(1));
      // Re-focus the same target so the case also rejects a pointer scope
      // accidentally surviving its terminal event, not only a different target.
      act(() => play.blur()); act(() => play.focus());
      expect(document.activeElement).toBe(play);
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("allows independent assistive focus after a completed touch-menu restoration", () => {
      const { bar, advance } = setup();
      const more = screen.getByRole("button", { name: "Playback settings" });
      pointer(more, "pointerdown", "touch"); act(() => more.focus()); fireEvent.click(more);
      const close = screen.getByRole("button", { name: "Close playback settings" });
      pointer(close, "pointerdown", "touch"); fireEvent.click(close);
      advance(); expect(bar).not.toHaveClass("is-visible");
      const play = screen.getByRole("button", { name: "Pause", hidden: true });
      act(() => play.focus());
      expect(document.activeElement).toBe(play);
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it.each([
      ["touch", "touch"], ["touch", "pen"], ["desktop", "touch"],
    ] as const)("hides after %s-layout %s Resume focus without pointerleave or blur", async (layout, pointerType) => {
      const { video, bar, osd, region, advance } = setup(layout);
      act(() => video.pause());
      const play = screen.getByRole("button", { name: "Play" });
      pointer(region, "pointerover", pointerType);
      pointer(play, "pointerdown", pointerType);
      act(() => play.focus());
      fireEvent.click(play);
      pointer(play, "pointerup", pointerType);
      expect(video.paused).toBe(false);
      expect(document.activeElement).toBe(play);
      advance();
      expect(bar).not.toHaveClass("is-visible");
      expect(osd).not.toHaveClass("is-visible");
      expect(document.activeElement).toBe(play);
      expect(video.paused).toBe(false);
    });

    it.each(["touch", "pen"] as const)("does not pin chrome on a %s pointerenter without pointerdown or pointerleave", (pointerType) => {
      const { video, bar, osd, region, advance } = setup();
      pointer(region, "pointerover", pointerType);
      advance();
      expect(bar).not.toHaveClass("is-visible");
      expect(osd).not.toHaveClass("is-visible");
      expect(video.paused).toBe(false);
    });

    it.each(["touch", "pen"] as const)("clears existing mouse-hover and keyboard-focus pins on %s without blur", (pointerType) => {
      const { video, bar, region, advance } = setup();
      const play = screen.getByRole("button", { name: "Pause" });
      pointer(region, "pointerover", "mouse");
      fireEvent.keyDown(play, { key: "Tab" }); act(() => play.focus());
      advance(); expect(bar).toHaveClass("is-visible");
      pointer(play, "pointerdown", pointerType);
      advance(); expect(bar).not.toHaveClass("is-visible");
      expect(document.activeElement).toBe(play);
      expect(video.paused).toBe(false);
    });

    it("preserves unclassified assistive or programmatic control focus", () => {
      const { bar, advance } = setup();
      act(() => screen.getByRole("button", { name: "Pause" }).focus());
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("hides after touch settings close restores focus to More", () => {
      const { bar, osd, advance } = setup();
      const more = screen.getByRole("button", { name: "Playback settings" });
      pointer(more, "pointerover", "touch"); pointer(more, "pointerdown", "touch");
      act(() => more.focus()); fireEvent.click(more);
      advance();
      expect(bar).toHaveClass("is-visible");
      const close = screen.getByRole("button", { name: "Close playback settings" });
      pointer(close, "pointerdown", "touch"); fireEvent.click(close);
      expect(screen.queryByRole("dialog", { name: "Playback settings" })).toBeNull();
      expect(document.activeElement).toBe(more);
      advance();
      expect(bar).not.toHaveClass("is-visible");
      expect(osd).not.toHaveClass("is-visible");
      expect(document.activeElement).toBe(more);
    });

    it("re-pins keyboard input on an already touch-focused control without another focus event", () => {
      const { bar, advance } = setup();
      const play = screen.getByRole("button", { name: "Pause" });
      pointer(play, "pointerdown", "touch"); act(() => play.focus());
      advance(); expect(bar).not.toHaveClass("is-visible");
      fireEvent.keyDown(play, { key: "ArrowDown" });
      expect(document.activeElement).toBe(play);
      advance(); expect(bar).toHaveClass("is-visible");
      expect(document.activeElement).toBe(play);
      act(() => play.blur());
      advance(); expect(bar).not.toHaveClass("is-visible");
    });

    it("preserves keyboard settings-close focus restoration pinning", () => {
      const { bar, advance } = setup();
      const more = screen.getByRole("button", { name: "Playback settings" });
      fireEvent.keyDown(more, { key: "Tab" }); act(() => more.focus());
      fireEvent.click(more);
      const close = screen.getByRole("button", { name: "Close playback settings" });
      fireEvent.keyDown(close, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Playback settings" })).toBeNull();
      expect(document.activeElement).toBe(more);
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it.each(["desktop", "touch"] as const)("preserves actual mouse hover in the %s layout until mouse leave", (layout) => {
      const { bar, region, advance } = setup(layout);
      pointer(region, "pointerover", "mouse");
      advance(); expect(bar).toHaveClass("is-visible");
      pointer(region, "pointerout", "mouse");
      advance(); expect(bar).not.toHaveClass("is-visible");
    });

    function touchPress(button: HTMLElement) {
      pointer(button, "pointerdown", "touch");
      // fireEvent does not perform the browser's ordinary focus default.
      act(() => button.focus());
      pointer(button, "pointerup", "touch");
      fireEvent.click(button);
    }
    function enableNativeAudioChoices() {
      const tracks = Object.assign(new EventTarget(), {
        0: { id: "en", label: "English", language: "eng", enabled: true },
        1: { id: "jp", label: "Japanese", language: "jpn", enabled: false },
        length: 2,
        item(index: number) { return this[index as 0 | 1] ?? null; },
      });
      Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", { configurable: true, get: () => tracks });
    }

    it.each(["settings", "captions", "audio"] as const)("[r3] retires desktop-layout touch %s restoration without losing exact focus or later assistive refocus", (menu) => {
      captionMenuMode.actual = true;
      if (menu === "audio") enableNativeAudioChoices();
      const { video, bar, osd, advance } = setup("desktop");
      const name = menu === "settings" ? "Playback settings" : menu === "captions" ? "Subtitles" : "Audio track, English";
      const trigger = screen.getByRole("button", { name });
      touchPress(trigger);
      const close = screen.getByRole("button", { name: menu === "captions" ? "Close subtitles menu" : "Close playback settings" });
      advance(); expect(bar).toHaveClass("is-visible");
      touchPress(close);
      expect(trigger).toHaveFocus();
      advance();
      expect(bar).not.toHaveClass("is-visible"); expect(osd).not.toHaveClass("is-visible");
      expect(trigger).toHaveFocus(); expect(video.paused).toBe(false);
      act(() => trigger.blur()); act(() => trigger.focus());
      advance(); expect(bar).toHaveClass("is-visible"); expect(trigger).toHaveFocus();
    });

    it.each(["desktop", "touch"] as const)("[r3] retires %s-layout touch Details restoration after the actual child modal cleanup", (layout) => {
      const { video, bar, advance } = setup(layout);
      const trigger = screen.getByRole("button", { name: "Player details and shortcuts" });
      touchPress(trigger);
      const dialog = screen.getByRole("dialog", { name: "Player details and shortcuts" });
      expect(dialog).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
      touchPress(within(dialog).getByRole("button", { name: "Close playback information" }));
      expect(trigger).toHaveFocus();
      advance(); expect(bar).not.toHaveClass("is-visible"); expect(trigger).toHaveFocus();
      expect(video.paused).toBe(false);
      act(() => trigger.blur()); act(() => trigger.focus());
      advance(); expect(bar).toHaveClass("is-visible"); expect(trigger).toHaveFocus();
    });

    it.each(["settings", "captions", "details"] as const)("[r3] keeps keyboard %s modal restoration pinned", (menu) => {
      captionMenuMode.actual = true;
      const { bar, advance } = setup("desktop");
      const trigger = screen.getByRole("button", { name: menu === "settings" ? "Playback settings" : menu === "captions" ? "Subtitles" : "Player details and shortcuts" });
      fireEvent.keyDown(trigger, { key: "Tab" }); act(() => trigger.focus()); fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: menu === "settings" ? "Playback settings" : menu === "captions" ? "Subtitles" : "Player details and shortcuts" });
      expect(dialog).toHaveFocus();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(trigger).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("[r3] returns the question-mark shortcut to its actual non-header origin", () => {
      setup("desktop");
      const header = screen.getByRole("button", { name: "Player details and shortcuts" });
      touchPress(header);
      touchPress(screen.getByRole("button", { name: "Close playback information" }));
      const pane = screen.getByRole("dialog", { name: "Playing Chrome input" });
      act(() => pane.focus());
      const headerFocus = vi.spyOn(header, "focus"); headerFocus.mockClear();
      fireEvent.keyDown(pane, { key: "?" });
      const dialog = screen.getByRole("dialog", { name: "Player details and shortcuts" });
      expect(within(dialog).getByRole("tabpanel", { name: "Shortcuts" })).toBeInTheDocument();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(pane).toHaveFocus(); expect(headerFocus).not.toHaveBeenCalled();
    });

    it.each(["disconnected", "other-player", "different-owner"] as const)("[r3] does not add owned Details reconciliation for a %s origin", (stale) => {
      const { view, props } = setup("desktop");
      const trigger = screen.getByRole("button", { name: "Player details and shortcuts" });
      touchPress(trigger);
      const parent = trigger.parentElement!, next = trigger.nextSibling;
      const outside = document.createElement("div"); outside.className = "player";
      if (stale === "disconnected") trigger.remove();
      if (stale === "other-player") { document.body.append(outside); outside.append(trigger); }
      if (stale === "different-owner") view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
      const oldFocus = vi.spyOn(trigger, "focus"); oldFocus.mockClear();
      const fallback = vi.spyOn(screen.getByRole("button", { name: "Close player" }), "focus"); fallback.mockClear();
      try {
        touchPress(screen.getByRole("button", { name: "Close playback information" }));
        // The unchanged generic modal hook attempts its saved origin once.
        // No new owned reconciliation may re-focus or invent a fallback for it.
        expect(oldFocus).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
      } finally {
        if (trigger.parentElement !== parent) parent.insertBefore(trigger, next);
        outside.remove();
      }
    });

    it("[r3] does not substitute Settings for a disconnected desktop captions origin", () => {
      captionMenuMode.actual = true;
      setup("desktop");
      const trigger = screen.getByRole("button", { name: "Subtitles" });
      const settings = screen.getByRole("button", { name: "Playback settings" });
      touchPress(trigger);
      const parent = trigger.parentElement!, next = trigger.nextSibling;
      trigger.remove();
      const settingsFocus = vi.spyOn(settings, "focus"); settingsFocus.mockClear();
      try {
        touchPress(screen.getByRole("button", { name: "Close subtitles menu" }));
        expect(settingsFocus).not.toHaveBeenCalled();
      } finally { parent.insertBefore(trigger, next); }
    });

    it.each(["paused", "buffering", "settings", "captions", "scrubbing"] as const)("keeps chrome pinned for %s independently of touch focus", (reason) => {
      const { video, bar, advance } = setup();
      pointer(document.querySelector(".player")!, "pointerdown", "touch");
      if (reason === "paused") act(() => video.pause());
      if (reason === "buffering") fireEvent.waiting(video);
      if (reason === "settings") fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      if (reason === "captions") fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      if (reason === "scrubbing") pointer(screen.getByTestId("scrub-bar"), "pointerdown", "touch");
      advance(); expect(bar).toHaveClass("is-visible");
    });
  });

  describe("touch transport click ownership", () => {
    function pointer(button: HTMLElement, type: "pointerdown" | "pointerup" | "pointerover" | "pointerout", pointerType = "touch") {
      fireEvent(button, new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType }));
    }
    function setup() {
      vi.useFakeTimers();
      deviceKindMock.mockReturnValue("android");
      Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
        configurable: true,
        value: { getInsets: vi.fn(() => '{"top":0,"right":0,"bottom":0,"left":0}') },
      });
      render(<VideoPlayer url="https://x/transport-focus.mp4" title="Transport focus" onClose={() => {}} />);
      const player = screen.getByRole("dialog", { name: "Playing Transport focus" });
      expect(player).toHaveClass("is-touch-player");
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let paused = false;
      Object.defineProperties(video, {
        paused: { configurable: true, get: () => paused },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
        duration: { configurable: true, value: 900 },
        currentTime: { configurable: true, writable: true, value: 240.333 },
      });
      const play = vi.mocked(video.play), pause = vi.mocked(video.pause);
      play.mockImplementation(async () => { paused = false; fireEvent.play(video); fireEvent.playing(video); });
      pause.mockImplementation(() => { paused = true; fireEvent.pause(video); });
      fireEvent.canPlay(video); fireEvent.play(video); fireEvent.playing(video);
      act(() => video.pause());
      play.mockClear(); pause.mockClear();
      const bar = player.querySelector(".player-bar")!;
      const osd = player.querySelector(".player-osd")!;
      const transport = player.querySelector(".player-touch-transport")!;
      const advance = () => act(() => vi.advanceTimersByTime(3_201));
      return { video, play, pause, bar, osd, transport, advance };
    }
    function lateTouchFocus(button: HTMLElement) {
      pointer(button, "pointerdown"); pointer(button, "pointerup");
      act(() => vi.advanceTimersByTime(1));
      // Android can deliver native focus after the pointer cleanup turn.
      act(() => button.focus());
      fireEvent.click(button, { detail: 1 });
    }

    it("[transport-focus] retires late touch Play focus after resuming exactly once", () => {
      const { video, play, pause, bar, osd, transport, advance } = setup();
      const button = screen.getByRole("button", { name: "Play" });
      lateTouchFocus(button);
      expect(play).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false); expect(button).toHaveFocus();
      advance();
      expect(bar).not.toHaveClass("is-visible"); expect(osd).not.toHaveClass("is-visible");
      expect(transport).not.toHaveClass("is-visible"); expect(button).toHaveFocus();
      expect(video.currentTime).toBe(240.333);
    });

    it.each([["Back 10 seconds", 230.333], ["Forward 10 seconds", 250.333]] as const)("[transport-focus] retires late touch %s focus while seeking exactly once", (name, target) => {
      const { video, play, pause, bar, osd, transport, advance } = setup();
      act(() => { void video.play(); }); play.mockClear(); pause.mockClear();
      let clock = video.currentTime;
      const writeTime = vi.fn((value: number) => { clock = value; });
      Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set: writeTime });
      const button = screen.getByRole("button", { name });
      lateTouchFocus(button);
      fireEvent.seeking(video); fireEvent.seeked(video);
      expect(writeTime).toHaveBeenCalledTimes(1); expect(writeTime).toHaveBeenCalledWith(target);
      expect(video.currentTime).toBe(target); expect(video.paused).toBe(false);
      expect(pause).not.toHaveBeenCalled(); expect(button).toHaveFocus();
      advance();
      expect(bar).not.toHaveClass("is-visible"); expect(osd).not.toHaveClass("is-visible");
      expect(transport).not.toHaveClass("is-visible"); expect(button).toHaveFocus();
    });

    it("[transport-focus] preserves the pause pin and resumes without retaining late touch Pause focus", () => {
      const { video, play, pause, bar, advance } = setup();
      act(() => { void video.play(); }); play.mockClear(); pause.mockClear();
      const button = screen.getByRole("button", { name: "Pause" });
      lateTouchFocus(button);
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true); expect(button).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
      act(() => { void video.play(); });
      advance(); expect(bar).not.toHaveClass("is-visible"); expect(button).toHaveFocus();
    });

    it("[transport-focus] preserves keyboard Play activation and its real focus pin", () => {
      const { video, play, pause, bar, advance } = setup();
      const button = screen.getByRole("button", { name: "Play" });
      fireEvent.keyDown(button, { key: "Tab" }); act(() => button.focus());
      fireEvent.keyDown(button, { key: "Enter" }); fireEvent.click(button, { detail: 0 });
      expect(play).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false); expect(button).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("[transport-focus] preserves independent assistive Play focus after an expired touch without activation", () => {
      const { video, play, pause, bar, advance } = setup();
      const button = screen.getByRole("button", { name: "Play" });
      pointer(button, "pointerdown"); pointer(button, "pointerup");
      act(() => vi.advanceTimersByTime(1));
      act(() => button.focus());
      fireEvent.click(button, { detail: 0 });
      expect(play).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false); expect(button).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
    });

    it("[transport-focus] preserves ordinary mouse hover until leave after one Play activation", () => {
      const { video, play, pause, bar, transport, advance } = setup();
      const button = screen.getByRole("button", { name: "Play" });
      pointer(transport as HTMLElement, "pointerover", "mouse");
      pointer(button, "pointerdown", "mouse"); pointer(button, "pointerup", "mouse");
      act(() => vi.advanceTimersByTime(1)); act(() => button.focus());
      fireEvent.click(button, { detail: 1 });
      expect(play).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false); expect(button).toHaveFocus();
      advance(); expect(bar).toHaveClass("is-visible");
      pointer(transport as HTMLElement, "pointerout", "mouse");
      advance(); expect(bar).not.toHaveClass("is-visible"); expect(button).toHaveFocus();
    });
  });

  it("hides inactive web chrome, preserves it for pause or menus, and reveals it on pointer activity", () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      const bar = document.querySelector(".player-bar") as HTMLElement;
      const osd = document.querySelector(".player-osd") as HTMLElement;
      const player = document.querySelector(".player") as HTMLElement;
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      fireEvent.canPlay(video);

      act(() => vi.advanceTimersByTime(3200));
      expect(bar).not.toHaveClass("is-visible");
      expect(osd).not.toHaveClass("is-visible");
      expect(document.querySelector(".player-osd .chip")).toHaveAttribute("tabindex", "-1");

      fireEvent.pointerMove(player);
      expect(bar).toHaveClass("is-visible");
      expect(osd).toHaveClass("is-visible");

      fireEvent(video, new Event("pause"));
      act(() => vi.advanceTimersByTime(3200));
      expect(bar).toHaveClass("is-visible");

      fireEvent(video, new Event("play"));
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      act(() => vi.advanceTimersByTime(3200));
      expect(osd).toHaveClass("is-visible");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the first stationary touch to reveal hidden controls before toggling playback", () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      fireEvent.canPlay(video);
      const play = vi.mocked(video.play);
      play.mockClear();
      act(() => vi.advanceTimersByTime(3200));
      expect(document.querySelector(".player-osd")).not.toHaveClass("is-visible");

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video);
      expect(document.querySelector(".player-osd")).toHaveClass("is-visible");
      expect(play).not.toHaveBeenCalled();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reveal-before-play semantics in the shared touch presentation", () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      fireEvent.canPlay(video);
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      const play = vi.mocked(video.play);
      play.mockClear();
      act(() => vi.advanceTimersByTime(3200));
      expect(document.querySelector(".player-osd")).not.toHaveClass("is-visible");

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 50 });
      expect(document.querySelector(".player-osd")).toHaveClass("is-visible");
      expect(play).not.toHaveBeenCalled();

      fireEvent.pointerDown(video, { pointerType: "touch" });
      fireEvent.click(video, { clientX: 50 });
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("video gesture reveal ownership", () => {
    function setup(layout: "desktop" | "ios" | "android" = "ios") {
      vi.useFakeTimers();
      deviceKindMock.mockReturnValue(layout === "desktop" ? "mac" : layout);
      if (layout === "android") {
        (window as unknown as Record<string, unknown>).__YAWF_NATIVE_SAFE_AREA__ = {
          getInsets: vi.fn(),
        };
      }
      const props = { url: "https://x/gesture.mp4", title: "Gesture ownership", onClose: () => {} };
      const view = render(<VideoPlayer {...props} />);
      expect(document.querySelector(".player")!.classList.contains("is-touch-player"))
        .toBe(layout !== "desktop");
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let paused = false;
      Object.defineProperties(video, {
        paused: { configurable: true, get: () => paused },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
        duration: { configurable: true, value: 900 },
        currentTime: { configurable: true, writable: true, value: 40 },
      });
      const play = vi.mocked(video.play);
      const pause = vi.mocked(video.pause);
      play.mockImplementation(async () => {
        paused = false; fireEvent.play(video); fireEvent.playing(video);
      });
      pause.mockImplementation(() => { paused = true; fireEvent.pause(video); });
      video.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
      fireEvent.canPlay(video); fireEvent.play(video); fireEvent.playing(video);
      act(() => vi.advanceTimersByTime(3_201));
      expect(document.querySelector(".player-bar")).not.toHaveClass("is-visible");
      play.mockClear(); pause.mockClear();
      return { video, play, pause, view, props };
    }

    function pointer(video: HTMLVideoElement, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", pointerType = "touch", pointerId = 1) {
      fireEvent(video, new PointerEvent(type, {
        bubbles: true, pointerType, pointerId, clientX: 50, clientY: 50,
      }));
    }
    function movingGesture(video: HTMLVideoElement, pointerType = "touch", pointerId = 1) {
      pointer(video, "pointerdown", pointerType, pointerId);
      pointer(video, "pointermove", pointerType, pointerId);
      expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
      pointer(video, "pointerup", pointerType, pointerId);
      fireEvent.click(video, { detail: 1, clientX: 50, clientY: 50 });
    }

    it.each(["desktop", "ios", "android"] as const)("[gesture-reveal] keeps a moving hidden touch reveal-only while playing on %s", (layout) => {
      const { video, play, pause } = setup(layout);
      movingGesture(video);
      expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
      expect(play).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false);
    });

    it.each(["desktop", "ios", "android"] as const)("[gesture-reveal] keeps a moving hidden pen reveal-only while playing on %s", (layout) => {
      const { video, play, pause } = setup(layout);
      movingGesture(video, "pen");
      expect(play).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(false);
    });

    it("[gesture-reveal] does not resume when playback pauses during a hidden reveal gesture", () => {
      const { video, play, pause } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove");
      act(() => video.pause()); pause.mockClear();
      pointer(video, "pointerup"); fireEvent.click(video, { detail: 1, clientX: 50 });
      expect(play).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
    });

    it.each(["touch", "pen"])("[gesture-control] toggles exactly once on the second visible %s gesture", (pointerType) => {
      const { video, play, pause } = setup();
      movingGesture(video, pointerType);
      expect(pause).not.toHaveBeenCalled();
      movingGesture(video, pointerType, 2);
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
    });

    it("[gesture-control] preserves immediate mouse playback toggle after hidden pointer activity", () => {
      const { video, play, pause } = setup();
      movingGesture(video, "mouse");
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    });

    it("[gesture-control] leaves keyboard playback available during a pending reveal gesture", () => {
      const { video, play, pause } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove");
      fireEvent.keyDown(window, { key: " " });
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    });

    it("[gesture-control] clears canceled reveal ownership before an independent click", () => {
      const { video, play, pause } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove"); pointer(video, "pointercancel");
      fireEvent.click(video, { detail: 1, clientX: 50 });
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    });

    it("[gesture-control] replaces an abandoned hidden gesture with a new visible pointer", () => {
      const { video, play, pause } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove");
      pointer(video, "pointerdown", "mouse", 2); pointer(video, "pointerup", "mouse", 2);
      fireEvent.click(video, { detail: 1, clientX: 50 });
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    });

    it("[gesture-control] ignores cancellation from a different pointer", () => {
      const { video, play, pause } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove");
      pointer(video, "pointercancel", "touch", 2);
      pointer(video, "pointerup"); fireEvent.click(video, { detail: 1, clientX: 50 });
      expect(pause).not.toHaveBeenCalled(); expect(play).not.toHaveBeenCalled();
      expect(video.paused).toBe(false);
    });

    it("[gesture-control] consumes reveal ownership before an independent subsequent click", () => {
      const { video, play, pause } = setup();
      movingGesture(video);
      expect(pause).not.toHaveBeenCalled();
      fireEvent.click(video, { detail: 1, clientX: 50 });
      expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    });

    it("[gesture-control] does not transfer a hidden gesture to a replacement source", () => {
      const { video, view, props } = setup();
      pointer(video, "pointerdown"); pointer(video, "pointermove");
      view.rerender(<VideoPlayer {...props} url="https://x/next-gesture.mp4" />);
      const next = document.querySelector("video.player-video") as HTMLVideoElement;
      expect(next).not.toBe(video);
      Object.defineProperty(next, "paused", { configurable: true, value: false });
      fireEvent.canPlay(next); fireEvent.play(next); fireEvent.playing(next);
      const pause = vi.mocked(next.pause); pause.mockClear();
      fireEvent.click(next, { detail: 1, clientX: 50 });
      expect(pause).toHaveBeenCalledTimes(1);
    });
  });

  it("announces startup and rebuffering until media is playable again", () => {
    render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(screen.getByRole("status")).toHaveTextContent("Starting playback");

    fireEvent(video, new Event("canplay"));
    expect(screen.queryByText("Starting playback…")).toBeNull();
    fireEvent(video, new Event("waiting"));
    expect(screen.getByRole("status")).toHaveTextContent("Buffering");
    fireEvent(video, new Event("playing"));
    expect(screen.queryByText("Buffering…")).toBeNull();
  });

  it("surfaces startup recovery after a finite media-ready deadline", () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      act(() => vi.advanceTimersByTime(20_000));

      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
      expect(screen.getByText(/Playback did not become ready/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /external player/ })).toBeNull();
      expect(screen.getByText(/External playback is not available/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("grants a trusted canonical server transcode a 45 second startup and manifest budget", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example/yawf";
    render(
      <VideoPlayer
        url="https://server.example/yawf/api/stream/session-1/index.m3u8"
        engine="webview-hls-transcode"
        title="T"
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hlsInstances[0]?.config.manifestLoadPolicy?.default).toMatchObject({
      maxTimeToFirstByteMs: 45_000,
      maxLoadTimeMs: 45_000,
    });

    act(() => vi.advanceTimersByTime(44_999));
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
  });

  it("keeps provider HLS on the 20 second startup budget despite a stream-shaped path", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example/yawf";
    render(
      <VideoPlayer
        url="https://provider.example/api/stream/session-1/index.m3u8"
        engine="webview-hls-transcode"
        title="T"
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hlsInstances[0]?.config.manifestLoadPolicy?.default).toMatchObject({
      maxTimeToFirstByteMs: 20_000,
      maxLoadTimeMs: 20_000,
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
  });

  it("fences the startup deadline when the source changes", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <VideoPlayer url="https://x/first.mp4" title="T" onClose={() => {}} />,
      );
      act(() => vi.advanceTimersByTime(10_000));
      rerender(<VideoPlayer url="https://x/second.mp4" title="T" onClose={() => {}} />);
      act(() => vi.advanceTimersByTime(10_000));
      expect(screen.queryByText("Playback interrupted")).toBeNull();

      act(() => vi.advanceTimersByTime(10_000));
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks the startup deadline while cast suspension owns playback", async () => {
    vi.useFakeTimers();
    try {
      isTauriMock.mockReturnValue(true);
      deviceKindMock.mockReturnValue("android");
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
      act(() => vi.advanceTimersByTime(25_000));
      expect(screen.queryByText("Playback interrupted")).toBeNull();

      fireEvent.click(screen.getByText("test resume playback"));
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the scrubber stale while hidden and flushes it when chrome returns", () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      const player = document.querySelector(".player") as HTMLElement;
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      fireEvent.canPlay(video);
      act(() => vi.advanceTimersByTime(3200));
      scrubBarMock.mockClear();
      Object.defineProperty(video, "currentTime", { configurable: true, value: 42 });

      fireEvent.timeUpdate(video);
      expect(scrubBarMock).not.toHaveBeenCalled();

      fireEvent.pointerMove(player);
      expect(screen.getByTestId("scrub-bar")).toHaveAttribute("data-current-time", "42");
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns the progressive src directly on the <video>", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.src).toBe("https://x/test.mp4");
    // No hls.js for a progressive source.
    expect(hlsInstances).toHaveLength(0);
  });

  // Cross-device resume seeking. The interesting case is HLS, where `duration`
  // is NaN at loadedmetadata and only becomes known on a later durationchange - 
  // the seek must be retried then rather than silently dropped.
  function instrumentVideo(video: HTMLVideoElement, duration: number) {
    let dur = duration;
    let current = 0;
    Object.defineProperty(video, "duration", {
      configurable: true,
      get: () => dur,
      set: (v: number) => {
        dur = v;
      },
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => current,
      set: (v: number) => {
        current = v;
      },
    });
    return {
      setDuration: (v: number) => {
        dur = v;
      },
      currentTime: () => current,
    };
  }

  it("resumes to the saved position immediately when duration is known (progressive)", () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        onClose={() => {}}
        startPositionSeconds={120}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const probe = instrumentVideo(video, 3600);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(probe.currentTime()).toBe(120);
  });

  it("defers the resume seek until duration arrives, then applies it (HLS)", () => {
    render(
      <VideoPlayer
        url="https://x/stream.m3u8"
        title="T"
        onClose={() => {}}
        startPositionSeconds={120}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const probe = instrumentVideo(video, Number.NaN); // duration unknown at first
    // loadedmetadata with NaN duration must NOT seek (would clamp to 0 + stick).
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(probe.currentTime()).toBe(0);
    // Duration becomes known → durationchange retries and the seek lands.
    probe.setDuration(3600);
    video.dispatchEvent(new Event("durationchange"));
    expect(probe.currentTime()).toBe(120);
  });

  it("does not resume a basically-finished item (start within 10s of the end)", () => {
    render(
      <VideoPlayer
        url="https://x/test.mp4"
        title="T"
        onClose={() => {}}
        startPositionSeconds={3595}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const probe = instrumentVideo(video, 3600);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(probe.currentTime()).toBe(0);
  });

  it.each([3, 3595])("forces an exact recovery handoff at %s seconds", (start) => {
    render(
      <VideoPlayer
        url="https://x/recovered.mp4"
        title="T"
        onClose={() => {}}
        startPositionSeconds={start}
        initialHandoffState={{ paused: false, volume: 1, muted: false, playbackRate: 1 }}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const probe = instrumentVideo(video, 3600);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(probe.currentTime()).toBe(start);
  });

  // Keyboard shortcuts (invisible power-user nicety).
  describe("keyboard shortcuts", () => {
    function setup(startPaused = true) {
      render(
        <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let current = 0;
      let paused = startPaused;
      Object.defineProperty(video, "duration", { configurable: true, get: () => 100 });
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => current,
        set: (v: number) => {
          current = v;
        },
      });
      Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => paused,
      });
      video.volume = 0.5;
      video.muted = false;
      return { video, currentTime: () => current };
    }
    const press = (key: string, target?: EventTarget) =>
      (target ?? window).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    it("space plays when paused", () => {
      setup(true);
      press(" ");
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    });

    it("space pauses when playing", () => {
      const { video } = setup(false);
      press(" ");
      expect(video.pause).toHaveBeenCalled();
    });

    it("ArrowRight seeks +5s and ArrowLeft seeks -5s (clamped at 0)", () => {
      const probe = setup();
      press("ArrowRight");
      expect(probe.currentTime()).toBe(5);
      press("ArrowLeft");
      press("ArrowLeft");
      expect(probe.currentTime()).toBe(0); // clamped, never negative
    });

    it("l/j seek ±10s", () => {
      const probe = setup();
      press("l");
      expect(probe.currentTime()).toBe(10);
      press("j");
      expect(probe.currentTime()).toBe(0);
    });

    it("m toggles mute and arrows adjust volume", () => {
      const { video } = setup();
      press("m");
      expect(video.muted).toBe(true);
      press("ArrowDown");
      expect(video.volume).toBeCloseTo(0.4);
      press("ArrowUp");
      expect(video.volume).toBeCloseTo(0.5);
    });

    it("a number key seeks to that decile of the duration", () => {
      const probe = setup();
      press("5");
      expect(probe.currentTime()).toBe(50); // 50% of 100s
    });

    it("uses the full known timeline for a partial-stream number shortcut", async () => {
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const request = vi.fn(async (_quality: string, position: number) => ({
        url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
        timelineOffsetSeconds: position,
        startPositionSeconds: 0,
        quality: "480p" as const,
      }));
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p"
          engine="webview-hls-transcode"
          title="Example Movie"
          serverOptimized={{
            qualities: ["480p"],
            loadSourceInfo: async () => ({ durationSeconds: 600 }),
            request,
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: { configurable: true, value: 5, writable: true },
        paused: { configurable: true, value: true },
      });
      await waitFor(() => expect(
        screen.getByTestId("scrub-bar").getAttribute("data-duration"),
      ).toBe("600"));

      press("7");
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 420));
      expect(video.currentTime).toBe(5);
    });

    it("keeps in-window keyboard seeks local and requests a new partial window when crossed", async () => {
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const request = vi.fn(async (_quality: string, position: number) => ({
        url: `https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=${position}`,
        timelineOffsetSeconds: position,
        startPositionSeconds: 0,
        quality: "480p" as const,
      }));
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=100"
          engine="webview-hls-transcode"
          title="Example Movie"
          timelineOffsetSeconds={100}
          serverOptimized={{
            qualities: ["480p"],
            loadSourceInfo: async () => ({ durationSeconds: 600 }),
            request,
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      let currentTime = 5;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: {
          configurable: true,
          get: () => currentTime,
          set: (next: number) => { currentTime = next; },
        },
        paused: { configurable: true, value: true },
      });
      await waitFor(() => expect(
        screen.getByTestId("scrub-bar").getAttribute("data-duration"),
      ).toBe("600"));

      press("ArrowRight");
      expect(currentTime).toBe(10);
      expect(request).not.toHaveBeenCalled();
      currentTime = 11;
      press("ArrowRight");
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 116));
      expect(currentTime).toBe(11);
    });

    it("uses the unknown-total EVENT offset for keyboard relative seeks", async () => {
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const replacement = deferred<{
        url: string;
        timelineOffsetSeconds: number;
        startPositionSeconds: number;
        quality: "480p";
      }>();
      const request = vi.fn((_quality: string, _position: number) => replacement.promise);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
        { status: 200 },
      )));
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=531"
          engine="webview-hls-transcode"
          title="Example Movie"
          timelineOffsetSeconds={531}
          serverOptimized={{ qualities: ["480p"], request }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { configurable: true, value: 12 },
        currentTime: { configurable: true, value: 3, writable: true },
        paused: { configurable: true, value: true },
      });
      fireEvent.loadedMetadata(video);
      fireEvent.timeUpdate(video);

      press("j");
      await waitFor(() => expect(request).toHaveBeenCalledWith("480p", 524));
      await act(async () => {
        replacement.resolve({
          url: "https://server.example/api/stream/session-1/index.m3u8?quality=480p&start=524",
          timelineOffsetSeconds: 524,
          startPositionSeconds: 0,
          quality: "480p",
        });
        await replacement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
    });

    it("ignores shortcuts while a text field is focused", () => {
      setup(true);
      const input = document.createElement("input");
      document.body.appendChild(input);
      press(" ", input);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      input.remove();
    });

    it("yields Space/Enter to a focused button (doesn't hijack play/pause)", () => {
      setup(true);
      const button = document.createElement("button");
      document.body.appendChild(button);
      press(" ", button);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      button.remove();
    });

    it("isolates Playback settings from shortcuts and exposed video clicks", () => {
      const requestFullscreen = vi.fn().mockResolvedValue(undefined);
      const restoreRequestFullscreen = replaceProperty(
        HTMLElement.prototype,
        "requestFullscreen",
        requestFullscreen,
      );
      try {
        const { video } = setup(true);
        fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
        const dialog = screen.getByRole("dialog", { name: "Playback settings" });
        const play = vi.mocked(HTMLMediaElement.prototype.play);
        const pause = vi.mocked(HTMLMediaElement.prototype.pause);
        play.mockClear();
        pause.mockClear();

        fireEvent.keyDown(dialog, { key: " " });
        fireEvent.click(video);
        fireEvent.doubleClick(video);

        expect(play).not.toHaveBeenCalled();
        expect(pause).not.toHaveBeenCalled();
        expect(requestFullscreen).not.toHaveBeenCalled();
        expect(dialog).toBeInTheDocument();
      } finally {
        restoreRequestFullscreen();
      }
    });

    it("isolates the captions dialog from player shortcuts and stage clicks", () => {
      const { video } = setup(true);
      fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
      const dialog = screen.getByTestId("captions-menu");
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      fireEvent.keyDown(dialog, { key: " " });
      fireEvent.click(video);

      expect(play).not.toHaveBeenCalled();
      expect(dialog).toBeInTheDocument();
    });

    it("isolates Player details from player shortcuts and stage clicks", () => {
      const { video } = setup(true);
      fireEvent.click(
        screen.getByRole("button", { name: "Player details and shortcuts" }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Player details and shortcuts",
      });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();

      fireEvent.keyDown(dialog, { key: " " });
      fireEvent.click(video);

      expect(play).not.toHaveBeenCalled();
      expect(dialog).toBeInTheDocument();
    });

    it("ignores shortcuts when a modifier is held (so ⌘K still works)", () => {
      setup(true);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }),
      );
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    });

    it("? opens the merged panel to Shortcuts and Escape closes it first", async () => {
      setup(true);
      expect(screen.queryByRole("dialog", { name: "Player details and shortcuts" })).toBeNull();
      // "?" opens it (state update → wrap in act so React flushes).
      act(() => {
        press("?");
      });
      expect(screen.getByRole("tabpanel", { name: "Shortcuts" })).toBeInTheDocument();
      act(() => {
        press("Escape");
      });
      expect(screen.queryByRole("dialog", { name: "Player details and shortcuts" })).toBeNull();
    });

    it("shows the paused now-playing screen with a graceful title fallback", async () => {
      render(
        <VideoPlayer
          url="https://x/test.mp4"
          title="Fallback title"
          nowPlaying={{
            year: 2026,
            runtimeMinutes: 118,
            rating: 7.9,
            episodeLabel: "S2 E5 - The Arrival",
            overview: "A reveal changes everything.",
            backdropUrl: "https://image.test/backdrop.jpg",
          }}
          onClose={() => {}}
        />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      fireEvent.pause(video);
      expect(screen.getByLabelText(/^Paused:/)).toBeInTheDocument();
      expect(
        screen.getByText(
          (_, element) =>
            element?.classList.contains("player-pause-meta") === true &&
            element.textContent === "S2 E5 - The Arrival20261h 58m★ 7.9",
        ),
      ).toBeInTheDocument();

      // The whole pause screen is the resume affordance (no separate button).
      await userEvent.click(screen.getByLabelText(/^Paused:/));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      expect(screen.queryByLabelText(/^Paused:/)).toBeNull();
    });
  });

  it("renders <track> elements for loaded subtitle tracks", () => {
    subsState.tracks = [
      { id: "t1", label: "EN", language: "en", vttUrl: "blob:vtt1" },
    ];
    subsState.activeTrackId = "t1";
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const track = document.querySelector("track") as HTMLTrackElement;
    expect(track).not.toBeNull();
    expect(track).toHaveAttribute("label", "EN");
    expect(track).toHaveAttribute("srclang", "en");
  });

  it("marks the CC chip active and shows the dot when a track is active", () => {
    subsState.tracks = [
      { id: "t1", label: "EN", language: "en", vttUrl: "blob:vtt1" },
    ];
    subsState.activeTrackId = "t1";
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const cc = screen.getByRole("button", { name: "Subtitles" });
    expect(cc.className).toContain("is-active");
    expect(document.querySelector(".captions-active-dot")).not.toBeNull();
  });
});

describe("local pause resume media ownership", () => {
  it.each(["desktop overlay", "desktop Space", "Android touch", "Android Space"])(
    "preserves the nonzero media clock and source through %s resume",
    async (route) => {
      globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
      const android = route.startsWith("Android");
      deviceKindMock.mockReturnValue(android ? "android" : "mac");
      if (android) {
        Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
          configurable: true, value: { getInsets: vi.fn() },
        });
      }
      const stopInvocations = vi.fn();
      const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
      const mediaSession = {
        metadata: null,
        playbackState: "none",
        setPositionState: vi.fn(),
        setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
          handlers.set(action, handler == null ? null : (details) => {
            if (action === "stop") stopInvocations();
            handler(details);
          });
        }),
      } as unknown as MediaSession;
      const restoreMediaSession = replaceProperty(navigator, "mediaSession", mediaSession);
      const srcWrite = vi.spyOn(HTMLMediaElement.prototype, "src", "set");
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      const load = vi.mocked(HTMLMediaElement.prototype.load);
      let view: ReturnType<typeof render> | null = null;
      try {
        view = render(<VideoPlayer url="https://server.example/api/stream/local-resume" title="Resume ownership" onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        let currentTime = 73.1;
        let paused = false;
        const timeWrites = vi.fn((value: number) => { currentTime = value; });
        Object.defineProperties(video, {
          currentTime: { configurable: true, get: () => currentTime, set: timeWrites },
          duration: { configurable: true, get: () => 180 },
          readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_ENOUGH_DATA },
          paused: { configurable: true, get: () => paused },
        });
        // jsdom has no media engine. Model native play/pause events, not the
        // player's state setters, so the real parent paused rerender executes.
        play.mockImplementation(function (this: HTMLMediaElement) {
          expect(this).toBe(video);
          paused = false;
          fireEvent.play(this);
          fireEvent.playing(this);
          return Promise.resolve();
        });
        pause.mockImplementation(function (this: HTMLMediaElement) {
          expect(this).toBe(video);
          paused = true;
          fireEvent.pause(this);
        });
        fireEvent.loadedMetadata(video);
        fireEvent.canPlay(video);
        fireEvent.play(video);
        fireEvent.playing(video);
        fireEvent.timeUpdate(video);
        expect(handlers.get("stop")).toEqual(expect.any(Function));
        const source = video.src;
        const loadstart = vi.fn();
        const emptied = vi.fn();
        video.addEventListener("loadstart", loadstart);
        video.addEventListener("emptied", emptied);
        srcWrite.mockClear();
        load.mockClear();
        timeWrites.mockClear();
        play.mockClear();
        pause.mockClear();

        await userEvent.click(screen.getByRole("button", { name: /^Pause$/ }));
        expect(video.paused).toBe(true);
        expect(pause).toHaveBeenCalledTimes(1);
        expect(document.querySelector("video.player-video")).toBe(video);
        // Late readiness events must not reapply the initial position during
        // an ordinary local pause or after the parent's paused UI rerenders.
        fireEvent.progress(video);
        fireEvent.canPlay(video);
        expect(video.currentTime).toBe(73.1);
        if (route === "desktop overlay") {
          await userEvent.click(screen.getByLabelText(/^Paused:/));
        } else if (route === "Android touch") {
          await userEvent.click(screen.getByRole("button", { name: /^Play$/ }));
        } else {
          act(() => {
            fireEvent.keyDown(window, { key: " ", code: "Space", cancelable: true });
          });
        }
        fireEvent.progress(video);
        fireEvent.canPlay(video);
        await act(async () => { await Promise.resolve(); });

        expect(play).toHaveBeenCalledTimes(1);
        expect(video.paused).toBe(false);
        expect(document.querySelector("video.player-video")).toBe(video);
        expect(video.src).toBe(source);
        expect(video.currentTime).toBe(73.1);
        expect(timeWrites).not.toHaveBeenCalled();
        expect(srcWrite).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
        expect(loadstart).not.toHaveBeenCalled();
        expect(emptied).not.toHaveBeenCalled();
        expect(stopInvocations).not.toHaveBeenCalled();
      } finally {
        view?.unmount();
        srcWrite.mockRestore();
        restoreMediaSession();
      }
    },
  );
});

describe("post-start webview stall recovery", () => {
  function playingMedia(video: HTMLVideoElement) {
    // jsdom does not update readonly media state when playing is dispatched.
    const state = { paused: false, seeking: false, ended: false };
    for (const key of ["paused", "seeking", "ended"] as const) {
      Object.defineProperty(video, key, { configurable: true, get: () => state[key] });
    }
    fireEvent.playing(video);
    return state;
  }

  async function beginDeferredRecovery(kind: "automatic" | "manual") {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const refresh = vi.fn(() => pending.promise);
    if (kind === "manual") refresh.mockRejectedValueOnce(new Error("Initial resolution failed"));
    const props = { title: "Recovery owner", refreshCurrentSource: refresh, onClose: () => {} };
    const view = render(<VideoPlayer {...props} url="https://x/old.mp4" sourceRevision={1} />);
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    original.currentTime = 40; playingMedia(original);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS); });
    if (kind === "manual") {
      fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
      await act(async () => { await Promise.resolve(); });
    }
    expect(refresh).toHaveBeenCalledTimes(kind === "automatic" ? 1 : 2);
    return { view, props, pending, refresh };
  }
  async function settleRecovery(pending: ReturnType<typeof deferred<void>>, outcome: "reject" | "timeout" | "resolve") {
    await act(async () => {
      if (outcome === "reject") pending.reject(new Error("Old resolution failed late"));
      else if (outcome === "resolve") pending.resolve();
      else await vi.advanceTimersByTimeAsync(FRESH_STREAM_RESOLUTION_TIMEOUT_MS);
      await Promise.resolve();
    });
  }

  it.each([
    ["automatic", "URL", "reject"], ["automatic", "URL", "timeout"], ["automatic", "URL", "resolve"],
    ["automatic", "revision", "reject"], ["automatic", "revision", "timeout"], ["automatic", "revision", "resolve"],
    ["manual", "URL", "reject"], ["manual", "URL", "timeout"], ["manual", "URL", "resolve"],
    ["manual", "revision", "reject"], ["manual", "revision", "timeout"], ["manual", "revision", "resolve"],
  ] as const)("ignores stale %s recovery after committed %s replacement and %s", async (kind, replacement, outcome) => {
    const f = await beginDeferredRecovery(kind);
    f.view.rerender(<VideoPlayer {...f.props} url={replacement === "URL" ? "https://x/new.mp4" : "https://x/old.mp4"} sourceRevision={2} />);
    const successor = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(successor); fireEvent.pause(successor);
    successor.currentTime = 73.1; successor.playbackRate = 1.25; successor.volume = 0.4; successor.muted = true;
    const pauseCalls = vi.mocked(successor.pause).mock.calls.length;
    const loadCalls = vi.mocked(successor.load).mock.calls.length;
    const source = successor.src;
    recordDiagnosticMock.mockClear();
    await settleRecovery(f.pending, outcome);
    expect(document.querySelector("video.player-video")).toBe(successor);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(successor.src).toBe(source); expect(successor.currentTime).toBe(73.1);
    expect(successor.playbackRate).toBe(1.25); expect(successor.volume).toBe(0.4); expect(successor.muted).toBe(true);
    expect(successor.pause).toHaveBeenCalledTimes(pauseCalls); expect(successor.load).toHaveBeenCalledTimes(loadCalls);
    expect(recordDiagnosticMock.mock.calls.filter(([, code]) => String(code).startsWith("stall."))).toHaveLength(0);
  });
  it.each([
    ["automatic", "reject"], ["automatic", "timeout"], ["automatic", "resolve"],
    ["manual", "reject"], ["manual", "timeout"], ["manual", "resolve"],
  ] as const)("does not publish %s recovery %s after unmount", async (kind, outcome) => {
    const f = await beginDeferredRecovery(kind);
    f.view.unmount(); recordDiagnosticMock.mockClear();
    await settleRecovery(f.pending, outcome);
    expect(recordDiagnosticMock).not.toHaveBeenCalled();
    expect(document.querySelector("video.player-video")).toBeNull();
  });
  it.each(["URL", "revision"] as const)("rejects an old saved stall callback after committed %s replacement", async (replacement) => {
    stallRecoveryObserver.enabled = true; stallRecoveryObserver.callbacks = [];
    try {
      const refresh = vi.fn(async () => {});
      const props = { title: "Saved recovery", refreshCurrentSource: refresh, onClose: () => {} };
      const view = render(<VideoPlayer {...props} url="https://x/old.mp4" sourceRevision={1} />);
      const saved = stallRecoveryObserver.callbacks[0]!; expect(saved).toBeDefined();
      view.rerender(<VideoPlayer {...props} url={replacement === "URL" ? "https://x/new.mp4" : "https://x/old.mp4"} sourceRevision={2} />);
      const successor = document.querySelector("video.player-video");
      let accepted = true;
      await act(async () => { accepted = await saved(40, { paused: false, volume: 1, muted: false, playbackRate: 1 }); });
      expect(accepted).toBe(false); expect(refresh).not.toHaveBeenCalled();
      expect(document.querySelector("video.player-video")).toBe(successor); expect(screen.queryByRole("alert")).toBeNull();
    } finally { stallRecoveryObserver.enabled = false; stallRecoveryObserver.callbacks = []; }
  });
  it.each(["automatic", "manual"] as const)("keeps the committed %s recovery authoritative through an abandoned render", async (kind) => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const refresh = vi.fn(() => pending.promise);
    if (kind === "manual") refresh.mockRejectedValueOnce(new Error("Initial resolution failed"));
    let choose: (value: boolean) => void = () => {};
    let speculative = 0;
    const blocked = new Promise<void>(() => {});
    function Gate({ replacement }: { replacement: boolean }) { if (replacement) { speculative += 1; throw blocked; } return null; }
    function Scenario() {
      const [replacement, setReplacement] = useState(false); choose = setReplacement;
      return <Suspense fallback={<div>Speculative recovery</div>}>
        <VideoPlayer title="Committed recovery" url={replacement ? "https://x/uncommitted.mp4" : "https://x/old.mp4"} refreshCurrentSource={refresh} onClose={() => {}} />
        <Gate replacement={replacement} />
      </Suspense>;
    }
    render(<Scenario />); const original = document.querySelector("video.player-video") as HTMLVideoElement;
    original.currentTime = 40; playingMedia(original);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS); });
    if (kind === "manual") fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    act(() => { startTransition(() => choose(true)); });
    expect(speculative).toBeGreaterThan(0);
    await settleRecovery(pending, "reject");
    expect(screen.getByRole("alert")).toHaveTextContent("A fresh stream could not be prepared");
    act(() => choose(false));
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeEnabled();
    expect(document.querySelector("video.player-video")).toBeNull();
  });
  it("does not clear a successor manual request when an older automatic request rejects", async () => {
    const f = await beginDeferredRecovery("automatic");
    deviceKindMock.mockReturnValue("ios");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { status: 404 }) : new Response("#EXTM3U\n480p.m3u8?generation=transcode-new\n")));
    const next = deferred<void>(); f.refresh.mockImplementationOnce(() => next.promise);
    f.view.rerender(<VideoPlayer {...f.props} url="https://server.example/api/stream/new/index.m3u8?quality=480p" sourceRevision={2}
      serverOptimized={{ qualities: ["480p"], request: async () => { throw new Error("Unexpected optimization"); } }} />);
    await act(async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    await settleRecovery(f.pending, "reject");
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("This stream has expired");
    await settleRecovery(next, "reject");
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeEnabled();
  });

  it("keeps advancing live media when progress events are delayed past the watchdog", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/movie.mp4" title="T" refreshCurrentSource={refreshCurrentSource} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40;
    playingMedia(video);
    const originalSrc = video.src;
    const pauseCalls = vi.mocked(video.pause).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    video.currentTime = 60;
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(video.src).toBe(originalSrc);
    expect(video.pause).toHaveBeenCalledTimes(pauseCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    video.currentTime = 80;
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    // Re-arming must not disable a later genuine unchanged-clock stall.
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(80, expect.objectContaining({ paused: false }));
  });

  it("re-arms on real clock progress in a playing event just before the stall deadline", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/movie.mp4" title="T" refreshCurrentSource={refreshCurrentSource} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40;
    playingMedia(video);
    const originalSrc = video.src;
    const pauseCalls = vi.mocked(video.pause).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    video.currentTime = 60;
    fireEvent.playing(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(video.src).toBe(originalSrc);
    expect(video.pause).toHaveBeenCalledTimes(pauseCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 2); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(60, expect.objectContaining({ paused: false }));
  });

  it("does not let unchanged playing-event noise defer a true 30-second stall", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/movie.mp4" title="T" refreshCurrentSource={refreshCurrentSource} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40;
    playingMedia(video);
    for (const delay of [10_000, 10_000, POST_START_STALL_TIMEOUT_MS - 20_001]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      fireEvent.playing(video);
      expect(refreshCurrentSource).not.toHaveBeenCalled();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(40, expect.objectContaining({ paused: false }));
  });

  it.each(["paused", "seeking", "ended"] as const)("checks live %s before delayed media events reach the watchdog", async (key) => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/movie.mp4" title="T" refreshCurrentSource={refreshCurrentSource} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40;
    const state = playingMedia(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    state[key] = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    expect(document.querySelector("video.player-video")).toBe(video);
  });

  it("keeps the watchdog suspended during cast ownership and restarts its full window on return", async () => {
    vi.useFakeTimers();
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    const refreshCurrentSource = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/movie.mp4" title="T" refreshCurrentSource={refreshCurrentSource} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40;
    playingMedia(video);
    fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS * 2); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("test resume playback"));
    playingMedia(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
  });

  it("does not let a replaced video's timer or late events recover its successor", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    const props = { title: "T", refreshCurrentSource, onClose: () => {} };
    const view = render(<VideoPlayer {...props} url="https://x/old.mp4" />);
    const oldVideo = document.querySelector("video.player-video") as HTMLVideoElement;
    oldVideo.currentTime = 40;
    playingMedia(oldVideo);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    view.rerender(<VideoPlayer {...props} url="https://x/new.mp4" />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video).not.toBe(oldVideo);
    video.currentTime = 80;
    playingMedia(video);
    const pauseCalls = vi.mocked(video.pause).mock.calls.length;
    fireEvent.timeUpdate(oldVideo);
    fireEvent.pause(oldVideo);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(video.pause).toHaveBeenCalledTimes(pauseCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(80, expect.objectContaining({ paused: false }));
  });

  it("freshly resolves once, resumes at the absolute position, then requires manual Retry", async () => {
    vi.useFakeTimers();
    let bumpRevision: (() => void) | null = null;
    const refreshCurrentSource = vi.fn(async () => {
      bumpRevision?.();
    });
    function Harness() {
      const [sourceRevision, setSourceRevision] = React.useState(0);
      bumpRevision = () => setSourceRevision((current) => current + 1);
      return (
        <VideoPlayer
          url="https://x/original.mp4"
          sourceRevision={sourceRevision}
          title="T"
          timelineOffsetSeconds={10}
          refreshCurrentSource={refreshCurrentSource}
          onClose={() => {}}
        />
      );
    }
    const React = await import("react");
    render(<Harness />);
    let video = document.querySelector("video.player-video") as HTMLVideoElement;
    const originalVideo = video;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 40, writable: true });
    Object.defineProperty(video, "volume", { configurable: true, value: 0.4, writable: true });
    playingMedia(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS);
    });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(
      50,
      expect.objectContaining({ volume: 0.4, paused: false }),
    );

    video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video).not.toBe(originalVideo);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 65, writable: true });
    playingMedia(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS);
    });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Retry to request a fresh stream");

    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await act(async () => { await Promise.resolve(); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(2);
    expect(refreshCurrentSource).toHaveBeenLastCalledWith(
      75,
      expect.objectContaining({ paused: false }),
    );
  });

  it("treats media progress as activity and never trips during a user pause", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="T"
        refreshCurrentSource={refreshCurrentSource}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    let bufferedEnd = 50;
    Object.defineProperty(video, "buffered", {
      configurable: true,
      value: {
        length: 1,
        start: () => 0,
        end: () => bufferedEnd,
      },
    });
    playingMedia(video);
    fireEvent.progress(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1_000);
    });
    bufferedEnd = 60;
    fireEvent.progress(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
    fireEvent.pause(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS * 2);
    });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
  });

  it("does not let unchanged progress noise mask a stall", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="T"
        refreshCurrentSource={refreshCurrentSource}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "buffered", {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 50 },
    });
    playingMedia(video);
    fireEvent.progress(video);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS - 1_000);
    });
    fireEvent.progress(video);
    fireEvent.canPlay(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
  });

  it("stays disabled when scrubbing ends before the media seek completes", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(async () => {});
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="T"
        refreshCurrentSource={refreshCurrentSource}
        onClose={() => {}}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    playingMedia(video);
    fireEvent.seeking(video);
    const scrubber = screen.getByTestId("scrub-bar");
    fireEvent.pointerDown(scrubber);
    fireEvent.pointerUp(scrubber);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POST_START_STALL_TIMEOUT_MS * 2);
    });
    expect(refreshCurrentSource).not.toHaveBeenCalled();
  });

  it("bounds a never-settling fresh resolution and exposes Retry", async () => {
    vi.useFakeTimers();
    const refreshCurrentSource = vi.fn(() => new Promise<void>(() => {}));
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="T"
        refreshCurrentSource={refreshCurrentSource}
        onClose={() => {}}
      />,
    );
    playingMedia(document.querySelector("video.player-video") as HTMLVideoElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        POST_START_STALL_TIMEOUT_MS + FRESH_STREAM_RESOLUTION_TIMEOUT_MS,
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Retry");
    expect(refreshCurrentSource).toHaveBeenCalledTimes(1);
  });
});

// ---- Captions popover toggle ----------------------------------------------

describe("captions toggle", () => {
  it("opens CaptionsMenu on CC click and reflects aria-expanded", async () => {
    render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
    const cc = screen.getByRole("button", { name: "Subtitles" });
    expect(cc).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("captions-menu")).toBeNull();

    await userEvent.click(cc);
    expect(cc).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("captions-menu")).toBeInTheDocument();
  });

  it("closes CaptionsMenu on a second CC click", async () => {
    render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
    const cc = screen.getByRole("button", { name: "Subtitles" });
    await userEvent.click(cc);
    expect(screen.getByTestId("captions-menu")).toBeInTheDocument();
    await userEvent.click(cc);
    expect(cc).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("captions-menu")).toBeNull();
  });

  it("closes CaptionsMenu via its onClose callback", async () => {
    render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    const menu = screen.getByTestId("captions-menu");
    await userEvent.click(within(menu).getByText("close-captions"));
    expect(screen.queryByTestId("captions-menu")).toBeNull();
  });
});

// ---- HLS source branch -----------------------------------------------------

describe("HLS source attach", () => {
  // hls.js (~151 KB gz) is now fetched on demand, only once an .m3u8 the browser
  // cannot play natively is reached - so the attach is async and these await it.
  it("leaves ordinary nonexact HLS startup on the hls.js default", async () => {
    render(
      <VideoPlayer
        url="https://x/stream.m3u8"
        title="T"
        startPositionSeconds={120}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].config).not.toHaveProperty("startPosition");
  });

  it("credentials only the configured server's mounted HLS session requests", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example/yawf";
    render(
      <VideoPlayer
        url="https://server.example/yawf/api/stream/session-1/index.m3u8"
        title="T"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
      "https://server.example/yawf/api/stream/session-1/index.m3u8",
    );
    expect(hlsInstances[0].attachMedia).toHaveBeenCalled();
    const xhr = { withCredentials: false } as XMLHttpRequest;
    hlsInstances[0].config.xhrSetup?.(
      xhr,
      "https://server.example/yawf/api/stream/session-1/segment-1.ts",
    );
    expect(xhr.withCredentials).toBe(true);
  });

  it("does not credential a provider CDN even when its URL contains an API stream path", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example/yawf";
    render(
      <VideoPlayer
        url="https://provider-cdn.example/api/stream/session-1/index.m3u8?next=/api/stream/"
        title="T"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const xhr = { withCredentials: true } as XMLHttpRequest;
    hlsInstances[0].config.xhrSetup?.(
      xhr,
      "https://provider-cdn.example/api/stream/session-1/segment-1.ts",
    );
    expect(xhr.withCredentials).toBe(false);
  });

  it("uses the global HLS audio default after track discovery without moving the control", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    render(
      <VideoPlayer
        url="https://x/stream.m3u8"
        title="T"
        playerPreferences={{ defaultAudioLanguage: "Spanish" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    hlsInstances[0].audioTracks = [
      { name: "English", lang: "eng" },
      { name: "Spanish", lang: "und" },
    ];
    const manifestHandler = hlsInstances[0].on.mock.calls.find(
      ([event]) => event === "manifestParsed",
    )?.[1] as (() => void) | undefined;
    if (manifestHandler == null) throw new Error("manifest handler missing");
    act(manifestHandler);

    expect(hlsInstances[0].audioTrack).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "Spanish" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    expect(hlsInstances[0].audioTrack).toBe(0);
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  });

  it("expands HLS code-only labels in the menu and Audio shortcut", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    render(<VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    hlsInstances[0].audioTracks = [
      { name: "eng", lang: "eng" },
      { name: "fre", lang: "fre" },
    ];
    hlsInstances[0].audioTrack = 0;
    const manifestHandler = hlsInstances[0].on.mock.calls.find(
      ([event]) => event === "manifestParsed",
    )?.[1] as (() => void) | undefined;
    if (manifestHandler == null) throw new Error("manifest handler missing");
    act(manifestHandler);

    const trigger = screen.getByRole("button", { name: "Audio track, English" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "French" }));
    expect(hlsInstances[0].audioTrack).toBe(1);
  });

  it("labels an unnamed HLS undetermined audio track as Audio 3 in the product menu", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(() => "");
    render(<VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    hlsInstances[0].audioTracks = [
      { name: "eng", lang: "eng" },
      { name: "", lang: "und" },
      { name: "", lang: "und" },
    ];
    hlsInstances[0].audioTrack = 0;
    const handler = hlsInstances[0].on.mock.calls.find(([event]) => event === "manifestParsed")?.[1] as (() => void) | undefined;
    if (handler == null) throw new Error("manifest handler missing");
    act(handler);
    fireEvent.click(screen.getByRole("button", { name: "Audio track, English" }));
    expect(screen.getByRole("button", { name: "Audio 3" })).toBeInTheDocument();
  });

  it("selects browser-native audio tracks when AudioTrackList is exposed", async () => {
    const tracks = Object.assign(new EventTarget(), {
      0: { id: "en", label: "English", language: "eng", enabled: true },
      1: { id: "fr", label: "French", language: "fra", enabled: false },
      length: 2,
      item(index: number) {
        return this[index as 0 | 1] ?? null;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true,
      get: () => tracks,
    });

    render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "French" }));
    expect(tracks[0].enabled).toBe(false);
    expect(tracks[1].enabled).toBe(true);
    expect(screen.getByRole("button", { name: "French" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reconciles a duplicate native selection to the prior preference without trapping later native choices", async () => {
    type MutableAudioTrack = {
      id: string;
      label: string;
      language: string;
      enabled: boolean;
      readonly writes: number;
      setNativeEnabled(value: boolean): void;
    };
    const nativeList = () => {
      const events = new EventTarget();
      const makeTrack = (
        id: string,
        label: string,
        language: string,
        initialEnabled: boolean,
      ): MutableAudioTrack => {
        let enabled = initialEnabled;
        let writes = 0;
        return {
          id,
          label,
          language,
          get enabled() { return enabled; },
          set enabled(value: boolean) {
            writes += 1;
            if (writes > 8) throw new Error("native audio reconciliation looped");
            enabled = value;
            events.dispatchEvent(new Event("change"));
          },
          get writes() { return writes; },
          setNativeEnabled(value: boolean) { enabled = value; },
        };
      };
      const english = makeTrack("en", "English", "eng", true);
      const french = makeTrack("fr", "French", "fra", false);
      const tracks = Object.assign(events, {
        0: english,
        1: french,
        length: 2,
        item(index: number) {
          return this[index as 0 | 1] ?? null;
        },
      });
      return { tracks, english, french };
    };

    const preferred = nativeList();
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true,
      get: () => preferred.tracks,
    });
    const onProgress = vi.fn();
    const mounted = render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="T"
        playerPreferences={{ defaultAudioLanguage: "French" }}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: "French" }),
    ).toHaveAttribute("aria-pressed", "true"));
    expect(preferred.english.enabled).toBe(false);
    expect(preferred.french.enabled).toBe(true);

    act(() => { preferred.english.enabled = true; });
    expect(preferred.english.enabled).toBe(false);
    expect(preferred.french.enabled).toBe(true);
    expect(screen.getByRole("button", { name: "French" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(preferred.english.writes + preferred.french.writes).toBeLessThanOrEqual(4);

    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 12 },
      duration: { configurable: true, value: 120 },
    });
    fireEvent.timeUpdate(video);
    expect(onProgress).toHaveBeenLastCalledWith(
      12,
      120,
      expect.objectContaining({ preferredAudioId: "fr", preferredAudioLang: "fra" }),
    );

    act(() => {
      preferred.english.setNativeEnabled(true);
      preferred.french.setNativeEnabled(false);
      preferred.tracks.dispatchEvent(new Event("change"));
    });
    expect(preferred.english.enabled).toBe(true);
    expect(preferred.french.enabled).toBe(false);
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    mounted.unmount();

    const unresolved = nativeList();
    unresolved.french.setNativeEnabled(true);
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true,
      get: () => unresolved.tracks,
    });
    render(
      <VideoPlayer
        url="https://x/other.mp4"
        title="Other"
        savedPrefs={{ preferredAudioId: "missing", preferredAudioLang: "zzz" }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(unresolved.english.enabled).toBe(true);
    expect(unresolved.french.enabled).toBe(true);
    expect(unresolved.english.writes + unresolved.french.writes).toBe(0);
  });

  it("expands browser-native code-only labels without changing browser track IDs", async () => {
    const tracks = Object.assign(new EventTarget(), {
      0: { id: "audio-en", label: "eng", language: "eng", enabled: true },
      1: { id: "audio-fr", label: "fre", language: "fre", enabled: false },
      length: 2,
      item(index: number) {
        return this[index as 0 | 1] ?? null;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
      configurable: true,
      get: () => tracks,
    });

    render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
    const trigger = await screen.findByRole("button", { name: "Audio track, English" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "French" }));

    expect(tracks[0].enabled).toBe(false);
    expect(tracks[1].enabled).toBe(true);
    expect(screen.getByRole("button", { name: "French" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("explains honestly when the browser does not expose alternate audio", async () => {
    render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));

    expect(screen.getByText(/does not expose alternate audio tracks/i)).toBeInTheDocument();
  });

  it("retries bounded fatal HLS network errors before surfacing recovery UI", async () => {
    vi.useFakeTimers();
    try {
      (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
        () => "",
      );
      render(<VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />);
      await act(async () => Promise.resolve());
      expect(hlsInstances).toHaveLength(1);
      const handler = hlsInstances[0].on.mock.calls.find(([event]) => event === "hlsError")?.[1] as (
        event: string,
        data: { fatal: boolean; type: string },
      ) => void;

      act(() => handler("hlsError", { fatal: true, type: "networkError" }));
      act(() => vi.advanceTimersByTime(500));
      expect(hlsInstances[0].startLoad).toHaveBeenCalledTimes(1);

      act(() => handler("hlsError", { fatal: true, type: "networkError" }));
      act(() => vi.advanceTimersByTime(1000));
      expect(hlsInstances[0].startLoad).toHaveBeenCalledTimes(2);

      act(() => handler("hlsError", { fatal: true, type: "networkError" }));
      expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
      expect(screen.getByText(/after two retries/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the manifest URL for fatal manifest load retries", async () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/manifest.m3u8" title="T" onClose={() => {}} />);
      await act(async () => Promise.resolve());
      const handler = hlsInstances[0].on.mock.calls.find(([event]) => event === "hlsError")?.[1] as (
        event: string,
        data: { fatal: boolean; type: string; details: string },
      ) => void;
      hlsInstances[0].loadSource.mockClear();

      act(() => handler("hlsError", {
        fatal: true,
        type: "networkError",
        details: "manifestLoadError",
      }));
      act(() => vi.advanceTimersByTime(500));
      expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
        "https://x/manifest.m3u8",
      );
      expect(hlsInstances[0].startLoad).not.toHaveBeenCalled();

      hlsInstances[0].loadSource.mockClear();
      act(() => handler("hlsError", {
        fatal: true,
        type: "networkError",
        details: "manifestLoadTimeOut",
      }));
      act(() => vi.advanceTimersByTime(1000));
      expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
        "https://x/manifest.m3u8",
      );
      expect(hlsInstances[0].startLoad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending HLS retry timer when the player unmounts", async () => {
    vi.useFakeTimers();
    try {
      (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
        () => "",
      );
      const { unmount } = render(
        <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
      );
      await act(async () => Promise.resolve());
      const handler = hlsInstances[0].on.mock.calls.find(([event]) => event === "hlsError")?.[1] as (
        event: string,
        data: { fatal: boolean; type: string },
      ) => void;
      act(() => handler("hlsError", { fatal: true, type: "networkError" }));
      unmount();
      act(() => vi.advanceTimersByTime(1000));
      expect(hlsInstances[0].startLoad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("attempts one HLS media recovery before failing", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    render(<VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const handler = hlsInstances[0].on.mock.calls.find(([event]) => event === "hlsError")?.[1] as (
      event: string,
      data: { fatal: boolean; type: string },
    ) => void;

    act(() => handler("hlsError", { fatal: true, type: "mediaError" }));
    expect(hlsInstances[0].recoverMediaError).toHaveBeenCalledTimes(1);
    act(() => handler("hlsError", { fatal: true, type: "mediaError" }));
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
  });

  it("prefers hls.js on non-iOS browsers even when native HLS hides alternate audio", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "maybe",
    );
    render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith("https://x/stream.m3u8");
  });

  it("uses hls.js on Android when WebView falsely reports native HLS support", async () => {
    deviceKindMock.mockReturnValue("android");
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "maybe",
    );

    render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );

    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
      "https://x/stream.m3u8",
    );
    expect(hlsInstances[0].attachMedia).toHaveBeenCalled();
  });

  it("uses hls.js in the Android APK when its user agent looks like desktop", async () => {
    deviceKindMock.mockReturnValue("mac");
    Object.defineProperty(window, "__YAWF_TAURI_MOBILE__", {
      configurable: true,
      value: true,
    });
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );

    render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );

    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
      "https://x/stream.m3u8",
    );
  });

  it("leaves ordinary nonexact native HLS startup unchanged in the iOS app", () => {
    deviceKindMock.mockReturnValue("ios");
    Object.defineProperty(window, "__YAWF_TAURI_MOBILE__", {
      configurable: true,
      value: true,
    });
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );

    render(
      <VideoPlayer
        url="https://x/stream.m3u8?quality=auto"
        title="Ordinary native HLS"
        startPositionSeconds={120}
        onClose={() => {}}
      />,
    );

    expect(hlsInstances).toHaveLength(0);
    const player = screen.getByRole("dialog", { name: "Playing Ordinary native HLS" });
    const video = player.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.src).toBe("https://x/stream.m3u8?quality=auto");
  });

  it("destroys the hls.js instance on unmount", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    const { unmount } = render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    unmount();
    expect(hlsInstances[0].destroy).toHaveBeenCalled();
  });

  it("routes to the external panel when HLS is unsupported", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    hlsIsSupported.mockReturnValue(false);
    render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );
    // The unsupported callback flips the parent to the recovery panel. Reached
    // only after the on-demand hls.js chunk resolves.
    await waitFor(() =>
      expect(document.querySelector(".player-external")).not.toBeNull(),
    );
    expect(hlsInstances).toHaveLength(0);
    expect(
      screen.getByText("This browser cannot play HLS. Try an external player or choose another source."),
    ).toBeInTheDocument();
  });

  it("falls back to native HLS on Android when MSE is unavailable", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    hlsIsSupported.mockReturnValue(false);
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    render(
      <VideoPlayer url="https://provider.example/stream.m3u8" title="T" onClose={() => {}} />,
    );

    await waitFor(() => {
      const video = document.querySelector("video.player-video");
      expect(video).not.toBeNull();
      expect((video as HTMLVideoElement | null)?.src).toBe("https://provider.example/stream.m3u8");
    });
    expect(hlsInstances).toHaveLength(0);
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("surfaces a native HLS fallback media error instead of treating hls.js as owner", async () => {
    isTauriMock.mockReturnValue(true);
    deviceKindMock.mockReturnValue("android");
    hlsIsSupported.mockReturnValue(false);
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "probably",
    );
    render(
      <VideoPlayer url="https://provider.example/stream.m3u8" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    await waitFor(() => expect(video.src).toBe("https://provider.example/stream.m3u8"));

    fireMediaError(video);
    expect(await screen.findByText("Playback interrupted")).toBeInTheDocument();
  });

  it("keeps the retry recovery panel visible in the desktop app", async () => {
    isTauriMock.mockReturnValue(true);
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    hlsIsSupported.mockReturnValue(false);
    render(
      <VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
    expect(screen.queryByText("Opening in the bundled player")).toBeNull();
  });
});

// ---- External panel: browser vs Tauri --------------------------------------

describe("ExternalPanel (browser)", () => {
  it("does not expose a provider URL to browser external actions", () => {
    render(<VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />);
    expect(screen.getByText("Use an external player")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Download player playlist/ })).toBeNull();
    expect(document.body.innerHTML).not.toContain("https://x/movie.mkv");
  });

  it("uses only the cookie-free external capability for browser actions", () => {
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const capability = `https://server.example/api/external-stream/session-1/${"E".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={capability}
        kind="external"
        title="T"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Download player playlist/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy stream link" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("api/stream/session-1\"");
  });

  it("withholds protected playback URLs when no external capability is available", () => {
    render(
      <VideoPlayer
        url="https://server.example/api/stream/protected-session"
        externalPlaybackUrl={null}
        kind="external"
        title="T"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: "Open direct link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in external player" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "External playback is not available for this protected stream",
    );
  });

  it("does not invoke any native player when not under Tauri", () => {
    render(<VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />);
    expect(playWithMpvMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });
});

describe("Built-in player (Tauri)", () => {
  it("uses the shared owned target for the active native external-player action", async () => {
    isTauriMock.mockReturnValue(true);
    const target = `https://server.example/api/external-stream/session-1/${"N".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={target}
        playbackAuthorization={`Bearer ${"N".repeat(43)}`}
        engine="native-mpv"
        title="T"
        onClose={() => {}}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "open embedded external player" }),
    );
    await waitFor(() =>
      expect(openInExternalPlayerMock).toHaveBeenCalledWith(target, undefined, undefined),
    );
    expect(await screen.findByTestId("embedded-external-status")).toHaveTextContent(
      "VLC hand-off",
    );
  });

  it("withholds the active native external-player action behind an explicit null fence", () => {
    isTauriMock.mockReturnValue(true);
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session-1"
        externalPlaybackUrl={null}
        playbackAuthorization={`Bearer ${"N".repeat(43)}`}
        engine="native-mpv"
        title="T"
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "open embedded external player" })).toBeNull();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("hands a distinct Server Mode external capability to desktop without a playback Authorization argument", async () => {
    isTauriMock.mockReturnValue(true);
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const target = `https://server.example/api/external-stream/session-1/${"D".repeat(43)}`;
    render(<VideoPlayer
      url="https://server.example/api/stream/session-1"
      externalPlaybackUrl={target}
      playbackAuthorization={`Bearer ${"D".repeat(43)}`}
      engine="webview-direct"
      title="T"
      onClose={() => {}}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    await userEvent.click(screen.getByRole("button", { name: /^Open in external player/ }));
    await waitFor(() => expect(openInExternalPlayerMock).toHaveBeenCalledWith(target, undefined, undefined));
  });

  it("uses the cookie-free capability, not the protected URL, when desktop mpv fallback opens an external app", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockRejectedValue(new Error("no mpv"));
    const target = `https://server.example/api/external-stream/session-1/${"F".repeat(43)}`;
    const authorization = `Bearer ${"F".repeat(43)}`;
    render(<VideoPlayer
      url="https://server.example/api/stream/session-1"
      externalPlaybackUrl={target}
      playbackAuthorization={authorization}
      engine="native-mpv"
      useBuiltInPlayer={false}
      title="T"
      onClose={() => {}}
    />);
    await waitFor(() => expect(playWithMpvMock).toHaveBeenCalledWith(
      "https://server.example/api/stream/session-1", authorization,
    ));
    await waitFor(() => expect(openInExternalPlayerMock).toHaveBeenCalledWith(target, undefined, undefined));
  });

  it("respects the unavailable capability fence when desktop mpv fails", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockRejectedValue(new Error("no mpv"));
    render(<VideoPlayer
      url="https://server.example/api/stream/session-1"
      externalPlaybackUrl={null}
      playbackAuthorization={`Bearer ${"G".repeat(43)}`}
      engine="native-mpv"
      useBuiltInPlayer={false}
      title="T"
      onClose={() => {}}
    />);
    await waitFor(() => expect(screen.getByText("External playback is not available for this protected stream.")).toBeInTheDocument());
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("renders the in-window libmpv player for MKV when enabled, no hand-off", async () => {
    isTauriMock.mockReturnValue(true);
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        playbackAuthorization={`Bearer ${"A".repeat(43)}`}
        onClose={() => {}}
        useBuiltInPlayer
      />,
    );
    // The embedded player takes over; the external mpv/VLC hand-off is skipped.
    expect(screen.getByTestId("embedded-player")).toHaveAttribute(
      "data-url",
      "https://x/movie.mkv",
    );
    expect(screen.getByTestId("embedded-player")).toHaveAttribute(
      "data-has-playback-authorization",
      "true",
    );
    expect(playWithMpvMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });

  it("uses the in-window player by default on macOS (external is the opt-out)", async () => {
    isTauriMock.mockReturnValue(true);
    render(<VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />);
    // Default (no useBuiltInPlayer prop) is now the built-in player; no hand-off.
    expect(screen.getByTestId("embedded-player")).toHaveAttribute(
      "data-url",
      "https://x/movie.mkv",
    );
    expect(playWithMpvMock).not.toHaveBeenCalled();
  });

  it("hands off to an external player when the built-in player is turned off", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
      />,
    );
    expect(screen.queryByTestId("embedded-player")).toBeNull();
    await waitFor(() => expect(playWithMpvMock).toHaveBeenCalled());
  });

  it.each(["windows", "linux"] as const)(
    "uses the in-window player on %s when built-in is on (mpv wid-embed)",
    async (platform) => {
      isTauriMock.mockReturnValue(true);
      deviceKindMock.mockReturnValue(platform);
      playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
      render(
        <VideoPlayer
          url="https://x/movie.mkv"
          title="T"
          onClose={() => {}}
          useBuiltInPlayer
        />,
      );
      expect(screen.getByTestId("embedded-player")).toBeInTheDocument();
      expect(playWithMpvMock).not.toHaveBeenCalled();
      deviceKindMock.mockReturnValue("mac");
    },
  );

  it("falls back from failed built-in mpv to HLS and updates the discriminator", async () => {
    isTauriMock.mockReturnValue(true);
    const requestWebviewFallback = vi.fn(async () => "https://x/recovery.m3u8");
    render(
      <VideoPlayer
        url="https://x/obsession.mp4"
        title="Obsession"
        engine="native-mpv"
        onClose={() => {}}
        useBuiltInPlayer
        requestWebviewFallback={requestWebviewFallback}
      />,
    );

    await userEvent.click(screen.getByText("simulate native failure"));
    await waitFor(() =>
      expect(document.querySelector("video.player-video")).not.toBeNull(),
    );
    expect(requestWebviewFallback).toHaveBeenCalledTimes(1);
    expect(hlsInstances[0]?.loadSource).toHaveBeenCalledWith(
      "https://x/recovery.m3u8",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Player details and shortcuts" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Player details and shortcuts" }),
    ).toHaveTextContent("Webview HLS transcode");
  });

  it("honours the built-in opt-out without probing the HLS fallback", async () => {
    isTauriMock.mockReturnValue(true);
    const requestWebviewFallback = vi.fn(async () => "https://x/recovery.m3u8");
    render(
      <VideoPlayer
        url="https://x/obsession.mp4"
        title="Obsession"
        engine="native-mpv"
        onClose={() => {}}
        useBuiltInPlayer={false}
        requestWebviewFallback={requestWebviewFallback}
      />,
    );

    await waitFor(() => expect(playWithMpvMock).toHaveBeenCalled());
    expect(requestWebviewFallback).not.toHaveBeenCalled();
    expect(screen.queryByTestId("embedded-player")).toBeNull();
  });
});

describe("ExternalPanel (Tauri)", () => {
  it("plays via the bundled mpv and shows its status", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
      />,
    );
    expect(screen.getByText("Opening in the bundled player")).toBeInTheDocument();
    await waitFor(() =>
      expect(playWithMpvMock).toHaveBeenCalledWith(
        "https://x/movie.mkv",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Playing in the bundled mpv player."),
      ).toBeInTheDocument(),
    );
  });

  it("reports the in-window embedding status when mpv embeds", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockResolvedValue({ embedded: true, status: "ok" });
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Playing in the bundled mpv (in-window embedding attempted).",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("falls back to the VLC/IINA hand-off when mpv fails", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockRejectedValue(new Error("no mpv"));
    openInExternalPlayerMock.mockResolvedValue("Opened in VLC");
    const authorization = `Bearer ${"A".repeat(43)}`;
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
        playbackAuthorization={authorization}
      />,
    );
    await waitFor(() =>
      expect(playWithMpvMock).toHaveBeenCalledWith(
        "https://x/movie.mkv",
        authorization,
      ),
    );
    await waitFor(() =>
      expect(openInExternalPlayerMock).toHaveBeenCalledWith(
        "https://x/movie.mkv",
        undefined,
        authorization,
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Opened in VLC")).toBeInTheDocument(),
    );
  });

  it("surfaces an error when both mpv and the VLC fallback fail", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockRejectedValue(new Error("no mpv"));
    openInExternalPlayerMock.mockRejectedValue(new Error("VLC missing"));
    render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector(".player-external-err")).toHaveTextContent(
        "VLC missing",
      ),
    );
    expect(screen.getByText("Could not open a player")).toBeInTheDocument();
    expect(screen.queryByText("Opening in the bundled player")).toBeNull();
    expect(screen.getByRole("button", { name: "Try external player again" })).toBeInTheDocument();
  });

  it("stops the bundled mpv on unmount once it has started", async () => {
    isTauriMock.mockReturnValue(true);
    playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
    const { unmount } = render(
      <VideoPlayer
        url="https://x/movie.mkv"
        title="T"
        onClose={() => {}}
        useBuiltInPlayer={false}
      />,
    );
    await waitFor(() => expect(playWithMpvMock).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(mpvStopMock).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// Next-episode eligibility and Up next (auto-advance) overlay
// ---------------------------------------------------------------------------

describe.each([
  ["desktop browser", "mac", false],
  ["Android browser", "android", false],
  ["Android app", "android", true],
  ["iOS browser", "ios", false],
] as const)("Next episode eligibility (%s)", (_label, kind, androidApp) => {
  beforeEach(() => {
    deviceKindMock.mockReturnValue(kind);
    if (androidApp) {
      isTauriMock.mockReturnValue(true);
      Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
        configurable: true,
        value: { getInsets: vi.fn() },
      });
    }
  });

  function renderWithNext(upNext: Parameters<typeof VideoPlayer>[0]["upNext"]) {
    const onPlayNext = vi.fn();
    render(
      <VideoPlayer
        url="https://x/video.mp4"
        engine="webview-direct"
        title={upNext == null ? "Movie" : "Episode"}
        upNext={upNext}
        onPlayNext={onPlayNext}
        onClose={() => {}}
      />,
    );
    return onPlayNext;
  }

  it("omits the Next episode button for a movie with a callback but no next item", () => {
    renderWithNext(null);

    expect(screen.queryByRole("button", { name: "Next episode" })).toBeNull();
  });

  it("ignores n and N for a movie with a callback but no next item", () => {
    const onPlayNext = renderWithNext(null);

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "N" });

    expect(onPlayNext).not.toHaveBeenCalled();
  });

  it("retains the Next episode button and n/N actions for a valid next item", () => {
    const onPlayNext = renderWithNext({ label: "S1 E2" });

    fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
    expect(onPlayNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "n" });
    expect(onPlayNext).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "N" });
    expect(onPlayNext).toHaveBeenCalledTimes(3);
  });
});

describe("Up next overlay", () => {
  function renderEnded(over: Partial<Parameters<typeof VideoPlayer>[0]> = {}) {
    const onPlayNext = vi.fn();
    const utils = render(
      <VideoPlayer
        url="https://x/ep.mp4"
        title="T"
        onClose={() => {}}
        upNext={{ label: "S2 E6" }}
        onPlayNext={onPlayNext}
        {...over}
      />,
    );
    const video = document.querySelector(
      "video.player-video",
    ) as HTMLVideoElement;
    return { ...utils, video, onPlayNext };
  }

  it("renders nothing before the video ends, and the card after", () => {
    const { video } = renderEnded();
    expect(screen.queryByText("Up next")).toBeNull();
    fireEvent(video, new Event("ended"));
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(screen.getByText("S2 E6")).toBeInTheDocument();
  });

  it("renders no card when upNext is null (movies / finale / setting off)", () => {
    const { video } = renderEnded({ upNext: null });
    fireEvent(video, new Event("ended"));
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("counts down and fires onPlayNext exactly once", () => {
    vi.useFakeTimers();
    try {
      const { video, onPlayNext } = renderEnded();
      fireEvent(video, new Event("ended"));
      expect(screen.getByText("Playing in 10s")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(onPlayNext).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onPlayNext).toHaveBeenCalledTimes(1); // interval cleared after firing
    } finally {
      vi.useRealTimers();
    }
  });

  it("Play now fires immediately; Dismiss stops the countdown for good", () => {
    vi.useFakeTimers();
    try {
      const { video, onPlayNext } = renderEnded();
      fireEvent(video, new Event("ended"));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Up next")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(onPlayNext).not.toHaveBeenCalled(); // dismissed card never fires
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the countdown under Data Saver (autoCountdown=false) but keeps Play now", () => {
    vi.useFakeTimers();
    try {
      const { video, onPlayNext } = renderEnded({ autoCountdown: false });
      fireEvent(video, new Event("ended"));
      expect(screen.queryByText(/Playing in/)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(onPlayNext).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Play now/ }));
      expect(onPlayNext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Up next predicted EOF handoff", () => {
  it("fires once at EOF after a visible warning, even when the parent stays mounted", () => {
    vi.useFakeTimers();
    try {
      const onPlayNext = vi.fn();
      render(
        <VideoPlayer url="https://x/predicted.mp4" title="T" onClose={() => {}}
          upNext={{ label: "S1 E2" }} onPlayNext={onPlayNext} />,
      );
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      Object.defineProperty(video, "duration", { configurable: true, value: 120 });
      Object.defineProperty(video, "currentTime", { configurable: true, value: 110, writable: true });
      fireEvent(video, new Event("loadedmetadata"));
      fireEvent(video, new Event("play"));
      fireEvent(video, new Event("timeupdate"));
      expect(screen.getByText("Up next")).toBeInTheDocument();
      fireEvent(video, new Event("ended"));
      expect(onPlayNext).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(20_000));
      expect(onPlayNext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Predictive end-of-episode behavior
// ---------------------------------------------------------------------------

describe("VideoPlayer predictive episode transitions", () => {
  function renderPredictive(over: Partial<Parameters<typeof VideoPlayer>[0]> = {}) {
    const onPlayNext = vi.fn();
    const onProgress = vi.fn();
    const onEnded = vi.fn();
    const view = render(
      <VideoPlayer
        url="https://x/episode.mp4"
        title="Episode"
        onClose={() => {}}
        upNext={{ label: "S1 E2" }}
        onPlayNext={onPlayNext}
        onProgress={onProgress}
        onEnded={onEnded}
        {...over}
      />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    return { ...view, video, onPlayNext, onProgress, onEnded };
  }

  function setPlaybackPosition(video: HTMLVideoElement, currentTime: number, duration: number): void {
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: currentTime, writable: true },
      duration: { configurable: true, value: duration },
    });
    fireEvent(video, new Event("durationchange"));
    fireEvent(video, new Event("play"));
    fireEvent(video, new Event("timeupdate"));
  }

  it("shows the adaptive early prompt without advancing before EOF", async () => {
    vi.useFakeTimers();
    try {
      const { video, onPlayNext } = renderPredictive();
      // A one-hour episode gets the capped 30-second early prompt window.
      setPlaybackPosition(video, 3_575, 3_600);
      expect(screen.getByText("Up next")).toBeInTheDocument();
      expect(screen.queryByText(/Playing in/)).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(onPlayNext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("immediately advances at EOF only after a generic warning was shown", async () => {
    const { video, onPlayNext } = renderPredictive();
    setPlaybackPosition(video, 95, 100);
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(onPlayNext).not.toHaveBeenCalled();

    fireEvent(video, new Event("ended"));
    expect(onPlayNext).toHaveBeenCalledTimes(1);
  });

  it("uses the EOF countdown fallback when no early warning was possible", () => {
    vi.useFakeTimers();
    try {
      const { video, onPlayNext } = renderPredictive();
      fireEvent(video, new Event("ended"));
      expect(screen.getByText("Playing in 10s")).toBeInTheDocument();
      expect(onPlayNext).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(onPlayNext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never advances after disabled auto play or a dismissed warning", async () => {
    vi.useFakeTimers();
    try {
      const disabled = renderPredictive({ autoCountdown: false });
      fireEvent(disabled.video, new Event("ended"));
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(disabled.onPlayNext).not.toHaveBeenCalled();

      disabled.unmount();
      const dismissed = renderPredictive();
      setPlaybackPosition(dismissed.video, 95, 100);
      expect(screen.getByText("Up next")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      fireEvent(dismissed.video, new Event("ended"));
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(dismissed.onPlayNext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the terminal callback own the final write without a duplicate progress callback", () => {
    const calls: string[] = [];
    const { video } = renderPredictive({
      onProgress: () => calls.push("progress"),
      onEnded: () => calls.push("ended"),
    });
    setPlaybackPosition(video, 100, 100);
    calls.length = 0;
    fireEvent(video, new Event("ended"));
    expect(calls).toEqual(["ended"]);
  });
});

// Evented browser subtitle lists, with per-object identities and real mode
// changes. These tests use the actual CaptionsMenu, not the lightweight stub.
function eventedCaptionList() {
  const target = new EventTarget();
  const list = Object.assign([] as TextTrack[], {
    addEventListener: vi.fn(target.addEventListener.bind(target)),
    removeEventListener: vi.fn(target.removeEventListener.bind(target)),
    dispatchEvent: target.dispatchEvent.bind(target),
    add(label: string, language = "", initial: TextTrackMode = "disabled", kind = "subtitles") {
      let mode = initial;
      const track = Object.assign(new EventTarget(), {
        label, language, kind, cues: [],
      });
      Object.defineProperty(track, "mode", {
        get: () => mode,
        set: (value: TextTrackMode) => {
          if (mode === value) return;
          mode = value;
          target.dispatchEvent(new Event("change"));
        },
      });
      list.push(track as unknown as TextTrack);
      target.dispatchEvent(new Event("addtrack"));
      return track as unknown as TextTrack;
    },
  });
  return list;
}

describe("embedded caption controls", () => {
  let lists: WeakMap<HTMLMediaElement, ReturnType<typeof eventedCaptionList>>;
  beforeEach(() => {
    captionMenuMode.actual = true;
    lists = new WeakMap();
    vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockImplementation(function (this: HTMLMediaElement) {
      let list = lists.get(this);
      if (list == null) { list = eventedCaptionList(); lists.set(this, list); }
      return list as unknown as TextTrackList;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const video = () => document.querySelector("video.player-video") as HTMLVideoElement;
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
  const button = (name: string) => within(screen.getByRole("dialog", { name: "Subtitles" })).getByRole("button", { name });

  it("exposes real HLS inventory and selection events, with a friendly unknown-language label", async () => {
    render(<VideoPlayer url="https://x/captions.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    act(() => {
      hls.subtitleTracks = [{ name: "subtitle_0" }, { name: "French", lang: "fr" }];
      hls.subtitleTrack = 0;
      hls.emit("subtitleTracksUpdated");
    });
    open();
    expect(button("Embedded subtitles")).toHaveAttribute("aria-pressed", "true");
    expect(button("Off")).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".captions-active-dot")).not.toBeNull();
    act(() => { hls.subtitleTracks.push({ name: "Spanish", lang: "es" }); hls.emit("subtitleTracksUpdated"); });
    expect(button("Spanish")).toHaveAttribute("aria-pressed", "false");
    act(() => { hls.subtitleTrack = 1; hls.emit("subtitleTrackSwitch", { id: 1 }); });
    expect(button("French")).toHaveAttribute("aria-pressed", "true");
    expect(button("Embedded subtitles")).toHaveAttribute("aria-pressed", "false");
    act(() => { hls.subtitleTracks = []; hls.subtitleTrack = -1; hls.emit("subtitleTracksUpdated"); });
    expect(within(screen.getByRole("dialog", { name: "Subtitles" })).queryByRole("button", { name: "French" })).toBeNull();
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
  });

  it("makes HLS Off, embedded, and downloaded choices mutually exclusive, including late default tracks", async () => {
    subsState.tracks = [{ id: "download", label: "Downloaded English", language: "en", vttUrl: "blob:captions" }];
    render(<VideoPlayer url="https://x/captions.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    const list = lists.get(video())!;
    let embedded!: TextTrack;
    let downloaded!: TextTrack;
    act(() => {
      hls.subtitleTracks = [{ name: "subtitle_0" }];
      hls.subtitleTrack = 0;
      hls.emit("subtitleTracksUpdated");
      embedded = list.add("subtitle_0", "", "showing");
      downloaded = list.add("Downloaded English", "en");
      Object.defineProperty(document.querySelector("track")!, "track", { value: downloaded });
      list.dispatchEvent(new Event("change"));
    });
    open();
    // HLS-owned native TextTracks must not appear as duplicate choices.
    expect(within(screen.getByRole("dialog", { name: "Subtitles" })).getAllByRole("button", { name: "Embedded subtitles" })).toHaveLength(1);
    fireEvent.click(button("Off"));
    expect(hls.subtitleTrack).toBe(-1);
    expect(hls.subtitleDisplay).toBe(false);
    expect(embedded.mode).toBe("disabled");
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
    act(() => { hls.subtitleTrack = 0; hls.subtitleDisplay = true; hls.emit("subtitleTrackSwitch", { id: 0 }); });
    expect(hls.subtitleTrack).toBe(-1);
    expect(hls.subtitleDisplay).toBe(false);
    fireEvent.click(button("Embedded subtitles"));
    expect(hls.subtitleTrack).toBe(0);
    expect(hls.subtitleDisplay).toBe(true);
    expect(embedded.mode).toBe("showing");
    expect(downloaded.mode).toBe("disabled");
    fireEvent.click(button("Downloaded English"));
    expect(subsState.activeTrackId).toBe("download");
    expect(hls.subtitleTrack).toBe(-1);
    expect(embedded.mode).toBe("disabled");
    expect(downloaded.mode).toBe("showing");
    fireEvent.click(button("Embedded subtitles"));
    expect(subsState.activeTrackId).toBeNull();
    expect(downloaded.mode).toBe("disabled");
    expect(embedded.mode).toBe("showing");
    fireEvent.click(button("Off"));
    expect(embedded.mode).toBe("disabled");
    expect(downloaded.mode).toBe("disabled");
  });

  it("observes native Safari track additions, changes, and removal without stealing same-label downloads", () => {
    deviceKindMock.mockReturnValue("ios");
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
    subsState.tracks = [{ id: "download", label: "English", language: "en", vttUrl: "blob:captions" }];
    render(<VideoPlayer url="https://x/native.m3u8" title="T" onClose={() => {}} />);
    const list = lists.get(video())!;
    let embedded!: TextTrack;
    let downloaded!: TextTrack;
    act(() => {
      embedded = list.add("English", "en", "showing");
      downloaded = list.add("English", "en");
      Object.defineProperty(document.querySelector("track")!, "track", { value: downloaded });
      list.dispatchEvent(new Event("change"));
    });
    open();
    const choices = within(screen.getByRole("dialog", { name: "Subtitles" })).getAllByRole("button", { name: "English" });
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(choices[1]!);
    expect(embedded.mode).toBe("disabled");
    expect(downloaded.mode).toBe("showing");
    fireEvent.click(choices[0]!);
    expect(subsState.activeTrackId).toBeNull();
    expect(embedded.mode).toBe("showing");
    expect(downloaded.mode).toBe("disabled");
    act(() => { embedded.mode = "disabled"; });
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
    act(() => { embedded.mode = "showing"; });
    expect(button("Off")).toHaveAttribute("aria-pressed", "false");
    act(() => { list.splice(list.indexOf(embedded), 1); list.dispatchEvent(new Event("removetrack")); });
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("dialog", { name: "Subtitles" })).getAllByRole("button", { name: "English" })).toHaveLength(1);
    expect(hlsInstances).toHaveLength(0);
  });

  it("honors initial Off for native captions and disables newly added caption tracks", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" playerPreferences={{ defaultSubtitleBehavior: "off" }} onClose={() => {}} />);
    const list = lists.get(video())!;
    let track!: TextTrack;
    act(() => { track = list.add("subtitle_0", "", "showing", "captions"); });
    expect(track.mode).toBe("disabled");
    open();
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Embedded subtitles"));
    expect(track.mode).toBe("showing");
    fireEvent.click(button("Off"));
    expect(track.mode).toBe("disabled");
    let late!: TextTrack;
    act(() => { late = list.add("French", "fr", "showing"); });
    expect(late.mode).toBe("disabled");
  });

  it("waits for a matching preferred language instead of enabling an unknown or wrong default", async () => {
    render(<VideoPlayer url="https://x/captions.m3u8" title="T" playerPreferences={{ defaultSubtitleBehavior: "preferred", defaultSubtitleLanguage: "fra" }} onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    act(() => {
      hls.subtitleTracks = [{ name: "subtitle_0" }, { name: "English", lang: "en" }];
      hls.subtitleTrack = 0;
      hls.emit("subtitleTracksUpdated");
    });
    expect(hls.subtitleTrack).toBe(-1);
    act(() => { hls.subtitleTracks.push({ name: "French", lang: "fr" }); hls.emit("subtitleTracksUpdated"); });
    expect(hls.subtitleTrack).toBe(2);
    expect(hls.subtitleDisplay).toBe(true);
    open();
    expect(button("French")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Off"));
    act(() => { hls.emit("subtitleTracksUpdated"); });
    expect(hls.subtitleTrack).toBe(-1);
  });

  it("applies the native preferred language only when it arrives and preserves manual Off", () => {
    deviceKindMock.mockReturnValue("ios");
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
    render(<VideoPlayer url="https://x/native.m3u8" title="T" playerPreferences={{ defaultSubtitleBehavior: "preferred", defaultSubtitleLanguage: "fr" }} onClose={() => {}} />);
    const list = lists.get(video())!;
    let unknown!: TextTrack;
    let french!: TextTrack;
    act(() => { unknown = list.add("subtitle_0", "", "showing"); });
    expect(unknown.mode).toBe("disabled");
    act(() => { french = list.add("French", "fra"); });
    expect(french.mode).toBe("showing");
    open();
    expect(button("French")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("Off"));
    act(() => { list.dispatchEvent(new Event("change")); });
    expect(french.mode).toBe("disabled");
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps remembered Off ahead of the preferred language on HLS default-selection events", async () => {
    render(<VideoPlayer url="https://x/captions.m3u8" title="T" savedPrefs={{ preferredSubId: "no" }} playerPreferences={{ defaultSubtitleBehavior: "preferred", defaultSubtitleLanguage: "fr" }} onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    act(() => { hls.subtitleTracks = [{ name: "French", lang: "fr" }]; hls.emit("subtitleTracksUpdated"); hls.subtitleTrack = 0; });
    expect(hls.subtitleTrack).toBe(-1);
    expect(hls.subtitleDisplay).toBe(false);
    open();
    expect(button("Off")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button("French"));
    expect(hls.subtitleTrack).toBe(0);
    expect(button("French")).toHaveAttribute("aria-pressed", "true");
  });

  it("disables embedded captions when a completed subtitle download activates a track", async () => {
    const props = { url: "https://x/captions.m3u8", title: "T", onClose: () => {} };
    const { rerender } = render(<VideoPlayer {...props} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    act(() => { hls.subtitleTracks = [{ name: "English", lang: "en" }]; hls.subtitleTrack = 0; hls.emit("subtitleTracksUpdated"); });
    subsState.tracks = [{ id: "download", label: "Downloaded English", language: "en", vttUrl: "blob:captions" }];
    subsState.activeTrackId = "download";
    rerender(<VideoPlayer {...props} />);
    expect(hls.subtitleTrack).toBe(-1);
    expect(hls.subtitleDisplay).toBe(false);
    open();
    expect(button("Downloaded English")).toHaveAttribute("aria-pressed", "true");
    expect(button("English")).toHaveAttribute("aria-pressed", "false");
    expect(button("Off")).toHaveAttribute("aria-pressed", "false");
  });

  it("cycles the keyboard shortcut through embedded, downloaded, and Off without overlapping modes", async () => {
    subsState.tracks = [{ id: "download", label: "Downloaded English", language: "en", vttUrl: "blob:captions" }];
    render(<VideoPlayer url="https://x/captions.m3u8" title="T" playerPreferences={{ defaultSubtitleBehavior: "off" }} onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const hls = hlsInstances[0]!;
    act(() => { hls.subtitleTracks = [{ name: "French", lang: "fr" }]; hls.emit("subtitleTracksUpdated"); });
    fireEvent.keyDown(window, { key: "c" });
    expect(hls.subtitleTrack).toBe(0);
    expect(subsState.activeTrackId).toBeNull();
    fireEvent.keyDown(window, { key: "c" });
    expect(hls.subtitleTrack).toBe(-1);
    expect(subsState.activeTrackId).toBe("download");
    fireEvent.keyDown(window, { key: "c" });
    expect(subsState.activeTrackId).toBeNull();
    expect(hls.subtitleTrack).toBe(-1);
    expect(hls.subtitleDisplay).toBe(false);
  });

  it("cleans up each source owner and fences stale HLS and native callbacks across same-URL revisions", async () => {
    const { rerender, unmount } = render(<VideoPlayer url="https://x/captions.m3u8" sourceRevision={0} title="T" playerPreferences={{ defaultSubtitleBehavior: "off" }} onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    const old = hlsInstances[0]!;
    const oldList = lists.get(video())!;
    const oldRefresh = old.on.mock.calls.find(([event]) => event === "subtitleTracksUpdated")![1] as () => void;
    const nativeRefresh = oldList.addEventListener.mock.calls.find(([event]) => event === "addtrack")![1] as () => void;
    rerender(<VideoPlayer url="https://x/captions.m3u8" sourceRevision={1} title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(2));
    const current = hlsInstances[1]!;
    act(() => { current.subtitleTracks = [{ name: "Current", lang: "en" }]; current.subtitleTrack = 0; current.emit("subtitleTracksUpdated"); });
    open();
    expect(button("Current")).toHaveAttribute("aria-pressed", "true");
    expect(old.off).toHaveBeenCalledWith("subtitleTracksUpdated", oldRefresh);
    expect(oldList.removeEventListener).toHaveBeenCalledWith("addtrack", nativeRefresh);
    let staleNative!: TextTrack;
    act(() => { old.subtitleTracks = [{ name: "Stale" }]; old.subtitleTrack = 0; oldRefresh(); staleNative = oldList.add("Stale native", "", "showing"); nativeRefresh(); });
    expect(staleNative.mode).toBe("showing");
    expect(button("Current")).toHaveAttribute("aria-pressed", "true");
    expect(current.subtitleTrack).toBe(0);
    expect(within(screen.getByRole("dialog", { name: "Subtitles" })).queryByRole("button", { name: /Stale/ })).toBeNull();
    const currentList = lists.get(video())!;
    unmount();
    expect(current.off).toHaveBeenCalledWith("subtitleTrackSwitch", expect.any(Function));
    expect(currentList.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});


// Geometry/event tests below assert requested native cue layout, not WebKit's
// private rendered cue boxes. Native readability still requires runtime proof.
describe("webview caption layout", () => {
  let list: ReturnType<typeof eventedCaptionList>;
  let stage = { left: 0, top: 0, width: 400, height: 800 };
  let osdTop = 650;
  let intrinsicWidth = 1920;
  let resizeObservers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }>;
  let restoreVisual: () => void;
  let visual: VisualViewport & { width: number; height: number; offsetTop: number; offsetLeft: number };
  const rect = (box: { left: number; top: number; width: number; height: number }) => ({
    ...box, right: box.left + box.width, bottom: box.top + box.height,
    x: box.left, y: box.top, toJSON: () => ({}),
  });
  const cue = (text = "A readable caption") => ({
    text, startTime: 1, endTime: 5, line: "auto" as number | "auto",
    snapToLines: true, lineAlign: "start", position: "auto" as number | "auto",
    positionAlign: "auto", size: 100, vertical: "", region: null,
  });
  beforeEach(() => {
    captionMenuMode.actual = true;
    deviceKindMock.mockReturnValue("ios");
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
    list = eventedCaptionList();
    stage = { left: 0, top: 0, width: 400, height: 800 };
    osdTop = 650;
    intrinsicWidth = 1920;
    resizeObservers = [];
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      callback: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.callback = () => callback([], this as unknown as ResizeObserver);
        resizeObservers.push(this);
      }
    });
    visual = Object.assign(new EventTarget(), {
      width: 400, height: 800, offsetLeft: 0, offsetTop: 0,
    }) as typeof visual;
    restoreVisual = replaceProperty(window, "visualViewport", visual);
    const lists = new WeakMap<HTMLMediaElement, ReturnType<typeof eventedCaptionList>>();
    vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockImplementation(function (this: HTMLMediaElement) {
      let current = lists.get(this);
      if (current == null) { current = eventedCaptionList(); lists.set(this, current); }
      list = current;
      return current as unknown as TextTrackList;
    });
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockImplementation(() => intrinsicWidth);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(1080);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("player-osd")) {
        return rect({ left: stage.left, top: osdTop, width: stage.width, height: stage.top + stage.height - osdTop });
      }
      if (this.classList.contains("player-video")) {
        const match = this.style.transform.match(/translate\(([-.\d]+)%, ([-.\d]+)%\) scale\(([-.\d]+)\)/);
        const zoom = Number(match?.[3] ?? 1);
        return rect({
          left: stage.left + (1 - zoom) * stage.width / 2 + Number(match?.[1] ?? 0) / 100 * stage.width,
          top: stage.top + (1 - zoom) * stage.height / 2 + Number(match?.[2] ?? 0) / 100 * stage.height,
          width: stage.width * zoom, height: stage.height * zoom,
        });
      }
      return rect(stage);
    });
  });
  afterEach(() => {
    restoreVisual();
    document.documentElement.style.removeProperty("--sub-font-scale");
    vi.restoreAllMocks();
  });
  function addCaption(currentCue = cue()) {
    let track!: TextTrack;
    act(() => {
      track = list.add("subtitle_0", "", "showing");
      (track.cues as unknown as unknown[]).push(currentCue);
      track.dispatchEvent(new Event("cuechange"));
    });
    return { track, currentCue };
  }

  it("anchors default native captions to the visible letterboxed picture, not the portrait transport", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption();
    expect(currentCue.line).toBeGreaterThan(50);
    expect(currentCue.line).toBeLessThan(65);
    expect(currentCue.lineAlign).toBe("end");
    expect(currentCue.startTime).toBe(1);
    expect(currentCue.endTime).toBe(5);
  });

  it("keeps the touch paused frame free of decorative artwork while retaining caption transport", () => {
    subsState.tracks = [{ id: "download", label: "Downloaded", language: "en", vttUrl: "blob:cc" }];
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const video = document.querySelector("video")!;
    fireEvent.pause(video);
    expect(document.querySelector(".player-pause-screen")).toBeNull();
    addCaption();
    expect(document.querySelector(".player-pause-screen")).toBeNull();
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    const menu = screen.getByRole("dialog", { name: "Subtitles" });
    fireEvent.click(within(menu).getByRole("button", { name: "Downloaded" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Close subtitles menu" }));
    expect(document.querySelector(".player-pause-screen")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Close subtitles menu" }));
    expect(document.querySelector(".player-pause-screen")).toBeNull();
  });

  it("repositions late cuechange arrivals without needing a new track inventory event", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { track } = addCaption();
    const late = cue("Late subtitle\nA second line");
    act(() => {
      (track.cues as unknown as unknown[]).push(late);
      track.dispatchEvent(new Event("cuechange"));
    });
    expect(late.line).not.toBe("auto");
    expect(late.line).toBeLessThan(65);
    expect(late.lineAlign).toBe("end");
    expect(late.text).toBe("Late subtitle\nA second line");
  });

  it("recomputes on actual resize, orientation, visual viewport and control-bound changes", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption();
    const original = currentCue.line;
    expect(resizeObservers[0]).toBeDefined();
    osdTop = 450;
    act(() => { resizeObservers[0]!.callback(); });
    expect(currentCue.line).toBeCloseTo(55.25);
    osdTop = 430;
    fireEvent(window, new Event("resize"));
    expect(currentCue.line).toBeCloseTo(52.75);
    osdTop = 410;
    fireEvent(window, new Event("orientationchange"));
    expect(currentCue.line).toBeCloseTo(50.25);
    stage = { left: 0, top: 0, width: 800, height: 400 };
    visual.width = 800;
    visual.height = 400;
    osdTop = 300;
    fireEvent(window, new Event("resize"));
    expect(currentCue.line).toBeCloseTo(73);
    stage = { left: 0, top: 0, width: 400, height: 800 };
    visual.width = 400;
    osdTop = 650;
    visual.height = 450;
    act(() => { visual.dispatchEvent(new Event("resize")); });
    expect(currentCue.line).toBeCloseTo(54.21875);
    expect(currentCue.line).toBeLessThan(original as number);
    visual.offsetTop = 400;
    visual.height = 200;
    act(() => { visual.dispatchEvent(new Event("scroll")); });
    expect(currentCue.line).toBeCloseTo(62.65625);
  });

  it("uses visible chrome bounds but returns to picture preference when chrome hides", async () => {
    vi.useFakeTimers();
    osdTop = 450;
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption();
    expect(currentCue.line).toBeCloseTo(55.25);
    fireEvent.canPlay(document.querySelector("video")!);
    fireEvent.play(document.querySelector("video")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(3300); });
    expect(document.querySelector(".player-osd")).not.toHaveClass("is-visible");
    expect(currentCue.line).toBeGreaterThan(60);
    fireEvent.pointerMove(document.querySelector(".webview-player")!);
    expect(currentCue.line).toBeCloseTo(55.25);
  });

  it("honors saved and edited subtitle position and recomputes fit, zoom and pan", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" savedPrefs={{ subtitlePosition: 20 }} onClose={() => {}} />);
    const { currentCue } = addCaption();
    expect(currentCue.line).toBeCloseTo(41.5625);
    expect(currentCue.lineAlign).toBe("start");
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.change(screen.getByRole("slider", { name: /Subtitle position/ }), { target: { value: "90" } });
    expect(currentCue.line).toBeCloseTo(61.25);
    fireEvent.click(screen.getByRole("button", { name: "Fill screen" }));
    expect(currentCue.line).toBeCloseTo(80.25);
    fireEvent.click(screen.getByRole("button", { name: "Stretch" }));
    expect(currentCue.line).toBeCloseTo(80.25);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    fireEvent.change(screen.getByRole("slider", { name: /^Zoom/ }), { target: { value: "2" } });
    expect(currentCue.size).toBeCloseTo(48);
    expect(document.querySelector("video")!.style.getPropertyValue("--player-caption-font-size")).toBe("12.375px");
    fireEvent.change(screen.getByRole("slider", { name: /Pan vertically/ }), { target: { value: "25" } });
    expect(currentCue.line).toBeLessThan(60);
    fireEvent.change(screen.getByRole("slider", { name: /Pan horizontally/ }), { target: { value: "50" } });
    expect(currentCue.position).toBeLessThan(50);
    expect(currentCue.size).toBeLessThan(50);
  });

  it("reserves multiline height at large appearance sizes without changing text or time", async () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { track, currentCue } = addCaption();
    act(() => {
      currentCue.text = "One\nTwo\nThree\nFour\nFive\nSix";
      track.dispatchEvent(new Event("cuechange"));
    });
    expect(currentCue.line).toBeCloseTo(61.25);
    await act(async () => { document.documentElement.style.setProperty("--sub-font-scale", "1.8"); });
    expect(currentCue.line).toBeCloseTo(63.0625);
    expect(document.querySelector("video")!.style.getPropertyValue("--player-caption-font-size")).toBe("16px");
    expect(currentCue.startTime).toBe(1);
    expect(currentCue.endTime).toBe(5);
  });

  it("preserves authored line, vertical, region and horizontal cue layouts", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { track } = addCaption();
    const authored = [
      { ...cue(), line: 2 }, { ...cue(), vertical: "rl" },
      { ...cue(), region: {} }, { ...cue(), position: 25 }, { ...cue(), size: 40 },
    ];
    const before = authored.map(value => ({ ...value }));
    act(() => {
      (track.cues as unknown as unknown[]).push(...authored);
      track.dispatchEvent(new Event("cuechange"));
    });
    expect(authored).toEqual(before);
  });

  it("waits for real intrinsic metadata before positioning a native cue", () => {
    intrinsicWidth = 0;
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption();
    expect(currentCue.line).toBe("auto");
    intrinsicWidth = 1920;
    fireEvent.loadedMetadata(document.querySelector("video")!);
    expect(currentCue.line).toBeCloseTo(61.25);
  });

  it("restores cue geometry on Off and downloaded mutual exclusion without resurrecting selection", () => {
    subsState.tracks = [{ id: "download", label: "Downloaded", language: "en", vttUrl: "blob:cc" }];
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { track, currentCue } = addCaption();
    const downloaded = cue("Downloaded cue");
    let downloadedTrack!: TextTrack;
    act(() => {
      downloadedTrack = list.add("Downloaded", "en");
      (downloadedTrack.cues as unknown as unknown[]).push(downloaded);
      Object.defineProperty(document.querySelector("track")!, "track", { value: downloadedTrack });
      list.dispatchEvent(new Event("change"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    expect(track.mode).toBe("disabled");
    expect(currentCue.line).toBe("auto");
    expect(downloadedTrack.mode).toBe("showing");
    expect(downloaded.line).toBeLessThan(65);
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(downloadedTrack.mode).toBe("disabled");
    expect(downloaded.line).toBe("auto");
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    expect(downloadedTrack.mode).toBe("disabled");
  });

  it("disposes observers and stale callbacks, restoring the old owner's native cue geometry", () => {
    const props = { url: "https://x/native.mp4", title: "T", onClose: () => {} };
    const { rerender, unmount } = render(<VideoPlayer {...props} sourceRevision={0} />);
    const { track, currentCue } = addCaption();
    const remove = vi.spyOn(track, "removeEventListener");
    const oldResize = resizeObservers[0]!;
    expect(oldResize).toBeDefined();
    const staleLayoutRefresh = list.addEventListener.mock.calls.find(([event]) => event === "change")![1] as () => void;
    rerender(<VideoPlayer {...props} sourceRevision={1} />);
    expect(oldResize.disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("cuechange", expect.any(Function));
    expect(currentCue.line).toBe("auto");
    expect(currentCue.snapToLines).toBe(true);
    const current = addCaption().currentCue;
    currentCue.line = 17;
    osdTop = 400;
    act(() => { oldResize.callback(); staleLayoutRefresh(); track.dispatchEvent(new Event("cuechange")); });
    expect(currentCue.line).toBe(17);
    expect(current.line).toBeCloseTo(61.25);
    unmount();
    expect(current.line).toBe("auto");
    expect(resizeObservers.at(-1)!.disconnect).toHaveBeenCalledOnce();
  });


  it("handles Safari and hls.js numeric automatic cue defaults without treating them as authored lines", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption({ ...cue(), line: -1, position: 50 });
    expect(currentCue.line).toBeCloseTo(61.25);
    expect(currentCue.lineAlign).toBe("end");
    expect(currentCue.snapToLines).toBe(false);
  });


  it("binds measured native cue font size to the existing appearance scale and colors", () => {
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toContain("font-size: calc(var(--player-caption-font-size, 1em) * var(--sub-font-scale, 1));");
    expect(css).toContain("color: var(--sub-color, #ffffff);");
    expect(css).toContain("background-color: rgba(0, 0, 0, var(--sub-bg, 0.55));");
  });


  it("restores native presentation geometry for Safari fullscreen and PiP and resumes inline layout", () => {
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const video = document.querySelector("video")!;
    const { track, currentCue } = addCaption();
    fireEvent(video, new Event("webkitbeginfullscreen"));
    expect(currentCue.line).toBe("auto");
    expect(currentCue.snapToLines).toBe(true);
    expect(track.mode).toBe("showing");
    fireEvent(video, new Event("webkitendfullscreen"));
    expect(currentCue.line).toBeCloseTo(61.25);
    const restorePip = replaceProperty(document, "pictureInPictureElement", video);
    try {
      fireEvent(video, new Event("enterpictureinpicture"));
      expect(currentCue.line).toBe("auto");
    } finally { restorePip(); }
    fireEvent(video, new Event("leavepictureinpicture"));
    expect(currentCue.line).toBeCloseTo(61.25);
    const restoreMode = replaceProperty(video, "webkitPresentationMode", "picture-in-picture");
    try {
      fireEvent(video, new Event("webkitpresentationmodechanged"));
      expect(currentCue.line).toBe("auto");
    } finally { restoreMode(); }
    fireEvent(video, new Event("webkitpresentationmodechanged"));
    expect(currentCue.line).toBeCloseTo(61.25);
  });

  it("does not reserve custom controls excluded by document fullscreen", () => {
    osdTop = 450;
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const { currentCue } = addCaption();
    expect(currentCue.line).toBeCloseTo(55.25);
    const restoreFullscreen = replaceProperty(document, "fullscreenElement", document.querySelector(".player-stage"));
    try {
      fireEvent(document, new Event("fullscreenchange"));
      expect(currentCue.line).toBeCloseTo(61.25);
    } finally { restoreFullscreen(); }
    fireEvent(document, new Event("fullscreenchange"));
    expect(currentCue.line).toBeCloseTo(55.25);
  });

});


describe("server generation HEAD retention", () => {
  const master = "https://server.example/api/stream/lease/index.m3u8?quality=480p";
  const child = "https://server.example/api/stream/lease/480p.m3u8?generation=transcode-owned";
  const manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n480p.m3u8?generation=transcode-owned\n";
  const optimized = { qualities: ["480p"] as const, request: vi.fn() };
  async function flushLease() {
    await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  }
  it("prepares once before native attach and retains the paused exact generation every 30 seconds", async () => {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>).mockReturnValue("probably");
    const prepared = deferred<Response>();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? Promise.resolve(new Response(null)) : prepared.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBeNull();
    prepared.resolve(new Response(manifest));
    await flushLease();
    expect(video.src).toBe(master);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(child, expect.objectContaining({ method: "HEAD", credentials: "include", cache: "no-store", redirect: "error" }));
    fireEvent.canPlay(video);
    fireEvent.pause(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(5);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  function setupNative() {
    vi.useFakeTimers();
    deviceKindMock.mockReturnValue("ios");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>).mockReturnValue("probably");
  }
  it("automatically resolves expiry and keeps manual Retry from restoring an old URL", async () => {
    setupNative();
    let heads = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: ++heads === 1 ? 200 : 404 }) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    const refresh = vi.fn(async () => {});
    render(<VideoPlayer url={master} engine="webview-hls-transcode" timelineOffsetSeconds={46} title="Lease" serverOptimized={optimized} refreshCurrentSource={refresh} onClose={() => {}} />);
    await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    act(() => { video.currentTime = 7.25; video.volume = 0.4; video.muted = true; video.playbackRate = 1.25; });
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    fireEvent.canPlay(video);
    fireEvent.pause(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("This stream has expired");
    expect(document.querySelector("video.player-video")).toBeNull();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(53.25, { paused: true, volume: 0.4, muted: true, playbackRate: 1.25 });
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await flushLease();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(53.25, { paused: true, volume: 0.4, muted: true, playbackRate: 1.25 });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });
  it("does not offer old-URL Retry when an expired owner has no fresh resolver", async () => {
    setupNative();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 404 }) : new Response(manifest)));
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
  it("ignores a stale preparation after source replacement and aborts its request", async () => {
    setupNative();
    const old = deferred<Response>();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? Promise.resolve(new Response(null)) : old.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    view.rerender(<VideoPlayer url="https://x/new.mp4" title="New" onClose={() => {}} />);
    expect(signal.aborted).toBe(true);
    old.resolve(new Response(manifest)); await flushLease();
    expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe("https://x/new.mp4");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["URL", "revision"])("ignores an aborted old HEAD failure after %s replacement", async (replacement) => {
    setupNative();
    const old = deferred<Response>();
    let heads = 0;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? ++heads === 1 ? old.promise : Promise.resolve(new Response(null)) : Promise.resolve(new Response(manifest)));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<VideoPlayer url={master} sourceRevision={1} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    const signal = fetcher.mock.calls.find(([, init]) => init?.method === "HEAD")![1]!.signal!;
    const nextUrl = replacement === "URL" ? "https://x/new.mp4" : master;
    view.rerender(<VideoPlayer url={nextUrl} sourceRevision={2} title="New" serverOptimized={optimized} onClose={() => {}} />);
    expect(signal.aborted).toBe(true);
    old.resolve(new Response(null, { status: 404 })); await flushLease();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe(nextUrl);
  });
  it("aborts one stalled HEAD at five seconds and coalesces foreground checks onto the 30 second cadence", async () => {
    setupNative();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Promise<Response>(() => {}) : Promise.resolve(new Response(manifest)));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    const heads = () => fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD");
    fireEvent.canPlay(document.querySelector("video.player-video") as HTMLVideoElement);
    const signal = heads()[0]![1]!.signal!;
    act(() => { window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(heads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(signal.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(24_999); });
    expect(heads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(heads()).toHaveLength(2);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(heads()[1]![1]!.signal!.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(heads()).toHaveLength(2);
    act(() => { window.dispatchEvent(new Event("pageshow")); });
    await flushLease(); expect(heads()).toHaveLength(3);
    view.unmount(); expect(heads()[2]![1]!.signal!.aborted).toBe(true);
  });
  it.each(["ended", "error", "cast"])("stops renewal for %s without a master reload", async (reason) => {
    setupNative();
    if (reason === "cast") isTauriMock.mockReturnValue(true);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={{ ...optimized, loadSourceInfo: async () => ({ durationSeconds: 10 }) }} onClose={() => {}} />);
    await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    if (reason === "cast") fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
    else if (reason === "ended") {
      Object.defineProperty(video, "duration", { configurable: true, value: 10 });
      video.currentTime = 10;
      fireEvent.ended(video);
      expect(screen.queryByRole("alert")).toBeNull();
    }
    else fireMediaError(video, 3);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });
  it("reuses the prepared actual target across an optimized handoff and rejects old in-flight failure", async () => {
    setupNative();
    const old = deferred<Response>();
    const next = deferred<{ url: string; timelineOffsetSeconds: number; startPositionSeconds: number; quality: "720p" }>();
    const nextMaster = master.replace("480p", "720p");
    const nextChild = child.replace("480p", "720p").replace("transcode-owned", "transcode-next");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return String(input) === child ? old.promise : Promise.resolve(new Response(null));
      return Promise.resolve(new Response(String(input) === master ? manifest : manifest.replaceAll("480p", "720p").replaceAll("transcode-owned", "transcode-next")));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={{ qualities: ["480p", "720p"], request: () => next.promise }} onClose={() => {}} />);
    await flushLease();
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    await flushLease();
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "HEAD")![1]!.signal!.aborted).toBe(true);
    old.resolve(new Response(null, { status: 404 })); await flushLease();
    expect(screen.queryByRole("alert")).toBeNull();
    next.resolve({ url: nextMaster, timelineOffsetSeconds: 0, startPositionSeconds: 0, quality: "720p" });
    await flushLease();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(nextChild, expect.objectContaining({ method: "HEAD" }));
    expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toContain(nextMaster);
  });
  it("bounds initial preparation retries at the fixed startup deadline", async () => {
    setupNative();
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("timed out");
    const calls = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(calls).toBeLessThan(18);
  });

  it("binds hls.js initial attachment to the actual prepared child without forcing native capabilities", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await flushLease();
    expect(hlsInstances).toHaveLength(1);
    expect(hlsInstances[0]!.loadSource).toHaveBeenCalledWith(master);
    expect(fetcher).toHaveBeenCalledWith(child, expect.objectContaining({ method: "HEAD" }));
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video); fireEvent.pause(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });

  it("attaches legacy masters without guessing a generation or polling their startup URL", async () => {
    setupNative();
    const fetcher = vi.fn(async () => new Response("#EXTM3U\n480p.m3u8\n"));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.src).toBe(master);
    fireEvent.canPlay(video); fireEvent.pause(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores an expired fresh-resolution rejection after the source owner changes", async () => {
    setupNative();
    const refresh = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 404 }) : new Response(manifest)));
    const view = render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} refreshCurrentSource={() => refresh.promise} onClose={() => {}} />);
    await flushLease();
    view.rerender(<VideoPlayer url="https://x/new.mp4" sourceRevision={2} title="New" onClose={() => {}} />);
    await act(async () => { refresh.reject(new Error("late resolution failure")); await Promise.resolve(); });
    await flushLease();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe("https://x/new.mp4");
  });

  it("coalesces rapid cast release onto the same owner retention cadence", async () => {
    setupNative(); isTauriMock.mockReturnValue(true);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video); fireEvent.pause(video);
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
      fireEvent.click(screen.getByRole("button", { name: "test resume playback" }));
      await flushLease();
    }
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });

  function suspendedReplacement(refresh: () => Promise<void>, engineOnly = false, suspendReplacement = true) {
    let choose: (pending: boolean) => void = () => { throw new Error("Scenario not mounted"); };
    let speculativeRenders = 0;
    const pendingRender = new Promise<void>(() => {});
    function Gate({ pending }: { pending: boolean }) {
      if (pending && suspendReplacement) { speculativeRenders += 1; throw pendingRender; }
      return null;
    }
    function Scenario() {
      const [pending, setPending] = useState(false);
      choose = setPending;
      return <Suspense fallback={<div>Speculative fallback</div>}>
        <VideoPlayer url={pending && !engineOnly ? "https://x/speculative.mp4" : master}
          engine={pending ? "webview-direct" : "webview-hls-transcode"}
          title="Lease" serverOptimized={optimized} refreshCurrentSource={refresh} onClose={() => {}} />
        <Gate pending={pending} />
      </Suspense>;
    }
    return { Scenario, choose: (pending: boolean) => choose(pending), speculativeRenders: () => speculativeRenders };
  }
  it("keeps a committed lease owner through a suspended replacement until HEAD404 reaches fresh Retry", async () => {
    setupNative();
    const head = deferred<Response>();
    const refresh = vi.fn(async () => {});
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? head.promise : Promise.resolve(new Response(manifest)));
    vi.stubGlobal("fetch", fetcher);
    const scenario = suspendedReplacement(refresh);
    render(<scenario.Scenario />);
    await flushLease();
    const committed = document.querySelector("video.player-video") as HTMLVideoElement;
    committed.currentTime = 6.25;
    Object.defineProperty(committed, "paused", { configurable: true, value: true });
    fireEvent.canPlay(committed); fireEvent.pause(committed);
    act(() => { startTransition(() => scenario.choose(true)); });
    await flushLease();
    expect(scenario.speculativeRenders()).toBeGreaterThan(0);
    expect(document.querySelector("video.player-video")).toBe(committed);
    expect(committed.isConnected).toBe(true);
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "HEAD")![1]!.signal!.aborted).toBe(false);
    head.resolve(new Response(null, { status: 404 })); await flushLease();
    expect(screen.getByRole("alert")).toHaveTextContent("This stream has expired");
    act(() => scenario.choose(false)); // Abort the never-committed replacement.
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await flushLease();
    expect(refresh).toHaveBeenCalledWith(6.25, expect.objectContaining({ paused: true }));
    expect(document.querySelector("video.player-video")).toBeNull();
  });
  it("settles the committed expired Retry while a speculative replacement is suspended and aborted", async () => {
    setupNative();
    const refresh = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 404 }) : new Response(manifest)));
    const scenario = suspendedReplacement(() => refresh.promise);
    render(<scenario.Scenario />);
    await flushLease();
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    act(() => { startTransition(() => scenario.choose(true)); });
    await flushLease();
    expect(scenario.speculativeRenders()).toBeGreaterThan(0);
    await act(async () => { refresh.reject(new Error("Current committed resolution failed")); await Promise.resolve(); });
    await flushLease();
    expect(screen.getByRole("alert")).toHaveTextContent("A fresh stream could not be prepared");
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeEnabled();
    act(() => scenario.choose(false));
    expect(screen.getByRole("alert")).toHaveTextContent("A fresh stream could not be prepared");
    expect(document.querySelector("video.player-video")).toBeNull();
  });

  it("keeps native retention alive after an ignored null-MediaError poster event", async () => {
    setupNative();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: null });
    expect(video.error).toBeNull();
    fireEvent.canPlay(video); fireEvent.pause(video); fireEvent.error(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });
  it.each(["media", "network"])("keeps retention alive through hls.js %s recovery despite a raw media error", async (kind) => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); await flushLease();
    const hls = hlsInstances[0]!;
    expect(hls).toBeDefined();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video); fireEvent.pause(video); fireMediaError(video, 3);
    act(() => { hls.emit("hlsError", { fatal: true, type: kind === "media" ? "mediaError" : "networkError", details: "fragLoadError" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(kind === "media" ? hls.recoverMediaError : hls.startLoad).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
  });
  it("aborts retention when hls.js exhausts its actual fatal recovery decision", async () => {
    vi.useFakeTimers();
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const pendingHead = deferred<Response>(); let heads = 0;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === "HEAD"
      ? ++heads === 1 ? Promise.resolve(new Response(null)) : pendingHead.promise
      : Promise.resolve(new Response(manifest)));
    vi.stubGlobal("fetch", fetcher);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Lease" serverOptimized={optimized} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); await flushLease();
    const hls = hlsInstances[0]!;
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video); fireEvent.pause(video);
    act(() => { hls.emit("hlsError", { fatal: true, type: "mediaError" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(heads).toBe(2);
    const signal = fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")[1]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    act(() => { hls.emit("hlsError", { fatal: true, type: "mediaError" }); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be decoded");
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(heads).toBe(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });
  it("keeps the committed expiry callback through an aborted engine-only transition on the reused child", async () => {
    setupNative();
    const head = deferred<Response>(); const refresh = vi.fn(async () => {});
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? head.promise : Promise.resolve(new Response(manifest)));
    vi.stubGlobal("fetch", fetcher);
    const scenario = suspendedReplacement(refresh, true);
    render(<scenario.Scenario />); await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 8.25;
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    fireEvent.canPlay(video); fireEvent.pause(video);
    act(() => { startTransition(() => scenario.choose(true)); }); await flushLease();
    expect(scenario.speculativeRenders()).toBeGreaterThan(0);
    expect(document.querySelector("video.player-video")).toBe(video);
    expect(video.src).toBe(master);
    expect(fetcher.mock.calls.find(([, init]) => init?.method === "HEAD")![1]!.signal!.aborted).toBe(false);
    head.resolve(new Response(null, { status: 404 })); await flushLease();
    expect(screen.getByRole("alert")).toHaveTextContent("This stream has expired");
    act(() => scenario.choose(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" })); await flushLease();
    expect(refresh).toHaveBeenCalledWith(8.25, expect.objectContaining({ paused: true }));
    expect(document.querySelector("video.player-video")).toBeNull();
  });
  it("publishes the expiry callback when an engine-only transition really commits on the reused child", async () => {
    setupNative();
    const head = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? head.promise : Promise.resolve(new Response(manifest))));
    const scenario = suspendedReplacement(async () => {}, true, false);
    render(<scenario.Scenario />); await flushLease();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    fireEvent.canPlay(video); fireEvent.pause(video);
    act(() => scenario.choose(true)); await flushLease();
    expect(document.querySelector("video.player-video")).toBe(video);
    head.resolve(new Response(null, { status: 404 })); await flushLease();
    expect(screen.getByRole("alert")).toHaveTextContent("This stream has expired");
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeEnabled();
  });

});

describe("mobile usability presentation and pinned settings", () => {
  it("pins touch More outside the secondary scrollport without hiding Audio or CC", () => {
    deviceKindMock.mockReturnValue("ios");
    render(<VideoPlayer url="https://x/movie.mp4" title="Pinned settings" onClose={() => {}} />);
    const more = screen.getByRole("button", { name: "Playback settings" });
    const toolbar = screen.getByRole("toolbar", { name: "Playback actions" });
    const secondary = toolbar.querySelector<HTMLElement>(".player-touch-actions")!;
    expect(more).toHaveClass("player-touch-more");
    expect(more.parentElement).toBe(toolbar);
    expect(more.closest(".player-touch-actions")).toBeNull();
    expect(more.previousElementSibling).toBe(secondary);
    expect(within(secondary).getByRole("button", { name: "Subtitles" })).toBeInTheDocument();
    expect(within(secondary).getByRole("button", { name: /Audio/ })).toBeInTheDocument();
    expect(within(secondary).queryByRole("button", { name: "Playback settings" })).toBeNull();
    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).toMatch(/\.player-touch-action-row\s*\{[^}]*display:\s*flex;[^}]*box-sizing:\s*border-box;/s);
    expect(css).toMatch(/\.player-touch-more\s*\{\s*flex:\s*0 0 auto;/);
    expect(css).toMatch(/\.player-touch-actions\s*\{[^}]*flex:\s*1 1 0%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.player-touch-actions \.player-touch-action,\s*\.player-touch-more\s*\{[^}]*min-height:\s*46px;/s);
  });

  async function changePresentation() {
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Fill screen" }));
    fireEvent.change(screen.getByRole("slider", { name: /Zoom/ }), { target: { value: "1.35" } });
    fireEvent.change(screen.getByRole("slider", { name: /Pan horizontally/ }), { target: { value: "12" } });
    fireEvent.change(screen.getByRole("slider", { name: /Pan vertically/ }), { target: { value: "-8" } });
  }
  function expectPresentation() {
    expect(document.querySelector("video.player-video")).toHaveStyle({ objectFit: "cover", transform: "translate(12%, -8%) scale(1.35)" });
  }
  async function expectPresentationControls() {
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("button", { name: "Fill screen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("slider", { name: /Zoom/ })).toHaveValue("1.35");
    expect(screen.getByRole("slider", { name: /Pan horizontally/ })).toHaveValue("12");
    expect(screen.getByRole("slider", { name: /Pan vertically/ })).toHaveValue("-8");
  }

  it("retains actual presentation controls and video style across quality replacements and fallback", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async (quality: ServerTranscodeQuality) => ({
      url: `https://server.example/api/stream/session-1/index.m3u8?quality=${quality}`,
      timelineOffsetSeconds: 0, startPositionSeconds: 0, quality,
    }));
    render(<VideoPlayer url="https://server.example/api/stream/session-1" title="Presentation film" sourceFileName="Film.mp4" imdbId="tt0000001" serverOptimized={{ qualities: ["480p", "720p"], request }} onClose={() => {}} />);
    await changePresentation();
    expectPresentation();
    let old = document.querySelector("video.player-video");
    fireEvent.click(screen.getByRole("button", { name: "480p" }));
    await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(old));
    expectPresentation();
    await expectPresentationControls();
    old = document.querySelector("video.player-video");
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(old));
    expectPresentation();
    await waitFor(() => expect(hlsInstances.at(-1)?.loadSource).toHaveBeenCalledWith(
      "https://server.example/api/stream/session-1/index.m3u8?quality=720p",
    ));
    act(() => hlsInstances.at(-1)!.emit("hlsError", { fatal: true, type: "otherError" }));
    await waitFor(() => expect((document.querySelector("video.player-video") as HTMLVideoElement).src).toBe("https://server.example/api/stream/session-1"));
    expectPresentation();
    await expectPresentationControls();
  });

  it("retains presentation values and styles when manual audio replaces the video child", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/session-audio/index.m3u8?quality=480p&audio=1",
      timelineOffsetSeconds: 0, startPositionSeconds: 0, quality: "480p" as const, audioTrack: 1,
    }));
    const loadAudioTracks = vi.fn(async () => [
      { index: 0, label: "English", language: "eng", default: true },
      { index: 1, label: "Japanese", language: "jpn", default: false },
    ]);
    render(<VideoPlayer url="https://server.example/api/stream/session-audio" title="Audio presentation" sourceFileName="Film.mp4" imdbId="tt0000001" serverOptimized={{ qualities: ["480p"], request, loadAudioTracks }} onClose={() => {}} />);
    await changePresentation();
    const original = document.querySelector("video.player-video");
    fireEvent.click(await screen.findByRole("button", { name: "Japanese" }));
    await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(original));
    expectPresentation();
    await expectPresentationControls();
    expect(request).toHaveBeenCalledWith("480p", 0, 1);
  });

  it("retains presentation through an explicit Retry child remount", async () => {
    render(<VideoPlayer url="https://x/retry.mp4" title="Retry presentation" sourceFileName="Film.mp4" onClose={() => {}} />);
    await changePresentation();
    fireEvent.click(screen.getByRole("button", { name: "Close playback settings" }));
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    fireMediaError(original);
    fireEvent.click(await screen.findByRole("button", { name: "Retry playback" }));
    await waitFor(() => expect(document.querySelector("video.player-video")).not.toBe(original));
    expectPresentation();
    await expectPresentationControls();
  });

  it("retains same-file refreshed URLs but resets different file or content owners without cross-file history", async () => {
    const base = { title: "Presentation film", sourceFileName: "Film-A.mp4", imdbId: "tt0000001", onClose: () => {} };
    const view = render(<VideoPlayer {...base} url="https://x/generation-A.mp4" />);
    await changePresentation();
    view.rerender(<VideoPlayer {...base} url="https://x/generation-B.mp4" sourceRevision={1} />);
    expectPresentation();
    await expectPresentationControls();
    view.rerender(<VideoPlayer {...base} sourceFileName="Film-B.mp4" url="https://x/generation-B.mp4" />);
    expect(document.querySelector("video.player-video")).toHaveStyle({ objectFit: "contain", transform: "translate(0%, 0%) scale(1)" });
    await changePresentation();
    view.rerender(<VideoPlayer {...base} url="https://x/generation-A.mp4" />);
    expect(document.querySelector("video.player-video")).toHaveStyle({ objectFit: "contain", transform: "translate(0%, 0%) scale(1)" });
    await changePresentation();
    view.rerender(<VideoPlayer {...base} imdbId="tt0000002" url="https://x/generation-A.mp4" />);
    expect(document.querySelector("video.player-video")).toHaveStyle({ objectFit: "contain", transform: "translate(0%, 0%) scale(1)" });
  });

  it("uses original playback identity conservatively when no file identity is available", async () => {
    const view = render(<VideoPlayer url="https://x/file-A.mp4" title="Same title" onClose={() => {}} />);
    await changePresentation();
    view.rerender(<VideoPlayer url="https://x/file-B.mp4" title="Same title" onClose={() => {}} />);
    expect(document.querySelector("video.player-video")).toHaveStyle({ objectFit: "contain", transform: "translate(0%, 0%) scale(1)" });
  });
});

describe("explicit Device Original audio intent", () => {
  const originalUrl = "https://server.example/api/stream/mode-original";
  const position = 61.157115;
  const tracks = [
    { index: 0, language: "eng", label: "English", default: true },
    { index: 1, language: "jpn", label: "Japanese", default: false },
  ];
  async function settleMode() {
    await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
  }
  function readyMode(video: HTMLVideoElement, offset = 0) {
    Object.defineProperties(video, {
      duration: { configurable: true, value: 180 - offset },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      paused: { configurable: true, value: true },
      seeking: { configurable: true, value: false },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 180 - offset } },
    });
    fireEvent.loadedMetadata(video); fireEvent.loadedData(video); fireEvent.seeked(video);
    fireEvent.timeUpdate(video);
  }
  async function settingsMode() {
    if (screen.queryByRole("button", { name: "Close playback settings" }) == null) {
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    }
  }
  async function setupMode() {
    deviceKindMock.mockReturnValue("ios");
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response("#EXTM3U\n", {
      headers: { "x-yawf-transcode-audio": new URL(String(input)).searchParams.get("audio") ?? "0" },
    })));
    const request = vi.fn(async (quality: ServerTranscodeQuality, absolute: number, audioTrack?: number) => ({
      url: `https://server.example/api/stream/mode-generation/index.m3u8?quality=${quality}&start=${absolute}&audio=${audioTrack ?? 0}`,
      timelineOffsetSeconds: absolute, startPositionSeconds: 0, quality, audioTrack,
    }));
    const onProgress = vi.fn();
    const props = {
      url: originalUrl, title: "Mode intent film", sourceFileName: "Mode.Movie.mkv", imdbId: "tt0000001",
      startPositionSeconds: position,
      initialHandoffState: { paused: true, volume: 0.35, muted: true, playbackRate: 1.25 },
      playerPreferences: { defaultAudioLanguage: "eng" },
      serverOptimized: { qualities: ["480p", "360p"] as ServerTranscodeQuality[], loadSourceInfo: vi.fn(async () => ({ durationSeconds: 180, tracks })), request },
      onProgress, onClose: vi.fn(),
    };
    const view = render(<VideoPlayer {...props} />);
    readyMode(document.querySelector("video.player-video") as HTMLVideoElement);
    await settleMode(); await settingsMode();
    fireEvent.click(screen.getByRole("button", { name: "Japanese" }));
    await settleMode();
    expect(request).toHaveBeenCalledTimes(1);
    readyMode(document.querySelector("video.player-video") as HTMLVideoElement, position);
    await settleMode(); await settingsMode();
    fireEvent.click(screen.getByRole("button", { name: "360p" }));
    await settleMode();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("360p", position, 1);
    readyMode(document.querySelector("video.player-video") as HTMLVideoElement, position);
    await settleMode(); await settingsMode();
    fireEvent.click(screen.getByRole("button", { name: "Device Original" }));
    await settleMode();
    const original = document.querySelector("video.player-video") as HTMLVideoElement;
    return { props, view, request, original, onProgress };
  }

  it("honors manual Japanese then quality then Original instead of automatically replacing Original again", async () => {
    vi.useFakeTimers();
    try {
      const { request, original, onProgress } = await setupMode();
      expect(original.src).toBe(originalUrl);
      readyMode(original); await settleMode();
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      expect(request).toHaveBeenCalledTimes(2);
      expect(document.querySelector("video.player-video")).toBe(original);
      expect(original.currentTime).toBeCloseTo(position, 6);
      await settingsMode();
      expect(screen.getByRole("button", { name: "Device Original" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onProgress.mock.calls.some(([, , prefs]) => prefs?.preferredAudioLang === "jpn")).toBe(true);
      expect(recordDiagnosticMock.mock.calls.filter(([, code]) => code === "webview.playback_failed")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["Japanese", "360p"])("admits fresh explicit %s after Original without erasing retained Japanese", async (choice) => {
    const { request, original } = await setupMode();
    readyMode(original); await settleMode();
    expect(request).toHaveBeenCalledTimes(2);
    await settingsMode(); fireEvent.click(screen.getByRole("button", { name: choice }));
    await settleMode();
    expect(request.mock.calls.length).toBeGreaterThan(2);
    // Quality keeps the actual Original track; it must not rewrite the
    // retained semantic preference merely because that source defaults to English.
    expect(request).toHaveBeenLastCalledWith(choice === "360p" ? "360p" : "480p", position, choice === "360p" ? 0 : 1);
    expect(document.querySelector("video.player-video")).not.toBe(original);
  });

  it("releases the Original fence on a committed revision while keeping the same-file Japanese preference", async () => {
    const { request, original, view, props } = await setupMode();
    readyMode(original); await settleMode();
    expect(request).toHaveBeenCalledTimes(2);
    view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
    const next = document.querySelector("video.player-video") as HTMLVideoElement;
    readyMode(next); await settleMode();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("480p", position, 1);
  });

  it("permits explicit Retry after Original to restore the retained language", async () => {
    const { request, original } = await setupMode();
    readyMode(original); await settleMode();
    expect(request).toHaveBeenCalledTimes(2);
    fireMediaError(original, 4);
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await settleMode();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("480p", position, 1);
  });
});


describe("Original pending-generation cancellation contract", () => {
  it("allows Original during pending preparation and rejects its late same-owner manifest", async () => {
    isTauriMock.mockReturnValue(true);
    embeddedModeIntentObserver.enabled = true;
    embeddedModeIntentObserver.props.length = 0;
    const pending = deferred<Response>();
    const fetcher = vi.fn(() => pending.promise);
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.stubGlobal("fetch", fetcher);
    const request = vi.fn(async () => ({
      url: "https://server.example/api/stream/late-mode/index.m3u8",
      timelineOffsetSeconds: 0, startPositionSeconds: 0, quality: "480p" as const,
    }));
    try {
      render(<VideoPlayer url="https://server.example/api/stream/original.mkv" engine="native-mpv"
        title="Pending mode" serverOptimized={{ qualities: ["480p"], request }} onClose={() => {}} />);
      const original = embeddedModeIntentObserver.props.at(-1)!;
      act(() => { void original.onSwitchServerOptimized!("480p", 51); });
      await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
      expect(signal.aborted).toBe(false);
      expect(embeddedModeIntentObserver.props.at(-1)!.serverOptimizationPending).toBe(true);
      act(() => { original.onSwitchDeviceOriginal!(51); });
      expect(signal.aborted).toBe(true);
      expect(embeddedModeIntentObserver.props.at(-1)!.serverOptimizationPending).toBe(false);
      await act(async () => { pending.resolve(new Response("#EXTM3U\n")); await pending.promise; for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
      expect(screen.getByTestId("embedded-player")).toHaveAttribute("data-url", "https://server.example/api/stream/original.mkv");
      expect(document.querySelector("video.player-video")).toBeNull();
    } finally { embeddedModeIntentObserver.enabled = false; }
  });

  it("does not let a stale Original callback cancel a newer committed owner", async () => {
    isTauriMock.mockReturnValue(true);
    embeddedModeIntentObserver.enabled = true;
    embeddedModeIntentObserver.props.length = 0;
    const pending = deferred<Response>();
    const fetcher = vi.fn(() => pending.promise);
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.stubGlobal("fetch", fetcher);
    const props = { title: "New owner mode", engine: "native-mpv" as const, serverOptimized: { qualities: ["480p"] as ServerTranscodeQuality[], request: vi.fn(async () => ({ url: "https://server.example/api/stream/new-mode/index.m3u8", timelineOffsetSeconds: 0, startPositionSeconds: 0, quality: "480p" as const })) }, onClose: vi.fn() };
    try {
      const view = render(<VideoPlayer {...props} url="https://server.example/api/stream/A.mkv" />);
      const staleOriginal = embeddedModeIntentObserver.props.at(-1)!.onSwitchDeviceOriginal!;
      view.rerender(<VideoPlayer {...props} url="https://server.example/api/stream/B.mkv" sourceRevision={1} />);
      act(() => { void embeddedModeIntentObserver.props.at(-1)!.onSwitchServerOptimized!("480p", 51); });
      await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
      const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
      act(() => { staleOriginal(8); });
      expect(signal.aborted).toBe(false);
      expect(embeddedModeIntentObserver.props.at(-1)!.serverOptimizationPending).toBe(true);
      await act(async () => { pending.resolve(new Response("#EXTM3U\n")); await pending.promise; for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
      await waitFor(() => expect(hlsInstances.some((instance) => instance.loadSource.mock.calls.some(
        ([source]) => source === "https://server.example/api/stream/new-mode/index.m3u8",
      ))).toBe(true));
      const committed = document.querySelector("video.player-video");
      act(() => { staleOriginal(8); });
      expect(document.querySelector("video.player-video")).toBe(committed);
    } finally { embeddedModeIntentObserver.enabled = false; }
  });
});

describe("exact handoff in-flight seek ownership", () => {
  function observeSeek(video: HTMLVideoElement, clampFirst = false) {
    let currentTime = 0;
    let seeking = false;
    const writes = vi.fn((value: number) => {
      // Model immediate target readback while the browser's asynchronous seek
      // is still in flight, rather than treating assignment as completion.
      currentTime = clampFirst && writes.mock.calls.length === 1 ? 30 : value;
      seeking = true;
    });
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => currentTime, set: writes },
      seeking: { configurable: true, get: () => seeking },
      duration: { configurable: true, value: 1_200 },
      paused: { configurable: true, value: true },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 1_200 } },
    });
    return {
      writes,
      settle: () => { seeking = false; fireEvent.seeked(video); },
    };
  }

  for (const intent of ["playing", "paused", "explicit-play"] as const) {
    it.each(["loadedmetadata", "loadeddata", "durationchange", "progress", "canplay"])(
      `does not restart the ${intent} handoff seek on %s`,
      async (event) => {
        render(<VideoPlayer url="https://media.example/exact.mp4" title="In-flight exact seek"
          startPositionSeconds={120}
          initialHandoffState={{ paused: intent !== "playing", volume: 1, muted: false, playbackRate: 1 }}
          onClose={() => {}} />);
        const video = document.querySelector("video.player-video") as HTMLVideoElement;
        const probe = observeSeek(video);
        const play = vi.mocked(HTMLMediaElement.prototype.play);
        if (intent === "explicit-play") {
          await userEvent.click(screen.getByRole("button", { name: "Play" }));
        }
        fireEvent.loadedMetadata(video);
        expect(probe.writes.mock.calls).toEqual([[120]]);
        fireEvent.seeking(video);
        fireEvent(video, new Event(event));
        fireEvent(video, new Event(event));
        expect(probe.writes.mock.calls).toEqual([[120]]);
        expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
        expect(play).not.toHaveBeenCalled();

        probe.settle();
        expect(probe.writes.mock.calls).toEqual([[120]]);
        expect(screen.queryByText("Synchronizing playback…")).toBeNull();
        expect(play).toHaveBeenCalledTimes(intent === "paused" ? 0 : 1);
        // Completing a paused handoff must not leave a permanent Play veto.
        if (intent === "paused") {
          await userEvent.click(screen.getByRole("button", { name: "Play" }));
          expect(play).toHaveBeenCalledTimes(1);
        }
      },
    );
  }

  it("retries an exact seek that settled at a clamped wrong position, then confirms only its completed retry", () => {
    render(<VideoPlayer url="https://media.example/clamped.mp4" title="Clamped exact seek"
      startPositionSeconds={120}
      initialHandoffState={{ paused: false, volume: 1, muted: false, playbackRate: 1 }}
      onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const probe = observeSeek(video, true);
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(30);
    expect(probe.writes.mock.calls).toEqual([[120]]);
    expect(play).not.toHaveBeenCalled();

    // A completed but clamped seek is not success. The existing seeked handler
    // must retry immediately, without a polling timer or sticky pending latch.
    probe.settle();
    expect(probe.writes.mock.calls).toEqual([[120], [120]]);
    expect(video.currentTime).toBe(120);
    expect(screen.getByRole("status")).toHaveTextContent("Synchronizing playback");
    expect(play).not.toHaveBeenCalled();
    fireEvent.canPlay(video);
    expect(probe.writes.mock.calls).toEqual([[120], [120]]);
    expect(play).not.toHaveBeenCalled();

    probe.settle();
    expect(screen.queryByText("Synchronizing playback…")).toBeNull();
    expect(probe.writes.mock.calls).toEqual([[120], [120]]);
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe("physical HTML media retirement", () => {
  function mainVideo(): HTMLVideoElement {
    const video = document.querySelector<HTMLVideoElement>("video.player-video");
    if (video == null) throw new Error("Main reader did not mount");
    return video;
  }
  function ready(video: HTMLVideoElement) {
    Object.defineProperty(video, "duration", { configurable: true, value: 720 });
    markCurrentMediaDataReady(video);
    fireEvent.loadedMetadata(video); fireEvent.canPlay(video); fireEvent.play(video);
  }

  it.each(["direct", "native HLS"] as const)("resets detached %s media after final progress capture and listener disposal", (reader) => {
    if (reader === "native HLS") {
      deviceKindMock.mockReturnValue("ios");
      vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    }
    const url = reader === "direct" ? "https://media.example/original.mp4" : "https://media.example/native.m3u8";
    const trace: string[] = [];
    const onProgress = vi.fn((position: number) => { trace.push("progress:" + position); });
    const view = render(<VideoPlayer url={url} title="Retiring main media" onProgress={onProgress} onClose={() => {}} />);
    const video = mainVideo(); ready(video); video.currentTime = 240.333;
    expect(video.getAttribute("src")).toBe(url);
    const remove = video.removeAttribute.bind(video);
    vi.spyOn(video, "pause").mockImplementation(() => { trace.push("pause"); fireEvent.pause(video); });
    vi.spyOn(video, "removeAttribute").mockImplementation((name) => { if (name === "src") trace.push("remove-src"); remove(name); });
    vi.spyOn(video, "load").mockImplementation(() => {
      trace.push("load"); expect(video.getAttribute("src")).toBeNull();
      video.currentTime = 0; fireEvent.timeUpdate(video); fireEvent.loadStart(video);
    });
    trace.length = 0; onProgress.mockClear();
    view.unmount();
    expect(video.isConnected).toBe(false);
    expect(trace).toEqual(["progress:240.333", "pause", "remove-src", "load"]);
    expect(onProgress).toHaveBeenCalledTimes(1); expect(video.getAttribute("src")).toBeNull();
    expect(video.pause).toHaveBeenCalledTimes(1); expect(video.load).toHaveBeenCalledTimes(1);
  });

  it("retires the captured old node without resetting its keyed successor or accepting late old media events", async () => {
    const props = { title: "Keyed source ownership", onClose: () => {} };
    const view = render(<VideoPlayer {...props} url="https://media.example/old.mp4" />);
    const old = mainVideo(); ready(old); old.currentTime = 240.333;
    const oldLoad = vi.spyOn(old, "load"); const oldPause = vi.spyOn(old, "pause");
    view.rerender(<VideoPlayer {...props} url="https://media.example/new.mp4" sourceRevision={1} />);
    const successor = mainVideo(); ready(successor); successor.currentTime = 240.333;
    expect(successor).not.toBe(old); expect(successor.isConnected).toBe(true);
    expect(old.getAttribute("src")).toBeNull();
    expect(oldLoad).toHaveBeenCalledTimes(1); expect(oldPause).toHaveBeenCalledTimes(1);
    // Prototype methods are shared vi.fn boundaries in this suite. Give the
    // successor its own boundary, not another alias to the old call history.
    const successorLoad = vi.fn(), successorPause = vi.fn();
    Object.defineProperties(successor, {
      load: { configurable: true, value: successorLoad },
      pause: { configurable: true, value: successorPause },
    });
    Object.defineProperty(old, "error", { configurable: true, value: { code: 3 } });
    fireEvent.error(old); fireEvent.pause(old); fireEvent.play(old); fireEvent.timeUpdate(old); fireEvent.canPlay(old);
    await act(async () => { await Promise.resolve(); });
    expect(mainVideo()).toBe(successor); expect(successor.getAttribute("src")).toBe("https://media.example/new.mp4");
    expect(successor.currentTime).toBe(240.333);
    expect(successorLoad).not.toHaveBeenCalled(); expect(successorPause).not.toHaveBeenCalled();
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    view.unmount();
  });

  it("does not reset connected StrictMode replay or ordinary listener-effect updates", () => {
    const url = "https://media.example/connected.mp4";
    const view = render(<StrictMode><VideoPlayer url={url} title="Connected owner" scrobbleContext={{ tmdbId: 1, type: "movie" }} onClose={() => {}} /></StrictMode>);
    const video = mainVideo(); ready(video); video.currentTime = 240.333;
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    view.rerender(<StrictMode><VideoPlayer url={url} title="Connected owner" scrobbleContext={{ tmdbId: 2, type: "movie" }} onClose={() => {}} /></StrictMode>);
    expect(mainVideo()).toBe(video); expect(video.isConnected).toBe(true);
    expect(video.getAttribute("src")).toBe(url); expect(video.currentTime).toBe(240.333);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not retire a connected media node during Suspense hide and reveal", () => {
    const pending = new Promise<void>(() => {});
    let choose: (hidden: boolean) => void = () => { throw new Error("Scenario not mounted"); };
    function Gate({ hidden }: { hidden: boolean }) { if (hidden) throw pending; return null; }
    function Scenario() {
      const [hidden, setHidden] = useState(false); choose = setHidden;
      return <Suspense fallback={<div>Retirement suspended</div>}>
        <VideoPlayer url="https://media.example/suspended.mp4" title="Suspended owner" onClose={() => {}} />
        <Gate hidden={hidden} />
      </Suspense>;
    }
    const view = render(<Scenario />); const video = mainVideo(); ready(video); video.currentTime = 240.333;
    act(() => choose(true));
    expect(screen.getByText("Retirement suspended")).toBeInTheDocument();
    expect(video.isConnected).toBe(true); expect(video.getAttribute("src")).toBe("https://media.example/suspended.mp4");
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    act(() => choose(false));
    expect(mainVideo()).toBe(video); expect(video.currentTime).toBe(240.333);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the live original resource while replacement preparation is pending and rejected", async () => {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    const preparation = deferred<never>(); const request = vi.fn(() => preparation.promise);
    const view = render(<VideoPlayer url="https://server.example/api/stream/original.mp4" title="Rejected replacement"
      serverOptimized={{ qualities: ["480p"], request }} onClose={() => {}} />);
    const original = mainVideo(); ready(original); original.currentTime = 240.333; fireEvent.pause(original);
    const src = original.getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    fireEvent.click(screen.getByRole("button", { name: "480p" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(mainVideo()).toBe(original); expect(original.isConnected).toBe(true);
    expect(original.getAttribute("src")).toBe(src); expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    await act(async () => { preparation.reject(new Error("synthetic preparation failure")); });
    await screen.findByText(/synthetic preparation failure/);
    expect(mainVideo()).toBe(original); expect(original.isConnected).toBe(true);
    expect(original.getAttribute("src")).toBe(src); expect(original.currentTime).toBe(240.333);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    view.unmount();
  });

  it("runs physical retirement after HLS destruction and ignores the retired HLS retry callback", async () => {
    const view = render(<VideoPlayer url="https://media.example/stream.m3u8" title="HLS retirement ordering" onClose={() => {}} />);
    const video = mainVideo();
    await waitFor(() => expect(hlsInstances[0]?.attachMedia).toHaveBeenCalledWith(video));
    const instance = hlsInstances[0], trace: string[] = [];
    instance.destroy.mockImplementation(() => { trace.push("hls-destroy"); });
    vi.spyOn(video, "pause").mockImplementation(() => { trace.push("pause"); });
    vi.spyOn(video, "load").mockImplementation(() => { trace.push("load"); });
    view.unmount();
    expect(trace).toEqual(["hls-destroy", "pause", "load"]);
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    const loads = instance.startLoad.mock.calls.length;
    act(() => instance.emit("hlsError", { fatal: true, type: "networkError" }));
    expect(instance.startLoad).toHaveBeenCalledTimes(loads);
  });
});


describe("interrupted webview header exit", () => {
  function ready(video: HTMLVideoElement) {
    Object.defineProperties(video, {
      paused: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      duration: { configurable: true, value: 900 },
    });
    fireEvent.canPlay(video); fireEvent.play(video); fireEvent.playing(video);
  }
  function hiddenPlaying(layout: "desktop" | "android" = "desktop") {
    vi.useFakeTimers();
    if (layout === "android") {
      deviceKindMock.mockReturnValue("android"); isTauriMock.mockReturnValue(true);
      Object.defineProperty(window, "__YAWF_TAURI_ANDROID__", { configurable: true, value: true });
    }
    const onClose = vi.fn();
    const props = { url: "https://x/error-exit.mp4", title: "Error exit", onClose };
    const view = render(<VideoPlayer {...props} />);
    const pane = screen.getByRole("dialog", { name: "Playing Error exit" });
    if (layout === "android") expect(pane).toHaveClass("is-touch-player");
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    ready(video);
    const bar = pane.querySelector(".player-bar")!;
    const advance = () => act(() => vi.advanceTimersByTime(3_201));
    advance();
    expect(bar).not.toHaveClass("is-visible");
    expect(screen.queryByRole("button", { name: "Close player" })).toBeNull();
    return { view, props, video, bar, pane, onClose, advance };
  }

  it.each(["desktop", "android"] as const)("[error-exit] reveals and pins the %s error header with an accessible normal Close", (layout) => {
    const { video, bar, pane, onClose, advance } = hiddenPlaying(layout);
    fireMediaError(video);
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(document.querySelector("video.player-video")).toBeNull();
    expect(bar).toHaveClass("is-visible"); expect(bar).not.toHaveAttribute("aria-hidden", "true");
    // Ordinary activity must not turn the error header into another transient
    // 3200ms reveal. Do not focus or hover a control until after this assertion.
    fireEvent.pointerMove(pane);
    advance(); advance();
    expect(bar).toHaveClass("is-visible");
    const close = screen.getByRole("button", { name: "Close player" });
    const details = screen.getByRole("button", { name: "Player details and shortcuts" });
    expect(close.tabIndex).toBe(0); expect(details.tabIndex).toBe(0);
    fireEvent.keyDown(pane, { key: "Tab" });
    expect(details).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["retry", "source-owner change"] as const)("[error-exit] releases the error pin after %s becomes playable", (action) => {
    const { view, props, video, bar, advance } = hiddenPlaying();
    fireMediaError(video);
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(bar).toHaveClass("is-visible");
    advance(); expect(bar).toHaveClass("is-visible");
    if (action === "retry") fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    else view.rerender(<VideoPlayer {...props} sourceRevision={1} />);
    expect(screen.queryByText("Playback interrupted")).toBeNull();
    const successor = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(successor).not.toBeNull(); expect(successor).not.toBe(video);
    ready(successor);
    advance();
    expect(bar).not.toHaveClass("is-visible");
    expect(screen.queryByRole("button", { name: "Close player" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close player", hidden: true }).tabIndex).toBe(-1);
  });

  for (const layout of ["desktop", "android"] as const) {
    for (const menu of ["settings", "captions"] as const) {
      it.each(["Close", "Escape"] as const)(`[error-modal] restores ${layout} ${menu} ownership to the error pane for %s`, (exit) => {
        captionMenuMode.actual = true;
        const { video, pane, bar, onClose } = hiddenPlaying(layout);
        fireEvent.pointerMove(pane);
        const menuName = menu === "settings" ? "Playback settings" : "Subtitles";
        const trigger = screen.getByRole("button", { name: menuName });
        fireEvent.click(trigger);
        const ordinary = screen.getByRole("dialog", { name: menuName });
        expect(ordinary).toHaveFocus();
        // A live child dialog still owns Escape; the parent cannot waive its
        // suspension globally just to repair interrupted playback.
        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: menuName })).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(trigger);
        expect(screen.getByRole("dialog", { name: menuName })).toHaveFocus();
        if (layout === "android") expect(bar).toHaveAttribute("inert");

        // Resource errors are delivered even while a modal owns user input.
        fireMediaError(video);
        expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
        expect(screen.queryByRole("dialog", { name: menuName })).toBeNull();
        expect(document.querySelector("video.player-video")).toBeNull();
        expect(pane).not.toHaveClass("has-touch-menu");
        expect(bar).not.toHaveAttribute("inert"); expect(bar).not.toHaveAttribute("aria-hidden", "true");
        const close = screen.getByRole("button", { name: "Close player" });
        const details = screen.getByRole("button", { name: "Player details and shortcuts" });
        fireEvent.keyDown(window, { key: "Tab" });
        expect(details).toHaveFocus();
        expect(onClose).not.toHaveBeenCalled();
        if (exit === "Close") fireEvent.click(close);
        else fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    }
  }

  it.each(["desktop", "android"] as const)("[error-modal] preserves independent %s Details modal ownership on an interrupted pane", (layout) => {
    const { video, onClose } = hiddenPlaying(layout);
    fireMediaError(video);
    fireEvent.click(screen.getByRole("button", { name: "Player details and shortcuts" }));
    const details = screen.getByRole("dialog", { name: "Player details and shortcuts" });
    expect(details).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Player details and shortcuts" })).toBeNull();
    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "failed"] as const)("[error-exit] preserves the separate %s native external panel header", async (state) => {
    vi.useFakeTimers(); isTauriMock.mockReturnValue(true);
    if (state === "failed") {
      playWithMpvMock.mockRejectedValue(new Error("Synthetic native unavailable"));
      openInExternalPlayerMock.mockRejectedValue(new Error("Synthetic external unavailable"));
    }
    render(<VideoPlayer url="https://x/native.mkv" engine="native-mpv" useBuiltInPlayer={false} title="Native exit" onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector("video.player-video")).toBeNull();
    if (state === "failed") expect(screen.getByText("Could not open a player")).toBeInTheDocument();
    else expect(screen.getByText(/Playing in the bundled mpv/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6_402));
    expect(document.querySelector(".player-bar")).toHaveClass("is-visible");
    expect(screen.getByRole("button", { name: "Close player" }).tabIndex).toBe(0);
    expect(screen.queryByRole("button", { name: "Retry playback" })).toBeNull();
    expect(playWithMpvMock).toHaveBeenCalledTimes(1);
  });
});

describe("mobile background playback lifecycle", () => {
  const master = "https://server.example/api/stream/resume/index.m3u8?quality=480p";
  const manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n480p.m3u8?generation=transcode-resume\n";
  const optimized = { qualities: ["480p"] as const, request: vi.fn() };
  async function flush() {
    await act(async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); });
  }
  function layout(android: boolean) {
    vi.useFakeTimers();
    if (android) {
      Object.defineProperty(window, "__YAWF_NATIVE_SAFE_AREA__", {
        configurable: true, value: { getInsets: vi.fn() },
      });
    }
  }
  function mediaState(video: HTMLVideoElement, paused = false) {
    const state = { paused, seeking: false, ended: false };
    for (const key of ["paused", "seeking", "ended"] as const) {
      Object.defineProperty(video, key, { configurable: true, get: () => state[key] });
    }
    fireEvent.canPlay(video);
    fireEvent(video, new Event(paused ? "pause" : "playing"));
    return state;
  }
  function leaseFetch(status: number) {
    globalThis.__DEBRIDSTREAMER_SERVER_URL__ = "https://server.example";
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("probably");
    let expired = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: expired ? status : 200 }) : new Response(manifest));
    vi.stubGlobal("fetch", fetcher);
    return { fetcher, expire: () => { expired = true; } };
  }
  async function sleepPage(expire: () => void) {
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expire();
    act(() => { window.dispatchEvent(new Event("pageshow")); });
    await flush();
  }

  it.each([
    ["generic visibility", false, "visibility"], ["Android visibility", true, "visibility"],
    ["generic pagehide", false, "pagehide"], ["Android pagehide", true, "pagehide"],
  ] as const)("[resume-watchdog] suspends %s background time and grants a fresh foreground window", async (_name, android, event) => {
    layout(android);
    const restoreVisibility = replaceProperty(document, "visibilityState", "visible");
    try {
      const refresh = vi.fn(async () => {});
      render(<VideoPlayer url="https://x/background.mp4" title="Background" refreshCurrentSource={refresh} onClose={() => {}} />);
      expect(document.querySelector(".player")!.classList.contains("is-touch-player")).toBe(android);
      const video = document.querySelector("video.player-video") as HTMLVideoElement;
      video.currentTime = 40; mediaState(video);
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      act(() => {
        if (event === "visibility") {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        } else window.dispatchEvent(new Event("pagehide"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
      expect(refresh).not.toHaveBeenCalled();
      expect(document.querySelector("video.player-video")).toBe(video);
      video.currentTime = 46.25; // Native clock may move while JS is suspended, without a timeupdate.
      act(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        if (event === "visibility") document.dispatchEvent(new Event("visibilitychange"));
        else window.dispatchEvent(new Event("pageshow"));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
      expect(refresh).not.toHaveBeenCalled();
      // Foreground event noise must not postpone a genuine stall indefinitely.
      act(() => { window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(46.25, expect.objectContaining({ paused: false }));
    } finally { restoreVisibility(); }
  });

  it("[resume-watchdog] keeps paused, cast, seeking and ended guards after a foreground transition", async () => {
    layout(true); isTauriMock.mockReturnValue(true);
    const refresh = vi.fn(async () => {});
    render(<VideoPlayer url="https://x/background.mp4" title="Background guards" refreshCurrentSource={refresh} onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    const state = mediaState(video);
    state.paused = true; fireEvent.pause(video);
    act(() => window.dispatchEvent(new Event("pagehide")));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(refresh).not.toHaveBeenCalled();
    state.paused = false; fireEvent.playing(video);
    fireEvent.click(screen.getByRole("button", { name: "test suspend playback" }));
    act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "test resume playback" }));
    state.seeking = true; fireEvent.seeking(video);
    act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(refresh).not.toHaveBeenCalled();
    state.seeking = false; fireEvent.seeked(video); state.ended = true;
    fireEvent.ended(video);
    act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([[404, true], [403, false]] as const)("[resume-lease] automatically replaces expired %s generation preserving paused=%s exact handoff", async (status, paused) => {
    layout(true);
    const fixture = leaseFetch(status);
    const pending = deferred<void>();
    const refresh = vi.fn((_position: number, _state: { paused: boolean; volume: number; muted: boolean; playbackRate: number }) => pending.promise);
    const props = { title: "Resume lease", serverOptimized: optimized, refreshCurrentSource: refresh, onClose: () => {} };
    const view = render(<VideoPlayer {...props} url={master} engine="webview-hls-transcode" timelineOffsetSeconds={46} />);
    await flush();
    const old = document.querySelector("video.player-video") as HTMLVideoElement;
    const state = mediaState(old, paused);
    const initialPlayCalls = vi.mocked(old.play).mock.calls.length;
    old.currentTime = 7.25; old.volume = 0.4; old.muted = true; old.playbackRate = 1.25;
    await sleepPage(fixture.expire);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(53.25, { paused, volume: 0.4, muted: true, playbackRate: 1.25 });
    expect(old.play).toHaveBeenCalledTimes(initialPlayCalls);
    expect(document.querySelector("video.player-video")).toBeNull();
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    act(() => { window.dispatchEvent(new Event("pageshow")); window.dispatchEvent(new Event("pageshow")); });
    await flush(); expect(refresh).toHaveBeenCalledTimes(1);
    const handoff = refresh.mock.calls[0]![1];
    view.rerender(<VideoPlayer {...props} url="https://x/fresh.mp4" sourceRevision={2} startPositionSeconds={53.25} initialHandoffState={handoff} />);
    pending.resolve(); await flush();
    const fresh = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(fresh).not.toBe(old); expect(fresh.src).toBe("https://x/fresh.mp4");
    const freshPlayCalls = vi.mocked(fresh.play).mock.calls.length;
    Object.defineProperties(fresh, {
      duration: { configurable: true, value: 720 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    });
    fireEvent.loadedMetadata(fresh); fireEvent.seeked(fresh);
    expect(fresh.currentTime).toBe(53.25);
    expect(fresh.volume).toBe(0.4); expect(fresh.muted).toBe(true); expect(fresh.playbackRate).toBe(1.25);
    expect(fresh.play).toHaveBeenCalledTimes(freshPlayCalls + (paused ? 0 : 1));
    expect(screen.queryByRole("alert")).toBeNull(); expect(state.paused).toBe(paused);
    expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method !== "HEAD")).toHaveLength(1);
  });

  it("[resume-lease] bounds StrictMode automatic expiry recovery then retries the same paused snapshot without old attach", async () => {
    layout(false); deviceKindMock.mockReturnValue("ios");
    const fixture = leaseFetch(404);
    const pending = deferred<void>();
    const retry = deferred<void>();
    const refresh = vi.fn((_position: number, _state: { paused: boolean; volume: number; muted: boolean; playbackRate: number }) => pending.promise)
      .mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => retry.promise);
    render(<StrictMode><VideoPlayer url={master} engine="webview-hls-transcode" title="Bounded resume" serverOptimized={optimized}
      refreshCurrentSource={refresh} timelineOffsetSeconds={3600} onClose={() => {}} /></StrictMode>);
    await flush();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    mediaState(video, true); video.currentTime = 7.25; video.volume = 0.3; video.muted = true; video.playbackRate = 1.5;
    await sleepPage(fixture.expire);
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(FRESH_STREAM_RESOLUTION_TIMEOUT_MS - 1); });
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("alert")).toHaveTextContent("A fresh stream could not be prepared");
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    fireEvent.click(screen.getByRole("button", { name: "Preparing fresh stream" }));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[0]).toEqual([3607.25, { paused: true, volume: 0.3, muted: true, playbackRate: 1.5 }]);
    expect(refresh.mock.calls[1]).toEqual(refresh.mock.calls[0]);
    pending.resolve(); retry.resolve(); await flush();
    expect(document.querySelector("video.player-video")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["revision", "unmount"] as const)("[resume-lease] ignores late expired resolution failure after %s", async (change) => {
    layout(true); const fixture = leaseFetch(404);
    const pending = deferred<void>(); const refresh = vi.fn((_position: number, _state: { paused: boolean; volume: number; muted: boolean; playbackRate: number }) => pending.promise);
    const props = { url: master, engine: "webview-hls-transcode" as const, title: "Stale resume", serverOptimized: optimized, refreshCurrentSource: refresh, onClose: () => {} };
    const view = render(<VideoPlayer {...props} sourceRevision={1} />); await flush();
    mediaState(document.querySelector("video.player-video") as HTMLVideoElement, true);
    await sleepPage(fixture.expire); expect(refresh).toHaveBeenCalledTimes(1);
    if (change === "unmount") view.unmount();
    else view.rerender(<VideoPlayer {...props} sourceRevision={2} serverOptimized={undefined} engine="webview-direct" />);
    const successor = document.querySelector("video.player-video");
    recordDiagnosticMock.mockClear();
    pending.reject(new Error("Old generation resolution failed")); await flush();
    expect(document.querySelector("video.player-video")).toBe(successor);
    expect(screen.queryByRole("alert")).toBeNull(); expect(recordDiagnosticMock).not.toHaveBeenCalled();
  });

  it("[resume-lease] coalesces expiry with the current fresh request instead of starting a second resolver", async () => {
    layout(false); const fixture = leaseFetch(404);
    const pending = deferred<void>(); const refresh = vi.fn((_position: number, _state: { paused: boolean; volume: number; muted: boolean; playbackRate: number }) => pending.promise);
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Coalesced" serverOptimized={optimized} refreshCurrentSource={refresh} onClose={() => {}} />);
    await flush();
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    video.currentTime = 40; mediaState(video);
    fixture.expire();
    // The watchdog and second HEAD share the deadline; both must use one resolver.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video.player-video")).toBeNull();
    expect(screen.getByRole("button", { name: "Preparing fresh stream" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("A fresh stream could not be prepared");
  });

  it("[resume-lease] keeps 401 unauthorized handling separate from expired-generation recovery", async () => {
    layout(false); const fixture = leaseFetch(401); const refresh = vi.fn(async () => {});
    render(<VideoPlayer url={master} engine="webview-hls-transcode" title="Unauthorized" serverOptimized={optimized} refreshCurrentSource={refresh} onClose={() => {}} />);
    await flush(); mediaState(document.querySelector("video.player-video") as HTMLVideoElement, true);
    await sleepPage(fixture.expire);
    expect(refresh).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    const heads = fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fixture.fetcher.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(heads);
  });
});
