// DexieStore - the IndexedDB-backed implementation of `Store` + `SecretStore`.
//
// IndexedDB works in BOTH a plain browser AND the Tauri webview, so a single
// implementation covers web and desktop with no Rust/SQLite plugin. Dexie gives
// us a typed, promise-based wrapper with a versioned schema (object stores +
// indexes). Everything is async; upsert/dedup semantics match the Swift
// DatabaseManager (one watch-history row per (mediaId, episodeId), newest wins;
// the watchlist has no duplicates; library entries are unique per
// (mediaId, folderId)).
//
// Tests run this against `fake-indexeddb` (see DexieStore.test.ts), which
// provides a spec-compliant in-memory IndexedDB.

import Dexie, { liveQuery, type Table } from "dexie";
import type { MediaItem, MediaPreview } from "../models/media";
import {
  type AIUsageRecord,
  type CachedResolutionRecord,
  type DebridConfigRecord,
  type DownloadRecord,
  type FolderKind,
  hasResumePoint,
  type IndexerConfigRecord,
  type LibraryEntryRecord,
  type LibraryFolderRecord,
  type ListType,
  listTypeSupportsFolders,
  type MediaCacheRecord,
  type SecretRecord,
  type SettingRecord,
  systemFolderID,
  systemFolderName,
  type TasteEventRecord,
  type WatchHistoryRecord,
  type WatchlistFolderRecord,
  type WatchlistRecord,
} from "./models";
import type {
  LibraryEntryUpsert,
  SecretStore,
  Store,
  WatchHistoryUpsert,
} from "./types";

/** The list types that get a system root folder (mirrors the Swift
 * UserLibraryEntry.ListType.allCases). */
const LIST_TYPES: ListType[] = ["watchlist", "favorites", "custom"];
const OPEN_TIMEOUT_MS = 10_000;
const MEDIA_CACHE_CAP = 500;
const TASTE_EVENTS_CAP = 1_000;
const AI_USAGE_CAP = 1_000;
const EXPLICIT_TASTE_EVENT_TYPES: ReadonlySet<TasteEventRecord["eventType"]> = new Set([
  "rated",
  "liked",
  "disliked",
]);

export interface StorageIssue {
  kind: "blocked" | "open-failed";
  message: string;
  error?: unknown;
}

/** Compose the (mediaId, episodeId) watch-history primary key. A null/absent
 * episodeId collapses to the media-level row. */
function historyKey(mediaId: string, episodeId: string | null | undefined): string {
  return `${mediaId}:${episodeId ?? ""}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for environments without crypto.randomUUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DexieStore extends Dexie implements Store, SecretStore {
  // Typed tables (Dexie populates these from the schema below).
  private settings!: Table<SettingRecord, string>;
  private secrets!: Table<SecretRecord, string>;
  private watchlist!: Table<WatchlistRecord, string>;
  private watchlistFolders!: Table<WatchlistFolderRecord, string>;
  private watchHistory!: Table<WatchHistoryRecord, string>;
  private library!: Table<LibraryEntryRecord, string>;
  private folders!: Table<LibraryFolderRecord, string>;
  private indexerConfigs!: Table<IndexerConfigRecord, string>;
  private debridConfigs!: Table<DebridConfigRecord, string>;
  private tasteEvents!: Table<TasteEventRecord, string>;
  private mediaCache!: Table<MediaCacheRecord, string>;
  private cachedResolutions!: Table<CachedResolutionRecord, string>;
  private aiUsage!: Table<AIUsageRecord, string>;
  private downloads!: Table<DownloadRecord, string>;
  private openReady: Promise<void>;
  private storageIssue: StorageIssue | null = null;
  private readonly storageIssueListeners = new Set<(issue: StorageIssue) => void>();

  constructor(name = "debridstreamer") {
    super(name);

    // v1 schema. Primary keys are the leading field; `&` marks a unique index;
    // other comma-separated entries are secondary indexes used by the queries
    // below (e.g. watchHistory by lastWatched for recency ordering, library by
    // folderId / listType, configs by priority).
    this.version(1).stores({
      settings: "key",
      secrets: "key",
      watchlist: "mediaId, addedAt",
      watchHistory: "id, mediaId, lastWatched, completed",
      library: "id, mediaId, folderId, listType, addedAt",
      folders: "id, parentId, listType, isSystem",
      indexerConfigs: "id, priority, isActive",
      debridConfigs: "id, priority, isActive",
      tasteEvents: "id, userId, createdAt",
      mediaCache: "id, lastFetched",
    });

    // v2: adds the watchlist auto-resolve cache (one ready-to-play resolution
    // per media id, indexed by resolvedAt for staleness sweeps). Dexie carries
    // every v1 store forward automatically; only the new store is declared.
    this.version(2).stores({
      cachedResolutions: "mediaId, resolvedAt",
    });

    // v3: adds the local AI usage ledger (one row per AI call, indexed by
    // createdAt for recency ordering). Local-only - the "Would I Like This?"
    // analysis writes a record here on each call so a running cost estimate can
    // be shown. Dexie carries the prior stores forward; only the new one is here.
    this.version(3).stores({
      aiUsage: "id, createdAt",
    });

    // v4: durable desktop download queue. jobId is both the primary key and
    // the native executor's progress-event correlation id.
    this.version(4).stores({
      downloads: "jobId, status, updatedAt, createdAt, mediaId, episodeId",
    });

    // v5 is deliberately additive: it only creates indexes on the existing
    // tasteEvents store, preserving every pre-v5 row during upgrade.
    this.version(5).stores({
      tasteEvents: "id, userId, createdAt, mediaId, eventType, [mediaId+createdAt]",
    });

    // v6: named Watchlist folders are deliberately separate from Library
    // folders. This declaration adds the nullable folderId index to existing
    // watchlist rows and a new folder table. The upgrade writes only the new
    // field, preserving every existing preview and addedAt value.
    this.version(6)
      .stores({
        watchlist: "mediaId, addedAt, folderId",
        watchlistFolders: "id, name, createdAt, updatedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("watchlist")
          .toCollection()
          .modify((row: WatchlistRecord) => {
            if (row.folderId === undefined) row.folderId = null;
          });
      });

    // v7: queued next episodes are a durable state, not a fake 0% resume.
    this.version(7)
      .stores({
        watchHistory: "id, mediaId, lastWatched, completed, queuedNext",
      })
      .upgrade(async (tx) => {
        await tx.table("watchHistory").toCollection().modify((row: WatchHistoryRecord) => {
          if (row.queuedNext === undefined) row.queuedNext = false;
        });
      });

    this.on("blocked", () => {
      this.reportStorageIssue({
        kind: "blocked",
        message: "Local storage upgrade is blocked by another open YAWF Stream tab.",
      });
    });
    this.openReady = this.startOpenAttempt();
  }

  /** Subscribe to recoverable IndexedDB failures for a toast/support surface. */
  onStorageIssue(listener: (issue: StorageIssue) => void): () => void {
    this.storageIssueListeners.add(listener);
    if (this.storageIssue != null) listener(this.storageIssue);
    return () => this.storageIssueListeners.delete(listener);
  }

  getStorageIssue(): StorageIssue | null {
    return this.storageIssue;
  }

  /** Explicit recovery path. Never deletes data automatically. */
  async resetLocalData(): Promise<void> {
    this.close();
    await Dexie.delete(this.name);
    this.storageIssue = null;
    this.openReady = this.startOpenAttempt();
    await this.openReady;
  }

  private startOpenAttempt(): Promise<void> {
    const attempt = this.openWithTimeout();
    void attempt.catch(() => undefined);
    return attempt;
  }

  private openWithTimeout(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error("Timed out opening local storage.");
        this.reportStorageIssue({ kind: "open-failed", message: error.message, error });
        reject(error);
      }, OPEN_TIMEOUT_MS);
      this.open().then(
        () => {
          clearTimeout(timeout);
          this.storageIssue = null;
          resolve();
        },
        (error) => {
          clearTimeout(timeout);
          this.reportStorageIssue({
            kind: "open-failed",
            message: "Could not open local storage. Reset local data to recover.",
            error,
          });
          reject(error);
        },
      );
    });
  }

  private async ready(): Promise<void> {
    const attempt = this.openReady;
    try {
      await attempt;
      return;
    } catch {
      // A timed-out blocked upgrade may have completed after the timeout fired.
      // Normalize the ready state instead of bricking every later operation.
      if (this.isOpen()) {
        if (this.openReady === attempt) this.openReady = Promise.resolve();
        return;
      }

      // Only one caller replaces a failed attempt. Dexie reuses an outstanding
      // open internally, so this also safely rejoins a still-blocked upgrade.
      if (this.openReady === attempt) this.openReady = this.startOpenAttempt();
      await this.openReady;
    }
  }

  private reportStorageIssue(issue: StorageIssue): void {
    this.storageIssue = issue;
    for (const listener of this.storageIssueListeners) listener(issue);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("debridstreamer:storage-issue", { detail: issue }));
    }
    console.warn("[YAWF Stream storage]", issue.message, issue.error ?? "");
  }

  private async pruneOldest<T>(table: Table<T, string>, index: string, cap: number): Promise<void> {
    const count = await table.count();
    if (count <= cap) return;
    const keys = await table.orderBy(index).limit(count - cap).primaryKeys();
    await table.bulkDelete(keys as string[]);
  }

  private async pruneImplicitTasteEvents(): Promise<void> {
    const implicitCount = await this.tasteEvents
      .where("eventType")
      .noneOf([...EXPLICIT_TASTE_EVENT_TYPES])
      .count();
    if (implicitCount <= TASTE_EVENTS_CAP) return;

    const keys = await this.tasteEvents
      .orderBy("createdAt")
      .filter((event) => !EXPLICIT_TASTE_EVENT_TYPES.has(event.eventType))
      .limit(implicitCount - TASTE_EVENTS_CAP)
      .primaryKeys();
    await this.tasteEvents.bulkDelete(keys);
  }

  // ---- Settings -------------------------------------------------------------

  async getSetting(key: string): Promise<string | null> {
    await this.ready();
    const row = await this.settings.get(key);
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    await this.ready();
    if (value == null) {
      await this.settings.delete(key);
      return;
    }
    await this.settings.put({ key, value });
  }

  async allSettings(): Promise<Record<string, string>> {
    await this.ready();
    const rows = await this.settings.toArray();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ---- Secrets (SecretStore) -----------------------------------------------

  async getSecret(key: string): Promise<string | null> {
    await this.ready();
    const row = await this.secrets.get(key);
    return row?.value ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.ready();
    await this.secrets.put({ key, value });
  }

  async deleteSecret(key: string): Promise<void> {
    await this.ready();
    await this.secrets.delete(key);
  }

  // ---- Watchlist ------------------------------------------------------------

  async addToWatchlist(
    preview: MediaPreview,
    folderId?: string | null,
  ): Promise<void> {
    await this.ready();
    if (folderId != null && (await this.watchlistFolders.get(folderId)) == null) {
      throw new Error("That watchlist folder no longer exists.");
    }
    // Keyed by mediaId → put() is an upsert, so there can be no duplicate.
    // Preserve the original addedAt when re-adding so ordering is stable, but
    // refresh the stored preview (metadata may have improved).
    const existing = await this.watchlist.get(preview.id);
    await this.watchlist.put({
      mediaId: preview.id,
      addedAt: existing?.addedAt ?? nowISO(),
      // A normal re-add keeps the folder. Imports can intentionally supply a
      // folder id to file existing or newly-added titles together.
      folderId: folderId === undefined ? existing?.folderId ?? null : folderId,
      preview,
    });
  }

  async removeFromWatchlist(mediaId: string): Promise<void> {
    await this.ready();
    await this.watchlist.delete(mediaId);
  }

  async listWatchlist(): Promise<WatchlistRecord[]> {
    await this.ready();
    const rows = await this.watchlist.toArray();
    // Most-recently-added first.
    return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async isInWatchlist(mediaId: string): Promise<boolean> {
    await this.ready();
    return (await this.watchlist.get(mediaId)) != null;
  }

  async createWatchlistFolder(name: string): Promise<WatchlistFolderRecord> {
    await this.ready();
    const base = name.trim() || "New Folder";
    const folders = await this.watchlistFolders.toArray();
    const taken = new Set(folders.map((folder) => folder.name));
    let uniqueName = base;
    let suffix = 2;
    while (taken.has(uniqueName)) {
      uniqueName = `${base} (${suffix})`;
      suffix += 1;
    }
    const folder: WatchlistFolderRecord = {
      id: `watchlist-folder-${uuid()}`,
      name: uniqueName,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    await this.watchlistFolders.put(folder);
    return folder;
  }

  async listWatchlistFolders(): Promise<WatchlistFolderRecord[]> {
    await this.ready();
    const folders = await this.watchlistFolders.toArray();
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  async renameWatchlistFolder(id: string, name: string): Promise<void> {
    await this.ready();
    const folder = await this.watchlistFolders.get(id);
    if (folder == null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error("Folder names cannot be empty.");
    const duplicate = await this.watchlistFolders
      .where("name")
      .equals(trimmed)
      .filter((candidate) => candidate.id !== id)
      .first();
    if (duplicate != null) throw new Error("A watchlist folder already has that name.");
    await this.watchlistFolders.update(id, { name: trimmed, updatedAt: nowISO() });
  }

  async deleteWatchlistFolder(id: string): Promise<void> {
    await this.ready();
    await this.transaction("rw", this.watchlist, this.watchlistFolders, async () => {
      if ((await this.watchlistFolders.get(id)) == null) return;
      const rows = await this.watchlist.where("folderId").equals(id).toArray();
      for (const row of rows) {
        await this.watchlist.update(row.mediaId, { folderId: null });
      }
      await this.watchlistFolders.delete(id);
    });
  }

  async assignWatchlistFolder(mediaId: string, folderId: string | null): Promise<void> {
    await this.ready();
    if (folderId != null && (await this.watchlistFolders.get(folderId)) == null) {
      throw new Error("That watchlist folder no longer exists.");
    }
    await this.watchlist.update(mediaId, { folderId });
  }

  // ---- Watch history / resume ----------------------------------------------

  async recordHistory(entry: WatchHistoryUpsert): Promise<WatchHistoryRecord> {
    await this.ready();
    const episodeId = entry.episodeId ?? null;
    const id = historyKey(entry.mediaId, episodeId);
    // `put` REPLACES the row, so a progress-only write must not wipe the
    // remembered player prefs - carry the existing values forward when omitted.
    const prev = await this.watchHistory.get(id);
    // Upsert by the derived key → exactly one row per (mediaId, episodeId),
    // newest wins (put replaces). Mirrors WatchHistory.save in GRDB.
    // Beginning playback turns a queued target into an ordinary history row.
    // A real resume always wins over a later queue request for the same target.
    const queuedTargetHasRealResume =
      entry.queuedNext && prev != null && !prev.completed && hasResumePoint(prev);
    if (queuedTargetHasRealResume) {
      // A real target resume wins, but stale predictive handoffs for the same
      // series must still be removed before returning it.
      await this.transaction("rw", this.watchHistory, async () => {
        const stale = await this.watchHistory.where("mediaId").equals(entry.mediaId).toArray();
        await this.watchHistory.bulkDelete(stale
          .filter((row) => row.queuedNext && row.id !== id)
          .map((row) => row.id));
      });
      return prev;
    }
    const record: WatchHistoryRecord = {
      id,
      mediaId: entry.mediaId,
      episodeId,
      progressSeconds: entry.progressSeconds ?? 0,
      durationSeconds: entry.durationSeconds ?? null,
      completed: entry.completed ?? false,
      queuedNext: entry.queuedNext ?? false,
      lastWatched: entry.lastWatched ?? nowISO(),
      streamQuality: entry.streamQuality ?? null,
      preview: entry.preview,
      preferredAudioId: entry.preferredAudioId ?? prev?.preferredAudioId ?? null,
      preferredAudioLang:
        entry.preferredAudioLang ?? prev?.preferredAudioLang ?? null,
      preferredSubId: entry.preferredSubId ?? prev?.preferredSubId ?? null,
      playbackSpeed: entry.playbackSpeed ?? prev?.playbackSpeed ?? null,
      subtitleDelay: entry.subtitleDelay ?? prev?.subtitleDelay ?? null,
      subtitlePosition: entry.subtitlePosition ?? prev?.subtitlePosition ?? null,
    };
    await this.transaction("rw", this.watchHistory, async () => {
      if (record.queuedNext) {
        // A show has at most one predictive handoff. Do not erase genuine resumes.
        const stale = await this.watchHistory.where("mediaId").equals(record.mediaId).toArray();
        await this.watchHistory.bulkDelete(stale
          .filter((row) => row.queuedNext && row.id !== record.id)
          .map((row) => row.id));
      }
      await this.watchHistory.put(record);
    });
    return record;
  }

  async deleteHistory(mediaId: string, episodeId?: string | null): Promise<void> {
    await this.ready();
    await this.watchHistory.delete(historyKey(mediaId, episodeId ?? null));
  }

  async listHistory(limit = 100): Promise<WatchHistoryRecord[]> {
    await this.ready();
    // lastWatched index → reverse for newest-first, then cap.
    return this.watchHistory
      .orderBy("lastWatched")
      .reverse()
      .limit(limit)
      .toArray();
  }

  async listHistoryForMedia(mediaId: string): Promise<WatchHistoryRecord[]> {
    await this.ready();
    const rows = await this.watchHistory.where("mediaId").equals(mediaId).toArray();
    return rows.sort((left, right) =>
      right.lastWatched.localeCompare(left.lastWatched),
    );
  }

  async getResume(
    mediaId: string,
    episodeId?: string | null,
  ): Promise<WatchHistoryRecord | null> {
    await this.ready();
    const row = await this.watchHistory.get(historyKey(mediaId, episodeId ?? null));
    return row ?? null;
  }

  async continueWatching(limit = 20): Promise<WatchHistoryRecord[]> {
    await this.ready();
    // Rows with a real resume point, newest first - mirrors fetchRecentWatchHistory.
    // Filter to resumable BEFORE slicing: zero-progress "viewed" rows (written
    // when a Detail opens) would otherwise fill the limit and crowd genuinely
    // resumable titles out of Continue Watching.
    // Match RemoteStore's bounded contract so malformed caller input cannot
    // turn this hot path into an unbounded IndexedDB scan.
    if (Number.isFinite(limit) && limit <= 0) return [];
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(20, Math.max(1, Math.floor(limit)))
      : 20;

    const rows: WatchHistoryRecord[] = [];
    await this.watchHistory
      .orderBy("lastWatched")
      .reverse()
      // `until` stops the reverse cursor as soon as the requested number of
      // resumable rows has been collected, rather than deserializing every
      // zero-progress Detail-open row in an unbounded history.
      .until(() => rows.length >= boundedLimit)
      .each((row) => {
        if (!row.completed && (row.queuedNext || hasResumePoint(row))) rows.push(row);
      });
    return rows;
  }

  // ---- Library + folders ----------------------------------------------------

  async addToLibrary(entry: LibraryEntryUpsert): Promise<LibraryEntryRecord> {
    await this.ready();
    // Serialize the reconcile-then-put in one transaction: the table is keyed by
    // a random uuid, so this read-then-decide is the ONLY thing enforcing the
    // one-row-per-(mediaId, folderId) invariant. Without a transaction, two
    // overlapping adds of the same media could both observe "absent" and insert
    // two permanent duplicate rows.
    return this.transaction("rw", this.library, this.folders, async () => {
      await this.ensureSystemFolders();

      // Resolve the folder the way the Swift addToLibrary normalization does:
      // non-folder list types pin to the system root; folder list types default
      // an empty folderId to the system root.
      const resolvedFolderId = listTypeSupportsFolders(entry.listType)
        ? (entry.folderId?.trim() || systemFolderID(entry.listType))
        : systemFolderID(entry.listType);

      // Reconcile on (mediaId, folderId) so re-adding the same media to the same
      // folder updates the existing row instead of creating a duplicate.
      const existing = await this.library
        .where("mediaId")
        .equals(entry.mediaId)
        .filter((r) => r.folderId === resolvedFolderId)
        .first();

      const record: LibraryEntryRecord = {
        id: existing?.id ?? `lib-${uuid()}`,
        mediaId: entry.mediaId,
        folderId: resolvedFolderId,
        listType: entry.listType,
        addedAt: entry.addedAt ?? existing?.addedAt ?? nowISO(),
        customListName: entry.customListName ?? existing?.customListName ?? null,
        releaseDateHint:
          entry.releaseDateHint ?? existing?.releaseDateHint ?? null,
        renewalStatus: entry.renewalStatus ?? existing?.renewalStatus ?? null,
        preview: entry.preview,
      };
      await this.library.put(record);
      return record;
    });
  }

  async removeFromLibrary(id: string): Promise<void> {
    await this.ready();
    await this.library.delete(id);
  }

  async listLibrary(listType?: ListType): Promise<LibraryEntryRecord[]> {
    await this.ready();
    const rows = listType
      ? await this.library.where("listType").equals(listType).toArray()
      : await this.library.toArray();
    return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async listLibraryByFolder(folderId: string): Promise<LibraryEntryRecord[]> {
    await this.ready();
    const rows = await this.library.where("folderId").equals(folderId).toArray();
    return rows.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async saveFolder(folder: LibraryFolderRecord): Promise<void> {
    await this.ready();
    await this.folders.put(folder);
  }

  async createFolder(
    name: string,
    listType: ListType,
    parentId: string | null,
  ): Promise<LibraryFolderRecord> {
    await this.ready();
    if (!listTypeSupportsFolders(listType)) {
      throw new Error(`Folders are not supported for ${listType}.`);
    }
    await this.ensureSystemFolders();
    const resolvedParentId = parentId ?? systemFolderID(listType);
    const uniqueName = await this.uniqueFolderName(name, listType, resolvedParentId);
    const folder: LibraryFolderRecord = {
      id: `folder-${uuid()}`,
      name: uniqueName,
      parentId: resolvedParentId,
      listType,
      folderKind: "manual",
      isSystem: false,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    await this.folders.put(folder);
    return folder;
  }

  async listFolders(listType?: ListType): Promise<LibraryFolderRecord[]> {
    await this.ready();
    const rows = listType
      ? await this.folders.where("listType").equals(listType).toArray()
      : await this.folders.toArray();
    // System folders first, then by name - mirrors fetchAllLibraryFolders.
    return rows.sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async deleteFolder(id: string): Promise<void> {
    await this.ready();
    // One transaction over both tables: reassigning entries, re-parenting
    // children and deleting the folder is a single logical edit, so a failure
    // partway through must not leave entries pointing at a deleted folder.
    await this.transaction("rw", this.library, this.folders, async () => {
      const folder = await this.folders.get(id);
      if (folder == null) return;
      if (folder.isSystem) {
        throw new Error("System folders cannot be deleted");
      }
      // Reassign this folder's entries to the system root, then delete it.
      const fallback = systemFolderID(folder.listType);
      const entries = await this.library.where("folderId").equals(id).toArray();
      for (const entry of entries) {
        // Skip if the media already lives in the fallback (avoid a duplicate).
        const collides = await this.library
          .where("mediaId")
          .equals(entry.mediaId)
          .filter((r) => r.folderId === fallback)
          .first();
        if (collides) {
          await this.library.delete(entry.id);
        } else {
          await this.library.update(entry.id, { folderId: fallback });
        }
      }
      // Re-parent child folders to the root (parentId: null) rather than leaving
      // dangling parentId references - mirrors the server's ON DELETE SET NULL so
      // a subtree stays reachable after its parent is deleted.
      const children = await this.folders.where("parentId").equals(id).toArray();
      for (const child of children) {
        await this.folders.update(child.id, { parentId: null, updatedAt: nowISO() });
      }
      await this.folders.delete(id);
    });
  }

  async ensureSystemFolders(): Promise<void> {
    await this.ready();
    for (const listType of LIST_TYPES) {
      const id = systemFolderID(listType);
      const existing = await this.folders.get(id);
      if (existing == null) {
        await this.folders.put({
          id,
          name: systemFolderName(listType),
          parentId: null,
          listType,
          folderKind: "system_root",
          isSystem: true,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
      }
    }
    // Behavior folders under the favorites (Library) root - Watched / Release Wait.
    const libraryRoot = systemFolderID("favorites");
    const behaviors: { id: string; name: string; kind: FolderKind }[] = [
      { id: "system-favorites-watched", name: "Watched", kind: "watched" },
      {
        id: "system-favorites-release-wait",
        name: "Release Wait",
        kind: "release_wait",
      },
    ];
    for (const b of behaviors) {
      const existing = await this.folders.get(b.id);
      if (existing == null) {
        await this.folders.put({
          id: b.id,
          name: b.name,
          parentId: libraryRoot,
          listType: "favorites",
          folderKind: b.kind,
          isSystem: true,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
      }
    }
  }

  private async uniqueFolderName(
    desired: string,
    listType: ListType,
    parentId: string | null,
  ): Promise<string> {
    const base = desired.trim().length > 0 ? desired.trim() : "New Folder";
    const siblings = await this.folders
      .where("listType")
      .equals(listType)
      .filter((f) => f.parentId === parentId)
      .toArray();
    const taken = new Set(siblings.map((f) => f.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} (${i})`)) i += 1;
    return `${base} (${i})`;
  }

  // ---- Indexer configs ------------------------------------------------------

  async saveIndexerConfig(config: IndexerConfigRecord): Promise<void> {
    await this.ready();
    await this.indexerConfigs.put(config);
  }

  async listIndexerConfigs(): Promise<IndexerConfigRecord[]> {
    await this.ready();
    const rows = await this.indexerConfigs.toArray();
    return rows.sort((a, b) => a.priority - b.priority);
  }

  async deleteIndexerConfig(id: string): Promise<void> {
    await this.ready();
    await this.indexerConfigs.delete(id);
  }

  // ---- Debrid configs -------------------------------------------------------

  async saveDebridConfig(config: DebridConfigRecord): Promise<void> {
    await this.ready();
    await this.debridConfigs.put(config);
  }

  async listDebridConfigs(): Promise<DebridConfigRecord[]> {
    await this.ready();
    const rows = await this.debridConfigs.toArray();
    return rows.sort((a, b) => a.priority - b.priority);
  }

  async deleteDebridConfig(id: string): Promise<void> {
    await this.ready();
    await this.debridConfigs.delete(id);
  }

  // ---- Taste events ---------------------------------------------------------

  async addTasteEvent(event: TasteEventRecord): Promise<void> {
    await this.ready();
    await this.tasteEvents.put(event);
    await this.pruneImplicitTasteEvents();
  }

  async recentTasteEvents(limit = 100): Promise<TasteEventRecord[]> {
    await this.ready();
    return this.tasteEvents
      .orderBy("createdAt")
      .reverse()
      .limit(limit)
      .toArray();
  }

  /** Per-title lookup uses the v5 compound index instead of scanning recency. */
  async recentTasteEventsForMedia(
    mediaId: string,
    limit = 100,
  ): Promise<TasteEventRecord[]> {
    await this.ready();
    return this.tasteEvents
      .where("[mediaId+createdAt]")
      .between([mediaId, Dexie.minKey], [mediaId, Dexie.maxKey])
      .reverse()
      .limit(limit)
      .toArray();
  }

  // ---- AI usage (local-only token/cost ledger) ------------------------------

  async addAIUsage(record: AIUsageRecord): Promise<void> {
    await this.ready();
    await this.aiUsage.put(record);
    await this.pruneOldest(this.aiUsage, "createdAt", AI_USAGE_CAP);
  }

  async totalAIUsageCostUSD(): Promise<number> {
    await this.ready();
    let total = 0;
    await this.aiUsage.each((row) => {
      total += row.estimatedCostUSD ?? 0;
    });
    return total;
  }

  // ---- Media cache ----------------------------------------------------------

  async putMedia(item: MediaItem, key: string = item.id): Promise<void> {
    await this.ready();
    // `key` lets a caller cache under a STABLE lookup id (e.g. the preview id
    // "tmdb-603") that differs from item.id (an IMDb "tt..." id), so the Offline
    // read path can find it by the same id the browse card carries.
    await this.mediaCache.put({ id: key, item, lastFetched: nowISO() });
    await this.pruneOldest(this.mediaCache, "lastFetched", MEDIA_CACHE_CAP);
  }

  async getMedia(id: string): Promise<MediaCacheRecord | null> {
    await this.ready();
    return (await this.mediaCache.get(id)) ?? null;
  }

  // ---- Cached resolutions (watchlist auto-resolve) --------------------------

  async putCachedResolution(record: CachedResolutionRecord): Promise<void> {
    await this.ready();
    // Keyed by mediaId → put() is an upsert, so exactly one resolution is kept
    // per title; re-resolving replaces the previous (newest wins).
    await this.cachedResolutions.put(record);
  }

  async getCachedResolution(
    mediaId: string,
  ): Promise<CachedResolutionRecord | null> {
    await this.ready();
    return (await this.cachedResolutions.get(mediaId)) ?? null;
  }

  async getCachedResolutions(mediaIds: string[]): Promise<CachedResolutionRecord[]> {
    await this.ready();
    if (mediaIds.length === 0) return [];
    const rows = await this.cachedResolutions.bulkGet(mediaIds);
    return rows.filter((row): row is CachedResolutionRecord => row != null);
  }

  async listCachedResolutions(): Promise<CachedResolutionRecord[]> {
    await this.ready();
    return this.cachedResolutions.toArray();
  }

  async deleteCachedResolution(mediaId: string): Promise<void> {
    await this.ready();
    await this.cachedResolutions.delete(mediaId);
  }

  // ---- Desktop downloads ---------------------------------------------------

  async saveDownload(record: DownloadRecord): Promise<void> {
    await this.ready();
    await this.downloads.put(record);
  }

  async updateDownload(
    jobId: string,
    changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
  ): Promise<DownloadRecord | null> {
    await this.ready();
    const current = await this.downloads.get(jobId);
    if (current == null) return null;
    const next: DownloadRecord = {
      ...current,
      ...changes,
      jobId,
      createdAt: current.createdAt,
      updatedAt: changes.updatedAt ?? nowISO(),
    };
    await this.downloads.put(next);
    return next;
  }

  async deleteDownload(jobId: string): Promise<void> {
    await this.ready();
    await this.downloads.delete(jobId);
  }

  async listDownloads(): Promise<DownloadRecord[]> {
    await this.ready();
    const rows = await this.downloads.toArray();
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  subscribeDownloads(listener: (records: DownloadRecord[]) => void): () => void {
    const subscription = liveQuery(() => this.listDownloads()).subscribe({
      next: listener,
      error: () => listener([]),
    });
    return () => subscription.unsubscribe();
  }
}
