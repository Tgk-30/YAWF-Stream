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
vi.mock("./EmbeddedPlayer", () => ({
  EmbeddedPlayer: (props: {
    title: string;
    url: string;
    engine: string;
    playbackAuthorization?: string;
    onPlaybackError?: (error: Error) => boolean | Promise<boolean>;
    onOpenExternalPlayer?: () => void | Promise<void>;
    externalActionStatus?: string | null;
  }) => (
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
  ),
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

  it("routes touch transport, speed, fit, captions, settings, and next through existing handlers", async () => {
    deviceKindMock.mockReturnValue("ios");
    const onPlayNext = vi.fn();
    render(
      <VideoPlayer
        url="https://x/movie.mp4"
        title="Touch film"
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

      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      fireMediaError(document.querySelector("video.player-video") as HTMLVideoElement);
      expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Open in external player/ })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Copy stream link" }));
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(openAndroidExternalPlayerMock).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
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
    expect(screen.getByText("External player opened.")).toBeInTheDocument();
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

  it("keeps real local touch previews and keyboard seeks immediate", () => {
    scrubBarMode.actual = true;
    render(<VideoPlayer url="https://x/movie.mp4" title="Local touch" onClose={() => {}} />);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 1_000 });
    fireEvent.loadedMetadata(video);
    const slider = screen.getByRole("slider", { name: "Seek" });
    slider.getBoundingClientRect = vi.fn(() => ({ left: 0, width: 100 } as DOMRect));
    fireEvent.pointerDown(slider, { pointerId: 7, pointerType: "touch", clientX: 20 });
    expect(video.currentTime).toBe(200);
    fireEvent.pointerMove(slider, { pointerId: 7, pointerType: "touch", clientX: 80 });
    expect(video.currentTime).toBe(800);
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

  it("shows a fullscreen control and reflects fullscreenchange state", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const restoreRequestFullscreen = replaceProperty(
      HTMLElement.prototype,
      "requestFullscreen",
      requestFullscreen,
    );
    const restoreFullscreenElement = replaceProperty(document, "fullscreenElement", null);
    try {
      render(<VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />);
      const stage = document.querySelector(".player-stage") as HTMLElement;
      const enter = screen.getByRole("button", { name: "Enter fullscreen" });
      await userEvent.click(enter);
      expect(requestFullscreen).toHaveBeenCalledWith();

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: stage,
      });
      fireEvent(document, new Event("fullscreenchange"));
      expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeInTheDocument();
    } finally {
      restoreRequestFullscreen();
      restoreFullscreenElement();
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
      await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
      expect(enterWebKitFullscreen).toHaveBeenCalledWith();
    } finally {
      restoreSupportsFullscreen();
      restoreEnterFullscreen();
    }
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

  it("hides inactive web chrome, preserves it for pause or menus, and reveals it on pointer activity", () => {
    vi.useFakeTimers();
    try {
      render(<VideoPlayer url="https://x/movie.mp4" title="T" onClose={() => {}} />);
      const bar = document.querySelector(".player-bar") as HTMLElement;
      const osd = document.querySelector(".player-osd") as HTMLElement;
      const player = document.querySelector(".player") as HTMLElement;
      const video = document.querySelector("video.player-video") as HTMLVideoElement;

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

describe("post-start webview stall recovery", () => {
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
    fireEvent.playing(video);
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
    fireEvent.playing(video);
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
    fireEvent.playing(video);
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
    fireEvent.playing(video);
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
    fireEvent.playing(video);
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
    fireEvent.playing(document.querySelector("video.player-video") as HTMLVideoElement);
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
// Up next (auto-advance) overlay
// ---------------------------------------------------------------------------

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

  it("keeps the paused frame unobscured for selected embedded or downloaded captions while retaining transport", () => {
    subsState.tracks = [{ id: "download", label: "Downloaded", language: "en", vttUrl: "blob:cc" }];
    render(<VideoPlayer url="https://x/native.mp4" title="T" onClose={() => {}} />);
    const video = document.querySelector("video")!;
    fireEvent.pause(video);
    expect(document.querySelector(".player-pause-screen")).not.toBeNull();
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
    expect(document.querySelector(".player-pause-screen")).not.toBeNull();
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
  it("expires into manual fresh resolution preserving paused source position instead of restoring an old URL", async () => {
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
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await flushLease();
    expect(refresh).toHaveBeenCalledWith(53.25, { paused: true, volume: 0.4, muted: true, playbackRate: 1.25 });
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
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
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
