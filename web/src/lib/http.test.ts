// Unit tests for the cross-environment HTTP wrapper (`appFetch`).
//
// `appFetch` has three runtime paths plus a module-level cache:
//   1. NOT under Tauri  → uses the global `fetch` directly.
//   2. Under Tauri      → dynamically imports `@tauri-apps/plugin-http` and calls
//      its `fetch` (the native, CORS-free proxy). The imported fn is cached.
//   3. Under Tauri but the dynamic import throws → degrades to the global `fetch`.
//
// We mock `./tauri` (`isTauri`) and `@tauri-apps/plugin-http` (the plugin fetch).
// Because the success-path caches the imported plugin fetch in module-level state
// (`cachedTauriFetch`), several tests use `vi.resetModules()` + a fresh dynamic
// `import("./http")` so each scenario starts with a clean cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks ---------------------------------------------------------
const isTauri = vi.fn<() => boolean>();
vi.mock("./tauri", () => ({
  isTauri: () => isTauri(),
}));

const configuredServerURL = vi.fn<() => string | null>(() => null);
vi.mock("./serverMode", () => ({
  configuredServerURL: () => configuredServerURL(),
}));

// The Tauri plugin's `fetch`. Mocked so the dynamic `import(...)` resolves to it.
const pluginFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => pluginFetch(...args),
}));

/** Build a minimal Response-like object that satisfies `{ status, text() }`. */
function fakeResponse(status: number, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

let globalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  globalFetch = vi.fn();
  vi.stubGlobal("fetch", globalFetch);
  // Default: not under Tauri (the plain-browser path).
  isTauri.mockReturnValue(false);
  configuredServerURL.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Re-import the module fresh so module-level cache state (`cachedTauriFetch`)
 * does not leak between tests. */
async function loadHttp() {
  return await import("./http");
}

describe("appFetch - non-Tauri (browser) path", () => {
  it("blocks disallowed hosts in Offline mode before fetch", async () => {
    const { appFetch } = await loadHttp();
    const { NetworkBlockedError, setNetworkMode } = await import("./networkPolicy");
    setNetworkMode("offline");

    await expect(appFetch("https://api.themoviedb.org/3/movie/1")).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("allows permitted metadata hosts in Full Local mode", async () => {
    globalFetch.mockResolvedValue(fakeResponse(200, "ok"));
    const { appFetch } = await loadHttp();
    const { setNetworkMode } = await import("./networkPolicy");
    setNetworkMode("fullLocal");

    await expect(appFetch("https://api.themoviedb.org/3/movie/1")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("always allows the configured server and loopback URLs", async () => {
    configuredServerURL.mockReturnValue("http://192.168.1.9:3000");
    globalFetch.mockResolvedValue(fakeResponse(200, "ok"));
    const { appFetch } = await loadHttp();
    const { setNetworkMode } = await import("./networkPolicy");
    setNetworkMode("offline");

    await appFetch("http://192.168.1.9:3000/api/me");
    await appFetch("http://localhost:3000/api/me");
    expect(globalFetch).toHaveBeenCalledTimes(2);
  });

  it("delegates to the global fetch and returns its Response", async () => {
    const res = fakeResponse(200, "ok");
    globalFetch.mockResolvedValue(res);
    const { appFetch } = await loadHttp();

    const out = await appFetch("https://api.example.com/data");

    expect(isTauri).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledWith("https://api.example.com/data", undefined);
    expect(pluginFetch).not.toHaveBeenCalled();
    expect(out).toBe(res);
    expect(out.status).toBe(200);
    await expect(out.text()).resolves.toBe("ok");
  });

  it("passes the init object (method/headers/body) straight through to fetch", async () => {
    globalFetch.mockResolvedValue(fakeResponse(201, "created"));
    const { appFetch } = await loadHttp();

    const init = {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    };
    await appFetch("https://api.example.com/create", init);

    expect(globalFetch).toHaveBeenCalledWith("https://api.example.com/create", init);
  });

  it("surfaces a non-2xx Response without throwing (caller inspects status)", async () => {
    const res = fakeResponse(404, "not found");
    globalFetch.mockResolvedValue(res);
    const { appFetch } = await loadHttp();

    const out = await appFetch("https://api.example.com/missing");

    expect(out.status).toBe(404);
    await expect(out.text()).resolves.toBe("not found");
  });

  it("surfaces a 500 Response as-is", async () => {
    globalFetch.mockResolvedValue(fakeResponse(500, "boom"));
    const { appFetch } = await loadHttp();
    const out = await appFetch("https://api.example.com/err");
    expect(out.status).toBe(500);
  });

  it("supports JSON body round-trip via the returned Response shape", async () => {
    globalFetch.mockResolvedValue(fakeResponse(200, JSON.stringify({ hello: "world" })));
    const { appFetch } = await loadHttp();
    const out = await appFetch("https://api.example.com/json");
    const parsed = JSON.parse(await out.text());
    expect(parsed).toEqual({ hello: "world" });
  });

  it("propagates a network rejection from the global fetch (does not swallow)", async () => {
    globalFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { appFetch } = await loadHttp();
    await expect(appFetch("https://down.example.com")).rejects.toThrow("Failed to fetch");
  });

  it("propagates an abort/timeout rejection from the global fetch", async () => {
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    globalFetch.mockRejectedValue(abortErr);
    const { appFetch } = await loadHttp();
    await expect(appFetch("https://slow.example.com")).rejects.toBe(abortErr);
  });
});

describe("appFetch - Tauri path", () => {
  it("routes through the plugin fetch (not the global) when under Tauri", async () => {
    isTauri.mockReturnValue(true);
    const res = fakeResponse(200, "native");
    pluginFetch.mockResolvedValue(res);
    const { appFetch } = await loadHttp();

    const out = await appFetch("https://indexer.example.com/api", { method: "GET" });

    expect(pluginFetch).toHaveBeenCalledTimes(1);
    expect(pluginFetch).toHaveBeenCalledWith("https://indexer.example.com/api", { method: "GET" });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(out).toBe(res);
    await expect(out.text()).resolves.toBe("native");
  });

  it("caches the imported plugin fetch across calls (imports once)", async () => {
    isTauri.mockReturnValue(true);
    pluginFetch.mockResolvedValue(fakeResponse(200, "x"));
    const { appFetch } = await loadHttp();

    await appFetch("https://a.example.com");
    await appFetch("https://b.example.com");
    await appFetch("https://c.example.com");

    // All three calls reuse the cached plugin fetch.
    expect(pluginFetch).toHaveBeenCalledTimes(3);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("passes undefined init through to the plugin fetch when no init given", async () => {
    isTauri.mockReturnValue(true);
    pluginFetch.mockResolvedValue(fakeResponse(204, ""));
    const { appFetch } = await loadHttp();

    await appFetch("https://nobody.example.com");

    expect(pluginFetch).toHaveBeenCalledWith("https://nobody.example.com", undefined);
  });

  it("does not replay a rejected native request through global fetch", async () => {
    isTauri.mockReturnValue(true);
    pluginFetch.mockRejectedValue(new Error("native request failed"));
    const { appFetch } = await loadHttp();

    await expect(appFetch("https://flaky.example.com")).rejects.toThrow(
      "native request failed",
    );

    expect(pluginFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("falls back to global fetch only when the native transport import fails", async () => {
    isTauri.mockReturnValue(true);
    globalFetch.mockResolvedValue(fakeResponse(200, "browser fallback"));
    vi.doMock("@tauri-apps/plugin-http", () => {
      throw new Error("plugin module unavailable");
    });
    try {
      const { appFetch } = await loadHttp();
      const response = await appFetch("https://fallback.example.com");

      expect(pluginFetch).not.toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
      await expect(response.text()).resolves.toBe("browser fallback");
    } finally {
      vi.doMock("@tauri-apps/plugin-http", () => ({
        fetch: (...args: unknown[]) => pluginFetch(...args),
      }));
    }
  });
});

describe("appFetch - isTauri gating", () => {
  it("evaluates isTauri() on every call (re-checks environment)", async () => {
    globalFetch.mockResolvedValue(fakeResponse(200, "a"));
    const { appFetch } = await loadHttp();

    await appFetch("https://1.example.com");
    await appFetch("https://2.example.com");

    expect(isTauri).toHaveBeenCalledTimes(2);
  });

  it("can switch from browser path to Tauri path between calls", async () => {
    pluginFetch.mockResolvedValue(fakeResponse(200, "native"));
    globalFetch.mockResolvedValue(fakeResponse(200, "browser"));
    const { appFetch } = await loadHttp();

    isTauri.mockReturnValue(false);
    const first = await appFetch("https://x.example.com");
    expect(await first.text()).toBe("browser");

    isTauri.mockReturnValue(true);
    const second = await appFetch("https://y.example.com");
    expect(await second.text()).toBe("native");

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(pluginFetch).toHaveBeenCalledTimes(1);
  });
});
