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
const generation = 'a'.repeat(64), stream = 'b'.repeat(64), argvHash = 'c'.repeat(64);
const hls = overrides => ({ kind: 'hls-response', elapsedMs: 10, method: 'GET', status: 200, stream, generation,
  asset: '480p_segment.ts', segment: 0, quality: null, start: null, frontier: null, endlist: null, ...overrides });
const producer = overrides => ({ kind: 'producer-start', elapsedMs: 9, ordinal: 1, generation, argvHash,
  inputLocal: true, codec: 'libx264', hls: true, eventPlaylist: true, segmentSeconds: 6, fixed480: true, ...overrides });

test('collect retains validated browser data and counts but drops other rows', () => {
  const input = Buffer.concat([encode(row), encode({ kind: 'server', secret: 'https://private.invalid/' })]);
  const result = collect(input, valid);
  assert.deepEqual(result, { rows: [row], otherRows: 1, hlsFirstFragmentDiagnostic: {
    scope: 'server-generation-stream-diagnostic-only', browserCorrelationEstablished: false,
    firstBrowserClocks: { loadedmetadata: null, playing: null }, firstSuccessfulGetFragments: [],
  } });
  assert(!JSON.stringify(result).includes('private.invalid'));
});

test('derives only bounded first-fragment, manifest, producer and uncorrelated browser clocks', () => {
  const browser = (elapsedMs, event, at, currentTime) => ({ kind: 'browser', elapsedMs, observation: { event, at, currentTime, safe: true } });
  const browserValid = value => ['loadedmetadata', 'playing'].includes(value.event) && Number.isFinite(value.at) &&
    Number.isFinite(value.currentTime) && value.safe === true;
  const manifest = hls({ elapsedMs: 4, asset: 'index.m3u8', segment: null, quality: '480p', start: '0', frontier: '12.5', endlist: '0' });
  const input = Buffer.concat([
    encode(manifest), encode(producer({ elapsedMs: 5 })),
    encode(browser(6, 'loadedmetadata', 100, 0)), encode(hls({ elapsedMs: 7, segment: 3 })),
    encode(hls({ elapsedMs: 8, segment: 4 })), encode(browser(9, 'playing', 200, 2.25)),
    encode({ kind: 'server-future', elapsedMs: 'private', url: 'https://private.invalid/' }),
  ]);
  const result = collect(input, browserValid);
  assert.equal(result.otherRows, 5);
  assert.deepEqual(result.hlsFirstFragmentDiagnostic, {
    scope: 'server-generation-stream-diagnostic-only', browserCorrelationEstablished: false,
    firstBrowserClocks: {
      loadedmetadata: { event: 'loadedmetadata', elapsedMs: 6, documentClockMs: 100, mediaClockSeconds: 0 },
      playing: { event: 'playing', elapsedMs: 9, documentClockMs: 200, mediaClockSeconds: 2.25 },
    },
    firstSuccessfulGetFragments: [{
      generation, stream, fragmentOrdinal: 3,
      response: { elapsedMs: 7, status: 200, quality: '480p', startSeconds: 0, frontierSeconds: 12.5, endlist: false },
      producerStartCount: 1,
      producerStart: { generation, elapsedMs: 5, ordinal: 1, inputLocal: true, fixed480: true },
    }],
  });
  assert(!JSON.stringify(result).includes('private.invalid'));
});

test('recognized server records require exact shapes, enums, bounds and monotonic accepted clocks', () => {
  const malformed = [
    hls({ url: 'https://private.invalid/' }), hls({ method: 'POST' }), hls({ status: 99 }), hls({ stream: 'x'.repeat(64) }),
    hls({ generation: 'x'.repeat(64) }), hls({ asset: 'private.ts' }), hls({ segment: 100_000 }),
    hls({ quality: 'private' }), hls({ start: '01' }), hls({ start: '86401' }), hls({ frontier: 'Infinity' }),
    hls({ frontier: '604801' }), hls({ endlist: 'true' }), hls({ elapsedMs: 86_400_001 }),
    producer({ ordinal: 0 }), producer({ generation: 'x'.repeat(64) }), producer({ argvHash: 'x'.repeat(64) }),
    producer({ codec: 'private' }), producer({ hls: 1 }), producer({ segmentSeconds: 5 }), producer({ private: true }),
  ];
  for (const value of malformed) assert.throws(() => collect(encode(value), valid));
  assert.throws(() => collect(Buffer.concat([encode(hls({ elapsedMs: 10 })), encode(producer({ elapsedMs: 9 }))]), valid));
  assert.throws(() => collect(encode(hls({ asset: 'index.m3u8', segment: 0 })), valid));
  assert.throws(() => collect(encode(hls({ asset: '480p_segment.ts', segment: null })), valid));
  assert.doesNotThrow(() => collect(encode(hls({ asset: 'index.m3u8', segment: null, start: '120', frontier: '600.1234567' })), valid));
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
