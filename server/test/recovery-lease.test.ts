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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("destructive recovery lease lifetime", () => {
  it("excludes server startup through asynchronous owner recovery while allowing an online backup", async () => {
    const path = seedDatabase();
    const enteredHash = deferred<void>();
    const hash = deferred<string>();
    vi.spyOn(crypto, "hashPassword").mockImplementationOnce(() => {
      enteredHash.resolve();
      return hash.promise;
    });

    const recovery = resetOwnerPassword(path, { password: "fixture-new-password" });
    await enteredHash.promise;
    try {
      expectServerExcluded(path);
      const onlineBackup = await createDatabaseBackup(path, join(dirname(path), "online.sqlite"));
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
  });

  it("holds the owner-recovery lease until a hashing failure and then releases it without changing the owner", async () => {
    const path = seedDatabase();
    const enteredHash = deferred<void>();
    const hash = deferred<string>();
    vi.spyOn(crypto, "hashPassword").mockImplementationOnce(() => {
      enteredHash.resolve();
      return hash.promise;
    });

    const recovery = resetOwnerPassword(path, { password: "fixture-new-password" });
    const rejected = expect(recovery).rejects.toThrow("fixture hashing refused");
    await enteredHash.promise;
    try {
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
  });

  it("holds the restore lease across the asynchronous safety backup and releases it after replacement", async () => {
    const path = seedDatabase();
    const backup = await createDatabaseBackup(path, join(dirname(path), "restore-input.sqlite"));
    const beforeRestore = new AppDatabase(path);
    beforeRestore.sqlite.prepare("UPDATE users SET username = 'changed-owner'").run();
    beforeRestore.close();

    const restoring = restoreDatabaseBackup(path, backup.outputPath);
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
  });
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
  });
}
