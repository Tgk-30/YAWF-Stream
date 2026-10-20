#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [input, legacyOutput, macos11Output, expectedTag] = process.argv.slice(2);
if (!input || !legacyOutput || !macos11Output || !expectedTag || !/^v\d+\.\d+\.\d+-web$/.test(expectedTag)) throw new Error('usage: split_desktop_updater_manifests.mjs input latest.json latest-macos11.json');
const manifest = JSON.parse(readFileSync(input, 'utf8'));
if (!manifest || typeof manifest !== 'object' || !manifest.platforms || typeof manifest.platforms !== 'object') throw new Error('invalid updater manifest');
const expectedVersion = expectedTag.replace(/^v/, '').replace(/-web$/, '');
if (manifest.version !== expectedVersion) throw new Error(`manifest version ${manifest.version} does not match ${expectedVersion}`);
const platforms = manifest.platforms;
const keys = Object.keys(platforms);
const allowed = /^(darwin-(aarch64|x86_64)(-app)?|linux-x86_64(-appimage|-deb)?|windows-x86_64(-msi|-nsis)?)$/;
const required = ['darwin-aarch64','darwin-aarch64-app','darwin-x86_64','darwin-x86_64-app','linux-x86_64','linux-x86_64-appimage','linux-x86_64-deb'];
for (const key of required) if (!platforms[key]) throw new Error(`missing required updater target: ${key}`);
const windows = keys.filter((key) => key.startsWith('windows-'));
if (windows.length && !['windows-x86_64','windows-x86_64-msi','windows-x86_64-nsis'].every((key) => windows.includes(key))) throw new Error('incomplete Windows updater targets');
if (keys.some((key) => !allowed.test(key))) throw new Error(`unexpected updater target: ${keys.find((key) => !allowed.test(key))}`);
for (const [key, entry] of Object.entries(platforms)) {
  if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') throw new Error(`invalid updater URL for ${key}`);
  const url = new URL(entry.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || /github\.com:\d+/i.test(entry.url) || url.pathname !== `/Tgk-30/YAWF-Stream/releases/download/${expectedTag}/${url.pathname.split('/').at(-1)}` || url.search || url.hash || url.username || url.password || url.port || url.pathname.includes('..')) throw new Error(`invalid updater URL for ${key}`);
  if (typeof entry.signature !== 'string') throw new Error(`invalid updater signature for ${key}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(entry.signature) || entry.signature.length % 4 !== 0) throw new Error(`invalid updater signature for ${key}`);
  let decoded;
  try { decoded = Buffer.from(entry.signature, 'base64').toString('utf8'); } catch { decoded = ''; }
  if (Buffer.from(decoded, 'utf8').toString('base64') !== entry.signature) throw new Error(`invalid updater signature for ${key}`);
  const lines = decoded.replace(/\n$/, '').split('\n');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) throw new Error(`invalid updater signature for ${key}`);
  for (const [i, length] of [[1, 74], [3, 64]]) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(lines[i])) throw new Error(`invalid updater signature for ${key}`);
    if (lines[i].length % 4 !== 0) throw new Error(`invalid updater signature for ${key}`);
    let packet; try { packet = Buffer.from(lines[i], 'base64'); } catch { packet = null; }
    if (packet && packet.toString('base64') !== lines[i]) packet = null;
    if (!packet || packet.length !== length) throw new Error(`invalid updater signature for ${key}`);
  }
}
const full = structuredClone(manifest);
const legacy = structuredClone(manifest);
for (const key of ['darwin-x86_64', 'darwin-x86_64-app']) delete legacy.platforms[key];
writeFileSync(legacyOutput, `${JSON.stringify(legacy, null, 2)}\n`);
writeFileSync(macos11Output, `${JSON.stringify(full, null, 2)}\n`);
