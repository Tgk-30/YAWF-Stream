import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  PINNED_FIXTURE_SOURCE_SHA256,
  PINNED_SOURCE_REVISION,
  PINNED_UPDATER_SHA256,
} from "./prepare_fixture_source.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PREPARE = join(ROOT, "prepare_fixture_source.mjs");
const ACTIVITY = join(ROOT, "app/src/main/java/com/yawf/permissionreturnfixture/FixtureActivity.kt");
const POLICY = join(ROOT, "app/src/main/java/com/yawf/permissionreturnfixture/FixturePolicy.java");
const FLOW = join(
  ROOT,
  "app/src/androidTest/java/com/yawf/permissionreturnfixture/PermissionReturnFlowTest.java",
);
const WORKFLOW = resolve(ROOT, "../../.github/workflows/android-permission-return-fixture.yml");
const ROOT_BUILD = join(ROOT, "build.gradle.kts");
const APP_BUILD = join(ROOT, "app/build.gradle.kts");
const SETTINGS = join(ROOT, "settings.gradle.kts");
const SUCCESS_STAGE = join(ROOT, "stage_success_target.mjs");
const SUCCESS_BUILD = join(ROOT, "success-fixture/build.gradle.kts");
const SUCCESS_ACTIVITY = join(
  ROOT,
  "success-fixture/src/main/java/com/yawf/permissionreturnfixture/SuccessFixtureActivity.kt",
);
const SUCCESS_MANIFEST = join(ROOT, "success-fixture/src/main/AndroidManifest.xml");
const DRIVER_BUILD = join(ROOT, "success-driver/build.gradle.kts");
const DRIVER_MANIFEST = join(ROOT, "success-driver/src/main/AndroidManifest.xml");
const SUCCESS_DRIVER = join(
  ROOT,
  "success-driver/src/androidTest/java/com/yawf/permissionreturndriver/SuccessPermissionReturnFlowTest.java",
);
const EXPECTED_UPDATER_PIN = "bf42027e5f1aa0715d51ef68b87f4c6c209173465613896357071eebc599b565";
const EXPECTED_FIXTURE_PIN = "13204e15181c05d62f492ba074962a314ef2623415c7181528f595a8eca30c93";
const EXPECTED_SOURCE_REVISION = "9fc94a237d99b849cfc18a01085bb487915dd978";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function syntheticPinnedModule() {
  const root = mkdtempSync(join(tmpdir(), "yawf-fixture-module-"));
  const source = "package com.tgk30.debridstreamer\nclass SyntheticCandidate\n";
  const fixture = source.replace(
    "package com.tgk30.debridstreamer\n",
    "package com.yawf.permissionreturnfixture\n",
  );
  const modulePath = join(root, "prepare_fixture_source.mjs");
  const moduleSource = readFileSync(PREPARE, "utf8")
    .replace(EXPECTED_UPDATER_PIN, sha256(Buffer.from(source)))
    .replace(EXPECTED_FIXTURE_PIN, sha256(Buffer.from(fixture)));
  writeFileSync(modulePath, moduleSource);
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  return {
    root,
    source,
    fixture,
    generated: join(
      root,
      "app/src/main/java/com/yawf/permissionreturnfixture/YawfAndroidUpdater.kt",
    ),
    module,
  };
}

async function syntheticStageModule() {
  const root = mkdtempSync(join(tmpdir(), "yawf-success-stage-"));
  const modulePath = join(root, "stage_success_target.mjs");
  writeFileSync(modulePath, readFileSync(SUCCESS_STAGE));
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  return {
    root,
    output: join(root, "success-fixture/build/generated/successBaselineAssets/success-target.apk"),
    module,
  };
}

function activityFailures(source) {
  const failures = [];
  const required = [
    "androidUpdater = YawfAndroidUpdater.attach(this)",
    "super.onResume()",
    "getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)",
    "!(BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME && returningFromUnknownSourceSettings)",
    "androidUpdater.onResume()",
    "androidUpdater.onPause()\n    super.onPause()",
    "super.onWindowFocusChanged(hasFocus)\n    if (::androidUpdater.isInitialized) androidUpdater.onWindowFocusChanged(hasFocus)",
    "androidUpdater.onDestroy()\n    super.onDestroy()",
  ];
  for (const value of required) if (!source.includes(value)) failures.push(value);
  const resumeStart = source.indexOf("override fun onResume()");
  const superResume = source.indexOf("super.onResume()", resumeStart);
  const markerRead = source.indexOf("KEY_AWAITING_INSTALL_PERMISSION", resumeStart);
  const updaterResume = source.indexOf("androidUpdater.onResume()", resumeStart);
  if (!(resumeStart >= 0 && superResume > resumeStart && markerRead > superResume && updaterResume > markerRead)) {
    failures.push("initial resume forwards before the permission-return-only gate");
  }
  return failures;
}

function flowFailures(flow, policy) {
  const failures = [];
  const requiredFlow = [
    "putString(FixturePolicy.KEY_DOWNLOAD_CANDIDATE, candidate.toString())",
    "putInt(FixturePolicy.KEY_UPDATE_PHASE, FixturePolicy.PHASE_STAGED)",
    "tamperStagedBytesWithoutChangingLength();\n            toggle.click();",
    "permissionEnabled = true;\n            controlReachedTamper = true;",
    "if (BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME)",
    "assertReturnResumeOmissionBlocksVerifierRecovery();",
    "waitForTamperFailureWithoutInstaller();",
    "assertFalse(\"Tampered staged file was retained\", stagedFile.exists())",
    "FixturePolicy.PHASE_PREPARING",
    "Permission return marker survived failed verification",
    "preferences.getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)",
    "assertTrue(\"Negative control unexpectedly removed staged bytes\", stagedFile.isFile())",
    "FixturePolicy.PHASE_STAGED",
    "assertTrue(\n                \"Negative control lost its permission-return marker\"",
    "assertFalse(\"A package installer surface was observed\", installerObserved)",
    "for (String installerPackage : FixturePolicy.installerPackages())",
    "device.hasObject(By.pkg(installerPackage))",
    "try {\n                revokeUnknownSourcePermissionVisibly();\n            } catch (Throwable cleanupFailure)",
    "assertTrue(\"Unknown-source permission was not visibly revoked\", permissionRevoked)",
    "publicOtaProof\", false",
    "installProof\", false",
    "dataPreservationProof\", false",
  ];
  for (const value of requiredFlow) if (!flow.includes(value)) failures.push(value);
  const requiredPolicy = [
    "The verified update changed or became unavailable.",
    "Update preparation was interrupted. Retry when you are ready.",
    "return CHANGED_MESSAGE.equals(message) || INTERRUPTED_MESSAGE.equals(message);",
  ];
  for (const value of requiredPolicy) if (!policy.includes(value)) failures.push(value);
  if (!/for \(String message : new String\[\] \{\s*FixturePolicy\.CHANGED_MESSAGE,\s*FixturePolicy\.INTERRUPTED_MESSAGE,/m.test(flow)) {
    failures.push("bounded reviewed retry message set");
  }
  if (/verifyStaged|java\.lang\.reflect|setAccessible\s*\(/.test(flow)) {
    failures.push("private verification bypass");
  }
  if (/getWindowRoots\s*\(/.test(flow)) {
    failures.push("nonpublic UiAutomator window-root API");
  }
  if (/adb|pm install|fake feed|SIGNING_CERT/.test(flow)) {
    failures.push("forbidden install or trust shortcut");
  }
  if (flow.includes("Verifying update")) {
    failures.push("transient verification presentation asserted");
  }
  return failures;
}

function workflowFailures(source) {
  const failures = [];
  const required = [
    `CANDIDATE_SOURCE_REVISION: "${EXPECTED_SOURCE_REVISION}"`,
    `CANDIDATE_UPDATER_SHA256: ${PINNED_UPDATER_SHA256}`,
    "permissions:\n  contents: read",
    "workflow_dispatch:",
    "test \"$actual\" = \"$CANDIDATE_SOURCE_REVISION\"",
    "prepare_fixture_source.mjs",
    "- mode: positive",
    "app_task: :app:assembleDebug",
    "test_task: :app:assembleDebugAndroidTest",
    "- mode: return-resume-omitted",
    "app_task: :app:assembleNegativeControl",
    "test_task: :app:assembleNegativeControlAndroidTest",
    "receipt[\"controlReachedTamper\"] is True",
    "receipt[\"permissionVisiblyRevoked\"] is True",
    "receipt[\"verifierRecoveryObserved\"] is True",
    "receipt[\"stagedFileCleared\"] is True",
    "receipt[\"verifierRecoveryObserved\"] is False",
    "receipt[\"stagedFileCleared\"] is False",
    "actions/upload-artifact@v4",
  ];
  for (const value of required) if (!source.includes(value)) failures.push(value);
  if (/pull_request:|push:|schedule:/.test(source)) failures.push("workflow is not manual-only");
  if (/secrets\.|SIGNING|download-artifact/.test(source)) failures.push("workflow uses release or secret input");
  return failures;
}

function successFixtureFailures({ settings, build, activity, manifest, driverBuild, driverManifest, driver }) {
  const failures = [];
  const required = [
    [settings, 'include(":success-fixture")'],
    [settings, 'include(":success-driver")'],
    [build, 'create("baseline")'],
    [build, 'versionCode = 90_000_001'],
    [build, 'versionName = "90.0.1"'],
    [build, 'create("target")'],
    [build, 'versionCode = 90_000_002'],
    [build, 'versionName = "90.0.2"'],
    [build, 'sourceSets.getByName("baseline").assets.directories.add'],
    [build, '"build/generated/successBaselineAssets"'],
    [build, 'sourceSets.getByName("main").java.srcDir("../app/src/main/java")'],
    [activity, 'assets.open(TARGET_ASSET_NAME)'],
    [activity, 'check(total == BuildConfig.SUCCESS_TARGET_SIZE)'],
    [activity, 'check(digest.digest().toHex() == BuildConfig.SUCCESS_TARGET_SHA256)'],
    [activity, '.putInt(FixturePolicy.KEY_NETWORK_CONSENT, FixturePolicy.CONSENT_DECLINED)'],
    [activity, '.putBoolean(FixturePolicy.KEY_AUTOMATIC_CHECKS, false)'],
    [activity, '.putInt(FixturePolicy.KEY_UPDATE_PHASE, FixturePolicy.PHASE_STAGED)'],
    [activity, '!staged.exists()'],
    [activity, '!preferences.contains(FixturePolicy.KEY_DOWNLOAD_CANDIDATE)'],
    [activity, 'SUCCESS_RECEIPT'],
    [driverBuild, 'applicationId = "com.yawf.permissionreturndriver"'],
    [driverManifest, 'android:name=".DriverActivity"'],
    [driver, '"com.yawf.permissionreturndriver", driverContext.getPackageName()'],
    [driver, 'clickUnique(By.res("android", "button1")'],
    [driver, 'waitForUniqueInstallerButton("Update", INSTALL_WAIT_MS)'],
    [driver, 'waitForUniqueInstallerButton("Open", INSTALL_WAIT_MS)'],
    [driver, 'assertEquals("Fixture UID changed across the update", uidBefore, after.applicationInfo.uid)'],
    [driver, 'assertEquals("Fixture first-install time changed", firstInstallBefore, after.firstInstallTime)'],
    [driver, 'assertEquals("Fixture signer set changed", signersBefore, signerDigests(after))'],
    [driver, 'waitFor(By.text(SUCCESS_RECEIPT).pkg(FIXTURE_PACKAGE)'],
    [driver, 'try {\n                revokeUnknownSourcePermissionVisibly();\n            } catch (Throwable cleanupFailure)'],
    [driver, '"publicDiscoveryProof", false'],
    [driver, '"productionOtaProof", false'],
  ];
  for (const [source, value] of required) if (!source.includes(value)) failures.push(value);
  if (build.includes('sourceSets.getByName("target").assets')
      || build.includes('sourceSets.getByName("main").assets')) {
    failures.push("target recursively consumes the baseline target asset");
  }
  if (build.includes('file("build/generated/successBaselineAssets")')
      || build.includes('layout.buildDirectory.dir("generated/successBaselineAssets")')
      || build.includes("android.sourceset.disallowProvider")) {
    failures.push("non-string Android SourceSet directory or compatibility bypass");
  }
  if (manifest.includes("android.permission.INTERNET")) failures.push("success fixture has network permission");
  if (driverManifest.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
    failures.push("driver can request package installation");
  }
  if (/Intent\.ACTION_VIEW|verifyStaged|setAccessible\s*\(|pm install|adb\s/.test(driver)) {
    failures.push("driver bypasses the ordinary fixture and installer UI");
  }
  return failures;
}

test("final source pins bind the exact integrated updater and the copier remains package-only", async () => {
  assert.equal(PINNED_SOURCE_REVISION, EXPECTED_SOURCE_REVISION);
  assert.equal(PINNED_UPDATER_SHA256, EXPECTED_UPDATER_PIN);
  assert.equal(PINNED_FIXTURE_SOURCE_SHA256, EXPECTED_FIXTURE_PIN);
  const candidateSource = process.env.CANDIDATE_UPDATER_SOURCE;
  if (candidateSource) {
    const source = readFileSync(candidateSource);
    assert.equal(sha256(source), EXPECTED_UPDATER_PIN);
    assert.equal(
      sha256(Buffer.from(source.toString("utf8").replace(
        "package com.tgk30.debridstreamer\n",
        "package com.yawf.permissionreturnfixture\n",
      ))),
      EXPECTED_FIXTURE_PIN,
    );
  }

  const synthetic = await syntheticPinnedModule();
  const checkout = join(synthetic.root, "checkout");
  const candidate = join(checkout, "scripts/android/YawfAndroidUpdater.kt");
  mkdirSync(dirname(candidate), { recursive: true });
  writeFileSync(candidate, synthetic.source);
  try {
    const receipt = synthetic.module.prepareFixtureSource({
      checkout,
      sourceRevision: PINNED_SOURCE_REVISION,
    });
    assert.equal(receipt.transformation, "package-declaration-only");
    assert.equal(readFileSync(synthetic.generated, "utf8"), synthetic.fixture);
  } finally {
    rmSync(synthetic.root, { recursive: true, force: true });
  }
});

test("source admission rejects changed bytes, symlinks, and an unreviewed generated output", async () => {
  const synthetic = await syntheticPinnedModule();
  const checkout = join(synthetic.root, "checkout");
  const candidate = join(checkout, "scripts/android/YawfAndroidUpdater.kt");
  mkdirSync(dirname(candidate), { recursive: true });
  try {
    writeFileSync(candidate, `${synthetic.source}\n`);
    assert.throws(
      () => synthetic.module.prepareFixtureSource({
        checkout,
        sourceRevision: PINNED_SOURCE_REVISION,
      }),
      /does not match the reviewed/,
    );
    writeFileSync(candidate, synthetic.source);
    assert.throws(
      () => synthetic.module.prepareFixtureSource({
        checkout,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
      /source revision does not match/,
    );
    mkdirSync(dirname(synthetic.generated), { recursive: true });
    writeFileSync(synthetic.generated, "unreviewed\n");
    assert.throws(
      () => synthetic.module.prepareFixtureSource({
        checkout,
        sourceRevision: PINNED_SOURCE_REVISION,
      }),
      /Refusing to overwrite/,
    );
    rmSync(synthetic.generated, { force: true });
    rmSync(candidate);
    symlinkSync(PREPARE, candidate);
    assert.equal(lstatSync(candidate).isSymbolicLink(), true);
    assert.throws(
      () => synthetic.module.prepareFixtureSource({
        checkout,
        sourceRevision: PINNED_SOURCE_REVISION,
      }),
      /regular non-symlink/,
    );
  } finally {
    rmSync(synthetic.root, { recursive: true, force: true });
  }
});

test("positive recovery and return-resume-omitted control prove distinct bounded outcomes", () => {
  const activity = readFileSync(ACTIVITY, "utf8");
  const flow = readFileSync(FLOW, "utf8");
  const policy = readFileSync(POLICY, "utf8");
  assert.deepEqual(activityFailures(activity), []);
  assert.deepEqual(flowFailures(flow, policy), []);

  const mutants = {
    "all resumes omitted": activityFailures(activity.replace(
      "!(BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME && returningFromUnknownSourceSettings)",
      "!BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME",
    )),
    "return omission removed": activityFailures(activity.replace(
      "!(BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME && returningFromUnknownSourceSettings)",
      "true",
    )),
    "generic retry disallowed": flowFailures(
      flow,
      policy.replace(
        "return CHANGED_MESSAGE.equals(message) || INTERRUPTED_MESSAGE.equals(message);",
        "return CHANGED_MESSAGE.equals(message);",
      ),
    ),
    "stage removal unchecked": flowFailures(
      flow.replace('assertFalse("Tampered staged file was retained", stagedFile.exists());', ""),
      policy,
    ),
    "negative stage retained unchecked": flowFailures(
      flow.replace('assertTrue("Negative control unexpectedly removed staged bytes", stagedFile.isFile());', ""),
      policy,
    ),
    "await marker unchecked": flowFailures(
      flow.replace(
        'assertFalse(\n                        "Permission return marker survived failed verification",\n                        preferences.getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false));',
        "",
      ),
      policy,
    ),
    "installer allowed": flowFailures(
      flow.replace('assertFalse("A package installer surface was observed", installerObserved);', ""),
      policy,
    ),
    "cleanup removed": flowFailures(
      flow.replace("revokeUnknownSourcePermissionVisibly();", "permissionRevoked = true;"),
      policy,
    ),
  };
  for (const [name, failures] of Object.entries(mutants)) {
    assert.notDeepEqual(failures, [], name);
  }
});

test("AGP 9 uses built-in Kotlin and exposes only the bounded return-resume control variant", () => {
  const rootBuild = readFileSync(ROOT_BUILD, "utf8");
  const appBuild = readFileSync(APP_BUILD, "utf8");
  assert.match(rootBuild, /id\("com\.android\.application"\) version "9\.3\.1" apply false/);
  assert.doesNotMatch(rootBuild, /org\.jetbrains\.kotlin\.android|kotlin-gradle-plugin/);
  assert.match(appBuild, /plugins \{\s*id\("com\.android\.application"\)\s*\}/);
  assert.doesNotMatch(appBuild, /org\.jetbrains\.kotlin\.android/);
  assert.match(appBuild, /kotlin \{\s*compilerOptions \{\s*jvmTarget = JvmTarget\.JVM_17\s*\}\s*\}/);
  assert.match(appBuild, /buildConfigField\("boolean", "OMIT_PERMISSION_RETURN_ON_RESUME", "false"\)/);
  assert.match(appBuild, /create\("negativeControl"\)[\s\S]*OMIT_PERMISSION_RETURN_ON_RESUME", "true"/);
  assert.ok(appBuild.includes(`"\\"${PINNED_UPDATER_SHA256}\\""`));

  const mutants = {
    "external root plugin restored": rootBuild.replace(
      "}",
      '    id("org.jetbrains.kotlin.android") version "2.2.10" apply false\n}',
    ),
    "external app plugin restored": appBuild.replace(
      '    id("com.android.application")',
      '    id("com.android.application")\n    id("org.jetbrains.kotlin.android")',
    ),
    "control variant removed": appBuild.replace(/\s*create\("negativeControl"\) \{[\s\S]*?\n        \}\n/, "\n"),
  };
  assert.match(mutants["external root plugin restored"], /org\.jetbrains\.kotlin\.android/);
  assert.match(mutants["external app plugin restored"], /org\.jetbrains\.kotlin\.android/);
  assert.doesNotMatch(mutants["control variant removed"], /create\("negativeControl"\)/);
});

test("workflow is manual, read-only, pinned, and runs both bounded lifecycle outcomes", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.deepEqual(workflowFailures(workflow), []);
  const mutants = {
    "source equality removed": workflowFailures(workflow.replace(
      "test \"$actual\" = \"$CANDIDATE_SOURCE_REVISION\"",
      ":",
    )),
    "source hash changed": workflowFailures(workflow.replace(PINNED_UPDATER_SHA256, "0".repeat(64))),
    "negative mode removed": workflowFailures(workflow.replace("- mode: return-resume-omitted", "- mode: positive-copy")),
    "PR trigger added": workflowFailures(workflow.replace("  workflow_dispatch:", "  workflow_dispatch:\n  pull_request:")),
    "release download added": workflowFailures(workflow.replace(
      "      - name: Set up JDK 17",
      "      - uses: actions/download-artifact@v4\n      - name: Set up JDK 17",
    )),
  };
  for (const [name, failures] of Object.entries(mutants)) {
    assert.notDeepEqual(failures, [], name);
  }
});

test("success target admission pins bytes and refuses changed, linked, or unreviewed assets", async () => {
  const synthetic = await syntheticStageModule();
  const target = join(synthetic.root, "target.apk");
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128, 0x5a)]);
  writeFileSync(target, bytes);
  const digest = sha256(bytes);
  try {
    const receipt = synthetic.module.stageSuccessTarget({
      target,
      expectedSha256: digest,
      expectedSize: bytes.length,
    });
    assert.equal(receipt.targetSha256, digest);
    assert.deepEqual(readFileSync(synthetic.output), bytes);
    assert.throws(
      () => synthetic.module.stageSuccessTarget({
        target,
        expectedSha256: "0".repeat(64),
        expectedSize: bytes.length,
      }),
      /digest does not match/,
    );
    assert.throws(
      () => synthetic.module.stageSuccessTarget({
        target,
        expectedSha256: digest,
        expectedSize: bytes.length + 1,
      }),
      /size does not match/,
    );
    writeFileSync(synthetic.output, "unreviewed");
    assert.throws(
      () => synthetic.module.stageSuccessTarget({
        target,
        expectedSha256: digest,
        expectedSize: bytes.length,
      }),
      /Refusing to replace/,
    );
    const linked = join(synthetic.root, "linked.apk");
    symlinkSync(target, linked);
    assert.throws(
      () => synthetic.module.stageSuccessTarget({
        target: linked,
        expectedSha256: digest,
        expectedSize: bytes.length,
      }),
      /regular non-symlink/,
    );
  } finally {
    rmSync(synthetic.root, { recursive: true, force: true });
  }
});

test("success fixture separates target bytes and uses a surviving ordinary-UI driver", () => {
  const sources = {
    settings: readFileSync(SETTINGS, "utf8"),
    build: readFileSync(SUCCESS_BUILD, "utf8"),
    activity: readFileSync(SUCCESS_ACTIVITY, "utf8"),
    manifest: readFileSync(SUCCESS_MANIFEST, "utf8"),
    driverBuild: readFileSync(DRIVER_BUILD, "utf8"),
    driverManifest: readFileSync(DRIVER_MANIFEST, "utf8"),
    driver: readFileSync(SUCCESS_DRIVER, "utf8"),
  };
  assert.deepEqual(successFixtureFailures(sources), []);
  const mutants = {
    "target recursively includes itself": successFixtureFailures({
      ...sources,
      build: sources.build.replace(
        'sourceSets.getByName("baseline").assets.directories.add',
        'sourceSets.getByName("main").assets.directories.add',
      ),
    }),
    "File source directory restored": successFixtureFailures({
      ...sources,
      build: sources.build.replace(
        '"build/generated/successBaselineAssets"',
        'file("build/generated/successBaselineAssets")',
      ),
    }),
    "provider source directory restored": successFixtureFailures({
      ...sources,
      build: sources.build.replace(
        '"build/generated/successBaselineAssets"',
        'layout.buildDirectory.dir("generated/successBaselineAssets")',
      ),
    }),
    "target digest unchecked": successFixtureFailures({
      ...sources,
      activity: sources.activity.replace(
        'check(digest.digest().toHex() == BuildConfig.SUCCESS_TARGET_SHA256)',
        "digest.digest()",
      ),
    }),
    "driver signer continuity unchecked": successFixtureFailures({
      ...sources,
      driver: sources.driver.replace(
        'assertEquals("Fixture signer set changed", signersBefore, signerDigests(after));',
        "",
      ),
    }),
    "direct installer intent added": successFixtureFailures({
      ...sources,
      driver: sources.driver.replace(
        "launchFixture();",
        "launchFixture(); // Intent.ACTION_VIEW",
      ),
    }),
    "permission cleanup removed": successFixtureFailures({
      ...sources,
      driver: sources.driver.replace("revokeUnknownSourcePermissionVisibly();", "permissionRevoked = true;"),
    }),
  };
  for (const [name, failures] of Object.entries(mutants)) {
    assert.notDeepEqual(failures, [], name);
  }
});
