// @vitest-environment jsdom
//
// Tests for the calendar React hooks (calendar.ts). App-wide useCalendar only
// resolves bounded followed-series episodes; route-local movie releases load
// through useMovieReleaseCalendar. collectSeries is driven through a mocked
// store; resolution through mocked lib/metadata + serverApi; localISODate stays
// real so groupEpisodes buckets correctly.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MediaPreview } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import type { UpcomingEpisode } from "../lib/metadata";

// ── Module mocks ─────────────────────────────────────────────────────────────
const listLibrary = vi.fn();
const listWatchlist = vi.fn();
vi.mock("../storage", () => ({
  getStore: () => ({ listLibrary, listWatchlist }),
}));

const getUpcomingEpisodesForSeries = vi.fn();
vi.mock("../lib/metadata", () => ({
  // Fully stub the module (avoid pulling its import chain into the worker).
  // localISODate is reimplemented faithfully so groupEpisodes buckets in local
  // time exactly as production does.
  localISODate: (now: number) => {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },
  MAX_CALENDAR_SERIES: 30,
  getUpcomingEpisodesForSeries: (...a: unknown[]) =>
    getUpcomingEpisodesForSeries(...a),
}));

const fetchServerUpcomingEpisodes = vi.fn();
const fetchServerMovieReleases = vi.fn();
vi.mock("../lib/serverApi", () => ({
  fetchServerUpcomingEpisodes: (...a: unknown[]) =>
    fetchServerUpcomingEpisodes(...a),
  fetchServerMovieReleases: () => fetchServerMovieReleases(),
}));

const isServerMode = vi.fn(() => false as boolean);
vi.mock("../lib/serverMode", () => ({
  isServerMode: () => isServerMode(),
}));

import { useCalendar, useMovieReleaseCalendar } from "./calendar";

const getMovieReleaseCalendar = vi.fn();

// ── Helpers ──────────────────────────────────────────────────────────────────
function preview(id: string, type: MediaPreview["type"] = "series"): MediaPreview {
  return { id, type, title: `Title ${id}` };
}
function libEntry(p: MediaPreview) {
  return { preview: p };
}
function watchRecord(p: MediaPreview) {
  return { preview: p };
}

/** An episode whose air date is "today" in local time, so it always buckets. */
function todayEp(series = preview("s")): UpcomingEpisode {
  const now = new Date();
  const airDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return {
    series,
    seasonNumber: 1,
    episodeNumber: 1,
    title: "Pilot",
    airDate,
  };
}

// A single STABLE service reference. `useCalendar` lists `tmdb` in its effect
// deps, so a fresh object per render would re-run the effect → setState →
// re-render forever. Reuse one identity across renders.
const SVC = { getMovieReleaseCalendar } as unknown as TMDBService;

beforeEach(() => {
  vi.clearAllMocks();
  isServerMode.mockReturnValue(false);
  listLibrary.mockResolvedValue([]);
  listWatchlist.mockResolvedValue([]);
  getMovieReleaseCalendar.mockResolvedValue([]);
  fetchServerMovieReleases.mockResolvedValue([]);
});

describe("useCalendar - initial state", () => {
  it("reports hasTMDB true when a service is provided", () => {
    const { result } = renderHook(() => useCalendar(SVC));
    // Synchronous first render: still loading, hasTMDB seeded from the service.
    expect(result.current.loading).toBe(true);
    expect(result.current.hasTMDB).toBe(true);
  });

  it("reports hasTMDB false when no service and not server mode", () => {
    const { result } = renderHook(() => useCalendar(null));
    expect(result.current.hasTMDB).toBe(false);
  });

  it("performs zero store or metadata I/O while durable profile setup is disabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCalendar(SVC, "series", 0, enabled),
      { initialProps: { enabled: false } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listLibrary).not.toHaveBeenCalled();
    expect(listWatchlist).not.toHaveBeenCalled();
    expect(getUpcomingEpisodesForSeries).not.toHaveBeenCalled();
    expect(fetchServerUpcomingEpisodes).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(1));
    expect(listWatchlist).toHaveBeenCalledTimes(1);
  });
});

describe("useCalendar - empty paths", () => {
  it("resolves to an empty agenda with hasSeries false when no series exist", async () => {
    listLibrary.mockResolvedValue([]);
    listWatchlist.mockResolvedValue([]);
    const { result } = renderHook(() => useCalendar(SVC));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([]);
    expect(result.current.entries).toEqual([]);
    expect(result.current.hasSeries).toBe(false);
    expect(result.current.error).toBeNull();
    // Episode resolution is never attempted when there are no series.
    expect(getUpcomingEpisodesForSeries).not.toHaveBeenCalled();
  });

  it("skips episode resolution (no key) but still flags hasSeries when series exist without a service", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("s1"))]);
    const { result } = renderHook(() => useCalendar(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasSeries).toBe(true);
    expect(result.current.hasTMDB).toBe(false);
    expect(result.current.groups).toEqual([]);
    expect(result.current.entries).toEqual([]);
    expect(getUpcomingEpisodesForSeries).not.toHaveBeenCalled();
  });
});

describe("useCalendar - live resolution", () => {
  it("resolves upcoming episodes via TMDB and groups them", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("s1"))]);
    getUpcomingEpisodesForSeries.mockResolvedValue([todayEp()]);

    const { result } = renderHook(() => useCalendar(SVC));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasSeries).toBe(true);
    expect(result.current.hasTMDB).toBe(true);
    expect(result.current.groups.map((g) => g.bucket)).toEqual(["today"]);
    expect(result.current.entries).toHaveLength(1);
    expect(getUpcomingEpisodesForSeries).toHaveBeenCalledWith(
      [preview("s1")],
      SVC,
      expect.any(Number),
      14,
    );
  });

  it("projects an empty calendar synchronously when durable setup becomes disabled", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("s1"))]);
    getUpcomingEpisodesForSeries.mockResolvedValue([todayEp()]);
    const renderSnapshots: Array<ReturnType<typeof useCalendar>> = [];
    const { result, rerender } = renderHook(
      ({ enabled }) => {
        const calendar = useCalendar(SVC, "series", 0, enabled);
        renderSnapshots.push(calendar);
        return calendar;
      },
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const snapshotsBeforeDisable = renderSnapshots.length;
    rerender({ enabled: false });

    expect(renderSnapshots[snapshotsBeforeDisable]).toEqual({
      entries: [],
      episodes: [],
      groups: [],
      loading: false,
      error: null,
      hasSeries: false,
      hasTMDB: true,
    });
  });
});

describe("useCalendar - server mode", () => {
  it("routes episode resolution through the server API when in server mode", async () => {
    isServerMode.mockReturnValue(true);
    listWatchlist.mockResolvedValue([watchRecord(preview("s2"))]);
    fetchServerUpcomingEpisodes.mockResolvedValue([todayEp(preview("s2"))]);

    // service null but server mode on → server resolver, hasTMDB true.
    const { result } = renderHook(() => useCalendar(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasTMDB).toBe(true);
    expect(result.current.groups.map((g) => g.bucket)).toEqual(["today"]);
    expect(result.current.entries).toHaveLength(1);
    expect(fetchServerUpcomingEpisodes).toHaveBeenCalledWith([preview("s2")]);
    expect(getUpcomingEpisodesForSeries).not.toHaveBeenCalled();
    expect(getMovieReleaseCalendar).not.toHaveBeenCalled();
    expect(fetchServerMovieReleases).not.toHaveBeenCalled();
  });

  it("loads TMDB movie releases only when the Calendar-only hook mounts", async () => {
    const date = todayEp().airDate;
    getMovieReleaseCalendar.mockResolvedValue([
      {
        movie: preview("m1", "movie"),
        releaseDate: date,
        source: "upcoming",
      },
    ]);

    const { result } = renderHook(() => useMovieReleaseCalendar(SVC));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.releases).toEqual([
      expect.objectContaining({ releaseDate: date, movie: preview("m1", "movie") }),
    ]);
    expect(getMovieReleaseCalendar).toHaveBeenCalledTimes(1);
  });
});

describe("useCalendar - error fallback", () => {
  it("surfaces an Error message and clears the agenda when resolution throws", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("s1"))]);
    getUpcomingEpisodesForSeries.mockRejectedValue(new Error("tmdb down"));

    const { result } = renderHook(() => useCalendar(SVC));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("tmdb down");
    expect(result.current.groups).toEqual([]);
    expect(result.current.entries).toEqual([]);
    expect(result.current.hasSeries).toBe(false);
  });

  it("stringifies a non-Error rejection", async () => {
    listLibrary.mockResolvedValue([libEntry(preview("s1"))]);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    getUpcomingEpisodesForSeries.mockRejectedValue("string failure");

    const { result } = renderHook(() => useCalendar(SVC));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("string failure");
  });
});
