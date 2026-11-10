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
  it.each([
    [240, ["360p"]], [360, ["360p"]], [480, ["480p", "360p"]],
    [540, ["720p", "480p", "360p"]], [720, ["720p", "480p", "360p"]],
    [1080, ["1080p", "720p", "480p", "360p"]],
  ] as const)("does not encode duplicate source-sized Auto renditions for height %i", (sourceVideoHeight, names) => {
    const args = hlsArgs("/owned/video.mp4", "/owned/output", { sourceVideoHeight });
    expect(valueAfter(args, "-var_stream_map")).toBe(names.map((name, index) =>
      `v:${index},a:${index},name:${name}`).join(" "));
    expect(args.filter((arg) => arg === "0:a:0")).toHaveLength(names.length);
    const graph = valueAfter(args, "-filter_complex")!;
    if (names.length === 1) expect(graph).not.toContain("split=");
    else expect(graph).toContain(`split=${names.length}`);
  });

  it("retains Auto audio bitrates and subtitle ownership after compacting its indices", () => {
    const args = hlsArgs("/owned/video.mp4", "/owned/output", {
      sourceVideoHeight: 480, audioTrack: 1, preserveSubtitles: true, includeSubtitle: true,
    });
    expect(valueAfter(args, "-b:v:0")).toBe("1800k");
    expect(valueAfter(args, "-b:a:0")).toBe("128k");
    expect(valueAfter(args, "-b:a:1")).toBe("96k");
    expect(args.filter((arg) => arg === "0:a:1")).toHaveLength(2);
    expect(valueAfter(args, "-var_stream_map")).toBe(
      "v:0,a:0,s:0,sgroup:subs,name:480p v:1,a:1,name:360p",
    );
    const silent = hlsArgs("/owned/video.mp4", "/owned/output", {
      sourceVideoHeight: 360, includeAudio: false,
    });
    expect(valueAfter(silent, "-var_stream_map")).toBe("v:0,name:360p");
    expect(silent).not.toContain("-c:a");
  });

  it.each([undefined, null, NaN, -1, 0, 480.5, 16385])("retains the full Auto ladder for uncertain height %s", (sourceVideoHeight) => {
    expect(hlsArgs("/owned/video.mp4", "/owned/output", { sourceVideoHeight }))
      .toEqual(hlsArgs("/owned/video.mp4", "/owned/output"));
  });

  it.each(["1080p", "720p", "480p", "360p"] as const)("leaves explicit %s quality unchanged by source-height pruning", (quality) => {
    expect(hlsArgs("/owned/video.mp4", "/owned/output", { quality, sourceVideoHeight: 360 }))
      .toEqual(hlsArgs("/owned/video.mp4", "/owned/output", { quality }));
  });

  it.each(["http", "https"] as const)("resumes seekable %s inputs with bounded reconnect before seek and input", (protocol) => {
    const url = `${protocol}://provider.example/video.mp4`;
    const args = hlsArgs(url, "/owned/yawf", {
      quality: "480p", startSeconds: 731, preserveSubtitles: true, includeSubtitle: true,
    });
    for (const [option, value] of [["-reconnect", "1"], ["-reconnect_on_network_error", "1"], ["-reconnect_delay_max", "5"]] as const) {
      expect(valueAfter(args, option)).toBe(value);
      expect(args.filter((arg) => arg === option)).toHaveLength(1);
      expect(args.indexOf(option)).toBeLessThan(args.indexOf("-ss"));
      expect(args.indexOf(option)).toBeLessThan(args.indexOf("-i"));
    }
    expect(valueAfter(args, "-ss")).toBe("731");
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-ss"));
    expect(valueAfter(args, "-i")).toBe(url);
  });

  it.each(["/owned/video.mp4", "video.mp4", "file:/owned/video.mp4"])("does not add HTTP reconnect options for local input %s", (url) => {
    const args = hlsArgs(url, "/owned/yawf", { quality: "480p", startSeconds: 731 });
    expect(args.filter((arg) => arg.startsWith("-reconnect"))).toEqual([]);
    expect(valueAfter(args, "-i")).toBe(url);
    expect(valueAfter(args, "-ss")).toBe("731");
  });

  it("never enables EOF replay, streamed restart, HTTP-status retries or newer reconnect options", () => {
    const args = hlsArgs("https://provider.example/video.mp4", "/owned/yawf");
    for (const option of [
      "-reconnect_at_eof", "-reconnect_streamed", "-reconnect_on_http_error",
      "-reconnect_max_retries", "-reconnect_delay_total_max", "-xerror",
    ]) expect(args).not.toContain(option);
    expect(args).not.toContain("-ss");
  });

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

function capacityRegistryFixture(maxTranscodes = 2, exitOnKill = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "yawf-transcode-capacity-"));
  const database = new AppDatabase(":memory:");
  const children: Array<{
    child: ChildProcess;
    dir: string;
    kills: number;
    running: boolean;
    finish: (code?: number | null, signal?: NodeJS.Signals) => void;
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
        finish: (code: number | null = 0, signal?: NodeJS.Signals) => {},
      };
      record.finish = (code: number | null = 0, signal?: NodeJS.Signals) => {
        if (!record.running) return;
        record.running = false;
        // Node reports process termination first, then stdio closure. The
        // registry must release capacity once even though both events fire.
        child.emit("exit", code, signal ?? null);
        child.emit("close", code, signal ?? null);
      };
      child.kill = () => {
        record.kills += 1;
        // Most tests explicitly emit asynchronous exit to preserve capacity.
        const wasRunning = record.running;
        if (exitOnKill) record.finish(0);
        return wasRunning;
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
  it("binds Auto readiness, subtitles and staged handoff to the same cached source-sized ladder", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yawf-source-sized-auto-"));
    const database = new AppDatabase(":memory:");
    seedTranscodeSession(database, "source-sized");
    const probeStreams = vi.fn(async () => ({ audio: true, subtitle: true, videoHeight: 480 }));
    const spawnHls = vi.fn((args: string[]) => {
      const dir = dirname(args.at(-1)!);
      writeFileSync(join(dir, "stream.m3u8"), "#EXTM3U\n480p.m3u8\n");
      writeFileSync(join(dir, "480p.m3u8"), "#EXTM3U\n#EXTINF:6,\n480p_seg_00000.ts\n");
      writeFileSync(join(dir, "480p_seg_00000.ts"), fakeMpegTsSegment());
      writeFileSync(join(dir, "480p_subtitles.m3u8"), "#EXTM3U\n#EXTINF:6,\n480p0.vtt\n");
      writeFileSync(join(dir, "480p0.vtt"), "WEBVTT\n");
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean; stderr: null };
      child.stderr = null;
      child.kill = () => { child.emit("exit", 0); return true; };
      return child as unknown as ChildProcess;
    });
    const registry = new TranscodeRegistry(database, {
      dataDir, maxTranscodes: 2, transcodeVideoEncoder: "libx264", transcodeStartTimeoutMs: 125,
    } as ServerConfig, { async detect() { return true; }, probeStreams, spawnHls });
    try {
      const options = { quality: "auto" as const, preserveSubtitles: true };
      const original = await registry.ensureJob("source-sized", "https://provider.example/video", options);
      const replacement = await registry.ensureJob("source-sized", "https://provider.example/video", { ...options, startSeconds: 90 });
      expect(replacement).not.toBe(original);
      expect(registry.dirFor("source-sized")).toBe(original);
      expect(probeStreams).toHaveBeenCalledTimes(1);
      for (const [args] of spawnHls.mock.calls) {
        expect(valueAfter(args, "-var_stream_map")).toBe(
          "v:0,a:0,s:0,sgroup:subs,name:480p v:1,a:1,name:360p",
        );
      }
      const generation = registry.generationFor("source-sized", replacement)!;
      expect(registry.dirForAsset("source-sized", "480p.m3u8", generation, true)).toBe(replacement);
      expect(registry.dirFor("source-sized")).toBe(replacement);
    } finally {
      await registry.stop(); database.close(); rmSync(dataDir, { recursive: true, force: true });
    }
  });

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
  it.each(["exit", "error"] as const)("rejects a staged replacement with ready files after %s without retiring healthy output", async (failure) => {
    const fixture = stagedRegistryFixture();
    let pending: ReturnType<typeof observe<string>> | undefined;
    try {
      const original = await fixture.registry.ensureJob("healthy", "https://provider.example/source");
      const generation = fixture.registry.generationFor("healthy", original)!;
      const spawned = fixture.waitForSpawn();
      pending = observe(fixture.registry.ensureJob("healthy", "https://provider.example/source", { quality: "360p", startSeconds: 90 }));
      await spawned;
      const staged = fixture.children[1]!;
      writeFileSync(join(staged.dir, "stream.m3u8"), "#EXTM3U\n360p.m3u8\n");
      writeFileSync(join(staged.dir, "360p_seg_00000.ts"), "partial segment");
      if (failure === "exit") staged.child.emit("exit", 1, null);
      else staged.child.emit("error", new Error("failed after writing readiness files"));
      expect(await pending).toMatchObject({ status: "rejected", error: { statusCode: 502 } });
      expect(fixture.registry.dirFor("healthy")).toBe(original);
      expect(fixture.registry.dirForAsset("healthy", "1080p_seg_00000.ts", generation)).toBe(original);
      expect(fixture.children[0]!.kills).toBe(0);
      expect(staged.kills).toBeGreaterThan(0);
      expect(existsSync(staged.dir)).toBe(false);
    } finally {
      await pending;
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it.each(["exit", "error"] as const)("refuses current-generation assets after a ready job reports %s", async (failure) => {
    const fixture = capacityRegistryFixture();
    try {
      const dir = await fixture.registry.ensureJob("failed-current", "https://provider.example/source", { quality: "480p", startSeconds: 90 });
      const generation = fixture.registry.generationFor("failed-current", dir)!;
      writeFileSync(join(dir, "480p.m3u8"), "#EXTM3U\n#EXTINF:6,\n480p_seg_00000.ts\n#EXT-X-ENDLIST\n");
      if (failure === "exit") fixture.children[0]!.finish(1);
      else fixture.children[0]!.child.emit("error", new Error("post-readiness failure"));
      for (const asset of ["stream.m3u8", "480p.m3u8", "480p_seg_00000.ts"]) {
        expect(existsSync(join(dir, asset))).toBe(true);
        expect(fixture.registry.dirForAsset("failed-current", asset, generation)).toBeNull();
        expect(fixture.registry.dirForAsset("failed-current", asset)).toBeNull();
      }
      expect(fixture.registry.startSecondsForAsset("failed-current", generation)).toBe(90);
      expect(fixture.children).toHaveLength(1);
    } finally {
      fixture.children.forEach((record) => record.finish(0));
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("keeps successful completed current-generation playlists and segments readable", async () => {
    const fixture = capacityRegistryFixture();
    try {
      const dir = await fixture.registry.ensureJob("completed-current", "https://provider.example/source", { quality: "480p" });
      const generation = fixture.registry.generationFor("completed-current", dir)!;
      writeFileSync(join(dir, "480p.m3u8"), "#EXTM3U\n#EXTINF:6,\n480p_seg_00000.ts\n#EXT-X-ENDLIST\n");
      fixture.children[0]!.finish(0);
      for (const asset of ["stream.m3u8", "480p.m3u8", "480p_seg_00000.ts"]) {
        expect(fixture.registry.dirForAsset("completed-current", asset, generation)).toBe(dir);
        expect(fixture.registry.dirForAsset("completed-current", asset)).toBe(dir);
      }
      expect(await fixture.registry.ensureJob("completed-current", "https://provider.example/source", { quality: "480p" })).toBe(dir);
      expect(fixture.children).toHaveLength(1);
    } finally {
      fixture.children.forEach((record) => record.finish(0));
      await fixture.registry.stop();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("preserves the exact retired grace after intentional SIGTERM marks the old job failed", async () => {
    const fixture = capacityRegistryFixture();
    try {
      seedTranscodeSession(fixture.database, "retired-grace");
      const original = await fixture.registry.ensureJob("retired-grace", "https://provider.example/source", { quality: "480p" });
      const generation = fixture.registry.generationFor("retired-grace", original)!;
      writeFileSync(join(original, "480p.m3u8"), "#EXTM3U\n#EXTINF:6,\n480p_seg_00000.ts\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const replacement = await fixture.registry.ensureJob("retired-grace", "https://provider.example/source", { quality: "360p", startSeconds: 90 });
      writeFileSync(join(replacement, "360p.m3u8"), "#EXTM3U\n");
      expect(fixture.registry.dirForAsset("retired-grace", "360p.m3u8", fixture.registry.generationFor("retired-grace", replacement)!, true)).toBe(replacement);
      expect(fixture.children[0]!.kills).toBeGreaterThan(0);
      fixture.children[0]!.finish(null, "SIGTERM");
      for (const asset of ["stream.m3u8", "480p.m3u8", "480p_seg_00000.ts"]) {
        expect(fixture.registry.dirForAsset("retired-grace", asset, generation)).toBe(original);
      }
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fixture.registry.dirForAsset("retired-grace", "480p.m3u8", generation)).toBe(original);
      expect(fixture.registry.dirFor("retired-grace")).toBe(replacement);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.registry.dirForAsset("retired-grace", "480p.m3u8", generation)).toBeNull();
      expect(fixture.registry.dirFor("retired-grace")).toBe(replacement);
    } finally {
      fixture.children.forEach((record) => record.finish(0));
      await fixture.registry.stop();
      vi.useRealTimers();
      fixture.database.close();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });


  it.each(["exit", "error"] as const)("replaces same-options output after a ready job reports %s", async (failure) => {
    const fixture = capacityRegistryFixture(2);
    try {
      seedTranscodeSession(fixture.database, "recover");
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
      writeFileSync(join(replacement, "1080p.m3u8"), "#EXTM3U\n");
      expect(fixture.registry.dirForAsset("recover", "1080p.m3u8", fixture.registry.generationFor("recover", replacement)!, true)).toBe(replacement);
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
      seedTranscodeSession(fixture.database, "recover");
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
      seedTranscodeSession(fixture.database, "recover");
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
      seedTranscodeSession(fixture.database, "first");
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
      writeFileSync(join(replacement, "360p.m3u8"), "#EXTM3U\n");
      expect(fixture.registry.dirForAsset("first", "360p.m3u8", fixture.registry.generationFor("first", replacement)!, true)).toBe(replacement);
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
    seedTranscodeSession(fixture.database, "leased");
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
      writeFileSync(join(replacement, "360p.m3u8"), "#EXTM3U\n");
      expect(f.registry.dirForAsset("leased", "360p.m3u8", f.registry.generationFor("leased", replacement)!, true)).toBe(replacement);
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


function seedTranscodeSession(database: AppDatabase, id: string): void {
  database.sqlite.prepare("INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, created_at) VALUES ('transcode-owner', 'transcode-owner', 'Fixture', 'fixture-hash', 'owner', '2026-01-01')").run();
  database.sqlite.prepare("INSERT OR IGNORE INTO profiles (id, user_id, display_name, created_at, updated_at) VALUES ('transcode-profile', 'transcode-owner', 'Fixture', '2026-01-01', '2026-01-01')").run();
  database.sqlite.prepare("INSERT INTO stream_sessions (id, profile_id, encrypted_upstream_url, created_at, expires_at) VALUES (?, 'transcode-profile', 'fixture', '2026-01-01', '9999-12-31T00:00:00.000Z')").run(id);
}

describe("prepared replacement activation", () => {
  async function fixture(exitOnKill = true) {
    const f = capacityRegistryFixture(2, exitOnKill);
    seedTranscodeSession(f.database, "prepared");
    const original = await f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "480p" });
    writeFileSync(join(original, "480p.m3u8"), "#EXTM3U\n");
    const originalGeneration = f.registry.generationFor("prepared", original)!;
    const replacement = await f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "360p", startSeconds: 731 });
    writeFileSync(join(replacement, "360p.m3u8"), "#EXTM3U\n");
    const replacementGeneration = f.registry.generationFor("prepared", replacement)!;
    const pointer = () => (f.database.sqlite.prepare("SELECT transcode_dir FROM stream_sessions WHERE id = 'prepared'").get() as { transcode_dir: string }).transcode_dir;
    const activate = (asset = "360p.m3u8", generation: string | undefined = replacementGeneration) =>
      (f.registry.dirForAsset as (id: string, asset: string, generation?: string, activate?: boolean) => string | null)("prepared", asset, generation, true);
    const cleanup = async () => {
      f.children.forEach(child => child.finish()); await f.registry.stop();
      f.database.close(); rmSync(f.dataDir, { recursive: true, force: true }); vi.useRealTimers();
    };
    return { ...f, original, originalGeneration, replacement, replacementGeneration, pointer, activate, cleanup };
  }
  function touchRetained(f: Awaited<ReturnType<typeof fixture>>, asset = "360p.m3u8", generation = f.replacementGeneration, session = "prepared") {
    // Baseline equivalent of the existing HEAD route, without an absent-method failure.
    const registry = f.registry as typeof f.registry & { touchRetainedGeneration?: (id: string, asset: string, generation: string) => boolean };
    return (registry.touchRetainedGeneration ?? registry.touchCurrentGeneration).call(registry, session, asset, generation);
  }

  it("[retained-ready] HEAD-equivalent renewal keeps prepared output alive without activating or retiring its current reader", async () => {
    const f = await fixture();
    const state = f.registry as unknown as { jobs: Map<string, { lastAccess: number }>; prepared: Map<string, { lastAccess: number }> };
    const original = state.jobs.get("prepared")!, prepared = state.prepared.get("prepared")!;
    let now = prepared.lastAccess + 1; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const originalAccess = original.lastAccess;
      expect(f.registry.touchCurrentGeneration("prepared", "360p.m3u8", f.replacementGeneration)).toBe(false);
      expect(touchRetained(f)).toBe(true); expect(prepared.lastAccess).toBe(now);
      expect(original.lastAccess).toBe(originalAccess); expect(f.pointer()).toBe(f.original);
      for (let index = 0; index < 3; index += 1) {
        now += 60_000;
        expect(f.registry.touchCurrentGeneration("prepared", "480p.m3u8", f.originalGeneration)).toBe(true);
        expect(touchRetained(f)).toBe(true);
        (f.registry as unknown as { reap(): void }).reap();
      }
      expect(state.jobs.get("prepared")).toBe(original); expect(state.prepared.get("prepared")).toBe(prepared);
      expect(f.pointer()).toBe(f.original); expect(f.children.map(child => child.kills)).toEqual([0, 0]);
      expect(existsSync(f.original)).toBe(true); expect(existsSync(f.replacement)).toBe(true);
      expect(f.activate()).toBe(f.replacement); expect(f.pointer()).toBe(f.replacement);
      expect(f.children[0]!.kills).toBe(1);
      expect(touchRetained(f, "480p.m3u8", f.originalGeneration)).toBe(false);
      expect(touchRetained(f)).toBe(true);
    } finally { clock.mockRestore(); await f.cleanup(); }
  });

  it.each(["failed", "cancelled", "disposed", "idle", "wrong-session", "wrong-generation", "missing", "segment", "master", "stale-lifecycle", "closed"] as const)("[retained-controls] rejects %s without touching either retained owner", async (kind) => {
    const f = await fixture();
    const state = f.registry as unknown as { lifecycle: string; prepared: Map<string, { lastAccess: number; failed: boolean; cancelled: boolean; disposed: boolean; lifecycleGeneration: number }>; jobs: Map<string, { lastAccess: number }> };
    const job = state.prepared.get("prepared")!, current = state.jobs.get("prepared")!;
    const before = job.lastAccess, currentBefore = current.lastAccess, generation = job.lifecycleGeneration;
    const clock = kind === "idle" ? vi.spyOn(Date, "now").mockReturnValue(before + 120_001) : null;
    try {
      if (kind === "failed" || kind === "cancelled" || kind === "disposed") job[kind] = true;
      if (kind === "stale-lifecycle") job.lifecycleGeneration -= 1;
      if (kind === "closed") state.lifecycle = "stopping";
      const asset = kind === "missing" ? "720p.m3u8" : kind === "segment" ? "360p_seg_00000.ts" : kind === "master" ? "stream.m3u8" : kind === "closed" ? "480p.m3u8" : "360p.m3u8";
      expect(touchRetained(f, asset, kind === "wrong-generation" ? "transcode-wrong" : kind === "closed" ? f.originalGeneration : f.replacementGeneration, kind === "wrong-session" ? "other" : "prepared")).toBe(false);
      expect(job.lastAccess).toBe(before); expect(current.lastAccess).toBe(currentBefore);
      expect(f.pointer()).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
    } finally {
      clock?.mockRestore(); job.failed = false; job.cancelled = false; job.disposed = false; job.lifecycleGeneration = generation; state.lifecycle = "open"; await f.cleanup();
    }
  });

  it("discarded ready replacement never starts the active reader retirement grace", async () => {
    const f = await fixture();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.pointer()).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
      expect(f.registry.touchCurrentGeneration("prepared", "480p.m3u8", f.originalGeneration)).toBe(true);
      expect(existsSync(f.original)).toBe(true);
      expect(f.registry.dirForAsset("prepared", "360p.m3u8", f.replacementGeneration)).toBe(f.replacement);
    } finally { await f.cleanup(); }
  });
  it("exact rendition activation commits before retiring the old reader for exactly30seconds", async () => {
    const f = await fixture();
    try {
      expect(f.registry.dirForAsset("prepared", "360p.m3u8", f.replacementGeneration)).toBe(f.replacement);
      expect(f.registry.dirFor("prepared")).toBe(f.original); expect(f.pointer()).toBe(f.original);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect(f.activate()).toBe(f.replacement);
      expect(f.pointer()).toBe(f.replacement); expect(f.registry.dirFor("prepared")).toBe(f.replacement);
      expect(f.children[0]!.kills).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.registry.dirForAsset("prepared", "480p.m3u8", f.originalGeneration)).toBe(f.original);
      expect(f.activate("480p.m3u8", f.originalGeneration)).toBe(f.original);
      expect(f.registry.dirFor("prepared")).toBe(f.replacement);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.registry.dirForAsset("prepared", "480p.m3u8", f.originalGeneration)).toBeNull();
      expect(f.registry.dirFor("prepared")).toBe(f.replacement);
    } finally { await f.cleanup(); }
  });
  it.each(["master", "segment", "subtitle-playlist", "subtitle-segment", "missing-generation", "wrong-generation"])("does not activate on %s lookup", async kind => {
    const f = await fixture();
    try {
      const asset = kind === "master" ? "stream.m3u8" : kind === "segment" ? "360p_seg_00000.ts" : kind === "subtitle-playlist" ? "360p_subtitles.m3u8" : kind === "subtitle-segment" ? "360p0.vtt" : "360p.m3u8";
      if (kind.startsWith("subtitle")) writeFileSync(join(f.replacement, asset), "fixture");
      const generation = kind === "missing-generation" ? undefined : kind === "wrong-generation" ? "transcode-unknown" : f.replacementGeneration;
      (f.registry.dirForAsset as (id: string, asset: string, generation?: string, activate?: boolean) => string | null)("prepared", asset, generation, true);
      expect(f.registry.dirFor("prepared")).toBe(f.original); expect(f.pointer()).toBe(f.original);
      expect(f.children[0]!.kills).toBe(0);
    } finally { await f.cleanup(); }
  });
  it.each(["exit", "error"] as const)("rejects a prepared %s before activation without retiring the active reader", async failure => {
    const f = await fixture();
    try {
      if (failure === "exit") f.children[1]!.finish(1);
      else f.children[1]!.child.emit("error", new Error("fixture failed preparation"));
      expect(f.activate()).toBeNull(); expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.pointer()).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("failed activation database write leaves active ownership and prepared retry intact", async () => {
    const f = await fixture();
    try {
      f.database.sqlite.exec("CREATE TRIGGER reject_activation BEFORE UPDATE OF transcode_dir ON stream_sessions BEGIN SELECT RAISE(ABORT, 'fixture activation write failure'); END");
      expect(() => f.activate()).toThrow("fixture activation write failure");
      expect(f.pointer()).toBe(f.original); expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.children[0]!.kills).toBe(0);
      f.database.sqlite.exec("DROP TRIGGER reject_activation");
      expect(f.activate()).toBe(f.replacement); expect(f.pointer()).toBe(f.replacement);
    } finally { await f.cleanup(); }
  });
  it("idle prepared output is removed alone while the current reader keeps its lease", async () => {
    const f = await fixture(); let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      now += 60_000; expect(f.registry.touchCurrentGeneration("prepared", "480p.m3u8", f.originalGeneration)).toBe(true);
      now += 60_001; expect(f.registry.touchCurrentGeneration("prepared", "480p.m3u8", f.originalGeneration)).toBe(true);
      (f.registry as unknown as { reap(): void }).reap();
      await vi.waitFor(() => expect(existsSync(f.replacement)).toBe(false));
      expect(f.registry.dirFor("prepared")).toBe(f.original); expect(f.pointer()).toBe(f.original);
      expect(f.children[0]!.kills).toBe(0); expect(f.children[1]!.kills).toBeGreaterThan(0);
      expect(f.activate()).toBeNull();
    } finally { clock.mockRestore(); await f.cleanup(); }
  });
  it("an idle prepared generation cannot revive before the next reaper tick", async () => {
    const f = await fixture(); const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    try {
      expect(f.activate()).toBeNull(); expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.pointer()).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
    } finally { clock.mockRestore(); await f.cleanup(); }
  });
  it("reuses one prepared generation and resets its idle access window", async () => {
    const f = await fixture(); let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      now += 100_000;
      expect(await f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "360p", startSeconds: 731 })).toBe(f.replacement);
      expect(f.registry.touchCurrentGeneration("prepared", "480p.m3u8", f.originalGeneration)).toBe(true);
      now += 30_000; (f.registry as unknown as { reap(): void }).reap();
      expect(f.activate()).toBe(f.replacement); expect(f.children).toHaveLength(2);
    } finally { clock.mockRestore(); await f.cleanup(); }
  });
  it("superseding invalidates the old preparation before awaiting exit and coalesces its successor", async () => {
    const f = await fixture(false);
    try {
      const first = observe(f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "720p", startSeconds: 900 }));
      await vi.waitFor(() => expect(f.children[1]!.kills).toBeGreaterThan(0));
      const second = observe(f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "720p", startSeconds: 900 }));
      expect(f.activate()).toBeNull(); expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.registry.generationFor("prepared", f.replacement)).toBeNull();
      expect(f.children).toHaveLength(2); expect(f.children[0]!.kills).toBe(0);
      await expect(f.registry.ensureJob("other-holder", "https://provider.example/other")).rejects.toMatchObject({ statusCode: 503 });
      f.children[1]!.finish();
      const result = await first; expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw new Error("Expected prepared successor");
      expect(await second).toEqual(result); expect(f.children).toHaveLength(3);
      writeFileSync(join(result.value, "720p.m3u8"), "#EXTM3U\n");
      expect(f.activate()).toBeNull(); expect(f.pointer()).toBe(f.original);
      expect(f.registry.dirForAsset("prepared", "720p.m3u8", f.registry.generationFor("prepared", result.value)!, true)).toBe(result.value);
      expect(f.pointer()).toBe(result.value); expect(f.children[0]!.kills).toBe(1);
    } finally { await f.cleanup(); }
  });
  it("readiness starts the prepared idle window after a delayed warmup", async () => {
    const f = stagedRegistryFixture(); seedTranscodeSession(f.database, "ready-clock");
    let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const original = await f.registry.ensureJob("ready-clock", "https://provider.example/video");
      const spawned = f.waitForSpawn();
      const next = f.registry.ensureJob("ready-clock", "https://provider.example/video", { quality: "360p" });
      await spawned; now += 300;
      writeFileSync(join(f.children[1]!.dir, "stream.m3u8"), "#EXTM3U\n");
      writeFileSync(join(f.children[1]!.dir, "360p_seg_00000.ts"), "segment");
      await next;
      const state = f.registry as unknown as { prepared?: Map<string, { lastAccess: number }>; jobs: Map<string, { lastAccess: number }> };
      expect((state.prepared?.get("ready-clock") ?? state.jobs.get("ready-clock"))!.lastAccess).toBe(now);
      expect(f.registry.dirFor("ready-clock")).toBe(original);
    } finally { clock.mockRestore(); await f.registry.stop(); f.database.close(); rmSync(f.dataDir, { recursive: true, force: true }); }
  });
  it.each(["revoked", "expired"] as const)("rejects activation after the session is %s", async reason => {
    const f = await fixture();
    try {
      f.database.sqlite.prepare(reason === "revoked"
        ? "UPDATE stream_sessions SET revoked_at = '2026-01-01' WHERE id = 'prepared'"
        : "UPDATE stream_sessions SET expires_at = '2026-01-01' WHERE id = 'prepared'").run();
      expect(f.activate()).toBeNull(); expect(f.registry.dirFor("prepared")).toBe(f.original);
      expect(f.pointer()).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
    } finally { await f.cleanup(); }
  });
  it("superseded prepared process retains capacity until its actual exit", async () => {
    const f = await fixture(false);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const replacement = observe(f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "720p" }));
      await vi.advanceTimersByTimeAsync(4000);
      expect(await replacement).toMatchObject({ status: "rejected", error: { statusCode: 503 } });
      expect(f.children[1]!.running).toBe(true); expect(f.children).toHaveLength(2);
      expect(f.registry.dirFor("prepared")).toBe(f.original); expect(f.children[0]!.kills).toBe(0);
      f.children[1]!.finish();
      await expect(f.registry.ensureJob("prepared", "https://provider.example/video", { quality: "720p" })).resolves.toEqual(expect.any(String));
      expect(f.children).toHaveLength(3);
    } finally { await f.cleanup(); }
  });
  it.each(["kill", "stop"] as const)("%s cleans current and prepared outputs without allowing stale activation", async method => {
    const f = await fixture();
    try {
      await (method === "kill" ? f.registry.kill("prepared") : f.registry.stop());
      expect(f.activate()).toBeNull(); expect(f.registry.dirFor("prepared")).toBeNull();
      expect(existsSync(f.original)).toBe(false); expect(existsSync(f.replacement)).toBe(false);
      expect(f.pointer()).toBeNull();
    } finally { await f.cleanup(); }
  });
});
