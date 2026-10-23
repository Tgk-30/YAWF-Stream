import { describe, expect, it, vi } from "vitest";
import { CinemetaEpisodeService } from "./CinemetaEpisodeService";

function guideBody(
  imdbId: string,
  regularSeasonCounts: number[],
  specials: number[] = [],
): string {
  const videos = [
    ...specials.map((number) => ({
      id: `${imdbId}:0:${number}`,
      season: 0,
      number,
      episode: number,
      name: `Special ${number}`,
    })),
    ...regularSeasonCounts.flatMap((count, index) =>
      Array.from({ length: count }, (_, episodeIndex) => {
        const season = index + 1;
        const number = episodeIndex + 1;
        return {
          id: `${imdbId}:${season}:${number}`,
          season,
          number,
          episode: number,
          name:
            imdbId === "tt0434665" && season === 2 && number === 7
              ? "Release the Death Blow!"
              : `S${season}E${number}`,
          released: "2005-04-13T00:00:00.000Z",
        };
      }),
    ),
  ];
  return JSON.stringify({ meta: { id: imdbId, type: "series", videos } });
}

function serviceWith(body: string) {
  const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => body }));
  return { service: new CinemetaEpisodeService(fetchImpl), fetchImpl };
}

describe("CinemetaEpisodeService", () => {
  it("uses AbortController when AbortSignal.timeout is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    });
    try {
      const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return { status: 200, text: async () => guideBody("tt0434665", [1]) };
      });
      await expect(new CinemetaEpisodeService(fetchImpl).getGuide("tt0434665"))
        .resolves.toMatchObject({ imdbId: "tt0434665" });
    } finally {
      if (descriptor != null) Object.defineProperty(AbortSignal, "timeout", descriptor);
    }
  });

  it("preserves Bleach's exact canonical seasons and non-contiguous specials", async () => {
    const { service, fetchImpl } = serviceWith(
      guideBody("tt0434665", [20, 21], [1, 2, 99, 6]),
    );
    const guide = await service.getGuide("tt0434665");

    expect(guide.seasons.map((season) => [season.seasonNumber, season.episodeCount])).toEqual([
      [0, 4],
      [1, 20],
      [2, 21],
    ]);
    expect(guide.episodesBySeason.get(2)?.[6]).toMatchObject({
      id: "tt0434665:2:7",
      seasonNumber: 2,
      episodeNumber: 7,
      title: "Release the Death Blow!",
      airDate: "2005-04-13",
    });
    expect(guide.episodesBySeason.get(0)?.map((episode) => episode.episodeNumber)).toEqual([
      1, 2, 6, 99,
    ]);

    await service.getGuide("tt0434665");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Naruto", "tt0409591", [35, 48]],
    ["Breaking Bad", "tt0903747", [7, 13]],
  ])("accepts validated %s seasonal inventory", async (_name, imdbId, counts) => {
    const { service } = serviceWith(guideBody(imdbId, counts, [1, 3]));
    const guide = await service.getGuide(imdbId);
    expect(guide.seasons.filter((season) => season.seasonNumber > 0).map(
      (season) => season.episodeCount,
    )).toEqual(counts);
  });

  it("rejects a mismatched IMDb identity and non-contiguous regular episodes", async () => {
    const mismatch = serviceWith(guideBody("tt0409591", [2])).service;
    await expect(mismatch.getGuide("tt0434665")).rejects.toThrow("identity");

    const malformed = JSON.stringify({
      meta: {
        id: "tt0434665",
        type: "series",
        videos: [{ id: "tt0434665:1:2", season: 1, number: 2, episode: 2 }],
      },
    });
    await expect(serviceWith(malformed).service.getGuide("tt0434665")).rejects.toThrow(
      "non-contiguous episodes",
    );
  });
});
