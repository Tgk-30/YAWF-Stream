import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('./split_desktop_updater_manifests.mjs', import.meta.url).pathname;
const packet = (n, byte) => Buffer.alloc(n, byte).toString('base64');
const signature = Buffer.from(`untrusted comment: signature\n${packet(74, 1)}\ntrusted comment: timestamp\n${packet(64, 2)}`).toString('base64');
const entry = (name) => ({ url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/v2.3.22-web/${name}`, signature });
const basePlatforms = Object.fromEntries(['darwin-aarch64','darwin-aarch64-app','darwin-x86_64','darwin-x86_64-app','linux-x86_64','linux-x86_64-appimage','linux-x86_64-deb'].map((key) => [key, entry(key)]));
function run(manifest, tag='v2.3.22-web') { const d=mkdtempSync(join(tmpdir(),'feed-')); const i=join(d,'in.json'), l=join(d,'latest.json'), m=join(d,'mac.json'); writeFileSync(i,JSON.stringify(manifest)); const r=spawnSync(process.execPath,[script,i,l,m,tag],{encoding:'utf8'}); return r.status === 0 ? {r,legacy:JSON.parse(readFileSync(l)),full:JSON.parse(readFileSync(m))} : {r}; }
test('legacy fence removes both Intel aliases and full feed retains all required targets',()=>{ const {r,legacy,full}=run({version:'2.3.22',platforms:basePlatforms}); assert.equal(r.status,0,r.stderr); const expected=Object.fromEntries(Object.entries(full.platforms).filter(([key])=>!key.startsWith('darwin-x86_64'))); assert.deepEqual(legacy.platforms,expected); assert.equal(Object.keys(full.platforms).length,7); });
test('split preserves signatures and URLs byte-for-byte',()=>{ const {full}=run({version:'2.3.22',platforms:basePlatforms}); assert.deepEqual(full.platforms,basePlatforms); });
for (const [name, mutate, expected] of [['malformed signature', (p)=>({...p,'darwin-aarch64':{...p['darwin-aarch64'],signature:'bad'}}), /invalid updater signature/],['missing target',(p)=>{const q={...p}; delete q['linux-x86_64-deb']; return q;}, /missing required updater target/],['wrong URL host',(p)=>({...p,'darwin-aarch64':{...p['darwin-aarch64'],url:p['darwin-aarch64'].url.replace('github.com','evil.example')}}), /invalid updater URL/],['credentials',(p)=>({...p,'darwin-aarch64':{...p['darwin-aarch64'],url:p['darwin-aarch64'].url.replace('https://','https://u:p@')}}), /invalid updater URL/],['bad tag',(p)=>p, /usage/]]) { test(`rejects ${name}`,()=>{const result=run({version:'2.3.22',platforms:mutate(basePlatforms)}, name==='bad tag'?'latest':'v2.3.22-web'); assert.notEqual(result.r.status,0); assert.match(result.r.stderr,expected);}); }
const invalidUrlMutations = {
  port: (u) => u.replace('github.com', 'github.com:443'),
  query: (u) => `${u}?x=1`,
  fragment: (u) => `${u}#x`,
  traversal: (u) => u.replace('/YAWF-Stream/', '/YAWF-Stream/../evil/'),
};
for (const [name, change] of Object.entries(invalidUrlMutations)) test(`rejects URL ${name}`, () => {
  const p = { ...basePlatforms, 'darwin-aarch64': { ...basePlatforms['darwin-aarch64'], url: change(basePlatforms['darwin-aarch64'].url) } };
  const result = run({ version: '2.3.22', platforms: p });
  assert.match(result.r.stderr, /invalid updater URL/);
});
test('rejects noncanonical outer base64', () => {
  const p = { ...basePlatforms, 'darwin-aarch64': { ...basePlatforms['darwin-aarch64'], signature: `${basePlatforms['darwin-aarch64'].signature}!` } };
  assert.match(run({ version: '2.3.22', platforms: p }).r.stderr, /invalid updater signature/);
});
test('rejects unknown platform key', () => {
  assert.match(run({ version: '2.3.22', platforms: { ...basePlatforms, unknown: basePlatforms['darwin-aarch64'] } }).r.stderr, /unexpected updater target/);
});
