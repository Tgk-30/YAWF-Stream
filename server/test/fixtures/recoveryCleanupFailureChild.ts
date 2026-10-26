import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase, DatabaseLeaseBusyError } from "../../src/db.js";
import { createDatabaseBackup, resetOwnerPassword, restoreDatabaseBackup } from "../../src/recovery.js";

const [databasePath, mode] = process.argv.slice(2);
if (!databasePath || !["owner", "restore"].includes(mode ?? "")) {
  throw new Error("Fixture database and recovery mode are required.");
}
process.env.DS_SCRYPT_N = "16384";
const setup = new AppDatabase(databasePath);
setup.sqlite.prepare(
  `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
   VALUES ('fixture-owner', 'fixture-owner', 'Fixture owner', 'fixture-hash', 'owner', ?)`,
).run(new Date().toISOString());
setup.close();
const backupPath = join(dirname(databasePath), "restore-input.sqlite");
if (mode === "restore") await createDatabaseBackup(databasePath, backupPath);

const originalClose = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function closeWithRecoveryFailure() {
  const location = this.prepare("PRAGMA database_list").get() as { file: string };
  if (realpathSync(location.file) === realpathSync(databasePath)) throw new Error("fixture recovery close failed");
  originalClose.call(this);
};
try {
  let failed = false;
  try {
    if (mode === "owner") {
      await resetOwnerPassword(databasePath, { password: "fixture-new-password" });
    } else {
      await restoreDatabaseBackup(databasePath, backupPath);
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("fixture recovery close failed")) throw error;
    failed = true;
  }
  if (!failed) throw new Error("Recovery unexpectedly accepted a permanent close failure.");
} finally {
  DatabaseSync.prototype.close = originalClose;
}

global.gc?.();
try {
  const unexpected = new AppDatabase(databasePath);
  unexpected.close();
  throw new Error("Recovery released ownership while its database remained open.");
} catch (error) {
  if (!(error instanceof DatabaseLeaseBusyError)) throw error;
}
process.stdout.write("recovery-cleanup-held\n", () => process.exit(0));
