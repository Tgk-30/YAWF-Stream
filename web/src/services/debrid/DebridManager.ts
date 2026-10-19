// Port of Sources/DebridStreamer/Services/Debrid/DebridManager.swift.
//
// Manages multiple debrid services and routes requests to the best available one.
// Mirrors the Swift actor's order-independent, priority-driven merge in
// checkCacheAll, the resolveStream preferred/priority selection (with the
// Real-Debrid smart findExistingTorrent flow), and the concurrent, order-
// preserving validateAll. The keychain/secret-resolution `configure(configs:)`
// path is intentionally not ported here (no DB/keychain in the web layer);
// services are registered directly via addService, as the Swift tests do.

import { CacheStatus, type DebridServiceType, DebridServiceType as DebridServiceTypeNS, type DebridTorrent, type DebridFileHint, type StreamInfo } from "./models";
import { type DebridService, DebridError } from "./types";
import { RealDebridService } from "./RealDebridService";

/** Per-hash merged cache result: the bound service plus its reported status. */
export interface MergedCacheEntry {
  service: DebridServiceType;
  status: CacheStatus;
}

export interface ProviderSmokeResult {
  service: DebridServiceType;
  accountReachable: boolean;
  cacheReachable: boolean;
  durationMs: number;
}

/** Maximum time a single provider may hold up a cache lookup. A provider that
 * exceeds this budget contributes no answer, while healthy providers continue
 * to determine the result. */
export const DEBRID_CACHE_TIMEOUT_MS = 10_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error(`${label} cache check aborted`));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(new Error(`${label} cache check aborted`)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} cache check timed out after ${ms}ms`)));
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export class DebridManager {
  private services: DebridService[] = [];

  /** Add a single service. Mirrors Swift `addService`. Insertion order is the
   * priority order (services[0] is highest priority). */
  addService(service: DebridService): void {
    this.services.push(service);
  }

  /** All active service types. Mirrors `activeServiceTypes`. */
  get activeServiceTypes(): DebridServiceType[] {
    return this.services.map((s) => s.serviceType);
  }

  /** Mirrors `hasServices`. */
  get hasServices(): boolean {
    return this.services.length > 0;
  }

  /** Check cache across all active services, binding each hash to the highest-
   * priority service that reports it (cached beats non-cached; ties broken by the
   * lower priority index). The merge is deterministic regardless of completion
   * order. Mirrors Swift `checkCacheAll`. */
  async checkCacheAll(
    hashes: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, MergedCacheEntry>> {
    if (hashes.length === 0) return {};

    // Query all services concurrently, carrying each service's priority index.
    const collected = await Promise.all(
      this.services.map(async (service, index) => {
        let cache: Record<string, CacheStatus> = {};
        try {
          cache = await withTimeout(
            service.checkCache(hashes),
            DEBRID_CACHE_TIMEOUT_MS,
            DebridServiceTypeNS.displayName(service.serviceType),
            signal,
          );
        } catch (error) {
          // Swallowing per-service cache failures keeps one dead provider from
          // blanking the others, but a silent swallow made "invalid token on
          // the server" indistinguishable from "nothing is cached". Log the
          // reason so it is visible in docker logs / the browser console.
          console.warn(
            `[debrid] cache check failed for ${DebridServiceTypeNS.displayName(service.serviceType)}:`,
            error instanceof Error ? error.message : String(error),
          );
          cache = {};
        }
        return { index, serviceType: service.serviceType, cache };
      }),
    );

    // Deterministic merge by priority index.
    const results: Record<
      string,
      { index: number; service: DebridServiceType; status: CacheStatus }
    > = {};
    for (const entry of collected.sort((a, b) => a.index - b.index)) {
      for (const [rawHash, status] of Object.entries(entry.cache)) {
        // Torrent infoHashes are case-insensitive hex, but providers echo them
        // in different cases (Real-Debrid tends uppercase, others lowercase).
        // Canonicalize to lowercase so (a) the caller's lookup can't miss on a
        // case mismatch - which made cached streams read as uncached - and
        // (b) the same torrent from two providers merges instead of splitting.
        const hash = rawHash.toLowerCase();
        const existing = results[hash];
        if (existing) {
          const beatsCacheState =
            CacheStatus.isCached(status) && !CacheStatus.isCached(existing.status);
          const sameCacheStateLowerIndex =
            CacheStatus.isCached(status) === CacheStatus.isCached(existing.status) &&
            entry.index < existing.index;
          if (beatsCacheState || sameCacheStateLowerIndex) {
            results[hash] = {
              index: entry.index,
              service: entry.serviceType,
              status,
            };
          }
        } else {
          results[hash] = {
            index: entry.index,
            service: entry.serviceType,
            status,
          };
        }
      }
    }

    const out: Record<string, MergedCacheEntry> = {};
    for (const [hash, v] of Object.entries(results)) {
      out[hash] = { service: v.service, status: v.status };
    }
    return out;
  }

  /** Resolve a torrent hash to a stream URL using the preferred (or first
   * available) service. Mirrors Swift `resolveStream`. No silent cross-service
   * fallback: the selected service's error propagates. */
  async resolveStream(
    hash: string,
    preferredService: DebridServiceType | null = null,
    fileHint: DebridFileHint | null = null,
  ): Promise<StreamInfo> {
    const service = this.pickService(preferredService);

    // For Real-Debrid, use the smart resolve flow.
    if (service instanceof RealDebridService) {
      return this.resolveWithRealDebrid(service, hash, fileHint);
    }

    // Generic flow for other services.
    const torrentId = await service.addMagnet(hash);
    await service.selectFiles(torrentId, []);
    return service.getStreamURL(torrentId, fileHint);
  }

  /** Smart Real-Debrid resolve flow: reuse an existing torrent if present, else
   * add the magnet, then poll for the stream URL. Mirrors `resolveWithRealDebrid`. */
  private async resolveWithRealDebrid(
    service: RealDebridService,
    hash: string,
    fileHint: DebridFileHint | null = null,
  ): Promise<StreamInfo> {
    let torrentId: string;

    let existingId: string | null = null;
    try {
      existingId = await service.findExistingTorrent(hash);
    } catch {
      existingId = null; // mirrors Swift `try?`
    }

    if (existingId != null) {
      torrentId = existingId;
    } else {
      torrentId = await service.addMagnet(hash);
    }

    return service.getStreamURL(torrentId, fileHint);
  }

  /** Get a Real-Debrid transcoded HLS (`.m3u8`) URL for an already-resolved
   * stream, so a non-browser-playable container (MKV/HEVC/AV1) can be played
   * in-webview via hls.js instead of being handed off to a native player.
   *
   * Returns null (the caller falls back to the native-player path) when:
   *   - the stream wasn't resolved by Real-Debrid (no `restrictedId`, or RD
   *     isn't a configured service), or
   *   - Real-Debrid has no HLS transcode available for it.
   *
   * Never throws for the "not available" case; a network/HTTP failure from the
   * transcode call is swallowed to null so playback degrades gracefully. */
  async getTranscodeHLS(stream: StreamInfo): Promise<string | null> {
    const id = stream.restrictedId;
    if (id == null || id.length === 0) return null;
    const rd = this.services.find(
      (s): s is RealDebridService => s instanceof RealDebridService,
    );
    if (rd == null) return null;
    try {
      return await rd.getTranscodeHLS(id);
    } catch {
      return null;
    }
  }

  /** Add a magnet (by infoHash) to a debrid account so it gets cached there.
   * Uses the preferred service when given, else the highest-priority one.
   * Returns the service-native torrent/transfer id. Surfaced for the hash-list
   * import flow (bulk-hydrate a list of hashes onto the user's debrid). */
  async addMagnet(
    hash: string,
    preferredService: DebridServiceType | null = null,
  ): Promise<string> {
    const service = this.pickService(preferredService);
    return service.addMagnet(hash);
  }

  /** List the account's torrents across every service that supports listing,
   * concurrently and fault-tolerantly (a service that throws contributes no
   * rows rather than failing the whole call). Service order is preserved, with
   * each service's rows kept together. The Debrid Library manager's data source. */
  async listTorrents(): Promise<DebridTorrent[]> {
    const collected = await Promise.all(
      this.services.map(async (service, index) => {
        if (typeof service.listTorrents !== "function") {
          return { index, rows: [] as DebridTorrent[] };
        }
        try {
          return { index, rows: await service.listTorrents() };
        } catch {
          return { index, rows: [] as DebridTorrent[] };
        }
      }),
    );
    return collected
      .sort((a, b) => a.index - b.index)
      .flatMap((c) => c.rows);
  }

  /** Delete a torrent/transfer by id from a specific service (matched by its
   * short code, e.g. "RD"/"AD"). Throws if no matching service supports delete. */
  async deleteTorrent(id: string, debridServiceCode: string): Promise<void> {
    for (const service of this.services) {
      if (
        DebridServiceTypeNS.shortCode(service.serviceType) === debridServiceCode &&
        typeof service.deleteTorrent === "function"
      ) {
        await service.deleteTorrent(id);
        return;
      }
    }
    throw DebridError.networkError(
      `No configured service can delete torrents for ${debridServiceCode}`,
    );
  }

  /** Resolve a single service by preference, else the highest priority one. */
  private pickService(preferredService: DebridServiceType | null): DebridService {
    if (preferredService != null) {
      const found = this.services.find((s) => s.serviceType === preferredService);
      if (found == null) {
        throw DebridError.networkError(
          `Service ${DebridServiceTypeNS.displayName(preferredService)} not configured`,
        );
      }
      return found;
    }
    const first = this.services[0];
    if (first == null) {
      throw DebridError.networkError("No debrid services configured");
    }
    return first;
  }

  /** Validate all configured services concurrently, preserving service order in
   * the result. Mirrors Swift `validateAll`. */
  async validateAll(): Promise<[DebridServiceType, boolean][]> {
    const collected = await Promise.all(
      this.services.map(async (service, index) => {
        let valid = false;
        try {
          valid = await service.validateToken();
        } catch {
          valid = false;
        }
        return { index, serviceType: service.serviceType, valid };
      }),
    );
    return collected
      .sort((a, b) => a.index - b.index)
      .map((c) => [c.serviceType, c.valid] as [DebridServiceType, boolean]);
  }

  /** Read-only provider smoke check used by diagnostics and release validation.
   * It verifies both the account endpoint and cache lookup contract without
   * adding, selecting, or deleting a torrent. */
  async smokeTestProviders(
    hash = "0000000000000000000000000000000000000000",
  ): Promise<ProviderSmokeResult[]> {
    const normalizedHash = hash.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(normalizedHash)) {
      throw new Error("Provider smoke hash must be a 40-character info hash");
    }

    const collected = await Promise.all(
      this.services.map(async (service, index) => {
        const startedAt = Date.now();
        let accountReachable = false;
        let cacheReachable = false;
        try {
          accountReachable = await withTimeout(
            service.validateToken(),
            DEBRID_CACHE_TIMEOUT_MS,
            DebridServiceTypeNS.displayName(service.serviceType),
          );
        } catch {
          accountReachable = false;
        }
        if (accountReachable) {
          try {
            const cache = await withTimeout(
              service.checkCache([normalizedHash]),
              DEBRID_CACHE_TIMEOUT_MS,
              DebridServiceTypeNS.displayName(service.serviceType),
            );
            cacheReachable = Object.prototype.hasOwnProperty.call(
              cache,
              normalizedHash,
            );
          } catch {
            cacheReachable = false;
          }
        }
        return {
          index,
          result: {
            service: service.serviceType,
            accountReachable,
            cacheReachable,
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        };
      }),
    );

    return collected
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.result);
  }
}
