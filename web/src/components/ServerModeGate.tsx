import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  configuredServerURL,
  configuredServerURLSource,
  saveServerURL,
} from "../lib/serverMode";
import {
  clearServerSession,
  onUnauthorized,
  setCsrfToken,
} from "../lib/serverSession";
import {
  ServerSessionProvider,
  type ServerProfileSummary,
  type ServerSession,
  type ServerTranscodeCapabilities,
} from "../lib/ServerSessionContext";
import {
  needsCloudflareAccessLogin,
  openServerAccessLogin,
} from "../lib/serverAccess";
import { AmbientVideo } from "./AmbientVideo";
import { recordDiagnostic } from "../lib/diagnostics";
import "./ServerModeGate.css";

declare global {
  var __DEBRIDSTREAMER_SETUP_TOKEN__: string | null | undefined;
}

interface ProfileState {
  profiles: ServerProfileSummary[];
  activeProfileId: string;
}

interface BootstrapResponse {
  setupRequired: boolean;
  setupTokenRequired?: boolean;
  session: ServerSession | null;
  profiles?: ProfileState | null;
  csrfToken?: string | null;
  transcodeAvailable?: boolean;
  transcodeCapabilities?: ServerTranscodeCapabilities;
  omdbProxy?: boolean;
  buildProfile?: "family" | "friends" | "public";
}

interface AuthResponse {
  csrfToken?: string | null;
}

type GateState =
  | { kind: "local" }
  | { kind: "loading"; baseURL: string }
  | { kind: "ready"; baseURL: string }
  | { kind: "setup"; baseURL: string; setupTokenRequired: boolean; setupToken: string | null }
  | { kind: "invite"; baseURL: string; token: string }
  | { kind: "login"; baseURL: string }
  | { kind: "cloudflare-access"; baseURL: string }
  | { kind: "error"; baseURL: string; message: string };

function setupTokenFromURL(): string | null {
  try {
    const token = new URL(window.location.href).searchParams.get("setup")?.trim();
    return token != null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function setupTokenFromGlobal(): string | null {
  const token = globalThis.__DEBRIDSTREAMER_SETUP_TOKEN__?.trim();
  return token != null && token.length > 0 ? token : null;
}

function clearSetupTokenFromURL(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("setup")) return;
    url.searchParams.delete("setup");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Non-fatal; the setup token is one-time useful only before owner creation.
  }
}

function inviteTokenFromURL(): string | null {
  try {
    const token = new URL(window.location.href).searchParams.get("invite")?.trim();
    return token != null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function clearInviteFromURL(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Non-fatal; leaving the token in the URL does not block the session.
  }
}

function jsonFetch<T>(
  baseURL: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return fetch(`${baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const text = await response.text();
    let parsed: { error?: string } = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as { error?: string };
      } catch {
        // Non-JSON body (e.g. a reverse-proxy HTML error page) - fall back to a
        // status-based message instead of throwing a misleading parse error.
        parsed = {};
      }
    }
    if (!response.ok) {
      throw new Error(parsed.error ?? `Server request failed (${response.status}).`);
    }
    return parsed as T;
  });
}

export function ServerModeGate({ children }: { children: ReactNode }) {
  const baseURL = useMemo(() => configuredServerURL(), []);
  const inviteToken = useMemo(() => inviteTokenFromURL(), []);
  const setupToken = useMemo(
    () => setupTokenFromURL() ?? setupTokenFromGlobal(),
    [],
  );
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<ServerSession | null>(null);
  const [profiles, setProfiles] = useState<ServerProfileSummary[]>([]);
  const [transcodeAvailable, setTranscodeAvailable] = useState(false);
  const [transcodeCapabilities, setTranscodeCapabilities] =
    useState<ServerTranscodeCapabilities>({
      adaptive: false,
      seekOffset: false,
      subtitleSidecar: false,
      hardwareEncoder: "libx264",
      availableVideoEncoders: [],
      toneMapping: false,
    });
  const [omdbProxy, setOmdbProxy] = useState(false);
  const [buildProfile, setBuildProfile] = useState<"family" | "friends" | "public">("public");
  const [state, setState] = useState<GateState>(() =>
    baseURL == null ? { kind: "local" } : { kind: "loading", baseURL },
  );

  // Auth forms reach "ready" without a session object in hand; fetch it once so
  // consumers (simpleMode/role + the "who's watching" picker) have the value
  // without waiting for a reload.
  async function captureSession(url: string): Promise<boolean> {
    try {
      const res = await jsonFetch<{
        session: ServerSession | null;
        profiles?: ProfileState | null;
      }>(url, "/api/auth/session");
      setSession(res.session);
      setProfiles(res.profiles?.profiles ?? []);
      // Report whether we actually have a session in hand. A null session (or a
      // failed fetch below) must NOT flip the gate to "ready", or the app would
      // mount authenticated-but-session-less (no setup wizard, no profile
      // switcher) until a manual reload.
      return res.session != null;
    } catch {
      setSession(null);
      setProfiles([]);
      return false;
    }
  }

  // If a request 401s (session expired/revoked while the app is open), return to
  // the login screen instead of leaving a half-broken authenticated shell.
  useEffect(() => {
    if (baseURL == null) return;
    return onUnauthorized(() => {
      clearServerSession();
      setState({ kind: "login", baseURL });
    });
  }, [baseURL]);

  useEffect(() => {
    if (baseURL == null) return;
    let cancelled = false;
    setState({ kind: "loading", baseURL });
    void jsonFetch<BootstrapResponse>(baseURL, "/api/bootstrap")
      .then((bootstrap) => {
        if (cancelled) return;
        // Capture the CSRF token so mutating requests work cross-origin (where
        // document.cookie can't see ds_csrf).
        setCsrfToken(bootstrap.csrfToken);
        setTranscodeAvailable(bootstrap.transcodeAvailable ?? false);
        setTranscodeCapabilities(
          bootstrap.transcodeCapabilities ?? {
            adaptive: false,
            seekOffset: false,
            subtitleSidecar: false,
            hardwareEncoder: "libx264",
            availableVideoEncoders: [],
            toneMapping: false,
          },
        );
        setOmdbProxy(bootstrap.omdbProxy ?? false);
        setBuildProfile(bootstrap.buildProfile ?? "public");
        if (bootstrap.setupRequired) {
          setState({
            kind: "setup",
            baseURL,
            setupTokenRequired: bootstrap.setupTokenRequired ?? false,
            setupToken,
          });
        }
        else if (bootstrap.session != null) {
          setSession(bootstrap.session);
          setProfiles(bootstrap.profiles?.profiles ?? []);
          setState({ kind: "ready", baseURL });
        }
        else if (inviteToken != null) {
          setState({ kind: "invite", baseURL, token: inviteToken });
        }
        else setState({ kind: "login", baseURL });
      })
      .catch(async (error) => {
        if (cancelled) return;
        if (await needsCloudflareAccessLogin(baseURL)) {
          if (!cancelled) setState({ kind: "cloudflare-access", baseURL });
          return;
        }
        const message = error instanceof Error ? error.message : "Cannot reach server.";
        recordDiagnostic("network", "server.bootstrap_failed", "error", message);
        setState({ kind: "error", baseURL, message });
      });
    return () => {
      cancelled = true;
    };
  }, [baseURL, inviteToken, setupToken, attempt]);

  if (state.kind === "local" || state.kind === "ready") {
    return (
      <ServerSessionProvider
        initial={session}
        initialProfiles={profiles}
        initialTranscodeAvailable={transcodeAvailable}
        initialTranscodeCapabilities={transcodeCapabilities}
        initialOmdbProxy={omdbProxy}
        initialBuildProfile={buildProfile}
      >
        {children}
      </ServerSessionProvider>
    );
  }
  if (state.kind === "loading") {
    return <GateShell title="Connecting" copy="Checking the YAWF Stream server." baseURL={state.baseURL} />;
  }
  if (state.kind === "error") {
    const offline = navigator.onLine === false;
    const canUseLocalMode = configuredServerURLSource() === "saved";
    return (
      <GateShell
        title={offline ? "Device offline" : "Server unavailable"}
        copy={
          offline
            ? "This device is offline. Reconnect to the internet or your home network, then retry."
            : state.message
        }
        guidance={
          offline
            ? undefined
            : "The host may be asleep, powered off, or unavailable on this network. Keep it awake for remote streaming and check Settings > Server > Remote access when it is back online."
        }
        baseURL={state.baseURL}
        actionLabel={canUseLocalMode ? "Use Local Mode" : undefined}
        onAction={
          canUseLocalMode
            ? async () => {
                saveServerURL(null);
                window.location.reload();
              }
            : undefined
        }
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (state.kind === "cloudflare-access") {
    return (
      <GateShell
        title="Cloudflare Access sign-in required"
        copy="The server is online, but Cloudflare Access needs a separate desktop session. Sign in in the window that opens, close it when the server loads, then retry."
        baseURL={state.baseURL}
        actionLabel="Sign in to Cloudflare Access"
        onAction={() => openServerAccessLogin(state.baseURL)}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (state.kind === "setup") {
    return (
      <AuthForm
        title="Create owner account"
        copy="This server has not been set up yet."
        baseURL={state.baseURL}
        submitLabel="Create owner"
        includeDisplayName
        includeSetupToken={state.setupTokenRequired}
        setupToken={state.setupToken}
        onSubmit={(payload) =>
          jsonFetch<AuthResponse>(state.baseURL, "/api/auth/setup-owner", payload).then(async (res) => {
            setCsrfToken(res.csrfToken);
            const ok = await captureSession(state.baseURL);
            clearSetupTokenFromURL();
            // Only mount the app once we actually hold the session. If the
            // session fetch failed/raced, re-run bootstrap (the auth cookie is
            // now set) instead of mounting authenticated-but-session-less.
            if (ok) setState({ kind: "ready", baseURL: state.baseURL });
            else setAttempt((n) => n + 1);
          })
        }
      />
    );
  }
  if (state.kind === "invite") {
    return (
      <AuthForm
        title="Join YAWF Stream"
        copy="Create your profile from this invite link."
        baseURL={state.baseURL}
        submitLabel="Create profile"
        includeDisplayName
        onSubmit={(payload) =>
          jsonFetch<AuthResponse>(state.baseURL, "/api/auth/invite", {
            ...payload,
            token: state.token,
          }).then(async (res) => {
            setCsrfToken(res.csrfToken);
            const ok = await captureSession(state.baseURL);
            clearInviteFromURL();
            if (ok) setState({ kind: "ready", baseURL: state.baseURL });
            else setAttempt((n) => n + 1);
          })
        }
      />
    );
  }
  return (
    <AuthForm
      title="Sign in"
      copy="Use your YAWF Stream server profile."
      baseURL={state.baseURL}
      submitLabel="Sign in"
      includeTotp
      onSubmit={(payload) =>
        jsonFetch<AuthResponse>(state.baseURL, "/api/auth/login", payload).then(async (res) => {
          setCsrfToken(res.csrfToken);
          const ok = await captureSession(state.baseURL);
          if (ok) setState({ kind: "ready", baseURL: state.baseURL });
          else setAttempt((n) => n + 1);
        })
      }
    />
  );
}

function GateShell({
  title,
  copy,
  guidance,
  baseURL,
  actionLabel,
  onAction,
  onRetry,
}: {
  title: string;
  copy: string;
  guidance?: string;
  baseURL: string;
  actionLabel?: string;
  onAction?: () => Promise<void>;
  onRetry?: () => void;
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function runAction(): void {
    if (onAction == null) return;
    setActionBusy(true);
    setActionError(null);
    void onAction()
      .catch((error) => {
        setActionError(
          error instanceof Error ? error.message : "Could not open the sign-in window.",
        );
      })
      .finally(() => setActionBusy(false));
  }

  return (
    <div className="server-gate">
      <AmbientVideo name="aurora" opacity={0.32} />
      <div className="server-gate-card">
        <h1 className="server-gate-title">{title}</h1>
        <p className="server-gate-copy">{copy}</p>
        {guidance != null && (
          <p className="server-gate-copy">{guidance}</p>
        )}
        {actionError != null && <p className="server-gate-error">{actionError}</p>}
        {(onAction != null || onRetry != null) && (
          <div className="server-gate-actions">
            {onAction != null && actionLabel != null && (
              <button
                className="server-gate-button"
                type="button"
                disabled={actionBusy}
                onClick={runAction}
              >
                {actionBusy ? "Opening sign-in" : actionLabel}
              </button>
            )}
            {onRetry != null && (
              <button
                className="server-gate-button server-gate-button-secondary"
                type="button"
                onClick={onRetry}
              >
                Retry
              </button>
            )}
          </div>
        )}
        <div className="server-gate-meta">{baseURL || window.location.origin}</div>
      </div>
    </div>
  );
}

function AuthForm({
  title,
  copy,
  baseURL,
  submitLabel,
  includeDisplayName = false,
  includeSetupToken = false,
  includeTotp = false,
  setupToken: initialSetupToken = null,
  onSubmit,
}: {
  title: string;
  copy: string;
  baseURL: string;
  submitLabel: string;
  includeDisplayName?: boolean;
  includeSetupToken?: boolean;
  includeTotp?: boolean;
  setupToken?: string | null;
  onSubmit: (payload: {
    username: string;
    password: string;
    displayName?: string;
    setupToken?: string;
    totpCode?: string;
  }) => Promise<unknown>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState(initialSetupToken ?? "");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void onSubmit({
      username: username.trim(),
      password,
      displayName: includeDisplayName ? displayName.trim() || username.trim() : undefined,
      ...(includeSetupToken || setupToken.trim().length > 0
        ? { setupToken: setupToken.trim() }
        : {}),
      ...(includeTotp && totpCode.trim().length > 0
        ? { totpCode: totpCode.trim() }
        : {}),
    })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Request failed.");
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="server-gate">
      <AmbientVideo name={includeSetupToken ? "secure" : "aurora"} opacity={0.3} />
      <div className="server-gate-card">
        <h1 className="server-gate-title">{title}</h1>
        <p className="server-gate-copy">{copy}</p>
        <form className="server-gate-form" onSubmit={submit}>
          <label className="server-gate-field">
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              minLength={3}
            />
          </label>
          {includeDisplayName && (
            <label className="server-gate-field">
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
              />
            </label>
          )}
          <label className="server-gate-field">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={includeDisplayName ? "new-password" : "current-password"}
              required
              minLength={8}
            />
          </label>
          {includeSetupToken && initialSetupToken == null && (
            <label className="server-gate-field">
              Setup token
              <input
                type="password"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="one-time-code"
                required
              />
            </label>
          )}
          {includeTotp && (
            <label className="server-gate-field">
              Authenticator code (if enabled)
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ""))}
                autoComplete="one-time-code"
                placeholder="6-digit code"
              />
            </label>
          )}
          {error != null && <p className="server-gate-error">{error}</p>}
          <button className="server-gate-button" type="submit" disabled={busy}>
            {busy ? "Please wait" : submitLabel}
          </button>
        </form>
        <div className="server-gate-meta">{baseURL || window.location.origin}</div>
      </div>
    </div>
  );
}
