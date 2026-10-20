import { describe, expect, it, vi } from "vitest";
import { hlsArgs } from "../src/transcodeSession.js";

function valueAfter(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("HLS transcode arguments", () => {
  it("builds a seek-aware adaptive 1080p, 720p, 480p, and 360p ladder", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "adaptive",
      startSeconds: 731,
    });
    expect(valueAfter(args, "-ss")).toBe("731");
    expect(valueAfter(args, "-master_pl_name")).toBe("stream.m3u8");
    expect(valueAfter(args, "-var_stream_map")).toContain("name:1080p");
    expect(valueAfter(args, "-var_stream_map")).toContain("name:720p");
    expect(valueAfter(args, "-var_stream_map")).toContain("name:480p");
    expect(valueAfter(args, "-var_stream_map")).toContain("name:360p");
    expect(valueAfter(args, "-hls_segment_filename")).toContain("%v_seg_%05d.ts");
    expect(valueAfter(args, "-hls_playlist_type")).toBe("event");
    expect(valueAfter(args, "-hls_list_size")).toBe("0");
  });

  it("uses a bounded low-bandwidth profile without upscaling", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "data-saver",
    });
    expect(valueAfter(args, "-vf")).toContain("min(480,ih)");
    expect(valueAfter(args, "-var_stream_map")).toBe("v:0,a:0,name:480p");
    expect(valueAfter(args, "-b:a")).toBe("96k");
    expect(valueAfter(args, "-b:v:0")).toBe("1800k");
    expect(valueAfter(args, "-maxrate:v:0")).toBe("1800k");
    expect(valueAfter(args, "-hls_playlist_type")).toBe("event");
  });

  it("maps legacy profiles and explicit qualities to bounded fixed renditions", () => {
    expect(valueAfter(hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "high",
    }), "-vf")).toContain("min(1080,ih)");
    expect(valueAfter(hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality: "720p",
    }), "-vf")).toContain("min(720,ih)");
    const low = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality: "360p",
    });
    expect(valueAfter(low, "-vf")).toContain("min(360,ih)");
    expect(valueAfter(low, "-b:v:0")).toBe("700k");
  });

  it("builds a playable video-only ladder when the source has no audio", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "adaptive",
      includeAudio: false,
    });
    expect(args).not.toContain("0:a:0");
    expect(valueAfter(args, "-var_stream_map")).toBe(
      "v:0,name:1080p v:1,name:720p v:2,name:480p v:3,name:360p",
    );
    expect(args).not.toContain("-c:a");
  });

  it("maps only the bounded selected source audio stream for fixed and adaptive outputs", () => {
    const fixed = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality: "480p",
      audioTrack: 2,
    });
    expect(fixed.filter((value) => value === "0:a:2")).toHaveLength(1);
    expect(fixed).not.toContain("0:a:0");

    const adaptive = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality: "auto",
      audioTrack: 3,
    });
    expect(adaptive.filter((value) => value === "0:a:3")).toHaveLength(4);
    expect(adaptive).not.toContain("0:a:0");
  });

  it("supports explicit tone mapping, subtitle preservation, and hardware encoding", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "high",
      hdrPolicy: "tone-map",
      preserveSubtitles: true,
      includeSubtitle: true,
      videoEncoder: "h264_videotoolbox",
    });
    expect(valueAfter(args, "-vf")).toContain("tonemap=tonemap=hable");
    expect(args).toContain("h264_videotoolbox");
    expect(args).toContain("0:s:0");
    expect(args.at(-1)).toContain("subtitles.vtt");
  });
});

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { AppDatabase } from "../src/db.js";
import { TranscodeRegistry } from "../src/transcodeSession.js";
import type { ServerConfig } from "../src/types.js";
import type { Transcoder } from "../src/transcode.js";

function stagedRegistryFixture(firstSpawnPlayable = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-registry-"));
  const database = new AppDatabase(":memory:");
  const children: Array<{ child: ChildProcess; dir: string; kills: number }> = [];
  let notifySpawn: (() => void) | null = null;
  const transcoder: Transcoder = {
    async detect() { return true; },
    spawnHls(args) {
      const dir = dirname(args.at(-1)!);
      const record = { child: null as unknown as ChildProcess, dir, kills: 0 };
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean; stderr: null };
      child.kill = () => {
        record.kills += 1;
        child.emit("exit", 0);
        return true;
      };
      child.stderr = null;
      record.child = child as unknown as ChildProcess;
      children.push(record);
      notifySpawn?.();
      // Only the first process becomes playable. Later spawns deliberately hang
      // so stop/kill owns and removes the staged child and directory.
      if (firstSpawnPlayable && children.length === 1) {
        writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n1080p.m3u8\n");
        writeFileSync(join(dir, "1080p_seg_00000.ts"), "segment");
      }
      return record.child;
    },
  };
  const registry = new TranscodeRegistry(
    database,
    {
      dataDir,
      maxTranscodes: 2,
      transcodeVideoEncoder: "libx264",
      transcodeStartTimeoutMs: 500,
    } as ServerConfig,
    transcoder,
  );
  const waitForSpawn = () => new Promise<void>((resolve) => { notifySpawn = resolve; });
  return { children, dataDir, database, registry, waitForSpawn };
}

function capacityRegistryFixture(maxTranscodes = 2) {
  const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-capacity-"));
  const database = new AppDatabase(":memory:");
  const children: Array<{
    child: ChildProcess;
    dir: string;
    kills: number;
    running: boolean;
    finish: (code?: number) => void;
  }> = [];
  const transcoder: Transcoder = {
    async detect() { return true; },
    spawnHls(args) {
      const dir = dirname(args.at(-1)!);
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal?: NodeJS.Signals | number) => boolean;
        stderr: null;
      };
      const record = {
        child: child as unknown as ChildProcess,
        dir,
        kills: 0,
        running: true,
        finish: (code = 0) => {},
      };
      record.finish = (code = 0) => {
        if (!record.running) return;
        record.running = false;
        // Node reports process termination first, then stdio closure. The
        // registry must release capacity once even though both events fire.
        child.emit("exit", code, null);
        child.emit("close", code, null);
      };
      child.kill = () => {
        record.kills += 1;
        // SIGTERM is asynchronous in production. Tests explicitly emit the
        // later exit/close so cancellation cannot prematurely free capacity.
        return record.running;
      };
      child.stderr = null;
      children.push(record);
      writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n");
      for (const quality of ["1080p", "720p", "480p", "360p"]) {
        writeFileSync(join(dir, `${quality}_seg_00000.ts`), "segment");
      }
      return record.child;
    },
  };
  const registry = new TranscodeRegistry(
    database,
    {
      dataDir,
      maxTranscodes,
      transcodeVideoEncoder: "libx264",
      transcodeStartTimeoutMs: 500,
    } as ServerConfig,
    transcoder,
  );
  return { children, dataDir, database, registry };
}

describe("transcode staged lifecycle", () => {
  it("kills and removes an initial warm-up when the registry stops", async () => {
    const fixture = stagedRegistryFixture(false);
    try {
      const pending = fixture.registry.ensureJob("initial", "https://provider.example/video");
      await fixture.waitForSpawn();
      await fixture.registry.stop();
      await expect(pending).rejects.toMatchObject({ statusCode: 410 });
      expect(fixture.children[0]?.kills).toBeGreaterThan(0);
      expect(existsSync(fixture.children[0]!.dir)).toBe(false);
    } finally {
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("cleans a staged directory when FFmpeg exits before readiness", async () => {
    const fixture = stagedRegistryFixture(false);
    try {
      const pending = fixture.registry.ensureJob("exited", "https://provider.example/video");
      await fixture.waitForSpawn();
      (fixture.children[0]!.child as unknown as EventEmitter).emit("exit", 1);
      await expect(pending).rejects.toMatchObject({ statusCode: 502 });
      expect(existsSync(fixture.children[0]!.dir)).toBe(false);
    } finally {
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("kills and removes a rejected replacement warm-up without leaving the active job orphaned", async () => {
    const fixture = stagedRegistryFixture();
    try {
      const active = await fixture.registry.ensureJob("replacement", "https://provider.example/video");
      expect(existsSync(active)).toBe(true);
      const pending = fixture.registry.ensureJob(
        "replacement",
        "https://provider.example/video",
        { quality: "360p" },
      );
      const rejected = expect(pending).rejects.toMatchObject({ statusCode: 410 });
      await fixture.waitForSpawn();
      await fixture.registry.kill("replacement");
      await rejected;
      expect(fixture.children).toHaveLength(2);
      expect(fixture.children[1]?.kills).toBeGreaterThan(0);
      expect(existsSync(fixture.children[1]!.dir)).toBe(false);
      expect(existsSync(active)).toBe(false);
    } finally {
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });
});

describe("transcode process capacity", () => {
  it("frees admission after normal FFmpeg exit while cached output remains playable", async () => {
    const fixture = capacityRegistryFixture(1);
    try {
      const cached = await fixture.registry.ensureJob(
        "completed",
        "https://provider.example/first",
      );
      fixture.children[0]!.finish(0);
      expect(existsSync(join(cached, "stream.m3u8"))).toBe(true);
      expect(fixture.registry.dirFor("completed")).toBe(cached);

      const next = await fixture.registry.ensureJob(
        "next",
        "https://provider.example/second",
      );
      expect(fixture.children).toHaveLength(2);
      expect(existsSync(join(next, "stream.m3u8"))).toBe(true);
      expect(existsSync(join(cached, "stream.m3u8"))).toBe(true);
      fixture.children[1]!.finish(0);
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("replaces either of two completed cached jobs without discarding prior assets", async () => {
    const fixture = capacityRegistryFixture(2);
    try {
      const first = await fixture.registry.ensureJob(
        "first",
        "https://provider.example/first",
      );
      const second = await fixture.registry.ensureJob(
        "second",
        "https://provider.example/second",
      );
      const firstGeneration = fixture.registry.generationFor("first", first);
      expect(firstGeneration).not.toBeNull();
      fixture.children[0]!.finish(0);
      fixture.children[1]!.finish(0);

      const replacement = await fixture.registry.ensureJob(
        "first",
        "https://provider.example/first",
        { quality: "360p", startSeconds: 60 },
      );
      expect(fixture.children).toHaveLength(3);
      expect(replacement).not.toBe(first);
      expect(fixture.registry.dirFor("second")).toBe(second);
      expect(fixture.registry.dirForAsset(
        "first",
        "stream.m3u8",
        firstGeneration!,
      )).toBe(first);
      expect(existsSync(join(first, "stream.m3u8"))).toBe(true);
      fixture.children[2]!.finish(0);
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("still rejects new and replacement work while two FFmpeg processes are live", async () => {
    const fixture = capacityRegistryFixture(2);
    try {
      await fixture.registry.ensureJob("first", "https://provider.example/first");
      await fixture.registry.ensureJob("second", "https://provider.example/second");

      await expect(fixture.registry.ensureJob(
        "third",
        "https://provider.example/third",
      )).rejects.toMatchObject({ statusCode: 503 });
      await expect(fixture.registry.ensureJob(
        "first",
        "https://provider.example/first",
        { quality: "360p" },
      )).rejects.toMatchObject({ statusCode: 503 });
      expect(fixture.children).toHaveLength(2);
      fixture.children.forEach((record) => record.finish(0));
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("does not free a cancelled process slot until its exit event arrives", async () => {
    const fixture = capacityRegistryFixture(1);
    try {
      await fixture.registry.ensureJob("cancelled", "https://provider.example/first");
      await fixture.registry.kill("cancelled");
      expect(fixture.children[0]!.kills).toBeGreaterThan(0);

      await expect(fixture.registry.ensureJob(
        "too-early",
        "https://provider.example/second",
      )).rejects.toMatchObject({ statusCode: 503 });
      fixture.children[0]!.finish(0);
      await expect(fixture.registry.ensureJob(
        "after-exit",
        "https://provider.example/second",
      )).resolves.toEqual(expect.any(String));
      expect(fixture.children).toHaveLength(2);
      fixture.children[1]!.finish(0);
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });
});

describe("transcode stream probe admission", () => {
  function probeRegistry(
    probeStreams: NonNullable<Transcoder["probeStreams"]>,
    maxTranscodes = 2,
  ) {
    const database = new AppDatabase(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-probe-registry-"));
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      {
        async detect() { return true; },
        spawnHls() { throw new Error("not used"); },
        probeStreams,
      },
    );
    return { dataDir, database, registry };
  }

  it("bounds ffprobe concurrency across different authorized sessions", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const probe = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { audio: true, subtitle: false, audioTracks: [] };
    });
    const fixture = probeRegistry(probe, 2);
    try {
      const requests = Array.from({ length: 8 }, (_, index) =>
        fixture.registry.audioTracksFor(`session-${index}`, `https://provider.example/${index}`),
      );
      expect(probe).toHaveBeenCalledTimes(2);
      expect(maximum).toBe(2);
      await expect(Promise.all(requests.slice(2))).resolves.toEqual(
        Array.from({ length: 6 }, () => null),
      );
      releases.forEach((release) => release());
      await Promise.all(requests.slice(0, 2));
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("reaps probe-only cache entries when their session no longer exists", async () => {
    const probe = vi.fn(async () => ({
      audio: true,
      subtitle: false,
      audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
      durationSeconds: 3600.5,
    }));
    const fixture = probeRegistry(probe, 1);
    try {
      await fixture.registry.audioTracksFor("gone", "https://provider.example/video");
      await fixture.registry.audioTracksFor("gone", "https://provider.example/video");
      expect(probe).toHaveBeenCalledTimes(1);
      (fixture.registry as unknown as { reap(): void }).reap();
      await fixture.registry.audioTracksFor("gone", "https://provider.example/video");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("coalesces source info and compatibility audio inventory, then invalidates it on kill", async () => {
    let release: ((value: {
      audio: boolean;
      subtitle: boolean;
      audioTracks: Array<{
        index: number;
        language: string;
        label: string;
        default: boolean;
      }>;
      durationSeconds: number;
    }) => void) | null = null;
    const probe = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const fixture = probeRegistry(probe, 2);
    try {
      const sourceInfo = fixture.registry.sourceInfoFor(
        "shared",
        "https://provider.example/video",
      );
      const audioTracks = fixture.registry.audioTracksFor(
        "shared",
        "https://provider.example/video",
      );
      expect(probe).toHaveBeenCalledTimes(1);
      release!({
        audio: true,
        subtitle: false,
        audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
        durationSeconds: 3600.5,
      });
      await expect(sourceInfo).resolves.toEqual({
        audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
        durationSeconds: 3600.5,
      });
      await expect(audioTracks).resolves.toEqual([
        { index: 0, language: "eng", label: "English", default: true },
      ]);

      await fixture.registry.kill("shared");
      const refreshed = fixture.registry.sourceInfoFor(
        "shared",
        "https://provider.example/video",
      );
      expect(probe).toHaveBeenCalledTimes(2);
      release!({
        audio: true,
        subtitle: false,
        audioTracks: [],
        durationSeconds: 3600.5,
      });
      await refreshed;
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["excessive", 86_400.001],
    ["unknown", undefined],
  ])("sanitizes %s fake-probe duration metadata", async (_label, durationSeconds) => {
    const probe = vi.fn(async () => ({
      audio: false,
      subtitle: false,
      durationSeconds,
    }));
    const fixture = probeRegistry(probe, 1);
    try {
      await expect(
        fixture.registry.sourceInfoFor("bounded", "https://provider.example/video"),
      ).resolves.toEqual({ audioTracks: null, durationSeconds: null });
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it.each([0.001, 3600.5, 86_400])(
    "preserves bounded finite fake-probe duration %s",
    async (durationSeconds) => {
      const fixture = probeRegistry(async () => ({
        audio: false,
        subtitle: false,
        durationSeconds,
      }), 1);
      try {
        await expect(
          fixture.registry.sourceInfoFor("finite", "https://provider.example/video"),
        ).resolves.toEqual({ audioTracks: null, durationSeconds });
      } finally {
        await fixture.registry.stop();
        fixture.database.close();
        rmSync(fixture.dataDir, { recursive: true, force: true });
      }
    },
  );
});
