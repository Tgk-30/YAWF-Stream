import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface FixtureCLI {
  repo: string;
  output: string;
  smokeOnly: boolean;
}

function parseFixtureCLI(argv: string[]): FixtureCLI {
  let repo: string | null = null;
  let output: string | null = null;
  let smokeOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--smoke-only") {
      if (smokeOnly) throw new Error("Duplicate --smoke-only argument.");
      smokeOnly = true;
      continue;
    }
    if (argument !== "--repo" && argument !== "--output") {
      throw new Error(`Unknown fixture argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;
    if (argument === "--repo") {
      if (repo != null) throw new Error("Duplicate --repo argument.");
      repo = value;
    } else {
      if (output != null) throw new Error("Duplicate --output argument.");
      output = value;
    }
  }
  if (repo == null || output == null) {
    throw new Error("Usage: server-ui-fixture.mts --repo <absolute-checkout> --output <absolute-empty-directory> [--smoke-only]");
  }
  return { repo, output, smokeOnly };
}

function canonicalAbsoluteDirectory(raw: string, label: string, create: boolean): string {
  if (!isAbsolute(raw) || resolve(raw) !== raw || raw.length > 4096 || raw === sep) {
    throw new Error(`${label} must be a normalized absolute non-root path.`);
  }
  if (create && !existsSync(raw)) mkdirSync(raw, { recursive: true, mode: 0o700 });
  if (!existsSync(raw) || !lstatSync(raw).isDirectory() || realpathSync(raw) !== raw) {
    throw new Error(`${label} must resolve directly to a local directory, not a symlink.`);
  }
  return raw;
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

const fixtureCLI = parseFixtureCLI(process.argv.slice(2));
const REPO = canonicalAbsoluteDirectory(fixtureCLI.repo, "--repo", false);
const ARTIFACT_DIR = canonicalAbsoluteDirectory(fixtureCLI.output, "--output", true);
if (isInside(REPO, ARTIFACT_DIR) || isInside(ARTIFACT_DIR, REPO)) {
  throw new Error("--output and --repo must be separate directory trees.");
}
if (readdirSync(ARTIFACT_DIR).length !== 0) {
  throw new Error("--output must be empty so evidence is never overwritten or mixed.");
}
for (const required of [
  join(REPO, ".git"),
  join(REPO, "server", "package.json"),
  join(REPO, "server", "src", "app.ts"),
  join(REPO, "web", "dist", "index.html"),
]) {
  if (!existsSync(required)) throw new Error(`The checkout is missing a required input: ${basename(required)}`);
}
const WEB_DIST = join(REPO, "web", "dist");
const MEDIA_DIR = join(ARTIFACT_DIR, "media");
const MAX_WEB_DIST_FILES = 512;
const MAX_WEB_DIST_BYTES = 64 * 1024 * 1024;

type AdmittedWebDistEntry = {
  path: string;
  bytes: number;
  sha256: string;
};

function admittedWebDist(): AdmittedWebDistEntry[] {
  const files: AdmittedWebDistEntry[] = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Compiled web assets must not contain symlinks.");
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("Compiled web assets must contain only regular files and directories.");
      const path = relative(WEB_DIST, absolute).split(sep).join("/");
      if (path.length === 0 || path.startsWith("../") || isAbsolute(path)) {
        throw new Error("Compiled web asset escaped the exact admitted dist directory.");
      }
      const body = readFileSync(absolute);
      totalBytes += body.length;
      if (files.length >= MAX_WEB_DIST_FILES || totalBytes > MAX_WEB_DIST_BYTES) {
        throw new Error("Compiled web asset inventory exceeded its fixed file or byte bound.");
      }
      files.push({
        path,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  };
  visit(WEB_DIST);
  if (files.length === 0 || !files.some((entry) => entry.path === "index.html")) {
    throw new Error("Compiled web asset inventory lacks index.html.");
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

const HOST = "127.0.0.1";
const APP_PORT = boundedPort(process.env.FIXTURE_APP_PORT, 43120);
const MEDIA_PORT = boundedPort(process.env.FIXTURE_MEDIA_PORT, 43121);
const APP_ORIGIN = `http://${HOST}:${APP_PORT}`;
const MEDIA_ORIGIN = `http://${HOST}:${MEDIA_PORT}`;

const USERNAME = "fixture-owner";
const PASSWORD = "fixture-owner-password";
const TITLE = "Synthetic Fixture Movie";
const HASH = "a".repeat(40);
const MOVIE_PATH = join(MEDIA_DIR, "synthetic.mp4");
const MOVIE_URL = `${MEDIA_ORIGIN}/media/synthetic.mp4`;

const EXTERNAL_CAPABILITY_PATH = /^\/api\/external-stream\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{32,128}(?:\/[a-f0-9]{64}\.[a-z0-9]{1,8})?$/;
const EXTERNAL_RECEIPT_LIMIT = 128;
const EXTERNAL_RECEIPT_PATH = join(ARTIFACT_DIR, "external-capability-runtime.json");
const MEDIA_PROBE_PATH = join(ARTIFACT_DIR, "media-probe.json");
const externalReceiptStarted = process.hrtime.bigint();
let externalReceiptSequence = 0;
let externalReceiptPhase: "smoke" | "live" = "smoke";
let externalSmokeCompleted = false;
let externalLivePhaseStartedAtMs: number | null = null;
let externalReceiptDropped = 0;
type ExternalReceiptEvent = {
  sequence: number;
  elapsedMs: number;
  phase: "smoke" | "live";
  method: "GET" | "HEAD";
  request: {
    range: { present: false } | { present: true; valid: false } |
      { present: true; valid: true; start: number | null; end: number | null };
    acceptClass: "absent" | "video-mp4" | "video-wildcard" | "wildcard" | "other";
    userAgentClass: "absent" | "vlc-android" | "google-photos" | "fixture-inject" | "other";
  };
  response: null | {
    status: number;
    contentLength: number | null;
    range: { start: number; end: number; total: number } | null;
    contentTypeClass: "absent" | "video-mp4" | "hls" | "video-mp2t" | "other";
    acceptRangesClass: "absent" | "bytes" | "other";
  };
  lifecycle: {
    finishObserved: boolean;
    closeObserved: boolean;
    requestAbortedObserved: boolean;
    prematureCloseObserved: boolean;
  };
};
const externalReceiptEvents: ExternalReceiptEvent[] = [];
const externalReceiptRequests = new WeakMap<object, ExternalReceiptEvent>();

const allowedMedia = new Set([
  "synthetic.mp4",
  "index.m3u8",
  ...Array.from({ length: 12 }, (_, index) => `segment${String(index).padStart(3, "0")}.ts`),
]);

function ffmpegFilterPath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function runFfmpeg(label: string, args: string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error != null) throw new Error(`${label} could not execute the installed ffmpeg.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${String(result.status)}.`);
}

function writeMediaProbe(): void {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=format_name,duration,size:stream=index,codec_type,codec_name,profile,level,codec_tag_string,pix_fmt,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    MOVIE_PATH,
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error != null || result.status !== 0) {
    throw new Error("ffprobe could not inspect the synthetic MP4.");
  }
  const probe = JSON.parse(result.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  if (!Array.isArray(probe.streams) || probe.streams.length !== 2 || probe.format == null) {
    throw new Error("ffprobe did not report exactly the expected bounded audio/video streams.");
  }
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (
    video?.codec_name !== "h264" || video.pix_fmt !== "yuv420p" ||
    video.width !== 1280 || video.height !== 720 || video.r_frame_rate !== "30/1" ||
    audio?.codec_name !== "aac" || audio.sample_rate !== "48000"
  ) {
    throw new Error("Synthetic MP4 codec probe did not match the Android compatibility fixture.");
  }
  writeFileSync(MEDIA_PROBE_PATH, `${JSON.stringify(probe, null, 2)}\n`, { mode: 0o600 });
}

function generateFixtureMedia(): void {
  const filterInventory = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-filters"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    filterInventory.error != null ||
    filterInventory.status !== 0 ||
    !/(?:^|\n)\s*[.A-Z]+\s+drawtext\s/m.test(filterInventory.stdout ?? "")
  ) {
    throw new Error("The installed ffmpeg lacks the required drawtext filter for visible elapsed-time evidence.");
  }
  const fonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ];
  const font = fonts.find((candidate) => existsSync(candidate));
  if (font == null) throw new Error("A known local bold font is required for the visible elapsed-time overlay.");
  mkdirSync(MEDIA_DIR, { mode: 0o700 });
  const videoFilter = [
    `drawtext=fontfile='${ffmpegFilterPath(font)}'`,
    "text='YAWF SYNTHETIC  %{pts\\:hms}'",
    "fontsize=72",
    "fontcolor=white",
    "borderw=4",
    "bordercolor=black",
    "x=(w-text_w)/2",
    "y=h-text_h-80",
  ].join(":");
  runFfmpeg("Synthetic MP4 generation", [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=36",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=36",
    "-vf", videoFilter,
    "-t", "36",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-g", "90",
    "-keyint_min", "90",
    "-sc_threshold", "0",
    "-force_key_frames", "expr:gte(t,n_forced*3)",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    MOVIE_PATH,
  ]);
  runFfmpeg("Synthetic HLS generation", [
    "-i", MOVIE_PATH,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", "3",
    "-hls_list_size", "0",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "mpegts",
    "-start_number", "0",
    "-hls_segment_filename", join(MEDIA_DIR, "segment%03d.ts"),
    join(MEDIA_DIR, "index.m3u8"),
  ]);
  writeMediaProbe();

  const expectedSegments = Array.from({ length: 12 }, (_, index) =>
    `segment${String(index).padStart(3, "0")}.ts`);
  const actualSegments = readdirSync(MEDIA_DIR)
    .filter((name) => /^segment\d{3}\.ts$/.test(name))
    .sort();
  if (JSON.stringify(actualSegments) !== JSON.stringify(expectedSegments)) {
    throw new Error(`Generated HLS must contain exactly segment000.ts through segment011.ts; got ${actualSegments.length}.`);
  }
  const manifestSegments = readFileSync(join(MEDIA_DIR, "index.m3u8"), "utf8")
    .split(/\r?\n/)
    .filter((line) => /^segment\d{3}\.ts$/.test(line));
  if (JSON.stringify(manifestSegments) !== JSON.stringify(expectedSegments)) {
    throw new Error("Generated HLS manifest did not name the exact bounded 12-segment set.");
  }
  for (const name of ["synthetic.mp4", "index.m3u8", ...expectedSegments]) {
    const mediaPath = join(MEDIA_DIR, name);
    if (!lstatSync(mediaPath).isFile() || statSync(mediaPath).size <= 0) {
      throw new Error(`Generated media is missing or empty: ${name}`);
    }
  }
}

function boundedPort(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Fixture ports must be integers from 1024 through 65535.");
  }
  return value;
}

function monotonicElapsedMs(): number {
  return Number((process.hrtime.bigint() - externalReceiptStarted) / 1_000_000n);
}

function boundedHeaderInteger(value: unknown): number | null {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^(0|[1-9]\d{0,15})$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function boundedContentRange(value: unknown): { start: number; end: number; total: number } | null {
  if (typeof value !== "string") return null;
  const match = /^bytes (0|[1-9]\d{0,15})-(0|[1-9]\d{0,15})\/(0|[1-9]\d{0,15})$/.exec(value);
  if (match == null) return null;
  const start = boundedHeaderInteger(match[1]);
  const end = boundedHeaderInteger(match[2]);
  const total = boundedHeaderInteger(match[3]);
  if (start == null || end == null || total == null || end < start || end >= total) return null;
  return { start, end, total };
}

function writeExternalReceipt(): void {
  const receipt = {
    schemaVersion: 1,
    description: "Token-free external capability response observations from this owned fixture only.",
    maxEntries: EXTERNAL_RECEIPT_LIMIT,
    activePhase: externalReceiptPhase,
    smokeCompleted: externalSmokeCompleted,
    livePhaseStartedAtMs: externalLivePhaseStartedAtMs,
    droppedEntries: externalReceiptDropped,
    events: externalReceiptEvents,
  };
  const temporary = `${EXTERNAL_RECEIPT_PATH}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, EXTERNAL_RECEIPT_PATH);
}

function requestRangeClass(value: unknown): ExternalReceiptEvent["request"]["range"] {
  if (value == null) return { present: false };
  if (typeof value !== "string") return { present: true, valid: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match == null || (match[1] === "" && match[2] === "")) {
    return { present: true, valid: false };
  }
  const start = match[1] === "" ? null : boundedHeaderInteger(match[1]);
  const end = match[2] === "" ? null : boundedHeaderInteger(match[2]);
  if (
    (match[1] !== "" && start == null) ||
    (match[2] !== "" && end == null) ||
    (start != null && end != null && end < start)
  ) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, start, end };
}

function acceptClass(value: unknown): ExternalReceiptEvent["request"]["acceptClass"] {
  if (typeof value !== "string" || value.trim() === "") return "absent";
  const tokens = value.toLowerCase().split(",").map((part) => part.trim().split(";", 1)[0]);
  if (tokens.includes("video/mp4")) return "video-mp4";
  if (tokens.includes("video/*")) return "video-wildcard";
  if (tokens.includes("*/*")) return "wildcard";
  return "other";
}

function userAgentClass(value: unknown): ExternalReceiptEvent["request"]["userAgentClass"] {
  if (typeof value !== "string" || value.trim() === "") return "absent";
  if (/\b(?:vlc|libvlc)\b/i.test(value)) return "vlc-android";
  if (/\b(?:google photos|photos)\b/i.test(value)) return "google-photos";
  if (/\blightmyrequest\b/i.test(value)) return "fixture-inject";
  return "other";
}

function contentTypeClass(value: unknown): NonNullable<ExternalReceiptEvent["response"]>["contentTypeClass"] {
  if (typeof value !== "string" || value.trim() === "") return "absent";
  const type = value.toLowerCase().split(";", 1)[0].trim();
  if (type === "video/mp4") return "video-mp4";
  if (type === "application/vnd.apple.mpegurl" || type === "application/x-mpegurl") return "hls";
  if (type === "video/mp2t") return "video-mp2t";
  return "other";
}

function acceptRangesClass(value: unknown): NonNullable<ExternalReceiptEvent["response"]>["acceptRangesClass"] {
  if (typeof value !== "string" || value.trim() === "") return "absent";
  return value.trim().toLowerCase() === "bytes" ? "bytes" : "other";
}

function recordExternalCapabilityRequest(request: any, reply: any): void {
  const rawUrl = typeof request?.raw?.url === "string" ? request.raw.url : "";
  const methodValue = typeof request?.method === "string" ? request.method : "";
  if (!EXTERNAL_CAPABILITY_PATH.test(rawUrl) || (methodValue !== "GET" && methodValue !== "HEAD")) return;
  const method: "GET" | "HEAD" = methodValue;
  if (externalReceiptEvents.length >= EXTERNAL_RECEIPT_LIMIT) {
    externalReceiptDropped += 1;
    writeExternalReceipt();
    return;
  }
  const event: ExternalReceiptEvent = {
    sequence: ++externalReceiptSequence,
    elapsedMs: monotonicElapsedMs(),
    phase: externalReceiptPhase,
    method,
    request: {
      range: requestRangeClass(request.headers?.range),
      acceptClass: acceptClass(request.headers?.accept),
      userAgentClass: userAgentClass(request.headers?.["user-agent"]),
    },
    response: null,
    lifecycle: {
      finishObserved: false,
      closeObserved: false,
      requestAbortedObserved: false,
      prematureCloseObserved: false,
    },
  };
  externalReceiptEvents.push(event);
  externalReceiptRequests.set(request, event);
  request.raw.once("aborted", () => {
    event.lifecycle.requestAbortedObserved = true;
    writeExternalReceipt();
  });
  reply.raw.once("finish", () => {
    event.lifecycle.finishObserved = true;
    writeExternalReceipt();
  });
  reply.raw.once("close", () => {
    event.lifecycle.closeObserved = true;
    event.lifecycle.prematureCloseObserved = !event.lifecycle.finishObserved;
    writeExternalReceipt();
  });
  writeExternalReceipt();
}

function recordExternalCapabilityResponse(request: any, reply: any): void {
  const event = externalReceiptRequests.get(request);
  if (event == null) return;
  event.response = {
    status: reply.statusCode,
    contentLength: boundedHeaderInteger(reply.getHeader("content-length")),
    range: boundedContentRange(reply.getHeader("content-range")),
    contentTypeClass: contentTypeClass(reply.getHeader("content-type")),
    acceptRangesClass: acceptRangesClass(reply.getHeader("accept-ranges")),
  };
  event.lifecycle.finishObserved = event.lifecycle.finishObserved || reply.raw.writableFinished === true;
  writeExternalReceipt();
}

function assertFixtureInputs(): void {
  for (const required of [
    `${WEB_DIST}/index.html`,
    MOVIE_PATH,
    join(MEDIA_DIR, "index.m3u8"),
    ...[...allowedMedia]
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(MEDIA_DIR, name)),
  ]) {
    if (!existsSync(required)) throw new Error(`Missing fixture input: ${required}`);
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".mp4": return "video/mp4";
    case ".m3u8": return "application/vnd.apple.mpegurl";
    case ".ts": return "video/mp2t";
    default: return "application/octet-stream";
  }
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (value == null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match == null || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function serveMedia(request: IncomingMessage, response: ServerResponse): void {
  const requestURL = new URL(request.url ?? "/", MEDIA_ORIGIN);
  const name = basename(requestURL.pathname);
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    requestURL.pathname !== `/media/${name}` ||
    !allowedMedia.has(name)
  ) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }

  const path = join(MEDIA_DIR, name);
  const size = statSync(path).size;
  const range = parseRange(typeof request.headers.range === "string" ? request.headers.range : undefined, size);
  if (range === null) {
    response.writeHead(416, {
      "accept-ranges": "bytes",
      "content-range": `bytes */${size}`,
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(end - start + 1),
    "content-type": contentType(path),
  };
  if (range != null) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(range == null ? 200 : 206, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path, { start, end }).pipe(response);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const syntheticMovie = {
  id: 600,
  title: TITLE,
  media_type: "movie",
  overview: "Account-free generated playback fixture.",
  poster_path: null,
  backdrop_path: null,
  release_date: "2026-01-01",
  vote_average: 8.0,
  runtime: 40,
  status: "Released",
  genres: [{ id: 878, name: "Science Fiction" }],
  external_ids: { imdb_id: "tt0000600", tvdb_id: null },
};

const emptyPage = { page: 1, results: [], total_pages: 1, total_results: 0 };

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function sanitizedFetchLog(method: string, url: URL, outcome: "fixture" | "media" | "blocked"): void {
  console.log(`[fixture-fetch] ${outcome} ${method} ${url.hostname}${url.pathname}`);
}

function installFailClosedFetch(originalFetch: typeof fetch): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const method = methodOf(input, init);

    if (
      url.origin === MEDIA_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith("/media/") &&
      allowedMedia.has(basename(url.pathname))
    ) {
      sanitizedFetchLog(method, url, "media");
      return originalFetch(input as RequestInfo | URL, init);
    }

    if (method === "GET" && url.hostname === "api.themoviedb.org") {
      const path = url.pathname;
      sanitizedFetchLog(method, url, "fixture");
      if (path === "/3/movie/600") return jsonResponse(syntheticMovie);
      if (path === "/3/movie/600/credits") return jsonResponse({ cast: [] });
      if (path === "/3/movie/600/recommendations") return jsonResponse(emptyPage);
      if (path === "/3/movie/600/videos") return jsonResponse({ results: [] });
      if (path === "/3/movie/600/external_ids") {
        return jsonResponse({ imdb_id: "tt0000600", tvdb_id: null });
      }
      if (path === "/3/movie/600/release_dates") {
        return jsonResponse({ results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG" }] }] });
      }
      if (path === "/3/find/tt0000600") {
        return jsonResponse({ movie_results: [syntheticMovie], tv_results: [] });
      }
      if (/^\/3\/genre\/(movie|tv)\/list$/.test(path)) return jsonResponse({ genres: [] });
      if (/^\/3\/search\/(movie|tv|multi)$/.test(path)) {
        const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
        return jsonResponse(query === TITLE.toLowerCase()
          ? { page: 1, results: [syntheticMovie], total_pages: 1, total_results: 1 }
          : emptyPage);
      }
      if (
        /^\/3\/trending\/(movie|tv)\/week$/.test(path) ||
        /^\/3\/movie\/(popular|top_rated|now_playing|upcoming)$/.test(path) ||
        /^\/3\/tv\/(popular|top_rated|airing_today|on_the_air)$/.test(path) ||
        /^\/3\/discover\/(movie|tv)$/.test(path)
      ) {
        return jsonResponse(emptyPage);
      }
      throw new Error(`Blocked unexpected TMDB fixture route: ${method} ${url.hostname}${path}`);
    }

    if (method === "GET" && url.hostname === "fixture.invalid") {
      sanitizedFetchLog(method, url, "fixture");
      if (url.pathname === "/manifest.json") {
        return jsonResponse({ id: "fixture.synthetic", name: "Synthetic Fixture", resources: ["stream"], types: ["movie"] });
      }
      if (url.pathname === "/stream/movie/tt0000600.json") {
        return jsonResponse({ streams: [{ infoHash: HASH, title: "Synthetic Fixture Movie 2026 1080p WEB-DL x264" }] });
      }
      throw new Error(`Blocked unexpected Stremio fixture route: ${method} ${url.hostname}${url.pathname}`);
    }

    if (url.hostname === "api.real-debrid.com") {
      sanitizedFetchLog(method, url, "fixture");
      if (method === "GET" && url.pathname === "/rest/1.0/torrents") return jsonResponse([]);
      if (method === "POST" && url.pathname === "/rest/1.0/torrents/addMagnet") {
        return jsonResponse({ id: "rd-torrent" }, 201);
      }
      if (method === "POST" && url.pathname === "/rest/1.0/torrents/selectFiles/rd-torrent") {
        return new Response(null, { status: 204 });
      }
      if (method === "GET" && url.pathname === "/rest/1.0/torrents/info/rd-torrent") {
        return jsonResponse({
          id: "rd-torrent",
          status: "downloaded",
          links: ["https://real-debrid.example/restricted-link"],
          files: [{
            id: 1,
            path: "/Synthetic.Fixture.Movie.2026.1080p.WEB-DL.x264.mp4",
            bytes: statSync(MOVIE_PATH).size,
            selected: 1,
          }],
        });
      }
      if (method === "POST" && url.pathname === "/rest/1.0/unrestrict/link") {
        return jsonResponse({ download: MOVIE_URL, id: "unrestricted-fixture" });
      }
      throw new Error(`Blocked unexpected Real-Debrid fixture route: ${method} ${url.hostname}${url.pathname}`);
    }

    sanitizedFetchLog(method, url, "blocked");
    throw new Error(`Blocked unexpected outbound request: ${method} ${url.hostname}${url.pathname}`);
  }) as typeof fetch;
}

type FixtureClient = { cookies: Map<string, string> };

function rememberCookies(client: FixtureClient, setCookie: string | string[] | undefined): void {
  for (const value of setCookie == null ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) client.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function inject(app: any, client: FixtureClient, options: {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
}): Promise<any> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (client.cookies.size > 0) {
    headers.cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  if (options.csrf) {
    const csrf = client.cookies.get("ds_csrf");
    if (csrf == null) throw new Error(`Missing CSRF cookie for ${options.method} ${options.url}`);
    headers["x-csrf-token"] = csrf;
  }
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers,
    payload: options.payload,
    remoteAddress: HOST,
  });
  rememberCookies(client, response.headers["set-cookie"]);
  return response;
}

function expectStatus(response: any, status: number, label: string): void {
  if (response.statusCode !== status) {
    const body = String(response.body ?? "").slice(0, 500);
    throw new Error(`${label} returned ${response.statusCode}, expected ${status}: ${body}`);
  }
}

function parseJSON<T>(response: any): T {
  return JSON.parse(response.body) as T;
}

async function seed(app: any): Promise<void> {
  const owner: FixtureClient = { cookies: new Map() };
  const setup = await inject(app, owner, {
    method: "POST",
    url: "/api/auth/setup-owner",
    payload: { username: USERNAME, password: PASSWORD, displayName: "Fixture Owner" },
  });
  expectStatus(setup, 200, "setup owner");

  for (const credential of [
    { provider: "tmdb", label: "Synthetic TMDB", value: "fixture-tmdb-key" },
    { provider: "real_debrid", label: "Synthetic Real-Debrid", value: "fixture-rd-token" },
  ]) {
    const response = await inject(app, owner, {
      method: "PUT",
      url: "/api/admin/credentials",
      payload: credential,
      csrf: true,
    });
    expectStatus(response, 200, `seed ${credential.provider}`);
  }

  const indexers = await inject(app, owner, {
    method: "PUT",
    url: "/api/settings/profile",
    csrf: true,
    payload: {
      key: "server_indexer_configs",
      value: JSON.stringify([{
        id: "synthetic-stremio",
        type: "stremio_addon",
        baseURL: "https://fixture.invalid",
        isActive: true,
        displayName: "Synthetic Fixture",
        priority: 0,
      }]),
    },
  });
  expectStatus(indexers, 200, "seed custom Stremio indexer");

  const builtIns = await inject(app, owner, {
    method: "PUT",
    url: "/api/settings/profile",
    csrf: true,
    payload: { key: "built_in_indexers_enabled", value: "false" },
  });
  expectStatus(builtIns, 200, "disable built-in indexers");

  const watchlist = await inject(app, owner, {
    method: "PUT",
    url: "/api/library/watchlist/tmdb-600",
    csrf: true,
    payload: {
      preview: {
        id: "tmdb-600",
        type: "movie",
        title: TITLE,
        year: 2026,
        posterPath: null,
        backdropPath: null,
        imdbRating: 8.0,
        tmdbId: 600,
      },
    },
  });
  expectStatus(watchlist, 200, "seed watchlist");
}

async function smoke(app: any): Promise<Record<string, unknown>> {
  const hlsManifest = await fetch(`${MEDIA_ORIGIN}/media/index.m3u8`);
  if (hlsManifest.status !== 200 || !(await hlsManifest.text()).includes("segment000.ts")) {
    throw new Error("Generated HLS manifest was not served from the restricted loopback media origin.");
  }
  const hlsSegment = await fetch(`${MEDIA_ORIGIN}/media/segment000.ts`, {
    headers: { range: "bytes=0-1023" },
  });
  if (hlsSegment.status !== 206 || (await hlsSegment.arrayBuffer()).byteLength !== 1024) {
    throw new Error("Generated HLS segment range was not served from the restricted loopback media origin.");
  }
  const manifest = await fetch("https://fixture.invalid/manifest.json");
  const manifestBody = await manifest.json() as { id?: string };
  if (manifest.status !== 200 || manifestBody.id !== "fixture.synthetic") {
    throw new Error("Synthetic Stremio manifest route did not return the fixture manifest.");
  }
  let unexpectedBlocked = false;
  try {
    await fetch("https://unexpected.invalid/should-not-leave-host");
  } catch {
    unexpectedBlocked = true;
  }
  if (!unexpectedBlocked) throw new Error("Unexpected outbound request was not blocked.");

  const client: FixtureClient = { cookies: new Map() };
  const login = await inject(app, client, {
    method: "POST",
    url: "/api/auth/login",
    payload: { username: USERNAME, password: PASSWORD },
  });
  expectStatus(login, 200, "login");

  const bootstrap = await inject(app, client, { method: "GET", url: "/api/bootstrap" });
  expectStatus(bootstrap, 200, "bootstrap");
  const bootstrapBody = parseJSON<{ transcodeAvailable: boolean; directTorrentAvailable: boolean; session: unknown }>(bootstrap);
  if (bootstrapBody.transcodeAvailable || bootstrapBody.directTorrentAvailable || bootstrapBody.session == null) {
    throw new Error("Bootstrap did not preserve disabled transcoding and Direct P2P with an authenticated session.");
  }

  const watchlist = await inject(app, client, { method: "GET", url: "/api/library/watchlist" });
  expectStatus(watchlist, 200, "watchlist");
  const watchlistBody = parseJSON<{ items: Array<{ mediaId: string }> }>(watchlist);
  if (watchlistBody.items[0]?.mediaId !== "tmdb-600") throw new Error("Synthetic watchlist item is missing.");

  const discover = await inject(app, client, { method: "GET", url: "/api/discover/home" });
  expectStatus(discover, 200, "bounded empty discover catalogs");

  const detail = await inject(app, client, { method: "GET", url: "/api/media/detail?id=tmdb-600&type=movie" });
  expectStatus(detail, 200, "metadata detail");
  const detailBody = parseJSON<{ item: { id: string; tmdbId: number; title: string }; imdbId: string | null }>(detail);
  if (detailBody.item.id !== "tt0000600" || detailBody.item.tmdbId !== 600 || detailBody.imdbId !== "tt0000600") {
    throw new Error("Synthetic TMDB detail did not map to tt0000600.");
  }

  const streams = await inject(app, client, {
    method: "GET",
    url: `/api/streams/tt0000600?type=movie&title=${encodeURIComponent(TITLE)}&year=2026`,
  });
  expectStatus(streams, 200, "stream search");
  const streamBody = parseJSON<{ rows: Array<{ result: { infoHash: string } }>; hasDebrid: boolean; hasIndexers: boolean }>(streams);
  if (!streamBody.hasDebrid || !streamBody.hasIndexers || streamBody.rows[0]?.result.infoHash !== HASH) {
    throw new Error("Synthetic Stremio source was not returned with a debrid service.");
  }

  const resolve = await inject(app, client, {
    method: "POST",
    url: "/api/streams/resolve",
    csrf: true,
    payload: {
      infoHash: HASH,
      preferredService: "real_debrid",
      mediaId: "tmdb-600",
      mediaType: "movie",
    },
  });
  expectStatus(resolve, 200, "stream resolve");
  const resolved = parseJSON<{
    stream: { streamURL: string; debridService: string; playbackAuthorization: string };
    session: { id: string; playbackUrl: string; playbackAuthorization: string };
  }>(resolve);
  if (resolved.stream.debridService !== "RD" || resolved.stream.streamURL !== resolved.session.playbackUrl) {
    throw new Error("Resolved stream did not use the Server Mode proxy session.");
  }
  if (resolved.stream.playbackAuthorization !== resolved.session.playbackAuthorization) {
    throw new Error("Resolved stream did not retain its session-scoped playback authorization.");
  }
  const capability = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/.exec(resolved.session.playbackAuthorization)?.[1];
  if (capability == null || !/^[A-Za-z0-9_-]{1,120}$/.test(resolved.session.id)) {
    throw new Error("Resolved stream did not provide a bounded external-player capability.");
  }
  const externalPath = `/api/external-stream/${encodeURIComponent(resolved.session.id)}/${encodeURIComponent(capability)}`;

  const full = await inject(app, client, { method: "GET", url: resolved.stream.streamURL });
  expectStatus(full, 200, "full proxy response");
  const expected = readFileSync(MOVIE_PATH);
  const actual = full.rawPayload as Buffer;
  if (actual.length !== expected.length || createHash("sha256").update(actual).digest("hex") !== createHash("sha256").update(expected).digest("hex")) {
    throw new Error("Full proxy response differs from synthetic.mp4.");
  }

  const range = await inject(app, client, {
    method: "GET",
    url: resolved.stream.streamURL,
    headers: { range: "bytes=0-1023" },
  });
  expectStatus(range, 206, "range proxy response");
  if (range.rawPayload.length !== 1024 || range.headers["content-range"] !== `bytes 0-1023/${expected.length}`) {
    throw new Error("Range proxy response did not preserve byte boundaries.");
  }

  // Exercise the exact cookie-free route handed to external players without
  // persisting or logging its session-scoped capability value.
  const externalClient: FixtureClient = { cookies: new Map() };
  const externalFull = await inject(app, externalClient, { method: "GET", url: externalPath });
  expectStatus(externalFull, 200, "external capability full response");
  if (
    externalFull.headers["content-type"] !== "video/mp4" ||
    externalFull.headers["accept-ranges"] !== "bytes" ||
    externalFull.headers["content-length"] !== String(expected.length) ||
    externalFull.headers["content-disposition"] != null
  ) {
    throw new Error("External capability full response did not preserve the exact playable MP4 headers.");
  }
  if (
    externalFull.rawPayload.length !== expected.length ||
    createHash("sha256").update(externalFull.rawPayload as Buffer).digest("hex") !==
      createHash("sha256").update(expected).digest("hex")
  ) {
    throw new Error("External capability full response differs from synthetic.mp4.");
  }
  const externalRange = await inject(app, externalClient, {
    method: "GET",
    url: externalPath,
    headers: { range: "bytes=1024-2047" },
  });
  expectStatus(externalRange, 206, "external capability range response");
  if (
    externalRange.rawPayload.length !== 1024 ||
    externalRange.headers["content-range"] !== `bytes 1024-2047/${expected.length}` ||
    !Buffer.from(externalRange.rawPayload as Buffer).equals(expected.subarray(1024, 2048))
  ) {
    throw new Error("External capability range response did not preserve byte identity or boundaries.");
  }

  const servedWebDist: AdmittedWebDistEntry[] = [];
  for (const entry of admittedWebDist()) {
    const url = entry.path === "index.html"
      ? "/"
      : `/${entry.path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
    const response = await inject(app, client, { method: "GET", url });
    expectStatus(response, 200, `compiled web asset ${entry.path}`);
    if (entry.path === "index.html" && !String(response.headers["content-type"] ?? "").includes("text/html")) {
      throw new Error("Compiled web root did not return HTML.");
    }
    const served = Buffer.from(response.rawPayload as Buffer);
    const servedSha256 = createHash("sha256").update(served).digest("hex");
    if (served.length !== entry.bytes || servedSha256 !== entry.sha256) {
      throw new Error("Compiled web asset response differs from its exact admitted source bytes.");
    }
    servedWebDist.push({ path: entry.path, bytes: served.length, sha256: servedSha256 });
  }

  return {
    ok: true,
    appOrigin: APP_ORIGIN,
    mediaOrigin: MEDIA_ORIGIN,
    checks: [
      "loopback-hls-manifest-segment",
      "stremio-manifest",
      "unexpected-outbound-fail-closed",
      "login",
      "bootstrap-disabled-features",
      "watchlist",
      "bounded-empty-discover",
      "metadata-detail",
      "stremio-stream-search",
      "real-debrid-resolve",
      "proxy-full-body-sha256",
      "proxy-range",
      "external-capability-full-body-sha256",
      "external-capability-playable-response-headers",
      "external-capability-range-byte-identity",
      "compiled-web-dist-byte-identity",
    ],
    mediaBytes: expected.length,
    mediaSha256: createHash("sha256").update(expected).digest("hex"),
    webIndexSha256: servedWebDist.find((entry) => entry.path === "index.html")?.sha256,
    servedWebDist,
    unexpectedOutboundAllowed: false,
  };
}

async function main(): Promise<void> {
  generateFixtureMedia();
  assertFixtureInputs();
  if (APP_PORT === MEDIA_PORT) throw new Error("Fixture app and media ports must differ.");
  const runtimeDir = mkdtempSync(join(tmpdir(), "ds-server-ui-fixture-"));
  const originalFetch = globalThis.fetch;
  const mediaServer = createServer(serveMedia);
  let app: any = null;
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (app != null) await app.close().catch(() => {});
    await new Promise<void>((resolve) => mediaServer.close(() => resolve()));
    globalThis.fetch = originalFetch;
    rmSync(runtimeDir, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      mediaServer.once("error", reject);
      mediaServer.listen(MEDIA_PORT, HOST, () => {
        mediaServer.off("error", reject);
        resolve();
      });
    });
    installFailClosedFetch(originalFetch);

    const { buildApp } = await import(`${REPO}/server/src/app.ts`);
    app = await buildApp({
      config: {
        host: HOST,
        port: APP_PORT,
        dataDir: runtimeDir,
        databasePath: join(runtimeDir, "fixture.sqlite"),
        webDistPath: WEB_DIST,
        secretKey: randomBytes(32),
        setupToken: null,
        publicMode: false,
        cookieSecure: false,
        cookieSameSite: "lax",
        allowInsecurePublic: false,
        logger: false,
        updateCheck: false,
        allowRawStreamUrls: true,
        enableDirectTorrent: false,
        enableTranscode: false,
      },
    });
    app.addHook("onRequest", async (request: any, reply: any) => {
      recordExternalCapabilityRequest(request, reply);
    });
    app.addHook("onResponse", async (request: any, reply: any) => {
      recordExternalCapabilityResponse(request, reply);
    });

    await seed(app);
    const result = await smoke(app);
    externalSmokeCompleted = true;
    externalReceiptPhase = "live";
    externalLivePhaseStartedAtMs = monotonicElapsedMs();
    writeExternalReceipt();
    writeFileSync(join(ARTIFACT_DIR, "smoke-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`[fixture] smoke passed; sanitized result written to ${join(ARTIFACT_DIR, "smoke-result.json")}`);

    if (fixtureCLI.smokeOnly) {
      await close();
      return;
    }

    await app.listen({ host: HOST, port: APP_PORT });
    console.log("[fixture] READY server-mode-ui loopback");
    console.log(`[fixture] Server Mode UI: ${APP_ORIGIN}`);
    console.log(`[fixture] login username: ${USERNAME}`);
    console.log("[fixture] login password is the documented synthetic fixture password in README.md");
    console.log("[fixture] loopback only; press Ctrl-C to stop and delete the isolated database");

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void close().then(() => process.exit(0));
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
}

await main();
