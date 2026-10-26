import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const lockPath = process.argv[2];
if (lockPath == null) throw new Error("Database lease path is required.");

const sqlite = new DatabaseSync(lockPath);
sqlite.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  PRAGMA cache_size = 4;
  CREATE TABLE unrelated (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
  INSERT INTO unrelated (payload) VALUES (zeroblob(2097152));
  BEGIN IMMEDIATE;
  UPDATE unrelated SET payload = randomblob(2097152) WHERE id = 1;
`);
const journalPath = `${lockPath}-journal`;
if (!existsSync(journalPath) || statSync(journalPath).size <= 512) {
  throw new Error("Fixture did not create a hot rollback journal.");
}
process.stdout.write("hot-journal-ready\n");
setInterval(() => {}, 60_000);
