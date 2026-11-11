import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHILD_ENV, CHILD_PROBE, EXPECTED_NODE, EXPECTED_UNDICI, MAX_CHILD_MS,
  PROBE_SHA256, RESPONSE, RESPONSE_SHA256, decodeTranscript, parseArgs, runGuard } from './bundled_node_fetch_guard.mjs';

const script = fileURLToPath(new URL('./bundled_node_fetch_guard.mjs', import.meta.url));
function events() {
  return [
    { event: 'ready', nodeVersion: '22.23.4', undiciVersion: '6.29.1', platform: 'darwin', architecture: 'arm64', loopbackOnly: true },
    { event: 'malformed', encodingCount: 6, advertisedBytes: 100, bodyBytes: 0, payloadSha256: RESPONSE_SHA256 },
    { event: 'rejected', errorName: 'TypeError' },
    { event: 'alive', healthStatus: 200, healthBodyBytes: 2, drainMs: 100 },
    { event: 'closed', connectionCount: 3, requestCount: 2, socketsRemaining: 0 },
  ];
}
const encode = values => values.map(value => JSON.stringify(value) + '\n').join('');
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bundled-fetch-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fixture-binary'), output = join(root, 'receipt.json');
  await writeFile(binary, 'owned deterministic binary fixture\n', { mode: 0o700 });
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  return { binary, output, sha256, root };
}
function fake(t, { values = events(), stderr = '', exitCode = 0, signal = null, hang = false, onSpawn, spawnError = false, rawStdout } = {}) {
  const state = { calls: [], kills: 0 };
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false, killed = false;
  const close = (code, sig) => { if (!closed) { closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code, sig); } };
  child.kill = sig => { state.kills++; killed = true; queueMicrotask(() => close(null, sig)); return true; };
  t.after(() => close(null, 'SIGKILL'));
  state.spawn = (binary, args, options) => {
    state.calls.push({ binary, args, options });
    queueMicrotask(async () => {
      if (onSpawn) await onSpawn();
      if (spawnError) child.emit('error', new Error('PRIVATE_SPAWN_DETAIL'));
      child.stdout.write(rawStdout ?? encode(values));
      child.stderr.write(stderr);
      if (!hang && !killed) close(exitCode, signal);
    });
    return child;
  };
  return state;
}

test('fixed policy and frozen advisory payload do not install exception/rejection listeners', () => {
  assert.equal(EXPECTED_NODE, '22.23.4'); assert.equal(EXPECTED_UNDICI, '6.29.1'); assert.equal(MAX_CHILD_MS, 8000);
  assert.equal((RESPONSE.match(/gzip/g) ?? []).length, 6);
  assert.ok(RESPONSE.endsWith('Content-Length: 100\r\nConnection: close\r\n\r\n'));
  assert.equal(RESPONSE_SHA256, createHash('sha256').update(RESPONSE).digest('hex'));
  assert.equal(PROBE_SHA256, createHash('sha256').update(CHILD_PROBE).digest('hex'));
  assert.ok(CHILD_PROBE.includes("server.listen(0, '127.0.0.1', done)"));
  assert.ok(CHILD_PROBE.indexOf("event: 'rejected'") < CHILD_PROBE.indexOf('first.end()'));
  assert.ok(CHILD_PROBE.includes('await Promise.all([closing, ...socketCloses])'));
  assert.doesNotMatch(CHILD_PROBE, /uncaughtException|unhandledRejection|process\.on\(|process\.env|https:\/\//);
});

test('CLI admits only its three exact nonsecret flags', () => {
  const good = ['--binary', '/owned/node', '--sha256', '1'.repeat(64), '--output', '/owned/new.json'];
  assert.deepEqual(parseArgs(good), { binary: '/owned/node', sha256: '1'.repeat(64), output: '/owned/new.json' });
  for (const bad of [[], good.slice(0, -2), [...good, '--node-version', '22.23.3'],
    ['--binary', 'x', '--binary', 'y', '--output', 'z'],
    ['constructor', 'x', '--sha256', 'y', '--output', 'z'],
    ['--url', 'http://127.0.0.1/', '--sha256', 'y', '--output', 'z']]) assert.throws(() => parseArgs(bad));
  const refused = spawnSync(process.execPath, [script, '--unexpected'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, 'Bundled Node fetch guard refused.\n');
});

test('wrong SHA, missing/nonregular/symlink binaries and existing output refuse before any child', async t => {
  const f = await fixture(t), state = fake(t);
  await assert.rejects(runGuard({ ...f, sha256: '0'.repeat(64) }, { spawnImpl: state.spawn }));
  await assert.rejects(runGuard({ ...f, binary: join(f.root, 'missing') }, { spawnImpl: state.spawn }));
  await assert.rejects(runGuard({ ...f, binary: f.root }, { spawnImpl: state.spawn }));
  await symlink(f.binary, join(f.root, 'alias'));
  await assert.rejects(runGuard({ ...f, binary: join(f.root, 'alias') }, { spawnImpl: state.spawn }));
  await writeFile(f.output, 'preserve');
  await assert.rejects(runGuard(f, { spawnImpl: state.spawn }));
  assert.equal(await readFile(f.output, 'utf8'), 'preserve'); assert.equal(state.calls.length, 0);
});

test('healthy handled rejection requires exact metadata, immutable binary, natural exit and closed owned server', async t => {
  const f = await fixture(t), state = fake(t);
  const receipt = await runGuard(f, { spawnImpl: state.spawn });
  assert.equal(receipt.result, 'pass'); assert.equal(state.calls.length, 1); assert.equal(state.kills, 0);
  assert.deepEqual(state.calls[0].args, ['--input-type=module', '-e', CHILD_PROBE]);
  assert.deepEqual(state.calls[0].options.env, CHILD_ENV);
  assert.deepEqual(state.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(state.calls[0].options.shell, false);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), receipt);
  assert.ok(!JSON.stringify(receipt).includes(f.root));
});

test('unexpected Node or built-in Undici versions cannot qualify', async t => {
  for (const field of ['nodeVersion', 'undiciVersion']) {
    const f = await fixture(t), values = events(); values[0][field] = field === 'nodeVersion' ? '22.23.3' : '6.28.1';
    const receipt = await runGuard(f, { spawnImpl: fake(t, { values }).spawn });
    assert.equal(receipt.result, 'fail'); assert.equal(receipt.checks.versionsMatch, false);
  }
});

test('missing, ambiguous, forged or out-of-order readiness/payload/health/closure cannot qualify', async t => {
  const variants = [values => values.splice(2, 1), values => values.push(values[4]),
    values => { values[0].loopbackOnly = false; }, values => { values[0].extra = 'PRIVATE'; },
    values => { values[1].encodingCount = 5; }, values => { values[1].bodyBytes = 100; },
    values => { values[1].payloadSha256 = '0'.repeat(64); }, values => { values[2].errorName = 'Error'; },
    values => { values[3].healthStatus = 500; }, values => { values[4].socketsRemaining = 1; }];
  for (const mutate of variants) {
    const f = await fixture(t), values = events(); mutate(values);
    assert.equal((await runGuard(f, { spawnImpl: fake(t, { values }).spawn })).result, 'fail');
  }
  assert.equal(decodeTranscript(encode(events().slice(0, 3))).complete, false);
  assert.equal(decodeTranscript('PRIVATE NONJSON\n').valid, false);
});

test('natural crash and signal remain fatal even after apparently healthy events', async t => {
  for (const options of [{ exitCode: 1 }, { exitCode: null, signal: 'SIGABRT' }]) {
    const f = await fixture(t);
    assert.equal((await runGuard(f, { spawnImpl: fake(t, options).spawn })).result, 'fail');
  }
});

test('orphaned-stream crash and arbitrary stderr are classified without retaining raw data', async t => {
  const f = await fixture(t);
  const state = fake(t, { values: events().slice(0, 3), exitCode: 1,
    stderr: "Unhandled 'error' event PRIVATE_STDERR UND_ERR_RES_CONTENT_LENGTH_MISMATCH" });
  const receipt = await runGuard(f, { spawnImpl: state.spawn });
  assert.equal(receipt.result, 'fail'); assert.equal(receipt.checks.fetchRejectionHandled, true);
  assert.equal(receipt.execution.stderrClass, 'advisory-orphaned-stream');
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE_STDERR'));
  const other = await fixture(t);
  assert.equal((await runGuard(other, { spawnImpl: fake(t, { stderr: 'PRIVATE_UNEXPECTED_DETAIL' }).spawn })).result, 'fail');
});

test('bounded timeout kills only its owned child and cannot accept readiness alone', { timeout: 2000 }, async t => {
  const f = await fixture(t), state = fake(t, { values: events().slice(0, 1), hang: true });
  const receipt = await runGuard(f, { spawnImpl: state.spawn, timeoutMs: 5 });
  assert.equal(receipt.result, 'fail'); assert.equal(receipt.execution.timedOut, true);
  assert.equal(receipt.execution.signal, 'SIGKILL'); assert.equal(state.kills, 1);
  const other = await fixture(t);
  await assert.rejects(runGuard(other, { spawnImpl: state.spawn, timeoutMs: MAX_CHILD_MS + 1 }));
});

test('stdout/stderr bounds and spawn failure never become a passing receipt', async t => {
  for (const options of [{ rawStdout: 'X'.repeat(8193) }, { stderr: 'X'.repeat(16385) }, { spawnError: true }]) {
    const f = await fixture(t), state = fake(t, options);
    const receipt = await runGuard(f, { spawnImpl: state.spawn });
    assert.equal(receipt.result, 'fail');
    if (!options.spawnError) { assert.equal(receipt.execution.outputBoundExceeded, true); assert.equal(state.kills, 1); }
    else assert.equal(receipt.execution.spawnError, true);
  }
});

test('binary mutation during the probe is rejected instead of reporting the earlier hash as proof', async t => {
  const f = await fixture(t);
  const state = fake(t, { onSpawn: () => writeFile(f.binary, 'changed owned fixture\n') });
  const receipt = await runGuard(f, { spawnImpl: state.spawn });
  assert.equal(receipt.result, 'fail'); assert.equal(receipt.checks.binaryUnchanged, false);
});
