// ProfileMenu - the top-right avatar. Shows the user's photo (or their initial)
// and opens a small popover to customize their name + avatar image. In Server
// Mode it also offers "Switch profile" (the existing ProfilePicker). The avatar
// image is resized client-side to a small square data: URL and stored locally in
// settings - nothing leaves the device.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/AppStore";
import { isServerMode } from "../lib/serverMode";
import { updateProfileRecord } from "../storage/ProfileRegistry";
import { Icon } from "./Icon";
import { PRESET_AVATARS } from "./AvatarPresets";
import "./ProfileMenu.css";

interface Props {
  /** Opens the "Who's watching?" ProfilePicker (Server Mode). */
  onSwitchProfile?: () => void;
  /** Whether the account has multiple profiles worth switching between. */
  showSwitch?: boolean;
}

/** Load a picked image, center-crop to a 160px square, and return a compact
 * JPEG data: URL (a few KB) suitable for storing in settings. */
async function fileToAvatarDataURL(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read image"));
      i.src = url;
    });
    // A corrupt/empty image would yield a zero scale → a blank avatar; reject so
    // the caller keeps the previous one instead of silently storing a blank.
    if (!img.width || !img.height) throw new Error("Empty image");
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ProfileMenu({ onSwitchProfile, showSwitch }: Props) {
  const { settings, updateSettings, activeProfile, refreshProfiles } = useAppStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // A higher modal, such as the command palette, owns its own Escape.
      const modal = event.target instanceof Element
        ? event.target.closest('[aria-modal="true"]')
        : null;
      if (modal != null && modal !== popoverRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      avatarRef.current?.focus({ preventScroll: true });
    };
    // Capture before route shortcuts, but only while this popover is open.
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [open]);

  const name = (settings.userName ?? "").trim();
  const avatar = settings.userAvatar ?? "";
  const initial = (name || "You").charAt(0).toUpperCase();

  const syncLocalProfile = (patch: { name?: string; avatar?: string }) => {
    if (isServerMode() || activeProfile == null) return;
    void updateProfileRecord(activeProfile.id, patch).then(() => refreshProfiles());
  };

  const pickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setPhotoError(null);
    try {
      const dataUrl = await fileToAvatarDataURL(file);
      updateSettings({ ...settings, userAvatar: dataUrl });
      syncLocalProfile({ avatar: dataUrl });
    } catch {
      // The user explicitly asked for this, so a file we cannot decode has to
      // say so. Silently keeping the old avatar looked like nothing happened.
      setPhotoError("That image could not be read. Try a JPEG or PNG.");
    } finally {
      setBusy(false);
    }
  };

  const avatarInner = avatar ? (
    <img src={avatar} alt="" />
  ) : (
    <span className="profile-menu-initial">{initial}</span>
  );

  return (
    <div className="profile-menu">
      <button
        type="button"
        className="profile-menu-avatar"
        ref={avatarRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Your profile"
      >
        {avatarInner}
      </button>

      {open && (
        <>
          <button
            type="button"
            className="profile-menu-scrim"
            aria-label="Close"
            onClick={() => setOpen(false)}
          />
          <div ref={popoverRef} className="profile-menu-pop glass-raised glass-lit" role="dialog" aria-label="Profile">
            <div className="profile-menu-head">
              <div className="profile-menu-big">{avatarInner}</div>
              <input
                className="profile-menu-name field"
                type="text"
                value={settings.userName ?? ""}
                placeholder="Your name"
                maxLength={40}
                onChange={(e) =>
                  (() => {
                    updateSettings({ ...settings, userName: e.target.value });
                    syncLocalProfile({ name: e.target.value });
                  })()
                }
                aria-label="Your name"
              />
            </div>

            {photoError != null && (
              <p className="profile-menu-error" role="alert">{photoError}</p>
            )}

            <div className="profile-menu-actions">
              <button
                type="button"
                className="profile-menu-action"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="upload" size={16} />
                {avatar ? "Change photo" : "Add photo"}
              </button>
              {avatar && (
                <button
                  type="button"
                  className="profile-menu-action"
                  disabled={busy}
                  onClick={() => {
                    updateSettings({ ...settings, userAvatar: "" });
                    syncLocalProfile({ avatar: "" });
                  }}
                >
                  <Icon name="trash" size={16} />
                  Remove
                </button>
              )}
            </div>

            <div className="profile-menu-presets">
              <span className="profile-menu-presets-label t-secondary">
                Or pick one
              </span>
              <div className="profile-menu-presets-grid">
                {PRESET_AVATARS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={
                      "profile-menu-preset" +
                      (avatar === preset.dataUrl ? " is-selected" : "")
                    }
                    aria-label={preset.label}
                    aria-pressed={avatar === preset.dataUrl}
                    title={preset.label}
                    onClick={() =>
                      (() => {
                        updateSettings({ ...settings, userAvatar: preset.dataUrl });
                        syncLocalProfile({ avatar: preset.dataUrl });
                      })()
                    }
                  >
                    <img src={preset.dataUrl} alt="" />
                  </button>
                ))}
              </div>
            </div>

            {showSwitch && onSwitchProfile && (
              <button
                type="button"
                className="profile-menu-switch"
                onClick={() => {
                  setOpen(false);
                  onSwitchProfile();
                }}
              >
                <Icon name="refresh" size={16} />
                Switch profile
              </button>
            )}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={pickImage}
            />
          </div>
        </>
      )}
    </div>
  );
}
