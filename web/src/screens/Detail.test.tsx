// @vitest-environment jsdom
//
// Render/interaction tests for the Detail screen. The screen wires many child
// surfaces and services together, so everything external is mocked: the data
// hooks (useDetail/useStreams), the app store slice it reads, serverMode +
// ServerSessionContext, the storage taste-event store, the TasteProfile rebuild,
// and serverApi. Child components are replaced with doubles that expose their
// props as DOM so the parent wiring (play / watchlist / back / taste / related)
// can be asserted without their internals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview, MediaItem } from "../models/media";
import type { DetailState } from "../data/detail";
import type { StreamsState } from "../data/streams";
import { TorrentResult } from "../services/indexers/models";

// --- mutable mock state -----------------------------------------------------

let mockDetailItem: MediaPreview | null = null;
let mockDetail: DetailState;
let mockStreams: StreamsState;
let mockWatchlist: MediaPreview[] = [];
let inWatchlistResult = false;
let mockCached: { stream: any } | null = null;
let mockContinueWatching: any[] = [];
let serverModeOn = false;
let transcodeAvailable = false;
let pickerSelection = { season: 1, episode: 3 };
const tauriState = vi.hoisted(() => ({ on: false, desktop: false }));
const downloadsFfmpegAvailable = vi.hoisted(() => vi.fn(async () => true));
const downloadsRuntime = vi.hoisted(() => ({
  enqueue: vi.fn(async () => {}),
  enqueueSeason: vi.fn(async () => {}),
}));

const closeDetail = vi.fn();
const openDetail = vi.fn();
const navigate = vi.fn();
const toggleWatchlist = vi.fn();
const recordResume = vi.fn();
const refreshContinueWatching = vi.fn(async () => {});
const openDetailPlayer = vi.fn();
const closeDetailPlayer = vi.fn();
const openTrailer = vi.fn();
const closeTrailer = vi.fn();

let mockServices: any = {
  tmdb: null,
  indexers: null,
  debrid: null,
  ai: null,
  subtitles: null,
  translator: null,
};
let mockSettings: any = { transcode: false };

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    detailItem: mockDetailItem,
    closeDetail,
    openDetail,
    navigate,
    services: mockServices,
    settings: mockSettings,
    watchlist: mockWatchlist,
    toggleWatchlist,
    recordResume,
    continueWatching: mockContinueWatching,
    refreshContinueWatching,
    detailPlayerOpen: true,
    openDetailPlayer,
    closeDetailPlayer,
    trailerOpen: false,
    openTrailer,
    closeTrailer,
  }),
  useCachedResolutions: () =>
    mockCached ? { [mockDetailItem?.id ?? "x"]: mockCached } : {},
}));

vi.mock("../data/detail", () => ({
  useDetail: () => mockDetail,
}));

vi.mock("../data/streams", () => ({
  useStreams: () => mockStreams,
  filterStreamRows: (rows: unknown[]) => rows,
}));

vi.mock("../data/library", () => ({
  isInWatchlist: () => inWatchlistResult,
}));

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => serverModeOn,
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  isTauri: () => tauriState.on,
  isDesktopTauri: () => tauriState.desktop,
}));

vi.mock("../lib/ServerSessionContext", () => ({
  useTranscodeAvailable: () => transcodeAvailable,
  useDirectTorrentAvailable: () => false,
  useTranscodeCapabilities: () => ({
    adaptive: transcodeAvailable,
    seekOffset: transcodeAvailable,
    subtitleSidecar: transcodeAvailable,
    hardwareEncoder: "libx264",
    availableVideoEncoders: transcodeAvailable ? ["libx264"] : [],
    toneMapping: false,
  }),
}));

vi.mock("../lib/downloadsBridge", () => ({
  getDownloadsBridge: () => ({ downloadsFfmpegAvailable }),
}));
vi.mock("../services/downloads", () => ({
  startDownloadsRuntime: () => downloadsRuntime,
}));

const createRequest = vi.fn<(...a: any[]) => any>();
const resolveServerStream = vi.fn<(...a: any[]) => any>();
const fetchServerEpisodes = vi.fn<(...a: any[]) => any>();
vi.mock("../lib/serverApi", () => ({
  asServerTranscodeStream: (stream: any) => ({
    ...stream,
    streamURL: `${stream.streamURL.replace(/\/+$/, "")}/index.m3u8`,
  }),
  serverOptimizedSource: (stream: any) => ({
    url: `${stream.streamURL.replace(/\/+$/, "")}/index.m3u8`,
    timelineOffsetSeconds: 0,
    startPositionSeconds: 0,
    quality: "auto",
  }),
  serverExternalPlaybackURL: (stream: any) => `${stream.streamURL}/external-test`,
  createRequest: (...a: unknown[]) => createRequest(...a),
  fetchServerEpisodes: (...a: unknown[]) => fetchServerEpisodes(...a),
  resolveServerStream: (...a: unknown[]) => resolveServerStream(...a),
}));

// Taste store + profile rebuild.
const recentTasteEvents = vi.fn<(...a: any[]) => Promise<any[]>>(async () => []);
const addTasteEvent = vi.fn<(...a: any[]) => Promise<void>>(async () => {});
const rebuildTasteContext = vi.fn<(...a: any[]) => Promise<string>>(
  async () => "ctx",
);
const listHistory = vi.fn<(...a: any[]) => Promise<any[]>>(async () => []);
const listHistoryForMedia = vi.fn<(...a: any[]) => Promise<any[]>>(async () => []);
const getResume = vi.fn<(...a: any[]) => Promise<any>>(async () => null);
const storeRecordHistory = vi.fn<(...a: any[]) => Promise<any>>(async () => ({}));
const deleteHistory = vi.fn<(...a: any[]) => Promise<void>>(async () => {});
let movieHistory: any = null;
vi.mock("../storage", () => ({
  getStore: () => ({
    recentTasteEvents,
    addTasteEvent,
    listHistory,
    listHistoryForMedia,
    getResume,
    recordHistory: storeRecordHistory,
    deleteHistory,
  }),
}));
vi.mock("../services/ai/TasteProfile", () => ({
  rebuildTasteContext: (...a: unknown[]) => rebuildTasteContext(...a),
}));

// --- child doubles ----------------------------------------------------------

vi.mock("../components/DetailHero", () => ({
  DetailHero: ({
    item,
    inWatchlist,
    onClose,
    onToggleWatchlist,
    onRequest,
    requestState,
    tasteSignal,
    onTasteSignal,
    onPlay,
    onDownload,
    downloadDisabledReason,
    externalRatings,
    completionLabel,
    movieWatched,
    onToggleMovieWatched,
  }: any) => (
    <div data-testid="hero">
      <span data-testid="hero-title">{item?.title}</span>
      <span data-testid="hero-inwl">{String(inWatchlist)}</span>
      <span data-testid="hero-reqstate">{requestState}</span>
      <span data-testid="hero-taste">{tasteSignal ?? "none"}</span>
      <span data-testid="hero-completion">{completionLabel ?? "none"}</span>
      {externalRatings}
      <button onClick={onPlay}>play</button>
      {onToggleMovieWatched && (
        <button onClick={onToggleMovieWatched} aria-pressed={movieWatched}>
          {movieWatched ? "Mark unwatched" : "Mark watched"}
        </button>
      )}
      {onDownload && (
        <button onClick={onDownload} disabled={downloadDisabledReason != null}>
          download
        </button>
      )}
      <button onClick={onClose}>close</button>
      <button onClick={onToggleWatchlist}>toggle-wl</button>
      <button onClick={() => onTasteSignal?.("liked")}>like</button>
      <button onClick={() => onTasteSignal?.("disliked")}>dislike</button>
      {onRequest && <button onClick={onRequest}>request</button>}
    </div>
  ),
}));

vi.mock("../components/DetailAnalysis", () => ({
  DetailAnalysis: () => <div data-testid="analysis" />,
}));

vi.mock("../components/OmdbRatings", () => ({
  OmdbRatings: ({ imdbId }: any) => (
    <div data-testid="omdb" data-imdb={imdbId ?? ""} />
  ),
}));

vi.mock("../components/StreamPicker", () => ({
  StreamPicker: ({ onOpenSettings, onPlay, resolveStream }: any) => (
    <div data-testid="streampicker">
      <button onClick={onOpenSettings}>open-settings</button>
      <button
        data-testid="play-stream"
        onClick={() =>
          onPlay(
            { streamURL: "https://cdn.example/x.mp4", fileName: "x.mp4", codec: "H.264" },
            { title: "Src" },
          )
        }
      >
        play-stream
      </button>
      <button
        data-testid="resolve-and-play-stream"
        onClick={() => {
          const source = {
            infoHash: "HASH",
            title: "show.mkv",
            codec: "H.265",
          };
          void resolveStream({ result: source, cachedOn: "real_debrid" }).then(
            (stream: any) => onPlay(stream, source),
          );
        }}
      >
        resolve-and-play-stream
      </button>
    </div>
  ),
}));

vi.mock("../components/EpisodePicker", () => ({
  EpisodePicker: ({ onSelect, onToggleWatched }: any) => (
    <>
      <button
        data-testid="pick-episode"
        onClick={() => onSelect(pickerSelection)}
      >
        pick-ep
      </button>
      <button
        data-testid="mark-episode-watched"
        onClick={() => onToggleWatched?.({ season: 1, episode: 2 }, true)}
      >
        mark-episode-watched
      </button>
      <button
        data-testid="mark-episode-unwatched"
        onClick={() => onToggleWatched?.({ season: 1, episode: 2 }, false)}
      >
        mark-episode-unwatched
      </button>
    </>
  ),
}));

vi.mock("../components/CastRail", () => ({
  CastRail: ({ cast }: any) => (
    <div data-testid="castrail" data-count={cast.length} />
  ),
}));

vi.mock("../components/Rail", () => ({
  Rail: ({ title, items, onSelect }: any) => (
    <div data-testid="related" data-title={title}>
      {items.map((it: MediaPreview) => (
        <button key={it.id} onClick={() => onSelect?.(it)}>
          related-{it.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../components/Spinner", () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

vi.mock("../components/VideoPlayer", () => ({
  VideoPlayer: ({
    url,
    title,
    subtitle,
    nowPlaying,
    sourceFileName,
    playbackAuthorization,
    engine,
    requestWebviewFallback,
    upNext,
    autoCountdown,
    playerPreferences,
    onClose,
    onProgress,
    onEnded,
  }: any) => (
    <div
      data-testid="player"
      data-url={url}
      data-title={title}
      data-subtitle={subtitle ?? ""}
      data-source-file={sourceFileName ?? ""}
      data-has-playback-authorization={String(playbackAuthorization != null)}
      data-engine={engine}
      data-pause-year={nowPlaying?.year ?? ""}
      data-pause-runtime={nowPlaying?.runtimeMinutes ?? ""}
      data-pause-rating={nowPlaying?.rating ?? ""}
      data-pause-overview={nowPlaying?.overview ?? ""}
      data-pause-episode={nowPlaying?.episodeLabel ?? ""}
      data-pause-backdrop={nowPlaying?.backdropUrl ?? ""}
      data-has-fallback={String(requestWebviewFallback != null)}
      data-up-next={upNext?.label ?? ""}
      data-auto-countdown={String(autoCountdown)}
      data-default-audio-language={playerPreferences?.defaultAudioLanguage ?? ""}
      data-default-subtitle-language={playerPreferences?.defaultSubtitleLanguage ?? ""}
      data-default-subtitle-behavior={playerPreferences?.defaultSubtitleBehavior ?? ""}
      data-default-playback-speed={playerPreferences?.defaultPlaybackSpeed ?? ""}
      data-default-volume={playerPreferences?.defaultVolume ?? ""}
      data-remember-per-title-track-choices={String(
        playerPreferences?.rememberPerTitleTrackChoices ?? "",
      )}
    >
      <button type="button" onClick={() => onProgress?.(80, 100)}>
        report-progress
      </button>
      <button type="button" onClick={() => onEnded?.(100, 100)}>
        report-ended
      </button>
      <button type="button" onClick={onClose}>
        close-player
      </button>
    </div>
  ),
}));

import { Detail } from "./Detail";

// --- fixtures ---------------------------------------------------------------

function preview(id: string, over: Partial<MediaPreview> = {}): MediaPreview {
  return { id, type: "movie", title: `Title ${id}`, ...over };
}

function mediaItem(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "tt100",
    type: "movie",
    title: "The Movie",
    year: 2020,
    posterPath: null,
    backdropPath: null,
    overview: "An overview.",
    genres: ["Drama", "Mystery"],
    imdbRating: 7.5,
    rtRating: null,
    runtime: 120,
    status: null,
    tmdbId: 100,
    lastFetched: new Date().toISOString(),
    ...over,
  };
}

function detailState(over: Partial<DetailState["data"]> = {}): DetailState {
  return {
    data: {
      item: mediaItem(),
      cast: [],
      related: [],
      imdbId: "tt100",
      ...over,
    },
    loading: false,
    error: null,
    source: "live",
  };
}

function streamsState(): StreamsState {
  return {
    rows: [],
    loading: false,
    error: null,
    hasIndexers: true,
    hasDebrid: true,
    missingImdbId: false,
    sourceErrors: [],
  };
}

function downloadRow(title: string, sizeBytes: number) {
  return {
    result: TorrentResult.fromSearch({
      infoHash: title,
      title,
      sizeBytes,
      seeders: 10,
      leechers: 0,
      indexerName: "Test source",
    }),
    cachedOn: null,
  };
}

beforeEach(() => {
  mockDetailItem = preview("m1", { type: "movie", title: "Selected" });
  mockDetail = detailState();
  mockStreams = streamsState();
  mockWatchlist = [];
  inWatchlistResult = false;
  mockCached = null;
  mockContinueWatching = [];
  serverModeOn = false;
  transcodeAvailable = false;
  tauriState.on = false;
  tauriState.desktop = false;
  pickerSelection = { season: 1, episode: 3 };
  mockServices = {
    tmdb: null,
    indexers: null,
    debrid: null,
    ai: null,
    subtitles: null,
    translator: null,
  };
  mockSettings = { transcode: false, ratingScale: "thumbs" };
  vi.clearAllMocks();
  movieHistory = null;
  recentTasteEvents.mockResolvedValue([]);
  listHistory.mockResolvedValue([]);
  listHistoryForMedia.mockResolvedValue([]);
  getResume.mockImplementation(async (_mediaId, episodeId) =>
    episodeId == null ? movieHistory : null,
  );
  storeRecordHistory.mockImplementation(async (entry) => {
    if (entry.episodeId == null) movieHistory = { ...entry };
    return entry;
  });
  deleteHistory.mockImplementation(async (mediaId, episodeId) => {
    if (mediaId === "m1" && episodeId == null) movieHistory = null;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Detail null guard", () => {
  it("renders nothing when there is no selected item", () => {
    mockDetailItem = null;
    const { container } = render(<Detail />);
    expect(container.firstChild).toBeNull();
  });
});

describe("Detail base render", () => {
  it("renders hero, omdb, stream picker, cast rail and related", () => {
    mockDetail = detailState({
      cast: [{ id: 1, name: "Actor", character: "Role", profilePath: null } as any],
      related: [preview("rel1")],
    });
    render(<Detail />);
    expect(screen.getByTestId("hero")).toBeInTheDocument();
    expect(screen.getByTestId("hero-title").textContent).toBe("The Movie");
    expect(screen.getByTestId("omdb").getAttribute("data-imdb")).toBe("tt100");
    expect(screen.getByTestId("omdb").closest('[data-testid="hero"]')).not.toBeNull();
    expect(screen.getByTestId("streampicker")).toBeInTheDocument();
    expect(screen.getByTestId("castrail").getAttribute("data-count")).toBe("1");
    expect(screen.getByText("related-rel1")).toBeInTheDocument();
  });

  it("refreshes Continue Watching once when a player session closes", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByTestId("play-stream"));
    expect(await screen.findByTestId("player")).toBeInTheDocument();

    await userEvent.click(screen.getByText("report-progress"));
    expect(recordResume).toHaveBeenCalledWith(
      mockDetailItem,
      80,
      100,
      null,
      undefined,
    );
    await userEvent.click(screen.getByText("close-player"));

    await waitFor(() => expect(refreshContinueWatching).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("player")).not.toBeInTheDocument();
  });

  it("omits the hero when the detail item is null (no metadata yet)", () => {
    mockDetail = detailState({ item: null });
    render(<Detail />);
    expect(screen.queryByTestId("hero")).toBeNull();
    // The stream picker still renders even without metadata.
    expect(screen.getByTestId("streampicker")).toBeInTheDocument();
  });

  it("is a modal dialog and closes the main Detail overlay with Escape", async () => {
    render(<Detail />);
    const dialog = screen.getByRole("dialog", { name: "Selected details" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await userEvent.keyboard("{Escape}");
    expect(closeDetail).toHaveBeenCalledTimes(1);
  });

  it("series: streams open on a dedicated page, not inline at the bottom", async () => {
    mockDetailItem = preview("s1", { type: "series", title: "The Series", tmdbId: 200 });
    mockDetail = detailState({ item: mediaItem({ type: "series", id: "s1", tmdbId: 200 }) });
    render(<Detail />);
    // For a series the picker is NOT inline - it lives on its own page.
    expect(screen.queryByTestId("streampicker")).not.toBeInTheDocument();
    // Picking an episode opens the dedicated streams page.
    const episodeTrigger = screen.getByTestId("pick-episode");
    await userEvent.click(episodeTrigger);
    const streamsDialog = screen.getByRole("dialog", { name: /Streams/ });
    expect(streamsDialog).toBeInTheDocument();
    expect(streamsDialog.parentElement).toBe(document.body);
    expect(streamsDialog).toHaveFocus();
    expect(screen.getByTestId("streampicker")).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /Episodes/ })).toHaveFocus();
    // "‹ Episodes" back button returns to the episode list (closes the page).
    await userEvent.click(screen.getByRole("button", { name: /Episodes/ }));
    expect(screen.queryByTestId("streampicker")).not.toBeInTheDocument();
    expect(episodeTrigger).toHaveFocus();
  });

  it("closes the streams page before the player opens", async () => {
    mockDetailItem = preview("s1", { type: "series", title: "The Series", tmdbId: 200 });
    mockDetail = detailState({ item: mediaItem({ type: "series", id: "s1", tmdbId: 200 }) });
    render(<Detail />);
    await userEvent.click(screen.getByTestId("pick-episode"));
    await userEvent.click(screen.getByTestId("play-stream"));
    expect(await screen.findByTestId("player")).toBeInTheDocument();

    expect(screen.queryByRole("dialog", { name: /Streams/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("player")).toBeInTheDocument();
  });

  it("closes the streams page on Escape when no player is mounted", async () => {
    mockDetailItem = preview("s1", { type: "series", title: "The Series", tmdbId: 200 });
    mockDetail = detailState({ item: mediaItem({ type: "series", id: "s1", tmdbId: 200 }) });
    render(<Detail />);
    await userEvent.click(screen.getByTestId("pick-episode"));
    expect(screen.getByRole("dialog", { name: /Streams/ })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Streams/ })).not.toBeInTheDocument(),
    );
  });

  it("renders the AI analysis only when the provider exposes analyzeTitle", () => {
    mockServices.ai = { analyzeTitle: vi.fn() };
    render(<Detail />);
    expect(screen.getByTestId("analysis")).toBeInTheDocument();
  });

  it("omits AI analysis and its upsell when no analyzeTitle provider is configured", () => {
    mockServices.ai = null;
    render(<Detail />);
    expect(screen.queryByTestId("analysis")).toBeNull();
    expect(screen.queryByText(/Add an AI provider/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Settings" })).not.toBeInTheDocument();
  });

  it("reflects watchlist membership in the hero", () => {
    inWatchlistResult = true;
    render(<Detail />);
    expect(screen.getByTestId("hero-inwl").textContent).toBe("true");
  });

  it("marks and unmarks an episode through history without touching continue watching", async () => {
    mockDetailItem = preview("s1", {
      type: "series",
      title: "The Series",
      tmdbId: 200,
    });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "The Series", tmdbId: 200 }),
    });
    render(<Detail />);

    await userEvent.click(screen.getByTestId("mark-episode-watched"));
    await waitFor(() =>
      expect(storeRecordHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaId: "s1",
          episodeId: "s1e2",
          progressSeconds: 1,
          durationSeconds: 1,
          completed: true,
        }),
      ),
    );
    await userEvent.click(screen.getByTestId("mark-episode-unwatched"));
    await waitFor(() =>
      expect(deleteHistory).toHaveBeenCalledWith("s1", "s1e2"),
    );
    expect(recordResume).not.toHaveBeenCalled();
    expect(refreshContinueWatching).not.toHaveBeenCalled();
  });

  it("marks and unmarks a movie through its completed history row", async () => {
    render(<Detail />);

    await userEvent.click(await screen.findByRole("button", { name: "Mark watched" }));
    await waitFor(() =>
      expect(storeRecordHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaId: "m1",
          episodeId: null,
          progressSeconds: 1,
          durationSeconds: 1,
          completed: true,
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Mark unwatched" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "Mark unwatched" }));
    await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith("m1", null));
    expect(await screen.findByRole("button", { name: "Mark watched" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("Detail actions", () => {
  it("closes via the hero back/close button", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByText("close"));
    expect(closeDetail).toHaveBeenCalledTimes(1);
  });

  it("toggles the watchlist for the selected item", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByText("toggle-wl"));
    expect(toggleWatchlist).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1" }),
    );
  });

  it("opens settings from the stream picker", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByText("open-settings"));
    expect(navigate).toHaveBeenCalledWith("settings");
  });

  it("forwards a related-item click to openDetail", async () => {
    mockDetail = detailState({ related: [preview("rel9")] });
    render(<Detail />);
    await userEvent.click(screen.getByText("related-rel9"));
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rel9" }),
    );
  });
});

describe("Detail play", () => {
  it("opens Settings when the title cannot be resolved to a searchable id", async () => {
    mockStreams = { ...streamsState(), missingImdbId: true };
    render(<Detail />);

    await userEvent.click(screen.getByText("play"));
    expect(navigate).toHaveBeenCalledWith("settings");
  });

  it("scrolls to the stream picker when there is no cached resolution", async () => {
    const scrollIntoView = vi.fn();
    const orig = document.getElementById.bind(document);
    vi.spyOn(document, "getElementById").mockImplementation((id) => {
      const el = orig(id);
      if (el) (el as any).scrollIntoView = scrollIntoView;
      return el;
    });
    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("uses movie metadata in player chrome and keeps the resolved filename in diagnostics", async () => {
    mockSettings = {
      transcode: false,
      ratingScale: "thumbs",
      defaultAudioLanguage: "ja",
      defaultSubtitleLanguage: "en",
      defaultSubtitleBehavior: "preferred",
      defaultPlaybackSpeed: 1.25,
      defaultVolume: 40,
      rememberPerTitleTrackChoices: false,
    };
    mockDetail = detailState({
      item: mediaItem({
        backdropPath: "/backdrop.jpg",
        posterPath: "/poster.jpg",
        overview: "A movie overview.",
      }),
    });
    mockCached = {
      stream: {
        fileName: "movie.mp4",
        streamURL: "https://cdn/movie.mp4",
        codec: "H.264",
      },
    };
    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    await waitFor(() => {
      expect(screen.getByTestId("player")).toBeInTheDocument();
    });
    expect(screen.getByTestId("player").getAttribute("data-title")).toBe(
      "The Movie (2020)",
    );
    expect(screen.getByTestId("player")).toHaveAttribute("data-source-file", "movie.mp4");
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-engine",
      "webview-direct",
    );
    expect(screen.getByTestId("player")).toHaveAttribute("data-pause-year", "2020");
    expect(screen.getByTestId("player")).toHaveAttribute("data-pause-runtime", "120");
    expect(screen.getByTestId("player")).toHaveAttribute("data-pause-rating", "7.5");
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-pause-overview",
      "A movie overview.",
    );
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-pause-backdrop",
      "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
    );
    expect(screen.getByTestId("player")).toHaveAttribute("data-default-audio-language", "ja");
    expect(screen.getByTestId("player")).toHaveAttribute("data-default-subtitle-language", "en");
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-default-subtitle-behavior",
      "preferred",
    );
    expect(screen.getByTestId("player")).toHaveAttribute("data-default-playback-speed", "1.25");
    expect(screen.getByTestId("player")).toHaveAttribute("data-default-volume", "40");
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-remember-per-title-track-choices",
      "false",
    );
  });

  it("falls back to the resolved filename only when media metadata is unavailable", async () => {
    mockDetailItem = preview("m1", { title: "" });
    mockDetail = detailState({ item: null });
    render(<Detail />);

    await userEvent.click(screen.getByTestId("play-stream"));
    const player = await screen.findByTestId("player");
    expect(player).toHaveAttribute("data-title", "x.mp4");
    expect(player).toHaveAttribute("data-source-file", "x.mp4");
  });

  it("uses show and episode metadata for series player title and subtitle", async () => {
    const getEpisodes = vi.fn(async () => [
      {
        id: "ep-3",
        mediaId: "s1",
        seasonNumber: 1,
        episodeNumber: 3,
        title: "The Arrival",
      },
    ]);
    mockDetailItem = preview("s1", { type: "series", title: "Obsession", tmdbId: 200 });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "Obsession", tmdbId: 200 }),
    });
    mockServices.tmdb = { getEpisodes, getSeasons: vi.fn(async () => []) };
    render(<Detail />);

    await userEvent.click(screen.getByTestId("pick-episode"));
    await waitFor(() => expect(getEpisodes).toHaveBeenCalledWith(200, 1));
    await userEvent.click(screen.getByTestId("play-stream"));

    const player = await screen.findByTestId("player");
    expect(player).toHaveAttribute("data-title", "Obsession");
    expect(player).toHaveAttribute("data-subtitle", "S1 E3 - The Arrival");
    expect(player).toHaveAttribute("data-up-next", "S1 E4");
    expect(player).toHaveAttribute("data-auto-countdown", "false");
  });

  async function playSeriesEpisode(
    selection: { season: number; episode: number },
    getSeasons: ReturnType<typeof vi.fn>,
    getEpisodes: ReturnType<typeof vi.fn>,
  ) {
    pickerSelection = selection;
    mockDetailItem = preview("s1", { type: "series", title: "Queue show", tmdbId: 200 });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "Queue show", tmdbId: 200 }),
    });
    mockServices.tmdb = { getSeasons, getEpisodes };
    render(<Detail />);
    await waitFor(() => expect(getSeasons).toHaveBeenCalledWith(200));
    await userEvent.click(screen.getByTestId("pick-episode"));
    await waitFor(() => expect(getEpisodes).toHaveBeenCalledWith(200, selection.season));
    await userEvent.click(screen.getByTestId("play-stream"));
    return screen.findByTestId("player");
  }

  it("queues an aired next episode within the current season at terminal playback", async () => {
    const getSeasons = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3 }]);
    const getEpisodes = vi.fn(async () => [
      { seasonNumber: 1, episodeNumber: 1, airDate: "2020-01-01" },
      { seasonNumber: 1, episodeNumber: 2, airDate: "2020-01-08" },
      { seasonNumber: 1, episodeNumber: 3, airDate: "2020-01-15" },
    ]);
    await playSeriesEpisode({ season: 1, episode: 1 }, getSeasons, getEpisodes);

    await userEvent.click(screen.getByRole("button", { name: "report-ended" }));
    await waitFor(() =>
      expect(storeRecordHistory).toHaveBeenCalledWith(
        expect.objectContaining({ episodeId: "s1e2", queuedNext: true }),
      ),
    );
  });

  it("queues an aired first episode of the next regular season at a boundary", async () => {
    const getSeasons = vi.fn(async () => [
      { seasonNumber: 1, episodeCount: 2 },
      { seasonNumber: 2, episodeCount: 4 },
    ]);
    const getEpisodes = vi.fn(async (_tmdbId: number, season: number) =>
      season === 2
        ? [{ seasonNumber: 2, episodeNumber: 1, airDate: "2020-02-01" }]
        : [
            { seasonNumber: 1, episodeNumber: 1, airDate: "2020-01-01" },
            { seasonNumber: 1, episodeNumber: 2, airDate: "2020-01-08" },
          ],
    );
    await playSeriesEpisode({ season: 1, episode: 2 }, getSeasons, getEpisodes);

    await userEvent.click(screen.getByRole("button", { name: "report-ended" }));
    await waitFor(() =>
      expect(storeRecordHistory).toHaveBeenCalledWith(
        expect.objectContaining({ episodeId: "s2e1", queuedNext: true }),
      ),
    );
  });

  it("does not queue after a series finale", async () => {
    const getSeasons = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 2 }]);
    const getEpisodes = vi.fn(async () => [
      { seasonNumber: 1, episodeNumber: 1, airDate: "2020-01-01" },
      { seasonNumber: 1, episodeNumber: 2, airDate: "2020-01-08" },
    ]);
    await playSeriesEpisode({ season: 1, episode: 2 }, getSeasons, getEpisodes);

    await userEvent.click(screen.getByRole("button", { name: "report-ended" }));
    expect(storeRecordHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ queuedNext: true }),
    );
  });

  it("does not queue an unaired next episode", async () => {
    const getSeasons = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 2 }]);
    const getEpisodes = vi.fn(async () => [
      { seasonNumber: 1, episodeNumber: 1, airDate: "2020-01-01" },
      { seasonNumber: 1, episodeNumber: 2, airDate: "2999-01-01" },
    ]);
    await playSeriesEpisode({ season: 1, episode: 1 }, getSeasons, getEpisodes);

    await userEvent.click(screen.getByRole("button", { name: "report-ended" }));
    await waitFor(() => expect(getEpisodes).toHaveBeenCalledWith(200, 1));
    await Promise.resolve();
    expect(storeRecordHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ queuedNext: true }),
    );
  });

  it("does not queue when no live episode guide is available", async () => {
    pickerSelection = { season: 1, episode: 1 };
    mockDetailItem = preview("s1", { type: "series", title: "Queue show", tmdbId: 200 });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "Queue show", tmdbId: 200 }),
    });
    mockServices.tmdb = null;
    render(<Detail />);
    await userEvent.click(screen.getByTestId("pick-episode"));
    await userEvent.click(screen.getByTestId("play-stream"));
    await userEvent.click(screen.getByRole("button", { name: "report-ended" }));

    expect(storeRecordHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ queuedNext: true }),
    );
  });

  it("requests a transcode HLS url for an MKV cached stream", async () => {
    const getTranscodeHLS = vi.fn(async () => "https://cdn/stream.m3u8");
    mockServices.debrid = { getTranscodeHLS };
    mockCached = {
      stream: {
        fileName: "movie.mkv",
        streamURL: "https://cdn/movie.mkv",
        codec: "H.264",
      },
    };
    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    await waitFor(() => expect(getTranscodeHLS).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("player")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-engine",
      "webview-hls-transcode",
    );
  });

  it("still attempts the custom web player when HLS transcode is unavailable", async () => {
    const getTranscodeHLS = vi.fn(async () => null);
    mockServices.debrid = { getTranscodeHLS };
    mockCached = {
      stream: {
        fileName: "movie.mkv",
        streamURL: "https://cdn/movie.mkv",
        codec: "H.265",
      },
    };
    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    await waitFor(() =>
      expect(screen.getByTestId("player")).toBeInTheDocument(),
    );
    expect(getTranscodeHLS).toHaveBeenCalled();
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-engine",
      "webview-direct",
    );
  });

  it("keeps the legacy server transcode preference on servers without selector qualities", async () => {
    serverModeOn = true;
    transcodeAvailable = true;
    mockSettings = { ...mockSettings, transcode: true, dataSaver: true };
    resolveServerStream.mockResolvedValue({
      fileName: "legacy.mp4",
      streamURL: "https://server.example/api/stream/session-legacy/index.m3u8",
      codec: "H.264",
    });
    mockDetailItem = preview("s1", { type: "series", title: "Obsession", tmdbId: 200 });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "Obsession", tmdbId: 200 }),
    });
    mockServices.tmdb = { getEpisodes: vi.fn(async () => []), getSeasons: vi.fn(async () => []) };

    render(<Detail />);
    await userEvent.click(screen.getByTestId("pick-episode"));
    await userEvent.click(screen.getByTestId("resolve-and-play-stream"));
    await waitFor(() => expect(resolveServerStream).toHaveBeenCalled());
    expect(resolveServerStream.mock.calls.at(-1)?.[1]).toMatchObject({
      transcode: true,
      transcodeOptions: { profile: "data-saver" },
    });
  });

  it("automatically uses server HLS for an incompatible source in the hosted web app", async () => {
    serverModeOn = true;
    transcodeAvailable = true;
    resolveServerStream.mockResolvedValue({
      fileName: "show.mkv",
      streamURL: "https://server.example/api/stream/session-1",
      codec: "H.265",
    });
    mockDetailItem = preview("s1", { type: "series", title: "Obsession", tmdbId: 200 });
    mockDetail = detailState({
      item: mediaItem({ id: "s1", type: "series", title: "Obsession", tmdbId: 200 }),
    });
    mockServices.tmdb = { getEpisodes: vi.fn(async () => []), getSeasons: vi.fn(async () => []) };

    render(<Detail />);
    await userEvent.click(screen.getByTestId("pick-episode"));
    expect(document.querySelector(".episode-streams")).not.toBeNull();
    await userEvent.click(screen.getByTestId("resolve-and-play-stream"));

    const player = await screen.findByTestId("player");
    expect(player).toHaveAttribute("data-engine", "webview-hls-transcode");
    expect(player).toHaveAttribute(
      "data-url",
      "https://server.example/api/stream/session-1/index.m3u8",
    );
    expect(player).toHaveAttribute(
      "data-source-file",
      "show.mkv",
    );
    expect(document.querySelector(".episode-streams")).toBeNull();
  });

  it("routes 2160p DV/HDR H265-in-MP4 straight to native mpv on desktop", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    const getTranscodeHLS = vi.fn(async () => "https://cdn/lossy.m3u8");
    mockServices.debrid = { getTranscodeHLS };
    mockSettings = {
      ...mockSettings,
      builtInPlayer: true,
      preferredExternalPlayer: "IINA",
    };
    mockCached = {
      stream: {
        fileName:
          "Obsession.2026.2160p.iT.WEB-DL.UNRATED.DV.HDR10+.MULTi.H265.MP4",
        streamURL: "https://cdn/obsession.mp4",
        // Route defensively from the filename even if cached metadata is stale.
        codec: "Unknown",
        restrictedId: "rd-id",
        playbackAuthorization: `Bearer ${"A".repeat(43)}`,
      },
    };

    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    const player = await screen.findByTestId("player");

    expect(player).toHaveAttribute("data-engine", "native-mpv");
    expect(player).toHaveAttribute("data-has-fallback", "true");
    expect(player).toHaveAttribute("data-has-playback-authorization", "true");
    // RD HLS is lazy recovery only. It must not run before native has failed.
    expect(getTranscodeHLS).not.toHaveBeenCalled();
  });

  it("keeps a browser-playable H264 MP4 in the webview even on desktop", async () => {
    // The structural guarantee behind routing: the browser-playable check runs
    // BEFORE isTauri(), so a container/codec the webview can decode never gets
    // upgraded to native mpv just because we're on desktop. Pinned here because
    // the existing webview-direct test runs in a browser session (isTauri=false);
    // this exercises the desktop branch to prove it still yields webview-direct.
    tauriState.on = true;
    tauriState.desktop = true;
    const getTranscodeHLS = vi.fn(async () => "https://cdn/lossy.m3u8");
    mockServices.debrid = { getTranscodeHLS };
    mockSettings = {
      ...mockSettings,
      builtInPlayer: true,
      preferredExternalPlayer: "IINA",
    };
    mockCached = {
      stream: {
        fileName: "movie.mp4",
        streamURL: "https://cdn/movie.mp4",
        codec: "H.264",
      },
    };

    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    const player = await screen.findByTestId("player");

    expect(player).toHaveAttribute("data-engine", "webview-direct");
    // Never routed to native and never asked RD to transcode - it just plays.
    expect(player).not.toHaveAttribute("data-engine", "native-mpv");
    expect(getTranscodeHLS).not.toHaveBeenCalled();
  });

  it("requests browser-compatible HLS for an incompatible source on Android", async () => {
    tauriState.on = true;
    tauriState.desktop = false;
    const getTranscodeHLS = vi.fn(async () => "https://cdn/android.m3u8");
    mockServices.debrid = { getTranscodeHLS };
    mockCached = {
      stream: {
        fileName: "movie.mkv",
        streamURL: "https://cdn/movie.mkv",
        codec: "H.265",
      },
    };

    render(<Detail />);
    await userEvent.click(screen.getByText("play"));
    const player = await screen.findByTestId("player");

    expect(getTranscodeHLS).toHaveBeenCalled();
    expect(player).toHaveAttribute("data-engine", "webview-hls-transcode");
    expect(player).toHaveAttribute("data-url", "https://cdn/android.m3u8");
  });
});

describe("Detail taste signal", () => {
  it("reads the newest taste event to seed the hero thumb on mount", async () => {
    recentTasteEvents.mockResolvedValue([
      { mediaId: "m1", eventType: "liked" },
    ]);
    render(<Detail />);
    await waitFor(() =>
      expect(screen.getByTestId("hero-taste").textContent).toBe("liked"),
    );
  });

  it("records a like and rebuilds the taste context", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByText("like"));
    expect(screen.getByTestId("hero-taste").textContent).toBe("liked");
    await waitFor(() => expect(addTasteEvent).toHaveBeenCalled());
    const evt = addTasteEvent.mock.calls[0][0] as any;
    expect(evt.eventType).toBe("liked");
    expect(evt.mediaId).toBe("m1");
    expect(evt.signalStrength).toBe(1);
    // genres carried in metadata from the loaded item.
    expect(evt.metadata.genres).toContain("Mystery");
    await waitFor(() => expect(rebuildTasteContext).toHaveBeenCalled());
  });

  it("toggles an active like back off as a not_interested event", async () => {
    recentTasteEvents.mockResolvedValue([
      { mediaId: "m1", eventType: "liked" },
    ]);
    render(<Detail />);
    await waitFor(() =>
      expect(screen.getByTestId("hero-taste").textContent).toBe("liked"),
    );
    await userEvent.click(screen.getByText("like"));
    expect(screen.getByTestId("hero-taste").textContent).toBe("none");
    await waitFor(() => expect(addTasteEvent).toHaveBeenCalled());
    const evt = addTasteEvent.mock.calls[0][0] as any;
    expect(evt.eventType).toBe("not_interested");
    expect(evt.signalStrength).toBe(0);
  });

  it("records a dislike with negative signal strength", async () => {
    render(<Detail />);
    await userEvent.click(screen.getByText("dislike"));
    expect(screen.getByTestId("hero-taste").textContent).toBe("disliked");
    await waitFor(() => expect(addTasteEvent).toHaveBeenCalled());
    expect((addTasteEvent.mock.calls[0][0] as any).signalStrength).toBe(-1);
  });
});

describe("Detail downloads", () => {
  it("passes the selected source size into the download queue", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    mockServices = {
      tmdb: null,
      indexers: {},
      debrid: { hasServices: true },
      ai: null,
      subtitles: null,
      translator: null,
    };
    mockSettings = {
      transcode: false,
      ratingScale: "thumbs",
      streamCachedOnly: false,
    };
    mockStreams = streamsState();
    mockStreams.rows = [downloadRow("Movie 2160p", 8_000_000_000)];

    render(<Detail />);
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    await userEvent.click(screen.getByRole("button", { name: "Download movie" }));

    await waitFor(() =>
      expect(downloadsRuntime.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ sizeBytes: 8_000_000_000 }),
      ),
    );
  });

  it("shows an estimate for the selected resolution and updates it for optimization", async () => {
    tauriState.on = true;
    tauriState.desktop = true;
    mockServices = {
      tmdb: null,
      indexers: {},
      debrid: { hasServices: true },
      ai: null,
      subtitles: null,
      translator: null,
    };
    mockSettings = {
      transcode: false,
      ratingScale: "thumbs",
      streamCachedOnly: false,
    };
    mockStreams = streamsState();
    mockStreams.rows = [
      downloadRow("Movie 2160p", 8 * 1024 * 1024 * 1024),
      downloadRow("Movie 720p", 1536 * 1024 * 1024),
    ];

    render(<Detail />);
    await userEvent.click(screen.getByRole("button", { name: "download" }));
    expect(await screen.findByText("Estimated total: 8.0 GB")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Download resolution"), {
      target: { value: "720p" },
    });
    expect(screen.getByText("Estimated total: 1.5 GB")).toBeInTheDocument();

    const optimized = screen.getByRole("button", { name: "Optimized copy" });
    await waitFor(() => expect(optimized).toBeEnabled());
    await userEvent.click(optimized);
    expect(screen.getByText("Estimated total: up to 1.5 GB")).toBeInTheDocument();
    expect(screen.getByLabelText("Audio languages to keep")).toBeInTheDocument();
    expect(screen.getByLabelText("Subtitle languages to keep")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Smaller file (slow)" }));
    expect(screen.getByText("Planning estimate: about 768 MB")).toBeInTheDocument();
  });

  it("does not offer desktop downloads on Android", () => {
    tauriState.on = true;
    tauriState.desktop = false;
    render(<Detail />);
    expect(screen.queryByRole("button", { name: "download" })).toBeNull();
    expect(downloadsFfmpegAvailable).not.toHaveBeenCalled();
  });
});

describe("Detail numeric rating", () => {
  it("records a 1–10 pick as a normalized 'rated' taste event", async () => {
    mockSettings.ratingScale = "ten";
    render(<Detail />);
    // The stars sit behind an explicit "Rate" button now.
    await userEvent.click(await screen.findByRole("button", { name: "Rate" }));
    await userEvent.click(await screen.findByLabelText("8 out of 10"));
    await waitFor(() => expect(addTasteEvent).toHaveBeenCalled());
    const evt = addTasteEvent.mock.calls[0][0] as any;
    expect(evt.eventType).toBe("rated");
    expect(evt.mediaId).toBe("m1");
    expect(evt.signalStrength).toBeCloseTo(0.6, 5);
    expect(evt.metadata.rating).toBe("8");
    expect(evt.metadata.scale).toBe("ten");
    expect(evt.metadata.norm).toBe("0.8000");
    await waitFor(() => expect(rebuildTasteContext).toHaveBeenCalled());
  });

  it("seeds the 1–10 control from the newest saved rating", async () => {
    mockSettings.ratingScale = "ten";
    recentTasteEvents.mockResolvedValue([
      {
        mediaId: "m1",
        eventType: "rated",
        metadata: { norm: "0.7" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    render(<Detail />);
    // Collapsed, the saved score shows on the Rate button; revealing it seeds
    // the stars from that value.
    await userEvent.click(
      await screen.findByRole("button", { name: "Your rating: 7/10" }),
    );
    expect(await screen.findByText("7/10")).toBeTruthy();
    expect(
      screen.getByLabelText("7 out of 10").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("commits a 0–100 rating only on release", async () => {
    mockSettings.ratingScale = "hundred";
    render(<Detail />);
    await userEvent.click(await screen.findByRole("button", { name: "Rate" }));
    const slider = await screen.findByLabelText("Rate out of 100");
    fireEvent.change(slider, { target: { value: "90" } });
    expect(addTasteEvent).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(addTasteEvent).toHaveBeenCalled());
    const evt = addTasteEvent.mock.calls[0][0] as any;
    expect(evt.metadata.scale).toBe("hundred");
    expect(evt.metadata.rating).toBe("90");
    expect(evt.metadata.norm).toBe("0.9000");
    expect(evt.signalStrength).toBeCloseTo(0.8, 5);
  });

  it("hides the numeric control in thumbs mode (hero thumbs only)", async () => {
    mockSettings.ratingScale = "thumbs";
    render(<Detail />);
    await screen.findByTestId("hero");
    expect(screen.queryByLabelText("Your rating")).toBeNull();
  });
});

describe("Detail server-mode title request", () => {
  it("does not expose a request action outside server mode", () => {
    serverModeOn = false;
    render(<Detail />);
    expect(screen.queryByText("request")).toBeNull();
    expect(screen.getByTestId("hero-reqstate").textContent).toBe("idle");
  });

  it("files a request and moves to the requested state", async () => {
    serverModeOn = true;
    createRequest.mockResolvedValue(undefined);
    render(<Detail />);
    await userEvent.click(screen.getByText("request"));
    await waitFor(() =>
      expect(screen.getByTestId("hero-reqstate").textContent).toBe(
        "requested",
      ),
    );
    expect(createRequest).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ id: "m1" }),
    );
  });

  it("treats a 409 as an already-pending request", async () => {
    serverModeOn = true;
    createRequest.mockRejectedValue({ status: 409 });
    render(<Detail />);
    await userEvent.click(screen.getByText("request"));
    await waitFor(() =>
      expect(screen.getByTestId("hero-reqstate").textContent).toBe("already"),
    );
  });

  it("reports a non-409 request failure instead of silently resetting", async () => {
    // Returning to "idle" made a failed request look identical to one never
    // made: the button span back to "Request" with nothing said.
    serverModeOn = true;
    createRequest.mockRejectedValue({ status: 500 });
    render(<Detail />);
    await userEvent.click(screen.getByText("request"));
    await waitFor(() => expect(createRequest).toHaveBeenCalled());
    expect(screen.getByTestId("hero-reqstate").textContent).toBe("failed");
  });

  it("lets the user retry after a failure", async () => {
    serverModeOn = true;
    createRequest.mockRejectedValueOnce({ status: 500 });
    render(<Detail />);
    await userEvent.click(screen.getByText("request"));
    await waitFor(() =>
      expect(screen.getByTestId("hero-reqstate").textContent).toBe("failed"),
    );
    // A failed request must stay actionable.
    createRequest.mockResolvedValueOnce(undefined);
    await userEvent.click(screen.getByText("request"));
    await waitFor(() =>
      expect(screen.getByTestId("hero-reqstate").textContent).toBe("requested"),
    );
  });
});
