import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { realTranscoder } from "../src/transcode.js";

function completeProbe(payload: unknown) {
  const stdout = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: () => boolean;
  };
  child.stdout = stdout;
  child.kill = () => true;
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const result = realTranscoder.probeStreams!("https://provider.example/media");
  stdout.emit("data", Buffer.from(JSON.stringify(payload)));
  child.emit("close", 0);
  return result;
}

describe("real transcoder boot probes", () => {
  function bootChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    return child;
  }

  beforeEach(() => spawnMock.mockReset());

  it("allows FFmpeg startup on a cold host to take over two seconds", async () => {
    vi.useFakeTimers();
    try {
      const child = bootChild();
      spawnMock.mockReturnValueOnce(child);
      const result = realTranscoder.detect();
      await vi.advanceTimersByTimeAsync(2_250);
      child.emit("close", 0);

      await expect(result).resolves.toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith("ffmpeg", ["-version"], { stdio: "ignore" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts slow optional probes without losing supported encoders and audio selection", async () => {
    vi.useFakeTimers();
    try {
      const filters = bootChild();
      const encoders = bootChild();
      const ffprobe = bootChild();
      spawnMock.mockReturnValueOnce(filters).mockReturnValueOnce(encoders).mockReturnValueOnce(ffprobe);
      const result = realTranscoder.capabilities!();
      await vi.advanceTimersByTimeAsync(2_250);
      filters.stdout.emit("data", Buffer.from(" .. zscale V->V Test scale"));
      encoders.stdout.emit("data", Buffer.from(" V....D libx264 Test video\n S..... webvtt Test captions"));
      for (const child of [filters, encoders, ffprobe]) child.emit("close", 0);

      await expect(result).resolves.toEqual({
        toneMapping: true,
        videoEncoders: ["libx264"],
        subtitleSidecar: true,
        audioTrackSelection: true,
      });
      for (const child of [filters, encoders, ffprobe]) expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a timed-out version probe only after the killed child closes", async () => {
    vi.useFakeTimers();
    try {
      const cold = bootChild();
      const retry = bootChild();
      spawnMock.mockReturnValueOnce(cold).mockReturnValueOnce(retry);
      const result = realTranscoder.detect();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cold.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      cold.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_750);
      retry.emit("close", 0);
      await expect(result).resolves.toBe(true);
      expect(retry.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries only a timed-out capability probe and retains the successful probes", async () => {
    vi.useFakeTimers();
    try {
      const filters = bootChild();
      const encoders = bootChild();
      const ffprobe = bootChild();
      const retry = bootChild();
      spawnMock.mockReturnValueOnce(filters).mockReturnValueOnce(encoders)
        .mockReturnValueOnce(ffprobe).mockReturnValueOnce(retry);
      const result = realTranscoder.capabilities!();
      filters.stdout.emit("data", Buffer.from(" .. zscale V->V Test scale"));
      filters.emit("close", 0);
      ffprobe.emit("close", 0);
      encoders.stdout.emit("data", Buffer.from(" V....D h264_nvenc Partial output"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(encoders.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      encoders.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(4);
      expect(spawnMock.mock.calls[3]?.slice(0, 2)).toEqual(["ffmpeg", ["-hide_banner", "-encoders"]]);
      retry.stdout.emit("data", Buffer.from(" V....D libx264 Test video\n S..... webvtt Test captions"));
      retry.emit("close", 0);
      await expect(result).resolves.toEqual({
        toneMapping: true,
        videoEncoders: ["libx264"],
        subtitleSidecar: true,
        audioTrackSelection: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry ENOENT or a completed unsuccessful invocation", async () => {
    const missing = bootChild();
    const nonzero = bootChild();
    spawnMock.mockReturnValueOnce(missing).mockReturnValueOnce(nonzero);
    const absent = realTranscoder.detect();
    missing.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" }));
    await expect(absent).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const unsuccessful = realTranscoder.detect();
    nonzero.emit("close", 1);
    await expect(unsuccessful).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("clears the watchdog after success and still stops a hung boot probe", async () => {
    vi.useFakeTimers();
    try {
      const fast = bootChild();
      const hung = bootChild();
      spawnMock.mockReturnValueOnce(fast).mockReturnValueOnce(hung);
      const success = realTranscoder.detect();
      fast.emit("close", 0);
      await expect(success).resolves.toBe(true);

      const result = realTranscoder.detect();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fast.kill).not.toHaveBeenCalled();
      expect(hung.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(hung.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      hung.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung retry without a third invocation even when it later closes", async () => {
    vi.useFakeTimers();
    try {
      const cold = bootChild();
      const retry = bootChild();
      spawnMock.mockReturnValueOnce(cold).mockReturnValueOnce(retry);
      const result = realTranscoder.detect();
      await vi.advanceTimersByTimeAsync(5_000);
      cold.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(retry.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(false);
      retry.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("inspects the required encoder before starting optional processes", async () => {
    const encoder = bootChild();
    const filter = bootChild();
    const ffprobe = bootChild();
    spawnMock.mockReturnValueOnce(encoder).mockReturnValueOnce(filter).mockReturnValueOnce(ffprobe);
    const result = realTranscoder.inspectStartup!(new AbortController().signal);
    expect(spawnMock.mock.calls.map(([, args]) => args)).toEqual([["-hide_banner", "-encoders"]]);
    encoder.stdout.emit("data", Buffer.from(" V....D libx264 Test video\n S..... webvtt Test captions"));
    encoder.emit("close", 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock.mock.calls.map(([, args]) => args)).toEqual([
      ["-hide_banner", "-encoders"], ["-hide_banner", "-filters"], ["-version"],
    ]);
    filter.stdout.emit("data", Buffer.from(" .. zscale V->V Test scale"));
    filter.emit("close", 0);
    ffprobe.emit("close", 0);
    await expect(result).resolves.toEqual({ state: "ready", capabilities: {
      videoEncoders: ["libx264"], toneMapping: true, subtitleSidecar: true, audioTrackSelection: true,
    } });
  });

  it.each([true, false])("reports a retryable encoder timeout only after both child closes: %s", async (confirmed) => {
    vi.useFakeTimers();
    try {
      const encoder = bootChild();
      const second = bootChild();
      spawnMock.mockReturnValueOnce(encoder).mockReturnValueOnce(second);
      const result = realTranscoder.inspectStartup!(new AbortController().signal);
      await vi.advanceTimersByTimeAsync(5_000);
      encoder.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(second.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      if (confirmed) second.emit("close", null, "SIGKILL");
      else await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toEqual({ state: confirmed ? "retryable-timeout" : "unavailable" });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("aborts a running inspection without retrying or starting optional tools", async () => {
    const child = bootChild();
    spawnMock.mockReturnValueOnce(child);
    const controller = new AbortController();
    const result = realTranscoder.inspectStartup!(controller.signal);
    controller.abort();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await expect(result).resolves.toEqual({ state: "unavailable" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not schedule recovery for a missing encoder or an unsuccessful tool", async () => {
    const absent = bootChild();
    const unsupported = bootChild();
    spawnMock.mockReturnValueOnce(absent).mockReturnValueOnce(unsupported);
    const first = realTranscoder.inspectStartup!(new AbortController().signal);
    absent.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" }));
    await expect(first).resolves.toEqual({ state: "unavailable" });
    const second = realTranscoder.inspectStartup!(new AbortController().signal);
    unsupported.stdout.emit("data", Buffer.from(" V....D libx265 unsupported"));
    unsupported.emit("close", 0);
    await expect(second).resolves.toEqual({ state: "unavailable" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

});

describe("real transcoder source probe", () => {
  beforeEach(() => spawnMock.mockReset());

  it("reads the first mapped video's unrotated height in the existing probe", async () => {
    await expect(completeProbe({ streams: [
      { codec_type: "audio" },
      { codec_type: "video", height: 480, side_data_list: [{ rotation: 0 }] },
      { codec_type: "video", height: 1080 },
    ] })).resolves.toMatchObject({ videoHeight: 480 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toContain(
      "stream=index,codec_type,height:stream_tags=language,title,rotate:stream_side_data=rotation:stream_disposition=default:format=duration",
    );
  });

  it.each([
    { height: "480" }, { height: 0 }, { height: 480.5 }, { height: 16385 },
    { height: 480, tags: { rotate: "90" } },
    { height: 480, tags: { rotate: "unknown" } },
    { height: 480, tags: { rotate: null } },
    { height: 480, tags: null },
    { height: 480, tags: [] },
    { height: 480, side_data_list: [{ rotation: -90 }] },
    { height: 480, side_data_list: [{ rotation: "0" }] },
    { height: 480, side_data_list: [{}] },
    { height: 480, side_data_list: null },
    { height: 480, side_data_list: [null] },
    { height: 480, side_data_list: "unknown" },
  ])("keeps uncertain or rotated source height out of ladder selection: %j", async (metadata) => {
    await expect(completeProbe({ streams: [{ codec_type: "video", ...metadata }] }))
      .resolves.toMatchObject({ videoHeight: null });
  });

  it("requests format duration and returns a bounded original-source duration", async () => {
    const result = completeProbe({
      streams: [
        {
          codec_type: "audio",
          tags: { language: "eng", title: "English" },
          disposition: { default: 1 },
        },
      ],
      format: { duration: "5423.125" },
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("-show_entries") + 1]).toContain("format=duration");
    await expect(result).resolves.toMatchObject({
      durationSeconds: 5423.125,
      audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
    });
  });

  it.each([
    ["missing", undefined],
    ["invalid", "unknown"],
    ["infinite", "Infinity"],
    ["zero", "0"],
    ["negative", "-1"],
    ["excessive", "86400.001"],
  ])("returns null for %s source duration metadata", async (_label, duration) => {
    const format = duration === undefined ? {} : { duration };
    await expect(completeProbe({ streams: [], format })).resolves.toMatchObject({
      durationSeconds: null,
    });
  });

  it("accepts the inclusive one-day source duration limit", async () => {
    await expect(
      completeProbe({ streams: [], format: { duration: "86400" } }),
    ).resolves.toMatchObject({ durationSeconds: 86_400 });
  });

  it("lets only the explicit slow lane retain a valid probe completing at 10.1 seconds", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = stdout;
      child.kill = vi.fn(() => true);
      spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

      const result = realTranscoder.probeStreams!(
        "https://provider.example/slow-media",
        { timeoutMs: 15_000 },
      );
      stdout.emit("data", Buffer.from(JSON.stringify({
        streams: [{
          codec_type: "audio",
          tags: { language: "fra", title: "French" },
          disposition: { default: 1 },
        }],
        format: { duration: "596.457379" },
      })));
      await vi.advanceTimersByTimeAsync(10_100);
      child.emit("close", 0);

      await expect(result).resolves.toMatchObject({
        audioTracks: [{ index: 0, language: "fra", label: "French", default: true }],
        durationSeconds: 596.457379,
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the ordinary five-second deadline and settles only after actual child close", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = stdout;
      child.kill = vi.fn(() => true);
      spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

      let settled = false;
      const result = realTranscoder.probeStreams!(
        "https://provider.example/slow-media",
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(false);

      child.emit("close", null);
      await expect(result).resolves.toBeNull();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills an externally cancelled probe and still waits for actual child close", async () => {
    const stdout = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdout;
    child.kill = vi.fn(() => true);
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const controller = new AbortController();
    let settled = false;
    const result = realTranscoder.probeStreams!(
      "https://provider.example/cancelled-media",
      { signal: controller.signal },
    ).finally(() => {
      settled = true;
    });

    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(result).resolves.toBeNull();
    expect(settled).toBe(true);
  });
});
