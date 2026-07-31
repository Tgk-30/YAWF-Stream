// Cached-on-debrid stream picker (mirrors the native StreamListView).
//
// Given resolved stream rows (torrent + cache state from data/streams.ts), this
// renders each as a row with: a quality chip (1080p · H.265 · BluRay · Atmos),
// a green "Instant · RD/AD/PM/TB" badge when it's cached on a debrid service or
// a grey "Will cache" badge otherwise, and seeders / size / indexer metadata.
// A "Cached only" toggle filters to instant streams and the list is cached-first
// sorted. Selecting a row resolves the stream through the caller's resolver
// (local DebridManager in Local Mode, self-hosted API in Server Mode) and hands
// the URL up for playback.

import { useEffect, useMemo, useState } from "react";
import {
  DebridServiceType,
  fileMatchesEpisode,
  type StreamInfo,
} from "../services/debrid/models";
import {
  TorrentResult,
  VideoCodec,
  VideoQuality,
} from "../services/indexers/models";
import {
  classifyRowForEpisode,
  filterStreamRows,
  type StreamRow,
  type StreamsState,
} from "../data/streams";
import { formatSize } from "../data/debridLibrary";
import { useAppStore } from "../store/AppStore";
import {
  actionableProviderError,
  rankSources,
  type RankedSource,
  type SourceAssessment,
} from "../data/sourceIntelligence";
import { isDesktopTauri } from "../lib/tauri";
import { Icon } from "./Icon";
import { ErrorNote } from "./ErrorNote";
import "./StreamPicker.css";

/** A cached debrid source should return quickly. Bound the UI wait so a stalled
 * provider request cannot leave a stream row permanently in Resolving state. */
export const STREAM_RESOLVE_TIMEOUT_MS = 15_000;

type ResolutionStatus = "resolving" | "failed";

function cacheStatusFor(row: StreamRow): NonNullable<StreamRow["cacheStatus"]> {
  if (row.cachedOn != null) return "cached";
  // Older self-hosted servers only send cachedOn. Keep their established
  // uncached behavior until they begin sending the explicit status field.
  return row.cacheStatus ?? "not_cached";
}

function resolveWithinTimeout<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error("This stream took too long to resolve. Try again or pick another source."));
    }, STREAM_RESOLVE_TIMEOUT_MS);
    // Wrap the call so a non-conforming resolver that throws synchronously also
    // follows the ordinary failure path and clears the pending timer.
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => globalThis.clearTimeout(timer));
  });
}

function assertPackEpisodeMatch(
  row: StreamRow,
  stream: StreamInfo,
  episodeContext: { season: number; episode: number } | null,
): void {
  if (
    episodeContext == null ||
    classifyRowForEpisode(row, episodeContext.season, episodeContext.episode) !== "pack" ||
    fileMatchesEpisode(stream.fileName, episodeContext)
  ) {
    return;
  }
  const season = String(episodeContext.season).padStart(2, "0");
  const episode = String(episodeContext.episode).padStart(2, "0");
  throw new Error(`Couldn't find S${season}E${episode} in this season pack. Try another source.`);
}

interface StreamPickerProps {
  state: StreamsState;
  resolveStream: (row: StreamRow) => Promise<StreamInfo>;
  /** Called with the resolved stream + the torrent (for codec/container info). */
  onPlay: (stream: StreamInfo, source: TorrentResult) => void;
  onOpenSettings?: () => void;
  /** "S2 E5" when a series episode is selected - shown in the header so the
   *  user can see WHY the list is episode-scoped. Null for movies. */
  episodeLabel?: string | null;
  /** The selected episode, for tagging season-pack releases. Null for movies. */
  episodeContext?: { season: number; episode: number } | null;
  /** Runtime enables a conservative bitrate estimate instead of guessing from
   * file size alone. */
  runtimeMinutes?: number | null;
  /** True when the connected server can adapt a source the browser cannot
   * direct play. */
  transcodeAvailable?: boolean;
}

export function StreamPicker({
  state,
  resolveStream,
  onPlay,
  onOpenSettings,
  episodeLabel = null,
  episodeContext = null,
  runtimeMinutes = null,
  transcodeAvailable = false,
}: StreamPickerProps) {
  const { settings } = useAppStore();
  // Settings supplies the initial preference for each picker. The local state
  // remains session-scoped so switching this checkbox does not rewrite a
  // person's saved default.
  const [cachedOnly, setCachedOnly] = useState(() => settings.streamCachedOnly);
  const [resFilter, setResFilter] = useState<VideoQuality | null>(null);
  const [codecFilter, setCodecFilter] = useState<VideoCodec | null>(null);
  const [visibleCount, setVisibleCount] = useState(10);
  const [resolutionStates, setResolutionStates] = useState<Record<string, ResolutionStatus>>({});
  const [resolveError, setResolveError] = useState<string | null>(null);
  const playbackProfile = isDesktopTauri()
    ? "native" as const
    : transcodeAvailable
      ? "browser-transcode" as const
      : "browser-direct" as const;

  // Clear the resolution/codec chips whenever the underlying results change
  // (a new title is opened). A stale value is already ignored if it no longer
  // appears, but if the next title HAPPENS to share that resolution/codec the
  // old chip would silently pre-filter it - surprising the user. Resetting on
  // the rows identity keeps the picker unfiltered for each newly opened title.
  useEffect(() => {
    setResFilter(null);
    setCodecFilter(null);
    setVisibleCount(10);
    setResolutionStates({});
  }, [state.rows]);

  // The data-saver-eligible rows are the basis for both the chips and the list.
  const baseRows = useMemo(
    () => filterStreamRows(state.rows, { ...settings, streamCachedOnly: false }),
    [state.rows, settings],
  );
  const cacheCheckUnavailable =
    state.phase !== "checking_availability" &&
    state.hasDebrid &&
    baseRows.length > 0 &&
    baseRows.every((row) => cacheStatusFor(row) === "unavailable");

  // A saved Cached-only preference must not hide every indexed release when
  // the provider check itself failed. Show the sources and explain the issue.
  useEffect(() => {
    if (cacheCheckUnavailable) setCachedOnly(false);
  }, [cacheCheckUnavailable]);

  // Resolution + codec chips, shown ONLY for the values that actually appear in
  // this title's results (so we never offer a "4K" chip that filters to nothing).
  const availableQualities = useMemo(() => {
    const present = new Set(baseRows.map((r) => r.result.quality));
    return ([
      VideoQuality.uhd4k,
      VideoQuality.hd1080p,
      VideoQuality.hd720p,
      VideoQuality.sd480p,
    ] as const).filter((q) => present.has(q));
  }, [baseRows]);
  const availableCodecs = useMemo(() => {
    const present = new Set(baseRows.map((r) => r.result.codec));
    return ([VideoCodec.h265, VideoCodec.h264, VideoCodec.av1] as const).filter(
      (c) => present.has(c),
    );
  }, [baseRows]);

  // A stale chip (selected, then the title changed and no longer has it) is
  // ignored rather than filtering to an empty list.
  const effRes = resFilter != null && availableQualities.includes(resFilter) ? resFilter : null;
  const effCodec = codecFilter != null && availableCodecs.includes(codecFilter) ? codecFilter : null;

  // Cached-first sort (the underlying list is already quality/seeder sorted).
  const rows = useMemo(() => {
    const filtered = baseRows.filter(
      (r) =>
        (!cachedOnly ||
          state.phase === "checking_availability" ||
          r.cachedOn != null) &&
        (effRes == null || r.result.quality === effRes) &&
        (effCodec == null || r.result.codec === effCodec),
    );
    return rankSources(filtered, {
      profile: playbackProfile,
      runtimeMinutes,
    });
  }, [
    baseRows,
    cachedOnly,
    effRes,
    effCodec,
    playbackProfile,
    runtimeMinutes,
    state.phase,
  ]);
  const rowValues = useMemo(() => rows.map((entry) => entry.row), [rows]);

  // A filter change is a fresh result set, so the next view starts at the fast
  // initial mount size rather than retaining a previous "show more" expansion.
  useEffect(() => {
    setVisibleCount(10);
  }, [cachedOnly, effRes, effCodec]);

  const visibleRows = useMemo(
    () => rows.slice(0, visibleCount),
    [rows, visibleCount],
  );

  async function select(row: StreamRow) {
    if (!state.hasDebrid) {
      setResolveError(
        "Add a debrid service in Settings to play - it turns a match into an instant stream.",
      );
      return;
    }
    const hash = row.result.infoHash;
    if (resolutionStates[hash] === "resolving") return;
    setResolveError(null);
    setResolutionStates((current) => ({ ...current, [hash]: "resolving" }));
    try {
      const stream = await resolveWithinTimeout(() => resolveStream(row));
      // DebridFileSelector normally chooses the hinted file within a pack. A
      // provider can still return an untagged/default file, so never start the
      // wrong episode when a season-pack row lacks the requested episode.
      assertPackEpisodeMatch(row, stream, episodeContext);
      onPlay(stream, row.result);
    } catch (err) {
      setResolveError(actionableProviderError(err));
      setResolutionStates((current) => ({ ...current, [hash]: "failed" }));
    } finally {
      // A failed resolve stays visibly terminal and retryable. A successful
      // resolve drops back to its normal Instant/Will cache badge while play
      // starts; a late completion after the timeout cannot call onPlay.
      setResolutionStates((current) => {
        if (current[hash] !== "resolving") return current;
        const next = { ...current };
        delete next[hash];
        return next;
      });
    }
  }

  const filteredCount = baseRows.length;
  const cachedCount = baseRows.filter((r) => r.cachedOn != null).length;
  const hasQualityChips =
    availableQualities.length > 1 || availableCodecs.length > 1;

  return (
    <section className="streams">
      <div className="streams-head">
        <h2 className="streams-title">
          Available streams
          {episodeLabel != null && (
            <span className="streams-episode-label t-secondary"> · {episodeLabel}</span>
          )}
        </h2>
        {state.hasIndexers && state.rows.length > 0 && (
          <div className="streams-controls">
            <span className="streams-count t-secondary">
              {cacheCheckUnavailable
                ? `Cache check unavailable · ${state.rows.length} total`
                : `${cachedCount} instant · ${state.rows.length} total`}
              {visibleRows.length < rows.length ? ` · ${visibleRows.length} shown` : ""}
            </span>
            <label className="streams-toggle">
              <input
                type="checkbox"
                checked={cachedOnly}
                disabled={
                  cacheCheckUnavailable ||
                  state.phase === "checking_availability"
                }
                onChange={(e) => setCachedOnly(e.target.checked)}
              />
              Cached only
            </label>
          </div>
        )}
      </div>

      {state.hasIndexers && state.rows.length > 0 && hasQualityChips && (
        <div className="streams-filters" role="group" aria-label="Filter streams">
          {availableQualities.length > 1 &&
            availableQualities.map((q) => (
              <button
                key={q}
                type="button"
                className={`chip stream-filter-chip${effRes === q ? " is-active" : ""}`}
                aria-pressed={effRes === q}
                onClick={() => setResFilter((cur) => (cur === q ? null : q))}
              >
                {q}
              </button>
            ))}
          {availableCodecs.length > 1 &&
            availableCodecs.map((c) => (
              <button
                key={c}
                type="button"
                className={`chip stream-filter-chip${effCodec === c ? " is-active" : ""}`}
                aria-pressed={effCodec === c}
                onClick={() => setCodecFilter((cur) => (cur === c ? null : c))}
              >
                {c}
              </button>
            ))}
        </div>
      )}

      {resolveError && (
        <ErrorNote as="div" className="streams-error">
          {resolveError}
        </ErrorNote>
      )}

      {cacheCheckUnavailable && (
        <div className="streams-cache-warning" role="status">
          <Icon name="info" size={16} />
          <span>
            Your provider did not return cache status. The releases are still
            available, but instant availability could not be verified.
          </span>
          {onOpenSettings && (
            <button type="button" className="btn" onClick={onOpenSettings}>
              Check provider
            </button>
          )}
        </div>
      )}

      <StreamBody
        state={state}
        rows={rowValues}
        visibleRows={visibleRows}
        cachedOnly={cachedOnly}
        filteredCount={filteredCount}
        chipFiltersActive={effRes != null || effCodec != null}
        resolutionStates={resolutionStates}
        onSelect={select}
        onShowAll={() => setCachedOnly(false)}
        onClearChips={() => {
          setResFilter(null);
          setCodecFilter(null);
        }}
        onShowMore={() => setVisibleCount((count) => count + 20)}
        onOpenSettings={onOpenSettings}
        episodeLabel={episodeLabel}
        episodeContext={episodeContext}
      />
    </section>
  );
}

function StreamBody({
  state,
  rows,
  visibleRows,
  cachedOnly,
  filteredCount,
  chipFiltersActive,
  resolutionStates,
  onSelect,
  onShowAll,
  onClearChips,
  onShowMore,
  onOpenSettings,
  episodeLabel = null,
  episodeContext = null,
}: {
  state: StreamsState;
  rows: StreamRow[];
  visibleRows: RankedSource[];
  cachedOnly: boolean;
  filteredCount: number;
  chipFiltersActive: boolean;
  resolutionStates: Record<string, ResolutionStatus>;
  onSelect: (row: StreamRow) => void;
  onShowAll: () => void;
  onClearChips: () => void;
  onShowMore: () => void;
  onOpenSettings?: () => void;
  episodeLabel?: string | null;
  episodeContext?: { season: number; episode: number } | null;
}) {
  if (state.loading && rows.length === 0) {
    return (
      <ul className="streams-list streams-skeleton" aria-busy="true" aria-label="Searching sources">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i}>
            <div className="stream-row stream-row-skel" aria-hidden="true">
              <span className="stream-quality-skel skel" />
              <div className="stream-main">
                <span className="skel-line skel-name skel" />
                <span className="skel-line skel-meta skel" />
              </div>
              <span className="stream-badge-skel skel" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (!state.hasIndexers) {
    return (
      <div className="streams-empty glass-rest">
        <Icon name="search" size={22} className="t-secondary" />
        <p className="streams-empty-title">No sources yet</p>
        <p className="t-secondary streams-empty-sub">
          A source is where the app looks for releases. Turn on the built-in
          scrapers, or add one (Torrentio, Jackett, Prowlarr…), in Settings - 
          then pair it with a debrid service to stream instantly.
        </p>
        {onOpenSettings && (
          <div className="streams-empty-actions">
            <button
              type="button"
              className="btn btn-prominent"
              onClick={onOpenSettings}
            >
              <Icon name="settings" size={15} />
              Open settings
            </button>
          </div>
        )}
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="streams-empty glass-rest">
        <p className="streams-empty-title">Couldn't search streams</p>
        <p className="t-secondary streams-empty-sub">{state.error}</p>
      </div>
    );
  }

  if (state.missingImdbId) {
    // No IMDb id ⇒ NO search ever ran. Never render "No streams found" here - 
    // that reads as an exhaustive search that came up empty, when in truth
    // zero requests were made (the silent "streams are not being found" P0).
    return (
      <div className="streams-empty glass-rest">
        <Icon name="info" size={22} className="t-warning" />
        <p className="streams-empty-title">Can't search for this title yet</p>
        <p className="t-secondary streams-empty-sub">
          Sources are searched by IMDb id, and this title doesn't have one yet - 
          usually because the catalog lookup is incomplete or the TMDB key is
          missing. Check Settings → Sources, then reopen this title.
        </p>
        {onOpenSettings && (
          <div className="streams-empty-actions">
            <button type="button" className="btn" onClick={onOpenSettings}>
              <Icon name="settings" size={15} />
              Open settings
            </button>
          </div>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    // Quality/codec chips combined to nothing (each chip alone always matches,
    // but a resolution+codec combination can be empty).
    const chipsEmpty = chipFiltersActive && filteredCount > 0;
    const cachedOnlyEmpty = !chipsEmpty && cachedOnly && filteredCount > 0;
    const filtersEmpty = !chipsEmpty && state.rows.length > 0 && filteredCount === 0;
    // With no debrid service there IS no playback path - saying "sources did
    // not return a match" would be false (nothing was searched for playback).
    // Tell the truth and route to the guided setup.
    const noDebrid = !state.hasDebrid;

    return (
      <div className="streams-empty glass-rest">
        <p className="streams-empty-title">
          {noDebrid
            ? "Almost there - add a debrid service"
            : chipsEmpty
              ? "No streams match those filters"
              : cachedOnlyEmpty
                ? "No instant streams shown"
                : filtersEmpty
                  ? "Playback filters hid every stream"
                  : "No streams found"}
        </p>
        <p className="t-secondary streams-empty-sub">
          {noDebrid
            ? "A debrid service turns a matched release into an instant stream. Nothing was searched for playback yet. Run the two-minute guided setup, or add one in Settings."
            : chipsEmpty
              ? "No release matches that resolution + codec combination. Clear a filter to see more."
              : cachedOnlyEmpty
                ? "Switch off Cached only to show streams that can be cached first."
                : filtersEmpty
                  ? "Your quality or file-size limits removed the available results for this title."
                  : episodeLabel != null
                    ? `The configured sources have no match for ${episodeLabel} yet - try another episode or add another source.`
                    : "The configured sources did not return a match for this title yet. Add another source or try a different release."}
        </p>
        {/* Empty ≠ exhaustive when some sources failed: name them so the user
            knows this result may be incomplete (network/mirror issues). */}
        {!noDebrid && state.sourceErrors.length > 0 && (
          <p className="t-secondary streams-empty-sub streams-source-errors">
            {state.sourceErrors.length === 1 ? "One source" : `${state.sourceErrors.length} sources`}{" "}
            couldn't be reached:{" "}
            {state.sourceErrors.map((e) => e.indexer).join(", ")} - results may
            be incomplete.
          </p>
        )}
        <div className="streams-empty-actions">
          {noDebrid && (
            <button
              type="button"
              className="btn btn-prominent"
              onClick={() => window.dispatchEvent(new Event("ds:open-first-run"))}
            >
              <Icon name="play" size={15} />
              Run guided setup
            </button>
          )}
          {chipsEmpty && (
            <button type="button" className="btn" onClick={onClearChips}>
              Clear filters
            </button>
          )}
          {cachedOnlyEmpty && (
            <button type="button" className="btn" onClick={onShowAll}>
              Show all streams
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              className={cachedOnlyEmpty || noDebrid ? "btn" : "btn btn-prominent"}
              onClick={onOpenSettings}
            >
              <Icon name="settings" size={15} />
              Open settings
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {state.loading && state.phase === "checking_availability" && (
        <div
          className="streams-phase"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="streams-phase-dot" aria-hidden="true" />
          Checking provider availability. Sources are ready to review now.
        </div>
      )}
      <ul className="streams-list">
        {visibleRows.map(({ row, assessment, recommended }) => (
          <StreamRowItem
            key={row.result.infoHash}
            row={row}
            assessment={assessment}
            recommended={recommended}
            resolutionStatus={resolutionStates[row.result.infoHash] ?? null}
            onSelect={() => onSelect(row)}
            pack={
              episodeContext != null &&
              classifyRowForEpisode(row, episodeContext.season, episodeContext.episode) ===
                "pack"
            }
          />
        ))}
      </ul>
      {visibleRows.length < rows.length && (
        <div className="streams-pagination">
          <button type="button" className="btn" onClick={onShowMore}>
            Show 20 more
          </button>
        </div>
      )}
    </>
  );
}

function StreamRowItem({
  row,
  assessment,
  recommended,
  resolutionStatus,
  onSelect,
  pack = false,
}: {
  row: StreamRow;
  assessment: SourceAssessment;
  recommended: boolean;
  resolutionStatus: ResolutionStatus | null;
  onSelect: () => void;
  /** The release is a whole-season pack (not an exact episode file). */
  pack?: boolean;
}) {
  const { result, cachedOn } = row;
  const cached = cachedOn != null;
  const cacheUnavailable = cacheStatusFor(row) === "unavailable";
  const resolving = resolutionStatus === "resolving";
  const failed = resolutionStatus === "failed";

  return (
    <li>
      <button
        type="button"
        className={`stream-row glass-rest glass-lit${cached ? " is-instant" : ""}`}
        onClick={onSelect}
        disabled={resolving}
        title={result.title}
      >
        <span className="stream-quality">{result.quality}</span>

        <div className="stream-main">
          <div className="stream-title-line">
            <div className="stream-name">{result.title}</div>
            {recommended && <span className="stream-recommended-chip">Recommended</span>}
            {pack && <span className="stream-pack-chip">Season pack</span>}
          </div>
          <div className="stream-meta t-secondary">
            <span>{TorrentResult.qualityLabel(result)}</span>
            <span>·</span>
            <span>{formatSize(result.sizeBytes)}</span>
            <span>·</span>
            <span>{result.seeders} seeders</span>
            <span>·</span>
            <span>{result.indexerName}</span>
            {assessment.signals.hdr != null && (
              <>
                <span>·</span>
                <span>{assessment.signals.hdr}</span>
              </>
            )}
            {assessment.signals.remux && (
              <>
                <span>·</span>
                <span>REMUX</span>
              </>
            )}
            {assessment.signals.estimatedMbps != null && (
              <>
                <span>·</span>
                <span>~{Math.round(assessment.signals.estimatedMbps)} Mbps</span>
              </>
            )}
          </div>
          {recommended && (
            <div className="stream-recommendation-reason">
              Why: {assessment.reasons.join(", ")}.
              {assessment.warnings.length > 0
                ? ` Note: ${assessment.warnings.join(", ")}.`
                : ""}
            </div>
          )}
        </div>

        {resolving ? (
          <span className="stream-badge is-resolving">
            <span className="stream-spin" aria-hidden="true" />
            Resolving…
          </span>
        ) : failed ? (
          <span className="stream-badge is-failed">Failed · Retry</span>
        ) : (
          <span
            className={`stream-badge ${
              cached ? "is-cached" : cacheUnavailable ? "is-unknown" : "is-cache"
            }`}
          >
            {cached ? (
              <>
                <Icon name="play" size={11} />
                Instant · {DebridServiceType.shortCode(cachedOn!)}
              </>
            ) : cacheUnavailable ? (
              "Cache unknown"
            ) : (
              "Will cache"
            )}
          </span>
        )}
      </button>
    </li>
  );
}
