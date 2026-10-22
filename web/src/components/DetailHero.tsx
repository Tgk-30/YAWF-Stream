// DetailHero - cinematic top of the Detail screen.
//
// Full-bleed backdrop with a slow Ken Burns drift + layered scrim/vignette, then
// poster + large title, a dotted meta row, genre chips, the overview, and the
// primary actions (Play prominent + Watchlist). Content settles in with motion.

import { useState, type ReactNode } from "react";
import { MediaItem as MediaItemNS } from "../models/media";
import type { MediaItem } from "../models/media";
import { Icon } from "./Icon";
import { ImgWithFallback } from "./ImgWithFallback";
import "./DetailHero.css";

/** The user's current like/dislike taste signal for this title (drives the
 *  thumbs control's active state). */
export type TasteSignal = "liked" | "disliked" | null;

interface DetailHeroProps {
  item: MediaItem;
  inWatchlist: boolean;
  onPlay: () => void;
  /** Primary action copy. Detail uses a setup label when playback prerequisites
   * are missing so phone users get an actionable control instead of a no-op. */
  playLabel?: string;
  onToggleWatchlist: () => void;
  /** Server Mode only - file a title request for this item. Omitted (and the
   *  button hidden) in Local Mode. */
  onRequest?: () => void;
  /** Drives the Request button label/disabled state: idle → "Request",
   *  requesting → busy, requested → "Requested", already → "Already requested". */
  requestState?: "idle" | "requesting" | "requested" | "already" | "failed";
  /** Current like/dislike signal for this title (null = no signal yet). */
  tasteSignal?: TasteSignal;
  /** Record (or toggle off) a like/dislike taste signal for this title. */
  onTasteSignal?: (signal: "liked" | "disliked") => void;
  /** When set, Play is disabled and this explains why (e.g. no debrid service
   *  configured yet) - an honest gate instead of a click that goes nowhere. */
  playDisabledReason?: string | null;
  /** Local desktop-only download action, rendered beside Play when supplied. */
  onDownload?: () => void;
  /** Honest explanation for a disabled download action. */
  downloadDisabledReason?: string | null;
  /** Movie-only watched state, controlled by Detail's durable history row. */
  movieWatched?: boolean;
  /** Movie-only action to toggle the durable watched history row. */
  onToggleMovieWatched?: () => void;
  /** Async external ratings owned by Detail, placed beside the TMDB score. */
  externalRatings?: ReactNode;
  /** Full-title completion state derived from durable watch history. */
  completionLabel?: "Watched" | "Completed" | null;
}

export function DetailHero({
  item,
  inWatchlist,
  onPlay,
  playLabel = "Play",
  onToggleWatchlist,
  onRequest,
  requestState = "idle",
  tasteSignal = null,
  onTasteSignal,
  playDisabledReason = null,
  onDownload,
  downloadDisabledReason = null,
  movieWatched = false,
  onToggleMovieWatched,
  externalRatings,
  completionLabel = null,
}: DetailHeroProps) {
  const itemKey = `${item.type}:${item.id}`;
  const backdrop = MediaItemNS.backdropURL(item);
  const [backdropFailedFor, setBackdropFailedFor] = useState<string | null>(null);
  const backdropFailed = backdropFailedFor === itemKey;
  const poster = MediaItemNS.posterThumbnailURL(item);
  const rating = MediaItemNS.ratingString(item);
  const runtime = MediaItemNS.runtimeString(item);

  const metaBits = [
    item.year != null ? String(item.year) : null,
    runtime || null,
    item.status || null,
  ].filter(Boolean) as string[];

  return (
    <div className="detail-hero">
      <div
        key={`backdrop:${itemKey}`}
        className="detail-hero-backdrop-layer"
      >
        {backdrop && !backdropFailed ? (
          <img
            className="detail-hero-backdrop"
            src={backdrop}
            alt=""
            draggable={false}
            onError={() => setBackdropFailedFor(itemKey)}
          />
        ) : (
          // No backdrop, or it failed to load → the on-brand gradient instead of
          // a broken-image frame.
          <div className="detail-hero-backdrop hero-gradient" />
        )}
      </div>
      <div className="detail-hero-scrim" />
      <div className="detail-hero-vignette" />

      <div
        key={`content:${itemKey}`}
        className="detail-hero-content"
      >
        {poster && (
          <ImgWithFallback
            className="detail-hero-poster"
            src={poster}
            alt={item.title}
            draggable={false}
            fallback={
              <div
                className="detail-hero-poster detail-hero-poster-placeholder"
                aria-hidden="true"
              >
                <Icon name="discover" size={30} />
              </div>
            }
          />
        )}

        <div className="detail-hero-info">
          <div className="detail-hero-title-row">
            <h1 className="detail-hero-title">{item.title}</h1>
            {completionLabel != null && (
              <span className="detail-hero-completion" aria-label={completionLabel}>
                <Icon name="check" size={13} />
                {completionLabel}
              </span>
            )}
          </div>

          <div className="detail-hero-ratings">
            {rating !== "N/A" && (
              <span className="detail-hero-rating">
                <Icon name="star" size={13} className="t-warning" />
                {rating}
              </span>
            )}
            {externalRatings}
          </div>

          <div className="detail-hero-meta">
            {metaBits.map((bit, i) => (
              <span key={bit + i} className="detail-hero-metabit">
                {i > 0 && <span className="detail-hero-dot">·</span>}
                {bit}
              </span>
            ))}
          </div>

          {item.genres.length > 0 && (
            <div className="detail-hero-genres">
              {item.genres.slice(0, 4).map((g) => (
                <span key={g} className="detail-genre-chip">
                  {g}
                </span>
              ))}
            </div>
          )}

          {item.overview && <p className="detail-hero-overview">{item.overview}</p>}

          <div className="detail-hero-actions">
            <button
              type="button"
              className="btn btn-prominent detail-play"
              onClick={onPlay}
              disabled={playDisabledReason != null}
              title={playDisabledReason ?? "Play"}
            >
              <Icon name="play" size={16} />
              {playLabel}
            </button>
            {onDownload && (
              <button
                type="button"
                className="btn detail-download"
                onClick={onDownload}
                disabled={downloadDisabledReason != null}
                title={downloadDisabledReason ?? "Download"}
              >
                <Icon name="debrid" size={16} />
                Download
              </button>
            )}
            {onToggleMovieWatched && (
              <button
                type="button"
                className={`btn detail-watched${movieWatched ? " is-on" : ""}`}
                onClick={onToggleMovieWatched}
                aria-pressed={movieWatched}
                title={movieWatched ? "Watched. Mark unwatched" : "Mark watched"}
              >
                <Icon name="check" size={16} filled={movieWatched} />
                {movieWatched ? "Mark unwatched" : "Mark watched"}
              </button>
            )}
            <button
              type="button"
              className={`btn detail-watch${inWatchlist ? " is-on" : ""}`}
              onClick={onToggleWatchlist}
              aria-pressed={inWatchlist}
            >
              <Icon name="watchlist" size={16} filled={inWatchlist} />
              {inWatchlist ? "In watchlist" : "Watchlist"}
            </button>
            {onRequest && (
              <button
                type="button"
                className={`btn detail-request${
                  requestState === "requested" || requestState === "already"
                    ? " is-on"
                    : ""
                }`}
                onClick={onRequest}
                disabled={
                  requestState === "requesting" ||
                  requestState === "requested" ||
                  requestState === "already"
                }
                title={
                  requestState === "already"
                    ? "Already requested"
                    : requestState === "requested"
                      ? "Request sent"
                      : requestState === "failed"
                        ? "Request failed - tap to try again"
                        : "Ask an admin to add this title"
                }
              >
                <Icon
                  name={
                    requestState === "requested" || requestState === "already"
                      ? "check"
                      : "library"
                  }
                  size={16}
                />
                {requestState === "requesting"
                  ? "Requesting…"
                  : requestState === "requested"
                    ? "Requested"
                    : requestState === "already"
                      ? "Already requested"
                      : requestState === "failed"
                        ? "Request failed - retry"
                        : "Request"}
              </button>
            )}

            {onTasteSignal && (
              <div
                className="detail-taste"
                role="group"
                aria-label="Rate this title for your taste profile"
              >
                <button
                  type="button"
                  className={`detail-taste-btn${tasteSignal === "liked" ? " is-liked" : ""}`}
                  onClick={() => onTasteSignal("liked")}
                  aria-pressed={tasteSignal === "liked"}
                  aria-label="I like this"
                  title="I like this"
                >
                  <Icon name="thumbs-up" size={16} filled={tasteSignal === "liked"} />
                </button>
                <button
                  type="button"
                  className={`detail-taste-btn${tasteSignal === "disliked" ? " is-disliked" : ""}`}
                  onClick={() => onTasteSignal("disliked")}
                  aria-pressed={tasteSignal === "disliked"}
                  aria-label="Not for me"
                  title="Not for me"
                >
                  <Icon
                    name="thumbs-down"
                    size={16}
                    filled={tasteSignal === "disliked"}
                  />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
