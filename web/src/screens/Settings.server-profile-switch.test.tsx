// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../data/settings";
import {
  ServerSessionProvider,
  type ServerSession,
  useSetServerSession,
} from "../lib/ServerSessionContext";
import { Settings } from "./Settings";

let mockServerMode = true;
let mockSettings: AppSettings = defaultSettings();
let mockActiveProfile: { id: string } | null = null;
const updateSettings = vi.fn();

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
  isDesktopTauri: () => false,
  desktopServerStatus: vi.fn(),
  startDesktopServer: vi.fn(),
  stopDesktopServer: vi.fn(),
  openExternalURL: vi.fn(),
}));

vi.mock("../lib/serverApi", () => ({
  fetchAccountProfiles: vi.fn().mockResolvedValue({
    profiles: [],
    activeProfileId: "p1",
  }),
  setProfileMaturity: vi.fn(),
  exportServerPortableProfile: vi.fn(),
  importServerPortableProfile: vi.fn(),
  testServerDebridToken: vi.fn(),
}));

vi.mock("../store/AppStore", () => ({
  useAppStore: () => ({
    settings: mockSettings,
    updateSettings,
    simpleMode: false,
    activeProfile: mockActiveProfile,
    profiles: [],
    multiUserEnabled: false,
  }),
  useSimpleMode: () => false,
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,xxx") },
}));

const BASE = "https://srv.example.com";

type Credential = {
  id: string;
  provider: "real_debrid";
  scope: "profile";
  label: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

function credentialResponse(label: string): Response {
  const credential: Credential = {
    id: `credential-${label}`,
    provider: "real_debrid",
    scope: "profile",
    label,
  };
  return jsonResponse({ credentials: [credential] });
}

function installFetch(
  credentialResponses: Array<Response | Promise<Response>>,
): { credentialCalls: () => number } {
  let credentialsIndex = 0;

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).startsWith(BASE)
      ? String(input).slice(BASE.length)
      : String(input);

    if (path === "/api/auth/session") {
      return jsonResponse({
        session: {
          username: "viewer",
          displayName: "Viewer",
          role: "member",
        },
      });
    }
    if (path === "/api/profiles") return jsonResponse({ profiles: [] });
    if (path === "/api/usage/streams") {
      return jsonResponse({
        days: 30,
        totalBytes: 0,
        streamCount: 0,
        lastAccessedAt: null,
        profiles: [],
        sessions: [],
      });
    }
    if (path === "/api/auth/sessions") {
      return jsonResponse({ sessions: [] });
    }
    if (path === "/api/credentials/effective") {
      const response = credentialResponses[credentialsIndex];
      credentialsIndex += 1;
      if (response == null) {
        throw new Error("Unexpected credential refresh");
      }
      return await response;
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  return { credentialCalls: () => credentialsIndex };
}

const FIRST_PROFILE: ServerSession = {
  profileId: "p1",
  username: "first",
  displayName: "First profile",
  role: "member",
  simpleMode: false,
};

function ProfileSwitch({
  next,
  previous = FIRST_PROFILE,
}: {
  next: ServerSession;
  previous?: ServerSession;
}) {
  const setSession = useSetServerSession();
  return (
    <>
      <button type="button" onClick={() => setSession(next)}>
        Switch test profile
      </button>
      <button type="button" onClick={() => setSession(previous)}>
        Return test profile
      </button>
    </>
  );
}

function renderSettings(next: ServerSession, initial = FIRST_PROFILE) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerSessionProvider initial={initial}>
      <ProfileSwitch next={next} previous={initial} />
      {children}
    </ServerSessionProvider>
  );
  return render(<Settings />, { wrapper });
}

async function openServerSettings() {
  await userEvent.click(await screen.findByRole("button", { name: "Server" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServerMode = true;
  mockSettings = defaultSettings();
  mockActiveProfile = null;
  updateSettings.mockResolvedValue({ ok: true });
});

describe("Server settings profile refresh", () => {
  it("uses the server profile identity after child settings load before the session changes", async () => {
    const ownerSettings = {
      ...defaultSettings(),
      autoAdvanceEpisodes: false,
      defaultPlaybackSpeed: 1.25,
    };
    const childSettings = {
      ...defaultSettings(),
      autoAdvanceEpisodes: true,
      defaultPlaybackSpeed: 1.5,
    };
    mockSettings = ownerSettings;
    const view = renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "child",
      displayName: "Child",
    });

    await userEvent.click(await screen.findByRole("button", { name: "Playback" }));
    const dataSaver = screen.getByRole("checkbox", { name: "Data Saver" });
    const autoAdvance = screen.getByRole("checkbox", { name: "Auto-play next episode" });
    await userEvent.click(dataSaver);
    expect(dataSaver).toBeChecked();
    expect(autoAdvance).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    // ProfilePicker reloads the target settings while the prior session is
    // still current. This rerender must not discard the owner's live draft.
    mockSettings = childSettings;
    view.rerender(<Settings />);
    expect(dataSaver).toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    // The session changes only after the target settings have replaced the
    // AppStore value. Server Mode has no local activeProfile to key on.
    await userEvent.click(screen.getByRole("button", { name: "Switch test profile" }));

    await waitFor(() => {
      expect(dataSaver).not.toBeChecked();
      expect(autoAdvance).toBeChecked();
      expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    });

    await userEvent.click(dataSaver);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(updateSettings).toHaveBeenLastCalledWith({ ...childSettings, dataSaver: true });
  });

  it("ignores a failed save from the profile that was switched away from", async () => {
    const ownerSettings = { ...defaultSettings(), autoAdvanceEpisodes: false };
    const childSettings = { ...defaultSettings(), autoAdvanceEpisodes: true };
    const pendingSave = deferred<{ ok: boolean }>();
    mockSettings = ownerSettings;
    updateSettings.mockReturnValueOnce(pendingSave.promise);
    const view = renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "child",
      displayName: "Child",
    });

    await userEvent.click(await screen.findByRole("button", { name: "Playback" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Data Saver" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    mockSettings = childSettings;
    view.rerender(<Settings />);
    await userEvent.click(screen.getByRole("button", { name: "Switch test profile" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    });

    await act(async () => {
      pendingSave.resolve({ ok: false });
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    expect(screen.queryByText(/Could not save to this device/)).not.toBeInTheDocument();
  });

  it("ignores a rejected save from the profile that was switched away from", async () => {
    const ownerSettings = { ...defaultSettings(), autoAdvanceEpisodes: false };
    const childSettings = { ...defaultSettings(), autoAdvanceEpisodes: true };
    const pendingSave = deferred<{ ok: boolean }>();
    mockSettings = ownerSettings;
    updateSettings.mockReturnValueOnce(pendingSave.promise);
    const view = renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "child",
      displayName: "Child",
    });

    await userEvent.click(await screen.findByRole("button", { name: "Playback" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Data Saver" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    mockSettings = childSettings;
    view.rerender(<Settings />);
    await userEvent.click(screen.getByRole("button", { name: "Switch test profile" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    });

    await act(async () => {
      pendingSave.reject(new Error("owner save rejected"));
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    expect(screen.queryByText(/Could not save to this device/)).not.toBeInTheDocument();
  });

  it("does not accept an old save after switching away and back to the same profile", async () => {
    const ownerSettings = { ...defaultSettings(), autoAdvanceEpisodes: false };
    const childSettings = { ...defaultSettings(), autoAdvanceEpisodes: true };
    const pendingSave = deferred<{ ok: boolean }>();
    mockSettings = ownerSettings;
    updateSettings.mockReturnValueOnce(pendingSave.promise);
    const view = renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "child",
      displayName: "Child",
    });

    await userEvent.click(await screen.findByRole("button", { name: "Playback" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Data Saver" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    mockSettings = childSettings;
    view.rerender(<Settings />);
    await userEvent.click(screen.getByRole("button", { name: "Switch test profile" }));
    mockSettings = ownerSettings;
    view.rerender(<Settings />);
    await userEvent.click(screen.getByRole("button", { name: "Return test profile" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    });

    await act(async () => {
      pendingSave.resolve({ ok: true });
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
  });

  it("does not conflate identical local and server ids when the mode changes", async () => {
    const localSettings = { ...defaultSettings(), interfaceLanguage: "en" };
    const serverSettings = { ...defaultSettings(), interfaceLanguage: "system" };
    const sharedSession = { ...FIRST_PROFILE, profileId: "shared" };
    mockServerMode = false;
    mockActiveProfile = { id: "shared" };
    mockSettings = localSettings;
    const view = renderSettings(sharedSession, sharedSession);

    await userEvent.click(await screen.findByRole("button", { name: "Language & region" }));
    const interfaceLanguage = screen.getByRole("combobox", { name: "Interface language" });
    await userEvent.selectOptions(interfaceLanguage, "fr");
    expect(interfaceLanguage).toHaveValue("fr");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    mockServerMode = true;
    mockSettings = serverSettings;
    view.rerender(<Settings />);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Interface language" })).toHaveValue("system");
      expect(screen.getByRole("button", { name: "Up to date" })).toBeDisabled();
    });
  });

  it("clears the prior profile credential status immediately on a same-screen profile switch", async () => {
    const secondCredentials = deferred<Response>();
    installFetch([
      credentialResponse("First profile credential"),
      secondCredentials.promise,
    ]);
    renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "second",
      displayName: "Second profile",
    });
    await openServerSettings();

    expect(
      await screen.findByText("First profile credential"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Switch test profile" }),
    );

    expect(
      await screen.findByLabelText("Loading server settings"),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByText("First profile credential"),
    ).not.toBeInTheDocument();

    await act(async () => {
      secondCredentials.resolve(credentialResponse("Second profile credential"));
    });
    expect(
      await screen.findByText("Second profile credential"),
    ).toBeInTheDocument();
  });

  it("ignores an out-of-order credential refresh from the profile unmounted during a switch", async () => {
    const firstCredentials = deferred<Response>();
    const fetchState = installFetch([
      firstCredentials.promise,
      credentialResponse("Current profile credential"),
    ]);
    renderSettings({
      ...FIRST_PROFILE,
      profileId: "p2",
      username: "current",
      displayName: "Current profile",
    });
    await openServerSettings();
    await waitFor(() => expect(fetchState.credentialCalls()).toBe(1));

    await userEvent.click(
      screen.getByRole("button", { name: "Switch test profile" }),
    );

    expect(
      await screen.findByText("Current profile credential"),
    ).toBeInTheDocument();
    expect(fetchState.credentialCalls()).toBe(2);

    await act(async () => {
      firstCredentials.resolve(credentialResponse("Stale profile credential"));
    });

    expect(screen.getByText("Current profile credential")).toBeInTheDocument();
    expect(screen.queryByText("Stale profile credential")).not.toBeInTheDocument();
  });
});
