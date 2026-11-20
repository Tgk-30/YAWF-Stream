import { useMemo, useSyncExternalStore } from "react";

export interface VideoPresentation {
  fit: "contain" | "cover" | "fill";
  zoom: number;
  panX: number;
  panY: number;
  /** A session edit takes precedence over the current title's saved setting. */
  subtitlePosition?: number;
}

const DEFAULT_PRESENTATION: VideoPresentation = { fit: "contain", zoom: 1, panX: 0, panY: 0 };
type VideoAdjustments = Omit<VideoPresentation, "fit">;
const DEFAULT_ADJUSTMENTS: VideoAdjustments = { zoom: 1, panX: 0, panY: 0 };

function createVideoPresentationStore() {
  const listeners = new Set<() => void>();
  let value = DEFAULT_PRESENTATION;
  let adjustments = DEFAULT_ADJUSTMENTS;
  return {
    getSnapshot: () => value,
    getFitSnapshot: () => value.fit,
    getAdjustmentsSnapshot: () => adjustments,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(patch: Partial<VideoPresentation>) {
      const next = { ...value, ...patch };
      const { fit, ...nextAdjustments } = next;
      const changed = next.zoom !== value.zoom || next.panX !== value.panX ||
        next.panY !== value.panY || next.subtitlePosition !== value.subtitlePosition;
      if (!changed && fit === value.fit) return;
      value = next;
      if (changed) adjustments = nextAdjustments;
      for (const listener of listeners) listener();
    },
  };
}

export type VideoPresentationStore = ReturnType<typeof createVideoPresentationStore>;

/** Own presentation by content/file without subscribing the outer player. */
export function useVideoPresentationStore(owner: string): VideoPresentationStore {
  return useMemo(createVideoPresentationStore, [owner]);
}

export function useVideoPresentation(store: VideoPresentationStore): VideoPresentation {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useVideoFit(store: VideoPresentationStore): VideoPresentation["fit"] {
  return useSyncExternalStore(store.subscribe, store.getFitSnapshot, store.getFitSnapshot);
}

export function useVideoAdjustments(store: VideoPresentationStore): VideoAdjustments {
  return useSyncExternalStore(store.subscribe, store.getAdjustmentsSnapshot, store.getAdjustmentsSnapshot);
}
