// Watchlist + History persistence - backed by the storage port (Dexie/IndexedDB).
//
// The native app stores these in GRDB. The storage port replaces the old
// localStorage stopgap with the typed cross-platform `Store` (IndexedDB via
// Dexie), which works in a plain browser AND the Tauri webview. The screens
// render from an in-memory `MediaPreview[]` held by the AppStore; these helpers
// read/write the durable Store and return the refreshed list so the AppStore can
// update its state. `isInWatchlist` stays a pure check over the in-memory array.

import type { MediaPreview } from "../models/media";
import { getStore } from "../storage";
import type { WatchHistoryRecord } from "../storage/models";

/** Whether an item is in the (in-memory) watchlist array. Pure - no I/O. */
export function isInWatchlist(items: MediaPreview[], id: string): boolean {
  return items.some((i) => i.id === id);
}

/** Load the watchlist from the Store, most-recently-added first. */
export async function loadWatchlist(): Promise<MediaPreview[]> {
  const rows = await getStore().listWatchlist();
  return rows.map((r) => r.preview);
}

/** Load the watch history from the Store, most-recently-watched first. */
export async function loadHistory(): Promise<MediaPreview[]> {
  const rows = await getStore().listHistory(100);
  return rows.map((r) => r.preview);
}

/** Load the "continue watching" rows (incomplete, with resume positions). */
export async function loadContinueWatching(): Promise<WatchHistoryRecord[]> {
  return getStore().continueWatching(20);
}

/** Toggle an item in the watchlist; returns the refreshed list. */
export async function toggleWatchlist(
  item: MediaPreview,
): Promise<MediaPreview[]> {
  const store = getStore();
  if (await store.isInWatchlist(item.id)) {
    await store.removeFromWatchlist(item.id);
  } else {
    await store.addToWatchlist(item);
  }
  return loadWatchlist();
}

/** Remove an item from the watchlist; returns the refreshed list. */
export async function removeFromWatchlist(
  id: string,
): Promise<MediaPreview[]> {
  const store = getStore();
  await store.removeFromWatchlist(id);
  return loadWatchlist();
}

/** Record a viewed/played item into watch history (one row per (media,episode),
 * newest wins). Returns the refreshed history list. Optional resume fields let
 * playback record a real resume position; opening a Detail records a view with
 * default zero progress. */
export async function recordHistory(
  item: MediaPreview,
  opts?: {
    progressSeconds?: number;
    durationSeconds?: number | null;
    completed?: boolean;
    streamQuality?: string | null;
    episodeId?: string | null;
    preferredAudioId?: string | null;
    preferredAudioLang?: string | null;
    preferredSubId?: string | null;
    playbackSpeed?: number | null;
    subtitleDelay?: number | null;
    subtitlePosition?: number | null;
  },
): Promise<MediaPreview[]> {
  const store = getStore();
  const episodeId = opts?.episodeId ?? null;

  // A plain "viewed" event (opening Detail) carries no progress fields. Because
  // the store does a full-record REPLACE keyed by (mediaId, episodeId) - not a
  // merge - writing zeros here would wipe an existing resume position. So for a
  // viewed-only event, preserve the existing row's progress and only bump
  // recency (lastWatched defaults to now in the store). Real playback events
  // (recordResume) pass progress fields and overwrite as before.
  const isViewedOnly =
    opts?.progressSeconds === undefined &&
    opts?.durationSeconds === undefined &&
    opts?.completed === undefined;
  const existing = isViewedOnly ? await store.getResume(item.id, episodeId) : null;

  await store.recordHistory({
    mediaId: item.id,
    episodeId,
    progressSeconds: opts?.progressSeconds ?? existing?.progressSeconds ?? 0,
    durationSeconds: opts?.durationSeconds ?? existing?.durationSeconds ?? null,
    completed: opts?.completed ?? existing?.completed ?? false,
    streamQuality: opts?.streamQuality ?? existing?.streamQuality ?? null,
    preview: item,
    // Player prefs (the store carries existing values forward when omitted).
    preferredAudioId: opts?.preferredAudioId,
    preferredAudioLang: opts?.preferredAudioLang,
    preferredSubId: opts?.preferredSubId,
    playbackSpeed: opts?.playbackSpeed,
    subtitleDelay: opts?.subtitleDelay,
    subtitlePosition: opts?.subtitlePosition,
  });
  return loadHistory();
}
