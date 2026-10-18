// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../data/settings";

let mockSettings: AppSettings;
const updateSettings = vi.fn();

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    simpleMode: false,
  }),
  useSimpleMode: () => false,
}));

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => false,
  configuredServerURL: () => null,
  configuredServerURLSource: () => null,
  saveServerURL: vi.fn(),
}));

let mockIsTauri = true;
let mockIsDesktopTauri = false;

vi.mock("../lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isDesktopTauri: () => mockIsDesktopTauri,
  desktopServerStatus: vi.fn().mockResolvedValue({
    available: true,
    running: false,
    url: null,
    urls: [],
    lan_urls: [],
    share_url: null,
    setup_url: null,
  }),
  detectTunnelTools: vi.fn(),
  getAppInstallInfo: vi.fn().mockResolvedValue(null),
  listExternalPlayers: vi.fn().mockResolvedValue([]),
  startDesktopServer: vi.fn(),
  stopDesktopServer: vi.fn(),
  openExternalURL: vi.fn(),
  revealInFileManager: vi.fn(),
}));

vi.mock("../lib/ServerSessionContext", () => ({
  useServerSession: () => null,
  useSetServerSession: () => vi.fn(),
  useTranscodeAvailable: () => false,
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

let mockHasLocalAndroidUpdater = true;
const checkAndroidAppUpdates = vi.fn();

vi.mock("../lib/androidUpdates", () => ({
  hasLocalAndroidUpdater: () => mockHasLocalAndroidUpdater,
  checkAndroidAppUpdates: (...args: unknown[]) => checkAndroidAppUpdates(...args),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,xxx") },
}));

import { Settings } from "./Settings";

function renderUpdates() {
  const view = render(<Settings />);
  const updates = view.container.querySelector('button[data-tab="updates"]');
  if (updates == null) throw new Error("Updates tab is unavailable");
  fireEvent.click(updates);
  return view;
}

beforeEach(() => {
  mockSettings = defaultSettings();
  mockIsTauri = true;
  mockIsDesktopTauri = false;
  mockHasLocalAndroidUpdater = true;
  checkAndroidAppUpdates.mockReset();
  checkAndroidAppUpdates.mockResolvedValue(undefined);
  updateSettings.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings Android updates", () => {
  it("shows the Android update explanation and native action without opening a tooltip", () => {
    renderUpdates();

    expect(
      screen.getByRole("heading", { name: "Android APK updates" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Android update checks are managed by the native app/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Check for Android updates" }),
    ).toBeVisible();
  });

  it("calls the native update check once with no arguments and reports success", async () => {
    renderUpdates();

    await userEvent.click(
      screen.getByRole("button", { name: "Check for Android updates" }),
    );

    expect(checkAndroidAppUpdates).toHaveBeenCalledTimes(1);
    expect(checkAndroidAppUpdates).toHaveBeenCalledWith();
    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("Android update dialog opened.");
  });

  it("reports a native update check failure", async () => {
    checkAndroidAppUpdates.mockRejectedValueOnce(new Error("unavailable"));
    renderUpdates();

    await userEvent.click(
      screen.getByRole("button", { name: "Check for Android updates" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Android update dialog unavailable. Reopen the app and try again.",
    );
  });

  it("does not expose the native action in a non-local web session", () => {
    mockIsTauri = false;
    mockHasLocalAndroidUpdater = false;
    renderUpdates();

    expect(
      screen.queryByRole("button", { name: "Check for Android updates" }),
    ).not.toBeInTheDocument();
    expect(checkAndroidAppUpdates).not.toHaveBeenCalled();
  });

  it("preserves the ordinary desktop update controls", () => {
    mockIsDesktopTauri = true;
    mockHasLocalAndroidUpdater = false;
    renderUpdates();

    expect(
      screen.getByText("Check for desktop updates automatically"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Install signed desktop updates automatically"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Check for Android updates" }),
    ).not.toBeInTheDocument();
  });
});
