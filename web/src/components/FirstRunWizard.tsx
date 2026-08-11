// Persona-based first-run wizard (Local Mode only). Routes a brand-new user down
// one of five paths, or lets them skip past an honest warning. The "device"
// path is a FORCED key-collection flow: the app can't search properly without
// a TMDB key and can't play anything without a debrid token, so both are
// collected (with live validation) before the wizard completes - each with an
// explicit, honest escape rather than a silent skip. Mounted by FirstRunHost
// (see App.tsx) when isFirstRun() is true.

import { useState, type FormEvent } from "react";
import { useAppStore } from "../store/AppStore";
import {
  markOnboardingComplete,
  markQuickSetupAcknowledged,
} from "../lib/firstRun";
import { saveServerURL } from "../lib/serverMode";
import { isTauri } from "../lib/tauri";
import { DebridServiceType } from "../services/debrid/models";
import { AIProviderKind } from "../services/ai/models";
import type { AppSettings, DebridTokenEntry } from "../data/settings";
import {
  AI_SIGNUP_ID,
  CONCEPTS,
  DEBRID_SIGNUP_ID,
  setupVideoUrl,
  signupUrl,
} from "../data/onboardingHelp";
import { testDebridToken, testOmdbKey, testTmdbKey } from "../lib/onboardingValidation";
import { ensureDefaultProfile } from "../storage/ProfileRegistry";
import { Icon, type IconName } from "./Icon";
import { useDirectTorrentAvailable } from "../lib/ServerSessionContext";
import "./FirstRunWizard.css";

interface Persona {
  id: "device" | "quick" | "connect" | "host" | "advanced";
  title: string;
  copy: string;
  icon: IconName;
  /** Optional status chip. Recommendation styling is controlled separately. */
  badge?: string;
  recommended?: boolean;
}

const PERSONAS: Persona[] = [
  {
    id: "device",
    title: "Just watch on this device",
    copy: "Connect a catalog key and a debrid account before playback.",
    icon: "play",
    badge: "Recommended",
    recommended: true,
  },
  {
    id: "quick",
    title: "Quick setup",
    copy: "Start with public sources without adding your own keys now. Catalog and playback limits are explained before continuing.",
    icon: "sparkles",
    badge: "Not recommended",
  },
  {
    id: "connect",
    title: "Connect to a server",
    copy: "Already have a server or an invite link? Paste the address and sign in.",
    icon: "share",
  },
  {
    id: "host",
    title: "Host for my family",
    copy: "Run the server on this computer; your household signs in from their own devices.",
    icon: "debrid",
  },
  {
    id: "advanced",
    title: "Advanced setup",
    copy: "Set up the core keys, then open full settings for every provider, source, and dial.",
    icon: "sliders",
  },
];

/** Validate a web destination and add HTTPS when the user typed a bare host. */
function normalizeServerDestination(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const schemeMatch = value.match(/^([a-z][a-z\d+.-]*):/i);
  if (schemeMatch != null) {
    const scheme = schemeMatch[1]?.toLowerCase();
    const remainder = value.slice(schemeMatch[0].length);
    const looksLikeHostPort = /^\d+(?:[/?#]|$)/.test(remainder);
    if (scheme !== "http" && scheme !== "https" && !looksLikeHostPort) {
      return null;
    }
    if ((scheme === "http" || scheme === "https") && !/^https?:\/\//i.test(value)) {
      return null;
    }
  }

  const destination = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(destination);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0
    ) {
      return null;
    }
    return destination;
  } catch {
    return null;
  }
}

/** The catalog step's validated result: exactly one key, or null when the
 *  (non-forced) built-in-catalog escape was taken. */
interface CatalogKey {
  tmdbKey?: string;
  omdbKey?: string;
}

/** The optional AI step's result. A cloud provider carries an apiKey; the
 *  local Ollama provider carries an endpoint instead. */
interface AiChoice {
  provider: AIProviderKind;
  apiKey?: string;
  ollamaEndpoint?: string;
}

export function FirstRunWizard({
  onDone,
  forced = false,
}: {
  onDone: () => void;
  /** Mandatory mode: the launch found no catalog key or no debrid token.
   * Skipping is hidden, while Quick setup remains an explicit acknowledged
   * escape that records the user's choice not to configure credentials. */
  forced?: boolean;
}) {
  const { settings, services, updateSettings, navigate } = useAppStore();
  const directTorrentAvailable = useDirectTorrentAvailable();
  const [step, setStep] = useState<
    | "choose"
    | "connect"
    | "quick"
    | "host"
    | "catalog"
    | "streaming"
    | "ai"
    | "skip-confirm"
  >("choose");
  // Debrid entry carried from the streaming step into the optional AI step, so
  // both land in the single final settings write.
  const [collectedDebrid, setCollectedDebrid] = useState<DebridTokenEntry | null>(
    null,
  );
  // Validated catalog key carried from the catalog step; null = the user chose
  // the built-in-catalog escape (an existing key is never clobbered).
  const [collectedCatalog, setCollectedCatalog] = useState<CatalogKey | null>(null);
  // Which persona the key steps will exit into. In forced mode the advanced and
  // host paths route THROUGH catalog+streaming first - otherwise they'd close
  // the mandatory wizard keyless and every next launch would re-trap the user.
  const [exitPersona, setExitPersona] = useState<"device" | "advanced" | "host">(
    "device",
  );
  async function finish(simple: boolean, andThen?: () => void) {
    await updateSettings({ ...settings, simpleMode: simple });
    await ensureDefaultProfile({
      name: settings.userName || "You",
      avatar: settings.userAvatar || "😀",
    });
    await markOnboardingComplete();
    andThen?.();
    onDone();
  }

  async function finishQuick() {
    await updateSettings({
      ...settings,
      simpleMode: true,
      builtInIndexersEnabled: true,
    });
    await ensureDefaultProfile({
      name: settings.userName || "You",
      avatar: settings.userAvatar || "😀",
    });
    await markQuickSetupAcknowledged();
    await markOnboardingComplete();
    onDone();
  }

  /** The device path's SINGLE settings write: catalog keys, the debrid entry,
   *  and the optional AI choice all land in one updateSettings so services
   *  rebuild once and nothing races. Escapes pass null and never write empty
   *  values over a re-running user's existing keys. */
  async function finishDevice(
    debrid: DebridTokenEntry | null,
    ai: AiChoice | null,
  ) {
    const next: AppSettings = {
      ...settings,
      // Advanced keeps the full UI it asked for; device/host stay simple.
      simpleMode: exitPersona !== "advanced",
    };
    if (collectedCatalog?.tmdbKey != null && collectedCatalog.tmdbKey.trim().length > 0) {
      next.tmdbKey = collectedCatalog.tmdbKey.trim();
    }
    if (collectedCatalog?.omdbKey != null && collectedCatalog.omdbKey.trim().length > 0) {
      next.omdbKey = collectedCatalog.omdbKey.trim();
    }
    if (debrid != null) {
      // Replace an existing entry for the same provider, else prepend.
      next.debridTokens = [
        debrid,
        ...settings.debridTokens.filter((t) => t.service !== debrid.service),
      ];
    }
    if (ai != null) {
      next.aiProvider = ai.provider;
      if (ai.apiKey != null) next.aiApiKey = ai.apiKey.trim();
      if (ai.ollamaEndpoint != null && ai.ollamaEndpoint.trim().length > 0) {
        next.ollamaEndpoint = ai.ollamaEndpoint.trim();
      }
    }
    await updateSettings(next);
    await ensureDefaultProfile({
      name: settings.userName || "You",
      avatar: settings.userAvatar || "😀",
    });
    await markOnboardingComplete();
    // Advanced and host asked for Settings, land them there once keys are in.
    if (exitPersona !== "device") navigate("settings");
    onDone();
  }

  async function choose(id: Persona["id"]) {
    if (id === "device") {
      setExitPersona("device");
      return setStep("catalog");
    }
    if (id === "quick") return setStep("quick");
    if (id === "advanced") {
      // Forced: keys first, then the full settings they asked for - a keyless
      // finish would just re-trap them on the next launch.
      if (forced) {
        setExitPersona("advanced");
        return setStep("catalog");
      }
      return finish(false, () => navigate("settings"));
    }
    if (id === "connect") return setStep("connect");
    if (id === "host") return setStep("host");
  }

  async function skip() {
    await updateSettings({ ...settings, simpleMode: true });
    await ensureDefaultProfile({
      name: settings.userName || "You",
      avatar: settings.userAvatar || "😀",
    });
    await markOnboardingComplete();
    onDone();
  }

  if (step === "connect") {
    return <ConnectStep onBack={() => setStep("choose")} />;
  }
  if (step === "quick") {
    return (
      <QuickSetupStep
        liveMetadataAvailable={services.tmdb != null}
        directTorrentAvailable={directTorrentAvailable}
        onBack={() => setStep("choose")}
        onContinue={() => void finishQuick()}
      />
    );
  }
  if (step === "host") {
    return (
      <HostStep
        onBack={() => setStep("choose")}
        onContinue={() => {
          // Forced: collect this device's keys before the hosting hand-off - 
          // hosting setup lives in Settings, but the local client must not
          // leave the mandatory wizard unusable.
          if (forced) {
            setExitPersona("host");
            setStep("catalog");
            return;
          }
          void finish(true, () => navigate("settings"));
        }}
      />
    );
  }
  if (step === "catalog") {
    return (
      <CatalogStep
        initialTmdb={collectedCatalog?.tmdbKey ?? settings.tmdbKey}
        initialOmdb={collectedCatalog?.omdbKey ?? settings.omdbKey}
        forced={forced}
        onBack={() => setStep("choose")}
        onNext={(key) => {
          setCollectedCatalog(key);
          setStep("streaming");
        }}
      />
    );
  }
  if (step === "streaming") {
    return (
      <StreamingStep
        existing={settings.debridTokens}
        forced={forced}
        onBack={() => setStep("catalog")}
        onDone={(entry) => {
          // The debrid choice is made - offer the optional AI step before the
          // single final settings write.
          setCollectedDebrid(entry);
          setStep("ai");
        }}
      />
    );
  }
  if (step === "ai") {
    return (
      <AiStep
        initialProvider={settings.aiProvider}
        initialKey={settings.aiApiKey}
        initialOllamaEndpoint={settings.ollamaEndpoint}
        onBack={() => setStep("streaming")}
        onSkip={() => void finishDevice(collectedDebrid, null)}
        onSave={(ai) => void finishDevice(collectedDebrid, ai)}
      />
    );
  }
  if (step === "skip-confirm") {
    return (
      <SkipConfirmStep onBack={() => setStep("choose")} onSkip={() => void skip()} />
    );
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <p className="first-run-eyebrow">
          <Icon name="sparkles" size={13} />
          Welcome to YAWF Stream
        </p>
        <h1 className="first-run-title">How do you want to use YAWF Stream?</h1>
        <p className="first-run-sub">
          {forced
            ? "The app needs its keys before it can search or stream - pick a path to set them up."
            : "Pick one to get started - you can change anything later in Settings."}
        </p>
        <div className="first-run-choices">
          {PERSONAS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={
                "first-run-choice" + (p.recommended ? " is-recommended" : "")
              }
              onClick={() => void choose(p.id)}
            >
              <span className="first-run-choice-icon" aria-hidden>
                <Icon name={p.icon} size={17} />
              </span>
              <span className="first-run-choice-body">
                <span className="first-run-choice-head">
                  <span className="first-run-choice-title">{p.title}</span>
                  {p.badge != null && (
                    <span className="first-run-choice-badge">{p.badge}</span>
                  )}
                </span>
                <span className="first-run-choice-copy">{p.copy}</span>
              </span>
            </button>
          ))}
        </div>
        {!forced && (
          <button
            type="button"
            className="first-run-skip"
            onClick={() => setStep("skip-confirm")}
          >
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

function QuickSetupStep({
  liveMetadataAvailable,
  directTorrentAvailable,
  onBack,
  onContinue,
}: {
  liveMetadataAvailable: boolean;
  directTorrentAvailable: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="first-run">
      <div className="first-run-card">
        <p className="first-run-eyebrow">Quick setup is not recommended</p>
        <h1 className="first-run-title">Continue without adding credentials</h1>
        <p className="first-run-sub">
          This route makes no signup, key acquisition, or key-validation request. It turns on the existing built-in public sources and keeps the simple profile experience. You can add your own credentials later in Settings.
        </p>
        <div className="first-run-hint">
          Public source services can see your device or server IP and the title identifiers being requested. They may be blocked, unavailable, incomplete, or wrong. A source result is not a safety check or a guarantee that playback will work.
        </div>
        <div className="first-run-hint">
          {liveMetadataAvailable
            ? "A catalog credential is already available, so live metadata, search, artwork, and episode details can work."
            : "No build-supplied catalog credential is available. Only the bundled sample catalog is available, and live search, current artwork, and episode details are limited."}
        </div>
        <p className="first-run-hint">
          OMDb is optional ratings enrichment. {directTorrentAvailable
            ? "The connected server explicitly enables Direct P2P, which still requires confirmation for each play."
            : "Direct P2P works only when a connected Server Mode server explicitly enables it. Otherwise playback still needs a debrid service."}
        </p>
        <label className="first-run-field first-run-quick-ack">
          <span>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{" "}
            I understand the privacy, reliability, catalog, and playback limits and want to use Quick setup.
          </span>
        </label>
        <div className="first-run-actions">
          <button type="button" className="first-run-secondary" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="first-run-primary"
            disabled={!acknowledged}
            onClick={onContinue}
          >
            Continue with Quick setup
          </button>
        </div>
      </div>
    </div>
  );
}

/** Two-dot progress rail for the device path (reuses the server-setup CSS). */
function DeviceProgress({ active }: { active: 1 | 2 }) {
  return (
    <ol className="server-setup-progress">
      <li
        className={
          "server-setup-progress-dot " + (active === 1 ? "is-active" : "is-done")
        }
      >
        <span className="server-setup-progress-num">1</span>
        <span className="server-setup-progress-label">Catalog</span>
      </li>
      <li
        className={
          "server-setup-progress-dot" + (active === 2 ? " is-active" : "")
        }
      >
        <span className="server-setup-progress-num">2</span>
        <span className="server-setup-progress-label">Streaming</span>
      </li>
    </ol>
  );
}

/** Device step 1 - the catalog keys. TMDB is the primary key (it alone
 *  provides posters, backdrops/banners, search, and the episode guide). OMDb
 *  is an OPTIONAL companion for IMDb / Rotten Tomatoes ratings - worth adding
 *  if you have an OMDb Patreon (premium) plan, though TMDB still supplies the
 *  artwork either way. Both fields are validated live; only the ones you fill
 *  are checked, and at least one catalog key is required to continue (the
 *  keyless built-in-catalog escape exists only when NOT forced). */
function CatalogStep({
  initialTmdb,
  initialOmdb,
  forced,
  onBack,
  onNext,
}: {
  initialTmdb: string;
  initialOmdb: string;
  forced: boolean;
  onBack: () => void;
  onNext: (key: CatalogKey | null) => void;
}) {
  const [tmdb, setTmdb] = useState(initialTmdb);
  const [omdb, setOmdb] = useState(initialOmdb);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tmdbSignup = signupUrl("tmdb");
  const omdbSignup = signupUrl("omdb");
  const tmdbVideo = setupVideoUrl("tmdb");
  const omdbVideo = setupVideoUrl("omdb");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const t = tmdb.trim();
    const o = omdb.trim();
    if (t.length === 0 && o.length === 0) {
      setError(
        "Add a catalog key to continue - TMDB (free) powers browsing, artwork & banners; OMDb adds richer ratings. Either one unlocks the app.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const next: CatalogKey = {};
    // Validate only the fields the user filled; a bad key blocks continuing and
    // names which one failed.
    if (t.length > 0) {
      const result = await testTmdbKey(t);
      if (result !== "ok") {
        setError(
          result === "unauthorized"
            ? "TMDB rejected that key - double-check it (use the v3 API key)."
            : "Couldn't reach TMDB - check your connection and try again.",
        );
        setBusy(false);
        return;
      }
      next.tmdbKey = t;
    }
    if (o.length > 0) {
      const result = await testOmdbKey(o);
      if (result !== "ok") {
        setError(
          result === "unauthorized"
            ? "OMDb rejected that key - double-check it (free keys need the activation link OMDb emails you)."
            : "Couldn't reach OMDb - check your connection and try again.",
        );
        setBusy(false);
        return;
      }
      next.omdbKey = o;
    }
    onNext(next);
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <DeviceProgress active={1} />
        <h1 className="first-run-title">Connect your catalog</h1>
        <p className="first-run-sub">
          Add a <b>TMDB</b> key for browsing, artwork &amp; banners, an <b>OMDb</b>{" "}
          key for richer IMDb / Rotten Tomatoes ratings, or both. Either one is
          enough to get started - both are free.
        </p>
        <form className="first-run-form" onSubmit={submit}>
          <label className="first-run-field">
            TMDB API key
            <input
              value={tmdb}
              onChange={(e) => setTmdb(e.target.value)}
              placeholder="v3 API key"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <div className="first-run-links">
            {tmdbSignup != null && (
              <a
                className="server-setup-signup"
                href={tmdbSignup}
                target="_blank"
                rel="noreferrer"
              >
                Get a free TMDB key ↗
              </a>
            )}
            {tmdbVideo != null && (
              <a
                className="server-setup-signup first-run-video"
                href={tmdbVideo}
                target="_blank"
                rel="noreferrer"
              >
                ▶ Watch setup guide
              </a>
            )}
          </div>

          <label className="first-run-field first-run-field-optional">
            <span className="first-run-field-label">
              OMDb API key
              <span className="first-run-optional-tag">Optional</span>
            </span>
            <input
              value={omdb}
              onChange={(e) => setOmdb(e.target.value)}
              placeholder="OMDb key - for IMDb & Rotten Tomatoes ratings"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="first-run-links">
            {omdbSignup != null && (
              <a
                className="server-setup-signup"
                href={omdbSignup}
                target="_blank"
                rel="noreferrer"
              >
                Get a free OMDb key ↗
              </a>
            )}
            {omdbVideo != null && (
              <a
                className="server-setup-signup first-run-video"
                href={omdbVideo}
                target="_blank"
                rel="noreferrer"
              >
                ▶ Watch setup guide
              </a>
            )}
          </div>
          <p className="first-run-hint">
            OMDb adds IMDb &amp; Rotten Tomatoes ratings. The free tier (1,000
            lookups/day) suits most homes; an OMDb Patreon plan raises the limit
            and is the richer ratings source - TMDB still supplies the artwork
            and banners either way.
          </p>

          {error != null && (
            <p className="first-run-error" role="alert">
              {error}
            </p>
          )}
          <div className="first-run-actions">
            <button type="button" className="first-run-secondary" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="first-run-primary" disabled={busy}>
              {busy ? "Testing…" : "Test keys & continue"}
            </button>
          </div>
        </form>
        {!forced && (
          <button
            type="button"
            className="first-run-escape"
            onClick={() => onNext(null)}
          >
            Continue with the built-in catalog (limited - no search artwork, no
            episode guide)
          </button>
        )}
        <p className="first-run-footnote">
          You can add or change either key any time in Settings → Keys.
        </p>
      </div>
    </div>
  );
}

/** Device step 2 - the streaming token. Passes with a verified debrid token,
 *  an explicit save-without-testing (debrid hosts are CORS-blocked in plain
 *  browsers, so a valid token can fail the live check), or the honest
 *  add-later escape. */
function StreamingStep({
  existing,
  forced,
  onBack,
  onDone,
}: {
  existing: DebridTokenEntry[];
  forced: boolean;
  onBack: () => void;
  onDone: (entry: DebridTokenEntry | null) => void;
}) {
  const seed = existing.length > 0 ? existing[0] : null;
  const [service, setService] = useState<DebridServiceType>(
    seed?.service ?? "real_debrid",
  );
  const [token, setToken] = useState(seed?.apiToken ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverifiedOk, setUnverifiedOk] = useState(false);

  const signup = signupUrl(DEBRID_SIGNUP_ID[service] ?? "");
  const setupVideo = setupVideoUrl(DEBRID_SIGNUP_ID[service] ?? "");

  // A failed check only vouches for the exact service+token it ran against - 
  // any edit hides the save-without-testing hatch until the user tests again.
  function changeService(next: DebridServiceType) {
    setService(next);
    setToken(existing.find((t) => t.service === next)?.apiToken ?? "");
    setUnverifiedOk(false);
    setError(null);
  }
  function changeToken(next: string) {
    setToken(next);
    setUnverifiedOk(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      setError(
        forced
          ? "Paste your API token - nothing can play without a debrid service."
          : "Paste your API token, or choose Add later.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await testDebridToken({ service, apiToken: trimmed });
    if (ok) {
      onDone({ service, apiToken: trimmed });
      return;
    }
    // Hedged on purpose: validateToken() can't distinguish a bad token from
    // an offline/CORS-blocked check.
    setError(
      "Couldn't verify that token - it may be mistyped, or your browser may be blocked from reaching the provider.",
    );
    setUnverifiedOk(true);
    setBusy(false);
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <DeviceProgress active={2} />
        <h1 className="first-run-title">Connect your debrid service</h1>
        <p className="first-run-sub">{CONCEPTS.debrid.blurb}</p>
        <form className="first-run-form" onSubmit={submit}>
          <div className="server-setup-fields">
            <label className="first-run-field">
              Provider
              <select
                value={service}
                onChange={(e) => changeService(e.target.value as DebridServiceType)}
              >
                {DebridServiceType.allCases().map((s) => (
                  <option key={s} value={s}>
                    {DebridServiceType.displayName(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="first-run-field">
              API token
              <input
                value={token}
                onChange={(e) => changeToken(e.target.value)}
                placeholder="API token"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            {signup != null && (
              <a
                className="server-setup-signup"
                href={signup}
                target="_blank"
                rel="noreferrer"
              >
                Get a {DebridServiceType.displayName(service)} token ↗
              </a>
            )}
            {setupVideo != null && (
              <a
                className="server-setup-signup first-run-video"
                href={setupVideo}
                target="_blank"
                rel="noreferrer"
              >
                ▶ Watch setup guide
              </a>
            )}
          </div>
          {error != null && (
            <p className="first-run-error" role="alert">
              {error}
            </p>
          )}
          <div className="first-run-actions">
            <button type="button" className="first-run-secondary" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="first-run-primary" disabled={busy}>
              {busy ? "Testing…" : "Test token & finish"}
            </button>
          </div>
          {unverifiedOk && (
            <button
              type="button"
              className="first-run-escape"
              onClick={() => onDone({ service, apiToken: token.trim() })}
            >
              Save without testing (the desktop app can reach providers a
              browser can't)
            </button>
          )}
        </form>
        {!forced && (
          <button
            type="button"
            className="first-run-escape"
            onClick={() => onDone(null)}
          >
            Add later - nothing will play until you do.
          </button>
        )}
      </div>
    </div>
  );
}

/** Honest confirmation before skipping the whole wizard. */
function SkipConfirmStep({
  onBack,
  onSkip,
}: {
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1 className="first-run-title">Skip setup?</h1>
        <div className="first-run-warn">
          Without a TMDB key, search and artwork are limited. Without a debrid
          token, nothing will play. You can add both any time in Settings →
          Keys.
        </div>
        <div className="first-run-actions">
          <button type="button" className="first-run-primary" onClick={onBack}>
            Go back
          </button>
          <button type="button" className="first-run-danger" onClick={onSkip}>
            Skip anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** Device step 3 (OPTIONAL) - AI recommendations. Never blocks onboarding:
 *  "Skip - add AI later" always completes. Cloud providers take an API key
 *  (with a working signup link); the local Ollama provider takes an endpoint.
 *  The provider list is data-driven, so new providers appear here for free. */
function AiStep({
  initialProvider,
  initialKey,
  initialOllamaEndpoint,
  onBack,
  onSkip,
  onSave,
}: {
  initialProvider: AIProviderKind;
  initialKey: string;
  initialOllamaEndpoint: string;
  onBack: () => void;
  onSkip: () => void;
  onSave: (ai: AiChoice) => void;
}) {
  const [provider, setProvider] = useState<AIProviderKind>(initialProvider);
  const [apiKey, setApiKey] = useState(initialKey);
  const [endpoint, setEndpoint] = useState(
    initialOllamaEndpoint.trim().length > 0
      ? initialOllamaEndpoint
      : "http://localhost:11434",
  );
  const isLocal = provider === AIProviderKind.ollama;
  const signup = signupUrl(AI_SIGNUP_ID[provider] ?? "");
  const canSave = isLocal
    ? endpoint.trim().length > 0
    : apiKey.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) {
      onSkip();
      return;
    }
    onSave(
      isLocal
        ? { provider, ollamaEndpoint: endpoint.trim() }
        : { provider, apiKey: apiKey.trim() },
    );
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <p className="first-run-eyebrow">
          <Icon name="sparkles" size={13} />
          Optional
        </p>
        <h1 className="first-run-title">Add AI recommendations</h1>
        <p className="first-run-sub">
          Describe a vibe for a curated lineup and get a “would I like this?”
          take on any title. Bring your own key, or point it at a local model - 
          change this any time in Settings.
        </p>
        <form className="first-run-form" onSubmit={submit}>
          <div className="server-setup-fields">
            <label className="first-run-field">
              Provider
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as AIProviderKind)}
              >
                {AIProviderKind.allCases().map((p) => (
                  <option key={p} value={p}>
                    {AIProviderKind.displayName(p)}
                    {p === AIProviderKind.ollama ? " - local" : ""}
                  </option>
                ))}
              </select>
            </label>
            {isLocal ? (
              <label className="first-run-field">
                Ollama endpoint
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="http://localhost:11434"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ) : (
              <label className="first-run-field">
                API key
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="API key"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </label>
            )}
            {signup != null && !isLocal && (
              <a
                className="server-setup-signup"
                href={signup}
                target="_blank"
                rel="noreferrer"
              >
                Get an {AIProviderKind.displayName(provider)} key ↗
              </a>
            )}
          </div>
          <div className="first-run-actions">
            <button type="button" className="first-run-secondary" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="first-run-primary" disabled={!canSave}>
              Save &amp; finish
            </button>
          </div>
        </form>
        <button type="button" className="first-run-escape" onClick={onSkip}>
          Skip - add AI later
        </button>
      </div>
    </div>
  );
}

function ConnectStep({ onBack }: { onBack: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (url.trim().length === 0) {
      setError("Enter your server address.");
      return;
    }
    const destination = normalizeServerDestination(url);
    if (destination == null) {
      setError(
        "Enter a valid server address or invite link. Only HTTP and HTTPS are supported.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Mark complete before leaving so returning to Local Mode later does not
      // re-trigger the wizard. Persist the destination ORIGIN as the followed
      // server too, so the next cold boot goes straight back to it instead of
      // asking for the address again. (Origin only: an invite URL's token is
      // single-use, so following the full URL would loop on a dead link.)
      await markOnboardingComplete();
      try {
        saveServerURL(new URL(destination).origin, { follow: true });
      } catch {
        saveServerURL(destination, { follow: true });
      }
      globalThis.location.assign(destination);
    } catch {
      setError("Couldn't open that server. Check the address and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1 className="first-run-title">Connect to a server</h1>
        <p className="first-run-sub">
          Paste the server address or full invite link. It will open here so you
          can sign in on the server.
        </p>
        <form className="first-run-form" onSubmit={submit}>
          <label className="first-run-field">
            Server address
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://stream.example.com"
              autoComplete="url"
              inputMode="url"
              autoFocus
            />
          </label>
          {error != null && (
            <p className="first-run-error" role="alert">
              {error}
            </p>
          )}
          <div className="first-run-actions">
            <button type="button" className="first-run-secondary" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="first-run-primary" disabled={busy}>
              {busy ? "Opening…" : "Open server"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function HostStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const desktop = isTauri();
  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1 className="first-run-title">Host for your household</h1>
        <p className="first-run-sub">
          {desktop
            ? "This computer can serve YAWF Stream to your other devices. Open Settings → Install & setup to start hosting and get a link + QR code to share."
            : "Hosting runs in the released macOS and Linux desktop apps or via Docker on a server. Windows remains held until its signing gate passes."}
        </p>
        <div className="first-run-actions">
          <button type="button" className="first-run-secondary" onClick={onBack}>
            Back
          </button>
          <button type="button" className="first-run-primary" onClick={onContinue}>
            Open Settings
          </button>
        </div>
      </div>
    </div>
  );
}
