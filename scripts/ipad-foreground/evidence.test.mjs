import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNativeCase } from './evidence.mjs';

const doc = 'a'.repeat(32), stream = 'b'.repeat(64), generation = 'c'.repeat(64);
function observation(seq, kind, frozen = false) {
  const position = frozen ? Math.min(seq, 4) : seq;
  return { at: (seq - 1) * 1000, bufferAhead: 3, currentTime: position, document: doc,
    event: seq === 1 ? 'firstframe' : 'animationframe', frameMediaTime: position,
    frames: position * 30, generation: null, hidden: false, mediaError: false, paused: false,
    rate: 1, ready: true, readyState: 4, rootReady: true, rvfc: true, seeking: false, seq,
    sourceKind: kind, sourceLocal: true, sourceOrdinal: 1, standalone: true, stream,
    totalFrames: position * 30, videoCount: 1, videoOrdinal: 1 };
}
function trace(kind = 'direct', frozen = false) {
  const sourceKind = kind === 'direct' ? 'direct' : 'hls';
  const records = [];
  if (sourceKind === 'direct') records.push({ kind: 'direct-response', elapsedMs: 0, method: 'GET', status: 206, stream });
  else records.push(
    { kind: 'producer-start', elapsedMs: 0, generation, ordinal: 1, inputLocal: true, fixed480: true,
      hls: true, eventPlaylist: true, segmentSeconds: 6, codec: 'libx264', argvHash: 'd'.repeat(64) },
    { kind: 'hls-response', elapsedMs: 1, method: 'GET', status: 200, stream, generation, asset: 'index.m3u8', segment: null },
    { kind: 'hls-response', elapsedMs: 4000, method: 'GET', status: 200, stream, generation, asset: '480p_segment.ts', segment: 0 },
  );
  if (kind === 'stall') records.push({ kind: 'segment-held', elapsedMs: 4000, stream, generation, segment: 1 });
  for (let seq = 1; seq <= 22; seq++) records.push({ kind: 'browser', elapsedMs: seq * 1000, observation: observation(seq, sourceKind, frozen) });
  return { records, document: doc, baselineSeq: 2, sourceOrdinal: 1, kind, seconds: kind === 'stall' ? 180 : 15,
    markerSeq: kind === 'stall' ? 3 : null, segmentHeld: kind === 'stall' };
}

test('accepts only a full observed direct admission window, never endurance', () => {
  const input = trace();
  // The last real sample is exactly 15 seconds after the native baseline.
  // Replacing the baseline with the next rAF would incorrectly refuse this.
  input.records = input.records.filter(r => r.kind !== 'browser' || r.observation.seq <= 17);
  const result = evaluateNativeCase(input);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ADMISSION_ONLY');
  assert.equal(result.seconds, 15);
  assert.equal(result.mediaSeconds, 15);
});

test('matches real HLS producer and generation to observed stream', () => {
  const input = trace('hls');
  assert.equal(evaluateNativeCase(input).ok, true);
  const changed = structuredClone(input);
  changed.records.find(r => r.kind === 'hls-response' && r.asset === '480p_segment.ts').stream = 'e'.repeat(64);
  assert.equal(evaluateNativeCase(changed).code, 'HLS_SEGMENT_MISSING');
  const multiple = structuredClone(input);
  multiple.records.push({ ...multiple.records.find(r => r.kind === 'hls-response' && r.asset === '480p_segment.ts'), generation: 'f'.repeat(64), elapsedMs: 5 });
  assert.equal(evaluateNativeCase(multiple).code, 'HLS_GENERATION_CHANGED');
  const wrongProducer = structuredClone(input);
  wrongProducer.records.find(r => r.kind === 'producer-start').fixed480 = false;
  assert.equal(evaluateNativeCase(wrongProducer).code, 'PRODUCTION_480_PRODUCER_MISSING');
});

test('the unchanged 15-second detector needs a real held segment and advancing rAF timestamps', () => {
  const input = trace('stall', true);
  const result = evaluateNativeCase(input);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'HELD_SEGMENT_NO_DECODED_PROGRESS');
  assert.equal(result.seconds, 15);
  assert.equal(result.presentedDelta, 0);
  assert.equal(result.heldRequests, 1);
  assert.equal(evaluateNativeCase({ ...input, segmentHeld: false }).code, 'HELD_SEGMENT_REQUIRED');
  const wrongHold = structuredClone(input);
  wrongHold.records.find(r => r.kind === 'segment-held').generation = 'e'.repeat(64);
  assert.equal(evaluateNativeCase(wrongHold).code, 'HELD_REQUEST_NOT_CORRELATED');
  const gap = structuredClone(input);
  gap.records.find(r => r.kind === 'browser' && r.observation.seq === 7).observation.at += 5000;
  assert.equal(evaluateNativeCase(gap).code, 'RAF_OBSERVATION_GAP');
  const notStalled = trace('stall', false);
  assert.equal(evaluateNativeCase(notStalled).code, 'STALL_NOT_OBSERVED_OR_INCOMPLETE');
});

test('alternating, clock-only and frame-only progress cannot qualify as a held stall', () => {
  for (const mode of ['alternating', 'clock-only', 'frame-only']) {
    const input = trace('stall', true);
    for (const row of input.records) {
      if (row.kind !== 'browser' || row.observation.seq < 4) continue;
      const n = row.observation.seq - 4;
      const clockSteps = mode === 'frame-only' ? 0 : mode === 'clock-only' ? n : Math.floor((n + 1) / 2);
      const frameSteps = mode === 'clock-only' ? 0 : mode === 'frame-only' ? n : Math.floor(n / 2);
      row.observation.currentTime = 4 + clockSteps * 0.1;
      row.observation.frameMediaTime = row.observation.currentTime;
      row.observation.frames = 120 + frameSteps;
      row.observation.totalFrames = 120 + frameSteps;
    }
    assert.equal(evaluateNativeCase(input).code, 'NO_DECODED_PROGRESS_NOT_STAGNANT', mode);
  }
});

test('sequence loss, changed source, player pauses and missing decoded readiness fail closed', () => {
  const missing = trace();
  missing.records = missing.records.filter(r => r.kind !== 'browser' || r.observation.seq !== 4);
  assert.equal(evaluateNativeCase(missing).code, 'OBSERVER_SEQUENCE_GAP');
  const switched = trace();
  switched.records.find(r => r.kind === 'browser' && r.observation.seq === 6).observation.stream = 'e'.repeat(64);
  assert.equal(evaluateNativeCase(switched).code, 'DOCUMENT_VIDEO_SOURCE_CHANGED');
  const paused = trace();
  paused.records.find(r => r.kind === 'browser' && r.observation.seq === 6).observation.paused = true;
  assert.equal(evaluateNativeCase(paused).code, 'invalid-player-state');
  const noFirst = trace();
  noFirst.records[1].observation.event = 'playing';
  assert.equal(evaluateNativeCase(noFirst).code, 'FRESH_DECODED_BASELINE_REQUIRED');
});
