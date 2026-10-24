import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { DebridServiceType } from "../../services/debrid/models";

type ServerRole = "owner" | "admin" | "member" | "restricted" | null;
type ProviderScope = "profile" | "server" | "missing";

type SavedProviderStatus = Record<DebridServiceType, ProviderScope>;

const DEBRID_PROVIDERS: readonly DebridServiceType[] = [
  "real_debrid",
  "all_debrid",
  "premiumize",
  "torbox",
];

const PROVIDER_LABELS: Record<DebridServiceType, string> = {
  real_debrid: "Real-Debrid",
  all_debrid: "AllDebrid",
  premiumize: "Premiumize",
  torbox: "TorBox",
};

const MAX_CREDENTIAL_ROWS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDebridProvider(value: unknown): value is DebridServiceType {
  return typeof value === "string" && DEBRID_PROVIDERS.includes(value as DebridServiceType);
}

/**
 * Reduces the redacted effective-credential response to the only facts this UI
 * needs. It deliberately discards IDs, labels, profile IDs, and timestamps.
 */
export function parseSavedProviderStatus(value: unknown): SavedProviderStatus | null {
  if (!isRecord(value) || !Array.isArray(value.credentials)) return null;
  if (value.credentials.length > MAX_CREDENTIAL_ROWS) return null;

  const statuses = new Map<DebridServiceType, ProviderScope>();

  for (const row of value.credentials) {
    if (!isRecord(row) || typeof row.provider !== "string") return null;
    if (!isDebridProvider(row.provider)) continue;
    if (statuses.has(row.provider)) return null;

    if (row.scope === null) {
      if (row.id !== null || row.label !== null || "isActive" in row) return null;
      statuses.set(row.provider, "missing");
      continue;
    }

    if (
      (row.scope !== "profile" && row.scope !== "server") ||
      row.isActive !== true ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.label !== "string"
    ) {
      return null;
    }

    statuses.set(row.provider, row.scope);
  }

  if (statuses.size !== DEBRID_PROVIDERS.length) return null;

  return {
    real_debrid: statuses.get("real_debrid")!,
    all_debrid: statuses.get("all_debrid")!,
    premiumize: statuses.get("premiumize")!,
    torbox: statuses.get("torbox")!,
  };
}

function roleCanChangeCredentials(role: ServerRole, isKid: boolean): boolean {
  return !isKid && (role === "owner" || role === "admin" || role === "member");
}

function guidanceFor(
  scope: ProviderScope,
  label: string,
  role: ServerRole,
): string {
  if (scope === "profile") {
    return `A ${label} credential is saved for this profile. Profile credentials take precedence over shared server credentials.`;
  }
  if (scope === "server") {
    if (role === "owner" || role === "admin") {
      return `This profile uses a ${label} credential shared by the server. Manage shared credentials in Advanced > Server. Saving a new token creates a profile override.`;
    }
    return `This profile uses a ${label} credential shared by the server administrator. Saving a new token creates a profile override.`;
  }
  if (role === "owner" || role === "admin") {
    return `No ${label} credential is saved for this profile or shared by the server. Add a profile override here, or configure a shared credential in Advanced > Server.`;
  }
  return `No ${label} credential is available to this profile. Add a profile override, or ask the server administrator.`;
}

function configuredProviderSummary(statuses: SavedProviderStatus): string | null {
  const labels = DEBRID_PROVIDERS.filter((provider) => statuses[provider] !== "missing").map(
    (provider) => PROVIDER_LABELS[provider],
  );
  return labels.length > 0
    ? `Configured providers, not priority order: ${labels.join(", ")}.`
    : null;
}

type LoadState =
  | { profileId: string | null; phase: "loading" }
  | { profileId: string | null; phase: "success"; statuses: SavedProviderStatus }
  | { profileId: string | null; phase: "error" };

export function ServerProviderStatus({
  enabled,
  service,
  profileId,
  role,
  isKid,
  loadStatus,
  refreshVersion = 0,
  children,
}: {
  enabled: boolean;
  service: DebridServiceType;
  profileId: string | null;
  role: ServerRole;
  isKid: boolean;
  loadStatus: () => Promise<unknown>;
  refreshVersion?: number;
  children: ReactNode;
}) {
  const [state, setState] = useState<LoadState>({ profileId: null, phase: "loading" });
  const [retryVersion, retry] = useReducer((version: number) => version + 1, 0);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!enabled || profileId == null) return;

    const request = ++requestVersion.current;
    let active = true;
    setState({ profileId, phase: "loading" });

    void loadStatus().then(
      (response) => {
        const statuses = parseSavedProviderStatus(response);
        if (!active || request !== requestVersion.current) return;
        setState(
          statuses == null
            ? { profileId, phase: "error" }
            : { profileId, phase: "success", statuses },
        );
      },
      () => {
        if (!active || request !== requestVersion.current) return;
        setState({ profileId, phase: "error" });
      },
    );

    return () => {
      active = false;
    };
  }, [enabled, loadStatus, profileId, retryVersion, refreshVersion]);

  if (!enabled) return <>{children}</>;

  const isCurrentProfile = profileId != null && state.profileId === profileId;
  const phase = profileId == null ? "error" : !isCurrentProfile ? "loading" : state.phase;
  const canChange = profileId != null && roleCanChangeCredentials(role, isKid);
  const administratorManaged = !canChange;

  return (
    <div className="settings-fields">
      {phase === "loading" && (
        <p className="settings-status" role="status" aria-live="polite">
          Loading saved provider status…
        </p>
      )}

      {phase === "error" && (
        <div className="settings-status is-error" role="alert">
          <p>Saved provider status could not be loaded. No credentials were changed.</p>
          {profileId != null && (
            <button type="button" className="btn" onClick={retry}>
              Retry
            </button>
          )}
          <p className="settings-hint">Ask the server administrator if playback still fails.</p>
        </div>
      )}

      {administratorManaged && (
        <p className="settings-hint">
          Provider credentials for this profile are managed by the server administrator. Credential changes are unavailable from this profile.
        </p>
      )}

      {phase === "success" && state.phase === "success" && (
        <div aria-live="polite">
          <p className="settings-hint">
            Saved configuration only. This does not verify the token or provider connection.
          </p>
          {configuredProviderSummary(state.statuses) != null && (
            <p className="settings-hint">
              {configuredProviderSummary(state.statuses)}
            </p>
          )}
          {!administratorManaged && (
            <p className="settings-hint">
              {guidanceFor(state.statuses[service], PROVIDER_LABELS[service], role)}
            </p>
          )}
        </div>
      )}

      {canChange && children}
    </div>
  );
}
