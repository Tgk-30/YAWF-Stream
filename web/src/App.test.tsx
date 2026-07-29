// @vitest-environment jsdom
//
// Behavioral tests for the App shell (src/App.tsx). App is the router/layout:
// it picks which screen renders per `route`, mounts the NavRail, gates the
// Browse/Detail/ProfilePicker/WelcomeGuide overlays, decides whether the
// floating GlobalSearch shows, and redirects off hidden screens. We mock every
// screen + heavy child to stubs so we only exercise App's own logic.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Store mock ---------------------------------------------------------
// App reads a slice of useAppStore; we drive it via a mutable object so each
// test can set route / detailItem / browseContext / simpleMode etc.

const navigate = vi.fn();
const openDetail = vi.fn();
const closeDetail = vi.fn();
const closeBrowse = vi.fn();
const search = vi.fn();

const startManager = { id: "downloads-runtime" };

type StoreSlice = {
  route: string;
  navigate: typeof navigate;
  detailItem: unknown;
  browseContext: unknown;
  openDetail: typeof openDetail;
  closeDetail: typeof closeDetail;
  closeBrowse: typeof closeBrowse;
  search: typeof search;
  settings: {
    autoUpdateChecks: boolean;
    autoInstallUpdates: boolean;
    tmdbKey: string;
    omdbKey: string;
  };
  simpleMode: boolean;
  hydrated: boolean;
  calendar: { episodes: unknown[]; loading: boolean; error: string | null };
  calendarLastSeenAt: number | null;
  services: {
    debrid: { hasServices: boolean } | null;
    indexers: { activeIndexers: unknown[] } | null;
  };
  activeProfile: {
    id: string;
    name: string;
    avatar?: string;
    color?: string;
    isAdmin: boolean;
    isDefault: boolean;
    createdAt: number;
    passwordHash?: string | null;
  } | null;
  profiles: Array<{
    id: string;
    name: string;
    avatar?: string;
    color?: string;
    isAdmin: boolean;
    isDefault: boolean;
    createdAt: number;
    passwordHash?: string | null;
  }>;
  multiUserEnabled: boolean;
  switchLocalProfile: (id: string, password?: string) => Promise<{ ok: boolean; reason?: "bad-password" | "not-found" }>;
};

let localProfileUnlocked = true;

let store: StoreSlice;

vi.mock("./store/AppStore", () => ({
  useAppStore: () => store,
  useAppActions: () => ({ search }),
  isLocalProfileUnlocked: () => localProfileUnlocked,
}));

// --- serverMode / preload helpers ---------------------------------------

let serverModeValue = false;
vi.mock("./lib/serverMode", () => ({
  isServerMode: () => serverModeValue,
  configuredServerURL: () => null,
}));

let smartPreloadEnabled = false;
const whenIdle = vi.fn();
vi.mock("./lib/smartPreload", () => ({
  isSmartPreloadEnabled: () => smartPreloadEnabled,
  whenIdle: (fn: () => void) => whenIdle(fn),
}));

let isTauriValue = false;
vi.mock("./lib/tauri", () => ({
  isTauri: () => isTauriValue,
}));

let getStoreResult = { name: "store" };
vi.mock("./storage", () => ({
  getStore: () => getStoreResult,
}));

const startDownloadsRuntimeMock = vi.fn();
const stopDownloadsRuntimeMock = vi.fn();
vi.mock("./services/downloads", () => ({
  startDownloadsRuntime: (...args: unknown[]) => startDownloadsRuntimeMock(...args),
  stopDownloadsRuntime: (...args: unknown[]) => stopDownloadsRuntimeMock(...args),
}));

let autoEnterProfileIdValue: string | null = null;
vi.mock("./storage/ProfileRegistry", () => ({
  getAutoEnterProfileId: () => Promise.resolve(autoEnterProfileIdValue),
}));

// useTheme is a thin DOM side-effect; stub to a no-op so jsdom stays clean.
vi.mock("./theme/useTheme", () => ({ useTheme: () => {} }));

// CSS imports are inert in jsdom; stub to keep things fast/safe.
vi.mock("./theme/theme.css", () => ({}));
vi.mock("./App.css", () => ({}));

// --- Screen stubs -------------------------------------------------------
// Each screen renders a unique marker so we can assert which one App routed to.
// Discover gets the openDetail handler so we can verify it's wired through.

let routeThrows = false;
vi.mock("./screens/Discover", () => ({
  Discover: ({ onSelect }: { onSelect: (i: unknown) => void }) => {
    if (routeThrows) throw new Error("route exploded");
    return (
      <button data-testid="screen-discover" onClick={() => onSelect({ id: "x" })}>
        discover
      </button>
    );
  },
}));
vi.mock("./screens/Search", () => ({
  Search: () => <div data-testid="screen-search">search</div>,
}));
vi.mock("./screens/Library", () => ({
  Library: () => <div data-testid="screen-library">library</div>,
}));
vi.mock("./screens/Downloads", () => ({
  Downloads: () => <div data-testid="screen-downloads">downloads</div>,
}));
vi.mock("./screens/Watchlist", () => ({
  Watchlist: () => <div data-testid="screen-watchlist">watchlist</div>,
}));
vi.mock("./screens/History", () => ({
  History: () => <div data-testid="screen-history">history</div>,
}));
vi.mock("./screens/Assistant", () => ({
  Assistant: () => <div data-testid="screen-assistant">assistant</div>,
}));
vi.mock("./screens/Calendar", () => ({
  Calendar: () => <div data-testid="screen-calendar">calendar</div>,
}));
vi.mock("./screens/DebridLibrary", () => ({
  DebridLibrary: () => <div data-testid="screen-debrid">debrid</div>,
}));
vi.mock("./screens/Settings", () => ({
  Settings: () => <div data-testid="screen-settings">settings</div>,
}));
vi.mock("./screens/Browse", () => ({
  Browse: () => <div data-testid="overlay-browse">browse</div>,
}));
let detailThrows = false;
vi.mock("./screens/Detail", () => ({
  Detail: () => {
    if (detailThrows) throw new Error("player exploded");
    return <div data-testid="overlay-detail">detail</div>;
  },
}));

// --- Child component stubs ----------------------------------------------
// Keep NavRail real-ish but light: stub it to surface the props App passes.

vi.mock("./components/NavRail", async () => {
  // isScreenHidden is pure + used by App's redirect effect; reuse the real one.
  const actual = await vi.importActual<typeof import("./components/NavRail")>(
    "./components/NavRail",
  );
  return {
    ...actual,
    NavRail: ({
      selected,
      onSelect,
      onSwitchProfile,
      calendarBadgeCount = 0,
      inert = false,
    }: {
      selected: string;
      onSelect: (s: string) => void;
      onSwitchProfile: () => void;
      calendarBadgeCount?: number;
      inert?: boolean;
    }) => (
      <nav
        data-testid="nav-rail"
        data-selected={selected}
        data-calendar-badge={calendarBadgeCount}
        ref={(element) => element?.toggleAttribute("inert", inert)}
      >
        <button data-testid="nav-go-library" onClick={() => onSelect("library")}>
          go-library
        </button>
        <button data-testid="nav-switch-profile" onClick={onSwitchProfile}>
          switch
        </button>
      </nav>
    ),
  };
});

vi.mock("./components/GlobalSearch", () => ({
  GlobalSearch: () => (
    <button data-testid="global-search" onClick={() => search("q")}>
      global-search
    </button>
  ),
}));

vi.mock("./components/Spinner", () => ({
  Spinner: ({ variant }: { variant?: string }) => (
    <div data-testid="spinner" data-variant={variant} />
  ),
}));

vi.mock("./components/ProfilePicker", () => ({
  ProfilePicker: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="profile-picker" onClick={onClose}>
      profile-picker
    </button>
  ),
}));

vi.mock("./components/CommandPalette", () => ({
  CommandPalette: ({ initiallyOpen = false }: { initiallyOpen?: boolean }) => (
    <div
      data-testid="command-palette"
      data-initially-open={String(initiallyOpen)}
    />
  ),
}));

let capturedProfileMenuProps: {
  onSwitchProfile?: () => void;
  showSwitch?: boolean;
} = {};
vi.mock("./components/ProfileMenu", () => ({
  ProfileMenu: ({ onSwitchProfile, showSwitch }: { onSwitchProfile?: () => void; showSwitch?: boolean }) => {
    capturedProfileMenuProps = { onSwitchProfile, showSwitch };
    return (
      <div data-testid="profile-menu" data-show-switch={String(Boolean(showSwitch))}>
        {showSwitch && onSwitchProfile ? (
          <button
            type="button"
            data-testid="profile-menu-switch"
            onClick={onSwitchProfile}
          >
            switch profile
          </button>
        ) : null}
      </div>
    );
  },
}));

let lastLocalProfilePickerMode: "switch" | "select" | "lock" | null = null;
vi.mock("./components/LocalProfilePicker", () => ({
  LocalProfilePicker: ({ onClose, mode = "switch" }: { onClose: () => void; mode?: "switch" | "select" | "lock" }) => {
    lastLocalProfilePickerMode = mode;
    return (
      <div data-testid={`local-profile-picker-${mode}`}>
        <button type="button" data-testid="local-profile-picker-close" onClick={onClose}>
          close
        </button>
      </div>
    );
  },
}));

let installPromptEligibleValue = false;
vi.mock("./components/InstallPrompt", () => ({
  isInstallPromptEligible: () => installPromptEligibleValue,
  InstallPrompt: ({ onDismiss }: { onDismiss: () => void }) => (
    <button type="button" data-testid="install-prompt" onClick={onDismiss}>
      install prompt
    </button>
  ),
}));

vi.mock("./components/KeyboardShortcuts", () => ({
  KeyboardShortcuts: ({ onClose }: { onClose: () => void }) => (
    <button type="button" data-testid="keyboard-shortcuts" onClick={onClose}>
      shortcuts
    </button>
  ),
}));

vi.mock("./components/SpotlightTour", () => ({
  SpotlightTour: ({ onDone }: { onDone: () => void }) => (
    <button type="button" data-testid="spotlight-tour" onClick={onDone}>
      spotlight-tour
    </button>
  ),
}));

vi.mock("./components/WelcomeGuide", () => ({
  WelcomeGuide: ({
    onClose,
    onOpenSettings,
  }: {
    onClose: () => void;
    onOpenSettings: () => void;
  }) => (
    <div>
      <button data-testid="welcome-guide" onClick={onClose}>
        welcome-guide
      </button>
      <button data-testid="welcome-guide-open-settings" onClick={onOpenSettings}>
        open-settings
      </button>
    </div>
  ),
}));

vi.mock("./components/UpdateBanner", () => ({
  UpdateBanner: ({
    autoCheck,
    autoInstall,
  }: {
    autoCheck: boolean;
    autoInstall: boolean;
  }) => (
    <div
      data-testid="update-banner"
      data-auto-check={String(autoCheck)}
      data-auto-install={String(autoInstall)}
    />
  ),
}));

vi.mock("./components/SetupNudge", () => ({
  SetupNudge: ({
    onStartWizard,
    onShowTour,
    onDismiss,
  }: {
    onStartWizard: () => void;
    onShowTour: () => void;
    onDismiss: () => void;
  }) => {
    return (
      <div>
        <button data-testid="setup-nudge-start" onClick={onStartWizard}>
          setup-nudge-start
        </button>
        <button data-testid="setup-nudge-show-tour" onClick={onShowTour}>
          setup-nudge-tour
        </button>
        <button data-testid="setup-nudge-dismiss" onClick={onDismiss}>
          setup-nudge-dismiss
        </button>
      </div>
    );
  },
}));

// FirstRunHost-only children (imported by App.tsx module). Stub so the module
// graph resolves without pulling their real (heavy) implementations.
vi.mock("./components/FirstRunWizard", () => ({
  FirstRunWizard: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="first-run" onClick={onDone}>
      first-run
    </button>
  ),
}));
vi.mock("./components/ServerSetupWizard", () => ({
  ServerSetupWizard: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="server-setup" onClick={onDone}>
      server-setup
    </button>
  ),
}));
vi.mock("./components/TierOnboarding", () => ({
  TierOnboarding: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="tier-onboarding" onClick={onDone}>
      tier-onboarding
    </button>
  ),
}));

// FirstRunHost-controllable async gates (mutable so each test drives them).
let sessionValue: { role: string } | null = null;
vi.mock("./lib/ServerSessionContext", () => ({
  useServerSession: () => sessionValue,
  useServerProfiles: () => [],
}));

let firstRunValue = false;
let keyGateValue = false;
let devBypassesOnboardingValue = false;
vi.mock("./lib/firstRun", () => ({
  isFirstRun: () => Promise.resolve(firstRunValue),
  devBypassesOnboarding: () => devBypassesOnboardingValue,
  needsKeyOnboarding: () => keyGateValue,
}));

let secretReadsFailedThisSessionValue = false;
vi.mock("./storage/KeychainSecretStore", () => ({
  secretReadsFailedThisSession: () => secretReadsFailedThisSessionValue,
}));

let serverSetupValue = false;
let serverHealthShouldReject = false;
let pendingAdminHealthPromise: Promise<{ counts: { credentials: number } }> | null = null;
vi.mock("./lib/serverSetup", () => ({
  shouldShowServerSetup: () => Promise.resolve(serverSetupValue),
}));

let adminHealthCredentials = 0;
vi.mock("./lib/serverApi", () => ({
  fetchServerAdminHealth: () => {
    if (pendingAdminHealthPromise !== null) return pendingAdminHealthPromise;
    if (serverHealthShouldReject) {
      return Promise.reject(new Error("network offline"));
    }
    return Promise.resolve({ counts: { credentials: adminHealthCredentials } });
  },
}));

import { App, FirstRunHost } from "./App";

// jsdom here exposes localStorage only on an opaque origin (no working
// setItem/clear), so install a tiny in-memory shim App can read/write.
function installLocalStorage() {
  const map = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: ls,
  });
}

// --- Fixtures -----------------------------------------------------------

function makeStore(over: Partial<StoreSlice> = {}): StoreSlice {
  return {
    route: "discover",
    navigate,
    detailItem: null,
    browseContext: null,
    openDetail,
    closeDetail,
    closeBrowse,
    search,
    settings: { autoUpdateChecks: true, autoInstallUpdates: false, tmdbKey: "k", omdbKey: "" },
    simpleMode: false,
    hydrated: true,
    calendar: { episodes: [], loading: false, error: null },
    calendarLastSeenAt: null,
    // Configured by default so the "finish setup" nudge stays hidden here.
    services: {
      debrid: { hasServices: true },
      indexers: { activeIndexers: [{}] },
    },
    activeProfile: {
      id: "default",
      name: "You",
      isAdmin: true,
      isDefault: true,
      createdAt: 1,
    },
    profiles: [
      {
        id: "default",
        name: "You",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
    ],
    multiUserEnabled: true,
    switchLocalProfile: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

beforeEach(() => {
  navigate.mockClear();
  openDetail.mockClear();
  closeDetail.mockClear();
  closeBrowse.mockClear();
  search.mockClear();
  detailThrows = false;
  routeThrows = false;
  capturedProfileMenuProps = {};
  lastLocalProfilePickerMode = null;
  installPromptEligibleValue = false;
  whenIdle.mockClear();
  startDownloadsRuntimeMock.mockClear();
  stopDownloadsRuntimeMock.mockClear();
  startDownloadsRuntimeMock.mockReturnValue(startManager);
  localProfileUnlocked = true;
  isTauriValue = false;
  autoEnterProfileIdValue = null;
  serverModeValue = false;
  smartPreloadEnabled = false;
  sessionValue = null;
  firstRunValue = false;
  keyGateValue = false;
  devBypassesOnboardingValue = false;
  secretReadsFailedThisSessionValue = false;
  serverSetupValue = false;
  serverHealthShouldReject = false;
  pendingAdminHealthPromise = null;
  adminHealthCredentials = 0;
  store = makeStore();
  installLocalStorage();
  // Default: the welcome-guide seen flag is set so the auto-tour is OFF unless
  // a test clears it. Keeps most tests free of the WelcomeGuide overlay.
  globalThis.localStorage.setItem("ds_welcome_guide_seen", "1");
});

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
});

// -----------------------------------------------------------------------

describe("App routing", () => {
  const cases: Array<[string, string]> = [
    ["discover", "screen-discover"],
    ["search", "screen-search"],
    ["library", "screen-library"],
    ["watchlist", "screen-watchlist"],
    ["history", "screen-history"],
    ["assistant", "screen-assistant"],
    ["calendar", "screen-calendar"],
    ["debrid", "screen-debrid"],
    ["downloads", "screen-downloads"],
    ["settings", "screen-settings"],
  ];

  for (const [route, testid] of cases) {
    it(`renders the ${route} screen for route="${route}"`, async () => {
      store = makeStore({ route });
      render(<App />);
      expect(await screen.findByTestId(testid)).toBeInTheDocument();
    });
  }

  it("passes the active route to the NavRail as `selected`", () => {
    store = makeStore({ route: "library" });
    render(<App />);
    expect(screen.getByTestId("nav-rail")).toHaveAttribute("data-selected", "library");
  });

  it("wires NavRail onSelect to the store's navigate", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-go-library"));
    expect(navigate).toHaveBeenCalledWith("library");
  });

  it("wires Discover onSelect to openDetail", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("screen-discover"));
    expect(openDetail).toHaveBeenCalledWith({ id: "x" });
  });
});

describe("Setup nudge", () => {
  it("shows the finish-setup nudge when Local Mode has no debrid", async () => {
    store = makeStore({
      services: { debrid: null, indexers: { activeIndexers: [{}] } },
    });
    render(<App />);
    expect(await screen.findByTestId("setup-nudge-start")).toBeInTheDocument();
  });

  it("shows the nudge when there is no active source", async () => {
    store = makeStore({
      services: { debrid: { hasServices: true }, indexers: { activeIndexers: [] } },
    });
    render(<App />);
    expect(await screen.findByTestId("setup-nudge-start")).toBeInTheDocument();
  });

  it("hides the nudge once a debrid + source are configured", () => {
    store = makeStore(); // configured by default
    render(<App />);
    expect(screen.queryByTestId("setup-nudge-start")).toBeNull();
  });

  it("hides the nudge on the Settings screen", () => {
    store = makeStore({
      route: "settings",
      services: { debrid: null, indexers: { activeIndexers: [] } },
    });
    render(<App />);
    expect(screen.queryByTestId("setup-nudge-start")).toBeNull();
  });

  it("hides the nudge while the full-screen Browse overlay is open", () => {
    store = makeStore({
      browseContext: { kind: "category" },
      services: { debrid: null, indexers: { activeIndexers: [] } },
    });
    render(<App />);
    expect(screen.queryByText("Let's get you streaming")).toBeNull();
  });
});

describe("GlobalSearch visibility", () => {
  it("shows the floating search on discover", () => {
    store = makeStore({ route: "discover" });
    render(<App />);
    expect(screen.getByTestId("global-search")).toBeInTheDocument();
  });

  it.each(["settings", "search", "calendar", "debrid", "assistant"])(
    "hides the floating search on %s",
    (route) => {
      store = makeStore({ route });
      render(<App />);
      expect(screen.queryByTestId("global-search")).not.toBeInTheDocument();
    },
  );

  it("hides the floating search when a detailItem is open", () => {
    store = makeStore({ route: "discover", detailItem: { id: "a" } });
    render(<App />);
    expect(screen.queryByTestId("global-search")).not.toBeInTheDocument();
  });

  it("hides the floating search when a browseContext is open", () => {
    store = makeStore({ route: "discover", browseContext: { kind: "category" } });
    render(<App />);
    expect(screen.queryByTestId("global-search")).not.toBeInTheDocument();
  });

  it("wires GlobalSearch onSubmit to the store's search", () => {
    store = makeStore({ route: "discover" });
    render(<App />);
    fireEvent.click(screen.getByTestId("global-search"));
    expect(search).toHaveBeenCalledWith("q");
  });
});

describe("Browse + Detail overlays", () => {
  it("mounts neither overlay by default", () => {
    render(<App />);
    expect(screen.queryByTestId("overlay-browse")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-rail")).not.toHaveAttribute("inert");
  });

  it("mounts the Browse overlay when browseContext is set", async () => {
    store = makeStore({ browseContext: { kind: "category" } });
    render(<App />);
    expect(await screen.findByTestId("overlay-browse")).toBeInTheDocument();
    expect(screen.queryByTestId("overlay-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-rail")).toHaveAttribute("inert");
  });

  it("mounts the Detail overlay when detailItem is set", async () => {
    store = makeStore({ detailItem: { id: "a" } });
    render(<App />);
    expect(await screen.findByTestId("overlay-detail")).toBeInTheDocument();
    expect(screen.getByTestId("nav-rail")).toHaveAttribute("inert");
  });

  it("mirrors overlay state to the document root and removes it on close", () => {
    store = makeStore({ detailItem: { id: "a" } });
    const { rerender } = render(<App />);
    expect(document.documentElement).toHaveAttribute("data-overlay-open");

    store = makeStore();
    rerender(<App />);
    expect(document.documentElement).not.toHaveAttribute("data-overlay-open");
  });

  it("mounts both overlays together (Detail over Browse)", async () => {
    store = makeStore({
      browseContext: { kind: "category" },
      detailItem: { id: "a" },
    });
    render(<App />);
    expect(await screen.findByTestId("overlay-browse")).toBeInTheDocument();
    expect(await screen.findByTestId("overlay-detail")).toBeInTheDocument();
  });

  it("a Detail render crash closes the overlay instead of escaping the shell", async () => {
    const boom = vi.spyOn(console, "error").mockImplementation(() => {});
    detailThrows = true;
    store = makeStore({ detailItem: { id: "a" } });
    render(<App />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closeDetail).toHaveBeenCalled();
    boom.mockRestore();
  });

  it("adds the overlay class when the Detail boundary catches a crash", async () => {
    const boom = vi.spyOn(console, "error").mockImplementation(() => {});
    detailThrows = true;
    store = makeStore({ detailItem: { id: "a" } });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveClass(
      "error-boundary",
      "error-boundary-overlay",
    );
    boom.mockRestore();
  });

  it("does not add the overlay class when the route boundary catches a crash", async () => {
    const boom = vi.spyOn(console, "error").mockImplementation(() => {});
    routeThrows = true;
    store = makeStore({ route: "discover" });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("error-boundary");
    expect(alert).not.toHaveClass("error-boundary-overlay");
    boom.mockRestore();
  });
});

describe("ProfilePicker gating", () => {
  it("does not render the picker until the rail requests it", () => {
    render(<App />);
    expect(screen.queryByTestId("profile-picker")).not.toBeInTheDocument();
  });

  it("opens the local profile picker when switching profile in local mode", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-switch-profile"));
    expect(await screen.findByTestId("local-profile-picker-switch")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("local-profile-picker-close"));
    expect(screen.queryByTestId("local-profile-picker-switch")).not.toBeInTheDocument();
  });

  it("opens the picker from the rail and closes it via onClose", async () => {
    serverModeValue = true;
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-switch-profile"));
    // ProfilePicker is code-split (React.lazy) - await its chunk.
    expect(await screen.findByTestId("profile-picker")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("profile-picker"));
    expect(screen.queryByTestId("profile-picker")).not.toBeInTheDocument();
  });

  it("shows the local profile picker in switch mode from the top rail", async () => {
    store = makeStore({
      activeProfile: {
        id: "default",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      profiles: [
        {
          id: "default",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
        },
      ],
    });
    autoEnterProfileIdValue = "default";
    render(<App />);
    fireEvent.click(screen.getByTestId("nav-switch-profile"));
    expect(await screen.findByTestId("local-profile-picker-switch")).toBeInTheDocument();
    expect(lastLocalProfilePickerMode).toBe("switch");
  });

  it("renders ProfileMenu switch action when multiple local profiles are available", () => {
    store = makeStore({
      profiles: [
        {
          id: "a",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
        },
        {
          id: "b",
          name: "Sibling",
          isAdmin: false,
          isDefault: false,
          createdAt: 2,
        },
      ],
      activeProfile: {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
    });
    autoEnterProfileIdValue = "a";
    render(<App />);
    expect(capturedProfileMenuProps.showSwitch).toBe(true);
    fireEvent.click(screen.getByTestId("profile-menu-switch"));
    expect(lastLocalProfilePickerMode).toBe("switch");
    expect(screen.getByTestId("local-profile-picker-switch")).toBeInTheDocument();
  });

  it("opens the launch picker in select mode when no launch profile is configured", async () => {
    const profiles = [
      {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      {
        id: "b",
        name: "Sibling",
        isAdmin: false,
        isDefault: false,
        createdAt: 2,
      },
    ];
    store = makeStore({
      activeProfile: profiles[0],
      profiles,
      multiUserEnabled: true,
    });
    autoEnterProfileIdValue = null;
    localProfileUnlocked = true;
    render(<App />);
    expect(await screen.findByTestId("local-profile-picker-select")).toBeInTheDocument();
    expect(lastLocalProfilePickerMode).toBe("select");
  });

  it("handles the no-launch-profile bootstrap path when local profiles are missing", () => {
    store = makeStore({
      profiles: [],
      activeProfile: {
        id: "default",
        name: "You",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      multiUserEnabled: false,
    });
    render(<App />);
    expect(screen.queryByTestId("local-profile-picker-select")).not.toBeInTheDocument();
  });

  it("switches to the auto-selected profile when it is different and unlocked", async () => {
    const switcher = vi.fn(async () => ({ ok: true }));
    store = makeStore({
      activeProfile: {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      profiles: [
        {
          id: "a",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
        },
        {
          id: "b",
          name: "Sibling",
          isAdmin: false,
          isDefault: false,
          createdAt: 2,
        },
      ],
      switchLocalProfile: switcher,
      multiUserEnabled: true,
    });
    autoEnterProfileIdValue = "b";
    localProfileUnlocked = true;
    render(<App />);
    await waitFor(() => expect(switcher).toHaveBeenCalledWith("b"));
    expect(screen.queryByTestId("local-profile-picker-select")).not.toBeInTheDocument();
  });

  it("falls back to launch picker when switching to a non-default local profile fails", async () => {
    const switcher = vi.fn(async () => ({ ok: false as const }));
    store = makeStore({
      activeProfile: {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      profiles: [
        {
          id: "a",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
        },
        {
          id: "b",
          name: "Sibling",
          isAdmin: false,
          isDefault: false,
          createdAt: 2,
        },
      ],
      switchLocalProfile: switcher,
      multiUserEnabled: true,
    });
    autoEnterProfileIdValue = "b";
    localProfileUnlocked = true;
    render(<App />);
    await waitFor(() => expect(switcher).toHaveBeenCalledWith("b"));
    expect(await screen.findByTestId("local-profile-picker-select")).toBeInTheDocument();
  });

  it("does not switch when auto-enter points to the active profile", async () => {
    const switcher = vi.fn(async () => ({ ok: true }));
    store = makeStore({
      activeProfile: {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      profiles: [
        {
          id: "a",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
        },
        {
          id: "b",
          name: "Sibling",
          isAdmin: false,
          isDefault: false,
          createdAt: 2,
        },
      ],
      switchLocalProfile: switcher,
      multiUserEnabled: true,
    });
    autoEnterProfileIdValue = "a";
    localProfileUnlocked = true;
    render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switcher).not.toHaveBeenCalled();
    expect(screen.queryByTestId("local-profile-picker-select")).not.toBeInTheDocument();
  });

  it("opens the launch lock gate when the active local profile is protected", () => {
    store = makeStore({
      activeProfile: {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
        passwordHash: "locked",
      },
      profiles: [
        {
          id: "a",
          name: "Owner",
          isAdmin: true,
          isDefault: true,
          createdAt: 1,
          passwordHash: "locked",
        },
      ],
      multiUserEnabled: true,
    });
    localProfileUnlocked = false;
    autoEnterProfileIdValue = "a";
    render(<App />);
    expect(screen.getByTestId("local-profile-picker-lock")).toBeInTheDocument();
    expect(lastLocalProfilePickerMode).toBe("lock");
  });

  it("dismisses the local profile picker via its close button", async () => {
    const profiles = [
      {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      {
        id: "b",
        name: "Sibling",
        isAdmin: false,
        isDefault: false,
        createdAt: 2,
      },
    ];
    store = makeStore({
      activeProfile: profiles[0],
      profiles,
      multiUserEnabled: true,
    });
    autoEnterProfileIdValue = null;
    render(<App />);
    const picker = await screen.findByTestId("local-profile-picker-select");
    fireEvent.click(screen.getByTestId("local-profile-picker-close"));
    expect(screen.queryByTestId("local-profile-picker-select")).not.toBeInTheDocument();
    expect(picker).not.toBeInTheDocument();
  });

  it("closes profile chooser and launch-picker lock overlays from their close actions", () => {
    const profiles = [
      {
        id: "a",
        name: "Owner",
        isAdmin: true,
        isDefault: true,
        createdAt: 1,
      },
      {
        id: "b",
        name: "Sibling",
        isAdmin: false,
        isDefault: false,
        createdAt: 2,
      },
    ];
    store = makeStore({
      profiles,
      multiUserEnabled: true,
      activeProfile: {
        ...profiles[0],
        passwordHash: "locked",
      },
    });
    autoEnterProfileIdValue = profiles[0].id;
    localProfileUnlocked = false;
    render(<App />);
    const lockPicker = screen.getByTestId("local-profile-picker-lock");
    fireEvent.click(screen.getByTestId("local-profile-picker-close"));
    expect(screen.getByTestId("local-profile-picker-lock")).toBeInTheDocument();
    expect(lockPicker).toBeInTheDocument();
  });
});

describe("CommandPalette + UpdateBanner globals", () => {
  it("loads and opens the CommandPalette on the first Cmd-K", async () => {
    render(<App />);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByTestId("command-palette")).toHaveAttribute(
      "data-initially-open",
      "true",
    );
  });

  it("also opens the CommandPalette on Ctrl-K", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
  });

  it("does not open the CommandPalette for unrelated keydown events", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "h" });
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("forwards update settings to the UpdateBanner", () => {
    store = makeStore({
      settings: { autoUpdateChecks: false, autoInstallUpdates: true, tmdbKey: "k", omdbKey: "" },
    });
    render(<App />);
    const banner = screen.getByTestId("update-banner");
    expect(banner).toHaveAttribute("data-auto-check", "false");
    expect(banner).toHaveAttribute("data-auto-install", "true");
  });
});

describe("Calendar new-episode indicator", () => {
  it("passes the followed-release count to navigation and clears it after the watermark advances", () => {
    const airDate = new Date();
    airDate.setDate(airDate.getDate() - 1);
    const lastSeen = new Date();
    lastSeen.setDate(lastSeen.getDate() - 2);
    store = makeStore({
      calendar: {
        loading: false,
        error: null,
        episodes: [
          {
            series: { id: "show", type: "series", title: "Followed show" },
            seasonNumber: 1,
            episodeNumber: 2,
            title: "New episode",
            airDate: `${airDate.getFullYear()}-${String(airDate.getMonth() + 1).padStart(2, "0")}-${String(airDate.getDate()).padStart(2, "0")}`,
          },
        ],
      },
      calendarLastSeenAt: lastSeen.getTime(),
    });
    const { rerender } = render(<App />);
    expect(screen.getByTestId("nav-rail")).toHaveAttribute("data-calendar-badge", "1");

    store.calendarLastSeenAt = Date.now();
    rerender(<App />);
    expect(screen.getByTestId("nav-rail")).toHaveAttribute("data-calendar-badge", "0");
  });
});

describe("WelcomeGuide auto-tour", () => {
  it("auto-opens when the seen flag is absent", async () => {
    globalThis.localStorage.removeItem("ds_welcome_guide_seen");
    render(<App />);
    // WelcomeGuide is code-split (React.lazy) - await its chunk on first mount.
    expect(await screen.findByTestId("welcome-guide")).toBeInTheDocument();
  });

  it("stays closed when the seen flag is set", () => {
    render(<App />); // beforeEach set the flag
    expect(screen.queryByTestId("welcome-guide")).not.toBeInTheDocument();
  });

  it("closing the guide persists the seen flag and unmounts it", () => {
    globalThis.localStorage.removeItem("ds_welcome_guide_seen");
    render(<App />);
    fireEvent.click(screen.getByTestId("welcome-guide"));
    expect(screen.queryByTestId("welcome-guide")).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem("ds_welcome_guide_seen")).toBe("1");
  });

  it("opens settings when WelcomeGuide requests it", () => {
    globalThis.localStorage.removeItem("ds_welcome_guide_seen");
    render(<App />);
    fireEvent.click(screen.getByTestId("welcome-guide-open-settings"));
    expect(navigate).toHaveBeenCalledWith("settings");
  });

  it("re-opens on the ds:open-welcome-guide window event", () => {
    render(<App />); // closed (flag set)
    expect(screen.queryByTestId("welcome-guide")).not.toBeInTheDocument();
    fireEvent(window, new Event("ds:open-welcome-guide"));
    expect(screen.getByTestId("welcome-guide")).toBeInTheDocument();
  });
});

describe("hidden-screen redirect effect", () => {
  it("redirects to discover when on a Simple-mode-hidden screen", async () => {
    store = makeStore({ route: "assistant", simpleMode: true });
    render(<App />);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("discover", { replace: true }),
    );
  });

  it("redirects to discover when on a Server-mode-hidden screen (debrid)", async () => {
    serverModeValue = true;
    store = makeStore({ route: "debrid", simpleMode: false });
    render(<App />);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("discover", { replace: true }),
    );
  });

  it("does not redirect when the current screen is visible", () => {
    store = makeStore({ route: "library", simpleMode: false });
    render(<App />);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers a route-level recovery button that routes home", async () => {
    routeThrows = true;
    store = makeStore({ route: "discover" });
    render(<App />);
    const goHome = await screen.findByRole("button", { name: /go home/i });
    fireEvent.click(goHome);
    expect(navigate).toHaveBeenCalledWith("discover");
  });
});

describe("modal overlays and event listeners", () => {
  it("opens the shortcuts overlay from ds:open-shortcuts", async () => {
    render(<App />);
    fireEvent(window, new Event("ds:open-shortcuts"));
    expect(await screen.findByTestId("keyboard-shortcuts")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("keyboard-shortcuts"));
    expect(screen.queryByTestId("keyboard-shortcuts")).not.toBeInTheDocument();
  });

  it("opens the spotlight tour from ds:open-tour", async () => {
    render(<App />);
    fireEvent(window, new Event("ds:open-tour"));
    expect(await screen.findByTestId("spotlight-tour")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spotlight-tour"));
    expect(screen.queryByTestId("spotlight-tour")).not.toBeInTheDocument();
  });

  it("opens the local first-run wizard from ds:open-first-run", async () => {
    render(<App />);
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
    fireEvent(window, new Event("ds:open-first-run"));
    const firstRun = await screen.findByTestId("first-run");
    expect(firstRun).toBeInTheDocument();
    fireEvent.click(firstRun);
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
  });

  it("opens and closes tier welcome from ds:open-tier-welcome", async () => {
    render(<App />);
    fireEvent(window, new Event("ds:open-tier-welcome"));
    const tierWelcome = await screen.findByTestId("tier-onboarding");
    expect(tierWelcome).toBeInTheDocument();
    fireEvent.click(tierWelcome);
    expect(screen.queryByTestId("tier-onboarding")).not.toBeInTheDocument();
  });

  it("starts first-run from the setup nudge", async () => {
    store = makeStore({
      services: { debrid: null, indexers: { activeIndexers: [{}] } },
    });
    render(<App />);
    const startButton = await screen.findByTestId("setup-nudge-start");
    expect(startButton).toBeInTheDocument();
    fireEvent.click(startButton);
    expect(screen.getByTestId("first-run")).toBeInTheDocument();
  });

  it("shows the setup tour from the setup nudge", async () => {
    store = makeStore({
      services: { debrid: null, indexers: { activeIndexers: [{}] } },
    });
    render(<App />);
    fireEvent.click(screen.getByTestId("setup-nudge-show-tour"));
    expect(screen.getByTestId("welcome-guide")).toBeInTheDocument();
  });

  it("closes the setup nudge when dismissed and persists flag", async () => {
    const baseline = new Map<string, string>();
    baseline.set("ds_welcome_guide_seen", "1");
    const safeStorage = {
      getItem: (k: string) => (baseline.has(k) ? baseline.get(k) : null),
      setItem: vi.fn((k: string, v: string) => {
        baseline.set(k, String(v));
      }),
      removeItem: (k: string) => baseline.delete(k),
      clear: () => baseline.clear(),
      key: (i: number) => Array.from(baseline.keys())[i] ?? null,
      get length() {
        return baseline.size;
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: safeStorage,
    });
    store = makeStore({
      services: { debrid: null, indexers: { activeIndexers: [{}] } },
    });
    render(<App />);
    const dismiss = await screen.findByTestId("setup-nudge-dismiss");
    fireEvent.click(dismiss);
    expect(safeStorage.setItem).toHaveBeenCalledWith(
      "ds_setup_nudge_dismissed",
      "1",
    );
    expect(screen.queryByTestId("setup-nudge-dismiss")).not.toBeInTheDocument();
  });

  it("dismisses setup nudge even when localStorage setItem throws", async () => {
    const baseline = new Map<string, string>([["ds_welcome_guide_seen", "1"]]);
    const failingStorage = {
      getItem: (k: string) => (baseline.has(k) ? baseline.get(k) ?? null : null),
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: failingStorage,
    });
    store = makeStore({
      services: { debrid: null, indexers: { activeIndexers: [{}] } },
    });
    render(<App />);
    const dismiss = await screen.findByTestId("setup-nudge-dismiss");
    fireEvent.click(dismiss);
    expect(screen.queryByTestId("setup-nudge-dismiss")).not.toBeInTheDocument();
  });
});

describe("InstallPrompt branch", () => {
  it("renders the install card when install checks pass", async () => {
    installPromptEligibleValue = true;
    render(<App />);
    const card = await screen.findByTestId("install-prompt");
    expect(card).toBeInTheDocument();
    fireEvent.click(card);
    expect(globalThis.localStorage.getItem("ds_pwa_install_dismissed")).toBe("1");
    expect(screen.queryByTestId("install-prompt")).not.toBeInTheDocument();
  });

  it("renders install prompt even when localStorage getItem throws", async () => {
    installPromptEligibleValue = true;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    });
    render(<App />);
    expect(await screen.findByTestId("install-prompt")).toBeInTheDocument();
  });
});

describe("Downloads runtime lifecycle", () => {
  it("starts the local downloads runtime when running in Tauri local mode", () => {
    isTauriValue = true;
    serverModeValue = false;
    startDownloadsRuntimeMock.mockReturnValue(startManager);
    const { unmount } = render(<App />);
    expect(startDownloadsRuntimeMock).toHaveBeenCalledWith(getStoreResult, store.services.debrid);
    unmount();
    expect(stopDownloadsRuntimeMock).toHaveBeenCalledWith(startManager);
  });

  it("does not start the local downloads runtime in server mode", () => {
    isTauriValue = true;
    serverModeValue = true;
    render(<App />);
    expect(startDownloadsRuntimeMock).not.toHaveBeenCalled();
    expect(stopDownloadsRuntimeMock).not.toHaveBeenCalled();
  });
});

describe("smart preload effect", () => {
  it("skips idle preloading when disabled", () => {
    smartPreloadEnabled = false;
    render(<App />);
    expect(whenIdle).not.toHaveBeenCalled();
  });

  it("schedules idle preloading when enabled and executes the callback", () => {
    let executed = 0;
    whenIdle.mockImplementation((callback: () => void) => {
      executed++;
      callback();
    });
    smartPreloadEnabled = true;
    render(<App />);
    expect(whenIdle).toHaveBeenCalledTimes(1);
    expect(executed).toBe(1);
  });
});

// -----------------------------------------------------------------------
// FirstRunHost - the async wizard gate that decides between TierOnboarding,
// FirstRunWizard, ServerSetupWizard, and the App itself. It returns null until
// BOTH the relevant async gate AND store hydration resolve, so most assertions
// use findBy* / waitFor to let the effects settle.
// -----------------------------------------------------------------------

describe("FirstRunHost gating", () => {
  it("renders boot chrome until the store has hydrated", async () => {
    store = makeStore({ hydrated: false });
    const { container } = render(<FirstRunHost />);
    // firstRun resolves to false, but hydrated=false keeps app/wizard decisions
    // gated while a lightweight boot shell prevents a blank window.
    await waitFor(() => {
      // No app or wizard mounts before hydration.
      expect(screen.queryByTestId("nav-rail")).not.toBeInTheDocument();
      expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
    });
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("renders the App once hydrated with no first-run and no server setup", async () => {
    // welcomed flag set so TierOnboarding never shows; not first-run.
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
  });

  it("bypasses key gating when onboarding is developer-disabled", async () => {
    devBypassesOnboardingValue = true;
    firstRunValue = false;
    keyGateValue = true; // ignored
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
  });

  it("forces the app to ignore key gating when keychain reads already failed", async () => {
    secretReadsFailedThisSessionValue = true;
    firstRunValue = false;
    keyGateValue = true; // ignored because keychain failure short-circuit
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();
  });

  it("shows TierOnboarding first on a genuine local first-run, then the FirstRunWizard", async () => {
    firstRunValue = true;
    globalThis.localStorage.removeItem("ds_tier_welcomed");
    render(<FirstRunHost />);

    // Tier welcome precedes the persona wizard on a fresh start.
    const tier = await screen.findByTestId("tier-onboarding");
    expect(tier).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).not.toBeInTheDocument();

    // Acknowledging the welcome persists the flag and reveals the FirstRunWizard.
    fireEvent.click(tier);
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
    expect(globalThis.localStorage.getItem("ds_tier_welcomed")).toBe("1");
  });

  it("shows TierOnboarding when key gate is required and tier welcome was not seen", async () => {
    firstRunValue = false;
    keyGateValue = true;
    globalThis.localStorage.removeItem("ds_tier_welcomed");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("tier-onboarding")).toBeInTheDocument();
  });

  it("skips TierOnboarding when already welcomed and goes straight to the FirstRunWizard", async () => {
    firstRunValue = true;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
    expect(screen.queryByTestId("tier-onboarding")).not.toBeInTheDocument();
  });

  it("completing the FirstRunWizard reveals the App", async () => {
    firstRunValue = true;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    fireEvent.click(await screen.findByTestId("first-run"));
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
  });

  it("forces the wizard when keys are missing even after onboarding completed", async () => {
    firstRunValue = false; // onboarding_completed is set…
    keyGateValue = true; // …but the launch found no catalog key / debrid token
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
  });

  it("key-gated wizard completion reveals the App for this session", async () => {
    firstRunValue = false;
    keyGateValue = true;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    fireEvent.click(await screen.findByTestId("first-run"));
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
  });

  it("uses the server setup branch in tier onboarding gating", async () => {
    serverModeValue = true;
    sessionValue = { role: "owner" };
    firstRunValue = false;
    keyGateValue = false;
    serverSetupValue = true;
    adminHealthCredentials = 2;
    globalThis.localStorage.removeItem("ds_tier_welcomed");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("tier-onboarding")).toBeInTheDocument();
  });

  it("shows the ServerSetupWizard for a fresh server when the owner has no credentials", async () => {
    serverModeValue = true;
    sessionValue = { role: "owner" };
    serverSetupValue = true; // shouldShowServerSetup → true
    adminHealthCredentials = 0;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("server-setup")).toBeInTheDocument();
  });

  it("completing the ServerSetupWizard reveals the App", async () => {
    serverModeValue = true;
    sessionValue = { role: "owner" };
    serverSetupValue = true;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    fireEvent.click(await screen.findByTestId("server-setup"));
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
  });

  it("skips server setup for a non-owner session (resolves straight to App)", async () => {
    serverModeValue = true;
    sessionValue = { role: "member" };
    serverSetupValue = true; // would show, but non-owner short-circuits to false
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("server-setup")).not.toBeInTheDocument();
  });

  it("falls back from server setup when the admin health check fails", async () => {
    serverModeValue = true;
    sessionValue = { role: "owner" };
    serverHealthShouldReject = true;
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    render(<FirstRunHost />);
    expect(await screen.findByTestId("nav-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("server-setup")).not.toBeInTheDocument();
  });

  it("does not apply pending server-setup state updates after unmount", async () => {
    serverModeValue = true;
    sessionValue = { role: "owner" };
    adminHealthCredentials = 2;
    pendingAdminHealthPromise = new Promise(() => {});
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    const { unmount } = render(<FirstRunHost />);
    expect(screen.queryByTestId("server-setup")).not.toBeInTheDocument();
    unmount();
    expect(screen.queryByTestId("server-setup")).not.toBeInTheDocument();
  });

  it("does not apply the resolved server-setup result after unmount", async () => {
    let resolveAdminHealth: (value: { counts: { credentials: number } }) => void = () => {};
    pendingAdminHealthPromise = new Promise((resolve) => {
      resolveAdminHealth = resolve as (value: { counts: { credentials: number } }) => void;
    });
    serverModeValue = true;
    sessionValue = { role: "owner" };
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    const { unmount } = render(<FirstRunHost />);
    unmount();
    resolveAdminHealth({ counts: { credentials: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not apply a failed server-setup result after unmount", async () => {
    let rejectAdminHealth: (reason?: unknown) => void = () => {};
    pendingAdminHealthPromise = new Promise((_, reject) => {
      rejectAdminHealth = reject;
    });
    serverModeValue = true;
    sessionValue = { role: "owner" };
    globalThis.localStorage.setItem("ds_tier_welcomed", "1");
    const { unmount } = render(<FirstRunHost />);
    unmount();
    rejectAdminHealth(new Error("network offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back to the tier-welcome safely when localStorage throws", async () => {
    // Private-mode style: getItem throws → welcomed defaults to true, so no
    // TierOnboarding even on a first-run; the FirstRunWizard shows directly.
    firstRunValue = true;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    });
    render(<FirstRunHost />);
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
    expect(screen.queryByTestId("tier-onboarding")).not.toBeInTheDocument();
  });
});
