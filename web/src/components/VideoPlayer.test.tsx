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
    config: { xhrSetup?: (xhr: XMLHttpRequest) => void };
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
const scrubBarMock = vi.hoisted(() => vi.fn((props: { currentTime: number }) => (
  <div data-testid="scrub-bar" data-current-time={props.currentTime} />
)));
const iconMock = vi.hoisted(() => vi.fn(({ name }: { name: string }) => <span data-icon={name} />));
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
    config: { xhrSetup?: (xhr: XMLHttpRequest) => void };
    levels: Array<{ height?: number; bitrate?: number; name?: string }> = [];
    audioTracks: Array<{ name?: string; lang?: string }> = [];
    currentLevel = -1;
    audioTrack = 0;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    on = vi.fn();
    startLoad = vi.fn();
    recoverMediaError = vi.fn();
    constructor(config: { xhrSetup?: (xhr: XMLHttpRequest) => void }) {
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
const mpvStopMock = vi.fn(async () => {});
vi.mock("../lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  playWithMpv: (url: string, authorization?: string) =>
    playWithMpvMock(url, authorization),
  openInExternalPlayer: (
    url: string,
    preferred?: string,
    authorization?: string,
  ) => openInExternalPlayerMock(url, preferred, authorization),
  mpvStop: () => mpvStopMock(),
}));

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

// jsdom's <video> has no play/pause/load/canPlayType implementations.
beforeEach(() => {
  hlsInstances.length = 0;
  hlsIsSupported.mockReturnValue(true);
  isTauriMock.mockReturnValue(false);
  playWithMpvMock.mockResolvedValue({ embedded: false, status: "ok" });
  openInExternalPlayerMock.mockResolvedValue("VLC hand-off");
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
  delete window.YawfAndroidTV;
  vi.clearAllMocks();
});

// ---- Top-level shell + branch selection -----------------------------------

describe("VideoPlayer shell", () => {
  it("uses the native Android TV bridge and reports native progress", async () => {
    const play = vi.fn();
    const stop = vi.fn();
    const onProgress = vi.fn();
    const onClose = vi.fn();
    window.YawfAndroidTV = { play, stop };
    render(
      <VideoPlayer
        url="https://server.example/api/stream/session/index.m3u8"
        externalPlaybackUrl="https://server.example/api/external-stream/capability"
        playbackAuthorization="Bearer short-lived"
        title="TV film"
        subtitle="Director's cut"
        startPositionSeconds={42}
        onProgress={onProgress}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(JSON.parse(play.mock.calls[0]![0])).toEqual({
      url: "https://server.example/api/external-stream/capability",
      title: "TV film",
      subtitle: "Director's cut",
      startPositionSeconds: 42,
      authorization: "Bearer short-lived",
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
    expect(video.playbackRate).toBe(1.25);
    expect(speed).toHaveValue("1.25");

    await userEvent.selectOptions(speed, "1.5");

    expect(video.playbackRate).toBe(1.5);
    expect(speed).toHaveValue("1.5");
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

  it("keeps direct-link recovery inside the player after a browser media error", () => {
    render(
      <VideoPlayer url="https://x/test.mp4" title="T" onClose={() => {}} />,
    );
    const video = document.querySelector("video.player-video") as HTMLVideoElement;

    fireEvent.error(video);

    expect(screen.getByText("Playback interrupted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in external player" })).toBeInTheDocument();
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

    fireEvent.error(video);

    await waitFor(() => expect(requestWebviewFallback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith("https://x/stream/index.m3u8");
    expect(screen.queryByText("Playback interrupted")).toBeNull();
  });

  it("offers the stream-scoped external handoff in the playback settings menu", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:player-list");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const restoreCreate = replaceProperty(URL, "createObjectURL", createObjectURL);
    const restoreRevoke = replaceProperty(URL, "revokeObjectURL", revokeObjectURL);
    try {
      render(
        <VideoPlayer
          url="https://server.example/api/stream/session-1"
          externalPlaybackUrl="https://server.example/api/external-stream/session-1/capability"
          title="Example Movie"
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Playback settings" }));
      await userEvent.click(screen.getByRole("button", { name: /Open in external player/ }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const playlist = createObjectURL.mock.calls[0][0] as Blob;
      await expect(playlist.text()).resolves.toContain(
        "https://server.example/api/external-stream/session-1/capability",
      );
      expect(click).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent("Player file downloaded");
    } finally {
      click.mockRestore();
      restoreCreate();
      restoreRevoke();
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
  it("attaches hls.js when the browser can't play HLS natively", async () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "",
    );
    render(<VideoPlayer url="https://x/stream.m3u8" title="T" onClose={() => {}} />);
    await waitFor(() => expect(hlsInstances).toHaveLength(1));
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith(
      "https://x/stream.m3u8",
    );
    expect(hlsInstances[0].attachMedia).toHaveBeenCalled();
    const xhr = { withCredentials: false } as XMLHttpRequest;
    hlsInstances[0].config.xhrSetup?.(xhr);
    expect(xhr.withCredentials).toBe(true);
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
    expect(screen.getByRole("button", { name: "Playback settings" })).toBeInTheDocument();
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

  it("uses native HLS (no hls.js) when canPlayType reports support", () => {
    (HTMLMediaElement.prototype.canPlayType as ReturnType<typeof vi.fn>) = vi.fn(
      () => "maybe",
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
      screen.getByText("This browser cannot play HLS. Try the desktop app."),
    ).toBeInTheDocument();
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
  it("shows the open-externally note and a direct link in the browser", () => {
    render(<VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />);
    expect(screen.getByText("Open externally")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open direct link" });
    expect(link).toHaveAttribute("href", "https://x/movie.mkv");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("does not invoke any native player when not under Tauri", () => {
    render(<VideoPlayer url="https://x/movie.mkv" title="T" onClose={() => {}} />);
    expect(playWithMpvMock).not.toHaveBeenCalled();
    expect(openInExternalPlayerMock).not.toHaveBeenCalled();
  });
});

describe("Built-in player (Tauri)", () => {
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
