// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../data/settings";

let mockSettings: AppSettings;
let mockPlayerMounted = false;
let mockIsTauri = false;
let mockIsDesktopTauri = false;
let mockAndroidUpdater = false;
let mockActiveProfile: { id: string } | null = { id: "profile-a" };
let mockServerProfileId: string | null = null;
let refreshAllowed = true;
const updateSettings = vi.fn();
const prepareBrowserAppRefresh = vi.hoisted(() => vi.fn());
const reloadBrowserAppPage = vi.hoisted(() => vi.fn());

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    services: { debrid: null },
    updateSettings,
    simpleMode: false,
    activeProfile: mockActiveProfile,
    profiles: mockActiveProfile == null ? [] : [mockActiveProfile],
    multiUserEnabled: true,
    refreshProfiles: vi.fn(),
    pendingSettingsSection: null,
    clearPendingSettingsSection: vi.fn(),
  }),
  useSimpleMode: () => false,
}));

vi.mock("../lib/attention", () => ({
  usePlayerMounted: () => mockPlayerMounted,
}));

vi.mock("../lib/browserAppRefresh", () => ({
  assertBrowserAppRefreshAllowed: () => {
    if (!refreshAllowed) throw new Error("updates blocked by current policy");
  },
  prepareBrowserAppRefresh,
  reloadBrowserAppPage,
}));

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => mockServerProfileId != null,
  configuredServerURL: () => null,
  configuredServerURLSource: () => null,
  saveServerURL: vi.fn(),
}));

vi.mock("../lib/ServerSessionContext", () => ({
  useServerSession: () =>
    mockServerProfileId == null ? null : { profileId: mockServerProfileId },
  useSetServerSession: () => vi.fn(),
  useTranscodeAvailable: () => false,
}));

vi.mock("../lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isDesktopTauri: () => mockIsDesktopTauri,
  desktopServerStatus: vi.fn().mockResolvedValue(null),
  detectTunnelTools: vi.fn().mockResolvedValue({
    cloudflared: { installed: false, version: null, detail: null },
    tailscale: { installed: false, version: null, detail: null },
  }),
  getAppInstallInfo: vi.fn().mockResolvedValue(null),
  listExternalPlayers: vi.fn().mockResolvedValue([]),
  startDesktopServer: vi.fn(),
  stopDesktopServer: vi.fn(),
  openExternalURL: vi.fn(),
  revealInFileManager: vi.fn(),
}));

vi.mock("../lib/androidUpdates", () => ({
  hasLocalAndroidUpdater: () => mockAndroidUpdater,
  checkAndroidAppUpdates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/serverSession", () => ({
  notifyUnauthorized: vi.fn(),
  readCsrfToken: () => null,
}));

vi.mock("../lib/serverApi", () => ({
  fetchAccountProfiles: vi.fn(async () => ({ profiles: [] })),
  setProfileMaturity: vi.fn(),
  exportServerPortableProfile: vi.fn(),
  importServerPortableProfile: vi.fn(),
  testServerDebridToken: vi.fn(),
}));

vi.mock("../lib/smartPreload", () => ({
  isSmartPreloadEnabled: () => false,
  setSmartPreloadEnabled: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test") },
}));

import { Settings } from "./Settings";

function renderUpdates() {
  const view = render(<Settings />);
  const tab = view.container.querySelector('button[data-tab="updates"]');
  if (tab == null) throw new Error("Updates tab is unavailable");
  fireEvent.click(tab);
  return view;
}

function reloadButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Reload app" });
}

beforeEach(() => {
  mockSettings = {
    ...defaultSettings(),
    debridTokens: [{ service: "real_debrid", apiToken: "configured" }],
  };
  mockPlayerMounted = false;
  mockIsTauri = false;
  mockIsDesktopTauri = false;
  mockAndroidUpdater = false;
  mockActiveProfile = { id: "profile-a" };
  mockServerProfileId = null;
  refreshAllowed = true;
  updateSettings.mockReset();
  prepareBrowserAppRefresh.mockReset();
  prepareBrowserAppRefresh.mockResolvedValue(undefined);
  reloadBrowserAppPage.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings browser app refresh", () => {
  it("offers only an explicit server-delivered browser refresh action", async () => {
    renderUpdates();

    expect(screen.getByRole("heading", { name: "Refresh browser app" })).toBeVisible();
    expect(screen.getByText(/delivered by your configured web server/i)).toBeVisible();
    expect(screen.queryByText("Check for desktop updates automatically")).toBeNull();
    expect(screen.queryByText("Install signed desktop updates automatically")).toBeNull();
    expect(prepareBrowserAppRefresh).not.toHaveBeenCalled();
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();

    await userEvent.click(reloadButton());
    expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1);
    expect(reloadBrowserAppPage).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable error and retries only after another explicit click", async () => {
    prepareBrowserAppRefresh
      .mockRejectedValueOnce(new Error("service worker unavailable"))
      .mockResolvedValueOnce(undefined);
    renderUpdates();

    await userEvent.click(reloadButton());
    expect(await screen.findByRole("status")).toHaveTextContent(/could not reload/i);
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();

    await userEvent.click(reloadButton());
    expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(2);
    expect(reloadBrowserAppPage).toHaveBeenCalledTimes(1);
  });

  it("surfaces a bounded worker timeout as an actionable retry", async () => {
    const timeout = new Error(
      "The browser did not finish finding its service worker. Try again.",
    );
    timeout.name = "BrowserAppRefreshTimeoutError";
    prepareBrowserAppRefresh.mockRejectedValueOnce(timeout);
    renderUpdates();

    await userEvent.click(reloadButton());

    expect(await screen.findByRole("status")).toHaveTextContent(
      /did not finish finding its service worker\. Try again\./i,
    );
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(reloadButton()).toBeEnabled();
  });

  it("blocks reload for unsaved settings or a mounted player", async () => {
    const original = mockSettings;
    const view = renderUpdates();

    mockSettings = {
      ...original,
      autoAdvanceEpisodes: !original.autoAdvanceEpisodes,
    };
    view.rerender(<Settings />);
    expect(reloadButton()).toBeDisabled();
    expect(screen.getByText(/Save your settings changes before reloading/i)).toBeVisible();

    view.unmount();
    cleanup();
    mockSettings = original;
    mockPlayerMounted = true;
    renderUpdates();
    expect(reloadButton()).toBeDisabled();
    expect(screen.getByText(/Close the active player before reloading/i)).toBeVisible();
    expect(prepareBrowserAppRefresh).not.toHaveBeenCalled();
  });

  it("rechecks dirty, player, and policy guards after a deferred worker update", async () => {
    let resolvePrepare!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    const original = mockSettings;
    const view = renderUpdates();
    fireEvent.click(reloadButton());

    mockSettings = {
      ...original,
      autoAdvanceEpisodes: !original.autoAdvanceEpisodes,
    };
    view.rerender(<Settings />);
    await act(async () => resolvePrepare());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/settings changed/i);

    view.unmount();
    cleanup();
    mockSettings = original;
    prepareBrowserAppRefresh.mockResolvedValueOnce(undefined);
    const policyView = renderUpdates();
    refreshAllowed = false;
    await userEvent.click(reloadButton());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/could not reload/i);
    policyView.unmount();
  });

  it("deduplicates a pending refresh request", async () => {
    let resolvePrepare!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    renderUpdates();

    const button = reloadButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(prepareBrowserAppRefresh).toHaveBeenCalledTimes(1);
    await act(async () => resolvePrepare());
    expect(reloadBrowserAppPage).toHaveBeenCalledTimes(1);
  });

  it("does not reload after unmount or a profile owner replacement", async () => {
    let resolveUnmounted!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveUnmounted = resolve;
      }),
    );
    const first = renderUpdates();
    fireEvent.click(reloadButton());
    first.unmount();
    await act(async () => resolveUnmounted());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();

    let resolveReplaced!: () => void;
    prepareBrowserAppRefresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveReplaced = resolve;
      }),
    );
    const second = renderUpdates();
    fireEvent.click(reloadButton());
    mockActiveProfile = { id: "profile-b" };
    second.rerender(<Settings />);
    await act(async () => resolveReplaced());
    expect(reloadBrowserAppPage).not.toHaveBeenCalled();
  });

  it("keeps the browser card out of desktop and Android native builds", () => {
    mockIsTauri = true;
    mockIsDesktopTauri = true;
    const desktop = renderUpdates();
    expect(screen.queryByRole("button", { name: "Reload app" })).toBeNull();
    expect(screen.getByText("Check for desktop updates automatically")).toBeVisible();
    expect(screen.getByText("Install signed desktop updates automatically")).toBeVisible();
    desktop.unmount();
    cleanup();

    mockIsDesktopTauri = false;
    mockAndroidUpdater = true;
    renderUpdates();
    expect(screen.queryByRole("button", { name: "Reload app" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check for Android updates" })).toBeVisible();
  });
});
