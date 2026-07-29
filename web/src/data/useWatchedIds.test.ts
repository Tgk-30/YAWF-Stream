// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { WatchHistoryRecord } from "../storage/models";
import { useDetailWatchedState, useWatchedIds } from "./useWatchedIds";

const listHistory = vi.fn<() => Promise<WatchHistoryRecord[]>>();
const getResume = vi.fn<(mediaId: string, episodeId: string | null) => Promise<WatchHistoryRecord | null>>();
const listHistoryForMedia = vi.fn<(mediaId: string) => Promise<WatchHistoryRecord[]>>();

vi.mock("../storage", () => ({
  getStore: () => ({
    listHistory,
    getResume,
    listHistoryForMedia,
  }),
}));

function record(
  over: Partial<WatchHistoryRecord> & { id: string; mediaId: string; episodeId?: string | null },
): WatchHistoryRecord {
  return {
    episodeId: over.episodeId ?? null,
    progressSeconds: over.progressSeconds ?? 0,
    durationSeconds: over.durationSeconds ?? 100,
    completed: over.completed ?? false,
    lastWatched: over.lastWatched ?? "2026-01-01T00:00:00.000Z",
    streamQuality: over.streamQuality ?? null,
    preview: {
      id: over.mediaId,
      type: "movie",
      title: "Title",
    },
    ...over,
  };
}

describe("useWatchedIds", () => {
  beforeEach(() => {
    listHistory.mockReset();
    getResume.mockReset();
    listHistoryForMedia.mockReset();
  });

  it("loads watched media ids from history", async () => {
    listHistory.mockResolvedValue([
      record({ id: "a", mediaId: "m-1", completed: true }),
      record({ id: "b", mediaId: "m-2", progressSeconds: 10, durationSeconds: 200 }),
      record({ id: "c", mediaId: "m-3", episodeId: "s1e1", completed: true }),
    ]);

    const { result } = renderHook(() => useWatchedIds());

    await waitFor(() => expect(result.current.has("m-1")).toBe(true));
    expect(result.current.has("m-1")).toBe(true);
    expect(result.current.has("m-2")).toBe(false);
    expect(result.current.has("m-3")).toBe(true);
    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("resets to empty on store failures", async () => {
    listHistory.mockRejectedValue(new Error("storage offline"));

    const { result } = renderHook(() => useWatchedIds());

    await waitFor(() => expect(result.current).toEqual(new Set<string>()));
    expect(result.current.size).toBe(0);
  });
});

describe("useDetailWatchedState", () => {
  beforeEach(() => {
    listHistory.mockReset();
    getResume.mockReset();
    listHistoryForMedia.mockReset();
  });

  it("returns empty detail state when media is missing", async () => {
    const { result } = renderHook(() => useDetailWatchedState(null, "movie"));
    expect(result.current).toEqual({ episodeIds: new Set<string>(), movieWatched: false });
  });

  it("loads movie watched state from resume history", async () => {
    getResume.mockResolvedValue(
      record({ id: "m-1", mediaId: "m-1", completed: true, episodeId: null }),
    );

    const { result } = renderHook(() => useDetailWatchedState("m-1", "movie"));

    await waitFor(() => expect(result.current.movieWatched).toBe(true));
    expect(result.current.episodeIds).toEqual(new Set<string>());
    expect(result.current.movieWatched).toBe(true);
    expect(listHistoryForMedia).not.toHaveBeenCalled();
    expect(getResume).toHaveBeenCalledWith("m-1", null);
  });

  it("loads series episode state from media history", async () => {
    listHistoryForMedia.mockResolvedValue([
      record({ id: "e1", mediaId: "m-1", episodeId: "s1e1", completed: true }),
      record({ id: "e2", mediaId: "m-1", episodeId: "s1e2", completed: false, progressSeconds: 10 }),
    ]);

    const { result } = renderHook(() => useDetailWatchedState("m-1", "series"));

    await waitFor(() => expect(result.current.episodeIds.has("s1e1")).toBe(true));
    expect(result.current.movieWatched).toBe(false);
    expect(result.current.episodeIds).toEqual(new Set(["s1e1"]));
    expect(listHistoryForMedia).toHaveBeenCalledWith("m-1");
  });

  it("returns an empty detail state on series load failure", async () => {
    listHistoryForMedia.mockRejectedValue(new Error("history failed"));

    const { result } = renderHook(() => useDetailWatchedState("m-1", "series"));

    await waitFor(() => expect(result.current).toEqual({ episodeIds: new Set<string>(), movieWatched: false }));
    expect(result.current.episodeIds.size).toBe(0);
  });
});
