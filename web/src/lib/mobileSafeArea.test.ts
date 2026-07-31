// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./tauri", () => ({
  isTauri: () => true,
}));

const deviceKind = vi.fn(() => "android");
vi.mock("./platform", () => ({
  deviceKind: () => deviceKind(),
}));

import {
  applyPhysicalSafeAreaInsets,
  installMobileSafeAreaInsets,
} from "./mobileSafeArea";

function mockAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      callbacks.delete(id);
    });

  return {
    request,
    cancel,
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    },
  };
}

async function flushPromises(): Promise<void> {
  await vi.dynamicImportSettled();
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  invoke.mockReset();
  deviceKind.mockReturnValue("android");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Android safe-area bridge", () => {
  it("converts native physical pixels into WebView CSS pixels", () => {
    applyPhysicalSafeAreaInsets(
      { top: 90, right: 0, bottom: 60, left: 3 },
      3,
    );

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--native-safe-area-top")).toBe("30px");
    expect(style.getPropertyValue("--native-safe-area-right")).toBe("0px");
    expect(style.getPropertyValue("--native-safe-area-bottom")).toBe("20px");
    expect(style.getPropertyValue("--native-safe-area-left")).toBe("1px");
  });

  it("requests native insets on Android and applies them", async () => {
    invoke.mockResolvedValue({ top: 48, right: 0, bottom: 24, left: 0 });
    const frames = mockAnimationFrames();

    const uninstall = installMobileSafeAreaInsets();
    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("mobile_safe_area_insets");
    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-top"),
    ).toBe("48px");
    uninstall();
  });

  it("does not invoke the Android command on desktop", () => {
    const frames = mockAnimationFrames();
    deviceKind.mockReturnValue("mac");
    const uninstall = installMobileSafeAreaInsets();
    expect(frames.request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    uninstall();
  });

  it("refreshes native insets after rotation", async () => {
    invoke.mockResolvedValue({ top: 48, right: 0, bottom: 24, left: 0 });
    const frames = mockAnimationFrames();
    const uninstall = installMobileSafeAreaInsets();

    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("orientationchange"));
    expect(frames.request).toHaveBeenCalledTimes(2);
    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it("retries after 250 ms and 1000 ms", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ top: 48, right: 0, bottom: 24, left: 0 });
    const frames = mockAnimationFrames();
    const uninstall = installMobileSafeAreaInsets();

    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);
    expect(frames.request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(frames.request).toHaveBeenCalledTimes(2);
    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(749);
    expect(frames.request).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(frames.request).toHaveBeenCalledTimes(3);
    frames.flush();
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(3);
    uninstall();
  });

  it("cancels pending work and removes refresh listeners on teardown", () => {
    vi.useFakeTimers();
    const visualViewport = new EventTarget();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    const frames = mockAnimationFrames();

    const uninstall = installMobileSafeAreaInsets();
    uninstall();

    expect(frames.cancel).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
    visualViewport.dispatchEvent(new Event("resize"));
    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("warns when native insets cannot be refreshed", async () => {
    invoke.mockRejectedValue(new Error("bridge unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frames = mockAnimationFrames();
    const uninstall = installMobileSafeAreaInsets();

    frames.flush();
    await flushPromises();
    expect(warning).toHaveBeenCalledWith(
      "[YAWF Stream] Could not refresh native safe-area insets.",
    );
    uninstall();
  });
});
