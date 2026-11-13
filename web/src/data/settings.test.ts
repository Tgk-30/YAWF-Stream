// Tests for the pure parse/normalize/merge/default logic in settings.ts plus
// the localStorage load/save and the Store-backed loadSettingsFromStore /
// saveSettingsToStore (with getStore/getSecretStore mocked). The UI-coupled
// service construction (buildServices) is intentionally skipped.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---- Mock the storage port (getStore / getSecretStore) ----------------------
//
// An in-memory fake Store + SecretStore so loadSettingsFromStore /
// saveSettingsToStore exercise their real merge/reconcile logic without Dexie.

interface DebridConfigRow {
  id: string;
  service: string;
  apiToken: string;
  isActive: boolean;
  priority: number;
}
interface IndexerConfigRow {
  id: string;
  type: string;
  baseURL: string;
  apiKey: string | null;
  isActive: boolean;
  displayName: string | null;
  providerSubtype: string;
  endpointPath: string;
  categoryFilter: string | null;
  priority: number;
}

const settingsMap = new Map<string, string>();
const secretMap = new Map<string, string>();
let debridConfigs: DebridConfigRow[] = [];
let indexerConfigs: IndexerConfigRow[] = [];

const fakeStore = {
  getSetting: vi.fn(async (key: string) => settingsMap.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string | null) => {
    if (value == null) settingsMap.delete(key);
    else settingsMap.set(key, value);
  }),
  allSettings: vi.fn(async () => Object.fromEntries(settingsMap)),
  listDebridConfigs: vi.fn(async () => debridConfigs.map((c) => ({ ...c }))),
  saveDebridConfig: vi.fn(async (c: DebridConfigRow) => {
    const i = debridConfigs.findIndex((x) => x.id === c.id);
    if (i >= 0) debridConfigs[i] = { ...c };
    else debridConfigs.push({ ...c });
  }),
  deleteDebridConfig: vi.fn(async (id: string) => {
    debridConfigs = debridConfigs.filter((c) => c.id !== id);
  }),
  listIndexerConfigs: vi.fn(async () => indexerConfigs.map((c) => ({ ...c }))),
  saveIndexerConfig: vi.fn(async (c: IndexerConfigRow) => {
    const i = indexerConfigs.findIndex((x) => x.id === c.id);
    if (i >= 0) indexerConfigs[i] = { ...c };
    else indexerConfigs.push({ ...c });
  }),
  deleteIndexerConfig: vi.fn(async (id: string) => {
    indexerConfigs = indexerConfigs.filter((c) => c.id !== id);
  }),
};

const fakeSecrets = {
  getSecret: vi.fn(async (key: string) => secretMap.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => {
    secretMap.set(key, value);
  }),
  deleteSecret: vi.fn(async (key: string) => {
    secretMap.delete(key);
  }),
};

vi.mock("../storage", () => ({
  getStore: () => fakeStore,
  getSecretStore: () => fakeSecrets,
}));

// ---- Import under test (after the mock is registered) -----------------------

import {
  normalizeStreamMaxQuality,
  normalizeStreamMaxSizeGB,
  normalizeRatingScale,
  normalizeDefaultPlaybackSpeed,
  normalizeDefaultVolume,
  normalizeAppearanceNavOrder,
  normalizeAppearanceNavHidden,
  defaultSettings,
  loadSettings,
  saveSettings,
  redactSecrets,
  loadSettingsFromStore,
  saveSettingsToStore,
  type AppSettings,
} from "./settings";
import { DEFAULT_THEME_ID } from "../theme/themes";

function resetStorageState(): void {
  settingsMap.clear();
  secretMap.clear();
  debridConfigs = [];
  indexerConfigs = [];
}

beforeEach(() => {
  resetStorageState();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// Pure normalizers
// =============================================================================

describe("normalizeStreamMaxQuality", () => {
  it("passes through the valid enum values", () => {
    for (const v of ["4K", "1080p", "720p", "480p", "SD"] as const) {
      expect(normalizeStreamMaxQuality(v)).toBe(v);
    }
  });

  it('defaults unknown / null / numeric values to "any"', () => {
    expect(normalizeStreamMaxQuality("any")).toBe("any");
    expect(normalizeStreamMaxQuality("8K")).toBe("any");
    expect(normalizeStreamMaxQuality(null)).toBe("any");
    expect(normalizeStreamMaxQuality(undefined)).toBe("any");
    expect(normalizeStreamMaxQuality(1080)).toBe("any");
    expect(normalizeStreamMaxQuality("1080P")).toBe("any"); // case-sensitive
  });
});

describe("default playback preference normalizers", () => {
  it("accepts supported speeds and clamps volume to a percentage", () => {
    expect(normalizeDefaultPlaybackSpeed(1.25)).toBe(1.25);
    expect(normalizeDefaultPlaybackSpeed("2")).toBe(2);
    expect(normalizeDefaultPlaybackSpeed(1.1)).toBe(1);
    expect(normalizeDefaultVolume(67.6)).toBe(68);
    expect(normalizeDefaultVolume(-2)).toBe(0);
    expect(normalizeDefaultVolume(150)).toBe(100);
    expect(normalizeDefaultVolume("garbage")).toBe(100);
  });
});

describe("normalizeStreamMaxSizeGB", () => {
  it("returns 0 for non-positive / non-finite / invalid input", () => {
    expect(normalizeStreamMaxSizeGB(0)).toBe(0);
    expect(normalizeStreamMaxSizeGB(-5)).toBe(0);
    expect(normalizeStreamMaxSizeGB(NaN)).toBe(0);
    expect(normalizeStreamMaxSizeGB(Infinity)).toBe(0);
    expect(normalizeStreamMaxSizeGB("not-a-number")).toBe(0);
    expect(normalizeStreamMaxSizeGB(null)).toBe(0);
    expect(normalizeStreamMaxSizeGB(undefined)).toBe(0);
  });

  it("rounds to one decimal place", () => {
    expect(normalizeStreamMaxSizeGB(12.34)).toBe(12.3);
    expect(normalizeStreamMaxSizeGB(12.36)).toBe(12.4);
  });

  it("parses numeric strings", () => {
    expect(normalizeStreamMaxSizeGB("25")).toBe(25);
    expect(normalizeStreamMaxSizeGB("7.55")).toBe(7.6);
  });

  it("clamps at the 500 GB ceiling", () => {
    expect(normalizeStreamMaxSizeGB(9999)).toBe(500);
    expect(normalizeStreamMaxSizeGB(500)).toBe(500);
    expect(normalizeStreamMaxSizeGB(500.9)).toBe(500);
  });
});

describe("normalizeRatingScale", () => {
  it("passes through the three legal scales", () => {
    expect(normalizeRatingScale("ten")).toBe("ten");
    expect(normalizeRatingScale("hundred")).toBe("hundred");
    expect(normalizeRatingScale("thumbs")).toBe("thumbs");
  });

  it("falls back to the 1–10 default for anything else", () => {
    expect(normalizeRatingScale(undefined)).toBe("ten");
    expect(normalizeRatingScale(null)).toBe("ten");
    expect(normalizeRatingScale("five")).toBe("ten");
    expect(normalizeRatingScale(10)).toBe("ten");
    expect(normalizeRatingScale({})).toBe("ten");
  });
});

// =============================================================================
// defaultSettings
// =============================================================================

describe("defaultSettings", () => {
  it('defaults networkMode to "standard"', () => {
    expect(defaultSettings().networkMode).toBe("standard");
  });
  it("defaults new profiles to Advanced and Midnight", () => {
    const d = defaultSettings();
    expect(d.debridTokens).toEqual([]);
    expect(d.sources).toEqual([]);
    expect(d.builtInIndexersEnabled).toBe(false);
    expect(d.aiProvider).toBe("anthropic");
    expect(d.ollamaEndpoint).toBe("http://localhost:11434");
    expect(d.theme).toBe("midnight");
    expect(d.appearanceAccent).toBe("cyan");
    expect(d.appearanceBlur).toBe(12);
    expect(d.appearanceRadius).toBe("default");
    expect(d.appearanceBackdrop).toBe("subtle");
    expect(d.appearanceHeroScale).toBe("standard");
    expect(d.appearancePosterSize).toBe("default");
    expect(d.appearanceNavHidden).toContain("assistant");
    expect(d.subtitleFontScale).toBe(1);
    expect(d.subtitleTextColor).toBe("#ffffff");
    expect(d.subtitleBgOpacity).toBe(0.55);
    expect(d.defaultAudioLanguage).toBe("");
    expect(d.defaultSubtitleBehavior).toBe("off");
    expect(d.defaultSubtitleLanguage).toBe("");
    expect(d.defaultPlaybackSpeed).toBe(1);
    expect(d.defaultVolume).toBe(100);
    expect(d.rememberPerTitleTrackChoices).toBe(true);
    expect(d.iosHlsPlaybackMode).toBe("native");
    expect(d.simpleMode).toBe(true);
    expect(d.autoUpdateChecks).toBe(true);
    expect(d.autoInstallUpdates).toBe(false);
    expect(d.streamCachedOnly).toBe(true);
    expect(d.streamMaxQuality).toBe("any");
    expect(d.streamMaxSizeGB).toBe(0);
    expect(d.dataSaver).toBe(false);
    expect(d.transcode).toBe(false);
    expect(d.traktScrobbleEnabled).toBe(false);
    expect(d.showPosterRatings).toBe(true);
  });

  it("returns a fresh object each call (no shared array identity)", () => {
    const a = defaultSettings();
    const b = defaultSettings();
    expect(a.debridTokens).not.toBe(b.debridTokens);
    a.sources.push({
      id: "x",
      type: "torznab",
      baseURL: "u",
      isActive: true,
    });
    expect(b.sources).toEqual([]);
  });
});

// =============================================================================
// loadSettings / saveSettings (localStorage)
// =============================================================================

/** A minimal in-memory localStorage stub. */
function stubLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const ls = {
    getItem: vi.fn((k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
    clear: vi.fn(() => map.clear()),
    key: vi.fn(),
    length: 0,
  };
  vi.stubGlobal("localStorage", ls);
  return { ls, map };
}

const KEY = "debridstreamer.settings.v1";

describe("loadSettings", () => {
  it("returns defaults when localStorage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadSettings()).toEqual(defaultSettings());
  });

  it("returns defaults when no blob is stored", () => {
    stubLocalStorage();
    expect(loadSettings()).toEqual(defaultSettings());
  });

  it("merges a stored partial blob over defaults", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "abc", simpleMode: false }),
    });
    const s = loadSettings();
    expect(s.tmdbKey).toBe("abc");
    expect(s.simpleMode).toBe(false);
    // Untouched fields keep their defaults.
    expect(s.aiProvider).toBe("anthropic");
  });

  it("keeps a persisted Simple and Aurora selection over the new defaults", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({ simpleMode: true, theme: "aurora" }),
    });

    const s = loadSettings();
    expect(s.simpleMode).toBe(true);
    expect(s.theme).toBe("aurora");
  });

  it("normalizes the opt-in Trakt scrobble toggle", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({ traktScrobbleEnabled: true }),
    });
    expect(loadSettings().traktScrobbleEnabled).toBe(true);

    stubLocalStorage({
      [KEY]: JSON.stringify({ traktScrobbleEnabled: "true" }),
    });
    expect(loadSettings().traktScrobbleEnabled).toBe(false);
  });

  it("normalizes the poster-rating display preference", () => {
    stubLocalStorage({ [KEY]: JSON.stringify({ showPosterRatings: false }) });
    expect(loadSettings().showPosterRatings).toBe(false);

    stubLocalStorage({ [KEY]: JSON.stringify({ showPosterRatings: "false" }) });
    expect(loadSettings().showPosterRatings).toBe(true);
  });

  it("normalizes legacy / invalid stored values to safe defaults", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({
        streamMaxQuality: "8K",
        streamMaxSizeGB: -3,
        appearanceAccent: "neon",
        appearanceDensity: "ultra",
        appearanceTextSize: "huge",
        appearanceMotion: "wiggle",
        appearanceRadius: "blobby",
        appearanceBlur: 999,
        appearanceChrome: "frosted",
        appearanceBackdrop: "loud",
        appearanceHeroScale: "giant",
        appearancePanelContrast: "extreme",
        appearanceNavLabels: "maybe",
        appearanceNavTint: "neon",
        appearancePosterSize: "tiny",
        subtitleFontScale: 99,
        subtitleTextColor: "red",
        subtitleBgOpacity: 5,
        defaultAudioLanguage: "engagement",
        defaultSubtitleBehavior: "always",
        defaultSubtitleLanguage: "???",
        defaultPlaybackSpeed: 1.1,
        defaultVolume: 999,
        rememberPerTitleTrackChoices: "true",
        iosHlsPlaybackMode: "managed",
        ratingScale: "eleven",
      }),
    });
    const s = loadSettings();
    expect(s.streamMaxQuality).toBe("any");
    expect(s.streamMaxSizeGB).toBe(0);
    expect(s.appearanceAccent).toBe("theme");
    expect(s.appearanceDensity).toBe("comfortable");
    expect(s.appearanceTextSize).toBe("m");
    expect(s.appearanceMotion).toBe("system");
    // These three normalize to their neutral fallbacks (not the new-user
    // premium defaults, which only apply to a fresh install with no stored blob).
    expect(s.appearanceRadius).toBe("default");
    expect(s.appearanceBlur).toBe(28); // clamped to max
    expect(s.appearanceChrome).toBe("balanced");
    expect(s.appearanceBackdrop).toBe("ambient");
    expect(s.appearanceHeroScale).toBe("standard");
    expect(s.appearancePanelContrast).toBe("standard");
    expect(s.appearanceNavLabels).toBe("auto");
    expect(s.appearanceNavTint).toBe("balanced");
    expect(s.appearancePosterSize).toBe("default");
    expect(s.subtitleFontScale).toBe(1.8); // clamped to max
    expect(s.subtitleTextColor).toBe("#ffffff");
    expect(s.subtitleBgOpacity).toBe(0.95); // clamped to max
    expect(s.defaultAudioLanguage).toBe("");
    expect(s.defaultSubtitleBehavior).toBe("off");
    expect(s.defaultSubtitleLanguage).toBe("");
    expect(s.defaultPlaybackSpeed).toBe(1);
    expect(s.defaultVolume).toBe(100);
    expect(s.rememberPerTitleTrackChoices).toBe(true);
    expect(s.iosHlsPlaybackMode).toBe("native");
    expect(s.ratingScale).toBe("ten"); // poisoned scale → 1–10 default
  });

  it("keeps valid appearance / subtitle values verbatim (lowercasing hex)", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({
        appearanceAccent: "cyan",
        appearanceBlur: 12,
        subtitleFontScale: 1.25,
        subtitleTextColor: "#AABBCC",
        subtitleBgOpacity: 0.3,
      }),
    });
    const s = loadSettings();
    expect(s.appearanceAccent).toBe("cyan");
    expect(s.appearanceBlur).toBe(12);
    expect(s.subtitleFontScale).toBe(1.25);
    expect(s.subtitleTextColor).toBe("#aabbcc");
    expect(s.subtitleBgOpacity).toBe(0.3);
  });

  it("normalizes stored default playback preferences without changing old blobs", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({
        defaultAudioLanguage: "French (Canada)",
        defaultSubtitleBehavior: "preferred",
        defaultSubtitleLanguage: "spa",
        defaultPlaybackSpeed: "1.5",
        defaultVolume: "42.4",
        rememberPerTitleTrackChoices: false,
        iosHlsPlaybackMode: "compatibility",
      }),
    });
    expect(loadSettings()).toMatchObject({
      defaultAudioLanguage: "fr",
      defaultSubtitleBehavior: "preferred",
      defaultSubtitleLanguage: "es",
      defaultPlaybackSpeed: 1.5,
      defaultVolume: 42,
      rememberPerTitleTrackChoices: false,
      iosHlsPlaybackMode: "compatibility",
    });
  });

  it("does not let a missing array clobber the [] defaults", () => {
    stubLocalStorage({ [KEY]: JSON.stringify({ tmdbKey: "x" }) });
    const s = loadSettings();
    expect(s.debridTokens).toEqual([]);
    expect(s.sources).toEqual([]);
  });

  it("preserves stored arrays when present", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({
        debridTokens: [{ service: "real_debrid", apiToken: "tok" }],
        sources: [{ id: "s1", type: "torznab", baseURL: "u", isActive: true }],
      }),
    });
    const s = loadSettings();
    expect(s.debridTokens).toHaveLength(1);
    expect(s.sources[0].id).toBe("s1");
  });

  it("returns defaults on malformed JSON (parse throws)", () => {
    stubLocalStorage({ [KEY]: "{not valid json" });
    expect(loadSettings()).toEqual(defaultSettings());
  });

  it("returns defaults when getItem itself throws", () => {
    const ls = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", ls);
    expect(loadSettings()).toEqual(defaultSettings());
  });
});

describe("saveSettings", () => {
  it("writes a JSON blob to localStorage under the v1 key", () => {
    const { ls, map } = stubLocalStorage();
    const s = defaultSettings();
    s.tmdbKey = "mykey";
    saveSettings(s);
    expect(ls.setItem).toHaveBeenCalledWith(KEY, JSON.stringify(s));
    expect(JSON.parse(map.get(KEY)!).tmdbKey).toBe("mykey");
  });

  it("no-ops without localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveSettings(defaultSettings())).not.toThrow();
  });

  it("swallows setItem errors (private mode / quota)", () => {
    const ls = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("QuotaExceeded");
      }),
    };
    vi.stubGlobal("localStorage", ls);
    expect(() => saveSettings(defaultSettings())).not.toThrow();
  });
});

describe("redactSecrets", () => {
  it("blanks every credential field but keeps non-secret settings", () => {
    const s: AppSettings = {
      ...defaultSettings(),
      tmdbKey: "tk",
      omdbKey: "ok",
      aiApiKey: "ak",
      openSubtitlesApiKey: "osk",
      debridTokens: [{ service: "real_debrid", apiToken: "rdt" }],
      sources: [
        { id: "x", type: "torznab", baseURL: "http://h", apiKey: "ik", isActive: true },
      ],
      theme: "midnight",
    };
    const r = redactSecrets(s);
    expect(r.tmdbKey).toBe("");
    expect(r.omdbKey).toBe("");
    expect(r.aiApiKey).toBe("");
    expect(r.openSubtitlesApiKey).toBe("");
    expect(r.debridTokens[0].apiToken).toBe("");
    expect(r.debridTokens[0].service).toBe("real_debrid"); // non-secret kept
    expect(r.sources[0].apiKey).toBeNull();
    expect(r.sources[0].baseURL).toBe("http://h"); // non-secret kept
    expect(r.theme).toBe("midnight");
    // Does not mutate the original.
    expect(s.tmdbKey).toBe("tk");
    expect(s.debridTokens[0].apiToken).toBe("rdt");
  });
});

describe("saveSettingsToStore - no plaintext secrets in the localStorage cache", () => {
  it("redacts every credential before writing the bootstrap blob", async () => {
    const { map } = stubLocalStorage();
    await saveSettingsToStore({
      ...defaultSettings(),
      tmdbKey: "SECRET_TMDB",
      omdbKey: "SECRET_OMDB",
      aiApiKey: "SECRET_AI",
      openSubtitlesApiKey: "SECRET_OS",
      debridTokens: [{ service: "real_debrid", apiToken: "SECRET_RD" }],
      sources: [
        { id: "s1", type: "torznab", baseURL: "http://idx", apiKey: "SECRET_IDX", isActive: true },
      ],
    });
    const blob = map.get(KEY) ?? "";
    expect(blob).not.toContain("SECRET_TMDB");
    expect(blob).not.toContain("SECRET_OMDB");
    expect(blob).not.toContain("SECRET_AI");
    expect(blob).not.toContain("SECRET_OS");
    expect(blob).not.toContain("SECRET_RD");
    expect(blob).not.toContain("SECRET_IDX");
    // Non-secret settings are still cached for the bootstrap render.
    expect(JSON.parse(blob).theme).toBeDefined();
    // The real secrets DID reach the SecretStore (not lost, just not in plaintext).
    expect(secretMap.get("tmdb_api_key")).toBe("SECRET_TMDB");
  });
});

// =============================================================================
// loadSettingsFromStore (Store-backed)
// =============================================================================

describe("loadSettingsFromStore - first-run migration", () => {
  it("persists and hydrates networkMode", async () => {
    settingsMap.set("storage_port_initialized", "true");
    await saveSettingsToStore({ ...defaultSettings(), networkMode: "offline" });
    expect(settingsMap.get("network_mode")).toBe("offline");
    await expect(loadSettingsFromStore()).resolves.toMatchObject({ networkMode: "offline" });
  });

  it("seeds the Store from the legacy localStorage blob on first run", async () => {
    // No storage_port_initialized flag -> migration path.
    stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "legacy-key", simpleMode: false }),
    });
    const result = await loadSettingsFromStore();
    // Returns the legacy settings verbatim.
    expect(result.tmdbKey).toBe("legacy-key");
    expect(result.simpleMode).toBe(false);
    // And marks the Store as initialized so the next load won't re-migrate.
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
    // The migration routed the TMDB key through the SecretStore (it's a secret).
    expect(secretMap.get("tmdb_api_key")).toBe("legacy-key");
    expect(settingsMap.get("tmdb_api_key")).toBe("secret:tmdb_api_key");
  });

  it("does NOT replay a redacted blob over already-migrated secrets (interrupted-migration race)", async () => {
    // Race state: a prior migration redacted the localStorage cache and wrote the
    // real secret + settings to the Store, but crashed before setting the init
    // flag. The next load must NOT migrate the blank blob over the real Store
    // secret. (The migration always writes `theme`, so its presence is how we
    // detect the Store was already populated by an interrupted migration.)
    stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "", simpleMode: false }), // redacted
    });
    settingsMap.set("ui_theme", "midnight"); // Store already written by prior run
    settingsMap.set("tmdb_api_key", "secret:tmdb_api_key"); // marker in Store
    secretMap.set("tmdb_api_key", "REAL_KEY"); // real secret already migrated

    const result = await loadSettingsFromStore();

    // The real secret survives (was NOT overwritten with "").
    expect(secretMap.get("tmdb_api_key")).toBe("REAL_KEY");
    expect(result.tmdbKey).toBe("REAL_KEY");
    // And the Store is now marked initialized so it won't re-evaluate next time.
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });

  it("marks initialized without replay on a fresh install (empty legacy blob)", async () => {
    vi.stubGlobal("localStorage", undefined); // no legacy blob at all
    const result = await loadSettingsFromStore();
    expect(result.tmdbKey).toBe("");
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });

  it("migrates a genuine keyless first run (non-secret settings, empty Store)", async () => {
    // A real legacy blob with NO credentials but non-secret settings, into an
    // empty Store. Must still migrate those settings (not be mistaken for a
    // redacted post-migration cache).
    stubLocalStorage({
      [KEY]: JSON.stringify({ theme: "aurora", simpleMode: false }),
    });
    const result = await loadSettingsFromStore();
    expect(result.simpleMode).toBe(false);
    // The non-secret settings reached the Store.
    expect(settingsMap.get("ui_theme")).toBeDefined();
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });

  it("does NOT replay over a populated Store, and preserves the legacy cache for recovery", async () => {
    // Interrupted migration: the legacy still holds a secret, but the Store
    // already has data (a partial signal). Replaying could overwrite newer Store
    // values, so we SKIP - and must NOT scrub the legacy cache (it holds the
    // still-unmigrated secret, recoverable on the next steady-state load).
    const { map } = stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "REAL_FROM_LEGACY", simpleMode: false }),
    });
    settingsMap.set("ui_theme", "midnight"); // a partial store signal
    await loadSettingsFromStore();
    expect(settingsMap.get("ui_theme")).toBe("midnight"); // untouched
    expect(JSON.parse(map.get(KEY)!).tmdbKey).toBe("REAL_FROM_LEGACY"); // not scrubbed
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });

  it("detects a partial Store via omdb/opensubtitles markers, not just theme", async () => {
    // Redacted legacy + a Store holding ONLY an omdb secret marker (no theme).
    // storeHasData must see the omdb marker so the redacted replay can't wipe it.
    stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "", simpleMode: false }), // redacted
    });
    settingsMap.set("omdb_api_key", "secret:omdb_api_key");
    secretMap.set("omdb_api_key", "REAL_OMDB");
    const result = await loadSettingsFromStore();
    expect(secretMap.get("omdb_api_key")).toBe("REAL_OMDB"); // not wiped
    expect(result.omdbKey).toBe("REAL_OMDB");
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });

  it("keeps the legacy plaintext intact + unflagged when a migration secret write fails", async () => {
    // Keychain locked mid-migration: the secret write rejects. The legacy cache
    // must NOT be redacted and the init flag must stay unset, so the next launch
    // retries from the still-authoritative legacy blob (no data loss).
    const { map } = stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "LEGACY_TMDB", simpleMode: false }),
    });
    fakeSecrets.setSecret.mockRejectedValueOnce(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadSettingsFromStore();

    expect(result.tmdbKey).toBe("LEGACY_TMDB"); // session still works
    // Durable state is left retryable: flag unset, cache NOT redacted.
    expect(settingsMap.get("storage_port_initialized")).toBeUndefined();
    expect(JSON.parse(map.get(KEY)!).tmdbKey).toBe("LEGACY_TMDB"); // still plaintext
    warn.mockRestore();
    fakeSecrets.setSecret.mockImplementation(async (key: string, value: string) => {
      secretMap.set(key, value);
    });
  });

  it("skips replay over a populated Store: a stale legacy neither overwrites nor wipes Store secrets", async () => {
    // codex-8 findings 1+2: legacy is stale (tmdb=T_OLD only); the Store holds a
    // NEWER tmdb (T_NEW) plus a later-added OMDB. Skipping replay (Store has data)
    // means the stale value can't overwrite T_NEW and the empty omdb can't wipe it.
    stubLocalStorage({
      [KEY]: JSON.stringify({ tmdbKey: "T_OLD", simpleMode: false }),
    });
    settingsMap.set("tmdb_api_key", "secret:tmdb_api_key");
    secretMap.set("tmdb_api_key", "T_NEW");
    settingsMap.set("omdb_api_key", "secret:omdb_api_key");
    secretMap.set("omdb_api_key", "REAL_OMDB");

    const result = await loadSettingsFromStore();

    expect(secretMap.get("tmdb_api_key")).toBe("T_NEW"); // stale T_OLD did NOT overwrite
    expect(secretMap.get("omdb_api_key")).toBe("REAL_OMDB"); // NOT wiped
    expect(result.tmdbKey).toBe("T_NEW");
    expect(result.omdbKey).toBe("REAL_OMDB");
  });

  it("never replays (so can't wipe) when there is no legacy blob but the Store has data", async () => {
    // No legacy blob at all + a Store that already holds a secret. Even if the
    // build has env-default keys, the absence of a RAW legacy blob means no
    // replay - so the real Store secret can't be wiped.
    vi.stubGlobal("localStorage", undefined);
    settingsMap.set("omdb_api_key", "secret:omdb_api_key");
    secretMap.set("omdb_api_key", "REAL_OMDB");
    const result = await loadSettingsFromStore();
    expect(secretMap.get("omdb_api_key")).toBe("REAL_OMDB"); // not wiped
    expect(result.omdbKey).toBe("REAL_OMDB");
    expect(settingsMap.get("storage_port_initialized")).toBe("true");
  });
});

describe("loadSettingsFromStore - established store", () => {
  beforeEach(() => {
    // Mark initialized so we take the normal (non-migration) read path.
    settingsMap.set("storage_port_initialized", "true");
    vi.stubGlobal("localStorage", undefined);
  });

  it("returns merged defaults when the store is otherwise empty", async () => {
    const s = await loadSettingsFromStore();
    expect(s.tmdbKey).toBe("");
    expect(s.builtInIndexersEnabled).toBe(false); // null -> privacy-safe default
    expect(s.simpleMode).toBe(true);
    expect(s.theme).toBe(DEFAULT_THEME_ID);
    expect(s.streamCachedOnly).toBe(true);
    expect(s.streamMaxQuality).toBe("any");
    expect(s.defaultPlaybackSpeed).toBe(1);
    expect(s.defaultVolume).toBe(100);
    expect(s.rememberPerTitleTrackChoices).toBe(true);
    expect(s.iosHlsPlaybackMode).toBe("native");
    expect(s.debridTokens).toEqual([]);
    expect(s.sources).toEqual([]);
  });

  it("resolves secret-marked values from the SecretStore", async () => {
    settingsMap.set("tmdb_api_key", "secret:tmdb_api_key");
    secretMap.set("tmdb_api_key", "resolved-tmdb");
    settingsMap.set("omdb_api_key", "plain-omdb"); // non-marker passthrough
    const s = await loadSettingsFromStore();
    expect(s.tmdbKey).toBe("resolved-tmdb");
    expect(s.omdbKey).toBe("plain-omdb");
  });

  it("hydrates scalar and secret values from one bulk settings snapshot", async () => {
    settingsMap.set("simple_mode", "true");
    settingsMap.set("tmdb_api_key", "secret:tmdb_api_key");
    secretMap.set("tmdb_api_key", "resolved-tmdb");

    const fromSnapshot = await loadSettingsFromStore();

    expect(fromSnapshot.simpleMode).toBe(true);
    expect(fromSnapshot.tmdbKey).toBe("resolved-tmdb");
    expect(fakeStore.allSettings).toHaveBeenCalledTimes(1);
    expect(fakeStore.getSetting).not.toHaveBeenCalled();

    // The fake can expose the identical records through individual reads too;
    // its bulk adapter must produce the same fully-normalized AppSettings.
    vi.clearAllMocks();
    fakeStore.allSettings.mockImplementationOnce(async () =>
      Object.fromEntries(
        await Promise.all(
          Array.from(settingsMap.keys()).map(async (key) => [
            key,
            await fakeStore.getSetting(key),
          ]),
        ),
      ),
    );
    await expect(loadSettingsFromStore()).resolves.toEqual(fromSnapshot);
  });

  it("keeps persisted Simple and Aurora values when the durable store hydrates", async () => {
    settingsMap.set("simple_mode", "true");
    settingsMap.set("ui_theme", "aurora");

    const s = await loadSettingsFromStore();
    expect(s.simpleMode).toBe(true);
    expect(s.theme).toBe("aurora");
  });

  it("parses boolean string flags correctly", async () => {
    settingsMap.set("built_in_indexers_enabled", "false");
    settingsMap.set("simple_mode", "false");
    settingsMap.set("auto_update_checks", "false");
    settingsMap.set("auto_install_updates", "true");
    settingsMap.set("stream_cached_only", "true");
    settingsMap.set("data_saver", "true");
    settingsMap.set("transcode", "true");
    settingsMap.set("trakt_scrobble_enabled", "true");
    settingsMap.set("default_audio_language", "jpn");
    settingsMap.set("default_subtitle_behavior", "preferred");
    settingsMap.set("default_subtitle_language", "en-GB");
    settingsMap.set("default_playback_speed", "1.25");
    settingsMap.set("default_volume", "45");
    settingsMap.set("remember_per_title_track_choices", "false");
    settingsMap.set("ios_hls_playback_mode", "compatibility");
    const s = await loadSettingsFromStore();
    expect(s.builtInIndexersEnabled).toBe(false);
    expect(s.simpleMode).toBe(false);
    expect(s.autoUpdateChecks).toBe(false);
    expect(s.autoInstallUpdates).toBe(true);
    expect(s.streamCachedOnly).toBe(true);
    expect(s.dataSaver).toBe(true);
    expect(s.transcode).toBe(true);
    expect(s.traktScrobbleEnabled).toBe(true);
    expect(s.defaultAudioLanguage).toBe("ja");
    expect(s.defaultSubtitleBehavior).toBe("preferred");
    expect(s.defaultSubtitleLanguage).toBe("en");
    expect(s.defaultPlaybackSpeed).toBe(1.25);
    expect(s.defaultVolume).toBe(45);
    expect(s.rememberPerTitleTrackChoices).toBe(false);
    expect(s.iosHlsPlaybackMode).toBe("compatibility");
  });

  it("keeps an existing saved cached-only choice", async () => {
    settingsMap.set("stream_cached_only", "false");
    const s = await loadSettingsFromStore();
    expect(s.streamCachedOnly).toBe(false);
  });

  it("treats any non-'true' boolean string as false", async () => {
    settingsMap.set("simple_mode", "yes"); // not exactly "true"
    const s = await loadSettingsFromStore();
    expect(s.simpleMode).toBe(false);
  });

  it("normalizes invalid stored appearance / subtitle values", async () => {
    settingsMap.set("appearance_accent", "neon");
    settingsMap.set("appearance_blur", "999");
    settingsMap.set("subtitle_bg_opacity", "9");
    settingsMap.set("stream_max_quality", "8K");
    settingsMap.set("stream_max_size_gb", "-1");
    const s = await loadSettingsFromStore();
    expect(s.appearanceAccent).toBe("theme");
    expect(s.appearanceBlur).toBe(28);
    expect(s.subtitleBgOpacity).toBe(0.95);
    expect(s.streamMaxQuality).toBe("any");
    expect(s.streamMaxSizeGB).toBe(0);
  });

  it("resolves an invalid stored theme id to the default", async () => {
    settingsMap.set("ui_theme", "not-a-real-theme");
    const s = await loadSettingsFromStore();
    expect(s.theme).toBe(DEFAULT_THEME_ID);
  });

  it("loads debrid tokens from configs + SecretStore, skipping empty tokens", async () => {
    debridConfigs = [
      { id: "debrid-real_debrid", service: "real_debrid", apiToken: "secret:debrid.debrid-real_debrid", isActive: true, priority: 0 },
      { id: "debrid-torbox", service: "torbox", apiToken: "secret:debrid.debrid-torbox", isActive: true, priority: 1 },
    ];
    secretMap.set("debrid.debrid-real_debrid", "rd-token");
    // torbox has no secret -> "" -> skipped.
    const s = await loadSettingsFromStore();
    expect(s.debridTokens).toEqual([
      { service: "real_debrid", apiToken: "rd-token" },
    ]);
  });

  it("maps non-built_in indexer configs to sources and drops built_in", async () => {
    indexerConfigs = [
      {
        id: "i1",
        type: "torznab",
        baseURL: "http://idx",
        apiKey: "k",
        isActive: true,
        displayName: "My Idx",
        providerSubtype: "custom_torznab",
        endpointPath: "/api",
        categoryFilter: null,
        priority: 3,
      },
      {
        id: "built-in",
        type: "built_in",
        baseURL: "",
        apiKey: null,
        isActive: false,
        displayName: null,
        providerSubtype: "built_in",
        endpointPath: "",
        categoryFilter: null,
        priority: 0,
      },
    ];
    const s = await loadSettingsFromStore();
    expect(s.sources).toEqual([
      {
        id: "i1",
        type: "torznab",
        baseURL: "http://idx",
        apiKey: "k",
        isActive: true,
        displayName: "My Idx",
        priority: 3,
      },
    ]);
  });
});

// =============================================================================
// saveSettingsToStore (Store-backed)
// =============================================================================

describe("saveSettingsToStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", undefined);
  });

  function settingsWith(overrides: Partial<AppSettings>): AppSettings {
    return { ...defaultSettings(), ...overrides };
  }

  it("routes secret keys through SecretStore and leaves a marker in the KV table", async () => {
    await saveSettingsToStore(
      settingsWith({ tmdbKey: "tmdb123", omdbKey: "" }),
    );
    // tmdb key set -> secret stored + marker written.
    expect(secretMap.get("tmdb_api_key")).toBe("tmdb123");
    expect(settingsMap.get("tmdb_api_key")).toBe("secret:tmdb_api_key");
    // empty omdb key -> secret deleted + KV null (deleted).
    expect(secretMap.has("omdb_api_key")).toBe(false);
    expect(settingsMap.has("omdb_api_key")).toBe(false);
  });

  it("persists scalar + boolean settings as their string forms", async () => {
    await saveSettingsToStore(
      settingsWith({
        aiProvider: "openai",
        aiModel: "gpt-4o",
        simpleMode: false,
        autoUpdateChecks: false,
        transcode: true,
        traktScrobbleEnabled: true,
        showPosterRatings: false,
        streamMaxSizeGB: 12.34,
        appearanceBlur: 999, // normalized on write
        defaultAudioLanguage: "German",
        defaultSubtitleBehavior: "preferred",
        defaultSubtitleLanguage: "French",
        defaultPlaybackSpeed: 1.5,
        defaultVolume: 67,
        rememberPerTitleTrackChoices: false,
        iosHlsPlaybackMode: "compatibility",
      }),
    );
    expect(settingsMap.get("ai_provider")).toBe("openai");
    expect(settingsMap.get("ai_model")).toBe("gpt-4o");
    expect(settingsMap.get("simple_mode")).toBe("false");
    expect(settingsMap.get("auto_update_checks")).toBe("false");
    expect(settingsMap.get("transcode")).toBe("true");
    expect(settingsMap.get("trakt_scrobble_enabled")).toBe("true");
    expect(settingsMap.get("show_poster_ratings")).toBe("false");
    expect(settingsMap.get("stream_max_size_gb")).toBe("12.3");
    expect(settingsMap.get("appearance_blur")).toBe("28"); // clamped
    expect(settingsMap.get("default_audio_language")).toBe("de");
    expect(settingsMap.get("default_subtitle_behavior")).toBe("preferred");
    expect(settingsMap.get("default_subtitle_language")).toBe("fr");
    expect(settingsMap.get("default_playback_speed")).toBe("1.5");
    expect(settingsMap.get("ios_hls_playback_mode")).toBe("compatibility");
    expect(settingsMap.get("default_volume")).toBe("67");
    expect(settingsMap.get("remember_per_title_track_choices")).toBe("false");
  });

  it("writes only a changed scalar when the caller supplies the prior settings", async () => {
    const previous = settingsWith({ simpleMode: true });
    const next = { ...previous, simpleMode: false };

    await saveSettingsToStore(next, { previous });

    const scalarWrites = fakeStore.setSetting.mock.calls.filter(
      ([key]) => !["tmdb_api_key", "trakt_client_id", "trakt_client_secret", "omdb_api_key", "ai_api_key", "opensubtitles_api_key"].includes(key),
    );
    expect(scalarWrites).toEqual([["simple_mode", "false"]]);
  });

  it("keeps an appearance-only save to one scalar write and zero secret or config operations", async () => {
    const previous = settingsWith({
      tmdbKey: "tmdb",
      traktClientId: "trakt-client",
      traktClientSecret: "trakt-secret",
      omdbKey: "omdb",
      aiApiKey: "ai",
      openSubtitlesApiKey: "subtitles",
      debridTokens: [{ service: "real_debrid", apiToken: "rd" }],
      sources: [
        {
          id: "source",
          type: "torznab",
          baseURL: "http://indexer",
          apiKey: "indexer-key",
          isActive: true,
          displayName: "Indexer",
          priority: 2,
        },
      ],
      builtInIndexersEnabled: false,
      appearanceBlur: 12,
    });
    const next = {
      ...previous,
      appearanceBlur: 14,
      // Equal cloned arrays prove the budget does not depend on reference identity.
      debridTokens: previous.debridTokens.map((entry) => ({ ...entry })),
      sources: previous.sources.map((entry) => ({ ...entry })),
    };

    await saveSettingsToStore(next, { previous });

    expect(fakeStore.setSetting.mock.calls).toEqual([["appearance_blur", "14"]]);
    expect(fakeSecrets.getSecret).not.toHaveBeenCalled();
    expect(fakeSecrets.setSecret).not.toHaveBeenCalled();
    expect(fakeSecrets.deleteSecret).not.toHaveBeenCalled();
    expect(fakeStore.listDebridConfigs).not.toHaveBeenCalled();
    expect(fakeStore.saveDebridConfig).not.toHaveBeenCalled();
    expect(fakeStore.deleteDebridConfig).not.toHaveBeenCalled();
    expect(fakeStore.listIndexerConfigs).not.toHaveBeenCalled();
    expect(fakeStore.saveIndexerConfig).not.toHaveBeenCalled();
    expect(fakeStore.deleteIndexerConfig).not.toHaveBeenCalled();
  });

  it("persists all six credential fields when they changed from the prior settings", async () => {
    const previous = settingsWith({
      tmdbKey: "old-tmdb",
      traktClientId: "old-trakt-client",
      traktClientSecret: "old-trakt-secret",
      omdbKey: "old-omdb",
      aiApiKey: "old-ai",
      openSubtitlesApiKey: "old-subtitles",
    });
    const next = {
      ...previous,
      tmdbKey: "new-tmdb",
      traktClientId: "new-trakt-client",
      traktClientSecret: "new-trakt-secret",
      omdbKey: "new-omdb",
      aiApiKey: "new-ai",
      openSubtitlesApiKey: "new-subtitles",
    };

    await saveSettingsToStore(next, { previous });

    const expectedSecrets = [
      ["tmdb_api_key", "new-tmdb"],
      ["trakt_client_id", "new-trakt-client"],
      ["trakt_client_secret", "new-trakt-secret"],
      ["omdb_api_key", "new-omdb"],
      ["ai_api_key", "new-ai"],
      ["opensubtitles_api_key", "new-subtitles"],
    ];
    expect(fakeSecrets.setSecret).toHaveBeenCalledTimes(expectedSecrets.length);
    for (const [key, value] of expectedSecrets) {
      expect(fakeSecrets.setSecret).toHaveBeenCalledWith(key, value);
      expect(fakeStore.setSetting).toHaveBeenCalledWith(key, `secret:${key}`);
    }
    expect(fakeStore.setSetting).toHaveBeenCalledTimes(expectedSecrets.length);
    expect(fakeSecrets.deleteSecret).not.toHaveBeenCalled();
    expect(fakeStore.listDebridConfigs).not.toHaveBeenCalled();
    expect(fakeStore.listIndexerConfigs).not.toHaveBeenCalled();
  });

  it("writes zero scalars when the next settings equal the supplied prior settings", async () => {
    const current = settingsWith({ theme: "aurora" });

    await saveSettingsToStore(current, { previous: current });

    const scalarWrites = fakeStore.setSetting.mock.calls.filter(
      ([key]) => !["tmdb_api_key", "trakt_client_id", "trakt_client_secret", "omdb_api_key", "ai_api_key", "opensubtitles_api_key"].includes(key),
    );
    expect(scalarWrites).toEqual([]);
  });

  it("writes debrid tokens to SecretStore + a marker'd config row, skipping blank tokens", async () => {
    await saveSettingsToStore(
      settingsWith({
        debridTokens: [
          { service: "real_debrid", apiToken: "rd" },
          { service: "torbox", apiToken: "   " }, // blank -> skipped
        ],
      }),
    );
    expect(debridConfigs).toHaveLength(1);
    const row = debridConfigs[0];
    expect(row.id).toBe("debrid-real_debrid");
    expect(row.apiToken).toBe("secret:debrid.debrid-real_debrid");
    expect(secretMap.get("debrid.debrid-real_debrid")).toBe("rd");
  });

  it("reconciles debrid configs - removes stale entries no longer in settings", async () => {
    // Pre-existing stale config.
    debridConfigs = [
      { id: "debrid-premiumize", service: "premiumize", apiToken: "secret:debrid.debrid-premiumize", isActive: true, priority: 0 },
    ];
    secretMap.set("debrid.debrid-premiumize", "old");
    await saveSettingsToStore(
      settingsWith({ debridTokens: [{ service: "real_debrid", apiToken: "rd" }] }),
    );
    const ids = debridConfigs.map((c) => c.id);
    expect(ids).toContain("debrid-real_debrid");
    expect(ids).not.toContain("debrid-premiumize");
    expect(secretMap.has("debrid.debrid-premiumize")).toBe(false);
  });

  it("persists indexer sources as config records with priority from index", async () => {
    await saveSettingsToStore(
      settingsWith({
        sources: [
          { id: "a", type: "jackett", baseURL: "http://j", isActive: true },
          { id: "b", type: "prowlarr", baseURL: "http://p", isActive: true, priority: 7 },
        ],
      }),
    );
    const a = indexerConfigs.find((c) => c.id === "a")!;
    const b = indexerConfigs.find((c) => c.id === "b")!;
    expect(a.priority).toBe(0); // fell back to index
    expect(a.providerSubtype).toBe("jackett");
    expect(b.priority).toBe(7); // explicit priority preserved
    expect(b.providerSubtype).toBe("prowlarr");
  });

  it("writes a disabled built-in row only when built-in indexers are disabled", async () => {
    await saveSettingsToStore(settingsWith({ builtInIndexersEnabled: false }));
    const builtIn = indexerConfigs.find((c) => c.id === "built-in");
    expect(builtIn).toBeDefined();
    expect(builtIn!.type).toBe("built_in");
    expect(builtIn!.isActive).toBe(false);
  });

  it("does not write a built-in row when built-in indexers are enabled", async () => {
    await saveSettingsToStore(settingsWith({ builtInIndexersEnabled: true }));
    expect(indexerConfigs.find((c) => c.id === "built-in")).toBeUndefined();
  });

  it("removes indexer configs that are no longer in the sources list", async () => {
    indexerConfigs = [
      {
        id: "stale",
        type: "torznab",
        baseURL: "http://old",
        apiKey: null,
        isActive: true,
        displayName: null,
        providerSubtype: "custom_torznab",
        endpointPath: "/api",
        categoryFilter: null,
        priority: 0,
      },
    ];
    await saveSettingsToStore(
      settingsWith({
        sources: [{ id: "fresh", type: "torznab", baseURL: "http://new", isActive: true }],
      }),
    );
    const ids = indexerConfigs.map((c) => c.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });

  it("round-trips through save then load", async () => {
    settingsMap.set("storage_port_initialized", "true");
    const original = settingsWith({
      tmdbKey: "T",
      omdbKey: "O",
      aiProvider: "openai",
      aiModel: "m1",
      simpleMode: false,
      traktScrobbleEnabled: true,
      showPosterRatings: false,
      streamMaxQuality: "1080p",
      streamMaxSizeGB: 20,
      appearanceAccent: "rose",
      subtitleTextColor: "#123456",
      defaultAudioLanguage: "Spanish",
      defaultSubtitleBehavior: "preferred",
      defaultSubtitleLanguage: "English",
      defaultPlaybackSpeed: 1.25,
      defaultVolume: 35,
      rememberPerTitleTrackChoices: false,
      iosHlsPlaybackMode: "compatibility",
      debridTokens: [{ service: "real_debrid", apiToken: "rd-tok" }],
      sources: [{ id: "src1", type: "jackett", baseURL: "http://j", isActive: true, apiKey: "ak", displayName: "J", priority: 0 }],
    });
    await saveSettingsToStore(original);
    const loaded = await loadSettingsFromStore();
    expect(loaded.tmdbKey).toBe("T");
    expect(loaded.omdbKey).toBe("O");
    expect(loaded.aiProvider).toBe("openai");
    expect(loaded.aiModel).toBe("m1");
    expect(loaded.simpleMode).toBe(false);
    expect(loaded.traktScrobbleEnabled).toBe(true);
    expect(loaded.showPosterRatings).toBe(false);
    expect(loaded.streamMaxQuality).toBe("1080p");
    expect(loaded.streamMaxSizeGB).toBe(20);
    expect(loaded.appearanceAccent).toBe("rose");
    expect(loaded.subtitleTextColor).toBe("#123456");
    expect(loaded.defaultAudioLanguage).toBe("es");
    expect(loaded.defaultSubtitleBehavior).toBe("preferred");
    expect(loaded.defaultSubtitleLanguage).toBe("en");
    expect(loaded.defaultPlaybackSpeed).toBe(1.25);
    expect(loaded.defaultVolume).toBe(35);
    expect(loaded.rememberPerTitleTrackChoices).toBe(false);
    expect(loaded.iosHlsPlaybackMode).toBe("compatibility");
    expect(loaded.debridTokens).toEqual([{ service: "real_debrid", apiToken: "rd-tok" }]);
    expect(loaded.sources).toEqual([
      {
        id: "src1",
        type: "jackett",
        baseURL: "http://j",
        apiKey: "ak",
        isActive: true,
        displayName: "J",
        priority: 0,
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Desktop keychain "fail-closed" paths. On the Tauri build, getSecretStore()
  // returns a KeychainSecretStore whose set/deleteSecret REJECT when the OS
  // keychain is locked/denied. saveSettingsToStore must not let that abort the
  // reconciliation mid-flight (which would orphan a config row / KV marker and
  // lose the rest of the Save). We simulate it by rejecting the fake secrets.
  // ---------------------------------------------------------------------------
  describe("keychain fail-closed (desktop)", () => {
    afterEach(() => {
      // Restore the base in-memory secret-store behavior (clearAllMocks keeps
      // implementations, so a persistent override here would leak otherwise).
      fakeSecrets.getSecret.mockImplementation(
        async (key: string) => secretMap.get(key) ?? null,
      );
      fakeSecrets.setSecret.mockImplementation(
        async (key: string, value: string) => {
          secretMap.set(key, value);
        },
      );
      fakeSecrets.deleteSecret.mockImplementation(async (key: string) => {
        secretMap.delete(key);
      });
    });

    it("removes a stale debrid config (and continues the save) even when the keychain secret delete fails closed", async () => {
      // Stale debrid config to be removed; its keychain purge will fail.
      debridConfigs = [
        {
          id: "debrid-premiumize",
          service: "premiumize",
          apiToken: "secret:debrid.debrid-premiumize",
          isActive: true,
          priority: 0,
        },
      ];
      secretMap.set("debrid.debrid-premiumize", "old");
      // Stale indexer to prove the post-debrid reconciliation still ran.
      indexerConfigs = [
        {
          id: "stale-idx",
          type: "torznab",
          baseURL: "http://old",
          apiKey: null,
          isActive: true,
          displayName: null,
          providerSubtype: "custom_torznab",
          endpointPath: "/api",
          categoryFilter: null,
          priority: 0,
        },
      ];
      fakeSecrets.deleteSecret.mockRejectedValueOnce(new Error("keychain locked"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Removal (no tokens) must NOT throw - the purge is best-effort.
      await expect(
        saveSettingsToStore(
          settingsWith({
            debridTokens: [],
            sources: [
              { id: "fresh-idx", type: "torznab", baseURL: "http://new", isActive: true },
            ],
          }),
        ),
      ).resolves.toBeUndefined();

      // The config ROW was deleted despite the keychain failure (intent honored,
      // no orphaned row whose marker would re-surface the service on next load).
      expect(debridConfigs.map((c) => c.id)).not.toContain("debrid-premiumize");
      // Reconciliation CONTINUED past the failure: indexer table fully updated.
      const idxIds = indexerConfigs.map((c) => c.id);
      expect(idxIds).toContain("fresh-idx");
      expect(idxIds).not.toContain("stale-idx");
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("clears a secret KV marker and completes the save when emptying a key whose keychain delete fails closed", async () => {
      // A previously-set OMDb key (marker + value) now being cleared.
      settingsMap.set("omdb_api_key", "secret:omdb_api_key");
      secretMap.set("omdb_api_key", "old-omdb");
      fakeSecrets.deleteSecret.mockRejectedValueOnce(new Error("keychain locked"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        saveSettingsToStore(settingsWith({ omdbKey: "" })),
      ).resolves.toBeUndefined();

      // Marker cleared first → value is unreferenced on next load even though the
      // keychain purge failed; the rest of the KV writes still landed.
      expect(settingsMap.has("omdb_api_key")).toBe(false);
      expect(settingsMap.get("ai_provider")).toBe("anthropic");
      warn.mockRestore();
    });

    it("surfaces a keychain WRITE failure but still persists everything else (no half-reconciled tables)", async () => {
      // The real_debrid token write fails closed; all other secrets succeed.
      fakeSecrets.setSecret.mockImplementation(
        async (key: string, value: string) => {
          if (key === "debrid.debrid-real_debrid") {
            throw new Error("keychain locked");
          }
          secretMap.set(key, value);
        },
      );
      indexerConfigs = [
        {
          id: "stale-idx",
          type: "torznab",
          baseURL: "http://old",
          apiKey: null,
          isActive: true,
          displayName: null,
          providerSubtype: "custom_torznab",
          endpointPath: "/api",
          categoryFilter: null,
          priority: 0,
        },
      ];

      const err = await saveSettingsToStore(
        settingsWith({
          aiProvider: "openai",
          aiModel: "gpt-4o",
          debridTokens: [{ service: "real_debrid", apiToken: "rd" }],
          sources: [
            { id: "fresh-idx", type: "torznab", baseURL: "http://new", isActive: true },
          ],
        }),
      ).then(
        () => null,
        (e) => e as AggregateError,
      );

      // The failure is surfaced (the user must know their key wasn't saved)...
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(1);
      // ...but no marker'd row was written pointing at the secret we couldn't store.
      expect(debridConfigs.find((c) => c.id === "debrid-real_debrid")).toBeUndefined();
      expect(secretMap.has("debrid.debrid-real_debrid")).toBe(false);
      // Everything else persisted: unrelated KV settings + full indexer reconcile.
      expect(settingsMap.get("ai_provider")).toBe("openai");
      expect(settingsMap.get("ai_model")).toBe("gpt-4o");
      const idxIds = indexerConfigs.map((c) => c.id);
      expect(idxIds).toContain("fresh-idx");
      expect(idxIds).not.toContain("stale-idx");
    });
  });
});

// =============================================================================
// Nav customization: normalizers + full persistence round-trip (both paths)
// =============================================================================

describe("normalizeAppearanceNavOrder / normalizeAppearanceNavHidden", () => {
  it("defaults to an empty array for missing / non-array values", () => {
    expect(normalizeAppearanceNavOrder(undefined)).toEqual([]);
    expect(normalizeAppearanceNavOrder(null)).toEqual([]);
    expect(normalizeAppearanceNavOrder(42)).toEqual([]);
    expect(normalizeAppearanceNavHidden(undefined)).toEqual([]);
  });

  it("accepts a real array and keeps only known screen ids, de-duplicated", () => {
    expect(
      normalizeAppearanceNavOrder([
        "history",
        "bogus",
        "history",
        "library",
        7,
      ]),
    ).toEqual(["history", "library"]);
  });

  it("parses a JSON-string payload (the KV-store encoding)", () => {
    expect(normalizeAppearanceNavOrder('["search","discover"]')).toEqual([
      "search",
      "discover",
    ]);
    expect(normalizeAppearanceNavOrder("not json")).toEqual([]);
  });

  it("never lets 'settings' into the hidden list", () => {
    expect(
      normalizeAppearanceNavHidden(["calendar", "settings", "history"]),
    ).toEqual(["calendar", "history"]);
  });
});

describe("nav customization persistence round-trip", () => {
  it("round-trips order + hidden through the localStorage blob", () => {
    stubLocalStorage({
      [KEY]: JSON.stringify({
        appearanceNavOrder: ["history", "library", "settings", "bogus"],
        appearanceNavHidden: ["calendar", "settings"],
      }),
    });
    const s = loadSettings();
    expect(s.appearanceNavOrder).toEqual(["history", "library", "settings"]);
    expect(s.appearanceNavHidden).toEqual(["calendar"]); // settings stripped
  });

  it("defaults to empty arrays when the blob omits them", () => {
    stubLocalStorage({ [KEY]: JSON.stringify({ tmdbKey: "x" }) });
    const s = loadSettings();
    expect(s.appearanceNavOrder).toEqual([]);
    expect(s.appearanceNavHidden).toEqual([]);
  });

  it("round-trips order + hidden through the Store (JSON-encoded KV values)", async () => {
    settingsMap.set("storage_port_initialized", "true");
    await saveSettingsToStore({
      ...defaultSettings(),
      appearanceNavOrder: ["history", "library"],
      appearanceNavHidden: ["calendar"],
    });
    // Stored as JSON strings under the KV keys.
    expect(settingsMap.get("appearance_nav_order")).toBe(
      JSON.stringify(["history", "library"]),
    );
    expect(settingsMap.get("appearance_nav_hidden")).toBe(
      JSON.stringify(["calendar"]),
    );
    const loaded = await loadSettingsFromStore();
    expect(loaded.appearanceNavOrder).toEqual(["history", "library"]);
    expect(loaded.appearanceNavHidden).toEqual(["calendar"]);
  });
});
