// Port of Sources/DebridStreamer/Services/Indexers/StremioAddonIndexer.swift.
//
// Indexer that resolves streams from a Stremio addon (the Torrentio-compatible
// ecosystem). A Stremio addon is configured by its base URL (the manifest URL,
// e.g. `https://torrentio.strem.fun/...`); for a given content type + media id
// it exposes `GET /stream/{type}/{id}.json` which returns a list of streams.
//
// This maps those streams into `TorrentResult` defensively:
//  - `infoHash` is taken from the stream's `infoHash` field, or extracted from a
//    `magnet:` URL / `xt=urn:btih:` parameter when only a URL is present.
//  - title / quality / seeders are parsed from the stream's `title` (or `name`)
//    text, following the Torrentio convention where the title is a multi-line
//    blob like `Movie Name 1080p\n👤 42 💾 2.1 GB ⚙️ provider`.
//
// A malformed base URL or any network/decoding failure degrades gracefully (the
// fetch throws, which `IndexerManager.searchAll` catches and records per-indexer
// without aborting sibling indexers).

import type { MediaType } from "../../models/media";
import {
  MAX_TORRENT_FILE_INDEX,
  normalizeTorrentFileNameHint,
  TorrentResult,
} from "./models";
import {
  defaultFetchImpl,
  type FetchImpl,
  IndexerError,
  type TorrentIndexer,
} from "./types";

/** A single Stremio stream entry. All fields are optional because addons vary
 * widely in which they populate (Torrentio sets `infoHash` + `title`; others may
 * only provide a `url`). Mirrors the Swift `StremioStream`. */
interface StremioStream {
  name?: string | null;
  title?: string | null;
  infoHash?: string | null;
  fileIdx?: number | null;
  behaviorHints?: { filename?: string | null } | null;
  url?: string | null;
}

/** Top-level `/stream/...json` response. The `streams` array is optional so an
 * empty / error body decodes to no results rather than throwing. Mirrors the
 * Swift `StremioStreamResponse`. */
interface StremioStreamResponse {
  streams?: StremioStream[] | null;
}

const INFO_HASH_RE = /^[A-Fa-f0-9]{40}$/;
// A 40-hex run that is a complete token (not flanked by more hex) - so a longer
// hex blob in the URL (e.g. a 64-char sha256) isn't truncated to a wrong "hash".
const FIRST_HEX_40_RE = /(?<![A-Fa-f0-9])[A-Fa-f0-9]{40}(?![A-Fa-f0-9])/;

// A configured add-on is user-supplied but only semi-trusted; cap how much of its
// response we buffer so a hostile or broken add-on can't return a huge/endless
// body and exhaust memory. 8 MB is far above any real stream-list JSON.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Read a fetch response's body as text, refusing to buffer past `maxBytes`. The
 * FetchImpl type only promises `text()`, but the real Response also exposes a
 * byte stream - prefer it so we can stop early; fall back to `text()` (capped)
 * for test stubs / non-standard fetches that don't provide one. */
async function readCappedText(
  response: { text(): Promise<string> },
  maxBytes: number,
): Promise<string> {
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  const reader = body?.getReader?.();
  if (reader == null) {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // istanbul ignore next -- `value` is intentionally optional for malformed streams only.
      const safeChunk = value ?? new Uint8Array();
      total += safeChunk.byteLength;
      if (total > maxBytes) throw IndexerError.cannotParseResponse();
      chunks.push(safeChunk);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cleanup failures.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class StremioAddonIndexer implements TorrentIndexer {
  readonly name: string;
  private readonly baseURL: string;
  private readonly fetchImpl: FetchImpl;

  constructor(name: string, baseURL: string, fetchImpl: FetchImpl = defaultFetchImpl) {
    this.name = name;
    this.baseURL = baseURL;
    this.fetchImpl = fetchImpl;
  }

  async search(
    imdbId: string,
    type: MediaType,
    season: number | null,
    episode: number | null,
  ): Promise<TorrentResult[]> {
    // Stremio addons key on IMDb ids only; bail cleanly on anything else
    // (e.g. a `tmdb-123` synthesized id) so we don't fire a doomed request.
    const trimmedId = imdbId.trim();
    if (!trimmedId.toLowerCase().startsWith("tt")) return [];

    const stremioType = stremioContentType(type);
    // For series Stremio expects `tt1234567:season:episode`.
    const streamId =
      type === "series" && season != null && episode != null
        ? `${trimmedId}:${season}:${episode}`
        : trimmedId;

    const url = this.makeStreamURL(stremioType, streamId);

    const response = await this.fetchImpl(url);
    if (!(response.status >= 200 && response.status <= 299)) {
      throw IndexerError.badServerResponse(response.status);
    }

    let payload: StremioStreamResponse;
    try {
      payload = JSON.parse(
        await readCappedText(response, MAX_RESPONSE_BYTES),
      ) as StremioStreamResponse;
    } catch {
      throw IndexerError.cannotParseResponse();
    }
    return this.mapStreams(payload.streams ?? []);
  }

  async searchByQuery(_query: string, _type: MediaType): Promise<TorrentResult[]> {
    // Stremio addons resolve by IMDb id, not free-text query, so there is no
    // meaningful text-search path. Return empty rather than guessing.
    return [];
  }

  // MARK: - Request building

  /** Builds `{baseURL}/stream/{type}/{id}.json`, normalizing slashes so a base
   * URL with or without a trailing slash both resolve correctly. Stremio stream
   * ids can contain ':' (series) which must be percent-encoded. Throws
   * `IndexerError.badURL` for an unusable base URL. */
  private makeStreamURL(type: string, id: string): string {
    let trimmedBase = this.baseURL.trim();
    while (trimmedBase.endsWith("/")) {
      trimmedBase = trimmedBase.slice(0, -1);
    }
    // Settings accepts the addon's manifest URL (…/manifest.json) and even
    // validates connectivity against it; strip a trailing `/manifest.json` so we
    // request the addon's `/stream/{type}/{id}.json` endpoint rather than the
    // nonsensical `…/manifest.json/stream/…` (which returns no streams).
    trimmedBase = trimmedBase.replace(/\/manifest\.json$/i, "");
    while (trimmedBase.endsWith("/")) {
      trimmedBase = trimmedBase.slice(0, -1);
    }
    if (trimmedBase.length === 0) {
      throw IndexerError.badURL(this.baseURL);
    }
    const encodedId = encodeStreamId(id);
    const urlString = `${trimmedBase}/stream/${type}/${encodedId}.json`;
    // Validate the URL the way the Swift `URL(string:)` guard does.
    try {
      // eslint-disable-next-line no-new
      new URL(urlString);
    } catch {
      throw IndexerError.badURL(urlString);
    }
    return urlString;
  }

  // MARK: - Mapping

  private mapStreams(streams: StremioStream[]): TorrentResult[] {
    const results: TorrentResult[] = [];
    for (const stream of streams) {
      const hash = resolveInfoHash(stream);
      if (hash == null) continue;
      const hasExplicitFileIndex = stream.fileIdx != null;
      if (
        hasExplicitFileIndex &&
        (!Number.isSafeInteger(stream.fileIdx) ||
          (stream.fileIdx as number) < 0 ||
          (stream.fileIdx as number) > MAX_TORRENT_FILE_INDEX)
      ) continue;

      // Prefer the descriptive multi-line `title`, falling back to `name` and
      // finally the bare hash so parsing always has something to work on.
      const rawTitle = (stream.title ?? stream.name)?.trim();
      const displayTitle = rawTitle != null && rawTitle.length > 0 ? rawTitle : hash;
      // Quality/codec/source parsing keys off the whole blob; collapse the
      // newlines so multi-line Torrentio titles still match the parsers.
      const parseSource = displayTitle.replace(/\n/g, " ");

      const seeders = extractSeeders(displayTitle) ?? 0;
      const sizeBytes = extractSize(displayTitle) ?? 0;
      // Use the first non-empty line as the human-facing title; rest is metadata.
      const primaryTitle = displayTitle.split("\n")[0].trim();

      const magnetURI =
        stream.url != null && stream.url.startsWith("magnet:")
          ? stream.url
          : makeMagnet(hash, primaryTitle);

      const fileIndex =
        hasExplicitFileIndex
          ? (stream.fileIdx as number)
          : null;
      const fileNameHint = normalizeTorrentFileNameHint(
        stream.behaviorHints?.filename,
      );

      results.push(
        TorrentResult.fromSearch({
          infoHash: hash,
          title: `${primaryTitle} ${parseSource}`.trim(),
          sizeBytes,
          seeders,
          leechers: 0,
          indexerName: this.name,
          magnetURI,
          fileIndex,
          fileNameHint,
        }),
      );
    }
    return results;
  }
}

// MARK: - Free helpers (mirror the Swift private methods)

function stremioContentType(type: MediaType): string {
  return type === "movie" ? "movie" : "series";
}

/** Percent-encodes a Stremio stream id, encoding the path-unsafe characters
 * (notably ':') the way the Swift `.urlPathAllowed.subtracting(":")` does. The
 * id is `tt…` or `tt…:season:episode`, so encoding the colons is sufficient and
 * keeps the rest readable. */
function encodeStreamId(id: string): string {
  return id.replace(/:/g, "%3A");
}

/** Resolves a 40-char btih info hash from a Stremio stream, trying (in order):
 * the explicit `infoHash` field, an `xt=urn:btih:` parameter in a magnet/url,
 * and the first 40-hex run anywhere in the `url`. Returns lowercased hash or
 * null. Mirrors `resolveInfoHash`. */
function resolveInfoHash(stream: StremioStream): string | null {
  const direct = stream.infoHash?.trim();
  if (direct != null && isValidInfoHash(direct)) {
    return direct.toLowerCase();
  }
  if (stream.url != null) {
    const fromMagnet = extractInfoHashFromMagnet(stream.url);
    if (fromMagnet != null) return fromMagnet;
  }
  return null;
}

/** Extracts a btih hash from a magnet/url: first an `xt=urn:btih:` query param,
 * then the first 40-hex run anywhere in the string. Mirrors the Swift
 * `extractInfoHash(fromMagnet:)`. */
function extractInfoHashFromMagnet(urlString: string): string | null {
  // Try a structured parse first. `magnet:?...` parses with the WHATWG URL
  // parser (scheme `magnet:`, the rest as the query after `?`).
  try {
    const parsed = new URL(urlString);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key.toLowerCase() === "xt") {
        const prefix = "urn:btih:";
        if (value.toLowerCase().startsWith(prefix)) {
          const candidate = value.slice(prefix.length);
          if (isValidInfoHash(candidate)) return candidate.toLowerCase();
        }
      }
    }
  } catch {
    // Not a parseable URL - fall through to the regex scan.
  }
  // Fall back to the first 40-hex run anywhere in the string.
  const match = FIRST_HEX_40_RE.exec(urlString);
  if (match) return match[0].toLowerCase();
  return null;
}

function isValidInfoHash(value: string): boolean {
  return INFO_HASH_RE.test(value);
}

function makeMagnet(hash: string, title: string): string {
  const encodedName = encodeURIComponent(title);
  return `magnet:?xt=urn:btih:${hash}&dn=${encodedName}`;
}

/** Parses the seeder count from a Torrentio-style title line, e.g.
 * `👤 42` / `Seeders: 42` / `S:42`. Mirrors `extractSeeders`. */
function extractSeeders(title: string): number | null {
  const patterns = [
    /👤\s*(\d+)/,
    /seeders?\s*[:=]?\s*(\d+)/i,
    /\bS\s*[:=]\s*(\d+)/i,
    /👤\s*(\S+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(title);
    if (match) {
      const value = Number.parseInt(match[1], 10);
      if (!Number.isNaN(value)) return value;
    }
  }
  return null;
}

/** Parses a human size like `💾 2.1 GB` / `Size: 700 MB` into bytes. Mirrors
 * `extractSize`. */
function extractSize(title: string): number | null {
  const match = /((?:\d+(?:\.\d+)?)|(?:\.))\s*(TB|GB|MB|KB|[A-Z]B)/i.exec(title);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  const unit = match[2].toUpperCase();
  let multiplier: number;
  switch (unit) {
    case "TB":
      multiplier = 1_000_000_000_000;
      break;
    case "GB":
      multiplier = 1_000_000_000;
      break;
    case "MB":
      multiplier = 1_000_000;
      break;
    case "KB":
      multiplier = 1_000;
      break;
    default:
      multiplier = 1;
  }
  return Math.trunc(value * multiplier);
}
