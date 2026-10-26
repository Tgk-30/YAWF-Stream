// Detail-screen data layer.
//
// Loads the full MediaItem (overview/genres/runtime/imdb id), the cast, and the
// "more like this" recommendations for a selected MediaPreview - live via the
// shared TMDBService when configured, else a graceful fixtures/empty fallback so
// the Detail screen still renders for a screenshot without a key. Imports the
// ported TMDBService READ-ONLY.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CastMember, MediaItem, MediaPreview } from "../models/media";
import type { TMDBService } from "../services/metadata/TMDBService";
import { fetchServerDetail } from "../lib/serverApi";
import { isServerMode } from "../lib/serverMode";
import { getNetworkMode, NetworkBlockedError } from "../lib/networkPolicy";
import { getStore } from "../storage";

export interface DetailData {
  item: MediaItem | null;
  cast: CastMember[];
  related: MediaPreview[];
  /** IMDb id (tt…) when known - needed by the indexer search. */
  imdbId: string | null;
}

export interface DetailState {
  data: DetailData;
  loading: boolean;
  error: string | null;
  /** "live" when TMDB produced it, "fixtures" for the no-key fallback. */
  source: "live" | "fixtures";
}

interface DetailOwner {
  id: string | null;
  type: MediaPreview["type"] | null;
  tmdbId: number | null;
  service: TMDBService | null;
  requestMode: "server" | "standard" | "fullLocal" | "offline";
}

interface OwnedDetailState {
  owner: DetailOwner;
  value: DetailState;
}

function sameDetailOwner(left: DetailOwner, right: DetailOwner): boolean {
  return left.id === right.id &&
    left.type === right.type &&
    left.tmdbId === right.tmdbId &&
    left.service === right.service &&
    left.requestMode === right.requestMode;
}

/** Build a usable MediaItem straight from a preview (no network) for the
 * fixtures/no-key path so the hero still renders title/year/rating/poster. */
function previewToItem(p: MediaPreview): MediaItem {
  return {
    id: p.id,
    type: p.type,
    title: p.title,
    year: p.year ?? null,
    posterPath: p.posterPath ?? null,
    backdropPath: p.backdropPath ?? null,
    overview: null,
    genres: [],
    imdbRating: p.imdbRating ?? null,
    rtRating: null,
    runtime: null,
    status: null,
    tmdbId: p.tmdbId ?? null,
    lastFetched: new Date().toISOString(),
  };
}

function initialDetailState(preview: MediaPreview | null): DetailState {
  return {
    data: {
      item: preview == null ? null : previewToItem(preview),
      cast: [],
      related: [],
      imdbId: preview?.id.startsWith("tt") === true ? preview.id : null,
    },
    loading: true,
    error: null,
    source: "fixtures",
  };
}

export async function loadLive(
  service: TMDBService,
  preview: MediaPreview,
  onImdbId?: (imdbId: string) => void,
): Promise<DetailData> {
  const tmdbId =
    preview.tmdbId ??
    (preview.id.startsWith("tmdb-")
      ? Number.parseInt(preview.id.slice(5), 10)
      : null);

  // Start independent requests together. External ids previously waited for
  // detail, then cast/recommendations, leaving stream search needlessly idle.
  const hasTmdbId = tmdbId != null && !Number.isNaN(tmdbId);
  let publishedImdbId: string | null = null;
  const publishImdbId = (candidate: string | null | undefined) => {
    if (candidate == null || !candidate.startsWith("tt") || candidate === publishedImdbId) return;
    publishedImdbId = candidate;
    onImdbId?.(candidate);
  };
  const externalIds = hasTmdbId
    ? service
        .getExternalIds(tmdbId, preview.type)
        .then((ids) => {
          // This can resolve before the heavyweight detail payload. Publishing
          // it immediately lets useStreams begin without waiting for hero art.
          publishImdbId(ids.imdbId);
          return ids;
        })
        .catch(() => null)
    : Promise.resolve(null);
  const detailPromise = service.getDetail(preview.id, preview.type);
  const castPromise = hasTmdbId
    ? service.getCast(tmdbId, preview.type).catch(() => [] as CastMember[])
    : Promise.resolve([] as CastMember[]);
  const relatedPromise = hasTmdbId
    ? service.getRecommendations(tmdbId, preview.type).catch(() => [] as MediaPreview[])
    : Promise.resolve([] as MediaPreview[]);

  const detail = await detailPromise;
  try {
    // Cache under the PREVIEW id (the stable id a browse card carries), which is
    // what the Offline read path looks up. detail.id may be an IMDb "tt..." id
    // that differs from the preview's "tmdb-..." id, so keying by detail.id here
    // would guarantee an Offline cache miss.
    await getStore().putMedia(detail, preview.id);
  } catch {
    // The cache is a convenience for Offline mode, never a reason to fail detail.
  }

  // The detail id is an IMDb id (tt…) when TMDB had one, else a tmdb- fallback.
  let imdbId = detail.id.startsWith("tt") ? detail.id : null;
  // Fallback: the detail payload's appended external_ids sometimes lacks
  // imdb_id (notably TV) - try the dedicated external_ids endpoint before
  // settling for null, because a null imdb id means the STREAM SEARCH NEVER
  // RUNS for this title (the silent "no streams found" P0).
  if (imdbId == null) {
    const ids = await externalIds;
    if (ids?.imdbId != null && ids.imdbId.startsWith("tt")) imdbId = ids.imdbId;
  }

  // Publish the stream-search key while cast and related art continue loading.
  publishImdbId(imdbId);
  const [cast, related] = await Promise.all([castPromise, relatedPromise]);

  return { item: detail, cast, related, imdbId };
}

/** Load cached detail when Offline blocks metadata, preserving a useful Detail
 * screen for titles the user opened while connected. */
export async function loadDetailWithOfflineFallback(
  service: TMDBService,
  preview: MediaPreview,
  onImdbId?: (imdbId: string) => void,
): Promise<DetailData | null> {
  try {
    return await loadLive(service, preview, onImdbId);
  } catch (error) {
    if (!(error instanceof NetworkBlockedError) && getNetworkMode() !== "offline") {
      throw error;
    }
    const cached = await getStore().getMedia(preview.id);
    if (cached == null) return null;
    const imdbId = cached.item.id.startsWith("tt") ? cached.item.id : null;
    if (imdbId != null) onImdbId?.(imdbId);
    return { item: cached.item, cast: [], related: [], imdbId };
  }
}

/** Resolve the detail data for a selected preview. */
export function useDetail(
  preview: MediaPreview | null,
  service: TMDBService | null,
): DetailState {
  const serverMode = isServerMode();
  const networkMode = getNetworkMode();
  const requestPreview = useMemo(() => preview, [
    preview?.id,
    preview?.type,
    preview?.title,
    preview?.year,
    preview?.posterPath,
    preview?.backdropPath,
    preview?.imdbRating,
    preview?.tmdbId,
  ]);
  const owner = useMemo<DetailOwner>(() => ({
    id: requestPreview?.id ?? null,
    type: requestPreview?.type ?? null,
    tmdbId: requestPreview?.tmdbId ?? null,
    service,
    requestMode: serverMode ? "server" : networkMode,
  }), [requestPreview?.id, requestPreview?.type, requestPreview?.tmdbId, service, serverMode, networkMode]);
  const fallback = initialDetailState(requestPreview);
  const [state, setState] = useState<OwnedDetailState>(() => ({
    owner,
    value: fallback,
  }));
  const ownerRef = useRef(owner);
  useLayoutEffect(() => {
    ownerRef.current = owner;
  }, [owner]);

  useEffect(() => {
    const commitState = (
      next: DetailState | ((current: DetailState) => DetailState),
    ) => {
      if (!sameDetailOwner(ownerRef.current, owner)) return;
      setState((current) => {
        const currentValue = sameDetailOwner(current.owner, owner)
          ? current.value
          : initialDetailState(requestPreview);
        return {
          owner,
          value: typeof next === "function" ? next(currentValue) : next,
        };
      });
    };

    if (requestPreview == null) {
      commitState(initialDetailState(null));
      return;
    }
    const currentPreview = requestPreview;
    let cancelled = false;

    commitState(initialDetailState(currentPreview));

    async function run() {
      if (serverMode) {
        try {
          const data = await fetchServerDetail({
            id: currentPreview.id,
            type: currentPreview.type,
          });
          if (!cancelled) {
            commitState({ data, loading: false, error: null, source: "live" });
          }
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!cancelled) {
            commitState({
              data: {
                item: previewToItem(currentPreview),
                cast: [],
                related: [],
                // Catalog previews are often IMDb-rooted (tt…) - pass the id
                // through so series/stream search works without TMDB.
                imdbId: currentPreview.id.startsWith("tt") ? currentPreview.id : null,
              },
              loading: false,
              error: message,
              source: "fixtures",
            });
          }
          return;
        }
      }

      if (service == null) {
        if (!cancelled) {
          commitState({
            data: {
              item: previewToItem(currentPreview),
              cast: [],
              related: [],
              imdbId: currentPreview.id.startsWith("tt") ? currentPreview.id : null,
            },
            loading: false,
            error: null,
            source: "fixtures",
          });
        }
        return;
      }

      try {
        const data = await loadDetailWithOfflineFallback(service, currentPreview, (imdbId) => {
          if (cancelled) return;
          commitState((current) => ({
            ...current,
            data: { ...current.data, imdbId },
            source: "live",
          }));
        });
        if (!cancelled && data != null) {
          commitState({ data, loading: false, error: null, source: "live" });
        } else if (!cancelled) {
          commitState({
            data: { item: null, cast: [], related: [], imdbId: null },
            loading: false,
            error: "Not available offline (not cached yet).",
            source: "fixtures",
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          commitState({
            data: {
              item: previewToItem(currentPreview),
              cast: [],
              related: [],
              imdbId: currentPreview.id.startsWith("tt") ? currentPreview.id : null,
            },
            loading: false,
            error: message,
            source: "fixtures",
          });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [requestPreview, service, owner, serverMode]);

  return sameDetailOwner(state.owner, owner) ? state.value : fallback;
}
