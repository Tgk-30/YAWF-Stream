// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVideoPresentation } from "./useVideoPresentation";

describe("session-local video presentation ownership", () => {
  it("retains all presentation values while the content/file owner stays the same", () => {
    const { result, rerender } = renderHook(({ owner }) => useVideoPresentation(owner), { initialProps: { owner: "file-A" } });
    act(() => result.current[1]({ fit: "cover", zoom: 1.35, panX: 12, panY: -8 }));
    rerender({ owner: "file-A" });
    expect(result.current[0]).toEqual({ fit: "cover", zoom: 1.35, panX: 12, panY: -8 });
  });

  it("resets a genuine owner change and ignores its predecessor callback", () => {
    const { result, rerender } = renderHook(({ owner }) => useVideoPresentation(owner), { initialProps: { owner: "file-A" } });
    const stale = result.current[1];
    act(() => stale({ zoom: 1.5 }));
    rerender({ owner: "file-B" });
    expect(result.current[0]).toEqual({ fit: "contain", zoom: 1, panX: 0, panY: 0 });
    act(() => result.current[1]({ panY: 5 }));
    act(() => stale({ fit: "fill", zoom: 2, panX: 40, panY: 40 }));
    expect(result.current[0]).toEqual({ fit: "contain", zoom: 1, panX: 0, panY: 5 });
  });

  it("rejects stale callbacks even when an earlier owner identity returns", () => {
    const { result, rerender } = renderHook(({ owner }) => useVideoPresentation(owner), { initialProps: { owner: "file-A" } });
    const oldA = result.current[1];
    act(() => oldA({ zoom: 1.5 }));
    rerender({ owner: "file-B" });
    act(() => result.current[1]({ zoom: 2 }));
    rerender({ owner: "file-A" });
    expect(result.current[0].zoom).toBe(1);
    act(() => result.current[1]({ zoom: 1.25 }));
    act(() => oldA({ zoom: 2.5 }));
    expect(result.current[0]).toEqual({ fit: "contain", zoom: 1.25, panX: 0, panY: 0 });
  });
});
