// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, MediaPreview } from "../models/media";
import { setNetworkMode } from "../lib/networkPolicy";

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => true,
}));

const fetchServerDetail = vi.fn();
const fetchServerEpisodes = vi.fn();
vi.mock("../lib/serverApi", () => ({
  fetchServerDetail: (...args: unknown[]) => fetchServerDetail(...args),
  fetchServerEpisodes: (...args: unknown[]) => fetchServerEpisodes(...args),
}));

import { useDetail, type DetailState } from "./detail";
import { useEpisodes } from "./episodes";

function item(
  id: string,
  tmdbId: number,
  title: string,
): MediaItem {
  return {
    id,
    type: "series",
    title,
    year: id === "tt0434665" ? 2004 : 2022,
    posterPath: null,
    backdropPath: null,
    overview: null,
    genres: [],
    imdbRating: null,
    rtRating: null,
    runtime: null,
    status: null,
    tmdbId,
    lastFetched: "2026-10-23T00:00:00.000Z",
  };
}

function preview(
  id: string,
  tmdbId: number,
  title: string,
): MediaPreview {
  return { id, type: "series", title, tmdbId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ChainState {
  detail: DetailState;
  episodes: ReturnType<typeof useEpisodes>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setNetworkMode("standard");
});

describe("detail identity dependent request chain", () => {
  it("does not request a parent episode after the preview moves to the child", async () => {
    const childDetail = deferred<{
      item: MediaItem;
      cast: [];
      related: [];
      imdbId: string;
    }>();
    fetchServerDetail.mockImplementation(({ id }: { id: string }) => {
      if (id === "tt0434665") {
        return Promise.resolve({
          item: item("tt0434665", 30984, "Bleach"),
          cast: [],
          related: [],
          imdbId: "tt0434665",
        });
      }
      return childDetail.promise;
    });
    fetchServerEpisodes.mockImplementation(
      async ({ imdbId, tmdbId, season }: {
        imdbId: string;
        tmdbId: number;
        season: number;
      }) => ({
        episodes: [{
          id: `${imdbId}:${season}:1`,
          mediaId: imdbId,
          seasonNumber: season,
          episodeNumber: 1,
          title: "Episode 1",
        }],
        numbering: "cinemeta",
        guideVersion: "2",
        tmdbId,
      }),
    );

    const parent = preview("tt0434665", 30984, "Bleach");
    const child = preview(
      "tt14986406",
      215105,
      "Bleach: Thousand-Year Blood War",
    );
    const renders: ChainState[] = [];
    const hook = renderHook(
      ({ selected, season }: { selected: MediaPreview; season: number }) => {
        const detail = useDetail(selected, null);
        const episodes = useEpisodes(
          detail.data.item?.tmdbId ?? selected.tmdbId ?? null,
          season,
          null,
          detail.data.imdbId,
        );
        const state = { detail, episodes };
        renders.push(state);
        return state;
      },
      { initialProps: { selected: parent, season: 16 } },
    );
    await waitFor(() => expect(hook.result.current.episodes.source).toBe("live"));

    fetchServerEpisodes.mockClear();
    renders.length = 0;
    hook.rerender({ selected: child, season: 1 });

    expect(renders[0]?.detail).toMatchObject({
      loading: true,
      data: {
        imdbId: "tt14986406",
        item: { id: "tt14986406", tmdbId: 215105 },
      },
    });
    expect(renders[0]?.episodes).toMatchObject({
      episodes: [],
      loading: true,
      source: "none",
    });
    await waitFor(() => expect(fetchServerEpisodes).toHaveBeenCalled());
    expect(fetchServerEpisodes).toHaveBeenCalledWith({
      tmdbId: 215105,
      imdbId: "tt14986406",
      season: 1,
    });
    expect(fetchServerEpisodes).not.toHaveBeenCalledWith({
      tmdbId: 30984,
      imdbId: "tt0434665",
      season: 1,
    });

    hook.unmount();
  });
});
