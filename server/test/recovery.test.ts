import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/crypto";
import { AppDatabase } from "../src/db";
import {
  configuredDatabasePath,
  createDatabaseBackup,
  resetOwnerPassword,
  restoreDatabaseBackup,
} from "../src/recovery";

describe("local owner recovery", () => {
  const previousScrypt = process.env.DS_SCRYPT_N;
  // Only real multi-boundary filesystem scenarios need the Windows allowance.
  const NATIVE_RECOVERY_TEST_MS = process.platform === "win32" ? 30_000 : undefined;
  const CLEANUP_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;
  const pending = new Set<Promise<unknown>>();

  function trackedTest(run: () => Promise<void>): Promise<void> {
    const operation = run();
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }

  async function drainRecoveryWork(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Recovery test did not settle before environment cleanup.")), CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  beforeEach(() => {
    process.env.DS_SCRYPT_N = "16384";
  });

  afterEach(async () => {
    await drainRecoveryWork();
    if (previousScrypt == null) delete process.env.DS_SCRYPT_N;
    else process.env.DS_SCRYPT_N = previousScrypt;
    delete process.env.DS_SERVER_DB_PATH;
    delete process.env.DS_SERVER_DATA_DIR;
  }, CLEANUP_TIMEOUT_MS + 1000);

  it("resets the only owner, disables TOTP, revokes sessions, and records an audit event", () => trackedTest(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-"));
    const path = join(dir, "server.sqlite");
    const db = new AppDatabase(path);
    try {
      const oldHash = await hashPassword("old-password");
      db.sqlite
        .prepare(
          `INSERT INTO users
             (id, username, display_name, password_hash, role, created_at, totp_secret_encrypted, totp_enabled)
           VALUES ('owner-1', 'Owner', 'Owner', ?, 'owner', '2026-01-01T00:00:00.000Z', 'encrypted', 1)`,
        )
        .run(oldHash);
      db.sqlite
        .prepare(
          `INSERT INTO profiles
             (id, user_id, display_name, simple_mode, is_default, created_at, updated_at)
           VALUES ('profile-1', 'owner-1', 'Owner', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.sqlite
        .prepare(
          `INSERT INTO sessions
             (id, user_id, token_hash, created_at, expires_at)
           VALUES ('session-1', 'owner-1', 'token-hash', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
        )
        .run();
    } finally {
      db.close();
    }

    const result = await resetOwnerPassword(path, {
      password: "new-password",
    });
    expect(result).toEqual({
      username: "Owner",
      sessionsRevoked: 1,
      totpDisabled: true,
    });

    const check = new DatabaseSync(path);
    try {
      const owner = check
        .prepare(
          "SELECT password_hash, totp_secret_encrypted, totp_enabled FROM users WHERE id = 'owner-1'",
        )
        .get() as {
        password_hash: string;
        totp_secret_encrypted: string | null;
        totp_enabled: number;
      };
      await expect(verifyPassword(owner.password_hash, "new-password")).resolves.toBe(
        true,
      );
      expect(owner.totp_secret_encrypted).toBeNull();
      expect(owner.totp_enabled).toBe(0);
      expect(
        (
          check
            .prepare("SELECT revoked_at FROM sessions WHERE id = 'session-1'")
            .get() as { revoked_at: string | null }
        ).revoked_at,
      ).not.toBeNull();
      expect(
        (
          check
            .prepare(
              "SELECT action FROM audit_log WHERE action = 'owner.recovered_local'",
            )
            .get() as { action: string }
        ).action,
      ).toBe("owner.recovered_local");
    } finally {
      check.close();
    }
  }), NATIVE_RECOVERY_TEST_MS);

  it("does not reset an ambiguous owner without an explicit username", () => trackedTest(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-"));
    const path = join(dir, "server.sqlite");
    const db = new AppDatabase(path);
    try {
      const hash = await hashPassword("old-password");
      for (const [id, username] of [
        ["owner-1", "one"],
        ["owner-2", "two"],
      ]) {
        db.sqlite
          .prepare(
            `INSERT INTO users
               (id, username, display_name, password_hash, role, created_at)
             VALUES (?, ?, ?, ?, 'owner', ?)`,
          )
          .run(id, username, username, hash, `2026-01-0${id.at(-1)}T00:00:00.000Z`);
      }
    } finally {
      db.close();
    }

    await expect(
      resetOwnerPassword(path, { password: "new-password" }),
    ).rejects.toThrow("More than one owner exists");
  }), NATIVE_RECOVERY_TEST_MS);

  it("does not create a new database while trying to recover a missing owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-missing-"));
    const path = join(dir, "missing.sqlite");

    await expect(
      resetOwnerPassword(path, { password: "new-password" }),
    ).rejects.toThrow("Database file does not exist");
    expect(existsSync(path)).toBe(false);
  });

  it("resolves the database path without creating server credentials", () => {
    process.env.DS_SERVER_DATA_DIR = "/srv/yawf";
    expect(configuredDatabasePath()).toBe(
      join("/srv/yawf", "debridstreamer.sqlite"),
    );
    process.env.DS_SERVER_DB_PATH = "/data/custom.sqlite";
    expect(configuredDatabasePath()).toBe("/data/custom.sqlite");
  });

  it("creates a verified backup and restores it with a safety copy", () => trackedTest(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-backup-"));
    const path = join(dir, "server.sqlite");
    const backupPath = join(dir, "exports", "known-good.sqlite");
    const db = new AppDatabase(path);
    try {
      db.sqlite
        .prepare(
          `INSERT INTO users
            (id, username, display_name, password_hash, role, created_at)
           VALUES ('owner-backup', 'original-owner', 'Original owner', 'hash', 'owner', ?)`,
        )
        .run(new Date().toISOString());
    } finally {
      db.close();
    }

    const backupResult = await createDatabaseBackup(path, backupPath);
    expect(backupResult.outputPath).toBe(backupPath);
    expect(backupResult.pages).toBeGreaterThan(0);

    const changed = new DatabaseSync(path);
    try {
      changed.prepare("UPDATE users SET username = 'changed-owner'").run();
    } finally {
      changed.close();
    }

    const restored = await restoreDatabaseBackup(path, backupPath);
    expect(restored.safetyBackup).not.toBeNull();
    expect(existsSync(restored.safetyBackup!)).toBe(true);

    const verified = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        (verified.prepare("SELECT username FROM users").get() as { username: string })
          .username,
      ).toBe("original-owner");
    } finally {
      verified.close();
    }
  }), NATIVE_RECOVERY_TEST_MS);

  it("rejects a restore file that is not a YAWF Stream database", () => trackedTest(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-invalid-"));
    const path = join(dir, "server.sqlite");
    const invalid = join(dir, "invalid.sqlite");
    const db = new AppDatabase(path);
    db.close();
    const unrelated = new DatabaseSync(invalid);
    try {
      unrelated.exec("CREATE TABLE unrelated (value TEXT);");
    } finally {
      unrelated.close();
    }

    await expect(restoreDatabaseBackup(path, invalid)).rejects.toThrow(
      "not a YAWF Stream server database",
    );
  }), NATIVE_RECOVERY_TEST_MS);

  it("refuses destructive recovery while the server database is open", () => trackedTest(async () => {
    const dir = mkdtempSync(join(tmpdir(), "yawf-recovery-running-"));
    const path = join(dir, "server.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const db = new AppDatabase(path);
    try {
      await createDatabaseBackup(path, backupPath);
      await expect(
        resetOwnerPassword(path, { password: "new-password" }),
      ).rejects.toThrow("Stop the YAWF Stream server");
      await expect(restoreDatabaseBackup(path, backupPath)).rejects.toThrow(
        "Stop the YAWF Stream server",
      );
    } finally {
      db.close();
    }
  }), NATIVE_RECOVERY_TEST_MS);
});
