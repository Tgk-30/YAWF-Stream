import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleUrl = process.env.DESKTOP102_TEST_MODULE
  ? pathToFileURL(process.env.DESKTOP102_TEST_MODULE)
  : new URL('./admit_desktop102_finalization.mjs', import.meta.url);
const { admit, createTestAdmission, ORIGINAL_ASSET_PINS, JOB_PINS, TAG, SOURCE, PRODUCER, RELEASE_ID } = await import(moduleUrl);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const apiAsset = (pin, id = pin.id) => ({ id, name: pin.name, state: 'uploaded', size: pin.size,
  digest: `sha256:${pin.sha256}`, url: `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/assets/${id}` });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop102-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Object.fromEntries(ORIGINAL_ASSET_PINS.map(pin => [pin.name, Buffer.from(`fixture:${pin.name}`)]));
  const pins = ORIGINAL_ASSET_PINS.map(pin => ({ ...pin, size: bytes[pin.name].length, sha256: hash(bytes[pin.name]) }));
  const harness = createTestAdmission(pins);
  const original = path.join(root, 'original'); mkdirSync(original);
  for (const pin of pins) writeFileSync(path.join(original, pin.name), bytes[pin.name]);
  const jobs = attempt => ({ total_count: JOB_PINS[attempt - 1].length, jobs: JOB_PINS[attempt - 1].map(pin => {
    const { failedSteps, ...job } = structuredClone(pin);
    return { ...job, steps: failedSteps };
  }) });
  const value = {
    heldTag: TAG, windows: '', ref: { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: SOURCE } },
    run: { id: PRODUCER, run_attempt: 2, run_number: 185, workflow_id: 299659497,
      repository: { full_name: 'Tgk-30/YAWF-Stream' }, head_sha: SOURCE, head_branch: TAG,
      event: 'push', path: '.github/workflows/web-release.yml', status: 'completed', conclusion: 'failure' },
    jobs1: jobs(1), jobs2: jobs(2),
    release: { id: RELEASE_ID, url: `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/${RELEASE_ID}`,
      tag_name: TAG, target_commitish: SOURCE, draft: true, prerelease: false, published_at: null,
      assets: pins.map(pin => apiAsset(pin)) },
  };
  return { root, pins, bytes, harness, original, value };
}
const targets = {
  'darwin-aarch64': 'YAWF.Stream_aarch64.app.tar.gz',
  'darwin-aarch64-app': 'YAWF.Stream_aarch64.app.tar.gz',
  'darwin-x86_64': 'YAWF.Stream_x64.app.tar.gz',
  'darwin-x86_64-app': 'YAWF.Stream_x64.app.tar.gz',
  'linux-x86_64': 'YAWF.Stream_2.3.102_amd64.AppImage',
  'linux-x86_64-appimage': 'YAWF.Stream_2.3.102_amd64.AppImage',
  'linux-x86_64-deb': 'YAWF.Stream_2.3.102_amd64.deb',
};
function writeFeeds(directory, full) {
  const legacy = structuredClone(full); delete legacy.platforms['darwin-x86_64']; delete legacy.platforms['darwin-x86_64-app'];
  for (const [name, data] of [['latest.json', legacy], ['latest-macos11.json', full]]) {
    writeFileSync(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`);
  }
}
function writeChecksums(directory, names) {
  writeFileSync(path.join(directory, 'SHA256SUMS'), names.map(name => `${hash(readFileSync(path.join(directory, name)))}  ${name}\n`).join(''));
}
function derived(t, stage = 'final') {
  const f = fixture(t);
  f.local = path.join(f.root, 'local'); mkdirSync(f.local);
  for (const pin of f.pins.filter(pin => pin.name !== 'latest.json')) copyFileSync(path.join(f.original, pin.name), path.join(f.local, pin.name));
  f.full = { version: '2.3.102', notes: 'Synthetic structural fixture only', pub_date: '2026-11-12T00:00:00Z',
    platforms: Object.fromEntries(Object.entries(targets).map(([key, name]) => [key, {
      url: `https://github.com/Tgk-30/YAWF-Stream/releases/download/${TAG}/${name}`,
      signature: f.bytes[`${name}.sig`].toString('utf8').trim(),
    }])) };
  writeFeeds(f.local, f.full);
  f.names = [...f.pins.map(pin => pin.name), 'latest-macos11.json'].sort();
  writeChecksums(f.local, f.names);
  f.expected = f.harness.inventory(f.local);
  f.remote = path.join(f.root, 'remote'); mkdirSync(f.remote);
  for (const name of [...f.names, ...(stage === 'final' ? ['SHA256SUMS'] : [])]) copyFileSync(path.join(f.local, name), path.join(f.remote, name));
  f.release = { ...f.value.release, assets: f.expected.assets.filter(row => stage === 'final' || row.name !== 'SHA256SUMS').map((row, i) => {
    const old = f.pins.find(pin => pin.name === row.name && row.name !== 'latest.json');
    return apiAsset(row, old ? old.id : 900000000 + i);
  }) };
  return f;
}

test('admits the exact fourteen-asset draft and both pinned attempts without qualifying Windows', t => {
  const f = fixture(t); const result = f.harness.admit(f.value);
  assert.equal(result.producerAttempt, 2); assert.equal(result.initialIntelFrontendFailureRetained, true);
  assert.equal(result.intelAttempt2SuccessObserved, true); assert.equal(result.heldWindowsFrontendFailureRetained, true);
  assert.equal(result.windowsQualified, false); assert.equal(result.publishAuthorizedByThisGate, false);
  assert.equal(result.finalizedOrCleanInstalled, false);
});
const admissionNegatives = {
  'release ID replacement': [f => { f.value.release.id++; }, /Exact draft/],
  'release source replacement': [f => { f.value.release.target_commitish = 'b'.repeat(40); }, /Exact draft/],
  'published or prerelease state': [f => { f.value.release.draft = false; }, /Exact draft/],
  'immutable tag replacement': [f => { f.value.ref.object.sha = 'b'.repeat(40); }, /Immutable tag/],
  'unheld Windows scope': [f => { f.value.windows = 'true'; }, /held-Windows/],
  'changed producer attempt': [f => { f.value.run.run_attempt = 3; }, /producer attempt2/],
  'missing producer attempt metadata': [f => { delete f.value.run.run_attempt; }, /producer attempt2/],
  'wrong producer repository': [f => { f.value.run.repository.full_name = 'other/repo'; }, /producer attempt2/],
  'attempt1 missing inventory': [f => { f.value.jobs1.jobs.pop(); }, /Attempt1 job inventory/],
  'attempt2 extra inventory': [f => { f.value.jobs2.jobs.push(f.value.jobs2.jobs[0]); }, /Attempt2 job inventory/],
  'attempt1 changed job identity': [f => { f.value.jobs1.jobs[0].id++; }, /Attempt1 exact job/],
  'attempt2 missing job attempt metadata': [f => { delete f.value.jobs2.jobs[0].run_attempt; }, /Attempt2 exact job/],
  'attempt1 Intel failure erased': [f => { const j = f.value.jobs1.jobs.find(j => j.name.startsWith('release (macos-15-intel')); j.conclusion = 'success'; j.steps = []; }, /Attempt1 exact job/],
  'attempt2 Intel not successful': [f => { f.value.jobs2.jobs.find(j => j.name.startsWith('release (macos-15-intel')).conclusion = 'failure'; }, /Attempt2 exact job/],
  'held Windows failure lineage changed': [f => { f.value.jobs2.jobs.find(j => j.name.startsWith('release (windows-')).steps[0].name = 'Sign'; }, /Attempt2 exact job/],
  'missing job step metadata': [f => { delete f.value.jobs1.jobs[0].steps; }, /Job step metadata/],
  'missing original asset': [f => { f.value.release.assets.pop(); }, /Original14 asset inventory/],
  'unexpected original asset': [f => { f.value.release.assets.push({ name: 'Windows.exe' }); }, /Original14 asset inventory/],
  'same-name same-size valid-digest replacement': [f => { f.value.release.assets[0].digest = `sha256:${'b'.repeat(64)}`; }, /Asset immutable/],
  'original asset ID replaced with identical bytes': [f => { const a = f.value.release.assets[0]; a.id++; a.url = `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/assets/${a.id}`; }, /Original asset ID/],
};
for (const [name, [mutate, error]] of Object.entries(admissionNegatives)) test(`refuses ${name}`, t => {
  const f = fixture(t); mutate(f); assert.throws(() => f.harness.admit(f.value), error);
});
test('production pins are deeply immutable and tiny test pins cannot change production admission', t => {
  const f = fixture(t); assert.throws(() => { ORIGINAL_ASSET_PINS[0].sha256 = 'b'.repeat(64); }, TypeError);
  assert.throws(() => admit(f.value), /Asset immutable/);
});
test('pin injection is unavailable outside the exact test entrypoint even with a forged environment', () => {
  const script = `import {createTestAdmission,ORIGINAL_ASSET_PINS} from ${JSON.stringify(moduleUrl.href)}; createTestAdmission(ORIGINAL_ASSET_PINS);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'forged' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /restricted to the exact Node test/);
});
test('verifies all fourteen downloaded files against immutable original pins', t => {
  const f = fixture(t); assert.equal(f.harness.verifyDownloadedAssets(f.value.release, f.original).length, 14);
});
test('refuses same-size downloaded byte mutation', t => {
  const f = fixture(t); const a = f.pins[0]; writeFileSync(path.join(f.original, a.name), Buffer.alloc(a.size));
  assert.throws(() => f.harness.verifyDownloadedAssets(f.value.release, f.original), /Downloaded pinned digest/);
});
test('refuses coherently changed API and downloaded bytes', t => {
  const f = fixture(t); const a = f.pins[0]; const bytes = Buffer.alloc(a.size); writeFileSync(path.join(f.original, a.name), bytes);
  f.value.release.assets[0].digest = `sha256:${hash(bytes)}`;
  assert.throws(() => f.harness.verifyDownloadedAssets(f.value.release, f.original), /Asset immutable/);
});
test('refuses extra downloaded files', t => {
  const f = fixture(t); writeFileSync(path.join(f.original, 'unexpected'), 'x');
  assert.throws(() => f.harness.verifyDownloadedAssets(f.value.release, f.original), /Downloaded inventory/);
});
test('refuses symlinked artifact directories', t => {
  const f = fixture(t); const alias = path.join(f.root, 'alias'); symlinkSync(f.original, alias);
  assert.throws(() => f.harness.verifyDownloadedAssets(f.value.release, alias), /not canonical/);
});
test('refuses symlinked artifact files', t => {
  const f = fixture(t); const file = path.join(f.original, f.pins[0].name); const copy = path.join(f.root, 'copy');
  copyFileSync(file, copy); rmSync(file); symlinkSync(copy, file);
  assert.throws(() => f.harness.verifyDownloadedAssets(f.value.release, f.original), /Regular file identity/);
});
test('captures explicit expected local sixteen-file inventory and verifies fresh derived fifteen', t => {
  const f = derived(t, 'derived'); const result = f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'derived');
  assert.equal(f.expected.assets.length, 16); assert.equal(result.assets.length, 15); assert.equal(result.unchangedOriginalAssets, 13);
  assert.equal(result.publishAuthorizedByThisGate, false);
});
test('verifies final sixteen-file inventory and checksum coverage', t => {
  const f = derived(t); assert.equal(f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final').assets.length, 16);
});
test('refuses expected local original13 pin substitution even when API and bytes agree', t => {
  const f = derived(t, 'derived'); const name = 'YAWF.Stream_2.3.102_aarch64.dmg'; const row = f.expected.assets.find(r => r.name === name);
  const data = Buffer.alloc(row.size); row.sha256 = hash(data); writeFileSync(path.join(f.remote, name), data);
  f.release.assets.find(a => a.name === name).digest = `sha256:${row.sha256}`;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'derived'), /Expected original13 pin/);
});
test('refuses same original13 bytes reuploaded with a replacement ID', t => {
  const f = derived(t); const a = f.release.assets.find(a => a.name === 'YAWF.Stream_2.3.102_aarch64.dmg'); a.id++;
  a.url = `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/assets/${a.id}`;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /Original asset ID/);
});
test('refuses expected scope or source-directory metadata substitution', t => {
  const f = derived(t); f.expected.producerAttempt = 3;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /Expected local scope/);
});
test('refuses reusing local artifacts as remote verification', t => {
  const f = derived(t); assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.local, 'final'), /separate clean/);
});
test('refuses derived API digest drift against expected local hashes', t => {
  const f = derived(t); f.release.assets.find(a => a.name === 'latest.json').digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /Asset immutable/);
});
test('refuses unexpected remote inventory additions', t => {
  const f = derived(t); f.release.assets.push({ name: 'unexpected' });
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /Remote derived\/final asset inventory/);
});
test('refuses missing remote inventory entries', t => {
  const f = derived(t, 'derived'); f.release.assets.pop();
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'derived'), /Remote derived\/final asset inventory/);
});
test('refuses duplicate remote asset IDs', t => {
  const f = derived(t); const a = f.release.assets.find(a => a.name === 'latest.json');
  const b = f.release.assets.find(a => a.name === 'latest-macos11.json'); b.id = a.id; b.url = a.url;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /IDs are duplicated/);
});
test('refuses a new derived asset reusing an original ID', t => {
  const f = derived(t); const a = f.release.assets.find(a => a.name === 'latest.json'); a.id = f.pins[0].id;
  a.url = `https://api.github.com/repos/Tgk-30/YAWF-Stream/releases/assets/${a.id}`;
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'final'), /reuses an original/);
});
test('refuses changed remote bytes even when API metadata is unchanged', t => {
  const f = derived(t, 'derived'); const row = f.expected.assets.find(r => r.name === 'YAWF.Stream_2.3.102_aarch64.dmg');
  writeFileSync(path.join(f.remote, row.name), Buffer.alloc(row.size));
  assert.throws(() => f.harness.verifyDerivedInventory(f.expected, f.release, f.remote, 'derived'), /Downloaded pinned digest/);
});
test('refuses local original13 byte changes before expected inventory creation', t => {
  const f = derived(t); const p = path.join(f.local, 'YAWF.Stream_2.3.102_aarch64.dmg'); writeFileSync(p, Buffer.alloc(readFileSync(p).length)); writeChecksums(f.local, f.names);
  assert.throws(() => f.harness.inventory(f.local), /Preserved original13 digest/);
});
test('refuses a nondeterministic local feed split', t => {
  const f = derived(t); const file = path.join(f.local, 'latest.json'); writeFileSync(file, readFileSync(file).subarray(0, -1)); writeChecksums(f.local, f.names);
  assert.throws(() => f.harness.inventory(f.local), /deterministic split/);
});
test('refuses local feed target additions', t => {
  const f = derived(t); f.full.platforms['windows-x86_64'] = { url: 'no', signature: 'no' }; writeFeeds(f.local, f.full); writeChecksums(f.local, f.names);
  assert.throws(() => f.harness.inventory(f.local), /feed target scope/);
});
test('refuses a local feed URL or signature substitution', t => {
  const f = derived(t); f.full.platforms['linux-x86_64'].url = 'https://other.invalid/asset'; writeFeeds(f.local, f.full); writeChecksums(f.local, f.names);
  assert.throws(() => f.harness.inventory(f.local), /feed URL\/signature/);
});
test('refuses incomplete or duplicate local checksum coverage', t => {
  const f = derived(t); writeChecksums(f.local, f.names.slice(1));
  assert.throws(() => f.harness.inventory(f.local), /Checksum list is incomplete/);
});
test('refuses a locally incorrect checksum row digest', t => {
  const f = derived(t); const p = path.join(f.local, 'SHA256SUMS'); writeFileSync(p, readFileSync(p, 'utf8').replace(/^[a-f0-9]{64}/, 'b'.repeat(64)));
  assert.throws(() => f.harness.inventory(f.local), /Checksum row digest/);
});
