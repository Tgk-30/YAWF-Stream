import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, diagnostic, VALIDATOR_SHA256 } from './android_foreground_observer_diagnostic.mjs';

const cli = fileURLToPath(new URL('./android_foreground_observer_diagnostic.mjs', import.meta.url));
const encode = x => Buffer.from(JSON.stringify(x) + '\n');
const row = { kind: 'browser', elapsedMs: 42, observation: { safe: true } };
const valid = x => Object.keys(x).join(',') === 'safe' && x.safe === true;
const hash = x => createHash('sha256').update(x).digest('hex');

test('collect retains validated browser data and counts but drops other rows', () => {
  const input = Buffer.concat([encode(row), encode({ kind: 'server', secret: 'https://private.invalid/' })]);
  const result = collect(input, valid);
  assert.deepEqual(result, { rows: [row], otherRows: 1 });
  assert(!JSON.stringify(result).includes('private.invalid'));
});

test('rejects malformed, duplicate, extra or unsafe browser values and row limits', () => {
  for (const input of [
    '{"kind":"browser","kind":"server"}',
    '{"kind":"browser","elapsedMs":1,"observation":{"safe":true,"safe":false}}',
    JSON.stringify({ ...row, url: 'https://private.invalid/' }),
    JSON.stringify({ ...row, observation: { safe: true, url: 'https://private.invalid/' } }),
    JSON.stringify({ ...row, elapsedMs: -1 }),
    '{"kind":"browser","elapsedMs":1e999,"observation":{"safe":true}}',
    '{bad',
    Array(8193).fill('{"kind":"server"}').join('\n'),
  ]) assert.throws(() => collect(Buffer.from(input), valid));
});

test('pinned validator required, refused output is bounded, private and exclusive', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'observer-test-'));
  try {
    const validator = join(dir, 'validator.mjs'), input = join(dir, 'input'), output = join(dir, 'output');
    writeFileSync(validator, 'export function validObservation() { return true; }');
    writeFileSync(input, encode(row));
    assert.notEqual(hash(readFileSync(validator)), VALIDATOR_SHA256);
    assert.equal((await diagnostic(input, validator)).status, 'refused');
    const run = () => spawnSync(process.execPath, [cli, '--input', input, '--validator', validator, '--output', output]);
    assert.equal(run().status, 0);
    const bytes = readFileSync(output), report = JSON.parse(bytes);
    assert.deepEqual(report, { scope: 'diagnostic-only', hostedAdmission: false, fullQualification: false, productionCauseEstablished: false, status: 'refused' });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const before = hash(bytes); assert.equal(run().status, 1); assert.equal(hash(readFileSync(output)), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real pinned validator binding and input refusals', { skip: !process.env.FIXTURE_VALIDATOR }, async () => {
  const validator = process.env.FIXTURE_VALIDATOR;
  assert.equal(hash(readFileSync(validator)), VALIDATOR_SHA256);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'observer-test-'));
  try {
    const input = join(dir, 'input'), link = join(dir, 'link');
    assert.equal((await diagnostic(input, validator)).status, 'unavailable');
    writeFileSync(input, Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.equal((await diagnostic(input, validator)).status, 'refused');
    symlinkSync(input, link);
    assert.equal((await diagnostic(link, validator)).status, 'refused');
    writeFileSync(input, encode({ kind: 'browser', elapsedMs: 1, observation: { url: 'https://private.invalid/' } }));
    assert.equal((await diagnostic(input, validator)).status, 'refused');
    const observation = { at: 1, bufferAhead: null, currentTime: null, document: 'a'.repeat(32), event: 'arrival', frameMediaTime: null, frames: 0, generation: null, hidden: false, mediaError: false, paused: false, rate: 0, ready: true, rootReady: true, readyState: 0, rvfc: false, seeking: false, seq: 1, sourceKind: 'unknown', sourceLocal: false, sourceOrdinal: 0, standalone: false, stream: null, totalFrames: null, videoCount: 0, videoOrdinal: 0 };
    writeFileSync(input, Buffer.concat([encode({ kind: 'browser', elapsedMs: 1, observation }), encode({ kind: 'server', url: 'https://private.invalid/' })]));
    const result = await diagnostic(input, validator);
    assert.equal(result.status, 'available'); assert.equal(result.otherRowCount, 1); assert.deepEqual(result.browserRows[0].observation, observation);
    observation.sourceKind = 'hls';
    writeFileSync(input, encode({ kind: 'browser', elapsedMs: 1, observation }));
    assert.equal((await diagnostic(input, validator)).status, 'refused');
    assert(!JSON.stringify(result).includes('private.invalid'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('output parent symlink is refused without touching its target', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'observer-test-'));
  try {
    const target = join(dir, 'target'), link = join(dir, 'link');
    // The private test directory itself is a normal output parent.
    symlinkSync(dir, link);
    const result = spawnSync(process.execPath, [cli, '--input', join(dir, 'missing'), '--validator', join(dir, 'missing-validator'), '--output', join(link, 'target')]);
    assert.equal(result.status, 1);
    assert.throws(() => statSync(target), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
