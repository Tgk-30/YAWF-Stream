// Unit tests for IndexerFactory (port of IndexerFactory.swift):
//  - buildIndexers: built-in set ordering + enable/disable, external indexer
//    construction per type, priority sort, displayName-vs-type-default naming,
//    sendAPIKeyAsHeader resolution (prowlarr subtype), skipping
//    unknown/empty/unparseable stremio_addon configs, and built_in -> null.
//  - testConnection: built-in short-circuit, endpoint-path joining, apikey in
//    query vs X-Api-Key header (prowlarr subtype), category filter, stremio
//    manifest validation, unparseable base URL, non-2xx, Torznab <error>
//    envelope, and positive-feed detection.
//
// The network is stubbed via an injected `FetchImpl` (same pattern as
// indexers.test.ts / StremioAddonIndexer.test.ts): it captures the last URL +
// headers and counts calls.

import { describe, expect, it } from "vitest";
import { IndexerFactory } from "./IndexerFactory";
import { StremioAddonIndexer } from "./StremioAddonIndexer";
import { TorznabIndexer } from "./TorznabIndexer";
import {
  type FetchImpl,
  makeIndexerConfig,
  ProviderSubtype,
} from "./types";

interface MockResponse {
  status: number;
  body: string;
}

interface MockFetch {
  fetchImpl: FetchImpl;
  lastURL: () => URL | null;
  lastHeaders: () => Record<string, string> | undefined;
  hits: () => number;
}

function makeMockFetch(
  handler: (url: URL, hit: number) => MockResponse,
): MockFetch {
  let count = 0;
  let captured: URL | null = null;
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl: FetchImpl = async (url, init) => {
    count += 1;
    const parsed = new URL(url);
    captured = parsed;
    capturedHeaders = init?.headers;
    const { status, body } = handler(parsed, count);
    return { status, text: async () => body };
  };
  return {
    fetchImpl,
    lastURL: () => captured,
    lastHeaders: () => capturedHeaders,
    hits: () => count,
  };
}

const ok = (body: string): MockResponse => ({ status: 200, body });
const validFeed = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';

// ============================================================================
// buildIndexers - built-in set
// ============================================================================

describe("IndexerFactory.buildIndexers built-in set", () => {
  it("returns the four built-in scrapers in order when given no configs", () => {
    const indexers = IndexerFactory.buildIndexers([]);
    expect(indexers.map((i) => i.name)).toEqual(["Torrentio", "APIBay", "YTS", "EZTV"]);
  });

  it("keeps built-ins when a built_in config is explicitly active", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: true }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["Torrentio", "APIBay", "YTS", "EZTV"]);
  });

  it("omits built-ins when a built_in config is inactive", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
    ]);
    expect(indexers).toEqual([]);
  });

  it("keeps built-ins by default when only external configs are present (no built_in config)", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({
        id: "ext",
        type: "torznab",
        baseURL: "http://h",
        displayName: "Ext",
      }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["Torrentio", "APIBay", "YTS", "EZTV", "Ext"]);
  });

  it("uses only the first built_in config's isActive flag", () => {
    // buildIndexers uses `configs.find(type === "built_in")`, so the first one wins.
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b1", type: "built_in", baseURL: "", isActive: false }),
      makeIndexerConfig({ id: "b2", type: "built_in", baseURL: "", isActive: true }),
    ]);
    expect(indexers).toEqual([]);
  });
});

// ============================================================================
// buildIndexers - external indexers per type
// ============================================================================

describe("IndexerFactory.buildIndexers external indexer types", () => {
  function buildSingleExternal(config: ReturnType<typeof makeIndexerConfig>) {
    return IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
      config,
    ]);
  }

  it("builds a TorznabIndexer for jackett/prowlarr/torznab/zilean", () => {
    for (const type of ["jackett", "prowlarr", "torznab", "zilean"] as const) {
      const indexers = buildSingleExternal(
        makeIndexerConfig({ id: type, type, baseURL: "http://host" }),
      );
      expect(indexers).toHaveLength(1);
      expect(indexers[0]).toBeInstanceOf(TorznabIndexer);
    }
  });

  it("builds a StremioAddonIndexer for stremio_addon", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({
        id: "s",
        type: "stremio_addon",
        baseURL: "https://torrentio.strem.fun",
      }),
    );
    expect(indexers).toHaveLength(1);
    expect(indexers[0]).toBeInstanceOf(StremioAddonIndexer);
  });

  it("uses a trimmed displayName for stremio_addon", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({
        id: "s",
        type: "stremio_addon",
        baseURL: "https://torrentio.strem.fun",
        displayName: "  My Stremio Addon  ",
      }),
    );
    expect(indexers[0]?.name).toBe("My Stremio Addon");
  });

  it("names torznab-family indexers from the type default when no displayName", () => {
    const cases: Array<[Parameters<typeof makeIndexerConfig>[0]["type"], string]> = [
      ["jackett", "Jackett"],
      ["prowlarr", "Prowlarr"],
      ["torznab", "Torznab"],
      ["zilean", "Zilean"],
      ["stremio_addon", "Stremio Addon"],
    ];
    for (const [type, expected] of cases) {
      const indexers = buildSingleExternal(
        makeIndexerConfig({ id: type, type, baseURL: "https://host" }),
      );
      expect(indexers[0]?.name).toBe(expected);
    }
  });

  it("prefers a non-empty trimmed displayName over the type default", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({
        id: "j",
        type: "jackett",
        baseURL: "http://host",
        displayName: "  My Jackett  ",
      }),
    );
    expect(indexers[0]?.name).toBe("My Jackett");
  });

  it("falls back to the type default when displayName is whitespace-only", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({
        id: "j",
        type: "jackett",
        baseURL: "http://host",
        displayName: "   ",
      }),
    );
    expect(indexers[0]?.name).toBe("Jackett");
  });

  it("skips a stremio_addon config with an empty/whitespace base URL", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({ id: "s", type: "stremio_addon", baseURL: "   " }),
    );
    expect(indexers).toHaveLength(0);
  });

  it("skips a stremio_addon config with an unparseable base URL", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({
        id: "s",
        type: "stremio_addon",
        baseURL: "not a url",
      }),
    );
    expect(indexers).toHaveLength(0);
  });

  it("skips a torznab config with an empty base URL", () => {
    const indexers = buildSingleExternal(
      makeIndexerConfig({ id: "t", type: "torznab", baseURL: "" }),
    );
    expect(indexers).toHaveLength(0);
  });

  it("drops an unexpected built_in payload that reaches the external-construction path", () => {
    const mutable = {
      ...makeIndexerConfig({ id: "weird", type: "jackett", baseURL: "http://host" }),
      isActive: true,
    } as { type: string };
    let reads = 0;
    Object.defineProperty(mutable, "type", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? "jackett" : "built_in";
      },
      set: () => {
        // no-op: this config keeps its staged behavior via the getter only.
      },
    });

    const indexers = IndexerFactory.buildIndexers([mutable as any]);
    expect(reads).toBe(3);
    expect(indexers).toHaveLength(4);
    expect(indexers.map((indexer) => indexer.name)).toEqual([
      "Torrentio",
      "APIBay",
      "YTS",
      "EZTV",
    ]);
  });

  it("ignores unknown external indexer types by returning null from makeExternalIndexer", () => {
    const mutable = {
      ...makeIndexerConfig({ id: "mystery", type: "jackett", baseURL: "http://host" }),
      type: "mystery" as never,
      isActive: true,
    };

    const indexers = IndexerFactory.buildIndexers([mutable as any]);
    expect(indexers).toHaveLength(4);
    expect(indexers.map((indexer) => indexer.name)).toEqual([
      "Torrentio",
      "APIBay",
      "YTS",
      "EZTV",
    ]);
  });
});

// ============================================================================
// buildIndexers - active filtering + priority sort
// ============================================================================

describe("IndexerFactory.buildIndexers filtering and ordering", () => {
  it("excludes inactive external configs", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
      makeIndexerConfig({
        id: "on",
        type: "torznab",
        baseURL: "http://h1",
        displayName: "On",
        isActive: true,
      }),
      makeIndexerConfig({
        id: "off",
        type: "torznab",
        baseURL: "http://h2",
        displayName: "Off",
        isActive: false,
      }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["On"]);
  });

  it("sorts active external indexers by ascending priority", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
      makeIndexerConfig({
        id: "p3",
        type: "torznab",
        baseURL: "http://h3",
        displayName: "Third",
        priority: 3,
      }),
      makeIndexerConfig({
        id: "p1",
        type: "jackett",
        baseURL: "http://h1",
        displayName: "First",
        priority: 1,
      }),
      makeIndexerConfig({
        id: "p2",
        type: "prowlarr",
        baseURL: "http://h2",
        displayName: "Second",
        priority: 2,
      }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["First", "Second", "Third"]);
  });

  it("places priority-sorted external indexers after the built-ins", () => {
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({
        id: "p2",
        type: "torznab",
        baseURL: "http://h2",
        displayName: "B",
        priority: 2,
      }),
      makeIndexerConfig({
        id: "p1",
        type: "torznab",
        baseURL: "http://h1",
        displayName: "A",
        priority: 1,
      }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["Torrentio", "APIBay", "YTS", "EZTV", "A", "B"]);
  });

  it("never includes a built_in config among the external set even when active", () => {
    // The external filter excludes type === "built_in"; an active built_in only
    // toggles the built-in scrapers, it is not also constructed as an external.
    const indexers = IndexerFactory.buildIndexers([
      makeIndexerConfig({ id: "b", type: "built_in", baseURL: "x", isActive: true }),
    ]);
    expect(indexers.map((i) => i.name)).toEqual(["Torrentio", "APIBay", "YTS", "EZTV"]);
  });
});

// ============================================================================
// buildIndexers - constructed indexer wiring (verified via a search request)
// ============================================================================

describe("IndexerFactory.buildIndexers constructed wiring", () => {
  it("wires the torznab indexer with baseURL, endpointPath, apikey, and category", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const indexers = IndexerFactory.buildIndexers(
      [
        makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
        makeIndexerConfig({
          id: "j",
          type: "jackett",
          baseURL: "http://localhost:9117",
          apiKey: "secretkey",
          categoryFilter: "2000",
          // jackett's defaultEndpointPath
        }),
      ],
      mock.fetchImpl,
    );

    await indexers[0].searchByQuery("test", "movie");
    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/api/v2.0/indexers/all/results/torznab/api");
    expect(url.searchParams.get("apikey")).toBe("secretkey");
    expect(url.searchParams.get("cat")).toBe("2000");
    // jackett's default subtype is NOT prowlarr, so the key goes in the query.
    expect(mock.lastHeaders()).toBeUndefined();
  });

  it("normalizes whitespace around endpointPath before wiring torznab requests", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const indexers = IndexerFactory.buildIndexers(
      [
        makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
        makeIndexerConfig({
          id: "j",
          type: "jackett",
          baseURL: "http://localhost:9117/base",
          endpointPath: " /api/torznab/ ",
        }),
      ],
      mock.fetchImpl,
    );

    await indexers[0].searchByQuery("test", "movie");
    expect(mock.lastURL()!.pathname).toBe("/base/api/torznab");
  });

  it("sends the API key as the X-Api-Key header for a prowlarr-subtype config", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const indexers = IndexerFactory.buildIndexers(
      [
        makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
        makeIndexerConfig({
          id: "p",
          type: "prowlarr",
          baseURL: "http://localhost:9696",
          apiKey: "header-token",
          // prowlarr's default subtype is prowlarr -> header mode
        }),
      ],
      mock.fetchImpl,
    );

    await indexers[0].searchByQuery("test", "movie");
    expect(mock.lastHeaders()?.["X-Api-Key"]).toBe("header-token");
    expect(mock.lastURL()!.searchParams.get("apikey")).toBeNull();
  });

  it("uses query-key mode for a torznab type even if its config type matches a header type only by subtype", async () => {
    // sendAPIKeyAsHeader is keyed on providerSubtype === prowlarr, not type.
    // A torznab type with an explicit prowlarr subtype must use header mode.
    const mock = makeMockFetch(() => ok(validFeed));
    const indexers = IndexerFactory.buildIndexers(
      [
        makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
        makeIndexerConfig({
          id: "t",
          type: "torznab",
          baseURL: "http://host",
          apiKey: "k",
          providerSubtype: ProviderSubtype.prowlarr,
          endpointPath: "/api",
        }),
      ],
      mock.fetchImpl,
    );

    await indexers[0].searchByQuery("test", "movie");
    expect(mock.lastHeaders()?.["X-Api-Key"]).toBe("k");
    expect(mock.lastURL()!.searchParams.get("apikey")).toBeNull();
  });

  it("wires the stremio addon indexer with its base URL", async () => {
    const json = JSON.stringify({
      streams: [
        {
          title: "Show.1080p.WEB\n\u{1F464} 50 \u{1F4BE} 1.5 GB",
          infoHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      ],
    });
    const mock = makeMockFetch(() => ok(json));
    const indexers = IndexerFactory.buildIndexers(
      [
        makeIndexerConfig({ id: "b", type: "built_in", baseURL: "", isActive: false }),
        makeIndexerConfig({
          id: "s",
          type: "stremio_addon",
          baseURL: "https://torrentio.strem.fun",
        }),
      ],
      mock.fetchImpl,
    );

    const results = await indexers[0].search("tt1234567", "movie", null, null);
    const url = new URL(mock.lastURL()!.toString());
    expect(url.host).toBe("torrentio.strem.fun");
    expect(url.pathname).toBe("/stream/movie/tt1234567.json");
    expect(results).toHaveLength(1);
    expect(results[0].infoHash).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});

// ============================================================================
// testConnection
// ============================================================================

describe("IndexerFactory.testConnection", () => {
  it("returns true for a built_in config without probing the network", async () => {
    const mock = makeMockFetch(() => ok("garbage"));
    const config = makeIndexerConfig({ id: "b", type: "built_in", baseURL: "" });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(true);
    expect(mock.hits()).toBe(0);
  });

  it("returns false (no fetch) when the base URL is unparseable", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "not a url",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(false);
    expect(mock.hits()).toBe(0);
  });

  it("returns false (no fetch) when the base URL is only whitespace", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "   ",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(false);
    expect(mock.hits()).toBe(0);
  });

  it("returns true on a valid empty Torznab feed (2xx)", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://localhost:9117",
      apiKey: "abc",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(true);
  });

  it("returns true for a body containing <rss without an xml declaration", async () => {
    const mock = makeMockFetch(() => ok("<rss><channel></channel></rss>"));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(true);
  });

  it("returns false when the body has no recognizable feed root", async () => {
    const mock = makeMockFetch(() => ok("<html><body>login</body></html>"));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(false);
  });

  it("returns false on a Torznab <error> envelope despite HTTP 200", async () => {
    const xml =
      '<?xml version="1.0"?><error code="100" description="Incorrect user credentials"/>';
    const mock = makeMockFetch(() => ok(xml));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
      apiKey: "wrong",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(false);
  });

  it("returns false on a non-2xx HTTP status", async () => {
    const mock = makeMockFetch(() => ({ status: 401, body: validFeed }));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
      apiKey: "bad",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(false);
  });

  it("returns false when the fetch itself rejects", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error("network down");
    };
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
    });
    expect(await IndexerFactory.testConnection(config, fetchImpl)).toBe(false);
  });

  it("probes t=search&q=test and joins the configured endpoint path onto the base path", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://localhost:9117/base",
      endpointPath: "/api/torznab",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    const url = mock.lastURL()!;
    expect(url.pathname).toBe("/base/api/torznab");
    expect(url.searchParams.get("t")).toBe("search");
    expect(url.searchParams.get("q")).toBe("test");
  });

  it("probes the root base path when endpointPath is configured", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://localhost:9117",
      endpointPath: "/api/torznab",
    });

    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.pathname).toBe("/api/torznab");
    expect(mock.lastURL()!.searchParams.get("t")).toBe("search");
    expect(mock.lastURL()!.searchParams.get("q")).toBe("test");
  });

  it("trims whitespace in endpointPath when probing for connection", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://localhost:9117/base",
      endpointPath: " /api/torznab/ ",
    });

    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.pathname).toBe("/base/api/torznab");
  });

  it("sends apikey in the query for a non-prowlarr subtype", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
      apiKey: "querykey",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.searchParams.get("apikey")).toBe("querykey");
    expect(mock.lastHeaders()).toBeUndefined();
  });

  it("sends the API key as the X-Api-Key header for a prowlarr subtype and not in the query", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "p",
      type: "prowlarr",
      baseURL: "http://h",
      apiKey: "header-token",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastHeaders()?.["X-Api-Key"]).toBe("header-token");
    expect(mock.lastURL()!.searchParams.get("apikey")).toBeNull();
  });

  it("appends the category filter when configured", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "j",
      type: "jackett",
      baseURL: "http://h",
      categoryFilter: "5000",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.searchParams.get("cat")).toBe("5000");
  });

  it("omits the apikey param entirely when no key is configured", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "t",
      type: "torznab",
      baseURL: "http://h",
      apiKey: null,
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.searchParams.get("apikey")).toBeNull();
    expect(mock.lastHeaders()).toBeUndefined();
  });

  it("validates stremio addons by reading manifest.json", async () => {
    const manifest = { id: "addon", resources: ["streaming"] };
    const mock = makeMockFetch((url) => {
      if (url.pathname === "/stream/manifest.json") {
        return ok(JSON.stringify(manifest));
      }
      return ok("{}");
    });

    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream",
    });
    const connected = await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(connected).toBe(true);
    expect(mock.lastURL()!.pathname).toBe("/stream/manifest.json");
    expect(mock.hits()).toBe(1);
  });

  it("validates a Stremio manifest when Object.hasOwn is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object, "hasOwn");
    Object.defineProperty(Object, "hasOwn", {
      configurable: true,
      value: undefined,
    });
    const mock = makeMockFetch(() => ok(JSON.stringify({ id: "legacy-webview-addon" })));
    try {
      const result = await IndexerFactory.testConnection(
        makeIndexerConfig({
          id: "stremio-legacy-webview",
          type: "stremio_addon",
          baseURL: "http://h/stream",
        }),
        mock.fetchImpl,
      );
      expect(result).toBe(true);
      expect(mock.hits()).toBe(1);
    } finally {
      if (descriptor == null) delete (Object as { hasOwn?: unknown }).hasOwn;
      else Object.defineProperty(Object, "hasOwn", descriptor);
    }
  });

  it("returns false for stremio addons with a whitespace-only base URL", async () => {
    const mock = makeMockFetch(() => ok("{}"));
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "   ",
    });
    const connected = await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(connected).toBe(false);
    expect(mock.hits()).toBe(0);
  });

  it("accepts a base URL that already points at manifest.json", async () => {
    const manifest = { resources: ["streaming"] };
    const mock = makeMockFetch((url) => {
      expect(url.pathname).toBe("/stream/manifest.json");
      return ok(JSON.stringify(manifest));
    });
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream/manifest.json",
    });

    const connected = await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(connected).toBe(true);
  });

  it("accepts a base URL that points to MANIFEST.JSON with different case", async () => {
    const manifest = { id: "addon" };
    const mock = makeMockFetch((url) => {
      expect(url.pathname).toBe("/stream/manifest.json");
      return ok(JSON.stringify(manifest));
    });
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream/MANIFEST.JSON",
    });

    const connected = await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(connected).toBe(true);
  });

  it("accepts a manifest URL with a trailing slash", async () => {
    const manifest = { id: "addon" };
    const mock = makeMockFetch((url) => {
      expect(url.pathname).toBe("/stream/manifest.json");
      return ok(JSON.stringify(manifest));
    });
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream/manifest.json/",
    });
    expect(await IndexerFactory.testConnection(config, mock.fetchImpl)).toBe(true);
  });

  it("rejects stremio addons that return an invalid manifest", async () => {
    const mock = makeMockFetch(() => ok("not json"));
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream",
    });
    await expect(IndexerFactory.testConnection(config, mock.fetchImpl)).resolves.toBe(false);
  });

  it("rejects stremio addons that return non-2xx from manifest.json", async () => {
    const mock = makeMockFetch(() => ({ status: 500, body: JSON.stringify({ id: "addon" }) }));
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream",
    });
    await expect(IndexerFactory.testConnection(config, mock.fetchImpl)).resolves.toBe(false);
  });

  it("rejects stremio addons that are missing manifest keys", async () => {
    const mock = makeMockFetch(() => ok("{}"));
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream",
    });
    await expect(IndexerFactory.testConnection(config, mock.fetchImpl)).resolves.toBe(false);
  });

  it("rejects stremio addons that return an array manifest", async () => {
    const mock = makeMockFetch(() => ok("[]"));
    const config = makeIndexerConfig({
      id: "s",
      type: "stremio_addon",
      baseURL: "http://h/stream",
    });
    await expect(IndexerFactory.testConnection(config, mock.fetchImpl)).resolves.toBe(false);
  });

  it("leaves the base path untouched when the endpoint path is empty", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "t",
      type: "torznab",
      baseURL: "http://h/existing",
      endpointPath: "",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.pathname).toBe("/existing");
  });

  it("treats a slash-only endpointPath as an empty path while still probing", async () => {
    const mock = makeMockFetch(() => ok(validFeed));
    const config = makeIndexerConfig({
      id: "t",
      type: "jackett",
      baseURL: "http://h/existing",
      endpointPath: "/",
    });
    await IndexerFactory.testConnection(config, mock.fetchImpl);
    expect(mock.lastURL()!.pathname).toBe("/existing");
    expect(mock.lastURL()!.searchParams.get("t")).toBe("search");
    expect(mock.lastURL()!.searchParams.get("q")).toBe("test");
  });
});
