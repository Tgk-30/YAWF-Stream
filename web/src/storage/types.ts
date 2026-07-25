// Storage port - the cross-platform persistence contract.
//
// `Store` is the typed interface the UI calls; `DexieStore` implements it on
// IndexedDB (works in a plain browser AND the Tauri webview). The interface is
// deliberately backend-agnostic so a native backend (Tauri SQLite + an OS
// keychain behind SecretStore) can be swapped in later without touching any
// caller - the screens and AppStore depend only on these method signatures.
//
// The method contracts mirror what the native DatabaseManager / SettingsManager
// expose to the UI (media cache, watch history incl. resume/progress, library +
// folders, indexer/debrid configs, taste events, settings) plus the secret
// contract from the Swift SecretStore protocol.

import type {
  AIUsageRecord,
  CachedResolutionRecord,
  DebridConfigRecord,
  DownloadRecord,
  IndexerConfigRecord,
  LibraryEntryRecord,
  LibraryFolderRecord,
  ListType,
  MediaCacheRecord,
  TasteEventRecord,
  WatchHistoryRecord,
  WatchlistFolderRecord,
  WatchlistRecord,
} from "./models";
import type { MediaItem, MediaPreview } from "../models/media";

/** The secret contract mirroring the Swift `SecretStore` protocol. Async,
 * key→value, with delete. The web implementation persists to IndexedDB; an OS
 * keychain plugin behind this same interface is the documented follow-up. */
export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** The typed, cross-platform persistence interface the UI depends on. */
export interface Store {
  // MARK: Settings (key-value) - mirrors app_settings + SettingsManager.

  /** Read a setting, or null when unset. */
  getSetting(key: string): Promise<string | null>;
  /** Write a setting; passing null deletes it. */
  setSetting(key: string, value: string | null): Promise<void>;
  /** All settings as a plain object (for bulk hydration on startup). */
  allSettings(): Promise<Record<string, string>>;

  // MARK: Watchlist - keyed by mediaId, no duplicates.

  /** Add to the watchlist (no-op if already present, refreshes addedAt). */
  addToWatchlist(preview: MediaPreview, folderId?: string | null): Promise<void>;
  /** Remove from the watchlist by media id. */
  removeFromWatchlist(mediaId: string): Promise<void>;
  /** The watchlist, most-recently-added first. */
  listWatchlist(): Promise<WatchlistRecord[]>;
  /** Whether a media id is on the watchlist. */
  isInWatchlist(mediaId: string): Promise<boolean>;
  /** Create, list, rename, and delete named watchlist folders. Deleting a
   * folder moves its titles to uncategorized rather than deleting them. */
  createWatchlistFolder(name: string): Promise<WatchlistFolderRecord>;
  listWatchlistFolders(): Promise<WatchlistFolderRecord[]>;
  renameWatchlistFolder(id: string, name: string): Promise<void>;
  deleteWatchlistFolder(id: string): Promise<void>;
  /** Assign one saved title to a folder, or null for uncategorized. */
  assignWatchlistFolder(mediaId: string, folderId: string | null): Promise<void>;

  // MARK: Watch history / resume - one row per (mediaId, episodeId).

  /** Upsert a watch-history entry (one row per (mediaId, episodeId); newest
   * wins). Mirrors `DatabaseManager.saveWatchHistory`. */
  recordHistory(entry: WatchHistoryUpsert): Promise<WatchHistoryRecord>;
  /** Remove the exact history row for a movie or episode. Used when a manual
   * watched-state toggle is turned back off. */
  deleteHistory(mediaId: string, episodeId?: string | null): Promise<void>;
  /** All history, most-recently-watched first (capped). Mirrors
   * `fetchAllWatchHistory`. */
  listHistory(limit?: number): Promise<WatchHistoryRecord[]>;
  /** Complete history for one media id, with no global recency window. */
  listHistoryForMedia(mediaId: string): Promise<WatchHistoryRecord[]>;
  /** The resume row for a (mediaId, episodeId), or null. Mirrors
   * `fetchWatchHistory(mediaId:episodeId:)`. */
  getResume(
    mediaId: string,
    episodeId?: string | null,
  ): Promise<WatchHistoryRecord | null>;
  /** Incomplete history with a meaningful resume point, newest first. Mirrors
   * `fetchRecentWatchHistory` (the "Continue Watching" rail). */
  continueWatching(limit?: number): Promise<WatchHistoryRecord[]>;

  // MARK: Library + folders - mirrors user_library / library_folders.

  /** Upsert a library entry (one per (mediaId, folderId/listType)). */
  addToLibrary(entry: LibraryEntryUpsert): Promise<LibraryEntryRecord>;
  /** Remove a library entry by id. */
  removeFromLibrary(id: string): Promise<void>;
  /** Library entries for a list type, most-recently-added first. */
  listLibrary(listType?: ListType): Promise<LibraryEntryRecord[]>;
  /** Library entries inside a folder, most-recently-added first. */
  listLibraryByFolder(folderId: string): Promise<LibraryEntryRecord[]>;

  /** Upsert a folder. */
  saveFolder(folder: LibraryFolderRecord): Promise<void>;
  /** Create a folder under a parent (non-system, supportsFolders types only). */
  createFolder(
    name: string,
    listType: ListType,
    parentId: string | null,
  ): Promise<LibraryFolderRecord>;
  /** All folders, optionally filtered by list type (system folders first). */
  listFolders(listType?: ListType): Promise<LibraryFolderRecord[]>;
  /** Delete a folder by id (system folders are protected). */
  deleteFolder(id: string): Promise<void>;
  /** Ensure the per-list-type system root folders exist. */
  ensureSystemFolders(): Promise<void>;

  // MARK: Indexer configs - mirrors indexer_configs.

  /** Upsert an indexer config. */
  saveIndexerConfig(config: IndexerConfigRecord): Promise<void>;
  /** All indexer configs (active + inactive), priority-ascending. Mirrors
   * `fetchAllIndexerConfigs`. */
  listIndexerConfigs(): Promise<IndexerConfigRecord[]>;
  /** Delete an indexer config by id. */
  deleteIndexerConfig(id: string): Promise<void>;

  // MARK: Debrid configs - mirrors debrid_configs.

  /** Upsert a debrid config. */
  saveDebridConfig(config: DebridConfigRecord): Promise<void>;
  /** All debrid configs (active + inactive), priority-ascending. Mirrors
   * `fetchAllDebridConfigs`. */
  listDebridConfigs(): Promise<DebridConfigRecord[]>;
  /** Delete a debrid config by id. */
  deleteDebridConfig(id: string): Promise<void>;

  // MARK: Taste events - mirrors taste_events.

  /** Append a taste event. Mirrors `saveTasteEvent`. */
  addTasteEvent(event: TasteEventRecord): Promise<void>;
  /** Recent taste events, newest first. Mirrors `fetchTasteEvents`. */
  recentTasteEvents(limit?: number): Promise<TasteEventRecord[]>;

  // MARK: AI usage (local-only token/cost ledger).

  /** Append an AI usage record. Local-only; Server Mode no-ops. */
  addAIUsage(record: AIUsageRecord): Promise<void>;
  /** The running total estimated AI cost (USD) across all recorded calls. */
  totalAIUsageCostUSD(): Promise<number>;

  // MARK: Media cache (optional) - mirrors media_cache.

  /** Cache a MediaItem under `key` (defaults to item.id). Mirrors `saveMedia`. */
  putMedia(item: MediaItem, key?: string): Promise<void>;
  /** Fetch a cached MediaItem by id, or null. Mirrors `fetchMedia`. */
  getMedia(id: string): Promise<MediaCacheRecord | null>;

  // MARK: Cached resolutions - watchlist auto-resolve / pre-resolve.

  /** Upsert the best ready-to-play resolution for a media id (newest wins). */
  putCachedResolution(record: CachedResolutionRecord): Promise<void>;
  /** The cached resolution for a media id, or null. */
  getCachedResolution(mediaId: string): Promise<CachedResolutionRecord | null>;
  /** Cached resolutions for a bounded set of media ids. */
  getCachedResolutions(mediaIds: string[]): Promise<CachedResolutionRecord[]>;
  /** All cached resolutions (for the watchlist "Ready to play" badge pass). */
  listCachedResolutions(): Promise<CachedResolutionRecord[]>;
  /** Drop a cached resolution by media id (e.g. when removed from watchlist). */
  deleteCachedResolution(mediaId: string): Promise<void>;

  // MARK: Desktop downloads (Local Mode / Tauri only).

  saveDownload(record: DownloadRecord): Promise<void>;
  updateDownload(
    jobId: string,
    changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
  ): Promise<DownloadRecord | null>;
  deleteDownload(jobId: string): Promise<void>;
  listDownloads(): Promise<DownloadRecord[]>;
  subscribeDownloads(listener: (records: DownloadRecord[]) => void): () => void;
}

/** The fields a caller provides to upsert a watch-history row. `id` is derived
 * from (mediaId, episodeId) by the store. */
export interface WatchHistoryUpsert {
  mediaId: string;
  episodeId?: string | null;
  progressSeconds?: number;
  durationSeconds?: number | null;
  completed?: boolean;
  /** Queue a series episode as the explicit next handoff target. */
  queuedNext?: boolean;
  streamQuality?: string | null;
  /** Display snapshot stored alongside so History renders without a join. */
  preview: MediaPreview;
  /** Override the watch timestamp (defaults to now). */
  lastWatched?: string;
  /** Remembered in-window-player prefs (audio/sub track, speed). Optional; when
   * omitted an existing row's values are preserved (not wiped). */
  preferredAudioId?: string | null;
  preferredAudioLang?: string | null;
  preferredSubId?: string | null;
  playbackSpeed?: number | null;
  subtitleDelay?: number | null;
  subtitlePosition?: number | null;
}

/** The fields a caller provides to upsert a library entry. */
export interface LibraryEntryUpsert {
  mediaId: string;
  listType: ListType;
  folderId?: string | null;
  customListName?: string | null;
  releaseDateHint?: string | null;
  renewalStatus?: string | null;
  preview: MediaPreview;
  addedAt?: string;
}
