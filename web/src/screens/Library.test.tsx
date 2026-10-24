// @vitest-environment jsdom
//
// Render tests for the Library screen. It loads favorites entries + folders from
// the Store, renders a folder chip strip that filters a MediaGrid, and falls
// back to the watchlist when the library proper is empty. In Server Mode it also
// surfaces a shared "Requested" rail.
//
// Heavy deps are mocked: the app store (watchlist + nav callbacks), the storage
// Store (getStore), serverMode/serverApi, and MediaGrid/Rail (rendered as simple
// stubs so we assert on item lists without MediaCard's image plumbing).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MediaPreview } from "../models/media";
import type {
  LibraryEntryRecord,
  LibraryFolderRecord,
} from "../storage/models";

// --- mutable mock state -----------------------------------------------------

const openDetail = vi.fn();
const openBrowse = vi.fn();
const navigate = vi.fn();
let mockWatchlist: MediaPreview[] = [];

const ensureSystemFolders = vi.fn(async () => {});
let listFoldersImpl: () => Promise<LibraryFolderRecord[]>;
let listLibraryImpl: () => Promise<LibraryEntryRecord[]>;
const createFolderFn = vi.fn<(...a: unknown[]) => Promise<LibraryFolderRecord>>(
  async (name) => folder("f-new", String(name)),
);
const saveFolderFn = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const deleteFolderFn = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const addToLibraryFn = vi.fn<(...a: unknown[]) => Promise<LibraryEntryRecord>>(
  async () => ({}) as LibraryEntryRecord,
);
const removeFromLibraryFn = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});

let mockServerMode = false;
const listRequested = vi.fn(async () => ({ items: [] as { preview: MediaPreview }[] }));

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    watchlist: mockWatchlist,
    openDetail,
    openBrowse,
    navigate,
  }),
}));

vi.mock("../storage", () => ({
  getStore: () => ({
    ensureSystemFolders,
    listFolders: () => listFoldersImpl(),
    listLibrary: () => listLibraryImpl(),
    createFolder: (name: string, listType: string, parentId: string | null) =>
      createFolderFn(name, listType, parentId),
    saveFolder: (f: LibraryFolderRecord) => saveFolderFn(f),
    deleteFolder: (id: string) => deleteFolderFn(id),
    addToLibrary: (e: unknown) => addToLibraryFn(e),
    removeFromLibrary: (id: string) => removeFromLibraryFn(id),
  }),
}));

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => mockServerMode,
}));

vi.mock("../lib/serverApi", () => ({
  listRequested: () => listRequested(),
}));

// The favorites grid is now inlined with MediaCard directly (so it can carry the
// watched badge); stub the card to assert on the item lists + the watched prop.
vi.mock("../components/MediaCard", () => ({
  MediaCard: (props: {
    item: MediaPreview;
    onSelect?: (i: MediaPreview) => void;
    watched?: boolean;
  }) => (
    <button
      type="button"
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
  Rail: (props: { title: string; items: MediaPreview[] }) =>
    props.items.length === 0 ? null : (
      <div data-testid="rail">
        {props.title}:{props.items.map((i) => i.title).join(",")}
      </div>
    ),
}));

import { Library } from "./Library";

// --- helpers ----------------------------------------------------------------

function preview(id: string, title: string): MediaPreview {
  return { id, type: "movie", title };
}

function folder(id: string, name: string, kind: LibraryFolderRecord["folderKind"] = "manual"): LibraryFolderRecord {
  return {
    id,
    name,
    parentId: null,
    listType: "favorites",
    folderKind: kind,
    isSystem: kind === "system_root",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function entry(id: string, folderId: string | null, p: MediaPreview): LibraryEntryRecord {
  return {
    id,
    mediaId: p.id,
    folderId,
    listType: "favorites",
    addedAt: "2026-01-01T00:00:00Z",
    customListName: null,
    releaseDateHint: null,
    renewalStatus: null,
    preview: p,
  };
}

beforeEach(() => {
  openDetail.mockClear();
  openBrowse.mockClear();
  navigate.mockClear();
  ensureSystemFolders.mockClear();
  createFolderFn.mockClear();
  saveFolderFn.mockClear();
  deleteFolderFn.mockClear();
  addToLibraryFn.mockClear();
  removeFromLibraryFn.mockClear();
  listRequested.mockClear();
  mockWatchlist = [];
  mockServerMode = false;
  mockWatchedIds = new Set<string>();
  listFoldersImpl = async () => [];
  listLibraryImpl = async () => [];
  listRequested.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Library - loading + empty", () => {
  it("shows a loading line first, then resolves", async () => {
    let resolve!: (v: LibraryEntryRecord[]) => void;
    const pending = new Promise<LibraryEntryRecord[]>((r) => (resolve = r));
    listLibraryImpl = () => pending;
    render(<Library />);
    expect(screen.getByText("Loading your library…")).toBeInTheDocument();
    resolve([]);
    await waitFor(() => {
      expect(screen.queryByText("Loading your library…")).not.toBeInTheDocument();
    });
  });

  it("renders the empty state with Browse + Search CTAs when nothing saved", async () => {
    render(<Library />);
    expect(await screen.findByText("Your library is empty")).toBeInTheDocument();

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

describe("Library - error", () => {
  it("renders the error empty-state with the failure note", async () => {
    listLibraryImpl = async () => {
      throw new Error("disk gone");
    };
    render(<Library />);
    expect(
      await screen.findByText("Couldn't load your library"),
    ).toBeInTheDocument();
    expect(screen.getByText("disk gone")).toBeInTheDocument();
  });
});

describe("Library - folders + grid filtering", () => {
  it("renders a chip per non-root folder and filters the grid by folder", async () => {
    mockWatchlist = [preview("w1", "Unrelated watchlist title")];
    listFoldersImpl = async () => [
      folder("__root__", "Root", "system_root"),
      folder("f-action", "Action"),
      folder("f-scifi", "Sci-Fi"),
    ];
    listLibraryImpl = async () => [
      entry("e1", "f-action", preview("m1", "Die Hard")),
      entry("e2", "f-scifi", preview("m2", "Blade Runner")),
    ];
    render(<Library />);

    // All saved shows both; root folder chip is filtered out.
    await screen.findByText("card:Die Hard");
    expect(screen.getByText("card:Blade Runner")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Root" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();

    // Selecting "Sci-Fi" narrows to that folder's entries.
    await userEvent.click(screen.getByRole("button", { name: "Sci-Fi" }));
    expect(screen.getByText("card:Blade Runner")).toBeInTheDocument();
    expect(screen.queryByText("card:Die Hard")).not.toBeInTheDocument();
    expect(
      screen.queryByText("card:Unrelated watchlist title"),
    ).not.toBeInTheDocument();
  });

  it("keeps a newly created empty folder empty instead of showing the watchlist", async () => {
    mockWatchlist = [preview("w1", "Tenet")];
    let created = false;
    listFoldersImpl = async () =>
      created
        ? [folder("__root__", "Root", "system_root"), folder("f-new", "iPad QA48")]
        : [folder("__root__", "Root", "system_root")];
    createFolderFn.mockImplementationOnce(async (name) => {
      created = true;
      return folder("f-new", String(name));
    });

    render(<Library />);
    expect(await screen.findByText("card:Tenet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new folder/i }));
    await userEvent.type(screen.getByPlaceholderText("Folder name"), "iPad QA48");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("This folder is empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Save titles to “iPad QA48”/),
    ).toBeInTheDocument();
    expect(screen.queryByText("card:Tenet")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View all saved" }));
    expect(await screen.findByText("card:Tenet")).toBeInTheDocument();
    expect(screen.getByText(/Showing your watchlist/i)).toBeInTheDocument();
  });

  it("keeps an empty folder empty when favorites are saved elsewhere", async () => {
    mockWatchlist = [preview("w1", "Unrelated watchlist title")];
    listFoldersImpl = async () => [
      folder("__root__", "Root", "system_root"),
      folder("f-action", "Action"),
      folder("f-empty", "Empty folder"),
    ];
    listLibraryImpl = async () => [
      entry("e1", "f-action", preview("m1", "Die Hard")),
    ];
    render(<Library />);
    await screen.findByText("card:Die Hard");

    await userEvent.click(screen.getByRole("button", { name: "Empty folder" }));
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    expect(screen.queryByText("card:Die Hard")).not.toBeInTheDocument();
    expect(
      screen.queryByText("card:Unrelated watchlist title"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View all saved" }));
    expect(screen.getByText("card:Die Hard")).toBeInTheDocument();
    expect(
      screen.queryByText("card:Unrelated watchlist title"),
    ).not.toBeInTheDocument();
  });

  it("clicking a grid card opens the detail", async () => {
    listLibraryImpl = async () => [entry("e1", null, preview("m1", "Heat"))];
    render(<Library />);
    await userEvent.click(await screen.findByText("card:Heat"));
    expect(openDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", title: "Heat" }),
    );
  });

  it("marks finished titles watched from the batched history lookup", async () => {
    listLibraryImpl = async () => [
      entry("e1", null, preview("m1", "Heat")),
      entry("e2", null, preview("m2", "Drive")),
    ];
    mockWatchedIds = new Set<string>(["m1"]);
    render(<Library />);
    expect(await screen.findByText("card:Heat")).toHaveAttribute(
      "data-watched",
      "yes",
    );
    expect(screen.getByText("card:Drive")).toHaveAttribute("data-watched", "no");
  });
});

describe("Library - watchlist fallback", () => {
  it("falls back to the watchlist with a hint when All saved has no favorites", async () => {
    mockWatchlist = [preview("w1", "Tenet")];
    render(<Library />);
    expect(await screen.findByText("card:Tenet")).toBeInTheDocument();
    expect(
      screen.getByText(/Showing your watchlist/i),
    ).toBeInTheDocument();
  });
});

describe("Library - requested rail (Server Mode)", () => {
  it("does not fetch or show the rail in local mode", async () => {
    mockServerMode = false;
    render(<Library />);
    await screen.findByText("Your library is empty");
    expect(listRequested).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rail")).not.toBeInTheDocument();
  });

  it("shows the requested rail in Server Mode", async () => {
    mockServerMode = true;
    listRequested.mockResolvedValue({
      items: [{ preview: preview("r1", "Dune") }],
    });
    render(<Library />);
    await waitFor(() => {
      expect(screen.getByTestId("rail")).toHaveTextContent("Dune");
    });
  });

  it("degrades silently to no rail when the requested fetch fails", async () => {
    mockServerMode = true;
    listRequested.mockRejectedValue(new Error("offline"));
    render(<Library />);
    await screen.findByText("Your library is empty");
    expect(screen.queryByTestId("rail")).not.toBeInTheDocument();
  });
});

describe("Library - folder management", () => {
  const withEntries = () => {
    listFoldersImpl = async () => [
      folder("__root__", "Root", "system_root"),
      folder("f-action", "Action"),
    ];
    listLibraryImpl = async () => [
      entry("e1", "__root__", preview("m1", "Heat")),
      entry("e2", "f-action", preview("m2", "Die Hard")),
    ];
  };

  it("creates a folder from the inline creator", async () => {
    withEntries();
    render(<Library />);
    await screen.findByText("card:Heat");
    await userEvent.click(screen.getByRole("button", { name: /new folder/i }));
    await userEvent.type(screen.getByPlaceholderText("Folder name"), "Comedy");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(createFolderFn).toHaveBeenCalledWith("Comedy", "favorites", null),
    );
  });

  it("renames the selected folder", async () => {
    withEntries();
    render(<Library />);
    await userEvent.click(await screen.findByRole("button", { name: "Action" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("Action");
    await userEvent.clear(input);
    await userEvent.type(input, "Thrillers");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveFolderFn).toHaveBeenCalled());
    expect(saveFolderFn.mock.calls[0][0]).toMatchObject({
      id: "f-action",
      name: "Thrillers",
    });
  });

  it("deletes the selected folder after confirmation", async () => {
    withEntries();
    render(<Library />);
    await userEvent.click(await screen.findByRole("button", { name: "Action" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    // A confirm step appears before the destructive call.
    expect(deleteFolderFn).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /confirm delete folder/i }),
    );
    await waitFor(() => expect(deleteFolderFn).toHaveBeenCalledWith("f-action"));
  });

  it("moves a title to another folder in Organize mode", async () => {
    withEntries();
    render(<Library />);
    await screen.findByText("card:Heat");
    await userEvent.click(screen.getByRole("button", { name: /organize/i }));
    // Heat lives in root → move it into the Action folder.
    const selects = await screen.findAllByRole("combobox");
    await userEvent.selectOptions(selects[0], "f-action");
    await waitFor(() => expect(addToLibraryFn).toHaveBeenCalled());
    expect(addToLibraryFn.mock.calls[0][0]).toMatchObject({
      mediaId: "m1",
      folderId: "f-action",
      listType: "favorites",
    });
    // The source row is dropped so it's a move, not a copy.
    expect(removeFromLibraryFn).toHaveBeenCalledWith("e1");
  });

  it("removes a title from the library in Organize mode", async () => {
    withEntries();
    render(<Library />);
    await screen.findByText("card:Heat");
    await userEvent.click(screen.getByRole("button", { name: /organize/i }));
    const removeButtons = await screen.findAllByRole("button", { name: /remove/i });
    await userEvent.click(removeButtons[0]);
    await waitFor(() => expect(removeFromLibraryFn).toHaveBeenCalledWith("e1"));
  });
});
