// @vitest-environment jsdom
//
// Unit tests for reduced-motion preference resolution. This covers both explicit
// in-app mode values and OS-level fallback behavior when mode is system/unknown.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./reducedMotion";

describe("prefersReducedMotion", () => {
  let originalMotion: string | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;
  let originalWindow: (Window & typeof globalThis) | undefined;
  let originalDocument: Document | undefined;

  beforeEach(() => {
    originalMotion = document.documentElement.dataset.motion;
    originalMatchMedia = window.matchMedia;
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    if (window.matchMedia == null) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: vi.fn(() => ({ matches: false }) as MediaQueryList),
      });
    }
  });

  afterEach(() => {
    globalThis.window = originalWindow as Window & typeof globalThis;
    globalThis.document = originalDocument as Document;
    if (originalMotion == null) {
      document.documentElement.removeAttribute("data-motion");
    } else {
      document.documentElement.dataset.motion = originalMotion;
    }

    if (originalMatchMedia == null) {
      delete (window as unknown as { matchMedia?: typeof window.matchMedia })
        .matchMedia;
    } else {
      window.matchMedia = originalMatchMedia;
    }

    vi.restoreAllMocks();
  });

  it("returns true when the app requests reduced motion", () => {
    document.documentElement.dataset.motion = "reduced";
    expect(prefersReducedMotion()).toBe(true);
  });

  it("returns false when the app requests normal motion", () => {
    document.documentElement.dataset.motion = "normal";
    expect(prefersReducedMotion()).toBe(false);
  });

  it("falls back to prefers-reduced-motion when app mode is system/unknown", () => {
    document.documentElement.dataset.motion = "system";
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("returns false when prefers-reduced-motion is absent or false", () => {
    document.documentElement.removeAttribute("data-motion");
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns false when matchMedia is unavailable", () => {
    document.documentElement.removeAttribute("data-motion");
    delete (window as unknown as { matchMedia?: typeof window.matchMedia }).matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns false when window is not available", () => {
    originalWindow = globalThis.window;
    // @ts-expect-error
    globalThis.window = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns false when document is not available", () => {
    originalDocument = globalThis.document;
    // @ts-expect-error
    globalThis.document = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});
