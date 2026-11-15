import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BASE_SHA256, DERIVED_SHA256, LICENSE_SHA256, OUTPUT_NAME, PROFILE_VERSION, deriveForegroundSeccomp,
  hasOnlyForegroundChrootDelta, parsePinnedForegroundBase, pinForegroundDerivedBytes, prepareForegroundSeccomp,
  publishOwnedForegroundSeccomp } from './prepare_foreground_seccomp.mjs';

const baseBytes = readFileSync(new URL('./foreground-playback/seccomp-playwright-1.65.1.json', import.meta.url));
const base = JSON.parse(baseBytes);
const expectedBaseSha = 'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
const expectedDerivedSha = 'e53c15d248f57bceec0a3a16fad1b4ab0d05a7bddb455f86a60e2dba5612cdf7';
const expectedLicenseSha = '45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const temporary = () => mkdtempSync(join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), 'foreground-seccomp-test-'));

test('actual vendored bytes produce only the pinned, newly versioned chroot policy', () => {
  assert.equal(BASE_SHA256, expectedBaseSha); assert.equal(DERIVED_SHA256, expectedDerivedSha);
  assert.equal(LICENSE_SHA256, expectedLicenseSha);
  assert.equal(digest(baseBytes), expectedBaseSha);
  assert.equal(digest(readFileSync(new URL('./foreground-playback/LICENSE.playwright', import.meta.url))), expectedLicenseSha);
  assert.equal(PROFILE_VERSION, 'playwright-1.65.1-chroot-v1');
  assert.equal(OUTPUT_NAME, 'foreground-seccomp-playwright-1.65.1-chroot-v1.json');
  const bytes = deriveForegroundSeccomp(baseBytes), derived = JSON.parse(bytes);
  assert.equal(bytes.length, 16087); assert.equal(digest(bytes), expectedDerivedSha);
  assert.deepEqual(derived, { ...base, syscalls: [...base.syscalls, { names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [] }] });
  assert.equal(hasOnlyForegroundChrootDelta(base, derived), true);
  const chroot = derived.syscalls.filter((rule) => rule.names.includes('chroot'));
  assert.equal(chroot.length, 2);
  assert.deepEqual(chroot[0].includes.caps, ['CAP_SYS_CHROOT']);
  assert.deepEqual(chroot[1], { names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [] });
  assert.equal(digest(readFileSync(new URL('./foreground-playback/seccomp-playwright-1.65.1.json', import.meta.url))), expectedBaseSha);
});

test('bounded byte pins reject alternate bases and every other policy or rule delta', () => {
  for (const bytes of [Buffer.concat([baseBytes, Buffer.from('\n')]), Buffer.from('{}'), Buffer.from('{'),
    Buffer.from(JSON.stringify({ ...base, defaultAction: 'SCMP_ACT_ALLOW' }))]) {
    assert.throws(() => parsePinnedForegroundBase(bytes), { message: 'FOREGROUND_SECCOMP_BASE_SHA' });
  }
  for (const bytes of ['', null, Buffer.alloc(0), Buffer.alloc(32769)]) {
    assert.throws(() => parsePinnedForegroundBase(bytes), { message: 'FOREGROUND_SECCOMP_BASE_BOUND' });
  }
  const good = JSON.parse(deriveForegroundSeccomp(baseBytes));
  for (const change of [
    (p) => { p.defaultAction = 'SCMP_ACT_ALLOW'; }, (p) => { p.archMap.pop(); },
    (p) => { p.syscalls[0].action = 'SCMP_ACT_KILL'; }, (p) => { p.syscalls[0].names.push('mount'); },
    (p) => { p.syscalls.find((rule) => rule.names.includes('chroot')).includes.caps = []; },
    (p) => { p.syscalls.pop(); }, (p) => { p.syscalls.push({ names: ['mount'], action: 'SCMP_ACT_ALLOW', args: [] }); },
    (p) => { p.syscalls.at(-1).names = ['chroot', 'mount']; }, (p) => { p.syscalls.at(-1).action = 'SCMP_ACT_LOG'; },
    (p) => { p.syscalls.at(-1).args = [{ index: 0, value: 0, op: 'SCMP_CMP_EQ' }]; },
    (p) => { p.syscalls.at(-1).includes = {}; }, (p) => { p.syscalls.at(-1).excludes = {}; },
  ]) {
    const altered = clone(good); change(altered);
    assert.equal(hasOnlyForegroundChrootDelta(base, altered), false);
    assert.throws(() => pinForegroundDerivedBytes(Buffer.from(`${JSON.stringify(altered, null, 2)}\n`)), { message: 'FOREGROUND_SECCOMP_DERIVED_SHA' });
  }
  assert.throws(() => pinForegroundDerivedBytes(Buffer.concat([deriveForegroundSeccomp(baseBytes), Buffer.from('\n')])), { message: 'FOREGROUND_SECCOMP_DERIVED_SHA' });
});

test('actual preparer publishes a complete mode-0600 file exclusively and never replaces a symlink', () => {
  const root = temporary();
  try {
    const output = prepareForegroundSeccomp(root);
    assert.equal(output, join(root, OUTPUT_NAME)); assert.equal(digest(readFileSync(output)), expectedDerivedSha);
    assert.equal(lstatSync(output).isFile(), true); assert.equal(lstatSync(output).isSymbolicLink(), false);
    assert.equal(lstatSync(output).mode & 0o777, 0o600); assert.deepEqual(readdirSync(root), [OUTPUT_NAME]);
    assert.throws(() => prepareForegroundSeccomp(root), { message: 'FOREGROUND_SECCOMP_OUTPUT_EXISTS' });
    assert.equal(digest(readFileSync(output)), expectedDerivedSha); assert.deepEqual(readdirSync(root), [OUTPUT_NAME]);
    const nested = join(root, 'nested'); mkdirSync(nested, { mode: 0o700 });
    const sentinel = join(root, 'sentinel'); writeFileSync(sentinel, 'preserve'); symlinkSync(sentinel, join(nested, OUTPUT_NAME));
    assert.throws(() => publishOwnedForegroundSeccomp(nested, deriveForegroundSeccomp(baseBytes)), { message: 'FOREGROUND_SECCOMP_OUTPUT_EXISTS' });
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    const alias = join(root, 'alias'); symlinkSync(nested, alias);
    assert.throws(() => publishOwnedForegroundSeccomp(alias, deriveForegroundSeccomp(baseBytes)), { message: 'FOREGROUND_SECCOMP_OUTPUT_OWNER' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual CLI has no policy or output override and emits only pinned binding metadata', () => {
  const root = temporary(), script = fileURLToPath(new URL('./prepare_foreground_seccomp.mjs', import.meta.url));
  const invoke = (args) => spawnSync(process.execPath, [script, ...args], { env: { RUNNER_TEMP: root }, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  try {
    for (const args of [['--base', 'other'], ['--output', 'other'], ['--allow', 'mount']]) {
      const result = invoke(args); assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
      assert.equal(result.stderr, 'FOREGROUND_SECCOMP_REFUSED\n'); assert.deepEqual(readdirSync(root), []);
    }
    const result = invoke([]); assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.equal(result.stdout, `seccompProfileVersion=playwright-1.65.1-chroot-v1\nseccompBaseSha256=${expectedBaseSha}\nseccompDerivedSha256=${expectedDerivedSha}\nseccompLicenseSha256=${expectedLicenseSha}\n`);
    assert.equal(digest(readFileSync(join(root, OUTPUT_NAME))), expectedDerivedSha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function requireWorkflowSecurity(source) {
  const job = source.slice(source.indexOf('  foreground-chromium:'));
  assert.match(job, /runs-on: ubuntu-22\.04/); assert.match(job, /test "\$\{ImageOS:-\}" = ubuntu22/);
  assert.ok(source.includes('run: node --test scripts/prepare_foreground_seccomp.test.mjs'));
  const prepared = job.indexOf('node scripts/prepare_foreground_seccomp.mjs >> "$RUNNER_TEMP/foreground-evidence/binding.txt"');
  assert.ok(prepared > 0 && job.indexOf('docker build') > prepared);
  assert.ok(job.split(expectedDerivedSha).length >= 3);
  assert.ok(job.includes(`--security-opt "seccomp=$RUNNER_TEMP/${OUTPUT_NAME}"`));
  for (const guard of ['--network none', '--user "$uid:$gid"', '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--cpus 4', '--memory 6g', '--pids-limit 512', '--shm-size 512m']) assert.ok(job.includes(guard), guard);
  assert.doesNotMatch(job, /--cap-add|--privileged|seccomp=unconfined|--sysctl|--network host|--no-sandbox/);
  assert.doesNotMatch(job, /curl[^\n]*seccomp_profile/);
  const start = job.indexOf('trap finish EXIT'), end = job.indexOf('node --version', start);
  assert.ok(start > 0 && end > start);
  const admission = job.slice(start, end);
  assert.ok(admission.includes('test "$(id -u)" -ne 0'));
  assert.ok(admission.includes('for mask in CapInh CapPrm CapEff CapBnd CapAmb; do'));
  assert.ok(admission.includes('grep -c "^$mask:[[:space:]]*0000000000000000$" "/proc/$$/status"'));
  assert.ok(admission.includes('grep -c "^NoNewPrivs:[[:space:]]*1$" "/proc/$$/status"'));
}

test('workflow binds the derived profile only to the guarded host22 NONET container before any browser', () => {
  const source = readFileSync(new URL('../.github/workflows/foreground-playback-qa.yml', import.meta.url), 'utf8');
  requireWorkflowSecurity(source);
  for (const needle of ['--cap-drop ALL', 'for mask in CapInh CapPrm CapEff CapBnd CapAmb; do', 'test "$(id -u)" -ne 0',
    'node scripts/prepare_foreground_seccomp.mjs >> "$RUNNER_TEMP/foreground-evidence/binding.txt"']) {
    requireWorkflowSecurity(source);
    assert.ok(source.includes(needle)); assert.throws(() => requireWorkflowSecurity(source.replace(needle, '')), { code: 'ERR_ASSERTION' });
  }
});

test('actual generator pins, exact delta and exclusive publication reject individual causal mutants', async () => {
  const original = readFileSync(new URL('./prepare_foreground_seccomp.mjs', import.meta.url), 'utf8');
  const good = deriveForegroundSeccomp(baseBytes), parsed = JSON.parse(good);
  const prefixDrift = clone(parsed); prefixDrift.syscalls[0].action = 'SCMP_ACT_KILL';
  const ruleDrift = clone(parsed); ruleDrift.syscalls.at(-1).names.push('mount');
  const exclusive = (api) => {
    const root = temporary();
    try {
      const output = join(root, OUTPUT_NAME); writeFileSync(output, 'preserve');
      assert.throws(() => api.publishOwnedForegroundSeccomp(root, good), { message: 'FOREGROUND_SECCOMP_OUTPUT_EXISTS' });
      assert.equal(readFileSync(output, 'utf8'), 'preserve');
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const mutations = [
    ['digest(bytes) === BASE_SHA256', 'true', (api) => assert.throws(() => api.parsePinnedForegroundBase(Buffer.concat([baseBytes, Buffer.from('\n')])))],
    ['JSON.stringify(candidate.syscalls.slice(0, -1)) === JSON.stringify(base.syscalls)', 'true', (api) => assert.equal(api.hasOnlyForegroundChrootDelta(base, prefixDrift), false)],
    [`JSON.stringify(candidate.syscalls.at(-1)) === '{"names":["chroot"],"action":"SCMP_ACT_ALLOW","args":[]}'`, 'true', (api) => assert.equal(api.hasOnlyForegroundChrootDelta(base, ruleDrift), false)],
    ['digest(bytes) === DERIVED_SHA256', 'true', (api) => assert.throws(() => api.pinForegroundDerivedBytes(Buffer.concat([good, Buffer.from('\n')])))],
    ['linkSync(temporaryProfile, outputPath);', 'writeFileSync(outputPath, outputBytes);', exclusive],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ parsePinnedForegroundBase, hasOnlyForegroundChrootDelta, pinForegroundDerivedBytes, publishOwnedForegroundSeccomp });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'a mutant must fail an actual policy or publication assertion');
  }
});
