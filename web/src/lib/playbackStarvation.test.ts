import { describe, expect, it } from "vitest";
import { PlaybackStarvation, lowerStarvationQuality } from "./playbackStarvation";

describe("PlaybackStarvation", () => {
  it("counts three progressed episodes, not repeated waiting or playing events", () => {
    const policy = new PlaybackStarvation();
    expect(policy.waiting(0, 0, true)).toBe(false);
    policy.progress(10, true); policy.progress(11, true);
    expect(policy.waiting(1_000, 0.5, true)).toBe(false);
    for (let i = 0; i < 10; i++) expect(policy.waiting(2_000, 0, true)).toBe(false);
    policy.progress(11, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
    policy.progress(12, true);
    expect(policy.waiting(4_000, 0, true)).toBe(false);
    policy.progress(13, true);
    expect(policy.waiting(5_000, 0, true)).toBe(true);
    policy.interrupt();
    for (let i = 0; i < 10; i++) {
      policy.progress(14 + i, true);
      expect(policy.waiting(6_000 + i, 0, true)).toBe(false);
    }
  });

  it("ignores healthy buffer, invalid buffer, and episodes outside the rolling window", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true);
    expect(policy.waiting(0, 6, true)).toBe(false);
    expect(policy.waiting(1, NaN, true)).toBe(false);
    expect(policy.waiting(2, 0, true)).toBe(false);
    policy.progress(12, true);
    expect(policy.waiting(46_000, 0, true)).toBe(false);
    policy.progress(13, true);
    expect(policy.waiting(47_000, 0, true)).toBe(false);
    policy.progress(14, true);
    expect(policy.waiting(48_000, 0, true)).toBe(true);
  });

  it("does not count three healthy waiting events as starvation", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true);
    for (let i = 1; i <= 3; i++) {
      policy.progress(10 + i, true);
      expect(policy.waiting(i, 5, true)).toBe(false);
    }
    expect(policy.waiting(4, 0, true)).toBe(false);
  });

  it.each(["startup", "seek", "paused", "hidden", "lease", "reset", "handoff", "recovery"])("interrupts %s rather than inheriting progress or episodes", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true);
    policy.progress(12, true); policy.waiting(2, 0, true);
    expect(policy.waiting(3, 0, false)).toBe(false);
    policy.progress(13, false); policy.progress(14, true);
    expect(policy.waiting(4, 0, true)).toBe(false);
    policy.progress(15, true);
    expect(policy.waiting(5, 0, true)).toBe(false);
  });

  it("bounds inventory probing and can complete three real episodes after inventory arrives", () => {
    const policy = new PlaybackStarvation();
    expect(policy.claimAudioInventoryLoad()).toBe(true);
    expect(policy.claimAudioInventoryLoad()).toBe(false);
    policy.progress(10, true);
    for (let i = 1; i <= 3; i++) {
      policy.progress(10 + i, true);
      expect(policy.waiting(i, 0, true, false)).toBe(false);
    }
    expect(policy.claimAttempt(4, true)).toBe(true);
    expect(policy.claimAttempt(5, true)).toBe(false);
    policy.interrupt(); expect(policy.claimAudioInventoryLoad()).toBe(false);
  });

  it("does not mistake clock jitter after waiting for resumed playback", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true);
    for (let i = 1; i < 10; i++) {
      policy.progress(11 + i / 100, true);
      expect(policy.waiting(2 + i, 0, true)).toBe(false);
    }
    policy.progress(12, true); expect(policy.waiting(20, 0, true)).toBe(false);
    policy.progress(13, true); expect(policy.waiting(30, 0, true)).toBe(true);
  });

  it.each([0.001, 0.033, 0.05])("preserves episodes across native depleted-clock settling of %ss without treating settling as resumed progress", regression => {
    const policy = new PlaybackStarvation();
    policy.progress(70.272, true); policy.progress(71.775, true);
    expect(policy.waiting(1_000, 0.097, true)).toBe(false);
    policy.progress(71.775 - regression, true);
    expect(policy.waiting(2_000, 0.097, true)).toBe(false);
    policy.progress(77.903, true);
    expect(policy.waiting(14_000, 0.097, true)).toBe(false);
    policy.progress(77.903 - regression, true);
    expect(policy.waiting(15_000, 0.097, true)).toBe(false);
    policy.progress(83.919, true);
    expect(policy.waiting(26_000, 0.097, true)).toBe(true);
  });

  it.each([0.050001, 0.051, 0.25, 1])("retires earlier episodes for a genuine %ss backward clock", regression => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1_000, 0, true);
    policy.progress(12, true); policy.waiting(2_000, 0, true);
    policy.progress(12 - regression, true); policy.progress(13, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
    policy.progress(14, true); expect(policy.waiting(4_000, 0, true)).toBe(false);
    policy.progress(15, true); expect(policy.waiting(5_000, 0, true)).toBe(true);
  });

  it("keeps the high-water anchor so repeated small regressions cannot accumulate into an accepted rewind", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1_000, 0, true);
    policy.progress(12, true); policy.waiting(2_000, 0, true);
    policy.progress(11.97, true); policy.progress(11.94, true); policy.progress(13, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
  });

  it("invalidates progress and history on a backwards clock", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true);
    policy.progress(12, true); policy.waiting(2, 0, true);
    policy.progress(0, true); policy.progress(1, true);
    expect(policy.waiting(3, 0, true)).toBe(false);
    policy.progress(13, true);
    expect(policy.waiting(4, 0, true)).toBe(false);
  });
});

describe("lowerStarvationQuality", () => {
  it.each([
    [1080, ["auto", "720p", "480p", "360p"], "480p"],
    [1080, ["auto", "720p", "360p"], "720p"],
    [480, ["480p", "360p"], "360p"],
    [360, ["480p", "360p"], null],
    [0, ["480p", "360p"], null],
    [NaN, ["480p"], null],
    [720, ["auto", "1080p"], null],
    [1080, [], null],
  ] as const)("selects a strictly lower offered rung for %s", (height, offered, expected) => {
    expect(lowerStarvationQuality(height, offered)).toBe(expected);
  });
});
