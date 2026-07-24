// Port of Sources/DebridStreamer/Services/Metadata/TMDBService.swift.
//
// A fetch-based TMDB metadata provider. Mirrors the Swift actor's behavior:
// the same API paths/params, the toMediaPreview/toMediaItem mapping (incl.
// backdropPath and the imdb-id-vs-tmdb-id logic), and a bounded TTL response
// cache keyed by `path + sorted query params` (short TTL for catalog reads,
// 24h for the static genre list). The `fetch` implementation is injectable so
// tests can stub the network (the Swift code injects a URLSession instead).

import {
  type CastMember,
  type Episode,
  makeCastMember,
  type MediaItem,
  type MediaPreview,
  type MediaType,
  MediaType as MediaTypeNS,
  type Season,
} from "../../models/media";
import {
  type DiscoverFilters,
  type ExternalIds,
  type Genre,
  type MediaCategory,
  type MetadataProvider,
  type MetadataSearchResult,
  TMDBError,
  type TrendingWindow,
} from "./types";
import { assertNetworkAllowed } from "../../lib/networkPolicy";

// MARK: - Raw TMDB response shapes (snake_case as the API returns them).
//
// The Swift code relies on JSONDecoder's convertFromSnakeCase. In TS we decode
// from the raw snake_case JSON explicitly, keeping the mapping in one place.

interface RawPagedResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

interface RawSearchResult {
  id: number;
  title?: string | null;
  name?: string | null;
  media_type?: string | null;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number | null;
  genre_ids?: number[] | null;
}

interface RawGenre {
  id: number;
  name: string;
}

interface RawExternalIds {
  imdb_id?: string | null;
  tvdb_id?: number | null;
}

// /movie/{id}/release_dates - per-country release dates, each carrying a
// certification (the configured region is what `getCertification` reads).
interface RawReleaseDates {
  results: Array<{
    iso_3166_1: string;
    release_dates: Array<{ certification?: string | null }>;
  }>;
}

// /tv/{id}/content_ratings - per-country TV content rating.
interface RawContentRatings {
  results: Array<{ iso_3166_1: string; rating?: string | null }>;
}

// US maturity ranking, mirroring the server's MATURITY_RANK ladder. Used only to
// pick the MOST RESTRICTIVE certification when a movie carries several - the
// server remains the authority for the cap comparison.
const CERT_RANK: Readonly<Record<string, number>> = {
  G: 0,
  PG: 1,
  "PG-13": 2,
  R: 3,
  "NC-17": 4,
};

/** The strictest certification among a title's regional certs. An unrecognized cert
 * outranks all known ones (returned as-is) so the server fail-closes on it;
 * an empty list yields null. */
function strictestCertification(certs: string[]): string | null {
  if (certs.length === 0) return null;
  let best: string | null = null;
  let bestRank = -1;
  for (const cert of certs) {
    const rank = CERT_RANK[cert.toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
    if (rank > bestRank) {
      bestRank = rank;
      best = cert;
    }
  }
  return best;
}

interface RawDetailResponse {
  id: number;
  title?: string | null;
  name?: string | null;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  vote_average?: number | null;
  runtime?: number | null;
  episode_run_time?: number[] | null;
  status?: string | null;
  genres?: RawGenre[] | null;
  external_ids?: RawExternalIds | null;
}

interface RawCredits {
  cast: RawCastMember[];
}

interface RawVideos {
  results: RawVideo[];
}
interface RawVideo {
  key?: string | null;
  site?: string | null;
  type?: string | null;
  official?: boolean | null;
  name?: string | null;
}

interface RawCastMember {
  id: number;
  name: string;
  character?: string | null;
  profile_path?: string | null;
}

interface RawGenresResponse {
  genres: RawGenre[];
}

interface RawTVDetailResponse {
  id: number;
  seasons?: RawSeason[] | null;
}

interface RawSeason {
  id: number;
  season_number: number;
  name: string;
  overview?: string | null;
  poster_path?: string | null;
  episode_count: number;
  air_date?: string | null;
}

interface RawSeasonResponse {
  episodes: RawEpisode[];
}

interface RawEpisode {
  id: number;
  episode_number: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  still_path?: string | null;
  runtime?: number | null;
}

interface RawFindResponse {
  movie_results: RawSearchResult[];
  tv_results: RawSearchResult[];
}

/** A movie release date from TMDB's now-playing or upcoming catalog. The
 * catalog endpoint supplies a primary release date, which is the best
 * date-level signal available without fanning out into one request per movie
 * for territory-specific release windows. */
export interface MovieRelease {
  movie: MediaPreview;
  releaseDate: string;
  source: "now_playing" | "upcoming";
}

// MARK: - Mappers (mirror toMediaPreview / toMediaItem)

/** Parse a leading 4-digit year from a TMDB date string. Mirrors the Swift
 * `dateStr.flatMap { ... prefix(4) }` (requires length >= 4). */
function parseYear(dateStr: string | null | undefined): number | null {
  if (!dateStr || dateStr.length < 4) return null;
  const parsed = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Mirrors `TMDBSearchResult.toMediaPreview()`. Returns null for person results
 * and entries with no title (compactMap drops them). */
function toMediaPreview(r: RawSearchResult): MediaPreview | null {
  const displayTitle = r.title ?? r.name ?? "";
  if (displayTitle.length === 0) return null;

  let type: MediaType;
  if (r.media_type != null) {
    switch (r.media_type) {
      case "movie":
        type = MediaTypeNS.movie;
        break;
      case "tv":
        type = MediaTypeNS.series;
        break;
      default:
        return null; // Skip "person" etc.
    }
  } else {
    type = r.title != null ? MediaTypeNS.movie : MediaTypeNS.series;
  }

  const year = parseYear(r.release_date ?? r.first_air_date);

  return {
    id: `tmdb-${r.id}`,
    type,
    title: displayTitle,
    year,
    posterPath: r.poster_path ?? null,
    imdbRating: r.vote_average ?? null,
    tmdbId: r.id,
    backdropPath: r.backdrop_path ?? null,
  };
}

/** Mirrors `TMDBDetailResponse.toMediaItem(type:)`. */
function toMediaItem(r: RawDetailResponse, type: MediaType): MediaItem {
  const displayTitle = r.title ?? r.name ?? "Unknown";
  const year = parseYear(r.release_date ?? r.first_air_date);

  const imdbId = r.external_ids?.imdb_id;
  const itemId = imdbId && imdbId.length > 0 ? imdbId : `tmdb-${r.id}`;

  let displayRuntime: number | null;
  if (r.runtime != null && r.runtime > 0) {
    displayRuntime = r.runtime;
  } else if (
    r.episode_run_time &&
    r.episode_run_time.length > 0 &&
    r.episode_run_time[0] > 0
  ) {
    displayRuntime = r.episode_run_time[0];
  } else {
    displayRuntime = null;
  }

  return {
    id: itemId,
    type,
    title: displayTitle,
    year,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    overview: r.overview ?? null,
    genres: r.genres?.map((g) => g.name) ?? [],
    imdbRating: r.vote_average ?? null,
    runtime: displayRuntime,
    status: r.status ?? null,
    tmdbId: r.id,
    lastFetched: new Date().toISOString(),
  };
}

// MARK: - TTL response cache

interface CacheEntry {
  expiresAt: number; // epoch ms
  value: unknown;
}

/** Injectable fetch signature (a subset of the DOM `fetch`). */
export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export class TMDBService implements MetadataProvider {
  private readonly apiKey: string;
  private readonly baseURL = "https://api.themoviedb.org/3";
  private readonly fetchImpl: FetchImpl;
  private readonly language: string;
  private readonly region: string;

  // Bounded TTL cache of already-DECODED read responses, keyed by
  // `path + sorted query params`. Only successful reads are cached - errors
  // are never stored, so a failure is always retried.
  private responseCache = new Map<string, CacheEntry>();
  /** Identical reads that begin before the TTL cache is populated share work. */
  private inFlight = new Map<string, Promise<unknown>>();
  private readonly cacheCapacity = 256;

  /** Short TTL for volatile catalog reads (search/trending/category/discover/
   * detail/seasons/episodes/cast/recommendations). 5 minutes, in ms. */
  static readonly shortTTL = 60 * 5 * 1000;
  /** Long TTL for the effectively-static genre list. 24 hours, in ms. */
  static readonly longTTL = 60 * 60 * 24 * 1000;

  constructor(
    apiKey: string,
    fetchImpl?: FetchImpl,
    locale: { language?: string; region?: string } = {},
  ) {
    this.apiKey = apiKey;
    this.language = locale.language ?? "en-US";
    this.region = locale.region ?? "US";
    // Default to the global fetch; tests inject a stub. Bind so `this` inside
    // the platform fetch stays correct.
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
  }

  /** Returns a cached value if present and unexpired; otherwise runs `produce`,
   * stores it under the TTL, and returns it. Only the success path caches, so
   * a throwing `produce` is never memoized. Mirrors Swift `cached`. */
  private async cached<T>(
    key: string,
    ttl: number,
    produce: () => Promise<T>,
  ): Promise<T> {
    const entry = this.responseCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T;
    }
    const pending = this.inFlight.get(key);
    if (pending != null) return pending as Promise<T>;

    const request = produce()
      .then((value) => {
        this.store(key, value, ttl);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  /** Inserts into the bounded cache: expired entries are swept first, then the
   * soonest-to-expire entries are evicted if the cap is reached. Mirrors
   * Swift `store`. */
  private store(key: string, value: unknown, ttl: number): void {
    const now = Date.now();
    for (const [k, v] of this.responseCache) {
      if (v.expiresAt <= now) this.responseCache.delete(k);
    }
    if (this.responseCache.size >= this.cacheCapacity) {
      const overflow = this.responseCache.size - (this.cacheCapacity - 1);
      const victims = [...this.responseCache.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, overflow)
        .map(([k]) => k);
      for (const victim of victims) this.responseCache.delete(victim);
    }
    this.responseCache.set(key, { expiresAt: now + ttl, value });
  }

  /** Stable cache key from a path plus its sorted query params. Mirrors Swift
   * `cacheKey`. */
  private cacheKey(path: string, params: Record<string, string>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${path}?${sorted}`;
  }

  // MARK: - MetadataProvider

  async search(
    query: string,
    type: MediaType | null,
    page = 1,
  ): Promise<MetadataSearchResult> {
    const path = type != null ? `/search/${MediaTypeNS.tmdbPath(type)}` : "/search/multi";

    const params: Record<string, string> = {
      query,
      page: String(page),
      include_adult: "false",
      language: this.language,
      region: this.region,
    };

    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, params);
      return this.pagedToResult(response);
    });
  }

  async getDetail(id: string, type: MediaType): Promise<MediaItem> {
    // If the ID is a TMDB numeric ID, use it directly. Otherwise extract from
    // "tmdb-{id}", or resolve an IMDB ID via /find first.
    let tmdbId: string;
    if (id.startsWith("tmdb-")) {
      tmdbId = id.slice(5);
    } else if (id.length > 0 && /^[0-9]+$/.test(id)) {
      tmdbId = id;
    } else {
      const found = await this.findByImdbId(id, type);
      if (found == null) throw TMDBError.notFound(id);
      tmdbId = String(found);
    }

    const path = `/${MediaTypeNS.tmdbPath(type)}/${tmdbId}`;
    // credits are fetched separately by getCast, so only request external_ids.
    const params = {
      append_to_response: "external_ids",
      language: this.language,
    };

    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawDetailResponse>(path, params);
      return toMediaItem(response, type);
    });
  }

  async getTrending(
    type: MediaType,
    timeWindow: TrendingWindow = "week",
    page = 1,
  ): Promise<MetadataSearchResult> {
    const path = `/trending/${MediaTypeNS.tmdbPath(type)}/${timeWindow}`;
    const params = { page: String(page), language: this.language };

    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, params);
      return this.pagedToResult(response);
    });
  }

  async getCategory(
    category: MediaCategory,
    type: MediaType,
    page = 1,
  ): Promise<MetadataSearchResult> {
    const path = `/${MediaTypeNS.tmdbPath(type)}/${category}`;
    const params = {
      page: String(page),
      language: this.language,
      region: this.region,
    };

    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, params);
      return this.pagedToResult(response);
    });
  }

  /**
   * Release-dated movie rows for calendar surfaces. This intentionally reads
   * only the first now-playing and upcoming pages: two cached catalog requests
   * give the calendar a useful recent and near-future cadence without a detail
   * or release-dates request for every movie.
   */
  async getMovieReleaseCalendar(): Promise<MovieRelease[]> {
    const fetchCategory = async (
      source: MovieRelease["source"],
    ): Promise<MovieRelease[]> => {
      const path = `/movie/${source}`;
      const params = {
        page: "1",
        language: this.language,
        region: this.region,
      };
      const response = await this.cached(
        this.cacheKey(path, params),
        TMDBService.shortTTL,
        () => this.request<RawPagedResponse<RawSearchResult>>(path, params),
      );
      // Guard against a non-standard/error response (TMDB unreachable, missing
      // key, rate limited) so the calendar degrades to its honest empty/error
      // state instead of throwing on `.results` being undefined.
      const rows = Array.isArray(response?.results) ? response.results : [];
      return rows.flatMap((raw) => {
        const movie = toMediaPreview(raw);
        const releaseDate = raw.release_date;
        if (
          movie == null ||
          movie.type !== MediaTypeNS.movie ||
          releaseDate == null ||
          !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
        ) {
          return [];
        }
        return [{ movie, releaseDate, source }];
      });
    };

    const results = await Promise.allSettled([
      fetchCategory("now_playing"),
      fetchCategory("upcoming"),
    ]);
    const releases = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (releases.length === 0) {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure != null) throw failure.reason;
    }

    // A movie can move between both category endpoints around its release day.
    // Keep one date per title, preferring the upcoming source for an exact tie.
    const unique = new Map<string, MovieRelease>();
    for (const release of releases) {
      const current = unique.get(release.movie.id);
      if (
        current == null ||
        release.releaseDate < current.releaseDate ||
        (release.releaseDate === current.releaseDate && release.source === "upcoming")
      ) {
        unique.set(release.movie.id, release);
      }
    }
    return [...unique.values()].sort((a, b) =>
      a.releaseDate === b.releaseDate
        ? a.movie.title.localeCompare(b.movie.title)
        : a.releaseDate.localeCompare(b.releaseDate),
    );
  }

  async discover(
    type: MediaType,
    filters: DiscoverFilters,
  ): Promise<MetadataSearchResult> {
    const path = `/discover/${MediaTypeNS.tmdbPath(type)}`;
    const params: Record<string, string> = {
      page: String(filters.page),
      sort_by: filters.sortBy,
      language: this.language,
      region: this.region,
      include_adult: "false",
    };
    if (filters.genreId != null) {
      params.with_genres = String(filters.genreId);
    }
    if (filters.year != null) {
      if (type === "movie") {
        params.primary_release_year = String(filters.year);
      } else {
        params.first_air_date_year = String(filters.year);
      }
    }
    if (filters.minRating != null) {
      params["vote_average.gte"] = String(filters.minRating);
      params["vote_count.gte"] = "100";
    }

    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, params);
      return this.pagedToResult(response);
    });
  }

  /** Like `discover`, but takes the full raw `/discover` query-param map so the
   * advanced Browse filter slideover can use TMDB params beyond the core
   * `DiscoverFilters` (multi-genre, year range, vote_count, runtime, original
   * language). Additive - the Discover screen still uses `discover()`. `api_key`
   * is appended by `request`; pass everything else (page/sort_by/language/…). */
  async discoverWithParams(
    type: MediaType,
    params: Record<string, string>,
  ): Promise<MetadataSearchResult> {
    const path = `/discover/${MediaTypeNS.tmdbPath(type)}`;
    const localized = {
      language: this.language,
      region: this.region,
      ...params,
    };
    return this.cached(this.cacheKey(path, localized), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, localized);
      return this.pagedToResult(response);
    });
  }

  async getGenres(type: MediaType): Promise<Genre[]> {
    const path = `/genre/${MediaTypeNS.tmdbPath(type)}/list`;
    const params = { language: this.language };
    return this.cached(this.cacheKey(path, params), TMDBService.longTTL, async () => {
      const response = await this.request<RawGenresResponse>(path, params);
      return response.genres.map((g) => ({ id: g.id, name: g.name }));
    });
  }

  async getSeasons(tmdbId: number): Promise<Season[]> {
    const path = `/tv/${tmdbId}`;
    const params = { language: this.language };
    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawTVDetailResponse>(path, params);
      return (response.seasons ?? []).map((s) => ({
        id: s.id,
        seasonNumber: s.season_number,
        name: s.name,
        overview: s.overview ?? null,
        posterPath: s.poster_path ?? null,
        episodeCount: s.episode_count,
        airDate: s.air_date ?? null,
      }));
    });
  }

  async getEpisodes(tmdbId: number, season: number): Promise<Episode[]> {
    const path = `/tv/${tmdbId}/season/${season}`;
    const params = { language: this.language };
    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawSeasonResponse>(path, params);
      return response.episodes.map((ep) => ({
        id: `${tmdbId}-s${season}e${ep.episode_number}`,
        mediaId: `tmdb-${tmdbId}`,
        seasonNumber: season,
        episodeNumber: ep.episode_number,
        title: ep.name ?? null,
        overview: ep.overview ?? null,
        airDate: ep.air_date ?? null,
        stillPath: ep.still_path ?? null,
        runtime: ep.runtime ?? null,
      }));
    });
  }

  async getExternalIds(tmdbId: number, type: MediaType): Promise<ExternalIds> {
    const path = `/${MediaTypeNS.tmdbPath(type)}/${tmdbId}/external_ids`;
    return this.cached(this.cacheKey(path, {}), TMDBService.shortTTL, async () => {
      const raw = await this.request<RawExternalIds>(path, {});
      return { imdbId: raw.imdb_id ?? null, tvdbId: raw.tvdb_id ?? null };
    });
  }

  async getCast(tmdbId: number, type: MediaType): Promise<CastMember[]> {
    const path = `/${MediaTypeNS.tmdbPath(type)}/${tmdbId}/credits`;
    const params = { language: this.language };
    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawCredits>(path, params);
      return response.cast.map((c) =>
        makeCastMember(c.id, c.name, c.character ?? "", c.profile_path),
      );
    });
  }

  /** The YouTube key of the best official trailer (prefer official Trailer, then
   * any Trailer, then a Teaser), or null when TMDB has no usable YouTube video.
   * Cached with the short TTL. */
  async getTrailer(tmdbId: number, type: MediaType): Promise<string | null> {
    const path = `/${MediaTypeNS.tmdbPath(type)}/${tmdbId}/videos`;
    const params = { language: this.language };
    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawVideos>(path, params);
      const yt = response.results.filter(
        (v) =>
          v.site === "YouTube" && typeof v.key === "string" && v.key.length > 0,
      );
      const pick =
        yt.find((v) => v.type === "Trailer" && v.official === true) ??
        yt.find((v) => v.type === "Trailer") ??
        yt.find((v) => v.type === "Teaser" && v.official === true) ??
        yt.find((v) => v.type === "Teaser") ??
        yt[0];
      return pick?.key ?? null;
    });
  }

  async getRecommendations(
    tmdbId: number,
    type: MediaType,
  ): Promise<MediaPreview[]> {
    const path = `/${MediaTypeNS.tmdbPath(type)}/${tmdbId}/recommendations`;
    const params = { language: this.language, page: "1" };
    return this.cached(this.cacheKey(path, params), TMDBService.shortTTL, async () => {
      const response = await this.request<RawPagedResponse<RawSearchResult>>(path, params);
      return response.results
        .map(toMediaPreview)
        .filter((p): p is MediaPreview => p !== null);
    });
  }

  /** The regional maturity certification for a title, or null when TMDB has none.
   * Movies read `/movie/{id}/release_dates` (the first non-empty US
   * certification); series read `/tv/{id}/content_ratings`.
   * Cached with the long TTL - certifications effectively never change. The
   * server's kid play-block treats a null return as "unknown" → fail-closed. */
  async getCertification(
    tmdbId: number,
    type: MediaType,
    region = this.region,
  ): Promise<string | null> {
    if (type === "movie") {
      const path = `/movie/${tmdbId}/release_dates`;
      return this.cached(this.cacheKey(path, {}), TMDBService.longTTL, async () => {
        const response = await this.request<RawReleaseDates>(path, {});
        const regional = response.results.find((r) => r.iso_3166_1 === region);
        if (regional == null) return null;
        // A title can carry multiple regional certifications (theatrical R, edited-for-TV
        // PG-13, an NC-17 director's cut, …) across its release_dates, in no
        // guaranteed order. Return the MOST RESTRICTIVE so the kid play-block stays
        // fail-safe - an unrecognized cert ranks highest so it blocks rather than
        // slips through.
        const certs = regional.release_dates
          .map((d) => d.certification)
          .filter((c): c is string => c != null && c.trim().length > 0)
          .map((c) => c.trim());
        return strictestCertification(certs);
      });
    }
    const path = `/tv/${tmdbId}/content_ratings`;
    return this.cached(this.cacheKey(path, {}), TMDBService.longTTL, async () => {
      const response = await this.request<RawContentRatings>(path, {});
      const regional = response.results.find((r) => r.iso_3166_1 === region);
      const rating = regional?.rating;
      return rating != null && rating.trim().length > 0 ? rating.trim() : null;
    });
  }

  // MARK: - Find by IMDB ID

  async findByImdbId(imdbId: string, type: MediaType): Promise<number | null> {
    const path = `/find/${imdbId}`;
    const params = { external_source: "imdb_id" };
    const response = await this.request<RawFindResponse>(path, params);
    if (type === "movie") {
      return response.movie_results[0]?.id ?? null;
    }
    return response.tv_results[0]?.id ?? null;
  }

  // MARK: - Helpers

  /** Mirrors the repeated `MetadataSearchResult(items: results.compactMap...)`. */
  private pagedToResult(
    response: RawPagedResponse<RawSearchResult>,
  ): MetadataSearchResult {
    const items = response.results
      .map(toMediaPreview)
      .filter((p): p is MediaPreview => p !== null);
    return {
      items,
      page: response.page,
      totalPages: response.total_pages,
      totalResults: response.total_results,
    };
  }

  // MARK: - HTTP

  private async request<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    assertNetworkAllowed("metadata", "TMDB");
    const url = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.append(k, v);
    }
    url.searchParams.append("api_key", this.apiKey);

    const response = await this.fetchImpl(url.toString());
    const status = response.status;

    if (!(status >= 200 && status <= 299)) {
      if (status === 401) throw TMDBError.unauthorized();
      if (status === 404) throw TMDBError.notFound(path);
      if (status === 429) throw TMDBError.rateLimited();
      const body = await response.text().catch(() => "");
      throw TMDBError.httpError(status, body);
    }

    const text = await response.text();
    return JSON.parse(text) as T;
  }
}
