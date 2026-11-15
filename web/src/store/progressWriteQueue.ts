import type { MediaPreview } from "../models/media";
import type { PlaybackPrefs } from "../storage/models";
import type { Store } from "../storage/types";
import { RemoteStore } from "../storage/RemoteStore";

/** Serial, coalescing, best-effort persistence for frequently sampled progress. */
export interface ProgressWriteJob {
  store: object;
  generation: number;
  mediaId: string;
  episodeId: string | null;
  snapshot?: unknown;
  mergeSnapshot?: (previous: unknown, next: unknown) => unknown;
  write: (signal: AbortSignal, snapshot?: unknown) => Promise<unknown>;
}

const MAX_PENDING_PROGRESS_WRITES = 64;
export const PROGRESS_HISTORY_TIMEOUT_MS = 10_000;

/** Timeout/abort wrapper kept in the lazily loaded progress-only chunk. */
export async function withProgressWriteTimeout<T>(
  signal: AbortSignal,
  write: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw new DOMException("Progress write cancelled", "AbortError");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = () => rejectCancelled?.(
    new DOMException("Progress write cancelled", "AbortError"),
  );
  signal.addEventListener("abort", onAbort, { once: true });
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Progress write timed out."));
    }, PROGRESS_HISTORY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([write(controller.signal), expired, cancelled]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    signal.removeEventListener("abort", onAbort);
  }
}

export class ProgressWriteQueue {
  private readonly storeIds = new WeakMap<object, number>();
  private nextStoreId = 1;
  private readonly pending = new Map<string, ProgressWriteJob>();
  private active: { job: ProgressWriteJob; controller: AbortController } | null = null;
  private draining: Promise<void> | null = null;

  recordResume(
    store: Store,
    generation: number,
    item: MediaPreview,
    progressSeconds: number,
    durationSeconds: number | null,
    episodeId?: string | null,
    prefs?: PlaybackPrefs,
  ): void {
    const completed =
      durationSeconds != null &&
      durationSeconds > 0 &&
      progressSeconds / durationSeconds >= 0.95;
    // `recordHistory()` is intentionally convenient for interactive history
    // mutations because it reads the refreshed list back. Playback progress
    // is different: doing that every five seconds deserializes all history
    // rows and changes the provider context for the entire app. The storage
    // upsert already preserves omitted player prefs, so persist directly and
    // refresh once at the playback-session boundary or when History opens.
    const entry = {
      mediaId: item.id,
      episodeId: episodeId ?? null,
      progressSeconds,
      durationSeconds,
      completed,
      preview: item,
      preferredAudioId: prefs?.preferredAudioId,
      preferredAudioLang: prefs?.preferredAudioLang,
      preferredSubId: prefs?.preferredSubId,
      playbackSpeed: prefs?.playbackSpeed,
      subtitleDelay: prefs?.subtitleDelay,
      subtitlePosition: prefs?.subtitlePosition,
    };
    const mergePendingEntries = (previous: unknown, next: unknown) => {
      const older = previous as typeof entry;
      const newer = next as typeof entry;
      return {
        ...older,
        ...newer,
        preferredAudioId: newer.preferredAudioId === undefined
          ? older.preferredAudioId : newer.preferredAudioId,
        preferredAudioLang: newer.preferredAudioLang === undefined
          ? older.preferredAudioLang : newer.preferredAudioLang,
        preferredSubId: newer.preferredSubId === undefined
          ? older.preferredSubId : newer.preferredSubId,
        playbackSpeed: newer.playbackSpeed === undefined
          ? older.playbackSpeed : newer.playbackSpeed,
        subtitleDelay: newer.subtitleDelay === undefined
          ? older.subtitleDelay : newer.subtitleDelay,
        subtitlePosition: newer.subtitlePosition === undefined
          ? older.subtitlePosition : newer.subtitlePosition,
      };
    };
    this.enqueue({
      store,
      generation,
      mediaId: item.id,
      episodeId: episodeId ?? null,
      snapshot: entry,
      mergeSnapshot: mergePendingEntries,
      write: (signal, snapshot) => {
        const pendingEntry = snapshot as typeof entry;
        return store instanceof RemoteStore
          ? store.recordHistoryProgress(pendingEntry, signal)
          : store.recordHistory(pendingEntry);
      },
    });
  }

  enqueue(job: ProgressWriteJob): void {
    const storeId = this.storeId(job.store);
    const key = JSON.stringify([storeId, job.generation, job.mediaId, job.episodeId]);
    // Moving an overwritten key to the end preserves the ordering of the
    // latest snapshots while ensuring only one pending snapshot per identity.
    const previous = this.pending.get(key);
    const nextJob = previous != null && job.mergeSnapshot != null
      ? {
          ...job,
          snapshot: job.mergeSnapshot(previous.snapshot, job.snapshot),
        }
      : job;
    this.pending.delete(key);
    this.pending.set(key, nextJob);
    while (this.pending.size > MAX_PENDING_PROGRESS_WRITES) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.pending.delete(oldest);
    }
    this.kick();
  }

  cancelGeneration(generation: number): void {
    for (const [key, job] of this.pending) {
      if (job.generation === generation) this.pending.delete(key);
    }
    if (this.active?.job.generation === generation) this.active.controller.abort();
  }

  async flush(): Promise<void> {
    while (this.draining != null || this.pending.size > 0) {
      this.kick();
      const current = this.draining;
      if (current != null) await current;
    }
  }

  private storeId(store: object): number {
    let id = this.storeIds.get(store);
    if (id == null) {
      id = this.nextStoreId++;
      this.storeIds.set(store, id);
    }
    return id;
  }

  private kick(): void {
    if (this.draining != null || this.pending.size === 0) return;
    const task = this.drain();
    this.draining = task;
    void task.finally(() => {
      if (this.draining === task) this.draining = null;
      if (this.pending.size > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const first = this.pending.entries().next().value as [string, ProgressWriteJob] | undefined;
      if (first == null) return;
      const [key, job] = first;
      this.pending.delete(key);
      const controller = new AbortController();
      this.active = { job, controller };
      try {
        await job.write(controller.signal, job.snapshot);
      } catch {
        // Progress is best-effort; later snapshots continue through the queue.
      } finally {
        if (this.active?.job === job) this.active = null;
      }
    }
  }
}

/** Passed by the lazy player screen; each provider creates its own queue. */
export function createProgressWriteQueue(): ProgressWriteQueue {
  return new ProgressWriteQueue();
}
