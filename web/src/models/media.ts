// Port of Sources/DebridStreamer/Models/MediaItem.swift, MediaType.swift,
// and CastMember.swift (the display-only types the metadata layer produces).
//
// Field names are kept aligned with the Swift models so cached JSON and later
// sync code line up across the two implementations.

import { isNetworkAllowed } from "../lib/networkPolicy";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

function imageURL(path: string | null | undefined, size: string): string | null {
  return path && isNetworkAllowed("images") ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

/** The type of media content. Mirrors Swift `MediaType`. */
export type MediaType = "movie" | "series";

export const MediaType = {
  movie: "movie" as MediaType,
  series: "series" as MediaType,

  /** Human-facing label. Mirrors `MediaType.displayName`. */
  displayName(type: MediaType): string {
    return type === "movie" ? "Movie" : "TV Show";
  },

  /** TMDB API path segment. Mirrors `MediaType.tmdbPath`. */
  tmdbPath(type: MediaType): string {
    return type === "movie" ? "movie" : "tv";
  },
} as const;

/**
 * A preview/summary version of MediaItem for catalog listings.
 * Mirrors Swift `MediaPreview`. `backdropPath` is optional and only populated
 * for hero/spotlight surfaces (declared last in Swift for Codable compat).
 */
export interface MediaPreview {
  id: string;
  type: MediaType;
  title: string;
  year?: number | null;
  posterPath?: string | null;
  imdbRating?: number | null;
  tmdbId?: number | null;
  /** Optional 16:9 backdrop path - populated for hero/spotlight surfaces. */
  backdropPath?: string | null;
  /** Search-only navigation hint, not part of library or playback identity. */
  searchContinuationSeason?: number;
}

export function withoutSearchContinuation(preview: MediaPreview): MediaPreview {
  if (preview.searchContinuationSeason == null) return preview;
  const { searchContinuationSeason: _, ...canonical } = preview;
  return canonical;
}

export const MediaPreview = {
  /** w342 poster, mirrors `MediaPreview.posterURL`. */
  posterURL(p: MediaPreview): string | null {
    return imageURL(p.posterPath, "w342");
  },

  /** Full-bleed w1280 backdrop, mirrors `MediaPreview.backdropURL`. */
  backdropURL(p: MediaPreview): string | null {
    return imageURL(p.backdropPath, "w1280");
  },

  /** w780 backdrop thumbnail, mirrors `MediaPreview.backdropThumbnailURL`. */
  backdropThumbnailURL(p: MediaPreview): string | null {
    return imageURL(p.backdropPath, "w780");
  },

  /** "%.1f" rating or "" when missing, mirrors `MediaPreview.ratingString`. */
  ratingString(p: MediaPreview): string {
    return p.imdbRating != null ? p.imdbRating.toFixed(1) : "";
  },
} as const;

/**
 * A movie or TV show with metadata from TMDB. Mirrors Swift `MediaItem`.
 * `id` is an IMDB ID (tt1234567) or `tmdb-{id}` fallback.
 * `lastFetched` is an ISO-8601 string (Swift uses `Date`).
 */
export interface MediaItem {
  id: string;
  type: MediaType;
  title: string;
  year?: number | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  overview?: string | null;
  genres: string[];
  imdbRating?: number | null;
  rtRating?: number | null;
  runtime?: number | null; // minutes
  status?: string | null;
  tmdbId?: number | null;
  lastFetched: string; // ISO-8601
}

export const MediaItem = {
  /** w500 poster, mirrors `MediaItem.posterURL`. */
  posterURL(m: MediaItem): string | null {
    return imageURL(m.posterPath, "w500");
  },

  /** w1280 backdrop, mirrors `MediaItem.backdropURL`. */
  backdropURL(m: MediaItem): string | null {
    return imageURL(m.backdropPath, "w1280");
  },

  /** w780 backdrop thumbnail, mirrors `MediaItem.backdropThumbnailURL`. */
  backdropThumbnailURL(m: MediaItem): string | null {
    return imageURL(m.backdropPath, "w780");
  },

  /** w342 poster thumbnail, mirrors `MediaItem.posterThumbnailURL`. */
  posterThumbnailURL(m: MediaItem): string | null {
    return imageURL(m.posterPath, "w342");
  },

  /** Year as a string or "", mirrors `MediaItem.yearString`. */
  yearString(m: MediaItem): string {
    return m.year != null ? String(m.year) : "";
  },

  /** "%.1f" rating or "N/A", mirrors `MediaItem.ratingString`. */
  ratingString(m: MediaItem): string {
    return m.imdbRating != null ? m.imdbRating.toFixed(1) : "N/A";
  },

  /** "Xh Ym" / "Ym" or "", mirrors `MediaItem.runtimeString`. */
  runtimeString(m: MediaItem): string {
    const runtime = m.runtime;
    if (runtime == null || runtime <= 0) return "";
    const hours = Math.floor(runtime / 60);
    const minutes = runtime % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  },
} as const;

/**
 * A single cast member for a movie or TV show. Mirrors Swift `CastMember`.
 * Display-only - never persisted. `profileURL` is a derived w185 image URL.
 */
export interface CastMember {
  id: number;
  name: string;
  character: string;
  profileURL: string | null;
}

/** Mirrors `CastMember.init(id:name:character:profilePath:)`. */
export function makeCastMember(
  id: number,
  name: string,
  character: string,
  profilePath: string | null | undefined,
): CastMember {
  const profileURL =
    profilePath && profilePath.length > 0 ? imageURL(profilePath, "w185") : null;
  return { id, name, character, profileURL };
}

/** A TV season summary. Mirrors Swift `Season`. */
export interface Season {
  id: number;
  seasonNumber: number;
  name: string;
  overview?: string | null;
  posterPath?: string | null;
  episodeCount: number;
  airDate?: string | null;
}

/** A TV show episode. Mirrors Swift `Episode`. */
export interface Episode {
  id: string;
  mediaId: string;
  seasonNumber: number;
  episodeNumber: number;
  title?: string | null;
  overview?: string | null;
  airDate?: string | null;
  stillPath?: string | null;
  runtime?: number | null;
}
