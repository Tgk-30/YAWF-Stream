import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosticContext, fullRegistry, ownedTarget, destinationObservation, runDiagnostic, runDiagnosticCleanup, DEVICE_TYPE, OFFSETS_MS } from './ipad-destination-diagnostic.mjs';
import { RUNTIME, MIN_FREE_BYTES } from './ipad-native-qa/hosted-run.mjs';
const SOURCE = 'a'.repeat(40), ID = '22222222-2222-4222-8222-222222222222', INSTANCE = '33333333-3333-4333-8333-333333333333';
const source = readFileSync(new URL('./ipad-destination-diagnostic.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/ipad-destination-diagnostic.yml', import.meta.url), 'utf8');
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ipad-destination-contract-')), temp = join(root, 'temp'), workspace = join(root, 'workspace'), home = join(root, 'home');
  for (const path of [temp, workspace, join(home, 'Library/Developer/CoreSimulator/Devices')]) mkdirSync(path, { recursive: true });
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', GITHUB_REPOSITORY: 'Tgk-30/YAWF-Stream', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: SOURCE, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_TOKEN: 'not-forwarded' };
  const existing = { udid: '11111111-1111-4111-8111-111111111111', name: 'preexisting', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: DEVICE_TYPE, dataPath: join(home, 'Library/Developer/CoreSimulator/Devices/existing/data'), extraMetadata: { retained: true } };
  const devices = { devices: { [RUNTIME]: [existing] } }, calls = [], waits = []; let clock = 0;
  const ownership = () => JSON.parse(readFileSync(join(temp, 'ipad-destination-diagnostic-123-1/evidence/ownership.json')));
  const destination = () => `Destinations compatible with the "NativeQA" scheme:\n { platform:iOS Simulator, id:${ID}, name:${devices.devices[RUNTIME].find((row) => row.udid === ID)?.name} }`;
  const answer = (stdout = '', status = 0, patch = {}) => ({ stdout, stderr: '', status, signal: null, closed: true, timedOut: false, truncated: false, ...patch });
  const execute = async (command, args, execution) => {
    calls.push({ command, args: [...args], execution, at: clock }); assert.equal(execution.env.GITHUB_TOKEN, undefined);
    if (command === '/usr/bin/git') return answer(`${SOURCE}\n`);
    if (command === '/usr/bin/sw_vers') return answer('26.7.2\n');
    if (args[0] === '-version') return answer('Xcode 26.5\nBuild version 17F42\n');
    if (args[0] === 'simctl' && args[1] === 'list') {
      if (args[2] === 'runtimes') return answer(JSON.stringify({ runtimes: [{ identifier: RUNTIME, version: '26.5', isAvailable: true }] }));
      if (args[2] === 'devicetypes') return answer(JSON.stringify({ devicetypes: [{ name: 'iPad (A16)', identifier: DEVICE_TYPE }] }));
      return answer(JSON.stringify(devices));
    }
    if (args[0] === 'simctl' && args[1] === 'create') {
      devices.devices[RUNTIME].push({ udid: ID, name: args[2], state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: DEVICE_TYPE, dataPath: join(home, 'Library/Developer/CoreSimulator/Devices', ID, 'data') }); return answer(`${ID}\n`);
    }
    if (args[0] === 'simctl' && args[1] === 'boot') { assert.equal(ownership().udid, ID); devices.devices[RUNTIME][1].state = 'Booted'; return answer(); }
    if (args[0] === 'simctl' && args[1] === 'bootstatus') return answer();
    if (args[0] === 'xcdevice') return answer('[]');
    if (args.includes('-showdestinations')) return options.partialDestination ? answer(destination(), 70, { timedOut: true }) : answer(options.observed ? destination() : 'Available destinations for the "NativeQA" scheme:\n { platform:iOS Simulator, id:placeholder, name:Any iOS Simulator Device }');
    if (args.includes('-showBuildSettings')) return answer('bounded nonbuilding resolver diagnostic', options.observed ? 0 : 70);
    if (command === '/usr/bin/log') return answer('diagnostic-tail\n'.repeat(6_000));
    if (args[0] === 'simctl' && args[1] === 'shutdown') { devices.devices[RUNTIME][1].state = 'Shutdown'; if (options.renameAtShutdown) devices.devices[RUNTIME][1].name = 'foreign'; return answer(); }
    if (args[0] === 'simctl' && args[1] === 'delete') { assert.equal(args[2], ID); devices.devices[RUNTIME] = devices.devices[RUNTIME].filter((row) => row.udid !== ID); return answer(); }
    throw new Error(`Unexpected mocked command: ${command}`);
  };
  const deps = { execute, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; }, home, freeBytes: () => options.freeBytes ?? MIN_FREE_BYTES, uuid: () => INSTANCE, platform: 'darwin', arch: 'arm64' };
  return { root, env, deps, calls, waits, devices, ownership, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
async function using(options, operation) { const f = fixture(options); try { await operation(f); } finally { f.dispose(); } }

test('diagnostic context rejects local hosts, forks, missing hosting evidence and roots before native work', async () => {
  await using({}, async (f) => {
    assert.throws(() => diagnosticContext({ ...f.env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'darwin', 'arm64'));
    assert.throws(() => diagnosticContext({ ...f.env, GITHUB_EVENT_NAME: 'pull_request', QA_PR_HEAD_REPOSITORY: 'foreign/fork' }, 'darwin', 'arm64'));
    assert.throws(() => diagnosticContext(f.env, 'linux', 'arm64'));
    await assert.rejects(runDiagnostic({ ...f.env, GITHUB_ACTIONS: 'false' }, f.deps)); assert.equal(f.calls.length, 0);
  });
});
test('full registry comparison retains every preexisting metadata field and rejects duplicate UUIDs', () => {
  const a = { devices: { [RUNTIME]: [{ udid: ID, extraMetadata: { value: 1 } }] } }, b = structuredClone(a); b.devices[RUNTIME][0].extraMetadata.value = 2;
  assert.notDeepEqual(fullRegistry(a), fullRegistry(b)); const forged = structuredClone(a); forged.devices[RUNTIME][0].runtime = 'additional-field'; assert.notDeepEqual(fullRegistry(a), fullRegistry(forged)); a.devices[RUNTIME].push({ udid: ID }); assert.throws(() => fullRegistry(a));
});
test('ownership refuses foreign paths, names, device types and preexisting UUIDs', async () => {
  await using({}, async (f) => {
    await runDiagnostic(f.env, f.deps); const owned = f.ownership();
    const row = { udid: ID, name: owned.name, deviceTypeIdentifier: DEVICE_TYPE, dataPath: join(owned.deviceSetPath, ID, 'data') };
    for (const patch of [{ dataPath: '/foreign/data' }, { name: 'foreign' }, { deviceTypeIdentifier: 'iPhone' }]) assert.throws(() => ownedTarget(owned, { devices: { [RUNTIME]: [{ ...row, ...patch }] } }, [], f.deps.home));
    assert.throws(() => ownedTarget(owned, { devices: { [RUNTIME]: [row] } }, [{ udid: ID }], f.deps.home));
  });
});
test('destination discrimination requires exact compatible identity and incompatible wins', () => {
  const owned = { udid: ID, name: 'owned' }, row = `{ platform:iOS Simulator, id:${ID}, name:owned }`;
  for (const header of ['Available destinations for', 'Destinations compatible with']) assert.equal(destinationObservation(`${header}\n${row}`, owned).observed, true);
  assert.equal(destinationObservation(`Available destinations for\n${row}\nDestinations incompatible with\n${row}`, owned).observed, false);
  assert.equal(destinationObservation(`Available destinations for\n${row.replace(ID, INSTANCE)}`, owned).observed, false);
  assert.equal(destinationObservation(`Available destinations for\n${row.replace('name:owned', 'name:other')}`, owned).observed, false);
});
test('fixed observations run at0/15/45 seconds even while discovery stays missing, without a canary', async () => {
  await using({}, async (f) => {
    const result = await runDiagnostic(f.env, f.deps);
    assert.deepEqual(OFFSETS_MS, [0, 15_000, 45_000]); assert.deepEqual(result.samples.map((sample) => sample.actualMs), OFFSETS_MS); assert.deepEqual(f.waits, [0, 15_000, 30_000]);
    assert.equal(result.destinationObserved, false); assert.equal(result.diagnosticCompleted, true); assert.equal(result.nativeTestsExecuted, false); assert.equal(result.productBuilt, false);
    assert.equal(f.calls.filter((call) => call.args.includes('-showdestinations')).length, 3); assert.equal(f.calls.filter((call) => call.args[1] === 'boot').length, 1);
    for (const verb of ['build', 'build-for-testing', 'test', 'test-without-building', 'install', 'launch', 'erase']) assert.equal(f.calls.some((call) => call.args.includes(verb)), false);
    assert.deepEqual(f.devices.devices[RUNTIME].map((row) => row.name), ['preexisting']);
  });
});
test('resolver is one exact-UDID nonbuilding request and captures failure rather than substituting a device', async () => {
  await using({}, async (f) => {
    const result = await runDiagnostic(f.env, f.deps), calls = f.calls.filter((call) => call.args.includes('-showBuildSettings'));
    assert.equal(calls.length, 1); const args = calls[0].args; assert.equal(args[args.indexOf('-destination') + 1], `platform=iOS Simulator,id=${ID}`); assert.equal(args[args.indexOf('-destination-timeout') + 1], '30'); assert.equal(result.resolver.status, 70); assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO'));
  });
});
test('failed or timed-out destination output cannot become an observed destination', async () => {
  await using({ partialDestination: true }, async (f) => { const result = await runDiagnostic(f.env, f.deps); assert.equal(result.destinationObserved, false); assert.ok(result.samples.every((sample) => !sample.destination.commandCompleted)); });
});
test('observed destination remains discovery evidence only', async () => {
  await using({ observed: true }, async (f) => { const result = await runDiagnostic(f.env, f.deps); assert.equal(result.destinationObserved, true); assert.equal(result.nativeTestsExecuted, false); assert.equal(result.productBuilt, false); });
});
test('insufficient8GiB space stops before create and boot', async () => {
  await using({ freeBytes: MIN_FREE_BYTES - 1 }, async (f) => { await assert.rejects(runDiagnostic(f.env, f.deps), /8GiB/); assert.equal(f.calls.some((call) => ['create', 'boot'].includes(call.args[1])), false); });
});
test('cleanup revalidates the owned tuple after shutdown and never deletes a renamed device', async () => {
  await using({ renameAtShutdown: true }, async (f) => { await assert.rejects(runDiagnostic(f.env, f.deps), /tuple changed/); assert.equal(f.calls.some((call) => call.args[1] === 'delete'), false); });
});
test('outer cleanup is guarded and already-absent ownership cannot touch preexisting devices', async () => {
  await using({}, async (f) => {
    await runDiagnostic(f.env, f.deps); const start = f.calls.length; const result = await runDiagnosticCleanup(f.env, f.deps); assert.equal(result.ownedAbsent, true); assert.equal(f.calls.slice(start).some((call) => ['shutdown', 'delete'].includes(call.args[1])), false);
    const beforeDeniedCleanup = f.calls.length;
    await assert.rejects(runDiagnosticCleanup({ ...f.env, RUNNER_ENVIRONMENT: 'self-hosted' }, f.deps)); assert.equal(f.calls.length, beforeDeniedCleanup);
  });
});
test('retained log tails have exact hashes and private bounded regular files', async () => {
  await using({}, async (f) => {
    await runDiagnostic(f.env, f.deps); const path = join(f.env.RUNNER_TEMP, 'ipad-destination-diagnostic-123-1/evidence');
    for (const name of readdirSync(path)) { const file = join(path, name); assert.equal(statSync(file).mode & 0o777, 0o600); if (!name.endsWith('.log.json')) continue; const metadata = JSON.parse(readFileSync(file)); const bytes = readFileSync(join(path, metadata.log)); assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256); if (metadata.tail) assert.ok(bytes.length <= 64 * 1024); }
  });
});
test('workflow stays independent, same-repository/manual, read-only and never selects old canary paths', () => {
  const paths = [...workflow.slice(workflow.indexOf('paths:'), workflow.indexOf('permissions:')).matchAll(/- '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(paths, ['.github/workflows/ipad-destination-diagnostic.yml', 'scripts/ipad-destination-diagnostic.mjs', 'scripts/ipad_destination_diagnostic.test.mjs']);
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /head\.repo\.full_name == github\.repository/); assert.match(workflow, /contents: read/); assert.match(workflow, /persist-credentials: false/); assert.match(workflow, /runs-on: macos-26/); assert.match(workflow, /if: always\(\)/); assert.doesNotMatch(workflow, /push:|secrets\.|contents: write|hosted-run\.mjs(?: |$)|ipad_native_qa\.test/);
  assert.doesNotMatch(source, /runHostedCanary|runHostedCleanup|test-without-building|build-for-testing|xcode-select|DeveloperToolsSecurity/); assert.match(source, /child\.kill\('SIGKILL'\)/); assert.match(source, /2_000/); assert.match(source, /MAX_ARTIFACT_BYTES/);
});
