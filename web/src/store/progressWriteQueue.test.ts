import { describe, expect, it, vi } from "vitest";
import { ProgressWriteQueue } from "./progressWriteQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ProgressWriteQueue", () => {
  it("serializes writes and coalesces hundreds of ticks to the newest snapshot", async () => {
    const queue = new ProgressWriteQueue();
    const store = {};
    const first = deferred();
    const persisted: number[] = [];
    const write = (progress: number) => queue.enqueue({
      store,
      generation: 1,
      mediaId: "movie",
      episodeId: null,
      write: async () => {
        if (progress === 1) await first.promise;
        persisted.push(progress);
      },
    });

    write(1);
    for (let progress = 2; progress <= 500; progress += 1) write(progress);
    const flush = queue.flush();
    expect(persisted).toEqual([]);
    first.resolve();
    await flush;
    expect(persisted).toEqual([1, 500]);
  });

  it("isolates store/profile/media/episode keys and cancels old-profile work", async () => {
    const queue = new ProgressWriteQueue();
    const oldStore = {};
    const newStore = {};
    const oldDone = deferred();
    const oldSignal = vi.fn();
    const writes: string[] = [];
    queue.enqueue({
      store: oldStore, generation: 7, mediaId: "same", episodeId: "e1",
      write: (signal) => {
        signal.addEventListener("abort", oldSignal);
        return oldDone.promise;
      },
    });
    queue.enqueue({
      store: oldStore, generation: 7, mediaId: "same", episodeId: "e2",
      write: async () => { writes.push("old-pending"); },
    });
    queue.cancelGeneration(7);
    queue.enqueue({
      store: newStore, generation: 8, mediaId: "same", episodeId: "e1",
      write: async () => { writes.push("new"); },
    });
    expect(oldSignal).toHaveBeenCalledTimes(1);
    oldDone.resolve();
    await queue.flush();
    expect(writes).toEqual(["new"]);
  });

  it("continues after best-effort write rejection", async () => {
    const queue = new ProgressWriteQueue();
    const store = {};
    const writes: number[] = [];
    for (const progress of [1, 2]) {
      queue.enqueue({
        store, generation: 1, mediaId: "movie", episodeId: null,
        write: async () => {
          writes.push(progress);
          if (progress === 1) throw new Error("offline");
        },
      });
    }
    await queue.flush();
    expect(writes).toEqual([1, 2]);
  });

  it("bounds both pending distinct identities and concurrent writes", async () => {
    const queue = new ProgressWriteQueue();
    const store = {};
    const first = deferred();
    let active = 0;
    let maxActive = 0;
    const written: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      queue.enqueue({
        store, generation: 1, mediaId: `movie-${index}`, episodeId: null,
        write: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (index === 0) await first.promise;
          written.push(`movie-${index}`);
          active -= 1;
        },
      });
    }
    const flush = queue.flush();
    first.resolve();
    await flush;
    expect(maxActive).toBe(1);
    expect(written.length).toBeLessThanOrEqual(65);
    expect(written.at(-1)).toBe("movie-499");
  });
});
