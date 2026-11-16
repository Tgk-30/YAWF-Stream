// Offline native-observation policy. No browser or media requests are made here.
import { evaluateProgress, validatePositiveWindow } from '../foreground_playback_gate.mjs';
import { validObservation, MAX_RECORDS } from './passive_observer.mjs';

const bad = code => ({ ok: false, code });
const invalidPositiveEvents = new Set(['waiting', 'stalled', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'visibilitychange']);
const sample = o => ({ wall: o.at, time: o.currentTime, frames: o.totalFrames,
  presented: { frames: o.frames, mediaTime: o.frameMediaTime }, rate: o.rate, paused: o.paused,
  seeking: o.seeking, hidden: o.hidden, error: o.mediaError ? 'media-error' : null,
  source: `${o.stream}:${o.sourceOrdinal}:${o.videoOrdinal}` });

/** All inputs are observations from the current owned fixture, not fabricated polls. */
export function evaluateNativeCase({ records, document, baselineSeq, sourceOrdinal, kind, seconds, markerSeq = null, segmentHeld = false }) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS || !/^[a-f0-9]{32}$/.test(document ?? '') ||
      !Number.isSafeInteger(baselineSeq) || baselineSeq < 1 || !Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 1 ||
      !['direct', 'hls', 'stall'].includes(kind) ||
      !((['direct', 'hls'].includes(kind) && [15, 480].includes(seconds)) || (kind === 'stall' && seconds === 180))) return bad('INVALID_CASE');
  if (records.some(r => !r || typeof r !== 'object' || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0)) return bad('INVALID_LEDGER');
  const browsers = records.filter(r => r.kind === 'browser');
  if (browsers.some(r => !validObservation(r.observation))) return bad('INVALID_OBSERVATION');
  const standalone = new Set(browsers.filter(r => r.observation.standalone).map(r => r.observation.document));
  if (standalone.size !== 1 || !standalone.has(document)) return bad('STANDALONE_DOCUMENT_CENSUS');
  const own = browsers.filter(r => r.observation.document === document).sort((a, b) => a.observation.seq - b.observation.seq);
  if (own.some((r, i) => r.observation.seq !== i + 1)) return bad('OBSERVER_SEQUENCE_GAP');
  if (own.some(r => r.observation.event === 'observer-limit')) return bad('OBSERVER_LIMIT');
  const baselineIndex = own.findIndex(r => r.observation.seq === baselineSeq);
  if (baselineIndex < 0) return bad('BASELINE_MISSING');
  const baseline = own[baselineIndex].observation;
  const expected = kind === 'direct' ? 'direct' : 'hls';
  const first = own.slice(0, baselineIndex + 1).findLast(r => r.observation.event === 'firstframe' &&
    r.observation.videoOrdinal === baseline.videoOrdinal && r.observation.sourceOrdinal === sourceOrdinal &&
    r.observation.sourceKind === expected && r.observation.stream === baseline.stream)?.observation;
  if (!first || baseline.sourceOrdinal !== sourceOrdinal || baseline.sourceKind !== expected || !baseline.sourceLocal ||
      !baseline.standalone || !baseline.rvfc || !baseline.stream || baseline.frames <= 0 || baseline.totalFrames === null ||
      baseline.currentTime === null || baseline.frameMediaTime === null) return bad('FRESH_DECODED_BASELINE_REQUIRED');
  const identity = o => o.document === document && o.videoOrdinal === baseline.videoOrdinal &&
    o.sourceOrdinal === sourceOrdinal && o.sourceKind === expected && o.stream === baseline.stream &&
    o.sourceLocal && o.standalone && o.rvfc;
  const after = own.slice(baselineIndex + 1);
  const baselineElapsed = own[baselineIndex].elapsedMs;
  let selectedGeneration = null;
  const samples = [];
  for (const entry of after) {
    const o = entry.observation;
    if (!identity(o)) return bad('DOCUMENT_VIDEO_SOURCE_CHANGED');
    if (o.event === 'animationframe') samples.push(entry);
  }
  if (samples.length === 0) return bad('RAF_OBSERVATION_MISSING');
  if (expected === 'direct') {
    if (!records.some(r => r.kind === 'direct-response' && r.stream === baseline.stream && r.method === 'GET' && [200, 206].includes(r.status))) return bad('DIRECT_RESPONSE_MISSING');
  } else {
    if (!records.some(r => r.kind === 'hls-response' && r.stream === baseline.stream && r.method === 'GET' && r.status === 200 && r.asset === 'index.m3u8')) return bad('HLS_MASTER_MISSING');
    const segments = records.filter(r => r.kind === 'hls-response' && r.stream === baseline.stream && r.method === 'GET' && r.status === 200 && r.asset === '480p_segment.ts' && typeof r.generation === 'string');
    if (!segments.length) return bad('HLS_SEGMENT_MISSING');
    const generations = new Set(segments.map(r => r.generation));
    if (generations.size !== 1) return bad('HLS_GENERATION_CHANGED');
    const generation = segments[0].generation;
    selectedGeneration = generation;
    const producers = records.filter(r => r.kind === 'producer-start' && r.generation === generation);
    if (producers.length !== 1 || !producers[0].inputLocal || !producers[0].fixed480 || !producers[0].hls || !producers[0].eventPlaylist || producers[0].segmentSeconds !== 6 || producers[0].codec === 'other' || !/^[a-f0-9]{64}$/.test(producers[0].argvHash ?? '')) return bad('PRODUCTION_480_PRODUCER_MISSING');
  }
  let begin = 0;
  let start = sample(baseline);
  if (kind === 'stall') {
    if (!segmentHeld || !Number.isSafeInteger(markerSeq) || markerSeq < baselineSeq) return bad('HELD_SEGMENT_REQUIRED');
    begin = samples.findIndex(r => r.observation.seq > markerSeq);
    if (begin < 0) return bad('POST_HOLD_RAF_MISSING');
    start = sample(samples[begin].observation);
    begin += 1;
  }
  if (!Number.isFinite(start.wall) || !Number.isFinite(start.time) || !Number.isFinite(start.frames) ||
      !Number.isFinite(start.presented.frames) || !Number.isFinite(start.presented.mediaTime)) return bad('INITIAL_SAMPLE_MISSING');
  let previous = start, stagnantSince = start.wall, stagnationStart = start, found = null;
  const positiveSamples = [];
  for (let i = begin; i < samples.length; i++) {
    const current = sample(samples[i].observation);
    if (!Number.isFinite(current.wall) || current.wall <= previous.wall || current.wall - previous.wall > 2500) return bad('RAF_OBSERVATION_GAP');
    if (![current.time, current.frames, current.presented.frames, current.presented.mediaTime].every(Number.isFinite)) return bad('SAMPLE_METRICS_MISSING');
    const evaluation = evaluateProgress(previous, current, stagnantSince, current.wall);
    if (evaluation.failure) {
      if (kind === 'stall' && evaluation.failure === 'no-decoded-progress') {
        if (current.wall - stagnationStart.wall < 15_000 ||
            Math.abs(current.time - stagnationStart.time) > 0.05 ||
            Math.abs(current.presented.mediaTime - stagnationStart.presented.mediaTime) > 0.05 ||
            current.frames !== stagnationStart.frames || current.presented.frames !== stagnationStart.presented.frames) {
          return bad('NO_DECODED_PROGRESS_NOT_STAGNANT');
        }
        found = current; break;
      }
      return bad(evaluation.failure);
    }
    if (evaluation.stagnantSince !== stagnantSince) stagnationStart = current;
    stagnantSince = evaluation.stagnantSince;
    positiveSamples.push(current);
    previous = current;
    if (kind !== 'stall' && current.wall - start.wall >= seconds * 1000 && current.time - start.time >= seconds) { found = current; break; }
  }
  if (!found) return bad(kind === 'stall' ? 'STALL_NOT_OBSERVED_OR_INCOMPLETE' : 'WINDOW_INCOMPLETE');
  const foundEntry = samples.find(x => x.observation.at === found.wall);
  if (expected === 'direct' && !records.some(r => r.kind === 'direct-response' && r.stream === baseline.stream && r.method === 'GET' && [200, 206].includes(r.status) && r.elapsedMs <= foundEntry.elapsedMs)) return bad('DIRECT_RESPONSE_OUTSIDE_WINDOW');
  if (expected === 'hls' && kind !== 'stall' && !records.some(r => r.kind === 'hls-response' && r.stream === baseline.stream && r.method === 'GET' && r.status === 200 && r.asset === '480p_segment.ts' && r.elapsedMs >= baselineElapsed && r.elapsedMs <= foundEntry.elapsedMs)) return bad('HLS_WINDOW_SEGMENT_MISSING');
  let heldRequests = 0;
  if (kind === 'stall') {
    const marker = own.find(r => r.observation.seq === markerSeq);
    if (!marker) return bad('HELD_REQUEST_NOT_CORRELATED');
    heldRequests = records.filter(r => r.kind === 'segment-held' && r.stream === baseline.stream && r.generation === selectedGeneration &&
      Number.isSafeInteger(r.segment) && r.elapsedMs >= marker.elapsedMs && r.elapsedMs <= foundEntry.elapsedMs).length;
    if (heldRequests === 0) return bad('HELD_REQUEST_NOT_CORRELATED');
  }
  if (kind !== 'stall') {
    const events = after.filter(r => r.observation.seq <= foundEntry.observation.seq)
      .map(r => ({ type: r.observation.event, at: r.observation.at }));
    if (events.some(e => invalidPositiveEvents.has(e.type)) || !validatePositiveWindow(start, positiveSamples, events, seconds * 1000)) return bad('POSITIVE_WINDOW_REJECTED');
  }
  return { ok: true, code: kind === 'stall' ? 'HELD_SEGMENT_NO_DECODED_PROGRESS' : seconds === 15 ? 'ADMISSION_ONLY' : 'OBSERVED_WINDOW',
    kind, seconds: (found.wall - start.wall) / 1000, mediaSeconds: found.time - start.time,
    presentedDelta: found.presented.frames - start.presented.frames, totalDelta: found.frames - start.frames, heldRequests };
}
