import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourcePath = new URL("./android/YawfAndroidUpdater.kt", import.meta.url);
const behaviorSourcePath = new URL("./android/YawfAndroidUpdaterBehaviorTest.kt", import.meta.url);
const source = readFileSync(sourcePath, "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("native updater exposes only the bounded Activity-owned API", () => {
  assert.match(source, /class YawfAndroidUpdater private constructor/);
  assert.match(source, /class YawfUpdateFileProvider : FileProvider\(\)/);
  assert.match(source, /fun attach\(activity: Activity\): YawfAndroidUpdater/);
  assert.match(source, /fun onResume\(\)/);
  assert.match(source, /fun onPause\(\)/);
  assert.match(source, /fun onWindowFocusChanged\(hasFocus: Boolean\)/);
  assert.match(source, /fun onDestroy\(\)/);
  assert.match(source, /fun checkManually\(\)/);
  assert.doesNotMatch(source, /@JavascriptInterface|addJavascriptInterface|WebViewCompat/);
  assert.doesNotMatch(source, /android\.util\.Log|println\(/);

  const publicFunctions = [...source.matchAll(/^  fun ([A-Za-z0-9_]+)\(/gm)].map((match) => match[1]);
  assert.deepEqual(publicFunctions.sort(), [
    "checkManually",
    "onDestroy",
    "onPause",
    "onResume",
    "onWindowFocusChanged",
  ]);
});

test("network access is consent-gated and automatic results are foreground-deferred", () => {
  assert.match(source, /private const val CONSENT_UNKNOWN = 0/);
  assert.match(source, /title = "Enable Android update checks\?"/);
  assert.match(source, /positive = "Enable"/);
  assert.match(source, /negative = "Not now"/);
  assert.match(source, /No request is sent until you enable this\./);
  assert.match(source, /if \(destroyed \|\| operation != null \|\| !hasNetworkConsent\(\)\) return/);
  assert.equal(source.match(/discoverCandidate\(\)/g)?.length, 2);
  assert.match(source, /private fun automaticChecksEnabled\(\): Boolean =\s+hasNetworkConsent\(\)/);

  const resultHandling = section(
    "persistAvailableOffer(result, deferUntilNextForeground = !manual)",
    "private fun showInitialConsentDialog",
  );
  assert.match(resultHandling, /if \(manual && resumeNumber == startedResume && activityReady\(\)\)/);
  assert.doesNotMatch(resultHandling, /if \(!manual[^)]*\)\s*\{?\s*showAvailableDialog/);
  assert.match(source, /foreground = false/);
  assert.match(source, /foreground &&\s+windowHasFocus &&\s+activity\.hasWindowFocus\(\)/);
  assert.match(source, /KEY_PENDING_CHECK_RESULT/);
  assert.match(source, /showPersistedCheckResultIfReady\(\)/);
  assert.match(source, /KEY_OFFER_NOT_BEFORE_GENERATION/);
  assert.match(source, /scheduleReadiness\(resetAttempts = true\)/);
});

test("release discovery and manifest contracts are fixed and bounded", () => {
  assert.match(source, /REPOSITORY_OWNER = "Tgk-30"/);
  assert.match(source, /REPOSITORY_NAME = "YAWF-Stream"/);
  assert.match(source, /RELEASES_PER_PAGE = 20/);
  assert.match(source, /MAX_RELEASE_PAGES = 10/);
  assert.match(source, /MAX_RELEASE_PAGE_BYTES = 1024 \* 1024/);
  assert.match(source, /MAX_MANIFEST_BYTES = 16 \* 1024/);
  assert.match(source, /MAX_APK_BYTES = 160L \* 1024L \* 1024L/);
  assert.match(source, /CHECK_DEADLINE_MS = 45_000L/);
  assert.match(source, /\^android-v\(0\|\[1-9\]\[0-9\]\{0,8\}\)/);
  assert.match(source, /"YAWF\.Stream_Android_\$version\.apk"/);
  assert.match(source, /MANIFEST_NAME = "android-update\.json"/);
  assert.match(source, /schemaVersion/);
  assert.match(source, /strictLong\(root, "schemaVersion"\) != 1L/);
  assert.match(source, /JsonDuplicateKeyScanner\(text\)\.scan\(\)/);
  assert.match(source, /Update JSON contains duplicate fields/);
  assert.match(source, /required = setOf\("schemaVersion", "version", "versionCode", "packageName", "apk"\)/);
  assert.match(source, /optional = setOf\("sourceRevision"\)/);
  assert.match(source, /required = setOf\("name", "sha256", "size"\), optional = emptySet\(\)/);
  assert.match(source, /release\.apkDigest != null && release\.apkDigest != sha256/);
  assert.match(source, /size != release\.apkSize/);
  assert.match(source, /versionCode != expectedVersionCode\(release\.semanticVersion\)/);
  assert.match(source, /MAX_RELEASE_TOTAL_BYTES = 8 \* 1024 \* 1024/);
  assert.match(source, /if \(!reachedReleaseHistoryEnd\)/);
});

test("source and redirect policy cannot be supplied by a caller", () => {
  assert.match(
    source,
    /https:\/\/api\.github\.com\/repos\/\$REPOSITORY_OWNER\/\$REPOSITORY_NAME\/releases/,
  );
  assert.match(
    source,
    /https:\/\/github\.com\/\$REPOSITORY_OWNER\/\$REPOSITORY_NAME\/releases\/download\/\$tag\/\$name/,
  );
  assert.match(
    source,
    /setOf\("github\.com", "release-assets\.githubusercontent\.com", "objects\.githubusercontent\.com"\)/,
  );
  assert.match(
    source,
    /setOf\("release-assets\.githubusercontent\.com", "objects\.githubusercontent\.com"\)/,
  );
  assert.match(source, /instanceFollowRedirects = false/);
  assert.match(source, /MAX_REDIRECTS = 5/);
  assert.match(source, /requireFinalDownloadHost\(current\)/);
  assert.match(source, /validateResolvedAssetSize\(connection, status, expectedSize\)/);
  assert.match(source, /parsed\.rawUserInfo != null/);
  assert.match(source, /parsed\.rawFragment != null/);
});

test("download, verification, permission, and installer states fail closed", () => {
  assert.match(source, /DownloadManager\.Request\(Uri\.parse\(resolvedUrl\)\)/);
  assert.match(source, /setDestinationInExternalFilesDir\(/);
  assert.match(source, /Environment\.DIRECTORY_DOWNLOADS/);
  assert.match(source, /"updates\/\$\{candidate\.apkName\}"/);
  assert.match(source, /KEY_DOWNLOAD_ID/);
  assert.match(source, /KEY_DOWNLOAD_CANDIDATE/);
  assert.match(source, /private fun reconcileDownload\(showRunningDialog: Boolean\): Boolean/);
  assert.match(source, /if \(reconcileDownload\(showRunningDialog = false\)\)/);
  assert.match(source, /downloadLocationMatches\(row\.localUri, target\)/);
  assert.match(source, /row\.total > 0L && row\.total != candidate\.size/);
  assert.match(source, /target\.length\(\) != candidate\.size/);
  assert.match(source, /copyAndHashToInternal\(candidate, source, temporary\)/);
  assert.match(source, /Os\.rename\(temporary\.absolutePath, staged\.absolutePath\)/);
  assert.match(source, /verifyStagedPackage\(candidate, staged\)/);
  assert.match(source, /val target = stagedFile\(candidate\)/);
  const installerLaunch = section("private fun launchInstaller", "private fun showDownloadingDialog");
  assert.doesNotMatch(installerLaunch, /downloadFile\(/);
  assert.doesNotMatch(installerLaunch, /resolveActivity\(/);
  assert.match(installerLaunch, /activity\.startActivity\(intent\)/);
  assert.match(installerLaunch, /catch \(_:\s*Exception\)/);
  assert.match(source, /MessageDigest\.isEqual/);
  assert.match(source, /archive\.packageName != activity\.packageName/);
  assert.match(source, /archive\.versionCode != candidate\.versionCode \|\| archive\.versionName != candidate\.version/);
  assert.match(source, /!isVersionCodeUpgrade\(archive\.versionCode, installed\.versionCode\)/);
  assert.match(source, /archive\.signers\.isEmpty\(\) \|\| archive\.signers != installed\.signers/);
  assert.match(source, /packageManager\.canRequestPackageInstalls\(\)/);
  assert.match(source, /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(source, /FileProvider\.getUriForFile\(activity, "\$\{activity\.packageName\}\.updates", target\)/);
  assert.match(source, /Intent\(Intent\.ACTION_VIEW\)/);
  assert.match(source, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(source, /DialogState\.AVAILABLE/);
  assert.match(source, /DialogState\.DOWNLOADING/);
  assert.match(source, /DialogState\.VERIFYING/);
  assert.match(source, /DialogState\.AWAITING_PERMISSION/);
  assert.match(source, /DialogState\.READY_TO_INSTALL/);
  assert.match(source, /DialogState\.RETRY/);
});

test("cadence, persisted phases, focus recovery, and private staging are wired", () => {
  const startCheck = section("private fun startCheck", "private fun showInitialConsentDialog");
  assert.doesNotMatch(startCheck, /putLong\(KEY_LAST_AUTOMATIC_CHECK/);
  assert.match(startCheck, /recordCheckSuccess\(\)/);
  assert.match(source, /AUTOMATIC_FAILURE_BACKOFF_MS = 6L \* 60L \* 60L \* 1000L/);
  assert.match(source, /recordAutomaticCheckFailure\(\)/);
  assert.match(source, /private const val PHASE_PREPARING = 1/);
  assert.match(source, /private const val PHASE_DOWNLOADING = 2/);
  assert.match(source, /private const val PHASE_STAGED = 3/);
  assert.match(
    section("private fun beginPrepareDownload", "private fun prepareDownload"),
    /persistUpdatePhase\(PHASE_PREPARING, candidate, resolvedUrlHash = null\)/,
  );
  assert.match(
    section("private fun beginPrepareDownload", "private fun prepareDownload"),
    /if \(!hasNetworkConsent\(\)\) \{\s+showRetryConsentDialog\(candidate\)/,
  );
  assert.match(source, /persistUpdatePhase\(PHASE_PREPARING, candidate, sha256Text\(resolvedUrl\)\)/);
  assert.match(source, /findOrphanDownload\(candidate, resolvedHash\)/);
  assert.doesNotMatch(
    section("private fun recoverInterruptedPrepare", "private fun requestManualCheckAfterConsent"),
    /prepareDownload\(|enqueueDownload\(/,
  );
  assert.match(source, /KEY_PHASE_NOT_BEFORE_GENERATION/);
  assert.match(source, /shouldRetryReadiness\(readinessAttempts, foreground, destroyed\)/);
  assert.match(source, /File\(activity\.filesDir, "updates"\)/);
  assert.match(source, /copyAndHashToInternal\(candidate, source, temporary\)/);
  assert.match(source, /verifyPackageIdentity\(candidate, temporary\)/);
  assert.match(source, /verifyStagedPackage\(candidate, staged\)/);
});

function filesBelow(root, predicate) {
  if (!existsSync(root)) return [];
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...filesBelow(path, predicate));
    else if (entry.isFile() && predicate(path)) matches.push(path);
  }
  return matches;
}

function newest(paths) {
  return paths.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function locateKotlinAndroidTools() {
  const home = process.env.HOME;
  const gradleModules = join(home, ".gradle/caches/modules-2/files-2.1");
  const compilers = filesBelow(
    join(gradleModules, "org.jetbrains.kotlin/kotlin-compiler-embeddable"),
    (path) => /kotlin-compiler-embeddable-[^/]+\.jar$/.test(path),
  );
  const compiler = newest(
    compilers.filter((path) => {
      const version = basename(path).match(/^kotlin-compiler-embeddable-(.+)\.jar$/)?.[1];
      return Boolean(
        version &&
          filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-stdlib/${version}`), (file) =>
            basename(file) === `kotlin-stdlib-${version}.jar`,
          ).length &&
          filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-script-runtime/${version}`), (file) =>
            file.endsWith(".jar"),
          ).length &&
          filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-reflect/${version}`), (file) =>
            file.endsWith(".jar"),
          ).length,
      );
    }),
  );
  const version = compiler && basename(compiler).match(/^kotlin-compiler-embeddable-(.+)\.jar$/)?.[1];
  if (!compiler || !version) return null;
  const stdlib = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-stdlib/${version}`), (path) =>
      basename(path) === `kotlin-stdlib-${version}.jar`,
    ),
  );
  const scriptRuntime = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-script-runtime/${version}`), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const reflect = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-reflect/${version}`), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const trove = newest(
    filesBelow(join(gradleModules, "org.jetbrains.intellij.deps/trove4j"), (path) => path.endsWith(".jar")),
  );
  const coroutines = newest(
    filesBelow(join(gradleModules, "org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm"), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const annotations = newest(
    filesBelow(join(gradleModules, "org.jetbrains/annotations"), (path) => path.endsWith(".jar")),
  );
  const coreAar = newest(
    filesBelow(join(gradleModules, "androidx.core/core"), (path) => path.endsWith(".aar")),
  );
  const androidHome = process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
  const androidJar = newest(filesBelow(join(androidHome, "platforms"), (path) => basename(path) === "android.jar"));
  const javaHome =
    process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
  const java = join(javaHome, "bin/java");
  const compilerRuntime = [compiler, stdlib, scriptRuntime, reflect, trove, coroutines, annotations];
  if (
    compilerRuntime.some((path) => !path) ||
    !androidJar ||
    !coreAar ||
    !existsSync(java) ||
    !existsSync("/usr/bin/unzip")
  ) {
    return null;
  }
  return { compilerRuntime, stdlib, annotations, coreAar, androidJar, java };
}

function ensureRealJsonJar() {
  const expectedSha256 = "3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed";
  const directory = join(tmpdir(), "yawf-android-test-deps");
  const path = join(directory, "json-20240303.jar");
  mkdirSync(directory, { recursive: true });
  const digest = () =>
    existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
  if (digest() !== expectedSha256) {
    rmSync(path, { force: true });
    const downloaded = spawnSync(
      "/usr/bin/curl",
      [
        "-fL",
        "--retry",
        "2",
        "--max-time",
        "30",
        "-o",
        path,
        "https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar",
      ],
      { encoding: "utf8" },
    );
    assert.equal(downloaded.status, 0, downloaded.stderr || downloaded.stdout);
  }
  assert.equal(digest(), expectedSha256, "org.json test runtime checksum");
  return path;
}

test("actual Kotlin parser, redirect, replay, state, and cancellation behavior", (t) => {
  const tools = locateKotlinAndroidTools();
  if (!tools) {
    t.skip("Android SDK or Kotlin compiler cache is unavailable");
    return;
  }
  const jsonJar = ensureRealJsonJar();
  const temporary = mkdtempSync(join(tmpdir(), "yawf-android-updater-behavior-"));
  try {
    const extracted = spawnSync("/usr/bin/unzip", ["-qq", tools.coreAar, "classes.jar", "-d", temporary], {
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    const outputJar = join(temporary, "YawfAndroidUpdaterBehavior.jar");
    const compile = spawnSync(
      tools.java,
      [
        "-cp",
        tools.compilerRuntime.join(":"),
        "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
        "-no-stdlib",
        "-no-reflect",
        "-jvm-target",
        "17",
        "-classpath",
        [jsonJar, tools.androidJar, join(temporary, "classes.jar"), tools.stdlib, tools.annotations].join(":"),
        "-d",
        outputJar,
        sourcePath.pathname,
        behaviorSourcePath.pathname,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
    const run = spawnSync(
      tools.java,
      [
        "-cp",
        [jsonJar, outputJar, tools.androidJar, join(temporary, "classes.jar"), tools.stdlib, tools.annotations].join(":"),
        "com.tgk30.debridstreamer.YawfAndroidUpdaterBehaviorTestKt",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /YawfAndroidUpdater behavior assertions passed: 83/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("exact updater source compiles against the installed Android SDK", (t) => {
  const home = process.env.HOME;
  const gradleModules = join(home, ".gradle/caches/modules-2/files-2.1");
  const compilers = filesBelow(
    join(gradleModules, "org.jetbrains.kotlin/kotlin-compiler-embeddable"),
    (path) => /kotlin-compiler-embeddable-[^/]+\.jar$/.test(path),
  );
  const compiler = newest(
    compilers.filter((path) => {
      const candidateVersion = basename(path).match(/^kotlin-compiler-embeddable-(.+)\.jar$/)?.[1];
      if (!candidateVersion) return false;
      return (
        filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-stdlib/${candidateVersion}`), (file) =>
          basename(file) === `kotlin-stdlib-${candidateVersion}.jar`,
        ).length > 0 &&
        filesBelow(
          join(gradleModules, `org.jetbrains.kotlin/kotlin-script-runtime/${candidateVersion}`),
          (file) => file.endsWith(".jar"),
        ).length > 0 &&
        filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-reflect/${candidateVersion}`), (file) =>
          file.endsWith(".jar"),
        ).length > 0
      );
    }),
  );
  const androidHome = process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
  const androidJar = newest(
    filesBelow(join(androidHome, "platforms"), (path) => basename(path) === "android.jar"),
  );
  const javaHome =
    process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
  const java = join(javaHome, "bin/java");
  const unzip = "/usr/bin/unzip";
  if (!compiler || !androidJar || !existsSync(java) || !existsSync(unzip)) {
    t.skip("Android SDK or Kotlin compiler cache is unavailable");
    return;
  }

  const version = basename(compiler).match(/^kotlin-compiler-embeddable-(.+)\.jar$/)?.[1];
  assert.ok(version, "compiler version must be discoverable");
  const stdlib = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-stdlib/${version}`), (path) =>
      basename(path) === `kotlin-stdlib-${version}.jar`,
    ),
  );
  const scriptRuntime = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-script-runtime/${version}`), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const reflect = newest(
    filesBelow(join(gradleModules, `org.jetbrains.kotlin/kotlin-reflect/${version}`), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const trove = newest(
    filesBelow(join(gradleModules, "org.jetbrains.intellij.deps/trove4j"), (path) => path.endsWith(".jar")),
  );
  const coroutines = newest(
    filesBelow(join(gradleModules, "org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm"), (path) =>
      path.endsWith(".jar"),
    ),
  );
  const annotations = newest(
    filesBelow(join(gradleModules, "org.jetbrains/annotations"), (path) => path.endsWith(".jar")),
  );
  const coreAar = newest(
    filesBelow(join(gradleModules, "androidx.core/core"), (path) => path.endsWith(".aar")),
  );
  const compilerRuntime = [compiler, stdlib, scriptRuntime, reflect, trove, coroutines, annotations];
  if (compilerRuntime.some((path) => !path) || !coreAar) {
    t.skip("complete Kotlin or AndroidX compiler cache is unavailable");
    return;
  }

  const temporary = mkdtempSync(join(tmpdir(), "yawf-android-updater-compile-"));
  try {
    const extracted = spawnSync(unzip, ["-qq", coreAar, "classes.jar", "-d", temporary], {
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    const result = spawnSync(
      java,
      [
        "-cp",
        compilerRuntime.join(":"),
        "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
        "-no-stdlib",
        "-no-reflect",
        "-jvm-target",
        "17",
        "-classpath",
        [androidJar, join(temporary, "classes.jar"), stdlib, annotations].join(":"),
        "-d",
        join(temporary, "YawfAndroidUpdater.jar"),
        sourcePath.pathname,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(temporary, "YawfAndroidUpdater.jar")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
