// DexieStore tests - run against fake-indexeddb (an in-memory, spec-compliant
// IndexedDB) so the real Dexie code path is exercised without a browser.
//
// Mirrors the intent of the Swift DatabaseManager tests: settings get/set/all;
// watchlist add/remove/dedup/contains; watch-history upsert (one row per
// (media,episode), newest wins) + getResume + continueWatching ordering;
// library + folder CRUD; indexer/debrid config CRUD + ordering; secrets.

import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DexieStore } from "./DexieStore";
import {
  makeIndexerConfigRecord,
  systemFolderID,
  type AIUsageRecord,
  type CachedResolutionRecord,
  type DebridConfigRecord,
  type DownloadRecord,
  type TasteEventRecord,
} from "./models";
import type { MediaPreview } from "../models/media";
import type { MediaItem } from "../models/media";

function preview(id: string, title = id): MediaPreview {
  return { id, type: "movie", title };
}

let db: DexieStore;
let counter = 0;

beforeEach(() => {
  // Unique DB name per test → full isolation under fake-indexeddb.
  counter += 1;
  db = new DexieStore(`test-${counter}-${Date.now()}`);
});

afterEach(async () => {
  await db.delete();
});

// ---- Settings ---------------------------------------------------------------

describe("settings", () => {
  it("get returns null when unset", async () => {
    expect(await db.getSetting("missing")).toBeNull();
  });

  it("set then get round-trips", async () => {
    await db.setSetting("tmdb_api_key", "abc123");
    expect(await db.getSetting("tmdb_api_key")).toBe("abc123");
  });

  it("set overwrites", async () => {
    await db.setSetting("k", "v1");
    await db.setSetting("k", "v2");
    expect(await db.getSetting("k")).toBe("v2");
  });

  it("set null deletes", async () => {
    await db.setSetting("k", "v");
    await db.setSetting("k", null);
    expect(await db.getSetting("k")).toBeNull();
  });

  it("allSettings returns every key as an object", async () => {
    await db.setSetting("a", "1");
    await db.setSetting("b", "2");
    expect(await db.allSettings()).toEqual({ a: "1", b: "2" });
  });
});

// ---- Desktop downloads -----------------------------------------------------

function download(jobId: string): DownloadRecord {
  return {
    jobId,
    mediaId: "tmdb-1",
    episodeId: null,
    title: "Movie (2024)",
    season: null,
    episode: null,
    infoHash: "abc",
    fileHint: null,
    mode: "full",
    optimizeProfile: null,
    keepAudioLangs: [],
    keepSubLangs: [],
    status: "queued",
    bytesDone: 0,
    bytesTotal: null,
    optimizePercent: null,
    destPath: null,
    error: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("desktop downloads", () => {
  it("saves, updates, lists, and deletes queue records", async () => {
    await db.saveDownload(download("job-1"));
    await db.updateDownload("job-1", { status: "paused", bytesDone: 50 });
    expect(await db.listDownloads()).toMatchObject([
      { jobId: "job-1", status: "paused", bytesDone: 50 },
    ]);
    await db.deleteDownload("job-1");
    expect(await db.listDownloads()).toEqual([]);
  });

  it("notifies download subscribers when the queue changes", async () => {
    const changed = new Promise<DownloadRecord[]>((resolve) => {
      const unsubscribe = db.subscribeDownloads((records) => {
        if (records.some((record) => record.jobId === "job-sub")) {
          unsubscribe();
          resolve(records);
        }
      });
    });
    await db.saveDownload(download("job-sub"));
    await expect(changed).resolves.toMatchObject([{ jobId: "job-sub" }]);
  });
});

// ---- Watchlist --------------------------------------------------------------

describe("watchlist", () => {
  it("add then list + contains", async () => {
    await db.addToWatchlist(preview("tt1"));
    expect(await db.isInWatchlist("tt1")).toBe(true);
    const list = await db.listWatchlist();
    expect(list.map((r) => r.mediaId)).toEqual(["tt1"]);
  });

  it("dedupes by mediaId (no duplicate rows)", async () => {
    await db.addToWatchlist(preview("tt1", "First"));
    await db.addToWatchlist(preview("tt1", "Second"));
    const list = await db.listWatchlist();
    expect(list).toHaveLength(1);
    // Latest preview wins (metadata refresh), addedAt is preserved.
    expect(list[0].preview.title).toBe("Second");
  });

  it("remove takes it off the list", async () => {
    await db.addToWatchlist(preview("tt1"));
    await db.removeFromWatchlist("tt1");
    expect(await db.isInWatchlist("tt1")).toBe(false);
    expect(await db.listWatchlist()).toHaveLength(0);
  });

  it("lists most-recently-added first", async () => {
    await db.addToWatchlist({ ...preview("tt1") });
    // Force distinct timestamps via the addedAt path.
    await new Promise((r) => setTimeout(r, 2));
    await db.addToWatchlist({ ...preview("tt2") });
    const list = await db.listWatchlist();
    expect(list[0].mediaId).toBe("tt2");
    expect(list[1].mediaId).toBe("tt1");
  });

  it("creates, renames, assigns, and deletes folders without deleting titles", async () => {
    await db.addToWatchlist(preview("tt1", "Arrival"));
    await db.addToWatchlist(preview("tt2", "Dune"));
    const folder = await db.createWatchlistFolder("Sci-Fi");
    await db.assignWatchlistFolder("tt1", folder.id);

    expect(await db.listWatchlistFolders()).toContainEqual(
      expect.objectContaining({ id: folder.id, name: "Sci-Fi" }),
    );
    expect(await db.listWatchlist()).toContainEqual(
      expect.objectContaining({ mediaId: "tt1", folderId: folder.id }),
    );

    await db.renameWatchlistFolder(folder.id, "Science Fiction");
    expect(await db.listWatchlistFolders()).toContainEqual(
      expect.objectContaining({ id: folder.id, name: "Science Fiction" }),
    );

    await db.deleteWatchlistFolder(folder.id);
    expect(await db.listWatchlist()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mediaId: "tt1", folderId: null }),
        expect.objectContaining({ mediaId: "tt2", folderId: null }),
      ]),
    );
    expect(await db.listWatchlistFolders()).not.toContainEqual(
      expect.objectContaining({ id: folder.id }),
    );
  });

  it("migrates pre-folder watchlist rows to uncategorized without losing data", async () => {
    const name = `legacy-watchlist-${Date.now()}-${counter}`;
    const legacy = new Dexie(name);
    legacy.version(5).stores({ watchlist: "mediaId, addedAt" });
    await legacy.open();
    await legacy.table("watchlist").put({
      mediaId: "tt-legacy",
      addedAt: "2021-01-02T00:00:00.000Z",
      preview: preview("tt-legacy", "Stored before folders"),
    });
    legacy.close();

    await db.delete();
    db = new DexieStore(name);
    const rows = await db.listWatchlist();
    expect(rows).toEqual([
      expect.objectContaining({
        mediaId: "tt-legacy",
        addedAt: "2021-01-02T00:00:00.000Z",
        folderId: null,
        preview: expect.objectContaining({ title: "Stored before folders" }),
      }),
    ]);
  });
});

// ---- Watch history / resume -------------------------------------------------

describe("watch history", () => {
  it("upserts one row per (mediaId, episodeId), newest wins", async () => {
    await db.recordHistory({ mediaId: "tt1", preview: preview("tt1"), progressSeconds: 10 });
    await db.recordHistory({ mediaId: "tt1", preview: preview("tt1"), progressSeconds: 120 });
    const all = await db.listHistory();
    expect(all).toHaveLength(1);
    expect(all[0].progressSeconds).toBe(120);
  });

  it("keeps movie and episode rows separate", async () => {
    await db.recordHistory({ mediaId: "tt1", preview: preview("tt1"), progressSeconds: 10 });
    await db.recordHistory({
      mediaId: "tt1",
      episodeId: "s1e1",
      preview: preview("tt1"),
      progressSeconds: 30,
    });
    const all = await db.listHistory();
    expect(all).toHaveLength(2);
  });

  it("deletes only the requested completed episode row when unmarked", async () => {
    await db.recordHistory({
      mediaId: "show",
      episodeId: "s1e1",
      preview: preview("show"),
      progressSeconds: 1,
      durationSeconds: 1,
      completed: true,
    });
    await db.recordHistory({
      mediaId: "show",
      episodeId: "s1e2",
      preview: preview("show"),
      progressSeconds: 1,
      durationSeconds: 1,
      completed: true,
    });
    await db.deleteHistory("show", "s1e1");
    expect(await db.getResume("show", "s1e1")).toBeNull();
    expect((await db.getResume("show", "s1e2"))?.completed).toBe(true);
  });

  it("remembers player prefs and preserves them across progress-only writes", async () => {
    // First write sets the remembered audio/sub/speed.
    await db.recordHistory({
      mediaId: "tt1",
      preview: preview("tt1"),
      progressSeconds: 60,
      preferredAudioId: "2",
      preferredAudioLang: "eng",
      preferredSubId: "no",
      playbackSpeed: 1.5,
    });
    // A later progress-only write (no pref fields) must NOT wipe them.
    await db.recordHistory({
      mediaId: "tt1",
      preview: preview("tt1"),
      progressSeconds: 900,
    });
    const resume = await db.getResume("tt1");
    expect(resume?.progressSeconds).toBe(900);
    expect(resume?.preferredAudioId).toBe("2");
    expect(resume?.preferredAudioLang).toBe("eng");
    expect(resume?.preferredSubId).toBe("no");
    expect(resume?.playbackSpeed).toBe(1.5);
  });

  it("getResume returns the (media, episode) row", async () => {
    await db.recordHistory({
      mediaId: "tt1",
      preview: preview("tt1"),
      progressSeconds: 300,
      durationSeconds: 6000,
    });
    const resume = await db.getResume("tt1");
    expect(resume?.progressSeconds).toBe(300);
    expect(await db.getResume("tt1", "s1e1")).toBeNull();
  });

  it("continueWatching is newest-first and only resumable rows (not completed, not zero-progress)", async () => {
    await db.recordHistory({
      mediaId: "tt1",
      preview: preview("tt1"),
      progressSeconds: 100,
      durationSeconds: 1000, // 10% → resumable
      lastWatched: "2024-01-01T00:00:00.000Z",
    });
    await db.recordHistory({
      mediaId: "tt2",
      preview: preview("tt2"),
      progressSeconds: 200,
      durationSeconds: 1000, // 20% → resumable
      lastWatched: "2024-02-01T00:00:00.000Z",
    });
    await db.recordHistory({
      mediaId: "tt3",
      preview: preview("tt3"),
      progressSeconds: 990,
      durationSeconds: 1000,
      completed: true, // finished → excluded
      lastWatched: "2024-03-01T00:00:00.000Z",
    });
    await db.recordHistory({
      mediaId: "tt5",
      preview: preview("tt5"),
      progressSeconds: 500,
      durationSeconds: 1000,
      completed: true,
      lastWatched: "2024-03-15T00:00:00.000Z",
    });
    // A plain "viewed" row (opening Detail): zero progress → must NOT crowd out
    // the resumable rows above (regression for round-2 bug #2).
    await db.recordHistory({
      mediaId: "tt4",
      preview: preview("tt4"),
      progressSeconds: 0,
      durationSeconds: null,
      lastWatched: "2024-04-01T00:00:00.000Z",
    });
    const cw = await db.continueWatching();
    expect(cw.map((r) => r.mediaId)).toEqual(["tt2", "tt1"]);
  });

  it("continueWatching stops its reverse cursor after collecting the requested resumables", async () => {
    const recordZeroProgress = async (id: string, lastWatched: string) => {
      await db.recordHistory({
        mediaId: id,
        preview: preview(id),
        progressSeconds: 0,
        durationSeconds: null,
        lastWatched,
      });
    };

    // The trailing block is intentionally large: an unbounded filter would read
    // all 242 rows, while the bounded cursor never reaches it.
    for (let i = 0; i < 80; i += 1) {
      await recordZeroProgress(
        `new-zero-${i}`,
        `2030-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      );
    }
    await db.recordHistory({
      mediaId: "resumable-new",
      preview: preview("resumable-new"),
      progressSeconds: 100,
      durationSeconds: 1_000,
      lastWatched: "2025-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 80; i += 1) {
      await recordZeroProgress(
        `middle-zero-${i}`,
        `2024-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      );
    }
    await db.recordHistory({
      mediaId: "resumable-old",
      preview: preview("resumable-old"),
      progressSeconds: 200,
      durationSeconds: 1_000,
      lastWatched: "2023-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 80; i += 1) {
      await recordZeroProgress(
        `old-zero-${i}`,
        `2022-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      );
    }

    let cursorVisits = 0;
    const historyTable = Reflect.get(db, "watchHistory") as {
      core: {
        openCursor(
          ...args: unknown[]
        ): Promise<{
          start(callback: () => void): unknown;
        } | null>;
      };
    };
    const originalOpenCursor = historyTable.core.openCursor.bind(historyTable.core);
    historyTable.core.openCursor = async (...args) => {
      const cursor = await originalOpenCursor(...args);
      if (cursor == null) return null;
      const originalStart = cursor.start.bind(cursor);
      cursor.start = (callback) =>
        originalStart(() => {
          cursorVisits += 1;
          callback();
        });
      return cursor;
    };

    const rows = await db.continueWatching(2);

    expect(rows.map((row) => row.mediaId)).toEqual([
      "resumable-new",
      "resumable-old",
    ]);
    expect(cursorVisits).toBeLessThan(200);
  });

  it("continueWatching rejects finite nonpositive limits without scanning", async () => {
    await db.getSetting("open-database");
    const historyTable = Reflect.get(db, "watchHistory") as {
      core: { openCursor(...args: unknown[]): Promise<unknown> };
    };
    const openCursor = vi.spyOn(historyTable.core, "openCursor");

    await expect(db.continueWatching(0)).resolves.toEqual([]);
    await expect(db.continueWatching(-1)).resolves.toEqual([]);
    await expect(db.continueWatching(-0.5)).resolves.toEqual([]);
    expect(openCursor).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity])(
    "continueWatching bounds non-finite limit %s to 20 rows",
    async (limit) => {
      for (let i = 0; i < 25; i += 1) {
        await db.recordHistory({
          mediaId: `limit-${i}`,
          preview: preview(`limit-${i}`),
          progressSeconds: 100,
          durationSeconds: 1_000,
          lastWatched: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        });
      }

      const rows = await db.continueWatching(limit);
      expect(rows).toHaveLength(20);
    },
  );

  it("continueWatching caps finite limits at 20 rows", async () => {
    for (let i = 0; i < 25; i += 1) {
      await db.recordHistory({
        mediaId: `cap-${i}`,
        preview: preview(`cap-${i}`),
        progressSeconds: 100,
        durationSeconds: 1_000,
        lastWatched: `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    await expect(db.continueWatching(200)).resolves.toHaveLength(20);
  });

  it("listHistory orders newest-first", async () => {
    await db.recordHistory({
      mediaId: "tt1",
      preview: preview("tt1"),
      lastWatched: "2024-01-01T00:00:00.000Z",
    });
    await db.recordHistory({
      mediaId: "tt2",
      preview: preview("tt2"),
      lastWatched: "2024-05-01T00:00:00.000Z",
    });
    const all = await db.listHistory();
    expect(all.map((r) => r.mediaId)).toEqual(["tt2", "tt1"]);
  });
});

// ---- Library + folders ------------------------------------------------------

describe("library + folders", () => {
  it("ensureSystemFolders creates the per-list-type roots + behavior folders", async () => {
    await db.ensureSystemFolders();
    const folders = await db.listFolders();
    const ids = folders.map((f) => f.id);
    expect(ids).toContain(systemFolderID("watchlist"));
    expect(ids).toContain(systemFolderID("favorites"));
    expect(ids).toContain(systemFolderID("custom"));
    expect(ids).toContain("system-favorites-watched");
    expect(ids).toContain("system-favorites-release-wait");
  });

  it("addToLibrary pins watchlist to its system root and dedupes", async () => {
    await db.addToLibrary({ mediaId: "tt1", listType: "watchlist", preview: preview("tt1") });
    await db.addToLibrary({ mediaId: "tt1", listType: "watchlist", preview: preview("tt1") });
    const entries = await db.listLibrary("watchlist");
    expect(entries).toHaveLength(1);
    expect(entries[0].folderId).toBe(systemFolderID("watchlist"));
  });

  it("createFolder + listLibraryByFolder", async () => {
    const folder = await db.createFolder("Faves", "favorites", null);
    await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      folderId: folder.id,
      preview: preview("tt1"),
    });
    const inFolder = await db.listLibraryByFolder(folder.id);
    expect(inFolder.map((e) => e.mediaId)).toEqual(["tt1"]);
  });

  it("addToLibrary serializes concurrent adds - no duplicate rows (regression)", async () => {
    await Promise.all([
      db.addToLibrary({ mediaId: "ttX", listType: "watchlist", preview: preview("ttX") }),
      db.addToLibrary({ mediaId: "ttX", listType: "watchlist", preview: preview("ttX") }),
    ]);
    const entries = await db.listLibrary("watchlist");
    expect(entries.filter((e) => e.mediaId === "ttX")).toHaveLength(1);
  });

  it("deleteFolder re-parents child folders to root, not dangling (regression)", async () => {
    const parent = await db.createFolder("Parent", "favorites", null);
    const child = await db.createFolder("Child", "favorites", parent.id);
    await db.deleteFolder(parent.id);
    const reloaded = (await db.listFolders("favorites")).find((f) => f.id === child.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.parentId).toBeNull();
  });

  it("createFolder rejects unsupported list types", async () => {
    await expect(db.createFolder("X", "watchlist", null)).rejects.toThrow();
  });

  it("createFolder falls back to a timestamp-random id when crypto.randomUUID is absent", async () => {
    // Exercise the uuid() fallback used in environments without crypto.randomUUID.
    const original = (globalThis as { crypto?: Crypto }).crypto;
    vi.stubGlobal("crypto", {}); // no randomUUID
    try {
      const folder = await db.createFolder("Fallback", "favorites", null);
      // Fallback shape: "folder-<base36ts>-<base36rand>" (no UUID hyphen-groups).
      expect(folder.id).toMatch(/^folder-[0-9a-z]+-[0-9a-z]+$/);
    } finally {
      vi.stubGlobal("crypto", original);
      vi.unstubAllGlobals();
    }
  });

  it("createFolder uniquifies duplicate names", async () => {
    const a = await db.createFolder("Dupe", "favorites", null);
    const b = await db.createFolder("Dupe", "favorites", null);
    expect(a.name).toBe("Dupe");
    expect(b.name).toBe("Dupe (2)");
  });

  it("deleteFolder reassigns entries to the system root", async () => {
    const folder = await db.createFolder("Temp", "favorites", null);
    await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      folderId: folder.id,
      preview: preview("tt1"),
    });
    await db.deleteFolder(folder.id);
    const root = await db.listLibraryByFolder(systemFolderID("favorites"));
    expect(root.map((e) => e.mediaId)).toEqual(["tt1"]);
    expect(await db.listFolders("favorites")).not.toContainEqual(
      expect.objectContaining({ id: folder.id }),
    );
  });

  it("deleteFolder drops an entry that already lives in the system root (collision)", async () => {
    // Same media in BOTH a manual folder and the system root → on delete the
    // manual-folder row is dropped (not reassigned) to avoid a duplicate.
    const folder = await db.createFolder("Temp", "favorites", null);
    await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      folderId: folder.id,
      preview: preview("tt1"),
    });
    await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      folderId: systemFolderID("favorites"),
      preview: preview("tt1"),
    });
    await db.deleteFolder(folder.id);
    const root = await db.listLibraryByFolder(systemFolderID("favorites"));
    // Exactly one row remains for tt1 in the root (no duplicate created).
    expect(root.filter((e) => e.mediaId === "tt1")).toHaveLength(1);
  });

  it("deleteFolder on a missing id is a silent no-op", async () => {
    await expect(db.deleteFolder("does-not-exist")).resolves.toBeUndefined();
  });

  it("deleteFolder refuses system folders", async () => {
    await db.ensureSystemFolders();
    await expect(db.deleteFolder(systemFolderID("favorites"))).rejects.toThrow();
  });

  it("saveFolder upserts an arbitrary folder record", async () => {
    const rec = {
      id: "f-custom",
      name: "Manual Save",
      parentId: null,
      listType: "favorites" as const,
      folderKind: "manual" as const,
      isSystem: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await db.saveFolder(rec);
    expect(await db.listFolders("favorites")).toContainEqual(
      expect.objectContaining({ id: "f-custom", name: "Manual Save" }),
    );
  });

  it("listLibrary with no listType returns every entry, newest-first", async () => {
    await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      addedAt: "2024-01-01T00:00:00.000Z",
      preview: preview("tt1"),
    });
    await db.addToLibrary({
      mediaId: "tt2",
      listType: "watchlist",
      addedAt: "2024-02-02T00:00:00.000Z",
      preview: preview("tt2"),
    });
    const all = await db.listLibrary();
    // Both list types present, ordered newest addedAt first.
    expect(all.map((e) => e.mediaId)).toEqual(["tt2", "tt1"]);
  });

  it("removeFromLibrary removes an entry by id", async () => {
    const entry = await db.addToLibrary({
      mediaId: "tt1",
      listType: "favorites",
      preview: preview("tt1"),
    });
    await db.removeFromLibrary(entry.id);
    expect(await db.listLibrary("favorites")).toHaveLength(0);
  });

  it("listFolders puts system folders first", async () => {
    await db.ensureSystemFolders();
    await db.createFolder("AAA Manual", "favorites", null);
    const folders = await db.listFolders("favorites");
    expect(folders[0].isSystem).toBe(true);
  });

  it("listFolders orders same-tier (non-system) folders by name", async () => {
    await db.createFolder("Zeta", "favorites", null);
    await db.createFolder("Alpha", "favorites", null);
    const manual = (await db.listFolders("favorites")).filter((f) => !f.isSystem);
    expect(manual.map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("sorts both system folders by name when system-ness ties", async () => {
    await db.saveFolder({
      id: "sys-zeta",
      name: "Zeta",
      parentId: null,
      listType: "favorites",
      folderKind: "system_root",
      isSystem: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    await db.saveFolder({
      id: "sys-alpha",
      name: "Alpha",
      parentId: null,
      listType: "favorites",
      folderKind: "system_root",
      isSystem: true,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const folders = (await db.listFolders("favorites")).filter((f) => f.isSystem);
    expect(folders.map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("createFolder with a blank name defaults to 'New Folder'", async () => {
    const folder = await db.createFolder("   ", "favorites", null);
    expect(folder.name).toBe("New Folder");
  });
});

// ---- Indexer configs --------------------------------------------------------

describe("indexer configs", () => {
  it("save + list ordered by priority", async () => {
    await db.saveIndexerConfig(
      makeIndexerConfigRecord({ id: "b", type: "torznab", baseURL: "u", priority: 2 }),
    );
    await db.saveIndexerConfig(
      makeIndexerConfigRecord({ id: "a", type: "jackett", baseURL: "u", priority: 1 }),
    );
    const list = await db.listIndexerConfigs();
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("defaults providerSubtype + endpointPath from type", async () => {
    await db.saveIndexerConfig(
      makeIndexerConfigRecord({ id: "j", type: "jackett", baseURL: "u" }),
    );
    const [c] = await db.listIndexerConfigs();
    expect(c.providerSubtype).toBe("jackett");
    expect(c.endpointPath).toBe("/api/v2.0/indexers/all/results/torznab/api");
  });

  it("persists the stremio_addon type faithfully", async () => {
    await db.saveIndexerConfig(
      makeIndexerConfigRecord({
        id: "s",
        type: "stremio_addon",
        baseURL: "https://addon.example/manifest.json",
      }),
    );
    const [c] = await db.listIndexerConfigs();
    expect(c.type).toBe("stremio_addon");
    expect(c.providerSubtype).toBe("stremio_addon");
  });

  it("save acts as upsert, delete removes", async () => {
    const cfg = makeIndexerConfigRecord({ id: "x", type: "torznab", baseURL: "u" });
    await db.saveIndexerConfig(cfg);
    await db.saveIndexerConfig({ ...cfg, baseURL: "u2" });
    let list = await db.listIndexerConfigs();
    expect(list).toHaveLength(1);
    expect(list[0].baseURL).toBe("u2");
    await db.deleteIndexerConfig("x");
    list = await db.listIndexerConfigs();
    expect(list).toHaveLength(0);
  });
});

// ---- Debrid configs ---------------------------------------------------------

describe("debrid configs", () => {
  function cfg(id: string, priority: number): DebridConfigRecord {
    return { id, service: "real_debrid", apiToken: "tok", isActive: true, priority };
  }

  it("save + list ordered by priority, upsert + delete", async () => {
    await db.saveDebridConfig(cfg("b", 5));
    await db.saveDebridConfig(cfg("a", 1));
    let list = await db.listDebridConfigs();
    expect(list.map((c) => c.id)).toEqual(["a", "b"]);

    await db.saveDebridConfig({ ...cfg("a", 1), apiToken: "tok2" });
    list = await db.listDebridConfigs();
    expect(list).toHaveLength(2);
    expect(list[0].apiToken).toBe("tok2");

    await db.deleteDebridConfig("a");
    list = await db.listDebridConfigs();
    expect(list.map((c) => c.id)).toEqual(["b"]);
  });
});

// ---- Taste events -----------------------------------------------------------

describe("taste events", () => {
  function event(id: string, createdAt: string): TasteEventRecord {
    return {
      id,
      userId: "default",
      mediaId: "tt1",
      episodeId: null,
      eventType: "added_to_watchlist",
      signalStrength: 1,
      metadata: {},
      createdAt,
    };
  }

  it("add + recent newest-first, capped", async () => {
    await db.addTasteEvent(event("e1", "2024-01-01T00:00:00.000Z"));
    await db.addTasteEvent(event("e2", "2024-02-01T00:00:00.000Z"));
    const recent = await db.recentTasteEvents();
    expect(recent.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(await db.recentTasteEvents(1)).toHaveLength(1);
  });

  it("uses the additive mediaId+createdAt index for per-title reads", async () => {
    await db.addTasteEvent(event("old", "2024-01-01T00:00:00.000Z"));
    await db.addTasteEvent({
      ...event("other", "2024-03-01T00:00:00.000Z"),
      mediaId: "tt-other",
    });
    await db.addTasteEvent(event("new", "2024-02-01T00:00:00.000Z"));

    expect(db.table("tasteEvents").schema.idxByName["[mediaId+createdAt]"]).toBeDefined();
    expect((await db.recentTasteEventsForMedia("tt1")).map((row) => row.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("never prunes explicit ratings, likes, or dislikes", async () => {
    const explicit: TasteEventRecord[] = [
      { ...event("rated-old", "1990-01-01T00:00:00.000Z"), eventType: "rated" },
      { ...event("liked-old", "1990-01-02T00:00:00.000Z"), eventType: "liked" },
      { ...event("disliked-old", "1990-01-03T00:00:00.000Z"), eventType: "disliked" },
    ];
    const implicit = Array.from({ length: 1_002 }, (_, index) => ({
      ...event(`implicit-${index}`, new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()),
      mediaId: `tmdb-${index}`,
    }));
    const table = db.table<TasteEventRecord, string>("tasteEvents");
    await table.bulkPut([...explicit, ...implicit]);

    await db.addTasteEvent(event("implicit-trigger", "2025-01-01T00:00:00.000Z"));

    expect((await table.bulkGet(explicit.map((row) => row.id))).filter(Boolean)).toHaveLength(3);
    expect(
      await table.where("eventType").noneOf(["rated", "liked", "disliked"]).count(),
    ).toBe(1_000);
    // Heavier fake-IndexedDB seed (1000+ rows) can exceed 20 seconds on
    // the shared Intel macOS release runner after dependency provisioning.
  }, 60000);
});

describe("v4 to v5 migration", () => {
  it("preserves taste events and makes them queryable by the new media index", async () => {
    const name = `migration-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(4).stores({
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
      cachedResolutions: "mediaId, resolvedAt",
      aiUsage: "id, createdAt",
      downloads: "jobId, status, updatedAt, createdAt, mediaId, episodeId",
    });
    const seeded: TasteEventRecord[] = [
      {
        id: "legacy-1",
        userId: "default",
        mediaId: "tt-upgrade",
        episodeId: null,
        eventType: "rated",
        signalStrength: 0.9,
        metadata: { rating: "9" },
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "legacy-2",
        userId: "default",
        mediaId: "tt-other",
        episodeId: null,
        eventType: "liked",
        signalStrength: 1,
        metadata: {},
        createdAt: "2024-02-01T00:00:00.000Z",
      },
    ];
    await legacy.table<TasteEventRecord, string>("tasteEvents").bulkAdd(seeded);
    legacy.close();

    const upgraded = new DexieStore(name);
    try {
      expect(await upgraded.table("tasteEvents").count()).toBe(seeded.length);
      expect(
        (await upgraded.recentTasteEventsForMedia("tt-upgrade")).map((row) => row.id),
      ).toEqual(["legacy-1"]);
      expect(
        upgraded.table("tasteEvents").schema.idxByName["[mediaId+createdAt]"],
      ).toBeDefined();
    } finally {
      await upgraded.delete();
    }
  });
});

describe("storage open failure handling", () => {
  it("reports a failed open and lets the caller offer explicit recovery", async () => {
    const original = Dexie.dependencies.indexedDB;
    const issue = vi.fn();

    try {
      Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory;
      // Create after removing the IndexedDB implementation so its eager open
      // follows the same failure path a blocked/corrupt browser profile would.
      const unavailable = new DexieStore(`unavailable-${Date.now()}`);
      unavailable.onStorageIssue(issue);
      await expect(unavailable.getSetting("boot")).rejects.toBeInstanceOf(Error);
      expect(issue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "open-failed" }),
      );
      unavailable.close();
    } finally {
      Dexie.dependencies.indexedDB = original;
    }
  });

  it("retries after a transient open timeout and serves the waiting operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const originalOpen = DexieStore.prototype.open;
    let calls = 0;
    const open = vi
      .spyOn(DexieStore.prototype, "open")
      .mockImplementation(function (this: DexieStore) {
        calls += 1;
        if (calls === 1) {
          return new Promise<Dexie>(() => {}) as ReturnType<DexieStore["open"]>;
        }
        return originalOpen.call(this);
      });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recovering = new DexieStore(`recovering-${Date.now()}`);

    try {
      const read = recovering.getSetting("boot");
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(read).resolves.toBeNull();
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(recovering.getStorageIssue()).toBeNull();
    } finally {
      open.mockRestore();
      warning.mockRestore();
      vi.useRealTimers();
      await recovering.delete();
    }
  });
});

// ---- Media cache ------------------------------------------------------------

describe("media cache", () => {
  it("put + get round-trips", async () => {
    const item: MediaItem = {
      id: "tt1",
      type: "movie",
      title: "Cached",
      genres: [],
      lastFetched: new Date().toISOString(),
    };
    await db.putMedia(item);
    const got = await db.getMedia("tt1");
    expect(got?.item.title).toBe("Cached");
    expect(await db.getMedia("missing")).toBeNull();
  });
});

// ---- Secrets (SecretStore) --------------------------------------------------

describe("secrets", () => {
  it("get/set/delete round-trips", async () => {
    expect(await db.getSecret("k")).toBeNull();
    await db.setSecret("k", "s3cr3t");
    expect(await db.getSecret("k")).toBe("s3cr3t");
    await db.setSecret("k", "rotated");
    expect(await db.getSecret("k")).toBe("rotated");
    await db.deleteSecret("k");
    expect(await db.getSecret("k")).toBeNull();
  });
});

// ---- AI usage (local-only cost/token ledger) --------------------------------

describe("AI usage ledger", () => {
  function usage(id: string, cost: number | null): AIUsageRecord {
    return {
      id,
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "analyze",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      estimatedCostUSD: cost,
      createdAt: "2024-01-01T00:00:00.000Z",
    };
  }

  it("starts at zero cost with no records", async () => {
    expect(await db.totalAIUsageCostUSD()).toBe(0);
  });

  it("sums estimatedCostUSD across records, treating null as zero", async () => {
    await db.addAIUsage(usage("u1", 0.01));
    await db.addAIUsage(usage("u2", 0.25));
    await db.addAIUsage(usage("u3", null)); // null contributes 0
    expect(await db.totalAIUsageCostUSD()).toBeCloseTo(0.26, 10);
  });

  it("addAIUsage upserts by id (newest wins)", async () => {
    await db.addAIUsage(usage("u1", 0.1));
    await db.addAIUsage(usage("u1", 0.5));
    expect(await db.totalAIUsageCostUSD()).toBeCloseTo(0.5, 10);
  });
});

// ---- Cached resolutions (watchlist auto-resolve) ----------------------------

describe("cached resolutions", () => {
  function resolution(mediaId: string, resolvedAt: string): CachedResolutionRecord {
    return {
      mediaId,
      stream: {
        streamURL: `https://cdn.example/${mediaId}.mkv`,
        quality: "1080p",
        codec: "H.265",
        audio: "AAC",
        source: "WEB-DL",
        sizeBytes: 1_000_000,
        fileName: `${mediaId}.mkv`,
        debridService: "RD",
      },
      resolvedAt,
      debridService: "RD",
      infoHash: `hash-${mediaId}`,
    };
  }

  it("put + get round-trips and returns null for a missing id", async () => {
    expect(await db.getCachedResolution("tt1")).toBeNull();
    await db.putCachedResolution(resolution("tt1", "2024-01-01T00:00:00.000Z"));
    const got = await db.getCachedResolution("tt1");
    expect(got?.mediaId).toBe("tt1");
    expect(got?.stream.streamURL).toBe("https://cdn.example/tt1.mkv");
    expect(got?.infoHash).toBe("hash-tt1");
  });

  it("bulk-gets only the requested cached resolution ids", async () => {
    await db.putCachedResolution(resolution("tt1", "2024-01-01T00:00:00.000Z"));
    await db.putCachedResolution(resolution("tt2", "2024-01-02T00:00:00.000Z"));
    expect((await db.getCachedResolutions(["tt2", "missing"])).map((row) => row.mediaId)).toEqual([
      "tt2",
    ]);
  });

  it("put is an upsert keyed by mediaId (newest wins)", async () => {
    await db.putCachedResolution(resolution("tt1", "2024-01-01T00:00:00.000Z"));
    await db.putCachedResolution(resolution("tt1", "2024-02-02T00:00:00.000Z"));
    const got = await db.getCachedResolution("tt1");
    expect(got?.resolvedAt).toBe("2024-02-02T00:00:00.000Z");
    expect(await db.listCachedResolutions()).toHaveLength(1);
  });

  it("list returns all rows and delete removes one", async () => {
    await db.putCachedResolution(resolution("tt1", "2024-01-01T00:00:00.000Z"));
    await db.putCachedResolution(resolution("tt2", "2024-01-02T00:00:00.000Z"));
    expect(await db.listCachedResolutions()).toHaveLength(2);
    await db.deleteCachedResolution("tt1");
    const remaining = await db.listCachedResolutions();
    expect(remaining.map((r) => r.mediaId)).toEqual(["tt2"]);
    // Deleting a missing id is a no-op.
    await db.deleteCachedResolution("nope");
    expect(await db.listCachedResolutions()).toHaveLength(1);
  });
});

describe("queued next history", () => {
  it("includes an explicit queue but excludes ordinary zero progress and replaces stale queues", async () => {
    await db.recordHistory({ mediaId: "show", episodeId: "s1e2", queuedNext: true, preview: preview("show") });
    await db.recordHistory({ mediaId: "show", episodeId: "s1e3", queuedNext: true, preview: preview("show") });
    await db.recordHistory({ mediaId: "viewed", preview: preview("viewed") });
    const rows = await db.continueWatching();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ episodeId: "s1e3", queuedNext: true });
  });

  it("turns queued playback progress into a real resume", async () => {
    await db.recordHistory({ mediaId: "show", episodeId: "s1e2", queuedNext: true, preview: preview("show") });
    const row = await db.recordHistory({
      mediaId: "show", episodeId: "s1e2", progressSeconds: 90,
      durationSeconds: 900, preview: preview("show"),
    });
    expect(row).toMatchObject({ progressSeconds: 90, durationSeconds: 900, queuedNext: false });
  });

  it("does not overwrite a real target resume with a later queue", async () => {
    await db.recordHistory({ mediaId: "show", episodeId: "s1e2", progressSeconds: 60, durationSeconds: 600, preview: preview("show") });
    const row = await db.recordHistory({ mediaId: "show", episodeId: "s1e2", queuedNext: true, preview: preview("show") });
    expect(row).toMatchObject({ progressSeconds: 60, queuedNext: false });
  });
});
