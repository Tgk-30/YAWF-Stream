// EpisodePicker - the season/episode browser on a series' Detail screen.
//
// Rich mode (an episode guide is available - local TMDB key or the Server-Mode
// metadata proxy): a season chip row plus an episode list with stills, titles,
// air dates/runtimes, per-episode resume bars, and an accent ring on the
// selected episode. Selecting an episode re-drives the stream search below.
//
// Degraded mode (no guide): a plain season/episode stepper so streaming still
// works - "Episode guide unavailable - pick the season and episode to search."

import { useEffect, useState } from "react";
import type { TMDBService } from "../services/metadata/TMDBService";
import type { Episode } from "../models/media";
import { episodeIdFor, useEpisodes, useSeasons } from "../data/episodes";
import { seasonIsWatched } from "../data/watchedState";
import { Icon } from "./Icon";
import { ImgWithFallback } from "./ImgWithFallback";
import { isNetworkAllowed } from "../lib/networkPolicy";
import "./EpisodePicker.css";

const TMDB_STILL_BASE = "https://image.tmdb.org/t/p/w300";
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// Above this many seasons the chip row gets unwieldy (wraps into a big block),
// so we switch to a compact "Season N" dropdown instead.
const MANY_SEASONS = 6;

/** A season's dropdown label: its TMDB name (or "Season N") + episode count. */
function seasonOptionLabel(s: {
  name: string;
  seasonNumber: number;
  episodeCount: number;
}): string {
  const base = s.name || `Season ${s.seasonNumber}`;
  return s.episodeCount > 0 ? `${base} · ${s.episodeCount} eps` : base;
}

interface EpisodePickerProps {
  /** Numeric TMDB id for the series (null → degraded stepper mode). */
  tmdbId: number | null;
  /** Exact IMDb identity used by Stremio and Cinemeta episode numbering. */
  imdbId?: string | null;
  tmdb: TMDBService | null;
  selected: { season: number; episode: number };
  onSelect: (next: { season: number; episode: number }) => void;
  /** `s2e5` → 0..1 resume fraction for this series' episodes. */
  progressByEpisodeId?: Record<string, number>;
  /** Episode ids the user has finished (drives the row check state). */
  watchedEpisodeIds?: Set<string>;
  /** Toggle an episode's watched state; `watched` is the DESIRED new state. */
  onToggleWatched?: (
    ep: { season: number; episode: number },
    watched: boolean,
  ) => void;
  /** Toggle every currently loaded episode in the browsed season. */
  onToggleSeasonWatched?: (
    episodes: Array<{ season: number; episode: number }>,
    watched: boolean,
  ) => void;
  /** Toggle every regular season in the series. */
  onToggleSeriesWatched?: (watched: boolean) => void;
  /** True only when every regular TMDB season is complete. */
  seriesWatched?: boolean;
}

function airDateLabel(airDate: string | null | undefined): string | null {
  if (!airDate) return null;
  const d = new Date(`${airDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return DATE_FMT.format(d);
}

function metaLabel(ep: Episode): string {
  const bits = [airDateLabel(ep.airDate), ep.runtime != null ? `${ep.runtime} min` : null];
  return bits.filter(Boolean).join(" · ");
}

export function EpisodePicker({
  tmdbId,
  imdbId = null,
  tmdb,
  selected,
  onSelect,
  progressByEpisodeId = {},
  watchedEpisodeIds,
  onToggleWatched,
  onToggleSeasonWatched,
  onToggleSeriesWatched,
  seriesWatched = false,
}: EpisodePickerProps) {
  const seasons = useSeasons(tmdbId, true, tmdb, imdbId);
  const rich = seasons.source === "live";

  // The season being BROWSED (chip row) - follows the selected episode's
  // season by default but browsing doesn't change the selection until an
  // episode is tapped.
  const [browseSeason, setBrowseSeason] = useState(selected.season);
  useEffect(() => {
    setBrowseSeason(selected.season);
  }, [selected.season, tmdbId, imdbId]);

  const episodes = useEpisodes(
    rich ? tmdbId : null,
    rich ? browseSeason : null,
    tmdb,
    imdbId,
  );
  const season = seasons.seasons.find((item) => item.seasonNumber === browseSeason);
  const seasonWatched = seasonIsWatched(
    watchedEpisodeIds ?? new Set<string>(),
    browseSeason,
    season?.episodeCount ?? 0,
  );
  const seasonEpisodes = episodes.episodes.map((episode) => ({
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
  }));

  // Degraded stepper state mirrors the selection directly.
  function step(field: "season" | "episode", delta: number) {
    const next = {
      season: Math.max(1, selected.season + (field === "season" ? delta : 0)),
      // Changing season resets the episode to 1 (a new season's numbering).
      episode:
        field === "season"
          ? 1
          : Math.max(1, selected.episode + delta),
    };
    onSelect(next);
  }

  if (seasons.loading) {
    return (
      <section className="episode-picker glass-rest" aria-label="Episodes" aria-busy="true">
        <div className="episode-picker-head">
          <h3 className="episode-picker-title">Episodes</h3>
        </div>
        <ul className="episode-list">
          {[0, 1, 2].map((i) => (
            <li key={i} className="episode-row episode-row-skel" aria-hidden>
              <span className="episode-still-skel skel" />
              <span className="episode-body-skel">
                <span className="skel-line skel" />
                <span className="skel-line skel-meta skel" />
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (!rich) {
    return (
      <section className="episode-picker glass-rest" aria-label="Episodes">
        <div className="episode-picker-head">
          <h3 className="episode-picker-title">Episodes</h3>
        </div>
        <p className="episode-picker-note t-secondary">
          Episode guide unavailable - pick the season and episode to search.
        </p>
        <div className="episode-stepper-row">
          {(["season", "episode"] as const).map((field) => (
            <div key={field} className="episode-stepper glass-rest">
              <span className="episode-stepper-label t-secondary">
                {field === "season" ? "Season" : "Episode"}
              </span>
              <button
                type="button"
                className="episode-stepper-btn"
                aria-label={`Previous ${field}`}
                onClick={() => step(field, -1)}
              >
                −
              </button>
              <span className="episode-stepper-value">
                {field === "season" ? selected.season : selected.episode}
              </span>
              <button
                type="button"
                className="episode-stepper-btn"
                aria-label={`Next ${field}`}
                onClick={() => step(field, 1)}
              >
                +
              </button>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="episode-picker glass-rest" aria-label="Episodes">
      <div className="episode-picker-head">
        <h3 className="episode-picker-title">Episodes</h3>
        {seasons.seasons.length > MANY_SEASONS ? (
          // Many seasons → a compact dropdown so the head doesn't wrap into a
          // huge chip block. Still a real, keyboard-accessible season selector.
          <label className="episode-season-select glass-rest">
            <span className="episode-season-select-label t-secondary">Season</span>
            <select
              className="episode-season-select-input"
              value={browseSeason}
              onChange={(e) => setBrowseSeason(Number(e.target.value))}
              aria-label="Season"
            >
              {seasons.seasons.map((s) => (
                <option key={s.id} value={s.seasonNumber}>
                  {seasonOptionLabel(s)}
                </option>
              ))}
            </select>
            <span className="episode-season-select-caret" aria-hidden>
              ▾
            </span>
          </label>
        ) : (
          <div className="episode-picker-seasons">
            {seasons.seasons.map((s) => (
              <button
                key={s.id}
                type="button"
                className={
                  "episode-season-chip chip" +
                  (s.seasonNumber === browseSeason ? " is-active" : "")
                }
                aria-pressed={s.seasonNumber === browseSeason}
                onClick={() => setBrowseSeason(s.seasonNumber)}
              >
                {s.name || `Season ${s.seasonNumber}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {(onToggleSeasonWatched != null || onToggleSeriesWatched != null) && (
        <div className="episode-picker-watch-controls" role="group" aria-label="Watched controls">
          {onToggleSeasonWatched != null && (
            <button
              type="button"
              className={`episode-rollup-btn${seasonWatched ? " is-watched" : ""}`}
              aria-pressed={seasonWatched}
              disabled={episodes.loading || seasonEpisodes.length === 0}
              onClick={() => onToggleSeasonWatched(seasonEpisodes, !seasonWatched)}
            >
              <Icon name="check" size={14} />
              {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
            </button>
          )}
          {onToggleSeriesWatched != null && (
            <div className="episode-rollup-series">
              <span className="episode-rollup-series-label">Entire series</span>
              <button
                type="button"
                className={`episode-rollup-series-btn${seriesWatched ? " is-watched" : ""}`}
                aria-pressed={seriesWatched}
                disabled={seasons.loading || seasons.seasons.length === 0}
                onClick={() => onToggleSeriesWatched(!seriesWatched)}
              >
                <Icon name="check" size={13} />
                {seriesWatched
                  ? "Mark entire series unwatched"
                  : "Mark entire series watched"}
              </button>
            </div>
          )}
        </div>
      )}

      <ul className="episode-list" aria-busy={episodes.loading}>
        {episodes.loading &&
          [0, 1, 2].map((i) => (
            <li key={`skel-${i}`} className="episode-row episode-row-skel" aria-hidden>
              <span className="episode-still-skel skel" />
              <span className="episode-body-skel">
                <span className="skel-line skel" />
                <span className="skel-line skel-meta skel" />
              </span>
            </li>
          ))}
        {!episodes.loading &&
          episodes.episodes.map((ep) => {
            const id = episodeIdFor(ep.seasonNumber, ep.episodeNumber);
            const isSelected =
              ep.seasonNumber === selected.season &&
              ep.episodeNumber === selected.episode;
            const progress = progressByEpisodeId[id];
            const watched = watchedEpisodeIds?.has(id) ?? false;
            const meta = metaLabel(ep);
            return (
              <li
                key={id}
                className={"episode-row-item" + (watched ? " is-watched" : "")}
              >
                <button
                  type="button"
                  className={"episode-row" + (isSelected ? " is-selected" : "")}
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelect({ season: ep.seasonNumber, episode: ep.episodeNumber })
                  }
                >
                  {ep.stillPath && isNetworkAllowed("images") ? (
                    <ImgWithFallback
                      className="episode-still"
                      src={`${TMDB_STILL_BASE}${ep.stillPath}`}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      fallback={<span className="episode-still episode-still-empty" aria-hidden="true" />}
                    />
                  ) : (
                    <span className="episode-still episode-still-empty" aria-hidden />
                  )}
                  <span className="episode-body">
                    <span className="episode-head">
                      <span className="episode-num chip">E{ep.episodeNumber}</span>
                      <span className="episode-name">
                        {ep.title || `Episode ${ep.episodeNumber}`}
                      </span>
                    </span>
                    {meta !== "" && (
                      <span className="episode-meta t-secondary">{meta}</span>
                    )}
                    {ep.overview && (
                      <span className="episode-overview t-secondary">{ep.overview}</span>
                    )}
                    {progress != null && (
                      <span className="episode-progress" aria-hidden>
                        <span
                          className="episode-progress-fill"
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </span>
                    )}
                  </span>
                </button>
                {onToggleWatched != null && (
                  <button
                    type="button"
                    className={
                      "episode-watched-btn" + (watched ? " is-watched" : "")
                    }
                    aria-pressed={watched}
                    aria-label={
                      watched
                        ? `Mark E${ep.episodeNumber} unwatched`
                        : `Mark E${ep.episodeNumber} watched`
                    }
                    title={watched ? "Mark unwatched" : "Mark watched"}
                    onClick={() =>
                      onToggleWatched(
                        { season: ep.seasonNumber, episode: ep.episodeNumber },
                        !watched,
                      )
                    }
                  >
                    <Icon name="check" size={15} />
                  </button>
                )}
              </li>
            );
          })}
        {!episodes.loading && episodes.episodes.length === 0 && (
          <li className="episode-picker-note t-secondary">
            No episode list for this season yet.
          </li>
        )}
      </ul>
    </section>
  );
}
