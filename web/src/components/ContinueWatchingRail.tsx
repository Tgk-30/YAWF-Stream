// Continue Watching - a rail of wide 16:9 banner cards (backdrop + centered play
// button) that jump straight back into a title at its saved episode + timestamp.
// Clicking a card opens the title primed to resume (Detail auto-selects the
// resume episode and the player seeks to the saved position on play).

import { MediaPreview } from "../models/media";
import type { WatchHistoryRecord } from "../storage/models";
import { watchProgressPercent } from "../storage/models";
import { parseEpisodeId, episodeLabel } from "../data/episodes";
import { Icon } from "./Icon";
import "./ContinueWatchingRail.css";

interface Props {
  records: WatchHistoryRecord[];
  onResume: (item: MediaPreview) => void;
}

/** "12m left" / "1h 04m left" from elapsed + total seconds. */
function remainingLabel(
  progressSeconds: number,
  durationSeconds: number | null | undefined,
): string | null {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  const elapsed = Number.isFinite(progressSeconds) ? Math.max(0, progressSeconds) : 0;
  const left = Math.max(0, Math.round((durationSeconds - elapsed) / 60));
  if (left <= 0) return null;
  if (left < 60) return `${left}m left`;
  const h = Math.floor(left / 60);
  const m = left % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m left`;
}

export function ContinueWatchingRail({ records, onResume }: Props) {
  if (records.length === 0) return null;
  const shown = records.slice(0, 8);

  return (
    <section className="cw-rail" aria-label="Continue Watching">
      <h2 className="cw-rail-title">Continue Watching</h2>
      <div className="cw-track">
        {shown.map((r) => {
          const p = watchProgressPercent(r);
          const ep = parseEpisodeId(r.episodeId);
          const img =
            MediaPreview.backdropThumbnailURL(r.preview) ?? MediaPreview.posterURL(r.preview);
          const remaining = r.queuedNext
            ? null
            : remainingLabel(r.progressSeconds, r.durationSeconds);
          const action = r.queuedNext ? "Next" : "Continue";
          return (
            <button
              key={r.id}
              type="button"
              className="cw-card"
              onClick={() => onResume(r.preview)}
              aria-label={`${action} ${r.preview.title}${
                ep ? ` ${episodeLabel(ep.season, ep.episode)}` : ""
              }`}
            >
              {img ? (
                <img className="cw-card-img" src={img} alt="" loading="lazy" />
              ) : (
                <div className="cw-card-img cw-card-img-fallback" aria-hidden />
              )}
              <div className="cw-card-scrim" aria-hidden />
              <span className="cw-card-play" aria-hidden>
                <Icon name="play" size={22} />
              </span>
              <div className="cw-card-meta">
                <span className="cw-card-name">{r.preview.title}</span>
                <span className="cw-card-sub">
                  <span className="cw-card-action">{action}</span>
                  {ep && (
                    <span className="cw-card-ep">
                      {episodeLabel(ep.season, ep.episode)}
                    </span>
                  )}
                  {remaining && <span className="cw-card-left">{remaining}</span>}
                </span>
              </div>
              {!r.queuedNext && (
                <div className="cw-card-progress" aria-hidden>
                  <div
                    className="cw-card-progress-fill"
                    style={{ width: `${Math.round(p * 100)}%` }}
                  />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
