// Port of the debrid-domain value types from the Swift app:
//  - StreamInfo / CacheStatus            (Models/StreamInfo.swift)
//  - VideoQuality / VideoCodec / AudioFormat / SourceType + filename parsers
//                                        (Models/MediaType.swift)
//  - DebridServiceType / DebridConfig    (Models/DebridConfig.swift)
//  - DebridAccountInfo                   (Services/Debrid/DebridServiceProtocol.swift)
//  - DebridFileCandidate / DebridFileSelector (Services/Debrid/DebridFileSelector.swift)
//
// These live in the debrid subdir (not the shared models) so parallel agents
// stay conflict-free. Field names track the Swift models so cached JSON and
// later sync code line up across the two implementations.

// MARK: - Filename-derived enums (mirror MediaType.swift)

/** Matches `token` only when delimited by non-alphanumeric boundaries (or string
 * ends), so ambiguous short tokens like "ts"/"sd"/"cam" don't match when embedded
 * inside words. Mirrors Swift `mediaTokenMatch`. */
export function mediaTokenMatch(haystack: string, token: string): boolean {
  return new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`).test(haystack);
}

/** Video quality tier parsed from torrent filenames. Mirrors `VideoQuality`. */
export type VideoQuality = "4K" | "1080p" | "720p" | "480p" | "SD" | "Unknown";

export const VideoQuality = {
  uhd4k: "4K" as VideoQuality,
  hd1080p: "1080p" as VideoQuality,
  hd720p: "720p" as VideoQuality,
  sd480p: "480p" as VideoQuality,
  sdOther: "SD" as VideoQuality,
  unknown: "Unknown" as VideoQuality,

  /** Sort weight, mirrors `VideoQuality.sortOrder`. */
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
    if (lower.includes("2160p") || lower.includes("4k") || lower.includes("uhd")) {
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

/** Video codec parsed from torrent filenames. Mirrors `VideoCodec`. */
export type VideoCodec = "H.264" | "H.265" | "AV1" | "XviD" | "Unknown";

export const VideoCodec = {
  h264: "H.264" as VideoCodec,
  h265: "H.265" as VideoCodec,
  av1: "AV1" as VideoCodec,
  xvid: "XviD" as VideoCodec,
  unknown: "Unknown" as VideoCodec,

  /** Mirrors `VideoCodec.parse`. */
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

  /** Mirrors `AudioFormat.parse`. */
  parse(filename: string): AudioFormat {
    const lower = filename.toLowerCase();
    if (lower.includes("atmos")) {
      return AudioFormat.atmos;
    } else if (lower.includes("dts-hd") || lower.includes("dts.hd")) {
      return AudioFormat.dtsHDMA;
    } else if (lower.includes("dts-x") || lower.includes("dts:x")) {
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

  /** Mirrors `SourceType.parse`. */
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

// MARK: - StreamInfo (mirror StreamInfo.swift)

/** A resolved stream ready for playback. Mirrors Swift `StreamInfo`. */
export interface StreamInfo {
  streamURL: string; // Direct HTTPS URL from debrid
  /** Original-media offset used by a seek-started server transcode. The HLS
   * rendition starts at zero, so player progress adds this value back. */
  timelineOffsetSeconds?: number;
  quality: VideoQuality;
  codec: VideoCodec;
  audio: AudioFormat;
  source: SourceType;
  sizeBytes: number;
  fileName: string;
  debridService: string; // Which debrid resolved it (short code RD/AD/PM/TB or name)
  /** Stream-scoped bearer issued by a YAWF Stream server. It grants access only
   * to this short-lived proxy session, so native players never receive the
   * account-wide HttpOnly login cookie. Local debrid services leave it unset. */
  playbackAuthorization?: string;
  /** Server Mode resolution backend. Omitted by local and older servers. */
  backend?: "debrid" | "direct_torrent";
  /** Real-Debrid unrestrict id, when known. Real-Debrid returns this alongside
   * the direct `download` URL; it's the key for the `/streaming/transcode/{id}`
   * and `/streaming/mediaInfos/{id}` endpoints, which let the app transcode an
   * MKV/HEVC source to in-webview-playable HLS. Optional and only set by
   * RealDebridService - other services leave it undefined. */
  restrictedId?: string;
}

export const StreamInfo = {
  /** `id` is the stream URL, mirrors Swift `StreamInfo.id`. */
  id(s: StreamInfo): string {
    return s.streamURL;
  },

  /** "[RD] 1080p H.264 BluRay"-style label, mirrors `StreamInfo.qualityLabel`. */
  qualityLabel(s: StreamInfo): string {
    const parts: string[] = [`[${s.debridService}]`];
    if (s.quality !== VideoQuality.unknown) parts.push(s.quality);
    if (s.codec !== VideoCodec.unknown) parts.push(s.codec);
    if (s.source !== SourceType.unknown) parts.push(s.source);
    return parts.join(" ");
  },
} as const;

// MARK: - CacheStatus (mirror StreamInfo.swift)

/** Status of a torrent hash on a debrid service. Mirrors Swift `CacheStatus`,
 * which is an enum with an associated `cached` payload. Modeled here as a tagged
 * union so deep-equality (`toEqual`) mirrors Swift `Equatable`. */
export type CacheStatus =
  | {
      kind: "cached";
      fileId: string | null;
      fileName: string | null;
      fileSize: number | null;
    }
  | { kind: "notCached" }
  | { kind: "unknown" };

export const CacheStatus = {
  cached(
    fileId: string | null = null,
    fileName: string | null = null,
    fileSize: number | null = null,
  ): CacheStatus {
    return { kind: "cached", fileId, fileName, fileSize };
  },
  notCached: { kind: "notCached" } as CacheStatus,
  unknown: { kind: "unknown" } as CacheStatus,

  /** Mirrors `CacheStatus.isCached`. */
  isCached(status: CacheStatus): boolean {
    return status.kind === "cached";
  },
} as const;

// MARK: - DebridServiceType (mirror DebridConfig.swift)

/** Supported debrid service types. Mirrors Swift `DebridServiceType`; the string
 * values are the persisted raw values. */
export type DebridServiceType =
  | "real_debrid"
  | "all_debrid"
  | "premiumize"
  | "torbox";

export const DebridServiceType = {
  realDebrid: "real_debrid" as DebridServiceType,
  allDebrid: "all_debrid" as DebridServiceType,
  premiumize: "premiumize" as DebridServiceType,
  torBox: "torbox" as DebridServiceType,

  /** Canonical display + PRIORITY order (first = preferred): the pickers list
   * services in this order and DebridManager registration sorts by it, so the
   * first configured service here wins cache badges and stream resolution. */
  allCases(): DebridServiceType[] {
    return ["torbox", "real_debrid", "all_debrid", "premiumize"];
  },

  /** Mirrors `DebridServiceType.displayName`. */
  displayName(type: DebridServiceType): string {
    switch (type) {
      case "real_debrid":
        return "Real-Debrid";
      case "all_debrid":
        return "AllDebrid";
      case "premiumize":
        return "Premiumize";
      case "torbox":
        return "TorBox";
    }
  },

  /** Short two-letter badge code. Mirrors `DebridServiceType.shortCode`. */
  shortCode(type: DebridServiceType): string {
    switch (type) {
      case "real_debrid":
        return "RD";
      case "all_debrid":
        return "AD";
      case "premiumize":
        return "PM";
      case "torbox":
        return "TB";
    }
  },

  /** Mirrors `DebridServiceType.baseURL`. */
  baseURL(type: DebridServiceType): string {
    switch (type) {
      case "real_debrid":
        return "https://api.real-debrid.com/rest/1.0";
      case "all_debrid":
        return "https://api.alldebrid.com/v4";
      case "premiumize":
        return "https://www.premiumize.me/api";
      case "torbox":
        return "https://api.torbox.app/v1/api";
    }
  },
} as const;

// MARK: - DebridConfig (mirror DebridConfig.swift)

/** User's debrid service configuration. Mirrors Swift `DebridConfig` (the value
 * fields - the GRDB persistence plumbing is not ported here). */
interface DebridConfig {
  id: string;
  service: DebridServiceType;
  apiToken: string; // Reference to keychain entry / raw token
  isActive: boolean;
  priority: number; // Lower = higher priority
}

/** Mirrors the Swift memberwise init defaults (`isActive = true`, `priority = 0`). */
export function makeDebridConfig(
  partial: Partial<DebridConfig> & {
    id: string;
    service: DebridServiceType;
    apiToken: string;
  },
): DebridConfig {
  return {
    id: partial.id,
    service: partial.service,
    apiToken: partial.apiToken,
    isActive: partial.isActive ?? true,
    priority: partial.priority ?? 0,
  };
}

// MARK: - DebridAccountInfo (mirror DebridServiceProtocol.swift)

/** Account info for display purposes. Mirrors Swift `DebridAccountInfo`.
 * `premiumExpiry` is a `Date | null` (Swift uses `Date?`). */
export interface DebridAccountInfo {
  username: string;
  email: string | null;
  premiumExpiry: Date | null;
  isPremium: boolean;
  points?: number | null;
}

// MARK: - DebridTorrent (debrid library manager)

/** One torrent/transfer in a user's debrid account, as surfaced by the Debrid
 * Library manager. Normalized across services (Real-Debrid `/torrents`,
 * AllDebrid `/magnet/status`, etc.) into a single display shape. Not present in
 * the Swift app (which has no library-manager screen) - a web-only addition. */
export interface DebridTorrent {
  /** Service-native id used for delete (`/torrents/delete/{id}`, etc.). */
  id: string;
  /** Torrent display name / filename. */
  name: string;
  /** Total size in bytes (0 when the service doesn't report it). */
  sizeBytes: number;
  /** Raw service status string (e.g. "downloaded", "downloading", "Ready"). */
  status: string;
  /** Lowercased infoHash when known (for dedup detection). Null otherwise. */
  infoHash: string | null;
  /** ISO-8601 added timestamp when known, else null. */
  addedAt: string | null;
  /** Hoster/host label when known (e.g. "real-debrid"), else null. */
  host: string | null;
  /** Download progress 0..100 when known, else null. */
  progress: number | null;
  /** Which debrid service this came from (short code RD/AD/PM/TB). */
  debridService: string;
}

// MARK: - DebridFileCandidate / DebridFileSelector (mirror DebridFileSelector.swift)

/** File candidate returned by debrid services. Mirrors Swift `DebridFileCandidate`. */
export interface DebridFileCandidate {
  link: string;
  fileName: string;
  sizeBytes: number;
}

const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "mov",
  "avi",
  "webm",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
  "wmv",
  "flv",
]);

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "ac3",
  "dts",
  "eac3",
  "flac",
  "m4a",
  "mka",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "wma",
]);

const SAMPLE_HINTS = [
  "sample",
  "trailer",
  "featurette",
  "extras",
  "behindthescenes",
  "commentary",
  "soundtrack",
];

interface CandidateMeta {
  isVideo: boolean;
  isSample: boolean;
  containerScore: number;
  codecScore: number;
}

/** Last path component, mirroring Swift `URL(fileURLWithPath:).lastPathComponent`
 * and `URL(string:).lastPathComponent`. Strips a trailing slash, then returns the
 * segment after the final slash. */
export function lastPathComponent(path: string): string {
  let p = path;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** File extension (lowercased) of a path's last component. Mirrors Swift
 * `URL(fileURLWithPath:).pathExtension`. */
function pathExtension(name: string): string {
  const base = lastPathComponent(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no extension or leading-dot dotfile
  return base.slice(dot + 1).toLowerCase();
}

function containerCompatibilityScore(ext: string): number {
  switch (ext) {
    case "mp4":
    case "m4v":
    case "mov":
      return 6;
    case "mkv":
      return 5;
    case "ts":
    case "m2ts":
    case "mpg":
    case "mpeg":
      return 4;
    case "webm":
      return 3;
    case "avi":
    case "wmv":
    case "flv":
      return 2;
    default:
      return 0;
  }
}

function codecCompatibilityScore(fileName: string): number {
  if (
    fileName.includes("x264") ||
    fileName.includes("h264") ||
    fileName.includes("avc") ||
    fileName.includes("h.264")
  ) {
    return 5;
  }
  if (
    fileName.includes("x265") ||
    fileName.includes("h265") ||
    fileName.includes("hevc") ||
    fileName.includes("h.265")
  ) {
    return 4;
  }
  if (fileName.includes("xvid") || fileName.includes("divx")) {
    return 2;
  }
  if (fileName.includes("av1")) {
    return 1;
  }
  return 3;
}

function normalizedName(candidate: DebridFileCandidate): string {
  const trimmed = candidate.fileName.trim();
  if (trimmed.length > 0 && trimmed.toLowerCase() !== "unknown") {
    return trimmed;
  }

  // Mirrors `URL(string: link)?.lastPathComponent`.
  try {
    const url = new URL(candidate.link);
    const fromLink = lastPathComponent(url.pathname).trim();
    if (fromLink.length > 0) {
      return fromLink;
    }
  } catch {
    // Not an absolute URL - fall through, mirroring a nil URL(string:).
  }

  return trimmed.length === 0 ? candidate.link : trimmed;
}

function meta(candidate: DebridFileCandidate): CandidateMeta {
  const effectiveName = normalizedName(candidate);
  const lower = effectiveName.toLowerCase();
  const ext = pathExtension(effectiveName);

  const isVideo = VIDEO_EXTENSIONS.has(ext) && !AUDIO_EXTENSIONS.has(ext);
  const isSample = SAMPLE_HINTS.some((hint) => lower.includes(hint));
  const containerScore = containerCompatibilityScore(ext);
  const codecScore = codecCompatibilityScore(lower);

  return { isVideo, isSample, containerScore, codecScore };
}

/** Returns <0 / 0 / >0 like the Swift `compare`. */
function compareCandidates(
  lhs: DebridFileCandidate,
  rhs: DebridFileCandidate,
): number {
  const lhsMeta = meta(lhs);
  const rhsMeta = meta(rhs);

  if (lhsMeta.isVideo !== rhsMeta.isVideo) {
    return lhsMeta.isVideo ? 1 : -1;
  }
  if (lhsMeta.isSample !== rhsMeta.isSample) {
    return lhsMeta.isSample ? -1 : 1;
  }
  if (lhsMeta.containerScore !== rhsMeta.containerScore) {
    return lhsMeta.containerScore > rhsMeta.containerScore ? 1 : -1;
  }
  if (lhsMeta.codecScore !== rhsMeta.codecScore) {
    return lhsMeta.codecScore > rhsMeta.codecScore ? 1 : -1;
  }
  if (lhs.sizeBytes !== rhs.sizeBytes) {
    return lhs.sizeBytes > rhs.sizeBytes ? 1 : -1;
  }
  if (lhs.fileName.length !== rhs.fileName.length) {
    return lhs.fileName.length > rhs.fileName.length ? 1 : -1;
  }
  return lhs.fileName > rhs.fileName ? 1 : -1;
}

/** A requested episode, used to steer multi-file (season-pack) selection. */
export interface EpisodeFileHint {
  season: number;
  episode: number;
}

/** Extract an exact episode tag (S02E05 / S2 E5 / 2x05 …) from UPPERCASED
 * text. These two regexes are THE canonical patterns - classifyRowForEpisode
 * in data/streams.ts consumes this same function for its exact-match branch,
 * so release ranking and pack file-picking can never diverge. */
export function matchEpisodeTag(
  text: string,
): { season: number; episode: number } | null {
  const se = text.match(/S(\d{1,2})[ ._-]?E(\d{1,3})/);
  if (se != null) {
    return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  }
  // NxNN format. The negative lookahead blocks the ubiquitous audio+codec
  // adjacency in release names - "DD5.1.x264" uppercases to "1X264", which
  // would otherwise parse as season 1 episode 264 and get right-season packs
  // dropped as mismatches. A genuine episode 264 of a season is expressed as
  // SxxExxx by every real indexer, so nothing of value is lost.
  const x = text.match(/\b(\d{1,2})X(?!26[45]\b)(\d{2,3})\b/);
  if (x != null) {
    return { season: parseInt(x[1], 10), episode: parseInt(x[2], 10) };
  }
  return null;
}

/** True when a file name (or its full path, for folder-per-episode packs)
 * carries the exact episode tag. Basename is tested first so a per-episode
 * file inside a season folder matches on its own name. */
export function fileMatchesEpisode(
  fileName: string,
  hint: EpisodeFileHint,
): boolean {
  const upper = fileName.toUpperCase();
  const base = upper.slice(upper.lastIndexOf("/") + 1);
  const m = matchEpisodeTag(base) ?? matchEpisodeTag(upper);
  return m != null && m.season === hint.season && m.episode === hint.episode;
}

/** Picks the best streamable file out of a debrid response. Mirrors Swift
 * `DebridFileSelector`. The Swift impl uses `candidates.max { compare($0,$1) < 0 }`
 * which returns the maximal element under `compareCandidates`.
 *
 * With an episode hint (season packs), the ranking runs over the files whose
 * names carry that exact episode tag; when nothing matches (single-file
 * torrents, odd naming), it falls back to the full set - today's behavior. */
export const DebridFileSelector = {
  selectBest(
    candidates: DebridFileCandidate[],
    hint: EpisodeFileHint | null = null,
  ): DebridFileCandidate | null {
    if (candidates.length === 0) return null;
    let pool = candidates;
    if (hint != null) {
      const matching = candidates.filter((c) => fileMatchesEpisode(c.fileName, hint));
      if (matching.length > 0) pool = matching;
    }
    // Reduce to the maximum under compareCandidates. Swift `max(by:)` keeps the
    // first element among equals when the comparator reports them not-less-than;
    // a strict ">0" keeps that same first-wins behavior on ties.
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) {
      if (compareCandidates(pool[i], best) > 0) {
        best = pool[i];
      }
    }
    return best;
  },
} as const;
