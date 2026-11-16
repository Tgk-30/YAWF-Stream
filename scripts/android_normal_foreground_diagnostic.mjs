#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const keys = (o, list) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...list].sort().join(',');
const bounded = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const sha = b => createHash('sha256').update(b).digest('hex');
function requireThat(v) { if (!v) throw new Error('NORMAL_DIAGNOSTIC_REFUSED'); }
export function validate(receipt, directory) {
  requireThat(keys(receipt, ['schemaVersion','scope','outcome','playbackCase','windowRequiredMs','windowObservedMs','preWindowEngine','preWindowDecodedFrames','detailsClosedBeforeWindow','preWindowPlayingControlVerified','windowStartUptimeMs','noInputDuringWindow','hostedAdmission','fullQualification','productionCauseEstablished','observerAbiIntegrated','manualBurnedClockReviewRequired','anchors']));
  requireThat(receipt.schemaVersion === 1 && receipt.scope === 'android-normal-viewing-diagnostic-only' && receipt.outcome === 'normal-viewing-capture-collected');
  requireThat(['direct','hls'].includes(receipt.playbackCase));
  requireThat(receipt.preWindowEngine === (receipt.playbackCase === 'hls' ? 'Webview HLS transcode' : 'Webview direct'));
  requireThat(Number.isSafeInteger(receipt.preWindowDecodedFrames) && receipt.preWindowDecodedFrames > 0);
  requireThat(receipt.windowRequiredMs === 480000 && bounded(receipt.windowObservedMs, 480000, 540000));
  requireThat(receipt.detailsClosedBeforeWindow === true && receipt.preWindowPlayingControlVerified === true && Number.isSafeInteger(receipt.windowStartUptimeMs) && receipt.windowStartUptimeMs > 0 && receipt.noInputDuringWindow === true && receipt.manualBurnedClockReviewRequired === true);
  for (const flag of ['hostedAdmission','fullQualification','productionCauseEstablished','observerAbiIntegrated']) requireThat(receipt[flag] === false);
  requireThat(Array.isArray(receipt.anchors) && receipt.anchors.length === 5);
  const stat = lstatSync(directory); requireThat(stat.isDirectory() && !stat.isSymbolicLink());
  let last = -1, bytes = 0;
  receipt.anchors.forEach((a, i) => {
    requireThat(keys(a, ['ordinal','elapsedMs','file','sha256','playerOwned','detailsAbsent']));
    requireThat(a.ordinal === i + 1 && a.file === `normal-anchor-${String(i + 1).padStart(2, '0')}-${receipt.playbackCase}.png`);
    requireThat(bounded(a.elapsedMs, 0, receipt.windowObservedMs) && a.elapsedMs >= last && a.playerOwned === true && a.detailsAbsent === true);
    last = a.elapsedMs;
    requireThat(typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256));
    const path = join(directory, a.file), file = lstatSync(path);
    requireThat(file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= 8 * 1024 * 1024);
    bytes += file.size; requireThat(bytes <= 40 * 1024 * 1024);
    requireThat(sha(readFileSync(path)) === a.sha256);
  });
  requireThat(receipt.anchors[0].elapsedMs <= 5000 && receipt.anchors[4].elapsedMs >= 480000);
  return { scope: 'android-normal-viewing-diagnostic-only', outcome: 'normal-viewing-capture-collected', hostedAdmission: false, fullQualification: false, productionCauseEstablished: false, observerAbiIntegrated: false, manualBurnedClockReviewRequired: true, reviewStatus: 'manual-review-required' };
}
function main(args) {
  requireThat(args.length === 6 && args[0] === '--native' && args[2] === '--evidence-dir' && args[4] === '--output');
  const stat = lstatSync(args[1]); requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 65536);
  const result = validate(JSON.parse(readFileSync(args[1], 'utf8')), resolve(args[3]));
  writeFileSync(args[5], JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch { process.stderr.write('NORMAL_DIAGNOSTIC_REFUSED\n'); process.exitCode = 1; }
}
