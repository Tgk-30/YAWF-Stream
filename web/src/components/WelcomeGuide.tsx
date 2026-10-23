// WelcomeGuide - a short, beautiful feature tour shown once to new users (after
// the setup onboarding) and re-openable from Settings / ⌘K. It introduces the
// signature features as a sequence of focused "boxes" rather than dumping
// everything at once - progressive disclosure, fully skippable, keyboard-driven.
//
// Design principles applied: one idea per step, a clear icon→title→one-line copy
// hierarchy, an always-visible Skip, a visible progress indicator, motion that
// the global reduced-motion rule damps, and tokens so it themes everywhere.

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import "./WelcomeGuide.css";

interface Step {
  icon: IconName;
  title: string;
  body: string;
  /** Optional keycap chips rendered under the copy (e.g. the ⌘K shortcut). */
  keys?: string[];
}

const STEPS: Step[] = [
  {
    icon: "sparkles",
    title: "Welcome to YAWF Stream",
    body: "Your movies and shows, from every source, in one beautiful place. Here's the 60-second tour - including how to get your first stream playing.",
  },
  {
    icon: "play",
    title: "How it works",
    body: "Open any title and pick a stream marked green “Instant”. It plays in seconds - streamed straight from your debrid service, with no downloading or seeding.",
  },
  {
    icon: "settings",
    title: "A one-time setup",
    body: "To find those streams you'll add a debrid service (Real-Debrid, TorBox…) and a source in Settings - or just sign in to a server someone already set up. It takes about two minutes.",
  },
  {
    icon: "wand-search",
    title: "Find something to watch",
    body: "Browse Discover or search any title without AI. If you configure AI later, you can also describe a vibe like “cozy fall mysteries” for a tailored lineup.",
  },
  {
    icon: "sliders",
    title: "Move fast",
    body: "Press ⌘K any time to jump to a screen, search, or switch themes. In the player, press ? to see the playback shortcuts.",
    keys: ["⌘", "K"],
  },
  {
    icon: "history",
    title: "Keep your place",
    body: "Continue Watching and resume bars pick up where you left off. Turn on watch stats, or import your list from IMDb or Letterboxd, from Settings.",
  },
  {
    icon: "check",
    title: "You're all set",
    body: "Dive in from Discover - anything here is one click (or ⌘K) away. If a title shows “No sources yet”, finish setup in Settings.",
  },
];

export function WelcomeGuide({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  /** When provided, the final step offers a direct path into Settings so a new
   *  user can finish setup instead of landing on an unconfigured app. */
  onOpenSettings?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  const next = useCallback(() => {
    if (last) {
      onClose();
    } else {
      setDir(1);
      setStep((s) => s + 1);
    }
  }, [last, onClose]);

  const back = useCallback(() => {
    setDir(-1);
    setStep((s) => Math.max(0, s - 1));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (
          e.key === "Enter" &&
          e.target instanceof Element &&
          e.target.closest(
            "button, a[href], input, select, textarea, [contenteditable='true'], [role='button'], [role='link']",
          ) != null
        ) {
          return;
        }
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onClose]);

  return (
    <div
      className="welcome-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tour"
    >
      <div className="welcome-card">
        <button
          type="button"
          className="welcome-skip"
          onClick={onClose}
          aria-label="Skip the tour"
        >
          Skip
        </button>

        <div className="welcome-stage">
            <div
              key={step}
              className={`welcome-step ${dir > 0 ? "welcome-step-forward" : "welcome-step-backward"}`}
            >
              <div className="welcome-halo">
                <Icon name={current.icon} size={30} />
              </div>
              <h2 className="welcome-title">{current.title}</h2>
              <p className="welcome-body">{current.body}</p>
              {current.keys && (
                <div className="welcome-keys" aria-hidden>
                  {current.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </div>
              )}
              {last && onOpenSettings && (
                <button
                  type="button"
                  className="btn welcome-cta"
                  onClick={() => {
                    onOpenSettings();
                    onClose();
                  }}
                >
                  <Icon name="settings" size={15} />
                  Set up streaming in Settings
                </button>
              )}
            </div>
        </div>

        <div className="welcome-dots" aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`welcome-dot${i === step ? " is-active" : ""}`}
            />
          ))}
        </div>

        <div className="welcome-foot">
          <button
            type="button"
            className="btn welcome-back"
            onClick={back}
            disabled={step === 0}
          >
            Back
          </button>
          <span className="welcome-count">
            {step + 1} / {STEPS.length}
          </span>
          <button type="button" className="btn btn-prominent" onClick={next}>
            {last ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
