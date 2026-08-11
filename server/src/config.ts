import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeSecretKey } from "./crypto.js";
import type { CookieSameSite, ServerConfig } from "./types.js";

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function sameSiteEnv(name: string, fallback: CookieSameSite): CookieSameSite {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "lax" || value === "strict" || value === "none") return value;
  return fallback;
}

function stringEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value != null && value.length > 0 ? value : null;
}

function buildProfileEnv(): "family" | "friends" | "public" {
  const value = process.env.DS_BUILD_PROFILE?.trim().toLowerCase();
  return value === "family" || value === "friends" ? value : "public";
}

function transcodeVideoEncoderEnv(): ServerConfig["transcodeVideoEncoder"] {
  const value = process.env.DS_SERVER_TRANSCODE_VIDEO_ENCODER?.trim().toLowerCase();
  if (
    value === "h264_videotoolbox" ||
    value === "h264_nvenc" ||
    value === "h264_qsv"
  ) {
    return value;
  }
  return "libx264";
}

function loadOrCreateSecretKey(dataDir: string): Buffer {
  const envSecret = process.env.DS_SERVER_SECRET_KEY;
  if (envSecret && envSecret.trim().length > 0) {
    return normalizeSecretKey(envSecret);
  }

  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "server.key");
  if (existsSync(path)) {
    return normalizeSecretKey(readFileSync(path, "utf8"));
  }

  const generated = randomBytes(32).toString("base64");
  writeFileSync(path, generated, { mode: 0o600 });
  return normalizeSecretKey(generated);
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.DS_SERVER_DATA_DIR ??
    join(process.cwd(), "data");
  const databasePath =
    overrides.databasePath ??
    process.env.DS_SERVER_DB_PATH ??
    join(dataDir, "debridstreamer.sqlite");

  return {
    host: overrides.host ?? process.env.HOST ?? "0.0.0.0",
    port: overrides.port ?? numberEnv("PORT", 43110),
    dataDir,
    databasePath,
    webDistPath:
      overrides.webDistPath ??
      (process.env.DS_WEB_DIST != null && process.env.DS_WEB_DIST.trim().length > 0
        ? resolve(process.env.DS_WEB_DIST)
        : null),
    secretKey: overrides.secretKey ?? loadOrCreateSecretKey(dataDir),
    setupToken:
      overrides.setupToken !== undefined
        ? overrides.setupToken
        : stringEnv("DS_SERVER_SETUP_TOKEN"),
    publicMode:
      overrides.publicMode ?? boolEnv("DS_SERVER_PUBLIC_MODE", false),
    cookieSecure:
      overrides.cookieSecure ?? boolEnv("DS_SERVER_COOKIE_SECURE", process.env.NODE_ENV === "production"),
    cookieSameSite:
      overrides.cookieSameSite ?? sameSiteEnv("DS_SERVER_COOKIE_SAMESITE", "lax"),
    sessionTtlSeconds:
      overrides.sessionTtlSeconds ?? numberEnv("DS_SERVER_SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    bindSessionUserAgent:
      overrides.bindSessionUserAgent ?? boolEnv("DS_SERVER_BIND_SESSION_USER_AGENT", false),
    allowInsecurePublic:
      overrides.allowInsecurePublic ?? boolEnv("DS_SERVER_ALLOW_INSECURE_PUBLIC", false),
    updateCheck:
      overrides.updateCheck ?? boolEnv("DS_SERVER_UPDATE_CHECK", process.env.NODE_ENV === "production"),
    allowRawStreamUrls:
      overrides.allowRawStreamUrls ??
      boolEnv("DS_SERVER_ALLOW_RAW_STREAM_URLS", process.env.NODE_ENV !== "production"),
    enableDirectTorrent:
      overrides.enableDirectTorrent ?? boolEnv("DS_SERVER_ENABLE_DIRECT_TORRENT", false),
    directTorrentMaxActive:
      boundedInteger(
        overrides.directTorrentMaxActive ?? numberEnv("DS_SERVER_DIRECT_TORRENT_MAX_ACTIVE", 2),
        2, 1, 4,
      ),
    directTorrentMaxSessions:
      boundedInteger(
        overrides.directTorrentMaxSessions ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS", 8),
        8, 1, 64,
      ),
    directTorrentMaxSessionsPerProfile:
      boundedInteger(
        overrides.directTorrentMaxSessionsPerProfile ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_MAX_SESSIONS_PER_PROFILE", 2),
        2, 1, 16,
      ),
    directTorrentMetadataTimeoutMs:
      boundedNumber(
        overrides.directTorrentMetadataTimeoutMs ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_METADATA_TIMEOUT_MS", 30_000),
        30_000, 5_000, 120_000,
      ),
    directTorrentMaxPeers:
      boundedInteger(
        overrides.directTorrentMaxPeers ?? numberEnv("DS_SERVER_DIRECT_TORRENT_MAX_PEERS", 24),
        24, 1, 50,
      ),
    directTorrentMaxTorrentBytes:
      boundedNumber(
        overrides.directTorrentMaxTorrentBytes ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_MAX_BYTES", 30 * 1024 * 1024 * 1024),
        30 * 1024 * 1024 * 1024, 1024 * 1024, 100 * 1024 * 1024 * 1024,
      ),
    directTorrentDownloadLimitBps:
      boundedNumber(
        overrides.directTorrentDownloadLimitBps ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_DOWNLOAD_BPS", 25 * 1024 * 1024),
        25 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024,
      ),
    directTorrentUploadLimitBps:
      boundedNumber(
        overrides.directTorrentUploadLimitBps ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_UPLOAD_BPS", 2 * 1024 * 1024),
        2 * 1024 * 1024, 16 * 1024, 10 * 1024 * 1024,
      ),
    directTorrentIdleTimeoutMs:
      boundedNumber(
        overrides.directTorrentIdleTimeoutMs ??
          numberEnv("DS_SERVER_DIRECT_TORRENT_IDLE_TIMEOUT_MS", 15 * 60_000),
        15 * 60_000, 60_000, 60 * 60_000,
      ),
    // Hard-default OFF in every environment (incl. dev) - transcoding is a
    // deliberate operator opt-in, not a dev convenience.
    enableTranscode:
      overrides.enableTranscode ?? boolEnv("DS_SERVER_ENABLE_TRANSCODE", false),
    maxTranscodes:
      overrides.maxTranscodes ?? numberEnv("DS_SERVER_MAX_TRANSCODES", 2),
    transcodeVideoEncoder:
      overrides.transcodeVideoEncoder ?? transcodeVideoEncoderEnv(),
    transcodeStartTimeoutMs:
      overrides.transcodeStartTimeoutMs ??
      numberEnv("DS_SERVER_TRANSCODE_START_TIMEOUT_MS", 30_000),
    trustProxy: overrides.trustProxy ?? boolEnv("DS_SERVER_TRUST_PROXY", false),
    corsOrigin: overrides.corsOrigin ?? process.env.DS_SERVER_CORS_ORIGIN ?? null,
    logger: overrides.logger ?? boolEnv("DS_SERVER_LOGGER", process.env.NODE_ENV === "production"),
    // Server-held OMDb key (the "hidden key" distribution path). Never exposed
    // to clients - used only by the /api/omdb proxy. An encrypted server-scoped
    // OMDb credential in the DB works too; this env is the convenient default
    // for a baked limited-distribution server image.
    omdbApiKey:
      overrides.omdbApiKey !== undefined
        ? overrides.omdbApiKey
        : stringEnv("DS_SERVER_OMDB_API_KEY"),
    buildProfile: overrides.buildProfile ?? buildProfileEnv(),
    omdbBrokerUrl:
      overrides.omdbBrokerUrl !== undefined ? overrides.omdbBrokerUrl : stringEnv("DS_OMDB_BROKER_URL"),
    brokerAuthToken:
      overrides.brokerAuthToken !== undefined ? overrides.brokerAuthToken : stringEnv("DS_BROKER_AUTH_TOKEN"),
    brokerTokens:
      overrides.brokerTokens ??
      (stringEnv("DS_BROKER_TOKENS") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
  };
}
