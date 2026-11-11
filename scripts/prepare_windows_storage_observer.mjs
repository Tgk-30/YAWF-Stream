#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STORAGE_OBSERVER_PROTOCOL = "yawf-windows-storage-descriptor-v1";
export const STORAGE_OBSERVER_EXE = "StorageDescriptorObserver.exe";
export const STORAGE_OBSERVER_FRAMEWORK = ".NETFramework,Version=v4.8";
export const STORAGE_OBSERVER_COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
export const STORAGE_OBSERVER_REFERENCES = "C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8";
export const REFERENCE_NAMES = ["mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.Extensions.dll"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HASH = /^[0-9a-f]{64}$/;
const fail = () => { throw new Error("Windows storage observer preparation is missing, invalid or unavailable. Explicit compile and hash-pinned bind are required."); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (object, keys) => object != null && typeof object === "object" && !Array.isArray(object)
  && Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");

export function requireUnredirected(path) {
  const absolute = resolve(path);
  for (let current = absolute; ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) fail();
    if (current === parse(current).root) break;
  }
  if (realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) fail();
}

export function readObserverFile(path, limit) {
  requireUnredirected(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit) fail();
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) fail();
  return bytes;
}

export function validateObserverBinding(value) {
  if (!exact(value, ["schemaVersion", "protocol", "sourceSha256", "compilerSha256", "frameworkTarget",
    "referenceSha256", "unsignedHelperSha256", "helperSha256", "helperSize"]) || value.schemaVersion !== 1
    || value.protocol !== STORAGE_OBSERVER_PROTOCOL || value.frameworkTarget !== STORAGE_OBSERVER_FRAMEWORK
    || ![value.sourceSha256, value.compilerSha256, value.unsignedHelperSha256, value.helperSha256].every(x => typeof x === "string" && HASH.test(x))
    || !exact(value.referenceSha256, REFERENCE_NAMES) || !Object.values(value.referenceSha256).every(x => typeof x === "string" && HASH.test(x))
    || !Number.isSafeInteger(value.helperSize) || value.helperSize < 1 || value.helperSize > 2_000_000) fail();
  return value;
}

function paths(root) {
  const base = join(root, "server", ".build", "windows-storage-observer");
  return { base, source: join(root, "server", "native", "windows", "StorageDescriptorObserver.cs"),
    unsigned: join(base, "unsigned"), runtime: join(base, "runtime"), metadata: join(base, "compile.json") };
}

export function verifyObserverDirectory(directory, expected) {
  const binding = validateObserverBinding(expected);
  requireUnredirected(directory);
  if (readdirSync(directory).sort().join("\0") !== [STORAGE_OBSERVER_EXE, "binding.json"].sort().join("\0")) fail();
  const disk = validateObserverBinding(JSON.parse(readObserverFile(join(directory, "binding.json"), 16_000).toString("utf8")));
  if (JSON.stringify(disk) !== JSON.stringify(binding)) fail();
  const binary = readObserverFile(join(directory, STORAGE_OBSERVER_EXE), 2_000_000);
  if (binary.length !== binding.helperSize || hash(binary) !== binding.helperSha256) fail();
  return binding;
}

export function preparedObserver(root = ROOT) {
  const p = paths(root);
  const binding = validateObserverBinding(JSON.parse(readObserverFile(join(p.runtime, "binding.json"), 16_000).toString("utf8")));
  if (binding.sourceSha256 !== hash(readObserverFile(p.source, 64_000))) fail();
  verifyObserverDirectory(p.runtime, binding);
  return { binding, directory: p.runtime };
}

export function compileWindowsStorageObserver({ root = ROOT, platform = process.platform, run = execFileSync, read = readObserverFile } = {}) {
  if (platform !== "win32") fail();
  const p = paths(root);
  if (existsSync(p.base)) fail();
  const source = readObserverFile(p.source, 64_000);
  const compiler = read(STORAGE_OBSERVER_COMPILER, 32_000_000);
  const referenceSha256 = Object.fromEntries(REFERENCE_NAMES.map(name => [name,
    hash(read(join(STORAGE_OBSERVER_REFERENCES, name), 32_000_000))]));
  let parent = dirname(p.base);
  while (!existsSync(parent)) parent = dirname(parent);
  requireUnredirected(parent);
  mkdirSync(p.unsigned, { recursive: true });
  try {
    const executable = join(p.unsigned, STORAGE_OBSERVER_EXE);
    run(STORAGE_OBSERVER_COMPILER, ["/nologo", "/noconfig", "/nostdlib+", "/target:exe", "/platform:anycpu", "/optimize+", "/debug-", "/warnaserror+",
      `/out:${executable}`, ...REFERENCE_NAMES.map(name => `/reference:${join(STORAGE_OBSERVER_REFERENCES, name)}`), p.source],
    { timeout: 60_000, maxBuffer: 256_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (readdirSync(p.unsigned).join("\0") !== STORAGE_OBSERVER_EXE) fail();
    const binary = readObserverFile(executable, 2_000_000);
    const binding = validateObserverBinding({ schemaVersion: 1, protocol: STORAGE_OBSERVER_PROTOCOL,
      sourceSha256: hash(source), compilerSha256: hash(compiler), frameworkTarget: STORAGE_OBSERVER_FRAMEWORK,
      referenceSha256, unsignedHelperSha256: hash(binary), helperSha256: hash(binary), helperSize: binary.length });
    writeFileSync(p.metadata, JSON.stringify(binding, null, 2) + "\n", { flag: "wx" });
    return binding;
  } catch {
    rmSync(p.base, { recursive: true, force: true });
    fail();
  }
}

export function bindWindowsStorageObserver(operatorSha256, { root = ROOT } = {}) {
  if (typeof operatorSha256 !== "string" || !HASH.test(operatorSha256)) fail();
  const p = paths(root);
  if (existsSync(p.runtime)) fail();
  const compiled = validateObserverBinding(JSON.parse(readObserverFile(p.metadata, 16_000).toString("utf8")));
  if (compiled.sourceSha256 !== hash(readObserverFile(p.source, 64_000))) fail();
  requireUnredirected(p.unsigned);
  if (readdirSync(p.unsigned).join("\0") !== STORAGE_OBSERVER_EXE) fail();
  const binary = readObserverFile(join(p.unsigned, STORAGE_OBSERVER_EXE), 2_000_000);
  if (hash(binary) !== operatorSha256) fail();
  const binding = validateObserverBinding({ ...compiled, helperSha256: operatorSha256, helperSize: binary.length });
  mkdirSync(p.runtime);
  try {
    writeFileSync(join(p.runtime, STORAGE_OBSERVER_EXE), binary, { flag: "wx" });
    writeFileSync(join(p.runtime, "binding.json"), JSON.stringify(binding, null, 2) + "\n", { flag: "wx" });
    verifyObserverDirectory(p.runtime, binding);
    return binding;
  } catch {
    rmSync(p.runtime, { recursive: true, force: true });
    fail();
  }
}

export function copyObserverDirectory(source, destination, binding) {
  verifyObserverDirectory(source, binding);
  if (existsSync(destination)) fail();
  mkdirSync(destination, { recursive: true });
  for (const name of [STORAGE_OBSERVER_EXE, "binding.json"]) copyFileSync(join(source, name), join(destination, name), constants.COPYFILE_EXCL);
  verifyObserverDirectory(destination, binding);
}

export function bundledObserverBinding(entry) {
  const source = readObserverFile(entry, 32_000_000).toString("utf8");
  const matches = [...source.matchAll(/^\/\* YAWF_WINDOWS_STORAGE_BINDING:(.+) \*\/$/gm)];
  if (matches.length !== 1) fail();
  const binding = JSON.parse(matches[0][1]);
  return binding === null ? null : validateObserverBinding(binding);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "compile") compileWindowsStorageObserver();
    else if (args.length === 3 && args[0] === "bind" && args[1] === "--sha256") bindWindowsStorageObserver(args[2]);
    else if (args.length === 1 && args[0] === "verify") preparedObserver();
    else fail();
    console.log("Windows storage observer preparation verified.");
  } catch {
    console.error("Windows storage observer preparation failed. Check the documented compile and hash-pinned bind prerequisites.");
    process.exitCode = 1;
  }
}
