import type { Dispatch, SetStateAction } from "react";
import type { RequestRecord } from "../../lib/serverApi";

export type ServerRole = "owner" | "admin" | "member" | "restricted";

export interface ServerUsageSession {
  id: string;
  title: string | null;
  createdAt: string;
  bytesServed: number;
  lastAccessedAt: string | null;
  completedAt: string | null;
  lastStatus: number | null;
}

export interface ServerUsageProfile {
  profileId: string;
  username: string;
  displayName: string;
  role: ServerRole;
  totalBytes: number;
  streamCount: number;
  lastAccessedAt: string | null;
  bandwidthCapBytes?: number | null;
  bandwidthUsageBytes?: number;
  bandwidthStatus?: "ok" | "approaching" | "over";
}

export interface ServerUsage {
  days: number;
  totalBytes: number;
  streamCount: number;
  lastAccessedAt?: string | null;
  sessions?: ServerUsageSession[];
  profiles?: ServerUsageProfile[];
  bandwidthCapBytes?: number | null;
  bandwidthUsageBytes?: number;
  bandwidthStatus?: "ok" | "approaching" | "over";
}

export interface ServerHealth {
  ok: boolean;
  serverTime: string;
  setupRequired: boolean;
  counts: {
    users: number;
    profiles: number;
    activeSessions: number;
    activeStreamSessions: number;
    credentials: number;
    activeInvites: number;
    auditEvents: number;
    recentStreamErrors: number;
    passwordlessProfiles: number;
  };
  config: {
    cookieSecure: boolean;
    cookieSameSite: string;
    trustProxy: boolean;
    corsConfigured: boolean;
    rawStreamUrlsEnabled: boolean;
    webDistConfigured: boolean;
    sessionTtlSeconds: number;
    bindSessionUserAgent: boolean;
    publicMode: boolean;
  };
  update?: {
    currentVersion: string;
    latestVersion: string | null;
    available: boolean;
    url: string;
  };
  transcode?: {
    enabled: boolean;
    ready: boolean;
    configuredEncoder: string;
    activeEncoder: string | null;
    availableVideoEncoders: string[];
    adaptive: boolean;
    seekOffset: boolean;
    subtitleSidecar: boolean;
    toneMapping: boolean;
  };
  warnings: string[];
}

export interface ActiveStreamSession {
  id: string;
  profileId: string;
  username: string;
  displayName: string;
  title: string | null;
  contentType: string | null;
  createdAt: string;
  expiresAt: string;
  bytesServed: number;
  lastAccessedAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
}

export interface ServerSessionEntry {
  id: string;
  userAgent: string | null;
  ipHash: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  current: boolean;
  active: boolean;
}

export interface ServerAuditEvent {
  id: string;
  actorUserId: string | null;
  actorProfileId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

export type CredentialProvider =
  | "tmdb"
  | "omdb"
  | "real_debrid"
  | "all_debrid"
  | "premiumize"
  | "torbox"
  | "openai"
  | "anthropic"
  | "ollama"
  | "opensubtitles"
  | "trakt";

export interface EffectiveCredential {
  id: string | null;
  provider: CredentialProvider;
  scope: "server" | "profile" | null;
  label: string | null;
  priority?: number;
  isActive?: boolean;
  updatedAt?: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatShortDate(value: string | null | undefined): string {
  if (value == null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export const CREDENTIAL_OPTIONS: { provider: CredentialProvider; label: string }[] = [
  { provider: "tmdb", label: "TMDB" },
  { provider: "omdb", label: "OMDB" },
  { provider: "real_debrid", label: "Real-Debrid" },
  { provider: "all_debrid", label: "AllDebrid" },
  { provider: "premiumize", label: "Premiumize" },
  { provider: "torbox", label: "TorBox" },
  { provider: "openai", label: "OpenAI" },
  { provider: "anthropic", label: "Anthropic" },
  { provider: "ollama", label: "Ollama" },
  { provider: "opensubtitles", label: "OpenSubtitles" },
  { provider: "trakt", label: "Trakt" },
];

function credentialProviderLabel(provider: CredentialProvider): string {
  return (
    CREDENTIAL_OPTIONS.find((option) => option.provider === provider)?.label ??
    provider
  );
}

function auditActionLabel(action: string): string {
  return action
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionUserAgentLabel(userAgent: string | null): string {
  if (userAgent == null || userAgent.trim().length === 0) return "Unknown device";
  const value = userAgent.toLowerCase();
  if (value.includes("iphone")) return "iPhone";
  if (value.includes("ipad")) return "iPad";
  if (value.includes("android")) return "Android";
  if (value.includes("mac os") || value.includes("macintosh")) return "Mac";
  if (value.includes("windows")) return "Windows";
  if (value.includes("linux")) return "Linux";
  return userAgent.slice(0, 72);
}

interface ServerAuditPanelProps {
  events: ServerAuditEvent[];
}

interface ServerHealthPanelProps {
  health: ServerHealth;
}

interface ActiveStreamsPanelProps {
  streams: ActiveStreamSession[];
  onRevoke: (id: string) => void;
}

interface RequestQueuePanelProps {
  requests: RequestRecord[];
  onApprove: (id: string) => void;
  onDeny: (id: string, reason?: string) => void;
}

interface PasswordDraft {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

interface PasswordPanelProps {
  draft: PasswordDraft;
  onDraftChange: Dispatch<SetStateAction<PasswordDraft>>;
  onSave: () => void;
  saving: boolean;
}

interface SessionsPanelProps {
  sessions: ServerSessionEntry[];
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
}

export interface ServerTotpStatus {
  enabled: boolean;
  enrollmentPending: boolean;
}

interface TotpPanelProps {
  status: ServerTotpStatus;
  enrollment: { secret: string; otpauthUrl: string } | null;
  code: string;
  currentPassword: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onCurrentPasswordChange: (value: string) => void;
  onEnroll: () => void;
  onConfirm: () => void;
  onDisable: () => void;
}

interface ProfileCredentialDraft {
  provider: CredentialProvider;
  label: string;
  value: string;
}

interface ProfileCredentialPanelProps {
  credentials: EffectiveCredential[];
  draft: ProfileCredentialDraft;
  onDraftChange: Dispatch<SetStateAction<ProfileCredentialDraft>>;
  onSave: () => void;
  onDelete: (id: string) => void;
  saving: boolean;
}

interface ServerUsagePanelProps {
  usage: ServerUsage;
}

export function ServerAuditPanel({ events }: ServerAuditPanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Audit log</span>
        <span className="chip">Recent</span>
      </div>
      {events.length === 0 ? (
        <p className="settings-hint t-secondary">No recent audit events.</p>
      ) : (
        <div className="settings-usage-list">
          {events.map((event) => {
            const actor =
              event.actorDisplayName ?? event.actorUsername ?? "System";
            const target =
              event.targetType != null && event.targetId != null
                ? `${event.targetType}:${event.targetId}`
                : event.targetType ?? "server";
            return (
              <div key={event.id} className="settings-usage-row">
                <span>
                  <strong>{auditActionLabel(event.action)}</strong>
                  <span className="t-secondary"> by {actor}</span>
                </span>
                <span className="settings-profile-meta t-secondary">
                  <span>{target}</span>
                  <span>{formatShortDate(event.createdAt)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ServerHealthPanel({ health }: ServerHealthPanelProps) {
  const flags = [
    `Cookies ${health.config.cookieSecure ? "secure" : "not secure"}`,
    `SameSite ${health.config.cookieSameSite}`,
    health.config.trustProxy ? "Proxy trusted" : "Proxy not trusted",
    health.config.webDistConfigured ? "Hosted PWA ready" : "API only",
    health.config.rawStreamUrlsEnabled ? "Raw stream sessions on" : "Raw stream sessions off",
    health.config.publicMode ? "Public mode on" : "Private mode",
    health.config.bindSessionUserAgent ? "Sessions bound to device" : "Device binding off",
  ];
  const encoderLabels: Record<string, string> = {
    libx264: "CPU software",
    h264_videotoolbox: "Apple VideoToolbox",
    h264_nvenc: "NVIDIA NVENC",
    h264_qsv: "Intel Quick Sync",
  };
  const transcodeRows =
    health.transcode == null
      ? []
      : [
          {
            feature: "Transcoding",
            ready: health.transcode.ready,
            detail: !health.transcode.enabled
              ? "Disabled by server configuration"
              : health.transcode.ready
                ? "FFmpeg and an H.264 encoder are ready"
                : "FFmpeg or the configured H.264 encoder was not detected",
          },
          {
            feature: "Active encoder",
            ready: health.transcode.activeEncoder != null,
            detail:
              health.transcode.activeEncoder == null
                ? `Configured: ${encoderLabels[health.transcode.configuredEncoder] ?? health.transcode.configuredEncoder}`
                : encoderLabels[health.transcode.activeEncoder] ??
                  health.transcode.activeEncoder,
          },
          {
            feature: "Adaptive quality",
            ready: health.transcode.adaptive,
            detail: "1080p, 720p, and 480p HLS renditions",
          },
          {
            feature: "Accurate seeking",
            ready: health.transcode.seekOffset,
            detail: "Server-side seek offset for resumed playback",
          },
          {
            feature: "Subtitle sidecar",
            ready: health.transcode.subtitleSidecar,
            detail: "Extracted WebVTT track when ffprobe is available",
          },
          {
            feature: "HDR tone mapping",
            ready: health.transcode.toneMapping,
            detail: "Uses FFmpeg zscale when detected",
          },
        ];

  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Server health</span>
        <span className={`chip${health.ok ? " is-active" : ""}`}>
          {health.ok ? "Online" : "Check"}
        </span>
      </div>

      <div className="settings-usage-grid">
        <div>
          <strong>{health.counts.users}</strong>
          <span className="t-secondary">Users</span>
        </div>
        <div>
          <strong>{health.counts.activeSessions}</strong>
          <span className="t-secondary">Active sessions</span>
        </div>
        <div>
          <strong>{health.counts.activeStreamSessions}</strong>
          <span className="t-secondary">Active streams</span>
        </div>
        <div>
          <strong>{health.counts.credentials}</strong>
          <span className="t-secondary">Credentials</span>
        </div>
        <div>
          <strong>{health.counts.activeInvites}</strong>
          <span className="t-secondary">Active invites</span>
        </div>
        <div>
          <strong>{health.counts.recentStreamErrors}</strong>
          <span className="t-secondary">24h stream errors</span>
        </div>
      </div>

      <div className="settings-url-list">
        {flags.map((flag) => (
          <span key={flag} className="chip">
            {flag}
          </span>
        ))}
      </div>

      {health.transcode != null && (
        <div className="settings-transcode-matrix">
          <div className="settings-sources-head">
            <span className="settings-sources-title">Transcoding matrix</span>
            <span
              className={`chip${health.transcode.ready ? " is-active" : ""}`}
            >
              {health.transcode.ready ? "Ready" : "Unavailable"}
            </span>
          </div>
          <div className="settings-usage-list">
            {transcodeRows.map((row) => (
              <div className="settings-usage-row" key={row.feature}>
                <span>
                  <strong>{row.feature}</strong>
                  <span className="t-secondary"> {row.detail}</span>
                </span>
                <span className={`chip${row.ready ? " is-active" : ""}`}>
                  {row.ready ? "Ready" : "No"}
                </span>
              </div>
            ))}
          </div>
          <p className="settings-hint t-secondary">
            Detected encoders:{" "}
            {health.transcode.availableVideoEncoders.length > 0
              ? health.transcode.availableVideoEncoders
                  .map((encoder) => encoderLabels[encoder] ?? encoder)
                  .join(", ")
              : "None"}
            . YAWF Stream automatically falls back to CPU software encoding when
            libx264 is available.
          </p>
        </div>
      )}

      {health.warnings.length > 0 && (
        <div className="settings-usage-list">
          {health.warnings.map((warning) => (
            <div key={warning} className="settings-usage-row">
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      {health.update?.available && (
        <p className="settings-status">
          Server {health.update.latestVersion} is available. Running {health.update.currentVersion}.{" "}
          <a href={health.update.url} target="_blank" rel="noreferrer">View update</a>
        </p>
      )}

      <p className="settings-hint t-secondary">
        Last checked {formatShortDate(health.serverTime)}
      </p>
    </div>
  );
}

export function ActiveStreamsPanel({
  streams,
  onRevoke,
}: ActiveStreamsPanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Active streams</span>
        <span className="chip">{streams.length} active</span>
      </div>
      {streams.length === 0 ? (
        <p className="settings-hint t-secondary">No active stream sessions.</p>
      ) : (
        <div className="settings-usage-list">
          {streams.map((stream) => (
            <div key={stream.id} className="settings-usage-row">
              <span>
                <strong>{stream.title ?? "Stream session"}</strong>
                <span className="t-secondary">
                  {" "}
                  {stream.displayName} @{stream.username}
                </span>
              </span>
              <span className="settings-profile-meta t-secondary">
                <span>{formatBytes(stream.bytesServed)}</span>
                {stream.lastStatus != null && <span>HTTP {stream.lastStatus}</span>}
                {stream.lastError != null && <span>{stream.lastError}</span>}
                <span>
                  {stream.lastAccessedAt == null
                    ? `Started ${formatShortDate(stream.createdAt)}`
                    : `Last ${formatShortDate(stream.lastAccessedAt)}`}
                </span>
                <span>Expires {formatShortDate(stream.expiresAt)}</span>
                <button
                  type="button"
                  className="chip"
                  onClick={() => onRevoke(stream.id)}
                >
                  Terminate
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RequestQueuePanel({
  requests,
  onApprove,
  onDeny,
}: RequestQueuePanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Title requests</span>
        <span className="chip">{requests.length} pending</span>
      </div>
      {requests.length === 0 ? (
        <p className="settings-hint t-secondary">No pending title requests.</p>
      ) : (
        <div className="settings-usage-list">
          {requests.map((request) => (
            <div key={request.id} className="settings-usage-row">
              <span>
                <strong>{request.preview.title}</strong>
                {request.preview.year != null && (
                  <span className="t-secondary"> ({request.preview.year})</span>
                )}
                <span className="t-secondary">
                  {" "}
                  - {request.requestedByDisplayName ?? "Someone"}
                </span>
              </span>
              <span className="settings-profile-meta t-secondary">
                <span>{formatShortDate(request.requestedAt)}</span>
                <button
                  type="button"
                  className="chip"
                  onClick={() => onApprove(request.id)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    const reason = window.prompt(
                      "Reason for denying (optional):",
                      "",
                    );
                    // Cancel leaves the request untouched; OK (even empty) denies.
                    if (reason == null) return;
                    onDeny(request.id, reason);
                  }}
                >
                  Deny
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PasswordPanel({
  draft,
  onDraftChange,
  onSave,
  saving,
}: PasswordPanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Password</span>
        <span className="chip">Account</span>
      </div>
      <div className="settings-source-row">
        <input
          type="password"
          value={draft.currentPassword}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              currentPassword: event.target.value,
            }))
          }
          placeholder="Current password"
        />
      </div>
      <div className="settings-source-row">
        <input
          type="password"
          value={draft.newPassword}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              newPassword: event.target.value,
            }))
          }
          placeholder="New password"
        />
        <input
          type="password"
          value={draft.confirmPassword}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              confirmPassword: event.target.value,
            }))
          }
          placeholder="Confirm new password"
        />
        <button
          type="button"
          className="btn"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Changing…" : "Change password"}
        </button>
      </div>
    </div>
  );
}

export function SessionsPanel({
  sessions,
  onRevoke,
  onRevokeAll,
}: SessionsPanelProps) {
  const activeSessions = sessions.filter((session) => session.active);
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Signed-in devices</span>
        <span className="settings-profile-meta">
          <span className="chip">{activeSessions.length} active</span>
          {activeSessions.length > 0 && (
            <button type="button" className="chip" onClick={onRevokeAll}>
              Sign out all devices
            </button>
          )}
        </span>
      </div>
      {sessions.length === 0 ? (
        <p className="settings-hint t-secondary">No sessions found.</p>
      ) : (
        <div className="settings-usage-list">
          {sessions.map((session) => (
            <div key={session.id} className="settings-usage-row">
              <span>
                <strong>{sessionUserAgentLabel(session.userAgent)}</strong>
                <span className="t-secondary">
                  {" "}
                  {session.current ? "Current session" : `Started ${formatShortDate(session.createdAt)}`}
                </span>
              </span>
              <span className="settings-profile-meta t-secondary">
                <span>
                  {session.active
                    ? `Expires ${formatShortDate(session.expiresAt)}`
                    : session.revokedAt != null
                      ? `Revoked ${formatShortDate(session.revokedAt)}`
                      : "Expired"}
                </span>
                {session.active && !session.current && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => onRevoke(session.id)}
                  >
                    Revoke
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TotpPanel({
  status,
  enrollment,
  code,
  currentPassword,
  busy,
  onCodeChange,
  onCurrentPasswordChange,
  onEnroll,
  onConfirm,
  onDisable,
}: TotpPanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Two-factor authentication</span>
        <span className={`chip${status.enabled ? " is-active" : ""}`}>
          {status.enabled ? "Enabled" : "Off"}
        </span>
      </div>
      {!status.enabled && enrollment == null && (
        <>
          <p className="settings-hint t-secondary">
            Protect owner and admin sign-ins with a six-digit authenticator code.
          </p>
          <button type="button" className="btn" onClick={onEnroll} disabled={busy}>
            Set up authenticator
          </button>
        </>
      )}
      {!status.enabled && enrollment != null && (
        <div className="settings-fields">
          <p className="settings-hint t-secondary">
            Add this key to your authenticator app, then enter its current code.
          </p>
          <code className="settings-server-code">{enrollment.secret}</code>
          <a className="chip" href={enrollment.otpauthUrl}>Open authenticator app</a>
          <input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            aria-label="Authenticator code"
          />
          <button type="button" className="btn" onClick={onConfirm} disabled={busy || code.length !== 6}>
            Confirm and enable
          </button>
        </div>
      )}
      {status.enabled && (
        <div className="settings-source-row">
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => onCurrentPasswordChange(event.target.value)}
            placeholder="Current password"
          />
          <input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            aria-label="Authenticator code"
          />
          <button type="button" className="btn" onClick={onDisable} disabled={busy || currentPassword.length === 0 || code.length !== 6}>
            Disable 2FA
          </button>
        </div>
      )}
    </div>
  );
}

export function ProfileCredentialPanel({
  credentials,
  draft,
  onDraftChange,
  onSave,
  onDelete,
  saving,
}: ProfileCredentialPanelProps) {
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Credential overrides</span>
        <span className="chip">Profile</span>
      </div>
      <p className="settings-hint t-secondary">
        Your profile can use a personal API key or debrid token instead of the
        shared server default for the selected provider.
      </p>

      <div className="settings-source-row">
        <select
          aria-label="Profile credential provider"
          value={draft.provider}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              provider: event.target.value as CredentialProvider,
            }))
          }
        >
          {CREDENTIAL_OPTIONS.map((item) => (
            <option key={item.provider} value={item.provider}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={draft.label}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              label: event.target.value,
            }))
          }
          placeholder="Label"
        />
      </div>
      <div className="settings-source-row">
        <input
          type="password"
          value={draft.value}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              value: event.target.value,
            }))
          }
          placeholder="Token or API key"
        />
        <button
          type="button"
          className="btn"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save profile override"}
        </button>
      </div>

      <div className="settings-usage-list">
        {credentials.map((credential) => (
          <div key={credential.provider} className="settings-usage-row">
            <span>
              <strong>{credentialProviderLabel(credential.provider)}</strong>
              <span className="t-secondary">
                {" "}
                {credential.label ?? "Not configured"}
              </span>
            </span>
            <span className="settings-profile-meta t-secondary">
              <span>
                {credential.scope === "profile"
                  ? "Profile override"
                  : credential.scope === "server"
                    ? "Shared server"
                    : "Missing"}
              </span>
              {credential.scope === "profile" && credential.id != null && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => onDelete(credential.id!)}
                >
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ServerUsagePanel({ usage }: ServerUsagePanelProps) {
  const topProfiles = usage.profiles?.slice(0, 6) ?? [];
  const recentSessions = usage.sessions?.slice(0, 6) ?? [];
  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Stream forwarding</span>
        <span className="chip">{usage.days} days</span>
      </div>
      <div className="settings-usage-grid">
        <div>
          <strong>{formatBytes(usage.totalBytes)}</strong>
          <span className="t-secondary">Forwarded</span>
        </div>
        <div>
          <strong>{usage.streamCount}</strong>
          <span className="t-secondary">Stream sessions</span>
        </div>
        <div>
          <strong>{formatShortDate(usage.lastAccessedAt)}</strong>
          <span className="t-secondary">Last activity</span>
        </div>
      </div>

      {topProfiles.length > 0 && (
        <div className="settings-usage-list">
          {topProfiles.map((profile) => (
            <div key={profile.profileId} className="settings-usage-row">
              <span>
                <strong>{profile.displayName}</strong>
                <span className="t-secondary"> @{profile.username}</span>
              </span>
              <span className="t-secondary">
                {formatBytes(profile.totalBytes)} · {profile.streamCount} streams
                {profile.bandwidthCapBytes != null
                  ? ` · ${formatBytes(profile.bandwidthUsageBytes ?? 0)} of ${formatBytes(profile.bandwidthCapBytes)} cap (${profile.bandwidthStatus ?? "ok"})`
                  : " · No monthly cap"}
              </span>
            </div>
          ))}
        </div>
      )}

      {recentSessions.length > 0 && (
        <div className="settings-usage-list">
          {recentSessions.map((session) => (
            <div key={session.id} className="settings-usage-row">
              <span>{session.title ?? "Stream session"}</span>
              <span className="t-secondary">
                {formatBytes(session.bytesServed)} · {formatShortDate(session.lastAccessedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
