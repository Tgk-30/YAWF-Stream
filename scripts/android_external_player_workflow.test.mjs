import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/android-current-runtime.yml', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
const driver = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java', import.meta.url), 'utf8');
const job = workflow.slice(workflow.indexOf('  external-player-fixture:\n'));

function workflowContract(w, j) {
  assert.match(w, /permissions:\n  contents: read\n  actions: read/);
  assert.match(j, /if: github\.ref_type == 'branch' && inputs\.external_player_fixture == true && inputs\.permission_fixture != true/);
  assert.match(j, /SYSTEM_IMAGE_PACKAGE: system-images;android-30;google_apis;x86_64/);
  assert.match(j, /PRODUCT_SHA256: f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb/);
  assert.match(j, /PRODUCT_SOURCE: 9fc94a237d99b849cfc18a01085bb487915dd978/);
  assert.match(j, /--certificate-pin public-phone-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(j, /test "\$installed_sha" = "\$PRODUCT_SHA256"/);
  assert.match(j, /decodedPlaybackClaimed'\] is False/);
  assert.match(j, /assert r\['outcome'\]=='passed' and r\['checks'\]\['openPlayerClicks'\]==1/);
  assert.match(j, /if: always\(\)/);
  const installs = [...j.matchAll(/adb[^\n]*\binstall(?:-multiple|-multi-package)?\b[^\n]*/g)].map(m => m[0]);
  assert.deepEqual(installs, [
    'adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK" | tee "$EVIDENCE/product-install.txt"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_APP_APK"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_TEST_APK"',
  ]);
  assert.doesNotMatch(j, /\b(?:pm\s+install|cmd\s+package\s+(?:install|grant)|pm\s+grant|appops\s+set)\b/);
  assert.match(j, /case "\$label" in Gallery\|Photos\)/);
  assert.match(j, /\$1 == expected && \$2 ~/);
  assert.doesNotMatch(j, /secrets\.|contents: write|packages: write|adb root|pm grant|settings put|run-as com\.tgk30/);
  assert.ok(j.indexOf('sha256sum --check -') < j.indexOf('adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK"'));
  assert.ok(j.indexOf('installed_sha') < j.indexOf('shell am instrument -w -r'));
}
function fixtureContract(f) {
  assert.match(f, /realpathSync\(raw\) !== raw/);
  assert.match(f, /if \(readdirSync\(ARTIFACT_DIR\)\.length !== 0\) \{\s*throw new Error\("--output must be empty/s);
  assert.match(f, /EXTERNAL_RECEIPT_LIMIT = 128/);
  assert.match(f, /externalReceiptPhase: "smoke" \| "live" = "smoke"/);
  assert.match(f, /generateFixtureMedia\(\);/);
  assert.match(f, /exactly segment000\.ts through segment011\.ts/);
  assert.match(f, /READY server-mode-ui loopback/);
  assert.match(f, /drawtext=fontfile=/);
  assert.doesNotMatch(f, /\/Volumes\/Work\/|\/private\/tmp\/ds-/);
}
function driverContract(d) {
  assert.equal((d.match(/openPlayer\.click\(\)/g) ?? []).length, 1);
  assert.match(d, /waitFor\(By\.text\(FIXTURE_ORIGIN_MESSAGE\)/);
  assert.match(d, /checks\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /receipt\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /Pattern\.CASE_INSENSITIVE \| Pattern\.UNICODE_CASE/);
  assert.match(d, /Pattern\.quote\(label\)/);
  assert.match(d, /device\.findObjects\(By\.text\(labelPattern\)\)/);
  assert.match(d, /device\.findObjects\(By\.desc\(labelPattern\)\)/);
  assert.match(d, /Ambiguous/);
  assert.match(d, /handler-playback-t1/);
  assert.match(d, /handler-playback-t2/);
  assert.match(d, /handler-after-seek/);
  assert.match(d, /device\.pressBack\(\);\s*waitForForegroundPackage\(PRODUCT_PACKAGE/);
  assert.doesNotMatch(d, /evaluateJavascript|executeShellCommand|grantRuntimePermission|shared_prefs/);
}

test('external job preserves immutable transport, narrow authority and honest receipts', () => workflowContract(workflow, job));
test('fixture preserves isolated output, bounded live receipts and visible-time media', () => fixtureContract(fixture));
test('driver uses one origin consent and leaves decoding to runtime review', () => driverContract(driver));

for (const [name, mutate, contract, original] of [
  ['APK hash', s => s.replace('PRODUCT_SHA256: f3e983', 'PRODUCT_SHA256: a3e983'), s => workflowContract(workflow, s), job],
  ['installed bytes', s => s.replace('test "$installed_sha" = "$PRODUCT_SHA256"', ':'), s => workflowContract(workflow, s), job],
  ['fourth third-party install', s => s + '\n          adb -s "$EMULATOR_SERIAL" install "third-party.apk"\n', s => workflowContract(workflow, s), job],
  ['alternate package install', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell cmd package install third-party.apk\n', s => workflowContract(workflow, s), job],
  ['alternate package grant', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell cmd package grant some.pkg android.permission.INTERNET\n', s => workflowContract(workflow, s), job],
  ['appops permission change', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell appops set some.pkg MANAGE_EXTERNAL_STORAGE allow\n', s => workflowContract(workflow, s), job],
  ['native button case', s => s.replace('Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE', 'Pattern.UNICODE_CASE'), driverContract, driver],
  ['first-match heading shadow', s => s.replace('device.findObjects(By.text(labelPattern))', 'java.util.Collections.singletonList(device.findObject(By.text(labelPattern)))'), driverContract, driver],
  ['native fake decode claim', s => s.replace('receipt.put("decodedPlaybackClaimed", false)', 'receipt.put("decodedPlaybackClaimed", true)'), driverContract, driver],
  ['lost origin confirmation', s => s.replace('waitFor(By.text(FIXTURE_ORIGIN_MESSAGE)', 'waitFor(By.text("Open external player?")'), driverContract, driver],
  ['unbounded event capture', s => s.replace('EXTERNAL_RECEIPT_LIMIT = 128', 'EXTERNAL_RECEIPT_LIMIT = 99999'), fixtureContract, fixture],
  ['fixture output overwrite', s => s.replace('readdirSync(ARTIFACT_DIR).length !== 0', 'false'), fixtureContract, fixture],
]) {
  test(`independently rejects ${name} mutant`, () => {
    contract(original);
    const changed = mutate(original);
    assert.notEqual(changed, original);
    assert.throws(() => contract(changed));
  });
}
