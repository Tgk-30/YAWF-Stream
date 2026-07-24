import { describe, expect, it } from "vitest";
import { isPhoneRemoteRoute, isTVMode, nextSpatialCandidate } from "./tvMode";

function candidate(left: number, top: number, width = 40, height = 40) {
  return {
    getBoundingClientRect: () =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  };
}

describe("TV mode", () => {
  it("recognizes the dedicated routes without matching unrelated paths", () => {
    expect(
      isTVMode({ pathname: "/tv", search: "" } as Location),
    ).toBe(true);
    expect(
      isTVMode({ pathname: "/", search: "?tv=1" } as Location),
    ).toBe(true);
    expect(
      isTVMode({ pathname: "/television", search: "" } as Location),
    ).toBe(false);
    expect(
      isPhoneRemoteRoute({ pathname: "/remote/" } as Location),
    ).toBe(true);
    expect(
      isPhoneRemoteRoute({ pathname: "/remote-access" } as Location),
    ).toBe(false);
  });

  it("prefers the closest aligned control for D-pad movement", () => {
    const current = candidate(0, 0);
    const right = candidate(100, 0);
    const diagonal = candidate(60, 120);
    const left = candidate(-100, 0);
    expect(
      nextSpatialCandidate(current, [current, diagonal, right, left], "right"),
    ).toBe(right);
    expect(
      nextSpatialCandidate(current, [current, diagonal, right, left], "left"),
    ).toBe(left);
  });
});
