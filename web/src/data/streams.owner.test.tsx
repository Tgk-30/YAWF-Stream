// @vitest-environment jsdom

import { useEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IndexerManager } from "../services/indexers/IndexerManager";
import { TorrentResult } from "../services/indexers/models";

vi.mock("../lib/serverMode", () => ({
  configuredServerURL: () => null,
}));

import { useStreams } from "./streams";

function result(hash: string, title: string) {
  return TorrentResult.fromSearch({
    infoHash: hash,
    title,
    sizeBytes: 1_000,
    seeders: 1,
    leechers: 0,
    indexerName: "test",
  });
}

describe("useStreams query ownership", () => {
  it("never exposes or resolves S16 rows during a deferred S17 query", async () => {
    let resolveS17: ((rows: TorrentResult[]) => void) | null = null;
    const oldRow = result("OLD-S16", "Bleach S16E24");
    const childRow = result("CHILD-S1", "Bleach TYBW S01E01");
    const searchAll = vi.fn(
      async (_imdbId: string, _type: string, season: number | null) => {
        if (season === 16) return [oldRow];
        return await new Promise<TorrentResult[]>((resolve) => {
          resolveS17 = resolve;
        });
      },
    );
    const indexers = {
      activeIndexers: ["test"],
      lastSearchErrors: [],
      searchAll,
      fork: () => indexers,
    } as unknown as IndexerManager;
    const resolved = vi.fn();

    const hook = renderHook(
      ({ imdbId, season, episode, autoPlay }) => {
        const streams = useStreams(
          imdbId,
          "series",
          season,
          episode,
          null,
          null,
          indexers,
          null,
        );
        useEffect(() => {
          if (autoPlay && !streams.loading && streams.rows[0] != null) {
            resolved(streams.rows[0].result.infoHash);
          }
        }, [autoPlay, streams.loading, streams.rows]);
        return streams;
      },
      {
        initialProps: {
          imdbId: "tt0434665",
          season: 16,
          episode: 24,
          autoPlay: false,
        },
      },
    );

    await waitFor(() => expect(hook.result.current.rows[0]?.result.infoHash).toBe("old-s16"));
    hook.rerender({
      imdbId: "tt14986406",
      season: 1,
      episode: 1,
      autoPlay: true,
    });

    expect(hook.result.current).toMatchObject({ rows: [], loading: true });
    expect(resolved).not.toHaveBeenCalled();

    await act(async () => {
      resolveS17?.([childRow]);
    });
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("child-s1"));
    expect(resolved).not.toHaveBeenCalledWith("old-s16");
  });
});
