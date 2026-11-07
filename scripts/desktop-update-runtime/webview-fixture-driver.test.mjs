import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
import { requiredWebviewBaseStages, requiredWebviewNextStages, verifyRuntimeEvents, startRuntimeService } from './runtime-service.mjs';
import { runMacosQualification } from './run_macos.mjs';

const source = await readFile(new URL('./webview-fixture-driver.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('webview-fixture-driver.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['validateWebviewConfig', 'sanitizeWebviewFailure', 'mediaSnapshot']);
const helpers = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const context = { exports: {}, URL, Error };
vm.runInNewContext(ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { validateWebviewConfig, sanitizeWebviewFailure, mediaSnapshot } = context.exports;
const config = { baseUrl: 'http://127.0.0.1:43210', baseVersion: '2.3.101', nextVersion: '2.3.102', runId: 'b8b467df-7ec6-4bd3-b5df-a9a465c8de12' };

test('WK fixture configuration and failure diagnostics stay bounded and loopback-only', () => {
  assert.equal(validateWebviewConfig(config).baseUrl, config.baseUrl);
  for (const baseUrl of ['https://127.0.0.1:43210', 'http://example.com:43210', 'http://127.0.0.1:43210/path', 'http://a:b@127.0.0.1:43210', 'http://127.0.0.1:43210/?token=x', 'http://127.0.0.1']) assert.throws(() => validateWebviewConfig({ ...config, baseUrl }));
  for (const patch of [{ nextVersion: config.baseVersion }, { nextVersion: '2.3.100' }, { baseVersion: 'latest' }, { runId: 'wrong' }, { extra: true }]) assert.throws(() => validateWebviewConfig({ ...config, ...patch }));
  const message = sanitizeWebviewFailure(new Error('Bearer sample https://example.invalid/media /Users/example/private token=value\n' + 'x'.repeat(300)));
  assert.ok(message.length <= 180); assert.doesNotMatch(message, /sample|https:|\/Users|token=value|\n/);
});

test('WK media diagnostics preserve real numeric and boolean properties without URLs or browser mutation', () => {
  const video = { currentTime: 1.25, duration: 40, videoWidth: 320, paused: false, seeking: false, muted: true, isConnected: true, readyState: 4, networkState: 1, error: null, currentSrc: 'http://private.invalid/media' };
  const snapshot = mediaSnapshot(video);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { position: 1.25, duration: 40, width: 320, paused: false, seeking: false, muted: true, connected: true, readyState: 4, networkState: 1, errorCode: null });
  assert.equal(mediaSnapshot({ ...video, duration: Infinity }).duration, null);
  assert.equal(mediaSnapshot(null).connected, false); assert.doesNotMatch(JSON.stringify(snapshot), /private|currentSrc/);
});

test('WK driver uses actual production components, paused admission, and real controls without a homemade reader', () => {
  for (const path of ['../../web/src/components/VideoPlayer', '../../web/src/components/UpdateBanner', '../../web/src/lib/attention', '../../web/src/lib/updater', '@tauri-apps/api/app']) assert.ok(source.includes(`from "${path}"`));
  assert.match(source, /<UpdateBanner autoCheck autoInstall=\{false\}/);
  assert.match(source, /<VideoPlayer[^>]+engine="webview-direct" useBuiltInPlayer=\{false\}/);
  assert.match(source, /initialHandoffState=\{\{ paused: false, muted: true, volume: 0, playbackRate: 1 \}\}/);
  assert.match(source, /await candidate\.update\.install\(\)/); assert.match(source, /error instanceof UpdateDeferredError/);
  assert.match(source, /finally \{ await candidate\.update\.close\?\.\(\); \}/);
  for (const label of ['Pause', 'Play', 'Close player']) assert.ok(source.includes(`playerButton("${label}").click()`));
  assert.match(source, /window\.dispatchEvent\(new KeyboardEvent\("keydown", \{ key: seekFrom < 20 \? "l" : "j"/);
  const close = source.indexOf('playerButton("Close player").click();'), acknowledged = source.indexOf('await emit("reader-unmounted"');
  assert.ok(close < acknowledged); assert.match(source.slice(close, acknowledged), /!video\.isConnected && !getPlayerMounted\(\) && video\.paused/);
  assert.ok(source.indexOf('await closeReader();') < source.indexOf('await emit("install-requested"'));
  assert.ok(source.indexOf('await emit("install-requested"') < source.indexOf('install.click();'));
  assert.doesNotMatch(source, /<video\b|createElement\("video"|\.currentTime\s*=|\bvideo!?\.(?:play|pause)\(|\b(?:vi|jest)\.mock|@tauri-apps\/api\/core|\binvoke\s*\(|setNetworkMode|Object\.defineProperty/);
});

function observations() {
  const details = {
    boot: { nativeVersionVerified: true }, playing: { position: 1, duration: 40, width: 320, activity: true, paused: false, muted: true, connected: true, errorCode: null },
    'paused-update-deferred': { paused: true, activity: true, deferredByProduction: true, automaticQueueTested: false },
    'reader-unmounted': { actualReactClose: true, activity: false, mediaConnected: false, mediaPaused: true, clockStopped: true },
    'install-requested': { actualBannerAction: true, activity: false }, seeked: { target: 11, seekFrom: 1, position: 11, paused: true }, resumed: { resumedFrom: 11, position: 11.75 },
  };
  const events = requiredWebviewBaseStages.map((stage, index) => ({ readerType: 'wkwebview-html5', stage, version: config.baseVersion, sequence: index + 1, detail: details[stage] }));
  events.push(...requiredWebviewNextStages.map((stage, index) => ({ readerType: 'wkwebview-html5', stage, version: config.nextVersion, sequence: index + 8, detail: details[stage] })));
  return { events, requests: [{ path: '/fixture.mp4', method: 'GET', sequence: 0 }, { path: '/update.tar.gz', method: 'GET', sequence: 7 }] };
}
const verify = (events, requests) => verifyRuntimeEvents(events, requests, config.baseVersion, config.nextVersion, 'wkwebview-html5');

test('WK observer rejects absent progress, pause, changed seek, resume, detached cleanup, and early or duplicate payloads', () => {
  const { events, requests } = observations();
  assert.equal(verify(events, requests).nextVersionPlaybackCompleted, true);
  for (const event of events) assert.throws(() => verify(events.filter((value) => value !== event), requests));
  for (const [stage, patch] of [['playing', { width: 0 }], ['playing', { position: 0 }], ['playing', { muted: false }], ['paused-update-deferred', { paused: false }], ['reader-unmounted', { activity: true }], ['reader-unmounted', { mediaConnected: true }], ['reader-unmounted', { clockStopped: false }], ['seeked', { position: 1 }], ['seeked', { target: 1 }], ['resumed', { position: 11 }]]) {
    assert.throws(() => verify(events.map((event) => event.stage === stage ? { ...event, detail: { ...event.detail, ...patch } } : event), requests), `${stage}: ${JSON.stringify(patch)}`);
  }
  assert.throws(() => verify(events, [...requests, requests[1]]));
  assert.throws(() => verify(events, [requests[0], { ...requests[1], sequence: 4 }]));
  assert.throws(() => verify(events, [requests[1]]));
});

test('WK receipts cannot pass the native lane or lose explicit reader identity', () => {
  const { events, requests } = observations();
  assert.throws(() => verifyRuntimeEvents(events, requests, config.baseVersion, config.nextVersion));
  assert.throws(() => verify(events.map(({ readerType: _readerType, ...event }) => event), requests));
  assert.throws(() => verify(events.map((event) => ({ ...event, readerType: 'native-mpv' })), requests));
  const result = verify(events, requests);
  assert.equal(result.readerType, 'wkwebview-html5'); assert.equal(result.nativeRenderSessionTested, false); assert.equal(result.automaticQueueTested, false);
});

test('WK loopback observer rejects foreign or absent reader tags before recording events', async () => {
  const service = await startRuntimeService({ ...config, readerType: 'wkwebview-html5', mediaPath: 'unused-fixture.mp4', archivePath: 'unused-update.tar.gz', signature: '' });
  const send = (readerType) => fetch(`${service.address}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2_000),
    body: JSON.stringify({ runId: config.runId, version: config.baseVersion, stage: 'boot', ...(readerType == null ? {} : { readerType }) }) });
  try {
    assert.equal((await send('native-mpv')).status, 400);
    assert.equal((await send(null)).status, 400);
    assert.equal(service.events.length, 0);
    assert.equal((await send('wkwebview-html5')).status, 204);
    assert.equal(service.events.length, 1); assert.equal(service.events[0].readerType, 'wkwebview-html5');
  } finally { await service.close(); }
});

test('WK orchestration remains guarded, separate from unchanged strict MPV and shared native installer checks', async () => {
  const original = process.env.GITHUB_ACTIONS; process.env.GITHUB_ACTIONS = 'false';
  try { await assert.rejects(runMacosQualification('wkwebview-html5'), /disposable GitHub macOS runner/); }
  finally { if (original === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = original; }
  const runner = await readFile(new URL('./run_macos.mjs', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../../.github/workflows/desktop-update-runtime.yml', import.meta.url), 'utf8');
  assert.match(runner, /readerType === 'native-mpv' \? 'fixture-driver\.tsx' : 'webview-fixture-driver\.tsx'/);
  assert.match(runner, /verifyRuntimeEvents\(service\.events, service\.requests, baseVersion, nextVersion, readerType\)/);
  for (const control of ['oldExit', 'running[0] === child.pid', 'targetExecutableHash', 'installedVersion !== nextVersion', "readFile(marker, 'utf8') !== runId"]) assert.ok(runner.includes(control));
  assert.match(workflow, /max-parallel: 2/); assert.equal((workflow.match(/reader: native-mpv/g) ?? []).length, 2); assert.equal((workflow.match(/reader: wkwebview-html5/g) ?? []).length, 2);
  assert.match(workflow, /name: desktop-update-runtime-\$\{\{ matrix\.arch \}\}-\$\{\{ matrix\.reader \}\}/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.evidence \}\}/);
  assert.doesNotMatch(workflow, /continue-on-error|secrets\./);
});

test('actual WK driver and full production graph pass strict TypeScript with generated config virtualized only', () => {
  const web = fileURLToPath(new URL('../../web/', import.meta.url)), driver = fileURLToPath(new URL('./webview-fixture-driver.tsx', import.meta.url));
  const generated = fileURLToPath(new URL('./runtime-config.json', import.meta.url)), configuration = join(web, 'tsconfig.json');
  const input = ts.readConfigFile(configuration, ts.sys.readFile); assert.equal(input.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(input.config, ts.sys, web, { resolveJsonModule: true }, configuration); assert.deepEqual(parsed.errors, []);
  const options = { ...parsed.options, baseUrl: web, paths: { react: ['node_modules/@types/react/index.d.ts'], 'react/*': ['node_modules/@types/react/*'], 'react-dom/*': ['node_modules/@types/react-dom/*'], '@tauri-apps/*': ['node_modules/@tauri-apps/*'] } };
  const host = ts.createCompilerHost(options), exists = host.fileExists.bind(host), read = host.readFile.bind(host), original = host.getSourceFile.bind(host);
  host.fileExists = (path) => resolve(path) === generated || exists(path);
  host.readFile = (path) => resolve(path) === generated ? JSON.stringify(config) : read(path);
  host.getSourceFile = (path, languageVersion, onError, fresh) => resolve(path) === generated ? ts.createSourceFile(path, JSON.stringify(config), languageVersion, true, ts.ScriptKind.JSON) : original(path, languageVersion, onError, fresh);
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, driver], options, host }); assert.ok(program.getSourceFile(driver)); assert.ok(program.getSourceFile(generated));
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (path) => path, getCurrentDirectory: () => web, getNewLine: () => '\n' }));
});
