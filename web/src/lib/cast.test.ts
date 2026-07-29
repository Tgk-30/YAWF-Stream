// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  castController,
  CastController,
  useCastState,
  type CastBridge,
  type CastPollEnvironment,
} from "./cast";
import type { CastAction, CastDevice, CastStatus } from "./tauri";

const device: CastDevice = {
  id: "uuid:tv-1",
  name: "Living Room TV",
  avControlUrl: "http://10.0.0.10/av",
  renderingControlUrl: "http://10.0.0.10/volume",
  location: "http://10.0.0.10/device.xml",
};

function setup() {
  let hidden = false;
  let parked = false;
  let environmentListener = () => {};
  let intervalCallback = () => {};
  const setIntervalMock = vi.fn((callback: () => void) => {
    intervalCallback = callback;
    return 7 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalMock = vi.fn();
  const environment: CastPollEnvironment = {
    hidden: () => hidden,
    parked: () => parked,
    subscribe: (listener) => {
      environmentListener = listener;
      return vi.fn(() => {
        environmentListener = () => {};
      });
    },
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock,
  };
  const statusValues: CastStatus[] = [
    { state: "PLAYING", positionSecs: 8, durationSecs: 120 },
    { state: "PLAYING", positionSecs: 10, durationSecs: 120 },
  ];
  const bridge: CastBridge = {
    discover: vi.fn(async () => [device]),
    load: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    status: vi.fn(async () => statusValues.shift() ?? {
      state: "PLAYING",
      positionSecs: 10,
      durationSecs: 120,
    }),
    setVolume: vi.fn(async () => {}),
  };
  const controller = new CastController(bridge, environment, 50);
  return {
    bridge,
    controller,
    setIntervalMock,
    clearIntervalMock,
    runInterval: () => intervalCallback(),
    setHidden: (value: boolean) => {
      hidden = value;
      environmentListener();
    },
    setParked: (value: boolean) => {
      parked = value;
      environmentListener();
    },
  };
}

const mockAttention = vi.hoisted(() => ({
  parked: false,
  listener: null as (() => void) | null,
}));

// The native module is typed exactly like `./tauri` so the mock keeps the real
// call signatures under vitest 4's single-signature `vi.fn<Fn>()` generic.
const mockNativeBridge = vi.hoisted(() => ({
  discover: vi.fn<(timeoutMs?: number) => Promise<CastDevice[]>>(async () => [
    device,
  ]),
  load: vi.fn<
    (
      device: CastDevice,
      url: string,
      title: string,
      subtitleUrl?: string | null,
    ) => Promise<void>
  >(async () => {}),
  control: vi.fn<
    (
      device: CastDevice,
      action: CastAction,
      positionSecs?: number | null,
    ) => Promise<void>
  >(async () => {}),
  status: vi.fn<(device: CastDevice) => Promise<CastStatus>>(async () => ({
    state: "PLAYING" as const,
    positionSecs: 10,
    durationSecs: 120,
  })),
  setVolume: vi.fn<(device: CastDevice, level: number) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock("./attention", () => ({
  getAttentionParked: () => mockAttention.parked,
  subscribeAttention: (listener: () => void) => {
    mockAttention.listener = listener;
    return () => {
      mockAttention.listener = null;
    };
  },
}));

vi.mock("./tauri", () => ({
  castDiscover: mockNativeBridge.discover,
  castLoad: mockNativeBridge.load,
  castControl: mockNativeBridge.control,
  castStatus: mockNativeBridge.status,
  castSetVolume: mockNativeBridge.setVolume,
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CastController", () => {
  it("runs discover, pick, load, status poll, controls, and stop", async () => {
    const context = setup();
    const { bridge, controller } = context;

    await controller.discover();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "selecting",
      devices: [device],
    });

    await controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
      subtitleUrl: "https://cdn.example/movie.srt",
    });
    await flush();
    expect(bridge.load).toHaveBeenCalledWith(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
      subtitleUrl: "https://cdn.example/movie.srt",
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "casting",
      device,
      status: { positionSecs: 8 },
    });
    expect(context.setIntervalMock).toHaveBeenCalledWith(
      expect.any(Function),
      50,
    );

    context.runInterval();
    await flush();
    expect(controller.getSnapshot().status?.positionSecs).toBe(10);

    await controller.control("pause");
    await controller.control("seek", 42);
    await controller.setVolume(73);
    expect(bridge.control).toHaveBeenCalledWith(device, "pause", undefined);
    expect(bridge.control).toHaveBeenCalledWith(device, "seek", 42);
    expect(bridge.setVolume).toHaveBeenCalledWith(device, 73);

    await controller.stop();
    expect(bridge.control).toHaveBeenCalledWith(device, "stop");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(context.clearIntervalMock).toHaveBeenCalled();
    controller.dispose();
  });

  it("clears polling while hidden or attention-parked and restarts when active", async () => {
    const context = setup();
    await context.controller.discover();
    await context.controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });
    await flush();
    const callsWhileVisible = vi.mocked(context.bridge.status).mock.calls.length;

    context.setHidden(true);
    expect(context.clearIntervalMock).toHaveBeenCalledTimes(1);
    context.runInterval();
    await flush();
    expect(context.bridge.status).toHaveBeenCalledTimes(callsWhileVisible);

    context.setHidden(false);
    await flush();
    expect(context.bridge.status).toHaveBeenCalledTimes(callsWhileVisible + 1);
    context.setParked(true);
    expect(context.clearIntervalMock).toHaveBeenCalledTimes(2);
    context.controller.dispose();
  });

  it("supports subscribe and unsubscribe from cast state updates", async () => {
    const context = setup();
    const unsubscribe = context.controller.subscribe(vi.fn());

    await context.controller.discover();
    unsubscribe();
    expect(context.controller.getSnapshot().phase).toBe("selecting");
    context.controller.dispose();
  });

  it("dismisses picker when not already loading or casting", async () => {
    const context = setup();
    await context.controller.discover();

    expect(context.controller.getSnapshot().phase).toBe("selecting");
    context.controller.dismissPicker();
    expect(context.controller.getSnapshot()).toMatchObject({ phase: "idle" });

    context.controller.dispose();
  });

  it("uses default environment and native bridge when constructed without injection", async () => {
    const removeInterval = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => {});
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    // A throwing default keeps the "an interval callback was registered"
    // expectation while staying callable for TypeScript's flow analysis.
    let pollCallback: () => void = (): void => {
      throw new Error("cast poller never registered an interval callback");
    };
    const interval = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback) => {
        pollCallback = callback as () => void;
        return 99 as unknown as ReturnType<typeof setInterval>;
      });

    mockNativeBridge.discover.mockResolvedValue([device]);
    const controller = new CastController();

    await controller.discover();
    await controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });

    expect(mockNativeBridge.discover).toHaveBeenCalledWith(2500);
    expect(mockNativeBridge.load).toHaveBeenCalledWith(device, "https://cdn.example/movie.mkv", "Movie", undefined);
    expect(addListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(interval).toHaveBeenCalled();
    pollCallback();
    await flushMicrotasks();
    expect(mockNativeBridge.status).toHaveBeenCalled();

    mockAttention.parked = true;
    mockAttention.listener?.();
    expect(removeInterval).toHaveBeenCalled();

    mockAttention.parked = false;
    mockAttention.listener?.();
    expect(interval).toHaveBeenCalledTimes(2);

    await controller.stop();
    expect(mockNativeBridge.control).toHaveBeenCalledWith(device, "stop", undefined);

    controller.dispose();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    interval.mockRestore();
    removeInterval.mockRestore();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("surfaces bridge errors for discover, load, control, and setVolume", async () => {
    const controller = new CastController();
    mockNativeBridge.discover.mockRejectedValueOnce(new Error("discover failed"));

    await controller.discover();
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "discover failed" });

    mockNativeBridge.discover.mockResolvedValue([device]);
    mockNativeBridge.load.mockRejectedValueOnce(new Error("load failed"));
    await controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "load failed" });

    mockNativeBridge.load.mockResolvedValue();
    mockNativeBridge.control
      .mockRejectedValueOnce(new Error("control failed"));
    mockNativeBridge.setVolume.mockRejectedValueOnce(new Error("volume failed"));

    await controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });
    await flush();

    await controller.setVolume(145);
    expect(mockNativeBridge.setVolume).toHaveBeenLastCalledWith(device, 100);
    expect(controller.getSnapshot().error).toBe("volume failed");

    await controller.control("pause");
    expect(mockNativeBridge.control).toHaveBeenCalledWith(device, "pause", undefined);
    expect(controller.getSnapshot().error).toBe("control failed");
    controller.dispose();
  });

  it("surfaces status polling errors", async () => {
    const context = setup();
    context.bridge.status = vi.fn(async () => {
      throw new Error("status failed");
    });

    await context.controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });
    await flush();

    context.runInterval();
    await flushMicrotasks();
    expect(context.controller.getSnapshot().error).toBe("status failed");
    context.controller.dispose();
  });

  it("does not clear state while loading when dismissPicker is called", async () => {
    let release: () => void = (): void => {
      throw new Error("pending load promise never exposed its resolver");
    };
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockNativeBridge.load.mockImplementationOnce(async () => pending);

    const controller = new CastController();
    const loading = controller.load(device, {
      url: "https://cdn.example/movie.mkv",
      title: "Movie",
    });

    await flush();
    expect(controller.getSnapshot().phase).toBe("loading");
    controller.dismissPicker();
    expect(controller.getSnapshot().phase).toBe("loading");

    release();
    await loading;
    controller.dispose();
  });

  it("normalizes volume values and exits cleanly when no casting target exists", async () => {
    const controller = new CastController();
    await controller.setVolume(25);
    await controller.control("pause");
    expect(controller.getSnapshot().phase).toBe("idle");

    await controller.stop();
    expect(controller.getSnapshot().phase).toBe("idle");
    controller.dispose();
  });

  it("notifies hook consumers through useSyncExternalStore", async () => {
    castController.dispose();
    const hook = renderHook(() => useCastState());
    await act(async () => {
      await castController.discover();
      await castController.load(device, {
        url: "https://cdn.example/movie.mkv",
        title: "Movie",
      });
    });

    await act(async () => {
      await castController.stop();
    });

    expect(hook.result.current.phase).toBe("idle");
    hook.unmount();
  });
});
