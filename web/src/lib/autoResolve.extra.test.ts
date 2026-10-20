// @vitest-environment jsdom
//
// jsdom env so `window` exists - the defaultEnabled/isTauriSafe gate inspects
// window globals (__TAURI_INTERNALS__ / __TAURI__). The rest of these tests are
// pure logic that runs identically under jsdom.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveOne,
  resolveWatchlistOnce,
  AutoResolveScheduler,
  RESOLUTION_TTL_MS,
  type AutoResolveDeps,
} from "./autoResolve";
import { defaultSettings, type AppSettings } from "../data/settings";
import { VideoQuality } from "../services/indexers/models";
import { CacheStatus } from "../services/debrid/models";
import type { MediaPreview } from "../models/media";
import type { IndexerManager } from "../services/indexers/IndexerManager";
import type { DebridManager } from "../services/debrid/DebridManager";
import type { Store } from "../storage/types";
import type { CachedResolutionRecord } from "../storage/models";

// id starts with "tt", so resolveImdbId short-circuits without needing TMDB.
function previewOf(id = "tt1"): MediaPreview {
  return { id, type: "movie", title: id } as unknown as MediaPreview;
}

function settings(over: Partial<AppSettings> = {}): AppSettings {
  // Most resolver cases exercise source selection, so opt out of the picker's
  // cached-only default unless a case explicitly verifies that hard constraint.
  return { ...defaultSettings(), streamCachedOnly: false, ...over };
}

function torrent(infoHash: string, quality: VideoQuality, sizeGB: number) {
  return { infoHash, quality, sizeBytes: sizeGB * 1024 * 1024 * 1024 };
}

/** Build a deps object with sensible defaults, overridable per field. */
function makeDeps(over: Partial<{
  results: ReturnType<typeof torrent>[];
  settings: AppSettings;
  resolveStream: ReturnType<typeof vi.fn>;
  checkCacheAll: ReturnType<typeof vi.fn>;
  putCachedResolution: ReturnType<typeof vi.fn>;
  hasServices: boolean;
  debridNull: boolean;
}> = {}): AutoResolveDeps {
  const resolveStream =
    over.resolveStream ?? vi.fn(async () => ({ debridService: "real_debrid" }));
  const checkCacheAll = over.checkCacheAll ?? vi.fn(async () => ({}));
  const putCachedResolution = over.putCachedResolution ?? vi.fn(async () => {});
  const debrid = over.debridNull
    ? null
    : ({
        hasServices: over.hasServices ?? true,
        checkCacheAll,
        resolveStream,
      } as unknown as DebridManager);
  return {
    tmdb: null,
    indexers: {
      searchAll: vi.fn(async () => over.results ?? [torrent("h1", VideoQuality.hd1080p, 4)]),
    } as unknown as IndexerManager,
    debrid,
    store: { putCachedResolution } as unknown as Store,
    settings: over.settings ?? settings(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveOne - guards & error handling", () => {
  it("returns null when debrid is null", async () => {
    const d = makeDeps({ debridNull: true });
    expect(await resolveOne(previewOf(), d)).toBeNull();
  });

  it("returns null when debrid has no services", async () => {
    const d = makeDeps({ hasServices: false });
    expect(await resolveOne(previewOf(), d)).toBeNull();
    // Never reaches the indexer search.
    expect(d.indexers.searchAll).not.toHaveBeenCalled();
  });

  it("returns null when no imdb id can be derived (no tmdb, non-tt id)", async () => {
    const d = makeDeps();
    const record = await resolveOne(previewOf("tmdb-999"), d);
    expect(record).toBeNull();
    expect(d.indexers.searchAll).not.toHaveBeenCalled();
  });

  it("returns null when the indexer search yields no results", async () => {
    const d = makeDeps({ results: [] });
    expect(await resolveOne(previewOf(), d)).toBeNull();
  });

  it("swallows a checkCacheAll rejection and still resolves (treats all as uncached)", async () => {
    const checkCacheAll = vi.fn(async () => {
      throw new Error("cache backend down");
    });
    const resolveStream = vi.fn(async () => ({ debridService: "real_debrid" }));
    const d = makeDeps({
      results: [torrent("h1", VideoQuality.hd1080p, 4)],
      checkCacheAll,
      resolveStream,
    });
    const record = await resolveOne(previewOf(), d);
    expect(record?.infoHash).toBe("h1");
    // Fell back to the best-by-sort candidate, then resolved it.
    expect(resolveStream).toHaveBeenCalledWith("h1", null);
  });

  it("swallows a resolveStream rejection and returns null (fault tolerant)", async () => {
    const resolveStream = vi.fn(async () => {
      throw new Error("resolve failed");
    });
    const d = makeDeps({ resolveStream });
    expect(await resolveOne(previewOf(), d)).toBeNull();
  });

  it("swallows a store.putCachedResolution rejection and returns null", async () => {
    const putCachedResolution = vi.fn(async () => {
      throw new Error("disk full");
    });
    const d = makeDeps({ putCachedResolution });
    expect(await resolveOne(previewOf(), d)).toBeNull();
  });
});

describe("resolveOne - cached-source preference", () => {
  it("prefers a cached candidate over the best-by-sort first row", async () => {
    // Best-by-sort is the 4K row, but only the 720p row is cached.
    const results = [
      torrent("best", VideoQuality.uhd4k, 4),
      torrent("cached", VideoQuality.hd720p, 4),
    ];
    const checkCacheAll = vi.fn(async () => ({
      cached: { service: "real_debrid", status: CacheStatus.cached("f", "n", 1) },
    }));
    const resolveStream = vi.fn(async () => ({ debridService: "real_debrid" }));
    const d = makeDeps({
      results,
      checkCacheAll,
      resolveStream,
      settings: settings({ dataSaver: false }),
    });
    const record = await resolveOne(previewOf(), d);
    expect(record?.infoHash).toBe("cached");
    expect(resolveStream).toHaveBeenCalledWith("cached", "real_debrid");
  });

  it("ignores a notCached/unknown status entry and treats the hash as uncached", async () => {
    const results = [torrent("h1", VideoQuality.hd1080p, 4)];
    const checkCacheAll = vi.fn(async () => ({
      h1: { service: "real_debrid", status: CacheStatus.notCached },
    }));
    const resolveStream = vi.fn(async () => ({ debridService: "real_debrid" }));
    const d = makeDeps({ results, checkCacheAll, resolveStream });
    const record = await resolveOne(previewOf(), d);
    expect(record?.infoHash).toBe("h1");
    expect(resolveStream).toHaveBeenCalledWith("h1", null);
  });

  it("pre-caches the best over-cap source when only quality/size caps emptied the allowed set (not cached-only)", async () => {
    // Data Saver clamps to 720p/5GB; both rows exceed it but cachedOnly is off.
    const results = [
      torrent("big4k", VideoQuality.uhd4k, 60),
      torrent("big1080", VideoQuality.hd1080p, 40),
    ];
    const resolveStream = vi.fn(async () => ({ debridService: "real_debrid" }));
    const d = makeDeps({
      results,
      resolveStream,
      settings: settings({ dataSaver: true, streamCachedOnly: false }),
    });
    const record = await resolveOne(previewOf(), d);
    // Falls back to the full row set; best-by-sort first row chosen.
    expect(record?.infoHash).toBe("big4k");
    expect(resolveStream).toHaveBeenCalled();
  });

  it("writes a well-formed CachedResolutionRecord on success", async () => {
    const putCachedResolution = vi.fn(async () => {});
    const resolveStream = vi.fn(async () => ({ debridService: "all_debrid" }));
    const d = makeDeps({
      results: [torrent("hh", VideoQuality.hd1080p, 4)],
      resolveStream,
      putCachedResolution,
    });
    const record = await resolveOne(previewOf("ttABC"), d);
    expect(record).toMatchObject({
      mediaId: "ttABC",
      infoHash: "hh",
      debridService: "all_debrid",
    });
    expect(typeof record?.resolvedAt).toBe("string");
    expect(Number.isNaN(Date.parse(record!.resolvedAt))).toBe(false);
    expect(putCachedResolution).toHaveBeenCalledWith(record);
  });

  it("resolves and persists the selected file identity for a multi-file source", async () => {
    const putCachedResolution = vi.fn(async () => {});
    const resolveStream = vi.fn(async () => ({ debridService: "torbox" }));
    const selected = {
      ...torrent("collection", VideoQuality.hd1080p, 4),
      fileIndex: 0,
      fileNameHint: "Requested.Small.mp4",
    };
    const record = await resolveOne(previewOf("ttFILES"), makeDeps({
      results: [selected],
      resolveStream,
      putCachedResolution,
    }));

    expect(resolveStream).toHaveBeenCalledWith("collection", null, {
      fileIndex: 0,
      fileName: "Requested.Small.mp4",
    });
    expect(record).toMatchObject({
      fileIndex: 0,
      fileNameHint: "Requested.Small.mp4",
    });
  });

  it("skips an identical resolution write until its freshness clock reaches half TTL", async () => {
    const now = 2_000_000_000_000;
    const putCachedResolution = vi.fn(async () => {});
    const d = makeDeps({
      results: [torrent("same-hash", VideoQuality.hd1080p, 4)],
      resolveStream: vi.fn(async () => ({
        debridService: "real_debrid",
        streamURL: "https://cdn.example/same.mkv",
      })),
      putCachedResolution,
    });
    const existing = {
      mediaId: "tt1",
      stream: { streamURL: "https://cdn.example/same.mkv" },
      resolvedAt: new Date(now - RESOLUTION_TTL_MS / 2 + 1).toISOString(),
      debridService: "real_debrid",
      infoHash: "same-hash",
    } as CachedResolutionRecord;

    expect(await resolveOne(previewOf(), d, existing, now)).toBe(existing);
    expect(putCachedResolution).not.toHaveBeenCalled();

    const refreshed = await resolveOne(
      previewOf(),
      d,
      { ...existing, resolvedAt: new Date(now - RESOLUTION_TTL_MS / 2).toISOString() },
      now,
    );
    expect(putCachedResolution).toHaveBeenCalledTimes(1);
    expect(refreshed?.resolvedAt).toBe(new Date(now).toISOString());
  });
});

/** Store stub for resolveWatchlistOnce that drives the freshness gate. */
function watchlistStore(over: Partial<{
  getCachedResolutions: ReturnType<typeof vi.fn>;
  putCachedResolution: ReturnType<typeof vi.fn>;
}> = {}): Store {
  return {
    getCachedResolutions: over.getCachedResolutions ?? vi.fn(async () => []),
    putCachedResolution: over.putCachedResolution ?? vi.fn(async () => {}),
  } as unknown as Store;
}

function freshRecord(now: number, ageMs: number): CachedResolutionRecord {
  return {
    mediaId: "x",
    stream: {} as never,
    resolvedAt: new Date(now - ageMs).toISOString(),
    debridService: "real_debrid",
    infoHash: "x",
  } as unknown as CachedResolutionRecord;
}

describe("resolveWatchlistOnce - queueing & freshness", () => {
  it("no-ops with zero counts when debrid is null", async () => {
    const d = makeDeps({ debridNull: true });
    const res = await resolveWatchlistOnce([previewOf("tt1")], d);
    expect(res).toEqual({ attempted: 0, resolved: 0, skipped: 0 });
  });

  it("no-ops when debrid has no services", async () => {
    const d = makeDeps({ hasServices: false });
    const res = await resolveWatchlistOnce([previewOf("tt1")], d);
    expect(res).toEqual({ attempted: 0, resolved: 0, skipped: 0 });
  });

  it("skips titles with a fresh cached resolution and attempts the rest", async () => {
    const now = 1_000_000_000_000;
    const getCachedResolutions = vi.fn(async () => [
      { ...freshRecord(now, 1000), mediaId: "tt-fresh" },
    ]);
    const d = makeDeps();
    d.store = watchlistStore({ getCachedResolutions });
    const res = await resolveWatchlistOnce(
      [previewOf("tt-fresh"), previewOf("tt-stale")],
      d,
      now,
    );
    expect(res.skipped).toBe(1);
    expect(res.attempted).toBe(1);
    expect(res.resolved).toBe(1);
  });

  it("treats a record at exactly the TTL boundary as stale (re-resolves it)", async () => {
    const now = 2_000_000_000_000;
    const getCachedResolutions = vi.fn(async () => [freshRecord(now, RESOLUTION_TTL_MS)]);
    const d = makeDeps();
    d.store = watchlistStore({ getCachedResolutions });
    const res = await resolveWatchlistOnce([previewOf("tt1")], d, now);
    // now - at === TTL, not < TTL → not fresh → attempted.
    expect(res.skipped).toBe(0);
    expect(res.attempted).toBe(1);
  });

  it("treats a record with an unparseable resolvedAt as stale", async () => {
    const now = 2_000_000_000_000;
    const bad = { ...freshRecord(now, 0), resolvedAt: "not-a-date" };
    const getCachedResolutions = vi.fn(async () => [bad]);
    const d = makeDeps();
    d.store = watchlistStore({ getCachedResolutions });
    const res = await resolveWatchlistOnce([previewOf("tt1")], d, now);
    expect(res.skipped).toBe(0);
    expect(res.attempted).toBe(1);
  });

  it("treats a keyed cache read rejection as no-cache (stale) and continues", async () => {
    const getCachedResolutions = vi.fn(async () => {
      throw new Error("read failed");
    });
    const d = makeDeps();
    d.store = watchlistStore({ getCachedResolutions });
    const res = await resolveWatchlistOnce([previewOf("tt1")], d, Date.now());
    expect(res.attempted).toBe(1);
    expect(res.skipped).toBe(0);
  });

  it("empty watchlist resolves to all-zero counts", async () => {
    const d = makeDeps();
    d.store = watchlistStore();
    expect(await resolveWatchlistOnce([], d, Date.now())).toEqual({
      attempted: 0,
      resolved: 0,
      skipped: 0,
    });
  });

  it("bulk-reads the watchlist cache once before selecting stale titles", async () => {
    const getCachedResolutions = vi.fn(async () => []);
    const d = makeDeps();
    d.store = watchlistStore({ getCachedResolutions });

    await resolveWatchlistOnce([previewOf("tt1"), previewOf("tt2")], d, Date.now());

    expect(getCachedResolutions).toHaveBeenCalledTimes(1);
    expect(getCachedResolutions).toHaveBeenCalledWith(["tt1", "tt2"]);
  });
});

describe("resolveWatchlistOnce - bounded concurrency", () => {
  it("never runs more than MAX_CONCURRENCY (3) resolves at once over a large queue", async () => {
    const total = 9;
    let active = 0;
    let maxActive = 0;
    const resolveStream = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return { debridService: "real_debrid" };
    });
    const d = makeDeps({ resolveStream });
    d.store = watchlistStore();
    const watchlist = Array.from({ length: total }, (_, i) => previewOf(`tt${i}`));
    const res = await resolveWatchlistOnce(watchlist, d, Date.now());
    expect(res.attempted).toBe(total);
    expect(res.resolved).toBe(total);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it("counts only successful resolves; a failing title does not stop the pass", async () => {
    let call = 0;
    const resolveStream = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return { debridService: "real_debrid" };
    });
    const d = makeDeps({ resolveStream });
    d.store = watchlistStore();
    const watchlist = [previewOf("tt0"), previewOf("tt1"), previewOf("tt2")];
    const res = await resolveWatchlistOnce(watchlist, d, Date.now());
    expect(res.attempted).toBe(3);
    expect(res.resolved).toBe(2);
  });
});

describe("AutoResolveScheduler - gate, throttle, re-entrancy", () => {
  function schedulerDeps(over: Partial<{
    listWatchlist: ReturnType<typeof vi.fn>;
    activeIndexers: string[];
    resolveStream: ReturnType<typeof vi.fn>;
    hasServices: boolean;
    debridNull: boolean;
  }> = {}) {
    const base = makeDeps({
      hasServices: over.hasServices,
      debridNull: over.debridNull,
      resolveStream: over.resolveStream,
    });
    (base.indexers as unknown as { activeIndexers: string[] }).activeIndexers =
      over.activeIndexers ?? ["ix"];
    base.store = {
      getCachedResolutions: vi.fn(async () => []),
      putCachedResolution: vi.fn(async () => {}),
      listWatchlist:
        over.listWatchlist ?? vi.fn(async () => [{ preview: previewOf("tt1") }]),
    } as unknown as Store;
    return base;
  }

  it("kick() runs a forced pass when enabled, ignoring the throttle", async () => {
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    const res = await sched.kick();
    expect(res).toEqual({ attempted: 1, resolved: 1, skipped: 0 });
    expect(deps.store.listWatchlist).toHaveBeenCalledTimes(1);
  });

  it("kick() returns null when the gate is disabled (browser no-op)", async () => {
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => false);
    expect(await sched.kick()).toBeNull();
    expect(deps.store.listWatchlist).not.toHaveBeenCalled();
  });

  it("kick() returns null when debrid is null", async () => {
    const deps = schedulerDeps({ debridNull: true });
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    expect(await sched.kick()).toBeNull();
  });

  it("kick() returns null when debrid has no services", async () => {
    const deps = schedulerDeps({ hasServices: false });
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    expect(await sched.kick()).toBeNull();
  });

  it("kick() returns null when no indexers are active", async () => {
    const deps = schedulerDeps({ activeIndexers: [] });
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    expect(await sched.kick()).toBeNull();
    expect(deps.store.listWatchlist).not.toHaveBeenCalled();
  });

  it("swallows a listWatchlist rejection and returns null", async () => {
    const deps = schedulerDeps({
      listWatchlist: vi.fn(async () => {
        throw new Error("store down");
      }),
    });
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    expect(await sched.kick()).toBeNull();
  });

  it("is re-entrancy-safe: a kick during an in-flight pass returns null", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const listWatchlist = vi.fn(async () => {
      await gate;
      return [{ preview: previewOf("tt1") }];
    });
    const deps = schedulerDeps({ listWatchlist });
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    const first = sched.kick();
    const second = await sched.kick(); // running === true → null
    expect(second).toBeNull();
    release();
    const firstRes = await first;
    expect(firstRes).toEqual({ attempted: 1, resolved: 1, skipped: 0 });
  });

  it("throttles a non-forced runOnce after a run within the interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 60_000, () => true);
    // start() kicks once immediately (force=false but lastRun=0, now-0 < interval is
    // false only at t=0 since 0 - 0 = 0 < 60000 → throttled). Use kick to seed lastRun.
    await sched.kick(); // forced → seeds lastRun = 0
    expect(deps.store.listWatchlist).toHaveBeenCalledTimes(1);
    // Advance less than the interval; the interval-driven (non-forced) pass throttles.
    vi.setSystemTime(30_000);
    // Drive a non-forced pass via the timer.
    sched.start(); // start() calls runOnce(false): now(30000) - lastRun(0) < 60000 → null
    expect(deps.store.listWatchlist).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it("start() is a no-op when the gate is disabled and sets no timer", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 1000, () => false);
    sched.start();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    sched.stop(); // safe to stop with no timer
  });

  it("start() then stop() registers and clears an interval timer", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 1000, () => true);
    sched.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    // A second start() is idempotent (timer already set).
    sched.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    sched.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("the interval timer fires a throttled-then-eligible pass over time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps, 1000, () => true);
    sched.start(); // immediate runOnce(false) at t=0: 0-0 < 1000 → throttled (no run)
    await Promise.resolve();
    expect(deps.store.listWatchlist).toHaveBeenCalledTimes(0);
    // Fire the interval once the throttle window has elapsed.
    vi.setSystemTime(1500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.store.listWatchlist).toHaveBeenCalled();
    sched.stop();
  });
});

describe("AutoResolveScheduler - defaultEnabled gate (real Tauri check)", () => {
  const W = window as unknown as Record<string, unknown>;

  afterEach(() => {
    delete W.__TAURI_INTERNALS__;
    delete W.__TAURI__;
  });

  function schedulerDeps() {
    const base = makeDeps();
    (base.indexers as unknown as { activeIndexers: string[] }).activeIndexers = ["ix"];
    base.store = {
      getCachedResolutions: vi.fn(async () => []),
      putCachedResolution: vi.fn(async () => {}),
      listWatchlist: vi.fn(async () => [{ preview: previewOf("tt1") }]),
    } as unknown as Store;
    return base;
  }

  it("default gate is disabled outside Tauri (no window globals) → kick() no-ops", async () => {
    // Neither __TAURI_INTERNALS__ nor __TAURI__ present in jsdom's window.
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps); // uses defaultEnabled
    expect(await sched.kick()).toBeNull();
    expect(deps.store.listWatchlist).not.toHaveBeenCalled();
  });

  it("default gate is enabled when __TAURI_INTERNALS__ is present → kick() runs", async () => {
    W.__TAURI_INTERNALS__ = {};
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps);
    expect(await sched.kick()).toEqual({ attempted: 1, resolved: 1, skipped: 0 });
    expect(deps.store.listWatchlist).toHaveBeenCalledTimes(1);
  });

  it("default gate is enabled when the legacy __TAURI__ global is present", async () => {
    W.__TAURI__ = {};
    const deps = schedulerDeps();
    const sched = new AutoResolveScheduler(() => deps);
    expect(await sched.kick()).toEqual({ attempted: 1, resolved: 1, skipped: 0 });
  });
});
