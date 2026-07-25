import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, databaseLockPath, migrateDatabase } from "../src/db.js";
import {
  createLegacyServerFixture,
  LEGACY_SERVER_FIXTURES,
  migrationHashes,
  RELEASED_MIGRATION_HASHES,
} from "./fixtures/migrationFixtures.js";

describe("AppDatabase", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses NORMAL synchronous mode for WAL databases", () => {
    const db = new AppDatabase(temporaryDatabasePath(tempDirs));
    try {
      expect((db.sqlite.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
    } finally {
      db.close();
    }
  });

  it("releases its lock only once and never removes a replacement lock", () => {
    const path = temporaryDatabasePath(tempDirs);
    const db = new AppDatabase(path);
    const lockPath = databaseLockPath(path);
    expect(existsSync(lockPath)).toBe(true);
    db.close();
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, "999999\n", { mode: 0o600 });
    db.close();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("removes expired audit records while retaining recent records", () => {
    const db = new AppDatabase(temporaryDatabasePath(tempDirs));
    try {
      const insert = db.sqlite.prepare(
        `INSERT INTO audit_log
         (id, actor_user_id, actor_profile_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?, NULL, NULL, 'test', NULL, NULL, NULL, ?)`,
      );
      insert.run("old", "2000-01-01T00:00:00.000Z");
      insert.run("recent", new Date().toISOString());

      db.pruneAuditLog();

      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id = 'old'").get() as {
          count: number;
        }).count,
      ).toBe(0);
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id = 'recent'").get() as {
          count: number;
        }).count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps every released migration immutable", () => {
    expect(migrationHashes()).toEqual(RELEASED_MIGRATION_HASHES);
  });

  for (const fixture of LEGACY_SERVER_FIXTURES) {
    it(`upgrades the ${fixture.name} fixture without losing data`, { timeout: 30_000 }, () => {
      const path = temporaryDatabasePath(tempDirs);
      createLegacyServerFixture(path, fixture.version);

      const db = new AppDatabase(path);
      try {
        const snapshots = readdirSync(join(path, "..", "backups"));
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatch(
          new RegExp(`^pre-upgrade-v${fixture.version}-to-v10-.*\\.sqlite$`),
        );
        const versions = db.sqlite
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>;
        expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(
          db.sqlite.prepare("SELECT value FROM profile_settings WHERE key = 'ui_theme'").get(),
        ).toEqual({ value: "midnight" });
        expect(
          db.sqlite.prepare("SELECT encrypted_value FROM credential_secrets WHERE id = 'credential-fixture'").get(),
        ).toEqual({ encrypted_value: "v1:fixture:encrypted:value" });
        expect(
          db.sqlite.prepare("SELECT preview_json FROM watchlist WHERE media_id = 'tt-fixture'").get(),
        ).toEqual({ preview_json: '{"id":"tt-fixture","title":"Fixture Film"}' });
        expect(
          db.sqlite.prepare("SELECT progress_seconds FROM watch_history WHERE media_id = 'series-fixture'").get(),
        ).toEqual({ progress_seconds: 420 });
        expect(
          db.sqlite.prepare("SELECT folder_id FROM user_library WHERE id = 'library-fixture'").get(),
        ).toEqual({ folder_id: "folder-fixture" });
        expect(
          db.sqlite.prepare("SELECT is_kid, maturity_max FROM profiles WHERE id = 'profile-fixture'").get(),
        ).toEqual({ is_kid: 0, maturity_max: null });
        expect(
          db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata_cache'").get(),
        ).toEqual({ name: "metadata_cache" });
        expect(
          db.sqlite.prepare("SELECT totp_enabled FROM users WHERE id = 'user-fixture'").get(),
        ).toEqual({ totp_enabled: 0 });
      } finally {
        db.close();
      }

      const reopened = new AppDatabase(path);
      try {
        expect(readdirSync(join(path, "..", "backups"))).toHaveLength(1);
        expect(
          reopened.sqlite.prepare("SELECT COUNT(*) AS count FROM watchlist WHERE media_id = 'tt-fixture'").get(),
        ).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    });
  }

  it("rolls back a migration and its marker when a schema change fails", { timeout: 30_000 }, () => {
    const path = temporaryDatabasePath(tempDirs);
    createLegacyServerFixture(path, 1);
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.exec("ALTER TABLE stream_sessions ADD COLUMN last_accessed_at TEXT;");
      expect(() => migrateDatabase(sqlite)).toThrow("Database migration 2 failed.");
      const columns = sqlite.prepare("PRAGMA table_info(stream_sessions)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "bytes_served")).toBe(false);
      expect(
        sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("refuses to open a database created by a newer app", { timeout: 30_000 }, () => {
    const path = temporaryDatabasePath(tempDirs);
    createLegacyServerFixture(path, 7);
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)")
        .run("2035-01-01T00:00:00.000Z");
      expect(() => migrateDatabase(sqlite)).toThrow(
        "Database schema version 99 is newer than supported version 10.",
      );
    } finally {
      sqlite.close();
    }
  });
});

function temporaryDatabasePath(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "debridstreamer-db-test-"));
  tempDirs.push(dir);
  return join(dir, "database.sqlite");
}
