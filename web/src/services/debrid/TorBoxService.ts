// Port of Sources/DebridStreamer/Services/Debrid/TorBoxService.swift.
//
// fetch-based TorBox client. Mirrors the Swift actor: /torrents/checkcached
// cache check, /torrents/createtorrent add, the /torrents/mylist snapshot +
// best-file selection + /torrents/requestdl stream-URL flow (with the
// "throw instead of streaming file_id=0 when not ready" guard), and /user/me
// account decoding. Auth is a Bearer header only (no apikey in query/body). The
// poll SLEEP is injectable (default no-op) so tests don't wait.

import {
  CacheStatus,
  type DebridAccountInfo,
  type DebridFileCandidate,
  DebridFileSelector,
  type DebridFileHint,
  isExactFileHint,
  type DebridServiceType,
  DebridServiceType as DebridServiceTypeNS,
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
} from "./types";
import {
  asObject,
  asObjectArray,
  int64Value,
  noopSleep,
  parseJSONObject,
  type Sleep,
} from "./jsonHelpers";

interface TorrentFileEntry {
  id: number;
  name: string;
  sizeBytes: number;
}

interface TorrentSnapshot {
  state: string;
  files: TorrentFileEntry[];
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class TorBoxService implements DebridService {
  readonly serviceType: DebridServiceType = DebridServiceTypeNS.torBox;
  private readonly apiToken: string;
  private readonly baseURL = "https://api.torbox.app/v1/api";
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: Sleep;

  constructor(apiToken: string, fetchImpl?: FetchImpl, sleep: Sleep = noopSleep) {
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl ?? defaultFetchImpl();
    this.sleep = sleep;
  }

  async checkCache(hashes: string[]): Promise<Record<string, CacheStatus>> {
    if (hashes.length === 0) return {};

    const results: Record<string, CacheStatus> = {};
    for (const chunk of chunked(hashes, 100)) {
      // Send lowercase: TorBox keys its response by lowercased hash, so an
      // uppercase-sent echo can never come back in a case we fail to match.
      const hashParam = chunk.map((h) => h.toLowerCase()).join(",");
      const data = await this.requestRaw(
        "/torrents/checkcached",
        "GET",
        `hash=${hashParam}&format=object`,
      );

      const json = parseJSONObject(data);
      // Unparseable body or an explicit failure envelope (rate limit, bad
      // request): leave the chunk unwritten so callers see "unavailable"
      // instead of a lying "not cached".
      if (json == null || json.success === false) continue;

      // `data` is a hash-keyed object when anything is cached, but TorBox
      // returns null or [] when NOTHING in the batch is cached. All three
      // shapes are a definitive answer for every hash in the chunk, and the
      // response keys are normalized defensively in case the echo case differs.
      const dataObj = asObject(json.data);
      const lowerKeyed = new Set<string>();
      if (dataObj) {
        for (const key of Object.keys(dataObj)) lowerKeyed.add(key.toLowerCase());
      }
      for (const hash of chunk) {
        const lowerHash = hash.toLowerCase();
        results[lowerHash] = lowerKeyed.has(lowerHash)
          ? CacheStatus.cached(null, null, null)
          : CacheStatus.notCached;
      }
    }

    return results;
  }

  async addMagnet(hash: string): Promise<string> {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const body = `magnet=${encodeURIComponent(magnet)}`;
    const data = await this.requestRaw("/torrents/createtorrent", "POST", undefined, body);

    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    // TorBox returns torrent_id as a number OR a numeric string; int64Value
    // coerces both (and null-guards), so accept any value it can parse. (The old
    // `typeof !== "number"` check rejected the valid numeric-string responses.)
    const id = dataObj ? int64Value(dataObj.torrent_id) : null;
    if (id == null) {
      throw DebridError.downloadFailed("Failed to add magnet to TorBox");
    }
    return String(id);
  }

  async selectFiles(_torrentId: string, _fileIds: number[]): Promise<void> {
    // TorBox handles file selection during creation.
  }

  async getStreamURL(
    torrentId: string,
    fileHint: DebridFileHint | null = null,
  ): Promise<StreamInfo> {
    const maxAttempts = 20;
    const terminalReadyStates = new Set(["cached", "completed", "uploading"]);
    let selectedFile: TorrentFileEntry | null = null;
    let lastState = "";

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const snapshot = await this.getTorrentSnapshot(torrentId);
      lastState = snapshot.state.toLowerCase();
      const best = this.bestFile(snapshot.files, fileHint);
      if (best != null) {
        selectedFile = best;
        break;
      }

      if (lastState.includes("stalled")) {
        throw DebridError.downloadFailed(`Torrent stalled: ${snapshot.state}`);
      }

      if (terminalReadyStates.has(lastState)) {
        break;
      }

      if (attempt < maxAttempts - 1) {
        await this.sleep(1000);
      }
    }

    if (selectedFile == null && !terminalReadyStates.has(lastState)) {
      throw DebridError.downloadFailed(
        `Torrent not ready: ${lastState.length === 0 ? "unknown" : lastState}`,
      );
    }
    if (selectedFile == null && fileHint != null && isExactFileHint(fileHint)) {
      throw DebridError.fileSelectionFailed();
    }

    const fallbackId = 0;
    const fileId = selectedFile?.id ?? fallbackId;
    const fileName = selectedFile?.name ?? "TorBox Stream";
    const size = selectedFile?.sizeBytes ?? 0;

    // requestdl is the ONE TorBox endpoint that authenticates via a `token=`
    // QUERY param, not the Bearer header - its API requires it (a header-only
    // request 422s with {"loc":["query","token"],"msg":"Field required"}), and
    // the returned link is meant to be usable directly. The Bearer header
    // requestRaw also attaches is harmless/ignored here.
    const data = await this.requestRaw(
      "/torrents/requestdl",
      "GET",
      `token=${encodeURIComponent(this.apiToken)}&torrent_id=${torrentId}&file_id=${fileId}&zip_link=false`,
    );

    const json = parseJSONObject(data);
    const dataStr = json && typeof json.data === "string" ? json.data : null;
    if (dataStr == null) throw DebridError.noFilesAvailable();

    return {
      streamURL: dataStr,
      quality: VideoQuality.parse(fileName),
      codec: VideoCodec.parse(fileName),
      audio: AudioFormat.parse(fileName),
      source: SourceType.parse(fileName),
      sizeBytes: size,
      fileName,
      debridService: "TB",
    };
  }

  async unrestrict(link: string): Promise<string> {
    if (!isAbsoluteURL(link)) throw DebridError.downloadFailed("Invalid link");
    return link;
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
    const data = await this.requestRaw("/user/me", "GET");
    const json = parseJSONObject(data);
    const dataObj = json && asObject(json.data);
    if (dataObj == null) throw DebridError.invalidToken();

    const email = typeof dataObj.email === "string" ? dataObj.email : "Unknown";
    const premium = typeof dataObj.plan === "number" ? dataObj.plan : 0;

    let premiumExpiry: Date | null = null;
    if (typeof dataObj.premium_expires_at === "string") {
      const parsed = new Date(dataObj.premium_expires_at);
      premiumExpiry = Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return {
      username: email,
      email,
      premiumExpiry,
      isPremium: premium > 0,
    };
  }

  // MARK: - HTTP

  private async requestRaw(
    path: string,
    method: string,
    queryParams?: string,
    body?: string,
  ): Promise<string> {
    let urlStr = this.baseURL + path;
    if (queryParams != null) {
      urlStr += `?${queryParams}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
    };
    if (body != null) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await this.fetchImpl(urlStr, { method, headers, body });
    const status = response.status;

    if (!(status >= 200 && status <= 299)) {
      if (status === 401 || status === 403) throw DebridError.invalidToken();
      const errText = (await response.text().catch(() => "")) || "";
      throw DebridError.httpError(status, errText);
    }

    return response.text();
  }

  private async getTorrentSnapshot(torrentId: string): Promise<TorrentSnapshot> {
    const data = await this.requestRaw(
      "/torrents/mylist",
      "GET",
      `id=${torrentId}&bypass_cache=true`,
    );

    const json = parseJSONObject(data);
    if (json == null) throw DebridError.torrentNotFound(torrentId);

    const torrentObject = this.extractTorrentObject(json, torrentId);
    if (torrentObject == null) throw DebridError.torrentNotFound(torrentId);

    const state =
      typeof torrentObject.download_state === "string"
        ? torrentObject.download_state
        : "";
    const files = this.parseFiles(torrentObject.files);
    return { state, files };
  }

  private extractTorrentObject(
    json: Record<string, unknown>,
    torrentId: string,
  ): Record<string, unknown> | null {
    const object = asObject(json.data);
    if (object) return object;

    const list = asObjectArray(json.data);
    if (list == null) return null;

    const torrentID = int64Value(torrentId);
    if (torrentID != null) {
      const match = list.find((entry) => int64Value(entry.id) === torrentID);
      if (match) return match;
    }

    return list[0] ?? null;
  }

  private parseFiles(rawFiles: unknown): TorrentFileEntry[] {
    const files = asObjectArray(rawFiles);
    if (files == null) return [];

    const out: TorrentFileEntry[] = [];
    for (const file of files) {
      const fileId64 = int64Value(file.id);
      if (fileId64 == null) continue;
      const name =
        (typeof file.name === "string" ? file.name : null) ??
        (typeof file.short_name === "string" ? file.short_name : null) ??
        "Unknown";
      const size = int64Value(file.size) ?? 0;
      out.push({ id: fileId64, name, sizeBytes: size });
    }
    return out;
  }

  private bestFile(
    files: TorrentFileEntry[],
    fileHint: DebridFileHint | null = null,
  ): TorrentFileEntry | null {
    if (files.length === 0) return null;

    const candidates: DebridFileCandidate[] = files.map((file) => ({
      link: String(file.id),
      fileName: file.name,
      sizeBytes: file.sizeBytes,
    }));

    const selected = DebridFileSelector.selectForHint(candidates, fileHint);
    if (selected == null) {
      if (fileHint != null && isExactFileHint(fileHint)) {
        throw DebridError.fileSelectionFailed();
      }
      return null;
    }
    const selectedId = Number.parseInt(selected.link, 10);
    if (Number.isNaN(selectedId)) return null;

    return files.find((f) => f.id === selectedId) ?? null;
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
