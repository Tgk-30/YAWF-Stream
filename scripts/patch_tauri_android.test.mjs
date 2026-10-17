import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  patchTauriAndroidProject,
  previousSafeAreaMainActivityForTest,
} from "./patch_tauri_android.mjs";

const androidRoot = "web/src-tauri/gen/android/app";
const packageName = "com.tgk30.debridstreamer";
const legacyCookieActivity = `package ${packageName}

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }
}
`;
const darkSystemBarCookieActivity = `package ${packageName}

import android.graphics.Color
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }
}
`;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yawf-tauri-android-"));
  const app = join(root, androidRoot);
  const java = join(app, "src/main/java", ...packageName.split("."));
  mkdirSync(java, { recursive: true });
  writeFileSync(
    join(app, "build.gradle.kts"),
    `android {
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "${packageName}"
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
}
`,
  );
  writeFileSync(
    join(app, "src/main/AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <!-- AndroidTV support -->
    <uses-feature android:name="android.software.leanback" android:required="false" />

    <application
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/Theme.debridstreamer"
        android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:launchMode="singleTask"
            android:label="@string/main_activity_title"
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <!-- AndroidTV support -->
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
          android:name="androidx.core.content.FileProvider"
          android:authorities="\${applicationId}.fileprovider"
          android:exported="false"
          android:grantUriPermissions="true">
          <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_paths" />
        </provider>
    </application>
</manifest>
`,
  );
  writeFileSync(
    join(java, "MainActivity.kt"),
    `package ${packageName}

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`,
  );
  return { root, app, mainActivity: join(java, "MainActivity.kt") };
}

function withFixture(run) {
  const fixture = createFixture();
  try {
    run(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("patches the origin-attested Server Mode player bridge idempotently", () => {
  withFixture(({ root, app, mainActivity }) => {
    const initial = patchTauriAndroidProject({ root });
    assert.equal(initial.changed, true);
    assert.equal(initial.gradleChanged, true);
    assert.equal(initial.activityChanged, true);
    assert.equal(initial.manifestChanged, true);
    const updater = readFileSync(join(dirname(mainActivity), "YawfAndroidUpdater.kt"), "utf8");
    assert.match(updater, /class YawfAndroidUpdater/);
    assert.doesNotMatch(updater, /@JavascriptInterface/);
    const updatePaths = readFileSync(join(app, "src/main/res/xml/yawf_update_paths.xml"), "utf8");
    assert.match(updatePaths, /<files-path name="updates" path="updates\/" \/>/);
    assert.doesNotMatch(updatePaths, /root-path|cache-path|external-path|external-files-path/);


    const gradle = readFileSync(join(app, "build.gradle.kts"), "utf8");
    const activity = readFileSync(mainActivity, "utf8");
    const manifest = readFileSync(join(app, "src/main/AndroidManifest.xml"), "utf8");
    assert.match(
      gradle,
      /defaultConfig \{\n        manifestPlaceholders\["usesCleartextTraffic"\] = "true"/,
    );
    assert.doesNotMatch(gradle, /usesCleartextTraffic"\] = "false"/);
    assert.equal(
      gradle.match(/implementation\("androidx\.webkit:webkit:1\.14\.0"\)/g)?.length,
      1,
    );
    assert.match(manifest, /android.permission.REQUEST_INSTALL_PACKAGES/);
    assert.match(manifest, /android:name=".YawfUpdateFileProvider"/);
    assert.match(manifest, /android:authorities="\$\{applicationId\}.updates"/);
    assert.match(activity, /androidUpdater = YawfAndroidUpdater.attach\(this\)/);
    assert.match(activity, /override fun onResume\(\)/);
    assert.match(activity, /override fun onPause\(\)/);
    assert.match(activity, /@Keep\n  fun checkAndroidUpdates\(\)/);
    assert.match(activity, /override fun onWebViewCreate\(webView: WebView\)/);
    assert.match(activity, /setAcceptThirdPartyCookies\(webView, true\)/);
    assert.match(activity, /statusBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/);
    assert.match(activity, /navigationBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/);
    assert.equal(activity.match(/@JavascriptInterface/g)?.length, 1);
    assert.equal(activity.match(/addJavascriptInterface/g)?.length, 1);
    assert.match(activity, /private const val SERVER_PLAYER_BRIDGE_NAME = "__YAWF_SERVER_PLAYER__"/);
    assert.match(activity, /WebViewFeature\.WEB_MESSAGE_LISTENER/);
    assert.match(activity, /WebViewCompat\.addWebMessageListener\(/);
    assert.match(activity, /setOf\("\*"\)/);
    assert.match(activity, /message\.type == WebMessageCompat\.TYPE_STRING/);
    const messageListener = activity.slice(
      activity.indexOf("WebViewCompat.addWebMessageListener"),
      activity.indexOf("private fun handleServerPlayerMessage"),
    );
    assert.ok(messageListener.indexOf("isMainFrame &&") < messageListener.indexOf("message.data"));
    assert.ok(
      messageListener.indexOf("safeAreaWebView === view") < messageListener.indexOf("message.data"),
    );
    assert.ok(
      messageListener.indexOf("message.type == WebMessageCompat.TYPE_STRING") <
        messageListener.indexOf("message.data"),
    );
    assert.match(activity, /!isMainFrame/);
    assert.match(activity, /currentTopOrigin\(webView\) != sourceOrigin/);
    assert.match(activity, /sourceOriginUri: Uri/);
    assert.match(activity, /pending\.replyProxy !== replyProxy/);
    assert.match(activity, /pending\.challenge != challenge/);
    assert.match(activity, /SERVER_PLAYER_TIMEOUT_MS = 30_000L/);
    assert.match(activity, /SERVER_PLAYER_RATE_LIMIT = 4/);
    assert.match(activity, /serverPlayerPending != null/);
    assert.match(activity, /keys == setOf\("action", "requestId"\)/);
    assert.match(activity, /keys == setOf\("action", "requestId", "challenge"\)/);
    assert.match(activity, /keys != setOf\("action", "requestId", "url"\)/);
    assert.match(activity, /segments\[routeIndex\] != "api"/);
    assert.match(activity, /segments\[routeIndex \+ 1\] != "external-stream"/);
    assert.match(activity, /path\.contains\('%'\)/);
    assert.match(activity, /targetOrigin != sourceOrigin/);
    assert.match(activity, /uri\.encodedQuery != null/);
    assert.match(activity, /uri\.encodedFragment != null/);
    assert.match(activity, /parsedHost\.removePrefix\("\["\)\.removeSuffix\("\]"\)/);
    assert.match(activity, /if \(host\.isEmpty\(\) \|\| host\.contains\('\['\) \|\| host\.contains\('\]'\)\) return null/);
    assert.match(activity, /setTitle\("Open external player\?"\)/);
    assert.match(activity, /setPositiveButton\("Open player"\)/);
    assert.match(activity, /setNegativeButton\("Cancel"\)/);
    assert.match(activity, /pending\.origin\.display\(\)/);
    assert.doesNotMatch(activity, /setMessage\([^)]*pending\.url/s);
    assert.match(activity, /Intent\(Intent\.ACTION_VIEW\)/);
    assert.match(activity, /setDataAndType\(Uri\.parse\(pending\.url\), "video\/\*"\)/);
    assert.match(activity, /WebViewCompat\.removeWebMessageListener/);
    assert.doesNotMatch(activity, /mobile_open_external_player/);
    assert.match(
      activity,
      /private const val SAFE_AREA_BRIDGE_NAME = "__YAWF_NATIVE_SAFE_AREA__"/,
    );
    assert.match(activity, /@Keep\nclass YawfSafeAreaBridge\(/);
    assert.match(activity, /fun getInsets\(\): String = snapshot\.get\(\)/);
    const bridgeClass = activity.slice(
      activity.indexOf("@Keep\nclass YawfSafeAreaBridge"),
      activity.indexOf("\n\nclass MainActivity"),
    );
    assert.doesNotMatch(bridgeClass, /WebView|Activity|Context|Intent/);
    assert.match(activity, /private val safeAreaSnapshot = AtomicReference\(EMPTY_SAFE_AREA\)/);
    assert.match(activity, /webView\.addJavascriptInterface\(safeAreaBridge, SAFE_AREA_BRIDGE_NAME\)/);
    assert.ok(
      activity.indexOf("webView.addJavascriptInterface") <
        activity.indexOf("super.onWebViewCreate(webView)"),
    );
    assert.match(activity, /val windowInsets = webView\.rootWindowInsets \?: return/);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      assert.match(activity, new RegExp(`systemWindowInset${side}\\.coerceAtLeast\\(0\\)`));
      assert.match(activity, new RegExp(`safeInset${side}\\.coerceAtLeast\\(0\\)`));
    }
    assert.match(activity, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.P/);
    assert.match(activity, /addOnLayoutChangeListener\(layoutListener\)/);
    assert.match(activity, /addOnGlobalLayoutListener\(globalLayoutListener\)/);
    assert.match(activity, /override fun onConfigurationChanged\(newConfig: Configuration\)/);
    assert.match(activity, /removeOnLayoutChangeListener/);
    assert.match(activity, /removeOnGlobalLayoutListener/);
    assert.match(activity, /removeJavascriptInterface\(SAFE_AREA_BRIDGE_NAME\)/);
    assert.match(
      activity,
      /private const val SAFE_AREA_CHANGE_SCRIPT = "window\.dispatchEvent\(new Event\('yawf-native-safe-area-change'\)\)"/,
    );
    assert.match(activity, /safeAreaSnapshot\.getAndSet\(nextSnapshot\) != nextSnapshot/);
    assert.match(activity, /webView\.evaluateJavascript\(SAFE_AREA_CHANGE_SCRIPT, null\)/);
    assert.match(activity, /if \(safeAreaWebView !== webView\) return/);
    const detachStart = activity.indexOf("  private fun detachSafeAreaBridge()");
    assert.ok(detachStart >= 0, "detachSafeAreaBridge must exist");
    const detachBody = activity.slice(detachStart);
    const resetSnapshotIndex = detachBody.indexOf("safeAreaSnapshot.set(EMPTY_SAFE_AREA)");
    const nullableWebViewIndex = detachBody.indexOf("val webView = safeAreaWebView ?: return");
    assert.ok(resetSnapshotIndex >= 0, "detach must reset the cached snapshot");
    assert.ok(nullableWebViewIndex >= 0, "detach must retain its nullable WebView guard");
    assert.ok(
      resetSnapshotIndex < nullableWebViewIndex,
      "detach must reset the cached snapshot before its nullable WebView guard",
    );
    const createStart = activity.indexOf("  override fun onWebViewCreate");
    const createEnd = activity.indexOf("  override fun onConfigurationChanged");
    assert.ok(createStart >= 0, "onWebViewCreate must exist");
    assert.ok(createEnd > createStart, "onWebViewCreate must end before configuration handling");
    const createBody = activity.slice(createStart, createEnd);
    const detachPreviousIndex = createBody.indexOf("detachSafeAreaBridge()");
    const attachNewIndex = createBody.indexOf("safeAreaWebView = webView");
    assert.ok(detachPreviousIndex >= 0, "replacement must detach the prior bridge");
    assert.ok(attachNewIndex >= 0, "replacement must retain the new WebView identity");
    assert.ok(
      detachPreviousIndex < attachNewIndex,
      "replacement must detach the prior bridge before retaining the new WebView",
    );
    assert.doesNotMatch(activity, /setWebViewClient|setOnApplyWindowInsetsListener/);
    assert.doesNotMatch(manifest, /android\.software\.leanback/);
    assert.doesNotMatch(manifest, /LEANBACK_LAUNCHER/);
    assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
    assert.match(manifest, /android\.permission\.INTERNET/);
    assert.match(manifest, /androidx\.core\.content\.FileProvider/);

    const repeat = patchTauriAndroidProject({ root });
    assert.deepEqual(repeat, {
      androidRoot: join(root, "web/src-tauri/gen/android"),
      changed: false,
      gradleChanged: false,
      activityChanged: false,
      manifestChanged: false,
    });
  });
});

test("migrates every exact earlier activity including the safe-area template", () => {
  for (const previousActivity of [
    legacyCookieActivity,
    darkSystemBarCookieActivity,
    previousSafeAreaMainActivityForTest(packageName),
  ]) {
    withFixture(({ root, mainActivity }) => {
      patchTauriAndroidProject({ root });
      writeFileSync(mainActivity, previousActivity);

      const migrated = patchTauriAndroidProject({ root });
      assert.equal(migrated.activityChanged, true);
      assert.equal(migrated.gradleChanged, false);
      assert.equal(migrated.manifestChanged, false);
      const migratedActivity = readFileSync(mainActivity, "utf8");
      assert.notEqual(migratedActivity, previousActivity);
      assert.match(
        migratedActivity,
        /statusBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/,
      );
      assert.match(
        migratedActivity,
        /navigationBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/,
      );
      assert.match(migratedActivity, /@Keep\nclass YawfSafeAreaBridge/);
      assert.match(migratedActivity, /AtomicReference\(EMPTY_SAFE_AREA\)/);
      assert.match(migratedActivity, /WebViewCompat\.addWebMessageListener/);
      assert.match(migratedActivity, /pending\.replyProxy !== replyProxy/);
      assert.equal(migratedActivity.match(/@JavascriptInterface/g)?.length, 1);

      const repeat = patchTauriAndroidProject({ root });
      assert.equal(repeat.changed, false);
      assert.equal(readFileSync(mainActivity, "utf8"), migratedActivity);
    });
  }
});

test("fails closed when the generated Tauri template drifts", () => {
  withFixture(({ root, app }) => {
    const gradlePath = join(app, "build.gradle.kts");
    writeFileSync(
      gradlePath,
      readFileSync(gradlePath, "utf8").replace(
        'manifestPlaceholders["usesCleartextTraffic"] = "false"',
        'manifestPlaceholders["usesCleartextTraffic"] = false',
      ),
    );
    assert.throws(
      () => patchTauriAndroidProject({ root }),
      /does not match the supported Tauri Android template/,
    );
  });

  withFixture(({ root, mainActivity }) => {
    writeFileSync(
      mainActivity,
      readFileSync(mainActivity, "utf8").replace(
        "import androidx.activity.enableEdgeToEdge",
        "import androidx.activity.EdgeToEdge",
      ),
    );
    assert.throws(
      () => patchTauriAndroidProject({ root }),
      /does not match the supported Tauri Android template/,
    );
  });

  withFixture(({ root, app, mainActivity }) => {
    patchTauriAndroidProject({ root });
    const gradlePath = join(app, "build.gradle.kts");
    const initialGradle = readFileSync(gradlePath, "utf8");
    writeFileSync(
      mainActivity,
      readFileSync(mainActivity, "utf8").replace(
        "  fun getInsets(): String = snapshot.get()",
        "  fun getInsets(): String = snapshot.get()\n\n  @JavascriptInterface\n  fun extra(): String = snapshot.get()",
      ),
    );
    assert.throws(
      () => patchTauriAndroidProject({ root }),
      /does not match the supported Tauri Android template/,
    );
    assert.equal(readFileSync(gradlePath, "utf8"), initialGradle);
  });

  withFixture(({ root, app, mainActivity }) => {
    patchTauriAndroidProject({ root });
    const gradlePath = join(app, "build.gradle.kts");
    const initialGradle = readFileSync(gradlePath, "utf8");
    writeFileSync(
      mainActivity,
      readFileSync(mainActivity, "utf8").replace(
        "private const val SERVER_PLAYER_TIMEOUT_MS = 30_000L",
        "private const val SERVER_PLAYER_TIMEOUT_MS = 60_000L",
      ),
    );
    assert.throws(
      () => patchTauriAndroidProject({ root }),
      /does not match the supported Tauri Android template/,
    );
    assert.equal(readFileSync(gradlePath, "utf8"), initialGradle);
  });

  withFixture(({ root, app }) => {
    const gradlePath = join(app, "build.gradle.kts");
    const initialGradle = readFileSync(gradlePath, "utf8");
    const manifestPath = join(app, "src/main/AndroidManifest.xml");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace(
        'android:name="android.software.leanback" android:required="false"',
        'android:name="android.software.leanback" android:required="true"',
      ),
    );
    assert.throws(
      () => patchTauriAndroidProject({ root }),
      /does not match the supported Tauri Android phone template/,
    );
    assert.equal(readFileSync(gradlePath, "utf8"), initialGradle);
  });
});
