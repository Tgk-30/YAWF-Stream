import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { patchTauriAndroidProject } from "./patch_tauri_android.mjs";

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

test("patches release cleartext and third-party WebView cookies idempotently", () => {
  withFixture(({ root, app, mainActivity }) => {
    const initial = patchTauriAndroidProject({ root });
    assert.equal(initial.changed, true);
    assert.equal(initial.gradleChanged, true);
    assert.equal(initial.activityChanged, true);
    assert.equal(initial.manifestChanged, true);

    const gradle = readFileSync(join(app, "build.gradle.kts"), "utf8");
    const activity = readFileSync(mainActivity, "utf8");
    const manifest = readFileSync(join(app, "src/main/AndroidManifest.xml"), "utf8");
    assert.match(
      gradle,
      /defaultConfig \{\n        manifestPlaceholders\["usesCleartextTraffic"\] = "true"/,
    );
    assert.doesNotMatch(gradle, /usesCleartextTraffic"\] = "false"/);
    assert.match(activity, /override fun onWebViewCreate\(webView: WebView\)/);
    assert.match(activity, /setAcceptThirdPartyCookies\(webView, true\)/);
    assert.match(activity, /statusBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/);
    assert.match(activity, /navigationBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/);
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

test("migrates the exact legacy cookie activity to explicit dark transparent system bars", () => {
  withFixture(({ root, mainActivity }) => {
    patchTauriAndroidProject({ root });
    writeFileSync(mainActivity, legacyCookieActivity);

    const migrated = patchTauriAndroidProject({ root });
    assert.equal(migrated.activityChanged, true);
    assert.equal(migrated.gradleChanged, false);
    assert.equal(migrated.manifestChanged, false);
    const migratedActivity = readFileSync(mainActivity, "utf8");
    assert.equal(migratedActivity, darkSystemBarCookieActivity);
    assert.match(
      migratedActivity,
      /statusBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/,
    );
    assert.match(
      migratedActivity,
      /navigationBarStyle = SystemBarStyle\.dark\(Color\.TRANSPARENT\)/,
    );

    const repeat = patchTauriAndroidProject({ root });
    assert.equal(repeat.changed, false);
    assert.equal(readFileSync(mainActivity, "utf8"), darkSystemBarCookieActivity);
  });
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
