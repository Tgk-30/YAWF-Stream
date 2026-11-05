// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CastDevice } from "../lib/tauri";
import type { CastState } from "../lib/cast";

const discover = vi.fn();
const load = vi.fn();
const control = vi.fn();
const setVolume = vi.fn();
const stop = vi.fn();
const dismissPicker = vi.fn();
const isTauri = vi.fn(() => true);

let castState: CastState = {
  phase: "idle",
  devices: [],
  device: null,
  status: null,
  volume: 50,
  error: null,
};

vi.mock("../lib/cast", () => ({
  castController: {
    discover: (...args: unknown[]) => discover(...args),
    load: (...args: unknown[]) => load(...args),
    control: (...args: unknown[]) => control(...args),
    setVolume: (...args: unknown[]) => setVolume(...args),
    stop: (...args: unknown[]) => stop(...args),
    dismissPicker: (...args: unknown[]) => dismissPicker(...args),
  },
  useCastState: () => castState,
}));

vi.mock("../lib/tauri", () => ({
  isTauri: () => isTauri(),
}));

import { CastControls, CastDevicePicker } from "./CastControls";

const devices: CastDevice[] = [
  {
    id: "uuid:living-room",
    name: "Living Room TV",
    avControlUrl: "http://10.0.0.10/av",
    renderingControlUrl: "http://10.0.0.10/volume",
    location: "http://10.0.0.10/device.xml",
  },
  {
    id: "uuid:bedroom",
    name: "Bedroom Kodi",
    avControlUrl: "http://10.0.0.11/av",
    renderingControlUrl: null,
    location: "http://10.0.0.11/device.xml",
  },
];

function resetState(override: Partial<CastState> = {}) {
  castState = {
    phase: "idle",
    devices: [],
    device: null,
    status: null,
    volume: 50,
    error: null,
    ...override,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauri.mockReturnValue(true);
  resetState();
  discover.mockResolvedValue(undefined);
  load.mockResolvedValue(undefined);
  control.mockResolvedValue(undefined);
  setVolume.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  dismissPicker.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const media = { url: "https://cdn.example/movie.mkv", title: "Movie" };

describe("CastDevicePicker", () => {
  it("lists discovered devices and selects the chosen renderer", () => {
    render(
      <CastDevicePicker
        phase="selecting"
        devices={devices}
        device={null}
        error={null}
        onSelect={() => {}}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("Bedroom Kodi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Bedroom Kodi/ }));
    expect(load).not.toHaveBeenCalled();
  });

  it("shows the empty state and retries discovery", async () => {
    const onRetry = vi.fn();
    render(
      <CastDevicePicker
        phase="selecting"
        devices={[]}
        device={null}
        error={null}
        onSelect={() => {}}
        onRetry={onRetry}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText("No cast devices found on your network"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows discovery and loading states without allowing manual close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <CastDevicePicker
        phase="discovering"
        devices={[]}
        device={null}
        error={null}
        onSelect={() => {}}
        onRetry={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Searching your network for TVs and media renderers...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close cast device picker" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    rerender(
      <CastDevicePicker
        phase="loading"
        devices={[]}
        device={devices[0]}
        error={null}
        onSelect={() => {}}
        onRetry={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Connecting to Living Room TV...")).toBeInTheDocument();

    rerender(
      <CastDevicePicker
        phase="error"
        devices={[]}
        device={null}
        error="Could not connect"
        onSelect={() => {}}
        onRetry={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not connect");
  });
});

describe("CastControls", () => {
  it("starts discovery from idle state and reports local playback state", async () => {
    const onLocalPlaybackChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={onLocalPlaybackChange}
      />,
    );

    const button = screen.getByRole("button", { name: "Cast to a device" });
    await user.click(button);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(false);

    resetState({
      phase: "loading",
    });
    rerender(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={onLocalPlaybackChange}
      />,
    );
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(true);

    rerender(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={onLocalPlaybackChange}
      />,
    );
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(true);
  });

  it("opens a picker in selecting mode and forwards load/retry/dismiss actions", async () => {
    const user = userEvent.setup();
    resetState({
      phase: "selecting",
      devices,
      error: "network",
    });

    render(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={() => {}}
      />,
    );

    const castButton = screen.getByRole("button", { name: "Cast to a device" });
    expect(castButton).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bedroom Kodi" }));
    expect(load).toHaveBeenCalledWith(devices[1], media);

    await user.click(screen.getByRole("button", { name: "Close cast device picker" }));
    expect(dismissPicker).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Cast to a device" }));
    expect(discover).toHaveBeenCalledTimes(0);
  });

  it("drives casting controls and volume slider for a live cast", async () => {
    const user = userEvent.setup();
    resetState({
      phase: "casting",
      device: devices[0],
      status: { state: "PLAYING", positionSecs: 3723, durationSecs: 7200 },
      volume: 35,
      error: null,
    });

    render(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Casting to Living Room TV/ })).toBeInTheDocument();
    const pause = screen.getByRole("button", { name: "Pause cast" });
    await user.click(pause);
    expect(control).toHaveBeenCalledWith("pause");

    const seek = screen.getByRole("slider", { name: "Cast position" });
    await user.click(seek);
    fireEvent.change(seek, { target: { value: "30" } });
    expect(control).toHaveBeenCalledWith("seek", 30);

    const volume = screen.getByRole("slider", { name: "Cast volume" });
    fireEvent.change(volume, { target: { value: "80" } });
    expect(setVolume).toHaveBeenCalledWith(80);

    expect(screen.getByText("1:02:03")).toBeInTheDocument();
    expect(screen.getByText("2:00:00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop casting" }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("renders a play button and inline error when casting is paused", () => {
    resetState({
      phase: "casting",
      device: {
        ...devices[1],
        renderingControlUrl: null,
      },
      status: { state: "PAUSED_PLAYBACK", positionSecs: 13, durationSecs: 44 },
      volume: 50,
      error: "cast connection lost",
    });

    render(
      <CastControls
        media={media}
        buttonClassName="cast-test-button"
        onLocalPlaybackChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Play cast" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Cast volume" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("cast connection lost");
  });

  it("hides in non-Tauri and appears only in desktop mode", () => {
    isTauri.mockReturnValue(false);
    render(<CastControls media={media} buttonClassName="cast-test-button" />);
    expect(
      screen.queryByRole("button", { name: "Cast to a device" }),
    ).toBeNull();
  });

  function expectNoReceiverCommands() {
    for (const command of [discover, load, control, setVolume, stop, dismissPicker]) {
      expect(command, "portal ownership must not mutate a cast receiver").not.toHaveBeenCalled();
    }
  }

  it.each([false, true])("owns an already-casting mount inside the player pane (fullscreen=%s)", (fullscreen) => {
    resetState({ phase: "casting", device: devices[0] });
    const pane = document.createElement("div");
    pane.className = "player";
    document.body.append(pane);
    const previousFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: fullscreen ? pane : null });
    const onLocalPlaybackChange = vi.fn();
    const { unmount } = render(<CastControls media={media} buttonClassName="cast-test-button" onLocalPlaybackChange={onLocalPlaybackChange} />, { container: pane });
    try {
      const bar = screen.getByRole("complementary", { name: "Casting to Living Room TV" });
      expect(bar.parentElement, "initial casting bar must belong to its enclosing player, not body").toBe(pane);
      expect(document.querySelectorAll(".casting-bar")).toHaveLength(1);
      expect(document.querySelector(".cast-picker-scrim")).toBeNull();
      expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(true);
      expectNoReceiverCommands();
    } finally {
      unmount();
      if (previousFullscreen) Object.defineProperty(document, "fullscreenElement", previousFullscreen);
      else delete (document as unknown as Record<string, unknown>).fullscreenElement;
      pane.remove();
    }
    expect(document.querySelector(".casting-bar")).toBeNull();
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(false);
    expectNoReceiverCommands();
  });

  it("keeps picker-to-casting-to-idle transitions in one mounted player owner without duplicates", () => {
    resetState({ phase: "selecting", devices });
    const onLocalPlaybackChange = vi.fn();
    const player = () => <div className="player" data-testid="cast-player"><CastControls media={media} buttonClassName="cast-test-button" onLocalPlaybackChange={onLocalPlaybackChange} /></div>;
    const { rerender, unmount } = render(player());
    const pane = screen.getByTestId("cast-player");
    expect(screen.getByRole("dialog", { name: "Cast to a device" }).closest(".player"), "picker must use the attached parent, not an early null parent ref").toBe(pane);
    expect(document.querySelectorAll(".cast-picker-scrim")).toHaveLength(1);
    expect(document.querySelectorAll(".casting-bar")).toHaveLength(0);

    resetState({ phase: "loading", devices, device: devices[0] });
    rerender(player());
    expect(screen.getByRole("dialog", { name: "Cast to a device" }).closest(".player")).toBe(pane);
    expect(document.querySelectorAll(".cast-picker-scrim")).toHaveLength(1);
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(true);

    resetState({ phase: "casting", device: devices[0] });
    rerender(player());
    expect(screen.getByRole("complementary", { name: "Casting to Living Room TV" }).parentElement).toBe(pane);
    expect(document.querySelectorAll(".cast-picker-scrim")).toHaveLength(0);
    expect(document.querySelectorAll(".casting-bar")).toHaveLength(1);

    resetState();
    rerender(player());
    expect(document.querySelectorAll(".cast-picker-scrim")).toHaveLength(0);
    expect(document.querySelectorAll(".casting-bar")).toHaveLength(0);
    expect(onLocalPlaybackChange).toHaveBeenLastCalledWith(false);
    unmount();
    expectNoReceiverCommands();
  });

  it.each(["selecting", "casting"] as const)("cleans up the player-owned %s portal when its owner unmounts", (phase) => {
    resetState({ phase, devices, device: devices[0] });
    const { unmount } = render(<div className="player" data-testid="cast-player"><CastControls media={media} buttonClassName="cast-test-button" /></div>);
    const pane = screen.getByTestId("cast-player");
    const surface = phase === "casting"
      ? screen.getByRole("complementary", { name: "Casting to Living Room TV" })
      : screen.getByRole("dialog", { name: "Cast to a device" });
    expect(pane, "active cast surface must be owned before owner cleanup").toContainElement(surface);
    unmount();
    expect(surface.isConnected).toBe(false);
    expect(document.querySelector(".cast-picker-scrim")).toBeNull();
    expect(document.querySelector(".casting-bar")).toBeNull();
    expectNoReceiverCommands();
  });

  it("retains body fallback for generic cast controls through picker and casting phases", () => {
    resetState({ phase: "selecting", devices });
    const { rerender, unmount } = render(<CastControls media={media} buttonClassName="cast-test-button" />);
    expect(screen.getByRole("dialog", { name: "Cast to a device" }).parentElement?.parentElement).toBe(document.body);
    expect(document.querySelectorAll(".cast-picker-scrim")).toHaveLength(1);
    resetState({ phase: "casting", device: devices[0] });
    rerender(<CastControls media={media} buttonClassName="cast-test-button" />);
    expect(screen.getByRole("complementary", { name: "Casting to Living Room TV" }).parentElement).toBe(document.body);
    expect(document.querySelector(".cast-picker-scrim")).toBeNull();
    expect(document.querySelectorAll(".casting-bar")).toHaveLength(1);
    unmount();
    expect(document.querySelector(".casting-bar")).toBeNull();
    expectNoReceiverCommands();
  });

});
