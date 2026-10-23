// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MediaPreview } from "../models/media";
import { emptyBrowseFilters } from "../data/browse";
import {
  AppStoreProvider,
  readNavigationHistoryEntry,
  useAppStore,
} from "./AppStore";

const settings = {
  appearanceDefaultTab: "discover",
  networkMode: "online",
  simpleMode: false,
};

vi.mock("../data/settings", () => ({
  loadSettings: () => settings,
  loadSettingsFromStore: async () => settings,
  applyDesignRefresh: (value: unknown) => value,
  markDesignRefreshApplied: async () => {},
  saveSettingsToStore: async () => {},
  buildServices: () => ({ hasDebrid: false }),
}));
vi.mock("../data/calendar", () => ({
  useCalendar: () => ({ episodes: [], loading: false, error: null }),
}));
vi.mock("../data/calendarNotifications", () => ({
  loadOrInitializeCalendarLastSeenAt: async () => Date.now(),
  saveCalendarLastSeenAt: async () => {},
}));
vi.mock("../data/library", () => ({
  loadWatchlist: async () => [],
  loadHistory: async () => [],
  loadContinueWatching: async () => [],
  recordHistory: async () => [],
  removeFromWatchlist: async () => [],
  toggleWatchlist: async () => [],
}));
vi.mock("../storage", () => ({
  getStore: () => ({
    listCachedResolutions: async () => [],
    getCachedResolutions: async () => [],
    recordHistory: async () => {},
    deleteCachedResolution: async () => {},
  }),
  swapLocalProfileStore: async () => {},
}));
vi.mock("../storage/RemoteStore", () => ({
  RemoteStore: class RemoteStore {},
}));
vi.mock("../lib/autoResolve", () => ({
  AutoResolveScheduler: class AutoResolveScheduler {
    start() {}
    stop() {}
    async kick() {}
  },
}));
vi.mock("../lib/serverMode", () => ({ isServerMode: () => false }));
vi.mock("../lib/networkPolicy", () => ({ setNetworkMode: () => {} }));
vi.mock("../lib/ServerSessionContext", () => ({ useServerSession: () => null }));
vi.mock("../lib/passwordHash", () => ({ verifyPassword: async () => true }));
vi.mock("../storage/ProfileRegistry", () => ({
  dbNameForProfile: () => "test",
  ensureDefaultProfile: async () => ({ id: "default", isDefault: true }),
  getActiveProfileId: async () => "default",
  getProfile: async () => ({ id: "default", isDefault: true }),
  isMultiUserEnabled: async () => true,
  listProfiles: async () => [],
  setActiveProfileId: async () => {},
  updateProfileRecord: async () => {},
}));

const item: MediaPreview = {
  id: "history-test-title",
  title: "History test title",
  type: "series",
  year: 2024,
  posterPath: null,
  backdropPath: null,
};

const replacementItem: MediaPreview = {
  ...item,
  id: "history-replacement-title",
  title: "History replacement title",
};

function HistoryHarness() {
  const store = useAppStore();
  return (
    <>
      <output data-testid="route">{store.route}</output>
      <output data-testid="browse">{store.browseContext?.kind ?? "none"}</output>
      <output data-testid="filters">
        {store.browseFiltersOpen ? "open" : "closed"}
      </output>
      <output data-testid="detail">{store.detailItem?.id ?? "none"}</output>
      <output data-testid="detail-sources">
        {store.detailSourcesOpen ? "open" : "closed"}
      </output>
      <output data-testid="detail-player">
        {store.detailPlayerOpen ? "open" : "closed"}
      </output>
      <button
        type="button"
        onClick={() =>
          store.openBrowse({ kind: "category", type: "movie", category: "popular" })
        }
      >
        browse
      </button>
      <button type="button" onClick={() => store.openDetail(item)}>
        detail
      </button>
      <button type="button" onClick={() => store.openDetail(replacementItem)}>
        replacement detail
      </button>
      <button type="button" onClick={store.openDetailSources}>
        sources
      </button>
      <button type="button" onClick={store.closeDetailSources}>
        episodes
      </button>
      <button type="button" onClick={store.openDetailPlayer}>
        player
      </button>
      <button type="button" onClick={store.openBrowseFilters}>
        filters
      </button>
      <button
        type="button"
        onClick={() =>
          store.updateBrowseContext({
            kind: "discover",
            type: "movie",
            filters: { ...emptyBrowseFilters(), genreIds: [28] },
          })
        }
      >
        apply filters
      </button>
      <button type="button" onClick={() => store.navigate("watchlist")}>
        watchlist
      </button>
    </>
  );
}

async function browserBack(): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await popped;
  });
}

async function browserForward(): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.forward();
    await popped;
  });
}

describe("AppStore browser history", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("Back closes Detail and keeps the Browse overlay beneath it", async () => {
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("browse"));
    fireEvent.click(screen.getByText("detail"));

    await browserBack();

    expect(screen.getByTestId("detail")).toHaveTextContent("none");
    expect(screen.getByTestId("browse")).toHaveTextContent("category");
  });

  it("Back closes Browse and returns to the current screen", async () => {
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("browse"));

    await browserBack();

    expect(screen.getByTestId("browse")).toHaveTextContent("none");
    expect(screen.getByTestId("route")).toHaveTextContent("discover");
  });

  it("does not push a replacement entry while applying popstate", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("browse"));
    fireEvent.click(screen.getByText("detail"));
    const pushesBeforeBack = pushState.mock.calls.length;

    await browserBack();

    expect(pushState).toHaveBeenCalledTimes(pushesBeforeBack);
    expect(readNavigationHistoryEntry(window.history.state)?.detailItem).toBeNull();
  });

  it("replaces the Browse entry beneath applied filters", async () => {
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("browse"));
    fireEvent.click(screen.getByText("filters"));
    expect(screen.getByTestId("filters")).toHaveTextContent("open");

    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      fireEvent.click(screen.getByText("apply filters"));
      await popped;
    });

    expect(screen.getByTestId("browse")).toHaveTextContent("discover");
    expect(screen.getByTestId("filters")).toHaveTextContent("closed");

    await browserBack();
    expect(screen.getByTestId("browse")).toHaveTextContent("none");
  });

  it("restores the persisted route on a fresh provider mount", async () => {
    window.history.replaceState(
      {
        debridStreamerNavigation: 1,
        depth: 0,
        route: "watchlist",
        browseContext: null,
        detailItem: null,
        layer: "none",
        localFilePlayer: null,
      },
      "",
      "/",
    );
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("route")).toHaveTextContent("watchlist");
    });
  });

  it("Forward reapplies the Detail and Browse descriptors", async () => {
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("browse"));
    fireEvent.click(screen.getByText("detail"));
    await browserBack();
    await browserForward();

    expect(screen.getByTestId("browse")).toHaveTextContent("category");
    expect(screen.getByTestId("detail")).toHaveTextContent(item.id);
  });

  it("treats a series source page as a replayable Detail history layer", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    render(
      <AppStoreProvider>
        <HistoryHarness />
      </AppStoreProvider>,
    );
    fireEvent.click(screen.getByText("detail"));
    fireEvent.click(screen.getByText("sources"));

    expect(screen.getByTestId("detail")).toHaveTextContent(item.id);
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("open");
    expect(readNavigationHistoryEntry(window.history.state)?.layer)
      .toBe("detail-sources");
    const pushesBeforeReplay = pushState.mock.calls.length;

    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      fireEvent.click(screen.getByText("episodes"));
      await popped;
    });
    expect(screen.getByTestId("detail")).toHaveTextContent(item.id);
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("closed");

    await browserForward();
    expect(screen.getByTestId("detail")).toHaveTextContent(item.id);
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("open");
    expect(pushState).toHaveBeenCalledTimes(pushesBeforeReplay);

    fireEvent.click(screen.getByText("player"));
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("closed");
    expect(screen.getByTestId("detail-player")).toHaveTextContent("open");
    expect(readNavigationHistoryEntry(window.history.state)?.layer)
      .toBe("detail-player-sources");

    await browserBack();
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("open");
    expect(screen.getByTestId("detail-player")).toHaveTextContent("closed");

    await browserForward();
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("closed");
    expect(screen.getByTestId("detail-player")).toHaveTextContent("closed");

    await browserBack();
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("open");
    await browserBack();
    fireEvent.click(screen.getByText("replacement detail"));
    expect(screen.getByTestId("detail")).toHaveTextContent(replacementItem.id);
    expect(screen.getByTestId("detail-sources")).toHaveTextContent("closed");
  });
});
