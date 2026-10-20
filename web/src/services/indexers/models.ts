// Port of Sources/DebridStreamer/Models/TorrentResult.swift (the display/search
// type produced by indexers) plus the VideoQuality/VideoCodec/AudioFormat/
// SourceType enums and their title parsers from MediaType.swift.
//
// Only the indexer-relevant pieces are ported here. The GRDB-backed
// `CachedTorrent` persistence type is intentionally omitted (out of scope for
// the web port). Field names are kept aligned with the Swift `TorrentResult`
// so cached JSON lines up across implementations.

// MARK: - Token boundary helper (mirrors `mediaTokenMatch`)

const MEDIA_TOKEN_PATTERNS = new Map<string, RegExp>([
  ["sd", /(?<![a-z0-9])sd(?![a-z0-9])/],
  ["cam", /(?<![a-z0-9])cam(?![a-z0-9])/],
  ["ts", /(?<![a-z0-9])ts(?![a-z0-9])/],
]);

/** Matches `token` only when delimited by non-alphanumeric boundaries (or
 * string ends), so ambiguous short tokens like "ts"/"sd"/"cam" don't match when
 * embedded inside words. Mirrors Swift `mediaTokenMatch`. */
function mediaTokenMatch(haystack: string, token: string): boolean {
  // Swift uses `(?<![a-z0-9])token(?![a-z0-9])` on an already-lowercased string.
  let re = MEDIA_TOKEN_PATTERNS.get(token);
  if (re == null) {
    // Keep the helper's generic token semantics while caching any future token
    // rather than compiling a new expression for every parse.
    re = new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`);
    MEDIA_TOKEN_PATTERNS.set(token, re);
  }
  return re.test(haystack);
}

// MARK: - VideoQuality

/** Video quality tier parsed from torrent filenames. Mirrors `VideoQuality`. */
export type VideoQuality = "4K" | "1080p" | "720p" | "480p" | "SD" | "Unknown";

export const VideoQuality = {
  uhd4k: "4K" as VideoQuality,
  hd1080p: "1080p" as VideoQuality,
  hd720p: "720p" as VideoQuality,
  sd480p: "480p" as VideoQuality,
  sdOther: "SD" as VideoQuality,
  unknown: "Unknown" as VideoQuality,

  /** Higher = better quality. Mirrors `VideoQuality.sortOrder`. */
  sortOrder(q: VideoQuality): number {
    switch (q) {
      case "4K":
        return 5;
      case "1080p":
        return 4;
      case "720p":
        return 3;
      case "480p":
        return 2;
      case "SD":
        return 1;
      case "Unknown":
        return 0;
    }
  },

  /** Parse quality from a torrent filename. Mirrors `VideoQuality.parse`. */
  parse(filename: string): VideoQuality {
    const lower = filename.toLowerCase();
    if (
      lower.includes("2160p") ||
      lower.includes("4k") ||
      lower.includes("uhd")
    ) {
      return VideoQuality.uhd4k;
    } else if (lower.includes("1080p") || lower.includes("1080i")) {
      return VideoQuality.hd1080p;
    } else if (lower.includes("720p")) {
      return VideoQuality.hd720p;
    } else if (lower.includes("480p")) {
      return VideoQuality.sd480p;
    } else if (
      mediaTokenMatch(lower, "sd") ||
      lower.includes("dvdrip") ||
      lower.includes("hdtv")
    ) {
      return VideoQuality.sdOther;
    }
    return VideoQuality.unknown;
  },
} as const;

// MARK: - VideoCodec

/** Video codec parsed from torrent filenames. Mirrors `VideoCodec`. */
export type VideoCodec = "H.264" | "H.265" | "AV1" | "XviD" | "Unknown";

export const VideoCodec = {
  h264: "H.264" as VideoCodec,
  h265: "H.265" as VideoCodec,
  av1: "AV1" as VideoCodec,
  xvid: "XviD" as VideoCodec,
  unknown: "Unknown" as VideoCodec,

  parse(filename: string): VideoCodec {
    const lower = filename.toLowerCase();
    if (
      lower.includes("x265") ||
      lower.includes("h265") ||
      lower.includes("hevc") ||
      lower.includes("h.265")
    ) {
      return VideoCodec.h265;
    } else if (
      lower.includes("x264") ||
      lower.includes("h264") ||
      lower.includes("avc") ||
      lower.includes("h.264")
    ) {
      return VideoCodec.h264;
    } else if (lower.includes("av1")) {
      return VideoCodec.av1;
    } else if (lower.includes("xvid") || lower.includes("divx")) {
      return VideoCodec.xvid;
    }
    return VideoCodec.unknown;
  },
} as const;

// MARK: - AudioFormat

/** Audio format parsed from torrent filenames. Mirrors `AudioFormat`. */
export type AudioFormat =
  | "Atmos"
  | "DTS-HD MA"
  | "DTS:X"
  | "TrueHD"
  | "DTS"
  | "AC3"
  | "AAC"
  | "Unknown";

export const AudioFormat = {
  atmos: "Atmos" as AudioFormat,
  dtsHDMA: "DTS-HD MA" as AudioFormat,
  dtsX: "DTS:X" as AudioFormat,
  trueHD: "TrueHD" as AudioFormat,
  dts: "DTS" as AudioFormat,
  ac3: "AC3" as AudioFormat,
  aac: "AAC" as AudioFormat,
  unknown: "Unknown" as AudioFormat,

  parse(filename: string): AudioFormat {
    const lower = filename.toLowerCase();
    if (lower.includes("atmos")) {
      return AudioFormat.atmos;
    } else if (lower.includes("dts-hd") || lower.includes("dts.hd")) {
      return AudioFormat.dtsHDMA;
    } else if (
      lower.includes("dts-x") ||
      lower.includes("dts.x") ||
      lower.includes("dts:x") ||
      /(?:^|[^a-z0-9])dtsx(?:[^a-z0-9]|$)/.test(lower)
    ) {
      return AudioFormat.dtsX;
    } else if (lower.includes("truehd") || lower.includes("true-hd")) {
      return AudioFormat.trueHD;
    } else if (lower.includes("dts")) {
      return AudioFormat.dts;
    } else if (
      lower.includes("dd5") ||
      lower.includes("ac3") ||
      lower.includes("dolby digital") ||
      lower.includes("dd+") ||
      lower.includes("ddp") ||
      lower.includes("eac3")
    ) {
      return AudioFormat.ac3;
    } else if (lower.includes("aac")) {
      return AudioFormat.aac;
    }
    return AudioFormat.unknown;
  },
} as const;

// MARK: - SourceType

/** Source type parsed from torrent filenames. Mirrors `SourceType`. */
export type SourceType =
  | "BluRay"
  | "WEB-DL"
  | "WEBRip"
  | "HDRip"
  | "DVDRip"
  | "HDTV"
  | "CAM"
  | "Unknown";

export const SourceType = {
  bluray: "BluRay" as SourceType,
  webDL: "WEB-DL" as SourceType,
  webRip: "WEBRip" as SourceType,
  hdRip: "HDRip" as SourceType,
  dvdRip: "DVDRip" as SourceType,
  hdtv: "HDTV" as SourceType,
  cam: "CAM" as SourceType,
  unknown: "Unknown" as SourceType,

  parse(filename: string): SourceType {
    const lower = filename.toLowerCase();
    if (
      lower.includes("bluray") ||
      lower.includes("blu-ray") ||
      lower.includes("bdrip") ||
      lower.includes("brrip")
    ) {
      return SourceType.bluray;
    } else if (lower.includes("web-dl") || lower.includes("webdl")) {
      return SourceType.webDL;
    } else if (lower.includes("webrip") || lower.includes("web-rip")) {
      return SourceType.webRip;
    } else if (lower.includes("hdrip")) {
      return SourceType.hdRip;
    } else if (lower.includes("dvdrip") || lower.includes("dvd-rip")) {
      return SourceType.dvdRip;
    } else if (lower.includes("hdtv")) {
      return SourceType.hdtv;
    } else if (
      mediaTokenMatch(lower, "cam") ||
      lower.includes("hdcam") ||
      mediaTokenMatch(lower, "ts") ||
      lower.includes("telesync")
    ) {
      return SourceType.cam;
    }
    return SourceType.unknown;
  },
} as const;

// MARK: - TorrentResult

/**
 * A torrent search result from an indexer. Mirrors Swift `TorrentResult`.
 * `id` is the hash plus an explicit Stremio file index when one exists.
 * `sizeBytes` is held as a JS `number`
 * (the Swift type is `Int64`; torrent sizes fit comfortably in a double).
 */
export interface TorrentResult {
  /** Stable identity for this torrent/file selection. */
  readonly id: string;
  infoHash: string;
  title: string;
  sizeBytes: number;
  quality: VideoQuality;
  codec: VideoCodec;
  audio: AudioFormat;
  source: SourceType;
  seeders: number;
  leechers: number;
  /** Which indexer found this. Mirrors `indexerName`. */
  indexerName: string;
  magnetURI?: string | null;
  /** Stremio's zero-based file index within the torrent. */
  fileIndex?: number | null;
  /** Optional bounded filename metadata used only to validate an exact pick. */
  fileNameHint?: string | null;
  /** Whether this torrent is cached on a debrid service. */
  isCached: boolean;
  /** Which debrid service has it cached. */
  cachedOn?: string | null;
}

export const TorrentResult = {
  /**
   * Build a TorrentResult, parsing quality/codec/audio/source from the title.
   * Mirrors `TorrentResult.fromSearch` - note infoHash is lowercased here.
   */
  fromSearch(args: {
    infoHash: string;
    title: string;
    sizeBytes: number;
    seeders: number;
    leechers: number;
    indexerName: string;
    magnetURI?: string | null;
    fileIndex?: number | null;
    fileNameHint?: string | null;
  }): TorrentResult {
    const infoHash = args.infoHash.toLowerCase();
    const fileIndex = args.fileIndex ?? null;
    const fileNameHint = args.fileNameHint ?? null;
    return {
      get id() {
        return fileIndex == null ? infoHash : `${infoHash}:${fileIndex}`;
      },
      infoHash,
      title: args.title,
      sizeBytes: args.sizeBytes,
      quality: VideoQuality.parse(args.title),
      codec: VideoCodec.parse(args.title),
      audio: AudioFormat.parse(args.title),
      source: SourceType.parse(args.title),
      seeders: args.seeders,
      leechers: args.leechers,
      indexerName: args.indexerName,
      magnetURI: args.magnetURI ?? null,
      ...(fileIndex == null ? {} : { fileIndex, fileNameHint }),
      isCached: false,
      cachedOn: null,
    };
  },

  /** Human-facing quality summary. Mirrors `TorrentResult.qualityLabel`. */
  qualityLabel(r: TorrentResult): string {
    const parts: string[] = [];
    if (r.quality !== VideoQuality.unknown) parts.push(r.quality);
    if (r.codec !== VideoCodec.unknown) parts.push(r.codec);
    if (r.source !== SourceType.unknown) parts.push(r.source);
    if (r.audio !== AudioFormat.unknown) parts.push(r.audio);
    return parts.length === 0 ? "Unknown" : parts.join(" · ");
  },
} as const;

/** Dedupe identity. Explicit file indices are separate playable selections. */
export function torrentResultSelectionKey(result: TorrentResult): string {
  const hash = result.infoHash.toLowerCase();
  return result.fileIndex == null ? `${hash}:default` : `${hash}:file:${result.fileIndex}`;
}

export const MAX_TORRENT_FILE_INDEX = 1_000_000;
export const MAX_TORRENT_FILE_NAME_HINT_LENGTH = 1_024;

/** Validate and normalize untrusted add-on/request filename metadata without
 * converting it into a provider-native selector. */
export function normalizeTorrentFileNameHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
  return normalized.length > 0 && normalized.length <= MAX_TORRENT_FILE_NAME_HINT_LENGTH
    ? normalized
    : null;
}

/** Whether a row can be resolved without downgrading an explicit selector to
 * heuristic playback. Legacy no-selector rows remain usable. */
export function torrentResultHasUsableFileSelection(result: TorrentResult): boolean {
  return result.fileIndex == null || normalizeTorrentFileNameHint(result.fileNameHint) != null;
}

/** Exact equality for binding a request back to the selector-bearing source
 * row. This is separate from provider filename matching, which may use a
 * unique basename when a provider omits the original folder path. */
export function torrentResultMatchesExactSelection(
  result: TorrentResult,
  fileIndex: number,
  fileName: unknown,
): boolean {
  if (
    !Number.isSafeInteger(fileIndex) ||
    fileIndex < 0 ||
    fileIndex > MAX_TORRENT_FILE_INDEX ||
    result.fileIndex !== fileIndex
  ) return false;
  const requestedName = normalizeTorrentFileNameHint(fileName);
  const boundName = normalizeTorrentFileNameHint(result.fileNameHint);
  return requestedName != null && boundName != null && requestedName === boundName;
}
