import { describe, expect, it } from "vitest";
import { SERVER_RELEASE_DISCOVERY_MAX_BYTES, SERVER_RELEASE_DISCOVERY_TIMEOUT_MS, SERVER_RELEASE_PAGE_LIMIT, SERVER_RELEASE_PAGE_MAX_BYTES, SERVER_RELEASES_PER_PAGE,
  fetchLatestServerRelease, selectServerRelease, serverReleaseStatus } from "../src/serverRelease.js";

const digest = `sha256:${"a".repeat(64)}`;
function release(tag: string, names: string[], extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, html_url: `https://github.com/Tgk-30/YAWF-Stream/releases/tag/${tag}`,
    draft: false, prerelease: false, published_at: "2026-10-12T00:00:00Z",
    assets: names.map((name) => ({ name, digest, size: 10, browser_download_url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/${name}` })),
    ...extra,
  };
}

describe("server release selection", () => {
  it("keeps independent page, aggregate, record, and deadline budgets", () => {
    expect({ perPage: SERVER_RELEASES_PER_PAGE, pages: SERVER_RELEASE_PAGE_LIMIT, pageBytes: SERVER_RELEASE_PAGE_MAX_BYTES,
      aggregateBytes: SERVER_RELEASE_DISCOVERY_MAX_BYTES, discoveryTimeoutMs: SERVER_RELEASE_DISCOVERY_TIMEOUT_MS }).toEqual(
      { perPage: 100, pages: 10, pageBytes: 4_000_000, aggregateBytes: 8_000_000, discoveryTimeoutMs: 10_000 });
  });

  it("chooses the greatest actual server release instead of the desktop latest release", () => {
    const selected = selectServerRelease([
      release("v2.3.6-web", ["YAWF-Stream.dmg", "SHA256SUMS"]),
      release("v2.3.8", ["debridstreamer-server_2.3.8_all.deb", "SHA256SUMS"]),
      release("android-v9.0.0", ["app.apk", "SHA256SUMS"]),
      release("v2.3.10-web", ["debridstreamer-server_2.3.10_all.deb", "SHA256SUMS", "server-update.json"]),
    ]);
    expect(selected).toMatchObject({ version: "2.3.10", tag: "v2.3.10-web" });
    expect(serverReleaseStatus("2.3.9", selected).available).toBe(true);
  });

  it("rejects drafts, prereleases, malformed digests, and missing exact assets", () => {
    expect(selectServerRelease([
      release("v3.0.0", ["debridstreamer-server_3.0.0_all.deb", "SHA256SUMS"], { draft: true }),
      release("v2.9.0", ["debridstreamer-server_latest_all.deb", "SHA256SUMS"]),
      { ...release("v2.8.0", ["debridstreamer-server_2.8.0_all.deb", "SHA256SUMS"]), assets: [{ name: "SHA256SUMS", digest: "sha256:no", size: 1, browser_download_url: "https://example.com" }] },
    ])).toBeNull();
  });

  it("scans bounded pages larger than 2 MB in aggregate and selects the greatest numeric release", async () => {
    const filler = (page: number, index: number) => ({ tag_name: `invalid-${page}-${index}`, padding: "x".repeat(Math.floor(800_000 / SERVER_RELEASES_PER_PAGE)) });
    const older = release("v9.99.99", ["debridstreamer-server_9.99.99_all.deb", "SHA256SUMS"]);
    const greatest = release("v10.0.0", ["debridstreamer-server_10.0.0_all.deb", "SHA256SUMS", "server-update.json"]);
    const pages = [
      [older, ...Array.from({ length: SERVER_RELEASES_PER_PAGE - 1 }, (_, index) => filler(1, index))],
      Array.from({ length: SERVER_RELEASES_PER_PAGE }, (_, index) => filler(2, index)),
      Array.from({ length: SERVER_RELEASES_PER_PAGE }, (_, index) => filler(3, index)),
      [greatest],
    ].map((page) => Buffer.from(JSON.stringify(page)));
    expect(pages.slice(0, 3).every((page) => page.length < SERVER_RELEASE_PAGE_MAX_BYTES)).toBe(true);
    const aggregateBytes = pages.reduce((total, page) => total + page.length, 0);
    expect(aggregateBytes).toBeGreaterThan(2_000_000);
    expect(aggregateBytes).toBeLessThan(8_000_000);
    const requested: number[] = []; const discoverySignals: AbortSignal[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url)); const page = Number(parsed.searchParams.get("page")); requested.push(page);
      expect(parsed.hostname).toBe("api.github.com");
      expect(parsed.searchParams.get("per_page")).toBe(String(SERVER_RELEASES_PER_PAGE));
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      discoverySignals.push(init!.signal!);
      const bytes = pages[page - 1] ?? Buffer.from("[]");
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    }) as typeof fetch;
    await expect(fetchLatestServerRelease(fetchImpl)).resolves.toMatchObject({ version: "10.0.0", tag: "v10.0.0" });
    expect(requested).toEqual([1, 2, 3, 4]);
    expect(discoverySignals.every((signal) => signal === discoverySignals[0])).toBe(true);
  });

  // Literal100/100/42 and payload sizes independently guard the observed242-entry history.
  function history242(mode: "none" | "current" | "later") {
    const rows: Record<string, unknown>[] = Array.from({ length: 242 }, (_, index) => ({ tag_name: `not-server-${index}` }));
    const server = (version: string) => release(`v${version}`, [`debridstreamer-server_${version}_all.deb`, "SHA256SUMS"]);
    if (mode !== "none") rows[0] = server("2.3.110");
    if (mode === "later") { rows[100] = server("2.3.111"); rows[200] = server("2.3.112"); }
    const sizes = [1_568_586, 2_263_873, 1_270_317];
    const bodies = [rows.slice(0, 100), rows.slice(100, 200), rows.slice(200)].map((page, index) => {
      page[0] = { ...page[0], padding: "" };
      page[0]!.padding = "x".repeat(sizes[index]! - Buffer.byteLength(JSON.stringify(page)));
      const bytes = Buffer.from(JSON.stringify(page)); expect(bytes.length).toBe(sizes[index]); return bytes;
    });
    expect(bodies.reduce((sum, bytes) => sum + bytes.length, 0)).toBe(5_102_776);
    const pages: number[] = []; const signals: AbortSignal[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url)); expect(parsed.searchParams.get("per_page")).toBe("100");
      const page = Number(parsed.searchParams.get("page")); pages.push(page); signals.push(init!.signal!);
      expect(page).toBeGreaterThanOrEqual(1); expect(page).toBeLessThanOrEqual(3);
      const bytes = bodies[page - 1]!;
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    }) as typeof fetch;
    return { fetchImpl, pages, signals };
  }

  for (const mode of ["none", "current", "later"] as const) {
    it(`242-entry history exhausts100/100/42 pages and selects ${mode}`, async () => {
      const fixture = history242(mode); const selected = await fetchLatestServerRelease(fixture.fetchImpl);
      if (mode === "none") expect(selected).toBeNull();
      else {
        expect(selected?.version).toBe(mode === "current" ? "2.3.110" : "2.3.112");
        expect(serverReleaseStatus("2.3.110", selected)).toMatchObject({ available: mode === "later", state: mode === "later" ? "available" : "current" });
      }
      expect(fixture.pages).toEqual([1, 2, 3]);
      expect(fixture.signals.every(signal => signal === fixture.signals[0])).toBe(true);
    });
  }

  for (const failure of ["http", "malformed", "timeout"] as const) {
    it(`a first-page current release cannot bypass a later ${failure} failure`, async () => {
      const fixture = history242("current");
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).searchParams.get("page") === "2") {
          if (failure === "timeout") throw new DOMException("fixture deadline", "TimeoutError");
          return failure === "http" ? new Response("failure", { status: 503 }) : new Response("{");
        }
        return fixture.fetchImpl(url, init);
      }) as typeof fetch;
      await expect(fetchLatestServerRelease(fetchImpl)).rejects.toThrow(failure === "http" ? /lookup failed/ : failure === "timeout" ? /deadline/ : /JSON|property/);
    });
  }

  it("stops on short or empty pages and fails closed at its page limit", async () => {
    const full = Buffer.from(JSON.stringify(Array.from({ length: SERVER_RELEASES_PER_PAGE }, (_, index) => ({ tag_name: `invalid-${index}` }))));
    let calls = 0;
    const endingFetch = (async () => {
      calls += 1; const bytes = calls === 1 ? full : Buffer.from("[]");
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    }) as typeof fetch;
    await expect(fetchLatestServerRelease(endingFetch)).resolves.toBeNull();
    expect(calls).toBe(2);

    const pages: number[] = [];
    const loopingFetch = (async (url: string | URL | Request) => {
      pages.push(Number(new URL(String(url)).searchParams.get("page")));
      return new Response(full, { status: 200, headers: { "content-length": String(full.length) } });
    }) as typeof fetch;
    await expect(fetchLatestServerRelease(loopingFetch)).rejects.toThrow(/page limit/);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const largeFull = Buffer.from(JSON.stringify(Array.from({ length: SERVER_RELEASES_PER_PAGE }, (_, index) => ({
      tag_name: `large-invalid-${index}`, padding: "x".repeat(Math.floor(900_000 / SERVER_RELEASES_PER_PAGE)),
    }))));
    expect(largeFull.length).toBeLessThan(SERVER_RELEASE_PAGE_MAX_BYTES);
    let largeCalls = 0;
    const largeFetch = (async () => { largeCalls += 1; return new Response(largeFull, { status: 200 }); }) as typeof fetch;
    await expect(fetchLatestServerRelease(largeFetch)).rejects.toThrow(/aggregate size limit/);
    expect(largeCalls).toBeLessThan(10);

    calls = 0;
    const emptyFetch = (async () => { calls += 1; return new Response("[]", { status: 200 }); }) as typeof fetch;
    await expect(fetchLatestServerRelease(emptyFetch)).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("cancels an oversized individual release page", async () => {
    let cancelled = false; let sent = false;
    const response = { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({
      read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(SERVER_RELEASE_PAGE_MAX_BYTES + 1) }; },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    }) } } as unknown as Response;
    await expect(fetchLatestServerRelease((async () => response) as typeof fetch)).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
  });

  it("ignores external pagination links", async () => {
    const full = Buffer.from(JSON.stringify(Array.from({ length: SERVER_RELEASES_PER_PAGE }, (_, index) => ({ tag_name: `invalid-link-${index}` }))));
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url)); requested.push(parsed.href);
      const bytes = requested.length === 1 ? full : Buffer.from("[]");
      return new Response(bytes, { status: 200, headers: { link: '<https://evil.invalid/releases?page=2>; rel="next"' } });
    }) as typeof fetch;
    await expect(fetchLatestServerRelease(fetchImpl)).resolves.toBeNull();
    expect(requested.map((url) => new URL(url).hostname)).toEqual(["api.github.com", "api.github.com"]);
    expect(requested.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
  });
});
