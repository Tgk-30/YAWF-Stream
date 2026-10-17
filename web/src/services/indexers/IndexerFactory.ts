// Port of Sources/DebridStreamer/Services/Indexers/IndexerFactory.swift.
//
// Builds the active indexer set from a list of IndexerConfigs (built-in
// Torrentio/APIBay/YTS/EZTV when enabled, plus priority-sorted external Torznab
// indexers)
// and validates an external endpoint via `testConnection` (2xx + a positive
// Torznab/RSS feed without an `<error>` envelope).

import { APIBayIndexer } from "./APIBayIndexer";
import { EZTVIndexer } from "./EZTVIndexer";
import { StremioAddonIndexer } from "./StremioAddonIndexer";
import {
  defaultFetchImpl,
  type FetchImpl,
  type IndexerConfig,
  ProviderSubtype,
  type TorrentIndexer,
} from "./types";
import { TorznabIndexer } from "./TorznabIndexer";
import { YTSIndexer } from "./YTSIndexer";

/** Torrentio's public endpoint, shipped as a built-in. It's a Stremio addon that
 * aggregates dozens of trackers (YTS, EZTV, RARBG mirrors, 1337x, ThePirateBay,
 * TorrentGalaxy, Nyaa, …) behind one IMDb-keyed API, so it returns far more (and
 * higher-quality) sources than the individual built-ins alone - the bare
 * endpoint uses its default broad provider set + quality/seeder sort. It's
 * IMDb-native (no free-text search), so it strengthens the imdb pass in both
 * Local and Server Mode and stays kid-safe (imdb-exact, bindable by the play
 * block). Per-indexer failures are absorbed by IndexerManager, so if Torrentio
 * is unreachable the other built-ins still serve results. */
const TORRENTIO_BUILT_IN_BASE_URL = "https://torrentio.strem.fun";

export const IndexerFactory = {
  /** Builds the active indexer list. Built-in scrapers come first (enabled
   * unless a `built_in` config is explicitly inactive), then active external
   * indexers sorted by ascending priority. Mirrors `buildIndexers`. */
  buildIndexers(
    configs: IndexerConfig[],
    fetchImpl: FetchImpl = defaultFetchImpl,
  ): TorrentIndexer[] {
    const result: TorrentIndexer[] = [];

    const builtInConfig = configs.find((c) => c.type === "built_in");
    const builtInEnabled = builtInConfig?.isActive ?? true;
    if (builtInEnabled) {
      // Torrentio first - the broadest, best-seeded source. APIBay/YTS/EZTV stay
      // as fallbacks and, for APIBay, the name-search that feeds the title pass
      // (Torrentio resolves by IMDb id only). Cross-source dupes collapse by
      // infoHash downstream, so the overlap costs nothing.
      result.push(
        new StremioAddonIndexer("Torrentio", TORRENTIO_BUILT_IN_BASE_URL, fetchImpl),
      );
      result.push(new APIBayIndexer(fetchImpl));
      result.push(new YTSIndexer(fetchImpl));
      result.push(new EZTVIndexer(fetchImpl));
    }

    const activeExternal = configs
      .filter((c) => c.isActive && c.type !== "built_in")
      .sort((a, b) => a.priority - b.priority);

    for (const config of activeExternal) {
      const indexer = makeExternalIndexer(config, fetchImpl);
      if (indexer == null) continue;
      result.push(indexer);
    }

    return result;
  },

  /** Validates an external indexer endpoint. Built-in always passes; otherwise
   * requires 2xx AND a positive Torznab/RSS feed (no `<error>` envelope).
   * Mirrors `testConnection`. */
  async testConnection(
    config: IndexerConfig,
    fetchImpl: FetchImpl = defaultFetchImpl,
  ): Promise<boolean> {
    if (config.type === "built_in") {
      // Built-in indexers have no user-configured endpoint to validate.
      return true;
    }
    if (config.type === "stremio_addon") {
      return testStremioAddonConnection(config, fetchImpl);
    }

    const probe = makeTorznabProbeRequest(config);
    if (probe == null) return false;

    try {
      const response = await fetchImpl(
        probe.url,
        probe.headers ? { headers: probe.headers } : undefined,
      );
      if (!(response.status >= 200 && response.status <= 299)) {
        return false;
      }
      return isPositiveTorznabResponse(await response.text());
    } catch {
      return false;
    }
  },
} as const;

/** Validates a Stremio addon by fetching and parsing `manifest.json`. A valid
 * addon is 2xx with valid JSON containing either an `id` or `resources`
 * field, matching the Swift `testStremioAddon` behavior. */
async function testStremioAddonConnection(
  config: IndexerConfig,
  fetchImpl: FetchImpl,
): Promise<boolean> {
  const trimmedBase = config.baseURL.trim();
  if (trimmedBase.length === 0) return false;

  let manifestBase = trimmedBase.replace(/\/+$/, "");
  if (/\/manifest\.json$/i.test(manifestBase)) {
    manifestBase = manifestBase.replace(/\/manifest\.json$/i, "");
  }
  const target = `${manifestBase}/manifest.json`;

  try {
    const response = await fetchImpl(target);
    if (!(response.status >= 200 && response.status <= 299)) {
      return false;
    }

    const parsed = JSON.parse(await response.text());
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }

    return (
      Object.prototype.hasOwnProperty.call(parsed, "id") ||
      Object.prototype.hasOwnProperty.call(parsed, "resources")
    );
  } catch {
    return false;
  }
}

/** Builds a minimal Torznab search probe (url + optional headers).
 * Mirrors `makeTorznabProbeRequest`. */
function makeTorznabProbeRequest(
  config: IndexerConfig,
): { url: string; headers: Record<string, string> | null } | null {
  const trimmedBase = config.baseURL.trim();
  if (trimmedBase.length === 0) {
    return null;
  }
  const trimmedEndpointPath = config.endpointPath.trim();

  let url: URL;
  try {
    url = new URL(trimmedBase);
  } catch {
    return null;
  }

  if (trimmedEndpointPath.length > 0) {
    const current = trimSlashes(url.pathname);
    const append = trimSlashes(trimmedEndpointPath);
    if (current.length === 0) {
      url.pathname = `/${append}`;
    } else if (append.length === 0) {
      url.pathname = `/${current}`;
    } else {
      url.pathname = `/${current}/${append}`;
    }
  }

  const sendAPIKeyAsHeader = config.providerSubtype === ProviderSubtype.prowlarr;
  url.searchParams.append("t", "search");
  url.searchParams.append("q", "test");
  if (config.categoryFilter != null && config.categoryFilter.length > 0) {
    url.searchParams.append("cat", config.categoryFilter);
  }
  if (
    config.apiKey != null &&
    config.apiKey.length > 0 &&
    !sendAPIKeyAsHeader
  ) {
    url.searchParams.append("apikey", config.apiKey);
  }

  let headers: Record<string, string> | null = null;
  if (
    config.apiKey != null &&
    config.apiKey.length > 0 &&
    sendAPIKeyAsHeader
  ) {
    headers = { "X-Api-Key": config.apiKey };
  }

  return { url: url.toString(), headers };
}

/** True only when the body looks like a valid Torznab/RSS feed and is not a
 * Torznab error envelope (`<error code=... />`). Mirrors
 * `isPositiveTorznabResponse`. */
function isPositiveTorznabResponse(body: string): boolean {
  const lower = body.toLowerCase();
  // A Torznab error envelope is a negative signal even with HTTP 200.
  if (lower.includes("<error")) {
    return false;
  }
  // Require a recognizable feed root; a valid empty feed still passes.
  return lower.includes("<rss") || lower.includes("<?xml");
}

/** Builds an external (Torznab-family) indexer from a config, or null for
 * built-in. Mirrors `makeExternalIndexer`. */
function makeExternalIndexer(
  config: IndexerConfig,
  fetchImpl: FetchImpl,
): TorrentIndexer | null {
  // Snapshot the discriminator once. Besides avoiding repeated property access,
  // this keeps factory behavior deterministic for configs supplied through a
  // proxy or accessor-backed object.
  const type = config.type;
  if (type === "built_in") {
    return null;
  }

  switch (type) {
    case "jackett":
    case "prowlarr":
    case "torznab":
    case "zilean": {
      const trimmedBase = config.baseURL.trim();
      if (trimmedBase.length === 0) return null;
      const displayName = config.displayName?.trim();
      const name =
        displayName != null && displayName.length > 0
          ? displayName
          : indexerTypeDisplayName(type);
      const trimmedEndpointPath = config.endpointPath.trim();
      const sendAPIKeyAsHeader =
        config.providerSubtype === ProviderSubtype.prowlarr;
      return new TorznabIndexer({
        name,
        baseURL: trimmedBase,
        endpointPath: trimmedEndpointPath,
        apiKey: config.apiKey,
        categoryFilter: config.categoryFilter,
        sendAPIKeyAsHeader,
        fetchImpl,
      });
    }
    case "stremio_addon": {
      const baseURL = config.baseURL.trim();
      // Mirror the Swift factory: skip an empty / unparseable base URL.
      if (baseURL.length === 0) return null;
      try {
        // eslint-disable-next-line no-new
        new URL(baseURL);
      } catch {
        return null;
      }
      const displayName = config.displayName?.trim();
      const name =
        displayName != null && displayName.length > 0
          ? displayName
          : indexerTypeDisplayName(type);
      return new StremioAddonIndexer(name, baseURL, fetchImpl);
    }
    default:
      // Keep unknown types resilient and observably labeled even if a new backend
      // value slips through before a proper case exists.
      indexerTypeDisplayName(type);
      return null;
  }
}

function indexerTypeDisplayName(type: string): string {
  switch (type) {
    case "jackett":
      return "Jackett";
    case "prowlarr":
      return "Prowlarr";
    case "torznab":
      return "Torznab";
    case "zilean":
      return "Zilean";
    case "stremio_addon":
      return "Stremio Addon";
  }
  return `Unknown (${type})`;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+/, "").replace(/\/+$/, "");
}
