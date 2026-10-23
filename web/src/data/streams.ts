// Stream-picker data layer.
//
// For a title (IMDb id + type), searches all configured indexers
// (IndexerManager.searchAll), then checks which of those torrents are instantly
// available on a debrid service (DebridManager.checkCacheAll over the infoHashes).
// Each result is annotated with its cache state (which service has it / "will
// cache") so the UI can render the green "Instant · RD" vs grey "Will cache"
// badge and a cached-first sort. Imports the ported services READ-ONLY.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaType } from "../models/media";
import type {
  DebridManager,
  MergedCacheEntry,
} from "../services/debrid/DebridManager";
import type { DebridServiceType } from "../services/debrid/models";
import { CacheStatus, matchEpisodeTag } from "../services/debrid/models";
import type {
  IndexerManager,
  IndexerSearchError,
} from "../services/indexers/IndexerManager";
import {
  torrentResultSelectionKey,
  torrentResultHasUsableFileSelection,
  VideoQuality,
  type TorrentResult,
} from "../services/indexers/models";
import type { AppSettings, StreamMaxQuality } from "./settings";
import { fetchServerStreams } from "../lib/serverApi";
import { configuredServerURL } from "../lib/serverMode";
import {
  buildTitleQuery,
  combineStreamResults,
  filterResultsByTitle,
} from "./streamMatching";

// buildTitleQuery + filterResultsByTitle historically lived in this module and
// now back BOTH modes via ./streamMatching; re-export so any importer reaching
// them through ../data/streams keeps working.
export { buildTitleQuery, filterResultsByTitle };

/** A torrent result plus its resolved cache state. */
export interface StreamRow {
  result: TorrentResult;
  /** Which debrid service has it cached (null when not cached / no debrid). */
  cachedOn: DebridServiceType | null;
  /** Whether the configured debrid service positively confirmed the hash.
   * Optional for compatibility with older self-hosted servers. A missing value
   * keeps the former cachedOn-only behavior in the UI. */
  cacheStatus?: "cached" | "not_cached" | "unavailable";
}

export interface StreamsState {
  rows: StreamRow[];
  loading: boolean;
  /** Current progressive resolution phase. Rows may already be visible while
   * provider cache availability is still being checked. */
  phase?: "searching_sources" | "checking_availability" | "ready";
  error: string | null;
  /** Whether any indexer is configured (drives the empty state copy). */
  hasIndexers: boolean;
  /** Whether any debrid service is configured (drives the cache badges). */
  hasDebrid: boolean;
  /** True when the title has NO imdb id, so no search could run at all. The UI
   * must say so - rendering the generic "No streams found" here was the silent
   * P0 ("streams are not being found"): zero requests were ever made. */
  missingImdbId: boolean;
  /** Per-source failures from the last search. Empty ⇒ every source answered.
   * Lets the empty state distinguish "nothing matched" from "sources down". */
  sourceErrors: IndexerSearchError[];
}


interface StreamQueryOwner {
  imdbId: string | null;
  type: MediaType;
  season: number | null;
  episode: number | null;
  title: string | null;
  year: number | null;
  indexers: IndexerManager;
  debrid: DebridManager | null;
  imdbIdPending: boolean;
  serverURL: string | null;
}

function sameStreamQueryOwner(left: StreamQueryOwner, right: StreamQueryOwner): boolean {
  return (
    left.imdbId === right.imdbId &&
    left.type === right.type &&
    left.season === right.season &&
    left.episode === right.episode &&
    left.title === right.title &&
    left.year === right.year &&
    left.indexers === right.indexers &&
    left.debrid === right.debrid &&
    left.imdbIdPending === right.imdbIdPending &&
    left.serverURL === right.serverURL
  );
}
const EMPTY: StreamsState = {
  rows: [],
  loading: false,
  phase: "ready",
  error: null,
  hasIndexers: false,
  hasDebrid: false,
  missingImdbId: false,
  sourceErrors: [],
};

function maxQualityOrder(maxQuality: StreamMaxQuality): number | null {
  return maxQuality === "any" ? null : VideoQuality.sortOrder(maxQuality);
}

/** The bandwidth-friendly ceiling the master Data Saver toggle clamps to. */
export const DATA_SAVER_MAX_QUALITY: StreamMaxQuality = "720p";
export const DATA_SAVER_MAX_SIZE_GB = 5;

/** Effective stream caps for a profile, applying the master Data Saver clamp.
 *
 * Data Saver only ever TIGHTENS (a `min` over quality + size) - it never loosens
 * a stricter explicit cap, so a user who already set 480p / 2 GB keeps those. The
 * cached-only constraint is left to its own explicit toggle. Off → the raw three
 * fields, so existing behavior is unchanged when Data Saver is off. */
export function effectiveDataSaver(settings: AppSettings): {
  cachedOnly: boolean;
  maxQuality: StreamMaxQuality;
  maxSizeGB: number;
} {
  if (!settings.dataSaver) {
    return {
      cachedOnly: settings.streamCachedOnly,
      maxQuality: settings.streamMaxQuality,
      maxSizeGB: settings.streamMaxSizeGB,
    };
  }
  const currentOrder = maxQualityOrder(settings.streamMaxQuality); // null = "any" (uncapped)
  const saverOrder = maxQualityOrder(DATA_SAVER_MAX_QUALITY) ?? 0; // "720p" is never "any"
  const maxQuality =
    currentOrder == null || currentOrder > saverOrder
      ? DATA_SAVER_MAX_QUALITY
      : settings.streamMaxQuality;
  // 0 means "no size cap", so treat it as larger than the Data Saver ceiling.
  const currentSize = settings.streamMaxSizeGB > 0 ? settings.streamMaxSizeGB : Infinity;
  const maxSizeGB = Math.min(currentSize, DATA_SAVER_MAX_SIZE_GB);
  return { cachedOnly: settings.streamCachedOnly, maxQuality, maxSizeGB };
}

export function streamMatchesDataSaver(row: StreamRow, settings: AppSettings): boolean {
  const caps = effectiveDataSaver(settings);
  if (caps.cachedOnly && row.cachedOn == null) return false;

  const maxOrder = maxQualityOrder(caps.maxQuality);
  if (
    maxOrder != null &&
    row.result.quality !== VideoQuality.unknown &&
    VideoQuality.sortOrder(row.result.quality) > maxOrder
  ) {
    return false;
  }

  const maxBytes = caps.maxSizeGB > 0 ? caps.maxSizeGB * 1024 * 1024 * 1024 : 0;
  if (maxBytes > 0 && row.result.sizeBytes > maxBytes) return false;

  return true;
}

export function filterStreamRows(rows: StreamRow[], settings: AppSettings): StreamRow[] {
  return rows.filter((row) => streamMatchesDataSaver(row, settings));
}

/** Collapse cross-indexer duplicates of the same torrent/file selection. A
 * single torrent can expose multiple explicit Stremio file indices, which are
 * different playable rows and must not collapse.
 * returned by several indexers, swamping the stream list with identical entries.
 * Keep one row per infoHash - the most useful variant (prefer a cached copy,
 * then more seeders) - preserving each release's first-seen slot. Pure +
 * automatic (no information is lost: it's the same torrent). */
export function dedupeStreamRows(rows: StreamRow[]): StreamRow[] {
  const bySelection = new Map<string, StreamRow>();
  const order: string[] = [];
  for (const row of rows) {
    const key = torrentResultSelectionKey(row.result);
    const existing = bySelection.get(key);
    if (existing == null) {
      bySelection.set(key, row);
      order.push(key);
    } else {
      bySelection.set(key, betterDuplicate(existing, row));
    }
  }
  return order.map((k) => bySelection.get(k)!);
}

/** Pick the more useful of two rows for the same torrent: a cached copy beats an
 * uncached one; otherwise the one with more seeders. */
function betterDuplicate(a: StreamRow, b: StreamRow): StreamRow {
  const aUsable = torrentResultHasUsableFileSelection(a.result);
  const bUsable = torrentResultHasUsableFileSelection(b.result);
  if (aUsable !== bUsable) return aUsable ? a : b;
  if ((a.cachedOn != null) !== (b.cachedOn != null)) {
    return a.cachedOn != null ? a : b;
  }
  return b.result.seeders > a.result.seeders ? b : a;
}

// MARK: - Episode matching

/** How a release title relates to a specific requested episode. */
type EpisodeMatch = "exact" | "pack" | "unknown" | "mismatch";

/** Classify a release title against a requested season/episode.
 *
 * Rules (uppercased title):
 * - `S02E05` / `S2 E5` / `S02.E05` / `2x05` → exact when both numbers match,
 *   otherwise mismatch.
 * - Season-only tags (`S02`, `SEASON 2`) → a season pack: right season keeps
 *   it as "pack", wrong season is a mismatch. A bare `COMPLETE` is a pack too.
 * - No recognizable tag → "unknown" (kept - some indexers strip tags).
 */
export function classifyRowForEpisode(
  row: StreamRow,
  season: number,
  episode: number,
): EpisodeMatch {
  const title = row.result.title.toUpperCase();
  // The exact-tag patterns live in services/debrid/models.ts (matchEpisodeTag)
  // so release ranking here and pack FILE-picking there can never diverge.
  const tag = matchEpisodeTag(title);
  if (tag != null) {
    return tag.season === season && tag.episode === episode ? "exact" : "mismatch";
  }
  const seasonOnly =
    title.match(/\bS(\d{1,2})\b/) ?? title.match(/\bSEASON[ ._-]?(\d{1,2})\b/);
  if (seasonOnly != null) {
    return parseInt(seasonOnly[1], 10) === season ? "pack" : "mismatch";
  }
  if (/\bCOMPLETE\b/.test(title)) return "pack";
  return "unknown";
}

/** Drop wrong-episode releases and stable-sort exact episode matches above
 * packs/untagged rows. No-op when no episode is requested (movies). */
export function filterAndRankForEpisode(
  rows: StreamRow[],
  season: number | null,
  episode: number | null,
): StreamRow[] {
  if (season == null || episode == null) return rows;
  return rows
    .map((row, index) => ({ row, index, match: classifyRowForEpisode(row, season, episode) }))
    .filter((entry) => entry.match !== "mismatch")
    .sort((a, b) => {
      const ka = a.match === "exact" ? 0 : 1;
      const kb = b.match === "exact" ? 0 : 1;
      return ka - kb || a.index - b.index;
    })
    .map((entry) => entry.row);
}

async function resolveStreams(
  imdbId: string,
  type: MediaType,
  season: number | null,
  episode: number | null,
  title: string | null,
  year: number | null,
  indexers: IndexerManager,
  debrid: DebridManager | null,
  signal?: AbortSignal,
  onResults?: (update: {
    rows: StreamRow[];
    sourceErrors: IndexerSearchError[];
  }) => void,
): Promise<{
  rows: StreamRow[];
  sourceErrors: IndexerSearchError[];
  allSourcesFailed: boolean;
}> {
  // Two complementary passes, merged: the imdb-based search (YTS/EZTV are
  // imdb-native) AND a title-based query - APIBay and other name-matching
  // indexers return nothing for a bare imdb id, so without this they never
  // contribute and a single dead imdb indexer (e.g. EZTV) empties every series.
  const query =
    title != null && title.trim().length > 0
      ? buildTitleQuery(title, season, episode)
      : null;
  const titleIndexers = query != null ? indexers.fork() : null;
  const [imdbPass, titlePass] = await Promise.all([
    // searchAll errors still surface (state.error); IndexerManager already
    // absorbs per-indexer failures internally, so a throw here is catastrophic.
    (indexers.searchAll as unknown as (
      imdbId: string,
      type: MediaType,
      season: number | null,
      episode: number | null,
      signal?: AbortSignal,
    ) => Promise<TorrentResult[]>)(imdbId, type, season, episode, signal).then(
      (results) => ({ results, errors: indexers.lastSearchErrors }),
    ),
    // The title pass is best-effort - a failure there must NOT empty the imdb
    // results, so it degrades to an empty set.
    query != null
      ? (titleIndexers!.searchByQuery as unknown as (
          query: string,
          type: MediaType,
          signal?: AbortSignal,
        ) => Promise<TorrentResult[]>)(query, type, signal)
          .then((results) => ({
            results,
            errors: titleIndexers!.lastSearchErrors,
          }))
          .catch((error) => ({
            results: [] as TorrentResult[],
            errors: [{ indexer: "Title search", error: errorMessage(error) }],
          }))
      : Promise.resolve({
          results: [] as TorrentResult[],
          errors: [] as IndexerSearchError[],
        }),
  ]);
  const sourceErrors = mergeIndexerErrors(imdbPass.errors, titlePass.errors);
  const activeCount = indexers.activeIndexers.length;
  const imdbAllFailed =
    activeCount > 0 && imdbPass.errors.length >= activeCount;
  const titleAllFailed =
    query == null ||
    (activeCount > 0 && titlePass.errors.length >= activeCount);
  const allSourcesFailed = imdbAllFailed && titleAllFailed;
  if (signal?.aborted) return { rows: [], sourceErrors, allSourcesFailed };
  // Fold the imdb-exact + loose title passes into one ranked, deduped set. The
  // combiner (shared with Server Mode) validates the title pass against the
  // requested title so the two modes can never diverge. The year is passed for
  // MOVIES only (combineStreamResults down-ranks wrong-year releases; episode
  // rips carry air/rip years that legitimately differ from a series' first-air
  // year, so the signal is meaningless there) - mirror media-runtime.js.
  const results = combineStreamResults(
    imdbPass.results,
    titlePass.results,
    title,
    type === "movie" ? year : null,
  );
  if (results.length === 0) {
    return { rows: [], sourceErrors, allSourcesFailed };
  }

  const preliminaryRows = filterAndRankForEpisode(
    dedupeStreamRows(
      results.map((result) => ({
        result,
        cachedOn: null,
        cacheStatus: "unavailable" as const,
      })),
    ),
    season,
    episode,
  );
  if (!signal?.aborted) {
    onResults?.({ rows: preliminaryRows, sourceErrors });
  }

  // Check cache across all configured debrid services for every infoHash.
  let cacheByHash: Record<string, MergedCacheEntry> = {};
  if (debrid != null && debrid.hasServices) {
    const hashes = results.map((r) => r.infoHash);
    try {
      const merged = await (debrid.checkCacheAll as unknown as (
        hashes: string[],
        signal?: AbortSignal,
      ) => ReturnType<DebridManager["checkCacheAll"]>)(hashes, signal);
      cacheByHash = merged;
    } catch {
      cacheByHash = {};
    }
  }

  return {
    rows: filterAndRankForEpisode(
      dedupeStreamRows(
        results.map((result) => {
          // checkCacheAll canonicalizes to lowercase; match it so a case
          // difference between the indexer hash and the provider's echo can't
          // make a cached torrent read as uncached.
          const entry = cacheByHash[result.infoHash.toLowerCase()];
          const cached = entry != null && CacheStatus.isCached(entry.status);
          return {
            result,
            cachedOn: cached ? entry.service : null,
            // A missing/unknown entry means the provider did not answer the
            // cache question. Do not mislabel that failure as confirmed uncached.
            cacheStatus: cached
              ? "cached" as const
              : entry?.status.kind === "notCached"
                ? "not_cached" as const
                : "unavailable" as const,
          };
        }),
      ),
      season,
      episode,
    ),
    sourceErrors,
    allSourcesFailed,
  };
}

function mergeIndexerErrors(
  ...groups: IndexerSearchError[][]
): IndexerSearchError[] {
  const seen = new Set<string>();
  const merged: IndexerSearchError[] = [];
  for (const error of groups.flat()) {
    const key = `${error.indexer}\u0000${error.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(error);
  }
  return merged;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const value = String(error);
  return value.length > 0 ? value : "Unknown error";
}

/** Resolve stream rows for a title. Returns an empty/idle state until both an
 * imdb id and at least one indexer are available. For series, pass the selected
 * season/episode so the search and ranking are episode-specific; movies pass
 * null/null. `year` is the item's release year when known - used to down-rank
 * (movies only) same-titled releases from a different year, e.g. The Odyssey
 * (2026) vs its 1997/2016 adaptations. `imdbIdPending` distinguishes metadata
 * that is still loading from a settled title that genuinely has no IMDb id. */
export function useStreams(
  imdbId: string | null,
  type: MediaType,
  season: number | null,
  episode: number | null,
  title: string | null,
  year: number | null,
  indexers: IndexerManager,
  debrid: DebridManager | null,
  imdbIdPending = false,
): StreamsState {
  const serverURL = configuredServerURL();
  const serverMode = serverURL != null;
  const hasIndexers = serverMode ? true : indexers.activeIndexers.length > 0;
  const hasDebrid = serverMode ? true : debrid != null && debrid.hasServices;
  const waitingForImdbId = imdbId == null && imdbIdPending && hasIndexers;
  const queryOwner = useMemo<StreamQueryOwner>(() => ({
    imdbId,
    type,
    season,
    episode,
    title,
    year,
    indexers,
    debrid,
    imdbIdPending,
    serverURL,
  }), [imdbId, type, season, episode, title, year, indexers, debrid, imdbIdPending, serverURL]);
  const initialState = (): StreamsState => ({
    ...EMPTY,
    hasIndexers,
    hasDebrid,
    loading: (imdbId != null && hasIndexers) || waitingForImdbId,
  });
  const [state, setState] = useState<StreamsState>(initialState);
  const ownerRef = useRef(queryOwner);
  const ownerChanged = !sameStreamQueryOwner(ownerRef.current, queryOwner);
  if (ownerChanged) ownerRef.current = queryOwner;
  const commitState = useCallback(
    (next: StreamsState | ((current: StreamsState) => StreamsState)) => {
      if (!sameStreamQueryOwner(ownerRef.current, queryOwner)) return;
      setState(next);
    },
    [queryOwner],
  );

  const run = useCallback(
    async (signal: AbortSignal) => {
      if (imdbId == null || !hasIndexers) {
        // HONEST idle: a null imdb id means NO search ever ran - say so instead
        // of letting the UI render the generic "No streams found".
        commitState({
          ...EMPTY,
          hasIndexers,
          hasDebrid,
          missingImdbId: imdbId == null && !imdbIdPending,
          loading: waitingForImdbId,
        });
        return;
      }
      commitState((s) => ({
        ...s,
        rows: [],
        loading: true,
        phase: "searching_sources",
        error: null,
        hasIndexers,
        hasDebrid,
      }));
      try {
        if (serverMode) {
          const remote = await fetchServerStreams({
            imdbId,
            type,
            season,
            episode,
            title,
            year,
            signal,
            onPhase: (phase, partial) => {
              if (phase !== "sources" || signal.aborted) return;
              commitState({
                rows: filterAndRankForEpisode(
                  dedupeStreamRows(partial.rows),
                  season,
                  episode,
                ),
                loading: true,
                phase: "checking_availability",
                error: null,
                hasIndexers: partial.hasIndexers,
                hasDebrid: partial.hasDebrid,
                missingImdbId: false,
                sourceErrors: partial.sourceErrors ?? [],
              });
            },
          });
          if (!signal.aborted) {
            commitState({
              rows: filterAndRankForEpisode(
                dedupeStreamRows(remote.rows),
                season,
                episode,
              ),
              loading: false,
              phase: "ready",
              error: null,
              hasIndexers: remote.hasIndexers,
              hasDebrid: remote.hasDebrid,
              missingImdbId: false,
              sourceErrors: remote.sourceErrors ?? [],
            });
          }
          return;
        }
        const resolved = await resolveStreams(
          imdbId,
          type,
          season,
          episode,
          title,
          year,
          indexers,
          debrid,
          signal,
          ({ rows, sourceErrors }) => {
            if (signal.aborted) return;
            commitState({
              rows,
              loading: true,
              phase: "checking_availability",
              error: null,
              hasIndexers,
              hasDebrid,
              missingImdbId: false,
              sourceErrors,
            });
          },
        );
        const { rows, sourceErrors, allSourcesFailed } = resolved;
        if (
          rows.length === 0 &&
          allSourcesFailed
        ) {
          // EVERY source failed - that's an outage, not "no results". Surface a
          // real error instead of the misleading empty state (silent P0).
          const detail = sourceErrors
            .map((e) => `${e.indexer}: ${e.error}`)
            .join(" · ");
          throw new Error(`Couldn't reach any source - ${detail}`);
        }
        if (!signal.aborted) {
          commitState({
            rows,
            loading: false,
            phase: "ready",
            error: null,
            hasIndexers,
            hasDebrid,
            missingImdbId: false,
            sourceErrors,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!signal.aborted) {
          commitState({
            rows: [],
            loading: false,
            phase: "ready",
            error: message,
            hasIndexers,
            hasDebrid,
            missingImdbId: false,
            sourceErrors: [],
          });
        }
      }
    },
    [imdbId, type, season, episode, title, year, indexers, debrid, imdbIdPending, hasIndexers, hasDebrid, serverMode, waitingForImdbId, commitState],
  );

  useEffect(() => {
    const controller = new AbortController();
    void run(controller.signal);
    return () => {
      controller.abort();
    };
  }, [run]);

  return ownerChanged ? initialState() : state;
}
