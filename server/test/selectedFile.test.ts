import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { decryptSecret } from "../src/crypto.js";

const hash = "b".repeat(40);
const selectedName = "collection/Right.Bunny.avi";
const origin = "https://93.184.216.34";
let app: FastifyInstance;
let dir: string;
let db: DatabaseSync;
let secret: Buffer;
let headers: Record<string, string>;
let requestedFileIds: string[];
let providerCalls: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "yawf-selected-file-"));
  secret = randomBytes(32);
  const databasePath = join(dir, "test.sqlite");
  app = await buildApp({ config: {
    databasePath, dataDir: dir, secretKey: secret, logger: false, cookieSecure: false,
  } });
  const owner = await app.inject({ method: "POST", url: "/api/auth/setup-owner", payload: {
    username: "owner", password: "fixture-password", displayName: "Owner",
  } });
  expect(owner.statusCode).toBe(200);
  headers = {
    cookie: owner.cookies.map((item) => `${item.name}=${item.value}`).join("; "),
    "x-csrf-token": owner.cookies.find((item) => item.name === "ds_csrf")!.value,
  };
  expect((await app.inject({ method: "PUT", url: "/api/admin/credentials", headers,
    payload: { provider: "torbox", value: "fixture-torbox-key", label: "Fixture" },
  })).statusCode).toBe(200);
  db = new DatabaseSync(databasePath);
  requestedFileIds = [];
  providerCalls = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
    if (url.hostname === "api.torbox.app") {
      providerCalls++;
      if (url.pathname.endsWith("/createtorrent")) return json({ torrent_id: 42 });
      if (url.pathname.endsWith("/mylist")) return json({ id: 42, download_state: "cached", files: [
        // Provider order and IDs are deliberately not the torrent's original
        // index order. An exact name identifies the intended smaller AVI.
        { id: 61, name: "collection/Wrong.x264.mkv", size: 100_000 },
        { id: 99, name: selectedName, size: 12 },
        { id: 31, name: "collection/readme.txt", size: 1 },
      ] });
      if (url.pathname.endsWith("/requestdl")) {
        const id = url.searchParams.get("file_id")!;
        requestedFileIds.push(id);
        return json(`${origin}/${id === "99" ? "right" : "wrong"}.avi`);
      }
    }
    if (url.origin === origin) {
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(url.pathname === "/right.avi" ? "RIGHT-BUNNY" : "WRONG-VIDEO", {
        headers: { "content-type": "video/x-msvideo" },
      });
    }
    throw new Error("Unexpected fixture request");
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const resolve = (extra: Record<string, unknown>) => app.inject({
  method: "POST", url: "/api/streams/resolve", headers,
  payload: { infoHash: hash, preferredService: "torbox", ...extra },
});

describe("selected torrent file through Server Mode and external playback", () => {
  it("keeps the selected smaller file in the session and cookie-free external bytes", async () => {
    const response = await resolve({ fileIndex: 1, fileName: selectedName });
    expect(response.statusCode).toBe(200);
    const { stream, session } = response.json();
    expect(requestedFileIds).toEqual(["99"]);
    expect(stream.fileName).toBe(selectedName);
    const row = db.prepare("SELECT title, encrypted_upstream_url FROM stream_sessions WHERE id = ?")
      .get(session.id)!;
    expect(row.title).toBe(selectedName);
    expect(decryptSecret(String(row.encrypted_upstream_url), secret)).toBe(`${origin}/right.avi`);
    const external = await app.inject({ method: "GET",
      url: `/api/external-stream/${session.id}/${stream.playbackAuthorization.slice("Bearer ".length)}`,
    });
    expect(external.statusCode).toBe(200);
    expect(external.body).toBe("RIGHT-BUNNY");
  });

  it("rejects an unavailable exact selection with 422 before requesting or granting another file", async () => {
    const response = await resolve({ fileIndex: 1, fileName: "Missing.Bunny.mkv" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe(
      "The selected file is unavailable or does not match this source. Choose another source.",
    );
    expect(requestedFileIds).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stream_sessions").get()!.n).toBe(0);
  });

  it("rejects incomplete or malformed exact selectors before contacting a provider", async () => {
    for (const input of [
      { fileIndex: 0 }, { fileName: selectedName },
      { fileIndex: -1, fileName: selectedName },
      { fileIndex: 1.5, fileName: selectedName },
      { fileIndex: 1_000_001, fileName: selectedName },
      { fileIndex: 1, fileName: "\u0000bad.mkv" },
      { fileIndex: 1, fileName: "\tRight.Bunny.avi" },
      { fileIndex: 1, fileName: "Right.Bunny.avi\n" },
      { fileIndex: 1, fileName: " " },
      { fileIndex: 1, fileName: "a".repeat(1025) },
    ]) {
      expect((await resolve(input)).statusCode).toBe(400);
    }
    expect(providerCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stream_sessions").get()!.n).toBe(0);
  });

  it("binds a kid title to the indexed file pair instead of only its collection hash", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/admin/credentials", headers,
      payload: { provider: "tmdb", value: "fixture-metadata-key", label: "Fixture" },
    })).statusCode).toBe(200);
    for (const [key, value] of [
      ["built_in_indexers_enabled", "false"],
      ["server_indexer_configs", JSON.stringify([{
        id: "fixture", type: "stremio_addon", baseURL: "https://addon.example",
        isActive: true,
      }])],
    ]) {
      expect((await app.inject({ method: "PUT", url: "/api/settings/profile", headers,
        payload: { key, value },
      })).statusCode).toBe(200);
    }
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers });
    const profileId = bootstrap.json().session.profileId;
    expect((await app.inject({ method: "POST", url: `/api/account/profiles/${profileId}/maturity`,
      headers, payload: { isKid: true, maturityMax: "PG" },
    })).statusCode).toBe(200);

    const providerFetch = globalThis.fetch;
    let explicitSource = true;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const json = (value: unknown) => new Response(JSON.stringify(value));
      if (url.hostname === "api.themoviedb.org") {
        if (url.pathname.includes("/find/")) return json({ movie_results: [{ id: 600 }], tv_results: [] });
        if (url.pathname.endsWith("/release_dates")) return json({ results: [{
          iso_3166_1: "US", release_dates: [{ certification: "G" }],
        }] });
        if (url.pathname.endsWith("/credits") || url.pathname.endsWith("/recommendations")) {
          return json({ cast: [], results: [] });
        }
        return json({ id: 600, title: "Right Bunny", genres: [],
          external_ids: { imdb_id: "tt0000600" },
        });
      }
      if (url.hostname === "addon.example") return json({ streams: [{
        infoHash: hash, title: "Collection 1080p",
        ...(explicitSource ? { fileIdx: 1, behaviorHints: { filename: selectedName } } : {}),
      }] });
      return providerFetch(input, init);
    }));
    const media = { mediaId: "tmdb-600", mediaType: "movie" };
    const valid = await resolve({ ...media, fileIndex: 1, fileName: selectedName });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().stream.fileName).toBe(selectedName);
    const calls = providerCalls;
    for (const selection of [
      {}, { fileIndex: 2, fileName: selectedName },
      { fileIndex: 1, fileName: "collection/Wrong.x264.mkv" },
    ]) {
      expect((await resolve({ ...media, ...selection })).statusCode).toBe(403);
    }
    expect(providerCalls).toBe(calls);
    explicitSource = false;
    expect((await resolve({ ...media, fileIndex: 1, fileName: selectedName })).statusCode).toBe(403);
    // Legacy single-file sources remain valid without an explicit selector.
    expect((await resolve(media)).statusCode).toBe(200);
  });
});
