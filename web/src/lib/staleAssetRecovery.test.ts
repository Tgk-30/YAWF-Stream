// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  installStaleAssetFailureCapture,
  isStaleAssetLoadError,
} from "./staleAssetRecovery";

describe("stale asset recovery classification", () => {
  it.each([
    "Unable to preload CSS for /assets/TierOnboarding-DEXptdKN.css",
    "Failed to fetch dynamically imported module: https://db.example/assets/Detail-AbCd1234.js",
  ])("recognizes an asset-specific preload failure: %s", (message) => {
    expect(isStaleAssetLoadError(new Error(message))).toBe(true);
  });

  it("does not classify unrelated exceptions or generic connection errors", () => {
    expect(isStaleAssetLoadError(new Error("broken screen"))).toBe(false);
    expect(isStaleAssetLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleAssetLoadError(new Error("Unable to preload CSS for /settings.css"))).toBe(false);
  });

  it("tags a Vite preload payload without preventing the error and cleans up", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const cleanup = installStaleAssetFailureCapture();
    const registration = addEventListener.mock.calls.find(
      ([type]) => type === "vite:preloadError",
    );
    const payload = new Error("opaque preload failure");
    const event = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(event, "payload", { value: payload });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(isStaleAssetLoadError(payload)).toBe(true);
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith(
      "vite:preloadError",
      registration?.[1],
    );
  });
});
