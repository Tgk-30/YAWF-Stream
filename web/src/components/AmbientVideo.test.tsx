// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { AmbientVideo } from "./AmbientVideo";

describe("AmbientVideo", () => {
  let visibilityListeners: Record<string, EventListener[]> = {};
  let observerCallback:
    | ((entries: { intersectionRatio: number }[]) => void)
    | null = null;

  beforeEach(() => {
    visibilityListeners = {};
    observerCallback = null;
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        (visibilityListeners[type] ??= []).push(
          typeof listener === "function" ? listener : listener.handleEvent,
        );
        return document;
      },
    );
    vi.spyOn(document, "removeEventListener").mockImplementation(
      () => document,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete document.documentElement.dataset.motion;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  function dispatchVisibilityChange() {
    for (const listener of visibilityListeners.visibilitychange ?? []) {
      listener.call(document, new Event("visibilitychange"));
    }
  }

  function installIntersectionObserver() {
    class MockIntersectionObserver {
      public observe = vi.fn();
      public disconnect = vi.fn();
      public unobserve = vi.fn();
      public constructor(callback: (entries: { intersectionRatio: number }[]) => void) {
        observerCallback = callback;
      }
      public takeRecords() {
        return [];
      }
      public root = null;
      public rootMargin = "";
      public thresholds: number[] = [];
    }
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    return MockIntersectionObserver;
  }

  it("renders a decorative, muted, looping autoplay video for the named loop", () => {
    const { container } = render(<AmbientVideo name="aurora" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.getAttribute("src")).toBe("/videos/aurora.mp4");
    expect(video).toHaveClass("ambient-video");
    expect(video).toHaveAttribute("aria-hidden", "true");
    expect(video).toHaveAttribute("tabindex", "-1");
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video).toHaveAttribute("preload", "metadata");
  });

  it("applies the default opacity and a custom class", () => {
    const { container } = render(
      <AmbientVideo name="cinema" className="extra" />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).toHaveClass("ambient-video", "extra");
    expect(video.style.opacity).toBe("0.35");
    expect(video.getAttribute("src")).toBe("/videos/cinema.mp4");
  });

  it("honours an explicit opacity override", () => {
    const { container } = render(<AmbientVideo name="secure" opacity={0.8} />);
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.style.opacity).toBe("0.8");
  });

  it("pauses and resumes playback when document visibility changes", () => {
    installIntersectionObserver();
    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });

    const { container } = render(<AmbientVideo name="secure" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined as unknown as void);
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);

    hidden = true;
    dispatchVisibilityChange();
    expect(pause).toHaveBeenCalledTimes(1);

    hidden = false;
    dispatchVisibilityChange();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("pauses playback when observer reports hidden and resumes when visible", () => {
    installIntersectionObserver();
    const { container } = render(<AmbientVideo name="aurora" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined as unknown as void);
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);

    observerCallback?.([{ intersectionRatio: 0 }]);
    expect(pause).toHaveBeenCalledTimes(1);
    observerCallback?.([{ intersectionRatio: 1 }]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not mount decorative video when reduced motion is enabled", () => {
    document.documentElement.dataset.motion = "reduced";
    const { container } = render(<AmbientVideo name="aurora" />);
    expect(container.querySelector("video")).toBeNull();
  });
});
