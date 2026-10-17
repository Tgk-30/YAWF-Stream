import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { encryptSecret, randomId } from "../src/crypto.js";
import { MAX_HLS_MANIFEST_BYTES } from "../src/hlsManifest.js";

const origin = "https://93.184.216.34";
let app: FastifyInstance;
let dir: string;
let db: DatabaseSync;
let secret: Buffer;
let profileId: string;
let ownerHeaders: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function session(url: string, opts: { contentType?: string; expiresAt?: string } = {}) {
  const id = randomId("stream");
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  db.prepare(`INSERT INTO stream_sessions
    (id, profile_id, encrypted_upstream_url, content_type, created_at, expires_at, source_kind)
    VALUES (?, ?, ?, ?, ?, ?, 'http')`).run(
    id, profileId, encryptSecret(url, secret), opts.contentType ?? null,
    new Date().toISOString(), expiresAt,
  );
  const token = createHmac("sha256", secret)
    .update("debridstreamer:stream-playback:v1\0").update(id).update("\0")
    .update(profileId).update("\0").update(expiresAt).digest("base64url");
  return { id, token, path: `/api/external-stream/${id}/${token}` };
}

function media(body: BodyInit | null, contentType: string, url: string, status = 200, headers = {}) {
  const response = new Response(body, { status, headers: { "content-type": contentType, ...headers } });
  // Fetch's URL is populated by the HTTP client, not a Response constructor.
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function references(manifest: string): string[] {
  return manifest.split("\n").flatMap((line) => line.trim().startsWith("#")
    ? [...line.matchAll(/(?:^|[, :])URI="([^"]+)"/g)].map((match) => match[1]!)
    : line.trim() ? [line.trim()] : []);
}

const localPath = (reference: string, base: string) =>
  new URL(reference, `https://server.example${base}`).pathname;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "yawf-external-hls-"));
  secret = randomBytes(32);
  const databasePath = join(dir, "test.sqlite");
  app = await buildApp({ config: {
    databasePath, dataDir: dir, secretKey: secret, logger: false,
    cookieSecure: false, allowRawStreamUrls: false,
    streamUpstreamResponseTimeoutMs: 100, streamUpstreamIdleTimeoutMs: 50,
  } });
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup-owner", payload: {
    username: "owner", password: "fixture-password", displayName: "Owner",
  } });
  expect(setup.statusCode).toBe(200);
  ownerHeaders = {
    cookie: setup.cookies.map((item) => `${item.name}=${item.value}`).join("; "),
    "x-csrf-token": setup.cookies.find((item) => item.name === "ds_csrf")!.value,
  };
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: ownerHeaders });
  profileId = bootstrap.json().session.profileId;
  // Seed only this disposable test DB; production raw sessions stay disabled.
  db = new DatabaseSync(databasePath);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("cookie-free HLS capability graph", () => {
  it("contains redirected master, extensionless video/audio, keys and maps without exposing source URLs", async () => {
    const root = session(`${origin}/entry.m3u8`);
    const master = ["#EXTM3U", "#EXT-X-VERSION:6",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fr",URI="audio/list?source=fixture"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"', "video/list?source=fixture", ""].join("\n");
    const video = ["#EXTM3U", "#EXT-X-TARGETDURATION:6",
      '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?source=fixture"',
      "#EXT-X-BYTERANGE:4@0", "#EXTINF:6,", "segment.ts?source=fixture", "#EXT-X-ENDLIST", ""].join("\n");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      if (url.endsWith("/entry.m3u8")) return new Response(null, { status: 302, headers: { location: "/catalog/master.m3u8" } });
      if (url.endsWith("/catalog/master.m3u8")) return media(master, "application/vnd.apple.mpegurl", url);
      if (url.includes("/catalog/video/list")) return media(video, "text/plain", url);
      if (url.includes("/catalog/audio/list")) return media("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsound.aac\n#EXT-X-ENDLIST\n", "application/x-mpegurl", url);
      return media("fixture-media", "application/octet-stream", url);
    });
    const first = await app.inject({ method: "GET", url: root.path, headers: { range: "bytes=0-1" } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.body).toContain('LANGUAGE="fr"');
    expect(first.body).not.toContain(origin);
    expect(first.body).not.toContain("source=fixture");
    const top = references(first.body).map((ref) => localPath(ref, root.path));
    expect(top).toHaveLength(2);
    for (const path of top) {
      expect(path).toMatch(new RegExp(`^${root.path}/[a-f0-9]{64}\\.m3u8$`));
      const nested = await app.inject({ method: "GET", url: path });
      expect(nested.statusCode).toBe(200);
      expect(nested.body).not.toContain("source=fixture");
      for (const child of references(nested.body)) {
        const childPath = localPath(child, path);
        expect(childPath).toMatch(new RegExp(`^${root.path}/[a-f0-9]{64}\\.[a-z0-9]{1,8}$`));
        const bytes = await app.inject({ method: "GET", url: childPath });
        expect(bytes.statusCode).toBe(200);
        expect(bytes.body).toBe("fixture-media");
      }
      if (nested.body.includes("BYTERANGE")) expect(nested.body).toContain("#EXT-X-BYTERANGE:4@0");
    }
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/catalog/keys/key.bin"))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => new Headers(call[1]?.headers).get("range") == null)).toBe(true);
    const row = db.prepare("SELECT completed_at FROM stream_sessions WHERE id = ?").get(root.id);
    expect(row?.completed_at).toBeNull();
    // Relative references retain a reverse-proxy mount even when the proxy strips it.
    expect(new URL(references(first.body)[0]!, `https://server.example/mounted${root.path}`).pathname)
      .toBe(`/mounted${top[0]}`);
  });

  it("preserves child byte ranges, MIME and HEAD while rejecting wrong graphs and revoked/expired grants before fetch", async () => {
    const root = session(`${origin}/master.m3u8`);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith(".m3u8")) return media("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n", "application/x-mpegurl", url);
      return media(init?.method === "HEAD" ? null : "abcd", "video/mp2t", url, 206, {
        "accept-ranges": "bytes", "content-length": "4", "content-range": "bytes 0-3/10",
      });
    });
    const first = await app.inject({ method: "GET", url: root.path });
    const path = localPath(references(first.body)[0]!, root.path);
    const range = await app.inject({ method: "GET", url: path, headers: { range: "bytes=0-3" } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe("abcd");
    expect(range.headers["content-type"]).toBe("video/mp2t");
    expect(range.headers["content-range"]).toBe("bytes 0-3/10");
    expect(new Headers(fetchMock.mock.calls.at(-1)![1]?.headers).get("range")).toBe("bytes=0-3");
    const head = await app.inject({ method: "HEAD", url: path, headers: { range: "bytes=0-3" } });
    expect(head.statusCode).toBe(206);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("4");
    expect(db.prepare("SELECT completed_at FROM stream_sessions WHERE id = ?").get(root.id)?.completed_at)
      .toBeNull();
    const second = session(`${origin}/other.m3u8`);
    for (const invalid of [
      path.replace(root.token, "A".repeat(43)),
      `${second.path}/${path.split("/").at(-1)}`,
      `${root.path}/${"f".repeat(64)}.bin`,
      `${root.path}/${encodeURIComponent("https://127.0.0.1/private")}`,
    ]) {
      const calls = fetchMock.mock.calls.length;
      const response = await app.inject({ method: "GET", url: invalid });
      expect(response.statusCode).toBe(404);
      expect(fetchMock.mock.calls).toHaveLength(calls);
    }
    const revoked = await app.inject({ method: "POST", url: `/api/admin/streams/${root.id}/revoke`, headers: ownerHeaders });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
    const expired = session(`${origin}/expired.m3u8`, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const calls = fetchMock.mock.calls.length;
    expect((await app.inject({ method: "GET", url: expired.path })).statusCode).toBe(404);
    expect(fetchMock.mock.calls).toHaveLength(calls);
  });

  it("never marks progressive root HEAD probes as completed", async () => {
    const root = session(`${origin}/video.mp4`);
    fetchMock.mockImplementation(async (input) => media(null, "video/mp4", String(input), 200, {
      "content-length": "4000", "accept-ranges": "bytes",
    }));
    expect((await app.inject({ method: "HEAD", url: root.path })).statusCode).toBe(200);
    expect(db.prepare("SELECT completed_at FROM stream_sessions WHERE id = ?").get(root.id)?.completed_at)
      .toBeNull();
    const authenticatedPath = `/api/stream/${root.id}`;
    expect((await app.inject({ method: "HEAD", url: authenticatedPath, headers: ownerHeaders })).statusCode).toBe(200);
    expect(db.prepare("SELECT completed_at FROM stream_sessions WHERE id = ?").get(root.id)?.completed_at)
      .toBeNull();
  });

  it("revalidates SSRF rules for discovered children and every redirect", async () => {
    const root = session(`${origin}/master.m3u8`);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(".m3u8")) return media("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttp://127.0.0.1/private.ts\n#EXTINF:6,\nredirect.ts\n#EXT-X-ENDLIST\n", "application/x-mpegurl", url);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/private" } });
    });
    const first = await app.inject({ method: "GET", url: root.path });
    expect(first.statusCode).toBe(200);
    const [privateRef, redirectRef] = references(first.body);
    const initialCalls = fetchMock.mock.calls.length;
    expect((await app.inject({ method: "GET", url: localPath(privateRef!, root.path) })).statusCode).toBe(502);
    expect(fetchMock.mock.calls).toHaveLength(initialCalls);
    expect((await app.inject({ method: "GET", url: localPath(redirectRef!, root.path) })).statusCode).toBe(502);
    expect(fetchMock.mock.calls).toHaveLength(initialCalls + 1);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("169.254"))).toBe(true);
  });

  it("retries extensionless partial manifests without Range and supplies honest rewritten HEAD metadata", async () => {
    const root = session(`${origin}/playlist`);
    const body = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n";
    fetchMock.mockImplementation(async (input, init) => {
      const partial = new Headers(init?.headers).has("range");
      return media(init?.method === "HEAD" ? null : partial ? "#E" : body,
        "application/x-mpegurl", String(input), partial ? 206 : 200,
        { "content-length": String(partial ? 2 : Buffer.byteLength(body)), etag: '"source-etag"' });
    });
    const response = await app.inject({ method: "GET", url: root.path, headers: { range: "bytes=0-1" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("#EXT-X-ENDLIST");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).has("range")).toBe(false);
    expect(response.headers.etag).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(response.body));
    const head = await app.inject({ method: "HEAD", url: root.path });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers.etag).toBeUndefined();
    expect(Number(head.headers["content-length"] ?? 0)).not.toBe(Buffer.byteLength(body));
  });

  it.each(["declared", "streamed", "malformed", "invalid-utf8", "stalled"])("bounds %s upstream manifests", async (kind) => {
    const root = session(`${origin}/master.m3u8`);
    fetchMock.mockImplementation(async (input) => {
      if (kind === "declared") return media("#EXTM3U", "application/x-mpegurl", String(input), 200,
        { "content-length": String(MAX_HLS_MANIFEST_BYTES + 1) });
      if (kind === "streamed") return media("#EXTM3U\n" + "x".repeat(MAX_HLS_MANIFEST_BYTES), "application/x-mpegurl", String(input));
      if (kind === "malformed") return media("not a playlist", "application/x-mpegurl", String(input));
      if (kind === "invalid-utf8") return media(new Uint8Array([0xff, 0xfe]), "application/x-mpegurl", String(input));
      return media(new ReadableStream({ pull() { return new Promise(() => {}); } }), "application/x-mpegurl", String(input));
    });
    const response = await app.inject({ method: "GET", url: root.path });
    expect(response.statusCode).toBe(kind === "stalled" ? 504 : 502);
    expect(response.body).not.toContain(origin);
    expect(response.body).not.toContain(root.token);
  });
});
