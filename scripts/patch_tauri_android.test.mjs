import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { patchTauriAndroidProject } from "./patch_tauri_android.mjs";

const androidRoot = "web/src-tauri/gen/android/app";
const packageName = "com.tgk30.debridstreamer";

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
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:usesCleartextTraffic="\${usesCleartextTraffic}" />
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

    const gradle = readFileSync(join(app, "build.gradle.kts"), "utf8");
    const activity = readFileSync(mainActivity, "utf8");
    assert.match(
      gradle,
      /defaultConfig \{\n        manifestPlaceholders\["usesCleartextTraffic"\] = "true"/,
    );
    assert.doesNotMatch(gradle, /usesCleartextTraffic"\] = "false"/);
    assert.match(activity, /override fun onWebViewCreate\(webView: WebView\)/);
    assert.match(activity, /setAcceptThirdPartyCookies\(webView, true\)/);

    const repeat = patchTauriAndroidProject({ root });
    assert.deepEqual(repeat, {
      androidRoot: join(root, "web/src-tauri/gen/android"),
      changed: false,
      gradleChanged: false,
      activityChanged: false,
    });
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
});
