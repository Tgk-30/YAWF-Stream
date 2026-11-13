#!/usr/bin/env node
/** Offline local consistency check, not publication, signature or updater authorization. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUpdateManifest, REPOSITORY } from '../deploy/updater/yawf-server-update.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_METADATA = 1024 * 1024;
const MAX_ASSET = 1_000_000_000;
const CHUNK = 64 * 1024;
const own = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function need(condition, message) { if (!condition) throw new Error(message); }

// JSON.parse alone silently accepts duplicate member names; reject ambiguous metadata.
function uniqueJson(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}: invalid JSON`); }
  let pos = 0;
  const ws = () => { while (/[\t\n\r ]/.test(text[pos] ?? '') && pos < text.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === '\\') { pos += 2; continue; }
      if (text[pos++] === '"') return JSON.parse(text.slice(start, pos));
    }
    throw new Error(`${label}: invalid string`);
  };
  const visit = (depth) => {
    need(depth <= 128, `${label}: nesting limit`); ws();
    if (text[pos] === '{') {
      pos++; ws(); const keys = new Set();
      if (text[pos] === '}') { pos++; return; }
      while (true) {
        ws(); need(text[pos] === '"', `${label}: invalid key`); const key = string();
        need(!keys.has(key), `${label}: duplicate key`); keys.add(key); ws();
        need(text[pos++] === ':', `${label}: invalid member`); visit(depth + 1); ws();
        if (text[pos] === '}') { pos++; return; }
        need(text[pos++] === ',', `${label}: invalid object`);
      }
    }
    if (text[pos] === '[') {
      pos++; ws(); if (text[pos] === ']') { pos++; return; }
      while (true) { visit(depth + 1); ws(); if (text[pos] === ']') { pos++; return; } need(text[pos++] === ',', `${label}: invalid array`); }
    }
    if (text[pos] === '"') { string(); return; }
    const start = pos; while (pos < text.length && !/[\t\n\r ,}\]]/.test(text[pos])) pos++;
    need(pos > start, `${label}: invalid value`);
  };
  visit(0); ws(); need(pos === text.length, `${label}: trailing data`); return value;
}
function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function openRegular(path, maxBytes) {
  const before = lstatSync(path);
  need(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maxBytes, `unsafe or oversized file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { need(sameStat(before, fstatSync(fd)), `file changed on open: ${path}`); return { fd, before, path }; }
  catch (error) { closeSync(fd); throw error; }
}
function finishFile(file) {
  need(sameStat(file.before, fstatSync(file.fd)) && sameStat(file.before, lstatSync(file.path)), `file changed while reading: ${file.path}`);
}
function readAsset(path, limit, retain = false) {
  const file = openRegular(path, limit), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const count = readSync(file.fd, buffer, 0, buffer.length, null); if (count === 0) break;
      size += count; need(size <= limit && size <= file.before.size, `file grew while reading: ${path}`);
      hash.update(buffer.subarray(0, count)); if (retain) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    need(size === file.before.size, `file truncated while reading: ${path}`); finishFile(file);
    return { size, sha256: hash.digest('hex'), ...(retain ? { bytes: Buffer.concat(chunks, size) } : {}) };
  } finally { closeSync(file.fd); }
}
function assertByteEqual(left, right) {
  const a = openRegular(left, MAX_ASSET); let b;
  try {
    b = openRegular(right, MAX_ASSET); need(a.before.size === b.before.size, 'Debian alias size differs');
    const x = Buffer.allocUnsafe(CHUNK), y = Buffer.allocUnsafe(CHUNK);
    let compared = 0;
    for (;;) {
      const limit = Math.min(CHUNK, a.before.size - compared + 1);
      const nx = readSync(a.fd, x, 0, limit, null), ny = readSync(b.fd, y, 0, limit, null);
      need(nx === ny && x.subarray(0, nx).equals(y.subarray(0, ny)), 'Debian alias bytes differ');
      compared += nx;
      need(compared <= a.before.size, 'Debian alias exceeded admitted size');
      if (!nx) { need(compared === a.before.size, 'Debian alias truncated'); break; }
    }
    finishFile(a); finishFile(b);
  } finally { closeSync(a.fd); if (b) closeSync(b.fd); }
}
function jsonAsset(asset, label) {
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes); }
  catch { throw new Error(`${label}: invalid UTF-8`); }
  return uniqueJson(text, label);
}
function checksumEntries(asset, expected) {
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes); }
  catch { throw new Error('SHA256SUMS: invalid UTF-8'); }
  const lines = text.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *]([^\s/\\]+)$/.exec(line);
    need(match && expected.has(match[2]) && !entries.has(match[2]), 'SHA256SUMS: malformed, duplicate, stale or unexpected entry');
    entries.set(match[2], match[1]);
  }
  need(entries.size === expected.size && [...expected].every(name => entries.has(name)), 'SHA256SUMS: missing required entry');
  return entries;
}

export function checkServerReleaseAssets(directory) {
  need(typeof directory === 'string' && directory.length > 0, 'directory is required');
  const dir = resolve(directory), stat = lstatSync(dir);
  need(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(dir) === dir, 'directory must be real and contain no symlink path');
  const names = readdirSync(dir); need(names.length <= 128, 'directory entry limit');
  for (const name of names) {
    const entry = lstatSync(join(dir, name));
    need(entry.isFile() && !entry.isSymbolicLink() && entry.size <= MAX_ASSET, `unsafe directory entry: ${name}`);
  }
  const manifestFile = readAsset(join(dir, 'server-update.json'), 64 * 1024, true);
  const manifest = jsonAsset(manifestFile, 'server-update.json');
  need(own(manifest) && typeof manifest.version === 'string' && manifest.version.length <= 64 && VERSION.test(manifest.version), 'invalid release version');
  parseUpdateManifest(manifest, manifest.version);
  const { version, sourceRevision, image, debian } = manifest;
  need(SHA1.test(sourceRevision) && image.repository === REPOSITORY && DIGEST.test(image.digest), 'invalid update identity');
  const verificationName = `Server_${version}_verification.json`, smokeName = `debridstreamer-server_${version}_all.smoke.json`;
  const updaterName = `yawf-server-updater_${version}.tar.gz`, alias = 'debridstreamer-server_all.deb';
  const expected = new Set([debian.name, alias, updaterName, smokeName, 'server-update.json', verificationName]);
  for (const name of names) {
    const releaseNamed = name.startsWith('debridstreamer-server_') || /^Server_.*_verification(?:\.|$)/.test(name) || name.startsWith('yawf-server-updater_');
    need(!releaseNamed || expected.has(name), `stale or unexpected release file: ${name}`);
  }
  const sums = checksumEntries(readAsset(join(dir, 'SHA256SUMS'), 64 * 1024, true), expected);
  const files = new Map([['server-update.json', manifestFile]]);
  for (const name of expected) if (!files.has(name)) files.set(name, readAsset(join(dir, name), name.endsWith('.json') ? MAX_METADATA : MAX_ASSET, name.endsWith('.json')));
  for (const [name, file] of files) need(sums.get(name) === file.sha256, `SHA256SUMS: checksum mismatch for ${name}`);
  need(files.get(debian.name).size === debian.size && files.get(debian.name).sha256 === debian.sha256, 'manifest Debian size or hash mismatch');
  assertByteEqual(join(dir, debian.name), join(dir, alias));
  const verification = jsonAsset(files.get(verificationName), verificationName);
  need(own(verification) && verification.schemaVersion === 1 && verification.version === version &&
    verification.sourceRevision === sourceRevision && verification.releaseTag === `v${version}` &&
    own(verification.image) && verification.image.repository === image.repository && verification.image.digest === image.digest &&
    SHA256.test(verification.serverBundleSha256 ?? ''), 'verification identity mismatch');
  for (const arch of ['amd64', 'arm64']) need(new RegExp(`^${REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[a-f0-9]{64}$`).test(verification.image[arch] ?? ''), `verification ${arch} image reference invalid`);
  need(verification.image.amd64 !== verification.image.arm64, 'verification architecture digests must differ');
  const smoke = jsonAsset(files.get(smokeName), smokeName);
  need(own(smoke) && smoke.schemaVersion === 1 && smoke.packageVersion === version && own(smoke.server) &&
    smoke.server.entry === 'index.cjs' && Number.isSafeInteger(smoke.server.bytes) && smoke.server.bytes > 0 &&
    smoke.server.sha256 === verification.serverBundleSha256, 'smoke package or server bundle mismatch');
  return { version, sourceRevision, image, checkedFiles: [...expected].sort(), scope: 'offline-local-consistency-only' };
}

function main(args) {
  need(args.length === 2 && args[0] === '--dir', 'Usage: node scripts/check_server_release_assets.mjs --dir /path/to/publication');
  const result = checkServerReleaseAssets(args[1]);
  process.stdout.write(`Server release ${result.version}: offline local asset consistency passed; publication and runtime are not verified.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`Server release asset check failed: ${error.message}\n`); process.exitCode = 1; }
}
