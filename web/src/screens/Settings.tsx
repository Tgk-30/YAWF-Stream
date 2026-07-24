// Settings screen - on-brand tabbed config, persisted through the app store.
//
// Three tabs:
//   • API keys - TMDB / OMDB metadata keys + the AI provider (kind, key, model).
//   • Debrid - per-service tokens (Real-Debrid / AllDebrid / Premiumize / TorBox),
//     in priority order.
//   • Sources - the built-in scrapers toggle + a list of external indexers
//     (Torznab / Jackett / Prowlarr / Zilean / Stremio add-ons).
//
// Saving writes through the store (updateSettings → saveSettings), which rebuilds
// the shared service instances, so a TMDB key entered here immediately lights up
// live data elsewhere. Credential values are routed through the SecretStore
// abstraction; desktop builds can back that with native secure storage.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { useAppStore } from "../store/AppStore";
import {
  useServerSession,
  useTranscodeAvailable,
  useSetServerSession,
} from "../lib/ServerSessionContext";
import { notifyUnauthorized, readCsrfToken } from "../lib/serverSession";
import { isSmartPreloadEnabled, setSmartPreloadEnabled } from "../lib/smartPreload";
import type { AccountProfile, RequestRecord } from "../lib/serverApi";
import {
  exportServerPortableProfile,
  fetchAccountProfiles,
  importServerPortableProfile,
  setProfileMaturity,
  testServerDebridToken,
} from "../lib/serverApi";
import {
  ActiveStreamsPanel,
  CREDENTIAL_OPTIONS,
  PasswordPanel,
  ProfileCredentialPanel,
  RequestQueuePanel,
  ServerAuditPanel,
  ServerHealthPanel,
  ServerUsagePanel,
  SessionsPanel,
  TotpPanel,
  formatShortDate,
  type ActiveStreamSession,
  type CredentialProvider,
  type EffectiveCredential,
  type ServerAuditEvent,
  type ServerHealth,
  type ServerRole,
  type ServerSessionEntry,
  type ServerTotpStatus,
  type ServerUsage,
} from "./settings/ServerStatusPanels";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { BUG_REPORT_URL } from "../lib/projectLinks";
import { Field, SegmentedControl } from "./settings/SettingsControls";
import type {
  AppSettings,
  DefaultSubtitleBehavior,
  RatingScale,
  SourceEntry,
  StreamMaxQuality,
} from "../data/settings";
import { PLAYBACK_LANGUAGE_OPTIONS } from "../lib/languagePreference";
import {
  INTERFACE_LANGUAGE_OPTIONS,
  METADATA_LANGUAGE_OPTIONS,
  METADATA_REGION_OPTIONS,
} from "../lib/localization";
import { DebridServiceType } from "../services/debrid/models";
import { AIProviderKind } from "../services/ai/models";
import { fetchAvailableModels } from "../services/ai/ModelCatalog";
import { readModelCache, writeModelCache } from "../services/ai/ModelCache";
import { appFetch } from "../lib/http";
import { testDebridToken } from "../lib/onboardingValidation";
import { getStore } from "../storage";
import {
  createProfileRecord,
  deleteProfileRecord,
  setMultiUserEnabled,
  getAutoEnterProfileId,
  setAutoEnterProfileId,
  updateProfileRecord,
  type LocalProfile,
} from "../storage/ProfileRegistry";
import { hashPassword } from "../lib/passwordHash";
import type { StoredIndexerType } from "../storage/models";
import { Icon } from "../components/Icon";
import { AvatarPicker } from "../components/AvatarPicker";
import {
  DEFAULT_PROFILE_AVATAR,
  DEFAULT_PROFILE_COLOR,
  PROFILE_COLORS,
  isImageAvatar,
} from "../data/profileAvatars";
import { InfoTip } from "../components/InfoTip";
import { AdvancedOnly } from "../components/AdvancedOnly";
import { SettingsSearch } from "../components/SettingsSearch";
import { CONCEPTS, signupUrl } from "../data/onboardingHelp";
import {
  type BeforeInstallPromptEvent,
  deviceKind,
  isStandaloneDisplay,
} from "../lib/platform";
import {
  configuredServerURL,
  configuredServerURLSource,
  isServerMode,
  saveServerURL,
} from "../lib/serverMode";
import {
  desktopServerStatus,
  detectTunnelTools,
  getAppInstallInfo,
  isTauri,
  listExternalPlayers,
  openExternalURL,
  revealInFileManager,
  startDesktopServer,
  stopDesktopServer,
  type DesktopServerStatus,
  type TunnelTools,
} from "../lib/tauri";
import { getDownloadsBridge } from "../lib/downloadsBridge";
import { getAppVersion } from "../lib/appVersion";
import {
  buildDiagnosticsReport,
  downloadDiagnosticsReport,
  recordDiagnostic,
} from "../lib/diagnostics";
import type {
  DebridManager,
  ProviderSmokeResult,
} from "../services/debrid/DebridManager";
import type { SettingsSection } from "../lib/settingsNavigation";
import {
  DOWNLOADS_DIRECTORY_SETTING,
  downloadsDirectory,
} from "../services/downloads";
import {
  clearTraktConnection,
  isTraktConnected,
  loadTraktConnection,
} from "../data/traktConnection";
import { TraktConnectDialog } from "../components/TraktConnectDialog";
import { useModalA11y } from "../components/useModalA11y";
import { factoryReset } from "../data/factoryReset";
import {
  exportPortableBackup,
  parsePortableBackup,
  parsePortableProfileBundle,
  portableBackupFilename,
  portableProfileBundleFromBackup,
  restorePortableBackup,
  type PortableBackup,
  type PortableProfileBundle,
} from "../data/portableBackup";
import "./Settings.css";

/** The selectable external-source types. */
const SOURCE_TYPES: StoredIndexerType[] = [
  "torznab",
  "jackett",
  "prowlarr",
  "zilean",
  "stremio_addon",
];

const CUSTOM_SOURCE_URL = "__custom";

interface SourcePreset {
  id: string;
  label: string;
  type: StoredIndexerType;
  baseURL: string;
  displayName: string;
  note: string;
}

const SOURCE_PRESETS: SourcePreset[] = [
  {
    id: "jackett-local",
    label: "Jackett local",
    type: "jackett",
    baseURL: "http://localhost:9117",
    displayName: "Jackett",
    note: "Uses Jackett's all-indexers Torznab API.",
  },
  {
    id: "prowlarr-local",
    label: "Prowlarr local",
    type: "prowlarr",
    baseURL: "http://localhost:9696",
    displayName: "Prowlarr",
    note: "Sends the API key as the Prowlarr header.",
  },
  {
    id: "zilean-local",
    label: "Zilean local",
    type: "zilean",
    baseURL: "http://localhost:8181",
    displayName: "Zilean",
    note: "Torznab-compatible Zilean endpoint.",
  },
  {
    id: "stremio-torrentio",
    label: "Torrentio addon",
    type: "stremio_addon",
    baseURL: "https://torrentio.strem.fun",
    displayName: "Torrentio",
    note: "Manifest URLs also work; playback resolves through stream endpoints.",
  },
  {
    id: "torznab-custom",
    label: "Custom Torznab URL",
    type: "torznab",
    baseURL: "http://localhost:9117",
    displayName: "Torznab",
    note: "Generic Torznab base URL for custom endpoints.",
  },
];

function sourceTypeLabel(type: StoredIndexerType): string {
  switch (type) {
    case "torznab":
      return "Torznab";
    case "jackett":
      return "Jackett";
    case "prowlarr":
      return "Prowlarr";
    case "zilean":
      return "Zilean";
    case "stremio_addon":
      return "Stremio Addon";
    case "built_in":
      return "Built-in Scrapers";
  }
}

function sourcePreset(id: string): SourcePreset {
  return SOURCE_PRESETS.find((preset) => preset.id === id) ?? SOURCE_PRESETS[0];
}

function defaultSourcePreset(type: StoredIndexerType): SourcePreset {
  return SOURCE_PRESETS.find((preset) => preset.type === type) ?? SOURCE_PRESETS[0];
}

function sourceURLChoices(type: StoredIndexerType, current: string) {
  const base = SOURCE_PRESETS.filter((preset) => preset.type === type).map((preset) => ({
    label: preset.label,
    value: preset.baseURL,
  }));
  const trimmed = current.trim();
  return trimmed.length > 0 && !base.some((option) => option.value === trimmed)
    ? [{ label: "Current custom URL", value: trimmed }, ...base]
    : base;
}

type Tab = SettingsSection;

const TABS: { id: Tab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "language", label: "Language & region" },
  { id: "playback", label: "Playback" },
  { id: "privacy", label: "Privacy" },
  { id: "install", label: "Install & setup" },
  { id: "profiles", label: "Profiles" },
  { id: "updates", label: "Help & updates" },
  { id: "server", label: "Server" },
  { id: "keys", label: "API keys" },
  { id: "debrid", label: "Providers" },
  { id: "sources", label: "Sources" },
];

const TAB_DESCRIPTIONS: Record<Tab, string> = {
  appearance: "Themes, layout, and visual comfort for this profile.",
  language: "Interface language, metadata language, and regional release context.",
  playback: "Player behavior, captions, quality, and handoff preferences.",
  privacy: "Network access, local storage, and data controls for this device.",
  install: "Install YAWF Stream and finish setup on this device.",
  profiles: "Names, avatars, colors, and sign-in protection for this device.",
  updates: "Troubleshooting, diagnostics, version checks, and release status.",
  server: "Hosting, remote access, and shared server settings.",
  keys: "Metadata, subtitle, and optional service credentials.",
  debrid: "Connect and verify the streaming accounts you already use.",
  sources: "Indexer order, add-ons, and source matching.",
};

// Tabs visible in Simple mode (progressive disclosure). Advanced unlocks the
// rest (Server and Sources). Help, diagnostics, and updates stay visible so
// Simple-mode users can recover from failures without changing experience mode.
const SIMPLE_TABS = new Set<Tab>([
  "appearance",
  "language",
  "playback",
  "privacy",
  "install",
  "keys",
  "debrid",
  "profiles",
  "updates",
]);

/** Pure, testable tab filter for the current modes. */
export function visibleTabs(opts: {
  serverMode: boolean;
  simpleMode: boolean;
}): { id: Tab; label: string }[] {
  return TABS.filter((t) => {
    if (!opts.serverMode && t.id === "server") return false;
    if (opts.serverMode && t.id === "profiles") return false;
    if (opts.simpleMode && !SIMPLE_TABS.has(t.id)) return false;
    return true;
  });
}

interface ServerProfile {
  id: string;
  username?: string;
  displayName: string;
  role: ServerRole;
  simpleMode?: boolean;
  disabled?: boolean;
  self?: boolean;
}

interface ServerInvite {
  id: string;
  label: string | null;
  role: Exclude<ServerRole, "owner">;
  simpleMode: boolean;
  maxUses: number;
  usedCount: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}

interface HealthResponse {
  ok: boolean;
  setupRequired?: boolean;
}

type InstallPath = "device" | "connect" | "downloads" | "deploy";

function inferServerURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("Enter a server URL.");
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString().replace(/\/+$/, "");

  const host = trimmed.split("/", 1)[0] ?? trimmed;
  const local =
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith(".local") ||
    host.includes(".local:");
  const scheme = local ? "http" : "https";
  return new URL(`${scheme}://${trimmed}`).toString().replace(/\/+$/, "");
}

async function serverRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const baseURL = configuredServerURL();
  if (baseURL == null) throw new Error("Server Mode is not configured.");
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    // Canonical CSRF source: prefers the in-memory token captured at bootstrap
    // and only falls back to document.cookie same-origin - a cross-origin
    // (pasted remote URL) client can't read the server origin's ds_csrf cookie.
    const csrf = readCsrfToken();
    if (csrf != null) headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(`${baseURL}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON body (e.g. a reverse-proxy 5xx) - fall through to a status error.
    }
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error
        : `Server request failed (${response.status}).`,
    );
  }
  return parsed as T;
}

export function Settings() {
  const {
    settings,
    services,
    updateSettings,
    simpleMode,
    activeProfile,
    profiles,
    multiUserEnabled,
    refreshProfiles,
    pendingSettingsSection,
    clearPendingSettingsSection,
  } = useAppStore();
  const serverSession = useServerSession();
  const setServerSession = useSetServerSession();
  // Land where the user's next step is: an unconfigured profile (no debrid
  // token yet) opens on Install & setup - the critical path - instead of the
  // Appearance dial-park. Configured profiles keep the familiar default.
  const [tab, setTab] = useState<Tab>(() =>
    pendingSettingsSection ??
    (settings.debridTokens.some((t) => t.apiToken.trim().length > 0)
      ? "appearance"
      : "install"),
  );
  // Edit a local draft; "Save" commits it through the store.
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const settingsScreenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pendingSettingsSection != null) clearPendingSettingsSection();
  }, [clearPendingSettingsSection, pendingSettingsSection]);

  // Every category is its own page-sized task. A long category must not hand
  // its scroll position to the next one, otherwise the next category opens in
  // the middle with its title and primary controls off screen.
  useLayoutEffect(() => {
    const scroller = settingsScreenRef.current?.closest(".app-content");
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  }, [tab]);

  // Switching profiles swaps the settings under us. The draft was seeded once at
  // mount, so without this it would still hold the PREVIOUS profile's values and
  // Save would write them into the profile just switched to. Keyed on the
  // profile id (not `settings`) so ordinary edits are never clobbered.
  const draftProfileId = useRef<string | null>(activeProfile?.id ?? null);
  useEffect(() => {
    const id = activeProfile?.id ?? null;
    if (draftProfileId.current === id) return;
    draftProfileId.current = id;
    setDraft(settings);
    setSaved(false);
    setSaveError(null);
  }, [activeProfile?.id, settings]);

  useEffect(() => {
    let mounted = true;
    void getAppVersion().then((version) => {
      if (mounted) setAppVersion(version);
    });
    return () => {
      mounted = false;
    };
  }, []);

  function patch(next: Partial<AppSettings>) {
    setDraft((d) => ({ ...d, ...next }));
    setSaved(false);
  }

  async function save() {
    setSaveError(null);
    const result = await updateSettings(draft);
    if (result.ok) {
      setSaved(true);
      return;
    }
    // Don't claim a save that didn't happen (e.g. a keychain write failing
    // closed on desktop). The in-memory value still applies for this session.
    setSaved(false);
    setSaveError(
      "Could not save to this device. Your changes apply for now, but will be lost when the app restarts.",
    );
  }

  const applyAppearance = useCallback((next: Partial<AppSettings>) => {
    // Appearance controls are instant-apply. Reflect the change in the preview
    // draft, but PERSIST only the appearance change layered on the last-SAVED
    // settings - NOT the whole draft. Persisting the draft would silently commit
    // unsaved edits from other tabs (e.g. a half-typed API key or debrid token)
    // and wrongly clear the "unsaved changes" indicator on a mere theme nudge.
    setDraft((d) => ({ ...d, ...next }));
    updateSettings({ ...settings, ...next });
    setSaved(true);
  }, [settings, updateSettings]);

  const serverMode = isServerMode();
  const tabs = visibleTabs({ serverMode, simpleMode });

  // Redirect off a now-hidden tab (e.g. after flipping to Simple while on
  // Server/Sources/Updates) so the user never lands on a blank pane.
  useEffect(() => {
    if (!visibleTabs({ serverMode, simpleMode }).some((t) => t.id === tab)) {
      setTab("appearance");
    }
  }, [serverMode, simpleMode, tab]);

  // Toggle the experience tier. Local Mode persists to AppSettings; Server Mode
  // PATCHes the profile's simple_mode and optimistically updates the session.
  const setExperience = useCallback(
    (simple: boolean) => {
      if (isServerMode()) {
        const base = configuredServerURL();
        const profileId = serverSession?.profileId;
        if (base == null || profileId == null) return;
        const csrf = readCsrfToken();
        // Optimistic, then RECONCILED. The PATCH used to be fired with its
        // rejection swallowed and its status never read, so a failed write still
        // flipped the whole UI and the tier quietly reverted on the next launch.
        const previous = serverSession;
        if (serverSession != null) {
          setServerSession({ ...serverSession, simpleMode: simple });
        }
        void fetch(`${base}/api/profiles/${encodeURIComponent(profileId)}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            ...(csrf != null ? { "x-csrf-token": csrf } : {}),
          },
          body: JSON.stringify({ simpleMode: simple }),
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          })
          .catch(() => {
            // Put the control back where the server still has it.
            if (previous != null) setServerSession(previous);
            setSaveError("Could not change the experience tier on the server.");
          });
      } else {
        updateSettings({ ...settings, simpleMode: simple });
      }
    },
    [settings, updateSettings, serverSession, setServerSession],
  );

  const selectedTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );
  const saveLabel = hasUnsavedChanges ? "Save changes" : saved ? "Saved" : "Up to date";
  // A failed durable write must not read as "Profile saved".
  const saveNote = saveError
    ? saveError
    : hasUnsavedChanges
      ? "Unsaved changes are local until you save this profile."
      : "Profile saved · credentials protected";

  return (
    <div className="settings-screen" ref={settingsScreenRef}>
      <header className="settings-header settings-hero glass-raised glass-lit">
        <div className="settings-title-block">
          <h1 className="settings-h1">Settings</h1>
          <p className="settings-subtitle t-secondary">
            {TAB_DESCRIPTIONS[selectedTab.id]}
          </p>
        </div>

        {tab !== "install" && (
          <div className={`settings-footer${hasUnsavedChanges ? " is-dirty" : " is-clean"}`}>
            <span className="settings-note t-secondary" aria-live="polite">
              {saveNote}
            </span>
            <button
              type="button"
              className="btn btn-prominent"
              onClick={save}
              disabled={!hasUnsavedChanges}
              aria-label={saveLabel}
              title={saveLabel}
            >
              <Icon
                name={hasUnsavedChanges ? "save" : "check"}
                size={16}
                className="settings-save-icon"
              />
              <span className="settings-save-label">{saveLabel}</span>
            </button>
          </div>
        )}
      </header>

      <SettingsSearch
        onJump={(id) => setTab(id as Tab)}
        visibleTabs={new Set(tabs.map((t) => t.id))}
      />

      <label className="settings-tab-select">
        <span className="settings-label">Settings category</span>
        <select value={tab} onChange={(event) => setTab(event.target.value as Tab)}>
          {tabs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <div className="settings-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            data-tab={t.id}
            className={`chip${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-panel glass-raised glass-lit">
        <h2 className="sr-only">{selectedTab.label}</h2>
        {tab === "appearance" && (
          <AppearanceTab
            draft={draft}
            applyAppearance={applyAppearance}
            serverMode={serverMode}
          />
        )}
        {tab === "language" && <LanguageRegionTab draft={draft} patch={patch} />}
        {tab === "install" && <InstallTab />}
        {tab === "playback" && <PlaybackTab draft={draft} patch={patch} />}
        {tab === "privacy" && <PrivacyTab draft={draft} patch={patch} />}
        {tab === "updates" && (
          <UpdatesTab
            draft={draft}
            patch={patch}
            debrid={services?.debrid ?? null}
            appVersion={appVersion ?? __APP_VERSION__}
          />
        )}
        {tab === "server" && <ServerTab />}
        {tab === "keys" && <KeysTab draft={draft} patch={patch} />}
        {tab === "debrid" && <DebridTab draft={draft} patch={patch} />}
        {tab === "sources" && <SourcesTab draft={draft} patch={patch} />}
        {tab === "profiles" && !serverMode && (
          <ProfilesTab
            activeProfile={activeProfile}
            profiles={profiles}
            multiUserEnabled={multiUserEnabled}
            refreshProfiles={refreshProfiles}
            settings={settings}
            updateSettings={updateSettings}
          />
        )}
      </div>

      <div className="settings-experience">
        <SegmentedControl
          label="Experience tier"
          value={simpleMode ? "simple" : "advanced"}
          options={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced" },
          ]}
          onChange={(v) => setExperience(v === "simple")}
          infoTip="Advanced is the default. Simple hides Calendar, Assistant, and Debrid while keeping the essential screens and settings."
        />
      </div>

      <ResetAndUninstall />

      <p className="settings-version t-secondary">
        YAWF Stream v{appVersion ?? "…"}
      </p>
    </div>
  );
}

// The Debian control file's Package field is the kebab-cased productName
// ("YAWF Stream" -> "yawf-stream"). The .deb FILENAME uses the product
// name verbatim (YAWF Stream_x.y.z_amd64.deb), but apt operates on the
// Package field, so this must stay kebab-cased or the command fails.
const DEB_REMOVE_COMMAND = "sudo apt remove yawf-stream";

function ResetAndUninstall() {
  const desktop = isTauri();
  const serverMode = configuredServerURL() != null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [installInfo, setInstallInfo] = useState<Awaited<ReturnType<typeof getAppInstallInfo>> | null>(null);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // Escape must go through closeConfirm, not a bare setConfirmOpen(false):
  // closing has to clear the typed ERASE and any stale failure state, or the
  // dialog reopens with the destructive button pre-armed.
  const dialogRef = useModalA11y<HTMLDivElement>(closeConfirm, confirmOpen);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void getAppInstallInfo()
      .then((info) => {
        if (!cancelled) setInstallInfo(info);
      })
      .catch((error) => {
        if (!cancelled) setUninstallError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  function closeConfirm() {
    if (resetting) return;
    setConfirmOpen(false);
    setConfirmation("");
    setResetError(null);
  }

  async function erase() {
    if (confirmation !== "ERASE") return;
    setResetting(true);
    setResetError(null);
    try {
      await factoryReset();
    } catch (error) {
      setResetError(error instanceof Error ? error.message : String(error));
      setResetting(false);
    }
  }

  async function copyDebCommand() {
    // Clear first so a repeat copy is a fresh content change the aria-live
    // region announces (an identical string re-set would be silent).
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(DEB_REMOVE_COMMAND);
      setCopyStatus("Command copied.");
    } catch {
      setCopyStatus("Copy is unavailable. Select the command and copy it manually.");
    }
  }

  return (
    <section className="settings-reset-card glass-raised glass-lit" aria-labelledby="settings-reset-title">
      <div className="settings-reset-heading">
        <div>
          <h2 id="settings-reset-title">Reset &amp; uninstall</h2>
          <p className="settings-hint t-secondary">Remove this device&apos;s data or get help uninstalling the app.</p>
        </div>
        <button type="button" className="btn settings-reset-erase" onClick={() => setConfirmOpen(true)}>
          Erase all data on this device
        </button>
      </div>

      {!desktop ? (
        <p className="settings-hint t-secondary">
          Installed as a browser app? Remove it from your browser&apos;s app menu. Use Erase all data above to clear what it stored.
        </p>
      ) : (
        <div className="settings-reset-uninstall">
          <p className="settings-hint t-secondary">
            Uninstalling does not remove your data. Use Erase all data first if you want a clean removal.
          </p>
          {installInfo?.format === "windows" && (
            <>
              <p className="settings-hint t-secondary">Find YAWF Stream in the list and choose Uninstall.</p>
              <button type="button" className="btn" onClick={() => void openExternalURL("ms-settings:appsfeatures")}>
                Open Windows app settings
              </button>
            </>
          )}
          {installInfo?.format === "macos-app" && (
            <>
              <p className="settings-hint t-secondary">Quit the app, then drag it to the Trash.</p>
              {installInfo.appBundlePath != null && (
                <button type="button" className="btn" onClick={() => void revealInFileManager(installInfo.appBundlePath!)}>
                  Reveal YAWF Stream in Finder
                </button>
              )}
            </>
          )}
          {installInfo?.format === "linux-appimage" && (
            <>
              <p className="settings-hint t-secondary">Delete the file to uninstall.</p>
              {installInfo.appimagePath != null && (
                <button type="button" className="btn" onClick={() => void revealInFileManager(installInfo.appimagePath!)}>
                  Reveal AppImage
                </button>
              )}
            </>
          )}
          {installInfo?.format === "linux-deb" && (
            <>
              <p className="settings-hint t-secondary">Remove the Debian package with this command.</p>
              <div className="settings-reset-command">
                <code>{DEB_REMOVE_COMMAND}</code>
                <button type="button" className="chip" onClick={() => void copyDebCommand()}>Copy command</button>
              </div>
              {/* Always mounted: a live region only announces content CHANGES,
                  so mounting it together with its first message drops it. */}
              <p className="settings-status" aria-live="polite">{copyStatus ?? ""}</p>
            </>
          )}
          {installInfo?.format === "unknown" && (
            <p className="settings-hint t-secondary">Remove YAWF Stream using this desktop&apos;s normal app management tools.</p>
          )}
          {uninstallError != null && <p className="settings-status is-error">{uninstallError}</p>}
        </div>
      )}

      {confirmOpen && createPortal(
        <div className="settings-reset-backdrop" role="presentation" onMouseDown={closeConfirm}>
          <div
            ref={dialogRef}
            className="settings-reset-dialog glass-hero glass-lit"
            role="dialog"
            aria-modal="true"
            aria-label="Erase all data on this device"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>{resetError == null ? "Erase all data on this device?" : "Reset incomplete"}</h2>
            <p>Erases everything YAWF Stream stores on this device: settings, library, watch history, API keys, and sign-in. The app restarts in first-run setup.</p>
            {serverMode && <p>Your household&apos;s data on the server is not touched.</p>}
            <p>Downloaded video files in your downloads folder are NOT deleted.</p>
            {resetError != null && <p className="settings-status is-error" role="alert">{resetError}</p>}
            <label className="settings-field">
              <span className="settings-label">Type ERASE to confirm</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={resetting} autoComplete="off" />
            </label>
            <div className="settings-reset-actions">
              <button type="button" className="chip" onClick={closeConfirm} disabled={resetting}>Cancel</button>
              <button type="button" className="btn settings-reset-erase" onClick={() => void erase()} disabled={confirmation !== "ERASE" || resetting}>
                {resetting ? "Erasing" : resetError == null ? "Erase all data" : "Retry"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

function localProfileId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ProfilesTab({
  activeProfile,
  profiles,
  multiUserEnabled,
  refreshProfiles,
  settings,
  updateSettings,
}: {
  activeProfile: LocalProfile | null;
  profiles: LocalProfile[];
  multiUserEnabled: boolean;
  refreshProfiles: () => Promise<void>;
  settings: AppSettings;
  updateSettings: (next: AppSettings) => Promise<{ ok: boolean }>;
}) {
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const canManage = activeProfile?.isAdmin ?? false;

  async function refresh(message?: string) {
    await refreshProfiles();
    setMessage(message ?? null);
  }

  // Editing the ACTIVE profile's identity here must also update the shared
  // settings.userName/userAvatar the ProfileMenu reads, or the top-right menu
  // shows a stale name/avatar after a reload (ProfileMenu syncs the other way).
  function editProfile(profile: LocalProfile, patch: { name?: string; avatar?: string; color?: string }) {
    void updateProfileRecord(profile.id, patch).then(() => refreshProfiles());
    if (profile.id === activeProfile?.id) {
      if (patch.name !== undefined) updateSettings({ ...settings, userName: patch.name });
      if (patch.avatar !== undefined) updateSettings({ ...settings, userAvatar: patch.avatar });
    }
  }

  async function addProfile() {
    const name = newName.trim();
    if (!name) return setMessage("Enter a name for the new profile.");
    await createProfileRecord({
      id: localProfileId(),
      name,
      avatar: DEFAULT_PROFILE_AVATAR,
      color: DEFAULT_PROFILE_COLOR,
      isDefault: false,
      isAdmin: false,
      createdAt: Date.now(),
    });
    setNewName("");
    await refresh("Profile added.");
  }

  function uploadProfilePhoto(profile: LocalProfile, file: File | undefined) {
    if (file == null) return;
    if (!file.type.startsWith("image/")) {
      setMessage("Choose an image file for the profile photo.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage("Profile photos must be smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setMessage("That profile photo could not be read.");
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      editProfile(profile, { avatar: reader.result });
      setMessage("Profile photo updated.");
    };
    reader.readAsDataURL(file);
  }

  async function savePassword(profile: LocalProfile) {
    const plain = passwords[profile.id] ?? "";
    if (!plain) return setMessage("Enter a password before saving it.");
    const passwordHash = await hashPassword(plain);
    await updateProfileRecord(profile.id, { passwordHash });
    setPasswords((previous) => ({ ...previous, [profile.id]: "" }));
    await refresh("Password saved.");
  }

  // The launch preference lives in the profile registry (it decides WHICH
  // profile to load, so it cannot live in a profile's own settings).
  const [autoEnterId, setAutoEnterId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAutoEnterProfileId().then((id) => {
      if (!cancelled) setAutoEnterId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function deleteProfile(profile: LocalProfile) {
    if (profiles.length <= 1) return setMessage("You need at least one profile.");
    if (profile.id === activeProfile?.id) return setMessage("Switch to another profile before deleting this one.");
    await deleteProfileRecord(profile.id);
    await refresh("Profile deleted. Its data remains in its local database.");
  }

  return (
    <div className="settings-fields settings-profiles">
      {/* Checkbox first, and WITHOUT settings-field: every other toggle row in
          Settings is ordered this way, and settings-field is flex-direction:
          column, which fights settings-toggle-row's row layout. */}
      <label className="settings-toggle-row">
        <input type="checkbox" checked={multiUserEnabled} onChange={(event) => void setMultiUserEnabled(event.target.checked).then(() => refreshProfiles())} />
        <span className="settings-label-line"><span className="settings-label">Enable multiple profiles</span><InfoTip label="Multiple profiles">Everyone on this device gets their own library, history, and watchlist. Turning this off keeps only the current profile active; it never deletes other profiles or their data.</InfoTip></span>
      </label>

      {profiles.length > 1 && (
        <label className="settings-field">
          <span className="settings-label-line">
            <span className="settings-label">Start as</span>
            <InfoTip label="Start as">
              Skip the &quot;Who&apos;s watching?&quot; screen and open straight into one
              profile. A profile with a password still asks for it.
            </InfoTip>
          </span>
          <select
            aria-label="Start as profile"
            value={autoEnterId ?? ""}
            onChange={(event) => {
              const next = event.target.value === "" ? null : event.target.value;
              setAutoEnterId(next);
              void setAutoEnterProfileId(next);
            }}
          >
            <option value="">Ask every time</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name || "Profile"}
                {profile.passwordHash != null ? " (asks for password)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="settings-profile-list">
        {profiles.map((profile) => {
          const isCurrent = profile.id === activeProfile?.id;
          const photo = isImageAvatar(profile.avatar);
          return (
            <div className={`settings-profile-card${isCurrent ? " is-current" : ""}`} key={profile.id}>
              <div className="settings-profile-head">
                <span className="settings-profile-avatar" style={{ background: profile.color ?? DEFAULT_PROFILE_COLOR }}>
                  {photo ? <img src={profile.avatar} alt="" /> : profileGlyph(profile)}
                </span>
                <div className="settings-profile-identity">
                  <span className="settings-profile-name-line">
                    <strong>{profile.name || "Profile"}</strong>
                    {isCurrent && <span className="settings-profile-you">You</span>}
                    {profile.isAdmin && <span className="settings-profile-admin">Admin</span>}
                  </span>
                  <span className="settings-profile-sub t-secondary">
                    {profile.passwordHash ? "Password protected" : "No password"}
                  </span>
                </div>
                {canManage && !profile.isDefault && (
                  <button type="button" className="settings-profile-remove" onClick={() => void deleteProfile(profile)} title="Delete profile" aria-label={`Delete ${profile.name}`}>
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </div>

              {canManage && (
                <div className="settings-profile-edit">
                  <Field label="Name"><input value={profile.name} maxLength={40} onChange={(event) => editProfile(profile, { name: event.target.value })} /></Field>
                  <div className="settings-profile-look">
                    <span className="settings-label">Profile look</span>
                    <div className="settings-profile-avatar-tools">
                      <AvatarPicker
                        value={photo ? "" : (profile.avatar ?? "")}
                        onChange={(emoji) => editProfile(profile, { avatar: emoji })}
                        idPrefix={`profile-${profile.id}`}
                      />
                      <div className="settings-profile-photo-row">
                        <label className="btn settings-profile-photo">
                          <Icon name="upload" size={15} />
                          Choose photo
                          <input
                            type="file"
                            accept="image/*"
                            onChange={(event) => {
                              uploadProfilePhoto(profile, event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                        </label>
                        {photo && (
                          <button type="button" className="chip" onClick={() => editProfile(profile, { avatar: DEFAULT_PROFILE_AVATAR })}>
                            Use an icon
                          </button>
                        )}
                      </div>
                      <div className="settings-profile-palette" role="radiogroup" aria-label={`Color for ${profile.name}`}>
                        {PROFILE_COLORS.map((color) => {
                          const active = (profile.color ?? DEFAULT_PROFILE_COLOR).toLowerCase() === color.value;
                          return (
                            <button
                              key={color.value}
                              type="button"
                              className={active ? "is-active" : ""}
                              style={{ background: color.value }}
                              onClick={() => editProfile(profile, { color: color.value })}
                              role="radio"
                              aria-checked={active}
                              aria-label={color.label}
                              title={color.label}
                            />
                          );
                        })}
                        <label className="settings-profile-color" title="Custom profile color">
                          <input
                            type="color"
                            value={profile.color ?? DEFAULT_PROFILE_COLOR}
                            onChange={(event) => editProfile(profile, { color: event.target.value })}
                            aria-label={`Custom color for ${profile.name}`}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                  <div className="settings-profile-password">
                    <input type="password" value={passwords[profile.id] ?? ""} placeholder={profile.passwordHash ? "New password" : "Set a password"} onChange={(event) => setPasswords((previous) => ({ ...previous, [profile.id]: event.target.value }))} />
                    <button type="button" className="btn" onClick={() => void savePassword(profile)}>{profile.passwordHash ? "Change" : "Set"}</button>
                    {profile.passwordHash && <button type="button" className="btn settings-profile-clearpw" onClick={() => void updateProfileRecord(profile.id, { passwordHash: undefined }).then(() => refresh("Password cleared."))}>Clear</button>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="settings-profile-add">
          <input value={newName} maxLength={40} placeholder="New profile name" onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addProfile(); }} />
          <button type="button" className="btn btn-prominent" onClick={() => void addProfile()}>Add profile</button>
        </div>
      )}
      {message && <p className="settings-note" role="status">{message}</p>}
    </div>
  );
}

function profileGlyph(profile: LocalProfile): string {
  if (profile.avatar && !isImageAvatar(profile.avatar)) return profile.avatar;
  return profile.name.trim().charAt(0).toUpperCase() || "?";
}

function UpdatesTab({
  draft,
  patch,
  debrid,
  appVersion,
}: TabProps & { debrid: DebridManager | null; appVersion: string }) {
  const [smokeResults, setSmokeResults] = useState<ProviderSmokeResult[] | null>(null);
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const desktop = isTauri();

  async function runProviderChecks() {
    if (debrid == null || smokeRunning) return;
    setSmokeRunning(true);
    setSmokeResults(null);
    try {
      const results = await debrid.smokeTestProviders();
      setSmokeResults(results);
      for (const result of results) {
        const healthy = result.accountReachable && result.cacheReachable;
        recordDiagnostic(
          "provider",
          `smoke.${result.service}.${healthy ? "passed" : "failed"}`,
          healthy ? "info" : "error",
          `${result.durationMs}ms`,
        );
      }
    } finally {
      setSmokeRunning(false);
    }
  }

  function exportDiagnostics() {
    const report = buildDiagnosticsReport({
      appVersion,
      runtime: desktop ? "desktop" : "browser",
      platform: deviceKind(),
      serverMode: isServerMode(),
      settings: draft,
    });
    downloadDiagnosticsReport(report);
    setDiagnosticsStatus("Diagnostics saved. Credentials and private URLs were excluded.");
  }

  return (
    <div className="settings-fields">
      <SettingsInfo label="About desktop updates">
        Desktop builds use signed release metadata from GitHub Releases. Browser
        and PWA installs update through the web server instead.
      </SettingsInfo>

      <section className="settings-section">
        <h2>Credits</h2>
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
          <img
            src="/tmdb.svg"
            alt="The Movie Database (TMDB)"
            width="74"
            height="54"
          />
        </a>
        <p className="settings-hint">
          This product uses the TMDB API but is not endorsed or certified by
          TMDB.
        </p>
      </section>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.autoUpdateChecks}
          onChange={(event) =>
            patch({
              autoUpdateChecks: event.target.checked,
              autoInstallUpdates: event.target.checked
                ? draft.autoInstallUpdates
                : false,
            })
          }
        />
        <span>
          <strong>Check for desktop updates automatically</strong>
          <span className="t-secondary">
            Checks on launch and weekly, then shows a signed update prompt.
          </span>
        </span>
      </label>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.autoUpdateChecks && draft.autoInstallUpdates}
          disabled={!draft.autoUpdateChecks}
          onChange={(event) => patch({ autoInstallUpdates: event.target.checked })}
        />
        <span>
          <strong>Install signed desktop updates automatically</strong>
          <span className="t-secondary"> Downloads, applies, and relaunches the app.</span>
        </span>
      </label>

      <section className="settings-diagnostics" aria-labelledby="settings-diagnostics-title">
        <div>
          <h2 id="settings-diagnostics-title">Troubleshooting</h2>
          <p className="settings-hint">
            Run read-only checks for saved providers, then export a redacted
            support file with configuration state and recent player events.
          </p>
        </div>

        <div className="settings-provider-check">
          <button
            type="button"
            className="btn"
            onClick={() => void runProviderChecks()}
            disabled={!desktop || debrid == null || smokeRunning}
          >
            {smokeRunning ? "Checking providers…" : "Run provider smoke tests"}
          </button>
          <button type="button" className="btn" onClick={exportDiagnostics}>
            Export diagnostics
          </button>
          <a
            className="btn"
            href={BUG_REPORT_URL}
            target="_blank"
            rel="noreferrer"
          >
            Report a bug
          </a>
        </div>

        {!desktop && (
          <p className="settings-hint">
            Provider checks run in the desktop app because browsers block direct
            provider API requests.
          </p>
        )}
        {desktop && debrid == null && (
          <p className="settings-hint">Save a provider before running checks.</p>
        )}
        {smokeResults != null && (
          <ul className="settings-diagnostic-results" aria-label="Provider smoke test results">
            {smokeResults.map((result) => {
              const healthy = result.accountReachable && result.cacheReachable;
              return (
                <li key={result.service}>
                  <strong>{DebridServiceType.displayName(result.service)}</strong>
                  <span className={healthy ? "is-valid" : "is-error"}>
                    {healthy
                      ? `Account and cache checks passed in ${result.durationMs}ms`
                      : !result.accountReachable
                        ? "Account check failed"
                        : "Cache check failed"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="settings-status" aria-live="polite">
          {diagnosticsStatus ?? ""}
        </p>
      </section>
    </div>
  );
}

interface TabProps {
  draft: AppSettings;
  patch: (next: Partial<AppSettings>) => void;
}

function PrivacyTab({ draft, patch }: TabProps) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const serverImportInput = useRef<HTMLInputElement>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [serverImportMode, setServerImportMode] = useState<"merge" | "replace">(
    "merge",
  );
  const [migrationBackup, setMigrationBackup] =
    useState<PortableBackup | null>(null);
  const [migrationProfileId, setMigrationProfileId] = useState<string | null>(
    null,
  );
  const [pendingServerImport, setPendingServerImport] = useState<{
    bundle: PortableProfileBundle;
    label: string;
    skippedRows: number;
    omissions: string[];
  } | null>(null);
  const serverMode = isServerMode();
  const modes: Array<{
    value: AppSettings["networkMode"];
    label: string;
    description: string;
    info: string;
  }> = [
    {
      value: "standard",
      label: "Standard",
      description: "All app connections are available.",
      info: "Allows metadata, images, ratings, debrid, indexers, subtitles, updates, trailers, and external AI.",
    },
    {
      value: "fullLocal",
      label: "Full Local",
      description: "Keep the media essentials, turn off extras.",
      info: "Allows only TMDB, ratings, debrid, indexers, and subtitles, plus local AI and your server. It blocks app updates, external AI, trailers, telemetry, and other external connections.",
    },
    {
      value: "offline",
      label: "Offline",
      description: "Use cached titles and downloaded files.",
      info: "Nothing leaves this device. Browse cached titles and play downloads. Local AI and your own local server remain available.",
    },
  ];

  const downloadJSON = useCallback(
    (value: unknown, filename: string) => {
      const blob = new Blob([JSON.stringify(value, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    },
    [],
  );

  const downloadBackup = useCallback(
    (backup: PortableBackup, kind: "backup" | "pre-restore") => {
      downloadJSON(backup, portableBackupFilename(kind));
    },
    [downloadJSON],
  );

  const exportLocalData = useCallback(async () => {
    setBackupStatus("Preparing local backup…");
    try {
      const backup = await exportPortableBackup();
      downloadBackup(backup, "backup");
      setBackupStatus(
        `Backup downloaded for ${backup.profiles.length} local profile(s). ` +
          "Credentials, profile locks, stream URLs, and device paths were excluded.",
      );
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : String(error));
    }
  }, [downloadBackup]);

  const restoreLocalData = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file == null) return;
      setBackupStatus("Verifying backup…");
      try {
        const backup = parsePortableBackup(await file.text());
        const result = await restorePortableBackup(backup);
        downloadBackup(result.preRestoreBackup, "pre-restore");
        setBackupStatus(
          `Restored ${result.restoredRows} record(s) across ` +
            `${result.restoredProfiles} profile(s). ` +
            (result.unlockedProfiles > 0
              ? `${result.unlockedProfiles} new profile(s) were restored without a lock. `
              : "") +
            "Reloading with the restored data…",
        );
        window.setTimeout(() => window.location.reload(), 250);
      } catch (error) {
        setBackupStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [downloadBackup],
  );

  const exportServerData = useCallback(async () => {
    setBackupStatus("Preparing server profile export…");
    try {
      const bundle = await exportServerPortableProfile();
      const stamp = bundle.createdAt.replaceAll(":", "-").replaceAll(".", "-");
      downloadJSON(bundle, `yawf-stream-server-profile-${stamp}.json`);
      setBackupStatus(
        `Exported ${bundle.watchlist.length} watchlist item(s), ` +
          `${bundle.history.length} history entry or entries, and ` +
          `${bundle.library.length} library item(s). Credentials, profile locks, ` +
          "stream URLs, and server paths were excluded.",
      );
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : String(error));
    }
  }, [downloadJSON]);

  const selectMigrationProfile = useCallback(
    (backup: PortableBackup, profileId: string) => {
      const conversion = portableProfileBundleFromBackup(backup, profileId);
      setMigrationProfileId(profileId);
      setPendingServerImport({
        bundle: conversion.bundle,
        label: conversion.profileName,
        skippedRows: conversion.skippedRows,
        omissions: conversion.omissions,
      });
      setBackupStatus(
        `Ready to import local profile "${conversion.profileName}". Review the ` +
          "mode below before continuing.",
      );
    },
    [],
  );

  const prepareServerImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file == null) return;
      setBackupStatus("Verifying profile data…");
      setPendingServerImport(null);
      setMigrationBackup(null);
      setMigrationProfileId(null);
      try {
        const text = await file.text();
        let header: { format?: unknown };
        try {
          header = JSON.parse(text) as { format?: unknown };
        } catch {
          throw new Error("Import file is not valid JSON.");
        }
        if (header.format === "yawf-profile-portable") {
          const bundle = parsePortableProfileBundle(text);
          setPendingServerImport({
            bundle,
            label: "portable server profile",
            skippedRows: 0,
            omissions: [],
          });
          setBackupStatus(
            "Portable server profile verified. Review the import mode below.",
          );
          return;
        }
        if (header.format === "yawf-local-backup") {
          const backup = parsePortableBackup(text);
          setMigrationBackup(backup);
          selectMigrationProfile(backup, backup.activeProfileId);
          return;
        }
        throw new Error(
          "Choose a YAWF Stream local backup or portable server profile.",
        );
      } catch (error) {
        setBackupStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [selectMigrationProfile],
  );

  const importServerData = useCallback(async () => {
    if (pendingServerImport == null) return;
    if (
      serverImportMode === "replace" &&
      !window.confirm(
        "Replace this server profile's portable settings, watchlist, history, folders, and library? Credentials and account security stay unchanged, but portable profile data not present in this file will be deleted.",
      )
    ) {
      return;
    }
    setBackupStatus(
      `${serverImportMode === "replace" ? "Replacing" : "Merging"} profile data…`,
    );
    try {
      const counts = await importServerPortableProfile(
        pendingServerImport.bundle,
        serverImportMode,
      );
      const imported =
        counts.settings +
        counts.watchlist +
        counts.history +
        counts.folders +
        counts.library;
      const skipped =
        pendingServerImport.skippedRows > 0
          ? ` ${pendingServerImport.skippedRows} invalid local row(s) were skipped.`
          : "";
      const omissions =
        pendingServerImport.omissions.length > 0
          ? ` ${pendingServerImport.omissions.join(" ")}`
          : "";
      setBackupStatus(
        `Imported ${imported} record(s) into this server profile.${skipped}${omissions} Reloading…`,
      );
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : String(error));
    }
  }, [pendingServerImport, serverImportMode]);

  return (
    <div className="settings-fields">
      <SettingsInfo label="Privacy mode">
        Choose how this profile connects to services. The setting applies immediately when you save it.
      </SettingsInfo>
      <div className="settings-option-strip" role="radiogroup" aria-label="Privacy mode">
        {modes.map((mode) => (
          <div className="settings-field" key={mode.value}>
            <button
              type="button"
              role="radio"
              aria-checked={draft.networkMode === mode.value}
              className={`settings-option-card${draft.networkMode === mode.value ? " is-active" : ""}`}
              onClick={() => patch({ networkMode: mode.value })}
            >
              <span>{mode.label}</span>
              <small>{mode.description}</small>
            </button>
            <InfoTip label={`About ${mode.label}`}>{mode.info}</InfoTip>
          </div>
        ))}
      </div>
      <section className="settings-section">
        <SettingsInfo
          label={serverMode ? "Profile portability" : "Local backup and restore"}
        >
          {serverMode
            ? "Move the current profile between YAWF Stream servers, or import one profile from a Local Mode backup. Credentials, account security, profile locks, stream URLs, and server paths are never included."
            : "Export every local profile's settings, watchlist, history, library, taste data, and media cache. Credentials, profile password hashes, temporary stream URLs, and device-specific download paths are never included. Existing profile locks remain in place during restore. New profiles are restored unlocked so you can set a new local password."}
        </SettingsInfo>
        {serverMode ? (
          <>
            <div className="settings-action-row">
              <button
                type="button"
                className="btn"
                onClick={() => void exportServerData()}
              >
                Export current profile
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => serverImportInput.current?.click()}
              >
                Choose profile data
              </button>
              <input
                ref={serverImportInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void prepareServerImport(event)}
              />
            </div>
            {migrationBackup != null && migrationBackup.profiles.length > 1 && (
              <label className="settings-field">
                <span>Local profile to migrate</span>
                <select
                  value={migrationProfileId ?? ""}
                  onChange={(event) =>
                    selectMigrationProfile(
                      migrationBackup,
                      event.currentTarget.value,
                    )
                  }
                >
                  {migrationBackup.profiles.map(({ profile }) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {pendingServerImport != null && (
              <div className="settings-fields">
                <div
                  className="settings-option-strip"
                  role="radiogroup"
                  aria-label="Profile import mode"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={serverImportMode === "merge"}
                    className={`settings-option-card${serverImportMode === "merge" ? " is-active" : ""}`}
                    onClick={() => setServerImportMode("merge")}
                  >
                    <span>Merge</span>
                    <small>
                      Add new data and keep the newer history entry when both
                      profiles contain the same title.
                    </small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={serverImportMode === "replace"}
                    className={`settings-option-card${serverImportMode === "replace" ? " is-active" : ""}`}
                    onClick={() => setServerImportMode("replace")}
                  >
                    <span>Replace portable data</span>
                    <small>
                      Clear this profile's portable data first. Credentials and
                      account security remain unchanged.
                    </small>
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void importServerData()}
                >
                  Import {pendingServerImport.label}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="settings-action-row">
            <button
              type="button"
              className="btn"
              onClick={() => void exportLocalData()}
            >
              Export local backup
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => restoreInput.current?.click()}
            >
              Restore local backup
            </button>
            <input
              ref={restoreInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void restoreLocalData(event)}
            />
          </div>
        )}
        <p className="settings-status" aria-live="polite">
          {backupStatus ?? ""}
        </p>
      </section>
    </div>
  );
}

function SettingsInfo({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-info-row">
      <span className="settings-label">{label}</span>
      <InfoTip label={label}>{children}</InfoTip>
    </div>
  );
}

const STREAM_QUALITY_OPTIONS: { value: StreamMaxQuality; label: string }[] = [
  { value: "any", label: "Any quality" },
  { value: "4K", label: "Up to 4K" },
  { value: "1080p", label: "Up to 1080p" },
  { value: "720p", label: "Up to 720p" },
  { value: "480p", label: "Up to 480p" },
  { value: "SD", label: "SD only" },
];

const STREAM_SIZE_CAP_OPTIONS = [
  { value: 0, label: "No cap" },
  { value: 2, label: "Up to 2 GB" },
  { value: 5, label: "Up to 5 GB" },
  { value: 10, label: "Up to 10 GB" },
  { value: 20, label: "Up to 20 GB" },
  { value: 50, label: "Up to 50 GB" },
] as const;

const CUSTOM_STREAM_SIZE_CAP = "custom";

function LanguageRegionTab({ draft, patch }: TabProps) {
  return (
    <div className="settings-form">
      <div className="settings-section-heading">
        <div>
          <span className="settings-kicker">Language</span>
          <h2>Language and region</h2>
        </div>
      </div>

      <div className="settings-control-grid">
        <Field
          label="Interface language"
          hint="Core navigation and TV controls are translated now. Untranslated screens fall back to English instead of showing missing text."
        >
          <select
            aria-label="Interface language"
            value={draft.interfaceLanguage}
            onChange={(event) =>
              patch({ interfaceLanguage: event.target.value })
            }
          >
            {INTERFACE_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Metadata language"
          hint="TMDB titles, summaries, genres, episodes, and trailers use this language when available."
        >
          <select
            aria-label="Metadata language"
            value={draft.metadataLanguage}
            onChange={(event) =>
              patch({ metadataLanguage: event.target.value })
            }
          >
            {METADATA_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Metadata region"
          hint="Used for regional release windows and ratings. Kid maturity limits keep their documented US safety ladder."
        >
          <select
            aria-label="Metadata region"
            value={draft.metadataRegion}
            onChange={(event) => patch({ metadataRegion: event.target.value })}
          >
            {METADATA_REGION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="settings-hint t-secondary">
        These settings are stored per profile and follow that profile in Server
        Mode. Save to rebuild the catalog client with the new locale.
      </p>
    </div>
  );
}

function PlaybackTab({ draft, patch }: TabProps) {
  // Populate the external-player picker with the players actually installed
  // (detected natively; empty in a plain browser, so the picker hides there).
  const [players, setPlayers] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void listExternalPlayers().then((p) => {
      if (alive) setPlayers(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const sizeCapOption =
    STREAM_SIZE_CAP_OPTIONS.find((option) => option.value === draft.streamMaxSizeGB) ??
    null;
  const sizeCapValue =
    sizeCapOption == null ? CUSTOM_STREAM_SIZE_CAP : String(sizeCapOption.value);
  // The server-transcode option is only meaningful in Server Mode AND only when
  // the operator enabled it (+ ffmpeg present), advertised via bootstrap.
  const canTranscode = isServerMode() && useTranscodeAvailable();

  return (
    <div className="settings-fields">
      <SettingsInfo label="About playback filters">
        These profile controls hide stream results that are likely to use more
        bandwidth. <strong>Data Saver</strong> adds a ≤720p / ≤5&nbsp;GB ceiling on
        top and also governs automatic (watchlist) playback. Server Mode applies
        them before sending stream rows to this device.
      </SettingsInfo>

      {isTauri() && (
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={draft.builtInPlayer}
            onChange={(event) => patch({ builtInPlayer: event.target.checked })}
          />
          <span>
            <strong>Built-in player</strong>
            <InfoTip label="About the built-in player">
              Play MKV and HEVC right inside the window with native libmpv. Turn
              it off to open your chosen external player instead. It works on
              released macOS and Linux builds. Windows remains held until its
              signing gate passes.
            </InfoTip>
          </span>
        </label>
      )}

      {players.length > 0 && (
        <label className="settings-field">
          <span className="settings-field-label">
            <strong>External player</strong>
            <span className="t-secondary">
              {" "}
              - which app opens MKV / 4K&nbsp;HEVC streams when the built-in
              player is off (or as a fallback). Detected on this machine.
            </span>
          </span>
          <select
            aria-label="External player"
            value={draft.preferredExternalPlayer}
            onChange={(event) =>
              patch({ preferredExternalPlayer: event.target.value })
            }
          >
            <option value="">Automatic (best available)</option>
            {players.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}

      <DownloadsFolderSetting />

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.dataSaver}
          onChange={(event) => patch({ dataSaver: event.target.checked })}
        />
          <span>
            <strong>Data Saver</strong>
            <InfoTip label="About Data Saver">
              Prefer smaller, lower-resolution streams up to 720p and 5 GB to use
              less bandwidth, including instant and watchlist playback. It does
              not re-encode video.
            </InfoTip>
          </span>
      </label>

      {canTranscode && (
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={draft.transcode}
            onChange={(event) => patch({ transcode: event.target.checked })}
          />
          <span>
            <strong>Reduce playback bitrate (server transcode)</strong>
            <InfoTip label="About server transcode">
              The server re-encodes playback to a 720p stream to use less
              bandwidth and more server CPU. It complements Data Saver, which
              only caps the source file selected.
            </InfoTip>
          </span>
        </label>
      )}

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.streamCachedOnly}
          onChange={(event) => patch({ streamCachedOnly: event.target.checked })}
        />
          <span>
            <strong>Show cached streams only</strong>
            <InfoTip label="About cached streams only">
              Avoid streams that need to be cached before playback.
            </InfoTip>
          </span>
      </label>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.autoAdvanceEpisodes}
          onChange={(event) => patch({ autoAdvanceEpisodes: event.target.checked })}
        />
          <span>
            <strong>Auto-play next episode</strong>
            <InfoTip label="About auto-play next episode">
              When a series episode ends, play the next one automatically if an
              instant cached stream is available. Otherwise, return to the stream
              list.
            </InfoTip>
          </span>
      </label>

      <div className="settings-control-grid">
        <Field
          label="Default audio language"
          hint="Used when a stream offers a matching audio track. Original keeps the stream's choice."
        >
          <select
            aria-label="Default audio language"
            value={draft.defaultAudioLanguage ?? ""}
            onChange={(event) => patch({ defaultAudioLanguage: event.target.value })}
          >
            <option value="">Original / stream default</option>
            {PLAYBACK_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Default playback speed"
          hint="Used when this title has no remembered playback speed."
        >
          <select
            aria-label="Default playback speed"
            value={draft.defaultPlaybackSpeed ?? 1}
            onChange={(event) => patch({ defaultPlaybackSpeed: Number(event.target.value) })}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed === 1 ? "Normal (1x)" : `${speed}x`}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Default volume"
          hint="Initial volume for a newly opened player."
        >
          <input
            aria-label="Default volume"
            type="range"
            min={0}
            max={100}
            step={1}
            value={draft.defaultVolume ?? 100}
            onChange={(event) => patch({ defaultVolume: Number(event.target.value) })}
          />
          <output>{draft.defaultVolume ?? 100}%</output>
        </Field>

        <Field
          label="Default subtitles"
          hint="Choose whether to automatically enable a matching subtitle track."
        >
          <select
            aria-label="Default subtitles"
            value={draft.defaultSubtitleBehavior ?? "off"}
            onChange={(event) =>
              patch({ defaultSubtitleBehavior: event.target.value as DefaultSubtitleBehavior })
            }
          >
            <option value="off">Keep subtitles off</option>
            <option value="preferred">Use preferred language</option>
          </select>
        </Field>

        <Field
          label="Preferred subtitle language"
          hint="Applied only when Default subtitles is set to use a preferred language."
        >
          <select
            aria-label="Preferred subtitle language"
            value={draft.defaultSubtitleLanguage ?? ""}
            disabled={(draft.defaultSubtitleBehavior ?? "off") !== "preferred"}
            onChange={(event) => patch({ defaultSubtitleLanguage: event.target.value })}
          >
            <option value="">No language selected</option>
            {PLAYBACK_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.rememberPerTitleTrackChoices ?? true}
          onChange={(event) =>
            patch({ rememberPerTitleTrackChoices: event.target.checked })
          }
        />
        <span>
          <strong>Remember audio and subtitle choices per title</strong>
          <InfoTip label="About remembered track choices">
            When enabled, a title's track choice takes priority over these
            defaults the next time you play it.
          </InfoTip>
        </span>
      </label>

      <div className="settings-control-grid">
        <SegmentedControl
          label="Rating scale"
          value={draft.ratingScale}
          options={[
            { value: "ten", label: "1–10" },
            { value: "hundred", label: "0–100" },
            { value: "thumbs", label: "Thumbs" },
          ]}
          onChange={(value) => patch({ ratingScale: value as RatingScale })}
        />
      </div>

      {/* Quality + size caps are power-user filters - hidden in Simple mode,
          which keeps "cached only" as the one safe, essential toggle. */}
      <AdvancedOnly>
        <Field
          label="Maximum quality"
          hint="Higher-quality torrents are hidden from stream results."
        >
          <select
            aria-label="Maximum quality"
            value={draft.streamMaxQuality}
            onChange={(event) =>
              patch({ streamMaxQuality: event.target.value as StreamMaxQuality })
            }
          >
            {STREAM_QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </AdvancedOnly>

      <AdvancedOnly>
      <Field
        label="Maximum file size"
        hint="Common caps are listed first. Custom still filters torrent result size, not transcoded playback bitrate."
      >
        <div className="settings-size-cap">
          <select
            aria-label="Maximum file size"
            value={sizeCapValue}
            onChange={(event) => {
              if (event.target.value === CUSTOM_STREAM_SIZE_CAP) {
                patch({
                  streamMaxSizeGB:
                    sizeCapOption == null && draft.streamMaxSizeGB > 0
                      ? draft.streamMaxSizeGB
                      : 25,
                });
                return;
              }
              patch({ streamMaxSizeGB: Number(event.target.value) });
            }}
          >
            {STREAM_SIZE_CAP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_STREAM_SIZE_CAP}>Custom</option>
          </select>
          {sizeCapOption == null && (
            <input
              type="number"
              min={0}
              max={500}
              step={0.5}
              value={draft.streamMaxSizeGB}
              onChange={(event) =>
                patch({ streamMaxSizeGB: Number(event.target.value) || 0 })
              }
              aria-label="Custom maximum file size in GB"
            />
          )}
        </div>
      </Field>
      </AdvancedOnly>
    </div>
  );
}

/** Native downloads intentionally keep their folder independent from the
 * settings draft: changing it should not rebuild every streaming service. */
function DownloadsFolderSetting() {
  const tauri = isTauri();
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tauri) return;
    let alive = true;
    void downloadsDirectory(getStore(), getDownloadsBridge())
      .then((path) => {
        if (alive) setFolder(path);
      })
      .catch(() => {
        if (alive) setError("Could not read the desktop downloads folder.");
      });
    return () => {
      alive = false;
    };
  }, [tauri]);

  if (!tauri) return null;
  return (
    <label className="settings-field">
      <span className="settings-field-label">
        <strong>Downloads folder</strong>
        <span className="t-secondary">
          Full-size and optimized downloads are organized here on this desktop.
        </span>
      </span>
      <input
        type="text"
        value={folder}
        placeholder="Loading default folder…"
        onChange={(event) => {
          setFolder(event.target.value);
          setError(null);
        }}
        onBlur={() => {
          const next = folder.trim();
          if (next.length === 0) {
            setError("Enter a folder path for downloads.");
            return;
          }
          void getStore()
            .setSetting(DOWNLOADS_DIRECTORY_SETTING, next)
            .catch(() => setError("Could not save the downloads folder."));
        }}
        aria-label="Downloads folder"
      />
      {error != null && <span className="settings-field-hint dl-error">{error}</span>}
    </label>
  );
}

function InstallTab() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [installed, setInstalled] = useState(() => isStandaloneDisplay());
  const [installPath, setInstallPath] = useState<InstallPath>("device");
  const kind = deviceKind();

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function promptInstall() {
    if (promptEvent == null) return;
    await promptEvent.prompt();
    await promptEvent.userChoice.catch(() => null);
    setPromptEvent(null);
    setInstalled(isStandaloneDisplay());
  }

  const primary =
    kind === "ios"
      ? {
          title: "Install on iPhone or iPad",
          body: "Open this server URL in Safari, use Share, then Add to Home Screen.",
        }
      : kind === "android"
        ? {
            title: "Install on Android",
            body: "Use the browser install prompt when available, or Install app from Chrome or Edge.",
          }
        : kind === "mac"
          ? {
              title: "Mac setup",
              body: "Use the desktop app for native playback and signed updates, or keep this server URL pinned in your browser.",
            }
          : {
              title: "Install this server",
              body: "Use your browser's install app action to add this self-hosted server to your launcher.",
            };
  const installPathOptions: Array<{
    id: InstallPath;
    label: string;
    summary: string;
  }> = [
    {
      id: "device",
      label: installed ? "Installed app" : primary.title,
      summary: installed
        ? "This device already has launcher access."
        : "Set up launcher access or desktop hosting on this device.",
    },
    {
      id: "connect",
      label: "Connect to server",
      summary: "Use a hosted YAWF Stream URL for shared profiles and keys.",
    },
    {
      id: "downloads",
      label: "Desktop downloads",
      summary: "Get released macOS and Linux builds. Windows is still held.",
    },
    {
      id: "deploy",
      label: "Server setup",
      summary: "Deploy Docker Compose on a NAS, VPS, or home server.",
    },
  ];

  return (
    <div className="settings-fields">
      <p className="settings-hint t-secondary">
        Set up this device for native playback, launcher access, and self-hosted
        streaming. The options below adjust to the browser or desktop app you are
        using now.
      </p>

      <div className="settings-install-picker">
        <label className="settings-label" htmlFor="settings-install-path">
          Setup path
        </label>
        <select
          id="settings-install-path"
          value={installPath}
          onChange={(event) => setInstallPath(event.target.value as InstallPath)}
        >
          {installPathOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-install-choices" aria-label="Setup path">
        {installPathOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={installPath === option.id}
            className={`settings-install-choice${installPath === option.id ? " is-active" : ""}`}
            onClick={() => setInstallPath(option.id)}
          >
            <span>{option.label}</span>
            <small>{option.summary}</small>
          </button>
        ))}
      </div>

      <div className="settings-install-detail">
        {installPath === "device" && (
          <>
            <div className="settings-install-card glass-rest">
              <div>
                <h3>{installed ? "Installed" : primary.title}</h3>
                <p className="t-secondary">
                  {installed
                    ? "This server is already running as an installed app."
                    : primary.body}
                </p>
              </div>
              {promptEvent != null && !installed && (
                <button type="button" className="btn" onClick={() => void promptInstall()}>
                  Install app
                </button>
              )}
            </div>
            <DesktopHostPanel />
          </>
        )}

        {installPath === "connect" && <ServerConnectionPanel />}

        {installPath === "downloads" && (
          <div className="settings-install-grid">
            <a
              className="settings-install-card glass-rest"
              href="https://github.com/Tgk-30/YAWF-Stream/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              <strong>Desktop downloads</strong>
              <span className="t-secondary">
                Released macOS and Linux assets with signed update support.
                Windows remains held until Authenticode verification passes.
              </span>
            </a>
          </div>
        )}

        {installPath === "deploy" && (
          <div className="settings-install-grid">
            <a
              className="settings-install-card glass-rest"
              href="https://github.com/Tgk-30/YAWF-Stream/tree/main/deploy/compose"
              target="_blank"
              rel="noreferrer"
            >
              <strong>Server setup</strong>
              <span className="t-secondary">
                Docker Compose files for NAS, VPS, Raspberry Pi, and home servers.
              </span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function DesktopHostPanel() {
  const [status, setStatus] = useState<DesktopServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [qrDataURL, setQrDataURL] = useState<string | null>(null);
  const desktop = isTauri();
  const shareURL =
    status?.share_url ?? status?.lan_urls[0] ?? status?.url ?? status?.urls[0] ?? null;
  const setupURL = status?.setup_url ?? null;
  const primaryURL = setupURL ?? shareURL;

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktopServerStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    let cancelled = false;
    if (!desktop || primaryURL == null) {
      setQrDataURL(null);
      return;
    }
    void QRCode.toDataURL(primaryURL, {
      width: 180,
      margin: 1,
      color: {
        dark: "#111827",
        light: "#ffffff",
      },
    })
      .then((dataURL) => {
        if (!cancelled) setQrDataURL(dataURL);
      })
      .catch(() => {
        if (!cancelled) setQrDataURL(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, primaryURL]);

  if (!desktop) return null;

  async function start() {
    setBusy(true);
    setError(null);
    setShareMessage(null);
    try {
      const next = await startDesktopServer();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    setShareMessage(null);
    try {
      const next = await stopDesktopServer();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openServer() {
    if (primaryURL == null) return;
    await openExternalURL(primaryURL);
  }

  async function copyShareURL(url: string) {
    setError(null);
    setShareMessage(null);
    try {
      await navigator.clipboard.writeText(url);
      setShareMessage("Copied.");
    } catch {
      setError("Clipboard is unavailable in this session.");
    }
  }

  async function shareHostedApp() {
    if (primaryURL == null) return;
    setError(null);
    setShareMessage(null);
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
    };
    if (nav.share == null) {
      await copyShareURL(primaryURL);
      return;
    }
    try {
      await nav.share({
        title: "YAWF Stream",
        text: "Open this YAWF Stream server.",
        url: primaryURL,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Share failed.");
    }
  }

  return (
    <div className="settings-source glass-rest settings-server-connect">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Host from this desktop</span>
        {status?.running && <span className="chip is-active">Running</span>}
      </div>
      <p className="settings-hint t-secondary">
        Start Server Mode on this computer, then open the hosted app URL for
        profiles, shared credentials, and phone/tablet home-screen installs.
      </p>
      <div className="settings-source-row">
        <button
          type="button"
          className="btn"
          onClick={() => void start()}
          disabled={busy || status?.running === true}
        >
          {busy && status?.running !== true ? "Starting" : "Start hosting"}
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => void stop()}
          disabled={busy || status?.running !== true}
        >
          Stop
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => void openServer()}
          disabled={primaryURL == null}
        >
          Open hosted app
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => void shareHostedApp()}
          disabled={primaryURL == null}
        >
          Share
        </button>
      </div>
      {primaryURL != null && (
        <div className="settings-share-box">
          {qrDataURL != null && (
            <img
              className="settings-share-qr"
              src={qrDataURL}
              alt="QR code for the hosted YAWF Stream server"
            />
          )}
          <div className="settings-share-copy">
            <span className="settings-label">
              {setupURL != null ? "One-time owner setup URL" : "Best setup URL"}
            </span>
            <code>{primaryURL}</code>
            {setupURL != null && (
              <span className="settings-hint t-secondary">
                Use this first-run link to create the owner account. Normal
                sharing links are listed below.
              </span>
            )}
            <div className="settings-source-row">
              <button
                type="button"
                className="chip"
                onClick={() => void copyShareURL(primaryURL)}
              >
                Copy
              </button>
              {status?.url != null && status.url !== shareURL && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => void copyShareURL(status.url!)}
                >
                  Copy local
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {status?.running === true && status.urls.length > 1 && (
        <div className="settings-url-list">
          {status.urls.map((url) => (
            <button
              type="button"
              key={url}
              className="chip"
              onClick={() => void copyShareURL(url)}
            >
              {url}
            </button>
          ))}
        </div>
      )}
      {status != null && (
        <p className="settings-hint t-secondary">{status.detail}</p>
      )}
      {status?.running === true && status.lan_urls.length === 0 && status.share_url == null && (
        <p className="settings-hint t-secondary">
          I could not detect a LAN address. Set
          <code> DEBRIDSTREAMER_DESKTOP_SHARE_URL</code> when launching the app
          to show a Tailscale or tunnel URL here.
        </p>
      )}
      {shareMessage && <p className="settings-status">{shareMessage}</p>}
      {status?.available === false && (
        <p className="settings-hint t-secondary">
          Release builds include this server bundle during CI. Development builds
          need <code> cd server && npm run build</code> first.
        </p>
      )}
      {error && <p className="settings-status is-error">{error}</p>}
    </div>
  );
}

function ServerConnectionPanel() {
  const activeURL = configuredServerURL();
  const source = configuredServerURLSource();
  const [input, setInput] = useState(activeURL ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const nextURL = inferServerURL(input);
      const response = await fetch(`${nextURL}/api/health`, {
        method: "GET",
        credentials: "include",
      });
      const text = await response.text();
      const parsed =
        text.length > 0 ? (JSON.parse(text) as Partial<HealthResponse>) : {};
      if (!response.ok || parsed.ok !== true) {
        throw new Error(`Server check failed (${response.status}).`);
      }
      saveServerURL(nextURL);
      setStatus(
        parsed.setupRequired
          ? "Connected. Owner setup will open next."
          : "Connected. Sign in will open next.",
      );
      window.setTimeout(() => window.location.reload(), 350);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    saveServerURL(null);
    window.location.reload();
  }

  const envLocked = source === "env" || source === "same-origin";

  return (
    <div className="settings-source glass-rest settings-server-connect">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Connect to a server</span>
        {activeURL != null && <span className="chip is-active">Server Mode</span>}
      </div>
      <p className="settings-hint t-secondary">
        Paste a YAWF Stream server URL to use shared profiles, shared API
        keys, and server-side stream forwarding across devices.
      </p>
      <div className="settings-source-row">
        <input
          className="settings-server-url-input"
          type="url"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="https://stream.example.com"
          disabled={envLocked}
        />
        <button
          type="button"
          className="btn"
          onClick={() => void connect()}
          disabled={busy || envLocked}
        >
          {busy ? "Checking" : activeURL == null ? "Connect" : "Reconnect"}
        </button>
        {activeURL != null && (
          <button
            type="button"
            className="chip"
            onClick={disconnect}
            disabled={envLocked}
            title={
              envLocked
                ? "This server URL was set by the app build configuration."
                : "Return this device to Local Mode."
            }
          >
            Use Local Mode
          </button>
        )}
      </div>
      <p className="settings-hint t-secondary">
        Example: <code>http://192.168.1.5:43110</code>
      </p>
      {envLocked && (
        <p className="settings-hint t-secondary">
          {source === "same-origin" ? (
            "This app was opened directly from the server, so it uses the same-origin API."
          ) : (
            <>
              This build is pinned to a server URL by
              <code> VITE_DEBRIDSTREAMER_SERVER_URL</code>.
            </>
          )}
        </p>
      )}
      <p className="settings-hint t-secondary">
        Opening the server URL directly is the simplest setup. Separate desktop
        builds may need that server to allow this app as a trusted origin.
      </p>
      {status && <p className="settings-status">{status}</p>}
      {error && <p className="settings-status is-error">{error}</p>}
    </div>
  );
}

// Guided setup for exposing a self-hosted server off the local network. Desktop
// builds detect the local clients, then guide the matching track. This detects
// and guides only: account login (`cloudflared tunnel login`, `tailscale up`)
// remains an intentional interactive/browser-auth flow. The persona +
// server-setup wizards point here ("Settings → Server → Remote access").

interface RemoteAccessStep {
  title: string;
  detail: string;
  command?: string;
}

const TAILSCALE_INSTALL_URL = "https://tailscale.com/kb/1017/install";
const CLOUDFLARED_INSTALL_URL =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/";

function recommendedTunnelTrack(tools: TunnelTools): "tailscale" | "cloudflare" {
  const tailscaleReady =
    tools.tailscale.installed && tools.tailscale.detail === "connected";
  const cloudflareReady = tools.cloudflared.installed;
  if (tailscaleReady !== cloudflareReady) {
    return tailscaleReady ? "tailscale" : "cloudflare";
  }
  if (tools.tailscale.installed !== tools.cloudflared.installed) {
    return tools.tailscale.installed ? "tailscale" : "cloudflare";
  }
  return "tailscale";
}

function remoteAccessSteps(
  track: "tailscale" | "cloudflare",
  installed: boolean,
  localTarget: string,
  hasKnownLocalTarget: boolean,
): RemoteAccessStep[] {
  const targetNote = hasKnownLocalTarget
    ? `The desktop host currently reports ${localTarget}.`
    : `Replace ${localTarget} with the desktop host's actual local bind URL after it starts.`;

  if (track === "tailscale") {
    return [
      ...(installed
        ? []
        : [
            {
              title: "Install Tailscale on the server",
              detail:
                "Install it on the machine running YAWF Stream, then return here to re-check it.",
            },
          ]),
      {
        title: "Sign in and join your tailnet",
        detail:
          "Run this on the server and finish the browser-auth flow. Tailscale then gives it a tailnet IP and optional MagicDNS name.",
        command: "tailscale up",
      },
      {
        title: "Install Tailscale on your devices",
        detail:
          "Add the same Tailscale account on each phone, tablet, or laptop. They can reach the server over your encrypted tailnet.",
      },
      {
        title: "Open the server through Tailscale",
        detail: `${targetNote} Keep that port and use the server's tailnet IP or MagicDNS name from your other devices.`,
      },
      {
        title: "Use the URL here",
        detail:
          "Paste the tailnet URL into Connect to a server above (or set DEBRIDSTREAMER_DESKTOP_SHARE_URL when launching the desktop host).",
      },
    ];
  }

  return [
    ...(installed
      ? []
      : [
          {
            title: "Install cloudflared on the server",
            detail:
              "Install it on the machine running YAWF Stream, then return here to re-check it.",
          },
        ]),
    {
      title: "Create and authenticate a Cloudflare Tunnel",
      detail:
        "In the Cloudflare Zero Trust dashboard, create a tunnel. Login and token setup are interactive browser-auth flows.",
      command: "cloudflared tunnel login",
    },
    {
      title: "Route a hostname to the server",
      detail: `Add a public hostname (for example stream.yourdomain.com) and route the tunnel to ${localTarget}. ${targetNote}`,
    },
    {
      title: "Run the connector",
      detail:
        "Start cloudflared with your tunnel token. Cloudflare serves your hostname over HTTPS and forwards traffic through the tunnel.",
    },
    {
      title: "Use the URL here",
      detail:
        "Paste https://stream.yourdomain.com into Connect to a server above (or set DEBRIDSTREAMER_DESKTOP_SHARE_URL for the desktop host).",
    },
  ];
}

function RemoteAccessPanel() {
  const [track, setTrack] = useState<"tailscale" | "cloudflare">("tailscale");
  const [tools, setTools] = useState<TunnelTools | null>(null);
  const [checking, setChecking] = useState(false);
  const [hostStatus, setHostStatus] = useState<DesktopServerStatus | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const manualTrack = useRef(false);
  const desktop = isTauri();
  const localTarget = hostStatus?.url ?? "http://localhost:<server-port>";
  const configuredRemoteBase = configuredServerURL();
  const remoteBase =
    configuredRemoteBase != null && configuredRemoteBase.length > 0
      ? configuredRemoteBase
      : hostStatus?.share_url ?? hostStatus?.url ?? window.location.origin;
  const normalizedRemoteBase = remoteBase.replace(/\/+$/, "");
  const tvURL = `${normalizedRemoteBase}/tv`;
  const phoneRemoteURL = `${normalizedRemoteBase}/remote`;
  const steps = remoteAccessSteps(
    track,
    track === "tailscale" ? tools?.tailscale.installed === true : tools?.cloudflared.installed === true,
    localTarget,
    hostStatus?.url != null,
  );
  const guideURL =
    track === "tailscale"
      ? "https://tailscale.com/kb/1223/funnel"
      : "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/";

  const checkTools = useCallback(async () => {
    if (!desktop) return;
    setChecking(true);
    const next = await detectTunnelTools();
    setTools(next);
    if (!manualTrack.current) setTrack(recommendedTunnelTrack(next));
    setChecking(false);
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktopServerStatus()
      .then((next) => {
        if (!cancelled) setHostStatus(next);
      })
      .catch(() => {
        // The explicit local-target placeholder makes this failure actionable.
      });
    void checkTools();
    return () => {
      cancelled = true;
    };
  }, [checkTools, desktop]);

  const copyRemoteURL = useCallback(async (label: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus("Clipboard unavailable. Select the URL and copy it manually.");
    }
  }, []);

  return (
    <div className="settings-source glass-rest settings-remote-access">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Remote access</span>
        <span className="chip">Tunnel</span>
      </div>
      <p className="settings-hint t-secondary">
        Expose this self-hosted server to phones and tablets off your network
        with a tunnel - no router ports to open, and traffic stays encrypted.
      </p>

      <div className="settings-source-row">
        <SegmentedControl
          label="Method"
          value={track}
          options={[
            { value: "tailscale", label: "Tailscale" },
            { value: "cloudflare", label: "Cloudflare Tunnel" },
          ]}
          onChange={(value) => {
            manualTrack.current = true;
            setTrack(value as "tailscale" | "cloudflare");
          }}
        />
      </div>

      {desktop && tools != null && (
        <div className="settings-remote-tool-statuses" aria-live="polite">
          <p className="settings-hint t-secondary">
            {tools.tailscale.installed ? (
              <>
                <strong>Tailscale detected</strong>
                {tools.tailscale.version != null ? ` (${tools.tailscale.version})` : ""}
                {` - ${tools.tailscale.detail === "connected" ? "connected" : "not logged in"}`}
              </>
            ) : (
              <>
                <strong>Tailscale: Not installed.</strong>{" "}
                <a href={TAILSCALE_INSTALL_URL} target="_blank" rel="noreferrer">
                  Install Tailscale
                </a>
              </>
            )}
          </p>
          <p className="settings-hint t-secondary">
            {tools.cloudflared.installed ? (
              <>
                <strong>cloudflared detected</strong>
                {tools.cloudflared.version != null ? ` (${tools.cloudflared.version})` : ""}
              </>
            ) : (
              <>
                <strong>cloudflared: Not installed.</strong>{" "}
                <a href={CLOUDFLARED_INSTALL_URL} target="_blank" rel="noreferrer">
                  Install cloudflared
                </a>
              </>
            )}
          </p>
          <button
            type="button"
            className="chip"
            onClick={() => void checkTools()}
            disabled={checking}
          >
            {checking ? "Checking..." : "Re-check"}
          </button>
        </div>
      )}

      <ol className="settings-remote-steps">
        {steps.map((step, index) => (
          <li key={step.title} className="settings-remote-step">
            <span className="settings-remote-step-num">{index + 1}</span>
            <span className="settings-remote-step-body">
              <strong>{step.title}</strong>
              <span className="t-secondary">{step.detail}</span>
              {step.command != null && <code>{step.command}</code>}
            </span>
          </li>
        ))}
      </ol>

      <div className="settings-divider" />
      <div className="settings-sources-head">
        <span className="settings-sources-title">TV and phone remote</span>
        <span className="chip">Every screen</span>
      </div>
      <p className="settings-hint t-secondary">
        Open the TV address in a TV browser, then open the phone remote address
        on a signed-in phone. The video stays on the TV and the phone sends
        private control commands only.
      </p>
      <div className="settings-invite-link">
        <code>{tvURL}</code>
        <button
          type="button"
          className="chip"
          onClick={() => void copyRemoteURL("TV address", tvURL)}
        >
          Copy TV address
        </button>
      </div>
      <div className="settings-invite-link">
        <code>{phoneRemoteURL}</code>
        <button
          type="button"
          className="chip"
          onClick={() => void copyRemoteURL("Phone remote address", phoneRemoteURL)}
        >
          Copy phone remote address
        </button>
      </div>
      <p className="settings-status" aria-live="polite">
        {copyStatus ?? ""}
      </p>

      <div className="settings-source-row">
        <a className="chip" href={guideURL} target="_blank" rel="noreferrer">
          {track === "tailscale" ? "Tailscale Funnel guide" : "Cloudflare Tunnel guide"}
        </a>
        <a
          className="chip"
          href="https://tailscale.com/download"
          target="_blank"
          rel="noreferrer"
        >
          Download Tailscale
        </a>
        <a
          className="chip"
          href="https://one.dash.cloudflare.com/"
          target="_blank"
          rel="noreferrer"
        >
          Cloudflare Zero Trust
        </a>
      </div>
      <p className="settings-hint t-secondary">
        Once you have the public URL, paste it into <strong>Connect to a
        server</strong> above. The desktop host can also show it automatically - 
        launch with <code>DEBRIDSTREAMER_DESKTOP_SHARE_URL</code> set.
      </p>
    </div>
  );
}

function ServerTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [role, setRole] = useState<ServerRole>("member");
  const [session, setSession] = useState<{
    username: string;
    displayName: string;
    role: ServerRole;
  } | null>(null);
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [usage, setUsage] = useState<ServerUsage | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [activeStreams, setActiveStreams] = useState<ActiveStreamSession[]>([]);
  const [pendingRequests, setPendingRequests] = useState<RequestRecord[]>([]);
  const [sessions, setSessions] = useState<ServerSessionEntry[]>([]);
  const [totpStatus, setTotpStatus] = useState<ServerTotpStatus>({
    enabled: false,
    enrollmentPending: false,
  });
  const [totpEnrollment, setTotpEnrollment] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpCurrentPassword, setTotpCurrentPassword] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [invites, setInvites] = useState<ServerInvite[]>([]);
  const [auditEvents, setAuditEvents] = useState<ServerAuditEvent[]>([]);
  const [inviteDraft, setInviteDraft] = useState({
    label: "",
    role: "member" as Exclude<ServerRole, "owner">,
    simpleMode: true,
    maxUses: 1,
    expiresDays: 7,
  });
  const [createdInviteURL, setCreatedInviteURL] = useState<string | null>(null);
  const [newProfile, setNewProfile] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "member" as Exclude<ServerRole, "owner">,
    simpleMode: true,
  });
  const [passwordDraft, setPasswordDraft] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [effectiveCredentials, setEffectiveCredentials] = useState<EffectiveCredential[]>([]);
  const [profileCredential, setProfileCredential] = useState({
    provider: "real_debrid" as CredentialProvider,
    label: "Personal",
    value: "",
  });
  const [sharedCredential, setSharedCredential] = useState({
    provider: "tmdb" as CredentialProvider,
    label: "Shared",
    value: "",
  });
  const [sharedCredentialTermsConfirmed, setSharedCredentialTermsConfirmed] =
    useState(false);
  // Which async save is in flight, so its submit button can disable + show
  // progress (prevents duplicate submissions / unclear final state).
  const [saving, setSaving] = useState<
    "password" | "credential" | "shared-credential" | null
  >(null);

  const canAdmin = role === "owner" || role === "admin";
  // A restricted profile can browse + watch but cannot perform management
  // actions (e.g. credential overrides). The server enforces this; hide the UI
  // so it isn't offered. Admin-only panels are already gated by canAdmin.
  const isRestricted = role === "restricted";

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const sessionResponse = await serverRequest<{
        session: {
          username: string;
          displayName: string;
          role: ServerRole;
        };
      }>("GET", "/api/auth/session");
      const admin =
        sessionResponse.session.role === "owner" ||
        sessionResponse.session.role === "admin";
      const [
        profilesResponse,
        usageResponse,
        healthResponse,
        activeStreamsResponse,
        requestsResponse,
        sessionsResponse,
        totpResponse,
        invitesResponse,
        credentialsResponse,
        auditResponse,
      ] = await Promise.all([
        serverRequest<{ profiles: ServerProfile[] }>("GET", "/api/profiles"),
        serverRequest<ServerUsage>(
          "GET",
          admin ? "/api/admin/usage/streams" : "/api/usage/streams",
        ),
        admin
          ? serverRequest<ServerHealth>("GET", "/api/admin/health")
          : Promise.resolve(null),
        admin
          ? serverRequest<{ streams: ActiveStreamSession[] }>(
              "GET",
              "/api/admin/streams/active",
            )
          : Promise.resolve({ streams: [] }),
        admin
          ? serverRequest<{ requests: RequestRecord[] }>(
              "GET",
              "/api/admin/requests?status=pending",
            )
          : Promise.resolve({ requests: [] }),
        serverRequest<{ sessions: ServerSessionEntry[] }>(
          "GET",
          "/api/auth/sessions",
        ),
        admin
          ? serverRequest<ServerTotpStatus>("GET", "/api/auth/totp").catch(() => ({
              enabled: false,
              enrollmentPending: false,
            }))
          : Promise.resolve({ enabled: false, enrollmentPending: false }),
        admin
          ? serverRequest<{ invites: ServerInvite[] }>("GET", "/api/admin/invites")
          : Promise.resolve({ invites: [] }),
        serverRequest<{ credentials: EffectiveCredential[] }>(
          "GET",
          "/api/credentials/effective",
        ),
        admin
          ? serverRequest<{ events: ServerAuditEvent[] }>(
              "GET",
              "/api/admin/audit-log?limit=25",
            )
          : Promise.resolve({ events: [] }),
      ]);
      setRole(sessionResponse.session.role);
      setSession(sessionResponse.session);
      setProfiles(profilesResponse.profiles);
      setUsage(usageResponse);
      setHealth(healthResponse);
      setActiveStreams(activeStreamsResponse.streams);
      setPendingRequests(requestsResponse.requests);
      setSessions(sessionsResponse.sessions);
      setTotpStatus(totpResponse);
      setInvites(invitesResponse.invites);
      setEffectiveCredentials(credentialsResponse.credentials);
      setAuditEvents(auditResponse.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createProfile() {
    setMessage(null);
    setError(null);
    try {
      await serverRequest("POST", "/api/profiles", {
        username: newProfile.username,
        displayName: newProfile.displayName || newProfile.username,
        password: newProfile.password,
        role: newProfile.role,
        simpleMode: newProfile.simpleMode,
      });
      setNewProfile({
        username: "",
        displayName: "",
        password: "",
        role: "member",
        simpleMode: true,
      });
      setMessage("Profile created.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSharedCredential() {
    // Same double-submit guard + busy state as its siblings below - this one
    // was missing it, so a double-click could double-PUT with no feedback.
    if (saving != null) return;
    setMessage(null);
    setError(null);
    setSaving("shared-credential");
    try {
      await serverRequest("PUT", "/api/admin/credentials", {
        provider: sharedCredential.provider,
        label: sharedCredential.label || "Shared",
        value: sharedCredential.value,
      });
      setSharedCredential((current) => ({ ...current, value: "" }));
      setSharedCredentialTermsConfirmed(false);
      setMessage("Shared credential saved.");
      // Refresh so the credential-overrides list + health counts reflect the
      // new provider immediately (mirrors saveProfileCredential et al.).
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function saveProfileCredential() {
    if (saving != null) return;
    setMessage(null);
    setError(null);
    setSaving("credential");
    try {
      await serverRequest("PUT", "/api/profile/credentials", {
        provider: profileCredential.provider,
        label: profileCredential.label || "Personal",
        value: profileCredential.value,
      });
      setProfileCredential((current) => ({ ...current, value: "" }));
      setMessage("Profile credential override saved.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function changePassword() {
    if (saving != null) return;
    setMessage(null);
    setError(null);
    // Validate before flipping the saving flag so a mismatch shows instantly.
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    setSaving("password");
    try {
      await serverRequest("POST", "/api/auth/change-password", {
        currentPassword: passwordDraft.currentPassword,
        newPassword: passwordDraft.newPassword,
      });
      setPasswordDraft({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setMessage("Password changed. Other sessions were signed out.");
      // The server just revoked the other sessions and wrote an audit event.
      // Without this the "Signed-in devices" list directly below still lists
      // them as active, contradicting the message above it, and still offers a
      // Revoke button for a session that is already gone. refresh() clears
      // `error` but not `message`, so the success text survives.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  async function revokeSession(id: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest(
        "DELETE",
        `/api/auth/sessions/${encodeURIComponent(id)}`,
      );
      setMessage("Session revoked.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revokeAllSessions() {
    setMessage(null);
    setError(null);
    try {
      await serverRequest("POST", "/api/auth/sessions/revoke-all", {
        includeCurrent: true,
      });
      notifyUnauthorized();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function enrollTotp() {
    setTotpBusy(true);
    setError(null);
    try {
      const enrollment = await serverRequest<{ secret: string; otpauthUrl: string }>(
        "POST",
        "/api/auth/totp/enroll",
      );
      setTotpEnrollment(enrollment);
      setTotpStatus({ enabled: false, enrollmentPending: true });
      setTotpCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function confirmTotp() {
    setTotpBusy(true);
    setError(null);
    try {
      await serverRequest("POST", "/api/auth/totp/confirm", { code: totpCode });
      setTotpStatus({ enabled: true, enrollmentPending: false });
      setTotpEnrollment(null);
      setTotpCode("");
      setMessage("Two-factor authentication enabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function disableTotp() {
    setTotpBusy(true);
    setError(null);
    try {
      await serverRequest("POST", "/api/auth/totp/disable", {
        currentPassword: totpCurrentPassword,
        code: totpCode,
      });
      setTotpStatus({ enabled: false, enrollmentPending: false });
      setTotpCurrentPassword("");
      setTotpCode("");
      setMessage("Two-factor authentication disabled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTotpBusy(false);
    }
  }

  async function revokeStream(id: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest(
        "POST",
        `/api/admin/streams/${encodeURIComponent(id)}/revoke`,
      );
      setMessage("Stream terminated.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function approveRequest(id: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest(
        "POST",
        `/api/admin/requests/${encodeURIComponent(id)}/approve`,
      );
      setMessage("Request approved.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function denyRequest(id: string, reason?: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest(
        "POST",
        `/api/admin/requests/${encodeURIComponent(id)}/deny`,
        reason != null && reason.trim().length > 0 ? { reason } : undefined,
      );
      setMessage("Request denied.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteProfileCredential(id: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest(
        "DELETE",
        `/api/profile/credentials/${encodeURIComponent(id)}`,
      );
      setMessage("Profile credential override removed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createInvite() {
    setMessage(null);
    setError(null);
    setCreatedInviteURL(null);
    try {
      const response = await serverRequest<{
        invite: ServerInvite;
        token: string;
      }>("POST", "/api/admin/invites", {
        label: inviteDraft.label.trim() || undefined,
        role: inviteDraft.role,
        simpleMode: inviteDraft.simpleMode,
        maxUses: inviteDraft.maxUses,
        expiresInSeconds: inviteDraft.expiresDays * 24 * 60 * 60,
      });
      setCreatedInviteURL(inviteURLFromToken(response.token));
      setInvites((current) => [response.invite, ...current]);
      setMessage("Invite link created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function inviteURLFromToken(token: string): string {
    const baseURL = configuredServerURL() ?? window.location.origin;
    const inviteURL = new URL(baseURL);
    inviteURL.searchParams.set("invite", token);
    return inviteURL.toString();
  }

  async function reissueInvite(invite: ServerInvite) {
    if (
      invite.active &&
      !window.confirm(
        "Reissue this invite? The current link will stop working immediately and a replacement link will be shown once.",
      )
    ) {
      return;
    }
    setMessage(null);
    setError(null);
    try {
      const response = await serverRequest<{
        invite: ServerInvite;
        token: string;
      }>(
        "POST",
        `/api/admin/invites/${encodeURIComponent(invite.id)}/reissue`,
      );
      setCreatedInviteURL(inviteURLFromToken(response.token));
      setInvites((current) => [
        response.invite,
        ...current.map((entry) =>
          entry.id === invite.id ? { ...entry, active: false } : entry,
        ),
      ]);
      setMessage("Invite reissued. Copy the replacement link now.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revokeInvite(id: string) {
    setMessage(null);
    setError(null);
    try {
      await serverRequest("DELETE", `/api/admin/invites/${encodeURIComponent(id)}`);
      setMessage("Invite revoked.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyInviteURL() {
    if (createdInviteURL == null) return;
    setMessage(null);
    setError(null);
    try {
      await navigator.clipboard.writeText(createdInviteURL);
      setMessage("Invite link copied.");
    } catch {
      setError("Clipboard is unavailable in this session.");
    }
  }

  async function logout() {
    setMessage(null);
    setError(null);
    try {
      await serverRequest("POST", "/api/auth/logout");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div
        className="settings-fields"
        aria-busy="true"
        aria-label="Loading server settings"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="settings-field" key={i} aria-hidden="true">
            <span className="settings-skel settings-skel-label" />
            <span className="settings-skel settings-skel-input" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="settings-fields">
      {error && <p className="settings-status is-error">{error}</p>}
      {message && <p className="settings-status">{message}</p>}

      <ServerConnectionPanel />

      <RemoteAccessPanel />

      <section className="settings-section" aria-labelledby="server-visibility-title">
        <h2 id="server-visibility-title">Who can see what</h2>
        <div className="settings-diagnostic-results">
          <p>
            <strong>Server owner and admins</strong>
            <span>
              Profiles, active stream filenames, usage totals, requests, health
              warnings, and audit events.
            </span>
          </p>
          <p>
            <strong>Profile members</strong>
            <span>
              Their own history, library, sessions, personal credentials, and
              household resources allowed by their role.
            </span>
          </p>
          <p>
            <strong>Configured providers</strong>
            <span>
              Requests and credentials sent to that provider when its service is
              used.
            </span>
          </p>
        </div>
        <p className="settings-hint">
          A profile password controls household access. It does not hide activity
          from the server operator.
        </p>
      </section>

      {session != null && (
        <div className="settings-profile-row glass-rest">
          <div>
            <strong>{session.displayName}</strong>
            <span className="t-secondary"> @{session.username}</span>
          </div>
          <div className="settings-profile-meta t-secondary">
            <span>{session.role}</span>
            <button type="button" className="chip" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {canAdmin && health != null && <ServerHealthPanel health={health} />}

      {canAdmin && (
        <ActiveStreamsPanel streams={activeStreams} onRevoke={revokeStream} />
      )}

      {canAdmin && (
        <RequestQueuePanel
          requests={pendingRequests}
          onApprove={(id) => void approveRequest(id)}
          onDeny={(id, reason) => void denyRequest(id, reason)}
        />
      )}

      {usage != null && <ServerUsagePanel usage={usage} />}

      {canAdmin && <ServerAuditPanel events={auditEvents} />}

      <PasswordPanel
        draft={passwordDraft}
        onDraftChange={setPasswordDraft}
        onSave={() => void changePassword()}
        saving={saving === "password"}
      />

      {canAdmin && (
        <TotpPanel
          status={totpStatus}
          enrollment={totpEnrollment}
          code={totpCode}
          currentPassword={totpCurrentPassword}
          busy={totpBusy}
          onCodeChange={setTotpCode}
          onCurrentPasswordChange={setTotpCurrentPassword}
          onEnroll={() => void enrollTotp()}
          onConfirm={() => void confirmTotp()}
          onDisable={() => void disableTotp()}
        />
      )}

      <SessionsPanel
        sessions={sessions}
        onRevoke={(id) => void revokeSession(id)}
        onRevokeAll={() => void revokeAllSessions()}
      />

      {!isRestricted && (
        <ProfileCredentialPanel
          credentials={effectiveCredentials}
          draft={profileCredential}
          onDraftChange={setProfileCredential}
          onSave={() => void saveProfileCredential()}
          onDelete={(id) => void deleteProfileCredential(id)}
          saving={saving === "credential"}
        />
      )}

      <div className="settings-sources-head">
        <span className="settings-sources-title">Profiles</span>
        <button type="button" className="chip" onClick={() => void refresh()}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>

      <div className="settings-profile-list">
        {profiles.map((profile) => (
          <div key={profile.id} className="settings-profile-row glass-rest">
            <div>
              <strong>{profile.displayName}</strong>
              <span className="t-secondary">
                {profile.username ? ` @${profile.username}` : ""}
              </span>
            </div>
            <div className="settings-profile-meta t-secondary">
              <span>{profile.role}</span>
              {profile.simpleMode != null && (
                <span>{profile.simpleMode ? "Simple" : "Advanced"}</span>
              )}
              {profile.disabled && <span>Disabled</span>}
              {profile.self && <span>You</span>}
            </div>
          </div>
        ))}
      </div>

      {canAdmin && (
        <>
          <div className="settings-divider" />

          <KidsProfilesPanel />

          <div className="settings-source glass-rest">
            <div className="settings-sources-head">
              <span className="settings-sources-title">Invite link</span>
              <span className="chip">Profiles</span>
            </div>
            <div className="settings-source-row">
              <input
                type="text"
                value={inviteDraft.label}
                onChange={(event) =>
                  setInviteDraft((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
                placeholder="Label, e.g. Family"
              />
              <select
                aria-label="Invite role"
                value={inviteDraft.role}
                onChange={(event) =>
                  setInviteDraft((current) => ({
                    ...current,
                    role: event.target.value as Exclude<ServerRole, "owner">,
                  }))
                }
              >
                <option value="member">Member</option>
                <option value="restricted">Restricted</option>
                {role === "owner" && <option value="admin">Admin</option>}
              </select>
              <input
                type="number"
                min={1}
                max={100}
                value={inviteDraft.maxUses}
                onChange={(event) =>
                  setInviteDraft((current) => ({
                    ...current,
                    maxUses: Number(event.target.value) || 1,
                  }))
                }
                aria-label="Maximum uses"
              />
              <input
                type="number"
                min={1}
                max={30}
                value={inviteDraft.expiresDays}
                onChange={(event) =>
                  setInviteDraft((current) => ({
                    ...current,
                    expiresDays: Number(event.target.value) || 1,
                  }))
                }
                aria-label="Expires after days"
              />
              <label className="settings-source-active">
                <input
                  type="checkbox"
                  checked={inviteDraft.simpleMode}
                  onChange={(event) =>
                    setInviteDraft((current) => ({
                      ...current,
                      simpleMode: event.target.checked,
                    }))
                  }
                />
                Simple
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => void createInvite()}
              >
                Create invite
              </button>
            </div>
            {createdInviteURL != null && (
              <div className="settings-invite-link">
                <code>{createdInviteURL}</code>
                <button
                  type="button"
                  className="chip"
                  onClick={() => void copyInviteURL()}
                >
                  Copy
                </button>
              </div>
            )}
            {invites.length > 0 && (
              <div className="settings-usage-list">
                {invites.slice(0, 6).map((invite) => (
                  <div key={invite.id} className="settings-usage-row">
                    <span>
                      <strong>{invite.label ?? invite.role}</strong>
                      <span className="t-secondary">
                        {" "}
                        {invite.usedCount}/{invite.maxUses} used · expires{" "}
                        {formatShortDate(invite.expiresAt)}
                      </span>
                    </span>
                    <span className="settings-profile-meta t-secondary">
                      <span>{invite.active ? "Active" : "Inactive"}</span>
                      <span>{invite.simpleMode ? "Simple" : "Advanced"}</span>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => void reissueInvite(invite)}
                      >
                        Reissue
                      </button>
                      {invite.active && (
                        <button
                          type="button"
                          className="chip"
                          onClick={() => void revokeInvite(invite.id)}
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

          <div className="settings-source glass-rest">
            <div className="settings-source-row">
              <input
                type="text"
                value={newProfile.username}
                onChange={(event) =>
                  setNewProfile((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
                placeholder="Username"
              />
              <input
                type="text"
                value={newProfile.displayName}
                onChange={(event) =>
                  setNewProfile((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="Display name"
              />
            </div>
            <div className="settings-source-row">
              <input
                type="password"
                value={newProfile.password}
                onChange={(event) =>
                  setNewProfile((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
                placeholder="Password"
              />
              <select
                aria-label="New profile role"
                value={newProfile.role}
                onChange={(event) =>
                  setNewProfile((current) => ({
                    ...current,
                    role: event.target.value as Exclude<ServerRole, "owner">,
                  }))
                }
              >
                <option value="member">Member</option>
                <option value="restricted">Restricted</option>
                {role === "owner" && <option value="admin">Admin</option>}
              </select>
              <label className="settings-source-active">
                <input
                  type="checkbox"
                  checked={newProfile.simpleMode}
                  onChange={(event) =>
                    setNewProfile((current) => ({
                      ...current,
                      simpleMode: event.target.checked,
                    }))
                  }
                />
                Simple
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => void createProfile()}
              >
                Create profile
              </button>
            </div>
          </div>

          <div className="settings-source glass-rest">
            <div className="settings-source-row">
              <select
                aria-label="Shared credential provider"
                value={sharedCredential.provider}
                onChange={(event) =>
                  setSharedCredential((current) => ({
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
                value={sharedCredential.label}
                onChange={(event) =>
                  setSharedCredential((current) => ({
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
                value={sharedCredential.value}
                onChange={(event) =>
                  setSharedCredential((current) => ({
                    ...current,
                    value: event.target.value,
                  }))
                }
                placeholder="Token or API key"
              />
              <button
                type="button"
                className="btn"
                onClick={() => void saveSharedCredential()}
                disabled={
                  saving != null ||
                  sharedCredential.value.trim().length === 0 ||
                  !sharedCredentialTermsConfirmed
                }
              >
                {saving === "shared-credential"
                  ? "Saving…"
                  : "Save shared credential"}
              </button>
            </div>
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={sharedCredentialTermsConfirmed}
                onChange={(event) =>
                  setSharedCredentialTermsConfirmed(event.target.checked)
                }
              />
              <span>
                <strong>Provider terms confirmed</strong>
                <span className="t-secondary">
                  I am authorized to use this credential for every profile that
                  can access this server. Some providers prohibit account or
                  credential sharing.
                </span>
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

// US movie certs the maturity cap offers, mildest → strongest (mirrors the
// server's MOVIE_CERTS enum). A kid profile is "watch this rating or milder".
const MATURITY_CERTS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
const DEFAULT_MATURITY_CAP = "PG-13";

/** Admin-only control over the account's "who's watching" sub-profiles' kid
 *  mode + maturity cap. These are the household VIEWER profiles (the picker's
 *  list, /api/account/profiles), distinct from the login accounts above. The
 *  server strictly couples the two fields, so the UI always sends them together:
 *  kid ON + a chosen cap, or kid OFF + a null cap. */
function KidsProfilesPanel() {
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const state = await fetchAccountProfiles();
      setProfiles(state.profiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(
    id: string,
    body: { isKid: boolean; maturityMax: string | null },
  ) {
    setBusyId(id);
    setError(null);
    try {
      const res = await setProfileMaturity(id, body);
      setProfiles(res.profiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  // The default profile can't be a kid (it's the household's primary viewer); it
  // mirrors the picker, which never gates the default. Only non-default ones show.
  const manageable = profiles.filter((profile) => !profile.isDefault);

  return (
    <div className="settings-source glass-rest">
      <div className="settings-sources-head">
        <span className="settings-sources-title">Kids profiles</span>
        <button type="button" className="chip" onClick={() => void refresh()}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>
      <p className="settings-hint t-secondary">
        Kid mode locks a viewer profile to a curated, search-free experience and
        only allows titles at or below the chosen maturity cap. Leaving a kid
        profile then requires the account password.
      </p>

      {loading ? (
        <div
          className="settings-usage-list"
          aria-busy="true"
          aria-label="Loading profiles"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="settings-usage-row" key={i} aria-hidden="true">
              <span className="settings-skel settings-skel-name" />
              <span className="settings-skel settings-skel-pill" />
            </div>
          ))}
        </div>
      ) : manageable.length === 0 ? (
        <p className="settings-hint t-secondary">
          Add a viewer profile from the &ldquo;Who&rsquo;s watching?&rdquo; picker
          to set it up as a kids profile.
        </p>
      ) : (
        <div className="settings-usage-list">
          {manageable.map((profile) => {
            const busy = busyId === profile.id;
            // When kid mode is off there's no cap to show - default the picker to
            // PG-13 so turning it on has a sensible starting cap.
            const cap = profile.maturityMax ?? DEFAULT_MATURITY_CAP;
            return (
              <div key={profile.id} className="settings-usage-row">
                <span>
                  <strong>{profile.displayName}</strong>
                  {profile.isKid && (
                    <span className="t-secondary"> Kids · up to {profile.maturityMax}</span>
                  )}
                </span>
                <span className="settings-profile-meta">
                  <label className="settings-source-active">
                    <input
                      type="checkbox"
                      checked={profile.isKid}
                      disabled={busy}
                      onChange={(event) => {
                        // Enforce the server's coupling: kid ON needs a cap
                        // (default PG-13); kid OFF clears it to null.
                        if (event.target.checked) {
                          void save(profile.id, { isKid: true, maturityMax: cap });
                        } else {
                          void save(profile.id, { isKid: false, maturityMax: null });
                        }
                      }}
                    />
                    Kid mode
                  </label>
                  <select
                    value={cap}
                    disabled={busy || !profile.isKid}
                    aria-label={`Maturity cap for ${profile.displayName}`}
                    onChange={(event) =>
                      void save(profile.id, {
                        isKid: true,
                        maturityMax: event.target.value,
                      })
                    }
                  >
                    {MATURITY_CERTS.map((cert) => (
                      <option key={cert} value={cert}>
                        {cert}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {error != null && <p className="settings-status is-error">{error}</p>}
    </div>
  );
}

function AppearanceTab({
  draft,
  applyAppearance,
  serverMode,
}: {
  draft: AppSettings;
  applyAppearance: (next: Partial<AppSettings>) => void;
  serverMode: boolean;
}) {
  // Smart preloading is a per-device preference, not a synced AppSettings field.
  const [smartPreload, setSmartPreload] = useState(isSmartPreloadEnabled());
  const changeSmartPreload = useCallback((enabled: boolean) => {
    setSmartPreloadEnabled(enabled);
    setSmartPreload(enabled);
  }, []);
  const replayWelcomeGuide = useCallback(() => {
    window.dispatchEvent(new CustomEvent("ds:open-welcome-guide"));
  }, []);
  const replayTierWelcome = useCallback(() => {
    window.dispatchEvent(new CustomEvent("ds:open-tier-welcome"));
  }, []);

  return (
    <AppearanceSettings
      draft={draft}
      serverMode={serverMode}
      smartPreload={smartPreload}
      onApplyAppearance={applyAppearance}
      onSmartPreloadChange={changeSmartPreload}
      onReplayWelcomeGuide={replayWelcomeGuide}
      onReplayTierWelcome={replayTierWelcome}
    />
  );
}

// Static fallbacks shown before (or when) a live fetch runs. The Refresh button
// replaces these with the provider's actual catalog.
const AI_MODEL_OPTIONS: Record<AppSettings["aiProvider"], string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini", "o4-mini"],
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  ollama: ["llama3.2", "qwen2.5", "mistral"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  openrouter: [
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4-6",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  mistral: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  xai: ["grok-4", "grok-3", "grok-3-mini"],
};

/** Merge the current value + live-fetched ids + static fallbacks into a unique,
 * ordered option list (current first so an off-list saved model stays visible). */
function modelOptions(
  provider: AppSettings["aiProvider"],
  current: string,
  fetched: string[],
): string[] {
  const base = fetched.length > 0 ? fetched : AI_MODEL_OPTIONS[provider] ?? [];
  const merged =
    current.trim().length > 0 && !base.includes(current)
      ? [current, ...base]
      : base;
  const seen = new Set<string>();
  return merged.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
}

/** Short "3 min ago" / "2 days ago" for a cache timestamp. */
function relativeTime(fromMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The "Model" picker. Seeds instantly from a per-provider cache, then quietly
 * refreshes the provider's live catalog in the background (no manual click
 * needed) whenever the provider or credential changes. A manual Refresh forces
 * a re-fetch. Falls back to the static list before any fetch/cache exists. */
function ModelSelectField({ draft, patch }: TabProps) {
  const [fetched, setFetched] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Bumped on every provider change and every (re)fetch; a resolved fetch only
  // commits its result if its id still matches, so a slow response from the
  // previous provider can't populate the new provider's dropdown.
  const reqId = useRef(0);

  const provider = draft.aiProvider;
  const apiKey = draft.aiApiKey;
  const endpoint = draft.ollamaEndpoint;
  const hasCredential =
    provider === "ollama"
      ? endpoint.trim().length > 0
      : apiKey.trim().length > 0;

  const load = useCallback(
    async (force: boolean) => {
      const id = (reqId.current += 1);
      const store = getStore();
      // 1. Seed from cache immediately (instant + offline-friendly).
      const cached = await readModelCache(store, provider).catch(() => null);
      if (id !== reqId.current) return;
      if (cached != null && cached.models.length > 0) {
        setFetched(cached.models);
        setFetchedAt(cached.fetchedAt);
      } else {
        setFetched([]);
        setFetchedAt(null);
      }
      setError(null);
      // 2. Decide whether to hit the network: a forced Refresh always does; an
      // automatic pass only when there's a credential AND the cache is missing
      // or stale (so re-opening Settings doesn't re-hit the API every time).
      const cacheFresh = cached != null && !cached.stale && cached.models.length > 0;
      const credential =
        provider === "ollama"
          ? endpoint.trim().length > 0
          : apiKey.trim().length > 0;
      if (!credential) return;
      if (!force && cacheFresh) return;

      setLoading(true);
      try {
        const models = await fetchAvailableModels({
          kind: provider,
          apiKey,
          endpoint,
          fetchImpl: appFetch,
        });
        if (id !== reqId.current) return;
        setFetched(models);
        const now = Date.now();
        setFetchedAt(now);
        void writeModelCache(store, provider, models, now);
      } catch (err) {
        if (id !== reqId.current) return;
        // Keep any cached list visible; a fetch failure is a soft warning.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [provider, apiKey, endpoint],
  );

  // Auto-load on mount and whenever the provider/credential changes. Debounced
  // so typing an API key character-by-character coalesces into a single fetch
  // (once the user pauses) instead of firing a request per keystroke. The reqId
  // guard inside load() still drops any stale in-flight result.
  useEffect(() => {
    const t = window.setTimeout(() => void load(false), 600);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <Field label="Model" hint="Updates automatically from your provider's live catalog.">
      <div className="settings-model-row">
        <select
          aria-label="AI model"
          value={draft.aiModel.trim().length === 0 ? "__default" : draft.aiModel}
          onChange={(event) =>
            patch({
              aiModel: event.target.value === "__default" ? "" : event.target.value,
            })
          }
        >
          <option value="__default">Provider default (recommended)</option>
          {modelOptions(provider, draft.aiModel, fetched).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="chip settings-model-refresh"
          onClick={() => void load(true)}
          disabled={loading}
          aria-busy={loading}
          title="Reload the provider's current models"
        >
          <Icon name="refresh" size={14} />
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error != null ? (
        <p className="settings-model-msg t-warning">{error}</p>
      ) : loading ? (
        <p className="settings-model-msg t-secondary">Loading live models…</p>
      ) : fetchedAt != null ? (
        <p className="settings-model-msg t-secondary">
          {fetched.length} model{fetched.length === 1 ? "" : "s"} · updated{" "}
          {relativeTime(fetchedAt)}
        </p>
      ) : !hasCredential ? (
        <p className="settings-model-msg t-secondary">
          Add your API key to load this provider's live model list.
        </p>
      ) : null}
    </Field>
  );
}

function KeysTab({ draft, patch }: TabProps) {
  const [keyPanel, setKeyPanel] = useState<"catalog" | "assistant">("catalog");
  const serverMode = isServerMode();
  const keyPanels: Array<{
    id: "catalog" | "assistant";
    label: string;
    summary: string;
  }> = [
    {
      id: "catalog",
      label: "Catalog metadata",
      summary: "Search, posters, ratings",
    },
    {
      id: "assistant",
      label: "Assistant AI",
      summary: "Mood discovery and chat",
    },
  ];

  return (
    <div className="settings-fields">
      <SettingsInfo label="About credential storage">
        Secrets stay in this profile. Desktop builds keep them in secure device
        storage when available.
      </SettingsInfo>

      <div className="settings-subsection-picker is-option-only">
        <label className="settings-subsection-select settings-mobile-picker">
          <span>Credential group</span>
          <select
            value={keyPanel}
            onChange={(event) =>
              setKeyPanel(event.target.value as "catalog" | "assistant")
            }
          >
            {keyPanels.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.label}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-option-strip" aria-label="Credential group">
          {keyPanels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={`settings-option-card${keyPanel === panel.id ? " is-active" : ""}`}
              onClick={() => setKeyPanel(panel.id)}
              aria-pressed={keyPanel === panel.id}
            >
              <span>{panel.label}</span>
              <small>{panel.summary}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-key-grid is-single">
        {keyPanel === "catalog" && (
          <>
            <section className="settings-key-card glass-rest" aria-label="Catalog metadata credentials">
              <Field
                label="TMDB API key"
                hint="Powers Discover, Search, and Detail metadata. Free to sign up."
                helpUrl={signupUrl("tmdb") ?? undefined}
                helpLabel="Get a free TMDB key"
              >
                <SecretInput
                  value={draft.tmdbKey}
                  onChange={(e) => patch({ tmdbKey: e.target.value })}
                  placeholder="v3 API key"
                />
              </Field>

              {/* OMDB is optional enrichment on top of TMDB - an Advanced extra. */}
              <AdvancedOnly>
                <Field label="OMDB API key" hint="Optional IMDb / Rotten Tomatoes enrichment.">
                  <SecretInput
                    value={draft.omdbKey}
                    onChange={(e) => patch({ omdbKey: e.target.value })}
                    placeholder="OMDB key"
                  />
                </Field>
              </AdvancedOnly>

              <Field
                label="OpenSubtitles API key"
                hint="Enables in-player subtitle search and download."
                helpUrl={signupUrl("openSubtitles") ?? undefined}
                helpLabel="Create an OpenSubtitles account"
              >
                <SecretInput
                  value={draft.openSubtitlesApiKey}
                  onChange={(e) => patch({ openSubtitlesApiKey: e.target.value })}
                  placeholder="OpenSubtitles key"
                />
              </Field>
            </section>
            {!serverMode && <TraktConnectionSection draft={draft} patch={patch} />}
          </>
        )}

        {keyPanel === "assistant" && (
          <section className="settings-key-card glass-rest" aria-label="Assistant AI credentials">
            <div className="settings-key-provider-grid">
              <Field
                label="AI provider"
                hint="Ollama runs locally (no key); the rest need an API key below."
              >
                <select
                  aria-label="AI provider"
                  value={draft.aiProvider}
                  onChange={(e) =>
                    // Reset the model override too: a model id from the old
                    // provider (e.g. gpt-4o-mini) would be rejected by the new host.
                    patch({
                      aiProvider: e.target.value as AppSettings["aiProvider"],
                      aiModel: "",
                    })
                  }
                >
                  {AIProviderKind.allCases().map((k) => (
                    <option key={k} value={k}>
                      {AIProviderKind.displayName(k)}
                      {k === "ollama" ? " · local, no key" : ""}
                    </option>
                  ))}
                </select>
              </Field>

              {/* The explicit model override is an Advanced dial - Simple mode
                  sticks with the recommended provider default. */}
              <AdvancedOnly>
                <ModelSelectField draft={draft} patch={patch} />
              </AdvancedOnly>
            </div>

            {draft.aiProvider === "ollama" ? (
              <Field label="Ollama endpoint" hint="A local Ollama server URL.">
                <input
                  type="text"
                  value={draft.ollamaEndpoint}
                  onChange={(e) => patch({ ollamaEndpoint: e.target.value })}
                  placeholder="http://localhost:11434"
                />
              </Field>
            ) : (
              <Field label={`${AIProviderKind.displayName(draft.aiProvider)} API key`}>
                <SecretInput
                  value={draft.aiApiKey}
                  onChange={(e) => patch({ aiApiKey: e.target.value })}
                  placeholder="API key"
                />
              </Field>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function TraktConnectionSection({ draft, patch }: TabProps) {
  const [connection, setConnection] = useState<{
    connected: boolean;
    username: string | null;
  }>({ connected: false, username: null });
  const [checking, setChecking] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadConnection = useCallback(async () => {
    try {
      const connected = await isTraktConnected();
      const stored = connected ? await loadTraktConnection() : null;
      return {
        connected,
        username: stored?.meta.username ?? null,
      };
    } catch {
      return { connected: false, username: null };
    }
  }, []);

  const refreshConnection = useCallback(async () => {
    setChecking(true);
    setConnection(await loadConnection());
    setChecking(false);
  }, [loadConnection]);

  useEffect(() => {
    let active = true;
    setChecking(true);
    void loadConnection().then((next) => {
      if (!active) return;
      setConnection(next);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [loadConnection]);

  async function disconnect() {
    setDisconnecting(true);
    try {
      await clearTraktConnection();
      await refreshConnection();
    } finally {
      setDisconnecting(false);
    }
  }

  const hasCredentials =
    draft.traktClientId.trim().length > 0 &&
    draft.traktClientSecret.trim().length > 0;

  return (
    <section className="settings-key-card glass-rest" aria-label="Trakt connection">
      <div className="settings-key-card-head">
        <div>
          <strong>Trakt</strong>
          <p className="settings-hint">
            Register a free app at trakt.tv/oauth/applications, then paste its Client ID and Secret.
          </p>
        </div>
      </div>

      <Field label="Trakt Client ID">
        <SecretInput
          value={draft.traktClientId}
          onChange={(event) => patch({ traktClientId: event.target.value })}
          placeholder="Client ID"
        />
      </Field>
      <Field label="Trakt Client Secret">
        <SecretInput
          value={draft.traktClientSecret}
          onChange={(event) => patch({ traktClientSecret: event.target.value })}
          placeholder="Client Secret"
        />
      </Field>

      <div className="settings-model-row">
        <span className="settings-model-msg t-secondary" aria-live="polite">
          {checking
            ? "Checking Trakt connection…"
            : connection.connected
              ? `Connected${connection.username != null ? ` as ${connection.username}` : ""}`
              : "Not connected"}
        </span>
        {connection.connected ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void disconnect()}
            disabled={disconnecting}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-prominent btn-sm"
            onClick={() => setDialogOpen(true)}
            disabled={!hasCredentials || checking}
          >
            Connect
          </button>
        )}
      </div>

      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.traktScrobbleEnabled}
          disabled={!connection.connected || checking}
          onChange={(event) => patch({ traktScrobbleEnabled: event.target.checked })}
        />
        <span>
          <strong>Scrobble to Trakt</strong>
          <span className="t-secondary">
            {" "}- mark what you watch as watching/watched on your Trakt profile.
          </span>
        </span>
      </label>

      <p className="settings-model-msg t-secondary">
        Syncs movies and series in the watchlist. Scrobbling is opt-in and only
        reports real player activity.
      </p>

      {dialogOpen && (
        <TraktConnectDialog
          clientId={draft.traktClientId.trim()}
          clientSecret={draft.traktClientSecret.trim()}
          onClose={() => setDialogOpen(false)}
          onConnected={() => void refreshConnection()}
        />
      )}
    </section>
  );
}

function SecretInput({
  value,
  onChange,
  placeholder,
  label,
  note = "",
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  label?: string;
  note?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setMessage(null);
    onChange(event);
  }

  async function copySecret() {
    if (value.trim().length === 0) {
      setMessage("Nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Copied.");
    } catch {
      setMessage("Clipboard unavailable.");
    }
  }

  const cleanedNote = note.trim();
  const showNote = cleanedNote.length > 0 || message != null;

  return (
    <div className="settings-secret-wrap">
      {label != null && label.trim().length > 0 && (
        <span className="settings-secret-label">{label}</span>
      )}
      <div className="settings-secret">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          aria-label={label ?? placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="settings-secret-actions">
          <button
            type="button"
            className="settings-secret-btn"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? "Hide secret" : "Reveal secret"}
            title={revealed ? "Hide" : "Reveal"}
          >
            <Icon name={revealed ? "eye-off" : "eye"} size={15} />
          </button>
          <button
            type="button"
            className="settings-secret-btn"
            onClick={() => void copySecret()}
            aria-label="Copy secret"
            title="Copy"
          >
            <Icon name="copy" size={15} />
          </button>
        </div>
      </div>
      {showNote && (
        <div className="settings-secret-note">
          {cleanedNote.length > 0 && <span>{cleanedNote}</span>}
          {message != null && <strong>{message}</strong>}
        </div>
      )}
    </div>
  );
}

// Maps a debrid service value to its onboardingHelp signup-link id.
const DEBRID_SIGNUP_ID: Record<string, string> = {
  real_debrid: "realDebrid",
  all_debrid: "allDebrid",
  premiumize: "premiumize",
  torbox: "torbox",
};

function DebridTab({ draft, patch }: TabProps) {
  const serviceOptions = DebridServiceType.allCases();
  const [selectedService, setSelectedService] = useState<
    AppSettings["debridTokens"][number]["service"]
  >(serviceOptions[0]);
  const [connectionState, setConnectionState] = useState<
    "idle" | "testing" | "valid" | "failed"
  >("idle");

  useEffect(() => {
    setConnectionState("idle");
  }, [selectedService, draft.debridTokens]);

  function tokenFor(service: AppSettings["debridTokens"][number]["service"]) {
    return draft.debridTokens.find((t) => t.service === service)?.apiToken ?? "";
  }
  function setToken(
    service: AppSettings["debridTokens"][number]["service"],
    token: string,
  ) {
    const exists = draft.debridTokens.some((t) => t.service === service);
    let next: AppSettings["debridTokens"];
    if (token.trim().length === 0) {
      // Clearing → drop the entry, preserving the order of the rest.
      next = draft.debridTokens.filter((t) => t.service !== service);
    } else if (exists) {
      // Update IN PLACE. Array order is provider priority (saveSettingsToStore
      // assigns priority by index), so filter+re-append would silently demote an
      // edited provider to last and change which service is preferred.
      next = draft.debridTokens.map((t) =>
        t.service === service ? { ...t, apiToken: token } : t,
      );
    } else {
      next = [...draft.debridTokens, { service, apiToken: token }];
    }
    patch({ debridTokens: next });
  }

  async function testConnection() {
    const apiToken = tokenFor(selectedService).trim();
    if (apiToken.length === 0 || connectionState === "testing") return;
    setConnectionState("testing");
    // In server mode the token check must run ON the server: debrid hosts
    // (TorBox in particular) send no CORS headers, so a webview/browser-side
    // test fails even for a perfect token.
    let valid = false;
    try {
      valid = isServerMode()
        ? await testServerDebridToken({ service: selectedService, apiToken })
        : await testDebridToken({ service: selectedService, apiToken });
    } catch {
      valid = false;
    }
    setConnectionState(valid ? "valid" : "failed");
  }

  return (
    <div className="settings-fields">
      <SettingsInfo label={`About ${CONCEPTS.debrid.term}`}>
        <strong>{CONCEPTS.debrid.term}:</strong> {CONCEPTS.debrid.blurb} Choose
        one provider at a time. Saved providers are tried in priority order; the
        first that has a cached result wins. Tokens stay in this profile, with
        secure device storage in desktop builds when available. Use only
        provider accounts and content you are authorized to access. Provider
        terms can restrict credential sharing, automation, or household use.
      </SettingsInfo>

      <Field label="Provider" hint="Real-Debrid is selected first by default.">
        <select
          aria-label="Debrid provider"
          value={selectedService}
          onChange={(event) =>
            setSelectedService(
              event.target.value as AppSettings["debridTokens"][number]["service"],
            )
          }
        >
          {serviceOptions.map((service) => (
            <option key={service} value={service}>
              {DebridServiceType.displayName(service)}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={`${DebridServiceType.displayName(selectedService)} token`}
        hint="Paste the API token for this provider."
        helpUrl={signupUrl(DEBRID_SIGNUP_ID[selectedService]) ?? undefined}
        helpLabel={`Find your ${DebridServiceType.displayName(selectedService)} token`}
      >
        <SecretInput
          value={tokenFor(selectedService)}
          onChange={(e) => setToken(selectedService, e.target.value)}
          placeholder="API token"
        />
      </Field>

      <div className="settings-provider-check" aria-live="polite">
        <button
          type="button"
          className="btn"
          onClick={() => void testConnection()}
          disabled={
            tokenFor(selectedService).trim().length === 0 ||
            connectionState === "testing"
          }
        >
          {connectionState === "testing" ? "Checking…" : "Test connection"}
        </button>
        {connectionState === "valid" && (
          <span className="settings-provider-result is-valid">
            <Icon name="check" size={14} /> Connected
          </span>
        )}
        {connectionState === "failed" && (
          <span className="settings-provider-result is-error">
            Connection failed. Refresh the token or try again.
          </span>
        )}
      </div>

      {draft.debridTokens.length > 0 && (
        <div className="settings-url-list">
          {draft.debridTokens.map((token, index) => (
            <button
              key={token.service}
              type="button"
              className="chip"
              onClick={() => setSelectedService(token.service)}
            >
              {index + 1}. {DebridServiceType.displayName(token.service)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SourcesTab({ draft, patch }: TabProps) {
  const [selectedPresetId, setSelectedPresetId] = useState(SOURCE_PRESETS[0].id);

  function addSource() {
    const preset = sourcePreset(selectedPresetId);
    const entry: SourceEntry = {
      id: `src-${Date.now()}`,
      type: preset.type,
      baseURL: preset.baseURL,
      apiKey: "",
      isActive: true,
      displayName: preset.displayName,
      priority: draft.sources.length,
    };
    patch({ sources: [...draft.sources, entry] });
  }
  function updateSource(id: string, next: Partial<SourceEntry>) {
    patch({
      sources: draft.sources.map((s) => (s.id === id ? { ...s, ...next } : s)),
    });
  }
  function removeSource(id: string) {
    patch({ sources: draft.sources.filter((s) => s.id !== id) });
  }
  /** Reorder a source (priority = list order, lower index = higher priority). */
  function moveSource(id: string, delta: number) {
    const idx = draft.sources.findIndex((s) => s.id === id);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= draft.sources.length) return;
    const reordered = [...draft.sources];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(next, 0, moved);
    patch({ sources: reordered.map((s, i) => ({ ...s, priority: i })) });
  }
  function changeSourceType(source: SourceEntry, type: StoredIndexerType) {
    const preset = defaultSourcePreset(type);
    updateSource(source.id, {
      type,
      baseURL: preset.baseURL,
      displayName:
        source.displayName != null && source.displayName.trim().length > 0
          ? source.displayName
          : preset.displayName,
    });
  }

  return (
    <div className="settings-fields">
      <SettingsInfo label={`About ${CONCEPTS.source.term}`}>
        <strong>{CONCEPTS.source.term}:</strong> {CONCEPTS.source.blurb} Pair a
        source with a debrid service to stream instantly.
      </SettingsInfo>
      <label className="settings-toggle-row">
        <input
          type="checkbox"
          checked={draft.builtInIndexersEnabled}
          onChange={(e) => patch({ builtInIndexersEnabled: e.target.checked })}
        />
        <span>
          <strong>Built-in scrapers</strong>
          <span className="settings-built-in-list t-secondary">
            Torrentio, APIBay, YTS, EZTV
          </span>
          <span className="settings-pill">Off until you opt in</span>
        </span>
      </label>

      <div className="settings-divider" />

      <div className="settings-sources-head">
        <span className="settings-sources-title">External sources</span>
        <div className="settings-add-source">
          <select
            value={selectedPresetId}
            onChange={(event) => setSelectedPresetId(event.target.value)}
            aria-label="Source preset"
          >
            {SOURCE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-prominent settings-add-source-btn"
            onClick={addSource}
          >
            <Icon name="check" size={13} /> Add source
          </button>
        </div>
      </div>

      {draft.sources.length === 0 ? (
        <p className="settings-hint t-secondary">
          No external sources. Add a source or explicitly enable the public
          built-in scrapers.
        </p>
      ) : (
        draft.sources.map((s, i) => {
          const choices = sourceURLChoices(s.type, s.baseURL);
          const urlSelectValue = choices.some((choice) => choice.value === s.baseURL)
            ? s.baseURL
            : CUSTOM_SOURCE_URL;
          const selectedChoice = choices.find((choice) => choice.value === s.baseURL);
          const preset = defaultSourcePreset(s.type);

          return (
            <div key={s.id} className="settings-source glass-rest">
              <div className="settings-source-row">
                <div className="settings-source-main">
                  <label className="settings-source-control settings-source-type-control">
                    <span>Protocol</span>
                    <select
                      className="settings-source-type-select"
                      value={s.type}
                      onChange={(e) =>
                        changeSourceType(s, e.target.value as SourceEntry["type"])
                      }
                    >
                      {SOURCE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {sourceTypeLabel(t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-source-control settings-source-name-control">
                    <span>Source name</span>
                    <input
                      type="text"
                      className="settings-source-name"
                      value={s.displayName ?? ""}
                      onChange={(e) =>
                        updateSource(s.id, { displayName: e.target.value })
                      }
                      placeholder="Display name"
                    />
                  </label>
                </div>
                <div className="settings-source-actions">
                  <label className="settings-source-active">
                    <input
                      type="checkbox"
                      checked={s.isActive}
                      onChange={(e) =>
                        updateSource(s.id, { isActive: e.target.checked })
                      }
                    />
                    Enabled
                  </label>
                  <div className="settings-source-button-group">
                    <button
                      type="button"
                      className="settings-source-remove"
                      onClick={() => moveSource(s.id, -1)}
                      aria-label="Move source up"
                      title="Move up"
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="settings-source-remove"
                      onClick={() => moveSource(s.id, 1)}
                      aria-label="Move source down"
                      title="Move down"
                      disabled={i === draft.sources.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="settings-source-remove"
                      onClick={() => removeSource(s.id)}
                      aria-label="Remove source"
                    >
                      <Icon name="xmark" size={15} />
                    </button>
                  </div>
                </div>
              </div>

              <div
                className={`settings-source-url-line${
                  urlSelectValue === CUSTOM_SOURCE_URL ? " has-custom" : ""
                }`}
              >
                <label className="settings-source-control">
                  <span>URL preset</span>
                  <select
                    className="settings-source-url-select"
                    value={urlSelectValue}
                    onChange={(event) => {
                      if (event.target.value !== CUSTOM_SOURCE_URL) {
                        updateSource(s.id, { baseURL: event.target.value });
                      }
                    }}
                  >
                    {choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                    <option value={CUSTOM_SOURCE_URL}>Custom URL</option>
                  </select>
                </label>
                {urlSelectValue === CUSTOM_SOURCE_URL && (
                  <label className="settings-source-control">
                    <span>Custom URL</span>
                    <input
                      type="url"
                      className="settings-source-url-input"
                      value={s.baseURL}
                      onChange={(e) =>
                        updateSource(s.id, { baseURL: e.target.value })
                      }
                      placeholder="https://indexer.example.com"
                    />
                  </label>
                )}
              </div>

              <p className="settings-source-meta">
                {selectedChoice?.label ?? "Custom URL"} · {preset.note}
              </p>
              <SecretInput
                value={s.apiKey ?? ""}
                onChange={(e) => updateSource(s.id, { apiKey: e.target.value })}
                label="API key"
                placeholder="API key (if required)"
                note="Saved only for this source."
              />
            </div>
          );
        })
      )}
      <p className="settings-hint">
        YAWF Stream does not host or supply media. Source availability does not
        establish permission to access a title. You are responsible for the
        sources you configure and for following applicable provider terms and
        law.
      </p>
    </div>
  );
}
