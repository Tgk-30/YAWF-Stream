// One-time keychain->local migration: move semantics (lift + delete), one-shot
// flag (never re-prompts), denied-key skip (user re-enters, no retry loop), and
// the mobile case where the commands do not exist at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { migrateKeychainSecretsOnce } from "./keychainMigration";
import type { DexieStore } from "./DexieStore";

function fakeDexie() {
  const settings = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    settings,
    secrets,
    store: {
      getSetting: async (k: string) => settings.get(k) ?? null,
      setSetting: async (k: string, v: string) => void settings.set(k, v),
      setSecret: async (k: string, v: string) => void secrets.set(k, v),
    } as unknown as DexieStore,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("migrateKeychainSecretsOnce", () => {
  it("moves every keychain value into the local store and deletes the original", async () => {
    const { store, secrets } = fakeDexie();
    invoke.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === "keychain_get") {
        return args.key === "tmdb_api_key" ? "tmdb-secret" : null;
      }
      return undefined; // keychain_delete
    });

    await migrateKeychainSecretsOnce(store);

    expect(secrets.get("tmdb_api_key")).toBe("tmdb-secret");
    // Move, not copy: the keychain original was deleted.
    expect(invoke).toHaveBeenCalledWith(
      "keychain_delete",
      expect.objectContaining({ key: "tmdb_api_key" }),
    );
  });

  it("runs exactly once: the flag blocks any later keychain access (no re-prompts)", async () => {
    const { store } = fakeDexie();
    invoke.mockResolvedValue(null);

    await migrateKeychainSecretsOnce(store);
    const callsAfterFirstRun = invoke.mock.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0);

    await migrateKeychainSecretsOnce(store);
    // Not a single additional keychain call - the OS can never prompt again.
    expect(invoke.mock.calls.length).toBe(callsAfterFirstRun);
  });

  // Android compiles keychain.rs out entirely (cfg(desktop) in lib.rs, and the
  // keyring crate has no Android backend), so every keychain_* invoke rejects
  // with an unknown-command error. That must degrade to the same local model the
  // browser build already uses, not strand the user with no secret storage.
  it("burns the flag when the commands do not exist at all, as on Android", async () => {
    const { store, settings, secrets } = fakeDexie();
    invoke.mockRejectedValue(new Error("Command keychain_get not found"));

    await migrateKeychainSecretsOnce(store);

    expect(settings.get("keychain_migrated_to_local_v1")).toBe("true");
    expect(secrets.size).toBe(0);
  });

  it("does not retry the absent commands on a later launch", async () => {
    const { store } = fakeDexie();
    invoke.mockRejectedValue(new Error("Command keychain_get not found"));

    await migrateKeychainSecretsOnce(store);
    const firstRunCalls = invoke.mock.calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);

    invoke.mockClear();
    await migrateKeychainSecretsOnce(store);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("skips a denied/cancelled key but still migrates the rest and burns the flag", async () => {
    const { store, secrets, settings } = fakeDexie();
    invoke.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd !== "keychain_get") return undefined;
      if (args.key === "tmdb_api_key") throw new Error("user cancelled");
      if (args.key === "debrid.debrid-torbox") return "tb-token";
      return null;
    });

    await migrateKeychainSecretsOnce(store);

    expect(secrets.has("tmdb_api_key")).toBe(false);
    expect(secrets.get("debrid.debrid-torbox")).toBe("tb-token");
    // The flag is burned even after a denial - never retry, never re-prompt.
    expect(settings.get("keychain_migrated_to_local_v1")).toBe("true");
  });
});
