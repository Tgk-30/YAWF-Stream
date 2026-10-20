// Port of Sources/DebridStreamer/Services/Debrid/PremiumizeService.swift.
//
// fetch-based Premiumize client. Mirrors the Swift actor: chunked /cache/check
// (parallel response/filename/filesize arrays), /transfer/create add, the
// /transfer/directdl poll that streams the link verbatim (no separate
// unrestrict), and /account/info decoding. Auth is a Bearer + X-API-Key header
// plus an `apikey=` form-body component (never in the query). The poll SLEEP is
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
  type StreamInfo,
  AudioFormat,
  lastPathComponent,
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
  urlQueryEncode,
} from "./types";
import {
  asObjectArray,
  int64Value,
  noopSleep,
  parseJSONObject,
  type Sleep,
} from "./jsonHelpers";

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class PremiumizeService implements DebridService {
  readonly serviceType: DebridServiceType = DebridServiceTypeNS.premiumize;
  private readonly apiToken: string;
  private readonly baseURL = "https://www.premiumize.me/api";
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
      const body = chunk.map((h) => `items[]=${formValueEncode(h)}`).join("&");
      const data = await this.requestRaw("/cache/check", "POST", undefined, body);

      const json = parseJSONObject(data);
      const response = json && Array.isArray(json.response) ? json.response : null;
      const filenames = json && Array.isArray(json.filename) ? json.filename : null;
      const filesizes = json && Array.isArray(json.filesize) ? json.filesize : null;
      if (response && filenames && filesizes) {
        chunk.forEach((hash, i) => {
          if (i >= response.length) return;
          const lowerHash = hash.toLowerCase();
          if (response[i] === true) {
            const name =
              i < filenames.length && typeof filenames[i] === "string"
                ? (filenames[i] as string)
                : null;
            const size =
              i < filesizes.length && typeof filesizes[i] === "number"
                ? (filesizes[i] as number)
                : null;
            results[lowerHash] = CacheStatus.cached(null, name, size);
          } else {
            results[lowerHash] = CacheStatus.notCached;
          }
        });
      }
    }

    return results;
  }

  async addMagnet(hash: string): Promise<string> {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const body = `src=${formValueEncode(magnet)}`;
    const data = await this.requestRaw("/transfer/create", "POST", undefined, body);

    const json = parseJSONObject(data);
    const id = json && typeof json.id === "string" ? json.id : null;
    if (id == null) {
      throw DebridError.downloadFailed("Failed to add magnet to Premiumize");
    }
    return id;
  }

  async selectFiles(_torrentId: string, _fileIds: number[]): Promise<void> {
    // Premiumize doesn't require file selection.
  }

  async getStreamURL(
    torrentId: string,
    fileHint: DebridFileHint | null = null,
  ): Promise<StreamInfo> {
    const encodedId = urlQueryEncode(torrentId);

    const maxAttempts = 20;
    let content: Record<string, unknown>[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const data = await this.requestRaw(
        "/transfer/directdl",
        "POST",
        undefined,
        `src_id=${encodedId}`,
      );

      const json = parseJSONObject(data);
      const items = json && asObjectArray(json.content);
      if (items && items.length > 0) {
        content = items;
        break;
      }

      if (attempt < maxAttempts - 1) {
        await this.sleep(1000);
      }
    }

    if (content.length === 0) {
      throw fileHint != null && isExactFileHint(fileHint)
        ? DebridError.fileSelectionFailed()
        : DebridError.noFilesAvailable();
    }

    const candidates: DebridFileCandidate[] = [];
    for (const item of content) {
      if (typeof item.link !== "string") continue;
      const path = typeof item.path === "string" ? item.path : "Unknown";
      const size = int64Value(item.size) ?? 0;
      candidates.push({ link: item.link, fileName: path, sizeBytes: size });
    }
    const selected = DebridFileSelector.selectForHint(candidates, fileHint);
    if (selected == null) {
      throw fileHint != null && isExactFileHint(fileHint)
        ? DebridError.fileSelectionFailed()
        : DebridError.noFilesAvailable();
    }

    const filename = lastPathComponent(selected.fileName);
    const size = selected.sizeBytes;

    return {
      streamURL: selected.link,
      quality: VideoQuality.parse(filename),
      codec: VideoCodec.parse(filename),
      audio: AudioFormat.parse(filename),
      source: SourceType.parse(filename),
      sizeBytes: size,
      fileName: filename,
      debridService: "PM",
    };
  }

  async unrestrict(link: string): Promise<string> {
    // Premiumize doesn't have a separate unrestrict - directdl handles it.
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
    const data = await this.requestRaw("/account/info", "GET");
    const json = parseJSONObject(data);
    if (json == null) throw DebridError.invalidToken();

    const customerId = typeof json.customer_id === "string" ? json.customer_id : "Unknown";
    const premiumUntil =
      typeof json.premium_until === "number" ? json.premium_until : null;

    return {
      username: customerId,
      email: null,
      premiumExpiry: premiumUntil != null ? new Date(premiumUntil * 1000) : null,
      isPremium: premiumUntil != null,
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
    if (queryParams != null && queryParams.length > 0) {
      urlStr += `?${queryParams}`;
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
