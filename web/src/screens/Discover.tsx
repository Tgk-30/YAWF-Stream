// Discover screen - mirrors Sources/.../Views/Catalog/DiscoverView.swift.
//
// Layout (top → bottom): cinematic HeroSpotlight (first trending item with a
// backdrop) → Continue Watching banner rail → horizontal poster Rails (Top 10
// Movies/TV, Popular, Top Rated, Now Playing, Upcoming). Data comes from the
// useDiscover() hook (live with a key, fixtures otherwise). "Describe a vibe"
// now lives on the Search screen.

import type { MediaPreview } from "../models/media";
import { useDiscover } from "../data/discover";
import { useAppStore } from "../store/AppStore";
import { hasResumePoint } from "../storage/models";
import { type BrowseContext } from "../data/browse";
import { HeroSpotlight } from "../components/HeroSpotlight";
import { ContinueWatchingRail } from "../components/ContinueWatchingRail";
import { Rail } from "../components/Rail";
import { useAttentionParked } from "../lib/attention";
import "./Discover.css";

interface DiscoverProps {
  onSelect?: (item: MediaPreview) => void;
}

export function Discover({ onSelect }: DiscoverProps) {
  const {
    services,
    navigate,
    openBrowse,
    openDetail,
    continueWatching,
    detailItem,
    browseContext,
    settings,
  } = useAppStore();
  const attentionParked = useAttentionParked();
  const { data, loading, railsLoading, error, source } = useDiscover(services.tmdb);

  // Continue Watching surfaces real resume points and explicit queued-next
  // handoffs. Ordinary zero-progress viewed rows remain excluded.
  const resumable = continueWatching.filter(
    (row) => row.queuedNext || hasResumePoint(row),
  );

  // "See all" → open the full paginated Browse for a rail's exact category.
  const seeAll = (ctx: BrowseContext) => () => openBrowse(ctx);
  const heroKey = data?.hero == null ? null : `${data.hero.type}:${data.hero.id}`;
  const withoutHero = (items: MediaPreview[]) =>
    heroKey == null ? items : items.filter((item) => `${item.type}:${item.id}` !== heroKey);

  if (loading || !data) {
    return <DiscoverSkeleton />;
  }

  // A category rail: its data may still be streaming in (progressive load), so
  // show a titled skeleton row in its place until it settles, then the real rail
  // (or nothing, if it resolved empty).
  const categoryRail = (
    title: string,
    items: MediaPreview[],
    ctx: BrowseContext,
  ) => {
    const rows = withoutHero(items);
    if (rows.length > 0) {
      return (
        <Rail
          title={title}
          items={rows}
          onSelect={onSelect}
          onSeeAll={seeAll(ctx)}
          showPosterRatings={settings?.showPosterRatings ?? false}
        />
      );
    }
    return railsLoading ? <RailSkeleton title={title} /> : null;
  };

  return (
    <div className="discover">
      {/* The hero lives OUTSIDE the capped content column so it can truly span
          the window. Inside the column, its full-bleed negative margins could
          never escape the 1440px cap - on wide windows the hero (and rails)
          stopped short and the raw theme background filled the right side as a
          hard seam (the "background color on the right" bug). */}
      {data.hero && (
        <HeroSpotlight
          items={[data.hero, ...data.trendingMovies, ...data.trendingTV]
            .filter(
              (it, i, arr) =>
                it.backdropPath != null &&
                // Keep the first BACKDROP-having occurrence of each title. Key on
                // type+id (a movie and a TV show can share a numeric TMDB id) and
                // on backdrop presence, so a backdrop-less duplicate appearing
                // earlier doesn't drop the backdrop version.
                arr.findIndex(
                  (x) =>
                    x.type === it.type &&
                    x.id === it.id &&
                    x.backdropPath != null,
                ) === i
            )
            .slice(0, 5)}
          onPlay={onSelect}
          onDetails={onSelect}
          suspended={detailItem != null || browseContext != null || attentionParked}
        />
      )}

      <div className="discover-body">
      {source === "fixtures" && (
        <section className="discover-catalog-notice glass-rest" role="status">
          <div>
            <strong>Sample catalog</strong>
            <p>
              {error
                ? `The live catalog could not be loaded: ${error} Showing bundled sample titles instead.`
                : "No catalog key is configured. These are bundled sample titles, not live trending results."}
            </p>
          </div>
          <button type="button" className="btn" onClick={() => navigate("settings")}>
            Open metadata settings
          </button>
        </section>
      )}
      {source === "offline" && (
        <section className="discover-catalog-notice glass-rest" role="status">
          <div>
            <strong>Offline catalog</strong>
            <p>{error ?? "Live discovery is unavailable while Offline mode is active."}</p>
          </div>
          <button type="button" className="btn" onClick={() => navigate("downloads")}>
            Open Downloads
          </button>
        </section>
      )}
      {resumable.length > 0 && (
        <ContinueWatchingRail records={resumable} onResume={openDetail} />
      )}

      <Rail
        title="Top 10 Movies"
        items={data.trendingMovies}
        ranked
        onSelect={onSelect}
        onSeeAll={seeAll({ kind: "category", type: "movie", category: "trending" })}
        showPosterRatings={settings?.showPosterRatings ?? false}
      />
      <Rail
        title="Top 10 TV Shows"
        items={data.trendingTV}
        ranked
        onSelect={onSelect}
        onSeeAll={seeAll({ kind: "category", type: "series", category: "trending" })}
        showPosterRatings={settings?.showPosterRatings ?? false}
      />
      {categoryRail("Popular Movies", data.popularMovies, {
        kind: "category",
        type: "movie",
        category: "popular",
      })}
      {categoryRail("Top Rated Movies", data.topRatedMovies, {
        kind: "category",
        type: "movie",
        category: "top_rated",
      })}
      {categoryRail("Now Playing", data.nowPlayingMovies, {
        kind: "category",
        type: "movie",
        category: "now_playing",
      })}
      {categoryRail("Upcoming", data.upcomingMovies, {
        kind: "category",
        type: "movie",
        category: "upcoming",
      })}
      </div>
    </div>
  );
}

/** A single titled skeleton rail - placeholder for a category still streaming in
 * during the progressive load, so the row's spot is held (no pop-in shift). */
function RailSkeleton({ title }: { title: string }) {
  return (
    <section className="rail" aria-hidden>
      <div className="rail-header">
        <h2 className="rail-title">{title}</h2>
      </div>
      <div className="skel-cards">
        {[0, 1, 2, 3, 4, 5].map((c) => (
          <div className="skel-card" key={c} />
        ))}
      </div>
    </section>
  );
}

/** Cold-start skeleton (mirrors DiscoverView.skeletonView): a hero block then a
 * few redacted rails. Purely cosmetic while the first load resolves. */
function DiscoverSkeleton() {
  return (
    <div className="discover">
      <div className="discover-body">
        <div className="skel-hero" />
        {[0, 1, 2].map((r) => (
          <div className="skel-rail" key={r}>
            <div className="skel-title" />
            <div className="skel-cards">
              {[0, 1, 2, 3, 4, 5].map((c) => (
                <div className="skel-card" key={c} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
