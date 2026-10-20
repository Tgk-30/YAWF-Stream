// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/settings";
import {
  ServerSessionProvider,
  type ServerSession,
  useSetServerSession,
} from "../lib/ServerSessionContext";
import { Settings } from "./Settings";

vi.mock("../lib/serverMode", () => ({
  isServerMode: () => true,
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
    settings: defaultSettings(),
    updateSettings: vi.fn(),
    simpleMode: false,
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
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

function ProfileSwitch({ next }: { next: ServerSession }) {
  const setSession = useSetServerSession();
  return (
    <button type="button" onClick={() => setSession(next)}>
      Switch test profile
    </button>
  );
}

function renderSettings(next: ServerSession) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServerSessionProvider initial={FIRST_PROFILE}>
      <ProfileSwitch next={next} />
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
});

describe("Server settings profile refresh", () => {
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
