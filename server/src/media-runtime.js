import { DebridManager } from "../../web/src/services/debrid/DebridManager.ts";
import { AllDebridService } from "../../web/src/services/debrid/AllDebridService.ts";
import { PremiumizeService } from "../../web/src/services/debrid/PremiumizeService.ts";
import { RealDebridService } from "../../web/src/services/debrid/RealDebridService.ts";
import { TorBoxService } from "../../web/src/services/debrid/TorBoxService.ts";
import { CacheStatus } from "../../web/src/services/debrid/models.ts";
import { IndexerManager } from "../../web/src/services/indexers/IndexerManager.ts";
import { IndexerType, makeIndexerConfig } from "../../web/src/services/indexers/types.ts";
import { decryptSecret } from "./crypto.js";
import { getServerDetail } from "./metadata-runtime.js";
import {
  buildTitleQuery,
  combineStreamResults,
} from "../../web/src/data/streamMatching.ts";

// Re-exported so the (pure-function) server tests can exercise the shared
// imdb+title merge exactly as searchServerStreams uses it.
export { combineStreamResults };

const BUILT_IN_INDEXERS_ENABLED_KEY = "built_in_indexers_enabled";
export const SERVER_INDEXER_CONFIGS_KEY = "server_indexer_configs";
const STREAM_CACHED_ONLY_KEY = "stream_cached_only";
const STREAM_MAX_QUALITY_KEY = "stream_max_quality";
const STREAM_MAX_SIZE_GB_KEY = "stream_max_size_gb";
const DATA_SAVER_KEY = "data_saver";
// The bandwidth-friendly ceiling the master Data Saver toggle clamps to. MUST
// mirror the client web/src/data/streams.ts effectiveDataSaver, or Server Mode
// and Local Mode would show different lists.
const DATA_SAVER_MAX_QUALITY = "720p";
const DATA_SAVER_MAX_SIZE_GB = 5;

const DEBRID_PROVIDERS = [
  "real_debrid",
  "all_debrid",
  "premiumize",
  "torbox",
];

const BUILDABLE_INDEXER_TYPES = new Set([
  "jackett",
  "prowlarr",
  "torznab",
  "zilean",
  "stremio_addon",
]);

const serverFetch = (url, init) => fetch(url, init);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settingValue(db, profileId, key) {
  const row = db.sqlite
    .prepare(
      `SELECT value
       FROM profile_settings
       WHERE profile_id = ? AND key = ?
       LIMIT 1`,
    )
    .get(profileId, key);
  return row?.value ?? null;
}

const QUALITY_ORDER = {
  Unknown: 0,
  SD: 1,
  "480p": 2,
  "720p": 3,
  "1080p": 4,
  "4K": 5,
};

function normalizeMaxQuality(value) {
  return Object.prototype.hasOwnProperty.call(QUALITY_ORDER, value) ? value : "any";
}

/** Apply the master Data Saver clamp to resolved filters. Pure + exported for
 *  tests; mirrors the client effectiveDataSaver (never loosens a stricter cap). */
export function withDataSaverClamp(filters, dataSaverOn) {
  if (!dataSaverOn) return filters;
  const currentQ = QUALITY_ORDER[filters.maxQuality]; // undefined for "any" (uncapped)
  const saverQ = QUALITY_ORDER[DATA_SAVER_MAX_QUALITY];
  const maxQuality =
    filters.maxQuality === "any" || (currentQ != null && currentQ > saverQ)
      ? DATA_SAVER_MAX_QUALITY
      : filters.maxQuality;
  const currentSize = filters.maxSizeGB > 0 ? filters.maxSizeGB : Infinity;
  const maxSizeGB = Math.min(currentSize, DATA_SAVER_MAX_SIZE_GB);
  return { cachedOnly: filters.cachedOnly, maxQuality, maxSizeGB };
}

function profileStreamFilters(db, profileId) {
  const base = {
    cachedOnly: settingValue(db, profileId, STREAM_CACHED_ONLY_KEY) === "true",
    maxQuality: normalizeMaxQuality(settingValue(db, profileId, STREAM_MAX_QUALITY_KEY)),
    maxSizeGB: (() => {
      const raw = Number(settingValue(db, profileId, STREAM_MAX_SIZE_GB_KEY));
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    })(),
  };
  return withDataSaverClamp(base, settingValue(db, profileId, DATA_SAVER_KEY) === "true");
}

export function rowMatchesStreamFilters(row, filters) {
  if (filters.cachedOnly && row.cachedOn == null) return false;
  if (filters.maxQuality !== "any") {
    const quality = row.result?.quality;
    const order = QUALITY_ORDER[quality] ?? 0;
    const maxOrder = QUALITY_ORDER[filters.maxQuality] ?? 0;
    if (order > maxOrder) return false;
  }
  if (filters.maxSizeGB > 0) {
    const sizeBytes = Number(row.result?.sizeBytes ?? 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > filters.maxSizeGB * 1024 * 1024 * 1024) {
      return false;
    }
  }
  return true;
}

function providerSubtypeFor(type, raw) {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return IndexerType.defaultProviderSubtype(type);
}

function parseIndexerConfigs(raw) {
  if (raw == null || raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const configs = [];
  for (const item of parsed) {
    if (item == null || typeof item !== "object") continue;
    const type = typeof item.type === "string" ? item.type : "";
    const baseURL = typeof item.baseURL === "string" ? item.baseURL.trim() : "";
    if (!BUILDABLE_INDEXER_TYPES.has(type) || baseURL.length === 0) continue;
    configs.push(
      makeIndexerConfig({
        id: typeof item.id === "string" ? item.id : `src-${configs.length}`,
        type,
        baseURL,
        apiKey: typeof item.apiKey === "string" ? item.apiKey : null,
        isActive: item.isActive !== false,
        displayName:
          typeof item.displayName === "string" ? item.displayName : null,
        providerSubtype: providerSubtypeFor(type, item.providerSubtype),
        endpointPath:
          typeof item.endpointPath === "string" ? item.endpointPath : null,
        categoryFilter:
          typeof item.categoryFilter === "string" ? item.categoryFilter : null,
        priority:
          typeof item.priority === "number" && Number.isFinite(item.priority)
            ? item.priority
            : configs.length,
      }),
    );
  }
  return configs;
}

function buildIndexerManager(db, profileId) {
  const configs = [];
  const builtIn = settingValue(db, profileId, BUILT_IN_INDEXERS_ENABLED_KEY);
  if (builtIn !== "true") {
    configs.push(
      makeIndexerConfig({
        id: "built-in",
        type: IndexerType.builtIn,
        baseURL: "",
        isActive: false,
      }),
    );
  }
  configs.push(
    ...parseIndexerConfigs(
      settingValue(db, profileId, SERVER_INDEXER_CONFIGS_KEY),
    ),
  );
  return new IndexerManager(configs, serverFetch);
}

function selectedCredential(db, config, profileId, provider) {
  const row = db.sqlite
    .prepare(
      `SELECT provider, priority, updated_at, encrypted_value
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
    return {
      provider,
      priority: row.priority,
      updatedAt: row.updated_at,
      value: decryptSecret(row.encrypted_value, config.secretKey),
    };
  } catch {
    return null;
  }
}

function buildDebridService(provider, token) {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  switch (provider) {
    case "real_debrid":
      return new RealDebridService(trimmed, serverFetch, realSleep);
    case "all_debrid":
      return new AllDebridService(trimmed, serverFetch, realSleep);
    case "premiumize":
      return new PremiumizeService(trimmed, serverFetch, realSleep);
    case "torbox":
      return new TorBoxService(trimmed, serverFetch, realSleep);
    default:
      return null;
  }
}
export { buildDebridService };

export function buildDebridManager(db, config, profileId) {
  const selected = DEBRID_PROVIDERS.map((provider, index) => ({
    index,
    credential: selectedCredential(db, config, profileId, provider),
  }))
    .filter((entry) => entry.credential != null)
    .sort((a, b) => {
      if (a.credential.priority !== b.credential.priority) {
        return a.credential.priority - b.credential.priority;
      }
      return a.index - b.index;
    });

  const manager = new DebridManager();
  const activeServices = [];
  for (const entry of selected) {
    const service = buildDebridService(
      entry.credential.provider,
      entry.credential.value,
    );
    if (service == null) continue;
    manager.addService(service);
    activeServices.push(entry.credential.provider);
  }
  return {
    manager: manager.hasServices ? manager : null,
    activeServices,
  };
}

export async function searchServerStreams(db, config, profileId, input) {
  const indexers = buildIndexerManager(db, profileId);
  const { manager: debrid, activeServices } = buildDebridManager(
    db,
    config,
    profileId,
  );
  const activeIndexers = indexers.activeIndexers;
  if (activeIndexers.length === 0) {
    const empty = {
      rows: [],
      hasIndexers: false,
      hasDebrid: debrid != null,
      activeIndexers,
      activeDebridServices: activeServices,
      indexerErrors: [],
    };
    await input.onPhase?.("sources", empty);
    await input.onPhase?.("ready", empty);
    return empty;
  }

  // Two complementary passes, merged identically to Local Mode via the shared
  // combineStreamResults: the imdb-native search (YTS/EZTV accept an imdb id) AND
  // a title/name query - APIBay-style indexers match torrent TITLES, so a bare
  // imdb id returns nothing there and without this they never contribute (one
  // dead imdb indexer would then empty every series). The title pass is
  // best-effort: a failure there must NOT empty the imdb results, and it is only
  // present for non-capped profiles (the route drops `title` for kids so the
  // fail-closed play-block, which is imdb-exact, can still bind every source).
  const titleQuery =
    typeof input.title === "string" && input.title.trim().length > 0
      ? buildTitleQuery(input.title, input.season ?? null, input.episode ?? null)
      : null;
  // The title pass runs on its OWN IndexerManager. Both passes call the manager's
  // collect(), which OVERWRITES lastSearchErrors; sharing one manager across the
  // concurrent Promise.all would let whichever pass finished last clobber the
  // imdb pass's errors - and indexerErrors below reads exactly those. Isolating
  // the title pass keeps indexerErrors deterministic (= the imdb pass), and the
  // title pass's own failures stay swallowed (best-effort, mirroring Local Mode).
  const titleIndexers = titleQuery != null ? buildIndexerManager(db, profileId) : null;
  const [byImdb, byTitle] = await Promise.all([
    indexers.searchAll(
      input.imdbId,
      input.type,
      input.season ?? null,
      input.episode ?? null,
    ),
    titleIndexers != null
      ? titleIndexers.searchByQuery(titleQuery, input.type).catch(() => [])
      : Promise.resolve([]),
  ]);
  // The year is passed for MOVIES only (combineStreamResults down-ranks
  // wrong-year releases; episode rips carry air/rip years that legitimately
  // differ from a series' first-air year, so the signal is meaningless there)
  // - mirror the client web/src/data/streams.ts resolveStreams.
  const results = combineStreamResults(
    byImdb,
    byTitle,
    input.title ?? null,
    input.type === "movie" ? input.year ?? null : null,
  );

  const filters = profileStreamFilters(db, profileId);
  const preliminaryRows = results
    .map((result) => ({
      result,
      cachedOn: null,
      cacheStatus: "unavailable",
    }))
    .filter((row) =>
      rowMatchesStreamFilters(row, { ...filters, cachedOnly: false }),
    );
  await input.onPhase?.("sources", {
    rows: preliminaryRows,
    hasIndexers: activeIndexers.length > 0,
    hasDebrid: debrid != null,
    activeIndexers,
    activeDebridServices: activeServices,
    indexerErrors: indexers.lastSearchErrors,
  });

  let cacheByHash = {};
  if (debrid != null) {
    try {
      cacheByHash = await debrid.checkCacheAll(results.map((r) => r.infoHash));
    } catch (error) {
      console.warn(
        "[streams] debrid cache check failed:",
        error instanceof Error ? error.message : String(error),
      );
      cacheByHash = {};
    }
  }

  const allRows = results.map((result) => {
    // checkCacheAll canonicalizes to lowercase; match it so a case difference
    // between the indexer hash and the provider's echo can't make a cached
    // torrent read as uncached (mirrors Local Mode's data/streams.ts).
    const entry = cacheByHash[result.infoHash.toLowerCase()];
    const cached = entry != null && CacheStatus.isCached(entry.status);
    return {
      result,
      cachedOn: cached ? entry.service : null,
      cacheStatus: cached
        ? "cached"
        : entry?.status?.kind === "notCached"
          ? "not_cached"
          : "unavailable",
    };
  });
  // Cached-only cannot be evaluated when every provider cache lookup failed.
  // Return the releases with an explicit unavailable status instead of an
  // empty list that falsely claims there are no matching streams.
  const cacheCheckAvailable = allRows.some(
    (row) => row.cacheStatus !== "unavailable",
  );
  const effectiveFilters = cacheCheckAvailable
    ? filters
    : { ...filters, cachedOnly: false };
  const rows = allRows.filter((row) => rowMatchesStreamFilters(row, effectiveFilters));

  const complete = {
    rows,
    hasIndexers: activeIndexers.length > 0,
    hasDebrid: debrid != null,
    activeIndexers,
    activeDebridServices: activeServices,
    indexerErrors: indexers.lastSearchErrors,
  };
  await input.onPhase?.("ready", complete);
  return complete;
}

export async function resolveServerStream(db, config, profileId, input) {
  const { manager } = buildDebridManager(db, config, profileId);
  if (manager == null) {
    throw Object.assign(new Error("Configure a debrid service to play."), {
      statusCode: 400,
    });
  }
  return manager.resolveStream(
    input.infoHash,
    input.preferredService ?? null,
    input.fileHint ?? null,
  );
}

function sourceEpisodeTag(title) {
  if (typeof title !== "string") return null;
  const upper = title.toUpperCase();
  const se = upper.match(/S(\d{1,2})[ ._-]?E(\d{1,3})/);
  if (se != null) return { season: Number(se[1]), episode: Number(se[2]) };
  const x = upper.match(/\b(\d{1,2})X(?!26[45]\b)(\d{2,3})\b/);
  return x == null ? null : { season: Number(x[1]), episode: Number(x[2]) };
}

function sourceMatchesEpisode(result, mediaType, season, episode) {
  if (mediaType !== "series" || season == null || episode == null) return true;
  const tag = sourceEpisodeTag(result?.title);
  return tag == null || (tag.season === season && tag.episode === episode);
}

// Whether `infoHash` is genuinely one of the indexer sources for the title named
// by `mediaId`. The kid play-block uses this to bind the cert-checked title to
// the content actually resolved, so an over-cap infoHash cannot be smuggled in
// under an in-cap mediaId. Resolves mediaId -> IMDb/title metadata, then queries
// the indexers DIRECTLY and looks for the hash (case-insensitively).
//
// It deliberately bypasses searchServerStreams' profileStreamFilters (cachedOnly
// / maxQuality / maxSizeGB) and the debrid cache lookup: membership is about
// whether the hash is a real SOURCE of the title, not whether it passes the
// profile's quality/cache preferences - filtering there would falsely block a
// legitimate in-cap movie. Normal Direct P2P binding also folds in the same
// title-query pass that discovery uses. Capped profiles leave that pass off so
// their existing IMDb-exact, fail-closed source binding is preserved.
export async function titleHasInfoHash(
  db,
  config,
  profileId,
  mediaId,
  mediaType,
  infoHash,
  season = null,
  episode = null,
  includeTitleMatches = false,
) {
  const target = String(infoHash).toLowerCase();
  const detail = await getServerDetail(db, config, profileId, { id: mediaId, type: mediaType });
  const imdbId = detail?.imdbId ?? null;
  if (imdbId == null) return false;
  const indexers = buildIndexerManager(db, profileId);
  if (indexers.activeIndexers.length === 0) return false;
  const byImdb = await indexers.searchAll(imdbId, mediaType, season, episode);
  const eligibleByImdb = byImdb.filter((result) =>
    sourceMatchesEpisode(result, mediaType, season, episode));
  const title = detail?.item?.title ?? null;
  if (!includeTitleMatches || typeof title !== "string" || title.trim().length === 0) {
    return eligibleByImdb.some((r) => String(r.infoHash).toLowerCase() === target);
  }
  const titleQuery = buildTitleQuery(title, season, episode);
  const titleIndexers = buildIndexerManager(db, profileId);
  const byTitle = await titleIndexers.searchByQuery(titleQuery, mediaType).catch(() => []);
  const eligibleByTitle = byTitle.filter((result) =>
    sourceMatchesEpisode(result, mediaType, season, episode));
  const results = combineStreamResults(
    eligibleByImdb,
    eligibleByTitle,
    title,
    mediaType === "movie" ? detail.item.year ?? null : null,
  );
  return results.some((r) => String(r.infoHash).toLowerCase() === target);
}
