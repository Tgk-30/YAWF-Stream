// @vitest-environment jsdom
//
// Control-UI + effect tests for the in-app VideoPlayer. Real playback (codec
// decode, HLS networking, native mpv hand-off) is mocked away; we exercise the
// branch selection (webview vs external), the CC popover toggle, the OSD row,
// the HLS source attach and recovery paths, and the mpv lifecycle effect.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";

// ---- Mocks for heavy / environment-bound deps -----------------------------

// hls.js: default export with the static helpers the source touches. The shared
// state is created via vi.hoisted so the hoisted vi.mock factory can close over
// it without a temporal-dead-zone error.
const { hlsInstances, hlsIsSupported } = vi.hoisted(() => ({
  hlsInstances: [] as Array<{
    config: {
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
  onScrubbingChange?: (scrubbing: boolean) => void;
}) => (
  <div
    data-testid="scrub-bar"
    data-current-time={props.currentTime}
    onPointerDown={() => props.onScrubbingChange?.(true)}
    onPointerUp={() => props.onScrubbingChange?.(false)}
  />
)));
const iconMock = vi.hoisted(() => vi.fn(({ name }: { name: string }) => <span data-icon={name} />));
const recordDiagnosticMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/diagnostics", () => ({
  recordDiagnostic: (...args: unknown[]) => recordDiagnosticMock(...args),
}));
vi.mock("./CastControls", () => ({
  CastControls: ({ onLocalPlaybackChange }: {
    onLocalPlaybackChange: (suspended: boolean) => void;
  }) => (
    <>
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
    };
    static ErrorTypes = { NETWORK_ERROR: "networkError" };
    static ErrorDetails = {
      MANIFEST_LOAD_ERROR: "manifestLoadError",
      MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
    };
    config: {
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
    loadSource = vi.fn();
    attachMedia = vi.fn((media: HTMLMediaElement) => {
      // Real media attachment runs the media load algorithm, which resets the
      // current speed to defaultPlaybackRate on affected Android WebViews.
      media.playbackRate = media.defaultPlaybackRate;
    });
    destroy = vi.fn();
    on = vi.fn();
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
  useAppStore: () => ({}),
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
vi.mock("./player/useSubtitleTracks", () => ({
  useSubtitleTracks: () => ({
    tracks: subsState.tracks,
    activeTrackId: subsState.activeTrackId,
    setActiveTrack: vi.fn(),
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
  }),
}));

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
vi.mock("./player/ScrubBar", () => ({
  ScrubBar: scrubBarMock,
}));
vi.mock("./player/CaptionsMenu", () => ({
  CaptionsMenu: (props: { onClose: () => void }) => (
    <div data-testid="captions-menu">
      <button type="button" onClick={props.onClose}>
        close-captions
      </button>
    </div>
  ),
}));
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

// jsdom's <video> has no play/pause/load/canPlayType implementations.
beforeEach(() => {
  vi.stubGlobal("location", new URL("tauri://localhost/"));
  recordDiagnosticMock.mockClear();
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

  it("replaces old browser capability links and never exposes provider URLs", async () => {
    deviceKindMock.mockReturnValue("ios");
    vi.stubGlobal("location", new URL("https://server.example/watch"));
    const first = `https://server.example/api/external-stream/first/${"C".repeat(43)}`;
    const second = `https://server.example/api/external-stream/second/${"D".repeat(43)}`;
    const { rerender } = render(
      <VideoPlayer
        url="https://server.example/api/stream/first"
        externalPlaybackUrl={first}
        title="Film"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("link", { name: /Open in VLC/ })).toHaveAttribute(
      "href",
      expect.stringContaining(encodeURIComponent(first)),
    );

    rerender(
      <VideoPlayer
        url="https://server.example/api/stream/second"
        externalPlaybackUrl={second}
        title="Film"
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    const replacement = screen.getByRole("link", { name: /Open in VLC/ });
    expect(replacement).toHaveAttribute(
      "href",
      expect.stringContaining(encodeURIComponent(second)),
    );
    expect(replacement.getAttribute("href")).not.toContain(encodeURIComponent(first));

    rerender(
      <VideoPlayer
        url="https://provider.example/private-file.mkv"
        externalPlaybackUrl="https://provider.example/private-file.mkv?authorization=secret"
        title="Film"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: /Open in VLC/ })).toBeNull();
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
      fireEvent.seeked(optimizedVideo);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();
      expect(play).toHaveBeenCalledTimes(1);
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
      fireEvent.seeked(restoredVideo);
      expect(play).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(restoredVideo);
      fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Device Original was restored");
      expect(screen.getByRole("button", { name: "Device Original" })).toHaveAttribute(
        "aria-pressed",
        "true",
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
      Object.defineProperty(originalVideo, "paused", { configurable: true, value: false });
      fireEvent.canPlay(originalVideo);
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
      fireEvent.canPlay(optimizedVideo);
      fireEvent.seeked(optimizedVideo);
      expect(screen.queryByText("Synchronizing playback…")).toBeNull();

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
      Object.defineProperty(restoredVideo, "duration", { configurable: true, value: 120 });
      Object.defineProperty(restoredVideo, "paused", { configurable: true, value: true });
      const play = vi.mocked(HTMLMediaElement.prototype.play);
      play.mockClear();
      fireEvent.loadedMetadata(restoredVideo);
      fireEvent.seeked(restoredVideo);
      fireEvent.canPlay(restoredVideo);
      expect(play).not.toHaveBeenCalled();
      expect(screen.queryByText("Playback interrupted")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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
      const handler = hlsInstances[0].on.mock.calls[0]?.[1] as (
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
      const handler = hlsInstances[0].on.mock.calls[0]?.[1] as (
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
      const handler = hlsInstances[0].on.mock.calls[0]?.[1] as (
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
    const handler = hlsInstances[0].on.mock.calls[0]?.[1] as (
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

  it("keeps native HLS in the iOS app", () => {
    deviceKindMock.mockReturnValue("ios");
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

    expect(hlsInstances).toHaveLength(0);
    const video = document.querySelector("video.player-video") as HTMLVideoElement;
    expect(video.src).toBe("https://x/stream.m3u8");
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
