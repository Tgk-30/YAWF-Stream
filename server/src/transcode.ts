// ffmpeg integration surface for opt-in server-side transcoding (Phase 3b).
//
// The whole feature touches child_process through this one `Transcoder` seam, so
// tests inject a fake (via BuildAppOptions.transcoder) and never need a real
// ffmpeg binary. The real implementation probes ffmpeg once at boot and spawns
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
}

export interface Transcoder {
  /** Resolves true iff `ffmpeg -version` exits 0 within a short timeout. Run once
   *  at boot and cached - never per request. */
  detect(): Promise<boolean>;
  /** Detect optional filters used by advanced profiles. */
  capabilities?(): Promise<TranscoderCapabilities>;
  /** Read only the source stream table. The main FFmpeg process still performs
   * the single full media pass, including optional subtitle extraction. */
  probeStreams?(upstreamUrl: string): Promise<TranscoderStreamProbe | null>;
  /** Spawn an ffmpeg process for the given argv (which encodes the HLS output
   *  paths). Returns the child handle so the registry can manage its lifecycle. */
  spawnHls(args: string[]): ChildProcess;
}

function captureFfmpegList(argument: "-filters" | "-encoders"): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolve(value);
    };
    try {
      const probe = spawn("ffmpeg", ["-hide_banner", argument], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        if (output.length < 1_000_000) output += chunk.toString("utf8");
      };
      probe.stdout?.on("data", collect);
      probe.stderr?.on("data", collect);
      probe.once("error", () => finish(null));
      probe.once("close", (code) => finish(code === 0 ? output : null));
      timer = setTimeout(() => {
        try {
          probe.kill("SIGKILL");
        } catch {
          /* already stopped */
        }
        finish(null);
      }, 2000);
      timer.unref?.();
    } catch {
      finish(null);
    }
  });
}

function detectFfprobe(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolve(available);
    };
    try {
      const probe = spawn("ffprobe", ["-version"], { stdio: "ignore" });
      probe.once("error", () => finish(false));
      probe.once("close", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try {
          probe.kill("SIGKILL");
        } catch {
          /* already stopped */
        }
        finish(false);
      }, 2000);
      timer.unref?.();
    } catch {
      finish(false);
    }
  });
}

export const realTranscoder: Transcoder = {
  detect() {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const probe = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
        probe.once("error", () => finish(false));
        probe.once("close", (code) => finish(code === 0));
        const timer = setTimeout(() => {
          try {
            probe.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          finish(false);
        }, 2000);
        timer.unref?.();
      } catch {
        finish(false);
      }
    });
  },
  async capabilities() {
    const [filters, encoders, ffprobeAvailable] = await Promise.all([
      captureFfmpegList("-filters"),
      captureFfmpegList("-encoders"),
      detectFfprobe(),
    ]);
    const videoEncoders = [
      "libx264",
      "h264_videotoolbox",
      "h264_nvenc",
      "h264_qsv",
    ].filter((encoder) =>
      new RegExp(`(?:^|\\s)${encoder}(?:\\s|$)`, "m").test(encoders ?? ""),
    ) as TranscodeVideoEncoder[];
    return {
      toneMapping: /(?:^|\s)zscale(?:\s|$)/m.test(filters ?? ""),
      videoEncoders,
      subtitleSidecar:
        ffprobeAvailable &&
        /(?:^|\s)webvtt(?:\s|$)/m.test(encoders ?? ""),
      audioTrackSelection: ffprobeAvailable,
    };
  },
  probeStreams(upstreamUrl) {
    return new Promise<TranscoderStreamProbe | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let output = "";
      const finish = (result: TranscoderStreamProbe | null) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        resolve(result);
      };
      try {
        const probe = spawn(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type:stream_tags=language,title:stream_disposition=default:format=duration",
            "-of",
            "json",
            upstreamUrl,
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        probe.stdout?.on("data", (chunk: Buffer) => {
          if (output.length < 65_536) output += chunk.toString("utf8");
        });
        probe.once("error", () => finish(null));
        probe.once("close", (code) => {
          if (code !== 0) {
            finish(null);
            return;
          }
          try {
            const parsed = JSON.parse(output) as {
              streams?: Array<{
                codec_type?: unknown;
                tags?: { language?: unknown; title?: unknown };
                disposition?: { default?: unknown };
              }>;
              format?: { duration?: unknown };
            };
            const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
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
        timer = setTimeout(() => {
          try {
            probe.kill("SIGKILL");
          } catch {
            /* already stopped */
          }
          finish(null);
        }, 5000);
        timer.unref?.();
      } catch {
        finish(null);
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
