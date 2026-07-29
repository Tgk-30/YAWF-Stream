// storage/index - getStore() / getSecretStore() backend selection.
//
// index.ts holds process-wide singletons, so each test resets the module
// registry (vi.resetModules) and re-imports a fresh copy after configuring the
// isTauri() / configuredServerURL() mocks. The concrete store classes are
// mocked to lightweight tagged stand-ins so this test exercises ONLY the
// selection logic (Local vs Server, browser vs Tauri-keychain) without pulling
// in Dexie/IndexedDB or fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable mock state the per-test modules read through the mocked modules below.
let serverURL: string | null = null;
let tauri = false;
const dexieStates = {
  instances: [] as Array<{
    name: string;
    close: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    getSecret: ReturnType<typeof vi.fn>;
    setSecret: ReturnType<typeof vi.fn>;
    deleteSecret: ReturnType<typeof vi.fn>;
  }>,
  reset() {
    this.instances.length = 0;
  },
  latest() {
    return this.instances[this.instances.length - 1];
  },
};

vi.mock("../lib/serverMode", () => ({
  configuredServerURL: () => serverURL,
}));

vi.mock("../lib/tauri", () => ({
  isTauri: () => tauri,
}));

vi.mock("./DexieStore", () => ({
  DexieStore: class {
    readonly kind = "dexie";
    readonly name: string;
    close: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    getSecret: ReturnType<typeof vi.fn>;
    setSecret: ReturnType<typeof vi.fn>;
    deleteSecret: ReturnType<typeof vi.fn>;
    // Mirror the real signature: default arg is the legacy "debridstreamer" DB.
    constructor(name = "debridstreamer") {
      this.name = name;
      this.close = vi.fn(async () => undefined);
      this.open = vi.fn(async () => this);
      this.getSecret = vi.fn(async () => `secret:${name}`);
      this.setSecret = vi.fn(async () => undefined);
      this.deleteSecret = vi.fn(async () => undefined);
      dexieStates.instances.push(this);
    }
  },
  __dexieStates: dexieStates,
}));

vi.mock("./RemoteStore", () => ({
  RemoteStore: class {
    readonly kind = "remote";
    constructor(public readonly baseURL: string) {}
  },
}));

vi.mock("./keychainMigration", () => ({
  migrateKeychainSecretsOnce: async () => {},
}));

async function freshIndex() {
  vi.resetModules();
  return import("./index");
}

beforeEach(() => {
  serverURL = null;
  tauri = false;
});

afterEach(() => {
  vi.clearAllMocks();
  dexieStates.reset();
});

describe("getStore()", () => {
  it("returns a DexieStore in plain Local Mode (no server URL)", async () => {
    const mod = await freshIndex();
    const store = mod.getStore() as unknown as { kind: string };
    expect(store.kind).toBe("dexie");
  });

  it("returns a RemoteStore wired to the configured server URL in Server Mode", async () => {
    serverURL = "http://my-server:8080";
    const mod = await freshIndex();
    const store = mod.getStore() as unknown as { kind: string; baseURL: string };
    expect(store.kind).toBe("remote");
    expect(store.baseURL).toBe("http://my-server:8080");
  });

  it("memoizes the singleton across calls", async () => {
    const mod = await freshIndex();
    expect(mod.getStore()).toBe(mod.getStore());
  });

  it("uses the same Dexie singleton in Tauri Local Mode (IndexedDB works in the webview)", async () => {
    tauri = true;
    const mod = await freshIndex();
    expect((mod.getStore() as unknown as { kind: string }).kind).toBe("dexie");
  });
});

describe("getSecretStore()", () => {
  it("returns a plain DexieStore in a browser (no Tauri, no server)", async () => {
    const mod = await freshIndex();
    const secret = mod.getSecretStore() as unknown as { kind: string };
    expect(secret.kind).toBe("dexie");
  });

  it("uses a migration-gated LOCAL store under Tauri (no OS keychain)", async () => {
    tauri = true;
    const mod = await freshIndex();
    const secret = mod.getSecretStore() as unknown as { dexie: { kind: string } };
    // Desktop secrets live in the same Dexie store as the browser build; the
    // wrapper only gates operations on the one-time keychain->local migration.
    expect(secret.dexie.kind).toBe("dexie");
  });

  it("returns the RemoteStore itself as the SecretStore in Server Mode (write-only)", async () => {
    serverURL = "http://srv";
    const mod = await freshIndex();
    const secret = mod.getSecretStore() as unknown as { kind: string };
    // Same instance as the store - RemoteStore implements both interfaces.
    expect(secret).toBe(mod.getStore());
    expect(secret.kind).toBe("remote");
  });

  it("Server Mode takes precedence over Tauri for the secret backend (no keychain)", async () => {
    serverURL = "http://srv";
    tauri = true;
    const mod = await freshIndex();
    expect((mod.getSecretStore() as unknown as { kind: string }).kind).toBe("remote");
  });

  it("memoizes the secret singleton across calls", async () => {
    tauri = true;
    const mod = await freshIndex();
    expect(mod.getSecretStore()).toBe(mod.getSecretStore());
  });

  it("shares one underlying Dexie instance between the store and the secret store", async () => {
    tauri = true;
    const mod = await freshIndex();
    const store = mod.getStore();
    const secret = mod.getSecretStore() as unknown as { dexie: unknown };
    // getSecretStore's backing Dexie is the very same instance getStore() returns.
    expect(secret.dexie).toBe(store);
  });

  it("does NOT keychain-migrate a non-default profile database under Tauri", async () => {
    tauri = true;
    const mod = await freshIndex();
    await mod.swapLocalProfileStore("debridstreamer_p_abc");
    // A non-default profile DB must return the RAW Dexie secret store (kind
    // "dexie"), never the keychain-migrating wrapper (which has no `kind`), so
    // it can never re-read the OS keychain and absorb the owner's secrets.
    const secret = mod.getSecretStore() as unknown as { kind?: string };
    expect(secret.kind).toBe("dexie");
    // The default DB, by contrast, IS wrapped (no `kind` on the wrapper).
    await mod.swapLocalProfileStore("debridstreamer");
    expect((mod.getSecretStore() as unknown as { kind?: string }).kind).toBeUndefined();
  });

  it("runs the keychain migration gate before local secret access in default profile", async () => {
    tauri = true;
    const mod = await freshIndex();
    const secretStore = mod.getSecretStore();

    await secretStore.getSecret("api-token");

    const state = (await import("./DexieStore")) as unknown as {
      __dexieStates: typeof dexieStates;
    };
    expect(state.__dexieStates.latest()?.getSecret).toHaveBeenCalledTimes(1);
    expect(secretStore).not.toBe(mod.getStore());
  });

  it("forwards setSecret and deleteSecret through the migration wrapper", async () => {
    tauri = true;
    const mod = await freshIndex();
    const secretStore = mod.getSecretStore();

    await secretStore.setSecret("api-token", "token-value");
    await secretStore.deleteSecret("api-token");

    const state = (await import("./DexieStore")) as unknown as {
      __dexieStates: typeof dexieStates;
    };
    expect(state.__dexieStates.latest()?.setSecret).toHaveBeenCalledWith("api-token", "token-value");
    expect(state.__dexieStates.latest()?.deleteSecret).toHaveBeenCalledWith("api-token");
  });
});

describe("__setStoreForTesting()", () => {
  it("replaces the store singleton and resets the secret-store cache", async () => {
    const mod = await freshIndex();
    // Prime both singletons (browser → Dexie for both).
    const original = mod.getStore();
    mod.getSecretStore();

    const injected = { kind: "injected" } as never;
    mod.__setStoreForTesting(injected);

    // getStore now returns the injected instance.
    expect(mod.getStore()).toBe(injected);
    expect(mod.getStore()).not.toBe(original);

    // The secret cache was cleared, so a fresh selection runs; in a plain browser
    // it re-selects the (newly injected) Dexie singleton.
    expect(mod.getSecretStore()).toBe(injected);
  });

  it("clearing to null forces getStore() to build a fresh Dexie store", async () => {
    const mod = await freshIndex();
    mod.__setStoreForTesting(null);
    expect((mod.getStore() as unknown as { kind: string }).kind).toBe("dexie");
  });
});

describe("lifecycle helpers", () => {
  it("closes active local store and clears caches", async () => {
    const mod = await freshIndex();
    await mod.getStore();
    const preCloseStore = mod.getStore();
    const preCloseSecret = mod.getSecretStore();

    await mod.closeActiveLocalStore();

    expect(dexieStates.latest()?.close).toHaveBeenCalledTimes(1);
    expect(mod.currentDexieDbName()).toBeNull();
    const postCloseStore = mod.getStore();
    const postCloseSecret = mod.getSecretStore();
    expect(postCloseStore).not.toBe(preCloseStore);
    expect(postCloseSecret).toBe(postCloseStore);
    expect(preCloseSecret).toBe(preCloseStore);
  });

  it("swaps local profile stores and throws in server mode", async () => {
    const mod = await freshIndex();
    const secret = (await import("./DexieStore")) as unknown as {
      __dexieStates: typeof dexieStates;
    };
    const dexieState = secret.__dexieStates;

    await mod.swapLocalProfileStore("debridstreamer_profile_1");
    const first = mod.getStore();
    const firstDexie = dexieState.latest();
    expect(first).toBe(firstDexie);
    await mod.swapLocalProfileStore("debridstreamer_profile_1");
    expect(firstDexie?.close).not.toHaveBeenCalled();

    await mod.swapLocalProfileStore("debridstreamer_profile_2");
    expect(firstDexie?.close).toHaveBeenCalledTimes(1);

    serverURL = "http://srv";
    await expect(mod.swapLocalProfileStore("fallback")).rejects.toThrow(
      "Local profile switching is unavailable in Server Mode",
    );
  });
});
