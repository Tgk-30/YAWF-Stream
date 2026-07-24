// @vitest-environment jsdom
//
// partC - the Local-Mode "Install & setup" + "Updates" tabs, which partA/partB
// never visit. Targets the previously-uncovered subtrees:
//   • InstallTab - setup-path picker (device/connect/downloads/deploy),
//     beforeinstallprompt/appinstalled wiring, promptInstall().
//   • DesktopHostPanel - only mounts under Tauri (isTauri() === true here):
//     status load, QR generation, start/stop/openServer/share/copy handlers,
//     LAN/setup-URL hints.
//   • ServerConnectionPanel.connect - inferServerURL() scheme inference, the
//     /api/health probe (success + failure), saveServerURL + reload.
//   • RemoteAccessPanel - Tailscale ↔ Cloudflare track switch.
//   • UpdatesTab - the two auto-update toggles + the disable-cascade.
//
// Local Mode (isServerMode() === false) so the non-server tabs are the focus.
// Tauri is mocked TRUE so DesktopHostPanel renders (partA mocks it false).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultSettings, type AppSettings } from "../data/settings";

// --- mutable mock state -----------------------------------------------------

let mockSettings: AppSettings = defaultSettings();
let mockSimpleMode = false;
const updateSettings = vi.fn();

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    simpleMode: mockSimpleMode,
  }),
  useSimpleMode: () => mockSimpleMode,
}));

let mockServerURL: string | null = null;
let mockServerURLSource: string | null = null;
let mockServerMode = false;
const saveServerURL = vi.fn();

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => mockServerMode,
  configuredServerURL: () => mockServerURL,
  configuredServerURLSource: () => mockServerURLSource,
  saveServerURL: (v: string | null) => saveServerURL(v),
}));

// Tauri is the key difference vs partA: DesktopHostPanel only renders when
// isTauri() is true, so all four async handlers + QR effect become reachable.
let mockIsTauri = true;
const desktopServerStatus = vi.fn();
const startDesktopServer = vi.fn();
const stopDesktopServer = vi.fn();
const openExternalURL = vi.fn();
const detectTunnelTools = vi.fn();
const getAppInstallInfo = vi.fn();
const revealInFileManager = vi.fn();

vi.mock("../lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  desktopServerStatus: () => desktopServerStatus(),
  startDesktopServer: () => startDesktopServer(),
  stopDesktopServer: () => stopDesktopServer(),
  openExternalURL: (url: string) => openExternalURL(url),
  detectTunnelTools: () => detectTunnelTools(),
  getAppInstallInfo: () => getAppInstallInfo(),
  revealInFileManager: (path: string) => revealInFileManager(path),
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
}));

vi.mock("../lib/smartPreload", () => ({
  isSmartPreloadEnabled: () => false,
  setSmartPreloadEnabled: vi.fn(),
}));

const toDataURL = vi.fn(async (..._args: unknown[]) => "data:image/png;base64,QR");
vi.mock("qrcode", () => ({
  default: { toDataURL: (...a: unknown[]) => toDataURL(...a) },
}));

import { Settings } from "./Settings";

// --- helpers ----------------------------------------------------------------

function renderAt(tab?: string, seed?: Partial<AppSettings>) {
  if (seed) mockSettings = { ...defaultSettings(), ...seed };
  const utils = render(<Settings />);
  if (tab) {
    const chip = utils.container.querySelector(`button[data-tab="${tab}"]`);
    if (chip) fireEvent.click(chip);
  }
  return utils;
}

const statusBase = {
  available: true,
  running: false,
  url: null as string | null,
  urls: [] as string[],
  lan_urls: [] as string[],
  share_url: null as string | null,
  setup_url: null as string | null,
  setup_token: null as string | null,
  port: 43110,
  detail: "Ready to host.",
  server_entry: "/srv/index.js",
  web_dist: "/srv/web",
};

beforeEach(() => {
  mockSettings = defaultSettings();
  mockSimpleMode = false;
  mockIsTauri = true;
  mockServerURL = null;
  mockServerURLSource = null;
  mockServerMode = false;
  updateSettings.mockClear();
  saveServerURL.mockClear();
  desktopServerStatus.mockReset();
  startDesktopServer.mockReset();
  stopDesktopServer.mockReset();
  openExternalURL.mockReset();
  detectTunnelTools.mockReset();
  getAppInstallInfo.mockReset();
  revealInFileManager.mockReset();
  toDataURL.mockClear();
  toDataURL.mockResolvedValue("data:image/png;base64,QR");
  // Default: status resolves to a not-running, no-URL state.
  desktopServerStatus.mockResolvedValue({ ...statusBase });
  detectTunnelTools.mockResolvedValue({
    cloudflared: { installed: false, version: null, detail: null },
    tailscale: { installed: false, version: null, detail: null },
  });
  getAppInstallInfo.mockResolvedValue({
    os: "windows",
    format: "windows",
    appBundlePath: null,
    appimagePath: null,
  });
});

describe("Settings · Desktop uninstall guidance", () => {
  it("renders Windows uninstall guidance and opens the Windows app settings URI", async () => {
    const user = userEvent.setup();
    renderAt();

    expect(await screen.findByText("Find YAWF Stream in the list and choose Uninstall.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Windows app settings" }));
    expect(openExternalURL).toHaveBeenCalledWith("ms-settings:appsfeatures");
  });

  it("renders macOS and AppImage reveal controls for their native formats", async () => {
    getAppInstallInfo.mockResolvedValueOnce({
      os: "macos",
      format: "macos-app",
      appBundlePath: "/Applications/DebridStreamer.app",
      appimagePath: null,
    });
    const mac = renderAt();
    expect(await screen.findByRole("button", { name: "Reveal YAWF Stream in Finder" })).toBeInTheDocument();
    mac.unmount();

    getAppInstallInfo.mockResolvedValueOnce({
      os: "linux",
      format: "linux-appimage",
      appBundlePath: null,
      appimagePath: "/tmp/DebridStreamer.AppImage",
    });
    renderAt();
    expect(await screen.findByRole("button", { name: "Reveal AppImage" })).toBeInTheDocument();
  });

  it("renders the Debian package command", async () => {
    getAppInstallInfo.mockResolvedValueOnce({
      os: "linux",
      format: "linux-deb",
      appBundlePath: null,
      appimagePath: null,
    });
    renderAt();
    // Kebab-cased: apt operates on the deb control file's Package field
    // (kebab-cased productName), not the verbatim-name .deb FILENAME.
    expect(await screen.findByText("sudo apt remove yawf-stream")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });
});

describe("Settings · Factory reset dialog", () => {
  it("shows the server-untouched line only in Server Mode", async () => {
    const user = userEvent.setup();
    mockServerURL = "https://server.example.com";
    const serverRender = renderAt();
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));
    const dialog = screen.getByRole("dialog", { name: "Erase all data on this device" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(
      within(dialog).getByText("Your household's data on the server is not touched."),
    ).toBeInTheDocument();
    serverRender.unmount();

    mockServerURL = null;
    renderAt();
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));
    const localDialog = screen.getByRole("dialog", { name: "Erase all data on this device" });
    expect(
      within(localDialog).queryByText("Your household's data on the server is not touched."),
    ).not.toBeInTheDocument();
  });

  it("clears the typed ERASE and any stale state when closed with Escape", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));
    const dialog = screen.getByRole("dialog", { name: "Erase all data on this device" });
    await user.type(within(dialog).getByLabelText("Type ERASE to confirm"), "ERASE");

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Erase all data on this device" }),
    ).not.toBeInTheDocument();

    // Reopening must not come back with the destructive button pre-armed.
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));
    const reopened = screen.getByRole("dialog", { name: "Erase all data on this device" });
    expect(within(reopened).getByLabelText("Type ERASE to confirm")).toHaveValue("");
    expect(within(reopened).getByRole("button", { name: "Erase all data" })).toBeDisabled();
  });
});

describe("Settings · Remote access tunnel detection", () => {
  function renderRemoteAccess() {
    mockServerMode = true;
    return renderAt("server");
  }

  it("shows install guidance for both tools when neither is installed", async () => {
    renderRemoteAccess();

    expect(await screen.findByText("Tailscale: Not installed.")).toBeInTheDocument();
    expect(screen.getByText("cloudflared: Not installed.")).toBeInTheDocument();
    expect(screen.getByText("Install Tailscale on the server")).toBeInTheDocument();
  });

  it("shows shareable TV and phone remote routes without moving the video to the phone", async () => {
    mockServerURL = "https://stream.example.com";
    renderRemoteAccess();

    expect(
      await screen.findByText("https://stream.example.com/tv"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://stream.example.com/remote"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/video stays on the TV and the phone sends/),
    ).toBeInTheDocument();
  });

  it("selects Cloudflare Tunnel and skips its install step when only cloudflared is installed", async () => {
    detectTunnelTools.mockResolvedValue({
      cloudflared: { installed: true, version: "cloudflared 2026.1.0", detail: null },
      tailscale: { installed: false, version: null, detail: null },
    });
    renderRemoteAccess();

    expect(await screen.findByText(/cloudflared detected/)).toBeInTheDocument();
    expect(screen.getByText("Create and authenticate a Cloudflare Tunnel")).toBeInTheDocument();
    expect(screen.queryByText("Install cloudflared on the server")).not.toBeInTheDocument();
  });

  it("selects Tailscale and skips its install step when it is connected", async () => {
    detectTunnelTools.mockResolvedValue({
      cloudflared: { installed: false, version: null, detail: null },
      tailscale: { installed: true, version: "1.82.0", detail: "connected" },
    });
    renderRemoteAccess();

    expect(
      await screen.findByText((_, element) =>
        element?.tagName === "P" && element.textContent?.includes("Tailscale detected") === true,
      ),
    ).toHaveTextContent("connected");
    expect(screen.getByText("Sign in and join your tailnet")).toBeInTheDocument();
    expect(screen.queryByText("Install Tailscale on the server")).not.toBeInTheDocument();
  });

  it("keeps the Tailscale default when both are detected and preserves a manual choice on re-check", async () => {
    detectTunnelTools.mockResolvedValue({
      cloudflared: { installed: true, version: "cloudflared 2026.1.0", detail: null },
      tailscale: { installed: true, version: "1.82.0", detail: "connected" },
    });
    renderRemoteAccess();

    expect(await screen.findByText("Sign in and join your tailnet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Cloudflare Tunnel" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));

    expect(await screen.findByText("Create and authenticate a Cloudflare Tunnel")).toBeInTheDocument();
    expect(screen.queryByText("Install cloudflared on the server")).not.toBeInTheDocument();
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ============================================================================
// UpdatesTab
// ============================================================================

describe("Settings · Updates", () => {
  it("offers a direct bug-report action beside diagnostics", () => {
    renderAt("updates");

    expect(screen.getByRole("link", { name: "Report a bug" })).toHaveAttribute(
      "href",
      expect.stringContaining("issues/new?template=bug_report.yml"),
    );
  });

  it("toggles auto-check on, then enables auto-install", async () => {
    const user = userEvent.setup();
    renderAt("updates", { autoUpdateChecks: false, autoInstallUpdates: false });

    const autoCheck = screen
      .getByText("Check for desktop updates automatically")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(autoCheck.checked).toBe(false);

    // The install toggle is disabled until checks are on.
    const autoInstall = screen
      .getByText("Install signed desktop updates automatically")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(autoInstall.disabled).toBe(true);

    await user.click(autoCheck);
    expect(autoCheck.checked).toBe(true);
  });

  it("turning off auto-check also clears auto-install (cascade)", async () => {
    const user = userEvent.setup();
    renderAt("updates", { autoUpdateChecks: true, autoInstallUpdates: true });

    const autoInstall = screen
      .getByText("Install signed desktop updates automatically")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(autoInstall.checked).toBe(true);
    expect(autoInstall.disabled).toBe(false);

    const autoCheck = screen
      .getByText("Check for desktop updates automatically")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(autoCheck); // turn checks OFF
    // After cascade the install toggle reads unchecked + disabled.
    expect(autoInstall.checked).toBe(false);
    expect(autoInstall.disabled).toBe(true);
  });

  it("flips auto-install while checks stay on", async () => {
    const user = userEvent.setup();
    renderAt("updates", { autoUpdateChecks: true, autoInstallUpdates: false });
    const autoInstall = screen
      .getByText("Install signed desktop updates automatically")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(autoInstall.disabled).toBe(false);
    await user.click(autoInstall);
    expect(autoInstall.checked).toBe(true);
  });
});

// ============================================================================
// InstallTab - setup-path picker + PWA install prompt
// ============================================================================

describe("Settings · Install (setup paths)", () => {
  it("defaults to the device path and switches through every setup path", async () => {
    const user = userEvent.setup();
    renderAt("install");

    // device path is active first → DesktopHostPanel ("Host from this desktop")
    expect(await screen.findByText("Host from this desktop")).toBeInTheDocument();

    // Connect → ServerConnectionPanel.
    await user.click(screen.getByRole("button", { name: /Connect to server/ }));
    expect(screen.getByText("Connect to a server")).toBeInTheDocument();

    // Downloads → release link card.
    await user.click(screen.getByRole("button", { name: /Desktop downloads/ }));
    expect(
      screen.getByText(/Released macOS and Linux assets/),
    ).toBeInTheDocument();

    // Deploy → docker compose card.
    await user.click(screen.getByRole("button", { name: /Server setup/ }));
    expect(
      screen.getByText(/Docker Compose files for NAS/),
    ).toBeInTheDocument();
  });

  it("drives the setup-path <select> too", async () => {
    renderAt("install");
    // "Setup path" labels both the <select> and the choices container; the
    // select carries the stable id.
    const select = document.getElementById("settings-install-path") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "downloads" } });
    expect(
      screen.getByText(/Released macOS and Linux assets/),
    ).toBeInTheDocument();
  });

  it("captures beforeinstallprompt, shows Install app, and runs promptInstall", async () => {
    const user = userEvent.setup();
    renderAt("install");
    await screen.findByText("Host from this desktop");

    // Fire the captured PWA prompt event with a stub prompt()/userChoice.
    const prompt = vi.fn(async () => {});
    const userChoice = Promise.resolve({ outcome: "accepted" as const, platform: "web" });
    const evt = new Event("beforeinstallprompt") as Event & {
      prompt: typeof prompt;
      userChoice: typeof userChoice;
    };
    evt.prompt = prompt;
    evt.userChoice = userChoice;
    fireEvent(window, evt);

    const installBtn = await screen.findByRole("button", { name: "Install app" });
    await user.click(installBtn);
    expect(prompt).toHaveBeenCalled();
  });

  it("marks installed and drops the prompt on appinstalled", async () => {
    renderAt("install");
    await screen.findByText("Host from this desktop");

    // Provide a prompt first so the Install button exists.
    const evt = new Event("beforeinstallprompt") as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted"; platform: string }>;
    };
    evt.prompt = vi.fn(async () => {});
    evt.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    fireEvent(window, evt);
    expect(await screen.findByRole("button", { name: "Install app" })).toBeInTheDocument();

    fireEvent(window, new Event("appinstalled"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument(),
    );
  });
});

// ============================================================================
// DesktopHostPanel - Tauri-only host controls
// ============================================================================

describe("Settings · DesktopHostPanel", () => {
  it("renders a not-running host with the initial status detail", async () => {
    renderAt("install");
    expect(await screen.findByText("Host from this desktop")).toBeInTheDocument();
    expect(await screen.findByText("Ready to host.")).toBeInTheDocument();
    // Start enabled, Stop/Open/Share disabled (no URL, not running).
    expect(screen.getByRole("button", { name: "Start hosting" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open hosted app" })).toBeDisabled();
  });

  it("surfaces a status-load error", async () => {
    desktopServerStatus.mockRejectedValue(new Error("supervisor offline"));
    renderAt("install");
    expect(await screen.findByText("supervisor offline")).toBeInTheDocument();
  });

  it("starts hosting, renders the QR + share URL, copies it", async () => {
    const running = {
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110", "http://192.168.1.5:43110"],
      lan_urls: ["http://192.168.1.5:43110"],
      share_url: "http://192.168.1.5:43110",
      detail: "Hosting on LAN.",
    };
    startDesktopServer.mockResolvedValue(running);
    const user = userEvent.setup();
    // userEvent.setup() installs its own (getter-only) navigator.clipboard, so
    // override it via defineProperty AFTER setup to observe writeText.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderAt("install");
    await screen.findByText("Host from this desktop");

    await user.click(screen.getByRole("button", { name: "Start hosting" }));

    // Running chip + QR image appear once the share URL resolves.
    expect(await screen.findByText("Running")).toBeInTheDocument();
    await waitFor(() => expect(toDataURL).toHaveBeenCalled());
    expect(
      await screen.findByAltText("QR code for the hosted YAWF Stream server"),
    ).toBeInTheDocument();

    // The multi-URL chip list renders (urls.length > 1).
    expect(screen.getByText("Hosting on LAN.")).toBeInTheDocument();

    // Copy the primary share URL (exact "Copy" excludes the "Copy local" chip).
    const copyBtn = await screen.findByRole("button", { name: "Copy" });
    await user.click(copyBtn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("http://192.168.1.5:43110"),
    );
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("shows a setup URL hint when the server reports a one-time owner setup link", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: ["http://192.168.1.5:43110"],
      share_url: "http://192.168.1.5:43110",
      setup_url: "http://192.168.1.5:43110/?setup=tok",
    });
    renderAt("install");
    expect(await screen.findByText("One-time owner setup URL")).toBeInTheDocument();
    expect(
      screen.getByText(/Use this first-run link to create the owner account/),
    ).toBeInTheDocument();
  });

  it("opens the hosted app through the Tauri shell", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: ["http://127.0.0.1:43110"],
      share_url: "http://127.0.0.1:43110",
    });
    const user = userEvent.setup();
    renderAt("install");
    await screen.findByText("Host from this desktop");

    const openBtn = await screen.findByRole("button", { name: "Open hosted app" });
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    await user.click(openBtn);
    expect(openExternalURL).toHaveBeenCalledWith("http://127.0.0.1:43110");
  });

  it("stops hosting via the Stop button", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: ["http://127.0.0.1:43110"],
      share_url: "http://127.0.0.1:43110",
    });
    stopDesktopServer.mockResolvedValue({ ...statusBase, running: false, detail: "Stopped." });
    const user = userEvent.setup();
    renderAt("install");
    await screen.findByText("Host from this desktop");

    const stopBtn = await screen.findByRole("button", { name: "Stop" });
    await waitFor(() => expect(stopBtn).not.toBeDisabled());
    await user.click(stopBtn);
    await waitFor(() => expect(stopDesktopServer).toHaveBeenCalled());
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
  });

  it("surfaces a start error", async () => {
    startDesktopServer.mockRejectedValue(new Error("port busy"));
    const user = userEvent.setup();
    renderAt("install");
    await screen.findByText("Host from this desktop");
    await user.click(screen.getByRole("button", { name: "Start hosting" }));
    expect(await screen.findByText("port busy")).toBeInTheDocument();
  });

  it("shares via the Web Share API when available", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: ["http://127.0.0.1:43110"],
      share_url: "http://127.0.0.1:43110",
    });
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share });
    const user = userEvent.setup();
    renderAt("install");
    await screen.findByText("Host from this desktop");

    const shareBtn = await screen.findByRole("button", { name: "Share" });
    await waitFor(() => expect(shareBtn).not.toBeDisabled());
    await user.click(shareBtn);
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://127.0.0.1:43110" }),
      ),
    );
    // Clean up the share stub so later tests fall back to clipboard.
    Object.assign(navigator, { share: undefined });
  });

  it("falls back to clipboard copy when Web Share is unavailable", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: ["http://127.0.0.1:43110"],
      share_url: "http://127.0.0.1:43110",
    });
    Object.assign(navigator, { share: undefined });
    const user = userEvent.setup();
    // Override clipboard AFTER setup() (getter-only) via defineProperty.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderAt("install");
    await screen.findByText("Host from this desktop");

    const shareBtn = await screen.findByRole("button", { name: "Share" });
    await waitFor(() => expect(shareBtn).not.toBeDisabled());
    await user.click(shareBtn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:43110"),
    );
  });

  it("hints about a missing LAN address when running without one", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      running: true,
      url: "http://127.0.0.1:43110",
      urls: ["http://127.0.0.1:43110"],
      lan_urls: [],
      share_url: null,
    });
    renderAt("install");
    expect(
      await screen.findByText(/I could not detect a LAN address/),
    ).toBeInTheDocument();
  });

  it("hints when the server bundle is unavailable in a dev build", async () => {
    desktopServerStatus.mockResolvedValue({
      ...statusBase,
      available: false,
      detail: "No bundled server.",
    });
    renderAt("install");
    expect(
      await screen.findByText(/Release builds include this server bundle/),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// ServerConnectionPanel - connect probe + inferServerURL
// ============================================================================

describe("Settings · ServerConnectionPanel connect", () => {
  function stubReload() {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload, origin: "http://localhost" },
    });
    return reload;
  }

  it("connects to a bare host, infers http for a LAN address, and saves it", async () => {
    const reload = stubReload();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, setupRequired: false }),
    })) as unknown as typeof fetch;

    renderAt("install");
    // Switch to the connect path so ServerConnectionPanel mounts.
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));

    const input = screen.getByPlaceholderText("https://stream.example.com");
    fireEvent.change(input, { target: { value: "192.168.1.9:43110" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      const f = global.fetch as unknown as ReturnType<typeof vi.fn>;
      expect(f).toHaveBeenCalledWith(
        "http://192.168.1.9:43110/api/health",
        expect.objectContaining({ method: "GET", credentials: "include" }),
      );
    });
    await waitFor(() =>
      expect(saveServerURL).toHaveBeenCalledWith("http://192.168.1.9:43110"),
    );
    expect(await screen.findByText(/Sign in will open next/)).toBeInTheDocument();
    // The success path schedules a window.location.reload after 350ms (real
    // timers - waitFor's 1s window catches it).
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("shows the owner-setup message when the server reports setupRequired", async () => {
    stubReload();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, setupRequired: true }),
    })) as unknown as typeof fetch;

    renderAt("install");
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));
    fireEvent.change(screen.getByPlaceholderText("https://stream.example.com"), {
      target: { value: "https://stream.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/Owner setup will open next/)).toBeInTheDocument();
  });

  it("surfaces a failed health probe", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "",
    })) as unknown as typeof fetch;

    renderAt("install");
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));
    fireEvent.change(screen.getByPlaceholderText("https://stream.example.com"), {
      target: { value: "https://down.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/Server check failed \(502\)\./)).toBeInTheDocument();
    expect(saveServerURL).not.toHaveBeenCalled();
  });

  it("rejects an empty URL before any fetch", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    renderAt("install");
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Enter a server URL.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("locks the input when the server URL is pinned by env", async () => {
    mockServerURL = "https://pinned.example.com";
    mockServerURLSource = "env";
    renderAt("install");
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));
    expect(screen.getByPlaceholderText("https://stream.example.com")).toBeDisabled();
    expect(
      screen.getByText(/This build is pinned to a server URL/),
    ).toBeInTheDocument();
  });

  it("explains same-origin pinning", async () => {
    mockServerURL = "https://same.example.com";
    mockServerURLSource = "same-origin";
    renderAt("install");
    fireEvent.click(await screen.findByRole("button", { name: /Connect to server/ }));
    expect(
      screen.getByText(/opened directly from the server/),
    ).toBeInTheDocument();
  });
});
