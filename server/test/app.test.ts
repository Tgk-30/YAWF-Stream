import { createServer, type Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { AppDatabase } from "../src/db.js";
import type { Transcoder } from "../src/transcode.js";

// A fake ffmpeg surface so transcode tests run without a real binary: detect()
// returns the configured availability, and spawnHls synchronously writes a stub
// HLS manifest + one segment into the dir encoded in the argv, then returns a
// fake child that "dies" cleanly when killed.
const FAKE_MANIFEST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:6",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXTINF:6.0,",
  "seg_00000.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

function makeFakeTranscoder(opts: { detect?: boolean; writeOutput?: boolean } = {}): Transcoder {
  return {
    async detect() {
      return opts.detect ?? true;
    },
    spawnHls(args: string[]) {
      const outputPath = args[args.length - 1] as string;
      const dir = dirname(outputPath);
      // writeOutput:false simulates an ffmpeg that never produces a manifest (so
      // ensureJob's start-timeout → 504 can be exercised).
      if (opts.writeOutput !== false) {
        if (args.includes("webvtt")) {
          writeFileSync(
            join(dir, "subtitles.vtt"),
            "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
          );
        } else if (args.includes("-master_pl_name")) {
          writeFileSync(
            join(dir, "stream.m3u8"),
            [
              "#EXTM3U",
              "#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080",
              "1080p.m3u8",
              "#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1280x720",
              "720p.m3u8",
              "#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=854x480",
              "480p.m3u8",
              "",
            ].join("\n"),
          );
          for (const rendition of ["1080p", "720p", "480p"]) {
            writeFileSync(
              join(dir, `${rendition}.m3u8`),
              FAKE_MANIFEST.replaceAll("seg_00000.ts", `${rendition}_seg_00000.ts`),
            );
            writeFileSync(
              join(dir, `${rendition}_seg_00000.ts`),
              Buffer.from([0, 0, 0, 0]),
            );
          }
        } else {
          writeFileSync(join(dir, "stream.m3u8"), FAKE_MANIFEST);
          writeFileSync(join(dir, "seg_00000.ts"), Buffer.from([0, 0, 0, 0]));
        }
      }
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal?: string) => boolean;
        stderr: null;
      };
      child.kill = () => {
        setImmediate(() => child.emit("close", 0));
        return true;
      };
      child.stderr = null;
      return child as unknown as ReturnType<Transcoder["spawnHls"]>;
    },
  };
}

interface TestClient {
  app: FastifyInstance;
  cookies: Map<string, string>;
}

function rememberCookies(client: TestClient, response: LightMyRequestResponse): void {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const line of cookies) {
    const first = line.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    if (value.length === 0) client.cookies.delete(name);
    else client.cookies.set(name, value);
  }
}

function cookieHeader(client: TestClient): string {
  return [...client.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function request(
  client: TestClient,
  opts: {
    method: string;
    url: string;
    payload?: unknown;
    csrf?: boolean;
    headers?: Record<string, string>;
  },
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const cookie = cookieHeader(client);
  if (cookie.length > 0) headers.cookie = cookie;
  if (opts.csrf) {
    const token = client.cookies.get("ds_csrf");
    if (token) headers["x-csrf-token"] = token;
  }
  const response = await client.app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload,
    headers,
  });
  rememberCookies(client, response);
  return response;
}

function json<T = unknown>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const char of value) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function currentTotp(secret: string): string {
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest.at(-1)! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) % 1_000_000;
  return String(value).padStart(6, "0");
}

async function setupOwner(app: FastifyInstance): Promise<TestClient> {
  const client: TestClient = { app, cookies: new Map() };
  const response = await request(client, {
    method: "POST",
    url: "/api/auth/setup-owner",
    payload: {
      username: "owner",
      password: "owner-password",
      displayName: "Owner",
    },
  });
  expect(response.statusCode).toBe(200);
  expect(client.cookies.get("ds_session")).toBeTruthy();
  expect(client.cookies.get("ds_csrf")).toBeTruthy();
  return client;
}

async function protectedTestApp(setupToken: string): Promise<FastifyInstance> {
  return buildApp({
    config: {
      databasePath: ":memory:",
      dataDir: ".test-data",
      secretKey: randomBytes(32),
      setupToken,
      cookieSecure: false,
      logger: false,
      allowRawStreamUrls: true,
    },
  });
}

async function createProfile(
  owner: TestClient,
  username: string,
  password: string,
  role: "admin" | "member" | "restricted" = "member",
): Promise<string> {
  const response = await request(owner, {
    method: "POST",
    url: "/api/profiles",
    csrf: true,
    payload: {
      username,
      password,
      displayName: username,
      role,
    },
  });
  expect(response.statusCode).toBe(200);
  return json<{ profile: { id: string } }>(response).profile.id;
}

async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<TestClient> {
  const client: TestClient = { app, cookies: new Map() };
  const response = await request(client, {
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return client;
}

describe("DebridStreamer server", () => {
  let app: FastifyInstance;
  let upstream: Server | null = null;
  let upstreamUrl = "";

  beforeEach(async () => {
    app = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: true,
      },
    });
  });

  afterEach(async () => {
    if (upstream != null) {
      await new Promise<void>((resolve) => upstream?.close(() => resolve()));
      upstream = null;
    }
    await app.close();
  });

  it("compresses large JSON responses when the client accepts gzip", async () => {
    app.get("/test/compression", async () => ({
      items: Array.from({ length: 300 }, (_, index) => ({
        id: index,
        title: `Playback source ${index}`,
      })),
    }));
    const response = await app.inject({
      method: "GET",
      url: "/test/compression",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.rawPayload.byteLength).toBeLessThan(2_000);
  });

  it("pairs a phone remote without exposing playback or session credentials", async () => {
    const viewer = await setupOwner(app);
    const created = await request(viewer, {
      method: "POST",
      url: "/api/remote/sessions",
      csrf: true,
    });
    expect(created.statusCode).toBe(200);
    const viewerSession = json<{
      session: { id: string; pairingCode: string };
    }>(created).session;
    expect(viewerSession.pairingCode).toMatch(/^\d{6}$/);

    const controller = await request(viewer, {
      method: "POST",
      url: "/api/remote/pair",
      csrf: true,
      payload: {
        code: viewerSession.pairingCode,
        controllerName: "Phone",
      },
    });
    expect(controller.statusCode).toBe(200);
    const paired = json<{
      session: { id: string; controllerToken: string };
    }>(controller).session;
    expect(paired.id).toBe(viewerSession.id);

    const queued = await request(viewer, {
      method: "POST",
      url: `/api/remote/sessions/${viewerSession.id}/commands`,
      csrf: true,
      headers: { "x-yawf-remote-token": paired.controllerToken },
      payload: { type: "seek-relative", value: 10 },
    });
    expect(queued.statusCode).toBe(200);

    const snapshot = await request(viewer, {
      method: "GET",
      url: `/api/remote/sessions/${viewerSession.id}?after=0`,
    });
    expect(snapshot.statusCode).toBe(200);
    const body = json<{
      session: {
        paired: boolean;
        commands: Array<{ type: string; value: number }>;
        controllerToken?: string;
      };
    }>(snapshot).session;
    expect(body.paired).toBe(true);
    expect(body.commands).toEqual([
      expect.objectContaining({ type: "seek-relative", value: 10 }),
    ]);
    expect(body).not.toHaveProperty("controllerToken");

    const rejected = await request(viewer, {
      method: "POST",
      url: `/api/remote/sessions/${viewerSession.id}/commands`,
      csrf: true,
      headers: { "x-yawf-remote-token": "wrong" },
      payload: { type: "play" },
    });
    expect(rejected.statusCode).toBe(404);
  });

  it("exports a secret-free profile bundle and imports it into another profile", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/settings/profile",
      csrf: true,
      payload: { key: "ui_theme", value: "midnight" },
    });
    await request(owner, {
      method: "PUT",
      url: "/api/settings/profile",
      csrf: true,
      payload: { key: "tmdb_api_key", value: "must-not-export" },
    });
    await request(owner, {
      method: "PUT",
      url: "/api/library/watchlist/tt-portable",
      csrf: true,
      payload: { preview: { id: "tt-portable", title: "Portable title" } },
    });
    await request(owner, {
      method: "PUT",
      url: "/api/history/tt-portable",
      csrf: true,
      payload: {
        progressSeconds: 42,
        durationSeconds: 100,
        completed: false,
        lastWatched: "2026-07-24T10:00:00.000Z",
        preview: { id: "tt-portable", title: "Portable title" },
      },
    });
    const folderResponse = await request(owner, {
      method: "POST",
      url: "/api/library/folders",
      csrf: true,
      payload: { name: "Portable folder", listType: "favorites" },
    });
    expect(folderResponse.statusCode).toBe(200);
    const folderId = json<{ folder: { id: string } }>(folderResponse).folder.id;
    await request(owner, {
      method: "PUT",
      url: "/api/library/tt-portable",
      csrf: true,
      payload: {
        listType: "favorites",
        folderId,
        preview: { id: "tt-portable", title: "Portable title" },
      },
    });

    const exported = await request(owner, {
      method: "GET",
      url: "/api/portability/export",
    });
    expect(exported.statusCode).toBe(200);
    const bundle = json<{
      bundle: {
        settings: Array<{ key: string; value: string }>;
        watchlist: Array<{ mediaId: string }>;
        history: Array<{ mediaId: string; progressSeconds: number }>;
        folders: Array<{ id: string; name: string }>;
        library: Array<{ mediaId: string; folderId: string | null }>;
      };
    }>(exported).bundle;
    expect(bundle.settings).toContainEqual({ key: "ui_theme", value: "midnight" });
    expect(bundle.settings.some((setting) => setting.key === "tmdb_api_key")).toBe(false);
    expect(bundle.watchlist).toContainEqual(
      expect.objectContaining({ mediaId: "tt-portable" }),
    );
    expect(bundle.history).toContainEqual(
      expect.objectContaining({
        mediaId: "tt-portable",
        progressSeconds: 42,
      }),
    );

    await createProfile(owner, "portable-member", "member-password");
    const member = await login(app, "portable-member", "member-password");
    const imported = await request(member, {
      method: "POST",
      url: "/api/portability/import",
      csrf: true,
      payload: { mode: "merge", bundle },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(
      json<{
        counts: {
          settings: number;
          watchlist: number;
          history: number;
          folders: number;
          library: number;
        };
      }>(imported).counts,
    ).toMatchObject({
      settings: 1,
      watchlist: 1,
      history: 1,
      folders: 1,
      library: 1,
    });

    const roundTrip = json<{
      bundle: {
        settings: Array<{ key: string; value: string }>;
        watchlist: Array<{ mediaId: string }>;
        history: Array<{ mediaId: string; progressSeconds: number }>;
        folders: Array<{ name: string }>;
        library: Array<{ mediaId: string }>;
      };
    }>(
      await request(member, {
        method: "GET",
        url: "/api/portability/export",
      }),
    ).bundle;
    expect(roundTrip.settings).toContainEqual({ key: "ui_theme", value: "midnight" });
    expect(roundTrip.watchlist).toContainEqual(
      expect.objectContaining({ mediaId: "tt-portable" }),
    );
    expect(roundTrip.history).toContainEqual(
      expect.objectContaining({
        mediaId: "tt-portable",
        progressSeconds: 42,
      }),
    );
    expect(roundTrip.folders).toContainEqual(
      expect.objectContaining({ name: "Portable folder" }),
    );
    expect(roundTrip.library).toContainEqual(
      expect.objectContaining({ mediaId: "tt-portable" }),
    );
  });

  it("restores child-first folder trees and safely breaks imported cycles", async () => {
    const owner = await setupOwner(app);
    const now = new Date().toISOString();
    const folder = (
      id: string,
      name: string,
      parentId: string | null,
    ) => ({
      id,
      name,
      parentId,
      listType: "favorites" as const,
      folderKind: "manual" as const,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    });
    const bundle = {
      product: "YAWF Stream" as const,
      format: "yawf-profile-portable" as const,
      version: 1 as const,
      createdAt: now,
      settings: [],
      watchlist: [],
      history: [],
      folders: [
        folder("child", "Child", "parent"),
        folder("parent", "Parent", null),
        folder("cycle-a", "Cycle A", "cycle-b"),
        folder("cycle-b", "Cycle B", "cycle-a"),
      ],
      library: [
        {
          mediaId: "tt-nested",
          folderId: "child",
          listType: "favorites" as const,
          addedAt: now,
          customListName: null,
          releaseDateHint: null,
          renewalStatus: null,
          preview: { id: "tt-nested", title: "Nested title" },
        },
      ],
    };

    const imported = await request(owner, {
      method: "POST",
      url: "/api/portability/import",
      csrf: true,
      payload: { mode: "merge", bundle },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(
      json<{ counts: { folders: number; library: number } }>(imported).counts,
    ).toMatchObject({
      folders: 4,
      library: 1,
    });

    const exported = json<{
      bundle: {
        folders: Array<{
          id: string;
          name: string;
          parentId: string | null;
        }>;
        library: Array<{ mediaId: string; folderId: string | null }>;
      };
    }>(
      await request(owner, {
        method: "GET",
        url: "/api/portability/export",
      }),
    ).bundle;
    const byName = new Map(exported.folders.map((entry) => [entry.name, entry]));
    expect(byName.get("Child")?.parentId).toBe(byName.get("Parent")?.id);
    expect(byName.get("Cycle A")?.parentId).not.toBe(byName.get("Cycle B")?.id);
    expect(byName.get("Cycle B")?.parentId).toBe(byName.get("Cycle A")?.id);
    expect(exported.library).toContainEqual(
      expect.objectContaining({
        mediaId: "tt-nested",
        folderId: byName.get("Child")?.id,
      }),
    );

    const duplicateFolders = await request(owner, {
      method: "POST",
      url: "/api/portability/import",
      csrf: true,
      payload: {
        mode: "merge",
        bundle: {
          ...bundle,
          library: [],
          folders: [
            folder("duplicate", "First", null),
            folder("duplicate", "Second", null),
          ],
        },
      },
    });
    expect(duplicateFolders.statusCode).toBe(400);
  });

  it("reissues an invite with the same policy and revokes the old token", async () => {
    const owner = await setupOwner(app);
    const created = await request(owner, {
      method: "POST",
      url: "/api/admin/invites",
      csrf: true,
      payload: {
        label: "Living room",
        role: "restricted",
        simpleMode: true,
        maxUses: 3,
        expiresInSeconds: 86_400,
      },
    });
    expect(created.statusCode).toBe(200);
    const first = json<{
      invite: { id: string; expiresAt: string };
      token: string;
    }>(created);

    const reissued = await request(owner, {
      method: "POST",
      url: `/api/admin/invites/${first.invite.id}/reissue`,
      csrf: true,
    });
    expect(reissued.statusCode).toBe(200);
    const replacement = json<{
      invite: {
        id: string;
        label: string;
        role: string;
        simpleMode: boolean;
        maxUses: number;
        usedCount: number;
        active: boolean;
        expiresAt: string;
      };
      token: string;
    }>(reissued);
    expect(replacement.invite).toMatchObject({
      label: "Living room",
      role: "restricted",
      simpleMode: true,
      maxUses: 3,
      usedCount: 0,
      active: true,
    });
    expect(replacement.invite.id).not.toBe(first.invite.id);
    expect(replacement.token).not.toBe(first.token);
    expect(
      new Date(replacement.invite.expiresAt).getTime() - Date.now(),
    ).toBeGreaterThan(23 * 60 * 60 * 1000);

    const oldToken = await request(
      { app, cookies: new Map() },
      {
        method: "POST",
        url: "/api/auth/invite",
        payload: {
          token: first.token,
          username: "old-link",
          password: "strong-password",
        },
      },
    );
    expect(oldToken.statusCode).toBe(410);

    const newToken = await request(
      { app, cookies: new Map() },
      {
        method: "POST",
        url: "/api/auth/invite",
        payload: {
          token: replacement.token,
          username: "new-link",
          password: "strong-password",
        },
      },
    );
    expect(newToken.statusCode).toBe(200);
  });

  it("completes a progressive stream search when no indexer is configured", async () => {
    const owner = await setupOwner(app);
    const response = await request(owner, {
      method: "GET",
      url: "/api/streams/tt1234567?type=movie&progressive=1",
    });
    expect(response.statusCode).toBe(200);
    const phases = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; rows: unknown[] });
    expect(phases).toEqual([
      expect.objectContaining({ phase: "sources", rows: [] }),
      expect.objectContaining({ phase: "ready", rows: [] }),
    ]);
  });

  it("creates the first owner, starts a session, and rejects unsafe writes without CSRF", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(json<{ setupRequired: boolean }>(health).setupRequired).toBe(true);

    const owner = await setupOwner(app);
    const session = await request(owner, { method: "GET", url: "/api/auth/session" });
    expect(session.statusCode).toBe(200);
    expect(json<{ session: { username: string; role: string } }>(session).session).toMatchObject({
      username: "owner",
      role: "owner",
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/setup-owner",
      payload: {
        username: "owner2",
        password: "owner-password",
        displayName: "Owner 2",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const noCsrf = await request(owner, {
      method: "PUT",
      url: "/api/library/watchlist/tt001",
      payload: { preview: { id: "tt001", title: "No CSRF" } },
    });
    expect(noCsrf.statusCode).toBe(403);

    const setting = await request(owner, {
      method: "PUT",
      url: "/api/settings/profile",
      csrf: true,
      payload: { key: "ui_theme", value: "midnight" },
    });
    expect(setting.statusCode).toBe(200);

    const settings = await request(owner, {
      method: "GET",
      url: "/api/settings/profile",
    });
    expect(settings.statusCode).toBe(200);
    expect(json<{ settings: Record<string, string> }>(settings).settings).toMatchObject({
      ui_theme: "midnight",
    });

    const logoutWithoutCsrf = await request(owner, {
      method: "POST",
      url: "/api/auth/logout",
    });
    expect(logoutWithoutCsrf.statusCode).toBe(403);

    const logout = await request(owner, {
      method: "POST",
      url: "/api/auth/logout",
      csrf: true,
    });
    expect(logout.statusCode).toBe(200);

    const revoked = await request(owner, {
      method: "GET",
      url: "/api/auth/session",
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("sets hardened session cookies while keeping only the CSRF token readable", async () => {
    const hardened = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: true,
        cookieSameSite: "strict",
        logger: false,
      },
    });
    try {
      const response = await hardened.inject({
        method: "POST",
        url: "/api/auth/setup-owner",
        payload: {
          username: "secure-owner",
          password: "secure-owner-password",
          displayName: "Secure Owner",
        },
      });
      expect(response.statusCode).toBe(200);
      const raw = response.headers["set-cookie"];
      const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const session = cookies.find((line) => line.startsWith("ds_session="));
      const csrf = cookies.find((line) => line.startsWith("ds_csrf="));
      expect(session).toMatch(/; HttpOnly/i);
      expect(session).toMatch(/; Secure/i);
      expect(session).toMatch(/; SameSite=Strict/i);
      expect(csrf).not.toMatch(/; HttpOnly/i);
      expect(csrf).toMatch(/; Secure/i);
      expect(csrf).toMatch(/; SameSite=Strict/i);
    } finally {
      await hardened.close();
    }
  });

  it("requires a configured setup token before creating the first owner", async () => {
    const protectedApp = await protectedTestApp("setup-token-for-tests");
    try {
      const health = await protectedApp.inject({ method: "GET", url: "/api/health" });
      expect(json<{ setupRequired: boolean; setupTokenRequired: boolean }>(health)).toMatchObject({
        setupRequired: true,
        setupTokenRequired: true,
      });

      const missing = await protectedApp.inject({
        method: "POST",
        url: "/api/auth/setup-owner",
        payload: {
          username: "owner",
          password: "owner-password",
          displayName: "Owner",
        },
      });
      expect(missing.statusCode).toBe(403);

      const wrong = await protectedApp.inject({
        method: "POST",
        url: "/api/auth/setup-owner",
        payload: {
          username: "owner",
          password: "owner-password",
          displayName: "Owner",
          setupToken: "wrong-token",
        },
      });
      expect(wrong.statusCode).toBe(403);

      const client: TestClient = { app: protectedApp, cookies: new Map() };
      const created = await request(client, {
        method: "POST",
        url: "/api/auth/setup-owner",
        payload: {
          username: "owner",
          password: "owner-password",
          displayName: "Owner",
          setupToken: "setup-token-for-tests",
        },
      });
      expect(created.statusCode).toBe(200);
      expect(client.cookies.get("ds_session")).toBeTruthy();
    } finally {
      await protectedApp.close();
    }
  });

  it("adds browser security headers and HSTS on trusted HTTPS requests", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toBeUndefined();

    const secureApp = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: true,
        trustProxy: true,
        logger: false,
        updateCheck: false,
      },
    });
    try {
      const secure = await secureApp.inject({
        method: "GET",
        url: "/api/health",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(secure.headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains",
      );
    } finally {
      await secureApp.close();
    }
  });

  it("applies progressive login backoff and exposes failed attempts in the audit log", async () => {
    const owner = await setupOwner(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "owner", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "owner-password" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const auditResponse = await request(owner, {
      method: "GET",
      url: "/api/admin/audit-log?limit=20",
    });
    const actions = json<{ events: Array<{ action: string }> }>(auditResponse).events.map(
      (event) => event.action,
    );
    expect(actions).toContain("auth.login.failed");
    expect(actions).toContain("auth.login.blocked");
  });

  it("supports TOTP enrollment and requires the authenticator code on login", async () => {
    const owner = await setupOwner(app);
    const enrollmentResponse = await request(owner, {
      method: "POST",
      url: "/api/auth/totp/enroll",
      csrf: true,
    });
    expect(enrollmentResponse.statusCode).toBe(200);
    const enrollment = json<{ secret: string; otpauthUrl: string }>(enrollmentResponse);
    expect(enrollment.otpauthUrl).toContain("otpauth://totp/");
    const code = currentTotp(enrollment.secret);
    const confirmed = await request(owner, {
      method: "POST",
      url: "/api/auth/totp/confirm",
      csrf: true,
      payload: { code },
    });
    expect(confirmed.statusCode).toBe(200);

    const missing = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "owner-password" },
    });
    expect(missing.statusCode).toBe(401);
    expect(json<{ error: string }>(missing).error).toBe("Two-factor code required.");

    const signedIn = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "owner-password", totpCode: currentTotp(enrollment.secret) },
    });
    expect(signedIn.statusCode).toBe(200);
  });

  it("revokes every account session with one sign-out-all action", async () => {
    const owner = await setupOwner(app);
    const second = await login(app, "owner", "owner-password");
    const revoked = await request(owner, {
      method: "POST",
      url: "/api/auth/sessions/revoke-all",
      csrf: true,
      payload: { includeCurrent: true },
    });
    expect(revoked.statusCode).toBe(200);
    expect(json<{ revoked: number }>(revoked).revoked).toBe(2);
    expect((await request(owner, { method: "GET", url: "/api/auth/session" })).statusCode).toBe(401);
    expect((await request(second, { method: "GET", url: "/api/auth/session" })).statusCode).toBe(401);
  });

  it("optionally binds sessions to the User-Agent that created them", async () => {
    const boundApp = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        setupToken: null,
        cookieSecure: false,
        bindSessionUserAgent: true,
        logger: false,
        updateCheck: false,
      },
    });
    const client: TestClient = { app: boundApp, cookies: new Map() };
    try {
      const created = await request(client, {
        method: "POST",
        url: "/api/auth/setup-owner",
        headers: { "user-agent": "Browser A" },
        payload: { username: "owner", password: "owner-password", displayName: "Owner" },
      });
      expect(created.statusCode).toBe(200);
      const changed = await request(client, {
        method: "GET",
        url: "/api/auth/session",
        headers: { "user-agent": "Browser B" },
      });
      expect(changed.statusCode).toBe(401);
    } finally {
      await boundApp.close();
    }
  });

  it("requires every viewer profile to have a password in public mode", async () => {
    const publicApp = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        setupToken: null,
        cookieSecure: false,
        publicMode: true,
        logger: false,
        updateCheck: false,
      },
    });
    try {
      const owner = await setupOwner(publicApp);
      const missing = await request(owner, {
        method: "POST",
        url: "/api/account/profiles",
        csrf: true,
        payload: { displayName: "Guest", simpleMode: true },
      });
      expect(missing.statusCode).toBe(400);
      const created = await request(owner, {
        method: "POST",
        url: "/api/account/profiles",
        csrf: true,
        payload: { displayName: "Guest", password: "guest-password", simpleMode: true },
      });
      expect(created.statusCode).toBe(200);
      const state = await request(owner, { method: "GET", url: "/api/account/profiles" });
      const guest = json<{ profiles: Array<{ displayName: string; gateType: string }> }>(state)
        .profiles.find((profile) => profile.displayName === "Guest");
      expect(guest?.gateType).toBe("password");
    } finally {
      await publicApp.close();
    }
  });

  it("exposes profile simpleMode (as a boolean) and lets a profile flip it", async () => {
    const owner = await setupOwner(app);

    // Owner defaults to Advanced (simpleMode false). Assert it's a real boolean
    // so a regression that drops the int→boolean mapping (raw number leak) fails.
    const session1 = await request(owner, { method: "GET", url: "/api/auth/session" });
    const s1 = json<{ session: { profileId: string; simpleMode: boolean } }>(session1).session;
    expect(typeof s1.simpleMode).toBe("boolean");
    expect(s1.simpleMode).toBe(false);

    // Bootstrap carries it too.
    const boot = await request(owner, { method: "GET", url: "/api/bootstrap" });
    expect(json<{ session: { simpleMode: boolean } | null }>(boot).session?.simpleMode).toBe(false);

    // Self-edit: flip simpleMode on the owner's own profile.
    const patch = await request(owner, {
      method: "PATCH",
      url: `/api/profiles/${s1.profileId}`,
      csrf: true,
      payload: { simpleMode: true },
    });
    expect(patch.statusCode).toBe(200);

    // The next session reflects the flip.
    const session2 = await request(owner, { method: "GET", url: "/api/auth/session" });
    expect(json<{ session: { simpleMode: boolean } }>(session2).session.simpleMode).toBe(true);
  });

  it("rate-limits repeated login attempts for the same account and IP", async () => {
    await setupOwner(app);

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          username: "owner",
          password: "wrong-password",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "owner",
        password: "wrong-password",
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(json<{ error: string }>(limited).error).toMatch(/too many failed login attempts/i);
  });

  it("keeps watchlist and history isolated per profile", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "bob", "bob-password");
    const bob = await login(app, "bob", "bob-password");

    const ownerWatch = await request(owner, {
      method: "PUT",
      url: "/api/library/watchlist/tt-shared",
      csrf: true,
      payload: { preview: { id: "tt-shared", title: "Owner version" } },
    });
    expect(ownerWatch.statusCode).toBe(200);

    const bobWatch = await request(bob, {
      method: "PUT",
      url: "/api/library/watchlist/tt-shared",
      csrf: true,
      payload: { preview: { id: "tt-shared", title: "Bob version" } },
    });
    expect(bobWatch.statusCode).toBe(200);

    const ownerHistory = await request(owner, {
      method: "PUT",
      url: "/api/history/tt-shared",
      csrf: true,
      payload: {
        progressSeconds: 10,
        durationSeconds: 100,
        completed: false,
        preview: { id: "tt-shared", title: "Owner version" },
      },
    });
    expect(ownerHistory.statusCode).toBe(200);

    const bobHistory = await request(bob, {
      method: "PUT",
      url: "/api/history/tt-shared",
      csrf: true,
      payload: {
        progressSeconds: 90,
        durationSeconds: 100,
        completed: true,
        preview: { id: "tt-shared", title: "Bob version" },
      },
    });
    expect(bobHistory.statusCode).toBe(200);

    const ownerWatchlist = json<{ items: Array<{ preview: { title: string } }> }>(
      await request(owner, { method: "GET", url: "/api/library/watchlist" }),
    );
    const bobWatchlist = json<{ items: Array<{ preview: { title: string } }> }>(
      await request(bob, { method: "GET", url: "/api/library/watchlist" }),
    );
    expect(ownerWatchlist.items).toHaveLength(1);
    expect(bobWatchlist.items).toHaveLength(1);
    expect(ownerWatchlist.items[0]?.preview.title).toBe("Owner version");
    expect(bobWatchlist.items[0]?.preview.title).toBe("Bob version");

    const ownerHist = json<{ items: Array<{ progressSeconds: number; completed: boolean }> }>(
      await request(owner, { method: "GET", url: "/api/history" }),
    );
    const bobHist = json<{ items: Array<{ progressSeconds: number; completed: boolean }> }>(
      await request(bob, { method: "GET", url: "/api/history" }),
    );
    expect(ownerHist.items[0]).toMatchObject({ progressSeconds: 10, completed: false });
    expect(bobHist.items[0]).toMatchObject({ progressSeconds: 90, completed: true });
  });

  it("returns the newest 20 continue-watching rows at the strict resume boundaries", async () => {
    const owner = await setupOwner(app);
    const saveHistory = async (
      mediaId: string,
      progressSeconds: number,
      durationSeconds: number | null,
      minute: number,
      completed = false,
    ) => {
      const response = await request(owner, {
        method: "PUT",
        url: `/api/history/${mediaId}`,
        csrf: true,
        payload: {
          progressSeconds,
          durationSeconds,
          completed,
          lastWatched: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
          preview: { id: mediaId, type: "movie", title: mediaId },
        },
      });
      expect(response.statusCode).toBe(200);
    };

    for (let index = 0; index < 25; index += 1) {
      await saveHistory(`resume-${index}`, 50, 100, index);
    }
    await saveHistory("under-95", 94.9999, 100, 25);
    await saveHistory("over-2", 2.0001, 100, 26);
    await saveHistory("at-2", 2, 100, 27);
    await saveHistory("at-95", 95, 100, 28);
    await saveHistory("viewed-only", 0, null, 29);
    await saveHistory("completed-midway", 50, 100, 30, true);

    const response = await request(owner, {
      method: "GET",
      url: "/api/history?view=continue-watching&limit=200",
    });
    expect(response.statusCode).toBe(200);
    const body = json<{
      view: string;
      items: Array<{ mediaId: string }>;
    }>(response);
    expect(body.view).toBe("continue-watching");
    expect(body.items.map((item) => item.mediaId)).toEqual([
      "over-2",
      "under-95",
      ...Array.from({ length: 18 }, (_, index) => `resume-${24 - index}`),
    ]);
    expect(body.items).toHaveLength(20);
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(65_536);

    const normal = json<{ view?: string; items: Array<{ mediaId: string }> }>(
      await request(owner, { method: "GET", url: "/api/history?limit=3" }),
    );
    expect(normal.view).toBeUndefined();
    expect(normal.items.map((item) => item.mediaId)).toEqual([
      "completed-midway",
      "viewed-only",
      "at-95",
    ]);
  });

  it("keeps the continue-watching response within 64 KiB as a newest prefix", async () => {
    const owner = await setupOwner(app);
    const newestFirst = Array.from({ length: 20 }, (_, index) => `large-${19 - index}`);
    for (let index = 0; index < 20; index += 1) {
      const mediaId = `large-${index}`;
      const response = await request(owner, {
        method: "PUT",
        url: `/api/history/${mediaId}`,
        csrf: true,
        payload: {
          progressSeconds: 50,
          durationSeconds: 100,
          completed: false,
          lastWatched: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
          preview: { id: mediaId, type: "movie", title: "x".repeat(6_000) },
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const response = await request(owner, {
      method: "GET",
      url: "/api/history?view=continue-watching&limit=20",
    });
    const body = json<{ view: string; items: Array<{ mediaId: string }> }>(response);
    const ids = body.items.map((item) => item.mediaId);

    expect(response.statusCode).toBe(200);
    expect(body.view).toBe("continue-watching");
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(65_536);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
    expect(ids).toEqual(newestFirst.slice(0, ids.length));
  });

  it("does not audit routine resume-position updates", async () => {
    const owner = await setupOwner(app);
    const before = json<{ events: Array<{ action: string }> }>(
      await request(owner, { method: "GET", url: "/api/admin/audit-log" }),
    ).events;

    const response = await request(owner, {
      method: "PUT",
      url: "/api/history/tt-resume",
      csrf: true,
      payload: {
        progressSeconds: 30,
        durationSeconds: 120,
        completed: false,
        preview: { id: "tt-resume", title: "Resume title" },
      },
    });
    expect(response.statusCode).toBe(200);

    const after = json<{ events: Array<{ action: string }> }>(
      await request(owner, { method: "GET", url: "/api/admin/audit-log" }),
    ).events;
    expect(after).toEqual(before);
    expect(after.some((event) => event.action === "history.upsert")).toBe(false);
  });

  it("caps the admin health audit-event count at 10,000", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "debridstreamer-health-test-"));
    const databasePath = join(tempDir, "database.sqlite");
    const healthApp = await buildApp({
      config: {
        databasePath,
        dataDir: tempDir,
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: true,
      },
    });
    let database: DatabaseSync | null = null;
    try {
      const owner = await setupOwner(healthApp);
      database = new DatabaseSync(databasePath);
      database.exec("DELETE FROM audit_log");
      const insert = database.prepare(
        `INSERT INTO audit_log
         (id, actor_user_id, actor_profile_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?, NULL, NULL, 'test', NULL, NULL, NULL, ?)`,
      );
      const createdAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 9_999; i += 1) insert.run(`audit-${i}`, createdAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const belowCap = json<{ counts: { auditEvents: number } }>(
        await request(owner, { method: "GET", url: "/api/admin/health" }),
      );
      expect(belowCap.counts.auditEvents).toBe(9_999);

      insert.run("audit-9999", createdAt);
      insert.run("audit-10000", createdAt);
      const atCap = json<{ counts: { auditEvents: number } }>(
        await request(owner, { method: "GET", url: "/api/admin/health" }),
      );
      expect(atCap.counts.auditEvents).toBe(10_000);
    } finally {
      database?.close();
      await healthApp.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports the active hardware transcoder and playback capability matrix", async () => {
    const hardwareApp = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: true,
        enableTranscode: true,
        transcodeVideoEncoder: "h264_nvenc",
      },
      transcoder: {
        ...makeFakeTranscoder(),
        async capabilities() {
          return {
            toneMapping: true,
            videoEncoders: ["libx264", "h264_nvenc"],
            subtitleSidecar: true,
          };
        },
      },
    });
    try {
      const owner = await setupOwner(hardwareApp);
      const health = json<{
        transcode: {
          enabled: boolean;
          ready: boolean;
          configuredEncoder: string;
          activeEncoder: string | null;
          availableVideoEncoders: string[];
          adaptive: boolean;
          seekOffset: boolean;
          subtitleSidecar: boolean;
          toneMapping: boolean;
        };
      }>(
        await request(owner, {
          method: "GET",
          url: "/api/admin/health",
        }),
      );
      expect(health.transcode).toEqual({
        enabled: true,
        ready: true,
        configuredEncoder: "h264_nvenc",
        activeEncoder: "h264_nvenc",
        availableVideoEncoders: ["libx264", "h264_nvenc"],
        adaptive: true,
        seekOffset: true,
        subtitleSidecar: true,
        toneMapping: true,
      });
    } finally {
      await hardwareApp.close();
    }
  });

  it("seeds system folders and supports folder + entry CRUD with DexieStore parity", async () => {
    const owner = await setupOwner(app);

    // System folders are seeded lazily on first read: 3 roots + Watched + Release Wait.
    const folders0 = json<{
      folders: Array<{ id: string; folderKind: string; isSystem: boolean; name: string }>;
    }>(await request(owner, { method: "GET", url: "/api/library/folders" })).folders;
    expect(folders0.map((f) => f.folderKind).sort()).toEqual([
      "release_wait",
      "system_root",
      "system_root",
      "system_root",
      "watched",
    ]);
    expect(folders0.every((f) => f.isSystem)).toBe(true);
    const favRootId = folders0.find((f) => f.folderKind === "system_root" && f.name === "Library")!.id;

    // No CSRF → 403 on a write.
    expect(
      (await request(owner, { method: "PUT", url: "/api/library/m1", payload: { listType: "favorites", preview: { id: "m1" } } })).statusCode,
    ).toBe(403);

    // Create folder under favorites (manual, non-system).
    const created = json<{ folder: { id: string; name: string; folderKind: string; isSystem: boolean } }>(
      await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Action", listType: "favorites" } }),
    ).folder;
    expect(created).toMatchObject({ name: "Action", folderKind: "manual", isSystem: false });
    const actionId = created.id;

    // Duplicate name disambiguates to "Action (2)".
    expect(
      json<{ folder: { name: string } }>(
        await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Action", listType: "favorites" } }),
      ).folder.name,
    ).toBe("Action (2)");

    // Folders unsupported for watchlist.
    expect(
      (await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "x", listType: "watchlist" } })).statusCode,
    ).toBe(400);

    // Add to the manual folder; add another with no folderId → defaults to favorites root.
    const e1 = json<{ entry: { id: string; folderId: string } }>(
      await request(owner, { method: "PUT", url: "/api/library/m1", csrf: true, payload: { listType: "favorites", folderId: actionId, preview: { id: "m1", title: "M1" } } }),
    ).entry;
    expect(e1.folderId).toBe(actionId);
    const e3 = json<{ entry: { folderId: string } }>(
      await request(owner, { method: "PUT", url: "/api/library/m3", csrf: true, payload: { listType: "favorites", preview: { id: "m3" } } }),
    ).entry;
    expect(e3.folderId).toBe(favRootId);

    // Dedup + COALESCE: re-add m1 to the same folder updates in place; addedAt preserved.
    const e1b = json<{ entry: { id: string; customListName: string | null } }>(
      await request(owner, { method: "PUT", url: "/api/library/m1", csrf: true, payload: { listType: "favorites", folderId: actionId, customListName: "Fav", preview: { id: "m1", title: "M1b" } } }),
    ).entry;
    expect(e1b.id).toBe(e1.id);
    expect(e1b.customListName).toBe("Fav");

    // An explicit addedAt on re-add wins (DexieStore parity); omitting it keeps
    // the existing value (already covered by the m1 dedup above).
    expect(
      json<{ entry: { addedAt: string } }>(
        await request(owner, { method: "PUT", url: "/api/library/m3", csrf: true, payload: { listType: "favorites", addedAt: "2030-01-01T00:00:00.000Z", preview: { id: "m3" } } }),
      ).entry.addedAt,
    ).toBe("2030-01-01T00:00:00.000Z");
    expect(
      json<{ items: Array<{ mediaId: string }> }>(
        await request(owner, { method: "GET", url: "/api/library?listType=favorites" }),
      ).items.map((e) => e.mediaId).sort(),
    ).toEqual(["m1", "m3"]);

    // Remove an entry.
    await request(owner, { method: "DELETE", url: `/api/library/entry/${e1.id}`, csrf: true });
    expect(
      json<{ items: Array<{ mediaId: string }> }>(
        await request(owner, { method: "GET", url: "/api/library?listType=favorites" }),
      ).items.map((e) => e.mediaId),
    ).toEqual(["m3"]);

    // Delete system folder → 400; delete manual → 200; delete missing → 200 (no-op).
    expect((await request(owner, { method: "DELETE", url: `/api/library/folders/${favRootId}`, csrf: true })).statusCode).toBe(400);
    expect((await request(owner, { method: "DELETE", url: `/api/library/folders/${actionId}`, csrf: true })).statusCode).toBe(200);
    expect((await request(owner, { method: "DELETE", url: "/api/library/folders/nope", csrf: true })).statusCode).toBe(200);
  });

  it("re-parents entries to the system root on folder delete, deduping collisions", async () => {
    const owner = await setupOwner(app);
    const favRootId = json<{ folders: Array<{ id: string; folderKind: string }> }>(
      await request(owner, { method: "GET", url: "/api/library/folders?listType=favorites" }),
    ).folders.find((f) => f.folderKind === "system_root")!.id;
    const actionId = json<{ folder: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Action", listType: "favorites" } }),
    ).folder.id;

    // m1 lives in both Action and the root (collision); m9 only in Action.
    await request(owner, { method: "PUT", url: "/api/library/m1", csrf: true, payload: { listType: "favorites", folderId: actionId, preview: { id: "m1" } } });
    await request(owner, { method: "PUT", url: "/api/library/m1", csrf: true, payload: { listType: "favorites", folderId: favRootId, preview: { id: "m1" } } });
    await request(owner, { method: "PUT", url: "/api/library/m9", csrf: true, payload: { listType: "favorites", folderId: actionId, preview: { id: "m9" } } });

    await request(owner, { method: "DELETE", url: `/api/library/folders/${actionId}`, csrf: true });

    const items = json<{ items: Array<{ mediaId: string; folderId: string }> }>(
      await request(owner, { method: "GET", url: "/api/library?listType=favorites" }),
    ).items;
    expect(items.filter((e) => e.mediaId === "m1")).toHaveLength(1); // collision deduped
    expect(items.find((e) => e.mediaId === "m9")?.folderId).toBe(favRootId); // re-parented
  });

  it("isolates library + folders per profile (no IDOR)", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "carol", "carol-password");
    const carol = await login(app, "carol", "carol-password");

    const fA = json<{ folder: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Owner Folder", listType: "favorites" } }),
    ).folder;
    const eA = json<{ entry: { id: string } }>(
      await request(owner, { method: "PUT", url: "/api/library/o1", csrf: true, payload: { listType: "favorites", folderId: fA.id, preview: { id: "o1" } } }),
    ).entry;

    // Carol sees none of owner's rows.
    expect(json<{ items: unknown[] }>(await request(carol, { method: "GET", url: "/api/library?listType=favorites" })).items).toHaveLength(0);
    expect(
      json<{ folders: Array<{ name: string }> }>(await request(carol, { method: "GET", url: "/api/library/folders?listType=favorites" })).folders.some((f) => f.name === "Owner Folder"),
    ).toBe(false);
    expect(json<{ items: unknown[] }>(await request(carol, { method: "GET", url: `/api/library/folder/${fA.id}` })).items).toHaveLength(0);

    // Carol's deletes can't touch owner's rows.
    await request(carol, { method: "DELETE", url: `/api/library/entry/${eA.id}`, csrf: true });
    await request(carol, { method: "DELETE", url: `/api/library/folders/${fA.id}`, csrf: true });
    expect(json<{ items: unknown[] }>(await request(owner, { method: "GET", url: "/api/library?listType=favorites" })).items).toHaveLength(1);
    expect(
      json<{ folders: Array<{ name: string }> }>(await request(owner, { method: "GET", url: "/api/library/folders?listType=favorites" })).folders.some((f) => f.name === "Owner Folder"),
    ).toBe(true);
  });

  it("saveFolder validates parentId: unknown or cross-profile → 400 (no 500, no IDOR re-parent)", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "dave", "dave-password");
    const dave = await login(app, "dave", "dave-password");

    const ownerFolderId = json<{ folder: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Owner", listType: "favorites" } }),
    ).folder.id;
    const daveFolderId = json<{ folder: { id: string } }>(
      await request(dave, { method: "POST", url: "/api/library/folders", csrf: true, payload: { name: "Dave", listType: "favorites" } }),
    ).folder.id;

    const saveBody = (parentId: string | null) => ({
      name: "Renamed",
      parentId,
      listType: "favorites",
      folderKind: "manual",
      isSystem: false,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    // Unknown parent → clean 400 (not a raw FK 500).
    expect(
      (await request(dave, { method: "PUT", url: `/api/library/folders/${daveFolderId}`, csrf: true, payload: saveBody("does-not-exist") })).statusCode,
    ).toBe(400);
    // Another profile's folder as parent → 400 (no cross-profile re-parent).
    expect(
      (await request(dave, { method: "PUT", url: `/api/library/folders/${daveFolderId}`, csrf: true, payload: saveBody(ownerFolderId) })).statusCode,
    ).toBe(400);
    // Valid same-profile rename (no parent) → 200.
    expect(
      (await request(dave, { method: "PUT", url: `/api/library/folders/${daveFolderId}`, csrf: true, payload: saveBody(null) })).statusCode,
    ).toBe(200);
  });

  it("server AI recommend: requires a key, enforces auth + CSRF, and parses provider output", async () => {
    const owner = await setupOwner(app);

    // No AI credential configured → 400 with the configure message.
    const noKey = await request(owner, {
      method: "POST",
      url: "/api/ai/recommend",
      csrf: true,
      payload: { prompt: "cozy mysteries" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(json<{ error: string }>(noKey).error).toMatch(/configure an ai provider/i);

    // Missing CSRF → 403; unauthenticated → 401.
    expect(
      (await request(owner, { method: "POST", url: "/api/ai/recommend", payload: { prompt: "x" } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/ai/recommend", payload: { prompt: "x" } })).statusCode,
    ).toBe(401);

    // Store a server-wide Anthropic key and stub the upstream. The stub echoes the
    // x-api-key it received back as the recommendation title, so the assertion also
    // proves which credential the server selected.
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk-server", label: "AI" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const text = JSON.stringify({
          recommendations: [{ title: `key:${headers["x-api-key"]}`, year: 2014, reason: "r", score: 0.9 }],
        });
        return new Response(
          JSON.stringify({ content: [{ type: "text", text }], model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 7 } }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const ok = await request(owner, {
        method: "POST",
        url: "/api/ai/recommend",
        csrf: true,
        payload: { prompt: "mind-bending sci-fi" },
      });
      expect(ok.statusCode).toBe(200);
      const recs = json<{ recommendations: Array<{ title: string; year: number }> }>(ok).recommendations;
      expect(recs).toHaveLength(1);
      expect(recs[0].title).toBe("key:sk-server");
      expect(recs[0].year).toBe(2014);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server AI: a profile-scoped key overrides the server key for that profile only", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "carol", "carol-password");
    const carol = await login(app, "carol", "carol-password");

    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk-server", label: "AI" },
    });
    await request(carol, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk-carol", label: "AI" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const text = JSON.stringify({
          recommendations: [{ title: headers["x-api-key"], year: 2000, reason: "r", score: 0.5 }],
        });
        return new Response(JSON.stringify({ content: [{ type: "text", text }], model: "m" }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const ownerTitle = json<{ recommendations: Array<{ title: string }> }>(
        await request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x" } }),
      ).recommendations[0].title;
      const carolTitle = json<{ recommendations: Array<{ title: string }> }>(
        await request(carol, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x" } }),
      ).recommendations[0].title;
      expect(ownerTitle).toBe("sk-server"); // owner falls back to the shared server key
      expect(carolTitle).toBe("sk-carol"); // carol's profile override wins for carol
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server AI: maps an upstream provider failure to 502", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk", label: "AI" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) return new Response("upstream boom", { status: 500 });
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x" } });
      expect(res.statusCode).toBe(502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server AI curate: resolves AI titles via TMDB and counts unmatched", async () => {
    const owner = await setupOwner(app);
    for (const cred of [
      { provider: "anthropic", value: "sk", label: "AI" },
      { provider: "tmdb", value: "tmdb-key", label: "TMDB" },
    ]) {
      await request(owner, { method: "PUT", url: "/api/admin/credentials", csrf: true, payload: cred });
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://api.anthropic.com")) {
        const text = JSON.stringify({
          recommendations: [
            { title: "Inception", year: 2010, reason: "r", score: 0.9 },
            { title: "Nonexistent Film 9000", year: 1900, reason: "r", score: 0.4 },
          ],
        });
        return new Response(JSON.stringify({ content: [{ type: "text", text }], model: "m" }), { status: 200 });
      }
      if (u.startsWith("https://api.themoviedb.org")) {
        const query = new URL(u).searchParams.get("query") ?? "";
        const results = query.startsWith("Inception")
          ? [{ id: 27205, media_type: "movie", title: "Inception", release_date: "2010-07-16", poster_path: "/p.jpg", vote_average: 8.3 }]
          : [];
        return new Response(JSON.stringify({ page: 1, total_pages: 1, total_results: results.length, results }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, { method: "POST", url: "/api/ai/curate", csrf: true, payload: { prompt: "heist" } });
      expect(res.statusCode).toBe(200);
      const out = json<{ items: Array<{ id: string; title: string }>; unmatched: number }>(res);
      expect(out.items).toHaveLength(1);
      expect(out.items[0].title).toBe("Inception");
      expect(out.items[0].id).toBe("tmdb-27205");
      expect(out.unmatched).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server metadata: reuses TMDB catalog reads across HTTP requests", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "tmdb", value: "tmdb-key", label: "TMDB" },
    });

    const originalFetch = globalThis.fetch;
    let tmdbCalls = 0;
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://api.themoviedb.org")) {
        tmdbCalls += 1;
        const parsed = new URL(u);
        const isTV = parsed.pathname.includes("/tv/");
        const item = isTV
          ? {
              id: 2000 + tmdbCalls,
              name: "Cached Series",
              first_air_date: "2026-01-01",
              backdrop_path: "/series.jpg",
              vote_average: 7.4,
            }
          : {
              id: 1000 + tmdbCalls,
              title: "Cached Movie",
              release_date: "2026-01-01",
              backdrop_path: "/movie.jpg",
              vote_average: 8.1,
            };
        return new Response(
          JSON.stringify({
            page: 1,
            total_pages: 1,
            total_results: 1,
            results: [item],
          }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    try {
      const first = await request(owner, { method: "GET", url: "/api/discover/home" });
      expect(first.statusCode).toBe(200);
      expect(tmdbCalls).toBe(6);

      const second = await request(owner, { method: "GET", url: "/api/discover/home" });
      expect(second.statusCode).toBe(200);
      expect(tmdbCalls).toBe(6);
      expect(json<{ hero: { title: string } | null }>(second).hero?.title).toBe("Cached Movie");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server calendar: returns cached TMDB movie release dates", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "tmdb", value: "tmdb-key", label: "TMDB" },
    });

    const originalFetch = globalThis.fetch;
    let tmdbCalls = 0;
    globalThis.fetch = (async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "api.themoviedb.org") {
        tmdbCalls += 1;
        const upcoming = parsed.pathname.endsWith("/upcoming");
        return new Response(JSON.stringify({
          page: 1,
          total_pages: 1,
          total_results: 1,
          results: [{
            id: upcoming ? 2 : 1,
            title: upcoming ? "Future Movie" : "Recent Movie",
            release_date: upcoming ? "2026-07-04" : "2026-06-10",
          }],
        }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    try {
      const first = await request(owner, { method: "GET", url: "/api/calendar/movies" });
      expect(first.statusCode).toBe(200);
      expect(json<{ releases: Array<{ releaseDate: string }> }>(first).releases).toHaveLength(2);
      expect(tmdbCalls).toBe(2);

      const second = await request(owner, { method: "GET", url: "/api/calendar/movies" });
      expect(second.statusCode).toBe(200);
      expect(tmdbCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server calendar: rejects more than 30 series", async () => {
    const owner = await setupOwner(app);
    const response = await request(owner, {
      method: "POST",
      url: "/api/calendar/upcoming",
      csrf: true,
      payload: {
        series: Array.from({ length: 31 }, (_, index) => ({
          id: `series-${index + 1}`,
          type: "series",
          title: `Series ${index + 1}`,
          tmdbId: index + 1,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("server AI recommend: enforces the count bounds (1..20)", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk", label: "AI" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) {
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ recommendations: [] }) }], model: "m" }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const recommend = (count: number) =>
        request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x", count } });
      expect((await recommend(0)).statusCode).toBe(400); // below min
      expect((await recommend(21)).statusCode).toBe(400); // above max
      expect((await recommend(1)).statusCode).toBe(200); // min ok
      expect((await recommend(20)).statusCode).toBe(200); // max ok
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server AI: falls back to a guarded Ollama endpoint when no cloud key is set", async () => {
    const owner = await setupOwner(app);
    // Only an Ollama endpoint configured → selectProvider must pick ollama. The
    // app is built with allowRawStreamUrls:true (see beforeEach), so the SSRF
    // guard permits the loopback endpoint.
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "ollama", value: "http://127.0.0.1:11434/api/chat", label: "Ollama" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("http://127.0.0.1:11434")) {
        // Ollama's chat shape: the provider reads message.content.
        const text = JSON.stringify({ recommendations: [{ title: "Local Pick", year: 2024, reason: "r", score: 0.7 }] });
        return new Response(JSON.stringify({ message: { role: "assistant", content: text } }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x" } });
      expect(res.statusCode).toBe(200);
      const recs = json<{ recommendations: Array<{ title: string }> }>(res).recommendations;
      expect(recs).toHaveLength(1);
      expect(recs[0].title).toBe("Local Pick");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server AI: the Ollama SSRF guard blocks an internal endpoint when raw URLs are off", async () => {
    // A locked-down deployment (allowRawStreamUrls:false) must not let an Ollama
    // endpoint pointing at the cloud-metadata address reach the internal network.
    const hardened = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: false,
      },
    });
    try {
      const owner = await setupOwner(hardened);
      await request(owner, {
        method: "PUT",
        url: "/api/admin/credentials",
        csrf: true,
        payload: { provider: "ollama", value: "http://169.254.169.254/api/chat", label: "Ollama" },
      });
      // The guard throws before any fetch; mapped to a generic 502 (no detail leak).
      const res = await request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "x" } });
      expect(res.statusCode).toBe(502);
    } finally {
      await hardened.close();
    }
  });

  it("server subtitles search: requires a key, enforces auth + CSRF, and parses results", async () => {
    const owner = await setupOwner(app);

    const noKey = await request(owner, {
      method: "POST",
      url: "/api/subtitles/search",
      csrf: true,
      payload: { imdbId: "tt1375666" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(json<{ error: string }>(noKey).error).toMatch(/configure an opensubtitles/i);

    expect(
      (await request(owner, { method: "POST", url: "/api/subtitles/search", payload: { imdbId: "tt1" } })).statusCode,
    ).toBe(403); // no CSRF
    expect(
      (await app.inject({ method: "POST", url: "/api/subtitles/search", payload: { imdbId: "tt1" } })).statusCode,
    ).toBe(401); // unauthenticated

    // A search with neither imdbId nor query → 400 (zod refine).
    expect(
      (await request(owner, { method: "POST", url: "/api/subtitles/search", csrf: true, payload: { languages: ["en"] } })).statusCode,
    ).toBe(400);

    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "opensubtitles", value: "os-key", label: "OS" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.opensubtitles.com/api/v1/subtitles")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        // Echo the Api-Key back as the release name to prove credential selection.
        const body = {
          data: [
            { attributes: { language: "en", release: headers["Api-Key"], download_count: 42, files: [{ file_id: 111 }] } },
          ],
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, {
        method: "POST",
        url: "/api/subtitles/search",
        csrf: true,
        payload: { imdbId: "tt1375666", languages: ["en"] },
      });
      expect(res.statusCode).toBe(200);
      const results = json<{ results: Array<{ fileId: string; language: string; release: string }> }>(res).results;
      expect(results).toHaveLength(1);
      expect(results[0].fileId).toBe("111");
      expect(results[0].language).toBe("en");
      expect(results[0].release).toBe("os-key"); // used the stored server key
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server subtitles fetch: downloads, decompresses gzip, and returns decoded VTT", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "opensubtitles", value: "os-key", label: "OS" },
    });

    // A real local server serving a GZIPPED SRT - proves undici auto-decompresses
    // before .text(), then subsrt-ts parses and cuesToVTT runs under Node.
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello world\n";
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-subrip", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(srt)));
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Expected TCP test server.");
    upstreamUrl = `http://127.0.0.1:${address.port}/sub.srt.gz`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.startsWith(upstreamUrl)) return originalFetch(url, init); // real gzip server
      if (u.startsWith("https://api.opensubtitles.com/api/v1/download")) {
        return new Response(JSON.stringify({ link: upstreamUrl }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, {
        method: "POST",
        url: "/api/subtitles/fetch",
        csrf: true,
        payload: { fileId: "111" },
      });
      expect(res.statusCode).toBe(200);
      const vtt = json<{ vtt: string }>(res).vtt;
      expect(vtt.startsWith("WEBVTT")).toBe(true);
      expect(vtt).toContain("Hello world");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server subtitles fetch: returns 422 for an empty/unreadable subtitle", async () => {
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "opensubtitles", value: "os-key", label: "OS" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://api.opensubtitles.com/api/v1/download")) {
        return new Response(JSON.stringify({ link: "https://dl.opensubtitles.example/garbage" }), { status: 200 });
      }
      if (u.startsWith("https://dl.opensubtitles.example/")) {
        return new Response("not a subtitle file - no timestamps here", { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, { method: "POST", url: "/api/subtitles/fetch", csrf: true, payload: { fileId: "111" } });
      expect(res.statusCode).toBe(422);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server subtitles: search is profile-scoped (a profile key overrides, no cross-profile leak)", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "erin", "erin-password");
    const erin = await login(app, "erin", "erin-password");

    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "opensubtitles", value: "os-server", label: "OS" },
    });
    await request(erin, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: { provider: "opensubtitles", value: "os-erin", label: "OS" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.opensubtitles.com/api/v1/subtitles")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = { data: [{ attributes: { language: "en", release: headers["Api-Key"], download_count: 1, files: [{ file_id: 1 }] } }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const releaseFor = async (client: typeof owner) =>
        json<{ results: Array<{ release: string }> }>(
          await request(client, { method: "POST", url: "/api/subtitles/search", csrf: true, payload: { imdbId: "tt1" } }),
        ).results[0].release;
      expect(await releaseFor(owner)).toBe("os-server"); // owner → shared server key
      expect(await releaseFor(erin)).toBe("os-erin"); // erin's profile override wins
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server subtitles translate: requires an AI key and translates cues preserving timing", async () => {
    const owner = await setupOwner(app);
    const cues = [{ start: 1000, end: 2000, text: "Hello world" }];

    const noKey = await request(owner, {
      method: "POST",
      url: "/api/subtitles/translate",
      csrf: true,
      payload: { cues, targetLanguage: "Spanish" },
    });
    expect(noKey.statusCode).toBe(400);
    expect(json<{ error: string }>(noKey).error).toMatch(/configure an ai provider/i);

    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "anthropic", value: "sk", label: "AI" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.anthropic.com")) {
        // Echo the [[0]] marker with translated text, preserving the protocol.
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "[[0]] Hola mundo" }], model: "m" }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await request(owner, {
        method: "POST",
        url: "/api/subtitles/translate",
        csrf: true,
        payload: { cues, targetLanguage: "Spanish" },
      });
      expect(res.statusCode).toBe(200);
      const out = json<{ cues: Array<{ start: number; end: number; text: string }>; providerKind: string }>(res);
      expect(out.providerKind).toBe("anthropic");
      expect(out.cues).toHaveLength(1);
      expect(out.cues[0].text).toBe("Hola mundo"); // translated
      expect(out.cues[0].start).toBe(1000); // timing preserved
      expect(out.cues[0].end).toBe(2000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("server subtitles fetch: SSRF-blocks an internal CDN download link when raw URLs are off", async () => {
    const hardened = await buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: false,
      },
    });
    try {
      const owner = await setupOwner(hardened);
      await request(owner, {
        method: "PUT",
        url: "/api/admin/credentials",
        csrf: true,
        payload: { provider: "opensubtitles", value: "os-key", label: "OS" },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url, init) => {
        if (String(url).startsWith("https://api.opensubtitles.com/api/v1/download")) {
          // A compromised/MITM'd API "returns" a link at the cloud-metadata address.
          return new Response(JSON.stringify({ link: "http://169.254.169.254/latest/meta-data/" }), { status: 200 });
        }
        return originalFetch(url, init);
      }) as typeof fetch;
      try {
        const res = await request(owner, { method: "POST", url: "/api/subtitles/fetch", csrf: true, payload: { fileId: "111" } });
        // The guard refuses the private address before fetching it → 502.
        expect(res.statusCode).toBe(502);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await hardened.close();
    }
  });

  it("server subtitles translate: rate-limits per profile (10/min)", async () => {
    const owner = await setupOwner(app);
    const payload = { cues: [{ start: 0, end: 1000, text: "Hi" }], targetLanguage: "Spanish" };
    // No AI key configured: each call clears the rate limiter then 400s (missing
    // key). The limiter (10/min) trips the 11th call with a 429 before the handler.
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await request(owner, { method: "POST", url: "/api/subtitles/translate", csrf: true, payload });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  // --- Phase 4: title requests + approve/deny queue --------------------------

  it("requests: create + admin queue + approve→shared list, with IDOR + CSRF + dedup", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "mallory", "mallory-password");
    const mallory = await login(app, "mallory", "mallory-password");

    const preview = { id: "tt100", type: "movie", title: "Requested Movie" };
    const created = await request(owner, {
      method: "POST",
      url: "/api/library/requests",
      csrf: true,
      payload: { mediaId: "tt100", preview },
    });
    expect(created.statusCode).toBe(200);
    const req = json<{ request: { id: string; status: string } }>(created).request;
    expect(req.status).toBe("pending");

    const ownList = () => request(owner, { method: "GET", url: "/api/library/requests" });
    const queue = () => request(owner, { method: "GET", url: "/api/admin/requests" });
    expect(json<{ requests: Array<{ id: string }> }>(await ownList()).requests.some((r) => r.id === req.id)).toBe(true);
    expect(json<{ requests: Array<{ id: string }> }>(await queue()).requests.some((r) => r.id === req.id)).toBe(true);

    // Duplicate live pending → 409.
    expect(
      (await request(owner, { method: "POST", url: "/api/library/requests", csrf: true, payload: { mediaId: "tt100", preview } })).statusCode,
    ).toBe(409);

    // IDOR / authz: a different account sees none of it; non-admin is blocked.
    expect(json<{ requests: unknown[] }>(await request(mallory, { method: "GET", url: "/api/library/requests" })).requests).toHaveLength(0);
    expect((await request(mallory, { method: "GET", url: "/api/admin/requests" })).statusCode).toBe(403);
    expect((await request(mallory, { method: "POST", url: `/api/admin/requests/${req.id}/approve`, csrf: true })).statusCode).toBe(403);
    // CSRF required on approve.
    expect((await request(owner, { method: "POST", url: `/api/admin/requests/${req.id}/approve` })).statusCode).toBe(403);

    // Approve → leaves the pending queue + lands in the shared Requested list.
    expect((await request(owner, { method: "POST", url: `/api/admin/requests/${req.id}/approve`, csrf: true })).statusCode).toBe(200);
    expect(json<{ requests: Array<{ id: string }> }>(await queue()).requests.some((r) => r.id === req.id)).toBe(false);
    expect(
      json<{ items: Array<{ mediaId: string }> }>(await request(owner, { method: "GET", url: "/api/library/requested" })).items.some((i) => i.mediaId === "tt100"),
    ).toBe(true);
    // ...and a different account does not see it.
    expect(json<{ items: unknown[] }>(await request(mallory, { method: "GET", url: "/api/library/requested" })).items).toHaveLength(0);
    // Approving an already-decided request → 404.
    expect((await request(owner, { method: "POST", url: `/api/admin/requests/${req.id}/approve`, csrf: true })).statusCode).toBe(404);
  });

  it("requests: a denied title can be re-requested; the deny reason is stored", async () => {
    const owner = await setupOwner(app);
    const preview = { id: "tt200", type: "movie", title: "Denied" };
    const first = json<{ request: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/library/requests", csrf: true, payload: { mediaId: "tt200", preview } }),
    ).request.id;
    expect(
      (await request(owner, { method: "POST", url: `/api/admin/requests/${first}/deny`, csrf: true, payload: { reason: "Too violent" } })).statusCode,
    ).toBe(200);
    // The denial frees the partial-unique slot → a re-request succeeds.
    expect(
      (await request(owner, { method: "POST", url: "/api/library/requests", csrf: true, payload: { mediaId: "tt200", preview } })).statusCode,
    ).toBe(200);
    const denied = json<{ requests: Array<{ id: string; status: string; decisionReason: string | null }> }>(
      await request(owner, { method: "GET", url: "/api/library/requests" }),
    ).requests.find((r) => r.id === first);
    expect(denied?.status).toBe("denied");
    expect(denied?.decisionReason).toBe("Too violent");
  });

  it("requests: an approved title is visible to every profile of the same account", async () => {
    const owner = await setupOwner(app);
    const sub = json<{ profile: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/account/profiles", csrf: true, payload: { displayName: "Kid" } }),
    ).profile.id;
    const id = json<{ request: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/library/requests", csrf: true, payload: { mediaId: "tt300", preview: { id: "tt300", type: "movie", title: "Shared" } } }),
    ).request.id;
    await request(owner, { method: "POST", url: `/api/admin/requests/${id}/approve`, csrf: true });
    // Switch the active profile to the sub-profile; the shared list is account-scoped.
    expect((await request(owner, { method: "POST", url: "/api/profiles/switch", csrf: true, payload: { profileId: sub } })).statusCode).toBe(200);
    expect(
      json<{ items: Array<{ mediaId: string }> }>(await request(owner, { method: "GET", url: "/api/library/requested" })).items.some((i) => i.mediaId === "tt300"),
    ).toBe(true);
  });

  it("kids maturity: hardened lockdown - admin-only, parental switch lock, fail-closed bound play-block, gated browse", async () => {
    const BOUND_HASH = "c".repeat(40); // the within-cap title's one indexer source
    const owner = await setupOwner(app);
    await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: { provider: "tmdb", value: "tmdb-key", label: "TMDB" },
    });

    const ownerDefault = json<{ profiles: Array<{ id: string; isDefault: boolean }> }>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    ).profiles.find((p) => p.isDefault)!.id;

    // Household sub-profile to lock down as a kid.
    const kid = json<{ profile: { id: string } }>(
      await request(owner, { method: "POST", url: "/api/account/profiles", csrf: true, payload: { displayName: "Kiddo" } }),
    ).profile.id;

    // FixF: is_kid and the cap are strictly coupled - neither half-state persists.
    expect(
      (await request(owner, { method: "POST", url: `/api/account/profiles/${kid}/maturity`, csrf: true, payload: { isKid: true, maturityMax: null } })).statusCode,
    ).toBe(400);
    expect(
      (await request(owner, { method: "POST", url: `/api/account/profiles/${kid}/maturity`, csrf: true, payload: { isKid: false, maturityMax: "R" } })).statusCode,
    ).toBe(400);

    // The maturity route is admin-only: a member USER account cannot set it.
    await createProfile(owner, "mallory", "mallory-password", "member");
    const mallory = await login(app, "mallory", "mallory-password");
    const malloryDefault = json<{ profiles: Array<{ id: string; isDefault: boolean }> }>(
      await request(mallory, { method: "GET", url: "/api/account/profiles" }),
    ).profiles.find((p) => p.isDefault)!.id;
    expect(
      (await request(mallory, { method: "POST", url: `/api/account/profiles/${malloryDefault}/maturity`, csrf: true, payload: { isKid: true, maturityMax: "PG" } })).statusCode,
    ).toBe(403);

    // Owner (admin) sets the kid cap to PG.
    const setRes = await request(owner, {
      method: "POST",
      url: `/api/account/profiles/${kid}/maturity`,
      csrf: true,
      payload: { isKid: true, maturityMax: "PG" },
    });
    expect(setRes.statusCode).toBe(200);
    const kidRow = json<{ profiles: Array<{ id: string; isKid: boolean; maturityMax: string | null }> }>(setRes).profiles.find((p) => p.id === kid)!;
    expect(kidRow.isKid).toBe(true);
    expect(kidRow.maturityMax).toBe("PG");

    const j200 = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    const originalFetch = globalThis.fetch;
    let lastDiscoverUrl = "";
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://api.themoviedb.org")) {
        const p = new URL(u).pathname;
        if (p.includes("/find/")) {
          // imdb→tmdb: tt0000NNN → NNN.
          const m = p.match(/\/find\/tt0*(\d+)/);
          const id = m ? Number(m[1]) : 0;
          return j200({ movie_results: id ? [{ id }] : [], tv_results: [] });
        }
        if (p.endsWith("/release_dates")) {
          const id = p.match(/\/movie\/(\d+)\/release_dates/)?.[1] ?? "";
          // 500 → R (over PG); 700 → [PG,R] (strictest R, FixG); else G (within).
          const certs = id === "500" ? ["R"] : id === "700" ? ["PG", "R"] : ["G"];
          return j200({ results: [{ iso_3166_1: "US", release_dates: certs.map((c) => ({ certification: c })) }] });
        }
        if (p.endsWith("/credits") || p.endsWith("/recommendations")) {
          return j200({ cast: [], results: [] });
        }
        if (p.includes("/discover/")) {
          lastDiscoverUrl = u;
          return j200({ page: 1, total_pages: 1, total_results: 0, results: [] });
        }
        const detail = p.match(/\/(movie|tv)\/(\d+)$/);
        if (detail) {
          const id = Number(detail[2]);
          return j200({ id, title: `Title ${id}`, genres: [], external_ids: { imdb_id: `tt${String(id).padStart(7, "0")}` } });
        }
        return j200({ page: 1, total_pages: 1, total_results: 0, results: [], genres: [] });
      }
      const host = new URL(u).hostname;
      if (host === "apibay.org") {
        // The within-cap title's single legitimate source. The binding check
        // (titleHasInfoHash) only ever searches that title here.
        return j200([{ id: "1", name: "Kid Movie 2026 1080p WEB", info_hash: BOUND_HASH, leechers: "1", seeders: "9", size: "1048576" }]);
      }
      if (host === "yts.torrentbay.st") {
        return j200({ status: "ok", data: { movies: [] } });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    try {
      // Switch the owner's session into the kid sub-profile ("who's watching").
      expect((await request(owner, { method: "POST", url: "/api/profiles/switch", csrf: true, payload: { profileId: kid } })).statusCode).toBe(200);
      expect(
        (
          await request(owner, {
            method: "PUT",
            url: "/api/settings/profile",
            csrf: true,
            payload: { key: "built_in_indexers_enabled", value: "true" },
          })
        ).statusCode,
      ).toBe(200);

      // FixA: a kid-active session cannot lift its OWN cap (requireAdmin rejects
      // the kid profile even though the underlying account is the owner).
      expect(
        (await request(owner, { method: "POST", url: `/api/account/profiles/${kid}/maturity`, csrf: true, payload: { isKid: false, maturityMax: null } })).statusCode,
      ).toBe(403);

      // Search is disabled on a kid profile.
      expect((await request(owner, { method: "GET", url: "/api/search?q=batman" })).statusCode).toBe(403);

      // AI discovery (free-text recommend/curate) is closed for kids.
      expect((await request(owner, { method: "POST", url: "/api/ai/recommend", csrf: true, payload: { prompt: "scary movies" } })).statusCode).toBe(403);
      expect((await request(owner, { method: "POST", url: "/api/ai/curate", csrf: true, payload: { prompt: "scary movies" } })).statusCode).toBe(403);

      // Subtitle search: no free-text, and an over-cap imdb is cert-blocked.
      expect((await request(owner, { method: "POST", url: "/api/subtitles/search", csrf: true, payload: { query: "anything" } })).statusCode).toBe(403);
      expect((await request(owner, { method: "POST", url: "/api/subtitles/search", csrf: true, payload: { imdbId: "tt0000500" } })).statusCode).toBe(403);

      // Play-block, all fail-closed (403):
      const resolve = (payload: unknown) =>
        request(owner, { method: "POST", url: "/api/streams/resolve", csrf: true, payload });
      // over-cap (R) title
      expect((await resolve({ infoHash: "a".repeat(40), mediaId: "tmdb-500", mediaType: "movie" })).statusCode).toBe(403);
      // missing media identity
      expect((await resolve({ infoHash: "b".repeat(40) })).statusCode).toBe(403);
      // series (kid browse is movie-only)
      expect((await resolve({ infoHash: BOUND_HASH, mediaId: "tmdb-600", mediaType: "series" })).statusCode).toBe(403);
      // FixC: a within-cap mediaId paired with an UNBOUND (over-cap) infoHash is
      // refused - the infoHash must be a real source of the certified title.
      expect((await resolve({ infoHash: "a".repeat(40), mediaId: "tmdb-600", mediaType: "movie" })).statusCode).toBe(403);
      // Legitimate within-cap play: cert G ✓ AND infoHash is the title's source ✓,
      // so it clears the gate and reaches the debrid check (400, no debrid here).
      expect((await resolve({ infoHash: BOUND_HASH, mediaId: "tmdb-600", mediaType: "movie" })).statusCode).toBe(400);

      // FixD: the raw-session route is closed for kids regardless of role/flag.
      expect(
        (await request(owner, { method: "POST", url: "/api/streams/sessions/raw", csrf: true, payload: { upstreamUrl: "http://127.0.0.1:9/x.mp4" } })).statusCode,
      ).toBe(403);

      // FixE: detail + source-search are cert-gated. Within-cap allowed, over-cap
      // (and a strictest-of-multiple-certs R title, FixG) blocked.
      expect((await request(owner, { method: "GET", url: "/api/media/detail?id=tmdb-600&type=movie" })).statusCode).toBe(200);
      expect((await request(owner, { method: "GET", url: "/api/media/detail?id=tmdb-500&type=movie" })).statusCode).toBe(403);
      expect((await request(owner, { method: "GET", url: "/api/media/detail?id=tmdb-700&type=movie" })).statusCode).toBe(403);
      expect((await request(owner, { method: "GET", url: "/api/streams/tt0000600?type=movie" })).statusCode).toBe(200);
      expect((await request(owner, { method: "GET", url: "/api/streams/tt0000500?type=movie" })).statusCode).toBe(403);

      // FixE: the series-only calendar is closed for kids.
      expect(
        (await request(owner, { method: "POST", url: "/api/calendar/upcoming", csrf: true, payload: { series: [] } })).statusCode,
      ).toBe(403);
      expect(
        json<{ releases: unknown[] }>(await request(owner, { method: "GET", url: "/api/calendar/movies" })).releases,
      ).toEqual([]);

      // The series-only episode-guide routes are closed for kids too (the
      // client degrades to its stepper fallback).
      expect(
        (await request(owner, { method: "GET", url: "/api/media/seasons?tmdbId=1399" })).statusCode,
      ).toBe(403);
      expect(
        (await request(owner, { method: "GET", url: "/api/media/episodes?tmdbId=1399&season=1" })).statusCode,
      ).toBe(403);

      // Browse is forced to cert-capped movie even when the client asks for series.
      const disc = await request(owner, { method: "GET", url: "/api/catalog/discover?type=series&sort_by=popularity.desc" });
      expect(disc.statusCode).toBe(200);
      expect(lastDiscoverUrl).toContain("/discover/movie");
      expect(lastDiscoverUrl).toContain("certification.lte=PG");
      expect(lastDiscoverUrl).toContain("certification_country=US");
      const home = json<{ trendingTV: unknown[] }>(await request(owner, { method: "GET", url: "/api/discover/home" }));
      expect(home.trendingTV).toEqual([]);

      // FixB: leaving a kid profile requires the account password. No password and
      // a wrong password are both refused; the gate holds (search still 403).
      const switchTo = (payload: unknown) =>
        request(owner, { method: "POST", url: "/api/profiles/switch", csrf: true, payload });
      expect((await switchTo({ profileId: ownerDefault })).statusCode).toBe(403);
      expect((await switchTo({ profileId: ownerDefault, password: "wrong" })).statusCode).toBe(403);
      expect((await request(owner, { method: "GET", url: "/api/search?q=batman" })).statusCode).toBe(403);
      // Correct account password unlocks the switch back to the adult profile.
      expect((await switchTo({ profileId: ownerDefault, password: "owner-password" })).statusCode).toBe(200);

      // Episode-guide routes: back on the adult profile, malformed params are
      // rejected by validation (not silently coerced).
      expect(
        (await request(owner, { method: "GET", url: "/api/media/seasons?tmdbId=abc" })).statusCode,
      ).toBe(400);
      expect(
        (await request(owner, { method: "GET", url: "/api/media/episodes?tmdbId=1399" })).statusCode,
      ).toBe(400);
      // Now on the uncapped adult profile, search works again.
      expect((await request(owner, { method: "GET", url: "/api/search?q=batman" })).statusCode).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 20000); // heavy multi-request integration test; 5s default is tight on loaded CI

  it("uses server credentials by default and profile credentials as overrides", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "bob", "bob-password");
    const bob = await login(app, "bob", "bob-password");

    const serverCred = await request(owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      csrf: true,
      payload: {
        provider: "real_debrid",
        label: "Shared RD",
        value: "server-token",
      },
    });
    expect(serverCred.statusCode).toBe(200);

    const bobInherited = json<{
      credentials: Array<{ provider: string; scope: string | null; label: string | null }>;
    }>(await request(bob, { method: "GET", url: "/api/credentials/effective" }));
    expect(bobInherited.credentials.find((c) => c.provider === "real_debrid")).toMatchObject({
      scope: "server",
      label: "Shared RD",
    });

    const profileCred = await request(bob, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: {
        provider: "real_debrid",
        label: "Bob RD",
        value: "bob-token",
      },
    });
    expect(profileCred.statusCode).toBe(200);

    const bobOverride = json<{
      credentials: Array<{ provider: string; scope: string | null; label: string | null }>;
    }>(await request(bob, { method: "GET", url: "/api/credentials/effective" }));
    expect(bobOverride.credentials.find((c) => c.provider === "real_debrid")).toMatchObject({
      scope: "profile",
      label: "Bob RD",
    });

    const ownerEffective = json<{
      credentials: Array<{ provider: string; scope: string | null; label: string | null }>;
    }>(await request(owner, { method: "GET", url: "/api/credentials/effective" }));
    expect(ownerEffective.credentials.find((c) => c.provider === "real_debrid")).toMatchObject({
      scope: "server",
      label: "Shared RD",
    });
  });

  it("searches streams server-side and resolves playback through a profile proxy session", async () => {
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    upstream = createServer((_req, res) => {
      const body = Buffer.from("server-stream");
      res.writeHead(200, {
        "content-length": String(body.length),
        "content-type": "video/mp4",
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Expected TCP test server.");
    upstreamUrl = `http://127.0.0.1:${address.port}/movie.mp4`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const urlString = String(url);
      if (urlString.startsWith(upstreamUrl)) {
        return originalFetch(url, init);
      }
      const parsed = new URL(urlString);
      if (parsed.hostname === "apibay.org") {
        return new Response(
          JSON.stringify([
            {
              id: "1",
              name: "Example.Movie.2026.1080p.WEB-DL.x264",
              info_hash: hash,
              leechers: "1",
              seeders: "12",
              size: "1048576",
            },
          ]),
          { status: 200 },
        );
      }
      if (parsed.hostname === "yts.torrentbay.st") {
        return new Response(
          JSON.stringify({ status: "ok", data: { movies: [] } }),
          { status: 200 },
        );
      }
      if (parsed.hostname === "api.real-debrid.com") {
        if (parsed.pathname.endsWith("/torrents")) {
          return new Response("[]", { status: 200 });
        }
        if (parsed.pathname.endsWith("/torrents/addMagnet")) {
          return new Response(JSON.stringify({ id: "rd-torrent" }), { status: 201 });
        }
        if (parsed.pathname.endsWith("/torrents/info/rd-torrent")) {
          return new Response(
            JSON.stringify({
              status: "downloaded",
              links: ["https://real-debrid.example/restricted-link"],
              files: [
                {
                  id: 1,
                  path: "/Example.Movie.2026.1080p.WEB-DL.x264.mp4",
                  bytes: 1048576,
                  selected: 1,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (parsed.pathname.endsWith("/unrestrict/link")) {
          expect(String(init?.body)).toContain("real-debrid.example");
          return new Response(
            JSON.stringify({ download: upstreamUrl, id: "unrestricted-1" }),
            { status: 200 },
          );
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const owner = await setupOwner(app);
      expect(
        (
          await request(owner, {
            method: "PUT",
            url: "/api/settings/profile",
            csrf: true,
            payload: { key: "built_in_indexers_enabled", value: "true" },
          })
        ).statusCode,
      ).toBe(200);
      const credential = await request(owner, {
        method: "PUT",
        url: "/api/profile/credentials",
        csrf: true,
        payload: {
          provider: "real_debrid",
          label: "Owner RD",
          value: "rd-token",
        },
      });
      expect(credential.statusCode).toBe(200);

      const streams = await request(owner, {
        method: "GET",
        url: "/api/streams/tt1234567?type=movie",
      });
      expect(streams.statusCode).toBe(200);
      const streamBody = json<{
        rows: Array<{ result: { infoHash: string; title: string } }>;
        hasDebrid: boolean;
        hasIndexers: boolean;
      }>(streams);
      expect(streamBody.hasDebrid).toBe(true);
      expect(streamBody.hasIndexers).toBe(true);
      expect(streamBody.rows[0]?.result).toMatchObject({
        infoHash: hash,
        title: "Example.Movie.2026.1080p.WEB-DL.x264",
      });

      const progressiveStreams = await request(owner, {
        method: "GET",
        url: "/api/streams/tt1234567?type=movie&progressive=1",
      });
      expect(progressiveStreams.statusCode).toBe(200);
      expect(progressiveStreams.headers["content-type"]).toContain(
        "application/x-ndjson",
      );
      const streamPhases = progressiveStreams.body
        .trim()
        .split("\n")
        .map((line) =>
          JSON.parse(line) as {
            phase: string;
            rows: Array<{
              cachedOn: string | null;
              cacheStatus: string;
            }>;
          },
        );
      expect(streamPhases.map((phase) => phase.phase)).toEqual([
        "sources",
        "ready",
      ]);
      expect(streamPhases[0]?.rows[0]).toMatchObject({
        cachedOn: null,
        cacheStatus: "unavailable",
      });
      expect(streamPhases[1]?.rows[0]).toMatchObject({
        cachedOn: null,
        cacheStatus: "unavailable",
      });

      const resolved = await request(owner, {
        method: "POST",
        url: "/api/streams/resolve",
        csrf: true,
        payload: { infoHash: hash, preferredService: "real_debrid" },
      });
      expect(resolved.statusCode).toBe(200);
      const resolvedBody = json<{
        stream: {
          streamURL: string;
          debridService: string;
          playbackAuthorization: string;
        };
        session: { playbackUrl: string; playbackAuthorization: string };
      }>(resolved);
      expect(resolvedBody.stream.debridService).toBe("RD");
      expect(resolvedBody.stream.streamURL).toBe(resolvedBody.session.playbackUrl);
      expect(resolvedBody.stream.streamURL).toMatch(/^\/api\/stream\/stream_/);
      expect(resolvedBody.stream.playbackAuthorization).toBe(
        resolvedBody.session.playbackAuthorization,
      );
      expect(resolvedBody.stream.playbackAuthorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
      expect(resolvedBody.stream.streamURL).not.toContain(resolvedBody.stream.playbackAuthorization);

      const playback = await request(owner, {
        method: "GET",
        url: resolvedBody.stream.streamURL,
      });
      expect(playback.statusCode).toBe(200);
      expect(playback.headers["content-type"]).toBe("video/mp4");
      expect(playback.body).toBe("server-stream");

      const nativePlayback = await request({ app, cookies: new Map() }, {
        method: "GET",
        url: resolvedBody.stream.streamURL,
        headers: { authorization: resolvedBody.stream.playbackAuthorization },
      });
      expect(nativePlayback.statusCode).toBe(200);
      expect(nativePlayback.body).toBe("server-stream");

      const rejectedBearer = await request({ app, cookies: new Map() }, {
        method: "GET",
        url: resolvedBody.stream.streamURL,
        headers: { authorization: `Bearer ${"A".repeat(43)}` },
      });
      expect(rejectedBearer.statusCode).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("debrid token test validates server-side (the CORS-blocked-provider path)", async () => {
    const owner = await setupOwner(app);

    const originalFetch = globalThis.fetch;
    let lastAuth = "";
    globalThis.fetch = (async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "api.torbox.app" && parsed.pathname.endsWith("/user/me")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        lastAuth = headers.Authorization ?? headers.authorization ?? "";
        const good = lastAuth === "Bearer tb-good";
        return new Response(
          JSON.stringify(
            good
              ? { success: true, error: null, data: { email: "u@example.com", plan: 1 } }
              : { success: false, error: "BAD_TOKEN", data: null },
          ),
          { status: good ? 200 : 401 },
        );
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    try {
      const good = await request(owner, {
        method: "POST",
        url: "/api/debrid/test",
        csrf: true,
        payload: { service: "torbox", apiToken: "tb-good" },
      });
      expect(good.statusCode).toBe(200);
      expect(json<{ valid: boolean }>(good).valid).toBe(true);

      const bad = await request(owner, {
        method: "POST",
        url: "/api/debrid/test",
        csrf: true,
        payload: { service: "torbox", apiToken: "tb-bad" },
      });
      expect(bad.statusCode).toBe(200);
      expect(json<{ valid: boolean }>(bad).valid).toBe(false);
      expect(lastAuth).toBe("Bearer tb-bad");

      const anonymous: TestClient = { app, cookies: new Map() };
      const rejected = await request(anonymous, {
        method: "POST",
        url: "/api/debrid/test",
        payload: { service: "torbox", apiToken: "tb-good" },
      });
      expect(rejected.statusCode).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("proxies stream sessions with Range support and rejects another profile", async () => {
    upstream = createServer((req, res) => {
      const body = Buffer.from("abcdefghij");
      if (req.headers.range === "bytes=0-3") {
        res.writeHead(206, {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-3/10",
          "content-length": "4",
          "content-type": "text/plain",
        });
        res.end(body.subarray(0, 4));
        return;
      }
      res.writeHead(200, {
        "accept-ranges": "bytes",
        "content-length": String(body.length),
        "content-type": "text/plain",
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Expected TCP test server.");
    upstreamUrl = `http://127.0.0.1:${address.port}/video`;

    const owner = await setupOwner(app);
    await createProfile(owner, "bob", "bob-password");
    const bob = await login(app, "bob", "bob-password");

    const created = await request(owner, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: {
        upstreamUrl,
        contentType: "text/plain",
      },
    });
    expect(created.statusCode).toBe(200);
    const streamSession = json<{
      session: { playbackUrl: string; playbackAuthorization: string };
    }>(created).session;
    const playbackUrl = streamSession.playbackUrl;

    const ownerStream = await request(owner, {
      method: "GET",
      url: playbackUrl,
      headers: { range: "bytes=0-3" },
    });
    expect(ownerStream.statusCode).toBe(206);
    expect(ownerStream.headers["content-range"]).toBe("bytes 0-3/10");
    expect(ownerStream.body).toBe("abcd");

    const bearerStream = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: playbackUrl,
      headers: {
        range: "bytes=0-3",
        authorization: streamSession.playbackAuthorization,
      },
    });
    expect(bearerStream.statusCode).toBe(206);
    expect(bearerStream.body).toBe("abcd");

    const capability = streamSession.playbackAuthorization.replace(/^Bearer\s+/, "");
    const sessionId = playbackUrl.split("/").pop();
    const externalUrl = `/api/external-stream/${sessionId}/${capability}`;
    const externalStream = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: externalUrl,
      headers: { range: "bytes=0-3" },
    });
    expect(externalStream.statusCode).toBe(206);
    expect(externalStream.headers["cache-control"]).toBe("private, no-store");
    expect(externalStream.headers["referrer-policy"]).toBe("no-referrer");
    expect(externalStream.body).toBe("abcd");

    const invalidExternal = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: `/api/external-stream/${sessionId}/${"A".repeat(43)}`,
    });
    expect(invalidExternal.statusCode).toBe(404);

    const secondCreated = await request(owner, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: { upstreamUrl, contentType: "text/plain" },
    });
    const secondPlaybackUrl = json<{ session: { playbackUrl: string } }>(secondCreated).session
      .playbackUrl;
    const wrongStreamBearer = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: secondPlaybackUrl,
      headers: { authorization: streamSession.playbackAuthorization },
    });
    expect(wrongStreamBearer.statusCode).toBe(404);

    const bobStream = await request(bob, {
      method: "GET",
      url: playbackUrl,
    });
    expect(bobStream.statusCode).toBe(404);
  });

  it("kill-switch: admin revokes a stream session and the proxy then refuses it", async () => {
    upstream = createServer((_req, res) => {
      const body = Buffer.from("abcdefghij");
      res.writeHead(200, {
        "accept-ranges": "bytes",
        "content-length": String(body.length),
        "content-type": "text/plain",
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Expected TCP test server.");
    upstreamUrl = `http://127.0.0.1:${address.port}/video`;

    const owner = await setupOwner(app);
    await createProfile(owner, "carol", "carol-password");
    const carol = await login(app, "carol", "carol-password");

    // carol starts a stream session.
    const created = await request(carol, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: { upstreamUrl, contentType: "text/plain" },
    });
    expect(created.statusCode).toBe(200);
    const session = json<{
      session: { id: string; playbackUrl: string; playbackAuthorization: string };
    }>(created).session;

    // The fresh session shows up in the admin active-streams list (a full GET
    // would mark it completed and drop it from the list, so check it first).
    const active = await request(owner, { method: "GET", url: "/api/admin/streams/active" });
    expect(active.statusCode).toBe(200);
    expect(
      json<{ streams: Array<{ id: string }> }>(active).streams.some((s) => s.id === session.id),
    ).toBe(true);

    // Playback works before revocation.
    const before = await request(carol, { method: "GET", url: session.playbackUrl });
    expect(before.statusCode).toBe(200);

    // A non-admin cannot revoke.
    const carolRevoke = await request(carol, {
      method: "POST",
      url: `/api/admin/streams/${session.id}/revoke`,
      csrf: true,
    });
    expect(carolRevoke.statusCode).toBe(403);

    // Revoke without CSRF is rejected.
    const noCsrf = await request(owner, {
      method: "POST",
      url: `/api/admin/streams/${session.id}/revoke`,
    });
    expect(noCsrf.statusCode).toBe(403);

    // Admin revokes with CSRF.
    const revoke = await request(owner, {
      method: "POST",
      url: `/api/admin/streams/${session.id}/revoke`,
      csrf: true,
    });
    expect(revoke.statusCode).toBe(200);

    // The proxy now refuses the revoked session for its owner.
    const after = await request(carol, { method: "GET", url: session.playbackUrl });
    expect(after.statusCode).toBe(404);
    const bearerAfter = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: session.playbackUrl,
      headers: { authorization: session.playbackAuthorization },
    });
    expect(bearerAfter.statusCode).toBe(404);
    const capability = session.playbackAuthorization.replace(/^Bearer\s+/, "");
    const externalAfter = await request({ app, cookies: new Map() }, {
      method: "GET",
      url: `/api/external-stream/${session.id}/${capability}`,
    });
    expect(externalAfter.statusCode).toBe(404);

    // Revoking again (already revoked) reports not-found.
    const again = await request(owner, {
      method: "POST",
      url: `/api/admin/streams/${session.id}/revoke`,
      csrf: true,
    });
    expect(again.statusCode).toBe(404);
  });

  // --- Phase 3b: server-side transcoding -------------------------------------

  async function buildTranscodeApp(
    config: Record<string, unknown> = {},
    transcoder: Transcoder = makeFakeTranscoder(),
  ): Promise<FastifyInstance> {
    return buildApp({
      config: {
        databasePath: ":memory:",
        dataDir: ".test-data",
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        allowRawStreamUrls: true,
        enableTranscode: true,
        ...config,
      },
      transcoder,
    });
  }

  async function createRawSession(
    client: TestClient,
    upstreamUrl = "http://127.0.0.1:9/video",
  ): Promise<{ id: string; playbackUrl: string }> {
    const created = await request(client, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: { upstreamUrl, contentType: "video/mp4" },
    });
    expect(created.statusCode).toBe(200);
    return json<{ session: { id: string; playbackUrl: string } }>(created).session;
  }

  it("transcode OFF: routes 404, capability false, and the proxy is unchanged", async () => {
    const off = await buildTranscodeApp({ enableTranscode: false });
    upstream = createServer((_req, res) => {
      const body = Buffer.from("hello-bytes");
      res.writeHead(200, {
        "content-length": String(body.length),
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Expected TCP test server.");
    upstreamUrl = `http://127.0.0.1:${address.port}/v`;
    try {
      const owner = await setupOwner(off);
      const session = await createRawSession(owner, upstreamUrl);
      expect(
        json<{ transcodeAvailable: boolean }>(await request(owner, { method: "GET", url: "/api/bootstrap" })).transcodeAvailable,
      ).toBe(false);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(404);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/seg_00000.ts` })).statusCode).toBe(404);
      // The plain proxy still works (byte-identical to before this feature).
      const proxied = await request(owner, { method: "GET", url: session.playbackUrl });
      expect(proxied.statusCode).toBe(200);
      expect(proxied.body).toBe("hello-bytes");
    } finally {
      await off.close();
    }
  });

  it("transcode: ffmpeg absent → capability false and routes 404 even with the flag on", async () => {
    const noFfmpeg = await buildTranscodeApp({ enableTranscode: true }, makeFakeTranscoder({ detect: false }));
    try {
      const owner = await setupOwner(noFfmpeg);
      const session = await createRawSession(owner);
      expect(
        json<{ transcodeAvailable: boolean }>(await request(owner, { method: "GET", url: "/api/bootstrap" })).transcodeAvailable,
      ).toBe(false);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(404);
    } finally {
      await noFfmpeg.close();
    }
  });

  it("transcode: reports detected encoders and safely falls back to software", async () => {
    const base = makeFakeTranscoder();
    const detected: Transcoder = {
      ...base,
      async capabilities() {
        return {
          toneMapping: true,
          videoEncoders: ["libx264"],
        };
      },
    };
    const fallback = await buildTranscodeApp(
      {
        enableTranscode: true,
        transcodeVideoEncoder: "h264_nvenc",
      },
      detected,
    );
    try {
      const owner = await setupOwner(fallback);
      const bootstrap = json<{
        transcodeAvailable: boolean;
        transcodeCapabilities: {
          hardwareEncoder: string;
          availableVideoEncoders: string[];
          toneMapping: boolean;
        };
      }>(await request(owner, { method: "GET", url: "/api/bootstrap" }));
      expect(bootstrap.transcodeAvailable).toBe(true);
      expect(bootstrap.transcodeCapabilities).toMatchObject({
        hardwareEncoder: "libx264",
        availableVideoEncoders: ["libx264"],
        toneMapping: true,
      });
    } finally {
      await fallback.close();
    }
  });

  it("transcode ON (+ffmpeg): advertises the capability and serves an HLS manifest + segment", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true });
    try {
      const owner = await setupOwner(on);
      expect(
        json<{ transcodeAvailable: boolean }>(await request(owner, { method: "GET", url: "/api/bootstrap" })).transcodeAvailable,
      ).toBe(true);
      const session = await createRawSession(owner);

      const manifest = await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` });
      expect(manifest.statusCode).toBe(200);
      expect(String(manifest.headers["content-type"])).toContain("application/vnd.apple.mpegurl");
      expect(manifest.body).toContain("#EXTM3U");
      // The adaptive master exposes three auth-scoped renditions.
      expect(manifest.body).toContain(`/api/stream/${session.id}/1080p.m3u8`);
      expect(manifest.body).toContain(`/api/stream/${session.id}/720p.m3u8`);
      expect(manifest.body).toContain(`/api/stream/${session.id}/480p.m3u8`);

      const variant = await request(owner, {
        method: "GET",
        url: `/api/stream/${session.id}/1080p.m3u8`,
      });
      expect(variant.statusCode).toBe(200);
      expect(variant.body).toContain(
        `/api/stream/${session.id}/1080p_seg_00000.ts`,
      );

      const seg = await request(owner, { method: "GET", url: `/api/stream/${session.id}/1080p_seg_00000.ts` });
      expect(seg.statusCode).toBe(200);
      expect(String(seg.headers["content-type"])).toContain("video/mp2t");
    } finally {
      await on.close();
    }
  });

  it("transcode: applies the client profile and start offset, and exposes a subtitle sidecar", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true });
    try {
      const owner = await setupOwner(on);
      const session = await createRawSession(owner);
      const manifest = await request(owner, {
        method: "GET",
        url: `/api/stream/${session.id}/index.m3u8?profile=data-saver&start=120&hdr=preserve&subtitles=preserve`,
      });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["x-yawf-playback-decision"]).toBe("transcode");
      expect(manifest.headers["x-yawf-transcode-profile"]).toBe("data-saver");
      expect(manifest.headers["x-yawf-transcode-start"]).toBe("120");
      const subtitles = await request(owner, {
        method: "GET",
        url: `/api/stream/${session.id}/subtitles.vtt`,
      });
      expect(subtitles.statusCode).toBe(200);
      expect(String(subtitles.headers["content-type"])).toContain("text/vtt");
      expect(subtitles.body).toContain("WEBVTT");
    } finally {
      await on.close();
    }
  });

  it("transcode: a profile cannot read another profile's manifest/segments (IDOR)", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true });
    try {
      const owner = await setupOwner(on);
      await createProfile(owner, "dave", "dave-password");
      const dave = await login(on, "dave", "dave-password");
      const session = await createRawSession(owner);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(200);
      expect((await request(dave, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(404);
      expect((await request(dave, { method: "GET", url: `/api/stream/${session.id}/seg_00000.ts` })).statusCode).toBe(404);
    } finally {
      await on.close();
    }
  });

  it("transcode: a revoked session is refused by the transcode routes", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true });
    try {
      const owner = await setupOwner(on);
      const session = await createRawSession(owner);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(200);
      expect((await request(owner, { method: "POST", url: `/api/admin/streams/${session.id}/revoke`, csrf: true })).statusCode).toBe(200);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` })).statusCode).toBe(404);
      expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/seg_00000.ts` })).statusCode).toBe(404);
    } finally {
      await on.close();
    }
  });

  it("transcode: the segment route rejects non-segment paths (no traversal)", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true });
    try {
      const owner = await setupOwner(on);
      const session = await createRawSession(owner);
      await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` }); // start the job
      for (const bad of ["passwd", "seg_00000.ts.bak", "seg_0.ts", "seg_99999.txt", "evil.ts"]) {
        expect((await request(owner, { method: "GET", url: `/api/stream/${session.id}/${bad}` })).statusCode).toBe(404);
      }
    } finally {
      await on.close();
    }
  });

  it("transcode: enforces the concurrency cap (503 when busy)", async () => {
    const on = await buildTranscodeApp({ enableTranscode: true, maxTranscodes: 1 });
    try {
      const owner = await setupOwner(on);
      const s1 = await createRawSession(owner);
      const s2 = await createRawSession(owner);
      expect((await request(owner, { method: "GET", url: `/api/stream/${s1.id}/index.m3u8` })).statusCode).toBe(200);
      expect((await request(owner, { method: "GET", url: `/api/stream/${s2.id}/index.m3u8` })).statusCode).toBe(503);
    } finally {
      await on.close();
    }
  });

  it("transcode: returns 504 when ffmpeg never produces a manifest", async () => {
    const on = await buildTranscodeApp(
      { enableTranscode: true, transcodeStartTimeoutMs: 200 },
      makeFakeTranscoder({ writeOutput: false }), // never writes the HLS output
    );
    try {
      const owner = await setupOwner(on);
      const session = await createRawSession(owner);
      const res = await request(owner, { method: "GET", url: `/api/stream/${session.id}/index.m3u8` });
      expect(res.statusCode).toBe(504);
    } finally {
      await on.close();
    }
  });

  it("restricted role: blocks management routes but allows browse + watchlist", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "rest", "rest-password", "restricted");
    await createProfile(owner, "memb", "memb-password", "member");
    const restricted = await login(app, "rest", "rest-password");
    const member = await login(app, "memb", "memb-password");

    // Management route (profile credential override) is blocked for restricted.
    // requireNotRestricted fires before body parsing, so the 403 is the role gate.
    const restrictedCred = await request(restricted, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: { provider: "tmdb", label: "Mine", value: "abc123" },
    });
    expect(restrictedCred.statusCode).toBe(403);

    // Profile management (PATCH) is blocked for restricted. The role gate runs
    // before the id/ownership check, so any id yields the same 403.
    const restrictedPatch = await request(restricted, {
      method: "PATCH",
      url: "/api/profiles/any-profile-id",
      csrf: true,
      payload: { displayName: "Hacker" },
    });
    expect(restrictedPatch.statusCode).toBe(403);

    // Browse/viewing data is allowed for restricted: write + read the watchlist.
    const restrictedWatchPut = await request(restricted, {
      method: "PUT",
      url: "/api/library/watchlist/tt0111161",
      csrf: true,
      payload: { preview: { id: "tt0111161", title: "Movie" } },
    });
    expect(restrictedWatchPut.statusCode).toBe(200);
    const restrictedWatchGet = await request(restricted, {
      method: "GET",
      url: "/api/library/watchlist",
    });
    expect(restrictedWatchGet.statusCode).toBe(200);

    // A member is unaffected: the same management route succeeds.
    const memberCred = await request(member, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: { provider: "tmdb", label: "Mine", value: "abc123" },
    });
    expect(memberCred.statusCode).toBe(200);

    // The owner is unaffected too.
    const ownerCred = await request(owner, {
      method: "PUT",
      url: "/api/profile/credentials",
      csrf: true,
      payload: { provider: "tmdb", label: "Owner", value: "abc123" },
    });
    expect(ownerCred.statusCode).toBe(200);
  });

  // ---- Account role management (promote / demote) --------------------------

  it("owner promotes and demotes account roles; the change takes effect on the target", async () => {
    const owner = await setupOwner(app);
    const bobId = await createProfile(owner, "bob", "bob-password", "member");

    const promote = await request(owner, {
      method: "POST",
      url: `/api/profiles/${bobId}/role`,
      csrf: true,
      payload: { role: "admin" },
    });
    expect(promote.statusCode).toBe(200);
    const bobAsAdmin = await login(app, "bob", "bob-password");
    expect(
      json<{ session: { role: string } }>(
        await request(bobAsAdmin, { method: "GET", url: "/api/auth/session" }),
      ).session.role,
    ).toBe("admin");

    const demote = await request(owner, {
      method: "POST",
      url: `/api/profiles/${bobId}/role`,
      csrf: true,
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(200);
    const bobAsMember = await login(app, "bob", "bob-password");
    expect(
      json<{ session: { role: string } }>(
        await request(bobAsMember, { method: "GET", url: "/api/auth/session" }),
      ).session.role,
    ).toBe("member");
  });

  it("a non-owner admin cannot grant the admin tier but can move member <-> restricted", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "alice", "alice-password", "admin");
    const memberId = await createProfile(owner, "bob", "bob-password", "member");
    const admin = await login(app, "alice", "alice-password");

    const grant = await request(admin, {
      method: "POST",
      url: `/api/profiles/${memberId}/role`,
      csrf: true,
      payload: { role: "admin" },
    });
    expect(grant.statusCode).toBe(403);

    const restrict = await request(admin, {
      method: "POST",
      url: `/api/profiles/${memberId}/role`,
      csrf: true,
      payload: { role: "restricted" },
    });
    expect(restrict.statusCode).toBe(200);
  });

  it("no account can change its own role", async () => {
    const owner = await setupOwner(app);
    const list = await request(owner, { method: "GET", url: "/api/profiles" });
    const ownerAccount = json<{ profiles: Array<{ id: string; username: string }> }>(list).profiles.find(
      (p) => p.username === "owner",
    );
    expect(ownerAccount).toBeTruthy();
    const selfChange = await request(owner, {
      method: "POST",
      url: `/api/profiles/${ownerAccount?.id ?? "missing"}/role`,
      csrf: true,
      payload: { role: "member" },
    });
    expect(selfChange.statusCode).toBe(400);
  });

  it("the role route is admin-only, CSRF-guarded, and 404s an unknown profile", async () => {
    const owner = await setupOwner(app);
    const bobId = await createProfile(owner, "bob", "bob-password", "member");
    const member = await login(app, "bob", "bob-password");

    // A non-admin member is rejected before anything else (requireAdmin).
    expect(
      (
        await request(member, {
          method: "POST",
          url: `/api/profiles/${bobId}/role`,
          csrf: true,
          payload: { role: "restricted" },
        })
      ).statusCode,
    ).toBe(403);
    // Missing CSRF token is rejected for the owner.
    expect(
      (
        await request(owner, {
          method: "POST",
          url: `/api/profiles/${bobId}/role`,
          payload: { role: "admin" },
        })
      ).statusCode,
    ).toBe(403);
    // Unknown profile id.
    expect(
      (
        await request(owner, {
          method: "POST",
          url: "/api/profiles/does-not-exist/role",
          csrf: true,
          payload: { role: "member" },
        })
      ).statusCode,
    ).toBe(404);
  });

  // ---- Household sub-profiles ("who's watching") ---------------------------

  interface AccountProfile {
    id: string;
    displayName: string;
    avatarColor: string | null;
    simpleMode: boolean;
    isDefault: boolean;
  }
  interface ProfileState {
    profiles: AccountProfile[];
    activeProfileId: string;
  }

  async function createAccountProfile(
    client: TestClient,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const response = await request(client, {
      method: "POST",
      url: "/api/account/profiles",
      csrf: true,
      payload,
    });
    expect(response.statusCode).toBe(200);
    return json<{ profile: { id: string } }>(response).profile.id;
  }

  async function switchProfile(
    client: TestClient,
    profileId: string,
  ): Promise<LightMyRequestResponse> {
    return request(client, {
      method: "POST",
      url: "/api/profiles/switch",
      csrf: true,
      payload: { profileId },
    });
  }

  it("creates household sub-profiles under one account and lists them with the default first", async () => {
    const owner = await setupOwner(app);

    const initial = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    );
    expect(initial.profiles).toHaveLength(1);
    expect(initial.profiles[0]?.isDefault).toBe(true);
    expect(initial.activeProfileId).toBe(initial.profiles[0]?.id);

    // A viewer profile needs no username; password is optional.
    const kidId = await createAccountProfile(owner, {
      displayName: "Kid",
      avatarColor: "#22c55e",
    });

    const state = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    );
    expect(state.profiles).toHaveLength(2);
    expect(state.profiles[0]?.isDefault).toBe(true); // default first
    const kid = state.profiles.find((p) => p.id === kidId);
    expect(kid).toMatchObject({ displayName: "Kid", avatarColor: "#22c55e", isDefault: false });

    // bootstrap + session both echo the picker payload.
    const boot = json<{ profiles: ProfileState | null }>(
      await request(owner, { method: "GET", url: "/api/bootstrap" }),
    );
    expect(boot.profiles?.profiles).toHaveLength(2);
    const session = json<{ profiles: ProfileState }>(
      await request(owner, { method: "GET", url: "/api/auth/session" }),
    );
    expect(session.profiles.profiles).toHaveLength(2);
  });

  it("switching the active profile changes the data scope (watchlist differs per profile)", async () => {
    const owner = await setupOwner(app);
    const defaultId = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    ).activeProfileId;
    const kidId = await createAccountProfile(owner, { displayName: "Kid" });

    // Default profile adds an item.
    await request(owner, {
      method: "PUT",
      url: "/api/library/watchlist/tt-default",
      csrf: true,
      payload: { preview: { id: "tt-default", title: "Default pick" } },
    });

    // Switch to the kid profile - session + active scope follow it.
    const switched = json<{ session: { profileId: string }; profiles: ProfileState }>(
      await switchProfile(owner, kidId),
    );
    expect(switched.session.profileId).toBe(kidId);
    expect(switched.profiles.activeProfileId).toBe(kidId);

    // The kid profile starts empty (data is isolated by the active profile).
    const kidWatchlist = json<{ items: unknown[] }>(
      await request(owner, { method: "GET", url: "/api/library/watchlist" }),
    );
    expect(kidWatchlist.items).toHaveLength(0);

    await request(owner, {
      method: "PUT",
      url: "/api/library/watchlist/tt-kid",
      csrf: true,
      payload: { preview: { id: "tt-kid", title: "Kid pick" } },
    });
    const kidAfter = json<{ items: Array<{ mediaId: string }> }>(
      await request(owner, { method: "GET", url: "/api/library/watchlist" }),
    );
    expect(kidAfter.items.map((i) => i.mediaId)).toEqual(["tt-kid"]);

    // Switch back to the default - its original item is intact, the kid's is not.
    await switchProfile(owner, defaultId);
    const defaultAfter = json<{ items: Array<{ mediaId: string }> }>(
      await request(owner, { method: "GET", url: "/api/library/watchlist" }),
    );
    expect(defaultAfter.items.map((i) => i.mediaId)).toEqual(["tt-default"]);
  });

  it("renames, recolors, and deletes a sub-profile but keeps the default protected", async () => {
    const owner = await setupOwner(app);
    const defaultId = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    ).activeProfileId;
    const kidId = await createAccountProfile(owner, { displayName: "Kid" });

    // Rename + recolor.
    const patched = json<{ profiles: AccountProfile[] }>(
      await request(owner, {
        method: "PATCH",
        url: `/api/account/profiles/${kidId}`,
        csrf: true,
        payload: { displayName: "Teen", avatarColor: "#6366f1" },
      }),
    );
    expect(patched.profiles.find((p) => p.id === kidId)).toMatchObject({
      displayName: "Teen",
      avatarColor: "#6366f1",
    });

    // The default profile can never be deleted.
    const deleteDefault = await request(owner, {
      method: "DELETE",
      url: `/api/account/profiles/${defaultId}`,
      csrf: true,
    });
    expect(deleteDefault.statusCode).toBe(400);

    // A non-default sub-profile deletes cleanly.
    const deleteKid = await request(owner, {
      method: "DELETE",
      url: `/api/account/profiles/${kidId}`,
      csrf: true,
    });
    expect(deleteKid.statusCode).toBe(200);
    const remaining = json<{ profiles: AccountProfile[] }>(deleteKid);
    expect(remaining.profiles).toHaveLength(1);
    expect(remaining.profiles[0]?.id).toBe(defaultId);
  });

  it("a session whose active profile is deleted falls back to the default", async () => {
    const owner = await setupOwner(app);
    const defaultId = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    ).activeProfileId;
    const kidId = await createAccountProfile(owner, { displayName: "Kid" });

    await switchProfile(owner, kidId);
    expect(
      json<{ session: { profileId: string } }>(
        await request(owner, { method: "GET", url: "/api/auth/session" }),
      ).session.profileId,
    ).toBe(kidId);

    // Delete the active profile, then confirm the session degrades to default.
    await request(owner, {
      method: "DELETE",
      url: `/api/account/profiles/${kidId}`,
      csrf: true,
    });
    expect(
      json<{ session: { profileId: string } }>(
        await request(owner, { method: "GET", url: "/api/auth/session" }),
      ).session.profileId,
    ).toBe(defaultId);
  });

  it("cannot switch to, read, rename, or delete another account's profile (IDOR-safe)", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "bob", "bob-password");
    const bob = await login(app, "bob", "bob-password");

    // Owner creates a household sub-profile.
    const ownerKidId = await createAccountProfile(owner, { displayName: "Owner Kid" });

    // bob's list never includes the owner's profiles.
    const bobState = json<ProfileState>(
      await request(bob, { method: "GET", url: "/api/account/profiles" }),
    );
    expect(bobState.profiles.some((p) => p.id === ownerKidId)).toBe(false);

    // bob cannot switch to the owner's profile.
    expect((await switchProfile(bob, ownerKidId)).statusCode).toBe(404);
    // bob cannot rename it.
    expect(
      (
        await request(bob, {
          method: "PATCH",
          url: `/api/account/profiles/${ownerKidId}`,
          csrf: true,
          payload: { displayName: "hacked" },
        })
      ).statusCode,
    ).toBe(404);
    // bob cannot delete it.
    expect(
      (
        await request(bob, {
          method: "DELETE",
          url: `/api/account/profiles/${ownerKidId}`,
          csrf: true,
        })
      ).statusCode,
    ).toBe(404);

    // The owner's profile is untouched.
    const ownerState = json<ProfileState>(
      await request(owner, { method: "GET", url: "/api/account/profiles" }),
    );
    expect(ownerState.profiles.find((p) => p.id === ownerKidId)?.displayName).toBe("Owner Kid");
  });

  it("requires auth and CSRF for sub-profile mutations", async () => {
    const owner = await setupOwner(app);
    const kidId = await createAccountProfile(owner, { displayName: "Kid" });

    // Unauthenticated client.
    const anon: TestClient = { app, cookies: new Map() };
    expect(
      (await request(anon, { method: "GET", url: "/api/account/profiles" })).statusCode,
    ).toBe(401);

    // Authenticated but missing CSRF → 403 on every unsafe route.
    expect(
      (
        await request(owner, {
          method: "POST",
          url: "/api/account/profiles",
          payload: { displayName: "NoCsrf" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await request(owner, { method: "POST", url: "/api/profiles/switch", payload: { profileId: kidId } })).statusCode).toBe(403);
    expect(
      (await request(owner, { method: "PATCH", url: `/api/account/profiles/${kidId}`, payload: { displayName: "x" } })).statusCode,
    ).toBe(403);
    expect(
      (await request(owner, { method: "DELETE", url: `/api/account/profiles/${kidId}` })).statusCode,
    ).toBe(403);
  });

  it("restricted role cannot create/manage household sub-profiles", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "limited", "limited-password", "restricted");
    const limited = await login(app, "limited", "limited-password");
    // A restricted account can switch among its own profiles (a viewing
    // convenience) but cannot create/rename/delete them (management).
    expect(
      (await request(limited, { method: "POST", url: "/api/account/profiles", csrf: true, payload: { displayName: "Kid" } })).statusCode,
    ).toBe(403);
  });

  it("sets and clears rolling household bandwidth caps without blocking stream sessions", async () => {
    const owner = await setupOwner(app);
    const kidId = await createAccountProfile(owner, { displayName: "Kid" });

    const set = await request(owner, {
      method: "POST",
      url: "/api/profiles/quota",
      csrf: true,
      payload: { profileId: kidId, capBytes: 1 },
    });
    expect(set.statusCode).toBe(200);
    expect(
      json<{
        profiles: ProfileState;
      }>(set).profiles.profiles.find((profile) => profile.id === kidId),
    ).toMatchObject({
      bandwidthCapBytes: 1,
      bandwidthUsageBytes: 0,
      bandwidthStatus: "ok",
    });

    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end("over-cap playback still works");
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address == null || typeof address === "string") throw new Error("Test server did not bind");
    const upstreamUrl = `http://127.0.0.1:${address.port}/video`;

    // Warn-only is intentional: this playback makes the profile over cap, and
    // a later stream is still proxied. Do not add a quota check to this path.
    await switchProfile(owner, kidId);
    const first = await request(owner, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: { upstreamUrl, contentType: "video/mp4" },
    });
    expect(first.statusCode).toBe(200);
    const firstSession = json<{ session: { id: string; playbackUrl: string } }>(first).session;
    expect((await request(owner, { method: "GET", url: firstSession.playbackUrl })).statusCode).toBe(200);

    const usage = await request(owner, { method: "GET", url: "/api/admin/usage/streams" });
    expect(usage.statusCode).toBe(200);
    expect(
      json<{
        profiles: Array<{
          profileId: string;
          bandwidthCapBytes: number | null;
          bandwidthStatus: string;
        }>;
      }>(
        usage,
      ).profiles.find((profile) => profile.profileId === kidId),
    ).toMatchObject({ bandwidthCapBytes: 1, bandwidthStatus: "over" });

    const second = await request(owner, {
      method: "POST",
      url: "/api/streams/sessions/raw",
      csrf: true,
      payload: { upstreamUrl, contentType: "video/mp4" },
    });
    expect(second.statusCode).toBe(200);
    const secondSession = json<{ session: { playbackUrl: string } }>(second).session;
    expect((await request(owner, { method: "GET", url: secondSession.playbackUrl })).statusCode).toBe(200);

    const clear = await request(owner, {
      method: "POST",
      url: "/api/profiles/quota",
      csrf: true,
      payload: { profileId: kidId, capBytes: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(
      json<{ profiles: ProfileState }>(clear).profiles.profiles.find((profile) => profile.id === kidId),
    ).toMatchObject({ bandwidthCapBytes: null, bandwidthStatus: "ok" });
  });

  it("allows only owner/admin household managers to set bandwidth caps", async () => {
    const owner = await setupOwner(app);
    await createProfile(owner, "member", "member-password");
    const member = await login(app, "member", "member-password");
    const memberProfile = json<ProfileState>(
      await request(member, { method: "GET", url: "/api/account/profiles" }),
    ).activeProfileId;

    expect(
      (
        await request(member, {
          method: "POST",
          url: "/api/profiles/quota",
          csrf: true,
          payload: { profileId: memberProfile, capBytes: 1024 },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("never leaks or lets the client overwrite the protected sub-profile password hash", async () => {
    const owner = await setupOwner(app);
    // A household sub-profile created WITH a password stores a write-only hash.
    const sub = json<{ profile: { id: string } }>(
      await request(owner, {
        method: "POST",
        url: "/api/account/profiles",
        csrf: true,
        payload: { displayName: "Kid", password: "kid-pin-1234" },
      }),
    ).profile.id;
    // Switch to it so /api/settings/profile reads that profile's settings. The
    // profile was created with a password, which is now an enforced switch PIN,
    // so the switch must supply it (a profile with a PIN can no longer be
    // entered credential-free - that is the household gate).
    expect(
      (await request(owner, { method: "POST", url: "/api/profiles/switch", csrf: true, payload: { profileId: sub, password: "kid-pin-1234" } })).statusCode,
    ).toBe(200);
    const settings = json<{ settings: Record<string, string> }>(
      await request(owner, { method: "GET", url: "/api/settings/profile" }),
    ).settings;
    expect(settings.profile_password_hash).toBeUndefined(); // not leaked on read
    expect(settings.profile_gate_kind).toBeUndefined();
    // And the generic settings PUT cannot overwrite/delete the protected key.
    expect(
      (await request(owner, {
        method: "PUT",
        url: "/api/settings/profile",
        csrf: true,
        payload: { key: "profile_password_hash", value: "attacker" },
      })).statusCode,
    ).toBe(403);
    expect(
      (await request(owner, {
        method: "PUT",
        url: "/api/settings/profile",
        csrf: true,
        payload: { key: "profile_gate_kind", value: "none" },
      })).statusCode,
    ).toBe(403);
  });
});
