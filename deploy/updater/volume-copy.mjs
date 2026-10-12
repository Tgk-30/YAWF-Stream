#!/usr/bin/env node
import { chmodSync, chownSync, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

function inside(root, path) { return path === root || path.startsWith(`${root}${sep}`); }
function copyTree(source, destination) {
  const root = resolve(source); const target = resolve(destination);
  if (root === "/" || target === "/" || root === target) throw new Error("Unsafe copy roots.");
  const applyMetadata = (path, stat) => {
    const desiredMode = stat.mode & 0o7777;
    let current = lstatSync(path);
    if ((current.mode & 0o7777) !== desiredMode) {
      // The container has CHOWN but not FOWNER. When root does not own an
      // existing target, take ownership only long enough to apply its mode.
      if (current.uid !== process.geteuid()) {
        chownSync(path, 0, 0);
        current = lstatSync(path);
      }
      chmodSync(path, desiredMode);
    }
    if (current.uid !== stat.uid || current.gid !== stat.gid) chownSync(path, stat.uid, stat.gid);
  };
  const walk = (from, to) => {
    if (!inside(root, resolve(from)) || !inside(target, resolve(to))) throw new Error("Copy escaped its roots.");
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error("Updater snapshots do not allow symlinks.");
    if (stat.isDirectory()) { mkdirSync(to, { recursive: true, mode: 0o700 }); for (const name of readdirSync(from)) walk(join(from, name), join(to, name)); applyMetadata(to, stat); return; }
    if (!stat.isFile()) throw new Error("Updater snapshots support regular files only.");
    copyFileSync(from, to); applyMetadata(to, stat);
  };
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Snapshot root must be a directory.");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
  for (const name of readdirSync(root)) walk(join(root, name), join(target, name));
  applyMetadata(target, rootStat);
}

const [mode, source, destination] = process.argv.slice(2);
if (!new Set(["copy", "restore"]).has(mode) || source == null || destination == null) throw new Error("Invalid volume copy invocation.");
copyTree(source, destination);
