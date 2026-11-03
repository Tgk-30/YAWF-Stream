// @vitest-environment jsdom
//
// EpisodePicker behavior: rich mode (season chips + episode rows + selection +
// resume bars), the season-switch refetch, the loading skeleton, and the
// degraded stepper (no episode guide) with its min-clamp + onSelect payloads.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../data/episodes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/episodes")>();
  return {
    ...actual,
    useSeasons: (...args: unknown[]) => mockUseSeasons(...args),
    useEpisodes: (...args: unknown[]) => mockUseEpisodes(...args),
  };
});

const mockUseSeasons = vi.fn();
const mockUseEpisodes = vi.fn();

import { EpisodePicker } from "./EpisodePicker";
import type { Episode, Season } from "../models/media";

function season(n: number, over: Partial<Season> = {}): Season {
  return { id: n, seasonNumber: n, name: `Season ${n}`, episodeCount: 8, ...over };
}
function episode(s: number, e: number, over: Partial<Episode> = {}): Episode {
  return {
    id: `42-s${s}e${e}`,
    mediaId: "tmdb-42",
    seasonNumber: s,
    episodeNumber: e,
    title: `Ep ${e}`,
    overview: null,
    airDate: null,
    stillPath: null,
    runtime: 45,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  mockUseSeasons.mockReset();
  mockUseEpisodes.mockReset();
});

function renderPicker(over: Partial<Parameters<typeof EpisodePicker>[0]> = {}) {
  const props = {
    tmdbId: 42,
    tmdb: null,
    selected: { season: 1, episode: 1 },
    onSelect: vi.fn(),
    ...over,
  };
  render(<EpisodePicker {...props} />);
  return props;
}

describe("EpisodePicker - rich mode", () => {
  it("renders season chips + episode rows and marks the selection", () => {
    mockUseSeasons.mockReturnValue({
      seasons: [season(1), season(2)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1), episode(1, 2)],
      loading: false,
      source: "live",
    });
    renderPicker({ progressByEpisodeId: { s1e2: 0.5 } });

    expect(screen.getByRole("button", { name: "Season 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const rows = screen.getAllByRole("button", { name: /Ep \d/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain("is-selected");
    expect(rows[1].className).not.toContain("is-selected");
    // resume bar renders only on the episode that has progress
    expect(within(rows[1]).getByText("Ep 2")).toBeInTheDocument();
    expect(rows[1].querySelector(".episode-progress-fill")).not.toBeNull();
    expect(rows[0].querySelector(".episode-progress-fill")).toBeNull();
  });

  it("selecting an episode reports the season/episode payload", async () => {
    const user = userEvent.setup();
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 3)],
      loading: false,
      source: "live",
    });
    const { onSelect } = renderPicker();
    await user.click(screen.getByRole("button", { name: /Ep 3/ }));
    expect(onSelect).toHaveBeenCalledWith({ season: 1, episode: 3 });
  });

  it("switching seasons refetches that season's episodes without changing the selection", async () => {
    const user = userEvent.setup();
    mockUseSeasons.mockReturnValue({
      seasons: [season(1), season(2)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1)],
      loading: false,
      source: "live",
    });
    const { onSelect } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Season 2" }));
    // Browsing is not selecting: no onSelect, but useEpisodes now asked for S2.
    expect(onSelect).not.toHaveBeenCalled();
    const lastCall = mockUseEpisodes.mock.calls.at(-1)!;
    expect(lastCall[1]).toBe(2);
  });

  it("uses a season dropdown (not chips) when a show has many seasons", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 9 }, (_, i) => season(i + 1));
    mockUseSeasons.mockReturnValue({ seasons: many, loading: false, source: "live" });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1)],
      loading: false,
      source: "live",
    });
    renderPicker();
    // No chip buttons past the threshold - a proper season selector instead.
    expect(screen.queryByRole("button", { name: "Season 2" })).toBeNull();
    const select = screen.getByRole("combobox", { name: "Season" });
    expect(select).toHaveValue("1");
    // Switching it browses that season (refetch) without changing the selection.
    await user.selectOptions(select, "5");
    const lastCall = mockUseEpisodes.mock.calls.at(-1)!;
    expect(lastCall[1]).toBe(5);
  });

  it("keeps season chips for a short run (at or below the threshold)", () => {
    const six = Array.from({ length: 6 }, (_, i) => season(i + 1));
    mockUseSeasons.mockReturnValue({ seasons: six, loading: false, source: "live" });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1)],
      loading: false,
      source: "live",
    });
    renderPicker();
    expect(screen.getByRole("button", { name: "Season 6" })).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Season" }),
    ).toBeNull();
  });

  it("shows a skeleton while seasons load", () => {
    mockUseSeasons.mockReturnValue({ seasons: [], loading: true, source: "none" });
    mockUseEpisodes.mockReturnValue({ episodes: [], loading: false, source: "none" });
    renderPicker();
    expect(document.querySelector(".episode-row-skel")).not.toBeNull();
  });

  it("opens streams from the row while the check toggles the full-row watched state", async () => {
    const user = userEvent.setup();
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1), episode(1, 2)],
      loading: false,
      source: "live",
    });
    const onToggleWatched = vi.fn();
    const { onSelect } = renderPicker({
      watchedEpisodeIds: new Set(["s1e1"]),
      onToggleWatched,
    });

    // The episode row remains the primary stream-opening action.
    await user.click(screen.getByRole("button", { name: /Ep 1/ }));
    expect(onSelect).toHaveBeenCalledWith({ season: 1, episode: 1 });
    expect(onToggleWatched).not.toHaveBeenCalled();

    // The adjacent check owns watched state and the full-row highlight.
    const unmark = screen.getByRole("button", { name: "Mark E1 unwatched" });
    expect(unmark).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".episode-row-item.is-watched")).not.toBeNull();
    await user.click(unmark);
    expect(onToggleWatched).toHaveBeenCalledWith({ season: 1, episode: 1 }, false);

    // E2 is unwatched and its check marks it watched.
    await user.click(screen.getByRole("button", { name: "Mark E2 watched" }));
    expect(onToggleWatched).toHaveBeenCalledWith({ season: 1, episode: 2 }, true);
  });

  it("hides the watched toggle when no handler is provided", () => {
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1)],
      loading: false,
      source: "live",
    });
    renderPicker();
    expect(document.querySelector(".episode-watched-btn")).toBeNull();
  });

  it("shows a skeleton when rich episodes are loading", () => {
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [],
      loading: true,
      source: "live",
    });

    renderPicker();
    const skels = document.querySelectorAll(".episode-row-skel");
    expect(skels.length).toBeGreaterThan(0);
    expect(document.querySelector(".episode-list")).not.toBeNull();
  });

  it("handles invalid air dates by omitting date text", () => {
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [
        episode(1, 1, {
          airDate: "not-a-date",
          runtime: 45,
          title: null,
        }),
      ],
      loading: false,
      source: "live",
    });

    renderPicker({ progressByEpisodeId: {} });
    expect(screen.getByText("45 min")).toBeInTheDocument();
    expect(screen.getByText("Episode 1")).toBeInTheDocument();
  });

  it("renders formatted metadata with a valid air date", () => {
    mockUseSeasons.mockReturnValue({
      seasons: [season(1)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1, { airDate: "2022-03-15", title: "Pilot" })],
      loading: false,
      source: "live",
    });
    renderPicker();

    const expectedDate = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date("2022-03-15T00:00:00Z"));
    expect(screen.getByText(`Pilot`)).toBeInTheDocument();
    expect(screen.getByText("Pilot").closest(".episode-body")?.textContent).toContain(
      expectedDate,
    );
  });
  it("renders calendar-only air dates without changing episode or watched selection", () => {
    mockUseSeasons.mockReturnValue({ seasons: [season(17)], loading: false, source: "live" });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(17, 1, { airDate: "2022-10-09", title: "Synthetic air date", runtime: 24 })],
      loading: false,
      source: "live",
    });
    const onToggleWatched = vi.fn();
    const { onSelect } = renderPicker({ selected: { season: 17, episode: 1 }, onToggleWatched });
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(new Date("2022-10-09T00:00:00Z"));
    const row = screen.getByRole("button", { name: /Synthetic air date/ });
    expect(row).toHaveClass("is-selected");
    expect(row.querySelector(".episode-meta")).toHaveTextContent(`${expectedDate} · 24 min`);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleWatched).not.toHaveBeenCalled();
  });

  it("makes the current season action primary and the entire-series action secondary", async () => {
    const user = userEvent.setup();
    mockUseSeasons.mockReturnValue({
      seasons: [season(1), season(2)],
      loading: false,
      source: "live",
    });
    mockUseEpisodes.mockReturnValue({
      episodes: [episode(1, 1), episode(1, 2)],
      loading: false,
      source: "live",
    });
    const onToggleSeasonWatched = vi.fn();
    const onToggleSeriesWatched = vi.fn();
    renderPicker({ onToggleSeasonWatched, onToggleSeriesWatched });

    const seasonAction = screen.getByRole("button", { name: "Mark season watched" });
    const seriesAction = screen.getByRole("button", {
      name: "Mark entire series watched",
    });
    expect(seasonAction).toHaveClass("episode-rollup-btn");
    expect(seriesAction).toHaveClass("episode-rollup-series-btn");
    expect(screen.getByText("Entire series")).toBeInTheDocument();

    await user.click(seasonAction);
    expect(onToggleSeasonWatched).toHaveBeenCalledWith(
      [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      true,
    );
    await user.click(seriesAction);
    expect(onToggleSeriesWatched).toHaveBeenCalledWith(true);
  });

});

describe("EpisodePicker - degraded stepper", () => {
  function mockNoGuide() {
    mockUseSeasons.mockReturnValue({ seasons: [], loading: false, source: "none" });
    mockUseEpisodes.mockReturnValue({ episodes: [], loading: false, source: "none" });
  }

  it("explains the degraded mode and steps season/episode", async () => {
    const user = userEvent.setup();
    mockNoGuide();
    const { onSelect } = renderPicker({ selected: { season: 2, episode: 5 } });

    expect(
      screen.getByText(
        "Episode guide unavailable - pick the season and episode to search.",
      ),
    ).toBeInTheDocument();

    expect(screen.queryByRole("combobox", { name: "Season" })).toBeNull();
    expect(document.querySelector(".episode-season-select-label")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next episode" }));
    expect(onSelect).toHaveBeenCalledWith({ season: 2, episode: 6 });

    await user.click(screen.getByRole("button", { name: "Next season" }));
    // Changing season resets the episode to 1.
    expect(onSelect).toHaveBeenCalledWith({ season: 3, episode: 1 });
  });

  it("clamps both fields at 1", async () => {
    const user = userEvent.setup();
    mockNoGuide();
    const { onSelect } = renderPicker({ selected: { season: 1, episode: 1 } });
    await user.click(screen.getByRole("button", { name: "Previous season" }));
    expect(onSelect).toHaveBeenCalledWith({ season: 1, episode: 1 });
    await user.click(screen.getByRole("button", { name: "Previous episode" }));
    expect(onSelect).toHaveBeenCalledWith({ season: 1, episode: 1 });
  });
});

describe("EpisodePicker - numbered season dropdown", () => {
  const continuationTitle = "Bleach: Thousand-Year Blood War";

  function mockManySeasons() {
    const many = Array.from({ length: 19 }, (_, i) =>
      season(i + 1, i >= 16 ? { name: continuationTitle, episodeCount: 13 } : {}),
    );
    mockUseSeasons.mockReturnValue({ seasons: many, loading: false, source: "live" });
    mockUseEpisodes.mockImplementation((_id: number, browsed: number) => ({
      episodes: [episode(browsed, 1)], loading: false, source: "live",
    }));
  }

  it("keeps a long continuation season number ahead of the complete native option title", () => {
    mockManySeasons();
    renderPicker({ selected: { season: 17, episode: 1 } });

    const select = screen.getByRole("combobox", { name: "Season" });
    const label = screen.getByText("Season 17", { selector: ".episode-season-select-label" });
    expect(label).toBeVisible();
    expect(label.nextElementSibling).toBe(select);
    expect(select).toHaveValue("17");
    expect(within(select).getAllByRole("option", {
      name: `${continuationTitle} · 13 eps`,
    })).toHaveLength(3);
    expect((select as HTMLSelectElement).selectedOptions[0]).toHaveTextContent(
      `${continuationTitle} · 13 eps`,
    );
  });

  it("shows the browsed continuation number without selecting an episode or changing watched state", async () => {
    const user = userEvent.setup();
    mockManySeasons();
    const onToggleWatched = vi.fn();
    const onToggleSeasonWatched = vi.fn();
    const onToggleSeriesWatched = vi.fn();
    const { onSelect } = renderPicker({
      selected: { season: 2, episode: 7 },
      onToggleWatched,
      onToggleSeasonWatched,
      onToggleSeriesWatched,
    });
    const select = screen.getByRole("combobox", { name: "Season" });
    for (const browsed of [17, 18, 19]) {
      await user.selectOptions(select, String(browsed));
      expect(screen.getByText(`Season ${browsed}`, {
        selector: ".episode-season-select-label",
      })).toBeVisible();
      expect(select).toHaveValue(String(browsed));
      expect(mockUseEpisodes).toHaveBeenLastCalledWith(42, browsed, null, null);
      expect(onSelect).not.toHaveBeenCalled();
      expect(onToggleWatched).not.toHaveBeenCalled();
      expect(onToggleSeasonWatched).not.toHaveBeenCalled();
      expect(onToggleSeriesWatched).not.toHaveBeenCalled();
    }
  });

  it("keeps the visible number separate from ordinary and fallback season names", () => {
    const many = Array.from({ length: 7 }, (_, i) => season(i + 1));
    many[2] = season(3, { name: "The Beginning" });
    many[3] = season(4, { name: "" });
    mockUseSeasons.mockReturnValue({ seasons: many, loading: false, source: "live" });
    mockUseEpisodes.mockReturnValue({ episodes: [], loading: false, source: "live" });
    renderPicker({ selected: { season: 3, episode: 1 } });

    expect(screen.getByText("Season 3", { selector: ".episode-season-select-label" })).toBeVisible();
    const select = screen.getByRole("combobox", { name: "Season" });
    expect(within(select).getByRole("option", { name: "The Beginning · 8 eps" })).toHaveValue("3");
    expect(within(select).getByRole("option", { name: "Season 4 · 8 eps" })).toHaveValue("4");
  });

  it("reserves the number while allowing the native title to shrink inside constrained headers", () => {
    const css = readFileSync("src/components/EpisodePicker.css", "utf8");
    const wrapper = css.match(/\.episode-season-select\s*\{([^}]*)\}/)?.[1];
    const label = css.match(/\.episode-season-select-label\s*\{([^}]*)\}/)?.[1];
    const input = css.match(/\.episode-season-select-input\s*\{([^}]*)\}/)?.[1];
    expect(wrapper).toMatch(/box-sizing:\s*border-box/);
    expect(wrapper).toMatch(/min-width:\s*0/);
    expect(wrapper).toMatch(/max-width:\s*100%/);
    expect(label).toMatch(/flex:\s*0 0 auto/);
    expect(label).toMatch(/white-space:\s*nowrap/);
    expect(input).toMatch(/flex:\s*1 1 auto/);
    expect(input).toMatch(/min-width:\s*0/);
    expect(input).toMatch(/overflow:\s*hidden/);
    expect(input).toMatch(/text-overflow:\s*ellipsis/);
  });
});
