// @vitest-environment jsdom
//
// Render/behavior tests for UpdateBanner: the launch-time check gate
// (autoCheck), the null render when no update is available, the available
// (idle) state, the Install flow (installing -> determinate/indeterminate
// progress -> error), Retry, auto-install, and Dismiss.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingUpdate } from "../lib/updater";

// The component imports checkForUpdates + the weekly-cadence helpers from
// lib/updater. markUpdateChecked/updateCheckAgeMs are backed by real localStorage
// so the weekly-poll gate behaves as in production; WEEKLY_UPDATE_CHECK_MS is the
// real constant.
const checkForUpdates = vi.fn<() => Promise<PendingUpdate | null>>();
const getNativeAppVersion = vi.fn<() => Promise<string | null>>();

vi.mock("../lib/updater", async () => {
  const actual = await vi.importActual<typeof import("../lib/updater")>(
    "../lib/updater",
  );
  return {
    ...actual,
    checkForUpdates: () => checkForUpdates(),
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
    checkForUpdates.mockResolvedValue(makeUpdate("9.9.9", vi.fn()));
    const { container } = render(
      <UpdateBanner autoCheck={false} autoInstall={false} />,
    );
    // Give any effect a chance to (not) run.
    await Promise.resolve();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("automatically installs a mandatory server compatibility update", async () => {
    const install = vi.fn(() => new Promise<void>(() => {}));
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(makeUpdate("0.9.24", install));

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        requiredVersion="0.9.24"
      />,
    );

    await screen.findByText("Installing… 0%");
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "Desktop update required",
    );
    expect(
      screen.queryByRole("button", { name: "Dismiss update notification" }),
    ).toBeNull();
  });

  it("blocks an incompatible desktop client when the update cannot be found", async () => {
    getNativeAppVersion.mockResolvedValue("0.9.21");
    checkForUpdates.mockResolvedValue(null);

    render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        requiredVersion="0.9.24"
      />,
    );

    await screen.findByText("Desktop update required");
    expect(
      screen.getByText(/Desktop v0\.9\.21 cannot run the server v0\.9\.24/),
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
        requiredVersion="0.9.24"
      />,
    );

    await screen.findByText("Desktop update required");
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not force an update when the desktop is as new as the server", async () => {
    getNativeAppVersion.mockResolvedValue("0.10.0");
    checkForUpdates.mockResolvedValue(makeUpdate("0.10.1", vi.fn()));

    const { container } = render(
      <UpdateBanner
        autoCheck={false}
        autoInstall={false}
        requiredVersion="0.9.24"
      />,
    );

    await waitFor(() => expect(getNativeAppVersion).toHaveBeenCalledTimes(1));
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the check resolves null (no update / browser)", async () => {
    checkForUpdates.mockResolvedValue(null);
    const { container } = render(
      <UpdateBanner autoCheck autoInstall={false} />,
    );
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("shows the available (idle) banner with version, Install and Dismiss", async () => {
    checkForUpdates.mockResolvedValue(makeUpdate("1.2.3", vi.fn()));
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
    checkForUpdates.mockResolvedValue(makeUpdate("1.0.0", vi.fn()));
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
    checkForUpdates.mockResolvedValue(makeUpdate("1.3.0", vi.fn()));
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
    checkForUpdates.mockResolvedValue(makeUpdate("2.0.0", install));
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

  it("clamps the fraction to 0..1 before formatting the percent", async () => {
    let report: ((f: number | null) => void) | undefined;
    const install = vi.fn((onProgress?: (f: number | null) => void) => {
      report = onProgress;
      return new Promise<void>(() => {});
    });
    checkForUpdates.mockResolvedValue(makeUpdate("2.1.0", install));
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
    checkForUpdates.mockResolvedValue(makeUpdate("3.0.0", install));
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
    checkForUpdates.mockResolvedValue(makeUpdate("4.5.6", install));
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
    checkForUpdates.mockResolvedValue(makeUpdate("5.0.0", install));
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
    checkForUpdates.mockResolvedValue(makeUpdate("6.0.0", install));
    render(<UpdateBanner autoCheck autoInstall />);

    // Goes straight to installing without the user pressing anything.
    await screen.findByText("Installing… 0%");
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("auto-install surfaces the error state when install rejects", async () => {
    const install = vi.fn(() => Promise.reject(new Error("boom")));
    checkForUpdates.mockResolvedValue(makeUpdate("7.0.0", install));
    render(<UpdateBanner autoCheck autoInstall />);

    await screen.findByText("Update failed");
    expect(
      screen.getByText("Couldn't install v7.0.0. Try again later."),
    ).toBeInTheDocument();
  });

  it("ignores late update results after unmount", async () => {
    let resolve: ((value: PendingUpdate | null) => void) | undefined;
    const pending = new Promise<PendingUpdate | null>((r) => {
      resolve = r;
    });
    const install = vi.fn();
    checkForUpdates.mockReturnValue(pending);

    const { unmount } = render(<UpdateBanner autoCheck autoInstall={false} />);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    unmount();

    resolve?.(makeUpdate("9.9.9", install));

    await pending;
    expect(install).not.toHaveBeenCalled();
  });

  it("re-checks weekly for a long-running instance once a week has elapsed", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue(null); // no update → poll stays eligible
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

  it("does not re-check when the last check was recent (within a week)", async () => {
    vi.useFakeTimers();
    try {
      checkForUpdates.mockResolvedValue(null);
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
      checkForUpdates.mockResolvedValue(makeUpdate("1.0.0", vi.fn()));
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
      checkForUpdates.mockResolvedValue(makeUpdate("1.1.0", vi.fn()));
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
  const { container } = render(<UpdateBanner autoCheck={false} autoInstall={false} requiredVersion="2.3.99" />);
  await Promise.resolve();
  expect(getNativeAppVersion).not.toHaveBeenCalled();
  expect(checkForUpdates).not.toHaveBeenCalled();
  expect(container).toBeEmptyDOMElement();
});
