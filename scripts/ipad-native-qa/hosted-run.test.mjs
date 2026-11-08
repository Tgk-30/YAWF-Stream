import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { admitToolchain, admitCreatedDevice, cleanupOwnedDevice, cleanupTarget, hostedContext, nativeEnvironment, registrySnapshot, expectedEnvironment, validateTestRun, validateSummary, admitResultAction, admitCounterTest, admitCounterAttachment, RUNTIME, MIN_FREE_BYTES, COUNTER, SELECTOR } from './hosted-run.mjs';

const id = '12345678-1234-4567-9876-123456789abc';
const instance = '22345678-1234-4567-9876-123456789abc';
const source = 'a'.repeat(40);
const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPad-A16';
const set = join(homedir(), 'Library/Developer/CoreSimulator/Devices');
const ownership = { schemaVersion: 1, createdFor: 'ipad-native-qa', createdFresh: true, udid: id, name: `YAWF-iPad-NativeQA-${instance}`, runtimeIdentifier: RUNTIME, deviceSetPath: set, rootApprovedDefaultSet: true };
const device = { udid: id, name: ownership.name, isAvailable: true, state: 'Shutdown', deviceTypeIdentifier: deviceType, dataPath: join(set, id, 'data') };
const registry = () => ({ devices: { [RUNTIME]: [{ ...device }] } });
const destinations = `Available destinations for the "NativeQA" scheme:\n { platform:iOS Simulator, arch:arm64, id:${id}, OS:26.5, name:${ownership.name} }`;
const environment = expectedEnvironment(ownership, source, instance);
const v = (text) => ({ _value: text });
const ref = (text) => ({ id: v(text) });
const validSummary = { result: 'Passed', totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0, expectedFailures: 0, testFailures: [], runtimeWarnings: [] };
function runPlist() { return { __xctestrun_metadata__: { FormatVersion: 2 }, TestConfigurations: [{ TestTargets: [{ BlueprintName: 'SafariNativeInputTests', IsUITestBundle: true, EnvironmentVariables: { ...environment }, TestBundlePath: '__TESTROOT__/Debug-iphonesimulator/SafariNativeInputTests-Runner.app/PlugIns/SafariNativeInputTests.xctest', TestHostPath: '__TESTROOT__/Debug-iphonesimulator/SafariNativeInputTests-Runner.app/SafariNativeInputTests-Runner', UITargetAppPath: '__TESTROOT__/Debug-iphonesimulator/NativeQAAnchor.app' }] }] }; }
const target = (run) => run.TestConfigurations[0].TestTargets[0];
const folder = fileURLToPath(new URL('.', import.meta.url));
const controller = readFileSync(join(folder, 'hosted-run.mjs'), 'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/ipad-native-qa.yml', import.meta.url), 'utf8');

test('actual CLI rejects local execution before any simulator command', () => {
  const result = spawnSync(process.execPath, [join(folder, 'hosted-run.mjs')], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Only a GitHub-hosted ARM macOS runner/);
});
test('hosted context requires exact manual or same-repo PR ARM identity and canonical fresh evidence root', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'Tgk-30/YAWF-Stream', GITHUB_SHA: source, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: '/runner/temp', GITHUB_WORKSPACE: '/runner/repo' };
  assert.equal(hostedContext(env, 'darwin', 'arm64', (x) => x).evidence, '/runner/temp/ipad-native-qa-123-1');
  for (const patch of [{ RUNNER_ENVIRONMENT: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_ACTIONS: 'false' }, { RUNNER_ARCH: 'X64' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_SHA: 'short' }, { RUNNER_TEMP: 'relative' }, { RUNNER_TEMP: '/' }, { RUNNER_TEMP: '/runner/repo' }, { GITHUB_RUN_ATTEMPT: '0' }]) assert.throws(() => hostedContext({ ...env, ...patch }, 'darwin', 'arm64', (x) => x));
  assert.throws(() => hostedContext(env, 'darwin', 'arm64', () => '/different'));
  assert.equal(hostedContext({ ...env, GITHUB_EVENT_NAME: 'pull_request', QA_PR_HEAD_REPOSITORY: env.GITHUB_REPOSITORY }, 'darwin', 'arm64', (x) => x).source, source);
  assert.throws(() => hostedContext({ ...env, GITHUB_EVENT_NAME: 'pull_request', QA_PR_HEAD_REPOSITORY: 'foreign/fork' }, 'darwin', 'arm64', (x) => x));
});
test('native child environment cannot forward CI credentials or arbitrary overrides', () => {
  const native = nativeEnvironment('/owned/tmp', { USER: 'runner', LOGNAME: 'runner', GITHUB_TOKEN: 'not-forwarded', DEVELOPER_DIR: '/foreign', PATH: '/foreign', OTHER_VALUE: 'not-forwarded' });
  assert.equal(native.TMPDIR, '/owned/tmp'); assert.equal(native.DEVELOPER_DIR, '/Applications/Xcode_26.5.app/Contents/Developer');
  assert.equal(native.GITHUB_TOKEN, undefined); assert.equal(native.OTHER_VALUE, undefined); assert.notEqual(native.PATH, '/foreign');
});
test('toolchain requires installed exact Xcode26.5 runtime and unique iPad type with8GiB headroom', () => {
  const runtimes = { runtimes: [{ identifier: RUNTIME, version: '26.5', isAvailable: true }] };
  const types = { devicetypes: [{ name: 'iPad (A16)', identifier: deviceType }] };
  assert.equal(admitToolchain('Xcode 26.5\nBuild version 17F42\n', runtimes, types, MIN_FREE_BYTES).deviceType.identifier, deviceType);
  for (const bad of ['Xcode 27.0\nBuild version future', 'Xcode 26.5\nBuild version different']) assert.throws(() => admitToolchain(bad, runtimes, types, MIN_FREE_BYTES));
  assert.throws(() => admitToolchain('Xcode 26.5\nBuild version 17F42', runtimes, types, MIN_FREE_BYTES - 1));
  assert.throws(() => admitToolchain('Xcode 26.5\nBuild version 17F42', { runtimes: [] }, types, MIN_FREE_BYTES));
  assert.throws(() => admitToolchain('Xcode 26.5\nBuild version 17F42', { runtimes: [{ ...runtimes.runtimes[0], isAvailable: false }] }, types, MIN_FREE_BYTES));
  assert.throws(() => admitToolchain('Xcode 26.5\nBuild version 17F42', { runtimes: [...runtimes.runtimes, ...runtimes.runtimes] }, types, MIN_FREE_BYTES));
  assert.throws(() => admitToolchain('Xcode 26.5\nBuild version 17F42', runtimes, { devicetypes: [...types.devicetypes, ...types.devicetypes] }, MIN_FREE_BYTES));
});
test('actual fresh-device admission reuses strict ownership and rejects existing or altered registries', () => {
  assert.equal(admitCreatedDevice(ownership, registry(), [], destinations, deviceType).udid, id);
  assert.throws(() => admitCreatedDevice(ownership, registry(), registrySnapshot(registry()), destinations, deviceType));
  for (const patch of [{ name: 'foreign' }, { dataPath: '/foreign/data' }, { isAvailable: false }, { deviceTypeIdentifier: 'iPhone' }]) {
    const bad = registry(); Object.assign(bad.devices[RUNTIME][0], patch);
    assert.throws(() => admitCreatedDevice(ownership, bad, [], destinations, deviceType));
  }
  assert.throws(() => admitCreatedDevice(ownership, registry(), [], destinations.replace(id, instance), deviceType));
  const clone = registry(); clone.devices[RUNTIME].push({ ...device, udid: instance });
  assert.throws(() => admitCreatedDevice(ownership, clone, [], destinations, deviceType));
});
test('cleanup issues only exact owned UUID commands and refuses changed identity without any invocation', () => {
  const calls = []; cleanupOwnedDevice(ownership, registry(), [], deviceType, (...args) => calls.push(args));
  assert.deepEqual(calls.map((entry) => entry[0]), [['simctl', 'shutdown', id], ['simctl', 'delete', id]]);
  for (const patch of [{ name: 'foreign' }, { dataPath: '/foreign/data' }, { deviceTypeIdentifier: 'iPhone' }]) {
    const bad = registry(); Object.assign(bad.devices[RUNTIME][0], patch); let invoked = false;
    assert.throws(() => cleanupOwnedDevice(ownership, bad, [], deviceType, () => { invoked = true; })); assert.equal(invoked, false);
  }
  assert.throws(() => cleanupTarget(ownership, registry(), registrySnapshot(registry()), deviceType));
  let invoked = false; assert.deepEqual(cleanupOwnedDevice(ownership, { devices: {} }, [], deviceType, () => { invoked = true; }), { alreadyAbsent: true }); assert.equal(invoked, false);
});
test('registry preserves all preexisting metadata and detects duplicates, changes and clones', () => {
  assert.deepEqual(registrySnapshot(registry(), id), []);
  const bad = registry(); bad.devices[RUNTIME].push({ ...device }); assert.throws(() => registrySnapshot(bad));
  const forged = registry(); forged.devices[RUNTIME][0].runtime = 'foreign'; assert.equal(registrySnapshot(forged)[0].runtime, RUNTIME);
});
test('generated xctestrun accepts only exact five resolved public values and owned expected products', () => {
  assert.equal(validateTestRun(runPlist(), environment, '/build/products', () => true).BlueprintName, 'SafariNativeInputTests');
  for (const key of Object.keys(environment)) { const run = runPlist(); target(run).EnvironmentVariables[key] = `$(UNRESOLVED)`; assert.throws(() => validateTestRun(run, environment, '/build/products', () => true)); }
  for (const key of ['TestBundlePath', 'TestHostPath', 'UITargetAppPath']) {
    for (const path of ['/foreign/app', '__TESTROOT__/../../foreign/app', '__TESTROOT__/foreign.app']) { const run = runPlist(); target(run)[key] = path; assert.throws(() => validateTestRun(run, environment, '/build/products', () => true)); }
  }
  assert.throws(() => validateTestRun(runPlist(), environment, '/build/products', () => false));
  const reserved = runPlist(); target(reserved).EnvironmentVariables.SIMULATOR_UDID = id; assert.throws(() => validateTestRun(reserved, environment, '/build/products', () => true));
  const extra = runPlist(); extra.TestConfigurations[0].TestTargets.push(target(runPlist())); assert.throws(() => validateTestRun(extra, environment, '/build/products', () => true));
});
test('actual owned product-path policy rejects a filesystem symlink escaping the build', () => {
  const root = mkdtempSync(join(tmpdir(), 'ipad-hosted-products-')); const products = join(root, 'products');
  const runner = join(products, 'Debug-iphonesimulator/SafariNativeInputTests-Runner.app');
  const bundle = join(runner, 'PlugIns/SafariNativeInputTests.xctest');
  try {
    mkdirSync(bundle, { recursive: true }); mkdirSync(join(products, 'Debug-iphonesimulator/NativeQAAnchor.app'));
    writeFileSync(join(runner, 'SafariNativeInputTests-Runner'), 'owned executable fixture');
    validateTestRun(runPlist(), environment, products);
    rmSync(bundle, { recursive: true }); const foreign = join(root, 'foreign.xctest'); mkdirSync(foreign); symlinkSync(foreign, bundle);
    assert.throws(() => validateTestRun(runPlist(), environment, products));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('result admission requires actual owned destination, one successful counter and retained PNG payload', () => {
  validateSummary(validSummary);
  for (const patch of [{ totalTestCount: 2 }, { passedTests: 0 }, { failedTests: 1 }, { skippedTests: 1 }, { expectedFailures: 1 }, { result: 'Failed' }, { runtimeWarnings: ['warning'] }, { testFailures: ['failure'] }]) assert.throws(() => validateSummary({ ...validSummary, ...patch }));
  const action = { actions: { _values: [{ actionResult: { status: v('succeeded'), testsRef: ref('tests') }, runDestination: { targetDeviceRecord: { identifier: v(id) } } }] } };
  assert.equal(admitResultAction(action, id), 'tests'); assert.throws(() => admitResultAction(action, instance));
  const failedAction = structuredClone(action); failedAction.actions._values[0].actionResult.status = v('failed'); assert.throws(() => admitResultAction(failedAction, id));
  const tests = { tests: { _values: [{ identifier: v(COUNTER), testStatus: v('Success'), summaryRef: ref('details') }] } };
  assert.equal(admitCounterTest(tests), 'details');
  for (const name of ['SafariNativeInputTests/testSafariPublicFixtureLogin()', 'testNativeCounterInput()']) { const bad = structuredClone(tests); bad.tests._values[0].identifier = v(name); assert.throws(() => admitCounterTest(bad)); }
  const failedTest = structuredClone(tests); failedTest.tests._values[0].testStatus = v('Failure'); assert.throws(() => admitCounterTest(failedTest));
  const attachment = { attachments: { _values: [{ name: v('native-counter-three-real-taps'), uniformTypeIdentifier: v('public.png'), payloadRef: ref('png') }] } };
  assert.equal(admitCounterAttachment(attachment), 'png'); assert.throws(() => admitCounterAttachment({}));
  for (const patch of [{ name: v('wrong') }, { uniformTypeIdentifier: v('public.jpeg') }, { payloadRef: {} }]) { const bad = structuredClone(attachment); Object.assign(bad.attachments._values[0], patch); assert.throws(() => admitCounterAttachment(bad)); }
  attachment.attachments._values.push(attachment.attachments._values[0]); assert.throws(() => admitCounterAttachment(attachment));
});
test('workflow and actual controller are manual or same-repo path-filtered PR counter-only with ordered admission, bounded cleanup and no unsafe substitutes', () => {
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /push:|secrets\.|contents: write|release|deploy/);
  const eventBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
  assert.deepEqual([...eventBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]), ['workflow_dispatch', 'pull_request']);
  const pathsBlock = workflow.match(/  pull_request:\n    paths:\n([\s\S]*?)\npermissions:/)[1].trim().split('\n');
  const paths = pathsBlock.map((line) => { const match = line.trim().match(/^- ['"]([^'"]+)['"]$/); assert.ok(match); return match[1]; });
  assert.deepEqual(paths, ['.github/workflows/ipad-native-qa.yml', 'scripts/ipad-native-qa/**', 'scripts/ipad_native_qa.test.mjs']);
  const gate = workflow.match(/    if: >-\n([\s\S]*?)    name:/)[1].trim().replace(/\s+/g, ' ');
  assert.equal(gate, "github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository");
  assert.match(workflow, /runs-on: macos-26/); assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /if: always\(\)/);
  assert.equal(SELECTOR, 'SafariNativeInputTests/SafariNativeInputTests/testNativeCounterInput');
  assert.match(controller, /`-only-testing:\$\{SELECTOR\}`/); assert.doesNotMatch(controller, /retry-tests|downloadPlatform|['\"]booted['\"]|shutdown', 'all|delete', 'all|simctl', 'erase|DeveloperToolsSecurity|xcode-select/);
  assert.ok(controller.indexOf("write('ownership.json'") < controller.indexOf("xcrun(['simctl', 'boot', udid])"));
  assert.ok(controller.indexOf('validateTestRun(plist') < controller.indexOf("['test-without-building'"));
  const ui = readFileSync(join(folder, 'UITests/SafariNativeInputTests.swift'), 'utf8');
  assert.match(ui, /override func record\(_ issue: XCTIssue\)/); assert.match(ui, /native-input-failure-before-teardown/);
  assert.ok(ui.indexOf('override func record') < ui.indexOf('override func tearDown'));
  const failureHook = ui.slice(ui.indexOf('override func record'), ui.indexOf('override func tearDown'));
  assert.match(failureHook, /XCUIScreen.main.screenshot\(\)/); assert.match(failureHook, /attachment.lifetime = \.keepAlways/); assert.match(failureHook, /add\(attachment\)/);
  assert.ok(failureHook.indexOf('add(attachment)') < failureHook.indexOf('super.record(issue)'));
  assert.match(workflow, /hosted-run.mjs --cleanup-only/);
});

for (const [label, marker] of [['missing', undefined], ['self-hosted', 'self-hosted']]) {
  test(`hosted context rejects ${label} RUNNER_ENVIRONMENT before native work`, () => {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'Tgk-30/YAWF-Stream', GITHUB_SHA: source, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: '/runner/temp', GITHUB_WORKSPACE: '/runner/repo' };
    if (marker !== undefined) env.RUNNER_ENVIRONMENT = marker;
    assert.throws(() => hostedContext(env, 'darwin', 'arm64', (path) => path), /Only a GitHub-hosted ARM macOS runner/);
  });
}
