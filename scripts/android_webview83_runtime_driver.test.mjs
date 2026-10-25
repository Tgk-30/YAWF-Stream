import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const driverPath = new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeWebViewCompatibilityTest.java",
  import.meta.url,
);
const manifestPath = new URL(
  "./android-runtime-instrumentation/app/src/main/AndroidManifest.xml",
  import.meta.url,
);

function count(source, needle) {
  return source.split(needle).length - 1;
}

function validateDriver(source) {
  const failures = [];
  const requireMatch = (pattern, message) => {
    if (!pattern.test(source)) failures.push(message);
  };
  const rejectMatch = (pattern, message) => {
    if (pattern.test(source)) failures.push(message);
  };

  requireMatch(/class RuntimeWebViewCompatibilityTest/, "missing dedicated driver class");
  requireMatch(/unsupportedStockWebViewShowsNativeRecoveryOnly/, "missing bounded startup test");
  requireMatch(/MINIMUM_WEBVIEW_MAJOR = 90/, "minimum WebView major is not literal 90");
  requireMatch(/DEFAULT_PROVIDER_PACKAGE = "com\.google\.android\.webview"/, "wrong stock provider package");
  requireMatch(/DEFAULT_PROVIDER_VERSION = "83\.0\.4103\.106"/, "wrong stock provider version");
  requireMatch(/DEFAULT_PROVIDER_LABEL = "Android System WebView"/, "wrong stock provider label");
  requireMatch(/fixedArgument\(\s*arguments, "expectedWebViewPackage", DEFAULT_PROVIDER_PACKAGE, SAFE_PACKAGE\)/s,
    "provider package is not a strictly validated fixed argument");
  requireMatch(/fixedArgument\(\s*arguments, "expectedWebViewVersion", DEFAULT_PROVIDER_VERSION, STRICT_VERSION\)/s,
    "provider version is not a strictly validated fixed argument");
  requireMatch(/fixedArgument\(\s*arguments, "expectedWebViewLabel", DEFAULT_PROVIDER_LABEL, SAFE_LABEL\)/s,
    "provider label is not a strictly validated fixed argument");
  requireMatch(/expectedMajor < MINIMUM_WEBVIEW_MAJOR/, "driver does not require the unsupported side of 90");
  requireMatch(/PRODUCT_ACTIVITY = PRODUCT_PACKAGE \+ "\.MainActivity"/,
    "product activity is not the exact package MainActivity");
  requireMatch(/private void launchProductNormally\(\) \{\s*Intent intent = new Intent\(Intent\.ACTION_MAIN\)\s*\.addCategory\(Intent\.CATEGORY_LAUNCHER\)\s*\.setComponent\(new ComponentName\(PRODUCT_PACKAGE, PRODUCT_ACTIVITY\)\)\s*\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK \| Intent\.FLAG_ACTIVITY_CLEAR_TASK\);\s*instrumentation\.getTargetContext\(\)\.startActivity\(intent\)/s,
    "product is not launched through the exact normal explicit launcher intent");
  if (count(source, "new ComponentName(") !== 1) {
    failures.push("the exact product launcher must be the only explicit component");
  }
  requireMatch(/checks\.put\("normalLaunchViaExplicitLauncherIntent", true\)/,
    "receipt does not record the normal explicit launcher path");

  requireMatch(/WARNING_TITLE = "Update Android System WebView"/, "wrong native warning title");
  requireMatch(/"YAWF needs Android System WebView version 90 or newer\. Selected provider: "/,
    "warning does not state literal 90 and selected provider");
  requireMatch(/expectedProviderPackage \+ ", version " \+ expectedProviderVersion/,
    "warning does not bind the expected provider package and version");
  requireMatch(/findObjects\(By\.text\(WARNING_TITLE\)\.pkg\(PRODUCT_PACKAGE\)\)/,
    "warning titles are not enumerated exactly");
  requireMatch(/assertEquals\("Expected exactly one native WebView warning title", 1, titles\.size\(\)\)/,
    "warning title is not required exactly once");
  requireMatch(/singleNativeButton\("button1", APP_INFO_BUTTON\)/,
    "App info is not bound to the exact positive native button");
  requireMatch(/singleNativeButton\("button2", CLOSE_BUTTON\)/,
    "Close YAWF is not bound to the exact negative native button");
  requireMatch(/By\.res\("android", resourceId\)\s*\.pkg\(PRODUCT_PACKAGE\)\s*\.text\(exactCaseInsensitiveLabel\(label\)\)\s*\.clickable\(true\)\s*\.enabled\(true\)/s,
    "native buttons are not package-bound, exact-label, enabled click targets");
  requireMatch(/Pattern\.CASE_INSENSITIVE \| Pattern\.UNICODE_CASE/,
    "native label matching is not exact Unicode case-insensitive");
  requireMatch(/Pattern\.quote\(label\)/, "native label is not regex-quoted");
  if (count(source, "appInfo.click();") !== 1) failures.push("App info must be clicked exactly once");
  if (count(source, "close.click();") !== 1) failures.push("Close YAWF must be clicked exactly once");

  requireMatch(/waitForForegroundPackage\(SETTINGS_PACKAGE, UI_WAIT_MS\)/,
    "real com.android.settings foreground is not required");
  requireMatch(/waitForExactTextOrDescription\(\s*expectedProviderLabel, SETTINGS_PACKAGE/s,
    "exact provider App info label is not required in Settings");
  if (count(source, "device.pressBack();") !== 1) failures.push("Settings must be left with exactly one Back");
  if ((source.match(/= assertExactCompatibilityWarning\(\);/g) ?? []).length !== 2) {
    failures.push("exact warning is not checked before and after Settings");
  }
  requireMatch(/waitForNotForegroundPackage\(PRODUCT_PACKAGE, UI_WAIT_MS\)/,
    "Close YAWF does not require the product to leave foreground");

  requireMatch(/By\.clazz\("android\.webkit\.WebView"\)\.pkg\(PRODUCT_PACKAGE\)/,
    "hidden product WebView absence is not checked");
  for (const forbidden of [
    "Enable Android update checks?",
    "Check for Android updates?",
    "Welcome to YAWF Stream",
    "How do you want to use YAWF Stream?",
    "Discover",
    "Connect to a server",
  ]) {
    if (!source.includes(`"${forbidden}"`)) failures.push(`missing forbidden-surface check: ${forbidden}`);
  }

  for (const capture of [
    "initial-native-warning",
    "provider-app-info",
    "native-warning-after-return",
    "after-close-not-foreground",
  ]) {
    if (!source.includes(`capture("${capture}")`)) failures.push(`missing evidence capture: ${capture}`);
  }
  requireMatch(/MAX_CAPTURES = 8/, "capture bound changed");
  requireMatch(/MAX_ACTION_LINES = 96/, "action bound changed");
  requireMatch(/dumpWindowHierarchy\(hierarchy\)/, "XML hierarchy is not captured");
  requireMatch(/takeScreenshot\(screenshot\)/, "screenshot is not captured");
  requireMatch(/"scope", "unsupported-webview-startup-guidance-only"/,
    "receipt is not scoped to startup guidance only");
  requireMatch(/receipt\.put\("playbackTested", false\)/, "receipt makes a playback claim");
  requireMatch(/receipt\.put\("otaTested", false\)/, "receipt makes an OTA claim");
  requireMatch(/receipt\.put\("providerInstalledOrUpdated", false\)/,
    "receipt claims the provider was installed or updated");
  requireMatch(/receipt\.put\("taskRemovalClaimed", false\)/,
    "receipt claims host-only task removal");
  requireMatch(/receipt\.put\("hostTaskRemovalCheckRequired", true\)/,
    "receipt omits the host task-removal gate");

  rejectMatch(/Settings\.|ACTION_APPLICATION_DETAILS_SETTINGS|ACTION_VIEW|market:|getPackageManager|getLaunchIntentForPackage|queryIntentActivities|getInstalledApplications|QUERY_ALL_PACKAGES/,
    "driver can query packages or launch Settings, store, or URL directly");
  rejectMatch(/executeShellCommand|evaluateJavascript|addJavascriptInterface|shared_prefs|run-as/,
    "driver uses shell, product JS, or private product state");
  rejectMatch(/grantRuntimePermission|pm grant|appops|REQUEST_INSTALL_PACKAGES/,
    "driver grants or requests installation authority");
  rejectMatch(/By\.textContains|By\.descContains/, "driver uses partial semantic selectors");
  return failures;
}

function validateManifest(source) {
  const failures = [];
  if (/uses-permission|QUERY_ALL_PACKAGES|android\.permission\.INTERNET/.test(source)) {
    failures.push("runtime driver manifest gained permission or broad package authority");
  }
  const queried = [...source.matchAll(/<package android:name="([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(queried) !== JSON.stringify(["com.yawf.stream.tv"])) {
    failures.push("existing TV-only package visibility changed");
  }
  return failures;
}

const [driver, manifest] = await Promise.all([
  readFile(driverPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);

test("unsupported WebView driver stays native, exact, bounded, and claim-limited", () => {
  assert.deepEqual(validateDriver(driver), []);
  assert.deepEqual(validateManifest(manifest), []);
});

test("driver contract rejects independent authority and evidence regressions", () => {
  const mutations = [
    ["MINIMUM_WEBVIEW_MAJOR = 90", "MINIMUM_WEBVIEW_MAJOR = 89"],
    ["new Intent(Intent.ACTION_MAIN)", "new Intent()"],
    [".addCategory(Intent.CATEGORY_LAUNCHER)", "// launcher category removed"],
    ["new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY)",
      "new ComponentName(SETTINGS_PACKAGE, PRODUCT_ACTIVITY)"],
    ['PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity"',
      'PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".OtherActivity"'],
    ["Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK",
      "Intent.FLAG_ACTIVITY_NEW_TASK"],
    ["instrumentation.getTargetContext().startActivity(intent);",
      "instrumentation.getTargetContext().getPackageManager().queryIntentActivities(intent, 0);\n        instrumentation.getTargetContext().startActivity(intent);"],
    ["com.google.android.webview", "com.example.otherwebview"],
    ["83.0.4103.106", "133.0.6943.49"],
    ["Update Android System WebView", "WebView problem"],
    ["version 90 or newer", "a recent version"],
    [
      'assertEquals("Expected exactly one native WebView warning title", 1, titles.size())',
      'assertTrue("Some warning exists", !titles.isEmpty())',
    ],
    ['singleNativeButton("button1", APP_INFO_BUTTON)', 'device.findObject(By.text(APP_INFO_BUTTON))'],
    ["waitForForegroundPackage(SETTINGS_PACKAGE, UI_WAIT_MS)",
      "waitForForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS)"],
    ["expectedProviderLabel, SETTINGS_PACKAGE", '"Settings", SETTINGS_PACKAGE'],
    ["device.pressBack();", "// Back removed"],
    ["UiObject2 close = assertExactCompatibilityWarning();", "UiObject2 close = appInfo;"],
    ["close.click();", "// Close removed"],
    ["waitForNotForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS);", "// foreground check removed"],
    ['receipt.put("playbackTested", false)', 'receipt.put("playbackTested", true)'],
    ['receipt.put("otaTested", false)', 'receipt.put("otaTested", true)'],
  ];
  for (const [before, after] of mutations) {
    assert.equal(count(driver, before), 1, `mutation site must be unique: ${before}`);
    const mutant = driver.replace(before, after);
    assert.notEqual(mutant, driver);
    assert.notDeepEqual(validateDriver(mutant), [], `semantic mutant survived: ${before}`);
  }

  for (const authorityMutation of [
    '\n// Settings.ACTION_APPLICATION_DETAILS_SETTINGS\n',
    '\n// getLaunchIntentForPackage(PRODUCT_PACKAGE)\n',
    '\n// queryIntentActivities(new Intent(Intent.ACTION_MAIN), 0)\n',
    '\n// executeShellCommand("pm grant")\n',
    '\n// evaluateJavascript("hidden")\n',
  ]) {
    assert.notDeepEqual(validateDriver(driver + authorityMutation), []);
  }

  const manifestMutant = manifest.replace(
    "<application",
    '<uses-permission android:name="android.permission.INTERNET" />\n    <application',
  );
  assert.notEqual(manifestMutant, manifest);
  assert.notDeepEqual(validateManifest(manifestMutant), []);

  const packageVisibilityMutant = manifest.replace(
    "</queries>",
    '    <package android:name="com.tgk30.debridstreamer" />\n    </queries>',
  );
  assert.notEqual(packageVisibilityMutant, manifest);
  assert.notDeepEqual(validateManifest(packageVisibilityMutant), []);
});
