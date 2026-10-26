import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
if (sourcePath == null || targetPath == null) {
  throw new Error("Source and target database paths are required.");
}

const sqlite = new DatabaseSync(sourcePath);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA wal_autocheckpoint = 0;
  CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO unrelated (value) VALUES ('foreign WAL fixture');
`);
if (!existsSync(`${sourcePath}-wal`)) {
  throw new Error("Fixture did not create a WAL file.");
}
copyFileSync(sourcePath, targetPath);
copyFileSync(`${sourcePath}-wal`, `${targetPath}-wal`);
sqlite.close();
process.stdout.write("foreign-wal-copied\n");
