import { describe, expect, it } from "vitest";
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
      await fixture.waitForSpawn();
      await fixture.registry.kill("replacement");
      await expect(pending).rejects.toMatchObject({ statusCode: 410 });
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
