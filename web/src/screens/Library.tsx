// Library screen - backed by the storage port.
//
// Reads the durable library (the `favorites` list-type entries) and the folder
// list from the Store. A folder strip filters the grid; "All saved" shows every
// favorites entry, and selecting a folder shows that folder's entries. Full
// folder management lives here: create / rename / delete a collection, and an
// "Organize" mode to move a title between folders or remove it. The watchlist is
// surfaced as a fallback section for a fresh, empty library.

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/AppStore";
import { MediaCard } from "../components/MediaCard";
import { VirtualMediaGrid } from "../components/MediaGrid";
import { Rail } from "../components/Rail";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { getStore } from "../storage";
import { MediaPreview as MediaPreviewNS } from "../models/media";
import type { LibraryEntryRecord, LibraryFolderRecord } from "../storage/models";
import type { MediaPreview } from "../models/media";
import { isServerMode } from "../lib/serverMode";
import { listRequested } from "../lib/serverApi";
import { useWatchedIds } from "../data/useWatchedIds";
import "../components/MediaGrid.css";
import "./LibraryScreens.css";

const ALL = "__all__";

export function Library() {
  const { watchlist, openDetail, openBrowse, navigate, settings } = useAppStore();
  const [folders, setFolders] = useState<LibraryFolderRecord[]>([]);
  const [entries, setEntries] = useState<LibraryEntryRecord[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The SHARED, account-wide list of APPROVED title requests (Server Mode only).
  const [requested, setRequested] = useState<MediaPreview[]>([]);

  // Folder-management UI state.
  const [organize, setOrganize] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const rootId = folders.find((f) => f.folderKind === "system_root")?.id ?? "";
  // Only user-manageable folders (the system root is the implicit "All saved").
  const manualFolders = folders.filter((f) => f.folderKind !== "system_root");
  const selected =
    selectedFolder !== ALL ? folders.find((f) => f.id === selectedFolder) : undefined;

  const load = useCallback(async () => {
    const store = getStore();
    await store.ensureSystemFolders();
    const [folderList, favEntries] = await Promise.all([
      store.listFolders("favorites"),
      store.listLibrary("favorites"),
    ]);
    setFolders(folderList);
    setEntries(favEntries);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (cancelled) return;
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // The shared "Requested" rail surfaces APPROVED titles to the whole household.
  // Server Mode only; failures degrade silently to a hidden (empty) rail.
  useEffect(() => {
    if (!isServerMode()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await listRequested();
        if (!cancelled) setRequested(items.map((r) => r.preview));
      } catch {
        if (!cancelled) setRequested([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── folder writes ──────────────────────────────────────────────────────────
  async function runWrite(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createFolder() {
    const name = newName.trim();
    if (name.length === 0) return;
    await runWrite(async () => {
      const folder = await getStore().createFolder(name, "favorites", null);
      setSelectedFolder(folder.id);
    });
    setNewName("");
    setCreating(false);
  }

  async function renameFolder() {
    const name = renameName.trim();
    if (renamingId == null || name.length === 0) return;
    const folder = folders.find((f) => f.id === renamingId);
    if (folder == null) return;
    await runWrite(async () => {
      await getStore().saveFolder({
        ...folder,
        name,
        updatedAt: new Date().toISOString(),
      });
    });
    setRenamingId(null);
    setRenameName("");
  }

  async function deleteSelectedFolder() {
    if (selected == null) return;
    await runWrite(async () => {
      await getStore().deleteFolder(selected.id);
      // Its titles fall back to "All saved"; land the user there.
      setSelectedFolder(ALL);
    });
    setConfirmDelete(false);
  }

  /** Move one favorites entry into `toFolderId` ("" = All saved / root). Uses the
   * store's upsert + remove primitives so it works in Local and Server mode. */
  async function moveEntry(entry: LibraryEntryRecord, toFolderId: string) {
    const target = toFolderId.trim() || rootId;
    if (entry.folderId === target) return;
    await runWrite(async () => {
      const store = getStore();
      // Carry the row's metadata (added date, custom-list name, release/renewal
      // hints) across the move so it isn't reset to "just added just now".
      await store.addToLibrary({
        mediaId: entry.mediaId,
        listType: "favorites",
        folderId: toFolderId.trim() || null,
        preview: entry.preview,
        addedAt: entry.addedAt,
        customListName: entry.customListName,
        releaseDateHint: entry.releaseDateHint,
        renewalStatus: entry.renewalStatus,
      });
      // Drop the source-folder row so the title moves rather than being copied.
      await store.removeFromLibrary(entry.id);
    });
  }

  async function removeEntry(entry: LibraryEntryRecord) {
    await runWrite(async () => {
      await getStore().removeFromLibrary(entry.id);
    });
  }

  const visible: LibraryEntryRecord[] =
    selectedFolder === ALL
      ? entries
      : entries.filter((e) => e.folderId === selectedFolder);
  const visiblePreviews = visible.map((e) => e.preview);

  // Surface the watchlist only for a fresh, empty library viewed from All
  // saved. An empty folder must not borrow unrelated titles from the watchlist.
  const showingWatchlistFallback =
    selectedFolder === ALL && entries.length === 0 && watchlist.length > 0;
  const items = showingWatchlistFallback ? watchlist : visiblePreviews;
  const showingEmptyFolder = selectedFolder !== ALL && visible.length === 0;
  const hasEntries = entries.length > 0;
  // Finished-title check badges on the grid, from one batched history lookup.
  const watchedIds = useWatchedIds(entries);

  return (
    <div className="lib-screen">
      <div className="lib-head">
        <div>
          <h1 className="lib-h1">Library</h1>
          <p className="lib-sub t-secondary">Your collections and saved titles.</p>
        </div>
        {hasEntries && (
          <button
            type="button"
            className={`btn btn-sm${organize ? " btn-prominent" : ""}`}
            onClick={() => setOrganize((v) => !v)}
            aria-pressed={organize}
          >
            <Icon name={organize ? "check" : "sliders"} size={14} />
            {organize ? "Done" : "Organize"}
          </button>
        )}
      </div>

      <Rail
        title="Requested by your household"
        items={requested}
        onSelect={openDetail}
        showPosterRatings={settings?.showPosterRatings ?? false}
      />

      <div className="lib-folders">
        <button
          type="button"
          className={`lib-folder-chip chip${selectedFolder === ALL ? " is-active" : ""}`}
          onClick={() => setSelectedFolder(ALL)}
        >
          All saved
        </button>
        {manualFolders.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`lib-folder-chip chip${selectedFolder === f.id ? " is-active" : ""}`}
            onClick={() => setSelectedFolder(f.id)}
          >
            {f.name}
          </button>
        ))}
        {creating ? (
          <span className="lib-folder-new">
            <input
              autoFocus
              type="text"
              className="lib-folder-input"
              placeholder="Folder name"
              aria-label="New folder name"
              value={newName}
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFolder();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-prominent"
              disabled={busy || newName.trim().length === 0}
              onClick={() => void createFolder()}
            >
              Create
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="lib-folder-chip chip lib-folder-add"
            onClick={() => setCreating(true)}
          >
            + New folder
          </button>
        )}
      </div>

      {/* Rename / delete toolbar for the selected (non-system) folder. */}
      {selected != null && (
        <div className="lib-folder-tools">
          {renamingId === selected.id ? (
            <>
              <input
                autoFocus
                type="text"
                className="lib-folder-input"
                aria-label={`Rename folder ${selected.name}`}
                value={renameName}
                maxLength={40}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void renameFolder();
                  if (e.key === "Escape") setRenamingId(null);
                }}
              />
              <button
                type="button"
                className="btn btn-sm btn-prominent"
                disabled={busy || renameName.trim().length === 0}
                onClick={() => void renameFolder()}
              >
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRenamingId(null)}>
                Cancel
              </button>
            </>
          ) : confirmDelete ? (
            <>
              <span className="t-secondary">
                Delete “{selected.name}”? Its titles move to All saved.
              </span>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                aria-label={`Confirm delete folder ${selected.name}`}
                disabled={busy}
                onClick={() => void deleteSelectedFolder()}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setRenamingId(selected.id);
                  setRenameName(selected.name);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger-ghost"
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size={13} /> Delete
              </button>
            </>
          )}
        </div>
      )}

      {loading ? (
        <p className="t-secondary">Loading your library…</p>
      ) : error ? (
        <EmptyState
          icon="library"
          title="Couldn't load your library"
          subtitle="Something went wrong reading your saved titles from this device. Try reopening the app."
          note={error}
        />
      ) : showingEmptyFolder ? (
        <EmptyState
          icon="library"
          title="This folder is empty"
          subtitle={
            selected == null
              ? "Save titles to this folder, or view all of your saved favorites."
              : `Save titles to “${selected.name}”, or view all of your saved favorites.`
          }
          actions={
            <button
              type="button"
              className="btn btn-prominent"
              onClick={() => setSelectedFolder(ALL)}
            >
              View all saved
            </button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="library"
          title="Your library is empty"
          subtitle="Favorites and custom collections will appear here as you save titles."
          actions={
            <>
              <button
                type="button"
                className="btn btn-prominent"
                onClick={() =>
                  openBrowse({ kind: "category", type: "movie", category: "trending" })
                }
              >
                Browse trending
              </button>
              <button type="button" className="btn" onClick={() => navigate("search")}>
                Search catalog
              </button>
            </>
          }
        />
      ) : organize && visible.length > 0 ? (
        <ul className="lib-org-list" aria-label="Organize saved titles">
          {visible.map((entry) => {
            const poster = MediaPreviewNS.posterURL(entry.preview);
            const value =
              entry.folderId === rootId || entry.folderId == null ? ALL : entry.folderId;
            return (
              <li key={entry.id} className="lib-org-row glass-rest">
                <button
                  type="button"
                  className="lib-org-poster"
                  onClick={() => openDetail(entry.preview)}
                  title={entry.preview.title}
                >
                  {poster ? (
                    <img src={poster} alt="" loading="lazy" />
                  ) : (
                    <Icon name="discover" size={20} />
                  )}
                </button>
                <div className="lib-org-info">
                  <div className="lib-org-title">{entry.preview.title}</div>
                  <label className="lib-org-move">
                    <span className="t-secondary">Folder</span>
                    <select
                      value={value}
                      disabled={busy}
                      onChange={(e) =>
                        void moveEntry(entry, e.target.value === ALL ? "" : e.target.value)
                      }
                    >
                      <option value={ALL}>All saved</option>
                      {manualFolders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost lib-org-remove"
                  disabled={busy}
                  onClick={() => void removeEntry(entry)}
                >
                  <Icon name="trash" size={13} /> Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          {showingWatchlistFallback && (
            <p className="lib-sub t-secondary">
              Showing your watchlist - add favorites to build your library.
            </p>
          )}
          <VirtualMediaGrid
            items={items}
            renderItem={(item) => (
              <MediaCard
                item={item}
                onSelect={openDetail}
                watched={watchedIds.has(item.id)}
                showPosterRatings={settings?.showPosterRatings ?? false}
              />
            )}
          />
        </>
      )}
    </div>
  );
}
