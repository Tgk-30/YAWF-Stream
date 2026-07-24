import { TMDBService } from "../../web/src/services/metadata/TMDBService.ts";
import { createHash } from "node:crypto";
import { decryptSecret } from "./crypto.js";

const TMDB_CACHE_PROVIDER = "tmdb";
const TMDB_CACHE_MAX_BODY_BYTES = 2_000_000;
const TMDB_CACHE_TTL_MS = {
  search: 5 * 60 * 1000,
  catalog: 30 * 60 * 1000,
  detail: 6 * 60 * 60 * 1000,
  long: 24 * 60 * 60 * 1000,
};
const tmdbInflightByDb = new WeakMap();

function isoFromEpochMs(epochMs) {
  return new Date(epochMs).toISOString();
}

function tmdbCacheTTL(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return 0;
  }
  if (parsed.hostname !== "api.themoviedb.org") return 0;
  if (!parsed.pathname.startsWith("/3/")) return 0;

  const path = parsed.pathname;
  if (
    /\/genre\/[^/]+\/list$/.test(path) ||
    path.endsWith("/release_dates") ||
    path.endsWith("/content_ratings")
  ) {
    return TMDB_CACHE_TTL_MS.long;
  }
  if (path.includes("/search/")) return TMDB_CACHE_TTL_MS.search;
  if (
    path.includes("/discover/") ||
    path.includes("/trending/") ||
    /^\/3\/(movie|tv)\/(popular|top_rated|now_playing|upcoming|airing_today|on_the_air)$/.test(path)
  ) {
    return TMDB_CACHE_TTL_MS.catalog;
  }
  return TMDB_CACHE_TTL_MS.detail;
}

function tmdbCacheKey(url) {
  const parsed = new URL(String(url));
  parsed.searchParams.delete("api_key");
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  const normalized = `${parsed.origin}${parsed.pathname}${query.length > 0 ? `?${query}` : ""}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function tmdbInflightFor(db) {
  let inflight = tmdbInflightByDb.get(db);
  if (inflight == null) {
    inflight = new Map();
    tmdbInflightByDb.set(db, inflight);
  }
  return inflight;
}

function cachedFetchResponse(status, body) {
  return {
    status,
    async text() {
      return body;
    },
  };
}

function readMetadataCache(db, cacheKey) {
  const now = new Date().toISOString();
  const row = db.sqlite
    .prepare(
      `SELECT status, value_json
       FROM metadata_cache
       WHERE provider = ?
         AND cache_key = ?
         AND expires_at > ?
       LIMIT 1`,
    )
    .get(TMDB_CACHE_PROVIDER, cacheKey, now);
  if (row == null) return null;
  return cachedFetchResponse(row.status, row.value_json);
}

function storeMetadataCache(db, cacheKey, status, body, ttlMs) {
  if (status < 200 || status > 299) return;
  if (Buffer.byteLength(body, "utf8") > TMDB_CACHE_MAX_BODY_BYTES) return;
  const now = Date.now();
  const nowIso = isoFromEpochMs(now);
  db.sqlite
    .prepare("DELETE FROM metadata_cache WHERE provider = ? AND expires_at <= ?")
    .run(TMDB_CACHE_PROVIDER, nowIso);
  db.sqlite
    .prepare(
      `INSERT INTO metadata_cache
         (provider, cache_key, status, value_json, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, cache_key) DO UPDATE SET
         status = excluded.status,
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      TMDB_CACHE_PROVIDER,
      cacheKey,
      status,
      body,
      nowIso,
      nowIso,
      isoFromEpochMs(now + ttlMs),
    );
}

function cachedServerFetch(db) {
  return async (url, init) => {
    const ttlMs = tmdbCacheTTL(url);
    if (ttlMs <= 0) return fetch(url, init);

    const cacheKey = tmdbCacheKey(url);
    const cached = readMetadataCache(db, cacheKey);
    if (cached != null) return cached;

    const inflight = tmdbInflightFor(db);
    const existing = inflight.get(cacheKey);
    if (existing != null) return existing;

    const load = (async () => {
      const response = await fetch(url, init);
      const body = await response.text();
      storeMetadataCache(db, cacheKey, response.status, body, ttlMs);
      return cachedFetchResponse(response.status, body);
    })();
    inflight.set(cacheKey, load);
    try {
      return await load;
    } finally {
      inflight.delete(cacheKey);
    }
  };
}

function tmdbIdOf(preview) {
  if (typeof preview.tmdbId === "number" && Number.isFinite(preview.tmdbId)) {
    return preview.tmdbId;
  }
  if (typeof preview.id === "string" && preview.id.startsWith("tmdb-")) {
    const parsed = Number.parseInt(preview.id.slice(5), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof preview.id === "string" && /^[0-9]+$/.test(preview.id)) {
    const parsed = Number.parseInt(preview.id, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function todayISODate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function effectiveCredentialValue(db, config, profileId, provider) {
  const row = db.sqlite
    .prepare(
      `SELECT encrypted_value
       FROM credential_secrets
       WHERE provider = ?
         AND is_active = 1
         AND (
           (scope = 'profile' AND profile_id = ?)
           OR scope = 'server'
         )
       ORDER BY
         CASE WHEN scope = 'profile' THEN 0 ELSE 1 END,
         priority ASC,
         updated_at DESC
       LIMIT 1`,
    )
    .get(provider, profileId);
  if (row == null) return null;
  try {
    return decryptSecret(row.encrypted_value, config.secretKey);
  } catch {
    return null;
  }
}

function tmdbService(db, config, profileId) {
  const token = effectiveCredentialValue(db, config, profileId, "tmdb");
  if (token == null || token.trim().length === 0) {
    throw Object.assign(new Error("Configure a TMDB API key to use live metadata."), {
      statusCode: 400,
    });
  }
  const setting = (key) =>
    db.sqlite
      .prepare(
        `SELECT value
         FROM profile_settings
         WHERE profile_id = ? AND key = ?
         LIMIT 1`,
      )
      .get(profileId, key)?.value ?? null;
  let language = "en-US";
  try {
    const configured = setting("metadata_language");
    if (typeof configured === "string") {
      language = new Intl.Locale(configured).toString();
    }
  } catch {
    language = "en-US";
  }
  const configuredRegion = setting("metadata_region");
  const region =
    typeof configuredRegion === "string" && /^[A-Za-z]{2}$/.test(configuredRegion)
      ? configuredRegion.toUpperCase()
      : "US";
  return new TMDBService(token, cachedServerFetch(db), { language, region });
}

// Base /discover/movie params for a maturity-capped (kid) profile: US cert
// ceiling + adult off. TMDB only supports server-side certification filtering on
// /discover/movie (NOT trending/category/tv), so every kid-facing catalog call
// routes through discover-movie with these params - that's why kid browse is
// movie-only. `extra` adds sort_by / genres / page.
function capMovieParams(maturityMax, extra = {}) {
  const params = {
    include_adult: "false",
    ...extra,
  };
  // Only emit the certification filter when there is an actual cap. A kid with no
  // cap (defended against at the schema layer, but handled here too) still gets
  // movie-only/adult-off curation, just without a cert ceiling - never the full
  // adult catalog.
  if (typeof maturityMax === "string" && maturityMax.length > 0) {
    params.certification_country = "US";
    params["certification.lte"] = maturityMax;
  }
  return params;
}

// True when this audience must see only curated (movie-only, cert-capped)
// content. Triggers for ANY kid profile OR any profile carrying a cap - so an
// is_kid profile is never served the full adult/TV catalog even if its cap is
// somehow null. The cert filter itself is applied only when a cap exists.
function isCapped(audience) {
  if (audience == null) return false;
  if (audience.isKid === true) return true;
  return typeof audience.maturityMax === "string" && audience.maturityMax.length > 0;
}

function pickHero(trendingMovies, trendingTV) {
  return (
    trendingMovies.find((item) => item.backdropPath != null && item.backdropPath.length > 0) ??
    trendingTV.find((item) => item.backdropPath != null && item.backdropPath.length > 0) ??
    null
  );
}

export async function getServerDiscoverHome(db, config, profileId, audience) {
  const service = tmdbService(db, config, profileId);
  if (isCapped(audience)) {
    // Curated, movie-only, cert-capped home. Same payload shape as the adult
    // home (the client renders the same rails); TV + upcoming are emptied and
    // every rail is a cert-filtered discover-movie query.
    const cap = audience.maturityMax;
    const [popular, family, animation, topRated] = await Promise.all([
      service.discoverWithParams("movie", capMovieParams(cap, { sort_by: "popularity.desc", page: "1" })),
      service.discoverWithParams("movie", capMovieParams(cap, { sort_by: "popularity.desc", with_genres: "10751", page: "1" })),
      service.discoverWithParams("movie", capMovieParams(cap, { sort_by: "popularity.desc", with_genres: "16", page: "1" })),
      service.discoverWithParams("movie", capMovieParams(cap, { sort_by: "vote_average.desc", "vote_count.gte": "200", page: "1" })),
    ]);
    return {
      trendingMovies: popular.items,
      trendingTV: [],
      popularMovies: family.items,
      topRatedMovies: topRated.items,
      nowPlayingMovies: animation.items,
      upcomingMovies: [],
      hero: pickHero(popular.items, []),
    };
  }
  const [
    trendingMovies,
    trendingTV,
    popularMovies,
    topRatedMovies,
    nowPlayingMovies,
    upcomingMovies,
  ] = await Promise.all([
    service.getTrending("movie", "week"),
    service.getTrending("series", "week"),
    service.getCategory("popular", "movie"),
    service.getCategory("top_rated", "movie"),
    service.getCategory("now_playing", "movie"),
    service.getCategory("upcoming", "movie"),
  ]);
  return {
    trendingMovies: trendingMovies.items,
    trendingTV: trendingTV.items,
    popularMovies: popularMovies.items,
    topRatedMovies: topRatedMovies.items,
    nowPlayingMovies: nowPlayingMovies.items,
    upcomingMovies: upcomingMovies.items,
    hero: pickHero(trendingMovies.items, trendingTV.items),
  };
}

export async function searchServerMedia(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  return service.search(input.query, input.type ?? null, input.page ?? 1);
}

// Maps a (cert-uncontrolled) catalog category onto an equivalent cert-capped
// discover-movie sort, so kid category rails stay within the maturity cap.
const KID_CATEGORY_SORT = {
  trending: "popularity.desc",
  popular: "popularity.desc",
  top_rated: "vote_average.desc",
  now_playing: "primary_release_date.desc",
  upcoming: "primary_release_date.asc",
  airing_today: "popularity.desc",
  on_the_air: "popularity.desc",
};

export async function getServerCategory(db, config, profileId, input, audience) {
  const service = tmdbService(db, config, profileId);
  if (isCapped(audience)) {
    const extra = {
      sort_by: KID_CATEGORY_SORT[input.category] ?? "popularity.desc",
      page: String(input.page ?? 1),
    };
    if (input.category === "top_rated") extra["vote_count.gte"] = "200";
    return service.discoverWithParams("movie", capMovieParams(audience.maturityMax, extra));
  }
  if (input.category === "trending") {
    return service.getTrending(input.type, "week", input.page ?? 1);
  }
  return service.getCategory(input.category, input.type, input.page ?? 1);
}

export async function discoverServerMedia(db, config, profileId, input, audience) {
  const service = tmdbService(db, config, profileId);
  if (isCapped(audience)) {
    // Force movie + overwrite (not default) the cert params: a hand-crafted
    // certification.lte / type=series must not slip a kid past the cap. A kid
    // without a cap (schema-guarded, defended here too) still gets movie-only.
    const params = { ...input.params, include_adult: "false" };
    if (typeof audience.maturityMax === "string" && audience.maturityMax.length > 0) {
      params.certification_country = "US";
      params["certification.lte"] = audience.maturityMax;
    }
    return service.discoverWithParams("movie", params);
  }
  return service.discoverWithParams(input.type, input.params);
}

export async function getServerGenres(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  return { genres: await service.getGenres(input.type) };
}

export const MAX_CALENDAR_SERIES = 30;
const MAX_CALENDAR_SERIES_CONCURRENCY = 6;

async function getUpcomingEpisodes(series, service, now = Date.now()) {
  if (series.type !== "series") return [];
  const tmdbId = tmdbIdOf(series);
  if (tmdbId == null) return [];
  const today = todayISODate(now);
  try {
    const seasons = await service.getSeasons(tmdbId);
    const candidates = seasons
      .filter((season) => season.seasonNumber > 0)
      .sort((a, b) => b.seasonNumber - a.seasonNumber)
      .slice(0, 2);
    const perSeason = await Promise.all(
      candidates.map(async (season) => {
        try {
          const episodes = await service.getEpisodes(tmdbId, season.seasonNumber);
          return episodes
            .filter((episode) => episode.airDate != null && episode.airDate >= today)
            .map((episode) => ({
              series,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              title: episode.title ?? null,
              airDate: episode.airDate,
            }));
        } catch {
          return [];
        }
      }),
    );
    return perSeason.flat().sort((a, b) => a.airDate.localeCompare(b.airDate));
  } catch {
    return [];
  }
}

export async function getUpcomingEpisodesForSeries(seriesList, service, now = Date.now()) {
  const seen = new Set();
  const series = seriesList
    .filter((item) => {
      if (item.type !== "series") return false;
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, MAX_CALENDAR_SERIES);
  const all = new Array(series.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CALENDAR_SERIES_CONCURRENCY, series.length) },
    async () => {
      while (nextIndex < series.length) {
        const index = nextIndex;
        nextIndex += 1;
        all[index] = await getUpcomingEpisodes(series[index], service, now);
      }
    },
  );
  await Promise.all(workers);
  return all.flat().sort((a, b) => a.airDate.localeCompare(b.airDate));
}

export async function getServerUpcomingEpisodes(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  return { episodes: await getUpcomingEpisodesForSeries(input.series, service) };
}

/** Release-dated movie rows for Server Mode's calendar. The TMDB service uses
 * the server's encrypted credential and cached fetch broker, so callers never
 * need direct access to that essential-service key. */
export async function getServerMovieReleaseCalendar(db, config, profileId) {
  const service = tmdbService(db, config, profileId);
  return { releases: await service.getMovieReleaseCalendar() };
}

// The US maturity certification for a title, used by the kid play-block + the
// detail/source-search cert gates. mediaId may be a TMDB id ("tmdb-NNN"/numeric)
// OR an IMDB id ("tt…", the form /api/streams/:imdbId carries) - the latter is
// resolved to a TMDB id via /find first. Returns null when no TMDB id can be
// derived (caller fail-closes → blocks); the call is wrapped in a catch upstream
// so a missing TMDB key / TMDB error also degrades to a block rather than a leak.
export async function titleCertification(db, config, profileId, mediaId, type) {
  const service = tmdbService(db, config, profileId);
  let tmdbId = tmdbIdOf({ id: mediaId });
  if (tmdbId == null && typeof mediaId === "string" && mediaId.startsWith("tt")) {
    tmdbId = await service.findByImdbId(mediaId, type);
  }
  if (tmdbId == null) return null;
  // Household maturity caps currently use the documented US ladder. Keep this
  // safety decision independent from the viewer's metadata display region.
  return service.getCertification(tmdbId, type, "US");
}

export async function getServerDetail(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  const detail = await service.getDetail(input.id, input.type);
  const tmdbId = detail.tmdbId;
  let cast = [];
  let related = [];
  if (typeof tmdbId === "number" && Number.isFinite(tmdbId)) {
    [cast, related] = await Promise.all([
      service.getCast(tmdbId, input.type).catch(() => []),
      service.getRecommendations(tmdbId, input.type).catch(() => []),
    ]);
  }
  return {
    item: detail,
    cast,
    related,
    imdbId: detail.id.startsWith("tt") ? detail.id : null,
  };
}

/** A series' seasons for the episode picker (thin proxy over the server-side
 *  TMDB key, mirroring getServerDetail). */
export async function getServerSeasons(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  const seasons = await service.getSeasons(input.tmdbId);
  return { seasons };
}

/** One season's episode list for the episode picker. */
export async function getServerEpisodes(db, config, profileId, input) {
  const service = tmdbService(db, config, profileId);
  const episodes = await service.getEpisodes(input.tmdbId, input.season);
  return { episodes };
}
