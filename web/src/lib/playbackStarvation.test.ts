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

  it("[starvation96-policy] confirms three distinct unchanged-clock waits, never duplicates or another attempt", () => {
    const policy = new PlaybackStarvation();
    policy.progress(70, true);
    for (let i = 0; i < 3; i++) {
      const at = i * 12_000;
      policy.progress(71 + i * 6, true);
      expect(policy.waiting(at, 2.5, true)).toBe(false);
      const pending = policy.beginWaitingConfirmation(at, 71 + i * 6, 1, true)!;
      expect(pending).not.toBeNull();
      expect(policy.beginWaitingConfirmation(at + 1_000, pending.position, 1, true)).toBe(pending);
      expect(policy.confirmWaiting(pending, at + 1_999, pending.position, 1, true)).toBe(false);
      expect(policy.confirmWaiting(pending, at + 2_000, pending.position, 1, true)).toBe(i === 2);
      expect(policy.confirmWaiting(pending, at + 3_000, pending.position, 1, true)).toBe(false);
      expect(policy.beginWaitingConfirmation(at + 3_000, pending.position, 1, true)).toBeNull();
    }
    policy.interrupt(); policy.progress(90, true); policy.progress(91, true);
    expect(policy.beginWaitingConfirmation(40_000, 91, 1, true)).toBeNull();
  });

  it("[starvation96-policy] needs real resumed progress and shares each episode with the fast depletion path", () => {
    const policy = new PlaybackStarvation();
    expect(policy.beginWaitingConfirmation(0, 10, 1, true)).toBeNull();
    policy.progress(11, true);
    const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    expect(policy.waiting(100, 0.5, true)).toBe(false);
    expect(policy.confirmWaiting(pending, 2_000, 11, 1, true)).toBe(false);
    expect(policy.beginWaitingConfirmation(3_000, 11.25, 1, true)).toBeNull();
    const second = policy.beginWaitingConfirmation(3_000, 11.251, 1, true)!;
    expect(policy.confirmWaiting(second, 5_000, 11.251, 1, true)).toBe(false);
    policy.progress(12, true);
    expect(policy.waiting(6_000, 0, true)).toBe(true);
  });

  it("[starvation96-policy] cancels reported or quiet clock movement rather than confirming a stale sample", () => {
    for (const delta of [0.001, 0.3, -0.001, -1, NaN]) {
      const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
      const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
      expect(policy.confirmWaiting(pending, 2_000, 11 + delta, 1, true)).toBe(false);
      expect(policy.waitingConfirmation).toBeNull();
      expect(policy.confirmWaiting(pending, 3_000, 11, 1, true)).toBe(false);
    }
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    policy.progress(11.001, true);
    expect(policy.waitingConfirmation).toBeNull();
    expect(policy.confirmWaiting(pending, 2_000, 11, 1, true)).toBe(false);
  });

  it("[starvation96-policy] fences cancelled and interrupted tokens and newer explicit playback intent", () => {
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const first = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    policy.cancelWaitingConfirmation();
    const second = policy.beginWaitingConfirmation(100, 11, 1, true)!;
    expect(policy.confirmWaiting(first, 2_100, 11, 1, true)).toBe(false);
    expect(policy.waitingConfirmation).toBe(second);
    expect(policy.confirmWaiting(second, 2_100, 11, 2, true)).toBe(false);
    expect(policy.waitingConfirmation).toBeNull();
    expect(policy.beginWaitingConfirmation(2_200, 11, 2, true)).toBeNull();
    policy.progress(12, true); expect(policy.waiting(2_250, 0, true)).toBe(false);
    policy.progress(13, true); expect(policy.waiting(2_300, 0, true)).toBe(false);
    policy.progress(14, true);
    const third = policy.beginWaitingConfirmation(3_000, 14, 2, true)!;
    policy.interrupt();
    expect(policy.confirmWaiting(third, 5_000, 14, 2, true)).toBe(false);
    expect(policy.beginWaitingConfirmation(5_000, 14, 2, true)).toBeNull();
  });

  it("[starvation96-policy] rejects expired backwards nonfinite or ineligible confirmation clocks", () => {
    for (const now of [-1, 5_001, NaN, Infinity]) {
      const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
      const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
      expect(policy.confirmWaiting(pending, now, 11, 1, true)).toBe(false);
      expect(policy.waitingConfirmation).toBeNull();
      policy.progress(12, true); expect(policy.waiting(6_000, 0, true)).toBe(false);
      policy.progress(13, true); expect(policy.waiting(7_000, 0, true)).toBe(false);
      policy.progress(14, true); expect(policy.waiting(8_000, 0, true)).toBe(true);
    }
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    expect(policy.confirmWaiting(pending, 2_000, 11, 1, false)).toBe(false);
    expect(policy.beginWaitingConfirmation(2_000, 11, 1, true)).toBeNull();
    policy.progress(12, true);
    expect(policy.beginWaitingConfirmation(NaN, 12, 1, true)).toBeNull();
    expect(policy.beginWaitingConfirmation(3_000, 12, 1, true)).toBeNull();
  });

  it("[starvation96-policy] can finish confirmed episodes after bounded audio discovery without another wait", () => {
    const policy = new PlaybackStarvation(); expect(policy.claimAudioInventoryLoad()).toBe(true);
    policy.progress(10, true);
    for (let i = 0; i < 3; i++) {
      policy.progress(11 + i, true);
      const pending = policy.beginWaitingConfirmation(i * 4_000, 11 + i, 1, true)!;
      expect(policy.confirmWaiting(pending, i * 4_000 + 2_000, 11 + i, 1, true, false)).toBe(false);
    }
    expect(policy.claimAttempt(10_001, true)).toBe(true);
    expect(policy.claimAttempt(10_002, true)).toBe(false);
    expect(policy.claimAudioInventoryLoad()).toBe(false);
  });

  it("[starvation96-policy] applies the same45-second window to confirmed and fast episodes", () => {
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const first = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    expect(policy.confirmWaiting(first, 2_000, 11, 1, true)).toBe(false);
    policy.progress(12, true); expect(policy.waiting(48_000, 0, true)).toBe(false);
    policy.progress(13, true);
    const second = policy.beginWaitingConfirmation(49_000, 13, 1, true)!;
    expect(policy.confirmWaiting(second, 51_000, 13, 1, true)).toBe(false);
    policy.progress(14, true); expect(policy.waiting(52_000, 0, true)).toBe(true);
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
