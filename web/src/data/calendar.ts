// Calendar data layer - release-dated episodes and movies.
//
// Followed series contribute bounded episode air dates for the app-wide
// NavRail indicator. The Calendar screen additionally loads TMDB's now-playing
// and upcoming movie pages only when that route is mounted.

import { useEffect, useMemo, useState } from "react";
import type { MediaPreview } from "../models/media";
import type { UpcomingEpisode } from "../lib/metadata";
import {
  getUpcomingEpisodesForSeries,
  localISODate,
  MAX_CALENDAR_SERIES,
} from "../lib/metadata";
import type { MovieRelease, TMDBService } from "../services/metadata/TMDBService";
import { getStore } from "../storage";
import {
  fetchServerMovieReleases,
  fetchServerUpcomingEpisodes,
} from "../lib/serverApi";
import { isServerMode } from "../lib/serverMode";

/** Keep enough history to make the month view useful without turning it into a
 * full series archive. TMDB's movie catalog supplies recent and near-future
 * release dates independently. */
const CALENDAR_RECENT_DAYS = 14;

export interface CalendarEntry {
  id: string;
  date: string;
  media: MediaPreview;
  kind: "episode" | "movie";
  /** A short, display-ready secondary label. */
  detail: string;
  /** Distinguishes TMDB's now-playing and upcoming movie catalog rows. */
  source?: "now_playing" | "upcoming";
}

/** A date-keyed group of upcoming episodes, retained for callers that need the
 * compact agenda buckets. The calendar screen itself uses CalendarEntry dates. */
export interface CalendarGroup {
  bucket: "today" | "week" | "later";
  label: string;
  episodes: UpcomingEpisode[];
}

export interface CalendarState {
  entries: CalendarEntry[];
  /** Raw followed-series episodes retained for the in-app new-release indicator. */
  episodes: UpcomingEpisode[];
  /** Legacy compact agenda data, kept in sync with episode entries. */
  groups: CalendarGroup[];
  loading: boolean;
  error: string | null;
  /** Whether the user follows any TV series in library/watchlist. */
  hasSeries: boolean;
  /** Whether a TMDB-backed source is available. */
  hasTMDB: boolean;
}

/** Movie releases are intentionally route-local: they are not needed for the
 * NavRail episode badge, so fetching them at application boot wastes network
 * and CPU on every other screen. */
export interface MovieReleaseCalendarState {
  releases: MovieRelease[];
  loading: boolean;
  error: string | null;
  hasTMDB: boolean;
}

/** Collect the unique TV series across favorites + watchlist from the Store. */
export async function collectSeries(): Promise<MediaPreview[]> {
  const store = getStore();
  const [favorites, watchlist] = await Promise.all([
    store.listLibrary("favorites").catch(() => []),
    store.listWatchlist().catch(() => []),
  ]);
  // Both stores persist addedAt and return newest-first, but sort the merged
  // sources again so a newer watchlist entry outranks an older favorite. The
  // string fallback keeps imported legacy rows stable if addedAt is absent.
  const records = [...favorites, ...watchlist].sort((a, b) =>
    String(b.addedAt ?? "").localeCompare(String(a.addedAt ?? "")),
  );
  const seen = new Set<string>();
  return records
    .map((record) => record.preview)
    .filter((preview) => {
      if (preview.type !== "series" || seen.has(preview.id)) return false;
      seen.add(preview.id);
      return true;
    })
    .slice(0, MAX_CALENDAR_SERIES);
}

/** Bucket + label episodes into Today / This week / Later. `now` is injectable
 * for testing. Pure. */
export function groupEpisodes(
  episodes: UpcomingEpisode[],
  now: number = Date.now(),
): CalendarGroup[] {
  const today = localISODate(now);
  const weekEnd = localISODate(now + 7 * 24 * 60 * 60 * 1000);
  const todayEps: UpcomingEpisode[] = [];
  const weekEps: UpcomingEpisode[] = [];
  const laterEps: UpcomingEpisode[] = [];

  for (const episode of episodes) {
    if (episode.airDate < today) continue;
    if (episode.airDate === today) todayEps.push(episode);
    else if (episode.airDate <= weekEnd) weekEps.push(episode);
    else laterEps.push(episode);
  }

  const groups: CalendarGroup[] = [];
  if (todayEps.length > 0) groups.push({ bucket: "today", label: "Today", episodes: todayEps });
  if (weekEps.length > 0) groups.push({ bucket: "week", label: "This week", episodes: weekEps });
  if (laterEps.length > 0) groups.push({ bucket: "later", label: "Upcoming", episodes: laterEps });
  return groups;
}

/** Followed episodes that aired after a calendar visit and no later than now.
 * Air dates are date-only in TMDB, so they are compared at the start of the
 * user's local air-date. Invalid dates are ignored rather than rolling into a
 * different month. Pure and bounded by the calendar's episode fetch. */
export function episodesAiredSince(
  episodes: readonly UpcomingEpisode[],
  lastSeenAt: number,
  now: number = Date.now(),
): UpcomingEpisode[] {
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(now) || now < lastSeenAt) {
    return [];
  }
  return episodes.filter((episode) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(episode.airDate);
    if (match == null) return false;
    const [, year, month, day] = match;
    const airDate = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      airDate.getFullYear() !== Number(year) ||
      airDate.getMonth() !== Number(month) - 1 ||
      airDate.getDate() !== Number(day)
    ) {
      return false;
    }
    const airedAt = airDate.getTime();
    return airedAt > lastSeenAt && airedAt <= now;
  });
}

function episodeCode(episode: UpcomingEpisode): string {
  return `S${String(episode.seasonNumber).padStart(2, "0")}E${String(
    episode.episodeNumber,
  ).padStart(2, "0")}`;
}

/** Convert raw scheduled data into date-sorted, deduplicated calendar entries. */
export function calendarEntries(
  episodes: UpcomingEpisode[],
  movieReleases: MovieRelease[],
): CalendarEntry[] {
  const entries: CalendarEntry[] = [
    ...episodes.map((episode) => ({
      id: `episode:${episode.series.id}:${episode.seasonNumber}:${episode.episodeNumber}:${episode.airDate}`,
      date: episode.airDate,
      media: episode.series,
      kind: "episode" as const,
      detail: [episodeCode(episode), episode.title].filter(Boolean).join(" · "),
    })),
    ...movieReleases.map((release) => ({
      id: `movie:${release.movie.id}:${release.releaseDate}`,
      date: release.releaseDate,
      media: release.movie,
      kind: "movie" as const,
      detail: release.source === "upcoming" ? "Movie release · Upcoming" : "Movie release · Now playing",
      source: release.source,
    })),
  ];
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) =>
      a.date === b.date
        ? a.media.title.localeCompare(b.media.title)
        : a.date.localeCompare(b.date),
    );
}

/** Resolve the app-wide, badge-relevant episode calendar for saved series. */
const EMPTY_SERIES_SIGNATURE = "";

export function useCalendar(
  tmdb: TMDBService | null,
  seriesWatchlistSignature: string = EMPTY_SERIES_SIGNATURE,
  refreshKey = 0,
  enabled = true,
): CalendarState {
  const serverMode = isServerMode();
  const hasTMDB = tmdb != null || serverMode;
  const disabledState = useMemo<CalendarState>(() => ({
    entries: [],
    episodes: [],
    groups: [],
    loading: false,
    error: null,
    hasSeries: false,
    hasTMDB,
  }), [hasTMDB]);
  const [state, setState] = useState<CalendarState>({
    entries: [],
    episodes: [],
    groups: [],
    loading: enabled,
    error: null,
    hasSeries: false,
    hasTMDB,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState(disabledState);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      setState((current) => ({
        ...current,
        loading: true,
        error: null,
        hasTMDB: tmdb != null || serverMode,
      }));
      let hasSeries = false;
      try {
        const series = await collectSeries();
        hasSeries = series.length > 0;
        if (cancelled) return;
        if (tmdb == null && !serverMode) {
          setState({
            entries: [],
            episodes: [],
            groups: [],
            loading: false,
            error: null,
            hasSeries,
            hasTMDB: false,
          });
          return;
        }

        const episodesPromise =
          series.length === 0
            ? Promise.resolve([] as UpcomingEpisode[])
            : serverMode
              ? fetchServerUpcomingEpisodes(series)
              : getUpcomingEpisodesForSeries(series, tmdb, Date.now(), CALENDAR_RECENT_DAYS);
        const episodes = await episodesPromise;
        if (cancelled) return;
        setState({
          entries: calendarEntries(episodes, []),
          episodes,
          groups: groupEpisodes(episodes),
          loading: false,
          error: null,
          hasSeries,
          hasTMDB: true,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          entries: [],
          episodes: [],
          groups: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          hasSeries: false,
          hasTMDB: tmdb != null || serverMode,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [disabledState, enabled, tmdb, serverMode, seriesWatchlistSignature, refreshKey]);

  // Effects run after commit. Project the disabled contract during render so a
  // profile boundary cannot expose the previous profile's calendar for a frame.
  return enabled ? state : disabledState;
}

/** Load TMDB movie releases only while the Calendar route is mounted. */
export function useMovieReleaseCalendar(
  tmdb: TMDBService | null | undefined,
  refreshKey = 0,
): MovieReleaseCalendarState {
  const serverMode = isServerMode();
  const hasTMDB = tmdb != null || serverMode;
  const [state, setState] = useState<MovieReleaseCalendarState>({
    releases: [],
    loading: hasTMDB,
    error: null,
    hasTMDB,
  });

  useEffect(() => {
    let cancelled = false;
    if (!hasTMDB) {
      setState({ releases: [], loading: false, error: null, hasTMDB: false });
      return () => {
        cancelled = true;
      };
    }

    setState((current) => ({ ...current, loading: true, error: null, hasTMDB: true }));
    void (async () => {
      try {
        // Server Mode resolves this through its privacy-preserving TMDB broker,
        // so the browser never receives the household TMDB credential.
        const releases = serverMode
          ? await fetchServerMovieReleases()
          : tmdb == null || typeof tmdb.getMovieReleaseCalendar !== "function"
            ? []
            : await tmdb.getMovieReleaseCalendar();
        if (cancelled) return;
        setState({ releases, loading: false, error: null, hasTMDB: true });
      } catch (error) {
        if (cancelled) return;
        setState({
          releases: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          hasTMDB: true,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tmdb, serverMode, hasTMDB, refreshKey]);

  return state;
}
