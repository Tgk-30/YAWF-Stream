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
const releaseLease = () => {
  if (released) return;
  database.close();
  released = true;
};
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  releaseLease();
  process.stdout.write("released\n", () => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
process.on("message", (message) => {
  if (message === "release-lease") {
    releaseLease();
    process.stdout.write(`lease-released:${process.pid}\n`);
  } else if (message === "ping") {
    process.stdout.write(`alive:${process.pid}\n`);
  }
});
process.stdout.write("acquired\n");
setInterval(() => {}, 60_000);
