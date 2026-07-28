// @vitest-environment jsdom
//
// Render/interaction tests for the LOCAL-MODE Settings panels (partA):
// Appearance, API keys (catalog + assistant), Providers (debrid tokens), and
// Sources (built-in toggle + external indexers). The server-side panels are
// covered separately in partB. Everything here runs in Local Mode
// (isServerMode() === false), so the Server tab is hidden and the non-server
// panels are the focus.
//
// The component is dependency-heavy, so the external modules are mocked: the
// app store (settings draft + updateSettings spy + simpleMode), the server
// session context, serverMode/tauri/serverSession/serverApi/smartPreload. The
// real ../data/settings defaultSettings() seeds a complete draft, and the real
// debrid/ai model modules drive the provider/option lists (no mock needed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultSettings, type AppSettings } from "../data/settings";
import type { SettingsSection } from "../lib/settingsNavigation";

// --- mutable mock state -----------------------------------------------------

let mockSettings: AppSettings = defaultSettings();
let mockSimpleMode = false;
let mockPendingSettingsSection: SettingsSection | null = null;
const updateSettings = vi.fn();
const clearPendingSettingsSection = vi.fn(() => {
  mockPendingSettingsSection = null;
});
const getAppVersion = vi.hoisted(() => vi.fn(async () => "test-version"));
const setSmartPreloadEnabled = vi.fn();
const isTraktConnected = vi.hoisted(() => vi.fn());
const loadTraktConnection = vi.hoisted(() => vi.fn());
const clearTraktConnection = vi.hoisted(() => vi.fn());
const factoryReset = vi.hoisted(() => vi.fn());
const testDebridToken = vi.hoisted(() => vi.fn());
const fetchAvailableModels = vi.hoisted(() => vi.fn(async () => ["custom-model-1", "custom-model-2"]));
// vi.fn now takes the whole function signature as its type argument, so pin the
// mock to the real ModelCache signature instead of letting `async () => null`
// narrow the resolved type to `null`.
const readModelCache = vi.hoisted(() =>
  vi.fn<typeof import("../services/ai/ModelCache").readModelCache>(async () => null),
);
const writeModelCache = vi.hoisted(() => vi.fn(async () => undefined));
let smartPreloadOn = false;

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    simpleMode: mockSimpleMode,
    pendingSettingsSection: mockPendingSettingsSection,
    clearPendingSettingsSection,
  }),
  useSimpleMode: () => mockSimpleMode,
}));

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => false,
  configuredServerURL: () => null,
  configuredServerURLSource: () => null,
  saveServerURL: vi.fn(),
}));

vi.mock("../lib/appVersion", () => ({ getAppVersion }));

vi.mock("../lib/tauri", () => ({
  isTauri: () => false,
  getAppInstallInfo: vi.fn(),
  revealInFileManager: vi.fn(),
  listExternalPlayers: vi.fn(async () => []),
  desktopServerStatus: vi.fn(async () => null),
  startDesktopServer: vi.fn(),
  stopDesktopServer: vi.fn(),
  openExternalURL: vi.fn(),
}));

vi.mock("../data/factoryReset", () => ({ factoryReset }));

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
  isSmartPreloadEnabled: () => smartPreloadOn,
  setSmartPreloadEnabled: (v: boolean) => {
    smartPreloadOn = v;
    setSmartPreloadEnabled(v);
  },
}));

vi.mock("../services/ai/ModelCache", () => ({
  readModelCache,
  writeModelCache,
}));

vi.mock("../services/ai/ModelCatalog", () => ({ fetchAvailableModels }));

vi.mock("../lib/onboardingValidation", () => ({ testDebridToken }));

vi.mock("../data/traktConnection", () => ({
  isTraktConnected,
  loadTraktConnection,
  clearTraktConnection,
}));

vi.mock("../components/TraktConnectDialog", () => ({
  TraktConnectDialog: ({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) => (
    <div>
      <span>Mock Trakt Connect Dialog</span>
      <button type="button" onClick={onClose}>
        Close Trakt dialog
      </button>
      <button type="button" onClick={onConnected}>
        Simulate Trakt connection
      </button>
    </div>
  ),
}));

// QRCode is only used in desktop-host (mocked tauri = not desktop), but import
// it harmlessly so the module graph stays satisfied.
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:,") } }));

import { Settings, visibleTabs } from "./Settings";

// --- helpers ----------------------------------------------------------------

/** Render Settings with a fresh draft (optionally pre-seeded) + click a tab. */
function renderAt(tab?: string, seed?: Partial<AppSettings>) {
  if (seed) mockSettings = { ...defaultSettings(), ...seed };
  const utils = render(<Settings />);
  if (tab) {
    const chip = utils.container.querySelector(`button[data-tab="${tab}"]`);
    if (chip) fireEvent.click(chip);
  }
  return utils;
}

beforeEach(() => {
  mockSettings = defaultSettings();
  mockSimpleMode = false;
  mockPendingSettingsSection = null;
  smartPreloadOn = false;
  updateSettings.mockClear();
  clearPendingSettingsSection.mockClear();
  getAppVersion.mockClear();
  setSmartPreloadEnabled.mockClear();
  isTraktConnected.mockReset();
  loadTraktConnection.mockReset();
  clearTraktConnection.mockReset();
  factoryReset.mockReset();
  testDebridToken.mockReset();
  fetchAvailableModels.mockReset();
  fetchAvailableModels.mockResolvedValue(["custom-model-1", "custom-model-2"]);
  readModelCache.mockReset();
  writeModelCache.mockReset();
  readModelCache.mockResolvedValue(null);
  writeModelCache.mockResolvedValue(undefined);
  factoryReset.mockResolvedValue(undefined);
  isTraktConnected.mockResolvedValue(false);
  loadTraktConnection.mockResolvedValue(null);
  clearTraktConnection.mockResolvedValue(undefined);
  testDebridToken.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Shell / tab visibility
// ============================================================================

describe("Settings shell", () => {
  it("puts settings search first and removes the Control center kicker", () => {
    renderAt();
    const search = screen.getByLabelText("Search settings");
    const experience = screen.getByRole("radiogroup", { name: "Experience tier" });

    expect(search.compareDocumentPosition(experience) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Control center")).toBeNull();
  });

  it("shows the app version on the landing shell", async () => {
    renderAt();
    expect(await screen.findByText("YAWF Stream vtest-version")).toBeInTheDocument();
  });

  it("returns to the top when the settings category changes", () => {
    const { container } = render(
      <div className="app-content">
        <Settings />
      </div>,
    );
    const scroller = container.querySelector(".app-content") as HTMLElement;
    scroller.scrollTop = 900;

    fireEvent.click(container.querySelector('button[data-tab="appearance"]')!);
    expect(scroller.scrollTop).toBe(0);
  });

  it("gives playback selects stable accessible names", () => {
    mockSettings = {
      ...defaultSettings(),
      debridTokens: [{ service: "real_debrid", apiToken: "tok" }],
    };
    renderAt("playback");

    expect(screen.getByRole("combobox", { name: "Maximum quality" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Maximum file size" })).toBeInTheDocument();
  });

  it("hides the Server tab in Local Mode", () => {
    renderAt();
    const tabs = screen.getByText("Settings").closest(".settings-screen")!;
    expect(within(tabs as HTMLElement).queryByRole("button", { name: "Server" })).toBeNull();
    // visibleTabs pure helper agrees.
    expect(visibleTabs({ serverMode: false, simpleMode: false }).some((t) => t.id === "server")).toBe(
      false,
    );
  });

  it("shows the full advanced tab set and defaults to Appearance when configured", () => {
    // A configured profile (has a debrid token) keeps the familiar default tab.
    mockSettings = {
      ...defaultSettings(),
      debridTokens: [{ service: "real_debrid", apiToken: "tok" }],
    };
    renderAt();
    // Appearance is the default tab and starts with visual style choices.
    expect(screen.getByText("Choose a style")).toBeInTheDocument();
    // Sources tab chip is present in advanced mode.
    expect(document.querySelector('button[data-tab="sources"]')).not.toBeNull();
  });

  it("defaults to Install & setup when nothing is configured", () => {
    // Unconfigured (no debrid tokens) → land on the critical path, not the
    // Appearance dial-park.
    renderAt();
    expect(screen.queryByText("Choose a style")).toBeNull();
    expect(
      document.querySelector('button[data-tab="install"]')?.className ?? "",
    ).toContain("is-active");
  });

  it("opens a one-time section requested by another screen", () => {
    mockPendingSettingsSection = "keys";

    renderAt();

    expect(
      document.querySelector('button[data-tab="keys"]')?.className ?? "",
    ).toContain("is-active");
    expect(clearPendingSettingsSection).toHaveBeenCalledTimes(1);
  });

  it("keeps Help and diagnostics visible in Simple mode while hiding Sources", () => {
    mockSimpleMode = true;
    renderAt();
    expect(document.querySelector('button[data-tab="sources"]')).toBeNull();
    expect(document.querySelector('button[data-tab="updates"]')).not.toBeNull();
    // Essentials remain.
    expect(document.querySelector('button[data-tab="appearance"]')).not.toBeNull();
    expect(document.querySelector('button[data-tab="keys"]')).not.toBeNull();
  });

  it("Save is disabled when there are no unsaved changes", () => {
    // Configured → lands on Appearance, where the save footer renders (the
    // Install & setup tab intentionally has no footer).
    mockSettings = {
      ...defaultSettings(),
      debridTokens: [{ service: "real_debrid", apiToken: "tok" }],
    };
    renderAt();
    const save = screen.getByRole("button", { name: "Up to date" });
    expect(save).toBeDisabled();
  });

  it("Experience segmented control flips Local Mode simpleMode through updateSettings", async () => {
    const user = userEvent.setup();
    renderAt();
    expect(screen.getByRole("radio", { name: "Advanced" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "About Experience tier" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Calendar, Assistant, and Debrid",
    );

    // Currently advanced. Click "Simple".
    const simpleBtn = screen.getByRole("radio", { name: "Simple" });
    await user.click(simpleBtn);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ simpleMode: true }));
  });
});

// ============================================================================
// Keys tab - catalog + assistant credentials
// ============================================================================

describe("Settings · API keys (catalog)", () => {
  it("writes the TMDB key into the draft via patch", async () => {
    const user = userEvent.setup();
    renderAt("keys");
    const tmdb = screen.getByPlaceholderText("v3 API key");
    await user.type(tmdb, "abc");
    expect((tmdb as HTMLInputElement).value).toBe("abc");
  });

  it("shows OMDB key in Advanced and hides it in Simple", () => {
    renderAt("keys");
    expect(screen.getByPlaceholderText("OMDB key")).toBeInTheDocument();
  });

  it("hides the OMDB (advanced-only) key in Simple mode", () => {
    mockSimpleMode = true;
    renderAt("keys");
    // OpenSubtitles remains (not advanced-gated), OMDB is gone.
    expect(screen.getByPlaceholderText("OpenSubtitles key")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("OMDB key")).toBeNull();
  });

  it("captures an OMDB key in advanced mode", async () => {
    const user = userEvent.setup();
    renderAt("keys");

    const omdb = screen.getByPlaceholderText("OMDB key");
    await user.clear(omdb);
    await user.type(omdb, "abc-omdb");
    expect(omdb).toHaveValue("abc-omdb");
  });

  it("reflects an existing OpenSubtitles key value from the draft", () => {
    renderAt("keys", { openSubtitlesApiKey: "os-key-123" });
    expect(screen.getByPlaceholderText("OpenSubtitles key")).toHaveValue("os-key-123");
  });

  it("keeps Connect disabled until both Trakt credentials are present", async () => {
    renderAt("keys");
    const connect = await screen.findByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
  });

  it("updates the Trakt client ID", async () => {
    const user = userEvent.setup();
    renderAt("keys");

    const traktId = screen.getByPlaceholderText("Client ID") as HTMLInputElement;
    await user.clear(traktId);
    await user.type(traktId, "client-id");

    expect(traktId).toHaveValue("client-id");
  });

  it("disconnects an existing Trakt connection", async () => {
    const user = userEvent.setup();
    isTraktConnected.mockResolvedValue(true);
    loadTraktConnection.mockResolvedValue({
      meta: { username: "alice" },
    });
    renderAt("keys", { traktClientId: "client", traktClientSecret: "secret" });

    expect(await screen.findByText("Connected as alice")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(clearTraktConnection).toHaveBeenCalledTimes(1));
  });

  it("enables opt-in Trakt scrobbling only after Trakt connects", async () => {
    const user = userEvent.setup();
    const first = renderAt("keys", { traktClientId: "client", traktClientSecret: "secret" });
    const toggle = await screen.findByRole("checkbox", { name: /Scrobble to Trakt/ });
    expect(toggle).toBeDisabled();
    first.unmount();

    isTraktConnected.mockResolvedValue(true);
    loadTraktConnection.mockResolvedValue({ meta: { username: "alice" } });
    renderAt("keys", { traktClientId: "client", traktClientSecret: "secret" });
    const connectedToggle = await screen.findByRole("checkbox", {
      name: /Scrobble to Trakt/,
    });
    expect(connectedToggle).toBeEnabled();
    await user.click(connectedToggle);
    expect(connectedToggle).toBeChecked();
  });

  it("updates trakt secret and opens/closes the Trakt connect dialog", async () => {
    const user = userEvent.setup();
    isTraktConnected.mockResolvedValueOnce(false);
    loadTraktConnection.mockResolvedValueOnce(null);
    isTraktConnected.mockResolvedValueOnce(true);
    loadTraktConnection.mockResolvedValueOnce({ meta: { username: "alice" } });

    renderAt("keys", { traktClientId: "client", traktClientSecret: "" });

    const traktSecret = screen.getByPlaceholderText("Client Secret") as HTMLInputElement;
    await user.type(traktSecret, "token");
    expect(traktSecret).toHaveValue("token");

    const connect = screen.getByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect).toBeEnabled());
    await user.click(connect);

    expect(screen.getByText("Mock Trakt Connect Dialog")).toBeInTheDocument();
    expect(isTraktConnected).toHaveBeenCalledTimes(1);
    expect(loadTraktConnection).toHaveBeenCalledTimes(0);

    await user.click(screen.getByRole("button", { name: "Simulate Trakt connection" }));
    await waitFor(() => expect(isTraktConnected).toHaveBeenCalledTimes(2));
    expect(loadTraktConnection).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close Trakt dialog" }));
    expect(screen.queryByText("Mock Trakt Connect Dialog")).toBeNull();
  });

  it("falls back to Not connected when Trakt probe throws", async () => {
    isTraktConnected.mockRejectedValue(new Error("network down"));

    renderAt("keys", { traktClientId: "client", traktClientSecret: "secret" });

    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(loadTraktConnection).not.toHaveBeenCalled();
  });

  it("switches to the Assistant AI panel and shows the provider select", async () => {
    const user = userEvent.setup();
    renderAt("keys");
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));
    // Default provider is anthropic → an Anthropic API key field is shown.
    expect(screen.getByPlaceholderText("API key")).toBeInTheDocument();
  });

  it("switches credential groups using the selector", async () => {
    const user = userEvent.setup();
    renderAt("keys");

    const panelSelect = screen.getByRole("combobox", { name: "Credential group" }) as HTMLSelectElement;
    await user.selectOptions(panelSelect, "assistant");

    expect(screen.getByRole("combobox", { name: "AI provider" })).toBeInTheDocument();
    expect(screen.queryByText("TMDB API key")).toBeNull();
  });

  it("resets an explicit model override when provider changes", async () => {
    const user = userEvent.setup();
    renderAt("keys", {
      aiProvider: "anthropic",
      aiModel: "gpt-4o-mini",
    });

    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));
    const modelSelect = screen.getByRole("combobox", { name: "AI model" }) as HTMLSelectElement;
    const providerSelect = screen.getByRole("combobox", { name: "AI provider" }) as HTMLSelectElement;

    expect(modelSelect.value).toBe("gpt-4o-mini");
    await user.selectOptions(providerSelect, "ollama");
    expect(modelSelect.value).toBe("__default");
  });

  it("writes model selection from the model picker", async () => {
    const user = userEvent.setup();
    renderAt("keys", { aiProvider: "anthropic", aiApiKey: "test-api-key" });
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));

    const modelSelect = screen.getByRole("combobox", { name: "AI model" }) as HTMLSelectElement;
    await user.selectOptions(modelSelect, "claude-opus-4-8");

    expect(modelSelect.value).toBe("claude-opus-4-8");
  });

  it("refreshes live model catalog from the model panel", async () => {
    const user = userEvent.setup();
    renderAt("keys", { aiProvider: "anthropic", aiApiKey: "test-api-key" });
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await user.click(refresh);

    expect(fetchAvailableModels).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "anthropic",
        apiKey: "test-api-key",
      }),
    );
  });

  it("uses cached model data when available", async () => {
    const now = Date.now();
    readModelCache.mockResolvedValue({
      models: ["cached-model"],
      fetchedAt: now,
      stale: false,
    });

    renderAt("keys", { aiProvider: "anthropic", aiApiKey: "test-api-key" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));

    await waitFor(() => {
      const modelSelect = screen.getByRole("combobox", { name: "AI model" }) as HTMLSelectElement;
      expect(within(modelSelect).getByRole("option", { name: "cached-model" })).toBeInTheDocument();
    });
  });

  it("reports a warning when live model refresh fails", async () => {
    const user = userEvent.setup();
    fetchAvailableModels.mockRejectedValue(new Error("model refresh failed"));

    renderAt("keys", { aiProvider: "anthropic", aiApiKey: "test-api-key" });
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await user.click(refresh);

    expect(await screen.findByText("model refresh failed")).toBeInTheDocument();
  });

  it("shows the Ollama endpoint field (not a secret) when provider is ollama", async () => {
    const user = userEvent.setup();
    renderAt("keys", { aiProvider: "ollama" });
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));
    expect(screen.getByPlaceholderText("http://localhost:11434")).toBeInTheDocument();
    // No API-key secret field in ollama mode.
    expect(screen.queryByPlaceholderText("API key")).toBeNull();

    const endpoint = screen.getByPlaceholderText("http://localhost:11434") as HTMLInputElement;
    await user.clear(endpoint);
    await user.type(endpoint, "http://localhost:11435");
    expect(endpoint).toHaveValue("http://localhost:11435");
  });

  it("allows typing into the Assistant AI key field", async () => {
    const user = userEvent.setup();
    renderAt("keys");
    await user.click(screen.getByRole("button", { name: /Assistant AI/ }));
    const apiKey = screen.getByPlaceholderText("API key");
    await user.type(apiKey, "secret-api-key");
    expect(apiKey).toHaveValue("secret-api-key");
  });

  it("updates the OpenSubtitles API key in Advanced mode", async () => {
    const user = userEvent.setup();
    renderAt("keys", { openSubtitlesApiKey: "os-old" });

    const openSubtitlesKey = screen.getByPlaceholderText("OpenSubtitles key") as HTMLInputElement;
    await user.clear(openSubtitlesKey);
    await user.type(openSubtitlesKey, "os-new");

    expect(openSubtitlesKey).toHaveValue("os-new");
  });
});

// ============================================================================
// SecretInput behaviour (reveal / copy) - used across Keys/Debrid/Sources
// ============================================================================

describe("Settings · SecretInput", () => {
  it("toggles the TMDB secret between password and text", async () => {
    const user = userEvent.setup();
    renderAt("keys");
    const tmdb = screen.getByPlaceholderText("v3 API key") as HTMLInputElement;
    expect(tmdb.type).toBe("password");
    await user.click(screen.getAllByRole("button", { name: "Reveal secret" })[0]);
    expect(tmdb.type).toBe("text");
    await user.click(screen.getAllByRole("button", { name: "Hide secret" })[0]);
    expect(tmdb.type).toBe("password");
  });

  it('copies the secret and surfaces "Copied." on success', async () => {
    const user = userEvent.setup();
    // Override the clipboard AFTER userEvent.setup() (which installs its own stub)
    // so the component's navigator.clipboard.writeText hits our spy.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderAt("keys", { tmdbKey: "k" });
    await user.click(screen.getAllByRole("button", { name: "Copy secret" })[0]);
    expect(writeText).toHaveBeenCalledWith("k");
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it('shows "Nothing to copy." for an empty secret without touching the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderAt("keys"); // empty tmdb
    await user.click(screen.getAllByRole("button", { name: "Copy secret" })[0]);
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByText("Nothing to copy.")).toBeInTheDocument();
  });

  it('shows "Clipboard unavailable." when copy fails', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new Error("copy blocked");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderAt("keys", { tmdbKey: "k" });
    await user.click(screen.getAllByRole("button", { name: "Copy secret" })[0]);
    expect(await screen.findByText("Clipboard unavailable.")).toBeInTheDocument();
  });
});

// ============================================================================
// Debrid (Providers) tab - token add / edit / clear, priority list
// ============================================================================

describe("Settings · Providers (debrid)", () => {
  it("adds a new token entry into the draft when typing for the selected service", async () => {
    const user = userEvent.setup();
    const { container } = renderAt("debrid");
    const token = screen.getByPlaceholderText("API token");
    await user.type(token, "tb-token");
    // The default selected service is TorBox (first in the canonical order),
    // so the priority chip list now lists TorBox as #1.
    expect(within(container).getByRole("button", { name: /1\. TorBox/ })).toBeInTheDocument();
  });

  it("renders existing tokens in priority order as chips", () => {
    const { container } = renderAt("debrid", {
      debridTokens: [
        { service: "all_debrid", apiToken: "a" },
        { service: "premiumize", apiToken: "p" },
      ],
    });
    const chips = within(container).getAllByRole("button", { name: /^\d+\. / });
    expect(chips[0]).toHaveTextContent("1. AllDebrid");
    expect(chips[1]).toHaveTextContent("2. Premiumize");
  });

  it("clearing a token removes that service's entry", () => {
    renderAt("debrid", {
      debridTokens: [{ service: "torbox", apiToken: "x" }],
    });
    const token = screen.getByPlaceholderText("API token") as HTMLInputElement;
    expect(token.value).toBe("x");
    // TorBox is the default selected service; clearing the field drops it.
    fireEvent.change(token, { target: { value: "" } });
    expect(screen.queryByRole("button", { name: /1\. TorBox/ })).toBeNull();
  });

  it("clicking a priority chip selects that service and loads its token", async () => {
    const user = userEvent.setup();
    renderAt("debrid", {
      debridTokens: [
        { service: "real_debrid", apiToken: "rd" },
        { service: "torbox", apiToken: "tb" },
      ],
    });
    const token = screen.getByPlaceholderText("API token") as HTMLInputElement;
    // Default selected = first canonical option (torbox) → shows "tb".
    expect(token.value).toBe("tb");
    await user.click(screen.getByRole("button", { name: /1\. Real-Debrid/ }));
    expect((screen.getByPlaceholderText("API token") as HTMLInputElement).value).toBe("rd");
  });

  it("editing an existing token preserves its priority position (in-place update)", () => {
    renderAt("debrid", {
      debridTokens: [
        { service: "real_debrid", apiToken: "rd" },
        { service: "torbox", apiToken: "tb" },
      ],
    });
    const token = screen.getByPlaceholderText("API token") as HTMLInputElement;
    fireEvent.change(token, { target: { value: "rd-new" } });
    // Still #1 Real-Debrid, #2 TorBox (no demotion).
    expect(screen.getByRole("button", { name: /1\. Real-Debrid/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2\. TorBox/ })).toBeInTheDocument();
  });

  it("switches the selected debrid provider in the dropdown", async () => {
    const user = userEvent.setup();
    renderAt("debrid", {
      debridTokens: [
        { service: "real_debrid", apiToken: "rd-token" },
        { service: "torbox", apiToken: "tb-token" },
      ],
    });

    const provider = screen.getByRole("combobox", { name: /Debrid provider/ });
    await user.selectOptions(provider, "all_debrid");

    expect(screen.getByRole("button", { name: /1\. Real-Debrid/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("API token")).toHaveValue("");
  });

  it("tests the selected provider token and reports a failed connection", async () => {
    const user = userEvent.setup();
    testDebridToken.mockResolvedValue(false);
    renderAt("debrid", {
      debridTokens: [{ service: "torbox", apiToken: "tb-token" }],
    });

    await user.click(screen.getByRole("button", { name: "Test connection" }));

    expect(testDebridToken).toHaveBeenCalledWith({
      service: "torbox",
      apiToken: "tb-token",
    });
    expect(
      await screen.findByText("Connection failed. Refresh the token or try again."),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// Sources tab - built-in toggle + external indexer CRUD
// ============================================================================

describe("Settings · Sources", () => {
  it("toggles built-in scrapers through patch", async () => {
    const user = userEvent.setup();
    renderAt("sources");
    const builtIn = screen
      .getByText("Built-in scrapers")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(builtIn.checked).toBe(false);
    await user.click(builtIn);
    expect(builtIn.checked).toBe(true);
  });

  it("shows the empty-state hint when there are no external indexers", () => {
    renderAt("sources");
    expect(
      screen.getByText(
        /No external sources. Add a source or explicitly enable the public built-in scrapers\./,
      ),
    ).toBeInTheDocument();
  });

  it("adds an external indexer from the selected preset", async () => {
    const user = userEvent.setup();
    renderAt("sources");
    const preset = screen.getByRole("combobox", { name: /Source preset/ });
    await user.selectOptions(preset, "zilean-local");
    await user.click(screen.getByRole("button", { name: /Add source/ }));
    // The selected preset is "Zilean local" → a Zilean source card appears.
    expect(screen.getByPlaceholderText("Display name")).toHaveValue("Zilean");
    expect(screen.queryByText(/No external sources/)).toBeNull();
  });

  it("renders an existing source with its protocol, name, enabled state, and removes it", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        {
          id: "s1",
          type: "prowlarr",
          baseURL: "http://localhost:9696",
          apiKey: "",
          isActive: true,
          displayName: "My Prowlarr",
          priority: 0,
        },
      ],
    });
    expect(screen.getByDisplayValue("My Prowlarr")).toBeInTheDocument();
    const enabled = screen.getByRole("checkbox", { name: /Enabled/ });
    expect(enabled).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Remove source" }));
    expect(screen.queryByDisplayValue("My Prowlarr")).toBeNull();
    expect(screen.getByText(/No external sources/)).toBeInTheDocument();
  });

  it("disables move-up on the first source and move-down on the last", () => {
    renderAt("sources", {
      sources: [
        { id: "a", type: "jackett", baseURL: "http://localhost:9117", apiKey: "", isActive: true, displayName: "A", priority: 0 },
        { id: "b", type: "zilean", baseURL: "http://localhost:8181", apiKey: "", isActive: true, displayName: "B", priority: 1 },
      ],
    });
    const ups = screen.getAllByRole("button", { name: "Move source up" });
    const downs = screen.getAllByRole("button", { name: "Move source down" });
    expect(ups[0]).toBeDisabled();
    expect(ups[1]).not.toBeDisabled();
    expect(downs[0]).not.toBeDisabled();
    expect(downs[1]).toBeDisabled();
  });

  it("reorders sources when move-down is clicked", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "a", type: "jackett", baseURL: "http://localhost:9117", apiKey: "", isActive: true, displayName: "Alpha", priority: 0 },
        { id: "b", type: "zilean", baseURL: "http://localhost:8181", apiKey: "", isActive: true, displayName: "Beta", priority: 1 },
      ],
    });
    const before = screen.getAllByPlaceholderText("Display name").map((i) => (i as HTMLInputElement).value);
    expect(before).toEqual(["Alpha", "Beta"]);
    await user.click(screen.getAllByRole("button", { name: "Move source down" })[0]);
    const after = screen.getAllByPlaceholderText("Display name").map((i) => (i as HTMLInputElement).value);
    expect(after).toEqual(["Beta", "Alpha"]);
  });

  it("moves a source up with the move button", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "a", type: "jackett", baseURL: "http://localhost:9117", apiKey: "", isActive: true, displayName: "Alpha", priority: 0 },
        { id: "b", type: "zilean", baseURL: "http://localhost:8181", apiKey: "", isActive: true, displayName: "Beta", priority: 1 },
      ],
    });
    const before = screen.getAllByPlaceholderText("Display name").map((i) => (i as HTMLInputElement).value);
    expect(before).toEqual(["Alpha", "Beta"]);
    await user.click(screen.getAllByRole("button", { name: "Move source up" })[1]);
    const after = screen.getAllByPlaceholderText("Display name").map((i) => (i as HTMLInputElement).value);
    expect(after).toEqual(["Beta", "Alpha"]);
  });

  it("surfaces an off-preset baseURL as a 'Current custom URL' choice in the preset select", () => {
    renderAt("sources", {
      sources: [
        { id: "s1", type: "jackett", baseURL: "https://my.custom.example", apiKey: "", isActive: true, displayName: "J", priority: 0 },
      ],
    });
    // sourceURLChoices injects the current value as a "Current custom URL" option,
    // so the preset select shows it as the selected choice (not the inline input).
    const urlSelect = screen.getByRole("combobox", { name: /URL preset/ }) as HTMLSelectElement;
    expect(urlSelect.value).toBe("https://my.custom.example");
    expect(within(urlSelect).getByRole("option", { name: "Current custom URL" })).toBeInTheDocument();
  });

  it("changing the URL preset to a built-in option updates the source baseURL", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "s1", type: "jackett", baseURL: "https://my.custom.example", apiKey: "", isActive: true, displayName: "J", priority: 0 },
      ],
    });
    const urlSelect = screen.getByRole("combobox", { name: /URL preset/ }) as HTMLSelectElement;
    await user.selectOptions(urlSelect, "http://localhost:9117");
    expect(urlSelect.value).toBe("http://localhost:9117");
  });

  it("edits an existing source display name", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "s1", type: "prowlarr", baseURL: "http://localhost:9696", apiKey: "", isActive: true, displayName: "My Feed", priority: 0 },
      ],
    });
    const nameInput = screen.getByPlaceholderText("Display name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Rebranded");
    expect(nameInput.value).toBe("Rebranded");
  });

  it("updates a source's custom URL when a custom preset is chosen", () => {
    renderAt("sources", {
      sources: [
        { id: "s1", type: "jackett", baseURL: "", apiKey: "", isActive: true, displayName: "Custom", priority: 0 },
      ],
    });
    const urlInput = screen.getByPlaceholderText("https://indexer.example.com") as HTMLInputElement;
    expect(urlInput).toBeInTheDocument();
    fireEvent.change(urlInput, { target: { value: "https://updated.example" } });
    expect(urlInput.value).toBe("https://updated.example");
  });

  it("toggles source enabled state", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        {
          id: "s1",
          type: "prowlarr",
          baseURL: "http://localhost:9696",
          apiKey: "",
          isActive: false,
          displayName: "My Prowlarr",
          priority: 0,
        },
      ],
    });
    const enabled = screen.getByRole("checkbox", { name: /Enabled/ }) as HTMLInputElement;
    expect(enabled).not.toBeChecked();
    await user.click(enabled);
    expect(enabled).toBeChecked();
  });

  it("writes a typed API key onto the source's secret input", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "s1", type: "prowlarr", baseURL: "http://localhost:9696", apiKey: "", isActive: true, displayName: "P", priority: 0 },
      ],
    });
    const apiKey = screen.getByPlaceholderText("API key (if required)") as HTMLInputElement;
    await user.type(apiKey, "secret-key");
    expect(apiKey.value).toBe("secret-key");
  });

  it("changing the protocol updates the source type and resets its base URL", async () => {
    const user = userEvent.setup();
    renderAt("sources", {
      sources: [
        { id: "s1", type: "jackett", baseURL: "http://localhost:9117", apiKey: "", isActive: true, displayName: "Keep", priority: 0 },
      ],
    });
    const protocol = screen.getByRole("combobox", { name: /Protocol/ });
    await user.selectOptions(protocol, "zilean");
    expect((protocol as HTMLSelectElement).value).toBe("zilean");
    // Display name preserved (non-empty), not clobbered by the preset default.
    expect(screen.getByDisplayValue("Keep")).toBeInTheDocument();
  });
});

// ============================================================================
// Appearance tab - instant-apply controls call applyAppearance/updateSettings
// ============================================================================

describe("Settings · Appearance", () => {
  it("applies a quick profile through updateSettings (instant apply)", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    await user.click(screen.getByRole("button", { name: "Apply Compact control style" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "midnight", appearanceDensity: "compact" }),
    );
  });

  it("changing Density instantly applies appearanceDensity", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    const densityGroup = screen.getByRole("radiogroup", { name: "Density" });
    await user.click(within(densityGroup).getByRole("radio", { name: "Compact" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearanceDensity: "compact" }),
    );
  });

  it("changing Text size applies appearanceTextSize", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    const group = screen.getByRole("radiogroup", { name: "Text size" });
    await user.click(within(group).getByRole("radio", { name: "XL" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearanceTextSize: "xl" }),
    );
  });

  it("selecting an accent swatch applies appearanceAccent", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    await user.click(screen.getByRole("radio", { name: "Cyan accent" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearanceAccent: "cyan" }),
    );
  });

  it("selecting a theme preset applies the theme", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    await user.click(screen.getByRole("button", { name: "Apply Midnight Studio style" }));
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "midnight" }));
  });

  it("the glass-blur range applies appearanceBlur", () => {
    renderAt("appearance");
    const range = screen.getByRole("slider", { name: "Glass blur" }) as HTMLInputElement;
    fireEvent.change(range, { target: { value: "10" } });
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ appearanceBlur: 10 }));
  });

  it("selecting a subtitle swatch applies subtitleTextColor", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    await user.click(screen.getByRole("radio", { name: "Subtitle color #ffe066" }));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ subtitleTextColor: "#ffe066" }),
    );
  });

  it("the subtitle font-scale range applies subtitleFontScale", () => {
    renderAt("appearance");
    const range = screen.getByRole("slider", { name: "Subtitle font scale" }) as HTMLInputElement;
    fireEvent.change(range, { target: { value: "1.4" } });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ subtitleFontScale: 1.4 }),
    );
  });

  it("the subtitle background range applies subtitleBgOpacity", () => {
    renderAt("appearance");
    const range = screen.getByRole("slider", { name: "Subtitle background opacity" }) as HTMLInputElement;
    fireEvent.change(range, { target: { value: "0.3" } });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ subtitleBgOpacity: 0.3 }),
    );
  });

  it("marks the saved subtitle color swatch active", () => {
    renderAt("appearance", { subtitleTextColor: "#9be7ff" });
    const swatch = screen.getByRole("radio", { name: "Subtitle color #9be7ff" });
    expect(swatch).toHaveAttribute("aria-checked", "true");
    expect(swatch).toHaveClass("is-active");
  });

  it("toggling Smart preloading writes the per-device preference", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    const toggle = screen
      .getByText("Smart preloading")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);
    expect(setSmartPreloadEnabled).toHaveBeenCalledWith(true);
    expect(toggle.checked).toBe(true);
  });

  it("toggles the persistent poster-rating preference", async () => {
    const user = userEvent.setup();
    renderAt("appearance");
    const toggle = screen
      .getByText("Show ratings on posters")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await user.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ showPosterRatings: false }),
    );
  });

  it("Replay welcome guide dispatches the ds:open-welcome-guide event", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    window.addEventListener("ds:open-welcome-guide", handler);
    renderAt("appearance");
    await user.click(screen.getByRole("button", { name: /Replay welcome guide/ }));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener("ds:open-welcome-guide", handler);
  });

});

// ============================================================================
// Playback tab - non-server caps (advanced-gated) + data saver toggle
// ============================================================================

describe("Settings · Playback (local caps)", () => {
  it("offers safe defaults and updates each player preference in the draft", () => {
    renderAt("playback");

    expect(screen.getByRole("combobox", { name: "Default audio language" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "Original / stream default" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Preferred subtitle language" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Default playback speed" })).toHaveValue("1");
    expect(screen.getByRole("slider", { name: "Default volume" })).toHaveValue("100");
    expect(screen.getByRole("checkbox", { name: /Remember audio and subtitle choices per title/ })).toBeChecked();

    fireEvent.change(screen.getByRole("combobox", { name: "Default audio language" }), {
      target: { value: "ja" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Default subtitles" }), {
      target: { value: "preferred" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Preferred subtitle language" }), {
      target: { value: "en" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Default playback speed" }), {
      target: { value: "1.5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Default volume" }), {
      target: { value: "35" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Remember audio and subtitle choices per title/ }));

    expect(screen.getByRole("combobox", { name: "Default audio language" })).toHaveValue("ja");
    expect(screen.getByRole("combobox", { name: "Preferred subtitle language" })).toHaveValue("en");
    expect(screen.getByRole("combobox", { name: "Default playback speed" })).toHaveValue("1.5");
    expect(screen.getByRole("slider", { name: "Default volume" })).toHaveValue("35");
    expect(screen.getByRole("checkbox", { name: /Remember audio and subtitle choices per title/ })).not.toBeChecked();
  });

  it("defaults cached-only on for new settings", () => {
    renderAt("playback");
    const cachedOnly = screen
      .getByText("Show cached streams only")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cachedOnly.checked).toBe(true);
  });

  it("toggles Data Saver through patch", async () => {
    const user = userEvent.setup();
    renderAt("playback");
    const ds = screen
      .getByText("Data Saver")
      .closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(ds.checked).toBe(false);
    await user.click(ds);
    expect(ds.checked).toBe(true);
  });

  it("hides the advanced quality/size caps in Simple mode", () => {
    mockSimpleMode = true;
    renderAt("playback");
    expect(screen.queryByText("Maximum quality")).toBeNull();
    expect(screen.queryByText("Maximum file size")).toBeNull();
    // The cached-only essential remains.
    expect(screen.getByText("Show cached streams only")).toBeInTheDocument();
  });

  it("shows quality/size caps in Advanced and reveals a custom GB input for an off-list cap", () => {
    renderAt("playback", { streamMaxSizeGB: 25 });
    expect(screen.getByText("Maximum quality")).toBeInTheDocument();
    // 25 GB is not in the preset list → the custom number input is shown.
    expect(screen.getByLabelText("Custom maximum file size in GB")).toHaveValue(25);
  });
});

describe("Settings · Reset & uninstall", () => {
  it("keeps the reset card available in Simple mode with browser uninstall guidance", () => {
    mockSimpleMode = true;
    renderAt();

    expect(screen.getByRole("heading", { name: "Reset & uninstall" })).toBeInTheDocument();
    expect(screen.getByText(/Installed as a browser app/)).toBeInTheDocument();
  });

  it("requires ERASE before starting the factory reset", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));

    const dialog = screen.getByRole("dialog", { name: "Erase all data on this device" });
    const erase = within(dialog).getByRole("button", { name: "Erase all data" });
    expect(erase).toBeDisabled();
    expect(dialog).toHaveTextContent("Downloaded video files in your downloads folder are NOT deleted.");

    await user.type(within(dialog).getByLabelText("Type ERASE to confirm"), "ERASE");
    await user.click(erase);
    expect(factoryReset).toHaveBeenCalledTimes(1);
  });

  it("surfaces a reset failure with Retry and Cancel", async () => {
    const user = userEvent.setup();
    factoryReset.mockRejectedValueOnce(new Error("keychain locked"));
    renderAt();
    await user.click(screen.getByRole("button", { name: "Erase all data on this device" }));
    const dialog = screen.getByRole("dialog", { name: "Erase all data on this device" });
    await user.type(within(dialog).getByLabelText("Type ERASE to confirm"), "ERASE");
    await user.click(within(dialog).getByRole("button", { name: "Erase all data" }));

    expect(await within(dialog).findByRole("heading", { name: "Reset incomplete" })).toBeInTheDocument();
    expect(within(dialog).getByText("keychain locked")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
