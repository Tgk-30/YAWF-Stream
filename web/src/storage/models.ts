// Storage-layer record shapes - TS mirrors of the GRDB tables the UI needs.
//
// These are intentionally defined HERE (under storage/) rather than under
// web/src/models, because models/ is off-limits to modify and already-tested.
// The field names track the Swift models so cached/synced JSON lines up across
// the two implementations:
//   - WatchHistory / UserLibraryEntry  (Models/WatchHistory.swift)
//   - LibraryFolder                     (Models/LibraryFolder.swift)
//   - DebridConfig / IndexerConfig      (Models/DebridConfig.swift)
//   - TasteEvent                        (Models/TasteEvent.swift)
//   - MediaItem (cache)                 (Models/MediaItem.swift)
//
// Dates are persisted as ISO-8601 strings (Dexie stores them fine as Date too,
// but strings keep the records JSON-clean for later sync). Everything is plain
// data - no class instances - so it round-trips through IndexedDB structured
// clone without custom (de)serialization.

import type { MediaPreview } from "../models/media";

// MARK: - Watch history (Models/WatchHistory.swift)

/** Tracks a user's watch progress for a movie or episode. One row per
 * (mediaId, episodeId); episodeId is null for movies. Mirrors `WatchHistory`. */
export interface WatchHistoryRecord {
  /** Primary key - `${mediaId}:${episodeId ?? ""}` so there is exactly one row
   * per (media, episode). */
  id: string;
  mediaId: string;
  episodeId: string | null;
  progressSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  /** A durable series handoff target, distinct from a 0% resume row. */
  queuedNext?: boolean;
  /** ISO-8601 timestamp of the last watch. Indexed for recency ordering. */
  lastWatched: string;
  streamQuality: string | null;
  /** Display snapshot so History / Continue-Watching can render the grid
   * without a separate media-cache join. Not present in the Swift schema
   * (which joins media_cache); kept here so the web UI is self-contained. */
  preview: MediaPreview;
  /** Remembered in-window-player preferences for this (media, episode), so the
   * next play restores the viewer's choices. All optional (older rows lack them);
   * non-indexed, so adding them needs no Dexie version bump. */
  preferredAudioId?: string | null;
  preferredAudioLang?: string | null;
  /** Subtitle track id as a string, or "no" for explicitly off, or null/unset. */
  preferredSubId?: string | null;
  playbackSpeed?: number | null;
  subtitleDelay?: number | null;
  subtitlePosition?: number | null;
}

/** The in-window-player choices remembered per (media, episode). */
export interface PlaybackPrefs {
  preferredAudioId?: string | null;
  preferredAudioLang?: string | null;
  preferredSubId?: string | null;
  playbackSpeed?: number | null;
  subtitleDelay?: number | null;
  subtitlePosition?: number | null;
}

/** Progress as a fraction 0..1. Mirrors `WatchHistory.progressPercent`. */
export function watchProgressPercent(r: WatchHistoryRecord): number {
  if (r.durationSeconds == null || r.durationSeconds <= 0) return 0;
  return Math.min(r.progressSeconds / r.durationSeconds, 1);
}

/** Whether the user has a meaningful resume point (>2% and <95%).
 * Mirrors `WatchHistory.hasResumePoint`. */
export function hasResumePoint(r: WatchHistoryRecord): boolean {
  const p = watchProgressPercent(r);
  return p > 0.02 && p < 0.95;
}

/** A { mediaId: fraction } map of resume progress, for "Continue Watching" bars
 * on cards. Includes only incomplete records with a real resume point so a
 * finished or barely-started title shows no bar. With per-episode records the
 * NEWEST one wins per title (was last-iteration-wins, i.e. array-order luck). */
export function watchProgressMap(
  records: WatchHistoryRecord[],
): Record<string, number> {
  const map: Record<string, number> = {};
  const newest: Record<string, string> = {};
  for (const r of records) {
    if (r.completed || r.queuedNext || !hasResumePoint(r)) continue;
    const prev = newest[r.preview.id];
    if (prev != null && prev.localeCompare(r.lastWatched) >= 0) continue;
    newest[r.preview.id] = r.lastWatched;
    map[r.preview.id] = watchProgressPercent(r);
  }
  return map;
}

/** The newest incomplete record (with a real resume point) per media id. The
 * Continue Watching rail shows ONE card per show - resuming its most recent
 * episode - while the older per-episode records stay in storage and drive the
 * per-episode bars in the episode picker. */
export function latestResumeByMedia(
  records: WatchHistoryRecord[],
): Record<string, WatchHistoryRecord> {
  const map: Record<string, WatchHistoryRecord> = {};
  for (const r of records) {
    if (r.completed || (!r.queuedNext && !hasResumePoint(r))) continue;
    const cur = map[r.mediaId];
    if (cur == null || cur.lastWatched.localeCompare(r.lastWatched) < 0) {
      map[r.mediaId] = r;
    }
  }
  return map;
}

// MARK: - Watchlist

/** A watchlist entry. The native app models the watchlist as the `watchlist`
 * list-type in user_library; here it is a focused store keyed by mediaId with no
 * duplicates, carrying the display preview so the screen can render directly. */
export interface WatchlistRecord {
  /** Primary key - the media id. No duplicates. */
  mediaId: string;
  /** ISO-8601 timestamp added (most-recent-first ordering). */
  addedAt: string;
  /** Optional named watchlist folder. Older rows and uncategorized titles use
   * null; keeping this optional makes the additive IndexedDB migration safe for
   * rows that predate folders. */
  folderId?: string | null;
  preview: MediaPreview;
}

/** A named, flat folder for organizing saved watchlist titles. This is separate
 * from Library folders on purpose: a title can only appear once in the
 * watchlist, then optionally belongs to one of these folders. */
export interface WatchlistFolderRecord {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

// MARK: - User library (Models/WatchHistory.swift → UserLibraryEntry)

/** Library list types. Mirrors `UserLibraryEntry.ListType`. */
export type ListType = "watchlist" | "favorites" | "custom";

/** Whether a list type supports user folders. Mirrors `ListType.supportsFolders`. */
export function listTypeSupportsFolders(listType: ListType): boolean {
  return listType !== "watchlist";
}

/** A user library entry. Mirrors `UserLibraryEntry`. */
export interface LibraryEntryRecord {
  id: string;
  mediaId: string;
  folderId: string | null;
  listType: ListType;
  /** ISO-8601. */
  addedAt: string;
  customListName: string | null;
  releaseDateHint: string | null;
  renewalStatus: string | null;
  /** Display snapshot so the Library grid renders without a media-cache join. */
  preview: MediaPreview;
}

// MARK: - Library folders (Models/LibraryFolder.swift)

/** Folder kinds. Mirrors `LibraryFolder.FolderKind`. */
export type FolderKind = "system_root" | "manual" | "watched" | "release_wait";

/** Hierarchical folder container. Mirrors `LibraryFolder`. */
export interface LibraryFolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  listType: ListType;
  folderKind: FolderKind;
  isSystem: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
}

/** Mirrors `LibraryFolder.systemFolderID(for:)`. */
export function systemFolderID(listType: ListType): string {
  return `system-${listType}`;
}

/** Mirrors `LibraryFolder.systemFolderName(for:)`. */
export function systemFolderName(listType: ListType): string {
  switch (listType) {
    case "watchlist":
      return "Watchlist";
    case "favorites":
      return "Library";
    case "custom":
      return "Custom";
  }
}

// MARK: - Debrid configs (Models/DebridConfig.swift)

/** Supported debrid services. String values are the persisted raw values.
 * Mirrors `DebridServiceType`. */
export type DebridServiceType =
  | "real_debrid"
  | "all_debrid"
  | "premiumize"
  | "torbox";

/** A persisted debrid service configuration. Mirrors `DebridConfig`. The
 * `apiToken` here is the raw token (web phase). The keychain indirection of the
 * native build - where apiToken is a keychain reference - is the documented
 * SecretStore follow-up. */
export interface DebridConfigRecord {
  id: string;
  service: DebridServiceType;
  apiToken: string;
  isActive: boolean;
  /** Lower = higher priority. Mirrors `DebridConfig.priority`. */
  priority: number;
}

// MARK: - Indexer configs (Models/DebridConfig.swift → IndexerConfig)

/** Indexer kinds. Includes `stremio_addon` (present in the Swift model) even
 * though the ported web IndexerManager cannot yet construct it - persisting it
 * faithfully means a later Stremio-capable factory needs no migration. Mirrors
 * `IndexerConfig.IndexerType`. */
export type StoredIndexerType =
  | "jackett"
  | "prowlarr"
  | "torznab"
  | "zilean"
  | "stremio_addon"
  | "built_in";

/** Provider subtype. Mirrors `IndexerConfig.ProviderSubtype`. */
export type StoredProviderSubtype =
  | "jackett"
  | "prowlarr"
  | "custom_torznab"
  | "stremio_addon"
  | "built_in";

/** A persisted indexer configuration. Mirrors `IndexerConfig` (all v2 fields). */
export interface IndexerConfigRecord {
  id: string;
  type: StoredIndexerType;
  baseURL: string;
  apiKey: string | null;
  isActive: boolean;
  displayName: string | null;
  providerSubtype: StoredProviderSubtype;
  endpointPath: string;
  categoryFilter: string | null;
  /** Lower = higher priority. Mirrors `IndexerConfig.priority`. */
  priority: number;
}

/** Mirrors `IndexerType.defaultProviderSubtype`. */
export function defaultProviderSubtype(
  type: StoredIndexerType,
): StoredProviderSubtype {
  switch (type) {
    case "jackett":
      return "jackett";
    case "prowlarr":
      return "prowlarr";
    case "torznab":
    case "zilean":
      return "custom_torznab";
    case "stremio_addon":
      return "stremio_addon";
    case "built_in":
      return "built_in";
  }
}

/** Mirrors `IndexerType.defaultEndpointPath`. */
export function defaultEndpointPath(type: StoredIndexerType): string {
  switch (type) {
    case "jackett":
      return "/api/v2.0/indexers/all/results/torznab/api";
    case "prowlarr":
      return "/api/v1/search";
    case "torznab":
    case "zilean":
      return "/api";
    case "stremio_addon":
    case "built_in":
      return "";
  }
}

/** Build an IndexerConfigRecord, defaulting providerSubtype/endpointPath from
 * the type the way the Swift memberwise init does. */
export function makeIndexerConfigRecord(partial: {
  id: string;
  type: StoredIndexerType;
  baseURL: string;
  apiKey?: string | null;
  isActive?: boolean;
  displayName?: string | null;
  providerSubtype?: StoredProviderSubtype | null;
  endpointPath?: string | null;
  categoryFilter?: string | null;
  priority?: number;
}): IndexerConfigRecord {
  return {
    id: partial.id,
    type: partial.type,
    baseURL: partial.baseURL,
    apiKey: partial.apiKey ?? null,
    isActive: partial.isActive ?? true,
    displayName: partial.displayName ?? null,
    providerSubtype:
      partial.providerSubtype ?? defaultProviderSubtype(partial.type),
    endpointPath: partial.endpointPath ?? defaultEndpointPath(partial.type),
    categoryFilter: partial.categoryFilter ?? null,
    priority: partial.priority ?? 0,
  };
}

// MARK: - Taste events (Models/TasteEvent.swift)

/** Taste event types. Mirrors `TasteEvent.EventType`. */
export type TasteEventType =
  | "watched"
  | "completed"
  | "liked"
  | "disliked"
  | "added_to_watchlist"
  | "removed_from_watchlist"
  | "searched"
  | "rated"
  | "not_interested";

/** Event log of user preference signals. Mirrors `TasteEvent` (the fields the
 * web UI records; the feedback-scale extension columns are optional). */
export interface TasteEventRecord {
  id: string;
  userId: string;
  mediaId: string | null;
  episodeId: string | null;
  eventType: TasteEventType;
  signalStrength: number;
  metadata: Record<string, string>;
  /** ISO-8601. Indexed for recency ordering. */
  createdAt: string;
}

// MARK: - Media cache (Models/MediaItem.swift)

/** A cached MediaItem keyed by its id. Mirrors the `media_cache` table; the web
 * cache is optional (TMDB is the source of truth) but is provided so Detail /
 * Library can render offline. The value is the ported `MediaItem` shape. */
import type { MediaItem } from "../models/media";

export interface MediaCacheRecord {
  /** Primary key - the media id. */
  id: string;
  item: MediaItem;
  /** ISO-8601 of the last fetch (for eviction policies later). */
  lastFetched: string;
}

// MARK: - Cached resolution (watchlist auto-resolve / pre-resolve)

/** A pre-resolved, ready-to-play stream for a watchlisted title, produced by the
 * background auto-resolve job (lib/autoResolve.ts). Keyed by mediaId so a single
 * "best" cached resolution is kept per title; re-resolving replaces it. The
 * stored `stream` is the ported `StreamInfo` value (a direct/HLS URL plus the
 * parsed quality/codec metadata). This is a web-only convenience table - the
 * native app re-resolves on demand - so the UI can show a "Ready to play" badge
 * and play instantly without re-walking indexers + debrid. */
export interface CachedResolutionRecord {
  /** Primary key - the media id. One cached resolution per title. */
  mediaId: string;
  /** The resolved, ready-to-play stream (ported `StreamInfo`). */
  stream: import("../services/debrid/models").StreamInfo;
  /** ISO-8601 timestamp the resolution was produced (for staleness checks). */
  resolvedAt: string;
  /** Short code of the debrid service that resolved it (RD/AD/PM/TB). */
  debridService: string;
  /** The infoHash the resolution came from (for dedup / provenance). */
  infoHash: string;
}

// MARK: - AI usage (local-only cost/token ledger)

/** A single AI call's token + cost usage, persisted locally so the app can show
 * a running estimate of what AI features cost. Written on each `analyzeTitle`
 * call (and a natural home for future AI calls). Local-only this phase - Server
 * Mode no-ops the write (it owns its own usage accounting server-side). */
export interface AIUsageRecord {
  /** Primary key - a unique id per call. */
  id: string;
  /** The AI provider kind ("openai" | "anthropic" | "ollama"). */
  provider: string;
  /** The resolved model id, or null when the provider didn't report one. */
  model: string | null;
  /** What the call was for (e.g. "analyze" | "recommend"). */
  feature: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUSD: number | null;
  /** ISO-8601 timestamp of the call. Indexed for recency ordering. */
  createdAt: string;
}

// MARK: - Downloads (local desktop only)

/** A durable native desktop download job. The browser never executes these
 * records, while the Tauri app can recover its queue after a restart. */
export interface DownloadRecord {
  /** Caller-generated UUID and native progress-event correlation id. */
  jobId: string;
  mediaId: string;
  episodeId: string | null;
  title: string;
  season: number | null;
  episode: number | null;
  infoHash: string;
  fileHint: string | null;
  mode: "full" | "optimized";
  optimizeProfile: "remux" | "h265" | null;
  keepAudioLangs: string[];
  keepSubLangs: string[];
  status:
    | "queued"
    | "resolving"
    | "downloading"
    | "optimizing"
    | "completed"
    | "failed"
    | "canceled"
    | "paused";
  bytesDone: number;
  bytesTotal: number | null;
  /** Last reported transcode percentage (0-100), or null outside optimizing.
   *  Separate from bytesDone/bytesTotal because ffmpeg measures time, not bytes. */
  optimizePercent: number | null;
  destPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// MARK: - Settings / secrets key-value

/** A plain key-value app setting. Mirrors the `app_settings` table. */
export interface SettingRecord {
  key: string;
  value: string;
}

/** A stored secret. In this web phase secrets live in IndexedDB; an OS-keychain
 * backend behind SecretStore is the documented follow-up. Mirrors the
 * getSecret/setSecret/deleteSecret contract from the Swift `SecretStore`. */
export interface SecretRecord {
  key: string;
  value: string;
}
