// @vitest-environment jsdom
//
// Render tests for the Watchlist screen. It reads `watchlist` (saved previews)
// and `cachedResolutions` (id -> cached resolution) from the store. The subtitle
// gains a "N ready to play instantly." hint counting items with a cached
// resolution; each card has a Remove button wired to removeFromWatchlist. When
// empty it shows an empty-state with Browse / Search CTAs.
//
// The store is mocked for data + callbacks; MediaCard is stubbed so we can assert
// on the `ready` prop and item title without the real image plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview } from "../models/media";
import type {
  CachedResolutionRecord,
  WatchHistoryRecord,
} from "../storage/models";

// --- mutable mock state -----------------------------------------------------

const openDetail = vi.fn();
const openBrowse = vi.fn();
const navigate = vi.fn();
const removeFromWatchlist = vi.fn();
const listWatchlistFolders = vi.fn();
const listWatchlistRows = vi.fn();
const createWatchlistFolder = vi.fn();
const renameWatchlistFolder = vi.fn();
const deleteWatchlistFolder = vi.fn();
const assignWatchlistFolder = vi.fn();
const importToWatchlist = vi.fn();
const isTraktConnected = vi.hoisted(() => vi.fn());
const getValidAccessToken = vi.hoisted(() => vi.fn());
const fetchWatchlist = vi.hoisted(() => vi.fn());
const fetchWatchlistShows = vi.hoisted(() => vi.fn());
const pushWatchlist = vi.hoisted(() => vi.fn());
const findByImdbId = vi.fn();
const getDetail = vi.fn();
const search = vi.fn();
const getExternalIds = vi.fn();
let mockTmdbService: {
  findByImdbId: typeof findByImdbId;
  getDetail: typeof getDetail;
  search: typeof search;
  getExternalIds: typeof getExternalIds;
} | null = {
  findByImdbId,
  getDetail,
  search,
  getExternalIds,
};
let serverMode = false;
let mockWatchlist: MediaPreview[] = [];
let mockCachedResolutions: Record<string, CachedResolutionRecord> = {};
let mockContinueWatching: WatchHistoryRecord[] = [];
let watchlistImportOnClose: (() => void) | null = null;
const settings = { traktClientId: "trakt-client", traktClientSecret: "trakt-secret" };

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    watchlist: mockWatchlist,
    openDetail,
    removeFromWatchlist,
    continueWatching: mockContinueWatching,
    openBrowse,
    navigate,
    services: {
      tmdb: mockTmdbService,
    },
    settings,
    importToWatchlist,
  }),
  useCachedResolutions: () => mockCachedResolutions,
}));

vi.mock("../lib/serverMode", () => ({ isServerMode: () => serverMode }));

vi.mock("../data/traktConnection", () => ({
  isTraktConnected,
  getValidAccessToken,
}));

vi.mock("../services/sync/TraktSyncService", () => ({
  TraktSyncService: class {
    fetchWatchlist(...args: unknown[]) {
      return fetchWatchlist(...args);
    }
    fetchWatchlistShows(...args: unknown[]) {
      return fetchWatchlistShows(...args);
    }
    pushWatchlist(...args: unknown[]) {
      return pushWatchlist(...args);
    }
  },
}));

vi.mock("../storage", () => ({
  getStore: () => ({
    listWatchlistFolders: () => listWatchlistFolders(),
    listWatchlist: () => listWatchlistRows(),
    createWatchlistFolder: (name: string) => createWatchlistFolder(name),
    renameWatchlistFolder: (id: string, name: string) => renameWatchlistFolder(id, name),
    deleteWatchlistFolder: (id: string) => deleteWatchlistFolder(id),
    assignWatchlistFolder: (id: string, folderId: string | null) =>
      assignWatchlistFolder(id, folderId),
  }),
}));

vi.mock("../components/WatchlistImportDialog", () => ({
  WatchlistImportDialog: (props: {
    onClose: () => void;
    onImported?: () => void;
  }) => {
    watchlistImportOnClose = props.onClose;
    return (
      <div data-testid="watchlist-import-dialog">
        <button type="button" onClick={() => props.onClose()}>
          Close import dialog
        </button>
        {props.onImported ? (
          <button
            type="button"
            onClick={() => {
              props.onImported?.();
              props.onClose();
            }}
          >
            Simulate completed import
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("../components/MediaCard", () => ({
  MediaCard: (props: {
    item: MediaPreview;
    onSelect?: (i: MediaPreview) => void;
    ready?: boolean;
    progress?: number;
    watched?: boolean;
  }) => (
    <button
      type="button"
      data-ready={props.ready ? "yes" : "no"}
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

import { shouldShowTraktWatchlistSync, Watchlist } from "./Watchlist";

// --- helpers ----------------------------------------------------------------

function preview(id: string, title: string): MediaPreview {
  return { id, type: "movie", title };
}

function resolution(): CachedResolutionRecord {
  return {} as CachedResolutionRecord;
}

beforeEach(() => {
  openDetail.mockClear();
  openBrowse.mockClear();
  navigate.mockClear();
  removeFromWatchlist.mockClear();
  createWatchlistFolder.mockClear();
  renameWatchlistFolder.mockClear();
  deleteWatchlistFolder.mockClear();
  assignWatchlistFolder.mockClear();
  mockWatchlist = [];
  mockCachedResolutions = {};
  mockContinueWatching = [];
  watchlistImportOnClose = null;
  mockWatchedIds = new Set<string>();
  serverMode = false;
  isTraktConnected.mockResolvedValue(false);
  getValidAccessToken.mockResolvedValue("access-token");
  fetchWatchlist.mockResolvedValue([]);
  fetchWatchlistShows.mockResolvedValue([]);
  pushWatchlist.mockResolvedValue({});
  findByImdbId.mockResolvedValue(null);
  getDetail.mockReset();
  search.mockResolvedValue({ items: [] });
  getExternalIds.mockResolvedValue({ imdbId: null });
  importToWatchlist.mockResolvedValue({ added: 0, skipped: 0 });
  listWatchlistFolders.mockResolvedValue([]);
  listWatchlistRows.mockResolvedValue([]);
  createWatchlistFolder.mockResolvedValue({ id: "folder-1", name: "New Folder" });
  renameWatchlistFolder.mockResolvedValue(undefined);
  deleteWatchlistFolder.mockResolvedValue(undefined);
  assignWatchlistFolder.mockResolvedValue(undefined);
  settings.traktClientId = "trakt-client";
  settings.traktClientSecret = "trakt-secret";
  mockTmdbService = {
    findByImdbId,
    getDetail,
    search,
    getExternalIds,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Watchlist - empty", () => {
  it("renders the empty-state with Browse + Search CTAs", async () => {
    render(<Watchlist />);
    expect(screen.getByText("Your watchlist is empty")).toBeInTheDocument();
    expect(screen.queryByText(/card:/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /browse trending/i }));
    expect(openBrowse).toHaveBeenCalledWith({
      kind: "category",
      type: "movie",
      category: "trending",
    });

    await userEvent.click(screen.getByRole("button", { name: /search catalog/i }));
    expect(navigate).toHaveBeenCalledWith("search");
  });

  it("does not show the ready-to-play hint when empty", () => {
    render(<Watchlist />);
    expect(screen.queryByText(/ready to play instantly/i)).not.toBeInTheDocument();
  });

  it("opens the import dialog from the empty-state list action", async () => {
    const user = userEvent.setup();
    render(<Watchlist />);

    await user.click(screen.getByRole("button", { name: /Import list/i }));
    expect(screen.getByTestId("watchlist-import-dialog")).toBeInTheDocument();
  });

  it("resolves organization reload after import completes", async () => {
    const user = userEvent.setup();
    render(<Watchlist />);

    await user.click(screen.getByRole("button", { name: /Import list/i }));
    expect(screen.getByTestId("watchlist-import-dialog")).toBeInTheDocument();

    listWatchlistFolders.mockResolvedValue([{ id: "folder-a", name: "Imported" }]);
    listWatchlistRows.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: /Simulate completed import/i }));

    expect(screen.queryByTestId("watchlist-import-dialog")).not.toBeInTheDocument();
  });
});

describe("Watchlist - populated", () => {
  it("renders a card per item and opens detail on select", async () => {
    mockWatchlist = [preview("m1", "Tenet"), preview("m2", "Dune")];
    render(<Watchlist />);
    expect(screen.getByText("card:Tenet")).toBeInTheDocument();
    expect(screen.getByText("card:Dune")).toBeInTheDocument();

    await userEvent.click(screen.getByText("card:Dune"));
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m2" }),
    );
  });

  it("marks cards ready and shows the ready-to-play count hint", () => {
    mockWatchlist = [preview("m1", "Tenet"), preview("m2", "Dune")];
    mockCachedResolutions = { m1: resolution() };
    render(<Watchlist />);

    expect(screen.getByText(/1 ready to play instantly/i)).toBeInTheDocument();
    expect(screen.getByText("card:Tenet")).toHaveAttribute("data-ready", "yes");
    expect(screen.getByText("card:Dune")).toHaveAttribute("data-ready", "no");
  });

  it("opens the import dialog when a watchlist item exists and Import is tapped", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByTestId("watchlist-import-dialog")).toBeInTheDocument();
    expect(watchlistImportOnClose).toBeInstanceOf(Function);
    await userEvent.click(screen.getByRole("button", { name: "Close import dialog" }));
    expect(screen.queryByTestId("watchlist-import-dialog")).not.toBeInTheDocument();
  });

  it("flags watched titles from the batched history lookup", () => {
    mockWatchlist = [preview("m1", "Tenet"), preview("m2", "Dune")];
    mockWatchedIds = new Set<string>(["m2"]);
    render(<Watchlist />);

    expect(screen.getByText("card:Tenet")).toHaveAttribute("data-watched", "no");
    expect(screen.getByText("card:Dune")).toHaveAttribute("data-watched", "yes");
  });

  it("removes an item via its Remove button", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);

    const removeBtn = screen.getByRole("button", {
      name: /Remove Tenet from watchlist/i,
    });
    await userEvent.click(removeBtn);
    expect(removeFromWatchlist).toHaveBeenCalledWith("m1");
  });

  it("shows a resume bar on an in-progress watchlisted title", () => {
    mockWatchlist = [preview("m1", "Tenet"), preview("m2", "Dune")];
    mockContinueWatching = [
      {
        id: "m1:",
        mediaId: "m1",
        episodeId: null,
        progressSeconds: 50,
        durationSeconds: 100,
        completed: false,
        lastWatched: "2020-01-01T00:00:00Z",
        streamQuality: null,
        preview: preview("m1", "Tenet"),
      },
    ];
    render(<Watchlist />);
    expect(screen.getByText("card:Tenet")).toHaveAttribute("data-progress", "0.5");
    expect(screen.getByText("card:Dune")).toHaveAttribute("data-progress", "");
  });

  it("quickly filters titles in the current watchlist view", async () => {
    mockWatchlist = [preview("m1", "Tenet"), preview("m2", "Dune")];
    render(<Watchlist />);

    await userEvent.type(screen.getByRole("searchbox", { name: /search watchlist/i }), "dune");
    expect(screen.getByText("card:Dune")).toBeInTheDocument();
    expect(screen.queryByText("card:Tenet")).not.toBeInTheDocument();
  });

  it("supports canceling folder creation", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);

    await userEvent.click(screen.getByRole("button", { name: /\+ New folder/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New watchlist folder name")).not.toBeInTheDocument();
  });

  it("surfaces Trakt connection failures in state without blocking actions", async () => {
    isTraktConnected.mockRejectedValue(new Error("trakt unavailable"));
    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);

    expect(await screen.findByText("card:Tenet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pull from Trakt" })).not.toBeInTheDocument();
  });

  it("shows organization errors from the initial reload pass", async () => {
    listWatchlistFolders.mockRejectedValueOnce(new Error("store load failed"));
    listWatchlistRows.mockResolvedValueOnce([]);
    mockWatchlist = [preview("m1", "Tenet")];

    render(<Watchlist />);
    expect(await screen.findByText("store load failed")).toBeInTheDocument();
  });
});

describe("Watchlist - Trakt pull", () => {
  it("imports resolved Trakt movies and reports added and skipped titles", async () => {
    isTraktConnected.mockResolvedValue(true);
    fetchWatchlist.mockResolvedValue([
      { imdbID: "tt0133093", title: "The Matrix", year: 1999 },
    ]);
    search.mockResolvedValue({
      items: [preview("tmdb-603", "The Matrix")],
    });
    importToWatchlist.mockResolvedValue({ added: 1, skipped: 2 });

    render(<Watchlist />);
    const pull = await screen.findByRole("button", { name: "Pull from Trakt" });
    await userEvent.click(pull);

    await waitFor(() =>
      expect(importToWatchlist).toHaveBeenCalledWith([
        expect.objectContaining({ id: "tmdb-603", title: "The Matrix" }),
      ]),
    );
    expect(fetchWatchlist).toHaveBeenCalledWith("trakt-client", "access-token");
    expect(screen.getByText(/Pulled 1 movie, 0 series from Trakt: added 1, skipped 2 already saved/i)).toBeInTheDocument();
  });

  it("pulls TMDB-resolved shows into the same watchlist merge", async () => {
    isTraktConnected.mockResolvedValue(true);
    fetchWatchlistShows.mockResolvedValue([
      {
        traktID: 123,
        imdbID: "tt0944947",
        tmdbID: 1399,
        title: "Game of Thrones",
        year: 2011,
      },
    ]);
    getDetail.mockResolvedValue({
      id: "tmdb-1399",
      type: "series",
      title: "Game of Thrones",
      year: 2011,
      genres: [],
      lastFetched: "2026-01-01T00:00:00.000Z",
      tmdbId: 1399,
    });
    importToWatchlist.mockResolvedValue({ added: 1, skipped: 0 });

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));

    await waitFor(() =>
      expect(importToWatchlist).toHaveBeenCalledWith([
        expect.objectContaining({ id: "tmdb-1399", type: "series" }),
      ]),
    );
    expect(fetchWatchlistShows).toHaveBeenCalledWith("trakt-client", "access-token");
    expect(screen.getByText(/Pulled 0 movies, 1 series from Trakt/i)).toBeInTheDocument();
  });

  it("pushes mixed movie and series candidates in one Trakt request", async () => {
    isTraktConnected.mockResolvedValue(true);
    mockWatchlist = [
      { ...preview("tt0133093", "The Matrix"), type: "movie" },
      { id: "tmdb-1399", type: "series", title: "Game of Thrones", tmdbId: 1399 },
    ];

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Push to Trakt" }));

    await waitFor(() =>
      expect(pushWatchlist).toHaveBeenCalledWith(
        "trakt-client",
        "access-token",
        ["tt0133093"],
        [1399],
      ),
    );
    expect(screen.getByText(/Pushed 1 movie, 1 series to Trakt/i)).toBeInTheDocument();
  });

  it("hides Trakt actions in Server Mode", () => {
    expect(shouldShowTraktWatchlistSync(true, true)).toBe(false);
    expect(shouldShowTraktWatchlistSync(true, false)).toBe(true);
  });

  it("shows a TMDB missing error when pulling without a TMDB client", async () => {
    isTraktConnected.mockResolvedValue(true);
    mockTmdbService = null;

    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));

    expect(await screen.findByText(/Add a TMDB API key in Settings to match Trakt titles./i))
      .toBeInTheDocument();
  });

  it("shows a TMDB missing error when pushing without a TMDB client", async () => {
    isTraktConnected.mockResolvedValue(true);
    mockTmdbService = null;

    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Push to Trakt" }));

    expect(await screen.findByText(/Add a TMDB API key in Settings to reconcile Trakt IDs./i))
      .toBeInTheDocument();
  });

  it("fails gracefully when access token lookup returns null", async () => {
    isTraktConnected.mockResolvedValue(true);
    getValidAccessToken.mockResolvedValue(null);

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));
    expect(await screen.findByText(/Trakt is not connected/)).toBeInTheDocument();
  });

  it("fails gracefully when Trakt authorization is not configured", async () => {
    isTraktConnected.mockResolvedValue(true);
    settings.traktClientSecret = "";

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));
    expect(await screen.findByText(/Add your Trakt Client ID and Secret in Settings before syncing./i))
      .toBeInTheDocument();
  });

  it("surfaces fetch errors from Trakt pull", async () => {
    isTraktConnected.mockResolvedValue(true);
    fetchWatchlist.mockRejectedValue(new Error("pull failed"));
    render(<Watchlist />);

    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));
    expect(await screen.findByText(/pull failed/i)).toBeInTheDocument();
  });

  it("surfaces write errors from Trakt push", async () => {
    isTraktConnected.mockResolvedValue(true);
    mockWatchlist = [{ ...preview("tt0133093", "The Matrix"), type: "movie" }];
    pushWatchlist.mockRejectedValue(new Error("push failed"));

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Push to Trakt" }));
    expect(await screen.findByText(/push failed/i)).toBeInTheDocument();
  });

  it("surfaces organization errors from failed folder creation", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    createWatchlistFolder.mockRejectedValueOnce(new Error("storage offline"));
    listWatchlistFolders.mockResolvedValue([{ id: "f1", name: "Existing" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(screen.getByRole("button", { name: /\+ New folder/i }));
    await userEvent.type(screen.getByLabelText("New watchlist folder name"), "New Folder");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("storage offline")).toBeInTheDocument();
  });
});

describe("Watchlist - folder organization", () => {
  it("creates a folder and selects it", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    createWatchlistFolder.mockResolvedValue({ id: "folder-2", name: "Queue" });
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(screen.getByRole("button", { name: /\+ New folder/i }));
    await userEvent.type(screen.getByLabelText("New watchlist folder name"), "Queue");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createWatchlistFolder).toHaveBeenCalledWith("Queue"));
    expect(await screen.findByRole("button", { name: "Queue" })).toBeInTheDocument();
  });

  it("ignores folder creation when name is empty", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);
    await userEvent.click(screen.getByRole("button", { name: /\+ New folder/i }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(createWatchlistFolder).not.toHaveBeenCalled();
  });

  it("renames a selected folder", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    await userEvent.clear(screen.getByLabelText("Rename watchlist folder"));
    await userEvent.type(screen.getByLabelText("Rename watchlist folder"), "Watch Later");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(renameWatchlistFolder).toHaveBeenCalledWith("folder-2", "Watch Later"),
    );
  });

  it("cancels folder rename without writing", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    await userEvent.type(screen.getByLabelText("Rename watchlist folder"), "Watch Later");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(renameWatchlistFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("deletes a selected folder and returns to all", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteWatchlistFolder).toHaveBeenCalledWith("folder-2"));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("cancels folder deletion confirmation", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([]);

    render(<Watchlist />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteWatchlistFolder).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeInTheDocument();
  });

  it("moves a watchlist title into another folder", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([
      {
        mediaId: "m1",
        folderId: null,
      },
    ] as never[]);

    render(<Watchlist />);
    const select = await screen.findByLabelText("Move Tenet to folder");
    await userEvent.selectOptions(select, "folder-2");

    await waitFor(() =>
      expect(assignWatchlistFolder).toHaveBeenCalledWith("m1", "folder-2"),
    );
  });

  it("shows an organization error when the pull sync refresh fails", async () => {
    isTraktConnected.mockResolvedValue(true);
    fetchWatchlist.mockResolvedValue([{ imdbID: "tt0133093", title: "The Matrix", year: 1999 }]);
    search.mockResolvedValue({ items: [preview("tmdb-603", "The Matrix")] });
    importToWatchlist.mockResolvedValue({ added: 1, skipped: 0 });
    listWatchlistFolders
      .mockResolvedValueOnce([{ id: "f1", name: "Queue" }])
      .mockRejectedValueOnce(new Error("refresh after pull failed"));
    listWatchlistRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockWatchlist = [preview("m1", "Tenet")];
    render(<Watchlist />);

    await userEvent.click(await screen.findByRole("button", { name: "Pull from Trakt" }));
    expect(await screen.findByText(/refresh after pull failed/i)).toBeInTheDocument();
  });

  it("records folder chip state for non-All selection", async () => {
    mockWatchlist = [preview("m1", "Tenet")];
    listWatchlistFolders.mockResolvedValue([{ id: "folder-2", name: "Queue" }]);
    listWatchlistRows.mockResolvedValue([{ mediaId: "m1", folderId: null } as never]);

    render(<Watchlist />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });

  it("hides folder controls in Server mode", () => {
    mockWatchlist = [preview("m1", "Tenet")];
    serverMode = true;

    render(<Watchlist />);
    expect(screen.queryByRole("button", { name: /\+ New folder/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Move Tenet to folder/i)).not.toBeInTheDocument();
  });
});
