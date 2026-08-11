import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import type { EventEmitter } from "node:events";
// k-rpc does not publish TypeScript declarations. This direct, pinned
// dependency is the routing layer used by the locked bittorrent-dht version.
// @ts-expect-error No declarations are published by k-rpc.
import createKrpc from "k-rpc";
import type { ServerConfig } from "./types.js";

export interface DirectTorrentFile {
  name: string;
  length: number;
  createReadStream(options?: { start?: number; end?: number }): NodeJS.ReadableStream;
}

export interface DirectTorrentHandle {
  infoHash: string;
  files: DirectTorrentFile[];
  destroy(): Promise<void>;
}

/** Test seam for Direct P2P. Tests inject metadata and streams without ever
 * loading WebTorrent or joining a swarm. */
export interface DirectTorrentAdapter {
  open(infoHash: string): Promise<DirectTorrentHandle>;
  close(): Promise<void>;
}

export interface DirectTorrentSession {
  sessionId: string;
  infoHash: string;
  file: DirectTorrentFile;
  expiresAt: string;
}

interface ActiveTorrent {
  handle: DirectTorrentHandle;
  sessionIds: Set<string>;
}

interface RegisteredSession extends DirectTorrentSession {
  expiresAtMs: number;
  idleAtMs: number;
}

interface SessionReservation {
  profileId: string;
  infoHash: string;
}

interface InboundSocket extends EventEmitter {
  remoteAddress?: string;
  destroy(error?: Error): void;
}

interface WebTorrentConnectionPool {
  tcpServer: EventEmitter;
  _onTCPConnectionBound: (socket: InboundSocket) => void;
}

interface WebTorrentWithConnectionPool {
  _connPool?: WebTorrentConnectionPool;
}

/** Private, special-use, documentation, multicast, and reserved IPv4 ranges.
 * DHT peer responses in the supported WebTorrent path are IPv4 compact peers.
 * Blocking them prevents a poisoned source from turning a swarm join into a
 * connection attempt against the server operator's local network. */
export const DIRECT_TORRENT_BLOCKLIST: Array<{ start: string; end: string }> = [
  { start: "0.0.0.0", end: "0.255.255.255" },
  { start: "10.0.0.0", end: "10.255.255.255" },
  { start: "100.64.0.0", end: "100.127.255.255" },
  { start: "127.0.0.0", end: "127.255.255.255" },
  { start: "169.254.0.0", end: "169.254.255.255" },
  { start: "172.16.0.0", end: "172.31.255.255" },
  { start: "192.0.0.0", end: "192.0.0.255" },
  { start: "192.0.2.0", end: "192.0.2.255" },
  { start: "192.31.196.0", end: "192.31.196.255" },
  { start: "192.52.193.0", end: "192.52.193.255" },
  { start: "192.88.99.0", end: "192.88.99.255" },
  { start: "192.168.0.0", end: "192.168.255.255" },
  { start: "192.175.48.0", end: "192.175.48.255" },
  { start: "198.18.0.0", end: "198.19.255.255" },
  { start: "198.51.100.0", end: "198.51.100.255" },
  { start: "203.0.113.0", end: "203.0.113.255" },
  { start: "224.0.0.0", end: "255.255.255.255" },
];

interface DhtNode {
  id?: Buffer;
  host?: string;
  address?: string;
  port?: number;
  [key: string]: unknown;
}

type DhtQueryCallback = (
  error?: Error | null,
  response?: { r?: { nodes?: Buffer; [key: string]: unknown }; [key: string]: unknown } | null,
  peer?: DhtNode,
  request?: unknown,
) => void;

interface DhtSocket {
  query(node: DhtNode, message: unknown, callback?: DhtQueryCallback): unknown;
  send(node: DhtNode, message: unknown, callback?: (error?: Error | null) => void): unknown;
}

interface DhtRoutingBucket {
  add(node: DhtNode): unknown;
}

export interface DirectTorrentDhtRpc {
  socket: DhtSocket;
  nodes: DhtRoutingBucket;
  clear(): void;
  destroy(callback?: () => void): void;
  [key: string]: unknown;
}

const IPV4_BLOCK_RANGES = DIRECT_TORRENT_BLOCKLIST.map(({ start, end }) => ({
  start: ipv4Number(start),
  end: ipv4Number(end),
}));
const hardenedDhtRpcs = new WeakSet<object>();
const hardenedDhtBuckets = new WeakSet<object>();

function ipv4Number(host: string): number {
  const octets = host.split(".").map(Number);
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0;
}

function isPublicIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const value = ipv4Number(host);
  return !IPV4_BLOCK_RANGES.some((range) => value >= range.start && value <= range.end);
}

function inboundIpv4(host: string | undefined): string | null {
  if (host == null || host.length === 0) return null;
  if (isIP(host) === 4) return host;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)?.[1];
  return mapped != null && isIP(mapped) === 4 ? mapped : null;
}

function rejectInboundSocket(socket: InboundSocket): void {
  socket.on("error", () => {});
  socket.destroy();
}

/** Install a fail-closed guard around WebTorrent 3.0.21's TCP accept hook.
 * Every accepted socket remains counted until close, including sockets that
 * have completed their BitTorrent handshake. */
export function installDirectTorrentTcpGuard(
  client: WebTorrentWithConnectionPool,
  maxInboundConnections: number,
): void {
  const pool = client._connPool;
  if (
    pool == null
    || pool.tcpServer == null
    || typeof pool._onTCPConnectionBound !== "function"
  ) {
    throw new Error("Unsupported WebTorrent TCP connection pool.");
  }
  const tcpServer = pool.tcpServer;
  const delegate = pool._onTCPConnectionBound;
  const listeners = tcpServer.listeners("connection");
  if (listeners.length !== 1 || listeners[0] !== delegate) {
    throw new Error("Unsupported WebTorrent TCP connection listener layout.");
  }
  if (!Number.isInteger(maxInboundConnections) || maxInboundConnections < 1) {
    throw new Error("Invalid Direct P2P inbound connection limit.");
  }
  tcpServer.removeListener("connection", delegate);
  const accepted = new Set<InboundSocket>();
  tcpServer.on("connection", (socket: InboundSocket) => {
    const host = inboundIpv4(socket.remoteAddress);
    if (host == null || !isPublicIpv4(host) || accepted.size >= maxInboundConnections) {
      rejectInboundSocket(socket);
      return;
    }
    accepted.add(socket);
    socket.once("close", () => accepted.delete(socket));
    try {
      delegate(socket);
    } catch {
      accepted.delete(socket);
      rejectInboundSocket(socket);
    }
  });
}

function dhtHost(node: DhtNode): string | null {
  const host = node.host ?? node.address;
  return typeof host === "string" && host.length > 0 ? host : null;
}

function isResolvableDhtHostname(host: string): boolean {
  if (host.length > 253 || /^[0-9.]+$/.test(host)) return false;
  return host.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function blockedDhtDestinationError(): Error {
  return Object.assign(new Error("Blocked Direct P2P DHT destination."), {
    code: "EDHTBLOCKED",
  });
}

/** Remove private and special-use IPv4 contacts from a BEP 5 compact node
 * response before k-rpc can add them to its traversal table. Malformed buffers
 * fail closed because no partial contact is safe to interpret. */
export function filterDirectTorrentCompactNodes(nodes: Buffer, idLength = 20): Buffer {
  const contactLength = idLength + 6;
  if (contactLength <= 6 || nodes.length % contactLength !== 0) return Buffer.alloc(0);
  const allowed: Buffer[] = [];
  for (let offset = 0; offset < nodes.length; offset += contactLength) {
    const host = [
      nodes[offset + idLength],
      nodes[offset + idLength + 1],
      nodes[offset + idLength + 2],
      nodes[offset + idLength + 3],
    ].join(".");
    if (isPublicIpv4(host)) allowed.push(nodes.subarray(offset, offset + contactLength));
  }
  return allowed.length * contactLength === nodes.length
    ? nodes
    : Buffer.concat(allowed);
}

function guardRoutingBucket(bucket: DhtRoutingBucket): void {
  if (hardenedDhtBuckets.has(bucket)) return;
  hardenedDhtBuckets.add(bucket);
  const add = bucket.add;
  bucket.add = function guardedAdd(node) {
    const host = dhtHost(node);
    if (host == null || !isPublicIpv4(host)) return undefined;
    return add.call(this, node);
  };
}

/** Harden the exact k-rpc boundary used by bittorrent-dht 11.0.12.
 * Hostnames are permitted only long enough for k-rpc-socket to resolve them;
 * its recursive numeric query is checked again before any UDP send. */
export function hardenDirectTorrentDhtRpc(rpc: DirectTorrentDhtRpc): DirectTorrentDhtRpc {
  if (hardenedDhtRpcs.has(rpc)) return rpc;
  hardenedDhtRpcs.add(rpc);

  const socket = rpc.socket;
  const query = socket.query;
  socket.query = function guardedQuery(node, message, callback) {
    const host = dhtHost(node);
    const version = host == null ? -1 : isIP(host);
    if (
      host == null
      || version === 6
      || (version === 4 && !isPublicIpv4(host))
      || (version === 0 && !isResolvableDhtHostname(host))
    ) {
      const error = blockedDhtDestinationError();
      queueMicrotask(() => callback?.(error, null, node));
      return undefined;
    }
    return query.call(this, node, message, (error, response, peer, request) => {
      const compactNodes = response?.r?.nodes;
      if (Buffer.isBuffer(compactNodes)) {
        response!.r!.nodes = filterDirectTorrentCompactNodes(compactNodes);
      }
      callback?.(error, response, peer, request);
    });
  };

  const send = socket.send;
  socket.send = function guardedSend(node, message, callback) {
    const host = dhtHost(node);
    if (host == null || !isPublicIpv4(host)) {
      const error = blockedDhtDestinationError();
      queueMicrotask(() => callback?.(error));
      return undefined;
    }
    return send.call(this, node, message, callback);
  };

  guardRoutingBucket(rpc.nodes);
  const clear = rpc.clear;
  rpc.clear = function guardedClear() {
    clear.call(this);
    guardRoutingBucket(this.nodes);
  };
  return rpc;
}

export function createDirectTorrentDhtRpc(
  options: Record<string, unknown> = {},
): DirectTorrentDhtRpc {
  return hardenDirectTorrentDhtRpc(createKrpc({ ...options, idLength: 20 }) as DirectTorrentDhtRpc);
}

const VIDEO_EXTENSIONS = new Set([
  "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "mpg", "mpeg", "wmv", "flv",
]);
const SAMPLE_HINTS = [
  "sample", "trailer", "featurette", "extras", "behindthescenes", "commentary", "soundtrack",
];

function episodeTag(name: string): { season: number; episode: number } | null {
  const upper = name.toUpperCase();
  const se = upper.match(/S(\d{1,2})[ ._-]?E(\d{1,3})/);
  if (se != null) return { season: Number(se[1]), episode: Number(se[2]) };
  const x = upper.match(/\b(\d{1,2})X(?!26[45]\b)(\d{2,3})\b/);
  return x == null ? null : { season: Number(x[1]), episode: Number(x[2]) };
}

function fileScore(file: DirectTorrentFile): readonly [number, number, number, number, string] {
  const lower = file.name.toLowerCase();
  const extension = lower.split(".").at(-1) ?? "";
  const isVideo = VIDEO_EXTENSIONS.has(extension) ? 1 : 0;
  const isSample = SAMPLE_HINTS.some((hint) => lower.includes(hint)) ? 1 : 0;
  const container = ["mp4", "m4v", "mov"].includes(extension)
    ? 6
    : extension === "mkv"
      ? 5
      : ["ts", "m2ts", "mpg", "mpeg"].includes(extension)
        ? 4
        : extension === "webm"
          ? 3
          : ["avi", "wmv", "flv"].includes(extension) ? 2 : 0;
  return [isVideo, -isSample, container, file.length, file.name];
}

function compareScore(left: DirectTorrentFile, right: DirectTorrentFile): number {
  const a = fileScore(left);
  const b = fileScore(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

/** Select from real torrent metadata, using the same video/sample/container/
 * size priorities as DebridFileSelector and its exact episode-tag rule. */
export function selectDirectTorrentFile(
  files: DirectTorrentFile[],
  hint: { season: number; episode: number } | null,
): DirectTorrentFile | null {
  let pool = files.filter((file) => {
    const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
    return file.length > 0 && VIDEO_EXTENSIONS.has(extension);
  });
  if (hint != null) {
    const matching = pool.filter((file) => {
      const tag = episodeTag(file.name);
      return tag?.season === hint.season && tag.episode === hint.episode;
    });
    if (matching.length === 0) return null;
    pool = matching;
  }
  return pool.reduce<DirectTorrentFile | null>(
    (best, file) => best == null || compareScore(file, best) > 0 ? file : best,
    null,
  );
}

export class DirectTorrentRegistry {
  private readonly torrents = new Map<string, ActiveTorrent>();
  private readonly opening = new Map<string, Promise<ActiveTorrent>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly reservations = new Map<string, SessionReservation>();
  private readonly profileReservationCounts = new Map<string, number>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  private closeActiveTorrent(infoHash: string, active: ActiveTorrent): Promise<void> {
    const pending = this.closing.get(infoHash);
    if (pending != null) return pending;
    if (
      this.torrents.get(infoHash) !== active
      || active.sessionIds.size > 0
      || [...this.reservations.values()].some((reservation) => reservation.infoHash === infoHash)
    ) {
      return Promise.resolve();
    }
    this.torrents.delete(infoHash);
    const closing = active.handle.destroy().finally(() => {
      if (this.closing.get(infoHash) === closing) this.closing.delete(infoHash);
    });
    this.closing.set(infoHash, closing);
    return closing;
  }

  constructor(
    private readonly adapter: DirectTorrentAdapter,
    private readonly config: ServerConfig,
    private readonly onRelease?: (sessionId: string) => void,
  ) {
    this.sweepTimer = setInterval(
      () => void this.sweep(),
      Math.min(60_000, Math.max(1_000, Math.floor(config.directTorrentIdleTimeoutMs / 4))),
    );
    this.sweepTimer.unref();
  }

  private reserve(
    sessionId: string,
    profileId: string,
    infoHash: string,
  ): SessionReservation {
    if (this.reservations.has(sessionId)) {
      throw Object.assign(new Error("The Direct P2P session is already registered."), {
        statusCode: 409,
      });
    }
    if (this.reservations.size >= this.config.directTorrentMaxSessions) {
      throw Object.assign(new Error("The Direct P2P server is at its session limit."), {
        statusCode: 503,
      });
    }
    const profileCount = this.profileReservationCounts.get(profileId) ?? 0;
    if (profileCount >= this.config.directTorrentMaxSessionsPerProfile) {
      throw Object.assign(new Error("This profile is at its Direct P2P session limit."), {
        statusCode: 429,
      });
    }
    const reservation = { profileId, infoHash };
    this.reservations.set(sessionId, reservation);
    this.profileReservationCounts.set(profileId, profileCount + 1);
    return reservation;
  }

  private releaseReservation(
    sessionId: string,
    expected?: SessionReservation,
  ): boolean {
    const reservation = this.reservations.get(sessionId);
    if (reservation == null || (expected != null && reservation !== expected)) return false;
    this.reservations.delete(sessionId);
    const profileCount = this.profileReservationCounts.get(reservation.profileId) ?? 0;
    if (profileCount <= 1) this.profileReservationCounts.delete(reservation.profileId);
    else this.profileReservationCounts.set(reservation.profileId, profileCount - 1);
    return true;
  }

  async register(input: {
    sessionId: string;
    profileId: string;
    infoHash: string;
    expiresInSeconds: number;
    fileHint: { season: number; episode: number } | null;
  }): Promise<DirectTorrentSession> {
    if (!/^[a-f0-9]{40}$/.test(input.infoHash)) throw new Error("Invalid torrent hash.");
    if (this.closed) throw new Error("Direct P2P is shutting down.");
    const reservation = this.reserve(input.sessionId, input.profileId, input.infoHash);
    let active: ActiveTorrent | undefined;
    let registered = false;
    try {
      const closing = this.closing.get(input.infoHash);
      if (closing != null) await closing;
      if (this.closed || this.reservations.get(input.sessionId) !== reservation) {
        throw new Error("Direct P2P registration was cancelled.");
      }
      active = this.torrents.get(input.infoHash);
      if (active == null) {
        let pending = this.opening.get(input.infoHash);
        if (pending == null) {
          if (this.torrents.size + this.opening.size >= this.config.directTorrentMaxActive) {
            throw Object.assign(new Error("The Direct P2P server is at its active torrent limit."), {
              statusCode: 503,
            });
          }
          pending = this.adapter.open(input.infoHash).then(async (handle) => {
            if (handle.infoHash.toLowerCase() !== input.infoHash) {
              await handle.destroy();
              throw new Error("Torrent metadata did not match the requested hash.");
            }
            const opened = { handle, sessionIds: new Set<string>() };
            this.torrents.set(input.infoHash, opened);
            return opened;
          }).finally(() => {
            this.opening.delete(input.infoHash);
          });
          this.opening.set(input.infoHash, pending);
        }
        active = await pending;
        if (this.closed || this.reservations.get(input.sessionId) !== reservation) {
          throw new Error("Direct P2P registration was cancelled.");
        }
      }
      const file = selectDirectTorrentFile(active.handle.files, input.fileHint);
      if (file == null) {
        throw Object.assign(new Error(
          input.fileHint == null
            ? "The torrent metadata contains no playable file."
            : "The torrent metadata contains no playable file for the requested episode.",
        ), { statusCode: 422 });
      }
      const now = Date.now();
      const expiresAtMs = now + input.expiresInSeconds * 1_000;
      const session: RegisteredSession = {
        sessionId: input.sessionId,
        infoHash: input.infoHash,
        file,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        idleAtMs: now + this.config.directTorrentIdleTimeoutMs,
      };
      active.sessionIds.add(input.sessionId);
      this.sessions.set(input.sessionId, session);
      const expiryTimer = setTimeout(
        () => void this.release(input.sessionId).catch(() => {}),
        Math.max(0, session.expiresAtMs - Date.now()),
      );
      expiryTimer.unref();
      this.expiryTimers.set(input.sessionId, expiryTimer);
      registered = true;
      return session;
    } catch (error) {
      this.releaseReservation(input.sessionId, reservation);
      if (active != null) await this.closeActiveTorrent(input.infoHash, active);
      throw error;
    } finally {
      if (!registered) this.releaseReservation(input.sessionId, reservation);
    }
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session == null) return;
    session.idleAtMs = Date.now() + this.config.directTorrentIdleTimeoutMs;
  }

  get(sessionId: string): DirectTorrentSession | null {
    const session = this.sessions.get(sessionId);
    if (session == null) return null;
    if (session.expiresAtMs <= Date.now()) {
      void this.release(sessionId).catch(() => {});
      return null;
    }
    this.touch(sessionId);
    return session;
  }

  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session == null) {
      this.releaseReservation(sessionId);
      return;
    }
    this.sessions.delete(sessionId);
    this.releaseReservation(sessionId);
    try {
      this.onRelease?.(sessionId);
    } catch {
      // Registry cleanup must not leave peer sockets alive because an optional
      // persistence callback failed during shutdown or idle cleanup.
    }
    const expiryTimer = this.expiryTimers.get(sessionId);
    if (expiryTimer != null) clearTimeout(expiryTimer);
    this.expiryTimers.delete(sessionId);
    const active = this.torrents.get(session.infoHash);
    if (active == null) return;
    active.sessionIds.delete(sessionId);
    await this.closeActiveTorrent(session.infoHash, active);
  }

  async sweep(now = Date.now()): Promise<void> {
    const stale = [...this.sessions.values()]
      .filter((session) => session.expiresAtMs <= now || session.idleAtMs <= now)
      .map((session) => session.sessionId);
    await Promise.allSettled(stale.map((sessionId) => this.release(sessionId)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    await Promise.allSettled(this.opening.values());
    await Promise.allSettled([
      ...this.closing.values(),
      ...[...this.torrents.values()].map((active) => active.handle.destroy()),
    ]);
    this.torrents.clear();
    for (const sessionId of this.sessions.keys()) {
      try {
        this.onRelease?.(sessionId);
      } catch {
        // Best effort while the engine and application are closing.
      }
    }
    this.sessions.clear();
    this.reservations.clear();
    this.profileReservationCounts.clear();
    await this.adapter.close();
  }
}

/** The production adapter is loaded only for an explicit operator opt-in. */
export async function createWebTorrentAdapter(config: ServerConfig): Promise<DirectTorrentAdapter> {
  const { default: WebTorrent } = await import("webtorrent");
  const root = join(config.dataDir, "direct-torrent");
  // Direct P2P has no durable-download promise. A process crash can leave an
  // orphaned piece store, so clear only this dedicated temporary root before
  // starting the explicitly enabled engine.
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const nodeId = randomBytes(20);
  const dhtRpc = createDirectTorrentDhtRpc({ nodeId });
  const client = new WebTorrent({
    nodeId,
    dht: { krpc: dhtRpc },
    tracker: false,
    lsd: false,
    utp: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    webSeeds: false,
    blocklist: DIRECT_TORRENT_BLOCKLIST,
    maxConns: config.directTorrentMaxPeers,
    downloadLimit: config.directTorrentDownloadLimitBps,
    uploadLimit: config.directTorrentUploadLimitBps,
    seedOutgoingConnections: false,
  } as never);
  // WebTorrent can bubble a torrent error to its client. Keep the optional
  // engine from terminating the whole Server Mode process on an unhandled
  // EventEmitter error; individual operations still fail through their own
  // metadata/read streams.
  client.on("error", () => {});
  const closeClient = async (): Promise<void> => {
    if ((client as unknown as { destroyed?: boolean }).destroyed === true) return;
    await new Promise<void>((resolve, reject) => {
      client.destroy((error) => {
        error == null
          ? resolve()
          : reject(error instanceof Error ? error : new Error(error));
      });
    });
  };
  try {
    installDirectTorrentTcpGuard(
      client as unknown as WebTorrentWithConnectionPool,
      config.directTorrentMaxPeers,
    );
  } catch (error) {
    await closeClient().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error | string) => {
        client.removeListener("ready", onReady);
        reject(error instanceof Error ? error : new Error(error));
      };
      client.once("ready", onReady);
      client.once("error", onError);
    });
  } catch (error) {
    await closeClient().catch(() => {});
    throw error;
  }

  const removeTorrent = async (infoHash: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error | string | null) => {
        if (settled) return;
        settled = true;
        error == null
          ? resolve()
          : reject(error instanceof Error ? error : new Error(error));
      };
      try {
        const pending = (client.remove as unknown as (
          torrentId: string,
          options: Record<string, never>,
          callback: (error?: Error | string | null) => void,
        ) => Promise<void> | void)(infoHash, {}, done);
        void pending?.catch(done);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    async open(infoHash) {
      if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new Error("Invalid torrent hash.");
      if ((client as unknown as { destroyed?: boolean }).destroyed === true) {
        throw Object.assign(new Error("The Direct P2P engine is unavailable."), {
          statusCode: 503,
        });
      }
      const path = join(root, infoHash);
      await mkdir(path, { recursive: true });
      const torrent = client.add(`magnet:?xt=urn:btih:${infoHash}`, {
        path,
        deselect: true,
      } as never);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Object.assign(new Error("Torrent metadata timed out."), { statusCode: 504 })),
            config.directTorrentMetadataTimeoutMs,
          );
          const done = (error?: Error) => {
            clearTimeout(timer);
            torrent.removeListener("ready", onReady);
            torrent.removeListener("error", onError);
            error == null ? resolve() : reject(error);
          };
          const onReady = () => done();
          const onError = (error: Error) => done(error);
          torrent.once("ready", onReady);
          torrent.once("error", onError);
        });
        if (torrent.infoHash.toLowerCase() !== infoHash) {
          throw new Error("Torrent metadata did not match the requested hash.");
        }
        if (torrent.length > config.directTorrentMaxTorrentBytes) {
          throw Object.assign(new Error("The torrent exceeds the Direct P2P disk limit."), {
            statusCode: 413,
          });
        }
        let destroyed = false;
        return {
          infoHash,
          files: torrent.files.map((file) => ({
            name: file.path || file.name,
            length: file.length,
            createReadStream: (options) => file.createReadStream(
              options?.start != null && options.end != null
                ? { start: options.start, end: options.end }
                : undefined,
            ) as unknown as NodeJS.ReadableStream,
          })),
          async destroy() {
            if (destroyed) return;
            destroyed = true;
            await removeTorrent(infoHash);
            await rm(path, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await removeTorrent(infoHash).catch(() => {});
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    },
    async close() {
      await closeClient();
    },
  };
}
