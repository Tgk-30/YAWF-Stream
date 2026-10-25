export const EPISODE_GUIDE_VERSION = "2";

export interface EpisodeSourceCoordinates {
  displaySeason: number;
  displayEpisode: number;
  imdbId: string;
  tmdbId: number | null;
  season: number;
  episode: number;
  title: string | null;
  year: number | null;
}

export interface EpisodeContinuation {
  parentImdbId: string;
  parentTmdbId: number;
  childImdbId: string;
  childTmdbId: number;
  parentSeasonCount: number;
  displaySeasonStart: number;
  childSeasonStart: number;
  childTitle: string;
  childYear: number;
}

/** Explicit, verified identity relationships only. Never infer continuations
 * from titles, season counts, or anime metadata. */
export const EPISODE_CONTINUATIONS: readonly EpisodeContinuation[] = [
  {
    parentImdbId: "tt0434665",
    parentTmdbId: 30984,
    childImdbId: "tt14986406",
    childTmdbId: 215105,
    parentSeasonCount: 16,
    displaySeasonStart: 17,
    childSeasonStart: 1,
    childTitle: "Bleach: Thousand-Year Blood War",
    childYear: 2022,
  },
];

export function continuationForParent(
  imdbId: string,
): EpisodeContinuation | null {
  return EPISODE_CONTINUATIONS.find((relation) => relation.parentImdbId === imdbId) ?? null;
}

/** Interpret legacy parent-display coordinates stored under a verified child.
 * At least one exact child id is required, and every supplied id must agree. */
export function recoverContinuationChildSelection(input: {
  imdbId: string | null;
  tmdbId: number | null;
  season: number;
  episode: number;
}): { season: number; episode: number } | null {
  if (
    !Number.isSafeInteger(input.season) ||
    !Number.isSafeInteger(input.episode) ||
    input.episode < 1
  ) {
    return null;
  }
  const continuation = EPISODE_CONTINUATIONS.find(
    (relation) =>
      (input.imdbId === relation.childImdbId || input.tmdbId === relation.childTmdbId) &&
      (input.imdbId == null || input.imdbId === relation.childImdbId) &&
      (input.tmdbId == null || input.tmdbId === relation.childTmdbId),
  );
  if (continuation == null || input.season < continuation.displaySeasonStart) return null;
  return {
    season:
      continuation.childSeasonStart +
      (input.season - continuation.displaySeasonStart),
    episode: input.episode,
  };
}

export function requiresCanonicalEpisodeGuide(
  imdbId: string | null,
  tmdbId: number | null,
): boolean {
  if (imdbId == null) {
    return tmdbId != null && EPISODE_CONTINUATIONS.some(
      (relation) => relation.parentTmdbId === tmdbId,
    );
  }
  const relation = continuationForParent(imdbId);
  return relation != null && (tmdbId == null || relation.parentTmdbId === tmdbId);
}

export function hasEpisodeContinuationIdentityConflict(
  imdbId: string | null,
  tmdbId: number | null,
): boolean {
  if (imdbId == null || tmdbId == null) return false;
  const relation = continuationForParent(imdbId);
  if (relation != null) return relation.parentTmdbId !== tmdbId;
  return EPISODE_CONTINUATIONS.some(
    (candidate) =>
      candidate.childImdbId === imdbId && candidate.parentTmdbId === tmdbId,
  );
}

/** Resolve display coordinates to the exact metadata and source identity. The
 * display coordinates remain the caller's history identity. */
export function resolveEpisodeSource(input: {
  imdbId: string;
  tmdbId: number | null;
  season: number;
  episode: number;
  title?: string | null;
  year?: number | null;
}): EpisodeSourceCoordinates {
  const continuation = EPISODE_CONTINUATIONS.find(
    (relation) =>
      relation.parentImdbId === input.imdbId &&
      (input.tmdbId == null || relation.parentTmdbId === input.tmdbId) &&
      input.season >= relation.displaySeasonStart,
  );
  if (continuation == null) {
    return {
      displaySeason: input.season,
      displayEpisode: input.episode,
      imdbId: input.imdbId,
      tmdbId: input.tmdbId,
      season: input.season,
      episode: input.episode,
      title: input.title ?? null,
      year: input.year ?? null,
    };
  }
  return {
    displaySeason: input.season,
    displayEpisode: input.episode,
    imdbId: continuation.childImdbId,
    tmdbId: continuation.childTmdbId,
    season:
      continuation.childSeasonStart +
      (input.season - continuation.displaySeasonStart),
    episode: input.episode,
    title: continuation.childTitle,
    year: continuation.childYear,
  };
}
