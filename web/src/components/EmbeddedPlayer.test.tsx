// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderPlayerMock = vi.hoisted(() => ({
  callback: null as ((ev: { name: string; data: unknown }) => void) | null,
  init: vi.fn(),
  destroy: vi.fn(),
  command: vi.fn(),
  observeProperties: vi.fn(),
  setProperty: vi.fn(),
  getProperty: vi.fn(),
}));
const iconMock = vi.hoisted(() => vi.fn(({ name }: { name: string }) => <span data-icon={name} />));
const openInExternalPlayerMock = vi.hoisted(() => vi.fn(async () => "opened"));

const tauriWindowMock = vi.hoisted(() => ({
  setFullscreen: vi.fn(async (_fullscreen: boolean) => {}),
  isFullscreen: vi.fn(async () => false),
  onResized: vi.fn(async (_callback: () => void) => () => {}),
}));

vi.mock("../lib/renderPlayer", () => ({
  init: renderPlayerMock.init,
  destroy: renderPlayerMock.destroy,
  command: renderPlayerMock.command,
  setProperty: renderPlayerMock.setProperty,
  getProperty: renderPlayerMock.getProperty,
  observeProperties: renderPlayerMock.observeProperties,
  setVideoMarginRatio: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/window", () => {
  return { getCurrentWindow: () => tauriWindowMock };
});

vi.mock("../lib/tauri", () => ({
  openInExternalPlayer: openInExternalPlayerMock,
  isTauri: () => false,
}));

vi.mock("./Icon", () => ({
  Icon: iconMock,
}));

import { EmbeddedPlayer } from "./EmbeddedPlayer";

const initialViewport = {
  width: window.innerWidth,
  height: window.innerHeight,
  scale: window.devicePixelRatio,
};

function setViewport(width: number, height: number, scale = 1): void {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
    devicePixelRatio: { configurable: true, value: scale },
  });
}

function emitProperty(name: string, data: unknown): void {
  const callback = renderPlayerMock.callback;
  if (callback == null) throw new Error("mpv property listener is not ready");
  act(() => callback({ name, data }));
}

beforeEach(() => {
  renderPlayerMock.callback = null;
  renderPlayerMock.init.mockReset();
  renderPlayerMock.init.mockResolvedValue(undefined);
  renderPlayerMock.destroy.mockReset();
  renderPlayerMock.destroy.mockResolvedValue(undefined);
  renderPlayerMock.command.mockReset();
  renderPlayerMock.command.mockResolvedValue(undefined);
  renderPlayerMock.observeProperties.mockImplementation(
    async (
      _properties: unknown,
      callback: (ev: { name: string; data: unknown }) => void,
    ) => {
      renderPlayerMock.callback = callback;
      return () => {};
    },
  );
  renderPlayerMock.setProperty.mockResolvedValue(undefined);
  renderPlayerMock.getProperty.mockResolvedValue([]);
  tauriWindowMock.setFullscreen.mockResolvedValue(undefined);
  tauriWindowMock.isFullscreen.mockResolvedValue(false);
  tauriWindowMock.onResized.mockResolvedValue(() => {});
  iconMock.mockClear();
  openInExternalPlayerMock.mockClear();
  setViewport(1024, 768);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  setViewport(initialViewport.width, initialViewport.height, initialViewport.scale);
});

describe("EmbeddedPlayer listener cleanup", () => {
  it("unsubscribes an observation listener that resolves after unmount", async () => {
    let resolveObserve: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    renderPlayerMock.observeProperties.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveObserve = resolve;
      }),
    );
    const { unmount } = render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.observeProperties).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolveObserve?.(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes a late Tauri resize listener after unmount", async () => {
    let resolveResize: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    tauriWindowMock.onResized.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveResize = resolve;
      }),
    );
    const { unmount } = render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(tauriWindowMock.onResized).toHaveBeenCalled());
    unmount();
    await act(async () => {
      resolveResize?.(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("EmbeddedPlayer control geometry", () => {
  it("keeps transport controls in the true center column", () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Test movie"
        onClose={() => {}}
        onPlayNext={() => {}}
      />,
    );

    const center = screen
      .getByRole("button", { name: "Pause" })
      .closest(".embed-buttons-center");
    expect(center).not.toBeNull();
    expect(center).toContainElement(
      screen.getByRole("button", { name: "Back 10 seconds" }),
    );
    expect(center).toContainElement(
      screen.getByRole("button", { name: "Forward 10 seconds" }),
    );

    expect(
      screen.getByRole("slider", { name: "Volume" }).closest(".embed-buttons-left"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Fullscreen" }).closest(".embed-buttons-right"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Next episode" }).closest(".embed-buttons-right"),
    ).not.toBeNull();
  });

  it("uses equal flexible side columns so the center column stays at 50%", () => {
    const css = readFileSync("src/components/EmbeddedPlayer.css", "utf8");
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);",
    );
  });
});

describe("EmbeddedPlayer playback controls", () => {
  it("only shows the Next episode control when a next target exists", () => {
    const { rerender } = render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Next episode" })).toBeNull();

    rerender(
      <EmbeddedPlayer
        url="https://example.test/episode.mkv"
        title="Show"
        onClose={() => {}}
        onPlayNext={() => {}}
        nextLabel="S2 E6 - The Arrival"
      />,
    );
    expect(screen.getByRole("button", { name: "Next episode" })).toBeInTheDocument();
  });

  it("toggles mute and restores the remembered volume level", async () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("volume", 72);

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("mute", true);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("mute", false);
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("volume", 72);
  });

  it("keeps native mute state separate from the actual volume property events", async () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    const slider = screen.getByRole("slider", { name: "Volume" });

    emitProperty("volume", 64);
    emitProperty("mute", true);
    expect(slider).toHaveValue("64");
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();

    emitProperty("volume", 0);
    emitProperty("mute", false);
    expect(slider).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("volume", 64);
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("mute", false);
  });

  it("keeps the Audio control in place while native track discovery is pending", () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Audio" })).toBeInTheDocument();
  });

  it("refreshes tracks from the native track-list count event and matches a title when lang is und", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "audio", lang: "eng", title: "English 5.1", selected: true },
      { id: 2, type: "audio", lang: "und", title: "Deutsch 5.1" },
    ]);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        playerPreferences={{ defaultAudioLanguage: "deu" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 2);

    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("aid", "2"),
    );
  });

  it("leaves the stream-selected native audio unchanged when no global language matches", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "audio", lang: "eng", title: "English", selected: true },
    ]);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        playerPreferences={{ defaultAudioLanguage: "Japanese" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 1);

    await waitFor(() => expect(renderPlayerMock.getProperty).toHaveBeenCalled());
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("aid", "1");
  });

  it("prefers remembered audio only when remembering track choices is enabled", async () => {
    const tracks = [
      { id: 1, type: "audio", lang: "eng", title: "English", selected: true },
      { id: 2, type: "audio", lang: "deu", title: "German" },
    ];
    renderPlayerMock.getProperty.mockResolvedValue(tracks);
    const { rerender } = render(
      <EmbeddedPlayer
        url="https://example.test/remembered.mkv"
        title="Movie"
        savedPrefs={{ preferredAudioLang: "eng" }}
        playerPreferences={{ defaultAudioLanguage: "deu", rememberPerTitleTrackChoices: true }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 2);
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("aid", "1"),
    );

    renderPlayerMock.setProperty.mockClear();
    rerender(
      <EmbeddedPlayer
        url="https://example.test/default.mkv"
        title="Movie"
        savedPrefs={{ preferredAudioLang: "eng" }}
        playerPreferences={{ defaultAudioLanguage: "deu", rememberPerTitleTrackChoices: false }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 2);
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("aid", "2"),
    );
  });

  it("applies configured native volume and speed using Settings units", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "audio", lang: "eng", title: "English", selected: true },
    ]);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        playerPreferences={{ defaultVolume: 35, defaultPlaybackSpeed: 1.5 }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("volume", 35),
    );
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("mute", false);
    emitProperty("track-list/count", 1);
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("speed", 1.5),
    );
  });

  it("keeps a remembered subtitle over a global subtitle-off default", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "audio", lang: "eng", title: "English", selected: true },
      { id: 2, type: "sub", lang: "deu", title: "German subtitles" },
    ]);
    render(
      <EmbeddedPlayer
        url="https://example.test/subtitles.mkv"
        title="Movie"
        savedPrefs={{ preferredSubId: "2" }}
        playerPreferences={{ defaultSubtitleBehavior: "off", rememberPerTitleTrackChoices: true }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 2);
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("sid", "2"),
    );
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("sid", "no");
  });

  it("sets native default volume before unpausing", async () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/quiet.mkv"
        title="Movie"
        playerPreferences={{ defaultVolume: 0 }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("pause", false),
    );
    const calls = renderPlayerMock.setProperty.mock.calls;
    const volumeAt = calls.findIndex(([name, value]) => name === "volume" && value === 0);
    const muteAt = calls.findIndex(([name, value]) => name === "mute" && value === true);
    const unpauseAt = calls.findIndex(([name, value]) => name === "pause" && value === false);
    expect(volumeAt).toBeGreaterThanOrEqual(0);
    expect(muteAt).toBeGreaterThanOrEqual(0);
    expect(volumeAt).toBeLessThan(unpauseAt);
    expect(muteAt).toBeLessThan(unpauseAt);
  });

  it("does not let an empty stream-default language delay the configured speed", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([{ id: 9, type: "video", title: "Video" }]);
    render(
      <EmbeddedPlayer
        url="https://example.test/video-only.mkv"
        title="Movie"
        playerPreferences={{ defaultAudioLanguage: "", defaultPlaybackSpeed: 1.25 }}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("speed", 1.25),
    );
    emitProperty("track-list/count", 1);
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("aid", "9");
  });

  it("does not consume the restore when a video-only track list arrives first", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([{ id: 9, type: "video", title: "Video" }]);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        playerPreferences={{ defaultAudioLanguage: "German" }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("track-list/count", 1);
    await waitFor(() => expect(renderPlayerMock.getProperty).toHaveBeenCalled());
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("aid", "2");

    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "video", title: "Video" },
      { id: 2, type: "audio", lang: "deu", title: "German" },
    ]);
    emitProperty("track-list/count", 2);
    await waitFor(() =>
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("aid", "2"),
    );
  });

  it("draws the buffered range from the absolute demuxer cache timestamp", async () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("duration", 100);
    emitProperty("time-pos", 25);
    // demuxer-cache-time is the ABSOLUTE last buffered timestamp, not a
    // time-ahead delta: 40s cached of a 100s file must draw 40%, not 65%.
    emitProperty("demuxer-cache-time", 40);

    await waitFor(() => {
      const buffered = document.body.querySelector(".embed-scrub-buffered") as HTMLElement;
      expect(buffered.style.width).toBe("40%");
    });
  });

  it("toggles the right time readout between remaining and total duration", async () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("duration", 100);
    emitProperty("time-pos", 25);

    const readout = await screen.findByRole("button", { name: "Show total duration" });
    await waitFor(() => expect(readout).toHaveTextContent("-1:15"));
    fireEvent.click(readout);
    expect(screen.getByRole("button", { name: "Show remaining time" })).toHaveTextContent(
      "1:40",
    );
  });

  it("maps seek-offset native progress back to the original timeline", async () => {
    const onProgress = vi.fn();
    render(
      <EmbeddedPlayer
        url="https://example.test/stream/index.m3u8"
        title="Movie"
        timelineOffsetSeconds={700}
        onProgress={onProgress}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    await waitFor(() =>
      expect(renderPlayerMock.command).toHaveBeenCalledWith("loadfile", [
        "https://example.test/stream/index.m3u8",
      ]),
    );
    emitProperty("duration", 100);
    emitProperty("time-pos", 12);

    await waitFor(() =>
      expect(onProgress).toHaveBeenCalledWith(
        712,
        800,
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
        "aria-valuenow",
        "712",
      ),
    );
    expect(document.querySelector(".embed-time")).toHaveTextContent("11:52");
  });

  it("coalesces rapid native clock/cache events into scrubber-only updates", async () => {
    vi.useFakeTimers();
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    emitProperty("duration", 100);
    // First position also drops the initial spinner. Settle that one parent
    // render, then assert the rapid steady-state events do not recreate icons.
    emitProperty("time-pos", 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    iconMock.mockClear();

    for (let pos = 2; pos <= 20; pos += 1) {
      emitProperty("time-pos", pos);
      emitProperty("demuxer-cache-time", pos + 20);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
      "aria-valuenow",
      "1",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute(
      "aria-valuenow",
      "20",
    );
    expect(document.body.querySelector<HTMLElement>(".embed-scrub-buffered")?.style.width).toBe("40%");
    expect(iconMock).not.toHaveBeenCalled();
  });

  it("pauses on a single stage click but fullscreen toggles on double click without pausing", async () => {
    vi.useFakeTimers();
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    renderPlayerMock.setProperty.mockClear();
    const stage = document.querySelector<HTMLElement>(".embed-stage");
    if (stage == null) throw new Error("stage missing");

    fireEvent.click(stage);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("pause", true);

    renderPlayerMock.setProperty.mockClear();
    fireEvent.click(stage);
    fireEvent.doubleClick(stage);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(tauriWindowMock.setFullscreen).toHaveBeenCalledWith(true);
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("pause", true);
  });

  it("opens the merged details panel to Shortcuts and Escape closes it before closing the player", () => {
    const onClose = vi.fn();
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: "?" });
    const panel = screen.getByRole("dialog", { name: "Player details and shortcuts" });
    expect(panel).toHaveTextContent("Info");
    expect(panel).toHaveTextContent("Shortcuts");
    expect(screen.getByRole("tabpanel", { name: "Shortcuts" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Player details and shortcuts" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses distinct conventional icons for audio and subtitle controls", async () => {
    renderPlayerMock.getProperty.mockResolvedValue([
      { id: 1, type: "audio", title: "English" },
      { id: 2, type: "sub", title: "English CC" },
    ]);
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Audio" })).toBeInTheDocument());

    const audioButton = screen.getByRole("button", { name: "Audio" });
    const subtitleButton = screen.getByRole("button", { name: "Subtitles" });
    expect(audioButton.querySelector('[data-icon="audio"]')).not.toBeNull();
    expect(subtitleButton.querySelector('[data-icon="captions"]')).not.toBeNull();
  });

  it("uses the Tauri window API from the fullscreen button in both directions", async () => {
    let fullscreenState = false;
    tauriWindowMock.isFullscreen.mockImplementation(async () => fullscreenState);
    tauriWindowMock.setFullscreen.mockImplementation(async (next) => {
      fullscreenState = next;
    });
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    await waitFor(() => expect(tauriWindowMock.setFullscreen).toHaveBeenCalledWith(true));
    await screen.findByRole("button", { name: "Exit fullscreen" });

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() => expect(tauriWindowMock.setFullscreen).toHaveBeenCalledWith(false));
  });

  it("keeps the libmpv lifecycle alive through a native fullscreen round trip", async () => {
    let fullscreenState = false;
    let onResized: (() => void) | undefined;
    tauriWindowMock.isFullscreen.mockImplementation(async () => fullscreenState);
    tauriWindowMock.setFullscreen.mockImplementation(async (next) => {
      fullscreenState = next;
    });
    tauriWindowMock.onResized.mockImplementation(async (callback) => {
      onResized = callback;
      return () => {};
    });
    const onClose = vi.fn();
    const { rerender } = render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={onClose} />,
    );

    await waitFor(() => {
      expect(renderPlayerMock.init).toHaveBeenCalledTimes(1);
      expect(renderPlayerMock.command).toHaveBeenCalledWith("loadfile", [
        "https://example.test/movie.mkv",
      ]);
      expect(tauriWindowMock.onResized).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    await screen.findByRole("button", { name: "Exit fullscreen" });
    fullscreenState = true;
    await act(async () => {
      onResized?.();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() => expect(tauriWindowMock.setFullscreen).toHaveBeenLastCalledWith(false));
    fullscreenState = false;
    await act(async () => {
      onResized?.();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Fullscreen" });

    rerender(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={onClose} />,
    );
    expect(renderPlayerMock.init).toHaveBeenCalledTimes(1);
    expect(renderPlayerMock.destroy).not.toHaveBeenCalled();
  });

  it("shows the paused now-playing screen and resumes immediately", async () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Example Show"
        nowPlaying={{
          year: 2026,
          runtimeMinutes: 48,
          rating: 8.4,
          episodeLabel: "S2 E5 - The Arrival",
          overview: "The crew make a difficult discovery.",
          backdropUrl: "https://image.test/backdrop.jpg",
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("pause", true);

    expect(screen.getByLabelText(/^Paused:/)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.classList.contains("player-pause-meta") === true &&
          element.textContent === "S2 E5 - The Arrival202648m★ 8.4",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("The crew make a difficult discovery.")).toBeInTheDocument();

    // The whole pause screen is the resume affordance (no separate button).
    fireEvent.click(screen.getByLabelText(/^Paused:/));
    expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("pause", false);
    expect(screen.queryByLabelText(/^Paused:/)).toBeNull();
  });

  it("keeps native chrome interactive above the pause overlay", async () => {
    const onClose = vi.fn();
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("pause", true);
    renderPlayerMock.setProperty.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(renderPlayerMock.setProperty).not.toHaveBeenCalledWith("pause", false);

    const css = readFileSync("src/components/EmbeddedPlayer.css", "utf8");
    expect(css).toMatch(/\.embed-controls\s*\{[^}]*z-index:\s*7;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(
      /\.embed-player\.show-controls \.embed-top,[\s\S]*?\.embed-player\.show-controls \.embed-bottom,[\s\S]*?pointer-events:\s*auto;/,
    );
  });

  it("falls back to a title-only pause screen when Detail metadata is absent", async () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Just the title"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("pause", true);

    expect(screen.getByLabelText(/^Paused:/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Just the title" })).toBeInTheDocument();
    expect(document.querySelector(".player-pause-meta")).toBeNull();
  });

  it("keeps Escape layering: close a menu first, then close the player", () => {
    const onClose = vi.fn();
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on one Escape after the auto-hide timer hides clean player chrome", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={onClose} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    emitProperty("duration", 120);
    emitProperty("time-pos", 8);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    expect(document.querySelector(".embed-player")).not.toHaveClass("show-controls");

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EmbeddedPlayer popover material", () => {
  it("player popovers must not sample live video through a backdrop blur", () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    const menu = screen.getByRole("menu");
    expect(menu.classList).not.toContain("glass-raised");
    expect((menu as HTMLElement).style.backdropFilter).toBe("");
    expect((menu as HTMLElement).style.getPropertyValue("-webkit-backdrop-filter")).toBe("");

    const css = readFileSync("src/components/EmbeddedPlayer.css", "utf8");
    expect(css).not.toMatch(/\.embed-menu\s*\{[^}]*backdrop-filter/);
    expect(css).toMatch(/\.embed-menu\s*\{[^}]*background:\s*rgba\(12, 14, 22, 1\);/s);
  });

  it("player details must not sample live video through a backdrop blur", () => {
    render(
      <EmbeddedPlayer url="https://example.test/movie.mkv" title="Movie" onClose={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Player details and shortcuts" }));
    const panel = screen.getByRole("dialog", { name: "Player details and shortcuts" });
    expect(panel.classList).not.toContain("glass-raised");
    expect((panel as HTMLElement).style.backdropFilter).toBe("");
    expect((panel as HTMLElement).style.getPropertyValue("-webkit-backdrop-filter")).toBe("");

    const css = readFileSync("src/components/player/PlayerInfoPopover.css", "utf8");
    expect(css).not.toMatch(/\.player-info-popover\s*\{[^}]*backdrop-filter/);
    expect(css).toMatch(
      /\.player-info-popover\s*\{[^}]*background:\s*rgba\(12, 14, 22, 1\);/s,
    );
  });
});

describe("window-anchored controls and playback diagnostics", () => {
  it("escapes an inset Detail block and stays window-anchored after dimensions arrive", async () => {
    // This is the shipped sequence: Detail starts 244 CSS px from the left at
    // desktop width and has scrolled to its movie stream picker. Its backdrop
    // filter makes it a containing block for fixed descendants. Source-dimension
    // events must never turn into inline control geometry.
    setViewport(1440, 900, 2);
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.style.cssText =
      "position: fixed; inset: 0 0 0 244px; overflow-y: auto; backdrop-filter: blur(28px);";
    detail.scrollTop = 700;
    document.body.appendChild(detail);

    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Test movie"
        onClose={() => {}}
      />,
      { container: detail },
    );

    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    const player = screen
      .getByRole("button", { name: "Pause" })
      .closest<HTMLElement>(".embed-player");
    const controls = player?.querySelector<HTMLElement>(".embed-controls");

    // The full-window overlay must not inherit Detail's 244 px x-offset or its
    // 700 px scroll displacement.
    expect(player?.parentElement).toBe(document.body);
    expect(detail).not.toContainElement(player);
    expect(controls).not.toHaveAttribute("style");

    emitProperty("dwidth", 3840);
    expect(controls).not.toHaveAttribute("style");

    emitProperty("dheight", 2160);
    expect(controls).not.toHaveAttribute("style");

    const css = readFileSync("src/components/EmbeddedPlayer.css", "utf8");
    expect(css).toMatch(/\.embed-controls\s*\{[^}]*inset:\s*0;/s);
  });

  it("keeps the full-window contract before the first frame and for audio-only media", async () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/audio.mka"
        title="Audio"
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    const controls = document.querySelector<HTMLElement>(".embed-controls");
    expect(controls).not.toHaveAttribute("style");

    emitProperty("dwidth", null);
    emitProperty("dheight", null);
    expect(controls).not.toHaveAttribute("style");
  });

  it("shows the native engine plus source and backing-display dimensions", async () => {
    setViewport(1000, 700, 2);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Test movie"
        sourceFileName="Test.Movie.2160p.WEB-DL.H265.mkv"
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());
    emitProperty("video-params/w", 3840);
    emitProperty("video-params/h", 2160);

    fireEvent.click(screen.getByRole("button", { name: "Player details and shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Player details and shortcuts" });
    expect(dialog).toHaveTextContent("Native mpv");
    expect(dialog).toHaveTextContent("3840 × 2160 px");
    expect(dialog).toHaveTextContent("2000 × 1400 px");
    expect(dialog).toHaveTextContent("Test.Movie.2160p.WEB-DL.H265.mkv");
  });
});

describe("EmbeddedPlayer decode-failure fallback", () => {
  // The window mpv's watchdog uses (mirrors FIRST_FRAME_WATCHDOG_MS).
  const WATCHDOG_MS = 25_000;

  it("puts resume options after the mpv 0.38 playlist-index slot", async () => {
    render(
      <EmbeddedPlayer
        url="https://example.test/resumed.mkv"
        title="Resumed"
        startPositionSeconds={125.9}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(renderPlayerMock.command).toHaveBeenCalledWith("loadfile", [
        "https://example.test/resumed.mkv",
        "replace",
        "-1",
        "start=+125",
      ]),
    );
  });

  it("passes the stream-scoped bearer separately from the playback URL", async () => {
    const authorization = `Bearer ${"A".repeat(43)}`;
    render(
      <EmbeddedPlayer
        url="https://stream.example/api/stream/stream_123"
        title="Server stream"
        playbackAuthorization={authorization}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(renderPlayerMock.command).toHaveBeenCalledWith(
        "loadfile",
        ["https://stream.example/api/stream/stream_123"],
        authorization,
      ),
    );
    expect("https://stream.example/api/stream/stream_123").not.toContain(authorization);
  });

  it("passes stream authorization to the external-player error fallback", async () => {
    renderPlayerMock.command.mockRejectedValue(new Error("load failed"));
    const authorization = `Bearer ${"A".repeat(43)}`;
    render(
      <EmbeddedPlayer
        url="https://stream.example/api/stream/stream_0123456789abcdef0123456789abcdef"
        title="Server stream"
        playbackAuthorization={authorization}
        onClose={() => {}}
      />,
    );

    const button = await screen.findByRole(
      "button",
      { name: "Open in external player" },
      { timeout: 4000 },
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(openInExternalPlayerMock).toHaveBeenCalledWith(
        "https://stream.example/api/stream/stream_0123456789abcdef0123456789abcdef",
        undefined,
        authorization,
      ),
    );
  });

  it("routes a persistent loadfile rejection through native fallback", async () => {
    // Both the first attempt AND the one silent retry fail.
    renderPlayerMock.command.mockRejectedValue(
      new Error("mpv command failed: Raw(-4)"),
    );
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/rejected.mkv"
        title="Rejected"
        startPositionSeconds={125}
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );

    await waitFor(
      () =>
        expect(onPlaybackError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "mpv command failed: Raw(-4)" }),
        ),
      { timeout: 4000 },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers from a transient loadfile rejection with one silent retry", async () => {
    renderPlayerMock.command.mockRejectedValueOnce(
      new Error("mpv command failed: Raw(-1)"),
    );
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/hiccup.mkv"
        title="Hiccup"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );

    // The retry (after an ~800ms wait) issues loadfile a second time and
    // playback proceeds without ever surfacing an error.
    await waitFor(
      () => {
        const loadfileCalls = renderPlayerMock.command.mock.calls.filter(
          (c) => c[0] === "loadfile",
        );
        expect(loadfileCalls.length).toBe(2);
      },
      { timeout: 4000 },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(onPlaybackError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hands off to the webview when mpv reports an end-file decode error", async () => {
    // The gap this closes: loadfile SUCCEEDS (so the init try/catch sees nothing)
    // but the file then fails to decode, surfacing asynchronously as an end-file
    // ERROR event. The Rust core forwards only reason=ERROR, so any end-file with
    // error:true must trigger the parent's webview fallback.
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/corrupt.mkv"
        title="Corrupt"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: true, code: -12 });
    expect(onPlaybackError).toHaveBeenCalledTimes(1);
  });

  it("ignores an end-file that is not a genuine error (normal EOF)", async () => {
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: false });
    expect(onPlaybackError).not.toHaveBeenCalled();
  });

  it("requests the webview fallback only once when errors repeat", async () => {
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/corrupt.mkv"
        title="Corrupt"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: true, code: -12 });
    emitProperty("end-file", { error: true, code: -12 });
    expect(onPlaybackError).toHaveBeenCalledTimes(1);
  });

  it("hands off to the webview when no first frame arrives within the watchdog window", async () => {
    vi.useFakeTimers();
    try {
      const onPlaybackError = vi.fn(async () => true);
      render(
        <EmbeddedPlayer
          url="https://example.test/stalled.mkv"
          title="Stalled"
          onPlaybackError={onPlaybackError}
          onClose={() => {}}
        />,
      );
      // The mocked init chain is microtask-only, so a single async tick arms the
      // watchdog. No time-pos is ever emitted (mpv accepted the file but never
      // decodes a frame).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(1);
      });
      // The init chain is fully done once the unpause lands (the watchdog arms
      // right after it); asserting on the callback alone raced the 25s window.
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("pause", false);
      expect(onPlaybackError).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
      });
      expect(onPlaybackError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands the watchdog down once the first frame is shown", async () => {
    vi.useFakeTimers();
    try {
      const onPlaybackError = vi.fn(async () => true);
      render(
        <EmbeddedPlayer
          url="https://example.test/movie.mkv"
          title="Movie"
          onPlaybackError={onPlaybackError}
          onClose={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // A first time-pos ≈ first frame, well before the window closes.
      emitProperty("time-pos", 0.5);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
      });
      expect(onPlaybackError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EmbeddedPlayer decode-failure fallback", () => {
  // The window mpv's watchdog uses (mirrors FIRST_FRAME_WATCHDOG_MS).
  const WATCHDOG_MS = 25_000;

  it("hands off to the webview when mpv reports an end-file decode error", async () => {
    // The gap this closes: loadfile SUCCEEDS (so the init try/catch sees nothing)
    // but the file then fails to decode, surfacing asynchronously as an end-file
    // ERROR event. The Rust core forwards only reason=ERROR, so any end-file with
    // error:true must trigger the parent's webview fallback.
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/corrupt.mkv"
        title="Corrupt"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: true, code: -12 });
    expect(onPlaybackError).toHaveBeenCalledTimes(1);
  });

  it("ignores an end-file that is not a genuine error (normal EOF)", async () => {
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/movie.mkv"
        title="Movie"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: false });
    expect(onPlaybackError).not.toHaveBeenCalled();
  });

  it("requests the webview fallback only once when errors repeat", async () => {
    const onPlaybackError = vi.fn(async () => true);
    render(
      <EmbeddedPlayer
        url="https://example.test/corrupt.mkv"
        title="Corrupt"
        onPlaybackError={onPlaybackError}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(renderPlayerMock.callback).not.toBeNull());

    emitProperty("end-file", { error: true, code: -12 });
    emitProperty("end-file", { error: true, code: -12 });
    expect(onPlaybackError).toHaveBeenCalledTimes(1);
  });

  it("hands off to the webview when no first frame arrives within the watchdog window", async () => {
    vi.useFakeTimers();
    try {
      const onPlaybackError = vi.fn(async () => true);
      render(
        <EmbeddedPlayer
          url="https://example.test/stalled.mkv"
          title="Stalled"
          onPlaybackError={onPlaybackError}
          onClose={() => {}}
        />,
      );
      // The mocked init chain is microtask-only, so a single async tick arms the
      // watchdog. No time-pos is ever emitted (mpv accepted the file but never
      // decodes a frame).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(1);
      });
      // The init chain is fully done once the unpause lands (the watchdog arms
      // right after it); asserting on the callback alone raced the 25s window.
      expect(renderPlayerMock.setProperty).toHaveBeenCalledWith("pause", false);
      expect(onPlaybackError).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
      });
      expect(onPlaybackError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands the watchdog down once the first frame is shown", async () => {
    vi.useFakeTimers();
    try {
      const onPlaybackError = vi.fn(async () => true);
      render(
        <EmbeddedPlayer
          url="https://example.test/movie.mkv"
          title="Movie"
          onPlaybackError={onPlaybackError}
          onClose={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // A first time-pos ≈ first frame, well before the window closes.
      emitProperty("time-pos", 0.5);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
      });
      expect(onPlaybackError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EmbeddedPlayer predictive up next", () => {
  async function renderPredictive(props: Partial<React.ComponentProps<typeof EmbeddedPlayer>> = {}) {
    vi.useFakeTimers();
    const onPlayNext = vi.fn();
    renderPlayerMock.getProperty.mockImplementation(async (name: string) =>
      name === "chapter-list" ? [{ title: "End Credits", time: 700 }] : [],
    );
    render(
      <EmbeddedPlayer
        url="https://example.test/episode.mkv"
        title="Episode"
        nextLabel="S1 E2"
        onPlayNext={onPlayNext}
        onClose={() => {}}
        {...props}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    emitProperty("duration", 800);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    return onPlayNext;
  }

  it("arms only at a trusted late credits marker and does not play immediately", async () => {
    const onPlayNext = await renderPredictive();
    emitProperty("time-pos", 650);
    expect(screen.queryByText("Up next")).toBeNull();
    emitProperty("time-pos", 700);
    expect(screen.getByText("Up next")).toBeTruthy();
    expect(onPlayNext).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(onPlayNext).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onPlayNext).toHaveBeenCalledTimes(1);
  });

  it("keeps generic prediction manual until EOF and honors disabled and dismissed auto advance", async () => {
    const onPlayNext = await renderPredictive({ autoCountdown: false });
    renderPlayerMock.getProperty.mockImplementation(async () => []);
    emitProperty("time-pos", 795);
    expect(screen.getByText("Up next")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(onPlayNext).not.toHaveBeenCalled();
    emitProperty("eof-reached", true);
    expect(screen.getByText("Up next")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("pauses countdown and resets a dismissed prompt after a backward seek", async () => {
    const onPlayNext = await renderPredictive();
    emitProperty("time-pos", 700);
    emitProperty("pause", true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(onPlayNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    emitProperty("time-pos", 600);
    expect(screen.queryByText("Up next")).toBeNull();
    emitProperty("pause", false);
    emitProperty("time-pos", 700);
    expect(screen.getByText("Up next")).toBeTruthy();
  });
});
