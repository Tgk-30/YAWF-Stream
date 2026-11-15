import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./android-owned-destroy-instrumentation/', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('API linkage is checksum-bound compile-only JAR, never packaged AAR or implementation', async () => {
  const gradle = await read('app/build.gradle.kts');
  const readme = await read('README.md');
  const digestImportContract = (source) => /^import java\.security\.MessageDigest$/m.test(source) &&
    /val digest = MessageDigest\.getInstance\("SHA-256"\)/.test(source) &&
    !/val digest = java\.security\./.test(source);
  assert.equal(digestImportContract(gradle), true);
  assert.equal(digestImportContract(gradle.replace('MessageDigest.getInstance', 'java.security.MessageDigest.getInstance')), false);
  assert.match(gradle, /TAURI_ANDROID_API_CLASSES_JAR_REQUIRED/);
  assert.match(gradle, /TAURI_ANDROID_API_CLASSES_JAR_SHA256_REQUIRED/);
  assert.match(gradle, /TAURI_ANDROID_API_SOURCE_RECEIPT_REQUIRED/);
  assert.match(gradle, /compileOnly\(files\(apiClassesJar\)\)/);
  assert.match(gradle, /androidTestCompileOnly\(files\(apiClassesJar\)\)/);
  assert.match(gradle, /add\(publicApiSignatures\.name, "androidx\.appcompat:appcompat:1\.6\.0"\)/);
  const compileOnlyLines = (source) => source.split('\n')
    .filter((line) => /^\s*(?:androidTest)?[cC]ompileOnly\s*\(/.test(line))
    .map((line) => line.trim());
  const exactLocalJarInputs = (source) => JSON.stringify(compileOnlyLines(source)) === JSON.stringify([
    'compileOnly(files(apiClassesJar))',
    'androidTestCompileOnly(files(apiClassesJar))',
    'androidTestCompileOnly(publicApiSignatureClasspath)',
  ]);
  assert.equal(exactLocalJarInputs(gradle), true);
  assert.equal(exactLocalJarInputs(gradle.replace(
    'androidTestCompileOnly(files(apiClassesJar))',
    'androidTestCompileOnly("androidx.appcompat:appcompat:1.6.0")'
  )), false);
  assert.equal(exactLocalJarInputs(gradle.replace(
    'compileOnly(files(apiClassesJar))',
    'compileOnly(project(":tauri-android"))'
  )), false);
  assert.equal(exactLocalJarInputs(gradle.replace(
    'androidTestCompileOnly(publicApiSignatureClasspath)',
    'androidTestCompileOnly(publicApiSignatures)'
  )), false);
  const hashBindingContract = (source) => /require\(digest == apiClassesJarSha256\)/.test(source) &&
    /TAURI_ANDROID_API_CLASSES_JAR_HASH_MISMATCH/.test(source);
  assert.equal(hashBindingContract(gradle), true);
  assert.match(gradle, /TAURI_ANDROID_API_SOURCE_HASHES_MISMATCH/);
  assert.doesNotMatch(gradle, /\bimplementation\s*\(/);
  assert.doesNotMatch(gradle, /compileOnly\s*\([^\n]*\.aar/i);
  assert.match(readme, /compiled `classes\.jar` contents/);
  assert.match(readme, /does not produce that JAR/);

  // Causal mutations: each required linkage guard must independently disappear
  // from the source contract if removed from the Gradle configuration.
  assert.doesNotMatch(gradle.replace('compileOnly(files(apiClassesJar))', ''), /compileOnly\(files\(apiClassesJar\)\)/);
  assert.equal(hashBindingContract(gradle.replace(
    'require(digest == apiClassesJarSha256) { "TAURI_ANDROID_API_CLASSES_JAR_HASH_MISMATCH" }', ''
  )), false);
});

test('instrumentation manifest is isolated and names the exact installed target', async () => {
  const gradle = await read('app/build.gradle.kts');
  const appManifest = await read('app/src/main/AndroidManifest.xml');
  const testManifest = await read('app/src/androidTest/AndroidManifest.xml');
  const runner = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyInstrumentationRunner.java');
  assert.match(appManifest, /<package android:name="com\.tgk30\.debridstreamer"\s*\/>/);
  assert.match(gradle, /applicationId = "com\.tgk30\.debridstreamer"/);
  assert.match(gradle, /testApplicationId = "com\.yawf\.ownedstartupinstrumentation\.test"/);
  assert.match(testManifest, /android:targetPackage="com\.tgk30\.debridstreamer"/);
  assert.match(runner, /TARGET_ACTIVITY\s*=\s*"com\.tgk30\.debridstreamer\.MainActivity"/);
  assert.match(runner, /super\.callActivityOnCreate\(activity, state\);[\s\S]*?getMethod\("getPluginManager"\)/);
  assert.match(runner, /targetPluginManager\.load\(null,/);
  assert.doesNotMatch(runner, /PluginManager\.INSTANCE/);
  assert.doesNotMatch(appManifest, /<uses-permission\b/);
  assert.doesNotMatch(testManifest, /android:targetPackage="[^"]*(instrumentation|ownedstartup)/);
});

test('fault is one-shot, first-map-order guarded, and retry is one physical tap only', async () => {
  const plugin = await read('app/src/androidTest/java/com/yawf/ownedstartup/FaultOncePlugin.java');
  const runner = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyInstrumentationRunner.java');
  const testSource = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  assert.match(testSource, /^import android\.app\.Instrumentation;$/m);
  const firstOrderContract = (source) => /if \(!isFirstPluginInLiveManagerMap\(\)\)/.test(source) &&
    /plugins\.entrySet\(\)\.stream\(\)\.findFirst\(\)/.test(source) &&
    /FAULT_PLUGIN_NAME\.equals\(entry\.getKey\(\)\)/.test(source) &&
    /uniquePluginInstance\(\(PluginHandle\) handle\) == this/.test(source) && /FAULT_NOT_FIRST/.test(source);
  assert.equal(firstOrderContract(plugin), true);
  assert.match(plugin, /ordinal == 1[\s\S]*?isFirstPluginInLiveManagerMap\(\)/);
  assert.match(plugin, /FAULT_NOT_FIRST/);
  assert.match(plugin, /throw new IllegalStateException\(FAULT_MARKER\)/);
  assert.match(plugin, /ordinal == 2/);
  assert.match(plugin, /PLUGIN_LOAD_COUNT_EXCEEDED/);
  assert.match(plugin, /FAULT_PLUGIN_NAME\.equals\(entry\.getKey\(\)\)/);
  assert.match(plugin, /Plugin\.class\.isAssignableFrom\(field\.getType\(\)\)/);
  assert.match(plugin, /uniquePluginInstance\(\(PluginHandle\) handle\) == this/);
  assert.match(plugin, /!plugins\.containsKey\(OwnedDestroyInstrumentationRunner\.FAULT_PLUGIN_NAME\)/);
  assert.match(runner, /FAULT_PLUGIN_NAME\s*=\s*""/);
  assert.match(runner, /if \(!faultPlugin\.registrationKeyAvailable\(\)\)[\s\S]*?targetPluginManager\.load\(null,/);
  assert.match(runner, /new FaultOncePlugin\(activity, this, targetPluginManager\)/);
  assert.match(plugin, /livePluginManagerMap\(PluginManager pluginManager\)/);
  assert.doesNotMatch(`${plugin}\n${runner}\n${testSource}`, /PluginManager\.INSTANCE|\.getMethod\("getInstance"\)|\.getMethod\("getLoaded"\)|\.getInstance\(\)|\.getLoaded\(\)/);
  assert.match(testSource, /Plugin\.class\.isAssignableFrom\(field\.getType\(\)\)/);
  assert.match(testSource, /field\.getType\(\) == boolean\.class/);
  assert.match(testSource, /livePluginManagerMap\(PluginManager pluginManager\)/);
  assert.match(testSource, /viewDetachedOnMain\(oldView\)/);
  assert.match(testSource, /readUniqueWryWebViewField\(activity\) == null/);
  assert.match(testSource, /readUniqueHelperAcceptedWebView\(activity\) == null/);
  assert.match(testSource, /tapCount\s*=\s*1/);
  assert.match(testSource, /sendPointerSync\(down\)[\s\S]*?sendPointerSync\(up\)/);
  assert.match(testSource, /current == activity/);
  assert.match(testSource, /currentFault\.loadCount\(\) == 2/);
  assert.match(testSource, /newView != null && newView != oldView/);
  assert.doesNotMatch(testSource, /\.performClick\s*\(/);
  assert.doesNotMatch(testSource, /while\s*\([^)]*tap|retryLoop/i);

  // Removing the live order check or allowing a third callback breaks the contract.
  assert.equal(firstOrderContract(plugin.replace('if (!isFirstPluginInLiveManagerMap()) {', 'if (true) {')), false);
  assert.equal(firstOrderContract(plugin.replace('uniquePluginInstance((PluginHandle) handle) == this', 'true')), false);
  const thirdLoadRefusal = (source) => /runner\.refuse\("PLUGIN_LOAD_COUNT_EXCEEDED"\)/.test(source) &&
    /throw new IllegalStateException\("PLUGIN_LOAD_COUNT_EXCEEDED"\)/.test(source);
  assert.equal(thirdLoadRefusal(plugin), true);
  assert.equal(thirdLoadRefusal(plugin.replace('runner.refuse("PLUGIN_LOAD_COUNT_EXCEEDED");', '')), false);
});

test('launch uses the public synchronous Instrumentation API exactly once', async () => {
  const testSource = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const launchContract = (source) => (source.match(/\.startActivitySync\(launch\)/g) ?? []).length === 1 &&
    !/\.startActivity\(launch\)/.test(source);
  assert.equal(launchContract(testSource), true);
  assert.match(testSource, /getLaunchIntentForPackage\(OwnedDestroyInstrumentationRunner\.TARGET_PACKAGE\)/);
  assert.match(testSource, /TARGET_ACTIVITY\.equals\(launch\.getComponent\(\)\.getClassName\(\)\)/);
  assert.equal(launchContract(testSource.replace('.startActivitySync(launch)', '.startActivity(launch)')), false);
});

test('one native gesture uses clipped screen coordinates, a real bounded hold and positive original-button input proof', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const controller = await readFile(new URL('./android_owned_startup_runtime.py', import.meta.url), 'utf8');
  const nativeTapContract = (code) => [
    'runner.targetActivity() == activity && runner.targetActivityCreateCount() == 1',
    'runner.targetPid() == android.os.Process.myPid()',
    '!activity.isFinishing() && !activity.isDestroyed() && activity.hasWindowFocus()',
    'matches.get(0) != button',
    '!button.hasOnClickListeners()',
    'root.getLocationOnScreen(rootScreenOffset);',
    'screenBounds.offset(rootScreenOffset[0], rootScreenOffset[1]);',
    'button.getLocationOnScreen(buttonScreenLocation);',
    'buttonScreenLocation[0] + button.getWidth(), buttonScreenLocation[1] + button.getHeight()',
    'screenBounds.intersect(buttonScreenBounds)',
    'this.screenBounds = new Rect(screenBounds)',
    'ViewConfiguration.getTapTimeout() + TAP_FRAME_MS',
    'ViewConfiguration.getLongPressTimeout()',
    'TAP_HOLD_MAX_MS = 200L',
    'SystemClock.sleep(holdMillis);',
    'long downTime = SystemClock.uptimeMillis();',
    'long upTime = SystemClock.uptimeMillis();',
    'MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0)',
    '\n                instrumentation.sendPointerSync(up);\n',
    'heldMillis >= holdMillis && heldMillis <= TAP_HOLD_MAX_MS && heldMillis < longPressMillis',
    'SystemClock.uptimeMillis() + holdMillis <= observationDeadline',
    'retryPressedObservationOutcome = retryPressedOnMain(tap, observationDeadline);',
    'retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome.PRESSED;',
    'currentBounds == null || !currentBounds.equals(tap.screenBounds)',
    ': tap.button.isPressed() ? PressedObservationOutcome.PRESSED : PressedObservationOutcome.UNPRESSED',
    'observed.await(remaining, TimeUnit.MILLISECONDS)',
    'if (SystemClock.uptimeMillis() <= deadlineUptime) result.set(value);',
    'RETRY_BUTTON_DETACH_DEADLINE_MS = 2_000L',
    'ownedFocusedActivityOnMain(tap.activity) && !tap.button.isAttachedToWindow()',
    'retryOriginalButtonDetachedAfterUp = awaitOriginalButtonDetachedAfterUp(tap);',
    'require(retryDownPressed, "RETRY_DOWN_NOT_OBSERVED_PRESSED");',
    'require(retryOriginalButtonDetachedAfterUp, "RETRY_ORIGINAL_BUTTON_NOT_DETACHED_AFTER_UP");',
    'evidence.put("retryDownPressed", retryDownPressed);',
    'evidence.put("retryOriginalButtonDetachedAfterUp", retryOriginalButtonDetachedAfterUp);',
  ].every((required) => code.includes(required)) &&
    (code.match(/MotionEvent\.ACTION_DOWN/g) ?? []).length === 1 &&
    (code.match(/MotionEvent\.ACTION_UP/g) ?? []).length === 1 &&
    (code.match(/\.sendPointerSync\(/g) ?? []).length === 2 &&
    (code.match(/sendExactlyOneTap\(instrumentation, tap\)/g) ?? []).length === 1 &&
    /retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome\.PRESSED;\s*\} else \{\s*retryPressedObservationOutcome = PressedObservationOutcome\.BUDGET_SKIPPED;\s*\}\s*\} finally \{\s*long upTime = SystemClock\.uptimeMillis\(\);[\s\S]*?instrumentation\.sendPointerSync\(up\)/.test(code) &&
    !/performClick|callOnClick|dispatchTouchEvent|UiAutomation|UiDevice|ACTION_MOVE|ACTION_CANCEL|setPressed\(/.test(code);
  assert.equal(nativeTapContract(source), true);
  for (const [from, to] of [
    ['screenBounds.offset(rootScreenOffset[0], rootScreenOffset[1]);', ''],
    ['screenBounds.intersect(buttonScreenBounds)', 'true'],
    ['SystemClock.sleep(holdMillis);', ''],
    ['SystemClock.uptimeMillis() + holdMillis <= observationDeadline', 'true'],
    ['MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0)',
      'MotionEvent.obtain(downTime, downTime + 80L, MotionEvent.ACTION_UP, x, y, 0)'],
    ['retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome.PRESSED;', 'retryDownPressed = true;'],
    ['ownedFocusedActivityOnMain(tap.activity) && !tap.button.isAttachedToWindow()', 'true'],
    ['require(retryDownPressed, "RETRY_DOWN_NOT_OBSERVED_PRESSED");', ''],
    ['require(retryOriginalButtonDetachedAfterUp, "RETRY_ORIGINAL_BUTTON_NOT_DETACHED_AFTER_UP");', ''],
    ['                instrumentation.sendPointerSync(up);', '                if (false) instrumentation.sendPointerSync(up);'],
    ['instrumentation.sendPointerSync(down);', 'instrumentation.sendPointerSync(down); instrumentation.sendPointerSync(down);'],
  ]) {
    assert.ok(source.includes(from));
    assert.equal(nativeTapContract(source.replace(from, to)), false);
  }
  const inputEvidenceContract = (code) => {
    const fields = code.match(/BOOL_FIELDS = \(([\s\S]*?)\n\)/)?.[1] ?? '';
    return fields.includes('"retryDownPressed"') && fields.includes('"retryOriginalButtonDetachedAfterUp"') &&
      code.includes('EVIDENCE_KEYS = set(BOOL_FIELDS)') &&
      code.includes('all(type(value[name]) is bool for name in BOOL_FIELDS)') &&
      code.includes('all(value[name] for name in BOOL_FIELDS)');
  };
  assert.equal(inputEvidenceContract(controller), true);
  for (const field of ['retryDownPressed', 'retryOriginalButtonDetachedAfterUp']) {
    assert.equal(inputEvidenceContract(controller.replace(`"${field}"`, '')), false);
  }
});

test('input diagnostics distinguish pending and negative observations without changing gesture admission', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const diagnosticContract = (code) => [
    'private Long retryDownCallElapsedMs;',
    'retryPressedObservationOutcome = PressedObservationOutcome.NOT_ATTEMPTED;',
    'long downCallStartedAt = SystemClock.uptimeMillis();',
    'retryDownCallElapsedMs = Math.min(TOTAL_DEADLINE_MS,',
    'Math.max(0L, SystemClock.uptimeMillis() - downCallStartedAt)',
    'retryPressedObservationOutcome = PressedObservationOutcome.BUDGET_SKIPPED;',
    'AtomicReference<PressedObservationOutcome> result = new AtomicReference<>();',
    'return value == null ? PressedObservationOutcome.OBSERVATION_TIMEOUT : value;',
    'currentBounds == null || !currentBounds.equals(tap.screenBounds)',
    'tap.button.isPressed() ? PressedObservationOutcome.PRESSED : PressedObservationOutcome.UNPRESSED',
    'result.set(PressedObservationOutcome.OBSERVATION_ERROR)',
    'evidence.put("retryDownCallElapsedMs", retryDownCallElapsedMs == null ? JSONObject.NULL : retryDownCallElapsedMs);',
    'evidence.put("retryPressedObservationOutcome", retryPressedObservationOutcome.wireValue);',
  ].every((required) => code.includes(required)) &&
    /try \{\s*instrumentation\.sendPointerSync\(down\);\s*\} finally \{[\s\S]*?retryDownCallElapsedMs = Math\.min/.test(code);
  assert.equal(diagnosticContract(source), true);
  const outcomes = source.match(/private enum PressedObservationOutcome \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.deepEqual([...outcomes.matchAll(/\b[A-Z_]+\("([a-z-]+)"\)/g)].map((match) => match[1]), [
    'not-attempted', 'budget-skipped', 'observation-timeout', 'state-mismatch', 'unpressed', 'pressed', 'observation-error',
  ]);
  for (const [from, to] of [
    ['private Long retryDownCallElapsedMs;', 'private long retryDownCallElapsedMs;'],
    ['return value == null ? PressedObservationOutcome.OBSERVATION_TIMEOUT : value;',
      'return value == null ? PressedObservationOutcome.UNPRESSED : value;'],
    ['retryPressedObservationOutcome = PressedObservationOutcome.BUDGET_SKIPPED;',
      'retryPressedObservationOutcome = PressedObservationOutcome.UNPRESSED;'],
    ['retryDownCallElapsedMs = Math.min(TOTAL_DEADLINE_MS,', 'retryDownCallElapsedMs = Math.max(TOTAL_DEADLINE_MS,'],
  ]) {
    assert.ok(source.includes(from));
    assert.equal(diagnosticContract(source.replace(from, to)), false);
  }
});

test('reported artifact is fixed-schema, redacted, and scoped to this selected retry only', async () => {
  const testSource = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const readme = await read('README.md');
  assert.match(testSource, /scope", "selected_first_plugin_load_failure_then_one_native_retry"/);
  assert.match(testSource, /failureCode = phase \+ "_FAILED"/);
  assert.doesNotMatch(testSource, /error\.getMessage\(\)|getTitle\(|getUrl\(|screenshot|credential|token/i);
  assert.match(testSource, /TOTAL_DEADLINE_MS = 150_000L/);
  assert.match(testSource, /FAILURE_UI_DEADLINE_MS = 60_000L/);
  assert.match(testSource, /RETRY_DEADLINE_MS = 90_000L/);
  assert.match(readme, /does not test streaming, ANR recovery, every plugin ordering/);
  assert.match(readme, /Root owns compilation, exact APK\/certificate binding/);
  assert.match(readme, /overall 150-second cooperative deadline/);
  assert.match(readme, /independent outer instrumentation-command timeout/);
  assert.match(readme, /load\(WebView\)` override through the real minified classloader is an open runtime gate/);

  // Reverting the one non-sensitive scope label must invalidate the evidence contract.
  assert.doesNotMatch(testSource.replace('selected_first_plugin_load_failure_then_one_native_retry', 'startup_success'),
    /selected_first_plugin_load_failure_then_one_native_retry/);
});


test('AppCompat signatures are isolated, JAR-only, task-bound and receipted without resource extraction', async () => {
  const gradle = await read('app/build.gradle.kts');
  const signatureContract = (source) => [
    'configurations.create("ownedPublicApiSignatures")',
    'isCanBeResolved = true',
    'isCanBeConsumed = false',
    'isTransitive = true',
    'entry.name == "classes.jar"',
    'Regex("libs/[A-Za-z0-9_.-]+\\\\.jar").matches(entry.name)',
    'signatureEntries(input).map { entry ->',
    'archive.getInputStream(jar)',
    'input.copyTo(output, overwrite = true)',
    'files(signatureJarFiles).builtBy(extractPublicApiSignatureJars)',
    'androidTestCompileOnly(publicApiSignatureClasspath)',
    '"component" to artifact.moduleVersion.id.toString()',
    '"artifactSha256" to signatureSha256(input)',
    '"sha256" to signatureSha256(output)',
    '"PUBLIC_COMPILE_ONLY_SIGNATURES_NO_RUNTIME_COPIES"',
  ].every((required) => source.includes(required)) &&
    !/zipTree\(|extendsFrom\(|(?:include|from)\([^\n]*["']res\//.test(source);
  assert.equal(signatureContract(gradle), true);
  for (const required of [
    'entry.name == "classes.jar"',
    'Regex("libs/[A-Za-z0-9_.-]+\\\\.jar").matches(entry.name)',
    '.builtBy(extractPublicApiSignatureJars)',
    '"artifactSha256" to signatureSha256(input)',
    '"sha256" to signatureSha256(output)',
  ]) {
    assert.ok(gradle.includes(required));
    assert.equal(signatureContract(gradle.replace(required, 'REMOVED_REQUIRED_SIGNATURE_GUARD')), false);
  }
  assert.equal(signatureContract(gradle.replace(
    'androidTestCompileOnly(publicApiSignatureClasspath)', 'androidTestCompileOnly(publicApiSignatures)'
  )), false);
});

test('platform runner executes genuine one-method JUnit with callback-only statuses and fail-closed bounded output', async () => {
  const runner = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyInstrumentationRunner.java');
  const testSource = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const genuineJUnitContract = (source) => [
    'extends Instrumentation',
    'super.onCreate(arguments);',
    'start();',
    'Looper.myLooper() == Looper.getMainLooper()',
    'JUnitCore junit = new JUnitCore();',
    'junit.addListener(observed);',
    'junit.addListener(new TextListener(text));',
    'junit.run(Request.method(OwnedDestroyRetryTest.class, TEST_METHOD))',
    'publish(1, description);',
    'publish(failures == 0 && assumptions == 0 ? 0 : -2, description);',
    'identityMatched && runStarts == 1 && runFinishes == 1 && starts == 1 && finishes == 1',
    'failures == 0 && ignored == 0 && assumptions == 0 && result.wasSuccessful()',
    'result.getRunCount() == 1 && result.getFailureCount() == 0',
    'result.getIgnoreCount() == 0 && result.getAssumptionFailureCount() == 0',
    'observed.singleSuccessfulTest(result) && !output.truncated() && !text.checkError()',
    'MAX_BYTES = 16_384',
    'Math.min(length, MAX_BYTES - bytes.size())',
    'finish(success ? Activity.RESULT_OK : Activity.RESULT_CANCELED, results);',
  ].every((required) => source.includes(required)) &&
    /catch \(Throwable failure\) \{\s*success = false;/.test(source) &&
    (source.match(/\bsendStatus\(/g) ?? []).length === 1 &&
    !/new Result\(|OK \(1 test\)|owned_destroy_evidence|AndroidJUnitRunner|InstrumentationRegistry/.test(source);
  assert.equal(genuineJUnitContract(runner), true);
  assert.match(runner, /TEST_CLASS = "com\.yawf\.ownedstartup\.OwnedDestroyRetryTest"/);
  assert.match(runner, /TEST_METHOD = "acceptedPluginLoadFailureIsDestroyedThenOneNativeRetrySucceeds"/);
  assert.match(runner, /\(TEST_CLASS \+ "#" \+ TEST_METHOD\)\.equals\(arguments\.getString\("class"\)\)/);
  assert.match(runner, /runner == null \|\| runner\.getClass\(\) != OwnedDestroyInstrumentationRunner\.class \|\| !runner\.junitRunning/);
  assert.match(runner, /void testStarted\(Description description\) \{\s*starts\+\+;\s*publish\(1, description\)/);
  assert.match(runner, /void testFinished\(Description description\) \{\s*finishes\+\+;\s*publish\(/);
  assert.match(runner, /status\.putString\("class", description\.getClassName\(\)\)/);
  assert.match(runner, /status\.putString\("test", description\.getMethodName\(\)\)/);
  assert.match(runner, /status\.putInt\("numtests", 1\)/);
  assert.match(testSource, /OwnedDestroyInstrumentationRunner\.currentRunner\(\)/);
  assert.equal((testSource.match(/^\s*@Test$/gm) ?? []).length, 1);
  assert.doesNotMatch(`${runner}\n${testSource}`, /androidx\.|InstrumentationRegistry|@RunWith|AndroidJUnit4/);
  for (const required of [
    'junit.run(Request.method(OwnedDestroyRetryTest.class, TEST_METHOD))',
    'junit.addListener(new TextListener(text));',
    'publish(1, description);',
    'result.getRunCount() == 1 && result.getFailureCount() == 0',
    'result.getIgnoreCount() == 0 && result.getAssumptionFailureCount() == 0',
    '!output.truncated()',
    'success = false;\n            // Bootstrap',
  ]) {
    assert.ok(runner.includes(required));
    assert.equal(genuineJUnitContract(runner.replace(required, 'REMOVED_REQUIRED_JUNIT_GUARD')), false);
  }
  assert.equal(genuineJUnitContract(runner.replace(
    'finish(success ? Activity.RESULT_OK : Activity.RESULT_CANCELED, results);',
    'finish(Activity.RESULT_OK, results);'
  )), false);
});

test('Java-only test APK packages only pinned JUnit and Hamcrest, never AndroidX or Kotlin runtimes', async () => {
  const gradle = await read('app/build.gradle.kts');
  const properties = await read('gradle.properties');
  const moduleKotlinDisabled = (source) => /android \{\n    \/\/[^\n]*\n    enableKotlin = false\n/.test(source);
  const onlyJUnitRuntime = (source) => JSON.stringify(source.split('\n').filter((line) =>
    /\b(?:[A-Za-z]*(?:Implementation|RuntimeOnly)|implementation|runtimeOnly)\s*\(/.test(line)
  ).map((line) => line.trim())) === JSON.stringify([
    'androidTestImplementation("junit:junit:4.13.2") { isTransitive = false }',
    'androidTestImplementation("org.hamcrest:hamcrest-core:1.3") { isTransitive = false }',
  ]);
  assert.equal(moduleKotlinDisabled(gradle), true);
  assert.equal(onlyJUnitRuntime(gradle), true);
  assert.equal(moduleKotlinDisabled(gradle.replace('enableKotlin = false', '')), false);
  for (const unwanted of ['androidx.test:runner:1.7.0', 'androidx.appcompat:appcompat:1.6.0', 'org.jetbrains.kotlin:kotlin-stdlib:2.3.21']) {
    assert.equal(onlyJUnitRuntime(`${gradle}\nandroidTestImplementation("${unwanted}")\n`), false);
  }
  assert.equal(onlyJUnitRuntime(gradle.replace('junit:junit:4.13.2', 'junit:junit:4.12')), false);
  assert.equal(onlyJUnitRuntime(gradle.replace('org.hamcrest:hamcrest-core:1.3', 'org.hamcrest:hamcrest-core:2.2')), false);
  assert.doesNotMatch(properties, /android\.(?:builtInKotlin|newDsl)\s*=\s*false/);
  assert.match(gradle, /compileOnly\(files\(apiClassesJar\)\)/);
  assert.match(gradle, /androidTestCompileOnly\(files\(apiClassesJar\)\)/);
});
