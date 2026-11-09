import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as runtime from './android_player91_runtime.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, realpathSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PIN, sanitize, validateEnvironment, validateCatalog, cpuSnapshot, iowaitPercent,
  validateHostResources, validateGuest, validateLauncher, validateJUnit, validateReceipt, validateMenuOnlyReceipt, validateUpdateConsentTail, parseRuntimeMode, ownedDirectory, parseInstalledAPKPaths, parseAPKHashOutput } from './android_player91_runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const java = readFileSync(join(root, 'scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimePlayer91MoreFlowTest.java'), 'utf8');
const driver = readFileSync(join(root, 'scripts/android_player91_runtime.mjs'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/android-player91-runtime.yml'), 'utf8');
const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  CANDIDATE_SOURCE_SHA: PIN.source, CANDIDATE_RUN_ID: PIN.run, CANDIDATE_APK_SHA256: PIN.sha256,
  CANDIDATE_VERSION: PIN.version, CANDIDATE_VERSION_CODE: PIN.code, CANDIDATE_ARTIFACT_ID: PIN.artifactId, SYSTEM_IMAGE_PACKAGE: PIN.image,
  AVD_NAME: PIN.avd, EMULATOR_SERIAL: PIN.serial, EMULATOR_GPU: PIN.gpu,
  CANDIDATE_APK: 'candidate/YAWF.Stream_Android_2.3.91.apk', CANDIDATE_ARTIFACT: 'android-phone-verification-candidate' });
const guest = () => ({ sdk: '36', abi: 'x86_64', hardware: 'ranchu', pageSize: '4096',
  webview: 'Current WebView package (name, version): (com.google.android.webview, 144.0.7559.0)' });
const input = (role = 'more') => ({ role, ok: true, tool: 'finger', toolType: 1, durationMs: 100, steps: 2,
  targetBounds: [10, 10, 100, 100], x: 50, y: 50, foregroundTargetBefore: true, foregroundTargetAfter: true, downAdmitted: true, downInjectionAttempted: true, downAcknowledged: true, upAcknowledged: true, streamMayRemain: false,
  cancelAcknowledged: false, downUptimeMs: 1000, eventUptimeMs: [1000, 1050, 1100],
  ...(role === 'reveal' ? { observationEpoch: 'clock-before', x: 55, y: 38.8 } : {}) });
const receipt = () => ({ schemaVersion: 1, profile: 'private91-hosted-more', outcome: 'PASS', phase: 'complete',
  sourceClicks: 1, explicitSourceRow: true, clockBeforeSeconds: 2, clockAfterSeconds: 4,
  chromeRevealPerformed: false, chromeRevealCount: 0,
  uniqueMenu: true, menuHeading: true, singleUiAutomationOwner: true, menuBounds: [0, 500, 1080, 1800], inputs: [input()] });
const junit = 'INSTRUMENTATION_STATUS: numtests=1\nOK (1 test)\nINSTRUMENTATION_CODE: -1\n';

test('fixed hosted91 profile accepts only official Linux X64 context', () => {
  validateEnvironment(environment());
  for (const [key, bad] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_ENVIRONMENT', undefined],
    ['RUNNER_OS', 'macOS'], ['RUNNER_ARCH', 'ARM64']]) assert.throws(() => validateEnvironment({ ...environment(), [key]: bad }));
});
test('candidate source run APK code image serial and renderer are indivisible pins', () => {
  for (const key of ['CANDIDATE_SOURCE_SHA', 'CANDIDATE_RUN_ID', 'CANDIDATE_APK_SHA256', 'CANDIDATE_VERSION',
    'CANDIDATE_VERSION_CODE', 'CANDIDATE_ARTIFACT_ID', 'SYSTEM_IMAGE_PACKAGE', 'AVD_NAME', 'EMULATOR_SERIAL', 'EMULATOR_GPU', 'CANDIDATE_APK', 'CANDIDATE_ARTIFACT']) {
    assert.throws(() => validateEnvironment({ ...environment(), [key]: 'wrong' }), key);
  }
});
test('four-core guest profile requires actual host four CPUs and eight GiB without fallback', () => {
  validateHostResources({ availableCPUs: 4, memoryBytes: 8 * 1024 ** 3 });
  for (const host of [{ availableCPUs: 3, memoryBytes: 16 * 1024 ** 3 }, { availableCPUs: 4, memoryBytes: 8 * 1024 ** 3 - 1 },
    { availableCPUs: NaN, memoryBytes: 16 * 1024 ** 3 }, { availableCPUs: 4, memoryBytes: Infinity }]) {
    assert.throws(() => validateHostResources(host));
  }
});
test('resource receipts precede boot and raw readiness evidence precedes all interval assertions', () => {
  assert.equal(PIN.guestCores, 4); assert.equal(PIN.guestMemoryMiB, 4096);
  assert.match(driver, /'-cores', String\(PIN\.guestCores\), '-memory', String\(PIN\.guestMemoryMiB\)/);
  const boot = driver.indexOf("emulator = command('emulator'");
  const mustPrecede = (needle, after) => {
    const at = driver.indexOf(needle); assert.ok(at >= 0 && after > at);
  };
  mustPrecede("save('host-resources-before-boot.json'", driver.indexOf('validateHostResources(hostResources)'));
  mustPrecede("save('configured-guest-before-boot.json'", boot);
  for (const kind of ['cpu', 'events', 'launcher']) {
    const save = driver.indexOf('save(`readiness-${interval}-' + kind + '.txt`');
    assert.ok(save >= 0 && save < driver.indexOf('const current = cpuSnapshot(rawCPU)'));
  }
  mustPrecede("save('runtime-events.txt', runtimeEvents)", driver.indexOf("'Runtime current boot ANR observed'"));
  assert.match(driver, /wait < 10, 'Strict guest IO admission failed'/);
  assert.match(driver, /!\/\\bam_anr\\b\/\.test\(rawEvents\)/);
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
test('provider APK metadata accepts factory names and all installed base plus splits', () => {
  for (const path of ['/product/app/WebViewGoogle/WebViewGoogle.apk', '/system/app/WebView/WebView.apk',
    '/system_ext/app/WebView/WebViewStub.apk', '/data/app/~~safe+code==/com.google.android.webview-code==/WebViewGoogle.apk']) {
    assert.deepEqual(parseInstalledAPKPaths(`package:${path}\n`), [path]);
  }
  const paths = ['/data/app/~~safe==/webview-code==/base.apk', '/data/app/~~safe==/webview-code==/split_config.x86_64.apk'];
  assert.deepEqual(parseInstalledAPKPaths(paths.map((path) => 'package:' + path).join('\r\n') + '\r\n'), paths);
  const eight = Array.from({ length: 8 }, (_, i) => `/system/app/webview/split${i}.apk`);
  assert.deepEqual(parseInstalledAPKPaths(eight.map((path) => 'package:' + path).join('\n')), eight);
});
test('provider APK metadata rejects bad roots traversal shell input duplicates and extra lines', () => {
  const good = 'package:/system/app/WebView/WebView.apk\n';
  for (const text of ['', good.repeat(2), good + '\n', good + 'daemon started\n', 'notice\n' + good,
    Array.from({ length: 9 }, (_, i) => `package:/system/app/webview/split${i}.apk`).join('\n'),
    ...['/vendor/app/webview.apk', '/data/app-staging/base.apk', '/system/app/../base.apk', '/system/app/a..b.apk',
      '/system/app/%2e%2e/base.apk', '/system/app//base.apk', '/system/app/./base.apk', '/system/app/a b.apk',
      '/system/app/base.apk;id', '/system/app/$(id).apk', '/system/app/base*.apk', '/system/app/a\\b.apk',
      '/system/app/a\tb.apk', '/system/app/a\u0000.apk', '/system/app/base.apk '].map((path) => `package:${path}\n`)]) {
    assert.throws(() => parseInstalledAPKPaths(text), text);
  }
});
test('every provider APK hash is exact hexadecimal bound to its requested full path', () => {
  const path = '/system_ext/app/WebView/WebViewGoogle.apk'; const digest = 'a'.repeat(64);
  assert.equal(parseAPKHashOutput(`${digest}  ${path}\n`, path), digest);
  assert.equal(parseAPKHashOutput(`${digest} ${path}\r\n`, path), digest);
  for (const output of [`${'g'.repeat(64)}  ${path}\n`, `${'a'.repeat(63)}  ${path}\n`, `${digest}  /system/app/other.apk\n`,
    `${digest}  ${path}\n\n`, `${digest}  ${path}\nextra`, `${digest}  ${path}\n${digest}  ${path}\n`, `${digest}   ${path}\n`, ` ${digest}  ${path}\n`]) {
    assert.throws(() => parseAPKHashOutput(output, path));
  }
});
test('raw provider paths are retained before validation and all parsed APKs are hashed', () => {
  const retain = driver.indexOf("save('webview-package-paths.txt', installedWebview)");
  const parse = driver.indexOf('const providerPaths = parseInstalledAPKPaths(installedWebview)');
  assert.ok(retain >= 0 && retain < parse);
  assert.match(driver, /for \(const path of providerPaths\)/);
  assert.match(driver, /sha256: parseAPKHashOutput\(output, path\)/);
  assert.match(driver, /save\('webview-apks\.json', \{ \.\.\.webview, APKs: providerAPKs \}\)/);
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
  const value = receipt(); value.inputs.unshift(input('reveal')); value.chromeRevealCount = 1; value.chromeRevealPerformed = true;
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
test('new91 workflow prefix has its own frozen identity, not the old90 prefix', () => {
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
  assert.ok(workflow.indexOf(':app:assembleDebugAndroidTest') < workflow.indexOf('run: node scripts/android_player91_runtime.mjs'));
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /QUERY_ALL_PACKAGES|chmod 0?666|secrets\.|VLC|vlc|--wipe-data/);
});
test('ADB startup completes and raw device snapshot is retained before the exact empty-device gate', () => {
  const start = driver.indexOf("save('adb-start-server.txt', await run('adb', ['start-server']))");
  const acquire = driver.indexOf("const devicesBeforeRun = await run('adb', ['devices'])");
  const retain = driver.indexOf("save('adb-preexisting-devices.txt', devicesBeforeRun)");
  const gate = driver.indexOf("requireTrue(devicesBeforeRun.trim() === 'List of devices attached', 'Existing device present before owned run')");
  assert.ok(start >= 0 && start < acquire && acquire < retain && retain < gate);
  assert.ok(gate < driver.indexOf("for (const port of [43120, 43121, 5554, 5555])"));
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
test('login uses one ordinary field focus and one public SDK text send per fixture field', () => {
  assert.equal((java.match(/instrumentation\.sendStringSync\(USER\)/g) || []).length, 1);
  assert.equal((java.match(/instrumentation\.sendStringSync\(PASSWORD\)/g) || []).length, 1);
  assert.doesNotMatch(java, /\.setText\((?:USER|PASSWORD)\)/);
  assert.match(java, /private void focusLoginField\(int index\)[\s\S]*?fields\(3\)\.get\(index\)[\s\S]*?target\.click\(\)/);
  assert.match(java, /\.put\("textEntryMethod", "UiObject2\.click\+Instrumentation\.sendStringSync"\)/);
});
test('login waits for fresh exact username commit before password and after its single text send', () => {
  const before = java.indexOf('usernameCommittedBeforePassword = waitForUsernameCommit()');
  const password = java.indexOf('instrumentation.sendStringSync(PASSWORD)');
  const after = java.indexOf('usernameCommittedAfterPassword = waitForUsernameCommit()');
  assert.ok(before >= 0 && before < password && password < after);
  assert.match(java, /USER\.equals\(fields\(3\)\.get\(0\)\.getText\(\)\)/);
  assert.match(java, /fields\(3\)\.get\(index\)\.isFocused\(\)/);
  for (const key of ['usernameCommittedBeforePassword', 'usernameCommittedAfterPassword', 'passwordTextSendReturned',
    'usernameFocusClicks', 'passwordFocusClicks', 'usernameTextSends', 'passwordTextSends']) assert.ok(java.includes(`.put("${key}",`));
});
test('two clock observation epochs reveal only absent chrome at the safe non-transport point', () => {
  const before = java.indexOf('revealChromeForObservation("clock-before")');
  const after = java.indexOf('revealChromeForObservation("clock-after")');
  assert.ok(before >= 0 && before < java.indexOf('long clockDeadline') && after > before);
  assert.match(java, /if \(playerChromeVisible\(\)\) return/);
  assert.match(java, /chromeRevealEpochs\.contains\(observationEpoch\)/);
  assert.match(java, /chromeRevealEpochs\.size\(\) < 2/);
  assert.match(java, /bounds\.left \+ bounds\.width\(\) \* 0\.5f, bounds\.top \+ bounds\.height\(\) \* 0\.32f, "reveal", bounds, observationEpoch/);
  assert.match(java, /proof\.put\("observationEpoch", observationEpoch\)/);
  const more = java.slice(java.indexOf('step("more-transaction")'), java.indexOf('long menuDeadline'));
  assert.doesNotMatch(more, /revealChromeForObservation\(/);
  assert.match(more, /no third reveal is admitted/);
  assert.match(java, /clockBefore > 0 && clockBefore < 25/);
  assert.match(java, /clockAfter >= clockBefore \+ 1 && clockAfter < 30/);
});
test('clock PNG observation keeps the real2200ms interval and actual last UP to More deadline', () => {
  assert.match(java, /capture\("clock-before", false\)/);
  assert.match(java, /capture\("clock-after", false\)/);
  assert.match(java, /if \(!includeHierarchy\) return/);
  assert.match(java, /SystemClock\.sleep\(2_200\)/);
  assert.match(java, /chromeRevealUp = inputs\.getJSONObject\(inputs\.length\(\) - 1\)\.getJSONArray\("eventUptimeMs"\)\.getLong\(2\)/);
  assert.match(java, /now\(\) - chromeRevealUp < 3_200/);
});
test('native enrollment prompt declines using observed exact uppercase NOT NOW', () => {
  assert.match(java, /if \(text\("Enable Android update checks\?"\) != null\) \{\s+declineUpdateChecksToWelcome\(\);/);
  assert.match(java, /UiObject2 notNow = clickable\("NOT NOW"\), enable = clickable\("ENABLE"\)/);
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

test('two distinct measured reveal epochs are transparent; third, duplicate, hidden setup and late More reject', () => {
  const value = receipt();
  value.chromeRevealCount = 2; value.chromeRevealPerformed = true;
  value.inputs = [input('explicit-source'), input('reveal'),
    { ...input('reveal'), observationEpoch: 'clock-after', downUptimeMs: 3500, eventUptimeMs: [3500, 3550, 3600] },
    { ...input(), downUptimeMs: 4000, eventUptimeMs: [4000, 4050, 4100] }];
  validateReceipt(value);
  for (const mutate of [
    (r) => { r.inputs[2].observationEpoch = 'clock-before'; },
    (r) => { r.inputs[2].observationEpoch = 'more'; },
    (r) => { r.inputs[1].y = 55; },
    (r) => { r.inputs[2].downUptimeMs = 3000; r.inputs[2].eventUptimeMs = [3000, 3050, 3100]; },
    (r) => { r.inputs[3].downUptimeMs = 6800; r.inputs[3].eventUptimeMs = [6800, 6850, 6900]; },
    (r) => { r.chromeRevealCount = 1; },
    (r) => { r.inputs.splice(3, 0, { ...input('reveal'), observationEpoch: 'clock-after' }); r.chromeRevealCount = 3; },
    (r) => { r.inputs.splice(3, 0, input('setup')); },
    (r) => { r.inputs[3].observationEpoch = 'clock-after'; },
  ]) { const copy = structuredClone(value); mutate(copy); assert.throws(() => validateReceipt(copy)); }
});

test('native elapsed clock is the one bounded player-scoped SeekBar, never a naked text clock', () => {
  const clock = java.slice(java.indexOf('    private int clock()'), java.indexOf('    private enum InputTail'));
  for (const text of ['UiObject2 current = player()', 'By.pkg(PRODUCT).clazz("android.widget.SeekBar")',
    'bars.size() <= 1', 'assertVisible(bar)', 'current.getVisibleBounds().contains(bar.getVisibleBounds())', 'parseSeekClock(bar.getText())']) assert.ok(clock.includes(text), text);
  assert.doesNotMatch(clock, /By.text|split\(" \/ "\)|getContentDescription/);
  const visible = java.slice(java.indexOf('    private boolean playerChromeVisible()'), java.indexOf('    private void fresh()'));
  for (const text of ['android.widget.SeekBar', 'Playback settings', 'Play', 'Pause', 'if (playerChromeVisible()) return']) assert.ok(visible.includes(text), text);
});

test('actual source Java SeekBar parser compiles and executes adversarial elapsed-duration cases', () => {
  const start = java.indexOf('    static int parseSeekClock(String label) {');
  const end = java.indexOf('\n    private int clock()', start);
  assert.ok(start >= 0 && end > start, 'actual Java parser method required');
  const actualMethod = java.slice(start, end);
  const cases = [
    ['0:00 of 0:36, Seek', 0], ['0:01 of 0:36, Seek', 1], ['0:35 of 0:36, Seek', 35],
    ['00:05 of 00:36, Seek', 5], ['0:36 of 0:36, Seek', -1], ['0:37 of 0:36, Seek', -1],
    ['0:01 of 0:35, Seek', -1], ['0:01 of 1:36, Seek', -1], ['0:60 of 0:36, Seek', -1],
    ['0:01', -1], ['0:01 / 0:36', -1], ['0:01 of 0:36', -1], ['0:01 of 0:36, seek', -1],
    [' 0:01 of 0:36, Seek', -1], ['0:01 of 0:36, Seek\n', -1], ['0:00:01 of 0:00:36, Seek', -1],
    ['-0:01 of 0:36, Seek', -1], [null, -1], ['x'.repeat(65), -1],
  ];
  const base = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(base?.startsWith('/'), 'explicit Work/runner-owned temporary root required');
  const directory = realpathSync(mkdtempSync(join(base, 'native-seek-clock-')));
  const checks = cases.map(([text, expected], index) => `if (parseSeekClock(${JSON.stringify(text)}) != ${expected}) throw new AssertionError("case${index}");`).join('\n');
  writeFileSync(join(directory, 'NativeSeekClockHarness.java'), `import java.util.regex.Pattern;\npublic final class NativeSeekClockHarness {\n${actualMethod}\npublic static void main(String[] args) {\n${checks}\nSystem.out.println("native-seek-clock:${cases.length}");\n}\n}\n`);
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const javaCommand = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const compile = spawnSync(javac, [`-J-Djava.io.tmpdir=${directory}`, '-d', directory, join(directory, 'NativeSeekClockHarness.java')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(compile.status, 0, `actual Java parser compilation failed: ${compile.stderr}`);
  const run = spawnSync(javaCommand, [`-Djava.io.tmpdir=${directory}`, '-cp', directory, 'NativeSeekClockHarness'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, `actual Java parser cases failed: ${run.stderr}`);
  assert.equal(run.stdout.trim(), `native-seek-clock:${cases.length}`);
});

const menuOnlyReceipt = () => ({ ...receipt(), profile: 'private91-hosted-menu-only', clockBeforeSeconds: -1, clockAfterSeconds: -1,
  menuOnlyQualified: true, clockProgressQualified: false, playbackContinuityQualified: false, initialClockObservationCount: 1,
  chromeRevealCount:1,chromeRevealPerformed:true,chromeRevealUpUptimeMs:2100,moreWindowLimitMs:1200,
  chromeAbsenceObservations:[{uptimeMs:1500,visible:false,cacheRefreshed:true},{uptimeMs:1700,visible:false,cacheRefreshed:true}],
  moreAcquisitionStartedUptimeMs:2101,moreAcquiredUptimeMs:2150,moreDownAttemptUptimeMs:2200,
  moreAcquisition:{rootPackageMatches:true,playerPackageMatches:true,targetPackageMatches:true,playerCount:1,targetCount:1,
    clearCacheCount:1,activeRootCount:1,rootWindowId:2,playerWindowId:2,targetWindowId:2,targetIdentity:17,
    rootBounds:[0,0,1080,1920],playerBounds:[0,0,1080,1920],targetBounds:[10,10,100,100],screenWidth:1080,screenHeight:1920,
    nodesVisited:100,maxDepth:20,ancestorDistance:1},
  inputs:[input('explicit-source'),{...input('reveal'),observationEpoch:'menu-only',foregroundAfterUptimeMs:2150,downUptimeMs:2000,eventUptimeMs:[2000,2050,2100]},
    {...input(),downUptimeMs:2200,eventUptimeMs:[2200,2250,2300]}] });
test('menu-only accepts actual menu proof without clocks and cannot cross-qualify progress profiles', () => {
  validateMenuOnlyReceipt(menuOnlyReceipt());
  assert.throws(() => validateReceipt(menuOnlyReceipt()));
  assert.throws(() => validateMenuOnlyReceipt(receipt()));
  for (const changes of [{ clockBeforeSeconds: 2 }, { clockAfterSeconds: 4 }, { clockProgressQualified: true },
    { playbackContinuityQualified: true }, { menuOnlyQualified: false }, { profile: 'private91-hosted-more' },
    { initialClockObservationCount: 0 }, { initialClockObservationCount: 2 }, { uniqueMenu: false }, { menuHeading: false }]) {
    assert.throws(() => validateMenuOnlyReceipt({ ...menuOnlyReceipt(), ...changes }));
  }
});
test('91 exact one fresh reveal acquisition and More DOWN reject stale elapsed and extra action proofs', () => {
  const value=menuOnlyReceipt();validateMenuOnlyReceipt(value);
  for(const mutate of[
    r=>{r.inputs[1].observationEpoch='clock-before';},r=>{r.inputs[1].upAcknowledged=false;},r=>{r.inputs[1].streamMayRemain=true;},
    r=>{r.inputs[1].y=55;},r=>{r.moreAcquisitionStartedUptimeMs=2099;},r=>{r.moreAcquiredUptimeMs=2099;},
    r=>{r.moreAcquiredUptimeMs=2300;},r=>{r.moreDownAttemptUptimeMs=2201;},r=>{r.chromeRevealUpUptimeMs=2101;},
    r=>{r.inputs[2].downUptimeMs=3301;r.inputs[2].eventUptimeMs=[3301,3351,3401];r.moreDownAttemptUptimeMs=3301;},
    r=>{r.chromeAbsenceObservations[1].visible=true;},r=>{r.chromeAbsenceObservations[1].cacheRefreshed=false;},
    r=>{r.chromeAbsenceObservations[1].uptimeMs=2200;},r=>{r.chromeAbsenceObservations.pop();},
    r=>{r.inputs.splice(2,0,input('setup'));},r=>{r.inputs.splice(1,0,input('explicit-source'));},r=>{r.inputs.push(input());},r=>{r.inputs.splice(1,1);r.chromeRevealCount=0;r.chromeRevealPerformed=false;},
  ]){const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateMenuOnlyReceipt(copy));}
  const boundary=menuOnlyReceipt();boundary.inputs[2].downUptimeMs=3300;boundary.inputs[2].eventUptimeMs=[3300,3350,3400];boundary.moreDownAttemptUptimeMs=3300;validateMenuOnlyReceipt(boundary);
});
test('91 only menu-only is runnable and exactly one JUnit method exists', () => {
  assert.equal(parseRuntimeMode([]),'menu-only');assert.equal(parseRuntimeMode(['menu-only']),'menu-only');
  for(const args of[['run'],['other'],['menu-only','extra']])assert.throws(()=>parseRuntimeMode(args));
  assert.match(driver,/Only the finite91 menu-only gate is admitted/);
  assert.equal((java.match(/@Test\s+public void/g)||[]).length,1);
  assert.ok(java.includes('production91OpensMoreMenuOnlyWithNativeFinger() throws Throwable { runCase(true); }'));
  assert.ok(!java.includes('production91OpensMoreWithNativeFinger()'));
});
test('new91 workflow explicitly selects menu-only below its independently frozen prefix', () => {
  assert.match(workflow, /^        run: node scripts\/android_player91_runtime\.mjs menu-only$/m);
  assert.doesNotMatch(workflow, /^        run: node scripts\/android_player91_runtime\.mjs(?: run)?$/m);
});
test('91 native critical window uses exactly one bounded SDK snapshot and no UiObject2 before DOWN', () => {
  const flow=java.slice(java.indexOf('    private void flowMenuOnly()'),java.indexOf('    private Rect waitForTwoFreshChromeAbsentObservations()'));
  const window=flow.slice(flow.indexOf('chromeRevealUp ='),flow.indexOf('finger(more.target'));
  for(const required of ['moreAcquisitionStarted = now()', 'AcquiredMore more = acquireMoreOnce(screenWidth, screenHeight)', 'moreAcquired = now()', 'more.root.contains', 'more.admit(', 'reveal.put("foregroundTargetAfter", true)']) assert.ok(window.includes(required),required);
  assert.doesNotMatch(window,/UiObject2|findObjects|player\(\)|fresh\(|guard\(|refresh\(|getWindows|capture\(|write\(|sleep\(/);
  assert.ok(window.indexOf('more.root.contains')<window.indexOf('reveal.put('));
  assert.ok(window.indexOf('more.admit(')<window.indexOf('reveal.put('));
  const acquire=java.slice(java.indexOf('    private AcquiredMore acquireMoreOnce'),java.indexOf('    private void scanMore'));
  assert.equal((acquire.match(/automation\.clearCache\(\)/g)||[]).length,1);
  assert.equal((acquire.match(/automation\.getRootInActiveWindow\(\)/g)||[]).length,1);
  assert.match(acquire,/root\.recycle\(\)/); assert.match(acquire,/scan\.identity\.recycle\(\)/);
  const scan=java.slice(java.indexOf('    private void scanMore'),java.indexOf('    private UiObject2 menuOnlyMore'));
  for(const value of ['scan.policy.visit(path.size())', 'index >= playerIndex && distance <= 6', 'AcquisitionPolicy.windows(', 'scan.identity.equals(candidate)', 'finally { child.recycle(); }', 'children <= 512']) assert.ok(scan.includes(value),value);
  assert.doesNotMatch(scan,/getParent\(|refresh\(|UiObject2|findObjects|getWindows/);
  assert.match(java,/down >= moreAcquired && down - chromeRevealUp <= 1_200/);
  assert.match(java,/moreDownAttempt = down/);
});

test('91 candidate and workflow artifact source pins are explicit independent constants',()=>{
  assert.deepEqual({source:PIN.source,run:PIN.run,artifactId:PIN.artifactId,sha256:PIN.sha256,bytes:PIN.bytes,version:PIN.version,code:PIN.code,signer:PIN.signer},
    {source:'71ac64423a00df601d35142c2bbae774cff3037b',run:'42643241753',artifactId:'13687171562',sha256:'c25114fe2e6a6e61923162177348c98154733ff0d37bb556698c20c98716adb1',bytes:88705921,version:'2.3.91',code:'2003091',signer:'233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a'});
  assert.match(workflow,/artifact-ids: \$\{\{ env\.CANDIDATE_ARTIFACT_ID \}\}/);
  for(const literal of[PIN.source,PIN.run,PIN.artifactId,PIN.sha256,PIN.code])assert.ok(workflow.includes(literal));
  assert.notEqual(PIN.prefix,'d99110f238492fab16418dbcb17ce27bd9ed91357a4c08ec38a78d61aa40e380');
});

function flatCandidateDownloadPath(text) {
  const blocks = [...text.matchAll(/      - name: Download exact private production-signed candidate\n([\s\S]*?)(?=      # BEGIN OWNED|      - name: |$)/g)];
  assert.equal(blocks.length, 1, 'One exact candidate download step required');
  assert.match(blocks[0][1], /^        uses: actions\/download-artifact@v4$/m);
  const fields = [...blocks[0][1].matchAll(/^          ([a-z-]+): (.+)$/gm)];
  assert.equal(new Set(fields.map((field) => field[1])).size, fields.length, 'Duplicate download inputs rejected');
  const inputs = Object.fromEntries(fields.map((field) => [field[1], field[2]]));
  assert.equal(inputs['artifact-ids'], '${{ env.CANDIDATE_ARTIFACT_ID }}');
  assert.equal(inputs['merge-multiple'], 'true', 'ID-selected artifact must flatten into the driver candidate directory');
  assert.equal(inputs.path, 'candidate');
  return `${inputs.path}/YAWF.Stream_Android_2.3.91.apk`;
}
test('exact ID download shape places APK at the existing flat driver path', () => {
  assert.equal(flatCandidateDownloadPath(workflow), environment().CANDIDATE_APK);
});
test('download shape rejects missing or false flattening and nested destination without changing pins', () => {
  const positive = workflow.includes('          merge-multiple: true\n') ? workflow
    : workflow.replace('          path: candidate\n', '          merge-multiple: true\n          path: candidate\n');
  assert.equal(flatCandidateDownloadPath(positive), environment().CANDIDATE_APK);
  assert.throws(() => flatCandidateDownloadPath(positive.replace('          merge-multiple: true\n', '')), /must flatten/);
  assert.throws(() => flatCandidateDownloadPath(positive.replace('merge-multiple: true', 'merge-multiple: false')), /must flatten/);
  assert.throws(() => flatCandidateDownloadPath(positive.replace('path: candidate\n', 'path: candidate/android-phone-verification-candidate\n')));
});

test('91 snapshot admission rejects wrong missing ambiguous stale or unbounded copied proof', () => {
  validateMenuOnlyReceipt(menuOnlyReceipt());
  const mutations = [
    r=>{delete r.moreAcquisition;}, r=>{r.moreAcquisition.rootPackageMatches=false;},
    r=>{delete r.moreAcquisition.playerPackageMatches;},r=>{r.moreAcquisition.targetPackageMatches=false;},
    r=>{r.moreAcquisition.playerCount=0;},r=>{r.moreAcquisition.playerCount=2;},r=>{r.moreAcquisition.targetCount=2;},
    r=>{r.moreAcquisition.clearCacheCount=2;},r=>{r.moreAcquisition.activeRootCount=2;},
    r=>{r.moreAcquisition.rootWindowId=-1;},r=>{r.moreAcquisition.targetWindowId=3;},r=>{r.moreAcquisition.playerWindowId=3;},
    r=>{r.moreAcquisition.nodesVisited=513;},r=>{r.moreAcquisition.maxDepth=33;},r=>{r.moreAcquisition.ancestorDistance=7;},
    r=>{r.moreAcquisition.targetBounds=[1000,1000,1200,2000];},r=>{r.moreAcquisition.screenWidth=100;},
    r=>{r.inputs[1].foregroundAfterUptimeMs=2100;},r=>{r.inputs[2].downAdmitted=false;},
    r=>{delete r.inputs[2].downInjectionAttempted;},r=>{r.inputs[2].downAcknowledged=false;},
    r=>{r.inputs[2].eventUptimeMs.push(2400);},r=>{r.inputs[2].cancelAcknowledged=true;},
  ];
  for(const mutate of mutations){const value=structuredClone(menuOnlyReceipt());mutate(value);assert.throws(()=>validateMenuOnlyReceipt(value));}
});
test('91 shared reveal proof is deferred until exact acquired root contains the acknowledged reveal point', () => {
  const flow=java.slice(java.indexOf('    private void flowMenuOnly()'),java.indexOf('    private Rect waitForTwoFreshChromeAbsentObservations()'));
  for(const value of ['moreAcquired >= chromeRevealUp', 'more.root.contains((int) reveal.getDouble("x"), (int) reveal.getDouble("y"))', 'reveal.getBoolean("downAcknowledged") && reveal.getBoolean("upAcknowledged")', 'more.admit(', 'reveal.put("foregroundTargetAfter", true).put("ok", true)']) assert.ok(flow.includes(value),value);
  const finger=java.slice(java.indexOf('    private void finger(float x, float y, String role, Rect targetBounds, String observationEpoch, AcquiredMore acquired)'),java.indexOf('    private void inject('));
  assert.ok(finger.includes('boolean deferredRevealProof = role.equals("reveal") && "menu-only".equals(observationEpoch)'));
  assert.ok(finger.includes('if (!deferredRevealProof)'));
  assert.ok(finger.includes('.put("foregroundTargetBefore", false).put("foregroundTargetAfter", false)'));
  assert.ok(finger.indexOf('acquired.admit(')<finger.indexOf('state.admit()'));
  assert.ok(finger.indexOf('state.admit()')<finger.indexOf('inject(down, down, MotionEvent.ACTION_DOWN'));
  assert.ok(finger.includes('if (state.streamActive)'));
  assert.doesNotMatch(finger,/boolean stream = true|UiObject2|findObjects|getWindows/);
  const inject=java.slice(java.indexOf('    private void inject('),java.indexOf('    private void assertVisible('));
  assert.ok(inject.indexOf('state.attemptingDown()')<inject.indexOf('automation.injectInputEvent(event, true)'));
  assert.ok(inject.indexOf('automation.injectInputEvent(event, true)')<inject.indexOf('state.downAck(acknowledged)'));
});
test('actual Java acquisition bounds identities and acknowledged-stream policy compile and execute', () => {
  const start=java.indexOf('    static final class AcquisitionPolicy {');
  const end=java.indexOf('    private static final class AcquiredMore',start);
  const fs=java.indexOf('    static final class FingerState {');const fe=java.indexOf('    private void finger(',fs);
  assert.ok(start>=0 && end>start && fs>=0 && fe>fs);
  const constants=['PRODUCT','PLAYER'].map(name=>java.match(new RegExp(`    private static final String ${name} = [^;]+;`))?.[0]);assert.ok(constants.every(Boolean));
  const checks=`
    AcquisitionPolicy.owner(PRODUCT,true,2);
    reject(()->AcquisitionPolicy.owner(null,true,2)); reject(()->AcquisitionPolicy.owner("foreign",true,2));
    reject(()->AcquisitionPolicy.owner(PRODUCT,false,2)); reject(()->AcquisitionPolicy.owner(PRODUCT,true,-1));
    if(!AcquisitionPolicy.player(PRODUCT,"android.app.Dialog",PLAYER))throw new AssertionError();
    if(AcquisitionPolicy.player("foreign","android.app.Dialog",PLAYER) || AcquisitionPolicy.player(PRODUCT,"Other",PLAYER) || AcquisitionPolicy.player(PRODUCT,"android.app.Dialog","foreign"))throw new AssertionError();
    if(!AcquisitionPolicy.more(PRODUCT,"Playback settings",null) || !AcquisitionPolicy.more(PRODUCT,null,"Playback settings") || AcquisitionPolicy.more(null,"Playback settings",null) || AcquisitionPolicy.more(PRODUCT,"other",null))throw new AssertionError();
    AcquisitionPolicy.windows(2,2,2);reject(()->AcquisitionPolicy.windows(2,3,2));reject(()->AcquisitionPolicy.windows(2,2,3));
    AcquisitionPolicy.unique(1,1);reject(()->AcquisitionPolicy.unique(0,1));reject(()->AcquisitionPolicy.unique(2,1));reject(()->AcquisitionPolicy.unique(1,0));reject(()->AcquisitionPolicy.unique(1,2));
    AcquisitionPolicy.ancestor(0,true);AcquisitionPolicy.ancestor(6,true);reject(()->AcquisitionPolicy.ancestor(7,true));reject(()->AcquisitionPolicy.ancestor(1,false));
    AcquisitionPolicy budget=new AcquisitionPolicy();for(int i=0;i<512;i++)budget.visit(32);reject(()->budget.visit(32));
    reject(()->new AcquisitionPolicy().visit(33));reject(()->new AcquisitionPolicy().visit(-1));
    FingerState refused=new FingerState();if(refused.streamActive || refused.downAdmitted || refused.downInjectionAttempted)throw new AssertionError();
    reject(()->refused.cancelAck(true));reject(()->refused.attemptingDown());
    FingerState rejected=new FingerState();rejected.admit();rejected.attemptingDown();rejected.downAck(false);
    if(rejected.streamActive || rejected.downAcknowledged || !rejected.downInjectionAttempted)throw new AssertionError();reject(()->rejected.cancelAck(true));
    FingerState open=new FingerState();open.admit();open.attemptingDown();open.downAck(true);if(!open.streamActive)throw new AssertionError();
    open.upAck(false);if(!open.streamActive)throw new AssertionError();open.cancelAck(true);if(open.streamActive || !open.cancelAcknowledged)throw new AssertionError();
    FingerState complete=new FingerState();complete.admit();complete.attemptingDown();complete.downAck(true);complete.upAck(true);
    if(complete.streamActive || !complete.upAcknowledged)throw new AssertionError();reject(()->complete.cancelAck(true));`;
  const base=process.env.RUNNER_TEMP||process.env.TMPDIR;assert.ok(base?.startsWith('/'));
  const dir=realpathSync(mkdtempSync(join(base,'native-acquisition-')));
  writeFileSync(join(dir,'NativeAcquisitionHarness.java'),`public final class NativeAcquisitionHarness {\n${constants.join('\n')}\n${java.slice(start,end)}\n${java.slice(fs,fe)}\nstatic void reject(Runnable r){try{r.run();}catch(IllegalStateException expected){return;}throw new AssertionError("accepted invalid policy");}\npublic static void main(String[] args){${checks}\nSystem.out.println("native-acquisition-policy:passed");}\n}`);
  const javac=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/javac'):'javac';const javaCommand=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'java';
  const compile=spawnSync(javac,[`-J-Djava.io.tmpdir=${dir}`,'-d',dir,join(dir,'NativeAcquisitionHarness.java')],{encoding:'utf8',timeout:20000});assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(javaCommand,[`-Djava.io.tmpdir=${dir}`,'-cp',dir,'NativeAcquisitionHarness'],{encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'native-acquisition-policy:passed');
});

test('diagnostic copies raw SDK geometry before every unchanged containment guard without new queries',()=>{
 const acquire=java.slice(java.indexOf('    private AcquiredMore acquireMoreOnce'),java.indexOf('    private void scanMore'));
 const scan=java.slice(java.indexOf('    private void scanMore'),java.indexOf('    private UiObject2 menuOnlyMore'));
 const before=(body,persist,guard)=>{const at=body.indexOf(persist);assert.ok(at>=0&&body.indexOf(guard)>at,persist);};
 before(acquire,'persistRawMoreGeometry(scan, "root-before-containment")','assertTrue("Invalid active root bounds"');
 before(scan,'persistRawMoreGeometry(scan, "player-before-containment")','assertTrue("Player escaped active root"');
 before(scan,'persistRawMoreGeometry(scan, "more-before-containment", target, targetWindow)','assertTrue("More escaped player"');
 const flow=java.slice(java.indexOf('    private void flowMenuOnly()'),java.indexOf('    private Rect waitForTwoFreshChromeAbsentObservations()'));
 before(flow,'assertTrue("Diagnostic geometry captured; More DOWN intentionally not admitted", false)','finger(more.target');
 const raw=java.slice(java.indexOf('    private void persistRawMoreGeometry'),java.indexOf('    private AcquiredMore acquireMoreOnce'));
 for(const key of ['rootBounds','playerBounds','moreBounds','rootWindowId','playerWindowId','moreWindowId','displayWidth','displayHeight','screenBounds','moreDownAttemptUptimeMs','additionalSDKQueries'])assert.ok(raw.includes('"'+key+'"'),key);
 assert.doesNotMatch(raw,/getRootInActiveWindow|clearCache|getBoundsInScreen|getWindowId|getDisplay|findObjects|getWindows|injectInputEvent|capture\(/);
 assert.ok(raw.includes('write("more-acquisition-raw.json", raw.toString(2))'));
 assert.match(driver,/scope: 'DIAGNOSTIC_RAW_SDK_GEOMETRY_ONLY_NOT_PRODUCT_QUALIFICATION', diagnosticOnly: true, productQualified: false/);
 assert.match(driver,/result\.menuOnlyQualified = false; result\.clockProgressQualified = false;/);
 assert.match(driver,/DIAGNOSTIC_COMPLETED_MENU_OBSERVED_NOT_PRODUCT_PASS/);
});

const zeroTailReasons = () => ({schemaVersion:1,bits:0,reasons:[],knownNodes:[],truncated:false});
const consentInput = () => ({...input('setup'),setupTail:{action:'UPDATE_NOT_NOW_TO_WELCOME',phase:'launch',sourceClicks:0,declineOrdinal:1,ok:true,maximumMs:2000,maximumSamples:20,upUptimeMs:1100,screenWidth:1080,screenHeight:1920,firstStableUptimeMs:1200,lastStableUptimeMs:1300,finishedUptimeMs:1301,observations:[
 {uptimeMs:1120,rootAvailable:false,ownerValid:false,rootWindowId:-1,rootBounds:null,rootKey:null,oldPrompt:false,unexpected:false,dialogs:0,titles:0,skips:0,nexts:0,snapshotComplete:false,nodesVisited:0,maxDepth:0,missingChildCount:0,missingChildDepth:-1,missingChildIndex:-1,reasonEvidence:zeroTailReasons()},
 ...[1200,1300].map(uptimeMs=>({uptimeMs,rootAvailable:true,ownerValid:true,rootWindowId:7,rootBounds:[0,0,1080,1920],rootKey:'7,0,0,1080,1920',oldPrompt:false,unexpected:false,dialogs:1,titles:1,skips:1,nexts:1,snapshotComplete:true,nodesVisited:8,maxDepth:3,missingChildCount:0,missingChildDepth:-1,missingChildIndex:-1,reasonEvidence:zeroTailReasons()}))]}});
test('exact consent tail recomputes delayed-null then stable Welcome and rejects every missing postcondition',()=>{
 validateUpdateConsentTail(consentInput());
 for(const mutate of[
  x=>x.role='more',x=>x.upAcknowledged=false,x=>x.streamMayRemain=true,x=>x.setupTail.action='OTHER',x=>x.setupTail.phase='player',x=>x.setupTail.sourceClicks=1,x=>x.setupTail.declineOrdinal=2,
  x=>x.setupTail.ok=false,x=>x.setupTail.maximumMs=2001,x=>x.setupTail.maximumSamples=21,x=>x.setupTail.upUptimeMs=1099,
  x=>x.setupTail.observations[1].ownerValid=false,x=>x.setupTail.observations[1].unexpected=true,x=>x.setupTail.observations[1].dialogs=2,
  x=>x.setupTail.observations[2].skips=0,x=>x.setupTail.observations[2].nexts=0,x=>x.setupTail.observations[2].titles=0,x=>x.setupTail.observations[2].oldPrompt=true,
  x=>x.setupTail.observations[2].uptimeMs=3200,x=>x.setupTail.observations[2].uptimeMs=1299,x=>x.setupTail.observations[2].rootKey='different',
  x=>x.setupTail.observations[0].titles=1,x=>x.setupTail.observations[0].rootAvailable=true,x=>x.setupTail.observations.pop(),
  x=>x.setupTail.observations=Array.from({length:21},()=>x.setupTail.observations[0]),x=>x.setupTail.firstStableUptimeMs=1199,x=>x.setupTail.finishedUptimeMs=3101,
 ]){const copy=consentInput();mutate(copy);assert.throws(()=>validateUpdateConsentTail(copy));}
 const value=menuOnlyReceipt();value.inputs.unshift(consentInput());validateMenuOnlyReceipt(value);
 const duplicate=structuredClone(value);duplicate.inputs.unshift(consentInput());assert.throws(()=>validateMenuOnlyReceipt(duplicate));
 const wrongRole=structuredClone(value);wrongRole.inputs[0].role='reveal';assert.throws(()=>validateMenuOnlyReceipt(wrongRole));
});
test('consent-only tail is after acknowledged release, bounded readonly, and leaves default and More guards intact',()=>{
 assert.equal((java.match(/"setup", bounds, null, null, InputTail\.UPDATE_NOT_NOW_TO_WELCOME/g)||[]).length,1);
 const decline=java.slice(java.indexOf('    private void declineUpdateChecksToWelcome'),java.indexOf('    static final class WelcomeTailPolicy'));
 for(const text of['"launch", phase','0, sourceClicks','0, updateConsentDeclines++','"Enable Android update checks?"','"NOT NOW"','"ENABLE"','"android.widget.Button"'])assert.ok(decline.includes(text),text);
 const tail=java.slice(java.indexOf('    private void requireUpdateConsentWelcomeTail'),java.indexOf('    private void tapObject'));
 for(const text of['state.upAcknowledged && !state.streamActive','times.getLong(2)','attempt < 20','now() - upAt <= 2000','automation.clearCache()','automation.getRootInActiveWindow()','SystemClock.sleep(100)','proof.put("ok", true)'])assert.ok(tail.includes(text),text);
 assert.doesNotMatch(tail,/\.tap\(|\.click\(|inject\(|pressBack|startActivity|\.play\(|\.pause\(/);
 const finger=java.slice(java.indexOf('    private void finger(float x, float y, String role, Rect targetBounds, String observationEpoch, AcquiredMore acquired, InputTail tail)'),java.indexOf('    private void inject('));
 assert.ok(finger.indexOf('inject(down, now(), step == 2 ? MotionEvent.ACTION_UP')<finger.indexOf('requireUpdateConsentWelcomeTail(state, times, proof)'));
 assert.ok(finger.includes('assertEquals("Foreground changed during native input", before, foreground(x, y))'));
 assert.ok(finger.includes('down - chromeRevealUp <= 1_200'));
 assert.ok(java.includes('assertTrue("Diagnostic geometry captured; More DOWN intentionally not admitted", false)'));
});
test('actual Java consent tail policy compiles and executes release ownership timing and stable-landmark controls',()=>{
 const start=java.indexOf('    static final class WelcomeTailPolicy {'),end=java.indexOf('    private static final class WelcomeTailScan',start);assert.ok(start>=0&&end>start);
 const base=process.env.RUNNER_TEMP||process.env.TMPDIR;assert.ok(base?.startsWith('/'));const dir=realpathSync(mkdtempSync(join(base,'consent-tail-')));
 const checks=`
 WelcomeTailPolicy p=new WelcomeTailPolicy();
 if(p.observe(1100,1000,true,false,false,false,false,0,0,0,0,null))throw new AssertionError();
 if(p.observe(1200,1000,true,true,true,false,false,1,1,1,1,"r"))throw new AssertionError();
 if(!p.observe(1300,1000,true,true,true,false,false,1,1,1,1,"r"))throw new AssertionError();
 reject(()->new WelcomeTailPolicy().observe(1000,1000,false,true,true,false,false,1,1,1,1,"r"));
 reject(()->new WelcomeTailPolicy().observe(1000,1000,true,true,false,false,false,1,1,1,1,"r"));
 reject(()->new WelcomeTailPolicy().observe(1000,1000,true,true,true,true,false,1,1,1,1,"r"));
 reject(()->new WelcomeTailPolicy().observe(3001,1000,true,true,true,false,false,1,1,1,1,"r"));
 reject(()->new WelcomeTailPolicy().observe(999,1000,true,true,true,false,false,1,1,1,1,"r"));
 reject(()->new WelcomeTailPolicy().observe(1000,1000,true,true,true,false,false,2,1,1,1,"r"));
 if(new WelcomeTailPolicy().observe(1000,1000,true,true,true,false,true,1,1,1,1,"r"))throw new AssertionError();
 if(new WelcomeTailPolicy().observe(1000,1000,true,true,true,false,false,1,1,0,1,"r"))throw new AssertionError();
 WelcomeTailPolicy missing=new WelcomeTailPolicy();for(int i=0;i<20;i++)if(missing.observe(1000+i*50,1000,true,false,false,false,false,0,0,0,0,null))throw new AssertionError();
 reject(()->missing.observe(2000,1000,true,false,false,false,false,0,0,0,0,null));
 WelcomeTailPolicy changed=new WelcomeTailPolicy();changed.observe(1100,1000,true,true,true,false,false,1,1,1,1,"r1");
 if(changed.observe(1200,1000,true,true,true,false,false,1,1,1,1,"r2"))throw new AssertionError();
 if(!changed.observe(1300,1000,true,true,true,false,false,1,1,1,1,"r2"))throw new AssertionError();`;
 writeFileSync(join(dir,'ConsentTailHarness.java'),`public final class ConsentTailHarness {\n${java.slice(start,end)}\nstatic void reject(Runnable r){try{r.run();}catch(IllegalStateException ok){return;}throw new AssertionError("invalid tail accepted");}\npublic static void main(String[] args){${checks}\nSystem.out.println("consent-tail-policy:passed");}}`);
 const javac=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/javac'):'javac',binary=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'java';
 const compiled=spawnSync(javac,[`-J-Djava.io.tmpdir=${dir}`,'-d',dir,join(dir,'ConsentTailHarness.java')],{encoding:'utf8',timeout:20000});assert.equal(compiled.status,0,compiled.stderr);
 const ran=spawnSync(binary,[`-Djava.io.tmpdir=${dir}`,'-cp',dir,'ConsentTailHarness'],{encoding:'utf8',timeout:20000});assert.equal(ran.status,0,ran.stderr);assert.equal(ran.stdout.trim(),'consent-tail-policy:passed');
});

test('incomplete tail driver resets stability and requires two later complete samples without input retry',()=>{
 const value=consentInput(), first=structuredClone(value.setupTail.observations[1]);
 const complete=(at)=>({...first,uptimeMs:at,snapshotComplete:true,nodesVisited:8,maxDepth:3,missingChildCount:0,missingChildDepth:-1,missingChildIndex:-1});
 value.setupTail.observations=[{...value.setupTail.observations[0],snapshotComplete:false,nodesVisited:0,maxDepth:0,missingChildCount:0,missingChildDepth:-1,missingChildIndex:-1},complete(1200),{...complete(1250),snapshotComplete:false,missingChildCount:1,missingChildDepth:2,missingChildIndex:0},complete(1350),complete(1450)];
 Object.assign(value.setupTail,{firstStableUptimeMs:1350,lastStableUptimeMs:1450,finishedUptimeMs:1451});
 validateUpdateConsentTail(value);
 for(const mutate of[
  x=>x.setupTail.observations[2].snapshotComplete=true,
  x=>x.setupTail.observations[2].unexpected=true,
  x=>x.setupTail.observations[2].ownerValid=false,
  x=>x.setupTail.observations[2].missingChildCount=0,
  x=>x.setupTail.observations[2].nodesVisited=513,
  x=>x.setupTail.observations[2].maxDepth=33,
  x=>x.setupTail.observations.pop(),
  x=>x.setupTail.firstStableUptimeMs=1200,
  x=>x.setupTail.observations[4].uptimeMs=3101,
  x=>x.setupTail.observations[0].snapshotComplete=true,
 ]){const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateUpdateConsentTail(copy));}
 const partialOnly=structuredClone(value);partialOnly.setupTail.observations=Array.from({length:20},(_,i)=>({...value.setupTail.observations[2],uptimeMs:1100+i*100}));assert.throws(()=>validateUpdateConsentTail(partialOnly));
});

test('incomplete tail actual copied Java scanner preserves partial numeric state and never accepts its tree',()=>{
 const constants=['PRODUCT','PLAYER'].map(name=>java.match(new RegExp(`    private static final String ${name} = [^;]+;`))[0]);
 constants.push(java.match(/    private static final Pattern TERMS = [^;]+;/)[0]);
 const acq=java.slice(java.indexOf('    static final class AcquisitionPolicy {'),java.indexOf('    private static final class AcquiredMore'));
 const policies=java.slice(java.indexOf('    static final class WelcomeTailPolicy {'),java.indexOf('    private void requireUpdateConsentWelcomeTail'));
 const support=`
 static final class Rect {int left,top,right,bottom;Rect(){this(0,0,1080,1920);}Rect(int a,int b,int c,int d){left=a;top=b;right=c;bottom=d;}boolean isEmpty(){return right<=left||bottom<=top;}boolean contains(Rect r){return r.left>=left&&r.top>=top&&r.right<=right&&r.bottom<=bottom;}}
 static final class AccessibilityNodeInfo {String text,clazz;AccessibilityNodeInfo[] children;AccessibilityNodeInfo(String c,String t,AccessibilityNodeInfo... kids){clazz=c;text=t;children=kids;}CharSequence getText(){return text;}CharSequence getContentDescription(){return null;}CharSequence getClassName(){return clazz;}String getViewIdResourceName(){return null;}CharSequence getPackageName(){return PRODUCT;}int getWindowId(){return 7;}boolean isVisibleToUser(){return true;}boolean isEnabled(){return true;}boolean isClickable(){return clazz.equals("android.widget.Button");}void getBoundsInScreen(Rect r){}int getChildCount(){return children.length;}AccessibilityNodeInfo getChild(int i){return children[i];}void recycle(){}}
 static void assertTrue(String m,boolean b){if(!b)throw new AssertionError(m);}static void assertNotNull(String m,Object o){if(o==null)throw new AssertionError(m);}
 static boolean complete(WelcomeTailScan scan)throws Exception{try{return (Boolean)WelcomeTailScan.class.getDeclaredField("complete").get(scan);}catch(NoSuchFieldException old){return true;}}
 static int numeric(WelcomeTailScan scan,String name)throws Exception{return (Integer)WelcomeTailScan.class.getDeclaredField(name).get(scan);}
 static boolean sample(WelcomeTailPolicy p,long at,boolean available,boolean owner,boolean unexpected,boolean completed,int d,int t,int s,int n)throws Exception{
 try{return (Boolean)WelcomeTailPolicy.class.getDeclaredMethod("observe",long.class,long.class,boolean.class,boolean.class,boolean.class,boolean.class,boolean.class,int.class,int.class,int.class,int.class,String.class,boolean.class).invoke(p,at,1000L,true,available,owner,unexpected,false,d,t,s,n,available?"r":null,completed);}catch(NoSuchMethodException old){return p.observe(at,1000,true,available,owner,unexpected,false,d,t,s,n,available?"r":null);}catch(java.lang.reflect.InvocationTargetException failed){if(failed.getCause() instanceof RuntimeException)throw (RuntimeException)failed.getCause();throw failed;}}
 static void reject(Checked r)throws Exception{try{r.run();}catch(IllegalStateException expected){return;}throw new AssertionError("invalid partial sample accepted");}interface Checked{void run()throws Exception;}
 `;
 const checks=`
 IncompleteTailHarness harness=new IncompleteTailHarness();
 AccessibilityNodeInfo title=new AccessibilityNodeInfo("android.widget.TextView","Welcome to YAWF Stream");
 AccessibilityNodeInfo root=new AccessibilityNodeInfo("android.app.Dialog","Welcome",title,null);
 WelcomeTailScan partial=new WelcomeTailScan(new Rect(),7);
 try{harness.scanWelcomeTail(root,partial,0);}catch(AssertionError old){throw new AssertionError("R5 null child must be persisted as incomplete, not abort the readonly sampler",old);}
 if(complete(partial)||numeric(partial,"missingChildCount")!=1||partial.dialogs!=1||partial.titles!=1||partial.budget.nodes!=2)throw new AssertionError("partial numeric state lost");
 WelcomeTailPolicy p=new WelcomeTailPolicy();
 if(sample(p,1000,false,false,false,false,0,0,0,0))throw new AssertionError();
 if(sample(p,1100,true,true,false,true,1,1,1,1))throw new AssertionError();
 if(sample(p,1200,true,true,false,false,1,1,1,1))throw new AssertionError("partial tree accepted");
 if(sample(p,1300,true,true,false,true,1,1,1,1))throw new AssertionError("partial tree earned stability");
 if(!sample(p,1400,true,true,false,true,1,1,1,1))throw new AssertionError("two complete samples refused");
 reject(()->sample(new WelcomeTailPolicy(),1100,true,true,true,false,1,1,1,1));
 reject(()->sample(new WelcomeTailPolicy(),1100,true,false,false,false,1,1,1,1));
 reject(()->sample(new WelcomeTailPolicy(),3001,true,true,false,false,1,1,1,1));
 WelcomeTailPolicy capped=new WelcomeTailPolicy();for(int i=0;i<20;i++)if(sample(capped,1000+i*50,true,true,false,false,1,1,1,1))throw new AssertionError();reject(()->sample(capped,2000,true,true,false,false,1,1,1,1));
 `;
 const dir=realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP||process.env.TMPDIR,'incomplete-tail-')));
 writeFileSync(join(dir,'IncompleteTailHarness.java'),`import java.util.regex.Pattern;public final class IncompleteTailHarness {${constants.join('\n')}\n${support}\n${acq}\n${policies}\npublic static void main(String[] args)throws Exception{${checks}\nSystem.out.println("incomplete-tail:passed");}}`);
 const javac=join(process.env.JAVA_HOME,'bin/javac'),binary=join(process.env.JAVA_HOME,'bin/java');
 const built=spawnSync(javac,[`-J-Djava.io.tmpdir=${dir}`,'-d',dir,join(dir,'IncompleteTailHarness.java')],{encoding:'utf8',timeout:20000});assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(binary,[`-Djava.io.tmpdir=${dir}`,'-cp',dir,'IncompleteTailHarness'],{encoding:'utf8',timeout:20000});assert.equal(ran.status,0,ran.stderr);assert.equal(ran.stdout.trim(),'incomplete-tail:passed');
 const tail=java.slice(java.indexOf('    private void requireUpdateConsentWelcomeTail'),java.indexOf('    private void tapObject'));
 for(const text of ['"snapshotComplete"','"nodesVisited"','"missingChildCount"','"missingChildDepth"','"missingChildIndex"'])assert.ok(tail.includes(text));
 assert.ok(tail.indexOf('observations.put(')<tail.indexOf('policy.observe('));assert.doesNotMatch(tail,/\.tap\(|\.click\(|inject\(|pressBack|startActivity/);
});

test('tail reason JSON accepts exact bounded enums and raw geometry but rejects unknown schema or text',()=>{
 const observation=()=>structuredClone(consentInput().setupTail.observations[1]);
 const validate=runtime.validateTailReasonEvidence;assert.equal(typeof validate,'function','Diagnostic reason validator is required');
 validate(observation());
 const names=['TERMS_TEXT','TERMS_DESCRIPTION','UNKNOWN_DIALOG','UNKNOWN_ALERT_TITLE','UNKNOWN_NATIVE_BUTTON','KNOWN_PACKAGE','KNOWN_WINDOW','KNOWN_NOT_VISIBLE','KNOWN_EMPTY_BOUNDS','KNOWN_OUTSIDE_ROOT','SKIP_DISABLED','SKIP_NOT_CLICKABLE','NEXT_DISABLED','NEXT_NOT_CLICKABLE'];
 for(let i=0;i<names.length;i++){
  const o=observation(),bit=1<<i;o.unexpected=true;Object.assign(o.reasonEvidence,{bits:bit,reasons:[names[i]]});
  if(i>=5){
   const node={kind:i>=12?'NEXT':i>=10?'SKIP':'TITLE',nodeOrdinal:1,depth:0,packageMatches:true,windowId:7,visible:true,enabled:i>=10?true:null,clickable:i>=10?true:null,rawBounds:[0,0,100,100],reasonBits:bit};
   if(i===5)Object.assign(node,{packageMatches:false,windowId:null,visible:null});
   if(i===6)Object.assign(node,{windowId:-1,visible:null});
   if(i===7)node.visible=false;
   if(i===8)node.rawBounds=[10,10,10,10];
   if(i===9)node.rawBounds=[-3,0,100,100];
   if(i===10||i===12)Object.assign(node,{enabled:false,clickable:null});
   if(i===11||i===13)node.clickable=false;
   o.reasonEvidence.knownNodes=[node];
  }
  validate(o);
  const input=consentInput();input.setupTail.observations[1]=o;assert.throws(()=>validateUpdateConsentTail(input),'Diagnostics must never waive unexpected refusal');
 }
 const valid=observation();valid.reasonEvidence.knownNodes=[{kind:'TITLE',nodeOrdinal:1,depth:0,packageMatches:true,windowId:7,visible:true,enabled:null,clickable:null,rawBounds:[0,0,100,100],reasonBits:0}];validate(valid);
 for(const mutate of[
  o=>o.reasonEvidence.schemaVersion=2,o=>o.reasonEvidence.bits=16384,o=>o.reasonEvidence.bits=-1,o=>o.reasonEvidence.bits=1.5,
  o=>o.reasonEvidence.reasons=['OTHER'],o=>o.reasonEvidence.reasons=['TERMS_TEXT'],o=>o.reasonEvidence.reasons.push('TERMS_TEXT'),
  o=>o.reasonEvidence.bits=1,o=>o.unexpected=true,o=>o.reasonEvidence.text='unowned text',o=>o.text='unowned text',o=>o.reasonEvidence.url='https://invalid.example/',
  o=>o.reasonEvidence.knownNodes[0].text='unowned text',o=>o.reasonEvidence.knownNodes[0].kind='OTHER',
  o=>o.reasonEvidence.knownNodes[0].windowId='7',o=>o.reasonEvidence.knownNodes[0].visible=null,
  o=>o.reasonEvidence.knownNodes[0].rawBounds=[0,0,100,2147483648],o=>o.reasonEvidence.knownNodes[0].rawBounds[0]=NaN,
  o=>o.reasonEvidence.knownNodes[0].nodeOrdinal=513,o=>o.reasonEvidence.knownNodes[0].depth=33,
  o=>o.reasonEvidence.knownNodes[0].enabled=true,o=>o.reasonEvidence.knownNodes[0].reasonBits=32,
  o=>o.reasonEvidence.knownNodes=Array.from({length:9},()=>o.reasonEvidence.knownNodes[0]),o=>o.reasonEvidence.truncated=1,
  o=>Object.assign(o.reasonEvidence.knownNodes[0],{packageMatches:false,windowId:7}),
  o=>Object.assign(o.reasonEvidence.knownNodes[0],{kind:'SKIP',enabled:false,clickable:false}),
 ]){const o=structuredClone(valid);mutate(o);assert.throws(()=>validate(o));}
 const unknown=consentInput();unknown.setupTail.observations[1].rawText='not permitted';assert.throws(()=>validateUpdateConsentTail(unknown));
});

test('actual copied Java reason scanner attributes all fourteen existing predicates without extra SDK reads',()=>{
 const constants=['PRODUCT','PLAYER'].map(name=>java.match(new RegExp(`    private static final String ${name} = [^;]+;`))[0]);
 constants.push(java.match(/    private static final Pattern TERMS = [^;]+;/)[0]);
 const acq=java.slice(java.indexOf('    static final class AcquisitionPolicy {'),java.indexOf('    private static final class AcquiredMore'));
 const scanner=java.slice(java.indexOf('    private static final class WelcomeTailScan'),java.indexOf('    private void requireUpdateConsentWelcomeTail'));
 const support=`
 static final class Rect {int left,top,right,bottom;Rect(){this(0,0,1080,1920);}Rect(int a,int b,int c,int d){left=a;top=b;right=c;bottom=d;}boolean isEmpty(){return right<=left||bottom<=top;}boolean contains(Rect r){return r.left>=left&&r.top>=top&&r.right<=right&&r.bottom<=bottom;}}
 static final class AccessibilityNodeInfo {String text,clazz,description,resource,pkg=PRODUCT;int window=7,windowReads,visibleReads,enabledReads,clickableReads;boolean visible=true,enabled=true,clickable=true;Rect bounds=new Rect(0,0,100,100);AccessibilityNodeInfo[] children=new AccessibilityNodeInfo[0];AccessibilityNodeInfo(String c,String t){clazz=c;text=t;}CharSequence getText(){return text;}CharSequence getContentDescription(){return description;}CharSequence getClassName(){return clazz;}String getViewIdResourceName(){return resource;}CharSequence getPackageName(){return pkg;}int getWindowId(){windowReads++;return window;}boolean isVisibleToUser(){visibleReads++;return visible;}boolean isEnabled(){enabledReads++;return enabled;}boolean isClickable(){clickableReads++;return clickable;}void getBoundsInScreen(Rect r){r.left=bounds.left;r.top=bounds.top;r.right=bounds.right;r.bottom=bounds.bottom;}int getChildCount(){return children.length;}AccessibilityNodeInfo getChild(int i){return children[i];}void recycle(){}}
 static void assertTrue(String m,boolean b){if(!b)throw new AssertionError(m);}static void assertNotNull(String m,Object o){if(o==null)throw new AssertionError(m);}
 static int reasons(WelcomeTailScan scan)throws Exception{try{return (Integer)WelcomeTailScan.class.getDeclaredField("reasonBits").get(scan);}catch(NoSuchFieldException old){return 0;}}
 static Object field(Object o,String name)throws Exception{var f=o.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(o);}
 `;
 const checks=`
 TailReasonsHarness h=new TailReasonsHarness();
 for(int i=0;i<14;i++){
  AccessibilityNodeInfo n=new AccessibilityNodeInfo("android.widget.TextView", "Welcome to YAWF Stream");
  if(i==0)n.text="Terms of Service";
  if(i==1){n.text="";n.description="Terms of Service";}
  if(i==2){n.clazz="android.app.Dialog";n.text="Unknown";}
  if(i==3){n.text="";n.resource="android:id/alertTitle";}
  if(i==4){n.text="";n.resource="android:id/button2";}
  if(i==5)n.pkg="other.package";
  if(i==6)n.window=8;
  if(i==7)n.visible=false;
  if(i==8)n.bounds=new Rect(10,10,10,10);
  if(i==9)n.bounds=new Rect(-3,0,100,100);
  if(i>=10){n.text=i>=12?"Next":"Skip";n.clazz="android.widget.Button";if(i%2==0)n.enabled=false;else n.clickable=false;}
  WelcomeTailScan scan=new WelcomeTailScan(new Rect(),7);h.scanWelcomeTail(n,scan,0);
  if(!scan.unexpected||reasons(scan)!=(1<<i))throw new AssertionError("predicate "+i+" expected "+(1<<i)+" got "+reasons(scan));
  if(n.windowReads!=(i>=6?1:0)||n.visibleReads!=(i>=7?1:0)||n.enabledReads!=(i>=10?1:0)||n.clickableReads!=(i>=10&&i%2==1?1:0))throw new AssertionError("short-circuit SDK reads changed for "+i);
  if(i>=5){java.util.List<?> nodes=(java.util.List<?>)field(scan,"knownNodes");Object record=nodes.get(0);
   if(i==5&&(field(record,"windowId")!=null||field(record,"visible")!=null))throw new AssertionError("unread metadata fabricated");
   if(i==6&&field(record,"visible")!=null)throw new AssertionError("unread visibility fabricated");
   if(i==9&&((Rect)field(record,"rawBounds")).left!=-3)throw new AssertionError("raw bounds clipped");
   if((i==10||i==12)&&field(record,"clickable")!=null)throw new AssertionError("unread clickable fabricated");
  }
 }
 AccessibilityNodeInfo healthy=new AccessibilityNodeInfo("android.app.Dialog","Welcome");healthy.children=new AccessibilityNodeInfo[]{new AccessibilityNodeInfo("android.widget.TextView","Welcome to YAWF Stream"),new AccessibilityNodeInfo("android.widget.Button","Skip"),new AccessibilityNodeInfo("android.widget.Button","Next")};
 WelcomeTailScan good=new WelcomeTailScan(new Rect(),7);h.scanWelcomeTail(healthy,good,0);if(good.unexpected||reasons(good)!=0||good.dialogs!=1||good.titles!=1||good.skips!=1||good.nexts!=1)throw new AssertionError("valid original Welcome refused");
 AccessibilityNodeInfo nativePrompt=new AccessibilityNodeInfo("android.app.Dialog","Enable Android update checks?");AccessibilityNodeInfo alert=new AccessibilityNodeInfo("android.widget.TextView","Enable Android update checks?");alert.resource="android:id/alertTitle";AccessibilityNodeInfo no=new AccessibilityNodeInfo("android.widget.Button","NOT NOW");no.resource="android:id/button2";AccessibilityNodeInfo yes=new AccessibilityNodeInfo("android.widget.Button","ENABLE");yes.resource="android:id/button1";nativePrompt.children=new AccessibilityNodeInfo[]{alert,no,yes};
 WelcomeTailScan prompt=new WelcomeTailScan(new Rect(),7);h.scanWelcomeTail(nativePrompt,prompt,0);if(!prompt.oldPrompt||prompt.unexpected||reasons(prompt)!=0)throw new AssertionError("known native prompt reclassified");
 AccessibilityNodeInfo repeated=new AccessibilityNodeInfo("android.view.View","");repeated.children=new AccessibilityNodeInfo[9];for(int i=0;i<9;i++)repeated.children[i]=new AccessibilityNodeInfo("android.widget.TextView","Welcome to YAWF Stream");WelcomeTailScan cap=new WelcomeTailScan(new Rect(),7);h.scanWelcomeTail(repeated,cap,0);if(((java.util.List<?>)field(cap,"knownNodes")).size()!=8||!(Boolean)field(cap,"knownNodesTruncated")||cap.unexpected)throw new AssertionError("diagnostic cap changed policy");
 `;
 const dir=realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP||process.env.TMPDIR,'tail-reasons-')));
 writeFileSync(join(dir,'TailReasonsHarness.java'),`import java.util.regex.Pattern;public final class TailReasonsHarness {${constants.join('\n')}\n${support}\n${acq}\n${scanner}\npublic static void main(String[] args)throws Exception{${checks}\nSystem.out.println("tail-reasons:14-predicates-passed");}}`);
 const built=spawnSync(join(process.env.JAVA_HOME,'bin/javac'),[`-J-Djava.io.tmpdir=${dir}`,'-d',dir,join(dir,'TailReasonsHarness.java')],{encoding:'utf8',timeout:20000});assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(join(process.env.JAVA_HOME,'bin/java'),[`-Djava.io.tmpdir=${dir}`,'-cp',dir,'TailReasonsHarness'],{encoding:'utf8',timeout:20000});assert.equal(ran.status,0,ran.stderr);assert.equal(ran.stdout.trim(),'tail-reasons:14-predicates-passed');
});

test('reason capture is bounded numeric-only before unchanged policy refusal and does not query SDK again',()=>{
 const scan=java.slice(java.indexOf('    private void scanWelcomeTail'),java.indexOf('    private void requireUpdateConsentWelcomeTail'));
 for(const method of ['getBoundsInScreen','getPackageName','getWindowId','isVisibleToUser'])assert.equal((scan.match(new RegExp(`node\\.${method}\\(`,'g'))||[]).length,1,method);
 assert.equal((scan.match(/node\.isEnabled\(/g)||[]).length,2);assert.equal((scan.match(/node\.isClickable\(/g)||[]).length,2);
 assert.match(scan,/knownNodes\.size\(\) < 8/);assert.match(scan,/else scan\.knownNodesTruncated = true/);
 const tail=java.slice(java.indexOf('    private void requireUpdateConsentWelcomeTail'),java.indexOf('    private JSONObject tailReasonEvidence'));
 const evidenceAt=tail.indexOf('.put("reasonEvidence", tailReasonEvidence(scan))');
 assert.ok(evidenceAt>=0 && evidenceAt<tail.indexOf('policy.observe('));
 const serialize=java.slice(java.indexOf('    private JSONObject tailReasonEvidence'),java.indexOf('    private void tapObject'));
 assert.doesNotMatch(serialize,/node\.|getText|getContentDescription|getClassName|getViewIdResourceName|getPackageName|getWindowId|isVisibleToUser|isEnabled|isClickable|URL|\.play\(|\.pause\(/);
 const keys=[...serialize.matchAll(/\.put\("([A-Za-z]+)"/g)].map(m=>m[1]).sort();
 assert.deepEqual(keys,['bits','clickable','depth','enabled','kind','knownNodes','nodeOrdinal','packageMatches','rawBounds','reasonBits','reasons','schemaVersion','truncated','visible','windowId'].sort());
 assert.ok(java.includes('assertTrue("Diagnostic geometry captured; More DOWN intentionally not admitted", false)'));
});

const observedExpandedWelcomeTail=()=>{
 const value=consentInput(),up=126676;
 Object.assign(value,{downUptimeMs:up-100,eventUptimeMs:[up-100,up-50,up]});
 const node=(kind,nodeOrdinal,depth,rawBounds,reasonBits=0)=>({kind,nodeOrdinal,depth,packageMatches:true,windowId:10,visible:true,enabled:kind==='SKIP'||kind==='NEXT'?true:null,clickable:kind==='SKIP'||kind==='NEXT'?true:null,rawBounds,reasonBits});
 const expanded={uptimeMs:127600,rootAvailable:true,ownerValid:true,rootWindowId:10,rootBounds:[0,0,1080,1920],rootKey:'10,0,0,1080,1920',oldPrompt:false,unexpected:true,dialogs:1,titles:1,skips:1,nexts:1,snapshotComplete:true,nodesVisited:17,maxDepth:11,missingChildCount:0,missingChildDepth:-1,missingChildIndex:-1,reasonEvidence:{schemaVersion:1,bits:512,reasons:['KNOWN_OUTSIDE_ROOT'],knownNodes:[node('WELCOME',10,9,[0,0,1082,1922],512),node('TITLE',14,11,[136,724,945,803]),node('SKIP',16,11,[136,1165,262,1275]),node('NEXT',17,11,[779,1162,945,1281])],truncated:false}};
 const strict=(at)=>{const sample=structuredClone(expanded);sample.uptimeMs=at;sample.unexpected=false;sample.reasonEvidence.bits=0;sample.reasonEvidence.reasons=[];Object.assign(sample.reasonEvidence.knownNodes[0],{rawBounds:[0,0,1080,1920],reasonBits:0});return sample;};
 const partial={...structuredClone(expanded),uptimeMs:127068,rootWindowId:11,rootBounds:[28,701,1052,1219],rootKey:'11,28,701,1052,1219',unexpected:false,dialogs:0,titles:0,skips:0,nexts:0,snapshotComplete:false,nodesVisited:1,maxDepth:0,missingChildCount:1,missingChildDepth:0,missingChildIndex:0,reasonEvidence:zeroTailReasons()};
 Object.assign(value.setupTail,{upUptimeMs:up,firstStableUptimeMs:127700,lastStableUptimeMs:127800,finishedUptimeMs:127801,observations:[partial,expanded,strict(127700),strict(127800)]});
 return {value,expanded,strict};
};

test('observed Welcome-only expansion is NOTREADY then needs two new strict samples within the unchanged bound',()=>{
 const {value,expanded,strict}=observedExpandedWelcomeTail();
 validateUpdateConsentTail(value);
 for(const mutate of[
  x=>x.setupTail.observations.splice(2,1),
  x=>x.setupTail.observations[3].uptimeMs=127799,
  x=>x.setupTail.firstStableUptimeMs=127600,
  x=>x.setupTail.observations[2].reasonEvidence.knownNodes[0].rawBounds=[0,0,1081,1921],
  x=>x.setupTail.observations[1].oldPrompt=true,
  x=>x.setupTail.observations[1].ownerValid=false,
  x=>x.setupTail.observations[1].reasonEvidence.truncated=true,
  x=>x.setupTail.observations[1].reasonEvidence.knownNodes.pop(),
  x=>x.setupTail.observations[1].reasonEvidence.knownNodes[0].rawBounds[0]=-1,
  x=>x.setupTail.observations[1].reasonEvidence.knownNodes[0].rawBounds[1]=-1,
  x=>x.setupTail.observations[1].reasonEvidence.knownNodes[0].rawBounds=[0,0,1079,1922],
  x=>{const o=x.setupTail.observations[1];o.reasonEvidence.bits|=1;o.reasonEvidence.reasons.unshift('TERMS_TEXT');},
  x=>{const o=x.setupTail.observations[1];o.reasonEvidence.knownNodes[0].reasonBits=0;o.reasonEvidence.knownNodes[0].rawBounds=[0,0,1080,1920];Object.assign(o.reasonEvidence.knownNodes[1],{reasonBits:512,rawBounds:[-1,0,100,100]});},
  x=>{const o=x.setupTail.observations[1];o.snapshotComplete=false;o.missingChildCount=1;o.missingChildDepth=0;o.missingChildIndex=0;},
 ]){const copy=structuredClone(value);mutate(copy);assert.throws(()=>validateUpdateConsentTail(copy));}
 for(const amount of[1,2,3,100000]){
  const x=structuredClone(value),o=x.setupTail.observations[1];o.reasonEvidence.knownNodes[0].rawBounds=[0,0,1080+amount,1920+amount];validateUpdateConsentTail(x);
  const persistent=structuredClone(value);persistent.setupTail.observations=Array.from({length:20},(_,i)=>({...structuredClone(o),uptimeMs:126676+i*100}));assert.throws(()=>validateUpdateConsentTail(persistent));
 }
 const reset=structuredClone(value);reset.setupTail.observations=[structuredClone(expanded),strict(127700),{...strict(127750),snapshotComplete:false,missingChildCount:1,missingChildDepth:0,missingChildIndex:0},strict(127850),strict(127950)];Object.assign(reset.setupTail,{firstStableUptimeMs:127850,lastStableUptimeMs:127950,finishedUptimeMs:127951});validateUpdateConsentTail(reset);
 const partialOnly=structuredClone(reset);partialOnly.setupTail.observations.pop();assert.throws(()=>validateUpdateConsentTail(partialOnly));
 const late=structuredClone(value);late.setupTail.observations[3].uptimeMs=128677;assert.throws(()=>validateUpdateConsentTail(late));
});

test('actual Java Welcome expansion classifier never earns readiness and preserves terminal predicates and deadlines',()=>{
 const definitions=java.slice(java.indexOf('    static final class WelcomeTailPolicy {'),java.indexOf('    private void scanWelcomeTail'));
 const start=java.indexOf('    private static boolean isWelcomeLayoutSettling('),end=java.indexOf('    private void requireUpdateConsentWelcomeTail');
 const classifier=start<0?'private static boolean isWelcomeLayoutSettling(WelcomeTailScan scan,boolean owner){return false;}':java.slice(start,end);
 const support=`static final class Rect{int left,top,right,bottom;Rect(){this(0,0,1080,1920);}Rect(int a,int b,int c,int d){left=a;top=b;right=c;bottom=d;}boolean isEmpty(){return right<=left||bottom<=top;}boolean contains(Rect r){return r.left>=left&&r.top>=top&&r.right<=right&&r.bottom<=bottom;}}
 static final class AcquisitionPolicy{int nodes,deepest;}
 static WelcomeTailScan observed(){WelcomeTailScan s=new WelcomeTailScan(new Rect(),10);s.dialogs=s.titles=s.skips=s.nexts=1;s.reasonBits=512;s.unexpected=true;s.knownNodes.add(new KnownTailNode("WELCOME",10,9,true,10,true,null,null,new Rect(0,0,1082,1922),512));s.knownNodes.add(new KnownTailNode("TITLE",14,11,true,10,true,null,null,new Rect(136,724,945,803),0));s.knownNodes.add(new KnownTailNode("SKIP",16,11,true,10,true,true,true,new Rect(136,1165,262,1275),0));s.knownNodes.add(new KnownTailNode("NEXT",17,11,true,10,true,true,true,new Rect(779,1162,945,1281),0));return s;}
 static boolean sample(WelcomeTailPolicy p,WelcomeTailScan s,long at){boolean settling=isWelcomeLayoutSettling(s,true);return p.observe(at,1000,true,true,true,s.unexpected&&!settling,s.oldPrompt,s.dialogs,s.titles,s.skips,s.nexts,"r",s.complete&&!settling);}
 static void reject(Runnable r){try{r.run();}catch(IllegalStateException expected){return;}throw new AssertionError("Terminal sample accepted");}
 static WelcomeTailScan strict(){WelcomeTailScan s=observed();s.unexpected=false;s.reasonBits=0;KnownTailNode n=s.knownNodes.get(0);s.knownNodes.set(0,new KnownTailNode(n.kind,n.nodeOrdinal,n.depth,true,10,true,null,null,new Rect(),0));return s;}`;
 const checks=`WelcomeTailScan expanded=observed();if(!isWelcomeLayoutSettling(expanded,true))throw new AssertionError("Observed Welcome expansion must be NOTREADY");if(isWelcomeLayoutSettling(expanded,false))throw new AssertionError("Owner waived");WelcomeTailPolicy p=new WelcomeTailPolicy();if(sample(p,expanded,1100)||p.stable!=0)throw new AssertionError("Expansion earned readiness");if(sample(p,strict(),1200))throw new AssertionError();if(!sample(p,strict(),1300))throw new AssertionError("Two strict samples refused");
 for(int amount:new int[]{1,2,3,100000}){WelcomeTailScan s=observed();s.knownNodes.get(0).rawBounds.right=1080+amount;s.knownNodes.get(0).rawBounds.bottom=1920+amount;if(!isWelcomeLayoutSettling(s,true))throw new AssertionError("Magnitude changes NOTREADY");WelcomeTailPolicy capped=new WelcomeTailPolicy();for(int i=0;i<20;i++)if(sample(capped,s,1000+i*100))throw new AssertionError("Persistent expansion accepted");reject(()->sample(capped,s,3001));}
 WelcomeTailPolicy reset=new WelcomeTailPolicy();sample(reset,strict(),1100);sample(reset,expanded,1150);if(sample(reset,strict(),1200))throw new AssertionError("Expansion did not reset stability");WelcomeTailScan partial=strict();partial.complete=false;sample(reset,partial,1250);if(sample(reset,strict(),1300))throw new AssertionError("Partial did not reset stability");if(!sample(reset,strict(),1400))throw new AssertionError();
 for(int i=0;i<10;i++){WelcomeTailScan s=observed();if(i==0)s.reasonBits|=1;if(i==1)s.oldPrompt=true;if(i==2)s.complete=false;if(i==3)s.knownNodesTruncated=true;if(i==4)s.knownNodes.get(0).rawBounds.left=-1;if(i==5)s.knownNodes.get(0).rawBounds.top=-1;if(i==6)s.knownNodes.get(0).rawBounds.right=1079;if(i==7)s.knownNodes.remove(3);if(i==8){KnownTailNode n=s.knownNodes.get(1);s.knownNodes.set(1,new KnownTailNode(n.kind,14,11,false,null,null,null,null,n.rawBounds,32));}if(i==9){KnownTailNode n=s.knownNodes.get(1);s.knownNodes.set(1,new KnownTailNode(n.kind,14,11,true,10,true,null,null,new Rect(-1,0,100,100),512));}if(isWelcomeLayoutSettling(s,true))throw new AssertionError("Other predicate waived "+i);reject(()->sample(new WelcomeTailPolicy(),s,1100));}
 if(!expanded.unexpected||expanded.reasonBits!=512||expanded.knownNodes.get(0).rawBounds.right!=1082)throw new AssertionError("Raw evidence changed");`;
 const dir=realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP||process.env.TMPDIR,'welcome-settling-')));
 writeFileSync(join(dir,'WelcomeSettlingHarness.java'),`public final class WelcomeSettlingHarness{${support}\n${definitions}\n${classifier}\npublic static void main(String[] args){${checks}System.out.println("welcome-settling:passed");}}`);
 const built=spawnSync(join(process.env.JAVA_HOME,'bin/javac'),[`-J-Djava.io.tmpdir=${dir}`,'-d',dir,join(dir,'WelcomeSettlingHarness.java')],{encoding:'utf8',timeout:20000});assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(join(process.env.JAVA_HOME,'bin/java'),[`-Djava.io.tmpdir=${dir}`,'-cp',dir,'WelcomeSettlingHarness'],{encoding:'utf8',timeout:20000});assert.equal(ran.status,0,ran.stderr);assert.equal(ran.stdout.trim(),'welcome-settling:passed');
});

test('Welcome settling classification is readonly and retains raw unexpected evidence before the unchanged policy',()=>{
 const policy=java.slice(java.indexOf('    static final class WelcomeTailPolicy {'),java.indexOf('    private static final class WelcomeTailScan'));
 assert.equal(createHash('sha256').update(policy).digest('hex'),'6ff893b46ffa193340d468d3b7bfc155473094d11f2f4834adc4e5c41a9cf39d');
 const start=java.indexOf('    private static boolean isWelcomeLayoutSettling('),end=java.indexOf('    private void requireUpdateConsentWelcomeTail');assert.ok(start>=0&&end>start);
 const classifier=java.slice(start,end);assert.doesNotMatch(classifier,/\.getRootInActiveWindow\(|\.clearCache\(|\.getBoundsInScreen\(|\.getWindowId\(|\.isVisibleToUser\(|\.isEnabled\(|\.isClickable\(|inject\(|\.tap\(|\.click\(|SystemClock|scan\.unexpected\s*=(?!=)|scan\.reasonBits\s*=(?!=)|\.rawBounds\.[a-z]+\s*=(?!=)/);
 const tail=java.slice(end,java.indexOf('    private JSONObject tailReasonEvidence'));
 assert.ok(tail.includes('scan != null && scan.unexpected).put("dialogs"'));
 assert.ok(tail.includes('boolean settling = root != null && owner && isWelcomeLayoutSettling(scan, owner);'));
 assert.ok(tail.includes('scan != null && scan.unexpected && !settling'));
 assert.ok(tail.includes('root != null && owner && scan.complete && !settling'));
 assert.doesNotMatch(tail,/\.tap\(|\.click\(|inject\(|pressBack|startActivity/);
 assert.ok(java.includes('assertTrue("Diagnostic geometry captured; More DOWN intentionally not admitted", false)'));
});
