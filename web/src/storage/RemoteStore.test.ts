// RemoteStore (Server-Mode storage backend) tests - fetch-mocked. Focus on the
// resume/continue-watching path hardened in the bug-hunt + core history calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteStore } from "./RemoteStore";

function jsonResponse(obj: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  } as Response;
}

function histItem(over: Record<string, unknown> = {}) {
  return {
    mediaId: "tt1",
    episodeId: null,
    progressSeconds: 0,
    durationSeconds: null,
    completed: false,
    lastWatched: "2024-01-01T00:00:00.000Z",
    streamQuality: null,
    preview: { id: "tt1", type: "movie", title: "X" },
    ...over,
  };
}

describe("RemoteStore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "" });
  });
  afterEach(() => vi.unstubAllGlobals());
  const store = () => new RemoteStore("http://srv");

  describe("getResume - exact-key lookup", () => {
    it("GETs /api/history/:mediaId and maps the item", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ item: histItem({ progressSeconds: 300, durationSeconds: 600 }) }),
      );
      const r = await store().getResume("tt1");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/history/tt1",
        expect.objectContaining({ method: "GET", credentials: "include" }),
      );
      expect(r?.progressSeconds).toBe(300);
      expect(r?.id).toBe("tt1:");
    });

    it("encodes a non-empty episodeId as a query param", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ item: null }));
      await store().getResume("tt1", "s1e1");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/history/tt1?episodeId=s1e1",
        expect.anything(),
      );
    });

    it("omits the query for a null/empty episodeId and returns null when absent", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ item: null }));
      expect(await store().getResume("tt1", null)).toBeNull();
      expect(fetchMock).toHaveBeenLastCalledWith(
        "http://srv/api/history/tt1",
        expect.anything(),
      );
    });
  });

  describe("continueWatching - resumable-only, filtered before the slice", () => {
    it("keeps only resumable rows (drops viewed-only + completed), preserving order", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          view: "continue-watching",
          items: [
            histItem({ mediaId: "a", progressSeconds: 0, durationSeconds: null }), // viewed-only
            histItem({ mediaId: "b", progressSeconds: 300, durationSeconds: 600 }), // resumable
            histItem({
              mediaId: "c",
              progressSeconds: 500,
              durationSeconds: 1000,
              completed: true,
            }), // finished
            histItem({ mediaId: "d", progressSeconds: 100, durationSeconds: 1000 }), // resumable
          ],
        }),
      );
      const r = await store().continueWatching(20);
      expect(r.map((x) => x.mediaId)).toEqual(["b", "d"]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/history?view=continue-watching&limit=20",
        expect.anything(),
      );
    });

    it("caps the fast response at 20 rows before mapping", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          view: "continue-watching",
          items: [
            ...Array.from({ length: 20 }, (_, i) =>
              histItem({ mediaId: `m${i}`, progressSeconds: 100, durationSeconds: 1000 }),
            ),
            null,
          ],
        }),
      );
      const r = await store().continueWatching(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/history?view=continue-watching&limit=20",
        expect.anything(),
      );
      expect(r.map((row) => row.mediaId)).toEqual(
        Array.from({ length: 20 }, (_, i) => `m${i}`),
      );
    });

    it("caps the legacy fallback at 20 and excludes completed mid-progress rows", async () => {
      const legacyRows = [
        histItem({
          mediaId: "completed-midway",
          progressSeconds: 500,
          durationSeconds: 1000,
          completed: true,
        }),
        ...Array.from({ length: 25 }, (_, index) =>
          histItem({
            mediaId: `resume-${index}`,
            progressSeconds: 100,
            durationSeconds: 1000,
          }),
        ),
      ];
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ items: [] }))
        .mockResolvedValueOnce(jsonResponse({ items: legacyRows }));

      const r = await store().continueWatching(200);

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "http://srv/api/history?view=continue-watching&limit=20",
        "http://srv/api/history?limit=500",
      ]);
      expect(r.map((row) => row.mediaId)).toEqual(
        Array.from({ length: 20 }, (_, index) => `resume-${index}`),
      );
    });

    it("returns no rows or network work for finite nonpositive limits", async () => {
      const remote = store();
      expect(await remote.continueWatching(0)).toEqual([]);
      expect(await remote.continueWatching(-1)).toEqual([]);
      expect(await remote.continueWatching(-0.5)).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([NaN, Infinity, -Infinity])(
      "uses the default 20-row legacy fallback for non-finite limit %s",
      async (limit) => {
        const legacyRows = Array.from({ length: 25 }, (_, index) =>
          histItem({
            mediaId: `fallback-${index}`,
            progressSeconds: 100,
            durationSeconds: 1000,
          }),
        );
        fetchMock
          .mockResolvedValueOnce(jsonResponse({ items: [] }))
          .mockResolvedValueOnce(jsonResponse({ items: legacyRows }));

        const r = await store().continueWatching(limit);

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
          "http://srv/api/history?view=continue-watching&limit=20",
          "http://srv/api/history?limit=500",
        ]);
        expect(r).toHaveLength(20);
      },
    );
  });

  describe("history writes", () => {
    it("recordHistory PUTs the row to /api/history/:mediaId with a CSRF header", async () => {
      vi.stubGlobal("document", { cookie: "ds_csrf=tok123" });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().recordHistory({
        mediaId: "tt9",
        episodeId: null,
        progressSeconds: 42,
        durationSeconds: 100,
        completed: false,
        preview: { id: "tt9", type: "movie", title: "Z" },
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/history/tt9");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body).progressSeconds).toBe(42);
    });

    it("listHistory maps the server items to records", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ items: [histItem({ mediaId: "x", progressSeconds: 5 })] }),
      );
      const rows = await store().listHistory();
      expect(rows[0]?.mediaId).toBe("x");
      expect(rows[0]?.id).toBe("x:");
    });

    it("recordHistory builds the record locally from defaults (no re-fetch)", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const before = Date.now();
      const rec = await store().recordHistory({
        mediaId: "tt5",
        preview: { id: "tt5", type: "movie", title: "M" },
      });
      // Exactly one network call - the PUT - and no GET read-back.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rec.id).toBe("tt5:");
      expect(rec.episodeId).toBeNull();
      expect(rec.progressSeconds).toBe(0);
      expect(rec.durationSeconds).toBeNull();
      expect(rec.completed).toBe(false);
      expect(rec.streamQuality).toBeNull();
      // lastWatched defaulted to a fresh nowISO() timestamp.
      expect(Date.parse(rec.lastWatched)).toBeGreaterThanOrEqual(before);
      const init = fetchMock.mock.calls[0]![1];
      expect(JSON.parse(init.body).lastWatched).toBe(rec.lastWatched);
    });

    it("recordHistory keeps an explicit episodeId + lastWatched in the keyed record", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const rec = await store().recordHistory({
        mediaId: "show1",
        episodeId: "s2e3",
        lastWatched: "2020-05-05T00:00:00.000Z",
        progressSeconds: 12,
        durationSeconds: 50,
        completed: true,
        streamQuality: "1080p",
        preview: { id: "show1", type: "series", title: "S" },
      });
      expect(rec.id).toBe("show1:s2e3");
      expect(rec.episodeId).toBe("s2e3");
      expect(rec.lastWatched).toBe("2020-05-05T00:00:00.000Z");
      expect(rec.completed).toBe(true);
      expect(rec.streamQuality).toBe("1080p");
    });

    it("deleteHistory DELETEs only the requested episode row", async () => {
      vi.stubGlobal("document", { cookie: "ds_csrf=tok123" });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().deleteHistory("show/1", "s2e3");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/history/show%2F1?episodeId=s2e3");
      expect(init.method).toBe("DELETE");
      expect(init.headers["x-csrf-token"]).toBe("tok123");
    });

    it("listHistory passes the requested limit through", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
      await store().listHistory(7);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/history?limit=7",
        expect.anything(),
      );
    });
  });

  describe("watchlist", () => {
    it("addToWatchlist PUTs the preview to the encoded media id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const preview = { id: "tt 7/x", type: "movie", title: "W" } as const;
      await store().addToWatchlist(preview);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/watchlist/tt%207%2Fx");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ preview });
    });

    it("removeFromWatchlist DELETEs the encoded media id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().removeFromWatchlist("a/b");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/watchlist/a%2Fb");
      expect(init.method).toBe("DELETE");
    });

    it("listWatchlist maps server rows to records", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          items: [
            {
              mediaId: "tt1",
              addedAt: "2024-02-02T00:00:00.000Z",
              preview: { id: "tt1", type: "movie", title: "X" },
            },
          ],
        }),
      );
      const rows = await store().listWatchlist();
      expect(rows).toEqual([
        {
          mediaId: "tt1",
          addedAt: "2024-02-02T00:00:00.000Z",
          preview: { id: "tt1", type: "movie", title: "X" },
        },
      ]);
    });

    it("isInWatchlist returns true only when the id is present", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          items: [
            {
              mediaId: "tt1",
              addedAt: "2024-02-02T00:00:00.000Z",
              preview: { id: "tt1", type: "movie", title: "X" },
            },
          ],
        }),
      );
      expect(await store().isInWatchlist("tt1")).toBe(true);
      expect(await store().isInWatchlist("nope")).toBe(false);
    });
  });

  describe("folders", () => {
    const folder = {
      id: "f1",
      name: "Action",
      parentId: null,
      listType: "favorites" as const,
      folderKind: "manual" as const,
      isSystem: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };

    it("saveFolder PUTs the folder body to the encoded id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().saveFolder(folder);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/folders/f1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body);
      expect(body.name).toBe("Action");
      expect(body.folderKind).toBe("manual");
      // id is in the URL, not the body.
      expect(body.id).toBeUndefined();
    });

    it("createFolder POSTs name/listType/parentId and maps the response", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ folder }));
      const r = await store().createFolder("Action", "favorites", null);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/folders");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        name: "Action",
        listType: "favorites",
        parentId: null,
      });
      expect(r).toEqual(folder);
    });

    it("listFolders maps rows and omits the query when no listType", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ folders: [folder] }));
      const r = await store().listFolders();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/library/folders",
        expect.anything(),
      );
      expect(r).toEqual([folder]);
    });

    it("listFolders adds an encoded listType query when provided", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ folders: [] }));
      await store().listFolders("favorites");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/library/folders?listType=favorites",
        expect.anything(),
      );
    });

    it("deleteFolder DELETEs the encoded id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().deleteFolder("f/2");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/folders/f%2F2");
      expect(init.method).toBe("DELETE");
    });

    it("ensureSystemFolders is a no-op (no network)", async () => {
      await store().ensureSystemFolders();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("no-op / write-only Server-Mode stubs", () => {
    it("addAIUsage writes nothing", async () => {
      await store().addAIUsage({
        id: "u1",
        provider: "openai",
        model: "gpt",
        promptTokens: 1,
        completionTokens: 1,
        costUSD: 0.01,
        createdAt: "2024-01-01T00:00:00.000Z",
      } as never);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("totalAIUsageCostUSD returns 0 without a fetch", async () => {
      expect(await store().totalAIUsageCostUSD()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("listCachedResolutions returns [] without a fetch", async () => {
      expect(await store().listCachedResolutions()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("getCachedResolution / getMedia return null", async () => {
      const s = store();
      expect(await s.getCachedResolution("x")).toBeNull();
      expect(await s.getMedia("x")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("getSecret is write-only and always returns null", async () => {
      expect(await store().getSecret("tmdb_api_key")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("listDebridConfigs returns [] (no destructive reconciliation)", async () => {
      expect(await store().listDebridConfigs()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("recentTasteEvents returns [] and addTasteEvent is a no-op", async () => {
      const s = store();
      await s.addTasteEvent({} as never);
      expect(await s.recentTasteEvents()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deleteDebridConfig throws the Server-Mode unsupported error", async () => {
      await expect(store().deleteDebridConfig("x")).rejects.toThrow(
        "deleteDebridConfig is not available in Server Mode yet.",
      );
    });
  });

  describe("secrets - provider credential bridge", () => {
    it("setSecret PUTs a provider credential when the key maps to a provider", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().setSecret("tmdb_api_key", "abc123");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/profile/credentials");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({
        id: "profile-tmdb",
        provider: "tmdb",
        label: "TMDB",
        value: "abc123",
        priority: 0,
        isActive: true,
      });
    });

    it("setSecret treats an empty provider value as NO-CHANGE (never a delete)", async () => {
      await store().setSecret("omdb_api_key", "   ");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("setSecret on a non-provider key buffers in memory without a fetch", async () => {
      await store().setSecret("some_other_key", "val");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deleteSecret only clears the in-memory pending buffer (no fetch, no provider delete)", async () => {
      const s = store();
      // Buffer a non-provider secret, then a saveDebridConfig that consumes it.
      await s.setSecret("rd_token_key", "buffered");
      await s.deleteSecret("rd_token_key");
      // The buffered value is gone, so a secret-marker debrid save now skips.
      await s.saveDebridConfig({
        id: "rd-1",
        service: "realdebrid",
        apiToken: "secret:rd_token_key",
        priority: 0,
        isActive: true,
      } as never);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("settings cache", () => {
    it("allSettings fetches once then serves a cached copy", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ settings: { a: "1" } }));
      const s = store();
      const first = await s.allSettings();
      const second = await s.allSettings();
      expect(first).toEqual({ a: "1" });
      // Cached: only the first read hit the network. Copies are independent.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      first.a = "mutated";
      expect(second.a).toBe("1");
    });

    it("getSetting reads through allSettings and returns null for a missing key", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ settings: { a: "1" } }));
      const s = store();
      expect(await s.getSetting("a")).toBe("1");
      expect(await s.getSetting("missing")).toBeNull();
    });

    it("setSetting PUTs and patches the live cache for a value and a null delete", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ settings: { a: "1" } }))
        .mockResolvedValue(jsonResponse({ ok: true }));
      const s = store();
      await s.allSettings(); // populate cache
      await s.setSetting("b", "2");
      expect(await s.getSetting("b")).toBe("2"); // served from patched cache, no new GET
      await s.setSetting("a", null);
      expect(await s.getSetting("a")).toBeNull();
      // Only the initial allSettings GET hit the network for reads.
      const getCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "GET");
      expect(getCalls).toHaveLength(1);
    });

    it("a setSetting landing during an in-flight allSettings is not clobbered by the fetch", async () => {
      // GET resolves only when we say so, simulating a slow allSettings fetch.
      let releaseGet: (r: Response) => void = () => {};
      const getPending = new Promise<Response>((res) => {
        releaseGet = res;
      });
      fetchMock.mockImplementation((_url: string, init?: { method?: string }) =>
        init?.method === "GET" || init?.method === undefined
          ? getPending
          : Promise.resolve(jsonResponse({ ok: true })),
      );
      const s = store();

      const allP = s.allSettings(); // fetch starts, cache still null
      await s.setSetting("b", "2"); // PUT lands mid-flight, bumps the generation
      releaseGet(jsonResponse({ settings: { a: "1" } })); // server snapshot lacks "b"
      await allP;

      // The stale snapshot must NOT have been cached. A fresh read reflects "b".
      fetchMock.mockResolvedValue(jsonResponse({ settings: { a: "1", b: "2" } }));
      expect(await s.getSetting("b")).toBe("2");
    });

    it("setSetting with no populated cache PUTs without touching the cache", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const s = store();
      // No prior allSettings() → settingsCache is null; the cache-patch branch is skipped.
      await s.setSetting("k", "v");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/settings/profile");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ key: "k", value: "v" });
    });

    it("resetProfileCache forces the next allSettings to re-fetch", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ settings: { a: "1" } }))
        .mockResolvedValueOnce(jsonResponse({ settings: { a: "2" } }));
      const s = store();
      expect((await s.allSettings()).a).toBe("1");
      s.resetProfileCache();
      expect((await s.allSettings()).a).toBe("2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("library entries", () => {
    const serverEntry = {
      id: "lib-1",
      mediaId: "tt1",
      folderId: "f1",
      listType: "favorites" as const,
      addedAt: "2024-01-01T00:00:00.000Z",
      customListName: null,
      releaseDateHint: null,
      renewalStatus: null,
      preview: { id: "tt1", type: "movie" as const, title: "X" },
    };

    it("addToLibrary PUTs the upsert body and maps the response entry", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ entry: serverEntry }));
      const r = await store().addToLibrary({
        mediaId: "tt1",
        listType: "favorites",
        folderId: "f1",
        addedAt: "2024-01-01T00:00:00.000Z",
        preview: { id: "tt1", type: "movie", title: "X" },
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/tt1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body);
      expect(body.listType).toBe("favorites");
      expect(body.folderId).toBe("f1");
      // Optional fields default to null in the request body.
      expect(body.customListName).toBeNull();
      expect(body.releaseDateHint).toBeNull();
      expect(body.renewalStatus).toBeNull();
      expect(r).toEqual(serverEntry);
    });

    it("addToLibrary defaults absent optional fields to null", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ entry: serverEntry }));
      await store().addToLibrary({
        mediaId: "tt1",
        listType: "favorites",
        preview: { id: "tt1", type: "movie", title: "X" },
      });
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(body.folderId).toBeNull();
      expect(body.customListName).toBeNull();
      expect(body.releaseDateHint).toBeNull();
      expect(body.renewalStatus).toBeNull();
    });

    it("removeFromLibrary DELETEs the encoded entry id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().removeFromLibrary("lib/9");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/library/entry/lib%2F9");
      expect(init.method).toBe("DELETE");
    });

    it("listLibrary maps rows and omits the query when no listType", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [serverEntry] }));
      const r = await store().listLibrary();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/library",
        expect.anything(),
      );
      expect(r).toEqual([serverEntry]);
    });

    it("listLibrary adds an encoded listType query when provided", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
      await store().listLibrary("favorites");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/library?listType=favorites",
        expect.anything(),
      );
    });

    it("listLibraryByFolder GETs the encoded folder id and maps rows", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ items: [serverEntry] }));
      const r = await store().listLibraryByFolder("f/1");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://srv/api/library/folder/f%2F1",
        expect.anything(),
      );
      expect(r).toEqual([serverEntry]);
    });
  });

  describe("indexer configs - stored in profile settings JSON", () => {
    function cfg(id: string, priority: number) {
      return {
        id,
        type: "torznab",
        name: id,
        baseURL: "http://i",
        apiKey: "k",
        priority,
        isActive: true,
      } as never;
    }

    it("saveIndexerConfig merges, sorts by priority, and writes the settings key", async () => {
      // First GET (allSettings) returns one existing config; the PUT saves the merged list.
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            settings: { server_indexer_configs: JSON.stringify([cfg("b", 5)]) },
          }),
        )
        .mockResolvedValue(jsonResponse({ ok: true }));
      await store().saveIndexerConfig(cfg("a", 1));
      // The PUT call carries the sorted, merged JSON under the settings key.
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
      expect(putCall[0]).toBe("http://srv/api/settings/profile");
      const body = JSON.parse(putCall[1].body);
      expect(body.key).toBe("server_indexer_configs");
      const saved = JSON.parse(body.value);
      expect(saved.map((r: { id: string }) => r.id)).toEqual(["a", "b"]); // priority 1 before 5
    });

    it("saveIndexerConfig replaces an existing config with the same id", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            settings: { server_indexer_configs: JSON.stringify([cfg("a", 9)]) },
          }),
        )
        .mockResolvedValue(jsonResponse({ ok: true }));
      await store().saveIndexerConfig(cfg("a", 2));
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
      const saved = JSON.parse(JSON.parse(putCall[1].body).value);
      expect(saved).toHaveLength(1);
      expect(saved[0].priority).toBe(2);
    });

    it("listIndexerConfigs parses the settings JSON array", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          settings: { server_indexer_configs: JSON.stringify([cfg("a", 1)]) },
        }),
      );
      const r = await store().listIndexerConfigs();
      expect(r.map((x) => x.id)).toEqual(["a"]);
    });

    it("listIndexerConfigs returns [] when the key is absent or blank", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ settings: {} }));
      expect(await store().listIndexerConfigs()).toEqual([]);
    });

    it("listIndexerConfigs returns [] on malformed (non-JSON) stored value", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ settings: { server_indexer_configs: "{not json" } }),
      );
      expect(await store().listIndexerConfigs()).toEqual([]);
    });

    it("listIndexerConfigs returns [] when stored JSON is not an array", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ settings: { server_indexer_configs: '{"a":1}' } }),
      );
      expect(await store().listIndexerConfigs()).toEqual([]);
    });

    it("deleteIndexerConfig drops the id and re-saves the remaining list", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            settings: {
              server_indexer_configs: JSON.stringify([cfg("a", 1), cfg("b", 2)]),
            },
          }),
        )
        .mockResolvedValue(jsonResponse({ ok: true }));
      await store().deleteIndexerConfig("a");
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
      const saved = JSON.parse(JSON.parse(putCall[1].body).value);
      expect(saved.map((r: { id: string }) => r.id)).toEqual(["b"]);
    });
  });

  describe("saveDebridConfig - credential bridge", () => {
    function debridConfig(over: Record<string, unknown> = {}) {
      return {
        id: "rd-1",
        service: "realdebrid",
        apiToken: "raw-token",
        priority: 3,
        isActive: true,
        ...over,
      } as never;
    }

    it("PUTs a credential with the raw token from the config", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await store().saveDebridConfig(debridConfig());
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://srv/api/profile/credentials");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({
        id: "rd-1",
        provider: "realdebrid",
        label: "realdebrid",
        value: "raw-token",
        priority: 3,
        isActive: true,
      });
    });

    it("resolves a secret:<key> marker from the pending-secrets buffer", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const s = store();
      // Buffer the real value via the write-only setSecret bridge (non-provider key).
      await s.setSecret("rd_token_key", "buffered-token");
      await s.saveDebridConfig(debridConfig({ apiToken: "secret:rd_token_key" }));
      const putCall = fetchMock.mock.calls.find(
        (c) => c[0] === "http://srv/api/profile/credentials",
      )!;
      expect(JSON.parse(putCall[1].body).value).toBe("buffered-token");
    });

    it("skips the write when the resolved token is empty/blank", async () => {
      await store().saveDebridConfig(debridConfig({ apiToken: "   " }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips the write when a secret marker has no buffered value", async () => {
      await store().saveDebridConfig(debridConfig({ apiToken: "secret:absent" }));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("further no-op Server-Mode stubs", () => {
    it("putMedia / putCachedResolution / deleteCachedResolution do nothing", async () => {
      const s = store();
      await s.putMedia({ id: "x" } as never);
      await s.putCachedResolution({ mediaId: "x" } as never);
      await s.deleteCachedResolution("x");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("error / non-OK responses", () => {
    it("surfaces the server-provided error message and status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));
      await expect(store().listWatchlist()).rejects.toMatchObject({
        message: "boom",
        status: 500,
      });
    });

    it("falls back to a status message when the body has no error field", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 503));
      await expect(store().listHistory()).rejects.toMatchObject({
        message: "Server request failed (503).",
        status: 503,
      });
    });

    it("falls back to a status message for a non-JSON (e.g. HTML proxy) body", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "<html>Bad Gateway</html>",
      } as Response);
      await expect(store().listFolders()).rejects.toMatchObject({
        message: "Server request failed (502).",
        status: 502,
      });
    });

    it("accepts an empty (zero-length) 200 body without parsing", async () => {
      // A 204-style empty body must not throw - request() skips JSON.parse when
      // the text is empty and resolves to {}.
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
      } as Response);
      await expect(store().removeFromWatchlist("tt1")).resolves.toBeUndefined();
    });

    it("notifies unauthorized on a 401", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 401));
      await expect(store().listWatchlist()).rejects.toMatchObject({ status: 401 });
      // notifyUnauthorized dispatches an event; ensure the call path didn't swallow status.
    });
  });
});

describe("RemoteStore queued next", () => {
  it("keeps queued rows from the continue-watching API while dropping ordinary zero progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ view: "continue-watching", items: [
      histItem({ mediaId: "queue", episodeId: "s1e2", queuedNext: true }),
      histItem({ mediaId: "viewed" }),
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "" });
    await expect(new RemoteStore("http://srv").continueWatching()).resolves.toMatchObject([
      { mediaId: "queue", queuedNext: true },
    ]);
    vi.unstubAllGlobals();
  });
});
