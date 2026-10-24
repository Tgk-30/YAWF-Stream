// "Who's watching?" picker (Server Mode only).
//
// A full-screen overlay listing the account's household sub-profiles. Selecting
// one calls POST /api/profiles/switch, then re-hydrates the app store so the new
// profile's watchlist / history / settings replace the previous profile's. An
// edit mode exposes add / rename / delete (the default profile can't be deleted,
// and an account always keeps at least one).
//
// Mirrors the store + serverApi patterns: all network calls go through the
// serverApi helpers (which attach credentials + the CSRF header), and the
// session/profile context holds the in-memory truth the rest of the app reads.

import { useEffect, useMemo, useState } from "react";
import {
  createAccountProfile,
  deleteAccountProfile,
  fetchAccountProfiles,
  setProfileBandwidthQuota,
  setProfilePin,
  setProfilePassword,
  switchAccountProfile,
  updateAccountProfile,
  type AccountProfile,
} from "../lib/serverApi";
import {
  useServerProfiles,
  useServerSession,
  useSetServerProfiles,
  useSetServerSession,
  type ServerProfileSummary,
} from "../lib/ServerSessionContext";
import { useAppActions } from "../store/AppStore";
import { PROFILE_COLORS } from "../data/profileAvatars";
import { useModalA11y } from "./useModalA11y";
import "./ProfilePicker.css";

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** Avatar = the display-name initial on the profile's color tint. */
function Avatar({ profile, size = 96 }: { profile: ServerProfileSummary; size?: number }) {
  const bg = profile.avatarColor ?? "#475569";
  return (
    <span
      className="profile-avatar"
      style={{ background: bg, width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden
    >
      {initialOf(profile.displayName)}
    </span>
  );
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

function bandwidthSummary(profile: ServerProfileSummary): string {
  const usage = formatBytes(profile.bandwidthUsageBytes ?? 0);
  if (profile.bandwidthCapBytes == null) return `${usage} this month · No cap`;
  const status = profile.bandwidthStatus ?? "ok";
  const label = status === "over" ? "Over cap" : status === "approaching" ? "Approaching cap" : "Within cap";
  return `${usage} of ${formatBytes(profile.bandwidthCapBytes)} · ${label}`;
}

export function ProfilePicker({ onClose }: { onClose: () => void }) {
  const session = useServerSession();
  const profiles = useServerProfiles();
  const setSession = useSetServerSession();
  const setProfiles = useSetServerProfiles();
  const { reloadProfileData } = useAppActions();
  const pickerRef = useModalA11y<HTMLDivElement>(onClose);

  const [editing, setEditing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [publicMode, setPublicMode] = useState(false);
  const [renaming, setRenaming] = useState<AccountProfile | null>(null);
  // The profile id awaiting delete confirmation (two-step: Delete → Confirm).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // When set, the parental-lock prompt is open for this target profile: leaving
  // a kid profile requires the account password before the switch is allowed.
  const [unlocking, setUnlocking] = useState<ServerProfileSummary | null>(null);
  // PIN entry is distinct from the existing parental account-password prompt:
  // this is the PIN on the profile the viewer is ENTERING.
  const [pinUnlocking, setPinUnlocking] = useState<ServerProfileSummary | null>(null);
  const [pinFor, setPinFor] = useState<ServerProfileSummary | null>(null);
  const [passwordFor, setPasswordFor] = useState<ServerProfileSummary | null>(null);
  const [quotaFor, setQuotaFor] = useState<ServerProfileSummary | null>(null);

  const activeId = session?.profileId ?? null;
  // Is the CURRENTLY ACTIVE profile a kid? Leaving it (switching to a different
  // profile) needs the account password; entering one, or no-op re-selects, do not.
  const activeIsKid = useMemo(
    () => profiles.some((p) => p.id === activeId && p.isKid),
    [profiles, activeId],
  );
  const isHouseholdManager = session?.role === "owner" || session?.role === "admin";

  function canManagePin(profile: ServerProfileSummary): boolean {
    return isHouseholdManager || profile.id === activeId;
  }

  /** Permanently delete a profile (after the inline two-step confirm). */
  function performDelete(profileId: string) {
    setConfirmDeleteId(null);
    setError(null);
    setBusyId(profileId);
    const wasActive = profileId === activeId;
    void deleteAccountProfile(profileId)
      .then(async (res) => {
        // The delete already succeeded server-side: refresh the list FIRST so
        // the deleted tile is dropped even if the follow-up switch fails.
        await refreshAfterMutation(res.profiles);
        if (wasActive) {
          // Converge the client onto the server's fallback (default) profile so
          // it isn't left pointed at a now-deleted one. Any failure here is
          // isolated: the delete stands and the next load reconciles the
          // session, so we must NOT surface "Could not delete.".
          const fallback =
            res.profiles.find((p) => p.isDefault) ?? res.profiles[0];
          if (fallback != null) {
            try {
              const sw = await switchAccountProfile(fallback.id);
              await reloadProfileData();
              if (sw.session != null) {
                setSession({
                  profileId: sw.session.profileId,
                  username: sw.session.username,
                  displayName: sw.session.displayName,
                  role: sw.session.role,
                  avatarColor: sw.session.avatarColor,
                  simpleMode: sw.session.simpleMode,
                  isKid: sw.session.isKid ?? fallback.isKid,
                });
              }
            } catch {
              // Convergence-only failure; delete still stands.
            }
          }
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not delete."),
      )
      .finally(() => setBusyId(null));
  }

  // Refresh the list from the server on open so a profile added on another
  // device shows up. Best-effort; the in-memory list is the fallback.
  useEffect(() => {
    let cancelled = false;
    void fetchAccountProfiles()
      .then((state) => {
        if (!cancelled) {
          setProfiles(state.profiles);
          setPublicMode(state.publicMode === true);
        }
      })
      .catch(() => {
        /* keep the in-memory list */
      });
    return () => {
      cancelled = true;
    };
  }, [setProfiles]);

  function selectProfile(profile: ServerProfileSummary) {
    if (busyId != null) return;
    // Already active → just close (selecting your current profile is a no-op).
    if (profile.id === activeId) {
      onClose();
      return;
    }
    // A PIN on the TARGET profile is a household gate for entering it. Prompt
    // before switching so a 403 can be retried without closing the picker.
    if (profile.hasPin === true && profile.gateType === "password") {
      setError(null);
      setUnlocking(profile);
      return;
    }
    if (profile.hasPin === true) {
      setError(null);
      setPinUnlocking(profile);
      return;
    }
    // Parental lock: leaving a kid profile for a DIFFERENT one needs the account
    // password. Prompt for it instead of switching straight away.
    if (activeIsKid) {
      setError(null);
      setUnlocking(profile);
      return;
    }
    void runSwitch(profile).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not switch profile.");
    });
  }

  /** Perform the actual profile switch. `password` is passed through only for the
   *  parental-lock path (leaving a kid profile); a wrong/missing one 403s. The
   *  promise rejects on failure so callers can surface the error (inline, or as
   *  "Incorrect password" in the unlock prompt) and retry. */
  async function runSwitch(
    profile: ServerProfileSummary,
    password?: string,
  ): Promise<void> {
    setBusyId(profile.id);
    setError(null);
    try {
      const result = await switchAccountProfile(profile.id, password);
      // Load the new profile's data BEFORE flipping the UI session. If the
      // refetch fails we stay on the old profile (the catch re-throws), instead
      // of leaving the new - possibly kid - session over the old profile's
      // already-rendered (possibly over-cap) rails. The server has already
      // switched the session cookie, so these loaders return the new profile's data.
      await reloadProfileData();
      if (result.session != null) {
        setSession({
          profileId: result.session.profileId,
          username: result.session.username,
          displayName: result.session.displayName,
          role: result.session.role,
          avatarColor: result.session.avatarColor,
          simpleMode: result.session.simpleMode,
          isKid: result.session.isKid ?? profile.isKid,
        });
      }
      if (result.profiles != null) setProfiles(result.profiles.profiles);
      onClose();
    } catch (err) {
      setBusyId(null);
      throw err;
    }
  }

  async function refreshAfterMutation(next: ServerProfileSummary[]): Promise<void> {
    setProfiles(next);
  }

  if (adding) {
    return (
      <ProfileForm
        title="Add profile"
        submitLabel="Create"
        requirePassword={publicMode}
        onCancel={() => setAdding(false)}
        onSubmit={async (values) => {
          const res = await createAccountProfile(values);
          // Append the new one and re-fetch to stay canonical.
          await refreshAfterMutation([
            ...profiles,
            {
              id: res.profile.id,
              displayName: res.profile.displayName,
              avatarColor: res.profile.avatarColor,
              simpleMode: res.profile.simpleMode,
              isDefault: res.profile.isDefault,
              isKid: res.profile.isKid,
              hasPin: res.profile.hasPin,
              gateType: res.profile.gateType,
              bandwidthCapBytes: null,
              bandwidthUsageBytes: 0,
              bandwidthStatus: "ok",
            },
          ]);
          setAdding(false);
        }}
      />
    );
  }

  if (renaming != null) {
    return (
      <ProfileForm
        title="Edit profile"
        submitLabel="Save"
        initial={{ displayName: renaming.displayName, avatarColor: renaming.avatarColor }}
        hidePassword
        onCancel={() => setRenaming(null)}
        onSubmit={async (values) => {
          const res = await updateAccountProfile(renaming.id, {
            displayName: values.displayName,
            avatarColor: values.avatarColor,
          });
          await refreshAfterMutation(res.profiles);
          setRenaming(null);
        }}
      />
    );
  }

  if (unlocking != null) {
    return (
      <UnlockPrompt
        target={unlocking}
        onCancel={() => setUnlocking(null)}
        onSubmit={(password) => runSwitch(unlocking, password)}
      />
    );
  }

  if (pinUnlocking != null) {
    return (
      <PinUnlockPrompt
        target={pinUnlocking}
        onCancel={() => setPinUnlocking(null)}
        onSubmit={(pin) => runSwitch(pinUnlocking, pin)}
      />
    );
  }

  if (pinFor != null) {
    return (
      <PinSettingsForm
        target={pinFor}
        changing={pinFor.hasPin === true}
        onCancel={() => setPinFor(null)}
        onSubmit={async (pin) => {
          const result = await setProfilePin(pinFor.id, pin);
          await refreshAfterMutation(result.profiles.profiles);
          setPinFor(null);
        }}
      />
    );
  }

  if (passwordFor != null) {
    return (
      <PasswordSettingsForm
        target={passwordFor}
        onCancel={() => setPasswordFor(null)}
        onSubmit={async (password) => {
          const result = await setProfilePassword(passwordFor.id, password);
          await refreshAfterMutation(result.profiles.profiles);
          setPasswordFor(null);
        }}
      />
    );
  }

  if (quotaFor != null) {
    return (
      <QuotaSettingsForm
        target={quotaFor}
        onCancel={() => setQuotaFor(null)}
        onSubmit={async (capBytes) => {
          const result = await setProfileBandwidthQuota(quotaFor.id, capBytes);
          await refreshAfterMutation(result.profiles.profiles);
          setQuotaFor(null);
        }}
      />
    );
  }

  return (
    <div
      ref={pickerRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Who's watching?"
      tabIndex={-1}
    >
      <div className="profile-picker-inner">
        <h1 className="profile-picker-title">Who&rsquo;s watching?</h1>

        <ul className="profile-grid">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <button
                type="button"
                className={`profile-tile${profile.id === activeId ? " is-active" : ""}`}
                onClick={() => void selectProfile(profile)}
                disabled={busyId != null}
                aria-current={profile.id === activeId ? "true" : undefined}
              >
                <Avatar profile={profile} />
                <span className="profile-tile-name">
                  {profile.displayName}
                  {profile.hasPin === true && (
                    <span className="profile-lock-glyph" aria-label="PIN protected" role="img">
                      {" \u{1F512}"}
                    </span>
                  )}
                </span>
                {profile.isKid && <span className="profile-kids-badge">Kids</span>}
                {busyId === profile.id && <span className="profile-tile-busy">Switching…</span>}
              </button>
              {editing && (
                <div className="profile-tile-actions">
                  <button
                    type="button"
                    className="profile-mini-btn"
                    onClick={() => setRenaming(profileToAccount(profile))}
                  >
                    Edit
                  </button>
                  {canManagePin(profile) && (
                    <>
                      <button
                        type="button"
                        className="profile-mini-btn"
                        onClick={() => setPinFor(profile)}
                        disabled={busyId != null}
                        aria-label={`${profile.hasPin ? "Change" : "Set"} PIN for ${profile.displayName}`}
                      >
                        {profile.hasPin ? "Change PIN" : "Set PIN"}
                      </button>
                      {profile.hasPin === true && (
                        <button
                          type="button"
                          className="profile-mini-btn"
                          disabled={busyId != null}
                          aria-label={`Remove PIN for ${profile.displayName}`}
                          onClick={() => {
                            setError(null);
                            setBusyId(profile.id);
                            void setProfilePin(profile.id, null)
                              .then((result) => refreshAfterMutation(result.profiles.profiles))
                              .catch((err) =>
                                setError(err instanceof Error ? err.message : "Could not remove PIN."),
                              )
                              .finally(() => setBusyId(null));
                          }}
                        >
                          Remove PIN
                        </button>
                      )}
                    </>
                  )}
                  {isHouseholdManager && (
                    <>
                      <button
                        type="button"
                        className="profile-mini-btn"
                        onClick={() => setPasswordFor(profile)}
                        disabled={busyId != null}
                      >
                        {profile.gateType === "password" ? "Change password" : "Set password"}
                      </button>
                      <button
                        type="button"
                        className="profile-mini-btn"
                        onClick={() => setQuotaFor(profile)}
                        disabled={busyId != null}
                        aria-label={`${profile.bandwidthCapBytes != null ? "Change" : "Set"} monthly cap for ${profile.displayName}`}
                      >
                        {profile.bandwidthCapBytes != null ? "Change cap" : "Set cap"}
                      </button>
                      {profile.bandwidthCapBytes != null && (
                        <button
                          type="button"
                          className="profile-mini-btn"
                          disabled={busyId != null}
                          aria-label={`Clear monthly cap for ${profile.displayName}`}
                          onClick={() => {
                            setError(null);
                            setBusyId(profile.id);
                            void setProfileBandwidthQuota(profile.id, null)
                              .then((result) => refreshAfterMutation(result.profiles.profiles))
                              .catch((err) =>
                                setError(err instanceof Error ? err.message : "Could not clear monthly cap."),
                              )
                              .finally(() => setBusyId(null));
                          }}
                        >
                          Clear cap
                        </button>
                      )}
                      <span className={`profile-bandwidth-status is-${profile.bandwidthStatus ?? "ok"}`}>
                        {bandwidthSummary(profile)}
                      </span>
                    </>
                  )}
                  {!profile.isDefault &&
                    (confirmDeleteId === profile.id ? (
                      <span className="profile-confirm-delete" role="group" aria-label={`Delete ${profile.displayName}?`}>
                        <button
                          type="button"
                          className="profile-mini-btn is-danger"
                          onClick={() => performDelete(profile.id)}
                          disabled={busyId != null}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="profile-mini-btn"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="profile-mini-btn is-danger"
                        onClick={() => setConfirmDeleteId(profile.id)}
                        aria-label={`Delete ${profile.displayName}`}
                      >
                        Delete
                      </button>
                    ))}
                </div>
              )}
            </li>
          ))}

          {editing && (
            <li>
              <button
                type="button"
                className="profile-tile profile-tile-add"
                onClick={() => {
                  setError(null);
                  setAdding(true);
                }}
              >
                <span className="profile-avatar profile-avatar-add" aria-hidden>
                  +
                </span>
                <span className="profile-tile-name">Add profile</span>
              </button>
            </li>
          )}
        </ul>

        {error != null && <p className="profile-picker-error">{error}</p>}

        <div className="profile-picker-foot">
          <button
            type="button"
            className="profile-text-btn"
            onClick={() => {
              setEditing((value) => !value);
              setConfirmDeleteId(null); // drop any pending confirm when toggling
            }}
          >
            {editing ? "Done" : "Manage profiles"}
          </button>
          <button type="button" className="profile-text-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function profileToAccount(p: ServerProfileSummary): AccountProfile {
  return {
    id: p.id,
    displayName: p.displayName,
    avatarColor: p.avatarColor,
    simpleMode: p.simpleMode,
    isDefault: p.isDefault,
    isKid: p.isKid,
    // The picker summary doesn't carry the cap (only the kid flag); the rename
    // form this feeds doesn't touch maturity, so null is a safe placeholder.
    maturityMax: null,
    hasPin: p.hasPin,
    gateType: p.gateType,
    bandwidthCapBytes: p.bandwidthCapBytes,
    bandwidthUsageBytes: p.bandwidthUsageBytes,
    bandwidthStatus: p.bandwidthStatus,
  };
}

/** Target-profile PIN prompt. A 403 from the existing server switch contract is
 * intentionally rendered as a retryable PIN error rather than closing the picker. */
function PinUnlockPrompt({
  target,
  onCancel,
  onSubmit,
}: {
  target: ServerProfileSummary;
  onCancel: () => void;
  onSubmit: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useModalA11y<HTMLDivElement>(onCancel);
  const canSubmit = /^\d{4,6}$/.test(pin) && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void onSubmit(pin).catch((err) => {
      const status = (err as { status?: number }).status;
      setError(
        status === 403
          ? "Incorrect PIN"
          : err instanceof Error
            ? err.message
            : "Could not switch profile.",
      );
      setBusy(false);
    });
  }

  return (
    <div
      ref={promptRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Enter profile PIN"
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">Enter PIN</h1>
        <p className="profile-unlock-copy">
          Enter the PIN to switch to <strong>{target.displayName}</strong>.
        </p>
        <label className="profile-field">
          PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            autoFocus
          />
        </label>
        {error != null && <p className="profile-picker-error" role="alert">{error}</p>}
        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Back
          </button>
          <button type="button" className="profile-solid-btn" onClick={submit} disabled={!canSubmit}>
            {busy ? "Please wait" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PinSettingsForm({
  target,
  changing,
  onCancel,
  onSubmit,
}: {
  target: ServerProfileSummary;
  changing: boolean;
  onCancel: () => void;
  onSubmit: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useModalA11y<HTMLDivElement>(onCancel);
  const validPin = /^\d{4,6}$/.test(pin);
  const canSubmit = validPin && pin === confirm && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void onSubmit(pin)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not save PIN."))
      .finally(() => setBusy(false));
  }

  const updatePin = (value: string, setter: (next: string) => void) =>
    setter(value.replace(/\D/g, "").slice(0, 6));

  return (
    <div
      ref={formRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label={changing ? `Change PIN for ${target.displayName}` : `Set PIN for ${target.displayName}`}
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">{changing ? "Change PIN" : "Set PIN"}</h1>
        <p className="profile-unlock-copy">
          A household gate - it asks for a PIN to switch into this profile. It is not encryption and does not protect your data files.
        </p>
        <label className="profile-field">
          New PIN (4-6 digits)
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="new-password"
            value={pin}
            onChange={(event) => updatePin(event.target.value, setPin)}
            autoFocus
          />
        </label>
        <label className="profile-field">
          Confirm PIN
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => updatePin(event.target.value, setConfirm)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        {confirm.length > 0 && confirm !== pin && (
          <p className="profile-picker-error">PINs do not match.</p>
        )}
        {error != null && <p className="profile-picker-error">{error}</p>}
        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="profile-solid-btn" onClick={submit} disabled={!canSubmit}>
            {busy ? "Please wait" : changing ? "Change PIN" : "Set PIN"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PasswordSettingsForm({
  target,
  onCancel,
  onSubmit,
}: {
  target: ServerProfileSummary;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useModalA11y<HTMLDivElement>(onCancel);
  const canSubmit = password.length >= 8 && password === confirm && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void onSubmit(password)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not save password."))
      .finally(() => setBusy(false));
  }

  return (
    <div
      ref={formRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label={`Set password for ${target.displayName}`}
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">Set profile password</h1>
        <p className="profile-unlock-copy">
          This password will be required before switching into <strong>{target.displayName}</strong>.
        </p>
        <label className="profile-field">
          New password
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
        </label>
        <label className="profile-field">
          Confirm password
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        {confirm.length > 0 && confirm !== password && (
          <p className="profile-picker-error">Passwords do not match.</p>
        )}
        {error != null && <p className="profile-picker-error">{error}</p>}
        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="profile-solid-btn" onClick={submit} disabled={!canSubmit}>
            {busy ? "Please wait" : "Save password"}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuotaSettingsForm({
  target,
  onCancel,
  onSubmit,
}: {
  target: ServerProfileSummary;
  onCancel: () => void;
  onSubmit: (capBytes: number) => Promise<void>;
}) {
  const initialGiB =
    target.bandwidthCapBytes != null
      ? String(target.bandwidthCapBytes / 1024 ** 3)
      : "";
  const [gigabytes, setGigabytes] = useState(initialGiB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useModalA11y<HTMLDivElement>(onCancel);
  const bytes = Math.round(Number(gigabytes) * 1024 ** 3);
  const canSubmit = Number.isSafeInteger(bytes) && bytes > 0 && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void onSubmit(bytes)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not save monthly cap."))
      .finally(() => setBusy(false));
  }

  return (
    <div
      ref={formRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label={`Monthly cap for ${target.displayName}`}
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">Monthly bandwidth cap</h1>
        <p className="profile-unlock-copy">
          Warn-only household guidance. Reaching or exceeding this cap never cuts off playback.
        </p>
        <label className="profile-field">
          Monthly cap (GB)
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={gigabytes}
            onChange={(event) => setGigabytes(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            autoFocus
          />
        </label>
        {error != null && <p className="profile-picker-error">{error}</p>}
        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="profile-solid-btn" onClick={submit} disabled={!canSubmit}>
            {busy ? "Please wait" : "Save cap"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Parental-lock prompt shown when leaving a kid profile: the account password
 *  is required before the switch. A 403 means a wrong/missing password - we show
 *  "Incorrect password" and let the user retry without closing. */
function UnlockPrompt({
  target,
  onCancel,
  onSubmit,
}: {
  target: ServerProfileSummary;
  onCancel: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const enteringProtectedProfile = target.gateType === "password";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useModalA11y<HTMLDivElement>(onCancel);
  const canSubmit = password.length > 0 && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void onSubmit(password)
      .catch((err) => {
        const status = (err as { status?: number }).status;
        setError(
          status === 403
            ? "Incorrect password."
            : err instanceof Error
              ? err.message
              : "Could not switch profile.",
        );
        setBusy(false);
      });
    // On success the picker closes, so no need to clear busy.
  }

  return (
    <div
      ref={promptRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label={enteringProtectedProfile ? "Enter profile password" : "Enter account password"}
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">
          {enteringProtectedProfile ? "Enter profile password" : "Enter account password"}
        </h1>
        <p className="profile-unlock-copy">
          {enteringProtectedProfile
            ? <>Enter the password for <strong>{target.displayName}</strong>.</>
            : <>The account password is required to leave a kids profile and switch to <strong>{target.displayName}</strong>.</>}
        </p>

        <label className="profile-field">
          {enteringProtectedProfile ? "Profile password" : "Account password"}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            autoComplete="current-password"
            autoFocus
          />
        </label>

        {error != null && <p className="profile-picker-error">{error}</p>}

        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="profile-solid-btn"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? "Please wait" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ProfileFormValues {
  displayName: string;
  avatarColor: string | null;
  password?: string;
}

function ProfileForm({
  title,
  submitLabel,
  initial,
  hidePassword = false,
  requirePassword = false,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: { displayName: string; avatarColor: string | null };
  hidePassword?: boolean;
  requirePassword?: boolean;
  onCancel: () => void;
  onSubmit: (values: ProfileFormValues) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [avatarColor, setAvatarColor] = useState<string>(
    initial?.avatarColor ?? PROFILE_COLORS[0]!.value,
  );
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = useMemo(
    () => displayName.trim().length > 0 && (!requirePassword || password.length >= 8),
    [displayName, password, requirePassword],
  );
  const formRef = useModalA11y<HTMLDivElement>(onCancel);

  function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    void onSubmit({
      displayName: displayName.trim(),
      avatarColor,
      password: hidePassword || password.length === 0 ? undefined : password,
    })
      .catch((err) => setError(err instanceof Error ? err.message : "Request failed."))
      .finally(() => setBusy(false));
  }

  return (
    <div
      ref={formRef}
      className="profile-picker"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="profile-picker-inner profile-form">
        <h1 className="profile-picker-title">{title}</h1>

        <label className="profile-field">
          Name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={100}
            autoFocus
          />
        </label>

        <div className="profile-field">
          Color
          <div className="profile-color-row">
            {PROFILE_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className={`profile-color-dot${avatarColor === color.value ? " is-selected" : ""}`}
                style={{ background: color.value }}
                aria-label={`Use ${color.label.toLowerCase()}`}
                title={color.label}
                onClick={() => setAvatarColor(color.value)}
              />
            ))}
          </div>
        </div>

        {!hidePassword && (
          <label className="profile-field">
            {requirePassword ? "Password" : "Password (optional)"}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={requirePassword ? "At least 8 characters" : "Leave blank for a quick-switch profile"}
              required={requirePassword}
              minLength={requirePassword ? 8 : undefined}
            />
          </label>
        )}

        {error != null && <p className="profile-picker-error">{error}</p>}

        <div className="profile-picker-foot">
          <button type="button" className="profile-text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="profile-solid-btn"
            onClick={submit}
            disabled={!canSubmit || busy}
          >
            {busy ? "Please wait" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
