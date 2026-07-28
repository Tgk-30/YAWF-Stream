import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  downloadStart,
  downloadPause,
  downloadResume,
  downloadCancel,
  downloadForceStop,
  transcodeStart,
  transcodeCancel,
  downloadsFfmpegAvailable,
  downloadsDefaultDir,
  listenDownloadProgress,
} = vi.hoisted(() => ({
  downloadStart: vi.fn(),
  downloadPause: vi.fn(),
  downloadResume: vi.fn(),
  downloadCancel: vi.fn(),
  downloadForceStop: vi.fn(),
  transcodeStart: vi.fn(),
  transcodeCancel: vi.fn(),
  downloadsFfmpegAvailable: vi.fn(),
  downloadsDefaultDir: vi.fn(),
  listenDownloadProgress: vi.fn(),
}));

vi.mock("./tauri", () => ({
  downloadStart,
  downloadPause,
  downloadResume,
  downloadCancel,
  downloadForceStop,
  transcodeStart,
  transcodeCancel,
  downloadsFfmpegAvailable,
  downloadsDefaultDir,
  listenDownloadProgress,
}));

import {
  __setDownloadsBridgeForTesting,
  getDownloadsBridge,
} from "./downloadsBridge";

describe("downloadsBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setDownloadsBridgeForTesting(null);
    downloadsFfmpegAvailable.mockResolvedValue(false);
    downloadsDefaultDir.mockResolvedValue("/tmp/downloads");
  });

  it("forwards all native bridge calls", async () => {
    const bridge = getDownloadsBridge();
    await bridge.downloadStart({
      jobId: "job-1",
      url: "https://example/mkv",
      headers: { Authorization: "token" },
      destPath: "/tmp/out",
    });
    await bridge.downloadPause("job-1");
    await bridge.downloadResume("job-1");
    await bridge.downloadCancel("job-1");
    await bridge.downloadForceStop("job-1");
    await bridge.transcodeStart({
      jobId: "job-1",
      inputPath: "/tmp/in.mkv",
      outputPath: "/tmp/out.mp4",
      keepAudioLangs: ["eng"],
      keepSubLangs: ["jpn"],
      profile: "remux",
    });
    await bridge.transcodeCancel("job-1");

    const unlisten = vi.fn();
    listenDownloadProgress.mockResolvedValue(unlisten);
    const stop = await bridge.listenDownloadProgress(() => {});
    stop();

    expect(downloadStart).toHaveBeenCalledWith({
      jobId: "job-1",
      url: "https://example/mkv",
      headers: { Authorization: "token" },
      destPath: "/tmp/out",
    });
    expect(downloadPause).toHaveBeenCalledWith("job-1");
    expect(downloadResume).toHaveBeenCalledWith("job-1");
    expect(downloadCancel).toHaveBeenCalledWith("job-1");
    expect(downloadForceStop).toHaveBeenCalledWith("job-1");
    expect(transcodeStart).toHaveBeenCalledWith({
      jobId: "job-1",
      inputPath: "/tmp/in.mkv",
      outputPath: "/tmp/out.mp4",
      keepAudioLangs: ["eng"],
      keepSubLangs: ["jpn"],
      profile: "remux",
    });
    expect(transcodeCancel).toHaveBeenCalledWith("job-1");
    expect(listenDownloadProgress).toHaveBeenCalledWith(expect.any(Function));
    expect(stop).toBe(unlisten);
  });

  it("allows swapping and restoring the active bridge for tests", async () => {
    const customListen = vi.fn();
    const customBridge = {
      downloadStart: vi.fn().mockResolvedValue(undefined),
      downloadPause: vi.fn().mockResolvedValue(undefined),
      downloadResume: vi.fn().mockResolvedValue(undefined),
      downloadCancel: vi.fn().mockResolvedValue(undefined),
      downloadForceStop: vi.fn().mockResolvedValue(undefined),
      transcodeStart: vi.fn().mockResolvedValue(undefined),
      transcodeCancel: vi.fn().mockResolvedValue(undefined),
      downloadsFfmpegAvailable: vi.fn().mockResolvedValue(true),
      downloadsDefaultDir: vi.fn().mockResolvedValue("/mock/downloads"),
      listenDownloadProgress: vi.fn().mockResolvedValue(customListen),
    };

    __setDownloadsBridgeForTesting(customBridge);
    const switched = getDownloadsBridge();

    await switched.downloadPause("job-2");
    const bridgeStop = await switched.listenDownloadProgress(() => {});

    expect(switched).toBe(customBridge);
    expect(customBridge.downloadPause).toHaveBeenCalledWith("job-2");
    expect(customBridge.listenDownloadProgress).toHaveBeenCalledWith(expect.any(Function));
    expect(bridgeStop).toBe(customListen);

    __setDownloadsBridgeForTesting(null);
    const restored = getDownloadsBridge();
    await restored.downloadsFfmpegAvailable();

    expect(restored).not.toBe(customBridge);
    expect(downloadsFfmpegAvailable).toHaveBeenCalledWith();
  });

  it("forwards capability checks on both the active and restored bridge", async () => {
    const bridge = getDownloadsBridge();
    await bridge.downloadsFfmpegAvailable();
    await bridge.downloadsDefaultDir();

    expect(downloadsFfmpegAvailable).toHaveBeenCalledTimes(1);
    expect(downloadsDefaultDir).toHaveBeenCalledTimes(1);
    const defaultDir = await bridge.downloadsDefaultDir();
    expect(defaultDir).toBe("/tmp/downloads");
  });
});
