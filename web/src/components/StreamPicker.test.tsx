// @vitest-environment jsdom
//
// Behavioral tests for StreamPicker: loading skeleton, no-indexers / error /
// no-streams empty states, the row list (quality + cached/will-cache badges,
// metadata), the Cached-only toggle + its filtered-empty state, row selection
// (resolve -> onPlay), the resolving badge + disabled state, resolve errors,
// and the "no debrid configured" guard.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { StreamRow, StreamsState } from "../data/streams";
import type { StreamMaxQuality } from "../data/settings";
import { DebridServiceType, type StreamInfo } from "../services/debrid/models";
import { TorrentResult } from "../services/indexers/models";

// --- Mocks --------------------------------------------------------------

// Only the four fields filterStreamRows / effectiveDataSaver actually read.
interface TestSettings {
  dataSaver: boolean;
  streamCachedOnly: boolean;
  streamMaxQuality: StreamMaxQuality;
  streamMaxSizeGB: number;
}

// Default settings make filterStreamRows a pure no-op (Data Saver off, no caps).
let storeSettings: TestSettings = {
  dataSaver: false,
  streamCachedOnly: false,
  streamMaxQuality: "any",
  streamMaxSizeGB: 0,
};

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({ settings: storeSettings }),
}));

vi.mock("./Icon", () => ({
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
}));

vi.mock("./StreamPicker.css", () => ({}));

import { STREAM_RESOLVE_TIMEOUT_MS, StreamPicker } from "./StreamPicker";

// --- Fixtures -----------------------------------------------------------

function makeRow(opts: {
  hash: string;
  title: string;
  sizeBytes?: number;
  seeders?: number;
  indexerName?: string;
  cachedOn?: DebridServiceType | null;
  cacheStatus?: StreamRow["cacheStatus"];
}): StreamRow {
  const result = TorrentResult.fromSearch({
    infoHash: opts.hash,
    title: opts.title,
    sizeBytes: opts.sizeBytes ?? 1_500_000_000,
    seeders: opts.seeders ?? 42,
    leechers: 1,
    indexerName: opts.indexerName ?? "Jackett",
  });
  return {
    result,
    cachedOn: opts.cachedOn ?? null,
    ...(opts.cacheStatus == null ? {} : { cacheStatus: opts.cacheStatus }),
  };
}

function baseState(over: Partial<StreamsState> = {}): StreamsState {
  return {
    rows: [],
    loading: false,
    error: null,
    hasIndexers: true,
    hasDebrid: true,
    missingImdbId: false,
    sourceErrors: [],
    ...over,
  };
}

const noop = () => {};
const neverResolve = async (): Promise<StreamInfo> => {
  throw new Error("should not be called");
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  storeSettings = {
    dataSaver: false,
    streamCachedOnly: false,
    streamMaxQuality: "any",
    streamMaxSizeGB: 0,
  };
});

describe("StreamPicker", () => {
  it("renders the loading skeleton when state.loading is true", () => {
    const { container } = render(
      <StreamPicker
        state={baseState({ loading: true })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    const list = container.querySelector(".streams-skeleton");
    expect(list).not.toBeNull();
    expect(list).toHaveAttribute("aria-busy", "true");
    // 4 skeleton rows.
    expect(container.querySelectorAll(".stream-row-skel")).toHaveLength(4);
  });

  it("shows the 'no sources configured' empty state and an Open settings button", () => {
    const onOpenSettings = vi.fn();
    render(
      <StreamPicker
        state={baseState({ hasIndexers: false })}
        resolveStream={neverResolve}
        onPlay={noop}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.getByText("No sources yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open settings/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("omits the settings button when no onOpenSettings is given", () => {
    render(
      <StreamPicker
        state={baseState({ hasIndexers: false })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    expect(screen.getByText("No sources yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open settings/ })).toBeNull();
  });

  it("renders an error state when state.error is set", () => {
    render(
      <StreamPicker
        state={baseState({ error: "Indexer timed out" })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    expect(screen.getByText("Couldn't search streams")).toBeInTheDocument();
    expect(screen.getByText("Indexer timed out")).toBeInTheDocument();
  });

  it("renders the 'No streams found' empty state when there are no rows", () => {
    render(
      <StreamPicker
        state={baseState({ rows: [] })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    expect(screen.getByText("No streams found")).toBeInTheDocument();
  });

  it("says the search NEVER RAN when the title has no IMDb id (not 'No streams found')", () => {
    // The silent P0: a null imdb id used to fall through to the generic empty
    // state, reading as an exhaustive search that found nothing - when in truth
    // zero requests were made.
    render(
      <StreamPicker
        state={baseState({ rows: [], missingImdbId: true })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    expect(screen.getByText("Can't search for this title yet")).toBeInTheDocument();
    expect(screen.queryByText("No streams found")).toBeNull();
  });

  it("names failed sources under the empty state so empty ≠ exhaustive", () => {
    render(
      <StreamPicker
        state={baseState({
          rows: [],
          sourceErrors: [
            { indexer: "Torrentio", error: "timed out" },
            { indexer: "EZTV", error: "dns" },
          ],
        })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );
    expect(screen.getByText("No streams found")).toBeInTheDocument();
    expect(
      screen.getByText(/2 sources.*couldn't be reached/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Torrentio, EZTV/)).toBeInTheDocument();
  });

  it("tells the truth with no debrid service and routes to the guided setup", () => {
    const onEvent = vi.fn();
    window.addEventListener("ds:open-first-run", onEvent);
    try {
      render(
        <StreamPicker
          state={baseState({ rows: [], hasDebrid: false })}
          resolveStream={neverResolve}
          onPlay={noop}
        />,
      );
      // NOT the misleading "sources did not return a match" copy - nothing was
      // searched for playback without a debrid service.
      expect(
        screen.getByText("Almost there - add a debrid service"),
      ).toBeInTheDocument();
      expect(screen.queryByText("No streams found")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Run guided setup" }));
      expect(onEvent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("ds:open-first-run", onEvent);
    }
  });

  it("renders a promoted Open settings button when no streams are available", () => {
    const onOpenSettings = vi.fn();
    render(
      <StreamPicker
        state={baseState({ rows: [], hasIndexers: true, hasDebrid: true })}
        resolveStream={neverResolve}
        onPlay={noop}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.getByText("No streams found")).toBeInTheDocument();
    const settings = screen.getByRole("button", { name: /Open settings/ });
    expect(settings).toBeInTheDocument();
    expect(settings.className).toContain("btn-prominent");
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("uses compact settings button when no debrid service is configured", () => {
    const onOpenSettings = vi.fn();
    render(
      <StreamPicker
        state={baseState({ rows: [], hasDebrid: false, hasIndexers: true })}
        resolveStream={neverResolve}
        onPlay={noop}
        onOpenSettings={onOpenSettings}
      />,
    );
    const settings = screen.getByRole("button", { name: /Open settings/ });
    expect(settings.className).toBe("btn");
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("lists rows with quality, metadata and the correct cached / will-cache badge", () => {
    const rows = [
      makeRow({
        hash: "AAA",
        title: "Dune.2021.1080p.BluRay.x265",
        sizeBytes: 4_000_000_000,
        seeders: 99,
        indexerName: "Jackett",
        cachedOn: DebridServiceType.realDebrid,
      }),
      makeRow({
        hash: "BBB",
        title: "Dune.2021.720p.WEB-DL",
        cachedOn: null,
      }),
    ];
    render(
      <StreamPicker
        state={baseState({ rows })}
        resolveStream={neverResolve}
        onPlay={noop}
      />,
    );

    // Cached row: green "Instant · RD" badge.
    const cached = screen.getByText("Dune.2021.1080p.BluRay.x265").closest("button")!;
    expect(within(cached).getByText(/Instant/)).toBeInTheDocument();
    expect(within(cached).getByText(/RD/)).toBeInTheDocument();
    // Quality chip + seeders + indexer metadata are shown.
    expect(within(cached).getByText("1080p")).toBeInTheDocument();
    expect(within(cached).getByText("99 seeders")).toBeInTheDocument();
    expect(within(cached).getByText("Jackett")).toBeInTheDocument();

    // Non-cached row: grey "Will cache" badge.
    const willCache = screen.getByText("Dune.2021.720p.WEB-DL").closest("button")!;
    expect(within(willCache).getByText("Will cache")).toBeInTheDocument();
  });

  it("offers Direct P2P only when advertised and requires a complete per-play acknowledgement", async () => {
    const user = userEvent.setup();
    const row = makeRow({ hash: "D".repeat(40), title: "Direct.Movie.1080p.mp4" });
    const resolveStream = vi.fn(async (_row: StreamRow, _backend?: string): Promise<StreamInfo> => ({
      streamURL: "https://server.test/api/stream/direct",
      quality: "1080p",
      codec: "H.264",
      audio: "Unknown",
      source: "Unknown",
      sizeBytes: 10,
      fileName: "Direct.Movie.1080p.mp4",
      debridService: "Direct P2P",
      backend: "direct_torrent",
    }));
    const onPlay = vi.fn();
    const { rerender } = render(
      <StreamPicker
        state={baseState({ rows: [row], hasDebrid: false })}
        resolveStream={resolveStream}
        onPlay={onPlay}
      />,
    );
    expect(screen.queryByRole("button", { name: "Direct P2P" })).toBeNull();
    rerender(
      <StreamPicker
        state={baseState({ rows: [row], hasDebrid: false })}
        resolveStream={resolveStream}
        onPlay={onPlay}
        directTorrentAvailable
      />,
    );
    await user.click(screen.getByRole("button", { name: "Direct P2P" }));
    expect(screen.getByText(/swarm peers can see your server's public IP/i)).toBeInTheDocument();
    expect(screen.getByText(/network or ISP can identify, block, or throttle/i)).toBeInTheDocument();
    expect(screen.getByText(/playback depends on seeders/i)).toBeInTheDocument();
    expect(screen.getByText(/upload data, use disk space/i)).toBeInTheDocument();
    expect(screen.getByText(/rights to this content/i)).toBeInTheDocument();
    const play = screen.getByRole("button", { name: "Play with Direct P2P" });
    expect(play).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /network, disk, and rights/i }));
    await user.click(play);
    await waitFor(() => expect(resolveStream).toHaveBeenCalledWith(row, "direct_torrent"));
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
  });

  it("keeps Direct P2P resolving beyond the debrid timeout until the server succeeds", async () => {
    vi.useFakeTimers();
    const row = makeRow({ hash: "F".repeat(40), title: "Direct.Slow.1080p.mp4" });
    let finishResolve!: (stream: StreamInfo) => void;
    const resolveStream = vi.fn(
      (_row: StreamRow, _backend?: "debrid" | "direct_torrent") =>
        new Promise<StreamInfo>((resolve) => {
          finishResolve = resolve;
        }),
    );
    const onPlay = vi.fn();

    render(
      <StreamPicker
        state={baseState({ rows: [row], hasDebrid: false })}
        resolveStream={resolveStream}
        onPlay={onPlay}
        directTorrentAvailable
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Direct P2P" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /network, disk, and rights/i }));
    fireEvent.click(screen.getByRole("button", { name: "Play with Direct P2P" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveStream).toHaveBeenCalledWith(row, "direct_torrent");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_RESOLVE_TIMEOUT_MS);
    });
    expect(screen.getByText("Resolving…")).toBeInTheDocument();
    expect(screen.queryByText(/took too long to resolve/)).toBeNull();
    expect(onPlay).not.toHaveBeenCalled();

    const directStream: StreamInfo = {
      streamURL: "https://server.test/api/stream/direct",
      quality: "1080p",
      codec: "H.264",
      audio: "Unknown",
      source: "Unknown",
      sizeBytes: 10,
      fileName: "Direct.Slow.1080p.mp4",
      debridService: "Direct P2P",
      backend: "direct_torrent",
    };
    await act(async () => {
      finishResolve(directStream);
      await Promise.resolve();
    });
    expect(onPlay).toHaveBeenCalledWith(directStream, row.result);
    expect(screen.queryByText("Resolving…")).toBeNull();
  });

  it("shows P2P sources immediately when a saved debrid cache filter is on", () => {
    storeSettings = { ...storeSettings, streamCachedOnly: true };
    const row = makeRow({ hash: "E".repeat(40), title: "Direct.Only.1080p.mp4" });
    render(
      <StreamPicker
        state={baseState({ rows: [row], hasDebrid: false })}
        resolveStream={neverResolve}
        onPlay={noop}
        directTorrentAvailable
      />,
    );
    expect(screen.getByText("Direct.Only.1080p.mp4")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Cached only" })).toBeNull();
    expect(screen.getByText("1 source total")).toBeInTheDocument();
  });

  it("renders the size label as a dash for zero-byte entries", () => {
    const rows = [makeRow({ hash: "ZZZ", title: "Zero byte", sizeBytes: 0 })];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("does not label a failed provider check as Will cache", () => {
    const onOpenSettings = vi.fn();
    const rows = [
      makeRow({
        hash: "UNKNOWN",
        title: "Provider status unavailable",
        cacheStatus: "unavailable",
      }),
    ];
    render(
      <StreamPicker
        state={baseState({ rows })}
        resolveStream={neverResolve}
        onPlay={noop}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText("Cache unknown")).toBeInTheDocument();
    expect(screen.queryByText("Will cache")).toBeNull();
    expect(screen.getByText(/provider did not return cache status/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Cached only/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check provider" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("uses whole-number formatting when values are large enough", () => {
    const rows = [makeRow({ hash: "BIG", title: "Large", sizeBytes: 3_000_000_000 })];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.getByText("2.8 GB")).toBeInTheDocument();
  });

  it("uses whole-number formatting for byte-sized values", () => {
    const rows = [makeRow({ hash: "BYTE", title: "Byte", sizeBytes: 100 })];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.getByText("100 B")).toBeInTheDocument();
  });

  it("shows one decimal place for sub-100 values with larger units", () => {
    const rows = [makeRow({ hash: "ABC", title: "Medium", sizeBytes: 1_536 })];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    // 1536 B -> 1.5 KB from formatSize.
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
  });

  it("shows the instant/total counts in the header", () => {
    const rows = [
      makeRow({ hash: "A", title: "A 1080p", cachedOn: DebridServiceType.allDebrid }),
      makeRow({ hash: "B", title: "B 1080p", cachedOn: null }),
      makeRow({ hash: "C", title: "C 1080p", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.getByText(/1 instant · 3 total/)).toBeInTheDocument();
  });

  it("starts with the Settings cached-only default, while the picker toggle stays session-scoped", () => {
    storeSettings = {
      dataSaver: false,
      streamCachedOnly: true,
      streamMaxQuality: "any",
      streamMaxSizeGB: 0,
    };
    const rows = [
      makeRow({ hash: "A", title: "Cached default 1080p", cachedOn: DebridServiceType.realDebrid }),
      makeRow({ hash: "B", title: "Uncached default 1080p", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    const toggle = screen.getByRole("checkbox", { name: /Cached only/ });
    expect(toggle).toBeChecked();
    expect(screen.getByText("Cached default 1080p")).toBeInTheDocument();
    expect(screen.queryByText("Uncached default 1080p")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Uncached default 1080p")).toBeInTheDocument();
  });

  it("shows progressive sources without discarding the saved cached-only preference", () => {
    storeSettings = {
      dataSaver: false,
      streamCachedOnly: true,
      streamMaxQuality: "any",
      streamMaxSizeGB: 0,
    };
    const preliminary = [
      makeRow({
        hash: "A",
        title: "Eventually cached 1080p H264 AAC mp4",
        cacheStatus: "unavailable",
      }),
      makeRow({
        hash: "B",
        title: "Eventually uncached 1080p H264 AAC mp4",
        cacheStatus: "unavailable",
      }),
    ];
    const props = {
      resolveStream: neverResolve,
      onPlay: noop,
    };
    const { rerender } = render(
      <StreamPicker
        {...props}
        state={baseState({
          rows: preliminary,
          loading: true,
          phase: "checking_availability",
        })}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: /Cached only/ });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Eventually cached 1080p H264 AAC mp4")).toBeInTheDocument();
    expect(screen.getByText("Eventually uncached 1080p H264 AAC mp4")).toBeInTheDocument();

    rerender(
      <StreamPicker
        {...props}
        state={baseState({
          rows: [
            { ...preliminary[0]!, cachedOn: DebridServiceType.realDebrid, cacheStatus: "cached" },
            { ...preliminary[1]!, cacheStatus: "not_cached" },
          ],
          phase: "ready",
        })}
      />,
    );
    expect(toggle).toBeChecked();
    expect(toggle).not.toBeDisabled();
    expect(screen.getByText("Eventually cached 1080p H264 AAC mp4")).toBeInTheDocument();
    expect(screen.queryByText("Eventually uncached 1080p H264 AAC mp4")).toBeNull();
  });

  it("renders 10 streams initially and expands by 20 at a time", () => {
    const rows = Array.from({ length: 31 }, (_, index) =>
      makeRow({ hash: `page-${index}`, title: `Paged stream ${index + 1} 1080p` }),
    );
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    expect(screen.getAllByText(/^Paged stream /)).toHaveLength(10);
    const more = screen.getByRole("button", { name: "Show 20 more" });
    fireEvent.click(more);
    expect(screen.getAllByText(/^Paged stream /)).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(screen.getAllByText(/^Paged stream /)).toHaveLength(31);
    expect(screen.queryByRole("button", { name: "Show 20 more" })).toBeNull();
  }, 15000);

  it("cached-first sorts the rows (instant rows render before will-cache ones)", () => {
    const rows = [
      makeRow({ hash: "A", title: "Uncached First 1080p", cachedOn: null }),
      makeRow({ hash: "B", title: "Cached Second 1080p", cachedOn: DebridServiceType.torBox }),
    ];
    const { container } = render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    const names = Array.from(container.querySelectorAll(".stream-name")).map(
      (n) => n.textContent,
    );
    expect(names[0]).toBe("Cached Second 1080p");
    expect(names[1]).toBe("Uncached First 1080p");
  });

  it("Cached-only toggle filters to instant streams, with a show-all escape hatch", () => {
    const rows = [
      makeRow({ hash: "A", title: "Cached One 1080p", cachedOn: DebridServiceType.premiumize }),
      makeRow({ hash: "B", title: "Uncached Two 1080p", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    const toggle = screen.getByRole("checkbox", { name: /Cached only/ });
    fireEvent.click(toggle);

    expect(screen.getByText("Cached One 1080p")).toBeInTheDocument();
    expect(screen.queryByText("Uncached Two 1080p")).toBeNull();
  });

  it("Cached-only with zero cached rows shows the instant-empty state + Show all", () => {
    const rows = [
      makeRow({ hash: "A", title: "Uncached A 1080p", cachedOn: null }),
      makeRow({ hash: "B", title: "Uncached B 1080p", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Cached only/ }));
    expect(screen.getByText("No instant streams shown")).toBeInTheDocument();

    // "Show all streams" turns the toggle back off and re-reveals the rows.
    fireEvent.click(screen.getByRole("button", { name: "Show all streams" }));
    expect(screen.getByText("Uncached A 1080p")).toBeInTheDocument();
  });

  it("shows a Season pack chip when episodeContext matches a season pack release", () => {
    const rows = [
      makeRow({ hash: "AAA", title: "My Show S01", cachedOn: DebridServiceType.realDebrid }),
      makeRow({ hash: "BBB", title: "Unrelated", cachedOn: DebridServiceType.realDebrid }),
    ];
    render(
      <StreamPicker
        state={baseState({ rows })}
        resolveStream={neverResolve}
        onPlay={noop}
        episodeLabel="S1E3"
        episodeContext={{ season: 1, episode: 3 }}
      />,
    );

    const packRow = screen.getByText("My Show S01").closest("button")!;
    expect(within(packRow).getByText("Season pack")).toBeInTheDocument();
  });

  it("resolves a selected stream and calls onPlay with the StreamInfo + torrent", async () => {
    const row = makeRow({ hash: "AAA", title: "Pick Me 1080p", cachedOn: DebridServiceType.realDebrid });
    const resolved: StreamInfo = {
      streamURL: "https://cdn.example/stream.mkv",
      quality: "1080p",
      codec: "H.265",
      audio: "Atmos",
      source: "BluRay",
      sizeBytes: 1234,
      fileName: "pick.mkv",
      debridService: "RD",
    };
    const resolveStream = vi.fn().mockResolvedValue(resolved);
    const onPlay = vi.fn();

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={onPlay}
      />,
    );

    expect(screen.getByText(/Instant/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Pick Me 1080p").closest("button")!);

    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(resolveStream).toHaveBeenCalledWith(row);
    expect(onPlay).toHaveBeenCalledWith(resolved, row.result);
    expect(screen.getByText(/Instant/)).toBeInTheDocument();
    expect(screen.queryByText("Failed · Retry")).not.toBeInTheDocument();
  });

  it("shows a Resolving… badge and disables the row while resolving", async () => {
    const row = makeRow({ hash: "AAA", title: "Slow Pick 1080p", cachedOn: null });
    let release!: (s: StreamInfo) => void;
    const resolveStream = vi.fn(
      () => new Promise<StreamInfo>((res) => {
        release = res;
      }),
    );

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={noop}
      />,
    );

    const button = screen.getByText("Slow Pick 1080p").closest("button")!;
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/Resolving/)).toBeInTheDocument());
    expect(button).toBeDisabled();

    // Resolve to let the pending promise settle.
    release({
      streamURL: "u",
      quality: "1080p",
      codec: "Unknown",
      audio: "Unknown",
      source: "Unknown",
      sizeBytes: 0,
      fileName: "f",
      debridService: "RD",
    });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("surfaces a resolve error message and clears the resolving state", async () => {
    const row = makeRow({ hash: "AAA", title: "Bad Pick 1080p", cachedOn: null });
    const resolveStream = vi.fn().mockRejectedValue(new Error("Debrid 429"));

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={noop}
      />,
    );

    fireEvent.click(screen.getByText("Bad Pick 1080p").closest("button")!);

    await waitFor(() =>
      expect(
        screen.getByText(
          "The provider rate limit was reached. Wait a minute, then retry this source.",
        ),
      ).toBeInTheDocument(),
    );
    // Row is interactive again (resolving cleared).
    expect(screen.getByText("Bad Pick 1080p").closest("button")!).not.toBeDisabled();
    expect(screen.getByText("Failed · Retry")).toBeInTheDocument();
  });

  it("times out a cached season-pack resolve into a failed retry state", async () => {
    vi.useFakeTimers();
    const row = makeRow({
      hash: "SEASON9",
      title: "Rick and Morty Season 9 Complete 1080p",
      cachedOn: DebridServiceType.realDebrid,
    });
    const resolveStream = vi.fn(() => new Promise<StreamInfo>(() => {}));
    const onPlay = vi.fn();

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={onPlay}
        episodeContext={{ season: 9, episode: 8 }}
      />,
    );

    const button = screen.getByText("Rick and Morty Season 9 Complete 1080p").closest("button")!;
    fireEvent.click(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_RESOLVE_TIMEOUT_MS);
    });

    expect(screen.queryByText("Resolving…")).not.toBeInTheDocument();
    expect(screen.getByText("Failed · Retry")).toBeInTheDocument();
    expect(screen.getByText(/took too long to resolve/)).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("fails a season pack that resolves to a different episode instead of playing it", async () => {
    const row = makeRow({
      hash: "SEASON9-WRONG-FILE",
      title: "Rick and Morty Season 9 Complete 1080p",
      cachedOn: DebridServiceType.realDebrid,
    });
    const resolveStream = vi.fn().mockResolvedValue({
      streamURL: "https://cdn.example/rick-and-morty-s09e07.mkv",
      quality: "1080p",
      codec: "H.264",
      audio: "Unknown",
      source: "WEB-DL",
      sizeBytes: 1,
      fileName: "Rick.and.Morty.S09E07.1080p.mkv",
      debridService: "RD",
    } satisfies StreamInfo);
    const onPlay = vi.fn();

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={onPlay}
        episodeContext={{ season: 9, episode: 8 }}
      />,
    );

    fireEvent.click(screen.getByText("Rick and Morty Season 9 Complete 1080p").closest("button")!);

    expect(await screen.findByText(/Couldn't find S09E08 in this season pack/)).toBeInTheDocument();
    expect(screen.getByText("Failed · Retry")).toBeInTheDocument();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("surfaces a non-Error resolve error and still clears resolving state", async () => {
    const row = makeRow({ hash: "TXT", title: "Text Error Pick 1080p", cachedOn: null });
    const resolveStream = vi.fn().mockRejectedValue("Nope");

    render(
      <StreamPicker
        state={baseState({ rows: [row] })}
        resolveStream={resolveStream}
        onPlay={noop}
      />,
    );

    fireEvent.click(screen.getByText("Text Error Pick 1080p").closest("button")!);
    await waitFor(() => expect(screen.getByText("Nope")).toBeInTheDocument());
    expect(screen.getByText("Text Error Pick 1080p").closest("button")!).not.toBeDisabled();
  });

  it("blocks selection with a guidance message when no debrid is configured", async () => {
    const row = makeRow({ hash: "AAA", title: "No Debrid 1080p", cachedOn: null });
    const resolveStream = vi.fn();

    render(
      <StreamPicker
        state={baseState({ rows: [row], hasDebrid: false })}
        resolveStream={resolveStream}
        onPlay={noop}
      />,
    );

    fireEvent.click(screen.getByText("No Debrid 1080p").closest("button")!);

    expect(await screen.findByText(/Add a debrid service in Settings to play/)).toBeInTheDocument();
    expect(resolveStream).not.toHaveBeenCalled();
  });

  it("shows episode-specific empty-state text when rows are absent", () => {
    render(
      <StreamPicker
        state={baseState({ rows: [] })}
        resolveStream={neverResolve}
        onPlay={noop}
        episodeLabel="S1E5"
      />,
    );
    expect(
      screen.getByText(
        "The configured sources have no match for S1E5 yet - try another episode or add another source.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the 'filters hid every stream' empty state when Data Saver removes all rows", () => {
    // Tighten settings so the 1080p / 4 GB row is filtered out entirely.
    storeSettings = {
      dataSaver: false,
      streamCachedOnly: false,
      streamMaxQuality: "480p",
      streamMaxSizeGB: 0,
    };
    const rows = [makeRow({ hash: "A", title: "Big 1080p File", cachedOn: null })];

    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.getByText("Playback filters hid every stream")).toBeInTheDocument();
  });

  // --- Resolution / codec filter chips (opt-in) -------------------------

  it("renders resolution + codec chips only when >1 value is present, and filters by resolution", () => {
    const rows = [
      makeRow({ hash: "A", title: "Movie 2160p x265", cachedOn: null }),
      makeRow({ hash: "B", title: "Movie 1080p x264", cachedOn: null }),
      makeRow({ hash: "C", title: "Movie 720p x264", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    const group = screen.getByRole("group", { name: "Filter streams" });
    expect(group).toBeInTheDocument();
    // A chip per present resolution (4K/1080p/720p) and codec (H.265/H.264).
    const chip4k = within(group).getByRole("button", { name: "4K" });
    expect(chip4k).toHaveAttribute("aria-pressed", "false");
    // All three rows are listed before filtering.
    expect(screen.getAllByText(/^Movie /)).toHaveLength(3);

    // Click the 4K chip → only the 2160p row remains, chip is pressed.
    fireEvent.click(chip4k);
    expect(chip4k).toHaveAttribute("aria-pressed", "true");
    const list = document.querySelector(".streams-list")!;
    expect(within(list as HTMLElement).getAllByText(/^Movie /)).toHaveLength(1);
    expect(within(list as HTMLElement).getByText("Movie 2160p x265")).toBeInTheDocument();

    // Clicking it again clears the filter (all three return).
    fireEvent.click(chip4k);
    expect(chip4k).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByText(/^Movie /)).toHaveLength(3);
  });

  it("filters by codec using the codec chip", () => {
    const rows = [
      makeRow({ hash: "A", title: "Movie 2160p x265", cachedOn: null }),
      makeRow({ hash: "B", title: "Movie 1080p x264", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );

    const group = screen.getByRole("group", { name: "Filter streams" });
    fireEvent.click(within(group).getByRole("button", { name: "H.264" }));
    expect(screen.queryByText("Movie 2160p x265")).toBeNull();
    expect(screen.getByText("Movie 1080p x264")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "H.264" }));
    expect(screen.getByText("Movie 2160p x265")).toBeInTheDocument();
    expect(screen.getByText("Movie 1080p x264")).toBeInTheDocument();
  });

  it("does not render the chip row when only one resolution and one codec are present", () => {
    const rows = [
      makeRow({ hash: "A", title: "Movie 1080p x264 one", cachedOn: null }),
      makeRow({ hash: "B", title: "Movie 1080p x264 two", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(screen.queryByRole("group", { name: "Filter streams" })).not.toBeInTheDocument();
  });

  it("clears active chips when a new title's results arrive (no stale pre-filtering)", () => {
    const rowsA = [
      makeRow({ hash: "A", title: "Title A 2160p x265", cachedOn: null }),
      makeRow({ hash: "B", title: "Title A 1080p x264", cachedOn: null }),
    ];
    const { rerender } = render(
      <StreamPicker state={baseState({ rows: rowsA })} resolveStream={neverResolve} onPlay={noop} />,
    );
    const chip4k = within(
      screen.getByRole("group", { name: "Filter streams" }),
    ).getByRole("button", { name: "4K" });
    fireEvent.click(chip4k);
    expect(chip4k).toHaveAttribute("aria-pressed", "true");

    // A different title resolves (new rows identity) that also has a 4K option - 
    // the old 4K chip must NOT carry over and silently pre-filter it.
    const rowsB = [
      makeRow({ hash: "C", title: "Title B 2160p x265", cachedOn: null }),
      makeRow({ hash: "D", title: "Title B 1080p x264", cachedOn: null }),
    ];
    rerender(
      <StreamPicker state={baseState({ rows: rowsB })} resolveStream={neverResolve} onPlay={noop} />,
    );
    expect(
      within(screen.getByRole("group", { name: "Filter streams" })).getByRole("button", {
        name: "4K",
      }),
    ).toHaveAttribute("aria-pressed", "false");
    // Both of Title B's rows are shown (unfiltered).
    expect(screen.getAllByText(/^Title B /)).toHaveLength(2);
  });

  it("shows the chip-empty state with a Clear filters button when a resolution+codec combo matches nothing", () => {
    // 4K is only H.265, 1080p is only H.264 → selecting 4K + H.264 is empty.
    const rows = [
      makeRow({ hash: "A", title: "Movie 2160p x265", cachedOn: null }),
      makeRow({ hash: "B", title: "Movie 1080p x264", cachedOn: null }),
    ];
    render(
      <StreamPicker state={baseState({ rows })} resolveStream={neverResolve} onPlay={noop} />,
    );
    const group = screen.getByRole("group", { name: "Filter streams" });
    fireEvent.click(within(group).getByRole("button", { name: "4K" }));
    fireEvent.click(within(group).getByRole("button", { name: "H.264" }));

    expect(screen.getByText("No streams match those filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    // Both rows return after clearing.
    expect(screen.getAllByText(/^Movie /)).toHaveLength(2);
  });

  it("shows episode-specific empty-state text when filters hide all rows", () => {
    storeSettings = {
      dataSaver: false,
      streamCachedOnly: false,
      streamMaxQuality: "480p",
      streamMaxSizeGB: 0,
    };
    const rows = [
      makeRow({ hash: "A", title: "Big 1080p File", cachedOn: null }),
    ];

    render(
      <StreamPicker
        state={baseState({ rows })}
        resolveStream={neverResolve}
        onPlay={noop}
        episodeLabel="S2 E5"
        episodeContext={{ season: 2, episode: 5 }}
      />,
    );

    expect(screen.getByText(/S2 E5/)).toBeInTheDocument();
    expect(screen.getByText("Playback filters hid every stream")).toBeInTheDocument();
  });
});
