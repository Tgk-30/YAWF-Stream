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

function patchedMainActivity(packageName) {
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
  const replacementActivity = patchedMainActivity(packageName);
  const activityChanged = activity === originalActivity || activity === legacyActivity;
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
      ? "Patched generated Android phone manifest, cleartext, and WebView cookie settings."
      : "Generated Android phone manifest, cleartext, and WebView cookie settings are already patched.",
  );
}
