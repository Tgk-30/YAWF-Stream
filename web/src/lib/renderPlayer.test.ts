import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const listenMock = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { createRenderPlayerSession } from "./renderPlayer";
import { getPlayerMounted, tryAcquireUpdateInstallation } from "./attention";
let testSession = createRenderPlayerSession();
const init = (config: Parameters<ReturnType<typeof createRenderPlayerSession>["init"]>[0]) => { testSession = createRenderPlayerSession(); return testSession.init(config); };
const destroy = () => testSession.destroy();
const setVideoMarginRatio = (margin: { bottom?: number }) => testSession.setVideoMarginRatio(margin);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(async () => { await testSession.destroy().catch(() => {}); });

describe("setVideoMarginRatio", () => {
  it("coalesces duplicate native geometry updates and resets between sessions", async () => {
    await init({});
    invokeMock.mockClear();

    await setVideoMarginRatio({ bottom: 0.25 });
    await setVideoMarginRatio({ bottom: 0.25 });
    await setVideoMarginRatio({ bottom: 0.5 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "player_set_video_margin", { bottom: 0.25 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "player_set_video_margin", { bottom: 0.5 });

    await destroy();
    await init({});
    invokeMock.mockClear();
    await setVideoMarginRatio({ bottom: 0.5 });
    expect(invokeMock).toHaveBeenCalledWith("player_set_video_margin", { bottom: 0.5 });
  });

  it("allows a retry when the native bridge rejects a geometry update", async () => {
    await init({});
    invokeMock.mockClear();
    invokeMock.mockRejectedValueOnce(new Error("surface unavailable"));
    await expect(setVideoMarginRatio({ bottom: 0.25 })).rejects.toThrow("surface unavailable");
    invokeMock.mockResolvedValue(undefined);

    await setVideoMarginRatio({ bottom: 0.25 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("player lifecycle queue", () => {
  it("preserves init, destroy, init ordering across deferred native commands", async () => {
    let resolveFirstInit: (() => void) | undefined;
    let resolveDestroy: (() => void) | undefined;
    invokeMock
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveFirstInit = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveDestroy = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);

    const firstInit = init({});
    await Promise.resolve(); // The native init has actually been issued.
    const firstDestroy = destroy();
    const secondInit = init({});
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith("player_init", {
      options: {},
      observed: [],
    });

    resolveFirstInit?.();
    await firstInit;
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenLastCalledWith("player_destroy");

    resolveDestroy?.();
    await firstDestroy;
    await secondInit;
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith("player_init", {
      options: {},
      observed: [],
    });
  });

  it("continues with later lifecycle operations after an earlier failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("init failed"));
    await expect(init({})).rejects.toThrow("init failed");
    await destroy();
    expect(invokeMock).toHaveBeenLastCalledWith("player_destroy");
  });
});

function deferredRender<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve };
}
async function renderTick() { for (let i = 0; i < 15; i += 1) await Promise.resolve(); }
describe("owned render reader drain", () => {
  it("holds admission through pending init and exact destroy after cancellation", async () => {
    const ready = deferredRender<void>(); const stopped = deferredRender<void>();
    invokeMock.mockImplementation((command: string) => command === "player_init" ? ready.promise : stopped.promise);
    const session = createRenderPlayerSession(); const setup = vi.fn(async () => {}); const initialized = session.init({}, setup);
    await renderTick(); expect(invokeMock).toHaveBeenCalledWith("player_init", { options: {}, observed: [] });
    const destroyed = session.destroy(); expect(getPlayerMounted()).toBe(true); expect(tryAcquireUpdateInstallation()).toBeNull();
    ready.resolve(); await initialized; await renderTick();
    expect(setup).not.toHaveBeenCalled(); expect(invokeMock).toHaveBeenCalledWith("player_destroy"); expect(getPlayerMounted()).toBe(true);
    stopped.resolve(); await destroyed; expect(getPlayerMounted()).toBe(false);
  });
  it("serializes pending setup and destroy before admitting a successor owner", async () => {
    const loaded = deferredRender<void>(); const destroyed = deferredRender<void>();
    invokeMock.mockImplementation((command: string) => command === "player_command" ? loaded.promise : command === "player_destroy" ? destroyed.promise : Promise.resolve());
    const old = createRenderPlayerSession(); const next = createRenderPlayerSession();
    const initialized = old.init({}, async () => { await old.command("loadfile", ["https://x/old.mkv"]); });
    await renderTick(); const close = old.destroy(); const successor = next.init({}); await renderTick();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["player_init", "player_command"]);
    loaded.resolve(); await initialized; await renderTick();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["player_init", "player_command", "player_destroy"]);
    expect(getPlayerMounted()).toBe(true); destroyed.resolve(); await close; await successor;
    invokeMock.mockClear(); await old.destroy(); expect(invokeMock).not.toHaveBeenCalled();
    await next.destroy(); expect(getPlayerMounted()).toBe(false);
  });
  it("drains issued commands before destroying and rejects late commands from that owner", async () => {
    const session = createRenderPlayerSession(); await session.init({});
    const command = deferredRender<void>(); invokeMock.mockReturnValueOnce(command.promise);
    const pending = session.command("seek", [30, "absolute"]); const close = session.destroy(); await renderTick();
    expect(invokeMock).not.toHaveBeenCalledWith("player_destroy"); expect(tryAcquireUpdateInstallation()).toBeNull();
    await expect(session.command("seek", [0, "absolute"])).rejects.toThrow("closed");
    command.resolve(); await pending; await close; expect(getPlayerMounted()).toBe(false);
  });
  it("does not let stale destroy or property writes affect a successor renderer", async () => {
    const old = createRenderPlayerSession(); const next = createRenderPlayerSession();
    await old.init({}); await next.init({}); invokeMock.mockClear();
    await old.destroy(); await expect(old.setProperty("pause", true)).rejects.toThrow("closed");
    expect(invokeMock).not.toHaveBeenCalled(); expect(getPlayerMounted()).toBe(true);
    await next.destroy(); expect(getPlayerMounted()).toBe(false);
  });
  it("retains unknown-live render work when destroy fails until exact retry acknowledges", async () => {
    const session = createRenderPlayerSession(); await session.init({}); invokeMock.mockRejectedValueOnce(new Error("Destroy acknowledgement lost"));
    await expect(session.destroy()).rejects.toThrow("acknowledgement lost");
    expect(getPlayerMounted()).toBe(true); expect(tryAcquireUpdateInstallation()).toBeNull();
    await session.destroy(); expect(getPlayerMounted()).toBe(false);
  });
});
