import { DatabaseSync } from "node:sqlite";
import {
  AppDatabase,
  DatabaseLeaseBusyError,
} from "../../src/db.js";

const databasePath = process.argv[2];
if (databasePath == null) throw new Error("Database path is required.");

const setup = new AppDatabase(databasePath);
setup.sqlite
  .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)")
  .run("2035-01-01T00:00:00.000Z");
setup.close();

const originalClose = DatabaseSync.prototype.close;
let failOnce = true;
DatabaseSync.prototype.close = function closeWithInjectedFailure() {
  const applicationDatabase = this.isOpen && this
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'schema_migrations'")
    .get() != null;
  if (failOnce && applicationDatabase) {
    failOnce = false;
    throw new Error("injected constructor database close failure");
  }
  originalClose.call(this);
};

try {
  try {
    new AppDatabase(databasePath);
    throw new Error("Expected database construction to fail.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("newer than supported")) {
      throw error;
    }
  }
} finally {
  DatabaseSync.prototype.close = originalClose;
}

try {
  new AppDatabase(databasePath);
  throw new Error("Constructor cleanup released the lease while its database remained open.");
} catch (error) {
  if (!(error instanceof DatabaseLeaseBusyError)) throw error;
}

process.stdout.write("constructor-cleanup-held\n", () => process.exit(0));
