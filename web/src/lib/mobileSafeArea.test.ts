// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const isTauri = vi.fn(() => true);
vi.mock("./tauri", () => ({
  isTauri: () => isTauri(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  invoke.mockReset();
  isTauri.mockReturnValue(true);
  deviceKind.mockReturnValue("android");
  delete (
    globalThis as typeof globalThis & { __YAWF_TAURI_ANDROID__?: unknown }
  ).__YAWF_TAURI_ANDROID__;
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

  it("uses the authoritative Android marker with a desktop user agent", async () => {
    deviceKind.mockReturnValue("linux");
    (
      globalThis as typeof globalThis & { __YAWF_TAURI_ANDROID__?: unknown }
    ).__YAWF_TAURI_ANDROID__ = true;
    invoke.mockResolvedValue({ top: 54, right: 3, bottom: 27, left: 0 });
    const frames = mockAnimationFrames();

    const uninstall = installMobileSafeAreaInsets();
    frames.flush();
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("mobile_safe_area_insets");
    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-top"),
    ).toBe("54px");
    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-right"),
    ).toBe("3px");
    uninstall();
  });

  it("does not invoke the Android command outside a native Android webview", () => {
    const frames = mockAnimationFrames();
    deviceKind.mockReturnValue("mac");
    const uninstallDesktop = installMobileSafeAreaInsets();
    deviceKind.mockReturnValue("ios");
    const uninstallIos = installMobileSafeAreaInsets();
    deviceKind.mockReturnValue("android");
    isTauri.mockReturnValue(false);
    const uninstallBrowser = installMobileSafeAreaInsets();

    expect(frames.request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    uninstallDesktop();
    uninstallIos();
    uninstallBrowser();
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

  it("serializes rotation refreshes and ignores the stale in-flight response", async () => {
    const first = deferred<{ top: number; right: number; bottom: number; left: number }>();
    const second = deferred<{ top: number; right: number; bottom: number; left: number }>();
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const frames = mockAnimationFrames();
    const uninstall = installMobileSafeAreaInsets();

    frames.flush();
    await vi.dynamicImportSettled();
    expect(invoke).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("orientationchange"));
    window.dispatchEvent(new Event("resize"));
    expect(invoke).toHaveBeenCalledTimes(1);

    first.resolve({ top: 96, right: 0, bottom: 48, left: 0 });
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-top"),
    ).toBe("");

    second.resolve({ top: 42, right: 0, bottom: 21, left: 0 });
    await flushPromises();
    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-top"),
    ).toBe("42px");
    uninstall();
  });

  it("does not apply or warn from a native response that settles after teardown", async () => {
    const pending = deferred<{ top: number; right: number; bottom: number; left: number }>();
    invoke.mockReturnValue(pending.promise);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frames = mockAnimationFrames();
    const uninstall = installMobileSafeAreaInsets();

    frames.flush();
    await vi.dynamicImportSettled();
    uninstall();
    pending.resolve({ top: 99, right: 0, bottom: 0, left: 0 });
    await flushPromises();

    expect(
      document.documentElement.style.getPropertyValue("--native-safe-area-top"),
    ).toBe("");
    expect(warning).not.toHaveBeenCalled();
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
