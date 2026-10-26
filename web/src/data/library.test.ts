// Unit tests for the watchlist/history helpers that delegate to the storage
// port. recordHistory's resume-preservation is covered separately in
// library.recordHistory.test.ts; this file pins the load/toggle/remove paths.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaPreview } from "../models/media";

const { store, calls, historyWrites } = vi.hoisted(() => {
  const calls: string[] = [];
  const historyWrites: Array<Record<string, unknown>> = [];
  const watchlistIds = new Set<string>();
  return {
    calls,
    store: {
      watchlistIds,
      async listWatchlist() {
        calls.push("listWatchlist");
        return [...watchlistIds].map((id) => ({
          preview: { id, type: "movie", title: id },
        }));
      },
      async listHistory(limit?: number) {
        calls.push(`listHistory:${limit ?? "default"}`);
        return [{ preview: { id: "h1", type: "movie", title: "Hist" } }];
      },
      async continueWatching(limit?: number) {
        calls.push(`continueWatching:${limit ?? "default"}`);
        return [{ mediaId: "cw1", progressSeconds: 60, durationSeconds: 600 }];
      },
      async isInWatchlist(id: string) {
        return watchlistIds.has(id);
      },
      async addToWatchlist(item: MediaPreview) {
        calls.push(`add:${item.id}`);
        watchlistIds.add(item.id);
      },
      async removeFromWatchlist(id: string) {
        calls.push(`remove:${id}`);
        watchlistIds.delete(id);
      },
      async getResume() {
        return null;
      },
      async recordHistory(entry: Record<string, unknown>) {
        historyWrites.push(entry);
        return entry;
      },
    },
    historyWrites,
  };
});

vi.mock("../storage", () => ({ getStore: () => store }));

const {
  isInWatchlist,
  loadWatchlist,
  loadHistory,
  loadContinueWatching,
  recordHistory,
  toggleWatchlist,
  removeFromWatchlist,
} = await import("./library");

function movie(id: string): MediaPreview {
  return { id, type: "movie", title: id };
}

afterEach(() => {
  store.watchlistIds.clear();
  calls.length = 0;
  historyWrites.length = 0;
});

describe("isInWatchlist (pure)", () => {
  it("is true only when the id is present", () => {
    const items = [movie("a"), movie("b")];
    expect(isInWatchlist(items, "b")).toBe(true);
    expect(isInWatchlist(items, "z")).toBe(false);
    expect(isInWatchlist([], "a")).toBe(false);
  });
});

describe("loadWatchlist / loadHistory", () => {
  it("maps stored rows down to their preview", async () => {
    store.watchlistIds.add("w1");
    store.watchlistIds.add("w2");
    const wl = await loadWatchlist();
    expect(wl.map((p) => p.id).sort()).toEqual(["w1", "w2"]);
    expect(calls).toContain("listWatchlist");

    const hist = await loadHistory();
    expect(hist).toEqual([{ id: "h1", type: "movie", title: "Hist" }]);
    expect(calls).toContain("listHistory:100");
  });
});

describe("loadContinueWatching", () => {
  it("returns the store's continue-watching rows verbatim", async () => {
    const rows = await loadContinueWatching();
    expect(rows).toHaveLength(1);
    expect(rows[0].mediaId).toBe("cw1");
    expect(calls).toContain("continueWatching:20");
  });
});

describe("recordHistory", () => {
  it("forwards all six playback preferences to the active store", async () => {
    await recordHistory(movie("prefs"), {
      progressSeconds: 10,
      preferredAudioId: "audio-jpn",
      preferredAudioLang: "jpn",
      preferredSubId: "sub-eng",
      playbackSpeed: 1.5,
      subtitleDelay: -0.4,
      subtitlePosition: 82,
    });

    expect(historyWrites).toContainEqual(expect.objectContaining({
      preferredAudioId: "audio-jpn",
      preferredAudioLang: "jpn",
      preferredSubId: "sub-eng",
      playbackSpeed: 1.5,
      subtitleDelay: -0.4,
      subtitlePosition: 82,
    }));
  });
});

describe("toggleWatchlist", () => {
  it("adds when absent and returns the refreshed list", async () => {
    const list = await toggleWatchlist(movie("x"));
    expect(calls).toContain("add:x");
    expect(list.map((p) => p.id)).toContain("x");
  });

  it("removes when already present", async () => {
    store.watchlistIds.add("x");
    const list = await toggleWatchlist(movie("x"));
    expect(calls).toContain("remove:x");
    expect(list.map((p) => p.id)).not.toContain("x");
  });
});

describe("removeFromWatchlist", () => {
  it("removes by id and returns the refreshed list", async () => {
    store.watchlistIds.add("x");
    store.watchlistIds.add("y");
    const list = await removeFromWatchlist("x");
    expect(calls).toContain("remove:x");
    expect(list.map((p) => p.id)).toEqual(["y"]);
  });
});
