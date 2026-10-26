import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { hashPassword, nowISO, randomId } from "./crypto.js";
import {
  acquireDatabaseLease,
  DatabaseLeaseBusyError,
  retainFailedDatabaseCleanup,
  type DatabaseLeaseHandle,
} from "./db.js";

interface ResetOwnerOptions {
  username?: string;
  password: string;
}

export interface ResetOwnerResult {
  username: string;
  sessionsRevoked: number;
  totpDisabled: boolean;
}

export interface DatabaseBackupResult {
  outputPath: string;
  pages: number;
}

function acquireRecoveryLease(databasePath: string, message: string): DatabaseLeaseHandle {
  try {
    return acquireDatabaseLease(databasePath);
  } catch (error) {
    if (error instanceof DatabaseLeaseBusyError) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

function closeRecoveryResources(
  connections: Set<DatabaseSync>,
  lease: DatabaseLeaseHandle,
): void {
  let closeError: unknown;
  for (const sqlite of connections) {
    try {
      if (sqlite.isOpen) sqlite.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  const stillOpen = [...connections].filter((sqlite) => sqlite.isOpen);
  if (stillOpen.length > 0) {
    for (const sqlite of stillOpen) retainFailedDatabaseCleanup(sqlite, lease);
    throw closeError ?? new Error("Recovery could not close its database safely. Restart this process before retrying.");
  }
  try {
    lease.close();
  } catch (error) {
    retainFailedDatabaseCleanup(null, lease);
    throw closeError ?? error;
  }
  if (closeError != null) throw closeError;
}

function timestampForPath(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function defaultBackupPath(databasePath: string, kind: string): string {
  return join(
    dirname(databasePath),
    "backups",
    `${kind}-${timestampForPath()}.sqlite`,
  );
}

function assertHealthyDatabase(path: string, connections?: Set<DatabaseSync>): void {
  if (!existsSync(path)) {
    throw new Error(`Database file does not exist: ${path}`);
  }
  const sqlite = new DatabaseSync(path, { readOnly: true });
  connections?.add(sqlite);
  try {
    const integrity = sqlite.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
    }
    const migrationTable = sqlite
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (migrationTable == null) {
      throw new Error("Backup is not a YAWF Stream server database.");
    }
  } finally {
    sqlite.close();
    if (!sqlite.isOpen) connections?.delete(sqlite);
  }
}

export async function createDatabaseBackup(
  databasePath: string,
  outputPath = defaultBackupPath(databasePath, "manual"),
): Promise<DatabaseBackupResult> {
  return createDatabaseBackupWithConnections(databasePath, outputPath);
}

async function createDatabaseBackupWithConnections(
  databasePath: string,
  outputPath: string,
  connections?: Set<DatabaseSync>,
): Promise<DatabaseBackupResult> {
  if (!existsSync(databasePath)) {
    throw new Error(`Database file does not exist: ${databasePath}`);
  }
  const resolvedDatabase = resolve(databasePath);
  const resolvedOutput = resolve(outputPath);
  if (resolvedDatabase === resolvedOutput) {
    throw new Error("Backup output must be different from the live database.");
  }
  if (existsSync(resolvedOutput)) {
    throw new Error(`Refusing to overwrite an existing backup: ${resolvedOutput}`);
  }

  mkdirSync(dirname(resolvedOutput), { recursive: true });
  const source = new DatabaseSync(resolvedDatabase);
  connections?.add(source);
  try {
    source.exec("PRAGMA busy_timeout = 5000;");
    const pages = await backup(source, resolvedOutput);
    chmodSync(resolvedOutput, 0o600);
    assertHealthyDatabase(resolvedOutput, connections);
    return { outputPath: resolvedOutput, pages };
  } catch (error) {
    rmSync(resolvedOutput, { force: true });
    throw error;
  } finally {
    source.close();
    if (!source.isOpen) connections?.delete(source);
  }
}

export async function restoreDatabaseBackup(
  databasePath: string,
  inputPath: string,
): Promise<{ restoredFrom: string; safetyBackup: string | null }> {
  const resolvedDatabase = resolve(databasePath);
  const resolvedInput = resolve(inputPath);
  if (resolvedDatabase === resolvedInput) {
    throw new Error("Restore input must be different from the live database.");
  }
  mkdirSync(dirname(resolvedDatabase), { recursive: true });
  const lease = acquireRecoveryLease(
    resolvedDatabase,
    "Stop the YAWF Stream server before restoring its database.",
  );
  const connections = new Set<DatabaseSync>();
  try {
    return await restoreDatabaseBackupUnderLease(resolvedDatabase, resolvedInput, connections);
  } finally {
    closeRecoveryResources(connections, lease);
  }
}

async function restoreDatabaseBackupUnderLease(
  resolvedDatabase: string,
  resolvedInput: string,
  connections: Set<DatabaseSync>,
): Promise<{ restoredFrom: string; safetyBackup: string | null }> {
  assertHealthyDatabase(resolvedInput, connections);

  let safetyBackup: string | null = null;
  if (existsSync(resolvedDatabase)) {
    safetyBackup = defaultBackupPath(resolvedDatabase, "pre-restore");
    await createDatabaseBackupWithConnections(resolvedDatabase, safetyBackup, connections);
  }

  const staged = `${resolvedDatabase}.restore-${timestampForPath()}.tmp`;
  rmSync(staged, { force: true });
  copyFileSync(resolvedInput, staged);
  chmodSync(staged, 0o600);
  assertHealthyDatabase(staged, connections);

  const displaced = `${resolvedDatabase}.replaced-${timestampForPath()}`;
  try {
    rmSync(`${resolvedDatabase}-wal`, { force: true });
    rmSync(`${resolvedDatabase}-shm`, { force: true });
    if (existsSync(resolvedDatabase)) renameSync(resolvedDatabase, displaced);
    renameSync(staged, resolvedDatabase);
    assertHealthyDatabase(resolvedDatabase, connections);
    rmSync(displaced, { force: true });
  } catch (error) {
    rmSync(staged, { force: true });
    if (!existsSync(resolvedDatabase) && existsSync(displaced)) {
      renameSync(displaced, resolvedDatabase);
    }
    throw error;
  }

  return { restoredFrom: resolvedInput, safetyBackup };
}

export function configuredDatabasePath(): string {
  const explicit = process.env.DS_SERVER_DB_PATH?.trim();
  if (explicit) return explicit;
  const dataDir = process.env.DS_SERVER_DATA_DIR?.trim() || join(process.cwd(), "data");
  return join(dataDir, "debridstreamer.sqlite");
}

export async function resetOwnerPassword(
  databasePath: string,
  options: ResetOwnerOptions,
): Promise<ResetOwnerResult> {
  if (options.password.length < 8) {
    throw new Error("The new owner password must be at least 8 characters.");
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Database file does not exist: ${databasePath}`);
  }

  const lease = acquireRecoveryLease(
    databasePath,
    "Stop the YAWF Stream server before recovering its owner.",
  );
  const connections = new Set<DatabaseSync>();
  try {
    return await resetOwnerPasswordUnderLease(databasePath, options, connections);
  } finally {
    closeRecoveryResources(connections, lease);
  }
}

async function resetOwnerPasswordUnderLease(
  databasePath: string,
  options: ResetOwnerOptions,
  connections: Set<DatabaseSync>,
): Promise<ResetOwnerResult> {
  const sqlite = new DatabaseSync(databasePath);
  connections.add(sqlite);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec("PRAGMA busy_timeout = 1000;");
    const owners = sqlite
      .prepare(
        `SELECT id, username, totp_enabled
         FROM users
         WHERE role = 'owner' AND disabled_at IS NULL
         ORDER BY created_at`,
      )
      .all() as Array<{ id: string; username: string; totp_enabled: number }>;
    const owner =
      options.username == null
        ? owners.length === 1
          ? owners[0]
          : null
        : owners.find(
            (candidate) =>
              candidate.username.toLocaleLowerCase() ===
              options.username?.toLocaleLowerCase(),
          ) ?? null;

    if (owner == null) {
      if (options.username != null) {
        throw new Error(`No active owner account matches "${options.username}".`);
      }
      if (owners.length === 0) {
        throw new Error("No active owner account exists in this database.");
      }
      throw new Error("More than one owner exists. Pass --username to choose one.");
    }

    const passwordHash = await hashPassword(options.password);
    const now = nowISO();
    sqlite.exec("BEGIN IMMEDIATE;");
    try {
      sqlite
        .prepare(
          `UPDATE users
           SET password_hash = ?,
               totp_secret_encrypted = NULL,
               totp_pending_secret_encrypted = NULL,
               totp_enabled = 0
           WHERE id = ? AND role = 'owner'`,
        )
        .run(passwordHash, owner.id);
      const sessions = sqlite
        .prepare(
          `UPDATE sessions
           SET revoked_at = COALESCE(revoked_at, ?)
           WHERE user_id = ? AND revoked_at IS NULL`,
        )
        .run(now, owner.id);
      sqlite
        .prepare(
          `INSERT INTO audit_log
             (id, actor_user_id, actor_profile_id, action, target_type, target_id, metadata_json, created_at)
           VALUES (?, NULL, NULL, 'owner.recovered_local', 'user', ?, ?, ?)`,
        )
        .run(
          randomId("audit"),
          owner.id,
          JSON.stringify({
            username: owner.username,
            sessionsRevoked: Number(sessions.changes),
            totpDisabled: owner.totp_enabled === 1,
          }),
          now,
        );
      sqlite.exec("COMMIT;");
      return {
        username: owner.username,
        sessionsRevoked: Number(sessions.changes),
        totpDisabled: owner.totp_enabled === 1,
      };
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    sqlite.close();
    if (!sqlite.isOpen) connections.delete(sqlite);
  }
}

function printRecoveryUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  node dist/index.cjs recovery reset-owner --password-stdin [--username OWNER]",
      "  node dist/index.cjs recovery backup [--output FILE]",
      "  node dist/index.cjs recovery restore --input FILE --force",
      "",
      "Stop the server before reset-owner or restore.",
      "Restore verifies the input and keeps a pre-restore safety backup.",
      "",
    ].join("\n"),
  );
}

export async function runRecoveryCli(args: string[]): Promise<number | null> {
  if (args[0] !== "recovery") return null;

  const command = args[1];
  if (command === "backup") {
    const outputIndex = args.indexOf("--output");
    const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    if (outputIndex >= 0 && !output) {
      printRecoveryUsage();
      return 2;
    }
    try {
      const result = await createDatabaseBackup(configuredDatabasePath(), output);
      process.stdout.write(
        `Verified backup created at ${result.outputPath} (${result.pages} pages).\n`,
      );
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Database backup failed: ${message}\n`);
      return 1;
    }
  }

  if (command === "restore") {
    const inputIndex = args.indexOf("--input");
    const input = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
    if (!input || !args.includes("--force")) {
      printRecoveryUsage();
      return 2;
    }
    try {
      const result = await restoreDatabaseBackup(configuredDatabasePath(), input);
      process.stdout.write(
        `Verified database restored from ${result.restoredFrom}.` +
          `${result.safetyBackup ? ` Safety backup: ${result.safetyBackup}.` : ""}\n`,
      );
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Database restore failed: ${message}\n`);
      return 1;
    }
  }

  if (command !== "reset-owner" || !args.includes("--password-stdin")) {
    printRecoveryUsage();
    return 2;
  }

  const usernameIndex = args.indexOf("--username");
  const username =
    usernameIndex >= 0 && args[usernameIndex + 1]
      ? args[usernameIndex + 1]
      : undefined;
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");

  try {
    const result = await resetOwnerPassword(configuredDatabasePath(), {
      username,
      password,
    });
    process.stdout.write(
      `Owner "${result.username}" recovered. Revoked ${result.sessionsRevoked} session(s)` +
        `${result.totpDisabled ? " and disabled TOTP" : ""}.\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Owner recovery failed: ${message}\n`);
    return 1;
  }
}
