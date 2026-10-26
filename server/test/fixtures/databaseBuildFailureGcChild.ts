import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../../src/app.js";
import {
  AppDatabase,
  DatabaseLeaseBusyError,
} from "../../src/db.js";

const databasePath = process.argv[2];
if (databasePath == null) throw new Error("Database path is required.");
if (globalThis.gc == null) throw new Error("This fixture requires --expose-gc.");

const setup = new AppDatabase(databasePath);
setup.close();

const originalClose = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function closeWithPermanentFailure() {
  const applicationDatabase = this.isOpen && this
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'schema_migrations'")
    .get() != null;
  if (applicationDatabase) {
    throw new Error("injected permanent application database close failure");
  }
  originalClose.call(this);
};
try {
  const failure = new Error("injected transcode detection failure");
  try {
    await buildApp({
      config: {
        databasePath,
        dataDir: dirname(databasePath),
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        updateCheck: false,
        enableTranscode: true,
      },
      transcoder: {
        detect: async () => { throw failure; },
      } as never,
    });
    throw new Error("Expected buildApp construction to fail.");
  } catch (error) {
    if (error !== failure) throw error;
  }
} finally {
  DatabaseSync.prototype.close = originalClose;
}

for (let index = 0; index < 20; index += 1) {
  globalThis.gc();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

try {
  new AppDatabase(databasePath);
  throw new Error("Garbage collection released a failed build's database lease.");
} catch (error) {
  if (!(error instanceof DatabaseLeaseBusyError)) throw error;
}

process.stdout.write("build-cleanup-held-after-gc\n", () => process.exit(0));
