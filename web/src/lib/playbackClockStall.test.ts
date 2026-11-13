import { describe, expect, it } from "vitest";
import { PlaybackClockStall } from "./playbackClockStall";

describe("PlaybackClockStall", () => {
  function played(frames: number | null = 273) {
    const clock = new PlaybackClockStall();
    clock.sample(0, 17, frames == null ? null : frames - 10, 1, true);
    clock.sample(500, 17.9716438, frames, 1, true);
    return clock;
  }
  it.each([273, null])("[clock107] earns a twelve-second hold only after actual clock progress (frames %s)", frames => {
    const clock = played(frames);
    for (let at = 1000; at < 12500; at += 500) expect(clock.sample(at, 17.9716438, frames, 1, true)).toBe(false);
    expect(clock.sample(12500, 17.9716438, frames, 1, true)).toBe(true);
  });
  it("[clock107] a counter or static first frame cannot prove prior playback", () => {
    const clock = new PlaybackClockStall();
    clock.sample(0, 17, 0, 1, true); clock.sample(500, 17, 10, 1, true);
    for (let at = 1000; at <= 30000; at += 500) expect(clock.sample(at, 17, 10, 1, true)).toBe(false);
  });
  it("[clock107] synchronous callback movement is not a fresh prior playback witness", () => {
    const clock = new PlaybackClockStall();
    clock.sample(0, 17, null, 1, true); clock.sample(1, 18, null, 1, true);
    for (let at = 500; at <= 30000; at += 500) expect(clock.sample(at, 18, null, 1, true)).toBe(false);
  });
  it("[clock107] advancing decoded frames or clock prevents a hold", () => {
    for (const advanceFrames of [false, true]) {
      const clock = played();
      for (let at = 1000; at <= 30000; at += 500) {
        expect(clock.sample(at, advanceFrames ? 17.9716438 : 18 + at / 1000,
          advanceFrames ? 273 + at : 273, 1, true)).toBe(false);
      }
    }
  });
  it("[clock107] observes both independent counters without preferring a stale browser total", () => {
    const clock = new PlaybackClockStall();
    clock.sample(0, 17, 1000, 1, true, 250);
    clock.sample(500, 17.9716438, 1001, 1, true, 273);
    for (let at = 1000; at <= 30000; at += 500) expect(clock.sample(at, 17.9716438, 1001, 1, true, 273 + at)).toBe(false);
  });

  it.each(["ineligible", "intent", "late", "backward", "missing-counter", "counter-reset"])("[clock107] %s retires continuity and earlier playback proof", reason => {
    const clock = played();
    for (let at = 1000; at <= 12000; at += 500) clock.sample(at, 17.9716438, 273, 1, true);
    const at = reason === "late" ? 15000 : reason === "backward" ? 11000 : 12500;
    const frames = reason === "missing-counter" ? null : reason === "counter-reset" ? 1 : 273;
    const intent = reason === "intent" ? 2 : 1;
    expect(clock.sample(at, 17.9716438, frames, intent, reason !== "ineligible")).toBe(false);
    for (let now = at + 500; now <= at + 15000; now += 500) expect(clock.sample(now, 17.9716438, frames, intent, true)).toBe(false);
  });
});
