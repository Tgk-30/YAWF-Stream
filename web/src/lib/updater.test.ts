// Tests for the auto-updater bridge (src/lib/updater.ts).
//
// `checkForUpdates()` must be safe outside the desktop Tauri shell (no import of
// the updater runtime, never throws, returns a typed unsupported result). The vitest
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

const admissionState = vi.hoisted(() => ({ player: false, installing: false, releases: 0 }));
vi.mock("./attention", () => ({
  getPlayerMounted: () => admissionState.player,
  tryAcquireUpdateInstallation: () => {
    if (admissionState.player || admissionState.installing) return null;
    admissionState.installing = true;
    return () => { admissionState.installing = false; admissionState.releases += 1; };
  },
}));

const relaunchMock = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

import { checkForUpdates, UpdateDeferredError, UpdateRestartRequiredError, type PendingUpdate } from "./updater";
import { setNetworkMode } from "./networkPolicy";

/** Put a fake Tauri window in place so isTauri() returns true. */
function enterTauri(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 });
}

async function availableUpdate(): Promise<PendingUpdate> {
  const result = await checkForUpdates();
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error("expected available update");
  return result.update;
}

beforeEach(() => {
  admissionState.player = false; admissionState.installing = false; admissionState.releases = 0;
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
    await expect(checkForUpdates()).resolves.toEqual({ status: "unsupported" });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("does not throw even if a window without the Tauri flag exists", async () => {
    // A bare window (a plain browser) still lacks __TAURI_INTERNALS__.
    vi.stubGlobal("window", {});
    await expect(checkForUpdates()).resolves.toEqual({ status: "unsupported" });
    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe("checkForUpdates (under Tauri)", () => {
  it("does not invoke the updater plugin when updates are blocked", async () => {
    enterTauri();
    setNetworkMode("offline");

    await expect(checkForUpdates()).resolves.toEqual({ status: "privacy-blocked" });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("honors an explicit privacy mode supplied by the UI", async () => {
    enterTauri();

    await expect(checkForUpdates("fullLocal")).resolves.toEqual({
      status: "privacy-blocked",
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("returns no-update when the updater reports no update available", async () => {
    enterTauri();
    checkMock.mockResolvedValue(null);
    await expect(checkForUpdates()).resolves.toEqual({ status: "no-update" });
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("returns check-failed and never throws when the check itself rejects", async () => {
    enterTauri();
    checkMock.mockRejectedValue(new Error("network down"));
    await expect(checkForUpdates()).resolves.toEqual({ status: "check-failed" });
  });

  it("maps an available update to a PendingUpdate (notes from body)", async () => {
    enterTauri();
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: "Fixes and stuff",
      download: vi.fn(),
    });
    const pending = await availableUpdate();
    expect(pending.version).toBe("1.2.0");
    expect(pending.currentVersion).toBe("1.1.0");
    expect(pending.notes).toBe("Fixes and stuff");
    expect(typeof pending.install).toBe("function");
  });

  it("maps a missing body to null notes", async () => {
    enterTauri();
    checkMock.mockResolvedValue({
      version: "2.0.0",
      currentVersion: "1.9.0",
      body: undefined,
      download: vi.fn(),
    });
    const pending = await availableUpdate();
    expect(pending.notes).toBeNull();
  });
});

describe("PendingUpdate.install - progress translation + relaunch", () => {
  it("reports a 0..1 fraction when a content length is known, then relaunches", async () => {
    enterTauri();
    // download drives a sequence of progress events through the
    // callback the updater passes it; capture the callback and emit events.
    const download = vi.fn(
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
      download,
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await availableUpdate();
    const fractions: (number | null)[] = [];
    await pending.install((f) => fractions.push(f));

    // Started (len>0 → 0), Progress 25/100, Progress 50/100, Finished → 1.
    expect(fractions).toEqual([0, 0.25, 0.5, 1]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("reports null fractions when no content length is sent", async () => {
    enterTauri();
    const download = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: { contentLength: 0 } });
        cb({ event: "Progress", data: { chunkLength: 10 } });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      download,
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await availableUpdate();
    const fractions: (number | null)[] = [];
    await pending.install((f) => fractions.push(f));

    // Started with len 0 → null; Progress with no known total → null.
    expect(fractions).toEqual([null, null]);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a missing contentLength in Started as unknown size", async () => {
    enterTauri();
    const download = vi.fn(
      async (cb: (event: unknown) => void) => {
        cb({ event: "Started", data: {} });
      },
    );
    checkMock.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: null,
      download,
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await availableUpdate();
    const fractions: (number | null)[] = [];
    await pending.install((f) => fractions.push(f));

    expect(fractions).toEqual([null]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("install works without an onProgress callback", async () => {
    enterTauri();
    const download = vi.fn(
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
      download,
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    relaunchMock.mockResolvedValue(undefined);

    const pending = await availableUpdate();
    await expect(pending.install()).resolves.toBeUndefined();
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});


describe("mobile updater separation", () => {
  it("does not call the desktop plugin in an Android Tauri app", async () => {
    enterTauri();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __YAWF_TAURI_MOBILE__: true, __YAWF_TAURI_ANDROID__: true });
    await expect(checkForUpdates()).resolves.toEqual({ status: "unsupported" });
    expect(checkMock).not.toHaveBeenCalled();
  });
  it("remains unsupported on Android even when its privacy mode blocks updates", async () => {
    enterTauri();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __YAWF_TAURI_MOBILE__: true, __YAWF_TAURI_ANDROID__: true });
    await expect(checkForUpdates("fullLocal")).resolves.toEqual({ status: "unsupported" });
    expect(checkMock).not.toHaveBeenCalled();
  });
  it("does not call the desktop plugin in an older Android user agent", async () => {
    enterTauri();
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 11; wv)", platform: "Linux armv8", maxTouchPoints: 5 });
    await expect(checkForUpdates()).resolves.toEqual({ status: "unsupported" });
    expect(checkMock).not.toHaveBeenCalled();
  });
});

function deferredUpdate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stagedNativeUpdate() {
  enterTauri();
  const native = { version: "9.0.0", currentVersion: "8.0.0", body: null,
    download: vi.fn(async () => {}), install: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  checkMock.mockResolvedValue(native); relaunchMock.mockResolvedValue(undefined);
  return native;
}
describe("split native update admission", () => {
  it("does not download or install while any player is already mounted", async () => {
    const native = stagedNativeUpdate(); const candidate = await availableUpdate();
    admissionState.player = true;
    await expect(candidate.install()).rejects.toBeInstanceOf(UpdateDeferredError);
    expect(native.download).not.toHaveBeenCalled(); expect(native.install).not.toHaveBeenCalled();
  });
  it.each(["player", "policy"] as const)("retains downloaded bytes when %s changes during download and retries without downloading twice", async (reason) => {
    const native = stagedNativeUpdate(); const download = deferredUpdate<void>(); native.download.mockImplementationOnce(() => download.promise);
    const candidate = await availableUpdate(); let allowed = true; const started = vi.fn();
    const operation = candidate.install(undefined, { canProceed: () => allowed, onInstallStarted: started });
    const rejected = expect(operation).rejects.toBeInstanceOf(UpdateDeferredError);
    if (reason === "player") admissionState.player = true; else allowed = false;
    download.resolve(); await rejected;
    expect(native.install).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
    admissionState.player = false; allowed = true;
    await candidate.install(undefined, { canProceed: () => allowed, onInstallStarted: started });
    expect(native.download).toHaveBeenCalledTimes(1); expect(native.install).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1); expect(admissionState.installing).toBe(true);
  });
  it("checks privacy again at the split download boundary", async () => {
    const native = stagedNativeUpdate(); const download = deferredUpdate<void>(); native.download.mockImplementationOnce(() => download.promise);
    const candidate = await availableUpdate(); const operation = candidate.install();
    const rejected = expect(operation).rejects.toBeInstanceOf(UpdateDeferredError);
    setNetworkMode("fullLocal"); download.resolve(); await rejected;
    expect(native.install).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled();
  });
  it("shares one in-flight operation and holds admission through native installation and relaunch", async () => {
    const native = stagedNativeUpdate(); const installed = deferredUpdate<void>(); const restarted = deferredUpdate<void>();
    native.install.mockImplementationOnce(() => installed.promise); relaunchMock.mockImplementationOnce(() => restarted.promise);
    const candidate = await availableUpdate(); const started = vi.fn(); let allowed = true;
    const first = candidate.install(undefined, { canProceed: () => allowed, onInstallStarted: started });
    expect(candidate.install()).toBe(first);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    expect(admissionState.installing).toBe(true);
    allowed = false; setNetworkMode("fullLocal"); await candidate.close?.();
    expect(native.close).not.toHaveBeenCalled(); installed.resolve();
    await vi.waitFor(() => expect(relaunchMock).toHaveBeenCalledTimes(1));
    expect(admissionState.installing).toBe(true);
    restarted.resolve(); await first; expect(admissionState.releases).toBe(0);
  });
  it("releases physical admission after native install fails before success", async () => {
    const native = stagedNativeUpdate();
    native.install.mockRejectedValueOnce(new Error("Native apply failed"));
    const candidate = await availableUpdate(); await expect(candidate.install()).rejects.toThrow("Native apply failed");
    expect(admissionState.installing).toBe(false); expect(admissionState.releases).toBe(1);
  });
  it("disposes a cancelled in-flight download once and never installs its late bytes", async () => {
    const native = stagedNativeUpdate(); const download = deferredUpdate<void>(); native.download.mockImplementationOnce(() => download.promise);
    const candidate = await availableUpdate(); const operation = candidate.install();
    const rejected = expect(operation).rejects.toBeInstanceOf(UpdateDeferredError);
    const closed = candidate.close!(); expect(candidate.close!()).toBe(closed); expect(native.close).not.toHaveBeenCalled();
    download.resolve(); await rejected; await closed;
    expect(native.close).toHaveBeenCalledTimes(1); expect(native.install).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled();
  });
});

describe("applied update restart-only recovery", () => {
  it.each(["restart", "stale install"] as const)("uses only %s after apply succeeds but restart fails despite disabled network policy", async (retry) => {
    const native = stagedNativeUpdate(); relaunchMock.mockRejectedValueOnce(new Error("Restart failed"));
    const candidate = await availableUpdate();
    await expect(candidate.install()).rejects.toBeInstanceOf(UpdateRestartRequiredError);
    expect(candidate.applied).toBe(true); expect(admissionState.installing).toBe(true); expect(admissionState.releases).toBe(0);
    setNetworkMode("fullLocal"); await candidate.close?.(); expect(native.close).not.toHaveBeenCalled();
    if (retry === "restart") await candidate.restart!(); else await candidate.install(undefined, { canProceed: () => false });
    expect(native.download).toHaveBeenCalledTimes(1); expect(native.install).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(2); expect(admissionState.installing).toBe(true); expect(admissionState.releases).toBe(0);
  });
  it("deduplicates restart-only retries and remains restart-required after another failure", async () => {
    const native = stagedNativeUpdate(); relaunchMock.mockRejectedValueOnce(new Error("First restart failed"));
    const candidate = await availableUpdate(); await expect(candidate.install()).rejects.toBeInstanceOf(UpdateRestartRequiredError);
    const restarted = deferredUpdate<void>(); relaunchMock.mockImplementationOnce(() => restarted.promise);
    const first = candidate.restart!(); expect(candidate.restart!()).toBe(first); expect(candidate.install()).toBe(first);
    const rejected = expect(first).rejects.toBeInstanceOf(UpdateRestartRequiredError);
    restarted.reject(new Error("Second restart failed")); await rejected;
    expect(candidate.applied).toBe(true); expect(admissionState.installing).toBe(true);
    await candidate.restart!(); expect(native.download).toHaveBeenCalledTimes(1); expect(native.install).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(3); expect(admissionState.releases).toBe(0);
  });
  it("does not offer a local restart before native apply success", async () => {
    const native = stagedNativeUpdate(); const candidate = await availableUpdate();
    await expect(candidate.restart!()).rejects.toThrow("has not been installed");
    expect(candidate.applied).toBe(false); expect(native.install).not.toHaveBeenCalled(); expect(relaunchMock).not.toHaveBeenCalled();
  });
});
