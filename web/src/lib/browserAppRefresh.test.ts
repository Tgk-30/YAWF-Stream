import { afterEach, describe, expect, it, vi } from "vitest";
import { setNetworkMode } from "./networkPolicy";
import {
  prepareBrowserAppRefresh,
  reloadBrowserAppPage,
} from "./browserAppRefresh";

afterEach(() => {
  vi.useRealTimers();
  setNetworkMode("standard");
});

describe("browser app refresh", () => {
  it("updates an existing service worker before allowing an explicit reload", async () => {
    const update = vi.fn(async () => undefined);
    const getRegistration = vi.fn(async () => ({ update }));
    const reload = vi.fn();

    await prepareBrowserAppRefresh({ getRegistration } as never);
    expect(getRegistration).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    reloadBrowserAppPage(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit same-page reload when no service worker is registered", async () => {
    const getRegistration = vi.fn(async () => undefined);
    const reload = vi.fn();

    await prepareBrowserAppRefresh({ getRegistration } as never);
    expect(getRegistration).toHaveBeenCalledTimes(1);
    reloadBrowserAppPage(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fails before touching a service worker when update traffic is blocked", async () => {
    setNetworkMode("offline");
    const getRegistration = vi.fn();

    await expect(
      prepareBrowserAppRefresh({ getRegistration } as never),
    ).rejects.toThrow(/Blocked updates request in offline mode/);
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("rechecks privacy after worker lookup and before requesting an update", async () => {
    let resolveRegistration!: (value: { update: () => Promise<void> }) => void;
    const update = vi.fn(async () => undefined);
    const getRegistration = vi.fn(
      () => new Promise<{ update: () => Promise<void> }>((resolve) => {
        resolveRegistration = resolve;
      }),
    );
    const pending = prepareBrowserAppRefresh({ getRegistration } as never);

    setNetworkMode("fullLocal");
    resolveRegistration({ update });

    await expect(pending).rejects.toThrow(/Blocked updates request in fullLocal mode/);
    expect(update).not.toHaveBeenCalled();
  });

  it("times out a service worker lookup that never settles", async () => {
    vi.useFakeTimers();
    const pending = prepareBrowserAppRefresh(
      { getRegistration: () => new Promise(() => {}) } as never,
      50,
    );
    const rejected = expect(pending).rejects.toThrow(
      /did not finish finding its service worker/,
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });

  it("times out a service worker update that never settles", async () => {
    vi.useFakeTimers();
    const pending = prepareBrowserAppRefresh({
      getRegistration: async () => ({ update: () => new Promise(() => {}) }),
    } as never, 50);
    const rejected = expect(pending).rejects.toThrow(
      /did not finish checking app files/,
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });
});
