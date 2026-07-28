import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNetworkMode } from "./networkPolicy";
import { TMDBError } from "../services/metadata/types";
import { testDebridToken, testOmdbKey, testTmdbKey } from "./onboardingValidation";
import type { DebridTokenEntry } from "../data/settings";

const tmdbSearch = vi.fn();
vi.mock("../services/metadata/TMDBService", async () => {
  const actual = await vi.importActual<typeof import("../services/metadata/TMDBService")>(
    "../services/metadata/TMDBService",
  );
  class TMDBService {
    search = tmdbSearch;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_apiKey: string) {}
  }
  return {
    ...actual,
    TMDBService,
  };
});

const debridValidate = vi.fn();
vi.mock("../data/settings", async () => {
  const actual = await vi.importActual<typeof import("../data/settings")>("../data/settings");
  return {
    ...actual,
    buildDebridService: (_entry: DebridTokenEntry) => {
      const entry = _entry;
      if (entry.apiToken.trim().length === 0) return null;
      return {
        validateToken: debridValidate,
      };
    },
  };
});

// testOmdbKey uses raw fetch (not the gated OMDBService), so it must enforce the
// privacy gate itself. In Offline mode the OMDb key must never leave the device.
describe("testOmdbKey privacy gate", () => {
  const fetchSpy = vi.fn();
  const original = globalThis.fetch;

  beforeEach(() => {
    setNetworkMode("standard");
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    setNetworkMode("standard");
    globalThis.fetch = original;
  });

  it("never sends the key off-device when ratings are blocked (offline)", async () => {
    setNetworkMode("offline");
    await expect(testOmdbKey("SECRET-OMDB-KEY")).resolves.toBe("network");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reaches OMDb normally in standard mode", async () => {
    fetchSpy.mockResolvedValue({ status: 200, json: async () => ({ Response: "True" }) });
    await expect(testOmdbKey("GOOD-KEY")).resolves.toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns ok when OMDb responds with a temporary lookup failure", async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      json: async () => ({ Response: "False", Error: "Movie not found!" }),
    });
    await expect(testOmdbKey("GOOD-KEY")).resolves.toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns unauthorized for an OMDb key-style error response", async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      json: async () => ({ Response: "False", Error: "Invalid API key" }),
    });
    await expect(testOmdbKey("BAD-KEY")).resolves.toBe("unauthorized");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns network when OMDb fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("no network"));
    await expect(testOmdbKey("BAD-KEY")).resolves.toBe("network");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("testTmdbKey", () => {
  beforeEach(() => {
    tmdbSearch.mockReset();
  });

  it("maps unauthorized and rate-limited keys", async () => {
    tmdbSearch.mockRejectedValue(TMDBError.unauthorized());
    await expect(testTmdbKey("BAD-KEY")).resolves.toBe("unauthorized");

    tmdbSearch.mockRejectedValue(TMDBError.rateLimited());
    await expect(testTmdbKey("LIMITED-KEY")).resolves.toBe("ok");
  });

  it("reports network failures as unverified", async () => {
    tmdbSearch.mockRejectedValue(new Error("network down"));
    await expect(testTmdbKey("X")).resolves.toBe("network");
  });

  it("treats successful TMDB responses as working keys", async () => {
    tmdbSearch.mockResolvedValue({ results: [{ id: 1 }] });
    await expect(testTmdbKey("GOOD-KEY")).resolves.toBe("ok");
  });
});

describe("testDebridToken", () => {
  beforeEach(() => {
    debridValidate.mockReset();
  });

  it("returns false for missing token values", async () => {
    const result = await testDebridToken({ service: "premiumize", apiToken: "   " });
    expect(result).toBe(false);
    expect(debridValidate).not.toHaveBeenCalled();
  });

  it("passes through validateToken success and failure", async () => {
    debridValidate.mockResolvedValue(true);
    await expect(testDebridToken({ service: "torbox", apiToken: "tok" })).resolves.toBe(true);

    debridValidate.mockResolvedValue(false);
    await expect(testDebridToken({ service: "torbox", apiToken: "tok" })).resolves.toBe(false);
    expect(debridValidate).toHaveBeenCalledTimes(2);
  });

  it("returns false when validateToken rejects", async () => {
    debridValidate.mockRejectedValue(new Error("offline"));
    await expect(testDebridToken({ service: "real_debrid", apiToken: "tok" })).resolves.toBe(false);
  });
});
