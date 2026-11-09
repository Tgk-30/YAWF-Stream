import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, realpathSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PIN, sanitize, validateEnvironment, validateCatalog, cpuSnapshot, iowaitPercent,
  validateGuest, validateLauncher, validateJUnit, validateReceipt, ownedDirectory } from './android_player90_runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const java = readFileSync(join(root, 'scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimePlayer90MoreFlowTest.java'), 'utf8');
const driver = readFileSync(join(root, 'scripts/android_player90_runtime.mjs'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/android-player90-runtime.yml'), 'utf8');
const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  CANDIDATE_SOURCE_SHA: PIN.source, CANDIDATE_RUN_ID: PIN.run, CANDIDATE_APK_SHA256: PIN.sha256,
  CANDIDATE_VERSION: PIN.version, CANDIDATE_VERSION_CODE: PIN.code, SYSTEM_IMAGE_PACKAGE: PIN.image,
  AVD_NAME: PIN.avd, EMULATOR_SERIAL: PIN.serial, EMULATOR_GPU: PIN.gpu,
  CANDIDATE_APK: 'candidate/YAWF.Stream_Android_2.3.90.apk', CANDIDATE_ARTIFACT: 'android-phone-verification-candidate' });
const guest = () => ({ sdk: '36', abi: 'x86_64', hardware: 'ranchu', pageSize: '4096',
  webview: 'Current WebView package (name, version): (com.google.android.webview, 144.0.7559.0)' });
const input = (role = 'more') => ({ role, ok: true, tool: 'finger', toolType: 1, durationMs: 100, steps: 2,
  targetBounds: [10, 10, 100, 100], x: 50, y: 50, foregroundTargetBefore: true, foregroundTargetAfter: true, upAcknowledged: true, streamMayRemain: false,
  cancelAcknowledged: false, downUptimeMs: 1000, eventUptimeMs: [1000, 1050, 1100] });
const receipt = () => ({ schemaVersion: 1, profile: 'private90-hosted-more', outcome: 'PASS', phase: 'complete',
  sourceClicks: 1, explicitSourceRow: true, clockBeforeSeconds: 2, clockAfterSeconds: 4,
  uniqueMenu: true, menuHeading: true, singleUiAutomationOwner: true, menuBounds: [0, 500, 1080, 1800], inputs: [input()] });
const junit = 'INSTRUMENTATION_STATUS: numtests=1\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n';

test('fixed hosted90 profile accepts only official Linux X64 context', () => {
  validateEnvironment(environment());
  for (const [key, bad] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_ENVIRONMENT', undefined],
    ['RUNNER_OS', 'macOS'], ['RUNNER_ARCH', 'ARM64']]) assert.throws(() => validateEnvironment({ ...environment(), [key]: bad }));
});
test('candidate source run APK code image serial and renderer are indivisible pins', () => {
  for (const key of ['CANDIDATE_SOURCE_SHA', 'CANDIDATE_RUN_ID', 'CANDIDATE_APK_SHA256', 'CANDIDATE_VERSION',
    'CANDIDATE_VERSION_CODE', 'SYSTEM_IMAGE_PACKAGE', 'AVD_NAME', 'EMULATOR_SERIAL', 'EMULATOR_GPU', 'CANDIDATE_APK', 'CANDIDATE_ARTIFACT']) {
    assert.throws(() => validateEnvironment({ ...environment(), [key]: 'wrong' }), key);
  }
});
test('stable SDK catalog must contain exact official API36 x86 package row', () => {
  validateCatalog(`Available Packages:\n ${PIN.image} | 11 | Google APIs Intel x86_64\n`);
  for (const bad of ['', `${PIN.image}-preview | 11 | image`, `prefix ${PIN.image} | 11 | image`, `${PIN.image} | beta | image`]) {
    assert.throws(() => validateCatalog(bad));
  }
});
test('actual CPU intervals reject reset zero and excessive counters', () => {
  assert.deepEqual(cpuSnapshot('cpu 10 0 10 70 5 2 3 0 0 0\n'), { total: 100, iowait: 5 });
  assert.equal(iowaitPercent({ total: 100, iowait: 5 }, { total: 200, iowait: 10 }), 5);
  for (const after of [{ total: 100, iowait: 5 }, { total: 99, iowait: 5 }, { total: 200, iowait: 4 }, { total: 200, iowait: 106 }]) {
    assert.throws(() => iowaitPercent({ total: 100, iowait: 5 }, after));
  }
  assert.throws(() => cpuSnapshot('cpu incomplete'));
});
test('guest fences API ABI hardware page size and actual WebView', () => {
  assert.deepEqual(validateGuest(guest()), { package: 'com.google.android.webview', version: '144.0.7559.0' });
  for (const [key, bad] of [['sdk', '35'], ['abi', 'arm64-v8a'], ['hardware', 'physical'], ['pageSize', '16384'],
    ['webview', 'Current WebView package (name, version): (com.google.android.webview, 89.0.1.2)'], ['webview', 'provider unknown']]) {
    assert.throws(() => validateGuest({ ...guest(), [key]: bad }));
  }
});
test('resumed launcher admission is not boot-complete alone', () => {
  validateLauncher('mResumedActivity: ActivityRecord{abc u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}');
  validateLauncher('topResumedActivity=ActivityRecord{abc u0 com.android.launcher3/.Launcher t1}');
  for (const value of ['sys.boot_completed=1', 'mResumedActivity: com.android.settings/.Settings', 'com.android.launcher3/.Launcher background']) {
    assert.throws(() => validateLauncher(value));
  }
});
test('JUnit requires exactly one genuine completed pass without failures or skips', () => {
  validateJUnit(junit);
  for (const value of ['INSTRUMENTATION_CODE: -1', 'OK (2 tests)\nINSTRUMENTATION_CODE: -1', junit + 'FAILURES!!!',
    junit + 'INSTRUMENTATION_STATUS_CODE: -3', junit + 'ignored', 'OK (1 test)\nINSTRUMENTATION_CODE: 0']) assert.throws(() => validateJUnit(value));
});
test('semantic menu proof accepts the complete finite case', () => { validateReceipt(receipt()); });
test('semantic menu proof rejects a passing exit without actual heading and unique dialog', () => {
  for (const key of ['menuHeading', 'uniqueMenu', 'singleUiAutomationOwner', 'explicitSourceRow']) {
    const value = receipt(); value[key] = false; assert.throws(() => validateReceipt(value));
  }
  const value = receipt(); value.menuBounds = [0, 500, 0, 500]; assert.throws(() => validateReceipt(value));
});
test('explicit source row once and genuine nonzero progressing clock are required', () => {
  for (const changes of [{ sourceClicks: 0 }, { sourceClicks: 2 }, { clockBeforeSeconds: 0 }, { clockAfterSeconds: 2 },
    { clockAfterSeconds: '4' }, { clockAfterSeconds: 36 }]) assert.throws(() => validateReceipt({ ...receipt(), ...changes }));
});
test('native FINGER proof requires foreground UP certainty and no outstanding stream', () => {
  for (const changes of [{ ok: false }, { tool: 'unknown' }, { toolType: 0 }, { durationMs: 99 }, { steps: 3 },
    { foregroundTargetBefore: false }, { foregroundTargetAfter: false }, { upAcknowledged: false },
    { streamMayRemain: true }, { cancelAcknowledged: true }, { x: 100 }, { targetBounds: [] }, { eventUptimeMs: [1000, 1050, 1099] }]) {
    const value = receipt(); value.inputs = [{ ...input(), ...changes }]; assert.throws(() => validateReceipt(value));
  }
});
test('More actual DOWN must fall inside single reveal auto-hide window', () => {
  const value = receipt(); value.inputs.unshift(input('reveal'));
  value.inputs[1] = { ...input(), downUptimeMs: 2000, eventUptimeMs: [2000, 2050, 2100] };
  validateReceipt(value);
  value.inputs[1] = { ...input(), downUptimeMs: 4300, eventUptimeMs: [4300, 4350, 4400] };
  assert.throws(() => validateReceipt(value));
  value.inputs = [input('reveal')]; assert.throws(() => validateReceipt(value));
  value.inputs = [input(), input()]; assert.throws(() => validateReceipt(value));
});
test('redaction removes URL credentials cookie and stream capability material', () => {
  const output = sanitize('https://example.invalid/api/stream/private?secret=x Cookie: ds_session=abc BearerTOKEN fixture-owner-password');
  for (const forbidden of ['https://', 'private?', 'ds_session', 'BearerTOKEN', 'fixture-owner-password']) assert.ok(!output.includes(forbidden));
  assert.ok(!sanitize('Authorization: Bearer opaque-header-value').includes('opaque-header-value'));
  assert.ok(!sanitize('Cookie: session=opaque-cookie-value').includes('opaque-cookie-value'));
  assert.ok(!sanitize('Bearer opaque-bearer-value').includes('opaque-bearer-value'));
});
test('new output ownership rejects aliases existing output and parent escape', () => {
  const parent = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(parent && parent.startsWith('/'), 'Tests require an explicit owned temporary root');
  const base = realpathSync(mkdtempSync(join(parent, 'more90-contract-')));
  const output = join(base, 'output'); assert.equal(ownedDirectory(output, base, true), output);
  assert.throws(() => ownedDirectory(output, base, true));
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'alias'));
  assert.throws(() => ownedDirectory(join(base, 'alias'), base));
  assert.throws(() => ownedDirectory(join(base, '..', 'escape'), base));
});
test('immutable root-owned workflow prefix stays byte exact', () => {
  const marker = '      # BEGIN OWNED TEST-ONLY EXECUTION\n';
  const prefix = workflow.split(marker)[0] + marker;
  assert.equal(createHash('sha256').update(prefix).digest('hex'), PIN.prefix);
});
test('workflow explicitly limits setup-android to platform-tools without removed tools default', () => {
  const block = /      - name: Set up official Android SDK\n([\s\S]*?)(?=      - name: |$)/.exec(workflow)?.[1];
  assert.ok(block, 'The scoped SDK setup step must exist');
  assert.match(block, /        uses: android-actions\/setup-android@v3\n        with:\n          packages: platform-tools\n$/);
  assert.doesNotMatch(block, /(?:^|\s)tools(?:\s|$)/);
});
test('workflow admits exact SDK emulator in both current and subsequent step PATH', () => {
  assert.match(workflow, /test -n "\$ANDROID_HOME"/);
  assert.match(workflow, /test -x "\$ANDROID_HOME\/emulator\/emulator"/);
  assert.match(workflow, /export PATH="\$ANDROID_HOME\/emulator:\$PATH"/);
  assert.match(workflow, /printf '%s\\n' "\$ANDROID_HOME\/emulator" >> "\$GITHUB_PATH"/);
  assert.match(workflow, /test "\$\(command -v emulator\)" = "\$ANDROID_HOME\/emulator\/emulator"/);
  assert.ok(workflow.indexOf('export PATH="$ANDROID_HOME/emulator:$PATH"') < workflow.indexOf('emulator -accel-check'));
});
test('SDK emulator PATH shell block fails closed without configured executable and persists official path', () => {
  const begin = workflow.indexOf('          test -n "$ANDROID_HOME"');
  const end = workflow.indexOf('          test -c /dev/kvm', begin);
  assert.ok(begin >= 0 && end > begin, 'Scoped emulator PATH admission block is required');
  const shell = workflow.slice(begin, end).replace(/^          /gm, '');
  const parent = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(parent && parent.startsWith('/'));
  const base = realpathSync(mkdtempSync(join(parent, 'emulator-path-contract-')));
  const sdk = join(base, 'sdk'); const official = join(sdk, 'emulator'); const old = join(base, 'old-bin');
  mkdirSync(official, { recursive: true }); mkdirSync(old);
  for (const path of [join(official, 'emulator'), join(old, 'emulator')]) {
    writeFileSync(path, '#!/bin/sh\nexit 99\n'); chmodSync(path, 0o700);
  }
  const invoke = (tag) => {
    const githubPath = join(base, tag);
    const run = spawnSync('/bin/bash', ['-euc', shell + '\nprintf "current=%s\\n" "$(command -v emulator)"'], {
      encoding: 'utf8', env: { ...process.env, ANDROID_HOME: sdk, GITHUB_PATH: githubPath, PATH: old }, timeout: 5000,
    });
    return { run, githubPath };
  };
  const good = invoke('good-path');
  assert.equal(good.run.status, 0, good.run.stderr);
  assert.equal(good.run.stdout.trim(), `current=${official}/emulator`);
  assert.ok(existsSync(good.githubPath), 'Subsequent steps require the persisted SDK emulator directory');
  assert.equal(readFileSync(good.githubPath, 'utf8'), official + '\n');
  chmodSync(join(official, 'emulator'), 0o600);
  const missing = invoke('missing-path');
  assert.notEqual(missing.run.status, 0);
  assert.equal(existsSync(missing.githubPath), false, 'Unusable configured SDK must not persist an alternative PATH');
});
test('workflow uses exact source builds test-only harness before owned emulator', () => {
  assert.match(workflow, /node-version: '24\.17\.0'/);
  assert.match(workflow, /java-version: '17'/);
  assert.match(workflow, /candidate-source\/web && npm ci && npm run build/);
  assert.match(workflow, /:app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest/);
  assert.ok(workflow.indexOf(':app:assembleDebugAndroidTest') < workflow.indexOf('run: node scripts/android_player90_runtime.mjs\n'));
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /QUERY_ALL_PACKAGES|chmod 0?666|secrets\.|VLC|vlc|--wipe-data/);
});
test('runtime owns fresh AVD fixture and failure evidence before cleanup', () => {
  assert.match(driver, /relative\(parent, path\)/);
  assert.match(driver, /Existing device present before owned run/);
  assert.match(driver, /fixture\.stop\(\); const closed = await fixture\.done/);
  assert.match(driver, /const closed = graceful \|\| await emulator\.done/);
  assert.ok(driver.indexOf("save(name, read.output)") < driver.indexOf("if (logcat) { logcat.stop()"));
  assert.match(driver, /reverse', '--remove'/);
  assert.match(driver, /for \(let interval = 0; interval < 2; interval\+\+\)/);
  assert.match(driver, /requireTrue\(wait < 10, 'Strict guest IO admission failed'\)/);
  assert.match(driver, /Current boot ANR observed/);
});
test('Java source uses one UiAutomation owner real SDK FINGER and exact native bounds', () => {
  assert.equal((java.match(/instrumentation\.getUiAutomation\(\)/g) || []).length, 1);
  assert.match(java, /property\.toolType = MotionEvent\.TOOL_TYPE_FINGER/);
  assert.match(java, /InputDevice\.SOURCE_TOUCHSCREEN/);
  assert.match(java, /automation\.injectInputEvent\(event, true\)/);
  assert.match(java, /finally \{ event\.recycle\(\); \}/);
  assert.match(java, /MotionEvent\.ACTION_CANCEL/);
  assert.match(java, /before, foreground\(x, y\)/);
  assert.match(java, /root\.recycle\(\)/);
  assert.match(java, /getVisibleBounds\(\)/);
});
test('Java no state injection or invisible menu surrogate and preserves idle policy', () => {
  assert.doesNotMatch(java, /evaluateJavascript|javascript:|dispatchEvent|SharedPreferences|adoptShellPermissionIdentity|executeShellCommand|new WebView/);
  assert.match(java, /assertEquals\(36, Build\.VERSION\.SDK_INT\)/);
  assert.match(java, /automation\.clearCache\(\)/);
  assert.match(java, /setWaitForIdleTimeout\(oldIdle\)/);
  assert.match(java, /Missing unique explicit stream row; hero Play is not admitted/);
  assert.match(java, /More requires its actual unique heading/);
  assert.match(java, /The native More activation did not open the Playback settings dialog/);
});
