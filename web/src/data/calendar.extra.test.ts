// Extra tests for the calendar data layer - covers branches the original
// calendar.test.ts does not: collectSeries (store-backed dedup / type-filter /
// fault tolerance) plus additional groupEpisodes edge cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPreview } from "../models/media";
import type { UpcomingEpisode } from "../lib/metadata";

// --- Mock the store module that collectSeries imports. ---------------------
const listLibrary = vi.fn();
const listWatchlist = vi.fn();
vi.mock("../storage", () => ({
  getStore: () => ({ listLibrary, listWatchlist }),
}));

// Import AFTER the mock is registered.
import { collectSeries, groupEpisodes } from "./calendar";

function preview(id: string, type: MediaPreview["type"] = "series"): MediaPreview {
  return { id, type, title: `Title ${id}` };
}

function libEntry(p: MediaPreview, addedAt = "2026-01-01T00:00:00.000Z") {
  return { preview: p, addedAt };
}
function watchRecord(p: MediaPreview, addedAt = "2026-01-01T00:00:00.000Z") {
  return { preview: p, addedAt };
}

function ep(airDate: string, episodeNumber = 1): UpcomingEpisode {
  return {
    series: preview("s"),
    seasonNumber: 1,
    episodeNumber,
    title: `Ep ${episodeNumber}`,
    airDate,
  };
}

beforeEach(() => {
  listLibrary.mockReset();
  listWatchlist.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectSeries", () => {
  it("merges favorites + watchlist newest-first across both sources", async () => {
    listLibrary.mockResolvedValue([
      libEntry(preview("a"), "2026-01-01T00:00:00.000Z"),
      libEntry(preview("b"), "2026-01-03T00:00:00.000Z"),
    ]);
    listWatchlist.mockResolvedValue([
      watchRecord(preview("c"), "2026-01-02T00:00:00.000Z"),
    ]);

    const out = await collectSeries();

    expect(out.map((p) => p.id)).toEqual(["b", "c", "a"]);
    // Favorites must be requested with the "favorites" list type.
    expect(listLibrary).toHaveBeenCalledWith("favorites");
    expect(listWatchlist).toHaveBeenCalled();
  });

  it("dedupes by id, keeping the first (favorites) occurrence", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("dup"))]);
    listWatchlist.mockResolvedValue([watchRecord(preview("dup")), watchRecord(preview("x"))]);

    const out = await collectSeries();

    expect(out.map((p) => p.id)).toEqual(["dup", "x"]);
  });

  it("filters out non-series media (movies)", async () => {
    listLibrary.mockResolvedValue([
      libEntry(preview("movie1", "movie")),
      libEntry(preview("show1", "series")),
    ]);
    listWatchlist.mockResolvedValue([watchRecord(preview("movie2", "movie"))]);

    const out = await collectSeries();

    expect(out.map((p) => p.id)).toEqual(["show1"]);
  });

  it("returns [] when there is nothing in either list", async () => {
    listLibrary.mockResolvedValue([]);
    listWatchlist.mockResolvedValue([]);

    expect(await collectSeries()).toEqual([]);
  });

  it("falls back to [] for favorites when listLibrary rejects", async () => {
    listLibrary.mockRejectedValue(new Error("library down"));
    listWatchlist.mockResolvedValue([watchRecord(preview("w"))]);

    const out = await collectSeries();

    // Library error swallowed -> only the watchlist series survives.
    expect(out.map((p) => p.id)).toEqual(["w"]);
  });

  it("falls back to [] for watchlist when listWatchlist rejects", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("f"))]);
    listWatchlist.mockRejectedValue(new Error("watchlist down"));

    const out = await collectSeries();

    expect(out.map((p) => p.id)).toEqual(["f"]);
  });

  it("returns [] when both lists reject", async () => {
    listLibrary.mockRejectedValue(new Error("a"));
    listWatchlist.mockRejectedValue(new Error("b"));

    expect(await collectSeries()).toEqual([]);
  });
});

// A fixed "now": 2026-06-17T12:00:00Z.
const NOW = Date.parse("2026-06-17T12:00:00Z");

describe("groupEpisodes (additional edge cases)", () => {
  it("collapses many episodes per bucket and preserves input order within a bucket", async () => {
    const groups = groupEpisodes(
      [
        ep("2026-06-17", 1), // today
        ep("2026-06-17", 2), // today
        ep("2026-06-19", 3), // week
        ep("2026-06-20", 4), // week
        ep("2026-08-01", 5), // later
      ],
      NOW,
    );
    expect(groups.map((g) => g.bucket)).toEqual(["today", "week", "later"]);
    expect(groups[0].episodes.map((e) => e.episodeNumber)).toEqual([1, 2]);
    expect(groups[1].episodes.map((e) => e.episodeNumber)).toEqual([3, 4]);
    expect(groups[2].episodes.map((e) => e.episodeNumber)).toEqual([5]);
  });

  it("does NOT reorder out-of-order input (no internal sort)", () => {
    const groups = groupEpisodes([ep("2026-06-20", 9), ep("2026-06-19", 8)], NOW);
    // Both fall in 'week'; original order is retained.
    expect(groups[0].episodes.map((e) => e.episodeNumber)).toEqual([9, 8]);
  });

  it("puts the day after the 7-day boundary into 'later'", () => {
    // weekEnd for NOW is 2026-06-24; one day later is upcoming.
    const groups = groupEpisodes([ep("2026-06-25", 1)], NOW);
    expect(groups[0].bucket).toBe("later");
  });

  it("drops a stale/past air date instead of mis-bucketing it as 'week' (regression)", () => {
    // A date before 'today' has already aired - it must not show as upcoming.
    const groups = groupEpisodes([ep("2026-06-10", 1)], NOW);
    expect(groups).toEqual([]);
  });

  it("produces only the today bucket when all episodes air today", () => {
    const groups = groupEpisodes([ep("2026-06-17", 1), ep("2026-06-17", 2)], NOW);
    expect(groups.map((g) => g.bucket)).toEqual(["today"]);
    expect(groups[0].label).toBe("Today");
  });

  it("uses the correct labels for week and later buckets", () => {
    const groups = groupEpisodes([ep("2026-06-19", 1), ep("2026-07-30", 2)], NOW);
    expect(groups.find((g) => g.bucket === "week")?.label).toBe("This week");
    expect(groups.find((g) => g.bucket === "later")?.label).toBe("Upcoming");
  });

  it("respects an injected `now` that shifts the today boundary", () => {
    // groupEpisodes buckets against the LOCAL date, so `now` has to be a local
    // instant on the same day as the episode. A UTC-midnight instant is the
    // previous local day at any negative offset, which put this in "week" for
    // anyone in the Americas while passing on UTC CI runners.
    const later = new Date(2026, 5, 20, 12, 0, 0).getTime();
    const groups = groupEpisodes([ep("2026-06-20", 1)], later);
    expect(groups[0].bucket).toBe("today");
  });
});
