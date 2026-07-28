// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/settings";
import {
  buildDiagnosticsReport,
  clearDiagnostics,
  recentDiagnostics,
  recordDiagnostic,
  downloadDiagnosticsReport,
  redactDiagnosticText,
} from "./diagnostics";

beforeEach(clearDiagnostics);
afterEach(() => vi.restoreAllMocks());

describe("diagnostics", () => {
  it("redacts bearer, query, assignment, and credential-shaped values", () => {
    const text = redactDiagnosticText(
      "Authorization=secret-value Bearer abc.def.ghi https://x.test/?apikey=token123 token: 12345678901234567890123456789012",
    );

    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("token123");
    expect(text).not.toContain("12345678901234567890123456789012");
    expect(text).toContain("[redacted]");
  });

  it("bounds and copies the in-memory event buffer", () => {
    for (let index = 0; index < 105; index += 1) {
      recordDiagnostic("player", `event-${index}`);
    }

    const snapshot = recentDiagnostics();
    expect(snapshot).toHaveLength(100);
    expect(snapshot[0]?.code).toBe("event-5");
    snapshot[0]!.code = "mutated";
    expect(recentDiagnostics()[0]?.code).toBe("event-5");
  });

  it("exports configuration state without credential values", () => {
    const settings = {
      ...defaultSettings(),
      tmdbKey: "tmdb-secret",
      omdbKey: "omdb-secret",
      openSubtitlesApiKey: "subs-secret",
      traktClientId: "trakt-secret",
      debridTokens: [{ service: "torbox" as const, apiToken: "provider-secret" }],
      sources: [
        {
          id: "source-1",
          type: "torznab" as const,
          baseURL: "https://private.example/api",
          apiKey: "source-secret",
          isActive: true,
        },
      ],
    };

    recordDiagnostic("provider", "smoke.failed", "error", "token=do-not-export");
    const report = buildDiagnosticsReport({
      appVersion: "0.9.19",
      runtime: "desktop",
      platform: "mac",
      serverMode: false,
      settings,
    });
    const serialized = JSON.stringify(report);

    expect(report.configuration.configuredProviders).toEqual(["torbox"]);
    expect(report.configuration.activeSourceTypes).toEqual(["torznab"]);
    for (const secret of [
      "tmdb-secret",
      "omdb-secret",
      "subs-secret",
      "trakt-secret",
      "provider-secret",
      "source-secret",
      "private.example",
      "do-not-export",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("creates and tears down an in-browser diagnostics download", () => {
    const originalCreateElement = document.createElement.bind(document);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const click = vi.fn();
    const anchor = document.createElement("a");

    vi.spyOn(document, "createElement").mockImplementation((name: string) => {
      if (name === "a") {
        return Object.assign(anchor, {
          click,
        });
      }
      return originalCreateElement(name);
    });

    createObjectURL.mockReturnValue("blob:report");

    const report = {
      schemaVersion: 1,
      generatedAt: "2026-07-22T00:00:00.000Z",
      product: "YAWF Stream",
      appVersion: "1.0.0",
      environment: {
        runtime: "browser",
        platform: "MacIntel",
        mode: "local",
      },
      configuration: {
        networkMode: "auto",
        dataSaver: false,
        builtInPlayer: true,
        autoAdvanceEpisodes: true,
        configuredProviders: [],
        activeSourceTypes: [],
        builtInIndexersEnabled: true,
        tmdbConfigured: false,
        omdbConfigured: false,
        subtitlesConfigured: false,
        traktConfigured: false,
      },
      events: [],
    };

    downloadDiagnosticsReport(report);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  });
});
