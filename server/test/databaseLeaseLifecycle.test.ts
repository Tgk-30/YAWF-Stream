import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { FixtureChildren, type FixtureChild } from "./helpers/fixtureChildren.js";
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
// Windows native descriptor checks cross several real filesystem/process phases.
// Preserve the contention gates and every individual child phase deadline.
const NATIVE_PROCESS_TEST_MS = process.platform === "win32" ? CHILD_TIMEOUT_MS * 3 : undefined;

interface LeaseChild {
  child: FixtureChild["child"];
  acquired: Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): { stdout: string; stderr: string };
  releaseLease(): Promise<void>;
  proveAlive(): Promise<void>;
  stop(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children = new FixtureChildren(CHILD_TIMEOUT_MS, 1_000);
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

function spawnLeaseChild(databasePath: string, signal: AbortSignal): LeaseChild {
  // Node's IPC overload loses the fixed first-three stdio types.
  const owned = children.track(spawn(
    process.execPath,
    ["--import", "tsx", CHILD_FIXTURE, databasePath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] },
  ) as FixtureChild["child"], signal);
  const acquired = owned.waitForOutput("acquired\n");
  void acquired.catch(() => {});
  return {
    child: owned.child,
    acquired,
    get exit() { return owned.waitForClose(); },
    output: owned.output,
    releaseLease: () => {
      owned.child.send("release-lease");
      return owned.waitForOutput(`lease-released:${owned.child.pid}\n`);
    },
    proveAlive: () => {
      owned.child.send("ping");
      return owned.waitForOutput(`alive:${owned.child.pid}\n`);
    },
    stop: owned.stop,
  };
}

async function stopChild(
  leaseChild: LeaseChild,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return leaseChild.stop(signal);
}

afterEach(async () => {
  await children.cleanup();
  expect(children.size).toBe(0);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("database lease process lifecycle", () => {
  it("allows exactly one child to win an initially absent-file race", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const contenders = Array.from({ length: 4 }, () => spawnLeaseChild(databasePath, signal));
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

  it("excludes a second child while the owner is live", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const owner = spawnLeaseChild(databasePath, signal);
    await owner.acquired;

    const contender = spawnLeaseChild(databasePath, signal);
    await expect(contender.exit).resolves.toEqual({ code: 73, signal: null });
    expect(contender.output().stderr).toContain("database is already open");
    await stopChild(owner, "SIGTERM");
  });

  it("reacquires after SIGKILL without deleting or rewriting the lease file", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const owner = spawnLeaseChild(databasePath, signal);
    await owner.acquired;
    const before = readFileSync(lockPath);

    await expect(stopChild(owner, "SIGKILL")).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath)).toEqual(before);

    const replacement = spawnLeaseChild(databasePath, signal);
    await replacement.acquired;
    await stopChild(replacement, "SIGTERM");
  }, NATIVE_PROCESS_TEST_MS);

  it("reacquires after actual SIGTERM with platform-correct termination semantics", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const owner = spawnLeaseChild(databasePath, signal);
    await owner.acquired;
    const before = readFileSync(lockPath);

    await expect(stopChild(owner, "SIGTERM")).resolves.toEqual(
      process.platform === "win32"
        ? { code: null, signal: "SIGTERM" }
        : { code: 0, signal: null },
    );
    if (process.platform === "win32") {
      expect(owner.output().stdout).not.toContain("released\n");
    } else {
      expect(owner.output().stdout).toContain("released\n");
    }
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath)).toEqual(before);

    const replacement = spawnLeaseChild(databasePath, signal);
    await replacement.acquired;
    await stopChild(replacement, "SIGTERM");
  }, NATIVE_PROCESS_TEST_MS);

  it("releases through IPC while its actual owner stays alive for successor acquisition", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const owner = spawnLeaseChild(databasePath, signal);
    await owner.acquired;
    const ownerPid = owner.child.pid;
    expect(ownerPid).toBeGreaterThan(0);
    expect(owner.child.connected).toBe(true);
    const before = readFileSync(lockPath);

    await owner.releaseLease();
    expect(readFileSync(lockPath)).toEqual(before);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    expect(owner.child.connected).toBe(true);

    const replacement = spawnLeaseChild(databasePath, signal);
    await replacement.acquired;
    expect(replacement.child.pid).not.toBe(ownerPid);
    await owner.proveAlive();
    expect(owner.child.pid).toBe(ownerPid);
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    expect(owner.child.connected).toBe(true);
    expect(children.size).toBe(2);
    expect(readFileSync(lockPath)).toEqual(before);

    await stopChild(owner, "SIGTERM");
    await stopChild(replacement, "SIGTERM");
  }, NATIVE_PROCESS_TEST_MS);

  it("closes an open-file fixture before the cleanup hook removes its directory", async ({ signal, onTestFinished }) => {
    const path = temporaryDatabasePath();
    const owned = children.track(spawn(process.execPath, ["-e", `
      require("node:fs").openSync(process.argv[1], "w");
      process.stdout.write("file-held\\n");
      setInterval(() => {}, 60_000);
    `, path], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }), signal);
    onTestFinished(async () => {
      try {
        expect(children.size).toBe(0);
        expect(owned.child.signalCode).toBe("SIGKILL");
        await expect(owned.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
      } finally {
        // A failing cleanup mutation must not leave this control's real child alive.
        await owned.dispose();
      }
    });
    await owned.waitForOutput("file-held\n");
    expect(children.size).toBe(1);
    // Leave the actual open descriptor/process to afterEach, not a synthetic exit.
  });

  it("keeps online backup compatible while the application lease is held", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const owner = spawnLeaseChild(databasePath, signal);
    await owner.acquired;
    const backupPath = join(databasePath, "..", "backup.sqlite");

    const backup = await createDatabaseBackup(databasePath, backupPath);
    expect(backup.outputPath).toBe(backupPath);
    expect(backup.pages).toBeGreaterThan(0);
    expect(existsSync(backupPath)).toBe(true);
    await stopChild(owner, "SIGTERM");
  }, NATIVE_PROCESS_TEST_MS);

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
  }, NATIVE_PROCESS_TEST_MS);

  it("does not release the lease when constructor cleanup leaves its database open", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const owned = children.track(spawn(
      process.execPath,
      ["--import", "tsx", CONSTRUCTOR_FAILURE_FIXTURE, databasePath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ), signal);
    const result = await owned.waitForClose();
    const { stdout, stderr } = owned.output();
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("constructor-cleanup-held\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  }, NATIVE_PROCESS_TEST_MS);

  it("retains a failed build database through forced garbage collection", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const owned = children.track(spawn(
      process.execPath,
      ["--expose-gc", "--import", "tsx", BUILD_FAILURE_GC_FIXTURE, databasePath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ), signal);
    const result = await owned.waitForClose();
    const { stdout, stderr } = owned.output();
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("build-cleanup-held-after-gc\n");

    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  }, NATIVE_PROCESS_TEST_MS);

  it("rejects a hot-journal invalid lease without changing forensic bytes", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const journalPath = `${lockPath}-journal`;
    const diagnostics = process.env.YAWF_TEST_LEASE_PHASES === "1";
    const phaseStarted = performance.now();
    const parentPhases = new Set<string>();
    const phase = (name: "spawn-requested" | "ready-observed" | "sigkill-requested" | "close-observed" | "admission-start" | "admission-end") => {
      if (!diagnostics || parentPhases.has(name)) return;
      parentPhases.add(name);
      const elapsed = Math.min(99_999_999, Math.max(0, Math.floor(performance.now() - phaseStarted)));
      process.stdout.write(`lease-phase parent ${name} ${elapsed}\n`);
    };
    const onAbort = () => phase("sigkill-requested");
    signal.addEventListener("abort", onAbort, { once: true });
    phase("spawn-requested");
    const owned = children.track(spawn(
      process.execPath,
      ["--import", "tsx", HOT_JOURNAL_FIXTURE, lockPath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ), signal);
    let closed = false;
    const onClose = () => { closed = true; phase("close-observed"); };
    const childPhases = new Set<string>();
    let line = "";
    let overflow = false;
    const onPhaseData = (chunk: string) => {
      if (!diagnostics || childPhases.size === 6) return;
      for (const character of chunk) {
        if (character === "\n") {
          const match = !overflow && /^lease-phase child (module|open|seed-commit|begin|update|journal-validated-ready) ([0-9]{1,8})$/.exec(line);
          if (match && !childPhases.has(match[1]!)) {
            childPhases.add(match[1]!);
            process.stdout.write(`lease-phase child ${match[1]} ${Number(match[2])}\n`);
          }
          line = "";
          overflow = false;
        } else if (!overflow && line.length < 96) {
          line += character;
        } else {
          line = "";
          overflow = true;
        }
      }
    };
    owned.child.stdout.on("data", onPhaseData);
    owned.child.once("close", onClose);
    try {
      await owned.waitForOutput("hot-journal-ready\n");
      phase("ready-observed");
      phase("sigkill-requested");
      await owned.stop("SIGKILL");

      const databaseBefore = readFileSync(lockPath);
      const journalBefore = readFileSync(journalPath);
      phase("admission-start");
      try {
        expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
      } finally {
        phase("admission-end");
      }
      expect(readFileSync(lockPath).equals(databaseBefore)).toBe(true);
      expect(readFileSync(journalPath).equals(journalBefore)).toBe(true);
    } finally {
      try {
        if (!closed) phase("sigkill-requested");
        await owned.dispose();
      } finally {
        owned.child.stdout.off("data", onPhaseData);
        owned.child.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
      }
    }
  }, NATIVE_PROCESS_TEST_MS);

  it("rejects a foreign WAL lease without creating or changing sidecars", async ({ signal }) => {
    const databasePath = temporaryDatabasePath();
    const lockPath = databaseLockPath(databasePath);
    const originDir = mkdtempSync(join(tmpdir(), "yawf-foreign-wal-origin-"));
    tempDirs.push(originDir);
    const sourcePath = join(originDir, "foreign.sqlite");
    const owned = children.track(spawn(
      process.execPath,
      ["--import", "tsx", FOREIGN_WAL_FIXTURE, sourcePath, lockPath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    ), signal);
    const result = await owned.waitForClose();
    const { stdout, stderr } = owned.output();
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain("foreign-wal-copied\n");

    const before = fileInventory(dirname(lockPath));
    expect(before.map((entry) => entry.name)).toEqual([
      basename(lockPath),
      `${basename(lockPath)}-wal`,
    ]);
    expect(() => acquireDatabaseLease(databasePath)).toThrow(DatabaseLeaseFormatError);
    expect(fileInventory(dirname(lockPath))).toEqual(before);
  }, NATIVE_PROCESS_TEST_MS);
});
