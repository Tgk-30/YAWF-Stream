#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAndroidRelativePath = "web/src-tauri/gen/android";
const cleartextPlaceholder = 'manifestPlaceholders["usesCleartextTraffic"]';

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

function patchedMainActivity(packageName) {
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

function patchFile(path, original, replacement, description) {
  const source = readFileSync(path, "utf8");
  if (source.includes(replacement)) return false;
  if (!source.includes(original)) {
    throw new Error(
      `${description} does not match the supported Tauri Android template. Refusing to patch generated sources.`,
    );
  }
  writeFileSync(path, source.replace(original, replacement));
  return true;
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
  const gradleChanged = patchFile(
    gradlePath,
    defaultConfigFalse,
    defaultConfigTrue,
    "app/build.gradle.kts",
  );
  const patchedGradle = readFileSync(gradlePath, "utf8");
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
  const replacementActivity = patchedMainActivity(packageName);
  let activityChanged = false;
  if (activity === originalActivity) {
    writeFileSync(mainActivityPath, replacementActivity);
    activityChanged = true;
  } else if (activity !== replacementActivity) {
    throw new Error(
      "Generated Android MainActivity.kt does not match the supported Tauri Android template. Refusing to patch generated sources.",
    );
  }

  return {
    androidRoot,
    changed: gradleChanged || activityChanged,
    gradleChanged,
    activityChanged,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = patchTauriAndroidProject();
  console.log(
    result.changed
      ? "Patched generated Android cleartext and WebView cookie settings."
      : "Generated Android cleartext and WebView cookie settings are already patched.",
  );
}
