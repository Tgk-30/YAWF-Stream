import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    'long tapTimeoutMillis = ViewConfiguration.getTapTimeout();',
    'long holdMillis = tapTimeoutMillis + TAP_FRAME_MS;',
    'ViewConfiguration.getLongPressTimeout()',
    'TAP_HOLD_MAX_MS = 200L',
    'SystemClock.sleep(holdMillis);',
    'long downTime = SystemClock.uptimeMillis();',
    'long upTime = SystemClock.uptimeMillis();',
    'MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0)',
    '\n                instrumentation.sendPointerSync(up);\n',
    'heldMillis >= holdMillis && heldMillis <= TAP_HOLD_MAX_MS && heldMillis < longPressMillis',
    'SystemClock.uptimeMillis() + holdMillis <= observationDeadline',
    'observer = new PressedObserver(tap, retryTapObservation);',
    'retryPressedObservationOutcome = observer.awaitResult();',
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
    /observer\.start\(\);\s*SystemClock\.sleep\(holdMillis\);\s*retryPressedObservationOutcome = observer\.awaitResult\(\);/.test(code) &&
    /retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome\.PRESSED;\s*\} else \{\s*retryPressedObservationOutcome = PressedObservationOutcome\.BUDGET_SKIPPED;\s*\}\s*\} finally \{\s*if \(observer != null\) observer\.close\(\);\s*long upTime = SystemClock\.uptimeMillis\(\);[\s\S]*?instrumentation\.sendPointerSync\(up\)/.test(code) &&
    !/performClick|callOnClick|dispatchTouchEvent|UiAutomation|UiDevice|ACTION_MOVE|ACTION_CANCEL|setPressed\(/.test(code);
  assert.equal(nativeTapContract(source), true);
  for (const [from, to] of [
    ['screenBounds.offset(rootScreenOffset[0], rootScreenOffset[1]);', ''],
    ['screenBounds.intersect(buttonScreenBounds)', 'true'],
    ['SystemClock.sleep(holdMillis);', ''],
    ['observer.start();\n                SystemClock.sleep(holdMillis);', 'SystemClock.sleep(holdMillis);\n                observer.start();'],
    ['if (observer != null) observer.close();', ''],
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
    'private TapObservation retryTapObservation;',
    'new TapObservation(downTime, tapTimeoutMillis, holdMillis, longPressMillis, observationDeadline)',
    'return value == null ? PressedObservationOutcome.OBSERVATION_TIMEOUT : value;',
    'currentBounds == null || !currentBounds.equals(tap.screenBounds)',
    'tap.button.isPressed() ? PressedObservationOutcome.PRESSED : PressedObservationOutcome.UNPRESSED',
    'observation.completeSample(SystemClock.uptimeMillis(), PressedObservationOutcome.OBSERVATION_ERROR)',
    'observation.beginSample(SystemClock.uptimeMillis())',
    'observation.completeSample(SystemClock.uptimeMillis(), value)',
    'observation.enqueue(SystemClock.uptimeMillis()) && main.post(read)',
    'main.postDelayed(this, TAP_FRAME_MS)',
    'boolean completed = remaining > 0 && observed.await(remaining, TimeUnit.MILLISECONDS);',
    'return observation.finish(SystemClock.uptimeMillis(), completed);',
    'observation.close();',
    'main.removeCallbacks(read)',
    'evidence.put("retryDownCallElapsedMs", retryDownCallElapsedMs == null ? JSONObject.NULL : retryDownCallElapsedMs);',
    'evidence.put("retryPressedObservationOutcome", retryPressedObservationOutcome.wireValue);',
    'evidence.put("retryTapTiming", new JSONObject(TapObservation.wireValues(retryTapObservation)));',
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
    ['observation.beginSample(SystemClock.uptimeMillis())', 'true'],
    ['observation.completeSample(SystemClock.uptimeMillis(), value)', 'false'],
    ['return observation.finish(SystemClock.uptimeMillis(), completed);', 'return PressedObservationOutcome.PRESSED;'],
    ['main.postDelayed(this, TAP_FRAME_MS)', 'main.postDelayed(this, 1L)'],
  ]) {
    assert.ok(source.includes(from));
    assert.equal(diagnosticContract(source.replace(from, to)), false);
  }
});

test('actual concurrent pressed-observation policy rejects timing and late-publication mutants', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const begin = '    // BEGIN PURE TAP OBSERVATION POLICY\n';
  const end = '    // END PURE TAP OBSERVATION POLICY\n';
  assert.equal(source.split(begin).length, 2);
  assert.equal(source.split(end).length, 2);
  const policy = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end));
  assert.doesNotMatch(policy, /android\.|SystemClock|\b(?:Activity|Button|Rect|Instrumentation)\b/);
  const binding = (code) => [
    'new TapObservation(downTime, tapTimeoutMillis, holdMillis, longPressMillis, observationDeadline)',
    'long observationDeadline = downTime + Math.min(TAP_HOLD_MAX_MS, longPressMillis - 1L) - TAP_FRAME_MS;',
    'observation.enqueue(SystemClock.uptimeMillis()) && main.post(read)',
    'observation.beginSample(SystemClock.uptimeMillis())',
    'observation.completeSample(SystemClock.uptimeMillis(), value)',
    'return observation.finish(SystemClock.uptimeMillis(), completed);',
    'retryTapObservation.recordUp(upTime);',
  ].every((part) => code.includes(part)) &&
    /observer\.start\(\);\s*SystemClock\.sleep\(holdMillis\);\s*retryPressedObservationOutcome = observer\.awaitResult\(\);/.test(code);
  assert.equal(binding(source), true);
  for (const [from, to] of [
    ['observer.start();\n                SystemClock.sleep(holdMillis);', 'SystemClock.sleep(holdMillis);\n                observer.start();'],
    ['SystemClock.sleep(holdMillis);', 'SystemClock.sleep(holdMillis + 17L);'],
    ['observation.completeSample(SystemClock.uptimeMillis(), value)', 'observation.completeSample(SystemClock.uptimeMillis(), PressedObservationOutcome.PRESSED)'],
    ['return observation.finish(SystemClock.uptimeMillis(), completed);', 'return PressedObservationOutcome.PRESSED;'],
  ]) {
    assert.equal(source.split(from).length, 2);
    assert.equal(binding(source.replace(from, to)), false);
  }
  const checks = String.raw`
        static void check(boolean value, String code) { if (!value) throw new AssertionError(code); }
        static TapObservation timing() { return new TapObservation(1000, 100, 117, 400, 1183); }
        static void positive(TapObservation state) {
            check(state.enqueue(1064), "DOWN returned after 64 ms");
            check(state.beginSample(1068), "normal UI queue enters during the full hold sleep");
            check(!state.completeSample(1069, PressedObservationOutcome.PRESSED), "positive ends observation only");
        }
        static void exercise(String name) {
            TapObservation state = timing();
            if (name.equals("during-hold")) {
                positive(state);
                check(state.finish(1181, true) == PressedObservationOutcome.PRESSED, "64 plus unchanged full 117 ms sleep qualifies timely real proof");
                state.recordUp(1181);
                java.util.Map<String, Object> values = TapObservation.wireValues(state);
                check(values.get("enqueuedOffsetMs").equals(64L) && values.get("enteredOffsetMs").equals(68L) &&
                    values.get("completedOffsetMs").equals(69L) && values.get("actualHoldMs").equals(181L), "actual relative timings");
                check(values.get("tapTimeoutMs").equals(100L) && values.get("minimumHoldMs").equals(117L), "configured not guessed");
            } else if (name.equals("configured-timeout")) {
                state = new TapObservation(1000, 120, 137, 500, 1183);
                check(state.enqueue(1020) && state.beginSample(1024), "nondefault configuration");
                check(!state.completeSample(1025, PressedObservationOutcome.PRESSED), "real positive");
                check(state.finish(1157, true) == PressedObservationOutcome.PRESSED, "unchanged configured hold");
                state.recordUp(1157);
                java.util.Map<String, Object> values = TapObservation.wireValues(state);
                check(values.get("tapTimeoutMs").equals(120L) && values.get("minimumHoldMs").equals(137L) &&
                    values.get("longPressTimeoutMs").equals(500L) && values.get("actualHoldMs").equals(157L), "no guessed 100 ms timing");
            } else if (name.equals("old-double-delay")) {
                check(state.enqueue(1181), "old full sleep before enqueue left only 2 ms");
                check(!state.beginSample(1185), "same healthy 4 ms scheduling cannot meet old deadline");
                check(state.finish(1185, false) == PressedObservationOutcome.OBSERVATION_TIMEOUT, "old trace never becomes unpressed or qualified");
            } else if (name.equals("late-caller")) {
                positive(state);
                check(state.finish(1184, true) == PressedObservationOutcome.OBSERVATION_TIMEOUT, "caller must still meet original deadline");
            } else if (name.equals("missing-latch")) {
                positive(state);
                check(state.finish(1181, false) == PressedObservationOutcome.OBSERVATION_TIMEOUT, "incomplete callback is not proof");
            } else if (name.equals("late-completion")) {
                check(state.enqueue(1064) && state.beginSample(1180), "entered within deadline");
                check(!state.completeSample(1184, PressedObservationOutcome.PRESSED) && state.result == null, "late traversal cannot publish positive");
                check(state.finish(1184, true) == PressedObservationOutcome.OBSERVATION_TIMEOUT, "late completion remains pending");
            } else if (name.equals("closed-publication")) {
                check(state.enqueue(1064) && state.beginSample(1068), "in-flight read");
                state.close();
                check(!state.completeSample(1069, PressedObservationOutcome.PRESSED), "closed observer does not reschedule");
                check(state.result == null && TapObservation.wireValues(state).get("completedOffsetMs") == null, "closed result and timing frozen");
            } else if (name.equals("closed-read")) {
                check(state.enqueue(1064), "enqueued"); state.close();
                check(!state.beginSample(1068) && TapObservation.wireValues(state).get("sampleCount").equals(0), "late callback cannot read after UP fence");
            } else if (name.equals("interval")) {
                check(state.enqueue(1064) && state.beginSample(1064), "first sample");
                check(state.completeSample(1064, PressedObservationOutcome.UNPRESSED), "unpressed may be read again within same gesture");
                check(!state.beginSample(1080) && state.beginSample(1081), "17 ms minimum interval");
                check(!state.completeSample(1082, PressedObservationOutcome.PRESSED), "later true pressed");
                check(state.finish(1181, true) == PressedObservationOutcome.PRESSED, "no extra gesture");
            } else if (name.equals("sample-cap")) {
                state = new TapObservation(1000, 100, 117, 400, 1500);
                check(state.enqueue(1000), "enqueued");
                for (int index = 0; index < 12; index++) {
                    check(state.beginSample(1000 + index * 17), "bounded sample");
                    check(state.completeSample(1000 + index * 17, PressedObservationOutcome.UNPRESSED) == (index < 11), "at most 12 reads even under larger fixture deadline");
                }
                check(state.finish(1200, true) == PressedObservationOutcome.UNPRESSED, "real negative remains negative");
            } else if (name.equals("terminal-negative")) {
                check(state.enqueue(1064) && state.beginSample(1068), "first sample");
                check(!state.completeSample(1069, PressedObservationOutcome.STATE_MISMATCH), "identity or geometry mismatch is terminal");
                check(state.finish(1181, true) == PressedObservationOutcome.STATE_MISMATCH, "negative cannot qualify");
            } else if (name.equals("empty")) {
                check(state.finish(1181, true) == PressedObservationOutcome.OBSERVATION_TIMEOUT, "missing value is unknown not unpressed");
                check(TapObservation.wireValues(null).get("tapTimeoutMs") == null, "unattempted config unknown");
                state.recordUp(999999);
                check(TapObservation.wireValues(state).get("actualHoldMs").equals(150000L), "bounded public timing");
            } else throw new AssertionError("unknown fixture case");
        }
  `;
  const mutations = [
    ['configured-timeout', 'configured-timeout', 'Math.min(150_000L, tapTimeoutMillis)', '100L'],
    ['original-deadline', 'old-double-delay', 'now <= deadlineUptime', 'true'],
    ['late-caller', 'late-caller', '!callbackCompleted || !inTime(now)', '!callbackCompleted'],
    ['missing-latch', 'missing-latch', '!callbackCompleted || !inTime(now)', '!inTime(now)'],
    ['late-completion', 'late-completion', '!inTime(now) || now < lastSampleAt', 'now < lastSampleAt'],
    ['late-publication', 'closed-publication', 'closed || !inSample', '!inSample'],
    ['late-read', 'closed-read', 'closed || enqueued == null', 'enqueued == null'],
    ['sample-interval', 'interval', 'now - lastSampleAt < INTERVAL_MS', 'false'],
    ['sample-cap', 'sample-cap', 'value == PressedObservationOutcome.UNPRESSED && samples < MAX_SAMPLES', 'value == PressedObservationOutcome.UNPRESSED'],
    ['negative-proof', 'terminal-negative', 'result = value; return false;', 'result = PressedObservationOutcome.PRESSED; return false;'],
    ['unknown-proof', 'empty', 'value == null ? PressedObservationOutcome.OBSERVATION_TIMEOUT : value', 'value == null ? PressedObservationOutcome.UNPRESSED : value'],
  ];
  const wrappers = [policy, ...mutations.map(([, , from, to]) => {
    assert.equal(policy.split(from).length, 2, `exact mutation needle: ${from}`);
    return policy.replace(from, to);
  })];
  const generated = `public final class TapObservationFixture {\n${wrappers.map((code, index) =>
    `private static final class Policy${index} {\n${code}\n${checks}\n}`).join('\n')}\n` +
    `public static void main(String[] args) { switch (Integer.parseInt(args[0])) {\n${wrappers.map((_, index) =>
      `case ${index}: Policy${index}.exercise(args[1]); break;`).join('\n')}\ndefault: throw new AssertionError("unknown policy"); } System.out.print("PASS"); }\n}`;
  const temporaryRoot = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(temporaryRoot && isAbsolute(temporaryRoot), 'an owned absolute test temporary directory is required');
  const directory = mkdtempSync(join(temporaryRoot, 'owned-tap-observation-'));
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const invoke = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    cwd: directory, env: { ...process.env, TMPDIR: directory },
  });
  const requireProcess = (result, status) => {
    assert.equal(result.error, undefined, 'fixture process must not time out or fail to spawn');
    assert.equal(result.signal, null, 'fixture process must not crash');
    assert.equal(result.status, status, result.stdout + result.stderr);
  };
  try {
    const file = join(directory, 'TapObservationFixture.java');
    writeFileSync(file, generated);
    requireProcess(invoke(javac, ['--release', '17', '-d', directory, file]), 0);
    for (const name of ['during-hold', 'configured-timeout', 'old-double-delay', 'late-caller', 'missing-latch', 'late-completion', 'closed-publication', 'closed-read', 'interval', 'sample-cap', 'terminal-negative', 'empty']) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'TapObservationFixture', '0', name]);
      requireProcess(positive, 0); assert.equal(positive.stdout, 'PASS');
    }
    for (const [index, [label, name]] of mutations.entries()) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'TapObservationFixture', '0', name]);
      requireProcess(positive, 0); assert.equal(positive.stdout, 'PASS');
      const negative = invoke(java, ['-Xmx64m', '-cp', directory, 'TapObservationFixture', String(index + 1), name]);
      requireProcess(negative, 1);
      assert.match(negative.stderr, /java\.lang\.AssertionError:/, label);
      assert.doesNotMatch(negative.stderr, /(?:NoClassDefFoundError|ExceptionInInitializerError|StackOverflowError)/, label);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('paired public async probe posts second on the same main looper without changing ordinary touch proof', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const contract = (code) => {
    const start = code.slice(code.indexOf('        void start() {'), code.indexOf('        PressedObservationOutcome awaitResult()'));
    const close = code.slice(code.indexOf('        void close() {'), code.indexOf('    private boolean awaitOriginalButtonDetachedAfterUp'));
    const asyncRead = code.slice(code.indexOf('            asyncRead = () -> {'), code.indexOf('            read = new Runnable()'));
    return [
      'private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());',
      'retryAsyncMainProbe = observer.asyncProbe;',
      'new AsyncMainProbe(observation.downTime, observation.deadlineUptime)',
      'asyncMain = android.os.Handler.createAsync(main.getLooper());',
      'android.os.Looper.myLooper() == main.getLooper(), Build.VERSION.SDK_INT >= 28',
      'asyncMain.getLooper() == main.getLooper() && main.getLooper() == android.os.Looper.getMainLooper()',
      'if (asyncProbe.enqueue(SystemClock.uptimeMillis()) && asyncMain.post(asyncRead)) return;',
      'retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome.PRESSED;',
      'require(retryDownPressed, "RETRY_DOWN_NOT_OBSERVED_PRESSED");',
      'evidence.put("retryAsyncMainProbe", new JSONObject(AsyncMainProbe.wireValues(retryAsyncMainProbe)));',
    ].every((part) => code.includes(part)) &&
      /if \(observation\.enqueue\(SystemClock\.uptimeMillis\(\)\) && main\.post\(read\)\) \{\s*startAsyncDiagnostic\(\);\s*return;/.test(start) &&
      /observation\.close\(\);\s*asyncProbe\.close\(SystemClock\.uptimeMillis\(\)\);\s*try \{ if \(asyncMain != null\) asyncMain\.removeCallbacks\(asyncRead\);/.test(close) &&
      /if \(!asyncProbe\.begin\(SystemClock\.uptimeMillis\(\), sameLooper\)\) return;/.test(asyncRead) &&
      /if \(!sameLooper\) \{\s*asyncProbe\.complete\(SystemClock\.uptimeMillis\(\), AsyncProbeOutcome\.STATE_MISMATCH\);\s*return;/.test(asyncRead) &&
      asyncRead.includes('Rect bounds = verifiedRetryScreenBoundsOnMain(tap.activity, tap.button);') &&
      asyncRead.includes('tap.button.isPressed() ? AsyncProbeOutcome.PRESSED : AsyncProbeOutcome.UNPRESSED') &&
      asyncRead.includes('asyncProbe.complete(SystemClock.uptimeMillis(), value);') &&
      !/sleep|await\(|postDelayed|setPressed|performClick|reflect|sendPointer|dispatchTouch|\.set[A-Z]/.test(start + asyncRead) &&
      (code.match(/Handler\.createAsync\(/g) ?? []).length === 1 &&
      (code.match(/asyncMain\.post\(/g) ?? []).length === 1 &&
      /if \(observer != null\) observer\.close\(\);\s*long upTime = SystemClock\.uptimeMillis\(\);/.test(code);
  };
  assert.equal(contract(source), true);
  for (const [from, to] of [
    ['observation.enqueue(SystemClock.uptimeMillis()) && main.post(read)', 'main.post(read) || observation.enqueue(SystemClock.uptimeMillis())'],
    ['asyncMain = android.os.Handler.createAsync(main.getLooper());', 'asyncMain = new android.os.Handler(main.getLooper());'],
    ['asyncMain.post(asyncRead)', 'main.post(asyncRead)'],
    ['Build.VERSION.SDK_INT >= 28', 'true'],
    ['asyncProbe.close(SystemClock.uptimeMillis());', ''],
    ['asyncMain.removeCallbacks(asyncRead)', 'main.removeCallbacks(asyncRead)'],
    ['asyncProbe.complete(SystemClock.uptimeMillis(), value);', 'asyncProbe.complete(SystemClock.uptimeMillis(), AsyncProbeOutcome.PRESSED);'],
    ['retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome.PRESSED;', 'retryDownPressed = true;'],
    ['startAsyncDiagnostic();', 'startAsyncDiagnostic(); SystemClock.sleep(1L);'],
  ]) {
    assert.equal(source.split(from).length, 2, `one async binding needle: ${from}`);
    assert.equal(contract(source.replace(from, to)), false);
  }
});

test('actual paired async policy freezes one read and never promotes async-only entry to ordinary proof', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const extract = (label) => {
    const begin = `    // BEGIN PURE ${label} POLICY\n`, end = `    // END PURE ${label} POLICY\n`;
    assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
    return source.slice(source.indexOf(begin) + begin.length, source.indexOf(end));
  };
  const policy = extract('ASYNC MAIN PROBE'), ordinaryPolicy = extract('TAP OBSERVATION');
  assert.doesNotMatch(policy, /android\.|SystemClock|\b(?:Activity|Button|Rect|Instrumentation)\b/);
  const checks = String.raw`
        static void check(boolean value, String code) { if (!value) throw new AssertionError(code); }
        static AsyncMainProbe setup() {
            AsyncMainProbe probe = new AsyncMainProbe(1000, 1183);
            check(probe.start(1065, false, true) && probe.handlerReady(1065, true) && probe.enqueue(1065), "ordinary enqueue at 1064 precedes async attempt");
            return probe;
        }
        static String outcome(AsyncMainProbe probe) { return (String) AsyncMainProbe.wireValues(probe).get("outcome"); }
        static void exercise(String name) throws Exception {
            TapObservation ordinary = new TapObservation(1000, 100, 117, 400, 1183);
            check(ordinary.enqueue(1064), "ordinary handler policy enqueues first");
            AsyncMainProbe probe = setup();
            if (name.equals("paired") || name.equals("async-only")) {
                if (name.equals("paired")) {
                    check(ordinary.beginSample(1068), "ordinary callback");
                    ordinary.completeSample(1069, PressedObservationOutcome.PRESSED);
                }
                check(probe.begin(1070, true), "async callback same looper");
                probe.complete(1071, AsyncProbeOutcome.PRESSED); probe.close(1181);
                check(outcome(probe).equals("pressed"), "async positive diagnostic");
                check(ordinary.finish(1181, name.equals("paired")) == (name.equals("paired") ?
                    PressedObservationOutcome.PRESSED : PressedObservationOutcome.OBSERVATION_TIMEOUT), "async cannot qualify missing ordinary callback");
                java.util.Map<String, Object> wire = AsyncMainProbe.wireValues(probe);
                check(wire.size() == 8 && wire.get("enqueuedOffsetMs").equals(65L) && wire.get("enteredOffsetMs").equals(70L) &&
                    wire.get("completedOffsetMs").equals(71L) && wire.get("closedOffsetMs").equals(181L) &&
                    wire.get("handlerSameMainLooper").equals(true) && wire.get("instrumentationThreadIsMain").equals(false), "fixed public facts only");
            } else if (name.equals("unavailable")) {
                probe = new AsyncMainProbe(1000, 1183);
                check(!probe.start(1065, false, false) && !probe.handlerReady(1065, true) && !probe.enqueue(1065), "public API unavailable is not a synchronous replacement");
                probe.close(1181); check(outcome(probe).equals("unavailable"), "unavailable stays inconclusive");
            } else if (name.equals("once")) {
                check(!probe.start(1066, false, true) && !probe.enqueue(1066), "one attempt and one async post");
                check(probe.begin(1068, true) && !probe.begin(1069, true), "exactly one callback read");
                probe.complete(1070, AsyncProbeOutcome.UNPRESSED); probe.complete(1071, AsyncProbeOutcome.PRESSED);
                check(outcome(probe).equals("unpressed"), "no resample or overwrite");
            } else if (name.equals("wrong-looper")) {
                check(probe.begin(1068, false), "record actual callback mismatch");
                probe.complete(1069, AsyncProbeOutcome.PRESSED); probe.close(1181);
                check(outcome(probe).equals("state-mismatch"), "wrong callback loop cannot publish pressed");
                probe = new AsyncMainProbe(1000, 1183); check(probe.start(1065, false, true), "start");
                check(!probe.handlerReady(1065, false) && !probe.enqueue(1065), "wrong handler loop cannot enqueue");
            } else if (name.equals("late-read")) {
                check(!probe.begin(1184, true), "absolute unchanged observation deadline");
                probe.close(1184); check(outcome(probe).equals("observation-timeout"), "no callback is not unpressed or blocked-thread proof");
            } else if (name.equals("late-completion")) {
                check(probe.begin(1180, true), "timely entry"); probe.complete(1184, AsyncProbeOutcome.PRESSED);
                probe.close(1185); check(outcome(probe).equals("observation-timeout"), "late traversal cannot publish a result");
            } else if (name.equals("closed-read")) {
                probe.close(1181); check(!probe.begin(1182, true), "UP fence rejects queued callback");
            } else if (name.equals("closed-publication")) {
                check(probe.begin(1068, true), "in-flight read"); probe.close(1181);
                java.util.Map<String, Object> frozen = AsyncMainProbe.wireValues(probe);
                probe.complete(1182, AsyncProbeOutcome.PRESSED); probe.error(1182);
                check(frozen.equals(AsyncMainProbe.wireValues(probe)), "no post-close result or error publication");
            } else if (name.equals("jdk-inflight-close")) {
                final AsyncMainProbe shared = probe;
                java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1), release = new java.util.concurrent.CountDownLatch(1);
                java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
                Thread callback = new Thread(() -> { try {
                    check(shared.begin(1068, true), "callback begins"); entered.countDown();
                    check(release.await(1, java.util.concurrent.TimeUnit.SECONDS), "bounded release");
                    shared.complete(1182, AsyncProbeOutcome.PRESSED);
                } catch (Throwable error) { failure.set(error); } });
                callback.setDaemon(true); callback.start();
                try {
                    check(entered.await(1, java.util.concurrent.TimeUnit.SECONDS), "callback entered without UI stubs");
                    shared.close(1181);
                    java.util.Map<String, Object> frozen = AsyncMainProbe.wireValues(shared);
                    release.countDown(); callback.join(1000);
                    check(!callback.isAlive() && failure.get() == null && frozen.equals(AsyncMainProbe.wireValues(shared)), "JDK in-flight publication fence");
                } finally { release.countDown(); callback.join(1000); }
            } else if (name.equals("freeze")) {
                probe.close(1181); java.util.Map<String, Object> frozen = AsyncMainProbe.wireValues(probe);
                probe.close(1182); check(frozen.equals(AsyncMainProbe.wireValues(probe)), "idempotent closure timestamp");
            } else if (name.equals("negative")) {
                check(probe.begin(1068, true), "timely callback"); probe.complete(1069, AsyncProbeOutcome.UNPRESSED);
                probe.close(1181); check(outcome(probe).equals("unpressed"), "true negative remains negative");
            } else if (name.equals("bounded")) {
                probe.close(999999); check(AsyncMainProbe.wireValues(probe).get("closedOffsetMs").equals(150000L), "bounded public offsets");
                check(AsyncMainProbe.wireValues(null).get("enteredOffsetMs") == null, "missing probe unknown, not false");
            } else throw new AssertionError("unknown fixture case");
        }
  `;
  const mutations = [
    ['unavailable', 'return supported;', 'return true;'],
    ['once', 'closed || enqueued != null', 'closed || false'],
    ['wrong-looper', '!Boolean.TRUE.equals(callbackSameMainLooper)', 'false'],
    ['late-read', 'entered != null || !within(now)', 'entered != null'],
    ['late-completion', 'completed != null || !within(now)', 'completed != null'],
    ['closed-read', 'closed || enqueued == null', 'enqueued == null'],
    ['closed-publication', 'closed || entered == null', 'entered == null'],
    ['jdk-inflight-close', 'closed || entered == null', 'entered == null'],
    ['freeze', 'if (closed) return;', 'if (false) return;'],
    ['negative', '? value : AsyncProbeOutcome.OBSERVATION_ERROR', '? AsyncProbeOutcome.PRESSED : AsyncProbeOutcome.OBSERVATION_ERROR'],
    ['bounded', 'Math.min(150_000L, Math.max(0L, now - downTime))', 'Math.max(0L, now - downTime)'],
  ];
  const wrappers = [policy, ...mutations.map(([, from, to]) => {
    assert.equal(policy.split(from).length, 2, `exact async mutation: ${from}`); return policy.replace(from, to);
  })];
  const generated = `public final class AsyncMainProbeFixture {\n${wrappers.map((code, index) =>
    `private static final class Policy${index} {\n${ordinaryPolicy}\n${code}\n${checks}\n}`).join('\n')}\n` +
    `public static void main(String[] args) throws Exception { switch (Integer.parseInt(args[0])) {\n${wrappers.map((_, index) =>
      `case ${index}: Policy${index}.exercise(args[1]); break;`).join('\n')}\ndefault: throw new AssertionError("unknown policy"); } System.out.print("PASS"); }\n}`;
  const temporaryRoot = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(temporaryRoot && isAbsolute(temporaryRoot), 'an owned absolute test temporary directory is required');
  const directory = mkdtempSync(join(temporaryRoot, 'owned-async-main-probe-'));
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const invoke = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', cwd: directory, env: { ...process.env, TMPDIR: directory },
  });
  const requireProcess = (result, status) => {
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, status, result.stdout + result.stderr);
  };
  try {
    const file = join(directory, 'AsyncMainProbeFixture.java'); writeFileSync(file, generated);
    requireProcess(invoke(javac, ['--release', '17', '-d', directory, file]), 0);
    for (const name of ['paired', 'async-only', 'unavailable', 'once', 'wrong-looper', 'late-read', 'late-completion', 'closed-read', 'closed-publication', 'jdk-inflight-close', 'freeze', 'negative', 'bounded']) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'AsyncMainProbeFixture', '0', name]);
      requireProcess(positive, 0); assert.equal(positive.stdout, 'PASS');
    }
    for (const [index, [name]] of mutations.entries()) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'AsyncMainProbeFixture', '0', name]);
      requireProcess(positive, 0); assert.equal(positive.stdout, 'PASS');
      const negative = invoke(java, ['-Xmx64m', '-cp', directory, 'AsyncMainProbeFixture', String(index + 1), name]);
      requireProcess(negative, 1); assert.match(negative.stderr, /java\.lang\.AssertionError:/, name);
      assert.doesNotMatch(negative.stderr, /(?:NoClassDefFoundError|ExceptionInInitializerError|StackOverflowError)/, name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('admission keeps the original identity and bounded read-only samples before one gesture', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const section = (code, from, to) => code.slice(code.indexOf(from), code.indexOf(to));
  const admissionContract = (code) => {
    const wait = section(code, '    private TapPlan awaitStableTapPlan(', '    private static TapAdmissionSample admissionSample(');
    const readSample = section(code, '    private TapAdmissionSample readAdmissionSample(', '    private TapAdmissionSample inspectAdmissionOnMain(');
    const inspect = section(code, '    private TapAdmissionSample inspectAdmissionOnMain(', '    private void captureFocusSnapshotOnMain(');
    return code.includes('evidence.put("retryAdmissionAdmitted", retryAdmissionState != null && retryAdmissionState.admitted && !retryAdmissionState.refused);') &&
      code.includes('awaitStableTapPlan(activity, before.onlyRetryButton, fault, oldView)') && [
      'new TapAdmissionState(activity, originalButton, now,',
      'Math.min(startedAt + TOTAL_DEADLINE_MS, now + TapAdmissionState.MAX_ELAPSED_MS)',
      'state.observe(SystemClock.elapsedRealtime(), sample) && state.readyAt(SystemClock.elapsedRealtime())',
      'int[] bounds = state.copiedBounds();',
      'return new TapPlan(activity, originalButton, new Rect(bounds[0], bounds[1], bounds[2], bounds[3]), state.admittedAt);',
      'SystemClock.sleep(Math.min(TapAdmissionState.MIN_INTERVAL_MS, remaining));',
    ].every((part) => wait.includes(part)) && [
      'activity.runOnUiThread(() -> {',
      'if (SystemClock.elapsedRealtime() < deadline)',
      'result.compareAndSet(null, value)',
      'observed.await(remaining, TimeUnit.MILLISECONDS)',
      'SystemClock.elapsedRealtime() >= deadline',
      'result.getAndSet(closed)',
      'result.set(closed);',
      'TapAdmissionReason.OBSERVATION_TIMEOUT',
      'TapAdmissionReason.OBSERVATION_ERROR',
    ].every((part) => readSample.includes(part)) && [
      'owner != activity || runner.targetActivityCreateCount() != 1',
      'runner.targetPid() != android.os.Process.myPid()',
      'activity.isFinishing() || activity.isDestroyed()',
      'runner.refusalCode() != null || runner.faultPlugin() != fault || fault.firstView() != oldView',
      'fault.loadCount() != 1 || !fault.firstPluginVerified() || !fault.faultInjected()',
      'matches.size() > 1 || (matches.size() == 1 && matches.get(0) != button)',
      'oldView.getParent() != null || oldView.isAttachedToWindow() || webViews.size() != 0',
      'readUniqueWryWebViewFieldOnMain(activity) != null || readUniqueHelperAcceptedWebViewOnMain(activity) != null',
      'activity.getSystemService(Context.POWER_SERVICE)',
      'activity.getSystemService(Context.KEYGUARD_SERVICE)',
      'power == null || keyguard == null',
      '!power.isInteractive()',
      'keyguard.isKeyguardLocked()',
      'TapAdmissionReason.SCREEN_ASLEEP',
      'TapAdmissionReason.KEYGUARD_LOCKED',
      'verifiedRetryScreenBoundsOnMain(activity, button)',
    ].every((part) => inspect.includes(part)) &&
      !/runOnMainSync|sendPointerSync|MotionEvent|performClick|dispatchTouchEvent|wakeUp\(|requestDismissKeyguard\(|newWakeLock\(/.test(wait + readSample + inspect);
  };
  assert.equal(admissionContract(source), true);
  for (const [from, to] of [
    ['evidence.put("retryAdmissionAdmitted", retryAdmissionState != null && retryAdmissionState.admitted && !retryAdmissionState.refused);', 'evidence.put("retryAdmissionAdmitted", true);'],
    ['awaitStableTapPlan(activity, before.onlyRetryButton, fault, oldView)', 'awaitStableTapPlan(activity, null, fault, oldView)'],
    ['Math.min(startedAt + TOTAL_DEADLINE_MS, now + TapAdmissionState.MAX_ELAPSED_MS)', 'now + TOTAL_DEADLINE_MS'],
    ['state.observe(SystemClock.elapsedRealtime(), sample) && state.readyAt(SystemClock.elapsedRealtime())', 'true'],
    ['result.compareAndSet(null, value)', 'result.set(value)'],
    ['result.getAndSet(closed)', 'result.get()'],
    ['observed.await(remaining, TimeUnit.MILLISECONDS) ||\n                    SystemClock.elapsedRealtime() >= deadline', 'observed.await(60_000, TimeUnit.MILLISECONDS) ||\n                    SystemClock.elapsedRealtime() >= deadline'],
    ['fault.loadCount() != 1 || !fault.firstPluginVerified() || !fault.faultInjected()', 'false'],
    ['readUniqueWryWebViewFieldOnMain(activity) != null || readUniqueHelperAcceptedWebViewOnMain(activity) != null', 'false'],
    ['power == null || keyguard == null', 'false'],
    ['!power.isInteractive()', 'false'],
    ['keyguard.isKeyguardLocked()', 'false'],
  ]) {
    assert.equal(source.split(from).length, 2);
    assert.equal(admissionContract(source.replace(from, to)), false);
  }
});

test('actual extracted admission policy rejects behavioral mutants without Android SDK doubles', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const begin = '    // BEGIN PURE TAP ADMISSION POLICY\n';
  const end = '    // END PURE TAP ADMISSION POLICY\n';
  assert.equal(source.split(begin).length, 2);
  assert.equal(source.split(end).length, 2);
  const policy = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end));
  assert.ok(policy.startsWith('    private enum TapAdmissionReason {'));
  assert.equal((policy.match(/class TapAdmissionState\b/g) ?? []).length, 1);
  assert.equal((policy.match(/class TapAdmissionSample\b/g) ?? []).length, 1);
  assert.doesNotMatch(policy, /android\.|SystemClock|\b(?:Activity|Button|Rect|Instrumentation)\b/);
  assert.match(source, /TapAdmissionState state = new TapAdmissionState\(activity, originalButton,/);
  assert.match(source, /state\.observe\(SystemClock\.elapsedRealtime\(\), sample\) && state\.readyAt\(/);
  assert.match(source, /awaitStableTapPlan\(activity, before\.onlyRetryButton, fault, oldView\)/);
  assert.doesNotMatch(source, /buildTapPlanOnMain/);
  const pins = await readFile(new URL('./prepare_android_owned_fault_alias.py', import.meta.url), 'utf8');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  assert.ok(pins.includes(`"app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java": "${sourceSha256}"`));
  const checks = String.raw`
        static void check(boolean value, String code) { if (!value) throw new AssertionError(code); }
        static TapAdmissionSample sample(Object owner, Object button, TapAdmissionReason reason, int x, long at) {
            return new TapAdmissionSample(owner, button, reason, new int[] { x, 0, x + 10, 10 }, at);
        }
        static void exercise(String name) {
            Object owner = new Object(), button = new Object();
            TapAdmissionState state = new TapAdmissionState(owner, button, 0, 10000);
            if (name.equals("transient")) {
                check(!state.observe(0, sample(owner, button, TapAdmissionReason.FOCUS, 0, 0)), "focus is not admission");
                check(!state.observe(17, sample(owner, button, TapAdmissionReason.NONE, 0, 17)), "first eligible sample is not admission");
                check(state.observe(34, sample(owner, button, TapAdmissionReason.NONE, 0, 34)), "two stable samples admit");
                check(state.sampleCount == 3 && state.firstBlocking == TapAdmissionReason.FOCUS && state.lastBlocking == TapAdmissionReason.FOCUS, "fixed blocking history");
                int[] copy = state.copiedBounds(); copy[0] = 99;
                check(state.copiedBounds()[0] == 0 && state.admittedAt == 34, "copied plan bounds and actual sample time");
                for (TapAdmissionReason reason : new TapAdmissionReason[] { TapAdmissionReason.SCREEN_ASLEEP, TapAdmissionReason.KEYGUARD_LOCKED }) {
                    TapAdmissionState waiting = new TapAdmissionState(owner, button, 0, 10000);
                    check(!waiting.observe(0, sample(owner, button, reason, 0, 0)), "screen state is not admission");
                    check(!waiting.observe(17, sample(owner, button, TapAdmissionReason.NONE, 0, 17)), "screen recovery still requires a fresh pair");
                    check(waiting.observe(34, sample(owner, button, TapAdmissionReason.NONE, 0, 34)), "screen recovery can admit only after two eligible samples");
                }
            } else if (name.equals("reset")) {
                check(!state.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0)), "first sample");
                check(!state.observe(17, sample(owner, button, TapAdmissionReason.FOCUS, 0, 17)), "focus interrupts pair");
                check(!state.observe(34, sample(owner, button, TapAdmissionReason.NONE, 0, 34)), "old eligible sample cannot survive interruption");
                check(state.observe(51, sample(owner, button, TapAdmissionReason.NONE, 0, 51)), "fresh consecutive pair");
            } else if (name.equals("identity")) {
                state.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0));
                check(!state.observe(17, sample(owner, new Object(), TapAdmissionReason.NONE, 0, 17)) && state.refused, "replacement button refuses immediately");
                check(!state.observe(34, sample(owner, button, TapAdmissionReason.NONE, 0, 34)), "cannot retarget back");
                TapAdmissionState other = new TapAdmissionState(owner, button, 0, 10000);
                check(!other.observe(0, sample(new Object(), button, TapAdmissionReason.NONE, 0, 0)) && other.refused, "owner loss refuses");
            } else if (name.equals("geometry")) {
                check(!state.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0)), "first bounds");
                check(!state.observe(17, sample(owner, button, TapAdmissionReason.NONE, 1, 17)), "changed bounds cannot admit");
                check(!state.admitted && !state.refused && state.sampleCount == 2 && state.elapsedMs == 17, "two different bounds remain pending despite count and elapsed");
                check(state.firstBlocking == TapAdmissionReason.UNSTABLE_GEOMETRY, "unstable reason");
                check(state.observe(34, sample(owner, button, TapAdmissionReason.NONE, 1, 34)), "new identical consecutive bounds admit");
            } else if (name.equals("deadline")) {
                state.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0));
                check(!state.observe(2001, sample(owner, button, TapAdmissionReason.NONE, 0, 17)) && state.refused, "late caller cannot admit an earlier callback");
                TapAdmissionState clamped = new TapAdmissionState(owner, button, 100, 120);
                clamped.observe(100, sample(owner, button, TapAdmissionReason.NONE, 0, 100));
                check(!clamped.observe(120, sample(owner, button, TapAdmissionReason.NONE, 0, 117)), "existing total deadline clamps admission");
                TapAdmissionState accepted = new TapAdmissionState(owner, button, 0, 10000);
                accepted.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0));
                check(accepted.observe(17, sample(owner, button, TapAdmissionReason.NONE, 0, 17)), "setup accepted plan");
                check(!accepted.readyAt(2000), "expired final plan cannot publish");
            } else if (name.equals("interval")) {
                state.observe(0, sample(owner, button, TapAdmissionReason.NONE, 0, 0));
                check(!state.observe(1, sample(owner, button, TapAdmissionReason.NONE, 0, 1)) && state.refused, "no consecutive pair without poll interval");
            } else if (name.equals("terminal")) {
                for (TapAdmissionReason reason : new TapAdmissionReason[] { TapAdmissionReason.OWNER, TapAdmissionReason.LIVENESS, TapAdmissionReason.IDENTITY, TapAdmissionReason.FAULT, TapAdmissionReason.CLEANUP, TapAdmissionReason.OBSERVATION_TIMEOUT, TapAdmissionReason.OBSERVATION_ERROR }) {
                    TapAdmissionState refused = new TapAdmissionState(owner, button, 0, 10000);
                    check(!refused.observe(0, sample(owner, button, reason, 0, 0)) && refused.refused, "terminal observation refuses immediately");
                    check(!refused.observe(17, sample(owner, button, TapAdmissionReason.NONE, 0, 17)), "terminal refusal cannot recover into input");
                }
            } else if (name.equals("persistent")) {
                for (TapAdmissionReason reason : new TapAdmissionReason[] { TapAdmissionReason.FOCUS, TapAdmissionReason.SCREEN_ASLEEP, TapAdmissionReason.KEYGUARD_LOCKED }) {
                    TapAdmissionState waiting = new TapAdmissionState(owner, button, 0, 10000);
                    for (long at = 0; at < 2000; at += 17) {
                        check(!waiting.observe(at, sample(owner, button, reason, 0, at)), "persistent focus or screen loss has zero admissions");
                    }
                    check(!waiting.readyAt(2000) && waiting.refused && waiting.sampleCount <= TapAdmissionState.MAX_SAMPLES && waiting.elapsedMs == 2000, "bounded persistent refusal");
                }
                TapAdmissionState moving = new TapAdmissionState(owner, button, 0, 10000);
                for (int index = 0; index * 17 < 2000; index++) {
                    check(!moving.observe(index * 17, sample(owner, button, TapAdmissionReason.NONE, index % 2, index * 17)), "unstable geometry has zero admissions");
                }
                check(!moving.readyAt(2000), "unstable deadline");
            } else throw new AssertionError("unknown fixture case");
        }
  `;
  const mutations = [
    ['first-sample', 'transient', 'previousBounds != null && java.util.Arrays.equals(previousBounds, sample.bounds)', 'previousBounds == null || java.util.Arrays.equals(previousBounds, sample.bounds)'],
    ['pair-reset', 'reset', 'previousBounds = null;', '/* retained prior eligible sample */'],
    ['identity', 'identity', 'sample.button != button', 'false'],
    ['geometry', 'geometry', 'java.util.Arrays.equals(previousBounds, sample.bounds)', 'true'],
    ['late-caller', 'deadline', 'now < deadline', 'true'],
    ['poll-interval', 'interval', 'sample.observedAt - previousAt < MIN_INTERVAL_MS', 'false'],
    ['observation-error', 'terminal', 'OBSERVATION_ERROR("observation-error", true)', 'OBSERVATION_ERROR("observation-error", false)'],
    ['copied-bounds', 'transient', 'admittedBounds == null ? null : admittedBounds.clone()', 'admittedBounds'],
  ];
  const wrappers = [policy, ...mutations.map(([, , from, to]) => {
    assert.equal(policy.split(from).length, 2, `exact mutation needle: ${from}`);
    return policy.replace(from, to);
  })];
  const generated = `public final class AdmissionPolicyFixture {\n${wrappers.map((code, index) =>
    `private static final class Policy${index} {\n${code}\n${checks}\n}`).join('\n')}\n` +
    `public static void main(String[] args) { switch (Integer.parseInt(args[0])) {\n${wrappers.map((_, index) =>
      `case ${index}: Policy${index}.exercise(args[1]); break;`).join('\n')}\ndefault: throw new AssertionError("unknown policy"); } System.out.print("PASS"); }\n}`;
  assert.equal(generated.split(policy).length, 2, 'the unmodified policy bytes occur exactly once');
  const temporaryRoot = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(temporaryRoot && isAbsolute(temporaryRoot), 'an owned absolute test temporary directory is required');
  const directory = mkdtempSync(join(temporaryRoot, 'owned-admission-policy-'));
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const invoke = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    cwd: directory, env: { ...process.env, TMPDIR: directory },
  });
  const requireProcess = (result, status) => {
    assert.equal(result.error, undefined, 'fixture process must not time out or fail to spawn');
    assert.equal(result.signal, null, 'fixture process must not crash');
    assert.equal(result.status, status, result.stdout + result.stderr);
  };
  try {
    const file = join(directory, 'AdmissionPolicyFixture.java');
    writeFileSync(file, generated);
    requireProcess(invoke(javac, ['--release', '17', '-d', directory, file]), 0);
    for (const name of ['transient', 'reset', 'identity', 'geometry', 'deadline', 'interval', 'terminal', 'persistent']) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'AdmissionPolicyFixture', '0', name]);
      requireProcess(positive, 0);
      assert.equal(positive.stdout, 'PASS');
    }
    for (const [index, [label, name]] of mutations.entries()) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'AdmissionPolicyFixture', '0', name]);
      requireProcess(positive, 0);
      assert.equal(positive.stdout, 'PASS');
      const negative = invoke(java, ['-Xmx64m', '-cp', directory, 'AdmissionPolicyFixture', String(index + 1), name]);
      requireProcess(negative, 1);
      assert.match(negative.stderr, /java\.lang\.AssertionError:/, label);
      assert.doesNotMatch(negative.stderr, /ExceptionInInitializerError|NoClassDefFoundError|OutOfMemoryError/);
    }
    console.log(`Admission policy source SHA-256 ${sourceSha256}; extracted SHA-256 ${createHash('sha256').update(policy).digest('hex')}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('focus discriminator is one-shot, process-owned, bounded and reads only the admitted updater Dialog', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const from = source.indexOf('    private void captureFocusSnapshotOnMain(');
  const to = source.indexOf('    private static boolean ownedFocusedActivityOnMain(', from);
  const capture = source.slice(from, to);
  assert.ok(from > 0 && to > from);
  assert.match(source, /if \(!activity\.hasWindowFocus\(\) \|\| !decor\.hasWindowFocus\(\)\) \{\s*captureFocusSnapshotOnMain\(activity, decor\);/);
  assert.equal((source.match(/captureFocusSnapshotOnMain\(activity, decor\)/g) ?? []).length, 1);
  const contract = (code) => [
    'if (!retryFocusSnapshot.claim()) return;',
    'if (Build.VERSION.SDK_INT < 29) return;',
    'WindowInspector.getGlobalWindowViews()',
    'windows.size() > FocusSnapshot.MAX_ROOTS',
    'root.isAttachedToWindow()', 'root.isShown()', 'root.hasWindowFocus()',
    'WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE', 'WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE',
    'FocusSnapshot.classify(mainRoot, mainAttached,', 'retryFocusSnapshot.publish(snapshot);',
    'OwnedDestroyInstrumentationRunner.TARGET_ACTIVITY.equals(activity.getClass().getName())',
    'Class.forName("com.tgk30.debridstreamer.YawfAndroidUpdater", false, activity.getClassLoader())',
    'readOwnedUpdaterDialog(activity, activity.getClass(), updaterClass, Dialog.class)',
    'if (value == UNAVAILABLE_DIALOG) return "unavailable";',
    'dialog.isShowing()', 'window.getDecorView()',
    'classifyUpdaterDialog(true, window == null ? null : window.getDecorView(), snapshot.focusedRootCount, snapshot.focusedRoot)',
  ].every((part) => code.includes(part)) &&
    (code.match(/WindowInspector\.getGlobalWindowViews\(/g) ?? []).length === 1 &&
    !/collect\(|getChild|sendPointerSync|performClick|dismiss\(|setFlags|addFlags|clearFlags|getText|getTitle|getUrl|ActivityManager|requestFocus|newWakeLock|\.attach\(/.test(code);
  assert.equal(contract(capture), true);
  for (const required of [
    'if (!retryFocusSnapshot.claim()) return;', 'if (Build.VERSION.SDK_INT < 29) return;',
    'windows.size() > FocusSnapshot.MAX_ROOTS',
    'Class.forName("com.tgk30.debridstreamer.YawfAndroidUpdater", false, activity.getClassLoader())',
    'if (value == UNAVAILABLE_DIALOG) return "unavailable";',
  ]) {
    assert.equal(capture.split(required).length, 2);
    assert.equal(contract(capture.replace(required, 'REMOVED_REQUIRED_FOCUS_GUARD')), false);
  }
  assert.match(source, /evidence\.put\("retryFocusSnapshot", new JSONObject\(retryFocusSnapshot\.snapshot\(\)\.wireValues\(\)\)\)/);
});

test('actual focus classification and typed-owner reflection reject independent behavioral mutants', async () => {
  const source = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java');
  const begin = '    // BEGIN PURE FOCUS SNAPSHOT POLICY\n';
  const end = '    // END PURE FOCUS SNAPSHOT POLICY\n';
  assert.equal(source.split(begin).length, 2);
  assert.equal(source.split(end).length, 2);
  const policy = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end));
  assert.doesNotMatch(policy, /android\.|getDeclaredField\(|getName\(|getText\(|getTitle\(/);
  assert.equal((policy.match(/\.get\(activity\)/g) ?? []).length, 1);
  assert.equal((policy.match(/dialogField\.get\(/g) ?? []).length, 1);
  const pins = await readFile(new URL('./prepare_android_owned_fault_alias.py', import.meta.url), 'utf8');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  assert.ok(pins.includes('"app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyRetryTest.java": "' + sourceSha256 + '"'));
  const checks = String.raw`
        static void check(boolean value, String code) { if (!value) throw new AssertionError(code); }
        static class DialogValue { }
        static final class ChildDialog extends DialogValue { }
        static class UpdaterValue { private ChildDialog renamed = new ChildDialog(); private String ignored = "PRIVATE_FOCUS"; }
        static final class ChildUpdater extends UpdaterValue { }
        static final class ActivityValue { private UpdaterValue renamed = new UpdaterValue(); private Object unrelated = new Object(); }
        static final class DuplicateOwner { private UpdaterValue first = new UpdaterValue(), second = new UpdaterValue(); }
        static final class StaticOwner { private static UpdaterValue only = new UpdaterValue(); }
        static final class DuplicateDialogs { private DialogValue first = new DialogValue(), second = new DialogValue(); }
        static final class DuplicateDialogOwner { private DuplicateDialogs only = new DuplicateDialogs(); }
        static FocusSnapshot roots(Object main, Object other) {
            return FocusSnapshot.classify(main, true, true, false, false, false, new FocusRoot[] {
                new FocusRoot(main, true, true, false), new FocusRoot(other, true, true, true) });
        }
        static void exercise(String name) {
            Object main = new Object(), other = new Object();
            if (name.equals("roots")) {
                FocusSnapshot value = roots(main, other);
                check(value.available && value.focusCategory.equals("other-owned-root") && value.focusedRoot == other, "exact focused root identity");
                check(value.rootCount == 2 && value.attachedRootCount == 2 && value.visibleRootCount == 2 && value.focusedRootCount == 1, "bounded root facts");
                FocusSnapshot own = FocusSnapshot.classify(main, true, true, true, true, false, new FocusRoot[] { new FocusRoot(main, true, true, true) });
                check(own.focusCategory.equals("target-main") && own.mainNotFocusable && !own.mainNotTouchable, "main identity and flags");
                FocusSnapshot none = FocusSnapshot.classify(main, true, true, false, false, true, new FocusRoot[] { new FocusRoot(main, true, true, false) });
                check(none.focusCategory.equals("none-owned") && none.mainNotTouchable, "no owned focus is not main focus");
                FocusSnapshot both = FocusSnapshot.classify(main, true, true, true, false, false, new FocusRoot[] { new FocusRoot(main, true, true, true), new FocusRoot(other, true, true, true) });
                check(both.focusCategory.equals("ambiguous") && both.focusedRoot == null, "multiple focus cannot pick a root");
                java.util.Map<String,Object> wire = value.wireValues();
                check(wire.size() == 13 && !wire.containsValue(other) && !wire.toString().contains("PRIVATE_FOCUS"), "no identities or private fields on wire");
            } else if (name.equals("bounds")) {
                FocusRoot[] many = new FocusRoot[33];
                for (int i = 0; i < many.length; i++) many[i] = new FocusRoot(i == 0 ? main : new Object(), true, true, false);
                check(!FocusSnapshot.classify(main, true, true, false, false, false, many).available, "root cap is not truncated success");
                check(!FocusSnapshot.classify(main, true, true, false, false, false, new FocusRoot[] { new FocusRoot(main, true, true, false), new FocusRoot(main, true, true, false) }).available, "duplicate identities refuse");
                check(!FocusSnapshot.classify(main, true, true, false, false, false, new FocusRoot[0]).available, "attached main must be in complete snapshot");
            } else if (name.equals("once")) {
                FocusSnapshotCapture capture = new FocusSnapshotCapture();
                check(!capture.snapshot().attempted && !capture.snapshot().available, "not attempted is unavailable");
                check(capture.claim() && capture.snapshot().attempted && !capture.snapshot().available, "claim records attempted before observation");
                FocusSnapshot first = roots(main, other); capture.publish(first);
                check(!capture.claim(), "no repeated snapshot");
                capture.publish(FocusSnapshot.unavailable(true));
                check(capture.snapshot() == first, "later publisher cannot replace first snapshot");
            } else if (name.equals("reflection")) {
                ActivityValue activity = new ActivityValue();
                check(readOwnedUpdaterDialog(activity, ActivityValue.class, UpdaterValue.class, DialogValue.class) == activity.renamed.renamed, "unique exact owner and assignable Dialog field");
                check(readOwnedUpdaterDialog(activity, Object.class, UpdaterValue.class, DialogValue.class) == UNAVAILABLE_DIALOG, "wrong Activity class refuses");
                check(readOwnedUpdaterDialog(new DuplicateOwner(), DuplicateOwner.class, UpdaterValue.class, DialogValue.class) == UNAVAILABLE_DIALOG, "ambiguous updater owner refuses");
                check(readOwnedUpdaterDialog(new StaticOwner(), StaticOwner.class, UpdaterValue.class, DialogValue.class) == UNAVAILABLE_DIALOG, "static owner is not admitted Activity ownership");
                check(readOwnedUpdaterDialog(new DuplicateDialogOwner(), DuplicateDialogOwner.class, DuplicateDialogs.class, DialogValue.class) == UNAVAILABLE_DIALOG, "ambiguous Dialog field refuses");
                activity.renamed = null;
                check(readOwnedUpdaterDialog(activity, ActivityValue.class, UpdaterValue.class, DialogValue.class) == UNAVAILABLE_DIALOG, "missing updater refuses");
                activity.renamed = new ChildUpdater();
                check(readOwnedUpdaterDialog(activity, ActivityValue.class, UpdaterValue.class, DialogValue.class) == UNAVAILABLE_DIALOG, "subclass is not exact admitted updater");
            } else if (name.equals("dialog")) {
                check(classifyUpdaterDialog(true, other, 1, other).equals("yes"), "showing exact focused Dialog");
                check(classifyUpdaterDialog(true, other, 1, main).equals("no"), "showing different Dialog is not focused owner");
                check(classifyUpdaterDialog(false, other, 1, other).equals("no"), "not showing is not focused owner");
                check(classifyUpdaterDialog(true, null, 1, other).equals("unavailable"), "missing Dialog window is unavailable");
                check(classifyUpdaterDialog(true, other, 2, other).equals("unavailable"), "ambiguous focus is unavailable");
                check(classifyUpdaterDialog(true, other, 0, null).equals("no"), "no focused root cannot prove ownership");
            } else throw new AssertionError("unknown fixture case");
        }
  `;
  const mutations = [
    ['root-cap', 'bounds', 'roots.length > MAX_ROOTS', 'false'],
    ['duplicate-root', 'bounds', 'seen.put(root.identity, Boolean.TRUE) != null', '(seen.put(root.identity, Boolean.TRUE) != null && false)'],
    ['root-identity', 'roots', 'value.focusedRoot == mainRoot ? "target-main"', 'true ? "target-main"'],
    ['one-shot', 'once', 'if (claimed) return false;', 'if (false) return false;'],
    ['ambiguous-owner', 'reflection', 'ownerField != null || java.lang.reflect.Modifier.isStatic(field.getModifiers())', 'java.lang.reflect.Modifier.isStatic(field.getModifiers())'],
    ['static-owner', 'reflection', 'java.lang.reflect.Modifier.isStatic(field.getModifiers())', 'false'],
    ['exact-owner', 'reflection', 'updater.getClass() != updaterClass', 'false'],
    ['dialog-identity', 'dialog', 'dialogRoot == focusedRoot', 'true'],
    ['private-wire', 'roots', 'values.put("rootCount", rootCount);', 'values.put("private", focusedRoot); values.put("rootCount", rootCount);'],
  ];
  const wrappers = [policy, ...mutations.map(([, , from, to]) => {
    assert.equal(policy.split(from).length, 2, 'exact focus mutation needle');
    return policy.replace(from, to);
  })];
  const generated = 'public final class FocusPolicyFixture {\n' + wrappers.map((code, index) =>
    'private static final class Policy' + index + ' {\n' + code + '\n' + checks + '\n}').join('\n') +
    '\npublic static void main(String[] args) { switch (Integer.parseInt(args[0])) {\n' + wrappers.map((_, index) =>
      'case ' + index + ': Policy' + index + '.exercise(args[1]); break;').join('\n') +
    '\ndefault: throw new AssertionError("unknown policy"); } System.out.print("PASS"); }\n}';
  assert.equal(generated.split(policy).length, 2);
  const temporaryRoot = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(temporaryRoot && isAbsolute(temporaryRoot), 'owned absolute temporary directory required');
  const directory = mkdtempSync(join(temporaryRoot, 'owned-focus-policy-'));
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
  const invoke = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    cwd: directory, env: { ...process.env, TMPDIR: directory },
  });
  const requireProcess = (result, status) => {
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stdout + result.stderr);
  };
  try {
    const file = join(directory, 'FocusPolicyFixture.java'); writeFileSync(file, generated);
    requireProcess(invoke(javac, ['--release', '17', '-d', directory, file]), 0);
    for (const name of ['roots', 'bounds', 'once', 'reflection', 'dialog']) {
      const result = invoke(java, ['-Xmx64m', '-cp', directory, 'FocusPolicyFixture', '0', name]);
      requireProcess(result, 0); assert.equal(result.stdout, 'PASS');
    }
    for (const [index, [label, name]] of mutations.entries()) {
      const positive = invoke(java, ['-Xmx64m', '-cp', directory, 'FocusPolicyFixture', '0', name]);
      requireProcess(positive, 0); assert.equal(positive.stdout, 'PASS');
      const negative = invoke(java, ['-Xmx64m', '-cp', directory, 'FocusPolicyFixture', String(index + 1), name]);
      requireProcess(negative, 1); assert.match(negative.stderr, /java\.lang\.AssertionError:/, label);
      assert.doesNotMatch(negative.stderr, /ExceptionInInitializerError|NoClassDefFoundError|OutOfMemoryError/);
    }
    console.log('Focus snapshot source SHA-256 ' + sourceSha256 + '; extracted SHA-256 ' + createHash('sha256').update(policy).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
