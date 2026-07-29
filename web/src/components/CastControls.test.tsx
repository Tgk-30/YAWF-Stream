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
});
