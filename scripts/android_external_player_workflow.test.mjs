import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/android-current-runtime.yml', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./android_external_player_server_fixture.mts', import.meta.url), 'utf8');
const driver = readFileSync(new URL('./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java', import.meta.url), 'utf8');
const job = workflow.slice(workflow.indexOf('  external-player-fixture:\n'));

function workflowContract(w, j) {
  assert.match(w, /permissions:\n  contents: read\n  actions: read/);
  assert.match(j, /if: github\.ref_type == 'branch' && inputs\.external_player_fixture == true && inputs\.permission_fixture != true/);
  assert.match(j, /SYSTEM_IMAGE_PACKAGE: system-images;android-36;google_apis;x86_64/);
  assert.match(j, /PRODUCT_SHA256: f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb/);
  assert.match(j, /PRODUCT_SOURCE: 9fc94a237d99b849cfc18a01085bb487915dd978/);
  assert.match(j, /validate_webview_provider\(provider,minimum_major=90,expected_package='com\.google\.android\.webview',expected_version=None\)/);
  assert.ok(j.indexOf('major=validate_webview_provider') < j.indexOf('adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK"'));
  assert.match(j, /--certificate-pin public-phone-source\/web\/src-tauri\/SIGNING_CERT_SHA256/);
  assert.match(j, /test "\$installed_sha" = "\$PRODUCT_SHA256"/);
  assert.match(j, /decodedPlaybackClaimed'\] is False/);
  assert.match(j, /assert r\['outcome'\]=='passed' and checks\['openPlayerClicks'\]==1/);
  assert.match(j, /all\(type\(value\) is bool for value in destination\)/);
  assert.match(j, /destination in \(\(True,False\),\(False,True\)\)/);
  assert.match(j, /# BEGIN EXTERNAL_DESTINATION_RECEIPT_POLICY/);
  assert.match(j, /host\['solePhotosDirectLaunchEligible'\] is True/);
  assert.match(j, /checks\['expectedHandlerForegroundObserved'\] is True/);
  assert.match(j, /checks\['manualMovingElapsedTimeCapturePair'\] is True/);
  assert.match(j, /checks\['semanticSeekGesturePerformed'\] is True/);
  assert.match(j, /checks\['singleBackReturnedToProduct'\] is True/);
  assert.match(j, /if: always\(\)/);
  const installs = [...j.matchAll(/adb[^\n]*\binstall(?:-multiple|-multi-package)?\b[^\n]*/g)].map(m => m[0]);
  assert.deepEqual(installs, [
    'adb -s "$EMULATOR_SERIAL" install "$PRODUCT_APK" | tee "$EVIDENCE/product-install.txt"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_APP_APK"',
    'adb -s "$EMULATOR_SERIAL" install "$HARNESS_TEST_APK"',
  ]);
  assert.doesNotMatch(j, /\b(?:pm\s+install|cmd\s+package\s+(?:install|grant)|pm\s+grant|appops\s+set)\b/);
  assert.match(j, /case "\$label" in Gallery\|Photos\)/);
  assert.match(j, /# BEGIN EXTERNAL_STOCK_HANDLER_POLICY/);
  assert.match(j, /len\(components\)==1/);
  assert.match(j, /assert cursor==len\(lines\)/);
  assert.match(j, /assert len\(components\)==reported/);
  assert.match(j, /Duplicate Activity component/);
  assert.match(j, /fixed_package='com\.google\.android\.apps\.photos'/);
  assert.match(j, /fixed_activity='com\.google\.android\.apps\.photos\.pager\.HostPhotoPagerActivity'/);
  assert.match(j, /-e externalHandlerActivity "\$handler_activity"/);
  assert.match(j, /-e externalHandlerActivityCount "\$handler_activity_count"/);
  assert.match(j, /timeout --kill-after=10s 90s adb -s "\$EMULATOR_SERIAL" exec-out cat "\$system_apk"/);
  assert.doesNotMatch(j, /adb[^\n]*pull "\$system_apk"/);
  assert.match(j, /test "\$remote_size" -gt 0 -a "\$remote_size" -le 268435456/);
  assert.match(j, /test "\$remote_name" = "\$system_apk"/);
  assert.match(j, /test "\$transfer_status" -eq 0/);
  assert.match(j, /test "\$local_size" = "\$remote_size"/);
  assert.match(j, /test "\$local_hash" = "\$remote_hash"/);
  assert.match(j, /test "\$\(timeout 10s adb -s "\$EMULATOR_SERIAL" get-state\)" = device/);
  assert.match(j, /timeout 10s adb -s "\$EMULATOR_SERIAL" emu avd name[^\n]*= "\$AVD_NAME"/);
  const validated = j.indexOf("printf 'validated=true");
  assert.ok(validated > j.indexOf('test "$local_hash" = "$remote_hash"'));
  assert.ok(j.indexOf('aapt2 dump badging') > validated);
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

function methodBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `Missing method signature: ${signature}`);
  const open = source.indexOf('{', signatureIndex + signature.length);
  assert.ok(open >= 0, `Missing method body: ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`Unclosed method body: ${signature}`);
}

function playbackSettingsObservation(d) {
  assert.equal((d.match(/UiObject2 playbackSettings = waitForRefreshedPlaybackSettings\(\);/g) ?? []).length, 1);
  assert.match(d, /MEDIA_WAIT_MS = 60_000/);
  assert.match(d, /PLAYER_DIALOG_LABEL =\s*\n?\s*"Playing Synthetic Fixture Movie \(2026\)"/);
  assert.match(d, /PLAYBACK_SETTINGS_LABEL = "Playback settings"/);
  const body = methodBody(d, 'private UiObject2 waitForRefreshedPlaybackSettings()');
  assert.match(body, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/);
  assert.match(body, /long deadline = SystemClock\.uptimeMillis\(\) \+ MEDIA_WAIT_MS/);
  assert.match(body, /boolean revealTapPerformed = false/);
  assert.match(body, /instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*assertNoOutOfScopeApproval\(\)/);
  assert.match(body, /UiObject2 playerDialog = findUniqueExactProductDialog\(PLAYER_DIALOG_LABEL\);\s*if \(playerDialog == null \|\| !hasVisibleBounds\(playerDialog\)\) \{\s*SystemClock\.sleep\(250\);\s*continue;/);
  assert.doesNotMatch(body, /requireUniqueExactProductDialog\(\s*PLAYER_DIALOG_LABEL/);
  assert.match(body, /findLabeledClickableWithin\(\s*playerDialog, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL\)/);
  assert.match(body, /if \(found != null && hasVisibleBounds\(found\)\) \{\s*assertVisibleBounds\(found, PLAYBACK_SETTINGS_LABEL\);\s*return found;/);
  assert.match(body, /if \(!revealTapPerformed\) \{\s*playerDialog\.click\(\);\s*revealTapPerformed = true;/);
  assert.equal((body.match(/playerDialog\.click\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(body, /device\.click|capture\(/);
}

function playbackSettingsPanelObservation(d) {
  assert.match(d, /EXTERNAL_PLAYER_LABEL =\s*\n?\s*"Open in external player Choose VLC or another installed video app"/);
  const runFlow = methodBody(d, 'private void runFlow()');
  assert.match(runFlow, /transition\("production-player-visible"\);\s*capture\("production-player"\);\s*UiObject2 playbackSettings = waitForRefreshedPlaybackSettings\(\);\s*clickObservedControlImmediately\(playbackSettings, PLAYBACK_SETTINGS_LABEL\);/);
  const capturePlayer = runFlow.indexOf('capture("production-player")');
  const acquireButton = runFlow.indexOf('waitForRefreshedPlaybackSettings()');
  const clickButton = runFlow.indexOf('clickObservedControlImmediately(playbackSettings, PLAYBACK_SETTINGS_LABEL)');
  const requirePanel = runFlow.indexOf('waitForUniquePlaybackSettingsDialog()');
  const capturePanel = runFlow.indexOf('capture("playback-settings-panel")');
  const scopedScroll = runFlow.indexOf('scrollPlaybackSettingsUntilLabeledClickable(');
  const captureExternal = runFlow.indexOf('capture("external-control-visible")');
  assert.ok(capturePlayer < acquireButton && acquireButton < clickButton);
  assert.ok(clickButton < requirePanel && requirePanel < capturePanel && capturePanel < scopedScroll);
  assert.ok(scopedScroll < captureExternal);
  assert.match(runFlow, /scrollPlaybackSettingsUntilLabeledClickable\(\s*EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL\)/);
  assert.doesNotMatch(runFlow, /scrollUntilLabeledClickable\(\s*(?:"Open in external player"|EXTERNAL_PLAYER_LABEL)/);

  const scopedLabel = methodBody(d, 'private UiObject2 findLabeledClickableWithin(');
  assert.match(scopedLabel, /Pattern labelPattern = exactLabel\(label\)/);
  assert.match(scopedLabel, /boundary\.findObjects\(By\.text\(labelPattern\)\)/);
  assert.match(scopedLabel, /boundary\.findObjects\(By\.desc\(labelPattern\)\)/);
  assert.match(scopedLabel, /if \(candidates\.size\(\) > 1\)/);

  const immediateClick = methodBody(d, 'private void clickObservedControlImmediately(');
  assert.equal((immediateClick.match(/object\.click\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(immediateClick, /assertNoOutOfScopeApproval|capture\(|SystemClock\.sleep|isClickable\(|isEnabled\(|getVisibleBounds/);

  const dialogFinder = methodBody(d, 'private UiObject2 findUniqueExactProductDialog(String label)');
  assert.match(dialogFinder, /By\.clazz\("android\.app\.Dialog"\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.text\(exactLabel\(label\)\)/);
  assert.match(dialogFinder, /if \(dialogs\.size\(\) > 1\)/);

  const waitDialog = methodBody(d, 'private UiObject2 waitForUniquePlaybackSettingsDialog()');
  assert.match(waitDialog, /instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*assertNoOutOfScopeApproval\(\)/);
  assert.match(waitDialog, /findUniqueExactProductDialog\(PLAYBACK_SETTINGS_LABEL\)/);
  assert.match(waitDialog, /assertVisibleBounds\(dialog, "Playback settings dialog"\)/);

  const scoped = methodBody(d, 'private UiObject2 scrollPlaybackSettingsUntilLabeledClickable(');
  assert.match(scoped, /for \(int attempt = 0; attempt < 12; attempt\+\+\)/);
  assert.match(scoped, /instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*assertNoOutOfScopeApproval\(\)/);
  assert.match(scoped, /requireUniqueExactProductDialog\(\s*PLAYBACK_SETTINGS_LABEL, "Playback settings dialog"\)/);
  assert.match(scoped, /findLabeledClickableWithin\(dialog, label, description\)/);
  assert.match(scoped, /if \(found != null && hasVisibleBounds\(found\)\) \{\s*assertVisibleBounds\(found, description\);\s*return found;/);
  assert.match(scoped, /findUniqueScrollableWithin\(dialog, description\)/);
  assert.doesNotMatch(scoped, /findLabeledClickable\(label\)|device\.findObject\(\s*By\.scrollable/);

  const scrollable = methodBody(d, 'private UiObject2 findUniqueScrollableWithin(');
  assert.match(scrollable, /if \(dialog\.isScrollable\(\)\) candidates\.add\(dialog\)/);
  assert.match(scrollable, /dialog\.findObjects\(\s*By\.scrollable\(true\)\.pkg\(PRODUCT_PACKAGE\)\)/);
  assert.match(scrollable, /1,\s*candidates\.size\(\)/);
  assert.doesNotMatch(scrollable, /device\.findObject|device\.findObjects/);
}

function driverContract(d) {
  playbackSettingsObservation(d);
  playbackSettingsPanelObservation(d);
  assert.equal((d.match(/openPlayer\.click\(\)/g) ?? []).length, 1);
  assert.match(d, /waitFor\(By\.text\(FIXTURE_ORIGIN_MESSAGE\)/);
  assert.match(d, /checks\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /receipt\.put\("decodedPlaybackClaimed", false\)/);
  assert.match(d, /Pattern\.CASE_INSENSITIVE \| Pattern\.UNICODE_CASE/);
  assert.match(d, /Pattern\.quote\(label\)/);
  assert.match(d, /Connect to a server Already have a server or an invite link\? Paste the address and sign in\./);
  assert.match(d, /clickLabeled\(CONNECT_SERVER_LABEL, "combined Connect to a server card", UI_WAIT_MS\)/);
  assert.match(d, /1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H\.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown/);
  assert.match(d, /scrollUntilLabeledClickable\(SOURCE_CONTROL_LABEL, "synthetic source"\)/);
  assert.match(d, /device\.findObjects\(By\.text\(labelPattern\)\)/);
  assert.match(d, /device\.findObjects\(By\.desc\(labelPattern\)\)/);
  assert.match(d, /Ambiguous/);
  assert.match(d, /handler-playback-t1/);
  assert.match(d, /handler-playback-t2/);
  assert.match(d, /handler-after-seek/);
  assert.match(d, /device\.pressBack\(\);\s*waitForForegroundPackage\(PRODUCT_PACKAGE/);
  assert.match(d, /SYSTEM_UI_PACKAGE = "com\.android\.systemui"/);
  assert.match(d, /FULLSCREEN_TIP_TITLE = "Viewing full screen"/);
  assert.match(d, /FULLSCREEN_TIP_DESCRIPTION =\s*\n?\s*"To exit, swipe down from the top of your screen"/);
  assert.match(d, /FULLSCREEN_TIP_BUTTON = "Got it"/);
  assert.match(d, /DIRECT_HANDLER_PACKAGE = "com\.google\.android\.apps\.photos"/);
  assert.match(d, /DIRECT_HANDLER_ACTIVITY =\s*\n?\s*"com\.google\.android\.apps\.photos\.pager\.HostPhotoPagerActivity"/);
  assert.match(d, /checks\.put\("realAndroidChooserObserved", false\)/);
  assert.match(d, /checks\.put\("soleHandlerDirectLaunchObserved", false\)/);
  assert.match(d, /realAndroidChooserObserved \^ soleHandlerDirectLaunchObserved/);
  assert.match(d, /hasCompleteHandlerMetadata\(\s*handlerLabel,\s*handlerPackage,\s*handlerActivity,\s*handlerActivityCountValue\)/);
  const metadata = methodBody(d, 'private static boolean hasCompleteHandlerMetadata(');
  assert.match(metadata, /boolean noneProvided = label\.isEmpty\(\)\s*&& packageName\.isEmpty\(\)\s*&& activity\.isEmpty\(\)\s*&& activityCount\.isEmpty\(\)/);
  assert.match(metadata, /boolean allProvided = !label\.isEmpty\(\)\s*&& !packageName\.isEmpty\(\)\s*&& !activity\.isEmpty\(\)\s*&& !activityCount\.isEmpty\(\)/);
  assert.match(metadata, /return noneProvided \|\| allProvided/);
  const resolver = methodBody(d, 'private void resolveExternalDestination()');
  assert.match(resolver, /long deadline = SystemClock\.uptimeMillis\(\) \+ SHORT_WAIT_MS/);
  assert.match(resolver, /while \(SystemClock\.uptimeMillis\(\) < deadline\)/);
  assert.match(resolver, /UiObject2 chooser = findTextOrDescription\("Open external player"\)/);
  assert.match(resolver, /realAndroidChooserObserved = true/);
  assert.match(resolver, /UiObject2 fullscreenTipButton = findExactFullscreenTipButton\(\)/);
  assert.match(resolver, /UiObject2 handler = chooser == null \? null : findLabeledClickable\(handlerLabel\)/);
  assert.doesNotMatch(resolver, /assertNotNull\("The chooser did not expose/);
  assert.match(resolver, /chooseExternalDestinationAction\(/);
  assert.match(resolver, /assertNoOutOfScopeApproval\(\);\s*capture\("nonbinding-fullscreen-tip"\);\s*fullscreenTipButton\.click\(\)/);
  assert.equal((resolver.match(/fullscreenTipButton\.click\(\)/g) ?? []).length, 1);
  assert.match(resolver, /soleHandlerDirectLaunchObserved = true/);
  const action = methodBody(d, 'private static String chooseExternalDestinationAction(');
  assert.match(action, /if \(exactFullscreenTipVisible\) \{\s*return fullscreenTipDismissed \? "wait" : "dismiss-fullscreen-tip";/);
  assert.match(action, /if \(chooserVisible && chooserHandlerVisible\) return "select-chooser-handler"/);
  assert.match(action, /!chooserVisible\s*&& !anyFullscreenTipResourceVisible\s*&& soleDirectAdmission\s*&& expectedHandlerForeground/);
  const directAdmission = methodBody(d, 'private boolean isSolePhotosDirectLaunchAdmission()');
  assert.match(directAdmission, /handlerActivityCount == 1/);
  assert.match(directAdmission, /DIRECT_HANDLER_PACKAGE\.equals\(handlerPackage\)/);
  assert.match(directAdmission, /DIRECT_HANDLER_ACTIVITY\.equals\(handlerActivity\)/);
  const fullscreenTip = methodBody(d, 'private UiObject2 findExactFullscreenTipButton()');
  assert.match(fullscreenTip, /By\.res\(SYSTEM_UI_PACKAGE, "immersive_cling_title"\)\s*\.pkg\(SYSTEM_UI_PACKAGE\)\s*\.text\(exactLabel\(FULLSCREEN_TIP_TITLE\)\)/);
  assert.match(fullscreenTip, /By\.res\(SYSTEM_UI_PACKAGE, "immersive_cling_description"\)\s*\.pkg\(SYSTEM_UI_PACKAGE\)\s*\.text\(exactLabel\(FULLSCREEN_TIP_DESCRIPTION\)\)/);
  assert.match(fullscreenTip, /By\.res\(SYSTEM_UI_PACKAGE, "ok"\)\s*\.pkg\(SYSTEM_UI_PACKAGE\)\s*\.text\(exactLabel\(FULLSCREEN_TIP_BUTTON\)\)\s*\.clazz\("android\.widget\.Button"\)\s*\.clickable\(true\)\s*\.enabled\(true\)/);
  assert.match(fullscreenTip, /assertEquals\("Expected one exact fullscreen tip button", 1, buttons\.size\(\)\)/);
  assert.match(fullscreenTip, /assertVisibleBounds\(button, "fullscreen tip button"\)/);
  assert.doesNotMatch(d, /evaluateJavascript|executeShellCommand|grantRuntimePermission|shared_prefs/);
}

test('external job preserves immutable transport, narrow authority and honest receipts', () => workflowContract(workflow, job));
test('fixture preserves isolated output, bounded live receipts and visible-time media', () => fixtureContract(fixture));
test('driver uses one origin consent and leaves decoding to runtime review', () => driverContract(driver));

for (const [name, mutate, contract, original] of [
  ['APK hash', s => s.replace('PRODUCT_SHA256: f3e983', 'PRODUCT_SHA256: a3e983'), s => workflowContract(workflow, s), job],
  ['engine minimum', s => s.replace('minimum_major=90', 'minimum_major=0'), s => workflowContract(workflow, s), job],
  ['installed bytes', s => s.replace('test "$installed_sha" = "$PRODUCT_SHA256"', ':'), s => workflowContract(workflow, s), job],
  ['handler transfer timeout', s => s.replace('timeout --kill-after=10s 90s adb', 'adb'), s => workflowContract(workflow, s), job],
  ['handler size bound', s => s.replace('test "$remote_size" -gt 0 -a "$remote_size" -le 268435456', ':'), s => workflowContract(workflow, s), job],
  ['handler remote path binding', s => s.replace('test "$remote_name" = "$system_apk"', ':'), s => workflowContract(workflow, s), job],
  ['handler transfer exit', s => s.replace('test "$transfer_status" -eq 0', ':'), s => workflowContract(workflow, s), job],
  ['handler size equality', s => s.replace('test "$local_size" = "$remote_size"', ':'), s => workflowContract(workflow, s), job],
  ['handler hash equality', s => s.replace('test "$local_hash" = "$remote_hash"', ':'), s => workflowContract(workflow, s), job],
  ['handler live device', s => s.replace('get-state)" = device', 'get-state)" = offline'), s => workflowContract(workflow, s), job],
  ['handler same AVD', s => s.replace(/(timeout 10s adb -s "\$EMULATOR_SERIAL" emu avd name[^\n]*= )"\$AVD_NAME"/, '$1"other-avd"'), s => workflowContract(workflow, s), job],
  ['fourth third-party install', s => s + '\n          adb -s "$EMULATOR_SERIAL" install "third-party.apk"\n', s => workflowContract(workflow, s), job],
  ['alternate package install', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell cmd package install third-party.apk\n', s => workflowContract(workflow, s), job],
  ['alternate package grant', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell cmd package grant some.pkg android.permission.INTERNET\n', s => workflowContract(workflow, s), job],
  ['appops permission change', s => s + '\n          adb -s "$EMULATOR_SERIAL" shell appops set some.pkg MANAGE_EXTERNAL_STORAGE allow\n', s => workflowContract(workflow, s), job],
  ['wrong fullscreen overlay package', s => s.replace('SYSTEM_UI_PACKAGE = "com.android.systemui"', 'SYSTEM_UI_PACKAGE = "com.example.overlay"'), driverContract, driver],
  ['wrong fullscreen overlay title', s => s.replace('FULLSCREEN_TIP_TITLE = "Viewing full screen"', 'FULLSCREEN_TIP_TITLE = "Full screen"'), driverContract, driver],
  ['wrong sole direct package', s => s.replace('DIRECT_HANDLER_PACKAGE = "com.google.android.apps.photos"', 'DIRECT_HANDLER_PACKAGE = "com.example.video"'), driverContract, driver],
  ['multiple handlers admitted as direct', s => s.replace('handlerActivityCount == 1', 'handlerActivityCount >= 1'), driverContract, driver],
  ['direct launch bypasses host metadata', s => s.replace('                && soleDirectAdmission\n                && expectedHandlerForeground', '                && expectedHandlerForeground'), driverContract, driver],
  ['false chooser and direct receipt coexist', s => s.replace('realAndroidChooserObserved ^ soleHandlerDirectLaunchObserved', 'realAndroidChooserObserved || soleHandlerDirectLaunchObserved'), driverContract, driver],
  ['partial handler metadata admitted', s => s.replace('                && !activity.isEmpty()\n                && !activityCount.isEmpty()', '                && !activityCount.isEmpty()'), driverContract, driver],
  ['disabled fullscreen tip button admitted', s => s.replace('                        .clickable(true)\n                        .enabled(true));', '                        .clickable(true));'), driverContract, driver],
  ['already dismissed fullscreen tip clicked again', s => s.replace('return fullscreenTipDismissed ? "wait" : "dismiss-fullscreen-tip";', 'return "dismiss-fullscreen-tip";'), driverContract, driver],
  ['unbounded destination resolver', s => s.replace('while (SystemClock.uptimeMillis() < deadline)', 'while (true)'), driverContract, driver],
  ['native button case', s => s.replace('Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE', 'Pattern.UNICODE_CASE'), driverContract, driver],
  ['refreshed settings callsite', s => s.replace('UiObject2 playbackSettings = waitForRefreshedPlaybackSettings();', 'UiObject2 playbackSettings = waitForLabeledClickable("Playback settings", MEDIA_WAIT_MS, "Playback settings");'), driverContract, driver],
  ['settings refresh API guard', s => s.replace('Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE', 'true'), driverContract, driver],
  ['settings cache refresh result', s => s.replace('instrumentation.getUiAutomation().clearCache());', 'true);'), driverContract, driver],
  ['settings cache refresh ordering', s => s.replace('            assertTrue(\n                    "Accessibility cache refresh failed",\n                    instrumentation.getUiAutomation().clearCache());\n            assertNoOutOfScopeApproval();', '            assertNoOutOfScopeApproval();\n            assertTrue(\n                    "Accessibility cache refresh failed",\n                    instrumentation.getUiAutomation().clearCache());'), driverContract, driver],
  ['settings refresh exact label', s => s.replace('PLAYBACK_SETTINGS_LABEL = "Playback settings"', 'PLAYBACK_SETTINGS_LABEL = "Settings"'), driverContract, driver],
  ['settings observation input replay', s => s.replace('UiObject2 found = findLabeledClickableWithin(', 'device.click(500, 500);\n            UiObject2 found = findLabeledClickableWithin('), driverContract, driver],
  ['settings deadline relaxation', s => s.replace('MEDIA_WAIT_MS = 60_000', 'MEDIA_WAIT_MS = 600_000'), driverContract, driver],
  ['player capture after settings acquisition', s => s.replace('capture("production-player");\n        UiObject2 playbackSettings = waitForRefreshedPlaybackSettings();', 'UiObject2 playbackSettings = waitForRefreshedPlaybackSettings();\n        capture("production-player");'), driverContract, driver],
  ['player dialog readiness fail-fast', s => s.replace('UiObject2 playerDialog = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);', 'UiObject2 playerDialog = requireUniqueExactProductDialog(PLAYER_DIALOG_LABEL, "playing movie dialog");'), driverContract, driver],
  ['invisible player dialog reveal', s => s.replace('playerDialog == null || !hasVisibleBounds(playerDialog)', 'false'), driverContract, driver],
  ['repeated conditional reveal tap', s => s.replace('if (!revealTapPerformed)', 'if (true)'), driverContract, driver],
  ['unscoped playing dialog', s => s.replace('.pkg(PRODUCT_PACKAGE)\n                        .text(exactLabel(label))', '.text(exactLabel(label))'), driverContract, driver],
  ['settings dialog admission removed', s => s.replace('waitForUniquePlaybackSettingsDialog();', 'waitForTextOrDescription(PLAYBACK_SETTINGS_LABEL, SHORT_WAIT_MS, PLAYBACK_SETTINGS_LABEL);'), driverContract, driver],
  ['settings panel capture moved after scroll', s => s.replace('capture("playback-settings-panel");\n        UiObject2 external = scrollPlaybackSettingsUntilLabeledClickable(', 'UiObject2 external = scrollPlaybackSettingsUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL);\n        capture("playback-settings-panel");\n        UiObject2 ignoredExternal = scrollPlaybackSettingsUntilLabeledClickable('), driverContract, driver],
  ['settings scroll escapes dialog', s => s.replace('dialog.findObjects(\n                By.scrollable(true).pkg(PRODUCT_PACKAGE))', 'device.findObjects(\n                By.scrollable(true).pkg(PRODUCT_PACKAGE))'), driverContract, driver],
  ['generic external-control fallback', s => s.replace('scrollPlaybackSettingsUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL)', 'scrollUntilLabeledClickable(\n                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL)'), driverContract, driver],
  ['settings visible-bounds admission removed', s => s.replace('found != null && hasVisibleBounds(found)', 'found != null'), driverContract, driver],
  ['external action label shortened', s => s.replace('Open in external player Choose VLC or another installed video app', 'Open in external player'), driverContract, driver],
  ['dialog-scoped label made inexact', s => s.replace('Pattern labelPattern = exactLabel(label);', 'Pattern labelPattern = Pattern.compile(label);'), driverContract, driver],
  ['shortened connect label', s => s.replace('Connect to a server Already have a server or an invite link? Paste the address and sign in.', 'Connect to a server'), driverContract, driver],
  ['unused connect label', s => s.replace('clickLabeled(CONNECT_SERVER_LABEL,', 'clickLabeled("Connect to a server",'), driverContract, driver],
  ['shortened source label', s => s.replace('1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown', '1080p Synthetic Fixture Movie 2026'), driverContract, driver],
  ['unused source label', s => s.replace('scrollUntilLabeledClickable(SOURCE_CONTROL_LABEL,', 'scrollUntilLabeledClickable("1080p Synthetic Fixture Movie 2026",'), driverContract, driver],
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

function enginePolicy(code, providerDump) {
  const evidence = mkdtempSync(join(tmpdir(), 'yawf-external-engine-'));
  writeFileSync(join(evidence, 'stock-webview.txt'), providerDump);
  return spawnSync('python3', ['-c', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: {...process.env, EVIDENCE: evidence},
  });
}

function handlerPolicy(code, handlerDump) {
  const evidence = mkdtempSync(join(tmpdir(), 'yawf-external-handler-'));
  writeFileSync(join(evidence, 'stock-video-handlers.txt'), handlerDump);
  const execution = spawnSync('python3', ['-c', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: {...process.env, EVIDENCE: evidence},
  });
  const receipt = execution.status === 0
    ? JSON.parse(readFileSync(join(evidence, 'stock-handler-query-admission.json'), 'utf8'))
    : null;
  return {execution, receipt};
}

function destinationReceiptPolicy(code, checks) {
  return spawnSync('python3', ['-c', `import json,os\nchecks=json.loads(os.environ['CHECKS'])\n${code}`], {
    encoding: 'utf8', env: {...process.env, CHECKS: JSON.stringify(checks)},
  });
}

test('executes strict boolean XOR destination receipt validation', () => {
  const code = job.split('# BEGIN EXTERNAL_DESTINATION_RECEIPT_POLICY\n')[1].split('# END EXTERNAL_DESTINATION_RECEIPT_POLICY')[0]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  assert.equal(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: true, soleHandlerDirectLaunchObserved: false,
  }).status, 0);
  assert.equal(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: false, soleHandlerDirectLaunchObserved: true,
  }).status, 0);
  assert.notEqual(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: 'false', soleHandlerDirectLaunchObserved: false,
  }).status, 0);
  assert.notEqual(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: false, soleHandlerDirectLaunchObserved: false,
  }).status, 0);
  assert.notEqual(destinationReceiptPolicy(code, {
    realAndroidChooserObserved: true, soleHandlerDirectLaunchObserved: true,
  }).status, 0);
});

function resolverPolicyProbe(source) {
  const body = methodBody(source, 'private static String chooseExternalDestinationAction(');
  const metadataBody = methodBody(source, 'private static boolean hasCompleteHandlerMetadata(');
  const directory = mkdtempSync(join(tmpdir(), 'yawf-external-resolver-'));
  const javaSource = `public final class ResolverPolicyProbe {
    private static String chooseExternalDestinationAction(
        boolean chooserVisible,
        boolean chooserHandlerVisible,
        boolean exactFullscreenTipVisible,
        boolean anyFullscreenTipResourceVisible,
        boolean fullscreenTipDismissed,
        boolean soleDirectAdmission,
        boolean expectedHandlerForeground) {${body}}
    private static boolean hasCompleteHandlerMetadata(
        String label, String packageName, String activity, String activityCount) {${metadataBody}}
    private static void expect(String expected, String actual) {
      if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual);
    }
    public static void main(String[] args) {
      expect("dismiss-fullscreen-tip", chooseExternalDestinationAction(false, false, true, true, false, true, true));
      expect("wait", chooseExternalDestinationAction(false, false, true, true, true, true, true));
      expect("wait", chooseExternalDestinationAction(false, false, false, true, false, true, true));
      expect("wait", chooseExternalDestinationAction(false, false, false, false, false, false, true));
      expect("accept-sole-handler-direct-launch", chooseExternalDestinationAction(false, false, false, false, false, true, true));
      expect("wait", chooseExternalDestinationAction(true, false, false, false, false, true, true));
      expect("select-chooser-handler", chooseExternalDestinationAction(true, true, false, false, false, false, false));
      if (!hasCompleteHandlerMetadata("", "", "", "")) throw new AssertionError("empty metadata rejected");
      if (!hasCompleteHandlerMetadata("Photos", "com.google.android.apps.photos", "com.google.android.apps.photos.Player", "1")) throw new AssertionError("complete metadata rejected");
      if (hasCompleteHandlerMetadata("", "com.google.android.apps.photos", "com.google.android.apps.photos.Player", "1")) throw new AssertionError("missing label admitted");
      if (hasCompleteHandlerMetadata("Photos", "", "com.google.android.apps.photos.Player", "1")) throw new AssertionError("missing package admitted");
      if (hasCompleteHandlerMetadata("Photos", "com.google.android.apps.photos", "", "1")) throw new AssertionError("missing activity admitted");
      if (hasCompleteHandlerMetadata("Photos", "com.google.android.apps.photos", "com.google.android.apps.photos.Player", "")) throw new AssertionError("missing count admitted");
    }
  }`;
  const file = join(directory, 'ResolverPolicyProbe.java');
  writeFileSync(file, javaSource);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome ? join(javaHome, 'bin', 'javac') : 'javac';
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const compile = spawnSync(javac, ['-d', directory, file], {encoding: 'utf8'});
  if (compile.status !== 0) return compile;
  return spawnSync(java, ['-cp', directory, 'ResolverPolicyProbe'], {encoding: 'utf8'});
}

test('executes the actual destination state policy and kills unsafe state mutants', () => {
  assert.equal(resolverPolicyProbe(driver).status, 0);
  const repeatedTip = driver.replace(
    'return fullscreenTipDismissed ? "wait" : "dismiss-fullscreen-tip";',
    'return "dismiss-fullscreen-tip";');
  assert.notEqual(repeatedTip, driver);
  assert.notEqual(resolverPolicyProbe(repeatedTip).status, 0);
  const noMetadata = driver.replace(
    '                && soleDirectAdmission\n                && expectedHandlerForeground',
    '                && expectedHandlerForeground');
  assert.notEqual(noMetadata, driver);
  assert.notEqual(resolverPolicyProbe(noMetadata).status, 0);
  const chooserBypass = driver.replace('if (!chooserVisible', 'if (true');
  assert.notEqual(chooserBypass, driver);
  assert.notEqual(resolverPolicyProbe(chooserBypass).status, 0);
  const partialMetadata = driver.replace(
    '                && !activity.isEmpty()\n                && !activityCount.isEmpty()',
    '                && !activityCount.isEmpty()');
  assert.notEqual(partialMetadata, driver);
  assert.notEqual(resolverPolicyProbe(partialMetadata).status, 0);
});

test('executes exact sole Photos direct-launch admission with negative controls', () => {
  const code = job.split('# BEGIN EXTERNAL_STOCK_HANDLER_POLICY\n')[1].split('# END EXTERNAL_STOCK_HANDLER_POLICY')[0]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const photos = '  com.google.android.apps.photos/.pager.HostPhotoPagerActivity\n';
  const admitted = handlerPolicy(code,
    `1 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n${photos}`);
  assert.equal(admitted.execution.status, 0);
  assert.equal(admitted.receipt.activityCount, 1);
  assert.equal(admitted.receipt.solePhotosDirectLaunchEligible, true);

  const wrongPackage = handlerPolicy(code,
    '1 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n  com.example.video/.PlayerActivity\n');
  assert.equal(wrongPackage.execution.status, 0);
  assert.equal(wrongPackage.receipt.activityCount, 1);
  assert.equal(wrongPackage.receipt.solePhotosDirectLaunchEligible, false);

  const multiple = handlerPolicy(code,
    `2 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n${photos}  Activity #1:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n  com.example.video/._PlayerActivity\n`);
  assert.equal(multiple.execution.status, 0);
  assert.equal(multiple.receipt.activityCount, 2);
  assert.equal(multiple.receipt.solePhotosDirectLaunchEligible, false);

  const wrongActivity = handlerPolicy(code,
    '1 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n  com.google.android.apps.photos/.WrongActivity\n');
  assert.equal(wrongActivity.execution.status, 0);
  assert.equal(wrongActivity.receipt.solePhotosDirectLaunchEligible, false);

  const countMismatch = handlerPolicy(code,
    `2 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n${photos}`);
  assert.notEqual(countMismatch.execution.status, 0);

  const malformed = handlerPolicy(code,
    '1 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n  com.google.android.apps.photos/.Bad-Activity\n');
  assert.notEqual(malformed.execution.status, 0);

  const malformedSegments = handlerPolicy(code,
    '1 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n  com.google.android.apps.photos/.pager..HostPhotoPagerActivity\n');
  assert.notEqual(malformedSegments.execution.status, 0);

  const duplicate = handlerPolicy(code,
    `2 activities found:\n  Activity #0:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n${photos}  Activity #1:\n    priority=0 preferredOrder=0 match=0x608000 specificIndex=-1 isDefault=true\n${photos}`);
  assert.notEqual(duplicate.execution.status, 0);

  const falseEmpty = handlerPolicy(code, `No activities found\n${photos}`);
  assert.notEqual(falseEmpty.execution.status, 0);

  const unknown = handlerPolicy(code,
    `1 activities found:\n  Activity #0:\n    unexpected=true\n${photos}`);
  assert.notEqual(unknown.execution.status, 0);
});

test('executes the actual minimum-engine admission before native UI', () => {
  const code = job.split('# BEGIN EXTERNAL_STOCK_WEBVIEW_POLICY\n')[1].split('# END EXTERNAL_STOCK_WEBVIEW_POLICY')[0]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const dump = version => `Current WebView package (name, version): (com.google.android.webview, ${version})`;
  assert.equal(enginePolicy(code, dump('133.0.6943.49')).status, 0);
  assert.notEqual(enginePolicy(code, dump('83.0.4103.106')).status, 0);
  assert.notEqual(enginePolicy(code, dump('133.0.6943.49').replace('com.google.android.webview','unexpected.webview')).status, 0);
  assert.notEqual(enginePolicy(code, 'provider unavailable').status, 0);
  const mutant = code.replace('minimum_major=90','minimum_major=0');
  assert.notEqual(mutant, code);
  assert.equal(enginePolicy(mutant, dump('83.0.4103.106')).status, 0, 'Floor-removal mutant must visibly admit the rejected engine');
});
