// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MediaType } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import { useTrailer } from "./trailer";

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useTrailer", () => {
  it("returns null without fetching when required inputs are missing", () => {
    const result0 = renderHook(() => useTrailer(null, null, null)).result.current;
    expect(result0).toEqual({ key: null, loading: false });

    const result1 = renderHook(() => useTrailer(1, null, null as unknown as TMDBService)).result
      .current;
    expect(result1).toEqual({ key: null, loading: false });
  });

  it("loads trailer keys from TMDB service", async () => {
    const tmdb = {
      getTrailer: vi.fn(async () => "abc"),
    } as unknown as TMDBService;

    const { result } = renderHook(() => useTrailer(99, "movie" as MediaType, tmdb));

    await waitFor(() => expect(result.current).toEqual({ key: "abc", loading: false }));
    expect(tmdb.getTrailer).toHaveBeenCalledWith(99, "movie");
  });

  it("returns a null trailer key on fetch failure", async () => {
    const tmdb = {
      getTrailer: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as TMDBService;

    const { result } = renderHook(() => useTrailer(100, "series" as MediaType, tmdb));

    await waitFor(() => expect(result.current).toEqual({ key: null, loading: false }));
    expect(tmdb.getTrailer).toHaveBeenCalledWith(100, "series");
  });

  it("prevents stale trailer keys from previous media from leaking across prop changes", async () => {
    const first = defer<string>();
    const second = defer<string>();
    const tmdb = {
      getTrailer: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    } as unknown as TMDBService;

    const { result, rerender } = renderHook(
      ({ tmdbId, type }) => useTrailer(tmdbId, type, tmdb),
      { initialProps: { tmdbId: 1, type: "movie" as MediaType } },
    );

    expect(result.current).toEqual({ key: null, loading: true });

    rerender({ tmdbId: 2, type: "movie" as MediaType });
    expect(result.current).toEqual({ key: null, loading: true });

    first.resolve("old-key");
    second.resolve("new-key");

    await waitFor(() => expect(result.current).toEqual({ key: "new-key", loading: false }));
    expect(result.current.key).toBe("new-key");
  });
});
