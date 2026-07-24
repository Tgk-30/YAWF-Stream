// App shell - mirrors Sources/.../Views/ContentView.swift (the Hybrid nav).
//
// Aurora background + restrained glow, a slim glass NavRail on the left, a
// content area that routes between screens via the app store, a floating
// top-right GlobalSearch field (hidden on Settings + Detail), and a Detail
// overlay that mounts over the content area whenever a media item is selected.

import "./theme/theme.css";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavRail, isScreenHidden, type ScreenId } from "./components/NavRail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { episodesAiredSince } from "./data/calendar";
import type { TourStep } from "./components/SpotlightTour";

// The optional point-and-highlight tour. Each step spotlights a real nav
// destination by its stable [data-screen] anchor. It is available on demand
// without stacking a second tour on top of the first-run welcome guide.
const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-screen="discover"]',
    title: "Your home base",
    body: "A cinematic hero plus your Top 10 and rails of trending, popular, and new releases - all pulled live.",
    placement: "right",
  },
  {
    target: '[data-screen="search"]',
    title: "Find anything, instantly",
    body: "Search any movie or show - results appear as you type, no Enter needed.",
    placement: "right",
  },
  {
    target: '[data-screen="watchlist"]',
    title: "Save it for later",
    body: "Add titles to your Watchlist to come back to. In Server Mode it syncs across every device in your household.",
    placement: "right",
  },
  {
    target: '[data-screen="settings"]',
    title: "Your keys & preferences",
    body: "Add or change your TMDB / OMDb and debrid keys, pick a theme, choose your rating scale, and tune playback here anytime.",
    placement: "right",
  },
];
const ROUTE_TITLES: Record<ScreenId, string> = {
  discover: "Discover",
  search: "Search",
  library: "Library",
  watchlist: "Watchlist",
  calendar: "Calendar",
  history: "History",
  assistant: "Assistant",
  debrid: "Debrid library",
  downloads: "Downloads",
  settings: "Settings",
};
import { GlobalSearch } from "./components/GlobalSearch";
import { ProfileMenu } from "./components/ProfileMenu";
import { Spinner } from "./components/Spinner";
import { UpdateBanner } from "./components/UpdateBanner";
import { BandwidthWarningBanner } from "./components/BandwidthWarningBanner";
import { HostAvailabilityBanner } from "./components/HostAvailabilityBanner";
import { InstallPrompt, isInstallPromptEligible } from "./components/InstallPrompt";
import { LocalPlayerHost } from "./components/LocalPlayerHost";
import { TVPairingDock } from "./components/TVPairingDock";
// Eager (not lazy): the lock screen must paint in the SAME commit as the app
// shell, or a code-split chunk load would flash a protected profile's content
// behind a null Suspense fallback before the gate appears.
import { LocalProfilePicker } from "./components/LocalProfilePicker";
import { isSmartPreloadEnabled, whenIdle } from "./lib/smartPreload";
import { setIdleGateSuppressed, usePlayerMounted } from "./lib/attention";
import { isLocalProfileUnlocked, useAppStore } from "./store/AppStore";
import { useServerSession } from "./lib/ServerSessionContext";
import { isServerMode } from "./lib/serverMode";
import { isTauri } from "./lib/tauri";
import { getStore } from "./storage";
import { getAutoEnterProfileId } from "./storage/ProfileRegistry";
import {
  startDownloadsRuntime,
  stopDownloadsRuntime,
} from "./services/downloads";
import { devBypassesOnboarding, isFirstRun, needsKeyOnboarding } from "./lib/firstRun";
import { secretReadsFailedThisSession } from "./storage/KeychainSecretStore";
import { shouldShowServerSetup } from "./lib/serverSetup";
import { fetchServerAdminHealth } from "./lib/serverApi";
import { isTVMode } from "./lib/tvMode";
import {
  applyDocumentLocale,
  resolveInterfaceLocale,
  translate,
} from "./lib/localization";
import { useTheme } from "./theme/useTheme";
import "./App.css";

// First-paint + light screens stay eager (Discover is the landing screen; the
// rest are small structural lists that read already-loaded store state).
import { Discover } from "./screens/Discover";
import { Search } from "./screens/Search";
import { Library } from "./screens/Library";
import { Watchlist } from "./screens/Watchlist";
import { History } from "./screens/History";

// Heavy / not-on-first-paint screens + overlays are code-split into their own
// chunks (React.lazy), so the initial bundle doesn't carry them. The Detail
// overlay in particular pulls in the VideoPlayer + hls.js (large). The screens
// use named exports, so map them to a `default` for lazy(). Each is rendered
// inside a <Suspense> with a glass Spinner fallback while its chunk downloads.
const Calendar = lazy(() =>
  import("./screens/Calendar").then((m) => ({ default: m.Calendar })),
);
const DebridLibrary = lazy(() =>
  import("./screens/DebridLibrary").then((m) => ({ default: m.DebridLibrary })),
);
const Downloads = lazy(() =>
  import("./screens/Downloads").then((m) => ({ default: m.Downloads })),
);
const Settings = lazy(() =>
  import("./screens/Settings").then((m) => ({ default: m.Settings })),
);
const Browse = lazy(() =>
  import("./screens/Browse").then((m) => ({ default: m.Browse })),
);
const Assistant = lazy(() =>
  import("./screens/Assistant").then((m) => ({ default: m.Assistant })),
);
const Detail = lazy(() =>
  import("./screens/Detail").then((m) => ({ default: m.Detail })),
);

// Modal/overlay flows most returning users never open (onboarding wizards, the
// command palette, the guide, the shortcuts sheet) are code-split too, so their
// bytes - and ServerSetupWizard's QRCode dependency - stay out of first paint.
// Each render site sits inside a <Suspense fallback={null}> (a modal appearing a
// frame late is invisible). InstallPrompt stays eager: it shares a module with
// the isInstallPromptEligible predicate used during render.
const FirstRunWizard = lazy(() =>
  import("./components/FirstRunWizard").then((m) => ({ default: m.FirstRunWizard })),
);
const ServerSetupWizard = lazy(() =>
  import("./components/ServerSetupWizard").then((m) => ({ default: m.ServerSetupWizard })),
);
const TierOnboarding = lazy(() =>
  import("./components/TierOnboarding").then((m) => ({ default: m.TierOnboarding })),
);
const ProfilePicker = lazy(() =>
  import("./components/ProfilePicker").then((m) => ({ default: m.ProfilePicker })),
);
const WelcomeGuide = lazy(() =>
  import("./components/WelcomeGuide").then((m) => ({ default: m.WelcomeGuide })),
);
const KeyboardShortcuts = lazy(() =>
  import("./components/KeyboardShortcuts").then((m) => ({ default: m.KeyboardShortcuts })),
);
const SetupNudge = lazy(() =>
  import("./components/SetupNudge").then((m) => ({ default: m.SetupNudge })),
);
const SpotlightTour = lazy(() =>
  import("./components/SpotlightTour").then((m) => ({ default: m.SpotlightTour })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);

/** Gates a genuine first-run behind the right wizard, then the app:
 *   • Local Mode  → the persona FirstRunWizard (isFirstRun).
 *   • Server Mode → the owner-only ServerSetupWizard for a fresh server
 *     (shouldShowServerSetup), driven off the live admin health counts.
 *
 *  Renders boot chrome while async checks resolve, avoiding a blank opaque
 *  window before a wizard decision. Lives inside AppStoreProvider +
 *  ServerSessionProvider so all branches have store + session access. */
export function FirstRunHost() {
  const { hydrated, settings, services } = useAppStore();
  const session = useServerSession();
  const serverMode = isServerMode();

  // Local-Mode persona wizard gate.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  // The FORCED key gate: a Local-Mode launch without a catalog key or a debrid
  // token re-opens the wizard as mandatory, regardless of onboarding history.
  // Latched ONCE per launch (after hydration) so completing the wizard - or
  // deliberately clearing keys in Settings - doesn't re-trap mid-session; the
  // next launch re-evaluates.
  const [keyGate, setKeyGate] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hydrated || keyGate != null) return;
    if (devBypassesOnboarding()) {
      setKeyGate(false);
      return;
    }
    // A locked/broken keychain hydrates secrets as null - the keys may exist
    // but be unreadable. Never force onboarding on top of that.
    if (secretReadsFailedThisSession()) {
      setKeyGate(false);
      return;
    }
    setKeyGate(
      needsKeyOnboarding({
        serverMode,
        // services.tmdb folds in an env-provided key; settings alone would
        // force dev builds that are actually configured.
        hasTmdb: services.tmdb != null,
        omdbKey: settings.omdbKey,
        hasDebrid: services.debrid?.hasServices === true,
      }),
    );
  }, [hydrated, keyGate, serverMode, settings.omdbKey, services]);
  // Server-Mode owner setup gate (null = undecided, false = skip/done/non-owner).
  const [serverSetup, setServerSetup] = useState<boolean | null>(null);
  // Tier-aware welcome (shown once, before the setup wizards, on a fresh start).
  const [welcomed, setWelcomed] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem("ds_tier_welcomed") === "1";
    } catch {
      return true;
    }
  });
  const markWelcomed = () => {
    try {
      globalThis.localStorage?.setItem("ds_tier_welcomed", "1");
    } catch {
      // ignore (private mode)
    }
    setWelcomed(true);
  };

  useEffect(() => {
    void isFirstRun().then(setFirstRun);
  }, []);

  // Decide the Server-Mode setup gate once a session is known. Non-owners and
  // Local Mode resolve to false immediately; owners need the live credential
  // count from admin health to know whether the server still looks empty.
  useEffect(() => {
    if (!serverMode || session == null) {
      setServerSetup(false);
      return;
    }
    if (session.role !== "owner") {
      setServerSetup(false);
      return;
    }
    let cancelled = false;
    void fetchServerAdminHealth()
      .then((health) =>
        shouldShowServerSetup({
          role: session.role,
          credentialCount: health.counts.credentials,
        }),
      )
      .then((show) => {
        if (!cancelled) setServerSetup(show);
      })
      .catch(() => {
        // If health can't be read, never trap the owner behind setup.
        if (!cancelled) setServerSetup(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverMode, session]);

  // Wait for BOTH the relevant gate AND Store hydration before deciding. This
  // ensures the wizard's choice (e.g. Advanced → simpleMode false) is applied
  // AFTER hydration's setSettings, so a late hydration can't revert it.
  if (firstRun == null || serverSetup == null || keyGate == null || !hydrated) {
    return (
      <div
        aria-busy="true"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "var(--bg-1, #0a0b16)",
        }}
      >
        <Spinner label="Starting YAWF Stream" />
      </div>
    );
  }
  // Tier-tailored welcome first, on a genuine fresh start (then the existing
  // mode-specific setup wizard collects the actual config).
  if (!welcomed && (firstRun || keyGate || serverSetup)) {
    return (
      <Suspense fallback={null}>
        <TierOnboarding onDone={markWelcomed} />
      </Suspense>
    );
  }
  if (firstRun || keyGate) {
    return (
      <Suspense fallback={null}>
        <FirstRunWizard
          forced={keyGate}
          onDone={() => {
            setFirstRun(false);
            setKeyGate(false);
          }}
        />
      </Suspense>
    );
  }
  if (serverSetup)
    return (
      <Suspense fallback={null}>
        <ServerSetupWizard onDone={() => setServerSetup(false)} />
      </Suspense>
    );
  return <App />;
}

export function App() {
  const {
    route,
    navigate,
    detailItem,
    browseContext,
    closeBrowse,
    openDetail,
    closeDetail,
    settings,
    simpleMode,
    services,
    calendar,
    calendarLastSeenAt,
    activeProfile,
    multiUserEnabled = false,
    profiles = [],
    switchLocalProfile,
  } = useAppStore();
  const playerMounted = usePlayerMounted();
  const interfaceLocale = resolveInterfaceLocale(settings.interfaceLanguage);
  const routeTitle = translate(
    interfaceLocale,
    `nav.${route === "debrid" ? "debrid" : route}` as Parameters<
      typeof translate
    >[1],
    ROUTE_TITLES[route],
  );
  const routePageLabel = translate(interfaceLocale, "route.page", "page");
  useEffect(() => {
    applyDocumentLocale(settings.interfaceLanguage);
  }, [settings.interfaceLanguage]);
  // Calendar data is resolved once in AppStore. Recompute this bounded selector
  // only when that data, its watermark, or navigation changes - never on every
  // shell render. A failed/unavailable Server Mode calendar simply has no badge.
  const calendarBadgeCount = useMemo(() => {
    if (calendar.loading || calendar.error != null || calendarLastSeenAt == null) return 0;
    return episodesAiredSince(calendar.episodes, calendarLastSeenAt).length;
  }, [calendar.episodes, calendar.error, calendar.loading, calendarLastSeenAt, route]);

  // A mounted player can play for hours without pointer or keyboard activity.
  // Keep the input-idle route parking from treating that as unattended, while
  // the unfocused signal still parks non-video chrome in another window.
  useEffect(() => {
    setIdleGateSuppressed(playerMounted);
    return () => setIdleGateSuppressed(false);
  }, [playerMounted]);

  // "Who's watching" picker visibility, server or Local Mode.
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  // Keep a tiny always-loaded shortcut shim so the first Cmd-K requests the
  // lazy palette and opens it in its initial render.
  const [commandPaletteRequested, setCommandPaletteRequested] = useState(false);
  useEffect(() => {
    const openCommandPalette = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "k" || event.key === "K")
      ) {
        event.preventDefault();
        setCommandPaletteRequested(true);
      }
    };
    window.addEventListener("keydown", openCommandPalette);
    return () => window.removeEventListener("keydown", openCommandPalette);
  }, []);
  // A password lock is independent of the "enable multiple profiles" toggle:
  // once a profile has a password it stays gated until unlocked, even if
  // multi-user is later switched off (otherwise the toggle silently voids it).
  const localProfileLocked = !isServerMode() && activeProfile?.passwordHash != null && !isLocalProfileUnlocked(activeProfile.id);

  // Launch choice: with several profiles, ask who's watching - unless the user
  // nominated one to enter automatically (Settings -> Profiles). Runs once per
  // launch. A protected profile still meets its password prompt via
  // localProfileLocked above, so auto-enter never walks past a password.
  const [launchPickerOpen, setLaunchPickerOpen] = useState(false);
  const launchChoiceMade = useRef(false);
  useEffect(() => {
    if (launchChoiceMade.current || isServerMode()) return;
    // Wait for the registry to report; [] is also "still loading" here.
    if (profiles.length === 0) return;
    launchChoiceMade.current = true;
    if (profiles.length === 1) return; // nothing to choose between
    void (async () => {
      const autoId = await getAutoEnterProfileId();
      const target = autoId != null ? profiles.find((p) => p.id === autoId) : undefined;
      if (target == null) {
        setLaunchPickerOpen(true); // no preference, or it was deleted -> ask
        return;
      }
      if (target.id === activeProfile?.id) return; // already the active profile
      // Switching to a protected profile needs its password, which this path
      // cannot supply - fall back to the chooser so the prompt is shown there.
      const result = await switchLocalProfile(target.id);
      if (!result.ok) setLaunchPickerOpen(true);
    })();
  }, [profiles, activeProfile?.id, switchLocalProfile]);

  // First-run feature tour. App only mounts past the setup wizards, so this is
  // the moment to greet a new user. Shown once (localStorage flag); existing
  // users see it once too, which doubles as a "what's new" for the latest
  // features. Re-openable from Settings / ⌘K via the window event below.
  const [welcomeGuideOpen, setWelcomeGuideOpen] = useState(false);
  useEffect(() => {
    try {
      if (globalThis.localStorage?.getItem("ds_welcome_guide_seen") !== "1") {
        setWelcomeGuideOpen(true);
      }
    } catch {
      // private mode - just skip the auto-tour
    }
    const reopen = () => setWelcomeGuideOpen(true);
    window.addEventListener("ds:open-welcome-guide", reopen);
    return () => window.removeEventListener("ds:open-welcome-guide", reopen);
  }, []);
  // Keep the shorter point-and-highlight tour available on demand. The welcome
  // guide already covers the shell, so finishing it must not launch another
  // sequence immediately afterward.
  const [tourOpen, setTourOpen] = useState(false);
  const closeWelcomeGuide = () => {
    setWelcomeGuideOpen(false);
    try {
      globalThis.localStorage?.setItem("ds_welcome_guide_seen", "1");
    } catch {
      // ignore (private mode)
    }
  };
  const closeTour = () => {
    setTourOpen(false);
  };
  // Allow re-running the tour on demand (e.g. from a help menu / ⌘K).
  useEffect(() => {
    const open = () => setTourOpen(true);
    window.addEventListener("ds:open-tour", open);
    return () => window.removeEventListener("ds:open-tour", open);
  }, []);

  // On-demand guided setup: the SAME persona wizard a genuine first run shows,
  // re-runnable at any time. This is the clear onboarding path for installs
  // whose one-shot first-run flags were consumed long ago (webview storage
  // survives updates) but that were never actually configured. Opened from the
  // setup card below or via ⌘K ("Run guided setup") through `ds:open-first-run`.
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  useEffect(() => {
    const openWizard = () => setFirstRunOpen(true);
    window.addEventListener("ds:open-first-run", openWizard);
    return () => window.removeEventListener("ds:open-first-run", openWizard);
  }, []);

  // App-wide keyboard-shortcuts reference, opened from ⌘K (no persistence - it's
  // a reference, not a one-time greeting).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const open = () => setShortcutsOpen(true);
    window.addEventListener("ds:open-shortcuts", open);
    return () => window.removeEventListener("ds:open-shortcuts", open);
  }, []);

  // Re-openable build-profile welcome (the first-run TierOnboarding), so a user
  // can revisit the "getting started" guidance from Settings after dismissing it.
  const [tierWelcomeOpen, setTierWelcomeOpen] = useState(false);
  useEffect(() => {
    const open = () => setTierWelcomeOpen(true);
    window.addEventListener("ds:open-tier-welcome", open);
    return () => window.removeEventListener("ds:open-tier-welcome", open);
  }, []);

  // Contextual "finish setup" nudge (Local Mode only): a dismissible bar shown
  // while the app can't stream yet - no debrid service, or no active source. It
  // auto-hides once setup is complete; dismissal is remembered so it never nags.
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem("ds_setup_nudge_dismissed") === "1";
    } catch {
      return false;
    }
  });
  const dismissNudge = () => {
    setNudgeDismissed(true);
    try {
      globalThis.localStorage?.setItem("ds_setup_nudge_dismissed", "1");
    } catch {
      // ignore (private mode)
    }
  };
  const needsSetup =
    !isServerMode() &&
    (!services.debrid?.hasServices ||
      (services.indexers?.activeIndexers?.length ?? 0) === 0);
  const showSetupNudge =
    needsSetup &&
    !nudgeDismissed &&
    route !== "settings" &&
    detailItem == null &&
    browseContext == null &&
    !welcomeGuideOpen &&
    !tierWelcomeOpen &&
    !firstRunOpen &&
    !shortcutsOpen;

  // Mobile-browser "add to home screen" card. Eligibility is static for the
  // session (platform + display-mode don't change mid-run); dismissal persists.
  const [installEligible] = useState(() => isInstallPromptEligible());
  const [installDismissed, setInstallDismissed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem("ds_pwa_install_dismissed") === "1";
    } catch {
      return false;
    }
  });
  const dismissInstall = () => {
    setInstallDismissed(true);
    try {
      globalThis.localStorage?.setItem("ds_pwa_install_dismissed", "1");
    } catch {
      // ignore (private mode)
    }
  };
  // The setup nudge outranks it - one bottom card at a time.
  const showInstallPrompt =
    installEligible &&
    !installDismissed &&
    !showSetupNudge &&
    route !== "settings" &&
    detailItem == null &&
    browseContext == null &&
    !welcomeGuideOpen &&
    !tierWelcomeOpen &&
    !firstRunOpen &&
    !shortcutsOpen;

  // Smart preloading (invisible): while idle, warm the lazy Detail + Browse code
  // chunks so opening a title or "See all" is instant instead of waiting on a
  // chunk fetch. Off → metered users skip the background bytes.
  useEffect(() => {
    if (!isSmartPreloadEnabled()) return;
    whenIdle(() => {
      void import("./screens/Detail");
      void import("./screens/Browse");
    });
  }, []);

  // Apply the persisted theme to the document root (instantly on change, and on
  // startup once the Store hydrates the saved choice).
  useTheme(settings);

  // A covered screen keeps compositing: its animations invalidate the
  // full-viewport backdrop-filter of the overlay above it every frame.
  // Mirror overlay state onto the root so CSS can park the covered tree.
  useEffect(() => {
    const covered = detailItem != null || browseContext != null;
    document.documentElement.toggleAttribute("data-overlay-open", covered);
    return () => document.documentElement.removeAttribute("data-overlay-open");
  }, [detailItem, browseContext]);

  // The native executor is durable but its event subscription is not. Start
  // one local-mode runtime at app launch so interrupted jobs are recovered even
  // before the user opens the Downloads screen.
  useEffect(() => {
    if (!isTauri() || isServerMode()) return;
    const manager = startDownloadsRuntime(getStore(), services.debrid);
    return () => stopDownloadsRuntime(manager);
    // activeProfile?.id is in the deps so a Local Mode profile switch rebinds
    // the runtime to the NEW profile's Store. Without it, two profiles sharing
    // one debrid token keep services.debrid referentially identical, the effect
    // never re-runs, and the DownloadManager keeps writing to the previous
    // profile's now-closed database.
  }, [services.debrid, activeProfile?.id]);

  // If the current screen is hidden under the active modes (e.g. the user flips
  // to Simple while on Assistant/Debrid, or is in Server Mode), redirect to
  // Discover so they're never stranded on a now-unreachable screen.
  useEffect(() => {
    if (isScreenHidden(route, { serverMode: isServerMode(), simpleMode })) {
      // Replace (not push): this is a forced correction, so pressing Back must
      // not restore the hidden route and bounce here again in a loop.
      navigate("discover", { replace: true });
    }
  }, [route, simpleMode, navigate]);

  // The global quick-search field is shown on browse screens but not Settings
  // (ContentView.showsGlobalSearch); the dedicated Search screen has its own
  // field, so hide the floating one there too.
  const showsGlobalSearch =
    route !== "settings" &&
    route !== "search" &&
    route !== "calendar" &&
    route !== "debrid" &&
    route !== "downloads" &&
    route !== "assistant" &&
    detailItem == null &&
    browseContext == null;
  const routeFrameRef = useRef<HTMLDivElement | null>(null);
  const initialRouteRef = useRef(true);
  useEffect(() => {
    document.title = `${routeTitle} | YAWF Stream`;
    if (initialRouteRef.current) {
      initialRouteRef.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => routeFrameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [route, routeTitle]);

  return (
    // data-setup-nudge reserves scroll room under the fixed get-started card
    // (App.css) so the last content row is never stranded behind it.
    <div className="app" data-setup-nudge={showSetupNudge || showInstallPrompt || undefined}>
      <a className="skip-to-content" href="#main-content">
        {translate(interfaceLocale, "common.skipContent", "Skip to content")}
      </a>
      <div className="aurora-glow" />
      <div className="app-alert-stack">
        <HostAvailabilityBanner />
        <BandwidthWarningBanner />
      </div>

      <NavRail
        selected={route}
        onSelect={navigate}
        inert={detailItem != null || browseContext != null}
        onSwitchProfile={() => setProfilePickerOpen(true)}
        localProfile={activeProfile}
        localProfileCount={profiles.length}
        localMultiUserEnabled={multiUserEnabled}
        navOrder={settings.appearanceNavOrder}
        navHidden={settings.appearanceNavHidden}
        calendarBadgeCount={calendarBadgeCount}
        interfaceLocale={interfaceLocale}
      />

      <main id="main-content" className="app-content" tabIndex={-1}>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {routeTitle} {routePageLabel}
        </span>
        {showsGlobalSearch && <GlobalSearch />}
        {showsGlobalSearch && (
          <ProfileMenu
            onSwitchProfile={() => setProfilePickerOpen(true)}
            showSwitch={isServerMode() || (multiUserEnabled && profiles.length > 1)}
          />
        )}

        {/* Route transition: a keyed frame that plays a CSS enter animation on
            each navigation. The `key={route}` remounts this div on every route
            change, which restarts the `routeIn` keyframes (see App.css). We use a
            pure-CSS animation rather than a JS/motion one on purpose: it runs on
            the compositor and completes reliably even if rAF is throttled, and it
            sidesteps the AnimatePresence exit-wait that stalls on these heavy,
            nested-motion screens. Suspense stays inside so a lazy screen shows the
            spinner within the frame. */}
        <div
          key={route}
          className="route-frame"
          tabIndex={-1}
          aria-label={`${routeTitle} ${routePageLabel}`}
          ref={(element) => {
            routeFrameRef.current = element;
            element?.toggleAttribute(
              "inert",
              detailItem != null || browseContext != null,
            );
          }}
        >
          {/* Per-screen boundary: a single screen's render crash offers "Go
              home" instead of sinking the whole app. resetKey={route} clears it
              on navigation (the keyed frame also remounts). */}
          <ErrorBoundary
            label={route}
            resetKey={route}
            onGoHome={() => navigate("discover")}
          >
            <Suspense fallback={<Spinner variant="inline" />}>
              {renderScreen(route)}
            </Suspense>
          </ErrorBoundary>
        </div>

        {/* Browse overlay - mounts over the current screen ("See all" +
            advanced filters), below the Detail overlay. Its own boundary: a
            crash here closes the overlay instead of sinking the app. */}
        {browseContext != null && (
          <div
            ref={(element) => {
              element?.toggleAttribute("inert", detailItem != null);
            }}
          >
            <ErrorBoundary
              label="browse"
              resetKey={browseContext}
              onGoHome={closeBrowse}
              homeLabel="Close"
              overlay
            >
              <Suspense fallback={<Spinner variant="overlay" />}>
                <Browse />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}

        {/* Detail overlay - mounts over the current screen (and over Browse).
            It hosts the VideoPlayer, so it gets its own boundary: a player
            render crash closes the overlay rather than reaching the root
            boundary in main.tsx and taking the whole app down. resetKey is the
            item id, so navigating to a different title from inside a crashed
            Detail recovers without a reload. */}
        {detailItem != null && (
          <ErrorBoundary
            label="detail"
            resetKey={detailItem.id}
            onGoHome={closeDetail}
            homeLabel="Close"
            overlay
          >
            <Suspense fallback={<Spinner variant="overlay" />}>
              <Detail />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      {/* Completed downloads can launch playback without opening a Detail
          overlay. The host owns the app-wide native-mpv mount. */}
      <LocalPlayerHost />
      {isTVMode() && <TVPairingDock />}

      {/* Lazily-loaded overlays - each chunk downloads only when first opened.
          A null Suspense fallback is correct here: these are modals, so "nothing
          for a frame" is invisible until the chunk resolves. */}
      <Suspense fallback={null}>
        {profilePickerOpen && (isServerMode() ? (
          <ProfilePicker onClose={() => setProfilePickerOpen(false)} />
        ) : (
          <LocalProfilePicker onClose={() => setProfilePickerOpen(false)} />
        ))}
        {/* Launch choice. The lock gate wins when both apply, so a protected
            profile shows its password prompt rather than two stacked pickers. */}
        {launchPickerOpen && !localProfileLocked && (
          <LocalProfilePicker mode="select" onClose={() => setLaunchPickerOpen(false)} />
        )}
        {localProfileLocked && (
          <LocalProfilePicker mode="lock" onClose={() => {}} />
        )}

        {/* ⌘K quick switcher - fetched only after its first shortcut. */}
        {commandPaletteRequested && (
          <Suspense fallback={null}>
            <CommandPalette initiallyOpen />
          </Suspense>
        )}

        {/* First-run feature tour (and re-openable from Settings / ⌘K). */}
        {welcomeGuideOpen && (
          <WelcomeGuide
            onClose={closeWelcomeGuide}
            onOpenSettings={() => navigate("settings")}
          />
        )}

        {tourOpen && <SpotlightTour steps={TOUR_STEPS} onDone={closeTour} />}

        {shortcutsOpen && (
          <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />
        )}

        {tierWelcomeOpen && (
          <TierOnboarding onDone={() => setTierWelcomeOpen(false)} />
        )}

        {/* Re-run of the first-run persona wizard (full-screen; closes on done or
            skip - the wizard persists its own onboarding_completed flag). */}
        {firstRunOpen && <FirstRunWizard onDone={() => setFirstRunOpen(false)} />}

        {showSetupNudge && (
          <SetupNudge
            onStartWizard={() => setFirstRunOpen(true)}
            onShowTour={() => setWelcomeGuideOpen(true)}
            onDismiss={dismissNudge}
          />
        )}
      </Suspense>

      {showInstallPrompt && <InstallPrompt onDismiss={dismissInstall} />}

      {/* Desktop auto-update toast. Runs the launch-time check itself and is a
          no-op in a plain browser (isTauri-gated in updater.ts). */}
      <UpdateBanner
        autoCheck={settings.autoUpdateChecks}
        autoInstall={settings.autoInstallUpdates}
        networkMode={settings.networkMode}
      />
    </div>
  );

  function renderScreen(screen: ScreenId) {
    switch (screen) {
      case "discover":
        return <Discover onSelect={openDetail} />;
      case "search":
        return <Search />;
      case "library":
        return <Library />;
      case "watchlist":
        return <Watchlist />;
      case "calendar":
        return <Calendar />;
      case "history":
        return <History />;
      case "assistant":
        return <Assistant />;
      case "debrid":
        return <DebridLibrary />;
      case "downloads":
        return <Downloads />;
      case "settings":
        return <Settings />;
    }
  }
}
