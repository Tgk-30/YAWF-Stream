import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validate } from './android_normal_foreground_diagnostic.mjs';
import { validateNativeReceipt } from './android_foreground_playback_receipt.mjs';

function fixture(dir) {
  const anchors = Array.from({length: 5}, (_, i) => {
    const file = `normal-anchor-0${i+1}-hls.png`, data = Buffer.from(`image-${i}`);
    writeFileSync(join(dir, file), data);
    return { ordinal: i+1, elapsedMs: i*120000, file, sha256: createHash('sha256').update(data).digest('hex'), playerOwned: true, detailsAbsent: true };
  });
  return { schemaVersion: 1, scope: 'android-normal-viewing-diagnostic-only', outcome: 'normal-viewing-capture-collected', playbackCase: 'hls', windowRequiredMs: 480000, windowObservedMs: 480100, preWindowEngine: 'Webview HLS transcode', preWindowDecodedFrames: 19, detailsClosedBeforeWindow: true, preWindowPlayingControlVerified: true, windowStartUptimeMs: 10000, noInputDuringWindow: true, hostedAdmission: false, fullQualification: false, productionCauseEstablished: false, observerAbiIntegrated: false, manualBurnedClockReviewRequired: true, anchors };
}
test('normal observation is separate and fails semantic mutants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'normal-diagnostic-'));
  try {
    const value = fixture(dir);
    assert.equal(validate(value, dir).outcome, 'normal-viewing-capture-collected');
    assert.throws(() => validateNativeReceipt(value));
    const mutations = [
      x => x.detailsClosedBeforeWindow = false, x => x.preWindowPlayingControlVerified = false, x => x.windowStartUptimeMs = -1, x => x.noInputDuringWindow = false,
      x => x.windowObservedMs = 479999, x => x.windowObservedMs = 540001,
      x => x.anchors[0].elapsedMs = 5001, x => x.anchors[4].elapsedMs = 479999,
      x => x.anchors[2].playerOwned = false, x => x.anchors[2].detailsAbsent = false,
      x => x.fullQualification = true, x => x.hostedAdmission = true,
      x => x.productionCauseEstablished = true, x => x.observerAbiIntegrated = true,
      x => x.anchors[1].sha256 = '0'.repeat(64), x => x.samples = [{decodedFrames: 999}],
      x => x.preWindowDecodedFrames = 0, x => x.anchors.pop(),
    ];
    for (const mutate of mutations) { const copy = structuredClone(value); mutate(copy); assert.throws(() => validate(copy, dir)); }
    // A static/paused viewport is still a valid capture, not playback proof.
    for (const anchor of value.anchors) {
      const data = Buffer.from('identical-static-frame');
      writeFileSync(join(dir, anchor.file), data);
      anchor.sha256 = createHash('sha256').update(data).digest('hex');
    }
    assert.equal(validate(value, dir).fullQualification, false);
    writeFileSync(join(dir, value.anchors[0].file), 'tampered');
    assert.throws(() => validate(value, dir));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('auto MKV is an HLS capture only, with exact file and no quality action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'normal-mkv-'));
  try {
    const value = fixture(dir);
    value.playbackCase = 'auto-mkv';
    value.preWindowFile = 'Synthetic.Fixture.Movie.2026.1080p.WEB-DL.x264.mkv';
    value.manualQualitySelected = false;
    for (const anchor of value.anchors) {
      const data = Buffer.from(`image-${anchor.ordinal - 1}`);
      anchor.file = anchor.file.replace('-hls.png', '-auto-mkv.png');
      writeFileSync(join(dir, anchor.file), data);
    }
    assert.equal(validate(value, dir).outcome, 'normal-viewing-capture-collected');
    assert.throws(() => validateNativeReceipt(value));
    for (const mutate of [
      x => x.preWindowFile = 'Synthetic.Fixture.Movie.2026.1080p.WEB-DL.x264.mp4',
      x => delete x.preWindowFile, x => x.manualQualitySelected = true,
      x => x.preWindowEngine = 'Webview direct', x => x.fullQualification = true,
      x => x.hostedAdmission = true, x => x.productionCauseEstablished = true,
      x => x.anchors[0].file = 'normal-anchor-01-hls.png',
    ]) { const copy = structuredClone(value); mutate(copy); assert.throws(() => validate(copy, dir)); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
