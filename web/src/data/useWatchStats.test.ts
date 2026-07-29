// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { WatchHistoryRecord, TasteEventRecord } from "../storage/models";

const listHistory = vi.fn<() => Promise<WatchHistoryRecord[]>>();
const recentTasteEvents = vi.fn<() => Promise<TasteEventRecord[]>>();

vi.mock("../storage", () => ({
  getStore: () => ({
    listHistory,
    recentTasteEvents,
  }),
}));

import { useWatchStats } from "./useWatchStats";

function history(over: Partial<WatchHistoryRecord> & { id: string; mediaId: string }): WatchHistoryRecord {
  return {
    episodeId: over.episodeId ?? null,
    progressSeconds: over.progressSeconds ?? 120,
    durationSeconds: over.durationSeconds ?? null,
    completed: over.completed ?? false,
    lastWatched: over.lastWatched ?? "2026-07-21T00:00:00.000Z",
    streamQuality: over.streamQuality ?? null,
    preview: over.preview ?? { id: over.mediaId, type: "movie", title: "Item" },
    ...over,
  };
}

function taste(over: Partial<TasteEventRecord> & { id: string }): TasteEventRecord {
  return {
    userId: over.userId ?? "user-1",
    mediaId: over.mediaId ?? "movie-1",
    episodeId: over.episodeId ?? null,
    eventType: over.eventType ?? "liked",
    signalStrength: over.signalStrength ?? 1,
    metadata: over.metadata ?? {},
    createdAt: over.createdAt ?? "2026-07-21T00:00:00.000Z",
    ...over,
  };
}

describe("useWatchStats", () => {
  beforeEach(() => {
    listHistory.mockReset();
    recentTasteEvents.mockReset();
  });

  it("does nothing when disabled", async () => {
    const { result } = renderHook(() => useWatchStats(false));

    expect(result.current).toBeNull();
    expect(listHistory).not.toHaveBeenCalled();
    expect(recentTasteEvents).not.toHaveBeenCalled();

    await Promise.resolve();
  });

  it("loads history and taste events when enabled and returns aggregated stats", async () => {
    listHistory.mockResolvedValue([
      history({ id: "m1", mediaId: "m1", completed: true, durationSeconds: 1200 }),
      history({ id: "m2", mediaId: "m2", completed: false, progressSeconds: 40, durationSeconds: 100 }),
      history({ id: "e1", mediaId: "e1", episodeId: "s1", completed: true, durationSeconds: 2000 }),
    ]);
    recentTasteEvents.mockResolvedValue([
      taste({ id: "t1", eventType: "liked", metadata: { genres: "Drama Sci-Fi" } }),
      taste({ id: "t2", eventType: "liked", metadata: { genres: "Drama" } }),
      taste({ id: "t3", eventType: "watched", metadata: { genres: "Ignored" } }),
    ]);

    const { result } = renderHook(() => useWatchStats(true));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(listHistory).toHaveBeenCalledWith(500);
    expect(recentTasteEvents).toHaveBeenCalledWith(500);

    const stats = result.current!;
    expect(stats).toMatchObject({
      titles: 3,
      completed: 2,
      completionRate: 2 / 3,
      activeDays: 1,
      favoriteGenres: [
        { genre: "Drama", count: 1 },
      { genre: "Drama Sci-Fi", count: 1 },
      ],
    });
    expect(stats.totalSeconds).toBe(1200 + 40 + 2000);
  });

  it("treats store errors as no stats", async () => {
    listHistory.mockRejectedValue(new Error("storage offline"));
    recentTasteEvents.mockResolvedValue([]);

    const { result } = renderHook(() => useWatchStats(true));

    await waitFor(() => expect(result.current).toBeNull());
    expect(listHistory).toHaveBeenCalledTimes(1);
    expect(recentTasteEvents).toHaveBeenCalledTimes(1);
  });

  it("recomputes when stable deps change", async () => {
    listHistory.mockResolvedValue([]);
    recentTasteEvents.mockResolvedValue([]);

    const { rerender } = renderHook(
      ({ enabled, deps }) => useWatchStats(enabled, deps),
      {
        initialProps: { enabled: true, deps: ["a"] as readonly string[] },
      },
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));
    listHistory.mockClear();
    recentTasteEvents.mockClear();

    rerender({ enabled: true, deps: ["b"] as readonly string[] });
    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));
    expect(listHistory).toHaveBeenCalledWith(500);

    rerender({ enabled: false, deps: ["b"] as readonly string[] });
    expect(listHistory).toHaveBeenCalledTimes(1);
  });
});
