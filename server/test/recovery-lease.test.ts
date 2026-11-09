import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "../src/crypto";
import { AppDatabase, DatabaseLeaseBusyError } from "../src/db";
import {
  createDatabaseBackup,
  resetOwnerPassword,
  restoreDatabaseBackup,
} from "../src/recovery";

const directories: string[] = [];
const NATIVE_RECOVERY_TEST_MS = process.platform === "win32" ? 30_000 : undefined;
const CLEANUP_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;
const pending = new Set<Promise<unknown>>();
const cleanupActions = new Set<() => void>();
const backgroundErrors: unknown[] = [];

function tracked<T>(operation: Promise<T>, expectedRejection = false): Promise<T> {
  pending.add(operation);
  void operation.then(() => pending.delete(operation), (error: unknown) => {
    pending.delete(operation);
    if (!expectedRejection) backgroundErrors.push(error);
  });
  return operation;
}

function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    void operation.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => {
      clearTimeout(timer); reject(error);
    });
  });
}

function hashPhase(entered: Promise<void>, recovery: Promise<unknown>): Promise<void> {
  return bounded(Promise.race([
    entered,
    recovery.then(() => { throw new Error("Recovery completed before the controlled hash phase."); }),
  ]), CLEANUP_TIMEOUT_MS, "Recovery did not reach its controlled hash phase.");
}

async function drainRecoveryWork(): Promise<void> {
  for (const action of [...cleanupActions]) action();
  cleanupActions.clear();
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (pending.size > 0) {
    await bounded(Promise.allSettled([...pending]), Math.max(1, deadline - Date.now()), "Recovery work did not settle before cleanup.");
  }
  expect(pending.size).toBe(0);
  expect(backgroundErrors.splice(0)).toEqual([]);
}

function seedDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "yawf-recovery-lease-"));
  directories.push(directory);
  const path = join(directory, "server.sqlite");
  const database = new AppDatabase(path);
  try {
    database.sqlite.prepare(
      `INSERT INTO users
         (id, username, display_name, password_hash, role, created_at)
       VALUES ('fixture-owner', 'fixture-owner', 'Fixture owner', 'fixture-old-hash', 'owner', ?)`,
    ).run(new Date().toISOString());
  } finally {
    database.close();
  }
  return path;
}

function expectServerExcluded(path: string): void {
  let unexpectedDatabase: AppDatabase | undefined;
  let observedError: unknown;
  try {
    unexpectedDatabase = new AppDatabase(path);
  } catch (error) {
    observedError = error;
  } finally {
    unexpectedDatabase?.close();
  }
  expect(observedError).toBeInstanceOf(DatabaseLeaseBusyError);
}

function deferred<T>(cleanup?: { value: T } | { error: Error }) {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const action = () => {
    if (cleanup == null) return;
    if ("error" in cleanup) reject(cleanup.error);
    else resolve(cleanup.value);
  };
  if (cleanup != null) cleanupActions.add(action);
  return {
    promise,
    resolve: (value: T) => { cleanupActions.delete(action); resolve(value); },
    reject: (error: Error) => { cleanupActions.delete(action); reject(error); },
  };
}

afterEach(async () => {
  // Settle controlled gates and the entire interrupted test body before mocks
  // or directories disappear underneath asynchronous SQLite recovery work.
  await drainRecoveryWork();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}, CLEANUP_TIMEOUT_MS + 1000);

describe("destructive recovery lease lifetime", () => {
  it("excludes server startup through asynchronous owner recovery while allowing an online backup", () => tracked((async () => {
    const path = seedDatabase();
    const enteredHash = deferred<void>();
    const hash = deferred<string>({ value: "fixture-new-hash" });
    vi.spyOn(crypto, "hashPassword").mockImplementationOnce(() => {
      enteredHash.resolve();
      return hash.promise;
    });

    const recovery = tracked(resetOwnerPassword(path, { password: "fixture-new-password" }));
    try {
      await hashPhase(enteredHash.promise, recovery);
      expectServerExcluded(path);
      const onlineBackup = await tracked(createDatabaseBackup(path, join(dirname(path), "online.sqlite")));
      expect(existsSync(onlineBackup.outputPath)).toBe(true);
      expectServerExcluded(path);
    } finally {
      hash.resolve("fixture-new-hash");
      await recovery;
    }

    const reopened = new AppDatabase(path);
    try {
      expect(reopened.sqlite.prepare("SELECT password_hash FROM users").get())
        .toEqual({ password_hash: "fixture-new-hash" });
    } finally {
      reopened.close();
    }
  })(), true), NATIVE_RECOVERY_TEST_MS);

  it("holds the owner-recovery lease until a hashing failure and then releases it without changing the owner", () => tracked((async () => {
    const path = seedDatabase();
    const enteredHash = deferred<void>();
    const hash = deferred<string>({ error: new Error("fixture hashing refused") });
    vi.spyOn(crypto, "hashPassword").mockImplementationOnce(() => {
      enteredHash.resolve();
      return hash.promise;
    });

    const recovery = tracked(resetOwnerPassword(path, { password: "fixture-new-password" }), true);
    const rejected = expect(recovery).rejects.toThrow("fixture hashing refused");
    try {
      await hashPhase(enteredHash.promise, recovery);
      expectServerExcluded(path);
    } finally {
      hash.reject(new Error("fixture hashing refused"));
      await rejected;
    }

    const reopened = new AppDatabase(path);
    try {
      expect(reopened.sqlite.prepare("SELECT password_hash FROM users").get())
        .toEqual({ password_hash: "fixture-old-hash" });
      expect(reopened.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log").get())
        .toEqual({ count: 0 });
    } finally {
      reopened.close();
    }
  })(), true), NATIVE_RECOVERY_TEST_MS);

  it("holds the restore lease across the asynchronous safety backup and releases it after replacement", () => tracked((async () => {
    const path = seedDatabase();
    const backup = await tracked(createDatabaseBackup(path, join(dirname(path), "restore-input.sqlite")));
    const beforeRestore = new AppDatabase(path);
    try {
      beforeRestore.sqlite.prepare("UPDATE users SET username = 'changed-owner'").run();
    } finally {
      beforeRestore.close();
    }

    const restoring = tracked(restoreDatabaseBackup(path, backup.outputPath));
    try {
      expectServerExcluded(path);
    } finally {
      await restoring;
    }
    const result = await restoring;
    expect(existsSync(result.safetyBackup!)).toBe(true);

    const reopened = new AppDatabase(path);
    try {
      expect(reopened.sqlite.prepare("SELECT username FROM users").get())
        .toEqual({ username: "fixture-owner" });
    } finally {
      reopened.close();
    }
  })(), true), NATIVE_RECOVERY_TEST_MS);

  it("drains an abandoned controlled recovery before removing its directory", async ({ onTestFinished }) => {
    const path = seedDatabase();
    const enteredHash = deferred<void>();
    const hash = deferred<string>({ value: "fixture-drained-hash" });
    vi.spyOn(crypto, "hashPassword").mockImplementationOnce(() => {
      enteredHash.resolve();
      return hash.promise;
    });
    const recovery = tracked(resetOwnerPassword(path, { password: "fixture-new-password" }));
    let verifiedBeforeCleanup = false;
    const verified = tracked(recovery.then(() => {
      expect(vi.isMockFunction(crypto.hashPassword)).toBe(true);
      const reopened = new AppDatabase(path);
      try {
        expect(reopened.sqlite.prepare("SELECT password_hash FROM users").get())
          .toEqual({ password_hash: "fixture-drained-hash" });
        verifiedBeforeCleanup = true;
      } finally {
        reopened.close();
      }
    }));
    onTestFinished(async () => {
      try {
        expect(verifiedBeforeCleanup).toBe(true);
        expect(pending.size).toBe(0);
        expect(cleanupActions.size).toBe(0);
        expect(vi.isMockFunction(crypto.hashPassword)).toBe(false);
        expect(existsSync(dirname(path))).toBe(false);
      } finally {
        // Exact cleanup mutants must still drain their real source operation.
        hash.resolve("fixture-drained-hash");
        await Promise.allSettled([recovery, verified]);
      }
    });
    await hashPhase(enteredHash.promise, recovery);
    expectServerExcluded(path);
    expect(pending.has(recovery)).toBe(true);
    // Leave both actual operations to afterEach; no manual cleanup in the body.
  }, NATIVE_RECOVERY_TEST_MS);

});

for (const mode of ["owner", "restore"] as const) {
  it(`retains ${mode} recovery ownership after a permanent database close failure until process exit`, () => {
    const directory = mkdtempSync(join(tmpdir(), "yawf-recovery-cleanup-"));
    directories.push(directory);
    const path = join(directory, "server.sqlite");
    const fixture = fileURLToPath(new URL("./fixtures/recoveryCleanupFailureChild.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture, path, mode], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("recovery-cleanup-held\n");
    const reopened = new AppDatabase(path);
    reopened.close();
  }, NATIVE_RECOVERY_TEST_MS);
}
