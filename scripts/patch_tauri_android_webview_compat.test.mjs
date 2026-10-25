import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  parseLeadingWebViewMajorForTest,
  patchTauriAndroidProject,
  patchedMainActivityForWebViewCompatibilityTest,
  previousPatchedMainActivityForWebViewCompatibilityTest,
  webViewStartupSupportedForTest,
} from "./patch_tauri_android.mjs";

const packageName = "com.tgk30.debridstreamer";

function count(source, needle) {
  return source.split(needle).length - 1;
}

function assertCompatibilityContract(activity) {
  const onCreate = activity.slice(
    activity.indexOf("  override fun onCreate"),
    activity.indexOf("  override fun onWebViewCreate"),
  );
  const onWebViewCreate = activity.slice(
    activity.indexOf("  override fun onWebViewCreate"),
    activity.indexOf("  override fun onResume"),
  );
  const compatibilityMethods = activity.slice(
    activity.indexOf("  private fun inspectWebViewCompatibility"),
    activity.indexOf("  private fun refreshSafeAreaInsets"),
  );

  assert.match(activity, /private const val MINIMUM_WEBVIEW_MAJOR_VERSION = 90/);
  assert.match(
    activity,
    /packageName != null &&\n        majorVersion != null &&\n        majorVersion >= MINIMUM_WEBVIEW_MAJOR_VERSION/,
  );
  assert.ok(
    onCreate.indexOf("webViewCompatibility = inspectWebViewCompatibility()") <
      onCreate.indexOf("super.onCreate(savedInstanceState)"),
  );
  assert.match(
    onCreate,
    /if \(webViewCompatibility\.supported\) \{\n      androidUpdater = YawfAndroidUpdater\.attach\(this\)\n    \}/,
  );
  assert.ok(
    onWebViewCreate.indexOf("if (!webViewCompatibility.supported)") <
      onWebViewCreate.indexOf("detachSafeAreaBridge()"),
  );
  assert.match(
    onWebViewCreate,
    /webView\.visibility = View\.INVISIBLE\n      super\.onWebViewCreate\(webView\)\n      return/,
  );
  assert.match(compatibilityMethods, /WebViewCompat\.getCurrentWebViewPackage\(this\)/);
  assert.match(
    compatibilityMethods,
    /WEBVIEW_LEADING_MAJOR\.find\(versionName\).*match\.groupValues\[1\]\.toIntOrNull\(\)/s,
  );
  assert.match(
    compatibilityMethods,
    /packageManager\.getApplicationInfo\(packageName, 0\).*installed\.packageName != packageName/s,
  );
  assert.match(compatibilityMethods, /Settings\.ACTION_APPLICATION_DETAILS_SETTINGS/);
  assert.match(compatibilityMethods, /Uri\.fromParts\("package", packageName, null\)/);
  assert.match(
    compatibilityMethods,
    /packageManager\.resolveActivity\(\n        implicitIntent,\n        PackageManager\.MATCH_SYSTEM_ONLY/,
  );
  assert.match(compatibilityMethods, /if \(!activityInfo\.exported\) return null/);
  assert.match(
    compatibilityMethods,
    /activityInfo\.applicationInfo\.flags and ApplicationInfo\.FLAG_SYSTEM == 0/,
  );
  assert.match(
    compatibilityMethods,
    /implicitIntent\.setComponent\(ComponentName\(activityInfo\.packageName, activityInfo\.name\)\)/,
  );
  assert.match(compatibilityMethods, /startActivity\(settingsIntent\)/);
  assert.match(compatibilityMethods, /\.setTitle\("Update Android System WebView"\)/);
  assert.match(compatibilityMethods, /\.setCancelable\(false\)/);
  assert.match(compatibilityMethods, /dialog\.setCanceledOnTouchOutside\(false\)/);
  assert.match(
    compatibilityMethods,
    /\.setNegativeButton\("Close YAWF"\) \{ _, _ -> finishAndRemoveTask\(\) \}/,
  );
  assert.match(compatibilityMethods, /\.setPositiveButton\("Open provider App info"\)/);
  assert.match(compatibilityMethods, /Then close and reopen YAWF/);
  assert.doesNotMatch(compatibilityMethods, /market:|https?:\/\//);
  assert.equal(count(activity, "WebViewCompat.getCurrentWebViewPackage(this)"), 1);
}

test("parses a strict leading Android WebView major without accepting malformed versions", () => {
  for (const [versionName, expected] of [
    ["83.0.4103.106", 83],
    ["89.0.4389.105", 89],
    ["90", 90],
    ["90.0.4430.210", 90],
    ["120.0-beta", 120],
    [null, null],
    [undefined, null],
    ["", null],
    [" 90.0", null],
    ["90.0 ", null],
    ["90beta", null],
    ["90.", null],
    [".90", null],
    ["-90.0", null],
    ["2147483648.0", null],
  ]) {
    assert.equal(parseLeadingWebViewMajorForTest(versionName), expected, String(versionName));
  }
});

test("fails closed at the literal provider and version boundary", () => {
  assert.equal(webViewStartupSupportedForTest("com.google.android.webview", "89.9.9.9"), false);
  assert.equal(webViewStartupSupportedForTest("com.google.android.webview", "90.0.0.0"), true);
  assert.equal(webViewStartupSupportedForTest("com.android.chrome", "126.0.6478.122"), true);
  assert.equal(webViewStartupSupportedForTest(null, "126.0.6478.122"), false);
  assert.equal(webViewStartupSupportedForTest("", "126.0.6478.122"), false);
  assert.equal(webViewStartupSupportedForTest("not-a-package", "126.0.6478.122"), false);
  assert.equal(webViewStartupSupportedForTest("com.google.android.webview", null), false);
  assert.equal(webViewStartupSupportedForTest("com.google.android.webview", "current"), false);
});

test("generates a guarded lifecycle without changing protected bridge contracts", () => {
  const previous = previousPatchedMainActivityForWebViewCompatibilityTest(packageName);
  const activity = patchedMainActivityForWebViewCompatibilityTest(packageName);

  assert.notEqual(activity, previous);
  assertCompatibilityContract(activity);
  for (const protectedNeedle of [
    'private const val SERVER_PLAYER_BRIDGE_NAME = "__YAWF_SERVER_PLAYER__"',
    'private val SERVER_PLAYER_CAPABILITY = Regex("^[A-Za-z0-9_-]{32,128}$")',
    "WebViewCompat.addWebMessageListener(",
    'setOf("*")',
    'setDataAndType(Uri.parse(pending.url), "video/*")',
    'CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)',
    "currentTopOrigin(webView) != sourceOrigin",
    "targetOrigin != sourceOrigin",
    "webView.removeJavascriptInterface(SAFE_AREA_BRIDGE_NAME)",
    "androidUpdater.checkManually()",
  ]) {
    assert.equal(count(activity, protectedNeedle), count(previous, protectedNeedle), protectedNeedle);
  }
  assert.equal(count(activity, "private lateinit var androidUpdater"), 1);
  assert.equal(count(activity, "override fun onResume()"), 1);
  assert.equal(count(activity, "override fun onDestroy()"), 1);
});

function createPreviousPatchedFixture() {
  const root = mkdtempSync(join(tmpdir(), "yawf-webview-migration-"));
  const app = join(root, "web/src-tauri/gen/android/app");
  const sourceDirectory = join(app, "src/main/java", ...packageName.split("."));
  const mainActivity = join(sourceDirectory, "MainActivity.kt");
  const updater = join(sourceDirectory, "YawfAndroidUpdater.kt");
  const manifest = join(app, "src/main/AndroidManifest.xml");
  const gradle = join(app, "build.gradle.kts");
  const updatePaths = join(app, "src/main/res/xml/yawf_update_paths.xml");
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(dirname(updatePaths), { recursive: true });
  writeFileSync(
    gradle,
    `android {
    compileSdk = 36
    namespace = "${packageName}"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "${packageName}"
        minSdk = 24
        targetSdk = 36
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
}
`,
  );
  writeFileSync(
    manifest,
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

    <application android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <provider
            android:name=".YawfUpdateFileProvider"
            android:authorities="\${applicationId}.updates"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/yawf_update_paths" />
        </provider>
    </application>
</manifest>
`,
  );
  writeFileSync(
    updater,
    readFileSync(new URL("./android/YawfAndroidUpdater.kt", import.meta.url), "utf8"),
  );
  writeFileSync(
    updatePaths,
    '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <files-path name="updates" path="updates/" />\n</paths>\n',
  );
  writeFileSync(mainActivity, previousPatchedMainActivityForWebViewCompatibilityTest(packageName));
  return { root, app, mainActivity, updater, manifest, gradle, updatePaths };
}

test("migrates the exact previous fully patched activity and is a second-pass no-op", () => {
  const fixture = createPreviousPatchedFixture();
  try {
    const preserved = [fixture.gradle, fixture.manifest, fixture.updater, fixture.updatePaths];
    const before = new Map(preserved.map((path) => [path, readFileSync(path)]));
    const first = patchTauriAndroidProject({ root: fixture.root });
    assert.deepEqual(first, {
      androidRoot: join(fixture.root, "web/src-tauri/gen/android"),
      changed: true,
      gradleChanged: false,
      activityChanged: true,
      manifestChanged: false,
    });
    assert.equal(
      readFileSync(fixture.mainActivity, "utf8"),
      patchedMainActivityForWebViewCompatibilityTest(packageName),
    );
    for (const path of preserved) assert.deepEqual(readFileSync(path), before.get(path), path);

    const migrated = readFileSync(fixture.mainActivity);
    const second = patchTauriAndroidProject({ root: fixture.root });
    assert.deepEqual(second, {
      androidRoot: join(fixture.root, "web/src-tauri/gen/android"),
      changed: false,
      gradleChanged: false,
      activityChanged: false,
      manifestChanged: false,
    });
    assert.deepEqual(readFileSync(fixture.mainActivity), migrated);
    for (const path of preserved) assert.deepEqual(readFileSync(path), before.get(path), path);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("contract check rejects security and compatibility semantic mutations", () => {
  const activity = patchedMainActivityForWebViewCompatibilityTest(packageName);
  const mutations = [
    activity.replace("MINIMUM_WEBVIEW_MAJOR_VERSION = 90", "MINIMUM_WEBVIEW_MAJOR_VERSION = 89"),
    activity.replace(">= MINIMUM_WEBVIEW_MAJOR_VERSION", "> MINIMUM_WEBVIEW_MAJOR_VERSION"),
    activity.replace("packageName != null &&\n        majorVersion", "majorVersion"),
    activity.replace(
      "Settings.ACTION_APPLICATION_DETAILS_SETTINGS",
      "Intent.ACTION_VIEW",
    ),
    activity.replace("PackageManager.MATCH_SYSTEM_ONLY", "0"),
    activity.replace(
      "implicitIntent.setComponent(ComponentName(activityInfo.packageName, activityInfo.name))",
      "implicitIntent",
    ),
    activity.replace("if (!activityInfo.exported) return null", "if (false) return null"),
    activity.replace(
      "activityInfo.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM == 0",
      "activityInfo.applicationInfo.flags == 0",
    ),
    activity.replace("finishAndRemoveTask()", "finish()"),
    activity.replace("webView.visibility = View.INVISIBLE", "webView.visibility = View.VISIBLE"),
    activity.replace(
      "if (webViewCompatibility.supported) {\n      androidUpdater = YawfAndroidUpdater.attach(this)\n    }",
      "androidUpdater = YawfAndroidUpdater.attach(this)",
    ),
  ];

  for (const mutation of mutations) {
    assert.notEqual(mutation, activity);
    assert.throws(() => assertCompatibilityContract(mutation));
  }
});
