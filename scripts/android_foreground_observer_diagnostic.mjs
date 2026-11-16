// Diagnostic export only. This does not qualify playback or establish a cause.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const VALIDATOR_SHA256 = '300a6fb16630299fd1912af10af421991b6ad4c78a25703f5ecd91da938ea2b0';
const LIMIT = 8 * 1024 * 1024;
const MAX_ROWS = 8192;
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
  const rows = []; let otherRows = 0;
  for (const line of lines) {
    rejectDuplicateKeys(line);
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid');
    if (row.kind !== 'browser') { otherRows++; continue; }
    if (Object.keys(row).sort().join(',') !== 'elapsedMs,kind,observation' ||
        typeof row.elapsedMs !== 'number' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 ||
        !validObservation(row.observation)) throw new Error('invalid');
    rows.push(row);
  }
  return { rows, otherRows };
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
    const report = { ...base, status: 'available', browserRows: result.rows, otherRowCount: result.otherRows };
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
