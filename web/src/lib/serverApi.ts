import type { MediaType } from "../models/media";
import type { CastMember, Episode, MediaItem, MediaPreview, Season } from "../models/media";
import type { AIMovieRecommendation, AIUsageMetrics } from "../services/ai/models";
import type { DebridServiceType, StreamInfo } from "../services/debrid/models";
import type {
  SubtitleSearchParams,
  SubtitleSearchResult,
} from "../services/subtitles/OpenSubtitlesClient";
import type { SubtitleCue } from "../services/subtitles/cues";
import type { Genre, MediaCategory } from "../services/metadata/types";
import type { OMDBRatings } from "../services/metadata/OMDBService";
import type { StreamRow } from "../data/streams";
import type { UpcomingEpisode } from "./metadata";
import type { MovieRelease } from "../services/metadata/TMDBService";
import type { PortableProfileBundle } from "../data/portableBackup";
import { configuredServerURL } from "./serverMode";
import { notifyUnauthorized, readCsrfToken } from "./serverSession";

type JsonObject = Record<string, unknown>;

function serverBaseURL(): string {
  const baseURL = configuredServerURL();
  if (baseURL == null) throw new Error("Server Mode is not configured.");
  return baseURL;
}

async function serverRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<T> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  const unsafe = method !== "GET" && method !== "HEAD";
  if (body !== undefined) headers["content-type"] = "application/json";
  if (unsafe) {
    const csrf = readCsrfToken();
    if (csrf != null) headers["x-csrf-token"] = csrf;
  }

  const response = await fetch(`${serverBaseURL()}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: JsonObject = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as JsonObject;
    } catch {
      // Non-JSON body (e.g. an HTML 5xx page from a reverse proxy) - fall back to
      // a status-based message rather than throwing a misleading parse error.
      parsed = {};
    }
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : `Server request failed (${response.status}).`;
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return parsed as T;
}

export type RemoteCommandType =
  | "play"
  | "pause"
  | "seek-relative"
  | "seek-absolute"
  | "volume"
  | "mute"
  | "fullscreen"
  | "next"
  | "close";

export interface RemotePlaybackState {
  title: string | null;
  subtitle: string | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  volume: number;
  muted: boolean;
  updatedAt: string;
}

export interface TVRemoteSession {
  id: string;
  pairingCode: string;
  pairingExpiresAt: string;
  expiresAt: string;
}

export interface PhoneRemoteSession {
  id: string;
  controllerToken: string;
  expiresAt: string;
  state: RemotePlaybackState;
}

export interface TVRemoteCommand {
  sequence: number;
  type: RemoteCommandType;
  value?: number | boolean;
  createdAt: string;
}

export async function createTVRemoteSession(): Promise<TVRemoteSession> {
  return (
    await serverRequest<{ session: TVRemoteSession }>(
      "POST",
      "/api/remote/sessions",
    )
  ).session;
}

export async function pairPhoneRemote(input: {
  code: string;
  controllerName?: string | null;
}): Promise<PhoneRemoteSession> {
  return (
    await serverRequest<{ session: PhoneRemoteSession }>(
      "POST",
      "/api/remote/pair",
      input,
    )
  ).session;
}

export async function fetchTVRemoteSession(
  id: string,
  afterSequence: number,
): Promise<{
  paired: boolean;
  controllerName: string | null;
  expiresAt: string;
  state: RemotePlaybackState;
  commands: TVRemoteCommand[];
}> {
  return (
    await serverRequest<{
      session: {
        paired: boolean;
        controllerName: string | null;
        expiresAt: string;
        state: RemotePlaybackState;
        commands: TVRemoteCommand[];
      };
    }>(
      "GET",
      `/api/remote/sessions/${encodeURIComponent(id)}?after=${afterSequence}`,
    )
  ).session;
}

export async function updateTVRemoteState(
  id: string,
  state: Omit<RemotePlaybackState, "updatedAt">,
): Promise<RemotePlaybackState> {
  return (
    await serverRequest<{ state: RemotePlaybackState }>(
      "PUT",
      `/api/remote/sessions/${encodeURIComponent(id)}/state`,
      state,
    )
  ).state;
}

export async function fetchPhoneRemoteState(
  session: Pick<PhoneRemoteSession, "id" | "controllerToken">,
): Promise<RemotePlaybackState> {
  return (
    await serverRequest<{ session: { state: RemotePlaybackState } }>(
      "GET",
      `/api/remote/sessions/${encodeURIComponent(session.id)}/controller`,
      undefined,
      { "x-yawf-remote-token": session.controllerToken },
    )
  ).session.state;
}

export async function sendPhoneRemoteCommand(
  session: Pick<PhoneRemoteSession, "id" | "controllerToken">,
  command: { type: RemoteCommandType; value?: number | boolean },
): Promise<TVRemoteCommand> {
  return (
    await serverRequest<{ command: TVRemoteCommand }>(
      "POST",
      `/api/remote/sessions/${encodeURIComponent(session.id)}/commands`,
      command,
      { "x-yawf-remote-token": session.controllerToken },
    )
  ).command;
}

export async function revokeTVRemoteSession(id: string): Promise<void> {
  await serverRequest(
    "DELETE",
    `/api/remote/sessions/${encodeURIComponent(id)}`,
  );
}

export async function exportServerPortableProfile(): Promise<PortableProfileBundle> {
  return (
    await serverRequest<{ bundle: PortableProfileBundle }>(
      "GET",
      "/api/portability/export",
    )
  ).bundle;
}

export async function importServerPortableProfile(
  bundle: PortableProfileBundle,
  mode: "merge" | "replace" = "merge",
): Promise<{
  settings: number;
  watchlist: number;
  history: number;
  folders: number;
  library: number;
}> {
  return (
    await serverRequest<{
      ok: true;
      counts: {
        settings: number;
        watchlist: number;
        history: number;
        folders: number;
        library: number;
      };
    }>("POST", "/api/portability/import", { mode, bundle })
  ).counts;
}

function absoluteServerURL(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl).toString();
  } catch {
    return `${serverBaseURL()}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }
}

export async function fetchServerStreams(input: {
  imdbId: string;
  type: MediaType;
  season?: number | null;
  episode?: number | null;
  /** Human title for the server's name-matching indexer pass (APIBay etc.),
   *  which an imdb id alone can't reach. Optional - older servers ignore the
   *  extra query param and fall back to the imdb-only search. */
  title?: string | null;
  /** The item's release year - lets the server down-rank same-titled releases
   *  from a different year (movies only). Optional - older servers ignore the
   *  extra query param and keep the unranked-by-year order. */
  year?: number | null;
  /** Abort both source discovery and provider availability work when the title
   * changes or its Detail view closes. */
  signal?: AbortSignal;
  /** Receives indexer rows as soon as they are known, before provider cache
   * availability finishes. Current servers stream this in one request. */
  onPhase?: (
    phase: "sources" | "ready",
    result: ServerStreamsResponse,
  ) => void;
}): Promise<{
  rows: StreamRow[];
  hasIndexers: boolean;
  hasDebrid: boolean;
  sourceErrors?: Array<{ indexer: string; error: string }>;
}> {
  type ProgressiveEnvelope =
    | ({ phase: "sources" | "ready" } & ServerStreamsResponse)
    | { phase: "error"; error?: string };
  const normalize = (response: ServerStreamsResponse): ServerStreamsResponse => ({
    rows: response.rows ?? [],
    hasIndexers: response.hasIndexers === true,
    hasDebrid: response.hasDebrid === true,
    sourceErrors: response.sourceErrors ?? response.indexerErrors ?? [],
  });
  const params = new URLSearchParams({ type: input.type });
  if (input.season != null) params.set("season", String(input.season));
  if (input.episode != null) params.set("episode", String(input.episode));
  if (input.title != null && input.title.trim().length > 0) {
    params.set("title", input.title.trim());
  }
  if (input.year != null) params.set("year", String(input.year));
  if (input.onPhase != null) params.set("progressive", "1");
  const path = `/api/streams/${encodeURIComponent(input.imdbId)}?${params.toString()}`;

  if (input.onPhase == null) {
    const response = await serverRequest<ServerStreamsResponse>("GET", path);
    return normalize(response);
  }

  const response = await fetch(`${serverBaseURL()}${path}`, {
    method: "GET",
    credentials: "include",
    signal: input.signal,
  });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const text = await response.text();
    let message = `Server request failed (${response.status}).`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // A reverse proxy can return HTML. Keep the status-based message.
    }
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }

  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (reader == null) {
    throw new Error("The server returned an empty stream-search response.");
  }
  let buffer = "";
  let totalBytes = 0;
  let complete: ServerStreamsResponse | null = null;
  const consume = (text: string) => {
    const parsed = JSON.parse(text) as ProgressiveEnvelope | ServerStreamsResponse;
    if ("phase" in parsed && parsed.phase === "error") {
      throw new Error(
        typeof parsed.error === "string"
          ? parsed.error
          : "Stream search failed. Retry or check the configured indexers.",
      );
    }
    if ("phase" in parsed) {
      const phase = parsed.phase;
      const result = normalize(parsed);
      input.onPhase?.(phase, result);
      if (phase === "ready") complete = result;
      return;
    }
    // Compatibility with a server that ignores `progressive=1` and returns the
    // established one-document JSON response.
    complete = normalize(parsed);
    input.onPhase?.("ready", complete);
  };

  while (true) {
    const { done, value } = await reader.read();
    totalBytes += value?.byteLength ?? 0;
    if (totalBytes > 10_000_000) {
      await reader.cancel();
      throw new Error("The server returned an oversized stream-search response.");
    }
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) consume(line);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim().length > 0) consume(buffer.trim());
  if (complete == null) {
    throw new Error("The server ended stream search before availability was ready.");
  }
  return complete;
}

interface ServerStreamsResponse {
  rows: StreamRow[];
  hasIndexers: boolean;
  hasDebrid: boolean;
  sourceErrors?: Array<{ indexer: string; error: string }>;
  indexerErrors?: Array<{ indexer: string; error: string }>;
}

/** Validates a candidate debrid token against the provider SERVER-side.
 * Debrid hosts (TorBox in particular) send no CORS headers, so the client-side
 * check is meaningless in a webview/browser: in server mode the server is the
 * only party that can reach the provider API. */
export async function testServerDebridToken(input: {
  service: DebridServiceType;
  apiToken: string;
}): Promise<boolean> {
  const response = await serverRequest<{ valid: boolean }>(
    "POST",
    "/api/debrid/test",
    { service: input.service, apiToken: input.apiToken },
  );
  return response.valid === true;
}

export async function resolveServerStream(
  row: StreamRow,
  opts: {
    transcode?: boolean;
    transcodeOptions?: ServerTranscodeOptions;
    media?: { id: string; type: MediaType };
    /** Episode context (series) - steers season-pack file selection on the
     *  server. Omitted for movies / older servers (unknown fields ignored). */
    fileHint?: { season: number; episode: number } | null;
  } = {},
): Promise<StreamInfo> {
  const response = await serverRequest<{ stream: StreamInfo }>(
    "POST",
    "/api/streams/resolve",
    {
      infoHash: row.result.infoHash,
      preferredService: row.cachedOn,
      // The server needs the title context to enforce maturity gating on capped
      // (kid) profiles; it's ignored for normal profiles, so always send it.
      ...(opts.media != null
        ? { mediaId: opts.media.id, mediaType: opts.media.type }
        : {}),
      ...(opts.fileHint != null
        ? { season: opts.fileHint.season, episode: opts.fileHint.episode }
        : {}),
    },
  );
  const stream = {
    ...response.stream,
    streamURL: absoluteServerURL(response.stream.streamURL),
  };
  // Reuse the session's HLS manifest when the user explicitly requested lower
  // data use. The hosted web compatibility path calls the same helper when the
  // original format cannot be decoded by browsers.
  return opts.transcode
    ? asServerTranscodeStream(stream, opts.transcodeOptions)
    : stream;
}

/** Point an existing Server Mode proxy session at its HLS compatibility
 * manifest without resolving the torrent a second time. The server creates the
 * transcode lazily when this URL is first requested. */
export interface ServerTranscodeOptions {
  profile?: "adaptive" | "high" | "data-saver";
  startSeconds?: number;
  hdrPolicy?: "auto" | "preserve" | "tone-map";
  preserveSubtitles?: boolean;
}

export function asServerTranscodeStream(
  stream: StreamInfo,
  options: ServerTranscodeOptions = {},
): StreamInfo {
  const suffixAt = stream.streamURL.search(/[?#]/);
  const base = (
    suffixAt < 0 ? stream.streamURL : stream.streamURL.slice(0, suffixAt)
  ).replace(/\/+$/, "");
  const manifestBase = base.toLowerCase().endsWith("/index.m3u8")
    ? base
    : `${base}/index.m3u8`;
  const params = new URLSearchParams(
    suffixAt < 0 ? "" : stream.streamURL.slice(suffixAt).replace(/^[?#]/, ""),
  );
  if (options.profile != null) params.set("profile", options.profile);
  const startSeconds =
    options.startSeconds != null &&
    Number.isFinite(options.startSeconds) &&
    options.startSeconds > 0
      ? Math.min(86_400, Math.floor(options.startSeconds))
      : 0;
  if (startSeconds > 0) params.set("start", String(startSeconds));
  else params.delete("start");
  if (options.hdrPolicy != null) params.set("hdr", options.hdrPolicy);
  if (options.preserveSubtitles) params.set("subtitles", "preserve");
  else params.delete("subtitles");
  const query = params.toString();
  const streamURL = query.length > 0 ? `${manifestBase}?${query}` : manifestBase;
  if (
    stream.streamURL === streamURL &&
    (stream.timelineOffsetSeconds ?? 0) === startSeconds
  ) {
    return stream;
  }
  return {
    ...stream,
    streamURL,
    timelineOffsetSeconds: startSeconds,
  };
}

/** Build the capability URL consumed by native players launched from a hosted
 * browser. External players cannot inherit either the app's HttpOnly session
 * cookie or a Cloudflare Access browser cookie, so the server exposes one
 * narrowly scoped route authenticated by the stream session's existing bearer
 * capability. Operators using Cloudflare Access can bypass only
 * `/api/external-stream/*`; the capability remains bound to this stream,
 * profile, expiry, and server-side revocation state. */
export function serverExternalPlaybackURL(stream: StreamInfo): string | null {
  const authorization = stream.playbackAuthorization?.trim() ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/i.exec(authorization);
  if (match == null) return null;

  let streamUrl: URL;
  try {
    streamUrl = new URL(stream.streamURL);
  } catch {
    return null;
  }
  const pathMatch = /\/api\/stream\/([^/?#]+)/i.exec(streamUrl.pathname);
  if (pathMatch == null) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
  return `${streamUrl.origin}/api/external-stream/${encodeURIComponent(sessionId)}/${encodeURIComponent(match[1])}`;
}

export async function searchServerMedia(input: {
  query: string;
  type: MediaType | null;
  page?: number;
}): Promise<{
  items: MediaPreview[];
  page: number;
  totalPages: number;
  totalResults: number;
}> {
  const params = new URLSearchParams({
    q: input.query,
    type: input.type ?? "all",
    page: String(input.page ?? 1),
  });
  return serverRequest("GET", `/api/search?${params.toString()}`);
}

export async function fetchServerDiscoverHome(): Promise<{
  hero: MediaPreview | null;
  trendingMovies: MediaPreview[];
  trendingTV: MediaPreview[];
  popularMovies: MediaPreview[];
  topRatedMovies: MediaPreview[];
  nowPlayingMovies: MediaPreview[];
  upcomingMovies: MediaPreview[];
}> {
  return serverRequest("GET", "/api/discover/home");
}

export async function fetchServerCategory(input: {
  type: MediaType;
  category: "trending" | MediaCategory;
  page?: number;
}): Promise<{
  items: MediaPreview[];
  page: number;
  totalPages: number;
  totalResults: number;
}> {
  const params = new URLSearchParams({
    type: input.type,
    category: input.category,
    page: String(input.page ?? 1),
  });
  return serverRequest("GET", `/api/catalog/category?${params.toString()}`);
}

export async function discoverServerMedia(input: {
  type: MediaType;
  params: Record<string, string>;
}): Promise<{
  items: MediaPreview[];
  page: number;
  totalPages: number;
  totalResults: number;
}> {
  const params = new URLSearchParams({
    type: input.type,
    ...input.params,
  });
  return serverRequest("GET", `/api/catalog/discover?${params.toString()}`);
}

export async function fetchServerGenres(type: MediaType): Promise<Genre[]> {
  const params = new URLSearchParams({ type });
  const response = await serverRequest<{ genres: Genre[] }>(
    "GET",
    `/api/genres?${params.toString()}`,
  );
  return response.genres;
}

export async function fetchServerUpcomingEpisodes(
  series: MediaPreview[],
): Promise<UpcomingEpisode[]> {
  const response = await serverRequest<{ episodes: UpcomingEpisode[] }>(
    "POST",
    "/api/calendar/upcoming",
    { series },
  );
  return response.episodes;
}

/** Movie release dates resolved by the Server Mode TMDB broker. */
export async function fetchServerMovieReleases(): Promise<MovieRelease[]> {
  const response = await serverRequest<{ releases: MovieRelease[] }>(
    "GET",
    "/api/calendar/movies",
  );
  return response.releases;
}

export async function recommendServerAI(input: {
  prompt: string;
  count?: number;
}): Promise<{
  recommendations: AIMovieRecommendation[];
  model: string | null;
  usage: AIUsageMetrics | null;
}> {
  return serverRequest("POST", "/api/ai/recommend", {
    prompt: input.prompt,
    count: input.count ?? 8,
  });
}

export async function curateServerAI(input: {
  prompt: string;
  count?: number;
}): Promise<{ items: MediaPreview[]; unmatched: number }> {
  return serverRequest("POST", "/api/ai/curate", {
    prompt: input.prompt,
    count: input.count ?? 8,
  });
}

export async function searchServerSubtitles(
  params: SubtitleSearchParams,
): Promise<{ results: SubtitleSearchResult[] }> {
  return serverRequest("POST", "/api/subtitles/search", params);
}

export async function fetchServerSubtitle(
  fileId: string,
  imdbId?: string | null,
): Promise<{ vtt: string }> {
  return serverRequest("POST", "/api/subtitles/fetch", { fileId, imdbId });
}

export async function translateServerSubtitles(input: {
  cues: SubtitleCue[];
  targetLanguage: string;
}): Promise<{ cues: SubtitleCue[]; providerKind: string }> {
  return serverRequest("POST", "/api/subtitles/translate", input);
}

export async function revokeServerStreamSession(id: string): Promise<void> {
  await serverRequest(
    "POST",
    `/api/admin/streams/${encodeURIComponent(id)}/revoke`,
  );
}

// ---- Household sub-profiles ("who's watching") ----------------------------
// These talk to the account-scoped /api/account/profiles + /api/profiles/switch
// routes. A sub-profile is a viewer WITHIN the current account (no username; the
// password is optional), distinct from the admin account-management surface in
// Settings that uses /api/profiles. serverRequest already attaches credentials +
// the CSRF header on the unsafe methods.

export interface AccountProfile {
  id: string;
  displayName: string;
  avatarColor: string | null;
  simpleMode: boolean;
  isDefault: boolean;
  /** Kid mode locks the profile into the curated, search-disabled experience and
   *  pairs with a `maturityMax` cap. The server strictly couples the two. */
  isKid: boolean;
  /** US movie cert cap ("G"|"PG"|"PG-13"|"R"|"NC-17"), or null when not a kid. */
  maturityMax: string | null;
  /** A server-side household PIN is set. The PIN hash never leaves the server. */
  hasPin?: boolean;
  /** Kind of switch gate configured for this profile. */
  gateType?: "none" | "pin" | "password";
  /** Warn-only rolling 30-day household bandwidth data. */
  bandwidthCapBytes?: number | null;
  bandwidthUsageBytes?: number;
  bandwidthStatus?: "ok" | "approaching" | "over";
}

export interface AccountProfileState {
  profiles: AccountProfile[];
  activeProfileId: string;
  publicMode?: boolean;
}

export async function fetchAccountProfiles(): Promise<AccountProfileState> {
  return serverRequest("GET", "/api/account/profiles");
}

export async function createAccountProfile(input: {
  displayName: string;
  avatarColor?: string | null;
  password?: string | null;
  simpleMode?: boolean;
}): Promise<{ profile: AccountProfile }> {
  return serverRequest("POST", "/api/account/profiles", {
    displayName: input.displayName,
    avatarColor: input.avatarColor ?? null,
    // Only send a password when one was actually entered - the server treats it
    // as optional for household viewer profiles.
    ...(input.password != null && input.password.length > 0
      ? { password: input.password }
      : {}),
    simpleMode: input.simpleMode ?? true,
  });
}

export async function updateAccountProfile(
  id: string,
  patch: { displayName?: string; avatarColor?: string | null; simpleMode?: boolean },
): Promise<{ ok: true; profiles: AccountProfile[] }> {
  return serverRequest("PATCH", `/api/account/profiles/${encodeURIComponent(id)}`, patch);
}

export async function deleteAccountProfile(
  id: string,
): Promise<{ ok: true; profiles: AccountProfile[] }> {
  return serverRequest("DELETE", `/api/account/profiles/${encodeURIComponent(id)}`);
}

/** Owner/admin only. Sets kid mode + maturity cap together - the server rejects a
 *  half-state (kid without a cap, or a cap without kid mode) with a 400. */
export async function setProfileMaturity(
  id: string,
  body: { isKid: boolean; maturityMax: string | null },
): Promise<{ ok: true; profiles: AccountProfile[] }> {
  return serverRequest(
    "POST",
    `/api/account/profiles/${encodeURIComponent(id)}/maturity`,
    body,
  );
}

export async function switchAccountProfile(
  profileId: string,
  password?: string,
): Promise<{
  session: {
    profileId: string;
    displayName: string;
    avatarColor: string | null;
    role: "owner" | "admin" | "member" | "restricted";
    username: string;
    simpleMode: boolean;
  } | null;
  profiles: AccountProfileState | null;
}> {
  // The same server contract carries the account password when leaving a kid
  // profile and the target profile PIN when entering a PIN-protected profile.
  return serverRequest("POST", "/api/profiles/switch", {
    profileId,
    ...(password != null && password.length > 0 ? { password } : {}),
  });
}

/** Set or clear a viewer profile's 4-6 digit household PIN. The response is the
 * refreshed picker state so the lock glyph updates without a separate fetch. */
export async function setProfilePin(
  profileId: string,
  pin: string | null,
): Promise<{ profiles: AccountProfileState }> {
  return serverRequest("POST", "/api/profiles/pin", { profileId, pin });
}

export async function setProfilePassword(
  profileId: string,
  password: string,
): Promise<{ profiles: AccountProfileState }> {
  return serverRequest("POST", "/api/profiles/password", { profileId, password });
}

/** Owner/admin only. A rolling monthly household warning cap, never playback
 * enforcement. `null` clears the cap and returns refreshed picker state. */
export async function setProfileBandwidthQuota(
  profileId: string,
  capBytes: number | null,
): Promise<{ profiles: AccountProfileState }> {
  return serverRequest("POST", "/api/profiles/quota", { profileId, capBytes });
}

// ---- Title requests (Phase 4) ---------------------------------------------
// A "request" is a member asking an admin to add a title to the household. The
// shared `/api/library/requested` list surfaces APPROVED titles to everyone;
// the admin queue lives behind /api/admin/requests. serverRequest already
// attaches credentials + the CSRF header on the unsafe methods.

export interface RequestRecord {
  id: string;
  mediaId: string;
  preview: MediaPreview;
  status: "pending" | "approved" | "denied";
  decisionReason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  requestedByDisplayName: string | null;
  decidedByDisplayName: string | null;
}

/** File a title request. Throws with status 409 when the title already has a
 *  live pending request (the caller surfaces "Already requested"). */
export async function createRequest(
  mediaId: string,
  preview: MediaPreview,
): Promise<{ request: RequestRecord }> {
  return serverRequest("POST", "/api/library/requests", { mediaId, preview });
}

/** The caller's OWN requests, optionally filtered by status. */
export async function listOwnRequests(
  status?: RequestRecord["status"],
): Promise<{ requests: RequestRecord[] }> {
  const query = status != null ? `?status=${encodeURIComponent(status)}` : "";
  return serverRequest("GET", `/api/library/requests${query}`);
}

/** The SHARED, account-wide list of APPROVED titles. */
export async function listRequested(): Promise<{ items: RequestRecord[] }> {
  return serverRequest("GET", "/api/library/requested");
}

/** The admin moderation queue (defaults to pending). Admin only on the server. */
export async function adminListRequests(
  status?: RequestRecord["status"],
): Promise<{ requests: RequestRecord[] }> {
  const query = status != null ? `?status=${encodeURIComponent(status)}` : "";
  return serverRequest("GET", `/api/admin/requests${query}`);
}

/** Approve a pending request. Admin + CSRF on the server. */
export async function adminApproveRequest(id: string): Promise<{ ok: true }> {
  return serverRequest(
    "POST",
    `/api/admin/requests/${encodeURIComponent(id)}/approve`,
  );
}

/** Deny a pending request, optionally with a reason. Admin + CSRF on the server. */
export async function adminDenyRequest(
  id: string,
  reason?: string,
): Promise<{ ok: true }> {
  return serverRequest(
    "POST",
    `/api/admin/requests/${encodeURIComponent(id)}/deny`,
    reason != null && reason.trim().length > 0 ? { reason } : undefined,
  );
}

export async function fetchServerDetail(input: {
  id: string;
  type: MediaType;
}): Promise<{
  item: MediaItem;
  cast: CastMember[];
  related: MediaPreview[];
  imdbId: string | null;
}> {
  const params = new URLSearchParams({
    id: input.id,
    type: input.type,
  });
  return serverRequest("GET", `/api/media/detail?${params.toString()}`);
}

/** Fetch a series' seasons via the server metadata proxy (the TMDB key lives
 *  on the server). Callers treat any failure as "no episode guide". */
export async function fetchServerSeasons(input: {
  tmdbId: number;
}): Promise<{ seasons: Season[] }> {
  const params = new URLSearchParams({ tmdbId: String(input.tmdbId) });
  return serverRequest("GET", `/api/media/seasons?${params.toString()}`);
}

/** Fetch one season's episode list via the server metadata proxy. */
export async function fetchServerEpisodes(input: {
  tmdbId: number;
  season: number;
}): Promise<{ episodes: Episode[] }> {
  const params = new URLSearchParams({
    tmdbId: String(input.tmdbId),
    season: String(input.season),
  });
  return serverRequest("GET", `/api/media/episodes?${params.toString()}`);
}

/** Fetch OMDb ratings for an IMDb id via the server "hidden key" proxy. The
 *  server holds the key (profile / server / env) and returns only the parsed
 *  ratings - the key never reaches the client. Returns null when the server has
 *  no OMDb key for this profile. */
export async function fetchServerOmdb(imdbId: string): Promise<OMDBRatings | null> {
  const res = await serverRequest<{ ratings: OMDBRatings | null }>(
    "GET",
    `/api/omdb/${encodeURIComponent(imdbId)}`,
  );
  return res.ratings;
}

// ── Server first-run setup helpers ───────────────────────────────────────────
// Thin wrappers over the EXISTING admin endpoints the Settings → Server tab
// already drives. They exist so the guided Server setup wizard can reuse the
// same save/invite/health paths without re-implementing the fetch/CSRF plumbing
// (serverRequest above already handles credentials + x-csrf-token).

/** Provider key the setup wizard / Settings store credentials under. Mirrors
 *  CredentialProvider in Settings.tsx. */
export type ServerCredentialProvider =
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

/** Save (or overwrite) a SHARED server credential - same PUT the Server tab's
 *  "Save shared credential" button uses. Owner/admin only on the server. */
export async function saveServerSharedCredential(input: {
  provider: ServerCredentialProvider;
  label: string;
  value: string;
}): Promise<void> {
  await serverRequest("PUT", "/api/admin/credentials", {
    provider: input.provider,
    label: input.label.trim().length > 0 ? input.label : "Shared",
    value: input.value,
  });
}

interface ServerInviteResult {
  token: string;
  invite: { id: string };
}

/** Create a household invite - same POST the Server tab's invite form uses. The
 *  caller builds the shareable URL from the returned token. */
export async function createServerInvite(input: {
  label?: string;
  role: "member" | "admin" | "restricted";
  simpleMode: boolean;
  maxUses: number;
  expiresInSeconds: number;
}): Promise<ServerInviteResult> {
  return serverRequest<ServerInviteResult>("POST", "/api/admin/invites", {
    label: input.label?.trim() || undefined,
    role: input.role,
    simpleMode: input.simpleMode,
    maxUses: input.maxUses,
    expiresInSeconds: input.expiresInSeconds,
  });
}

/** Read the owner-only health summary so the setup gate can count existing
 *  credentials (and the wizard can show how many keys are configured). */
export async function fetchServerAdminHealth(): Promise<{
  counts: { credentials: number; profiles: number; activeInvites: number };
}> {
  return serverRequest("GET", "/api/admin/health");
}
