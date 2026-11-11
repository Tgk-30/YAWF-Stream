#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledObserverBinding, preparedObserver, requireUnredirected, validateObserverBinding,
  verifyObserverDirectory } from "../prepare_windows_storage_observer.mjs";

export const PACKET_LIMITS = { files: 256, bytes: 64 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, manifestBytes: 64 * 1024 };
const TREES = ["server/.build/windows-storage-observer", "server/dist", "web/dist"];
const PRIVATE_SOURCE = "server/src/privateStorage.ts";
const CS_SOURCE = "server/native/windows/StorageDescriptorObserver.cs";
const HASH = /^[0-9a-f]{64}$/;
const SOURCE = /^[0-9a-f]{40}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("Windows storage QA packet admission failed."); };
const exact = (value, keys) => value != null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const at = (root, path) => join(root, ...path.split("/"));
function absolute(path) { if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail(); return path; }
function absent(path) { try { lstatSync(path); fail(); } catch (error) { if (error.code !== "ENOENT") throw error; } }
function parentSafe(path) { let parent = dirname(path); while (!existsSync(parent)) parent = dirname(parent); requireUnredirected(parent); }
function read(path, limit) {
  requireUnredirected(path); const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit || stat.size < 0) fail();
  const bytes = readFileSync(path); if (bytes.length !== stat.size) fail(); return bytes;
}
function allowed(path) {
  const fixed = [TREES[0] + "/compile.json", TREES[0] + "/unsigned/StorageDescriptorObserver.exe", TREES[0] + "/runtime/StorageDescriptorObserver.exe",
    TREES[0] + "/runtime/binding.json", "server/dist/index.cjs", "server/dist/windows-storage-observer/StorageDescriptorObserver.exe", "server/dist/windows-storage-observer/binding.json"];
  return typeof path === "string" && path.length <= 240 && (fixed.includes(path) || path.startsWith("web/dist/"))
    && path.split("/").every(part => (part === ".build" || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))
    && part !== "." && part !== ".." && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    && TREES.some(prefix => path.startsWith(prefix + "/"));
}

export function inspectCheckout(repo, source, { run = execFileSync } = {}) {
  absolute(repo); if (!SOURCE.test(source)) fail(); requireUnredirected(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" });
  const git = args => run("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-C", repo, ...args],
    { env, timeout: 10_000, maxBuffer: PACKET_LIMITS.manifestBytes, stdio: ["ignore", "pipe", "pipe"] });
  if (git(["rev-parse", "--verify", "HEAD"]).toString().trim() !== source ||
    resolve(git(["rev-parse", "--show-toplevel"]).toString().trim()).toLowerCase() !== repo.toLowerCase()) fail();
  git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
  const hashes = [PRIVATE_SOURCE, CS_SOURCE].map(path => {
    const bytes = read(at(repo, path), PACKET_LIMITS.manifestBytes);
    if (digest(bytes) !== digest(git(["show", `${source}:${path}`]))) fail(); return digest(bytes);
  });
  return { privateStorageSha256: hashes[0], observerSourceSha256: hashes[1] };
}

export function validatePacketManifest(value, source) {
  if (!SOURCE.test(source) || !exact(value, ["schemaVersion", "sourceRevision", "privateStorageSha256", "observerSourceSha256", "files"])
    || value.schemaVersion !== 1 || value.sourceRevision !== source || !HASH.test(value.privateStorageSha256)
    || !HASH.test(value.observerSourceSha256) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > PACKET_LIMITS.files) fail();
  let total = 0, previous = ""; const folded = new Set(), spellings = new Map();
  for (const file of value.files) {
    if (!exact(file, ["path", "bytes", "sha256"]) || !allowed(file.path) || file.path <= previous
      || folded.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > PACKET_LIMITS.fileBytes || !HASH.test(file.sha256)) fail();
    previous = file.path; folded.add(file.path.toLowerCase()); total += file.bytes;
    const parts = file.path.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const path = parts.slice(0, end).join("/"), key = path.toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== path) fail(); spellings.set(key, path);
    }
  }
  if (total > PACKET_LIMITS.bytes || TREES.some(prefix => !value.files.some(file => file.path.startsWith(prefix + "/")))) fail();
  return value;
}

function collect(root, packet = false) {
  const entries = [], bytes = new Map(); let total = 0;
  function walk(directory) {
    requireUnredirected(directory); const names = readdirSync(directory).sort(); if (!names.length) fail();
    for (const name of names) {
      const path = join(directory, name); const rel = relative(root, path).split("\\").join("/");
      if (packet && rel === "packet.json") continue;
      requireUnredirected(path); const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else {
        if (!allowed(rel) || entries.length >= PACKET_LIMITS.files || !stat.isFile() || stat.size > PACKET_LIMITS.fileBytes) fail();
        total += stat.size; if (total > PACKET_LIMITS.bytes) fail();
        const content = read(path, PACKET_LIMITS.fileBytes); entries.push({ path: rel, bytes: content.length, sha256: digest(content) }); bytes.set(rel, content);
      }
    }
  }
  if (packet) walk(root); else for (const tree of TREES) walk(at(root, tree));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entries, bytes };
}

function verifyBindings(root, sourceSha256) {
  const runtime = at(root, TREES[0] + "/runtime");
  const binding = validateObserverBinding(JSON.parse(read(join(runtime, "binding.json"), 16_000)));
  if (binding.sourceSha256 !== sourceSha256) fail();
  verifyObserverDirectory(runtime, binding);
  const bundle = bundledObserverBinding(at(root, "server/dist/index.cjs"));
  if (JSON.stringify(bundle) !== JSON.stringify(binding)) fail();
  verifyObserverDirectory(at(root, "server/dist/windows-storage-observer"), binding);
}

function writeFiles(root, files) {
  for (const [path, bytes] of files) { const dest = at(root, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: "wx" }); }
}

export function packetOverlapsGeneratedTree(repo, packet, platform = process.platform) {
  const paths = platform === "win32" ? win32 : posix;
  const canonical = path => platform === "win32" ? paths.resolve(path).toLowerCase() : paths.resolve(path);
  const destination = canonical(packet);
  return TREES.some(tree => {
    const generated = canonical(paths.join(repo, ...tree.split("/")));
    return destination === generated || destination.startsWith(generated + paths.sep);
  });
}

export function createPacket({ repo, packet, source, checkout = inspectCheckout }) {
  absolute(repo); absolute(packet); if (!SOURCE.test(source)) fail(); absent(packet); parentSafe(packet);
  if (packetOverlapsGeneratedTree(repo, packet)) fail();
  const identity = checkout(repo, source); preparedObserver(repo); verifyBindings(repo, identity.observerSourceSha256);
  const tree = collect(repo); const manifest = validatePacketManifest({ schemaVersion: 1, sourceRevision: source, ...identity, files: tree.entries }, source);
  const encoded = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); if (encoded.length > PACKET_LIMITS.manifestBytes) fail();
  mkdirSync(packet);
  try { writeFiles(packet, tree.bytes); writeFileSync(join(packet, "packet.json"), encoded, { flag: "wx" }); }
  catch { rmSync(packet, { recursive: true, force: true }); fail(); }
  return { packetSha256: digest(encoded), files: tree.entries.length, bytes: tree.entries.reduce((sum, file) => sum + file.bytes, 0) };
}

export function admitPacket({ repo, packet, source, sha256, checkout = inspectCheckout }) {
  absolute(repo); absolute(packet); if (!SOURCE.test(source) || !HASH.test(sha256)) fail();
  // The operator's digest is checked before parsing or inspecting any payload.
  const encoded = read(join(packet, "packet.json"), PACKET_LIMITS.manifestBytes); if (digest(encoded) !== sha256) fail();
  const manifest = validatePacketManifest(JSON.parse(encoded), source);
  const identity = checkout(repo, source);
  if (identity.privateStorageSha256 !== manifest.privateStorageSha256 || identity.observerSourceSha256 !== manifest.observerSourceSha256) fail();
  const tree = collect(packet, true);
  if (JSON.stringify(tree.entries) !== JSON.stringify(manifest.files)) fail();
  verifyBindings(packet, manifest.observerSourceSha256);
  const fresh = collect(packet, true); if (JSON.stringify(fresh.entries) !== JSON.stringify(manifest.files)) fail();
  for (const target of TREES) { absent(at(repo, target)); parentSafe(at(repo, target)); }
  const created = [];
  try {
    for (const target of TREES) { const path = at(repo, target); mkdirSync(path, { recursive: true }); created.push(path); }
    writeFiles(repo, fresh.bytes);
  } catch { for (const path of created.reverse()) rmSync(path, { recursive: true, force: true }); fail(); }
  return { packetSha256: sha256, files: tree.entries.length, bytes: tree.entries.reduce((sum, file) => sum + file.bytes, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2), options = {};
    const keys = mode === "create" ? ["repo", "packet", "source"] : mode === "admit" ? ["repo", "packet", "source", "sha256"] : [];
    if (!keys.length || args.length !== keys.length * 2) fail();
    for (let i = 0; i < args.length; i += 2) { const key = args[i].slice(2); if (args[i] !== "--" + key || !keys.includes(key) || key in options) fail(); options[key] = args[i + 1]; }
    console.log(JSON.stringify(mode === "create" ? createPacket(options) : admitPacket(options)));
  } catch { console.error("Windows storage QA packet admission failed."); process.exitCode = 1; }
}
