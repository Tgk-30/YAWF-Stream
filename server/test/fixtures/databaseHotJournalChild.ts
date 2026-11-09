import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const phaseStarted = performance.now();
const phase = (name: "module" | "open" | "seed-commit" | "begin" | "update" | "journal-validated-ready") => {
  if (process.env.YAWF_TEST_LEASE_PHASES !== "1") return;
  const elapsed = Math.min(99_999_999, Math.max(0, Math.floor(performance.now() - phaseStarted)));
  process.stdout.write(`lease-phase child ${name} ${elapsed}\n`);
};
phase("module");

const lockPath = process.argv[2];
if (lockPath == null) throw new Error("Database lease path is required.");

const sqlite = new DatabaseSync(lockPath);
phase("open");
sqlite.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  PRAGMA cache_size = 4;
  CREATE TABLE unrelated (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
  INSERT INTO unrelated (payload) VALUES (zeroblob(2097152));
`);
phase("seed-commit");
sqlite.exec("BEGIN IMMEDIATE;");
phase("begin");
sqlite.exec("UPDATE unrelated SET payload = randomblob(2097152) WHERE id = 1;");
phase("update");
const journalPath = `${lockPath}-journal`;
if (!existsSync(journalPath) || statSync(journalPath).size <= 512) {
  throw new Error("Fixture did not create a hot rollback journal.");
}
phase("journal-validated-ready");
process.stdout.write("hot-journal-ready\n");
setInterval(() => {}, 60_000);
