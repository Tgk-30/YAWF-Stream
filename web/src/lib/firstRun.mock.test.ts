// Mock-based unit tests for firstRun gating logic.
//
// Unlike the sibling firstRun.test.ts (which exercises the real DexieStore via
// fake-indexeddb), this suite mocks the `../storage` and `./serverMode` modules
// so we can drive every branch in isolation - including the DEV qa-skip bypass,
// the configured-server-URL short-circuit, and the store read/write error
// contracts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks ---------------------------------------------------------
const getSetting = vi.fn<(key: string) => Promise<string | null>>();
const setSetting = vi.fn<(key: string, value: string | null) => Promise<void>>();

vi.mock("../storage", () => ({
  getStore: () => ({ getSetting, setSetting }),
}));

const configuredServerURL = vi.fn<() => string | null>();

vi.mock("./serverMode", () => ({
  configuredServerURL: () => configuredServerURL(),
}));

// Imported AFTER the mocks are registered (vi.mock is hoisted, so this is safe).
import { isFirstRun, markOnboardingComplete } from "./firstRun";

const ONBOARDING_KEY = "onboarding_completed";

/** Set globalThis.location.search (the source devBypassesOnboarding reads). */
function stubLocation(search: string): void {
  vi.stubGlobal("location", { search } as unknown as Location);
}

beforeEach(() => {
  vi.resetAllMocks();
  // Defaults: local mode, store reports nothing onboarded.
  configuredServerURL.mockReturnValue(null);
  getSetting.mockResolvedValue(null);
  setSetting.mockResolvedValue(undefined);
  // DEV is `true` under vitest by default; force production unless a test opts
  // into DEV explicitly, so the qa-skip branch is only exercised on purpose.
  vi.stubEnv("DEV", false);
  stubLocation("");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isFirstRun", () => {
  it("is true on a genuine fresh local install (no server URL, nothing stored)", async () => {
    await expect(isFirstRun()).resolves.toBe(true);
    expect(getSetting).toHaveBeenCalledWith(ONBOARDING_KEY);
  });

  it("is false once onboarding_completed is stored", async () => {
    getSetting.mockResolvedValue("true");
    await expect(isFirstRun()).resolves.toBe(false);
  });

  it("is false when the stored value is empty string (only null counts as not-done)", async () => {
    // The check is `done == null`, so an empty string is treated as completed.
    getSetting.mockResolvedValue("");
    await expect(isFirstRun()).resolves.toBe(false);
  });

  it("treats undefined from the store as not-yet-onboarded (== null)", async () => {
    getSetting.mockResolvedValue(undefined as unknown as string | null);
    await expect(isFirstRun()).resolves.toBe(true);
  });

  it("is false when a server URL is configured, without ever touching the store", async () => {
    configuredServerURL.mockReturnValue("https://stream.example.com");
    await expect(isFirstRun()).resolves.toBe(false);
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("still gates (server URL null) - empty-string URL counts as configured only if non-null", async () => {
    // configuredServerURL returns a string for any configured value, including "".
    configuredServerURL.mockReturnValue("");
    await expect(isFirstRun()).resolves.toBe(false);
    // "" != null, so it short-circuits before the store read.
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("does not trap the user when the store read throws (returns false)", async () => {
    getSetting.mockRejectedValue(new Error("indexeddb unavailable"));
    await expect(isFirstRun()).resolves.toBe(false);
  });

  it("checks server URL before reading the store", async () => {
    configuredServerURL.mockReturnValue("https://srv");
    getSetting.mockResolvedValue(null);
    await isFirstRun();
    expect(configuredServerURL).toHaveBeenCalledTimes(1);
    expect(getSetting).not.toHaveBeenCalled();
  });

  describe("DEV qa-skip bypass", () => {
    it("returns false in DEV when ?qa-skip-onboarding is present (no server, nothing stored)", async () => {
      vi.stubEnv("DEV", true);
      stubLocation("?qa-skip-onboarding");
      await expect(isFirstRun()).resolves.toBe(false);
      // Bypass short-circuits before serverMode/store are consulted.
      expect(configuredServerURL).not.toHaveBeenCalled();
      expect(getSetting).not.toHaveBeenCalled();
    });

    it("bypass works with the param mixed among other query params", async () => {
      vi.stubEnv("DEV", true);
      stubLocation("?foo=1&qa-skip-onboarding=&bar=2");
      await expect(isFirstRun()).resolves.toBe(false);
    });

    it("does NOT bypass in DEV without the qa-skip param", async () => {
      vi.stubEnv("DEV", true);
      stubLocation("?some=thing");
      await expect(isFirstRun()).resolves.toBe(true);
      expect(getSetting).toHaveBeenCalledWith(ONBOARDING_KEY);
    });

    it("ignores the qa-skip param entirely in production (DEV=false)", async () => {
      vi.stubEnv("DEV", false);
      stubLocation("?qa-skip-onboarding");
      // Param is present but DEV is off, so normal gating applies → first run.
      await expect(isFirstRun()).resolves.toBe(true);
    });

    it("does not throw if location is missing in DEV (optional-chaining + empty search)", async () => {
      vi.stubEnv("DEV", true);
      vi.stubGlobal("location", undefined);
      // location?.search ?? "" → "" → URLSearchParams("") has no param → no bypass.
      await expect(isFirstRun()).resolves.toBe(true);
    });

    it("falls back to normal gating when search normalization throws", async () => {
      vi.stubEnv("DEV", true);
      vi.stubGlobal("location", {
        get search() {
          throw new Error("bad location search");
        },
      } as unknown as Location);
      await expect(isFirstRun()).resolves.toBe(true);
      expect(getSetting).toHaveBeenCalledWith(ONBOARDING_KEY);
    });
  });
});

describe("markOnboardingComplete", () => {
  it("persists the onboarding flag as the string \"true\"", async () => {
    await markOnboardingComplete();
    expect(setSetting).toHaveBeenCalledWith(ONBOARDING_KEY, "true");
  });

  it("rejects when the completion marker cannot be persisted", async () => {
    setSetting.mockRejectedValue(new Error("disk full"));
    await expect(markOnboardingComplete()).rejects.toThrow("disk full");
  });

  it("resolves to undefined on success", async () => {
    await expect(markOnboardingComplete()).resolves.toBeUndefined();
  });
});

describe("round-trip via mocked store", () => {
  it("after marking complete, a store that now returns \"true\" makes isFirstRun false", async () => {
    // Simulate the store actually persisting the value.
    let stored: string | null = null;
    setSetting.mockImplementation(async (_k, v) => {
      stored = v;
    });
    getSetting.mockImplementation(async () => stored);

    expect(await isFirstRun()).toBe(true);
    await markOnboardingComplete();
    expect(stored).toBe("true");
    expect(await isFirstRun()).toBe(false);
  });

  it("keeps the next launch in first-run until a failed completion write is retried", async () => {
    let stored: string | null = null;
    setSetting
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockImplementation(async (_key, value) => {
        stored = value;
      });
    getSetting.mockImplementation(async () => stored);

    await expect(markOnboardingComplete()).rejects.toThrow("quota exceeded");
    await expect(isFirstRun()).resolves.toBe(true);

    await markOnboardingComplete();
    await expect(isFirstRun()).resolves.toBe(false);
    expect(setSetting).toHaveBeenCalledTimes(2);
  });
});
