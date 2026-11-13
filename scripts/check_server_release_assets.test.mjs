import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerReleaseAssets } from './check_server_release_assets.mjs';
import { resolveUpdateCandidate } from '../deploy/updater/yawf-server-update.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = 'ghcr.io/tgk-30/yawf-stream', version = '3.4.5';
const deb = `debridstreamer-server_${version}_all.deb`, alias = 'debridstreamer-server_all.deb';
const smoke = `debridstreamer-server_${version}_all.smoke.json`, verification = `Server_${version}_verification.json`;
const tar = `yawf-server-updater_${version}.tar.gz`;
const names = [deb, alias, tar, smoke, 'server-update.json', verification];
function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'server-asset-check-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packageBytes = Buffer.from('synthetic package'); const serverHash = 'a'.repeat(64);
  for (const name of [deb, alias]) writeFileSync(join(dir, name), packageBytes);
  writeFileSync(join(dir, tar), 'synthetic updater');
  writeFileSync(join(dir, 'server-update.json'), JSON.stringify({schemaVersion:1,version,sourceRevision:'1'.repeat(40),image:{repository:repo,digest:`sha256:${'2'.repeat(64)}`},debian:{name:deb,sha256:hash(packageBytes),size:packageBytes.length}}));
  writeFileSync(join(dir, verification), JSON.stringify({schemaVersion:1,version,sourceRevision:'1'.repeat(40),releaseTag:`v${version}`,serverBundleSha256:serverHash,image:{repository:repo,digest:`sha256:${'2'.repeat(64)}`,amd64:`${repo}@sha256:${'3'.repeat(64)}`,arm64:`${repo}@sha256:${'4'.repeat(64)}`}}));
  writeFileSync(join(dir, smoke), JSON.stringify({schemaVersion:1,packageVersion:version,server:{entry:'index.cjs',bytes:100,sha256:serverHash}}));
  sums(dir); return dir;
}
function sums(dir) { writeFileSync(join(dir,'SHA256SUMS'), names.map(n => `${hash(readFileSync(join(dir,n)))}  ${n}\n`).join('')); }
function jsonEdit(dir,name,fn) { const path=join(dir,name), v=JSON.parse(readFileSync(path)); fn(v); writeFileSync(path,JSON.stringify(v)); sums(dir); }
function checkFails(dir, pattern) { assert.throws(() => checkServerReleaseAssets(dir), pattern); }

test('accepts generic release version and ignores unreferenced regular diagnostic backup', t => {
  const dir=fresh(t);writeFileSync(join(dir,'SHA256SUMS-before-manifest-entry.txt'),'retained diagnostic');
  const r=checkServerReleaseAssets(dir);assert.equal(r.version,version);assert.equal(r.sourceRevision,'1'.repeat(40));assert.equal(r.checkedFiles.length,6);assert.equal(r.scope,'offline-local-consistency-only');
});

test('checker never modifies the accepted fixture', t => {
  const dir=fresh(t);const files=[...names,'SHA256SUMS'];
  const before=files.map(name=>[name,hash(readFileSync(join(dir,name)))]);
  checkServerReleaseAssets(dir);
  assert.deepEqual(files.map(name=>[name,hash(readFileSync(join(dir,name)))]),before);
});

test('every required asset including the update manifest and verification has exactly one well-formed checksum', async t => {
  for (const name of names) await t.test(name, t => {
    const dir=fresh(t),path=join(dir,'SHA256SUMS'),lines=readFileSync(path,'utf8').trimEnd().split('\n');
    writeFileSync(path, lines.filter(x=>!x.endsWith(`  ${name}`)).join('\n')+'\n');checkFails(dir,/missing required entry/);
  });
});

test('rejects duplicate, malformed, traversing, stale and extra checksum entries', async t => {
  const cases=[
    ['duplicate', lines=>lines+lines.split('\n')[0]+'\n'],
    ['malformed', lines=>lines.replace(/^[a-f\d]/,'G')],
    ['traversal', lines=>lines.replace('  server-update.json','  ../server-update.json')],
    ['absolute', lines=>lines.replace('  server-update.json','  /server-update.json')],
    ['stale', lines=>lines.replace(deb,'debridstreamer-server_3.4.4_all.deb')],
    ['unexpected', lines=>lines+'f'.repeat(64)+'  unlisted.txt\n'],
    ['blank', lines=>lines+'\n'],
  ];
  for(const [name,mutate] of cases) await t.test(name,t=>{const dir=fresh(t),p=join(dir,'SHA256SUMS');writeFileSync(p,mutate(readFileSync(p,'utf8')));checkFails(dir,/malformed|duplicate|stale|unexpected/);});
});

test('rejects missing, changed, oversized or symlinked required and stale release files', async t => {
  const cases=[
    ['missing', d=>rmSync(join(d,tar)), /ENOENT/],
    ['asset mismatch', d=>writeFileSync(join(d,tar),'changed'), /checksum mismatch/],
    ['oversized metadata', d=>writeFileSync(join(d,'server-update.json'),Buffer.alloc(65537,0x20)), /oversized/],
    ['oversized binary', d=>truncateSync(join(d,deb),1_000_000_001), /oversized|unsafe/],
    ['symlink', d=>{rmSync(join(d,alias));symlinkSync(deb,join(d,alias));}, /unsafe directory entry/],
    ['stale file', d=>writeFileSync(join(d,'Server_3.4.4_verification.json'),'{}'), /stale or unexpected/],
    ['stale updater extension', d=>writeFileSync(join(d,'yawf-server-updater_3.4.4.zip'),'stale'), /stale or unexpected/],
    ['symlink directory', d=>{mkdirSync(join(d,'other'));symlinkSync('other',join(d,'link'));}, /unsafe directory entry/],
  ];
  for(const [name,mutate,pattern] of cases) await t.test(name,t=>{const dir=fresh(t);mutate(dir);checkFails(dir,pattern);});
});

test('rejects manifest, verification and smoke identity mismatches even with recomputed checksums', async t => {
  const cases=[
    ['manifest version', 'server-update.json', v=>v.version='03.4.5'],
    ['manifest source', 'server-update.json', v=>v.sourceRevision='Z'.repeat(40)],
    ['manifest repository', 'server-update.json', v=>v.image.repository='example.org/other'],
    ['manifest digest', 'server-update.json', v=>v.image.digest='sha256:bad'],
    ['manifest filename', 'server-update.json', v=>v.debian.name='../bad.deb'],
    ['manifest size', 'server-update.json', v=>v.debian.size++],
    ['manifest hash', 'server-update.json', v=>v.debian.sha256='9'.repeat(64)],
    ['verification schema', verification, v=>v.schemaVersion=2],
    ['verification version', verification, v=>v.version='3.4.4'],
    ['verification source', verification, v=>v.sourceRevision='9'.repeat(40)],
    ['verification tag', verification, v=>v.releaseTag='v3.4.4'],
    ['verification digest', verification, v=>v.image.digest=`sha256:${'9'.repeat(64)}`],
    ['verification child', verification, v=>v.image.amd64='https://example.com'],
    ['verification same children', verification, v=>v.image.arm64=v.image.amd64],
    ['smoke version', smoke, v=>v.packageVersion='3.4.4'],
    ['smoke entry', smoke, v=>v.server.entry='index.js'],
    ['smoke size', smoke, v=>v.server.bytes=0],
    ['smoke CJS hash', smoke, v=>v.server.sha256='9'.repeat(64)],
  ];
  for(const [name,file,mutate] of cases) await t.test(name,t=>{const dir=fresh(t);jsonEdit(dir,file,mutate);checkFails(dir,/invalid|mismatch|verification|server update manifest/);});
});

test('rejects different alias bytes even when its own checksum is updated', t => {
  const dir=fresh(t);writeFileSync(join(dir,alias),'different package');sums(dir);checkFails(dir,/alias/);
});

test('alias byte comparison rejects identical growth beyond the opening size', async t => {
  const dir=fresh(t);
  const shim=`import { readSync as realRead } from 'node:fs';
export * from 'node:fs';
const extended=new Set();
export function readSync(fd,buffer,offset,length,position) { const n=realRead(fd,buffer,offset,length,position); if(n===0 && length>0 && !extended.has(fd)){extended.add(fd);buffer[offset]=0x61;return 1;} return n; }`;
  const fsURL=`data:text/javascript;base64,${Buffer.from(shim).toString('base64')}`;
  const source=readFileSync(new URL('./check_server_release_assets.mjs',import.meta.url),'utf8');
  const prefix=source.slice(0,source.indexOf('function main(args)'));
  assert.notEqual(prefix,source);
  const code=prefix.replace("from 'node:fs'",`from ${JSON.stringify(fsURL)}`)
    .replace("'../deploy/updater/yawf-server-update.mjs'",JSON.stringify(new URL('../deploy/updater/yawf-server-update.mjs',import.meta.url).href))+'\nexport { assertByteEqual };';
  const instrumented=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.throws(()=>instrumented.assertByteEqual(join(dir,deb),join(dir,alias)),/alias exceeded admitted size/);
});

test('alias byte comparison rejects a matching premature EOF before the opening size', async t => {
  const dir=fresh(t);
  const shim=`import { readSync as realRead } from 'node:fs';
export * from 'node:fs';
const seen=new Set();
export function readSync(fd,buffer,offset,length,position) { if(seen.has(fd)) return 0; seen.add(fd); return realRead(fd,buffer,offset,Math.min(length,1),position); }`;
  const fsURL=`data:text/javascript;base64,${Buffer.from(shim).toString('base64')}`;
  const source=readFileSync(new URL('./check_server_release_assets.mjs',import.meta.url),'utf8');
  const prefix=source.slice(0,source.indexOf('function main(args)'));
  const code=prefix.replace("from 'node:fs'",`from ${JSON.stringify(fsURL)}`)
    .replace("'../deploy/updater/yawf-server-update.mjs'",JSON.stringify(new URL('../deploy/updater/yawf-server-update.mjs',import.meta.url).href))+'\nexport { assertByteEqual };';
  const instrumented=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.throws(()=>instrumented.assertByteEqual(join(dir,deb),join(dir,alias)),/Debian alias truncated/);
});

test('rejects duplicate JSON keys and invalid UTF-8 with matching checksum', async t => {
  for(const [name,mutate] of [
    ['duplicate manifest', d=>{const p=join(d,'server-update.json');writeFileSync(p,readFileSync(p,'utf8').replace('{','{"version":"9.9.9",'));}],
    ['duplicate verification', d=>{const p=join(d,verification);writeFileSync(p,readFileSync(p,'utf8').replace('{','{"schemaVersion":1,'));}],
    ['invalid UTF-8 smoke', d=>writeFileSync(join(d,smoke),Buffer.from([0xff]))],
  ]) await t.test(name,t=>{const dir=fresh(t);mutate(dir);sums(dir);checkFails(dir,/duplicate key|UTF-8/);});
});

test('causal in-memory regression: disabling manifest checksum coverage accepts the formerly omitted entry', async t => {
  const dir=fresh(t), sumPath=join(dir,'SHA256SUMS');
  const lines=readFileSync(sumPath,'utf8').split('\n').filter(line=>!line.endsWith('  server-update.json')).join('\n');
  writeFileSync(sumPath,lines);checkFails(dir,/missing required entry/);
  const checker=readFileSync(new URL('./check_server_release_assets.mjs',import.meta.url),'utf8');
  const oldCoverage="entries.size === expected.size && [...expected].every(name => entries.has(name))";
  const weakenedCoverage="entries.size === expected.size - 1 && [...expected].every(name => name === 'server-update.json' || entries.has(name))";
  const oldCompare="need(sums.get(name) === file.sha256, `SHA256SUMS: checksum mismatch for ${name}`)";
  const weakenedCompare="need((name === 'server-update.json' && !sums.has(name)) || sums.get(name) === file.sha256, `SHA256SUMS: checksum mismatch for ${name}`)";
  assert.equal(checker.split(oldCoverage).length,2);assert.equal(checker.split(oldCompare).length,2);
  const code=checker.slice(0,checker.indexOf('function main(args)')).replace(oldCoverage,weakenedCoverage).replace(oldCompare,weakenedCompare)
    .replace("'../deploy/updater/yawf-server-update.mjs'",JSON.stringify(new URL('../deploy/updater/yawf-server-update.mjs',import.meta.url).href));
  const mutant=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(mutant.checkServerReleaseAssets(dir).version,version);
});

function updaterFetch(dir, checksumBytes) {
  const manifestBytes=readFileSync(join(dir,'server-update.json')), manifest=JSON.parse(manifestBytes), tag=`v${manifest.version}`;
  const bytesByName={'server-update.json':manifestBytes,'SHA256SUMS':checksumBytes,[manifest.debian.name]:readFileSync(join(dir,manifest.debian.name))};
  const root=`https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/`;
  const assets=Object.entries(bytesByName).map(([name,bytes])=>({name,digest:`sha256:${hash(bytes)}`,size:bytes.length,browser_download_url:root+name}));
  const releases=Buffer.from(JSON.stringify([{tag_name:tag,draft:false,prerelease:false,published_at:'2026-01-01T00:00:00Z',assets}]));
  return async url=>{
    const target=String(url);if(target.startsWith('https://api.github.com/repos/Tgk-30/YAWF-Stream/releases?')) return new Response(releases);
    for(const [name,bytes] of Object.entries(bytesByName)) if(target===root+name)return new Response(bytes);
    throw new Error('unexpected mocked URL, no network');
  };
}
test('actual updater resolver rejects old package-only sums and accepts corrected complete sums using mock fetch', async t => {
  const dir=fresh(t),correct=readFileSync(join(dir,'SHA256SUMS'));
  const old=Buffer.from(correct.toString('utf8').split('\n').filter(line=>!line.endsWith('  server-update.json')&&!line.endsWith(`  ${verification}`)).join('\n'));
  await assert.rejects(resolveUpdateCandidate('0.0.0',updaterFetch(dir,old)),/server-update\.json/);
  assert.equal((await resolveUpdateCandidate('0.0.0',updaterFetch(dir,correct))).version,version);
});

const actual = process.env.SERVER_RELEASE_CHECK_PUBLICATION_DIR;
test('actual publication passes, and original pre-fix sums fail in an isolated copy and real updater resolver', {skip:!actual}, async t => {
  const result=checkServerReleaseAssets(actual);const manifest=JSON.parse(readFileSync(join(actual,'server-update.json')));
  assert.equal(result.version,manifest.version);const old=readFileSync(join(actual,'SHA256SUMS.original-tag-artifact'));
  const copy=mkdtempSync(join(tmpdir(),'server-asset-published-copy-'));t.after(()=>rmSync(copy,{recursive:true,force:true}));
  for(const name of [...result.checkedFiles,'SHA256SUMS'])copyFileSync(join(actual,name),join(copy,name));
  writeFileSync(join(copy,'SHA256SUMS'),old);checkFails(copy,/missing required entry/);
  await assert.rejects(resolveUpdateCandidate('0.0.0',updaterFetch(actual,old)),/server-update\.json/);
  assert.equal((await resolveUpdateCandidate('0.0.0',updaterFetch(actual,readFileSync(join(actual,'SHA256SUMS'))))).version,manifest.version);
});
