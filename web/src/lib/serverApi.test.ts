import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Dep mocks ────────────────────────────────────────────────────────────────
// serverApi depends on serverMode (base URL) and serverSession (CSRF + 401
// signal). Both are mocked so the tests exercise serverApi's request building,
// JSON parsing, and error handling in isolation.

const configuredServerURL = vi.fn<() => string | null>(
  () => "https://server.example",
);
const readCsrfToken = vi.fn<() => string | null>(() => null);
const notifyUnauthorized = vi.fn<() => void>();

vi.mock("./serverMode", () => ({
  configuredServerURL: () => configuredServerURL(),
}));

vi.mock("./serverSession", () => ({
  readCsrfToken: () => readCsrfToken(),
  notifyUnauthorized: () => notifyUnauthorized(),
}));

import * as api from "./serverApi";

// ── fetch test double ────────────────────────────────────────────────────────
type FakeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

function jsonResponse(body: unknown, init?: { status?: number }): FakeResponse {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function rawResponse(
  text: string,
  init?: { status?: number },
): FakeResponse {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

const fetchMock = vi.fn<typeof fetch>();

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (call == null) throw new Error("fetch was not called");
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  configuredServerURL.mockReturnValue("https://server.example");
  readCsrfToken.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // mockReset (not clearAllMocks) so any unconsumed *Once queue entry on
  // fetchMock is dropped and cannot leak into the next test.
  fetchMock.mockReset();
  configuredServerURL.mockReset();
  readCsrfToken.mockReset();
  notifyUnauthorized.mockReset();
});

describe("serverApi - request building (via serverRequest)", () => {
  it("builds a GET with credentials:'include' and no content-type / csrf header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ genres: [] }) as never);
    await api.fetchServerGenres("movie");

    const { url, init } = lastCall();
    expect(url).toBe("https://server.example/api/genres?type=movie");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-csrf-token"]).toBeUndefined();
  });

  it("sets content-type when a body is present and serializes it as JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ recommendations: [], model: null, usage: null }) as never,
    );
    await api.recommendServerAI({ prompt: "scary movies", count: 3 });

    const { init } = lastCall();
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "scary movies",
      count: 3,
    });
  });

  it("attaches x-csrf-token on unsafe methods when a token exists", async () => {
    readCsrfToken.mockReturnValue("csrf-tok-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminApproveRequest("req-1");

    const { init } = lastCall();
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-tok-123");
    // No body on this POST → no content-type header.
    expect(headers["content-type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(readCsrfToken).toHaveBeenCalled();
  });

  it("omits the csrf header on unsafe methods when no token is available", async () => {
    readCsrfToken.mockReturnValue(null);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminApproveRequest("req-1");

    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBeUndefined();
  });

  it("does NOT request a csrf token for safe GET requests", async () => {
    readCsrfToken.mockReturnValue("should-not-be-read");
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }) as never);
    await api.listRequested();
    expect(readCsrfToken).not.toHaveBeenCalled();
  });

  it("throws when Server Mode is not configured (null base URL)", async () => {
    configuredServerURL.mockReturnValue(null);
    // Note: no fetch response is queued here - serverBaseURL throws before fetch
    // is reached, and a queued mockResolvedValueOnce would otherwise leak into
    // the next test's fetch call.
    await expect(api.fetchServerGenres("movie")).rejects.toThrow(
      "Server Mode is not configured.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports and imports a portable Server Mode profile", async () => {
    const bundle: Awaited<
      ReturnType<typeof api.exportServerPortableProfile>
    > = {
      product: "YAWF Stream",
      format: "yawf-profile-portable",
      version: 1,
      createdAt: "2026-07-24T10:00:00.000Z",
      settings: [],
      watchlist: [],
      history: [],
      folders: [],
      library: [],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ bundle }) as never)
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          counts: {
            settings: 0,
            watchlist: 0,
            history: 0,
            folders: 0,
            library: 0,
          },
        }) as never,
      );

    await expect(api.exportServerPortableProfile()).resolves.toEqual(bundle);
    await expect(
      api.importServerPortableProfile(bundle, "replace"),
    ).resolves.toEqual({
      settings: 0,
      watchlist: 0,
      history: 0,
      folders: 0,
      library: 0,
    });
    expect(lastCall().url).toBe(
      "https://server.example/api/portability/import",
    );
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      mode: "replace",
      bundle,
    });
  });
});

describe("serverApi - JSON parsing & error handling", () => {
  it("returns {} (parsed) for an empty 2xx body", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse("") as never);
    // revokeServerStreamSession returns void; it must resolve, not throw.
    await expect(api.revokeServerStreamSession("s1")).resolves.toBeUndefined();
  });

  it("falls back to {} when a 2xx body is non-JSON (does not throw a parse error)", async () => {
    fetchMock.mockResolvedValueOnce(
      rawResponse("<html>proxy</html>") as never,
    );
    const genres = api.fetchServerGenres("movie");
    // parsed is {} → response.genres is undefined; this surfaces as undefined,
    // not a thrown JSON.parse error.
    await expect(genres).resolves.toBeUndefined();
  });

  it("uses parsed.error as the message on a non-ok response and sets .status", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "boom happened" }, { status: 400 }) as never,
    );
    await expect(api.fetchServerGenres("movie")).rejects.toMatchObject({
      message: "boom happened",
      status: 400,
    });
  });

  it("falls back to a status-based message when error field is missing/non-string", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 42 }, { status: 503 }) as never,
    );
    await expect(api.fetchServerGenres("movie")).rejects.toThrow(
      "Server request failed (503).",
    );
  });

  it("falls back to a status message when an error body is non-JSON (HTML 5xx)", async () => {
    fetchMock.mockResolvedValueOnce(
      rawResponse("<html>502 Bad Gateway</html>", { status: 502 }) as never,
    );
    await expect(api.fetchServerGenres("movie")).rejects.toThrow(
      "Server request failed (502).",
    );
  });

  it("calls notifyUnauthorized() exactly on a 401 and still throws", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "nope" }, { status: 401 }) as never,
    );
    await expect(api.listRequested()).rejects.toMatchObject({ status: 401 });
    expect(notifyUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT call notifyUnauthorized() on a non-401 error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "x" }, { status: 403 }) as never,
    );
    await expect(api.listRequested()).rejects.toMatchObject({ status: 403 });
    expect(notifyUnauthorized).not.toHaveBeenCalled();
  });
});

describe("fetchServerStreams", () => {
  it("encodes the imdb id and only adds season/episode when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        rows: [{ id: "r1" }],
        hasIndexers: true,
        hasDebrid: false,
      }) as never,
    );
    const res = await api.fetchServerStreams({
      imdbId: "tt 123",
      type: "series",
      season: 2,
      episode: 5,
    });
    const { url } = lastCall();
    expect(url).toBe(
      "https://server.example/api/streams/tt%20123?type=series&season=2&episode=5",
    );
    expect(res).toEqual({
      rows: [{ id: "r1" }],
      hasIndexers: true,
      hasDebrid: false,
      sourceErrors: [],
    });
  });

  it("omits season/episode when null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [], hasIndexers: false, hasDebrid: false }) as never,
    );
    await api.fetchServerStreams({
      imdbId: "tt99",
      type: "movie",
      season: null,
      episode: null,
    });
    expect(lastCall().url).toBe(
      "https://server.example/api/streams/tt99?type=movie",
    );
  });

  it("streams source rows before provider availability in one request", async () => {
    const source = {
      rows: [{ result: { infoHash: "a".repeat(40) }, cachedOn: null }],
      hasIndexers: true,
      hasDebrid: true,
      indexerErrors: [],
    };
    const ready = {
      rows: [{ result: { infoHash: "a".repeat(40) }, cachedOn: "real_debrid" }],
      hasIndexers: true,
      hasDebrid: true,
      indexerErrors: [],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(
        `${JSON.stringify({ phase: "sources", ...source })}\n${JSON.stringify({
          phase: "ready",
          ...ready,
        })}\n`,
        {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        },
      ) as never,
    );
    const phases = vi.fn();
    const result = await api.fetchServerStreams({
      imdbId: "tt99",
      type: "movie",
      onPhase: phases,
    });
    expect(lastCall().url).toBe(
      "https://server.example/api/streams/tt99?type=movie&progressive=1",
    );
    expect(phases).toHaveBeenNthCalledWith(
      1,
      "sources",
      expect.objectContaining({ rows: source.rows }),
    );
    expect(phases).toHaveBeenNthCalledWith(
      2,
      "ready",
      expect.objectContaining({ rows: ready.rows }),
    );
    expect(result.rows).toEqual(ready.rows);
  });

  it("rejects a progressive response whose cumulative chunks exceed the limit", async () => {
    const chunk = new TextEncoder().encode(
      `${JSON.stringify({
        phase: "sources",
        rows: [],
        hasIndexers: true,
        hasDebrid: true,
        padding: "x".repeat(1_000_000),
      })}\n`,
    );
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            reads++ < 10
              ? { done: false, value: chunk }
              : { done: true, value: undefined },
          cancel,
        }),
      },
    } as never);

    await expect(
      api.fetchServerStreams({
        imdbId: "tt99",
        type: "movie",
        onPhase: vi.fn(),
      }),
    ).rejects.toThrow("oversized stream-search response");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("resolveServerStream", () => {
  const row = {
    result: { infoHash: "HASH" },
    cachedOn: "real_debrid",
  } as never;

  it("posts infoHash + preferredService and returns an absolute streamURL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        stream: {
          streamURL: "/play/abc",
          title: "x",
          playbackAuthorization: `Bearer ${"A".repeat(43)}`,
        },
      }) as never,
    );
    const info = await api.resolveServerStream(row);
    const { url, init } = lastCall();
    expect(url).toBe("https://server.example/api/streams/resolve");
    expect(JSON.parse(init.body as string)).toEqual({
      infoHash: "HASH",
      preferredService: "real_debrid",
    });
    // relative path → resolved against base URL
    expect(info.streamURL).toBe("https://server.example/play/abc");
    expect(info.playbackAuthorization).toBe(`Bearer ${"A".repeat(43)}`);
  });

  it("includes media context and appends index.m3u8 when transcoding", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ stream: { streamURL: "/play/abc" } }) as never,
    );
    const info = await api.resolveServerStream(row, {
      transcode: true,
      media: { id: "m1", type: "movie" },
    });
    expect(JSON.parse(lastCall().init.body as string)).toMatchObject({
      mediaId: "m1",
      mediaType: "movie",
    });
    expect(info.streamURL).toBe("https://server.example/play/abc/index.m3u8");
  });

  it("converts an existing proxy session to HLS without double-appending", () => {
    const direct = {
      streamURL: "https://server.example/api/stream/session-1/",
      fileName: "movie.mkv",
    } as never;
    const hls = api.asServerTranscodeStream(direct);
    expect(hls.streamURL).toBe(
      "https://server.example/api/stream/session-1/index.m3u8",
    );
    expect(api.asServerTranscodeStream(hls)).toBe(hls);
  });

  it("preserves a proxy session query while adding its HLS manifest", () => {
    const direct = {
      streamURL: "https://server.example/api/stream/session-1/?token=abc",
      fileName: "movie.mkv",
    } as never;
    expect(api.asServerTranscodeStream(direct).streamURL).toBe(
      "https://server.example/api/stream/session-1/index.m3u8?token=abc",
    );
  });

  it("adds bounded client profile, resume, HDR, and subtitle options", () => {
    const direct = {
      streamURL: "https://server.example/api/stream/session-1",
      fileName: "movie.mkv",
    } as never;
    expect(
      api.asServerTranscodeStream(direct, {
        profile: "data-saver",
        startSeconds: 731.8,
        hdrPolicy: "tone-map",
        preserveSubtitles: true,
      }).streamURL,
    ).toBe(
      "https://server.example/api/stream/session-1/index.m3u8?profile=data-saver&start=731&hdr=tone-map&subtitles=preserve",
    );
  });

  it("builds a cookie-free external-player capability URL", () => {
    const token = "A".repeat(43);
    expect(api.serverExternalPlaybackURL({
      streamURL: "https://server.example/api/stream/session-1",
      playbackAuthorization: `Bearer ${token}`,
    } as never)).toBe(
      `https://server.example/api/external-stream/session-1/${token}`,
    );
  });

  it("refuses to expose an external URL without a scoped playback capability", () => {
    expect(api.serverExternalPlaybackURL({
      streamURL: "https://server.example/api/stream/session-1",
    } as never)).toBeNull();
    expect(api.serverExternalPlaybackURL({
      streamURL: "https://server.example/not-a-stream/session-1",
      playbackAuthorization: `Bearer ${"A".repeat(43)}`,
    } as never)).toBeNull();
  });

  it("preserves an already-absolute streamURL (absoluteServerURL passthrough)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        stream: { streamURL: "https://cdn.example/v.mp4" },
      }) as never,
    );
    const info = await api.resolveServerStream(row);
    expect(info.streamURL).toBe("https://cdn.example/v.mp4");
  });

  it("resolves an absolute-relative stream URL without a leading slash", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ stream: { streamURL: "play/abc" } }) as never,
    );
    const info = await api.resolveServerStream(row);
    expect(info.streamURL).toBe("https://server.example/play/abc");
  });

  it("adds fileHint season and episode to the resolve request body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ stream: { streamURL: "/play/abc" } }) as never,
    );
    await api.resolveServerStream(row, { fileHint: { season: 2, episode: 4 } });

    const body = JSON.parse(lastCall().init.body as string);
    expect(body).toMatchObject({
      season: 2,
      episode: 4,
    });
  });
});

describe("search & discovery query building", () => {
  it("searchServerMedia defaults type to 'all' and page to 1", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], page: 1, totalPages: 0, totalResults: 0 }) as never,
    );
    await api.searchServerMedia({ query: "a&b", type: null });
    expect(lastCall().url).toBe(
      "https://server.example/api/search?q=a%26b&type=all&page=1",
    );
  });

  it("searchServerMedia passes an explicit type + page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], page: 3, totalPages: 9, totalResults: 0 }) as never,
    );
    await api.searchServerMedia({ query: "x", type: "series", page: 3 });
    expect(lastCall().url).toBe(
      "https://server.example/api/search?q=x&type=series&page=3",
    );
  });

  it("fetchServerDiscoverHome hits the home endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ hero: null }) as never);
    await api.fetchServerDiscoverHome();
    expect(lastCall().url).toBe("https://server.example/api/discover/home");
  });

  it("fetchServerCategory builds type/category/page params", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], page: 1, totalPages: 1, totalResults: 0 }) as never,
    );
    await api.fetchServerCategory({ type: "movie", category: "trending" });
    expect(lastCall().url).toBe(
      "https://server.example/api/catalog/category?type=movie&category=trending&page=1",
    );
  });

  it("discoverServerMedia merges extra params after type", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], page: 1, totalPages: 1, totalResults: 0 }) as never,
    );
    await api.discoverServerMedia({
      type: "movie",
      params: { with_genres: "28", sort_by: "popularity.desc" },
    });
    expect(lastCall().url).toBe(
      "https://server.example/api/catalog/discover?type=movie&with_genres=28&sort_by=popularity.desc",
    );
  });

  it("fetchServerGenres unwraps the genres array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ genres: [{ id: 1, name: "Action" }] }) as never,
    );
    await expect(api.fetchServerGenres("movie")).resolves.toEqual([
      { id: 1, name: "Action" },
    ]);
  });

  it("fetchServerDetail builds id/type params", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ item: {}, cast: [], related: [], imdbId: null }) as never,
    );
    await api.fetchServerDetail({ id: "550", type: "movie" });
    expect(lastCall().url).toBe(
      "https://server.example/api/media/detail?id=550&type=movie",
    );
  });
});

describe("calendar / AI / subtitles", () => {
  it("fetchServerUpcomingEpisodes posts series and unwraps episodes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ episodes: [{ id: "e1" }] }) as never,
    );
    const eps = await api.fetchServerUpcomingEpisodes([{ id: "s1" } as never]);
    expect(lastCall().url).toBe("https://server.example/api/calendar/upcoming");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      series: [{ id: "s1" }],
    });
    expect(eps).toEqual([{ id: "e1" }]);
  });

  it("recommendServerAI defaults count to 8", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ recommendations: [], model: null, usage: null }) as never,
    );
    await api.recommendServerAI({ prompt: "p" });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      prompt: "p",
      count: 8,
    });
  });

  it("curateServerAI defaults count to 8", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [], unmatched: 0 }) as never,
    );
    await api.curateServerAI({ prompt: "p" });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      prompt: "p",
      count: 8,
    });
  });

  it("searchServerSubtitles posts the params object verbatim", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }) as never);
    await api.searchServerSubtitles({ imdbId: "tt1" } as never);
    expect(lastCall().url).toBe(
      "https://server.example/api/subtitles/search",
    );
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      imdbId: "tt1",
    });
  });

  it("fetchServerSubtitle posts { fileId }", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ vtt: "WEBVTT" }) as never);
    await expect(api.fetchServerSubtitle("f9")).resolves.toEqual({
      vtt: "WEBVTT",
    });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ fileId: "f9" });
  });

  it("translateServerSubtitles posts the input verbatim", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ cues: [], providerKind: "k" }) as never,
    );
    const input = { cues: [{ start: 0 }], targetLanguage: "es" } as never;
    await api.translateServerSubtitles(input);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      cues: [{ start: 0 }],
      targetLanguage: "es",
    });
  });
});

describe("admin streams + omdb", () => {
  it("revokeServerStreamSession encodes the id", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse("") as never);
    await api.revokeServerStreamSession("a/b");
    expect(lastCall().url).toBe(
      "https://server.example/api/admin/streams/a%2Fb/revoke",
    );
  });

  it("fetchServerOmdb unwraps ratings and encodes the imdb id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ratings: { imdb: "8.0" } }) as never,
    );
    await expect(api.fetchServerOmdb("tt 1")).resolves.toEqual({ imdb: "8.0" });
    expect(lastCall().url).toBe("https://server.example/api/omdb/tt%201");
  });

  it("fetchServerOmdb returns null when server has no key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ratings: null }) as never);
    await expect(api.fetchServerOmdb("tt1")).resolves.toBeNull();
  });

  it("fetchServerSeasons encodes tmdbId as a query parameter", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ seasons: [{ seasonNumber: 1 }] }) as never,
    );
    const result = await api.fetchServerSeasons({ tmdbId: 123 });
    expect(lastCall().url).toBe(
      "https://server.example/api/media/seasons?tmdbId=123",
    );
    expect(result).toEqual({ seasons: [{ seasonNumber: 1 }] });
  });

  it("fetchServerEpisodes encodes tmdbId and season as query parameters", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ episodes: [{ id: "e1" }] }) as never,
    );
    const result = await api.fetchServerEpisodes({ tmdbId: 123, season: 2 });
    expect(lastCall().url).toBe(
      "https://server.example/api/media/episodes?tmdbId=123&season=2",
    );
    expect(result).toEqual({ episodes: [{ id: "e1" }] });
  });
});

describe("household sub-profiles", () => {
  it("fetchAccountProfiles GETs the account profiles route", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profiles: [], activeProfileId: "p1" }) as never,
    );
    await api.fetchAccountProfiles();
    expect(lastCall().url).toBe(
      "https://server.example/api/account/profiles",
    );
  });

  it("createAccountProfile defaults avatarColor=null, simpleMode=true, omits empty password", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profile: { id: "p1" } }) as never,
    );
    await api.createAccountProfile({ displayName: "Kid" });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      displayName: "Kid",
      avatarColor: null,
      simpleMode: true,
    });
  });

  it("createAccountProfile includes a non-empty password and passed flags", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profile: { id: "p1" } }) as never,
    );
    await api.createAccountProfile({
      displayName: "A",
      avatarColor: "#fff",
      password: "pw",
      simpleMode: false,
    });
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      displayName: "A",
      avatarColor: "#fff",
      password: "pw",
      simpleMode: false,
    });
  });

  it("createAccountProfile omits an empty-string password", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profile: { id: "p1" } }) as never,
    );
    await api.createAccountProfile({ displayName: "A", password: "" });
    expect(
      JSON.parse(lastCall().init.body as string),
    ).not.toHaveProperty("password");
  });

  it("updateAccountProfile PATCHes the encoded id with the patch body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, profiles: [] }) as never,
    );
    await api.updateAccountProfile("id/1", { displayName: "New" });
    const { url, init } = lastCall();
    expect(init.method).toBe("PATCH");
    expect(url).toBe("https://server.example/api/account/profiles/id%2F1");
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "New" });
  });

  it("deleteAccountProfile DELETEs the encoded id (no body)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, profiles: [] }) as never,
    );
    await api.deleteAccountProfile("x");
    const { url, init } = lastCall();
    expect(init.method).toBe("DELETE");
    expect(url).toBe("https://server.example/api/account/profiles/x");
    expect(init.body).toBeUndefined();
  });

  it("setProfileMaturity POSTs the maturity sub-route with the body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, profiles: [] }) as never,
    );
    await api.setProfileMaturity("p1", { isKid: true, maturityMax: "PG-13" });
    const { url, init } = lastCall();
    expect(url).toBe(
      "https://server.example/api/account/profiles/p1/maturity",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      isKid: true,
      maturityMax: "PG-13",
    });
  });

  it("switchAccountProfile sends password only when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: null, profiles: null }) as never,
    );
    await api.switchAccountProfile("p1", "pw");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      profileId: "p1",
      password: "pw",
    });
  });

  it("switchAccountProfile omits an empty password", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ session: null, profiles: null }) as never,
    );
    await api.switchAccountProfile("p1", "");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      profileId: "p1",
    });
  });

  it("setProfilePin posts the PIN endpoint and returns refreshed profile state", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profiles: { profiles: [], activeProfileId: "p1" } }) as never,
    );
    await expect(api.setProfilePin("p 1", "1234")).resolves.toEqual({
      profiles: { profiles: [], activeProfileId: "p1" },
    });
    expect(lastCall().url).toBe("https://server.example/api/profiles/pin");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      profileId: "p 1",
      pin: "1234",
    });
  });

  it("setProfileBandwidthQuota posts a clear as capBytes:null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ profiles: { profiles: [], activeProfileId: "p1" } }) as never,
    );
    await api.setProfileBandwidthQuota("p1", null);
    expect(lastCall().url).toBe("https://server.example/api/profiles/quota");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      profileId: "p1",
      capBytes: null,
    });
  });
});

describe("title requests", () => {
  it("createRequest posts mediaId + preview", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ request: { id: "r1" } }) as never,
    );
    await api.createRequest("m1", { id: "m1" } as never);
    expect(lastCall().url).toBe("https://server.example/api/library/requests");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      mediaId: "m1",
      preview: { id: "m1" },
    });
  });

  it("listOwnRequests appends an encoded status query when given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requests: [] }) as never);
    await api.listOwnRequests("approved");
    expect(lastCall().url).toBe(
      "https://server.example/api/library/requests?status=approved",
    );
  });

  it("listOwnRequests omits the query when status is undefined", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requests: [] }) as never);
    await api.listOwnRequests();
    expect(lastCall().url).toBe(
      "https://server.example/api/library/requests",
    );
  });

  it("listRequested hits the shared approved list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }) as never);
    await api.listRequested();
    expect(lastCall().url).toBe(
      "https://server.example/api/library/requested",
    );
  });

  it("adminListRequests appends an encoded status query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requests: [] }) as never);
    await api.adminListRequests("pending");
    expect(lastCall().url).toBe(
      "https://server.example/api/admin/requests?status=pending",
    );
  });

  it("adminListRequests omits status query when no status is passed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requests: [] }) as never);
    await api.adminListRequests();
    expect(lastCall().url).toBe("https://server.example/api/admin/requests");
  });

  it("adminApproveRequest POSTs the encoded approve route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminApproveRequest("r 1");
    expect(lastCall().url).toBe(
      "https://server.example/api/admin/requests/r%201/approve",
    );
  });

  it("adminDenyRequest sends a reason body when non-blank", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminDenyRequest("r1", "  nope  ");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      reason: "  nope  ",
    });
  });

  it("adminDenyRequest sends no body for a blank/whitespace reason", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminDenyRequest("r1", "   ");
    expect(lastCall().init.body).toBeUndefined();
  });

  it("adminDenyRequest sends no body when reason is omitted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }) as never);
    await api.adminDenyRequest("r1");
    expect(lastCall().init.body).toBeUndefined();
  });
});

describe("server setup helpers", () => {
  it("saveServerSharedCredential PUTs provider/label/value", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse("") as never);
    await api.saveServerSharedCredential({
      provider: "tmdb",
      label: "My key",
      value: "secret",
    });
    const { url, init } = lastCall();
    expect(init.method).toBe("PUT");
    expect(url).toBe("https://server.example/api/admin/credentials");
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "tmdb",
      label: "My key",
      value: "secret",
    });
  });

  it("saveServerSharedCredential defaults a blank label to 'Shared'", async () => {
    fetchMock.mockResolvedValueOnce(rawResponse("") as never);
    await api.saveServerSharedCredential({
      provider: "omdb",
      label: "   ",
      value: "v",
    });
    expect(JSON.parse(lastCall().init.body as string)).toMatchObject({
      label: "Shared",
    });
  });

  it("createServerInvite trims a label and omits an empty one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ token: "T", invite: { id: "i1" } }) as never,
    );
    await api.createServerInvite({
      label: "   ",
      role: "member",
      simpleMode: true,
      maxUses: 3,
      expiresInSeconds: 600,
    });
    const body = JSON.parse(lastCall().init.body as string);
    expect(body.label).toBeUndefined();
    expect(body).toMatchObject({
      role: "member",
      simpleMode: true,
      maxUses: 3,
      expiresInSeconds: 600,
    });
  });

  it("createServerInvite keeps a non-empty trimmed label and returns the token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ token: "T", invite: { id: "i1" } }) as never,
    );
    const res = await api.createServerInvite({
      label: "  Family  ",
      role: "admin",
      simpleMode: false,
      maxUses: 1,
      expiresInSeconds: 60,
    });
    expect(JSON.parse(lastCall().init.body as string).label).toBe("Family");
    expect(res).toEqual({ token: "T", invite: { id: "i1" } });
  });

  it("fetchServerAdminHealth GETs the health route", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        counts: { credentials: 2, profiles: 1, activeInvites: 0 },
      }) as never,
    );
    const res = await api.fetchServerAdminHealth();
    expect(lastCall().url).toBe("https://server.example/api/admin/health");
    expect(res.counts.credentials).toBe(2);
  });
});
