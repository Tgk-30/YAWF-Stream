import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDatabaseLease,
  AppDatabase,
  databaseLockPath,
  DatabaseLeaseAccessError,
  DatabaseLeaseBusyError,
  DatabaseLeaseFormatError,
  isDatabaseServerRunning,
  migrateDatabase,
} from "../src/db.js";
import { MIGRATIONS } from "../src/schema.js";
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

  it("holds a persistent exclusive lease and releases it idempotently", () => {
    const path = temporaryDatabasePath(tempDirs);
    const db = new AppDatabase(path);
    const lockPath = databaseLockPath(path);
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(isDatabaseServerRunning(path)).toBe(true);
    expect(() => acquireDatabaseLease(path)).toThrow(DatabaseLeaseBusyError);

    db.close();
    db.close();
    expect(existsSync(lockPath)).toBe(true);
    expect(isDatabaseServerRunning(path)).toBe(false);

    const reopened = new AppDatabase(path);
    reopened.close();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("keeps the lease held until a failed application database close is retried", () => {
    const path = temporaryDatabasePath(tempDirs);
    const db = new AppDatabase(path);
    const originalClose = db.sqlite.close.bind(db.sqlite);
    let failOnce = true;
    db.sqlite.close = () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected application database close failure");
      }
      originalClose();
    };

    try {
      expect(() => db.close()).toThrow("injected application database close failure");
      expect(() => new AppDatabase(path)).toThrow(DatabaseLeaseBusyError);

      db.close();
      const reopened = new AppDatabase(path);
      reopened.close();
    } finally {
      db.sqlite.close = originalClose;
      db.close();
    }
  });

  it("retains a failed lease close handle so release can be retried", () => {
    const path = temporaryDatabasePath(tempDirs);
    const lease = acquireDatabaseLease(path);
    const originalClose = DatabaseSync.prototype.close;
    let failOnce = true;
    let replacement: ReturnType<typeof acquireDatabaseLease> | null = null;
    DatabaseSync.prototype.close = function closeWithInjectedFailure() {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected lease close failure");
      }
      originalClose.call(this);
    };

    try {
      expect(() => lease.close()).toThrow("injected lease close failure");
      expect(() => acquireDatabaseLease(path)).toThrow(DatabaseLeaseBusyError);

      lease.close();
      replacement = acquireDatabaseLease(path);
    } finally {
      DatabaseSync.prototype.close = originalClose;
      replacement?.close();
      lease.close();
    }
  });

  it("does not create a lease file when the compatibility probe finds none", () => {
    const path = temporaryDatabasePath(tempDirs);
    const lockPath = databaseLockPath(path);

    expect(isDatabaseServerRunning(path)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    ["legacy numeric", "1\n"],
    ["malformed", "not a SQLite lease\n"],
  ])("leaves a %s lease untouched and requires offline migration", (_label, contents) => {
    const path = temporaryDatabasePath(tempDirs);
    const lockPath = databaseLockPath(path);
    writeFileSync(lockPath, contents, { mode: 0o600 });
    const before = readFileSync(lockPath);

    expect(() => acquireDatabaseLease(path)).toThrow(DatabaseLeaseFormatError);
    expect(() => isDatabaseServerRunning(path)).toThrow(DatabaseLeaseFormatError);
    expect(readFileSync(lockPath)).toEqual(before);
  });

  it("leaves an unrecognized SQLite lease untouched and reports its format", () => {
    const path = temporaryDatabasePath(tempDirs);
    const lockPath = databaseLockPath(path);
    const unrelated = new DatabaseSync(lockPath);
    unrelated.exec("CREATE TABLE unrelated (value TEXT NOT NULL);");
    unrelated.close();
    const before = readFileSync(lockPath);

    expect(() => acquireDatabaseLease(path)).toThrow(DatabaseLeaseFormatError);
    expect(() => isDatabaseServerRunning(path)).toThrow(DatabaseLeaseFormatError);
    expect(readFileSync(lockPath)).toEqual(before);
  });

  it("distinguishes an inaccessible lease path from a held lease", () => {
    const path = temporaryDatabasePath(tempDirs);
    const lockPath = databaseLockPath(path);
    mkdirSync(lockPath);

    expect(() => acquireDatabaseLease(path)).toThrow(DatabaseLeaseAccessError);
    expect(statSync(lockPath).isDirectory()).toBe(true);
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
    expect(migrationHashes().slice(0, RELEASED_MIGRATION_HASHES.length))
      .toEqual(RELEASED_MIGRATION_HASHES);
    expect(migrationHashes()).toHaveLength(RELEASED_MIGRATION_HASHES.length + 1);
  });

  it("snapshots and upgrades a v11 database with nullable playback preferences", () => {
    const path = temporaryDatabasePath(tempDirs);
    createLegacyServerFixture(path, 7);
    const sqlite = new DatabaseSync(path);
    try {
      for (const [version, sql] of MIGRATIONS) {
        if (version <= 7 || version > 11) continue;
        sqlite.exec(sql);
        sqlite.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(version, `2026-10-${String(version).padStart(2, "0")}T00:00:00.000Z`);
      }
    } finally {
      sqlite.close();
    }

    const db = new AppDatabase(path);
    try {
      const snapshots = readdirSync(join(path, "..", "backups"));
      expect(snapshots).toEqual([
        expect.stringMatching(/^pre-upgrade-v11-to-v12-.*\.sqlite$/),
      ]);
      const snapshotPath = join(path, "..", "backups", snapshots[0]!);
      expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
      const snapshot = new DatabaseSync(snapshotPath);
      try {
        const snapshotColumns = snapshot.prepare("PRAGMA table_info(watch_history)")
          .all() as Array<{ name: string }>;
        expect(snapshotColumns.some((column) => column.name === "preferred_audio_id"))
          .toBe(false);
        expect(
          snapshot.prepare(
            "SELECT progress_seconds FROM watch_history WHERE media_id = 'series-fixture'",
          ).get(),
        ).toEqual({ progress_seconds: 420 });
      } finally {
        snapshot.close();
      }
      expect(
        db.sqlite.prepare(
          `SELECT preferred_audio_id, preferred_audio_lang, preferred_sub_id,
                  playback_speed, subtitle_delay, subtitle_position
           FROM watch_history WHERE media_id = 'series-fixture'`,
        ).get(),
      ).toEqual({
        preferred_audio_id: null,
        preferred_audio_lang: null,
        preferred_sub_id: null,
        playback_speed: null,
        subtitle_delay: null,
        subtitle_position: null,
      });
      expect(
        db.sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 12 });
    } finally {
      db.close();
    }
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
          new RegExp(`^pre-upgrade-v${fixture.version}-to-v12-.*\\.sqlite$`),
        );
        const versions = db.sqlite
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>;
        expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
          db.sqlite.prepare("SELECT source_kind FROM stream_sessions WHERE id = 'stream-fixture'").get(),
        ).toEqual({ source_kind: "http" });
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
        "Database schema version 99 is newer than supported version 12.",
      );
    } finally {
      sqlite.close();
    }
  });

  it("releases the lease when AppDatabase construction fails", { timeout: 30_000 }, () => {
    const path = temporaryDatabasePath(tempDirs);
    createLegacyServerFixture(path, 7);
    const sqlite = new DatabaseSync(path);
    try {
      sqlite.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)")
        .run("2035-01-01T00:00:00.000Z");
    } finally {
      sqlite.close();
    }

    expect(() => new AppDatabase(path)).toThrow(
      "Database schema version 99 is newer than supported version 12.",
    );
    const lease = acquireDatabaseLease(path);
    lease.close();
  });
});

function temporaryDatabasePath(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "debridstreamer-db-test-"));
  tempDirs.push(dir);
  return join(dir, "database.sqlite");
}
