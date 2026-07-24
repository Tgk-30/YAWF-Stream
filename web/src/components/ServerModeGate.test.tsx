// @vitest-environment jsdom
//
// Component coverage for the Server-Mode bootstrap gate. Drives the gate's state
// machine: Local Mode passthrough, the loading shell, the server-error shell +
// Retry re-bootstrap, the setup-owner / invite / login auth forms, the
// captureSession -> "ready" transition, the auth-race re-bootstrap (session
// fetch returns null -> setAttempt re-runs bootstrap), and the 401 ->
// onUnauthorized -> login path. External deps (serverMode, serverSession,
// ServerSessionContext, AmbientVideo) are mocked so the test exercises only the
// gate's own logic; the global `fetch` (used by the component's local jsonFetch)
// is stubbed per-test.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- Mocks ------------------------------------------------------------------

// configuredServerURL drives Local vs Server mode. Default: a server URL.
const configuredServerURL = vi.fn<() => string | null>(() => "https://srv.test");
const configuredServerURLSource = vi.fn(() => "saved");
const saveServerURL = vi.fn();
vi.mock("../lib/serverMode", () => ({
  configuredServerURL: () => configuredServerURL(),
  configuredServerURLSource: () => configuredServerURLSource(),
  saveServerURL: (value: string | null) => saveServerURL(value),
}));

const setCsrfToken = vi.fn();
const clearServerSession = vi.fn();
// Capture the registered 401 handler so a test can fire it.
let unauthorizedHandler: (() => void) | null = null;
const unsubscribe = vi.fn();
const onUnauthorized = vi.fn((handler: () => void) => {
  unauthorizedHandler = handler;
  return unsubscribe;
});
vi.mock("../lib/serverSession", () => ({
  setCsrfToken: (...args: unknown[]) => setCsrfToken(...args),
  clearServerSession: () => clearServerSession(),
  onUnauthorized: (handler: () => void) => onUnauthorized(handler),
}));

const needsCloudflareAccessLogin = vi.fn<() => Promise<boolean>>();
const openServerAccessLogin = vi.fn<() => Promise<void>>();
vi.mock("../lib/serverAccess", () => ({
  needsCloudflareAccessLogin: () => needsCloudflareAccessLogin(),
  openServerAccessLogin: () => openServerAccessLogin(),
}));

// Render the provider as a simple wrapper that exposes its props for assertions.
vi.mock("../lib/ServerSessionContext", () => ({
  ServerSessionProvider: ({
    children,
    initial,
    initialProfiles,
    initialBuildProfile,
    initialTranscodeAvailable,
    initialOmdbProxy,
  }: {
    children: React.ReactNode;
    initial: unknown;
    initialProfiles: unknown[];
    initialBuildProfile: string;
    initialTranscodeAvailable: boolean;
    initialOmdbProxy: boolean;
  }) => (
    <div
      data-testid="session-provider"
      data-session={JSON.stringify(initial)}
      data-profiles={JSON.stringify(initialProfiles)}
      data-build={initialBuildProfile}
      data-transcode={String(initialTranscodeAvailable)}
      data-omdb={String(initialOmdbProxy)}
    >
      {children}
    </div>
  ),
}));

vi.mock("./AmbientVideo", () => ({
  AmbientVideo: () => null,
}));

import { ServerModeGate } from "./ServerModeGate";

// --- fetch helpers ----------------------------------------------------------

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Reset sticky implementations too (clearAllMocks keeps mockReturnValue impls,
  // so a never-resolving fetch from one test would leak into the next).
  fetchMock.mockReset();
  configuredServerURL.mockReset();
  configuredServerURLSource.mockReset();
  unauthorizedHandler = null;
  configuredServerURL.mockReturnValue("https://srv.test");
  configuredServerURLSource.mockReturnValue("saved");
  needsCloudflareAccessLogin.mockResolvedValue(false);
  openServerAccessLogin.mockResolvedValue();
  vi.stubGlobal("fetch", fetchMock);
  // Keep the URL clean between tests (invite/setup token readers parse it).
  window.history.replaceState({}, "", "/");
  // Drop any global setup token leakage.
  (globalThis as { __DEBRIDSTREAMER_SETUP_TOKEN__?: string | null }).__DEBRIDSTREAMER_SETUP_TOKEN__ = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHILD = <div data-testid="app">APP MOUNTED</div>;

describe("ServerModeGate", () => {
  it("renders children directly in Local Mode without bootstrapping", async () => {
    configuredServerURL.mockReturnValue(null);
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(screen.getByTestId("app")).toBeInTheDocument();
    expect(screen.getByTestId("session-provider")).toBeInTheDocument();
    // No bootstrap network call in Local Mode.
    expect(fetchMock).not.toHaveBeenCalled();
    // onUnauthorized is not armed in Local Mode (baseURL == null early-return).
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("shows the connecting shell while bootstrap is in flight", async () => {
    // Never-resolving fetch keeps the gate in the loading state.
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(
      screen.getByText("Checking the YAWF Stream server."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();
  });

  it("mounts the app and forwards bootstrap session/flags when a session exists", async () => {
    const session = {
      profileId: "p1",
      username: "owner",
      displayName: "Owner",
      role: "owner",
      simpleMode: false,
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        setupRequired: false,
        session,
        profiles: { profiles: [{ id: "p1" }], activeProfileId: "p1" },
        csrfToken: "csrf-123",
        transcodeAvailable: true,
        omdbProxy: true,
        buildProfile: "friends",
      }),
    );

    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(setCsrfToken).toHaveBeenCalledWith("csrf-123");

    const provider = screen.getByTestId("session-provider");
    expect(JSON.parse(provider.dataset.session!)).toEqual(session);
    expect(JSON.parse(provider.dataset.profiles!)).toEqual([{ id: "p1" }]);
    expect(provider.dataset.build).toBe("friends");
    expect(provider.dataset.transcode).toBe("true");
    expect(provider.dataset.omdb).toBe("true");

    // Bootstrap was a GET (no body).
    expect(fetchMock).toHaveBeenCalledWith(
      "https://srv.test/api/bootstrap",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    // The 401 handler is armed in Server Mode.
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("falls back to default flags when bootstrap omits optional fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        setupRequired: false,
        session: { profileId: "p", username: "u", displayName: "U", role: "member", simpleMode: false },
      }),
    );
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    const provider = await screen.findByTestId("session-provider");
    expect(provider.dataset.build).toBe("public");
    expect(provider.dataset.transcode).toBe("false");
    expect(provider.dataset.omdb).toBe("false");
    expect(JSON.parse(provider.dataset.profiles!)).toEqual([]);
  });

  it("renders the error shell and Retry re-runs bootstrap", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom: down"));
    // Second bootstrap (after Retry) succeeds with a session -> ready.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        setupRequired: false,
        session: { profileId: "p", username: "u", displayName: "U", role: "owner", simpleMode: false },
      }),
    );

    const user = userEvent.setup();
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(await screen.findByText("Server unavailable")).toBeInTheDocument();
    expect(screen.getByText("boom: down")).toBeInTheDocument();
    expect(
      screen.getByText(/host may be asleep, powered off, or unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use Local Mode" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a generic error message when the rejection is not an Error", async () => {
    fetchMock.mockRejectedValueOnce("string failure");
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(await screen.findByText("Server unavailable")).toBeInTheDocument();
    expect(screen.getByText("Cannot reach server.")).toBeInTheDocument();
  });

  it("recognizes Cloudflare Access and opens a desktop sign-in window", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed"));
    needsCloudflareAccessLogin.mockResolvedValueOnce(true);

    const user = userEvent.setup();
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(
      await screen.findByText("Cloudflare Access sign-in required"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server unavailable")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Sign in to Cloudflare Access" }),
    );
    expect(openServerAccessLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("surfaces a Cloudflare sign-in window error without losing Retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed"));
    needsCloudflareAccessLogin.mockResolvedValueOnce(true);
    openServerAccessLogin.mockRejectedValueOnce(new Error("window blocked"));

    const user = userEvent.setup();
    render(<ServerModeGate>{CHILD}</ServerModeGate>);
    await screen.findByText("Cloudflare Access sign-in required");
    await user.click(
      screen.getByRole("button", { name: "Sign in to Cloudflare Access" }),
    );

    expect(await screen.findByText("window blocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("surfaces a status-based error message for a non-ok bootstrap with no JSON error", async () => {
    fetchMock.mockResolvedValueOnce(
      // Non-JSON body (e.g. HTML proxy page) -> jsonFetch builds a status message.
      {
        ok: false,
        status: 502,
        text: () => Promise.resolve("<html>bad gateway</html>"),
      } as unknown as Response,
    );
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(
      await screen.findByText("Server request failed (502)."),
    ).toBeInTheDocument();
  });

  it("prefers the server-provided error string on a non-ok bootstrap", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "custom server error" }, false, 500),
    );
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    expect(await screen.findByText("custom server error")).toBeInTheDocument();
  });

  describe("setup-owner form", () => {
    function bootstrapSetup(setupTokenRequired = false) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          setupRequired: true,
          setupTokenRequired,
          session: null,
        }),
      );
    }

    it("renders the create-owner form when setup is required", async () => {
      bootstrapSetup(false);
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      expect(await screen.findByText("Create owner account")).toBeInTheDocument();
      expect(
        screen.getByText("This server has not been set up yet."),
      ).toBeInTheDocument();
      // includeDisplayName -> the Display name field is present.
      expect(screen.getByText("Display name")).toBeInTheDocument();
      // No setup-token field when not required.
      expect(screen.queryByText("Setup token")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create owner" }),
      ).toBeInTheDocument();
    });

    it("requires a setup-token field when the server demands one", async () => {
      bootstrapSetup(true);
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      expect(screen.getByText("Setup token")).toBeInTheDocument();
    });

    it("submits, captures the session, and mounts the app on success (race ok)", async () => {
      bootstrapSetup(false);
      // setup-owner POST returns a csrf token.
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-setup" }));
      // captureSession GET returns a session -> ok=true -> ready.
      const session = {
        profileId: "p9",
        username: "boss",
        displayName: "Boss",
        role: "owner",
        simpleMode: false,
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ session, profiles: { profiles: [{ id: "p9" }], activeProfileId: "p9" } }),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      await user.type(screen.getByLabelText("Username"), "boss");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      expect(await screen.findByTestId("app")).toBeInTheDocument();
      expect(setCsrfToken).toHaveBeenCalledWith("csrf-setup");

      // The setup-owner POST carried the trimmed username + a defaulted display name.
      const setupCall = fetchMock.mock.calls.find(
        ([url]) => url === "https://srv.test/api/auth/setup-owner",
      );
      expect(setupCall).toBeTruthy();
      const body = JSON.parse((setupCall![1] as RequestInit).body as string);
      expect(body.username).toBe("boss");
      expect(body.password).toBe("supersecret");
      // displayName defaults to the username when left blank.
      expect(body.displayName).toBe("boss");

      // The captured session is handed to the provider.
      const provider = screen.getByTestId("session-provider");
      expect(JSON.parse(provider.dataset.session!)).toEqual(session);
    });

    it("re-bootstraps (setAttempt) when captureSession returns a null session (auth race)", async () => {
      bootstrapSetup(false);
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-setup" }));
      // captureSession: null session -> ok=false -> setAttempt -> re-bootstrap.
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: null }));
      // Re-run bootstrap now sees a live session (cookie is set) -> ready.
      const session = {
        profileId: "p9",
        username: "boss",
        displayName: "Boss",
        role: "owner",
        simpleMode: false,
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: false, session }),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      await user.type(screen.getByLabelText("Username"), "boss");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      // The re-bootstrap eventually mounts the app.
      expect(await screen.findByTestId("app")).toBeInTheDocument();
      // bootstrap, setup-owner POST, captureSession GET, re-bootstrap = 4 calls.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    });

    it("re-bootstraps when captureSession itself throws (caught -> ok=false)", async () => {
      bootstrapSetup(false);
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-setup" }));
      // captureSession rejects -> caught -> ok=false -> setAttempt.
      fetchMock.mockRejectedValueOnce(new Error("session fetch failed"));
      // Re-bootstrap recovers with a session.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          setupRequired: false,
          session: { profileId: "p", username: "u", displayName: "U", role: "owner", simpleMode: false },
        }),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      await user.type(screen.getByLabelText("Username"), "boss");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      expect(await screen.findByTestId("app")).toBeInTheDocument();
    });

    it("shows the form error and stays on the form when setup-owner POST fails", async () => {
      bootstrapSetup(false);
      // setup-owner POST returns a non-ok error.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "username taken" }, false, 409),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      await user.type(screen.getByLabelText("Username"), "boss");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      expect(await screen.findByText("username taken")).toBeInTheDocument();
      // Still on the create-owner form; the app never mounts.
      expect(screen.getByText("Create owner account")).toBeInTheDocument();
      expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    });
  });

  describe("invite form", () => {
    it("renders the invite form when an ?invite token is present and no session", async () => {
      window.history.replaceState({}, "", "/?invite=inv-token-1");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: false, session: null }),
      );

      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      expect(await screen.findByText("Join YAWF Stream")).toBeInTheDocument();
      expect(
        screen.getByText("Create your profile from this invite link."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create profile" }),
      ).toBeInTheDocument();
    });

    it("submits the invite with the URL token and mounts on success", async () => {
      window.history.replaceState({}, "", "/?invite=inv-token-1");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: false, session: null }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-inv" }));
      const session = {
        profileId: "pi",
        username: "guest",
        displayName: "Guest",
        role: "member",
        simpleMode: true,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ session }));

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Join YAWF Stream");
      await user.type(screen.getByLabelText("Username"), "guest");
      await user.type(screen.getByLabelText("Password"), "guestpass1");
      await user.click(screen.getByRole("button", { name: "Create profile" }));

      expect(await screen.findByTestId("app")).toBeInTheDocument();

      const inviteCall = fetchMock.mock.calls.find(
        ([url]) => url === "https://srv.test/api/auth/invite",
      );
      const body = JSON.parse((inviteCall![1] as RequestInit).body as string);
      expect(body.token).toBe("inv-token-1");
      expect(body.username).toBe("guest");
    });
  });

  describe("login form", () => {
    function bootstrapLogin() {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: false, session: null }),
      );
    }

    it("renders the sign-in form when no session and no invite/setup token", async () => {
      bootstrapLogin();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(
        screen.getByText("Use your YAWF Stream server profile."),
      ).toBeInTheDocument();
      // Login form has no Display name field.
      expect(screen.queryByText("Display name")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Authenticator code (if enabled)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });

    it("logs in, captures the session, and mounts the app", async () => {
      bootstrapLogin();
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-login" }));
      const session = {
        profileId: "pl",
        username: "user1",
        displayName: "User One",
        role: "member",
        simpleMode: false,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ session }));

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByRole("heading", { name: "Sign in" });
      await user.type(screen.getByLabelText("Username"), "user1");
      await user.type(screen.getByLabelText("Password"), "password1");
      await user.type(screen.getByLabelText("Authenticator code (if enabled)"), "123456");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      expect(await screen.findByTestId("app")).toBeInTheDocument();
      expect(setCsrfToken).toHaveBeenCalledWith("csrf-login");
      const provider = screen.getByTestId("session-provider");
      expect(JSON.parse(provider.dataset.session!)).toEqual(session);
      const loginCall = fetchMock.mock.calls.find(
        ([url]) => url === "https://srv.test/api/auth/login",
      );
      const loginBody = JSON.parse((loginCall![1] as RequestInit).body as string);
      expect(loginBody.totpCode).toBe("123456");
    });

    it("disables the submit button while a login request is in flight", async () => {
      bootstrapLogin();
      // Login POST never resolves -> the button stays in its busy/disabled state,
      // so we can assert the in-flight branch without racing a later resolution.
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByRole("heading", { name: "Sign in" });
      await user.type(screen.getByLabelText("Username"), "user1");
      await user.type(screen.getByLabelText("Password"), "password1");
      await user.click(screen.getByRole("button", { name: "Sign in" }));

      const busyButton = await screen.findByRole("button", { name: "Please wait" });
      expect(busyButton).toBeDisabled();
    });
  });

  describe("401 / unauthorized handling", () => {
    it("returns to the login screen when a 401 is signalled while mounted", async () => {
      // Start in the ready/app state.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          setupRequired: false,
          session: { profileId: "p", username: "u", displayName: "U", role: "owner", simpleMode: false },
        }),
      );

      render(<ServerModeGate>{CHILD}</ServerModeGate>);
      expect(await screen.findByTestId("app")).toBeInTheDocument();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(typeof unauthorizedHandler).toBe("function");

      // Fire the captured 401 handler.
      unauthorizedHandler!();

      // Clears the session and drops back to the login gate.
      expect(clearServerSession).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(screen.queryByTestId("app")).not.toBeInTheDocument();
    });
  });

  describe("setup token from URL / global", () => {
    it("prefills the setup-token field (hidden) from a ?setup URL param", async () => {
      window.history.replaceState({}, "", "/?setup=tok-url");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: true, setupTokenRequired: true, session: null }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "c" }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          session: { profileId: "p", username: "u", displayName: "U", role: "owner", simpleMode: false },
        }),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      // With an initialSetupToken present, the visible Setup token input is hidden
      // (the token rides along silently) - only Username/Password fields show.
      expect(screen.queryByText("Setup token")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("Username"), "owner");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      await screen.findByTestId("app");
      const setupCall = fetchMock.mock.calls.find(
        ([url]) => url === "https://srv.test/api/auth/setup-owner",
      );
      const body = JSON.parse((setupCall![1] as RequestInit).body as string);
      expect(body.setupToken).toBe("tok-url");
    });

    it("reads the setup token from the injected global when the URL has none", async () => {
      (globalThis as { __DEBRIDSTREAMER_SETUP_TOKEN__?: string | null }).__DEBRIDSTREAMER_SETUP_TOKEN__ =
        "tok-global";
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ setupRequired: true, setupTokenRequired: true, session: null }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: "c" }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          session: { profileId: "p", username: "u", displayName: "U", role: "owner", simpleMode: false },
        }),
      );

      const user = userEvent.setup();
      render(<ServerModeGate>{CHILD}</ServerModeGate>);

      await screen.findByText("Create owner account");
      await user.type(screen.getByLabelText("Username"), "owner");
      await user.type(screen.getByLabelText("Password"), "supersecret");
      await user.click(screen.getByRole("button", { name: "Create owner" }));

      await screen.findByTestId("app");
      const setupCall = fetchMock.mock.calls.find(
        ([url]) => url === "https://srv.test/api/auth/setup-owner",
      );
      const body = JSON.parse((setupCall![1] as RequestInit).body as string);
      expect(body.setupToken).toBe("tok-global");
    });
  });

  it("renders error/login meta with the configured baseURL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ setupRequired: false, session: null }),
    );
    render(<ServerModeGate>{CHILD}</ServerModeGate>);

    const heading = await screen.findByRole("heading", { name: "Sign in" });
    const card = heading.closest(".server-gate-card") as HTMLElement;
    expect(within(card).getByText("https://srv.test")).toBeInTheDocument();
  });
});
