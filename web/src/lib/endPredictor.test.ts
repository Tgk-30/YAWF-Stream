import { describe, expect, it } from "vitest";
import { adaptiveEndWindow, predictEpisodeEnd } from "./endPredictor";

describe("end predictor", () => {
  it.each([null, NaN, Infinity, 0, 59])("rejects invalid or short duration %s", (duration) => {
    expect(predictEpisodeEnd({ position: 1, duration, playing: true, eligible: true }).show).toBe(false);
  });

  it("rejects ineligible, paused, and dismissed input", () => {
    for (const input of [
      { eligible: false }, { playing: false }, { dismissed: true },
    ]) {
      expect(predictEpisodeEnd({ position: 90, duration: 100, playing: true, eligible: true, ...input }).show).toBe(false);
    }
  });

  it("uses exact adaptive clamps", () => {
    expect(adaptiveEndWindow(60)).toBe(10);
    expect(adaptiveEndWindow(1_200)).toBe(10);
    expect(adaptiveEndWindow(1_260)).toBe(11);
    expect(adaptiveEndWindow(3_600)).toBe(30);
  });

  it("trusts only a late, clearly-labelled marker with 15 to 300 seconds after the marker", () => {
    const base = { duration: 1_200, playing: true, eligible: true };
    expect(predictEpisodeEnd({ ...base, position: 900, chapters: [{ title: "End Credits", time: 900 }] }))
      .toMatchObject({ show: true, earlyAutoAdvance: true, reason: "credits" });
    for (const chapter of [
      { title: "Credits", time: 700 }, // too early
      { title: "Credits", time: 1_190 }, // fewer than 15 marker seconds remain
      { title: "Chapter 12", time: 900 },
      { title: "Credits", time: Number.NaN },
    ]) {
      expect(predictEpisodeEnd({ ...base, position: 900, chapters: [chapter] }).earlyAutoAdvance).toBe(false);
    }
  });

  it("shows generic prompt without early automatic transition", () => {
    expect(predictEpisodeEnd({ position: 1_190, duration: 1_200, playing: true, eligible: true }))
      .toMatchObject({ show: true, earlyAutoAdvance: false, reason: "duration" });
  });
});
