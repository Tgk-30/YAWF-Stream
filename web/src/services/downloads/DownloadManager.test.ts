import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadsBridge, DownloadProgress } from "../../lib/downloadsBridge";
import type { DownloadRecord } from "../../storage/models";
import type { Store } from "../../storage/types";
import {
  DownloadManager,
  enqueueSeasonDownloads,
  makeDownloadRecord,
  type DownloadDebridResolver,
} from "./DownloadManager";

class DownloadStore {
  records = new Map<string, DownloadRecord>();
  listeners = new Set<(records: DownloadRecord[]) => void>();
  history: DownloadRecord["status"][] = [];
  updateCalls = 0;
  listCalls = 0;
  queryExecutions = 0;
  beforeUpdate: (
    changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
  ) => Promise<void> = async () => {};

  async getSetting(key: string): Promise<string | null> {
    return key === "downloads_directory" ? "/Downloads" : null;
  }
  async setSetting(): Promise<void> {}
  async saveDownload(record: DownloadRecord): Promise<void> {
    this.records.set(record.jobId, record);
    this.history.push(record.status);
    this.notify();
  }
  async updateDownload(
    jobId: string,
    changes: Partial<Omit<DownloadRecord, "jobId" | "createdAt">>,
  ): Promise<DownloadRecord | null> {
    this.updateCalls += 1;
    await this.beforeUpdate(changes);
    const current = this.records.get(jobId);
    if (current == null) return null;
    const next = { ...current, ...changes, jobId, createdAt: current.createdAt };
    this.records.set(jobId, next);
    this.history.push(next.status);
    this.notify();
    return next;
  }
  async deleteDownload(jobId: string): Promise<void> {
    this.records.delete(jobId);
    this.notify();
  }
  async listDownloads(): Promise<DownloadRecord[]> {
    this.listCalls += 1;
    return [...this.records.values()];
  }
  subscribeDownloads(listener: (records: DownloadRecord[]) => void): () => void {
    this.listeners.add(listener);
    this.runQueueQuery(listener);
    return () => this.listeners.delete(listener);
  }
  private notify() {
    this.listeners.forEach((listener) => this.runQueueQuery(listener));
  }
  private runQueueQuery(listener: (records: DownloadRecord[]) => void) {
    this.queryExecutions += 1;
    listener(
      [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }
}

function makeBridge() {
  let emit: ((progress: DownloadProgress) => void) | null = null;
  const running = new Set<string>();
  const bridge: DownloadsBridge = {
    downloadStart: vi.fn(async (args) => {
      running.add(args.jobId);
    }),
    downloadPause: vi.fn(async (jobId) => {
      running.delete(jobId);
    }),
    downloadResume: vi.fn(async (jobId) => {
      running.add(jobId);
    }),
    downloadCancel: vi.fn(async (jobId) => {
      running.delete(jobId);
    }),
    downloadForceStop: vi.fn(async (jobId) => {
      running.delete(jobId);
    }),
    transcodeStart: vi.fn(async (args) => {
      running.add(args.jobId);
    }),
    transcodeCancel: vi.fn(async (jobId) => {
      running.delete(jobId);
    }),
    downloadsFfmpegAvailable: vi.fn(async () => true),
    downloadsDefaultDir: vi.fn(async () => "/Downloads"),
    downloadsAvailableSpace: vi.fn(async () => Number.MAX_SAFE_INTEGER),
    downloadDeleteFile: vi.fn(async () => {}),
    listenDownloadProgress: vi.fn(async (callback) => {
      emit = callback;
      return () => {
        emit = null;
      };
    }),
  };
  return {
    bridge,
    running,
    emit(progress: DownloadProgress) {
      emit?.(progress);
    },
  };
}

function resolver(): DownloadDebridResolver {
  return {
    resolveStream: vi.fn(async () => ({
      streamURL: "https://cdn.example/file",
      fileName: "movie.mp4",
    })),
  };
}

async function status(store: DownloadStore, jobId: string): Promise<DownloadRecord["status"]> {
  return (await store.listDownloads()).find((record) => record.jobId === jobId)!.status;
}

async function waitUntil(assertion: () => Promise<void>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("makeDownloadRecord", () => {
  it("seeds a positive picked source size and rejects unknown or invalid totals", () => {
    const input = {
      jobId: "seeded-size",
      mediaId: "m",
      title: "Sized",
      infoHash: "hash",
      mode: "full" as const,
    };

    expect(makeDownloadRecord({ ...input, sizeBytes: 8_000_000_000 }).bytesTotal).toBe(
      8_000_000_000,
    );
    for (const sizeBytes of [0, -1, null, undefined]) {
      expect(makeDownloadRecord({ ...input, sizeBytes }).bytesTotal).toBeNull();
    }
  });
});

describe("DownloadManager", () => {
  const managers: DownloadManager[] = [];
  afterEach(() => {
    managers.splice(0).forEach((manager) => manager.stop());
    vi.useRealTimers();
  });

  it("shares one queue query with two consumers and patches progress in createdAt order", async () => {
    const store = new DownloadStore();
    const older = {
      ...makeDownloadRecord(
        { jobId: "older", mediaId: "m1", title: "Older", infoHash: "a", mode: "full" },
        "2026-01-01T00:00:00.000Z",
      ),
      status: "paused" as const,
    };
    const newer = {
      ...makeDownloadRecord(
        { jobId: "newer", mediaId: "m2", title: "Newer", infoHash: "b", mode: "full" },
        "2026-01-02T00:00:00.000Z",
      ),
      status: "paused" as const,
    };
    await store.saveDownload(older);
    await store.saveDownload(newer);
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: makeBridge().bridge,
    });
    managers.push(manager);
    await manager.start();

    const firstConsumer = vi.fn();
    const secondConsumer = vi.fn();
    const unlistenFirst = manager.subscribeRecords(firstConsumer);
    const unlistenSecond = manager.subscribeRecords(secondConsumer);
    firstConsumer.mockClear();
    secondConsumer.mockClear();
    store.queryExecutions = 0;

    await store.updateDownload("newer", { bytesDone: 50 });

    expect(store.queryExecutions).toBe(1);
    expect(firstConsumer).toHaveBeenCalledTimes(1);
    expect(secondConsumer).toHaveBeenCalledTimes(1);
    expect(firstConsumer.mock.calls[0]![0].map((row: DownloadRecord) => row.jobId)).toEqual([
      "newer",
      "older",
    ]);
    expect(firstConsumer.mock.calls[0]![0][0]).toMatchObject({ bytesDone: 50 });

    store.queryExecutions = 0;
    await store.saveDownload({
      ...makeDownloadRecord(
        { jobId: "added", mediaId: "m3", title: "Added", infoHash: "c", mode: "full" },
        "2026-01-03T00:00:00.000Z",
      ),
      status: "paused",
    });
    expect(store.queryExecutions).toBe(1);

    store.queryExecutions = 0;
    await store.deleteDownload("added");
    expect(store.queryExecutions).toBe(1);
    unlistenFirst();
    unlistenSecond();
  });

  it("moves an optimized job through queued, resolving, downloading, optimizing, and completed", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "optimized",
      mediaId: "tmdb-1",
      title: "Movie (2024)",
      infoHash: "abc",
      mode: "optimized",
      optimizeProfile: "remux",
    });

    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect(native.bridge.downloadStart).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: record.jobId,
        reserveOutputCopy: true,
      }),
    );
    native.emit({ jobId: record.jobId, phase: "downloading", bytesDone: 20, bytesTotal: 100 });
    native.emit({ jobId: record.jobId, phase: "completed", bytesDone: 100, bytesTotal: 100 });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("optimizing"));
    expect(native.bridge.transcodeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: record.jobId,
        inputPath: "/Downloads/Movie (2024)/Movie (2024).source.mp4",
        outputPath: "/Downloads/Movie (2024)/Movie (2024).mkv",
      }),
    );
    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 100,
      bytesTotal: 100,
      outputPath: "/Downloads/Movie (2024)/Movie (2024).mkv",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("completed"));
    expect(store.history).toEqual(expect.arrayContaining(["queued", "resolving", "downloading", "optimizing", "completed"]));
  });

  it("forwards a durable exact file selector when resolving a download", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const debrid = resolver();
    const manager = new DownloadManager(store as unknown as Store, debrid, {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "selected-file",
      mediaId: "tmdb-files",
      title: "Requested Small",
      infoHash: "collection",
      fileIndex: 1,
      fileNameHint: "Show.S02E07.Small.mp4",
      season: 2,
      episode: 7,
      mode: "full",
    });

    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect(debrid.resolveStream).toHaveBeenCalledWith("collection", null, {
      fileIndex: 1,
      fileName: "Show.S02E07.Small.mp4",
      season: 2,
      episode: 7,
    });
    expect(await store.listDownloads()).toEqual([
      expect.objectContaining({ fileIndex: 1, fileNameHint: "Show.S02E07.Small.mp4" }),
    ]);
  });

  it("stores transcode percent without overwriting downloaded byte counters", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "optimized-progress",
      mediaId: "m",
      title: "Optimized Progress",
      infoHash: "hash",
      mode: "optimized",
      optimizeProfile: "remux",
      sizeBytes: 8_000_000_000,
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 8_000_000_000,
      bytesTotal: 8_000_000_000,
      outputPath: "/Downloads/Optimized Progress/Optimized Progress.source.mp4",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("optimizing"));

    native.emit({
      jobId: record.jobId,
      phase: "optimizing",
      bytesDone: 0,
      bytesTotal: null,
      percent: 42,
    });

    await waitUntil(async () => {
      expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)).toEqual(
        expect.objectContaining({
          bytesDone: 8_000_000_000,
          bytesTotal: 8_000_000_000,
          optimizePercent: 42,
        }),
      );
    });
  });

  it("completes a transcode without overwriting downloaded byte counters", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "optimized-completion",
      mediaId: "m",
      title: "Optimized Completion",
      infoHash: "hash",
      mode: "optimized",
      optimizeProfile: "remux",
      sizeBytes: 8_000_000_000,
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 8_000_000_000,
      bytesTotal: 8_000_000_000,
      outputPath: "/Downloads/Optimized Completion/Optimized Completion.source.mp4",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("optimizing"));

    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 0,
      bytesTotal: null,
      percent: 100,
      outputPath: "/Downloads/Optimized Completion/Optimized Completion.mkv",
    });

    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("completed"));
    expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)).toEqual(
      expect.objectContaining({
        status: "completed",
        bytesDone: 8_000_000_000,
        bytesTotal: 8_000_000_000,
        optimizePercent: 100,
      }),
    );
  });

  it("pauses and resumes the transcode phase instead of resuming the HTTP download", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "optimized-controls",
      mediaId: "m",
      title: "Optimized Controls",
      infoHash: "hash",
      mode: "optimized",
      optimizeProfile: "remux",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 100,
      bytesTotal: 100,
      outputPath: "/Downloads/Optimized Controls/Optimized Controls.source.mp4",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("optimizing"));

    await manager.pause(record.jobId);
    expect(await status(store, record.jobId)).toBe("paused");
    expect(native.bridge.transcodeCancel).toHaveBeenCalledWith(record.jobId);
    native.emit({ jobId: record.jobId, phase: "canceled", bytesDone: 25, bytesTotal: 100 });
    await Promise.resolve();
    expect(await status(store, record.jobId)).toBe("paused");

    await manager.resume(record.jobId);
    expect(await status(store, record.jobId)).toBe("optimizing");
    expect(native.bridge.transcodeStart).toHaveBeenCalledTimes(2);
    expect(native.bridge.downloadResume).not.toHaveBeenCalledWith(record.jobId);
  });

  it("does not launch queued work before the native progress listener is attached", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    let releaseListener!: () => void;
    const listenerReady = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const attachListener = native.bridge.listenDownloadProgress;
    native.bridge.listenDownloadProgress = vi.fn(async (callback) => {
      await listenerReady;
      return attachListener(callback);
    });
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    const starting = manager.start();
    const record = await manager.enqueue({
      jobId: "listener-first",
      mediaId: "m",
      title: "Listener First",
      infoHash: "hash",
      mode: "full",
    });
    await waitUntil(async () => {
      expect(native.bridge.listenDownloadProgress).toHaveBeenCalledOnce();
    });
    expect(native.bridge.downloadStart).not.toHaveBeenCalled();

    releaseListener();
    await starting;
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect(native.bridge.downloadStart).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: record.jobId }),
    );
  });

  it("leaves work queued when progress listening fails and starts it after a retry", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const attachListener = native.bridge.listenDownloadProgress;
    native.bridge.listenDownloadProgress = vi
      .fn<DownloadsBridge["listenDownloadProgress"]>()
      .mockRejectedValueOnce(new Error("event bus unavailable"))
      .mockImplementation(attachListener);
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "listener-retry",
      mediaId: "m",
      title: "Listener Retry",
      infoHash: "hash",
      mode: "full",
    });
    await Promise.resolve();
    expect(await status(store, record.jobId)).toBe("queued");
    expect(native.bridge.downloadStart).not.toHaveBeenCalled();

    await manager.start();
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect(native.bridge.downloadStart).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: record.jobId }),
    );
  });

  it("persists failed, paused, resumed, and canceled states without inventing completion", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const badResolver: DownloadDebridResolver = {
      resolveStream: vi.fn(async () => {
        throw new Error("expired link");
      }),
    };
    const failed = new DownloadManager(store as unknown as Store, badResolver, { bridge: native.bridge });
    managers.push(failed);
    await failed.start();
    const failedRecord = await failed.enqueue({ jobId: "failed", mediaId: "m", title: "Bad", infoHash: "x", mode: "full" });
    await waitUntil(() => expect(status(store, failedRecord.jobId)).resolves.toBe("failed"));

    failed.stop();
    const working = new DownloadManager(store as unknown as Store, resolver(), { bridge: native.bridge });
    managers.push(working);
    await working.start();
    const record = await working.enqueue({ jobId: "controls", mediaId: "m", title: "Good", infoHash: "y", mode: "full" });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    await working.pause(record.jobId);
    expect(await status(store, record.jobId)).toBe("paused");
    expect(native.bridge.downloadPause).toHaveBeenCalledWith(record.jobId);
    await working.resume(record.jobId);
    expect(await status(store, record.jobId)).toBe("downloading");
    expect(native.bridge.downloadResume).toHaveBeenCalledWith(record.jobId);
    await working.cancel(record.jobId);
    expect(await status(store, record.jobId)).toBe("canceled");
    expect(native.bridge.downloadCancel).toHaveBeenCalledWith(record.jobId);
    expect(native.running.has(record.jobId)).toBe(false);
  });

  it("force-stops a resolver that never settles and immediately opens the queue slot", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const resolveStream = vi
      .fn<DownloadDebridResolver["resolveStream"]>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({
        streamURL: "https://cdn.example/next",
        fileName: "next.mp4",
      });
    const manager = new DownloadManager(
      store as unknown as Store,
      { resolveStream },
      { bridge: native.bridge, concurrency: 1 },
    );
    managers.push(manager);
    await manager.start();
    const stuck = await manager.enqueue({
      jobId: "stuck-resolver",
      mediaId: "m1",
      title: "Stuck",
      infoHash: "stuck",
      mode: "full",
    });
    await waitUntil(() => expect(status(store, stuck.jobId)).resolves.toBe("resolving"));

    await manager.forceStop(stuck.jobId);
    expect(await status(store, stuck.jobId)).toBe("canceled");
    expect(native.bridge.downloadForceStop).toHaveBeenCalledWith(stuck.jobId);
    expect(native.bridge.downloadStart).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: stuck.jobId }),
    );

    const next = await manager.enqueue({
      jobId: "after-stuck",
      mediaId: "m2",
      title: "Next",
      infoHash: "next",
      mode: "full",
    });
    await waitUntil(() => expect(status(store, next.jobId)).resolves.toBe("downloading"));
    expect(native.running.has(next.jobId)).toBe(true);
  });

  it("force-stops an active native transfer before marking its row canceled", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "active-force-stop",
      mediaId: "m",
      title: "Active",
      infoHash: "hash",
      mode: "full",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect(native.running.has(record.jobId)).toBe(true);

    await manager.forceStop(record.jobId);
    expect(native.bridge.downloadForceStop).toHaveBeenCalledWith(record.jobId);
    expect(native.running.has(record.jobId)).toBe(false);
    expect(await status(store, record.jobId)).toBe("canceled");
  });

  it("force-stops a queued row even before the manager cache is primed", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    const record = await manager.enqueue({
      jobId: "uncached-queued",
      mediaId: "m",
      title: "Uncached",
      infoHash: "hash",
      mode: "full",
    });

    await manager.forceStop(record.jobId);
    expect(await status(store, record.jobId)).toBe("canceled");
    expect(native.bridge.downloadForceStop).toHaveBeenCalledWith(record.jobId);
    expect(native.bridge.downloadStart).not.toHaveBeenCalled();
  });

  it("keeps a terminal completion newer than an already-running progress write", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "terminal-order",
      mediaId: "m",
      title: "Ordered",
      infoHash: "hash",
      mode: "full",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));

    let releaseProgress!: () => void;
    const progressReleased = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let markProgressBlocked!: () => void;
    const progressBlocked = new Promise<void>((resolve) => {
      markProgressBlocked = resolve;
    });
    store.beforeUpdate = async (changes) => {
      if (changes.status === "downloading" && changes.bytesDone === 50) {
        markProgressBlocked();
        await progressReleased;
      }
    };

    native.emit({
      jobId: record.jobId,
      phase: "downloading",
      bytesDone: 50,
      bytesTotal: 100,
    });
    await progressBlocked;
    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 100,
      bytesTotal: 100,
      outputPath: "/Downloads/Ordered/Ordered.mp4",
    });
    releaseProgress();

    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("completed"));
    expect((await store.listDownloads())[0]).toEqual(
      expect.objectContaining({ status: "completed", bytesDone: 100 }),
    );
  });

  it("recovers interrupted native phases as paused after an app restart", async () => {
    const store = new DownloadStore();
    await store.saveDownload({
      jobId: "restart",
      mediaId: "m",
      episodeId: null,
      title: "Interrupted",
      season: null,
      episode: null,
      infoHash: "hash",
      fileHint: null,
      mode: "full",
      optimizeProfile: null,
      keepAudioLangs: [],
      keepSubLangs: [],
      status: "downloading",
      bytesDone: 12,
      bytesTotal: 100,
      optimizePercent: null,
      destPath: "/Downloads/Interrupted.mp4",
      error: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: makeBridge().bridge,
    });
    managers.push(manager);
    await manager.start();
    expect(await status(store, "restart")).toBe("paused");
  });

  it("resumes a durable partial file after an app restart", async () => {
    const store = new DownloadStore();
    await store.saveDownload({
      ...makeDownloadRecord({
        jobId: "restart-resume",
        mediaId: "m",
        title: "Interrupted",
        infoHash: "hash",
        mode: "full",
        sizeBytes: 100,
      }),
      status: "paused",
      bytesDone: 12,
      destPath: "/Downloads/Interrupted.mp4",
    });
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    await manager.resume("restart-resume");

    await waitUntil(async () => {
      expect(native.bridge.downloadStart).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "restart-resume",
          destPath: "/Downloads/Interrupted.mp4",
          resumeFromExisting: true,
        }),
      );
    });
    expect(await status(store, "restart-resume")).toBe("downloading");
  });

  it("fails before transfer when the destination lacks working space", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    vi.mocked(native.bridge.downloadsAvailableSpace!).mockResolvedValue(1);
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "no-space",
      mediaId: "m",
      title: "Large",
      infoHash: "hash",
      mode: "full",
      sizeBytes: 1_000_000_000,
    });

    await waitUntil(async () => {
      expect(await status(store, record.jobId)).toBe("failed");
    });
    expect(native.bridge.downloadStart).not.toHaveBeenCalled();
    expect((await store.listDownloads())[0]?.error).toContain(
      "Not enough free disk space",
    );
  });

  it("persists terminal bytes so an immediate failure can resume the partial file", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "partial-failure",
      mediaId: "m",
      title: "Partial",
      infoHash: "hash",
      mode: "full",
      sizeBytes: 100,
    });
    await waitUntil(async () => {
      expect(await status(store, record.jobId)).toBe("downloading");
    });
    native.emit({
      jobId: record.jobId,
      phase: "failed",
      bytesDone: 17,
      bytesTotal: 100,
      error: "Disk full",
    });
    await waitUntil(async () => {
      const saved = (await store.listDownloads()).find(
        (item) => item.jobId === record.jobId,
      );
      expect(saved).toMatchObject({ status: "failed", bytesDone: 17 });
    });
  });

  it("automatically retries transient failures twice with bounded backoff", async () => {
    vi.useFakeTimers();
    const store = new DownloadStore();
    const native = makeBridge();
    const resolveStream = vi
      .fn<DownloadDebridResolver["resolveStream"]>()
      .mockRejectedValue(new Error("network timeout"));
    const manager = new DownloadManager(
      store as unknown as Store,
      { resolveStream },
      { bridge: native.bridge },
    );
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "automatic-retry",
      mediaId: "m",
      title: "Automatic retry",
      infoHash: "hash",
      mode: "full",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolveStream).toHaveBeenCalledTimes(1);
    expect(await status(store, record.jobId)).toBe("failed");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(resolveStream).toHaveBeenCalledTimes(2);
    expect(await status(store, record.jobId)).toBe("failed");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(resolveStream).toHaveBeenCalledTimes(3);
    expect(await status(store, record.jobId)).toBe("failed");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolveStream).toHaveBeenCalledTimes(3);
  });

  it("retries a failed record and deletes a completed file on request", async () => {
    const store = new DownloadStore();
    await store.saveDownload({
      ...makeDownloadRecord({
        jobId: "retry",
        mediaId: "m",
        title: "Retry",
        infoHash: "hash",
        mode: "full",
      }),
      status: "failed",
      error: "Network failed",
    });
    await store.saveDownload({
      ...makeDownloadRecord({
        jobId: "delete",
        mediaId: "m2",
        title: "Delete",
        infoHash: "hash2",
        mode: "full",
      }),
      status: "completed",
      destPath: "/Downloads/Delete.mp4",
    });
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();

    await manager.retry("retry");
    await waitUntil(async () => {
      expect(native.bridge.downloadStart).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "retry" }),
      );
    });
    await manager.deleteCompletedFile("delete");
    expect(native.bridge.downloadDeleteFile).toHaveBeenCalledWith(
      "/Downloads/Delete.mp4",
    );
    expect((await store.listDownloads()).some((record) => record.jobId === "delete")).toBe(
      false,
    );
  });

  it("force-stops a failed durable job and deletes its orphaned partial file", async () => {
    const store = new DownloadStore();
    await store.saveDownload({
      ...makeDownloadRecord({
        jobId: "orphaned-partial",
        mediaId: "m",
        title: "Orphaned partial",
        infoHash: "hash",
        mode: "full",
      }),
      status: "failed",
      bytesDone: 42,
      destPath: "/Downloads/Orphaned.partial.mkv",
      error: "Network failed",
    });
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();

    await manager.forceStop("orphaned-partial");

    expect(native.bridge.downloadForceStop).toHaveBeenCalledWith("orphaned-partial");
    expect(native.bridge.downloadDeleteFile).toHaveBeenCalledWith(
      "/Downloads/Orphaned.partial.mkv",
    );
    expect(await status(store, "orphaned-partial")).toBe("canceled");
  });

  it("coalesces byte persistence while keeping the live UI fed between writes", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "rapid-progress",
      mediaId: "m",
      title: "Rapid",
      infoHash: "hash",
      mode: "full",
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));

    const liveProgress = vi.fn();
    manager.subscribeProgress(liveProgress);
    store.updateCalls = 0;
    store.listCalls = 0;
    vi.useFakeTimers();

    for (let bytesDone = 1; bytesDone <= 20; bytesDone += 1) {
      native.emit({ jobId: record.jobId, phase: "downloading", bytesDone, bytesTotal: 100 });
    }
    // The first value is immediate; the latest burst value is delivered at
    // 1Hz, independently of the 1Hz durable write cadence.
    expect(liveProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(liveProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(liveProgress).toHaveBeenCalledTimes(2);
    expect(liveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ bytesDone: 20 }),
    );
    expect(store.updateCalls).toBe(1);
    // The queue subscription sees the persisted byte values, but because the
    // status has not changed it does not call pump() for another full-table read.
    expect(store.listCalls).toBe(0);
    expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)?.bytesDone).toBe(20);

    store.listCalls = 0;
    for (let bytesDone = 21; bytesDone <= 40; bytesDone += 1) {
      native.emit({ jobId: record.jobId, phase: "downloading", bytesDone, bytesTotal: 100 });
    }
    expect(liveProgress).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(liveProgress).toHaveBeenCalledTimes(2);
    expect(store.updateCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(liveProgress).toHaveBeenCalledTimes(3);
    expect(liveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ bytesDone: 40 }),
    );
    expect(store.updateCalls).toBe(2);
    expect(store.listCalls).toBe(0);
    expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)?.bytesDone).toBe(40);
  });

  it("keeps a seeded total when a progress tick lacks Content-Length", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "seeded-progress",
      mediaId: "m",
      title: "Seeded Progress",
      infoHash: "hash",
      mode: "full",
      sizeBytes: 8_000_000_000,
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));
    expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)?.bytesTotal).toBe(
      8_000_000_000,
    );

    native.emit({
      jobId: record.jobId,
      phase: "downloading",
      bytesDone: 1_000_000,
      bytesTotal: null,
    });

    await waitUntil(async () => {
      expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)).toEqual(
        expect.objectContaining({ bytesDone: 1_000_000, bytesTotal: 8_000_000_000 }),
      );
    });
  });

  it("keeps a seeded total when completion lacks Content-Length", async () => {
    const store = new DownloadStore();
    const native = makeBridge();
    const manager = new DownloadManager(store as unknown as Store, resolver(), {
      bridge: native.bridge,
    });
    managers.push(manager);
    await manager.start();
    const record = await manager.enqueue({
      jobId: "seeded-completion",
      mediaId: "m",
      title: "Seeded Completion",
      infoHash: "hash",
      mode: "full",
      sizeBytes: 8_000_000_000,
    });
    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("downloading"));

    native.emit({
      jobId: record.jobId,
      phase: "completed",
      bytesDone: 8_000_000_000,
      bytesTotal: null,
      outputPath: "/Downloads/Seeded Completion/Seeded Completion.mp4",
    });

    await waitUntil(() => expect(status(store, record.jobId)).resolves.toBe("completed"));
    expect((await store.listDownloads()).find((row) => row.jobId === record.jobId)?.bytesTotal).toBe(
      8_000_000_000,
    );
  });

  it("enqueues every supplied season episode as an independent durable record", async () => {
    const store = new DownloadStore();
    const records = await enqueueSeasonDownloads(store as unknown as Store, [
      { jobId: "s1e1", mediaId: "show", episodeId: "s1e1", title: "Show S01E01", season: 1, episode: 1, infoHash: "a", mode: "full" },
      { jobId: "s1e2", mediaId: "show", episodeId: "s1e2", title: "Show S01E02", season: 1, episode: 2, infoHash: "b", mode: "full" },
      { jobId: "s1e3", mediaId: "show", episodeId: "s1e3", title: "Show S01E03", season: 1, episode: 3, infoHash: "c", mode: "full" },
    ]);
    expect(records).toHaveLength(3);
    expect((await store.listDownloads()).map((record) => record.episodeId)).toEqual(["s1e1", "s1e2", "s1e3"]);
    expect(records.every((record) => record.status === "queued")).toBe(true);
  });
});
