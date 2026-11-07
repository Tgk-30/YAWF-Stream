import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
import { requiredBaseStages } from './runtime-service.mjs';

const source = await readFile(new URL('./fixture-driver.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('fixture-driver.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['validateRuntimeConfig', 'sanitizeFailure', 'bounded']);
const helpers = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(tree)).join('\n');
const javascript = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, URL, Error, window: { setTimeout, clearTimeout } };
vm.runInNewContext(javascript, context);
const { validateRuntimeConfig, sanitizeFailure, bounded } = context.exports;
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
  assert.match(source, /emit\("failed", \{ message \}\)/);
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
