import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultJava = path.join(
  root,
  "scripts/android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeOtaFlowTest.java",
);
const sourcePath = process.env.FIXED42_JAVA_SOURCE == null
  ? defaultJava
  : path.resolve(process.env.FIXED42_JAVA_SOURCE);
const source = fs.readFileSync(sourcePath, "utf8");

function methodBody(java, name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?:throws\\s+[^\\{]+)?\\{`, "m");
  const match = signature.exec(java);
  assert.notEqual(match, null, `missing Java method ${name}`);
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < java.length; index += 1) {
    const character = java[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return java.slice(open + 1, index);
  }
  assert.fail(`unterminated Java method ${name}`);
}

function need(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function rejectMutation(body, original, replacement, contract) {
  need(body, original, `mutation anchor is missing: ${original}`);
  assert.throws(() => contract(body.replace(original, replacement)));
}

function initialEnableContract(body) {
  for (const token of [
    "Configurator.getInstance()",
    "setWaitForIdleTimeout(0L)",
    'By.res("android", "button1")',
    'Pattern.compile("\\\\AEnable\\\\z", Pattern.CASE_INSENSITIVE)',
    "assertNoBindingTermsAtCurrentIdlePolicy()",
    "freshEnables.get(0).click()",
    "instrumentation.getUiAutomation().clearCache()",
    'nativeDialogText(progressTitle)',
    'nativeDialogText(progressMessage)',
    'By.res("android", "button2")',
    'Pattern.compile("\\\\ACancel\\\\z", Pattern.CASE_INSENSITIVE)',
    "assertNoInitialEnableResultVisibleAtCurrentIdlePolicy()",
    "initialEnableCancelSelections++",
    'assertEquals("Initial Enable Cancel must be selected exactly once"',
    "initialEnableSettledResultExclusionSamples = settled",
    "initialEnableCancelWon = true",
    "configurator.setWaitForIdleTimeout(previousIdleTimeout)",
    'capture("fixed42-initial-enable-cancel-settled")',
  ]) need(body, token, `initial Enable contract lost ${token}`);
  assert.equal((body.match(/freshCancels\.get\(0\)\.click\(\)/g) ?? []).length, 1);
}

function fixedCriticalIntervalContract(java) {
  const run = methodBody(java, "runAutomaticFlow");
  const branchStart = run.indexOf("if (isFixed42AutomaticMode()) {");
  const elseStart = run.indexOf("} else {", branchStart);
  const branchEnd = run.indexOf("\n        }", elseStart);
  assert.ok(branchStart >= 0 && elseStart > branchStart && branchEnd > elseStart,
    "fixed and existing automatic branches are not explicit");
  const fixedBranch = run.slice(branchStart, elseStart);
  const existingBranch = run.slice(elseStart, branchEnd);
  need(fixedBranch, "enableAndCancelInitialFixed42CheckNoIdle()",
    "fixed profile does not own Enable through settled Cancel");
  assert.equal(fixedBranch.includes("click("), false,
    "fixed profile entered the generic idle-waiting click path");
  need(existingBranch, 'By.res("android", "button1")',
    "existing automatic profile lost its Enable selector");
  need(existingBranch, "cancelInitialManualCheckBeforeResult()",
    "existing automatic profile lost its original cancellation path");

  const critical = methodBody(java, "enableAndCancelInitialFixed42CheckNoIdle");
  initialEnableContract(critical);
  const zeroIdle = critical.indexOf("configurator.setWaitForIdleTimeout(0L)");
  const enable = critical.indexOf("freshEnables.get(0).click()");
  const checking = critical.indexOf("initialEnableCheckingTitleObserved = true");
  const cancel = critical.indexOf("freshCancels.get(0).click()");
  const settled = critical.indexOf("initialEnableCancelWon = true");
  const restore = critical.indexOf("configurator.setWaitForIdleTimeout(previousIdleTimeout)");
  const capture = critical.indexOf('capture("fixed42-initial-enable-cancel-settled")');
  assert.ok(zeroIdle >= 0 && zeroIdle < enable && enable < checking && checking < cancel
    && cancel < settled && settled < restore && restore < capture,
  "fixed critical interval ordering is not zero-idle Enable, observation, Cancel, settle, restore, capture");
  assert.equal(critical.slice(0, zeroIdle).includes(".click()"), false,
    "an input occurred before zero-idle policy was active");
  const beforeCancel = critical.slice(enable, cancel);
  assert.equal(beforeCancel.includes("capture("), false,
    "PNG or hierarchy capture occurred between Enable and Cancel");
  assert.equal(beforeCancel.includes("device.waitForIdle("), false,
    "an idle wait occurred between Enable and Cancel");
}

function fixedDataContract(java) {
  const seed = methodBody(java, "seedFixed42MeaningfulLocalState");
  const verify = methodBody(java, "assertFixed42MeaningfulLocalState");
  const profile = methodBody(java, "waitForFixed42ProfileNameField");
  const openProfile = methodBody(java, "openFixed42ProfileDialog");
  const freshButton = methodBody(java, "clickFreshFixed42Button");
  const folder = methodBody(java, "waitForFixed42FolderSelect");
  need(profile, 'findUniqueExactProductDialog("Profile")', "profile input is not scoped to exact dialog");
  need(profile, 'By.clazz("android.widget.EditText")', "profile input lost its source-derived class candidate");
  need(openProfile, 'clickFreshFixed42Button("Your profile", UI_WAIT_MS)', "profile open does not reacquire a fresh exact control");
  need(freshButton, "assertNoBindingTerms()", "fresh profile control is not safety guarded");
  need(freshButton, "instrumentation.getUiAutomation().clearCache()", "fresh profile control is not reacquired");
  assert.equal(seed.includes('By.desc("Your name")'), false, "fixed profile assumed an unproven WebView description mapping");
  assert.equal(verify.includes('By.desc("Your name")'), false, "fixed profile verification assumed an unproven description mapping");
  need(seed, '.clazz("android.widget.ToggleButton")', "appearance candidate class is absent");
  need(seed, "waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY)", "appearance summary is not observed");
  assert.equal(seed.includes("quiet.isChecked()"), false, "WebView checked state cannot admit baseline42 appearance");
  need(seed, "waitForFixed42FolderSelect(moveLabel, AUTOMATIC_FOLDER_NAME)", "folder marker is not exact");
  assert.equal(folder.includes("By.desc(moveLabel)"), false, "folder select assumed an unproven WebView description mapping");
  for (const token of ['By.text("Move ")', "By.text(AUTOMATIC_SAMPLE_TITLE)", 'By.text(" to folder")']) {
    need(folder, token, `folder select lost source-derived semantic fragment ${token}`);
  }
  need(seed, 'waitForFixed42DialogSemantic(\n                detailDialogIdentity, "In watchlist"', "watchlist result identity is absent");
}

function fixedAppearanceAnchorObservationContract(java) {
  const seed = methodBody(java, "seedFixed42MeaningfulLocalState");
  const orderedObservation = /selectFixed42SettingsCategory\("Appearance", "Choose a style"\);\s*captureFixed42Appearance\("fixed42-appearance-anchor"\);\s*waitForFixed42AppearanceSummary\("Midnight Studio"\);/;
  assert.match(seed, orderedObservation,
    "fixed42 Appearance must be captured immediately after its admitted content anchor");
  assert.equal(
    (java.match(/captureFixed42Appearance\("fixed42-appearance-anchor"\)/g) ?? []).length,
    1,
    "fixed42 Appearance anchor observation must be captured exactly once",
  );
  const capture = seed.indexOf('captureFixed42Appearance("fixed42-appearance-anchor")');
  const selectorSearch = seed.indexOf("scrollUntilVisibleExactProductWithFirstScrollObservation(");
  assert.ok(capture >= 0 && capture < selectorSearch,
    "fixed42 Appearance anchor observation must precede the unproven widget search");
}

function fixedAppearanceFirstScrollObservationContract(java) {
  const seed = methodBody(java, "seedFixed42MeaningfulLocalState");
  need(seed, "scrollUntilVisibleExactProductWithFirstScrollObservation(",
    "fixed42 Appearance did not request the bounded first-scroll observation");
  need(seed, '"fixed42-appearance-after-first-scroll"',
    "fixed42 Appearance first-scroll observation label is missing");
  assert.equal(
    (java.match(/"fixed42-appearance-after-first-scroll"/g) ?? []).length,
    1,
    "fixed42 Appearance first-scroll observation may be requested only once",
  );

  const helper = methodBody(java, "scrollUntilVisibleExactProductWithFirstScrollObservation");
  need(helper, "for (int attempt = 0; attempt < 12; attempt++)",
    "bounded exact-product search changed its scroll-attempt cap");
  assert.equal((helper.match(/scrollable\.scroll\(direction, 0\.75f\)/g) ?? []).length, 1,
    "observation helper must retain one normal scroll operation per attempt");
  assert.equal(helper.includes("device.swipe("), false,
    "observation helper added a non-normal scroll input");
  assert.equal(helper.includes(".click()"), false,
    "observation helper added a click");
  const scroll = helper.indexOf("scrollable.scroll(direction, 0.75f)");
  const settled = helper.indexOf("device.waitForIdle(750)", scroll);
  const cap = helper.indexOf("if (attempt == 0 && firstScrollCaptureLabel != null)", settled);
  const capture = helper.indexOf("captureFixed42Appearance(firstScrollCaptureLabel)", cap);
  assert.ok(scroll >= 0 && scroll < settled && settled < cap && cap < capture,
    "first-scroll observation must follow the first normal settled scroll");
  assert.equal((helper.match(/captureFixed42Appearance\(firstScrollCaptureLabel\)/g) ?? []).length, 1,
    "first-scroll observation helper has more than one capture site");

  const defaultHelper = methodBody(java, "scrollUntilVisibleExactProduct");
  need(defaultHelper, "selector, label, direction, null",
    "ordinary exact-product searches must opt out of the diagnostic observation");
}

function fixedAppearanceFreshCacheContract(java) {
  const wrapper = methodBody(java, "captureFixed42Appearance");
  for (const token of [
    "isFixed42AutomaticMode()",
    "Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE",
    "instrumentation.getUiAutomation().clearCache()",
    "capture(label)",
  ]) need(wrapper, token, `fresh fixed42 Appearance capture lost ${token}`);
  assert.match(
    wrapper,
    /assertTrue\("Fixed42 Appearance accessibility cache refresh failed",\s*instrumentation\.getUiAutomation\(\)\.clearCache\(\)\);\s*capture\(label\);/,
    "successful accessibility cache refresh must immediately precede fixed42 Appearance capture",
  );
  assert.equal((wrapper.match(/clearCache\(\)/g) ?? []).length, 1,
    "fixed42 Appearance wrapper must perform exactly one cache refresh per capture");
  assert.equal((wrapper.match(/capture\(label\)/g) ?? []).length, 1,
    "fixed42 Appearance wrapper must delegate exactly one capture");
  for (const forbidden of [".click()", "device.swipe(", ".scroll(", "device.press", ".setText("]) {
    assert.equal(wrapper.includes(forbidden), false,
      `fixed42 Appearance observation wrapper added input ${forbidden}`);
  }
  assert.equal(methodBody(java, "capture").includes("clearCache()"), false,
    "global capture semantics changed instead of using the fixed42-only wrapper");
  assert.equal((java.match(/captureFixed42Appearance\(/g) ?? []).length, 3,
    "fixed42 Appearance wrapper must have exactly two call sites and one declaration");
  assert.equal((java.match(/capture\("fixed42-appearance/g) ?? []).length, 0,
    "an Appearance observation bypasses the fresh-cache wrapper");
}

function postInstallContract(body) {
  for (const token of [
    'selectFixed42SettingsCategory("Help & updates", "Android APK updates")',
    'String resultTitle = "YAWF Stream is up to date"',
    'String resultMessage = "No newer signed Android phone release is available."',
    'clazz("android.widget.CheckBox")',
    "weekly.isCheckable()",
    "weekly.isChecked()",
    "postInstallManualInspectionChecks++",
    'assertEquals("Fixed42 postinstall Settings inspection must run exactly once"',
    "postInstallNativeOkClosures++",
    "nativeProductButton(OtaFlowPolicy.OK)",
    "postInstallNativeCancelClosures",
  ]) need(body, token, `postinstall inspection lost ${token}`);
  assert.equal(body.includes("openHelpAndUpdates()"), false, "fixed profile reused the old category selector");
}

test("fixed profile is exact and routes through one fresh initial Enable cancellation", () => {
  need(source, '"public-fixed42-to59-initial-cancel-due-resume-v1"', "profile name is missing");
  const run = methodBody(source, "runAutomaticFlow");
  need(run, "enableAndCancelInitialFixed42CheckNoIdle()", "fixed flow does not cancel the first Enable check");
  const initial = methodBody(source, "enableAndCancelInitialFixed42CheckNoIdle");
  initialEnableContract(initial);
  rejectMutation(initial, "setWaitForIdleTimeout(0L)", "setWaitForIdleTimeout(10_000L)", initialEnableContract);
  rejectMutation(initial, "initialEnableCancelSelections++", "initialEnableCancelSelections += 0", initialEnableContract);
});

test("fixed critical interval enters zero-idle before Enable and captures only after Cancel", () => {
  fixedCriticalIntervalContract(source);

  const genericClickMutant = source.replace(
    "if (isFixed42AutomaticMode()) {\n            enableAndCancelInitialFixed42CheckNoIdle();",
    `if (isFixed42AutomaticMode()) {
            click(
                    By.res("android", "button1")
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                            .text(Pattern.compile("\\\\AEnable\\\\z", Pattern.CASE_INSENSITIVE)),
                    "Enable", SHORT_WAIT_MS, true);
            enableAndCancelInitialFixed42CheckNoIdle();`,
  );
  assert.notEqual(genericClickMutant, source, "generic click mutant anchor was absent");
  assert.throws(() => fixedCriticalIntervalContract(genericClickMutant));

  const movedZeroIdleMutant = source
    .replace(
      "configurator.setWaitForIdleTimeout(0L);\n        try {",
      "try {",
    )
    .replace(
      "freshEnables.get(0).click();",
      "freshEnables.get(0).click();\n            configurator.setWaitForIdleTimeout(0L);",
    );
  assert.notEqual(movedZeroIdleMutant, source, "late zero-idle mutant anchor was absent");
  assert.throws(() => fixedCriticalIntervalContract(movedZeroIdleMutant));

  const preCancelCaptureMutant = source.replace(
    "freshEnables.get(0).click();",
    'freshEnables.get(0).click();\n            capture("mutant-before-cancel");',
  );
  assert.notEqual(preCancelCaptureMutant, source, "pre-Cancel capture mutant anchor was absent");
  assert.throws(() => fixedCriticalIntervalContract(preCancelCaptureMutant));
});

test("fixed baseline42 source-derived selector candidates fail closed and remain read-only after install", () => {
  fixedDataContract(source);
  const mutated = source.replace('.clazz("android.widget.ToggleButton")', '.clazz("android.widget.Button")');
  assert.throws(() => fixedDataContract(mutated));
  const invalidProfile = source.replace(
    "UiObject2 initialName = waitForFixed42ProfileNameField(\"initial profile name\");",
    'UiObject2 initialName = waitFor(By.desc("Your name"), SHORT_WAIT_MS, "initial profile name");',
  );
  assert.throws(() => fixedDataContract(invalidProfile));
  const receipt = methodBody(source, "writeReceipt");
  need(receipt, 'receipt.put("profileNamePostInstallSetTextActions",', "receipt omits postinstall write count");
});

test("fixed42 captures the fresh Appearance viewport immediately after its admitted anchor", () => {
  fixedAppearanceAnchorObservationContract(source);
  const removed = source.replace('        captureFixed42Appearance("fixed42-appearance-anchor");\n', "");
  assert.notEqual(removed, source, "Appearance anchor observation mutant anchor was absent");
  assert.throws(() => fixedAppearanceAnchorObservationContract(removed));

  const moved = source.replace(
    '        captureFixed42Appearance("fixed42-appearance-anchor");\n        waitForFixed42AppearanceSummary("Midnight Studio");',
    '        waitForFixed42AppearanceSummary("Midnight Studio");\n        captureFixed42Appearance("fixed42-appearance-anchor");',
  );
  assert.notEqual(moved, source, "late Appearance observation mutant anchor was absent");
  assert.throws(() => fixedAppearanceAnchorObservationContract(moved));
});

test("fixed42 captures at most one settled observation after the first normal Appearance scroll", () => {
  fixedAppearanceFirstScrollObservationContract(source);
  const uncapped = source.replace(
    "if (attempt == 0 && firstScrollCaptureLabel != null)",
    "if (attempt >= 0 && firstScrollCaptureLabel != null)",
  );
  assert.notEqual(uncapped, source, "uncapped first-scroll observation mutant anchor was absent");
  assert.throws(() => fixedAppearanceFirstScrollObservationContract(uncapped));

  const extraScroll = source.replace(
    "device.waitForIdle(750);\n            if (attempt == 0 && firstScrollCaptureLabel != null)",
    "device.waitForIdle(750);\n            scrollable.scroll(direction, 0.75f);\n            if (attempt == 0 && firstScrollCaptureLabel != null)",
  );
  assert.notEqual(extraScroll, source, "extra diagnostic scroll mutant anchor was absent");
  assert.throws(() => fixedAppearanceFirstScrollObservationContract(extraScroll));
});

test("fixed42 refreshes the API 34 accessibility cache before each observation without input", () => {
  fixedAppearanceFreshCacheContract(source);
  const lateRefresh = source.replace(
    '        assertTrue("Fixed42 Appearance accessibility cache refresh failed",\n                instrumentation.getUiAutomation().clearCache());\n        capture(label);',
    '        capture(label);\n        assertTrue("Fixed42 Appearance accessibility cache refresh failed",\n                instrumentation.getUiAutomation().clearCache());',
  );
  assert.notEqual(lateRefresh, source, "late cache-refresh mutant anchor was absent");
  assert.throws(() => fixedAppearanceFreshCacheContract(lateRefresh));

  const unassertedRefresh = source.replace(
    '        assertTrue("Fixed42 Appearance accessibility cache refresh failed",\n                instrumentation.getUiAutomation().clearCache());',
    "        instrumentation.getUiAutomation().clearCache();",
  );
  assert.notEqual(unassertedRefresh, source, "unasserted cache-refresh mutant anchor was absent");
  assert.throws(() => fixedAppearanceFreshCacheContract(unassertedRefresh));

  const inputMutant = source.replace(
    "        capture(label);\n    }\n\n    private void capture(String label)",
    "        device.pressBack();\n        capture(label);\n    }\n\n    private void capture(String label)",
  );
  assert.notEqual(inputMutant, source, "observation input mutant anchor was absent");
  assert.throws(() => fixedAppearanceFreshCacheContract(inputMutant));
});

test("automatic offer comes from a distinct launcher return with no pre-offer manual discovery", () => {
  const run = methodBody(source, "runAutomaticFlow");
  const trigger = run.indexOf('returnToProductThroughVisibleLauncher("automatic-check-trigger")');
  const absence = run.indexOf("assertAutomaticOfferAbsentForBoundedCheck()");
  const deferred = run.indexOf('returnToProductThroughVisibleLauncher("deferred-offer-return")');
  const offer = run.indexOf("deferredAutomaticOfferObserved = true");
  assert.ok(trigger >= 0 && trigger < absence && absence < deferred && deferred < offer);
  need(run, "0, preOfferManualDiscoveries", "fixed flow does not reject pre-offer manual discovery");
  const mutant = run.replace("assertAutomaticOfferAbsentForBoundedCheck();", "");
  assert.equal(mutant.includes("assertAutomaticOfferAbsentForBoundedCheck()"), false);
  assert.throws(() => need(mutant, "assertAutomaticOfferAbsentForBoundedCheck()", "missing absence gate"));
});

test("postinstall manual inspection occurs only after automatic offer and closes one exact result with OK", () => {
  const run = methodBody(source, "runAutomaticFlow");
  const offer = run.indexOf("automaticOfferOrdinal = deferredOfferReturnOrdinal");
  const install = run.indexOf("confirmSystemInstaller()");
  const persistence = run.indexOf('assertFixed42MeaningfulLocalState("after-task-relaunch", true)');
  const inspection = run.indexOf("inspectFixed42PostInstallAutomaticRetention()");
  assert.ok(offer >= 0 && offer < install && install < persistence && persistence < inspection);
  const body = methodBody(source, "inspectFixed42PostInstallAutomaticRetention");
  postInstallContract(body);
  rejectMutation(body, "postInstallNativeOkClosures++", "postInstallNativeOkClosures += 0", postInstallContract);
  rejectMutation(body, "weekly.isChecked()", "true", postInstallContract);
});

test("fixed receipt explicitly excludes postinstall inspection from automatic discovery proof", () => {
  const receipt = methodBody(source, "writeReceipt");
  for (const token of [
    'receipt.put("preOfferManualDiscoveries", preOfferManualDiscoveries)',
    'receipt.put("postInstallManualInspectionChecks",',
    'receipt.put("postInstallNativeOkClosures", postInstallNativeOkClosures)',
    'receipt.put("automaticDiscoveryProofIncludesPostInstallInspection", false)',
  ]) need(receipt, token, `fixed receipt lost ${token}`);
  const mutant = receipt.replace(
    'receipt.put("automaticDiscoveryProofIncludesPostInstallInspection", false)',
    'receipt.put("automaticDiscoveryProofIncludesPostInstallInspection", true)',
  );
  assert.throws(() => need(
    mutant,
    'receipt.put("automaticDiscoveryProofIncludesPostInstallInspection", false)',
    "postinstall inspection was folded into automatic discovery proof",
  ));
});
