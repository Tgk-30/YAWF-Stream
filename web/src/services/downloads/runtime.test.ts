import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../../storage/types";

const createdManagers: {
  store: unknown;
  debrid: unknown;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock("./DownloadManager", () => {
  return {
    DownloadManager: class {
      start = vi.fn(() => Promise.resolve());
      stop = vi.fn(() => undefined);

      constructor(public store: unknown, public debrid: unknown) {
        createdManagers.push(this as never);
      }
    },
  };
});

import {
  startDownloadsRuntime,
  stopDownloadsRuntime,
} from "./runtime";

// The runtime only compares store identity, so a labelled stand-in is enough.
function createStore(label: string): Store {
  return { label } as unknown as Store;
}

beforeEach(() => {
  // Keep each test independent while the runtime singleton remains in memory.
  for (const manager of createdManagers) {
    stopDownloadsRuntime(manager as never);
  }
  createdManagers.length = 0;
});

afterEach(() => {
  for (const manager of createdManagers) {
    stopDownloadsRuntime(manager as never);
  }
  createdManagers.length = 0;
});

describe("startDownloadsRuntime", () => {
  it("creates a manager and calls start for a new store", () => {
    const manager = startDownloadsRuntime(createStore("A"), null);

    expect(createdManagers).toHaveLength(1);
    expect(manager).toBe(createdManagers[0]);
    expect(createdManagers[0].start).toHaveBeenCalledTimes(1);
  });

  it("reuses the same manager when store and debrid resolver are unchanged", () => {
    const sharedStore = createStore("A");
    const managerA = startDownloadsRuntime(sharedStore, null);
    const managerB = startDownloadsRuntime(sharedStore, null);

    expect(managerB).toBe(managerA);
    expect(createdManagers).toHaveLength(1);
    expect(createdManagers[0].start).toHaveBeenCalledTimes(2);
  });

  it("recreates manager and stops previous when store changes", () => {
    const managerA = startDownloadsRuntime(createStore("A"), null);
    const managerB = startDownloadsRuntime(createStore("B"), null);

    expect(createdManagers).toHaveLength(2);
    expect(managerB).toBe(createdManagers[1]);
    expect(managerA).not.toBe(managerB);
    expect(managerA.stop).toHaveBeenCalledTimes(1);
    expect(managerB.start).toHaveBeenCalledTimes(1);
  });
});

describe("stopDownloadsRuntime", () => {
  it("only stops the active manager instance", () => {
    const managerA = startDownloadsRuntime(createStore("A"), null);
    const ignored = {
      start: vi.fn(),
      stop: vi.fn(),
    };

    stopDownloadsRuntime(ignored as never);
    expect(ignored.stop).not.toHaveBeenCalled();

    stopDownloadsRuntime(managerA);
    expect(managerA.stop).toHaveBeenCalledTimes(1);

    stopDownloadsRuntime(managerA);
    expect(managerA.stop).toHaveBeenCalledTimes(1);
  });
});
