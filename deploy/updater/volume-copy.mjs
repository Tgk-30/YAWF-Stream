#!/usr/bin/env node
import { constants, closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function inside(root, path) { return path === root || path.startsWith(`${root}${sep}`); }
const COPY_BUFFER_BYTES = 64 * 1024;
function sameSource(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.uid === after.uid && before.gid === after.gid && before.mode === after.mode && before.mtimeMs === after.mtimeMs;
}
function applyMetadataFd(fd, stat) {
  const desiredMode = stat.mode & 0o777;
  let current = fstatSync(fd);
  if (current.uid !== process.geteuid()) {
    fchownSync(fd, 0, 0);
    current = fstatSync(fd);
  }
  if ((current.mode & 0o777) !== desiredMode) fchmodSync(fd, desiredMode);
  current = fstatSync(fd);
  if (current.uid !== stat.uid || current.gid !== stat.gid) fchownSync(fd, stat.uid, stat.gid);
  const final = fstatSync(fd);
  if (final.uid !== stat.uid || final.gid !== stat.gid || (final.mode & 0o777) !== desiredMode) {
    throw new Error("Snapshot metadata could not be preserved exactly.");
  }
}
function applyDirectoryMetadata(path, stat) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { applyMetadataFd(fd, stat); } finally { closeSync(fd); }
}
function copyRegularFile(from, to, expected) {
  const sourceFd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd;
  let complete = false;
  try {
    const opened = fstatSync(sourceFd);
    if (!opened.isFile() || !sameSource(expected, opened)) throw new Error("Snapshot source changed before it could be copied safely.");
    destinationFd = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (true) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        const step = writeSync(destinationFd, buffer, written, count - written, null);
        if (step <= 0) throw new Error("Snapshot destination stopped accepting data.");
        written += step;
      }
      copied += count;
    }
    const after = fstatSync(sourceFd);
    if (copied !== expected.size || !sameSource(expected, after)) throw new Error("Snapshot source changed while it was being copied.");
    applyMetadataFd(destinationFd, expected);
    fsyncSync(destinationFd);
    complete = true;
  } finally {
    try {
      if (destinationFd != null) closeSync(destinationFd);
    } finally {
      try { closeSync(sourceFd); } finally {
        if (!complete) { try { unlinkSync(to); } catch {} }
      }
    }
  }
}
function removeEntry(path, target) {
  if (!inside(target, resolve(path)) || path === target) throw new Error("Cleanup escaped its target root.");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.isFile()) { unlinkSync(path); return; }
  if (!stat.isDirectory()) throw new Error("Updater cleanup supports regular files, directories, and symlinks only.");
  for (const name of readdirSync(path)) removeEntry(join(path, name), target);
  rmdirSync(path);
}
export function copyTree(source, destination) {
  const root = resolve(source); const target = resolve(destination);
  if (root === "/" || target === "/" || root === target || inside(root, target) || inside(target, root)) throw new Error("Unsafe copy roots.");
  const validate = (path) => {
    if (!inside(root, resolve(path))) throw new Error("Snapshot validation escaped its source root.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Updater snapshots do not allow symlinks.");
    if (stat.isDirectory()) { for (const name of readdirSync(path)) validate(join(path, name)); return; }
    if (!stat.isFile()) throw new Error("Updater snapshots support regular files only.");
  };
  const walk = (from, to) => {
    if (!inside(root, resolve(from)) || !inside(target, resolve(to))) throw new Error("Copy escaped its roots.");
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error("Updater snapshots do not allow symlinks.");
    if (stat.isDirectory()) { mkdirSync(to, { mode: 0o700 }); for (const name of readdirSync(from)) walk(join(from, name), join(to, name)); applyDirectoryMetadata(to, stat); return; }
    if (!stat.isFile()) throw new Error("Updater snapshots support regular files only.");
    copyRegularFile(from, to, stat);
  };
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Snapshot root must be a directory.");
  validate(root);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const targetStat = lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("Snapshot destination root must be a directory.");
  for (const name of readdirSync(target)) removeEntry(join(target, name), target);
  for (const name of readdirSync(root)) walk(join(root, name), join(target, name));
  applyDirectoryMetadata(target, rootStat);
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, destination] = process.argv.slice(2);
  const expected = mode === "copy" ? ["/data", "/backup/data"] : mode === "restore" ? ["/backup/data", "/data"] : null;
  if (expected == null || source !== expected[0] || destination !== expected[1]) throw new Error("Invalid volume copy invocation.");
  copyTree(source, destination);
}
