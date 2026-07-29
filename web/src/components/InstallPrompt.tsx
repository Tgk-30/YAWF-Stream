// InstallPrompt - dismissible "add to home screen" card, shown ONLY in a
// mobile browser session (never Tauri, never once installed/standalone).
// Android/Chromium: a real one-tap Install via the captured
// beforeinstallprompt; where the event never fires (iOS always, Firefox,
// unmet PWA criteria, dev builds) the card still renders platform-specific
// manual steps - that copy is the only guidance those environments get.

import { useEffect, useRef, useState } from "react";
import {
  deviceKind,
  isMobileBrowser,
  isSecureContextForInstall,
  isStandaloneDisplay,
} from "../lib/platform";
import { isTauri } from "../lib/tauri";
import {
  consumeInstallPrompt,
  getInstallPrompt,
  subscribeInstallPrompt,
} from "../lib/installPrompt";
import { Icon } from "./Icon";
import "./InstallPrompt.css";

/** Static platform gate: never in Tauri, never standalone, mobile UA only. */
export function isInstallPromptEligible(): boolean {
  return !isTauri() && !isStandaloneDisplay() && isMobileBrowser();
}

export function InstallPrompt({ onDismiss }: { onDismiss: () => void }) {
  const kind = deviceKind(); // "ios" | "android" behind the eligibility gate
  const [prompt, setPrompt] = useState(getInstallPrompt);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const unsubscribe = subscribeInstallPrompt(setPrompt);
    // Re-read after subscribing: the event can land between first render and
    // this effect, and it would otherwise be missed.
    setPrompt(getInstallPrompt());
    // Installed through the browser's own menu → the card has done its job.
    const onInstalled = () => onDismissRef.current();
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      unsubscribe();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (prompt == null) return;
    let outcome: string | null = null;
    try {
      await prompt.prompt();
      outcome = (await prompt.userChoice).outcome;
    } catch {
      // Event already used or invalidated - consume it and fall back to the
      // menu copy rather than leaving a dead Install button.
    } finally {
      consumeInstallPrompt();
      setPrompt(null);
    }
    // Accepted → the appinstalled/standalone state takes over; retire the card.
    // Dismissed → keep the card; the user can still X it away themselves.
    if (outcome === "accepted") onDismiss();
  }

  return (
    <div
      className="install-prompt glass-hero glass-lit"
      role="status"
      aria-label="Install app suggestion"
    >
      <span className="install-prompt-icon" aria-hidden>
        <Icon name="upload" size={16} />
      </span>
      <div className="install-prompt-text">
        <strong>Install YAWF Stream</strong>
        {kind === "ios" ? (
          <ol className="install-prompt-steps">
            <li>
              Tap the Share button <Icon name="share" size={13} /> in
              Safari&rsquo;s toolbar.
            </li>
            <li>
              Scroll and tap <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>.
            </li>
          </ol>
        ) : prompt != null ? (
          <span className="t-secondary">
            Add it to your home screen - full screen, no browser bars.
          </span>
        ) : !isSecureContextForInstall() ? (
          // Chromium hides the install entry entirely on a plain-HTTP origin,
          // so the generic "open your browser menu" copy below would send the
          // user looking for something that is not there. Name the real cause.
          <span className="t-secondary">
            This server is served over plain HTTP, so Android will not offer to
            install it. Reach it over HTTPS, or through a tunnel that provides
            one, and this card becomes a one-tap install.
          </span>
        ) : (
          <span className="t-secondary">
            Open your browser menu and choose{" "}
            <strong>Add to Home screen</strong> (or <strong>Install app</strong>).
          </span>
        )}
      </div>
      {kind === "android" && prompt != null && (
        <div className="install-prompt-actions">
          <button
            type="button"
            className="btn btn-prominent"
            onClick={() => void install()}
          >
            Install
          </button>
        </div>
      )}
      <button
        type="button"
        className="install-prompt-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss install suggestion"
      >
        <Icon name="xmark" size={16} />
      </button>
    </div>
  );
}
