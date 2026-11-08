import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { get, createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { AppDatabase } from "../src/db.js";
import type { DirectTorrentAdapter } from "../src/directTorrent.js";

// Only the indexed-title lookup is synthetic. Requests still pass the normal
// session, CSRF, explicit Direct P2P acknowledgement and stream routes.
vi.mock("../src/media-runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/media-runtime.js")>(),
  titleHasInfoHash: vi.fn(async () => true),
}));

const ownedApps: FastifyInstance[] = [];
const ownedServers: Server[] = [];
const ownedDirectories: string[] = [];
const terminalDrains: Array<() => void> = [];

afterEach(async () => {
  for (const app of ownedApps.splice(0)) await app.close();
  for (const drain of terminalDrains.splice(0)) drain();
  for (const server of ownedServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  for (const directory of ownedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setupApp(kind: "web" | "node" = "web", onCounted?: (source: Readable) => void, nodeLength = 100_000) {
  const directory = mkdtempSync(join(tmpdir(), "ds-transfer-close-"));
  ownedDirectories.push(directory);
  const databasePath = join(directory, "app.sqlite");
  const nodeBody = new Readable({ read() {} });
  const adapter: DirectTorrentAdapter = {
    async open(infoHash) {
      return {
        infoHash,
        files: [{ name: "Owned.Fixture.mp4", length: nodeLength, createReadStream: () => nodeBody }],
        async destroy() { nodeBody.destroy(); },
      };
    },
    async close() {},
  };
  const app = await buildApp({
    config: {
      databasePath, dataDir: directory, secretKey: randomBytes(32),
      cookieSecure: false, logger: false, allowRawStreamUrls: true,
      enableDirectTorrent: kind === "node",
      streamUpstreamIdleTimeoutMs: 60_000,
    },
    ...(kind === "node" ? { directTorrentAdapter: adapter } : {}),
  });
  ownedApps.push(app);
  app.addHook("onSend", async (request, _reply, payload) => {
    if (request.url.startsWith("/api/stream/") && payload instanceof Readable) onCounted?.(payload);
    return payload;
  });
  const owner = await app.inject({
    method: "POST", url: "/api/auth/setup-owner",
    payload: { username: "owner", password: "fixture-password", displayName: "Owner" },
  });
  expect(owner.statusCode).toBe(200);
  const cookies = owner.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const csrf = owner.json<{ csrfToken: string }>().csrfToken;
  const headers = { cookie: cookies, "x-csrf-token": csrf };
  return { app, databasePath, nodeBody, headers };
}

async function createSession(app: FastifyInstance, headers: Record<string, string>, kind: "web" | "node", upstreamUrl: string) {
  const result = await app.inject({
    method: "POST", headers,
    url: kind === "web" ? "/api/streams/sessions/raw" : "/api/streams/resolve",
    payload: kind === "web"
      ? { upstreamUrl, contentType: "video/mp4" }
      : {
          infoHash: "a".repeat(40), backend: "direct_torrent", directTorrentAcknowledged: true,
          mediaId: "tmdb-1", mediaType: "movie",
        },
  });
  expect(result.statusCode).toBe(200);
  const { session } = result.json<{ session: { id: string } }>();
  return { id: session.id, path: `/api/stream/${session.id}` };
}

function transferRows(databasePath: string) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("SELECT id, bytes_served, completed_at, last_status, last_error FROM stream_sessions ORDER BY id")
      .all() as Array<{ id: string; bytes_served: number; completed_at: string | null; last_status: number | null; last_error: string | null }>;
  } finally { db.close(); }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Expected owned TCP fixture.");
  return `http://127.0.0.1:${address.port}`;
}

// The observed shutdown race queues terminal stream events after app.close has
// closed SQLite. Hold only those events to make that actual ordering deterministic;
// the response, socket shutdown, counter and delivered bytes remain real.
function deferTerminalEvents(source: Readable) {
  const emit = source.emit.bind(source);
  const queued: Array<[string | symbol, ...unknown[]]> = [];
  let delayed = true;
  source.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (delayed && ["end", "finish", "close", "error"].includes(String(event))) {
      queued.push([event, ...args]);
      return true;
    }
    return emit(event, ...args);
  }) as typeof source.emit;
  const drain = () => {
    delayed = false;
    for (const [event, ...args] of queued.splice(0)) emit(event, ...args);
  };
  terminalDrains.push(drain);
  return drain;
}

async function openHeldTransfer(kind: "web" | "node", bytes = Buffer.from("owned-partial"), exactLength = false) {
  let counted: Readable | undefined;
  let drain: (() => void) | undefined;
  const streams: Array<{ source: Readable; drain: () => void }> = [];
  const fixture = await setupApp(kind, (source) => {
    counted = source;
    drain = deferTerminalEvents(source);
    streams.push({ source, drain });
  }, exactLength ? bytes.length : 100_000);
  let upstreamResponse: import("node:http").ServerResponse | undefined;
  const upstream = createServer((_request, response) => {
    upstreamResponse = response;
    response.writeHead(200, { "content-type": "video/mp4" });
    response.write(bytes);
  });
  ownedServers.push(upstream);
  const upstreamUrl = await listen(upstream);
  const session = await createSession(fixture.app, fixture.headers, kind, upstreamUrl);
  const origin = await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  let response: IncomingMessage | undefined;
  const firstBytes = new Promise<Buffer>((resolve, reject) => {
    const request = get(`${origin}${session.path}`, { headers: fixture.headers }, (incoming) => {
      response = incoming;
      incoming.once("data", resolve);
      incoming.on("error", () => {});
    });
    request.once("error", reject);
  });
  if (kind === "node") fixture.nodeBody.push(bytes);
  expect(await firstBytes).toEqual(bytes);
  expect(counted).toBeInstanceOf(Readable);
  expect(drain).toBeTypeOf("function");
  expect(transferRows(fixture.databasePath)[0]?.bytes_served).toBe(0);
  return { ...fixture, bytes, session, counted: counted!, drain: drain!, response: response!, upstreamResponse, upstreamUrl, origin, streams };
}

describe("stream transfer shutdown accounting", () => {
  it.each(["web", "node"] as const)("preserves completed %s accounting without duplicating it at shutdown", async (kind) => {
    const fixture = await openHeldTransfer(kind, Buffer.from("complete-body"), true);
    if (kind === "web") fixture.upstreamResponse!.end();
    else fixture.nodeBody.push(null);
    await vi.waitFor(() => expect(fixture.counted.readableEnded).toBe(true));
    fixture.drain();
    const before = transferRows(fixture.databasePath)[0]!;
    expect(before.bytes_served).toBe(fixture.bytes.length);
    expect(before.completed_at).toEqual(expect.any(String));
    await fixture.app.close();
    expect(transferRows(fixture.databasePath)[0]).toEqual(before);
  });

  it.each(["web", "node"] as const)("settles held %s stream bytes before SQLite close and fences late terminal callbacks", async (kind) => {
    const fixture = await openHeldTransfer(kind);
    await fixture.app.close();
    expect(transferRows(fixture.databasePath)).toEqual([{
      id: fixture.session.id, bytes_served: fixture.bytes.length,
      completed_at: null, last_status: 200, last_error: null,
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => fixture.drain()).not.toThrow();
    expect(() => {
      fixture.counted.emit("end"); fixture.counted.emit("close");
      fixture.counted.emit("error", new Error("late stream failure"));
    }).not.toThrow();
    expect(transferRows(fixture.databasePath)[0]?.bytes_served).toBe(fixture.bytes.length);
    expect(transferRows(fixture.databasePath)[0]?.completed_at).toBeNull();
  });

  it("settles every pending transfer of one app exactly once", async () => {
    const fixture = await openHeldTransfer("web");
    const second = await createSession(fixture.app, fixture.headers, "web", fixture.upstreamUrl);
    await new Promise<void>((resolve, reject) => {
      const request = get(`${fixture.origin}${second.path}`, { headers: fixture.headers }, (response) => {
        response.once("data", () => resolve());
        response.on("error", () => {});
      });
      request.once("error", reject);
    });
    expect(fixture.streams).toHaveLength(2);
    await fixture.app.close();
    expect(transferRows(fixture.databasePath).map((row) => ({
      bytes: row.bytes_served, completed: row.completed_at, status: row.last_status,
    }))).toEqual([
      { bytes: fixture.bytes.length, completed: null, status: 200 },
      { bytes: fixture.bytes.length, completed: null, status: 200 },
    ]);
    for (const stream of fixture.streams) stream.drain();
    expect(transferRows(fixture.databasePath).map((row) => row.bytes_served))
      .toEqual([fixture.bytes.length, fixture.bytes.length]);
  });

  it("keeps another app's held transfer live when the first app closes", async () => {
    const first = await openHeldTransfer("web", Buffer.from("first-app"));
    const second = await openHeldTransfer("web", Buffer.from("second-app"));
    await first.app.close();
    expect(transferRows(first.databasePath)[0]?.bytes_served).toBe(first.bytes.length);
    expect(transferRows(second.databasePath)[0]?.bytes_served).toBe(0);
    second.upstreamResponse!.end("-completed");
    await vi.waitFor(() => expect(second.counted.readableEnded).toBe(true));
    second.drain();
    const row = transferRows(second.databasePath)[0]!;
    expect(row.bytes_served).toBe(second.bytes.length + Buffer.byteLength("-completed"));
    expect(row.completed_at).toEqual(expect.any(String));
    await second.app.close();
    expect(transferRows(second.databasePath)[0]).toEqual(row);
    first.drain();
  });

  it("retries a failed shutdown accounting write while SQLite remains open", async () => {
    const fixture = await openHeldTransfer("web");
    const prepare = DatabaseSync.prototype.prepare;
    let writes = 0;
    let openAtFailure = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (/UPDATE stream_sessions\s+SET bytes_served/.test(sql)) {
        writes += 1;
        if (writes === 1) {
          openAtFailure = this.isOpen;
          throw new Error("fixture accounting write failed");
        }
      }
      return prepare.call(this, sql);
    });
    const close = vi.spyOn(AppDatabase.prototype, "close");
    await fixture.app.close();
    expect(openAtFailure).toBe(true);
    expect(writes).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(transferRows(fixture.databasePath)[0]?.bytes_served).toBe(fixture.bytes.length);
    fixture.drain();
  });
});
