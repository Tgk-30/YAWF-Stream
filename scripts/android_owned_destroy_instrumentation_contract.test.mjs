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
  assert.match(gradle, /androidTestImplementation\("androidx\.appcompat:appcompat:1\.6\.0"\)/);
  const compileOnlyLines = (source) => source.split('\n')
    .filter((line) => /^\s*(?:androidTest)?[cC]ompileOnly\s*\(/.test(line))
    .map((line) => line.trim());
  const exactApiJarOnly = (source) => JSON.stringify(compileOnlyLines(source)) === JSON.stringify([
    'compileOnly(files(apiClassesJar))',
    'androidTestCompileOnly(files(apiClassesJar))',
  ]);
  assert.equal(exactApiJarOnly(gradle), true);
  assert.equal(exactApiJarOnly(gradle.replace(
    'androidTestCompileOnly(files(apiClassesJar))',
    'androidTestCompileOnly("androidx.appcompat:appcompat:1.6.0")'
  )), false);
  assert.equal(exactApiJarOnly(gradle.replace(
    'compileOnly(files(apiClassesJar))',
    'compileOnly(project(":tauri-android"))'
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
  const appManifest = await read('app/src/main/AndroidManifest.xml');
  const testManifest = await read('app/src/androidTest/AndroidManifest.xml');
  const runner = await read('app/src/androidTest/java/com/yawf/ownedstartup/OwnedDestroyInstrumentationRunner.java');
  assert.match(appManifest, /<package android:name="com\.tgk30\.debridstreamer"\s*\/>/);
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
