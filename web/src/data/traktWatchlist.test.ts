import { describe, expect, it, vi } from "vitest";
import type { MediaPreview } from "../models/media";
import {
  collectTraktWatchlistPushCandidates,
  resolveTraktWatchlistPull,
} from "./traktWatchlist";

function preview(id: string, type: MediaPreview["type"] = "movie"): MediaPreview {
  return { id, type, title: id };
}

describe("collectTraktWatchlistPushCandidates", () => {
  it("keeps direct IMDb movie IDs", async () => {
    const getExternalIds = vi.fn();
    const result = await collectTraktWatchlistPushCandidates(
      [preview("tt0133093")],
      { getExternalIds },
    );

    expect(result).toEqual({ imdbIDs: ["tt0133093"], showTMDBIDs: [], skipped: 0 });
    expect(getExternalIds).not.toHaveBeenCalled();
  });

  it("reconciles TMDB movie IDs through external IDs", async () => {
    const getExternalIds = vi.fn(async () => ({ imdbId: "tt1160419" }));
    const result = await collectTraktWatchlistPushCandidates(
      [preview("tmdb-438631")],
      { getExternalIds },
    );

    expect(getExternalIds).toHaveBeenCalledWith(438631, "movie");
    expect(result).toEqual({ imdbIDs: ["tt1160419"], showTMDBIDs: [], skipped: 0 });
  });

  it("collects series TMDB ids and counts only unresolved titles", async () => {
    const getExternalIds = vi.fn(async () => ({ imdbId: null }));
    const result = await collectTraktWatchlistPushCandidates(
      [
        preview("tmdb-1"),
        preview("local-movie"),
        { ...preview("tmdb-1399", "series"), tmdbId: 1399 },
      ],
      { getExternalIds },
    );

    expect(result).toEqual({ imdbIDs: [], showTMDBIDs: [1399], skipped: 2 });
  });

  it("skips unresolved series previews when IMDb lookup fails", async () => {
    const findByImdbId = vi.fn(async () => {
      throw new Error("lookup failed");
    });
    const getExternalIds = vi.fn(async () => ({ imdbId: null }));
    const result = await collectTraktWatchlistPushCandidates(
      [{ ...preview("tt0111161"), type: "series" }],
      { findByImdbId, getExternalIds },
    );

    expect(findByImdbId).toHaveBeenCalledWith("tt0111161", "series");
    expect(result).toEqual({ imdbIDs: [], showTMDBIDs: [], skipped: 1 });
  });

  it("skips movies with non IMDb external IDs", async () => {
    const getExternalIds = vi.fn(async () => ({ imdbId: "nope" }));
    const result = await collectTraktWatchlistPushCandidates(
      [{ ...preview("tmdb-10"), type: "movie", tmdbId: 10 }],
      { getExternalIds },
    );

    expect(result).toEqual({ imdbIDs: [], showTMDBIDs: [], skipped: 1 });
  });

  it("uses direct series IMDB resolution when available", async () => {
    const findByImdbId = vi.fn(async () => 1399);
    const getExternalIds = vi.fn(async () => ({ imdbId: null }));
    const result = await collectTraktWatchlistPushCandidates(
      [{ ...preview("tt0944947"), type: "series" }],
      { findByImdbId, getExternalIds },
    );

    expect(findByImdbId).toHaveBeenCalledWith("tt0944947", "series");
    expect(result).toEqual({ imdbIDs: [], showTMDBIDs: [1399], skipped: 0 });
  });
});

describe("resolveTraktWatchlistPull", () => {
  it("resolves mixed movies and shows without duplicate series previews", async () => {
    const getDetail = vi.fn(async (id: string, type: MediaPreview["type"]) => ({
      id,
      type,
      title: type === "movie" ? "The Matrix" : "Game of Thrones",
      year: type === "movie" ? 1999 : 2011,
      genres: [],
      lastFetched: "2026-01-01T00:00:00.000Z",
      tmdbId: Number(id.slice("tmdb-".length)),
    }));
    const result = await resolveTraktWatchlistPull(
      [{ imdbID: "tt0133093", title: "The Matrix", year: 1999 }],
      [
        {
          traktID: 123,
          imdbID: "tt0944947",
          tmdbID: 1399,
          title: "Game of Thrones",
          year: 2011,
        },
        {
          traktID: 123,
          imdbID: "tt0944947",
          tmdbID: 1399,
          title: "Game of Thrones",
          year: 2011,
        },
      ],
      {
        findByImdbId: vi.fn(async (imdbId: string) =>
          imdbId === "tt0133093" ? 603 : 1399,
        ),
        getDetail,
        search: vi.fn(async () => ({ items: [] })),
      },
    );

    expect(result.movies).toBe(1);
    expect(result.series).toBe(1);
    expect(result.notFound).toBe(0);
    expect(result.previews).toEqual([
      expect.objectContaining({ id: "tmdb-603", type: "movie" }),
      expect.objectContaining({ id: "tmdb-1399", type: "series" }),
    ]);
  });

  it("falls back to search for a movie when IMDb lookup throws", async () => {
    const findByImdbId = vi.fn(async () => {
      throw new Error("query failed");
    });
    const result = await resolveTraktWatchlistPull(
      [{ imdbID: "tt0111161", title: "The Movie", year: 1994 }],
      [],
      {
        findByImdbId,
        getDetail: vi.fn(async () => {
          throw new Error("should not be called");
        }),
        search: vi.fn(async (query, type) => ({
          items: [
            {
              id: "tmdb-123",
              type,
              title: query,
              year: 1994,
            },
          ],
        })),
      },
    );

    expect(findByImdbId).toHaveBeenCalledWith("tt0111161", "movie");
    expect(result.movies).toBe(1);
    expect(result.previews).toEqual([
      expect.objectContaining({ id: "tmdb-123", type: "movie" }),
    ]);
  });

  it("falls back to search for a series without a usable TMDB identifier", async () => {
    const findByImdbId = vi.fn(async () => {
      throw new Error("query failed");
    });
    const result = await resolveTraktWatchlistPull(
      [],
      [
        {
          traktID: 1,
          imdbID: "tt0944947",
          tmdbID: null,
          title: "Game of Thrones",
          year: 2011,
        },
      ],
      {
        findByImdbId,
        getDetail: vi.fn(async () => {
          throw new Error("should not be used");
        }),
        search: vi.fn(async (query, type) => ({
          items: [
            {
              id: "tmdb-1399",
              type,
              title: query,
              year: 2011,
            },
          ],
        })),
      },
    );

    expect(findByImdbId).toHaveBeenCalledWith("tt0944947", "series");
    expect(result.series).toBe(1);
    expect(result.previews).toEqual([
      expect.objectContaining({ id: "tmdb-1399", type: "series" }),
    ]);
  });

  it("counts unresolved movie and show items when nothing can be reconciled", async () => {
    const findByImdbId = vi.fn(async () => null);
    const result = await resolveTraktWatchlistPull(
      [{ imdbID: "tt0000000", title: "Missing", year: 1990 }],
      [{ traktID: 1, imdbID: "tt1111111", tmdbID: null, title: "Missing 2", year: 1991 }],
      {
        findByImdbId,
        getDetail: vi.fn(async () => {
          throw new Error("never");
        }),
        search: vi.fn(async () => ({ items: [] })),
      },
    );

    expect(result.movies).toBe(0);
    expect(result.series).toBe(0);
    expect(result.notFound).toBe(2);
    expect(result.previews).toEqual([]);
  });
});
