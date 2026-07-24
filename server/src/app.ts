import { Readable, Transform } from "node:stream";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, type ZodType } from "zod";
import { AppDatabase } from "./db.js";
import { loadConfig } from "./config.js";
// The media adapter is plain JS so the server compiler does not typecheck the
// browser service graph; esbuild bundles it and tests cover the runtime route.
// @ts-ignore JS module intentionally has no declaration file.
import {
  buildDebridService,
  resolveServerStream,
  searchServerStreams,
  titleHasInfoHash,
} from "./media-runtime.js";
import {
  discoverServerMedia,
  getServerCategory,
  getServerDetail,
  getServerDiscoverHome,
  getServerEpisodes,
  getServerGenres,
  getServerMovieReleaseCalendar,
  getServerSeasons,
  getServerUpcomingEpisodes,
  MAX_CALENDAR_SERIES,
  searchServerMedia,
  titleCertification,
} from "./metadata-runtime.js";
import { curateServerAI, recommendServerAI } from "./ai-runtime.js";
import {
  fetchServerSubtitle,
  searchServerSubtitles,
  translateServerSubtitle,
} from "./subtitles-runtime.js";
import {
  addSecondsISO,
  decryptSecret,
  encryptSecret,
  hashOptional,
  hashPassword,
  nowISO,
  randomId,
  randomToken,
  sha256,
  verifyPassword,
} from "./crypto.js";
import { assertSafeUpstream, fetchUpstreamSafely } from "./ssrf.js";
import { fetchOmdbRatings, fetchOmdbViaBroker, type OMDBRatings } from "./omdb.js";
import { embeddedSecret } from "./embeddedSecrets.js";
import { bandwidthCapStatus, type BandwidthCapStatus } from "./bandwidth.js";
import { readFile } from "node:fs/promises";
import { realTranscoder } from "./transcode.js";
import {
  MANIFEST_NAME,
  TranscodeRegistry,
  type TranscodeClientProfile,
  type TranscodeHdrPolicy,
} from "./transcodeSession.js";
import { SERVER_VERSION } from "./version.js";
import {
  RemoteControlRegistry,
  type RemoteCommandType,
} from "./remoteControl.js";
import {
  CREDENTIAL_PROVIDERS,
  type AuthContext,
  type BuildAppOptions,
  type CredentialProvider,
  type ServerConfig,
  type UserRole,
} from "./types.js";

function rewriteTranscodeManifest(manifest: string, sessionId: string): string {
  const base = `/api/stream/${encodeURIComponent(sessionId)}/`;
  return manifest.replace(
    /^(?!#)((?:1080p|720p|480p)\.m3u8|(?:1080p|720p|480p)_seg_\d{5}\.ts|seg_\d{5}\.ts|subtitles\.vtt)$/gm,
    (_line, asset: string) => `${base}${asset}`,
  );
}

const SESSION_COOKIE = "ds_session";
const CSRF_COOKIE = "ds_csrf";
const CONTINUE_WATCHING_VIEW = "continue-watching";
const CONTINUE_WATCHING_MAX_ROWS = 20;
const CONTINUE_WATCHING_MAX_RESPONSE_BYTES = 65_536;

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/);

const passwordSchema = z.string().min(8).max(512);
const roleSchema = z.enum(["owner", "admin", "member", "restricted"]);
const providerSchema = z.enum(CREDENTIAL_PROVIDERS);
const mediaTypeSchema = z.enum(["movie", "series"]);
const debridServiceSchema = z.enum([
  "real_debrid",
  "all_debrid",
  "premiumize",
  "torbox",
]);
const debridTestSchema = z.object({
  service: debridServiceSchema,
  apiToken: z.string().trim().min(1).max(500),
});

const setupOwnerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100),
  setupToken: z.string().trim().min(1).max(512).optional(),
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(512),
  totpCode: z.string().trim().regex(/^\d{6}$/).optional(),
});

const totpCodeSchema = z.string().trim().regex(/^\d{6}$/);
const disableTotpSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  code: totpCodeSchema,
});

const revokeAllSessionsSchema = z.object({
  includeCurrent: z.boolean().default(true),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: passwordSchema,
});

const createProfileSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100),
  role: roleSchema.exclude(["owner"]).default("member"),
  simpleMode: z.boolean().default(true),
});

const createInviteSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  role: roleSchema.exclude(["owner"]).default("member"),
  simpleMode: z.boolean().default(true),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
});

const acceptInviteSchema = z.object({
  token: z.string().trim().min(32).max(256),
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100).optional(),
});

const remotePairSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  controllerName: z.string().trim().min(1).max(80).nullable().optional(),
});

const remoteCommandTypeSchema = z.enum([
  "play",
  "pause",
  "seek-relative",
  "seek-absolute",
  "volume",
  "mute",
  "fullscreen",
  "next",
  "close",
] satisfies RemoteCommandType[]);

const remoteCommandSchema = z
  .object({
    type: remoteCommandTypeSchema,
    value: z.union([z.number().finite(), z.boolean()]).optional(),
  })
  .superRefine((command, context) => {
    if (
      (command.type === "seek-relative" ||
        command.type === "seek-absolute" ||
        command.type === "volume") &&
      typeof command.value !== "number"
    ) {
      context.addIssue({
        code: "custom",
        message: `${command.type} requires a numeric value.`,
        path: ["value"],
      });
    }
    if (command.type === "mute" && typeof command.value !== "boolean") {
      context.addIssue({
        code: "custom",
        message: "mute requires a boolean value.",
        path: ["value"],
      });
    }
  });

const remoteStateSchema = z.object({
  title: z.string().trim().max(300).nullable(),
  subtitle: z.string().trim().max(300).nullable(),
  playing: z.boolean(),
  positionSeconds: z.number().finite().min(0).max(7 * 24 * 60 * 60),
  durationSeconds: z
    .number()
    .finite()
    .min(0)
    .max(7 * 24 * 60 * 60)
    .nullable(),
  volume: z.number().finite().min(0).max(1),
  muted: z.boolean(),
});

const remoteViewerQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

const patchProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  simpleMode: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

// Change an account's role (promote/demote). Kept as a dedicated action rather
// than folding into patchProfileSchema so the admin/owner guards and audit entry
// stay explicit and hard to bypass.
const setRoleSchema = z.object({ role: roleSchema });

// Household sub-profile ("who's watching") schemas. Distinct from the account
// schemas above: a sub-profile is a viewer within ONE account, not a separate
// login - so no username, and the password is OPTIONAL (kid/guest profiles).
// avatarColor is a short style token (hex or keyword) the picker renders as a
// tint behind the display-name initial.
const avatarColorSchema = z.string().trim().min(1).max(32);

const createAccountProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  avatarColor: avatarColorSchema.nullish(),
  simpleMode: z.boolean().default(true),
  password: passwordSchema.optional(),
});

const patchAccountProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    avatarColor: avatarColorSchema.nullish(),
    simpleMode: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.avatarColor !== undefined ||
      b.simpleMode !== undefined,
    { message: "Provide at least one field to update." },
  );

const switchProfileSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  // Parental unlock: required only when LEAVING a kid profile (verified against
  // the account password). Also carries the per-profile PIN when ENTERING a
  // PIN-protected profile. Optional/ignored for all other switches.
  password: z.string().min(1).max(512).optional(),
});

// Set or clear a profile's household PIN. A 4-6 digit numeric PIN; null clears
// it. The owner/admin may set any owned profile's PIN; a member may set their
// own. It gates SWITCHING into the profile - a household gate, not encryption.
const setProfilePinSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  pin: z
    .string()
    .regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits.")
    .nullable(),
});

const setProfilePasswordSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  password: passwordSchema,
});

// Household bandwidth is warn-only. The cap is represented as an exact byte
// count so the server, API, and clients all agree on the 80% warning boundary.
const setProfileBandwidthQuotaSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  capBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});

const accountProfileIdParamSchema = z.string().trim().min(1).max(128);

// A MediaPreview display snapshot. Cap its serialized size so a client can't
// persist arbitrarily large blobs per row (defense-in-depth above Fastify's 1MB
// body limit). 32 KB is ~16x a normal preview, so no legitimate payload is cut.
const boundedPreview = z
  .unknown()
  .refine((value) => JSON.stringify(value ?? null).length <= 32_768, {
    message: "preview payload is too large",
  });

// Bounds the :mediaId path param (written into watchlist/history rows + audit
// log). Matches the cap on other id params in this file; rejects empty/oversized.
const mediaIdParamSchema = z.string().trim().min(1).max(128);

const watchlistBodySchema = z.object({
  preview: boundedPreview,
});

const historyBodySchema = z.object({
  episodeId: z.string().trim().min(1).max(128).nullable().optional(),
  progressSeconds: z.number().nonnegative().default(0),
  durationSeconds: z.number().positive().nullable().optional(),
  completed: z.boolean().default(false),
  streamQuality: z.string().trim().max(80).nullable().optional(),
  preview: boundedPreview,
  lastWatched: z.string().datetime().optional(),
});

const requestBodySchema = z.object({
  mediaId: mediaIdParamSchema,
  preview: boundedPreview,
});

const requestStatusQuerySchema = z.object({
  status: z.enum(["pending", "approved", "denied"]).optional(),
});

const requestDenyBodySchema = z.object({
  reason: z.string().trim().max(500).nullish(),
});

const requestIdParamSchema = z.string().trim().min(1).max(128);

const listTypeSchema = z.enum(["watchlist", "favorites", "custom"]);

const libraryUpsertBodySchema = z.object({
  listType: listTypeSchema,
  folderId: z.string().trim().min(1).max(128).nullish(),
  customListName: z.string().max(200).nullish(),
  releaseDateHint: z.string().max(64).nullish(),
  renewalStatus: z.string().max(64).nullish(),
  preview: boundedPreview,
  addedAt: z.string().datetime().optional(),
});

const folderCreateBodySchema = z.object({
  name: z.string().max(120),
  listType: listTypeSchema,
  parentId: z.string().trim().min(1).max(128).nullish(),
});

const folderSaveBodySchema = z.object({
  name: z.string().max(120),
  parentId: z.string().max(128).nullable(),
  listType: listTypeSchema,
  folderKind: z.enum(["system_root", "manual", "watched", "release_wait"]),
  isSystem: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const portableSettingSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().max(16_384),
});

const portableWatchlistSchema = z.object({
  mediaId: mediaIdParamSchema,
  addedAt: z.string().datetime(),
  preview: boundedPreview,
});

const portableHistorySchema = z.object({
  mediaId: mediaIdParamSchema,
  episodeId: z.string().trim().min(1).max(128).nullable(),
  progressSeconds: z.number().finite().nonnegative(),
  durationSeconds: z.number().finite().positive().nullable(),
  completed: z.boolean(),
  lastWatched: z.string().datetime(),
  streamQuality: z.string().trim().max(80).nullable(),
  preview: boundedPreview,
});

const portableFolderSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  parentId: z.string().trim().min(1).max(128).nullable(),
  listType: listTypeSchema,
  folderKind: z.enum(["system_root", "manual", "watched", "release_wait"]),
  isSystem: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const portableLibrarySchema = z.object({
  mediaId: mediaIdParamSchema,
  folderId: z.string().trim().min(1).max(128).nullable(),
  listType: listTypeSchema,
  addedAt: z.string().datetime(),
  customListName: z.string().max(200).nullable(),
  releaseDateHint: z.string().max(64).nullable(),
  renewalStatus: z.string().max(64).nullable(),
  preview: boundedPreview,
});

const portableProfileBundleSchema = z
  .object({
    product: z.literal("YAWF Stream"),
    format: z.literal("yawf-profile-portable"),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    settings: z.array(portableSettingSchema).max(300),
    watchlist: z.array(portableWatchlistSchema).max(10_000),
    history: z.array(portableHistorySchema).max(20_000),
    folders: z.array(portableFolderSchema).max(5_000),
    library: z.array(portableLibrarySchema).max(20_000),
  })
  .superRefine((bundle, context) => {
    const folderIds = new Set<string>();
    bundle.folders.forEach((folder, index) => {
      if (folderIds.has(folder.id)) {
        context.addIssue({
          code: "custom",
          message: "Folder IDs must be unique.",
          path: ["folders", index, "id"],
        });
      }
      folderIds.add(folder.id);
      if (folder.isSystem !== (folder.folderKind !== "manual")) {
        context.addIssue({
          code: "custom",
          message: "Folder system state does not match its kind.",
          path: ["folders", index, "isSystem"],
        });
      }
      if (
        (folder.folderKind === "watched" ||
          folder.folderKind === "release_wait") &&
        folder.listType !== "favorites"
      ) {
        context.addIssue({
          code: "custom",
          message: "Favorite system folders must use the favorites list.",
          path: ["folders", index, "listType"],
        });
      }
    });
  });

const portableImportSchema = z.object({
  mode: z.enum(["merge", "replace"]).default("merge"),
  bundle: portableProfileBundleSchema,
});

const credentialBodySchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  provider: providerSchema,
  label: z.string().trim().min(1).max(120).default("Default"),
  value: z.string().min(1).max(8192),
  priority: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});

const aiRecommendBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  count: z.number().int().min(1).max(20).default(8),
});

const subtitleSearchBodySchema = z
  .object({
    imdbId: z.string().trim().max(32).nullish(),
    query: z.string().trim().max(200).nullish(),
    season: z.number().int().min(0).max(10_000).nullish(),
    episode: z.number().int().min(0).max(10_000).nullish(),
    languages: z.array(z.string().trim().min(1).max(12)).max(10).optional(),
  })
  .refine((b) => (b.imdbId?.length ?? 0) > 0 || (b.query?.length ?? 0) > 0, {
    message: "Provide an imdbId or a query.",
  });

const subtitleFetchBodySchema = z.object({
  fileId: z.string().trim().min(1).max(64),
  // The title being watched - required for a kid so the maturity cap can be
  // enforced on the fetched dialogue (search is gated the same way).
  imdbId: z.string().trim().max(32).nullish(),
});

const subtitleTranslateBodySchema = z.object({
  cues: z
    .array(
      z.object({
        start: z.number().finite().min(0),
        end: z.number().finite().min(0),
        text: z.string().max(2000),
      }),
    )
    .min(1)
    .max(5000),
  targetLanguage: z.string().trim().min(1).max(40),
});

const rawStreamSessionSchema = z.object({
  upstreamUrl: z.string().url(),
  contentType: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  expiresInSeconds: z.number().int().min(1).max(60 * 60 * 24).default(60 * 60 * 6),
});

const streamUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const sessionIdParamSchema = z.string().trim().min(1).max(120);

const streamSearchQuerySchema = z.object({
  type: mediaTypeSchema.default("movie"),
  season: z.coerce.number().int().min(0).max(10_000).optional(),
  episode: z.coerce.number().int().min(0).max(10_000).optional(),
  // Human title for the name-matching indexer pass (APIBay etc.). Optional so an
  // older client that omits it still works (imdb-only). Bounded to the same 300
  // chars as a media title. NO `.min(1)`: a blank `title=` must be accepted and
  // treated as "no title pass" (searchServerStreams only runs the pass when the
  // trimmed title is non-empty) - rejecting it would 400 a direct/older client.
  title: z.string().trim().max(300).optional(),
  // Release year for the wrong-year DOWN-RANK (movies only; a ranking hint, not
  // a filter). `.catch(undefined)`: a malformed/blank `year=` must degrade to
  // "no year hint", never 400 the whole stream search over ranking metadata.
  year: z.coerce.number().int().min(1800).max(3000).optional().catch(undefined),
  // Opt-in newline-delimited response. Older clients keep receiving one JSON
  // document, while current clients can render indexer results before the
  // provider cache checks complete.
  progressive: z.literal("1").optional().catch(undefined),
});

const mediaSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.union([mediaTypeSchema, z.literal("all")]).default("all"),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

const mediaCategorySchema = z.enum([
  "trending",
  "popular",
  "top_rated",
  "now_playing",
  "upcoming",
  "airing_today",
  "on_the_air",
]);

const mediaCategoryQuerySchema = z.object({
  type: mediaTypeSchema,
  category: mediaCategorySchema,
  page: z.coerce.number().int().min(1).max(500).default(1),
});

const mediaGenresQuerySchema = z.object({
  type: mediaTypeSchema,
});

const mediaDiscoverBaseQuerySchema = z.object({
  type: mediaTypeSchema,
});

const mediaDetailQuerySchema = z.object({
  id: z.string().trim().min(1).max(128),
  type: mediaTypeSchema,
});

const mediaSeasonsQuerySchema = z.object({
  tmdbId: z.coerce.number().int().min(1),
});

const mediaEpisodesQuerySchema = z.object({
  tmdbId: z.coerce.number().int().min(1),
  // Realistic ceiling - the longest-running shows are well under 100 seasons;
  // anything bigger is abuse probing and is rejected before TMDB is contacted.
  season: z.coerce.number().int().min(0).max(200),
});

const mediaPreviewSchema = z.object({
  id: z.string().trim().min(1).max(128),
  type: mediaTypeSchema,
  title: z.string().trim().min(1).max(300),
  year: z.number().int().nullable().optional(),
  posterPath: z.string().nullable().optional(),
  imdbRating: z.number().nullable().optional(),
  tmdbId: z.number().int().nullable().optional(),
  backdropPath: z.string().nullable().optional(),
});

const upcomingEpisodesBodySchema = z.object({
  series: z.array(mediaPreviewSchema).max(MAX_CALENDAR_SERIES),
});

type MediaPreviewInput = z.infer<typeof mediaPreviewSchema>;
type SeriesPreviewInput = MediaPreviewInput & { type: "series" };

function isSeriesPreviewInput(input: MediaPreviewInput): input is SeriesPreviewInput {
  return input.type === "series";
}

const resolveStreamSchema = z.object({
  infoHash: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{40}$/)
    .transform((value) => value.toLowerCase()),
  preferredService: debridServiceSchema.nullable().optional(),
  expiresInSeconds: z.number().int().min(1).max(60 * 60 * 24).default(60 * 60 * 6),
  // Media identity, carried so a maturity-capped (kid) profile can be checked
  // against the title's certification before the stream is resolved. Optional
  // for back-compat + raw sessions; their absence on a capped profile is itself
  // a block (fail-closed) - see the resolve route.
  mediaId: z.string().trim().min(1).max(256).optional(),
  mediaType: z.enum(["movie", "series"]).optional(),
  // Episode context (series only) - steers multi-file season-pack torrents to
  // the exact episode's file. Optional for back-compat; omitted → the default
  // largest-file pick, exactly today's behavior.
  season: z.number().int().min(1).max(200).nullable().optional(),
  episode: z.number().int().min(1).max(10_000).nullable().optional(),
});

const profileSettingSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().max(16_384).nullable(),
});

// Profile-settings keys written server-side that must never be read back by, or
// be writable from, the generic /api/settings/profile surface (it round-trips
// arbitrary client key/values). PIN hashes are write-only and bandwidth caps
// have their own owner/admin endpoint, so neither can be clobbered by settings.
const PROTECTED_PROFILE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "profile_password_hash",
  "profile_gate_kind",
  "bandwidth_cap_bytes",
]);

const PORTABILITY_SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "tmdb_api_key",
  "trakt_client_id",
  "trakt_client_secret",
  "omdb_api_key",
  "ai_api_key",
  "opensubtitles_api_key",
  "server_indexer_configs",
]);

function isPortableProfileSetting(key: string, value?: string): boolean {
  return (
    !PROTECTED_PROFILE_SETTING_KEYS.has(key) &&
    !PORTABILITY_SECRET_SETTING_KEYS.has(key) &&
    !/(?:^|_)(?:api_?key|token|secret|password|credential)(?:_|$)/i.test(key) &&
    !(value?.startsWith("secret:") ?? false)
  );
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

function createRateLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  return (
    request: FastifyRequest,
    bucket: string,
    limit: number,
    windowMs: number,
  ): void => {
    const now = Date.now();
    // Opportunistically evict expired buckets (at most once a minute, driven by
    // request activity - no dangling timer). Without this the map grows
    // unbounded from high-cardinality pre-auth keys (per-username login,
    // per-invite-token, per-IP), since entries were only ever inserted.
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }
    const key = `${bucket}:${request.ip}`;
    const current = buckets.get(key);
    if (current == null || current.resetAt <= now) {
      if (current == null && buckets.size >= 20_000) {
        // Keep spoofed usernames, invite tokens, and profile IDs from turning
        // rate limiting itself into an unbounded memory sink. Entries are
        // insertion ordered, so removing the oldest 10% is bounded and cheap.
        let remove = 2_000;
        for (const oldestKey of buckets.keys()) {
          buckets.delete(oldestKey);
          remove -= 1;
          if (remove === 0) break;
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw httpError(429, "Too many requests. Try again shortly.");
    }
  };
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function stringQueryParams(
  query: Record<string, unknown>,
  excluded: Set<string>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (excluded.has(key)) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value == null) continue;
    params[key] = String(value);
  }
  return params;
}

function isAdmin(role: UserRole): boolean {
  return role === "owner" || role === "admin";
}

const BANDWIDTH_CAP_SETTING = "bandwidth_cap_bytes";
const BANDWIDTH_PERIOD_DAYS = 30;

// Maturity ladder (kid gating). The owner-set cap (`maturity_max`) is always a US
// movie certification; a title's certification can be a US movie cert OR a US TV
// content rating, so both vocabularies are mapped onto one ascending severity
// rank. The cap settings the UI offers are the MOVIE_CERTS.
const MOVIE_CERTS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
const MATURITY_RANK: Readonly<Record<string, number>> = {
  // US movie (release_dates .certification)
  G: 0,
  PG: 1,
  "PG-13": 2,
  R: 3,
  "NC-17": 4,
  // US TV (content_ratings .rating), folded onto the same scale
  "TV-Y": 0,
  "TV-Y7": 0,
  "TV-G": 0,
  "TV-PG": 1,
  "TV-14": 2,
  "TV-MA": 4,
};

/** Whether a title's certification is allowed under a maturity cap. FAIL-CLOSED:
 * a null/blank/unrecognized title cert returns false (blocked), as does an
 * unrecognized cap. Only a known cert whose rank is <= the cap's rank passes. */
function certWithinCap(cert: string | null, cap: string): boolean {
  const capRank = MATURITY_RANK[cap];
  if (capRank == null) return false;
  if (cert == null) return false;
  const certRank = MATURITY_RANK[cert.trim().toUpperCase()];
  if (certRank == null) return false;
  return certRank <= capRank;
}

const maturitySettingsSchema = z
  .object({
    isKid: z.boolean(),
    // null clears the cap (no restriction); otherwise one of the movie certs.
    maturityMax: z.enum(MOVIE_CERTS).nullable(),
  })
  // is_kid and the cap are strictly coupled: a kid MUST carry a cap (else the
  // play-block + curated browse fail open), and a cap without is_kid would leave
  // the search/AI/calendar lockdown (which keys off is_kid) bypassable. Forbid
  // BOTH half-states so the only persistable rows are (kid + cap) or (neither).
  .refine((v) => v.isKid === (v.maturityMax != null), {
    message: "A kid profile requires a maturity cap, and a cap requires the kid flag.",
    path: ["maturityMax"],
  });

/** The active profile's maturity context, passed to the catalog runtime so kid
 *  browse is curated to cert-capped, movie-only results. */
function maturityAudience(auth: AuthContext): {
  isKid: boolean;
  maturityMax: string | null;
} {
  return { isKid: auth.isKid, maturityMax: auth.maturityMax };
}

function cookieOptions(config: ServerConfig, httpOnly: boolean) {
  return {
    path: "/",
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    httpOnly,
    maxAge: config.sessionTtlSeconds,
  };
}

function serializePreview(preview: unknown): string {
  return JSON.stringify(preview ?? null);
}

function deserializePreview(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function userCount(db: AppDatabase): number {
  return (db.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
}

// ---- Library + folders (mirrors web DexieStore, profile-scoped) ------------
const LIST_TYPES = ["watchlist", "favorites", "custom"] as const;
type ListType = (typeof LIST_TYPES)[number];

function listTypeSupportsFolders(listType: ListType): boolean {
  return listType !== "watchlist";
}
function systemRootName(listType: ListType): string {
  switch (listType) {
    case "watchlist":
      return "Watchlist";
    case "favorites":
      return "Library";
    case "custom":
      return "Custom";
  }
}
// System-folder ids are namespaced PER PROFILE so the deterministic identity
// doesn't collide across profiles on the single-column PK (no migration needed).
// The client references ids returned by listFolders, so only per-profile
// consistency matters, not the exact string.
function systemRootId(profileId: string, listType: ListType): string {
  return `sys-${listType}-${profileId}`;
}
function favWatchedId(profileId: string): string {
  return `sys-favorites-watched-${profileId}`;
}
function favReleaseWaitId(profileId: string): string {
  return `sys-favorites-release-wait-${profileId}`;
}

/** Seed a profile's 5 system folders (idempotent). Mirrors
 *  DexieStore.ensureSystemFolders: 3 roots + Watched / Release Wait under
 *  the favorites root. */
function ensureLibrarySystemFolders(db: AppDatabase, profileId: string): void {
  const now = nowISO();
  const insert = db.sqlite.prepare(
    `INSERT OR IGNORE INTO library_folders
       (id, profile_id, name, parent_id, list_type, folder_kind, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  db.transaction(() => {
    for (const lt of LIST_TYPES) {
      insert.run(systemRootId(profileId, lt), profileId, systemRootName(lt), null, lt, "system_root", now, now);
    }
    const favRoot = systemRootId(profileId, "favorites");
    insert.run(favWatchedId(profileId), profileId, "Watched", favRoot, "favorites", "watched", now, now);
    insert.run(favReleaseWaitId(profileId), profileId, "Release Wait", favRoot, "favorites", "release_wait", now, now);
  });
}

interface LibraryFolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  list_type: string;
  folder_kind: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}
function mapFolderRow(r: LibraryFolderRow) {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    listType: r.list_type,
    folderKind: r.folder_kind,
    isSystem: r.is_system === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const FOLDER_COLS =
  "id, name, parent_id, list_type, folder_kind, is_system, created_at, updated_at";

interface LibraryRow {
  id: string;
  media_id: string;
  folder_id: string | null;
  list_type: string;
  added_at: string;
  custom_list_name: string | null;
  release_date_hint: string | null;
  renewal_status: string | null;
  preview_json: string;
}
function mapLibraryRow(r: LibraryRow) {
  return {
    id: r.id,
    mediaId: r.media_id,
    folderId: r.folder_id,
    listType: r.list_type,
    addedAt: r.added_at,
    customListName: r.custom_list_name,
    releaseDateHint: r.release_date_hint,
    renewalStatus: r.renewal_status,
    preview: deserializePreview(r.preview_json),
  };
}
const LIBRARY_COLS =
  "id, media_id, folder_id, list_type, added_at, custom_list_name, release_date_hint, renewal_status, preview_json";

/** True if a folder id belongs to this profile (guards FK + IDOR). */
function folderExistsForProfile(db: AppDatabase, profileId: string, folderId: string): boolean {
  return (
    db.sqlite
      .prepare("SELECT 1 FROM library_folders WHERE id = ? AND profile_id = ? LIMIT 1")
      .get(folderId, profileId) != null
  );
}

/** DexieStore.uniqueFolderName parity: disambiguate among siblings (same
 *  listType + parentId) with " (2)", " (3)", … */
function uniqueFolderName(
  db: AppDatabase,
  profileId: string,
  desired: string,
  listType: ListType,
  parentId: string | null,
): string {
  const base = desired.trim().length > 0 ? desired.trim() : "New Folder";
  const siblings = (
    parentId == null
      ? db.sqlite
          .prepare(
            "SELECT name FROM library_folders WHERE profile_id = ? AND list_type = ? AND parent_id IS NULL",
          )
          .all(profileId, listType)
      : db.sqlite
          .prepare(
            "SELECT name FROM library_folders WHERE profile_id = ? AND list_type = ? AND parent_id = ?",
          )
          .all(profileId, listType, parentId)
  ) as Array<{ name: string }>;
  const taken = new Set(siblings.map((s) => s.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

function audit(
  db: AppDatabase,
  auth: Pick<AuthContext, "userId" | "profileId"> | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: unknown,
): void {
  db.sqlite
    .prepare(
      `INSERT INTO audit_log
       (id, actor_user_id, actor_profile_id, action, target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomId("audit"),
      auth?.userId ?? null,
      auth?.profileId ?? null,
      action,
      targetType ?? null,
      targetId ?? null,
      metadata == null ? null : JSON.stringify(metadata),
      nowISO(),
    );
}

function createUserAndProfile(
  db: AppDatabase,
  input: {
    username: string;
    displayName: string;
    passwordHash: string;
    profilePasswordHash?: string;
    role: UserRole;
    simpleMode?: boolean;
  },
): { userId: string; profileId: string } {
  const userId = randomId("user");
  const profileId = randomId("profile");
  const now = nowISO();
  // Surface a duplicate username as a clean 409 instead of an opaque 500 from the
  // UNIQUE(username) constraint. Callers run this inside a BEGIN IMMEDIATE
  // transaction, so this check + insert are atomic (no TOCTOU).
  const existingUser = db.sqlite
    .prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE LIMIT 1")
    .get(input.username);
  if (existingUser != null) {
    throw httpError(409, "Username already taken.");
  }
  db.sqlite
    .prepare(
      `INSERT INTO users
       (id, username, display_name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, input.username, input.displayName, input.passwordHash, input.role, now);
  db.sqlite
    .prepare(
      `INSERT INTO profiles
       (id, user_id, display_name, simple_mode, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      profileId,
      userId,
      input.displayName,
      input.simpleMode ?? true ? 1 : 0,
      now,
      now,
    );
  if (input.profilePasswordHash != null) {
    db.sqlite
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value)
         VALUES (?, 'profile_password_hash', ?)`,
      )
      .run(profileId, input.profilePasswordHash);
    db.sqlite
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value)
         VALUES (?, 'profile_gate_kind', 'password')`,
      )
      .run(profileId);
  }
  return { userId, profileId };
}

function mapInviteRow(row: {
  id: string;
  label: string | null;
  role: UserRole;
  simple_mode: number;
  max_uses: number;
  used_count: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}) {
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    simpleMode: row.simple_mode === 1,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    active:
      row.revoked_at == null &&
      row.used_count < row.max_uses &&
      new Date(row.expires_at).getTime() > Date.now(),
  };
}

function mapRequestRow(row: {
  id: string;
  media_id: string;
  preview_json: string;
  status: string;
  decision_reason: string | null;
  requested_at: string;
  decided_at: string | null;
  requester_display_name?: string | null;
  decided_by_display_name?: string | null;
}) {
  return {
    id: row.id,
    mediaId: row.media_id,
    preview: deserializePreview(row.preview_json),
    status: row.status as "pending" | "approved" | "denied",
    decisionReason: row.decision_reason,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    requestedByDisplayName: row.requester_display_name ?? null,
    decidedByDisplayName: row.decided_by_display_name ?? null,
  };
}

function mapAuditLogRow(row: {
  id: string;
  actor_user_id: string | null;
  actor_profile_id: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}) {
  let metadata: unknown = null;
  if (row.metadata_json != null) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorProfileId: row.actor_profile_id,
    actorUsername: row.actor_username,
    actorDisplayName: row.actor_display_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata,
    createdAt: row.created_at,
  };
}

function mapSessionRow(
  row: {
    id: string;
    user_agent: string | null;
    ip_hash: string | null;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
  },
  currentSessionId: string,
) {
  return {
    id: row.id,
    userAgent: row.user_agent,
    ipHash: row.ip_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    current: row.id === currentSessionId,
    active:
      row.revoked_at == null &&
      new Date(row.expires_at).getTime() > Date.now(),
  };
}

function createSession(
  db: AppDatabase,
  config: ServerConfig,
  userId: string,
  request: FastifyRequest,
): { sessionId: string; rawToken: string; csrfToken: string; expiresAt: string } {
  const sessionId = randomId("sess");
  const rawToken = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = addSecondsISO(config.sessionTtlSeconds);
  db.sqlite
    .prepare(
      `INSERT INTO sessions
       (id, user_id, token_hash, user_agent, ip_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      userId,
      sha256(rawToken),
      request.headers["user-agent"] ?? null,
      hashOptional(request.ip),
      nowISO(),
      expiresAt,
    );
  db.sqlite
    .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .run(nowISO(), userId);
  return { sessionId, rawToken, csrfToken, expiresAt };
}

// A throwaway scrypt hash (over a random password) used to spend the same CPU on
// a login attempt for a non-existent username as for a real one, so response
// timing doesn't leak which usernames exist. Computed once, lazily.
let dummyPasswordHash: string | null = null;
async function verifyDummyPassword(password: string): Promise<void> {
  dummyPasswordHash ??= await hashPassword(randomToken());
  await verifyPassword(dummyPasswordHash, password);
}

function setSessionCookies(
  reply: FastifyReply,
  config: ServerConfig,
  session: { sessionId: string; rawToken: string; csrfToken: string },
): void {
  reply.setCookie(
    SESSION_COOKIE,
    `${session.sessionId}.${session.rawToken}`,
    cookieOptions(config, true),
  );
  reply.setCookie(CSRF_COOKIE, session.csrfToken, cookieOptions(config, false));
}

function clearSessionCookies(reply: FastifyReply, config: ServerConfig): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config, true));
  reply.clearCookie(CSRF_COOKIE, cookieOptions(config, false));
}

function readSessionCookie(request: FastifyRequest): { sessionId: string; rawToken: string } | null {
  const value = request.cookies?.[SESSION_COOKIE];
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  return {
    sessionId: value.slice(0, dot),
    rawToken: value.slice(dot + 1),
  };
}

function readAuth(db: AppDatabase, request: FastifyRequest): AuthContext | null {
  const cookieValue = readSessionCookie(request);
  if (cookieValue == null) return null;
  // The active profile is sessions.active_profile_id when it still points at a
  // live profile OWNED BY THIS USER (the AND profiles.user_id guard makes the
  // pointer IDOR-safe even if a stale id from another account ever leaked in),
  // otherwise the account's is_default profile. COALESCE on the joined ids lets
  // one query pick the active row and fall back without a second round-trip:
  // NULL active id (single-profile deployments, pre-migration sessions) or a
  // since-disabled/deleted active profile both degrade to the default.
  const row = db.sqlite
    .prepare(
      `SELECT
         users.id AS userId,
         users.username AS username,
         users.role AS role,
         COALESCE(active.id, def.id) AS profileId,
         COALESCE(active.display_name, def.display_name) AS displayName,
         COALESCE(active.avatar_color, def.avatar_color) AS avatarColor,
         COALESCE(active.simple_mode, def.simple_mode) AS simpleMode,
         -- maturity_max is NULLABLE (null = no cap), so COALESCE would wrongly
         -- bleed the default profile's cap onto an active adult profile. Pick by
         -- whether the active row actually joined, mirroring profileId above.
         CASE WHEN active.id IS NOT NULL THEN active.is_kid ELSE def.is_kid END AS isKid,
         CASE WHEN active.id IS NOT NULL THEN active.maturity_max ELSE def.maturity_max END AS maturityMax,
         sessions.id AS sessionId
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       JOIN profiles AS def
         ON def.user_id = users.id AND def.is_default = 1 AND def.disabled_at IS NULL
       LEFT JOIN profiles AS active
         ON active.id = sessions.active_profile_id
        AND active.user_id = users.id
        AND active.disabled_at IS NULL
       WHERE sessions.id = ?
         AND sessions.token_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
         AND users.disabled_at IS NULL
       LIMIT 1`,
    )
    .get(cookieValue.sessionId, sha256(cookieValue.rawToken), nowISO()) as
    | (Omit<AuthContext, "simpleMode" | "isKid"> & {
        simpleMode: number;
        isKid: number;
      })
    | undefined;
  // simple_mode / is_kid are INTEGER columns - map to real booleans (a raw cast
  // would leak a number, defeating `=== true` / `?? true` checks downstream).
  if (row == null) return null;
  return { ...row, simpleMode: row.simpleMode === 1, isKid: row.isKid === 1 };
}

function requireAuth(db: AppDatabase, request: FastifyRequest): AuthContext {
  const auth = readAuth(db, request);
  if (auth == null) throw httpError(401, "Authentication required.");
  return auth;
}

function requireAdmin(auth: AuthContext): void {
  // A kid-active session is locked down regardless of the underlying ACCOUNT
  // role: `role` comes from users.role and a household sub-profile inherits it,
  // so without this a kid switched-into under an owner/admin account would pass
  // requireAdmin and could (e.g.) lift its own maturity cap. The active profile,
  // not the account role, is the privilege boundary here.
  if (auth.isKid) throw httpError(403, "This action is not available on this profile.");
  if (!isAdmin(auth.role)) throw httpError(403, "Admin access required.");
}

// A "restricted" profile can browse + watch but is strictly less-privileged than
// a "member": it cannot perform any management/write action (credential edits,
// profile management, etc.). Apply this to those routes; do NOT apply it to
// normal viewing/search/watchlist/history/streaming. A kid-active session is
// likewise barred (same active-profile-is-the-boundary reasoning as requireAdmin).
function requireNotRestricted(auth: AuthContext): void {
  if (auth.isKid) {
    throw httpError(403, "This action is not available on this profile.");
  }
  if (auth.role === "restricted") {
    throw httpError(403, "This action is not available for restricted profiles.");
  }
}

function requireCsrf(request: FastifyRequest): void {
  if (!unsafeMethods.has(request.method)) return;
  const cookieToken = request.cookies?.[CSRF_COOKIE];
  const headerToken = request.headers["x-csrf-token"];
  const supplied = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !supplied || supplied !== cookieToken) {
    throw httpError(403, "CSRF token is missing or invalid.");
  }
}

function allowedCorsOrigin(origin: string | undefined, config: ServerConfig): string | null {
  if (origin == null || origin.length === 0) return null;
  if (config.corsOrigin != null && config.corsOrigin.trim().length > 0) {
    const allowed = config.corsOrigin.split(",").map((item) => item.trim());
    return allowed.includes(origin) ? origin : null;
  }
  if (process.env.NODE_ENV !== "production") {
    try {
      const url = new URL(origin);
      if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        return origin;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function redactedCredential(row: {
  id: string;
  provider: CredentialProvider;
  scope: "server" | "profile";
  profile_id: string | null;
  label: string;
  priority: number;
  is_active: number;
  updated_at: string;
}) {
  return {
    id: row.id,
    provider: row.provider,
    scope: row.scope,
    profileId: row.profile_id,
    label: row.label,
    priority: row.priority,
    isActive: row.is_active === 1,
    updatedAt: row.updated_at,
  };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
};

function safeStaticPath(root: string, urlPath: string): string | null {
  // Fastify already decoded the wildcard param; this second decode can throw a
  // URIError on a malformed escape (e.g. "/%25" → "/%"). Catch it and fall back
  // to the SPA index (return null) instead of bubbling a 500 from the public route.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?", 1)[0] ?? "/");
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = resolve(join(root, clean === "/" ? "index.html" : clean));
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

function registerStaticApp(app: FastifyInstance, config: ServerConfig): void {
  if (config.webDistPath == null || !existsSync(config.webDistPath)) return;
  const root = resolve(config.webDistPath);

  app.get("/server-mode.js", async (_request, reply) => {
    reply.header("content-type", "text/javascript; charset=utf-8");
    reply.header("cache-control", "no-store");
    return reply.send(
      "globalThis.__DEBRIDSTREAMER_SERVER_URL__ = globalThis.location.origin;\n",
    );
  });

  app.get("/*", async (request, reply) => {
    const path = (request.params as { "*": string })["*"] ?? "";
    if (path.startsWith("api/")) throw httpError(404, "Not found.");

    const candidate = safeStaticPath(root, `/${path}`);
    const file =
      candidate != null && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(root, "index.html");

    const ext = extname(file);
    reply.header("content-type", MIME_TYPES[ext] ?? "application/octet-stream");
    if (ext === ".html") {
      reply.header("cache-control", "no-store");
    } else {
      reply.header("cache-control", "public, max-age=31536000, immutable");
    }
    return reply.send(createReadStream(file));
  });
}

// ---- Household sub-profiles ("who's watching") ----------------------------

interface AccountProfileRow {
  id: string;
  display_name: string;
  avatar_color: string | null;
  simple_mode: number;
  is_default: number;
  is_kid: number;
  maturity_max: string | null;
  has_pin: number;
  profile_gate_kind: string | null;
  bandwidth_cap_bytes: string | null;
  bandwidth_usage_bytes: number;
}

function parseBandwidthCap(raw: string | null): number | null {
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function bandwidthProfileState(
  capBytes: number | null,
  usageBytes: number,
): {
  bandwidthCapBytes: number | null;
  bandwidthUsageBytes: number;
  bandwidthStatus: BandwidthCapStatus;
} {
  const safeUsage = Number.isFinite(usageBytes) ? Math.max(0, usageBytes) : 0;
  return {
    bandwidthCapBytes: capBytes,
    bandwidthUsageBytes: safeUsage,
    bandwidthStatus: bandwidthCapStatus(safeUsage, capBytes),
  };
}

function mapAccountProfile(row: AccountProfileRow) {
  const capBytes = parseBandwidthCap(row.bandwidth_cap_bytes);
  return {
    id: row.id,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    simpleMode: row.simple_mode === 1,
    isDefault: row.is_default === 1,
    isKid: row.is_kid === 1,
    maturityMax: row.maturity_max,
    // Whether a per-profile PIN is set (the switch gate below). The hash itself
    // stays server-side and write-only; the client only learns that a PIN
    // exists, so it can prompt on switch and show the lock affordance.
    hasPin: row.has_pin === 1,
    gateType:
      row.has_pin !== 1
        ? "none"
        : row.profile_gate_kind === "password"
          ? "password"
          : "pin",
    // A rolling 30-day household signal only. This is intentionally advisory:
    // no streaming route reads this status or uses it to cut playback off.
    ...bandwidthProfileState(capBytes, row.bandwidth_usage_bytes),
  };
}

/** Every live (not-disabled) sub-profile owned by an account, default first.
 *  Drives the picker. Account-scoped, so it can never surface another user's
 *  profiles. */
function listAccountProfiles(db: AppDatabase, userId: string) {
  const since = usageSinceISO(BANDWIDTH_PERIOD_DAYS);
  const rows = db.sqlite
    .prepare(
      `SELECT id, display_name, avatar_color, simple_mode, is_default,
              is_kid, maturity_max,
              EXISTS(
                SELECT 1 FROM profile_settings ps
                WHERE ps.profile_id = profiles.id
                  AND ps.key = 'profile_password_hash'
              ) AS has_pin,
              (
                SELECT value FROM profile_settings ps
                WHERE ps.profile_id = profiles.id
                  AND ps.key = 'profile_gate_kind'
              ) AS profile_gate_kind,
              (
                SELECT value FROM profile_settings ps
                WHERE ps.profile_id = profiles.id
                  AND ps.key = 'bandwidth_cap_bytes'
              ) AS bandwidth_cap_bytes,
              COALESCE((
                SELECT SUM(ss.bytes_served) FROM stream_sessions ss
                WHERE ss.profile_id = profiles.id AND ss.created_at >= ?
              ), 0) AS bandwidth_usage_bytes
       FROM profiles
       WHERE user_id = ? AND disabled_at IS NULL
       ORDER BY is_default DESC, created_at ASC`,
    )
    .all(since, userId) as unknown as AccountProfileRow[];
  return rows.map(mapAccountProfile);
}

/** The picker payload echoed from bootstrap / session / switch: the account's
 *  profiles plus which one the session currently has active. */
function accountProfileState(db: AppDatabase, auth: AuthContext) {
  return {
    profiles: listAccountProfiles(db, auth.userId),
    activeProfileId: auth.profileId,
  };
}

function effectiveCredentials(db: AppDatabase, profileId: string) {
  return CREDENTIAL_PROVIDERS.map((provider) => {
    const row = db.sqlite
      .prepare(
        `SELECT id, provider, scope, profile_id, label, priority, is_active, updated_at
         FROM credential_secrets
         WHERE provider = ?
           AND is_active = 1
           AND (
             (scope = 'profile' AND profile_id = ?)
             OR scope = 'server'
           )
         ORDER BY
           CASE WHEN scope = 'profile' THEN 0 ELSE 1 END,
           priority ASC,
           updated_at DESC
         LIMIT 1`,
      )
      .get(provider, profileId) as Parameters<typeof redactedCredential>[0] | undefined;
    return row ? redactedCredential(row) : { provider, scope: null, id: null, label: null };
  });
}

/**
 * Resolve the OMDb API key to use for a profile, WITHOUT ever exposing it.
 * Precedence: the profile's own OMDb credential (server-mode BYOK) → a
 * server-scoped OMDb credential (operator-shared) → the env-configured server
 * key (`DS_SERVER_OMDB_API_KEY`, the baked limited-distribution key). Returns
 * null when none is configured. The plaintext key never leaves the server.
 */
function resolveOmdbKey(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
): string | null {
  const row = db.sqlite
    .prepare(
      `SELECT encrypted_value
         FROM credential_secrets
        WHERE provider = 'omdb'
          AND is_active = 1
          AND (
            (scope = 'profile' AND profile_id = ?)
            OR scope = 'server'
          )
        ORDER BY
          CASE WHEN scope = 'profile' THEN 0 ELSE 1 END,
          priority ASC,
          updated_at DESC
        LIMIT 1`,
    )
    .get(profileId) as { encrypted_value: string } | undefined;
  if (row != null) {
    try {
      const key = decryptSecret(row.encrypted_value, config.secretKey).trim();
      if (key.length > 0) return key;
    } catch {
      // Fall through to the env key on a decrypt failure.
    }
  }
  const envKey = config.omdbApiKey?.trim();
  if (envKey != null && envKey.length > 0) return envKey;
  // Lowest precedence: a key baked into a "friends" build (AES-256-GCM at rest,
  // decrypted in memory). A user's own / server / env key always wins over it.
  return embeddedSecret("omdb");
}

/** The broker/server's OWN OMDb key - a SERVER-scoped credential → env →
 *  embedded build key. Never a profile credential, so the broker can never use a
 *  consumer's personal key (no sentinel-profileId convention needed). */
function resolveServerOmdbKey(db: AppDatabase, config: ServerConfig): string | null {
  const row = db.sqlite
    .prepare(
      `SELECT encrypted_value FROM credential_secrets
        WHERE provider = 'omdb' AND scope = 'server' AND is_active = 1
        ORDER BY priority ASC, updated_at DESC LIMIT 1`,
    )
    .get() as { encrypted_value: string } | undefined;
  if (row != null) {
    try {
      const k = decryptSecret(row.encrypted_value, config.secretKey).trim();
      if (k.length > 0) return k;
    } catch {
      // fall through
    }
  }
  const envKey = config.omdbApiKey?.trim();
  if (envKey != null && envKey.length > 0) return envKey;
  return embeddedSecret("omdb");
}

/** Broker mode is active only when BOTH a URL and a non-empty token are set - so
 *  a half-configured broker falls through to local key resolution instead of
 *  silently returning nothing. */
function brokerConfigured(config: ServerConfig): boolean {
  return (
    config.omdbBrokerUrl != null &&
    config.brokerAuthToken != null &&
    config.brokerAuthToken.length > 0
  );
}

/** A profile's OWN OMDb key (scope='profile' only), decrypted - used so a user's
 *  personal key (BYOK) takes precedence over a broker or shared key. Null when
 *  the profile has none. */
function profileScopedOmdbKey(
  db: AppDatabase,
  config: ServerConfig,
  profileId: string,
): string | null {
  const row = db.sqlite
    .prepare(
      `SELECT encrypted_value FROM credential_secrets
        WHERE provider = 'omdb' AND scope = 'profile' AND profile_id = ? AND is_active = 1
        ORDER BY priority ASC, updated_at DESC LIMIT 1`,
    )
    .get(profileId) as { encrypted_value: string } | undefined;
  if (row == null) return null;
  try {
    const key = decryptSecret(row.encrypted_value, config.secretKey).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** Whether the server can provide OMDb ratings for a profile (drives the client
 *  capability flag, without revealing the key) - a resolvable key OR a broker. */
function omdbAvailableFor(db: AppDatabase, config: ServerConfig, profileId: string): boolean {
  return brokerConfigured(config) || resolveOmdbKey(db, config, profileId) != null;
}

/** Constant-time check that a presented bearer token is in the broker's accepted
 *  set (compares fixed-length SHA-256 digests to avoid length/timing leaks). */
function isValidBrokerToken(config: ServerConfig, presented: string | null): boolean {
  if (presented == null || presented.length === 0 || config.brokerTokens.length === 0) {
    return false;
  }
  const a = createHash("sha256").update(presented).digest();
  let ok = false;
  for (const token of config.brokerTokens) {
    const b = createHash("sha256").update(token).digest();
    if (timingSafeEqual(a, b)) ok = true; // no early return - keep it constant-time
  }
  return ok;
}

function upsertCredential(
  db: AppDatabase,
  config: ServerConfig,
  input: z.infer<typeof credentialBodySchema>,
  scope: "server" | "profile",
  profileId: string | null,
): ReturnType<typeof redactedCredential> {
  const now = nowISO();
  const id = input.id ?? randomId("cred");
  const existing = db.sqlite
    .prepare(
      `SELECT id, scope, profile_id
       FROM credential_secrets
       WHERE id = ?`,
    )
    .get(id) as { id: string; scope: string; profile_id: string | null } | undefined;

  if (existing != null && (existing.scope !== scope || existing.profile_id !== profileId)) {
    throw httpError(404, "Credential not found.");
  }

  const encryptedValue = encryptSecret(input.value, config.secretKey);
  if (existing == null) {
    db.sqlite
      .prepare(
        `INSERT INTO credential_secrets
         (id, provider, scope, profile_id, label, encrypted_value, priority, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        scope,
        profileId,
        input.label,
        encryptedValue,
        input.priority,
        input.isActive ? 1 : 0,
        now,
        now,
      );
  } else {
    db.sqlite
      .prepare(
        `UPDATE credential_secrets
         SET provider = ?,
             label = ?,
             encrypted_value = ?,
             priority = ?,
             is_active = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.provider,
        input.label,
        encryptedValue,
        input.priority,
        input.isActive ? 1 : 0,
        now,
        id,
      );
  }

  const row = db.sqlite
    .prepare(
      `SELECT id, provider, scope, profile_id, label, priority, is_active, updated_at
       FROM credential_secrets
       WHERE id = ?`,
    )
    .get(id) as Parameters<typeof redactedCredential>[0];
  return redactedCredential(row);
}

function mapWatchHistoryRow(row: {
  media_id: string;
  episode_id: string | null;
  progress_seconds: number;
  duration_seconds: number | null;
  completed: number;
  last_watched: string;
  stream_quality: string | null;
  preview_json: string;
}) {
  return {
    mediaId: row.media_id,
    episodeId: row.episode_id,
    progressSeconds: row.progress_seconds,
    durationSeconds: row.duration_seconds,
    completed: row.completed === 1,
    lastWatched: row.last_watched,
    streamQuality: row.stream_quality,
    preview: deserializePreview(row.preview_json),
  };
}

function createStreamSession(
  db: AppDatabase,
  config: ServerConfig,
  auth: AuthContext,
  input: {
    upstreamUrl: string;
    contentType?: string | null;
    title?: string | null;
    expiresInSeconds: number;
  },
) {
  const id = randomId("stream");
  const createdAt = nowISO();
  const expiresAt = addSecondsISO(input.expiresInSeconds);
  db.sqlite
    .prepare(
      `INSERT INTO stream_sessions
       (id, profile_id, encrypted_upstream_url, content_type, title, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      auth.profileId,
      encryptSecret(input.upstreamUrl, config.secretKey),
      input.contentType ?? null,
      input.title ?? null,
      createdAt,
      expiresAt,
    );
  return {
    id,
    playbackUrl: `/api/stream/${id}`,
    playbackAuthorization: `Bearer ${streamPlaybackToken(config, {
      id,
      profileId: auth.profileId,
      expiresAt,
    })}`,
    expiresAt,
  };
}

interface StreamPlaybackGrant {
  id: string;
  profileId: string;
  expiresAt: string;
}

/** A capability scoped to one stream row and its existing expiry/revocation
 * boundary. Native players cannot inherit the webview's HttpOnly login cookie,
 * and must never receive that account-wide credential as a generic HTTP header. */
function streamPlaybackToken(config: ServerConfig, grant: StreamPlaybackGrant): string {
  return createHmac("sha256", config.secretKey)
    .update("debridstreamer:stream-playback:v1\0")
    .update(grant.id)
    .update("\0")
    .update(grant.profileId)
    .update("\0")
    .update(grant.expiresAt)
    .digest("base64url");
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function streamPlaybackTokenMatches(
  config: ServerConfig,
  grant: StreamPlaybackGrant,
  provided: string | null,
): boolean {
  if (provided == null) return false;
  const expected = Buffer.from(streamPlaybackToken(config, grant));
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function usageSinceISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function recordStreamTransfer(
  db: AppDatabase,
  input: {
    sessionId: string;
    profileId: string;
    bytes: number;
    status: number;
    completed: boolean;
    error?: string | null;
  },
): void {
  const now = nowISO();
  db.sqlite
    .prepare(
      `UPDATE stream_sessions
       SET bytes_served = bytes_served + ?,
           last_accessed_at = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
           last_status = ?,
           last_error = ?
       WHERE id = ? AND profile_id = ?`,
    )
    .run(
      input.bytes,
      now,
      input.completed ? 1 : 0,
      now,
      input.status,
      input.error ?? null,
      input.sessionId,
      input.profileId,
    );
}

function countedStream(
  db: AppDatabase,
  input: {
    sessionId: string;
    profileId: string;
    status: number;
    body: ReadableStream<Uint8Array>;
  },
) {
  let bytes = 0;
  let recorded = false;
  const source = Readable.fromWeb(input.body);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  function record(completed: boolean, error?: Error | null) {
    if (recorded) return;
    recorded = true;
    recordStreamTransfer(db, {
      sessionId: input.sessionId,
      profileId: input.profileId,
      bytes,
      status: input.status,
      completed,
      error: error?.message ?? null,
    });
  }

  source.once("error", (error) => record(false, error));
  counter.once("error", (error) => record(false, error));
  counter.once("finish", () => record(true));
  counter.once("close", () => record(false));
  return source.pipe(counter);
}

function streamUsageSummary(db: AppDatabase, profileId: string, days: number) {
  const since = usageSinceISO(days);
  const summary = db.sqlite
    .prepare(
      `SELECT COUNT(*) AS stream_count,
              COALESCE(SUM(bytes_served), 0) AS total_bytes,
              MAX(last_accessed_at) AS last_accessed_at
       FROM stream_sessions
       WHERE profile_id = ? AND created_at >= ?`,
    )
    .get(profileId, since) as {
    stream_count: number;
    total_bytes: number;
    last_accessed_at: string | null;
  };
  const sessions = db.sqlite
    .prepare(
      `SELECT id, title, created_at, expires_at, bytes_served,
              last_accessed_at, completed_at, last_status
       FROM stream_sessions
       WHERE profile_id = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(profileId, since) as Array<{
    id: string;
    title: string | null;
    created_at: string;
    expires_at: string;
    bytes_served: number;
    last_accessed_at: string | null;
    completed_at: string | null;
    last_status: number | null;
  }>;
  // The quota period remains a rolling 30 days even if an operator requests a
  // differently sized usage history. It is informational only; no playback
  // or stream-session route consults this value.
  const quota = db.sqlite
    .prepare(
      `SELECT (
                SELECT value FROM profile_settings
                WHERE profile_id = ? AND key = 'bandwidth_cap_bytes'
              ) AS bandwidth_cap_bytes,
              COALESCE(SUM(bytes_served), 0) AS bandwidth_usage_bytes
       FROM stream_sessions
       WHERE profile_id = ? AND created_at >= ?`,
    )
    .get(profileId, profileId, usageSinceISO(BANDWIDTH_PERIOD_DAYS)) as {
    bandwidth_cap_bytes: string | null;
    bandwidth_usage_bytes: number;
  };
  const bandwidth = bandwidthProfileState(
    parseBandwidthCap(quota.bandwidth_cap_bytes),
    quota.bandwidth_usage_bytes,
  );
  return {
    days,
    totalBytes: summary.total_bytes,
    streamCount: summary.stream_count,
    lastAccessedAt: summary.last_accessed_at,
    sessions: sessions.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      bytesServed: row.bytes_served,
      lastAccessedAt: row.last_accessed_at,
      completedAt: row.completed_at,
      lastStatus: row.last_status,
    })),
    ...bandwidth,
  };
}

function adminStreamUsageSummary(db: AppDatabase, days: number) {
  const since = usageSinceISO(days);
  const bandwidthSince = usageSinceISO(BANDWIDTH_PERIOD_DAYS);
  // Include just the oldest period either summary needs, then conditionally
  // aggregate each period. This keeps the admin payload's normal `days` data
  // intact while the cap always uses the rolling monthly period.
  const earliestSince = days > BANDWIDTH_PERIOD_DAYS ? bandwidthSince : since;
  const rows = db.sqlite
    .prepare(
      `SELECT profiles.id AS profile_id,
              users.username,
              profiles.display_name,
              users.role,
              COUNT(CASE WHEN stream_sessions.created_at >= ? THEN stream_sessions.id END) AS stream_count,
              COALESCE(SUM(CASE WHEN stream_sessions.created_at >= ? THEN stream_sessions.bytes_served ELSE 0 END), 0) AS total_bytes,
              MAX(CASE WHEN stream_sessions.created_at >= ? THEN stream_sessions.last_accessed_at END) AS last_accessed_at,
              settings.value AS bandwidth_cap_bytes,
              COALESCE(SUM(CASE WHEN stream_sessions.created_at >= ? THEN stream_sessions.bytes_served ELSE 0 END), 0) AS bandwidth_usage_bytes
       FROM profiles
       JOIN users ON users.id = profiles.user_id
       LEFT JOIN profile_settings settings
         ON settings.profile_id = profiles.id
        AND settings.key = 'bandwidth_cap_bytes'
       LEFT JOIN stream_sessions
         ON stream_sessions.profile_id = profiles.id
        AND stream_sessions.created_at >= ?
       WHERE profiles.disabled_at IS NULL
       GROUP BY profiles.id
       ORDER BY total_bytes DESC, stream_count DESC, profiles.display_name ASC`,
    )
    .all(since, since, since, bandwidthSince, earliestSince) as Array<{
    profile_id: string;
    username: string;
    display_name: string;
    role: UserRole;
    stream_count: number;
    total_bytes: number;
    last_accessed_at: string | null;
    bandwidth_cap_bytes: string | null;
    bandwidth_usage_bytes: number;
  }>;
  const totalBytes = rows.reduce((sum, row) => sum + row.total_bytes, 0);
  const streamCount = rows.reduce((sum, row) => sum + row.stream_count, 0);
  const lastAccessedAt =
    rows
      .map((row) => row.last_accessed_at)
      .filter((value): value is string => value != null)
      .sort()
      .at(-1) ?? null;
  return {
    days,
    totalBytes,
    streamCount,
    lastAccessedAt,
    profiles: rows.map((row) => ({
      profileId: row.profile_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      totalBytes: row.total_bytes,
      streamCount: row.stream_count,
      lastAccessedAt: row.last_accessed_at,
      ...bandwidthProfileState(
        parseBandwidthCap(row.bandwidth_cap_bytes),
        row.bandwidth_usage_bytes,
      ),
    })),
  };
}

function adminActiveStreamSessions(db: AppDatabase) {
  const now = nowISO();
  const rows = db.sqlite
    .prepare(
      `SELECT stream_sessions.id,
              stream_sessions.profile_id,
              users.username,
              profiles.display_name,
              stream_sessions.title,
              stream_sessions.content_type,
              stream_sessions.created_at,
              stream_sessions.expires_at,
              stream_sessions.bytes_served,
              stream_sessions.last_accessed_at,
              stream_sessions.last_status,
              stream_sessions.last_error
       FROM stream_sessions
       JOIN profiles ON profiles.id = stream_sessions.profile_id
       JOIN users ON users.id = profiles.user_id
       WHERE stream_sessions.revoked_at IS NULL
         AND stream_sessions.expires_at > ?
         AND stream_sessions.completed_at IS NULL
       ORDER BY
         COALESCE(stream_sessions.last_accessed_at, stream_sessions.created_at) DESC
       LIMIT 100`,
    )
    .all(now) as Array<{
    id: string;
    profile_id: string;
    username: string;
    display_name: string;
    title: string | null;
    content_type: string | null;
    created_at: string;
    expires_at: string;
    bytes_served: number;
    last_accessed_at: string | null;
    last_status: number | null;
    last_error: string | null;
  }>;

  return {
    streams: rows.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      username: row.username,
      displayName: row.display_name,
      title: row.title,
      contentType: row.content_type,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      bytesServed: row.bytes_served,
      lastAccessedAt: row.last_accessed_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
    })),
  };
}

type SqlParam = string | number | bigint | Buffer | null;

function countScalar(db: AppDatabase, sql: string, ...params: SqlParam[]): number {
  const row = db.sqlite.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function adminHealthSummary(db: AppDatabase, config: ServerConfig) {
  const now = nowISO();
  const counts = {
    users: countScalar(db, "SELECT COUNT(*) AS count FROM users WHERE disabled_at IS NULL"),
    profiles: countScalar(db, "SELECT COUNT(*) AS count FROM profiles WHERE disabled_at IS NULL"),
    activeSessions: countScalar(
      db,
      `SELECT COUNT(*) AS count
       FROM sessions
       WHERE revoked_at IS NULL AND expires_at > ?`,
      now,
    ),
    activeStreamSessions: countScalar(
      db,
      `SELECT COUNT(*) AS count
       FROM stream_sessions
       WHERE revoked_at IS NULL
         AND expires_at > ?
         AND completed_at IS NULL`,
      now,
    ),
    credentials: countScalar(
      db,
      "SELECT COUNT(*) AS count FROM credential_secrets WHERE is_active = 1",
    ),
    activeInvites: countScalar(
      db,
      `SELECT COUNT(*) AS count
       FROM invites
       WHERE revoked_at IS NULL
         AND expires_at > ?
         AND used_count < max_uses`,
      now,
    ),
    auditEvents: countScalar(
      db,
      "SELECT COUNT(*) AS count FROM (SELECT 1 FROM audit_log LIMIT 10000)",
    ),
    recentStreamErrors: countScalar(
      db,
      `SELECT COUNT(*) AS count
       FROM stream_sessions
       WHERE last_error IS NOT NULL
         AND created_at >= ?`,
      addSecondsISO(-60 * 60 * 24),
    ),
    passwordlessProfiles: countScalar(
      db,
      `SELECT COUNT(*) AS count
       FROM profiles
       WHERE disabled_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM profile_settings
           WHERE profile_settings.profile_id = profiles.id
             AND profile_settings.key = 'profile_password_hash'
         )`,
    ),
  };

  const warnings: string[] = [];
  if (!config.cookieSecure) {
    warnings.push("Secure cookies are disabled. Use HTTPS and DS_SERVER_COOKIE_SECURE=true before exposing outside a private network.");
  }
  if (config.allowRawStreamUrls) {
    warnings.push("Raw stream URL sessions are enabled. Keep this disabled for public deployments.");
  }
  if (!config.trustProxy) {
    warnings.push("Reverse-proxy trust is disabled. Enable DS_SERVER_TRUST_PROXY=true behind a trusted HTTPS proxy.");
  }
  if (config.webDistPath == null) {
    warnings.push("Hosted PWA assets are not configured; API-only mode is active.");
  }
  if (config.publicMode && counts.passwordlessProfiles > 0) {
    warnings.push(`${counts.passwordlessProfiles} active viewer profile(s) do not have a password. Public mode requires every profile to be protected.`);
  }

  return {
    ok: true,
    serverTime: now,
    setupRequired: userCount(db) === 0,
    counts,
    config: {
      cookieSecure: config.cookieSecure,
      cookieSameSite: config.cookieSameSite,
      trustProxy: config.trustProxy,
      corsConfigured: config.corsOrigin != null && config.corsOrigin.trim().length > 0,
      rawStreamUrlsEnabled: config.allowRawStreamUrls,
      webDistConfigured: config.webDistPath != null,
      sessionTtlSeconds: config.sessionTtlSeconds,
      bindSessionUserAgent: config.bindSessionUserAgent,
      publicMode: config.publicMode,
      setupTokenRequired: userCount(db) === 0 && config.setupToken != null,
    },
    warnings,
  };
}

function setupTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided == null) return false;
  const expectedDigest = Buffer.from(sha256(expected), "hex");
  const providedDigest = Buffer.from(sha256(provided), "hex");
  return (
    expectedDigest.length === providedDigest.length &&
    timingSafeEqual(expectedDigest, providedDigest)
  );
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/g, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) % 1_000_000;
  return String(value).padStart(6, "0");
}

function verifyTotp(secret: string, provided: string, now = Date.now()): boolean {
  const providedBuffer = Buffer.from(provided);
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totpCode(secret, now + offset));
    if (
      expected.length === providedBuffer.length &&
      timingSafeEqual(expected, providedBuffer)
    ) return true;
  }
  return false;
}

interface LoginFailureState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

function loginFailureKey(request: FastifyRequest, username: string): string {
  return `${request.ip}:${username.trim().toLowerCase()}`;
}

function nextLoginBackoffMs(failures: number): number {
  if (failures < 5) return 0;
  return Math.min(15 * 60_000, 2_000 * 2 ** Math.min(9, failures - 5));
}

let releaseCache:
  | { expiresAt: number; value: { currentVersion: string; latestVersion: string | null; available: boolean; url: string } }
  | null = null;

function versionParts(version: string): number[] {
  return version.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
}

function newerVersion(latest: string, current: string): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return false;
}

async function serverUpdateStatus(enabled: boolean) {
  const url = "https://github.com/Tgk-30/YAWF-Stream/releases/latest";
  if (!enabled) {
    return { currentVersion: SERVER_VERSION, latestVersion: null, available: false, url };
  }
  if (releaseCache != null && releaseCache.expiresAt > Date.now()) return releaseCache.value;
  let latestVersion: string | null = null;
  try {
    const response = await fetch(
      "https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/latest",
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "YAWF-Stream-Server" },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (response.ok) {
      const body = await response.json() as { tag_name?: unknown };
      if (typeof body.tag_name === "string") latestVersion = body.tag_name.replace(/^v/, "").replace(/-web$/, "");
    }
  } catch {
    latestVersion = null;
  }
  const value = {
    currentVersion: SERVER_VERSION,
    latestVersion,
    available: latestVersion != null && newerVersion(latestVersion, SERVER_VERSION),
    url,
  };
  releaseCache = { expiresAt: Date.now() + 6 * 60 * 60_000, value };
  return value;
}

function streamContentType(fileName: string): string | null {
  const ext = extname(fileName.toLowerCase());
  return MIME_TYPES[ext] ?? null;
}

function registerRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  config: ServerConfig,
  transcode: {
    ready: boolean;
    toneMappingAvailable: boolean;
    subtitleSidecarAvailable: boolean;
    availableVideoEncoders: ServerConfig["transcodeVideoEncoder"][];
    registry: TranscodeRegistry;
  },
): void {
  const rateLimit = createRateLimiter();
  const loginFailures = new Map<string, LoginFailureState>();
  const remoteControls = new RemoteControlRegistry();

  const readRemoteToken = (request: FastifyRequest): string | null => {
    const raw = request.headers["x-yawf-remote-token"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value.length <= 256 ? value : null;
  };

  app.get("/api/health", async () => ({
    ok: true,
    setupRequired: userCount(db) === 0,
    setupTokenRequired: userCount(db) === 0 && config.setupToken != null,
  }));

  app.get("/api/bootstrap", async (request) => {
    const auth = readAuth(db, request);
    return {
      setupRequired: userCount(db) === 0,
      setupTokenRequired: userCount(db) === 0 && config.setupToken != null,
      session: auth,
      // The account's household profiles + the active one, so the client can
      // render the "who's watching" picker on load without a second request.
      // Null when unauthenticated.
      profiles: auth != null ? accountProfileState(db, auth) : null,
      // Echo the CSRF token from the cookie so a cross-origin client (which can't
      // read document.cookie) can attach it as the x-csrf-token header on
      // mutating requests after a reload. Null when unauthenticated.
      csrfToken: auth != null ? (request.cookies?.[CSRF_COOKIE] ?? null) : null,
      // Whether server-side transcoding is actually usable (operator flag on AND
      // ffmpeg present at boot), so the client only offers it when it'll work.
      transcodeAvailable: transcode.ready,
      transcodeCapabilities: {
        adaptive: transcode.ready,
        seekOffset: transcode.ready,
        subtitleSidecar:
          transcode.ready && transcode.subtitleSidecarAvailable,
        hardwareEncoder: config.transcodeVideoEncoder,
        availableVideoEncoders: transcode.ready
          ? transcode.availableVideoEncoders
          : [],
        toneMapping: transcode.ready && transcode.toneMappingAvailable,
      },
      // Whether the server can supply OMDb ratings for this profile (a profile,
      // server, or env OMDb key is configured). The key itself is never sent - 
      // the client only learns that the /api/omdb proxy will return ratings.
      omdbProxy: auth != null && omdbAvailableFor(db, config, auth.profileId),
      // Distribution tier - drives which onboarding flow the client shows.
      buildProfile: config.buildProfile,
    };
  });

  // TV-browser and phone remote. The TV's authenticated profile owns the
  // ephemeral viewer session. A six-digit, single-use code grants one
  // controller a separate random token, so a household member cannot discover
  // or control another screen merely by enumerating session IDs. No stream URL,
  // account cookie, provider credential, or title history is copied into the
  // pairing token.
  app.post("/api/remote/sessions", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `remote:create:${auth.profileId}`, 12, 60 * 60_000);
    const session = remoteControls.create(auth.profileId);
    audit(db, auth, "remote.session.create", "remote_session", session.id);
    return { session };
  });

  app.post("/api/remote/pair", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `remote:pair:${auth.profileId}`, 20, 15 * 60_000);
    const body = parseBody(remotePairSchema, request.body);
    const session = remoteControls.pair(
      body.code,
      body.controllerName?.trim() || null,
    );
    if (session == null) {
      throw httpError(404, "Pairing code is invalid or expired.");
    }
    audit(db, auth, "remote.session.pair", "remote_session", session.id);
    return { session };
  });

  app.get("/api/remote/sessions/:id", async (request) => {
    const auth = requireAuth(db, request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    const query = parseBody(remoteViewerQuerySchema, request.query);
    const session = remoteControls.viewerSnapshot(id, auth.profileId, query.after);
    if (session == null) throw httpError(404, "Remote session not found.");
    return { session };
  });

  app.put("/api/remote/sessions/:id/state", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    const body = parseBody(remoteStateSchema, request.body);
    const state = remoteControls.updateState(id, auth.profileId, body);
    if (state == null) throw httpError(404, "Remote session not found.");
    return { state };
  });

  app.get("/api/remote/sessions/:id/controller", async (request) => {
    requireAuth(db, request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    const token = readRemoteToken(request);
    const session =
      token == null ? null : remoteControls.controllerSnapshot(id, token);
    if (session == null) throw httpError(404, "Remote session not found.");
    return { session };
  });

  app.post("/api/remote/sessions/:id/commands", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `remote:command:${auth.profileId}`, 600, 60_000);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    const token = readRemoteToken(request);
    const body = parseBody(remoteCommandSchema, request.body);
    const command =
      token == null ? null : remoteControls.enqueue(id, token, body);
    if (command == null) throw httpError(404, "Remote session not found.");
    return { command };
  });

  app.delete("/api/remote/sessions/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    if (!remoteControls.remove(id, auth.profileId)) {
      throw httpError(404, "Remote session not found.");
    }
    audit(db, auth, "remote.session.revoke", "remote_session", id);
    return { ok: true };
  });

  app.get("/api/admin/health", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    return {
      ...adminHealthSummary(db, config),
      transcode: {
        enabled: config.enableTranscode,
        ready: transcode.ready,
        configuredEncoder: config.transcodeVideoEncoder,
        activeEncoder: transcode.ready ? config.transcodeVideoEncoder : null,
        availableVideoEncoders: transcode.ready
          ? transcode.availableVideoEncoders
          : [],
        adaptive: transcode.ready,
        seekOffset: transcode.ready,
        subtitleSidecar:
          transcode.ready && transcode.subtitleSidecarAvailable,
        toneMapping: transcode.ready && transcode.toneMappingAvailable,
      },
      update: await serverUpdateStatus(config.updateCheck),
    };
  });

  app.post("/api/auth/setup-owner", async (request, reply) => {
    const body = parseBody(setupOwnerSchema, request.body);
    rateLimit(request, "auth:setup-owner", 5, 15 * 60 * 1000);
    if (userCount(db) > 0) throw httpError(409, "Owner account already exists.");
    if (config.setupToken != null && !setupTokenMatches(config.setupToken, body.setupToken)) {
      throw httpError(403, "Invalid setup token.");
    }
    const passwordHash = await hashPassword(body.password);

    const created = db.transaction(() => {
      // Authoritative re-check INSIDE the write transaction (BEGIN IMMEDIATE
      // serializes writers), so two concurrent first-run calls that both passed
      // the pre-hash check above can't both create an owner.
      if (userCount(db) > 0) throw httpError(409, "Owner account already exists.");
      const ids = createUserAndProfile(db, {
        username: body.username,
        displayName: body.displayName,
        passwordHash,
        profilePasswordHash: config.publicMode ? passwordHash : undefined,
        role: "owner",
        simpleMode: false,
      });
      audit(db, { userId: ids.userId, profileId: ids.profileId }, "auth.setup_owner", "user", ids.userId);
      return ids;
    });

    const session = createSession(db, config, created.userId, request);
    setSessionCookies(reply, config, session);
    return {
      user: {
        id: created.userId,
        username: body.username,
        displayName: body.displayName,
        role: "owner",
      },
      profile: {
        id: created.profileId,
        displayName: body.displayName,
      },
      csrfToken: session.csrfToken,
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = parseBody(loginSchema, request.body);
    // Per-IP limit across ALL usernames (throttles credential spraying), in
    // addition to the per-(username,IP) limit below for targeted brute force.
    rateLimit(request, "auth:login-ip", 30, 15 * 60 * 1000);
    rateLimit(
      request,
      `auth:login:${body.username.toLowerCase()}`,
      10,
      15 * 60 * 1000,
    );
    const failureKey = loginFailureKey(request, body.username);
    const failureState = loginFailures.get(failureKey);
    if (failureState != null && failureState.blockedUntil > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((failureState.blockedUntil - Date.now()) / 1_000));
      reply.header("retry-after", String(retryAfter));
      audit(db, null, "auth.login.blocked", "user", undefined, {
        attemptedUsername: body.username.toLowerCase(),
        ipHash: hashOptional(request.ip),
        retryAfterSeconds: retryAfter,
      });
      throw httpError(429, "Too many failed login attempts. Try again later.");
    }
    const row = db.sqlite
      .prepare(
        `SELECT id, username, display_name, password_hash, role,
                totp_secret_encrypted, totp_enabled
         FROM users
         WHERE username = ? AND disabled_at IS NULL`,
      )
      .get(body.username) as
      | {
          id: string;
          username: string;
          display_name: string;
          password_hash: string;
          role: UserRole;
          totp_secret_encrypted: string | null;
          totp_enabled: number;
        }
      | undefined;

    const recordFailure = (reason: "credentials" | "totp") => {
      const now = Date.now();
      if (loginFailures.size >= 5_000) {
        for (const [key, state] of loginFailures) {
          if (now - state.lastFailureAt > 60 * 60_000) loginFailures.delete(key);
        }
        if (loginFailures.size >= 5_000) {
          const oldest = [...loginFailures.entries()]
            .sort((left, right) => left[1].lastFailureAt - right[1].lastFailureAt)
            .slice(0, 500);
          for (const [key] of oldest) loginFailures.delete(key);
        }
      }
      const previous = loginFailures.get(failureKey);
      const failures = previous != null && now - previous.lastFailureAt < 60 * 60_000
        ? previous.failures + 1
        : 1;
      const blockedUntil = now + nextLoginBackoffMs(failures);
      loginFailures.set(failureKey, { failures, lastFailureAt: now, blockedUntil });
      audit(db, null, "auth.login.failed", "user", row?.id, {
        attemptedUsername: body.username.toLowerCase(),
        ipHash: hashOptional(request.ip),
        reason,
        failures,
        blockedUntil: blockedUntil > now ? new Date(blockedUntil).toISOString() : null,
      });
    };

    if (row == null) {
      // Run a dummy verify so an unknown username takes the same time as a known
      // one - otherwise response timing reveals which usernames exist.
      await verifyDummyPassword(body.password);
      recordFailure("credentials");
      throw httpError(401, "Invalid username or password.");
    }
    if (!(await verifyPassword(row.password_hash, body.password))) {
      recordFailure("credentials");
      throw httpError(401, "Invalid username or password.");
    }
    if (row.totp_enabled === 1) {
      const secret = row.totp_secret_encrypted == null
        ? null
        : decryptSecret(row.totp_secret_encrypted, config.secretKey);
      if (secret == null || body.totpCode == null || !verifyTotp(secret, body.totpCode)) {
        recordFailure("totp");
        throw httpError(401, body.totpCode == null ? "Two-factor code required." : "Invalid two-factor code.");
      }
    }
    loginFailures.delete(failureKey);

    const profile = db.sqlite
      .prepare(
        `SELECT id, display_name
         FROM profiles
         WHERE user_id = ? AND is_default = 1 AND disabled_at IS NULL
         LIMIT 1`,
      )
      .get(row.id) as { id: string; display_name: string } | undefined;
    if (profile == null) throw httpError(403, "Profile is disabled.");

    const session = createSession(db, config, row.id, request);
    audit(db, { userId: row.id, profileId: profile.id }, "auth.login", "user", row.id);
    setSessionCookies(reply, config, session);
    return {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
      },
      profile: {
        id: profile.id,
        displayName: profile.display_name,
      },
      csrfToken: session.csrfToken,
    };
  });

  app.post("/api/auth/invite", async (request, reply) => {
    const body = parseBody(acceptInviteSchema, request.body);
    // IP-wide throttle (mirrors auth:login-ip) so rotating invite tokens can't
    // spray this pre-auth endpoint or balloon the per-token bucket map.
    rateLimit(request, "auth:invite-ip", 30, 15 * 60 * 1000);
    rateLimit(request, `auth:invite:${sha256(body.token)}`, 8, 15 * 60 * 1000);
    if (userCount(db) === 0) throw httpError(409, "Create the owner account first.");
    const tokenHash = sha256(body.token);
    const invite = db.sqlite
      .prepare(
        `SELECT id, role, simple_mode, max_uses, used_count, expires_at, revoked_at
         FROM invites
         WHERE token_hash = ?
         LIMIT 1`,
      )
      .get(tokenHash) as
      | {
          id: string;
          role: Exclude<UserRole, "owner">;
          simple_mode: number;
          max_uses: number;
          used_count: number;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (invite == null) throw httpError(404, "Invite not found.");
    if (invite.revoked_at != null) throw httpError(410, "Invite has been revoked.");
    if (invite.used_count >= invite.max_uses) throw httpError(410, "Invite has already been used.");
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw httpError(410, "Invite has expired.");
    }

    const passwordHash = await hashPassword(body.password);
    const created = db.transaction(() => {
      const fresh = db.sqlite
        .prepare(
          `SELECT used_count, max_uses, revoked_at, expires_at
           FROM invites
           WHERE id = ?
           LIMIT 1`,
        )
        .get(invite.id) as
        | {
            used_count: number;
            max_uses: number;
            revoked_at: string | null;
            expires_at: string;
          }
        | undefined;
      if (
        fresh == null ||
        fresh.revoked_at != null ||
        fresh.used_count >= fresh.max_uses ||
        new Date(fresh.expires_at).getTime() <= Date.now()
      ) {
        throw httpError(410, "Invite is no longer available.");
      }
      const userProfile = createUserAndProfile(db, {
        username: body.username,
        displayName: body.displayName ?? body.username,
        passwordHash,
        profilePasswordHash: config.publicMode ? passwordHash : undefined,
        role: invite.role,
        simpleMode: invite.simple_mode === 1,
      });
      db.sqlite
        .prepare("UPDATE invites SET used_count = used_count + 1 WHERE id = ?")
        .run(invite.id);
      return userProfile;
    });

    const session = createSession(db, config, created.userId, request);
    audit(db, created, "auth.invite.accept", "invite", invite.id);
    setSessionCookies(reply, config, session);
    return {
      user: {
        id: created.userId,
        username: body.username,
        displayName: body.displayName ?? body.username,
        role: invite.role,
      },
      profile: {
        id: created.profileId,
        displayName: body.displayName ?? body.username,
      },
      csrfToken: session.csrfToken,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const cookieValue = readSessionCookie(request);
    if (cookieValue != null) {
      requireCsrf(request);
      db.sqlite
        .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND token_hash = ?")
        .run(nowISO(), cookieValue.sessionId, sha256(cookieValue.rawToken));
    }
    clearSessionCookies(reply, config);
    return { ok: true };
  });

  app.get("/api/auth/session", async (request) => {
    const auth = requireAuth(db, request);
    return { session: auth, profiles: accountProfileState(db, auth) };
  });

  app.get("/api/auth/totp", async (request) => {
    const auth = requireAuth(db, request);
    if (!isAdmin(auth.role)) throw httpError(403, "Two-factor authentication is available to owners and admins.");
    const row = db.sqlite
      .prepare("SELECT totp_enabled, totp_pending_secret_encrypted FROM users WHERE id = ?")
      .get(auth.userId) as { totp_enabled: number; totp_pending_secret_encrypted: string | null } | undefined;
    return { enabled: row?.totp_enabled === 1, enrollmentPending: row?.totp_pending_secret_encrypted != null };
  });

  app.post("/api/auth/totp/enroll", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const secret = base32Encode(randomBytes(20));
    db.sqlite
      .prepare("UPDATE users SET totp_pending_secret_encrypted = ? WHERE id = ?")
      .run(encryptSecret(secret, config.secretKey), auth.userId);
    audit(db, auth, "auth.totp.enroll", "user", auth.userId);
    const label = encodeURIComponent(`YAWF Stream:${auth.username}`);
    const issuer = encodeURIComponent("YAWF Stream");
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    };
  });

  app.post("/api/auth/totp/confirm", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const body = parseBody(z.object({ code: totpCodeSchema }), request.body);
    const row = db.sqlite
      .prepare("SELECT totp_pending_secret_encrypted FROM users WHERE id = ?")
      .get(auth.userId) as { totp_pending_secret_encrypted: string | null } | undefined;
    if (row?.totp_pending_secret_encrypted == null) throw httpError(409, "Start two-factor enrollment first.");
    const secret = decryptSecret(row.totp_pending_secret_encrypted, config.secretKey);
    if (!verifyTotp(secret, body.code)) throw httpError(400, "Invalid authenticator code.");
    db.sqlite
      .prepare(
        `UPDATE users
         SET totp_secret_encrypted = totp_pending_secret_encrypted,
             totp_pending_secret_encrypted = NULL,
             totp_enabled = 1
         WHERE id = ?`,
      )
      .run(auth.userId);
    audit(db, auth, "auth.totp.enable", "user", auth.userId);
    return { ok: true, enabled: true };
  });

  app.post("/api/auth/totp/disable", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const body = parseBody(disableTotpSchema, request.body);
    const row = db.sqlite
      .prepare("SELECT password_hash, totp_secret_encrypted, totp_enabled FROM users WHERE id = ?")
      .get(auth.userId) as {
        password_hash: string;
        totp_secret_encrypted: string | null;
        totp_enabled: number;
      } | undefined;
    const passwordOk = row != null && await verifyPassword(row.password_hash, body.currentPassword);
    const secret = row?.totp_secret_encrypted == null
      ? null
      : decryptSecret(row.totp_secret_encrypted, config.secretKey);
    if (!passwordOk || secret == null || !verifyTotp(secret, body.code)) {
      throw httpError(401, "Password or authenticator code is incorrect.");
    }
    db.sqlite
      .prepare(
        `UPDATE users
         SET totp_secret_encrypted = NULL,
             totp_pending_secret_encrypted = NULL,
             totp_enabled = 0
         WHERE id = ?`,
      )
      .run(auth.userId);
    audit(db, auth, "auth.totp.disable", "user", auth.userId);
    return { ok: true, enabled: false };
  });

  app.get("/api/auth/sessions", async (request) => {
    const auth = requireAuth(db, request);
    const rows = db.sqlite
      .prepare(
        `SELECT id, user_agent, ip_hash, created_at, expires_at, revoked_at
         FROM sessions
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all(auth.userId) as Array<Parameters<typeof mapSessionRow>[0]>;
    return {
      sessions: rows.map((row) => mapSessionRow(row, auth.sessionId)),
    };
  });

  app.delete("/api/auth/sessions/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    db.sqlite
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE id = ?
           AND user_id = ?
           AND revoked_at IS NULL`,
      )
      .run(nowISO(), id, auth.userId);
    audit(db, auth, "auth.session.revoke", "session", id, {
      current: id === auth.sessionId,
    });
    return { ok: true };
  });

  app.post("/api/auth/sessions/revoke-all", async (request, reply) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(revokeAllSessionsSchema, request.body ?? {});
    const now = nowISO();
    const result = body.includeCurrent
      ? db.sqlite
          .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .run(now, auth.userId)
      : db.sqlite
          .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL")
          .run(now, auth.userId, auth.sessionId);
    audit(db, auth, "auth.session.revoke_all", "user", auth.userId, {
      includeCurrent: body.includeCurrent,
      revoked: result.changes,
    });
    if (body.includeCurrent) clearSessionCookies(reply, config);
    return { ok: true, revoked: result.changes };
  });

  app.post("/api/auth/change-password", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(changePasswordSchema, request.body);
    const row = db.sqlite
      .prepare("SELECT password_hash FROM users WHERE id = ? LIMIT 1")
      .get(auth.userId) as { password_hash: string } | undefined;
    if (row == null || !(await verifyPassword(row.password_hash, body.currentPassword))) {
      throw httpError(401, "Current password is incorrect.");
    }
    const nextHash = await hashPassword(body.newPassword);
    const now = nowISO();
    db.transaction(() => {
      db.sqlite
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(nextHash, auth.userId);
      db.sqlite
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?
           WHERE user_id = ?
             AND id <> ?
             AND revoked_at IS NULL`,
        )
        .run(now, auth.userId, auth.sessionId);
      audit(db, auth, "auth.password.change", "user", auth.userId);
    });
    return { ok: true };
  });

  app.get("/api/settings/profile", async (request) => {
    const auth = requireAuth(db, request);
    const rows = db.sqlite
      .prepare(
        `SELECT key, value
         FROM profile_settings
         WHERE profile_id = ?
         ORDER BY key ASC`,
      )
      .all(auth.profileId) as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) {
      if (PROTECTED_PROFILE_SETTING_KEYS.has(row.key)) continue;
      settings[row.key] = row.value;
    }
    return { settings };
  });

  app.put("/api/settings/profile", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(profileSettingSchema, request.body);
    // Don't let the generic settings surface read OR clobber server-managed
    // protected keys (e.g. the write-only sub-profile password hash).
    if (PROTECTED_PROFILE_SETTING_KEYS.has(body.key)) {
      throw httpError(403, "This setting cannot be modified.");
    }
    if (body.value == null) {
      db.sqlite
        .prepare("DELETE FROM profile_settings WHERE profile_id = ? AND key = ?")
        .run(auth.profileId, body.key);
    } else {
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, ?, ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(auth.profileId, body.key, body.value);
    }
    audit(db, auth, "settings.profile.set", "setting", body.key);
    return { ok: true };
  });

  app.get("/api/profiles", async (request) => {
    const auth = requireAuth(db, request);
    if (!isAdmin(auth.role)) {
      return {
        profiles: [
          {
            id: auth.profileId,
            displayName: auth.displayName,
            role: auth.role,
            self: true,
          },
        ],
      };
    }

    const rows = db.sqlite
      .prepare(
        `SELECT profiles.id,
                profiles.display_name,
                profiles.simple_mode,
                profiles.disabled_at,
                users.username,
                users.role,
                users.disabled_at AS user_disabled_at
         FROM profiles
         JOIN users ON users.id = profiles.user_id
         ORDER BY users.created_at ASC`,
      )
      .all() as Array<{
      id: string;
      display_name: string;
      simple_mode: number;
      disabled_at: string | null;
      username: string;
      role: UserRole;
      user_disabled_at: string | null;
    }>;
    return {
      profiles: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        simpleMode: row.simple_mode === 1,
        disabled: row.disabled_at != null || row.user_disabled_at != null,
      })),
    };
  });

  app.post("/api/profiles", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const body = parseBody(createProfileSchema, request.body);
    if (auth.role !== "owner" && body.role === "admin") {
      throw httpError(403, "Only the owner can create admin profiles.");
    }
    const passwordHash = await hashPassword(body.password);
    const ids = db.transaction(() => {
      const created = createUserAndProfile(db, {
        username: body.username,
        displayName: body.displayName,
        passwordHash,
        profilePasswordHash: config.publicMode ? passwordHash : undefined,
        role: body.role,
        simpleMode: body.simpleMode,
      });
      audit(db, auth, "profile.create", "profile", created.profileId, {
        username: body.username,
        role: body.role,
      });
      return created;
    });
    return {
      profile: {
        id: ids.profileId,
        username: body.username,
        displayName: body.displayName,
        role: body.role,
        simpleMode: body.simpleMode,
      },
    };
  });

  app.patch("/api/profiles/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireNotRestricted(auth);
    requireCsrf(request);
    const id = (request.params as { id: string }).id;
    if (auth.profileId !== id && !isAdmin(auth.role)) {
      throw httpError(403, "Cannot edit another profile.");
    }
    const body = parseBody(patchProfileSchema, request.body);
    const existing = db.sqlite
      .prepare(
        `SELECT profiles.id, profiles.user_id, users.role
         FROM profiles JOIN users ON users.id = profiles.user_id
         WHERE profiles.id = ?`,
      )
      .get(id) as { id: string; user_id: string; role: UserRole } | undefined;
    if (existing == null) throw httpError(404, "Profile not found.");

    const now = nowISO();
    if (body.displayName != null) {
      db.sqlite
        .prepare("UPDATE profiles SET display_name = ?, updated_at = ? WHERE id = ?")
        .run(body.displayName, now, id);
      db.sqlite
        .prepare("UPDATE users SET display_name = ? WHERE id = ?")
        .run(body.displayName, existing.user_id);
    }
    if (body.simpleMode != null) {
      db.sqlite
        .prepare("UPDATE profiles SET simple_mode = ?, updated_at = ? WHERE id = ?")
        .run(body.simpleMode ? 1 : 0, now, id);
    }
    if (body.disabled != null) {
      requireAdmin(auth);
      if (existing.role === "owner") throw httpError(400, "Owner profile cannot be disabled.");
      const disabledAt = body.disabled ? now : null;
      db.sqlite
        .prepare("UPDATE profiles SET disabled_at = ?, updated_at = ? WHERE id = ?")
        .run(disabledAt, now, id);
      db.sqlite
        .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
        .run(disabledAt, existing.user_id);
    }
    audit(db, auth, "profile.update", "profile", id);
    return { ok: true };
  });

  // Promote or demote an account's role. This is the one management action that
  // was previously fixed at create/invite time. Guards: admin-only; only the
  // owner may grant or revoke the owner/admin tier (mirrors profile creation);
  // you cannot change your own role; and the household's last owner cannot be
  // demoted (which would strand everyone with no one able to manage admins).
  app.post("/api/profiles/:id/role", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = (request.params as { id: string }).id;
    const body = parseBody(setRoleSchema, request.body);

    const existing = db.sqlite
      .prepare(
        `SELECT profiles.id, profiles.user_id, users.role
         FROM profiles JOIN users ON users.id = profiles.user_id
         WHERE profiles.id = ?`,
      )
      .get(id) as { id: string; user_id: string; role: UserRole } | undefined;
    if (existing == null) throw httpError(404, "Profile not found.");

    // Only the owner may touch the privileged tier, on either side of the change
    // (you cannot demote an admin, nor mint one, unless you are the owner).
    const touchesAdminTier = (r: UserRole) => r === "owner" || r === "admin";
    if (auth.role !== "owner" && (touchesAdminTier(existing.role) || touchesAdminTier(body.role))) {
      throw httpError(403, "Only the owner can change owner or admin roles.");
    }
    // Never let an account change its own role (self-lockout / self-promotion).
    // Compared by user id: one account can own several household profiles.
    if (existing.user_id === auth.userId) {
      throw httpError(400, "You cannot change your own role.");
    }
    // Keep at least one active owner, always.
    if (existing.role === "owner" && body.role !== "owner") {
      const owners = countScalar(
        db,
        "SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND disabled_at IS NULL",
      );
      if (owners <= 1) throw httpError(400, "The last owner cannot be demoted.");
    }

    if (existing.role === body.role) return { ok: true, role: body.role };
    db.sqlite.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, existing.user_id);
    audit(db, auth, "profile.role.update", "profile", id, {
      from: existing.role,
      to: body.role,
    });
    return { ok: true, role: body.role };
  });

  app.delete("/api/profiles/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = (request.params as { id: string }).id;
    const row = db.sqlite
      .prepare(
        `SELECT profiles.user_id, users.role
         FROM profiles JOIN users ON users.id = profiles.user_id
         WHERE profiles.id = ?`,
      )
      .get(id) as { user_id: string; role: UserRole } | undefined;
    if (row == null) throw httpError(404, "Profile not found.");
    if (row.role === "owner") throw httpError(400, "Owner profile cannot be disabled.");
    const now = nowISO();
    db.sqlite.prepare("UPDATE profiles SET disabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    db.sqlite.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, row.user_id);
    audit(db, auth, "profile.disable", "profile", id);
    return { ok: true };
  });

  // ---- Household sub-profiles ("who's watching") --------------------------
  // These manage VIEWER profiles WITHIN the current account and are the surface
  // the picker drives. They are intentionally separate from the /api/profiles/*
  // routes above, which manage other ACCOUNTS (admin/owner only). Everything
  // here is account-scoped: a user can only ever see/mutate/switch to a profile
  // whose user_id is their own, so cross-account access is impossible (IDOR-safe
  // by the WHERE user_id = auth.userId guard on every read and write).

  /** Owns + lives under this account? (guards every mutate/switch path). */
  function ownedLiveProfile(
    userId: string,
    profileId: string,
  ): { id: string; is_default: number } | null {
    return (
      (db.sqlite
        .prepare(
          `SELECT id, is_default
           FROM profiles
           WHERE id = ? AND user_id = ? AND disabled_at IS NULL
           LIMIT 1`,
        )
        .get(profileId, userId) as { id: string; is_default: number } | undefined) ?? null
    );
  }

  app.get("/api/account/profiles", async (request) => {
    const auth = requireAuth(db, request);
    return { ...accountProfileState(db, auth), publicMode: config.publicMode };
  });

  app.post("/api/account/profiles", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    requireNotRestricted(auth);
    const body = parseBody(createAccountProfileSchema, request.body);
    if (config.publicMode && body.password == null) {
      throw httpError(400, "Public mode requires a password for every viewer profile.");
    }
    const passwordHash = body.password != null ? await hashPassword(body.password) : null;

    const created = db.transaction(() => {
      // Cap the number of profiles per account (defense-in-depth against a
      // runaway client filling the picker). 12 is generous for a household.
      const count = countScalar(
        db,
        "SELECT COUNT(*) AS count FROM profiles WHERE user_id = ? AND disabled_at IS NULL",
        auth.userId,
      );
      if (count >= 12) throw httpError(409, "Profile limit reached for this account.");
      const profileId = randomId("profile");
      const now = nowISO();
      db.sqlite
        .prepare(
          `INSERT INTO profiles
           (id, user_id, display_name, avatar_color, simple_mode, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          profileId,
          auth.userId,
          body.displayName,
          body.avatarColor ?? null,
          body.simpleMode ? 1 : 0,
          now,
          now,
        );
      // Park the optional password on profile_settings (write-only, hashed) so
      // it is available if per-profile PINs are wired up later, without adding a
      // column. No-op when absent.
      if (passwordHash != null) {
        db.sqlite
          .prepare(
            `INSERT INTO profile_settings (profile_id, key, value)
             VALUES (?, 'profile_password_hash', ?)
             ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
          )
          .run(profileId, passwordHash);
        db.sqlite
          .prepare(
            `INSERT INTO profile_settings (profile_id, key, value)
             VALUES (?, 'profile_gate_kind', 'password')
             ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
          )
          .run(profileId);
      }
      audit(db, auth, "account.profile.create", "profile", profileId, {
        displayName: body.displayName,
      });
      return profileId;
    });

    return {
      profile: {
        id: created,
        displayName: body.displayName,
        avatarColor: body.avatarColor ?? null,
        simpleMode: body.simpleMode,
        isDefault: false,
        isKid: false,
        maturityMax: null,
        hasPin: passwordHash != null,
        gateType: passwordHash != null ? "password" : "none",
      },
    };
  });

  app.patch("/api/account/profiles/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    requireNotRestricted(auth);
    const id = accountProfileIdParamSchema.parse((request.params as { id: string }).id);
    const body = parseBody(patchAccountProfileSchema, request.body);
    // Ownership check makes rename/recolor IDOR-safe - another account's id 404s.
    if (ownedLiveProfile(auth.userId, id) == null) {
      throw httpError(404, "Profile not found.");
    }
    const now = nowISO();
    if (body.displayName !== undefined) {
      db.sqlite
        .prepare("UPDATE profiles SET display_name = ?, updated_at = ? WHERE id = ?")
        .run(body.displayName, now, id);
    }
    if (body.avatarColor !== undefined) {
      db.sqlite
        .prepare("UPDATE profiles SET avatar_color = ?, updated_at = ? WHERE id = ?")
        .run(body.avatarColor ?? null, now, id);
    }
    if (body.simpleMode !== undefined) {
      db.sqlite
        .prepare("UPDATE profiles SET simple_mode = ?, updated_at = ? WHERE id = ?")
        .run(body.simpleMode ? 1 : 0, now, id);
    }
    audit(db, auth, "account.profile.update", "profile", id);
    return { ok: true, profiles: listAccountProfiles(db, auth.userId) };
  });

  // Kid/maturity gating is set HERE, behind requireAdmin - deliberately NOT on
  // the PATCH route above (which is requireNotRestricted), so a kid can never
  // lift their own cap by editing their profile. Household-scoped via
  // ownedLiveProfile. Setting both fields together keeps the play-block
  // (maturity_max) and the curated-browse lockdown (is_kid) consistent.
  app.post("/api/account/profiles/:id/maturity", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    requireAdmin(auth);
    const id = accountProfileIdParamSchema.parse((request.params as { id: string }).id);
    const body = parseBody(maturitySettingsSchema, request.body);
    if (ownedLiveProfile(auth.userId, id) == null) {
      throw httpError(404, "Profile not found.");
    }
    db.sqlite
      .prepare(
        "UPDATE profiles SET is_kid = ?, maturity_max = ?, updated_at = ? WHERE id = ?",
      )
      .run(body.isKid ? 1 : 0, body.maturityMax, nowISO(), id);
    audit(db, auth, "account.profile.maturity", "profile", id, {
      isKid: body.isKid,
      maturityMax: body.maturityMax,
    });
    return { ok: true, profiles: listAccountProfiles(db, auth.userId) };
  });

  app.delete("/api/account/profiles/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    requireNotRestricted(auth);
    const id = accountProfileIdParamSchema.parse((request.params as { id: string }).id);
    const target = ownedLiveProfile(auth.userId, id);
    if (target == null) throw httpError(404, "Profile not found.");
    // Never delete the default profile, and always keep at least one profile so
    // the account is never left with nothing to switch to.
    if (target.is_default === 1) {
      throw httpError(400, "The default profile cannot be deleted.");
    }
    const remaining = countScalar(
      db,
      "SELECT COUNT(*) AS count FROM profiles WHERE user_id = ? AND disabled_at IS NULL",
      auth.userId,
    );
    if (remaining <= 1) throw httpError(400, "An account needs at least one profile.");

    db.transaction(() => {
      // Audit BEFORE the delete: the actor's active profile may BE the one being
      // removed (you can delete the profile you're currently watching as), and
      // audit_log.actor_profile_id FKs profiles(id) - inserting after the delete
      // would violate it. The target id is still captured in the row.
      audit(db, auth, "account.profile.delete", "profile", id);
      // Explicitly clear any session pointing at this profile. The
      // sessions.active_profile_id FK is declared ON DELETE SET NULL, but it was
      // added via ALTER TABLE ADD COLUMN and SQLite does not enforce that action
      // for ALTER-added columns - so without this the FK would BLOCK the delete.
      // Nulling here is correct regardless: those sessions transparently fall
      // back to the default profile on their next readAuth.
      db.sqlite
        .prepare("UPDATE sessions SET active_profile_id = NULL WHERE active_profile_id = ?")
        .run(id);
      // Hard delete: ON DELETE CASCADE clears this profile's watchlist/history/
      // library/settings rows.
      db.sqlite.prepare("DELETE FROM profiles WHERE id = ?").run(id);
    });
    return { ok: true, profiles: listAccountProfiles(db, auth.userId) };
  });

  app.post("/api/profiles/switch", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(switchProfileSchema, request.body);
    // Ownership check is the IDOR gate: a profile that isn't this account's (or
    // is disabled) 404s, so a session can never be pointed at someone else's
    // profile. On success the session's active pointer is updated and ALL
    // per-profile scoping (watchlist/history/library/settings) follows it on the
    // next readAuth.
    if (ownedLiveProfile(auth.userId, body.profileId) == null) {
      throw httpError(404, "Profile not found.");
    }
    // Parental lock: profile-switching is otherwise credential-free, so without
    // this a kid could simply switch back to an uncapped adult profile and shed
    // the entire maturity lockdown. LEAVING a kid profile (switching to any other
    // profile) requires the ACCOUNT password. Entering a kid profile, and no-op
    // re-selects of the same profile, stay free.
    let accountUnlocked = false;
    if (auth.isKid && body.profileId !== auth.profileId) {
      const row = db.sqlite
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(auth.userId) as { password_hash: string } | undefined;
      const ok =
        body.password != null &&
        row != null &&
        (await verifyPassword(row.password_hash, body.password));
      if (!ok) {
        // Rate-limit only FAILED unlocks (a successful parent shouldn't be
        // throttled for switching in/out), to slow brute force of the password.
        rateLimit(request, `profile:unlock:${auth.userId}`, 10, 60 * 1000);
        audit(db, auth, "account.profile.switch.locked", "profile", body.profileId);
        throw httpError(403, "The account password is required to leave a kid profile.");
      }
      accountUnlocked = true;
    }
    // Per-profile PIN: a household gate, NOT encryption. ENTERING a profile that
    // has a PIN requires it (a no-op re-select of the currently-active profile is
    // free - you already passed it, and re-locking yourself out mid-session helps
    // no one). Only FAILED attempts are rate-limited, to slow brute force. The
    // hash never leaves the server; the client learns only that a PIN exists.
    if (body.profileId !== auth.profileId) {
      const pinRow = db.sqlite
        .prepare(
          `SELECT value FROM profile_settings
           WHERE profile_id = ? AND key = 'profile_password_hash'`,
        )
        .get(body.profileId) as { value: string } | undefined;
      if (pinRow != null && !accountUnlocked) {
        const ok =
          body.password != null &&
          (await verifyPassword(pinRow.value, body.password));
        if (!ok) {
          rateLimit(request, `profile:pin:${body.profileId}`, 10, 60 * 1000);
          audit(db, auth, "account.profile.switch.locked", "profile", body.profileId);
          throw httpError(403, "This profile is password protected.");
        }
      }
    }
    db.sqlite
      .prepare("UPDATE sessions SET active_profile_id = ? WHERE id = ?")
      .run(body.profileId, auth.sessionId);
    audit(db, auth, "account.profile.switch", "profile", body.profileId);
    // Re-read so the response reflects the freshly-activated profile (display
    // name, simpleMode, avatar) for the client to hydrate against.
    const next = readAuth(db, request);
    return {
      session: next,
      profiles: next != null ? accountProfileState(db, next) : null,
    };
  });

  // Set or clear a profile's household PIN. Owner/admin sets any owned profile's
  // PIN; a member sets only their own. The PIN gates switching INTO the profile
  // (see /api/profiles/switch). It is a household gate, not encryption - local
  // data is not encrypted at rest and the copy must not over-promise.
  app.post("/api/profiles/password", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(setProfilePasswordSchema, request.body);
    if (ownedLiveProfile(auth.userId, body.profileId) == null) {
      throw httpError(404, "Profile not found.");
    }
    const isSelf = body.profileId === auth.profileId;
    const isManager = auth.role === "owner" || auth.role === "admin";
    if (!isSelf && !isManager) {
      throw httpError(403, "You can only change your own profile password.");
    }
    const passwordHash = await hashPassword(body.password);
    db.transaction(() => {
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, 'profile_password_hash', ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(body.profileId, passwordHash);
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, 'profile_gate_kind', 'password')
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(body.profileId);
      audit(db, auth, "account.profile.password.set", "profile", body.profileId);
    });
    return { profiles: accountProfileState(db, auth) };
  });

  app.post("/api/profiles/pin", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(setProfilePinSchema, request.body);
    // Ownership IDOR gate, same as switch: a profile that isn't this account's
    // (or is disabled) 404s.
    if (ownedLiveProfile(auth.userId, body.profileId) == null) {
      throw httpError(404, "Profile not found.");
    }
    // A member may only manage their OWN profile's PIN; owner/admin may manage
    // any profile in the account (so a parent can set/reset a member's PIN).
    const isSelf = body.profileId === auth.profileId;
    const isManager = auth.role === "owner" || auth.role === "admin";
    if (!isSelf && !isManager) {
      throw httpError(403, "You can only change your own profile PIN.");
    }
    if (body.pin == null) {
      if (config.publicMode) {
        throw httpError(400, "Public mode does not allow passwordless viewer profiles.");
      }
      db.sqlite
        .prepare(
          `DELETE FROM profile_settings
           WHERE profile_id = ? AND key = 'profile_password_hash'`,
        )
        .run(body.profileId);
      db.sqlite
        .prepare(
          `DELETE FROM profile_settings
           WHERE profile_id = ? AND key = 'profile_gate_kind'`,
        )
        .run(body.profileId);
      audit(db, auth, "account.profile.pin.clear", "profile", body.profileId);
    } else {
      const pinHash = await hashPassword(body.pin);
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, 'profile_password_hash', ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(body.profileId, pinHash);
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, 'profile_gate_kind', 'pin')
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(body.profileId);
      audit(db, auth, "account.profile.pin.set", "profile", body.profileId);
    }
    // Echo the refreshed picker so the client updates the lock affordance.
    return { profiles: accountProfileState(db, auth) };
  });

  // Set or clear a household viewer's rolling-month bandwidth advisory. This
  // is warn-only by design: do not add enforcement to stream creation or the
  // /api/stream proxy path. Playback must continue when a profile is over cap.
  app.post("/api/profiles/quota", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(setProfileBandwidthQuotaSchema, request.body);
    // Match the account-scoped ownership gate used by the PIN endpoint before
    // the role check, so another household's profile is never discoverable.
    if (ownedLiveProfile(auth.userId, body.profileId) == null) {
      throw httpError(404, "Profile not found.");
    }
    requireAdmin(auth);
    if (body.capBytes == null) {
      db.sqlite
        .prepare(
          `DELETE FROM profile_settings
           WHERE profile_id = ? AND key = ?`,
        )
        .run(body.profileId, BANDWIDTH_CAP_SETTING);
      audit(db, auth, "account.profile.quota.clear", "profile", body.profileId);
    } else {
      db.sqlite
        .prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, ?, ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(body.profileId, BANDWIDTH_CAP_SETTING, String(body.capBytes));
      audit(db, auth, "account.profile.quota.set", "profile", body.profileId, {
        capBytes: body.capBytes,
      });
    }
    return { profiles: accountProfileState(db, auth) };
  });

  app.get("/api/admin/invites", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    const rows = db.sqlite
      .prepare(
        `SELECT id, label, role, simple_mode, max_uses, used_count,
                created_at, expires_at, revoked_at
         FROM invites
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all() as Array<Parameters<typeof mapInviteRow>[0]>;
    return { invites: rows.map(mapInviteRow) };
  });

  app.post("/api/admin/invites", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const body = parseBody(createInviteSchema, request.body);
    if (auth.role !== "owner" && body.role === "admin") {
      throw httpError(403, "Only the owner can create admin invites.");
    }
    const id = randomId("invite");
    const token = randomToken(32);
    const now = nowISO();
    const expiresAt = addSecondsISO(body.expiresInSeconds);
    db.sqlite
      .prepare(
        `INSERT INTO invites
         (id, token_hash, created_by_user_id, created_by_profile_id, label,
          role, simple_mode, max_uses, used_count, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        sha256(token),
        auth.userId,
        auth.profileId,
        body.label ?? null,
        body.role,
        body.simpleMode ? 1 : 0,
        body.maxUses,
        now,
        expiresAt,
      );
    const row = db.sqlite
      .prepare(
        `SELECT id, label, role, simple_mode, max_uses, used_count,
                created_at, expires_at, revoked_at
         FROM invites
         WHERE id = ?`,
      )
      .get(id) as Parameters<typeof mapInviteRow>[0];
    audit(db, auth, "invite.create", "invite", id, {
      role: body.role,
      maxUses: body.maxUses,
    });
    return {
      invite: mapInviteRow(row),
      token,
    };
  });

  app.post("/api/admin/invites/:id/reissue", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    rateLimit(request, `invite:reissue:${auth.userId}`, 20, 60 * 60_000);
    const sourceId = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse((request.params as { id: string }).id);
    const source = db.sqlite
      .prepare(
        `SELECT id, label, role, simple_mode, max_uses, used_count,
                created_at, expires_at, revoked_at
         FROM invites
         WHERE id = ?`,
      )
      .get(sourceId) as Parameters<typeof mapInviteRow>[0] | undefined;
    if (source == null) throw httpError(404, "Invite not found.");
    if (auth.role !== "owner" && source.role === "admin") {
      throw httpError(403, "Only the owner can reissue admin invites.");
    }

    const originalLifetimeSeconds = Math.round(
      (new Date(source.expires_at).getTime() -
        new Date(source.created_at).getTime()) /
        1000,
    );
    const lifetimeSeconds = Math.min(
      60 * 60 * 24 * 30,
      Math.max(60, originalLifetimeSeconds),
    );
    const replacementId = randomId("invite");
    const token = randomToken(32);
    const now = nowISO();
    const expiresAt = addSecondsISO(lifetimeSeconds);
    const replacement = db.transaction(() => {
      db.sqlite
        .prepare(
          "UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now, sourceId);
      db.sqlite
        .prepare(
          `INSERT INTO invites
           (id, token_hash, created_by_user_id, created_by_profile_id, label,
            role, simple_mode, max_uses, used_count, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          replacementId,
          sha256(token),
          auth.userId,
          auth.profileId,
          source.label,
          source.role,
          source.simple_mode,
          source.max_uses,
          now,
          expiresAt,
        );
      return db.sqlite
        .prepare(
          `SELECT id, label, role, simple_mode, max_uses, used_count,
                  created_at, expires_at, revoked_at
           FROM invites
           WHERE id = ?`,
        )
        .get(replacementId) as Parameters<typeof mapInviteRow>[0];
    });
    audit(db, auth, "invite.reissue", "invite", replacementId, {
      sourceInviteId: sourceId,
      role: source.role,
      maxUses: source.max_uses,
    });
    return { invite: mapInviteRow(replacement), token };
  });

  app.delete("/api/admin/invites/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse((request.params as { id: string }).id);
    db.sqlite
      .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowISO(), id);
    audit(db, auth, "invite.revoke", "invite", id);
    return { ok: true };
  });

  app.get("/api/admin/audit-log", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    const query = parseBody(auditLogQuerySchema, request.query);
    const rows = db.sqlite
      .prepare(
        `SELECT audit_log.id,
                audit_log.actor_user_id,
                audit_log.actor_profile_id,
                users.username AS actor_username,
                profiles.display_name AS actor_display_name,
                audit_log.action,
                audit_log.target_type,
                audit_log.target_id,
                audit_log.metadata_json,
                audit_log.created_at
         FROM audit_log
         LEFT JOIN users ON users.id = audit_log.actor_user_id
         LEFT JOIN profiles ON profiles.id = audit_log.actor_profile_id
         ORDER BY audit_log.created_at DESC
         LIMIT ?`,
      )
      .all(query.limit) as Array<Parameters<typeof mapAuditLogRow>[0]>;
    return { events: rows.map(mapAuditLogRow) };
  });

  app.get("/api/library/watchlist", async (request) => {
    const auth = requireAuth(db, request);
    const rows = db.sqlite
      .prepare(
        `SELECT media_id, added_at, preview_json
         FROM watchlist
         WHERE profile_id = ?
         ORDER BY added_at DESC`,
      )
      .all(auth.profileId) as Array<{
      media_id: string;
      added_at: string;
      preview_json: string;
    }>;
    return {
      items: rows.map((row) => ({
        mediaId: row.media_id,
        addedAt: row.added_at,
        preview: deserializePreview(row.preview_json),
      })),
    };
  });

  app.put("/api/library/watchlist/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    const body = parseBody(watchlistBodySchema, request.body);
    db.sqlite
      .prepare(
        `INSERT INTO watchlist (profile_id, media_id, added_at, preview_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, media_id)
         DO UPDATE SET preview_json = excluded.preview_json`,
      )
      .run(auth.profileId, mediaId, nowISO(), serializePreview(body.preview));
    audit(db, auth, "watchlist.upsert", "media", mediaId);
    return { ok: true };
  });

  // --- Phase 4: title requests + approve/deny queue (Server Mode) -------------

  // Any profile (incl. a kid/restricted) can request a title for the family.
  app.post("/api/library/requests", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(requestBodySchema, request.body);
    const id = randomId("request");
    try {
      db.sqlite
        .prepare(
          `INSERT INTO requests
           (id, requester_profile_id, media_id, preview_json, status, requested_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(id, auth.profileId, body.mediaId, serializePreview(body.preview), nowISO());
    } catch (err) {
      // The partial-unique index rejects a second LIVE pending request.
      if (String((err as { message?: string })?.message ?? "").toUpperCase().includes("UNIQUE")) {
        throw httpError(409, "You've already requested this title.");
      }
      throw err;
    }
    audit(db, auth, "request.create", "request", id, { mediaId: body.mediaId });
    const row = db.sqlite
      .prepare(
        `SELECT id, media_id, preview_json, status, decision_reason, requested_at, decided_at
         FROM requests WHERE id = ?`,
      )
      .get(id) as Parameters<typeof mapRequestRow>[0];
    return { request: mapRequestRow(row) };
  });

  // The caller's OWN requests (any status), newest first - IDOR-safe by profile.
  app.get("/api/library/requests", async (request) => {
    const auth = requireAuth(db, request);
    const query = parseBody(requestStatusQuerySchema, request.query);
    const status = query.status ?? null;
    const rows = db.sqlite
      .prepare(
        `SELECT id, media_id, preview_json, status, decision_reason, requested_at, decided_at
         FROM requests
         WHERE requester_profile_id = ? AND (? IS NULL OR status = ?)
         ORDER BY requested_at DESC
         LIMIT 200`,
      )
      .all(auth.profileId, status, status) as Array<Parameters<typeof mapRequestRow>[0]>;
    return { requests: rows.map(mapRequestRow) };
  });

  // The shared account-level "Requested" list: every approved request across the
  // account's profiles, so the household sees what's been greenlit.
  app.get("/api/library/requested", async (request) => {
    const auth = requireAuth(db, request);
    const rows = db.sqlite
      .prepare(
        `SELECT r.id, r.media_id, r.preview_json, r.status, r.decision_reason,
                r.requested_at, r.decided_at,
                req.display_name AS requester_display_name
         FROM requests r
         JOIN profiles req ON req.id = r.requester_profile_id
         WHERE req.user_id = ? AND r.status = 'approved'
         ORDER BY r.decided_at DESC
         LIMIT 200`,
      )
      .all(auth.userId) as Array<Parameters<typeof mapRequestRow>[0]>;
    return { items: rows.map(mapRequestRow) };
  });

  // Admin queue (pending by default), with requester + decider identity.
  app.get("/api/admin/requests", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    const query = parseBody(requestStatusQuerySchema, request.query);
    const status = query.status ?? "pending";
    const rows = db.sqlite
      .prepare(
        `SELECT r.id, r.media_id, r.preview_json, r.status, r.decision_reason,
                r.requested_at, r.decided_at,
                req.display_name AS requester_display_name,
                dec.display_name AS decided_by_display_name
         FROM requests r
         JOIN profiles req ON req.id = r.requester_profile_id
         LEFT JOIN profiles dec ON dec.id = r.decided_by_profile_id
         WHERE r.status = ?
         ORDER BY r.requested_at DESC
         LIMIT 100`,
      )
      .all(status) as Array<Parameters<typeof mapRequestRow>[0]>;
    return { requests: rows.map(mapRequestRow) };
  });

  app.post("/api/admin/requests/:id/approve", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = requestIdParamSchema.parse((request.params as { id: string }).id);
    const result = db.sqlite
      .prepare(
        `UPDATE requests
         SET status = 'approved', decided_by_profile_id = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(auth.profileId, nowISO(), id);
    if (result.changes === 0) throw httpError(404, "Pending request not found.");
    audit(db, auth, "request.approve", "request", id);
    return { ok: true };
  });

  app.post("/api/admin/requests/:id/deny", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = requestIdParamSchema.parse((request.params as { id: string }).id);
    const body = parseBody(requestDenyBodySchema, request.body);
    const result = db.sqlite
      .prepare(
        `UPDATE requests
         SET status = 'denied', decided_by_profile_id = ?, decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(auth.profileId, nowISO(), body.reason ?? null, id);
    if (result.changes === 0) throw httpError(404, "Pending request not found.");
    audit(db, auth, "request.deny", "request", id, { reason: body.reason ?? null });
    return { ok: true };
  });

  app.delete("/api/library/watchlist/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    db.sqlite
      .prepare("DELETE FROM watchlist WHERE profile_id = ? AND media_id = ?")
      .run(auth.profileId, mediaId);
    audit(db, auth, "watchlist.delete", "media", mediaId);
    return { ok: true };
  });

  app.get("/api/history", async (request) => {
    const auth = requireAuth(db, request);
    const query = request.query as { limit?: string; view?: string };
    if (query.view === CONTINUE_WATCHING_VIEW) {
      const limit = parseLimit(
        query.limit,
        CONTINUE_WATCHING_MAX_ROWS,
        CONTINUE_WATCHING_MAX_ROWS,
      );
      const rows = db.sqlite
        .prepare(
          `SELECT media_id, episode_id, progress_seconds, duration_seconds,
                  completed, last_watched, stream_quality, preview_json
           FROM watch_history
           WHERE profile_id = ?
             AND completed = 0
             AND duration_seconds > 0
             AND progress_seconds / duration_seconds > 0.02
             AND progress_seconds / duration_seconds < 0.95
           ORDER BY last_watched DESC
           LIMIT ?`,
        )
        .all(auth.profileId, limit) as Parameters<typeof mapWatchHistoryRow>[0][];
      const items: ReturnType<typeof mapWatchHistoryRow>[] = [];
      for (const row of rows) {
        const item = mapWatchHistoryRow(row);
        const candidate = {
          view: CONTINUE_WATCHING_VIEW,
          items: [...items, item],
        };
        if (
          Buffer.byteLength(JSON.stringify(candidate), "utf8") >
          CONTINUE_WATCHING_MAX_RESPONSE_BYTES
        ) {
          break;
        }
        items.push(item);
      }
      return { view: CONTINUE_WATCHING_VIEW, items };
    }

    const limit = parseLimit(query.limit, 100, 500);
    const rows = db.sqlite
      .prepare(
        `SELECT media_id, episode_id, progress_seconds, duration_seconds,
                completed, last_watched, stream_quality, preview_json
         FROM watch_history
         WHERE profile_id = ?
         ORDER BY last_watched DESC
         LIMIT ?`,
      )
      .all(auth.profileId, limit) as Parameters<typeof mapWatchHistoryRow>[0][];
    return { items: rows.map(mapWatchHistoryRow) };
  });

  // Complete per-title history for Detail watched rollups. This is scoped by
  // media id and intentionally has no global recency window.
  app.get("/api/history/:mediaId/entries", async (request) => {
    const auth = requireAuth(db, request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    const rows = db.sqlite
      .prepare(
        `SELECT media_id, episode_id, progress_seconds, duration_seconds,
                completed, last_watched, stream_quality, preview_json
         FROM watch_history
         WHERE profile_id = ? AND media_id = ?
         ORDER BY last_watched DESC`,
      )
      .all(auth.profileId, mediaId) as Parameters<typeof mapWatchHistoryRow>[0][];
    return { items: rows.map(mapWatchHistoryRow) };
  });

  // Exact-key resume lookup. The list endpoint is windowed (≤500), so a client
  // merge that reads the existing resume position must not depend on scanning it
  // - otherwise an older title (beyond the window) would read back as absent and
  // a viewed-only write would zero its progress. This is an O(1) keyed lookup.
  app.get("/api/history/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    const { episodeId } = request.query as { episodeId?: string };
    const episodeKey = episodeId ?? "";
    const row = db.sqlite
      .prepare(
        `SELECT media_id, episode_id, progress_seconds, duration_seconds,
                completed, last_watched, stream_quality, preview_json
         FROM watch_history
         WHERE profile_id = ? AND media_id = ? AND episode_key = ?`,
      )
      .get(auth.profileId, mediaId, episodeKey) as
      | Parameters<typeof mapWatchHistoryRow>[0]
      | undefined;
    return { item: row ? mapWatchHistoryRow(row) : null };
  });

  app.put("/api/history/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    const body = parseBody(historyBodySchema, request.body);
    const episodeId = body.episodeId ?? null;
    const episodeKey = episodeId ?? "";
    db.sqlite
      .prepare(
        `INSERT INTO watch_history
         (profile_id, media_id, episode_key, episode_id, progress_seconds,
          duration_seconds, completed, last_watched, stream_quality, preview_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, media_id, episode_key)
         DO UPDATE SET
           episode_id = excluded.episode_id,
           progress_seconds = excluded.progress_seconds,
           duration_seconds = excluded.duration_seconds,
           completed = excluded.completed,
           last_watched = excluded.last_watched,
           stream_quality = excluded.stream_quality,
           preview_json = excluded.preview_json`,
      )
      .run(
        auth.profileId,
        mediaId,
        episodeKey,
        episodeId,
        body.progressSeconds,
        body.durationSeconds ?? null,
        body.completed ? 1 : 0,
        body.lastWatched ?? nowISO(),
        body.streamQuality ?? null,
        serializePreview(body.preview),
      );
    return { ok: true };
  });

  app.delete("/api/history/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const mediaId = mediaIdParamSchema.parse(
      (request.params as { mediaId: string }).mediaId,
    );
    const { episodeId } = request.query as { episodeId?: string };
    const episodeKey = episodeId ?? "";
    db.sqlite
      .prepare(
        `DELETE FROM watch_history
         WHERE profile_id = ? AND media_id = ? AND episode_key = ?`,
      )
      .run(auth.profileId, mediaId, episodeKey);
    audit(db, auth, "history.delete", "media", mediaId, {
      episodeId: episodeId ?? null,
    });
    return { ok: true };
  });

  // ---- Library + folders (per-profile, mirrors DexieStore) ------------------

  const parseListType = (query: unknown): ListType | undefined => {
    const raw = (query as { listType?: unknown }).listType;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === "watchlist" || value === "favorites" || value === "custom"
      ? value
      : undefined;
  };

  app.get("/api/library", async (request) => {
    const auth = requireAuth(db, request);
    ensureLibrarySystemFolders(db, auth.profileId);
    const listType = parseListType(request.query);
    const rows = (
      listType
        ? db.sqlite
            .prepare(
              `SELECT ${LIBRARY_COLS} FROM user_library
               WHERE profile_id = ? AND list_type = ? ORDER BY added_at DESC`,
            )
            .all(auth.profileId, listType)
        : db.sqlite
            .prepare(
              `SELECT ${LIBRARY_COLS} FROM user_library
               WHERE profile_id = ? ORDER BY added_at DESC`,
            )
            .all(auth.profileId)
    ) as unknown as LibraryRow[];
    return { items: rows.map(mapLibraryRow) };
  });

  app.get("/api/library/folder/:folderId", async (request) => {
    const auth = requireAuth(db, request);
    const folderId = mediaIdParamSchema.parse(
      (request.params as { folderId: string }).folderId,
    );
    const rows = db.sqlite
      .prepare(
        `SELECT ${LIBRARY_COLS} FROM user_library
         WHERE profile_id = ? AND folder_id = ? ORDER BY added_at DESC`,
      )
      .all(auth.profileId, folderId) as unknown as LibraryRow[];
    return { items: rows.map(mapLibraryRow) };
  });

  app.get("/api/library/folders", async (request) => {
    const auth = requireAuth(db, request);
    ensureLibrarySystemFolders(db, auth.profileId);
    const listType = parseListType(request.query);
    const rows = (
      listType
        ? db.sqlite
            .prepare(
              `SELECT ${FOLDER_COLS} FROM library_folders WHERE profile_id = ? AND list_type = ?`,
            )
            .all(auth.profileId, listType)
        : db.sqlite
            .prepare(`SELECT ${FOLDER_COLS} FROM library_folders WHERE profile_id = ?`)
            .all(auth.profileId)
    ) as unknown as LibraryFolderRow[];
    // System folders first, then by name (matches DexieStore.listFolders).
    const folders = rows.map(mapFolderRow).sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { folders };
  });

  app.post("/api/library/folders", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const body = parseBody(folderCreateBodySchema, request.body);
    if (!listTypeSupportsFolders(body.listType)) {
      throw httpError(400, `Folders are not supported for ${body.listType}.`);
    }
    ensureLibrarySystemFolders(db, auth.profileId);
    const parentId = body.parentId ?? systemRootId(auth.profileId, body.listType);
    if (!folderExistsForProfile(db, auth.profileId, parentId)) {
      throw httpError(400, "Unknown parent folder.");
    }
    const name = uniqueFolderName(db, auth.profileId, body.name, body.listType, parentId);
    const id = randomId("folder");
    const now = nowISO();
    db.sqlite
      .prepare(
        `INSERT INTO library_folders
           (id, profile_id, name, parent_id, list_type, folder_kind, is_system, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', 0, ?, ?)`,
      )
      .run(id, auth.profileId, name, parentId, body.listType, now, now);
    audit(db, auth, "library.folder.create", "library_folder", id);
    const row = db.sqlite
      .prepare(`SELECT ${FOLDER_COLS} FROM library_folders WHERE id = ?`)
      .get(id) as unknown as LibraryFolderRow;
    return { folder: mapFolderRow(row) };
  });

  app.put("/api/library/folders/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = mediaIdParamSchema.parse((request.params as { id: string }).id);
    const body = parseBody(folderSaveBodySchema, request.body);
    // saveFolder is a rename/update of an EXISTING folder. Refuse to mint a new
    // (possibly system) folder here, and never touch another profile's folder.
    const existing = db.sqlite
      .prepare("SELECT profile_id, is_system FROM library_folders WHERE id = ?")
      .get(id) as { profile_id: string; is_system: number } | undefined;
    if (existing == null || existing.profile_id !== auth.profileId) {
      throw httpError(404, "Folder not found.");
    }
    if (existing.is_system === 1) throw httpError(400, "System folders cannot be edited.");
    // A re-parent must point at one of THIS profile's folders - else the raw FK
    // would 500 on a dangling id, or (worse) accept another profile's folder id
    // (the FK checks existence, not ownership). Mirrors the createFolder guard.
    if (body.parentId != null && !folderExistsForProfile(db, auth.profileId, body.parentId)) {
      throw httpError(400, "Unknown parent folder.");
    }
    db.sqlite
      .prepare(
        `UPDATE library_folders SET name = ?, parent_id = ?, updated_at = ?
         WHERE id = ? AND profile_id = ?`,
      )
      .run(body.name, body.parentId, nowISO(), id, auth.profileId);
    audit(db, auth, "library.folder.save", "library_folder", id);
    return { ok: true };
  });

  app.delete("/api/library/folders/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = mediaIdParamSchema.parse((request.params as { id: string }).id);
    const folder = db.sqlite
      .prepare("SELECT list_type, is_system FROM library_folders WHERE id = ? AND profile_id = ?")
      .get(id, auth.profileId) as { list_type: string; is_system: number } | undefined;
    if (folder == null) return { ok: true }; // missing → no-op (DexieStore parity)
    if (folder.is_system === 1) throw httpError(400, "System folders cannot be deleted.");
    const fallback = systemRootId(auth.profileId, folder.list_type as ListType);
    db.transaction(() => {
      // Re-parent this folder's entries to the system root, deduping on media_id.
      const entries = db.sqlite
        .prepare("SELECT id, media_id FROM user_library WHERE profile_id = ? AND folder_id = ?")
        .all(auth.profileId, id) as Array<{ id: string; media_id: string }>;
      for (const e of entries) {
        const collides =
          db.sqlite
            .prepare(
              "SELECT 1 FROM user_library WHERE profile_id = ? AND media_id = ? AND folder_id = ? LIMIT 1",
            )
            .get(auth.profileId, e.media_id, fallback) != null;
        if (collides) {
          db.sqlite.prepare("DELETE FROM user_library WHERE id = ?").run(e.id);
        } else {
          db.sqlite.prepare("UPDATE user_library SET folder_id = ? WHERE id = ?").run(fallback, e.id);
        }
      }
      db.sqlite.prepare("DELETE FROM library_folders WHERE id = ? AND profile_id = ?").run(id, auth.profileId);
    });
    audit(db, auth, "library.folder.delete", "library_folder", id);
    return { ok: true };
  });

  app.put("/api/library/:mediaId", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const mediaId = mediaIdParamSchema.parse((request.params as { mediaId: string }).mediaId);
    const body = parseBody(libraryUpsertBodySchema, request.body);
    ensureLibrarySystemFolders(db, auth.profileId);
    // Folder resolution mirrors DexieStore: non-folder list types pin to the
    // system root; folder list types default an empty folderId to the root.
    const resolvedFolderId = listTypeSupportsFolders(body.listType)
      ? (body.folderId?.trim() || systemRootId(auth.profileId, body.listType))
      : systemRootId(auth.profileId, body.listType);
    if (!folderExistsForProfile(db, auth.profileId, resolvedFolderId)) {
      throw httpError(400, "Unknown folder.");
    }
    const now = nowISO();
    db.sqlite
      .prepare(
        `INSERT INTO user_library
           (id, profile_id, media_id, folder_id, list_type, added_at, custom_list_name, release_date_hint, renewal_status, preview_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, media_id, folder_id) DO UPDATE SET
           list_type = excluded.list_type,
           added_at = COALESCE(?, user_library.added_at),
           custom_list_name = COALESCE(excluded.custom_list_name, user_library.custom_list_name),
           release_date_hint = COALESCE(excluded.release_date_hint, user_library.release_date_hint),
           renewal_status = COALESCE(excluded.renewal_status, user_library.renewal_status),
           preview_json = excluded.preview_json`,
      )
      .run(
        randomId("lib"),
        auth.profileId,
        mediaId,
        resolvedFolderId,
        body.listType,
        body.addedAt ?? now,
        body.customListName ?? null,
        body.releaseDateHint ?? null,
        body.renewalStatus ?? null,
        serializePreview(body.preview),
        // On conflict: a caller-supplied addedAt wins (DexieStore parity); omitted
        // → NULL → COALESCE keeps the existing added_at. Distinct from the insert
        // value above (which defaults to `now` to satisfy NOT NULL on first add).
        body.addedAt ?? null,
      );
    audit(db, auth, "library.entry.upsert", "library_entry", mediaId);
    const row = db.sqlite
      .prepare(
        `SELECT ${LIBRARY_COLS} FROM user_library WHERE profile_id = ? AND media_id = ? AND folder_id = ?`,
      )
      .get(auth.profileId, mediaId, resolvedFolderId) as unknown as LibraryRow;
    return { entry: mapLibraryRow(row) };
  });

  app.delete("/api/library/entry/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    const id = mediaIdParamSchema.parse((request.params as { id: string }).id);
    db.sqlite
      .prepare("DELETE FROM user_library WHERE id = ? AND profile_id = ?")
      .run(id, auth.profileId);
    audit(db, auth, "library.entry.delete", "library_entry", id);
    return { ok: true };
  });

  app.get("/api/portability/export", async (request) => {
    const auth = requireAuth(db, request);
    ensureLibrarySystemFolders(db, auth.profileId);
    const settings = (
      db.sqlite
        .prepare(
          `SELECT key, value
           FROM profile_settings
           WHERE profile_id = ?
           ORDER BY key`,
        )
        .all(auth.profileId) as Array<{ key: string; value: string }>
    ).filter((row) => isPortableProfileSetting(row.key, row.value));
    const watchlist = (
      db.sqlite
        .prepare(
          `SELECT media_id, added_at, preview_json
           FROM watchlist
           WHERE profile_id = ?
           ORDER BY added_at DESC`,
        )
        .all(auth.profileId) as Array<{
        media_id: string;
        added_at: string;
        preview_json: string;
      }>
    ).map((row) => ({
      mediaId: row.media_id,
      addedAt: row.added_at,
      preview: deserializePreview(row.preview_json),
    }));
    const history = (
      db.sqlite
        .prepare(
          `SELECT media_id, episode_id, progress_seconds, duration_seconds,
                  completed, last_watched, stream_quality, preview_json
           FROM watch_history
           WHERE profile_id = ?
           ORDER BY last_watched DESC`,
        )
        .all(auth.profileId) as Parameters<typeof mapWatchHistoryRow>[0][]
    ).map(mapWatchHistoryRow);
    const folders = (
      db.sqlite
        .prepare(
          `SELECT ${FOLDER_COLS}
           FROM library_folders
           WHERE profile_id = ?`,
        )
        .all(auth.profileId) as unknown as LibraryFolderRow[]
    ).map(mapFolderRow);
    const library = (
      db.sqlite
        .prepare(
          `SELECT ${LIBRARY_COLS}
           FROM user_library
           WHERE profile_id = ?
           ORDER BY added_at DESC`,
        )
        .all(auth.profileId) as unknown as LibraryRow[]
    ).map(mapLibraryRow);

    return {
      bundle: {
        product: "YAWF Stream",
        format: "yawf-profile-portable",
        version: 1,
        createdAt: nowISO(),
        settings,
        watchlist,
        history,
        folders,
        library,
      },
    };
  });

  app.post(
    "/api/portability/import",
    { bodyLimit: 10 * 1024 * 1024 },
    async (request) => {
      const auth = requireAuth(db, request);
      requireNotRestricted(auth);
      requireCsrf(request);
      rateLimit(request, `portability:import:${auth.profileId}`, 6, 60 * 60_000);
      const body = parseBody(portableImportSchema, request.body);
      const counts = {
        settings: 0,
        watchlist: 0,
        history: 0,
        folders: 0,
        library: 0,
      };

      ensureLibrarySystemFolders(db, auth.profileId);
      db.transaction(() => {
        if (body.mode === "replace") {
          db.sqlite
            .prepare("DELETE FROM watchlist WHERE profile_id = ?")
            .run(auth.profileId);
          db.sqlite
            .prepare("DELETE FROM watch_history WHERE profile_id = ?")
            .run(auth.profileId);
          db.sqlite
            .prepare("DELETE FROM user_library WHERE profile_id = ?")
            .run(auth.profileId);
          db.sqlite
            .prepare(
              "DELETE FROM library_folders WHERE profile_id = ? AND is_system = 0",
            )
            .run(auth.profileId);
          const existingSettings = db.sqlite
            .prepare("SELECT key, value FROM profile_settings WHERE profile_id = ?")
            .all(auth.profileId) as Array<{ key: string; value: string }>;
          const removeSetting = db.sqlite.prepare(
            "DELETE FROM profile_settings WHERE profile_id = ? AND key = ?",
          );
          for (const setting of existingSettings) {
            if (isPortableProfileSetting(setting.key, setting.value)) {
              removeSetting.run(auth.profileId, setting.key);
            }
          }
        }

        const saveSetting = db.sqlite.prepare(
          `INSERT INTO profile_settings (profile_id, key, value)
           VALUES (?, ?, ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
        );
        for (const setting of body.bundle.settings) {
          if (!isPortableProfileSetting(setting.key, setting.value)) continue;
          saveSetting.run(auth.profileId, setting.key, setting.value);
          counts.settings += 1;
        }

        const saveWatchlist = db.sqlite.prepare(
          `INSERT INTO watchlist (profile_id, media_id, added_at, preview_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(profile_id, media_id) DO UPDATE SET
             added_at = CASE
               WHEN excluded.added_at > watchlist.added_at
               THEN excluded.added_at ELSE watchlist.added_at END,
             preview_json = CASE
               WHEN excluded.added_at >= watchlist.added_at
               THEN excluded.preview_json ELSE watchlist.preview_json END`,
        );
        for (const entry of body.bundle.watchlist) {
          saveWatchlist.run(
            auth.profileId,
            entry.mediaId,
            entry.addedAt,
            serializePreview(entry.preview),
          );
          counts.watchlist += 1;
        }

        const saveHistory = db.sqlite.prepare(
          `INSERT INTO watch_history
             (profile_id, media_id, episode_key, episode_id, progress_seconds,
              duration_seconds, completed, last_watched, stream_quality, preview_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, media_id, episode_key) DO UPDATE SET
             episode_id = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.episode_id ELSE watch_history.episode_id END,
             progress_seconds = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.progress_seconds ELSE watch_history.progress_seconds END,
             duration_seconds = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.duration_seconds ELSE watch_history.duration_seconds END,
             completed = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.completed ELSE watch_history.completed END,
             last_watched = MAX(excluded.last_watched, watch_history.last_watched),
             stream_quality = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.stream_quality ELSE watch_history.stream_quality END,
             preview_json = CASE WHEN excluded.last_watched >= watch_history.last_watched
               THEN excluded.preview_json ELSE watch_history.preview_json END`,
        );
        for (const entry of body.bundle.history) {
          saveHistory.run(
            auth.profileId,
            entry.mediaId,
            entry.episodeId ?? "",
            entry.episodeId,
            entry.progressSeconds,
            entry.durationSeconds,
            entry.completed ? 1 : 0,
            entry.lastWatched,
            entry.streamQuality,
            serializePreview(entry.preview),
          );
          counts.history += 1;
        }

        const portableFolders = new Map(
          body.bundle.folders.map((folder) => [folder.id, folder]),
        );
        const folderMap = new Map<string, string>();
        for (const folder of body.bundle.folders) {
          if (folder.folderKind === "system_root") {
            folderMap.set(folder.id, systemRootId(auth.profileId, folder.listType));
          } else if (folder.folderKind === "watched") {
            folderMap.set(folder.id, favWatchedId(auth.profileId));
          } else if (folder.folderKind === "release_wait") {
            folderMap.set(folder.id, favReleaseWaitId(auth.profileId));
          } else {
            folderMap.set(
              folder.id,
              `import-${sha256(`${auth.profileId}:${folder.id}`).slice(0, 32)}`,
            );
          }
        }

        const saveFolder = db.sqlite.prepare(
          `INSERT INTO library_folders
             (id, profile_id, name, parent_id, list_type, folder_kind,
              is_system, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             parent_id = excluded.parent_id,
             updated_at = excluded.updated_at`,
        );
        const pendingFolders = body.bundle.folders.filter(
          (folder) => !folder.isSystem && folder.folderKind === "manual",
        );
        const insertedFolders = new Set<string>();
        while (pendingFolders.length > 0) {
          let nextIndex = pendingFolders.findIndex((folder) => {
            if (folder.parentId == null) return true;
            const parent = portableFolders.get(folder.parentId);
            return (
              parent == null ||
              parent.folderKind !== "manual" ||
              parent.listType !== folder.listType ||
              insertedFolders.has(parent.id)
            );
          });
          // A remaining cycle is still recoverable. Break one edge by attaching
          // the first stable entry to its list root, then continue in dependency
          // order so the rest of the hierarchy is preserved.
          if (nextIndex < 0) nextIndex = 0;
          const [folder] = pendingFolders.splice(nextIndex, 1);
          const parent =
            folder.parentId == null
              ? null
              : portableFolders.get(folder.parentId) ?? null;
          const parentId =
            parent != null &&
            parent.listType === folder.listType &&
            (parent.folderKind !== "manual" || insertedFolders.has(parent.id))
              ? (folderMap.get(parent.id) ??
                systemRootId(auth.profileId, folder.listType))
              : systemRootId(auth.profileId, folder.listType);
          saveFolder.run(
            folderMap.get(folder.id)!,
            auth.profileId,
            folder.name,
            parentId,
            folder.listType,
            folder.createdAt,
            folder.updatedAt,
          );
          insertedFolders.add(folder.id);
          counts.folders += 1;
        }

        const saveLibrary = db.sqlite.prepare(
          `INSERT INTO user_library
             (id, profile_id, media_id, folder_id, list_type, added_at,
              custom_list_name, release_date_hint, renewal_status, preview_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, media_id, folder_id) DO UPDATE SET
             added_at = MAX(excluded.added_at, user_library.added_at),
             custom_list_name = excluded.custom_list_name,
             release_date_hint = excluded.release_date_hint,
             renewal_status = excluded.renewal_status,
             preview_json = excluded.preview_json`,
        );
        for (const entry of body.bundle.library) {
          const sourceFolder =
            entry.folderId == null
              ? null
              : portableFolders.get(entry.folderId) ?? null;
          const folderId =
            sourceFolder != null && sourceFolder.listType === entry.listType
              ? (folderMap.get(sourceFolder.id) ??
                systemRootId(auth.profileId, entry.listType))
              : systemRootId(auth.profileId, entry.listType);
          saveLibrary.run(
            randomId("lib"),
            auth.profileId,
            entry.mediaId,
            folderId,
            entry.listType,
            entry.addedAt,
            entry.customListName,
            entry.releaseDateHint,
            entry.renewalStatus,
            serializePreview(entry.preview),
          );
          counts.library += 1;
        }
      });

      audit(db, auth, "portability.import", "profile", auth.profileId, {
        mode: body.mode,
        counts,
      });
      return { ok: true, counts };
    },
  );

  app.get("/api/credentials/effective", async (request) => {
    const auth = requireAuth(db, request);
    return { credentials: effectiveCredentials(db, auth.profileId) };
  });

  app.put("/api/admin/credentials", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const body = parseBody(credentialBodySchema, request.body);
    const credential = upsertCredential(db, config, body, "server", null);
    audit(db, auth, "credential.server.upsert", "credential", credential.id, {
      provider: credential.provider,
    });
    return { credential };
  });

  app.put("/api/profile/credentials", async (request) => {
    const auth = requireAuth(db, request);
    requireNotRestricted(auth);
    requireCsrf(request);
    const body = parseBody(credentialBodySchema, request.body);
    const credential = upsertCredential(db, config, body, "profile", auth.profileId);
    audit(db, auth, "credential.profile.upsert", "credential", credential.id, {
      provider: credential.provider,
    });
    return { credential };
  });

  app.delete("/api/profile/credentials/:id", async (request) => {
    const auth = requireAuth(db, request);
    requireNotRestricted(auth);
    requireCsrf(request);
    const id = (request.params as { id: string }).id;
    db.sqlite
      .prepare("DELETE FROM credential_secrets WHERE id = ? AND scope = 'profile' AND profile_id = ?")
      .run(id, auth.profileId);
    audit(db, auth, "credential.profile.delete", "credential", id);
    return { ok: true };
  });

  app.get("/api/search", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `media:search:${auth.profileId}`, 60, 60 * 1000);
    // Kid profiles have no free-text search - only the curated, cert-capped
    // browse surfaces. Blocking here keeps a kid from typing past the cap.
    if (auth.isKid) throw httpError(403, "Search is disabled on this profile.");
    const query = parseBody(mediaSearchQuerySchema, request.query);
    return searchServerMedia(db, config, auth.profileId, {
      query: query.q,
      type: query.type === "all" ? null : query.type,
      page: query.page,
    });
  });

  app.get("/api/discover/home", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `media:home:${auth.profileId}`, 60, 60 * 1000);
    return getServerDiscoverHome(db, config, auth.profileId, maturityAudience(auth));
  });

  app.get("/api/catalog/category", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `media:category:${auth.profileId}`, 120, 60 * 1000);
    const query = parseBody(mediaCategoryQuerySchema, request.query);
    return getServerCategory(db, config, auth.profileId, query, maturityAudience(auth));
  });

  app.get("/api/catalog/discover", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `media:discover:${auth.profileId}`, 120, 60 * 1000);
    const rawQuery = (request.query ?? {}) as Record<string, unknown>;
    const query = parseBody(mediaDiscoverBaseQuerySchema, rawQuery);
    const params = stringQueryParams(rawQuery, new Set(["type"]));
    if (params.page == null) params.page = "1";
    if (params.language == null) params.language = "en-US";
    // Force include_adult off server-side (overwrite, not default): the client
    // only ever wants false, and a hand-crafted include_adult=true must not pull
    // adult results through the server.
    params.include_adult = "false";
    return discoverServerMedia(
      db,
      config,
      auth.profileId,
      { type: query.type, params },
      maturityAudience(auth),
    );
  });

  app.get("/api/genres", async (request) => {
    const auth = requireAuth(db, request);
    const query = parseBody(mediaGenresQuerySchema, request.query);
    return getServerGenres(db, config, auth.profileId, query);
  });

  app.post("/api/calendar/upcoming", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `calendar:upcoming:${auth.profileId}`, 30, 60 * 1000);
    // Series-only feature; kid browse is movie-only, so a kid has no business
    // enumerating arbitrary (uncurated) series air dates here. Block outright.
    if (auth.isKid) {
      throw httpError(403, "Upcoming episodes are not available on this profile.");
    }
    const body = parseBody(upcomingEpisodesBodySchema, request.body);
    return getServerUpcomingEpisodes(db, config, auth.profileId, {
      series: body.series.filter(isSeriesPreviewInput),
    });
  });

  app.get("/api/calendar/movies", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `calendar:movies:${auth.profileId}`, 30, 60 * 1000);
    // TMDB category endpoints cannot be certification-capped. Preserve kid
    // profile safety instead of proxying an uncapped movie catalog.
    if (auth.isKid) return { releases: [] };
    return getServerMovieReleaseCalendar(db, config, auth.profileId);
  });

  // AI recommendations (Assistant). Uses the server's stored AI provider key for
  // this profile; raw recommendations, no catalog resolution.
  app.post("/api/ai/recommend", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `ai:recommend:${auth.profileId}`, 10, 60 * 1000);
    // AI discovery is a free-text recommendation surface that can name over-cap
    // titles - the same class as /api/search. Kids get curated browse only.
    if (auth.isKid) throw httpError(403, "AI discovery is not available on this profile.");
    const body = parseBody(aiRecommendBodySchema, request.body);
    const result = await recommendServerAI(db, config, auth.profileId, body);
    audit(db, auth, "ai.recommend", "ai", undefined, { provider: result.providerKind });
    return {
      recommendations: result.recommendations,
      model: result.model,
      usage: result.usage,
    };
  });

  // AI mood-curate (Discover "Describe a vibe"). Recommends, then resolves each
  // title to a real catalog item server-side (the client has no TMDB key in
  // Server Mode), returning ready-to-render previews.
  app.post("/api/ai/curate", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `ai:curate:${auth.profileId}`, 10, 60 * 1000);
    if (auth.isKid) throw httpError(403, "AI discovery is not available on this profile.");
    const body = parseBody(aiRecommendBodySchema, request.body);
    const out = await curateServerAI(db, config, auth.profileId, body);
    audit(db, auth, "ai.curate", "ai", undefined, {
      provider: out.providerKind,
      matched: out.items.length,
    });
    return { items: out.items, unmatched: out.unmatched };
  });

  // Subtitle search (OpenSubtitles) using the server's stored key for this profile.
  app.post("/api/subtitles/search", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `subtitles:search:${auth.profileId}`, 60, 60 * 1000);
    const body = parseBody(subtitleSearchBodySchema, request.body);
    // Subtitle search is a discovery surface (free text + imdbId). For a kid it is
    // limited to a cert-gated lookup of their own within-cap MOVIE titles - no
    // free-text, no over-cap title (which would leak the film's full dialogue).
    if (auth.isKid) {
      if (body.imdbId == null || body.imdbId.length === 0) {
        throw httpError(403, "Subtitle search is not available on this profile.");
      }
      await requireTitleWithinCap(auth, body.imdbId, "movie");
    }
    const results = await searchServerSubtitles(db, config, auth.profileId, body);
    audit(db, auth, "subtitles.search", "subtitle", undefined, {
      imdbId: body.imdbId ?? null, // media id - safe to log
      languages: body.languages ?? ["en"], // lang codes - safe
      freeText: (body.query?.length ?? 0) > 0, // boolean only - NOT the query text
      results: results.length,
    });
    return { results };
  });

  // Download a chosen subtitle and return it as a decoded WebVTT string.
  app.post("/api/subtitles/fetch", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `subtitles:fetch:${auth.profileId}`, 60, 60 * 1000);
    const body = parseBody(subtitleFetchBodySchema, request.body);
    // Maturity gate: a kid may only fetch dialogue for a within-cap movie, so
    // require the title id and cert-check it (mirrors /api/subtitles/search).
    // Fail-closed: no id → 403, so an out-of-band fileId can't leak over-cap text.
    if (auth.isKid) {
      if (body.imdbId == null || body.imdbId.length === 0) {
        throw httpError(403, "Subtitles are not available on this profile.");
      }
      await requireTitleWithinCap(auth, body.imdbId, "movie");
    }
    const vtt = await fetchServerSubtitle(db, config, auth.profileId, body.fileId);
    audit(db, auth, "subtitles.fetch", "subtitle", body.fileId);
    return { vtt };
  });

  // AI-translate a track's cues, preserving timing. Reuses the profile's AI key.
  app.post("/api/subtitles/translate", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    // Tight limit: each translate fans out many AI calls and is long-running.
    rateLimit(request, `subtitles:translate:${auth.profileId}`, 10, 60 * 1000);
    const body = parseBody(subtitleTranslateBodySchema, request.body);
    const out = await translateServerSubtitle(db, config, auth.profileId, body);
    audit(db, auth, "subtitles.translate", "subtitle", undefined, {
      provider: out.providerKind,
      target: body.targetLanguage,
      cues: body.cues.length,
    });
    return { cues: out.cues, providerKind: out.providerKind };
  });

  // Cert-gate a title for a capped/kid profile: fail-closed (403) unless the
  // title's certification is within the cap. A kid with no cap is also blocked
  // (defended at the schema layer, belt-and-suspenders here). No-op for
  // uncapped profiles. Used to keep over-cap detail pages + source lists away
  // from kids (which also denies them the infoHashes for the resolve path).
  async function requireTitleWithinCap(
    auth: AuthContext,
    mediaId: string,
    type: "movie" | "series",
  ): Promise<void> {
    if (!auth.isKid && auth.maturityMax == null) return;
    // A kid's world is movie-only - TV ratings ride a different ladder and series
    // are never curated to them, so refuse non-movie lookups outright rather than
    // try to rank a TV rating against a movie cap.
    if (auth.isKid && type !== "movie") {
      throw httpError(403, "This title is outside your maturity settings.");
    }
    const cap = auth.maturityMax;
    const cert =
      cap != null
        ? await titleCertification(db, config, auth.profileId, mediaId, type).catch(() => null)
        : null;
    if (cap == null || !certWithinCap(cert, cap)) {
      throw httpError(403, "This title is outside your maturity settings.");
    }
  }

  app.get("/api/media/detail", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `media:detail:${auth.profileId}`, 120, 60 * 1000);
    const query = parseBody(mediaDetailQuerySchema, request.query);
    await requireTitleWithinCap(auth, query.id, query.type);
    return getServerDetail(db, config, auth.profileId, {
      id: query.id,
      type: query.type,
    });
  });

  // Episode-picker metadata (series only). Kid browse is movie-only, so a kid
  // has no business enumerating arbitrary series seasons/episodes - block
  // outright (mirrors /api/calendar/upcoming); the client degrades to its
  // stepper fallback. Rate-limited per profile (mirrors /api/omdb) so an
  // authed user can't hammer TMDB through these proxies, and TMDB failures
  // surface as a clean 503 (the client treats any failure as "no guide").
  app.get("/api/media/seasons", async (request) => {
    const auth = requireAuth(db, request);
    if (auth.isKid) {
      throw httpError(403, "Episode guides are not available on this profile.");
    }
    rateLimit(request, `media:seasons:${auth.profileId}`, 60, 60 * 1000);
    const query = parseBody(mediaSeasonsQuerySchema, request.query);
    try {
      return await getServerSeasons(db, config, auth.profileId, {
        tmdbId: query.tmdbId,
      });
    } catch {
      throw httpError(503, "Episode guide is unavailable right now.");
    }
  });

  app.get("/api/media/episodes", async (request) => {
    const auth = requireAuth(db, request);
    if (auth.isKid) {
      throw httpError(403, "Episode guides are not available on this profile.");
    }
    rateLimit(request, `media:episodes:${auth.profileId}`, 120, 60 * 1000);
    const query = parseBody(mediaEpisodesQuerySchema, request.query);
    try {
      return await getServerEpisodes(db, config, auth.profileId, {
        tmdbId: query.tmdbId,
        season: query.season,
      });
    } catch {
      throw httpError(503, "Episode guide is unavailable right now.");
    }
  });

  // OMDb ratings proxy - the "hidden key" path. The key is resolved server-side
  // (profile credential → server credential → env → embedded build key) and used
  // to call OMDb here; the client receives only parsed ratings, never the key and
  // never the OMDb request. { ratings: null } when no key is configured.
  //
  // Ratings for an IMDb id are identical regardless of which key fetched them, so
  // they're cached server-wide (bounded TTL) to cap shared-key spend + abuse.
  const omdbCache = new Map<string, { ratings: OMDBRatings | null; expires: number }>();
  const OMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const OMDB_NULL_TTL_MS = 10 * 60 * 1000;
  const OMDB_CACHE_MAX = 5000;
  app.get("/api/omdb/:imdbId", async (request) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `omdb:${auth.profileId}`, 60, 60 * 1000);
    const imdbId = z
      .string()
      .trim()
      .regex(/^tt\d+$/)
      .parse((request.params as { imdbId: string }).imdbId);
    // Precedence: a user's OWN key (BYOK) → the key broker (key never on this
    // server) → a local server/env/embedded key.
    const profileKey = profileScopedOmdbKey(db, config, auth.profileId);
    let fetcher: (() => Promise<OMDBRatings | null>) | null = null;
    if (profileKey != null) {
      fetcher = () => fetchOmdbRatings(profileKey, imdbId);
    } else if (brokerConfigured(config)) {
      fetcher = () => fetchOmdbViaBroker(config.omdbBrokerUrl!, config.brokerAuthToken, imdbId);
    } else {
      const key = resolveOmdbKey(db, config, auth.profileId);
      if (key != null) fetcher = () => fetchOmdbRatings(key, imdbId);
    }
    if (fetcher == null) return { ratings: null };

    // Only the shared sources (broker / server / env / embedded) produce
    // profile-independent ratings, so only THEY use the server-wide cache. A
    // user's own (BYOK) key bypasses the cache so a bad personal key can't
    // poison results for everyone else.
    const shared = profileKey == null;
    const now = Date.now();
    if (shared) {
      const hit = omdbCache.get(imdbId);
      if (hit != null && hit.expires > now) return { ratings: hit.ratings };
    }

    const ratings = await fetcher();
    if (shared) {
      if (omdbCache.size >= OMDB_CACHE_MAX) {
        const oldest = omdbCache.keys().next().value;
        if (oldest != null) omdbCache.delete(oldest);
      }
      // Cache a "no ratings" result only briefly so a transient miss doesn't
      // suppress a title for everyone for hours.
      const ttl = ratings == null ? OMDB_NULL_TTL_MS : OMDB_CACHE_TTL_MS;
      omdbCache.set(imdbId, { ratings, expires: now + ttl });
    }
    return { ratings };
  });

  // Broker endpoint - answers OMDb lookups for friend ("consumer") servers that
  // present a valid broker token. The broker holds the real key (its own
  // server/env/embedded key) and returns ONLY ratings; the consumer never
  // receives the key, so the key is never on the friend's machine and the token
  // is independently revocable. Server-to-server: a broker token, not a session.
  app.get("/api/broker/omdb/:imdbId", async (request, reply) => {
    // Rate-limit by IP BEFORE the token check so invalid-token spraying is
    // bounded too (then a usage limit on success).
    rateLimit(request, `broker:omdb:${request.ip}`, 600, 60 * 1000);
    const authz = request.headers.authorization ?? "";
    const presented = authz.startsWith("Bearer ") ? authz.slice(7).trim() : null;
    if (!isValidBrokerToken(config, presented)) {
      reply.code(401);
      return { error: "Invalid broker token." };
    }
    const imdbId = z
      .string()
      .trim()
      .regex(/^tt\d+$/)
      .parse((request.params as { imdbId: string }).imdbId);
    // The broker uses its OWN key only (server-scoped credential / env / embedded
    // - never a consumer's profile credential).
    const key = resolveServerOmdbKey(db, config);
    if (key == null) {
      reply.code(503);
      return { error: "Broker has no OMDb key configured." };
    }
    return { ratings: await fetchOmdbRatings(key, imdbId) };
  });

  app.get("/api/streams/:imdbId", async (request, reply) => {
    const auth = requireAuth(db, request);
    rateLimit(request, `streams:search:${auth.profileId}`, 60, 60 * 1000);
    const imdbId = z
      .string()
      .trim()
      .min(1)
      .max(64)
      .parse((request.params as { imdbId: string }).imdbId);
    const query = parseBody(streamSearchQuerySchema, request.query);
    // Over-cap source enumeration is blocked for kids - both an info leak and the
    // supply of infoHashes the resolve path would otherwise have to defend alone.
    await requireTitleWithinCap(auth, imdbId, query.type);
    // The name-matching title pass is deliberately SUPPRESSED for kid/capped
    // profiles: it can surface loosely-name-matched (e.g. APIBay) sources that
    // the fail-closed play-block (titleHasInfoHash, imdb-EXACT) would then refuse
    // to bind - a legit stream a kid couldn't play - and widening that gate to
    // accept name-matched hashes would weaken the child-safety guarantee. So kids
    // stay imdb-exact end-to-end; only normal profiles get the extra pass.
    const capped = auth.isKid || auth.maturityMax != null;
    const searchInput = {
      imdbId,
      type: query.type,
      season: query.season ?? null,
      episode: query.episode ?? null,
      title: capped ? null : query.title ?? null,
      // The year passes through even for capped profiles: it only REORDERS the
      // imdb-exact results (wrong-year noise sinks), it never widens the set.
      year: query.year ?? null,
    };
    if (query.progressive !== "1") {
      return searchServerStreams(db, config, auth.profileId, searchInput);
    }

    reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-accel-buffering", "no");
    const headers = reply.getHeaders();
    reply.hijack();
    reply.raw.statusCode = 200;
    for (const [name, value] of Object.entries(headers)) {
      if (value != null) reply.raw.setHeader(name, value);
    }
    reply.raw.flushHeaders();
    const sendPhase = (
      phase: "sources" | "ready",
      result: Awaited<ReturnType<typeof searchServerStreams>>,
    ) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`${JSON.stringify({ phase, ...result })}\n`);
    };
    try {
      await searchServerStreams(db, config, auth.profileId, {
        ...searchInput,
        onPhase: sendPhase,
      });
    } catch (error) {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(
          `${JSON.stringify({
            phase: "error",
            error:
              error instanceof Error && "statusCode" in error
                ? error.message
                : "Stream search failed. Retry or check the configured indexers.",
          })}\n`,
        );
      }
    } finally {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  // Validates a candidate debrid token SERVER-side. Debrid hosts (TorBox in
  // particular) send no CORS headers and reject preflight, so the client-side
  // "Test connection" always fails in a webview/browser even with a perfect
  // token; in server mode the authoritative check has to run here.
  app.post("/api/debrid/test", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `debrid:test:${auth.profileId}`, 30, 60 * 1000);
    const body = parseBody(debridTestSchema, request.body);
    const service = buildDebridService(body.service, body.apiToken);
    if (service == null) return { valid: false };
    return { valid: await service.validateToken() };
  });

  app.post("/api/streams/resolve", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `streams:resolve:${auth.profileId}`, 120, 60 * 1000);
    const body = parseBody(resolveStreamSchema, request.body);
    // Kid play-block - the authoritative content gate, FAIL-CLOSED. A capped/kid
    // profile may resolve a title only when (a) it declares its media identity,
    // (b) the title is a MOVIE within the cap, and (c) the infoHash is genuinely a
    // source of that title. (c) is the crucial binding: the cert is checked
    // against the CLAIMED mediaId, so without verifying the infoHash belongs to
    // it, a kid could pair an over-cap infoHash with an in-cap mediaId and play
    // anything. Any missing piece, unknown cert, or metadata error blocks. (The
    // resolveStreamSchema lowercases infoHash; titleHasInfoHash compares lower.)
    if (auth.isKid || auth.maturityMax != null) {
      const cap = auth.maturityMax;
      const blocked = (reason: string, extra: Record<string, unknown> = {}) => {
        audit(db, auth, "stream.maturity_blocked", "media", body.mediaId ?? body.infoHash, {
          reason,
          cap,
          ...extra,
        });
        return httpError(403, "This title is outside your maturity settings.");
      };
      if (cap == null) throw blocked("kid_without_cap");
      if (body.mediaId == null || body.mediaType == null) {
        throw blocked("missing_media_identity");
      }
      // Kid browse is movie-only; series can't be reliably source-verified here
      // (season/episode packs) and are never offered to a kid, so refuse them.
      if (body.mediaType !== "movie") {
        throw blocked("not_movie", { mediaType: body.mediaType });
      }
      const cert = await titleCertification(
        db,
        config,
        auth.profileId,
        body.mediaId,
        body.mediaType,
      ).catch(() => null);
      if (!certWithinCap(cert, cap)) {
        throw blocked("over_cap", { certification: cert, mediaId: body.mediaId });
      }
      const belongs = await titleHasInfoHash(
        db,
        config,
        auth.profileId,
        body.mediaId,
        body.mediaType,
        body.infoHash,
      ).catch(() => false);
      if (!belongs) {
        throw blocked("infohash_unbound", { mediaId: body.mediaId, infoHash: body.infoHash });
      }
    }
    const directStream = await resolveServerStream(db, config, auth.profileId, {
      infoHash: body.infoHash,
      preferredService: body.preferredService ?? null,
      fileHint:
        body.season != null && body.episode != null
          ? { season: body.season, episode: body.episode }
          : null,
    });
    const session = createStreamSession(db, config, auth, {
      upstreamUrl: directStream.streamURL,
      contentType: streamContentType(directStream.fileName),
      title: directStream.fileName,
      expiresInSeconds: body.expiresInSeconds,
    });
    audit(db, auth, "stream_session.debrid.create", "stream_session", session.id, {
      infoHash: body.infoHash,
      debridService: directStream.debridService,
    });
    return {
      stream: {
        ...directStream,
        streamURL: session.playbackUrl,
        playbackAuthorization: session.playbackAuthorization,
      },
      session,
    };
  });

  app.post("/api/streams/sessions/raw", async (request) => {
    const auth = requireAuth(db, request);
    requireCsrf(request);
    rateLimit(request, `streams:raw:${auth.profileId}`, 120, 60 * 1000);
    // A raw session plays an arbitrary upstream URL - there is no media identity
    // to certify, so it can never be made cap-safe. Refuse it outright for any
    // kid/capped profile (this is checked BEFORE the allowRawStreamUrls/admin
    // gate, which keys off the account role and would otherwise let a kid under
    // an owner/admin account through).
    if (auth.isKid || auth.maturityMax != null) {
      throw httpError(403, "Raw stream sessions are not available on this profile.");
    }
    if (!config.allowRawStreamUrls && !isAdmin(auth.role)) {
      throw httpError(403, "Raw stream sessions are disabled.");
    }
    const body = parseBody(rawStreamSessionSchema, request.body);
    const session = createStreamSession(db, config, auth, {
      upstreamUrl: body.upstreamUrl,
      contentType: body.contentType ?? null,
      title: body.title ?? null,
      expiresInSeconds: body.expiresInSeconds,
    });
    audit(db, auth, "stream_session.raw.create", "stream_session", session.id);
    return {
      session,
    };
  });

  app.get("/api/usage/streams", async (request) => {
    const auth = requireAuth(db, request);
    const query = parseBody(streamUsageQuerySchema, request.query);
    return streamUsageSummary(db, auth.profileId, query.days);
  });

  app.get("/api/admin/usage/streams", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    const query = parseBody(streamUsageQuerySchema, request.query);
    return adminStreamUsageSummary(db, query.days);
  });

  app.get("/api/admin/streams/active", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    return adminActiveStreamSessions(db);
  });

  // Stream kill-switch: an admin marks a live stream session revoked. The proxy
  // route (/api/stream/:id) already refuses sessions with a non-null revoked_at,
  // so the in-flight playback fails on its next range request.
  app.post("/api/admin/streams/:id/revoke", async (request) => {
    const auth = requireAuth(db, request);
    requireAdmin(auth);
    requireCsrf(request);
    const id = sessionIdParamSchema.parse((request.params as { id: string }).id);
    const result = db.sqlite
      .prepare(
        `UPDATE stream_sessions
         SET revoked_at = ?
         WHERE id = ?
           AND revoked_at IS NULL`,
      )
      .run(nowISO(), id);
    if (result.changes === 0) {
      throw httpError(404, "Active stream session not found.");
    }
    audit(db, auth, "stream_session.revoke", "stream_session", id);
    return { ok: true };
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/stream/:id",
    handler: async (request, reply) => {
      const auth = readAuth(db, request);
      const bearer = readBearerToken(request);
      if (auth == null && bearer == null) {
        throw httpError(401, "Authentication required.");
      }
      const id = (request.params as { id: string }).id;
      const row = db.sqlite
        .prepare(
          `SELECT id, profile_id, encrypted_upstream_url, content_type, expires_at
           FROM stream_sessions
           WHERE id = ?
             AND revoked_at IS NULL
             AND expires_at > ?
           LIMIT 1`,
        )
        .get(id, nowISO()) as
        | {
            id: string;
            profile_id: string;
            encrypted_upstream_url: string;
            content_type: string | null;
            expires_at: string;
          }
        | undefined;
      if (row == null) throw httpError(404, "Stream session not found.");
      const cookieAuthorized = auth?.profileId === row.profile_id;
      const bearerAuthorized = streamPlaybackTokenMatches(
        config,
        { id: row.id, profileId: row.profile_id, expiresAt: row.expires_at },
        bearer,
      );
      if (!cookieAuthorized && !bearerAuthorized) {
        throw httpError(404, "Stream session not found.");
      }

      const upstreamUrl = decryptSecret(row.encrypted_upstream_url, config.secretKey);
      const headers: Record<string, string> = {};
      const range = request.headers.range;
      if (typeof range === "string") headers.range = range;

      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());

      // SSRF guard: validate the URL (and every redirect hop) is http(s) and
      // resolves only to public addresses before the server fetches it. Private
      // addresses are allowed only when the operator opted into raw/local URLs
      // (dev default); production blocks them.
      const upstream = await fetchUpstreamSafely(
        upstreamUrl,
        {
          method: request.method,
          headers,
          signal: controller.signal,
        },
        config.allowRawStreamUrls,
      );

      reply.status(upstream.status);
      for (const header of [
        "accept-ranges",
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "last-modified",
      ]) {
        const value = upstream.headers.get(header);
        if (value != null) reply.header(header, value);
      }
      if (row.content_type != null && upstream.headers.get("content-type") == null) {
        reply.header("content-type", row.content_type);
      }

      if (request.method === "HEAD" || upstream.body == null) {
        recordStreamTransfer(db, {
          sessionId: row.id,
          profileId: row.profile_id,
          bytes: 0,
          status: upstream.status,
          completed: true,
        });
        return reply.send();
      }

      return reply.send(
        countedStream(db, {
          sessionId: row.id,
          profileId: row.profile_id,
          status: upstream.status,
          body: upstream.body as ReadableStream<Uint8Array>,
        }),
      );
    },
  });

  // Cookie-free external-player bridge. The capability is the same HMAC grant
  // returned with this one stream session, not an account-wide credential. It
  // remains bound to the session profile, expiry, and revocation row. Keeping
  // the token in a dedicated path lets Cloudflare Access users bypass ONLY
  // `/api/external-stream/*` while every account and API route stays behind
  // Access. Disable automatic request logging so the capability is not written
  // to the application log by Fastify/Pino.
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/external-stream/:id/:token",
    logLevel: "silent",
    handler: async (request, reply) => {
      const params = request.params as { id: string; token: string };
      const id = sessionIdParamSchema.parse(params.id);
      const bearer = z.string().trim().min(32).max(128).parse(params.token);
      const row = db.sqlite
        .prepare(
          `SELECT id, profile_id, encrypted_upstream_url, content_type, expires_at
           FROM stream_sessions
           WHERE id = ?
             AND revoked_at IS NULL
             AND expires_at > ?
           LIMIT 1`,
        )
        .get(id, nowISO()) as
        | {
            id: string;
            profile_id: string;
            encrypted_upstream_url: string;
            content_type: string | null;
            expires_at: string;
          }
        | undefined;
      if (
        row == null ||
        !streamPlaybackTokenMatches(
          config,
          { id: row.id, profileId: row.profile_id, expiresAt: row.expires_at },
          bearer,
        )
      ) {
        throw httpError(404, "Stream session not found.");
      }

      const upstreamUrl = decryptSecret(row.encrypted_upstream_url, config.secretKey);
      const headers: Record<string, string> = {};
      const range = request.headers.range;
      if (typeof range === "string") headers.range = range;

      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());
      const upstream = await fetchUpstreamSafely(
        upstreamUrl,
        {
          method: request.method,
          headers,
          signal: controller.signal,
        },
        config.allowRawStreamUrls,
      );

      reply.header("cache-control", "private, no-store");
      reply.header("referrer-policy", "no-referrer");
      reply.status(upstream.status);
      for (const header of [
        "accept-ranges",
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "last-modified",
      ]) {
        const value = upstream.headers.get(header);
        if (value != null) reply.header(header, value);
      }
      if (row.content_type != null && upstream.headers.get("content-type") == null) {
        reply.header("content-type", row.content_type);
      }

      if (request.method === "HEAD" || upstream.body == null) {
        recordStreamTransfer(db, {
          sessionId: row.id,
          profileId: row.profile_id,
          bytes: 0,
          status: upstream.status,
          completed: true,
        });
        return reply.send();
      }
      return reply.send(
        countedStream(db, {
          sessionId: row.id,
          profileId: row.profile_id,
          status: upstream.status,
          body: upstream.body as ReadableStream<Uint8Array>,
        }),
      );
    },
  });

  // --- Server-side transcoding (Phase 3b, opt-in) ----------------------------
  // When transcoding isn't available (flag off OR ffmpeg absent), both routes
  // 404 - indistinguishable from "not found" - and nothing above changes.

  /** Load + ownership-validate a stream session (same scoping as the proxy). */
  const loadTranscodeSession = (
    request: FastifyRequest,
  ): { id: string; encrypted_upstream_url: string } | null => {
    const auth = requireAuth(db, request);
    const id = (request.params as { id: string }).id;
    return (
      (db.sqlite
        .prepare(
          `SELECT id, encrypted_upstream_url
           FROM stream_sessions
           WHERE id = ? AND profile_id = ? AND revoked_at IS NULL AND expires_at > ?
           LIMIT 1`,
        )
        .get(id, auth.profileId, nowISO()) as
        | { id: string; encrypted_upstream_url: string }
        | undefined) ?? null
    );
  };

  // HLS manifest: starts/reuses an ffmpeg job and returns the playlist with each
  // segment URI rewritten to an absolute, auth'd API path.
  app.get("/api/stream/:id/index.m3u8", async (request, reply) => {
    if (!transcode.ready) throw httpError(404, "Transcoding is not available.");
    const row = loadTranscodeSession(request);
    if (row == null) throw httpError(404, "Stream session not found.");
    const upstreamUrl = decryptSecret(row.encrypted_upstream_url, config.secretKey);
    // SSRF: validate the FIRST hop before handing the URL to ffmpeg (private
    // addresses blocked unless the operator opted into raw URLs). Residual,
    // accepted for now (consistent with the DNS-rebinding note in ssrf.ts): ffmpeg
    // follows its OWN HTTP redirects, which are not re-validated per hop like the
    // proxy's fetchUpstreamSafely does. Low risk in practice - the only upstreams
    // are trusted debrid CDNs and admin-only raw sessions; a pre-resolve of the
    // terminal URL is deferred because it would re-fetch (and could consume)
    // single-use debrid links. Hardening follow-up: resolve+pin the final hop.
    await assertSafeUpstream(upstreamUrl, config.allowRawStreamUrls);
    const query = request.query as {
      profile?: string;
      start?: string;
      hdr?: string;
      subtitles?: string;
    };
    const profile: TranscodeClientProfile =
      query.profile === "high" || query.profile === "data-saver"
        ? query.profile
        : "adaptive";
    const startValue = Number(query.start);
    const startSeconds =
      Number.isFinite(startValue) && startValue > 0
        ? Math.min(86_400, Math.floor(startValue))
        : 0;
    // A browser H.264 transcode cannot preserve the source HDR metadata through
    // its yuv420p output. Accept the older `preserve` query as automatic
    // compatibility handling rather than advertising an HDR guarantee the
    // pipeline cannot make.
    const hdrPolicy: TranscodeHdrPolicy =
      query.hdr === "tone-map" ? "tone-map" : "auto";
    if (hdrPolicy === "tone-map" && !transcode.toneMappingAvailable) {
      throw httpError(
        501,
        "HDR tone mapping requires an ffmpeg build with the zscale filter.",
      );
    }
    const preserveSubtitles = query.subtitles === "preserve";
    const dir = await transcode.registry.ensureJob(row.id, upstreamUrl, {
      profile,
      startSeconds,
      hdrPolicy,
      preserveSubtitles,
    });
    let manifest = await readFile(join(dir, MANIFEST_NAME), "utf8");
    if (
      preserveSubtitles &&
      manifest.includes("#EXT-X-STREAM-INF")
    ) {
      const subtitleUri = `/api/stream/${encodeURIComponent(row.id)}/subtitles.vtt`;
      manifest = manifest.replace(
        /^#EXTM3U$/m,
        `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Embedded",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="${subtitleUri}"`,
      );
      manifest = manifest.replace(
        /^#EXT-X-STREAM-INF:(.+)$/gm,
        (_line, attributes: string) =>
          `#EXT-X-STREAM-INF:${attributes},SUBTITLES="subs"`,
      );
    }
    const rewritten = rewriteTranscodeManifest(manifest, row.id);
    reply.header("content-type", "application/vnd.apple.mpegurl");
    reply.header("cache-control", "no-store");
    reply.header("x-yawf-playback-decision", "transcode");
    reply.header("x-yawf-transcode-profile", profile);
    reply.header("x-yawf-transcode-start", String(startSeconds));
    return reply.send(rewritten);
  });

  // HLS child manifests, segments, and the optional subtitle sidecar. The
  // strict filename grammar rejects traversal and arbitrary files.
  app.get("/api/stream/:id/:asset", async (request, reply) => {
    if (!transcode.ready) throw httpError(404, "Transcoding is not available.");
    const asset = (request.params as { asset: string }).asset;
    if (
      !/^(?:(?:1080p|720p|480p)\.m3u8|(?:1080p|720p|480p)_seg_\d{5}\.ts|seg_\d{5}\.ts|subtitles\.vtt)$/.test(
        asset,
      )
    ) {
      throw httpError(404, "Not found.");
    }
    const row = loadTranscodeSession(request);
    if (row == null) throw httpError(404, "Stream session not found.");
    const dir = transcode.registry.dirFor(row.id);
    if (dir == null) throw httpError(404, "Transcode asset not found.");
    const path = join(dir, asset);
    if (!existsSync(path)) throw httpError(404, "Transcode asset not ready.");
    reply.header("cache-control", "no-store");
    if (asset.endsWith(".m3u8")) {
      const manifest = await readFile(path, "utf8");
      reply.header("content-type", "application/vnd.apple.mpegurl");
      return reply.send(rewriteTranscodeManifest(manifest, row.id));
    }
    if (asset.endsWith(".vtt")) {
      reply.header("content-type", "text/vtt; charset=utf-8");
      return reply.send(await readFile(path, "utf8"));
    }
    reply.header("content-type", "video/mp2t");
    return reply.send(createReadStream(path));
  });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  let config = loadConfig(options.config);
  const db = new AppDatabase(config.databasePath);

  // Transcoding (Phase 3b): probe ffmpeg ONLY when the operator opted in (zero
  // boot cost otherwise). transcodeReady gates the routes + the bootstrap
  // capability; the registry owns ffmpeg processes + temp dirs.
  const transcoder = options.transcoder ?? realTranscoder;
  const ffmpegPresent = config.enableTranscode ? await transcoder.detect() : false;
  const transcodeCapabilities =
    config.enableTranscode && ffmpegPresent && transcoder.capabilities != null
      ? await transcoder.capabilities().catch(() => ({
          toneMapping: false,
          videoEncoders: [],
          subtitleSidecar: false,
        }))
      : { toneMapping: false, subtitleSidecar: false };
  const availableVideoEncoders =
    transcodeCapabilities.videoEncoders ??
    (ffmpegPresent ? [config.transcodeVideoEncoder] : []);
  const effectiveVideoEncoder = availableVideoEncoders.includes(
    config.transcodeVideoEncoder,
  )
    ? config.transcodeVideoEncoder
    : availableVideoEncoders.includes("libx264")
      ? "libx264"
      : null;
  const transcodeReady =
    config.enableTranscode &&
    ffmpegPresent &&
    effectiveVideoEncoder != null;
  if (
    effectiveVideoEncoder != null &&
    effectiveVideoEncoder !== config.transcodeVideoEncoder
  ) {
    config = {
      ...config,
      transcodeVideoEncoder: effectiveVideoEncoder,
    };
  }
  const transcodeRegistry = new TranscodeRegistry(db, config, transcoder);
  if (transcodeReady) transcodeRegistry.start();

  const app = Fastify({
    logger: config.logger,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(compress, {
    global: true,
    threshold: 1_024,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https: wss:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'",
    );
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    const forwardedProto = Array.isArray(request.headers["x-forwarded-proto"])
      ? request.headers["x-forwarded-proto"][0]
      : request.headers["x-forwarded-proto"];
    if (request.protocol === "https" || (config.trustProxy && forwardedProto === "https")) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }

    if (config.bindSessionUserAgent) {
      const cookieValue = readSessionCookie(request);
      if (cookieValue != null) {
        const row = db.sqlite
          .prepare("SELECT user_agent FROM sessions WHERE id = ? AND token_hash = ? AND revoked_at IS NULL")
          .get(cookieValue.sessionId, sha256(cookieValue.rawToken)) as { user_agent: string | null } | undefined;
        const presented = request.headers["user-agent"] ?? null;
        if (row != null && row.user_agent !== presented) {
          db.sqlite
            .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
            .run(nowISO(), cookieValue.sessionId);
          clearSessionCookies(reply, config);
          audit(db, null, "auth.session.user_agent_mismatch", "session", cookieValue.sessionId, {
            ipHash: hashOptional(request.ip),
          });
        }
      }
    }

    const origin = Array.isArray(request.headers.origin)
      ? request.headers.origin[0]
      : request.headers.origin;
    const allowedOrigin = allowedCorsOrigin(origin, config);
    if (allowedOrigin != null) {
      reply.header("access-control-allow-origin", allowedOrigin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
      reply.header(
        "access-control-allow-headers",
        "content-type, x-csrf-token",
      );
      reply.header(
        "access-control-allow-methods",
        "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
      );
    }
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const zodError = error instanceof z.ZodError;
    const statusCode = zodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 500);
    const message = error instanceof Error ? error.message : "Request failed.";
    if (statusCode >= 500) app.log.error(error);
    // Debrid provider failures (invalid token, upstream 5xx) used to collapse
    // into "Internal server error.", leaving users with no hint that the fix
    // is re-entering a token in Settings. DebridError messages are static,
    // credential-free strings, so pass them through; everything else stays
    // generic.
    const isDebridError =
      error != null &&
      typeof error === "object" &&
      (error as { name?: string }).name === "DebridError";
    reply.status(statusCode).send({
      error: statusCode >= 500 && !isDebridError ? "Internal server error." : message,
      issues: zodError ? error.issues : undefined,
    });
  });

  app.addHook("onClose", async () => {
    await transcodeRegistry.stop();
    db.close();
  });

  registerRoutes(app, db, config, {
    ready: transcodeReady,
    toneMappingAvailable: transcodeCapabilities.toneMapping,
    subtitleSidecarAvailable:
      transcodeCapabilities.subtitleSidecar === true,
    availableVideoEncoders,
    registry: transcodeRegistry,
  });
  registerStaticApp(app, config);
  return app;
}
