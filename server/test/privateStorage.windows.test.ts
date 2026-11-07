import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { acquireDatabaseLease, AppDatabase, createPreUpgradeSnapshotIfNeeded, databaseLockPath } from "../src/db.js";
import { assertPrivateWindowsStorage, PrivateStorageError } from "../src/privateStorage.js";
import { createDatabaseBackup, restoreDatabaseBackup } from "../src/recovery.js";
import { createLegacyServerFixture } from "./fixtures/migrationFixtures.js";

const fixtureScript = fileURLToPath(new URL("../../scripts/windows_storage_acl_test_fixture.ps1", import.meta.url));

describe.skipIf(process.platform !== "win32")("native Windows private storage", () => {
  let root = "";
  beforeEach(() => {
    root = "";
    if (process.env.DS_SERVER_SECRET_KEY) throw new Error("Disposable tests must not inherit an external server credential.");
    root = mkdtempSync(join(tmpdir(), "yawf-win-storage-audit-"));
    writeFileSync(join(root, ".audit-owner"), "YAWF disposable storage audit");
  });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  function fixture(input: object, mode = "inspect"): Array<{ artifact: string; structurallyPrivate: boolean }> {
    const inventory = join(root, "inventory.json");
    writeFileSync(inventory, JSON.stringify({ root, ...input }));
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
    env.PSModulePath = join(dirname(executable), "Modules");
    return JSON.parse(execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fixtureScript,
      "-InputPath", inventory, "-Mode", mode], { encoding: "utf8", env, timeout: 20_000, windowsHide: true }).replace(/^\uFEFF/, "").trim());
  }
  function parent(name: string, mode = "private-test-parent"): string {
    const path = join(root, name); mkdirSync(path); fixture({ path }, mode); return path;
  }
  function inventory(path: string): unknown {
    return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
      name: entry.name,
      bytes: entry.isDirectory() ? inventory(join(path, entry.name)) : createHash("sha256").update(readFileSync(join(path, entry.name))).digest("hex"),
    }));
  }
  function expectUnchanged(path: string, action: () => unknown): void {
    const before = inventory(path);
    expect(action).toThrow(PrivateStorageError);
    expect(inventory(path)).toEqual(before);
  }

  it("boots and independently verifies key, DB, lease, WAL, SHM, snapshot and online backup DACLs", async () => {
    const data = parent("private"); const path = join(data, "database.sqlite");
    const config = loadConfig({ dataDir: data });
    createLegacyServerFixture(path, 7);
    const db = new AppDatabase(path);
    try {
      db.sqlite.exec("CREATE TABLE storage_probe(value INTEGER); INSERT INTO storage_probe VALUES(1);");
      const snapshots = readdirSync(join(data, "backups"));
      expect(snapshots).toHaveLength(1);
      const output = join(data, "backups", "manual.sqlite");
      await createDatabaseBackup(path, output);
      const files = [
        { artifact: "key", path: join(data, "server.key") }, { artifact: "database", path },
        { artifact: "lease", path: databaseLockPath(path) }, { artifact: "wal", path: path + "-wal" },
        { artifact: "shm", path: path + "-shm" }, { artifact: "snapshot", path: join(data, "backups", snapshots[0]!) },
        { artifact: "backup", path: output },
      ];
      expect(files.every(file => existsSync(file.path))).toBe(true);
      assertPrivateWindowsStorage(files.map(file => file.path));
      const observed = fixture({ files });
      expect(observed.map(file => file.artifact).sort()).toEqual(files.map(file => file.artifact).sort());
      expect(observed.every(file => file.structurallyPrivate)).toBe(true);
      expect(config.secretKey.equals(loadConfig({ dataDir: data }).secretKey)).toBe(true);
    } finally { db.close(); }
  }, 30_000);

  it.each(["key", "database", "lease"])("rejects permissive parent before creating a %s or its sidecars", (kind) => {
    const data = parent("public", "permissive-test-parent"); const path = join(data, "database.sqlite");
    expectUnchanged(data, () => kind === "key" ? loadConfig({ dataDir: data }) : kind === "database" ? new AppDatabase(path) : acquireDatabaseLease(path));
    expect(readdirSync(data)).toEqual([]);
  }, 30_000);

  it("rejects an unsafe existing key without replacing or normalizing its bytes", () => {
    const data = parent("private"); loadConfig({ dataDir: data });
    fixture({ path: join(data, "server.key") }, "public-test-file");
    expectUnchanged(data, () => loadConfig({ dataDir: data }));
  }, 30_000);

  it.each(["database", "lease", "wal", "shm"])("rejects an unsafe existing %s before touching any database artifact", (kind) => {
    const data = parent("private"); const path = join(data, "database.sqlite"); new AppDatabase(path).close();
    const file = kind === "database" ? path : kind === "lease" ? databaseLockPath(path) : `${path}-${kind}`;
    if (!existsSync(file)) writeFileSync(file, Buffer.alloc(0));
    fixture({ path: file }, "public-test-file");
    expectUnchanged(data, () => new AppDatabase(path));
  }, 30_000);

  it.each(["constructor", "direct snapshot"])("rejects an unsafe snapshot folder through %s before forensic bytes change", (kind) => {
    const data = parent("private"); const path = join(data, "database.sqlite");
    createLegacyServerFixture(path, 7);
    const backups = join(data, "backups"); mkdirSync(backups); fixture({ path: backups }, "permissive-test-parent");
    if (kind === "constructor") expectUnchanged(data, () => new AppDatabase(path));
    else {
      const db = new DatabaseSync(path);
      try { expectUnchanged(data, () => createPreUpgradeSnapshotIfNeeded(db, path)); } finally { db.close(); }
    }
  }, 30_000);

  it("rejects unsafe backup output before a file is written or source bytes change", async () => {
    const data = parent("private"); const path = join(data, "database.sqlite"); new AppDatabase(path).close();
    const target = parent("public", "permissive-test-parent"); const before = inventory(data);
    await expect(createDatabaseBackup(path, join(target, "backup.sqlite"))).rejects.toBeInstanceOf(PrivateStorageError);
    expect(readdirSync(target)).toEqual([]); expect(inventory(data)).toEqual(before);
  }, 30_000);

  it("rejects unsafe restore destination without displacing existing forensic bytes", async () => {
    const data = parent("private"); const input = join(data, "backup.sqlite"); new AppDatabase(input).close();
    const target = parent("public", "permissive-test-parent"); const path = join(target, "database.sqlite");
    createLegacyServerFixture(path, 7); const before = inventory(target);
    await expect(restoreDatabaseBackup(path, input)).rejects.toBeInstanceOf(PrivateStorageError);
    expect(inventory(target)).toEqual(before);
  }, 30_000);

  it("imports a broadly readable legacy backup without copying its ACL to the private restore", async () => {
    const source = parent("source"); const input = join(source, "backup.sqlite"); new AppDatabase(input).close();
    fixture({ path: input }, "public-test-file");
    const data = parent("private-target"); const output = join(data, "database.sqlite");
    await restoreDatabaseBackup(output, input);
    const observed = fixture({ files: [{ artifact: "restored-database", path: output }] });
    expect(observed).toHaveLength(1); expect(observed[0]!.structurallyPrivate).toBe(true);
    new AppDatabase(output).close();
  }, 30_000);

  it("rejects a junction before writing through it", () => {
    const target = parent("private"); const link = join(root, "junction"); symlinkSync(target, link, "junction");
    expectUnchanged(target, () => new AppDatabase(join(link, "database.sqlite")));
  }, 30_000);

  it("rejects replaceable ancestors even when the immediate data folder is private", () => {
    const outer = parent("replaceable", "writable-test-parent"); const data = join(outer, "private"); mkdirSync(data);
    fixture({ path: data }, "private-test-parent");
    expectUnchanged(data, () => new AppDatabase(join(data, "database.sqlite")));
  }, 30_000);

  it("allows a protected private child beneath a read-only public ancestor", () => {
    const outer = parent("read-only-public", "permissive-test-parent"); const data = join(outer, "private"); mkdirSync(data);
    fixture({ path: data }, "private-test-parent");
    new AppDatabase(join(data, "database.sqlite")).close();
  }, 30_000);

  it("passes Unicode and shell-looking folder names as data rather than commands", () => {
    const data = parent("private ' ü & $(Get-Date)");
    new AppDatabase(join(data, "database.sqlite")).close();
    expect(existsSync(join(data, "database.sqlite"))).toBe(true);
  }, 30_000);

  it("does not let the ACL test fixture change a foreign file through a nested junction", () => {
    const foreign = mkdtempSync(join(tmpdir(), "yawf-foreign-acl-target-"));
    try {
      const path = join(foreign, "dummy.txt"); writeFileSync(path, "disposable scope control");
      const link = join(root, "foreign-junction"); symlinkSync(foreign, link, "junction");
      expect(() => fixture({ path: join(link, "dummy.txt") }, "public-test-file")).toThrow(/reparse point/);
      assertPrivateWindowsStorage([path]);
      expect(readFileSync(path, "utf8")).toBe("disposable scope control");
    } finally { rmSync(foreign, { recursive: true, force: true }); }
  }, 30_000);
});
