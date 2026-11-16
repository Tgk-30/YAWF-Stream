// Diagnostic export only. This does not qualify playback or establish a cause.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const VALIDATOR_SHA256 = '73d12d475d280ce430993bcbd709a38e4b8f970cbd9e58d39fabe9a2259b0369';
const LIMIT = 8 * 1024 * 1024;
const MAX_ROWS = 8192;
const MAX_ELAPSED_MS = 86_400_000;
const HASH = /^[a-f0-9]{64}$/;
const HLS_ASSETS = new Set([
  'index.m3u8',
  '1080p.m3u8', '720p.m3u8', '480p.m3u8', '360p.m3u8',
  '1080p_segment.ts', '720p_segment.ts', '480p_segment.ts', '360p_segment.ts',
]);
const HLS_QUALITIES = new Set(['auto', '1080p', '720p', '480p', '360p']);
const PRODUCER_CODECS = new Set(['libx264', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'other']);
const digest = data => createHash('sha256').update(data).digest('hex');

function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('refused');
    const data = Buffer.alloc(stat.size + 1);
    let used = 0, n;
    while (used < data.length && (n = readSync(fd, data, used, data.length - used, null)) > 0) used += n;
    if (used !== stat.size) throw new Error('refused');
    return data.subarray(0, used);
  } finally { closeSync(fd); }
}

// JSON.parse silently accepts duplicate keys. Scan each JSON value first, including
// nested objects, so a validator cannot inspect a different value than an auditor.
function rejectDuplicateKeys(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('invalid');
  }
  function value(depth) {
    if (depth > 32) throw new Error('invalid');
    ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') throw new Error('invalid');
        const key = string(); if (keys.has(key)) throw new Error('invalid'); keys.add(key);
        ws(); if (text[i++] !== ':') throw new Error('invalid'); value(depth + 1); ws();
        const c = text[i++]; if (c === '}') return; if (c !== ',') throw new Error('invalid');
      }
      throw new Error('invalid');
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (i < text.length) { value(depth + 1); ws(); const c = text[i++]; if (c === ']') return; if (c !== ',') throw new Error('invalid'); }
      throw new Error('invalid');
    }
    const start = i; while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (start === i) throw new Error('invalid');
  }
  value(0); ws(); if (i !== text.length) throw new Error('invalid');
}

export function collect(data, validObservation) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_ROWS) throw new Error('invalid');
  const rows = [], serverRecords = []; let otherRows = 0, previousElapsedMs = -1;
  for (const line of lines) {
    rejectDuplicateKeys(line);
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid');
    if (row.kind === 'browser') {
      if (Object.keys(row).sort().join(',') !== 'elapsedMs,kind,observation' ||
          !validElapsed(row.elapsedMs) || !validObservation(row.observation)) throw new Error('invalid');
      previousElapsedMs = monotonicElapsed(row.elapsedMs, previousElapsedMs);
      rows.push(row);
      continue;
    }
    otherRows++;
    if (row.kind === 'hls-response') {
      validateHlsResponse(row);
      previousElapsedMs = monotonicElapsed(row.elapsedMs, previousElapsedMs);
      serverRecords.push(row);
    } else if (row.kind === 'producer-start') {
      validateProducerStart(row);
      previousElapsedMs = monotonicElapsed(row.elapsedMs, previousElapsedMs);
      serverRecords.push(row);
    }
  }
  return { rows, otherRows, hlsFirstFragmentDiagnostic: summarizeHls(serverRecords, rows) };
}

function validElapsed(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_ELAPSED_MS;
}

function monotonicElapsed(value, previous) {
  if (!validElapsed(value) || value < previous) throw new Error('invalid');
  return value;
}

function nullableHash(value) {
  return value === null || (typeof value === 'string' && HASH.test(value));
}

function nullableIntegerText(value, max) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= max;
}

function nullableFiniteText(value, max) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 16 || !/^(?:0|[1-9]\d{0,5})(?:\.\d+)?$/.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max;
}

function validateHlsResponse(row) {
  const fields = 'asset,elapsedMs,endlist,frontier,generation,kind,method,quality,segment,start,status,stream';
  const segmentAsset = typeof row.asset === 'string' && row.asset.endsWith('_segment.ts');
  if (Object.keys(row).sort().join(',') !== fields || !validElapsed(row.elapsedMs) ||
      !['GET', 'HEAD'].includes(row.method) || !Number.isSafeInteger(row.status) || row.status < 100 || row.status > 599 ||
      typeof row.stream !== 'string' || !HASH.test(row.stream) || !nullableHash(row.generation) ||
      !HLS_ASSETS.has(row.asset) ||
      (segmentAsset ? !Number.isSafeInteger(row.segment) || row.segment < 0 || row.segment > 99_999 : row.segment !== null) ||
      !(row.quality === null || HLS_QUALITIES.has(row.quality)) || !nullableIntegerText(row.start, 86_400) ||
      !nullableFiniteText(row.frontier, 604_800) || !(row.endlist === null || row.endlist === '0' || row.endlist === '1')) {
    throw new Error('invalid');
  }
}

function validateProducerStart(row) {
  const fields = 'argvHash,codec,elapsedMs,eventPlaylist,fixed480,generation,hls,inputLocal,kind,ordinal,segmentSeconds';
  if (Object.keys(row).sort().join(',') !== fields || !validElapsed(row.elapsedMs) ||
      !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > MAX_ROWS || !nullableHash(row.generation) ||
      typeof row.argvHash !== 'string' || !HASH.test(row.argvHash) || !PRODUCER_CODECS.has(row.codec) ||
      !['inputLocal', 'fixed480', 'hls', 'eventPlaylist'].every(field => typeof row[field] === 'boolean') ||
      !(row.segmentSeconds === null || row.segmentSeconds === 6)) throw new Error('invalid');
}

function firstBrowserClock(rows, event) {
  const row = rows.find(candidate => candidate.observation?.event === event);
  if (!row) return null;
  const observation = row.observation;
  return {
    event,
    elapsedMs: row.elapsedMs,
    documentClockMs: typeof observation.at === 'number' && Number.isFinite(observation.at) ? observation.at : null,
    mediaClockSeconds: typeof observation.currentTime === 'number' && Number.isFinite(observation.currentTime) ? observation.currentTime : null,
  };
}

function summarizeHls(records, browserRows) {
  const producers = records.filter(row => row.kind === 'producer-start');
  const manifests = records.filter(row => row.kind === 'hls-response' && row.method === 'GET' && row.status === 200 && row.asset === 'index.m3u8');
  const fragments = [], seen = new Set();
  for (const row of records) {
    if (row.kind !== 'hls-response' || row.method !== 'GET' || row.status !== 200 ||
        !row.asset.endsWith('_segment.ts') || row.generation === null) continue;
    const key = `${row.generation}:${row.stream}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const metadata = manifests.findLast(candidate => candidate.generation === row.generation && candidate.stream === row.stream && candidate.elapsedMs <= row.elapsedMs) ?? null;
    const matchingProducers = producers.filter(candidate => candidate.generation === row.generation);
    const producer = matchingProducers.length === 1 ? matchingProducers[0] : null;
    fragments.push({
      generation: row.generation,
      stream: row.stream,
      fragmentOrdinal: row.segment,
      response: {
        elapsedMs: row.elapsedMs,
        status: row.status,
        quality: metadata?.quality ?? null,
        startSeconds: metadata?.start === null || metadata == null ? null : Number(metadata.start),
        frontierSeconds: metadata?.frontier === null || metadata == null ? null : Number(metadata.frontier),
        endlist: metadata?.endlist === null || metadata == null ? null : metadata.endlist === '1',
      },
      producerStartCount: matchingProducers.length,
      producerStart: producer == null ? null : {
        generation: producer.generation,
        elapsedMs: producer.elapsedMs,
        ordinal: producer.ordinal,
        inputLocal: producer.inputLocal,
        fixed480: producer.fixed480,
      },
    });
  }
  return {
    scope: 'server-generation-stream-diagnostic-only',
    browserCorrelationEstablished: false,
    firstBrowserClocks: {
      loadedmetadata: firstBrowserClock(browserRows, 'loadedmetadata'),
      playing: firstBrowserClock(browserRows, 'playing'),
    },
    firstSuccessfulGetFragments: fragments,
  };
}

export async function diagnostic(input, validator) {
  const base = { scope: 'diagnostic-only', hostedAdmission: false, fullQualification: false, productionCauseEstablished: false };
  try {
    const bytes = readRegular(validator);
    if (digest(bytes) !== VALIDATOR_SHA256) return { ...base, status: 'refused' };
    // Import exactly the authenticated bytes, not a path that can be replaced after hashing.
    const module = await import(`data:text/javascript;base64,${bytes.toString('base64')}`);
    if (typeof module.validObservation !== 'function') return { ...base, status: 'refused' };
    let data;
    try { data = readRegular(input); }
    catch (error) { return { ...base, status: error.code === 'ENOENT' ? 'unavailable' : 'refused' }; }
    const result = collect(data, module.validObservation);
    const report = { ...base, status: 'available', browserRows: result.rows, otherRowCount: result.otherRows,
      hlsFirstFragmentDiagnostic: result.hlsFirstFragmentDiagnostic };
    if (Buffer.byteLength(JSON.stringify(report)) + 1 > LIMIT) return { ...base, status: 'refused' };
    return report;
  } catch { return { ...base, status: 'refused' }; }
}

async function main(args) {
  if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--validator' || args[4] !== '--output' || !args[1] || !args[3] || !args[5]) throw new Error('arguments');
  const report = await diagnostic(args[1], args[3]);
  const parent = dirname(resolve(args[5]));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('output');
  writeFileSync(args[5], JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('DIAGNOSTIC_OUTPUT_REFUSED\n'); process.exitCode = 1; });
}
