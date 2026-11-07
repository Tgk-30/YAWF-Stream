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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it.each(["exit", "error"] as const)("replaces same-options output after a ready job reports %s", async (failure) => {
    const fixture = capacityRegistryFixture(2);
    try {
      const original = await fixture.registry.ensureJob("recover", "https://provider.example/source");
      const originalGeneration = fixture.registry.generationFor("recover", original)!;
      if (failure === "exit") fixture.children[0]!.finish(1);
      else fixture.children[0]!.child.emit("error", new Error("post-readiness failure"));

      const [replacement, coalesced] = await Promise.all([
        fixture.registry.ensureJob("recover", "https://provider.example/source"),
        fixture.registry.ensureJob("recover", "https://provider.example/source"),
      ]);
      expect(replacement).not.toBe(original);
      expect(coalesced).toBe(replacement);
      expect(fixture.children).toHaveLength(2);
      expect(fixture.registry.dirFor("recover")).toBe(replacement);
      expect(fixture.registry.generationFor("recover", replacement)).not.toBe(originalGeneration);
      expect(fixture.registry.dirForAsset("recover", "stream.m3u8", originalGeneration)).toBe(original);
      expect(fixture.children[0]!.kills).toBeGreaterThan(0);
      expect(await fixture.registry.ensureJob("recover", "https://provider.example/source")).toBe(replacement);
      expect(fixture.children).toHaveLength(2);
    } finally {
      fixture.children.forEach((record) => record.finish(0));
      await fixture.registry.stop();
      expect(fixture.children.every((record) => !existsSync(record.dir))).toBe(true);
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a failed live child's slot until close before coalescing recovery", async () => {
    const fixture = capacityRegistryFixture(1);
    try {
      const original = await fixture.registry.ensureJob("recover", "https://provider.example/source");
      fixture.children[0]!.child.emit("error", new Error("post-readiness failure"));
      await expect(fixture.registry.ensureJob("recover", "https://provider.example/source"))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(fixture.children).toHaveLength(1);
      expect(fixture.children[0]!.running).toBe(true);
      fixture.children[0]!.finish(1);
      const [replacement, coalesced] = await Promise.all([
        fixture.registry.ensureJob("recover", "https://provider.example/source"),
        fixture.registry.ensureJob("recover", "https://provider.example/source"),
      ]);
      expect(replacement).not.toBe(original);
      expect(coalesced).toBe(replacement);
      expect(fixture.children).toHaveLength(2);
      await expect(fixture.registry.ensureJob("overflow", "https://provider.example/other"))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(fixture.children).toHaveLength(2);
    } finally {
      fixture.children.forEach((record) => record.finish(0));
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("cancels a coalesced failed-job replacement without leaking its staged output", async () => {
    const fixture = stagedRegistryFixture();
    try {
      const original = await fixture.registry.ensureJob("recover", "https://provider.example/source");
      fixture.children[0]!.child.emit("exit", 1);
      const first = observe(fixture.registry.ensureJob("recover", "https://provider.example/source"));
      const second = observe(fixture.registry.ensureJob("recover", "https://provider.example/source"));
      await vi.waitFor(() => expect(fixture.children).toHaveLength(2), { timeout: 300 });
      await fixture.registry.kill("recover");
      expect(await first).toMatchObject({ status: "rejected", error: { statusCode: 410 } });
      expect(await second).toMatchObject({ status: "rejected", error: { statusCode: 410 } });
      expect(fixture.registry.dirFor("recover")).toBeNull();
      expect(fixture.children).toHaveLength(2);
      expect(existsSync(original)).toBe(false);
      expect(fixture.children.every((record) => record.kills > 0 && !existsSync(record.dir))).toBe(true);
    } finally {
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("frees admission after normal FFmpeg exit while cached output remains playable", async () => {
    const fixture = capacityRegistryFixture(1);
    try {
      const cached = await fixture.registry.ensureJob(
        "completed",
        "https://provider.example/first",
      );
      fixture.children[0]!.finish(0);
      expect(await fixture.registry.ensureJob("completed", "https://provider.example/first")).toBe(cached);
      expect(fixture.children).toHaveLength(1);
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

describe("owned pending transcode cancellation", () => {
  function fixture(options: {
    max?: number;
    readyFirst?: boolean;
    holdSpawn?: number;
    probe?: Transcoder["probeStreams"];
    onSpawn?: (index: number) => void;
  } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-owned-preparation-"));
    const database = new AppDatabase(":memory:");
    const children: Array<{
      child: ChildProcess; dir: string; signals: unknown[]; running: boolean;
      ready: () => void; finish: () => void;
    }> = [];
    let maximum = 0;
    const registry = new TranscodeRegistry(database, {
      dataDir, maxTranscodes: options.max ?? 1,
      transcodeVideoEncoder: "libx264", transcodeStartTimeoutMs: 60_000,
    } as ServerConfig, {
      async detect() { return true; },
      probeStreams: options.probe,
      spawnHls(args) {
        const dir = dirname(args.at(-1)!);
        const emitter = new EventEmitter() as EventEmitter & { kill: (signal?: unknown) => boolean; stderr: null };
        const record = {
          child: emitter as unknown as ChildProcess, dir, signals: [] as unknown[], running: true,
          ready: () => {
            writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n");
            for (const quality of ["1080p", "720p", "480p", "360p"]) {
              writeFileSync(join(dir, `${quality}_seg_00000.ts`), "segment");
            }
          },
          finish: () => {
            if (!record.running) return;
            record.running = false;
            emitter.emit("exit", 0); emitter.emit("close", 0);
          },
        };
        emitter.kill = (signal) => { record.signals.push(signal); return record.running; };
        emitter.stderr = null;
        children.push(record);
        maximum = Math.max(maximum, children.filter((child) => child.running).length);
        if (children.length !== options.holdSpawn && (options.readyFirst || children.length > 1)) record.ready();
        options.onSpawn?.(children.length);
        return record.child;
      },
    });
    const cleanup = async () => {
      children.forEach((child) => child.finish());
      await registry.stop(); database.close(); rmSync(dataDir, { recursive: true, force: true });
    };
    return { registry, children, dataDir, cleanup, maximum: () => maximum };
  }

  function captured(promise: Promise<string>) {
    let result: Awaited<ReturnType<typeof observe<string>>> | undefined;
    const settled = observe(promise).then((value) => { result = value; return value; });
    return { settled, result: () => result };
  }

  async function cancelled(outcome: ReturnType<typeof captured>) {
    await vi.waitFor(() => expect(outcome.result()).toMatchObject({
      status: "rejected", error: { name: "AbortError", code: "TRANSCODE_PREPARATION_CANCELLED", statusCode: 499 },
    }), { timeout: 400 });
  }

  it.each([0, 75])("recovers max1 after abandoned startup exits at successor offset %s", async (offset) => {
    const f = fixture(); const owner = new AbortController();
    try {
      const first = captured(f.registry.ensureJob("owned", "https://provider.example/video", {}, { signal: owner.signal }));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      owner.abort(); await cancelled(first);
      const next = captured(f.registry.ensureJob("owned", "https://provider.example/video", { startSeconds: offset }));
      await vi.waitFor(() => expect(f.children[0]!.signals).toContain("SIGTERM"));
      expect(f.children).toHaveLength(1); expect(next.result()).toBeUndefined();
      f.children[0]!.finish();
      await expect(next.settled).resolves.toMatchObject({ status: "fulfilled" });
      expect(f.children).toHaveLength(2); expect(f.maximum()).toBe(1);
      expect(existsSync(f.children[0]!.dir)).toBe(false);
      // Late duplicate terminal callbacks must not release the new child's slot.
      f.children[0]!.child.emit("exit", 0); owner.abort();
      await expect(f.registry.ensureJob("other", "https://provider.example/other"))
        .rejects.toMatchObject({ statusCode: 503 });
    } finally { await f.cleanup(); }
  });

  it("detaches one signal owner without cancelling another coalesced owner", async () => {
    const f = fixture(); const a = new AbortController(); const b = new AbortController();
    try {
      const first = captured(f.registry.ensureJob("shared", "https://provider.example/video", {}, { signal: a.signal }));
      const second = captured(f.registry.ensureJob("shared", "https://provider.example/video", {}, { signal: b.signal }));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      a.abort(); await cancelled(first);
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready(); const dir = f.children[0]!.dir;
      await expect(second.settled).resolves.toMatchObject({ status: "fulfilled", value: dir });
      b.abort(); expect(f.children[0]!.signals).toEqual([]);
      expect(f.registry.dirFor("shared")).toBe(dir);
    } finally { await f.cleanup(); }
  });

  it("cancels staged work only after both coalesced signal owners abort", async () => {
    const f = fixture(); const a = new AbortController(); const b = new AbortController();
    try {
      const first = captured(f.registry.ensureJob("shared", "https://provider.example/video", {}, { signal: a.signal }));
      const second = captured(f.registry.ensureJob("shared", "https://provider.example/video", {}, { signal: b.signal }));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      a.abort(); await cancelled(first);
      expect(second.result()).toBeUndefined(); expect(f.children[0]!.signals).toEqual([]);
      b.abort(); await cancelled(second);
      await vi.waitFor(() => expect(f.children[0]!.signals).toContain("SIGTERM"));
      const successor = captured(f.registry.ensureJob("shared", "https://provider.example/video", { startSeconds: 90 }));
      expect(successor.result()).toBeUndefined(); expect(f.children).toHaveLength(1);
      f.children[0]!.finish();
      await expect(successor.settled).resolves.toMatchObject({ status: "fulfilled" });
      expect(f.children).toHaveLength(2); expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("protects a coalesced signal-less legacy owner", async () => {
    const f = fixture(); const owner = new AbortController();
    try {
      const first = captured(f.registry.ensureJob("shared", "https://provider.example/video", {}, { signal: owner.signal }));
      const legacy = captured(f.registry.ensureJob("shared", "https://provider.example/video"));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      owner.abort(); await cancelled(first);
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready();
      await expect(legacy.settled).resolves.toMatchObject({ status: "fulfilled", value: f.children[0]!.dir });
    } finally { await f.cleanup(); }
  });

  it("cancels a mismatched queued request without cancelling older owners", async () => {
    const f = fixture(); const queuedOwner = new AbortController();
    try {
      const older = captured(f.registry.ensureJob("queued", "https://provider.example/video"));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      const queued = captured(f.registry.ensureJob("queued", "https://provider.example/video", { startSeconds: 90 }, { signal: queuedOwner.signal }));
      queuedOwner.abort(); await cancelled(queued);
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready();
      await expect(older.settled).resolves.toMatchObject({ status: "fulfilled", value: f.children[0]!.dir });
      expect(f.children).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it.each(["already-aborted", "mkdir-pending"])("does not spawn for %s cancellation", async (stage) => {
    const f = fixture(); const owner = new AbortController();
    try {
      if (stage === "already-aborted") owner.abort();
      const pending = captured(f.registry.ensureJob("early", "https://provider.example/video", {}, { signal: owner.signal }));
      owner.abort(); await cancelled(pending);
      await f.registry.stop(); expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  it("detaches only the creation's shared probe waiter and suppresses late spawn", async () => {
    let settle!: (value: { audio: boolean; subtitle: boolean; audioTracks: [] }) => void;
    let sharedSignal: AbortSignal | undefined;
    const probe: NonNullable<Transcoder["probeStreams"]> = (_url, options) => {
      sharedSignal = options?.signal;
      return new Promise((resolve) => { settle = resolve; });
    };
    const f = fixture({ max: 2, probe }); const owner = new AbortController();
    const calls = vi.spyOn(f.registry as unknown as { probeStreams: (...args: unknown[]) => Promise<unknown> }, "probeStreams");
    try {
      const inventory = f.registry.sourceInfoFor("probe", "https://provider.example/video");
      const pending = captured(f.registry.ensureJob("probe", "https://provider.example/video", {}, { signal: owner.signal }));
      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
      owner.abort(); await cancelled(pending);
      expect(sharedSignal?.aborted).toBe(false);
      settle({ audio: false, subtitle: false, audioTracks: [] });
      await inventory; await f.registry.stop();
      expect(f.children).toHaveLength(0);
    } finally { calls.mockRestore(); await f.cleanup(); }
  });

  it("cancels at spawn without publishing or retiring the active previous assets", async () => {
    const owner = new AbortController();
    const f = fixture({ max: 2, readyFirst: true, onSpawn: (index) => { if (index === 2) owner.abort(); } });
    try {
      const original = await f.registry.ensureJob("active", "https://provider.example/video");
      const generation = f.registry.generationFor("active", original);
      const replacement = captured(f.registry.ensureJob("active", "https://provider.example/video", { quality: "360p" }, { signal: owner.signal }));
      await cancelled(replacement);
      await vi.waitFor(() => expect(f.children[1]!.signals).toContain("SIGTERM"));
      f.children[1]!.finish();
      await f.registry.ensureJob("active", "https://provider.example/video");
      expect(f.registry.dirFor("active")).toBe(original);
      expect(f.registry.generationFor("active", original)).toBe(generation);
      expect(f.children[0]!.signals).toEqual([]);
      expect(existsSync(join(original, "stream.m3u8"))).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("handles a late child error during synchronous spawn-abort disposal", async () => {
    const owner = new AbortController();
    const f = fixture({ onSpawn: () => owner.abort() });
    try {
      const pending = captured(f.registry.ensureJob("spawn-abort", "https://provider.example/video", {}, { signal: owner.signal }));
      await cancelled(pending);
      await vi.waitFor(() => expect(f.children[0]!.signals).toContain("SIGTERM"));
      expect(() => f.children[0]!.child.emit("error", new Error("late spawn failure"))).not.toThrow();
      expect(f.registry.dirFor("spawn-abort")).toBeNull();
      f.children[0]!.finish();
      await expect(f.registry.ensureJob("spawn-abort", "https://provider.example/video", { startSeconds: 90 }))
        .resolves.toEqual(expect.any(String));
      expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("reclaims only the abandoned session without interrupting another viewer", async () => {
    const owner = new AbortController(); const f = fixture({ max: 2, readyFirst: true, holdSpawn: 2 });
    try {
      const other = await f.registry.ensureJob("other-viewer", "https://provider.example/other");
      const pending = captured(f.registry.ensureJob("abandoned", "https://provider.example/video", {}, { signal: owner.signal }));
      await vi.waitFor(() => expect(f.children).toHaveLength(2));
      owner.abort(); await cancelled(pending);
      await vi.waitFor(() => expect(f.children[1]!.signals).toContain("SIGTERM"));
      expect(f.children[0]!.signals).toEqual([]);
      f.children[1]!.finish();
      await f.registry.ensureJob("abandoned", "https://provider.example/video", { startSeconds: 90 });
      expect(f.registry.dirFor("other-viewer")).toBe(other);
      expect(f.children[0]!.signals).toEqual([]); expect(f.maximum()).toBe(2);
    } finally { await f.cleanup(); }
  });

  it("detaches an aborted subtitle waiter without cancelling shared inventory", async () => {
    let settle!: (value: { audio: boolean; subtitle: boolean; audioTracks: [] }) => void;
    let sharedSignal: AbortSignal | undefined;
    const f = fixture({ probe: (_url, options) => {
      sharedSignal = options?.signal;
      return new Promise((resolve) => { settle = resolve; });
    } });
    const owner = new AbortController();
    try {
      const inventory = f.registry.sourceInfoFor("subtitle", "https://provider.example/video");
      let subtitle: boolean | null | undefined;
      const pending = f.registry.subtitleAvailableFor("subtitle", "https://provider.example/video", { signal: owner.signal })
        .then((value) => { subtitle = value; });
      owner.abort();
      await vi.waitFor(() => expect(subtitle).toBeNull(), { timeout: 400 });
      expect(sharedSignal?.aborted).toBe(false);
      settle({ audio: false, subtitle: true, audioTracks: [] });
      await inventory; await pending; expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  // The production disposal wait is bounded at four seconds; allow CI margin
  // without weakening the invariant that an unreported exit retains capacity.
  it("keeps a stubborn cancelled child's permit through bounded cleanup", async () => {
    const f = fixture(); const owner = new AbortController();
    try {
      const first = captured(f.registry.ensureJob("stubborn", "https://provider.example/video", {}, { signal: owner.signal }));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      owner.abort(); await cancelled(first);
      await expect(f.registry.ensureJob("stubborn", "https://provider.example/video", { startSeconds: 90 }))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(f.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(f.children[0]!.running).toBe(true); expect(f.children).toHaveLength(1);
      f.children[0]!.finish();
      await expect(f.registry.ensureJob("stubborn", "https://provider.example/video", { startSeconds: 90 })).resolves.toEqual(expect.any(String));
      expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  }, 8000);

  it("does not reclaim a published generation after a late owner abort", async () => {
    const f = fixture({ readyFirst: true }); const owner = new AbortController();
    try {
      const original = await f.registry.ensureJob("published", "https://provider.example/video", {}, { signal: owner.signal });
      owner.abort();
      await expect(f.registry.ensureJob("published", "https://provider.example/video", { startSeconds: 90 })).rejects.toMatchObject({ statusCode: 503 });
      expect(f.registry.dirFor("published")).toBe(original);
      expect(f.children[0]!.signals).toEqual([]);
    } finally { await f.cleanup(); }
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


describe("issued transcode preparation ownership", () => {
  function fixture(options: { max?: number; ready?: boolean; exits?: boolean; timeout?: number } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-issued-preparation-"));
    const database = new AppDatabase(":memory:");
    let ready = options.ready !== false;
    const children: Array<{
      child: ChildProcess; dir: string; signals: unknown[]; running: boolean;
      ready(): void; finish(): void;
    }> = [];
    let maximum = 0;
    const config = {
      dataDir, maxTranscodes: options.max ?? 1,
      transcodeVideoEncoder: "libx264", transcodeStartTimeoutMs: options.timeout ?? 1000,
    } as ServerConfig;
    const transcoder: Transcoder = {
      async detect() { return true; },
      spawnHls(args) {
        const dir = dirname(args.at(-1)!);
        const child = new EventEmitter() as EventEmitter & { kill: (signal: unknown) => boolean; stderr: null };
        const record = {
          child: child as unknown as ChildProcess, dir, signals: [] as unknown[], running: true,
          ready() {
            writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n480p.m3u8\n");
            for (const quality of ["1080p", "720p", "480p", "360p"]) {
              writeFileSync(join(dir, `${quality}.m3u8`), "#EXTM3U\n");
              writeFileSync(join(dir, `${quality}_seg_00000.ts`), fakeMpegTsSegment());
              writeFileSync(join(dir, `${quality}_subtitles.m3u8`), "#EXTM3U\n");
              writeFileSync(join(dir, `${quality}0.vtt`), "WEBVTT\n\n");
            }
          },
          finish() {
            if (!record.running) return;
            record.running = false; child.emit("exit", 0); child.emit("close", 0);
          },
        };
        child.kill = (signal) => {
          record.signals.push(signal);
          // A later event, never kill()'s return value, releases the permit.
          if (options.exits !== false) queueMicrotask(() => record.finish());
          return record.running;
        };
        child.stderr = null;
        children.push(record);
        maximum = Math.max(maximum, children.filter((item) => item.running).length);
        if (ready) record.ready();
        return record.child;
      },
    };
    const registry = new TranscodeRegistry(database, config, transcoder);
    const acquire = (id: string, startSeconds = 0, session = "session", signal?: AbortSignal) =>
      registry.acquirePreparation(session, id, "https://provider.example/video", { startSeconds }, { signal });
    const register = (id: string, session = "session") => registry.registerPreparation(session, id);
    const cleanup = async () => {
      children.forEach((item) => item.finish());
      await registry.stop(); database.close(); rmSync(dataDir, { recursive: true, force: true });
    };
    return { registry, database, dataDir, children, acquire, register, cleanup, config, transcoder,
      maximum: () => maximum, setReady: (value: boolean) => { ready = value; } };
  }

  it("allocates metadata only and never recreates an unknown or cancelled ticket", async () => {
    const f = fixture();
    const probe = vi.fn(async () => ({ audio: false, subtitle: false }));
    f.transcoder.probeStreams = probe;
    try {
      expect(f.registry.isPreparationRegistered("session", "unknown")).toBe(false);
      await expect(f.acquire("unknown")).rejects.toMatchObject({ statusCode: 410 });
      f.register("cancel-before-get");
      expect(f.registry.isPreparationRegistered("session", "cancel-before-get")).toBe(true);
      expect(f.registry.isPreparationRegistered("other", "cancel-before-get")).toBe(false);
      expect(f.registry.activatePreparation("session", "cancel-before-get", "transcode-not-ready")).toBe("not-ready");
      expect(f.children).toHaveLength(0);
      expect(existsSync(join(f.dataDir, "transcode-preparations"))).toBe(false);
      expect(await f.registry.cancelPreparation("session", "cancel-before-get")).toBe("applied");
      await expect(f.acquire("cancel-before-get")).rejects.toMatchObject({ statusCode: 410 });
      expect(await f.registry.cancelPreparation("session", "cancel-before-get")).toBe("gone");
      expect(f.registry.isPreparationRegistered("session", "cancel-before-get")).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  it("fences delayed actions and scopes identical ticket text to its stream session", async () => {
    const f = fixture();
    try {
      f.register("old"); const old = await f.acquire("old"); old.release();
      await f.registry.cancelPreparation("session", "old", old.generation);
      f.register("new"); const fresh = await f.acquire("new", 90); fresh.release();
      expect(await f.registry.cancelPreparation("session", "old", fresh.generation)).toBe("gone");
      expect(f.registry.activatePreparation("session", "new", old.generation)).toBe("generation-mismatch");
      expect(await f.registry.releasePreparation("session", "new", old.generation)).toBe("generation-mismatch");
      expect(await f.registry.cancelPreparation("other-session", "new", fresh.generation)).toBe("gone");
      expect(f.registry.activatePreparation("session", "new", fresh.generation)).toBe("applied");
      expect(f.children[1]!.signals).toEqual([]);
      f.register("new", "other-session");
      expect(await f.registry.cancelPreparation("other-session", "new")).toBe("applied");
      expect(f.registry.acquirePreparationAsset("session", "new", fresh.generation, "stream.m3u8")?.dir).toBe(fresh.dir);
    } finally { await f.cleanup(); }
  });

  it("reclaims ready max1 output only after actual child exit and lets the successor wait", async () => {
    const f = fixture({ exits: false });
    try {
      f.register("old"); const old = await f.acquire("old"); old.release();
      const cancelled = f.registry.cancelPreparation("session", "old", old.generation);
      f.register("new"); const next = observe(f.acquire("new", 90));
      await vi.waitFor(() => expect(f.children[0]!.signals).toContain("SIGTERM"));
      expect(f.children).toHaveLength(1); expect(f.children[0]!.running).toBe(true);
      f.children[0]!.finish(); await cancelled;
      const result = await next;
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") result.value.release();
      expect(f.children).toHaveLength(2); expect(f.maximum()).toBe(1);
      expect(existsSync(old.dir)).toBe(false);
      f.children[0]!.child.emit("exit", 0);
      f.register("third", "other");
      await expect(f.acquire("third", 0, "other")).rejects.toMatchObject({ statusCode: 503 });
    } finally { await f.cleanup(); }
  });

  it("holds every metadata reader without activating and reclaims after the last idempotent release", async () => {
    const f = fixture();
    try {
      f.register("master");
      const [first, second] = await Promise.all([f.acquire("master"), f.acquire("master")]);
      expect(f.registry.acquirePreparationAsset("session", "master", first.generation, "stream.m3u8")).toBeNull();
      await f.registry.cancelPreparation("session", "master");
      expect(f.children[0]!.signals).toEqual([]); expect(existsSync(first.dir)).toBe(true);
      first.release(); first.release(); expect(f.children[0]!.signals).toEqual([]);
      second.release(); second.release();
      await vi.waitFor(() => expect(existsSync(first.dir)).toBe(false));
      expect(f.children[0]!.signals).toEqual(["SIGTERM"]);
      await expect(f.acquire("master")).rejects.toMatchObject({ statusCode: 410 });
    } finally { await f.cleanup(); }
  });

  it("removes only the cancelled logical holder of coalesced ready output", async () => {
    const f = fixture();
    try {
      f.register("a"); f.register("b");
      const [a, b] = await Promise.all([f.acquire("a"), f.acquire("b")]); a.release(); b.release();
      expect(a.generation).toBe(b.generation); expect(f.children).toHaveLength(1);
      await f.registry.cancelPreparation("session", "a", a.generation);
      expect(f.children[0]!.signals).toEqual([]);
      expect(f.registry.activatePreparation("session", "b", b.generation)).toBe("applied");
      expect(await f.registry.cancelPreparation("session", "b", b.generation)).toBe("active");
      expect(f.children[0]!.signals).toEqual([]);
      await f.registry.releasePreparation("session", "b", b.generation);
      expect(f.children[0]!.signals).toEqual(["SIGTERM"]);
    } finally { await f.cleanup(); }
  });

  it("never publishes owned readiness over legacy current or kills another active owned generation", async () => {
    const f = fixture({ max: 3 });
    try {
      const legacy = await f.registry.ensureJob("session", "https://provider.example/video");
      f.register("a"); const a = await f.acquire("a", 30); a.release();
      expect(f.registry.dirFor("session")).toBe(legacy);
      expect(f.registry.activatePreparation("session", "a", a.generation)).toBe("applied");
      f.register("b"); const b = await f.acquire("b", 60); b.release();
      expect(f.registry.activatePreparation("session", "b", b.generation)).toBe("applied");
      expect(f.registry.dirFor("session")).toBe(legacy);
      expect(f.children.map((item) => item.signals)).toEqual([[], [], []]);
      await f.registry.releasePreparation("session", "b", b.generation);
      const asset = f.registry.acquirePreparationAsset("session", "a", a.generation, "480p_seg_00000.ts");
      expect(asset?.dir).toBe(a.dir); asset?.release();
      expect(f.children[0]!.signals).toEqual([]); expect(f.children[1]!.signals).toEqual([]);
      expect(existsSync(join(legacy, "stream.m3u8"))).toBe(true);
    } finally { await f.cleanup(); }
  });

  it.each(["ensure", "asset", "retention"])("protects matching owned output after legacy %s access", async (access) => {
    const f = fixture();
    try {
      f.register("owned"); const owned = await f.acquire("owned"); owned.release();
      if (access === "ensure") expect(await f.registry.ensureJob("session", "https://provider.example/video")).toBe(owned.dir);
      else if (access === "asset") expect(f.registry.dirForAsset("session", "480p.m3u8", owned.generation)).toBe(owned.dir);
      else expect(f.registry.touchCurrentGeneration("session", "480p.m3u8", owned.generation)).toBe(true);
      await f.registry.cancelPreparation("session", "owned", owned.generation);
      expect(f.children[0]!.signals).toEqual([]); expect(existsSync(owned.dir)).toBe(true);
      f.register("new"); await expect(f.acquire("new", 90)).rejects.toMatchObject({ statusCode: 503 });
    } finally { await f.cleanup(); }
  });

  it("preserves a legacy waiter that joined owned startup and its later asset access", async () => {
    const f = fixture({ ready: false });
    try {
      f.register("owned"); const owned = observe(f.acquire("owned"));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      const legacy = observe(f.registry.ensureJob("session", "https://provider.example/video"));
      f.children[0]!.ready();
      const ready = await owned; expect(ready.status).toBe("fulfilled");
      if (ready.status !== "fulfilled") throw ready.error;
      ready.value.release();
      await f.registry.cancelPreparation("session", "owned");
      expect(await legacy).toMatchObject({ status: "fulfilled", value: ready.value.dir });
      expect(f.children[0]!.signals).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("retains a legacy current job claimed by an owned viewer during legacy replacement", async () => {
    const f = fixture({ max: 2 });
    try {
      const original = await f.registry.ensureJob("session", "https://provider.example/video");
      f.register("viewer"); const owned = await f.acquire("viewer"); owned.release();
      f.registry.activatePreparation("session", "viewer", owned.generation);
      await f.registry.ensureJob("session", "https://provider.example/video", { startSeconds: 90 });
      expect(f.children[0]!.signals).toEqual([]);
      const asset = f.registry.acquirePreparationAsset("session", "viewer", owned.generation, "stream.m3u8");
      expect(asset?.dir).toBe(original); asset?.release();
      await f.registry.releasePreparation("session", "viewer", owned.generation);
      expect(f.children[0]!.signals).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("looks up owned subtitle readiness and timeline metadata without claiming legacy ownership", async () => {
    const f = fixture();
    f.transcoder.probeStreams = async () => ({ audio: false, subtitle: true });
    try {
      await f.registry.sourceInfoFor("session", "https://provider.example/video");
      f.register("subtitles");
      const prepared = await f.registry.acquirePreparation("session", "subtitles", "https://provider.example/video", {
        preserveSubtitles: true, startSeconds: 75,
      });
      prepared.release();
      expect(f.registry.generationFor("session", prepared.dir)).toBe(prepared.generation);
      expect(f.registry.startSecondsForAsset("session", prepared.generation)).toBe(75);
      expect(f.registry.subtitleReadyForAsset("session", prepared.generation)).toBe(true);
      expect(f.registry.subtitleReadyForAsset("session", "transcode-wrong")).toBe(false);
      expect(f.registry.startSecondsForAsset("other-session", prepared.generation)).toBeNull();
      await f.registry.cancelPreparation("session", "subtitles", prepared.generation);
      expect(f.children[0]!.signals).toEqual(["SIGTERM"]);
      expect(existsSync(prepared.dir)).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("requires exact active identity and strict filenames before acquiring a reader", async () => {
    const f = fixture();
    try {
      f.register("active"); const ready = await f.acquire("active"); ready.release();
      expect(f.registry.acquirePreparationAsset("session", "active", ready.generation, "480p.m3u8")).toBeNull();
      expect(f.registry.activatePreparation("session", "active", "transcode-wrong")).toBe("generation-mismatch");
      f.registry.activatePreparation("session", "active", ready.generation);
      writeFileSync(join(ready.dir, "not-hls.txt"), "non-media fixture");
      for (const asset of ["../stream.m3u8", "/stream.m3u8", "not-hls.txt", "480p_seg_99999.ts"]) {
        expect(f.registry.acquirePreparationAsset("session", "active", ready.generation, asset)).toBeNull();
      }
      expect(f.registry.acquirePreparationAsset("other", "active", ready.generation, "stream.m3u8")).toBeNull();
      expect(f.registry.acquirePreparationAsset("session", "active", "transcode-wrong", "stream.m3u8")).toBeNull();
      const master = f.registry.acquirePreparationAsset("session", "active", ready.generation, "stream.m3u8");
      const segment = f.registry.acquirePreparationAsset("session", "active", ready.generation, "480p_seg_00000.ts");
      expect(master?.dir).toBe(ready.dir); expect(segment?.dir).toBe(ready.dir);
      await f.registry.releasePreparation("session", "active", ready.generation);
      expect(f.children[0]!.signals).toEqual([]);
      master?.release(); master?.release(); expect(f.children[0]!.signals).toEqual([]);
      segment?.release(); await vi.waitFor(() => expect(existsSync(ready.dir)).toBe(false));
    } finally { await f.cleanup(); }
  });

  it.each([true, false])("detaches one HTTP waiter without cancelling a shared producer, same ticket=%s", async (same) => {
    const f = fixture({ ready: false }); const a = new AbortController(); const b = new AbortController();
    try {
      f.register("a"); if (!same) f.register("b");
      const first = observe(f.acquire("a", 0, "session", a.signal));
      const second = observe(f.acquire(same ? "a" : "b", 0, "session", b.signal));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      a.abort(); await expect(first).resolves.toMatchObject({ status: "rejected", error: { statusCode: 499 } });
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready(); const result = await second;
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") result.value.release();
      expect(f.children).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it("cancels a shared pending ticket promptly without waiting for the other logical holder", async () => {
    const f = fixture({ ready: false });
    try {
      f.register("a"); f.register("b");
      const a = observe(f.acquire("a")); const b = observe(f.acquire("b"));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      expect(await f.registry.cancelPreparation("session", "a")).toBe("applied");
      await expect(a).resolves.toMatchObject({ status: "rejected", error: { statusCode: 499 } });
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready(); const result = await b;
      expect(result.status).toBe("fulfilled"); if (result.status === "fulfilled") result.value.release();
    } finally { await f.cleanup(); }
  });

  it("cancels the last same-ticket pending waiter and fences its late callback", async () => {
    const f = fixture({ ready: false, exits: false }); const a = new AbortController(); const b = new AbortController();
    try {
      f.register("old"); const first = observe(f.acquire("old", 0, "session", a.signal));
      const second = observe(f.acquire("old", 0, "session", b.signal));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      a.abort(); await expect(first).resolves.toMatchObject({ status: "rejected", error: { statusCode: 499 } });
      expect(f.children[0]!.signals).toEqual([]);
      b.abort(); await expect(second).resolves.toMatchObject({ status: "rejected", error: { statusCode: 499 } });
      await vi.waitFor(() => expect(f.children[0]!.signals).toContain("SIGTERM"), { timeout: 300 });
      f.setReady(true); f.register("new"); const next = observe(f.acquire("new", 90));
      expect(f.children).toHaveLength(1); f.children[0]!.finish();
      const result = await next; expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") result.value.release();
      await expect(f.acquire("old")).rejects.toMatchObject({ statusCode: 410 });
      expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it.each([503, 504])("retries immutable issued identity after transient %s without rebinding options", async (status) => {
    const f = fixture({ ready: status === 503, timeout: 50 });
    try {
      if (status === 503) await f.registry.ensureJob("busy", "https://provider.example/other");
      f.register("retry");
      await expect(f.acquire("retry", 90)).rejects.toMatchObject({ statusCode: status });
      await expect(f.acquire("retry", 91)).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.registry.acquirePreparation("session", "retry", "https://provider.example/different", { startSeconds: 90 }))
        .rejects.toMatchObject({ statusCode: 409 });
      f.children.forEach((item) => item.finish()); f.setReady(true);
      const recovered = await f.acquire("retry", 90); recovered.release();
      expect(f.registry.startSecondsForAsset("session", recovered.generation)).toBe(90);
      expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("never cancels the older owner when an unused or mismatched queued ticket is cancelled", async () => {
    const f = fixture({ ready: false });
    try {
      f.register("old"); const old = observe(f.acquire("old"));
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      f.register("unused"); await f.registry.cancelPreparation("session", "unused");
      f.register("queued"); const queued = observe(f.acquire("queued", 90));
      await f.registry.cancelPreparation("session", "queued");
      await expect(queued).resolves.toMatchObject({ status: "rejected", error: { statusCode: 499 } });
      expect(f.children[0]!.signals).toEqual([]);
      f.children[0]!.ready(); const result = await old;
      expect(result.status).toBe("fulfilled"); if (result.status === "fulfilled") result.value.release();
      expect(f.children).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it("renews only an active existing rendition without resurrecting an idle generation", async () => {
    const f = fixture(); let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      f.register("lease"); const ready = await f.acquire("lease"); ready.release();
      expect(f.registry.touchPreparationGeneration("session", "lease", ready.generation, "480p.m3u8")).toBe(false);
      f.registry.activatePreparation("session", "lease", ready.generation);
      now += 100;
      expect(f.registry.touchPreparationGeneration("session", "lease", ready.generation, "480p.m3u8")).toBe(true);
      rmSync(join(ready.dir, "360p.m3u8"));
      now += 119_999;
      expect(f.registry.touchPreparationGeneration("session", "lease", ready.generation, "360p.m3u8")).toBe(false);
      now += 2;
      expect(f.registry.touchPreparationGeneration("session", "lease", ready.generation, "480p.m3u8")).toBe(false);
      expect(f.registry.touchPreparationGeneration("session", "lease", "transcode-wrong", "480p.m3u8")).toBe(false);
    } finally { clock.mockRestore(); await f.cleanup(); }
  });

  it("bounds tickets globally and per session without evicting live claims", async () => {
    const f = fixture(); let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      f.register("active"); f.register("ready");
      const active = await f.acquire("active"); active.release(); f.registry.activatePreparation("session", "active", active.generation);
      const ready = await f.acquire("ready"); ready.release();
      for (let i = 0; i < 62; i += 1) f.register(`unused-${i}`);
      expect(() => f.register("overflow")).toThrow(expect.objectContaining({ statusCode: 429 }));
      now += 60_000;
      expect(f.registry.isPreparationRegistered("session", "unused-0")).toBe(false);
      expect(f.registry.isPreparationRegistered("session", "active")).toBe(true);
      expect(f.registry.isPreparationRegistered("session", "ready")).toBe(true);
      f.register("after-expiry");
      await expect(f.acquire("unused-0")).rejects.toMatchObject({ statusCode: 410 });
      expect(f.registry.activatePreparation("session", "ready", ready.generation)).toBe("applied");
      const held = f.registry.acquirePreparationAsset("session", "active", active.generation, "480p.m3u8");
      expect(held?.dir).toBe(active.dir); held?.release();
      for (let i = 0; i < 61; i += 1) f.register(`fill-${i}`);
      for (let session = 0; session < 63; session += 1) {
        for (let i = 0; i < 64; i += 1) f.register(`ticket-${i}`, `s-${session}`);
      }
      expect(() => f.register("global-overflow", "last-session")).toThrow(expect.objectContaining({ statusCode: 429 }));
      expect(f.children).toHaveLength(1);
    } finally { clock.mockRestore(); await f.cleanup(); }
  });

  it("sweeps only its dedicated crash namespace once before concurrent owned creation", async () => {
    const f = fixture({ max: 3 });
    const root = join(f.dataDir, "transcode-preparations");
    try {
      mkdirSync(join(root, "transcode-crash"), { recursive: true });
      writeFileSync(join(root, "transcode-crash", "old.ts"), "old output");
      const sibling = join(f.dataDir, "user-data.txt"); writeFileSync(sibling, "keep");
      f.register("a", "a"); f.register("b", "b");
      const [a, b] = await Promise.all([f.acquire("a", 0, "a"), f.acquire("b", 0, "b")]); a.release(); b.release();
      f.register("c", "c"); const c = await f.acquire("c", 90, "c"); c.release();
      expect(existsSync(join(root, "transcode-crash"))).toBe(false);
      expect(existsSync(sibling)).toBe(true);
      expect(dirname(a.dir)).toBe(root); expect(dirname(b.dir)).toBe(root);
      expect(existsSync(a.dir)).toBe(true); expect(existsSync(b.dir)).toBe(true);
      expect(f.maximum()).toBe(3);
    } finally { await f.cleanup(); }
  });

  it.each(["kill", "stop"])("owns ready active pending and unused work during %s", async (action) => {
    const f = fixture({ max: 3 });
    try {
      f.register("a"); const a = await f.acquire("a"); a.release(); f.registry.activatePreparation("session", "a", a.generation);
      f.register("b"); const b = await f.acquire("b", 30); b.release();
      f.register("unused"); f.setReady(false); f.register("pending"); const pending = observe(f.acquire("pending", 60));
      await vi.waitFor(() => expect(f.children).toHaveLength(3));
      if (action === "kill") await f.registry.kill("session"); else await f.registry.stop();
      expect((await pending).status).toBe("rejected");
      expect(f.children.every((item) => !item.running)).toBe(true);
      expect(existsSync(a.dir)).toBe(false); expect(existsSync(b.dir)).toBe(false);
      expect(f.children.every((item) => !existsSync(item.dir))).toBe(true);
      await expect(f.acquire("a")).rejects.toMatchObject({ statusCode: 410 });
      expect(f.registry.activatePreparation("session", "unused", a.generation)).toBe("gone");
    } finally { await f.cleanup(); }
  });

  it("rejects old issued IDs after restart and sweeps old owned crash output lazily", async () => {
    const f = fixture(); const restarted = new TranscodeRegistry(f.database, f.config, f.transcoder);
    try {
      f.register("old"); const old = await f.acquire("old"); old.release();
      await f.registry.stop();
      mkdirSync(old.dir, { recursive: true }); writeFileSync(join(old.dir, "leftover.ts"), "crash");
      await expect(restarted.acquirePreparation("session", "old", "https://provider.example/video")).rejects.toMatchObject({ statusCode: 410 });
      restarted.registerPreparation("session", "fresh");
      const fresh = await restarted.acquirePreparation("session", "fresh", "https://provider.example/video"); fresh.release();
      expect(existsSync(old.dir)).toBe(false); expect(existsSync(fresh.dir)).toBe(true);
    } finally { await restarted.stop(); await f.cleanup(); }
  });

  it("reaps idle owned generations but keeps a pinned response until its release", async () => {
    const f = fixture({ max: 2 }); let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const prepare = f.database.sqlite.prepare.bind(f.database.sqlite);
    const database = vi.spyOn(f.database.sqlite, "prepare").mockImplementation((sql) =>
      sql === "SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?"
        ? { get: () => ({ revoked_at: null, expires_at: "9999-12-31T00:00:00.000Z" }) } as never : prepare(sql));
    try {
      f.register("old"); const old = await f.acquire("old"); old.release();
      f.register("pinned"); const pinned = await f.acquire("pinned", 90);
      now += 120_001;
      (f.registry as unknown as { reap(): void }).reap();
      await vi.waitFor(() => expect(existsSync(old.dir)).toBe(false));
      expect(existsSync(pinned.dir)).toBe(true); expect(f.children[1]!.signals).toEqual([]);
      pinned.release(); (f.registry as unknown as { reap(): void }).reap();
      await vi.waitFor(() => expect(existsSync(pinned.dir)).toBe(false));
      await expect(f.acquire("old")).rejects.toMatchObject({ statusCode: 410 });
    } finally { database.mockRestore(); clock.mockRestore(); await f.cleanup(); }
  });

  // Real disposal has a four-second ceiling; fake children report exit only
  // when this test says so, preserving the actual-termination capacity gate.
  it("retains a stubborn ready child's permit after bounded disposal", async () => {
    const f = fixture({ exits: false });
    try {
      f.register("old"); const old = await f.acquire("old"); old.release();
      await f.registry.cancelPreparation("session", "old", old.generation);
      expect(f.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(f.children[0]!.running).toBe(true);
      f.register("new"); await expect(f.acquire("new", 90)).rejects.toMatchObject({ statusCode: 503 });
      f.children[0]!.finish(); const next = await f.acquire("new", 90); next.release();
      expect(f.maximum()).toBe(1);
    } finally { await f.cleanup(); }
  }, 8000);
});
