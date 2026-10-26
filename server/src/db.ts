import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

const AUDIT_LOG_RETENTION_DAYS = 90;
const AUDIT_LOG_MINIMUM_ROWS = 50_000;
const DATABASE_LEASE_APPLICATION_ID = 0x59415746;
const DATABASE_LEASE_VERSION = 1;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_HEADER_MAGIC = Buffer.from("SQLite format 3\0");

interface SqliteError extends Error {
  errcode?: number;
}

interface DatabaseLeaseFileIdentity {
  dev: bigint;
  ino: bigint;
}

interface FailedDatabaseCleanup {
  sqlite: DatabaseSync | null;
  lease: DatabaseLeaseHandle | null;
}

// Some failed cleanup paths cannot return a handle that a caller could retry.
// Retain those resources for the process lifetime rather than silently
// dropping the exclusive lease while the application database may remain live.
const failedDatabaseCleanups: FailedDatabaseCleanup[] = [];

export class DatabaseLeaseBusyError extends Error {
  constructor(databasePath: string, options?: ErrorOptions) {
    super(`The YAWF Stream database is already open: ${databasePath}`, options);
    this.name = "DatabaseLeaseBusyError";
  }
}

export class DatabaseLeaseFormatError extends Error {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(
      `The database lease file uses a legacy or invalid format: ${lockPath}. ` +
      "Stop every YAWF Stream server that uses this database, then run the documented offline lock migration. The lease file was not changed.",
      options,
    );
    this.name = "DatabaseLeaseFormatError";
  }
}

export class DatabaseLeaseAccessError extends Error {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(`Could not access the database lease: ${lockPath}`, options);
    this.name = "DatabaseLeaseAccessError";
  }
}

export interface DatabaseLeaseHandle {
  readonly path: string;
  close(): void;
  release(): void;
}

export function retainFailedDatabaseCleanup(
  sqlite: DatabaseSync | null,
  lease: DatabaseLeaseHandle | null,
): void {
  failedDatabaseCleanups.push({ sqlite, lease });
}

class SqliteDatabaseLease implements DatabaseLeaseHandle {
  private sqlite: DatabaseSync | null;

  constructor(readonly path: string, sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  close(): void {
    const sqlite = this.sqlite;
    if (sqlite == null) return;
    if (sqlite.isOpen) sqlite.close();
    if (sqlite.isOpen) {
      throw new DatabaseLeaseAccessError(this.path, {
        cause: new Error("SQLite reported that the database lease remained open."),
      });
    }
    this.sqlite = null;
  }

  release(): void {
    this.close();
  }
}

export class AppDatabase {
  readonly sqlite: DatabaseSync;
  private readonly lease: DatabaseLeaseHandle | null;
  private closed = false;
  private cleanupRetained = false;

  constructor(path: string) {
    const existingDatabase =
      path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
    this.lease = path === ":memory:" ? null : acquireDatabaseLease(path);
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(path);
      this.sqlite = opened;
      this.sqlite.exec("PRAGMA foreign_keys = ON;");
      this.sqlite.exec("PRAGMA journal_mode = WAL;");
      // Standard WAL durability: only OS or power loss can lose the last resume tick.
      this.sqlite.exec("PRAGMA synchronous = NORMAL;");
      if (existingDatabase) {
        createPreUpgradeSnapshotIfNeeded(this.sqlite, path);
      }
      migrateDatabase(this.sqlite);
      this.pruneAuditLog();
    } catch (error) {
      let databaseStillOpen = opened?.isOpen === true;
      try {
        if (databaseStillOpen) opened?.close();
      } catch {
        // Inspect the actual handle below because close can fail before or
        // after SQLite changes its open state.
      }
      databaseStillOpen = opened?.isOpen === true;
      if (databaseStillOpen) {
        retainFailedDatabaseCleanup(opened, this.lease);
      } else if (this.lease != null) {
        try {
          this.lease.release();
        } catch {
          retainFailedDatabaseCleanup(null, this.lease);
        }
      }
      // Preserve the migration/open error that triggered recovery cleanup.
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.sqlite.isOpen) this.sqlite.close();
    if (this.sqlite.isOpen) {
      throw new Error("SQLite reported that the application database remained open.");
    }
    this.lease?.release();
    this.closed = true;
  }

  retainAfterFailedClose(): void {
    if (this.closed || this.cleanupRetained) return;
    this.cleanupRetained = true;
    retainFailedDatabaseCleanup(
      this.sqlite.isOpen ? this.sqlite : null,
      this.lease,
    );
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.sqlite.exec("COMMIT;");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Retain recent security events and at least the newest 50,000 audit records. */
  pruneAuditLog(now = new Date()): void {
    const cutoff = new Date(
      now.getTime() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.sqlite
      .prepare(
        `DELETE FROM audit_log
         WHERE created_at < ?
           AND created_at < COALESCE(
             (SELECT created_at
              FROM audit_log
              ORDER BY created_at DESC
              LIMIT 1 OFFSET ?),
             ?
           )`,
      )
      .run(cutoff, AUDIT_LOG_MINIMUM_ROWS - 1, cutoff);
  }

}

export function databaseLockPath(databasePath: string): string {
  return `${databasePath}.server.lock`;
}

function sqlitePrimaryErrorCode(error: unknown): number | null {
  const code = (error as SqliteError | null)?.errcode;
  return typeof code === "number" ? code & 0xff : null;
}

function isExistingPathError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST";
}

function databaseLeasePathExists(lockPath: string): boolean {
  try {
    statSync(lockPath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw new DatabaseLeaseAccessError(lockPath, { cause: error });
  }
}

function databaseLeaseFileIdentity(lockPath: string): DatabaseLeaseFileIdentity {
  try {
    const stat = statSync(lockPath, { bigint: true });
    if (!stat.isFile()) {
      throw new Error("The database lease path is not a regular file.");
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof DatabaseLeaseAccessError) throw error;
    throw new DatabaseLeaseAccessError(lockPath, { cause: error });
  }
}

function sameDatabaseLeaseFile(
  left: DatabaseLeaseFileIdentity,
  right: DatabaseLeaseFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function admitDatabaseLeaseEnvelope(lockPath: string): DatabaseLeaseFileIdentity {
  const identity = databaseLeaseFileIdentity(lockPath);
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  let file: number | null = null;
  try {
    file = openSync(lockPath, "r");
    const bytesRead = readSync(file, header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new DatabaseLeaseFormatError(lockPath);
  } catch (error) {
    if (error instanceof DatabaseLeaseFormatError) throw error;
    throw new DatabaseLeaseAccessError(lockPath, { cause: error });
  } finally {
    if (file != null) {
      try {
        closeSync(file);
      } catch (error) {
        throw new DatabaseLeaseAccessError(lockPath, { cause: error });
      }
    }
  }

  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const validPageSize =
    pageSize >= 512 &&
    pageSize <= 65_536 &&
    (pageSize & (pageSize - 1)) === 0;
  if (
    !header.subarray(0, SQLITE_HEADER_MAGIC.length).equals(SQLITE_HEADER_MAGIC) ||
    !validPageSize ||
    header[18] !== 1 ||
    header[19] !== 1 ||
    header[21] !== 64 ||
    header[22] !== 32 ||
    header[23] !== 32 ||
    header.readUInt32BE(60) !== DATABASE_LEASE_VERSION ||
    header.readUInt32BE(68) !== DATABASE_LEASE_APPLICATION_ID
  ) {
    throw new DatabaseLeaseFormatError(lockPath);
  }
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    if (databaseLeasePathExists(`${lockPath}${suffix}`)) {
      throw new DatabaseLeaseFormatError(lockPath);
    }
  }
  if (!sameDatabaseLeaseFile(identity, databaseLeaseFileIdentity(lockPath))) {
    throw new DatabaseLeaseAccessError(lockPath, {
      cause: new Error("The database lease file changed during header admission."),
    });
  }
  return identity;
}

function initializeDatabaseLeaseFile(lockPath: string): void {
  if (databaseLeasePathExists(lockPath)) return;
  const temporaryPath = `${lockPath}.initialize-${process.pid}-${randomUUID()}`;
  let file: number | null = null;
  let sqlite: DatabaseSync | null = null;
  try {
    file = openSync(temporaryPath, "wx", 0o600);
    closeSync(file);
    file = null;
    sqlite = new DatabaseSync(temporaryPath);
    sqlite.exec(`
      PRAGMA application_id = ${DATABASE_LEASE_APPLICATION_ID};
      PRAGMA user_version = ${DATABASE_LEASE_VERSION};
      CREATE TABLE database_lease_format (
        version INTEGER PRIMARY KEY CHECK (version = ${DATABASE_LEASE_VERSION})
      );
      INSERT INTO database_lease_format (version) VALUES (${DATABASE_LEASE_VERSION});
    `);
    sqlite.close();
    sqlite = null;
    try {
      linkSync(temporaryPath, lockPath);
    } catch (error) {
      if (!isExistingPathError(error)) throw error;
    }
  } catch (error) {
    throw new DatabaseLeaseAccessError(lockPath, { cause: error });
  } finally {
    try {
      sqlite?.close();
    } catch {
      // Preserve the lease initialization error.
    }
    if (file != null) {
      try {
        closeSync(file);
      } catch (error) {
        throw new DatabaseLeaseAccessError(lockPath, { cause: error });
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw new DatabaseLeaseAccessError(lockPath, { cause: error });
      }
    }
  }
}

function validateDatabaseLease(sqlite: DatabaseSync, lockPath: string): void {
  try {
    const application = sqlite.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    const version = sqlite.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const format = sqlite
      .prepare("SELECT version FROM database_lease_format")
      .get() as { version: number } | undefined;
    if (
      application.application_id !== DATABASE_LEASE_APPLICATION_ID ||
      version.user_version !== DATABASE_LEASE_VERSION ||
      format?.version !== DATABASE_LEASE_VERSION
    ) {
      throw new DatabaseLeaseFormatError(lockPath);
    }
  } catch (error) {
    if (error instanceof DatabaseLeaseFormatError) throw error;
    if (sqlitePrimaryErrorCode(error) === 1) {
      throw new DatabaseLeaseFormatError(lockPath, { cause: error });
    }
    throw error;
  }
}

function mapDatabaseLeaseError(
  error: unknown,
  databasePath: string,
  lockPath: string,
  readonlyAdmission: boolean,
): Error {
  if (
    error instanceof DatabaseLeaseBusyError ||
    error instanceof DatabaseLeaseFormatError ||
    error instanceof DatabaseLeaseAccessError
  ) {
    return error;
  }
  const code = sqlitePrimaryErrorCode(error);
  if (code === 5 || code === 6) {
    return new DatabaseLeaseBusyError(databasePath, { cause: error });
  }
  if (
    code === 11 ||
    code === 24 ||
    code === 26 ||
    (readonlyAdmission && code === 8)
  ) {
    return new DatabaseLeaseFormatError(lockPath, { cause: error });
  }
  return new DatabaseLeaseAccessError(lockPath, { cause: error });
}

function inspectDatabaseLease(
  databasePath: string,
  lockPath: string,
): DatabaseLeaseFileIdentity {
  const identity = admitDatabaseLeaseEnvelope(lockPath);
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(lockPath, { readOnly: true });
    sqlite.exec("PRAGMA busy_timeout = 0; BEGIN;");
    validateDatabaseLease(sqlite, lockPath);
    if (!sameDatabaseLeaseFile(identity, databaseLeaseFileIdentity(lockPath))) {
      throw new DatabaseLeaseAccessError(lockPath, {
        cause: new Error("The database lease file changed during validation."),
      });
    }
    sqlite.close();
    sqlite = null;
    return identity;
  } catch (error) {
    if (sqlite?.isOpen) {
      try {
        sqlite.close();
      } catch {
        if (sqlite.isOpen) retainFailedDatabaseCleanup(sqlite, null);
      }
    }
    throw mapDatabaseLeaseError(error, databasePath, lockPath, true);
  }
}

function openDatabaseLease(
  databasePath: string,
  readOnly: boolean,
): DatabaseLeaseHandle {
  const lockPath = databaseLockPath(databasePath);
  const identity = inspectDatabaseLease(databasePath, lockPath);
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = readOnly
      ? new DatabaseSync(lockPath, { readOnly: true })
      : new DatabaseSync(lockPath);
    if (!sameDatabaseLeaseFile(identity, databaseLeaseFileIdentity(lockPath))) {
      throw new DatabaseLeaseAccessError(lockPath, {
        cause: new Error("The database lease file changed before acquisition."),
      });
    }
    sqlite.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    if (!sameDatabaseLeaseFile(identity, databaseLeaseFileIdentity(lockPath))) {
      throw new DatabaseLeaseAccessError(lockPath, {
        cause: new Error("The database lease file changed during acquisition."),
      });
    }
    validateDatabaseLease(sqlite, lockPath);
    return new SqliteDatabaseLease(lockPath, sqlite);
  } catch (error) {
    if (sqlite?.isOpen) {
      try {
        sqlite.close();
      } catch {
        if (sqlite.isOpen) retainFailedDatabaseCleanup(sqlite, null);
      }
    }
    throw mapDatabaseLeaseError(error, databasePath, lockPath, false);
  }
}

export function acquireDatabaseLease(databasePath: string): DatabaseLeaseHandle {
  if (databasePath === ":memory:") {
    throw new DatabaseLeaseAccessError(databasePath, {
      cause: new Error("In-memory databases do not have a shared lease path."),
    });
  }
  const lockPath = databaseLockPath(databasePath);
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
  } catch (error) {
    throw new DatabaseLeaseAccessError(lockPath, { cause: error });
  }
  initializeDatabaseLeaseFile(lockPath);
  return openDatabaseLease(databasePath, false);
}

export function isDatabaseServerRunning(databasePath: string): boolean {
  const lockPath = databaseLockPath(databasePath);
  if (!databaseLeasePathExists(lockPath)) return false;
  try {
    const lease = openDatabaseLease(databasePath, true);
    lease.release();
    return false;
  } catch (error) {
    if (error instanceof DatabaseLeaseBusyError) return true;
    if (!databaseLeasePathExists(lockPath)) return false;
    throw error;
  }
}

function currentSchemaVersion(sqlite: DatabaseSync): number {
  const migrationTable = sqlite
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (migrationTable == null) return 0;
  const row = sqlite
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return Number(row.version);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createPreUpgradeSnapshotIfNeeded(
  sqlite: DatabaseSync,
  databasePath: string,
  now = new Date(),
): string | null {
  const latestVersion = MIGRATIONS.at(-1)?.[0] ?? 0;
  const currentVersion = currentSchemaVersion(sqlite);
  if (currentVersion >= latestVersion) return null;

  const backupDir = `${dirname(databasePath)}/backups`;
  mkdirSync(backupDir, { recursive: true });
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outputPath =
    `${backupDir}/pre-upgrade-v${currentVersion}-to-v${latestVersion}-${timestamp}.sqlite`;
  sqlite.exec(`VACUUM INTO ${sqlStringLiteral(outputPath)}`);
  chmodSync(outputPath, 0o600);
  return outputPath;
}

/** Upgrade a database one version at a time. Each schema change and its
 * version marker share a transaction, so an interrupted or invalid migration
 * can never leave a half-upgraded database that fails on every later launch. */
export function migrateDatabase(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const latestVersion = MIGRATIONS.at(-1)?.[0] ?? 0;
  const appliedRows = sqlite
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  const newestApplied = appliedRows.at(-1)?.version ?? 0;
  if (newestApplied > latestVersion) {
    throw new Error(
      `Database schema version ${newestApplied} is newer than supported version ${latestVersion}.`,
    );
  }

  for (const [version, sql] of MIGRATIONS) {
    if (applied.has(version)) continue;
    sqlite.exec("BEGIN IMMEDIATE;");
    try {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
      sqlite.exec("COMMIT;");
      applied.add(version);
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw new Error(`Database migration ${version} failed.`, { cause: error });
    }
  }

  const foreignKeyViolation = sqlite.prepare("PRAGMA foreign_key_check").get();
  if (foreignKeyViolation != null) {
    throw new Error("Database migration completed with a foreign key violation.");
  }
}
