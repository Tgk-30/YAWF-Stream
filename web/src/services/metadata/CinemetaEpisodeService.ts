import type { Episode, Season } from "../../models/media";
import { assertNetworkAllowed } from "../../lib/networkPolicy";

interface FetchResponse {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

interface RawCinemetaVideo {
  id?: unknown;
  name?: unknown;
  season?: unknown;
  number?: unknown;
  episode?: unknown;
  overview?: unknown;
  released?: unknown;
}

interface RawCinemetaResponse {
  meta?: {
    id?: unknown;
    type?: unknown;
    videos?: unknown;
  };
}

export interface CinemetaEpisodeGuide {
  imdbId: string;
  seasons: Season[];
  episodesBySeason: ReadonlyMap<number, Episode[]>;
}

interface CacheEntry {
  expiresAt: number;
  value: CinemetaEpisodeGuide;
}

const IMDB_ID = /^tt\d{7,10}$/;
const MAX_BODY_BYTES = 2_000_000;
const MAX_VIDEOS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_CAPACITY = 128;
const REQUEST_TIMEOUT_MS = 8_000;

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function boundedResponseText(response: FetchResponse): Promise<string> {
  if (response.body == null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new Error("Cinemeta episode guide exceeded the response limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Cinemeta episode guide exceeded the response limit.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Public Cinemeta episode inventory, validated against the exact IMDb id.
 * Regular seasons must be contiguous before the guide is accepted so callers
 * can safely translate legacy flattened season-one positions. Specials keep
 * their source episode numbers and are never ordinal-mapped. */
export class CinemetaEpisodeService {
  private readonly fetchImpl: FetchImpl;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CinemetaEpisodeGuide>>();

  constructor(fetchImpl?: FetchImpl) {
    this.fetchImpl =
      fetchImpl ??
      (async (input, init) => {
        assertNetworkAllowed("metadata", "Cinemeta");
        return fetch(input, init as RequestInit);
      });
  }

  async getGuide(imdbId: string): Promise<CinemetaEpisodeGuide> {
    if (!IMDB_ID.test(imdbId)) {
      throw new Error("Cinemeta requires an exact IMDb series id.");
    }
    const cached = this.cache.get(imdbId);
    if (cached != null && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.inFlight.get(imdbId);
    if (pending != null) return pending;

    const request = this.load(imdbId)
      .then((value) => {
        this.store(imdbId, value);
        return value;
      })
      .finally(() => this.inFlight.delete(imdbId));
    this.inFlight.set(imdbId, request);
    return request;
  }

  private async load(imdbId: string): Promise<CinemetaEpisodeGuide> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let text: string;
    try {
      const response = await this.fetchImpl(
        `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`,
        {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (response.status < 200 || response.status > 299) {
        throw new Error(`Cinemeta episode guide returned HTTP ${response.status}.`);
      }
      text = await boundedResponseText(response);
    } finally {
      clearTimeout(timeout);
    }
    const raw = JSON.parse(text) as RawCinemetaResponse;
    if (raw.meta?.id !== imdbId || raw.meta.type !== "series" || !Array.isArray(raw.meta.videos)) {
      throw new Error("Cinemeta episode guide identity did not match the request.");
    }
    if (raw.meta.videos.length === 0 || raw.meta.videos.length > MAX_VIDEOS) {
      throw new Error("Cinemeta episode guide had an invalid episode count.");
    }

    const episodesBySeason = new Map<number, Episode[]>();
    const seen = new Set<string>();
    for (const candidate of raw.meta.videos as RawCinemetaVideo[]) {
      const season = candidate.season;
      const episode = candidate.number;
      if (
        !Number.isSafeInteger(season) ||
        !Number.isSafeInteger(episode) ||
        (season as number) < 0 ||
        (season as number) > 200 ||
        (episode as number) < 1 ||
        (episode as number) > 10_000
      ) {
        throw new Error("Cinemeta episode guide contained invalid numbering.");
      }
      const exactId = `${imdbId}:${season}:${episode}`;
      if (candidate.id !== exactId || seen.has(exactId)) {
        throw new Error("Cinemeta episode guide contained an invalid episode identity.");
      }
      if (candidate.episode != null && candidate.episode !== episode) {
        throw new Error("Cinemeta episode guide contained conflicting numbering.");
      }
      seen.add(exactId);
      const mapped: Episode = {
        id: exactId,
        mediaId: imdbId,
        seasonNumber: season as number,
        episodeNumber: episode as number,
        title: nullableString(candidate.name),
        overview: nullableString(candidate.overview),
        airDate: dateOnly(candidate.released),
        stillPath: null,
        runtime: null,
      };
      const bucket = episodesBySeason.get(mapped.seasonNumber) ?? [];
      bucket.push(mapped);
      episodesBySeason.set(mapped.seasonNumber, bucket);
    }

    for (const episodes of episodesBySeason.values()) {
      episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
    }
    const regularSeasonNumbers = [...episodesBySeason.keys()]
      .filter((season) => season > 0)
      .sort((left, right) => left - right);
    if (regularSeasonNumbers.length === 0) {
      throw new Error("Cinemeta episode guide had no regular seasons.");
    }
    regularSeasonNumbers.forEach((season, index) => {
      if (season !== index + 1) {
        throw new Error("Cinemeta episode guide had non-contiguous seasons.");
      }
      const episodes = episodesBySeason.get(season)!;
      episodes.forEach((episode, episodeIndex) => {
        if (episode.episodeNumber !== episodeIndex + 1) {
          throw new Error("Cinemeta episode guide had non-contiguous episodes.");
        }
      });
    });

    const seasons = [...episodesBySeason.entries()]
      .sort(([left], [right]) => left - right)
      .map(([seasonNumber, episodes]) => ({
        id: seasonNumber,
        seasonNumber,
        name: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
        overview: null,
        posterPath: null,
        episodeCount: episodes.length,
        airDate: episodes.map((episode) => episode.airDate).find((date) => date != null) ?? null,
      }));
    return { imdbId, seasons, episodesBySeason };
  }

  private store(imdbId: string, value: CinemetaEpisodeGuide): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    if (this.cache.size >= CACHE_CAPACITY) {
      const oldest = [...this.cache.entries()].sort(
        (left, right) => left[1].expiresAt - right[1].expiresAt,
      )[0]?.[0];
      if (oldest != null) this.cache.delete(oldest);
    }
    this.cache.set(imdbId, { expiresAt: now + CACHE_TTL_MS, value });
  }
}
