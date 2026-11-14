import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hlsArgs as productionHlsArgs, type HlsTranscodeOptions } from "../src/transcodeSession.js";
import { initialMpegTsVideoPresentationTimestamp } from "../src/transcodeTsClock.js";
import { rewriteGeneratedWebVttForTimeline } from "../src/transcodeHls.js";

// Test-only module substitution permits independently compiled literal-source
// reverts without touching the working source while another reviewer reads it.
const hlsArgs: typeof productionHlsArgs = process.env.DS_TRANSCODE_TEST_ARGS_MODULE
  ? (await import(pathToFileURL(process.env.DS_TRANSCODE_TEST_ARGS_MODULE).href)).hlsArgs
  : productionHlsArgs;

const cap = "fps=fps='if(gt(source_fps,0),min(source_fps,30),30)'";
const valueAfter = (args: string[], option: string) => args[args.indexOf(option) + 1]!;

describe("optimized transcode frame-work budget", () => {
  it.each(["1080p", "720p", "480p", "360p"] as const)("caps fixed %s before scaling and tone mapping", (quality) => {
    const args = hlsArgs("/owned/source.mkv", "/owned/output", { quality, hdrPolicy: "tone-map" });
    const filter = valueAfter(args, "-vf");
    expect(filter.startsWith(cap + ",")).toBe(true);
    expect(filter.indexOf(cap)).toBeLessThan(filter.indexOf("zscale="));
    expect(filter.indexOf(cap)).toBeLessThan(filter.indexOf("scale=w="));
    expect(args).not.toContain("-r");
  });

  it.each([360, 480, undefined])("caps Auto once before split or tone mapping for source height %s", (sourceVideoHeight) => {
    const args = hlsArgs("/owned/source.mkv", "/owned/output", { sourceVideoHeight, hdrPolicy: "tone-map" });
    const graph = valueAfter(args, "-filter_complex");
    expect(graph.startsWith("[0:v:0]" + cap)).toBe(true);
    expect(graph.split(cap)).toHaveLength(2);
    expect(graph.indexOf(cap)).toBeLessThan(graph.indexOf("zscale="));
    if (sourceVideoHeight !== 360) expect(graph.indexOf(cap)).toBeLessThan(graph.indexOf("split="));
  });
  it.each(["1080p", "720p", "480p", "360p"] as const)("uses the cheaper scaler only for low-resolution fixed %s", (quality) => {
    const filter = valueAfter(hlsArgs("/owned/source.mkv", "/owned/output", { quality }), "-vf");
    expect(filter.includes(":flags=fast_bilinear")).toBe(quality === "480p" || quality === "360p");
  });
  it("keeps Auto1080/720 scaler policy while reducing only its480/360 branches", () => {
    const graph = valueAfter(hlsArgs("/owned/source.mkv", "/owned/output"), "-filter_complex");
    for (const height of [1080, 720, 480, 360]) {
      const branch = graph.split(";").find(value => value.endsWith(`[v${height}]`))!;
      expect(branch.includes(":flags=fast_bilinear")).toBe(height <= 480);
    }
  });
  it.each(["1080p", "720p", "480p", "360p"] as const)("uses the measured software preset only for low-resolution fixed %s", (quality) => {
    const args = hlsArgs("/owned/source.mkv", "/owned/output", { quality });
    expect(valueAfter(args, "-preset:v:0")).toBe(quality === "480p" || quality === "360p" ? "superfast" : "veryfast");
    expect(args.some(value => value.includes("threads"))).toBe(false);
  });
  it.each([360, 480, 720, undefined])("assigns Auto software presets by rendition height, not compacted index, for height %s", (sourceVideoHeight) => {
    const args = hlsArgs("/owned/source.mkv", "/owned/output", { sourceVideoHeight });
    const names = valueAfter(args, "-var_stream_map").split(" ").map(value => /name:(\d+)p/.exec(value)![1]);
    for (const [index, height] of names.entries()) {
      expect(valueAfter(args, `-preset:v:${index}`)).toBe(Number(height) <= 480 ? "superfast" : "veryfast");
    }
  });
  it.each(["h264_videotoolbox", "h264_nvenc", "h264_qsv"] as const)("preserves %s hardware preset/quality controls at every height", (videoEncoder) => {
    const args = hlsArgs("/owned/source.mkv", "/owned/output", { videoEncoder });
    expect(args).not.toContain("superfast");
    expect(args).not.toContain("veryfast");
    expect(args.some(value => value.includes("threads"))).toBe(false);
    for (let index = 0; index < 4; index += 1) {
      expect(valueAfter(args, `-c:v:${index}`)).toBe(videoEncoder);
      if (videoEncoder === "h264_nvenc") expect(valueAfter(args, `-preset:v:${index}`)).toBe("p4");
      if (videoEncoder === "h264_qsv") expect(valueAfter(args, `-global_quality:v:${index}`)).toBe("27");
    }
  });
});

// Explicit opt-in: runs actual generated HLS commands on local synthetic files.
// No HTTP listener, provider URL, application session or external media is used.
describe.skipIf(process.env.DS_TRANSCODE_FFMPEG_COMPAT !== "1")("actual FFmpeg optimized-transcode compatibility", () => {
  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  const ffprobe = process.env.FFPROBE ?? "ffprobe";
  let work: string;
  let sequence = 0;
  const receipts: unknown[] = [];
  const sources = new Map<string, string>();
  function run(binary: string, args: string[]) {
    return execFileSync(binary, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4_000_000,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: work } });
  }
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "yawf-transcode-compat-"));
    receipts.push({ ffmpeg: run(ffmpeg, ["-version"]).split("\n")[0], ffprobe: run(ffprobe, ["-version"]).split("\n")[0] });
    writeFileSync(join(work, "captions.srt"), "1\n00:00:01,000 --> 00:00:03,000\nFIRST\n\n2\n00:00:05,000 --> 00:00:07,000\nSECOND\n");
  });
  afterAll(() => {
    if (process.env.DS_TRANSCODE_COMPAT_RECEIPT) writeFileSync(process.env.DS_TRANSCODE_COMPAT_RECEIPT, JSON.stringify(receipts, null, 2) + "\n");
    if (work) rmSync(work, { recursive: true, force: true });
  });
  function source(rate: string, offset = 0) {
    const key = `${rate}-${offset}`;
    if (sources.has(key)) return sources.get(key)!;
    const path = join(work, `source-${sources.size}.mkv`);
    run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${rate}`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
      "-i", join(work, "captions.srt"), "-t", "8",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-map", "3:s:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads:v", "1", "-g", "30",
      "-c:a", "flac", "-c:s", "srt", "-output_ts_offset", String(offset), path]);
    sources.set(key, path); return path;
  }
  function transcode(rate: string, options: HlsTranscodeOptions, mutate?: (args: string[]) => string[], offset = 0) {
    const dir = join(work, `output-${++sequence}`); mkdirSync(dir);
    const generated = hlsArgs(source(rate, offset), dir, options);
    const args = mutate ? mutate(generated) : generated;
    run(ffmpeg, args);
    const names = readdirSync(dir).filter(name => /^\d+p\.m3u8$/.test(name));
    expect(names.length).toBeGreaterThan(0);
    const results = names.map(name => {
      const manifest = readFileSync(join(dir, name), "utf8");
      expect(manifest).toContain("#EXT-X-ENDLIST");
      const probe = JSON.parse(run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", join(dir, name)]));
      const video = probe.streams.find((stream: any) => stream.codec_type === "video");
      const audio = probe.streams.find((stream: any) => stream.codec_type === "audio");
      const frames = JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", join(dir, name)]));
      expect(video.codec_name).toBe("h264");
      expect(video.pix_fmt).toBe("yuv420p");
      const [n, d] = video.avg_frame_rate.split("/").map(Number);
      return { name, fps: n / d, frames: Number(video.nb_read_frames), start: Number(video.start_time),
        firstFramePts: Number(frames.frames[0]?.best_effort_timestamp_time),
        duration: Number(probe.format.duration), audioCodec: audio?.codec_name, audioChannels: audio?.channels };
    });
    receipts.push({ rate, options, offset, mutated: Boolean(mutate), results });
    return { dir, results };
  }
  function expectRate(results: ReturnType<typeof transcode>["results"], rate: number, duration = 8) {
    for (const result of results) {
      expect(result.fps).toBeCloseTo(rate, 3);
      expect(result.frames).toBeGreaterThanOrEqual(Math.floor(duration * rate) - 2);
      expect(result.frames).toBeLessThanOrEqual(Math.ceil(duration * rate) + 2);
      expect(result.duration).toBeGreaterThan(duration - 0.1);
      expect(result.duration).toBeLessThan(duration + 0.15);
    }
  }
  it.each(["24000/1001", "24", "25", "30", "60"])("fixed output caps %s without upsampling or changing duration/audio", (rate) => {
    const { dir, results } = transcode(rate, { quality: "480p", audioTrack: 1 });
    const [n, d = 1] = rate.split("/").map(Number);
    expectRate(results, Math.min(n! / d, 30));
    expect(results[0]!.audioCodec).toBe("aac");
    expect(results[0]!.audioChannels).toBe(2);
    if (rate === "25") {
      const pcm = execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-i", join(dir, "480p.m3u8"),
        "-map", "0:a:0", "-t", "1", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
      { timeout: 30_000, maxBuffer: 1_000_000, env: { ...process.env, TMPDIR: work } });
      // Correlate a steady interior interval rather than counting AAC priming
      // ringing near zero, which can add spurious zero crossings.
      const energy = (frequency: number) => {
        let real = 0, imaginary = 0;
        for (let index = 9_600; index < Math.min(43_200, pcm.length / 4); index += 1) {
          const sample = pcm.readFloatLE(index * 4);
          const phase = 2 * Math.PI * frequency * index / 48_000;
          real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase);
        }
        return real * real + imaginary * imaginary;
      };
      const selectedEnergy = energy(880), otherEnergy = energy(440);
      expect(selectedEnergy).toBeGreaterThan(otherEnergy * 1_000);
      receipts.push({ selectedAudioTrack: 1, selected880HzEnergy: selectedEnergy, rejected440HzEnergy: otherEnergy });
    }
  });
  it("Auto splits capped frames into aligned30fps renditions", () => {
    const { results } = transcode("60", { quality: "auto", sourceVideoHeight: 480, includeAudio: false });
    expect(results.map(result => result.name).sort()).toEqual(["360p.m3u8", "480p.m3u8"]);
    expectRate(results, 30);
    expect(new Set(results.map(result => result.start)).size).toBe(1);
    expect(results.every(result => result.audioCodec === undefined)).toBe(true);
  });
  it("retains shared input-clock subtitle timestamps after nonzero seek", () => {
    const options = { quality: "480p", startSeconds: 4, preserveSubtitles: true,
      includeSubtitle: true, audioTrack: 1 } as const;
    const { dir, results } = transcode("60", options, undefined, 11);
    const baseline = transcode("60", options, args => args.map(value =>
      value.replace(cap + ",", "").replaceAll(":flags=fast_bilinear", "").replace("superfast", "veryfast")), 11);
    expectRate(results, 30, 4);
    expectRate(baseline.results, 60, 4);
    expect(results[0]!.firstFramePts).toBeCloseTo(15, 2);
    expect(results[0]!.firstFramePts).toBe(baseline.results[0]!.firstFramePts);
    const clock = initialMpegTsVideoPresentationTimestamp(readFileSync(join(dir, "480p_seg_00000.ts")));
    const baselineClock = initialMpegTsVideoPresentationTimestamp(readFileSync(join(baseline.dir, "480p_seg_00000.ts")));
    expect(clock).toBe(15 * 90_000);
    expect(clock).toBe(baselineClock);
    const generatedCues = (directory: string) => readdirSync(directory).filter(name => name.endsWith(".vtt"))
      .sort().map(name => readFileSync(join(directory, name), "utf8"));
    const rawCues = generatedCues(dir);
    expect(rawCues).toEqual(generatedCues(baseline.dir));
    for (const raw of rawCues) {
      const mapped = rewriteGeneratedWebVttForTimeline(raw);
      expect(mapped).toBe(raw.replace(/^WEBVTT\n/, "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\n"));
    }
    const cues = rawCues.join("\n");
    expect(cues).toContain("SECOND");
    expect(cues).toContain("00:16.000 --> 00:18.000");
    receipts.push({ subtitleClockComparison: { baselineVideoPts: baselineClock, cappedVideoPts: clock,
      baselineFirstFramePts: baseline.results[0]!.firstFramePts, cappedFirstFramePts: results[0]!.firstFramePts,
      rawWebVttByteEqual: true, timestampMap: "LOCAL:00:00.000,MPEGTS:0" } });
  });
  it("individual original-filter revert fails the actual fixed60fps cap regression", () => {
    const { results } = transcode("60", { quality: "480p" }, args => args.map(value => value.replace(cap + ",", "")));
    expect(() => expectRate(results, 30)).toThrow();
    expectRate(results, 60);
  });
  it("individual original Auto-filter revert fails the actual60fps cap regression", () => {
    const { results } = transcode("60", { quality: "auto", sourceVideoHeight: 480, includeAudio: false },
      args => args.map(value => value.replace(cap + ",", "")));
    expect(() => expectRate(results, 30)).toThrow();
    expectRate(results, 60);
  });
  it("individual unconditional30fps mutant fails actual23.976 no-upsample regression", () => {
    const { results } = transcode("24000/1001", { quality: "480p" }, args => args.map(value => value.replace(cap, "fps=30")));
    expect(() => expectRate(results, 24000 / 1001)).toThrow();
    expectRate(results, 30);
  });
  it("evaluates the unknown-nominal-rate fallback through the real FFmpeg expression parser", () => {
    // Pin the expression's unknown-rate variable to zero. The synthetic decoder
    // itself still has a known60fps rate; this is expression-branch coverage.
    const { results } = transcode("60", { quality: "480p" }, args => args.map(value => value.replace(cap, cap.replaceAll("source_fps", "0"))));
    expectRate(results, 30);
  });
  it("individual missing-unknown-rate-fallback mutant rejects through real FFmpeg execution", () => {
    expect(() => transcode("60", { quality: "480p" }, args => args.map(value =>
      value.replace(cap, "fps=fps='min(0,30)'")))).toThrow();
  });
});
