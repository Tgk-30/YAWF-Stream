import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, realpathSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PIN, sanitize, validateEnvironment, validateCatalog, cpuSnapshot, iowaitPercent,
  validateHostResources, validateGuest, validateLauncher, validateJUnit, validateReceipt, validateMenuOnlyReceipt, parseRuntimeMode, ownedDirectory, parseInstalledAPKPaths, parseAPKHashOutput } from './android_player91_runtime.mjs';

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
  assert.match(java, /if \(text\("Enable Android update checks\?"\) != null\) \{\s+click\("NOT NOW", 3_000\);/);
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
  const clock = java.slice(java.indexOf('    private int clock()'), java.indexOf('    private void tapObject('));
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
