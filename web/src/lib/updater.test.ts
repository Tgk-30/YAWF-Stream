// Tests for the auto-updater bridge (src/lib/updater.ts).
//
// `checkForUpdates()` must be a safe no-op outside the desktop Tauri shell (no
// import of the updater runtime, never throws, resolves to null). The vitest
// env is "node" (no window) so isTauri() is false by default - the browser/SSR
// case. We flip into the Tauri path by stubbing a window with the
// __TAURI_INTERNALS__ flag and mocking the dynamically-imported plugin modules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dynamically-imported Tauri plugin runtimes that checkForUpdates()
// pulls in via `await import(...)`.
const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

const relaunchMock = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

import { checkForUpdates } from "./updater";
import { setNetworkMode } from "./networkPolicy";

/** Put a fake Tauri window in place so isTauri() returns true. */
function enterTauri(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 });
}

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setNetworkMode("standard");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setNetworkMode("standard");
});

describe("checkForUpdates (no Tauri runtime)", () => {
  it("resolves to null when not running under Tauri", async () => {
    // No `window` (node env) → isTauri() is false → no-op.
    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("does not throw even if a window without the Tauri flag exists", async () => {
    // A bare window (a plain browser) still lacks __TAURI_INTERNALS__.
    vi.stubGlobal("window", {});
    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe("checkForUpdates (under Tauri)", () => {
  it("does not invoke the updater plugin when updates are blocked", async () => {
    enterTauri();
    setNetworkMode("offline");

    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("returns null when the updater reports no update available", async () => {
    enterTauri();
    checkMock.mockResolvedValue(null);
    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("returns null and never throws when the check itself rejects", async () => {
    enterTauri();
    checkMock.mockRejectedValue(new Error("network down"));
    await expect(checkForUpdates()).resolves.toBeNull();
  });

  it("maps an available update to a PendingUpdate (notes from body)", async () => {
    enterTauri();
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: "Fixes and stuff",
      downloadAndInstall: vi.fn(),
    });
    const pending = await checkForUpdates();
    expect(pending).not.toBeNull();
    expect(pending?.version).toBe("1.2.0");
    expect(pending?.currentVersion).toBe("1.1.0");
    expect(pending?.notes).toBe("Fixes and stuff");
    expect(typeof pending?.install).toBe("function");
  });

  it("maps a missing body to null notes", async () => {
    enterTauri();
    checkMock.mockResolvedValue({
      version: "2.0.0",
      currentVersion: "1.9.0",
      body: undefined,
      downloadAndInstall: vi.fn(),
    });
    const pending = await checkForUpdates();
    expect(pending?.notes).toBeNull();
  });
});

describe("PendingUpdate.install - progress translation + relaunch", () => {
  it("reports a 0..1 fraction when a content length is known, then relaunches", async () => {
    enterTauri();
    // downloadAndInstall drives a sequence of progress events through the
    // callback the updater passes it; capture the callback and emit events.
    const downloadAndInstall = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 25 } });
        cb({ event: "Progress", data: { chunkLength: 25 } });
        cb({ event: "Finished", data: {} });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      downloadAndInstall,
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await checkForUpdates();
    const fractions: (number | null)[] = [];
    await pending!.install((f) => fractions.push(f));

    // Started (len>0 → 0), Progress 25/100, Progress 50/100, Finished → 1.
    expect(fractions).toEqual([0, 0.25, 0.5, 1]);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("reports null fractions when no content length is sent", async () => {
    enterTauri();
    const downloadAndInstall = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: { contentLength: 0 } });
        cb({ event: "Progress", data: { chunkLength: 10 } });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      downloadAndInstall,
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await checkForUpdates();
    const fractions: (number | null)[] = [];
    await pending!.install((f) => fractions.push(f));

    // Started with len 0 → null; Progress with no known total → null.
    expect(fractions).toEqual([null, null]);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a missing contentLength in Started as unknown size", async () => {
    enterTauri();
    const downloadAndInstall = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: {} });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      downloadAndInstall,
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await checkForUpdates();
    const fractions: (number | null)[] = [];
    await pending!.install((f) => fractions.push(f));

    expect(fractions).toEqual([null]);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("install works without an onProgress callback", async () => {
    enterTauri();
    const downloadAndInstall = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
        cb({ event: "Finished", data: {} });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      downloadAndInstall,
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await checkForUpdates();
    await expect(pending!.install()).resolves.toBeUndefined();
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});


describe("mobile updater separation", () => {
  it("does not call the desktop plugin in an Android Tauri app", async () => {
    enterTauri();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __YAWF_TAURI_MOBILE__: true, __YAWF_TAURI_ANDROID__: true });
    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });
  it("does not call the desktop plugin in an older Android user agent", async () => {
    enterTauri();
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 11; wv)", platform: "Linux armv8", maxTouchPoints: 5 });
    await expect(checkForUpdates()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
  });
});
