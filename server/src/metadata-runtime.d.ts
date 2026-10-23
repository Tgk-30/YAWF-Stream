import type { AppDatabase } from "./db.js";
import type { ServerConfig } from "./types.js";

export type MediaType = "movie" | "series";
export type MediaCategory =
  | "popular"
  | "top_rated"
  | "now_playing"
  | "upcoming"
  | "airing_today"
  | "on_the_air";

/** Resolves the decrypted credential value for a provider, with profile-scoped
 *  credentials taking precedence over server-scoped. Returns null when unset or
 *  on a decrypt failure. */
export function effectiveCredentialValue(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  provider: string,
): string | null;

/** Maturity context for a profile. When `maturityMax` is set, catalog browse is
 *  curated to cert-capped, movie-only results. */
export interface MaturityAudience {
  isKid: boolean;
  maturityMax: string | null;
}

export function getServerDiscoverHome(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  audience?: MaturityAudience,
): Promise<unknown>;

export function searchServerMedia(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    query: string;
    type?: MediaType | null;
    page?: number;
  },
): Promise<unknown>;

export function getServerCategory(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    type: MediaType;
    category: "trending" | MediaCategory;
    page?: number;
  },
  audience?: MaturityAudience,
): Promise<unknown>;

export function discoverServerMedia(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    type: MediaType;
    params: Record<string, string>;
  },
  audience?: MaturityAudience,
): Promise<unknown>;

export function getServerGenres(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    type: MediaType;
  },
): Promise<unknown>;

export const MAX_CALENDAR_SERIES: 30;

export interface UpcomingEpisodeSeries {
  id: string;
  type: "series";
  title: string;
  tmdbId?: number | null;
}

export interface UpcomingEpisodeService {
  getSeasons(tmdbId: number): Promise<Array<{ seasonNumber: number }>>;
  getEpisodes(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<Array<{
    seasonNumber: number;
    episodeNumber: number;
    title?: string | null;
    airDate?: string | null;
  }>>;
}

export interface UpcomingEpisode<TSeries extends UpcomingEpisodeSeries = UpcomingEpisodeSeries> {
  series: TSeries;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string;
}

export function getUpcomingEpisodesForSeries<TSeries extends UpcomingEpisodeSeries>(
  seriesList: readonly TSeries[],
  service: UpcomingEpisodeService,
  now?: number,
): Promise<Array<UpcomingEpisode<TSeries>>>;

export function getServerUpcomingEpisodes(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    series: UpcomingEpisodeSeries[];
  },
): Promise<unknown>;

export function getServerMovieReleaseCalendar(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
): Promise<unknown>;

export function getServerDetail(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    id: string;
    type: MediaType;
  },
): Promise<unknown>;

/** Throws on TMDB/key failures - the /api/media/seasons route converts any
 *  rejection into a 503 ("Episode guide is unavailable right now."). */
export function getServerSeasons(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    tmdbId?: number;
    imdbId?: string;
  },
): Promise<unknown>;

/** Throws on TMDB/key failures - the /api/media/episodes route converts any
 *  rejection into a 503 ("Episode guide is unavailable right now."). */
export function getServerEpisodes(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  input: {
    tmdbId?: number;
    imdbId?: string;
    season: number;
  },
): Promise<unknown>;

/** The US maturity certification for a title (kid play-block). Returns null when
 *  the mediaId carries no derivable TMDB id; callers treat null as fail-closed. */
export function titleCertification(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
  mediaId: string,
  type: MediaType,
): Promise<string | null>;
