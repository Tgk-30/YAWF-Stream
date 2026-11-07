import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
import { requiredBaseStages } from './runtime-service.mjs';

const source = await readFile(new URL('./fixture-driver.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('fixture-driver.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['validateRuntimeConfig', 'sanitizeFailure', 'bounded', 'observedClock', 'summarizeAudioDevices']);
const helpers = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const javascript = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, URL, Error, window: { setTimeout, clearTimeout } };
vm.runInNewContext(javascript, context);
const { validateRuntimeConfig, sanitizeFailure, bounded, observedClock, summarizeAudioDevices } = context.exports;
const config = { baseUrl: 'http://127.0.0.1:43210', baseVersion: '2.3.101', nextVersion: '2.3.102', runId: 'b8b467df-7ec6-4bd3-b5df-a9a465c8de12' };

test('fixture config permits only a loopback origin, exact versions and public run correlation', () => {
  assert.equal(validateRuntimeConfig(config).baseUrl, config.baseUrl);
  for (const baseUrl of ['https://127.0.0.1:43210', 'http://example.com:43210', 'http://127.0.0.1:43210/path', 'http://a:b@127.0.0.1:43210', 'http://127.0.0.1:43210/?token=x', 'http://127.0.0.1:43210/#x', 'http://127.0.0.1']) assert.throws(() => validateRuntimeConfig({ ...config, baseUrl }));
  for (const patch of [{ nextVersion: config.baseVersion }, { nextVersion: '2.3.100' }, { baseVersion: 'latest' }, { runId: 'wrong-run' }, { signature: 'not-a-driver-field' }]) assert.throws(() => validateRuntimeConfig({ ...config, ...patch }));
});

test('failure output is bounded and strips authorization, URLs, private paths and secret fields', () => {
  const result = sanitizeFailure(new Error('Bearer abc123 https://127.0.0.1/file /Users/example/private.txt token=value signature=value\n' + 'x'.repeat(400)));
  assert.ok(result.length <= 180);
  for (const value of ['abc123', 'http://', '/Users/example', 'token=value', 'signature=value', '\n']) assert.ok(!result.includes(value));
});

test('pure deadline helper preserves completion/rejection and rejects a never-settling promise', async () => {
  assert.equal(await bounded(Promise.resolve(3), 100, 'unit-completion'), 3);
  await assert.rejects(bounded(Promise.reject(new Error('unit-rejection')), 100, 'unit-rejection'), /unit-rejection/);
  await assert.rejects(bounded(new Promise(() => {}), 5, 'unit-deadline'), /unit-deadline timed out/);
});

test('frontend imports the production bridge and native version without mocks or raw native invoke', () => {
  for (const path of ['../../web/src/lib/attention', '../../web/src/lib/renderPlayer', '../../web/src/lib/updater', '@tauri-apps/api/app']) assert.ok(source.includes(`from "${path}"`));
  assert.match(source, /import runtimeConfig from "\.\/runtime-config\.json"/);
  assert.match(source, /version = await step\("native-version", getVersion\)/);
  assert.match(source, /session\.init\(/); assert.match(source, /session\.observeProperties\(OBSERVED, clock\.event\)/);
  assert.doesNotMatch(source, /\b(?:vi|jest)\.mock\b|from ["']@tauri-apps\/api\/core|\binvoke\s*\(/);
  assert.doesNotMatch(source, /getProperty\(["']time-pos|setNetworkMode|localStorage|downloadAndInstall|TAURI_SIGNING|privateKey/);
});

test('base stages match observer and real destroy/install promises precede recorded acknowledgements', () => {
  const statement = tree.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => decl.name.getText(tree) === 'BASE_STAGES'));
  const stageJavascript = ts.transpileModule(statement.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const stageContext = { exports: {} }; vm.runInNewContext(stageJavascript, stageContext);
  assert.deepEqual(Array.from(stageContext.exports.BASE_STAGES), requiredBaseStages);
  const pending = source.indexOf('const command = bounded(session.setProperty(');
  const destroy = source.indexOf('const destruction = bounded(session.destroy().then(');
  const attempt = source.indexOf('const deferredUpdate = requireDeferred(candidate, "destroy-update-admission")');
  const requested = source.indexOf('await emit("destroy-requested", atRequest)');
  assert.ok(pending < destroy && destroy < attempt && attempt < requested);
  assert.doesNotMatch(source.slice(destroy, attempt), /\bawait\b/);
  assert.ok(source.indexOf('await destruction;') < source.indexOf('await emit("destroy-acknowledged"'));
  assert.ok(source.indexOf('await emit("install-requested"') < source.indexOf('await bounded(candidate.install(), INSTALL_TIMEOUT_MS'));
});

test('only next boot after real play/pause/seek/resume/destruction may report completed', () => {
  const next = source.indexOf('await emit("paused",');
  const completed = source.indexOf('await emit("completed",');
  assert.ok(next > source.indexOf('if (version === config.baseVersion)'));
  for (const text of ['session.command("seek", [target, "absolute"])', 'native-seek-observation', 'native-resume-observation', 'await closeReader();']) assert.ok(source.indexOf(text, next) < completed);
  assert.match(source.slice(0, next), /await bounded\(new Promise<void>\(\(\) => \{\}\), 15_000, "await-real-process-relaunch"\)/);
  assert.equal((source.match(/emit\("completed"/g) ?? []).length, 1);
  assert.match(source, /emit\("failed", \{ message, diagnostic: \{ \.\.\.diagnostic, audioDevices \} \}\)/);
  assert.match(source, /runId: config\.runId, stage: name, version/);
  const parsed = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  assert.equal((parsed.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
});


test('fixture init keys are admitted by actual Rust validation and match the production player defaults', async () => {
  const core = await readFile(new URL('../../web/src-tauri/src/render_player/core.rs', import.meta.url), 'utf8');
  const block = core.slice(core.indexOf('fn validate_mpv_init_options('), core.indexOf('fn validate_player_command_request'));
  const allowed = new Set(Array.from(block.matchAll(/^\s*"([^"]+)"(?:\s+if|\s*=>)/gm), (match) => match[1]));
  assert.deepEqual([...allowed].sort(), ['keep-open', 'sub-font-size', 'terminal']);
  let fixtureOptions;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'session.init') {
      const object = node.arguments[0];
      fixtureOptions = object.properties.find((property) => property.name?.getText(tree) === 'initialOptions').initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(fixtureOptions && ts.isObjectLiteralExpression(fixtureOptions));
  const production = await readFile(new URL('../../web/src/components/EmbeddedPlayer.tsx', import.meta.url), 'utf8');
  const productionTree = ts.createSourceFile('EmbeddedPlayer.tsx', production, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let productionOptions;
  function visitProduction(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(productionTree) === 'MPV_CONFIG') productionOptions = node.initializer.properties.find((property) => property.name?.getText(productionTree) === 'initialOptions').initializer;
    ts.forEachChild(node, visitProduction);
  }
  visitProduction(productionTree);
  const values = (object) => new Map(object.properties.map((property) => [property.name.text, property.initializer.text]));
  const actual = values(fixtureOptions), defaults = values(productionOptions);
  for (const [key, value] of actual) { assert.ok(allowed.has(key), `Rust rejects ${key}`); assert.equal(value, defaults.get(key)); }
  assert.ok(!actual.has('mute') && !actual.has('pause'));
  const load = source.indexOf('await session.command("loadfile"');
  assert.ok(source.indexOf('await session.setProperty("mute", true)') < load);
  assert.ok(source.indexOf('await session.setProperty("pause", true)') < load);
  assert.match(source, /const target = seekFrom < 3 \? 5 : 1/);
});

test('native failure snapshots retain actual clock fields and observation counts without mutable aliases', () => {
  const clock = observedClock();
  const initial = clock.snapshot();
  assert.equal(initial.eventCount, 0);
  for (const name of ['position', 'duration', 'paused', 'seeking', 'width']) assert.equal(initial[name], null);
  for (const [name, data] of [['time-pos', 0.2], ['duration', 10], ['pause', false], ['seeking', true], ['video-params/w', 640]]) clock.event({ name, data });
  const snapshot = clock.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    position: 0.2, duration: 10, paused: false, seeking: true, width: 640, eventCount: 5,
    propertyEventCounts: { 'time-pos': 1, duration: 1, pause: 1, seeking: 1, 'video-params/w': 1 },
    recentEvents: ['time-pos', 'duration', 'pause', 'seeking', 'video-params/w'], recentErrors: [],
  });
  clock.event({ name: 'time-pos', data: 0.4 });
  clock.event({ name: 'dwidth', data: NaN });
  assert.equal(snapshot.position, 0.2); assert.equal(snapshot.eventCount, 5);
  assert.equal(snapshot.propertyEventCounts['time-pos'], 1); assert.equal(snapshot.recentEvents.length, 5);
  assert.equal(clock.snapshot().position, 0.4); assert.equal(clock.snapshot().width, 640);
});

test('native event diagnostics bound history and retain only safe names and numeric end-file errors', () => {
  const clock = observedClock();
  for (let index = 0; index < 30; index++) clock.event({ name: 'end-file', data: { error: true, code: -index, source: 'https://private.invalid/media' } });
  clock.event({ name: 'https://private.invalid/property', data: 'Bearer private-value' });
  clock.event({ name: 'end-file', data: { error: 'not-a-boolean', code: Infinity, description: '/Users/example/device' } });
  const snapshot = clock.snapshot();
  assert.equal(snapshot.eventCount, 32); assert.equal(snapshot.propertyEventCounts['end-file'], 31);
  assert.equal(snapshot.propertyEventCounts.other, 1); assert.equal(snapshot.recentEvents.length, 12);
  assert.equal(snapshot.recentEvents.at(-2), 'other'); assert.equal(snapshot.recentErrors.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.recentErrors.at(-1))), { name: 'end-file', error: false, code: null });
  assert.equal(snapshot.recentErrors[0].code, -27);
  clock.event({ name: 'end-file', data: { error: true, code: -9 } });
  assert.equal(snapshot.recentErrors.at(-1).code, null);
  const serialized = JSON.stringify(snapshot);
  for (const value of ['https:', 'private', 'Bearer', '/Users', 'description', 'source']) assert.ok(!serialized.includes(value));
});

test('audio inventory diagnostics report counts only and never expose device identities or choose a fallback', () => {
  const summary = summarizeAudioDevices([{ name: 'auto', description: 'Default' }, { name: 'coreaudio/private-device-uid', description: 'Personal device' }, { name: 'other/private-output' }, null]);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { status: 'observed', deviceCount: 4, automaticDevicePresent: true, coreAudioDeviceCount: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeAudioDevices(null))), { status: 'unexpected-shape' });
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeAudioDevices([]))), { status: 'observed', deviceCount: 0, automaticDevicePresent: false, coreAudioDeviceCount: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /private|Personal|Default|uid/);
});

test('failed receipt adds bounded diagnostics without changing native playback requirements or polling forbidden properties', () => {
  const failure = source.slice(source.indexOf('    const diagnostic = { nativeClock:'));
  assert.match(failure, /nativeClock: clock\.snapshot\(\), activity: getPlayerMounted\(\), installation: getUpdateInstallationActive\(\)/);
  assert.match(failure, /bounded\(session\.getProperty\("audio-device-list"\), DIAGNOSTIC_TIMEOUT_MS, "diagnostic-audio-devices"\)/);
  assert.match(failure, /message: sanitizeFailure\(diagnosticError\)/);
  assert.match(failure, /await emit\("failed", \{ message, diagnostic: \{ \.\.\.diagnostic, audioDevices \} \}\)/);
  assert.ok(failure.indexOf('await emit("failed"') < failure.indexOf('session.destroy()'));
  assert.equal((source.match(/session\.getProperty\(/g) ?? []).length, 1);
  assert.match(source, /const DIAGNOSTIC_TIMEOUT_MS = 2_000/);
  assert.match(source, /const NATIVE_TIMEOUT_MS = 25_000/);
  assert.match(source, /value\.position >= 0\.75 && value\.duration != null && value\.paused === false && \(value\.width \?\? 0\) > 0/);
  assert.match(source, /Math\.abs\(value\.position - target\) <= 0\.35 && value\.seeking !== true/);
  assert.match(source, /value\.position >= resumedFrom \+ 0\.5/);
  assert.doesNotMatch(source, /session\.(?:setProperty|command)\("(?:ao|audio-device|aid|vid|vo|gpu-context)"/);
});

test('entire fixture and imported production graph pass strict TypeScript with only generated JSON virtualized', () => {
  const web = fileURLToPath(new URL('../../web/', import.meta.url));
  const driver = fileURLToPath(new URL('./fixture-driver.tsx', import.meta.url));
  const generated = fileURLToPath(new URL('./runtime-config.json', import.meta.url));
  const configuration = join(web, 'tsconfig.json');
  const input = ts.readConfigFile(configuration, ts.sys.readFile); assert.equal(input.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(input.config, ts.sys, web, { resolveJsonModule: true }, configuration);
  assert.deepEqual(parsed.errors, []);
  // Mirror the fixture Vite aliases, with the installed React declaration
  // packages supplying types for the actual runtime React modules.
  const options = { ...parsed.options, baseUrl: web, paths: {
    react: ['node_modules/@types/react/index.d.ts'], 'react/*': ['node_modules/@types/react/*'],
    'react-dom/*': ['node_modules/@types/react-dom/*'], '@tauri-apps/*': ['node_modules/@tauri-apps/*'],
  } };
  const host = ts.createCompilerHost(options);
  const originalExists = host.fileExists.bind(host), originalRead = host.readFile.bind(host), originalSource = host.getSourceFile.bind(host);
  host.fileExists = (path) => resolve(path) === generated || originalExists(path);
  host.readFile = (path) => resolve(path) === generated ? JSON.stringify(config) : originalRead(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => resolve(path) === generated
    ? ts.createSourceFile(path, JSON.stringify(config), languageVersion, true, ts.ScriptKind.JSON)
    : originalSource(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, driver], options, host });
  assert.ok(program.getSourceFile(driver)); assert.ok(program.getSourceFile(generated));
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (path) => path, getCurrentDirectory: () => web, getNewLine: () => '\n' }));
});
