// App store - the single source of truth for routing, the Detail overlay, the
// shared service instances, and the persisted settings / watchlist / history.
// Implemented as a small React context + provider (no extra deps), with a
// `useAppStore()` hook plus a couple of focused selector hooks.
//
// Persistence is the storage port: a typed, cross-platform `Store` (IndexedDB
// via Dexie) that works in a plain browser AND the Tauri webview. The provider
// renders immediately from a synchronous bootstrap (env defaults + the legacy
// localStorage snapshot), then hydrates from the durable Store on mount; every
// mutation writes through the Store and refreshes the in-memory state.
//
// Services rebuild only when their keys/tokens/sources change, so saving a TMDB
// key lights up live data without making unrelated preference saves restart
// service consumers. Everything imports the ported services READ-ONLY.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ScreenId } from "../components/NavRail";
import type { MediaPreview } from "../models/media";
import type { BrowseContext } from "../data/browse";
import {
  type AppServices,
  type AppSettings,
  applyDesignRefresh,
  buildServices,
  loadSettings,
  loadSettingsFromStore,
  markDesignRefreshApplied,
  saveSettingsToStore,
} from "../data/settings";
import { useCalendar, type CalendarState } from "../data/calendar";
import {
  loadOrInitializeCalendarLastSeenAt,
  saveCalendarLastSeenAt,
} from "../data/calendarNotifications";
import {
  loadContinueWatching,
  loadHistory,
  loadWatchlist,
  recordHistory,
  removeFromWatchlist as removeFromWatchlistStore,
  toggleWatchlist as toggleWatchlistStore,
} from "../data/library";
import type {
  CachedResolutionRecord,
  PlaybackPrefs,
  WatchHistoryRecord,
} from "../storage/models";
import { getStore, swapLocalProfileStore } from "../storage";
import { RemoteStore } from "../storage/RemoteStore";
import { AutoResolveScheduler } from "../lib/autoResolve";
import { isServerMode } from "../lib/serverMode";
import { setNetworkMode } from "../lib/networkPolicy";
import { useServerSession } from "../lib/ServerSessionContext";
import { verifyPassword } from "../lib/passwordHash";
import type { SettingsSection } from "../lib/settingsNavigation";
import {
  dbNameForProfile,
  ensureDefaultProfile,
  getActiveProfileId,
  getProfile,
  isMultiUserEnabled,
  listProfiles,
  setActiveProfileId,
  updateProfileRecord,
  type LocalProfile,
} from "../storage/ProfileRegistry";

// Password unlocks deliberately live only for this renderer session. A reload
// returns protected Local Mode profiles to their lock screen.
const unlockedProfileIds = new Set<string>();

export function isLocalProfileUnlocked(id: string): boolean {
  return unlockedProfileIds.has(id);
}

/** Outcome of a durable settings write. Reported rather than thrown so the many
 *  fire-and-forget callers can't produce unhandled rejections. */
export interface SaveResult {
  ok: boolean;
}

/**
 * Browser-history entries intentionally describe UI navigation only. They do
 * not contain playback progress, service instances, or any other live data.
 * That keeps an entry structured-cloneable and lets a reload safely restore the
 * current screen without attempting to resume a stream.
 */
export type NavigationHistoryLayer =
  | "none"
  | "filters"
  | "trailer"
  | "detail-player"
  | "local-player";

export interface NavigationHistoryEntry {
  debridStreamerNavigation: 1;
  depth: number;
  route: ScreenId;
  browseContext: BrowseContext | null;
  detailItem: MediaPreview | null;
  layer: NavigationHistoryLayer;
  localFilePlayer: { path: string; title: string } | null;
}

const NAVIGATION_HISTORY_LAYERS = new Set<NavigationHistoryLayer>([
  "none",
  "filters",
  "trailer",
  "detail-player",
  "local-player",
]);

const SCREEN_IDS = new Set<ScreenId>([
  "discover",
  "search",
  "library",
  "watchlist",
  "calendar",
  "history",
  "assistant",
  "debrid",
  "downloads",
  "settings",
]);

/** Read only entries created by this app. Other same-document history entries
 * must remain opaque so Back can still leave the app when it reaches them. */
export function readNavigationHistoryEntry(
  state: unknown,
): NavigationHistoryEntry | null {
  if (state == null || typeof state !== "object") return null;
  const candidate = state as Partial<NavigationHistoryEntry>;
  if (
    candidate.debridStreamerNavigation !== 1 ||
    typeof candidate.depth !== "number" ||
    !Number.isInteger(candidate.depth) ||
    candidate.depth < 0 ||
    typeof candidate.route !== "string" ||
    !SCREEN_IDS.has(candidate.route as ScreenId) ||
    !NAVIGATION_HISTORY_LAYERS.has(candidate.layer as NavigationHistoryLayer)
  ) {
    return null;
  }
  if (
    (candidate.browseContext != null && typeof candidate.browseContext !== "object") ||
    (candidate.detailItem != null && typeof candidate.detailItem !== "object") ||
    (candidate.localFilePlayer != null &&
      (typeof candidate.localFilePlayer !== "object" ||
        typeof candidate.localFilePlayer.path !== "string" ||
        typeof candidate.localFilePlayer.title !== "string"))
  ) {
    return null;
  }
  return candidate as NavigationHistoryEntry;
}

function makeNavigationHistoryEntry(
  entry: Omit<NavigationHistoryEntry, "debridStreamerNavigation">,
): NavigationHistoryEntry {
  return { debridStreamerNavigation: 1, ...entry };
}

function browserHistoryAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.history?.pushState === "function" &&
    typeof window.history?.replaceState === "function"
  );
}

export interface AppStore {
  // Routing
  route: ScreenId;
  navigate: (route: ScreenId, options?: { replace?: boolean }) => void;
  pendingSettingsSection: SettingsSection | null;
  openSettingsSection: (section: SettingsSection) => void;
  clearPendingSettingsSection: () => void;

  // Detail overlay
  detailItem: MediaPreview | null;
  openDetail: (item: MediaPreview) => void;
  closeDetail: () => void;

  // Desktop local-file player. This is separate from Detail's stream player so
  // completed downloads can be played from any screen without fabricating a
  // debrid stream.
  localFilePlayer: { path: string; title: string } | null;
  playLocalFile: (path: string, title: string) => void;
  closeLocalFilePlayer: () => void;

  // Browse overlay ("See all" + advanced filters). Non-null mounts the Browse
  // screen over the current content (like Detail). Opened from rail "See all"
  // headers and Search with a context (category | genre | discover | search).
  browseContext: BrowseContext | null;
  openBrowse: (ctx: BrowseContext) => void;
  /** Replace the active Browse target without adding another overlay layer. */
  updateBrowseContext: (ctx: BrowseContext) => void;
  closeBrowse: () => void;

  // Browse's nested FilterSlideover is part of the browser Back stack rather
  // than component-local state, so Back can dismiss it without closing Browse.
  browseFiltersOpen: boolean;
  openBrowseFilters: () => void;
  closeBrowseFilters: () => void;

  // Detail's transient overlays follow the same stack. `detailPlayerOpen` is
  // only a live close signal: a popped player entry returns to Detail rather
  // than trying to resurrect an expired stream URL on browser Forward.
  trailerOpen: boolean;
  openTrailer: () => void;
  closeTrailer: () => void;
  detailPlayerOpen: boolean;
  openDetailPlayer: () => void;
  closeDetailPlayer: () => void;

  // A pending query handed to the Search screen from the global search field.
  pendingSearch: string | null;
  search: (query: string) => void;
  consumePendingSearch: () => void;

  // Shared, read-only service instances (rebuilt when settings change).
  services: AppServices;

  // Settings (storage-port backed)
  settings: AppSettings;
  /** Applies in memory immediately and persists. Resolves to `{ok: false}` when
   *  the durable write fails, so a caller that reports success can avoid
   *  claiming a save that did not happen. Never rejects - safe to ignore. */
  updateSettings: (next: AppSettings) => Promise<SaveResult>;
  /** Effective Simple/Advanced experience: Server Mode reads the profile
   * session; Local Mode reads AppSettings. Drives progressive disclosure. */
  simpleMode: boolean;
  /** True once the durable Store has hydrated over the bootstrap defaults. */
  hydrated: boolean;

  // Calendar releases and their per-profile in-app notification watermark.
  // This is in-app only. OS/push notifications and a notification center are
  // follow-up work that need a delivery service.
  calendar: CalendarState;
  calendarLastSeenAt: number | null;
  markCalendarSeen: () => void;
  refreshCalendar: () => void;

  // Watchlist + History (storage-port backed)
  watchlist: MediaPreview[];
  history: MediaPreview[];
  /** Incomplete items with resume positions (the Continue Watching rail). */
  continueWatching: WatchHistoryRecord[];
  /** Re-read only Continue Watching after a playback session closes. Waits for
   * any final progress write already in flight before loading the slice. */
  refreshContinueWatching: () => Promise<void>;
  /** Re-read the cached-resolution table from the Store (after a pass). */
  refreshCachedResolutions: () => void;
  toggleWatchlist: (item: MediaPreview) => void;
  removeFromWatchlist: (id: string) => void;
  /** Bulk-add already-resolved previews to the watchlist (used by import),
   * skipping any already present. Refreshes state + kicks a pre-resolve pass
   * once at the end. Resolves to how many were added vs skipped. */
  importToWatchlist: (
    previews: MediaPreview[],
  ) => Promise<{ added: number; skipped: number }>;
  /** Re-hydrate all per-profile data from the Store (watchlist / history /
   * continue-watching / settings). Called after a Server-Mode "who's watching"
   * profile switch so the UI reflects the newly-active profile's data. */
  reloadProfileData: () => Promise<void>;
  /** Local Mode profile registry state. Server Mode continues to use its
   * session profile context and never reads this registry. */
  activeProfile: LocalProfile | null;
  profiles: LocalProfile[];
  multiUserEnabled: boolean;
  refreshProfiles: () => Promise<void>;
  switchLocalProfile: (
    id: string,
    password?: string,
  ) => Promise<{ ok: boolean; reason?: "bad-password" | "not-found" }>;
  /** Record a real resume position (called from the player). For series pass
   *  the playing episode's id (`s2e5`); movies omit it / pass null. */
  recordResume: (
    item: MediaPreview,
    progressSeconds: number,
    durationSeconds: number | null,
    episodeId?: string | null,
    prefs?: PlaybackPrefs,
  ) => void;
}

/** Stable command/service access for shell controls that do not render data. */
export interface AppActions {
  /** Read the current services inside an event path. Render-time service users
   * stay on useAppStore so a configuration change can update their UI. */
  getServices: () => AppServices;
  navigate: AppStore["navigate"];
  openDetail: AppStore["openDetail"];
  closeDetail: AppStore["closeDetail"];
  openBrowse: AppStore["openBrowse"];
  updateBrowseContext: AppStore["updateBrowseContext"];
  closeBrowse: AppStore["closeBrowse"];
  search: AppStore["search"];
  consumePendingSearch: AppStore["consumePendingSearch"];
  updateSettings: AppStore["updateSettings"];
  refreshContinueWatching: AppStore["refreshContinueWatching"];
  refreshCachedResolutions: AppStore["refreshCachedResolutions"];
  toggleWatchlist: AppStore["toggleWatchlist"];
  removeFromWatchlist: AppStore["removeFromWatchlist"];
  importToWatchlist: AppStore["importToWatchlist"];
  reloadProfileData: AppStore["reloadProfileData"];
  refreshProfiles: AppStore["refreshProfiles"];
  switchLocalProfile: AppStore["switchLocalProfile"];
  recordResume: AppStore["recordResume"];
}

const AppStoreContext = createContext<AppStore | null>(null);
const AppActionsContext = createContext<AppActions | null>(null);
const CachedResolutionsContext = createContext<Record<
  string,
  CachedResolutionRecord
> | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<ScreenId>("discover");
  const [detailItem, setDetailItem] = useState<MediaPreview | null>(null);
  const [localFilePlayer, setLocalFilePlayer] = useState<{
    path: string;
    title: string;
  } | null>(null);
  const [browseContext, setBrowseContext] = useState<BrowseContext | null>(null);
  const [browseFiltersOpen, setBrowseFiltersOpen] = useState(false);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [detailPlayerOpen, setDetailPlayerOpen] = useState(false);
  const [pendingSearch, setPendingSearch] = useState<string | null>(null);

  // History mutations happen only through the navigation commands below. A
  // popstate must update React state, but must never manufacture a replacement
  // entry while doing so or browser Back would appear to do nothing.
  const isApplyingPopState = useRef(false);
  const historyReady = useRef(false);
  const restoredRouteFromHistory = useRef(false);
  // Applying Browse filters closes a nested history layer and replaces the
  // Browse descriptor underneath it. Carry the new context across that one
  // asynchronous popstate so Back does not reveal the stale pre-filter target.
  const pendingBrowseContextReplacement = useRef<BrowseContext | null>(null);

  const replaceNavigationHistory = useCallback((entry: NavigationHistoryEntry) => {
    if (!browserHistoryAvailable() || isApplyingPopState.current) return;
    window.history.replaceState(entry, "", window.location.href);
  }, []);

  const pushNavigationHistory = useCallback(
    (
      entry: Omit<NavigationHistoryEntry, "debridStreamerNavigation" | "depth">,
      options?: { replace?: boolean },
    ) => {
      if (!browserHistoryAvailable() || isApplyingPopState.current) return;
      const current = readNavigationHistoryEntry(window.history.state);
      // A forced redirect (e.g. a now-hidden screen bouncing to Discover) must
      // REPLACE the current entry rather than add a Back step. Otherwise Back
      // restores the hidden route, the redirect fires and pushes again, and the
      // user is trapped in a redirect<->Discover loop.
      if (options?.replace === true && current != null) {
        window.history.replaceState(
          makeNavigationHistoryEntry({ depth: current.depth, ...entry }),
          "",
          window.location.href,
        );
        return;
      }
      // A fresh document (or an older app build) has no managed root yet. Mark
      // the current entry first, then add the requested layer above it.
      if (current == null) {
        replaceNavigationHistory(
          makeNavigationHistoryEntry({
            depth: 0,
            route,
            browseContext: null,
            detailItem: null,
            layer: "none",
            localFilePlayer: null,
          }),
        );
      }
      const depth = (current?.depth ?? 0) + 1;
      window.history.pushState(
        makeNavigationHistoryEntry({ depth, ...entry }),
        "",
        window.location.href,
      );
    },
    [replaceNavigationHistory, route],
  );

  /** Return to the immediately previous managed entry when a close button or
   * Escape dismisses an overlay. The direct setter fallback is only for a
   * malformed/legacy history state, where calling Back could leave the app. */
  const goBackForClose = useCallback((fallback: () => void): void => {
    if (!browserHistoryAvailable() || isApplyingPopState.current) {
      fallback();
      return;
    }
    const current = readNavigationHistoryEntry(window.history.state);
    if (!historyReady.current || current == null || current.depth === 0) {
      fallback();
      return;
    }
    // Close controls should feel immediate. The subsequent popstate restores
    // the parent descriptor (for example Browse beneath Detail) without adding
    // an entry, and this direct state change is harmless if Back is delayed.
    fallback();
    window.history.back();
  }, []);

  // Synchronous bootstrap so the first paint has something sane; the durable
  // Store hydrates over it on mount.
  const [settings, setSettings] = useState<AppSettings>(() => {
    const initial = loadSettings();
    // Apply the persisted privacy mode SYNCHRONOUSLY on first render, before any
    // child effect (auto-update check, discover fetch) can fire, so a fullLocal
    // or offline user never has a boot window running under the default mode.
    setNetworkMode(initial.networkMode);
    return initial;
  });
  const [watchlist, setWatchlist] = useState<MediaPreview[]>([]);
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;
  const [history, setHistory] = useState<MediaPreview[]>([]);
  const [continueWatching, setContinueWatching] = useState<WatchHistoryRecord[]>(
    [],
  );
  const pendingResumeWritesRef = useRef<Set<Promise<unknown>>>(new Set());
  const [cachedResolutions, setCachedResolutions] = useState<
    Record<string, CachedResolutionRecord>
  >({});
  // True once the durable Store has hydrated over the synchronous bootstrap. The
  // first-run wizard waits for this so its choice (e.g. Advanced → simpleMode
  // false) isn't racily clobbered by a late hydration setSettings().
  const [hydrated, setHydrated] = useState(false);
  const [calendarLastSeenAt, setCalendarLastSeenAt] = useState<number | null>(null);
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);
  const [pendingSettingsSection, setPendingSettingsSection] = useState<SettingsSection | null>(null);
  const [activeProfile, setActiveProfile] = useState<LocalProfile | null>(null);
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [multiUserEnabled, setMultiUserEnabledState] = useState(true);

  type AuxiliarySlice =
    | "watchlist"
    | "history"
    | "continueWatching"
    | "cachedResolutions"
    | "calendarLastSeenAt";
  type ForegroundAuxiliarySlice = Extract<
    AuxiliarySlice,
    "history" | "continueWatching" | "cachedResolutions"
  >;
  const profileReadGenerationRef = useRef(0);
  const watchlistReadyGenerationRef = useRef<number | null>(null);
  const [watchlistReadyGeneration, setWatchlistReadyGeneration] = useState<number | null>(null);
  const auxiliaryRevisionsRef = useRef<Record<AuxiliarySlice, number>>({
    watchlist: 0,
    history: 0,
    continueWatching: 0,
    cachedResolutions: 0,
    calendarLastSeenAt: 0,
  });
  // User mutations and profile changes own auxiliaryRevisionsRef. Foreground
  // reads need a separate ordering domain: the newest successful request wins,
  // while a newer rejection must not suppress an older success or bootstrap.
  const foregroundRefreshRef = useRef<{
    nextRequest: number;
    latestSuccessful: Record<ForegroundAuxiliarySlice, number>;
  }>({
    nextRequest: 0,
    latestSuccessful: {
      history: 0,
      continueWatching: 0,
      cachedResolutions: 0,
    },
  });
  const [durableProfileReady, setDurableProfileReady] = useState(false);
  const [auxiliaryLoadRequest, setAuxiliaryLoadRequest] = useState<{
    generation: number;
    revisions: Record<AuxiliarySlice, number>;
    foregroundSuccessful: Record<ForegroundAuxiliarySlice, number>;
  } | null>(null);

  const bumpAuxiliaryRevision = useCallback((slice: AuxiliarySlice): number => {
    auxiliaryRevisionsRef.current[slice] += 1;
    return auxiliaryRevisionsRef.current[slice];
  }, []);

  const invalidateProfileReads = useCallback((): number => {
    const generation = profileReadGenerationRef.current + 1;
    profileReadGenerationRef.current = generation;
    watchlistReadyGenerationRef.current = null;
    setWatchlistReadyGeneration(null);
    setDurableProfileReady(false);
    setAuxiliaryLoadRequest(null);
    // A profile boundary must never render the previous profile's library,
    // activity, resume rows, cache badges, or notification watermark while the
    // replacement reads are pending.
    watchlistRef.current = [];
    setWatchlist([]);
    setHistory([]);
    setContinueWatching([]);
    setCachedResolutions({});
    setCalendarLastSeenAt(null);
    return generation;
  }, []);

  const auxiliaryReadIsCurrent = useCallback(
    (generation: number, slice: AuxiliarySlice, revision: number): boolean =>
      profileReadGenerationRef.current === generation &&
      auxiliaryRevisionsRef.current[slice] === revision,
    [],
  );

  useEffect(() => () => {
    // Fence every deferred continuation, including one started by a later
    // profile reload rather than the original mount hydration.
    profileReadGenerationRef.current += 1;
  }, []);

  const loadAuxiliaryProfileSlices = useCallback(async (request: {
    generation: number;
    revisions: Record<AuxiliarySlice, number>;
    foregroundSuccessful: Record<ForegroundAuxiliarySlice, number>;
    strict?: boolean;
  }) => {
    const { generation, revisions, foregroundSuccessful, strict = false } = request;
    const watchlistRevision = revisions.watchlist;
    const historyRevision = revisions.history;
    const continueWatchingRevision = revisions.continueWatching;
    const cachedRevision = revisions.cachedResolutions;
    const calendarRevision = revisions.calendarLastSeenAt;
    const readAuxiliary = async <T,>(read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (strict) throw error;
        return fallback;
      }
    };

    const watchlistTask = (async () => {
      const loaded = await readAuxiliary(loadWatchlist, []);
      if (!auxiliaryReadIsCurrent(generation, "watchlist", watchlistRevision)) return;
      watchlistReadyGenerationRef.current = generation;
      setWatchlistReadyGeneration(generation);
      watchlistRef.current = loaded;
      setWatchlist(loaded);

      // Cache hydration is deliberately keyed by the watchlist snapshot. A
      // full cache-table scan is unnecessary at boot and grows without bound.
      if (
        !auxiliaryReadIsCurrent(generation, "cachedResolutions", cachedRevision) ||
        foregroundRefreshRef.current.latestSuccessful.cachedResolutions !==
          foregroundSuccessful.cachedResolutions
      ) {
        return;
      }
      const rows = loaded.length === 0
        ? []
        : await readAuxiliary(
            () => getStore().getCachedResolutions(loaded.map((item) => item.id)),
            [],
          );
      if (
        !auxiliaryReadIsCurrent(generation, "watchlist", watchlistRevision) ||
        !auxiliaryReadIsCurrent(generation, "cachedResolutions", cachedRevision) ||
        foregroundRefreshRef.current.latestSuccessful.cachedResolutions !==
          foregroundSuccessful.cachedResolutions
      ) {
        return;
      }
      const map: Record<string, CachedResolutionRecord> = {};
      for (const row of rows) map[row.mediaId] = row;
      setCachedResolutions(map);
    })();

    const historyTask = readAuxiliary(loadHistory, [])
      .then((loaded) => {
        if (
          auxiliaryReadIsCurrent(generation, "history", historyRevision) &&
          foregroundRefreshRef.current.latestSuccessful.history ===
            foregroundSuccessful.history
        ) {
          setHistory(loaded);
        }
      });
    const continueWatchingTask = readAuxiliary(loadContinueWatching, [])
      .then((loaded) => {
        if (
          auxiliaryReadIsCurrent(
            generation,
            "continueWatching",
            continueWatchingRevision,
          ) &&
          foregroundRefreshRef.current.latestSuccessful.continueWatching ===
            foregroundSuccessful.continueWatching
        ) {
          setContinueWatching(loaded);
        }
      });
    const calendarTask = readAuxiliary(loadOrInitializeCalendarLastSeenAt, Date.now())
      .then((loaded) => {
        if (
          auxiliaryReadIsCurrent(
            generation,
            "calendarLastSeenAt",
            calendarRevision,
          )
        ) {
          setCalendarLastSeenAt(loaded);
        }
      });

    await Promise.all([
      watchlistTask,
      historyTask,
      continueWatchingTask,
      calendarTask,
    ]);
  }, [auxiliaryReadIsCurrent]);

  // Resolve the active profile and durable configuration on the startup
  // critical path. Large independent library slices hydrate only after this
  // state has committed, so they cannot hold the full application boot shell.
  useEffect(() => {
    let cancelled = false;
    const generation = invalidateProfileReads();
    void (async () => {
      // Resolve Local Mode's active database before any per-profile read. The
      // default keeps the literal legacy database name and therefore never
      // closes or migrates an existing single-user installation at boot.
      if (!isServerMode()) {
        // The whole profile-resolution chain is guarded: if the registry DB is
        // blocked/corrupt/quota-denied it must degrade to the implicit single
        // user on the legacy "debridstreamer" DB (no swap), NEVER reject before
        // setHydrated(true) and strand an existing user on a permanent spinner.
        try {
          const bootstrap = loadSettings();
          const defaultProfile = await ensureDefaultProfile({
            name: bootstrap.userName,
            avatar: bootstrap.userAvatar,
          });
          const [storedActiveId, registryProfiles, enabled] = await Promise.all([
            getActiveProfileId(),
            listProfiles().catch(() => null),
            isMultiUserEnabled().catch(() => null),
          ]);
          if (cancelled || profileReadGenerationRef.current !== generation) return;
          const activeId = storedActiveId ?? defaultProfile.id;
          const active = (await getProfile(activeId)) ?? defaultProfile;
          if (!active.isDefault) await swapLocalProfileStore(dbNameForProfile(active));
          if (cancelled || profileReadGenerationRef.current !== generation) return;
          setActiveProfile(active);
          if (registryProfiles != null) setProfiles(registryProfiles);
          if (enabled != null) setMultiUserEnabledState(enabled);
        } catch {
          // Registry unavailable: stay on the already-open default DB and fall
          // through to hydration so the app still opens on the user's data.
          if (cancelled || profileReadGenerationRef.current !== generation) return;
        }
      }
      const loadedSettings = await loadSettingsFromStore().catch(() => loadSettings());
      if (cancelled || profileReadGenerationRef.current !== generation) return;
      // One-time premium-redesign refresh: adopt the spacious appearance
      // defaults for installs that predate it (no-op after it has run once).
      // Mark it applied ONLY after a successful persist, so a failed Store write
      // retries next load instead of leaving the reset marked-done-but-lost.
      const refreshedSettings = applyDesignRefresh(loadedSettings);
      setNetworkMode(refreshedSettings.networkMode);
      setSettings(refreshedSettings);
      if (refreshedSettings !== loadedSettings) {
        void saveSettingsToStore(refreshedSettings, { previous: loadedSettings })
          .then(() => markDesignRefreshApplied())
          .catch(() => {
            /* leave the marker unset so the refresh retries next load */
          });
      }
      // Land on the user's chosen default tab. Only here, on first hydration - 
      // the app is still gated behind the wizard/hydration, so this can't stomp
      // a mid-session navigation. If the chosen tab is hidden under the active
      // modes, App's redirect effect sends it back to Discover.
      if (
        !restoredRouteFromHistory.current &&
        refreshedSettings.appearanceDefaultTab !== "discover"
      ) {
        setRoute(refreshedSettings.appearanceDefaultTab);
        replaceNavigationHistory(
          makeNavigationHistoryEntry({
            depth: readNavigationHistoryEntry(
              browserHistoryAvailable() ? window.history.state : null,
            )?.depth ?? 0,
            route: refreshedSettings.appearanceDefaultTab,
            browseContext: null,
            detailItem: null,
            layer: "none",
            localFilePlayer: null,
          }),
        );
      }
      setDurableProfileReady(true);
      setAuxiliaryLoadRequest({
        generation,
        revisions: { ...auxiliaryRevisionsRef.current },
        foregroundSuccessful: {
          ...foregroundRefreshRef.current.latestSuccessful,
        },
      });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [invalidateProfileReads, replaceNavigationHistory]);

  // The request is set in the critical hydration effect. This separate effect
  // cannot run until React has committed the durable settings/profile render.
  useEffect(() => {
    if (!durableProfileReady || auxiliaryLoadRequest == null) return;
    void loadAuxiliaryProfileSlices(auxiliaryLoadRequest);
  }, [auxiliaryLoadRequest, durableProfileReady, loadAuxiliaryProfileSlices]);

  // Reload the complete public profile snapshot for one owned generation.
  // Mount hydration stays progressive, but explicit reload and profile-switch
  // callers must not resume while only the target settings have landed.
  const reloadProfileDataForGeneration = useCallback(async (generation: number) => {
    const store = getStore();
    if (store instanceof RemoteStore) store.resetProfileCache();
    const loadedSettings = await loadSettingsFromStore();
    if (profileReadGenerationRef.current !== generation) return;
    setNetworkMode(loadedSettings.networkMode);
    setSettings(loadedSettings);
    setDurableProfileReady(true);
    await loadAuxiliaryProfileSlices({
      generation,
      revisions: { ...auxiliaryRevisionsRef.current },
      foregroundSuccessful: {
        ...foregroundRefreshRef.current.latestSuccessful,
      },
      strict: true,
    });
    // Settings update changes serviceConfigKey, so useMemo rebuilds clients for
    // the newly selected Local Mode profile without a separate service reset.
  }, [loadAuxiliaryProfileSlices]);

  // Used after Server Mode and explicit Local Mode profile switches. Invalidate
  // any older bootstrap reads before starting the replacement profile read.
  const reloadProfileData = useCallback(async () => {
    const generation = invalidateProfileReads();
    await reloadProfileDataForGeneration(generation);
  }, [invalidateProfileReads, reloadProfileDataForGeneration]);

  const refreshProfiles = useCallback(async () => {
    if (isServerMode()) return;
    const [nextProfiles, enabled, activeId] = await Promise.all([
      listProfiles(),
      isMultiUserEnabled(),
      getActiveProfileId(),
    ]);
    setProfiles(nextProfiles);
    setMultiUserEnabledState(enabled);
    setActiveProfile(nextProfiles.find((profile) => profile.id === activeId) ?? null);
  }, []);

  const switchLocalProfile = useCallback(async (
    id: string,
    password?: string,
  ): Promise<{ ok: boolean; reason?: "bad-password" | "not-found" }> => {
    if (isServerMode()) return { ok: false, reason: "not-found" };
    const profile = await getProfile(id);
    if (profile == null) return { ok: false, reason: "not-found" };
    if (profile.passwordHash != null) {
      const valid = await verifyPassword(password ?? "", profile.passwordHash);
      if (!valid) return { ok: false, reason: "bad-password" };
      unlockedProfileIds.add(id);
    }
    // Invalidate old-profile auxiliary reads before the database pointer moves.
    const generation = invalidateProfileReads();
    // Fail safe across the swap: the target profile's own mode is unknown until
    // reloadProfileData loads its settings, and getStore() now points at the new
    // profile's DB. Clamp to the most restrictive mode so a scheduler tick in
    // that sub-second window cannot make a call the target profile would block.
    setNetworkMode("offline");
    await swapLocalProfileStore(dbNameForProfile(profile));
    await setActiveProfileId(id);
    await updateProfileRecord(id, { lastUsedAt: Date.now() });
    await reloadProfileDataForGeneration(generation); // sets the target profile's real networkMode
    await refreshProfiles();
    return { ok: true };
  }, [invalidateProfileReads, refreshProfiles, reloadProfileDataForGeneration]);

  // Most settings are presentation or playback preferences. Rebuilding every
  // API client for those changes also used to restart the app-wide download
  // runtime, because the context handed App a fresh `services.debrid` path.
  // Build only when an input consumed by buildServices changes; settings still
  // update normally for consumers that actually use the changed preference.
  const serviceConfigKey = JSON.stringify({
    tmdbKey: settings.tmdbKey,
    omdbKey: settings.omdbKey,
    debridTokens: settings.debridTokens,
    sources: settings.sources,
    builtInIndexersEnabled: settings.builtInIndexersEnabled,
    aiProvider: settings.aiProvider,
    aiApiKey: settings.aiApiKey,
    aiModel: settings.aiModel,
    ollamaEndpoint: settings.ollamaEndpoint,
    openSubtitlesApiKey: settings.openSubtitlesApiKey,
  });
  const services = useMemo(
    () => buildServices(settings),
    [serviceConfigKey],
  );

  // Resolve badge-relevant episode data once at the store boundary. Avoid using
  // the raw watchlist identity as a refresh key: movies and reorder-only changes
  // cannot affect a followed-series episode schedule.
  const calendarSeriesSignature = useMemo(
    () =>
      watchlist
        .filter((item) => item.type === "series")
        .map((item) => item.id)
        .sort()
        .join(","),
    [watchlist],
  );
  const calendar = useCalendar(
    services.tmdb,
    calendarSeriesSignature,
    calendarRefreshKey,
    durableProfileReady,
  );

  const openBrowse = useCallback((ctx: BrowseContext) => {
    setBrowseContext(ctx);
    setBrowseFiltersOpen(false);
    setTrailerOpen(false);
    setDetailPlayerOpen(false);
    pushNavigationHistory({
      route,
      browseContext: ctx,
      detailItem: null,
      layer: "none",
      localFilePlayer: null,
    });
  }, [pushNavigationHistory, route]);

  const updateBrowseContext = useCallback((ctx: BrowseContext) => {
    setBrowseContext(ctx);
    setBrowseFiltersOpen(false);
    const current = browserHistoryAvailable()
      ? readNavigationHistoryEntry(window.history.state)
      : null;
    if (
      current?.layer === "filters" &&
      current.depth > 0 &&
      historyReady.current
    ) {
      pendingBrowseContextReplacement.current = ctx;
      window.history.back();
      return;
    }
    replaceNavigationHistory(
      makeNavigationHistoryEntry({
        depth: current?.depth ?? 0,
        route,
        browseContext: ctx,
        detailItem: null,
        layer: "none",
        localFilePlayer: null,
      }),
    );
  }, [replaceNavigationHistory, route]);

  const closeBrowse = useCallback(() => {
    goBackForClose(() => {
      setBrowseFiltersOpen(false);
      setBrowseContext(null);
    });
  }, [goBackForClose]);

  const openBrowseFilters = useCallback(() => {
    if (browseContext == null) return;
    setBrowseFiltersOpen(true);
    pushNavigationHistory({
      route,
      browseContext,
      detailItem,
      layer: "filters",
      localFilePlayer,
    });
  }, [browseContext, detailItem, localFilePlayer, pushNavigationHistory, route]);

  const closeBrowseFilters = useCallback(() => {
    goBackForClose(() => setBrowseFiltersOpen(false));
  }, [goBackForClose]);

  const openTrailer = useCallback(() => {
    if (detailItem == null) return;
    setTrailerOpen(true);
    pushNavigationHistory({
      route,
      browseContext,
      detailItem,
      layer: "trailer",
      localFilePlayer,
    });
  }, [browseContext, detailItem, localFilePlayer, pushNavigationHistory, route]);

  const closeTrailer = useCallback(() => {
    goBackForClose(() => setTrailerOpen(false));
  }, [goBackForClose]);

  const openDetailPlayer = useCallback(() => {
    if (detailItem == null) return;
    setDetailPlayerOpen(true);
    pushNavigationHistory({
      route,
      browseContext,
      detailItem,
      layer: "detail-player",
      localFilePlayer,
    });
  }, [browseContext, detailItem, localFilePlayer, pushNavigationHistory, route]);

  const closeDetailPlayer = useCallback(() => {
    goBackForClose(() => setDetailPlayerOpen(false));
  }, [goBackForClose]);

  const refreshCachedResolutions = useCallback(async () => {
    const generation = profileReadGenerationRef.current;
    const request = ++foregroundRefreshRef.current.nextRequest;
    // The eager scheduler effect may start as soon as durable settings commit.
    // Let the owned bootstrap read establish the watchlist before polling its
    // keyed cache rows, otherwise an empty poll can supersede that bootstrap.
    if (watchlistReadyGenerationRef.current !== generation) return;
    const revision = auxiliaryRevisionsRef.current.cachedResolutions;
    try {
      const mediaIds = watchlistRef.current.map((item) => item.id);
      const rows = await getStore().getCachedResolutions(mediaIds);
      if (!auxiliaryReadIsCurrent(generation, "cachedResolutions", revision)) return;
      if (
        request <=
        foregroundRefreshRef.current.latestSuccessful.cachedResolutions
      ) {
        return;
      }
      foregroundRefreshRef.current.latestSuccessful.cachedResolutions = request;
      setCachedResolutions((prev) => {
        // The 30s badge poll reads only current watchlist ids. Replacing the map
        // with a fresh object each tick changes the context value's identity and
        // re-renders every useAppStore() consumer. Bail out unless a resolution
        // changed, comparing scalar identity fields because stream is rebuilt.
        const unchanged =
          rows.length === Object.keys(prev).length &&
          rows.every((r) => {
            const p = prev[r.mediaId];
            return (
              p != null &&
              p.infoHash === r.infoHash &&
              p.resolvedAt === r.resolvedAt &&
              p.debridService === r.debridService
            );
          });
        if (unchanged) return prev;
        const map: Record<string, CachedResolutionRecord> = {};
        for (const r of rows) map[r.mediaId] = r;
        return map;
      });
    } catch {
      // best-effort
    }
  }, [auxiliaryReadIsCurrent]);

  // The background auto-resolve scheduler. It always reads the LATEST services
  // via the getter (so a settings change is picked up without rebuilding it),
  // and is Tauri-gated internally (a no-op in a plain browser). A ref keeps a
  // single instance across renders.
  const servicesRef = useRef(services);
  servicesRef.current = services;
  // A ref so the scheduler's deps closure always reads the CURRENT settings (for
  // the data-saver caps), not the ones captured when it was first constructed.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const schedulerRef = useRef<AutoResolveScheduler | null>(null);
  if (schedulerRef.current == null) {
    schedulerRef.current = new AutoResolveScheduler(() => ({
      tmdb: servicesRef.current.tmdb,
      indexers: servicesRef.current.indexers,
      debrid: servicesRef.current.debrid,
      store: getStore(),
      settings: settingsRef.current,
    }));
  }

  const refreshHistory = useCallback(async () => {
    const generation = profileReadGenerationRef.current;
    const request = ++foregroundRefreshRef.current.nextRequest;
    const historyRevision = auxiliaryRevisionsRef.current.history;
    const continueWatchingRevision = auxiliaryRevisionsRef.current.continueWatching;
    try {
      const [hist, cw] = await Promise.all([
        loadHistory(),
        loadContinueWatching(),
      ]);
      if (
        !auxiliaryReadIsCurrent(generation, "history", historyRevision) ||
        !auxiliaryReadIsCurrent(
          generation,
          "continueWatching",
          continueWatchingRevision,
        )
      ) {
        return;
      }
      if (request > foregroundRefreshRef.current.latestSuccessful.history) {
        foregroundRefreshRef.current.latestSuccessful.history = request;
        setHistory(hist);
      }
      if (
        request >
        foregroundRefreshRef.current.latestSuccessful.continueWatching
      ) {
        foregroundRefreshRef.current.latestSuccessful.continueWatching = request;
        setContinueWatching(cw);
      }
    } catch {
      // A foreground refresh is best effort. Leave the revisions untouched so
      // a pending owned bootstrap can still publish its successful snapshot.
    }
  }, [auxiliaryReadIsCurrent]);

  const refreshContinueWatching = useCallback(async () => {
    const generation = profileReadGenerationRef.current;
    const request = ++foregroundRefreshRef.current.nextRequest;
    const revision = auxiliaryRevisionsRef.current.continueWatching;
    // The webview player's final progress report is emitted during unmount.
    // Drain all writes visible at this session boundary before reading the
    // updated slice, including one added while an earlier write is settling.
    while (pendingResumeWritesRef.current.size > 0) {
      await Promise.all([...pendingResumeWritesRef.current]);
    }
    try {
      const loaded = await loadContinueWatching();
      if (!auxiliaryReadIsCurrent(generation, "continueWatching", revision)) return;
      if (
        request <=
        foregroundRefreshRef.current.latestSuccessful.continueWatching
      ) {
        return;
      }
      foregroundRefreshRef.current.latestSuccessful.continueWatching = request;
      setContinueWatching(loaded);
    } catch {
      // Keep a pending owned bootstrap authoritative after a failed refresh.
    }
  }, [auxiliaryReadIsCurrent]);

  // Install one listener for the whole app. It restores the descriptor with
  // direct setters rather than navigation commands, and the ref guard prevents
  // any nested command from turning a browser Back into a new pushState entry.
  // Reload intentionally restores only the route: streams and transient
  // overlays are not safe to replay after a fresh app session.
  useEffect(() => {
    if (!browserHistoryAvailable()) return;

    const saved = readNavigationHistoryEntry(window.history.state);
    restoredRouteFromHistory.current = saved != null;
    const initial = makeNavigationHistoryEntry({
      depth: saved?.depth ?? 0,
      route: saved?.route ?? "discover",
      browseContext: null,
      detailItem: null,
      layer: "none",
      localFilePlayer: null,
    });
    isApplyingPopState.current = true;
    try {
      setRoute(initial.route);
      setBrowseContext(null);
      setBrowseFiltersOpen(false);
      setDetailItem(null);
      setTrailerOpen(false);
      setDetailPlayerOpen(false);
      setLocalFilePlayer(null);
    } finally {
      isApplyingPopState.current = false;
    }
    window.history.replaceState(initial, "", window.location.href);
    historyReady.current = true;

    const applyPopState = (event: PopStateEvent) => {
      let entry = readNavigationHistoryEntry(event.state);
      // Do not claim an unrelated history entry. The browser will navigate away
      // from this document normally if it belongs to another page.
      if (entry == null) return;
      const pendingBrowseContext = pendingBrowseContextReplacement.current;
      if (pendingBrowseContext != null) {
        pendingBrowseContextReplacement.current = null;
        entry = makeNavigationHistoryEntry({
          depth: entry.depth,
          route: entry.route,
          browseContext: pendingBrowseContext,
          detailItem: null,
          layer: "none",
          localFilePlayer: null,
        });
        window.history.replaceState(entry, "", window.location.href);
      }
      isApplyingPopState.current = true;
      try {
        setRoute(entry.route);
        setBrowseContext(entry.browseContext);
        setBrowseFiltersOpen(entry.layer === "filters" && entry.browseContext != null);
        setDetailItem(entry.detailItem);
        setTrailerOpen(entry.layer === "trailer" && entry.detailItem != null);
        // A stream URL and playback session are deliberately not replayed by
        // Forward. The player entry still acts as a one-step close target on Back.
        setDetailPlayerOpen(false);
        setLocalFilePlayer(
          entry.layer === "local-player" ? entry.localFilePlayer : null,
        );
      } finally {
        // Guarantee the flag resets even if a future setter throws; a stranded
        // true would silently disable all subsequent history pushes.
        isApplyingPopState.current = false;
      }
      if (entry.route === "history") void refreshHistory();
    };

    window.addEventListener("popstate", applyPopState);
    return () => {
      historyReady.current = false;
      window.removeEventListener("popstate", applyPopState);
    };
  }, [refreshHistory]);

  // Load the history slices only when a screen requests them. In particular,
  // durable progress ticks must not deserialize the full history table and
  // rebuild the provider context every few seconds while a player is open.
  const navigate = useCallback((next: ScreenId, options?: { replace?: boolean }) => {
    setBrowseContext(null);
    setBrowseFiltersOpen(false);
    setDetailItem(null);
    setTrailerOpen(false);
    setDetailPlayerOpen(false);
    setRoute(next);
    pushNavigationHistory({
      route: next,
      browseContext: null,
      detailItem: null,
      layer: "none",
      localFilePlayer: null,
    }, options);
    if (next === "history") void refreshHistory();
  }, [pushNavigationHistory, refreshHistory]);

  const openSettingsSection = useCallback((section: SettingsSection) => {
    setPendingSettingsSection(section);
    navigate("settings");
  }, [navigate]);

  const clearPendingSettingsSection = useCallback(() => {
    setPendingSettingsSection(null);
  }, []);

  // Drive the background auto-resolve scheduler. It only does work under Tauri
  // with debrid configured (gated internally); here we (re)start it whenever
  // debrid availability changes and refresh the cached-resolution badge state on
  // an interval so a completed pass shows up without a reload. No-op in browser.
  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (
      scheduler == null ||
      !durableProfileReady ||
      watchlistReadyGeneration !== profileReadGenerationRef.current
    ) {
      return;
    }
    if (!services.hasDebrid) {
      scheduler.stop();
      return;
    }
    scheduler.start();
    // Poll the cached-resolution table so the watchlist badges reflect new
    // resolutions produced by background passes. PERF: skip ticks while the
    // window is hidden (nobody can see the badges) and catch up once when it
    // becomes visible again.
    const refresh = setInterval(() => {
      if (!document.hidden) void refreshCachedResolutions();
    }, 30_000);
    const onVisible = () => {
      if (!document.hidden) void refreshCachedResolutions();
    };
    document.addEventListener("visibilitychange", onVisible);
    void refreshCachedResolutions();
    return () => {
      clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVisible);
      scheduler.stop();
    };
  }, [durableProfileReady, services.hasDebrid, refreshCachedResolutions, watchlistReadyGeneration]);

  const openDetail = useCallback((item: MediaPreview) => {
    setDetailItem(item);
    setBrowseFiltersOpen(false);
    setTrailerOpen(false);
    setDetailPlayerOpen(false);
    pushNavigationHistory({
      route,
      browseContext,
      detailItem: item,
      layer: "none",
      localFilePlayer,
    });
    // Recording a view also feeds the History screen (zero-progress entry;
    // a real resume position is written later from the player).
    // `recordHistory` already reads the refreshed history list back, so adopt
    // ITS result rather than calling refreshHistory(): that re-read history a
    // second time AND ran the unbounded continueWatching scan on every title
    // open. Continue Watching cannot change here anyway - a viewed-only record
    // preserves the existing progress fields, so the resumable set is
    // identical; only its lastWatched order could shift, and the playback-close
    // refresh plus the History route refresh already cover that.
    const generation = profileReadGenerationRef.current;
    void recordHistory(item).then((loaded) => {
      if (profileReadGenerationRef.current === generation) {
        bumpAuxiliaryRevision("history");
        setHistory(loaded);
      }
    }).catch(() => {
      // Leave the revision unchanged so an owned bootstrap read can still
      // populate History after a rejected best-effort view record.
    });
  }, [browseContext, bumpAuxiliaryRevision, localFilePlayer, pushNavigationHistory, route]);

  const closeDetail = useCallback(() => {
    goBackForClose(() => {
      setTrailerOpen(false);
      setDetailPlayerOpen(false);
      setDetailItem(null);
    });
  }, [goBackForClose]);

  const playLocalFile = useCallback((path: string, title: string) => {
    // Preserve the filesystem path exactly as supplied. mpv receives this raw
    // value through the native player bridge; converting it to a webview asset
    // URL would make it unusable by libmpv.
    if (path.length === 0) return;
    const next = { path, title };
    setLocalFilePlayer(next);
    pushNavigationHistory({
      route,
      browseContext,
      detailItem,
      layer: "local-player",
      localFilePlayer: next,
    });
  }, [browseContext, detailItem, pushNavigationHistory, route]);

  const closeLocalFilePlayer = useCallback(() => {
    goBackForClose(() => setLocalFilePlayer(null));
  }, [goBackForClose]);

  const search = useCallback((query: string) => {
    const q = query.trim();
    if (q.length === 0) return;
    setPendingSearch(q);
    setRoute("search");
    setBrowseContext(null);
    setBrowseFiltersOpen(false);
    setDetailItem(null);
    setTrailerOpen(false);
    setDetailPlayerOpen(false);
    pushNavigationHistory({
      route: "search",
      browseContext: null,
      detailItem: null,
      layer: "none",
      localFilePlayer: null,
    });
  }, [pushNavigationHistory]);

  const consumePendingSearch = useCallback(() => setPendingSearch(null), []);

  const updateSettings = useCallback((next: AppSettings): Promise<SaveResult> => {
    // Optimistically update in-memory (and rebuild services only when their
    // config changes), then persist to the durable Store. Persisting can reject
    // if a keychain write fails closed (desktop); the in-memory value stays
    // usable for the session.
    //
    // The outcome is REPORTED rather than thrown: most callers fire-and-forget
    // (instant-apply appearance controls, the profile menu), so a rejecting
    // promise would surface as an unhandled rejection. Resolving to {ok} lets
    // "Save changes" avoid claiming a save that didn't happen, while leaving
    // every existing caller safe to ignore the result.
    setNetworkMode(next.networkMode);
    setSettings(next);
    return saveSettingsToStore(next, { previous: settingsRef.current }).then(
      () => ({ ok: true as const }),
      (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("Failed to persist settings:", err);
        return { ok: false as const };
      },
    );
  }, []);

  const markCalendarSeen = useCallback(() => {
    bumpAuxiliaryRevision("calendarLastSeenAt");
    const seenAt = Date.now();
    setCalendarLastSeenAt(seenAt);
    void saveCalendarLastSeenAt(seenAt).catch(() => {
      // Best effort: if persistence is unavailable, the current session still
      // clears the in-app indicator and a later Calendar visit can retry.
    });
  }, [bumpAuxiliaryRevision]);

  const refreshCalendar = useCallback(() => {
    setCalendarRefreshKey((current) => current + 1);
  }, []);

  // Coalesce concurrent mutations of the same item and serialize all
  // watchlist read-modify-writes. Different-item writes still replace the full
  // persisted list, so allowing them to race can lose whichever result settles
  // first. A final owned read reconciles both successful and rejected writes.
  const watchlistMutating = useRef<Set<string>>(new Set());
  const watchlistWriteTailRef = useRef<Promise<void>>(Promise.resolve());
  const watchlistWritesPendingRef = useRef(0);
  const watchlistWriteSequenceRef = useRef(0);
  const watchlistReconcileGenerationsRef = useRef<Set<number>>(new Set());

  const queueWatchlistWrite = useCallback(<T,>(
    generation: number,
    operation: () => Promise<T>,
  ): Promise<{ ran: false } | { ran: true; value: T }> => {
    const run = watchlistWriteTailRef.current
      .catch(() => {
        // The previous caller observes its own rejection. Keep the shared tail
        // usable so one failed write cannot strand later mutations.
      })
      .then(async () => {
        if (profileReadGenerationRef.current !== generation) {
          return { ran: false } as const;
        }
        return { ran: true, value: await operation() } as const;
      });
    watchlistWriteTailRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const settleWatchlistWrite = useCallback(async (
    generation: number,
    sequence: number,
  ) => {
    watchlistWritesPendingRef.current -= 1;
    if (
      watchlistWritesPendingRef.current !== 0 ||
      profileReadGenerationRef.current !== generation
    ) {
      return;
    }
    if (!watchlistReconcileGenerationsRef.current.has(generation)) return;
    let loaded: MediaPreview[];
    try {
      loaded = await loadWatchlist();
    } catch {
      // Do not advance the revision when reconciliation fails. A pending boot
      // read from the same generation may still provide the authoritative list.
      return;
    }
    if (
      profileReadGenerationRef.current !== generation ||
      watchlistWritesPendingRef.current !== 0 ||
      watchlistWriteSequenceRef.current !== sequence
    ) {
      return;
    }
    watchlistReconcileGenerationsRef.current.delete(generation);
    bumpAuxiliaryRevision("watchlist");
    watchlistReadyGenerationRef.current = generation;
    setWatchlistReadyGeneration(generation);
    watchlistRef.current = loaded;
    setWatchlist(loaded);
    void refreshCachedResolutions();
  }, [bumpAuxiliaryRevision, refreshCachedResolutions]);

  const toggleWatchlist = useCallback(
    (item: MediaPreview) => {
      if (watchlistMutating.current.has(item.id)) return;
      const generation = profileReadGenerationRef.current;
      const sequence = ++watchlistWriteSequenceRef.current;
      watchlistWritesPendingRef.current += 1;
      watchlistMutating.current.add(item.id);
      void queueWatchlistWrite(generation, () => toggleWatchlistStore(item))
        .then((result) => {
          if (!result.ran || profileReadGenerationRef.current !== generation) return;
          const revision = bumpAuxiliaryRevision("watchlist");
          watchlistReadyGenerationRef.current = generation;
          setWatchlistReadyGeneration(generation);
          watchlistRef.current = result.value;
          const next = result.value;
          setWatchlist(next);
          // If the item is now ON the watchlist, kick a pre-resolve pass so a
          // ready resolution is cached soon (Tauri-only; no-op in browser).
          if (next.some((i) => i.id === item.id)) {
            void schedulerRef.current?.kick().then(() => {
              if (auxiliaryReadIsCurrent(generation, "watchlist", revision)) {
                void refreshCachedResolutions();
              }
            });
          } else {
            // Removed → drop any cached resolution for it.
            void getStore()
              .deleteCachedResolution(item.id)
              .then(() => {
                if (auxiliaryReadIsCurrent(generation, "watchlist", revision)) {
                  void refreshCachedResolutions();
                }
              });
          }
        })
        .catch(() => {
          // Reconcile below. A rejected mutation must not suppress an earlier
          // bootstrap read or poison the serialization tail.
          watchlistReconcileGenerationsRef.current.add(generation);
        })
        .finally(() => {
          watchlistMutating.current.delete(item.id);
          void settleWatchlistWrite(generation, sequence);
        });
    },
    [auxiliaryReadIsCurrent, bumpAuxiliaryRevision, queueWatchlistWrite, refreshCachedResolutions, settleWatchlistWrite],
  );

  const removeFromWatchlist = useCallback(
    (id: string) => {
      if (watchlistMutating.current.has(id)) return;
      const generation = profileReadGenerationRef.current;
      const sequence = ++watchlistWriteSequenceRef.current;
      watchlistWritesPendingRef.current += 1;
      watchlistMutating.current.add(id);
      void queueWatchlistWrite(generation, () => removeFromWatchlistStore(id))
        .then((result) => {
          if (!result.ran || profileReadGenerationRef.current !== generation) return;
          const revision = bumpAuxiliaryRevision("watchlist");
          watchlistReadyGenerationRef.current = generation;
          setWatchlistReadyGeneration(generation);
          watchlistRef.current = result.value;
          const next = result.value;
          setWatchlist(next);
          void getStore()
            .deleteCachedResolution(id)
            .then(() => {
              if (auxiliaryReadIsCurrent(generation, "watchlist", revision)) {
                void refreshCachedResolutions();
              }
            });
        })
        .catch(() => {
          // The owned reconciliation below restores the authoritative list.
          watchlistReconcileGenerationsRef.current.add(generation);
        })
        .finally(() => {
          watchlistMutating.current.delete(id);
          void settleWatchlistWrite(generation, sequence);
        });
    },
    [auxiliaryReadIsCurrent, bumpAuxiliaryRevision, queueWatchlistWrite, refreshCachedResolutions, settleWatchlistWrite],
  );

  const importToWatchlist = useCallback(
    async (previews: MediaPreview[]) => {
      const generation = profileReadGenerationRef.current;
      const sequence = ++watchlistWriteSequenceRef.current;
      watchlistWritesPendingRef.current += 1;
      try {
        const result = await queueWatchlistWrite(generation, async () => {
          const store = getStore();
          let added = 0;
          let skipped = 0;
          for (const preview of previews) {
            if (await store.isInWatchlist(preview.id)) {
              skipped += 1;
              continue;
            }
            await store.addToWatchlist(preview);
            added += 1;
          }
          const next = added > 0 ? await loadWatchlist() : null;
          return { added, skipped, next };
        });
        if (!result.ran || profileReadGenerationRef.current !== generation) {
          return { added: 0, skipped: previews.length };
        }
        const { added, skipped, next } = result.value;
        if (next != null) {
          const revision = bumpAuxiliaryRevision("watchlist");
          watchlistReadyGenerationRef.current = generation;
          setWatchlistReadyGeneration(generation);
          watchlistRef.current = next;
          setWatchlist(next);
          void schedulerRef.current?.kick().then(() => {
            if (auxiliaryReadIsCurrent(generation, "watchlist", revision)) {
              void refreshCachedResolutions();
            }
          });
        }
        return { added, skipped };
      } catch (error) {
        watchlistReconcileGenerationsRef.current.add(generation);
        throw error;
      } finally {
        void settleWatchlistWrite(generation, sequence);
      }
    },
    [auxiliaryReadIsCurrent, bumpAuxiliaryRevision, queueWatchlistWrite, refreshCachedResolutions, settleWatchlistWrite],
  );

  const recordResume = useCallback(
    (
      item: MediaPreview,
      progressSeconds: number,
      durationSeconds: number | null,
      episodeId?: string | null,
      prefs?: PlaybackPrefs,
    ) => {
      const completed =
        durationSeconds != null &&
        durationSeconds > 0 &&
        progressSeconds / durationSeconds >= 0.95;
      // `recordHistory()` is intentionally convenient for interactive history
      // mutations because it reads the refreshed list back. Playback progress
      // is different: doing that every five seconds deserializes all history
      // rows and changes the provider context for the entire app. The storage
      // upsert already preserves omitted player prefs, so persist directly and
      // refresh once at the playback-session boundary or when History opens.
      const write = getStore()
        .recordHistory({
          mediaId: item.id,
          episodeId: episodeId ?? null,
          progressSeconds,
          durationSeconds,
          completed,
          preview: item,
          preferredAudioId: prefs?.preferredAudioId,
          preferredAudioLang: prefs?.preferredAudioLang,
          preferredSubId: prefs?.preferredSubId,
          playbackSpeed: prefs?.playbackSpeed,
          subtitleDelay: prefs?.subtitleDelay,
          subtitlePosition: prefs?.subtitlePosition,
        })
        .catch(() => {
          // Progress persistence is best effort. The next tick and final close
          // report can retry without interrupting playback.
        });
      pendingResumeWritesRef.current.add(write);
      void write.finally(() => pendingResumeWritesRef.current.delete(write));
    },
    [],
  );

  // Effective experience tier. Server Mode is authoritative from the profile
  // session (default Advanced when the session hasn't loaded yet); Local Mode uses
  // the AppSettings flag.
  const serverSession = useServerSession();
  const simpleMode = isServerMode()
    ? (serverSession?.simpleMode ?? false)
    : settings.simpleMode;

  const currentActions: AppActions = {
    getServices: () => servicesRef.current,
    navigate,
    openDetail,
    closeDetail,
    openBrowse,
    updateBrowseContext,
    closeBrowse,
    search,
    consumePendingSearch,
    updateSettings,
    refreshContinueWatching,
    refreshCachedResolutions,
    toggleWatchlist,
    removeFromWatchlist,
    importToWatchlist,
    reloadProfileData,
    refreshProfiles,
    switchLocalProfile,
    recordResume,
  };
  const currentActionsRef = useRef(currentActions);
  useLayoutEffect(() => {
    currentActionsRef.current = currentActions;
  });

  // Action-only consumers keep one context identity for the provider lifetime.
  // Each forwarding method reads the callbacks from the latest committed render,
  // so route-dependent handlers stay current without notifying shell controls.
  const actionsValue: AppActions = useMemo(() => {
    const live = () => currentActionsRef.current;
    return {
      getServices: () => live().getServices(),
      navigate: (...args) => live().navigate(...args),
      openDetail: (...args) => live().openDetail(...args),
      closeDetail: () => live().closeDetail(),
      openBrowse: (...args) => live().openBrowse(...args),
      updateBrowseContext: (...args) => live().updateBrowseContext(...args),
      closeBrowse: () => live().closeBrowse(),
      search: (...args) => live().search(...args),
      consumePendingSearch: () => live().consumePendingSearch(),
      updateSettings: (...args) => live().updateSettings(...args),
      refreshContinueWatching: () => live().refreshContinueWatching(),
      refreshCachedResolutions: () => live().refreshCachedResolutions(),
      toggleWatchlist: (...args) => live().toggleWatchlist(...args),
      removeFromWatchlist: (...args) => live().removeFromWatchlist(...args),
      importToWatchlist: (...args) => live().importToWatchlist(...args),
      reloadProfileData: () => live().reloadProfileData(),
      refreshProfiles: () => live().refreshProfiles(),
      switchLocalProfile: (...args) => live().switchLocalProfile(...args),
      recordResume: (...args) => live().recordResume(...args),
    };
  }, []);

  // PERF: memoize the context value. Every member below is already referentially
  // stable between unrelated updates (useCallback/useState); without useMemo the
  // provider handed out a FRESH object on every render - so each 30s badge poll
  // re-rendered every `useAppStore()` consumer in the app.
  const value: AppStore = useMemo(
    () => ({
      route,
      navigate,
      pendingSettingsSection,
      openSettingsSection,
      clearPendingSettingsSection,
      detailItem,
      openDetail,
      closeDetail,
      localFilePlayer,
      playLocalFile,
      closeLocalFilePlayer,
      browseContext,
      openBrowse,
      updateBrowseContext,
      closeBrowse,
      browseFiltersOpen,
      openBrowseFilters,
      closeBrowseFilters,
      trailerOpen,
      openTrailer,
      closeTrailer,
      detailPlayerOpen,
      openDetailPlayer,
      closeDetailPlayer,
      pendingSearch,
      search,
      consumePendingSearch,
      services,
      settings,
      updateSettings,
      simpleMode,
      hydrated,
      calendar,
      calendarLastSeenAt,
      markCalendarSeen,
      refreshCalendar,
      watchlist,
      history,
      continueWatching,
      refreshContinueWatching,
      refreshCachedResolutions,
      toggleWatchlist,
      removeFromWatchlist,
      importToWatchlist,
      reloadProfileData,
      activeProfile,
      profiles,
      multiUserEnabled,
      refreshProfiles,
      switchLocalProfile,
      recordResume,
    }),
    [
      route,
      navigate,
      pendingSettingsSection,
      openSettingsSection,
      clearPendingSettingsSection,
      detailItem,
      openDetail,
      closeDetail,
      localFilePlayer,
      playLocalFile,
      closeLocalFilePlayer,
      browseContext,
      openBrowse,
      updateBrowseContext,
      closeBrowse,
      browseFiltersOpen,
      openBrowseFilters,
      closeBrowseFilters,
      trailerOpen,
      openTrailer,
      closeTrailer,
      detailPlayerOpen,
      openDetailPlayer,
      closeDetailPlayer,
      pendingSearch,
      search,
      consumePendingSearch,
      services,
      settings,
      updateSettings,
      simpleMode,
      hydrated,
      calendar,
      calendarLastSeenAt,
      markCalendarSeen,
      refreshCalendar,
      watchlist,
      history,
      continueWatching,
      refreshContinueWatching,
      refreshCachedResolutions,
      toggleWatchlist,
      removeFromWatchlist,
      importToWatchlist,
      reloadProfileData,
      activeProfile,
      profiles,
      multiUserEnabled,
      refreshProfiles,
      switchLocalProfile,
      recordResume,
    ],
  );

  return (
    <AppActionsContext.Provider value={actionsValue}>
      <CachedResolutionsContext.Provider value={cachedResolutions}>
        <AppStoreContext.Provider value={value}>
          {children}
        </AppStoreContext.Provider>
      </CachedResolutionsContext.Provider>
    </AppActionsContext.Provider>
  );
}

/** Access the app store. Throws if used outside the provider. */
export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (store == null) {
    throw new Error("useAppStore must be used within an <AppStoreProvider>");
  }
  return store;
}

/** Access stable commands without subscribing to mutable app state. */
export function useAppActions(): AppActions {
  const actions = useContext(AppActionsContext);
  if (actions == null) {
    throw new Error("useAppActions must be used within an <AppStoreProvider>");
  }
  return actions;
}

/** Subscribe only to ready-to-play cache badges. The 30 second resolution poll
 * can update this map without re-rendering every general AppStore consumer. */
export function useCachedResolutions(): Record<string, CachedResolutionRecord> {
  const resolutions = useContext(CachedResolutionsContext);
  if (resolutions == null) {
    throw new Error("useCachedResolutions must be used within an <AppStoreProvider>");
  }
  return resolutions;
}

/** Convenience hook for the effective Simple/Advanced experience tier. */
export function useSimpleMode(): boolean {
  return useAppStore().simpleMode;
}
