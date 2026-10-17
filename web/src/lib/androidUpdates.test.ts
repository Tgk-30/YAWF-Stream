import { afterEach, expect, it, vi } from "vitest";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { checkAndroidAppUpdates, hasLocalAndroidUpdater } from "./androidUpdates";
afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });
function native(href: string) { vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __YAWF_TAURI_ANDROID__: true, location: { href } }); }
it("opens only a no-argument native dialog from the bundled Android origin", async () => {
 native("http://tauri.localhost/"); expect(hasLocalAndroidUpdater()).toBe(true);
 await checkAndroidAppUpdates(); expect(invoke.mock.calls).toEqual([["mobile_check_android_updates"]]);
});
it.each(["https://server.example/", "http://127.0.0.1:43110/", "https://tauri.localhost.example/", "http://tauri.localhost:43110/", "http://user:pass@tauri.localhost/"])("does not offer the ACL-denied action to hosted page %s", async (href) => {
 native(href); expect(hasLocalAndroidUpdater()).toBe(false);
 await expect(checkAndroidAppUpdates()).rejects.toThrow("standalone mode"); expect(invoke).not.toHaveBeenCalled();
});
it("requires native Android identity even at a matching browser URL", () => {
 vi.stubGlobal("window", { location: { href: "http://tauri.localhost/" } });
 expect(hasLocalAndroidUpdater()).toBe(false);
});
