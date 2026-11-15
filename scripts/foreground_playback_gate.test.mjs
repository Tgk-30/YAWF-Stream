import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFixtureBootstrapLog, classifyResponse, collectFixtureDiagnostic, evaluateProgress, sanitizeFixtureDiagnostic, validateEvidenceDirectory, validatePositiveWindow, validateReceipts } from './foreground_playback_gate.mjs';
import { buildFixtureMediaPlan } from './foreground_fixture_media_plan.mjs';
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
  assert.match(s, /buildFixtureMediaPlan\(\{ foregroundLong: fixtureCLI\.foregroundLong, videoFilter,/);
  assert.match(s, /enableTranscode: fixtureCLI\.foregroundLong/);
  assert.match(s, /length: 12/);
});

const mediaOptions = { foregroundLong: false, videoFilter: 'owned-overlay', moviePath: '/owned/media/synthetic.mp4',
  segmentPattern: '/owned/media/segment%03d.ts', playlistPath: '/owned/media/index.m3u8' };
function requireFixtureMediaPlan(factory) {
  const legacyMp4 = [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=36',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=36',
    '-vf', mediaOptions.videoFilter, '-t', '36', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-g', '90', '-keyint_min', '90', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*3)',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', mediaOptions.moviePath,
  ];
  const legacyHls = [
    '-i', mediaOptions.moviePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls',
    '-hls_time', '3', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts', '-start_number', '0', '-hls_segment_filename', mediaOptions.segmentPattern, mediaOptions.playlistPath,
  ];
  const short = factory(mediaOptions), long = factory({ ...mediaOptions, foregroundLong: true });
  assert.deepEqual(short.map(({ kind, stage }) => [kind, stage]), [
    ['ffmpeg', 'mp4-generation'], ['ffmpeg', 'static-hls-generation'], ['probe', 'media-probe'], ['layout', 'media-output-check'],
  ]);
  assert.deepEqual(short[0].args, legacyMp4, 'the default MP4 uses exactly the old 36-second arguments');
  assert.deepEqual(short[1].args, legacyHls, 'static HLS uses the complete old 36-second MP4, never a truncation');
  assert.deepEqual(long.slice(0, 4), short, 'both modes finish the exact legacy construction and strict checks first');
  assert.deepEqual(long.slice(4).map(({ kind, stage }) => [kind, stage]), [
    ['ffmpeg', 'long-mp4-generation'], ['probe', 'long-media-probe'],
  ]);
  const replacement = legacyMp4.map((arg) => arg.replace('duration=36', 'duration=600'));
  replacement[replacement.indexOf('-t') + 1] = '600';
  replacement.splice(replacement.indexOf('-c:v'), 0, '-b:v', '700k', '-maxrate', '900k', '-bufsize', '1400k');
  replacement.unshift('-y');
  assert.deepEqual(long[4].args, replacement, 'only the final owned MP4 is replaced, at bounded bitrate, before its final probe');
  assert.equal(long.filter((step) => step.kind === 'ffmpeg' && step.args.includes('copy')).length, 1);
  assert.equal(long[1].args.includes('-t'), false);
}

test('actual media plan preserves legacy 36-second static HLS before the opt-in long replacement and re-probe', () => {
  requireFixtureMediaPlan(buildFixtureMediaPlan);
  const source = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
  const generation = source.slice(source.indexOf('function generateFixtureMedia('), source.indexOf('function assertStaticMediaLayout('));
  assert.match(source, /import \{ buildFixtureMediaPlan \} from "\.\/foreground_fixture_media_plan\.mjs"/);
  assert.match(generation, /for \(const step of plan\) \{\s*markForegroundStage\(step\.stage\)/);
  assert.match(generation, /case "ffmpeg": runFfmpeg\(step\.label, step\.args\); break;/);
  assert.match(generation, /case "probe": writeMediaProbe\(\); break;/);
  assert.match(generation, /case "layout": assertStaticMediaLayout\(\); break;/);
  const layout = source.slice(source.indexOf('function assertStaticMediaLayout('), source.indexOf('function boundedPort('));
  assert.match(layout, /length: 12/);
  assert.match(layout, /JSON\.stringify\(actualSegments\) !== JSON\.stringify\(expectedSegments\)/);
  assert.match(layout, /JSON\.stringify\(manifestSegments\) !== JSON\.stringify\(expectedSegments\)/);
  assert.doesNotMatch(layout, /foregroundLong/);
  const main = source.slice(source.indexOf('async function main('));
  assert.ok(main.indexOf('generateFixtureMedia();') < main.indexOf('createServer(serveMedia)'));
});

test('actual media-plan semantic mutants fail without executing ffmpeg or creating media', async () => {
  const original = readFileSync(new URL('./foreground_fixture_media_plan.mjs', import.meta.url), 'utf8');
  const mutations = [
    ['mp4(36, false)', 'mp4(600, false)'],
    ['plan.push(mp4(600, true));', 'plan.unshift(mp4(600, true));'],
    ["'-i', moviePath, '-map', '0:v:0'", "'-i', moviePath, '-t', '36', '-map', '0:v:0'"],
    ["...(replace ? ['-y'] : [])", '...[]'],
    ["plan.push({ kind: 'probe', stage: 'long-media-probe' });", ''],
    ["['-b:v', '700k', '-maxrate', '900k', '-bufsize', '1400k']", '[]'],
  ];
  for (const [from, to] of mutations) {
    requireFixtureMediaPlan(buildFixtureMediaPlan);
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { requireFixtureMediaPlan(mutant.buildFixtureMediaPlan); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'construction semantics must reject each individual mutant');
  }
});

const fixtureStatus = { schemaVersion: 1, stage: 'mp4-generation', status: 'refused', failureCode: 'ffmpeg-exit', childExitCode: 1 };
const privateDiagnostic = 'https://private.invalid/session?providerKey=PRIVATE_DIAGNOSTIC cookie=PRIVATE_DIAGNOSTIC';
test('long-mode diagnostics use fixed stages and owned guard codes without changing short-mode or cleanup', () => {
  const fixture = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
  const driver = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const writer = fixture.slice(fixture.indexOf('function writeForegroundDiagnostic('), fixture.indexOf('function markForegroundStage('));
  assert.match(writer, /if \(!fixtureCLI\.foregroundLong\) return;/);
  assert.match(writer, /JSON\.stringify\(\{ schemaVersion: 1, stage: foregroundStage, status, failureCode, childExitCode \}\)/);
  assert.match(writer, /renameSync\(`\$\{path\}\.tmp`, path\)/);
  assert.doesNotMatch(writer, /message|stack|stdout|stderr|headers|cookies/);
  assert.match(fixture, /if \(fixtureCLI\.foregroundLong\) \{[\s\S]*?process\.on\("uncaughtExceptionMonitor", recordForegroundRefusal\)/);
  assert.doesNotMatch(fixture, /process\.on\("uncaughtException",/);
  const stages = new Set([...fixture.matchAll(/markForegroundStage\("([a-z-]+)"\)/g)].map((match) => match[1]));
  for (const step of buildFixtureMediaPlan({ ...mediaOptions, foregroundLong: true })) stages.add(step.stage);
  for (const stage of stages) {
    assert.ok(sanitizeFixtureDiagnostic({ ...fixtureStatus, stage, status: stage === 'ready' ? 'ready' : 'running', failureCode: null, childExitCode: null }), stage);
  }
  const failureType = fixture.match(/type ForegroundFixtureFailure =([\s\S]*?);/)?.[1];
  assert.ok(failureType);
  for (const [, failureCode] of failureType.matchAll(/"([a-z-]+)"/g)) {
    assert.ok(sanitizeFixtureDiagnostic({ ...fixtureStatus, failureCode, childExitCode: null }), failureCode);
  }
  for (const stage of ['mp4-generation', 'static-hls-generation', 'media-probe', 'long-mp4-generation', 'long-media-probe', 'input-check', 'server-build', 'seed-owner', 'smoke-bootstrap', 'smoke-proxy-full', 'ready']) {
    assert.ok(stages.has(stage), stage);
  }
  const retained = driver.indexOf('evidence.fixtureDiagnostic = collectFixtureDiagnostic(fixtureDir, fixtureLog, proc?.exitCode)');
  assert.ok(retained > 0 && retained < driver.indexOf('rmSync(fixtureDir, { recursive: true, force: true })'));
});

test('fixture status sanitizer rejects unknown private facts, malformed exits and contradictory states', () => {
  assert.deepEqual(sanitizeFixtureDiagnostic(fixtureStatus), fixtureStatus);
  assert.deepEqual(sanitizeFixtureDiagnostic({ ...fixtureStatus, stage: 'ready', status: 'ready', failureCode: null, childExitCode: null }),
    { ...fixtureStatus, stage: 'ready', status: 'ready', failureCode: null, childExitCode: null });
  for (const key of Object.keys(fixtureStatus)) {
    const value = { ...fixtureStatus }; delete value[key];
    assert.equal(sanitizeFixtureDiagnostic(value), null, key);
  }
  for (const value of [null, [], 1, privateDiagnostic,
    { ...fixtureStatus, schemaVersion: true }, { ...fixtureStatus, stage: privateDiagnostic },
    { ...fixtureStatus, stage: 'Error' }, { ...fixtureStatus, failureCode: privateDiagnostic },
    { ...fixtureStatus, failureCode: 'Error' }, { ...fixtureStatus, raw: privateDiagnostic },
    { ...fixtureStatus, status: privateDiagnostic }, { ...fixtureStatus, status: 'running' },
    { ...fixtureStatus, status: 'ready', failureCode: null, childExitCode: null },
    { ...fixtureStatus, stage: 'ready', status: 'running', failureCode: null, childExitCode: null },
    { ...fixtureStatus, failureCode: null }, { ...fixtureStatus, failureCode: 'smoke-assertion' },
  ]) assert.equal(sanitizeFixtureDiagnostic(value), null);
  for (const childExitCode of [undefined, true, false, -1, 0, 256, 1.5, NaN, Infinity, '1', [], {}, privateDiagnostic]) {
    assert.equal(sanitizeFixtureDiagnostic({ ...fixtureStatus, childExitCode }), null);
  }
  assert.deepEqual(sanitizeFixtureDiagnostic({ ...fixtureStatus, stage: 'server-build', failureCode: 'unclassified-error', childExitCode: null }),
    { ...fixtureStatus, stage: 'server-build', failureCode: 'unclassified-error', childExitCode: null });
});

test('bootstrap classification distinguishes public Node codes and classes from arbitrary private text', () => {
  for (const [text, expected] of [
    [`Error [ERR_MODULE_NOT_FOUND]: ${privateDiagnostic}`, 'bootstrap-module-not-found'],
    [`  code: 'MODULE_NOT_FOUND',\n${privateDiagnostic}`, 'bootstrap-module-not-found'],
    [`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: ${privateDiagnostic}`, 'bootstrap-file-extension'],
    [`Error [ERR_REQUIRE_ESM]: ${privateDiagnostic}`, 'bootstrap-require-esm'],
    [`Error [ERR_DLOPEN_FAILED]: ${privateDiagnostic}`, 'bootstrap-native-module-load'],
    [`SyntaxError: ${privateDiagnostic}`, 'bootstrap-syntax-error'],
    [`ReferenceError: ${privateDiagnostic}`, 'bootstrap-reference-error'],
    [`TypeError: ${privateDiagnostic}`, 'bootstrap-type-error'],
    [`RangeError: ${privateDiagnostic}`, 'bootstrap-range-error'],
  ]) {
    assert.equal(classifyFixtureBootstrapLog(text), expected);
    assert.ok(!classifyFixtureBootstrapLog(text).includes('PRIVATE_DIAGNOSTIC'));
  }
  for (const text of [null, {}, '', `Error: ${privateDiagnostic}`, `CustomPrivateError: ${privateDiagnostic}`,
    `private body contains TypeError: ${privateDiagnostic}`, `quoted Error [ERR_MODULE_NOT_FOUND]: ${privateDiagnostic}`,
    `Error [PRIVATE_DIAGNOSTIC]: ${privateDiagnostic}`, `SyntaxError: ${'x'.repeat(64 * 1024)}`]) {
    assert.equal(classifyFixtureBootstrapLog(text), 'bootstrap-unclassified');
  }
});

test('actual diagnostic reader retains only bounded regular-file facts before private cleanup', () => {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), 'foreground-diagnostic-'));
  const fixture = join(directory, 'fixture'), log = join(directory, 'fixture-private.log');
  const status = join(fixture, 'foreground-fixture-status.json');
  mkdirSync(fixture);
  try {
    writeFileSync(log, `SyntaxError: ${privateDiagnostic}\n`);
    writeFileSync(status, `${JSON.stringify(fixtureStatus)}\n`);
    const retained = collectFixtureDiagnostic(fixture, log, 1);
    assert.deepEqual(retained, { source: 'status-file', ...fixtureStatus, fixtureExitCode: 1 });
    rmSync(status); rmSync(log);
    assert.equal(retained.stage, 'mp4-generation');
    assert.ok(!JSON.stringify(retained).includes('PRIVATE_DIAGNOSTIC'));
    writeFileSync(log, `Error [ERR_MODULE_NOT_FOUND]: ${privateDiagnostic}\n`);
    assert.deepEqual(collectFixtureDiagnostic(fixture, log, 1), {
      source: 'bootstrap-log', schemaVersion: 1, stage: 'bootstrap', status: 'unavailable',
      failureCode: 'bootstrap-module-not-found', childExitCode: null, fixtureExitCode: 1,
    });
    writeFileSync(log, `Error: ${privateDiagnostic}\n`);
    assert.equal(collectFixtureDiagnostic(fixture, log, null).failureCode, 'bootstrap-unclassified');
    writeFileSync(log, `${'x'.repeat(70_000)}\nReferenceError: ${privateDiagnostic}\n`);
    assert.equal(collectFixtureDiagnostic(fixture, log, 1).failureCode, 'bootstrap-reference-error');
    const partial = 'SyntaxError: PRIVATE_DIAGNOSTIC';
    writeFileSync(log, `private prefix ${partial}${'x'.repeat(64 * 1024 - partial.length)}`);
    assert.equal(collectFixtureDiagnostic(fixture, log, 1).failureCode, 'bootstrap-unclassified');
    for (const raw of [privateDiagnostic, 'x'.repeat(2049), JSON.stringify(fixtureStatus),
      `${JSON.stringify({ ...fixtureStatus, raw: privateDiagnostic })}\n`,
      `{"stage":"PRIVATE_DIAGNOSTIC",${JSON.stringify(fixtureStatus).slice(1)}\n`,
    ]) {
      writeFileSync(status, raw);
      const value = collectFixtureDiagnostic(fixture, log, 1);
      assert.equal(value.source, 'invalid-status');
      assert.equal(value.failureCode, 'status-invalid');
      assert.ok(!JSON.stringify(value).includes('PRIVATE_DIAGNOSTIC'));
    }
    rmSync(status);
    const target = join(directory, 'target.json'); writeFileSync(target, `${JSON.stringify(fixtureStatus)}\n`);
    symlinkSync(target, status);
    assert.equal(collectFixtureDiagnostic(fixture, log, 1).source, 'invalid-status');
    rmSync(status); mkdirSync(status);
    assert.equal(collectFixtureDiagnostic(fixture, log, 1).source, 'invalid-status');
    rmSync(status, { recursive: true });
    rmSync(log); symlinkSync(target, log);
    assert.equal(collectFixtureDiagnostic(fixture, log, 1).source, 'unavailable');
    rmSync(log);
    for (const exit of [undefined, null, true, '1', -1, 256, 1.5, NaN, Infinity]) {
      assert.equal(collectFixtureDiagnostic(fixture, log, exit).fixtureExitCode, null);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual diagnostic classifiers reject individual privacy and schema mutants behaviorally', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutations = [
    ['!FIXTURE_STAGES.has(value.stage)', 'false', (api) => assert.equal(api.sanitizeFixtureDiagnostic({ ...fixtureStatus, stage: privateDiagnostic }), null)],
    ['!FIXTURE_FAILURES.has(value.failureCode)', 'false', (api) => assert.equal(api.sanitizeFixtureDiagnostic({ ...fixtureStatus, failureCode: privateDiagnostic, childExitCode: null }), null)],
    ["Object.keys(value).sort().join(',') !== 'childExitCode,failureCode,schemaVersion,stage,status'", 'false',
      (api) => assert.equal(api.sanitizeFixtureDiagnostic({ ...fixtureStatus, raw: privateDiagnostic }), null)],
    ['!Number.isSafeInteger(value.childExitCode)', 'false', (api) => assert.equal(api.sanitizeFixtureDiagnostic({ ...fixtureStatus, childExitCode: '1' }), null)],
    ['`^${name}:`', '`${name}:`', (api) => assert.equal(api.classifyFixtureBootstrapLog(`private body contains TypeError: ${privateDiagnostic}`), 'bootstrap-unclassified')],
    ["Buffer.byteLength(text, 'utf8') > FIXTURE_PRIVATE_LOG_LIMIT", 'false',
      (api) => assert.equal(api.classifyFixtureBootstrapLog(`SyntaxError: ${'x'.repeat(64 * 1024)}`), 'bootstrap-unclassified')],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ sanitizeFixtureDiagnostic, classifyFixtureBootstrapLog });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'a semantic mutant must fail the actual classifier assertion');
  }
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
