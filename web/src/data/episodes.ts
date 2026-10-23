// Episode-picker data layer.
//
// Loads a series' seasons and per-season episode lists - live via the shared
// TMDBService when configured (Local Mode) or the server metadata proxy
// (Server Mode), else a graceful `source: "none"` so the picker can fall back
// to a plain season/episode stepper. Also home to the pure episode-id helpers
// shared by Detail, StreamPicker labels, and continue-watching rows.
// Imports the ported TMDBService READ-ONLY.

import { useEffect, useState } from "react";
import type { Episode, Season } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import type { WatchHistoryRecord } from "../storage/models";
import { fetchServerEpisodes, fetchServerSeasons } from "../lib/serverApi";
import { isServerMode } from "../lib/serverMode";
import { CinemetaEpisodeService } from "../services/metadata/CinemetaEpisodeService";

// MARK: - Pure helpers

/** Canonical per-episode id used in storage keys: `s2e5` (no zero-pad).
 * Opaque downstream - only ever produced here and parsed by parseEpisodeId. */
export function episodeIdFor(season: number, episode: number): string {
  return `s${season}e${episode}`;
}

/** Parse an `s2e5` episode id back into numbers. Null for movies (null id)
 * and for unparseable/legacy ids. */
export function parseEpisodeId(
  id: string | null | undefined,
): { season: number; episode: number } | null {
  if (id == null) return null;
  const m = /^s(\d+)e(\d+)$/i.exec(id);
  if (m == null) return null;
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
}

/** Human label for an episode selection: "S2 E5". */
export function episodeLabel(season: number, episode: number): string {
  return `S${season} E${episode}`;
}

/** The episode after `current`, from TMDB season metadata.
 *  - Within a season: episode + 1.
 *  - At a season boundary: the lowest seasonNumber > current.season with
 *    seasonNumber !== 0 (never advance INTO specials) and episodeCount > 0 → E1.
 *  - After the finale: null.
 *  - seasons.length === 0 (no TMDB key / source "none"): blind within-season
 *    increment, NEVER crosses seasons - a past-the-finale target is harmless
 *    because auto-play requires a cached row and the picker's episode-scoped
 *    empty state is honest. */
export function nextEpisodeFor(
  current: { season: number; episode: number },
  seasons: Season[],
): { season: number; episode: number } | null {
  if (seasons.length === 0) {
    return { season: current.season, episode: current.episode + 1 };
  }
  const here = seasons.find((s) => s.seasonNumber === current.season);
  if (here != null && current.episode < here.episodeCount) {
    return { season: current.season, episode: current.episode + 1 };
  }
  const next = seasons
    .filter((s) => s.seasonNumber > current.season && s.seasonNumber !== 0 && s.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
  return next != null ? { season: next.seasonNumber, episode: 1 } : null;
}

/** The episode Detail should preselect for a series: the most recently
 * watched episode with a parseable episode id, else S1E1. Sorts by
 * `lastWatched` itself - never trusts the caller's array order. */
export function defaultSelectionFor(
  mediaId: string,
  records: WatchHistoryRecord[],
): { season: number; episode: number } {
  const newest = records
    .filter((r) => r.preview.id === mediaId && parseEpisodeId(r.episodeId) != null)
    .sort((a, b) => b.lastWatched.localeCompare(a.lastWatched))[0];
  return parseEpisodeId(newest?.episodeId) ?? { season: 1, episode: 1 };
}

/** Translate a legacy TMDB-style flattened S1 position through an already
 * validated Cinemeta regular-season inventory. Existing canonical selections,
 * specials, valid long first seasons, and positions beyond the inventory are
 * returned unchanged. */
export function normalizeFlattenedSeasonOneSelection(
  selection: { season: number; episode: number },
  seasons: Season[],
): { season: number; episode: number } {
  if (selection.season !== 1 || selection.episode < 1) return selection;
  const regular = seasons
    .filter((season) => season.seasonNumber > 0 && season.episodeCount > 0)
    .sort((left, right) => left.seasonNumber - right.seasonNumber);
  if (regular.length < 2 || regular[0].seasonNumber !== 1) return selection;
  if (selection.episode <= regular[0].episodeCount) return selection;

  let ordinal = selection.episode;
  for (let index = 0; index < regular.length; index += 1) {
    const season = regular[index];
    if (season.seasonNumber !== index + 1 || !Number.isSafeInteger(season.episodeCount)) {
      return selection;
    }
    if (ordinal <= season.episodeCount) {
      return { season: season.seasonNumber, episode: ordinal };
    }
    ordinal -= season.episodeCount;
  }
  return selection;
}

// MARK: - Hooks

interface SeasonsState {
  seasons: Season[];
  loading: boolean;
  /** "live" when a metadata source produced the list, "none" for the
   * no-key/error fallback (the picker degrades to a stepper). */
  source: "live" | "none";
  /** Only Cinemeta inventories are exact Stremio/IMDb numbering and safe for
   * translating a legacy flattened first-season position. */
  numbering: "cinemeta" | "tmdb" | null;
}

interface EpisodesState {
  episodes: Episode[];
  loading: boolean;
  source: "live" | "none";
  numbering: "cinemeta" | "tmdb" | null;
}

interface KeyedState<T> {
  key: string;
  value: T;
}

const NO_SEASONS: SeasonsState = {
  seasons: [], loading: false, source: "none", numbering: null,
};
const NO_EPISODES: EpisodesState = {
  episodes: [], loading: false, source: "none", numbering: null,
};
const cinemetaEpisodes = new CinemetaEpisodeService();

async function localImdbId(
  tmdbId: number | null,
  imdbId: string | null,
  tmdb: TMDBService | null,
): Promise<string | null> {
  if (imdbId != null) return imdbId;
  if (tmdbId == null || tmdb == null) return null;
  return (await tmdb.getExternalIds(tmdbId, "series")).imdbId ?? null;
}

/** Load the seasons list for a series. `enabled` gates the fetch (pass
 * `type === "series"`); errors and missing tmdbId/service degrade to
 * `source: "none"` - this hook never throws. */
export function useSeasons(
  tmdbId: number | null,
  enabled: boolean,
  tmdb: TMDBService | null,
  imdbId: string | null = null,
): SeasonsState {
  const requestKey = `${enabled ? 1 : 0}:${tmdbId ?? ""}:${imdbId ?? ""}`;
  const shouldLoad = enabled && (tmdbId != null || imdbId != null);
  const [state, setState] = useState<KeyedState<SeasonsState>>({
    key: requestKey,
    value: { ...NO_SEASONS, loading: shouldLoad },
  });

  useEffect(() => {
    if (!enabled || (tmdbId == null && imdbId == null)) {
      setState({ key: requestKey, value: NO_SEASONS });
      return;
    }
    let cancelled = false;
    setState({
      key: requestKey,
      value: { seasons: [], loading: true, source: "none", numbering: null },
    });

    async function run() {
      try {
        let raw: Season[] | null = null;
        let numbering: "cinemeta" | "tmdb" | null = null;
        if (isServerMode()) {
          const response = await fetchServerSeasons({ tmdbId, imdbId });
          raw = response.seasons;
          numbering = response.numbering;
        } else {
          const exactImdbId = await localImdbId(tmdbId, imdbId, tmdb).catch(() => null);
          if (exactImdbId != null) {
            const guide = await cinemetaEpisodes.getGuide(exactImdbId).catch(() => null);
            if (guide != null) {
              raw = guide.seasons;
              numbering = "cinemeta";
            }
          }
          if (raw == null && tmdbId != null && tmdb != null) {
            raw = await tmdb.getSeasons(tmdbId);
            numbering = "tmdb";
          }
        }
        if (cancelled) return;
        if (raw == null) {
          setState({ key: requestKey, value: NO_SEASONS });
          return;
        }
        // Season 0 is "Specials" - outside the picker's scope this round.
        const seasons = raw.filter((s) => s.seasonNumber > 0);
        setState({
          key: requestKey,
          value: {
            seasons,
            loading: false,
            source: seasons.length > 0 ? "live" : "none",
            numbering: seasons.length > 0 ? numbering : null,
          },
        });
      } catch {
        if (!cancelled) setState({ key: requestKey, value: NO_SEASONS });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [tmdbId, enabled, tmdb, imdbId, requestKey]);

  return state.key === requestKey
    ? state.value
    : { ...NO_SEASONS, loading: shouldLoad };
}

/** Load one season's episode list. Same degrade-to-"none" contract as
 * useSeasons. */
export function useEpisodes(
  tmdbId: number | null,
  seasonNumber: number | null,
  tmdb: TMDBService | null,
  imdbId: string | null = null,
): EpisodesState {
  const requestKey = `${tmdbId ?? ""}:${imdbId ?? ""}:${seasonNumber ?? ""}`;
  const shouldLoad = (tmdbId != null || imdbId != null) && seasonNumber != null;
  const [state, setState] = useState<KeyedState<EpisodesState>>({
    key: requestKey,
    value: { ...NO_EPISODES, loading: shouldLoad },
  });

  useEffect(() => {
    if ((tmdbId == null && imdbId == null) || seasonNumber == null) {
      setState({ key: requestKey, value: NO_EPISODES });
      return;
    }
    let cancelled = false;
    setState({
      key: requestKey,
      value: { episodes: [], loading: true, source: "none", numbering: null },
    });

    async function run() {
      try {
        let raw: Episode[] | null = null;
        let numbering: "cinemeta" | "tmdb" | null = null;
        if (isServerMode()) {
          const response = await fetchServerEpisodes({
            tmdbId,
            imdbId,
            season: seasonNumber!,
          });
          raw = response.episodes;
          numbering = response.numbering;
        } else {
          const exactImdbId = await localImdbId(tmdbId, imdbId, tmdb).catch(() => null);
          if (exactImdbId != null) {
            const guide = await cinemetaEpisodes.getGuide(exactImdbId).catch(() => null);
            const episodes = guide?.episodesBySeason.get(seasonNumber!);
            if (episodes != null) {
              raw = episodes;
              numbering = "cinemeta";
            }
          }
          if (raw == null && tmdbId != null && tmdb != null) {
            raw = await tmdb.getEpisodes(tmdbId, seasonNumber!);
            numbering = "tmdb";
          }
        }
        if (cancelled) return;
        if (raw == null) {
          setState({ key: requestKey, value: NO_EPISODES });
          return;
        }
        setState({
          key: requestKey,
          value: {
            episodes: raw,
            loading: false,
            source: raw.length > 0 ? "live" : "none",
            numbering: raw.length > 0 ? numbering : null,
          },
        });
      } catch {
        if (!cancelled) setState({ key: requestKey, value: NO_EPISODES });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [tmdbId, seasonNumber, tmdb, imdbId, requestKey]);

  return state.key === requestKey
    ? state.value
    : { ...NO_EPISODES, loading: shouldLoad };
}
