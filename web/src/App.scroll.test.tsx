// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, FirstRunHost } from "./App";
import { AppStoreProvider, useAppStore, type AppStore } from "./store/AppStore";
import { ServerSessionProvider, useSetServerSession, type ServerSession } from "./lib/ServerSessionContext";
import { registerPlayerMount } from "./lib/attention";
import type { ScreenId } from "./components/NavRail";

let serverMode = false;
let activeId = "default";
const profiles = [
  { id: "default", name: "First", isAdmin: true, isDefault: true, createdAt: 1 },
  { id: "second", name: "Second", isAdmin: false, isDefault: false, createdAt: 2 },
];
const makeSettings = () => ({ appearanceDefaultTab: "discover", networkMode: "online", simpleMode: false, interfaceLanguage: "en" });
let settings = makeSettings();
// Real AppStore commands/history/profile switching; only persistence, network
// dependencies and screen bodies are fixtures.
vi.mock("./data/settings", () => ({
  loadSettings: () => settings, loadSettingsFromStore: async () => settings,
  applyDesignRefresh: (v: unknown) => v, markDesignRefreshApplied: () => {}, saveSettingsToStore: async () => {},
  buildServices: () => ({ hasDebrid: false, debrid: { hasServices: true }, indexers: { activeIndexers: [{}] } }),
}));
vi.mock("./data/calendar", () => ({ useCalendar: () => ({ episodes: [], loading: false, error: null }), episodesAiredSince: () => 0 }));
vi.mock("./data/calendarNotifications", () => ({ loadOrInitializeCalendarLastSeenAt: async () => 1, saveCalendarLastSeenAt: async () => {} }));
vi.mock("./data/library", () => ({ loadWatchlist: async () => [], loadHistory: async () => [], loadContinueWatching: async () => [], recordHistory: async () => [], removeFromWatchlistStore: async () => [], toggleWatchlistStore: async () => [] }));
vi.mock("./storage", () => ({ getStore: () => ({ listCachedResolutions: async () => [], getCachedResolutions: async () => [] }), swapLocalProfileStore: async () => {} }));
vi.mock("./storage/RemoteStore", () => ({ RemoteStore: class {} }));
vi.mock("./lib/autoResolve", () => ({ AutoResolveScheduler: class { start() {} stop() {} async kick() {} } }));
vi.mock("./lib/serverMode", () => ({ isServerMode: () => serverMode, configuredServerURL: () => null }));
vi.mock("./lib/networkPolicy", () => ({ setNetworkMode: () => {} }));
vi.mock("./lib/passwordHash", () => ({ verifyPassword: async () => true }));
vi.mock("./storage/ProfileRegistry", () => ({
  dbNameForProfile: () => "fixture", ensureDefaultProfile: async () => profiles[0],
  getActiveProfileId: async () => activeId, getProfile: async (id: string) => profiles.find((p) => p.id === id),
  isMultiUserEnabled: async () => true, listProfiles: async () => profiles.map((p) => ({ ...p })),
  setActiveProfileId: async (id: string) => { activeId = id; }, updateProfileRecord: async () => {}, getAutoEnterProfileId: async () => "default",
}));
vi.mock("./theme/useTheme", () => ({ useTheme: () => {} }));
vi.mock("./lib/smartPreload", () => ({ isSmartPreloadEnabled: () => false, whenIdle: () => {} }));
vi.mock("./lib/tauri", () => ({ isTauri: () => false }));
vi.mock("./lib/tvMode", () => ({ isTVMode: () => false }));
vi.mock("./lib/firstRun", () => ({ isFirstRun: async () => false, devBypassesOnboarding: () => true, hasQuickSetupAcknowledgement: async () => true, needsKeyOnboarding: () => false }));
vi.mock("./storage/KeychainSecretStore", () => ({ secretReadsFailedThisSession: () => false }));
vi.mock("./lib/installPrompt", async (original) => ({
  ...await original<typeof import("./lib/installPrompt")>(),
  isInstallPromptEligible: () => false,
}));
vi.mock("./components/InstallPrompt", () => ({ InstallPrompt: () => null, isInstallPromptEligible: () => false }));
vi.mock("./components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("./components/HostAvailabilityBanner", () => ({ HostAvailabilityBanner: () => null }));
vi.mock("./components/BandwidthWarningBanner", () => ({ BandwidthWarningBanner: () => null }));
vi.mock("./components/ProfileMenu", () => ({ ProfileMenu: () => null }));
vi.mock("./components/LocalProfilePicker", () => ({ LocalProfilePicker: () => null }));
vi.mock("./components/GlobalSearch", () => ({ GlobalSearch: () => <button onClick={() => store().search("synthetic query")}>global-search</button> }));
vi.mock("./components/NavRail", async (original) => ({
  ...await original<typeof import("./components/NavRail")>(),
  NavRail: ({ onSelect }: { onSelect: (r: ScreenId) => void }) => <nav>{(["discover", "watchlist", "search", "history"] as const).map((r) => <button key={r} onClick={() => onSelect(r)}>nav-{r}</button>)}</nav>,
}));
vi.mock("./screens/Discover", () => ({ Discover: () => <FixtureScreen route="discover" /> }));
vi.mock("./screens/Watchlist", () => ({ Watchlist: () => <FixtureScreen route="watchlist" /> }));
vi.mock("./screens/Search", () => ({ Search: () => <FixtureScreen route="search" /> }));
vi.mock("./screens/History", () => ({ History: () => <FixtureScreen route="history" /> }));
vi.mock("./screens/Library", () => ({ Library: () => <FixtureScreen route="library" /> }));
vi.mock("./screens/Settings", () => ({ Settings: () => <FixtureScreen route="settings" /> }));
vi.mock("./screens/Detail", () => ({ Detail: () => <div data-testid="detail-overlay" /> }));
vi.mock("./screens/Browse", () => ({ Browse: () => <div data-testid="browse-overlay" /> }));
vi.mock("./components/LocalPlayerHost", () => ({ LocalPlayerHost: () => useAppStore().localFilePlayer == null ? null : <FixturePlayer /> }));

let currentStore: AppStore | undefined;
let setSession: (session: ServerSession | null) => void;
function store(): AppStore { if (!currentStore) throw new Error("Store probe not mounted"); return currentStore; }
function StoreProbe() { currentStore = useAppStore(); setSession = useSetServerSession(); return null; }
function FixturePlayer() { useEffect(registerPlayerMount, []); return <div data-testid="player-overlay" />; }
type Port = { top: number; limit: number };
let ports: WeakMap<HTMLElement, Port>;
let initialOffset = 0;
let events: Array<{ kind: string; route?: string; top: number }>;
let passiveOffsets: Array<{ route: string; top: number }>;
const limits: Record<string, number> = { discover: 2400, watchlist: 244.5, search: 1200, history: 900 };
function port(el: HTMLElement): Port { let v = ports.get(el); if (!v) { v = { top: initialOffset, limit: 2400 }; ports.set(el, v); } return v; }
function main(): HTMLElement { return document.getElementById("main-content")!; }
function FixtureScreen({ route }: { route: string }) {
  const [value, setValue] = useState("");
  const api = useAppStore();
  useLayoutEffect(() => {
    // jsdom has no layout. Model the browser overflow clamp on destination
    // commit BEFORE the ancestor App layout effect, using the observed 244.5px limit.
    const p = port(main()); p.limit = limits[route] ?? 1600; p.top = Math.min(p.top, p.limit);
    events.push({ kind: "destination-layout-clamp", route, top: p.top });
  }, [route]);
  useEffect(() => { passiveOffsets.push({ route, top: main().scrollTop }); }, [route]);
  useEffect(() => { if (route === "search" && api.pendingSearch != null) { setValue(api.pendingSearch); api.consumePendingSearch(); } }, [api, route]);
  return <section data-testid={`screen-${route}`}><input aria-label="screen-local-state" value={value} onChange={(e) => setValue(e.target.value)} /></section>;
}
const sessionA: ServerSession = { profileId: "server-a", username: "fixture", displayName: "First", role: "member", simpleMode: false };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let originalScrollTop: PropertyDescriptor | undefined;
beforeEach(() => {
  serverMode = false; activeId = "default"; settings = makeSettings(); currentStore = undefined;
  ports = new WeakMap(); initialOffset = 0; events = []; passiveOffsets = []; frames = new Map(); nextFrame = 0;
  window.history.replaceState(null, "", "/");
  const values = new Map([["ds_welcome_guide_seen", "1"], ["ds_setup_nudge_dismissed", "1"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear(), key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } });
  originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true,
    get() { return this.id === "main-content" ? port(this).top : 0; },
    set(value: number) { if (this.id !== "main-content") return; const p = port(this); p.top = Math.max(0, Math.min(value, p.limit)); events.push({ kind: "scroll-write", top: p.top }); },
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { const id = ++nextFrame; frames.set(id, cb); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(() => { cleanup(); if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop); else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountApp(options: { strict?: boolean; gated?: boolean; session?: ServerSession } = {}) {
  const tree = <ServerSessionProvider initial={options.session ?? null}><AppStoreProvider>{options.gated ? <FirstRunHost /> : <App />}<StoreProbe /></AppStoreProvider></ServerSessionProvider>;
  const view = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  await waitFor(() => { expect(store().hydrated).toBe(true); if (!serverMode) expect(store().activeProfile?.id).toBe(activeId); expect(main()).not.toBeNull(); });
  return view;
}
async function changeRoute(route: ScreenId) { act(() => store().navigate(route)); await screen.findByTestId(`screen-${route}`); }
async function traverse(direction: "back" | "forward") { await act(async () => { const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true })); window.history[direction](); await popped; }); }
const item = { id: "synthetic-title", title: "Fixture", type: "movie" as const, year: 2024, posterPath: null, backdropPath: null };

describe("App route scroll ownership", () => {
  it("resets the persistent scrollport after destination overflow clamping and before passive effects", async () => {
    await mountApp(); const persistentMain = main(); main().scrollTop = 1624; events = [];
    fireEvent.click(screen.getByText("nav-watchlist")); await screen.findByTestId("screen-watchlist");
    expect(main()).toBe(persistentMain); expect(events).toContainEqual({ kind: "destination-layout-clamp", route: "watchlist", top: 244.5 }); expect(main().scrollTop).toBe(0);
    expect(events.findIndex((e) => e.kind === "scroll-write" && e.top === 0)).toBeGreaterThan(events.findIndex((e) => e.kind === "destination-layout-clamp"));
    expect(passiveOffsets.at(-1)).toEqual({ route: "watchlist", top: 0 });
    main().scrollTop = 180; fireEvent.click(screen.getByText("nav-discover")); expect(main().scrollTop).toBe(0);
  });
  it.each(["navigate", "global-search"] as const)("starts the fresh destination at top through %s", async (via) => {
    await mountApp(); main().scrollTop = 1624; if (via === "navigate") await changeRoute("search"); else { fireEvent.click(screen.getByText("global-search")); await screen.findByTestId("screen-search"); }
    expect(store().route).toBe("search"); expect(main().scrollTop).toBe(0);
  });
  it("starts newly remounted Back and Forward destinations at top without pixel bookmarks", async () => {
    await mountApp(); await changeRoute("watchlist"); main().scrollTop = 180; fireEvent.change(screen.getByLabelText("screen-local-state"), { target: { value: "folder-state" } });
    await changeRoute("search"); main().scrollTop = 700; await traverse("back");
    expect(store().route).toBe("watchlist"); expect(screen.getByLabelText("screen-local-state")).toHaveValue(""); expect(main().scrollTop).toBe(0);
    main().scrollTop = 180; await traverse("forward"); expect(store().route).toBe("search"); expect(main().scrollTop).toBe(0);
  });
  it("clears an initial restored main offset when the shell first mounts", async () => { initialOffset = 244.5; await mountApp(); expect(main().scrollTop).toBe(0); expect(passiveOffsets[0]?.top).toBe(0); });
  it("starts the durable bootstrap default destination at top", async () => { settings.appearanceDefaultTab = "watchlist"; initialOffset = 244.5; await mountApp({ gated: true }); await screen.findByTestId("screen-watchlist"); expect(store().route).toBe("watchlist"); expect(main().scrollTop).toBe(0); });
  it("starts a history-restored route at top on a fresh provider mount", async () => { const first = await mountApp(); await changeRoute("watchlist"); main().scrollTop = 180; first.unmount(); initialOffset = 244.5; await mountApp(); await screen.findByTestId("screen-watchlist"); expect(main().scrollTop).toBe(0); });
  it("clears the previous local profile position on an actual profile switch", async () => { await mountApp(); main().scrollTop = 900; await act(async () => { expect(await store().switchLocalProfile("second")).toEqual({ ok: true }); }); expect(store().activeProfile?.id).toBe("second"); expect(store().route).toBe("discover"); expect(main().scrollTop).toBe(0); });
  it("clears the previous server profile position even while the route stays the same", async () => { serverMode = true; await mountApp({ session: sessionA }); main().scrollTop = 900; act(() => setSession({ ...sessionA, profileId: "server-b", displayName: "Second" })); expect(store().route).toBe("discover"); expect(main().scrollTop).toBe(0); });
  it.each(["detail", "browse", "player"] as const)("preserves the covered screen position while %s opens and closes through managed history", async (overlay) => {
    await mountApp(); main().scrollTop = 900; events = [];
    act(() => { if (overlay === "detail") store().openDetail(item); else if (overlay === "browse") store().openBrowse({ kind: "category", type: "movie", category: "popular" }); else store().playLocalFile("/synthetic.mp4", "Fixture"); });
    await screen.findByTestId(`${overlay}-overlay`); expect(main().scrollTop).toBe(900); await traverse("back"); await waitFor(() => expect(screen.queryByTestId(`${overlay}-overlay`)).not.toBeInTheDocument());
    expect(main().scrollTop).toBe(900); expect(events.filter((e) => e.kind === "scroll-write")).toEqual([]);
  });
  it("preserves active-tab position and same-route search updates", async () => { await mountApp(); main().scrollTop = 900; fireEvent.click(screen.getByText("nav-discover")); expect(main().scrollTop).toBe(900); await changeRoute("search"); main().scrollTop = 700; act(() => store().search("replacement query")); await waitFor(() => expect(screen.getByLabelText("screen-local-state")).toHaveValue("replacement query")); expect(main().scrollTop).toBe(700); });
  it("does not reset for same-identity profile refresh, locale or unrelated data updates", async () => { await mountApp(); main().scrollTop = 900; events = []; await act(async () => { await store().refreshProfiles(); await store().reloadProfileData(); }); await act(async () => { await store().updateSettings({ ...store().settings, interfaceLanguage: "fr" }); }); expect(main().scrollTop).toBe(900); expect(events.filter((e) => e.kind === "scroll-write")).toEqual([]); });
  it("resets synchronously while retaining preventScroll focus and safe unmount under StrictMode", async () => {
    const view = await mountApp({ strict: true }); main().scrollTop = 900; await changeRoute("watchlist"); expect(main().scrollTop).toBe(0);
    const focus = vi.spyOn(HTMLElement.prototype, "focus"); act(() => { for (const [id, cb] of frames) { frames.delete(id); cb(16); } }); expect(focus).toHaveBeenCalledWith({ preventScroll: true }); expect(main().scrollTop).toBe(0);
    main().scrollTop = 180; fireEvent.click(screen.getByText("nav-watchlist")); expect(main().scrollTop).toBe(180); await changeRoute("history"); const detached = main(); detached.scrollTop = 300; const stale = [...frames.values()]; view.unmount(); act(() => stale.forEach((cb) => cb(32))); expect(detached.scrollTop).toBe(300); expect(frames.size).toBe(0);
  });
});
