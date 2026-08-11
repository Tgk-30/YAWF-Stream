export type UserRole = "owner" | "admin" | "member" | "restricted";
export type CookieSameSite = "lax" | "strict" | "none";

export type CredentialProvider =
  | "tmdb"
  | "omdb"
  | "real_debrid"
  | "all_debrid"
  | "premiumize"
  | "torbox"
  | "openai"
  | "anthropic"
  | "ollama"
  | "opensubtitles"
  | "trakt";

export const CREDENTIAL_PROVIDERS: CredentialProvider[] = [
  "tmdb",
  "omdb",
  "real_debrid",
  "all_debrid",
  "premiumize",
  "torbox",
  "openai",
  "anthropic",
  "ollama",
  "opensubtitles",
  "trakt",
];

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  dataDir: string;
  webDistPath: string | null;
  secretKey: Buffer;
  /** Optional one-time owner-setup token. When configured, the first owner
   *  account cannot be created without this out-of-band token. */
  setupToken: string | null;
  /** Require every household viewer profile to have a password gate. */
  publicMode: boolean;
  cookieSecure: boolean;
  cookieSameSite: CookieSameSite;
  sessionTtlSeconds: number;
  /** Reject a session cookie when its User-Agent changes. */
  bindSessionUserAgent: boolean;
  /** Acknowledge an intentionally plain-HTTP public bind. */
  allowInsecurePublic: boolean;
  /** Check GitHub releases for a newer server container version. */
  updateCheck: boolean;
  allowRawStreamUrls: boolean;
  /** Explicit Direct P2P operator opt-in. False means WebTorrent is not loaded,
   * no registry/timer is created, and no torrent socket or cache path starts. */
  enableDirectTorrent: boolean;
  directTorrentMaxActive: number;
  directTorrentMaxSessions: number;
  directTorrentMaxSessionsPerProfile: number;
  directTorrentMetadataTimeoutMs: number;
  directTorrentMaxPeers: number;
  directTorrentMaxTorrentBytes: number;
  directTorrentDownloadLimitBps: number;
  directTorrentUploadLimitBps: number;
  directTorrentIdleTimeoutMs: number;
  /** Operator opt-in for server-side HLS transcoding (Phase 3b). Default false.
   *  When false - or when ffmpeg is absent at boot - the transcode routes 404 and
   *  the /api/stream/:id proxy is byte-for-byte unchanged. */
  enableTranscode: boolean;
  /** Max concurrent ffmpeg transcode jobs. Default 2 so one staged switch can
   * coexist with the active stream without exceeding the documented cap. */
  maxTranscodes: number;
  /** Bounded H.264 encoder selected by the server operator. Software is the
   * portable default; supported hardware encoders can be enabled explicitly. */
  transcodeVideoEncoder:
    | "libx264"
    | "h264_videotoolbox"
    | "h264_nvenc"
    | "h264_qsv";
  /** How long to wait for ffmpeg to produce the first HLS manifest+segment
   *  before giving up with a 504. Default 30s (raise on slow disks/CPUs). */
  transcodeStartTimeoutMs: number;
  trustProxy: boolean;
  corsOrigin: string | null;
  logger: boolean;
  /** Distribution tier this build/deploy targets - drives the client's
   *  onboarding flow (family = connect to your server, friends = self-host with
   *  baked keys, public = guided BYOK). Informational; not a security control. */
  buildProfile: "family" | "friends" | "public";
  /** "Hidden key" OMDb support: a server-held OMDb API key used to enrich
   *  titles with IMDb / Rotten Tomatoes / Metacritic ratings via the
   *  `/api/omdb/:imdbId` proxy. Lives ONLY on the server (this env value, or an
   *  encrypted server/profile credential) and is never sent to clients - so a
   *  limited-distribution build ships ratings with an unextractable key. A
   *  per-profile OMDb credential, when set, overrides this. Null = no
   *  server-provided OMDb (clients fall back to their own key, if any). */
  omdbApiKey: string | null;
  // ── Key broker (the truly-unextractable "friends" path) ──────────────────
  // Two roles; a server can be either or both:
  //   • CONSUMER (the friend's server): set `omdbBrokerUrl` + `brokerAuthToken`.
  //     It forwards OMDb lookups to the broker and holds NO OMDb key - only a
  //     revocable token - so the key is never on the friend's machine.
  //   • BROKER (the server YOU run): set `brokerTokens` (accepted tokens) and a
  //     real OMDb key. It answers /api/broker/omdb for valid tokens and returns
  //     only ratings, never the key.
  /** CONSUMER: base URL of the key broker to forward OMDb lookups to. */
  omdbBrokerUrl: string | null;
  /** CONSUMER: bearer token presented to the broker. */
  brokerAuthToken: string | null;
  /** BROKER: tokens this server accepts on /api/broker/* (comma-separated env). */
  brokerTokens: string[];
}

export interface AuthContext {
  userId: string;
  username: string;
  role: UserRole;
  /** The ACTIVE household sub-profile for this session (the "who's watching"
   * choice), resolved from sessions.active_profile_id with a fallback to the
   * account's is_default profile. All per-profile data scoping follows it. */
  profileId: string;
  displayName: string;
  /** The active profile's avatar tint (hex/keyword), or null for the default. */
  avatarColor: string | null;
  sessionId: string;
  /** Whether the active profile is in Simple (progressive-disclosure) mode. */
  simpleMode: boolean;
  /** Whether the active profile is a locked-down kid profile (search disabled,
   * curated movie-only browse). Independent of `maturityMax` in principle, but
   * an owner sets them together. */
  isKid: boolean;
  /** The active profile's maturity ceiling - a US movie certification
   * (G/PG/PG-13/R/NC-17), or null for no cap. The resolve play-block compares a
   * title's certification against this; null means unrestricted. */
  maturityMax: string | null;
}

export interface BuildAppOptions {
  config?: Partial<ServerConfig>;
  /** Test injection seam: swap the real ffmpeg child_process surface for a fake
   *  so CI never needs a real ffmpeg binary. Defaults to realTranscoder. */
  transcoder?: import("./transcode.js").Transcoder;
  /** Test injection seam. Used only when enableDirectTorrent is true, so a
   * flag-off test cannot accidentally start a fake or real swarm runtime. */
  directTorrentAdapter?: import("./directTorrent.js").DirectTorrentAdapter;
}
