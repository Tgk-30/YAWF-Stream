import { describe, expect, it } from "vitest";
import {
  buildTitleQuery,
  filterResultsByTitle,
  combineStreamResults,
  releaseYearDisagrees,
} from "./streamMatching";
import type { TorrentResult } from "../services/indexers/models";
import { VideoQuality } from "../services/indexers/models";

function tr(
  infoHash: string,
  title: string,
  seeders = 1,
  quality: VideoQuality = VideoQuality.hd1080p,
  fileIndex: number | null = null,
  fileNameHint: string | null = null,
): TorrentResult {
  return {
    infoHash,
    title,
    seeders,
    quality,
    leechers: 0,
    sizeBytes: 0,
    magnetURI: "",
    source: "test",
    fileIndex,
    fileNameHint,
  } as unknown as TorrentResult;
}

describe("buildTitleQuery", () => {
  it("appends a zero-padded SxxEyy tag for an episode", () => {
    expect(buildTitleQuery("The Bear", 1, 6)).toBe("The Bear S01E06");
    expect(buildTitleQuery("Severance", 12, 3)).toBe("Severance S12E03");
  });
  it("is the bare (trimmed) title for a movie", () => {
    expect(buildTitleQuery("  Oppenheimer  ", null, null)).toBe("Oppenheimer");
  });
});

describe("filterResultsByTitle - contiguous whole-word phrase", () => {
  it("keeps releases that lead with the title regardless of separators/case", () => {
    const kept = filterResultsByTitle(
      [
        tr("a", "The.Bear.S01E01.1080p.WEB-DL"),
        tr("b", "the bear s01e01 XviD-AFG"),
      ],
      "The Bear",
    );
    expect(kept.map((r) => r.infoHash)).toEqual(["a", "b"]);
  });

  it("rejects a DIFFERENT show that merely shares the title's words", () => {
    // The exact false positive seen live: both "the" and "bear" appear, but not
    // as the contiguous phrase "the bear".
    const kept = filterResultsByTitle(
      [tr("x", "The.Adventures.Of.Paddington.Bear.S01E01.WEB")],
      "The Bear",
    );
    expect(kept).toEqual([]);
  });

  it("rejects a same-SxxEyy wrong show", () => {
    const kept = filterResultsByTitle(
      [tr("y", "Yellowstone S01E06 1080p")],
      "The Bear",
    );
    expect(kept).toEqual([]);
  });

  it("folds & vs 'and' so a spelled-out connector still matches", () => {
    const kept = filterResultsByTitle(
      [
        tr("dd", "Dungeons.and.Dragons.Honor.Among.Thieves.2023.1080p.WEB-DL"),
        tr("tj", "Tom.and.Jerry.2021.1080p"),
      ],
      "Dungeons & Dragons: Honor Among Thieves",
    );
    // The D&D release survives the &→and fold; Tom & Jerry is a different title.
    expect(kept.map((r) => r.infoHash)).toEqual(["dd"]);
    expect(filterResultsByTitle([tr("tj", "Tom.and.Jerry.2021")], "Tom & Jerry")).toHaveLength(1);
  });

  it("matches single/short titles only on a whole-word boundary", () => {
    const kept = filterResultsByTitle(
      [tr("hit", "It 2017 1080p"), tr("miss", "Bitcoin Heist 1080p")],
      "It",
    );
    expect(kept.map((r) => r.infoHash)).toEqual(["hit"]);
  });

  it("passes everything through for an empty title", () => {
    const all = [tr("a", "Anything")];
    expect(filterResultsByTitle(all, "")).toBe(all);
  });
});

describe("combineStreamResults", () => {
  it("merges imdb + validated title pass, dedupes by hash, sorts best-first", () => {
    const byImdb = [tr("A", "The Bear S01E01 720p", 5, VideoQuality.hd720p)];
    const byTitle = [
      tr("B", "The Bear S01E01 2160p", 40, VideoQuality.uhd4k),
      tr("nope", "Paddington Bear S01E01", 999),
    ];
    const merged = combineStreamResults(byImdb, byTitle, "The Bear");
    // Paddington dropped; 4K leads on quality; hash A survives.
    expect(merged.map((r) => r.infoHash)).toEqual(["B", "A"]);
  });

  it("does not merge different explicit file indices sharing one hash", () => {
    const merged = combineStreamResults(
      [tr("same", "The Bear S01E01 small", 1, VideoQuality.hd720p, 0)],
      [tr("same", "The Bear S01E01 large", 99, VideoQuality.uhd4k, 1)],
      "The Bear",
    );
    expect(merged.map((result) => result.fileIndex)).toEqual([1, 0]);
  });

  it("prefers a usable selector over a higher-seeder duplicate", () => {
    const merged = combineStreamResults(
      [tr("same", "The Bear S01E01", 999, VideoQuality.uhd4k, 0, null)],
      [tr("same", "The Bear S01E01", 1, VideoQuality.hd720p, 0, "small.avi")],
      "The Bear",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].fileNameHint).toBe("small.avi");
  });
});

describe("releaseYearDisagrees - conservative wrong-year detection", () => {
  it("is neutral (false) when the target year is unknown", () => {
    expect(releaseYearDisagrees("The.Odyssey.1997.1080p", "The Odyssey", null)).toBe(false);
  });

  it("is neutral when the release name has no parseable year", () => {
    expect(releaseYearDisagrees("The.Odyssey.1080p.WEB.H264-GRP", "The Odyssey", 2026)).toBe(false);
  });

  it("flags a clean wrong-year release", () => {
    expect(releaseYearDisagrees("The.Odyssey.1997.1080p.BluRay.x264", "The Odyssey", 2026)).toBe(true);
    expect(releaseYearDisagrees("The Odyssey (2016) 720p WEBRip", "The Odyssey", 2026)).toBe(true);
  });

  it("tolerates +/-1 (festival/encode-year drift off the canonical year)", () => {
    expect(releaseYearDisagrees("The.Odyssey.2025.1080p.WEB-DL", "The Odyssey", 2026)).toBe(false);
    expect(releaseYearDisagrees("The.Odyssey.2027.1080p.WEB-DL", "The Odyssey", 2026)).toBe(false);
  });

  it("lets ONE agreeing year outweigh remaster/encode-year noise", () => {
    // Real-world shape: original year plus a later remaster/rip year.
    const name = "The.Odyssey.1997.REMASTERED.2016.1080p.BluRay";
    expect(releaseYearDisagrees(name, "The Odyssey", 1997)).toBe(false);
    // ...but for the 2026 film NEITHER year is compatible.
    expect(releaseYearDisagrees(name, "The Odyssey", 2026)).toBe(true);
  });

  it("treats a year-range pack as agreeing when the target falls inside it", () => {
    const pack = "The.Odyssey.Collection.1997-2016.1080p.x265";
    // 2005 matches NO single token - only the range covers it.
    expect(releaseYearDisagrees(pack, "The Odyssey", 2005)).toBe(false);
    expect(releaseYearDisagrees(pack, "The Odyssey", 2026)).toBe(true);
  });

  it("never reads a year-bearing TITLE as a release year", () => {
    // "2012" (2009): the title token must not count as year evidence...
    expect(releaseYearDisagrees("2012.1080p.BluRay.x264", "2012", 2009)).toBe(false);
    // ...while a real release year next to it still does.
    expect(releaseYearDisagrees("2012.2009.1080p.BluRay", "2012", 2009)).toBe(false);
    expect(releaseYearDisagrees("Blade.Runner.2049.2017.2160p.REMUX", "Blade Runner 2049", 2017)).toBe(false);
  });

  it("never reads resolution/dimension digits as a year", () => {
    expect(releaseYearDisagrees("The.Odyssey.2160p.HDR.DV", "The Odyssey", 2026)).toBe(false);
    expect(releaseYearDisagrees("The Odyssey 1920x1080 WEBRip", "The Odyssey", 2026)).toBe(false);
  });
});

describe("combineStreamResults - year-aware down-ranking (movies)", () => {
  // The v0.9.3 CV QA case: The Odyssey (2026)'s Download menu led with the
  // 1997/2016 adaptations. Wrong-year releases must sink below every
  // compatible-or-unknown-year release - even better-quality, better-seeded
  // ones - but must NOT be dropped (torrent names are messy).
  const odyssey = {
    byTitle: [
      tr("y1997uhd", "The Odyssey 1997 2160p REMUX", 900, VideoQuality.uhd4k),
      tr("y1997", "The.Odyssey.1997.1080p.BluRay.x264", 500),
      tr("y2016", "The Odyssey (2016) 720p WEBRip", 300, VideoQuality.hd720p),
      tr("noyear", "The.Odyssey.1080p.WEB.H264-GRP", 100),
      tr("y2026", "The.Odyssey.2026.1080p.WEB-DL", 40),
    ],
  };

  it("ranks the 2026 release above the 1997/2016 ones for The Odyssey (2026)", () => {
    const merged = combineStreamResults([], odyssey.byTitle, "The Odyssey", 2026);
    // Year-compatible + unknown-year first (their usual quality/seeder order),
    // wrong-year last (also quality/seeder order) - and nothing dropped.
    expect(merged.map((r) => r.infoHash)).toEqual([
      "noyear",
      "y2026",
      "y1997uhd",
      "y1997",
      "y2016",
    ]);
  });

  it("keeps the pre-existing order when no year is given (additive default)", () => {
    const merged = combineStreamResults([], odyssey.byTitle, "The Odyssey");
    // Plain quality-then-seeders: 4K first, the 1080p rows by seeders, 720p last.
    expect(merged.map((r) => r.infoHash)).toEqual([
      "y1997uhd",
      "y1997",
      "noyear",
      "y2026",
      "y2016",
    ]);
  });

  it("down-ranks a wrong-year release from the imdb pass too (mislabel guard)", () => {
    const byImdb = [
      tr("wrong", "The.Odyssey.1997.2160p", 900, VideoQuality.uhd4k),
      tr("right", "The.Odyssey.2026.720p", 10, VideoQuality.hd720p),
    ];
    const merged = combineStreamResults(byImdb, [], "The Odyssey", 2026);
    expect(merged.map((r) => r.infoHash)).toEqual(["right", "wrong"]);
  });
});
