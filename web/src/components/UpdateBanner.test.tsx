// @vitest-environment jsdom
//
// Render/behavior tests for UpdateBanner: the launch-time check gate
// (autoCheck), the null render when no update is available, the available
// (idle) state, the Install flow (installing -> determinate/indeterminate
// progress -> error), Retry, auto-install, and Dismiss.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense, startTransition, useState } from "react";
import { getPlayerMounted, registerPlayerMount, tryAcquireUpdateInstallation } from "../lib/attention";
import { UpdateDeferredError, UpdateRestartRequiredError } from "../lib/updater";
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
    const install = vi.fn<PendingUpdate["install"]>((_progress, admission) => {
      admission?.onInstallStarted?.();
      return new Promise<void>(() => {});
    });
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

function deferredBanner<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const releaseActivity: Array<() => void> = [];
afterEach(() => { for (const release of releaseActivity.splice(0)) release(); });
function mountReader() { const release = registerPlayerMount(); releaseActivity.push(release); return release; }
async function flushUpdate() { await act(async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); }); }
function stagedBannerUpdate() {
  const downloaded = deferredBanner<void>(); const nativeInstall = vi.fn(); let downloads = 0; let hasBytes = false;
  const candidate = makeUpdate("9.0.0", vi.fn<PendingUpdate["install"]>(async (_progress, admission) => {
    if (!hasBytes) { downloads += 1; await downloaded.promise; hasBytes = true; }
    if (admission?.canProceed() === false || getPlayerMounted()) throw new UpdateDeferredError();
    const release = tryAcquireUpdateInstallation(); if (release == null) throw new UpdateDeferredError();
    releaseActivity.push(release); admission?.onInstallStarted?.(); nativeInstall();
    await new Promise<void>(() => {});
  }));
  candidate.close = vi.fn(async () => {});
  return { candidate, downloaded, nativeInstall, downloads: () => downloads };
}
describe("desktop update playback deferral", () => {
  it("checks quietly but waits until the last of multiple players closes", async () => {
    const first = mountReader(); const last = mountReader(); const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockResolvedValue(availableUpdate("9.0.0", install));
    render(<UpdateBanner autoCheck autoInstall />); await flushUpdate();
    expect(checkForUpdates).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled();
    expect(screen.getByText(/Close all players/)).toBeInTheDocument();
    act(() => { first(); first(); }); await flushUpdate(); expect(install).not.toHaveBeenCalled();
    act(() => last()); await flushUpdate(); expect(install).toHaveBeenCalledTimes(1);
  });
  it.each(["feed result", "queued microtask"] as const)("admits playback before installation at the %s race", async (race) => {
    const feed = deferredBanner<UpdateCheckResult>(); const install = vi.fn(() => new Promise<void>(() => {}));
    checkForUpdates.mockReturnValue(feed.promise); render(<UpdateBanner autoCheck autoInstall />); await flushUpdate();
    let release = () => {};
    if (race === "feed result") act(() => { release = mountReader(); });
    await act(async () => {
      feed.resolve(availableUpdate("9.0.0", install));
      if (race === "queued microtask") queueMicrotask(() => { release = mountReader(); });
      for (let i = 0; i < 15; i += 1) await Promise.resolve();
    });
    expect(install).not.toHaveBeenCalled(); act(() => release()); await flushUpdate(); expect(install).toHaveBeenCalledTimes(1);
  });
  it.each(["autoInstall", "autoCheck", "privacy", "dismiss", "unmount"] as const)("does not apply a deferred candidate after %s cancellation", async (reason) => {
    const release = mountReader(); const install = vi.fn(() => new Promise<void>(() => {}));
    const candidate = makeUpdate("9.0.0", install); candidate.close = vi.fn(async () => {});
    checkForUpdates.mockResolvedValue({ status: "available", update: candidate });
    const view = render(<UpdateBanner autoCheck autoInstall />); await flushUpdate();
    if (reason === "dismiss") fireEvent.click(screen.getByRole("button", { name: "Dismiss update notification" }));
    else if (reason === "unmount") view.unmount();
    else view.rerender(<UpdateBanner autoCheck={reason !== "autoCheck"} autoInstall={reason !== "autoInstall"} networkMode={reason === "privacy" ? "fullLocal" : "standard"} />);
    act(() => release()); await flushUpdate(); expect(install).not.toHaveBeenCalled();
    if (reason === "dismiss" || reason === "unmount") expect(candidate.close).toHaveBeenCalledTimes(1);
  });
  it("defers an in-flight download when playback starts and reuses its bytes after close", async () => {
    const f = stagedBannerUpdate(); checkForUpdates.mockResolvedValue({ status: "available", update: f.candidate });
    render(<UpdateBanner autoCheck autoInstall />); await flushUpdate(); expect(f.downloads()).toBe(1);
    let release = () => {}; act(() => { release = mountReader(); }); f.downloaded.resolve(); await flushUpdate();
    expect(f.nativeInstall).not.toHaveBeenCalled(); expect(screen.getByText(/Close all players/)).toBeInTheDocument();
    act(() => release()); await flushUpdate(); expect(f.nativeInstall).toHaveBeenCalledTimes(1); expect(f.downloads()).toBe(1);
  });
  it.each(["autoInstall", "autoCheck", "privacy", "unmount", "dismiss"] as const)("rechecks committed %s after download before physical installation", async (reason) => {
    const f = stagedBannerUpdate(); checkForUpdates.mockResolvedValue({ status: "available", update: f.candidate });
    const view = render(<UpdateBanner autoCheck autoInstall={reason !== "dismiss"} />); await flushUpdate();
    let dismiss: (() => void) | undefined;
    if (reason === "dismiss") {
      dismiss = retainReactClick(screen.getByRole("button", { name: "Dismiss update notification" }));
      fireEvent.click(screen.getByRole("button", { name: "Install" })); await flushUpdate();
    }
    expect(f.downloads()).toBe(1);
    if (reason === "unmount") view.unmount();
    else if (reason === "dismiss") act(() => dismiss!());
    else view.rerender(<UpdateBanner autoCheck={reason !== "autoCheck"} autoInstall={reason !== "autoInstall"} networkMode={reason === "privacy" ? "fullLocal" : "standard"} />);
    f.downloaded.resolve(); await flushUpdate(); expect(f.nativeInstall).not.toHaveBeenCalled();
  });
  it.each(["privacy", "autoInstall"] as const)("does not let an abandoned %s render cancel current download admission", async (policy) => {
    const f = stagedBannerUpdate(); checkForUpdates.mockResolvedValue({ status: "available", update: f.candidate });
    const blocked = new Promise<void>(() => {}); let choose = (_value: boolean) => {}; let speculative = 0;
    function Gate({ pending }: { pending: boolean }) { if (pending) { speculative += 1; throw blocked; } return null; }
    function Scenario() {
      const [pending, setPending] = useState(false); choose = setPending;
      return <Suspense fallback={<div>Uncommitted policy</div>}>
        <UpdateBanner autoCheck autoInstall={!pending || policy !== "autoInstall"} networkMode={pending && policy === "privacy" ? "fullLocal" : "standard"} />
        <Gate pending={pending} />
      </Suspense>;
    }
    render(<Scenario />); await flushUpdate();
    act(() => { startTransition(() => choose(true)); }); expect(speculative).toBeGreaterThan(0);
    f.downloaded.resolve(); await flushUpdate(); expect(f.nativeInstall).toHaveBeenCalledTimes(1);
    act(() => choose(false));
  });
  it("keeps mandatory compatibility reasons nonblocking while an existing player must close", async () => {
    const release = mountReader(); const install = vi.fn(() => new Promise<void>(() => {}));
    getNativeAppVersion.mockResolvedValue("2.0.0"); checkForUpdates.mockResolvedValue(availableUpdate("3.0.0", install));
    render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor="2.3.0" />); await flushUpdate();
    expect(screen.queryByRole("alertdialog")).toBeNull(); expect(document.querySelector(".update-compatibility-backdrop")).toBeNull();
    expect(screen.getByText(/native compatibility floor v2.3.0/)).toBeInTheDocument(); expect(install).not.toHaveBeenCalled();
    act(() => release()); await flushUpdate(); expect(install).toHaveBeenCalledTimes(1);
  });
});

describe("installed desktop update restart UI", () => {
  it.each([false, true])("keeps applied state and local restart available with mandatory=%s after privacy and auto-install are disabled", async (mandatory) => {
    let applied = false;
    const restart = vi.fn(async () => {});
    const candidate: PendingUpdate = { version: "9.0.0", currentVersion: "2.0.0", notes: null,
      get applied() { return applied; }, restart, close: vi.fn(async () => {}),
      install: vi.fn<PendingUpdate["install"]>(async (_progress, admission) => {
        admission?.onInstallStarted?.(); applied = true; throw new UpdateRestartRequiredError();
      }) };
    if (mandatory) getNativeAppVersion.mockResolvedValue("2.0.0");
    checkForUpdates.mockResolvedValue({ status: "available", update: candidate });
    const view = render(<UpdateBanner autoCheck autoInstall nativeCompatibilityFloor={mandatory ? "2.3.0" : "0.9.24"} />);
    await flushUpdate(); expect(screen.getByText("Update v9.0.0 installed")).toBeInTheDocument();
    view.rerender(<UpdateBanner autoCheck={false} autoInstall={false} networkMode="fullLocal" nativeCompatibilityFloor={mandatory ? "2.3.0" : "0.9.24"} />);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull(); expect(screen.queryByRole("button", { name: "Dismiss update notification" })).toBeNull();
    if (mandatory) expect(screen.getByText(/meets native compatibility floor v2.3.0 after restart/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart app" })); await flushUpdate();
    expect(restart).toHaveBeenCalledTimes(1); expect(candidate.install).toHaveBeenCalledTimes(1); expect(checkForUpdates).toHaveBeenCalledTimes(1);
    view.unmount(); expect(candidate.close).not.toHaveBeenCalled();
  });
  it("deduplicates explicit local Restart and never returns to Install after restart failure", async () => {
    let applied = false; const pending = deferredBanner<void>();
    const restart = vi.fn(() => pending.promise);
    const candidate: PendingUpdate = { version: "9.0.0", currentVersion: "2.0.0", notes: null, get applied() { return applied; }, restart,
      install: vi.fn<PendingUpdate["install"]>(async (_progress, admission) => { admission?.onInstallStarted?.(); applied = true; throw new UpdateRestartRequiredError(); }) };
    checkForUpdates.mockResolvedValue({ status: "available", update: candidate });
    render(<UpdateBanner autoCheck autoInstall />); await flushUpdate();
    const button = screen.getByRole("button", { name: "Restart app" });
    act(() => { button.click(); button.click(); }); expect(restart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restarting…" })).toBeDisabled();
    // Model another restart failure without pretending native apply was undone.
    pending.reject(new UpdateRestartRequiredError()); await flushUpdate();
    expect(screen.getByRole("button", { name: "Restart app" })).toBeEnabled();
    restart.mockResolvedValueOnce();
    fireEvent.click(screen.getByRole("button", { name: "Restart app" })); await flushUpdate();
    expect(restart).toHaveBeenCalledTimes(2);
    expect(candidate.install).toHaveBeenCalledTimes(1); expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
