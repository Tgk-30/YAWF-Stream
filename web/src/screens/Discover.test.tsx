// @vitest-environment jsdom
//
// Render/interaction tests for the Discover screen. The screen is dependency-
// heavy, so the data hook (useDiscover), the app store, serverMode, and the
// serverApi curate call are mocked, and the child surfaces (HeroSpotlight,
// MoodStrip, Rail) are replaced with lightweight test doubles that expose their
// props/callbacks as DOM. The pure storage/models helpers are used as-is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview } from "../models/media";
import type { WatchHistoryRecord } from "../storage/models";
import type { DiscoverData } from "../data/discover";

// --- mutable mock state -----------------------------------------------------

let mockDiscover: {
  data: DiscoverData | null;
  loading: boolean;
  railsLoading?: boolean;
  error?: string | null;
  source?: "live" | "fixtures" | "offline" | null;
} = {
  data: null,
  loading: true,
};

const openBrowse = vi.fn();
const openDetail = vi.fn();
const navigate = vi.fn();
let mockContinueWatching: WatchHistoryRecord[] = [];
let mockServices: {
  tmdb: unknown;
  ai: { recommend: ReturnType<typeof vi.fn> } | null;
} = { tmdb: null, ai: null };

vi.mock("../data/discover", () => ({
  // Default railsLoading to false (the settled state) so tests that don't set it
  // match the real non-optional field rather than leaving it undefined.
  useDiscover: () => ({ railsLoading: false, ...mockDiscover }),
}));

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    services: mockServices,
    openBrowse,
    openDetail,
    navigate,
    continueWatching: mockContinueWatching,
  }),
}));

let serverModeOn = false;
vi.mock("../lib/serverMode", () => ({
  isServerMode: () => serverModeOn,
}));

const curateServerAI = vi.fn();
vi.mock("../lib/serverApi", () => ({
  curateServerAI: (...args: unknown[]) => curateServerAI(...args),
}));

// Child doubles. Each renders its title/props so the parent wiring is testable.
vi.mock("../components/HeroSpotlight", () => ({
  HeroSpotlight: ({ items, onPlay, onDetails }: any) => (
    <div data-testid="hero">
      <span data-testid="hero-count">{items.length}</span>
      <button onClick={() => onPlay?.(items[0])}>hero-play</button>
      <button onClick={() => onDetails?.(items[0])}>hero-details</button>
    </div>
  ),
}));

vi.mock("../components/ContinueWatchingRail", () => ({
  ContinueWatchingRail: ({ records, onResume }: any) => (
    <div data-testid="cw-rail">
      <span data-testid="cw-count">{records.length}</span>
      {records.map((r: any) => (
        <button key={r.id} onClick={() => onResume?.(r.preview)}>
          cw-{r.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../components/Rail", () => ({
  Rail: ({ title, items, onSelect, onSeeAll, progressById }: any) => (
    <div data-testid="rail" data-title={title}>
      <span data-testid="rail-title">{title}</span>
      <span data-testid="rail-count">{items.length}</span>
      <span data-testid="rail-has-seeall">{String(onSeeAll != null)}</span>
      <span data-testid="rail-progress">{JSON.stringify(progressById ?? null)}</span>
      {items.map((it: MediaPreview) => (
        <button key={it.id} onClick={() => onSelect?.(it)}>
          item-{it.id}
        </button>
      ))}
      {onSeeAll && <button onClick={() => onSeeAll()}>seeall-{title}</button>}
    </div>
  ),
}));

import { Discover } from "./Discover";

// --- fixtures ---------------------------------------------------------------

function preview(id: string, over: Partial<MediaPreview> = {}): MediaPreview {
  return { id, type: "movie", title: `Title ${id}`, ...over };
}

function fullData(): DiscoverData {
  return {
    hero: preview("hero1", { backdropPath: "/bd.jpg", type: "movie" }),
    trendingMovies: [
      preview("tm1", { backdropPath: "/a.jpg" }),
      preview("tm2"),
    ],
    trendingTV: [preview("tv1", { type: "series" })],
    popularMovies: [preview("pm1")],
    topRatedMovies: [preview("tr1")],
    nowPlayingMovies: [preview("np1")],
    upcomingMovies: [preview("up1")],
  };
}

function historyRecord(
  id: string,
  progress: number,
  duration: number | null,
): WatchHistoryRecord {
  return {
    id,
    mediaId: id,
    episodeId: null,
    progressSeconds: progress,
    durationSeconds: duration,
    completed: false,
    lastWatched: new Date().toISOString(),
    streamQuality: null,
    preview: preview(id),
  };
}

beforeEach(() => {
  mockDiscover = { data: null, loading: true };
  mockContinueWatching = [];
  mockServices = { tmdb: null, ai: null };
  serverModeOn = false;
  openBrowse.mockReset();
  openDetail.mockReset();
  navigate.mockReset();
  curateServerAI.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Discover skeleton", () => {
  it("renders the cold-start skeleton while loading", () => {
    mockDiscover = { data: null, loading: true };
    const { container } = render(<Discover />);
    expect(container.querySelector(".skel-hero")).not.toBeNull();
    // three redacted rails, six cards each
    expect(container.querySelectorAll(".skel-rail")).toHaveLength(3);
    expect(container.querySelectorAll(".skel-card")).toHaveLength(18);
    expect(screen.queryByTestId("hero")).toBeNull();
  });

  it("renders the skeleton when not loading but data is still null", () => {
    mockDiscover = { data: null, loading: false };
    const { container } = render(<Discover />);
    expect(container.querySelector(".skel-hero")).not.toBeNull();
  });
});

describe("Discover loaded", () => {
  it("labels fixture content and routes to metadata settings", async () => {
    mockDiscover = {
      data: fullData(),
      loading: false,
      source: "fixtures",
      error: "TMDB rejected the configured key.",
    };
    render(<Discover />);

    expect(screen.getByRole("status")).toHaveTextContent("Sample catalog");
    expect(screen.getByRole("status")).toHaveTextContent(
      "TMDB rejected the configured key.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open metadata settings" }),
    );
    expect(navigate).toHaveBeenCalledWith("settings");
  });

  it("shows the honest Offline state with a Downloads recovery action", async () => {
    mockDiscover = {
      data: fullData(),
      loading: false,
      source: "offline",
      error: "Offline mode is active.",
    };
    render(<Discover />);

    expect(screen.getByRole("status")).toHaveTextContent("Offline catalog");
    await userEvent.click(screen.getByRole("button", { name: "Open Downloads" }));
    expect(navigate).toHaveBeenCalledWith("downloads");
  });

  it("renders hero and all rails when data is present", () => {
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    expect(screen.getByTestId("hero")).toBeInTheDocument();

    const titles = screen.getAllByTestId("rail-title").map((n) => n.textContent);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Top 10 Movies",
        "Top 10 TV Shows",
        "Popular Movies",
        "Top Rated Movies",
        "Now Playing",
        "Upcoming",
      ]),
    );
    // "Describe a vibe" moved to Search; no mood rail on Discover.
    expect(titles).not.toContain("Mood picks");
  });

  it("holds a titled skeleton for a category rail still streaming in (progressive)", () => {
    // Trending resolved (hero + Top 10 present) but Popular hasn't yet.
    const data = { ...fullData(), popularMovies: [] };
    mockDiscover = { data, loading: false, railsLoading: true };
    const { container } = render(<Discover />);
    // A skeleton placeholder (titled, with skel cards) holds Popular's row.
    expect(container.querySelectorAll(".skel-card").length).toBeGreaterThan(0);
    // It's a skeleton, not the (mocked) Rail - so no rail-title for Popular yet,
    // while a populated category still renders its real rail.
    const railTitles = screen.getAllByTestId("rail-title").map((n) => n.textContent);
    expect(railTitles).not.toContain("Popular Movies");
    expect(railTitles).toContain("Now Playing");
  });

  it("hides an empty category rail once loading settles (no skeleton)", () => {
    const data = { ...fullData(), popularMovies: [] };
    mockDiscover = { data, loading: false, railsLoading: false };
    const { container } = render(<Discover />);
    expect(container.querySelector(".skel-card")).toBeNull();
    const railTitles = screen.getAllByTestId("rail-title").map((n) => n.textContent);
    expect(railTitles).not.toContain("Popular Movies");
  });

  it("hides the hero when data.hero is null", () => {
    mockDiscover = { data: { ...fullData(), hero: null }, loading: false };
    render(<Discover />);
    expect(screen.queryByTestId("hero")).toBeNull();
  });

  it("keeps a backdrop-having duplicate in the hero even when a backdrop-less twin sorts first", () => {
    // hero1 has no backdrop, but a trending twin (same id) does. Deduping on the
    // first occurrence overall would drop BOTH; the backdrop version must survive.
    const data = fullData();
    data.hero = preview("hero1", { backdropPath: null, type: "movie" });
    data.trendingMovies = [
      preview("hero1", { backdropPath: "/dup.jpg" }),
      preview("tm9", { backdropPath: "/x.jpg" }),
    ];
    mockDiscover = { data, loading: false };
    render(<Discover />);
    // hero1 (with backdrop) + tm9 = 2 spotlight items.
    expect(screen.getByTestId("hero-count").textContent).toBe("2");
  });

  it("keeps a movie and a TV title that share a numeric id (dedupe by type+id)", () => {
    const data = fullData();
    data.hero = preview("hero1", { backdropPath: "/h.jpg", type: "movie" });
    // A TV title with the SAME id as the hero movie - must not be deduped away.
    data.trendingTV = [
      preview("hero1", { backdropPath: "/tv.jpg", type: "series" }),
    ];
    data.trendingMovies = [];
    mockDiscover = { data, loading: false };
    render(<Discover />);
    // Both the movie and the series survive → 2 spotlight items.
    expect(screen.getByTestId("hero-count").textContent).toBe("2");
  });

  it("filters the hero item out of the withoutHero rails (Popular)", () => {
    const data = fullData();
    // hero1 is also injected into a withoutHero rail (Popular) to prove dedupe.
    data.popularMovies = [
      preview("hero1", { backdropPath: "/bd.jpg" }),
      preview("pm2"),
    ];
    mockDiscover = { data, loading: false };
    render(<Discover />);
    const popular = screen
      .getAllByTestId("rail")
      .find((r) => r.getAttribute("data-title") === "Popular Movies")!;
    // hero1 removed, only pm2 left.
    expect(within(popular).queryByText("item-hero1")).toBeNull();
    expect(within(popular).getByText("item-pm2")).toBeInTheDocument();
  });

  it("keeps the true chart (incl. hero) in the ranked Top 10 rail", () => {
    const data = fullData();
    // The hero also tops the trending chart - the Top 10 rail must still show it
    // as #1 (a real chart), unlike the withoutHero rails.
    data.trendingMovies = [
      preview("hero1", { backdropPath: "/bd.jpg" }),
      preview("tm2"),
    ];
    mockDiscover = { data, loading: false };
    render(<Discover />);
    const top10 = screen
      .getAllByTestId("rail")
      .find((r) => r.getAttribute("data-title") === "Top 10 Movies")!;
    expect(within(top10).getByText("item-hero1")).toBeInTheDocument();
    expect(within(top10).getByText("item-tm2")).toBeInTheDocument();
  });

  it("forwards item clicks to onSelect", async () => {
    const onSelect = vi.fn();
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover onSelect={onSelect} />);
    await userEvent.click(screen.getByText("item-pm1"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pm1" }),
    );
  });

  it("wires hero onPlay/onDetails to onSelect", async () => {
    const onSelect = vi.fn();
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover onSelect={onSelect} />);
    await userEvent.click(screen.getByText("hero-play"));
    await userEvent.click(screen.getByText("hero-details"));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});

describe("Discover Continue Watching", () => {
  it("surfaces resumable items in the banner rail", () => {
    // 50% → resumable
    mockContinueWatching = [historyRecord("res1", 50, 100)];
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    const cw = screen.getByTestId("cw-rail");
    expect(within(cw).getByText("cw-res1")).toBeInTheDocument();
    expect(within(cw).getByTestId("cw-count").textContent).toBe("1");
  });

  it("surfaces an explicit queued next row without treating ordinary zero progress as resumable", () => {
    mockContinueWatching = [
      { ...historyRecord("next", 0, 0), episodeId: "s2e1", queuedNext: true },
      historyRecord("viewed", 0, 0),
    ];
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    expect(within(screen.getByTestId("cw-rail")).getByText("cw-next")).toBeInTheDocument();
    expect(screen.queryByText("cw-viewed")).toBeNull();
  });

  it("hides the rail entirely when nothing is resumable (hasResumePoint filter)", () => {
    mockContinueWatching = [
      historyRecord("done", 99, 100), // 99% → excluded
      historyRecord("fresh", 1, 100), // 1% → excluded
    ];
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    // Rail is only rendered when there is something to resume.
    expect(screen.queryByTestId("cw-rail")).toBeNull();
  });

  it("forwards a resume click to onResume (openDetail) with the preview", async () => {
    mockContinueWatching = [historyRecord("res1", 50, 100)];
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    await userEvent.click(screen.getByText("cw-res1"));
    // openDetail is the mocked store callback wired to onResume.
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "res1" }),
    );
  });
});

describe("Discover See all", () => {
  it("opens browse with the category context for a rail", async () => {
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    await userEvent.click(screen.getByText("seeall-Top 10 Movies"));
    expect(openBrowse).toHaveBeenCalledWith({
      kind: "category",
      type: "movie",
      category: "trending",
    });
  });

  it("opens browse for the trending TV rail with type series", async () => {
    mockDiscover = { data: fullData(), loading: false };
    render(<Discover />);
    await userEvent.click(screen.getByText("seeall-Top 10 TV Shows"));
    expect(openBrowse).toHaveBeenCalledWith({
      kind: "category",
      type: "series",
      category: "trending",
    });
  });
});
