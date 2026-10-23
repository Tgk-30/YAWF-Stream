import { describe, expect, it } from "vitest";
import {
  EPISODE_GUIDE_VERSION,
  hasEpisodeContinuationIdentityConflict,
  requiresCanonicalEpisodeGuide,
  resolveEpisodeSource,
} from "./episodeSource";

describe("episode source relations", () => {
  it("maps Bleach display seasons 17+ to the verified TYBW identity", () => {
    expect(EPISODE_GUIDE_VERSION).toBe("2");
    expect(resolveEpisodeSource({
      imdbId: "tt0434665",
      tmdbId: 30984,
      season: 17,
      episode: 7,
      title: "Bleach",
      year: 2004,
    })).toEqual({
      displaySeason: 17,
      displayEpisode: 7,
      imdbId: "tt14986406",
      tmdbId: 215105,
      season: 1,
      episode: 7,
      title: "Bleach: Thousand-Year Blood War",
      year: 2022,
    });
    expect(resolveEpisodeSource({
      imdbId: "tt0434665",
      tmdbId: 30984,
      season: 20,
      episode: 1,
    }).season).toBe(4);
    expect(resolveEpisodeSource({
      imdbId: "tt0434665",
      tmdbId: null,
      season: 19,
      episode: 1,
    })).toMatchObject({
      imdbId: "tt14986406",
      tmdbId: 215105,
      season: 3,
      episode: 1,
    });
  });

  it("requires the canonical guide for the verified parent TMDB identity alone", () => {
    expect(requiresCanonicalEpisodeGuide(null, 30984)).toBe(true);
    expect(requiresCanonicalEpisodeGuide(null, 1396)).toBe(false);
  });

  it("fails closed on the verified child IMDb and parent TMDB conflict only", () => {
    expect(hasEpisodeContinuationIdentityConflict("tt14986406", 30984)).toBe(true);
    expect(hasEpisodeContinuationIdentityConflict("tt14986406", 215105)).toBe(false);
    expect(hasEpisodeContinuationIdentityConflict("tt0434665", 215105)).toBe(true);
    expect(hasEpisodeContinuationIdentityConflict("tt0903747", 30984)).toBe(false);
  });

  it("does not map original seasons, a separate sequel entry, or other shows", () => {
    expect(resolveEpisodeSource({
      imdbId: "tt0434665", tmdbId: 30984, season: 2, episode: 7,
    })).toMatchObject({ imdbId: "tt0434665", tmdbId: 30984, season: 2, episode: 7 });
    expect(resolveEpisodeSource({
      imdbId: "tt14986406", tmdbId: 215105, season: 1, episode: 7,
    })).toMatchObject({ imdbId: "tt14986406", tmdbId: 215105, season: 1, episode: 7 });
    expect(resolveEpisodeSource({
      imdbId: "tt0903747", tmdbId: 1396, season: 17, episode: 1,
    })).toMatchObject({ imdbId: "tt0903747", tmdbId: 1396, season: 17, episode: 1 });
    expect(resolveEpisodeSource({
      imdbId: "tt0434665", tmdbId: 999, season: 17, episode: 1,
    })).toMatchObject({ imdbId: "tt0434665", tmdbId: 999, season: 17, episode: 1 });
  });
});
