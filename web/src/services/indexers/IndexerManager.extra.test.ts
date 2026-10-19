// Extra coverage for IndexerManager + the IndexerFactory path-joining edge and
// the indexers/types.ts IndexerType helpers that the main suites leave
// uncovered:
//   - IndexerManager.addIndexer / configure / activeIndexers, and the
//     non-Error / empty-message branches of the private `errorMessage` helper
//     (a thrown string and a thrown Error with an empty message).
//   - IndexerFactory.testConnection with an all-slashes endpointPath (the
//     `append.length === 0` join branch).
//   - IndexerType.displayName for every case (the switch in types.ts).
//
// Network is stubbed via an injected FetchImpl (same pattern as
// IndexerFactory.test.ts / indexers.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexerFactory } from "./IndexerFactory";
import { IndexerManager, INDEXER_TIMEOUT_MS } from "./IndexerManager";
import { VideoQuality } from "./models";
import {
  defaultFetchImpl,
  type FetchImpl,
  IndexerType,
  IndexerError,
  makeIndexerConfig,
  type TorrentIndexer,
} from "./types";

function makeStub(args: {
  name: string;
  results?: {
    infoHash: string;
    quality: VideoQuality;
    seeders: number;
    fileIndex?: number | null;
    fileNameHint?: string | null;
  }[];
  throws?: unknown;
}): TorrentIndexer {
  return {
    name: args.name,
    async search() {
      if (args.throws !== undefined) throw args.throws;
      return (args.results ?? []).map((r) => ({
        get id() {
          return r.fileIndex == null ? r.infoHash : `${r.infoHash}:${r.fileIndex}`;
        },
        infoHash: r.infoHash,
        title: "Some.Release.1080p",
        sizeBytes: 1,
        quality: r.quality,
        codec: "Unknown" as const,
        audio: "Unknown" as const,
        source: "Unknown" as const,
        seeders: r.seeders,
        leechers: 0,
        indexerName: args.name,
        magnetURI: null,
        isCached: false,
        cachedOn: null,
        fileIndex: r.fileIndex ?? null,
        fileNameHint:
          r.fileNameHint !== undefined
            ? r.fileNameHint
            : r.fileIndex == null ? null : `file-${r.fileIndex}.mkv`,
      }));
    },
    async searchByQuery() {
      if (args.throws !== undefined) throw args.throws;
      return [];
    },
  };
}

describe("IndexerManager.addIndexer / configure", () => {
  it("addIndexer appends to the active set in order", () => {
    const manager = new IndexerManager();
    manager.setIndexers([]);
    manager.addIndexer(makeStub({ name: "One" }));
    manager.addIndexer(makeStub({ name: "Two" }));
    expect(manager.activeIndexers).toEqual(["One", "Two"]);
  });

  it("configure rebuilds the indexer set from configs (replacing the old set)", () => {
    const manager = new IndexerManager();
    manager.setIndexers([makeStub({ name: "Stale" })]);
    expect(manager.activeIndexers).toEqual(["Stale"]);

    manager.configure([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
      makeIndexerConfig({
        id: "t",
        type: "torznab",
        baseURL: "http://h",
        displayName: "Fresh",
      }),
    ]);
    expect(manager.activeIndexers).toEqual(["Fresh"]);
  });

  it("fork shares configured indexers but isolates search diagnostics", async () => {
    let rejectImdb!: (error: Error) => void;
    let resolveTitle!: () => void;
    const controlled: TorrentIndexer = {
      name: "Controlled",
      search: () =>
        new Promise<never>((_resolve, reject) => {
          rejectImdb = reject;
        }),
      searchByQuery: () =>
        new Promise((resolve) => {
          resolveTitle = () => resolve([]);
        }),
    };
    const imdbManager = new IndexerManager();
    imdbManager.setIndexers([controlled]);
    const titleManager = imdbManager.fork();

    const imdbSearch = imdbManager.searchAll("tt0001", "movie");
    const titleSearch = titleManager.searchByQuery("Example", "movie");
    resolveTitle();
    await titleSearch;
    rejectImdb(new Error("IMDb path failed"));
    await imdbSearch;

    expect(imdbManager.activeIndexers).toEqual(["Controlled"]);
    expect(titleManager.activeIndexers).toEqual(["Controlled"]);
    expect(imdbManager.lastSearchErrors).toEqual([
      { indexer: "Controlled", error: "IMDb path failed" },
    ]);
    expect(titleManager.lastSearchErrors).toEqual([]);
  });
});

describe("IndexerManager errorMessage branches", () => {
  it("records a thrown non-Error string via String(error)", async () => {
    const manager = new IndexerManager();
    manager.setIndexers([makeStub({ name: "Throws", throws: "plain failure" })]);

    const results = await manager.searchAll("tt0001", "movie");
    expect(results).toEqual([]);
    expect(manager.lastSearchErrors).toEqual([
      { indexer: "Throws", error: "plain failure" },
    ]);
  });

  it("falls back to 'Unknown error' for an empty thrown value", async () => {
    const manager = new IndexerManager();
    // An Error with an empty message AND String(error) collapses to "" -> the
    // final fallback. Throwing an empty string triggers `String("") === ""`.
    manager.setIndexers([makeStub({ name: "Empty", throws: "" })]);

    await manager.searchAll("tt0001", "movie");
    expect(manager.lastSearchErrors).toEqual([
      { indexer: "Empty", error: "Unknown error" },
    ]);
  });

  it("records an Error with an empty message via String(error) ('Error')", async () => {
    const manager = new IndexerManager();
    manager.setIndexers([makeStub({ name: "BlankErr", throws: new Error("") })]);

    await manager.searchByQuery("q", "movie");
    // Error with an empty message -> the `error.message.length > 0` guard fails,
    // so it stringifies the Error, which is non-empty ("Error").
    expect(manager.lastSearchErrors).toEqual([
      { indexer: "BlankErr", error: "Error" },
    ]);
  });

  it("keeps successful results while recording a sibling indexer's failure", async () => {
    const manager = new IndexerManager();
    manager.setIndexers([
      makeStub({
        name: "Good",
        results: [
          { infoHash: "a".repeat(40), quality: VideoQuality.hd1080p, seeders: 7 },
        ],
      }),
      makeStub({ name: "Bad", throws: new Error("boom") }),
    ]);

    const results = await manager.searchAll("tt0001", "movie");
    expect(results.map((r) => r.infoHash)).toEqual(["a".repeat(40)]);
    expect(manager.lastSearchErrors).toEqual([{ indexer: "Bad", error: "boom" }]);
  });

  it("preserves different explicit file indices from the same info hash", async () => {
    const manager = new IndexerManager();
    manager.setIndexers([makeStub({
      name: "Files",
      results: [
        { infoHash: "a".repeat(40), quality: VideoQuality.hd720p, seeders: 2, fileIndex: 0 },
        { infoHash: "a".repeat(40), quality: VideoQuality.hd1080p, seeders: 1, fileIndex: 1 },
      ],
    })]);

    const results = await manager.searchAll("tt0001", "movie");
    expect(results.map((result) => result.fileIndex)).toEqual([1, 0]);
  });

  it("prefers a usable selector over a higher-seeder duplicate", async () => {
    const manager = new IndexerManager();
    manager.setIndexers([makeStub({
      name: "Files",
      results: [
        { infoHash: "a".repeat(40), quality: VideoQuality.uhd4k, seeders: 999, fileIndex: 0, fileNameHint: null },
        { infoHash: "a".repeat(40), quality: VideoQuality.hd720p, seeders: 1, fileIndex: 0, fileNameHint: "small.avi" },
      ],
    })]);

    const results = await manager.searchAll("tt0001", "movie");
    expect(results).toHaveLength(1);
    expect(results[0].fileNameHint).toBe("small.avi");
  });

  it("tolerates an indexer missing searchByQuery by returning no query results", async () => {
    const legacy: TorrentIndexer = {
      name: "Legacy",
      search: async () => [],
    } as unknown as TorrentIndexer;
    const manager = new IndexerManager();
    manager.setIndexers([
      legacy,
      makeStub({ name: "Modern", results: [{ infoHash: "new", quality: VideoQuality.hd1080p, seeders: 2 }] }),
    ]);

    const results = await manager.searchByQuery("probe", "movie");
    expect(results).toEqual([]);
    expect(manager.lastSearchErrors).toEqual([]);
  });

  it("drops a hung indexer after the timeout but keeps the fast one's results", async () => {
    vi.useFakeTimers();
    try {
      const hung: TorrentIndexer = {
        name: "Hung",
        // Never resolves - simulates a stalled indexer server/socket.
        search: () => new Promise<never>(() => {}),
        async searchByQuery() {
          return [];
        },
      };
      const manager = new IndexerManager();
      manager.setIndexers([
        makeStub({
          name: "Fast",
          results: [{ infoHash: "b".repeat(40), quality: VideoQuality.hd1080p, seeders: 5 }],
        }),
        hung,
      ]);

      const promise = manager.searchAll("tt0002", "movie");
      // Let the fast indexer settle, then trip the hung one's timeout.
      await vi.advanceTimersByTimeAsync(INDEXER_TIMEOUT_MS + 50);
      const results = await promise;

      // The fast indexer's result survives; the hung one is dropped + recorded.
      expect(results.map((r) => r.infoHash)).toEqual(["b".repeat(40)]);
      expect(
        manager.lastSearchErrors.some(
          (e) => e.indexer === "Hung" && /timed out/i.test(e.error),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("IndexerFactory.testConnection endpoint-path join edge", () => {
  it("joins an all-slashes endpointPath as a no-op append (append.length === 0)", async () => {
    let captured: URL | null = null;
    const fetchImpl: FetchImpl = async (url) => {
      captured = new URL(url);
      return { status: 200, text: async () => "<rss></rss>" };
    };
    const config = makeIndexerConfig({
      id: "t",
      type: "torznab",
      baseURL: "http://host/base",
      endpointPath: "///", // trims to "" -> the append-empty branch
    });
    const ok = await IndexerFactory.testConnection(config, fetchImpl);
    expect(ok).toBe(true);
    // The existing base path is preserved, nothing appended.
    expect(captured!.pathname).toBe("/base");
  });
});

describe("defaultFetchImpl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to the global fetch, forwarding url + init", async () => {
    const globalFetch = vi.fn(async () => ({
      status: 200,
      text: async () => "<rss></rss>",
    }));
    vi.stubGlobal("fetch", globalFetch);

    const res = await defaultFetchImpl("http://host/api", {
      headers: { "X-Api-Key": "k" },
    });
    expect(globalFetch).toHaveBeenCalledWith("http://host/api", {
      headers: { "X-Api-Key": "k" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<rss></rss>");
  });
});

describe("IndexerType.displayName", () => {
  it("returns the human label for every indexer type", () => {
    expect(IndexerType.displayName("jackett")).toBe("Jackett");
    expect(IndexerType.displayName("prowlarr")).toBe("Prowlarr");
    expect(IndexerType.displayName("torznab")).toBe("Torznab");
    expect(IndexerType.displayName("zilean")).toBe("Zilean");
    expect(IndexerType.displayName("stremio_addon")).toBe("Stremio Addon");
    expect(IndexerType.displayName("built_in")).toBe("Built-in Scrapers");
  });
});

describe("IndexerError.badServerResponse", () => {
  it("includes the HTTP status code when present", () => {
    const err = IndexerError.badServerResponse(503);
    expect(err.message).toBe("Bad server response (HTTP 503)");
    expect(err.statusCode).toBe(503);
  });

  it("omits the status suffix when absent", () => {
    const err = IndexerError.badServerResponse();
    expect(err.message).toBe("Bad server response");
    expect(err.statusCode).toBeUndefined();
  });
});
