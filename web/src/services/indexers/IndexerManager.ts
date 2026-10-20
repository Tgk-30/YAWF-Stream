// Port of the `IndexerManager` actor in
// Sources/DebridStreamer/Services/Indexers/TorrentIndexer.swift.
//
// Aggregates multiple indexers: searches them all concurrently, deduplicates by
// infoHash (keeping the higher-seeder copy), sorts by quality-then-seeders, and
// records per-indexer failures in `lastSearchErrors` without dropping the
// results from indexers that succeeded. The Swift `actor` serializes access;
// JS is single-threaded so a plain class with `await Promise.all` reproduces the
// same observable behavior (concurrent in-flight requests, merged at the end).

import type { MediaType } from "../../models/media";
import { IndexerFactory } from "./IndexerFactory";
import {
  TorrentResult,
  torrentResultHasUsableFileSelection,
  torrentResultSelectionKey,
  VideoQuality,
} from "./models";
import {
  defaultFetchImpl,
  type FetchImpl,
  type IndexerConfig,
  type TorrentIndexer,
} from "./types";

/** A per-indexer error recorded by the last search. Mirrors the Swift
 * `(indexer: String, error: String)` tuple. */
export interface IndexerSearchError {
  indexer: string;
  error: string;
}

/** Hard ceiling on how long any single indexer may take before it's dropped
 * from a search. Without this, one hung indexer (slow server, stalled socket)
 * blocks the whole Promise.all and the entire stream list never appears. */
export const INDEXER_TIMEOUT_MS = 12_000;

/** Resolve/reject with `promise`, but reject with a timeout error if it hasn't
 * settled within `ms`. The underlying request keeps running but is no longer
 * awaited, so a slow indexer can't hold up the ones that already answered. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class IndexerManager {
  private indexers: TorrentIndexer[];
  private _lastSearchErrors: IndexerSearchError[] = [];

  constructor(configs: IndexerConfig[] = [], fetchImpl: FetchImpl = defaultFetchImpl) {
    this.indexers = IndexerFactory.buildIndexers(configs, fetchImpl);
  }

  /** Errors from the last search (for diagnostics). Mirrors `lastSearchErrors`. */
  get lastSearchErrors(): IndexerSearchError[] {
    return this._lastSearchErrors;
  }

  addIndexer(indexer: TorrentIndexer): void {
    this.indexers.push(indexer);
  }

  setIndexers(newIndexers: TorrentIndexer[]): void {
    this.indexers = newIndexers;
  }

  /** Create an independent search context that shares the configured indexer
   * clients but owns its own diagnostic state. Complementary searches can run
   * concurrently without racing on lastSearchErrors. */
  fork(): IndexerManager {
    const fork = new IndexerManager();
    fork.setIndexers([...this.indexers]);
    return fork;
  }

  configure(configs: IndexerConfig[], fetchImpl: FetchImpl = defaultFetchImpl): void {
    this.indexers = IndexerFactory.buildIndexers(configs, fetchImpl);
  }

  /** The names of the active indexers, in order. Mirrors `activeIndexers`. */
  get activeIndexers(): string[] {
    return this.indexers.map((i) => i.name);
  }

  /** Search all active indexers concurrently and merge results. Mirrors
   * `searchAll`. */
  async searchAll(
    imdbId: string,
    type: MediaType,
    season: number | null = null,
    episode: number | null = null,
  ): Promise<TorrentResult[]> {
    const settled = await Promise.all(
      this.indexers.map(async (indexer) => {
        try {
          const results = await withTimeout(
            indexer.search(imdbId, type, season, episode),
            INDEXER_TIMEOUT_MS,
            indexer.name,
          );
          return { name: indexer.name, results, error: null as string | null };
        } catch (error) {
          return {
            name: indexer.name,
            results: [] as TorrentResult[],
            error: errorMessage(error),
          };
        }
      }),
    );

    return this.collect(settled);
  }

  /** Search by text query across all indexers. Mirrors `searchByQuery`. */
  async searchByQuery(query: string, type: MediaType): Promise<TorrentResult[]> {
    const settled = await Promise.all(
      this.indexers.map(async (indexer) => {
        try {
          // A concrete indexer may legitimately have no query path (the Swift
          // protocol default returns []); tolerate a missing method the same way.
          const results =
            typeof indexer.searchByQuery === "function"
              ? await withTimeout(
                  indexer.searchByQuery(query, type),
                  INDEXER_TIMEOUT_MS,
                  indexer.name,
                )
              : [];
          return { name: indexer.name, results, error: null as string | null };
        } catch (error) {
          return {
            name: indexer.name,
            results: [] as TorrentResult[],
            error: errorMessage(error),
          };
        }
      }),
    );

    return this.collect(settled);
  }

  /** Merges per-indexer outcomes: records failures in `lastSearchErrors`,
   * concatenates the successes, then dedups + sorts. */
  private collect(
    settled: { name: string; results: TorrentResult[]; error: string | null }[],
  ): TorrentResult[] {
    const allResults: TorrentResult[] = [];
    const errors: IndexerSearchError[] = [];
    for (const outcome of settled) {
      if (outcome.error != null) {
        errors.push({ indexer: outcome.name, error: outcome.error });
      } else {
        allResults.push(...outcome.results);
      }
    }
    this._lastSearchErrors = errors;
    return deduplicateAndSort(allResults);
  }
}

/** Deduplicate by torrent plus explicit file selection (preferring higher
 * seeders) and sort by quality then seeders. Different file indices in the
 * same torrent are independently playable and must not collapse. */
function deduplicateAndSort(results: TorrentResult[]): TorrentResult[] {
  const grouped = new Map<string, TorrentResult[]>();
  for (const r of results) {
    const key = torrentResultSelectionKey(r);
    const group = grouped.get(key);
    if (group) {
      group.push(r);
    } else {
      grouped.set(key, [r]);
    }
  }

  const survivors: TorrentResult[] = [];
  for (const group of grouped.values()) {
    // group.max(by: { $0.seeders < $1.seeders }) - keep the highest-seeder copy.
    let best = group[0];
    for (const r of group) {
      const bestUsable = torrentResultHasUsableFileSelection(best);
      const candidateUsable = torrentResultHasUsableFileSelection(r);
      if ((!bestUsable && candidateUsable) || (bestUsable === candidateUsable && best.seeders < r.seeders)) {
        best = r;
      }
    }
    survivors.push(best);
  }

  return survivors.sort((lhs, rhs) => {
    if (lhs.quality !== rhs.quality) {
      // Higher quality first.
      return VideoQuality.sortOrder(rhs.quality) - VideoQuality.sortOrder(lhs.quality);
    }
    // Then higher seeders first.
    return rhs.seeders - lhs.seeders;
  });
}

/** Extracts a non-empty message from a thrown value (mirrors Swift's
 * `error.localizedDescription`). */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  const s = String(error);
  return s.length > 0 ? s : "Unknown error";
}
