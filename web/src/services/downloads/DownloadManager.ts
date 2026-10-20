import type { DebridFileHint, StreamInfo } from "../debrid/models";
import {
  getDownloadsBridge,
  type DownloadProgress,
  type DownloadsBridge,
} from "../../lib/downloadsBridge";
import type { DownloadRecord } from "../../storage/models";
import type { Store } from "../../storage/types";
import {
  optimizedOutputPath,
  rawDownloadPath,
} from "./filename";
import { recordDiagnostic } from "../../lib/diagnostics";

/** Plain setting key on purpose: downloads do not need a global AppSettings
 * rebuild just to change their destination. */
export const DOWNLOADS_DIRECTORY_SETTING = "downloads_directory";

export interface DownloadDebridResolver {
  resolveStream(
    infoHash: string,
    cachedOn?: null,
    fileHint?: DebridFileHint | null,
  ): Promise<Pick<StreamInfo, "streamURL" | "fileName">>;
}

export interface EnqueueDownloadInput {
  jobId?: string;
  mediaId: string;
  episodeId?: string | null;
  title: string;
  season?: number | null;
  episode?: number | null;
  infoHash: string;
  fileHint?: string | null;
  fileIndex?: number | null;
  fileNameHint?: string | null;
  /** Known size of the picked source, used to seed the progress denominator.
   *  The engine refines it from Content-Length when the host sends one; without
   *  this the bar has no total and reads 0% for the whole transfer. */
  sizeBytes?: number | null;
  mode: "full" | "optimized";
  optimizeProfile?: "remux" | "h265" | null;
  keepAudioLangs?: string[];
  keepSubLangs?: string[];
}

function makeJobId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `download-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatBytesForError(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.ceil(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Create a complete, durable queue record from a Detail action. */
export function makeDownloadRecord(
  input: EnqueueDownloadInput,
  now = new Date().toISOString(),
): DownloadRecord {
  return {
    jobId: input.jobId ?? makeJobId(),
    mediaId: input.mediaId,
    episodeId: input.episodeId ?? null,
    title: input.title,
    season: input.season ?? null,
    episode: input.episode ?? null,
    infoHash: input.infoHash,
    fileHint: input.fileHint ?? null,
    ...(input.fileIndex == null
      ? {}
      : {
          fileIndex: input.fileIndex,
          fileNameHint: input.fileNameHint ?? null,
        }),
    mode: input.mode,
    optimizeProfile: input.mode === "optimized" ? input.optimizeProfile ?? "remux" : null,
    keepAudioLangs: input.keepAudioLangs ?? [],
    keepSubLangs: input.keepSubLangs ?? [],
    status: "queued",
    bytesDone: 0,
    bytesTotal: input.sizeBytes != null && input.sizeBytes > 0 ? input.sizeBytes : null,
    optimizePercent: null,
    destPath: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function enqueueDownload(
  store: Store,
  input: EnqueueDownloadInput,
): Promise<DownloadRecord> {
  const record = makeDownloadRecord(input);
  await store.saveDownload(record);
  return record;
}

/** Enqueue a season or show without serially waiting for each IndexedDB write. */
export async function enqueueSeasonDownloads(
  store: Store,
  inputs: EnqueueDownloadInput[],
): Promise<DownloadRecord[]> {
  const records = inputs.map((input) => makeDownloadRecord(input));
  await Promise.all(records.map((record) => store.saveDownload(record)));
  return records;
}

export async function downloadsDirectory(
  store: Pick<Store, "getSetting" | "setSetting">,
  bridge: Pick<DownloadsBridge, "downloadsDefaultDir"> = getDownloadsBridge(),
): Promise<string> {
  const saved = await store.getSetting(DOWNLOADS_DIRECTORY_SETTING);
  if (saved != null && saved.trim().length > 0) return saved.trim();
  const defaultDir = await bridge.downloadsDefaultDir();
  await store.setSetting(DOWNLOADS_DIRECTORY_SETTING, defaultDir);
  return defaultDir;
}

type ProgressListener = (progress: DownloadProgress) => void;
type DownloadRecordsListener = (records: DownloadRecord[]) => void;

/** Native transfers can report many times per second. The only consumer of the
 * in-memory progress listener is the Downloads screen's speed text, so 1Hz
 * aligns with durable persistence; terminal events bypass the throttle. */
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const PROGRESS_UI_INTERVAL_MS = 1000;
const DOWNLOAD_FREE_SPACE_RESERVE_BYTES = 128 * 1024 * 1024;
const MAX_AUTOMATIC_RETRIES = 2;
const AUTOMATIC_RETRY_BASE_DELAY_MS = 1_500;

function isTransientDownloadFailure(message: string): boolean {
  const value = message.toLowerCase();
  if (
    /disk|space|permission|denied|unsupported|no playable|configure a debrid|ffmpeg is unavailable/.test(
      value,
    )
  ) {
    return false;
  }
  return /timed? out|timeout|temporar|network|connection|reset|unreachable|download stream failed|expired link|\b429\b|\b50[234]\b/.test(
    value,
  );
}

function requestDownloadNotificationPermission(): void {
  const NotificationApi = globalThis.Notification;
  if (NotificationApi == null || NotificationApi.permission !== "default") return;
  void NotificationApi.requestPermission().catch(() => {});
}

export function notifyDownloadCompleted(title: string): void {
  const NotificationApi = globalThis.Notification;
  if (NotificationApi == null || NotificationApi.permission !== "granted") return;
  try {
    new NotificationApi("Download complete", {
      body: `${title} is ready to watch.`,
      tag: `yawf-download-${title}`,
    });
  } catch {
    // Native notification permission and platform support are best effort.
  }
}

function notifyDownloadFailed(title: string): void {
  const NotificationApi = globalThis.Notification;
  if (NotificationApi == null || NotificationApi.permission !== "granted") return;
  try {
    new NotificationApi("Download needs attention", {
      body: `${title} could not finish. Open Downloads to retry.`,
      tag: `yawf-download-${title}`,
    });
  } catch {
    // Native notification permission and platform support are best effort.
  }
}

type ProgressMeasurements = Partial<
  Pick<DownloadRecord, "bytesDone" | "bytesTotal" | "optimizePercent">
>;

function progressMeasurements(
  progress: DownloadProgress,
  record: DownloadRecord,
): ProgressMeasurements {
  if (progress.percent != null) {
    return { optimizePercent: progress.percent };
  }
  return {
    bytesDone: Math.max(0, progress.bytesDone),
    // A host that sends no Content-Length reports bytesTotal null on every
    // tick. Keep the total seeded from the picked source.
    bytesTotal: progress.bytesTotal ?? record.bytesTotal,
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Download launch canceled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Download launch canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Frontend queue scheduler for the native streaming executor.
 *
 * A job starts in queued, resolves a fresh debrid URL, then waits for native
 * progress. Optimized jobs turn the native download terminal event into a
 * second optimizing phase and only complete after ffmpeg emits its terminal
 * event. Paused records stay paused. Transient failures receive two bounded,
 * delayed retries before remaining terminal for user recovery.
 */
export class DownloadManager {
  private readonly bridge: DownloadsBridge;
  private readonly concurrency: number;
  private started = false;
  private ready = false;
  private pumping = false;
  private progressUnlisten: (() => void) | null = null;
  private queueUnlisten: (() => void) | null = null;
  private readonly launches = new Map<string, AbortController>();
  private readonly nativeJobs = new Map<string, "download" | "transcode">();
  private readonly pausing = new Set<string>();
  private readonly optimizingOutputs = new Map<string, string>();
  private readonly speeds = new Map<string, number>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly recordsListeners = new Set<DownloadRecordsListener>();
  private recordsByJobId = new Map<string, DownloadRecord>();
  private records: DownloadRecord[] = [];
  private readonly pendingProgress = new Map<string, DownloadProgress>();
  private readonly progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastProgressPersistedAt = new Map<string, number>();
  private readonly pendingProgressNotifications = new Map<string, DownloadProgress>();
  private readonly progressNotificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastProgressNotifiedAt = new Map<string, number>();
  private readonly recordUpdateTails = new Map<string, Promise<void>>();
  private readonly automaticRetryAttempts = new Map<string, number>();
  private readonly automaticRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private ffmpegAvailability: Promise<boolean> | null = null;

  constructor(
    private readonly store: Store,
    private readonly debrid: DownloadDebridResolver | null,
    options: { bridge?: DownloadsBridge; concurrency?: number } = {},
  ) {
    this.bridge = options.bridge ?? getDownloadsBridge();
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 3));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recoverInterrupted();
    if (!this.started) return;
    this.queueUnlisten = this.store.subscribeDownloads((records) => {
      // This is the one liveQuery-backed queue subscription for scheduler and
      // UI. Cache every row for direct progress lookup and pump only after
      // queue/status changes, so byte persistence never re-runs a queue scan.
      if (this.syncRecords(records)) void this.pump();
    });
    try {
      const unlisten = await this.bridge.listenDownloadProgress((progress) => {
        if (progress.speedBps != null) this.speeds.set(progress.jobId, progress.speedBps);
        this.publishProgress(progress);
        void this.handleProgress(progress);
      });
      if (!this.started) {
        unlisten();
        return;
      }
      this.progressUnlisten = unlisten;
    } catch {
      this.progressUnlisten = null;
      this.queueUnlisten?.();
      this.queueUnlisten = null;
      this.started = false;
      return;
    }
    if (!this.started) return;
    this.ready = true;
    void this.pump();
  }

  stop(): void {
    this.started = false;
    this.ready = false;
    this.launches.forEach((controller) => controller.abort());
    this.launches.clear();
    this.progressUnlisten?.();
    this.progressUnlisten = null;
    this.queueUnlisten?.();
    this.queueUnlisten = null;
    this.progressTimers.forEach((timer) => clearTimeout(timer));
    this.progressTimers.clear();
    this.pendingProgress.clear();
    this.lastProgressPersistedAt.clear();
    this.progressNotificationTimers.forEach((timer) => clearTimeout(timer));
    this.progressNotificationTimers.clear();
    this.pendingProgressNotifications.clear();
    this.lastProgressNotifiedAt.clear();
    this.automaticRetryTimers.forEach((timer) => clearTimeout(timer));
    this.automaticRetryTimers.clear();
    this.automaticRetryAttempts.clear();
  }

  subscribeProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Share the runtime's one queue subscription with mounted queue views. */
  subscribeRecords(listener: DownloadRecordsListener): () => void {
    this.recordsListeners.add(listener);
    listener(this.records);
    return () => this.recordsListeners.delete(listener);
  }

  speedFor(jobId: string): number | undefined {
    return this.speeds.get(jobId);
  }

  async enqueue(input: EnqueueDownloadInput): Promise<DownloadRecord> {
    requestDownloadNotificationPermission();
    const record = await enqueueDownload(this.store, input);
    void this.pump();
    return record;
  }

  async enqueueSeason(inputs: EnqueueDownloadInput[]): Promise<DownloadRecord[]> {
    requestDownloadNotificationPermission();
    const records = await enqueueSeasonDownloads(this.store, inputs);
    void this.pump();
    return records;
  }

  async pause(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || !["resolving", "downloading", "optimizing"].includes(record.status)) {
      return;
    }
    this.pausing.add(jobId);
    try {
      if (record.status === "resolving") this.launches.get(jobId)?.abort();
      else if (record.status === "optimizing") await this.bridge.transcodeCancel(jobId);
      else await this.bridge.downloadPause(jobId);
      this.clearPendingProgress(jobId);
      await this.updateRecord(jobId, { status: "paused", error: null });
      void this.pump();
    } finally {
      this.pausing.delete(jobId);
    }
  }

  async resume(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || record.status !== "paused") return;
    // A job paused during this process can use native HTTP Range resume. After
    // a restart the Rust process has no URL/job state, so queue a fresh resolve.
    if (this.nativeJobs.get(jobId) === "transcode") {
      const rawPath = record.destPath;
      if (rawPath == null || record.optimizeProfile == null) {
        await this.fail(jobId, "The downloaded source path is unavailable for optimization.");
        return;
      }
      await this.startOptimization(
        record,
        rawPath,
        {
          bytesDone: record.bytesDone,
          bytesTotal: record.bytesTotal,
        },
        ["paused"],
      );
      return;
    }
    if (this.nativeJobs.get(jobId) === "download") {
      await this.bridge.downloadResume(jobId);
      await this.updateRecord(jobId, { status: "downloading", error: null });
      return;
    }
    await this.updateRecord(jobId, { status: "queued", error: null });
    void this.pump();
  }

  async retry(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || record.status !== "failed") return;
    this.clearAutomaticRetry(jobId);
    await this.updateRecord(jobId, {
      status: "queued",
      error: null,
      optimizePercent: null,
    });
    void this.pump();
  }

  async deleteCompletedFile(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || record.status !== "completed" || record.destPath == null) return;
    if (this.bridge.downloadDeleteFile == null) {
      await this.updateRecord(jobId, {
        error: "This app build cannot delete downloaded files.",
      });
      return;
    }
    try {
      this.clearAutomaticRetry(jobId);
      await this.bridge.downloadDeleteFile(record.destPath);
      await this.store.deleteDownload(jobId);
    } catch (error) {
      await this.updateRecord(jobId, {
        error: `The downloaded file could not be deleted. ${errorMessage(error)}`,
      });
    }
  }

  async cancel(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || ["completed", "canceled"].includes(record.status)) return;
    const nativeKind = this.nativeJobs.get(jobId);
    if (nativeKind == null && !["downloading", "optimizing", "paused"].includes(record.status)) {
      await this.forceStop(jobId);
      return;
    }
    this.launches.get(jobId)?.abort();
    this.clearPendingProgress(jobId);
    try {
      if (nativeKind === "transcode" || record.status === "optimizing") {
        await this.bridge.transcodeCancel(jobId);
      } else {
        await this.bridge.downloadCancel(jobId);
      }
    } catch {
      await this.bridge.downloadForceStop(jobId).catch(() => undefined);
    } finally {
      this.nativeJobs.delete(jobId);
      this.optimizingOutputs.delete(jobId);
      await this.updateRecord(jobId, { status: "canceled", error: null });
      void this.pump();
    }
  }

  /** Abort a transfer or optimization if one exists, then make the durable row
   * canceled even when it was queued, resolving, failed, or stale. */
  async forceStop(jobId: string): Promise<void> {
    const record = await this.recordForControl(jobId);
    if (record == null || ["completed", "canceled"].includes(record.status)) return;
    this.launches.get(jobId)?.abort();
    this.clearAutomaticRetry(jobId);
    this.pausing.add(jobId);
    this.clearPendingProgress(jobId);
    let cleanupError: unknown = null;
    let nativeStopFailed = false;
    try {
      await this.bridge.downloadForceStop(jobId);
    } catch (error) {
      nativeStopFailed = true;
      cleanupError = error;
    }
    // A terminal native failure removes its in-memory executor before the user
    // can press Stop. Delete the durable row's known partial path explicitly so
    // the action remains honest after a restart or a failed transfer.
    if (record.destPath != null && this.bridge.downloadDeleteFile != null) {
      try {
        await this.bridge.downloadDeleteFile(record.destPath);
        if (!nativeStopFailed) cleanupError = null;
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      this.nativeJobs.delete(jobId);
      this.optimizingOutputs.delete(jobId);
      if (cleanupError != null) {
        await this.updateRecord(jobId, {
          status: "failed",
          error: `The partial file could not be removed. ${errorMessage(cleanupError)}`,
        });
      } else {
        await this.updateRecord(jobId, { status: "canceled", error: null });
      }
    } finally {
      this.pausing.delete(jobId);
      void this.pump();
    }
  }

  async recoverInterrupted(): Promise<void> {
    const records = await this.store.listDownloads();
    await Promise.all(
      records
        .filter((record) =>
          ["resolving", "downloading", "optimizing"].includes(record.status),
        )
        .map((record) => this.store.updateDownload(record.jobId, { status: "paused" })),
    );
  }

  private async pump(): Promise<void> {
    if (!this.started || !this.ready || this.pumping) return;
    this.pumping = true;
    try {
      const records = await this.store.listDownloads();
      const active = new Set(
        records
          .filter((record) => ["resolving", "downloading", "optimizing"].includes(record.status))
          .map((record) => record.jobId),
      );
      this.launches.forEach((_controller, jobId) => active.add(jobId));
      for (const record of records.filter((row) => row.status === "queued")) {
        if (this.launches.has(record.jobId)) continue;
        if (active.size >= this.concurrency) break;
        const controller = new AbortController();
        this.launches.set(record.jobId, controller);
        active.add(record.jobId);
        void this.resolveAndStart(record, controller).finally(() => {
          if (this.launches.get(record.jobId) === controller) {
            this.launches.delete(record.jobId);
          }
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async resolveAndStart(
    record: DownloadRecord,
    controller: AbortController,
  ): Promise<void> {
    if (this.debrid == null) {
      await this.fail(record.jobId, "Configure a debrid service before downloading.");
      return;
    }
    try {
      await this.updateRecord(record.jobId, {
        status: "resolving",
        error: null,
      });
      if (!this.isCurrentLaunch(record.jobId, controller)) return;
      const episodeHint =
        record.season != null && record.episode != null
          ? { season: record.season, episode: record.episode }
          : null;
      const hint: DebridFileHint | null = record.fileIndex == null
        ? episodeHint
        : {
            fileIndex: record.fileIndex,
            fileName: record.fileNameHint ?? null,
            ...(episodeHint ?? {}),
          };
      const stream = await abortable(
        this.debrid.resolveStream(record.infoHash, null, hint),
        controller.signal,
      );
      if (!this.isCurrentLaunch(record.jobId, controller)) return;
      const latest = this.recordsByJobId.get(record.jobId);
      if (latest == null || latest.status !== "resolving") return;
      const directory = await downloadsDirectory(this.store, this.bridge);
      if (!this.isCurrentLaunch(record.jobId, controller)) return;
      const resumeFromExisting =
        latest.destPath != null && latest.bytesDone > 0;
      const destPath =
        resumeFromExisting && latest.destPath != null
          ? latest.destPath
          : rawDownloadPath(directory, latest, stream.fileName);
      if (
        this.bridge.downloadsAvailableSpace != null &&
        latest.episodeId == null &&
        latest.bytesTotal != null &&
        latest.bytesTotal > 0
      ) {
        const available = await this.bridge.downloadsAvailableSpace(destPath);
        const remaining = Math.max(
          0,
          latest.bytesTotal - (resumeFromExisting ? latest.bytesDone : 0),
        );
        // Optimized downloads temporarily need both the complete source and
        // the output file. Budget one full source-sized output rather than
        // discovering the shortage after the network transfer finishes.
        const workingSpace =
          latest.mode === "optimized"
            ? latest.bytesTotal
            : DOWNLOAD_FREE_SPACE_RESERVE_BYTES;
        if (available < remaining + workingSpace) {
          throw new Error(
            `Not enough free disk space. This download needs about ${formatBytesForError(remaining)}, plus ${formatBytesForError(workingSpace)} of working space.`,
          );
        }
      }
      await this.updateRecord(record.jobId, {
        status: "downloading",
        destPath,
        bytesDone: resumeFromExisting ? latest.bytesDone : 0,
        bytesTotal: latest.bytesTotal,
        error: null,
      });
      if (!this.isCurrentLaunch(record.jobId, controller)) return;
      this.nativeJobs.set(record.jobId, "download");
      await this.bridge.downloadStart({
        jobId: record.jobId,
        url: stream.streamURL,
        destPath,
        resumeFromExisting,
        reserveOutputCopy: latest.mode === "optimized",
      });
      if (!this.isCurrentLaunch(record.jobId, controller)) {
        await this.bridge.downloadForceStop(record.jobId).catch(() => undefined);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const latest = this.recordsByJobId.get(record.jobId);
      if (latest?.status !== "canceled" && latest?.status !== "paused") {
        await this.fail(record.jobId, errorMessage(error));
      }
    }
  }

  private async handleProgress(progress: DownloadProgress): Promise<void> {
    if (this.pausing.has(progress.jobId)) return;
    const record = this.recordsByJobId.get(progress.jobId);
    if (record == null) return;
    if (["paused", "canceled", "completed", "failed"].includes(record.status)) return;
    const measurements = progressMeasurements(progress, record);
    switch (progress.phase) {
      case "downloading":
      case "optimizing": {
        const status = progress.phase;
        this.pendingProgress.set(progress.jobId, progress);
        // A phase change is durable immediately. Repeated byte reports for the
        // same phase are coalesced to one primary-key update per second.
        if (record.status !== status) {
          await this.flushPendingProgress(progress.jobId);
        } else {
          this.scheduleProgressPersistence(progress.jobId);
        }
        return;
      }
      case "failed":
        this.clearPendingProgress(record.jobId);
        await this.fail(
          record.jobId,
          progress.error ?? "The native download failed.",
          measurements,
        );
        return;
      case "canceled":
        this.nativeJobs.delete(record.jobId);
        this.optimizingOutputs.delete(record.jobId);
        this.clearPendingProgress(record.jobId);
        await this.updateRecord(record.jobId, { status: "canceled", ...measurements });
        void this.pump();
        return;
      case "completed":
        this.clearPendingProgress(record.jobId);
        await this.completeNativePhase(record, progress, measurements);
    }
  }

  private async completeNativePhase(
    record: DownloadRecord,
    progress: DownloadProgress,
    measurements: ProgressMeasurements,
  ): Promise<void> {
    if (record.status === "optimizing") {
      const finalPath = progress.outputPath ?? this.optimizingOutputs.get(record.jobId) ?? record.destPath;
      this.nativeJobs.delete(record.jobId);
      this.optimizingOutputs.delete(record.jobId);
      await this.updateRecord(record.jobId, {
        status: "completed",
        destPath: finalPath,
        ...measurements,
        error: null,
      });
      this.clearAutomaticRetry(record.jobId);
      notifyDownloadCompleted(record.title);
      void this.pump();
      return;
    }

    const rawPath = progress.outputPath ?? record.destPath;
    if (record.mode === "full") {
      this.nativeJobs.delete(record.jobId);
      await this.updateRecord(record.jobId, {
        status: "completed",
        destPath: rawPath,
        ...measurements,
        error: null,
      });
      this.clearAutomaticRetry(record.jobId);
      notifyDownloadCompleted(record.title);
      void this.pump();
      return;
    }

    if (rawPath == null || record.optimizeProfile == null) {
      await this.fail(record.jobId, "The downloaded source path is unavailable for optimization.");
      return;
    }
    await this.startOptimization(record, rawPath, measurements, ["downloading"]);
  }

  private async startOptimization(
    record: DownloadRecord,
    rawPath: string,
    measurements: ProgressMeasurements,
    allowedStatuses: DownloadRecord["status"][],
  ): Promise<void> {
    const profile = record.optimizeProfile;
    if (profile == null) {
      await this.fail(record.jobId, "The optimization profile is unavailable.");
      return;
    }
    const current = this.recordsByJobId.get(record.jobId);
    if (current == null || !allowedStatuses.includes(current.status)) return;
    if (!(await this.isFfmpegAvailable())) {
      const latest = this.recordsByJobId.get(record.jobId);
      if (latest != null && allowedStatuses.includes(latest.status)) {
        await this.fail(record.jobId, "FFmpeg is unavailable, so this optimized download cannot run.");
      }
      return;
    }
    const outputPath = optimizedOutputPath(rawPath, profile);
    this.optimizingOutputs.set(record.jobId, outputPath);
    try {
      const updated = await this.updateRecord(
        record.jobId,
        {
          status: "optimizing",
          destPath: rawPath,
          ...measurements,
          error: null,
        },
        allowedStatuses,
      );
      if (updated?.status !== "optimizing") return;
      this.nativeJobs.set(record.jobId, "transcode");
      await this.bridge.transcodeStart({
        jobId: record.jobId,
        inputPath: rawPath,
        outputPath,
        keepAudioLangs: record.keepAudioLangs,
        keepSubLangs: record.keepSubLangs,
        profile,
      });
    } catch (error) {
      const latest = this.recordsByJobId.get(record.jobId);
      if (latest?.status !== "canceled" && latest?.status !== "paused") {
        await this.fail(record.jobId, errorMessage(error));
      }
    }
  }

  private async isFfmpegAvailable(): Promise<boolean> {
    this.ffmpegAvailability ??= this.bridge.downloadsFfmpegAvailable().catch(() => false);
    return this.ffmpegAvailability;
  }

  private async fail(
    jobId: string,
    error: string,
    measurements: ProgressMeasurements = {},
  ): Promise<void> {
    recordDiagnostic("download", "job.failed", "error", error);
    this.nativeJobs.delete(jobId);
    this.optimizingOutputs.delete(jobId);
    this.clearPendingProgress(jobId);
    await this.updateRecord(jobId, {
      status: "failed",
      ...measurements,
      error,
    });
    const retryAttempt = this.scheduleAutomaticRetry(jobId, error);
    if (retryAttempt != null) {
      await this.updateRecord(
        jobId,
        {
          error: `${error} Retrying automatically (attempt ${retryAttempt} of ${MAX_AUTOMATIC_RETRIES}).`,
        },
        ["failed"],
      );
    } else {
      const record = this.recordsByJobId.get(jobId);
      if (record != null) notifyDownloadFailed(record.title);
    }
    void this.pump();
  }

  private scheduleAutomaticRetry(jobId: string, error: string): number | null {
    if (!this.started || !isTransientDownloadFailure(error)) return null;
    const attempts = this.automaticRetryAttempts.get(jobId) ?? 0;
    if (
      attempts >= MAX_AUTOMATIC_RETRIES ||
      this.automaticRetryTimers.has(jobId)
    ) {
      return null;
    }
    const nextAttempt = attempts + 1;
    this.automaticRetryAttempts.set(jobId, nextAttempt);
    const timer = setTimeout(() => {
      this.automaticRetryTimers.delete(jobId);
      void (async () => {
        if (!this.started) return;
        const record = await this.recordForControl(jobId);
        if (record == null || record.status !== "failed") return;
        await this.updateRecord(jobId, {
          status: "queued",
          error: null,
          optimizePercent: null,
        });
        void this.pump();
      })();
    }, AUTOMATIC_RETRY_BASE_DELAY_MS * 2 ** (nextAttempt - 1));
    this.automaticRetryTimers.set(jobId, timer);
    return nextAttempt;
  }

  private clearAutomaticRetry(jobId: string): void {
    const timer = this.automaticRetryTimers.get(jobId);
    if (timer != null) clearTimeout(timer);
    this.automaticRetryTimers.delete(jobId);
    this.automaticRetryAttempts.delete(jobId);
  }

  private syncRecords(records: DownloadRecord[]): boolean {
    const previous = this.recordsByJobId;
    const needsPump =
      previous.size !== records.length ||
      records.some((record) => previous.get(record.jobId)?.status !== record.status);
    this.recordsByJobId = new Map(records.map((record) => [record.jobId, record]));
    this.applyRecords(records);
    return needsPump;
  }

  /**
   * Keep the queue's createdAt ordering from the one Store query. createdAt is
   * immutable after enqueue, so a byte/status update for an existing job can
   * replace just that cached row without another consumer-side sort.
   */
  private applyRecords(records: DownloadRecord[]): void {
    const sameOrder =
      records.length === this.records.length &&
      records.every((record, index) => this.records[index]?.jobId === record.jobId);
    if (!sameOrder) {
      this.records = records;
      this.publishRecords();
      return;
    }

    let next: DownloadRecord[] | null = null;
    records.forEach((record, index) => {
      if (sameDownloadRecord(this.records[index]!, record)) return;
      next ??= [...this.records];
      next[index] = record;
    });
    if (next != null) {
      this.records = next;
      this.publishRecords();
    }
  }

  private patchRecord(record: DownloadRecord): void {
    const index = this.records.findIndex((current) => current.jobId === record.jobId);
    if (index < 0 || sameDownloadRecord(this.records[index]!, record)) return;
    const next = [...this.records];
    next[index] = record;
    this.records = next;
    this.publishRecords();
  }

  private publishRecords(): void {
    this.recordsListeners.forEach((listener) => listener(this.records));
  }

  private async recordForControl(jobId: string): Promise<DownloadRecord | null> {
    const stored = (await this.store.listDownloads()).find((record) => record.jobId === jobId);
    if (stored != null) {
      this.recordsByJobId.set(jobId, stored);
      return stored;
    }
    return this.recordsByJobId.get(jobId) ?? null;
  }

  private isCurrentLaunch(jobId: string, controller: AbortController): boolean {
    return (
      this.started &&
      !controller.signal.aborted &&
      this.launches.get(jobId) === controller
    );
  }

  private updateRecord(
    jobId: string,
    changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
    allowedStatuses?: DownloadRecord["status"][],
  ): Promise<DownloadRecord | null> {
    const previous = this.recordUpdateTails.get(jobId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const current = this.recordsByJobId.get(jobId);
      if (
        allowedStatuses != null &&
        (current == null || !allowedStatuses.includes(current.status))
      ) {
        return current ?? null;
      }
      if (current != null) {
        const next = {
          ...current,
          ...changes,
          jobId,
          createdAt: current.createdAt,
        };
        this.recordsByJobId.set(jobId, next);
        this.patchRecord(next);
      }
      const saved = await this.store.updateDownload(jobId, changes);
      if (saved != null) {
        this.recordsByJobId.set(jobId, saved);
        this.patchRecord(saved);
      }
      return saved;
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.recordUpdateTails.set(jobId, tail);
    void tail.finally(() => {
      if (this.recordUpdateTails.get(jobId) === tail) {
        this.recordUpdateTails.delete(jobId);
      }
    });
    return operation;
  }

  private scheduleProgressPersistence(jobId: string): void {
    if (this.progressTimers.has(jobId)) return;
    const elapsed = Date.now() - (this.lastProgressPersistedAt.get(jobId) ?? 0);
    const delay = Math.max(0, PROGRESS_PERSIST_INTERVAL_MS - elapsed);
    const timer = setTimeout(() => {
      this.progressTimers.delete(jobId);
      void this.flushPendingProgress(jobId);
    }, delay);
    this.progressTimers.set(jobId, timer);
  }

  private async flushPendingProgress(jobId: string): Promise<void> {
    const timer = this.progressTimers.get(jobId);
    if (timer != null) clearTimeout(timer);
    this.progressTimers.delete(jobId);
    const progress = this.pendingProgress.get(jobId);
    this.pendingProgress.delete(jobId);
    const record = this.recordsByJobId.get(jobId);
    if (progress == null || record == null) return;
    if (["paused", "canceled", "completed", "failed"].includes(record.status)) return;
    if (progress.phase !== "downloading" && progress.phase !== "optimizing") return;
    this.lastProgressPersistedAt.set(jobId, Date.now());
    await this.updateRecord(
      jobId,
      {
        status: progress.phase,
        ...progressMeasurements(progress, record),
      },
      ["downloading", "optimizing"],
    );
  }

  private clearPendingProgress(jobId: string): void {
    const timer = this.progressTimers.get(jobId);
    if (timer != null) clearTimeout(timer);
    this.progressTimers.delete(jobId);
    this.pendingProgress.delete(jobId);
    this.lastProgressPersistedAt.delete(jobId);
  }

  private publishProgress(progress: DownloadProgress): void {
    this.pendingProgressNotifications.set(progress.jobId, progress);
    const terminal = ["completed", "failed", "canceled"].includes(progress.phase);
    const lastNotified = this.lastProgressNotifiedAt.get(progress.jobId);
    const elapsed = Date.now() - (lastNotified ?? 0);
    if (terminal || lastNotified == null || elapsed >= PROGRESS_UI_INTERVAL_MS) {
      this.flushProgressNotification(progress.jobId);
      return;
    }
    if (this.progressNotificationTimers.has(progress.jobId)) return;
    const timer = setTimeout(() => {
      this.progressNotificationTimers.delete(progress.jobId);
      this.flushProgressNotification(progress.jobId);
    }, Math.max(0, PROGRESS_UI_INTERVAL_MS - elapsed));
    this.progressNotificationTimers.set(progress.jobId, timer);
  }

  private flushProgressNotification(jobId: string): void {
    const timer = this.progressNotificationTimers.get(jobId);
    if (timer != null) clearTimeout(timer);
    this.progressNotificationTimers.delete(jobId);
    const progress = this.pendingProgressNotifications.get(jobId);
    this.pendingProgressNotifications.delete(jobId);
    if (progress == null) return;
    this.lastProgressNotifiedAt.set(jobId, Date.now());
    this.progressListeners.forEach((listener) => listener(progress));
  }
}

function sameDownloadRecord(a: DownloadRecord, b: DownloadRecord): boolean {
  return (
    a.jobId === b.jobId &&
    a.mediaId === b.mediaId &&
    a.episodeId === b.episodeId &&
    a.title === b.title &&
    a.season === b.season &&
    a.episode === b.episode &&
    a.infoHash === b.infoHash &&
    a.fileHint === b.fileHint &&
    (a.fileIndex ?? null) === (b.fileIndex ?? null) &&
    (a.fileNameHint ?? null) === (b.fileNameHint ?? null) &&
    a.mode === b.mode &&
    a.optimizeProfile === b.optimizeProfile &&
    a.status === b.status &&
    a.bytesDone === b.bytesDone &&
    a.bytesTotal === b.bytesTotal &&
    a.optimizePercent === b.optimizePercent &&
    a.destPath === b.destPath &&
    a.error === b.error &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.keepAudioLangs.length === b.keepAudioLangs.length &&
    a.keepAudioLangs.every((lang, index) => lang === b.keepAudioLangs[index]) &&
    a.keepSubLangs.length === b.keepSubLangs.length &&
    a.keepSubLangs.every((lang, index) => lang === b.keepSubLangs[index])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
