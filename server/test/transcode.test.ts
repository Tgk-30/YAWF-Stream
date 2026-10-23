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

describe("real transcoder source probe", () => {
  beforeEach(() => spawnMock.mockReset());

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
