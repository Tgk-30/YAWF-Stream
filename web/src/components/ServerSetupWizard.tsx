// Server first-run setup wizard (Server Mode, owner only). Guides a freshly
// deployed server through the steps the owner still has to do AFTER the
// setup-owner account is created (ServerModeGate handles that part):
//
//   welcome → API keys → access (Tailscale/Cloudflare) → invite household → done
//
// It drives the SAME endpoints the Settings → Server tab already uses, via the
// thin serverApi helpers (saveServerSharedCredential / createServerInvite), so
// there's one source of truth for credential + invite saves. Completion is
// recorded with the existing onboarding flag (markServerSetupComplete), and the
// owner can skip at any time. Mounted by FirstRunHost when shouldShowServerSetup
// resolves true. Styling reuses the persona wizard's .first-run* classes plus a
// few server-setup additions in FirstRunWizard.css.

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  saveServerSharedCredential,
  createServerInvite,
  type ServerCredentialProvider,
} from "../lib/serverApi";
import { configuredServerURL } from "../lib/serverMode";
import { markServerSetupComplete } from "../lib/serverSetup";
import { signupUrl } from "../data/onboardingHelp";
import {
  DEBRID_PROVIDER_OPTIONS,
  DEFAULT_DEBRID_PROVIDER,
  SERVER_SETUP_KEY_FIELDS,
  buildServerSetupCredentialDrafts,
  debridProviderOption,
  type DebridCredentialProvider,
} from "../lib/serverSetupCredentials";
import {
  DEFAULT_SERVER_SETUP_INVITE_PRESET_ID,
  SERVER_SETUP_INVITE_PRESETS,
  serverSetupInvitePreset,
  type ServerSetupInvitePresetId,
} from "../lib/serverSetupInvite";
import {
  SERVER_SETUP_STEPS,
  SERVER_SETUP_STEP_LABELS,
  isFinalStep,
  nextStep,
  previousStep,
  stepIndex,
  type ServerSetupStep,
} from "../lib/serverSetupSteps";
import "./FirstRunWizard.css";

// Maps a credential-provider value (from serverSetupCredentials) to its
// onboardingHelp signup-link id, so each key field can point at where to get it.
const CREDENTIAL_SIGNUP_ID: Record<string, string> = {
  tmdb: "tmdb",
  opensubtitles: "openSubtitles",
  real_debrid: "realDebrid",
  torbox: "torbox",
  premiumize: "premiumize",
  all_debrid: "allDebrid",
};

/** A small "where do I get this?" external link for a credential field, or null
 * when we don't have a signup page for that provider (e.g. OpenAI). */
function SignupLink({ provider }: { provider: string }) {
  const url = signupUrl(CREDENTIAL_SIGNUP_ID[provider] ?? "");
  if (url == null) return null;
  return (
    <a
      className="server-setup-signup"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      Where do I get this? ↗
    </a>
  );
}

interface ServerSetupWizardProps {
  /** Called when the owner finishes or skips. The host hides the wizard. */
  onDone: () => void;
}

export function ServerSetupWizard({ onDone }: ServerSetupWizardProps) {
  const [step, setStep] = useState<ServerSetupStep>("welcome");
  const [completionBusy, setCompletionBusy] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const completionPending = useRef(false);

  async function finish() {
    if (completionPending.current) return;
    completionPending.current = true;
    setCompletionBusy(true);
    setCompletionError(null);
    try {
      await markServerSetupComplete();
    } catch {
      completionPending.current = false;
      setCompletionBusy(false);
      setCompletionError(
        "We couldn't record that server setup is complete. Retry so setup does not appear again on the next launch.",
      );
      return;
    }
    completionPending.current = false;
    setCompletionBusy(false);
    onDone();
  }

  function goNext() {
    const next = nextStep(step);
    if (next != null) setStep(next);
  }
  function goBack() {
    const prev = previousStep(step);
    if (prev != null) setStep(prev);
  }

  return (
    <div className="first-run">
      <div className="first-run-card server-setup-card">
        {!isFinalStep(step) && completionError == null && (
          <button
            type="button"
            className="first-run-skip"
            onClick={() => void finish()}
            disabled={completionBusy}
          >
            {completionBusy ? "Saving..." : "Skip setup"}
          </button>
        )}

        <SetupProgress current={step} />

        {completionError != null ? (
          <CompletionRetryStep
            error={completionError}
            busy={completionBusy}
            onRetry={() => void finish()}
          />
        ) : (
          <>
            {step === "welcome" && <WelcomeStep onContinue={goNext} />}
            {step === "keys" && <KeysStep onBack={goBack} onContinue={goNext} />}
            {step === "access" && (
              <AccessStep onBack={goBack} onContinue={goNext} />
            )}
            {step === "invite" && (
              <InviteStep onBack={goBack} onContinue={goNext} />
            )}
            {step === "done" && (
              <DoneStep
                onFinish={() => void finish()}
                completionBusy={completionBusy}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CompletionRetryStep({
  error,
  busy,
  onRetry,
}: {
  error: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      <h1 className="first-run-title">Finish saving setup</h1>
      <p className="first-run-error" role="alert">
        {error}
      </p>
      <div className="first-run-actions">
        <button
          type="button"
          className="first-run-primary"
          onClick={onRetry}
          disabled={busy}
        >
          {busy ? "Retrying..." : "Retry saving setup"}
        </button>
      </div>
    </>
  );
}

/** Step rail showing the four setup phases + the finish marker. */
function SetupProgress({ current }: { current: ServerSetupStep }) {
  const currentIndex = stepIndex(current);
  return (
    <ol className="server-setup-progress" aria-label="Setup progress">
      {SERVER_SETUP_STEPS.map((step, index) => (
        <li
          key={step}
          className={`server-setup-progress-dot${
            index < currentIndex ? " is-done" : index === currentIndex ? " is-active" : ""
          }`}
        >
          <span className="server-setup-progress-num">{index + 1}</span>
          <span className="server-setup-progress-label">
            {SERVER_SETUP_STEP_LABELS[step]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <h1 className="first-run-title">Your server is live</h1>
      <p className="first-run-sub">
        Nice - the owner account is set up. A few quick steps and your household
        can sign in from any device. You can skip and do all of this later in
        Settings → Server.
      </p>
      <ul className="server-setup-list">
        <li>Add API keys so the catalog and streams work.</li>
        <li>Get a shareable URL so devices off your network can reach it.</li>
        <li>Invite the people in your household with their own profiles.</li>
      </ul>
      <div className="first-run-actions">
        <button type="button" className="first-run-primary" onClick={onContinue}>
          Get started
        </button>
      </div>
    </>
  );
}

/** API-keys step. Saves each non-empty field through the SHARED credential PUT
 *  (the same path the Server tab uses), so they apply server-wide. Empty fields
 *  are skipped. Failures are surfaced but never block continuing - the owner can
 *  finish a key later in Settings. */
function KeysStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [debridProvider, setDebridProvider] =
    useState<DebridCredentialProvider>(DEFAULT_DEBRID_PROVIDER);
  const [debridToken, setDebridToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  function setValue(provider: ServerCredentialProvider, value: string) {
    setValues((current) => ({ ...current, [provider]: value }));
    setError(null);
    setSavedCount(null);
  }

  async function saveAndContinue() {
    const pending = buildServerSetupCredentialDrafts({
      debridProvider,
      debridToken,
      values,
    });

    if (pending.length === 0) {
      // Nothing entered - let the owner move on and add keys later.
      onContinue();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let saved = 0;
      for (const entry of pending) {
        await saveServerSharedCredential({
          provider: entry.provider,
          label: entry.label,
          value: entry.value,
        });
        saved += 1;
      }
      setSavedCount(saved);
      onContinue();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't save a key (${err.message}). You can finish it later in Settings.`
          : "Couldn't save a key.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="first-run-title">Add your API keys</h1>
      <p className="first-run-sub">
        These are stored as shared server credentials, so every profile uses
        them. Add what you have now - TMDB and one debrid provider are the
        essentials.
      </p>
      <div className="server-setup-fields">
        <div className="server-setup-provider-row">
          <label className="first-run-field">
            Debrid provider
            <select
              value={debridProvider}
              onChange={(event) => {
                setDebridProvider(event.target.value as DebridCredentialProvider);
                setError(null);
                setSavedCount(null);
              }}
            >
              {DEBRID_PROVIDER_OPTIONS.map((option) => (
                <option key={option.provider} value={option.provider}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="server-setup-field-hint">
              Choose the provider whose token you want every profile to use.
            </span>
          </label>
          <label className="first-run-field">
            Debrid token
            <input
              type="password"
              value={debridToken}
              onChange={(event) => {
                setDebridToken(event.target.value);
                setError(null);
                setSavedCount(null);
              }}
              placeholder={debridProviderOption(debridProvider).placeholder}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="server-setup-field-hint">
              Cached stream resolving works best after this is saved.
            </span>
            <SignupLink provider={debridProvider} />
          </label>
        </div>
        {SERVER_SETUP_KEY_FIELDS.map((field) => (
          <label key={field.provider} className="first-run-field">
            {field.label}
            <input
              type="password"
              value={values[field.provider] ?? ""}
              onChange={(event) => setValue(field.provider, event.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="server-setup-field-hint">{field.hint}</span>
            <SignupLink provider={field.provider} />
          </label>
        ))}
      </div>
      {error != null && <p className="first-run-error">{error}</p>}
      {savedCount != null && (
        <p className="server-setup-ok">Saved {savedCount} key{savedCount === 1 ? "" : "s"}.</p>
      )}
      <div className="first-run-actions">
        <button type="button" className="first-run-secondary" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="first-run-primary"
          onClick={() => void saveAndContinue()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </>
  );
}

/** Access step. Static guidance that points at the in-app Tailscale/Cloudflare
 *  guide (Settings → Server) for exposing the server off the local network. */
function AccessStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const baseURL = configuredServerURL();
  return (
    <>
      <h1 className="first-run-title">Make it reachable</h1>
      <p className="first-run-sub">
        Right now the server is on{" "}
        {baseURL != null ? <code>{baseURL}</code> : "your local network"}.{" "}
        <strong>Only watching on your home Wi-Fi? You can skip this.</strong> To
        also use it from phones and tablets <em>away</em> from home, expose it
        with a tunnel - no ports to open, traffic stays encrypted.
      </p>
      <div className="server-setup-access">
        <a
          className="server-setup-access-card"
          href="https://tailscale.com/kb/1223/funnel"
          target="_blank"
          rel="noreferrer"
        >
          <strong>Tailscale</strong>
          <span>
            Private mesh between your own devices, plus Funnel for a public
            HTTPS URL. Easiest for a household.
          </span>
        </a>
        <a
          className="server-setup-access-card"
          href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
          target="_blank"
          rel="noreferrer"
        >
          <strong>Cloudflare Tunnel</strong>
          <span>
            A stable public hostname on your own domain, with Cloudflare in
            front. Good if you already use Cloudflare.
          </span>
        </a>
      </div>
      <p className="server-setup-note">
        The full step-by-step for both, and where to paste the resulting URL,
        lives in <strong>Settings → Server → Remote access</strong>. You can
        finish this anytime.
      </p>
      <div className="first-run-actions">
        <button type="button" className="first-run-secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="first-run-primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </>
  );
}

/** Invite step. Creates a household invite through the SAME POST the Server tab
 *  uses, builds the shareable ?invite= URL, and renders a QR for phones. */
function InviteStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const [invitePresetId, setInvitePresetId] = useState<ServerSetupInvitePresetId>(
    DEFAULT_SERVER_SETUP_INVITE_PRESET_ID,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteURL, setInviteURL] = useState<string | null>(null);
  const [qrDataURL, setQrDataURL] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const invitePreset = serverSetupInvitePreset(invitePresetId);
  // Guards the async invite/QR setState calls: the user can click Back/Skip (or
  // the wizard can close) while createServerInvite / QRCode.toDataURL are still
  // in flight, and updating state after unmount warns under StrictMode and can
  // crash the walkthrough.
  const mounted = useRef(true);
  useEffect(() => {
    // Set true in the SETUP body (not just false in cleanup): StrictMode runs
    // mount → cleanup → mount again, so a cleanup-only ref would be stuck false
    // after the dev double-invoke and freeze the step on "Creating…".
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await createServerInvite({
        label: invitePreset.inviteLabel,
        role: "member",
        simpleMode: invitePreset.simpleMode,
        maxUses: 5,
        expiresInSeconds: 7 * 24 * 60 * 60,
      });
      const base = configuredServerURL() ?? window.location.origin;
      const url = new URL(base);
      url.searchParams.set("invite", result.token);
      const built = url.toString();
      if (!mounted.current) return;
      setInviteURL(built);
      // Render a QR a phone can scan to open the invite link directly. The
      // promise can resolve after the step unmounts, so guard the setState.
      QRCode.toDataURL(built, {
        width: 168,
        margin: 1,
        color: { dark: "#111827", light: "#ffffff" },
      })
        .then((data) => {
          if (mounted.current) setQrDataURL(data);
        })
        .catch(() => {
          if (mounted.current) setQrDataURL(null);
        });
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Couldn't create the invite.");
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function copy() {
    if (inviteURL == null) return;
    try {
      await navigator.clipboard.writeText(inviteURL);
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current) setError("Clipboard is unavailable in this session.");
    }
  }

  return (
    <>
      <h1 className="first-run-title">Invite your household</h1>
      <p className="first-run-sub">
        Create a link anyone in your home can open to make their own profile.
        They land in Simple mode by default; you can change roles later in
        Settings → Server.
      </p>
      {inviteURL == null ? (
        <div className="server-setup-fields">
          <label className="first-run-field">
            Invite preset
            <select
              value={invitePresetId}
              onChange={(event) => {
                setInvitePresetId(event.target.value as ServerSetupInvitePresetId);
                setError(null);
              }}
              autoFocus
            >
              {SERVER_SETUP_INVITE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="server-setup-field-hint">
              {invitePreset.description}
            </span>
          </label>
          <div className="server-setup-preset-summary" aria-live="polite">
            <span>{invitePreset.inviteLabel}</span>
            <strong>{invitePreset.simpleMode ? "Simple mode" : "Full interface"}</strong>
          </div>
        </div>
      ) : (
        <div className="server-setup-invite-result">
          {qrDataURL != null && (
            <img
              className="server-setup-qr"
              src={qrDataURL}
              alt="QR code that opens the household invite link"
            />
          )}
          <div className="server-setup-invite-copy">
            <span className="server-setup-field-hint">
              Share this link, or have someone scan the code:
            </span>
            <code className="server-setup-invite-url">{inviteURL}</code>
            <button type="button" className="first-run-secondary" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}
      {error != null && <p className="first-run-error">{error}</p>}
      <div className="first-run-actions">
        <button type="button" className="first-run-secondary" onClick={onBack}>
          Back
        </button>
        {inviteURL == null ? (
          <button
            type="button"
            className="first-run-primary"
            onClick={() => void create()}
            disabled={busy}
          >
            {busy ? "Creating…" : "Create invite"}
          </button>
        ) : (
          <button type="button" className="first-run-primary" onClick={onContinue}>
            Continue
          </button>
        )}
      </div>
      {inviteURL == null && (
        <button
          type="button"
          className="server-setup-skip-inline"
          onClick={onContinue}
        >
          Skip - I'll invite people later
        </button>
      )}
    </>
  );
}

function DoneStep({
  onFinish,
  completionBusy,
}: {
  onFinish: () => void;
  completionBusy: boolean;
}) {
  // A tiny recap so the owner knows where to pick each thing back up.
  const links = useMemo(
    () => [
      "Add or change API keys in Settings → API keys / Providers.",
      "Manage profiles and invites in Settings → Server.",
      "Find the Tailscale / Cloudflare guide in Settings → Server → Remote access.",
    ],
    [],
  );
  return (
    <>
      <h1 className="first-run-title">You're all set</h1>
      <p className="first-run-sub">
        Your server is ready to stream. Everything here can be revisited from
        Settings whenever you need it.
      </p>
      <ul className="server-setup-list">
        {links.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="first-run-actions">
        <button
          type="button"
          className="first-run-primary"
          onClick={onFinish}
          disabled={completionBusy}
        >
          {completionBusy ? "Saving..." : "Open YAWF Stream"}
        </button>
      </div>
    </>
  );
}
