// ffmpeg integration surface for opt-in server-side transcoding (Phase 3b).
//
// The whole feature touches child_process through this one `Transcoder` seam, so
// tests inject a fake (via BuildAppOptions.transcoder) and never need a real
// ffmpeg binary. The real implementation probes ffmpeg at boot and spawns
// an HLS-producing process per stream session.

import { spawn, type ChildProcess } from "node:child_process";

export type TranscodeVideoEncoder =
  | "libx264"
  | "h264_videotoolbox"
  | "h264_nvenc"
  | "h264_qsv";

export interface TranscoderCapabilities {
  toneMapping: boolean;
  videoEncoders?: TranscodeVideoEncoder[];
  subtitleSidecar?: boolean;
  audioTrackSelection?: boolean;
}

export interface TranscoderAudioTrack {
  /** Zero-based index within the source's audio streams, not the global stream index. */
  index: number;
  language: string | null;
  label: string | null;
  default: boolean;
}

export interface TranscoderStreamProbe {
  audio: boolean;
  subtitle: boolean;
  audioTracks?: TranscoderAudioTrack[];
  /** Original source-container duration from ffprobe format metadata. */
  durationSeconds?: number | null;
  /** Decoded height only when the probe has no uncertain display rotation. */
  videoHeight?: number | null;
}

// Cold container starts can take several seconds to load FFmpeg's libraries.
// Give a timed-out and reaped probe one retry, without overlapping processes
// or adding work when the first attempt succeeds or the tool is missing.
const BOOT_MEDIA_TOOL_TIMEOUT_MS = 5_000;
const BOOT_MEDIA_TOOL_RETRY_TIMEOUT_MS = 8_000;
const BOOT_MEDIA_TOOL_CLOSE_GRACE_MS = 500;

export const STREAM_PROBE_FAST_TIMEOUT_MS = 5_000;
export const STREAM_PROBE_RETRY_TIMEOUT_MS = 15_000;

export interface TranscoderStreamProbeOptions {
  /** Only the explicit user retry receives the slow deadline. All other values
   * fail back to the ordinary five-second lane. */
  timeoutMs?: typeof STREAM_PROBE_FAST_TIMEOUT_MS | typeof STREAM_PROBE_RETRY_TIMEOUT_MS;
  /** Registry-owned cancellation. Aborting requests process termination, while
   * the returned promise remains pending until the child actually closes. */
  signal?: AbortSignal;
  /** Lets the registry retain global process admission through actual close. */
  onSpawn?: (child: ChildProcess) => void;
}

export type TranscoderStartupInspection =
  | { state: "ready"; capabilities: TranscoderCapabilities }
  | { state: "retryable-timeout" }
  | { state: "unavailable" };

export interface Transcoder {
  /** Inspect an encoder before optional tools. A timeout is retryable only
   * when the child has actually closed, so callers never overlap attempts. */
  inspectStartup?(signal: AbortSignal): Promise<TranscoderStartupInspection>;
  /** Resolves true iff `ffmpeg -version` exits 0 within a short timeout. Run once
   *  at boot and cached - never per request. */
  detect(): Promise<boolean>;
  /** Detect optional filters used by advanced profiles. */
  capabilities?(): Promise<TranscoderCapabilities>;
  /** Read only the source stream table. The main FFmpeg process still performs
   * the single full media pass, including optional subtitle extraction. */
  probeStreams?(
    upstreamUrl: string,
    options?: TranscoderStreamProbeOptions,
  ): Promise<TranscoderStreamProbe | null>;
  /** Spawn an ffmpeg process for the given argv (which encodes the HLS output
   *  paths). Returns the child handle so the registry can manage its lifecycle. */
  spawnHls(args: string[]): ChildProcess;
}

type BootMediaResult =
  | { kind: "success"; output: string }
  | { kind: "timeout" }
  | { kind: "unavailable" };

const BOOT_TOOL_UNAVAILABLE: BootMediaResult = { kind: "unavailable" };

function attemptBootMediaProbe(
  command: "ffmpeg" | "ffprobe",
  args: string[],
  captureOutput: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BootMediaResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(BOOT_TOOL_UNAVAILABLE); return; }
    let settled = false;
    let stopping: "timeout" | "abort" | null = null;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let probe: ChildProcess;
    const finish = (result: BootMediaResult) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const stop = (reason: "timeout" | "abort") => {
      if (settled || stopping != null) return;
      stopping = reason;
      if (timer != null) clearTimeout(timer);
      // An unconfirmed stop must never admit another process.
      timer = setTimeout(() => finish(BOOT_TOOL_UNAVAILABLE), BOOT_MEDIA_TOOL_CLOSE_GRACE_MS);
      timer.unref?.();
      try { probe.kill("SIGKILL"); } catch { /* Already stopping. */ }
    };
    const abort = () => stop("abort");
    try {
      probe = spawn(command, args, {
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      });
      const collect = (chunk: Buffer) => {
        if (output.length < 1_000_000) output += chunk.toString("utf8");
      };
      if (captureOutput) {
        probe.stdout?.on("data", collect);
        probe.stderr?.on("data", collect);
      }
      probe.once("error", () => {
        if (stopping == null) finish(BOOT_TOOL_UNAVAILABLE);
      });
      probe.once("close", (code) => {
        if (stopping === "timeout" && !signal?.aborted) finish({ kind: "timeout" });
        else if (stopping == null && code === 0 && !signal?.aborted) finish({ kind: "success", output });
        else finish(BOOT_TOOL_UNAVAILABLE);
      });
      timer = setTimeout(() => stop("timeout"), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    } catch {
      finish(BOOT_TOOL_UNAVAILABLE);
    }
  });
}

async function probeBootMediaTool(
  command: "ffmpeg" | "ffprobe",
  args: string[],
  captureOutput = false,
  signal?: AbortSignal,
): Promise<BootMediaResult> {
  const first = await attemptBootMediaProbe(command, args, captureOutput, BOOT_MEDIA_TOOL_TIMEOUT_MS, signal);
  if (first.kind !== "timeout" || signal?.aborted) return first;
  return attemptBootMediaProbe(command, args, captureOutput, BOOT_MEDIA_TOOL_RETRY_TIMEOUT_MS, signal);
}

function captureFfmpegList(argument: "-filters" | "-encoders", signal?: AbortSignal): Promise<BootMediaResult> {
  return probeBootMediaTool("ffmpeg", ["-hide_banner", argument], true, signal);
}

function bootOutput(result: BootMediaResult): string {
  return result.kind === "success" ? result.output : "";
}

function bootVideoEncoders(encoders: string): TranscodeVideoEncoder[] {
  const supported: TranscodeVideoEncoder[] = ["libx264", "h264_videotoolbox", "h264_nvenc", "h264_qsv"];
  return supported.filter((encoder) => new RegExp(`(?:^|\\s)${encoder}(?:\\s|$)`, "m").test(encoders));
}

function bootCapabilities(filters: BootMediaResult, encoders: string, ffprobe: BootMediaResult): TranscoderCapabilities {
  const ffprobeAvailable = ffprobe.kind === "success";
  return {
    toneMapping: /(?:^|\s)zscale(?:\s|$)/m.test(bootOutput(filters)),
    videoEncoders: bootVideoEncoders(encoders),
    subtitleSidecar: ffprobeAvailable && /(?:^|\s)webvtt(?:\s|$)/m.test(encoders),
    audioTrackSelection: ffprobeAvailable,
  };
}

export const realTranscoder: Transcoder = {
  async inspectStartup(signal) {
    // A successful encoder listing already proves FFmpeg can start. Give the
    // required check the host to itself before loading optional media tools.
    const encoders = await captureFfmpegList("-encoders", signal);
    if (signal.aborted) return { state: "unavailable" };
    if (encoders.kind === "timeout") return { state: "retryable-timeout" };
    if (encoders.kind !== "success" || bootVideoEncoders(encoders.output).length === 0) {
      return { state: "unavailable" };
    }
    const [filters, ffprobe] = await Promise.all([
      captureFfmpegList("-filters", signal),
      probeBootMediaTool("ffprobe", ["-version"], false, signal),
    ]);
    if (signal.aborted) return { state: "unavailable" };
    return { state: "ready", capabilities: bootCapabilities(filters, encoders.output, ffprobe) };
  },
  async detect() {
    return (await probeBootMediaTool("ffmpeg", ["-version"])).kind === "success";
  },
  async capabilities() {
    const [filters, encoders, ffprobe] = await Promise.all([
      captureFfmpegList("-filters"),
      captureFfmpegList("-encoders"),
      probeBootMediaTool("ffprobe", ["-version"]),
    ]);
    return bootCapabilities(filters, bootOutput(encoders), ffprobe);
  },
  probeStreams(upstreamUrl, options = {}) {
    return new Promise<TranscoderStreamProbe | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let output = "";
      let failed = false;
      let terminationRequested = false;
      let probe: ChildProcess | null = null;
      const timeoutMs = options.timeoutMs === STREAM_PROBE_RETRY_TIMEOUT_MS
        ? STREAM_PROBE_RETRY_TIMEOUT_MS
        : STREAM_PROBE_FAST_TIMEOUT_MS;
      const signalAborted = () => options.signal?.aborted === true;
      const finish = (result: TranscoderStreamProbe | null) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", terminate);
        resolve(result);
      };
      const terminate = () => {
        if (terminationRequested || settled) return;
        terminationRequested = true;
        failed = true;
        try {
          probe?.kill("SIGKILL");
        } catch {
          /* close/error will settle the operation */
        }
      };
      if (signalAborted()) {
        finish(null);
        return;
      }
      try {
        probe = spawn(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,height:stream_tags=language,title,rotate:stream_side_data=rotation:stream_disposition=default:format=duration",
            "-of",
            "json",
            upstreamUrl,
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        probe.stdout?.on("data", (chunk: Buffer) => {
          if (output.length < 65_536) output += chunk.toString("utf8");
        });
        probe.once("error", () => {
          failed = true;
        });
        probe.once("close", (code) => {
          if (failed || code !== 0) {
            finish(null);
            return;
          }
          try {
            const parsed = JSON.parse(output) as {
              streams?: Array<{
                codec_type?: unknown;
                height?: unknown;
                side_data_list?: unknown;
                tags?: { language?: unknown; title?: unknown; rotate?: unknown };
                disposition?: { default?: unknown };
              }>;
              format?: { duration?: unknown };
            };
            const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
            const video = streams.find((stream) => stream.codec_type === "video");
            const tags = video?.tags;
            const rotation = tags?.rotate;
            const unrotatedTag = tags === undefined ||
              (tags != null && typeof tags === "object" && !Array.isArray(tags) &&
                (rotation === undefined ||
                  (typeof rotation === "string" && /^[+-]?0(?:\.0+)?$/.test(rotation))));
            const sideData = video?.side_data_list;
            const unrotatedSideData = sideData === undefined ||
              (Array.isArray(sideData) && sideData.every((entry: unknown) =>
                entry != null && typeof entry === "object" &&
                "rotation" in entry && entry.rotation === 0));
            const videoHeight = typeof video?.height === "number" &&
              Number.isInteger(video.height) && video.height > 0 && video.height <= 16_384 &&
              unrotatedTag && unrotatedSideData ? video.height : null;
            const clean = (value: unknown, maxLength: number): string | null => {
              if (typeof value !== "string") return null;
              const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
              return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
            };
            const audioTracks = streams
              .filter((stream) => stream.codec_type === "audio")
              .slice(0, 32)
              .map((stream, index) => ({
                index,
                language: clean(stream.tags?.language, 32),
                label: clean(stream.tags?.title, 128),
                default: stream.disposition?.default === 1,
              }));
            const rawDuration = parsed.format?.duration;
            const duration =
              typeof rawDuration === "number"
                ? rawDuration
                : typeof rawDuration === "string"
                  ? Number(rawDuration)
                  : Number.NaN;
            finish({
              videoHeight,
              audio: audioTracks.length > 0,
              subtitle: streams.some((stream) => stream.codec_type === "subtitle"),
              audioTracks,
              durationSeconds:
                Number.isFinite(duration) && duration > 0 && duration <= 86_400
                  ? duration
                  : null,
            });
          } catch {
            finish(null);
          }
        });
        options.onSpawn?.(probe);
        options.signal?.addEventListener("abort", terminate, { once: true });
        if (signalAborted()) terminate();
        timer = setTimeout(terminate, timeoutMs);
        timer.unref?.();
      } catch {
        if (probe == null) finish(null);
        else terminate();
      }
    });
  },
  spawnHls(args) {
    // HLS goes to files. Drain stderr so a noisy FFmpeg failure can never fill
    // the pipe buffer and stall the child while the registry waits for output.
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.resume();
    return child;
  },
};
