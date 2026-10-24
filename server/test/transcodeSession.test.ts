import { describe, expect, it, vi } from "vitest";
import { hlsArgs } from "../src/transcodeSession.js";

function valueAfter(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function fakeMpegTsPacket(streamId: number, timestamp: number, pid: number): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x40 | ((pid >>> 8) & 0x1f), pid & 0xff, 0x10], 0);
  packet.set([
    0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5,
    0x20 | ((Math.floor(timestamp / 2 ** 30) & 0x07) << 1) | 1,
    Math.floor(timestamp / 2 ** 22) & 0xff,
    ((Math.floor(timestamp / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(timestamp / 2 ** 7) & 0xff,
    ((timestamp & 0x7f) << 1) | 1,
  ], 4);
  return packet;
}

function fakeMpegTsSegment(): Buffer {
  return Buffer.concat([
    fakeMpegTsPacket(0xe0, 576_000, 0x100),
    fakeMpegTsPacket(0xc0, 574_080, 0x101),
  ]);
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

  it("muxes a probed embedded subtitle as a segmented WebVTT HLS rendition", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      profile: "high",
      startSeconds: 731,
      hdrPolicy: "tone-map",
      preserveSubtitles: true,
      includeSubtitle: true,
      videoEncoder: "h264_videotoolbox",
    });
    expect(valueAfter(args, "-vf")).toContain("tonemap=tonemap=hable");
    expect(args).toContain("h264_videotoolbox");
    expect(args).toContain("0:s:0");
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-ss"));
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(valueAfter(args, "-c:s")).toBe("webvtt");
    expect(valueAfter(args, "-hls_subtitle_path")).toBe(
      join("/tmp/yawf", "%v_subtitles.m3u8"),
    );
    expect(valueAfter(args, "-var_stream_map")).toContain(
      "s:0,sgroup:subs",
    );
    expect(args.at(-1)).toBe(join("/tmp/yawf", "%v.m3u8"));
    expect(args).not.toContain(join("/tmp/yawf", "subtitles.vtt"));
  });

  it.each([
    ["auto", true],
    ["auto", false],
    ["480p", true],
    ["480p", false],
  ] as const)("uses a portable subtitle map for %s with audio %s", (quality, includeAudio) => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality,
      includeAudio,
      preserveSubtitles: true,
      includeSubtitle: true,
    });
    const map = valueAfter(args, "-var_stream_map")!;
    const prefix = quality === "auto" ? "1080p" : quality;
    expect(map.split(" ")[0]).toBe(
      `v:0,${includeAudio ? "a:0," : ""}s:0,sgroup:subs,name:${prefix}`,
    );
    // FFmpeg 5.1 rejects the optional newer sname field before writing HLS.
    expect(map).not.toContain("sname:");
    expect(valueAfter(args, "-hls_subtitle_path")).toBe(
      join("/tmp/yawf", "%v_subtitles.m3u8"),
    );
    expect(valueAfter(args, "-avoid_negative_ts")).toBe("disabled");
  });

  it("does not map or advertise subtitles without a successful track probe", () => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality: "480p",
      preserveSubtitles: true,
      includeSubtitle: false,
    });
    expect(args).not.toContain("0:s:0");
    expect(args).not.toContain("-c:s");
    expect(args).not.toContain("-hls_subtitle_path");
    expect(args).not.toContain("-avoid_negative_ts");
    expect(args).not.toContain("-hls_segment_options");
    expect(args).not.toContain("-copyts");
    expect(valueAfter(args, "-var_stream_map")).toBe("v:0,a:0,name:480p");
  });

  it.each([
    ["auto", 0, true],
    ["480p", 0, true],
    ["auto", 5, true],
    ["480p", 5, true],
    ["auto", 0, false],
    ["480p", 0, false],
    ["auto", 5, false],
    ["480p", 5, false],
  ] as const)("preserves the output subtitle clock for %s at start %i with audio %s", (quality, startSeconds, includeAudio) => {
    const args = hlsArgs("https://provider.example/video", "/tmp/yawf", {
      quality,
      startSeconds,
      includeAudio,
      preserveSubtitles: true,
      includeSubtitle: true,
    });
    expect(valueAfter(args, "-avoid_negative_ts")).toBe("disabled");
    expect(args.indexOf("-avoid_negative_ts")).toBeGreaterThan(args.indexOf("-i"));
    expect(args.indexOf("-avoid_negative_ts")).toBeLessThan(args.indexOf("-f"));
    expect(valueAfter(args, "-hls_segment_options")).toBe(
      "mpegts_copyts=1:avoid_negative_ts=disabled",
    );
    expect(args.indexOf("-hls_segment_options")).toBeGreaterThan(args.indexOf("-i"));
    expect(args.indexOf("-hls_segment_options")).toBeLessThan(args.indexOf("-f"));
    expect(args.filter(arg => arg === "-copyts")).toHaveLength(1);
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("-start_at_zero");
    expect(args).not.toContain("-itsoffset");
    if (!includeAudio) {
      expect(args).not.toContain("-c:a");
      expect(valueAfter(args, "-var_stream_map")).not.toContain("a:");
    }
    if (startSeconds > 0) {
      expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-ss"));
      expect(valueAfter(args, "-ss")).toBe(String(startSeconds));
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    } else {
      expect(args).not.toContain("-ss");
    }
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

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

function playableSpawn() {
  return vi.fn((args: string[]) => {
    const dir = dirname(args.at(-1)!);
    writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n");
    for (const quality of ["1080p", "720p", "480p", "360p"]) {
      writeFileSync(join(dir, `${quality}_seg_00000.ts`), "segment");
    }
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: null;
    };
    let finished = false;
    child.kill = vi.fn(() => {
      if (!finished) {
        finished = true;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }
      return true;
    });
    child.stderr = null;
    return child as unknown as ChildProcess;
  });
}

describe("transcode staged lifecycle", () => {
  it.each([
    ["playlist", false, false, true],
    ["first WebVTT segment", true, false, true],
    ["valid MPEG-TS clock", true, true, false],
  ])("does not promote a subtitle rendition without its %s", async (
    _missing,
    writePlaylist,
    writeSubtitleSegment,
    writeValidClock,
  ) => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-subtitle-ready-"));
    const database = new AppDatabase(":memory:");
    let outputDir: string | null = null;
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      stderr: null;
    };
    child.kill = () => {
      child.emit("exit", 0);
      return true;
    };
    child.stderr = null;
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 125,
      } as ServerConfig,
      {
        async detect() { return true; },
        async probeStreams() {
          return { audio: true, subtitle: true, audioTracks: [] };
        },
        spawnHls(args) {
          outputDir = dirname(args.at(-1)!);
          writeFileSync(join(outputDir, "stream.m3u8"), "#EXTM3U\n");
          writeFileSync(
            join(outputDir, "480p_seg_00000.ts"),
            writeValidClock ? fakeMpegTsSegment() : "segment",
          );
          if (writePlaylist) {
            writeFileSync(
              join(outputDir, "480p_subtitles.m3u8"),
              "#EXTM3U\n#EXTINF:6,\n480p0.vtt\n",
            );
          }
          if (writeSubtitleSegment) {
            writeFileSync(join(outputDir, "480p0.vtt"), "WEBVTT\n");
          }
          return child as unknown as ChildProcess;
        },
      },
    );
    try {
      await expect(registry.ensureJob(
        "subtitle-readiness",
        "https://provider.example/video",
        { quality: "480p", preserveSubtitles: true },
      )).rejects.toMatchObject({ statusCode: 504 });
      expect(outputDir).not.toBeNull();
      expect(existsSync(outputDir!)).toBe(false);
      expect(registry.dirFor("subtitle-readiness")).toBeNull();
    } finally {
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

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

describe("transcode pre-spawn lifecycle ownership", () => {
  it("awaits and cancels creation already admitted at data-directory setup", async () => {
    const parentDir = mkdtempSync(join(tmpdir(), "yawf-transcode-preparation-"));
    const dataDir = join(parentDir, "not-created-yet");
    const database = new AppDatabase(":memory:");
    const probeStreams = vi.fn(async () => ({
      audio: true,
      subtitle: false,
      audioTracks: [],
    }));
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    let pending: Promise<string> | null = null;
    let creationSettled = false;
    try {
      pending = registry.ensureJob(
        "preparation-stop",
        "https://provider.example/video",
      );
      const outcome = observe(pending).finally(() => {
        creationSettled = true;
      });

      await registry.stop();

      expect(creationSettled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { statusCode: 410 },
      });
      expect(probeStreams).not.toHaveBeenCalled();
      expect(spawnHls).not.toHaveBeenCalled();
      expect(
        existsSync(dataDir)
          ? await (await import("node:fs/promises")).readdir(dataDir)
          : [],
      ).toEqual([]);
    } finally {
      if (pending != null) await Promise.allSettled([pending]);
      await registry.stop();
      database.close();
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("waits for probe-stage creation cancellation and never spawns FFmpeg", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-probe-stop-"));
    const database = new AppDatabase(":memory:");
    let resolveProbeStarted: (() => void) | null = null;
    const probeStarted = new Promise<void>((resolve) => {
      resolveProbeStarted = resolve;
    });
    let settleProbe: ((value: null) => void) | null = null;
    const probeStreams = vi.fn<NonNullable<Transcoder["probeStreams"]>>(
      () => new Promise((resolve) => {
        settleProbe = resolve;
        resolveProbeStarted!();
      }),
    );
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    let pending: Promise<string> | null = null;
    try {
      pending = registry.ensureJob(
        "probe-stop",
        "https://provider.example/video",
      );
      const outcome = observe(pending);
      await probeStarted;

      await registry.stop();

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { statusCode: 410 },
      });
      expect(spawnHls).not.toHaveBeenCalled();
      expect(await (await import("node:fs/promises")).readdir(dataDir)).toEqual([]);
    } finally {
      settleProbe?.(null);
      if (pending != null) await Promise.allSettled([pending]);
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("shares one promise across concurrent and repeated shutdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-closed-"));
    const database = new AppDatabase(":memory:");
    const probeStreams = vi.fn(async () => ({
      audio: true,
      subtitle: false,
      audioTracks: [],
    }));
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    try {
      const firstStop = registry.stop();
      const concurrentStop = registry.stop();
      expect(concurrentStop).toBe(firstStop);
      await firstStop;
      expect(registry.stop()).toBe(firstStop);
      expect(probeStreams).not.toHaveBeenCalled();
      expect(spawnHls).not.toHaveBeenCalled();
    } finally {
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects new jobs and suppresses new probes after shutdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-closed-admission-"));
    const database = new AppDatabase(":memory:");
    const probeStreams = vi.fn(async () => ({
      audio: true,
      subtitle: false,
      audioTracks: [],
    }));
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    try {
      await registry.stop();

      await expect(registry.sourceInfoFor(
        "after-stop-probe",
        "https://provider.example/video",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      await expect(registry.ensureJob(
        "after-stop-job",
        "https://provider.example/video",
      )).rejects.toMatchObject({ statusCode: 410 });
      expect(probeStreams).not.toHaveBeenCalled();
      expect(spawnHls).not.toHaveBeenCalled();
    } finally {
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("awaits a killed pre-spawn creation and permits only a later explicit restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-probe-kill-"));
    const database = new AppDatabase(":memory:");
    let resolveProbeStarted: (() => void) | null = null;
    const probeStarted = new Promise<void>((resolve) => {
      resolveProbeStarted = resolve;
    });
    let settleFirstProbe: ((value: null) => void) | null = null;
    const probeStreams = vi.fn<NonNullable<Transcoder["probeStreams"]>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        settleFirstProbe = resolve;
        resolveProbeStarted!();
      }))
      .mockResolvedValue({ audio: true, subtitle: false, audioTracks: [] });
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    let pending: Promise<string> | null = null;
    try {
      pending = registry.ensureJob(
        "killed-before-spawn",
        "https://provider.example/video",
      );
      const outcome = observe(pending);
      await probeStarted;

      await registry.kill("killed-before-spawn");

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { statusCode: 410 },
      });
      expect(spawnHls).not.toHaveBeenCalled();
      settleFirstProbe?.(null);
      await Promise.resolve();

      await expect(registry.ensureJob(
        "killed-before-spawn",
        "https://provider.example/video",
      )).resolves.toEqual(expect.any(String));
      expect(probeStreams).toHaveBeenCalledTimes(2);
      expect(spawnHls).toHaveBeenCalledTimes(1);
    } finally {
      settleFirstProbe?.(null);
      if (pending != null) await Promise.allSettled([pending]);
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not resurrect a queued replacement that was requested before kill", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-queued-kill-"));
    const database = new AppDatabase(":memory:");
    let resolveProbeStarted: (() => void) | null = null;
    const probeStarted = new Promise<void>((resolve) => {
      resolveProbeStarted = resolve;
    });
    let settleFirstProbe: ((value: null) => void) | null = null;
    const probeStreams = vi.fn<NonNullable<Transcoder["probeStreams"]>>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        settleFirstProbe = resolve;
        resolveProbeStarted!();
      }))
      .mockResolvedValue({ audio: true, subtitle: false, audioTracks: [] });
    const spawnHls = playableSpawn();
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 2,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      { async detect() { return true; }, probeStreams, spawnHls },
    );
    let initial: Promise<string> | null = null;
    let queued: Promise<string> | null = null;
    try {
      initial = registry.ensureJob(
        "queued-before-kill",
        "https://provider.example/video",
        { quality: "480p" },
      );
      const initialOutcome = observe(initial);
      await probeStarted;
      queued = registry.ensureJob(
        "queued-before-kill",
        "https://provider.example/video",
        { quality: "360p" },
      );
      const queuedOutcome = observe(queued);

      await registry.kill("queued-before-kill");

      await expect(initialOutcome).resolves.toMatchObject({
        status: "rejected",
        error: { statusCode: 410 },
      });
      await expect(queuedOutcome).resolves.toMatchObject({
        status: "rejected",
        error: { statusCode: 410 },
      });
      expect(probeStreams).toHaveBeenCalledTimes(1);
      expect(spawnHls).not.toHaveBeenCalled();
    } finally {
      settleFirstProbe?.(null);
      await Promise.allSettled([
        ...(initial == null ? [] : [initial]),
        ...(queued == null ? [] : [queued]),
      ]);
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
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
      expect(fixture.registry.startSecondsForAsset(
        "first",
        firstGeneration!,
      )).toBe(0);
      expect(fixture.registry.startSecondsForAsset(
        "first",
        fixture.registry.generationFor("first", replacement)!,
      )).toBe(60);
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
    spawnHls: Transcoder["spawnHls"] = () => { throw new Error("not used"); },
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
        spawnHls,
        probeStreams,
      },
    );
    return { dataDir, database, registry };
  }

  function controlledProbeAdapter(settleOnAbort = false) {
    type ProbeResult = Awaited<ReturnType<NonNullable<Transcoder["probeStreams"]>>>;
    const records: Array<{
      timeoutMs: number | undefined;
      signal: AbortSignal | undefined;
      child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
      settle: (value: ProbeResult) => void;
      close: () => void;
    }> = [];
    const probe = vi.fn<NonNullable<Transcoder["probeStreams"]>>(
      (_upstreamUrl, options = {}) => new Promise((resolve) => {
        const child = new EventEmitter() as EventEmitter & {
          kill: ReturnType<typeof vi.fn>;
        };
        child.kill = vi.fn(() => true);
        let settled = false;
        const settle = (value: ProbeResult) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        options.signal?.addEventListener("abort", () => {
          child.kill("SIGKILL");
          if (settleOnAbort) settle(null);
        }, { once: true });
        options.onSpawn?.(child as unknown as ChildProcess);
        records.push({
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          child,
          settle,
          close: () => child.emit("close", null),
        });
      }),
    );
    return { probe, records };
  }

  it("settles and caches a missing probe adapter synchronously without holding admission", async () => {
    const database = new AppDatabase(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-missing-probe-registry-"));
    const transcoder: Transcoder = {
      async detect() { return true; },
      spawnHls() { throw new Error("not used"); },
    };
    const registry = new TranscodeRegistry(
      database,
      {
        dataDir,
        maxTranscodes: 1,
        transcodeVideoEncoder: "libx264",
        transcodeStartTimeoutMs: 500,
      } as ServerConfig,
      transcoder,
    );
    try {
      await expect(registry.sourceInfoFor(
        "missing-adapter",
        "https://provider.example/missing",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect((registry as unknown as { activeProbes: number }).activeProbes).toBe(0);
      expect([...(registry as unknown as {
        streamProbes: Map<string, { state: string; settledAt: number | null }>;
      }).streamProbes.values()]).toEqual([
        expect.objectContaining({ state: "failed", settledAt: expect.any(Number) }),
      ]);

      const replacement = vi.fn(async () => ({
        audio: false,
        subtitle: false,
        audioTracks: [],
      }));
      transcoder.probeStreams = replacement;
      await expect(registry.sourceInfoFor(
        "missing-adapter",
        "https://provider.example/missing",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(replacement).not.toHaveBeenCalled();

      await expect(registry.sourceInfoFor(
        "other",
        "https://provider.example/other",
      )).resolves.toEqual({ audioTracks: [], durationSeconds: null });
      expect(replacement).toHaveBeenCalledTimes(1);
    } finally {
      await registry.stop();
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reserve admission or spawn a probe for an already-aborted waiter", async () => {
    const controlled = controlledProbeAdapter();
    const fixture = probeRegistry(controlled.probe, 1);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(fixture.registry.sourceInfoFor(
        "already-aborted",
        "https://provider.example/aborted",
        { retryFailed: true, signal: controller.signal },
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(controlled.probe).not.toHaveBeenCalled();
      expect((fixture.registry as unknown as { activeProbes: number }).activeProbes).toBe(0);
      expect((fixture.registry as unknown as {
        streamProbes: Map<string, unknown>;
      }).streamProbes.size).toBe(0);

      const admitted = fixture.registry.sourceInfoFor(
        "next",
        "https://provider.example/next",
      );
      expect(controlled.probe).toHaveBeenCalledTimes(1);
      controlled.records[0]!.close();
      controlled.records[0]!.settle({
        audio: false,
        subtitle: false,
        audioTracks: [],
      });
      await expect(admitted).resolves.toEqual({
        audioTracks: [],
        durationSeconds: null,
      });
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

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
      const subtitleAvailable = fixture.registry.subtitleAvailableFor(
        "shared",
        "https://provider.example/video",
      );
      expect(probe).toHaveBeenCalledTimes(1);
      release!({
        audio: true,
        subtitle: true,
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
      await expect(subtitleAvailable).resolves.toBe(true);

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

  it("retries only a cooled-down failed probe and coalesces its replacement", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseReplacement: ((value: {
      audio: boolean;
      subtitle: boolean;
      audioTracks: never[];
    }) => void) | null = null;
    const synchronouslyFailed = {
      then(resolve: (value: null) => unknown) {
        resolve(null);
        return Promise.resolve(null);
      },
    } as unknown as ReturnType<NonNullable<Transcoder["probeStreams"]>>;
    const probe = vi.fn()
      .mockReturnValueOnce(synchronouslyFailed)
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseReplacement = resolve;
      }));
    const fixture = probeRegistry(probe, 1);
    try {
      await expect(fixture.registry.sourceInfoFor(
        "retry",
        "https://provider.example/video",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(1);

      now += 4_999;
      await expect(fixture.registry.sourceInfoFor(
        "retry",
        "https://provider.example/video",
        { retryFailed: true },
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(1);

      now += 2;
      await fixture.registry.sourceInfoFor("retry", "https://provider.example/video");
      expect(probe).toHaveBeenCalledTimes(1);
      const firstRetry = fixture.registry.sourceInfoFor(
        "retry",
        "https://provider.example/video",
        { retryFailed: true },
      );
      const sharedRetry = fixture.registry.sourceInfoFor(
        "retry",
        "https://provider.example/video",
        { retryFailed: true },
      );
      expect(probe).toHaveBeenCalledTimes(2);
      releaseReplacement!({ audio: false, subtitle: false, audioTracks: [] });
      await expect(Promise.all([firstRetry, sharedRetry])).resolves.toEqual([
        { audioTracks: [], durationSeconds: null },
        { audioTracks: [], durationSeconds: null },
      ]);

      now += 60_000;
      await expect(fixture.registry.sourceInfoFor(
        "retry",
        "https://provider.example/video",
        { retryFailed: true },
      )).resolves.toEqual({ audioTracks: [], durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("caches a synchronous probe throw and releases its admission slot", async () => {
    let now = 30_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const probe = vi.fn((upstreamUrl: string) => {
      if (upstreamUrl.endsWith("/throw") && probe.mock.calls.length === 1) {
        throw new Error("synchronous probe failure");
      }
      return Promise.resolve({ audio: false, subtitle: false, audioTracks: [] });
    });
    const fixture = probeRegistry(probe, 1);
    try {
      await expect(fixture.registry.sourceInfoFor(
        "throw",
        "https://provider.example/throw",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      await expect(fixture.registry.sourceInfoFor(
        "throw",
        "https://provider.example/throw",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(1);

      await expect(fixture.registry.sourceInfoFor(
        "other",
        "https://provider.example/other",
      )).resolves.toEqual({ audioTracks: [], durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(2);

      now += 5_001;
      await expect(fixture.registry.sourceInfoFor(
        "throw",
        "https://provider.example/throw",
        { retryFailed: true },
      )).resolves.toEqual({ audioTracks: [], durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("preserves a retryable failed entry while the global probe budget is full", async () => {
    let now = 20_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseBlocker: ((value: {
      audio: boolean;
      subtitle: boolean;
      audioTracks: never[];
    }) => void) | null = null;
    let failedCalls = 0;
    const probe = vi.fn((upstreamUrl: string) => {
      if (upstreamUrl.endsWith("/failed")) {
        failedCalls += 1;
        return Promise.resolve(failedCalls === 1
          ? null
          : { audio: false, subtitle: false, audioTracks: [] });
      }
      return new Promise((resolve) => {
        releaseBlocker = resolve;
      });
    });
    const fixture = probeRegistry(probe, 1);
    try {
      await fixture.registry.sourceInfoFor("failed", "https://provider.example/failed");
      const blocker = fixture.registry.sourceInfoFor(
        "blocker",
        "https://provider.example/blocker",
      );
      expect(probe).toHaveBeenCalledTimes(2);
      now += 5_001;

      await expect(fixture.registry.sourceInfoFor(
        "failed",
        "https://provider.example/failed",
        { retryFailed: true },
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(2);

      releaseBlocker!({ audio: false, subtitle: false, audioTracks: [] });
      await blocker;
      await expect(fixture.registry.sourceInfoFor(
        "failed",
        "https://provider.example/failed",
        { retryFailed: true },
      )).resolves.toEqual({ audioTracks: [], durationSeconds: null });
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("uses the slow lane only for an eligible explicit retry and caches successful zero-audio metadata", async () => {
    let now = 40_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const controlled = controlledProbeAdapter();
    const fixture = probeRegistry(controlled.probe, 1);
    try {
      const initial = fixture.registry.sourceInfoFor(
        "slow-retry",
        "https://provider.example/video",
      );
      expect(controlled.records[0]?.timeoutMs).toBe(5_000);
      controlled.records[0]!.close();
      controlled.records[0]!.settle(null);
      await expect(initial).resolves.toEqual({
        audioTracks: null,
        durationSeconds: null,
      });

      now += 5_001;
      const retried = fixture.registry.sourceInfoFor(
        "slow-retry",
        "https://provider.example/video",
        { retryFailed: true },
      );
      expect(controlled.records[1]?.timeoutMs).toBe(15_000);
      controlled.records[1]!.close();
      controlled.records[1]!.settle({
        audio: false,
        subtitle: false,
        audioTracks: [],
        durationSeconds: 596.457379,
      });
      await expect(retried).resolves.toEqual({
        audioTracks: [],
        durationSeconds: 596.457379,
      });

      now += 60_000;
      await expect(fixture.registry.sourceInfoFor(
        "slow-retry",
        "https://provider.example/video",
        { retryFailed: true },
      )).resolves.toEqual({
        audioTracks: [],
        durationSeconds: 596.457379,
      });
      expect(controlled.probe).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("lets one cancelled waiter detach without cancelling a coalesced consumer", async () => {
    const controlled = controlledProbeAdapter();
    const fixture = probeRegistry(controlled.probe, 1);
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const first = fixture.registry.sourceInfoFor(
        "shared-waiters",
        "https://provider.example/video",
        { signal: firstController.signal },
      );
      const second = fixture.registry.sourceInfoFor(
        "shared-waiters",
        "https://provider.example/video",
        { signal: secondController.signal },
      );
      expect(controlled.probe).toHaveBeenCalledTimes(1);
      firstController.abort();
      await expect(first).resolves.toEqual({
        audioTracks: null,
        durationSeconds: null,
      });
      expect(controlled.records[0]!.signal?.aborted).toBe(false);
      expect(controlled.records[0]!.child.kill).not.toHaveBeenCalled();

      controlled.records[0]!.close();
      controlled.records[0]!.settle({
        audio: true,
        subtitle: false,
        audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
        durationSeconds: 120,
      });
      await expect(second).resolves.toEqual({
        audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
        durationSeconds: 120,
      });
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("retains global admission after cancellation until the reported probe child closes", async () => {
    const controlled = controlledProbeAdapter(true);
    const fixture = probeRegistry(controlled.probe, 1);
    const controller = new AbortController();
    try {
      const cancelled = fixture.registry.sourceInfoFor(
        "cancelled-probe",
        "https://provider.example/first",
        { signal: controller.signal },
      );
      controller.abort();
      await expect(cancelled).resolves.toEqual({
        audioTracks: null,
        durationSeconds: null,
      });
      expect(controlled.records[0]!.child.kill).toHaveBeenCalledWith("SIGKILL");

      await expect(fixture.registry.sourceInfoFor(
        "too-early",
        "https://provider.example/second",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      expect(controlled.probe).toHaveBeenCalledTimes(1);

      controlled.records[0]!.close();
      const admitted = fixture.registry.sourceInfoFor(
        "after-close",
        "https://provider.example/second",
      );
      expect(controlled.probe).toHaveBeenCalledTimes(2);
      controlled.records[1]!.close();
      controlled.records[1]!.settle({
        audio: false,
        subtitle: false,
        audioTracks: [],
      });
      await expect(admitted).resolves.toEqual({
        audioTracks: [],
        durationSeconds: null,
      });
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("cancels a killed probe and never resurrects its late completion", async () => {
    const controlled = controlledProbeAdapter();
    const fixture = probeRegistry(controlled.probe, 1);
    try {
      const stale = fixture.registry.sourceInfoFor(
        "killed-probe",
        "https://provider.example/video",
      );
      await fixture.registry.kill("killed-probe");
      await expect(stale).resolves.toEqual({
        audioTracks: null,
        durationSeconds: null,
      });
      expect(controlled.records[0]!.signal?.aborted).toBe(true);
      expect(controlled.records[0]!.child.kill).toHaveBeenCalledWith("SIGKILL");

      controlled.records[0]!.settle({
        audio: true,
        subtitle: false,
        audioTracks: [{ index: 0, language: "old", label: "Stale", default: true }],
        durationSeconds: 999,
      });
      controlled.records[0]!.close();
      await Promise.resolve();
      const fresh = fixture.registry.sourceInfoFor(
        "killed-probe",
        "https://provider.example/video",
      );
      expect(controlled.probe).toHaveBeenCalledTimes(2);
      controlled.records[1]!.close();
      controlled.records[1]!.settle({
        audio: true,
        subtitle: false,
        audioTracks: [{ index: 0, language: "eng", label: "Fresh", default: true }],
        durationSeconds: 120,
      });
      await expect(fresh).resolves.toEqual({
        audioTracks: [{ index: 0, language: "eng", label: "Fresh", default: true }],
        durationSeconds: 120,
      });
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("cancels probe-only work when the registry shuts down", async () => {
    const controlled = controlledProbeAdapter();
    const fixture = probeRegistry(controlled.probe, 1);
    try {
      const pending = fixture.registry.sourceInfoFor(
        "shutdown-probe",
        "https://provider.example/video",
      );
      await fixture.registry.stop();
      await expect(pending).resolves.toEqual({
        audioTracks: null,
        durationSeconds: null,
      });
      expect(controlled.records[0]!.signal?.aborted).toBe(true);
      expect(controlled.records[0]!.child.kill).toHaveBeenCalledWith("SIGKILL");
      controlled.records[0]!.settle(null);
      controlled.records[0]!.close();
    } finally {
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("lets startup join a slow manual retry for only its fast budget without duplicating or cancelling it", async () => {
    vi.useFakeTimers({ now: 70_000 });
    const retryResult = {
      audio: true,
      subtitle: false,
      audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
      durationSeconds: 596.457379,
    };
    let resolveRetry: ((value: {
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
    const probe = vi.fn<NonNullable<Transcoder["probeStreams"]>>()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce((_url, options) => {
        expect(options?.timeoutMs).toBe(15_000);
        return new Promise((resolve) => {
          resolveRetry = resolve;
        });
      });
    let spawnedArgs: string[] | null = null;
    const hlsChild = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: null;
    };
    hlsChild.kill = vi.fn(() => {
      hlsChild.emit("exit", 0);
      hlsChild.emit("close", 0);
      return true;
    });
    hlsChild.stderr = null;
    const fixture = probeRegistry(probe, 2, (args) => {
      spawnedArgs = args;
      const outputDir = dirname(args.at(-1)!);
      writeFileSync(join(outputDir, "stream.m3u8"), "#EXTM3U\n");
      writeFileSync(join(outputDir, "480p_seg_00000.ts"), "segment");
      return hlsChild as unknown as ChildProcess;
    });
    const waitForProbeTarget = fixture.registry as unknown as {
      waitForProbe(
        sessionId: string,
        entry: unknown,
        options: { retryFailed?: boolean; signal?: AbortSignal },
      ): Promise<unknown>;
    };
    const originalWaitForProbe = waitForProbeTarget.waitForProbe.bind(fixture.registry);
    let markStartupWaiterAttached: (() => void) | null = null;
    const startupWaiterAttached = new Promise<void>((resolve) => {
      markStartupWaiterAttached = resolve;
    });
    let observeStartupWaiter = false;
    const waitForProbeSpy = vi.spyOn(waitForProbeTarget, "waitForProbe")
      .mockImplementation((sessionId, entry, options) => {
        const result = originalWaitForProbe(sessionId, entry, options);
        if (
          observeStartupWaiter &&
          sessionId === "startup-joins" &&
          options.retryFailed !== true
        ) {
          markStartupWaiterAttached!();
        }
        return result;
      });
    let retry: Promise<{
      audioTracks: Array<{
        index: number;
        language: string | null;
        label: string | null;
        default: boolean;
      }> | null;
      durationSeconds: number | null;
    }> | null = null;
    let startup: Promise<string> | null = null;
    try {
      await expect(fixture.registry.sourceInfoFor(
        "startup-joins",
        "https://provider.example/video",
      )).resolves.toEqual({ audioTracks: null, durationSeconds: null });
      vi.setSystemTime(75_001);

      retry = fixture.registry.sourceInfoFor(
        "startup-joins",
        "https://provider.example/video",
        { retryFailed: true },
      );
      const retryOutcome = observe(retry);
      observeStartupWaiter = true;
      startup = fixture.registry.ensureJob(
        "startup-joins",
        "https://provider.example/video",
        { quality: "480p" },
      );
      let startupSettled = false;
      const startupOutcome = observe(startup).finally(() => {
        startupSettled = true;
      });
      expect(probe).toHaveBeenCalledTimes(2);
      await startupWaiterAttached;
      const cachedProbe = [...(
        fixture.registry as unknown as {
          streamProbes: Map<string, { waiters: number }>;
        }
      ).streamProbes.values()][0];
      expect(cachedProbe?.waiters).toBe(2);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(startupSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(startupOutcome).resolves.toEqual({
        status: "fulfilled",
        value: expect.any(String),
      });
      expect(spawnedArgs).not.toBeNull();
      expect(probe).toHaveBeenCalledTimes(2);
      expect(probe.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);

      resolveRetry!(retryResult);
      await expect(retryOutcome).resolves.toEqual({
        status: "fulfilled",
        value: {
          audioTracks: [{ index: 0, language: "eng", label: "English", default: true }],
          durationSeconds: 596.457379,
        },
      });
    } finally {
      try {
        resolveRetry?.(retryResult);
        await vi.advanceTimersByTimeAsync(17_000);
        await Promise.allSettled([
          ...(retry == null ? [] : [retry]),
          ...(startup == null ? [] : [startup]),
        ]);
        await fixture.registry.stop();
      } finally {
        try {
          fixture.database.close();
          rmSync(fixture.dataDir, { recursive: true, force: true });
        } finally {
          try {
            waitForProbeSpy.mockRestore();
          } finally {
            vi.useRealTimers();
          }
        }
      }
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


describe("current generation retention", () => {
  async function leaseFixture() {
    const fixture = capacityRegistryFixture(2);
    const dir = await fixture.registry.ensureJob("leased", "https://provider.example/source");
    fixture.children[0]!.finish(0);
    writeFileSync(join(dir, "480p.m3u8"), "#EXTM3U\n");
    const generation = fixture.registry.generationFor("leased", dir)!;
    const job = (fixture.registry as unknown as { jobs: Map<string, { lastAccess: number; failed: boolean; cancelled: boolean; disposed: boolean }> }).jobs.get("leased")!;
    return { ...fixture, dir, generation, job };
  }
  async function cleanup(f: Awaited<ReturnType<typeof leaseFixture>>) {
    await f.registry.stop(); f.database.close(); rmSync(f.dataDir, { recursive: true, force: true });
  }
  it("retains a completed current generation over repeated pause intervals without creating work", async () => {
    const f = await leaseFixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (let i = 0; i < 8; i += 1) {
        now += 30_000;
        expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(true);
        expect(f.job.lastAccess).toBe(now);
      }
      expect(f.children).toHaveLength(1);
      expect(existsSync(f.dir)).toBe(true);
    } finally { clock.mockRestore(); await cleanup(f); }
  });
  it.each(["failed", "cancelled", "disposed"] as const)("does not retain a %s job", async (flag) => {
    const f = await leaseFixture();
    try {
      const before = f.job.lastAccess; f.job[flag] = true;
      expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(false);
      expect(f.job.lastAccess).toBe(before);
      f.job[flag] = false;
    } finally { await cleanup(f); }
  });
  it("does not resurrect idle output before the next reaper tick", async () => {
    const f = await leaseFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.job.lastAccess + 120_001);
    try {
      const before = f.job.lastAccess;
      expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(false);
      expect(f.job.lastAccess).toBe(before);
    } finally { clock.mockRestore(); await cleanup(f); }
  });
  it.each(["wrong generation", "wrong session", "missing asset", "non-playlist"])("rejects %s without touching the owner", async (kind) => {
    const f = await leaseFixture();
    try {
      const before = f.job.lastAccess;
      const asset = kind === "missing asset" ? "360p.m3u8" : kind === "non-playlist" ? "480p_seg_00000.ts" : "480p.m3u8";
      expect(f.registry.touchCurrentGeneration(kind === "wrong session" ? "other" : "leased", asset,
        kind === "wrong generation" ? "transcode-wrong" : f.generation)).toBe(false);
      expect(f.job.lastAccess).toBe(before);
    } finally { await cleanup(f); }
  });
  it("does not extend retired output or touch its replacement", async () => {
    const f = await leaseFixture();
    try {
      const replacement = await f.registry.ensureJob("leased", "https://provider.example/source", { quality: "360p" });
      f.children[1]!.finish(0);
      const before = f.job.lastAccess;
      expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(false);
      expect(f.job.lastAccess).toBe(before);
      expect(f.registry.generationFor("leased", replacement)).not.toBe(f.generation);
      expect(f.children).toHaveLength(2);
    } finally { await cleanup(f); }
  });
  it("reaps the retained generation normally after renewal stops", async () => {
    const f = await leaseFixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const prepare = f.database.sqlite.prepare.bind(f.database.sqlite);
    const database = vi.spyOn(f.database.sqlite, "prepare").mockImplementation((sql) =>
      sql === "SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?"
        ? { get: () => ({ revoked_at: null, expires_at: "9999-12-31T00:00:00.000Z" }) } as never
        : prepare(sql));
    try {
      now += 30_000;
      expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(true);
      const reap = () => (f.registry as unknown as { reap(): void }).reap();
      now += 119_999; reap(); expect(existsSync(f.dir)).toBe(true);
      now += 2; reap();
      await vi.waitFor(() => expect(existsSync(f.dir)).toBe(false));
      expect(f.registry.touchCurrentGeneration("leased", "480p.m3u8", f.generation)).toBe(false);
      expect(f.children).toHaveLength(1);
    } finally { database.mockRestore(); clock.mockRestore(); await cleanup(f); }
  });

});
