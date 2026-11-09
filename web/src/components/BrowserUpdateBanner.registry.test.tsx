// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPlayerMounted, registerPlayerMount } from "../lib/attention";
const prepare = vi.hoisted(() => vi.fn());
const reload = vi.hoisted(() => vi.fn());
const allow = vi.hoisted(() => vi.fn());
vi.mock("../lib/tauri", () => ({ isTauri: () => false }));
vi.mock("../lib/browserAppUpdate", async (original) => ({
  ...(await original<typeof import("../lib/browserAppUpdate")>()),
  checkBrowserAppUpdate: async () => ({ current: { path: "/assets/index-current1.js", hash: "current1" }, target: { path: "/assets/index-different1.js", hash: "different1" } }),
}));
vi.mock("../lib/browserAppRefresh", () => ({ prepareBrowserAppRefresh: prepare, reloadBrowserAppPage: reload, assertBrowserAppRefreshAllowed: allow }));
import { BrowserUpdateBanner } from "./BrowserUpdateBanner";
let closes: (() => void)[] = [];
function mountReader() { const close = registerPlayerMount(); closes.push(close); }
async function show() {
  render(<BrowserUpdateBanner autoCheck networkMode="standard" playerMounted={false} playerPending={false} />);
  await screen.findByRole("status");
}
beforeEach(() => { expect(getPlayerMounted()).toBe(false); prepare.mockReset().mockResolvedValue(undefined); reload.mockReset(); allow.mockReset(); });
afterEach(() => { cleanup(); closes.forEach((close) => close()); closes = []; });
it("blocks a real player registration before React receives mounted props", async () => {
  await show();
  mountReader();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update app" })); await Promise.resolve(); });
  expect(prepare).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});
it("blocks a real player registration across deferred preparation without a React render", async () => {
  let release!: () => void;
  prepare.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await show(); fireEvent.click(screen.getByRole("button", { name: "Update app" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  mountReader(); await act(async () => release());
  expect(reload).not.toHaveBeenCalled();
});
it("checks the real registry after the final privacy check immediately before reload", async () => {
  allow.mockImplementationOnce(mountReader);
  await show(); fireEvent.click(screen.getByRole("button", { name: "Update app" }));
  await waitFor(() => expect(allow).toHaveBeenCalledTimes(1));
  expect(getPlayerMounted()).toBe(true); expect(reload).not.toHaveBeenCalled();
});

it.each(["detail-player", "detail-player-sources", "local-player"])("blocks same-tick owned %s navigation before React updates", async (layer) => {
  const original = window.history.state;
  await show();
  try {
    window.history.replaceState({ debridStreamerNavigation: 1, depth: 1, route: "discover", browseContext: null,
      detailItem: { id: "fixture", type: "movie", title: "Fixture" }, layer,
      localFilePlayer: layer === "local-player" ? { path: "fixture.mp4", title: "Fixture" } : null }, "");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update app" })); await Promise.resolve(); });
    expect(prepare).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  } finally { window.history.replaceState(original, ""); }
});
it("blocks owned navigation committed to history during deferred preparation", async () => {
  let release!: () => void;
  prepare.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const original = window.history.state;
  await show(); fireEvent.click(screen.getByRole("button", { name: "Update app" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  try {
    window.history.replaceState({ debridStreamerNavigation: 1, depth: 1, route: "discover", browseContext: null,
      detailItem: { id: "fixture", type: "movie", title: "Fixture" }, layer: "detail-player", localFilePlayer: null }, "");
    await act(async () => release());
    expect(reload).not.toHaveBeenCalled();
  } finally { window.history.replaceState(original, ""); }
});
