// @vitest-environment jsdom
//
// CaptionsMenu: track toggles (aria-pressed), per-track delay, appearance
// controls (persisted via updateSettings), AI translate row, and the gated
// search / no-key states. Driven by a fully-mocked UseSubtitleTracks prop and a
// mocked AppStore slice.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaptionsMenu } from "./CaptionsMenu";
import type { UseSubtitleTracks, SubtitleTrack } from "./useSubtitleTracks";
import type { AppSettings } from "../../data/settings";

// --- Mocked AppStore -------------------------------------------------------
let mockSettings: AppSettings;
const updateSettings = vi.fn();

vi.mock("../../store/AppStore", () => ({
  useAppStore: () => ({ settings: mockSettings, updateSettings }),
}));

function baseSettings(): AppSettings {
  // Only the subtitle-appearance fields are read by CaptionsMenu; the rest can
  // be a loose object cast to AppSettings.
  return {
    subtitleFontScale: 1,
    subtitleTextColor: "#ffffff",
    subtitleBgOpacity: 0.55,
  } as unknown as AppSettings;
}

function makeTrack(over: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return {
    id: "t1",
    label: "EN · Release",
    language: "en",
    cues: [],
    delayMs: 0,
    vttUrl: "blob:x",
    translated: false,
    ...over,
  };
}

function makeSubs(over: Partial<UseSubtitleTracks> = {}): UseSubtitleTracks {
  return {
    tracks: [],
    activeTrackId: null,
    setActiveTrack: vi.fn(),
    results: [],
    searching: false,
    searchError: null,
    canSearch: true,
    search: vi.fn(async () => {}),
    loadingFileId: null,
    loadResult: vi.fn(async () => {}),
    setDelay: vi.fn(),
    canTranslate: false,
    translatingTrackId: null,
    translateProgress: null,
    translateTrack: vi.fn(async () => {}),
    ...over,
  };
}

function renderMenu(subs: UseSubtitleTracks, props: Partial<{
  seedTitle: string;
  seedImdbId: string | null;
  seedSeason: number | null;
  seedEpisode: number | null;
  onClose: () => void;
}> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <CaptionsMenu
      subs={subs}
      seedTitle={props.seedTitle ?? "The Movie"}
      seedImdbId={props.seedImdbId ?? null}
      seedSeason={props.seedSeason ?? null}
      seedEpisode={props.seedEpisode ?? null}
      onClose={onClose}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  mockSettings = baseSettings();
  updateSettings.mockClear();
});

describe("CaptionsMenu popover material", () => {
  it("captions must not sample live video through a backdrop blur", () => {
    renderMenu(makeSubs());
    const menu = screen.getByRole("dialog", { name: "Subtitles" });
    expect(menu.classList).not.toContain("glass-raised");
    expect((menu as HTMLElement).style.backdropFilter).toBe("");
    expect((menu as HTMLElement).style.getPropertyValue("-webkit-backdrop-filter")).toBe("");

    const css = readFileSync("src/components/VideoPlayer.css", "utf8");
    expect(css).not.toMatch(/\.captions-menu\s*\{[^}]*backdrop-filter/);
  });
});

describe("track list & toggles", () => {
  it("renders the Off toggle pressed when no track is active", () => {
    renderMenu(makeSubs({ activeTrackId: null }));
    const off = screen.getByRole("button", { name: /Off/ });
    expect(off).toHaveAttribute("aria-pressed", "true");
  });

  it("renders loaded tracks with the active one pressed and an AI badge", () => {
    const subs = makeSubs({
      tracks: [
        makeTrack({ id: "t1", label: "EN · Rel" }),
        makeTrack({ id: "t2", label: "ES (AI)", translated: true }),
      ],
      activeTrackId: "t2",
    });
    renderMenu(subs);
    expect(screen.getByRole("button", { name: /EN · Rel/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const active = screen.getByRole("button", { name: /ES \(AI\)/ });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(within(active).getByText("AI")).toBeInTheDocument();
    // Off is not pressed when a track is active.
    expect(screen.getByRole("button", { name: /Off/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking Off and a track calls setActiveTrack accordingly", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({
      tracks: [makeTrack({ id: "t1", label: "EN · Rel" })],
      activeTrackId: "t1",
    });
    renderMenu(subs);
    await user.click(screen.getByRole("button", { name: /Off/ }));
    expect(subs.setActiveTrack).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: /EN · Rel/ }));
    expect(subs.setActiveTrack).toHaveBeenCalledWith("t1");
  });
});

describe("delay controls", () => {
  it("is hidden when there is no active track", () => {
    renderMenu(makeSubs({ tracks: [makeTrack()], activeTrackId: null }));
    expect(
      screen.queryByRole("button", { name: "Subtitles earlier" }),
    ).not.toBeInTheDocument();
  });

  it("shows the current delay and nudges ±0.25s", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({
      tracks: [makeTrack({ id: "t1", delayMs: 500 })],
      activeTrackId: "t1",
    });
    renderMenu(subs);
    expect(screen.getByText("0.50s")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Subtitles earlier" }));
    expect(subs.setDelay).toHaveBeenCalledWith("t1", 250);
    await user.click(screen.getByRole("button", { name: "Subtitles later" }));
    expect(subs.setDelay).toHaveBeenCalledWith("t1", 750);
  });
});

describe("appearance controls (persisted)", () => {
  it("decreases / increases font scale within bounds", async () => {
    const user = userEvent.setup();
    renderMenu(makeSubs());
    expect(screen.getByText("100%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Smaller subtitles" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleFontScale: 0.9 }),
    );
    await user.click(screen.getByRole("button", { name: "Larger subtitles" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleFontScale: 1.1 }),
    );
  });

  it("clamps font scale to the 0.7 floor", async () => {
    const user = userEvent.setup();
    mockSettings = { ...baseSettings(), subtitleFontScale: 0.7 };
    renderMenu(makeSubs());
    await user.click(screen.getByRole("button", { name: "Smaller subtitles" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleFontScale: 0.7 }),
    );
  });

  it("sets a text color from the swatches and marks the active one", async () => {
    const user = userEvent.setup();
    mockSettings = { ...baseSettings(), subtitleTextColor: "#ffe066" };
    renderMenu(makeSubs());
    const active = screen.getByRole("button", { name: "Subtitle color #ffe066" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(active.className).toContain("is-active");
    await user.click(screen.getByRole("button", { name: "Subtitle color #9be7ff" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleTextColor: "#9be7ff" }),
    );
  });

  it("adjusts background opacity within [0, 0.95]", async () => {
    const user = userEvent.setup();
    mockSettings = { ...baseSettings(), subtitleBgOpacity: 0.95 };
    renderMenu(makeSubs());
    expect(screen.getByText("95%")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More subtitle background" }),
    );
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleBgOpacity: 0.95 }),
    );
    await user.click(
      screen.getByRole("button", { name: "Less subtitle background" }),
    );
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleBgOpacity: 0.8 }),
    );
  });
});

describe("AI translate row (gated)", () => {
  it("is hidden when canTranslate is false even with an active track", () => {
    renderMenu(
      makeSubs({
        canTranslate: false,
        tracks: [makeTrack()],
        activeTrackId: "t1",
      }),
    );
    expect(
      screen.queryByLabelText("Translate target language"),
    ).not.toBeInTheDocument();
  });

  it("is hidden when there is no active track even if canTranslate", () => {
    renderMenu(makeSubs({ canTranslate: true, activeTrackId: null }));
    expect(
      screen.queryByLabelText("Translate target language"),
    ).not.toBeInTheDocument();
  });

  it("translates the active track to the selected target", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({
      canTranslate: true,
      tracks: [makeTrack({ id: "t1" })],
      activeTrackId: "t1",
    });
    renderMenu(subs);
    await user.selectOptions(
      screen.getByLabelText("Translate target language"),
      "French",
    );
    await user.click(screen.getByRole("button", { name: /Translate to French/ }));
    expect(subs.translateTrack).toHaveBeenCalledWith("t1", "French");
  });

  it("shows progress and disables the button while translating", () => {
    const subs = makeSubs({
      canTranslate: true,
      tracks: [makeTrack({ id: "t1" })],
      activeTrackId: "t1",
      translatingTrackId: "t1",
      translateProgress: { done: 3, total: 10 },
    });
    renderMenu(subs);
    const btn = screen.getByRole("button", { name: /Translating 3\/10/ });
    expect(btn).toBeDisabled();
  });

  it("shows 'Translating…' when translating without progress detail", () => {
    const subs = makeSubs({
      canTranslate: true,
      tracks: [makeTrack({ id: "t1" })],
      activeTrackId: "t1",
      translatingTrackId: "t1",
      translateProgress: null,
    });
    renderMenu(subs);
    expect(
      screen.getByRole("button", { name: /Translating…/ }),
    ).toBeInTheDocument();
  });
});

describe("OpenSubtitles search (gated)", () => {
  it("shows the configure-key note when canSearch is false", () => {
    renderMenu(makeSubs({ canSearch: false }));
    expect(
      screen.getByText(/Add an OpenSubtitles API key in Settings/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Search" }),
    ).not.toBeInTheDocument();
  });

  it("seeds the query input with the title and searches by free text when no imdb id", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({ canSearch: true });
    renderMenu(subs, { seedTitle: "Dune", seedImdbId: null });
    const input = screen.getByPlaceholderText("Search title…") as HTMLInputElement;
    expect(input.value).toBe("Dune");
    expect(input.disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(subs.search).toHaveBeenCalledWith({
      imdbId: null,
      query: "Dune",
      season: null,
      episode: null,
      languages: ["en"],
    });
  });

  it("disables the input and searches by imdb id (query null) when seedImdbId is set", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({ canSearch: true });
    renderMenu(subs, {
      seedTitle: "Show",
      seedImdbId: "tt42",
      seedSeason: 2,
      seedEpisode: 5,
    });
    const input = screen.getByPlaceholderText(
      "Searching by IMDb id",
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(subs.search).toHaveBeenCalledWith({
      imdbId: "tt42",
      query: null,
      season: 2,
      episode: 5,
      languages: ["en"],
    });
  });

  it("searches on Enter in the query input with the chosen language", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({ canSearch: true });
    renderMenu(subs, { seedTitle: "X", seedImdbId: null });
    await user.selectOptions(
      screen.getByLabelText("Subtitle language"),
      "es",
    );
    const input = screen.getByPlaceholderText("Search title…");
    await user.type(input, "{Enter}");
    expect(subs.search).toHaveBeenCalledWith(
      expect.objectContaining({ languages: ["es"] }),
    );
  });

  it("does not run search on non-Enter key presses", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({ canSearch: true });
    renderMenu(subs, { seedTitle: "X", seedImdbId: null });
    const input = screen.getByPlaceholderText("Search title…");
    await user.type(input, "abc");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(subs.search).not.toHaveBeenCalled();
  });

  it("shows a search spinner and disables Search while searching", () => {
    renderMenu(makeSubs({ canSearch: true, searching: true }));
    const btn = screen.getByRole("button", { name: /Searching…/ });
    expect(btn).toBeDisabled();
  });

  it("renders a search error message", () => {
    renderMenu(makeSubs({ canSearch: true, searchError: "No subtitles found." }));
    expect(screen.getByLabelText("Subtitle title search")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No subtitles found.");
    expect(screen.getByText("No subtitles found.")).toBeInTheDocument();
  });

  it("renders results with HI + download count and loads on click", async () => {
    const user = userEvent.setup();
    const subs = makeSubs({
      canSearch: true,
      results: [
        {
          fileId: "f9",
          language: "en",
          release: "BluRay.1080p",
          downloadCount: 12345,
          hearingImpaired: true,
          machineTranslated: false,
          fps: null,
        },
      ],
    });
    renderMenu(subs);
    expect(screen.getByText("BluRay.1080p")).toBeInTheDocument();
    expect(screen.getByText(/HI ·/)).toBeInTheDocument();
    expect(screen.getByText(/12,345↓/)).toBeInTheDocument();
    await user.click(screen.getByText("BluRay.1080p"));
    expect(subs.loadResult).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f9" }),
    );
  });

  it("disables results and shows 'Loading…' on the in-flight one", () => {
    const subs = makeSubs({
      canSearch: true,
      loadingFileId: "f9",
      results: [
        {
          fileId: "f9",
          language: "en",
          release: "Rel",
          downloadCount: 1,
          hearingImpaired: false,
          machineTranslated: false,
          fps: null,
        },
      ],
    });
    renderMenu(subs);
    const result = screen.getByText("Rel").closest("button")!;
    expect(result).toBeDisabled();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

describe("close button", () => {
  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderMenu(makeSubs());
    await user.click(screen.getByRole("button", { name: "Close subtitles menu" }));
    expect(onClose).toHaveBeenCalled();
  });
});


describe("embedded caption choices", () => {
  it("does not claim Off while embedded captions are selected and routes their controls", () => {
    const select = vi.fn();
    const subs = makeSubs();
    render(<CaptionsMenu subs={subs} embedded={{
      tracks: [{ id: "hls:0", label: "Embedded subtitles" }],
      activeTrackId: "hls:0", setActiveTrack: select,
    }} seedTitle="T" seedImdbId={null} seedSeason={null} seedEpisode={null} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Embedded subtitles" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Embedded subtitles" }));
    expect(select).toHaveBeenLastCalledWith("hls:0");
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(select).toHaveBeenLastCalledWith(null);
    expect(subs.setActiveTrack).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button", { name: "Subtitles earlier" })).not.toBeInTheDocument();
  });
});
