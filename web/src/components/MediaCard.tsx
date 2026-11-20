// Premium poster card: a 2:3 poster that lifts + scales on hover (spring) and
// reveals a cinematic info layer (title, year·rating, quick Play/Info) sliding up
// from a gradient scrim - the "expand-on-hover" feel of Netflix/Apple TV+, done
// in place (no neighbor-overlap clipping). Poster fades in on load with a shimmer
// placeholder. Hover and reveal effects are CSS-only so large grids do not
// instantiate animation controllers per card.

import { memo, useCallback, useState } from "react";
import { MediaPreview as MediaPreviewNS } from "../models/media";
import type { MediaPreview } from "../models/media";
import { Icon } from "./Icon";
import { continuationForSearchPreview } from "../data/episodeSource";
import "./MediaCard.css";

interface MediaCardProps {
  item: MediaPreview;
  onSelect?: (item: MediaPreview) => void;
  /** Quick-play affordance (optional) - falls back to onSelect. */
  onPlay?: (item: MediaPreview) => void;
  /** Green "Ready to play" badge (a cached resolution exists). */
  ready?: boolean;
  /** Resume progress as a fraction 0..1 - renders a bottom "Continue Watching"
   * progress bar on the poster. Omit (or 0) to hide it. */
  progress?: number;
  /** Small glass chip in the poster corner (e.g. "S2 E5" on a series' Continue
   * Watching card). Rendered only when present. */
  cornerLabel?: string;
  /** 1-based rank - renders a large ghosted numeral to the left of the poster
   * (the Apple TV "Top 10" treatment). Omit for an ordinary card. */
  rank?: number;
  /** Finished-watching indicator - renders a small check badge on the poster.
   * Mutually exclusive with the in-progress bar in practice (a watched title has
   * no resume point). Omit (or false) to hide it. */
  watched?: boolean;
  /** Whether the persistent poster rating chip is enabled in Appearance. */
  showPosterRatings: boolean;
}

/** A stable hue (0-359) derived from the title so a poster-less card gets a
 *  consistent, distinct fallback color instead of a flat grey box. */
function hueFor(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) % 360;
  }
  return hash;
}

// memo: a grid re-render (filter/scroll/parent state) shouldn't re-run 100+ cards
// whose props are unchanged.
export const MediaCard = memo(function MediaCard({
  item,
  onSelect,
  onPlay,
  ready = false,
  progress,
  cornerLabel,
  rank,
  watched = false,
  showPosterRatings,
}: MediaCardProps) {
  const poster = MediaPreviewNS.posterURL(item);
  const rating = MediaPreviewNS.ratingString(item);
  const [loaded, setLoaded] = useState(false);
  // A poster URL can still 404 or fail to decode. Track that so we swap in the
  // designed fallback tile instead of leaving the browser's broken-image glyph.
  const [failed, setFailed] = useState(false);
  const showFallback = poster == null || failed;
  const continuation = continuationForSearchPreview(item);
  const title = continuation?.childTitle ?? item.title;
  const year = continuation?.childYear ?? item.year;
  const initial = title.trim().charAt(0).toUpperCase() || "?";

  // Stable handlers so the memo above isn't defeated by a fresh closure each render.
  const handleSelect = useCallback(() => onSelect?.(item), [onSelect, item]);
  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      (onPlay ?? onSelect)?.(item);
    },
    [onPlay, onSelect, item],
  );

  return (
    <button
      type="button"
      className={rank != null ? "media-card is-ranked" : "media-card"}
      onClick={handleSelect}
      title={title}
      aria-label={rank != null ? `#${rank}: ${title}` : title}
    >
      {rank != null && (
        <span className="media-card-rank" aria-hidden="true">
          {rank}
        </span>
      )}
      <div className="media-card-poster">
        {showFallback ? (
          <div
            className="media-card-fallback"
            style={{ "--fallback-hue": String(hueFor(title)) } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className="media-card-fallback-initial">{initial}</span>
            <Icon name="discover" size={20} className="media-card-fallback-icon" />
          </div>
        ) : (
          <img
            ref={(el) => {
              // Already-cached posters can be `complete` before React attaches
              // onLoad (which it never replays for a cached image), leaving the
              // poster stuck at opacity 0 under a permanent shimmer. Reconcile
              // synchronously on mount/commit.
              if (el?.complete && el.naturalWidth > 0) setLoaded(true);
            }}
            src={poster}
            alt={title}
            loading="lazy"
            decoding="async"
            draggable={false}
            className={loaded ? "is-loaded" : ""}
            onLoad={() => setLoaded(true)}
            onError={() => {
              // Swap to the designed fallback rather than the broken-image glyph.
              setFailed(true);
              setLoaded(true);
            }}
          />
        )}
        {!loaded && !showFallback && <div className="media-card-shimmer" aria-hidden />}

        {ready && (
          <span className="media-card-ready" title="Ready to play">
            <Icon name="play" size={10} />
            Ready
          </span>
        )}

        {cornerLabel != null && (
          <span className="media-card-corner-label">{cornerLabel}</span>
        )}

        {watched && (
          <span className="media-card-watched" title="Watched" aria-label="Watched">
            <Icon name="check" size={11} />
          </span>
        )}

        {showPosterRatings && rating !== "" && rating !== "N/A" && (
          <span
            className="media-card-poster-rating"
            aria-label={`Rating ${rating} out of 10`}
          >
            <Icon name="star" size={10} className="t-warning" />
            {rating}
          </span>
        )}

        {/* Cinematic reveal layer - fades/slides in on hover. */}
        <div className="media-card-reveal">
          <div className="media-card-reveal-inner">
            <div className="media-card-reveal-title">{title}</div>
            <div className="media-card-reveal-meta">
              {year != null && <span>{year}</span>}
              {rating !== "" && (
                <span className="media-card-reveal-rating">
                  <Icon name="star" size={10} className="t-warning" />
                  {rating}
                </span>
              )}
            </div>
            {/* Decorative hover affordances. The whole card is already a
                keyboard-accessible button (opens Detail); these duplicate that
                action visually for mouse users, so they're aria-hidden rather
                than exposed as separate (and un-nestable) interactive controls. */}
            <div className="media-card-reveal-actions" aria-hidden="true">
              <span className="media-card-play" onClick={handlePlay}>
                <Icon name="play" size={13} />
              </span>
              <span className="media-card-more">
                <Icon name="info" size={13} />
              </span>
            </div>
          </div>
        </div>

        {progress != null && progress > 0 && (
          <div className="media-card-progress" aria-hidden>
            <div
              className="media-card-progress-fill"
              style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
            />
          </div>
        )}
      </div>

      <div className="media-card-title">{title}</div>
      <div className="media-card-meta">
        <span className="media-card-year">{year ?? ""}</span>
        {rating !== "" && (
          <span className="media-card-rating">
            <Icon name="star" size={11} className="t-warning" />
            {rating}
          </span>
        )}
      </div>
    </button>
  );
});
