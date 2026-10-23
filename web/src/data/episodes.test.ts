// @vitest-environment jsdom
//
// Pure-helper + hook tests for the episode-picker data layer: episode-id
// round-trips, the resume-derived default selection, and the useSeasons /
// useEpisodes degrade-to-"none" contract.

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => mockServerMode,
  configuredServerURL: () => (mockServerMode ? "https://srv" : null),
}));
vi.mock("../lib/serverApi", () => ({
  fetchServerSeasons: (...args: unknown[]) => mockFetchServerSeasons(...args),
  fetchServerEpisodes: (...args: unknown[]) => mockFetchServerEpisodes(...args),
}));

let mockServerMode = false;
const mockFetchServerSeasons = vi.fn();
const mockFetchServerEpisodes = vi.fn();

import {
  defaultSelectionFor,
  episodeIdFor,
  episodeLabel,
  loadCanonicalSeasonEpisodes,
  nextEpisodeFor,
  normalizeFlattenedSeasonOneSelection,
  parseEpisodeId,
  useEpisodes,
  useSeasons,
} from "./episodes";
import type { TMDBService } from "../services/metadata/TMDBService";
import type { WatchHistoryRecord } from "../storage/models";

function record(over: Partial<WatchHistoryRecord>): WatchHistoryRecord {
  return {
    id: "x",
    mediaId: "tv1",
    episodeId: null,
    progressSeconds: 100,
    durationSeconds: 1000,
    completed: false,
    lastWatched: "2026-01-01T00:00:00Z",
    streamQuality: null,
    preview: { id: "tv1", type: "series", title: "Show" } as WatchHistoryRecord["preview"],
    ...over,
  };
}

function fakeTmdb(over: Partial<Record<"getSeasons" | "getEpisodes", unknown>> = {}) {
  return {
    getSeasons: over.getSeasons ?? vi.fn(async () => []),
    getEpisodes: over.getEpisodes ?? vi.fn(async () => []),
  } as unknown as TMDBService;
}

describe("episode id helpers", () => {
  it("round-trips ids without zero padding", () => {
    expect(episodeIdFor(2, 5)).toBe("s2e5");
    expect(parseEpisodeId("s2e5")).toEqual({ season: 2, episode: 5 });
    expect(parseEpisodeId(episodeIdFor(12, 103))).toEqual({ season: 12, episode: 103 });
  });

  it("rejects movies (null) and legacy/unparseable ids", () => {
    expect(parseEpisodeId(null)).toBeNull();
    expect(parseEpisodeId(undefined)).toBeNull();
    expect(parseEpisodeId("season-2-ep-5")).toBeNull();
    expect(parseEpisodeId("")).toBeNull();
  });

  it("formats human labels", () => {
    expect(episodeLabel(2, 5)).toBe("S2 E5");
  });
});

describe("defaultSelectionFor", () => {
  it("picks the most recently watched parseable episode, sorting itself", () => {
    const records = [
      record({ id: "a", episodeId: "s1e3", lastWatched: "2026-01-01T00:00:00Z" }),
      // Newest - but listed FIRST to prove array order is not trusted… wait,
      // newest must win regardless of position; put it in the middle.
      record({ id: "b", episodeId: "s2e7", lastWatched: "2026-03-01T00:00:00Z" }),
      record({ id: "c", episodeId: "s2e6", lastWatched: "2026-02-01T00:00:00Z" }),
    ];
    expect(defaultSelectionFor("tv1", records)).toEqual({ season: 2, episode: 7 });
  });

  it("selects the newest queued next target", () => {
    expect(defaultSelectionFor("tv1", [
      record({ episodeId: "s1e4", lastWatched: "2026-02-01T00:00:00Z" }),
      record({ episodeId: "s2e1", queuedNext: true, lastWatched: "2026-03-01T00:00:00Z" }),
    ])).toEqual({ season: 2, episode: 1 });
  });

  it("ignores other titles and unparseable ids; falls back to S1E1", () => {
    const records = [
      record({ id: "a", mediaId: "OTHER", preview: { id: "OTHER", type: "series", title: "x" } as WatchHistoryRecord["preview"], episodeId: "s9e9" }),
      record({ id: "b", episodeId: "legacy-key" }),
      record({ id: "c", episodeId: null }),
    ];
    expect(defaultSelectionFor("tv1", records)).toEqual({ season: 1, episode: 1 });
  });
});

describe("normalizeFlattenedSeasonOneSelection", () => {
  const seasons = (counts: number[]) => counts.map((episodeCount, index) => ({
    id: index + 1,
    seasonNumber: index + 1,
    name: `Season ${index + 1}`,
    episodeCount,
  }));

  it("maps Bleach's flattened E20/E21/E27 at the canonical boundary", () => {
    const bleach = seasons([20, 21, 22]);
    expect(normalizeFlattenedSeasonOneSelection({ season: 1, episode: 20 }, bleach))
      .toEqual({ season: 1, episode: 20 });
    expect(normalizeFlattenedSeasonOneSelection({ season: 1, episode: 21 }, bleach))
      .toEqual({ season: 2, episode: 1 });
    expect(normalizeFlattenedSeasonOneSelection({ season: 1, episode: 27 }, bleach))
      .toEqual({ season: 2, episode: 7 });
  });

  it("maps another affected anime but preserves an ordinary long first season", () => {
    expect(normalizeFlattenedSeasonOneSelection(
      { season: 1, episode: 40 }, seasons([35, 48, 48]),
    )).toEqual({ season: 2, episode: 5 });
    expect(normalizeFlattenedSeasonOneSelection(
      { season: 1, episode: 27 }, seasons([30, 10]),
    )).toEqual({ season: 1, episode: 27 });
  });

  it("does not change specials, already canonical selections, or out-of-range positions", () => {
    const bleach = [
      { id: 0, seasonNumber: 0, name: "Specials", episodeCount: 7 },
      ...seasons([20, 21]),
    ];
    expect(normalizeFlattenedSeasonOneSelection({ season: 0, episode: 6 }, bleach))
      .toEqual({ season: 0, episode: 6 });
    expect(normalizeFlattenedSeasonOneSelection({ season: 2, episode: 7 }, bleach))
      .toEqual({ season: 2, episode: 7 });
    expect(normalizeFlattenedSeasonOneSelection({ season: 1, episode: 99 }, bleach))
      .toEqual({ season: 1, episode: 99 });
  });
});

describe("useSeasons / useEpisodes", () => {
  it("degrades to source 'none' without a tmdbId or service", async () => {
    const { result } = renderHook(() => useSeasons(null, true, null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("none");

    const { result: eps } = renderHook(() => useEpisodes(null, 1, null));
    await waitFor(() => expect(eps.current.loading).toBe(false));
    expect(eps.current.source).toBe("none");
  });

  it("maps live seasons (dropping season 0 specials)", async () => {
    const tmdb = fakeTmdb({
      getSeasons: vi.fn(async () => [
        { id: 1, seasonNumber: 0, name: "Specials", episodeCount: 3 },
        { id: 2, seasonNumber: 1, name: "Season 1", episodeCount: 10 },
      ]),
    });
    const { result } = renderHook(() => useSeasons(42, true, tmdb));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("live");
    expect(result.current.seasons.map((s) => s.seasonNumber)).toEqual([1]);
  });

  it("degrades to 'none' when the service throws", async () => {
    const tmdb = fakeTmdb({
      getSeasons: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const { result } = renderHook(() => useSeasons(42, true, tmdb));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("none");
  });

  it("uses the server proxy in Server Mode", async () => {
    mockServerMode = true;
    try {
      mockFetchServerSeasons.mockResolvedValue({
        seasons: [{ id: 2, seasonNumber: 1, name: "Season 1", episodeCount: 8 }],
        numbering: "cinemeta",
      });
      const { result } = renderHook(() => useSeasons(42, true, null));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchServerSeasons).toHaveBeenCalledWith({ tmdbId: 42, imdbId: null });
      expect(result.current.source).toBe("live");
    } finally {
      mockServerMode = false;
    }
  });

  it("fences completed guide data during exact identity and season transitions", async () => {
    mockServerMode = true;
    try {
      mockFetchServerSeasons.mockResolvedValueOnce({
        seasons: [{ id: 1, seasonNumber: 1, name: "Season 1", episodeCount: 20 }],
        numbering: "cinemeta",
      });
      const seasonRenders: Array<ReturnType<typeof useSeasons>> = [];
      const seasons = renderHook(
        ({ tmdbId, imdbId }: { tmdbId: number; imdbId: string }) => {
          const state = useSeasons(tmdbId, true, null, imdbId);
          seasonRenders.push(state);
          return state;
        },
        { initialProps: { tmdbId: 1, imdbId: "tt0000001" } },
      );
      await waitFor(() => expect(seasons.result.current.source).toBe("live"));

      mockFetchServerSeasons.mockImplementationOnce(() => new Promise(() => {}));
      seasonRenders.length = 0;
      seasons.rerender({ tmdbId: 2, imdbId: "tt0000002" });
      expect(seasonRenders[0]).toMatchObject({
        seasons: [], loading: true, source: "none", numbering: null,
      });
      seasons.unmount();

      mockFetchServerEpisodes.mockResolvedValueOnce({
        episodes: [{
          id: "tt0000001:1:1",
          mediaId: "tt0000001",
          seasonNumber: 1,
          episodeNumber: 1,
          title: "Old episode",
        }],
        numbering: "cinemeta",
      });
      const episodeRenders: Array<ReturnType<typeof useEpisodes>> = [];
      const episodes = renderHook(
        ({ imdbId, season }: { imdbId: string; season: number }) => {
          const state = useEpisodes(null, season, null, imdbId);
          episodeRenders.push(state);
          return state;
        },
        { initialProps: { imdbId: "tt0000001", season: 1 } },
      );
      await waitFor(() => expect(episodes.result.current.source).toBe("live"));

      mockFetchServerEpisodes.mockImplementationOnce(() => new Promise(() => {}));
      episodeRenders.length = 0;
      episodes.rerender({ imdbId: "tt0000002", season: 2 });
      expect(episodeRenders[0]).toMatchObject({
        episodes: [], loading: true, source: "none", numbering: null,
      });
      episodes.unmount();
    } finally {
      mockServerMode = false;
    }
  });

  it("loads a season's episodes and reloads when the season changes", async () => {
    const getEpisodes = vi.fn(async (_id: number, season: number) => [
      {
        id: `e-${season}`,
        mediaId: "tmdb-42",
        seasonNumber: season,
        episodeNumber: 1,
        title: `S${season} opener`,
      },
    ]);
    const tmdb = fakeTmdb({ getEpisodes });
    const { result, rerender } = renderHook(
      ({ season }: { season: number }) => useEpisodes(42, season, tmdb),
      { initialProps: { season: 1 } },
    );
    await waitFor(() => expect(result.current.source).toBe("live"));
    expect(result.current.episodes[0].title).toBe("S1 opener");

    rerender({ season: 2 });
    await waitFor(() => expect(result.current.episodes[0]?.title).toBe("S2 opener"));
    expect(getEpisodes).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the known Bleach canonical guide is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const getSeasons = vi.fn(async () => [{
      id: 2, seasonNumber: 2, name: "Thousand-Year Blood War", episodeCount: 13,
    }]);
    const getEpisodes = vi.fn(async () => [{
      id: "tmdb-wrong", mediaId: "tmdb-30984", seasonNumber: 2,
      episodeNumber: 7, title: "Wrong merged identity",
    }]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Cinemeta unavailable");
    }) as typeof fetch;
    const tmdb = fakeTmdb({ getSeasons, getEpisodes });
    try {
      const seasons = renderHook(() =>
        useSeasons(30984, true, tmdb, "tt0434665"),
      );
      const episodes = renderHook(() =>
        useEpisodes(30984, 17, tmdb, "tt0434665"),
      );
      await waitFor(() => {
        expect(seasons.result.current.loading).toBe(false);
        expect(episodes.result.current.loading).toBe(false);
      });
      expect(seasons.result.current).toMatchObject({ seasons: [], source: "none" });
      expect(episodes.result.current).toMatchObject({ episodes: [], source: "none" });
      expect(getSeasons).not.toHaveBeenCalled();
      expect(getEpisodes).not.toHaveBeenCalled();
      seasons.unmount();
      episodes.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a known-parent canonical guide outage instead of returning a valid empty season", async () => {
    const originalFetch = globalThis.fetch;
    const getEpisodes = vi.fn(async () => [{
      id: "tmdb-wrong", mediaId: "tmdb-30984", seasonNumber: 2,
      episodeNumber: 1, title: "Wrong merged identity",
    }]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Cinemeta unavailable");
    }) as typeof fetch;
    try {
      await expect(loadCanonicalSeasonEpisodes({
        tmdbId: 30984,
        imdbId: "tt0434665",
        season: 2,
        tmdb: fakeTmdb({ getEpisodes }),
      })).rejects.toThrow("Cinemeta unavailable");
      expect(getEpisodes).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an authoritative empty list when a valid exact guide lacks the season", async () => {
    const originalFetch = globalThis.fetch;
    const imdbId = "tt7654321";
    const getEpisodes = vi.fn(async () => [{
      id: "tmdb-wrong", mediaId: "tmdb-42", seasonNumber: 2,
      episodeNumber: 1, title: "Wrong identity",
    }]);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      meta: {
        id: imdbId,
        type: "series",
        videos: [{ id: `${imdbId}:1:1`, season: 1, number: 1, episode: 1 }],
      },
    }))) as typeof fetch;
    try {
      await expect(loadCanonicalSeasonEpisodes({
        tmdbId: 42,
        imdbId,
        season: 2,
        tmdb: fakeTmdb({ getEpisodes }),
      })).resolves.toEqual([]);
      expect(getEpisodes).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads Bleach display seasons from the canonical composite instead of merged TMDB", async () => {
    const originalFetch = globalThis.fetch;
    const originalCounts = [20, 21, 22, 28, 18, 22, 20, 16, 22, 16, 7, 17, 36, 51, 26, 24];
    const sequelCounts = [13, 13, 14, 10];
    const guide = (imdbId: string, counts: number[]) => JSON.stringify({
      meta: {
        id: imdbId,
        type: "series",
        videos: counts.flatMap((count, seasonIndex) =>
          Array.from({ length: count }, (_, episodeIndex) => ({
            id: `${imdbId}:${seasonIndex + 1}:${episodeIndex + 1}`,
            season: seasonIndex + 1,
            number: episodeIndex + 1,
            episode: episodeIndex + 1,
            name: `${imdbId} S${seasonIndex + 1}E${episodeIndex + 1}`,
          })),
        ),
      },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      new Response(String(input).includes("tt14986406")
        ? guide("tt14986406", sequelCounts)
        : guide("tt0434665", originalCounts)),
    ) as typeof fetch;
    const mergedTmdbEpisodes = vi.fn(async () =>
      Array.from({ length: 50 }, (_, index) => ({
        id: `tmdb-wrong-${index + 1}`,
        mediaId: "tmdb-30984",
        seasonNumber: 2,
        episodeNumber: index + 1,
        title: `Merged Blood War ${index + 1}`,
      })),
    );
    const tmdb = fakeTmdb({ getEpisodes: mergedTmdbEpisodes });
    try {
      const originalSeasonTwo = await loadCanonicalSeasonEpisodes({
        tmdbId: 30984,
        imdbId: "tt0434665",
        season: 2,
        tmdb,
      });
      expect(originalSeasonTwo).toHaveLength(21);
      expect(originalSeasonTwo[0]).toMatchObject({
        mediaId: "tt0434665", seasonNumber: 2, episodeNumber: 1,
      });

      const allEpisodes = (await Promise.all(
        Array.from({ length: 20 }, (_, index) => loadCanonicalSeasonEpisodes({
          tmdbId: 30984,
          imdbId: "tt0434665",
          season: index + 1,
          tmdb,
        })),
      )).flat();
      expect(allEpisodes).toHaveLength(416);
      expect(allEpisodes.filter((episode) => episode.seasonNumber === 17)).toHaveLength(13);
      expect(allEpisodes.find((episode) => episode.seasonNumber === 17)).toMatchObject({
        mediaId: "tt14986406", episodeNumber: 1,
      });
      expect(mergedTmdbEpisodes).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not fall back to conflicting TMDB numbering when an exact guide lacks the season", async () => {
    const imdbId = "tt7654321";
    const originalFetch = globalThis.fetch;
    const getEpisodes = vi.fn(async () => [{
      id: "tmdb-conflict",
      mediaId: "tmdb-42",
      seasonNumber: 2,
      episodeNumber: 1,
      title: "Wrong identity",
    }]);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      meta: {
        id: imdbId,
        type: "series",
        videos: [{ id: `${imdbId}:1:1`, season: 1, number: 1, episode: 1 }],
      },
    }))) as typeof fetch;
    const tmdb = fakeTmdb({ getEpisodes });
    try {
      const { result } = renderHook(() =>
        useEpisodes(42, 2, tmdb, imdbId),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.episodes).toEqual([]);
      expect(result.current.guideVersion).toBe("2");
      expect(getEpisodes).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("nextEpisodeFor", () => {
  const seasons = [
    { id: 0, seasonNumber: 0, name: "Specials", episodeCount: 4 },
    { id: 1, seasonNumber: 1, name: "Season 1", episodeCount: 3 },
    { id: 2, seasonNumber: 2, name: "Season 2", episodeCount: 2 },
    { id: 3, seasonNumber: 3, name: "Season 3", episodeCount: 0 },
    { id: 4, seasonNumber: 4, name: "Season 4", episodeCount: 5 },
  ];

  it("increments within a season", () => {
    expect(nextEpisodeFor({ season: 1, episode: 1 }, seasons)).toEqual({
      season: 1,
      episode: 2,
    });
  });

  it("crosses to the next non-empty season at the boundary (skipping empties)", () => {
    expect(nextEpisodeFor({ season: 2, episode: 2 }, seasons)).toEqual({
      season: 4,
      episode: 1,
    });
  });

  it("crosses Bleach's original-series boundary from display S16 to S17", () => {
    const bleachSeasons = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      seasonNumber: index + 1,
      name: `Season ${index + 1}`,
      episodeCount: index === 15 ? 24 : 13,
    }));
    expect(nextEpisodeFor({ season: 16, episode: 24 }, bleachSeasons)).toEqual({
      season: 17,
      episode: 1,
    });
  });

  it("returns null after the finale", () => {
    expect(nextEpisodeFor({ season: 4, episode: 5 }, seasons)).toBeNull();
  });

  it("never advances into specials (season 0)", () => {
    // From S1's finale the next is S2 - not S0.
    expect(nextEpisodeFor({ season: 1, episode: 3 }, seasons)).toEqual({
      season: 2,
      episode: 1,
    });
  });

  it("blind within-season increment with no season metadata", () => {
    expect(nextEpisodeFor({ season: 3, episode: 7 }, [])).toEqual({
      season: 3,
      episode: 8,
    });
  });
});
