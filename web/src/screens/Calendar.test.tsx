// @vitest-environment jsdom
//
// Render coverage for the release calendar. Data resolution is tested in
// data/calendar.hook.test.tsx; these tests exercise the month layout, date
// grouping, empty states, navigation, today treatment, and Detail hand-off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview } from "../models/media";
import type { CalendarEntry, CalendarState } from "../data/calendar";

const openDetail = vi.fn();
const navigate = vi.fn();
const openSettingsSection = vi.fn();
const markCalendarSeen = vi.fn();
const refreshCalendar = vi.fn();
let calendarState: CalendarState;

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    calendar: calendarState,
    openDetail,
    navigate,
    openSettingsSection,
    markCalendarSeen,
    refreshCalendar,
  }),
}));

import { Calendar } from "./Calendar";

function localDate(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function preview(
  id: string,
  title: string,
  type: MediaPreview["type"] = "series",
  posterPath: string | null = "/poster.jpg",
): MediaPreview {
  return { id, type, title, posterPath };
}

function entry(
  media: MediaPreview,
  date: string,
  kind: CalendarEntry["kind"] = "episode",
  detail = "S02E07 · Cold Harbor",
): CalendarEntry {
  return {
    id: `${kind}:${media.id}:${date}`,
    date,
    media,
    kind,
    detail,
    ...(kind === "movie" ? { source: "upcoming" as const } : {}),
  };
}

function baseState(over: Partial<CalendarState> = {}): CalendarState {
  return {
    entries: [],
    episodes: [],
    groups: [],
    loading: false,
    error: null,
    hasSeries: true,
    hasTMDB: true,
    ...over,
  };
}

// The fixtures are built as today+N, and the compact month view only renders
// the current month, so any offset that crossed a month boundary put the entry
// on a page the assertions never look at. That made these tests fail for the
// last few days of every month, on CI and locally alike. Pin the clock to a
// mid-month date so the offsets always stay inside one month.
// shouldAdvanceTime keeps real timers progressing so waitFor and user-event
// still resolve.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  globalThis.localStorage?.clear();
  openDetail.mockClear();
  navigate.mockClear();
  openSettingsSection.mockClear();
  markCalendarSeen.mockClear();
  refreshCalendar.mockClear();
  calendarState = baseState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Calendar states", () => {
  it("consumes the in-app new-episode indicator when the screen is visited", () => {
    render(<Calendar />);
    expect(markCalendarSeen).toHaveBeenCalledTimes(1);
  });

  it("renders a six-week loading calendar while data resolves", () => {
    calendarState = baseState({ loading: true });
    const { container } = render(<Calendar />);
    expect(container.querySelector(".cal-month--loading")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelectorAll(".cal-day--skel")).toHaveLength(42);
  });

  it("renders the error, no-key, no-followed-show, and no-schedule states", () => {
    const { rerender } = render(<Calendar />);
    expect(screen.getByText("Nothing scheduled right now")).toBeInTheDocument();

    calendarState = baseState({ hasSeries: false });
    rerender(<Calendar />);
    expect(screen.getByText("No followed shows yet")).toBeInTheDocument();

    calendarState = baseState({ hasTMDB: false });
    rerender(<Calendar />);
    expect(screen.getByText("Add a TMDB key to see release dates")).toBeInTheDocument();

    calendarState = baseState({ error: "TMDB down" });
    rerender(<Calendar />);
    expect(screen.getByText("Couldn't load the release calendar")).toBeInTheDocument();
    expect(screen.getByText("TMDB down")).toBeInTheDocument();
  });

  it("opens the API key section from the missing TMDB key state", async () => {
    // The server can report the metadata capability before the active profile
    // has a usable key, so the explicit setup error must win over hasTMDB.
    calendarState = baseState({ hasTMDB: true, error: "Configure a TMDB API key." });
    render(<Calendar />);

    await userEvent.click(screen.getByRole("button", { name: "API settings" }));
    expect(openSettingsSection).toHaveBeenCalledWith("keys");
    expect(screen.queryByText("Couldn't load the release calendar")).toBeNull();
  });

  it("offers recovery and API settings when a calendar request fails", async () => {
    calendarState = baseState({ error: "TMDB down" });
    render(<Calendar />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refreshCalendar).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "API settings" }));
    expect(openSettingsSection).toHaveBeenCalledWith("keys");
  });

  it("links the no-followed-shows state back to Discover", async () => {
    calendarState = baseState({ hasSeries: false });
    render(<Calendar />);

    await userEvent.click(screen.getByRole("button", { name: "Browse shows" }));
    expect(navigate).toHaveBeenCalledWith("discover");
  });
});

describe("Calendar cadence", () => {
  it("starts new phone sessions in the more readable agenda view", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    calendarState = baseState({
      entries: [entry(preview("phone-show", "Severance"), localDate(2))],
    });

    render(<Calendar />);

    expect(screen.getByRole("radio", { name: "Agenda" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("heading", { name: /agenda$/i })).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("places mocked followed-show and TMDB movie entries on one date and groups them in the agenda", async () => {
    const show = preview("show-1", "Severance");
    const movie = preview("movie-1", "The Running Man", "movie");
    const date = localDate(2);
    calendarState = baseState({
      entries: [
        entry(show, date),
        entry(movie, date, "movie", "Movie release · Upcoming"),
      ],
    });
    render(<Calendar />);

    const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    await userEvent.click(screen.getByRole("gridcell", { name: `${dayLabel}, 2 releases` }));
    const dayPanel = screen.getByRole("heading", { name: dayLabel }).closest("aside");
    expect(dayPanel).not.toBeNull();
    expect(within(dayPanel as HTMLElement).getByText("Severance")).toBeInTheDocument();
    expect(within(dayPanel as HTMLElement).getByText("The Running Man")).toBeInTheDocument();
    expect(screen.getAllByText("Movie release").length).toBeGreaterThan(0);

    const openButtons = screen.getAllByTitle("Open Severance");
    await userEvent.click(openButtons[0]!);
    expect(openDetail).toHaveBeenCalledWith(show);
    expect(within(screen.getByTitle("Open Severance")).getByRole("img", {
      name: "Severance",
    })).toHaveAttribute("src", "https://image.tmdb.org/t/p/w342/poster.jpg");
  });

  it("keeps the month compact and shows artwork in the selected-day panel", async () => {
    const date = localDate(2);
    calendarState = baseState({
      entries: [
        entry(preview("with-art", "Severance"), date),
        entry(preview("no-art", "Andor", "series", null), date),
      ],
    });
    render(<Calendar />);

    const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });
    await userEvent.click(screen.getByRole("gridcell", { name: `${dayLabel}, 2 releases` }));
    const art = within(screen.getByTitle("Open Severance")).getByRole("img", { name: "Severance" });
    expect(art).toHaveAttribute("src", "https://image.tmdb.org/t/p/w342/poster.jpg");
    expect(screen.getByTitle("Open Andor").querySelector(".cal-release-poster-ph")).not.toBeNull();
  });

  it("marks today's day and labels the agenda group as Today", () => {
    const show = preview("show-today", "Andor", "series", null);
    calendarState = baseState({ entries: [entry(show, localDate())] });
    const { container } = render(<Calendar />);
    expect(screen.getByRole("gridcell", { name: /today/ })).toHaveClass("is-today");
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
    expect(container.querySelector(".cal-release-poster-ph")).toBeInTheDocument();
  });

  it("uses one roving calendar tab stop and supports arrow-key day navigation", async () => {
    calendarState = baseState({
      entries: [entry(preview("keyboard-show", "Andor"), localDate())],
    });
    const user = userEvent.setup();
    render(<Calendar />);

    const todayCell = screen.getByRole("gridcell", { name: /today/ });
    expect(todayCell).toHaveAttribute("tabindex", "0");
    expect(todayCell).toHaveAttribute("aria-current", "date");
    expect(screen.getAllByRole("gridcell", { hidden: true }).filter((cell) => cell.tabIndex === 0)).toHaveLength(1);

    todayCell.focus();
    await user.keyboard("{ArrowRight}");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowLabel = tomorrow.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const nextCell = screen.getByRole("gridcell", {
      name: `${tomorrowLabel}, 0 releases`,
    });
    expect(nextCell).toHaveFocus();
    expect(nextCell).toHaveAttribute("tabindex", "0");
    expect(todayCell).toHaveAttribute("tabindex", "-1");
  });

  it("navigates backward and forward between months", async () => {
    calendarState = baseState({ entries: [entry(preview("show-2", "Foundation"), localDate())] });
    render(<Calendar />);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(
      undefined,
      { month: "long", year: "numeric" },
    );
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString(
      undefined,
      { month: "long", year: "numeric" },
    );

    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: next })).toBeInTheDocument();
    expect(screen.getByText("Nothing scheduled")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: previous })).toBeInTheDocument();
  });
});
