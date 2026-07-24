// Local settings + service-construction layer.
//
// The native app keeps API keys / debrid tokens / indexer configs in GRDB +
// the keychain. The storage port (Phase 1.5) replaces the old localStorage
// stopgap with a real, typed, cross-platform persistence layer (IndexedDB via
// Dexie, behind the `Store` / `SecretStore` interfaces) that works in both a
// plain browser and the Tauri webview. API keys + tokens are routed through
// `SecretStore` (currently IndexedDB; an OS-keychain backend is the documented
// follow-up). Indexer + debrid configs live in their own Dexie tables.
//
// Env vars (`import.meta.env.VITE_*`) still provide a zero-config default so the
// app works for a screenshot without touching Settings; any value saved in
// Settings overrides the env default and is persisted to the Store.
//
// This module also builds the shared, READ-ONLY service instances the screens
// call: TMDBService / OMDBService / DebridManager / IndexerManager and the AI
// provider. Nothing under services/ or models/ is modified.

import { TMDBService } from "../services/metadata/TMDBService";
import { OMDBService } from "../services/metadata/OMDBService";
import { embeddedOmdbKey } from "./embeddedOmdb";
import { embeddedTmdbKey } from "./embeddedTmdb";
import { DebridManager } from "../services/debrid/DebridManager";
import type { DebridService } from "../services/debrid/types";
import { DebridServiceType } from "../services/debrid/models";
import { RealDebridService } from "../services/debrid/RealDebridService";
import { AllDebridService } from "../services/debrid/AllDebridService";
import { PremiumizeService } from "../services/debrid/PremiumizeService";
import { TorBoxService } from "../services/debrid/TorBoxService";
import { IndexerManager } from "../services/indexers/IndexerManager";
import {
  type IndexerConfig,
  IndexerType,
  makeIndexerConfig,
} from "../services/indexers/types";
import type { AIAssistantProvider } from "../services/ai/types";
import { AIProviderKind, OPENAI_COMPATIBLE } from "../services/ai/models";
import { OpenAIProvider } from "../services/ai/OpenAIProvider";
import { AnthropicProvider } from "../services/ai/AnthropicProvider";
import { OllamaProvider } from "../services/ai/OllamaProvider";
import { getSecretStore, getStore } from "../storage";
import type { SecretStore } from "../storage";
import type { ScreenId } from "../components/NavRail";
import { appFetch } from "../lib/http";
import { isServerMode } from "../lib/serverMode";
import type { NetworkMode } from "../lib/networkPolicy";
import { DEFAULT_THEME_ID, resolveThemeId } from "../theme/themes";
import { normalizeLanguagePreference } from "../lib/languagePreference";
import {
  OpenSubtitlesClient,
  type SubtitleClient,
} from "../services/subtitles/OpenSubtitlesClient";
import { ServerSubtitlesClient } from "../services/subtitles/ServerSubtitlesClient";
import {
  SubtitleTranslator,
  type Translator,
} from "../services/subtitles/SubtitleTranslator";
import { ServerSubtitleTranslator } from "../services/subtitles/ServerSubtitleTranslator";
import {
  normalizeInterfaceLanguage,
  normalizeMetadataLanguage,
  normalizeMetadataRegion,
} from "../lib/localization";
import {
  type IndexerConfigRecord,
  makeIndexerConfigRecord,
  type StoredIndexerType,
  type StoredProviderSubtype,
} from "../storage/models";

const STORAGE_KEY = "debridstreamer.settings.v1";

/** Settings keys persisted in the Store's key-value table (mirror the Swift
 * SettingsKeys). Secret-valued keys are persisted via `SecretStore`, with a
 * `secret:<key>` marker left in the KV table so a later sweep can find them. */
const SettingsKeys = {
  tmdbApiKey: "tmdb_api_key",
  traktClientId: "trakt_client_id",
  traktClientSecret: "trakt_client_secret",
  traktScrobbleEnabled: "trakt_scrobble_enabled",
  omdbApiKey: "omdb_api_key",
  builtInIndexersEnabled: "built_in_indexers_enabled",
  aiProvider: "ai_provider",
  aiApiKey: "ai_api_key",
  aiModel: "ai_model",
  ollamaEndpoint: "ollama_endpoint",
  theme: "ui_theme",
  appearanceAccent: "appearance_accent",
  appearanceDensity: "appearance_density",
  appearanceTextSize: "appearance_text_size",
  appearanceMotion: "appearance_motion",
  appearanceRadius: "appearance_radius",
  appearanceBlur: "appearance_blur",
  appearanceChrome: "appearance_chrome",
  appearanceBackdrop: "appearance_backdrop",
  appearanceHeroScale: "appearance_hero_scale",
  appearancePanelContrast: "appearance_panel_contrast",
  appearanceNavLabels: "appearance_nav_labels",
  appearanceNavPosition: "appearance_nav_position",
  appearanceNavTint: "appearance_nav_tint",
  appearancePosterSize: "appearance_poster_size",
  appearanceDefaultTab: "appearance_default_tab",
  appearanceNavOrder: "appearance_nav_order",
  appearanceNavHidden: "appearance_nav_hidden",
  subtitleFontScale: "subtitle_font_scale",
  subtitleTextColor: "subtitle_text_color",
  subtitleBgOpacity: "subtitle_bg_opacity",
  defaultAudioLanguage: "default_audio_language",
  defaultSubtitleBehavior: "default_subtitle_behavior",
  defaultSubtitleLanguage: "default_subtitle_language",
  defaultPlaybackSpeed: "default_playback_speed",
  defaultVolume: "default_volume",
  rememberPerTitleTrackChoices: "remember_per_title_track_choices",
  openSubtitlesApiKey: "opensubtitles_api_key",
  autoUpdateChecks: "auto_update_checks",
  simpleMode: "simple_mode",
  autoInstallUpdates: "auto_install_updates",
  streamCachedOnly: "stream_cached_only",
  streamMaxQuality: "stream_max_quality",
  streamMaxSizeGB: "stream_max_size_gb",
  dataSaver: "data_saver",
  autoAdvanceEpisodes: "auto_advance_episodes",
  showWatchStats: "show_watch_stats",
  showPosterRatings: "show_poster_ratings",
  transcode: "transcode",
  ratingScale: "rating_scale",
  preferredExternalPlayer: "preferred_external_player",
  builtInPlayer: "built_in_player",
  userName: "user_name",
  userAvatar: "user_avatar",
  networkMode: "network_mode",
  interfaceLanguage: "interface_language",
  metadataLanguage: "metadata_language",
  metadataRegion: "metadata_region",
} as const;

/** Marker written into the KV table for secret-valued keys; the real value
 * lives in the SecretStore under the same key. Mirrors the Swift
 * `SecretReference` "keychain:" convention. */
const SECRET_MARKER = "secret:";

/** Keys whose values are credentials and must go through `SecretStore`. */
const SECRET_KEYS = new Set<string>([
  SettingsKeys.tmdbApiKey,
  SettingsKeys.traktClientId,
  SettingsKeys.traktClientSecret,
  SettingsKeys.omdbApiKey,
  SettingsKeys.aiApiKey,
  SettingsKeys.openSubtitlesApiKey,
]);

/** A user-configured external indexer (Torznab/Jackett/Prowlarr/Stremio addon).
 * `type` is the storage-layer indexer type, which includes `stremio_addon`
 * (persisted faithfully even though the ported web IndexerManager cannot build
 * one yet - see buildIndexerConfigs, which skips types the web factory lacks). */
export interface SourceEntry {
  id: string;
  type: StoredIndexerType;
  baseURL: string;
  apiKey?: string | null;
  isActive: boolean;
  displayName?: string | null;
  priority?: number;
}

/** A debrid token entry. */
export interface DebridTokenEntry {
  service: DebridServiceType;
  apiToken: string;
}

export type StreamMaxQuality = "any" | "4K" | "1080p" | "720p" | "480p" | "SD";
export type AppearanceAccent =
  | "theme"
  | "violet"
  | "cyan"
  | "rose"
  | "green"
  | "amber";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceTextSize = "s" | "m" | "l" | "xl";
export type AppearanceMotion = "system" | "normal" | "reduced";
export type AppearanceRadius = "sharp" | "default" | "round";
export type AppearanceChrome = "translucent" | "balanced" | "solid";
export type AppearanceBackdrop = "ambient" | "subtle" | "plain";
export type AppearanceHeroScale = "compact" | "standard" | "cinematic";
export type AppearancePanelContrast = "soft" | "standard" | "high";
export type AppearanceNavLabels = "auto" | "labels" | "icons";
export type AppearanceNavPosition = "side" | "bottom";
export type AppearanceNavTint = "airy" | "balanced" | "solid";
export type AppearancePosterSize = "compact" | "default" | "large";
export type DefaultSubtitleBehavior = "off" | "preferred";

/** Everything the user can configure, persisted to localStorage this phase. */
/** How the user rates a title on Detail. "ten" = 1–10, "hundred" = 0–100
 *  slider, "thumbs" = like/dislike. Default is "ten". */
export type RatingScale = "ten" | "hundred" | "thumbs";
function isRatingScale(v: unknown): v is RatingScale {
  return v === "ten" || v === "hundred" || v === "thumbs";
}
/** Coerce any persisted value to a legal scale, falling back to the 1–10 default
 * so a poisoned/stale blob can never render one control while another is saved. */
export function normalizeRatingScale(v: unknown): RatingScale {
  return isRatingScale(v) ? v : "ten";
}

export interface AppSettings {
  tmdbKey: string;
  /** Trakt OAuth app credentials (user-registered, like every other key in
   *  this app). Empty until the user connects Trakt. The access/refresh tokens
   *  themselves live outside AppSettings in traktConnection.ts. */
  traktClientId: string;
  traktClientSecret: string;
  /** Opt-in only: report actual player lifecycle events to Trakt. */
  traktScrobbleEnabled: boolean;
  omdbKey: string;
  debridTokens: DebridTokenEntry[];
  sources: SourceEntry[];
  builtInIndexersEnabled: boolean;
  aiProvider: AIProviderKind;
  aiApiKey: string;
  aiModel: string;
  ollamaEndpoint: string;
  /** Per-profile privacy policy for outbound network requests. */
  networkMode: NetworkMode;
  /** Interface language. "system" follows the device with an English fallback. */
  interfaceLanguage: string;
  /** BCP-47 language used for TMDB titles, summaries, genres, and trailers. */
  metadataLanguage: string;
  /** ISO 3166-1 alpha-2 region used for release windows and certifications. */
  metadataRegion: string;
  /** Selected UI theme id (see theme/themes.ts). */
  theme: string;
  appearanceAccent: AppearanceAccent;
  appearanceDensity: AppearanceDensity;
  appearanceTextSize: AppearanceTextSize;
  appearanceMotion: AppearanceMotion;
  appearanceRadius: AppearanceRadius;
  appearanceBlur: number;
  appearanceChrome: AppearanceChrome;
  appearanceBackdrop: AppearanceBackdrop;
  appearanceHeroScale: AppearanceHeroScale;
  appearancePanelContrast: AppearancePanelContrast;
  appearanceNavLabels: AppearanceNavLabels;
  /** Desktop nav placement: side rail (default) or a bottom bar. */
  appearanceNavPosition: AppearanceNavPosition;
  appearanceNavTint: AppearanceNavTint;
  appearancePosterSize: AppearancePosterSize;
  /** The nav destination the app lands on at launch. Default "discover". */
  appearanceDefaultTab: ScreenId;
  /** User's preferred order of nav items, by screen id. Reorder is scoped
   * within each nav group; ids missing here keep their default relative order,
   * and unknown ids are dropped. Empty means "default order". */
  appearanceNavOrder: ScreenId[];
  /** Nav items the user chose to hide, by screen id. "settings" is never
   * hideable (it hosts the Simple/Advanced toggle) and is stripped on load. */
  appearanceNavHidden: ScreenId[];
  /** Subtitle appearance, applied to the player's `::cue` (ported from
   * VPStudio's subtitle settings): font scale (1 = default), text color (hex),
   * and caption-background opacity (0–0.95). */
  subtitleFontScale: number;
  subtitleTextColor: string;
  subtitleBgOpacity: number;
  /** Preferred audio language. Empty preserves the stream's original default. */
  defaultAudioLanguage?: string;
  /** Whether a preferred subtitle language should be selected automatically. */
  defaultSubtitleBehavior?: DefaultSubtitleBehavior;
  /** Preferred subtitle language. Empty preserves subtitles off by default. */
  defaultSubtitleLanguage?: string;
  /** Speed used when no remembered per-title speed is available. */
  defaultPlaybackSpeed?: number;
  /** Initial player volume as an integer percentage from 0 through 100. */
  defaultVolume?: number;
  /** Restore a title's prior audio and subtitle choice before applying defaults. */
  rememberPerTitleTrackChoices?: boolean;
  /** OpenSubtitles REST API key (powers in-player subtitle search). */
  openSubtitlesApiKey: string;
  /** Progressive disclosure: Simple hides advanced tabs/controls. Local-Mode
   * source of truth (Server Mode reads it from the profile session instead). */
  simpleMode: boolean;
  /** Desktop builds check signed GitHub Releases on launch. */
  autoUpdateChecks: boolean;
  /** Desktop builds install signed updates automatically after a successful check. */
  autoInstallUpdates: boolean;
  /** Hide non-cached stream results by default. */
  streamCachedOnly: boolean;
  /** Highest stream quality to show. */
  streamMaxQuality: StreamMaxQuality;
  /** Maximum stream result size in GB; 0 disables the cap. */
  streamMaxSizeGB: number;
  /** Master Data Saver - clamps the stream list AND automatic (watchlist)
   *  playback to a bandwidth-friendly tier (≤720p, ≤5 GB) without transcoding. */
  dataSaver: boolean;
  /** Auto-play the next episode when a series episode ends (cached streams only). */
  autoAdvanceEpisodes: boolean;
  /** Opt-in: show a personal watch-stats card on the History screen (off by
   *  default so the screen stays uncluttered for users who don't want it). */
  showWatchStats: boolean;
  /** Keep the TMDB score visible on poster cards while browsing a catalog. */
  showPosterRatings: boolean;
  /** Server-Mode only: request the server's transcoded 720p HLS variant for
   *  playback (lower bitrate, re-encoded). Only effective when the server
   *  advertises transcodeAvailable. */
  transcode: boolean;
  /** Which rating control Detail shows (1–10, 0–100, or thumbs). */
  ratingScale: RatingScale;
  /** Chosen external player name (from list_external_players); "" = auto. */
  preferredExternalPlayer: string;
  /** Desktop: play MKV/HEVC/AV1 in the built-in libmpv window instead of
   *  handing off to an external player (VLC/mpv/IINA). The default in-window
   *  path on macOS, Windows, and Linux (X11); libmpv is bundled per-platform
   *  in web-release.yml. If the native surface can't init (e.g. Wayland, or a
   *  missing lib) playback falls back automatically to the webview transcode
   *  with the resume position preserved, then to an external player. */
  builtInPlayer: boolean;
  /** Local profile display name shown on the top-right avatar; "" = "You". */
  userName: string;
  /** Local profile avatar as a data: URL (resized on upload); "" = initial. */
  userAvatar: string;
}

/** Read a `VITE_*` env var without assuming `import.meta.env` exists. */
function env(key: string): string {
  const e = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  const v = e?.[key];
  return v && v.trim().length > 0 ? v.trim() : "";
}

export function normalizeStreamMaxQuality(value: unknown): StreamMaxQuality {
  return value === "4K" ||
    value === "1080p" ||
    value === "720p" ||
    value === "480p" ||
    value === "SD"
    ? value
    : "any";
}

export function normalizeStreamMaxSizeGB(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(500, Math.round(parsed * 10) / 10);
}

function normalizeAppearanceAccent(value: unknown): AppearanceAccent {
  return value === "violet" ||
    value === "cyan" ||
    value === "rose" ||
    value === "green" ||
    value === "amber"
    ? value
    : "theme";
}

function normalizeAppearanceDensity(value: unknown): AppearanceDensity {
  return value === "compact" ? "compact" : "comfortable";
}

function normalizeAppearanceTextSize(value: unknown): AppearanceTextSize {
  return value === "s" || value === "l" || value === "xl" ? value : "m";
}

function normalizeAppearanceMotion(value: unknown): AppearanceMotion {
  return value === "normal" || value === "reduced" ? value : "system";
}

function normalizeAppearanceRadius(value: unknown): AppearanceRadius {
  return value === "sharp" || value === "round" ? value : "default";
}

function normalizeAppearanceBlur(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 18;
  return Math.min(28, Math.max(6, Math.round(parsed)));
}

function normalizeAppearanceChrome(value: unknown): AppearanceChrome {
  return value === "translucent" || value === "solid" ? value : "balanced";
}

function normalizeAppearanceBackdrop(value: unknown): AppearanceBackdrop {
  return value === "subtle" || value === "plain" ? value : "ambient";
}

function normalizeAppearanceHeroScale(value: unknown): AppearanceHeroScale {
  return value === "compact" || value === "cinematic" ? value : "standard";
}

function normalizeAppearancePanelContrast(value: unknown): AppearancePanelContrast {
  return value === "soft" || value === "high" ? value : "standard";
}

function normalizeAppearanceNavLabels(value: unknown): AppearanceNavLabels {
  return value === "labels" || value === "icons" ? value : "auto";
}

function normalizeAppearanceNavPosition(value: unknown): AppearanceNavPosition {
  return value === "bottom" ? "bottom" : "side";
}

function normalizeAppearanceNavTint(value: unknown): AppearanceNavTint {
  return value === "airy" || value === "solid" ? value : "balanced";
}

function normalizeAppearancePosterSize(value: unknown): AppearancePosterSize {
  return value === "compact" || value === "large" ? value : "default";
}

/** The nav destinations a user can pick as their default landing tab. */
const DEFAULT_TAB_VALUES: readonly ScreenId[] = [
  "discover",
  "search",
  "library",
  "watchlist",
  "calendar",
  "history",
  "assistant",
  "debrid",
  "settings",
];
function normalizeAppearanceDefaultTab(value: unknown): ScreenId {
  return typeof value === "string" &&
    (DEFAULT_TAB_VALUES as readonly string[]).includes(value)
    ? (value as ScreenId)
    : "discover";
}

/** Every nav destination that can be reordered or hidden. Kept in sync with
 * NavRail's NAV_ITEMS; a superset of DEFAULT_TAB_VALUES (includes "downloads"). */
const NAV_SCREEN_IDS: readonly ScreenId[] = [
  "discover",
  "search",
  "library",
  "watchlist",
  "calendar",
  "history",
  "assistant",
  "debrid",
  "downloads",
  "settings",
];

/** Coerce a persisted nav-id list (a real array from the localStorage blob, or a
 * JSON string from the KV store) into a clean, de-duplicated ScreenId[]. Unknown
 * ids are dropped so a stale/poisoned blob can never inject a phantom nav entry.
 * When `dropSettings` is set, "settings" is stripped (it can never be hidden). */
function normalizeNavIdList(
  value: unknown,
  opts?: { dropSettings?: boolean },
): ScreenId[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ScreenId[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    if (!(NAV_SCREEN_IDS as readonly string[]).includes(entry)) continue;
    if (opts?.dropSettings && entry === "settings") continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry as ScreenId);
  }
  return out;
}

export function normalizeAppearanceNavOrder(value: unknown): ScreenId[] {
  return normalizeNavIdList(value);
}

export function normalizeAppearanceNavHidden(value: unknown): ScreenId[] {
  return normalizeNavIdList(value, { dropSettings: true });
}

function toFiniteNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function normalizeSubtitleFontScale(value: unknown): number {
  const n = toFiniteNumber(value);
  if (n == null) return 1;
  return Math.min(1.8, Math.max(0.7, Math.round(n * 100) / 100));
}

function normalizeSubtitleBgOpacity(value: unknown): number {
  const n = toFiniteNumber(value);
  if (n == null) return 0.55;
  return Math.min(0.95, Math.max(0, Math.round(n * 100) / 100));
}

function normalizeSubtitleTextColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : "#ffffff";
}

const DEFAULT_PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function normalizeDefaultPlaybackSpeed(value: unknown): number {
  const speed = toFiniteNumber(value);
  return speed != null && (DEFAULT_PLAYBACK_SPEEDS as readonly number[]).includes(speed)
    ? speed
    : 1;
}

export function normalizeDefaultVolume(value: unknown): number {
  const volume = toFiniteNumber(value);
  return volume == null ? 100 : Math.min(100, Math.max(0, Math.round(volume)));
}

function normalizeDefaultLanguage(value: unknown): string {
  return normalizeLanguagePreference(value) ?? "";
}

function normalizeDefaultSubtitleBehavior(value: unknown): DefaultSubtitleBehavior {
  return value === "preferred" ? "preferred" : "off";
}

/** Defaults: pull what we can from env so the app works with zero config. */
export function defaultSettings(): AppSettings {
  return {
    tmdbKey: env("VITE_TMDB_KEY"),
    traktClientId: "",
    traktClientSecret: "",
    traktScrobbleEnabled: false,
    omdbKey: env("VITE_OMDB_KEY"),
    debridTokens: [],
    sources: [],
    builtInIndexersEnabled: false,
    aiProvider: "anthropic",
    aiApiKey: env("VITE_AI_KEY"),
    aiModel: "",
    ollamaEndpoint: "http://localhost:11434",
    networkMode: "standard",
    interfaceLanguage: "system",
    metadataLanguage: "en-US",
    metadataRegion: "US",
    theme: env("VITE_THEME") || DEFAULT_THEME_ID,
    appearanceAccent: "cyan",
    appearanceDensity: "comfortable",
    appearanceTextSize: "m",
    appearanceMotion: "system",
    appearanceRadius: "default",
    appearanceBlur: 12,
    appearanceChrome: "solid",
    appearanceBackdrop: "subtle",
    appearanceHeroScale: "standard",
    appearancePanelContrast: "standard",
    appearanceNavLabels: "auto",
    appearanceNavPosition: "side",
    appearanceNavTint: "balanced",
    appearancePosterSize: "default",
    appearanceDefaultTab: "discover",
    appearanceNavOrder: [],
    appearanceNavHidden: ["assistant"],
    subtitleFontScale: 1,
    subtitleTextColor: "#ffffff",
    subtitleBgOpacity: 0.55,
    defaultAudioLanguage: "",
    defaultSubtitleBehavior: "off",
    defaultSubtitleLanguage: "",
    defaultPlaybackSpeed: 1,
    defaultVolume: 100,
    rememberPerTitleTrackChoices: true,
    openSubtitlesApiKey: env("VITE_OPENSUBTITLES_KEY"),
    simpleMode: true,
    autoUpdateChecks: true,
    autoInstallUpdates: false,
    streamCachedOnly: true,
    streamMaxQuality: "any",
    streamMaxSizeGB: 0,
    dataSaver: false,
    autoAdvanceEpisodes: true,
    showWatchStats: true,
    showPosterRatings: true,
    transcode: false,
    ratingScale: "ten",
    preferredExternalPlayer: "",
    // The in-window player is the DEFAULT on macOS (libmpv + its deps ship inside
    // the .app - see scripts/bundle-mpv-deps.sh). Turn it off to hand off to an
    // external player (VLC/IINA/…) instead. macOS-only; VideoPlayer falls back to
    // the external hand-off on other platforms regardless.
    builtInPlayer: true,
    userName: "",
    userAvatar: "",
  };
}

/** Load persisted settings (merged over defaults). Safe in SSR/no-localStorage. */
export function loadSettings(): AppSettings {
  const base = defaultSettings();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...base,
      ...parsed,
      // Don't let a missing array clobber the [] default.
      debridTokens: parsed.debridTokens ?? base.debridTokens,
      sources: parsed.sources ?? base.sources,
      traktScrobbleEnabled:
        typeof parsed.traktScrobbleEnabled === "boolean"
          ? parsed.traktScrobbleEnabled
          : base.traktScrobbleEnabled,
      showPosterRatings:
        typeof parsed.showPosterRatings === "boolean"
          ? parsed.showPosterRatings
          : base.showPosterRatings,
      streamMaxQuality: normalizeStreamMaxQuality(parsed.streamMaxQuality),
      streamMaxSizeGB: normalizeStreamMaxSizeGB(parsed.streamMaxSizeGB),
      appearanceAccent: normalizeAppearanceAccent(parsed.appearanceAccent),
      appearanceDensity: normalizeAppearanceDensity(parsed.appearanceDensity),
      appearanceTextSize: normalizeAppearanceTextSize(parsed.appearanceTextSize),
      appearanceMotion: normalizeAppearanceMotion(parsed.appearanceMotion),
      appearanceRadius: normalizeAppearanceRadius(parsed.appearanceRadius),
      appearanceBlur: normalizeAppearanceBlur(parsed.appearanceBlur),
      appearanceChrome: normalizeAppearanceChrome(parsed.appearanceChrome),
      appearanceBackdrop: normalizeAppearanceBackdrop(parsed.appearanceBackdrop),
      appearanceHeroScale: normalizeAppearanceHeroScale(parsed.appearanceHeroScale),
      appearancePanelContrast: normalizeAppearancePanelContrast(
        parsed.appearancePanelContrast,
      ),
      appearanceNavLabels: normalizeAppearanceNavLabels(parsed.appearanceNavLabels),
      appearanceNavPosition: normalizeAppearanceNavPosition(
        parsed.appearanceNavPosition,
      ),
      appearanceNavTint: normalizeAppearanceNavTint(parsed.appearanceNavTint),
      appearancePosterSize: normalizeAppearancePosterSize(parsed.appearancePosterSize),
      appearanceDefaultTab: normalizeAppearanceDefaultTab(parsed.appearanceDefaultTab),
      appearanceNavOrder: normalizeAppearanceNavOrder(parsed.appearanceNavOrder),
      appearanceNavHidden: normalizeAppearanceNavHidden(parsed.appearanceNavHidden),
      subtitleFontScale: normalizeSubtitleFontScale(parsed.subtitleFontScale),
      subtitleTextColor: normalizeSubtitleTextColor(parsed.subtitleTextColor),
      subtitleBgOpacity: normalizeSubtitleBgOpacity(parsed.subtitleBgOpacity),
      defaultAudioLanguage: normalizeDefaultLanguage(parsed.defaultAudioLanguage),
      defaultSubtitleBehavior: normalizeDefaultSubtitleBehavior(
        parsed.defaultSubtitleBehavior,
      ),
      defaultSubtitleLanguage: normalizeDefaultLanguage(parsed.defaultSubtitleLanguage),
      defaultPlaybackSpeed: normalizeDefaultPlaybackSpeed(parsed.defaultPlaybackSpeed),
      defaultVolume: normalizeDefaultVolume(parsed.defaultVolume),
      rememberPerTitleTrackChoices:
        typeof parsed.rememberPerTitleTrackChoices === "boolean"
          ? parsed.rememberPerTitleTrackChoices
          : base.rememberPerTitleTrackChoices,
      ratingScale: normalizeRatingScale(parsed.ratingScale),
      preferredExternalPlayer:
        typeof parsed.preferredExternalPlayer === "string"
          ? parsed.preferredExternalPlayer
          : "",
      userName: typeof parsed.userName === "string" ? parsed.userName : "",
      userAvatar:
        typeof parsed.userAvatar === "string" ? parsed.userAvatar : "",
      networkMode:
        parsed.networkMode === "fullLocal" || parsed.networkMode === "offline"
          ? parsed.networkMode
          : "standard",
      interfaceLanguage: normalizeInterfaceLanguage(parsed.interfaceLanguage),
      metadataLanguage: normalizeMetadataLanguage(parsed.metadataLanguage),
      metadataRegion: normalizeMetadataRegion(parsed.metadataRegion),
      // A stale/poisoned provider id would route to a host that can't serve it.
      aiProvider: AIProviderKind.allCases().includes(
        parsed.aiProvider as AIProviderKind,
      )
        ? (parsed.aiProvider as AIProviderKind)
        : base.aiProvider,
    };
  } catch {
    return base;
  }
}

/** Per-device marker for the one-time premium-redesign appearance refresh. Bump
 * the VERSION to re-run it on a future redesign. */
const DESIGN_REFRESH_KEY = "ds_design_refresh";
const DESIGN_REFRESH_VERSION = "2026-07-midnight-studio";

/** True while the one-time design refresh is still pending on this device.
 * False once it has been applied+persisted, or when localStorage is unavailable
 * (we can't track once-only there, so we skip rather than re-apply every load - 
 * SSR / private-mode / tests). */
function isDesignRefreshPending(): boolean {
  try {
    const store = globalThis.localStorage;
    if (!store) return false;
    return store.getItem(DESIGN_REFRESH_KEY) !== DESIGN_REFRESH_VERSION;
  } catch {
    return false;
  }
}

/**
 * Record that the design refresh has been applied AND durably persisted, so it
 * never runs again on this device. Call this ONLY after the refreshed settings
 * have been successfully written to the Store - that ordering is what makes a
 * failed Store write retry on the next load instead of being lost forever (the
 * reset is idempotent, so at worst a re-apply is a no-op).
 */
export function markDesignRefreshApplied(): void {
  try {
    globalThis.localStorage?.setItem(DESIGN_REFRESH_KEY, DESIGN_REFRESH_VERSION);
  } catch {
    /* best-effort: if we can't record the marker, the refresh re-applies next
       load - idempotent, so harmless. */
  }
}

/**
 * One-time redesign refresh: adopt the Midnight Studio appearance defaults for
 * installs that predate the redesign. It changes presentation only and remains
 * fully reversible in Settings. Keys, playback, privacy, debrid, and sources
 * are never touched.
 *
 * Does NOT record completion - the caller marks it via markDesignRefreshApplied()
 * only after the result is durably persisted, so a failed persist retries next
 * load instead of losing the redesign. Returns the same reference when nothing
 * changes, so callers can skip a redundant persist with an identity check.
 */
export function applyDesignRefresh(loaded: AppSettings): AppSettings {
  if (!isDesignRefreshPending()) return loaded;
  const d = defaultSettings();
  return {
    ...loaded,
    theme: d.theme,
    appearanceAccent: d.appearanceAccent,
    appearanceDensity: d.appearanceDensity,
    appearanceTextSize: d.appearanceTextSize,
    appearanceRadius: d.appearanceRadius,
    appearanceBlur: d.appearanceBlur,
    appearanceChrome: d.appearanceChrome,
    appearanceHeroScale: d.appearanceHeroScale,
    appearancePosterSize: d.appearancePosterSize,
    appearanceBackdrop: d.appearanceBackdrop,
    appearanceNavHidden: Array.from(
      new Set([...loaded.appearanceNavHidden, "assistant"]),
    ),
  };
}

/** Parse the RAW legacy localStorage blob WITHOUT merging env/defaults, so a
 * migration decision keyed on "does the legacy still hold secrets" can't be
 * fooled by build-time VITE_* default keys. Returns null when absent/unparseable. */
function readRawLegacyBlob(): Partial<AppSettings> | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return parsed != null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Has the Store already been written by a prior (possibly interrupted)
 * migration? ANY persisted KV key (other than the init flag) or ANY debrid/
 * indexer config row counts - so a partial Store of any shape isn't misread as
 * empty (which would let a redacted replay clear real data). */
async function storeHasAnyData(all: Record<string, string>): Promise<boolean> {
  const store = getStore();
  for (const key of Object.keys(all)) {
    if (key !== "storage_port_initialized") return true;
  }
  return (
    (await store.listDebridConfigs()).length > 0 ||
    (await store.listIndexerConfigs()).length > 0
  );
}

/** Persist settings. No-ops without localStorage. */
export function saveSettings(settings: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore (private mode / no storage).
  }
}

/** A copy of settings with every credential field blanked. The localStorage
 * bootstrap cache must NEVER hold plaintext secrets - those live only in the
 * SecretStore / OS keychain. localStorage is readable by any same-origin script
 * (XSS) and sits in plaintext on disk, so caching raw keys there would defeat
 * the SecretStore indirection. The synchronous bootstrap render only needs the
 * non-secret settings (theme, flags, …); the real keys arrive a tick later from
 * the async Store hydration, which rebuilds the services. */
export function redactSecrets(settings: AppSettings): AppSettings {
  return {
    ...settings,
    tmdbKey: "",
    traktClientId: "",
    traktClientSecret: "",
    omdbKey: "",
    aiApiKey: "",
    openSubtitlesApiKey: "",
    debridTokens: settings.debridTokens.map((t) => ({ ...t, apiToken: "" })),
    sources: settings.sources.map((s) => ({ ...s, apiKey: null })),
  };
}

// ---- Store-backed settings (the storage port) -------------------------------

/** Resolve a setting from a bulk KV snapshot, following the SecretStore marker
 * when the real value is kept outside the settings table. */
async function getStoredValue(
  all: ReadonlyMap<string, string>,
  key: string,
): Promise<string | null> {
  const raw = all.get(key);
  if (raw == null) return null;
  if (raw.startsWith(SECRET_MARKER)) {
    return getSecretStore().getSecret(raw.slice(SECRET_MARKER.length));
  }
  return raw;
}

/** Write a setting, routing credential-valued keys through SecretStore and
 * leaving a `secret:<key>` marker in the KV table. Mirrors SettingsManager. */
async function setStoredValue(
  key: string,
  value: string,
  // `mergeOnly` (used by the first-run migration) makes an EMPTY secret a no-op
  // instead of a removal: a stale/partial legacy blob must never clear a Store
  // secret it simply doesn't know about (it would otherwise wipe a credential the
  // user added after an interrupted migration).
  mergeOnly = false,
): Promise<void> {
  const store = getStore();
  if (SECRET_KEYS.has(key)) {
    const secrets = getSecretStore();
    if (value.trim().length > 0) {
      await secrets.setSecret(key, value);
      await store.setSetting(key, `${SECRET_MARKER}${key}`);
    } else if (mergeOnly) {
      // Additive migration: don't remove a Store secret the legacy lacks.
      return;
    } else {
      // Clear the KV marker FIRST so the value is unreferenced on the next load
      // even if the keychain purge below fails CLOSED (desktop). Then best-effort
      // delete the secret: a keychain failure here leaves an orphaned-but-
      // unreferenced credential, which must not abort the whole settings save.
      await store.setSetting(key, null);
      await deleteSecretBestEffort(secrets, key);
    }
    return;
  }
  await store.setSetting(key, value);
}

/** Normalized non-secret KV entries. Secrets and config-row reconciliation have
 * their own ordering/error semantics and deliberately stay outside this diff. */
function scalarSettingEntries(settings: AppSettings): Array<[string, string]> {
  return [
    [SettingsKeys.aiProvider, settings.aiProvider],
    [
      SettingsKeys.traktScrobbleEnabled,
      settings.traktScrobbleEnabled ? "true" : "false",
    ],
    [SettingsKeys.aiModel, settings.aiModel],
    [SettingsKeys.ollamaEndpoint, settings.ollamaEndpoint],
    [SettingsKeys.networkMode, settings.networkMode],
    [
      SettingsKeys.interfaceLanguage,
      normalizeInterfaceLanguage(settings.interfaceLanguage),
    ],
    [
      SettingsKeys.metadataLanguage,
      normalizeMetadataLanguage(settings.metadataLanguage),
    ],
    [SettingsKeys.metadataRegion, normalizeMetadataRegion(settings.metadataRegion)],
    [SettingsKeys.theme, resolveThemeId(settings.theme)],
    [SettingsKeys.appearanceAccent, normalizeAppearanceAccent(settings.appearanceAccent)],
    [SettingsKeys.appearanceDensity, normalizeAppearanceDensity(settings.appearanceDensity)],
    [SettingsKeys.appearanceTextSize, normalizeAppearanceTextSize(settings.appearanceTextSize)],
    [SettingsKeys.appearanceMotion, normalizeAppearanceMotion(settings.appearanceMotion)],
    [SettingsKeys.appearanceRadius, normalizeAppearanceRadius(settings.appearanceRadius)],
    [SettingsKeys.appearanceBlur, String(normalizeAppearanceBlur(settings.appearanceBlur))],
    [SettingsKeys.appearanceChrome, normalizeAppearanceChrome(settings.appearanceChrome)],
    [SettingsKeys.appearanceBackdrop, normalizeAppearanceBackdrop(settings.appearanceBackdrop)],
    [SettingsKeys.appearanceHeroScale, normalizeAppearanceHeroScale(settings.appearanceHeroScale)],
    [SettingsKeys.appearancePanelContrast, normalizeAppearancePanelContrast(settings.appearancePanelContrast)],
    [SettingsKeys.appearanceNavLabels, normalizeAppearanceNavLabels(settings.appearanceNavLabels)],
    [SettingsKeys.appearanceNavPosition, normalizeAppearanceNavPosition(settings.appearanceNavPosition)],
    [SettingsKeys.appearanceNavTint, normalizeAppearanceNavTint(settings.appearanceNavTint)],
    [SettingsKeys.appearancePosterSize, normalizeAppearancePosterSize(settings.appearancePosterSize)],
    [SettingsKeys.appearanceDefaultTab, normalizeAppearanceDefaultTab(settings.appearanceDefaultTab)],
    [SettingsKeys.appearanceNavOrder, JSON.stringify(normalizeAppearanceNavOrder(settings.appearanceNavOrder))],
    [SettingsKeys.appearanceNavHidden, JSON.stringify(normalizeAppearanceNavHidden(settings.appearanceNavHidden))],
    [SettingsKeys.subtitleFontScale, String(normalizeSubtitleFontScale(settings.subtitleFontScale))],
    [SettingsKeys.subtitleTextColor, normalizeSubtitleTextColor(settings.subtitleTextColor)],
    [SettingsKeys.subtitleBgOpacity, String(normalizeSubtitleBgOpacity(settings.subtitleBgOpacity))],
    [SettingsKeys.defaultAudioLanguage, normalizeDefaultLanguage(settings.defaultAudioLanguage)],
    [SettingsKeys.defaultSubtitleBehavior, normalizeDefaultSubtitleBehavior(settings.defaultSubtitleBehavior)],
    [SettingsKeys.defaultSubtitleLanguage, normalizeDefaultLanguage(settings.defaultSubtitleLanguage)],
    [SettingsKeys.defaultPlaybackSpeed, String(normalizeDefaultPlaybackSpeed(settings.defaultPlaybackSpeed))],
    [SettingsKeys.defaultVolume, String(normalizeDefaultVolume(settings.defaultVolume))],
    [
      SettingsKeys.rememberPerTitleTrackChoices,
      (settings.rememberPerTitleTrackChoices ?? true) ? "true" : "false",
    ],
    [SettingsKeys.autoUpdateChecks, settings.autoUpdateChecks ? "true" : "false"],
    [SettingsKeys.simpleMode, settings.simpleMode ? "true" : "false"],
    [SettingsKeys.autoInstallUpdates, settings.autoInstallUpdates ? "true" : "false"],
    [SettingsKeys.streamCachedOnly, settings.streamCachedOnly ? "true" : "false"],
    [SettingsKeys.streamMaxQuality, normalizeStreamMaxQuality(settings.streamMaxQuality)],
    [SettingsKeys.streamMaxSizeGB, String(normalizeStreamMaxSizeGB(settings.streamMaxSizeGB))],
    [SettingsKeys.dataSaver, settings.dataSaver ? "true" : "false"],
    [SettingsKeys.autoAdvanceEpisodes, settings.autoAdvanceEpisodes ? "true" : "false"],
    [SettingsKeys.showWatchStats, settings.showWatchStats ? "true" : "false"],
    [SettingsKeys.showPosterRatings, settings.showPosterRatings ? "true" : "false"],
    [SettingsKeys.transcode, settings.transcode ? "true" : "false"],
    [SettingsKeys.ratingScale, settings.ratingScale],
    [SettingsKeys.preferredExternalPlayer, settings.preferredExternalPlayer],
    [SettingsKeys.builtInPlayer, settings.builtInPlayer ? "true" : "false"],
    [SettingsKeys.userName, settings.userName],
    [SettingsKeys.userAvatar, settings.userAvatar],
    [SettingsKeys.builtInIndexersEnabled, settings.builtInIndexersEnabled ? "true" : "false"],
  ];
}

/** Credential-valued KV entries. Keeping this list beside the scalar entry list
 * lets steady-state saves diff every secret without changing first-run writes. */
function secretSettingEntries(settings: AppSettings): Array<[string, string]> {
  return [
    [SettingsKeys.tmdbApiKey, settings.tmdbKey],
    [SettingsKeys.traktClientId, settings.traktClientId],
    [SettingsKeys.traktClientSecret, settings.traktClientSecret],
    [SettingsKeys.omdbApiKey, settings.omdbKey],
    [SettingsKeys.aiApiKey, settings.aiApiKey],
    [SettingsKeys.openSubtitlesApiKey, settings.openSubtitlesApiKey],
  ];
}

/** Config order is significant because it supplies persisted priority. */
function sameDebridTokens(
  left: readonly DebridTokenEntry[],
  right: readonly DebridTokenEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.service === right[index].service &&
        entry.apiToken === right[index].apiToken,
    )
  );
}

/** Compare every SourceEntry field consumed by makeIndexerConfigRecord. */
function sameSources(
  left: readonly SourceEntry[],
  right: readonly SourceEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.id === other.id &&
        entry.type === other.type &&
        entry.baseURL === other.baseURL &&
        (entry.apiKey ?? null) === (other.apiKey ?? null) &&
        entry.isActive === other.isActive &&
        (entry.displayName ?? null) === (other.displayName ?? null) &&
        entry.priority === other.priority
      );
    })
  );
}

/** Best-effort secret deletion for the REMOVAL path. On the Tauri desktop build
 * `deleteSecret` fails CLOSED - it rejects if the OS keychain is locked/denied
 * (see KeychainSecretStore). But by the time we call this we have already
 * cleared the owning KV marker / config row, so the secret is unreferenced
 * (load only follows live markers/rows). A keychain failure therefore means at
 * worst a harmless value lingers in the keychain - it must NOT propagate and
 * abort the surrounding reconciliation (which would orphan the very row/marker
 * we just removed and leave the rest of the Save half-applied). Swallow + warn;
 * only the key NAME is logged, never a secret value. */
async function deleteSecretBestEffort(
  secrets: SecretStore,
  key: string,
): Promise<void> {
  try {
    await secrets.deleteSecret(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[settings] best-effort secret delete failed for "${key}" - the ` +
        `credential is now unreferenced but may linger in the keychain.`,
      err,
    );
  }
}

/** Load settings from the Store (KV + SecretStore + the debrid/indexer config
 * tables), merged over the env-derived defaults. Falls back to the legacy
 * localStorage blob on first run (one-time migration) so an existing user's
 * config is not lost. */
export async function loadSettingsFromStore(): Promise<AppSettings> {
  const base = defaultSettings();

  // One-time migration: if the Store has nothing yet but localStorage has a
  // legacy blob, seed the Store from it so the upgrade is seamless.
  const store = getStore();
  // One KV snapshot avoids serial IndexedDB reads for every scalar setting on
  // the first-paint path. RemoteStore implements the same Store contract.
  const all = await store.allSettings();
  const settingsByKey = new Map(Object.entries(all));
  const existingFlag = settingsByKey.get("storage_port_initialized") ?? null;
  // True when we took the migration SKIP branch (flag was unset but the Store
  // already held data). In that case the legacy cache may still hold un-migrated
  // plaintext, so the scrub at the end must NOT run this load (it would destroy
  // it); the next steady-state load redacts it.
  let skippedMigration = false;
  if (existingFlag == null) {
    const rawLegacy = readRawLegacyBlob();
    const storeHasData = await storeHasAnyData(all);

    // Replay ONLY into a genuinely empty Store. Once the Store holds ANY data - 
    // an interrupted migration's own writes, OR the user's later changes - the
    // migration must NOT replay: a stale/partial legacy blob (or its env-default
    // gaps) would overwrite newer Store credentials with old/blank values. The
    // decision uses the RAW blob's mere presence, never env-merged secrets.
    if (rawLegacy != null && !storeHasData) {
      const legacy = loadSettings();
      try {
        // Additive (mergeOnly) + don't redact the cache: a failed write leaves
        // the legacy plaintext intact for a retry. (Into an empty Store there's
        // nothing to overwrite anyway; mergeOnly is belt-and-suspenders.)
        await saveSettingsToStore(legacy, {
          redactCache: false,
          mergeOnly: true,
        });
      } catch {
        // Partial/failed migration: flag stays unset + cache intact → the next
        // launch retries from the still-authoritative legacy blob (no loss).
        return legacy;
      }
      // Durably committed: mark initialized, THEN redact the now-migrated cache.
      await store.setSetting("storage_port_initialized", "true");
      saveSettings(redactSecrets(legacy));
      return legacy;
    }
    // Store already populated (interrupted migration or the user's own data):
    // don't replay (no overwrite/wipe), mark initialized, and load the real
    // Store. Leave the legacy cache un-scrubbed this load (it may hold
    // un-migrated plaintext; the next steady-state load redacts it).
    await store.setSetting("storage_port_initialized", "true");
    skippedMigration = true;
  }

  const [
    tmdbKey,
    traktClientId,
    traktClientSecret,
    omdbKey,
    aiApiKey,
    openSubtitlesApiKey,
  ] = await Promise.all([
    getStoredValue(settingsByKey, SettingsKeys.tmdbApiKey),
    getStoredValue(settingsByKey, SettingsKeys.traktClientId),
    getStoredValue(settingsByKey, SettingsKeys.traktClientSecret),
    getStoredValue(settingsByKey, SettingsKeys.omdbApiKey),
    getStoredValue(settingsByKey, SettingsKeys.aiApiKey),
    getStoredValue(settingsByKey, SettingsKeys.openSubtitlesApiKey),
  ]);
  const [
    aiProvider,
    aiModel,
    ollamaEndpoint,
    builtIn,
    traktScrobbleEnabled,
    theme,
    appearanceAccent,
    appearanceDensity,
    appearanceTextSize,
    appearanceMotion,
    appearanceRadius,
    appearanceBlur,
    appearanceChrome,
    appearanceBackdrop,
    appearanceHeroScale,
    appearancePanelContrast,
    appearanceNavLabels,
    appearanceNavPosition,
    appearanceNavTint,
    appearancePosterSize,
    appearanceDefaultTab,
    appearanceNavOrder,
    appearanceNavHidden,
    subtitleFontScale,
    subtitleTextColor,
    subtitleBgOpacity,
    defaultAudioLanguage,
    defaultSubtitleBehavior,
    defaultSubtitleLanguage,
    defaultPlaybackSpeed,
    defaultVolume,
    rememberPerTitleTrackChoices,
    autoUpdateChecks,
    autoInstallUpdates,
    streamCachedOnly,
    streamMaxQuality,
    streamMaxSizeGB,
    dataSaver,
    autoAdvanceEpisodes,
    showWatchStats,
    showPosterRatings,
    transcode,
    simpleMode,
    ratingScale,
    preferredExternalPlayer,
    userName,
    userAvatar,
    builtInPlayer,
    networkMode,
    interfaceLanguage,
    metadataLanguage,
    metadataRegion,
  ] = [
    settingsByKey.get(SettingsKeys.aiProvider) ?? null,
    settingsByKey.get(SettingsKeys.aiModel) ?? null,
    settingsByKey.get(SettingsKeys.ollamaEndpoint) ?? null,
    settingsByKey.get(SettingsKeys.builtInIndexersEnabled) ?? null,
    settingsByKey.get(SettingsKeys.traktScrobbleEnabled) ?? null,
    settingsByKey.get(SettingsKeys.theme) ?? null,
    settingsByKey.get(SettingsKeys.appearanceAccent) ?? null,
    settingsByKey.get(SettingsKeys.appearanceDensity) ?? null,
    settingsByKey.get(SettingsKeys.appearanceTextSize) ?? null,
    settingsByKey.get(SettingsKeys.appearanceMotion) ?? null,
    settingsByKey.get(SettingsKeys.appearanceRadius) ?? null,
    settingsByKey.get(SettingsKeys.appearanceBlur) ?? null,
    settingsByKey.get(SettingsKeys.appearanceChrome) ?? null,
    settingsByKey.get(SettingsKeys.appearanceBackdrop) ?? null,
    settingsByKey.get(SettingsKeys.appearanceHeroScale) ?? null,
    settingsByKey.get(SettingsKeys.appearancePanelContrast) ?? null,
    settingsByKey.get(SettingsKeys.appearanceNavLabels) ?? null,
    settingsByKey.get(SettingsKeys.appearanceNavPosition) ?? null,
    settingsByKey.get(SettingsKeys.appearanceNavTint) ?? null,
    settingsByKey.get(SettingsKeys.appearancePosterSize) ?? null,
    settingsByKey.get(SettingsKeys.appearanceDefaultTab) ?? null,
    settingsByKey.get(SettingsKeys.appearanceNavOrder) ?? null,
    settingsByKey.get(SettingsKeys.appearanceNavHidden) ?? null,
    settingsByKey.get(SettingsKeys.subtitleFontScale) ?? null,
    settingsByKey.get(SettingsKeys.subtitleTextColor) ?? null,
    settingsByKey.get(SettingsKeys.subtitleBgOpacity) ?? null,
    settingsByKey.get(SettingsKeys.defaultAudioLanguage) ?? null,
    settingsByKey.get(SettingsKeys.defaultSubtitleBehavior) ?? null,
    settingsByKey.get(SettingsKeys.defaultSubtitleLanguage) ?? null,
    settingsByKey.get(SettingsKeys.defaultPlaybackSpeed) ?? null,
    settingsByKey.get(SettingsKeys.defaultVolume) ?? null,
    settingsByKey.get(SettingsKeys.rememberPerTitleTrackChoices) ?? null,
    settingsByKey.get(SettingsKeys.autoUpdateChecks) ?? null,
    settingsByKey.get(SettingsKeys.autoInstallUpdates) ?? null,
    settingsByKey.get(SettingsKeys.streamCachedOnly) ?? null,
    settingsByKey.get(SettingsKeys.streamMaxQuality) ?? null,
    settingsByKey.get(SettingsKeys.streamMaxSizeGB) ?? null,
    settingsByKey.get(SettingsKeys.dataSaver) ?? null,
    settingsByKey.get(SettingsKeys.autoAdvanceEpisodes) ?? null,
    settingsByKey.get(SettingsKeys.showWatchStats) ?? null,
    settingsByKey.get(SettingsKeys.showPosterRatings) ?? null,
    settingsByKey.get(SettingsKeys.transcode) ?? null,
    settingsByKey.get(SettingsKeys.simpleMode) ?? null,
    settingsByKey.get(SettingsKeys.ratingScale) ?? null,
    settingsByKey.get(SettingsKeys.preferredExternalPlayer) ?? null,
    settingsByKey.get(SettingsKeys.userName) ?? null,
    settingsByKey.get(SettingsKeys.userAvatar) ?? null,
    settingsByKey.get(SettingsKeys.builtInPlayer) ?? null,
    settingsByKey.get(SettingsKeys.networkMode) ?? null,
    settingsByKey.get(SettingsKeys.interfaceLanguage) ?? null,
    settingsByKey.get(SettingsKeys.metadataLanguage) ?? null,
    settingsByKey.get(SettingsKeys.metadataRegion) ?? null,
  ];

  const debridConfigs = await store.listDebridConfigs();
  const indexerConfigs = await store.listIndexerConfigs();

  const debridTokens: DebridTokenEntry[] = [];
  for (const c of debridConfigs) {
    // The token lives in SecretStore under the config id.
    const token = (await getSecretStore().getSecret(debridSecretKey(c.id))) ?? "";
    if (token.length > 0) {
      debridTokens.push({ service: c.service, apiToken: token });
    }
  }

  const sources: SourceEntry[] = indexerConfigs
    .filter((c) => c.type !== "built_in")
    .map((c) => ({
      id: c.id,
      type: c.type,
      baseURL: c.baseURL,
      apiKey: c.apiKey,
      isActive: c.isActive,
      displayName: c.displayName,
      priority: c.priority,
    }));

  const loaded: AppSettings = {
    tmdbKey: tmdbKey ?? base.tmdbKey,
    traktClientId: traktClientId ?? base.traktClientId,
    traktClientSecret: traktClientSecret ?? base.traktClientSecret,
    traktScrobbleEnabled:
      traktScrobbleEnabled == null
        ? base.traktScrobbleEnabled
        : traktScrobbleEnabled === "true",
    omdbKey: omdbKey ?? base.omdbKey,
    debridTokens,
    sources,
    builtInIndexersEnabled: builtIn == null ? base.builtInIndexersEnabled : builtIn === "true",
    aiProvider: AIProviderKind.allCases().includes(aiProvider as AIProviderKind)
      ? (aiProvider as AIProviderKind)
      : base.aiProvider,
    aiApiKey: aiApiKey ?? base.aiApiKey,
    aiModel: aiModel ?? base.aiModel,
    ollamaEndpoint: ollamaEndpoint ?? base.ollamaEndpoint,
    networkMode:
      networkMode === "fullLocal" || networkMode === "offline"
        ? networkMode
        : base.networkMode,
    interfaceLanguage: normalizeInterfaceLanguage(
      interfaceLanguage ?? base.interfaceLanguage,
    ),
    metadataLanguage: normalizeMetadataLanguage(
      metadataLanguage ?? base.metadataLanguage,
    ),
    metadataRegion: normalizeMetadataRegion(
      metadataRegion ?? base.metadataRegion,
    ),
    theme: resolveThemeId(theme ?? base.theme),
    appearanceAccent: normalizeAppearanceAccent(
      appearanceAccent ?? base.appearanceAccent,
    ),
    appearanceDensity: normalizeAppearanceDensity(
      appearanceDensity ?? base.appearanceDensity,
    ),
    appearanceTextSize: normalizeAppearanceTextSize(
      appearanceTextSize ?? base.appearanceTextSize,
    ),
    appearanceMotion: normalizeAppearanceMotion(
      appearanceMotion ?? base.appearanceMotion,
    ),
    appearanceRadius: normalizeAppearanceRadius(
      appearanceRadius ?? base.appearanceRadius,
    ),
    appearanceBlur: normalizeAppearanceBlur(appearanceBlur ?? base.appearanceBlur),
    appearanceChrome: normalizeAppearanceChrome(
      appearanceChrome ?? base.appearanceChrome,
    ),
    appearanceBackdrop: normalizeAppearanceBackdrop(
      appearanceBackdrop ?? base.appearanceBackdrop,
    ),
    appearanceHeroScale: normalizeAppearanceHeroScale(
      appearanceHeroScale ?? base.appearanceHeroScale,
    ),
    appearancePanelContrast: normalizeAppearancePanelContrast(
      appearancePanelContrast ?? base.appearancePanelContrast,
    ),
    appearanceNavLabels: normalizeAppearanceNavLabels(
      appearanceNavLabels ?? base.appearanceNavLabels,
    ),
    appearanceNavPosition: normalizeAppearanceNavPosition(
      appearanceNavPosition ?? base.appearanceNavPosition,
    ),
    appearanceNavTint: normalizeAppearanceNavTint(
      appearanceNavTint ?? base.appearanceNavTint,
    ),
    appearancePosterSize: normalizeAppearancePosterSize(
      appearancePosterSize ?? base.appearancePosterSize,
    ),
    appearanceDefaultTab: normalizeAppearanceDefaultTab(
      appearanceDefaultTab ?? base.appearanceDefaultTab,
    ),
    appearanceNavOrder: normalizeAppearanceNavOrder(
      appearanceNavOrder ?? base.appearanceNavOrder,
    ),
    appearanceNavHidden: normalizeAppearanceNavHidden(
      appearanceNavHidden ?? base.appearanceNavHidden,
    ),
    subtitleFontScale: normalizeSubtitleFontScale(
      subtitleFontScale ?? base.subtitleFontScale,
    ),
    subtitleTextColor: normalizeSubtitleTextColor(
      subtitleTextColor ?? base.subtitleTextColor,
    ),
    subtitleBgOpacity: normalizeSubtitleBgOpacity(
      subtitleBgOpacity ?? base.subtitleBgOpacity,
    ),
    defaultAudioLanguage: normalizeDefaultLanguage(
      defaultAudioLanguage ?? base.defaultAudioLanguage,
    ),
    defaultSubtitleBehavior: normalizeDefaultSubtitleBehavior(
      defaultSubtitleBehavior ?? base.defaultSubtitleBehavior,
    ),
    defaultSubtitleLanguage: normalizeDefaultLanguage(
      defaultSubtitleLanguage ?? base.defaultSubtitleLanguage,
    ),
    defaultPlaybackSpeed: normalizeDefaultPlaybackSpeed(
      defaultPlaybackSpeed ?? base.defaultPlaybackSpeed,
    ),
    defaultVolume: normalizeDefaultVolume(defaultVolume ?? base.defaultVolume),
    rememberPerTitleTrackChoices:
      rememberPerTitleTrackChoices == null
        ? base.rememberPerTitleTrackChoices
        : rememberPerTitleTrackChoices === "true",
    openSubtitlesApiKey: openSubtitlesApiKey ?? base.openSubtitlesApiKey,
    simpleMode: simpleMode == null ? base.simpleMode : simpleMode === "true",
    autoUpdateChecks:
      autoUpdateChecks == null ? base.autoUpdateChecks : autoUpdateChecks === "true",
    autoInstallUpdates:
      autoInstallUpdates == null ? base.autoInstallUpdates : autoInstallUpdates === "true",
    streamCachedOnly:
      streamCachedOnly == null ? base.streamCachedOnly : streamCachedOnly === "true",
    streamMaxQuality: normalizeStreamMaxQuality(streamMaxQuality ?? base.streamMaxQuality),
    streamMaxSizeGB: normalizeStreamMaxSizeGB(streamMaxSizeGB ?? base.streamMaxSizeGB),
    dataSaver: dataSaver == null ? base.dataSaver : dataSaver === "true",
    autoAdvanceEpisodes:
      autoAdvanceEpisodes == null
        ? base.autoAdvanceEpisodes
        : autoAdvanceEpisodes === "true",
    showWatchStats:
      showWatchStats == null ? base.showWatchStats : showWatchStats === "true",
    showPosterRatings:
      showPosterRatings == null ? base.showPosterRatings : showPosterRatings === "true",
    transcode: transcode == null ? base.transcode : transcode === "true",
    ratingScale: normalizeRatingScale(ratingScale),
    preferredExternalPlayer:
      typeof preferredExternalPlayer === "string" ? preferredExternalPlayer : "",
    builtInPlayer:
      builtInPlayer == null ? base.builtInPlayer : builtInPlayer === "true",
    userName: typeof userName === "string" ? userName : "",
    userAvatar: typeof userAvatar === "string" ? userAvatar : "",
  };

  // Proactively scrub any pre-existing plaintext-secret blob a prior build wrote
  // to localStorage: overwrite the bootstrap cache with a redacted snapshot now
  // that the Store/SecretStore is the source of truth. Suppressed when we just
  // skipped a migration (the cache may still hold un-migrated plaintext to be
  // recovered/redacted on the next, steady-state load).
  if (!skippedMigration) {
    saveSettings(redactSecrets(loaded));
  }

  return loaded;
}

/** Persist settings to the Store: scalar/secret keys to KV + SecretStore, and
 * the debrid/indexer configs to their tables (replacing the previous set so the
 * tables mirror exactly what the user configured).
 *
 * `redactCache` (default true) controls the localStorage bootstrap-cache sync.
 * The first-run migration passes `false` so the legacy plaintext blob is NOT
 * redacted as part of the write - the migration only redacts after the Store
 * write fully succeeds AND the init flag is durable, so a failed migration leaves
 * the plaintext legacy intact for a retry. */
export async function saveSettingsToStore(
  settings: AppSettings,
  options: { redactCache?: boolean; mergeOnly?: boolean; previous?: AppSettings } = {},
): Promise<void> {
  const { redactCache = true, mergeOnly = false, previous } = options;
  const store = getStore();
  const secrets = getSecretStore();

  // Collected WRITE failures - a fail-closed keychain credential write OR a
  // genuine KV/DB write error (quota, corruption, aborted txn). Either way the
  // value wasn't persisted and the user must be told. We persist everything we
  // can FIRST - so one failure never leaves the KV / debrid / indexer tables
  // half-reconciled - then surface them at the very end. (Kept deliberately
  // generic: this bucket mixes secret writes and plain setSetting writes, so the
  // surfaced error must not claim every failure was a "secret" write.)
  const writeFailures: unknown[] = [];

  // allSettled (not all): a single write that fails (keychain locked, or a DB
  // error) must not abort the remaining KV writes or the debrid/indexer
  // reconciliation below.
  const previousScalars =
    previous == null ? null : new Map(scalarSettingEntries(previous));
  const changedScalarWrites = scalarSettingEntries(settings).filter(
    ([key, value]) => mergeOnly || previousScalars == null || previousScalars.get(key) !== value,
  );
  const previousSecrets =
    previous == null ? null : new Map(secretSettingEntries(previous));
  const changedSecretWrites = secretSettingEntries(settings).filter(
    ([key, value]) => mergeOnly || previousSecrets == null || previousSecrets.get(key) !== value,
  );
  const kvResults = await Promise.allSettled([
    ...changedSecretWrites.map(([key, value]) => setStoredValue(key, value, mergeOnly)),
    ...changedScalarWrites.map(([key, value]) => store.setSetting(key, value)),
  ]);
  for (const r of kvResults) {
    if (r.status === "rejected") writeFailures.push(r.reason);
  }

  // Debrid configs: reconcile the table to the current token set. Tokens go in
  // SecretStore under `debrid.<id>`; the config row carries a secret marker.
  const reconcileDebrid =
    mergeOnly ||
    previous == null ||
    !sameDebridTokens(settings.debridTokens, previous.debridTokens);
  if (reconcileDebrid) {
    const existingDebrid = await store.listDebridConfigs();
    const keptDebridIds = new Set<string>();
    let priority = 0;
    for (const entry of settings.debridTokens) {
      if (entry.apiToken.trim().length === 0) continue;
      // Stable id per service so re-saving updates rather than duplicates.
      const id = `debrid-${entry.service}`;
      keptDebridIds.add(id);
      try {
        // Write the secret BEFORE the marker'd row. If the keychain write fails
        // closed (desktop), skip the row so we never persist a config pointing at
        // a secret we couldn't store (load would surface an empty token). Any
        // existing row for this id stays put - id is already in keptDebridIds, so
        // the removal sweep below won't delete it - and we record the failure so
        // the whole Save still completes and then reports it.
        await secrets.setSecret(debridSecretKey(id), entry.apiToken);
      } catch (err) {
        writeFailures.push(err);
        continue;
      }
      await store.saveDebridConfig({
        id,
        service: entry.service,
        apiToken: `${SECRET_MARKER}${debridSecretKey(id)}`,
        isActive: true,
        priority: priority++,
      });
    }
    // Skip removals under mergeOnly (first-run migration): a stale/partial legacy
    // blob must not delete debrid rows the Store gained after an interrupted run.
    if (!mergeOnly) {
      for (const c of existingDebrid) {
        if (!keptDebridIds.has(c.id)) {
          // Delete the config row FIRST so the removal is honored even if the
          // keychain purge fails closed (desktop); the secret delete is best-effort
          // cleanup. Doing it the other way round would, on a keychain failure,
          // orphan a config row whose marker points at a (maybe still-present)
          // keychain entry AND abort the rest of this reconciliation.
          await store.deleteDebridConfig(c.id);
          await deleteSecretBestEffort(secrets, debridSecretKey(c.id));
        }
      }
    }
  }

  // Indexer configs: reconcile to the current sources list (preserve order as
  // priority). A `built_in` row is written only to DISABLE the scrapers.
  const reconcileIndexers =
    mergeOnly ||
    previous == null ||
    settings.builtInIndexersEnabled !== previous.builtInIndexersEnabled ||
    !sameSources(settings.sources, previous.sources);
  if (reconcileIndexers) {
    const existingIndexers = await store.listIndexerConfigs();
    const keptIndexerIds = new Set<string>();
    // Await each write (not fire-and-forget): saveSettingsToStore() must not
    // resolve until the indexer rows are actually persisted, or a reload/app quit
    // immediately after Save could lose newly-added or edited sources.
    for (const [i, s] of settings.sources.entries()) {
      keptIndexerIds.add(s.id);
      const record: IndexerConfigRecord = makeIndexerConfigRecord({
        id: s.id,
        type: s.type,
        baseURL: s.baseURL,
        apiKey: s.apiKey ?? null,
        isActive: s.isActive,
        displayName: s.displayName ?? null,
        providerSubtype: providerSubtypeFor(s.type),
        priority: s.priority ?? i,
      });
      await store.saveIndexerConfig(record);
    }
    if (!settings.builtInIndexersEnabled) {
      keptIndexerIds.add("built-in");
      await store.saveIndexerConfig(
        makeIndexerConfigRecord({
          id: "built-in",
          type: "built_in",
          baseURL: "",
          isActive: false,
        }),
      );
    }
    if (!mergeOnly) {
      for (const c of existingIndexers) {
        if (!keptIndexerIds.has(c.id)) {
          await store.deleteIndexerConfig(c.id);
        }
      }
    }
  }

  // Keep the legacy localStorage blob in sync as a belt-and-suspenders cache so
  // the synchronous bootstrap render has a recent snapshot before hydration - 
  // but REDACTED: secrets live only in the SecretStore/keychain, never plaintext
  // in localStorage (see redactSecrets). The first-run migration opts out
  // (redactCache:false) so it can keep the legacy plaintext until the migration
  // is durably committed, then redact separately.
  if (redactCache) {
    saveSettings(redactSecrets(settings));
  }

  // Everything that COULD be persisted now has been (KV + debrid + indexer tables
  // are fully reconciled and the localStorage cache is in sync). If any write
  // failed (a fail-closed keychain credential write, or a KV/DB error), surface
  // it now so the caller can tell the user their change wasn't fully saved - 
  // without having lost the rest of the Save to a mid-flight abort. The message
  // stays generic because the bucket mixes secret and plain settings writes; the
  // wrapped `errors` carry each underlying cause for real diagnostics.
  // (Removals are best-effort and never land here.)
  if (writeFailures.length > 0) {
    throw new AggregateError(
      writeFailures,
      `saveSettingsToStore: ${writeFailures.length} settings write(s) failed to persist`,
    );
  }
}

/** The SecretStore key a debrid config's token is stored under (mirrors the
 * Swift `SecretKey.debridToken`). */
function debridSecretKey(configId: string): string {
  return `debrid.${configId}`;
}

/** Best-effort providerSubtype for a stored type (the stremio subtype has no
 * web factory yet but is persisted faithfully). */
function providerSubtypeFor(type: StoredIndexerType): StoredProviderSubtype {
  switch (type) {
    case "jackett":
      return "jackett";
    case "prowlarr":
      return "prowlarr";
    case "stremio_addon":
      return "stremio_addon";
    case "built_in":
      return "built_in";
    case "torznab":
    case "zilean":
      return "custom_torznab";
  }
}

// ---- Service construction ---------------------------------------------------

/** The shared service instances the screens consume. Any of them may be null
 * when the corresponding key/token isn't configured. */
export interface AppServices {
  tmdb: TMDBService | null;
  omdb: OMDBService | null;
  debrid: DebridManager | null;
  indexers: IndexerManager;
  ai: AIAssistantProvider | null;
  /** Subtitle source: the local OpenSubtitles client, the Server-Mode client, or
   *  null when no key is configured in Local Mode. */
  subtitles: SubtitleClient | null;
  /** Subtitle translator: local, Server-Mode, or null when no AI is configured. */
  translator: Translator | null;
  /** Whether anything was configured (vs. the fixtures/empty fallback path). */
  hasTMDB: boolean;
  hasDebrid: boolean;
  hasIndexers: boolean;
  hasAI: boolean;
  hasSubtitles: boolean;
}

/** Module-level cache for the built DebridManager, keyed by a signature of the
 * debrid config (service types + tokens). Its identity stays stable across
 * unrelated settings edits so useDebridLibrary does not refetch the whole
 * account on every save. Only a debrid config change rebuilds it. */
let debridManagerCache: { signature: string; manager: DebridManager } | null =
  null;
let indexerManagerCache: { signature: string; manager: IndexerManager } | null =
  null;
let tmdbServiceCache: { key: string; service: TMDBService } | null = null;

/** Build (or reuse the cached) TMDBService for the effective key. Keeps a stable
 * identity while the key is unchanged so an unrelated settings save (theme,
 * data-saver, debrid edit…) doesn't churn services.tmdb and force
 * useDiscover/useDetail to drop to a skeleton and refetch. Null for no key. */
function getOrBuildTmdb(
  effectiveTmdbKey: string,
  language: string,
  region: string,
): TMDBService | null {
  if (effectiveTmdbKey.length === 0) {
    tmdbServiceCache = null;
    return null;
  }
  const signature = JSON.stringify([
    effectiveTmdbKey,
    normalizeMetadataLanguage(language),
    normalizeMetadataRegion(region),
  ]);
  if (tmdbServiceCache != null && tmdbServiceCache.key === signature) {
    return tmdbServiceCache.service;
  }
  const service = new TMDBService(effectiveTmdbKey, undefined, {
    language: normalizeMetadataLanguage(language),
    region: normalizeMetadataRegion(region),
  });
  tmdbServiceCache = { key: signature, service };
  return service;
}

/** A stable signature for the debrid config: the (service, token) pairs in
 * order. Identical config → identical signature → cached manager reused. */
function debridConfigSignature(tokens: DebridTokenEntry[]): string {
  return JSON.stringify(
    tokens
      .map((t) => [t.service, t.apiToken.trim()] as const)
      .filter(([, token]) => token.length > 0),
  );
}

/** Build (or reuse the cached) DebridManager for the current settings. Returns
 * null when no valid debrid service is configured. The returned manager keeps a
 * stable identity while the debrid config is unchanged. */
function getOrBuildDebridManager(settings: AppSettings): DebridManager | null {
  const signature = debridConfigSignature(settings.debridTokens);
  const services = settings.debridTokens
    .map(buildDebridService)
    .filter((s): s is DebridService => s !== null);
  if (services.length === 0) {
    debridManagerCache = null;
    return null;
  }
  if (debridManagerCache != null && debridManagerCache.signature === signature) {
    return debridManagerCache.manager;
  }
  const manager = new DebridManager();
  // Register in the canonical priority order (DebridServiceType.allCases:
  // TorBox first), not token-entry order - insertion order IS the manager's
  // priority, so this decides which service wins cache badges + resolution.
  const priority = DebridServiceType.allCases();
  const ranked = [...services].sort(
    (a, b) => priority.indexOf(a.serviceType) - priority.indexOf(b.serviceType),
  );
  for (const s of ranked) manager.addService(s);
  debridManagerCache = { signature, manager };
  return manager;
}

/** Build (or reuse the cached) IndexerManager for the current settings. Keeps a
 * stable identity while the indexer config is unchanged - so an unrelated
 * settings save (e.g. a theme change) does NOT churn the manager's identity and
 * make the stream picker re-run a full indexer search + cache-check. Mirrors
 * getOrBuildDebridManager. */
function getOrBuildIndexerManager(settings: AppSettings): IndexerManager {
  const indexerConfigs = buildIndexerConfigs(settings);
  const signature = JSON.stringify(indexerConfigs);
  if (
    indexerManagerCache != null &&
    indexerManagerCache.signature === signature
  ) {
    return indexerManagerCache.manager;
  }
  // `appFetch` is CORS-free under Tauri (routes indexer/addon hosts through
  // Rust) and degrades to the global fetch in a plain browser.
  const manager = new IndexerManager(indexerConfigs, appFetch);
  indexerManagerCache = { signature, manager };
  return manager;
}

/** Real delay for the debrid retry/poll loops. The services default their
 *  `sleep` to a test no-op; in production we MUST pass a real timer or uncached
 *  transfers and 5xx-retry backoffs spin with zero wait - hammering the service
 *  and failing/rate-limiting instead of waiting for the torrent to cache. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function buildDebridService(entry: DebridTokenEntry): DebridService | null {
  const token = entry.apiToken.trim();
  if (token.length === 0) return null;
  // Route through `appFetch` so debrid hosts (CORS-blocked in a plain browser)
  // work in the Tauri desktop app; it degrades to the global fetch in a browser.
  // `realSleep` makes the retry/poll backoffs actually wait in production.
  switch (entry.service) {
    case "real_debrid":
      return new RealDebridService(token, appFetch, realSleep);
    case "all_debrid":
      return new AllDebridService(token, appFetch, realSleep);
    case "premiumize":
      return new PremiumizeService(token, appFetch, realSleep);
    case "torbox":
      return new TorBoxService(token, appFetch, realSleep);
  }
}

function buildIndexerConfigs(settings: AppSettings): IndexerConfig[] {
  const configs: IndexerConfig[] = [];
  // A built_in config is only needed to DISABLE the scrapers; the factory
  // enables them by default when absent.
  if (!settings.builtInIndexersEnabled) {
    configs.push(
      makeIndexerConfig({
        id: "built-in",
        type: IndexerType.builtIn,
        baseURL: "",
        isActive: false,
      }),
    );
  }
  settings.sources
    .filter((s) => s.isActive && s.baseURL.trim().length > 0)
    .forEach((s, i) => {
      // The ported web IndexerManager/factory build the Torznab family
      // (jackett/prowlarr/torznab/zilean) plus `stremio_addon` (now that the
      // StremioAddonIndexer is ported). `built_in` is handled above via the
      // scrapers toggle; any other type gates gracefully (skipped here).
      if (!WEB_BUILDABLE_INDEXER_TYPES.has(s.type)) return;
      configs.push(
        makeIndexerConfig({
          id: s.id,
          type: s.type as IndexerType,
          baseURL: s.baseURL.trim(),
          apiKey: s.apiKey ?? null,
          isActive: true,
          displayName: s.displayName ?? null,
          priority: s.priority ?? i,
        }),
      );
    });
  return configs;
}

/** The indexer types the ported web factory can actually construct. */
const WEB_BUILDABLE_INDEXER_TYPES = new Set<StoredIndexerType>([
  "jackett",
  "prowlarr",
  "torznab",
  "zilean",
  "stremio_addon",
]);

function buildAIProvider(settings: AppSettings): AIAssistantProvider | null {
  const key = settings.aiApiKey.trim();
  const model = settings.aiModel.trim();
  // Pass `undefined` for the model when none is configured so the provider's own
  // default model parameter applies; `appFetch` is threaded either way so AI
  // hosts work in the desktop app (degrades to global fetch in a browser).
  const modelArg = model.length > 0 ? model : undefined;
  const kind = settings.aiProvider;

  if (kind === "anthropic") {
    if (key.length === 0) return null;
    return new AnthropicProvider(key, modelArg, appFetch);
  }
  if (kind === "ollama") {
    const endpoint = settings.ollamaEndpoint.trim();
    if (endpoint.length === 0) return null;
    return new OllamaProvider(endpoint, modelArg, appFetch);
  }
  // Everything else is an OpenAI-compatible host (OpenAI, Gemini, OpenRouter,
  // Groq, Mistral, DeepSeek, xAI) - one provider class, different base URL.
  const compat = OPENAI_COMPATIBLE[kind];
  if (compat == null || key.length === 0) return null;
  return new OpenAIProvider(key, modelArg, appFetch, {
    baseURL: compat.baseURL,
    kind,
    label: AIProviderKind.displayName(kind),
    defaultModel: compat.defaultModel,
  });
}

/** Build-time TMDB key fallback (VITE_TMDB_KEY), read defensively. Lets the
 *  catalog light up in dev/screenshot builds before any key is saved. */
function readEnvTmdbKey(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  const key = env?.VITE_TMDB_KEY;
  return key && key.trim().length > 0 ? key.trim() : "";
}

/** Build the shared service instances from the current settings. */
export function buildServices(settings: AppSettings): AppServices {
  const tmdbKey = settings.tmdbKey.trim();
  const omdbKey = settings.omdbKey.trim();

  // TMDB key precedence: the user's own key (BYOK) -> a build-time embedded key
  // (the serverless limited-distribution path, so a fresh install shows a real
  // catalog instead of fixtures) -> a VITE_TMDB_KEY dev/screenshot fallback.
  // Driving `services.tmdb` (used by Search/Browse AND now Discover) from this
  // single source means saving a key in Settings lights up every screen - not
  // just Search/Browse - without a reload. Embedded is dormant by default (no
  // key baked in), so this changes nothing until a build sets TMDB_EMBED_KEY.
  const effectiveTmdbKey =
    tmdbKey.length > 0 ? tmdbKey : embeddedTmdbKey() || readEnvTmdbKey();
  const tmdb = getOrBuildTmdb(
    effectiveTmdbKey,
    settings.metadataLanguage,
    settings.metadataRegion,
  );
  // OMDb key precedence: the user's own key (BYOK) → a build-time embedded key
  // (the serverless limited-distribution path, Mode 3). In Server Mode leave
  // services.omdb null so ratings come from the server's /api/omdb "hidden key"
  // proxy instead of ever putting a key in the client.
  const effectiveOmdbKey =
    omdbKey.length > 0 ? omdbKey : isServerMode() ? "" : embeddedOmdbKey();
  const omdb = effectiveOmdbKey.length > 0 ? new OMDBService(effectiveOmdbKey) : null;

  // Debrid: priority order = insertion order (entry order in settings). The
  // manager is cached by config signature so its identity is stable across
  // unrelated settings edits (avoids re-fetching the whole account on, e.g., a
  // theme save) - only rebuilt when the debrid config actually changes.
  const debrid = getOrBuildDebridManager(settings);

  // Cached by indexer-config signature so its identity stays stable across
  // unrelated settings saves (a theme change must not re-run the stream search).
  const indexers = getOrBuildIndexerManager(settings);

  const ai = buildAIProvider(settings);

  // Subtitles. In Server Mode the OpenSubtitles + AI keys live on the server, so
  // search/download and translation route through it (the player is agnostic to
  // which client/translator it gets). Local Mode is unchanged: build the
  // OpenSubtitles client only when a key is set, and the translator only when an
  // AI provider is configured. `appFetch` is CORS-free under Tauri.
  const serverMode = isServerMode();
  const osKey = settings.openSubtitlesApiKey.trim();
  const subtitles: SubtitleClient | null = serverMode
    ? new ServerSubtitlesClient()
    : osKey.length > 0
      ? new OpenSubtitlesClient(osKey, appFetch)
      : null;
  const translator: Translator | null = serverMode
    ? new ServerSubtitleTranslator()
    : ai != null
      ? new SubtitleTranslator(
          {
            provider: settings.aiProvider,
            apiKey: settings.aiApiKey,
            model: settings.aiModel,
            ollamaEndpoint: settings.ollamaEndpoint,
          },
          appFetch,
        )
      : null;

  return {
    tmdb,
    omdb,
    debrid,
    indexers,
    ai,
    subtitles,
    translator,
    hasTMDB: tmdb !== null,
    hasDebrid: debrid !== null,
    hasIndexers: indexers.activeIndexers.length > 0,
    hasAI: ai !== null,
    hasSubtitles: subtitles !== null,
  };
}
