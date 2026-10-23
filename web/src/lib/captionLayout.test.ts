import { describe, expect, it } from "vitest";
import { captionLayout, type CaptionLayoutInput } from "./captionLayout";

const input = (overrides: Partial<CaptionLayoutInput> = {}): CaptionLayoutInput => ({
  video: { left: 0, top: 0, width: 400, height: 800 },
  viewport: { left: 0, top: 0, width: 400, height: 800 },
  mediaWidth: 1920, mediaHeight: 1080, fit: "contain",
  controls: { left: 0, top: 650, width: 400, height: 150 },
  position: 90, fontScale: 1, zoom: 1, text: "Hello", ...overrides,
});

describe("captionLayout", () => {
  it("maps contain preference into the letterboxed picture", () => {
    const result = captionLayout(input())!;
    expect(result.line).toBeCloseTo(61.25);
    expect(result).toMatchObject({ lineAlign: "end", position: 50, size: 96, fontSize: 16 });
  });
  it.each(["cover", "fill"] as const)("uses the cropped element for %s and avoids actual controls", fit => {
    expect(captionLayout(input({ fit }))!.line).toBe(80.25);
    expect(captionLayout(input({ fit, controls: null }))!.line).toBe(90);
  });
  it("uses the horizontal visible intersection after zoom and pan", () => {
    const result = captionLayout(input({
      video: { left: 0, top: -400, width: 800, height: 1600 }, zoom: 2,
    }))!;
    expect(result.position).toBe(25);
    expect(result.size).toBe(48);
    expect(result.fontSize).toBeCloseTo(12.375);
    expect(result.line).toBeCloseTo(61.25);
  });
  it("uses the visual viewport and top-anchor preference", () => {
    const result = captionLayout(input({
      viewport: { left: 20, top: 300, width: 360, height: 150 }, position: 10,
    }))!;
    expect(result.lineAlign).toBe("start");
    expect(result.line).toBe(39.375);
    expect(result.size).toBe(86);
  });
  it("reserves explicit multiline height and wrapping at large appearance scale", () => {
    const result = captionLayout(input({ fontScale: 1.8, text: "One\nTwo\nThree\nFour\nFive\nSix" }))!;
    expect(result.line).toBeCloseTo(63.0625);
    expect(captionLayout(input({ fontScale: 1.8, text: "Long ".repeat(100) }))!.line).toBe(result.line);
  });
  it("ignores nonoverlapping control panels rather than reserving a fixed screen percentage", () => {
    const result = captionLayout(input({ controls: { left: 450, top: 300, width: 100, height: 300 } }));
    expect(result).not.toBeNull();
    expect(result!.line).toBeCloseTo(61.25);
  });
  it("declines unknown, empty, offscreen or fully obscured geometry", () => {
    for (const overrides of [
      { mediaWidth: 0 }, { mediaHeight: NaN },
      { video: { left: 0, top: 0, width: 0, height: 800 } },
      { viewport: { left: 600, top: 0, width: 400, height: 800 } },
      { controls: { left: 0, top: 200, width: 400, height: 600 } },
      { video: { left: Infinity, top: 0, width: 400, height: 800 } },
    ]) expect(captionLayout(input(overrides))).toBeNull();
  });
  it("normalizes invalid appearance, preference and zoom without nonfinite cue values", () => {
    expect(captionLayout(input({ fontScale: NaN, zoom: 0, position: Infinity }))).toEqual(captionLayout(input()));
    expect(captionLayout(input({ position: -20 }))!.lineAlign).toBe("start");
    expect(captionLayout(input({ position: 200 }))!.line).toBeLessThan(64);
  });
});
