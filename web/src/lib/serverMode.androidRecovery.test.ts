import { afterEach, beforeEach, expect, it, vi } from "vitest";

const URL_KEY = "debridstreamer.server.url";
const FOLLOW_KEY = "debridstreamer.server.follow";
const ENTRY = "http://tauri.localhost/#yawf-local-mode";

function storage() {
  const values = new Map<string, string>([
    [URL_KEY, "https://saved.example"],
    [FOLLOW_KEY, "1"],
    ["ds.profile.active", "family"],
    ["unrelated.preference", "keep"],
  ]);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}
function page(href = ENTRY, android = true, tauri = true) {
  const history = { state: { existing: "history" }, replaceState: vi.fn() };
  vi.stubGlobal("window", {
    location: { href },
    history,
    __YAWF_TAURI_ANDROID__: android,
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
  });
  return history;
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("__DEBRIDSTREAMER_SERVER_URL__", undefined);
  vi.stubGlobal("__DEBRIDSTREAMER_SERVER_MODE_ENV__", undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("consumes the fixed native marker before following and preserves bookmark and unrelated data", async () => {
  const saved = storage(); vi.stubGlobal("localStorage", saved);
  const history = page();
  const mode = await import("./serverMode");
  expect(mode.followServerURL()).toBe("https://saved.example");
  expect(mode.consumeAndroidLocalModeEntry()).toBe(true);
  expect(mode.followServerURL()).toBeNull();
  expect(mode.configuredServerURL()).toBeNull();
  expect(mode.configuredServerURLSource()).toBeNull();
  expect(mode.isServerMode()).toBe(false);
  expect(saved.values).toEqual(new Map([
    [URL_KEY, "https://saved.example"], [FOLLOW_KEY, "local"],
    ["ds.profile.active", "family"], ["unrelated.preference", "keep"],
  ]));
  expect(saved.removeItem).not.toHaveBeenCalled();
  expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/");
});

it("keeps both saved API and follow disabled after a cold module restart without a marker", async () => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); page();
  (await import("./serverMode")).consumeAndroidLocalModeEntry();
  vi.resetModules(); page("http://tauri.localhost/");
  const cold = await import("./serverMode");
  expect(cold.consumeAndroidLocalModeEntry()).toBe(false);
  expect(cold.configuredServerURL()).toBeNull();
  expect(cold.configuredServerURLSource()).toBeNull();
  expect(cold.followServerURL()).toBeNull();
  expect(saved.values.get(URL_KEY)).toBe("https://saved.example");
});

it("deliberate API reconnect retires Local Mode without reviving the old follow intent", async () => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); page();
  const mode = await import("./serverMode"); mode.consumeAndroidLocalModeEntry();
  mode.saveServerURL("https://reconnected.example/");
  expect(mode.configuredServerURL()).toBe("https://reconnected.example");
  expect(mode.configuredServerURLSource()).toBe("saved");
  expect(mode.followServerURL()).toBeNull();
  expect(saved.values.has(FOLLOW_KEY)).toBe(false);
});

it("deliberate follow reconnect can persist a new server navigation across restart", async () => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); page();
  const mode = await import("./serverMode"); mode.consumeAndroidLocalModeEntry();
  mode.saveServerURL("https://new.example/", { follow: true });
  expect(mode.followServerURL()).toBe("https://new.example");
  vi.resetModules(); page("http://tauri.localhost/");
  const cold = await import("./serverMode");
  expect(cold.configuredServerURL()).toBe("https://new.example");
  expect(cold.followServerURL()).toBe("https://new.example");
});

it("never overrides explicit environment or injected same-origin API configuration", async () => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); page();
  const mode = await import("./serverMode"); mode.consumeAndroidLocalModeEntry();
  vi.stubGlobal("__DEBRIDSTREAMER_SERVER_MODE_ENV__", { VITE_DEBRIDSTREAMER_SERVER_URL: "https://managed.example/" });
  expect(mode.configuredServerURL()).toBe("https://managed.example");
  expect(mode.configuredServerURLSource()).toBe("env");
  vi.stubGlobal("__DEBRIDSTREAMER_SERVER_MODE_ENV__", undefined);
  vi.stubGlobal("__DEBRIDSTREAMER_SERVER_URL__", "/");
  expect(mode.configuredServerURL()).toBe("");
  expect(mode.configuredServerURLSource()).toBe("same-origin");
  expect(saved.values.get(URL_KEY)).toBe("https://saved.example");
});

it.each([
  "https://tauri.localhost/#yawf-local-mode",
  "tauri://localhost/#yawf-local-mode",
  "http://tauri.localhost:8080/#yawf-local-mode",
  "http://tauri.localhost.example/#yawf-local-mode",
  "http://user:pass@tauri.localhost/#yawf-local-mode",
  "https://server.example/#yawf-local-mode",
  "http://127.0.0.1:43136/#yawf-local-mode",
  "http://tauri.localhost/path#yawf-local-mode",
  "http://tauri.localhost/?target=https://server.example#yawf-local-mode",
  "http://tauri.localhost/#yawf-local-mode&target=https://server.example",
  "http://tauri.localhost/#%79awf-local-mode",
])("rejects a marker outside the exact bundled entry: %s", async (href) => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); const history = page(href);
  const mode = await import("./serverMode");
  expect(mode.consumeAndroidLocalModeEntry()).toBe(false);
  expect(saved.setItem).not.toHaveBeenCalled();
  expect(history.replaceState).not.toHaveBeenCalled();
  expect(mode.configuredServerURL()).toBe("https://saved.example");
});

it.each([[false, true], [true, false]])("requires Android and genuine local Tauri runtime markers (%s/%s)", async (android, tauri) => {
  const saved = storage(); vi.stubGlobal("localStorage", saved); page(ENTRY, android, tauri);
  const mode = await import("./serverMode");
  expect(mode.consumeAndroidLocalModeEntry()).toBe(false);
  expect(saved.setItem).not.toHaveBeenCalled();
  expect(mode.configuredServerURL()).toBe("https://saved.example");
});

it("does not apply a persisted local sentinel to hosted pages or non-Android contexts", async () => {
  const saved = storage(); saved.values.set(FOLLOW_KEY, "local"); vi.stubGlobal("localStorage", saved);
  page("https://hosted.example/", true, true);
  const mode = await import("./serverMode");
  expect(mode.configuredServerURL()).toBe("https://saved.example");
  page("http://tauri.localhost/", false, true);
  expect(mode.configuredServerURL()).toBe("https://saved.example");
});

it("stays local for the current document if persistence or marker cleanup fails", async () => {
  const saved = storage(); saved.setItem.mockImplementation(() => { throw new Error("unavailable"); });
  vi.stubGlobal("localStorage", saved); const history = page();
  history.replaceState.mockImplementation(() => { throw new Error("unavailable"); });
  const mode = await import("./serverMode");
  expect(mode.consumeAndroidLocalModeEntry()).toBe(true);
  expect(mode.configuredServerURL()).toBeNull();
  expect(mode.followServerURL()).toBeNull();
  expect(saved.values.get(URL_KEY)).toBe("https://saved.example");
});
