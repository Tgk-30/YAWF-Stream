// Tests for TorBoxService - the fetchImpl-injection mock pattern mirrors
// AllDebridService.test.ts. The TorBox client uses a Bearer-only auth header,
// the /torrents/checkcached cache check (hash-keyed object response, chunked at
// 100), /torrents/createtorrent add, the /torrents/mylist snapshot + best-file
// selection + /torrents/requestdl stream-URL flow, and /user/me account info.

import { describe, expect, it } from "vitest";
import { TorBoxService } from "./TorBoxService";
import { DebridError, type FetchImpl } from "./types";

interface MockResponse {
  status: number;
  body: string;
}

interface CapturedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeMockFetch(handler: (req: CapturedRequest) => MockResponse): {
  fetchImpl: FetchImpl;
  requests: CapturedRequest[];
  byPath: (path: string) => CapturedRequest | undefined;
  allByPath: (path: string) => CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const captured: CapturedRequest = {
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ?? "",
    };
    requests.push(captured);
    const { status, body } = handler(captured);
    return { status, text: async () => body };
  };
  return {
    fetchImpl,
    requests,
    byPath: (path) => requests.find((r) => r.url.pathname === path),
    allByPath: (path) => requests.filter((r) => r.url.pathname === path),
  };
}

const ok = (body: string): MockResponse => ({ status: 200, body });

// MARK: - serviceType

describe("TorBoxService serviceType", () => {
  it("is torbox", () => {
    const service = new TorBoxService("tb-token", makeMockFetch(() => ok("{}")).fetchImpl);
    expect(service.serviceType).toBe("torbox");
  });
});

// MARK: - checkCache

describe("TorBoxService checkCache", () => {
  it("short-circuits to empty for empty input without hitting network", async () => {
    let didCallNetwork = false;
    const mock = makeMockFetch(() => {
      didCallNetwork = true;
      return ok("{}");
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache([]);

    expect(Object.keys(result).length).toBe(0);
    expect(didCallNetwork).toBe(false);
  });

  it("maps present hash keys to cached and absent ones to notCached (lowercased)", async () => {
    const mock = makeMockFetch((req) => {
      expect(req.url.pathname).toBe("/v1/api/torrents/checkcached");
      // Only ABCDEF is present in the data object (keyed by lowercased hash).
      return ok(JSON.stringify({ data: { abcdef: { name: "Movie" } } }));
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["ABCDEF", "123456"]);

    expect(result.abcdef).toEqual({
      kind: "cached",
      fileId: null,
      fileName: null,
      fileSize: null,
    });
    expect(result["123456"]).toEqual({ kind: "notCached" });
  });

  it("sends the comma-joined hashes and format=object query", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: {} })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await service.checkCache(["AABB", "CCDD"]);

    const req = mock.byPath("/v1/api/torrents/checkcached")!;
    expect(req.method).toBe("GET");
    expect(req.url.searchParams.get("hash")).toBe("aabb,ccdd");
    expect(req.url.searchParams.get("format")).toBe("object");
    expect(req.headers.Authorization).toBe("Bearer tb-token");
  });

  it("returns notCached for every hash when data is an empty object", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: {} })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa", "bbb"]);

    expect(result.aaa).toEqual({ kind: "notCached" });
    expect(result.bbb).toEqual({ kind: "notCached" });
  });

  it("returns notCached for every hash when data is [] (nothing cached)", async () => {
    // TorBox returns `data: []` (an array) when nothing in the batch is cached.
    // That is a definitive answer, not an unknown: every hash must be written
    // as notCached so cached-only filtering and badges work.
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: [] })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa", "bbb"]);

    expect(result.aaa).toEqual({ kind: "notCached" });
    expect(result.bbb).toEqual({ kind: "notCached" });
  });

  it("returns notCached for every hash when data is null (nothing cached)", async () => {
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ success: true, error: null, data: null })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa", "bbb"]);

    expect(result.aaa).toEqual({ kind: "notCached" });
    expect(result.bbb).toEqual({ kind: "notCached" });
  });

  it("returns notCached for every hash when data is missing under success:true", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ success: true })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa"]);

    expect(result.aaa).toEqual({ kind: "notCached" });
  });

  it("matches cached hashes even when the response keys are uppercased", async () => {
    // Defensive: if TorBox ever echoes keys in a different case, the lookup
    // must not misread a cached torrent as uncached.
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { ABCDEF: { name: "Movie" } } })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["abcdef", "123456"]);

    expect(result.abcdef).toEqual({
      kind: "cached",
      fileId: null,
      fileName: null,
      fileSize: null,
    });
    expect(result["123456"]).toEqual({ kind: "notCached" });
  });

  it("leaves results unwritten when the envelope reports failure", async () => {
    // success:false (rate limit, bad request) is NOT a definitive answer -
    // omit the hashes so callers render "unavailable" instead of lying.
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ success: false, error: "RATE_LIMIT", data: null })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa"]);

    expect(Object.keys(result)).toEqual([]);
  });

  it("leaves results unwritten when the body is not a JSON object", async () => {
    const mock = makeMockFetch(() => ok("not json"));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const result = await service.checkCache(["aaa"]);

    expect(Object.keys(result)).toEqual([]);
  });

  it("chunks hashes into batches of 100 (220 hashes -> 3 requests)", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: {} })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const hashes = Array.from({ length: 220 }, (_, i) => `hash${i}`);
    const result = await service.checkCache(hashes);

    const reqs = mock.allByPath("/v1/api/torrents/checkcached");
    expect(reqs.length).toBe(3);
    // Batch sizes: 100, 100, 20.
    expect(reqs[0].url.searchParams.get("hash")!.split(",").length).toBe(100);
    expect(reqs[1].url.searchParams.get("hash")!.split(",").length).toBe(100);
    expect(reqs[2].url.searchParams.get("hash")!.split(",").length).toBe(20);
    // All 220 hashes resolved (to notCached, since data:{} has no keys).
    expect(Object.keys(result).length).toBe(220);
  });
});

// MARK: - addMagnet

describe("TorBoxService addMagnet", () => {
  it("posts the magnet body and returns the torrent_id as a string", async () => {
    const mock = makeMockFetch((req) => {
      expect(req.url.pathname).toBe("/v1/api/torrents/createtorrent");
      expect(req.method).toBe("POST");
      return ok(JSON.stringify({ data: { torrent_id: 4242 } }));
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const id = await service.addMagnet("DEADBEEF");

    expect(id).toBe("4242");
    const req = mock.byPath("/v1/api/torrents/createtorrent")!;
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // magnet:?xt=urn:btih:DEADBEEF, url-encoded into the body.
    expect(req.body).toContain("magnet=");
    expect(decodeURIComponent(req.body)).toContain("magnet:?xt=urn:btih:DEADBEEF");
  });

  it("accepts a numeric-STRING torrent_id (TorBox returns it either way)", async () => {
    // Regression: the old `typeof === "number"` guard rejected a valid numeric
    // string. int64Value coerces "4242" → 4242, so it must be accepted.
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { torrent_id: "4242" } })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    expect(await service.addMagnet("DEADBEEF")).toBe("4242");
  });

  it("throws downloadFailed when torrent_id is non-numeric / uncoercible", async () => {
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { torrent_id: "not-a-number" } })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.addMagnet("DEADBEEF")).rejects.toMatchObject({
      kind: "downloadFailed",
    });
  });

  it("throws downloadFailed when torrent_id is missing", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: {} })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.addMagnet("DEADBEEF")).rejects.toMatchObject({
      kind: "downloadFailed",
    });
  });

  it("throws downloadFailed when data is absent", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ ok: true })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.addMagnet("DEADBEEF")).rejects.toMatchObject({
      kind: "downloadFailed",
    });
  });

  it("throws downloadFailed when data is an array (asObject null)", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: [] })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.addMagnet("DEADBEEF")).rejects.toMatchObject({
      kind: "downloadFailed",
    });
  });
});

// MARK: - getStreamURL

describe("TorBoxService getStreamURL", () => {
  it("maps an exact Stremio selection by unique filename, not provider file id or size", async () => {
    let requestdlQuery: URLSearchParams | null = null;
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(JSON.stringify({ data: {
          id: 88,
          download_state: "completed",
          files: [
            { id: 17, name: "Large.Movie.mkv", size: 9_000_000_000 },
            { id: 903, name: "Requested.Small.avi", size: 100_000_000 },
          ],
        } }));
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        requestdlQuery = req.url.searchParams;
        return ok(JSON.stringify({ data: "https://tb.example/requested" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    const stream = await service.getStreamURL("88", {
      fileIndex: 0,
      fileName: "Requested.Small.avi",
    });

    expect(stream.fileName).toBe("Requested.Small.avi");
    expect(requestdlQuery!.get("file_id")).toBe("903");
  });

  it("does not fall back to TorBox file zero for an unmatched exact selection", async () => {
    const mock = makeMockFetch((req) => req.url.pathname.endsWith("/mylist")
      ? ok(JSON.stringify({ data: { id: 88, download_state: "completed", files: [] } }))
      : ok(JSON.stringify({ data: "https://tb.example/wrong" })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    await expect(service.getStreamURL("88", {
      fileIndex: 0,
      fileName: "Requested.Small.avi",
    })).rejects.toMatchObject({ kind: "fileSelectionFailed" });
  });
  it("selects the best video file and returns a parsed StreamInfo", async () => {
    let requestdlQuery: URLSearchParams | null = null;
    const mock = makeMockFetch((req) => {
      switch (req.url.pathname) {
        case "/v1/api/torrents/mylist":
          return ok(
            JSON.stringify({
              data: {
                id: 77,
                download_state: "completed",
                files: [
                  { id: 0, name: "Movie.2026.sample.mkv", size: 500000 },
                  { id: 1, name: "Movie.2026.1080p.BluRay.x264.mkv", size: 4000000000 },
                  { id: 2, name: "readme.txt", size: 100 },
                ],
              },
            }),
          );
        case "/v1/api/torrents/requestdl":
          requestdlQuery = req.url.searchParams;
          return ok(JSON.stringify({ data: "https://tb.example/direct/movie.mkv" }));
        default:
          return { status: 404, body: "{}" };
      }
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const stream = await service.getStreamURL("77");

    expect(stream.streamURL).toBe("https://tb.example/direct/movie.mkv");
    expect(stream.fileName).toBe("Movie.2026.1080p.BluRay.x264.mkv");
    expect(stream.quality).toBe("1080p");
    expect(stream.codec).toBe("H.264");
    expect(stream.source).toBe("BluRay");
    expect(stream.sizeBytes).toBe(4_000_000_000);
    expect(stream.debridService).toBe("TB");
    // The selected file's id (1) is sent to requestdl with zip_link=false.
    expect(requestdlQuery!.get("file_id")).toBe("1");
    expect(requestdlQuery!.get("torrent_id")).toBe("77");
    expect(requestdlQuery!.get("zip_link")).toBe("false");
  });

  it("falls back to file_id=0 / 'TorBox Stream' when a terminal state has no files", async () => {
    let requestdlQuery: URLSearchParams | null = null;
    const mock = makeMockFetch((req) => {
      switch (req.url.pathname) {
        case "/v1/api/torrents/mylist":
          return ok(
            JSON.stringify({ data: { id: 5, download_state: "cached", files: [] } }),
          );
        case "/v1/api/torrents/requestdl":
          requestdlQuery = req.url.searchParams;
          return ok(JSON.stringify({ data: "https://tb.example/zero" }));
        default:
          return { status: 404, body: "{}" };
      }
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const stream = await service.getStreamURL("5");

    expect(stream.streamURL).toBe("https://tb.example/zero");
    expect(stream.fileName).toBe("TorBox Stream");
    expect(stream.sizeBytes).toBe(0);
    expect(requestdlQuery!.get("file_id")).toBe("0");
  });

  it("throws downloadFailed when the torrent is stalled", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({ data: { id: 9, download_state: "stalled (no seeds)", files: [] } }),
        );
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    let caught: DebridError | null = null;
    try {
      await service.getStreamURL("9");
    } catch (e) {
      caught = e as DebridError;
    }
    expect(caught?.kind).toBe("downloadFailed");
    expect(caught?.equals(DebridError.downloadFailed("Torrent stalled: stalled (no seeds)"))).toBe(true);
  });

  it("polls until files appear, sleeping between attempts", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        call++;
        // First two snapshots: downloading, no files. Third: a file appears.
        if (call < 3) {
          return ok(
            JSON.stringify({ data: { id: 1, download_state: "downloading", files: [] } }),
          );
        }
        return ok(
          JSON.stringify({
            data: {
              id: 1,
              download_state: "downloading",
              files: [{ id: 3, name: "Show.S01E01.720p.WEB-DL.mkv", size: 900 }],
            },
          }),
        );
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        return ok(JSON.stringify({ data: "https://tb.example/poll" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl, async (ms) => {
      sleeps.push(ms);
    });
    const stream = await service.getStreamURL("1");

    expect(stream.streamURL).toBe("https://tb.example/poll");
    expect(stream.fileName).toBe("Show.S01E01.720p.WEB-DL.mkv");
    // Two no-file snapshots before the third succeeded -> two 1000ms sleeps.
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("throws downloadFailed (not ready) when no files appear and state stays non-terminal", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({ data: { id: 1, download_state: "downloading", files: [] } }),
        );
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    let caught: DebridError | null = null;
    try {
      await service.getStreamURL("1");
    } catch (e) {
      caught = e as DebridError;
    }
    expect(caught?.kind).toBe("downloadFailed");
    expect(caught?.equals(DebridError.downloadFailed("Torrent not ready: downloading"))).toBe(true);
  });

  it("reports 'unknown' state when download_state is absent and no files appear", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(JSON.stringify({ data: { id: 1, files: [] } }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    await expect(service.getStreamURL("1")).rejects.toMatchObject({
      kind: "downloadFailed",
      detail: "Torrent not ready: unknown",
    });
  });

  it("throws noFilesAvailable when requestdl returns a non-string data", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({
            data: {
              id: 1,
              download_state: "completed",
              files: [{ id: 0, name: "Movie.1080p.mkv", size: 100 }],
            },
          }),
        );
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        return ok(JSON.stringify({ data: { url: "nope" } }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    await expect(service.getStreamURL("1")).rejects.toMatchObject({
      kind: "noFilesAvailable",
    });
  });

  it("throws torrentNotFound when mylist body is not a JSON object", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") return ok("garbage");
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    let caught: DebridError | null = null;
    try {
      await service.getStreamURL("42");
    } catch (e) {
      caught = e as DebridError;
    }
    expect(caught?.kind).toBe("torrentNotFound");
    expect(caught?.equals(DebridError.torrentNotFound("42"))).toBe(true);
  });

  it("throws torrentNotFound when data is neither an object nor an array", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(JSON.stringify({ data: "oops" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    await expect(service.getStreamURL("42")).rejects.toMatchObject({
      kind: "torrentNotFound",
      torrentId: "42",
    });
  });

  it("matches the torrent by id when data is a list", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({
            data: [
              { id: 1, download_state: "completed", files: [{ id: 0, name: "Other.mkv", size: 1 }] },
              {
                id: 99,
                download_state: "completed",
                files: [{ id: 7, name: "Target.1080p.mkv", size: 5000 }],
              },
            ],
          }),
        );
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        return ok(JSON.stringify({ data: "https://tb.example/target" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const stream = await service.getStreamURL("99");

    expect(stream.fileName).toBe("Target.1080p.mkv");
    const requestdl = mock.byPath("/v1/api/torrents/requestdl")!;
    expect(requestdl.url.searchParams.get("file_id")).toBe("7");
  });

  it("falls back to the first list entry when no id matches", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({
            data: [
              {
                id: 1,
                download_state: "completed",
                files: [{ id: 0, name: "First.1080p.mkv", size: 5000 }],
              },
              {
                id: 2,
                download_state: "completed",
                files: [{ id: 5, name: "Second.1080p.mkv", size: 5000 }],
              },
            ],
          }),
        );
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        return ok(JSON.stringify({ data: "https://tb.example/first" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    // "abc" is not a parseable int, so int64Value(torrentId) is null and the
    // matcher is skipped -> first entry wins.
    const stream = await service.getStreamURL("abc");

    expect(stream.fileName).toBe("First.1080p.mkv");
  });

  it("uses short_name when name is missing in a file entry", async () => {
    const mock = makeMockFetch((req) => {
      if (req.url.pathname === "/v1/api/torrents/mylist") {
        return ok(
          JSON.stringify({
            data: {
              id: 1,
              download_state: "completed",
              files: [{ id: 0, short_name: "Fallback.1080p.mkv", size: 10 }],
            },
          }),
        );
      }
      if (req.url.pathname === "/v1/api/torrents/requestdl") {
        return ok(JSON.stringify({ data: "https://tb.example/sn" }));
      }
      return { status: 404, body: "{}" };
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const stream = await service.getStreamURL("1");

    expect(stream.fileName).toBe("Fallback.1080p.mkv");
  });
});

// MARK: - getAccountInfo

describe("TorBoxService getAccountInfo", () => {
  it("decodes email, premium plan and expiry", async () => {
    const mock = makeMockFetch((req) => {
      expect(req.url.pathname).toBe("/v1/api/user/me");
      return ok(
        JSON.stringify({
          data: {
            email: "tb@example.com",
            plan: 2,
            premium_expires_at: "2030-01-01T00:00:00Z",
          },
        }),
      );
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const info = await service.getAccountInfo();

    expect(info.username).toBe("tb@example.com");
    expect(info.email).toBe("tb@example.com");
    expect(info.isPremium).toBe(true);
    expect(info.premiumExpiry).toEqual(new Date("2030-01-01T00:00:00Z"));
  });

  it("defaults to Unknown email, not premium, null expiry for a bare account", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: {} })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const info = await service.getAccountInfo();

    expect(info.username).toBe("Unknown");
    expect(info.email).toBe("Unknown");
    expect(info.isPremium).toBe(false);
    expect(info.premiumExpiry).toBeNull();
  });

  it("treats an unparseable premium_expires_at as null", async () => {
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { email: "x@y.z", plan: 1, premium_expires_at: "not-a-date" } })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const info = await service.getAccountInfo();

    expect(info.isPremium).toBe(true);
    expect(info.premiumExpiry).toBeNull();
  });

  it("treats plan 0 as not premium", async () => {
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { email: "free@y.z", plan: 0 } })),
    );
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    const info = await service.getAccountInfo();

    expect(info.isPremium).toBe(false);
  });

  it("throws invalidToken when data is missing", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ ok: true })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.getAccountInfo()).rejects.toMatchObject({
      kind: "invalidToken",
    });
  });

  it("throws invalidToken when data is an array", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ data: [] })));
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.getAccountInfo()).rejects.toMatchObject({
      kind: "invalidToken",
    });
  });
});

// MARK: - HTTP error mapping

describe("TorBoxService HTTP errors", () => {
  it("maps 401 to invalidToken", async () => {
    const mock = makeMockFetch(() => ({ status: 401, body: "{}" }));
    const service = new TorBoxService("bad", mock.fetchImpl);
    await expect(service.getAccountInfo()).rejects.toMatchObject({
      kind: "invalidToken",
    });
  });

  it("maps 403 to invalidToken", async () => {
    const mock = makeMockFetch(() => ({ status: 403, body: "forbidden" }));
    const service = new TorBoxService("bad", mock.fetchImpl);
    await expect(service.getAccountInfo()).rejects.toMatchObject({
      kind: "invalidToken",
    });
  });

  it("maps a non-auth HTTP error to httpError carrying status and body", async () => {
    const mock = makeMockFetch(() => ({ status: 500, body: "server boom" }));
    const service = new TorBoxService("tb-token", mock.fetchImpl);

    let caught: DebridError | null = null;
    try {
      await service.getAccountInfo();
    } catch (e) {
      caught = e as DebridError;
    }
    expect(caught?.equals(DebridError.httpError(500, "server boom"))).toBe(true);
  });
});

// MARK: - validateToken

describe("TorBoxService validateToken", () => {
  it("returns true for a healthy account", async () => {
    const mock = makeMockFetch(() =>
      ok(JSON.stringify({ data: { email: "ok@x.y", plan: 1 } })),
    );
    const service = new TorBoxService("good", mock.fetchImpl);
    expect(await service.validateToken()).toBe(true);
  });

  it("returns false when account info throws (401)", async () => {
    const mock = makeMockFetch(() => ({ status: 401, body: "{}" }));
    const service = new TorBoxService("bad", mock.fetchImpl);
    expect(await service.validateToken()).toBe(false);
  });

  it("returns false when the user payload is empty (invalidToken)", async () => {
    const mock = makeMockFetch(() => ok(JSON.stringify({ ok: true })));
    const service = new TorBoxService("bad", mock.fetchImpl);
    expect(await service.validateToken()).toBe(false);
  });
});

// MARK: - unrestrict / selectFiles

describe("TorBoxService unrestrict", () => {
  it("returns an absolute URL unchanged", async () => {
    const service = new TorBoxService("tb-token", makeMockFetch(() => ok("{}")).fetchImpl);
    expect(await service.unrestrict("https://tb.example/file.mkv")).toBe(
      "https://tb.example/file.mkv",
    );
  });

  it("throws downloadFailed for a non-absolute link", async () => {
    const service = new TorBoxService("tb-token", makeMockFetch(() => ok("{}")).fetchImpl);
    await expect(service.unrestrict("not a url")).rejects.toMatchObject({
      kind: "downloadFailed",
    });
  });
});

describe("TorBoxService selectFiles", () => {
  it("is a no-op that resolves without any network call", async () => {
    let called = false;
    const mock = makeMockFetch(() => {
      called = true;
      return ok("{}");
    });
    const service = new TorBoxService("tb-token", mock.fetchImpl);
    await expect(service.selectFiles("1", [0])).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});
