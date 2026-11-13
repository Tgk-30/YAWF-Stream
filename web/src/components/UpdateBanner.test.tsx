// @vitest-environment jsdom
//
// Render/behavior tests for UpdateBanner: the launch-time check gate
// (autoCheck), the null render when no update is available, the available
// (idle) state, the Install flow (installing -> determinate/indeterminate
// progress -> error), Retry, auto-install, and Dismiss.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import type { PendingUpdate, UpdateCheckResult } from "../lib/updater";
import type { NetworkMode } from "../lib/networkPolicy";

// The component imports checkForUpdates + the weekly-cadence helpers from
// lib/updater. markUpdateChecked/updateCheckAgeMs are backed by real localStorage
// so the weekly-poll gate behaves as in production; WEEKLY_UPDATE_CHECK_MS is the
// real constant.
const checkForUpdates = vi.fn<(networkMode?: NetworkMode) => Promise<UpdateCheckResult>>();
const getNativeAppVersion = vi.fn<() => Promise<string | null>>();

vi.mock("../lib/updater", async () => {
  const actual = await vi.importActual<typeof import("../lib/updater")>(
    "../lib/updater",
  );
  return {
    ...actual,
    checkForUpdates: (networkMode?: NetworkMode) => checkForUpdates(networkMode),
  };
});

vi.mock("../lib/appVersion", async () => {
  const actual = await vi.importActual<typeof import("../lib/appVersion")>(
    "../lib/appVersion",
  );
  return {
    ...actual,
    getNativeAppVersion: () => getNativeAppVersion(),
  };
});

// Icon renders an inline SVG that hard-depends on lucide-react; stub it to a
// data-name span so the component tree is trivial to assert on.
vi.mock("./Icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

import { UpdateBanner } from "./UpdateBanner";

/** A PendingUpdate whose install() never resolves on success but can be made to
 * reject, and which records the onProgress callback so tests can drive it. */
function makeUpdate(
  version: string,
  install: PendingUpdate["install"],
): PendingUpdate {
  return { version, currentVersion: "0.0.0", notes: null, install };
}

function availableUpdate(
  version: string,
  install: PendingUpdate["install"],
): UpdateCheckResult {
  return { status: "available", update: makeUpdate(version, install) };
}

/** Capture the handler React attached for this render. This intentionally
 * models an already-retained callback firing after newer props commit. */
function retainReactClick(button: HTMLElement): () => void {
  const propsKey = Object.keys(button).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (propsKey == null) throw new Error("React click props were not attached");
  const props = (button as unknown as Record<string, { onClick?: () => void }>)[
    propsKey
  ];
  if (typeof props?.onClick !== "function") {
    throw new Error("React click handler was not attached");
  }
  return props.onClick;
}

/** Release an already-registered native continuation at a precise React phase.
 * The layout boundary models a new render before the old passive cleanup. */
function heldNativeContinuation(version: string | null) {
  let continuation: (() => void) | undefined;
  const promise = {
    then(onfulfilled: (value: string | null) => unknown) {
      continuation = () => { onfulfilled(version); };
      return Promise.resolve();
    },
  } as unknown as Promise<string | null>;
  return {
    promise,
    release: () => {
      if (continuation == null) throw new Error("Native continuation not registered");
      const pending = continuation;
      continuation = undefined;
      pending();
    },
  };
}

function NativeContinuationBoundary({
  autoInstall,
  floor,
  release,
}: {
  autoInstall: boolean;
  floor: string;
  release?: () => void;
}) {
  useLayoutEffect(() => { release?.(); }, [release]);
  return <UpdateBanner autoCheck autoInstall={autoInstall} nativeCompatibilityFloor={floor} />;
}

beforeEach(() => {
  checkForUpdates.mockReset();
  getNativeAppVersion.mockReset();
  getNativeAppVersion.mockResolvedValue(null);
  // A working in-memory localStorage so the weekly-check gate (markUpdateChecked
  // / updateCheckAgeMs) actually persists - the default test stub no-ops setItem.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdateBanner", () => {
  it("renders nothing and never checks when autoCheck is false", async () => {
    checkForUpdates.mockResolvedValue(availableUpdate("9.9.9", vi.fn()));
    const { container } = render(
      <UpdateBanner autoCheck={false} autoInstall={false} />,
    );
    // Give any effect a chance to (not) run.
    await Promise.resolve();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("keeps a compatibility update blocking but honors disabled auto-install", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.24", install));

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText("Update v0.9.24 available");
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "Desktop update required",
    );
    expect(
      screen.queryByRole("button", { name: "Dismiss update notification" }),
    ).toBeNull();
  });

  it("automatically installs a mandatory compatibility update only when enabled", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.24", install));

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText("Installing… 0%");
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a mandatory install failure from feed failures", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(
      availableUpdate("0.9.24", vi.fn().mockRejectedValue(new Error("denied"))),
    );

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText(/Desktop update v0\.9\.24 could not be installed/);
    expect(screen.queryByText(/release feed could not be checked/)).toBeNull();
    expect(screen.queryByText(/is published yet/)).toBeNull();
  });

  it("does not confuse the web bundle version with the audited desktop floor", async () => {
    getNativeAppVersion.mockResolvedValue("2.3.6");
    checkForUpdates.mockResolvedValue(availableUpdate("2.3.20", vi.fn()));

    const { container } = render(
      <UpdateBanner autoCheck={false} autoInstall={false} />,
    );

    await waitFor(() => expect(getNativeAppVersion).toHaveBeenCalledTimes(1));
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("blocks an incompatible desktop client when the update cannot be found", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue({ status: "no-update" });

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText("Desktop update required");
    expect(
      screen.getByText(/No signed desktop update compatible with native floor v0\.9\.24 is published yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("does not override a network privacy mode for a compatibility update", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        networkMode="fullLocal"
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText("Desktop update required");
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(
      screen.getByText(/blocked by Network Privacy mode/),
    ).toBeInTheDocument();
  });

  it("distinguishes a feed check failure from an unpublished compatible release", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue({ status: "check-failed" });

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText(/signed desktop release feed could not be checked/);
    expect(screen.queryByText(/is published yet/)).toBeNull();
  });

  it("rejects a published update that remains below the native floor", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.23", vi.fn()));

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await screen.findByText(/No signed desktop update compatible with native floor v0\.9\.24/);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("does not force an update when the desktop is as new as the server", async () => {
    getNativeAppVersion.mockResolvedValue("0.10.0");
    checkForUpdates.mockResolvedValue(availableUpdate("0.10.1", vi.fn()));

    const { container } = render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        nativeCompatibilityFloor="0.9.24"
      />,
    );

    await waitFor(() => expect(getNativeAppVersion).toHaveBeenCalledTimes(1));
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the check reports no update", async () => {
    checkForUpdates.mockResolvedValue({ status: "no-update" });
    const { container } = render(
      <UpdateBanner autoCheck autoInstall={false} />,
    );
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("shows the available (idle) banner with version, Install and Dismiss", async () => {
    checkForUpdates.mockResolvedValue(availableUpdate("1.2.3", vi.fn()));
    render(<UpdateBanner autoCheck autoInstall={false} />);

    await screen.findByText("Update v1.2.3 available");
    expect(
      screen.getByText("A new version of YAWF Stream is ready to install."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    ).toBeInTheDocument();
    // role=status / aria-live container present.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("dismissing the idle banner unmounts it", async () => {
    checkForUpdates.mockResolvedValue(availableUpdate("1.0.0", vi.fn()));
    const { container } = render(
      <UpdateBanner autoCheck autoInstall={false} />,
    );
    const user = userEvent.setup();
    await screen.findByText("Update v1.0.0 available");
    await user.click(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    );
    expect(container.firstChild).toBeNull();
  });

  it("dismisses an update banner and suppresses re-render", async () => {
    checkForUpdates.mockResolvedValue(availableUpdate("1.3.0", vi.fn()));
    const { container } = render(
      <UpdateBanner autoCheck autoInstall={false} />,
    );
    const user = userEvent.setup();

    await screen.findByText("Update v1.3.0 available");
    await user.click(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    );

    expect(container.firstChild).toBeNull();
  });

  it("Install drives a determinate progress bar from onProgress fractions", async () => {
    let report: ((f: number | null) => void) | undefined;
    // install() that captures onProgress and stays pending (never resolves).
    const install = vi.fn((onProgress?: (f: number | null) => void) => {
      report = onProgress;
      return new Promise<void>(() => {});
    });
    checkForUpdates.mockResolvedValue(availableUpdate("2.0.0", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Install" }));
    expect(install).toHaveBeenCalledTimes(1);

    // Initial installing state, progress starts at 0%.
    await screen.findByText("Installing… 0%");
    // Drive a mid fraction -> rounded percent + determinate bar.
    report?.(0.42);
    await screen.findByText("Installing… 42%");

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar.className).not.toContain("is-indeterminate");

    // While installing, the Install and Dismiss buttons are gone.
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Dismiss update notification" }),
    ).toBeNull();
  });

  it("does not start a duplicate install from repeated activation", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("2.0.1", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);

    const button = await screen.findByRole("button", { name: "Install" });
    // Keep both native clicks in one React batch so the second activation can
    // reach the handler before the installing render removes the button. The
    // install-operation ref, rather than a disabled/removed DOM node, is the
    // safety boundary against duplicate native updater calls.
    act(() => {
      button.click();
      button.click();
    });

    await screen.findByText("Installing… 0%");
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("blocks a retained Install callback after the mode changes to fullLocal and can retry after restore", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("2.0.2", install));
    const { rerender } = render(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="standard"
      />,
    );

    const originalButton = await screen.findByRole("button", { name: "Install" });
    const retainedInstall = retainReactClick(originalButton);
    rerender(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="fullLocal"
      />,
    );
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();

    act(() => retainedInstall());
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();

    rerender(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="standard"
      />,
    );
    const restoredButton = await screen.findByRole("button", { name: "Install" });
    fireEvent.click(restoredButton);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it("rechecks privacy after an Install click before its queued plugin call", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("2.0.3", install));
    const { rerender } = render(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="standard"
      />,
    );

    const button = await screen.findByRole("button", { name: "Install" });
    act(() => {
      button.click();
      rerender(
        <UpdateBanner
          autoCheck
          autoInstall={false}
          networkMode="fullLocal"
        />,
      );
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(install).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("does not claim a privacy change cancelled an install already admitted to the plugin", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("2.0.4", install));
    const { rerender } = render(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="standard"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    rerender(
      <UpdateBanner
        autoCheck
        autoInstall={false}
        networkMode="fullLocal"
      />,
    );

    expect(screen.getByText("Installing… 0%")).toBeInTheDocument();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("clamps the fraction to 0..1 before formatting the percent", async () => {
    let report: ((f: number | null) => void) | undefined;
    const install = vi.fn((onProgress?: (f: number | null) => void) => {
      report = onProgress;
      return new Promise<void>(() => {});
    });
    checkForUpdates.mockResolvedValue(availableUpdate("2.1.0", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Install" }));
    report?.(1.8); // over 1 -> clamps to 100%
    await screen.findByText("Installing… 100%");
  });

  it("renders an indeterminate bar when onProgress reports null", async () => {
    let report: ((f: number | null) => void) | undefined;
    const install = vi.fn((onProgress?: (f: number | null) => void) => {
      report = onProgress;
      return new Promise<void>(() => {});
    });
    checkForUpdates.mockResolvedValue(availableUpdate("3.0.0", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Install" }));
    report?.(null);

    // Title without a percent, and the indeterminate class on the bar.
    await screen.findByText("Installing…");
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("is-indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });

  it("shows the error state and Retry when install rejects", async () => {
    const install = vi.fn(() => Promise.reject(new Error("nope")));
    checkForUpdates.mockResolvedValue(availableUpdate("4.5.6", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Install" }));

    await screen.findByText("Update failed");
    expect(
      screen.getByText("Couldn't install v4.5.6. Try again later."),
    ).toBeInTheDocument();
    // Error icon is "info".
    expect(document.querySelector('[data-icon="info"]')).not.toBeNull();
    // Retry + Dismiss are both available in the error state.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    ).toBeInTheDocument();
  });

  it("Retry re-invokes install after an error", async () => {
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error("first fail"))
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("5.0.0", install));
    render(<UpdateBanner autoCheck autoInstall={false} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Install" }));
    await screen.findByText("Update failed");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(install).toHaveBeenCalledTimes(2);
    // The retry attempt enters the installing state again.
    await screen.findByText("Installing… 0%");
  });

  it("auto-installs immediately when autoInstall is true (no Install click)", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("6.0.0", install));
    render(<UpdateBanner autoCheck autoInstall />);

    // Goes straight to installing without the user pressing anything.
    await screen.findByText("Installing… 0%");
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("auto-install surfaces the error state when install rejects", async () => {
    const install = vi.fn(() => Promise.reject(new Error("boom")));
    checkForUpdates.mockResolvedValue(availableUpdate("7.0.0", install));
    render(<UpdateBanner autoCheck autoInstall />);

    await screen.findByText("Update failed");
    expect(
      screen.getByText("Couldn't install v7.0.0. Try again later."),
    ).toBeInTheDocument();
  });

  it("ignores late update results after unmount", async () => {
    let resolve: ((value: UpdateCheckResult) => void) | undefined;
    const pending = new Promise<UpdateCheckResult>((r) => {
      resolve = r;
    });
    const install = vi.fn();
    checkForUpdates.mockReturnValue(pending);

    const { unmount } = render(<UpdateBanner autoCheck autoInstall />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    unmount();

    resolve?.(availableUpdate("9.9.9", install));

    await pending;
    await Promise.resolve();
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();
  });

  it("retries a failed launch after 15 minutes despite a recent success and resets the weekly cadence", async () => {
    vi.useFakeTimers();
    try {
      const previous = String(Date.now() - 1000);
      localStorage.setItem("ds_last_update_check", previous);
      const install = vi.fn();
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
        .mockResolvedValueOnce(availableUpdate("9.9.9", install));
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("ds_last_update_check")).toBe(previous);
      fireEvent.focus(window);
      fireEvent.focus(window);
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Update v9.9.9 available")).toBeInTheDocument();
      expect(install).not.toHaveBeenCalled();
      expect(Number(localStorage.getItem("ds_last_update_check"))).toBe(Date.now());
      fireEvent.click(screen.getByRole("button", { name: "Dismiss update notification" }));
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("defers an expired failure retry while hidden until visible", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" }).mockResolvedValue({ status: "no-update" });
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      hidden.mockReturnValue(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      hidden.mockReturnValue(false);
      await act(async () => { fireEvent(document, new Event("visibilitychange")); await Promise.resolve(); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      hidden.mockRestore();
    } finally { vi.useRealTimers(); }
  });

  it("does not defeat a failure cooldown when props change and cancels the retry on unmount", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue({ status: "check-failed" });
      const { rerender, unmount } = render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      rerender(<UpdateBanner autoCheck={false} autoInstall={false} />);
      rerender(<UpdateBanner autoCheck autoInstall={false} networkMode="fullLocal" />);
      rerender(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60 * 1000); });
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("retries repeated failures only after each cooldown and coalesces an in-flight retry", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((result: UpdateCheckResult) => void) | undefined;
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
        .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValue({ status: "no-update" });
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      fireEvent.focus(window);
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      await act(async () => { finish?.({ status: "check-failed" }); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(checkForUpdates).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it("honors disabled checking and privacy while a failure retry becomes due", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" }).mockResolvedValue({ status: "no-update" });
      const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      rerender(<UpdateBanner autoCheck={false} autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      rerender(<UpdateBanner autoCheck autoInstall={false} networkMode="fullLocal" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      rerender(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("throttles a successful retry even if success timestamps cannot be stored", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("localStorage", {
        getItem: () => null,
        setItem: () => { throw new Error("storage unavailable"); },
      });
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" }).mockResolvedValue({ status: "no-update" });
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      fireEvent.focus(window);
      fireEvent.focus(window);
      await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); });
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("keeps the mandatory feed failure retry available with automatic checks disabled", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
      .mockResolvedValueOnce(availableUpdate("0.9.24", vi.fn()));
    render(<UpdateBanner autoCheck={false} autoInstall={false} nativeCompatibilityFloor="0.9.24" />);
    await screen.findByText(/signed desktop release feed could not be checked/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Update v0.9.24 available");
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("does not start another check over an offered update when props refresh", async () => {
    const install = vi.fn();
    checkForUpdates.mockResolvedValue(availableUpdate("9.9.9", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} />);
    await screen.findByText("Update v9.9.9 available");
    rerender(<UpdateBanner autoCheck={false} autoInstall={false} />);
    rerender(<UpdateBanner autoCheck autoInstall={false} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.focus(window);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });

  it.each(["timer", "focus"] as const)("keeps the native floor on a mandatory failed-check %s retry", async (trigger) => {
    vi.useFakeTimers();
    try {
      const install = vi.fn();
      getNativeAppVersion.mockResolvedValue("0.9.21");
      checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
        .mockResolvedValueOnce(availableUpdate("0.9.22", install));
      render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.24" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText(/signed desktop release feed could not be checked/)).toBeInTheDocument();
      fireEvent.focus(window);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      if (trigger === "timer") {
        await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
      } else {
        vi.setSystemTime(Date.now() + 15 * 60 * 1000);
        await act(async () => { fireEvent.focus(window); await Promise.resolve(); });
      }
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
      expect(install).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(screen.getByText(/No signed desktop update compatible with native floor/)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("never installs a below-floor offer after a mandatory failure and focus", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    const install = vi.fn();
    checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
      .mockResolvedValueOnce(availableUpdate("0.9.22", install));
    render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.24" />);
    await screen.findByText(/signed desktop release feed could not be checked/);
    await act(async () => { fireEvent.focus(window); await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("does not start a foreground check before native compatibility is resolved", async () => {
    let resolve: ((version: string | null) => void) | undefined;
    getNativeAppVersion.mockReturnValue(new Promise((done) => { resolve = done; }));
    const install = vi.fn();
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.24" />);
    fireEvent.focus(window);
    fireEvent.focus(window);
    await act(async () => { await Promise.resolve(); });
    expect(checkForUpdates).not.toHaveBeenCalled();
    await act(async () => { resolve?.("0.9.21"); await Promise.resolve(); });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/No signed desktop update compatible with native floor/)).toBeInTheDocument();
  });

  it("retains a known native floor requirement if a later version lookup fails", async () => {
    getNativeAppVersion.mockResolvedValueOnce("0.9.21").mockResolvedValue(null);
    checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
      .mockResolvedValueOnce(availableUpdate("0.9.22", vi.fn()));
    const { rerender } = render(<UpdateBanner autoCheck={false} autoInstall nativeCompatibilityFloor="0.9.24" />);
    await screen.findByText(/signed desktop release feed could not be checked/);
    rerender(<UpdateBanner autoCheck={false} autoInstall nativeCompatibilityFloor="0.9.25" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No signed desktop update compatible with native floor v0.9.25/);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("installs an existing offered update once when automatic installation is enabled", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("9.9.9", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} />);
    await screen.findByText("Update v9.9.9 available");
    rerender(<UpdateBanner autoCheck autoInstall />);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("does not install an existing offer when auto-install is enabled under blocked privacy", async () => {
    const install = vi.fn();
    checkForUpdates.mockResolvedValue(availableUpdate("9.9.9", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} />);
    await screen.findByText("Update v9.9.9 available");
    rerender(<UpdateBanner autoCheck autoInstall networkMode="fullLocal" />);
    await act(async () => { await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit mandatory retry immediately while automatic checking is enabled", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValueOnce({ status: "check-failed" })
      .mockResolvedValueOnce(availableUpdate("0.9.24", vi.fn()));
    render(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.24" />);
    await screen.findByText(/signed desktop release feed could not be checked/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Update v0.9.24 available");
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("revalidates a pending offer against a raised native floor before auto-install", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    const install = vi.fn();
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.20" />);
    await screen.findByText("Update v0.9.22 available");
    rerender(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.24" />);
    await screen.findByText(/No signed desktop update compatible with native floor v0.9.24/);
    expect(install).not.toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("uses a raised floor for an in-flight result after an effect refresh", async () => {
    let finish: ((result: UpdateCheckResult) => void) | undefined;
    getNativeAppVersion.mockResolvedValue("0.9.21");
    const install = vi.fn();
    checkForUpdates.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.20" />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    rerender(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.24" />);
    await act(async () => { await Promise.resolve(); finish?.(availableUpdate("0.9.22", install)); await Promise.resolve(); });
    await screen.findByText(/No signed desktop update compatible with native floor v0.9.24/);
    expect(install).not.toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("R3 rejects a cached offer when the floor renders before its old passive cleanup", async () => {
    const held = heldNativeContinuation("0.9.21");
    getNativeAppVersion.mockResolvedValueOnce("0.9.21")
      .mockReturnValueOnce(held.promise)
      .mockReturnValue(new Promise(() => {}));
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    const { rerender } = render(<NativeContinuationBoundary autoInstall={false} floor="0.9.20" />);
    await screen.findByText("Update v0.9.22 available");
    rerender(<NativeContinuationBoundary autoInstall floor="0.9.20" />);
    rerender(<NativeContinuationBoundary autoInstall floor="0.9.24" release={held.release} />);
    await act(async () => { await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByText(/No signed desktop update compatible with native floor v0.9.24/)).toBeInTheDocument();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("R3 revalidates a retained manual handler against the current known native floor", async () => {
    getNativeAppVersion.mockResolvedValueOnce("0.9.21").mockReturnValue(new Promise(() => {}));
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.20" />);
    const retained = retainReactClick(await screen.findByRole("button", { name: "Install" }));
    rerender(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.24" />);
    act(() => retained());
    await act(async () => { await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/No signed desktop update compatible with native floor v0.9.24/)).toBeInTheDocument();
  });

  it("R3 revalidates the current floor at queued manual plugin entry", async () => {
    getNativeAppVersion.mockResolvedValueOnce("0.9.21").mockReturnValue(new Promise(() => {}));
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.20" />);
    const button = await screen.findByRole("button", { name: "Install" });
    act(() => {
      button.click();
      rerender(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.24" />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByText(/No signed desktop update compatible with native floor v0.9.24/)).toBeInTheDocument();
  });

  it("R3 honors revoked automatic intent before an old cached continuation cleans up", async () => {
    const held = heldNativeContinuation("0.9.21");
    getNativeAppVersion.mockResolvedValueOnce("0.9.21")
      .mockReturnValueOnce(held.promise)
      .mockReturnValue(new Promise(() => {}));
    const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("0.9.22", install));
    const { rerender } = render(<NativeContinuationBoundary autoInstall={false} floor="0.9.20" />);
    await screen.findByText("Update v0.9.22 available");
    rerender(<NativeContinuationBoundary autoInstall floor="0.9.20" />);
    rerender(<NativeContinuationBoundary autoInstall={false} floor="0.9.20" release={held.release} />);
    await act(async () => { await Promise.resolve(); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("R3 revokes a queued automatic install but still permits explicit manual Install and Retry", async () => {
    let finish: ((result: UpdateCheckResult) => void) | undefined;
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const install = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic install failure"))
      .mockImplementation(() => new Promise<void>(() => {}));
    const { rerender } = render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="0.9.20" />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish?.(availableUpdate("0.9.22", install));
      // The check continuation admits an automatic operation first; this
      // continuation revokes it before the queued updater plugin starts.
      await Promise.resolve();
      flushSync(() => {
        rerender(<UpdateBanner autoCheck autoInstall={false} nativeCompatibilityFloor="0.9.20" />);
      });
    });
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(install).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Installing… 0%")).toBeInTheDocument();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("re-checks weekly for a long-running instance once a week has elapsed", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue({ status: "no-update" }); // no update → poll stays eligible
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await vi.advanceTimersByTimeAsync(0); // flush the launch check
      expect(checkForUpdates).toHaveBeenCalledTimes(1);

      // Backdate the last check to over a week ago so the poll's gate opens.
      localStorage.setItem(
        "ds_last_update_check",
        String(Date.now() - 8 * 24 * 60 * 60 * 1000),
      );
      // One poll interval later, the gate is open → a second check fires.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-evaluates a due weekly check immediately when the window returns to the foreground", async () => {
    checkForUpdates.mockResolvedValue({ status: "no-update" });
    render(<UpdateBanner autoCheck autoInstall={false} />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

    localStorage.setItem(
      "ds_last_update_check",
      String(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    fireEvent.focus(window);

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
  });

  it("coalesces launch and foreground signals into one in-flight feed check", async () => {
    let resolve: ((value: UpdateCheckResult) => void) | undefined;
    checkForUpdates.mockReturnValue(
      new Promise<UpdateCheckResult>((done) => {
        resolve = done;
      }),
    );
    render(<UpdateBanner autoCheck autoInstall={false} />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

    localStorage.setItem(
      "ds_last_update_check",
      String(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    fireEvent.focus(window);
    fireEvent.focus(window);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    resolve?.({ status: "no-update" });
    await waitFor(() => expect(localStorage.getItem("ds_last_update_check")).not.toBeNull());
  });

  it("does not re-check when the last check was recent (within a week)", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue({ status: "no-update" });
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);

      // Launch just marked "now" → a poll interval later is still within the
      // week, so no second network check.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a dismissed version hidden but surfaces a later one on the next weekly check", async () => {
    const weekAgo = () => String(Date.now() - 8 * 24 * 60 * 60 * 1000);
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue(availableUpdate("1.0.0", vi.fn()));
      render(<UpdateBanner autoCheck autoInstall={false} />);
      await vi.advanceTimersByTimeAsync(0); // launch → v1.0.0 surfaces
      expect(screen.getByText("Update v1.0.0 available")).toBeInTheDocument();

      // Dismiss it.
      fireEvent.click(
        screen.getByRole("button", { name: "Dismiss update notification" }),
      );
      expect(screen.queryByText("Update v1.0.0 available")).toBeNull();

      // A week later the poll re-checks and finds the SAME version → stays hidden.
      localStorage.setItem("ds_last_update_check", weekAgo());
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(screen.queryByText("Update v1.0.0 available")).toBeNull();

      // A NEWER version appears → the next weekly poll surfaces it.
      checkForUpdates.mockResolvedValue(availableUpdate("1.1.0", vi.fn()));
      localStorage.setItem("ds_last_update_check", weekAgo());
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(screen.getByText("Update v1.1.0 available")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("does not compare Android APK versions against the hosted server or call the desktop updater", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("__YAWF_TAURI_MOBILE__", true);
  vi.stubGlobal("__YAWF_TAURI_ANDROID__", true);
  getNativeAppVersion.mockResolvedValue("2.3.9");
  const { container } = render(<UpdateBanner autoCheck={false} autoInstall={false} nativeCompatibilityFloor="2.3.99" />);
  await Promise.resolve();
  expect(getNativeAppVersion).not.toHaveBeenCalled();
  expect(checkForUpdates).not.toHaveBeenCalled();
  expect(container).toBeEmptyDOMElement();
});
