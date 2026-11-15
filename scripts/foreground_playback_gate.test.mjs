import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyResponse, evaluateProgress, validateEvidenceDirectory, validatePositiveWindow, validateReceipts } from './foreground_playback_gate.mjs';
const baseline = { time: 10, frames: 300, paused: false, seeking: false, rate: 1, hidden: false, error: null, source: 'one', wall: 1000, presented: { frames: 300 } };
test('verified Node xz archive has its extraction prerequisite in the image bootstrap', () => {
  const dockerfile = readFileSync(new URL('./foreground-playback/Dockerfile', import.meta.url), 'utf8');
  const beforeExtraction = dockerfile.split('COPY node-v24.22.3-linux-x64.tar.xz')[0];
  assert.match(beforeExtraction, /apt-get install[\s\S]*?\bxz-utils\b/);
  assert.doesNotMatch(beforeExtraction.replace('xz-utils', ''), /apt-get install[\s\S]*?\bxz-utils\b/);
});
test('decoded time and frame progress resets the watchdog', () => {
  assert.deepEqual(evaluateProgress(baseline, { ...baseline, time: 11, frames: 330, presented: { frames: 330 } }, 1000, 2000), { failure: null, stagnantSince: 2000 });
});
test('same detector rejects an actual stalled frame clock at the bound', () => {
  assert.equal(evaluateProgress(baseline, baseline, 1000, 16000).failure, 'no-decoded-progress');
});
test('clock movement without decoded frames cannot mask a stall', () => {
  assert.equal(evaluateProgress(baseline, { ...baseline, time: 11 }, 1000, 16000).failure, 'no-decoded-progress');
});
test('seek, pause, visibility loss and source replacement do not pass', () => {
  for (const mutant of [{ time: 100 }, { paused: true }, { hidden: true }, { seeking: true }, { source: 'two' }, { rate: 2 }]) {
    assert.ok(evaluateProgress(baseline, { ...baseline, ...mutant }, 1000, 2000).failure);
  }
});
test('old short fixture remains default while long and transcode require explicit opt in', () => {
  const s = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
  assert.match(s, /let foregroundLong = false/);
  assert.match(s, /fixtureCLI\.foregroundLong \? 600 : 36/);
  assert.match(s, /enableTranscode: fixtureCLI\.foregroundLong/);
  assert.match(s, /length: 12/);
});
test('transcode gate cannot pass on static fixture HLS', () => {
  const s = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  assert.match(s, /Production HLS requests missing/);
  assert.match(s, /Real ffmpeg HLS producer evidence missing/);
  assert.match(s, /Forced network stall was not detected/);
});

test('only production stream paths classify as HLS, not static copy fixtures or malformed assets', () => {
  assert.equal(classifyResponse('/api/stream/session/index.m3u8'), 'index.m3u8');
  assert.equal(classifyResponse('/api/stream/session/480p.m3u8'), '480p.m3u8');
  assert.equal(classifyResponse('/api/stream/session/480p_seg_00001.ts'), '480p_seg_00001.ts');
  assert.equal(classifyResponse('/api/stream/session'), 'direct-proxy');
  for (const path of ['/media/index.m3u8', '/media/segment000.ts', '/api/stream/session/720p_seg_00001.ts', '/api/stream/session/480p_seg_1.ts']) assert.equal(classifyResponse(path), null);
});
test('decoded frames without presented frames cannot mask a stall', () => {
  assert.equal(evaluateProgress(baseline, { ...baseline, time: 11, frames: 330 }, 1000, 16000).failure, 'no-decoded-progress');
});

const validFirst = { ...baseline, time: 0, wall: 0, frames: 1, presented: { frames: 1, mediaTime: 0 } };
function windowSample(wall, time = wall / 1000) {
  return { ...validFirst, wall, time, frames: Math.round(time * 30) + 1, presented: { frames: Math.round(time * 30) + 1, mediaTime: time } };
}
test('true 480-second positive and harmless stalled notification pass', () => {
  assert.equal(validatePositiveWindow(validFirst, [windowSample(480_000)], [{ type: 'stalled', at: 1000 }], 480_000), true);
});
test('brief waiting and cumulative five-second drift cannot pass even without a watchdog stall', () => {
  const samples = Array.from({ length: 485 }, (_, i) => windowSample((i + 1) * 1000, (i + 1) * 480 / 485));
  let previous = validFirst, stagnantSince = 0;
  for (const current of samples) {
    const result = evaluateProgress(previous, current, stagnantSince, current.wall);
    assert.equal(result.failure, null);
    stagnantSince = result.stagnantSince;
    previous = current;
  }
  assert.equal(validatePositiveWindow(validFirst, samples, [], 480_000), false);
  assert.equal(validatePositiveWindow(validFirst, [windowSample(480_000)], [{ type: 'waiting', at: 1000 }], 480_000), false);
});
test('positive validator rejects duration, frame, state, lifecycle, source and non-finite mutants individually', () => {
  const good = windowSample(480_000);
  for (const mutant of [
    { wall: 479_999 }, { time: 479 }, { frames: validFirst.frames },
    { presented: { frames: validFirst.presented.frames, mediaTime: 480 } },
    { paused: true }, { seeking: true }, { hidden: true }, { rate: 2 },
    { error: 3 }, { source: 'replacement' }, { time: NaN }, { wall: Infinity },
    { presented: { frames: 100, mediaTime: NaN } },
  ]) assert.equal(validatePositiveWindow(validFirst, [{ ...good, ...mutant }], [], 480_000), false);
  for (const type of ['waiting', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'visibilitychange']) {
    assert.equal(validatePositiveWindow(validFirst, [good], [{ type, at: 1 }], 480_000), false);
  }
});
const admissionSummary = { mode: 'admission', status: 'admission-only', fullQualification: false };
const admissionCases = { admission: { case: 'admission', outcome: 'admission-only', fullQualification: false } };
const fullSummary = { mode: 'full', status: 'passed', fullQualification: true };
const fullCases = Object.fromEntries(['direct', 'hls', 'stall'].map((name) => [name, { case: name, outcome: 'passed', fullQualification: false }]));
test('receipt qualification rejects oversize, missing, tampered mode and false outcomes', () => {
  assert.equal(validateReceipts('admission', admissionSummary, admissionCases, 100), true);
  assert.equal(validateReceipts('full', fullSummary, fullCases, 100), true);
  assert.equal(validateReceipts('full', fullSummary, fullCases, 32 * 1024 * 1024 + 1), false);
  assert.equal(validateReceipts('full', fullSummary, { direct: fullCases.direct, hls: fullCases.hls }, 100), false);
  assert.equal(validateReceipts('full', { ...fullSummary, mode: 'admission' }, fullCases, 100), false);
  assert.equal(validateReceipts('full', { ...fullSummary, fullQualification: false }, fullCases, 100), false);
  assert.equal(validateReceipts('full', fullSummary, { ...fullCases, stall: { ...fullCases.stall, outcome: 'failed' } }, 100), false);
});
test('host receipt reader requires exact regular non-symlink files and matching mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreground-receipts-'));
  try {
    writeFileSync(join(dir, 'binding.txt'), 'binding');
    writeFileSync(join(dir, 'toolchain.txt'), 'toolchain');
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(admissionSummary));
    writeFileSync(join(dir, 'admission.json'), JSON.stringify(admissionCases.admission));
    assert.equal(validateEvidenceDirectory(dir, 'admission'), true);
    assert.equal(validateEvidenceDirectory(dir, 'full'), false);
    rmSync(join(dir, 'admission.json'));
    assert.equal(validateEvidenceDirectory(dir, 'admission'), false);
    symlinkSync(join(dir, 'summary.json'), join(dir, 'admission.json'));
    assert.equal(validateEvidenceDirectory(dir, 'admission'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
