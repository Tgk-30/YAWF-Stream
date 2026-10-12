#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAndroidRelativePath = "web/src-tauri/gen/android";
const cleartextPlaceholder = 'manifestPlaceholders["usesCleartextTraffic"]';
const leanbackFeatureTemplate = `    <!-- AndroidTV support -->
    <uses-feature android:name="android.software.leanback" android:required="false" />

`;
const leanbackCategoryTemplate = `                <!-- AndroidTV support -->
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
`;

function findMainActivity(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const result = findMainActivity(path);
      if (result != null) return result;
    } else if (entry.isFile() && entry.name === "MainActivity.kt") {
      return path;
    }
  }
  return null;
}

function expectedMainActivity(packageName) {
  return `package ${packageName}

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;
}

function legacyPatchedMainActivity(packageName) {
  return `package ${packageName}

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
}

function darkSystemBarPatchedMainActivity(packageName) {
  return `package ${packageName}

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
}

function patchedMainActivity(packageName) {
  return `package ${packageName}

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max

private const val SAFE_AREA_BRIDGE_NAME = "__YAWF_NATIVE_SAFE_AREA__"
private const val SAFE_AREA_CHANGE_SCRIPT = "window.dispatchEvent(new Event('yawf-native-safe-area-change'))"
private const val EMPTY_SAFE_AREA = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"

@Keep
class YawfSafeAreaBridge(
  private val snapshot: AtomicReference<String>,
) {
  @JavascriptInterface
  fun getInsets(): String = snapshot.get()
}

class MainActivity : TauriActivity() {
  private val safeAreaSnapshot = AtomicReference(EMPTY_SAFE_AREA)
  private val safeAreaBridge = YawfSafeAreaBridge(safeAreaSnapshot)
  private var safeAreaWebView: WebView? = null
  private var safeAreaLayoutListener: View.OnLayoutChangeListener? = null
  private var safeAreaGlobalLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    detachSafeAreaBridge()
    safeAreaWebView = webView
    webView.addJavascriptInterface(safeAreaBridge, SAFE_AREA_BRIDGE_NAME)

    val layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      refreshSafeAreaInsets(webView)
    }
    val globalLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
      refreshSafeAreaInsets(webView)
    }
    safeAreaLayoutListener = layoutListener
    safeAreaGlobalLayoutListener = globalLayoutListener
    webView.addOnLayoutChangeListener(layoutListener)
    webView.viewTreeObserver.addOnGlobalLayoutListener(globalLayoutListener)
    webView.post { refreshSafeAreaInsets(webView) }

    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    super.onWebViewCreate(webView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    safeAreaWebView?.post { safeAreaWebView?.let(::refreshSafeAreaInsets) }
  }

  override fun onDestroy() {
    detachSafeAreaBridge()
    super.onDestroy()
  }

  private fun refreshSafeAreaInsets(webView: WebView) {
    if (safeAreaWebView !== webView) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      webView.post { refreshSafeAreaInsets(webView) }
      return
    }
    val windowInsets = webView.rootWindowInsets ?: return
    var top = windowInsets.systemWindowInsetTop.coerceAtLeast(0)
    var right = windowInsets.systemWindowInsetRight.coerceAtLeast(0)
    var bottom = windowInsets.systemWindowInsetBottom.coerceAtLeast(0)
    var left = windowInsets.systemWindowInsetLeft.coerceAtLeast(0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      windowInsets.displayCutout?.let { cutout ->
        top = max(top, cutout.safeInsetTop.coerceAtLeast(0))
        right = max(right, cutout.safeInsetRight.coerceAtLeast(0))
        bottom = max(bottom, cutout.safeInsetBottom.coerceAtLeast(0))
        left = max(left, cutout.safeInsetLeft.coerceAtLeast(0))
      }
    }
    val nextSnapshot =
      "{\\"top\\":$top,\\"right\\":$right,\\"bottom\\":$bottom,\\"left\\":$left}"
    if (safeAreaSnapshot.getAndSet(nextSnapshot) != nextSnapshot && safeAreaWebView === webView) {
      webView.evaluateJavascript(SAFE_AREA_CHANGE_SCRIPT, null)
    }
  }

  private fun detachSafeAreaBridge() {
    safeAreaSnapshot.set(EMPTY_SAFE_AREA)
    val webView = safeAreaWebView ?: return
    safeAreaLayoutListener?.let(webView::removeOnLayoutChangeListener)
    safeAreaGlobalLayoutListener?.let { listener ->
      if (webView.viewTreeObserver.isAlive) {
        webView.viewTreeObserver.removeOnGlobalLayoutListener(listener)
      }
    }
    webView.removeJavascriptInterface(SAFE_AREA_BRIDGE_NAME)
    safeAreaLayoutListener = null
    safeAreaGlobalLayoutListener = null
    safeAreaWebView = null
  }
}
`;
}

function replacementState(source, original, replacement, description) {
  if (source.includes(replacement)) return { changed: false, output: source };
  if (!source.includes(original)) {
    throw new Error(
      `${description} does not match the supported Tauri Android template. Refusing to patch generated sources.`,
    );
  }
  return { changed: true, output: source.replace(original, replacement) };
}

export function patchTauriAndroidProject({ root = repositoryRoot } = {}) {
  const androidRoot = join(root, generatedAndroidRelativePath);
  const appRoot = join(androidRoot, "app");
  const gradlePath = join(appRoot, "build.gradle.kts");
  const manifestPath = join(appRoot, "src/main/AndroidManifest.xml");
  const sourceRoot = join(appRoot, "src/main/java");
  for (const path of [gradlePath, manifestPath, sourceRoot]) {
    if (!existsSync(path)) {
      throw new Error(
        `Generated Android project is incomplete at ${relative(root, androidRoot) || generatedAndroidRelativePath}. Run tauri android init before patching.`,
      );
    }
  }

  const gradle = readFileSync(gradlePath, "utf8");
  const manifest = readFileSync(manifestPath, "utf8");
  if (!manifest.includes('android:usesCleartextTraffic="${usesCleartextTraffic}"')) {
    throw new Error(
      "AndroidManifest.xml does not match the supported Tauri Android template. Refusing to patch generated sources.",
    );
  }

  const defaultConfigFalse = `defaultConfig {
        ${cleartextPlaceholder} = "false"
        applicationId = `;
  const defaultConfigTrue = `defaultConfig {
        ${cleartextPlaceholder} = "true"
        applicationId = `;
  const gradleState = replacementState(
    gradle,
    defaultConfigFalse,
    defaultConfigTrue,
    "app/build.gradle.kts",
  );
  const patchedGradle = gradleState.output;
  if (
    !patchedGradle.includes(defaultConfigTrue) ||
    !patchedGradle.includes(`getByName("debug") {
            ${cleartextPlaceholder} = "true"`) ||
    patchedGradle.includes(`${cleartextPlaceholder} = "false"`)
  ) {
    throw new Error(
      "Generated Android cleartext settings do not leave release playback enabled. Refusing to patch generated sources.",
    );
  }

  const mainActivityPath = findMainActivity(sourceRoot);
  if (mainActivityPath == null) {
    throw new Error(
      "Generated Android MainActivity.kt is missing. Refusing to patch generated sources.",
    );
  }
  const activity = readFileSync(mainActivityPath, "utf8");
  const packageName = /^package\s+([A-Za-z_][A-Za-z0-9_.]*)$/m.exec(activity)?.[1];
  if (packageName == null) {
    throw new Error(
      "Generated Android MainActivity.kt has no supported package declaration. Refusing to patch generated sources.",
    );
  }
  const originalActivity = expectedMainActivity(packageName);
  const legacyActivity = legacyPatchedMainActivity(packageName);
  const darkSystemBarActivity = darkSystemBarPatchedMainActivity(packageName);
  const replacementActivity = patchedMainActivity(packageName);
  const activityChanged =
    activity === originalActivity ||
    activity === legacyActivity ||
    activity === darkSystemBarActivity;
  if (!activityChanged && activity !== replacementActivity) {
    throw new Error(
      "Generated Android MainActivity.kt does not match the supported Tauri Android template. Refusing to patch generated sources.",
    );
  }

  const hasLeanbackFeature = manifest.includes(leanbackFeatureTemplate);
  const hasLeanbackCategory = manifest.includes(leanbackCategoryTemplate);
  const hasAnyLeanback =
    manifest.includes("android.software.leanback") ||
    manifest.includes("android.intent.category.LEANBACK_LAUNCHER");
  if (hasLeanbackFeature !== hasLeanbackCategory || (!hasLeanbackFeature && hasAnyLeanback)) {
    throw new Error(
      "AndroidManifest.xml does not match the supported Tauri Android phone template. Refusing to patch generated sources.",
    );
  }
  const manifestChanged = hasLeanbackFeature && hasLeanbackCategory;
  const patchedManifest = manifestChanged
    ? manifest
        .replace(leanbackFeatureTemplate, "")
        .replace(leanbackCategoryTemplate, "")
    : manifest;

  // Validate every generated template before the first write. A drifted
  // MainActivity or manifest must not leave a half-patched Gradle file behind.
  if (gradleState.changed) writeFileSync(gradlePath, patchedGradle);
  if (activityChanged) writeFileSync(mainActivityPath, replacementActivity);
  if (manifestChanged) writeFileSync(manifestPath, patchedManifest);

  return {
    androidRoot,
    changed: gradleState.changed || activityChanged || manifestChanged,
    gradleChanged: gradleState.changed,
    activityChanged,
    manifestChanged,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = patchTauriAndroidProject();
  console.log(
    result.changed
      ? "Patched generated Android phone manifest, cleartext, cookies, and safe-area bridge."
      : "Generated Android phone manifest, cleartext, cookies, and safe-area bridge are already patched.",
  );
}
