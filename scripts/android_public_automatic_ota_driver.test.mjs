import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitAutomaticPublicTuple, AutomaticPublicOtaAdmissionError } from "./android_public_automatic_ota_admission.mjs";

const java = fs.readFileSync(new URL(
  "./android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
  import.meta.url,
), "utf8");

function extractMethodFrom(source, name) {
  const declaration = new RegExp(`\\bprivate\\s+[^\\n]+\\s+${name}\\(`).exec(source);
  assert.notEqual(declaration, null, `missing method ${name}`);
  const start = declaration.index;
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated method ${name}`);
}

const extractMethod = (name) => extractMethodFrom(java, name);

function validTuple(version = "2.3.31", versionCode = 2_003_031) {
  const sha = "b".repeat(64);
  const source = "a".repeat(40);
  const manifestDigest = "c".repeat(64);
  const verificationDigest = "d".repeat(64);
  const tag = `android-v${version}`;
  const apk = `YAWF.Stream_Android_${version}.apk`;
  const verificationName = `Android_${version}_verification.json`;
  const base = `https://github.com/Tgk-30/YAWF-Stream/releases/download/${tag}/`;
  return {
    release: {
      tagName: tag,
      isDraft: false,
      isPrerelease: false,
      publishedAt: "2030-01-01T00:00:00Z",
      targetCommitish: source,
      assets: [
        { name: apk, state: "uploaded", url: `${base}${apk}`, digest: `sha256:${sha}`, size: 123 },
        { name: "android-update.json", state: "uploaded", url: `${base}android-update.json`, digest: `sha256:${manifestDigest}`, size: 1 },
        { name: verificationName, state: "uploaded", url: `${base}${verificationName}`, digest: `sha256:${verificationDigest}`, size: 1 },
      ],
    },
    manifest: {
      schemaVersion: 1,
      version,
      versionCode,
      packageName: "com.tgk30.debridstreamer",
      sourceRevision: source,
      apk: { name: apk, sha256: sha, size: 123 },
    },
    verification: {
      version,
      sourceRevision: source,
      buildRun: 1234,
      apk: { name: apk, sha256: sha, size: 123 },
      certificateSha256: "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a",
      checks: { buildProvenance: { workflowRun: 1234, sourceRevision: source, canonicalSignedCandidateUnchanged: true } },
    },
  };
}

test("host admission binds one public target tuple to fail-closed instrumentation arguments", () => {
  const admitted = admitAutomaticPublicTuple(validTuple());
  assert.equal(admitted.otaMode, "automatic-initial-cancel-due-resume");
  assert.equal(admitted.baselineVersion, "2.3.27");
  assert.equal(admitted.targetVersion, "2.3.31");
  assert.equal(admitted.targetPublicRelease, "true");
  assert.equal(admitted.targetManifestSha256, "c".repeat(64));
  assert.equal(admitted.targetVerificationSha256, "d".repeat(64));
  const later = admitAutomaticPublicTuple(validTuple("2.3.32", 2_003_032));
  assert.equal(later.targetVersion, "2.3.32");
  assert.equal(later.targetApkName, "YAWF.Stream_Android_2.3.32.apk");
});

test("host admission rejects target identity and provenance mutants individually", () => {
  const mutations = [
    (v) => { v.release.isDraft = true; },
    (v) => { v.release.isPrerelease = true; },
    (v) => { v.release.assets[0].url = "https://example.com/private.apk"; },
    (v) => { v.release.assets[0].digest = `sha256:${"e".repeat(64)}`; },
    (v) => { v.manifest.versionCode = 2_003_027; },
    (v) => { v.manifest.versionCode = 2_003_030; },
    (v) => { v.manifest.versionCode = 2_003_032; },
    (v) => { v.manifest.sourceRevision = "short"; },
    (v) => { v.release.targetCommitish = "f".repeat(40); },
    (v) => { v.verification.certificateSha256 = "e".repeat(64); },
    (v) => { v.verification.checks.buildProvenance.workflowRun = 4321; },
    (v) => { v.verification.checks.buildProvenance.canonicalSignedCandidateUnchanged = false; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(validTuple());
    mutate(value);
    assert.throws(() => admitAutomaticPublicTuple(value), AutomaticPublicOtaAdmissionError);
  }
});

test("automatic driver performs the exact automatic path without manual fallback or direct intents", () => {
  const flow = extractMethod("runAutomaticFlow");
  const sequence = [
    "launchProductFromVisibleLauncher",
    "cancelInitialManualCheckBeforeResult",
    "completeNormalSetupExact",
    "seedMeaningfulLocalState",
    "automaticTriggerReturnOrdinal =\n                returnToProductThroughVisibleLauncher",
    "assertAutomaticOfferAbsentForBoundedCheck",
    "deferredOfferReturnOrdinal =\n                returnToProductThroughVisibleLauncher",
    "deferredAutomaticOfferObserved = true",
    "productInstallSelections++",
    "enterUnknownSourcePermission",
    "confirmSystemInstaller",
    "assertMeaningfulLocalState(\"warm-after-update\"",
    "dismissVisibleRecentTaskAndRelaunchThroughLauncher",
    "assertMeaningfulLocalState(\"after-task-relaunch\"",
  ];
  let offset = -1;
  for (const token of sequence) {
    const next = flow.indexOf(token, offset + 1);
    assert.ok(next > offset, `automatic flow order missing: ${token}`);
    offset = next;
  }
  for (const forbidden of ["CHECK_NOW", "tapVisibleAndroidUpdateCheckCard", "maybeLegacyManualReconsent", "startActivity(", "ComponentName"])
    assert.ok(!flow.includes(forbidden), `automatic flow contains forbidden fallback: ${forbidden}`);
});

test("cancel race, same-foreground absence and deferred offer are exact", () => {
  const cancel = extractMethod("cancelInitialManualCheckBeforeResult");
  assert.match(cancel, /Checking for updates/);
  assert.match(cancel, /Checking the official YAWF Stream Android release channel\./);
  assert.match(cancel, /assertNoInitialManualResultVisible\(\)[\s\S]*Cancel initial manual check/);
  assert.match(cancel, /device\.wait\(Until\.gone\(By\.text\(progressTitle\)\)/);
  const absent = extractMethod("assertAutomaticOfferAbsentForBoundedCheck");
  assert.match(absent, /AUTOMATIC_CHECK_BOUND_MS/);
  assert.match(absent, /fail\("Automatic offer appeared in the triggering foreground/);
  assert.match(java, /automaticDiscoveryObserved = initialManualCancelWon[\s\S]*automaticOfferAbsentSameForeground[\s\S]*deferredAutomaticOfferObserved/);
  assert.match(java, /AutomaticOtaDriverChecks\.deferredOfferIsFromLaterReturn\([\s\S]*automaticTriggerReturnOrdinal,[\s\S]*deferredOfferReturnOrdinal/);
});

test("meaningful local fixture state uses one exact text-or-description detail dialog", () => {
  const seed = extractMethod("seedMeaningfulLocalState");
  for (const exact of ["Auto OTA Profile", "Apply Quiet focus style", "Blade Runner 2049", "Automatic OTA public upgrade"])
    assert.ok(java.includes(exact), `missing exact fixture value ${exact}`);
  assert.match(seed, /Sample catalog/);
  assert.match(seed, /In watchlist/);
  assert.match(seed, /Move " \+ AUTOMATIC_SAMPLE_TITLE \+ " to folder/);
  assert.match(seed, /detailDialogIdentity = AUTOMATIC_SAMPLE_TITLE \+ " details"/);
  assert.match(seed, /waitForUniqueExactProductDialog\(detailDialogIdentity/);
  assert.match(seed, /scrollUntilVisibleInExactDialog\([\s\S]*detailDialogIdentity,[\s\S]*"Watchlist"/);
  const back = seed.indexOf("device.pressBack()");
  const gone = seed.indexOf("waitForUniqueExactProductDialogGone(detailDialogIdentity", back);
  const primary = seed.indexOf('"Primary"', gone);
  const route = seed.indexOf('navigateProductRoute("Watchlist")', primary);
  assert.ok(back >= 0 && gone > back && primary > gone && route > primary,
    "detail Back, exact disappearance, Primary nav, and Watchlist route must be ordered");
  assert.ok(!extractMethod("scrollUntilVisibleInExactDialog").includes('"Primary"'));
  const resolver = extractMethod("findUniqueExactProductDialog");
  assert.match(resolver, /By\.clazz\(DETAIL_DIALOG_CLASS\)\.pkg\(OtaFlowPolicy\.PRODUCT_PACKAGE\)/);
  assert.match(resolver, /dialog\.getText\(\)/);
  assert.match(resolver, /dialog\.getContentDescription\(\)/);
  assert.match(resolver, /AutomaticOtaDriverChecks\.uniqueExactDialogIndex/);
  assert.match(extractMethod("scrollUntilVisibleInExactDialog"),
    /findUniqueExactProductDialog\(dialogIdentity\)/);
  assert.match(extractMethod("waitForUniqueExactProductDialogGone"),
    /findUniqueExactProductDialog\(exactIdentity\)/);
  assert.match(seed, /detailClosedBeforePrimaryNavigation\([\s\S]*dialogWatchlistClickOrdinal,[\s\S]*backOrdinal,[\s\S]*dialogGoneOrdinal,[\s\S]*primaryNavigationOrdinal/);
  const compare = extractMethod("assertMeaningfulLocalState");
  assert.match(compare, /profilePersistedWarm = true/);
  assert.match(compare, /profilePersistedAfterTaskRelaunch = true/);
  assert.match(compare, /AutomaticOtaDriverChecks\.exactValueWasPreserved\([\s\S]*profileNameBeforeUpdate,[\s\S]*observedProfileName/);
  assert.match(java, /receipt\.put\("sampleCatalogFixtureUsed", sampleCatalogFixtureUsed\)/);
  assert.match(java, /receipt\.put\("liveCatalogProviderProof", false\)/);
});

test("automatic permission cleanup is visible launcher navigation", () => {
  const cleanup = extractMethod("cleanupUnknownSourcePermissionThroughVisibleSettings");
  for (const exact of ["Settings", "Apps", "Special app access", "Install unknown apps", "YAWF Stream", "Allow from this source"])
    assert.ok(cleanup.includes(`"${exact}"`), `missing cleanup step ${exact}`);
  assert.ok(!cleanup.includes("startActivity("));
  assert.ok(!cleanup.includes("ACTION_MANAGE_UNKNOWN_APP_SOURCES"));
  assert.match(cleanup, /permissionCleanupMustRun\([\s\S]*permissionEnabledByTest,[\s\S]*coreTransactionPassed/);
  assert.ok(!cleanup.includes("Automatic cleanup refused"));
  assert.ok(!cleanup.includes("Automatic cleanup requires successful"));
  assert.match(cleanup, /permissionCleanupToggleSelections\+\+[\s\S]*toggle\.click\(\)[\s\S]*permissionRevocationCompleted/);
});

test("recents dismissal uses one launcher-scoped card identity and verifies text and description absent", () => {
  const dismissal = extractMethod("dismissVisibleRecentTaskAndRelaunchThroughLauncher");
  assert.match(dismissal, /findUniqueLauncherObject\("YAWF Stream", launcherPackage, false\)/);
  assert.match(dismissal, /By\.text\("YAWF Stream"\)\.pkg\(launcherPackage\)/);
  assert.match(dismissal, /By\.desc\("YAWF Stream"\)\.pkg\(launcherPackage\)/);
  assert.match(dismissal, /visibleTaskDismissalSwipes\+\+[\s\S]*device\.swipe/);
  assert.match(dismissal, /visibleTaskDismissalCompleted\([\s\S]*exactTextAbsent,[\s\S]*exactDescriptionAbsent/);
  assert.match(java, /receipt\.put\("independentColdProcessProof", false\)/);
  assert.ok(!java.includes("profilePersistedCold"));
});

test("historical 2.3.25 to 2.3.26 modes remain isolated", () => {
  const historical = extractMethod("runHistoricalFlow");
  assert.match(historical, /OtaFlowPolicy\.NOT_NOW/);
  assert.match(historical, /OtaFlowPolicy\.CHECK_NOW/);
  assert.match(historical, /maybeLegacyManualReconsent\(\)/);
  assert.ok(!historical.includes("AUTOMATIC_OTA_MODE"));
  assert.match(java, /"strict"\.equals\(otaMode\) \|\| "legacy-manual-reconsent"\.equals\(otaMode\)/);
});

test("behavior predicates pass baseline and kill each focused mutant individually", () => {
  const checker = fileURLToPath(new URL(
    "./android-runtime-instrumentation/automatic_ota_driver_mutation_check.py",
    import.meta.url,
  ));
  const result = spawnSync("python3", [checker], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.deepEqual(report.tests.map((entry) => entry.test), [
    "dialogTextIdentity",
    "dialogDescriptionIdentity",
    "dialogPackageScope",
    "dialogClassScope",
    "dialogMissingIdentity",
    "dialogMismatchedText",
    "dialogMismatchedDescription",
    "dialogDuplicateIdentity",
    "sameForegroundBypass",
    "profileComparison",
    "detailDismissal",
    "recentsSwipe",
    "permissionToggle",
    "cleanupAfterFailure",
    "sameForegroundActualBranch",
  ]);
  report.tests.forEach((entry) => {
    assert.equal(entry.baselinePassed, true, `${entry.test} baseline failed`);
    assert.equal(entry.mutantKilled, true, `${entry.test} mutant survived`);
  });
});
