// Watchlist auto-resolve - a background pre-resolve job.
//
// For each watchlisted title it walks IndexerManager.searchAll -> DebridManager
// (cached-first) and stores the best ready-to-play resolution in the Store's
// `cachedResolution` table, keyed by mediaId. The watchlist UI then shows a
// "Ready to play" badge and Play can use the cached resolution for instant
// playback (skipping the indexer + debrid round-trip).
//
// This ONLY runs under Tauri (isTauri) and only when debrid + indexers are
// configured - debrid/indexer hosts are CORS-blocked in a plain browser, so the
// job is a no-op there. It is non-blocking, fault-tolerant (one title failing
// never stops the rest), and throttled (a minimum interval between full passes,
// plus a bounded concurrency so we don't hammer the indexers).
//
// The exported `resolveWatchlistOnce(...)` is the pure-ish unit of work (it takes
// its dependencies, so tests can drive it with stubs); `AutoResolveScheduler`
// wraps it with the Tauri gate, throttle, and an interval timer.

import type { MediaPreview, MediaType } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import type { IndexerManager } from "../services/indexers/IndexerManager";
import type { DebridManager, MergedCacheEntry } from "../services/debrid/DebridManager";
import { CacheStatus as CacheStatusNS } from "../services/debrid/models";
import type { Store } from "../storage/types";
import type { CachedResolutionRecord } from "../storage/models";
import type { AppSettings } from "../data/settings";
import {
  effectiveDataSaver,
  streamMatchesDataSaver,
  type StreamRow,
} from "../data/streams";
import { resolveImdbId } from "./metadata";

/** The dependencies a resolve pass needs, all injectable for testing. */
export interface AutoResolveDeps {
  tmdb: TMDBService | null;
  indexers: IndexerManager;
  debrid: DebridManager | null;
  store: Store;
  /** Current settings - so automatic selection honors the data-saver caps. */
  settings: AppSettings;
}

/** Outcome of a single pass - handy for diagnostics + tests. */
interface AutoResolveResult {
  /** Titles we attempted to resolve (had no fresh cached resolution). */
  attempted: number;
  /** Titles a ready resolution was cached for this pass. */
  resolved: number;
  /** Titles skipped because a fresh cached resolution already existed. */
  skipped: number;
}

/** How long a cached resolution stays "fresh" before we try to re-resolve it
 * (debrid direct links expire, so we periodically refresh). 6 hours. */
export const RESOLUTION_TTL_MS = 6 * 60 * 60 * 1000;
const RESOLUTION_REFRESH_HALF_TTL_MS = RESOLUTION_TTL_MS / 2;

/** Bounded concurrency so a large watchlist doesn't fire every search at once. */
const MAX_CONCURRENCY = 3;

/** Whether a cached resolution is still fresh enough to skip re-resolving. */
function isFresh(record: CachedResolutionRecord | null, now: number): boolean {
  if (record == null) return false;
  const at = Date.parse(record.resolvedAt);
  if (Number.isNaN(at)) return false;
  return now - at < RESOLUTION_TTL_MS;
}

function hasSameResolutionIdentity(
  existing: CachedResolutionRecord,
  next: CachedResolutionRecord,
): boolean {
  return (
    existing.stream.streamURL === next.stream.streamURL &&
    existing.infoHash === next.infoHash &&
    (existing.fileIndex ?? null) === (next.fileIndex ?? null) &&
    (existing.fileNameHint ?? null) === (next.fileNameHint ?? null) &&
    existing.debridService === next.debridService
  );
}

function shouldRefreshUnchangedResolution(
  existing: CachedResolutionRecord,
  now: number,
): boolean {
  const resolvedAt = Date.parse(existing.resolvedAt);
  return Number.isNaN(resolvedAt) || now - resolvedAt >= RESOLUTION_REFRESH_HALF_TTL_MS;
}

/** Resolve and cache the best ready-to-play stream for one title. Returns the
 * cached record on success, or null when nothing ready was found / an error was
 * swallowed. Fault-tolerant: never throws. */
export async function resolveOne(
  preview: MediaPreview,
  deps: AutoResolveDeps,
  existing: CachedResolutionRecord | null = null,
  now = Date.now(),
): Promise<CachedResolutionRecord | null> {
  const { tmdb, indexers, debrid, store, settings } = deps;
  if (debrid == null || !debrid.hasServices) return null;

  try {
    // 1. Derive an IMDb id (the indexer search key) via TMDB.
    const imdbId = await resolveImdbId(preview, tmdb);
    if (imdbId == null) return null;

    // 2. Search every indexer; results are already deduped + quality-sorted.
    const results = await indexers.searchAll(imdbId, preview.type as MediaType);
    if (results.length === 0) return null;

    // 3. Cache-check across debrid, then pick the best ready (cached) source so
    //    playback is instant. The pick must respect the same data-saver caps the
    //    manual picker applies - otherwise a 720p-capped user could still get a
    //    4K/huge source pre-cached. Build StreamRow-shaped candidates and filter.
    const hashes = results.map((r) => r.infoHash);
    const merged: Record<string, MergedCacheEntry> = await debrid
      .checkCacheAll(hashes)
      .catch(() => ({}));
    const rows: StreamRow[] = results.map((result) => {
      // checkCacheAll canonicalizes to lowercase - match it so a case
      // difference can't make a cached title read as uncached.
      const entry = merged[result.infoHash.toLowerCase()];
      const cachedOn =
        entry != null && CacheStatusNS.isCached(entry.status) ? entry.service : null;
      return { result, cachedOn };
    });

    const allowed = rows.filter((row) => streamMatchesDataSaver(row, settings));
    let pickFrom: StreamRow[];
    if (allowed.length > 0) {
      pickFrom = allowed;
    } else if (effectiveDataSaver(settings).cachedOnly) {
      // Cached-only is a hard constraint: nothing instant fits the caps, so don't
      // pre-cache a download-triggering source - leave it for manual play.
      return null;
    } else {
      // Only the quality/size caps emptied the set - pre-cache the best available
      // anyway (a ready badge beats none); the user can still override at play.
      pickFrom = rows;
    }

    // Prefer a cached (instant) candidate; else the best by the indexer sort. Fall
    // back when no service confirms cache (RD reports "unknown"); resolveStream
    // will add+poll if needed.
    const chosenRow = pickFrom.find((row) => row.cachedOn != null) ?? pickFrom[0];
    const chosen = chosenRow.result;
    const preferred = chosenRow.cachedOn;

    // 4. Resolve to a concrete, ready stream URL.
    const exactFileHint = chosen.fileIndex == null
      ? null
      : { fileIndex: chosen.fileIndex, fileName: chosen.fileNameHint ?? null };
    const stream = exactFileHint == null
      ? await debrid.resolveStream(chosen.infoHash, preferred)
      : await debrid.resolveStream(chosen.infoHash, preferred, exactFileHint);

    const record: CachedResolutionRecord = {
      mediaId: preview.id,
      stream,
      resolvedAt: new Date(now).toISOString(),
      debridService: stream.debridService,
      infoHash: chosen.infoHash,
      ...(chosen.fileIndex == null
        ? {}
        : {
            fileIndex: chosen.fileIndex,
            fileNameHint: chosen.fileNameHint ?? null,
          }),
    };
    if (existing != null && hasSameResolutionIdentity(existing, record)) {
      // resolvedAt is the freshness clock for expiring direct links. Keep an
      // identical row untouched until half the TTL has elapsed, then refresh
      // only that timestamp so a manual resolve cannot churn durable writes.
      if (!shouldRefreshUnchangedResolution(existing, now)) return existing;
    }
    await store.putCachedResolution(record);
    return record;
  } catch {
    // Fault-tolerant: a single title failing must not affect the others.
    return null;
  }
}

/** Run one full pass over the watchlist, resolving titles that lack a fresh
 * cached resolution. Concurrency-bounded + fault-tolerant. Pure-ish: all I/O
 * goes through the injected deps, so tests drive it directly. */
export async function resolveWatchlistOnce(
  watchlist: MediaPreview[],
  deps: AutoResolveDeps,
  now: number = Date.now(),
): Promise<AutoResolveResult> {
  if (deps.debrid == null || !deps.debrid.hasServices) {
    return { attempted: 0, resolved: 0, skipped: 0 };
  }

  // Read the cache in one keyed batch instead of one serial point read per
  // title. The table is keyed by mediaId, so the map is an exact lookup cache.
  const cachedRows = await deps.store
    .getCachedResolutions(watchlist.map((preview) => preview.id))
    .catch(() => []);
  const cachedByMediaId = new Map(cachedRows.map((record) => [record.mediaId, record]));

  // Decide which titles need work (no fresh cached resolution).
  const pending: Array<{ preview: MediaPreview; existing: CachedResolutionRecord | null }> = [];
  let skipped = 0;
  for (const preview of watchlist) {
    const existing = cachedByMediaId.get(preview.id) ?? null;
    if (isFresh(existing, now)) {
      skipped += 1;
    } else {
      pending.push({ preview, existing });
    }
  }

  let resolved = 0;
  // Simple bounded-concurrency worker pool over the pending queue.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const record = await resolveOne(
        pending[index].preview,
        deps,
        pending[index].existing,
        now,
      );
      if (record != null) resolved += 1;
    }
  }
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, pending.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return { attempted: pending.length, resolved, skipped };
}

/** Reads the watchlist from the Store (most-recently-added first) as previews. */
async function loadWatchlistPreviews(store: Store): Promise<MediaPreview[]> {
  const rows = await store.listWatchlist();
  return rows.map((r) => r.preview);
}

/** A throttled, Tauri-gated scheduler around `resolveWatchlistOnce`. Construct
 * with a getter for the current deps (so it always sees fresh service instances
 * after a settings change), then call `start()` to begin periodic passes and
 * `kick()` to trigger an on-demand pass (e.g. right after a watchlist add).
 *
 * In a plain browser `start()`/`kick()` are no-ops (debrid hosts are CORS-blocked
 * there) so the rest of the app behaves identically. */
export class AutoResolveScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRun = 0;

  constructor(
    private readonly getDeps: () => AutoResolveDeps,
    /** Minimum gap between passes (throttle). Default 5 minutes. */
    private readonly intervalMs: number = 5 * 60 * 1000,
    /** Gate predicate - overridable in tests; defaults to the Tauri check. */
    private readonly enabled: () => boolean = defaultEnabled,
  ) {}

  /** Begin periodic passes (no-op outside Tauri). Kicks once immediately. */
  start(): void {
    if (this.timer != null || !this.enabled()) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  /** Stop periodic passes. */
  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Trigger an on-demand pass, respecting the throttle + Tauri gate. Use after a
   * watchlist add. Resolves once the pass completes (or is skipped). */
  async kick(): Promise<AutoResolveResult | null> {
    return this.runOnce(true);
  }

  /** One guarded pass: gated, throttled, and re-entrancy-safe. */
  private async runOnce(force = false): Promise<AutoResolveResult | null> {
    if (!this.enabled()) return null;
    if (this.running) return null;
    const now = Date.now();
    if (!force && now - this.lastRun < this.intervalMs) return null;

    const deps = this.getDeps();
    if (deps.debrid == null || !deps.debrid.hasServices) return null;
    if (deps.indexers.activeIndexers.length === 0) return null;

    this.running = true;
    this.lastRun = now;
    try {
      const watchlist = await loadWatchlistPreviews(deps.store);
      return await resolveWatchlistOnce(watchlist, deps, now);
    } catch {
      return null;
    } finally {
      this.running = false;
    }
  }
}

/** Default gate: only run inside the Tauri webview (CORS-free network). Imported
 * lazily so this module stays unit-testable without the Tauri runtime. */
function defaultEnabled(): boolean {
  // Local import avoids a hard dependency for tests that inject their own gate.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  try {
    // `isTauri` is a tiny pure check on window globals.
    return isTauriSafe();
  } catch {
    return false;
  }
}

function isTauriSafe(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}
