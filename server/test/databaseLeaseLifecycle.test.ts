import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface LeaseChild {
  child: ChildProcessWithoutNullStreams;
  acquired: Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): { stdout: string; stderr: string };
}

const children = new Set<LeaseChild>();
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

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), CHILD_TIMEOUT_MS);
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

function spawnLeaseChild(databasePath: string): LeaseChild {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CHILD_FIXTURE, databasePath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let acquired = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const acquiredPromise = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!acquired && stdout.includes("acquired\n")) {
        acquired = true;
        resolve();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    void exit.then(({ code, signal }) => {
      if (!acquired) {
        reject(new Error(
          `Lease child exited before acquisition (code=${code}, signal=${signal}): ${stderr}`,
        ));
      }
    });
  });
  const leaseChild: LeaseChild = {
    child,
    acquired: timeout(acquiredPromise, "Lease child did not acquire in time."),
    exit: timeout(exit, "Lease child did not exit in time."),
    output: () => ({ stdout, stderr }),
  };
  children.add(leaseChild);
  void leaseChild.acquired.catch(() => {});
  void leaseChild.exit.then(
    () => children.delete(leaseChild),
    () => children.delete(leaseChild),
  );
  return leaseChild;
}

async function stopChild(
  leaseChild: LeaseChild,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  leaseChild.child.kill(signal);
  return leaseChild.exit;
}

afterEach(async () => {
  const running = [...children];
  for (const leaseChild of running) leaseChild.child.kill("SIGKILL");
  await Promise.allSettled(running.map((leaseChild) => leaseChild.exit));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

    await expect(stopChild(owner, "SIGTERM")).resolves.toEqual({
      code: 0,
      signal: null,
    });
    expect(owner.output().stdout).toContain("released\n");

    const replacement = spawnLeaseChild(databasePath);
    await replacement.acquired;
    await stopChild(replacement, "SIGTERM");
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
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CONSTRUCTOR_FAILURE_FIXTURE, databasePath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const result = await timeout(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      "Constructor cleanup child did not exit in time.",
    );
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("constructor-cleanup-held\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it("retains a failed build database through forced garbage collection", async () => {
    const databasePath = temporaryDatabasePath();
    const child = spawn(
      process.execPath,
      ["--expose-gc", "--import", "tsx", BUILD_FAILURE_GC_FIXTURE, databasePath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const result = await timeout(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      "Failed-build garbage-collection child did not exit in time.",
    );
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("build-cleanup-held-after-gc\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it("rejects a hot-journal invalid lease without changing forensic bytes", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const journalPath = `${lockPath}-journal`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", HOT_JOURNAL_FIXTURE, lockPath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("hot-journal-ready\n")) resolve();
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      void exit.then(({ code, signal }) => {
        if (!stdout.includes("hot-journal-ready\n")) {
          reject(new Error(`Hot-journal child exited ${code}/${signal}: ${stderr}`));
        }
      });
    });

    try {
      await timeout(ready, "Hot-journal child did not become ready in time.");
      child.kill("SIGKILL");
      await timeout(exit, "Hot-journal child did not exit after SIGKILL.");

      const databaseBefore = readFileSync(lockPath);
      const journalBefore = readFileSync(journalPath);
      expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
      expect(readFileSync(lockPath).equals(databaseBefore)).toBe(true);
      expect(readFileSync(journalPath).equals(journalBefore)).toBe(true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
  });

  it("rejects a foreign WAL lease without creating or changing sidecars", async () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const originDir = mkdtempSync(join(tmpdir(), "yawf-foreign-wal-origin-"));
    tempDirs.push(originDir);
    const sourcePath = join(originDir, "foreign.sqlite");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", FOREIGN_WAL_FIXTURE, sourcePath, lockPath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const result = await timeout(
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      "Foreign-WAL fixture child did not exit in time.",
    );
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("foreign-wal-copied\n");

    const before = fileInventory(dirname(lockPath));
    expect(before.map((entry) => entry.name)).toEqual([
      basename(lockPath),
      `${basename(lockPath)}-wal`,
    ]);
    expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
    expect(fileInventory(dirname(lockPath))).toEqual(before);
  });
});
