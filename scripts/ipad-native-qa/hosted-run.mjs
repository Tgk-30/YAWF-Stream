#!/usr/bin/env node
// Disposable hosted COUNTER-ONLY XCTest canary. No Safari, fixture or product playback.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateOwnership } from './preflight.mjs';

export const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
export const DEVELOPER_DIR = '/Applications/Xcode_26.5.app/Contents/Developer';
export const COUNTER = 'SafariNativeInputTests/testNativeCounterInput()';
export const SELECTOR = 'SafariNativeInputTests/SafariNativeInputTests/testNativeCounterInput';
export const MIN_FREE_BYTES = 8 * 1024 ** 3;
const RESERVED_FREE_BYTES = 2 * 1024 ** 3;
const MAX_LOG_BYTES = 8 * 1024 ** 2;
const MAX_EVIDENCE_BYTES = 256 * 1024 ** 2;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const value = (object) => object?._value;
const values = (object) => object?._values ?? [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireThat(condition, reason) { if (!condition) throw new Error(reason); }
function inside(root, path) { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
export function hostedContext(env, platform = process.platform, arch = process.arch, real = realpathSync) {
  requireThat(platform === 'darwin' && arch === 'arm64' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'macOS' && env.RUNNER_ARCH === 'ARM64', 'Only a GitHub-hosted ARM macOS runner is admitted');
  const approvedEvent = env.GITHUB_EVENT_NAME === 'workflow_dispatch' || (env.GITHUB_EVENT_NAME === 'pull_request' && env.QA_PR_HEAD_REPOSITORY === env.GITHUB_REPOSITORY);
  requireThat(approvedEvent && env.GITHUB_REPOSITORY === 'Tgk-30/YAWF-Stream' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'Exact-source repository event admission failed');
  requireThat(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Run identity is invalid');
  const temp = resolve(env.RUNNER_TEMP ?? '');
  const workspace = resolve(env.GITHUB_WORKSPACE ?? '');
  requireThat(isAbsolute(env.RUNNER_TEMP ?? '') && isAbsolute(env.GITHUB_WORKSPACE ?? '') && temp !== sep && workspace !== sep && temp !== workspace && !inside(temp, workspace) && !inside(workspace, temp) && real(temp) === temp && real(workspace) === workspace, 'Canonical separate runner-owned roots are mandatory');
  return { temp, workspace, evidence: join(temp, `ipad-native-qa-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`), source: env.GITHUB_SHA };
}
export function admitToolchain(version, runtimes, types, freeBytes) {
  requireThat(version.trim() === 'Xcode 26.5\nBuild version 17F42', 'Exact Xcode26.5 toolchain is required');
  requireThat(Number.isSafeInteger(freeBytes) && freeBytes >= MIN_FREE_BYTES, 'At least8GiB free disk is required before simulator creation');
  const runtime = runtimes.runtimes?.filter((item) => item.identifier === RUNTIME && item.version === '26.5' && item.isAvailable === true);
  const type = types.devicetypes?.filter((item) => item.name === 'iPad (A16)' && item.identifier?.startsWith('com.apple.CoreSimulator.SimDeviceType.iPad'));
  requireThat(runtime?.length === 1 && type?.length === 1, 'One installed available iOS26.5 runtime and exact iPad(A16) type are required; no downloads/fallback');
  return { runtime: runtime[0], deviceType: type[0] };
}
export function registrySnapshot(registry, excluding = null) {
  const rows = Object.entries(registry.devices ?? {}).flatMap(([runtime, devices]) => devices.map((device) => ({ ...device, runtime })));
  requireThat(rows.every((row) => UUID.test(row.udid ?? '')) && new Set(rows.map((row) => row.udid.toUpperCase())).size === rows.length, 'Ambiguous simulator registry');
  return rows.filter((row) => row.udid.toUpperCase() !== excluding?.toUpperCase()).map((row) => ({
    udid: row.udid.toUpperCase(), runtime: row.runtime, name: row.name, state: row.state,
    isAvailable: row.isAvailable, deviceTypeIdentifier: row.deviceTypeIdentifier, dataPath: row.dataPath,
  })).sort((a, b) => a.udid.localeCompare(b.udid));
}
export function admitCreatedDevice(ownership, registry, before, destinations, deviceType) {
  requireThat(!before.some((row) => row.udid === ownership.udid.toUpperCase()), 'An existing simulator cannot become owned');
  requireThat(JSON.stringify(registrySnapshot(registry, ownership.udid)) === JSON.stringify(before), 'Preexisting simulator metadata changed or an unexpected clone appeared');
  const admitted = validateOwnership(ownership, registry, destinations);
  const row = registrySnapshot(registry).find((item) => item.udid === ownership.udid.toUpperCase());
  requireThat(ownership.runtimeIdentifier === RUNTIME && row.deviceTypeIdentifier === deviceType && ownership.rootApprovedDefaultSet === true, 'Hosted device tuple mismatch');
  return admitted;
}
export function cleanupTarget(ownership, registry, before, deviceType, home = homedir()) {
  requireThat(UUID.test(ownership?.udid ?? '') && ownership.createdFor === 'ipad-native-qa' && ownership.createdFresh === true && ownership.runtimeIdentifier === RUNTIME && ownership.rootApprovedDefaultSet === true, 'Missing owned creation receipt');
  requireThat(/^YAWF-iPad-NativeQA-[a-f0-9-]{36}$/i.test(ownership.name ?? '') && ownership.deviceSetPath === join(home, 'Library/Developer/CoreSimulator/Devices'), 'Foreign device-set cleanup refused');
  requireThat(!before.some((row) => row.udid === ownership.udid.toUpperCase()), 'Preexisting device cleanup refused');
  const rows = registrySnapshot(registry); const row = rows.find((item) => item.udid === ownership.udid.toUpperCase());
  if (row == null) return null;
  requireThat(row.name === ownership.name && row.runtime === RUNTIME && row.deviceTypeIdentifier === deviceType && row.dataPath === join(ownership.deviceSetPath, ownership.udid, 'data'), 'Cleanup ownership mismatch');
  return ownership.udid;
}
export function cleanupOwnedDevice(ownership, registry, before, deviceType, exec, home = homedir()) {
  const udid = cleanupTarget(ownership, registry, before, deviceType, home);
  if (udid == null) return { alreadyAbsent: true };
  // Shutdown can report an already-shutdown device. Deletion still requires the
  // exact freshly created tuple; no global shutdown/erase/delete is permitted.
  exec(['simctl', 'shutdown', udid], true);
  exec(['simctl', 'delete', udid]);
  return { deleted: udid };
}
export function expectedEnvironment(ownership, source, instance) {
  requireThat(/^[a-f0-9]{40}$/.test(source) && UUID.test(instance), 'Invalid public source/run identity');
  return { QA_EXPECTED_UDID: ownership.udid, QA_OWNED_DEVICE_NAME: ownership.name,
    QA_HTTP_PROBE_URL: 'http://127.0.0.1:43178/__qa/arrival', QA_EXPECTED_FIXTURE_ID: instance, QA_EXPECTED_SOURCE_REVISION: source };
}
export function validateTestRun(plist, expected, products, isOwnedFile = (path) => existsSync(path) && inside(realpathSync(products), realpathSync(path))) {
  const targets = plist.TestConfigurations?.flatMap((configuration) => configuration.TestTargets ?? []);
  requireThat(plist.__xctestrun_metadata__?.FormatVersion === 2 && targets?.length === 1, 'Exactly one generated test target/configuration is required');
  const target = targets[0];
  requireThat(target.BlueprintName === 'SafariNativeInputTests' && target.IsUITestBundle === true, 'Unexpected XCTest target');
  const env = target.EnvironmentVariables ?? {};
  requireThat(Object.keys(env).filter((key) => key.startsWith('QA_')).sort().join() === Object.keys(expected).sort().join(), 'Five resolved QA environment values are required');
  for (const [key, text] of Object.entries(expected)) requireThat(env[key] === text && !String(env[key]).includes('$('), `Unresolved or mismatched QA environment: ${key}`);
  requireThat(!Object.keys(env).some((key) => key.startsWith('SIMULATOR_')) && Object.keys(target.CommandLineArguments ?? {}).length === 0, 'Simulator identity/launch argument overrides are forbidden');
  for (const key of ['TestBundlePath', 'TestHostPath', 'UITargetAppPath']) {
    const text = target[key];
    requireThat(typeof text === 'string' && text.startsWith('__TESTROOT__/') && !text.includes('$('), `Unresolved/unowned product: ${key}`);
    const path = resolve(products, text.slice('__TESTROOT__/'.length));
    requireThat(inside(products, path) && isOwnedFile(path), `Product escapes the owned build: ${key}`);
    const rel = relative(products, path);
    const suffix = key === 'TestBundlePath' ? /SafariNativeInputTests-Runner\.app\/PlugIns\/SafariNativeInputTests\.xctest$/
      : key === 'UITargetAppPath' ? /NativeQAAnchor\.app$/ : /SafariNativeInputTests-Runner\.app(?:\/SafariNativeInputTests-Runner)?$/;
    requireThat(suffix.test(rel), `Wrong owned product identity: ${key}`);
  }
  return target;
}
export function validateSummary(summary) {
  requireThat(summary.result === 'Passed' && summary.totalTestCount === 1 && summary.passedTests === 1 && summary.failedTests === 0 && summary.skippedTests === 0 && summary.expectedFailures === 0 && summary.testFailures?.length === 0 && summary.runtimeWarnings?.length === 0, 'Counter requires exactly1pass/0fail/0skip and no runtime warning');
}
function walk(object, found = []) { if (object && typeof object === 'object') { found.push(object); for (const child of Object.values(object)) if (child && typeof child === 'object') walk(child, found); } return found; }
export function admitResultAction(root, udid) {
  const actions = values(root.actions).filter((action) => action.actionResult?.testsRef != null);
  requireThat(actions.length === 1 && value(actions[0].actionResult.status) === 'succeeded' && value(actions[0].runDestination?.targetDeviceRecord?.identifier)?.toUpperCase() === udid.toUpperCase(), 'Actual XCTest destination/action mismatch');
  const id = value(actions[0].actionResult.testsRef.id); requireThat(typeof id === 'string' && id.length > 0 && id.length < 512, 'Missing actual tests object'); return id;
}
export function admitCounterTest(tests) {
  const leaves = walk(tests).filter((node) => node.testStatus != null);
  requireThat(leaves.length === 1 && value(leaves[0].identifier) === COUNTER && value(leaves[0].testStatus) === 'Success', 'Only the actual successful counter method is admitted');
  const id = value(leaves[0].summaryRef?.id); requireThat(typeof id === 'string' && id.length > 0 && id.length < 512, 'Missing counter test summary'); return id;
}
export function admitCounterAttachment(testSummary) {
  const screenshots = walk(testSummary).filter((node) => value(node.name) === 'native-counter-three-real-taps' && value(node.uniformTypeIdentifier) === 'public.png');
  requireThat(screenshots.length === 1, 'Exactly one retained native Counter3 screenshot is required');
  const id = value(screenshots[0].payloadRef?.id); requireThat(typeof id === 'string' && id.length > 0 && id.length < 512, 'Missing screenshot payload'); return id;
}
function artifactSize(root) { return readdirSync(root).filter((name) => !['tmp', 'DerivedData', 'evidence'].includes(name)).reduce((total, name) => total + treeSize(join(root, name)), 0); }
function treeSize(path) { if (!existsSync(path)) return 0; requireThat(!lstatSync(path).isSymbolicLink(), 'Symlink evidence is forbidden'); return lstatSync(path).isDirectory() ? readdirSync(path).reduce((total, name) => total + treeSize(join(path, name)), 0) : statSync(path).size; }

export function nativeEnvironment(temp, env = process.env) {
  return { HOME: homedir(), USER: env.USER ?? 'runner', LOGNAME: env.LOGNAME ?? 'runner',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    DEVELOPER_DIR, TMPDIR: temp };
}
export function runHostedCleanup(env = process.env) {
  const context = hostedContext(env); const e = context.evidence;
  if (!existsSync(e)) return { noOwnedRun: true };
  requireThat(realpathSync(e) === e && inside(context.temp, e), 'Cleanup evidence root is not owned');
  const artifact = join(e, 'evidence'); if (!existsSync(artifact)) mkdirSync(artifact);
  const load = (name) => {
    const path = join(e, name);
    requireThat(!lstatSync(path).isSymbolicLink() && statSync(path).size <= 1024 ** 2, 'Invalid bounded cleanup receipt');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  let sequence = 0;
  const exec = (args, tolerate = false) => {
    const result = spawnSync('/usr/bin/xcrun', args, { env: nativeEnvironment(join(e, 'tmp'), env), encoding: 'utf8', timeout: 60_000, maxBuffer: MAX_LOG_BYTES });
    writeFileSync(join(artifact, `cleanup-final-${++sequence}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (!tolerate) { if (result.error) throw result.error; requireThat(result.status === 0, 'Final owned cleanup command failed'); }
    return result.stdout ?? '';
  };
  if (!existsSync(join(e, 'ownership.json')) && !existsSync(join(e, 'devices-before.json'))) {
    const receipt = { noCreatedDevice: true, admissionStoppedBeforeDeviceSnapshot: true };
    writeFileSync(join(artifact, 'cleanup-final.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }
  const before = load('devices-before.json');
  if (!existsSync(join(e, 'ownership.json'))) {
    requireThat(JSON.stringify(registrySnapshot(JSON.parse(exec(['simctl', 'list', 'devices', '-j'])))) === JSON.stringify(before), 'Unrecorded simulator changes require review; no device will be deleted');
    const receipt = { noCreatedDevice: true, preexistingDevicesUnchanged: true };
    writeFileSync(join(artifact, 'cleanup-final.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }
  const ownership = load('ownership.json'); const deviceType = load('toolchain.json').deviceType.identifier;
  const cleanup = cleanupOwnedDevice(ownership, JSON.parse(exec(['simctl', 'list', 'devices', '-j'])), before, deviceType, exec);
  const after = registrySnapshot(JSON.parse(exec(['simctl', 'list', 'devices', '-j'])));
  requireThat(JSON.stringify(after) === JSON.stringify(before), 'Final cleanup did not preserve the preexisting simulator registry');
  const receipt = { ...cleanup, preexistingDevicesUnchanged: true };
  writeFileSync(join(artifact, 'cleanup-final.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function runHostedCanary(env = process.env) {
  const context = hostedContext(env); const e = context.evidence;
  mkdirSync(e, { mode: 0o700 }); // Exclusive fresh evidence; never mix attempts.
  const write = (name, data) => writeFileSync(join(e, name), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  let sequence = 0; let ownership = null; let before = null; let deviceType = null; let failure = null;
  const receipt = { schemaVersion: 1, mode: 'counter-only', source: context.source, fixtureStarted: false, placeholderProbeOnly: true, safariTestSelected: false, nativePass: false };
  const exec = (command, args, { tolerate = false, timeout = 120_000 } = {}) => {
    const result = spawnSync(command, args, { env: nativeEnvironment(join(e, 'tmp'), env), encoding: 'utf8', timeout, maxBuffer: MAX_LOG_BYTES });
    const log = `${String(++sequence).padStart(2, '0')}-${basename(command)}.log`;
    writeFileSync(join(e, log), `${result.stdout ?? ''}${result.stderr ?? ''}`);
    requireThat(artifactSize(e) <= MAX_EVIDENCE_BYTES, 'Bounded evidence budget exceeded');
    if (!tolerate) { if (result.error) throw result.error; requireThat(result.status === 0, `Command failed: ${basename(command)} (${log})`); }
    return result.stdout ?? '';
  };
  const xcrun = (args, tolerate = false) => exec('/usr/bin/xcrun', args, { tolerate });
  const registry = () => JSON.parse(xcrun(['simctl', 'list', 'devices', '-j']));
  const freeDisk = () => { const fs = statfsSync(context.temp); return fs.bavail * fs.bsize; };
  try {
    mkdirSync(join(e, 'tmp')); write('context.json', { ...context, imageOS: env.ImageOS, imageVersion: env.ImageVersion, developerDir: DEVELOPER_DIR, publicCounterPlaceholder: true });
    requireThat(exec('/usr/bin/git', ['-C', context.workspace, 'rev-parse', 'HEAD']).trim() === context.source, 'Checked-out source mismatch');
    const osVersion = exec('/usr/bin/sw_vers', ['-productVersion']).trim();
    requireThat(/^26\./.test(osVersion), 'Actual macOS26 is required');
    const version = exec('/usr/bin/xcodebuild', ['-version']);
    const admitted = admitToolchain(version, JSON.parse(xcrun(['simctl', 'list', 'runtimes', '-j'])), JSON.parse(xcrun(['simctl', 'list', 'devicetypes', '-j'])), freeDisk());
    deviceType = admitted.deviceType.identifier; write('toolchain.json', { osVersion, version, ...admitted, freeBytesBeforeCreate: freeDisk() });
    before = registrySnapshot(registry()); write('devices-before.json', before);
    const instance = randomUUID(); const name = `YAWF-iPad-NativeQA-${instance}`;
    const udid = xcrun(['simctl', 'create', name, deviceType, RUNTIME]).trim();
    requireThat(UUID.test(udid), 'Creation returned no unique simulator UUID');
    ownership = { schemaVersion: 1, createdFor: 'ipad-native-qa', createdFresh: true, udid, name, runtimeIdentifier: RUNTIME, deviceSetPath: join(homedir(), 'Library/Developer/CoreSimulator/Devices'), rootApprovedDefaultSet: true };
    write('ownership.json', ownership); // Immediate receipt before boot or build.
    const created = registry(); write('devices-created.json', created);
    cleanupTarget(ownership, created, before, deviceType); // Reject reuse/mismatched creation before boot.
    const createdRow = registrySnapshot(created).find((row) => row.udid === udid.toUpperCase());
    requireThat(createdRow?.state === 'Shutdown' && createdRow.isAvailable === true, 'Fresh creation must be available and Shutdown before boot');
    requireThat(JSON.stringify(registrySnapshot(created, udid)) === JSON.stringify(before), 'Creation changed preexisting devices');
    xcrun(['simctl', 'boot', udid]); xcrun(['simctl', 'bootstatus', udid, '-b']);
    const project = join(context.workspace, 'scripts/ipad-native-qa/NativeQA.xcodeproj');
    const destinations = exec('/usr/bin/xcodebuild', ['-project', project, '-scheme', 'NativeQA', '-showdestinations']);
    const booted = registry(); write('devices-admitted.json', booted); writeFileSync(join(e, 'destinations.txt'), destinations);
    write('device-admission.json', admitCreatedDevice(ownership, booted, before, destinations, deviceType));
    const expected = expectedEnvironment(ownership, context.source, instance);
    const derived = join(e, 'DerivedData'); const products = join(derived, 'Build/Products');
    exec('/usr/bin/xcodebuild', ['build-for-testing', '-project', project, '-scheme', 'NativeQA', '-sdk', 'iphonesimulator', '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived, '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', ...Object.entries(expected).map(([key, text]) => `${key}=${text}`)], { timeout: 300_000 });
    requireThat(freeDisk() >= RESERVED_FREE_BYTES, 'Disk reserve below2GiB after build');
    requireThat(realpathSync(products) === products && inside(e, products), 'Build products must remain in the actual owned evidence tree');
    const runs = readdirSync(products).filter((name) => name.endsWith('.xctestrun')); requireThat(runs.length === 1, 'Exactly one generated xctestrun is required');
    const run = join(products, runs[0]);
    requireThat(lstatSync(run).isFile() && !lstatSync(run).isSymbolicLink() && realpathSync(run) === run && statSync(run).size <= 1024 ** 2, 'Generated xctestrun must be an owned bounded regular file');
    const plist = JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', run]));
    const target = validateTestRun(plist, expected, products);
    const binaries = [];
    for (const [key, bundleID] of [['UITargetAppPath', 'com.yawf.tests.ipadnativeqa.anchor'], ['TestHostPath', 'com.yawf.tests.ipadnativeqa.uitests.xctrunner']]) {
      const path = resolve(products, target[key].slice('__TESTROOT__/'.length));
      const app = path.slice(0, path.indexOf('.app') + 4);
      const info = JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]));
      requireThat(info.CFBundleIdentifier === bundleID && /^[A-Za-z0-9_-]+$/.test(info.CFBundleExecutable ?? ''), 'Unexpected owned application identity');
      const executable = join(app, info.CFBundleExecutable);
      requireThat(inside(realpathSync(products), realpathSync(executable)), 'Owned executable escapes build products');
      const architectures = exec('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/);
      requireThat(architectures.includes('arm64'), 'Simulator product is missing ARM64');
      binaries.push({ bundleID, executable: relative(products, executable), architectures, sha256: hash(readFileSync(executable)) });
    }
    write('product-admission.json', binaries);
    write('xctestrun-admission.json', { file: runs[0], sha256: hash(readFileSync(run)), expected, counterOnly: true });
    const resultPath = join(e, 'counter.xcresult');
    exec('/usr/bin/xcodebuild', ['test-without-building', '-xctestrun', run, '-destination', `platform=iOS Simulator,id=${udid}`, '-destination-timeout', '30', '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1', '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '120', '-maximum-test-execution-time-allowance', '120', `-only-testing:${SELECTOR}`, '-resultBundlePath', resultPath, 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO'], { timeout: 240_000 });
    const summary = JSON.parse(xcrun(['xcresulttool', 'get', 'test-results', 'summary', '--path', resultPath])); write('test-summary.json', summary); validateSummary(summary);
    const getObject = (id) => JSON.parse(xcrun(['xcresulttool', 'get', 'object', '--legacy', '--path', resultPath, '--format', 'json', ...(id ? ['--id', id] : [])]));
    const action = getObject(); write('result-action.json', action);
    const tests = getObject(admitResultAction(action, udid)); write('counter-tests.json', tests);
    const details = getObject(admitCounterTest(tests)); write('counter-details.json', details);
    const screenshot = admitCounterAttachment(details);
    mkdirSync(join(e, 'attachments')); const png = join(e, 'attachments/native-counter-three-real-taps.png');
    xcrun(['xcresulttool', 'export', 'object', '--legacy', '--path', resultPath, '--id', screenshot, '--type', 'file', '--output-path', png]);
    requireThat(readFileSync(png).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Exported attachment is not a PNG');
    receipt.nativePass = true; receipt.screenshotSHA256 = hash(readFileSync(png));
  } catch (error) { failure = error; receipt.error = error instanceof Error ? error.message : 'Counter canary failed'; }
  finally {
    if (failure != null && existsSync(join(e, 'counter.xcresult'))) {
      try {
        exec('/usr/bin/xcrun', ['xcresulttool', 'export', 'attachments', '--path', join(e, 'counter.xcresult'), '--output-path', join(e, 'failure-attachments')]);
      } catch (error) { receipt.attachmentExportError = error.message; }
    }
    try {
      if (ownership != null && before != null) {
        const current = registry(); write('devices-before-cleanup.json', current);
        receipt.cleanup = cleanupOwnedDevice(ownership, current, before, deviceType, xcrun);
        const after = registry(); write('devices-after.json', after);
        requireThat(cleanupTarget(ownership, after, before, deviceType) == null, 'Owned simulator still exists after cleanup');
        requireThat(JSON.stringify(registrySnapshot(after)) === JSON.stringify(before), 'Preexisting device metadata changed or an unexpected simulator remains');
        receipt.preexistingDevicesUnchanged = true;
      }
    } catch (error) { receipt.cleanupError = error.message; failure ??= error; }
    // DerivedData is not an upload artifact. Keep the complete bounded xcresult,
    // public receipts, command logs and exported native attachments on failures.
    const artifact = join(e, 'evidence'); mkdirSync(artifact);
    let stagedBytes = 0;
    for (const name of readdirSync(e).filter((name) => !['tmp', 'DerivedData', 'evidence'].includes(name))) {
      try {
        const from = join(e, name); const bytes = treeSize(from);
        requireThat(stagedBytes + bytes <= MAX_EVIDENCE_BYTES, 'Complete artifact budget exceeded; oversized item not staged');
        cpSync(from, join(artifact, name), { recursive: true, errorOnExist: true, force: false });
        stagedBytes += bytes;
      } catch (error) { receipt.artifactError = error.message; failure ??= error; }
    }
    receipt.success = failure == null && receipt.nativePass && receipt.preexistingDevicesUnchanged === true;
    writeFileSync(join(artifact, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (failure) throw failure;
  return receipt;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--cleanup-only') runHostedCleanup();
  else {
    if (process.argv.length !== 2) throw new Error('Only the counter transaction or exact cleanup-only operation is admitted');
    runHostedCanary();
  }
}
