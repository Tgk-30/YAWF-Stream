// @vitest-environment jsdom
//
// Server-Mode + account-panel tests for the Settings screen. Targets the
// ServerTab subtree: ServerConnectionPanel, ServerHealthPanel, ActiveStreams,
// RequestQueue, ServerUsage, ServerAudit, PasswordPanel (changePassword +
// disabled-while-saving), ProfileCredentialPanel (profile overrides +
// delete), the shared-credential / invite / create-profile admin forms, the
// KidsProfilesPanel maturity controls, and the Simple/Advanced tab gating.
//
// `serverRequest` inside Settings.tsx talks to the real `fetch`, so we stub
// global.fetch with a routing table keyed by `${method} ${path}`. The
// KidsProfilesPanel instead goes through ../lib/serverApi, which we mock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Settings } from "./Settings";
import { defaultSettings } from "../data/settings";
import type { AppSettings } from "../data/settings";
import {
  ServerSessionProvider,
  type ServerSession,
} from "../lib/ServerSessionContext";

// ---- module mocks ---------------------------------------------------------

let mockServerMode = true;

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => mockServerMode,
  configuredServerURL: () => "https://srv.example.com",
  configuredServerURLSource: () => "saved",
  saveServerURL: vi.fn(),
}));

vi.mock("../lib/serverSession", () => ({
  readCsrfToken: () => "csrf-token",
  notifyUnauthorized: vi.fn(),
}));

vi.mock("../lib/smartPreload", () => ({
  isSmartPreloadEnabled: () => false,
  setSmartPreloadEnabled: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  isTauri: () => false,
  desktopServerStatus: vi.fn(),
  startDesktopServer: vi.fn(),
  stopDesktopServer: vi.fn(),
  openExternalURL: vi.fn(),
}));

const fetchAccountProfiles = vi.fn();
const setProfileMaturity = vi.fn();
const exportServerPortableProfile = vi.fn();
const importServerPortableProfile = vi.fn();

vi.mock("../lib/serverApi", () => ({
  fetchAccountProfiles: () => fetchAccountProfiles(),
  setProfileMaturity: (id: string, body: unknown) => setProfileMaturity(id, body),
  exportServerPortableProfile: () => exportServerPortableProfile(),
  importServerPortableProfile: (bundle: unknown, mode: unknown) =>
    importServerPortableProfile(bundle, mode),
  testServerDebridToken: vi.fn(),
}));

// AppStore - only the slice Settings reads.
let mockSettings: AppSettings;
const updateSettings = vi.fn();
let mockSimpleMode = false;

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    simpleMode: mockSimpleMode,
  }),
  useSimpleMode: () => mockSimpleMode,
}));

// qrcode is pulled in by DesktopHostPanel (which short-circuits when !isTauri),
// but mock it to keep the module graph light + deterministic.
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,xxx") },
}));

// ---- fetch routing table --------------------------------------------------

type Json = Record<string, unknown>;
let routes: Map<string, { ok: boolean; status: number; body: Json }>;
let fetchCalls: { method: string; path: string; body: unknown }[];

function route(method: string, path: string, body: Json, ok = true, status = 200) {
  routes.set(`${method} ${path}`, { ok, status, body });
}

const BASE = "https://srv.example.com";

function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    fetchCalls.push({
      method,
      path,
      body: init?.body != null ? JSON.parse(init.body as string) : undefined,
    });
    const hit = routes.get(`${method} ${path}`);
    const resolved = hit ?? { ok: true, status: 200, body: {} as Json };
    return {
      ok: resolved.ok,
      status: resolved.status,
      text: async () => JSON.stringify(resolved.body),
    } as Response;
  }) as unknown as typeof fetch;
}

// Seed the eight GET routes refresh() fans out, for a given role.
function seedRefresh(role: ServerSession["role"]) {
  route("GET", "/api/auth/session", {
    session: { username: "owner", displayName: "Owner", role },
  });
  route("GET", "/api/profiles", {
    profiles: [
      { id: "p1", username: "owner", displayName: "Owner", role, self: true, simpleMode: false },
      { id: "p2", username: "kid", displayName: "Kid", role: "restricted", disabled: true, simpleMode: true },
    ],
  });
  const usagePath = role === "owner" || role === "admin" ? "/api/admin/usage/streams" : "/api/usage/streams";
  route("GET", usagePath, {
    days: 30,
    totalBytes: 1024 * 1024 * 1024,
    streamCount: 4,
    lastAccessedAt: "2026-06-20T10:00:00Z",
    profiles: [
      { profileId: "p1", username: "owner", displayName: "Owner", role, totalBytes: 2048, streamCount: 2, lastAccessedAt: null },
    ],
    sessions: [
      { id: "s1", title: "Movie", createdAt: "2026-06-20T10:00:00Z", bytesServed: 512, lastAccessedAt: "2026-06-20T11:00:00Z", completedAt: null, lastStatus: 200 },
    ],
  });
  route("GET", "/api/auth/sessions", {
    sessions: [
      { id: "sess-cur", userAgent: "Mozilla iPhone", ipHash: null, createdAt: "2026-06-20T10:00:00Z", expiresAt: "2026-07-20T10:00:00Z", revokedAt: null, current: true, active: true },
      { id: "sess-other", userAgent: "Mozilla Windows", ipHash: null, createdAt: "2026-06-19T10:00:00Z", expiresAt: "2026-07-19T10:00:00Z", revokedAt: null, current: false, active: true },
    ],
  });
  route("GET", "/api/credentials/effective", {
    credentials: [
      { id: "c1", provider: "real_debrid", scope: "profile", label: "Personal" },
      { id: null, provider: "tmdb", scope: "server", label: "Shared" },
      { id: null, provider: "omdb", scope: null, label: null },
    ],
  });
  // Admin-only routes (harmless to seed even for members).
  route("GET", "/api/admin/health", {
    ok: true,
    serverTime: "2026-06-24T10:00:00Z",
    setupRequired: false,
    counts: { users: 3, profiles: 4, activeSessions: 2, activeStreamSessions: 1, credentials: 5, activeInvites: 1, auditEvents: 9, recentStreamErrors: 0 },
    config: { cookieSecure: true, cookieSameSite: "lax", trustProxy: false, corsConfigured: true, rawStreamUrlsEnabled: false, webDistConfigured: true, sessionTtlSeconds: 3600 },
    transcode: {
      enabled: true,
      ready: true,
      configuredEncoder: "h264_videotoolbox",
      activeEncoder: "h264_videotoolbox",
      availableVideoEncoders: ["libx264", "h264_videotoolbox"],
      adaptive: true,
      seekOffset: true,
      subtitleSidecar: true,
      toneMapping: true,
    },
    warnings: ["Set a strong owner password."],
  });
  route("GET", "/api/admin/streams/active", {
    streams: [
      { id: "str1", profileId: "p1", username: "owner", displayName: "Owner", title: "Big Movie", contentType: "movie", createdAt: "2026-06-24T10:00:00Z", expiresAt: "2026-06-24T12:00:00Z", bytesServed: 4096, lastAccessedAt: "2026-06-24T11:00:00Z", lastStatus: 200, lastError: null },
    ],
  });
  route("GET", "/api/admin/requests?status=pending", {
    requests: [
      { id: "req1", mediaId: "m1", preview: { title: "Wanted Film", year: 2020 }, status: "pending", decisionReason: null, requestedAt: "2026-06-24T10:00:00Z", decidedAt: null, requestedByDisplayName: "Alice", decidedByDisplayName: null },
    ],
  });
  route("GET", "/api/admin/invites", {
    invites: [
      { id: "inv1", label: "Family", role: "member", simpleMode: true, maxUses: 5, usedCount: 1, createdAt: "2026-06-20T10:00:00Z", expiresAt: "2026-07-01T10:00:00Z", revokedAt: null, active: true },
    ],
  });
  route("GET", "/api/admin/audit-log?limit=25", {
    events: [
      { id: "ev1", actorUserId: "u1", actorProfileId: "p1", actorUsername: "owner", actorDisplayName: "Owner", action: "profile.create", targetType: "profile", targetId: "p2", metadata: null, createdAt: "2026-06-24T09:00:00Z" },
    ],
  });
}

function renderSettings(session?: ServerSession | null) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerSessionProvider
      initial={
        session ?? {
          profileId: "p1",
          username: "owner",
          displayName: "Owner",
          role: "owner",
          simpleMode: false,
        }
      }
    >
      {children}
    </ServerSessionProvider>
  );
  return render(<Settings />, { wrapper });
}

async function gotoServerTab() {
  const tabButton = await screen.findByRole("button", { name: "Server" });
  await userEvent.click(tabButton);
}

beforeEach(() => {
  mockServerMode = true;
  mockSimpleMode = false;
  mockSettings = defaultSettings();
  routes = new Map();
  updateSettings.mockReset();
  fetchAccountProfiles.mockReset();
  setProfileMaturity.mockReset();
  exportServerPortableProfile.mockReset();
  importServerPortableProfile.mockReset();
  fetchAccountProfiles.mockResolvedValue({ profiles: [], activeProfileId: "p1" });
  setProfileMaturity.mockResolvedValue({ ok: true, profiles: [] });
  importServerPortableProfile.mockResolvedValue({
    settings: 0,
    watchlist: 0,
    history: 0,
    folders: 0,
    library: 0,
  });
  installFetch();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings tab gating (Server Mode)", () => {
  it("shows the Server tab in Advanced + Server Mode", async () => {
    seedRefresh("member");
    renderSettings();
    expect(await screen.findByRole("button", { name: "Server" })).toBeInTheDocument();
  });

  it("hides the Server tab in Simple mode", async () => {
    mockSimpleMode = true;
    renderSettings();
    // Appearance is a Simple tab and always present.
    expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Server" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sources" })).not.toBeInTheDocument();
  });

  it("hides the Server tab entirely in Local Mode", async () => {
    mockServerMode = false;
    renderSettings(null);
    expect(await screen.findByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Server" })).not.toBeInTheDocument();
  });

  it("hides the personal Trakt connection section in Server Mode", async () => {
    renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: "API keys" }));
    expect(screen.queryByLabelText("Trakt connection")).not.toBeInTheDocument();
  });

  it("imports a portable profile in merge mode from Privacy settings", async () => {
    const bundle = {
      product: "YAWF Stream",
      format: "yawf-profile-portable",
      version: 1,
      createdAt: "2026-07-24T10:00:00.000Z",
      settings: [],
      watchlist: [],
      history: [],
      folders: [],
      library: [],
    };
    const view = renderSettings();
    await userEvent.click(
      await screen.findByRole("button", { name: "Privacy" }),
    );
    expect(
      screen.getByRole("button", { name: "Export current profile" }),
    ).toBeInTheDocument();
    const input = view.container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await userEvent.upload(
      input,
      new File([JSON.stringify(bundle)], "profile.json", {
        type: "application/json",
      }),
    );
    const realSetTimeout = window.setTimeout.bind(window);
    const timeout = vi.spyOn(window, "setTimeout").mockImplementation(
      ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        delay === 500
          ? (0 as unknown as ReturnType<typeof window.setTimeout>)
          : realSetTimeout(handler, delay, ...args)) as typeof window.setTimeout,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Import portable server profile",
      }),
    );
    await waitFor(() =>
      expect(importServerPortableProfile).toHaveBeenCalledWith(bundle, "merge"),
    );
    timeout.mockRestore();
  });
});

describe("ServerTab loading + error", () => {
  it("shows a busy skeleton while the initial refresh is in flight", async () => {
    // Never-resolving fetch keeps it in the loading branch.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    renderSettings();
    await gotoServerTab();
    expect(
      await screen.findByLabelText("Loading server settings"),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("surfaces a server error message when the session request fails", async () => {
    route("GET", "/api/auth/session", { error: "Session expired" }, false, 403);
    renderSettings();
    await gotoServerTab();
    expect(await screen.findByText("Session expired")).toBeInTheDocument();
  });
});

describe("ServerTab member view", () => {
  it("renders the session row, usage, password + sessions panels but no admin panels", async () => {
    seedRefresh("member");
    renderSettings();
    await gotoServerTab();

    // session row (the @owner handle appears in the session row + profile list)
    expect(await screen.findAllByText("@owner")).not.toHaveLength(0);
    // usage panel
    expect(screen.getByText("Stream forwarding")).toBeInTheDocument();
    // password + sessions panels (always visible)
    expect(screen.getByText("Password")).toBeInTheDocument();
    expect(screen.getByText("Signed-in devices")).toBeInTheDocument();
    // admin-only panels absent for a member
    expect(screen.queryByText("Server health")).not.toBeInTheDocument();
    expect(screen.queryByText("Active streams")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit log")).not.toBeInTheDocument();
    expect(screen.queryByText("Invite link")).not.toBeInTheDocument();

    // member hit the non-admin usage endpoint
    expect(fetchCalls.some((c) => c.path === "/api/usage/streams")).toBe(true);
    expect(fetchCalls.some((c) => c.path === "/api/admin/usage/streams")).toBe(false);
  });

  it("hides the credential-overrides panel for a restricted profile", async () => {
    seedRefresh("restricted");
    renderSettings({ profileId: "p1", username: "r", displayName: "R", role: "restricted", simpleMode: false });
    await gotoServerTab();
    await screen.findByText("Password");
    expect(screen.queryByText("Credential overrides")).not.toBeInTheDocument();
  });
});

describe("ServerHealthPanel + admin panels", () => {
  it("renders health counts, flags and warnings for an owner", async () => {
    seedRefresh("owner");
    renderSettings();
    await gotoServerTab();

    const health = (await screen.findByText("Server health")).closest(".settings-source")!;
    expect(within(health as HTMLElement).getByText("Online")).toBeInTheDocument();
    expect(within(health as HTMLElement).getByText("Cookies secure")).toBeInTheDocument();
    expect(within(health as HTMLElement).getByText("Set a strong owner password.")).toBeInTheDocument();
    expect(
      within(health as HTMLElement).getByText("Transcoding matrix"),
    ).toBeInTheDocument();
    expect(
      within(health as HTMLElement).getAllByText(/Apple VideoToolbox/).length,
    ).toBeGreaterThan(0);
    expect(
      within(health as HTMLElement).getByText(/CPU software, Apple VideoToolbox/),
    ).toBeInTheDocument();
    // owner used the admin usage endpoint
    expect(fetchCalls.some((c) => c.path === "/api/admin/usage/streams")).toBe(true);
  });

  it("renders the audit log entry with a humanized action label", async () => {
    seedRefresh("owner");
    renderSettings();
    await gotoServerTab();
    expect(await screen.findByText("Profile Create")).toBeInTheDocument();
    expect(screen.getByText(/by Owner/)).toBeInTheDocument();
  });
});

describe("ActiveStreamsPanel terminate", () => {
  it("terminates a stream and refreshes", async () => {
    seedRefresh("owner");
    route("POST", "/api/admin/streams/str1/revoke", {});
    renderSettings();
    await gotoServerTab();

    // "Active streams" also appears as a health-count label; target the panel title.
    const title = (await screen.findAllByText("Active streams")).find((el) =>
      el.classList.contains("settings-sources-title"),
    )!;
    const streams = title.closest(".settings-source")!;
    await userEvent.click(within(streams as HTMLElement).getByRole("button", { name: "Terminate" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((c) => c.method === "POST" && c.path === "/api/admin/streams/str1/revoke"),
      ).toBe(true),
    );
    expect(await screen.findByText("Stream terminated.")).toBeInTheDocument();
  });
});

describe("RequestQueuePanel approve/deny", () => {
  it("approves a pending request", async () => {
    seedRefresh("owner");
    route("POST", "/api/admin/requests/req1/approve", {});
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Title requests")).closest(".settings-source")!;
    await userEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((c) => c.method === "POST" && c.path === "/api/admin/requests/req1/approve"),
      ).toBe(true),
    );
    expect(await screen.findByText("Request approved.")).toBeInTheDocument();
  });

  it("denies a pending request with a prompted reason", async () => {
    seedRefresh("owner");
    route("POST", "/api/admin/requests/req1/deny", {});
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("not appropriate");
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Title requests")).closest(".settings-source")!;
    await userEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Deny" }));

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === "POST" && c.path === "/api/admin/requests/req1/deny",
      );
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({ reason: "not appropriate" });
    });
    expect(await screen.findByText("Request denied.")).toBeInTheDocument();
    promptSpy.mockRestore();
  });

  it("leaves the request untouched when the deny prompt is cancelled", async () => {
    seedRefresh("owner");
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Title requests")).closest(".settings-source")!;
    await userEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Deny" }));

    expect(
      fetchCalls.some((c) => c.path === "/api/admin/requests/req1/deny"),
    ).toBe(false);
    promptSpy.mockRestore();
  });
});

describe("PasswordPanel changePassword", () => {
  it("rejects mismatched passwords before any request", async () => {
    seedRefresh("member");
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Password")).closest(".settings-source")! as HTMLElement;
    await userEvent.type(panel.querySelector('input[placeholder="Current password"]')!, "old");
    await userEvent.type(panel.querySelector('input[placeholder="New password"]')!, "newpass1");
    await userEvent.type(panel.querySelector('input[placeholder="Confirm new password"]')!, "different");
    await userEvent.click(within(panel).getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("New passwords do not match.")).toBeInTheDocument();
    expect(fetchCalls.some((c) => c.path === "/api/auth/change-password")).toBe(false);
  });

  it("posts the change and clears the fields on success", async () => {
    seedRefresh("member");
    route("POST", "/api/auth/change-password", {});
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Password")).closest(".settings-source")! as HTMLElement;
    const current = panel.querySelector('input[placeholder="Current password"]') as HTMLInputElement;
    const next = panel.querySelector('input[placeholder="New password"]') as HTMLInputElement;
    const confirm = panel.querySelector('input[placeholder="Confirm new password"]') as HTMLInputElement;
    await userEvent.type(current, "old");
    await userEvent.type(next, "newpass1");
    await userEvent.type(confirm, "newpass1");
    await userEvent.click(within(panel).getByRole("button", { name: "Change password" }));

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.path === "/api/auth/change-password");
      expect(call).toBeTruthy();
      expect(call!.body).toEqual({ currentPassword: "old", newPassword: "newpass1" });
    });
    expect(await screen.findByText("Password changed. Other sessions were signed out.")).toBeInTheDocument();
    // Re-query rather than reuse the references above: a successful change now
    // refreshes the signed-in-devices list (the server just revoked the other
    // sessions), which re-renders the panel and detaches the original inputs.
    await waitFor(() => {
      const fresh = (screen.getByText("Password")).closest(".settings-source")! as HTMLElement;
      const currentNow = fresh.querySelector('input[placeholder="Current password"]') as HTMLInputElement;
      const nextNow = fresh.querySelector('input[placeholder="New password"]') as HTMLInputElement;
      expect(currentNow.value).toBe("");
      expect(nextNow.value).toBe("");
    });
  });

  it("surfaces a server error from changePassword", async () => {
    seedRefresh("member");
    route("POST", "/api/auth/change-password", { error: "Current password is wrong." }, false, 400);
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Password")).closest(".settings-source")! as HTMLElement;
    await userEvent.type(panel.querySelector('input[placeholder="Current password"]')!, "bad");
    await userEvent.type(panel.querySelector('input[placeholder="New password"]')!, "newpass1");
    await userEvent.type(panel.querySelector('input[placeholder="Confirm new password"]')!, "newpass1");
    await userEvent.click(within(panel).getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Current password is wrong.")).toBeInTheDocument();
  });
});

describe("SessionsPanel revoke", () => {
  it("revokes a non-current active session and refreshes", async () => {
    seedRefresh("member");
    route("DELETE", "/api/auth/sessions/sess-other", {});
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Signed-in devices")).closest(".settings-source")! as HTMLElement;
    // The current session shows no Revoke button; only the other one does.
    expect(within(panel).getByText("Current session")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((c) => c.method === "DELETE" && c.path === "/api/auth/sessions/sess-other"),
      ).toBe(true),
    );
    expect(await screen.findByText("Session revoked.")).toBeInTheDocument();
  });
});

describe("ProfileCredentialPanel overrides", () => {
  it("renders effective credentials with their scope labels", async () => {
    seedRefresh("member");
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Credential overrides")).closest(".settings-source")! as HTMLElement;
    expect(within(panel).getByText("Profile override")).toBeInTheDocument();
    expect(within(panel).getByText("Shared server")).toBeInTheDocument();
    expect(within(panel).getByText("Missing")).toBeInTheDocument();
  });

  it("saves a profile credential override and disables the button while saving", async () => {
    seedRefresh("member");
    let resolveSave: () => void = () => {};
    routes.set("PUT /api/profile/credentials", { ok: true, status: 200, body: {} });
    // Wrap fetch to gate the PUT so we can observe the saving state.
    const realFetch = global.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && String(url).endsWith("/api/profile/credentials")) {
        fetchCalls.push({ method: "PUT", path: "/api/profile/credentials", body: JSON.parse(init!.body as string) });
        await new Promise<void>((r) => (resolveSave = r));
        return { ok: true, status: 200, text: async () => "{}" } as Response;
      }
      return realFetch(url, init);
    }) as unknown as typeof fetch;

    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Credential overrides")).closest(".settings-source")! as HTMLElement;
    await userEvent.type(panel.querySelector('input[placeholder="Token or API key"]')!, "secret-token");
    const saveBtn = within(panel).getByRole("button", { name: "Save profile override" });
    await userEvent.click(saveBtn);

    // mid-flight: button is disabled + shows progress label
    expect(await within(panel).findByRole("button", { name: "Saving…" })).toBeDisabled();

    resolveSave();
    await waitFor(() => {
      const call = fetchCalls.find((c) => c.method === "PUT" && c.path === "/api/profile/credentials");
      expect(call!.body).toEqual({ provider: "real_debrid", label: "Personal", value: "secret-token" });
    });
    expect(await screen.findByText("Profile credential override saved.")).toBeInTheDocument();
  });

  it("deletes a profile-scoped credential override", async () => {
    seedRefresh("member");
    route("DELETE", "/api/profile/credentials/c1", {});
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Credential overrides")).closest(".settings-source")! as HTMLElement;
    await userEvent.click(within(panel).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((c) => c.method === "DELETE" && c.path === "/api/profile/credentials/c1"),
      ).toBe(true),
    );
    expect(await screen.findByText("Profile credential override removed.")).toBeInTheDocument();
  });
});

describe("Admin: create profile, shared credential, invites", () => {
  it("creates a profile and posts the draft", async () => {
    seedRefresh("owner");
    route("POST", "/api/profiles", {});
    renderSettings();
    await gotoServerTab();

    await screen.findByText("Server health");
    await userEvent.type(screen.getByPlaceholderText("Username"), "newuser");
    await userEvent.type(screen.getByPlaceholderText("Display name"), "New User");
    await userEvent.type(screen.getByPlaceholderText("Password"), "pw1234");
    await userEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.method === "POST" && c.path === "/api/profiles");
      expect(call!.body).toMatchObject({ username: "newuser", displayName: "New User", password: "pw1234", role: "member", simpleMode: true });
    });
    expect(await screen.findByText("Profile created.")).toBeInTheDocument();
  });

  it("saves a shared credential and clears its value", async () => {
    seedRefresh("owner");
    route("PUT", "/api/admin/credentials", {});
    renderSettings();
    await gotoServerTab();

    await screen.findByText("Server health");
    // "Token or API key" also appears in the profile-override panel; scope to the
    // shared-credential form (the one with the "Save shared credential" button).
    const sharedBtn = screen.getByRole("button", { name: "Save shared credential" });
    const sharedForm = sharedBtn.closest(".settings-source")! as HTMLElement;
    const valueInput = sharedForm.querySelector('input[placeholder="Token or API key"]') as HTMLInputElement;
    await userEvent.type(valueInput, "shared-key");
    expect(sharedBtn).toBeDisabled();
    await userEvent.click(
      within(sharedForm).getByRole("checkbox", {
        name: /Provider terms confirmed/,
      }),
    );
    await userEvent.click(sharedBtn);

    await waitFor(() => {
      const call = fetchCalls.find((c) => c.method === "PUT" && c.path === "/api/admin/credentials");
      expect(call!.body).toMatchObject({ provider: "tmdb", label: "Shared", value: "shared-key" });
    });
    expect(await screen.findByText("Shared credential saved.")).toBeInTheDocument();
    // refresh() remounts the form; re-query the (now reset) value input.
    const freshBtn = screen.getByRole("button", { name: "Save shared credential" });
    const freshInput = freshBtn
      .closest(".settings-source")!
      .querySelector('input[placeholder="Token or API key"]') as HTMLInputElement;
    expect(freshInput.value).toBe("");
  });

  it("creates an invite, shows + copies the generated URL", async () => {
    seedRefresh("owner");
    route("POST", "/api/admin/invites", {
      invite: { id: "inv2", label: "Friends", role: "member", simpleMode: true, maxUses: 1, usedCount: 0, createdAt: "2026-06-24T10:00:00Z", expiresAt: "2026-07-01T10:00:00Z", revokedAt: null, active: true },
      token: "tok-abc",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderSettings();
    await gotoServerTab();

    const invitePanel = (await screen.findByText("Invite link")).closest(".settings-source")! as HTMLElement;
    await userEvent.click(within(invitePanel).getByRole("button", { name: "Create invite" }));

    const link = await screen.findByText(/\?invite=tok-abc$/);
    expect(link).toBeInTheDocument();
    expect(await screen.findByText("Invite link created.")).toBeInTheDocument();

    await userEvent.click(within(invitePanel).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("invite=tok-abc")));
    expect(await screen.findByText("Invite link copied.")).toBeInTheDocument();
  });

  it("revokes an existing active invite", async () => {
    seedRefresh("owner");
    route("DELETE", "/api/admin/invites/inv1", {});
    renderSettings();
    await gotoServerTab();

    const invitePanel = (await screen.findByText("Invite link")).closest(".settings-source")! as HTMLElement;
    await userEvent.click(within(invitePanel).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(
        fetchCalls.some((c) => c.method === "DELETE" && c.path === "/api/admin/invites/inv1"),
      ).toBe(true),
    );
    expect(await screen.findByText("Invite revoked.")).toBeInTheDocument();
  });

  it("reissues an invite and shows its one-time replacement link", async () => {
    seedRefresh("owner");
    route("POST", "/api/admin/invites/inv1/reissue", {
      invite: {
        id: "inv-replacement",
        label: "Family",
        role: "member",
        simpleMode: true,
        maxUses: 5,
        usedCount: 0,
        createdAt: "2026-07-24T10:00:00Z",
        expiresAt: "2026-08-04T10:00:00Z",
        revokedAt: null,
        active: true,
      },
      token: "replacement-token",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSettings();
    await gotoServerTab();

    const invitePanel = (await screen.findByText("Invite link")).closest(
      ".settings-source",
    )! as HTMLElement;
    await userEvent.click(
      within(invitePanel).getByRole("button", { name: "Reissue" }),
    );

    await waitFor(() =>
      expect(
        fetchCalls.some(
          (call) =>
            call.method === "POST" &&
            call.path === "/api/admin/invites/inv1/reissue",
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText(/\?invite=replacement-token$/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Invite reissued. Copy the replacement link now."),
    ).toBeInTheDocument();
  });
});

describe("KidsProfilesPanel maturity controls", () => {
  it("shows an empty hint when there are no manageable (non-default) profiles", async () => {
    seedRefresh("owner");
    fetchAccountProfiles.mockResolvedValue({
      profiles: [
        { id: "d1", displayName: "Primary", avatarColor: null, simpleMode: false, isDefault: true, isKid: false, maturityMax: null },
      ],
      activeProfileId: "d1",
    });
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Kids profiles")).closest(".settings-source")! as HTMLElement;
    expect(
      await within(panel).findByText(/Add a viewer profile/),
    ).toBeInTheDocument();
  });

  it("enables kid mode with the default cap when toggled on", async () => {
    seedRefresh("owner");
    fetchAccountProfiles.mockResolvedValue({
      profiles: [
        { id: "v1", displayName: "Junior", avatarColor: null, simpleMode: true, isDefault: false, isKid: false, maturityMax: null },
      ],
      activeProfileId: "v1",
    });
    setProfileMaturity.mockResolvedValue({
      ok: true,
      profiles: [
        { id: "v1", displayName: "Junior", avatarColor: null, simpleMode: true, isDefault: false, isKid: true, maturityMax: "PG-13" },
      ],
    });
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Kids profiles")).closest(".settings-source")! as HTMLElement;
    const checkbox = within(panel).getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    // The cap select is disabled until kid mode is on.
    expect(within(panel).getByLabelText("Maturity cap for Junior")).toBeDisabled();

    await userEvent.click(checkbox);
    await waitFor(() =>
      expect(setProfileMaturity).toHaveBeenCalledWith("v1", { isKid: true, maturityMax: "PG-13" }),
    );
    expect(await within(panel).findByText(/Kids · up to PG-13/)).toBeInTheDocument();
  });

  it("changes the maturity cap on an existing kid profile", async () => {
    seedRefresh("owner");
    fetchAccountProfiles.mockResolvedValue({
      profiles: [
        { id: "v1", displayName: "Junior", avatarColor: null, simpleMode: true, isDefault: false, isKid: true, maturityMax: "PG" },
      ],
      activeProfileId: "v1",
    });
    setProfileMaturity.mockResolvedValue({
      ok: true,
      profiles: [
        { id: "v1", displayName: "Junior", avatarColor: null, simpleMode: true, isDefault: false, isKid: true, maturityMax: "R" },
      ],
    });
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Kids profiles")).closest(".settings-source")! as HTMLElement;
    const select = within(panel).getByLabelText("Maturity cap for Junior") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    await userEvent.selectOptions(select, "R");

    await waitFor(() =>
      expect(setProfileMaturity).toHaveBeenCalledWith("v1", { isKid: true, maturityMax: "R" }),
    );
  });

  it("surfaces an error when loading kid profiles fails", async () => {
    seedRefresh("owner");
    fetchAccountProfiles.mockRejectedValue(new Error("Kids load failed"));
    renderSettings();
    await gotoServerTab();

    const panel = (await screen.findByText("Kids profiles")).closest(".settings-source")! as HTMLElement;
    expect(await within(panel).findByText("Kids load failed")).toBeInTheDocument();
  });
});

describe("ServerConnectionPanel + logout", () => {
  it("disconnects to Local Mode (saveServerURL(null) + reload)", async () => {
    seedRefresh("member");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload, origin: "https://srv.example.com" },
    });
    renderSettings();
    await gotoServerTab();

    // Two connection panels render (ServerConnectionPanel appears in ServerTab
    // and is also reused elsewhere); use the first "Use Local Mode" button.
    const btn = await screen.findByRole("button", { name: "Use Local Mode" });
    const { saveServerURL } = await import("../lib/serverMode");
    await userEvent.click(btn);
    expect(saveServerURL).toHaveBeenCalledWith(null);
    expect(reload).toHaveBeenCalled();
  });

  it("signs out via the session row", async () => {
    seedRefresh("member");
    route("POST", "/api/auth/logout", {});
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload, origin: "https://srv.example.com" },
    });
    renderSettings();
    await gotoServerTab();

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.method === "POST" && c.path === "/api/auth/logout")).toBe(true),
    );
  });
});
