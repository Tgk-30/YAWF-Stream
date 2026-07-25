import type { MediaItem, MediaPreview } from "../models/media";
import type {
  AIUsageRecord,
  CachedResolutionRecord,
  DebridConfigRecord,
  DownloadRecord,
  IndexerConfigRecord,
  FolderKind,
  LibraryEntryRecord,
  LibraryFolderRecord,
  ListType,
  MediaCacheRecord,
  TasteEventRecord,
  WatchHistoryRecord,
  WatchlistFolderRecord,
  WatchlistRecord,
} from "./models";
import { hasResumePoint } from "./models";
import type {
  LibraryEntryUpsert,
  SecretStore,
  Store,
  WatchHistoryUpsert,
} from "./types";

import { notifyUnauthorized, readCsrfToken } from "../lib/serverSession";

type JsonObject = Record<string, unknown>;

const SECRET_MARKER = "secret:";
const SERVER_INDEXER_CONFIGS_KEY = "server_indexer_configs";

const SECRET_CREDENTIAL_PROVIDERS: Record<
  string,
  "tmdb" | "omdb" | "opensubtitles"
> = {
  tmdb_api_key: "tmdb",
  omdb_api_key: "omdb",
  opensubtitles_api_key: "opensubtitles",
};

function historyKey(mediaId: string, episodeId: string | null | undefined): string {
  return `${mediaId}:${episodeId ?? ""}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

class ServerAPI {
  constructor(private readonly baseURL: string) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    const unsafe = method !== "GET" && method !== "HEAD";
    if (body !== undefined) headers["content-type"] = "application/json";
    if (unsafe) {
      const csrf = readCsrfToken();
      if (csrf != null) headers["x-csrf-token"] = csrf;
    }

    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: JsonObject = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as JsonObject;
      } catch {
        // Non-JSON body (e.g. an HTML 5xx page from a reverse proxy). Fall back
        // to a status-based message below rather than throwing a parse error
        // that masks the real HTTP status.
        parsed = {};
      }
    }
    if (!response.ok) {
      if (response.status === 401) notifyUnauthorized();
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : `Server request failed (${response.status}).`;
      const error = new Error(message) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return parsed as T;
  }
}

interface ServerWatchlistResponse {
  items: Array<{
    mediaId: string;
    addedAt: string;
    preview: MediaPreview;
  }>;
}

interface ServerHistoryResponse {
  view?: string;
  items: Array<{
    mediaId: string;
    episodeId: string | null;
    progressSeconds: number;
    durationSeconds: number | null;
    completed: boolean;
    queuedNext?: boolean;
    lastWatched: string;
    streamQuality: string | null;
    preview: MediaPreview;
  }>;
}

function mapHistory(row: ServerHistoryResponse["items"][number]): WatchHistoryRecord {
  return {
    id: historyKey(row.mediaId, row.episodeId),
    mediaId: row.mediaId,
    episodeId: row.episodeId,
    progressSeconds: row.progressSeconds,
    durationSeconds: row.durationSeconds,
    completed: row.completed,
    queuedNext: row.queuedNext ?? false,
    lastWatched: row.lastWatched,
    streamQuality: row.streamQuality,
    preview: row.preview,
  };
}

// ---- Library + folders (Server Mode) --------------------------------------
interface ServerLibraryEntry {
  id: string;
  mediaId: string;
  folderId: string | null;
  listType: ListType;
  addedAt: string;
  customListName: string | null;
  releaseDateHint: string | null;
  renewalStatus: string | null;
  preview: MediaPreview;
}
interface ServerFolder {
  id: string;
  name: string;
  parentId: string | null;
  listType: ListType;
  folderKind: FolderKind;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

function mapLibraryEntry(r: ServerLibraryEntry): LibraryEntryRecord {
  return {
    id: r.id,
    mediaId: r.mediaId,
    folderId: r.folderId,
    listType: r.listType,
    addedAt: r.addedAt,
    customListName: r.customListName,
    releaseDateHint: r.releaseDateHint,
    renewalStatus: r.renewalStatus,
    preview: r.preview,
  };
}
function mapFolder(r: ServerFolder): LibraryFolderRecord {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parentId,
    listType: r.listType,
    folderKind: r.folderKind,
    isSystem: r.isSystem,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function unsupportedRemoteWrite(name: string): Error {
  return new Error(`${name} is not available in Server Mode yet.`);
}

export class RemoteStore implements Store, SecretStore {
  private readonly api: ServerAPI;
  private settingsCache: Record<string, string> | null = null;
  // Bumped on every settings mutation. allSettings() captures it before its
  // fetch and only caches the response if it hasn't changed since - so a
  // setSetting() that lands while a fetch is in flight can't be silently
  // clobbered by the fetch caching a pre-mutation snapshot (lost update).
  private settingsGen = 0;
  private pendingSecrets = new Map<string, string>();

  constructor(baseURL: string) {
    this.api = new ServerAPI(baseURL);
  }

  /** Drop the per-profile settings cache. Called after a "who's watching"
   *  profile switch so the next read re-fetches the NEW active profile's
   *  settings instead of serving the previous profile's cached copy. */
  resetProfileCache(): void {
    this.settingsCache = null;
    // Bump so any allSettings() fetch already in flight (for the OLD profile)
    // won't cache its response into the NEW profile after the switch.
    this.settingsGen += 1;
    this.pendingSecrets.clear();
  }

  async getSetting(key: string): Promise<string | null> {
    const settings = await this.allSettings();
    return settings[key] ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    await this.api.put("/api/settings/profile", { key, value });
    this.settingsGen += 1;
    if (this.settingsCache != null) {
      if (value == null) delete this.settingsCache[key];
      else this.settingsCache[key] = value;
    }
  }

  async allSettings(): Promise<Record<string, string>> {
    if (this.settingsCache != null) return { ...this.settingsCache };
    const gen = this.settingsGen;
    const response = await this.api.get<{ settings: Record<string, string> }>(
      "/api/settings/profile",
    );
    // Only adopt this snapshot if no setSetting()/reset landed mid-flight; a
    // concurrent mutation may have updated the server past this response.
    if (this.settingsCache == null && this.settingsGen === gen) {
      this.settingsCache = response.settings;
    }
    return { ...(this.settingsCache ?? response.settings) };
  }

  async getSecret(_key: string): Promise<string | null> {
    // Server Mode never reads credential values back into the browser.
    return null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const provider = SECRET_CREDENTIAL_PROVIDERS[key];
    if (provider != null) {
      if (value.trim().length === 0) {
        // Empty = NO CHANGE, never a delete. In Server Mode getSecret() always
        // returns null (write-only), so saveSettingsToStore re-sends every
        // provider key as "" on any unrelated save; treating that as a delete
        // would silently destroy a working server credential the user never
        // touched. Explicit removal goes through the Server tab's credentials UI
        // (DELETE /api/profile/credentials/:id). Mirrors why listDebridConfigs()
        // returns [] to keep debrid tokens out of destructive reconciliation.
        return;
      }
      await this.api.put("/api/profile/credentials", {
        id: `profile-${provider}`,
        provider,
        label: provider.toUpperCase(),
        value,
        priority: 0,
        isActive: true,
      });
      return;
    }
    // Write-only bridge for saveSettingsToStore(): it first writes the raw
    // secret here, then saves a config row with a secret:<key> marker. We never
    // read values back into the browser after they are sent to the server.
    this.pendingSecrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    // Provider credentials are deliberately NOT deleted through this settings
    // round-trip (see setSecret): the phantom empty value that arrives on every
    // unrelated save would otherwise destroy a server credential the user never
    // touched. Explicit removal is done via the Server tab's credentials UI
    // (DELETE /api/profile/credentials/:id). Non-provider keys only ever lived in
    // the in-memory pending map, so clearing that is sufficient.
    this.pendingSecrets.delete(key);
  }

  async addToWatchlist(preview: MediaPreview, _folderId?: string | null): Promise<void> {
    await this.api.put(`/api/library/watchlist/${encodeURIComponent(preview.id)}`, {
      preview,
    });
  }

  async removeFromWatchlist(mediaId: string): Promise<void> {
    await this.api.delete(`/api/library/watchlist/${encodeURIComponent(mediaId)}`);
  }

  async listWatchlist(): Promise<WatchlistRecord[]> {
    const response = await this.api.get<ServerWatchlistResponse>(
      "/api/library/watchlist",
    );
    return response.items.map((row) => ({
      mediaId: row.mediaId,
      addedAt: row.addedAt,
      preview: row.preview,
    }));
  }

  async isInWatchlist(mediaId: string): Promise<boolean> {
    const rows = await this.listWatchlist();
    return rows.some((row) => row.mediaId === mediaId);
  }

  // These folders are a local Dexie feature for now. Keeping the methods on the
  // shared Store contract lets the Watchlist UI fail honestly in Server Mode
  // instead of silently pretending an assignment persisted remotely.
  async createWatchlistFolder(_name: string): Promise<WatchlistFolderRecord> {
    throw unsupportedRemoteWrite("createWatchlistFolder");
  }

  async listWatchlistFolders(): Promise<WatchlistFolderRecord[]> {
    return [];
  }

  async renameWatchlistFolder(_id: string, _name: string): Promise<void> {
    throw unsupportedRemoteWrite("renameWatchlistFolder");
  }

  async deleteWatchlistFolder(_id: string): Promise<void> {
    throw unsupportedRemoteWrite("deleteWatchlistFolder");
  }

  async assignWatchlistFolder(_mediaId: string, _folderId: string | null): Promise<void> {
    throw unsupportedRemoteWrite("assignWatchlistFolder");
  }

  async recordHistory(entry: WatchHistoryUpsert): Promise<WatchHistoryRecord> {
    const episodeId = entry.episodeId ?? null;
    const progressSeconds = entry.progressSeconds ?? 0;
    const durationSeconds = entry.durationSeconds ?? null;
    const completed = entry.completed ?? false;
    const queuedNext = entry.queuedNext ?? false;
    const streamQuality = entry.streamQuality ?? null;
    const lastWatched = entry.lastWatched ?? nowISO();
    await this.api.put(`/api/history/${encodeURIComponent(entry.mediaId)}`, {
      episodeId,
      progressSeconds,
      durationSeconds,
      completed,
      queuedNext,
      streamQuality,
      preview: entry.preview,
      lastWatched,
    });
    // The PUT is authoritative; build the record locally instead of re-fetching
    // up to 500 history rows to re-find the row we just wrote - that read-back
    // could page the new row out (when >500 newer rows exist) and spuriously
    // throw even though the write succeeded.
    return {
      id: historyKey(entry.mediaId, episodeId),
      mediaId: entry.mediaId,
      episodeId,
      progressSeconds,
      durationSeconds,
      completed,
      queuedNext,
      lastWatched,
      streamQuality,
      preview: entry.preview,
    };
  }

  async deleteHistory(mediaId: string, episodeId?: string | null): Promise<void> {
    const query =
      episodeId != null && episodeId.length > 0
        ? `?episodeId=${encodeURIComponent(episodeId)}`
        : "";
    await this.api.delete(`/api/history/${encodeURIComponent(mediaId)}${query}`);
  }

  async listHistory(limit = 100): Promise<WatchHistoryRecord[]> {
    const response = await this.api.get<ServerHistoryResponse>(
      `/api/history?limit=${encodeURIComponent(String(limit))}`,
    );
    return response.items.map(mapHistory);
  }

  async listHistoryForMedia(mediaId: string): Promise<WatchHistoryRecord[]> {
    const response = await this.api.get<ServerHistoryResponse>(
      `/api/history/${encodeURIComponent(mediaId)}/entries`,
    );
    return response.items.map(mapHistory);
  }

  async getResume(
    mediaId: string,
    episodeId?: string | null,
  ): Promise<WatchHistoryRecord | null> {
    // Exact keyed lookup - NOT a windowed list scan - so the viewed-only merge
    // (data/library.ts) reads the real resume position for any history size
    // (scanning only the newest 500 could miss it and zero the row).
    const query =
      episodeId != null && episodeId.length > 0
        ? `?episodeId=${encodeURIComponent(episodeId)}`
        : "";
    const { item } = await this.api.get<{
      item: ServerHistoryResponse["items"][number] | null;
    }>(`/api/history/${encodeURIComponent(mediaId)}${query}`);
    return item ? mapHistory(item) : null;
  }

  async continueWatching(limit = 20): Promise<WatchHistoryRecord[]> {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.trunc(limit), 20)
      : 20;
    if (normalizedLimit <= 0) return [];
    const response = await this.api.get<ServerHistoryResponse>(
      `/api/history?view=continue-watching&limit=${encodeURIComponent(String(normalizedLimit))}`,
    );
    if (response.view === "continue-watching") {
      const rows = response.items.slice(0, 20).map(mapHistory);
      return rows
        .filter((row) => !row.completed && (row.queuedNext || hasResumePoint(row)))
        .slice(0, normalizedLimit);
    }

    // An older server ignores the view query. Keep the wide legacy scan in
    // that mixed-version case so recent viewed-only rows cannot hide a resume.
    const rows = await this.listHistory(500);
    return rows
      .filter((row) => !row.completed && (row.queuedNext || hasResumePoint(row)))
      .slice(0, normalizedLimit);
  }

  async addToLibrary(entry: LibraryEntryUpsert): Promise<LibraryEntryRecord> {
    const resp = await this.api.put<{ entry: ServerLibraryEntry }>(
      `/api/library/${encodeURIComponent(entry.mediaId)}`,
      {
        listType: entry.listType,
        folderId: entry.folderId ?? null,
        customListName: entry.customListName ?? null,
        releaseDateHint: entry.releaseDateHint ?? null,
        renewalStatus: entry.renewalStatus ?? null,
        preview: entry.preview,
        addedAt: entry.addedAt,
      },
    );
    return mapLibraryEntry(resp.entry);
  }

  async removeFromLibrary(id: string): Promise<void> {
    await this.api.delete(`/api/library/entry/${encodeURIComponent(id)}`);
  }

  async listLibrary(listType?: ListType): Promise<LibraryEntryRecord[]> {
    const q = listType ? `?listType=${encodeURIComponent(listType)}` : "";
    const resp = await this.api.get<{ items: ServerLibraryEntry[] }>(`/api/library${q}`);
    return resp.items.map(mapLibraryEntry);
  }

  async listLibraryByFolder(folderId: string): Promise<LibraryEntryRecord[]> {
    const resp = await this.api.get<{ items: ServerLibraryEntry[] }>(
      `/api/library/folder/${encodeURIComponent(folderId)}`,
    );
    return resp.items.map(mapLibraryEntry);
  }

  async saveFolder(folder: LibraryFolderRecord): Promise<void> {
    await this.api.put(`/api/library/folders/${encodeURIComponent(folder.id)}`, {
      name: folder.name,
      parentId: folder.parentId,
      listType: folder.listType,
      folderKind: folder.folderKind,
      isSystem: folder.isSystem,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    });
  }

  async createFolder(
    name: string,
    listType: ListType,
    parentId: string | null,
  ): Promise<LibraryFolderRecord> {
    const resp = await this.api.post<{ folder: ServerFolder }>(`/api/library/folders`, {
      name,
      listType,
      parentId,
    });
    return mapFolder(resp.folder);
  }

  async listFolders(listType?: ListType): Promise<LibraryFolderRecord[]> {
    const q = listType ? `?listType=${encodeURIComponent(listType)}` : "";
    const resp = await this.api.get<{ folders: ServerFolder[] }>(`/api/library/folders${q}`);
    return resp.folders.map(mapFolder);
  }

  async deleteFolder(id: string): Promise<void> {
    await this.api.delete(`/api/library/folders/${encodeURIComponent(id)}`);
  }

  async ensureSystemFolders(): Promise<void> {
    // The server seeds system folders lazily on every library/folder read+write,
    // so there is nothing to do from the client.
  }

  private async remoteIndexerConfigs(): Promise<IndexerConfigRecord[]> {
    const settings = await this.allSettings();
    const raw = settings[SERVER_INDEXER_CONFIGS_KEY];
    if (raw == null || raw.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as IndexerConfigRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async saveRemoteIndexerConfigs(configs: IndexerConfigRecord[]): Promise<void> {
    await this.setSetting(SERVER_INDEXER_CONFIGS_KEY, JSON.stringify(configs));
  }

  async saveIndexerConfig(config: IndexerConfigRecord): Promise<void> {
    const existing = await this.remoteIndexerConfigs();
    const next = [
      ...existing.filter((row) => row.id !== config.id),
      config,
    ].sort((a, b) => a.priority - b.priority);
    await this.saveRemoteIndexerConfigs(next);
  }

  async listIndexerConfigs(): Promise<IndexerConfigRecord[]> {
    return this.remoteIndexerConfigs();
  }

  async deleteIndexerConfig(id: string): Promise<void> {
    const existing = await this.remoteIndexerConfigs();
    await this.saveRemoteIndexerConfigs(existing.filter((row) => row.id !== id));
  }

  async saveDebridConfig(config: DebridConfigRecord): Promise<void> {
    const secretKey = config.apiToken.startsWith(SECRET_MARKER)
      ? config.apiToken.slice(SECRET_MARKER.length)
      : null;
    const token =
      secretKey != null ? this.pendingSecrets.get(secretKey) : config.apiToken;
    if (token == null || token.trim().length === 0) {
      // Nothing to send - but still drop any transient (e.g. empty) pending entry.
      if (secretKey != null) this.pendingSecrets.delete(secretKey);
      return;
    }
    try {
      await this.api.put("/api/profile/credentials", {
        id: config.id,
        provider: config.service,
        label: config.service,
        value: token,
        priority: config.priority,
        isActive: config.isActive,
      });
    } finally {
      // Clear the transient plaintext secret whether or not the PUT succeeded - 
      // a failed save must not leave a credential sitting in memory until the
      // next profile switch or restart. A retry re-populates it via setSecret().
      if (secretKey != null) this.pendingSecrets.delete(secretKey);
    }
  }

  async listDebridConfigs(): Promise<DebridConfigRecord[]> {
    // Do not synthesize rows for write-only server credentials. If we returned
    // redacted rows here, a later save from an unrelated Settings tab would
    // interpret the missing raw tokens as deletes.
    return [];
  }

  async deleteDebridConfig(_id: string): Promise<void> {
    throw unsupportedRemoteWrite("deleteDebridConfig");
  }

  async addTasteEvent(_event: TasteEventRecord): Promise<void> {
    // Taste profile endpoints come after the core remote store wiring.
  }

  async recentTasteEvents(_limit = 100): Promise<TasteEventRecord[]> {
    return [];
  }

  async addAIUsage(_record: AIUsageRecord): Promise<void> {
    // AI usage is accounted server-side in Server Mode; nothing to write here.
  }

  async totalAIUsageCostUSD(): Promise<number> {
    return 0;
  }

  async putMedia(_item: MediaItem, _key?: string): Promise<void> {
    // Server-side media cache endpoints come after stream/search APIs.
  }

  async getMedia(_id: string): Promise<MediaCacheRecord | null> {
    return null;
  }

  async putCachedResolution(_record: CachedResolutionRecord): Promise<void> {
    // Server Mode uses stream sessions rather than local direct-link caching.
  }

  async getCachedResolution(_mediaId: string): Promise<CachedResolutionRecord | null> {
    return null;
  }

  async getCachedResolutions(_mediaIds: string[]): Promise<CachedResolutionRecord[]> {
    return [];
  }

  async listCachedResolutions(): Promise<CachedResolutionRecord[]> {
    return [];
  }

  async deleteCachedResolution(_mediaId: string): Promise<void> {
    // No local cache to delete in Server Mode.
  }

  // ---- Desktop downloads ---------------------------------------------------

  async saveDownload(_record: DownloadRecord): Promise<void> {
    throw unsupportedRemoteWrite("saveDownload");
  }

  async updateDownload(
    _jobId: string,
    _changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
  ): Promise<DownloadRecord | null> {
    throw unsupportedRemoteWrite("updateDownload");
  }

  async deleteDownload(_jobId: string): Promise<void> {
    throw unsupportedRemoteWrite("deleteDownload");
  }

  async listDownloads(): Promise<DownloadRecord[]> {
    return [];
  }

  subscribeDownloads(_listener: (records: DownloadRecord[]) => void): () => void {
    return () => {};
  }
}
