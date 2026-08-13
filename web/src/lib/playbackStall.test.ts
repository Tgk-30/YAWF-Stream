import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRESH_STREAM_RESOLUTION_TIMEOUT_MS,
  PlaybackStallWatchdog,
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
