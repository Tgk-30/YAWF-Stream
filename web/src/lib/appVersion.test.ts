import { describe, expect, it, vi } from "vitest";
import {
  compareAppVersions,
  DESKTOP_NATIVE_COMPATIBILITY_FLOOR,
  getAppVersion,
  getNativeAppVersion,
  requiresDesktopNativeUpdate,
} from "./appVersion";

const browser = () => "browser-version";

describe("getAppVersion", () => {
  it("uses the browser build version outside Tauri", async () => {
    const native = vi.fn(async () => "9.9.9");

    await expect(
      getAppVersion({ isTauri: () => false, native, browser }),
    ).resolves.toBe("browser-version");
    expect(native).not.toHaveBeenCalled();
  });

  it("uses the async native version in Tauri", async () => {
    const native = vi.fn(async () => "1.2.3");

    await expect(
      getAppVersion({ isTauri: () => true, native, browser }),
    ).resolves.toBe("1.2.3");
    expect(native).toHaveBeenCalledOnce();
  });

  it("falls back to the browser version if native lookup fails", async () => {
    const native = vi.fn(async () => {
      throw new Error("native API unavailable");
    });

    await expect(
      getAppVersion({ isTauri: () => true, native, browser }),
    ).resolves.toBe("browser-version");
  });
});

describe("getNativeAppVersion", () => {
  it("does not hide a failed native lookup behind the hosted web version", async () => {
    const native = vi.fn(async () => {
      throw new Error("native API unavailable");
    });

    await expect(
      getNativeAppVersion({ isTauri: () => true, native, browser }),
    ).resolves.toBeNull();
  });
});

describe("compareAppVersions", () => {
  it.each([
    ["0.9.21", "0.9.24", -1],
    ["0.10.0", "0.9.24", 1],
    ["v1.2.3", "1.2.3", 0],
    ["1.2.3-beta.2", "1.2.3-beta.10", -1],
    ["1.2.3-beta", "1.2.3", -1],
  ])("compares %s with %s", (left, right, direction) => {
    expect(Math.sign(compareAppVersions(left, right))).toBe(direction);
  });
});

describe("desktop native compatibility floor", () => {
  it("keeps the audited native floor independent from the web bundle version", () => {
    expect(DESKTOP_NATIVE_COMPATIBILITY_FLOOR).toBe("2.3.6");
    expect(requiresDesktopNativeUpdate("2.3.6")).toBe(false);
    expect(requiresDesktopNativeUpdate("2.3.13")).toBe(false);
  });

  it("continues to hard-gate a desktop package below the audited floor", () => {
    expect(requiresDesktopNativeUpdate("2.3.5")).toBe(true);
    expect(requiresDesktopNativeUpdate("2.3.6-beta.1")).toBe(true);
  });

  it("accepts an explicit later floor when a future native ABI changes", () => {
    expect(requiresDesktopNativeUpdate("2.3.20", "2.3.21")).toBe(true);
    expect(requiresDesktopNativeUpdate("2.3.21", "2.3.21")).toBe(false);
  });
});
