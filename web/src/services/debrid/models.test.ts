// Unit tests for the pure filename/quality parsers and the file selector in the
// debrid models. These classify untrusted torrent filenames (quality, codec,
// audio, source) and pick which file to actually stream - core domain logic that
// was largely untested.

import { describe, expect, it } from "vitest";
import {
  AudioFormat,
  DebridFileSelector,
  lastPathComponent,
  mediaTokenMatch,
  SourceType,
  VideoCodec,
  VideoQuality,
  type DebridFileCandidate,
} from "./models";

describe("mediaTokenMatch", () => {
  it("matches a whole token bounded by non-alphanumerics", () => {
    expect(mediaTokenMatch("movie.sd.x264", "sd")).toBe(true);
    expect(mediaTokenMatch("a ts b", "ts")).toBe(true);
  });
  it("does not match a token embedded in a larger word/number", () => {
    expect(mediaTokenMatch("hdtvsd", "sd")).toBe(false);
    expect(mediaTokenMatch("sd1080", "sd")).toBe(false);
  });
});

describe("VideoQuality.parse", () => {
  it("maps the resolution markers", () => {
    expect(VideoQuality.parse("Film.2160p.mkv")).toBe("4K");
    expect(VideoQuality.parse("Film.UHD.mkv")).toBe("4K");
    expect(VideoQuality.parse("Film.4K.mkv")).toBe("4K");
    expect(VideoQuality.parse("Film.1080p.mkv")).toBe("1080p");
    expect(VideoQuality.parse("Film.720p.mkv")).toBe("720p");
    expect(VideoQuality.parse("Film.480p.mkv")).toBe("480p");
  });
  it("maps SD-class markers and falls back to Unknown", () => {
    expect(VideoQuality.parse("Film.DVDRip.avi")).toBe("SD");
    expect(VideoQuality.parse("Film.HDTV.avi")).toBe("SD");
    expect(VideoQuality.parse("Film.mkv")).toBe("Unknown");
  });
  it("orders qualities by sortOrder", () => {
    expect(VideoQuality.sortOrder("4K")).toBeGreaterThan(
      VideoQuality.sortOrder("1080p"),
    );
    expect(VideoQuality.sortOrder("Unknown")).toBe(0);
  });
});

describe("VideoCodec.parse", () => {
  it("recognizes the codec families", () => {
    expect(VideoCodec.parse("Film.x265.mkv")).toBe("H.265");
    expect(VideoCodec.parse("Film.HEVC.mkv")).toBe("H.265");
    expect(VideoCodec.parse("Film.x264.mkv")).toBe("H.264");
    expect(VideoCodec.parse("Film.AVC.mkv")).toBe("H.264");
    expect(VideoCodec.parse("Film.AV1.mkv")).toBe("AV1");
    expect(VideoCodec.parse("Film.XviD.avi")).toBe("XviD");
    expect(VideoCodec.parse("Film.DivX.avi")).toBe("XviD");
    expect(VideoCodec.parse("Film.mkv")).toBe("Unknown");
  });
});

describe("AudioFormat.parse", () => {
  it("prefers the most specific format first", () => {
    expect(AudioFormat.parse("Film.Atmos.mkv")).toBe("Atmos");
    expect(AudioFormat.parse("Film.DTS-HD.MA.mkv")).toBe("DTS-HD MA");
    expect(AudioFormat.parse("Film.DTS-X.mkv")).toBe("DTS:X");
    expect(AudioFormat.parse("Film.TrueHD.mkv")).toBe("TrueHD");
    expect(AudioFormat.parse("Film.DTS.mkv")).toBe("DTS");
    expect(AudioFormat.parse("Film.DDP5.1.mkv")).toBe("AC3");
    expect(AudioFormat.parse("Film.AC3.mkv")).toBe("AC3");
    expect(AudioFormat.parse("Film.AAC.mkv")).toBe("AAC");
    expect(AudioFormat.parse("Film.mkv")).toBe("Unknown");
  });
});

describe("SourceType.parse", () => {
  it("recognizes the source families", () => {
    expect(SourceType.parse("Film.BluRay.mkv")).toBe("BluRay");
    expect(SourceType.parse("Film.BDRip.mkv")).toBe("BluRay");
    expect(SourceType.parse("Film.WEB-DL.mkv")).toBe("WEB-DL");
    expect(SourceType.parse("Film.WEBRip.mkv")).toBe("WEBRip");
    expect(SourceType.parse("Film.HDRip.mkv")).toBe("HDRip");
    expect(SourceType.parse("Film.DVDRip.avi")).toBe("DVDRip");
    expect(SourceType.parse("Film.HDTV.mkv")).toBe("HDTV");
    expect(SourceType.parse("Film.HDCAM.mkv")).toBe("CAM");
    expect(SourceType.parse("Film.mkv")).toBe("Unknown");
  });
});

describe("lastPathComponent", () => {
  it("returns the final path segment", () => {
    expect(lastPathComponent("/a/b/movie.mkv")).toBe("movie.mkv");
    expect(lastPathComponent("movie.mkv")).toBe("movie.mkv");
  });
  it("strips a trailing slash before taking the segment", () => {
    expect(lastPathComponent("/a/b/")).toBe("b");
    // Degenerate root "/" (never a real debrid file path): the trailing-slash
    // strip is guarded by length>1, so it yields "" - documented, not relied on.
    expect(lastPathComponent("/")).toBe("");
  });
});

describe("DebridFileSelector.selectBest", () => {
  it("selects only a unique named exact file and rejects incomplete or impossible hints", () => {
    const candidates = [
      { link: "17", fileName: "extras/Large.Movie.mkv", sizeBytes: 9_000 },
      { link: "903", fileName: "feature/Requested.Small.avi", sizeBytes: 100 },
      { link: "44", fileName: "README.txt", sizeBytes: 10 },
    ];

    expect(DebridFileSelector.selectForHint(candidates, {
      fileIndex: 0,
      fileName: "Requested.Small.avi",
    })?.link).toBe("903");
    expect(DebridFileSelector.selectForHint(candidates, {
      fileIndex: 0,
      fileName: null,
    })).toBeNull();
    expect(DebridFileSelector.selectForHint(candidates, {
      fileIndex: 1_000_001,
      fileName: "Requested.Small.avi",
    })).toBeNull();
    expect(DebridFileSelector.selectForHint(
      candidates.concat({ link: "904", fileName: "other/Requested.Small.avi", sizeBytes: 90 }),
      { fileIndex: 0, fileName: "Requested.Small.avi" },
    )).toBeNull();
    expect(DebridFileSelector.selectForHint(
      [{ link: "1", fileName: "Show.S02E08.mp4", sizeBytes: 100 }],
      {
        fileIndex: 0,
        fileName: "Show.S02E08.mp4",
        season: 2,
        episode: 7,
      },
    )).toBeNull();
  });
  function f(
    fileName: string,
    sizeBytes: number,
    link = fileName,
  ): DebridFileCandidate {
    return { link, fileName, sizeBytes };
  }

  it("returns null for no candidates", () => {
    expect(DebridFileSelector.selectBest([])).toBeNull();
  });

  it("prefers a video file over a non-video file", () => {
    const best = DebridFileSelector.selectBest([
      f("readme.txt", 9_999_999),
      f("movie.mkv", 1_000),
    ]);
    expect(best?.fileName).toBe("movie.mkv");
  });

  it("prefers the feature over a sample of the same type", () => {
    const best = DebridFileSelector.selectBest([
      f("sample.mkv", 50_000_000),
      f("feature.mkv", 1_000_000),
    ]);
    expect(best?.fileName).toBe("feature.mkv");
  });

  it("prefers the larger file when type/container/codec tie", () => {
    const best = DebridFileSelector.selectBest([
      f("a.mkv", 1_000_000),
      f("b.mkv", 5_000_000),
    ]);
    expect(best?.fileName).toBe("b.mkv");
  });

  it("keeps the first candidate on a full tie (stable)", () => {
    const best = DebridFileSelector.selectBest([
      f("first.mkv", 1_000_000),
      f("first.mkv", 1_000_000, "other-link"),
    ]);
    expect(best?.link).toBe("first.mkv");
  });
});

// ---------------------------------------------------------------------------
// Episode-tag matching + pack-aware selection (season-pack file pick)
// ---------------------------------------------------------------------------

import { fileMatchesEpisode, matchEpisodeTag } from "./models";

describe("matchEpisodeTag / fileMatchesEpisode", () => {
  it("recognizes the canonical tag formats (uppercased input)", () => {
    expect(matchEpisodeTag("SHOW.S02E05.1080P")).toEqual({ season: 2, episode: 5 });
    expect(matchEpisodeTag("SHOW S2 E5")).toEqual({ season: 2, episode: 5 });
    expect(matchEpisodeTag("SHOW.S02.E05")).toEqual({ season: 2, episode: 5 });
    expect(matchEpisodeTag("SHOW.2X05.HDTV")).toEqual({ season: 2, episode: 5 });
    expect(matchEpisodeTag("SHOW.1080P.WEB")).toBeNull();
  });

  it("does not false-positive on resolution strings like 1920X1080", () => {
    expect(matchEpisodeTag("SHOW.S02.1920X1080.COMPLETE")).toBeNull();
    expect(fileMatchesEpisode("Show.1920x1080.mkv", { season: 19, episode: 20 })).toBe(false);
  });

  it("matches case-insensitively on file names, basename first", () => {
    expect(fileMatchesEpisode("show.s02e05.mkv", { season: 2, episode: 5 })).toBe(true);
    expect(
      fileMatchesEpisode("Show.Season.2/Show.2x05.mkv", { season: 2, episode: 5 }),
    ).toBe(true);
    expect(fileMatchesEpisode("show.s02e06.mkv", { season: 2, episode: 5 })).toBe(false);
  });
});

describe("DebridFileSelector.selectBest with an episode hint", () => {
  const pack = [
    { link: "1", fileName: "Show.S02E04.1080p.mkv", sizeBytes: 4_000_000_000 },
    { link: "2", fileName: "Show.S02E05.1080p.mkv", sizeBytes: 3_000_000_000 },
    { link: "3", fileName: "Show.S02E05.SAMPLE.mkv", sizeBytes: 50_000_000 },
    { link: "4", fileName: "Show.S02E06.2160p.mkv", sizeBytes: 8_000_000_000 },
  ];

  it("picks the hinted episode's file over larger non-matching files", () => {
    const best = DebridFileSelector.selectBest(pack, { season: 2, episode: 5 });
    expect(best?.link).toBe("2"); // real E05 file, not the bigger E06 / not the sample
  });

  it("still rejects sample files within the matching subset", () => {
    const best = DebridFileSelector.selectBest(
      pack.filter((c) => c.link === "2" || c.link === "3"),
      { season: 2, episode: 5 },
    );
    expect(best?.link).toBe("2");
  });

  it("falls back to the default pick when no file matches the hint", () => {
    const best = DebridFileSelector.selectBest(pack, { season: 9, episode: 9 });
    expect(best?.link).toBe("4"); // largest video - exactly the unhinted behavior
  });

  it("behaves identically to the unhinted call for null hints", () => {
    expect(DebridFileSelector.selectBest(pack, null)).toEqual(
      DebridFileSelector.selectBest(pack),
    );
  });
});

describe("matchEpisodeTag - codec-adjacency guard", () => {
  it("does not parse DD5.1.x264 / 7.1.x265 audio+codec strings as episode tags", () => {
    expect(matchEpisodeTag("SHOW.S02.COMPLETE.DD5.1.X264-GROUP")).toBeNull();
    expect(matchEpisodeTag("SHOW.SEASON.2.DDP7.1.X265")).toBeNull();
    expect(matchEpisodeTag("MOVIE.2160P.DD5.1.X265")).toBeNull();
  });

  it("keeps genuine NxNN tags working next to codec strings", () => {
    expect(matchEpisodeTag("SHOW.2X05.DD5.1.X264")).toEqual({ season: 2, episode: 5 });
  });

  it("keeps right-season packs classified as packs, not mismatches", () => {
    // The regression this guard exists for: a right-season pack whose name
    // carries DD5.1.x264 must NOT be dropped from an episode-scoped list.
    expect(fileMatchesEpisode("Show.S02.COMPLETE.DD5.1.x264.mkv", { season: 1, episode: 264 })).toBe(false);
  });
});
