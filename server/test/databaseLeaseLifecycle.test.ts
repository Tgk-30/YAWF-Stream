import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  acquireDatabaseLease,
  databaseLockPath,
  DatabaseLeaseFormatError,
  DatabaseLeaseBusyError,
} from "../src/db.js";
import { createDatabaseBackup } from "../src/recovery.js";

const CHILD_FIXTURE = fileURLToPath(
  new URL("./fixtures/databaseLeaseChild.ts", import.meta.url),
);
const CONSTRUCTOR_FAILURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/databaseConstructorFailureChild.ts", import.meta.url),
);
const BUILD_FAILURE_GC_FIXTURE = fileURLToPath(
  new URL("./fixtures/databaseBuildFailureGcChild.ts", import.meta.url),
);
const HOT_JOURNAL_FIXTURE = fileURLToPath(
  new URL("./fixtures/databaseHotJournalChild.ts", import.meta.url),
);
const FOREIGN_WAL_FIXTURE = fileURLToPath(
  new URL("./fixtures/databaseForeignWalChild.ts", import.meta.url),
);
const CHILD_TIMEOUT_MS = 10_000;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface FixtureChild {
  child: ChildProcess;
  exit: Promise<ChildExit>;
  closed: Promise<ChildExit>;
  output(): { stdout: string; stderr: string };
}

interface LeaseChild extends FixtureChild {
  acquired: Promise<void>;
}

const children = new Set<FixtureChild>();
const tempDirs: string[] = [];

function temporaryDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yawf-database-lease-"));
  tempDirs.push(dir);
  return join(dir, "database.sqlite");
}

function fileInventory(directory: string): Array<{
  name: string;
  bytes: number;
  sha256: string;
}> {
  return readdirSync(directory).sort().map((name) => {
    const contents = readFileSync(join(directory, name));
    return {
      name,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  });
}

function timeout<T>(promise: Promise<T>, message: string, milliseconds = CHILD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function spawnFixture(args: string[], ipc = false): FixtureChild {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const exit = new Promise<ChildExit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const closed = new Promise<ChildExit>((resolve) => {
    child.once("close", (code, signal) => {
      children.delete(fixture);
      resolve({ code, signal });
    });
  });
  const fixture: FixtureChild = { child, exit, closed, output: () => ({ stdout, stderr }) };
  // Track every fixture immediately. A caller's deadline cannot establish that
  // the OS process or its handles have closed, so never untrack on timeout.
  children.add(fixture);
  void exit.catch(() => {});
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  return fixture;
}

function waitForOutput(fixture: FixtureChild, marker: string): Promise<void> {
  if (fixture.output().stdout.includes(marker)) return Promise.resolve();
  let onData: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    onData = () => {
      if (fixture.output().stdout.includes(marker)) resolve();
    };
    fixture.child.stdout!.on("data", onData);
    void fixture.closed.then(({ code, signal }) => {
      if (!fixture.output().stdout.includes(marker)) {
        reject(new Error(`Fixture exited before ${marker.trim()} (code=${code}, signal=${signal}): ${fixture.output().stderr}`));
      }
    }, reject);
  });
  return timeout(ready, `Fixture did not report ${marker.trim()} in time.`)
    .finally(() => fixture.child.stdout!.removeListener("data", onData));
}

function spawnLeaseChild(databasePath: string): LeaseChild {
  const fixture = spawnFixture(["--import", "tsx", CHILD_FIXTURE, databasePath], true);
  const acquired = waitForOutput(fixture, "acquired\n");
  void acquired.catch(() => {});
  return Object.assign(fixture, { acquired });
}

async function stopChild(fixture: FixtureChild, signal: NodeJS.Signals): Promise<ChildExit> {
  if (fixture.child.exitCode == null && fixture.child.signalCode == null) fixture.child.kill(signal);
  return timeout(fixture.closed, "Fixture did not close after termination.");
}

function closeChildOverIpc(fixture: FixtureChild): Promise<ChildExit> {
  if (!fixture.child.connected) throw new Error("Lease fixture has no IPC channel.");
  fixture.child.send!("close");
  return timeout(fixture.closed, "Lease fixture did not close after IPC shutdown.");
}

afterEach(async () => {
  const running = [...children];
  for (const fixture of running) {
    if (fixture.child.exitCode == null && fixture.child.signalCode == null) fixture.child.kill("SIGKILL");
  }
  // A failed close deadline must fail cleanup and preserve the directories,
  // rather than deleting files that a fixture may still have open on Windows.
  await Promise.all(running.map((fixture) => timeout(fixture.closed, "Fixture did not close during cleanup.")));
  expect(children.size).toBe(0);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, CHILD_TIMEOUT_MS + 1000);

describe("database lease process lifecycle", () => {
  it("allows exactly one child to win an initially absent-file race", async () => {
    const databasePath = temporaryDatabasePath();
    const contenders = Array.from({ length: 4 }, () => spawnLeaseChild(databasePath));
    const results = await Promise.allSettled(
      contenders.map((contender) => contender.acquired),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = contenders[results.findIndex((result) => result.status === "fulfilled")]!;
    for (const [index, contender] of contenders.entries()) {
      if (contender === winner) continue;
      await expect(contender.exit).resolves.toEqual({ code: 73, signal: null });
      expect(contender.output().stderr).toContain("DatabaseLeaseBusyError");
      expect(results[index]?.status).toBe("rejected");
    }
    await stopChild(winner, "SIGTERM");
  });

  it("excludes a second child while the owner is live", async () => {
    const databasePath = temporaryDatabasePath();
    const owner = spawnLeaseChild(databasePath);
    await owner.acquired;

    const contender = spawnLeaseChild(databasePath);
    await expect(contender.exit).resolves.toEqual({ code: 73, signal: null });
    expect(contender.output().stderr).toContain("database is already open");
    await stopChild(owner, "SIGTERM");
  });

  it("reacquires after SIGKILL without deleting or rewriting the lease file", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const owner = spawnLeaseChild(databasePath);
    await owner.acquired;
    const before = readFileSync(lockPath);

    await expect(stopChild(owner, "SIGKILL")).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath)).toEqual(before);

    const replacement = spawnLeaseChild(databasePath);
    await replacement.acquired;
    await stopChild(replacement, "SIGTERM");
  });

  it("releases the lease after an actual SIGTERM", async () => {
    const databasePath = temporaryDatabasePath();
    const owner = spawnLeaseChild(databasePath);
    await owner.acquired;

    const lockPath = databaseLockPath(databasePath);
    const before = readFileSync(lockPath);
    if (process.platform === "win32") {
      // Windows kill(SIGTERM) is forceful; it does not invoke the close handler.
      await expect(stopChild(owner, "SIGTERM")).resolves.toEqual({ code: null, signal: "SIGTERM" });
      expect(owner.output().stdout).not.toContain("released\n");
    } else {
      await expect(stopChild(owner, "SIGTERM")).resolves.toEqual({ code: 0, signal: null });
      expect(owner.output().stdout).toContain("released\n");
    }
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath)).toEqual(before);

    const replacement = spawnLeaseChild(databasePath);
    await replacement.acquired;
    await stopChild(replacement, "SIGTERM");
  });

  it("releases gracefully over IPC before the owning process exits", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const owner = spawnLeaseChild(databasePath);
    await owner.acquired;
    const before = readFileSync(lockPath);
    const released = waitForOutput(owner, "released\n");
    owner.child.send!("release");
    await released;
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    expect(children.has(owner)).toBe(true);

    // A different real process must acquire while the original remains alive.
    // Merely exiting with code zero would not prove the explicit close path.
    const replacement = spawnLeaseChild(databasePath);
    await replacement.acquired;
    expect(owner.child.exitCode).toBeNull();
    expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseBusyError);
    expect(readFileSync(lockPath)).toEqual(before);
    await expect(Promise.all([closeChildOverIpc(owner), closeChildOverIpc(replacement)]))
      .resolves.toEqual([{ code: 0, signal: null }, { code: 0, signal: null }]);
    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  }, CHILD_TIMEOUT_MS * 4);

  it("keeps a fixture tracked after a phase deadline until actual close", async () => {
    const fixture = spawnFixture(["-e", "setInterval(() => {}, 60_000)"]);
    try {
      await expect(timeout(fixture.closed, "injected phase deadline", 5))
        .rejects.toThrow("injected phase deadline");
      expect(children.has(fixture)).toBe(true);
      expect(fixture.child.exitCode).toBeNull();
      await expect(stopChild(fixture, "SIGKILL")).resolves.toEqual({ code: null, signal: "SIGKILL" });
      expect(children.has(fixture)).toBe(false);
    } finally {
      if (fixture.child.exitCode == null && fixture.child.signalCode == null) fixture.child.kill("SIGKILL");
      await timeout(fixture.closed, "Phase-deadline control did not close.");
    }
  });

  it("closes an open-file fixture before the cleanup hook removes its directory", async () => {
    const path = temporaryDatabasePath();
    const fixture = spawnFixture(["-e", `
      require("node:fs").openSync(process.argv[1], "w");
      process.stdout.write("file-held\\n");
      setInterval(() => {}, 60_000);
    `, path]);
    await waitForOutput(fixture, "file-held\n");
    expect(children.has(fixture)).toBe(true);
    // Deliberately leave this real handle/process to the tracked cleanup hook.
  });

  it("keeps online backup compatible while the application lease is held", async () => {
    const databasePath = temporaryDatabasePath();
    const owner = spawnLeaseChild(databasePath);
    await owner.acquired;
    const backupPath = join(databasePath, "..", "backup.sqlite");

    const backup = await createDatabaseBackup(databasePath, backupPath);
    expect(backup.outputPath).toBe(backupPath);
    expect(backup.pages).toBeGreaterThan(0);
    expect(existsSync(backupPath)).toBe(true);
    await stopChild(owner, "SIGTERM");
  });

  it("releases the lease when buildApp construction fails", async () => {
    const databasePath = temporaryDatabasePath();
    const dataDir = join(databasePath, "..");
    const failure = new Error("injected transcode detection failure");

    await expect(buildApp({
      config: {
        databasePath,
        dataDir,
        secretKey: randomBytes(32),
        cookieSecure: false,
        logger: false,
        updateCheck: false,
        enableTranscode: true,
      },
      transcoder: {
        detect: async () => { throw failure; },
      } as never,
    })).rejects.toBe(failure);

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it("does not release the lease when constructor cleanup leaves its database open", async () => {
    const databasePath = temporaryDatabasePath();
    const fixture = spawnFixture(["--import", "tsx", CONSTRUCTOR_FAILURE_FIXTURE, databasePath]);
    const result = await timeout(fixture.closed, "Constructor cleanup child did not exit in time.");
    expect(result, fixture.output().stderr).toEqual({ code: 0, signal: null });
    expect(fixture.output().stdout).toContain("constructor-cleanup-held\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it("retains a failed build database through forced garbage collection", async () => {
    const databasePath = temporaryDatabasePath();
    const fixture = spawnFixture(["--expose-gc", "--import", "tsx", BUILD_FAILURE_GC_FIXTURE, databasePath]);
    const result = await timeout(fixture.closed, "Failed-build garbage-collection child did not exit in time.");
    expect(result, fixture.output().stderr).toEqual({ code: 0, signal: null });
    expect(fixture.output().stdout).toContain("build-cleanup-held-after-gc\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it("rejects a hot-journal invalid lease without changing forensic bytes", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const journalPath = `${lockPath}-journal`;
    const fixture = spawnFixture(["--import", "tsx", HOT_JOURNAL_FIXTURE, lockPath]);

    try {
      await waitForOutput(fixture, "hot-journal-ready\n");
      await stopChild(fixture, "SIGKILL");

      const databaseBefore = readFileSync(lockPath);
      const journalBefore = readFileSync(journalPath);
      expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
      expect(readFileSync(lockPath).equals(databaseBefore)).toBe(true);
      expect(readFileSync(journalPath).equals(journalBefore)).toBe(true);
    } finally {
      await stopChild(fixture, "SIGKILL");
    }
    // Readiness, termination and finally cleanup each have a ten-second bound.
  }, CHILD_TIMEOUT_MS * 3);

  it("rejects a foreign WAL lease without creating or changing sidecars", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const originDir = mkdtempSync(join(tmpdir(), "yawf-foreign-wal-origin-"));
    tempDirs.push(originDir);
    const sourcePath = join(originDir, "foreign.sqlite");
    const fixture = spawnFixture(["--import", "tsx", FOREIGN_WAL_FIXTURE, sourcePath, lockPath]);
    const result = await timeout(fixture.closed, "Foreign-WAL fixture child did not exit in time.");
    expect(result, fixture.output().stderr).toEqual({ code: 0, signal: null });
    expect(fixture.output().stdout).toContain("foreign-wal-copied\n");

    const before = fileInventory(dirname(lockPath));
    expect(before.map((entry) => entry.name)).toEqual([
      basename(lockPath),
      `${basename(lockPath)}-wal`,
    ]);
    expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
    expect(fileInventory(dirname(lockPath))).toEqual(before);
  });
});
