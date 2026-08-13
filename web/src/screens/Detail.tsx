// Detail screen - the showcase, fully wired.
//
// Renders for the currently-selected MediaPreview (from the app store):
//   • DetailHero (backdrop + title/meta/overview + Play + Watchlist toggle)
//   • StreamPicker - the cached-on-debrid stream list (green Instant · RD vs grey
//     Will cache), resolving a stream via DebridManager and launching the player.
//   • CastRail (TMDBService.getCast)
//   • "More like this" Rail (TMDBService.getRecommendations) → opens that detail.
//
// Detail metadata loads live via the shared TMDBService when configured, else a
// no-key fallback that still shows the hero. Streams need configured indexers +
// debrid; without them the picker shows a clear empty state.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore, useCachedResolutions } from "../store/AppStore";
import { useDetail } from "../data/detail";
import { useStreams } from "../data/streams";
import {
  defaultSelectionFor,
  episodeIdFor,
  episodeLabel,
  nextEpisodeFor,
  parseEpisodeId,
  useEpisodes,
  useSeasons,
} from "../data/episodes";
import { filterStreamRows } from "../data/streams";
import { EpisodePicker } from "../components/EpisodePicker";
import { DetailHero, type TasteSignal } from "../components/DetailHero";
import { RatingReveal } from "../components/RatingReveal";
import { DetailAnalysis } from "../components/DetailAnalysis";
import { OmdbRatings } from "../components/OmdbRatings";
import { StreamPicker } from "../components/StreamPicker";
import { CastRail } from "../components/CastRail";
import { TrailerModal } from "../components/TrailerModal";
import { useModalA11y } from "../components/useModalA11y";
import { useTrailer } from "../data/trailer";
import { Rail } from "../components/Rail";
import { Spinner } from "../components/Spinner";
import { Icon } from "../components/Icon";
import { isInWatchlist } from "../data/library";
import {
  VideoCodec,
  type DebridServiceType,
  type StreamInfo,
} from "../services/debrid/models";
import { MediaItem as MediaItemNS } from "../models/media";
import {
  TorrentResult,
  VideoQuality,
  type VideoQuality as VideoQualityValue,
} from "../services/indexers/models";
import type { StreamRow } from "../data/streams";
import { rankSources } from "../data/sourceIntelligence";
import {
  createRequest,
  fetchServerEpisodes,
  resolveServerStream,
  serverOptimizedSource,
  serverExternalPlaybackURL,
  type ServerTranscodeQuality,
} from "../lib/serverApi";
import { isServerMode } from "../lib/serverMode";
import { isDesktopTauri } from "../lib/tauri";
import { assertNetworkAllowed, getNetworkMode, isRequestExempt } from "../lib/networkPolicy";
import type { PlaybackEngine } from "../lib/playbackEngine";
import {
  playbackRecoverySessionIdentity,
  withFreshStreamResolutionTimeout,
} from "../lib/playbackStall";
import { getDownloadsBridge } from "../lib/downloadsBridge";
import {
  startDownloadsRuntime,
  type EnqueueDownloadInput,
} from "../services/downloads";
import {
  useTranscodeAvailable,
  useTranscodeCapabilities,
  useDirectTorrentAvailable,
} from "../lib/ServerSessionContext";
import { getStore } from "../storage";
import {
  hasResumePoint,
  watchProgressPercent,
  type PlaybackPrefs,
  type TasteEventType,
} from "../storage/models";
import type { NowPlayingMetadata } from "../components/player/PlayerPauseOverlay";
import { seriesIsWatched } from "../data/watchedState";
import { useDetailWatchedState } from "../data/useWatchedIds";
import {
  configureTraktScrobble,
  type TraktScrobbleContext,
} from "../data/traktScrobble";
import { rebuildTasteContext } from "../services/ai/TasteProfile";
import "./Detail.css";

// The VideoPlayer pulls in hls.js (large) and only mounts once the user starts
// playback, so it's code-split into its own chunk and kept out of the Detail
// chunk + the initial bundle.
const VideoPlayer = lazy(() =>
  import("../components/VideoPlayer").then((m) => ({ default: m.VideoPlayer })),
);

// Persisted per-title episode selection (see selectEpisode below).
const EPISODE_OVERRIDES_KEY = "ds_episode_overrides";
function loadEpisodeOverrides(): Record<string, { season: number; episode: number }> {
  try {
    const raw = globalThis.localStorage?.getItem(EPISODE_OVERRIDES_KEY);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object") return {};
    // Keep only well-formed entries so poisoned storage can't crash Detail.
    const out: Record<string, { season: number; episode: number }> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const sel = v as { season?: unknown; episode?: unknown };
      if (
        typeof sel?.season === "number" &&
        Number.isInteger(sel.season) &&
        sel.season >= 1 &&
        typeof sel?.episode === "number" &&
        Number.isInteger(sel.episode) &&
        sel.episode >= 1
      ) {
        out[k] = { season: sel.season, episode: sel.episode };
      }
    }
    return out;
  } catch {
    return {};
  }
}

interface ActivePlayer {
  url: string;
  /** Forces the renderer to reload even when a provider renews in place. */
  sourceRevision: number;
  title: string;
  /** Episode context belongs under the show title, never in the media source
   * filename. Null for movies and when metadata is unavailable. */
  subtitle: string | null;
  /** A lightweight snapshot of Detail metadata for the player pause screen. */
  nowPlaying: NowPlayingMetadata | null;
  /** Raw debrid path, visible in Playback information only. */
  sourceFileName: string | null;
  /** Exact renderer selected for this source. Never infer this from the URL in
   * diagnostics: a debrid direct link often has no useful extension. */
  engine: PlaybackEngine;
  /** Original Server Mode source. It supplies the stream-scoped external-player
   * capability and, when transcoding is available, the safe HLS fallback. */
  fallbackStream: StreamInfo | null;
  /** Saved resume position (seconds) to seek to on load; 0 starts fresh. */
  startPositionSeconds: number;
  /** Remembered audio/subtitle/speed for this (media, episode), snapshotted at
   *  play time and restored by the in-window player once tracks load. */
  savedPrefs: PlaybackPrefs | null;
  /** Episode context SNAPSHOTTED at play time (never the live picker
   *  selection) so progress writes + subtitle search track the episode that
   *  is actually playing. All null for movies. */
  episodeId: string | null;
  season: number | null;
  episode: number | null;
  /** Immutable TMDB identity for the item actually handed to the player. */
  scrobbleContext: TraktScrobbleContext | null;
  /** Torrent identity used by one-click source recovery. */
  sourceHash: string | null;
  /** Source provenance retained even when the live source list is empty. */
  recoverySource: StreamRow | null;
  /** Original timeline position represented by HLS time zero. */
  timelineOffsetSeconds: number;
  /** In-session controls preserved across a fresh source resolution. */
  playbackHandoff: {
    paused: boolean;
    volume: number;
    muted: boolean;
    playbackRate: number;
  } | null;
}

/** True when the resolved file is a container/codec the webview can't decode
 * directly (MKV/AVI/HEVC/AV1), so it needs either Real-Debrid transcode-to-HLS
 * (in-window) or a native-player hand-off. */
function needsTranscodeOrExternal(
  stream: StreamInfo,
  source?: TorrentResult,
): boolean {
  // A Server Mode compatibility transcode keeps the original filename and
  // codec as diagnostics, so its HLS URL is the authoritative playability
  // signal.
  if (stream.streamURL.split("?")[0].toLowerCase().endsWith(".m3u8")) {
    return false;
  }
  const name = stream.fileName.toLowerCase();
  const badContainer =
    name.endsWith(".mkv") ||
    name.endsWith(".avi") ||
    name.endsWith(".ts") ||
    name.endsWith(".wmv") ||
    name.endsWith(".flv");
  const parsedCodec = VideoCodec.parse(stream.fileName);
  const badCodec =
    stream.codec === VideoCodec.h265 ||
    stream.codec === VideoCodec.av1 ||
    parsedCodec === VideoCodec.h265 ||
    parsedCodec === VideoCodec.av1 ||
    (source != null &&
      (source.codec === VideoCodec.h265 || source.codec === VideoCodec.av1));
  return badContainer || badCodec;
}

function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseLanguageList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((language) => language.trim())
        .filter(Boolean),
    ),
  ];
}

type DownloadEstimate = {
  summary: string;
  detail: string;
};

function downloadEstimate(
  sourceSizeBytes: number,
  mode: "full" | "optimized",
  profile: "remux" | "h265",
): DownloadEstimate | null {
  if (!Number.isFinite(sourceSizeBytes) || sourceSizeBytes <= 0) return null;
  const sourceSize = formatDownloadSize(sourceSizeBytes);
  if (mode === "full") {
    return {
      summary: `Estimated total: ${sourceSize}`,
      detail: "The selected source's reported file size.",
    };
  }
  if (profile === "remux") {
    return {
      summary: `Estimated total: up to ${sourceSize}`,
      detail:
        "A remux keeps the source video, so it is roughly the same size minus any audio or subtitle tracks you drop.",
    };
  }
  return {
    summary: `Planning estimate: about ${formatDownloadSize(sourceSizeBytes * 0.5)}`,
    detail:
      `The ${sourceSize} source will be re-encoded to H.265. Final size can vary, and processing can take as long as the video or longer on some computers.`,
  };
}

export function Detail() {
  const {
    detailItem,
    closeDetail,
    openDetail,
    navigate,
    services,
    settings,
    watchlist,
    toggleWatchlist,
    recordResume,
    continueWatching,
    refreshContinueWatching,
    trailerOpen,
    openTrailer,
    closeTrailer,
    detailPlayerOpen,
    openDetailPlayer,
    closeDetailPlayer,
  } = useAppStore();
  const cachedResolutions = useCachedResolutions();
  configureTraktScrobble({
    enabled: settings.traktScrobbleEnabled,
    clientId: settings.traktClientId,
    clientSecret: settings.traktClientSecret,
  });
  const transcodeAvailable = useTranscodeAvailable();
  const transcodeCapabilities = useTranscodeCapabilities();
  const directTorrentAvailable = useDirectTorrentAvailable();
  // Older servers predate `qualities`. Their HLS compatibility fallback still
  // works, while the selectable Server Optimized control safely stays hidden.
  const serverOptimizedQualities = transcodeCapabilities.qualities ?? [];
  const triedSourceHashesRef = useRef<Set<string>>(new Set());
  const lastPlayerProgressRef = useRef(0);
  const playerPreferences = useMemo(
    () => ({
      defaultAudioLanguage: settings.defaultAudioLanguage ?? "",
      defaultSubtitleLanguage: settings.defaultSubtitleLanguage ?? "",
      defaultSubtitleBehavior: settings.defaultSubtitleBehavior ?? "off",
      defaultPlaybackSpeed: settings.defaultPlaybackSpeed ?? 1,
      defaultVolume: settings.defaultVolume ?? 100,
      rememberPerTitleTrackChoices: settings.rememberPerTitleTrackChoices ?? true,
    }),
    [
      settings.defaultAudioLanguage,
      settings.defaultSubtitleLanguage,
      settings.defaultSubtitleBehavior,
      settings.defaultPlaybackSpeed,
      settings.defaultVolume,
      settings.rememberPerTitleTrackChoices,
    ],
  );

  const detail = useDetail(detailItem, services.tmdb);

  // Series episode selection: a user's explicit pick (persisted per title so
  // "I was browsing S3" survives a restart) wins; otherwise default to the
  // most recently watched episode, else S1E1. Movies stay null throughout - 
  // zero behavior change.
  const [episodeOverrides, setEpisodeOverrides] = useState<
    Record<string, { season: number; episode: number }>
  >(() => loadEpisodeOverrides());
  const selectEpisode = (id: string, next: { season: number; episode: number }) => {
    setEpisodeOverrides((m) => {
      const merged = { ...m, [id]: next };
      // Bound the map so storage never balloons. String-key insertion order is
      // spec-guaranteed (media ids are "tmdb-…"/"tt…", never integer-like, so
      // no numeric reordering) - slice(-80) keeps the most recent entries.
      const keys = Object.keys(merged);
      const bounded =
        keys.length > 80
          ? Object.fromEntries(keys.slice(-80).map((k) => [k, merged[k]]))
          : merged;
      try {
        globalThis.localStorage?.setItem(
          EPISODE_OVERRIDES_KEY,
          JSON.stringify(bounded),
        );
      } catch {
        // private mode - session-only is fine
      }
      return bounded;
    });
  };
  const selected = useMemo(
    () =>
      detailItem?.type === "series"
        ? episodeOverrides[detailItem.id] ??
          defaultSelectionFor(detailItem.id, continueWatching)
        : null,
    [detailItem, episodeOverrides, continueWatching],
  );

  // Completion is deliberately sourced from complete history rows. The
  // Continue Watching slice below remains only for resume bars and positions.
  const [watchedRefreshVersion, setWatchedRefreshVersion] = useState(0);
  const watchedRefreshKey = useMemo(
    () => ({ continueWatching, watchedRefreshVersion }),
    [continueWatching, watchedRefreshVersion],
  );
  const watchedDetail = useDetailWatchedState(
    detailItem?.id,
    detailItem?.type,
    watchedRefreshKey,
  );
  const watchedMutationIds = useRef<Set<string>>(new Set());

  const streams = useStreams(
    detail.data.imdbId,
    detailItem?.type ?? "movie",
    selected?.season ?? null,
    selected?.episode ?? null,
    detailItem?.title ?? detail.data.item?.title ?? null,
    detailItem?.year ?? detail.data.item?.year ?? null,
    services.indexers,
    services.debrid,
  );

  // Download selection intentionally follows the current list's source order.
  // The first row at a selected resolution is the same "best currently listed"
  // source the existing download flow used before it had a resolution control.
  // Cached-only is a StreamPicker display default, not a download limitation:
  // debrid can queue an uncached source for download just as it did before.
  const downloadRows = useMemo(
    () => filterStreamRows(streams.rows, { ...settings, streamCachedOnly: false }),
    [streams.rows, settings],
  );
  const downloadQualities = useMemo(() => {
    const present = new Set(downloadRows.map((row) => row.result.quality));
    return [...present].sort(
      (left, right) => VideoQuality.sortOrder(right) - VideoQuality.sortOrder(left),
    );
  }, [downloadRows]);

  // Per-episode resume bars come from the resumable slice only. Watched checks
  // come from durable history above because completed rows are excluded here.
  const progressByEpisodeId = useMemo(() => {
    if (detailItem?.type !== "series") return {};
    const map: Record<string, number> = {};
    for (const r of continueWatching) {
      if (r.mediaId !== detailItem.id || r.episodeId == null) continue;
      if (!r.completed && hasResumePoint(r)) {
        map[r.episodeId] = watchProgressPercent(r);
      }
    }
    return map;
  }, [detailItem, continueWatching]);

  const [player, setPlayer] = useState<ActivePlayer | null>(null);
  const playerRef = useRef<ActivePlayer | null>(null);
  const playerSourceRevisionRef = useRef(0);
  const playbackEpochRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const detailIdRef = useRef(detailItem?.id ?? null);
  detailIdRef.current = detailItem?.id ?? null;
  const [scrollToStreams, setScrollToStreams] = useState(false);
  // Series show their streams on a dedicated page (opened by picking an
  // episode) instead of inline at the bottom of Detail; movies keep the inline
  // list since they have no episode step.
  const isSeries = detailItem?.type === "series";
  const [streamsPageOpen, setStreamsPageOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [downloadMode, setDownloadMode] = useState<"full" | "optimized">("full");
  const [downloadQuality, setDownloadQuality] = useState<VideoQualityValue | null>(null);
  const [downloadProfile, setDownloadProfile] = useState<"remux" | "h265">("remux");
  const [downloadAudioLanguages, setDownloadAudioLanguages] = useState("");
  const [downloadSubtitleLanguages, setDownloadSubtitleLanguages] = useState("");
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);

  useEffect(() => {
    setDownloadQuality((current) =>
      current != null && downloadQualities.includes(current)
        ? current
        : downloadQualities[0] ?? null,
    );
  }, [downloadQualities]);

  const selectedDownloadSource = useMemo(
    () =>
      downloadRows.find(
        (row) => downloadQuality == null || row.result.quality === downloadQuality,
      ) ?? null,
    [downloadQuality, downloadRows],
  );
  const selectedDownloadEstimate = useMemo(
    () =>
      selectedDownloadSource == null
        ? null
        : downloadEstimate(
            selectedDownloadSource.result.sizeBytes,
            downloadMode,
            downloadProfile,
          ),
    [downloadMode, downloadProfile, selectedDownloadSource],
  );

  useEffect(() => {
    if (!isDesktopTauri() || isServerMode()) {
      setFfmpegAvailable(false);
      return;
    }
    let cancelled = false;
    void getDownloadsBridge()
      .downloadsFfmpegAvailable()
      .then((available) => {
        if (!cancelled) setFfmpegAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setFfmpegAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The title's YouTube trailer (null while loading / when TMDB has none). Kept
  // above the early return so hook order stays stable.
  const trailer = useTrailer(
    // Prefer the fresh navigation target's id; detail.data.item can lag a title
    // change by a fetch. Falls back to the enriched id when the preview lacks one.
    detailItem?.tmdbId ?? detail.data.item?.tmdbId ?? null,
    detailItem?.type ?? null,
    services.tmdb,
  );

  // ── Next-episode action and auto-advance ──────────────────────────────────
  // The up-next target is computed from the PLAYER SNAPSHOT (never the live
  // picker selection) using TMDB season metadata for season boundaries; a
  // guide-less series falls back to a blind within-season increment inside
  // nextEpisodeFor (harmless: moving to it still requires a cached row).
  const seasonsState = useSeasons(
    detail.data.item?.tmdbId ?? detailItem?.tmdbId ?? null,
    detailItem?.type === "series",
    services.tmdb,
  );
  const selectedSeasonEpisodes = useEpisodes(
    detail.data.item?.tmdbId ?? detailItem?.tmdbId ?? null,
    selected?.season ?? null,
    services.tmdb,
  );
  const upNextTarget = useMemo(
    () =>
      player?.episodeId != null &&
      player.season != null &&
      player.episode != null
        ? nextEpisodeFor(
            { season: player.season, episode: player.episode },
            seasonsState.seasons,
          )
        : null,
    [player, seasonsState.seasons],
  );
  const seriesWatched =
    detailItem?.type === "series" &&
    seriesIsWatched(watchedDetail.episodeIds, seasonsState.seasons);
  // Pending auto-play for the just-advanced episode. Guards (per the design
  // review): busy ref blocks double-fire from rows-identity churn; the
  // selected-matches-pending gate ensures the stream list is already re-scoped
  // to the new episode; the selectedRef uniqueness check bails if the user
  // manually retargeted mid-resolve.
  const [autoPlayPending, setAutoPlayPending] = useState<{
    season: number;
    episode: number;
  } | null>(null);
  const autoPlayBusy = useRef(false);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const streamsAnchorRef = useRef<HTMLDivElement>(null);
  // Surface the stream list: series open the dedicated page, movies scroll to
  // the inline picker. Used by the hero Watch button and the auto-advance
  // fallback so both honor the same series-vs-movie split.
  const revealStreams = () => {
    if (isSeries) {
      setStreamsPageOpen(true);
    } else {
      streamsAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };
  const streamsBackRef = useRef<HTMLButtonElement>(null);
  // Each portal owns its own modal focus scope. Suspending the outer Detail
  // scope while the streams page is open prevents its Tab handler from pulling
  // focus back out of the body-level portal.
  const rootRef = useModalA11y<HTMLDivElement>(
    closeDetail,
    player == null && !trailerOpen,
    streamsPageOpen,
  );
  const streamsPageRef = useModalA11y<HTMLDivElement>(
    () => setStreamsPageOpen(false),
    streamsPageOpen && player == null,
  );
  // The streams portal is outside .detail in the DOM, so explicitly inert the
  // covered content. Focus, Escape, Tab containment, and focus restoration are
  // handled by useModalA11y. While a player is mounted, the player owns Escape.
  useEffect(() => {
    if (!streamsPageOpen || player != null) return;
    const inner = rootRef.current?.querySelector<HTMLElement>(".detail-inner");
    inner?.setAttribute("inert", "");
    return () => {
      inner?.removeAttribute("inert");
    };
  }, [player, streamsPageOpen]);
  useEffect(() => {
    if (autoPlayPending == null || streams.loading || autoPlayBusy.current) return;
    if (
      selected == null ||
      selected.season !== autoPlayPending.season ||
      selected.episode !== autoPlayPending.episode
    ) {
      // The user retargeted before the advanced episode's rows landed - the
      // auto-play intent is stale; cancel it instead of leaving it armed.
      setAutoPlayPending(null);
      return;
    }
    const target = autoPlayPending;
    const row = filterStreamRows(streams.rows, settings).find(
      (r) => r.cachedOn != null,
    );
    setAutoPlayPending(null);
    if (row == null) {
      // Nothing instant for the next episode - land the user on the honest,
      // episode-scoped stream list instead of auto-playing something uncached.
      revealStreams();
      return;
    }
    autoPlayBusy.current = true;
    // Pass the target EXPLICITLY as the file hint - no reliance on which
    // render's `selected` the resolver closure captured.
    resolveSelectedStream(row, target)
      .then((s) => {
        if (
          selectedRef.current?.season !== target.season ||
          selectedRef.current?.episode !== target.episode
        ) {
          return;
        }
        return handlePlay(s, row.result);
      })
      .catch(() => revealStreams())
      .finally(() => {
        autoPlayBusy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlayPending, streams.loading, streams.rows, selected, settings]);

  // Server Mode "title request" state for this detail. Detail doesn't remount
  // between titles (openDetail just swaps detailItem), so reset on id change.
  const [requestState, setRequestState] = useState<
    "idle" | "requesting" | "requested" | "already" | "failed"
  >("idle");

  // The user's current like/dislike taste signal for this title, read from the
  // newest taste event for it. Drives the DetailHero thumbs control's active
  // state and toggles off when the same thumb is tapped again.
  const [tasteSignal, setTasteSignal] = useState<TasteSignal>(null);
  // The user's numeric rating for this title, stored NORMALIZED (0–1) so it can
  // be shown on whichever scale (1–10 / 0–100) the user currently prefers.
  const [ratingNorm, setRatingNorm] = useState<number | null>(null);

  const detailId = detailItem?.id ?? null;
  useEffect(() => {
    setRequestState("idle");
  }, [detailId]);

  useEffect(() => {
    // Clear the previous title's signal/rating up front so nothing from the last
    // Detail lingers on screen while this title's events load (or if none exist).
    setTasteSignal(null);
    setRatingNorm(null);
    if (detailId == null) return;
    let cancelled = false;
    void getStore()
      .recentTasteEvents(200)
      .then((events) => {
        if (cancelled) return;
        // The newest of (liked | disliked | not_interested) wins: a later
        // not_interested means the user toggled their thumb back off.
        const latest = events.find(
          (e) =>
            e.mediaId === detailId &&
            (e.eventType === "liked" ||
              e.eventType === "disliked" ||
              e.eventType === "not_interested"),
        );
        setTasteSignal(
          latest?.eventType === "liked"
            ? "liked"
            : latest?.eventType === "disliked"
              ? "disliked"
              : null,
        );
        // Newest "rated" event carries the normalized score in metadata.norm.
        const rated = events.find(
          (e) => e.mediaId === detailId && e.eventType === "rated",
        );
        const norm = rated != null ? Number(rated.metadata?.norm) : NaN;
        // Clamp to [0,1] so a corrupt metadata value can't render 15/10 or 150/100.
        setRatingNorm(
          Number.isFinite(norm) ? Math.min(1, Math.max(0, norm)) : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setTasteSignal(null);
          setRatingNorm(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  if (detailItem == null) return null;

  const item = detail.data.item;
  if (item == null && !detail.loading && getNetworkMode() === "offline") {
    return (
      <div className="detail" role="status">
        <p className="detail-nokey-hint t-secondary">
          {detail.error ?? "Not available offline (not cached yet)."}
        </p>
      </div>
    );
  }
  const currentDetailItem = detailItem;
  const inWatchlist = isInWatchlist(watchlist, detailItem.id);
  // A pre-resolved, ready-to-play stream from the watchlist auto-resolve job.
  // Movie-only: the cache is keyed per TITLE, so instant-playing it for a
  // series could play the wrong episode. Series always go through the picker.
  const cached =
    detailItem.type === "movie" ? cachedResolutions[detailItem.id] ?? null : null;

  function persistWatchedEpisodes(
    episodes: readonly { season: number; episode: number }[],
    watched: boolean,
  ): void {
    const unique = [...new Map(
      episodes.map((episode) => [
        episodeIdFor(episode.season, episode.episode),
        episode,
      ]),
    ).entries()];
    if (unique.length === 0 || unique.some(([id]) => watchedMutationIds.current.has(id))) {
      return;
    }
    for (const [id] of unique) watchedMutationIds.current.add(id);
    const store = getStore();
    void Promise.all(
      unique.map(([episodeId]) =>
        watched
          ? store.recordHistory({
              mediaId: currentDetailItem.id,
              episodeId,
              progressSeconds: 1,
              durationSeconds: 1,
              completed: true,
              preview: currentDetailItem,
            })
          : store.deleteHistory(currentDetailItem.id, episodeId),
      ),
    )
      .then(() => setWatchedRefreshVersion((version) => version + 1))
      .catch(() => {
        // Keep the existing display state when persistence fails.
      })
      .finally(() => {
        for (const [id] of unique) watchedMutationIds.current.delete(id);
      });
  }

  function toggleMovieWatched(watched: boolean): void {
    if (currentDetailItem.type !== "movie") return;
    const mutationId = `movie:${currentDetailItem.id}`;
    if (watchedMutationIds.current.has(mutationId)) return;
    watchedMutationIds.current.add(mutationId);
    const store = getStore();
    void (
      watched
        ? store.recordHistory({
            mediaId: currentDetailItem.id,
            episodeId: null,
            progressSeconds: 1,
            durationSeconds: 1,
            completed: true,
            preview: currentDetailItem,
          })
        : store.deleteHistory(currentDetailItem.id, null)
    )
      .then(() => setWatchedRefreshVersion((version) => version + 1))
      .catch(() => {
        // Keep the existing display state when persistence fails.
      })
      .finally(() => {
        watchedMutationIds.current.delete(mutationId);
      });
  }

  function toggleSeriesWatched(watched: boolean): void {
    if (!watched) {
      persistWatchedEpisodes(
        [...watchedDetail.episodeIds]
          .map((id) => parseEpisodeId(id))
          .filter((episode): episode is { season: number; episode: number } => episode != null),
        false,
      );
      return;
    }
    const tmdbId = item?.tmdbId ?? currentDetailItem.tmdbId ?? null;
    if (tmdbId == null || seasonsState.seasons.length === 0) return;
    void Promise.all(
      seasonsState.seasons.map((season) =>
        isServerMode()
          ? fetchServerEpisodes({ tmdbId, season: season.seasonNumber }).then(
              (response) => response.episodes,
            )
          : services.tmdb?.getEpisodes(tmdbId, season.seasonNumber) ??
            Promise.resolve([]),
      ),
    )
      .then((groups) =>
        persistWatchedEpisodes(
          groups.flat().map((episode) => ({
            season: episode.seasonNumber,
            episode: episode.episodeNumber,
          })),
          true,
        ),
      )
      .catch(() => {
        // A failed guide fetch leaves current watched state intact.
      });
  }

  /** Resume position (seconds) for the title (movies) or the SELECTED episode
   * (series), read from the already-loaded Continue Watching list
   * (cross-device synced in Server Mode) - 0 when there's no in-progress
   * record or it's completed. */
  function resumeSecondsFor(): number {
    if (detailItem == null) return 0;
    const wantedEpisodeId =
      selected != null ? episodeIdFor(selected.season, selected.episode) : null;
    const record = continueWatching.find(
      (h) => h.mediaId === detailItem.id && h.episodeId === wantedEpisodeId,
    );
    return record != null && !record.completed ? record.progressSeconds : 0;
  }

  /** Remembered audio/subtitle/speed for the title (movies) or SELECTED episode
   * (series), read from the loaded history - restored by the in-window player. */
  function prefsFor(): PlaybackPrefs | null {
    if (detailItem == null) return null;
    const wantedEpisodeId =
      selected != null ? episodeIdFor(selected.season, selected.episode) : null;
    const record = continueWatching.find(
      (h) => h.mediaId === detailItem.id && h.episodeId === wantedEpisodeId,
    );
    if (record == null) return null;
    return {
      preferredAudioId: record.preferredAudioId,
      preferredAudioLang: record.preferredAudioLang,
      preferredSubId: record.preferredSubId,
      playbackSpeed: record.playbackSpeed,
      subtitleDelay: record.subtitleDelay,
      subtitlePosition: record.subtitlePosition,
    };
  }

  /** Open the player, seeking to any saved resume position. Snapshots the
   * episode context so a picker change mid-playback can't retarget progress. */
  function openPlayer(
    url: string,
    sourceFileName: string | null,
    engine: PlaybackEngine,
    fallbackStream: StreamInfo | null = null,
    sourceHash: string | null = null,
    startPositionOverride: number | null = null,
    timelineOffsetSeconds = 0,
    playbackHandoff: ActivePlayer["playbackHandoff"] = null,
    recoverySource: StreamRow | null = null,
  ): void {
    // The series stream picker is a body-level portal above Detail. Close it
    // before mounting the player portal so playback and error states cannot
    // start invisibly behind that page until the user presses Back.
    setStreamsPageOpen(false);
    const metadataTitle = item?.title?.trim() || detailItem?.title?.trim() || "";
    const metadataYear = item?.year ?? detailItem?.year ?? null;
    const episodeMetadata =
      selected == null
        ? null
        : selectedSeasonEpisodes.episodes.find(
            (episode) =>
              episode.seasonNumber === selected.season &&
              episode.episodeNumber === selected.episode,
          ) ?? null;
    const episodeContext =
      selected == null
        ? null
        : `${episodeLabel(selected.season, selected.episode)}${
            episodeMetadata?.title?.trim()
              ? ` - ${episodeMetadata.title.trim()}`
              : ""
          }`;
    const episodePauseLabel =
      selected == null
        ? null
        : `S${selected.season} E${selected.episode}${
            episodeMetadata?.title?.trim()
              ? ` - ${episodeMetadata.title.trim()}`
              : ""
          }`;
    const title =
      metadataTitle.length > 0
        ? detailItem?.type === "movie" && metadataYear != null
          ? `${metadataTitle} (${metadataYear})`
          : metadataTitle
        : sourceFileName || "Untitled stream";
    const tmdbId = item?.tmdbId ?? detailItem?.tmdbId ?? null;
    const scrobbleContext: TraktScrobbleContext | null =
      tmdbId == null
        ? null
        : detailItem?.type === "series"
          ? selected == null
            ? null
            : {
                tmdbId,
                type: "series",
                season: selected.season,
                episode: selected.episode,
              }
          : { tmdbId, type: "movie" };
    const nextPlayer: ActivePlayer = {
      url,
      sourceRevision: playerSourceRevisionRef.current++,
      title,
      subtitle: detailItem?.type === "series" ? episodeContext : null,
      nowPlaying: {
        year: metadataYear,
        runtimeMinutes: episodeMetadata?.runtime ?? item?.runtime ?? null,
        rating: item?.imdbRating ?? detailItem?.imdbRating ?? null,
        episodeLabel: detailItem?.type === "series" ? episodePauseLabel : null,
        overview: episodeMetadata?.overview ?? item?.overview ?? null,
        backdropUrl: item != null ? MediaItemNS.backdropURL(item) : null,
        posterUrl: item != null ? MediaItemNS.posterURL(item) : null,
      },
      sourceFileName,
      engine,
      fallbackStream,
      startPositionSeconds: Math.max(
        0,
        (startPositionOverride ?? resumeSecondsFor()) - timelineOffsetSeconds,
      ),
      savedPrefs: prefsFor(),
      episodeId:
        selected != null ? episodeIdFor(selected.season, selected.episode) : null,
      season: selected?.season ?? null,
      episode: selected?.episode ?? null,
      scrobbleContext,
      sourceHash,
      recoverySource,
      timelineOffsetSeconds,
      playbackHandoff,
    };
    playbackEpochRef.current += 1;
    playerRef.current = nextPlayer;
    setPlayer(nextPlayer);
    openDetailPlayer();
  }

  function finishClosingPlayer(): void {
    playbackEpochRef.current += 1;
    refreshGenerationRef.current += 1;
    playerRef.current = null;
    setPlayer(null);
    // WebviewPlayer emits its final progress report from unmount cleanup. Run
    // the one-per-session slice refresh on the next task so that write is
    // registered first; AppStore then waits for it before reading the slice.
    window.setTimeout(() => {
      void refreshContinueWatching();
    }, 0);
  }

  function closePlayer(): void {
    if (detailPlayerOpen) {
      closeDetailPlayer();
    }
    finishClosingPlayer();
  }

  // Browser Back resets the store's live player flag from the popstate
  // descriptor. Let that state transition unmount the existing player and run
  // its final progress cleanup without pushing a replacement history entry.
  useEffect(() => {
    if (!detailPlayerOpen && player != null) finishClosingPlayer();
  }, [detailPlayerOpen, player, refreshContinueWatching]);

  /** Record (or toggle off) a like/dislike taste signal for the current title.
   * The event carries the title + genre names in metadata so the taste-profile
   * assembler can derive liked/disliked genres without a media-cache join. The
   * 24h taste-context cache is rebuilt so the next analysis reflects the change.
   *
   * Tapping the active thumb again toggles it off - recorded as a
   * "not_interested" event so a re-read of the newest signal clears the control
   * (the taste-context assembler ignores not_interested, so it neutralizes the
   * prior like/dislike). */
  function recordTasteSignal(signal: "liked" | "disliked"): void {
    if (detailItem == null) return;
    const next: TasteSignal = tasteSignal === signal ? null : signal;
    setTasteSignal(next);
    const eventType: TasteEventType = next ?? "not_interested";
    const genres = item?.genres ?? [];
    const metadata: Record<string, string> = { title: detailItem.title };
    if (genres.length > 0) metadata.genres = genres.join(", ");
    const store = getStore();
    void store
      .addTasteEvent({
        id: `taste-${detailItem.id}-${Date.now()}`,
        userId: "default",
        mediaId: detailItem.id,
        episodeId: null,
        eventType,
        signalStrength: next === "liked" ? 1 : next === "disliked" ? -1 : 0,
        metadata,
        createdAt: new Date().toISOString(),
      })
      .then(() => rebuildTasteContext(store))
      .catch(() => {
        // best-effort; the in-memory toggle already reflects the user's intent.
      });
  }

  /** Record a numeric rating (1–10 or 0–100). Stored normalized (0–1) in
   *  metadata.norm so it survives a scale change, and fed to the taste profile
   *  as a −1…1 signal (5/10 is neutral). */
  function recordRating(value: number): void {
    if (detailItem == null) return;
    const max = settings.ratingScale === "hundred" ? 100 : 10;
    const norm = Math.min(1, Math.max(0, value / max));
    setRatingNorm(norm);
    const genres = item?.genres ?? [];
    const metadata: Record<string, string> = {
      title: detailItem.title,
      rating: String(value),
      scale: settings.ratingScale,
      norm: norm.toFixed(4),
    };
    if (genres.length > 0) metadata.genres = genres.join(", ");
    const store = getStore();
    void store
      .addTasteEvent({
        id: `taste-${detailItem.id}-${Date.now()}`,
        userId: "default",
        mediaId: detailItem.id,
        episodeId: null,
        eventType: "rated" as TasteEventType,
        signalStrength: norm * 2 - 1,
        metadata,
        createdAt: new Date().toISOString(),
      })
      .then(() => rebuildTasteContext(store))
      .catch(() => {
        // best-effort; the in-memory value already reflects the user's rating.
      });
  }

  /** Remove a previously-given rating. Taste events are append-only, so we record
   * a newest "rated" event with NO norm - the Detail load reads it as "unrated"
   * and the taste profile (newest-per-media) contributes nothing for it, which
   * also suppresses the older score. */
  function clearRating(): void {
    if (detailItem == null) return;
    setRatingNorm(null);
    const store = getStore();
    void store
      .addTasteEvent({
        id: `taste-${detailItem.id}-${Date.now()}`,
        userId: "default",
        mediaId: detailItem.id,
        episodeId: null,
        eventType: "rated" as TasteEventType,
        signalStrength: 0,
        metadata: { title: detailItem.title, cleared: "true" },
        createdAt: new Date().toISOString(),
      })
      .then(() => rebuildTasteContext(store))
      .catch(() => {
        // best-effort; the in-memory value already reflects the cleared rating.
      });
  }

  /** Route one resolved file without hiding the selected engine. Desktop sends
   * unsupported containers/codecs straight to native mpv, preserving 4K DV/HDR
   * and avoiding a lossy RD transcode. Browser sessions still use RD HLS. If the
   * built-in native renderer later fails, VideoPlayer requests HLS lazily using
   * fallbackStream, then retains its external-player error action as the end of
   * the chain. The built-in-player setting remains authoritative inside
   * VideoPlayer: off means native external hand-off, never a silent webview swap. */
  async function playResolvedStream(
    stream: StreamInfo,
    sourceFileName: string | null = stream.fileName,
    source?: TorrentResult,
    startPositionOverride: number | null = null,
    playbackHandoff: ActivePlayer["playbackHandoff"] = null,
    recoverySource: StreamRow | null = null,
  ): Promise<void> {
    const sourceHash = source?.infoHash ?? null;
    const retainedRecoverySource = recoverySource ?? (
      source == null
        ? null
        : streams.rows.find(
            (candidate) => candidate.result.infoHash.toLowerCase() === source.infoHash.toLowerCase(),
          ) ?? null
    );
    const timelineOffsetSeconds = stream.timelineOffsetSeconds ?? 0;
    if (/^https?:\/\//i.test(stream.streamURL) && !isRequestExempt(stream.streamURL)) {
      try {
        assertNetworkAllowed("streaming", "player");
      } catch {
        setDownloadNotice("Streaming is turned off in Offline mode. Your downloaded titles still play from Downloads.");
        return;
      }
    }
    // Keep the original Server Mode proxy session with every hosted playback.
    // File names and torrent metadata are only hints, so a stream classified as
    // browser-compatible can still contain a codec that the media element rejects.
    // VideoPlayer can then retry this exact session through its HLS manifest,
    // and its External Player action can mint a cookie-free capability URL.
    const serverSource = isServerMode() ? stream : null;
    if (!needsTranscodeOrExternal(stream, source)) {
      const engine = stream.streamURL.split("?")[0].toLowerCase().endsWith(".m3u8")
        ? "webview-hls-transcode"
        : "webview-direct";
      openPlayer(
        stream.streamURL,
        sourceFileName,
        engine,
        serverSource,
        sourceHash,
        startPositionOverride,
        timelineOffsetSeconds,
        playbackHandoff,
        retainedRecoverySource,
      );
      return;
    }

    if (isDesktopTauri()) {
      openPlayer(
        stream.streamURL,
        sourceFileName,
        "native-mpv",
        stream,
        sourceHash,
        startPositionOverride,
        timelineOffsetSeconds,
        playbackHandoff,
        retainedRecoverySource,
      );
      return;
    }

    const hlsUrl = stream.backend === "direct_torrent"
      ? null
      : isServerMode() && transcodeAvailable
      ? serverOptimizedSource(stream, { quality: "auto", startSeconds: 0 }).url
      : await services.debrid?.getTranscodeHLS(stream).catch(() => null);
    if (hlsUrl != null) {
      openPlayer(
        hlsUrl,
        sourceFileName,
        "webview-hls-transcode",
        serverSource,
        sourceHash,
        startPositionOverride,
        timelineOffsetSeconds,
        playbackHandoff,
        retainedRecoverySource,
      );
      return;
    }
    // No compatibility transcode is available. Still enter the custom web
    // player and let the browser attempt the source; a decode failure remains
    // inside the player with Retry/direct-link fallbacks.
    openPlayer(
      stream.streamURL,
      sourceFileName,
      "webview-direct",
      serverSource,
      sourceHash,
      startPositionOverride,
      timelineOffsetSeconds,
      playbackHandoff,
      retainedRecoverySource,
    );
  }

  function cachedProvider(value: string): DebridServiceType | null {
    switch (value.trim().toLowerCase()) {
      case "rd":
      case "real_debrid": return "real_debrid";
      case "ad":
      case "all_debrid": return "all_debrid";
      case "pm":
      case "premiumize": return "premiumize";
      case "tb":
      case "torbox": return "torbox";
      default: return null;
    }
  }

  /** Play an already-resolved stream while retaining its resolution provenance. */
  async function playStream(cachedResolution: typeof cached) {
    if (cachedResolution == null) return;
    const { stream, infoHash } = cachedResolution;
    if (typeof infoHash !== "string" || infoHash.trim().length === 0) {
      await playResolvedStream(stream, stream.fileName);
      return;
    }
    const cachedOn = cachedProvider(cachedResolution.debridService ?? stream.debridService ?? "");
    const source = TorrentResult.fromSearch({
      infoHash,
      title: stream.fileName,
      sizeBytes: stream.sizeBytes,
      seeders: 0,
      leechers: 0,
      indexerName: "cached resolution",
    });
    source.isCached = true;
    source.cachedOn = cachedOn;
    await playResolvedStream(
      stream,
      stream.fileName,
      source,
      null,
      null,
      { result: source, cachedOn },
    );
  }

  async function resolveSelectedStream(
    row: StreamRow,
    hintOverride?: { season: number; episode: number } | null,
    startSecondsOverride?: number | null,
    backend: "debrid" | "direct_torrent" = "debrid",
  ): Promise<StreamInfo> {
    // Episode context (series only): steers season-pack torrents to the exact
    // episode's file. Exact single-episode torrents either match (same pick)
    // or carry no tag (fallback to the default pick) - always safe to pass.
    // The auto-advance effect passes its target explicitly (hintOverride) so
    // the hint can never depend on which render's `selected` was captured.
    const fileHint =
      hintOverride ??
      (detailItem?.type === "series" && selected != null
        ? { season: selected.season, episode: selected.episode }
        : null);
    if (isServerMode()) {
      // Keep Device Original by default unless the existing opt-in is enabled.
      // The title context is required for maturity gating on capped profiles.
      const media =
        detailItem != null ? { id: detailItem.id, type: detailItem.type } : undefined;
      try {
        const startSeconds = Math.max(
          0,
          startSecondsOverride ?? resumeSecondsFor(),
        );
        const sourceLooksHdr =
          /(?:^|[^a-z0-9])(?:dv|dovi|dolby[ ._-]?vision|hdr10\+?|hdr|hlg)(?:[^a-z0-9]|$)/i.test(
            row.result.title,
          );
        const transcodeOptions = {
          profile: settings.dataSaver
            ? "data-saver" as const
            : "adaptive" as const,
          startSeconds:
            transcodeCapabilities.seekOffset ? startSeconds : 0,
          hdrPolicy:
            sourceLooksHdr && transcodeCapabilities.toneMapping
              ? "tone-map" as const
              : "auto" as const,
          preserveSubtitles: transcodeCapabilities.subtitleSidecar,
        };
        const supportsOptimizedSelector =
          transcodeCapabilities.seekOffset && serverOptimizedQualities.length > 0;
        const stream = await resolveServerStream(row, {
          // Older servers do not advertise selector qualities. Keep their
          // profile-based opt-in behavior until the client can request a
          // separately warmed optimized source.
          transcode:
            backend === "debrid" && settings.transcode && !supportsOptimizedSelector,
          transcodeOptions,
          media,
          fileHint,
          backend,
          directTorrentAcknowledged: backend === "direct_torrent",
        });
        return stream;
      } catch (err) {
        // A 403 here means the title is over the active profile's maturity cap.
        // Surface a friendly message (StreamPicker renders the thrown .message)
        // instead of the raw server error, and don't crash the picker.
        if ((err as { status?: number }).status === 403 && backend === "debrid") {
          throw new Error("This title is outside your profile's maturity settings.");
        }
        throw err;
      }
    }
    if (services.debrid == null || !services.debrid.hasServices) {
      throw new Error("Configure a debrid service to play.");
    }
    return services.debrid.resolveStream(row.result.infoHash, row.cachedOn, fileHint);
  }

  const resolvePickerStream = (
    row: StreamRow,
    backend: "debrid" | "direct_torrent" = "debrid",
  ) => resolveSelectedStream(row, null, null, backend);

  /** File a Server-Mode title request for the current item. The detailItem is a
   *  MediaPreview - the same minimal shape watchlist add uses - so it's passed
   *  straight through. A 409 means the title already has a live pending request. */
  async function requestTitle() {
    if (detailItem == null || requestState === "requesting") return;
    if (requestState === "requested" || requestState === "already") return;
    setRequestState("requesting");
    try {
      await createRequest(detailItem.id, detailItem);
      setRequestState("requested");
    } catch (err) {
      const status = (err as { status?: number }).status;
      // Anything other than "already requested" used to snap silently back to
      // idle, so a failed request looked exactly like one never made.
      setRequestState(status === 409 ? "already" : "failed");
    }
  }

  /** Queue only a verified, aired regular episode. Metadata failures never
   * fabricate an ordinary zero-progress resume target. */
  async function queueVerifiedNextEpisode(): Promise<void> {
    if (detailItem?.type !== "series" || player == null || upNextTarget == null ||
        seasonsState.source !== "live") return;
    const tmdbId = detail.data.item?.tmdbId ?? detailItem.tmdbId ?? null;
    if (tmdbId == null) return;
    try {
      const episodes = isServerMode()
        ? (await fetchServerEpisodes({ tmdbId, season: upNextTarget.season })).episodes
        : await services.tmdb?.getEpisodes(tmdbId, upNextTarget.season) ?? [];
      const target = episodes.find((episode) =>
        episode.seasonNumber === upNextTarget.season &&
        episode.episodeNumber === upNextTarget.episode,
      );
      const today = new Date().toISOString().slice(0, 10);
      if (target == null || (target.airDate != null && target.airDate > today)) return;
      await getStore().recordHistory({
        mediaId: detailItem.id,
        episodeId: episodeIdFor(upNextTarget.season, upNextTarget.episode),
        progressSeconds: 0,
        durationSeconds: null,
        completed: false,
        queuedNext: true,
        preview: detailItem,
      });
      await refreshContinueWatching();
    } catch {
      // Guide data is a prerequisite for a queue, so leave no speculative row.
    }
  }

  /** Advance to the next episode (the Up-next card's action). Closes the
   * player, moves the (persisted) selection - which re-drives the stream
   * search - and queues the auto-play attempt for when the new rows land. */
  function handlePlayNext() {
    if (upNextTarget == null || detailItem == null) return;
    closePlayer();
    selectEpisode(detailItem.id, upNextTarget);
    setAutoPlayPending(upNextTarget);
  }

  async function handlePlay(stream: StreamInfo, source: TorrentResult) {
    const sourceHash = source.infoHash?.toLowerCase();
    triedSourceHashesRef.current = new Set(
      sourceHash != null ? [sourceHash] : [],
    );
    lastPlayerProgressRef.current = resumeSecondsFor();
    await playResolvedStream(stream, stream.fileName || source.title, source);
  }

  async function handleRefreshCurrentSource(
    absolutePositionSeconds: number,
    playbackHandoff: NonNullable<ActivePlayer["playbackHandoff"]>,
  ): Promise<void> {
    if (player?.sourceHash == null) {
      throw new Error("The current source cannot be resolved again.");
    }
    const sourceHash = player.sourceHash.toLowerCase();
    const activePlayer = player;
    const capturedEpoch = playbackEpochRef.current;
    const capturedDetailId = detailItem?.id ?? null;
    const requestGeneration = ++refreshGenerationRef.current;
    const row = streams.rows.find(
      (candidate) => candidate.result.infoHash.toLowerCase() === sourceHash,
    ) ?? activePlayer.recoverySource;
    if (row == null) {
      throw new Error("The current source is no longer in the source list.");
    }
    const position = Number.isFinite(absolutePositionSeconds)
      ? Math.max(0, absolutePositionSeconds)
      : Math.max(0, lastPlayerProgressRef.current);
    const episodeHint =
      player.season != null && player.episode != null
        ? { season: player.season, episode: player.episode }
        : null;
    const backend = player.fallbackStream?.backend === "direct_torrent"
      ? "direct_torrent" as const
      : "debrid" as const;
    lastPlayerProgressRef.current = position;
    try {
      const stream = await withFreshStreamResolutionTimeout(
        resolveSelectedStream(row, episodeHint, position, backend),
      );
      if (
        refreshGenerationRef.current !== requestGeneration ||
        playbackEpochRef.current !== capturedEpoch ||
        playerRef.current !== activePlayer ||
        detailIdRef.current !== capturedDetailId
      ) return;
      await playResolvedStream(
        stream,
        stream.fileName || row.result.title,
        row.result,
        position,
        playbackHandoff,
        row,
      );
    } catch (error) {
      throw new Error(
        `The current source could not be refreshed. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleTryNextSource(): Promise<void> {
    if (player == null) throw new Error("No active source is available to replace.");
    const runtimeMinutes =
      player.nowPlaying?.runtimeMinutes ?? item?.runtime ?? null;
    const profile = isDesktopTauri()
      ? "native" as const
      : transcodeAvailable
        ? "browser-transcode" as const
        : "browser-direct" as const;
    const ranked = rankSources(filterStreamRows(streams.rows, settings), {
      profile,
      runtimeMinutes,
    });
    const next = ranked.find(({ row, assessment }) => {
      const hash = row.result.infoHash.toLowerCase();
      return (
        row.cachedOn != null &&
        assessment.compatibility !== "risky" &&
        !triedSourceHashesRef.current.has(hash)
      );
    });
    if (next == null) {
      throw new Error(
        "No other instant source is compatible with this device. Return to the source list to cache or choose another release.",
      );
    }
    const hash = next.row.result.infoHash.toLowerCase();
    triedSourceHashesRef.current.add(hash);
    const episodeHint =
      player.season != null && player.episode != null
        ? { season: player.season, episode: player.episode }
        : null;
    try {
      const stream = await resolveSelectedStream(
        next.row,
        episodeHint,
        Math.max(0, lastPlayerProgressRef.current),
      );
      await playResolvedStream(
        stream,
        stream.fileName || next.row.result.title,
        next.row.result,
        Math.max(0, lastPlayerProgressRef.current),
      );
    } catch (error) {
      throw new Error(
        `The next source could not be prepared. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const downloadDisabledReason =
    !isDesktopTauri()
      ? "Open the desktop app to download files."
      : isServerMode()
        ? "Downloads are available in Local Mode in the desktop app."
        : services.debrid == null || !services.debrid.hasServices
          ? "Add a debrid service in Settings to download."
          : services.indexers == null
            ? "Add a source in Settings to download."
            : null;

  function downloadInput(
    source: TorrentResult,
    episodeContext: { season: number; episode: number; title?: string } | null,
  ): EnqueueDownloadInput {
    const show = item?.title ?? currentDetailItem.title;
    const year = item?.year != null ? ` (${item.year})` : "";
    const episodeTitle = episodeContext?.title?.trim();
    const title =
      episodeContext == null
        ? `${show}${year}`
        : `${show} S${String(episodeContext.season).padStart(2, "0")}E${String(episodeContext.episode).padStart(2, "0")}${episodeTitle ? ` - ${episodeTitle}` : ""}`;
    return {
      mediaId: currentDetailItem.id,
      episodeId:
        episodeContext == null
          ? null
          : episodeIdFor(episodeContext.season, episodeContext.episode),
      title,
      season: episodeContext?.season ?? null,
      episode: episodeContext?.episode ?? null,
      infoHash: source.infoHash,
      sizeBytes: source.sizeBytes,
      fileHint:
        episodeContext == null
          ? null
          : episodeIdFor(episodeContext.season, episodeContext.episode),
      mode: downloadMode,
      optimizeProfile: downloadMode === "optimized" ? downloadProfile : null,
      // Stream rows have no track inventory before the native ffprobe pass.
      // Empty means keep all tracks; otherwise these optional user-entered
      // language codes are forwarded unchanged to the existing FFmpeg contract.
      keepAudioLangs:
        downloadMode === "optimized" ? parseLanguageList(downloadAudioLanguages) : [],
      keepSubLangs:
        downloadMode === "optimized" ? parseLanguageList(downloadSubtitleLanguages) : [],
    };
  }

  async function enqueueCurrentDownload(): Promise<void> {
    const source = selectedDownloadSource?.result;
    if (source == null) {
      setDownloadNotice("Find a stream for this title before adding it to the queue.");
      return;
    }
    const episodeContext =
      selected == null ? null : { season: selected.season, episode: selected.episode };
    await startDownloadsRuntime(getStore(), services.debrid).enqueue(
      downloadInput(source, episodeContext),
    );
    setDownloadNotice("Added to Downloads.");
    setDownloadMenuOpen(false);
  }

  async function enqueueEpisodeBatch(
    episodes: Array<{ season: number; episode: number; title?: string }>,
    label: string,
  ): Promise<void> {
    if (services.indexers == null || detail.data.imdbId == null) {
      setDownloadNotice("Add a source and metadata key before creating a batch.");
      return;
    }
    setDownloadNotice(`Finding sources for ${label}…`);
    const matches = await Promise.all(
      episodes.map(async (episode) => {
        const results = await services.indexers!.searchAll(
          detail.data.imdbId!,
          "series",
          episode.season,
          episode.episode,
        );
        const source =
          results.find(
            (result) => downloadQuality == null || result.quality === downloadQuality,
          ) ?? results[0];
        return source == null ? null : downloadInput(source, episode);
      }),
    );
    const inputs = matches.filter((input): input is EnqueueDownloadInput => input != null);
    if (inputs.length === 0) {
      setDownloadNotice(`No sources were found for ${label}.`);
      return;
    }
    await startDownloadsRuntime(getStore(), services.debrid).enqueueSeason(inputs);
    const skipped = episodes.length - inputs.length;
    setDownloadNotice(
      skipped > 0
        ? `Added ${inputs.length}; ${skipped} episode${skipped === 1 ? "" : "s"} had no source.`
        : `Added ${inputs.length} episode${inputs.length === 1 ? "" : "s"} to Downloads.`,
    );
    setDownloadMenuOpen(false);
  }

  function enqueueCurrentSeason(): void {
    if (selected == null || selectedSeasonEpisodes.loading) {
      setDownloadNotice("The season guide is still loading.");
      return;
    }
    void enqueueEpisodeBatch(
      selectedSeasonEpisodes.episodes.map((episode) => ({
        season: episode.seasonNumber,
        episode: episode.episodeNumber,
        title: episode.title ?? undefined,
      })),
      `Season ${selected.season}`,
    );
  }

  function enqueueWholeShow(): void {
    if (services.tmdb == null || item?.tmdbId == null || seasonsState.seasons.length === 0) {
      setDownloadNotice("Load the episode guide before downloading the whole show.");
      return;
    }
    setDownloadNotice("Loading the episode guide…");
    void Promise.all(
      seasonsState.seasons.map((season) => services.tmdb!.getEpisodes(item.tmdbId!, season.seasonNumber)),
    ).then((groups) =>
      enqueueEpisodeBatch(
        groups.flat().map((episode) => ({
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          title: episode.title ?? undefined,
        })),
        "the whole show",
      ),
    ).catch(() => setDownloadNotice("The episode guide could not be loaded."));
  }

  return (
    <div
      className="detail"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${detailItem.title} details`}
      tabIndex={-1}
    >
      <div className="detail-inner">
      {item && (
        <DetailHero
          item={item}
          inWatchlist={inWatchlist}
          onClose={closeDetail}
          onToggleWatchlist={() => toggleWatchlist(detailItem)}
          onRequest={isServerMode() ? () => void requestTitle() : undefined}
          requestState={requestState}
          tasteSignal={tasteSignal}
          onTasteSignal={
            // RemoteStore.addTasteEvent is still a no-op, so in Server Mode a
            // thumb would light up and be thrown away. Don't offer it until the
            // server has somewhere to put it.
            settings.ratingScale === "thumbs" && !isServerMode()
              ? recordTasteSignal
              : undefined
          }
          playLabel={
            !streams.hasDebrid || streams.missingImdbId
              ? "Set up streaming"
              : "Play"
          }
          onDownload={
            isDesktopTauri() && !isServerMode()
              ? () => {
                  setDownloadNotice(null);
                  setDownloadMenuOpen((open) => !open);
                }
              : undefined
          }
          downloadDisabledReason={downloadDisabledReason}
          movieWatched={detailItem.type === "movie" ? watchedDetail.movieWatched : false}
          onToggleMovieWatched={
            detailItem.type === "movie"
              ? () => toggleMovieWatched(!watchedDetail.movieWatched)
              : undefined
          }
          externalRatings={<OmdbRatings imdbId={detail.data.imdbId} />}
          completionLabel={
            detailItem.type === "movie"
              ? watchedDetail.movieWatched
                ? "Watched"
                : null
              : seriesWatched
                ? "Completed"
                : null
          }
          onPlay={() => {
            if (!streams.hasDebrid || streams.missingImdbId) {
              navigate("settings");
              return;
            }
            // Instant play: if the auto-resolve job pre-cached a ready stream
            // for this title, play it immediately instead of re-walking the
            // indexers + debrid.
            if (cached != null) {
              void playStream(cached);
              return;
            }
            // Series open the dedicated streams page; movies scroll the inline
            // picker into view.
            if (isSeries) {
              setStreamsPageOpen(true);
              return;
            }
            setScrollToStreams(true);
            queueMicrotask(() => {
              document
                .getElementById("detail-streams")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
              setScrollToStreams(false);
            });
          }}
        />
      )}

      {downloadMenuOpen && (
        <section className="detail-download-menu glass-raised" aria-label="Download options">
          <div className="detail-download-menu-head">
            <div>
              <strong>{isSeries ? "Download episodes" : "Download movie"}</strong>
              <p className="t-secondary">
                {isSeries
                  ? "Queue the selected episode, season, or show. Each episode resolves its own source."
                  : "The best currently listed source is added to your desktop queue."}
              </p>
            </div>
            <button type="button" className="dl-icon-btn" onClick={() => setDownloadMenuOpen(false)} aria-label="Close download options">
              <Icon name="xmark" size={15} />
            </button>
          </div>
          <div className="detail-download-modes" role="group" aria-label="Download format">
            <button
              type="button"
              className={`chip${downloadMode === "full" ? " is-active dl-chip-active" : ""}`}
              onClick={() => setDownloadMode("full")}
            >
              Original file (as-is)
            </button>
            <button
              type="button"
              className={`chip${downloadMode === "optimized" ? " is-active dl-chip-active" : ""}`}
              onClick={() => setDownloadMode("optimized")}
              disabled={ffmpegAvailable !== true}
              title={ffmpegAvailable === false ? "FFmpeg is unavailable on this desktop." : "Checking FFmpeg…"}
            >
              Optimized copy
            </button>
          </div>
          <label className="detail-download-field">
            <span>Resolution</span>
            <select
              aria-label="Download resolution"
              value={downloadQuality ?? ""}
              onChange={(event) => setDownloadQuality(event.target.value as VideoQualityValue)}
              disabled={downloadQualities.length === 0}
            >
              {downloadQualities.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </label>
          {downloadMode === "optimized" && (
            <div className="detail-download-optimize">
              <div className="detail-download-profile" role="group" aria-label="Optimized profile">
                <button
                  type="button"
                  className={`chip${downloadProfile === "remux" ? " is-active dl-chip-active" : ""}`}
                  aria-pressed={downloadProfile === "remux"}
                  onClick={() => setDownloadProfile("remux")}
                >
                  Repackaged (fast)
                </button>
                <button
                  type="button"
                  className={`chip${downloadProfile === "h265" ? " is-active dl-chip-active" : ""}`}
                  aria-pressed={downloadProfile === "h265"}
                  onClick={() => setDownloadProfile("h265")}
                >
                  Smaller file (slow)
                </button>
              </div>
              <div className="detail-download-language-fields">
                <label className="detail-download-field">
                  <span>Audio languages to keep</span>
                  <input
                    type="text"
                    value={downloadAudioLanguages}
                    onChange={(event) => setDownloadAudioLanguages(event.target.value)}
                    placeholder="Optional, e.g. en, fr"
                  />
                </label>
                <label className="detail-download-field">
                  <span>Subtitle languages to keep</span>
                  <input
                    type="text"
                    value={downloadSubtitleLanguages}
                    onChange={(event) => setDownloadSubtitleLanguages(event.target.value)}
                    placeholder="Optional, e.g. en, es"
                  />
                </label>
              </div>
              <p className="detail-download-track-note t-secondary">
                Language codes are optional. Leave a field empty to keep every track of that type.
              </p>
            </div>
          )}
          <p className="detail-download-track-note t-secondary">
            Downloads are permanent files on this device. You can play or move
            them with other apps.
          </p>
          {selectedDownloadSource != null ? (
            <div className="detail-download-estimate" role="status">
              {selectedDownloadEstimate != null ? (
                <>
                  <strong>{selectedDownloadEstimate.summary}</strong>
                  <span>{selectedDownloadEstimate.detail}</span>
                </>
              ) : (
                <>
                  <strong>Estimated total: size unavailable</strong>
                  <span>The selected source did not report a file size.</span>
                </>
              )}
              <span className="detail-download-source">
                Selected {selectedDownloadSource.result.quality} source: {selectedDownloadSource.result.title}
              </span>
            </div>
          ) : (
            <p className="detail-download-track-note t-secondary">
              Find a stream to see a size estimate before downloading.
            </p>
          )}
          {ffmpegAvailable === false && (
            <p className="detail-download-track-note t-secondary">
              Optimized downloads need FFmpeg. Choose Full size or install the desktop build with FFmpeg.
            </p>
          )}
          <div className="detail-download-actions">
            <button
              type="button"
              className="btn btn-prominent"
              onClick={() => void enqueueCurrentDownload()}
              disabled={selectedDownloadSource == null}
            >
              <Icon name="debrid" size={15} />
              {isSeries && selected != null
                ? `This episode (${episodeLabel(selected.season, selected.episode)})`
                : "Download movie"}
            </button>
            {isSeries && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={enqueueCurrentSeason}
                  disabled={selected == null || selectedSeasonEpisodes.loading || selectedSeasonEpisodes.episodes.length === 0}
                >
                  Season {selected?.season ?? ""}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={enqueueWholeShow}
                  disabled={seasonsState.loading || seasonsState.seasons.length === 0}
                >
                  Whole show
                </button>
              </>
            )}
          </div>
          {downloadNotice != null && <p className="detail-download-notice" role="status">{downloadNotice}</p>}
        </section>
      )}

      {/* No-metadata-key hint: the hero renders from the catalog preview alone
          (no overview/genres) - say why, and where to fix it, instead of just
          looking sparse. Local Mode only; Server Mode proxies the server key. */}
      {item && detail.source === "fixtures" && !detail.loading && !isServerMode() && (
        <p className="detail-nokey-hint t-secondary">
          Showing basic info - add a free TMDB key for the full details:
          overview, genres, and the episode guide.
          <button
            type="button"
            className="detail-nokey-link"
            onClick={() => {
              navigate("settings");
            }}
          >
            Add a key in Settings
          </button>
        </p>
      )}

      {/* Watch the official trailer in-app (YouTube, privacy-nocookie embed).
          Hidden until TMDB confirms a trailer exists for this title. */}
      {trailer.key != null && (
        <button
          type="button"
          className="btn detail-trailer-btn"
          onClick={openTrailer}
        >
          <Icon name="play" size={14} />
          Watch trailer
        </button>
      )}

      {/* Your own rating (1–10 pips or a 0–100 slider), collapsed behind an
          explicit "Rate" button so the stars don't sit out permanently. Thumbs
          mode keeps the like/dislike control in the hero instead. The key resets
          the reveal to collapsed when the title changes. */}
      {/* Hidden in Server Mode for the same reason as the thumbs above: the
          remote taste store accepts the event and drops it, so the score would
          show and then vanish on reload. */}
      {settings.ratingScale !== "thumbs" && !isServerMode() && (
        <RatingReveal
          key={detailItem.id}
          scale={settings.ratingScale}
          value={
            ratingNorm != null
              ? Math.round(ratingNorm * (settings.ratingScale === "hundred" ? 100 : 10))
              : null
          }
          onRate={recordRating}
          onClear={clearRating}
        />
      )}

      {/* Personal analysis stays quiet until the optional provider is ready. */}
      {item && services.ai?.analyzeTitle != null && (
        <DetailAnalysis item={item} provider={services.ai} />
      )}

      {/* Season/episode picker (series only). Selecting an episode re-drives
          the stream search below; falls back to a plain stepper without TMDB. */}
      {detailItem.type === "series" && selected != null && (
        <EpisodePicker
          tmdbId={item?.tmdbId ?? detailItem.tmdbId ?? null}
          tmdb={services.tmdb}
          selected={selected}
          onSelect={(next) => {
            // Picking an episode opens the dedicated streams page for it.
            selectEpisode(detailItem.id, next);
            setStreamsPageOpen(true);
          }}
          progressByEpisodeId={progressByEpisodeId}
          watchedEpisodeIds={new Set(watchedDetail.episodeIds)}
          onToggleWatched={(episode, watched) =>
            persistWatchedEpisodes([episode], watched)
          }
          onToggleSeasonWatched={persistWatchedEpisodes}
          onToggleSeriesWatched={toggleSeriesWatched}
          seriesWatched={seriesWatched}
        />
      )}

      {/* Movies: the stream list sits inline. Series show it on a dedicated
          page (below) opened by picking an episode. */}
      {!isSeries && (
        <div
          id="detail-streams"
          ref={streamsAnchorRef}
          className={scrollToStreams ? "detail-streams-anchor" : undefined}
        >
          <StreamPicker
            state={streams}
            resolveStream={resolvePickerStream}
            onPlay={handlePlay}
            episodeLabel={null}
            episodeContext={null}
            runtimeMinutes={item?.runtime ?? null}
            transcodeAvailable={transcodeAvailable}
            directTorrentAvailable={directTorrentAvailable}
            onOpenSettings={() => {
              navigate("settings");
            }}
          />
        </div>
      )}

      <CastRail cast={detail.data.cast} />

      <Rail
        title="More like this"
        items={detail.data.related}
        onSelect={openDetail}
        showPosterRatings={settings?.showPosterRatings ?? false}
      />
      </div>

      {/* Series streams live on their own page (opened by picking an episode),
          instead of loading inline at the bottom of Detail. */}
      {isSeries && streamsPageOpen && selected != null && createPortal(
        <div
          ref={streamsPageRef}
          className="episode-streams"
          role="dialog"
          aria-modal="true"
          aria-label={`Streams - ${episodeLabel(selected.season, selected.episode)}`}
          tabIndex={-1}
        >
          <div className="episode-streams-panel">
            <div className="episode-streams-head">
              <button
                ref={streamsBackRef}
                type="button"
                className="episode-streams-back"
                onClick={() => setStreamsPageOpen(false)}
              >
                ‹ Episodes
              </button>
              <strong className="episode-streams-title">
                {(item?.title ?? detailItem.title) + " · "}
                {episodeLabel(selected.season, selected.episode)}
              </strong>
            </div>
            <div className="episode-streams-body">
              <StreamPicker
                state={streams}
                resolveStream={resolvePickerStream}
                onPlay={handlePlay}
                episodeLabel={episodeLabel(selected.season, selected.episode)}
                episodeContext={selected}
                runtimeMinutes={
                  selectedSeasonEpisodes.episodes.find(
                    (episode) =>
                      episode.seasonNumber === selected.season &&
                      episode.episodeNumber === selected.episode,
                  )?.runtime ?? item?.runtime ?? null
                }
                transcodeAvailable={transcodeAvailable}
                directTorrentAvailable={directTorrentAvailable}
                onOpenSettings={() => {
                  navigate("settings");
                }}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}

      {player && (
        <Suspense fallback={<Spinner variant="overlay" label="Loading player…" />}>
          <VideoPlayer
            key={playbackRecoverySessionIdentity(
              detailItem.id,
              player.episodeId,
              player.sourceHash,
              player.url,
            )}
            url={player.url}
            sourceRevision={player.sourceRevision}
            title={player.title}
            subtitle={player.subtitle}
            nowPlaying={player.nowPlaying}
            sourceFileName={player.sourceFileName}
            playbackAuthorization={player.fallbackStream?.playbackAuthorization}
            engine={player.engine}
            requestWebviewFallback={
              player.fallbackStream != null &&
              player.fallbackStream.backend !== "direct_torrent" &&
              (isServerMode() ? transcodeAvailable : services.debrid != null)
                ? isServerMode()
                  ? () => Promise.resolve(
                      serverOptimizedSource(player.fallbackStream!, {
                        quality: "auto",
                        startSeconds: 0,
                      }).url,
                    )
                  : () => services.debrid!.getTranscodeHLS(player.fallbackStream!)
                : undefined
            }
            serverOptimized={
              isServerMode() &&
              player.fallbackStream != null &&
              player.fallbackStream.backend !== "direct_torrent" &&
              transcodeAvailable &&
              transcodeCapabilities.seekOffset &&
              serverOptimizedQualities.length > 0
                ? {
                    qualities: serverOptimizedQualities,
                    defaultQuality: settings.transcode
                      ? settings.dataSaver
                        ? "480p"
                        : "auto"
                      : null,
                    request: async (
                      quality: ServerTranscodeQuality,
                      absolutePositionSeconds: number,
                    ) =>
                      serverOptimizedSource(player.fallbackStream!, {
                        quality,
                        startSeconds: absolutePositionSeconds,
                        hdrPolicy:
                          /(?:^|[^a-z0-9])(?:dv|dovi|dolby[ ._-]?vision|hdr10\+?|hdr|hlg)(?:[^a-z0-9]|$)/i.test(
                            player.sourceFileName ?? "",
                          ) && transcodeCapabilities.toneMapping
                            ? "tone-map"
                            : "auto",
                        preserveSubtitles: transcodeCapabilities.subtitleSidecar,
                      }),
                  }
                : undefined
            }
            externalPlaybackUrl={
              player.fallbackStream != null
                ? serverExternalPlaybackURL(player.fallbackStream) ?? player.url
                : player.url
            }
            preferredPlayer={settings.preferredExternalPlayer}
            useBuiltInPlayer={settings.builtInPlayer}
            timelineOffsetSeconds={player.timelineOffsetSeconds}
            onTryNextSource={handleTryNextSource}
            refreshCurrentSource={handleRefreshCurrentSource}
            initialHandoffState={player.playbackHandoff}
            startPositionSeconds={player.startPositionSeconds}
            savedPrefs={player.savedPrefs}
            playerPreferences={playerPreferences}
            scrobbleContext={player.scrobbleContext}
            onClose={closePlayer}
            onProgress={(current, duration, prefs) => {
              lastPlayerProgressRef.current = current;
              // Persist a resume position against the title (movies) or the
              // SNAPSHOTTED episode (series) so Continue Watching resumes the
              // right thing even if the picker changed mid-playback. `prefs`
              // carries the in-window player's audio/sub/speed for next time.
              recordResume(detailItem, current, duration, player.episodeId, prefs);
            }}
            onEnded={(current, duration, prefs) => {
              recordResume(detailItem, current, duration, player.episodeId, prefs);
              void queueVerifiedNextEpisode();
            }}
            // Subtitle search/translate context. The client/config are null when
            // the OpenSubtitles key / AI provider aren't configured, so the
            // player gates those affordances gracefully.
            subtitleClient={services.subtitles}
            translator={services.translator}
            imdbId={detail.data.imdbId}
            season={player.season}
            episode={player.episode}
            upNext={
              upNextTarget != null
                ? { label: episodeLabel(upNextTarget.season, upNextTarget.episode) }
                : null
            }
            onPlayNext={handlePlayNext}
            autoCountdown={Boolean(settings.autoAdvanceEpisodes) && !settings.dataSaver}
          />
        </Suspense>
      )}

      {trailerOpen && trailer.key != null && (
        <TrailerModal
          videoKey={trailer.key}
          title={detailItem.title}
          onClose={closeTrailer}
        />
      )}
    </div>
  );
}
