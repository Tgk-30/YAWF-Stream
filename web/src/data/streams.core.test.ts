// Core coverage for the stream-RESOLUTION layer of streams.ts - the part that
// the existing two suites deliberately skip.
//
//   - streams.test.ts        → happy paths of the pure filter/quality exports.
//   - streams.extra.test.ts  → boundary/edge behavior of those same pure exports.
//
// Neither exercises `useStreams` or the private `resolveStreams` it wraps,
// because the vitest env is "node" with no jsdom / @testing-library / renderer.
// This file fills that gap by mocking `react` so the hook's body, callback and
// effect run synchronously in node, letting us assert the cache-merge / sort /
// error / server-mode / empty / no-indexer branches end-to-end through the only
// export that reaches `resolveStreams`.
//
// We never re-test the pure exports here (no duplication).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaType } from "../models/media";
import { CacheStatus, DebridServiceType } from "../services/debrid/models";
import {
  AudioFormat,
  SourceType,
  VideoCodec,
  VideoQuality,
  type TorrentResult,
} from "../services/indexers/models";
import type {
  DebridManager,
  MergedCacheEntry,
} from "../services/debrid/DebridManager";
import type { IndexerManager } from "../services/indexers/IndexerManager";

// ---------------------------------------------------------------------------
// react mock: run the hook synchronously, capturing setState transitions.
// useState  → real cell backed by a module-level slot (reset per render).
// useCallback/useMemo → identity (return the factory result / fn).
// useEffect → store the effect; the harness runs it after the render returns.
// ---------------------------------------------------------------------------
interface HookCell {
  state: unknown;
  effect: (() => void | (() => void)) | null;
}
let cell: HookCell = { state: undefined, effect: null };
let stateInitialized = false;

vi.mock("react", () => ({
  useState: (init: unknown) => {
    if (!stateInitialized) {
      cell.state = typeof init === "function" ? (init as () => unknown)() : init;
      stateInitialized = true;
    }
    const setState = (next: unknown) => {
      cell.state = typeof next === "function" ? (next as (s: unknown) => unknown)(cell.state) : next;
    };
    return [cell.state, setState];
  },
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void)) => {
    cell.effect = effect;
  },
  useRef: (init: unknown) => ({ current: init }),
}));

// serverMode + serverApi are mocked so we can flip Local vs Server mode.
vi.mock("../lib/serverMode", () => ({
  configuredServerURL: vi.fn(() => null),
}));
vi.mock("../lib/serverApi", () => ({
  fetchServerStreams: vi.fn(),
}));

import {
  classifyRowForEpisode,
  filterAndRankForEpisode,
  useStreams,
  type StreamRow,
  type StreamsState,
} from "./streams";
import { configuredServerURL } from "../lib/serverMode";
import { fetchServerStreams } from "../lib/serverApi";

const mockConfiguredServerURL = vi.mocked(configuredServerURL);
const mockFetchServerStreams = vi.mocked(fetchServerStreams);

const GB = 1024 * 1024 * 1024;

function torrent(overrides: Partial<TorrentResult>): TorrentResult {
  const infoHash = overrides.infoHash ?? "hash";
  return {
    get id() {
      return infoHash;
    },
    infoHash,
    title: overrides.title ?? "Movie.1080p.BluRay",
    sizeBytes: overrides.sizeBytes ?? 1 * GB,
    quality: overrides.quality ?? VideoQuality.hd1080p,
    codec: overrides.codec ?? VideoCodec.h264,
    audio: overrides.audio ?? AudioFormat.ac3,
    source: overrides.source ?? SourceType.bluray,
    seeders: overrides.seeders ?? 10,
    leechers: overrides.leechers ?? 0,
    indexerName: overrides.indexerName ?? "test",
    magnetURI: overrides.magnetURI ?? null,
    isCached: overrides.isCached ?? false,
    cachedOn: overrides.cachedOn ?? null,
  };
}

/** Minimal IndexerManager stand-in: activeIndexers + searchAll (+ optional
 * searchByQuery, exercised by the title-based pass). */
function fakeIndexers(opts: {
  active?: string[];
  searchAll?: (
    imdbId: string,
    type: MediaType,
    season?: number | null,
    episode?: number | null,
    signal?: AbortSignal,
  ) => Promise<TorrentResult[]>;
  searchByQuery?: (query: string, type: MediaType, signal?: AbortSignal) => Promise<TorrentResult[]>;
}): IndexerManager {
  const build = (): IndexerManager => ({
    get activeIndexers() {
      return opts.active ?? ["jackett"];
    },
    // Read by useStreams after every search (honest empty states). A fake with
    // no failures reports none.
    get lastSearchErrors() {
      return [];
    },
    searchAll: opts.searchAll ?? (async () => [] as TorrentResult[]),
    searchByQuery: opts.searchByQuery ?? (async () => [] as TorrentResult[]),
    fork: build,
  } as unknown as IndexerManager);
  return build();
}

/** Minimal DebridManager stand-in: only hasServices + checkCacheAll are read. */
function fakeDebrid(opts: {
  hasServices?: boolean;
  checkCacheAll?: (hashes: string[], signal?: AbortSignal) => Promise<Record<string, MergedCacheEntry>>;
}): DebridManager {
  return {
    get hasServices() {
      return opts.hasServices ?? true;
    },
    checkCacheAll:
      opts.checkCacheAll ?? (async () => ({} as Record<string, MergedCacheEntry>)),
  } as unknown as DebridManager;
}

/** Render `useStreams` once and run its effect to completion. Returns the final
 * captured state plus a cleanup that mirrors React's effect-teardown. */
async function renderStreams(
  imdbId: string | null,
  type: MediaType,
  indexers: IndexerManager,
  debrid: DebridManager | null,
  season: number | null = null,
  episode: number | null = null,
  title: string | null = null,
  imdbIdPending = false,
): Promise<{ initial: StreamsState; state: StreamsState; cleanup: () => void }> {
  // First synchronous render: the hook returns the initial state and registers
  // its effect.
  const initial = useStreams(
    imdbId,
    type,
    season,
    episode,
    title,
    null,
    indexers,
    debrid,
    imdbIdPending,
  );
  // Run the registered effect (kicks off the async run + returns teardown).
  const teardown = cell.effect ? cell.effect() : undefined;
  // Flush the microtask queue so the async `run` settles into setState.
  await flush();
  return {
    initial,
    state: cell.state as StreamsState,
    cleanup: () => {
      if (typeof teardown === "function") teardown();
    },
  };
}

/** Let pending promise chains settle. A few macrotask ticks cover the
 * searchAll → checkCacheAll → map → setState pipeline. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  cell = { state: undefined, effect: null };
  stateInitialized = false;
  mockConfiguredServerURL.mockReturnValue(null);
  mockFetchServerStreams.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useStreams - idle / no-imdb / no-indexer guards", () => {
  it("is idle (not loading, empty) when imdbId is null", async () => {
    const indexers = fakeIndexers({ active: ["jackett"] });
    const { state } = await renderStreams(null, "movie", indexers, null);
    expect(state.loading).toBe(false);
    expect(state.rows).toEqual([]);
    expect(state.error).toBeNull();
    // hasIndexers still reflects the configured indexers even when idle.
    expect(state.hasIndexers).toBe(true);
  });

  it("keeps a pending IMDb id in loading state, then reports a settled missing id", async () => {
    const search = vi.fn(async () => [torrent({ infoHash: "unexpected" })]);
    const indexers = fakeIndexers({ active: ["jackett"], searchAll: search });

    const pending = await renderStreams(
      null,
      "movie",
      indexers,
      null,
      null,
      null,
      null,
      true,
    );
    expect(pending.initial.loading).toBe(true);
    expect(pending.state).toMatchObject({ loading: true, missingImdbId: false });
    expect(search).not.toHaveBeenCalled();
    pending.cleanup();

    const settled = await renderStreams(null, "movie", indexers, null);
    expect(settled.state).toMatchObject({ loading: false, missingImdbId: true });
    expect(search).not.toHaveBeenCalled();
  });

  it("starts the search only after pending metadata supplies a valid IMDb id", async () => {
    const search = vi.fn(async () => [] as TorrentResult[]);
    const indexers = fakeIndexers({ active: ["jackett"], searchAll: search });

    const pending = await renderStreams(
      null,
      "movie",
      indexers,
      null,
      null,
      null,
      null,
      true,
    );
    expect(search).not.toHaveBeenCalled();
    pending.cleanup();

    const ready = await renderStreams("tt123", "movie", indexers, null);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      "tt123",
      "movie",
      null,
      null,
      expect.any(AbortSignal),
    );
    expect(ready.state).toMatchObject({ loading: false, missingImdbId: false });
  });

  it("keeps the no-indexer gate idle while an IMDb id is pending", async () => {
    const search = vi.fn(async () => [torrent({ infoHash: "unexpected" })]);
    const indexers = fakeIndexers({ active: [], searchAll: search });
    const { initial, state } = await renderStreams(
      null,
      "movie",
      indexers,
      null,
      null,
      null,
      null,
      true,
    );

    expect(initial.loading).toBe(false);
    expect(state).toMatchObject({
      loading: false,
      hasIndexers: false,
      missingImdbId: false,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("does NOT load when no indexers are configured (Local mode)", async () => {
    const search = vi.fn(async () => [torrent({ infoHash: "a" })]);
    const indexers = fakeIndexers({ active: [], searchAll: search });
    const { state } = await renderStreams("tt1", "movie", indexers, null);
    expect(state.loading).toBe(false);
    expect(state.rows).toEqual([]);
    expect(state.hasIndexers).toBe(false);
    // searchAll must never be invoked when there are no active indexers.
    expect(search).not.toHaveBeenCalled();
  });
});

describe("useStreams - Local resolve path (resolveStreams)", () => {
  it("returns empty rows (no debrid call) when searchAll yields nothing", async () => {
    const checkCacheAll = vi.fn(async () => ({}));
    const indexers = fakeIndexers({ searchAll: async () => [] });
    const debrid = fakeDebrid({ hasServices: true, checkCacheAll });
    const { state } = await renderStreams("tt1", "movie", indexers, debrid);
    expect(state.loading).toBe(false);
    expect(state.rows).toEqual([]);
    expect(state.error).toBeNull();
    expect(checkCacheAll).not.toHaveBeenCalled(); // early return before cache check
  });

  it("annotates each row with its cached service when debrid reports cache", async () => {
    const results = [
      torrent({ infoHash: "h1", title: "A" }),
      torrent({ infoHash: "h2", title: "B" }),
      torrent({ infoHash: "h3", title: "C" }),
    ];
    const checkCacheAll = vi.fn(
      async (): Promise<Record<string, MergedCacheEntry>> => ({
        h1: { service: DebridServiceType.realDebrid, status: CacheStatus.cached() },
        // h2 reported but NOT cached → must be filtered out → cachedOn null.
        h2: { service: DebridServiceType.allDebrid, status: CacheStatus.notCached },
        // h3 absent entirely → cachedOn null.
      }),
    );
    const indexers = fakeIndexers({ searchAll: async () => results });
    const debrid = fakeDebrid({ hasServices: true, checkCacheAll });
    const { state } = await renderStreams("tt9", "series", indexers, debrid);

    expect(checkCacheAll).toHaveBeenCalledWith(["h1", "h2", "h3"], expect.any(AbortSignal));
    expect(state.rows.map((r) => [r.result.infoHash, r.cachedOn])).toEqual([
      ["h1", DebridServiceType.realDebrid],
      ["h2", null],
      ["h3", null],
    ]);
    expect(state.rows.map((r) => r.cacheStatus)).toEqual([
      "cached",
      "not_cached",
      "unavailable",
    ]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("sorts the merged results by quality (highest first)", async () => {
    // resolveStreams now merges the imdb-based + title-based passes, so it
    // re-sorts by quality/seeders rather than trusting one pass's order.
    const results = [
      torrent({ infoHash: "z", quality: VideoQuality.sd480p }),
      torrent({ infoHash: "a", quality: VideoQuality.uhd4k }),
      torrent({ infoHash: "m", quality: VideoQuality.hd1080p }),
    ];
    const indexers = fakeIndexers({ searchAll: async () => results });
    const debrid = fakeDebrid({ hasServices: true });
    const { state } = await renderStreams("tt1", "movie", indexers, debrid);
    // 4k → 1080p → 480p.
    expect(state.rows.map((r) => r.result.infoHash)).toEqual(["a", "m", "z"]);
  });

  it("runs a title-based query and merges it when the imdb pass is empty", async () => {
    // The real bug: EZTV (imdb-native) is down so searchAll returns nothing, but
    // APIBay (name-matching) finds the episode via a `Title SxxEyy` query.
    let capturedQuery = "";
    const indexers = fakeIndexers({
      searchAll: async () => [],
      searchByQuery: async (q) => {
        capturedQuery = q;
        return [torrent({ infoHash: "t1", title: "Show S01E06 1080p x264" })];
      },
    });
    const { state } = await renderStreams(
      "tt9",
      "series",
      indexers,
      null,
      1,
      6,
      "Show",
    );
    expect(capturedQuery).toBe("Show S01E06");
    expect(state.rows.map((r) => r.result.infoHash)).toEqual(["t1"]);
  });

  it("dedupes the same torrent across the imdb and title passes (higher seeders wins)", async () => {
    const indexers = fakeIndexers({
      searchAll: async () => [torrent({ infoHash: "DUP", seeders: 5 })],
      // Same torrent, different hash case + more seeders.
      searchByQuery: async () => [torrent({ infoHash: "dup", seeders: 40 })],
    });
    const { state } = await renderStreams(
      "tt9",
      "movie",
      indexers,
      null,
      null,
      null,
      "Movie", // matches the default torrent title "Movie.1080p.BluRay"
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].result.seeders).toBe(40);
  });

  it("drops title-pass results whose name doesn't contain the requested title", async () => {
    const indexers = fakeIndexers({
      searchAll: async () => [],
      searchByQuery: async () => [
        torrent({ infoHash: "good", title: "Breaking Bad S01E06 1080p" }),
        torrent({ infoHash: "wrong", title: "Better Call Saul S01E06 1080p" }),
      ],
    });
    const { state } = await renderStreams(
      "tt9",
      "series",
      indexers,
      null,
      1,
      6,
      "Breaking Bad",
    );
    // Only the matching show survives the title validation.
    expect(state.rows.map((r) => r.result.infoHash)).toEqual(["good"]);
  });

  it("leaves every row uncached when no debrid manager is supplied", async () => {
    const results = [torrent({ infoHash: "h1" }), torrent({ infoHash: "h2" })];
    const indexers = fakeIndexers({ searchAll: async () => results });
    const { state } = await renderStreams("tt1", "movie", indexers, null);
    expect(state.rows.map((r) => r.cachedOn)).toEqual([null, null]);
    expect(state.hasDebrid).toBe(false);
  });

  it("skips the cache check when debrid has no services", async () => {
    const checkCacheAll = vi.fn(async () => ({}));
    const results = [torrent({ infoHash: "h1" })];
    const indexers = fakeIndexers({ searchAll: async () => results });
    const debrid = fakeDebrid({ hasServices: false, checkCacheAll });
    const { state } = await renderStreams("tt1", "movie", indexers, debrid);
    expect(checkCacheAll).not.toHaveBeenCalled();
    expect(state.rows[0].cachedOn).toBeNull();
    expect(state.hasDebrid).toBe(false);
  });

  it("keeps rows but marks cache status unavailable when the check rejects", async () => {
    const results = [torrent({ infoHash: "h1" }), torrent({ infoHash: "h2" })];
    const checkCacheAll = vi.fn(async () => {
      throw new Error("debrid down");
    });
    const indexers = fakeIndexers({ searchAll: async () => results });
    const debrid = fakeDebrid({ hasServices: true, checkCacheAll });
    const { state } = await renderStreams("tt1", "movie", indexers, debrid);
    // Source discovery succeeded, so the provider failure is not a top-level
    // search error. It must remain distinct from a confirmed uncached result.
    expect(state.error).toBeNull();
    expect(state.rows.map((r) => r.cachedOn)).toEqual([null, null]);
    expect(state.rows.map((r) => r.cacheStatus)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("useStreams - error path", () => {
  it("surfaces a searchAll Error message into state.error", async () => {
    const indexers = fakeIndexers({
      searchAll: async () => {
        throw new Error("indexer exploded");
      },
    });
    const { state } = await renderStreams("tt1", "movie", indexers, null);
    expect(state.error).toBe("indexer exploded");
    expect(state.rows).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("stringifies a non-Error throw into state.error", async () => {
    const indexers = fakeIndexers({
      searchAll: async () => {
        throw "plain string failure";
      },
    });
    const { state } = await renderStreams("tt1", "movie", indexers, null);
    expect(state.error).toBe("plain string failure");
    expect(state.rows).toEqual([]);
  });
});

describe("useStreams - cancellation", () => {
  it("aborts the request signal on effect cleanup", () => {
    let signal: AbortSignal | undefined;
    const indexers = fakeIndexers({
      searchAll: (_imdbId, _type, _season, _episode, requestSignal) => {
        signal = requestSignal;
        return new Promise<TorrentResult[]>(() => {});
      },
    });
    useStreams("tt1", "movie", null, null, null, null, indexers, null);
    const teardown = cell.effect ? cell.effect() : undefined;
    expect(signal?.aborted).toBe(false);
    if (typeof teardown === "function") teardown();
    expect(signal?.aborted).toBe(true);
  });

  it("does not commit results after the effect is torn down (cancelled)", async () => {
    let resolveSearch: (v: TorrentResult[]) => void = () => {};
    const indexers = fakeIndexers({
      searchAll: () =>
        new Promise<TorrentResult[]>((res) => {
          resolveSearch = res;
        }),
    });
    // Render and immediately tear down BEFORE the search resolves.
    const initial = useStreams("tt1", "movie", null, null, null, null, indexers, null);
    expect(initial.loading).toBe(true); // imdb + indexers ⇒ starts loading
    const teardown = cell.effect ? cell.effect() : undefined;
    if (typeof teardown === "function") teardown(); // mark cancelled

    const before = (cell.state as StreamsState).rows.length;
    resolveSearch([torrent({ infoHash: "late" })]);
    await flush();
    // Cancelled signal ⇒ the late result is dropped, state.rows unchanged.
    expect((cell.state as StreamsState).rows.length).toBe(before);
  });
});

describe("useStreams - Server mode", () => {
  beforeEach(() => {
    mockConfiguredServerURL.mockReturnValue("https://srv.example");
  });

  it("hasIndexers/hasDebrid are forced true and the server stream list is used", async () => {
    mockFetchServerStreams.mockResolvedValue({
      rows: [
        { result: torrent({ infoHash: "s1" }), cachedOn: DebridServiceType.torBox },
      ],
      hasIndexers: true,
      hasDebrid: false,
    });
    // Local indexers/debrid are empty, but server mode overrides the gating.
    const indexers = fakeIndexers({ active: [] });
    const { state } = await renderStreams("tt5", "movie", indexers, null);

    expect(mockFetchServerStreams).toHaveBeenCalledWith(
      expect.objectContaining({
        imdbId: "tt5",
        type: "movie",
        season: null,
        episode: null,
        title: null,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(state.rows.map((r) => r.result.infoHash)).toEqual(["s1"]);
    expect(state.rows[0].cachedOn).toBe(DebridServiceType.torBox);
    // server response drives the final hasIndexers/hasDebrid flags.
    expect(state.hasIndexers).toBe(true);
    expect(state.hasDebrid).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("forwards the title + episode context so the server can run its name pass", async () => {
    mockFetchServerStreams.mockResolvedValue({
      rows: [],
      hasIndexers: true,
      hasDebrid: true,
    });
    const indexers = fakeIndexers({ active: [] });
    // series + season/episode + title - the exact context the server needs to
    // build "The Bear S01E06" for its APIBay-style name-matching pass.
    await renderStreams("tt5", "series", indexers, null, 1, 6, "The Bear");
    expect(mockFetchServerStreams).toHaveBeenCalledWith(
      expect.objectContaining({
        imdbId: "tt5",
        type: "series",
        season: 1,
        episode: 6,
        title: "The Bear",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("surfaces a server fetch error into state.error", async () => {
    mockFetchServerStreams.mockRejectedValue(new Error("503 from server"));
    const indexers = fakeIndexers({ active: [] });
    const { state } = await renderStreams("tt5", "movie", indexers, null);
    expect(state.error).toBe("503 from server");
    expect(state.rows).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("never calls local searchAll while in server mode", async () => {
    mockFetchServerStreams.mockResolvedValue({ rows: [], hasIndexers: true, hasDebrid: true });
    const search = vi.fn(async () => [torrent({ infoHash: "local" })]);
    const indexers = fakeIndexers({ active: ["jackett"], searchAll: search });
    await renderStreams("tt5", "movie", indexers, null);
    expect(search).not.toHaveBeenCalled();
    expect(mockFetchServerStreams).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Episode classification + ranking (pure)
// ---------------------------------------------------------------------------

function rowTitled(title: string): StreamRow {
  return { result: torrent({ infoHash: title, title }), cachedOn: null };
}

describe("classifyRowForEpisode", () => {
  it("recognizes exact episode tags in common formats", () => {
    for (const t of [
      "Show.S02E05.1080p.WEB",
      "Show s02.e05 x265",
      "Show S2 E5 WEBRip",
      "Show.2x05.HDTV",
    ]) {
      expect(classifyRowForEpisode(rowTitled(t), 2, 5)).toBe("exact");
    }
  });

  it("drops wrong-episode and wrong-season releases as mismatches", () => {
    expect(classifyRowForEpisode(rowTitled("Show.S02E06.1080p"), 2, 5)).toBe("mismatch");
    expect(classifyRowForEpisode(rowTitled("Show.S03E05.1080p"), 2, 5)).toBe("mismatch");
    expect(classifyRowForEpisode(rowTitled("Show.S03.Complete"), 2, 5)).toBe("mismatch");
    expect(classifyRowForEpisode(rowTitled("Show 3x05"), 2, 5)).toBe("mismatch");
  });

  it("keeps right-season packs and untagged releases", () => {
    expect(classifyRowForEpisode(rowTitled("Show.S02.COMPLETE.1080p"), 2, 5)).toBe("pack");
    expect(classifyRowForEpisode(rowTitled("Show Season 2 1080p"), 2, 5)).toBe("pack");
    expect(classifyRowForEpisode(rowTitled("Show.Complete.Series"), 2, 5)).toBe("pack");
    expect(classifyRowForEpisode(rowTitled("Show 1080p WEB"), 2, 5)).toBe("unknown");
  });
});

describe("filterAndRankForEpisode", () => {
  it("is a no-op for movies (no episode requested)", () => {
    const rows = [rowTitled("A.S09E09"), rowTitled("B")];
    expect(filterAndRankForEpisode(rows, null, null)).toEqual(rows);
  });

  it("drops mismatches and stable-sorts exact matches first", () => {
    const pack = rowTitled("Show.S02.COMPLETE");
    const wrong = rowTitled("Show.S02E06.WEB");
    const exactA = rowTitled("Show.S02E05.1080p");
    const untagged = rowTitled("Show WEB-DL");
    const exactB = rowTitled("Show.2x05.HDTV");
    const out = filterAndRankForEpisode([pack, wrong, exactA, untagged, exactB], 2, 5);
    expect(out.map((r) => r.result.title)).toEqual([
      "Show.S02E05.1080p", // exacts first, original relative order kept
      "Show.2x05.HDTV",
      "Show.S02.COMPLETE", // then pack + untagged, original order
      "Show WEB-DL",
    ]);
  });
});
