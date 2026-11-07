// Per-session HLS transcode job registry + lifecycle (Phase 3b).
//
// One ffmpeg process per stream session, producing a bounded H.264/AAC VOD HLS
// ladder into a per-session temp dir under the data dir. The registry owns
// the process + temp-dir lifecycle so there are no zombie ffmpegs or orphaned
// dirs: a boot sweep cleans crash leftovers, an idle/expiry reaper kills
// abandoned jobs, and stop() (wired to the app's onClose) tears everything down.
//
// Only constructed/started when transcoding is active (operator flag on AND
// ffmpeg present) - so it has zero cost in the default (off) configuration.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AppDatabase } from "./db.js";
import type { ServerConfig } from "./types.js";
import { isTranscodeAssetName, TRANSCODE_SUBTITLE_PLAYLIST_PATTERN } from "./transcodeHls.js";
import type {
  Transcoder,
  TranscoderAudioTrack,
  TranscoderStreamProbe,
  TranscodeVideoEncoder,
} from "./transcode.js";
import {
  STREAM_PROBE_FAST_TIMEOUT_MS,
  STREAM_PROBE_RETRY_TIMEOUT_MS,
} from "./transcode.js";
import { readInitialMpegTsVideoPresentationTimestamp } from "./transcodeTsClock.js";

export const MANIFEST_NAME = "stream.m3u8";
const FIRST_ADAPTIVE_SEGMENT = "1080p_seg_00000.ts";
const IDLE_MS = 120_000;
const REAP_INTERVAL_MS = 30_000;
const KILL_GRACE_MS = 3000;
const RETIRED_ASSET_GRACE_MS = 30_000;
const PROBE_CACHE_IDLE_MS = 5 * 60_000;
const FAILED_PROBE_RETRY_COOLDOWN_MS = 5_000;
const MAX_PROBE_CACHE_ENTRIES = 64;
const PROBE_FAST_CALLER_TIMEOUT_MS = 6_000;
const PROBE_RETRY_CALLER_TIMEOUT_MS = 17_000;
const UNUSED_PREPARATION_MS = 60_000;
const MAX_SESSION_PREPARATIONS = 64;
const MAX_PREPARATIONS = 4096;

/** Legacy client profile names retained for older app versions. */
export type TranscodeClientProfile = "adaptive" | "high" | "data-saver";
/** Public, allowlisted server-optimized playback qualities. */
export type TranscodeQuality = "auto" | "1080p" | "720p" | "480p" | "360p";
export const TRANSCODE_QUALITIES: readonly TranscodeQuality[] = [
  "auto",
  "1080p",
  "720p",
  "480p",
  "360p",
] as const;

/** Keep the original profile contract stable while all new callers use quality. */
export function qualityForProfile(profile: TranscodeClientProfile): TranscodeQuality {
  switch (profile) {
    case "high":
      return "1080p";
    case "data-saver":
      return "480p";
    default:
      return "auto";
  }
}

export function isTranscodeQuality(value: unknown): value is TranscodeQuality {
  return typeof value === "string" && (TRANSCODE_QUALITIES as readonly string[]).includes(value);
}
export type TranscodeHdrPolicy = "auto" | "preserve" | "tone-map";
export interface HlsTranscodeOptions {
  profile?: TranscodeClientProfile;
  /** Explicit quality takes precedence over the legacy profile. */
  quality?: TranscodeQuality;
  startSeconds?: number;
  /** Zero-based source audio-stream index. Never a global ffmpeg stream specifier. */
  audioTrack?: number;
  hdrPolicy?: TranscodeHdrPolicy;
  /** Preserve the first embedded subtitle track as a WebVTT HLS rendition. */
  preserveSubtitles?: boolean;
  videoEncoder?: TranscodeVideoEncoder;
  /** Internal result of the source probe. Defaults true for injected test
   * transcoders and backwards-compatible custom implementations. */
  includeAudio?: boolean;
  /** Internal stream-table probe result. */
  includeSubtitle?: boolean;
}

export interface TranscodeSourceInfo {
  audioTracks: TranscoderAudioTrack[] | null;
  durationSeconds: number | null;
}

export interface TranscodeSourceInfoOptions {
  retryFailed?: boolean;
  signal?: AbortSignal;
}

export interface TranscodeJobLifecycle {
  signal?: AbortSignal;
}

export interface TranscodePreparedJob {
  dir: string;
  generation: string;
  /** Hold disposable output through the master response without activating it. */
  release(): void;
}

export interface TranscodePreparationAsset {
  dir: string;
  release(): void;
}

export type TranscodePreparationActionResult =
  | "applied" | "gone" | "generation-mismatch" | "not-ready" | "active";

function preparationGone(): Error {
  return Object.assign(new Error("The transcode preparation is no longer available."), { statusCode: 410 });
}

function preparationCancelled(): Error {
  return Object.assign(new Error("The transcode preparation was cancelled."), {
    name: "AbortError", code: "TRANSCODE_PREPARATION_CANCELLED", statusCode: 499,
  });
}

function encoderArgs(
  encoder: TranscodeVideoEncoder,
  bitrates: readonly string[],
): string[] {
  const result: string[] = [];
  for (let index = 0; index < bitrates.length; index += 1) {
    const bitrate = bitrates[index]!;
    result.push(`-c:v:${index}`, encoder);
    if (encoder === "libx264") {
      result.push(`-preset:v:${index}`, "veryfast", `-crf:v:${index}`, "25");
    } else if (encoder === "h264_nvenc") {
      result.push(`-preset:v:${index}`, "p4", `-cq:v:${index}`, "27");
    } else if (encoder === "h264_qsv") {
      result.push(`-global_quality:v:${index}`, "27");
    }
    result.push(
      `-b:v:${index}`,
      bitrate,
      `-maxrate:v:${index}`,
      bitrate,
      `-bufsize:v:${index}`,
      `${Number.parseInt(bitrate, 10) * 2}k`,
      `-pix_fmt:v:${index}`,
      "yuv420p",
      `-profile:v:${index}`,
      "main",
    );
  }
  return result;
}

function toneMapPrefix(policy: TranscodeHdrPolicy): string {
  if (policy !== "tone-map") return "";
  return "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,";
}

/** Build a seek-aware HLS transcode. Auto clients get 1080p, 720p, 480p, and
 *  360p renditions; fixed qualities get one bounded rendition. The source is
 *  never upscaled. */
export function hlsArgs(
  upstreamUrl: string,
  dir: string,
  options: HlsTranscodeOptions = {},
): string[] {
  const quality = options.quality ?? qualityForProfile(options.profile ?? "adaptive");
  const startSeconds =
    options.startSeconds != null &&
    Number.isFinite(options.startSeconds) &&
    options.startSeconds > 0
      ? Math.min(86_400, Math.floor(options.startSeconds))
      : 0;
  const hdrPolicy = options.hdrPolicy ?? "auto";
  const encoder = options.videoEncoder ?? "libx264";
  const includeAudio = options.includeAudio !== false;
  const audioTrack =
    options.audioTrack != null &&
    Number.isInteger(options.audioTrack) &&
    options.audioTrack >= 0 &&
    options.audioTrack < 32
      ? options.audioTrack
      : 0;
  const audioMap = `0:a:${audioTrack}`;
  const includeSubtitle =
    options.preserveSubtitles === true && options.includeSubtitle === true;
  const args = [
    "-nostdin",
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
  ];
  // Keep VIDEO and WebVTT in the same input clock domain, including at zero
  // start. Otherwise input normalization can shift only the generated cues.
  if (includeSubtitle) args.push("-copyts");
  if (startSeconds > 0) {
    args.push("-ss", String(startSeconds));
  }
  args.push(
    "-i",
    upstreamUrl,
  );

  if (quality === "auto") {
    const prefix = toneMapPrefix(hdrPolicy);
    args.push(
      "-filter_complex",
      `[0:v:0]split=4[v1080i][v720i][v480i][v360i];[v1080i]${prefix}scale=w=-2:h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[v1080];[v720i]${prefix}scale=w=-2:h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[v720];[v480i]${prefix}scale=w=-2:h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[v480];[v360i]${prefix}scale=w=-2:h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[v360]`,
      "-map",
      "[v1080]",
      "-map",
      "[v720]",
      "-map",
      "[v480]",
      "-map",
      "[v360]",
      ...(includeAudio
        ? [
            "-map",
            audioMap,
            "-map",
            audioMap,
            "-map",
            audioMap,
            "-map",
            audioMap,
          ]
        : []),
      ...(includeSubtitle ? ["-map", "0:s:0"] : []),
      ...encoderArgs(encoder, ["8000k", "4500k", "1800k", "700k"]),
      ...(includeAudio
        ? [
            "-c:a",
            "aac",
            "-b:a:0",
            "192k",
            "-b:a:1",
            "160k",
            "-b:a:2",
            "128k",
            "-b:a:3",
            "96k",
            "-ac",
            "2",
          ]
        : []),
      ...(includeSubtitle ? ["-c:s", "webvtt"] : []),
      "-g",
      "144",
      "-keyint_min",
      "144",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*6)",
      ...(includeSubtitle ? [] : ["-sn"]),
      "-dn",
      "-max_muxing_queue_size",
      "1024",
      // Preserve the shared output clock in both HLS and its inner TS muxer.
      ...(includeSubtitle ? [
        "-avoid_negative_ts", "disabled",
        "-hls_segment_options", "mpegts_copyts=1:avoid_negative_ts=disabled",
      ] : []),
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "event",
      "-hls_list_size",
      "0",
      "-master_pl_name",
      MANIFEST_NAME,
      "-var_stream_map",
      includeAudio
        ? includeSubtitle
          ? "v:0,a:0,s:0,sgroup:subs,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p"
          : "v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p v:3,a:3,name:360p"
        : includeSubtitle
          ? "v:0,s:0,sgroup:subs,name:1080p v:1,name:720p v:2,name:480p v:3,name:360p"
          : "v:0,name:1080p v:1,name:720p v:2,name:480p v:3,name:360p",
      ...(includeSubtitle
        ? ["-hls_subtitle_path", join(dir, TRANSCODE_SUBTITLE_PLAYLIST_PATTERN)]
        : []),
      "-hls_segment_filename",
      join(dir, "%v_seg_%05d.ts"),
      join(dir, "%v.m3u8"),
    );
  } else {
    const fixed = {
      "1080p": { height: 1080, videoBitrate: "8000k", audioBitrate: "192k" },
      "720p": { height: 720, videoBitrate: "4500k", audioBitrate: "160k" },
      "480p": { height: 480, videoBitrate: "1800k", audioBitrate: "96k" },
      "360p": { height: 360, videoBitrate: "700k", audioBitrate: "64k" },
    }[quality];
    const videoFilter =
      `${toneMapPrefix(hdrPolicy)}scale=w=-2:h='min(${fixed.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    args.push(
      "-map",
      "0:v:0",
      ...(includeAudio ? ["-map", audioMap] : []),
      ...(includeSubtitle ? ["-map", "0:s:0"] : []),
      "-vf",
      videoFilter,
      ...encoderArgs(encoder, [fixed.videoBitrate]),
      ...(includeAudio
        ? [
            "-c:a",
            "aac",
            "-b:a",
            fixed.audioBitrate,
            "-ac",
            "2",
          ]
        : []),
      ...(includeSubtitle ? ["-c:s", "webvtt"] : []),
      "-g",
      "144",
      "-keyint_min",
      "144",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*6)",
      ...(includeSubtitle ? [] : ["-sn"]),
      "-dn",
      "-max_muxing_queue_size",
      "1024",
      ...(includeSubtitle ? [
        "-avoid_negative_ts", "disabled",
        "-hls_segment_options", "mpegts_copyts=1:avoid_negative_ts=disabled",
      ] : []),
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "event",
      "-hls_list_size",
      "0",
      "-master_pl_name",
      MANIFEST_NAME,
      "-var_stream_map",
      includeAudio
        ? includeSubtitle
          ? `v:0,a:0,s:0,sgroup:subs,name:${quality}`
          : `v:0,a:0,name:${quality}`
        : includeSubtitle
          ? `v:0,s:0,sgroup:subs,name:${quality}`
          : `v:0,name:${quality}`,
      ...(includeSubtitle
        ? ["-hls_subtitle_path", join(dir, TRANSCODE_SUBTITLE_PLAYLIST_PATTERN)]
        : []),
      "-hls_segment_filename",
      join(dir, "%v_seg_%05d.ts"),
      join(dir, "%v.m3u8"),
    );
  }
  return args;
}

interface Job {
  children: ChildProcess[];
  dir: string;
  fingerprint: string;
  lastAccess: number;
  failed: boolean;
  cancelled: boolean;
  disposed: boolean;
  disposal?: Promise<void>;
  assetGeneration: string;
  startSeconds: number;
  subtitleVideoMpegTsTimestamp: number | null;
  claims: Set<PreparationTicket>;
  readers: number;
  legacyProtected: boolean;
}

interface PreparationTicket {
  id: string;
  sessionId: string;
  createdAt: number;
  state: "unused" | "pending" | "ready" | "active";
  fingerprint?: string;
  upstreamUrl?: string;
  job?: Job;
  controller?: AbortController;
  request?: Promise<string>;
  waiters: Set<symbol>;
  delivered: boolean;
}

interface PendingJob {
  fingerprint: string;
  owned?: boolean;
  tickets: Set<PreparationTicket>;
  legacyProtected: boolean;
  promise: Promise<string>;
  controller: AbortController;
  waiters: Set<symbol>;
  cancelled: boolean;
  published: boolean;
  /** Assigned immediately after FFmpeg has spawned so lifecycle operations own it. */
  job?: Job;
}

interface StreamProbeCacheEntry {
  upstreamUrl: string;
  promise: Promise<TranscoderStreamProbe | null>;
  settle: (value: TranscoderStreamProbe | null) => void;
  controller: AbortController;
  lastAccess: number;
  state: "pending" | "succeeded" | "failed";
  settledAt: number | null;
  waiters: number;
  invalidated: boolean;
}

export class TranscodeRegistry {
  private lifecycle: "open" | "closing" | "closed" = "open";
  private stopPromise: Promise<void> | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly preparations = new Map<string, Map<string, PreparationTicket>>();
  private readonly ownedJobs = new Map<string, Map<string, Job>>();
  private readonly ownedCleanup = new Map<string, Set<Promise<void>>>();
  private ownedCacheReady: Promise<string> | null = null;
  /** Child processes remain here until Node reports exit or close.
   * Completed jobs keep their cached assets in `jobs`, but no longer consume
   * an execution slot. Conversely, a disposed child still consumes a slot
   * until the OS has actually reported its termination. */
  private readonly liveChildren = new Set<ChildProcess>();
  private readonly childExits = new WeakMap<ChildProcess, Promise<void>>();
  // In-flight job creations keyed by session, so concurrent ensureJob() calls
  // for the same session share ONE creation instead of racing (which would
  // orphan an ffmpeg + temp dir and bypass the maxTranscodes cap).
  private readonly pending = new Map<string, PendingJob>();
  /** Recently promoted output directories remain readable briefly so a player
   * can finish in-flight manifest and segment requests during a safe swap. */
  private readonly retired = new Map<string, Job[]>();
  /** Invalidate staging jobs when a session is revoked or the registry stops. */
  private readonly generations = new Map<string, number>();
  /** One bounded ffprobe per stream session. The same result drives both the
   * client inventory and FFmpeg job construction, avoiding duplicate reads of
   * short-lived provider URLs. */
  private readonly streamProbes = new Map<string, StreamProbeCacheEntry>();
  private activeProbes = 0;
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: ServerConfig,
    private readonly transcoder: Transcoder,
  ) {}

  private activeWorkCount(): number {
    let pendingReservations = 0;
    for (const pending of this.pending.values()) {
      if (pending.job == null) pendingReservations += 1;
    }
    return this.liveChildren.size + pendingReservations + this.activeProbes;
  }

  private trackChild(child: ChildProcess): void {
    this.liveChildren.add(child);
    let resolveExit!: () => void;
    this.childExits.set(child, new Promise<void>((resolve) => { resolveExit = resolve; }));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.liveChildren.delete(child);
      resolveExit();
    };
    // `exit` is the process-capacity boundary. `close` follows after stdio is
    // closed and is also emitted after a spawn error. An `error` alone can mean
    // a later kill/send failure, so it must not prematurely release a process
    // that has not actually terminated.
    child.once("exit", finish);
    child.once("close", finish);
  }

  /** Boot sweep (rm temp dirs left by a previous crash) + start the idle/expiry
   *  reaper. Only called when transcoding is active. */
  start(): void {
    if (this.lifecycle !== "open") return;
    const rows = this.db.sqlite
      .prepare("SELECT transcode_dir FROM stream_sessions WHERE transcode_dir IS NOT NULL")
      .all() as Array<{ transcode_dir: string | null }>;
    for (const r of rows) {
      if (r.transcode_dir != null) {
        void rm(r.transcode_dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    this.db.sqlite.prepare("UPDATE stream_sessions SET transcode_dir = NULL").run();
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise != null) return this.stopPromise;
    this.lifecycle = "closing";
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    if (this.reaper != null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    for (const [id, probe] of this.streamProbes) {
      this.invalidateProbe(id, probe);
    }
    const pendingCreations = [
      ...[...this.pending.values()].map((entry) => entry.promise),
      ...[...this.preparations.values()].flatMap((tickets) =>
        [...tickets.values()].flatMap((ticket) => ticket.request == null ? [] : [ticket.request])),
    ];
    const ids = new Set([
      ...this.jobs.keys(),
      ...this.pending.keys(),
      ...this.retired.keys(),
      ...this.ownedJobs.keys(),
      ...this.preparations.keys(),
      ...this.ownedCleanup.keys(),
    ]);
    try {
      await Promise.all([...ids].map((id) => this.kill(id)));
      await Promise.all(pendingCreations.map((creation) => creation.catch(() => undefined)));
      await Promise.all([...this.ownedCleanup.values()].flatMap((entries) => [...entries]));
    } finally {
      this.lifecycle = "closed";
    }
  }

  private invalidateProbe(
    sessionId: string,
    entry: StreamProbeCacheEntry,
  ): void {
    if (this.streamProbes.get(sessionId) === entry) {
      this.streamProbes.delete(sessionId);
    }
    if (entry.invalidated) return;
    entry.invalidated = true;
    entry.settle(null);
    entry.controller.abort();
  }

  private waitForProbe(
    sessionId: string,
    entry: StreamProbeCacheEntry,
    options: TranscodeSourceInfoOptions,
  ): Promise<TranscoderStreamProbe | null> {
    if (entry.state !== "pending") return entry.promise;
    const timeoutMs = options.retryFailed === true
      ? PROBE_RETRY_CALLER_TIMEOUT_MS
      : PROBE_FAST_CALLER_TIMEOUT_MS;
    entry.waiters += 1;
    return new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (
        value: TranscoderStreamProbe | null,
        detached: boolean,
      ) => {
        if (finished) return;
        finished = true;
        if (timer != null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", detach);
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (
          detached &&
          entry.waiters === 0 &&
          entry.state === "pending" &&
          this.streamProbes.get(sessionId) === entry
        ) {
          this.invalidateProbe(sessionId, entry);
        }
        resolve(value);
      };
      const detach = () => finish(null, true);
      timer = setTimeout(detach, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", detach, { once: true });
      if (options.signal?.aborted === true) {
        detach();
        return;
      }
      void entry.promise.then((value) => finish(value, false));
    });
  }

  private probeStreams(
    sessionId: string,
    upstreamUrl: string,
    options: TranscodeSourceInfoOptions = {},
  ): Promise<TranscoderStreamProbe | null> {
    if (this.lifecycle !== "open" || options.signal?.aborted === true) {
      return Promise.resolve(null);
    }
    const now = Date.now();
    const cached = this.streamProbes.get(sessionId);
    let retryingFailed = false;
    if (cached?.upstreamUrl === upstreamUrl) {
      cached.lastAccess = now;
      retryingFailed =
        options.retryFailed === true &&
        cached.state === "failed" &&
        cached.settledAt != null &&
        now - cached.settledAt >= FAILED_PROBE_RETRY_COOLDOWN_MS;
      if (!retryingFailed) return this.waitForProbe(sessionId, cached, options);
    } else if (cached != null) {
      this.invalidateProbe(sessionId, cached);
    }
    // ffprobe is an external process too. Count it against the same global
    // admission budget as active and warming ffmpeg jobs so opening audio menus
    // across many sessions cannot bypass maxTranscodes.
    if (
      this.activeWorkCount() >= this.config.maxTranscodes ||
      (this.streamProbes.size >= MAX_PROBE_CACHE_ENTRIES && !retryingFailed)
    ) {
      // Keep an eligible failed entry in place unless its replacement reserves
      // the normal process budget. This avoids an eviction gap that could turn
      // a later ordinary read into an automatic retry.
      return retryingFailed
        ? this.waitForProbe(sessionId, cached!, options)
        : Promise.resolve(null);
    }
    this.activeProbes += 1;
    let resolveProbe: (value: TranscoderStreamProbe | null) => void = () => {};
    let callersSettled = false;
    const promise = new Promise<TranscoderStreamProbe | null>((resolve) => {
      resolveProbe = resolve;
    });
    const settle = (value: TranscoderStreamProbe | null) => {
      if (callersSettled) return;
      callersSettled = true;
      resolveProbe(value);
    };
    const entry: StreamProbeCacheEntry = {
      upstreamUrl,
      promise,
      settle,
      controller: new AbortController(),
      lastAccess: now,
      state: "pending",
      settledAt: null,
      waiters: 0,
      invalidated: false,
    };
    // Publish the pending entry before the adapter is called. Test adapters can
    // settle synchronously, and concurrent callers must still share this exact
    // promise without resurrecting an entry removed by kill().
    this.streamProbes.set(sessionId, entry);
    let adapterSettled = false;
    let childReported = false;
    let childClosed = false;
    let admissionReleased = false;
    const releaseAdmission = () => {
      if (
        admissionReleased ||
        !adapterSettled ||
        (childReported && !childClosed)
      ) {
        return;
      }
      admissionReleased = true;
      this.activeProbes = Math.max(0, this.activeProbes - 1);
    };
    const onSpawn = (child: ChildProcess) => {
      if (childReported) {
        entry.controller.abort();
        return;
      }
      childReported = true;
      child.once("close", () => {
        childClosed = true;
        releaseAdmission();
      });
    };
    const finish = (value: TranscoderStreamProbe | null) => {
      if (adapterSettled) return;
      adapterSettled = true;
      releaseAdmission();
      if (
        entry.invalidated ||
        this.streamProbes.get(sessionId) !== entry
      ) {
        settle(null);
        return;
      }
      entry.state = value == null ? "failed" : "succeeded";
      entry.settledAt = Date.now();
      settle(value);
    };
    if (this.transcoder.probeStreams == null) {
      finish(null);
      return this.waitForProbe(sessionId, entry, options);
    }
    try {
      void this.transcoder.probeStreams(upstreamUrl, {
        timeoutMs: options.retryFailed === true
          ? STREAM_PROBE_RETRY_TIMEOUT_MS
          : STREAM_PROBE_FAST_TIMEOUT_MS,
        signal: entry.controller.signal,
        onSpawn,
      }).then(
        (value) => finish(value),
        () => finish(null),
      );
    } catch {
      entry.controller.abort();
      finish(null);
    }
    return this.waitForProbe(sessionId, entry, options);
  }

  async audioTracksFor(
    sessionId: string,
    upstreamUrl: string,
  ): Promise<TranscoderAudioTrack[] | null> {
    return (await this.sourceInfoFor(sessionId, upstreamUrl)).audioTracks;
  }

  async subtitleAvailableFor(
    sessionId: string,
    upstreamUrl: string,
    options: TranscodeSourceInfoOptions = {},
  ): Promise<boolean | null> {
    const probe = await this.probeStreams(sessionId, upstreamUrl, options);
    return probe == null ? null : probe.subtitle === true;
  }

  async sourceInfoFor(
    sessionId: string,
    upstreamUrl: string,
    options: TranscodeSourceInfoOptions = {},
  ): Promise<TranscodeSourceInfo> {
    const probe = await this.probeStreams(sessionId, upstreamUrl, options);
    const durationSeconds = probe?.durationSeconds;
    return {
      audioTracks:
        probe?.audioTracks == null
          ? null
          : probe.audioTracks.map((track) => ({ ...track })),
      durationSeconds:
        typeof durationSeconds === "number" &&
        Number.isFinite(durationSeconds) &&
        durationSeconds > 0 &&
        durationSeconds <= 86_400
          ? durationSeconds
          : null,
    };
  }

  /** Kill jobs whose session is gone/revoked/expired, or idle (client left). */
  private reap(): void {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.expireUnusedPreparations(now);
    for (const [id, entries] of this.ownedJobs) {
      const row = this.db.sqlite
        .prepare("SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?")
        .get(id) as { revoked_at: string | null; expires_at: string | null } | undefined;
      if (row == null || row.revoked_at != null || (row.expires_at != null && row.expires_at <= nowIso)) {
        void this.kill(id);
        continue;
      }
      for (const job of [...entries.values()]) {
        if (now - job.lastAccess > IDLE_MS && job.readers === 0) {
          for (const ticket of [...job.claims]) this.removePreparation(ticket);
          job.claims.clear();
          this.forgetOwnedJob(id, job);
          void this.disposeOwnedJob(id, job);
        }
      }
    }
    for (const [id, job] of [...this.jobs.entries()]) {
      const row = this.db.sqlite
        .prepare("SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?")
        .get(id) as { revoked_at: string | null; expires_at: string | null } | undefined;
      const dead =
        row == null ||
        row.revoked_at != null ||
        (row.expires_at != null && row.expires_at <= nowIso) ||
        (now - job.lastAccess > IDLE_MS && job.readers === 0);
      if (dead) void this.kill(id);
    }
    for (const id of this.pending.keys()) {
      const row = this.db.sqlite
        .prepare("SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?")
        .get(id) as { revoked_at: string | null; expires_at: string | null } | undefined;
      if (row == null || row.revoked_at != null || (row.expires_at != null && row.expires_at <= nowIso)) {
        void this.kill(id);
      }
    }
    for (const [id, probe] of this.streamProbes) {
      const row = this.db.sqlite
        .prepare("SELECT revoked_at, expires_at FROM stream_sessions WHERE id = ?")
        .get(id) as { revoked_at: string | null; expires_at: string | null } | undefined;
      if (
        row == null ||
        row.revoked_at != null ||
        (row.expires_at != null && row.expires_at <= nowIso) ||
        now - probe.lastAccess > PROBE_CACHE_IDLE_MS
      ) {
        this.invalidateProbe(id, probe);
      }
    }
  }

  async kill(sessionId: string): Promise<void> {
    const probe = this.streamProbes.get(sessionId);
    if (probe != null) this.invalidateProbe(sessionId, probe);
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    const owned = [...(this.ownedJobs.get(sessionId)?.values() ?? [])];
    this.ownedJobs.delete(sessionId);
    for (const ticket of [...(this.preparations.get(sessionId)?.values() ?? [])]) {
      this.removePreparation(ticket);
      ticket.controller?.abort();
    }
    for (const item of owned) { item.cancelled = true; item.claims.clear(); }
    const job = this.jobs.get(sessionId);
    if (job != null) {
      this.jobs.delete(sessionId);
      await this.disposeJob(sessionId, job, false);
    }
    const pending = this.pending.get(sessionId);
    const hadPendingJob = pending?.job != null;
    if (pending?.job != null) {
      pending.job.cancelled = true;
      await this.disposeJob(sessionId, pending.job, false);
      pending.job = undefined;
    }
    await pending?.promise.catch(() => undefined);
    await Promise.all(owned.map((item) => this.disposeOwnedJob(sessionId, item)));
    const retired = this.retired.get(sessionId) ?? [];
    this.retired.delete(sessionId);
    await Promise.all(retired.map((item) => this.disposeJob(sessionId, item, false)));
    if (job != null || hadPendingJob || retired.length > 0) {
      try {
        this.db.sqlite.prepare("UPDATE stream_sessions SET transcode_dir = NULL WHERE id = ?").run(sessionId);
      } catch {
        /* db may be closing */
      }
    }
  }

  /** Stop one job and remove its staging/output directory. A replacement calls
   * this only after its successor has become the active job, so the database
   * pointer is never cleared while a new manifest is serving. */
  private disposeJob(
    sessionId: string,
    job: Job,
    clearSessionDir: boolean,
  ): Promise<void> {
    if (job.disposal != null) return job.disposal;
    job.disposed = true;
    job.disposal = this.finishDisposal(sessionId, job, clearSessionDir);
    return job.disposal;
  }

  private async finishDisposal(sessionId: string, job: Job, clearSessionDir: boolean): Promise<void> {
    const exited = Promise.all(job.children.map((child) => this.childExits.get(child)));
    try {
      for (const child of job.children) child.kill("SIGTERM");
    } catch {
      /* already stopped */
    }
    const force = setTimeout(() => {
      try {
        for (const child of job.children) {
          if (this.liveChildren.has(child)) child.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
    }, KILL_GRACE_MS);
    force.unref?.();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), KILL_GRACE_MS + 1000);
      }),
    ]);
    clearTimeout(force);
    clearTimeout(deadline);
    if (!stopped) {
      // A signal is not process exit. Keep admission charged and remove output
      // only after a later actual exit, without holding callers indefinitely.
      void exited.then(() => rm(job.dir, { recursive: true, force: true })).catch(() => {});
      return;
    }
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
    if (clearSessionDir) {
      try {
        this.db.sqlite.prepare("UPDATE stream_sessions SET transcode_dir = NULL WHERE id = ?").run(sessionId);
      } catch {
        /* db may be closing */
      }
    }
  }

  private async retireJob(sessionId: string, job: Job): Promise<void> {
    if (job.claims.size > 0 || job.readers > 0) {
      this.storeOwnedJob(sessionId, job);
      return;
    }
    try {
      for (const child of job.children) child.kill("SIGTERM");
    } catch {
      /* already stopped */
    }
    const entries = this.retired.get(sessionId) ?? [];
    entries.push(job);
    this.retired.set(sessionId, entries);
    const timer = setTimeout(() => {
      const current = this.retired.get(sessionId) ?? [];
      this.retired.set(sessionId, current.filter((item) => item !== job));
      if ((this.retired.get(sessionId)?.length ?? 0) === 0) {
        this.retired.delete(sessionId);
      }
      void this.disposeJob(sessionId, job, false);
    }, RETIRED_ASSET_GRACE_MS);
    timer.unref?.();
  }

  /** The output dir for a live job (touches lastAccess), or null. */
  dirFor(sessionId: string): string | null {
    const job = this.jobs.get(sessionId);
    if (job == null) return null;
    job.lastAccess = Date.now();
    return job.dir;
  }

  /** Renew only the current, still-live output. A lease never creates work or
   * extends the fixed grace period of a replaced generation. Authorization is
   * checked by the asset route before calling this method. */
  touchCurrentGeneration(sessionId: string, asset: string, generation: string): boolean {
    const current = this.jobs.get(sessionId);
    const job = current?.assetGeneration === generation ? current : this.ownedJobs.get(sessionId)?.get(generation);
    const now = Date.now();
    if (
      job == null || job.assetGeneration !== generation ||
      job.failed || job.cancelled || job.disposed ||
      now - job.lastAccess > IDLE_MS ||
      !/^(?:1080p|720p|480p|360p)\.m3u8$/.test(asset) ||
      !existsSync(join(job.dir, asset))
    ) return false;
    job.lastAccess = now;
    job.legacyProtected = true;
    return true;
  }

  generationFor(sessionId: string, dir: string): string | null {
    const candidates = [
      this.jobs.get(sessionId),
      ...(this.retired.get(sessionId) ?? []),
      ...(this.ownedJobs.get(sessionId)?.values() ?? []),
    ];
    return candidates.find((job) => job?.dir === dir)?.assetGeneration ?? null;
  }

  dirForAsset(sessionId: string, asset: string, generation?: string): string | null {
    const candidates = [
      this.jobs.get(sessionId),
      ...(this.retired.get(sessionId) ?? []),
      ...(this.ownedJobs.get(sessionId)?.values() ?? []),
    ].filter((job): job is Job => job != null);
    const match = generation == null
      ? candidates[0]
      : candidates.find((job) => job.assetGeneration === generation);
    if (match == null || !existsSync(join(match.dir, asset))) return null;
    match.lastAccess = Date.now();
    match.legacyProtected = true;
    return match.dir;
  }

  startSecondsForAsset(sessionId: string, generation?: string): number | null {
    const candidates = [
      this.jobs.get(sessionId),
      ...(this.retired.get(sessionId) ?? []),
      ...(this.ownedJobs.get(sessionId)?.values() ?? []),
    ].filter((job): job is Job => job != null);
    const match = generation == null
      ? candidates[0]
      : candidates.find((job) => job.assetGeneration === generation);
    return match?.startSeconds ?? null;
  }

  subtitleReadyForAsset(
    sessionId: string,
    generation?: string,
  ): boolean {
    const candidates = [
      this.jobs.get(sessionId),
      ...(this.retired.get(sessionId) ?? []),
      ...(this.ownedJobs.get(sessionId)?.values() ?? []),
    ].filter((job): job is Job => job != null);
    const match = generation == null
      ? candidates[0]
      : candidates.find((job) => job.assetGeneration === generation);
    return match?.subtitleVideoMpegTsTimestamp != null;
  }

  /** IDs are allocated by the authenticated route, never by a manifest GET.
   * Removing an ID is terminal: a delayed GET cannot recreate its claim. */
  registerPreparation(sessionId: string, preparationId: string): void {
    if (this.lifecycle !== "open") throw preparationGone();
    this.expireUnusedPreparations(Date.now());
    const tickets = this.preparations.get(sessionId) ?? new Map<string, PreparationTicket>();
    if (tickets.has(preparationId)) {
      throw Object.assign(new Error("The preparation ID is already registered."), { statusCode: 409 });
    }
    const total = [...this.preparations.values()].reduce((count, entries) => count + entries.size, 0);
    if (tickets.size >= MAX_SESSION_PREPARATIONS || total >= MAX_PREPARATIONS) {
      throw Object.assign(new Error("Too many transcode preparations."), { statusCode: 429 });
    }
    tickets.set(preparationId, {
      id: preparationId, sessionId, createdAt: Date.now(), state: "unused",
      waiters: new Set(), delivered: false,
    });
    this.preparations.set(sessionId, tickets);
  }

  isPreparationRegistered(sessionId: string, preparationId: string): boolean {
    if (this.lifecycle !== "open") return false;
    this.expireUnusedPreparations(Date.now());
    return this.preparations.get(sessionId)?.has(preparationId) === true;
  }

  async acquirePreparation(
    sessionId: string,
    preparationId: string,
    upstreamUrl: string,
    options: HlsTranscodeOptions = {},
    lifecycle: TranscodeJobLifecycle = {},
  ): Promise<TranscodePreparedJob> {
    if (lifecycle.signal?.aborted === true) throw preparationCancelled();
    if (this.lifecycle !== "open") throw preparationGone();
    this.expireUnusedPreparations(Date.now());
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    if (ticket == null) throw preparationGone();
    const fingerprint = JSON.stringify(this.normalizeOptions(options));
    if (ticket.fingerprint != null && (ticket.fingerprint !== fingerprint || ticket.upstreamUrl !== upstreamUrl)) {
      throw Object.assign(new Error("A preparation cannot change its source or playback options."), { statusCode: 409 });
    }
    ticket.fingerprint = fingerprint;
    ticket.upstreamUrl = upstreamUrl;
    if (ticket.request == null) {
      ticket.controller = new AbortController();
      if (ticket.job == null) ticket.state = "pending";
      ticket.request = this.ensureJobInternal(sessionId, upstreamUrl, options, {
        signal: ticket.controller.signal,
      }, ticket).finally(() => {
        ticket.request = undefined;
        if (this.hasPreparation(ticket) && ticket.job == null) ticket.state = "unused";
      });
    }
    const request = ticket.request;
    const waiter = Symbol();
    ticket.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (aborted: boolean, error?: unknown) => {
        if (finished) return;
        finished = true;
        lifecycle.signal?.removeEventListener("abort", abort);
        ticket.waiters.delete(waiter);
        if (aborted) {
          if (ticket.waiters.size === 0 && !ticket.delivered && ticket.state !== "active") {
            void this.cancelPreparation(sessionId, preparationId).catch(() => {});
          }
          reject(preparationCancelled());
        } else if (error != null) {
          reject(error);
        } else if (!this.hasPreparation(ticket) || ticket.job == null || ticket.job.disposed || ticket.job.cancelled) {
          reject(preparationGone());
        } else {
          ticket.delivered = true;
          const job = ticket.job;
          resolve({ dir: job.dir, generation: job.assetGeneration, release: this.pinPreparationJob(sessionId, job) });
        }
      };
      const abort = () => finish(true);
      lifecycle.signal?.addEventListener("abort", abort, { once: true });
      void request.then(() => finish(false), (error: unknown) => finish(false, error));
      if (lifecycle.signal?.aborted === true) abort();
    });
  }

  activatePreparation(sessionId: string, preparationId: string, expectedGeneration: string): TranscodePreparationActionResult {
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    if (ticket == null) return "gone";
    if (ticket.job == null) return "not-ready";
    if (ticket.job.assetGeneration !== expectedGeneration) return "generation-mismatch";
    if (ticket.job.disposed || ticket.job.cancelled || ticket.job.failed) return "gone";
    ticket.state = "active";
    ticket.job.lastAccess = Date.now();
    return "applied";
  }

  async cancelPreparation(sessionId: string, preparationId: string, expectedGeneration?: string): Promise<TranscodePreparationActionResult> {
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    if (ticket == null) return "gone";
    if (expectedGeneration != null && ticket.job?.assetGeneration !== expectedGeneration) return "generation-mismatch";
    if (ticket.state === "active") return "active";
    const job = ticket.job;
    const request = ticket.request;
    this.removePreparation(ticket);
    ticket.controller?.abort();
    if (job != null) await this.reclaimPreparationJob(sessionId, job);
    else {
      const pending = this.pending.get(sessionId);
      if (pending?.cancelled === true) await pending.promise.catch(() => undefined);
      else await request?.catch(() => undefined);
    }
    return "applied";
  }

  async releasePreparation(sessionId: string, preparationId: string, expectedGeneration: string): Promise<TranscodePreparationActionResult> {
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    if (ticket == null) return "gone";
    if (ticket.job?.assetGeneration !== expectedGeneration) return "generation-mismatch";
    const job = ticket.job;
    this.removePreparation(ticket);
    ticket.controller?.abort();
    await this.reclaimPreparationJob(sessionId, job);
    return "applied";
  }

  acquirePreparationAsset(sessionId: string, preparationId: string, generation: string, asset: string): TranscodePreparationAsset | null {
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    const job = ticket?.job;
    if (ticket?.state !== "active" || job == null || job.assetGeneration !== generation ||
      job.disposed || job.cancelled || job.failed ||
      (asset !== MANIFEST_NAME && !isTranscodeAssetName(asset)) || !existsSync(join(job.dir, asset))) return null;
    job.lastAccess = Date.now();
    return { dir: job.dir, release: this.pinPreparationJob(sessionId, job) };
  }

  touchPreparationGeneration(sessionId: string, preparationId: string, generation: string, asset: string): boolean {
    const ticket = this.preparations.get(sessionId)?.get(preparationId);
    const job = ticket?.job;
    if (ticket?.state !== "active" || job == null || job.assetGeneration !== generation ||
      job.disposed || job.cancelled || job.failed || Date.now() - job.lastAccess > IDLE_MS ||
      !/^(?:1080p|720p|480p|360p)\.m3u8$/.test(asset) || !existsSync(join(job.dir, asset))) return false;
    job.lastAccess = Date.now();
    return true;
  }

  private hasPreparation(ticket: PreparationTicket): boolean {
    return this.preparations.get(ticket.sessionId)?.get(ticket.id) === ticket;
  }

  private removePreparation(ticket: PreparationTicket): void {
    if (!this.hasPreparation(ticket)) return;
    const tickets = this.preparations.get(ticket.sessionId)!;
    tickets.delete(ticket.id);
    if (tickets.size === 0) this.preparations.delete(ticket.sessionId);
    ticket.job?.claims.delete(ticket);
    this.pending.get(ticket.sessionId)?.tickets.delete(ticket);
  }

  private bindPreparation(ticket: PreparationTicket, job: Job): void {
    if (!this.hasPreparation(ticket)) return;
    ticket.job = job;
    if (ticket.state !== "active") ticket.state = "ready";
    job.claims.add(ticket);
    job.lastAccess = Date.now();
  }

  private expireUnusedPreparations(now: number): void {
    for (const tickets of this.preparations.values()) {
      for (const ticket of [...tickets.values()]) {
        if (ticket.state === "unused" && ticket.request == null && now - ticket.createdAt >= UNUSED_PREPARATION_MS) {
          this.removePreparation(ticket);
        }
      }
    }
  }

  private prepareOwnedCache(): Promise<string> {
    if (this.ownedCacheReady == null) {
      const root = join(this.config.dataDir, "transcode-preparations");
      this.ownedCacheReady = (async () => {
        // This dedicated namespace contains only disposable owned HLS output.
        // Await its one-time crash sweep before any new generation is created.
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        return root;
      })();
    }
    return this.ownedCacheReady;
  }

  private storeOwnedJob(sessionId: string, job: Job): void {
    const entries = this.ownedJobs.get(sessionId) ?? new Map<string, Job>();
    entries.set(job.assetGeneration, job);
    this.ownedJobs.set(sessionId, entries);
  }

  private forgetOwnedJob(sessionId: string, job: Job): void {
    const entries = this.ownedJobs.get(sessionId);
    entries?.delete(job.assetGeneration);
    if (entries?.size === 0) this.ownedJobs.delete(sessionId);
  }

  private pinPreparationJob(sessionId: string, job: Job): () => void {
    job.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      job.readers -= 1;
      void this.reclaimPreparationJob(sessionId, job).catch(() => {});
    };
  }

  private reclaimPreparationJob(sessionId: string, job: Job): Promise<void> {
    if (job.legacyProtected || job.claims.size > 0 || job.readers > 0) return Promise.resolve();
    job.cancelled = true;
    this.forgetOwnedJob(sessionId, job);
    return this.disposeOwnedJob(sessionId, job);
  }

  private disposeOwnedJob(sessionId: string, job: Job): Promise<void> {
    const cleanup = this.disposeJob(sessionId, job, false);
    const entries = this.ownedCleanup.get(sessionId) ?? new Set<Promise<void>>();
    entries.add(cleanup);
    this.ownedCleanup.set(sessionId, entries);
    void cleanup.finally(() => {
      entries.delete(cleanup);
      if (entries.size === 0 && this.ownedCleanup.get(sessionId) === entries) this.ownedCleanup.delete(sessionId);
    }).catch(() => {});
    return cleanup;
  }

  /** Ensure an HLS job exists for this session and return its output dir once the
   *  manifest + first segment are available. Reuses a live job; otherwise spawns
   *  one (subject to the concurrency cap). */
  async ensureJob(
    sessionId: string,
    upstreamUrl: string,
    options: HlsTranscodeOptions = {},
    lifecycle: TranscodeJobLifecycle = {},
  ): Promise<string> {
    return this.ensureJobInternal(sessionId, upstreamUrl, options, lifecycle);
  }

  private async ensureJobInternal(
    sessionId: string,
    upstreamUrl: string,
    options: HlsTranscodeOptions,
    lifecycle: TranscodeJobLifecycle,
    ticket?: PreparationTicket,
  ): Promise<string> {
    if (lifecycle.signal?.aborted === true) throw preparationCancelled();
    if (ticket != null && !this.hasPreparation(ticket)) throw preparationGone();
    if (this.lifecycle !== "open") {
      throw Object.assign(new Error("The transcode registry is closed."), { statusCode: 410 });
    }
    const requestGeneration = this.generations.get(sessionId) ?? 0;
    const normalizedOptions = this.normalizeOptions(options);
    const fingerprint = JSON.stringify(normalizedOptions);
    const existing = this.jobs.get(sessionId);
    const reusable = [existing, ...(this.ownedJobs.get(sessionId)?.values() ?? [])]
      .find((job) => job != null && !job.failed && !job.cancelled && !job.disposed && job.fingerprint === fingerprint);
    if (reusable != null) {
      reusable.lastAccess = Date.now();
      if (ticket == null) reusable.legacyProtected = true;
      else this.bindPreparation(ticket, reusable);
      return reusable.dir;
    }
    const cleanup = this.ownedCleanup.get(sessionId);
    if (cleanup != null && cleanup.size > 0) {
      await Promise.all([...cleanup]);
      return this.ensureJobInternal(sessionId, upstreamUrl, options, lifecycle, ticket);
    }
    // Coalesce concurrent creations for the same session into one promise.
    const inflight = this.pending.get(sessionId);
    if (inflight != null) {
      if (!inflight.cancelled && inflight.fingerprint === fingerprint) {
        if (ticket == null) inflight.legacyProtected = true;
        else inflight.tickets.add(ticket);
        return this.waitForCreation(sessionId, inflight, lifecycle.signal, true);
      }
      // A request changed profile/offset while the first FFmpeg startup was in
      // flight. Let that creation settle, then re-evaluate and replace it so we
      // never return a manifest for the wrong playback timeline.
      try {
        await this.waitForCreation(sessionId, inflight, lifecycle.signal, false);
      } catch {
        if (lifecycle.signal?.aborted) throw preparationCancelled();
      }
      if (
        this.lifecycle !== "open" ||
        (this.generations.get(sessionId) ?? 0) !== requestGeneration
      ) {
        throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
      }
      return this.ensureJobInternal(sessionId, upstreamUrl, options, lifecycle, ticket);
    }
    const generation = requestGeneration;
    const pendingEntry: PendingJob = {
      fingerprint,
      owned: ticket != null,
      tickets: new Set(ticket == null ? [] : [ticket]),
      legacyProtected: ticket == null,
      promise: Promise.resolve(""),
      controller: new AbortController(),
      waiters: new Set(),
      cancelled: false,
      published: false,
    };
    const created = this.createJob(
      sessionId,
      upstreamUrl,
      normalizedOptions,
      fingerprint,
      existing,
      generation,
      pendingEntry,
      (job) => {
        pendingEntry.job = job;
        if (
          this.lifecycle !== "open" ||
          (this.generations.get(sessionId) ?? 0) !== generation
        ) {
          job.cancelled = true;
          void this.disposeJob(sessionId, job, false);
        }
      },
    ).finally(async () => {
      if (pendingEntry.cancelled && pendingEntry.job != null) {
        await this.disposeJob(sessionId, pendingEntry.job, false);
      }
      if (this.pending.get(sessionId) === pendingEntry) {
        this.pending.delete(sessionId);
      }
    });
    pendingEntry.promise = created;
    this.pending.set(sessionId, pendingEntry);
    return this.waitForCreation(sessionId, pendingEntry, lifecycle.signal, true);
  }

  private normalizeOptions(options: HlsTranscodeOptions): HlsTranscodeOptions {
    return {
      profile: options.profile ?? "adaptive",
      quality: options.quality ?? qualityForProfile(options.profile ?? "adaptive"),
      startSeconds: Math.max(0, Math.floor(options.startSeconds ?? 0)),
      audioTrack:
        options.audioTrack != null && Number.isInteger(options.audioTrack)
          ? Math.min(31, Math.max(0, options.audioTrack))
          : 0,
      hdrPolicy: options.hdrPolicy ?? "auto",
      preserveSubtitles: options.preserveSubtitles === true,
      videoEncoder: options.videoEncoder ?? this.config.transcodeVideoEncoder,
    };
  }

  private waitForCreation(sessionId: string, entry: PendingJob, signal: AbortSignal | undefined, owns: boolean): Promise<string> {
    const waiter = Symbol();
    if (owns) entry.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (aborted: boolean, value?: string, error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        if (owns) entry.waiters.delete(waiter);
        if (aborted && owns && entry.waiters.size === 0 && !entry.published &&
          this.pending.get(sessionId) === entry) {
          entry.cancelled = true;
          entry.controller.abort();
          if (entry.job != null) {
            entry.job.cancelled = true;
            void this.disposeJob(sessionId, entry.job, false);
          }
        }
        if (aborted) reject(preparationCancelled());
        else if (error != null) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(true);
      signal?.addEventListener("abort", abort, { once: true });
      void entry.promise.then((value) => finish(false, value), (error: unknown) => finish(false, undefined, error));
      if (signal?.aborted === true) abort();
    });
  }

  private async createJob(
    sessionId: string,
    upstreamUrl: string,
    options: HlsTranscodeOptions,
    fingerprint: string,
    previous: Job | undefined,
    generation: number,
    creation: PendingJob,
    registerStaged: (job: Job) => void,
  ): Promise<string> {
    const assertCurrent = () => {
      if (creation.cancelled) throw preparationCancelled();
      if (this.lifecycle !== "open" || (this.generations.get(sessionId) ?? 0) !== generation) {
        throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
      }
    };
    assertCurrent();
    // Count actual live ffmpeg work, including a staged replacement. A quality
    // switch at a saturated cap fails honestly while the current job remains
    // playable, rather than exceeding the operator's process limit.
    if (this.activeWorkCount() >= this.config.maxTranscodes) {
      throw Object.assign(new Error("The transcoder is busy. Try again shortly."), { statusCode: 503 });
    }

    const outputRoot = creation.owned ? await this.prepareOwnedCache() : this.config.dataDir;
    assertCurrent();
    await mkdir(outputRoot, { recursive: true });
    assertCurrent();
    if (
      this.lifecycle !== "open" ||
      (this.generations.get(sessionId) ?? 0) !== generation
    ) {
      throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
    }
    const dir = await mkdtemp(join(outputRoot, "transcode-"));
    if (creation.cancelled) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw preparationCancelled();
    }
    if (
      this.lifecycle !== "open" ||
      (this.generations.get(sessionId) ?? 0) !== generation
    ) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
    }
    let child: ChildProcess;
    const streamProbe = await this.probeStreams(sessionId, upstreamUrl, { signal: creation.controller.signal });
    if (creation.cancelled) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw preparationCancelled();
    }
    if (
      this.lifecycle !== "open" ||
      (this.generations.get(sessionId) ?? 0) !== generation
    ) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
    }
    const processOptions = {
      ...options,
      includeAudio: streamProbe?.audio ?? true,
      includeSubtitle:
        options.preserveSubtitles === true && streamProbe?.subtitle === true,
    };
    try {
      child = this.transcoder.spawnHls(
        hlsArgs(upstreamUrl, dir, processOptions),
      );
    } catch (err) {
      // spawn threw synchronously (e.g. fd/memory exhaustion) BEFORE the job was
      // registered - rm the orphaned dir now (the boot sweep only knows about
      // dirs recorded on a session row, so it could never reclaim this one).
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    const children = [child];
    const job: Job = {
      children,
      dir,
      fingerprint,
      lastAccess: Date.now(),
      failed: false,
      cancelled: false,
      disposed: false,
      assetGeneration: basename(dir),
      startSeconds: options.startSeconds ?? 0,
      subtitleVideoMpegTsTimestamp: null,
      claims: new Set(),
      readers: 0,
      legacyProtected: creation.legacyProtected,
    };
    for (const process of children) this.trackChild(process);
    registerStaged(job);
    // Prevent an unhandled spawn error from crashing the server and let startup
    // fail immediately when FFmpeg exits before producing a playable segment.
    for (const process of children) {
      process.once("error", () => {
        job.failed = true;
      });
      process.once("exit", (code) => {
        if (code !== 0) job.failed = true;
      });
    }
    if (creation.cancelled) {
      job.cancelled = true;
      await this.disposeJob(sessionId, job, false);
      throw preparationCancelled();
    }

    const manifest = join(dir, MANIFEST_NAME);
    const quality = options.quality ?? qualityForProfile(options.profile ?? "adaptive");
    const firstSeg = join(
      dir,
      quality === "auto" ? FIRST_ADAPTIVE_SEGMENT : `${quality}_seg_00000.ts`,
    );
    const firstSubtitlePrefix = quality === "auto" ? "1080p" : quality;
    const subtitlePlaylist = join(dir, `${firstSubtitlePrefix}_subtitles.m3u8`);
    const firstSubtitleSegment = join(
      dir,
      `${firstSubtitlePrefix}0.vtt`,
    );
    const deadline = Date.now() + this.config.transcodeStartTimeoutMs;
    while (Date.now() < deadline) {
      if (job.cancelled) {
        await this.disposeJob(sessionId, job, false);
        if (creation.cancelled) throw preparationCancelled();
        throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
      }
      if (
        processOptions.includeSubtitle === true &&
        job.subtitleVideoMpegTsTimestamp == null &&
        existsSync(firstSeg)
      ) {
        job.subtitleVideoMpegTsTimestamp =
          await readInitialMpegTsVideoPresentationTimestamp(firstSeg);
      }
      const subtitleReady =
        processOptions.includeSubtitle !== true ||
        (
          existsSync(subtitlePlaylist) &&
          existsSync(firstSubtitleSegment) &&
          job.subtitleVideoMpegTsTimestamp != null
        );
      if (existsSync(manifest) && existsSync(firstSeg) && subtitleReady) {
        // Atomically make the fully playable replacement visible before the
        // old process and files are touched. A failed warm-up never changes the
        // active map entry or session directory.
        if (
          creation.cancelled || job.cancelled || this.lifecycle !== "open" ||
          (this.generations.get(sessionId) ?? 0) !== generation
        ) {
          await this.disposeJob(sessionId, job, false);
          if (creation.cancelled) throw preparationCancelled();
          throw Object.assign(new Error("The transcode session was closed."), { statusCode: 410 });
        }
        creation.published = true;
        job.legacyProtected ||= creation.legacyProtected;
        for (const ticket of creation.tickets) {
          if (this.hasPreparation(ticket)) this.bindPreparation(ticket, job);
        }
        if (creation.owned) {
          this.storeOwnedJob(sessionId, job);
          return dir;
        }
        this.jobs.set(sessionId, job);
        this.db.sqlite
          .prepare("UPDATE stream_sessions SET transcode_dir = ? WHERE id = ?")
          .run(dir, sessionId);
        if (previous != null) await this.retireJob(sessionId, previous);
        return dir;
      }
      if (job.failed) {
        await this.disposeJob(sessionId, job, false);
        throw Object.assign(
          new Error("The transcode process stopped before playback was ready."),
          { statusCode: 502 },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.disposeJob(sessionId, job, false);
    throw Object.assign(new Error("The transcode did not start in time."), { statusCode: 504 });
  }
}
