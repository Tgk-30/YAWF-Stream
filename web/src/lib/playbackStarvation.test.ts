import { describe, expect, it } from "vitest";
import { PlaybackStarvation, lowerStarvationQuality } from "./playbackStarvation";

describe("PlaybackStarvation", () => {
  it.each([40_000, 150_000])("[native200-policy] adapts on the second progressed episode spaced %sms apart", spacing => {
    const policy = new PlaybackStarvation();
    policy.progress(50, true); policy.progress(53.296, true);
    expect(policy.waiting(128_334, 0.121, true)).toBe(false);
    policy.progress(53.328, true); policy.progress(89.601, true);
    expect(policy.waiting(128_334 + spacing, 0.124, true)).toBe(true);
    policy.progress(119.6, true);
    expect(policy.waiting(128_334 + spacing + 1_000, 0.123, true)).toBe(false);
  });

  it.each([300_000, 300_001])("[native200-policy] bounds postponed decisions at %sms", age => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(0, 0, true, false);
    policy.progress(12, true); policy.waiting(1, 0, true, false);
    expect(policy.claimAttempt(age, true)).toBe(age === 300_000);
    if (age > 300_000) {
      policy.progress(13, true); expect(policy.waiting(age, 0, true)).toBe(true);
    }
  });

  it("counts two progressed episodes, not repeated waiting or playing events", () => {
    const policy = new PlaybackStarvation();
    expect(policy.waiting(0, 0, true)).toBe(false);
    policy.progress(10, true); policy.progress(11, true);
    expect(policy.waiting(1_000, 0.5, true)).toBe(false);
    for (let i = 0; i < 10; i++) expect(policy.waiting(2_000, 0, true)).toBe(false);
    policy.progress(11, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
    policy.progress(12, true);
    expect(policy.waiting(4_000, 0, true)).toBe(true);
    policy.progress(13, true);
    expect(policy.waiting(5_000, 0, true)).toBe(false);
    policy.interrupt();
    for (let i = 0; i < 10; i++) {
      policy.progress(14 + i, true);
      expect(policy.waiting(6_000 + i, 0, true)).toBe(false);
    }
  });

  it("[progressive107] refuses same or higher second rungs even after first adoption", () => {
    for (const forbidden of ["480p", "720p", "1080p", "auto"] as const) {
      const policy = new PlaybackStarvation();
      policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true, false);
      policy.progress(12, true); policy.waiting(2, 0, true, false);
      expect(policy.claimAttempt(3, true, "480p")).toBe(true);
      policy.adoptFirstAttempt("480p");
      policy.progress(0, true); policy.progress(1, true); policy.waiting(4, 0, true, false);
      policy.progress(2, true); policy.waiting(5, 0, true, false);
      expect(policy.claimAttempt(6, true, forbidden)).toBe(false);
    }
  });

  it("[progressive107] never permits a third attempt even with a lower available rung", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true, false);
    policy.progress(12, true); policy.waiting(2, 0, true, false);
    expect(policy.claimAttempt(3, true, "720p")).toBe(true);
    policy.adoptFirstAttempt("720p");
    policy.progress(0, true); policy.progress(1, true); policy.waiting(4, 0, true, false);
    policy.progress(2, true); policy.waiting(5, 0, true, false);
    expect(policy.claimAttempt(6, true, "480p")).toBe(true);
    policy.adoptFirstAttempt("480p");
    policy.interrupt();
    for (let i = 0; i < 5; i++) { policy.progress(20 + i, true); policy.waiting(7 + i, 0, true, false); }
    expect(policy.claimAttempt(20, true, "360p")).toBe(false);
  });

  it("[progressive107] a wrong adopted quality cannot rearm an attempt", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true, false);
    policy.progress(12, true); policy.waiting(2, 0, true, false);
    expect(policy.claimAttempt(3, true, "480p")).toBe(true);
    policy.adoptFirstAttempt("720p");
    for (let i = 0; i < 5; i++) { policy.progress(20 + i, true); policy.waiting(4 + i, 0, true, false); }
    expect(policy.claimAttempt(10, true, "360p")).toBe(false);
  });

  it("ignores healthy buffer, invalid buffer, and episodes outside the rolling window", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true);
    expect(policy.waiting(0, 6, true)).toBe(false);
    expect(policy.waiting(1, NaN, true)).toBe(false);
    expect(policy.waiting(2, 0, true)).toBe(false);
    policy.progress(12, true);
    expect(policy.waiting(300_003, 0, true)).toBe(false);
    policy.progress(13, true);
    expect(policy.waiting(300_004, 0, true)).toBe(true);
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

  it.each([
    ["startup", "progress"], ["seek", "interrupt"], ["paused", "waiting"], ["hidden", "progress"],
    ["lease", "claimAttempt"], ["reset", "interrupt"], ["handoff", "claimAttempt"], ["recovery", "waiting"],
  ] as const)("interrupts %s through %s rather than inheriting progress or episodes", (_reason, entry) => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true);
    // Exercise only this invalidation entry, so another interrupt cannot hide a broken guard.
    if (entry === "progress") policy.progress(13, false);
    else if (entry === "interrupt") policy.interrupt();
    else if (entry === "waiting") expect(policy.waiting(3, 0, false)).toBe(false);
    else expect(policy.claimAttempt(3, false)).toBe(false);
    policy.progress(14, true); policy.progress(14.5, true);
    expect(policy.waiting(4, 0, true)).toBe(false);
    policy.progress(15, true);
    expect(policy.waiting(5, 0, true)).toBe(true);
  });

  it("bounds inventory probing and can complete two real episodes after inventory arrives", () => {
    const policy = new PlaybackStarvation();
    expect(policy.claimAudioInventoryLoad()).toBe(true);
    expect(policy.claimAudioInventoryLoad()).toBe(false);
    policy.progress(10, true);
    for (let i = 1; i <= 2; i++) {
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
    policy.progress(12, true); expect(policy.waiting(20, 0, true)).toBe(true);
    policy.progress(13, true); expect(policy.waiting(30, 0, true)).toBe(false);
  });

  it.each([0.001, 0.033, 0.05])("preserves episodes across native depleted-clock settling of %ss without treating settling as resumed progress", regression => {
    const policy = new PlaybackStarvation();
    policy.progress(70.272, true); policy.progress(71.775, true);
    expect(policy.waiting(1_000, 0.097, true)).toBe(false);
    policy.progress(71.775 - regression, true);
    expect(policy.waiting(2_000, 0.097, true)).toBe(false);
    policy.progress(77.903, true);
    expect(policy.waiting(14_000, 0.097, true)).toBe(true);
    policy.progress(77.903 - regression, true);
    expect(policy.waiting(15_000, 0.097, true)).toBe(false);
    policy.progress(83.919, true);
    expect(policy.waiting(26_000, 0.097, true)).toBe(false);
  });

  it.each([0.050001, 0.051, 0.25, 1])("retires earlier episodes for a genuine %ss backward clock", regression => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1_000, 0, true);
    policy.progress(12, true);
    policy.progress(12 - regression, true); policy.progress(13, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
    policy.progress(14, true); expect(policy.waiting(4_000, 0, true)).toBe(true);
    policy.progress(15, true); expect(policy.waiting(5_000, 0, true)).toBe(false);
  });

  it("keeps the high-water anchor so repeated small regressions cannot accumulate into an accepted rewind", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1_000, 0, true);
    policy.progress(12, true);
    policy.progress(11.97, true); policy.progress(11.94, true); policy.progress(13, true);
    expect(policy.waiting(3_000, 0, true)).toBe(false);
    policy.progress(14, true); expect(policy.waiting(4_000, 0, true)).toBe(true);
  });

  it("invalidates progress and history on a backwards clock", () => {
    const policy = new PlaybackStarvation();
    policy.progress(10, true); policy.progress(11, true); policy.waiting(1, 0, true);
    policy.progress(12, true);
    policy.progress(0, true); policy.progress(1, true);
    expect(policy.waiting(3, 0, true)).toBe(false);
    policy.progress(13, true);
    expect(policy.waiting(4, 0, true)).toBe(true);
  });

  it("[starvation96-policy] confirms two distinct unchanged-clock waits, never duplicates or another attempt", () => {
    const policy = new PlaybackStarvation();
    policy.progress(70, true);
    for (let i = 0; i < 2; i++) {
      const at = i * 12_000;
      policy.progress(71 + i * 6, true);
      expect(policy.waiting(at, 2.5, true)).toBe(false);
      const pending = policy.beginWaitingConfirmation(at, 71 + i * 6, 1, true)!;
      expect(pending).not.toBeNull();
      expect(policy.beginWaitingConfirmation(at + 1_000, pending.position, 1, true)).toBe(pending);
      expect(policy.confirmWaiting(pending, at + 1_999, pending.position, 1, true)).toBe(false);
      expect(policy.confirmWaiting(pending, at + 2_000, pending.position, 1, true)).toBe(i === 1);
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
    expect(policy.confirmWaiting(second, 5_000, 11.251, 1, true)).toBe(true);
    policy.progress(12, true);
    expect(policy.waiting(6_000, 0, true)).toBe(false);
  });

  it.each([
    ["reported", 0.001], ["reported", 0.033], ["reported", 0.05],
    ["quiet", 0.001], ["quiet", 0.033], ["quiet", 0.05],
  ] as const)("[starvation97-policy] %s backward settling of %ss preserves two original-clock confirmations", (sample, regression) => {
    const policy = new PlaybackStarvation(); policy.progress(70, true);
    for (let i = 0; i < 2; i++) {
      const position = 71 + i * 6, at = i * 12_000;
      policy.progress(position, true);
      const pending = policy.beginWaitingConfirmation(at, position, 1, true)!;
      expect(pending).not.toBeNull();
      if (sample === "reported") policy.progress(position - regression, true);
      expect(policy.waitingConfirmation).toBe(pending);
      expect(pending.position).toBe(position);
      expect(policy.confirmWaiting(pending, at + 1_999, position - regression, 1, true)).toBe(false);
      expect(policy.waitingConfirmation).toBe(pending);
      expect(policy.confirmWaiting(pending, at + 2_000, position - regression, 1, true)).toBe(i === 1);
      expect(policy.confirmWaiting(pending, at + 3_000, position - regression, 1, true)).toBe(false);
      expect(policy.beginWaitingConfirmation(at + 3_000, position - regression, 1, true)).toBeNull();
    }
    policy.interrupt(); policy.progress(90, true); policy.progress(91, true);
    expect(policy.beginWaitingConfirmation(40_000, 91, 1, true)).toBeNull();
  });

  it("[starvation97-policy] a wait beginning after settling retains the original progress high-water", () => {
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    policy.progress(10.967, true);
    const pending = policy.beginWaitingConfirmation(0, 10.967, 1, true)!;
    expect(pending.position).toBe(11);
    expect(policy.confirmWaiting(pending, 2_000, 10.934, 1, true)).toBe(false);
    expect(policy.waitingConfirmation).toBeNull();
  });

  it.each(["reported", "quiet"] as const)("[starvation97-policy] rejects %s out-of-window, cumulative, forward and nonfinite clocks", sample => {
    for (const delta of [-0.050001, -0.051, -1, 0.001, 0.3, NaN, Infinity, -Infinity]) {
      const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
      const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
      if (sample === "reported") policy.progress(11 + delta, true);
      expect(policy.confirmWaiting(pending, 2_000, 11 + delta, 1, true)).toBe(false);
      expect(policy.waitingConfirmation).toBeNull();
      expect(policy.confirmWaiting(pending, 3_000, 11, 1, true)).toBe(false);
    }
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    policy.progress(10.967, true);
    if (sample === "reported") policy.progress(10.934, true);
    expect(policy.confirmWaiting(pending, 2_000, 10.934, 1, true)).toBe(false);
    expect(policy.waitingConfirmation).toBeNull();
    expect(policy.confirmWaiting(pending, 3_000, 11, 1, true)).toBe(false);
  });

  it("[starvation96-policy] cancels forward movement or backward clocks beyond the existing 50ms bound", () => {
    // Only backward settling within the original high-water window is allowed.
    // Forward progress and larger rewinds must still retire the confirmation.
    for (const delta of [0.001, 0.3, -0.050001, -1, NaN]) {
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
    policy.progress(13, true);
    policy.progress(14, true);
    const third = policy.beginWaitingConfirmation(3_000, 14, 2, true)!;
    policy.interrupt();
    expect(policy.confirmWaiting(third, 5_000, 14, 2, true)).toBe(false);
    expect(policy.beginWaitingConfirmation(5_000, 14, 2, true)).toBeNull();
    policy.progress(15, true); policy.progress(16, true);
    expect(policy.waiting(6_000, 0, true)).toBe(false);
    policy.progress(17, true); expect(policy.waiting(7_000, 0, true)).toBe(true);
  });

  it("[starvation96-policy] rejects expired backwards nonfinite or ineligible confirmation clocks", () => {
    for (const now of [-1, 5_001, NaN, Infinity]) {
      const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
      const pending = policy.beginWaitingConfirmation(0, 11, 1, true)!;
      expect(policy.confirmWaiting(pending, now, 11, 1, true)).toBe(false);
      expect(policy.waitingConfirmation).toBeNull();
      policy.progress(12, true); expect(policy.waiting(6_000, 0, true)).toBe(false);
      policy.progress(13, true); expect(policy.waiting(7_000, 0, true)).toBe(true);
      policy.progress(14, true); expect(policy.waiting(8_000, 0, true)).toBe(false);
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
    for (let i = 0; i < 2; i++) {
      policy.progress(11 + i, true);
      const pending = policy.beginWaitingConfirmation(i * 4_000, 11 + i, 1, true)!;
      expect(policy.confirmWaiting(pending, i * 4_000 + 2_000, 11 + i, 1, true, false)).toBe(false);
    }
    expect(policy.claimAttempt(10_001, true)).toBe(true);
    expect(policy.claimAttempt(10_002, true)).toBe(false);
    expect(policy.claimAudioInventoryLoad()).toBe(false);
  });

  it("[starvation96-policy] applies the same five-minute window to confirmed and fast episodes", () => {
    const policy = new PlaybackStarvation(); policy.progress(10, true); policy.progress(11, true);
    const first = policy.beginWaitingConfirmation(0, 11, 1, true)!;
    expect(policy.confirmWaiting(first, 2_000, 11, 1, true)).toBe(false);
    policy.progress(12, true); expect(policy.waiting(302_001, 0, true)).toBe(false);
    policy.progress(13, true);
    const second = policy.beginWaitingConfirmation(303_000, 13, 1, true)!;
    expect(policy.confirmWaiting(second, 305_000, 13, 1, true)).toBe(true);
    policy.progress(14, true); expect(policy.waiting(306_000, 0, true)).toBe(false);
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

describe("shared sustained clock budget107", () => {
  function hold(policy: PlaybackStarvation, start: number) {
    policy.sampleClockStall(start, 0, 0, 1, true);
    policy.sampleClockStall(start + 500, 1, 15, 1, true);
    for (let at = start + 1000; at <= start + 12500; at += 500) policy.sampleClockStall(at, 1, 15, 1, true);
    return start + 12500;
  }
  it("[clock107-ladder] admits an offered first 360p rung from current 480p without hardcoding attempt order", () => {
    const policy = new PlaybackStarvation();
    const at = hold(policy, 0);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "360p")).toBe(true);
    policy.adoptFirstAttempt("360p");
    const next = hold(policy, 20000);
    expect(policy.claimClockStall(next, 1, 15, 1, true, "360p")).toBe(false);
    expect(policy.claimClockStall(next, 1, 15, 1, true, "480p")).toBe(false);
  });

  it("[clock107-budget] shares two attempts and only rearms after adopted first plus fresh progress", () => {
    const policy = new PlaybackStarvation();
    let at = hold(policy, 0);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "auto")).toBe(false);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "480p")).toBe(true);
    at = hold(policy, 20000);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "360p")).toBe(false);
    policy.adoptFirstAttempt("480p");
    expect(policy.claimClockStall(at, 1, 15, 1, true, "360p")).toBe(false);
    at = hold(policy, 40000);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "360p")).toBe(true);
    policy.adoptFirstAttempt("360p");
    at = hold(policy, 60000);
    expect(policy.claimClockStall(at, 1, 15, 1, true, "360p")).toBe(false);
    policy.progress(5, true); policy.progress(6, true); policy.waiting(at, 0, true, false);
    policy.progress(7, true); policy.waiting(at + 1, 0, true, false);
    expect(policy.claimAttempt(at + 1, true, "360p")).toBe(false);
  });
});
