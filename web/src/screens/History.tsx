// History screen - backed by the storage port.
//
// Shows a "Continue Watching" rail (incomplete titles with a real resume
// position, read from watch history) followed by the full recently-watched grid
// (recorded whenever a Detail opens or playback records progress). Selecting a
// card re-opens Detail. Persistence is the durable Store (IndexedDB via Dexie),
// so resume positions survive reloads.

import { useAppStore } from "../store/AppStore";
import { MediaCard } from "../components/MediaCard";
import { VirtualMediaGrid } from "../components/MediaGrid";
import { Rail } from "../components/Rail";
import { EmptyState } from "../components/EmptyState";
import { WatchStatsCard } from "../components/WatchStatsCard";
import { latestResumeByMedia, watchProgressMap } from "../storage/models";
import { episodeLabel, parseEpisodeId } from "../data/episodes";
import { useWatchStats } from "../data/useWatchStats";
import { hasWatchStats } from "../data/watchStats";
import { useWatchedIds } from "../data/useWatchedIds";
import "../components/MediaGrid.css";

export function History() {
  const { history, continueWatching, openDetail, openBrowse, navigate, settings } =
    useAppStore();

  // Opt-in insights card (off by default). Keyed on the history + continue-
  // watching identities (not just length) so it re-aggregates after progress
  // changes to an already-recorded title, not only when a new row appears.
  const stats = useWatchStats(settings.showWatchStats, [
    history,
    continueWatching,
  ]);

  // ONE card per show in the rail - the newest incomplete episode/movie record
  // wins (per-episode records used to produce duplicate cards + duplicate React
  // keys for the same series). Newest-first ordering.
  const latestRecords = Object.values(latestResumeByMedia(continueWatching)).sort(
    (a, b) => b.lastWatched.localeCompare(a.lastWatched),
  );
  const resumable = latestRecords.map((r) => r.preview);
  // "S2 E5" corner labels for series cards (movies have no episodeId → no label).
  const resumableLabels: Record<string, string> = {};
  for (const r of latestRecords) {
    const parsed = parseEpisodeId(r.episodeId);
    if (parsed != null) {
      resumableLabels[r.preview.id] = episodeLabel(parsed.season, parsed.episode);
    }
  }
  // Shared progress map (same helper the Watchlist uses) so the rail, the rail's
  // bars, and the full grid below stay in lockstep instead of diverging.
  const resumableProgress = watchProgressMap(continueWatching);
  // Finished-title check badges on the grid. One batched history lookup (the
  // resume list excludes completed rows, so watched titles are read separately).
  const watchedIds = useWatchedIds(continueWatching);

  return (
    <div className="lib-screen">
      <h1 className="lib-h1">History</h1>
      <p className="lib-sub t-secondary">Titles you've recently opened.</p>

      {settings.showWatchStats && stats != null && hasWatchStats(stats) && (
        <WatchStatsCard stats={stats} />
      )}

      {resumable.length > 0 && (
        <Rail
          title="Continue Watching"
          items={resumable}
          progressById={resumableProgress}
          labelById={resumableLabels}
          onSelect={openDetail}
          showPosterRatings={settings?.showPosterRatings ?? false}
        />
      )}

      {history.length === 0 ? (
        <EmptyState
          icon="history"
          title="Nothing here yet"
          subtitle="Open a title and it'll show up here so you can jump back in."
          note="Pick up where you left off"
          actions={
            <>
              <button
                type="button"
                className="btn btn-prominent"
                onClick={() =>
                  openBrowse({ kind: "category", type: "movie", category: "trending" })
                }
              >
                Browse trending
              </button>
              <button type="button" className="btn" onClick={() => navigate("search")}>
                Search catalog
              </button>
            </>
          }
        />
      ) : (
        <VirtualMediaGrid
          items={history}
          renderItem={(item) => (
            <MediaCard
              item={item}
              onSelect={openDetail}
              progress={resumableProgress[item.id]}
              watched={watchedIds.has(item.id)}
              showPosterRatings={settings?.showPosterRatings ?? false}
            />
          )}
        />
      )}
    </div>
  );
}
