import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_SHA256,
  UPDATER_SHA256,
  prepareFixtureSource,
} from "./prepare_fixture_source.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PRODUCT_SOURCE = resolve(ROOT, "../../scripts/android/YawfAndroidUpdater.kt");
const GENERATED_SOURCE = join(
  ROOT,
  "app/build/generated/updater/com/yawf/consentfocusfixture/YawfAndroidUpdater.kt",
);
const ACTIVITY = join(
  ROOT,
  "app/src/main/java/com/yawf/consentfocusfixture/ConsentFocusActivity.kt",
);
const FLOW = join(
  ROOT,
  "app/src/androidTest/java/com/yawf/consentfocusfixture/ConsentFocusFlowTest.kt",
);
const APP_BUILD = join(ROOT, "app/build.gradle.kts");
const MANIFEST = join(ROOT, "app/src/main/AndroidManifest.xml");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixtureFailures(activity, flow, build, manifest) {
  const failures = [];
  const requiredActivity = [
    "class ConsentFocusActivity : Activity()",
    "RecordingExecutorService(this)",
    "constructor.isAccessible = true",
    "submissionOnMainThread = Looper.myLooper() == Looper.getMainLooper()",
    "checkingVisibleAtSubmission = owner.checkingVisibleForTest()",
    "focusRestoredBeforeSubmission = focusRestoredAfterConsent",
    "recordedFuture = command as? Future<*>",
    "return applicationContext.getSystemService(name)",
    "catch (_: WindowManager.BadTokenException)",
    "frameworkBadTokenProbeObserved = true",
    "failedDialogWindowManagerRequests = 0",
    "readinessFocusGate?.isShowing == true",
    "readinessFocusGateDismissed = true",
  ];
  const requiredFlow = [
    "clickConsentPositiveAndReadImmediateSubmissionCount()",
    '"Worker started inside the framework positive callback before consent dismissal",\n          0,',
    "ConsentFocusActivity.submissionCount == 1 && it.checkingVisibleForTest()",
    '"Duplicate focus submitted another worker", 1',
    "it.requestManualCheckForTest()",
    '"Cancel restarted a manual request queued behind CHECKING", 1',
    "scenario.moveToState(Lifecycle.State.STARTED)",
    '"Background manual intent submitted worker I/O", 0',
    "scenario.moveToState(Lifecycle.State.RESUMED)",
    "failedCheckingPresentationWaitsForANewRealReadinessEdgeWithoutWorkerOrSpin",
    '"Fixture did not prove a real AlertDialog.show BadToken failure"',
    "it.frameworkBadTokenProbeObservedForTest()",
    '"Failed presentation submitted worker I/O", 0',
    '"Failed presentation retried without a new readiness edge",\n          1,',
    "activity.failedUpdaterDialogWasClearedForTest()",
    'waitForActivity(scenario, "real framework focus loss")',
    "it.dismissReadinessFocusGateForTest()",
    'waitForActivity(scenario, "real framework focus gain")',
    "it.readinessFocusGainObservedForTest()",
    '"Real readiness edge submitted more than one worker", 1',
  ];
  for (const value of requiredActivity) if (!activity.includes(value)) failures.push(value);
  for (const value of requiredFlow) if (!flow.includes(value)) failures.push(value);
  if (flow.split("ConsentFocusActivity.submissionCount == 1 && it.checkingVisibleForTest()").length !== 4) {
    failures.push("all resumed submissions require visible CHECKING");
  }
  if (/command\.run\s*\(/.test(activity)) failures.push("recording executor runs production I/O");
  if (!build.includes('applicationId = "com.yawf.consentfocusfixture"')) {
    failures.push("unique fixture application id");
  }
  if (!build.includes(UPDATER_SHA256)) failures.push("product source digest build pin");
  if (!manifest.includes('android:label="YAWF consent focus fixture"')) {
    failures.push("test-only fixture label");
  }
  if (manifest.includes("android.permission.INTERNET")) failures.push("fixture requests network permission");
  return failures;
}

test("fixture source is an exact package-only transform of the reviewed updater", () => {
  assert.deepEqual(prepareFixtureSource(), {
    sourceSha256: UPDATER_SHA256,
    fixtureSha256: FIXTURE_SHA256,
    output: GENERATED_SOURCE,
  });
  const product = readFileSync(PRODUCT_SOURCE);
  const generated = readFileSync(GENERATED_SOURCE);
  assert.equal(sha256(product), UPDATER_SHA256);
  assert.equal(sha256(generated), FIXTURE_SHA256);
  assert.equal(
    generated.toString("utf8"),
    product
      .toString("utf8")
      .replace("package com.tgk30.debridstreamer\n", "package com.yawf.consentfocusfixture\n"),
  );
});

test("framework fixture observes real consent dismissal, focus, presentation, and cancellation ordering", () => {
  const activity = readFileSync(ACTIVITY, "utf8");
  const flow = readFileSync(FLOW, "utf8");
  const build = readFileSync(APP_BUILD, "utf8");
  const manifest = readFileSync(MANIFEST, "utf8");
  assert.deepEqual(fixtureFailures(activity, flow, build, manifest), []);

  const mutants = [
    ["executor performs submitted I/O", activity.replace("recordedFuture = command as? Future<*>", "command.run()")],
    ["positive callback permits an immediate worker", flow.replace('callback before consent dismissal",\n          0,', 'callback before consent dismissal",\n          1,')],
    ["submission no longer requires visible CHECKING", flow.replace(" && it.checkingVisibleForTest()", "")],
    ["background intent may submit", flow.replace('manual intent submitted worker I/O", 0', 'manual intent submitted worker I/O", 1')],
    ["BadToken probe is no longer required", flow.replace("it.frameworkBadTokenProbeObservedForTest()", "true")],
    ["real focus gain is no longer required", flow.replace("it.readinessFocusGainObservedForTest()", "true")],
  ];
  for (const [name, mutant] of mutants) {
    const nextActivity = name === "executor performs submitted I/O" ? mutant : activity;
    const nextFlow = name === "executor performs submitted I/O" ? flow : mutant;
    assert.notDeepEqual(fixtureFailures(nextActivity, nextFlow, build, manifest), [], name);
  }
});
