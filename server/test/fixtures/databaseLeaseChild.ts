import { AppDatabase, DatabaseLeaseBusyError } from "../../src/db.js";

const databasePath = process.argv[2];
if (databasePath == null) throw new Error("Database path is required.");

let database: AppDatabase;
try {
  database = new AppDatabase(databasePath);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Database lease failed.",
  })}\n`);
  process.exitCode = error instanceof DatabaseLeaseBusyError ? 73 : 74;
  process.exit();
}

let released = false;
const release = () => {
  if (released) return;
  database.close();
  released = true;
  process.stdout.write("released\n");
};
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  release();
  process.stdout.write("closed\n", () => process.exit(0));
};
// IPC permits graceful release on Windows without treating kill(SIGTERM) as a
// delivered POSIX signal. Release can be observed while this process stays alive.
process.on("message", (message) => {
  if (message === "release") release();
  if (message === "close") close();
});
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.stdout.write("acquired\n");
setInterval(() => {}, 60_000);
