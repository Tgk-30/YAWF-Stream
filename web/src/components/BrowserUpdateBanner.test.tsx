// @vitest-environment jsdom

import { Suspense, startTransition } from "react";
import appSource from "../App.tsx?raw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const bannerCSS = readFileSync(resolve(process.cwd(), "src/components/BrowserUpdateBanner.css"), "utf8");
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAppUpdate } from "../lib/browserAppUpdate";

const checkBrowserAppUpdate = vi.hoisted(() => vi.fn());
const prepareBrowserAppRefresh = vi.hoisted(() => vi.fn());
const assertBrowserAppRefreshAllowed = vi.hoisted(() => vi.fn());
const reloadBrowserAppPage = vi.hoisted(() => vi.fn());
const isTauri = vi.hoisted(() => vi.fn(() => false));
const getPlayerMounted = vi.hoisted(() => vi.fn(() => false));

vi.mock("../lib/browserAppUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browserAppUpdate")>()),
  checkBrowserAppUpdate,
}));
vi.mock("../lib/browserAppRefresh", () => ({
  prepareBrowserAppRefresh,
  assertBrowserAppRefreshAllowed,
  reloadBrowserAppPage,
}));
vi.mock("../lib/tauri", () => ({ isTauri }));
vi.mock("../lib/attention", () => ({ getPlayerMounted }));

import { BrowserUpdateBanner } from "./BrowserUpdateBanner";

const UPDATE_A: BrowserAppUpdate = {
  current: { path: "/assets/index-Current123.js", hash: "Current123" },
  target: { path: "/assets/index-Target4567.js", hash: "Target4567" },
};
const UPDATE_B: BrowserAppUpdate = {
  ...UPDATE_A,
  target: { path: "/assets/index-Newer8901.js", hash: "Newer8901" },
};

function view(overrides: Partial<React.ComponentProps<typeof BrowserUpdateBanner>> = {}) {
  return render(<BrowserUpdateBanner
    autoCheck
    networkMode="standard"
    playerMounted={false}
    playerPending={false}
    currentVersion="2.3.90"
    {...overrides}
  />);
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  checkBrowserAppUpdate.mockReset();
  checkBrowserAppUpdate.mockResolvedValue(UPDATE_A);
  prepareBrowserAppRefresh.mockReset();
  prepareBrowserAppRefresh.mockResolvedValue(undefined);
  assertBrowserAppRefreshAllowed.mockReset();
  reloadBrowserAppPage.mockReset();
  isTauri.mockReset();
  isTauri.mockReturnValue(false);
  getPlayerMounted.mockReset();
  getPlayerMounted.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BrowserUpdateBanner", () => {
  it("shows the loaded web version and never reloads before explicit action", async () => {
    view();
    expect(await screen.findByRole("status")).toHaveTextContent("Web version 2.3.90 is open");
    expect(screen.getByRole("status")).toHaveTextContent("different app build");
    expect(screen.getByRole("status")).toHaveTextContent("Save any unsaved changes");
    expect(screen.getByRole("button", { name: "Update app" })).toBeEnabled();
    expect(prepareBrowserAppRefresh).not.toHaveBeenCalled();
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(reloadBrowserAppPage).toHaveBeenCalledTimes(1));
    expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1);
    expect(assertBrowserAppRefreshAllowed).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notice while a player is mounted, then reveals it after close", async () => {
    const mounted = view({ playerMounted: true });
    await waitFor(() => expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
    mounted.rerender(<BrowserUpdateBanner autoCheck networkMode="standard" playerMounted={false} playerPending={false} currentVersion="2.3.90" />);
    expect(await screen.findByRole("status")).toBeVisible();
  });

  it.each(["Detail", "local file"])("hides an initial pending %s player before it mounts", async () => {
    view({ playerPending: true });
    await waitFor(() => expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(prepareBrowserAppRefresh).not.toHaveBeenCalled();
  });

  it("cancels reload when a player becomes pending during preparation", async () => {
    let release!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const mounted = view();
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1));
    mounted.rerender(<BrowserUpdateBanner autoCheck networkMode="standard" playerMounted={false} playerPending currentVersion="2.3.90" />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => release());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it("checks the synchronous player guard before preparation and again after its await", async () => {
    const mounted = view();
    await screen.findByRole("status");
    getPlayerMounted.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Update app" }));
    expect(prepareBrowserAppRefresh).not.toHaveBeenCalled();
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();

    getPlayerMounted.mockReturnValue(false);
    mounted.rerender(<BrowserUpdateBanner autoCheck networkMode="standard" playerMounted={false} playerPending={false} currentVersion="2.3.90" />);
    let release!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1));
    getPlayerMounted.mockReturnValue(true);
    await act(async () => release());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("rechecks privacy immediately before reload", async () => {
    view();
    await screen.findByRole("status");
    assertBrowserAppRefreshAllowed.mockImplementationOnce(() => { throw new Error("privacy changed"); });
    await userEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not update/i));
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it.each([
    ["automatic checks disabled", { autoCheck: false, networkMode: "standard" as const }],
    ["offline privacy", { autoCheck: true, networkMode: "offline" as const }],
    ["full local privacy", { autoCheck: true, networkMode: "fullLocal" as const }],
  ])("does not request app files when %s", async (_label, props) => {
    vi.useFakeTimers();
    view(props);
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
    expect(checkBrowserAppUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps browser checks out of native desktop and Android shells", async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    view();
    await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
    expect(checkBrowserAppUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses one entry for the session and resurfaces a different entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    checkBrowserAppUpdate.mockReset();
    checkBrowserAppUpdate.mockResolvedValueOnce(UPDATE_A).mockResolvedValueOnce(UPDATE_A).mockResolvedValueOnce(UPDATE_B);
    view();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();

    vi.setSystemTime(new Date("2026-11-09T12:30:01Z"));
    fireEvent(window, new Event("pageshow"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("status")).toBeNull();

    vi.setSystemTime(new Date("2026-11-09T13:00:02Z"));
    fireEvent(window, new Event("pageshow"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Different web app build available");
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["checks disabled", { autoCheck: false, networkMode: "standard" as const }],
    ["offline privacy", { autoCheck: true, networkMode: "offline" as const }],
    ["full local privacy", { autoCheck: true, networkMode: "fullLocal" as const }],
  ])("does not reload if %s commits during preparation", async (_label, policy) => {
    let release!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const mounted = view();
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1));
    mounted.rerender(<BrowserUpdateBanner {...policy} playerMounted={false} playerPending={false} currentVersion="2.3.90" />);
    await act(async () => release());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not use a suspended render to clear the committed pending-player guard", async () => {
    let release!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const never = new Promise<void>(() => {});
    function Suspender({ blocked }: { blocked: boolean }) { if (blocked) throw never; return null; }
    const tree = (pending: boolean, blocked = false) => <Suspense fallback={<span>Waiting</span>}>
      <BrowserUpdateBanner autoCheck networkMode="standard" playerMounted={false} playerPending={pending} currentVersion="2.3.90" />
      <Suspender blocked={blocked} />
    </Suspense>;
    const mounted = render(tree(false));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Update app" }));
    await waitFor(() => expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1));
    mounted.rerender(tree(true));
    act(() => startTransition(() => mounted.rerender(tree(false, true))));
    await act(async () => release());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it("deduplicates an explicit action and stops it after unmount", async () => {
    let release!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const mounted = view();
    await screen.findByRole("status");
    const action = screen.getByRole("button", { name: "Update app" });
    fireEvent.click(action); fireEvent.click(action);
    await waitFor(() => expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1));
    mounted.unmount();
    await act(async () => release());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it("wires pending Detail and local-file readers rather than viewing Detail itself", () => {
    expect(appSource).toMatch(/detailItem,\s+detailPlayerOpen,\s+localFilePlayer,/);
    expect(appSource).toContain("playerPending={detailPlayerOpen || localFilePlayer != null}");
    expect(appSource).not.toMatch(/playerPending=\{detailItem/);
  });

  it("uses safe mobile and short-landscape nav clearance with bounded scrolling", () => {
    expect(bannerCSS).toContain("@media (max-width: 699px), (max-width: 950px) and (max-height: 500px)");
    expect(bannerCSS).toContain("bottom: calc(var(--mobile-nav-bottom) + var(--mobile-nav-height) + var(--sp-sm))");
    expect(bannerCSS).toContain("left: max(var(--sp-sm), var(--safe-area-left))");
    expect(bannerCSS).toContain("right: max(var(--sp-sm), var(--safe-area-right))");
    expect(bannerCSS).toContain("max-height: calc(100vh");
    expect(bannerCSS).toContain("max-height: calc(100dvh");
    expect(bannerCSS).toContain("overflow-y: auto");
    expect(bannerCSS).toContain("width: auto");
    expect(bannerCSS).toContain("min-height: 44px");
    expect(bannerCSS).toContain("@media (max-width: 400px)");
    expect(bannerCSS).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("finds a different entry after thirty continuously visible minutes without reloading", async () => {
    vi.useFakeTimers();
    checkBrowserAppUpdate.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(UPDATE_A);
    view();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("different app build");
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it.each(["unmount", "disable"])("clears the visible cadence timer on %s", async (action) => {
    vi.useFakeTimers();
    checkBrowserAppUpdate.mockResolvedValue(null);
    const mounted = view();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(1);
    if (action === "unmount") mounted.unmount();
    else mounted.rerender(<BrowserUpdateBanner autoCheck={false} networkMode="standard" playerMounted={false} playerPending={false} />);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an in-flight check at a visible timer or foreground wakeup", async () => {
    vi.useFakeTimers();
    let release!: (value: BrowserAppUpdate | null) => void;
    checkBrowserAppUpdate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    view();
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    fireEvent(window, new Event("pageshow"));
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(1);
    await act(async () => release(null));
  });

  it("checks at visible cadence and suppresses hidden timer wakeups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    checkBrowserAppUpdate.mockResolvedValue(null);
    view();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await Promise.resolve(); });
    expect(checkBrowserAppUpdate).toHaveBeenCalledTimes(4);
  });

  it("silently ignores timeout, offline and malformed check failures without stale UI", async () => {
    let reject!: (error: Error) => void;
    checkBrowserAppUpdate.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const mounted = view();
    mounted.rerender(<BrowserUpdateBanner autoCheck={false} networkMode="standard" playerMounted={false} playerPending={false} currentVersion="2.3.90" />);
    await act(async () => reject(new Error("malformed or offline")));
    expect(screen.queryByRole("status")).toBeNull();
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });
});
