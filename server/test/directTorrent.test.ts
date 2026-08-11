import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createDirectTorrentDhtRpc,
  DIRECT_TORRENT_BLOCKLIST,
  DirectTorrentRegistry,
  filterDirectTorrentCompactNodes,
  hardenDirectTorrentDhtRpc,
  installDirectTorrentTcpGuard,
  selectDirectTorrentFile,
  type DirectTorrentAdapter,
  type DirectTorrentDhtRpc,
  type DirectTorrentFile,
} from "../src/directTorrent.js";
import { loadConfig } from "../src/config.js";

function file(name: string, length: number): DirectTorrentFile {
  return {
    name,
    length,
    createReadStream: () => Readable.from("x"),
  };
}

function compactNode(id: number, host: string, port = 6881): Buffer {
  const octets = host.split(".").map(Number);
  const node = Buffer.alloc(26, id);
  for (let index = 0; index < 4; index += 1) node[20 + index] = octets[index]!;
  node.writeUInt16BE(port, 24);
  return node;
}

describe("DirectTorrentRegistry", () => {
  it("selects the requested episode from actual metadata before size", () => {
    const selected = selectDirectTorrentFile([
      file("Show.S02E04.2160p.mkv", 20_000),
      file("Show.S02E05.1080p.mp4", 5_000),
      file("sample.mp4", 30_000),
    ], { season: 2, episode: 5 });
    expect(selected?.name).toBe("Show.S02E05.1080p.mp4");
  });

  it("never selects a tagged subtitle or other non-video file", () => {
    const selected = selectDirectTorrentFile([
      file("Show.S02E05.en.srt", 50_000),
      file("Show.Season.2.1080p.mkv", 5_000_000),
    ], { season: 2, episode: 5 });
    expect(selected).toBeNull();
    expect(selectDirectTorrentFile([file("notes.txt", 100)], null)).toBeNull();
  });

  it("rejects inbound private addresses at the pinned WebTorrent TCP hook", async () => {
    const { default: WebTorrent } = await import("webtorrent");
    const client = new WebTorrent({
      dht: false,
      tracker: false,
      lsd: false,
      utp: false,
      natUpnp: false,
      natPmp: false,
    });
    installDirectTorrentTcpGuard(client as never, 1);
    if (!client.listening) {
      await new Promise<void>((resolve) => client.once("listening", resolve));
    }
    const address = client.address();
    expect(address).not.toBeNull();
    const socket = createConnection({ host: "127.0.0.1", port: address!.port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Inbound socket was not rejected.")), 2_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      client.destroy((error) => error == null ? resolve() : reject(error));
    });
  });

  it("caps pending plus established inbound sockets and releases capacity on close", () => {
    class FakeSocket extends EventEmitter {
      destroyed = false;

      constructor(readonly remoteAddress?: string) {
        super();
      }

      destroy(): void {
        this.destroyed = true;
        this.emit("close");
      }
    }

    const tcpServer = new EventEmitter();
    const accepted = vi.fn();
    tcpServer.on("connection", accepted);
    installDirectTorrentTcpGuard({
      _connPool: { tcpServer, _onTCPConnectionBound: accepted },
    }, 1);

    const first = new FakeSocket("8.8.8.8");
    const overLimit = new FakeSocket("1.1.1.1");
    const privateMapped = new FakeSocket("::ffff:192.168.1.8");
    const malformed = new FakeSocket("999.1.1.1");
    tcpServer.emit("connection", first);
    tcpServer.emit("connection", overLimit);
    tcpServer.emit("connection", privateMapped);
    tcpServer.emit("connection", malformed);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(first.destroyed).toBe(false);
    expect(overLimit.destroyed).toBe(true);
    expect(privateMapped.destroyed).toBe(true);
    expect(malformed.destroyed).toBe(true);

    first.emit("close");
    const afterClose = new FakeSocket("9.9.9.9");
    tcpServer.emit("connection", afterClose);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(afterClose.destroyed).toBe(false);
  });

  it("blocks representative local and special-use IPv4 peer ranges", () => {
    expect(DIRECT_TORRENT_BLOCKLIST).toEqual(expect.arrayContaining([
      { start: "10.0.0.0", end: "10.255.255.255" },
      { start: "127.0.0.0", end: "127.255.255.255" },
      { start: "169.254.0.0", end: "169.254.255.255" },
      { start: "192.168.0.0", end: "192.168.255.255" },
      { start: "224.0.0.0", end: "255.255.255.255" },
    ]));
  });

  it("filters hostile compact routing nodes before k-rpc can query them", async () => {
    class FakeDhtSocket extends EventEmitter {
      inflight = 0;
      readonly queried: string[] = [];

      query(
        peer: { host?: string; address?: string; port?: number },
        _message: unknown,
        callback?: (error: Error | null, response: unknown, peer: unknown) => void,
      ): void {
        const host = peer.host ?? peer.address ?? "";
        this.queried.push(host);
        const response = {
          r: {
            id: Buffer.alloc(20, host === "9.9.9.9" ? 2 : 3),
            nodes: host === "9.9.9.9"
              ? Buffer.concat([
                compactNode(4, "127.0.0.1"),
                compactNode(5, "169.254.169.254"),
                compactNode(6, "8.8.8.8"),
              ])
              : Buffer.alloc(0),
          },
        };
        queueMicrotask(() => {
          callback?.(null, response, peer);
          this.emit("update");
          this.emit("postupdate");
          this.emit("response", response, peer);
        });
      }

      send(): void {}

      bind(): void {}

      address(): { address: string; family: string; port: number } {
        return { address: "0.0.0.0", family: "IPv4", port: 0 };
      }

      destroy(callback?: () => void): void {
        callback?.();
      }
    }

    const socket = new FakeDhtSocket();
    const rpc = createDirectTorrentDhtRpc({
      nodeId: Buffer.alloc(20, 1),
      nodes: [{ host: "9.9.9.9", port: 6881 }],
      krpcSocket: socket,
    });
    const routingNodes = rpc.nodes as unknown as {
      add(node: { id: Buffer; host: string; port: number }): void;
      remove(id: Buffer): void;
      toArray(): Array<{ host: string }>;
    };
    const publicNodeId = Buffer.alloc(20, 8);
    routingNodes.add({ id: Buffer.alloc(20, 7), host: "192.168.1.20", port: 6881 });
    routingNodes.add({ id: publicNodeId, host: "1.1.1.1", port: 6881 });
    expect(routingNodes.toArray().map((node) => node.host)).toEqual(["1.1.1.1"]);
    routingNodes.remove(publicNodeId);

    await new Promise<void>((resolve, reject) => {
      (rpc.populate as (
        target: Buffer,
        message: unknown,
        callback: (error?: Error | null) => void,
      ) => void)(Buffer.alloc(20, 9), { q: "find_node", a: {} }, (error) => {
        error == null ? resolve() : reject(error);
      });
    });

    expect(socket.queried).toEqual(expect.arrayContaining(["8.8.8.8", "9.9.9.9"]));
    expect(socket.queried).not.toContain("127.0.0.1");
    expect(socket.queried).not.toContain("169.254.169.254");
    await new Promise<void>((resolve) => rpc.destroy(resolve));
  });

  it("checks resolved bootstrap addresses and every UDP send fail closed", async () => {
    const sent: string[] = [];
    const queried: string[] = [];
    const socket = {
      query: vi.fn(function query(
        this: typeof socket,
        node: { host?: string; address?: string; port?: number },
        message: unknown,
        callback?: (error?: Error | null) => void,
      ) {
        const host = node.host ?? node.address ?? "";
        queried.push(host);
        if (host === "public-bootstrap.example") {
          return this.query({ host: "8.8.4.4", port: node.port }, message, callback);
        }
        if (host === "private-bootstrap.example") {
          return this.query({ host: "10.0.0.2", port: node.port }, message, callback);
        }
        callback?.(null);
      }),
      send: vi.fn((node: { host?: string; address?: string }) => {
        sent.push(node.host ?? node.address ?? "");
      }),
    };
    const added: string[] = [];
    const rpc = hardenDirectTorrentDhtRpc({
      socket,
      nodes: {
        add(node) {
          added.push(node.host ?? node.address ?? "");
        },
      },
      clear() {},
      destroy() {},
    } as DirectTorrentDhtRpc);

    const publicError = await new Promise<Error | null>((resolve) => {
      rpc.socket.query(
        { host: "public-bootstrap.example", port: 6881 },
        {},
        (error) => resolve(error ?? null),
      );
    });
    const privateError = await new Promise<Error | null>((resolve) => {
      rpc.socket.query(
        { host: "private-bootstrap.example", port: 6881 },
        {},
        (error) => resolve(error ?? null),
      );
    });
    const ipv6Error = await new Promise<Error | null>((resolve) => {
      rpc.socket.query({ host: "::1", port: 6881 }, {}, (error) => resolve(error ?? null));
    });
    const malformedError = await new Promise<Error | null>((resolve) => {
      rpc.socket.query({ host: "999.1.1.1", port: 6881 }, {}, (error) => resolve(error ?? null));
    });
    rpc.socket.send({ host: "127.0.0.1", port: 6881 }, {});
    rpc.socket.send({ host: "::1", port: 6881 }, {});
    rpc.socket.send({ host: "8.8.8.8", port: 6881 }, {});
    rpc.nodes.add({ id: Buffer.alloc(20), host: "203.0.113.8", port: 6881 });
    rpc.nodes.add({ id: Buffer.alloc(20), host: "9.9.9.9", port: 6881 });

    expect(publicError).toBeNull();
    expect(privateError).toMatchObject({ code: "EDHTBLOCKED" });
    expect(ipv6Error).toMatchObject({ code: "EDHTBLOCKED" });
    expect(malformedError).toMatchObject({ code: "EDHTBLOCKED" });
    expect(queried).toEqual([
      "public-bootstrap.example", "8.8.4.4", "private-bootstrap.example",
    ]);
    expect(sent).toEqual(["8.8.8.8"]);
    expect(added).toEqual(["9.9.9.9"]);
  });

  it("fails malformed compact routing nodes closed while retaining public IPv4", () => {
    const publicNode = compactNode(1, "8.8.8.8");
    expect(filterDirectTorrentCompactNodes(Buffer.concat([
      compactNode(2, "10.1.2.3"),
      publicNode,
      compactNode(3, "224.0.0.1"),
    ]))).toEqual(publicNode);
    expect(filterDirectTorrentCompactNodes(Buffer.alloc(25))).toEqual(Buffer.alloc(0));
  });

  it("shares a hash and releases its handle after the final session", async () => {
    const destroy = vi.fn(async () => {});
    const adapter: DirectTorrentAdapter = {
      open: vi.fn(async (infoHash) => ({
        infoHash,
        files: [file("Movie.mp4", 10)],
        destroy,
      })),
      close: vi.fn(async () => {}),
    };
    const config = loadConfig({
      databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      enableDirectTorrent: true, directTorrentIdleTimeoutMs: 10_000,
    });
    const registry = new DirectTorrentRegistry(adapter, config);
    const hash = "a".repeat(40);
    await registry.register({
      sessionId: "one", profileId: "profile", infoHash: hash,
      expiresInSeconds: 60, fileHint: null,
    });
    await registry.register({
      sessionId: "two", profileId: "profile", infoHash: hash,
      expiresInSeconds: 60, fileHint: null,
    });
    expect(adapter.open).toHaveBeenCalledTimes(1);
    await registry.release("one");
    expect(destroy).not.toHaveBeenCalled();
    await registry.release("two");
    expect(destroy).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("coalesces concurrent metadata opens for the same hash", async () => {
    let finishOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const destroy = vi.fn(async () => {});
    const adapter: DirectTorrentAdapter = {
      open: vi.fn(async (infoHash) => {
        await opened;
        return { infoHash, files: [file("Movie.mp4", 10)], destroy };
      }),
      close: vi.fn(async () => {}),
    };
    const config = loadConfig({
      databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      enableDirectTorrent: true, directTorrentIdleTimeoutMs: 10_000,
    });
    const registry = new DirectTorrentRegistry(adapter, config);
    const input = {
      infoHash: "b".repeat(40),
      expiresInSeconds: 60,
      fileHint: null,
    };
    const first = registry.register({ ...input, sessionId: "one", profileId: "profile" });
    const second = registry.register({ ...input, sessionId: "two", profileId: "profile" });
    expect(adapter.open).toHaveBeenCalledTimes(1);
    finishOpen?.();
    await Promise.all([first, second]);
    await registry.release("one");
    await registry.release("two");
    expect(destroy).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("destroys an unplayable shared handle only once", async () => {
    const destroy = vi.fn(async () => {});
    const adapter: DirectTorrentAdapter = {
      open: vi.fn(async (infoHash) => ({
        infoHash,
        files: [file("readme.txt", 10)],
        destroy,
      })),
      close: vi.fn(async () => {}),
    };
    const config = loadConfig({
      databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      enableDirectTorrent: true, directTorrentIdleTimeoutMs: 10_000,
    });
    const registry = new DirectTorrentRegistry(adapter, config);
    const input = {
      infoHash: "c".repeat(40),
      expiresInSeconds: 60,
      fileHint: null,
    };
    const results = await Promise.allSettled([
      registry.register({ ...input, sessionId: "one", profileId: "profile" }),
      registry.register({ ...input, sessionId: "two", profileId: "profile" }),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("bounds pending and active sessions globally and per profile", async () => {
    let finishOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => { finishOpen = resolve; });
    const destroy = vi.fn(async () => {});
    const adapter: DirectTorrentAdapter = {
      open: vi.fn(async (infoHash) => {
        await opened;
        return { infoHash, files: [file("Movie.mp4", 10)], destroy };
      }),
      close: vi.fn(async () => {}),
    };
    const config = loadConfig({
      databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      enableDirectTorrent: true, directTorrentMaxSessions: 2,
      directTorrentMaxSessionsPerProfile: 1,
    });
    const registry = new DirectTorrentRegistry(adapter, config);
    const input = {
      infoHash: "e".repeat(40), expiresInSeconds: 60, fileHint: null,
    };
    const first = registry.register({ ...input, sessionId: "one", profileId: "profile-one" });
    await expect(registry.register({
      ...input, sessionId: "same-profile", profileId: "profile-one",
    })).rejects.toMatchObject({ statusCode: 429 });
    const second = registry.register({ ...input, sessionId: "two", profileId: "profile-two" });
    await expect(registry.register({
      ...input, sessionId: "global", profileId: "profile-three",
    })).rejects.toMatchObject({ statusCode: 503 });
    expect(adapter.open).toHaveBeenCalledTimes(1);

    finishOpen?.();
    await Promise.all([first, second]);
    await registry.release("one");
    const sequential = await registry.register({
      ...input, sessionId: "sequential", profileId: "profile-one",
    });
    expect(sequential.sessionId).toBe("sequential");
    await registry.release("two");
    await registry.release("sequential");
    expect(destroy).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("releases a pending reservation when registration is cancelled", async () => {
    let finishOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => { finishOpen = resolve; });
    const destroy = vi.fn(async () => {});
    const adapter: DirectTorrentAdapter = {
      async open(infoHash) {
        await opened;
        return { infoHash, files: [file("Movie.mp4", 10)], destroy };
      },
      close: vi.fn(async () => {}),
    };
    const registry = new DirectTorrentRegistry(adapter, loadConfig({
      databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      directTorrentMaxSessions: 1, directTorrentMaxSessionsPerProfile: 1,
    }));
    const input = {
      infoHash: "f".repeat(40), expiresInSeconds: 60, fileHint: null,
    };
    const cancelled = registry.register({
      ...input, sessionId: "cancelled", profileId: "profile",
    });
    await registry.release("cancelled");
    const replacement = registry.register({
      ...input, sessionId: "replacement", profileId: "profile",
    });
    finishOpen?.();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(replacement).resolves.toMatchObject({ sessionId: "replacement" });
    expect(destroy).not.toHaveBeenCalled();
    await registry.release("replacement");
    expect(destroy).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("bounds Direct P2P session limits from environment configuration", () => {
    const globalName = "DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS";
    const profileName = "DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS_PER_PROFILE";
    const previousGlobal = process.env[globalName];
    const previousProfile = process.env[profileName];
    try {
      process.env[globalName] = "999";
      process.env[profileName] = "-20";
      const config = loadConfig({
        databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      });
      expect(config.directTorrentMaxSessions).toBe(64);
      expect(config.directTorrentMaxSessionsPerProfile).toBe(1);
      process.env[globalName] = "not-a-number";
      process.env[profileName] = "3.9";
      const reparsed = loadConfig({
        databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
      });
      expect(reparsed.directTorrentMaxSessions).toBe(8);
      expect(reparsed.directTorrentMaxSessionsPerProfile).toBe(3);
    } finally {
      if (previousGlobal == null) delete process.env[globalName];
      else process.env[globalName] = previousGlobal;
      if (previousProfile == null) delete process.env[profileName];
      else process.env[profileName] = previousProfile;
    }
  });

  it("does not touch an injected adapter while the operator flag is off", async () => {
    const adapter: DirectTorrentAdapter = {
      open: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const app = await buildApp({
      config: {
        databasePath: ":memory:", dataDir: ".test-data", secretKey: randomBytes(32),
        cookieSecure: false, logger: false, enableDirectTorrent: false,
      },
      directTorrentAdapter: adapter,
    });
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect((JSON.parse(bootstrap.body) as { directTorrentAvailable: boolean }).directTorrentAvailable)
      .toBe(false);
    await app.close();
    expect(adapter.open).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled();
  });
});
