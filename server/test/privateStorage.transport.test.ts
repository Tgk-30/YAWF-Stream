import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as storageFs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPrivateWindowsStorage, PrivateStorageError } from "../src/privateStorage.js";

const mocked = vi.hoisted(() => ({ files: new Map<string, Buffer>(), dirs: new Set<string>(), redirected: new Set<string>(),
  sidecars: [] as string[], exec: vi.fn(), realpath: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocked.exec }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    lstatSync(path: string, ...args: unknown[]) {
      const key = resolve(String(path));
      if (mocked.files.has(key) || mocked.dirs.has(key)) return { isSymbolicLink: () => mocked.redirected.has(key),
        isFile: () => mocked.files.has(key), isDirectory: () => mocked.dirs.has(key), size: mocked.files.get(key)?.length ?? 0 };
      return fs.lstatSync(path, ...(args as []));
    },
    readFileSync(path: string, ...args: unknown[]) {
      const bytes = mocked.files.get(resolve(String(path)));
      return bytes == null ? fs.readFileSync(path, ...(args as [])) : bytes;
    },
    readdirSync(path: string, ...args: unknown[]) {
      return mocked.dirs.has(resolve(String(path))) ? ["StorageDescriptorObserver.exe", "binding.json", ...mocked.sidecars]
        : fs.readdirSync(path, ...(args as []));
    },
    realpathSync: Object.assign((path: string) => fs.realpathSync(path), { native(path: string) {
      const key = resolve(String(path));
      return mocked.files.has(key) || mocked.dirs.has(key) ? mocked.realpath(key) : fs.realpathSync.native(path);
    } }),
  };
});

const source = fileURLToPath(new URL("../native/windows/StorageDescriptorObserver.cs", import.meta.url));
const runtime = fileURLToPath(new URL("../.build/windows-storage-observer/runtime", import.meta.url));
const exe = join(runtime, "StorageDescriptorObserver.exe");
const manifest = join(runtime, "binding.json");
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const protocol = "yawf-windows-storage-descriptor-v1";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
let path: string;
let binding: Record<string, unknown>;
function descriptors(entries: Array<{ id: number; kind: string }>) {
  return entries.map(({ id, kind }) => ({ id, kind, currentSid: "S-1-5-21-123-456-789-1001", ownerSid: "S-1-5-21-123-456-789-1001",
    trustedInstallerSid: null, directory: kind !== "file", reparse: false, daclPresent: true, daclNull: false, rawAceTypes: [0],
    rules: [{ sid: "S-1-5-21-123-456-789-1001", allow: true, rights: 0x1f01ff, inheritOnly: false,
      objectInherit: true, containerInherit: true, noPropagate: false }] }));
}
function respond(change: (values: ReturnType<typeof descriptors>) => unknown = values => values) {
  mocked.exec.mockImplementation((_file, _args, options) => JSON.stringify({ protocol,
    descriptors: change(descriptors(JSON.parse(options.input).entries)) }));
}
function privateFailure(action = () => assertPrivateWindowsStorage([path]), separateRealm = false) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  if (separateRealm) expect(failure).toHaveProperty("name", "PrivateStorageError");
  else expect(failure).toBeInstanceOf(PrivateStorageError);
  expect(String(failure)).not.toContain("raw-private-output");
  expect(failure).not.toHaveProperty("cause");
}
function production(bindingValue: unknown) {
  const directory = join(runtime, "..", "bundle");
  const sourceText = readFileSync(fileURLToPath(new URL("../src/privateStorage.ts", import.meta.url)), "utf8");
  const code = transformSync(sourceText, { loader: "ts", format: "cjs", define: {
    __YAWF_WINDOWS_STORAGE_BINDING__: JSON.stringify(bindingValue), "import.meta.url": "undefined" } }).code;
  const module = { exports: {} as { assertPrivateWindowsStorage(paths: string[]): void } };
  const require = createRequire(import.meta.url);
  vm.runInNewContext(code, { module, exports: module.exports, __dirname: directory, Buffer, URL,
    process: { platform: "win32", env: process.env },
    require(name: string) { return name === "node:fs" ? storageFs : name === "node:child_process" ? { execFileSync: mocked.exec } : require(name); } }, { timeout: 1000 });
  return () => module.exports.assertPrivateWindowsStorage([path]);
}

beforeEach(() => {
  vi.unstubAllGlobals(); mocked.files.clear(); mocked.dirs.clear(); mocked.redirected.clear(); mocked.sidecars = [];
  mocked.exec.mockReset(); mocked.realpath.mockReset().mockImplementation(value => value);
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  root = mkdtempSync(join(tmpdir(), "yawf-storage-transport-")); path = join(root, "private ' ü & $(not-a-command).sqlite"); writeFileSync(path, "unchanged forensic fixture");
  const bytes = Buffer.from("fixed test helper, never executed");
  binding = { schemaVersion: 1, protocol, sourceSha256: digest(readFileSync(source)), compilerSha256: "a".repeat(64),
    frameworkTarget: ".NETFramework,Version=v4.8", referenceSha256: Object.fromEntries(["mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(name => [name, "b".repeat(64)])),
    unsignedHelperSha256: digest(bytes), helperSha256: digest(bytes), helperSize: bytes.length };
  mocked.files.set(exe, bytes); mocked.files.set(manifest, Buffer.from(JSON.stringify(binding)));
  for (let dir = runtime; dir !== dirname(dir); dir = dirname(dir)) mocked.dirs.add(dir);
  respond();
});
afterEach(() => { Object.defineProperty(process, "platform", originalPlatform); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe("fixed Windows descriptor transport", () => {
  it("executes the fixed verified helper with JSON-only stdin and unchanged native budgets", () => {
    vi.stubEnv("NODE_OPTIONS", "raw-private-output"); vi.stubEnv("PATH", "raw-private-output");
    try { assertPrivateWindowsStorage([path]); } finally { vi.unstubAllEnvs(); }
    const [file, args, options] = mocked.exec.mock.calls[0]!;
    expect(file).toBe(exe); expect(args).toEqual([]);
    expect(options).toMatchObject({ timeout: 7000, maxBuffer: 256_000, windowsHide: true, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    expect(options.env).not.toHaveProperty("NODE_OPTIONS"); expect(options.env).not.toHaveProperty("PATH");
    const request = JSON.parse(options.input); expect(request.protocol).toBe(protocol);
    expect(request.entries[0]).toEqual({ path, kind: "file", id: 0 });
    expect(request.entries.some((entry: { kind: string }) => entry.kind === "ancestor")).toBe(true);
  });

  it("does not require preparation or execute anything on non-Windows", () => {
    mocked.files.clear(); Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    assertPrivateWindowsStorage([path]); expect(mocked.exec).not.toHaveBeenCalled();
  });

  it("reads privacy anew after a same-process permission change without changing forensic bytes", () => {
    assertPrivateWindowsStorage([path]);
    respond(values => { values[0]!.ownerSid = "S-1-1-0"; return values; });
    privateFailure(); expect(mocked.exec).toHaveBeenCalledTimes(2);
    expect(digest(readFileSync(path))).toBe(digest("unchanged forensic fixture"));
  });

  it("fails clearly before execution when development preparation is absent", () => {
    mocked.files.delete(manifest); privateFailure(); expect(mocked.exec).not.toHaveBeenCalled();
  });

  it("rejects changed source provenance before execution", () => {
    mocked.files.set(source, Buffer.from("changed source")); privateFailure(); expect(mocked.exec).not.toHaveBeenCalled();
  });

  it("rehashes helper bytes on every call and refuses tampering", () => {
    assertPrivateWindowsStorage([path]); mocked.files.set(exe, Buffer.from("tampered helper"));
    privateFailure(); expect(mocked.exec).toHaveBeenCalledTimes(1);
  });

  it("refuses loader sidecars before executing even an otherwise correct helper", () => {
    for (const name of ["StorageDescriptorObserver.exe.config", "System.Web.Extensions.dll", "StorageDescriptorObserver.exe.local"]) {
      mocked.sidecars = [name]; privateFailure();
    }
    expect(mocked.exec).not.toHaveBeenCalled();
  });

  it("refuses reparse indirection in helper files and ancestor directories", () => {
    for (const target of [exe, runtime, dirname(runtime)]) {
      mocked.redirected.add(target); privateFailure(); mocked.redirected.delete(target);
    }
    mocked.realpath.mockImplementation(value => value + "-redirected"); privateFailure();
    expect(mocked.exec).not.toHaveBeenCalled();
  });

  it("rejects malformed protocol and count, ID or kind mismatches", () => {
    for (const invalid of ["not-json", "null", JSON.stringify({ protocol: "other", descriptors: [] }),
      JSON.stringify({ protocol, descriptors: [], extra: true })]) {
      mocked.exec.mockReturnValue(invalid); privateFailure();
    }
    for (const metadata of [{ protocol: "other" }, { protocol, extra: true }]) {
      mocked.exec.mockImplementation((_file, _args, options) => JSON.stringify({ ...metadata, descriptors: descriptors(JSON.parse(options.input).entries) }));
      privateFailure();
    }
    for (const change of [(values: ReturnType<typeof descriptors>) => values.slice(1),
      (values: ReturnType<typeof descriptors>) => { values[0]!.id = 99; return values; },
      (values: ReturnType<typeof descriptors>) => { values[0]!.kind = "ancestor"; return values; }]) { respond(change); privateFailure(); }
  });

  it("rejects oversized output independently of child-process enforcement", () => {
    mocked.exec.mockImplementation((_file, _args, options) => " ".repeat(256_001) + JSON.stringify({ protocol,
      descriptors: descriptors(JSON.parse(options.input).entries) }));
    privateFailure();
  });

  it("sanitizes native nonzero, timeout and buffer-limit failures without touching files", () => {
    for (const code of [1, "ETIMEDOUT", "ENOBUFS"]) {
      mocked.exec.mockImplementation(() => { throw Object.assign(Error("raw-private-output"), { code, stdout: "raw-private-output", stderr: "raw-private-output" }); });
      privateFailure(); expect(digest(readFileSync(path))).toBe(digest("unchanged forensic fixture"));
    }
  });

  it("production binding refuses a replacement helper even when its manifest is also replaced", () => {
    const run = production(binding);
    const directory = join(runtime, "..", "bundle", "windows-storage-observer"); mocked.dirs.add(directory);
    mocked.dirs.add(dirname(directory));
    mocked.files.set(join(directory, "binding.json"), Buffer.from(JSON.stringify(binding)));
    mocked.files.set(join(directory, "StorageDescriptorObserver.exe"), mocked.files.get(exe)!);
    run();
    const alteredMetadata = { ...binding, sourceSha256: "c".repeat(64) };
    mocked.files.set(join(directory, "binding.json"), Buffer.from(JSON.stringify(alteredMetadata)));
    privateFailure(run, true);
    const replacement = Buffer.from("replacement helper"); const changed = { ...binding, helperSha256: digest(replacement), helperSize: replacement.length };
    mocked.files.set(join(directory, "binding.json"), Buffer.from(JSON.stringify(changed)));
    mocked.files.set(join(directory, "StorageDescriptorObserver.exe"), replacement);
    privateFailure(run, true); expect(mocked.exec).toHaveBeenCalledTimes(1);
  });

  it("a non-Windows production bundle cannot use the development manifest as fallback", () => {
    const run = production(null);
    expect(run).toThrow("Windows storage privacy could not be verified"); expect(mocked.exec).not.toHaveBeenCalled();
  });
});
