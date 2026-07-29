import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceKind, isMobileBrowser, isStandaloneDisplay } from "./platform";

describe("platform detection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects iOS from the user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 0,
    });

    expect(deviceKind()).toBe("ios");
    expect(isMobileBrowser()).toBe(true);
  });

  it("treats iPad class as iOS via touch point heuristic", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh)",
      platform: "MacIntel",
      maxTouchPoints: 3,
    });

    expect(deviceKind()).toBe("ios");
    expect(isMobileBrowser()).toBe(true);
  });

  it("detects android from the user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel)",
      platform: "Linux",
      maxTouchPoints: 1,
    });

    expect(deviceKind()).toBe("android");
    expect(isMobileBrowser()).toBe(true);
  });

  it("detects macOS and windows and linux by platform", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(deviceKind()).toBe("mac");

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    expect(deviceKind()).toBe("windows");

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0",
      platform: "Linux x86_64",
      maxTouchPoints: 0,
    });
    expect(deviceKind()).toBe("linux");
  });

  it("falls back to desktop or unknown", () => {
    vi.stubGlobal("navigator", {
      userAgent: "My desktop app test",
      platform: "Unknown",
      maxTouchPoints: 0,
    });

    expect(deviceKind()).toBe("desktop");

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; CrOS armv7l 12345.0)",
      platform: "",
      maxTouchPoints: 0,
    });

    expect(deviceKind()).toBe("linux");
    expect(isMobileBrowser()).toBe(false);

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0",
      platform: "",
      maxTouchPoints: 0,
    });
    expect(deviceKind()).toBe("unknown");
    expect(isMobileBrowser()).toBe(false);
  });
});

describe("standalone detection", () => {
  it("reads nav.standalone when true", () => {
    vi.stubGlobal("navigator", {
      standalone: true,
      userAgent: "",
      platform: "",
      maxTouchPoints: 0,
      matchMedia: vi.fn(),
    } as unknown as Navigator & { standalone?: boolean });

    expect(isStandaloneDisplay()).toBe(true);
  });

  it("reads matchMedia standalone when windowed", () => {
    vi.stubGlobal("navigator", {
      standalone: false,
      userAgent: "",
      platform: "",
      maxTouchPoints: 0,
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    } as unknown as Navigator & { standalone?: boolean });

    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    expect(isStandaloneDisplay()).toBe(true);
  });
});
