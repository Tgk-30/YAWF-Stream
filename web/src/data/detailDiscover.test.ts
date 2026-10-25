// @vitest-environment jsdom
//
// Tests for the Detail (detail.ts) and Discover (discover.ts) data layers.
// Both expose React hooks plus pure helpers, and branch across three paths:
// server mode (serverApi), live TMDB (a fake TMDBService), and the no-key
// fixtures fallback. We mock serverMode/serverApi/fixtures at the module level
// and drive the hooks with renderHook + waitFor.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { Suspense, createElement, startTransition, useState } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { CastMember, MediaItem, MediaPreview } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import { NetworkBlockedError, setNetworkMode } from "../lib/networkPolicy";

const mediaCache = new Map<string, MediaItem>();
vi.mock("../storage", () => ({
  getStore: () => ({
    putMedia: async (item: MediaItem, key: string = item.id) =>
      void mediaCache.set(key, item),
    getMedia: async (id: string) => {
      const item = mediaCache.get(id);
      return item == null ? null : { id, item, lastFetched: item.lastFetched };
    },
  }),
}));

// ── Module mocks ─────────────────────────────────────────────────────────────
const isServerMode = vi.fn(() => false as boolean);
vi.mock("../lib/serverMode", () => ({
  isServerMode: () => isServerMode(),
}));

const fetchServerDetail = vi.fn();
const fetchServerDiscoverHome = vi.fn();
vi.mock("../lib/serverApi", () => ({
  fetchServerDetail: (...args: unknown[]) => fetchServerDetail(...args),
  fetchServerDiscoverHome: (...args: unknown[]) => fetchServerDiscoverHome(...args),
}));

// Deterministic, small fixtures so we can assert hero-pick + array identity
// without depending on the (large) real bundled catalog.
const fixtureTrendingMovieWithBackdrop: MediaPreview = {
  id: "tmdb-100",
  type: "movie",
  title: "Fixture Movie",
  year: 2001,
  posterPath: "/p.jpg",
  backdropPath: "/b.jpg",
  imdbRating: 7,
  tmdbId: 100,
};
const loadDiscoverFixtures = vi.fn(() => ({
  trendingMovies: [fixtureTrendingMovieWithBackdrop],
  trendingTV: [],
  popularMovies: [],
  topRatedMovies: [],
  nowPlayingMovies: [],
  upcomingMovies: [],
}));
vi.mock("./fixtures", () => ({
  loadDiscoverFixtures: () => loadDiscoverFixtures(),
}));

import {
  loadDetailWithOfflineFallback,
  loadLive,
  useDetail,
  type DetailState,
} from "./detail";
import {
  useDiscover,
  loadLiveDiscover,
  loadFixtureDiscover,
} from "./discover";

// ── Helpers ──────────────────────────────────────────────────────────────────
function preview(partial: Partial<MediaPreview> = {}): MediaPreview {
  // Spread last so an explicit `null` (e.g. backdropPath: null) overrides the
  // default - `?? `would swallow a deliberate null.
  return {
    id: "tmdb-42",
    type: "movie",
    title: "The Thing",
    year: 1982,
    posterPath: "/poster.jpg",
    backdropPath: "/back.jpg",
    imdbRating: 8.1,
    tmdbId: null,
    ...partial,
  };
}

function mediaItem(partial: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "tt0084787",
    type: "movie",
    title: "The Thing",
    year: 1982,
    posterPath: "/poster.jpg",
    backdropPath: "/back.jpg",
    overview: "A thing.",
    genres: ["Horror"],
    imdbRating: 8.1,
    rtRating: null,
    runtime: 109,
    status: null,
    tmdbId: 1091,
    lastFetched: new Date().toISOString(),
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cast: CastMember[] = [
  { id: 1, name: "Kurt Russell", character: "MacReady", profileURL: null },
];

/** Minimal fake TMDBService with only the methods detail/discover use. */
function fakeTMDB(over: Partial<Record<string, unknown>> = {}): TMDBService {
  const base = {
    getDetail: vi.fn(async () => mediaItem()),
    getExternalIds: vi.fn(async () => ({ imdbId: null, tvdbId: null })),
    getCast: vi.fn(async () => cast),
    getRecommendations: vi.fn(async () => [preview({ id: "tmdb-7", title: "Rec" })]),
    getTrending: vi.fn(async (kind: string) => ({
      items: kind === "movie" ? [preview({ id: "tmdb-1", title: "TrendMovie" })] : [],
    })),
    getCategory: vi.fn(async () => ({ items: [] })),
  };
  return { ...base, ...over } as unknown as TMDBService;
}

beforeEach(() => {
  vi.clearAllMocks();
  mediaCache.clear();
  setNetworkMode("standard");
  isServerMode.mockReturnValue(false);
});

// ════════════════════════════════════════════════════════════════════════════
// detail.ts - useDetail
// ════════════════════════════════════════════════════════════════════════════
describe("useDetail", () => {
  it("keeps the mounted owner live when a suspended navigation is abandoned", async () => {
    isServerMode.mockReturnValue(true);
    const parentDetail = deferred<{
      item: MediaItem;
      cast: CastMember[];
      related: MediaPreview[];
      imdbId: string;
    }>();
    fetchServerDetail.mockImplementation(({ id }: { id: string }) => {
      if (id !== "tt0434665") throw new Error(`Unexpected committed request for ${id}`);
      return parentDetail.promise;
    });
    const parent = preview({
      id: "tt0434665",
      type: "series",
      title: "Bleach",
      tmdbId: 30984,
    });
    const child = preview({
      id: "tt14986406",
      type: "series",
      title: "Bleach: Thousand-Year Blood War",
      tmdbId: 215105,
    });
    const suspended = new Promise<never>(() => {});
    const observed: DetailState[] = [];
    let navigate!: (selected: MediaPreview) => void;

    function Probe({ selected }: { selected: MediaPreview }) {
      const state = useDetail(selected, null);
      observed.push(state);
      if (selected.id === child.id) throw suspended;
      return createElement(
        "div",
        { "data-testid": "detail-state" },
        state.data.item?.overview ?? "loading",
      );
    }

    function Harness() {
      const [selected, setSelected] = useState(parent);
      navigate = setSelected;
      return createElement(
        Suspense,
        { fallback: createElement("div", null, "Suspended") },
        createElement(Probe, { selected }),
      );
    }

    const view = render(createElement(Harness));
    await waitFor(() => expect(fetchServerDetail).toHaveBeenCalledTimes(1));

    act(() => {
      startTransition(() => navigate(child));
    });
    expect(observed.some((state) => state.data.item?.id === child.id)).toBe(true);

    await act(async () => {
      parentDetail.resolve({
        item: mediaItem({
          id: "tt0434665",
          type: "series",
          title: "Bleach",
          tmdbId: 30984,
          overview: "Parent detail completed.",
        }),
        cast: [],
        related: [],
        imdbId: "tt0434665",
      });
    });
    act(() => navigate(parent));

    await waitFor(() => {
      expect(view.getByTestId("detail-state").textContent).toBe("Parent detail completed.");
    });
    expect(fetchServerDetail).toHaveBeenCalledTimes(1);
  });

  it("fences the very first render when a settled server title changes", async () => {
    isServerMode.mockReturnValue(true);
    const childDetail = deferred<{
      item: MediaItem;
      cast: CastMember[];
      related: MediaPreview[];
      imdbId: string;
    }>();
    fetchServerDetail.mockImplementation(({ id }: { id: string }) => {
      if (id === "tt0434665") {
        return Promise.resolve({
          item: mediaItem({
            id: "tt0434665",
            type: "series",
            title: "Bleach",
            tmdbId: 30984,
          }),
          cast: [],
          related: [],
          imdbId: "tt0434665",
        });
      }
      return childDetail.promise;
    });
    const parent = preview({
      id: "tt0434665",
      type: "series",
      title: "Bleach",
      tmdbId: 30984,
    });
    const child = preview({
      id: "tt14986406",
      type: "series",
      title: "Bleach: Thousand-Year Blood War",
      tmdbId: 215105,
    });
    const renders: DetailState[] = [];
    const hook = renderHook(
      ({ selected }: { selected: MediaPreview | null }) => {
        const state = useDetail(selected, null);
        renders.push(state);
        return state;
      },
      { initialProps: { selected: parent as MediaPreview | null } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    renders.length = 0;
    hook.rerender({ selected: child });
    expect(renders[0]).toMatchObject({
      loading: true,
      error: null,
      source: "fixtures",
      data: {
        imdbId: "tt14986406",
        item: { id: "tt14986406", tmdbId: 215105 },
      },
    });
    expect(renders[0]?.data.imdbId).not.toBe("tt0434665");

    await act(async () => {
      childDetail.resolve({
        item: mediaItem({
          id: "tt14986406",
          type: "series",
          title: "Bleach: Thousand-Year Blood War",
          tmdbId: 215105,
        }),
        cast: [],
        related: [],
        imdbId: "tt14986406",
      });
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.data.imdbId).toBe("tt14986406");
  });

  it("rejects late local IMDb and final commits on a child to parent transition", async () => {
    const childExternal = deferred<{ imdbId: string | null; tvdbId: number | null }>();
    const childItem = deferred<MediaItem>();
    const parentExternal = deferred<{ imdbId: string | null; tvdbId: number | null }>();
    const parentItem = deferred<MediaItem>();
    const svc = fakeTMDB({
      getExternalIds: vi.fn((tmdbId: number) =>
        tmdbId === 215105 ? childExternal.promise : parentExternal.promise),
      getDetail: vi.fn((id: string) =>
        id === "tmdb-215105" ? childItem.promise : parentItem.promise),
      getCast: vi.fn(async () => []),
      getRecommendations: vi.fn(async () => []),
    });
    const child = preview({
      id: "tmdb-215105",
      type: "series",
      title: "Bleach: Thousand-Year Blood War",
      tmdbId: 215105,
    });
    const parent = preview({
      id: "tmdb-30984",
      type: "series",
      title: "Bleach",
      tmdbId: 30984,
    });
    const renders: DetailState[] = [];
    const hook = renderHook(
      ({ selected }: { selected: MediaPreview }) => {
        const state = useDetail(selected, svc);
        renders.push(state);
        return state;
      },
      { initialProps: { selected: child } },
    );

    renders.length = 0;
    hook.rerender({ selected: parent });
    expect(renders[0]).toMatchObject({
      loading: true,
      data: { imdbId: null, item: { id: "tmdb-30984", tmdbId: 30984 } },
    });

    await act(async () => {
      childExternal.resolve({ imdbId: "tt14986406", tvdbId: null });
      childItem.resolve(mediaItem({
        id: "tt14986406",
        type: "series",
        title: "Bleach: Thousand-Year Blood War",
        tmdbId: 215105,
      }));
      parentExternal.resolve({ imdbId: "tt0434665", tvdbId: null });
    });
    await waitFor(() => expect(hook.result.current.data.imdbId).toBe("tt0434665"));
    expect(hook.result.current.data.item?.id).toBe("tmdb-30984");

    await act(async () => {
      parentItem.resolve(mediaItem({
        id: "tt0434665",
        type: "series",
        title: "Bleach",
        tmdbId: 30984,
      }));
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.data).toMatchObject({
      imdbId: "tt0434665",
      item: { id: "tt0434665", tmdbId: 30984 },
    });
  });

  it("keys ownership by service identity and preview TMDB identity", async () => {
    const first = fakeTMDB({
      getDetail: vi.fn(async () => mediaItem({ id: "tt-first", tmdbId: 1 })),
    });
    const secondDetail = deferred<MediaItem>();
    const second = fakeTMDB({ getDetail: vi.fn(() => secondDetail.promise) });
    const renders: DetailState[] = [];
    const hook = renderHook(
      ({ selected, service }: { selected: MediaPreview; service: TMDBService }) => {
        const state = useDetail(selected, service);
        renders.push(state);
        return state;
      },
      { initialProps: { selected: preview({ id: "catalog", tmdbId: 1 }), service: first } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    renders.length = 0;
    hook.rerender({
      selected: preview({ id: "catalog", tmdbId: 1 }),
      service: second,
    });
    expect(renders[0]).toMatchObject({
      loading: true,
      data: { imdbId: null, item: { id: "catalog", tmdbId: 1 } },
    });

    renders.length = 0;
    hook.rerender({
      selected: preview({ id: "catalog", tmdbId: 2 }),
      service: second,
    });
    expect(renders[0]).toMatchObject({
      loading: true,
      data: { imdbId: null, item: { id: "catalog", tmdbId: 2 } },
    });
  });

  it("does not expose the previous title when preview becomes null", async () => {
    const selected = preview({ id: "tt0084787" });
    const renders: DetailState[] = [];
    const nullHook = renderHook(
      ({ value }: { value: MediaPreview | null }) => {
        const state = useDetail(value, null);
        renders.push(state);
        return state;
      },
      { initialProps: { value: selected as MediaPreview | null } },
    );
    await waitFor(() => expect(nullHook.result.current.loading).toBe(false));
    renders.length = 0;
    nullHook.rerender({ value: null });
    expect(renders[0]).toMatchObject({
      loading: true,
      data: { item: null, imdbId: null, cast: [], related: [] },
    });
  });

  it("falls back to a cached item when Offline blocks metadata", async () => {
    const cached = mediaItem({ id: "tt0084787" });
    mediaCache.set(cached.id, cached);
    setNetworkMode("offline");
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw new NetworkBlockedError("metadata", "offline", "TMDB");
      }),
    });

    await expect(loadDetailWithOfflineFallback(svc, preview({ id: cached.id }))).resolves.toMatchObject({
      item: cached,
      cast: [],
      related: [],
    });
  });

  it("caches under the PREVIEW id so Offline finds a title opened online (tmdb- vs tt- id)", async () => {
    // Online open: preview id (tmdb-42) differs from the detail id (tt0084787).
    const online = fakeTMDB({ getDetail: vi.fn(async () => mediaItem({ id: "tt0084787" })) });
    await loadLive(online, preview({ id: "tmdb-42" }));
    // The write MUST be keyed by the preview id, not the detail id, or the read
    // (which only knows the preview id) can never hit.
    expect(mediaCache.has("tmdb-42")).toBe(true);
    expect(mediaCache.has("tt0084787")).toBe(false);

    // Offline reopen of the same browse card must serve the cached detail.
    setNetworkMode("offline");
    const offline = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw new NetworkBlockedError("metadata", "offline", "TMDB");
      }),
    });
    const cachedResult = await loadDetailWithOfflineFallback(offline, preview({ id: "tmdb-42" }));
    expect(cachedResult?.item?.id).toBe("tt0084787");
  });

  it("reports the offline not-cached state when metadata is blocked", async () => {
    setNetworkMode("offline");
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw new NetworkBlockedError("metadata", "offline", "TMDB");
      }),
    });
    const p = preview();
    const { result } = renderHook(() => useDetail(p, svc));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.item).toBeNull();
    expect(result.current.error).toBe("Not available offline (not cached yet).");
  });

  it("stays in the initial loading/fixtures state when preview is null", () => {
    const svc = fakeTMDB();
    const { result } = renderHook(() => useDetail(null, svc));
    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBe("fixtures");
    expect(result.current.data.item).toBeNull();
    expect(result.current.data.cast).toEqual([]);
  });

  it("loads live via the service: maps item, cast, related and tt imdbId", async () => {
    const svc = fakeTMDB();
    const p = preview({ id: "tmdb-1091", tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.error).toBeNull();
    expect(result.current.data.item?.title).toBe("The Thing");
    expect(result.current.data.cast).toEqual(cast);
    expect(result.current.data.related).toHaveLength(1);
    // detail.id starts with "tt" -> imdbId surfaced.
    expect(result.current.data.imdbId).toBe("tt0084787");
    expect(svc.getCast).toHaveBeenCalledWith(1091, "movie");
    expect(svc.getRecommendations).toHaveBeenCalledWith(1091, "movie");
  });

  it("publishes external IMDb ids before a slow detail payload settles", async () => {
    const svc = fakeTMDB({
      getDetail: vi.fn(() => new Promise<MediaItem>(() => {})),
      getExternalIds: vi.fn(async () => ({ imdbId: "tt1091", tvdbId: null })),
    });
    const p = preview({ tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));

    await waitFor(() => expect(result.current.data.imdbId).toBe("tt1091"));
    expect(result.current.loading).toBe(true);
  });

  it("derives the tmdb id from a tmdb- prefixed preview id when tmdbId is absent", async () => {
    const svc = fakeTMDB();
    const p = preview({ id: "tmdb-555", tmdbId: null });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(svc.getCast).toHaveBeenCalledWith(555, "movie");
    expect(svc.getRecommendations).toHaveBeenCalledWith(555, "movie");
  });

  it("skips cast/recommendations when no numeric tmdb id is resolvable", async () => {
    const svc = fakeTMDB();
    const p = preview({ id: "tt9999999", tmdbId: null });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(svc.getCast).not.toHaveBeenCalled();
    expect(svc.getRecommendations).not.toHaveBeenCalled();
    expect(result.current.data.cast).toEqual([]);
    expect(result.current.data.related).toEqual([]);
  });

  it("imdbId is null when the detail id is a tmdb- fallback (not tt)", async () => {
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => mediaItem({ id: "tmdb-1091" })),
    });
    const p = preview({ tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.imdbId).toBeNull();
  });

  it("swallows a getCast/getRecommendations rejection (per-call .catch) and still resolves live", async () => {
    const svc = fakeTMDB({
      getCast: vi.fn(async () => {
        throw new Error("cast boom");
      }),
      getRecommendations: vi.fn(async () => {
        throw new Error("rec boom");
      }),
    });
    const p = preview({ tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.error).toBeNull();
    expect(result.current.data.cast).toEqual([]);
    expect(result.current.data.related).toEqual([]);
  });

  it("falls back to fixtures (previewToItem) when getDetail rejects", async () => {
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw new Error("detail down");
      }),
    });
    const p = preview({ title: "Aliens", year: 1986, tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("detail down");
    // previewToItem-derived item: title/year preserved, overview null, genres empty.
    expect(result.current.data.item?.title).toBe("Aliens");
    expect(result.current.data.item?.year).toBe(1986);
    expect(result.current.data.item?.overview).toBeNull();
    expect(result.current.data.item?.genres).toEqual([]);
    expect(result.current.data.imdbId).toBeNull();
  });

  it("stringifies a non-Error rejection into the error message", async () => {
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw "weird string failure";
      }),
    });
    const p = preview({ tmdbId: 1091 });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("weird string failure");
  });

  it("skips server updates when unmounted before server detail resolves", async () => {
    isServerMode.mockReturnValue(true);
    const pending = deferred<{
      item: MediaItem;
      cast: CastMember[];
      related: MediaPreview[];
      imdbId: string;
    }>();
    fetchServerDetail.mockReturnValue(pending.promise);

    const p = preview({ id: "srv-123" });
    const svc = fakeTMDB();
    const { result, unmount } = renderHook(() => useDetail(p, svc));
    unmount();

    pending.resolve({
      item: mediaItem({ title: "Server Detail" }),
      cast: [],
      related: [],
      imdbId: "ttserver",
    });
    await Promise.resolve();

    expect(fetchServerDetail).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBeNull();
    expect(result.current.data.item?.title).toBe("The Thing");
  });

  it("skips server error updates when unmounted before server detail rejects", async () => {
    isServerMode.mockReturnValue(true);
    const pending = deferred<never>();
    fetchServerDetail.mockReturnValue(pending.promise);

    const p = preview({ id: "srv-456" });
    const svc = fakeTMDB();
    const { result, unmount } = renderHook(() => useDetail(p, svc));
    unmount();
    pending.reject(new Error("server offline"));
    await Promise.resolve();

    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBeNull();
  });

  it("falls back to fixtures and keeps the preview IMDb id when a live detail request fails with a non-Error", async () => {
    const svc = fakeTMDB({
      getDetail: vi.fn(async () => {
        throw "network offline";
      }),
    });
    const p = preview({ id: "tt999" });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("network offline");
    expect(result.current.data.imdbId).toBe("tt999");
  });

  it("with a null service and not server mode, resolves to fixtures with no error", async () => {
    const p = preview();
    const { result } = renderHook(() => useDetail(p, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBeNull();
    expect(result.current.data.item?.title).toBe("The Thing");
  });

  it("server mode: returns server payload as live and never touches the service", async () => {
    isServerMode.mockReturnValue(true);
    const serverData = {
      item: mediaItem({ title: "Server Item" }),
      cast,
      related: [],
      imdbId: "tt1234567",
    };
    fetchServerDetail.mockResolvedValue(serverData);
    const svc = fakeTMDB();
    const p = preview({ id: "tmdb-9", type: "series" });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.data.item?.title).toBe("Server Item");
    expect(result.current.data.imdbId).toBe("tt1234567");
    expect(fetchServerDetail).toHaveBeenCalledWith({ id: "tmdb-9", type: "series" });
    expect(svc.getDetail).not.toHaveBeenCalled();
  });

  it("server mode failure falls back to fixtures with the error message", async () => {
    isServerMode.mockReturnValue(true);
    fetchServerDetail.mockRejectedValue(new Error("server 500"));
    const svc = fakeTMDB();
    const p = preview({ title: "Predator" });
    const { result } = renderHook(() => useDetail(p, svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("server 500");
    expect(result.current.data.item?.title).toBe("Predator");
  });

  it("server mode failure stringifies a non-Error rejection", async () => {
    // Hits the `err instanceof Error ? ... : String(err)` else-branch on the
    // server-mode catch.
    isServerMode.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    fetchServerDetail.mockRejectedValue("server string boom");
    // Stable preview ref: useDetail lists `preview` in its effect deps, so a
    // fresh object per render would re-run the effect forever.
    const p = preview();
    const { result } = renderHook(() => useDetail(p, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("server string boom");
  });

  it("previewToItem nulls every optional field when the preview omits them", async () => {
    // A bare preview (no year/poster/backdrop/rating/tmdbId) exercises each
    // `?? null` fallback in previewToItem on the no-key fixtures path.
    const bare: MediaPreview = { id: "tt1", type: "movie", title: "Bare" };
    const { result } = renderHook(() => useDetail(bare, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const item = result.current.data.item;
    expect(item?.title).toBe("Bare");
    expect(item?.year).toBeNull();
    expect(item?.posterPath).toBeNull();
    expect(item?.backdropPath).toBeNull();
    expect(item?.imdbRating).toBeNull();
    expect(item?.tmdbId).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// discover.ts - pure helpers
// ════════════════════════════════════════════════════════════════════════════
describe("loadLiveDiscover", () => {
  it("fetches all rails and unwraps .items; picks first trending movie w/ backdrop as hero", async () => {
    const svc = fakeTMDB({
      getTrending: vi.fn(async (kind: string) => ({
        items:
          kind === "movie"
            ? [
                preview({ id: "tmdb-1", title: "NoBackdrop", backdropPath: null }),
                preview({ id: "tmdb-2", title: "HasBackdrop", backdropPath: "/h.jpg" }),
              ]
            : [preview({ id: "tmdb-3", type: "series" })],
      })),
      getCategory: vi.fn(async (cat: string) => ({
        items: [preview({ id: `cat-${cat}` })],
      })),
    });

    const data = await loadLiveDiscover(svc);
    expect(data.trendingMovies).toHaveLength(2);
    expect(data.trendingTV[0]?.type).toBe("series");
    expect(data.popularMovies[0]?.id).toBe("cat-popular");
    expect(data.topRatedMovies[0]?.id).toBe("cat-top_rated");
    expect(data.nowPlayingMovies[0]?.id).toBe("cat-now_playing");
    expect(data.upcomingMovies[0]?.id).toBe("cat-upcoming");
    // hero = first trending movie that HAS a backdrop.
    expect(data.hero?.id).toBe("tmdb-2");

    expect(svc.getTrending).toHaveBeenCalledWith("movie", "week");
    expect(svc.getTrending).toHaveBeenCalledWith("series", "week");
  });

  it("falls back to a trending-TV backdrop when no trending movie has one", async () => {
    const svc = fakeTMDB({
      getTrending: vi.fn(async (kind: string) => ({
        items:
          kind === "movie"
            ? [preview({ id: "tmdb-1", backdropPath: null })]
            : [preview({ id: "tv-1", type: "series", backdropPath: "/tv.jpg" })],
      })),
      getCategory: vi.fn(async () => ({ items: [] })),
    });
    const data = await loadLiveDiscover(svc);
    expect(data.hero?.id).toBe("tv-1");
  });

  it("hero is null when nothing has a backdrop", async () => {
    const svc = fakeTMDB({
      getTrending: vi.fn(async () => ({
        items: [preview({ backdropPath: null })],
      })),
      getCategory: vi.fn(async () => ({ items: [] })),
    });
    const data = await loadLiveDiscover(svc);
    expect(data.hero).toBeNull();
  });
});

describe("loadFixtureDiscover", () => {
  it("spreads the fixtures and computes the hero from them", () => {
    const data = loadFixtureDiscover();
    expect(loadDiscoverFixtures).toHaveBeenCalled();
    expect(data.trendingMovies[0]?.id).toBe("tmdb-100");
    expect(data.hero?.id).toBe("tmdb-100"); // first trending movie has a backdrop
  });
});

// ════════════════════════════════════════════════════════════════════════════
// discover.ts - useDiscover
// ════════════════════════════════════════════════════════════════════════════
describe("useDiscover", () => {
  it("loads live via the service and reports source=live", async () => {
    const svc = fakeTMDB({
      getTrending: vi.fn(async (kind: string) => ({
        items: kind === "movie" ? [preview({ id: "tmdb-1", backdropPath: "/b.jpg" })] : [],
      })),
      getCategory: vi.fn(async () => ({ items: [] })),
    });
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.error).toBeNull();
    expect(result.current.data?.hero?.id).toBe("tmdb-1");
  });

  it("a live failure falls back to fixtures and keeps the error message", async () => {
    const svc = fakeTMDB({
      getTrending: vi.fn(async () => {
        throw new Error("tmdb offline");
      }),
    });
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("tmdb offline");
    expect(result.current.data?.trendingMovies[0]?.id).toBe("tmdb-100");
  });

  it("with a null service and no server mode, resolves to fixtures (no error)", async () => {
    const { result } = renderHook(() => useDiscover(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBeNull();
    expect(result.current.data?.hero?.id).toBe("tmdb-100");
  });

  it("Offline shows an honest empty state, NOT the bundled demo fixtures", async () => {
    setNetworkMode("offline");
    const svc = fakeTMDB({
      getTrending: vi.fn(async () => {
        throw new NetworkBlockedError("metadata", "offline", "TMDB");
      }),
    });
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("offline");
    // Empty rails, and specifically NOT the fixture title (tmdb-100).
    expect(result.current.data?.trendingMovies ?? []).toEqual([]);
    expect(result.current.data?.hero ?? null).toBeNull();
    expect(result.current.error).toMatch(/offline/i);
  });

  it("server mode: returns the server payload as live", async () => {
    isServerMode.mockReturnValue(true);
    const serverData = {
      hero: preview({ id: "srv-hero" }),
      trendingMovies: [preview({ id: "srv-1" })],
      trendingTV: [],
      popularMovies: [],
      topRatedMovies: [],
      nowPlayingMovies: [],
      upcomingMovies: [],
    };
    fetchServerDiscoverHome.mockResolvedValue(serverData);
    const svc = fakeTMDB();
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.data?.hero?.id).toBe("srv-hero");
    expect(svc.getTrending).not.toHaveBeenCalled();
  });

  it("server mode failure falls back to fixtures with the error", async () => {
    isServerMode.mockReturnValue(true);
    fetchServerDiscoverHome.mockRejectedValue(new Error("server gone"));
    const svc = fakeTMDB();
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("server gone");
    expect(result.current.data?.trendingMovies[0]?.id).toBe("tmdb-100");
  });

  it("server mode failure stringifies a non-Error rejection", async () => {
    // else-branch of `err instanceof Error ? ... : String(err)` (server path).
    isServerMode.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    fetchServerDiscoverHome.mockRejectedValue("srv string");
    // Stable service ref (useDiscover lists `tmdb` in its effect deps).
    const svc = fakeTMDB();
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("srv string");
  });

  it("a live failure stringifies a non-Error rejection", async () => {
    // else-branch of the live-path catch's `err instanceof Error` ternary.
    const svc = fakeTMDB({
      getTrending: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "live string";
      }),
    });
    const { result } = renderHook(() => useDiscover(svc));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("fixtures");
    expect(result.current.error).toBe("live string");
  });

  it("skips server-mode state updates when unmounted before fetch resolves", async () => {
    isServerMode.mockReturnValue(true);
    const pending = deferred<{ hero: MediaPreview; trendingMovies: MediaPreview[]; trendingTV: MediaPreview[]; popularMovies: MediaPreview[]; topRatedMovies: MediaPreview[]; nowPlayingMovies: MediaPreview[]; upcomingMovies: MediaPreview[] }>();
    fetchServerDiscoverHome.mockReturnValue(pending.promise);
    const svc = fakeTMDB();
    const { result, unmount } = renderHook(() => useDiscover(svc));
    unmount();
    pending.resolve({
      hero: preview({ id: "srv-hero" }),
      trendingMovies: [],
      trendingTV: [],
      popularMovies: [],
      topRatedMovies: [],
      nowPlayingMovies: [],
      upcomingMovies: [],
    });

    await Promise.resolve();
    expect(fetchServerDiscoverHome).toHaveBeenCalledTimes(1);
    // Initial state: loading true and source null, because updates are skipped
    // after cancellation.
    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBeNull();
  });

  it("skips server-mode error updates when unmounted before fetch rejects", async () => {
    isServerMode.mockReturnValue(true);
    const pending = deferred<never>();
    fetchServerDiscoverHome.mockReturnValue(pending.promise);
    const svc = fakeTMDB();
    const { result, unmount } = renderHook(() => useDiscover(svc));
    unmount();
    pending.reject("server rejected");

    await Promise.resolve();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("skips live updates when unmounted before tmdb discover resolves", async () => {
    const trendingMoviePending = deferred<any>();
    const trendingTVPending = deferred<any>();
    const popularPending = deferred<any>();
    const topRatedPending = deferred<any>();
    const nowPlayingPending = deferred<any>();
    const upcomingPending = deferred<any>();
    const svc = fakeTMDB({
      getTrending: vi.fn((kind: string) => {
        if (kind === "movie") return trendingMoviePending.promise;
        if (kind === "series") return trendingTVPending.promise;
        return popularPending.promise;
      }),
      getCategory: vi.fn((slug: string) => {
        if (slug === "popular") return popularPending.promise;
        if (slug === "top_rated") return topRatedPending.promise;
        if (slug === "now_playing") return nowPlayingPending.promise;
        return upcomingPending.promise;
      }),
    });
    const { result, unmount } = renderHook(() => useDiscover(svc));
    await Promise.resolve();
    unmount();
    trendingMoviePending.resolve({ items: [preview()] });
    trendingTVPending.resolve({ items: [] });
    popularPending.resolve({ items: [] });
    topRatedPending.resolve({ items: [] });
    nowPlayingPending.resolve({ items: [] });
    upcomingPending.resolve({ items: [] });

    await Promise.resolve();
    expect(svc.getTrending).toHaveBeenCalledTimes(2);
    expect(svc.getCategory).toHaveBeenCalledTimes(4);
    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBeNull();
  });

  it("skips live error fallback when unmounted before tmdb discover rejects", async () => {
    const trendingMoviePending = deferred<any>();
    const trendingTVPending = deferred<any>();
    const popularPending = deferred<any>();
    const topRatedPending = deferred<any>();
    const nowPlayingPending = deferred<any>();
    const upcomingPending = deferred<any>();
    const svc = fakeTMDB({
      getTrending: vi.fn((kind: string) => {
        if (kind === "movie") return trendingMoviePending.promise;
        if (kind === "series") return trendingTVPending.promise;
        return popularPending.promise;
      }),
      getCategory: vi.fn((slug: string) => {
        if (slug === "popular") return popularPending.promise;
        if (slug === "top_rated") return topRatedPending.promise;
        if (slug === "now_playing") return nowPlayingPending.promise;
        return upcomingPending.promise;
      }),
    });
    const { result, unmount } = renderHook(() => useDiscover(svc));
    await Promise.resolve();
    unmount();
    trendingMoviePending.reject(new Error("tmdb rejected"));
    trendingTVPending.resolve({ items: [] });
    popularPending.resolve({ items: [] });
    topRatedPending.resolve({ items: [] });
    nowPlayingPending.resolve({ items: [] });
    upcomingPending.resolve({ items: [] });

    await Promise.resolve();
    expect(svc.getTrending).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBeNull();
  });

});
