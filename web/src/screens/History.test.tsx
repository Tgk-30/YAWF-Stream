// @vitest-environment jsdom
//
// Render tests for the History screen. It reads `history` (recently-opened
// previews) and `continueWatching` (raw WatchHistoryRecords) from the store. The
// rail surfaces only records with a meaningful resume point (hasResumePoint),
// with a per-id progress fraction; the grid shows the full history, or an
// empty-state with Browse / Search CTAs when there's nothing.
//
// The store is mocked for the data + nav callbacks; MediaGrid / Rail are stubbed
// so we assert on the item lists (and the rail's progress map) without the real
// MediaCard image plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview } from "../models/media";
import type { WatchHistoryRecord } from "../storage/models";
import type { WatchStats } from "../data/watchStats";

// --- mutable mock state -----------------------------------------------------

const openDetail = vi.fn();
const openBrowse = vi.fn();
const navigate = vi.fn();
let mockHistory: MediaPreview[] = [];
let mockContinueWatching: WatchHistoryRecord[] = [];
let mockSettings: { showWatchStats: boolean } = { showWatchStats: false };
let mockStats: WatchStats | null = null;

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    history: mockHistory,
    continueWatching: mockContinueWatching,
    settings: mockSettings,
    openDetail,
    openBrowse,
    navigate,
  }),
}));

// The stats hook reads the durable Store directly; stub it so the screen test
// stays store-free and we control the snapshot.
vi.mock("../data/useWatchStats", () => ({
  useWatchStats: () => mockStats,
}));

// The grid is now inlined with MediaCard directly (so it can carry the watched
// badge); stub the card to assert on the item lists + the progress/watched props.
vi.mock("../components/MediaCard", () => ({
  MediaCard: (props: {
    item: MediaPreview;
    onSelect?: (i: MediaPreview) => void;
    progress?: number;
    watched?: boolean;
  }) => (
    <button
      type="button"
      data-progress={props.progress ?? ""}
      data-watched={props.watched ? "yes" : "no"}
      onClick={() => props.onSelect?.(props.item)}
    >
      card:{props.item.title}
    </button>
  ),
}));

let mockWatchedIds = new Set<string>();
vi.mock("../data/useWatchedIds", () => ({
  useWatchedIds: () => mockWatchedIds,
}));

vi.mock("../components/Rail", () => ({
  Rail: (props: {
    title: string;
    items: MediaPreview[];
    progressById?: Record<string | number, number>;
    labelById?: Record<string, string>;
    onSelect?: (i: MediaPreview) => void;
  }) => (
    <div data-testid="rail">
      <span data-testid="rail-title">{props.title}</span>
      {props.items.map((i) => (
        <button
          key={i.id}
          type="button"
          data-progress={props.progressById?.[i.id]}
          data-label={props.labelById?.[i.id]}
          onClick={() => props.onSelect?.(i)}
        >
          rail:{i.title}
        </button>
      ))}
    </div>
  ),
}));

import { History } from "./History";

// --- helpers ----------------------------------------------------------------

function preview(id: string, title: string): MediaPreview {
  return { id, type: "movie", title };
}

function record(
  id: string,
  title: string,
  progressSeconds: number,
  durationSeconds: number | null,
  episodeId: string | null = null,
): WatchHistoryRecord {
  return {
    id,
    mediaId: id,
    episodeId,
    progressSeconds,
    durationSeconds,
    completed: false,
    lastWatched: "2026-06-01T00:00:00Z",
    streamQuality: null,
    preview: preview(id, title),
  };
}

beforeEach(() => {
  openDetail.mockClear();
  openBrowse.mockClear();
  navigate.mockClear();
  mockHistory = [];
  mockContinueWatching = [];
  mockSettings = { showWatchStats: false };
  mockStats = null;
  mockWatchedIds = new Set<string>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function statsFixture(over: Partial<WatchStats> = {}): WatchStats {
  return {
    totalSeconds: 3600,
    titles: 3,
    completed: 2,
    completionRate: 2 / 3,
    streakDays: 2,
    streakOngoing: true,
    activeDays: 2,
    favoriteGenres: [{ genre: "Action", count: 2 }],
    ...over,
  };
}

describe("History - watch stats card", () => {
  it("is hidden when the setting is off", () => {
    mockSettings = { showWatchStats: false };
    mockStats = statsFixture();
    mockHistory = [preview("m1", "Tenet")];
    render(<History />);
    expect(screen.queryByText("Your watching")).not.toBeInTheDocument();
  });

  it("renders when enabled and there is history", () => {
    mockSettings = { showWatchStats: true };
    mockStats = statsFixture();
    mockHistory = [preview("m1", "Tenet")];
    render(<History />);
    expect(screen.getByText("Your watching")).toBeInTheDocument();
  });

  it("stays hidden when enabled but there is no watch data yet", () => {
    mockSettings = { showWatchStats: true };
    mockStats = statsFixture({ titles: 0 }); // hasWatchStats -> false
    render(<History />);
    expect(screen.queryByText("Your watching")).not.toBeInTheDocument();
  });
});

describe("History - empty", () => {
  it("uses a storage-neutral empty-state note for Local and Server Mode", () => {
    render(<History />);
    expect(screen.getByText("Pick up where you left off")).toBeInTheDocument();
    expect(screen.queryByText("Resume positions stay local")).not.toBeInTheDocument();
  });

  it("renders the empty-state with Browse + Search CTAs when nothing watched", async () => {
    render(<History />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByTestId("media-grid")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rail")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /browse trending/i }));
    expect(openBrowse).toHaveBeenCalledWith({
      kind: "category",
      type: "movie",
      category: "trending",
    });

    await userEvent.click(screen.getByRole("button", { name: /search catalog/i }));
    expect(navigate).toHaveBeenCalledWith("search");
  });
});

describe("History - grid", () => {
  it("renders the history grid and opens detail on select", async () => {
    mockHistory = [preview("m1", "Heat"), preview("m2", "Drive")];
    render(<History />);
    expect(screen.getByText("card:Heat")).toBeInTheDocument();
    expect(screen.getByText("card:Drive")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();

    await userEvent.click(screen.getByText("card:Drive"));
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m2" }),
    );
  });

  it("flags finished titles with the watched badge from the history lookup", () => {
    mockHistory = [preview("m1", "Heat"), preview("m2", "Drive")];
    mockWatchedIds = new Set<string>(["m1"]);
    render(<History />);
    expect(screen.getByText("card:Heat")).toHaveAttribute("data-watched", "yes");
    expect(screen.getByText("card:Drive")).toHaveAttribute("data-watched", "no");
  });
});

describe("History - Continue Watching rail", () => {
  it("surfaces only records with a resume point and passes their progress fraction", async () => {
    mockHistory = [preview("m1", "Heat")];
    mockContinueWatching = [
      record("m1", "Heat", 1800, 3600), // 50% - resumable
      record("m2", "Tooearly", 10, 3600), // ~0.3% - below floor, dropped
      record("m3", "Almostdone", 3500, 3600), // ~97% - above ceiling, dropped
    ];
    render(<History />);

    const rail = screen.getByTestId("rail");
    expect(screen.getByTestId("rail-title")).toHaveTextContent(
      "Continue Watching",
    );
    expect(screen.getByText("rail:Heat")).toBeInTheDocument();
    expect(screen.queryByText("rail:Tooearly")).not.toBeInTheDocument();
    expect(screen.queryByText("rail:Almostdone")).not.toBeInTheDocument();

    const resumeBtn = screen.getByText("rail:Heat");
    expect(resumeBtn).toHaveAttribute("data-progress", "0.5");

    await userEvent.click(resumeBtn);
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1" }),
    );
    // The rail lives alongside the grid.
    expect(rail).toBeInTheDocument();
  });

  it("hides the rail when no record has a resume point", () => {
    mockHistory = [preview("m1", "Heat")];
    mockContinueWatching = [record("m1", "Heat", 3600, 3600)]; // 100% complete
    render(<History />);
    expect(screen.queryByTestId("rail")).not.toBeInTheDocument();
    expect(screen.getByText("card:Heat")).toBeInTheDocument();
  });

  it("passes episode labels for resumable series entries", () => {
    mockHistory = [preview("m1", "Heat")];
    mockContinueWatching = [
      record("m1", "Heat", 1800, 3600, "s2e5"),
      record("m2", "Later", 10, 3600, "s1e1"),
    ];
    render(<History />);

    const resumeBtn = screen.getByText("rail:Heat");
    expect(screen.getByTestId("rail-title")).toHaveTextContent(
      "Continue Watching",
    );
    expect(resumeBtn).toHaveAttribute("data-label", "S2 E5");
    expect(resumeBtn).toHaveAttribute("data-progress", "0.5");
  });

  it("sorts resumable rows by most recently watched", () => {
    mockHistory = [preview("m1", "Heat"), preview("m2", "Drive")];
    mockContinueWatching = [
      {
        id: "old",
        mediaId: "m2",
        episodeId: null,
        progressSeconds: 60,
        durationSeconds: 600,
        completed: false,
        lastWatched: "2026-01-01T00:00:00Z",
        streamQuality: null,
        preview: preview("m2", "Drive"),
      },
      {
        id: "new",
        mediaId: "m1",
        episodeId: null,
        progressSeconds: 100,
        durationSeconds: 800,
        completed: false,
        lastWatched: "2026-12-01T00:00:00Z",
        streamQuality: null,
        preview: preview("m1", "Heat"),
      },
    ];
    render(<History />);

    const railButtons = screen.getAllByRole("button").filter((button) =>
      button.textContent?.startsWith("rail:"),
    );
    expect(railButtons[0]).toHaveTextContent("rail:Heat");
    expect(railButtons[1]).toHaveTextContent("rail:Drive");
  });
});
