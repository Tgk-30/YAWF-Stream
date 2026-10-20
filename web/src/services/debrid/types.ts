// Port of Services/Debrid/DebridServiceProtocol.swift (the protocol + DebridError)
// plus the shared fetch/HTTP plumbing the four concrete services build on.

import type {
  CacheStatus,
  DebridAccountInfo,
  DebridServiceType,
  DebridTorrent,
  DebridFileHint,
  StreamInfo,
} from "./models";

// MARK: - DebridError (mirror DebridError in DebridServiceProtocol.swift)

/**
 * Error kinds common to debrid services. Mirrors Swift `DebridError` (an
 * `Equatable` enum). The `kind` discriminator carries the associated values the
 * Swift cases hold, and the human-facing `message` matches `errorDescription`.
 */
type DebridErrorKind =
  | "invalidToken"
  | "expired"
  | "rateLimited"
  | "torrentNotFound"
  | "noFilesAvailable"
  | "fileSelectionFailed"
  | "downloadFailed"
  | "httpError"
  | "networkError";

export class DebridError extends Error {
  readonly kind: DebridErrorKind;
  /** Carried id for `torrentNotFound`. */
  readonly torrentId?: string;
  /** Carried message for `downloadFailed` / `networkError`. */
  readonly detail?: string;
  /** HTTP status code, present for `httpError`. */
  readonly statusCode?: number;
  /** HTTP body, present for `httpError`. */
  readonly body?: string;

  private constructor(
    kind: DebridErrorKind,
    message: string,
    fields: {
      torrentId?: string;
      detail?: string;
      statusCode?: number;
      body?: string;
    } = {},
  ) {
    super(message);
    this.name = "DebridError";
    this.kind = kind;
    this.torrentId = fields.torrentId;
    this.detail = fields.detail;
    this.statusCode = fields.statusCode;
    this.body = fields.body;
  }

  static invalidToken(): DebridError {
    return new DebridError("invalidToken", "Invalid API token");
  }
  static expired(): DebridError {
    return new DebridError("expired", "Premium subscription expired");
  }
  static rateLimited(): DebridError {
    return new DebridError("rateLimited", "Rate limit exceeded. Try again shortly.");
  }
  static torrentNotFound(id: string): DebridError {
    return new DebridError("torrentNotFound", `Torrent not found: ${id}`, {
      torrentId: id,
    });
  }
  static noFilesAvailable(): DebridError {
    return new DebridError("noFilesAvailable", "No downloadable files found");
  }
  static fileSelectionFailed(): DebridError {
    return new DebridError(
      "fileSelectionFailed",
      "The requested torrent file could not be matched uniquely",
    );
  }
  static downloadFailed(msg: string): DebridError {
    return new DebridError("downloadFailed", `Download failed: ${msg}`, {
      detail: msg,
    });
  }
  static httpError(code: number, msg: string): DebridError {
    return new DebridError("httpError", `HTTP ${code}: ${msg}`, {
      statusCode: code,
      body: msg,
    });
  }
  static networkError(msg: string): DebridError {
    return new DebridError("networkError", `Network error: ${msg}`, {
      detail: msg,
    });
  }

  /** Value equality, mirroring Swift `DebridError: Equatable`. */
  equals(other: DebridError): boolean {
    if (this.kind !== other.kind) return false;
    switch (this.kind) {
      case "torrentNotFound":
        return this.torrentId === other.torrentId;
      case "downloadFailed":
      case "networkError":
        return this.detail === other.detail;
      case "httpError":
        return this.statusCode === other.statusCode && this.body === other.body;
      default:
        return true;
    }
  }

  /** True when `e` is a DebridError of the given kind. Handy in tests. */
  static is(e: unknown, kind: DebridErrorKind): e is DebridError {
    return e instanceof DebridError && e.kind === kind;
  }
}

// MARK: - DebridService protocol (mirror DebridServiceProtocol)

/** Protocol for all debrid services (Real-Debrid, AllDebrid, Premiumize, TorBox).
 * Mirrors Swift `DebridServiceProtocol`. */
export interface DebridService {
  /** The service type identifier. */
  readonly serviceType: DebridServiceType;

  /** Check which torrent hashes are instantly available (cached). Returns a map
   * of lowercased hash -> CacheStatus. */
  checkCache(hashes: string[]): Promise<Record<string, CacheStatus>>;

  /** Add a magnet link for downloading. Returns a torrent/transfer ID. */
  addMagnet(hash: string): Promise<string>;

  /** Select specific files from a torrent for download. */
  selectFiles(torrentId: string, fileIds: number[]): Promise<void>;

  /** Get a direct streaming URL for a torrent. Exact file hints fail closed
   * when the provider response cannot uniquely identify the requested file. */
  getStreamURL(torrentId: string, fileHint?: DebridFileHint | null): Promise<StreamInfo>;

  /** Unrestrict a hosted link to a direct download URL (returned as a string). */
  unrestrict(link: string): Promise<string>;

  /** Verify the API token is valid. */
  validateToken(): Promise<boolean>;

  /** Get user account info (for display in settings). */
  getAccountInfo(): Promise<DebridAccountInfo>;

  /** List the account's torrents/transfers (the Debrid Library manager source).
   * Optional - not every service implements it yet; the manager treats a missing
   * method as "this service contributes no rows". */
  listTorrents?(): Promise<DebridTorrent[]>;

  /** Delete a torrent/transfer from the account by its service-native id.
   * Optional, paired with {@link listTorrents}. */
  deleteTorrent?(id: string): Promise<void>;
}

// MARK: - HTTP plumbing (replaces URLSession + requestRaw)

/** A captured/raw HTTP response, mirroring what `URLSession.data(for:)` yields
 * before the per-service status mapping runs. */
export interface RawHTTPResponse {
  status: number;
  text(): Promise<string>;
}

/** Injectable fetch signature (a subset of the DOM `fetch`). Tests stub this the
 * way the Swift tests inject a `URLSession` backed by `MockURLProtocol`. */
export type FetchImpl = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<RawHTTPResponse>;

/** Default fetch, binding to the platform global. */
export function defaultFetchImpl(): FetchImpl {
  return (url, init) =>
    fetch(url, init as RequestInit) as unknown as Promise<RawHTTPResponse>;
}

/** URL-query percent-encoding matching Swift `.urlQueryAllowed`.
 *
 * `.urlQueryAllowed` leaves these sub-delimiters and the listed punctuation
 * unescaped; `encodeURIComponent` is stricter (it escapes `!'()*` and others),
 * so we un-escape exactly the characters that `.urlQueryAllowed` permits to keep
 * the encoded magnet/link bytes identical to the Swift services. */
export function urlQueryEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /%(21|24|26|27|28|29|2A|2B|2C|2F|3A|3B|3D|3F|40)/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)),
  );
}

/** Percent-encode a value for an application/x-www-form-urlencoded BODY field.
 * Unlike urlQueryEncode (which un-escapes URL-query-allowed chars for byte parity
 * with the Swift services), this keeps `&`, `=`, `+` percent-encoded so a value
 * containing them is never misread as a field delimiter / key-value separator /
 * space inside a form body. */
export function formValueEncode(value: string): string {
  return encodeURIComponent(value);
}
