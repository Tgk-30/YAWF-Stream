import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRESH_STREAM_RESOLUTION_TIMEOUT_MS,
  PlaybackStallWatchdog,
  PlaybackRecoveryProgress,
  playbackExpectedToAdvance,
  playbackRecoverySessionIdentity,
  withFreshStreamResolutionTimeout,
} from "./playbackStall";

const advancing = {
  started: true,
  paused: false,
  seeking: false,
  suspended: false,
  ended: false,
  tearingDown: false,
};

afterEach(() => vi.useRealTimers());

describe("PlaybackStallWatchdog", () => {
  it("keeps renewal in one session but separates titles and season-pack episodes", () => {
    const first = playbackRecoverySessionIdentity("show", "s01e01", "hash", "old-url");
    expect(
      playbackRecoverySessionIdentity("show", "s01e01", "hash", "fresh-url"),
    ).toBe(first);
    expect(
      playbackRecoverySessionIdentity("show", "s01e02", "hash", "fresh-url"),
    ).not.toBe(first);
    expect(
      playbackRecoverySessionIdentity("other", "s01e01", "hash", "fresh-url"),
    ).not.toBe(first);
  });

  it("fires only after a full no-progress window", () => {
    vi.useFakeTimers();
    const stalled = vi.fn();
    const watchdog = new PlaybackStallWatchdog(stalled, 1_000);
    watchdog.update(advancing);
    vi.advanceTimersByTime(700);
    watchdog.noteProgress();
    vi.advanceTimersByTime(700);
    expect(stalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it("does not run while playback is intentionally unable to advance", () => {
    vi.useFakeTimers();
    const stalled = vi.fn();
    const watchdog = new PlaybackStallWatchdog(stalled, 1_000);
    for (const state of [
      { ...advancing, paused: true },
      { ...advancing, seeking: true },
      { ...advancing, suspended: true },
      { ...advancing, ended: true },
      { ...advancing, tearingDown: true },
      { ...advancing, started: false },
    ]) {
      expect(playbackExpectedToAdvance(state)).toBe(false);
      watchdog.update(state);
      vi.advanceTimersByTime(2_000);
    }
    expect(stalled).not.toHaveBeenCalled();
  });

  it("re-arms after a pause and cleans up permanently on stop", () => {
    vi.useFakeTimers();
    const stalled = vi.fn();
    const watchdog = new PlaybackStallWatchdog(stalled, 1_000);
    watchdog.update(advancing);
    vi.advanceTimersByTime(500);
    watchdog.update({ ...advancing, paused: true });
    vi.advanceTimersByTime(2_000);
    watchdog.update(advancing);
    vi.advanceTimersByTime(500);
    watchdog.stop();
    vi.advanceTimersByTime(2_000);
    expect(stalled).not.toHaveBeenCalled();
  });
});

describe("withFreshStreamResolutionTimeout", () => {
  it("rejects a provider request that never settles", async () => {
    vi.useFakeTimers();
    const pending = withFreshStreamResolutionTimeout(new Promise(() => {}));
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(FRESH_STREAM_RESOLUTION_TIMEOUT_MS);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("PlaybackRecoveryProgress", () => {
  it("requires a full60s and cannot earn from metadata or a stationary clock", () => {
    const progress = new PlaybackRecoveryProgress();
    expect(progress.note(0, 0, 1, true)).toBe(false);
    for (let second = 1; second < 60; second += 1) expect(progress.note(second * 1000, second, 1, true)).toBe(false);
    expect(progress.note(60000, 60, 1, true)).toBe(true);
    progress.reset();
    for (let second = 0; second <= 60; second += 1) expect(progress.note(second * 1000, 0, 1, true)).toBe(false);
  });
  it.each([0.5, 1.25, 2])("normalizes rate=%s without earning faster than actual elapsed time", (rate) => {
    const progress = new PlaybackRecoveryProgress(); progress.note(0, 0, rate, true);
    for (let second = 1; second < 60; second += 1) expect(progress.note(second * 1000, second * rate, rate, true)).toBe(false);
    expect(progress.note(60000, 60 * rate, rate, true)).toBe(true);
  });
  it.each(["excluded", "forward-jump", "backward", "gap", "backward-wall", "rate-change"] as const)("%s resets the entire contiguous window", (interruption) => {
    const progress = new PlaybackRecoveryProgress(); progress.note(0, 0, 1, true);
    for (let second = 1; second <= 59; second += 1) progress.note(second * 1000, second, 1, true);
    const now = interruption === "gap" ? 65000 : interruption === "backward-wall" ? 58000 : 60000;
    const position = interruption === "forward-jump" ? 5000 : interruption === "backward" ? 0 : 60;
    expect(progress.note(now, position, interruption === "rate-change" ? 2 : 1, interruption !== "excluded")).toBe(false);
    const rate = interruption === "rate-change" ? 2 : 1;
    // An excluded sample clears its baseline; a discontinuity establishes the new one.
    const baseline = interruption === "excluded" ? 1000 : 0;
    if (baseline > 0) expect(progress.note(now + baseline, position + rate, rate, true)).toBe(false);
    for (let second = 1; second < 60; second += 1) {
      expect(progress.note(now + baseline + second * 1000, position + (baseline / 1000 + second) * rate, rate, true)).toBe(false);
    }
    expect(progress.note(now + baseline + 60000, position + (baseline / 1000 + 60) * rate, rate, true)).toBe(true);
  });
  it("caps plausible clock deltas to wall elapsed rather than counting extra media seconds", () => {
    const progress = new PlaybackRecoveryProgress(); progress.note(0, 0, 1, true);
    for (let step = 1; step < 120; step += 1) expect(progress.note(step * 500, step * 0.75, 1, true)).toBe(false);
    expect(progress.note(60000, 90, 1, true)).toBe(true);
  });
  it.each([[NaN, 1, 1], [1, Infinity, 1], [1, -1, 1], [1, 1, 0], [1, 1, NaN]])("invalid sample%s/%s/%s cannot earn progress", (now, position, rate) => {
    const progress = new PlaybackRecoveryProgress(); expect(progress.note(now, position, rate, true)).toBe(false);
  });
});
