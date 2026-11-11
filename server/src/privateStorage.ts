import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse, resolve } from "node:path";

export class PrivateStorageError extends Error {
  constructor() {
    super("Windows storage privacy could not be verified. Use a private data or backup folder owned by your account and ensure native permission checks are available. Existing permissions and files were not changed.");
    this.name = "PrivateStorageError";
  }
}

type StorageKind = "file" | "directory" | "ancestor";
interface StorageRule {
  sid: string;
  allow: boolean;
  rights: number;
  inheritOnly: boolean;
  objectInherit: boolean;
  containerInherit: boolean;
  noPropagate: boolean;
}
export interface WindowsStorageDescriptor {
  kind: StorageKind;
  currentSid: string;
  ownerSid: string;
  trustedInstallerSid: string | null;
  directory: boolean;
  reparse: boolean;
  daclPresent: boolean;
  daclNull: boolean;
  rawAceTypes: number[];
  rules: StorageRule[];
}

// The data boundary admits only this user and the two privileged Windows
// principals. TrustedInstaller is an OS-ancestor exception, never a data grant.
export function windowsStorageDescriptorIsPrivate(value: WindowsStorageDescriptor): boolean {
  const trusted = new Set([value.currentSid, "S-1-5-18", "S-1-5-32-544"]);
  if (!["file", "directory", "ancestor"].includes(value.kind) ||
      !/^S-1-\d+(?:-\d+)+$/.test(value.currentSid) || !Array.isArray(value.rules) ||
      value.rules.length === 0 || value.rules.length > 256 || value.reparse ||
      !Array.isArray(value.rawAceTypes) || value.rawAceTypes.length !== value.rules.length ||
      value.rawAceTypes.some(type => type !== 0 && type !== 1) ||
      value.daclPresent !== true || value.daclNull !== false ||
      (value.kind === "file" ? value.directory !== false : value.directory !== true)) return false;
  if (value.kind === "ancestor" && value.trustedInstallerSid != null) trusted.add(value.trustedInstallerSid);
  if (!trusted.has(value.ownerSid)) return false;
  let fileInheritance = false;
  let directoryInheritance = false;
  for (const [index, rule] of value.rules.entries()) {
    if (typeof rule.sid !== "string" || typeof rule.allow !== "boolean" ||
        !Number.isSafeInteger(rule.rights) || rule.rights < 0 || rule.rights > 0xffffffff ||
        [rule.inheritOnly, rule.objectInherit, rule.containerInherit, rule.noPropagate].some(flag => typeof flag !== "boolean")) return false;
    if (rule.allow !== (value.rawAceTypes[index] === 0)) return false;
    if (!rule.allow || rule.rights === 0) continue;
    const creator = rule.sid === "S-1-3-0" && rule.inheritOnly;
    if (value.kind === "ancestor") {
      // Public ancestor traversal is normal. Untrusted deletion of children or
      // ACL/owner changes could instead replace the private path underneath us.
      if (!rule.inheritOnly && !trusted.has(rule.sid) && (rule.rights & 0x100d0040) !== 0) return false;
      continue;
    }
    if (value.kind === "file" && rule.inheritOnly) continue;
    if (!trusted.has(rule.sid) && !creator) return false;
    const read = (rule.rights & 1) !== 0 || (rule.rights & 0x90000000) !== 0;
    const write = (rule.rights & 2) !== 0 || (rule.rights & 0x50000000) !== 0;
    if (read && write && !rule.noPropagate) {
      fileInheritance ||= rule.objectInherit;
      directoryInheritance ||= rule.containerInherit;
    }
  }
  return value.kind !== "directory" || (fileInheritance && directoryInheritance);
}

// Production bundles receive this literal at build time. Source development
// uses only the fixed module-relative preparation directory, never PATH or CWD.
declare const __YAWF_WINDOWS_STORAGE_BINDING__: unknown;
const OBSERVER_PROTOCOL = "yawf-windows-storage-descriptor-v1";
const OBSERVER_EXE = "StorageDescriptorObserver.exe";
const REFERENCE_NAMES = ["mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.Extensions.dll"];
interface ObserverBinding {
  schemaVersion: 1; protocol: string; sourceSha256: string; compilerSha256: string;
  frameworkTarget: string; referenceSha256: Record<string, string>;
  unsignedHelperSha256: string; helperSha256: string; helperSize: number;
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function observerBinding(value: unknown): ObserverBinding {
  const digest = (hash: unknown) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
  if (!exactKeys(value, ["schemaVersion", "protocol", "sourceSha256", "compilerSha256", "frameworkTarget",
    "referenceSha256", "unsignedHelperSha256", "helperSha256", "helperSize"]) || value.schemaVersion !== 1 ||
    value.protocol !== OBSERVER_PROTOCOL || value.frameworkTarget !== ".NETFramework,Version=v4.8" ||
    ![value.sourceSha256, value.compilerSha256, value.unsignedHelperSha256, value.helperSha256].every(digest) ||
    !exactKeys(value.referenceSha256, REFERENCE_NAMES) || !Object.values(value.referenceSha256).every(digest) ||
    !Number.isSafeInteger(value.helperSize) || (value.helperSize as number) < 1 || (value.helperSize as number) > 2_000_000) throw new PrivateStorageError();
  return value as unknown as ObserverBinding;
}
function unredirected(path: string): void {
  const absolute = resolve(path);
  for (let current = absolute; ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new PrivateStorageError();
    if (current === parse(current).root) break;
  }
  if (realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) throw new PrivateStorageError();
}
function observerFile(path: string, limit: number): Buffer {
  unredirected(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new PrivateStorageError();
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new PrivateStorageError();
  return bytes;
}
function verifiedObserver(): string {
  let directory: string;
  let expected: ObserverBinding;
  if (typeof __YAWF_WINDOWS_STORAGE_BINDING__ !== "undefined") {
    // A non-Windows bundle cannot fall back to a mutable development manifest.
    expected = observerBinding(__YAWF_WINDOWS_STORAGE_BINDING__);
    directory = join(__dirname, "windows-storage-observer");
  } else {
    directory = fileURLToPath(new URL("../.build/windows-storage-observer/runtime/", import.meta.url));
    expected = observerBinding(JSON.parse(observerFile(join(directory, "binding.json"), 16_000).toString("utf8")));
    const source = fileURLToPath(new URL("../native/windows/StorageDescriptorObserver.cs", import.meta.url));
    if (createHash("sha256").update(observerFile(source, 64_000)).digest("hex") !== expected.sourceSha256) throw new PrivateStorageError();
  }
  unredirected(directory);
  if (readdirSync(directory).sort().join("\0") !== [OBSERVER_EXE, "binding.json"].sort().join("\0")) throw new PrivateStorageError();
  const disk = observerBinding(JSON.parse(observerFile(join(directory, "binding.json"), 16_000).toString("utf8")));
  if (JSON.stringify(disk) !== JSON.stringify(expected)) throw new PrivateStorageError();
  const executable = join(directory, OBSERVER_EXE);
  const bytes = observerFile(executable, 2_000_000);
  if (bytes.length !== expected.helperSize || createHash("sha256").update(bytes).digest("hex") !== expected.helperSha256) throw new PrivateStorageError();
  return executable;
}

/** Validate existing artifacts and the private ancestor from which a new
 * artifact would inherit its DACL. No cache: permissions can change at runtime. */
export function assertPrivateWindowsStorage(paths: readonly string[]): void {
  if (process.platform !== "win32") return;
  try {
    if (paths.length === 0 || paths.length > 16) throw new PrivateStorageError();
    const entries = new Map<string, { path: string; kind: StorageKind }>();
    const add = (path: string, kind: StorageKind) => {
      const existing = entries.get(path.toLowerCase());
      if (existing == null || existing.kind === "ancestor") entries.set(path.toLowerCase(), { path, kind });
    };
    const inspect = (path: string) => {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new PrivateStorageError();
        return stat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    for (const input of paths) {
      if (typeof input !== "string" || input.includes("\0") || input.length > 4096) throw new PrivateStorageError();
      const path = resolve(input);
      if (path.slice(parse(path).root.length).includes(":")) throw new PrivateStorageError();
      if (inspect(path) != null) add(path, "file");
      let parent = dirname(path);
      while (inspect(parent) == null) {
        const next = dirname(parent);
        if (next === parent) throw new PrivateStorageError();
        parent = next;
      }
      add(parent, "directory");
      for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
        if (inspect(ancestor) == null) throw new PrivateStorageError();
        add(ancestor, "ancestor");
        if (dirname(ancestor) === ancestor) break;
      }
    }
    const requests = [...entries.values()].map((entry, id) => ({ ...entry, id }));
    const executable = verifiedObserver();
    const osEnvironment = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE",
      "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LOCALAPPDATA", "APPDATA"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => osEnvironment.has(key.toUpperCase()))
      .map(([key, value]) => [key.toUpperCase(), value]));
    const output = execFileSync(executable, [], {
      input: JSON.stringify({ protocol: OBSERVER_PROTOCOL, entries: requests }), encoding: "utf8", env, timeout: 7000, maxBuffer: 256_000, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (Buffer.byteLength(output, "utf8") > 256_000) throw new PrivateStorageError();
    const response: unknown = JSON.parse(output.replace(/^\uFEFF/, "").trim());
    if (!exactKeys(response, ["protocol", "descriptors"]) || response.protocol !== OBSERVER_PROTOCOL) throw new PrivateStorageError();
    const descriptors = response.descriptors as Array<WindowsStorageDescriptor & { id: number }>;
    if (!Array.isArray(descriptors) || descriptors.length !== requests.length || descriptors.some((value, id) =>
      value.id !== id || value.kind !== requests[id]!.kind || !windowsStorageDescriptorIsPrivate(value))) throw new PrivateStorageError();
  } catch {
    // Native command errors contain local paths. Neither descriptors, stdin,
    // stdout nor stderr are attached to a public error or diagnostic record.
    throw new PrivateStorageError();
  }
}
