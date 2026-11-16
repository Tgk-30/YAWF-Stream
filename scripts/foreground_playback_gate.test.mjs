import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { sanitizeHlsMetadata, selectAndVerify480p, captureFailureUi, copyFailureScreenshot, isBoundedViewportJpeg, sanitizeUiFailureDiagnostic, classifyBrowserLaunchFailure, classifyFixtureBootstrapLog, classifyResponse, collectBrowserPrerequisites, collectFixtureDiagnostic, evaluateProgress, parseKernelUsernsFlag, runCasesAfterPublicBootstrap, runPublicBrowserBootstrap, sanitizeBrowserLaunchDiagnostic, sanitizeBrowserPrerequisiteDiagnostic, sanitizeFixtureDiagnostic, sanitizePublicBrowserBootstrap, validateEvidenceDirectory, validatePositiveWindow, validateReceipts } from './foreground_playback_gate.mjs';
import { buildFixtureMediaPlan } from './foreground_fixture_media_plan.mjs';
const baseline = { time: 10, frames: 300, paused: false, seeking: false, rate: 1, hidden: false, error: null, source: 'one', wall: 1000, presented: { frames: 300 } };
const hlsMetadata = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:3.000000,\n480p_seg_00000.ts\n#EXT-X-ENDLIST';
test('actual HLS sanitizer preserves real safe tags and strips every secret-bearing field or reference', () => {
  assert.equal(sanitizeHlsMetadata(hlsMetadata), hlsMetadata);
  assert.equal(sanitizeHlsMetadata(hlsMetadata.replaceAll('\n', '\r\n')), hlsMetadata);
  const input = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001f,mp4a.40.2",URI="https://secret.invalid/?token=SECRET",RESOLUTION=640x360,FRAME-RATE=30.000,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE\n480p.m3u8?generation=SECRET';
  assert.equal(sanitizeHlsMetadata(input), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30.000,VIDEO-RANGE=SDR,CLOSED-CAPTIONS=NONE\n480p.m3u8');
  const rejected = ['#EXT-X-KEY:METHOD=AES-128,URI="https://secret.invalid/SECRET"', '#EXT-X-MAP:URI="SECRET"',
    '#EXTINF:3.0,SECRET', '#EXT-X-VERSION:6?token=SECRET', '#EXT-X-ENDLIST:SECRET', '#EXT-X-PLAYLIST-TYPE:SECRET',
    '#EXT-X-STREAM-INF:BANDWIDTH=SECRET', '#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2',
    '#EXT-X-STREAM-INF:URI="SECRET,BANDWIDTH=123"', '#EXT-X-STREAM-INF:BANDWIDTH=1,URI="SECRET',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,', '# arbitrary SECRET', 'https://secret.invalid/480p.m3u8?token=SECRET',
    '/api/stream/SECRET/480p.m3u8', '../480p.m3u8', '480p_seg_000000.ts', 'segment000.ts'];
  assert.equal(sanitizeHlsMetadata(rejected.join('\n')), '');
  assert.equal(sanitizeHlsMetadata('480p_seg_00001.ts?token=SECRET'), '480p_seg_00001.ts');
  assert.equal(sanitizeHlsMetadata('x'.repeat(65537)), '');
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /playlist: playlist == null \? null : sanitizeHlsMetadata\(playlist\)/);
  assert.match(source, /row\.sanitizedBody = sanitizeHlsMetadata\(body\.toString\('utf8'\)\)/);
  assert.match(source, /row\.bytes = body\.length; row\.sha256 = sha\(body\)/);
  assert.match(source, /playlistSha256: playlist == null \? null : sha\(playlist\)/);
});
test('missing EXT-X separator mutation loses real metadata in the actual sanitizer', async () => {
  assert.equal(sanitizeHlsMetadata(hlsMetadata), hlsMetadata);
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const from = '#EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE)';
  assert.equal(source.split(from).length, 2);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(from, '#EXTX-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE)')).toString('base64')}`);
  assert.throws(() => assert.equal(mutant.sanitizeHlsMetadata(hlsMetadata), hlsMetadata), { code: 'ERR_ASSERTION' });
});
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
  assert.match(s, /let sourceMkv = false/);
  assert.match(s, /validMkvFixtureOptions\(\{ sourceMkv, foregroundLong, ipadForeground \}\)/);
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
    ["'-i', moviePath, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls'", "'-i', moviePath, '-t', '36', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls'"],
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
const publicBootstrapPassed = { schemaVersion: 1, scope: 'public-browser-bootstrap-before-fixture', fullQualification: false,
  outcome: 'passed', phase: 'complete', errorMessage: null, messageTruncated: false };
const admissionSummary = { mode: 'admission', status: 'admission-only', fullQualification: false, publicBrowserBootstrap: publicBootstrapPassed };
const admissionCases = { admission: { case: 'admission', outcome: 'admission-only', fullQualification: false } };
const fullSummary = { mode: 'full', status: 'passed', fullQualification: true, publicBrowserBootstrap: publicBootstrapPassed };
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


const browserMarkers = { namespaceFailure: false, sandboxFailure: false, checkFailure: false, operationNotPermitted: false,
  crashpadDatabaseRequired: false, crashpadDatabaseInitializationFailed: false, readOnlyFileSystem: false };
const browserResult = (facts, exitCode = null, signals = [], markers = {}) =>
  ({ schemaVersion: 1, facts, exitCode, signals, markers: { ...browserMarkers, ...markers } });

test('actual browser-launch classifier retains only finite safe facts and bounded exit codes', () => {
  const failure = (text) => new Error(`${text}\n${privateDiagnostic}`);
  const expected = browserResult;
  for (const [error, result] of [
    [failure('[pid=123][err] Failed to move to new namespace: failed: errno = Operation not permitted'), expected(['namespace-denied'], null, [], { namespaceFailure: true, operationNotPermitted: true })],
    [failure('[pid=123][err] No usable sandbox!'), expected(['sandbox-unavailable'], null, [], { sandboxFailure: true })],
    [failure("browserType.launch: Executable doesn't exist at /sensitive/path"), expected(['executable-missing'])],
    [Object.assign(failure('spawn error'), { code: 'ENOENT' }), expected(['launch-enoent'])],
    [failure('Host system is missing dependencies to run browsers'), expected(['dependency-missing'])],
    [failure('[pid=123][err] error while loading shared libraries: /sensitive/library'), expected(['dependency-missing'])],
    [failure('[pid=123] <process did exit: exitCode=1, signal=null>'), expected(['process-exited'], 1)],
    [failure('[pid=123] <process did exit: exitCode=null, signal=SIGSEGV>'), expected(['process-exited', 'process-crashed'], null, ['SIGSEGV'])],
    [failure('browserType.launch: Target page, context or browser has been closed'), expected(['target-closed'])],
    [Object.assign(failure('deadline'), { name: 'TimeoutError' }), expected(['timeout'])],
  ]) {
    const actual = classifyBrowserLaunchFailure(error);
    assert.deepEqual(actual, result);
    assert.ok(!JSON.stringify(actual).includes('PRIVATE_DIAGNOSTIC'));
    assert.ok(!JSON.stringify(actual).includes('/sensitive/'));
  }
  for (const error of [null, {}, privateDiagnostic, failure('unrecognized'), failure('quoted Failed to move to new namespace: Operation not permitted'),
    failure(`browserType.launch: Executable doesn't exist at ${'x'.repeat(64 * 1024)}`)]) {
    assert.deepEqual(classifyBrowserLaunchFailure(error), expected(['unclassified']));
  }
  assert.equal(classifyBrowserLaunchFailure(failure('[pid=1] <process did exit: exitCode=256, signal=null>')).exitCode, null);
  assert.equal(classifyBrowserLaunchFailure(failure('[pid=1] <process did exit: exitCode=1, signal=null>\n[pid=2] <process did exit: exitCode=2, signal=null>')).exitCode, null);
});

test('browser diagnostic validator rejects unknown, duplicate, private and invalid exit values', () => {
  const safe = browserResult(['process-exited'], 1);
  assert.deepEqual(sanitizeBrowserLaunchDiagnostic(safe), safe);
  for (const value of [null, [], {}, { ...safe, raw: privateDiagnostic }, { ...safe, schemaVersion: 2 },
    { ...safe, facts: [privateDiagnostic] }, { ...safe, facts: [] }, { ...safe, facts: ['process-exited', 'process-exited'] },
    { ...safe, facts: ['unclassified', 'process-exited'] }, { ...safe, facts: ['timeout'] },
    ...[undefined, true, -1, 256, 1.5, NaN, Infinity, '1', privateDiagnostic].map((exitCode) => ({ ...safe, exitCode })),
  ]) assert.equal(sanitizeBrowserLaunchDiagnostic(value), null);
});

test('browser-launch diagnostics are attached only to actual sandboxed launch failures', () => {
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /try \{\s*browser = await chromium\.launch\(\{ headless: true, chromiumSandbox: true \}\);\s*\} catch \(error\) \{\s*evidence\.browserLaunchDiagnostic = classifyBrowserLaunchFailure\(error\);\s*evidence\.browserPrerequisites = await collectBrowserPrerequisites\(\);\s*throw error;/);
});

test('individual browser diagnostic semantic mutants are rejected by actual classifier and validator probes', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutations = [
    ["facts.push('namespace-denied')", "facts.push('unclassified')", (api) => assert.deepEqual(api.classifyBrowserLaunchFailure(new Error('Failed to move to new namespace: Operation not permitted')).facts, ['namespace-denied'])],
    ["facts.push('dependency-missing')", "facts.push('unclassified')", (api) => assert.deepEqual(api.classifyBrowserLaunchFailure(new Error('Host system is missing dependencies to run browsers')).facts, ['dependency-missing'])],
    ["Buffer.byteLength(error.message, 'utf8') > BROWSER_LAUNCH_MESSAGE_LIMIT", 'false', (api) => assert.deepEqual(api.classifyBrowserLaunchFailure(new Error(`Host system is missing dependencies to run browsers ${'x'.repeat(64 * 1024)}`)).facts, ['unclassified'])],
    ["Object.keys(value).sort().join(',') !== 'exitCode,facts,markers,schemaVersion,signals'", 'false', (api) => assert.equal(api.sanitizeBrowserLaunchDiagnostic({ ...browserResult(['timeout']), raw: privateDiagnostic }), null)],
    ["!BROWSER_LAUNCH_FACTS.includes(fact)", 'false', (api) => assert.equal(api.sanitizeBrowserLaunchDiagnostic(browserResult([privateDiagnostic])), null)],
    ["value.exitCode > 255", 'false', (api) => assert.equal(api.sanitizeBrowserLaunchDiagnostic(browserResult(['process-exited'], 256)), null)],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ classifyBrowserLaunchFailure, sanitizeBrowserLaunchDiagnostic });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'each browser diagnostic mutation must be rejected');
  }
});

test('pinned Playwright sandbox rewrite and bullet call logs yield only bounded categorical facts', () => {
  const text = `browserType.launch: Target page, context or browser has been closed\n` +
    `╔════════════════════════════════╗\n║ Chromium sandboxing failed!    ║\n╚════════════════════════════════╝\n` +
    `Call log:\n  - [pid=123][err] Failed to move to new namespace: errno = Operation not permitted\n` +
    `  - [pid=123] <process did exit: exitCode=1, signal=null>\n${privateDiagnostic}`;
  assert.deepEqual(classifyBrowserLaunchFailure(new Error(text)), browserResult(
    ['namespace-denied', 'sandbox-unavailable', 'process-exited', 'target-closed'], 1, [],
    { namespaceFailure: true, operationNotPermitted: true, sandboxFailure: true }));
  const crash = new Error('Call log:\n  - [pid=9] <process did exit: exitCode=null, signal=SIGSEGV>');
  assert.deepEqual(classifyBrowserLaunchFailure(crash), browserResult(['process-exited', 'process-crashed'], null, ['SIGSEGV']));
  for (const text of ['private text Chromium sandboxing failed!', 'quoted - [pid=123][err] Failed to move to new namespace: EPERM',
    'quoted - [pid=123] <process did exit: exitCode=1, signal=null>']) {
    assert.deepEqual(classifyBrowserLaunchFailure(new Error(text)), browserResult(['unclassified']));
  }
  assert.ok(!JSON.stringify(classifyBrowserLaunchFailure(new Error(text))).includes('PRIVATE_DIAGNOSTIC'));
});

test('pinned rewrite and bullet parser semantic mutants fail actual classifier probes', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutations = [
    ['Chromium sandboxing failed!', 'Chromium sandboxing changed!',
      (api) => assert.ok(api.classifyBrowserLaunchFailure(new Error('║ Chromium sandboxing failed! ║')).facts.includes('sandbox-unavailable'))],
    [String.raw`(?:[ \t]*-[ \t]+)?[ \t]*(?:\[pid=\d+\]\[err\][ \t]*)?`, String.raw`[ \t]*(?:\[pid=\d+\]\[err\][ \t]*)?`,
      (api) => assert.ok(api.classifyBrowserLaunchFailure(new Error('  - [pid=2][err] Failed to move to new namespace: EPERM')).facts.includes('namespace-denied'))],
    [String.raw`(?:-[ \t]+)?(?:\[pid=\d+\][ \t]*)?`, String.raw`(?:\[pid=\d+\][ \t]*)?`,
      (api) => assert.equal(api.classifyBrowserLaunchFailure(new Error('  - [pid=2] <process did exit: exitCode=1, signal=null>')).exitCode, 1)],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ classifyBrowserLaunchFailure });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'each pinned format mutation must be rejected');
  }
});

test('C++ logger causes and exact finite signals survive without retaining messages or paths', () => {
  const prefix = '  - [pid=7][err] [7:8:0710/120000.123456:FATAL:zygote_host_impl_linux.cc(202)] ';
  for (const [body, markers, facts = ['public-cause-marker']] of [
    ['Failed to move to new namespace: errno = Operation not permitted', { namespaceFailure: true, operationNotPermitted: true }, ['namespace-denied']],
    ['No usable sandbox!', { sandboxFailure: true }, ['sandbox-unavailable']],
    ['Check failed: result: Operation not permitted (1)', { checkFailure: true, operationNotPermitted: true }],
    ['chrome_crashpad_handler: --database is required', { crashpadDatabaseRequired: true }],
    [`Failed to initialize Crashpad database at ${privateDiagnostic}`, { crashpadDatabaseInitializationFailed: true }],
    [`mkdir ${privateDiagnostic}: Read-only file system (30)`, { readOnlyFileSystem: true }],
  ]) {
    for (const logger of [prefix, prefix.replace('.cc(202)', '.cc:202')]) {
      const result = classifyBrowserLaunchFailure(new Error(logger + body));
      assert.deepEqual(result, browserResult(facts, null, [], markers));
      assert.ok(!JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'));
      assert.ok(!JSON.stringify(result).includes('zygote_host_impl_linux'));
    }
  }
  const exited = (signal) => `  - [pid=7] <process did exit: exitCode=null, signal=${signal}>`;
  assert.deepEqual(classifyBrowserLaunchFailure(new Error([exited('SIGTRAP'), exited('SIGSYS'), exited('SIGTRAP')].join('\n'))),
    browserResult(['process-exited', 'process-crashed'], null, ['SIGTRAP', 'SIGSYS']));
  assert.deepEqual(classifyBrowserLaunchFailure(new Error(exited('SIGKILL'))), browserResult(['process-exited'], null, ['SIGKILL']));
  assert.deepEqual(classifyBrowserLaunchFailure(new Error(exited('SIGPRIVATE'))), browserResult(['process-exited']));
  for (const text of ['quoted Check failed: EPERM', 'private text Read-only file system', 'quoted chrome_crashpad_handler: --database is required']) {
    assert.deepEqual(classifyBrowserLaunchFailure(new Error(text)), browserResult(['unclassified']));
  }
  const safe = browserResult(['process-exited'], 1);
  for (const signals of [null, 'SIGTRAP', [privateDiagnostic], ['SIGTRAP', 'SIGTRAP']]) {
    assert.equal(sanitizeBrowserLaunchDiagnostic({ ...safe, signals }), null);
  }
  for (const name of Object.keys(browserMarkers)) {
    const missing = { ...safe.markers }; delete missing[name];
    assert.equal(sanitizeBrowserLaunchDiagnostic({ ...safe, markers: missing }), null);
    assert.equal(sanitizeBrowserLaunchDiagnostic({ ...safe, markers: { ...safe.markers, [name]: privateDiagnostic } }), null);
  }
  assert.equal(sanitizeBrowserLaunchDiagnostic({ ...safe, markers: { ...safe.markers, raw: privateDiagnostic } }), null);
});

const probeResult = (outcome, exitCode = null, signal = null) => ({ schemaVersion: 1, scope: 'user-pid-namespace-only', outcome, exitCode, signal,
  kernelFlags: { unprivilegedUsernsClone: 1, apparmorRestrictUnprivilegedUserns: 0 } });

test('failure-only prerequisite uses exactly one ignored-stdio user/PID probe and no qualification data', async () => {
  for (const [event, args, expected] of [
    ['exit', [0, null], probeResult('exited', 0)], ['exit', [1, null], probeResult('exited', 1)],
    ['exit', [null, 'SIGSYS'], probeResult('signaled', null, 'SIGSYS')],
    ['exit', [null, 'SIGPRIVATE'], probeResult('unobserved')], ['error', [new Error(privateDiagnostic)], probeResult('spawn-error')],
  ]) {
    let count = 0; const paths = [];
    const result = await collectBrowserPrerequisites((command, argv, options) => {
      count++;
      assert.equal(command, '/usr/bin/unshare');
      assert.deepEqual(argv, ['--user', '--map-root-user', '--pid', '--fork', '/usr/bin/true']);
      assert.deepEqual(options, { stdio: 'ignore' });
      const child = new EventEmitter(); queueMicrotask(() => child.emit(event, ...args)); return child;
    }, (path) => { paths.push(path); return path.endsWith('/unprivileged_userns_clone') ? '1\n' : '0\n'; });
    assert.equal(count, 1);
    assert.deepEqual(paths, ['/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns']);
    assert.deepEqual(result, expected);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'));
  }
});

test('prerequisite deadline kills only its owned child at three seconds and never invents an observed signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const killed = [], child = new EventEmitter(); child.kill = (signal) => killed.push(signal);
    let settled = false;
    const pending = collectBrowserPrerequisites(() => child, () => null).then((value) => { settled = true; return value; });
    t.mock.timers.tick(2999); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(settled, true);
    assert.deepEqual(await pending, { ...probeResult('timed-out'), kernelFlags: { unprivilegedUsernsClone: null, apparmorRestrictUnprivilegedUserns: null } });
    assert.deepEqual(killed, ['SIGKILL']);
  } finally { t.mock.timers.reset(); }
});

test('prerequisite schema and kernel parser reject arbitrary values before retention', () => {
  for (const [raw, expected] of [['0', 0], ['0\n', 0], ['1', 1], ['1\n', 1]]) assert.equal(parseKernelUsernsFlag(raw), expected);
  for (const raw of [null, true, 1, '01', '1\n\n', '1\r\n', ' 1', privateDiagnostic, '1'.repeat(64)]) assert.equal(parseKernelUsernsFlag(raw), null);
  const safe = probeResult('exited', 0);
  assert.deepEqual(sanitizeBrowserPrerequisiteDiagnostic(safe), safe);
  for (const value of [{ ...safe, raw: privateDiagnostic }, { ...safe, scope: privateDiagnostic }, { ...safe, outcome: privateDiagnostic },
    { ...safe, signal: 'SIGSYS' }, { ...safe, exitCode: 256 }, { ...safe, exitCode: true }, { ...safe, kernelFlags: null },
    { ...probeResult('signaled', null, 'SIGPRIVATE') },
    ...[undefined, true, 2, -1, '1', privateDiagnostic].map((flag) => ({ ...safe, kernelFlags: { ...safe.kernelFlags, unprivilegedUsernsClone: flag } })),
  ]) assert.equal(sanitizeBrowserPrerequisiteDiagnostic(value), null);
});

test('cause, signal and prerequisite guards reject individual semantic mutants after original positives', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutations = [
    ['const normalized = cpp ? cpp[1] + line.slice(cpp[0].length) : line;', 'const normalized = line;',
      (api) => assert.equal(api.classifyBrowserLaunchFailure(new Error('[1:2:0710/120000.123456:FATAL:zygote.cc(202)] Check failed: value')).markers.checkFailure, true)],
    ['!BROWSER_SIGNALS.includes(signal)', 'false',
      (api) => assert.equal(api.sanitizeBrowserLaunchDiagnostic(browserResult(['process-exited'], null, [privateDiagnostic])), null)],
    ["typeof value.markers[name] !== 'boolean'", 'false',
      (api) => assert.equal(api.sanitizeBrowserLaunchDiagnostic(browserResult(['timeout'], null, [], { checkFailure: privateDiagnostic })), null)],
    ["['0', '1', '0\\n', '1\\n'].includes(text)", 'true', (api) => assert.equal(api.parseKernelUsernsFlag('2'), null)],
    ['report.exitCode > 255', 'false', (api) => assert.equal(api.sanitizeBrowserPrerequisiteDiagnostic(probeResult('exited', 256)), null)],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ classifyBrowserLaunchFailure, sanitizeBrowserLaunchDiagnostic, parseKernelUsernsFlag, sanitizeBrowserPrerequisiteDiagnostic });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'each guard mutant must fail an actual diagnostic assertion');
  }
});

const publicBrowserEnvironment = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp', TMPDIR: '/qa/tmp',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
function publicLauncher(events, launchError, closeError) {
  return { launch: async (options) => {
    assert.deepEqual(options, { headless: true, chromiumSandbox: true, env: publicBrowserEnvironment });
    events.push('launch');
    if (launchError) throw launchError;
    return { close: async () => { events.push('close'); if (closeError) throw closeError; } };
  } };
}

async function requirePublicBootstrapOrder(api) {
  for (const [mode, cases] of [['admission', ['admission']], ['full', ['direct', 'hls', 'stall']]]) {
    const events = [], summary = { fullQualification: false };
    await api.runCasesAfterPublicBootstrap(publicLauncher(events), mode, 'unused', summary,
      async (_browser, name) => events.push(name));
    assert.deepEqual(events, ['launch', 'close', ...cases]);
    assert.deepEqual(summary.publicBrowserBootstrap, publicBootstrapPassed);
    assert.equal(summary.fullQualification, false);
  }
}

async function requirePublicBootstrapBarrier(api) {
  const events = [], summary = {};
  await assert.rejects(api.runCasesAfterPublicBootstrap(publicLauncher(events, new Error('PUBLIC_BOOTSTRAP_TEST_DETAIL')),
    'admission', 'unused', summary, async () => events.push('fixture')), { message: 'Public browser bootstrap failed before fixture' });
  assert.deepEqual(events, ['launch']);
  assert.deepEqual(summary.publicBrowserBootstrap, { ...publicBootstrapPassed, outcome: 'failed', phase: 'launch', errorMessage: 'PUBLIC_BOOTSTRAP_TEST_DETAIL' });
}

test('public sandboxed no-context bootstrap closes before every unchanged fixture case and stops on failure', async () => {
  await requirePublicBootstrapOrder({ runCasesAfterPublicBootstrap });
  await requirePublicBootstrapBarrier({ runCasesAfterPublicBootstrap });
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(main, /await runCasesAfterPublicBootstrap\(chromium, mode, output, summary\)/);
  assert.doesNotMatch(main, /await runCase\(/);
  assert.equal(validateReceipts('full', fullSummary, {}, 100), false, 'bootstrap alone cannot replace any playback case');
  assert.equal(validateReceipts('full', { ...fullSummary, publicBrowserBootstrap: null }, fullCases, 100), false);
});

test('only pre-fixture public errors retain capped UTF-8 messages, never stacks or actual-app text', async () => {
  const error = new Error('PUBLIC_BOOTSTRAP_TEST_DETAIL'); let stackReads = 0;
  Object.defineProperty(error, 'stack', { get() { stackReads++; throw new Error('stack must not be read'); } });
  const report = await runPublicBrowserBootstrap(publicLauncher([], error));
  assert.equal(report.errorMessage, error.message); assert.equal(stackReads, 0);
  assert.ok(!JSON.stringify(classifyBrowserLaunchFailure(error)).includes(error.message));
  const closed = await runPublicBrowserBootstrap(publicLauncher([], null, new Error('PUBLIC_CLOSE_TEST_DETAIL')));
  assert.deepEqual(closed, { ...publicBootstrapPassed, outcome: 'failed', phase: 'close', errorMessage: 'PUBLIC_CLOSE_TEST_DETAIL' });
  for (const message of ['x'.repeat(16 * 1024 + 1), '€'.repeat(9000)]) {
    const capped = await runPublicBrowserBootstrap(publicLauncher([], new Error(message)));
    assert.equal(capped.messageTruncated, true);
    assert.ok(Buffer.byteLength(capped.errorMessage, 'utf8') <= 16 * 1024);
    assert.ok(!capped.errorMessage.includes('\ufffd'));
  }
});

test('public bootstrap report requires exact scope, keys, byte cap and non-qualification', () => {
  assert.deepEqual(sanitizePublicBrowserBootstrap(publicBootstrapPassed), publicBootstrapPassed);
  const failed = { ...publicBootstrapPassed, outcome: 'failed', phase: 'launch', errorMessage: 'public detail' };
  assert.deepEqual(sanitizePublicBrowserBootstrap(failed), failed);
  for (const key of Object.keys(failed)) { const value = { ...failed }; delete value[key]; assert.equal(sanitizePublicBrowserBootstrap(value), null); }
  for (const value of [{ ...failed, env: 'must-not-retain' }, { ...failed, scope: 'actual-app' }, { ...failed, fullQualification: true },
    { ...failed, outcome: 'unknown' }, { ...failed, phase: 'complete' }, { ...failed, errorMessage: null },
    { ...failed, errorMessage: 'x'.repeat(16 * 1024 + 1) }, { ...failed, messageTruncated: 'false' },
    { ...publicBootstrapPassed, errorMessage: 'not a failure' },
  ]) assert.equal(sanitizePublicBrowserBootstrap(value), null);
});

test('public bootstrap environment, schema, failure barrier and ordering mutants fail actual semantic probes', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const control = '  summary.publicBrowserBootstrap = await runPublicBrowserBootstrap(chromium);';
  const barrier = "  if (summary.publicBrowserBootstrap.outcome !== 'passed') throw new Error('Public browser bootstrap failed before fixture');";
  const cases = "  for (const name of mode === 'admission' ? ['admission'] : ['direct', 'hls', 'stall']) await executeCase(chromium, name, output);";
  const failed = { ...publicBootstrapPassed, outcome: 'failed', phase: 'launch', errorMessage: 'x'.repeat(16 * 1024 + 1) };
  const mutations = [
    ['env: { ...PUBLIC_BROWSER_ENV }', "env: { ...PUBLIC_BROWSER_ENV, EXTRA_PUBLIC_VALUE: 'public' }",
      async (api) => assert.deepEqual(await api.runPublicBrowserBootstrap(publicLauncher([])), publicBootstrapPassed)],
    ["Buffer.byteLength(value.errorMessage, 'utf8') > PUBLIC_BOOTSTRAP_MESSAGE_LIMIT", 'false',
      async (api) => assert.equal(api.sanitizePublicBrowserBootstrap(failed), null)],
    ["value.scope !== 'public-browser-bootstrap-before-fixture'", 'false',
      async (api) => assert.equal(api.sanitizePublicBrowserBootstrap({ ...publicBootstrapPassed, scope: 'actual-app' }), null)],
    [barrier, '', requirePublicBootstrapBarrier],
    [[control, barrier, cases].join('\n'), [cases, control, barrier].join('\n'), requirePublicBootstrapOrder],
  ];
  for (const [from, to, probe] of mutations) {
    await probe({ runPublicBrowserBootstrap, runCasesAfterPublicBootstrap, sanitizePublicBrowserBootstrap });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { await probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true, 'each public bootstrap mutation must fail an actual semantic assertion');
  }
});

const syntheticJpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x10, 0xff, 0xd9,
]);
const safeUiState = { dialogCount: 1, inputCount: 2, ready: true, skipTourVisible: false, videoCount: 0, watchlistButtonCount: 1, watchlistVisible: true };
const uiDiagnostic = (bytes = syntheticJpeg) => ({ schemaVersion: 1, state: safeUiState,
  screenshot: { filename: 'failure.jpg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
const failedUiReceipt = (bytes = syntheticJpeg) => ({ case: 'admission', outcome: 'failed', fullQualification: false, uiDiagnostic: uiDiagnostic(bytes) });

test('UI report accepts only bounded fixed state and viewport JPEG metadata', () => {
  assert.deepEqual(sanitizeUiFailureDiagnostic(uiDiagnostic()), uiDiagnostic());
  assert.equal(isBoundedViewportJpeg(syntheticJpeg), true);
  for (const value of [{ ...uiDiagnostic(), raw: privateDiagnostic }, { ...uiDiagnostic(), state: { ...safeUiState, raw: privateDiagnostic } },
    { ...uiDiagnostic(), state: { ...safeUiState, ready: 'true' } }, { ...uiDiagnostic(), state: { ...safeUiState, inputCount: 100 } },
    { ...uiDiagnostic(), screenshot: { ...uiDiagnostic().screenshot, filename: '../failure.jpg' } },
    { ...uiDiagnostic(), screenshot: { ...uiDiagnostic().screenshot, sha256: privateDiagnostic } },
    { ...uiDiagnostic(), screenshot: { ...uiDiagnostic().screenshot, bytes: 524289 } },
  ]) assert.equal(sanitizeUiFailureDiagnostic(value), null);
  for (const data of [Buffer.alloc(0), Buffer.from('not jpeg'), Buffer.concat([syntheticJpeg, Buffer.from([0])]),
    Buffer.from(syntheticJpeg.map((byte, index) => index === 9 ? 0x01 : byte)),
    Buffer.concat([syntheticJpeg.subarray(0, -2), Buffer.alloc(524288), syntheticJpeg.subarray(-2)]),
  ]) assert.equal(isBoundedViewportJpeg(data), false);
});

test('actual failure capture is origin and viewport bounded and masks controls without retaining page text', async () => {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), 'foreground-ui-'));
  let captures = 0;
  const locator = (selector) => ({ selector, count: async () => selector === 'input,textarea,select' ? 2 : selector === 'video' ? 0 : 1, first() { return this; }, isVisible: async () => selector === 'Watchlist' });
  const page = {
    isClosed: () => false, url: () => 'http://127.0.0.1:43120/', viewportSize: () => ({ width: 1280, height: 720 }),
    getByRole: (role, options) => locator(options?.name ?? role), locator, evaluate: async () => true,
    screenshot: async (options) => {
      captures += 1;
      assert.equal(options.type, 'jpeg'); assert.equal(options.fullPage, false); assert.equal(options.maskColor, '#000000');
      for (const selector of ['input', 'textarea', 'code', 'pre', 'iframe', 'password', 'token', 'secret']) assert.ok(options.mask[0].selector.includes(selector));
      return syntheticJpeg;
    },
  };
  try {
    const result = await captureFailureUi(page, dir);
    assert.deepEqual(result, uiDiagnostic());
    assert.deepEqual(readFileSync(join(dir, 'failure.jpg')), syntheticJpeg);
    assert.ok(!JSON.stringify(result).includes(privateDiagnostic));
    const other = { ...page, url: () => 'https://private.invalid/' };
    assert.equal(await captureFailureUi(other, dir), null);
    assert.equal(captures, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withScreenshotFiles(probe) {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), 'foreground-copy-'));
  const source = join(root, 'case'), dest = join(root, 'evidence');
  mkdirSync(source); mkdirSync(dest);
  writeFileSync(join(source, 'failure.jpg'), syntheticJpeg);
  writeFileSync(join(source, 'result.json'), JSON.stringify(failedUiReceipt()));
  try { probe(source, dest); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('actual copy guard accepts only a matching failed receipt, regular image, and bounded total', () => {
  withScreenshotFiles((source, dest) => {
    assert.equal(copyFailureScreenshot(source, dest, 'admission'), true);
    assert.deepEqual(readFileSync(join(dest, 'failure-admission.jpg')), syntheticJpeg);
  });
  withScreenshotFiles((source, dest) => {
    writeFileSync(join(source, 'result.json'), JSON.stringify({ ...failedUiReceipt(), outcome: 'passed' }));
    assert.equal(copyFailureScreenshot(source, dest, 'admission'), false);
  });
  withScreenshotFiles((source, dest) => {
    writeFileSync(join(source, 'result.json'), JSON.stringify({ ...failedUiReceipt(), uiDiagnostic: { ...uiDiagnostic(), screenshot: { ...uiDiagnostic().screenshot, sha256: 'a'.repeat(64) } } }));
    assert.equal(copyFailureScreenshot(source, dest, 'admission'), false);
  });
  withScreenshotFiles((source, dest) => {
    rmSync(join(source, 'failure.jpg')); writeFileSync(join(source, 'target.jpg'), syntheticJpeg);
    symlinkSync(join(source, 'target.jpg'), join(source, 'failure.jpg'));
    assert.equal(copyFailureScreenshot(source, dest, 'admission'), false);
  });
  withScreenshotFiles((source, dest) => {
    writeFileSync(join(dest, 'large'), 'x'); truncateSync(join(dest, 'large'), 32 * 1024 * 1024);
    assert.equal(copyFailureScreenshot(source, dest, 'admission'), false);
  });
});

test('failure capture and copy are absent from the positive path', () => {
  const driver = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/foreground-playback-qa.yml', import.meta.url), 'utf8');
  assert.match(driver, /\} catch \(error\) \{\s*evidence\.failureCode = failureCode\(error\);\s*failure = error;\s*try \{\s*const diagnostic = await captureFailureUi\(page, caseDir\)/);
  assert.match(workflow, /if test "\$status" -eq 0 && test "\$image_count" -ne 0/);
  assert.match(workflow, /if test "\$status" -ne 0; then[\s\S]*--copy-failure-screenshot/);
});

test('individual failure screenshot report and copy mutants are rejected behaviorally', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutations = [
    ["receipt.outcome !== 'failed'", 'false', (api) => withScreenshotFiles((source, dest) => {
      writeFileSync(join(source, 'result.json'), JSON.stringify({ ...failedUiReceipt(), outcome: 'passed' }));
      assert.equal(api.copyFailureScreenshot(source, dest, 'admission'), false);
    })],
    ["diag.screenshot.sha256 !== createHash('sha256').update(bytes).digest('hex')", 'false', (api) => withScreenshotFiles((source, dest) => {
      writeFileSync(join(source, 'result.json'), JSON.stringify({ ...failedUiReceipt(), uiDiagnostic: { ...uiDiagnostic(), screenshot: { ...uiDiagnostic().screenshot, sha256: 'a'.repeat(64) } } }));
      assert.equal(api.copyFailureScreenshot(source, dest, 'admission'), false);
    })],
    ["Object.keys(value.state).sort().join(',') !== UI_STATE_KEYS.join(',')", 'false', (api) => assert.equal(api.sanitizeUiFailureDiagnostic({ ...uiDiagnostic(), state: { ...safeUiState, raw: privateDiagnostic } }), null)],
    ["fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);", 'fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);', (api) => withScreenshotFiles((source, dest) => {
      rmSync(join(source, 'failure.jpg')); writeFileSync(join(source, 'target.jpg'), syntheticJpeg);
      symlinkSync(join(source, 'target.jpg'), join(source, 'failure.jpg'));
      assert.equal(api.copyFailureScreenshot(source, dest, 'admission'), false);
    })],
    ["bytes.length > FAILURE_JPEG_LIMIT", 'false', (api) => assert.equal(api.isBoundedViewportJpeg(Buffer.concat([syntheticJpeg.subarray(0, -2), Buffer.alloc(524288), syntheticJpeg.subarray(-2)])), false)],
    ["total += info.size;\n      if (total > EVIDENCE_LIMIT) return false;\n    }\n    writeFileSync(`${evidenceDir}/failure-${name}.jpg`", "total += info.size;\n      if (false) return false;\n    }\n    writeFileSync(`${evidenceDir}/failure-${name}.jpg`", (api) => withScreenshotFiles((source, dest) => {
      writeFileSync(join(dest, 'large'), 'x'); truncateSync(join(dest, 'large'), 32 * 1024 * 1024);
      assert.equal(api.copyFailureScreenshot(source, dest, 'admission'), false);
    })],
  ];
  for (const [from, to, probe] of mutations) {
    probe({ copyFailureScreenshot, sanitizeUiFailureDiagnostic, isBoundedViewportJpeg });
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { probe(mutant); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); rejected = true; }
    assert.equal(rejected, true);
  }
});


test('failure receipt and image descriptors use nonblocking no-follow opens', () => {
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function readGuardedBytes('), source.indexOf('export function copyFailureScreenshot('));
  const expected = /openSync\(path, constants\.O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK\)/;
  assert.match(body, expected);
  assert.doesNotMatch(body.replace(' | constants.O_NONBLOCK', ''), expected);
});


test('fresh fixture waits for its real tour dismissal before Watchlist input', () => {
  const source = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const from = source.indexOf("    evidence.phase = 'tour';");
  const to = source.indexOf("    evidence.phase = 'watchlist';", from);
  assert.ok(from >= 0 && to > from);
  const validate = (text) => {
    assert.match(text, /await skipTour\.click\(\{ timeout: 60_000 \}\);/);
    assert.doesNotMatch(text, /if \(await skipTour\.isVisible\(\)\)/);
  };
  const tour = source.slice(from, to);
  validate(tour);
  assert.throws(() => validate(tour.replace('await skipTour.click({ timeout: 60_000 });', 'if (await skipTour.isVisible()) await skipTour.click();')), { code: 'ERR_ASSERTION' });
});


function qualityPage({ remount = false, initiallyActive = false, neverActive = false, ignoreFirstClose = false, enabledAfterTicks = 0, neverEnabled = false, throwAfterSelection = false } = {}) {
  const state = { now: 0, menu: false, active: initiallyActive, selected: false, qualityClicks: 0, openClicks: 0, closeClicks: 0, ticks: 0, enabledChecks: 0, timeouts: [] };
  const bounded = (options) => {
    assert.ok(options && Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 1000);
    assert.ok(options.timeout <= 3000 - state.now);
    state.timeouts.push(options.timeout);
  };
  const quality = {
    isVisible: async () => state.menu,
    getAttribute: async (name, options) => { bounded(options); assert.equal(name, 'aria-pressed'); assert.equal(state.menu, true); return state.active ? 'true' : 'false'; },
    isEnabled: async (options) => { bounded(options); state.enabledChecks += 1; return !neverEnabled && state.ticks >= enabledAfterTicks; },
    click: async (options) => {
      bounded(options); assert.equal(state.menu, true); assert.ok(!neverEnabled && state.ticks >= enabledAfterTicks);
      state.qualityClicks += 1; state.selected = true; if (remount) state.menu = false;
      if (throwAfterSelection && state.qualityClicks === 1) { const error = new Error('unknown click delivery'); error.name = 'TimeoutError'; throw error; }
    },
  };
  const settings = { click: async (options) => { bounded(options); assert.equal(state.menu, false); state.menu = true; state.openClicks += 1; } };
  const closeSettings = { click: async (options) => {
    bounded(options); assert.equal(state.menu, true); state.closeClicks += 1;
    if (!(ignoreFirstClose && state.closeClicks === 1)) state.menu = false;
  } };
  const page = {
    getByText: (text, options) => { assert.equal(text, 'Streaming mode'); assert.equal(options.exact, true); return { isVisible: async () => state.menu }; },
    getByRole: (role, options) => { assert.equal(role, 'button'); assert.equal(options.exact, true); assert.ok(['480p', 'Playback settings', 'Close playback settings'].includes(options.name)); return options.name === '480p' ? quality : options.name === 'Playback settings' ? settings : closeSettings; },
    locator: (name) => { assert.equal(name, 'video'); return { hover: async (options) => bounded(options) }; },
  };
  const options = { timeoutMs: 3000, now: () => state.now, wait: async (ms) => {
    assert.ok(ms > 0 && ms <= Math.min(250, 3000 - state.now));
    state.now += ms; state.ticks += 1;
    if (state.selected && state.ticks >= 3 && !neverActive) state.active = true;
  } };
  return { page, options, state };
}
async function requireQualityHandoff(helper) {
  for (const remount of [false, true]) {
    const { page, options, state } = qualityPage({ remount });
    await helper(page, options);
    assert.equal(state.qualityClicks, 1);
    assert.equal(state.active, true);
    assert.equal(state.menu, false);
    assert.equal(state.openClicks, remount ? 2 : 1);
    assert.ok(state.timeouts.length > 0);
  }
  const already = qualityPage({ initiallyActive: true });
  await helper(already.page, already.options);
  assert.equal(already.state.qualityClicks, 0);
  assert.equal(already.state.menu, false);
  const ignoredClose = qualityPage({ initiallyActive: true, ignoreFirstClose: true });
  await helper(ignoredClose.page, ignoredClose.options);
  assert.equal(ignoredClose.state.menu, false);
  assert.equal(ignoredClose.state.qualityClicks, 0);
  const disabled = qualityPage({ enabledAfterTicks: 4 });
  await helper(disabled.page, disabled.options);
  assert.equal(disabled.state.qualityClicks, 1);
  assert.ok(disabled.state.enabledChecks > 1);
  assert.equal(disabled.state.menu, false);
  const uncertain = qualityPage({ throwAfterSelection: true });
  await helper(uncertain.page, uncertain.options);
  assert.equal(uncertain.state.qualityClicks, 1);
  assert.equal(uncertain.state.menu, false);
}
async function requirePendingFails(helper) {
  const pending = qualityPage({ neverActive: true });
  await assert.rejects(helper(pending.page, pending.options));
  assert.equal(pending.state.qualityClicks, 1);
  assert.equal(pending.state.now, 3000);
  const disabled = qualityPage({ neverEnabled: true });
  await assert.rejects(helper(disabled.page, disabled.options));
  assert.equal(disabled.state.qualityClicks, 0);
  assert.ok(disabled.state.enabledChecks > 0);
  assert.equal(disabled.state.now, 3000);
}
function requireQualityBinding(source) {
  const start = source.indexOf("      evidence.phase = 'quality';");
  const end = source.indexOf("    evidence.phase = 'firstframe';", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /await selectAndVerify480p\(page\);/);
  assert.ok(block.indexOf('await selectAndVerify480p(page);') < block.indexOf("evidence.optimizedQuality = '480p';"));
  assert.doesNotMatch(block, /getAttribute|\.click\(/);
}
test('actual quality helper handles retained and remounted menus, closes settings and never reselects active quality', async () => {
  await requireQualityHandoff(selectAndVerify480p);
  await requirePendingFails(selectAndVerify480p);
  requireQualityBinding(readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8'));
});
test('quality helper semantic mutants cannot pass the original positive and pending probes', async () => {
  const original = readFileSync(new URL('./foreground_playback_gate.mjs', import.meta.url), 'utf8');
  const mutants = [
    ["if (!(await menu.isVisible())) {", "if (!(await menu.isVisible()) && !selected) {"],
    ["if (pressed === 'true') {", "if (pressed !== null) {"],
    ["} else if (!selected && await quality.isEnabled({ timeout: actionTimeout() })) {", "} else if (await quality.isEnabled({ timeout: actionTimeout() })) {"],
    ["await quality.isEnabled({ timeout: actionTimeout() })", "true"],
    ["          selected = true;\n          await quality.click({ timeout: actionTimeout() });", "          await quality.click({ timeout: actionTimeout() });\n          selected = true;"],
    ["await closeSettings.click({ timeout: actionTimeout() });", "await settings.click({ timeout: actionTimeout() });"],
    ["if (!(await menu.isVisible())) return;", "return;"],
  ];
  for (const [from, to] of mutants) {
    await requireQualityHandoff(selectAndVerify480p);
    await requirePendingFails(selectAndVerify480p);
    assert.equal(original.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(original.replace(from, to)).toString('base64')}`);
    let rejected = false;
    try { await requireQualityHandoff(mutant.selectAndVerify480p); await requirePendingFails(mutant.selectAndVerify480p); }
    catch (error) { assert.ok(error instanceof Error); rejected = true; }
    assert.equal(rejected, true);
  }
  requireQualityBinding(original);
  assert.throws(() => requireQualityBinding(original.replace('await selectAndVerify480p(page);', 'await Promise.resolve();')), { code: 'ERR_ASSERTION' });
});
