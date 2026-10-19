// Port of Sources/DebridStreamer/Services/Debrid/AllDebridService.swift.
//
// fetch-based AllDebrid client. Mirrors the Swift actor: chunked /magnet/instant
// cache check, /magnet/upload + /magnet/status poll, /link/unlock unrestrict, and
// /user account decoding. Auth is sent as a Bearer + X-API-Key header and an
// `apikey=` form-body component (never in the query). The poll SLEEP is
// injectable (default no-op) so tests don't wait.

import {
  CacheStatus,
  type DebridAccountInfo,
  type DebridFileCandidate,
  DebridFileSelector,
  type DebridFileHint,
  isExactFileHint,
  type DebridServiceType,
  DebridServiceType as DebridServiceTypeNS,
  type DebridTorrent,
  type StreamInfo,
  AudioFormat,
  SourceType,
  VideoCodec,
  VideoQuality,
} from "./models";
import {
  type DebridService,
  DebridError,
  type FetchImpl,
  defaultFetchImpl,
  formValueEncode,
} from "./types";
import {
  asObject,
  asObjectArray,
  int64Value,
  noopSleep,
  parseJSONObject,
  type Sleep,
} from "./jsonHelpers";

/** Chunk an array into sub-arrays of `size`. Mirrors the Swift `chunked(into:)`. */
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class AllDebridService implements DebridService {
  readonly serviceType: DebridServiceType = DebridServiceTypeNS.allDebrid;
  private readonly apiToken: string;
  private readonly baseURL = "https://api.alldebrid.com/v4";
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: Sleep;
  private readonly agent = "DebridStreamer";

  constructor(apiToken: string, fetchImpl?: FetchImpl, sleep: Sleep = noopSleep) {
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl ?? defaultFetchImpl();
    this.sleep = sleep;
  }

  async checkCache(hashes: string[]): Promise<Record<string, CacheStatus>> {
    if (hashes.length === 0) return {};

    const results: Record<string, CacheStatus> = {};
    for (const chunk of chunked(hashes, 100)) {
      const magnetsParam = chunk.map((h) => `magnets[]=${h}`).join("&");
      const data = await this.requestRaw("/magnet/instant", "GET", magnetsParam);

      const json = parseJSONObject(data);
      const dataObj = json && asObject(json.data);
      const magnets = dataObj && asObjectArray(dataObj.magnets);
      if (magnets) {
        for (const magnetInfo of magnets) {
          // Skip rows without a real hash (error/invalid magnet entries have no
          // `hash` field): writing results[""] would pollute the map and leave
          // the actually-requested hash unrecorded (→ silently "not cached").
          if (typeof magnetInfo.hash !== "string" || magnetInfo.hash.length === 0) {
            continue;
          }
          const hash = magnetInfo.hash.toLowerCase();
          const instant = magnetInfo.instant === true;
          results[hash] = instant
            ? CacheStatus.cached(null, null, null)
            : CacheStatus.notCached;
        }
      }
    }

    return results;
  }

  async addMagnet(hash: string): Promise<string> {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const body = `magnets[]=${formValueEncode(magnet)}`;
    const data = await this.requestRaw("/magnet/upload", "POST", undefined, body);

    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    const magnets = dataObj && asObjectArray(dataObj.magnets);
    const first = magnets && magnets[0];
    const id = first ? int64Value(first.id) : null;
    if (id == null) {
      throw DebridError.downloadFailed("Failed to add magnet to AllDebrid");
    }
    return String(id);
  }

  async selectFiles(_torrentId: string, _fileIds: number[]): Promise<void> {
    // AllDebrid auto-selects files; this is a no-op for most cases.
  }

  async getStreamURL(
    torrentId: string,
    fileHint: DebridFileHint | null = null,
  ): Promise<StreamInfo> {
    const maxAttempts = 20;
    let magnets: Record<string, unknown> = {};
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const data = await this.requestRaw(
        "/magnet/status",
        "GET",
        `id=${torrentId}`,
      );
      const json = parseJSONObject(data);
      const dataObj = json && asObject(json.data);
      const magnet = dataObj && asObject(dataObj.magnets);
      if (magnet == null) throw DebridError.torrentNotFound(torrentId);
      magnets = magnet;
      const status = typeof magnet.status === "string" ? magnet.status : "";
      if (status === "Ready") break;
      if (status === "Error" || status.toLowerCase().includes("error")) {
        throw DebridError.downloadFailed(`AllDebrid reported status: ${status}`);
      }
      if (attempt === maxAttempts - 1) {
        throw DebridError.downloadFailed(
          `Torrent not ready after ${maxAttempts}s (status: ${status})`,
        );
      }
      await this.sleep(1000);
    }

    const links = asObjectArray(magnets.links);
    if (links == null) {
      throw fileHint != null && isExactFileHint(fileHint)
        ? DebridError.fileSelectionFailed()
        : DebridError.noFilesAvailable();
    }

    const candidates: DebridFileCandidate[] = [];
    for (const item of links) {
      if (typeof item.link !== "string") continue;
      const filename = typeof item.filename === "string" ? item.filename : "Unknown";
      const size = int64Value(item.size) ?? 0;
      candidates.push({ link: item.link, fileName: filename, sizeBytes: size });
    }
    const selected = DebridFileSelector.selectForHint(candidates, fileHint);
    if (selected == null) {
      throw fileHint != null && isExactFileHint(fileHint)
        ? DebridError.fileSelectionFailed()
        : DebridError.noFilesAvailable();
    }

    const streamURL = await this.unrestrict(selected.link);
    const filename = selected.fileName;
    const size = selected.sizeBytes;

    return {
      streamURL,
      quality: VideoQuality.parse(filename),
      codec: VideoCodec.parse(filename),
      audio: AudioFormat.parse(filename),
      source: SourceType.parse(filename),
      sizeBytes: size,
      fileName: filename,
      debridService: "AD",
    };
  }

  async unrestrict(link: string): Promise<string> {
    const body = `link=${formValueEncode(link)}`;
    const data = await this.requestRaw("/link/unlock", "POST", undefined, body);

    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    const downloadStr = dataObj && typeof dataObj.link === "string" ? dataObj.link : null;
    if (downloadStr == null || !isAbsoluteURL(downloadStr)) {
      throw DebridError.downloadFailed("Failed to unrestrict link on AllDebrid");
    }
    return downloadStr;
  }

  /** List the account's magnets (the Debrid Library manager source). Calls
   * `GET /magnet/status` with no id, which returns every magnet under
   * `data.magnets`, normalizing each into a `DebridTorrent`. Fault-tolerant:
   * an unparseable body yields an empty list. */
  async listTorrents(): Promise<DebridTorrent[]> {
    const data = await this.requestRaw("/magnet/status", "GET");
    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    const magnets = dataObj && asObjectArray(dataObj.magnets);
    if (magnets == null) return [];
    return magnets.map((m) => normalizeADTorrent(m));
  }

  /** Delete a magnet from the account by id (`GET /magnet/delete?id=`). */
  async deleteTorrent(id: string): Promise<void> {
    await this.requestRaw("/magnet/delete", "GET", `id=${id}`);
  }

  async validateToken(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      return true;
    } catch {
      return false;
    }
  }

  async getAccountInfo(): Promise<DebridAccountInfo> {
    const data = await this.requestRaw("/user", "GET");
    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    const user = dataObj && asObject(dataObj.user);
    if (user == null) throw DebridError.invalidToken();

    const username = typeof user.username === "string" ? user.username : "Unknown";
    const email = typeof user.email === "string" ? user.email : null;
    const isPremium = user.isPremium === true;

    let premiumExpiry: Date | null = null;
    if (typeof user.premiumUntil === "number") {
      premiumExpiry = new Date(user.premiumUntil * 1000);
    }

    return { username, email, premiumExpiry, isPremium };
  }

  // MARK: - HTTP

  private async requestRaw(
    path: string,
    method: string,
    queryParams?: string,
    body?: string,
  ): Promise<string> {
    let urlStr = `${this.baseURL}${path}?agent=${this.agent}`;
    if (queryParams != null && queryParams.length > 0) {
      urlStr += `&${queryParams}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      "X-API-Key": this.apiToken,
    };

    let composedBody: string | undefined;
    if (body != null) {
      const authBodyComponent = `apikey=${formValueEncode(this.apiToken)}`;
      composedBody = body.length === 0 ? authBodyComponent : `${body}&${authBodyComponent}`;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await this.fetchImpl(urlStr, {
      method,
      headers,
      body: composedBody,
    });
    const status = response.status;

    if (!(status >= 200 && status <= 299)) {
      if (status === 401) throw DebridError.invalidToken();
      const errText = (await response.text().catch(() => "")) || "";
      throw DebridError.httpError(status, errText);
    }

    return response.text();
  }
}

function isAbsoluteURL(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a raw AllDebrid `/magnet/status` magnet into the shared
 * `DebridTorrent` display shape. Defensive against missing/typed-wrong fields. */
function normalizeADTorrent(m: Record<string, unknown>): DebridTorrent {
  const idNum = int64Value(m.id);
  const id = idNum != null ? String(idNum) : String(m.id ?? "");
  const name = typeof m.filename === "string" ? m.filename : "Unknown";
  const hash = typeof m.hash === "string" ? m.hash.toLowerCase() : null;
  const status = typeof m.status === "string" ? m.status : "unknown";
  const bytes = int64Value(m.size) ?? 0;
  // AllDebrid reports `uploadDate` as a unix epoch (seconds).
  let addedAt: string | null = null;
  const upload = int64Value(m.uploadDate);
  if (upload != null && upload > 0) addedAt = new Date(upload * 1000).toISOString();
  return {
    id,
    name,
    sizeBytes: bytes,
    status,
    infoHash: hash,
    addedAt,
    host: null,
    progress: null,
    debridService: "AD",
  };
}
