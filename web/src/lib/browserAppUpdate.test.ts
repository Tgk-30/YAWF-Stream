// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNetworkMode } from "./networkPolicy";
import {
  BrowserAppUpdateCheckError,
  checkBrowserAppUpdate,
} from "./browserAppUpdate";

const CURRENT = "/assets/index-Current123.js";
const TARGET = "/assets/index-Target4567.js";

function installCurrent(path = CURRENT) {
  document.head.innerHTML = "";
  document.body.innerHTML = `<div id="root"></div><script type="module" src="${path}"></script>`;
}

function appHtml(path = TARGET, extra = ""): string {
  return `<!doctype html><html><head>${extra}</head><body><div id="root"></div><script type="module" src="${path}"></script></body></html>`;
}

function htmlResponse(html: string, options: {
  status?: number;
  contentType?: string;
  redirected?: boolean;
  url?: string;
} = {}): Response {
  const response = new Response(html, {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "text/html; charset=utf-8" },
  });
  if (options.redirected != null) {
    Object.defineProperty(response, "redirected", { configurable: true, value: options.redirected });
  }
  if (options.url != null) {
    Object.defineProperty(response, "url", { configurable: true, value: options.url });
  }
  return response;
}

beforeEach(() => {
  installCurrent();
  setNetworkMode("standard");
});

afterEach(() => {
  vi.useRealTimers();
  setNetworkMode("standard");
  vi.restoreAllMocks();
});

describe("browser app entry update check", () => {
  it("compares the loaded immutable entry with a direct same-origin no-cache index", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(appHtml()));

    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch })).resolves.toEqual({
      current: { path: CURRENT, hash: "Current123" },
      target: { path: TARGET, hash: "Target4567" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/", document.baseURI), expect.objectContaining({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { accept: "text/html" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("returns no update for the same entry", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(appHtml(CURRENT)));
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch })).resolves.toBeNull();
  });

  it.each([
    ["external module", appHtml("https://evil.example/assets/index-Target4567.js"), "text/html", false],
    ["protocol-relative module", appHtml("//evil.example/assets/index-Target4567.js"), "text/html", false],
    ["unhashed module", appHtml("/assets/index.js"), "text/html", false],
    ["multiple modules", appHtml(TARGET, '<script type="module" src="/assets/index-Other890.js"></script>'), "text/html", false],
    ["base URL", appHtml(TARGET, '<base href="https://evil.example/">'), "text/html", false],
    ["challenge page", "<!doctype html><html><body>Sign in</body></html>", "text/html", false],
    ["non-HTML response", appHtml(), "application/json", false],
    ["redirected response", appHtml(), "text/html", true],
  ])("rejects a malformed or untrusted %s", async (_label, html, contentType, redirected) => {
    const fetchImpl = vi.fn(async () => htmlResponse(html, { contentType, redirected }));
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toBeInstanceOf(BrowserAppUpdateCheckError);
  });

  it("rejects a response whose final URL changed", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(appHtml(), { url: `${location.origin}/login` }));
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/changed origin or path/);
  });

  it("honors privacy before issuing the request", async () => {
    setNetworkMode("offline");
    const fetchImpl = vi.fn();
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/Blocked updates request in offline mode/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts and rejects a request that exceeds the fixed deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const pending = checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 50 });
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("bounds streamed response bytes even without a content length", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(appHtml() + "x".repeat(512 * 1024)));
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/too large/);
  });

  it("rejects an oversized document before parsing it", async () => {
    const fetchImpl = vi.fn(async () => new Response(appHtml(), {
      headers: { "content-type": "text/html", "content-length": "999999" },
    }));
    await expect(checkBrowserAppUpdate({ fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/too large/);
  });
});
