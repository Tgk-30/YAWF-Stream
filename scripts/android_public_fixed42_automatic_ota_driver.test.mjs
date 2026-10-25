import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function nestedClassDeclaration(java, name) {
  const signature = new RegExp(`\\bprivate\\s+static\\s+final\\s+class\\s+${name}\\s*\\{`, "m");
  const match = signature.exec(java);
  assert.notEqual(match, null, `missing Java nested class ${name}`);
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
    if (character === "}" && --depth === 0) return java.slice(match.index, index + 1);
  }
  assert.fail(`unterminated Java nested class ${name}`);
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
    "String[] progressTexts",
    "String[] terminalTexts",
    "nativeDialogTextGroup(progressTexts)",
    "nativeDialogTextGroup(terminalTexts)",
    'By.res("android", "button2")',
    'Pattern.compile("\\\\ACancel\\\\z", Pattern.CASE_INSENSITIVE)',
    "queryFixed42CriticalTextGroup(",
    "queryFixed42CriticalCancelGroup(",
    "assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(terminalCounts)",
    "Fixed42CriticalQueryGroupPolicy.isInitialCheckingReady(",
    "Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(",
    "Fixed42CriticalQueryGroupPolicy.isSettledAbsent(",
    "initialEnableCancelSelections++",
    'assertEquals("Initial Enable Cancel must be selected exactly once"',
    "initialEnableSettledResultExclusionSamples = settled",
    "initialEnableCancelWon = true",
    "configurator.setWaitForIdleTimeout(previousIdleTimeout)",
    'capture("fixed42-initial-enable-cancel-settled")',
  ]) need(body, token, `initial Enable contract lost ${token}`);
  assert.equal((body.match(/freshCancels\.get\(0\)\.click\(\)/g) ?? []).length, 1);
  assert.equal(body.includes("device.hasObject("), false,
    "fixed42 critical observer restored separate hasObject tree scans");
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

function fixed42CriticalQueryGroupContract(java) {
  const critical = methodBody(java, "enableAndCancelInitialFixed42CheckNoIdle");
  const textGroupSelector = methodBody(java, "nativeDialogTextGroup");
  const textGroupQuery = methodBody(java, "queryFixed42CriticalTextGroup");
  const cancelGroupQuery = methodBody(java, "queryFixed42CriticalCancelGroup");
  const noResult = methodBody(java, "assertNoInitialEnableResultVisibleAtCurrentIdlePolicy");
  const policy = nestedClassDeclaration(java, "Fixed42CriticalQueryGroupPolicy");

  for (const token of [
    'String[] progressTexts = {progressTitle, progressMessage}',
    '"YAWF Stream is up to date"',
    '"Update check unavailable"',
    '"YAWF Stream " + admittedTargetVersion + " is available"',
    "nativeDialogTextGroup(progressTexts)",
    "nativeDialogTextGroup(terminalTexts)",
    'queryFixed42CriticalTextGroup(\n                                terminalSelector, terminalTexts, "checking-terminal")',
    'queryFixed42CriticalTextGroup(\n                                progressSelector, progressTexts, "checking-progress")',
    'queryFixed42CriticalTextGroup(\n                            terminalSelector, terminalTexts, "fresh-terminal")',
    "assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(freshTerminalCounts)",
    'queryFixed42CriticalCancelGroup(\n                    cancelSelector, "fresh-cancel")',
    "Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(\n                    freshTerminalCounts, freshCancels.size())",
    "initialEnableCancelSelections++",
    "freshCancels.get(0).click()",
    'queryFixed42CriticalTextGroup(\n                                terminalSelector, terminalTexts, "settled-terminal")',
    'queryFixed42CriticalTextGroup(\n                                progressSelector, progressTexts, "settled-progress")',
    "Fixed42CriticalQueryGroupPolicy.isSettledAbsent(",
  ]) need(critical, token, `fixed42 grouped critical observer lost ${token}`);

  const freshCache = critical.indexOf(
    'assertTrue("Initial Enable cache could not be refreshed before Cancel"',
  );
  const freshTerminal = critical.indexOf('terminalTexts, "fresh-terminal"', freshCache);
  const freshCancel = critical.indexOf('cancelSelector, "fresh-cancel"', freshTerminal);
  const freshGate = critical.indexOf(
    "Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(", freshCancel,
  );
  const cancelCount = critical.indexOf("initialEnableCancelSelections++", freshGate);
  const cancelClick = critical.indexOf("freshCancels.get(0).click()", cancelCount);
  assert.ok(freshCache >= 0 && freshCache < freshTerminal && freshTerminal < freshCancel
    && freshCancel < freshGate && freshGate < cancelCount && cancelCount < cancelClick,
  "fresh terminal exclusion and fresh unique Cancel must both precede the only Cancel click");
  assert.equal((critical.match(/freshCancels\.get\(0\)\.click\(\)/g) ?? []).length, 1,
    "fixed42 critical observer must click exactly one freshly queried Cancel");
  assert.equal(critical.includes("nativeDialogText(progressTitle)"), false,
    "fixed42 critical observer restored a separate title query");
  assert.equal(critical.includes("nativeDialogText(progressMessage)"), false,
    "fixed42 critical observer restored a separate message query");
  assert.equal(critical.includes("device.hasObject("), false,
    "fixed42 critical observer restored per-terminal hasObject scans");

  for (const token of [
    "Fixed42CriticalQueryGroupPolicy.exactTextPattern(exactTexts)",
    ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    ".clazz(Fixed42CriticalQueryGroupPolicy.TEXT_VIEW_CLASS)",
  ]) need(textGroupSelector, token, `fixed42 group selector lost ${token}`);
  assert.equal((textGroupQuery.match(/device\.findObjects\(selector\)/g) ?? []).length, 1,
    "one text group observation must use exactly one tree query");
  assert.equal((cancelGroupQuery.match(/device\.findObjects\(selector\)/g) ?? []).length, 1,
    "one Cancel group observation must use exactly one tree query");
  for (const token of [
    "match.getApplicationPackage()",
    "match.getClassName()",
    "match.getText()",
    "matches.size() > exactTexts.length",
    "Fixed42CriticalQueryGroupPolicy.classify(",
    "OtaFlowPolicy.PRODUCT_PACKAGE",
    "Fixed42CriticalQueryGroupPolicy.TEXT_VIEW_CLASS",
  ]) need(textGroupQuery, token, `fixed42 grouped result classification lost ${token}`);
  for (const token of [
    'static final String TEXT_VIEW_CLASS = "android.widget.TextView"',
    'new StringBuilder("\\\\A(?:")',
    "Pattern.quote(exactTexts[index])",
    'pattern.append(")\\\\z")',
    "expectedPackage.equals(candidate.packageName)",
    "expectedClass.equals(candidate.className)",
    "exactTexts[index].equals(candidate.text)",
    "requireTerminalAbsent(terminalCounts)",
    "cancelCount != 1",
  ]) need(policy, token, `fixed42 exact grouped-query policy lost ${token}`);
  for (const [index, label] of [
    [0, "up-to-date"],
    [1, "failure"],
    [2, "target offer"],
  ]) need(noResult, `0, terminalCounts.count(${index})`,
    `fixed42 ${label} terminal variant is not excluded independently`);
}

function fixed42CriticalTimingContract(java) {
  const textGroupQuery = methodBody(java, "queryFixed42CriticalTextGroup");
  const cancelGroupQuery = methodBody(java, "queryFixed42CriticalCancelGroup");
  const record = methodBody(java, "recordInitialEnableQueryGroupTiming");
  const receipt = methodBody(java, "writeReceipt");
  for (const body of [textGroupQuery, cancelGroupQuery]) {
    for (const token of [
      "long startedAt = SystemClock.uptimeMillis()",
      "recordInitialEnableQueryGroupTiming(",
      "SystemClock.uptimeMillis()",
      "new int[] {-1}",
      "throw failure",
    ]) need(body, token, `fixed42 query timing lost ${token}`);
  }
  for (const token of [
    "finishedAt < startedAt",
    "startedAt < initialEnableLastQueryTimingUptimeMs",
    "initialEnableQueryTimingSequence++",
    'append(" phase=").append(phase)',
    'append(" startUptimeMs=").append(startedAt)',
    'append(" finishUptimeMs=").append(finishedAt)',
    'append(" counts=")',
    "initialEnableQueryGroupTimings.size() >= MAX_INITIAL_ENABLE_QUERY_TIMINGS",
    "initialEnableQueryGroupTimings.remove(0)",
    "initialEnableQueryGroupTimingDrops++",
  ]) need(record, token, `fixed42 bounded timing buffer lost ${token}`);
  for (const forbidden of [
    "exactTexts", "selector", "getText", "getContentDescription", "packageName",
    "admittedTarget", "http", "failure.getMessage",
  ]) assert.equal(record.includes(forbidden), false,
    `fixed42 timing receipt leaked dynamic observer data through ${forbidden}`);
  for (const token of [
    'receipt.put("initialEnableQueryGroupTimings", initialEnableTimingJson)',
    'receipt.put("initialEnableQueryGroupTimingDrops",',
    'receipt.put("initialEnableQueryGroupTimingLimit",',
    "MAX_INITIAL_ENABLE_QUERY_TIMINGS",
  ]) need(receipt, token, `fixed42 timing receipt lost ${token}`);
}

function runFixed42CriticalQueryGroupPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42CriticalQueryGroupPolicy");
  const harness = `
import java.util.regex.Pattern;

public final class Fixed42CriticalQueryGroupPolicyHarness {
${policy}

    private static final String PRODUCT = "com.tgk30.debridstreamer";
    private static final String TEXT_VIEW = "android.widget.TextView";

    private static Fixed42CriticalQueryGroupPolicy.Candidate candidate(
            String packageName, String className, String text) {
        return new Fixed42CriticalQueryGroupPolicy.Candidate(packageName, className, text);
    }

    private static Fixed42CriticalQueryGroupPolicy.Counts counts(
            String[] exactTexts, Fixed42CriticalQueryGroupPolicy.Candidate... candidates) {
        return Fixed42CriticalQueryGroupPolicy.classify(
                PRODUCT, TEXT_VIEW, exactTexts, candidates);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void expectAssertion(Runnable action, String message) {
        boolean rejected = false;
        try {
            action.run();
        } catch (AssertionError expected) {
            rejected = true;
        }
        require(rejected, message);
    }

    public static void main(String[] args) {
        String[] progressTexts = {
                "Checking for updates",
                "Checking the official YAWF Stream Android release channel."
        };
        String[] terminalTexts = {
                "YAWF Stream is up to date",
                "Update check unavailable",
                "YAWF Stream 2.3.59 is available"
        };
        Pattern progressPattern =
                Fixed42CriticalQueryGroupPolicy.exactTextPattern(progressTexts);
        require(progressPattern.matcher(progressTexts[0]).matches(),
                "progress title must match the union");
        require(progressPattern.matcher(progressTexts[1]).matches(),
                "progress message must match the union");
        require(!progressPattern.matcher("Checking for update").matches(),
                "inexact progress name must not match");
        Pattern terminalPattern =
                Fixed42CriticalQueryGroupPolicy.exactTextPattern(terminalTexts);
        for (String terminal : terminalTexts) {
            require(terminalPattern.matcher(terminal).matches(),
                    "each exact terminal name must match");
        }
        require(!terminalPattern.matcher("YAWF Stream 2x3x59 is available").matches(),
                "quoted target version punctuation must stay literal");

        Fixed42CriticalQueryGroupPolicy.Counts progress = counts(
                progressTexts,
                candidate(PRODUCT, TEXT_VIEW, progressTexts[0]),
                candidate(PRODUCT, TEXT_VIEW, progressTexts[1]));
        Fixed42CriticalQueryGroupPolicy.Counts emptyTerminal = counts(terminalTexts);
        require(Fixed42CriticalQueryGroupPolicy.isInitialCheckingReady(
                        progress, emptyTerminal, 1),
                "exact initial CHECKING snapshot must be ready");

        for (int index = 0; index < terminalTexts.length; index++) {
            Fixed42CriticalQueryGroupPolicy.Counts terminal = counts(
                    terminalTexts, candidate(PRODUCT, TEXT_VIEW, terminalTexts[index]));
            expectAssertion(
                    () -> Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(terminal, 1),
                    "terminal variant " + index + " must beat and reject cancellation");
        }

        Fixed42CriticalQueryGroupPolicy.Counts laterOffer = counts(
                terminalTexts, candidate(PRODUCT, TEXT_VIEW, terminalTexts[2]));
        expectAssertion(
                () -> Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(laterOffer, 1),
                "earlier progress followed by a later terminal offer must fail closed");
        expectAssertion(
                () -> Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(emptyTerminal, 0),
                "later missing Cancel must fail closed");
        expectAssertion(
                () -> Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(emptyTerminal, 2),
                "later duplicate Cancel must fail closed");

        expectAssertion(
                () -> counts(progressTexts,
                        candidate("other.package", TEXT_VIEW, progressTexts[0])),
                "wrong package must fail");
        expectAssertion(
                () -> counts(progressTexts,
                        candidate(PRODUCT, "android.view.View", progressTexts[0])),
                "wrong class must fail");
        expectAssertion(
                () -> counts(progressTexts,
                        candidate(PRODUCT, TEXT_VIEW, "Checking for update")),
                "wrong name must fail");
        Fixed42CriticalQueryGroupPolicy.Counts duplicateProgress = counts(
                progressTexts,
                candidate(PRODUCT, TEXT_VIEW, progressTexts[0]),
                candidate(PRODUCT, TEXT_VIEW, progressTexts[0]),
                candidate(PRODUCT, TEXT_VIEW, progressTexts[1]));
        expectAssertion(
                () -> Fixed42CriticalQueryGroupPolicy.isInitialCheckingReady(
                        duplicateProgress, emptyTerminal, 1),
                "duplicate initial title must fail closed");

        Fixed42CriticalQueryGroupPolicy.Counts emptyProgress = counts(progressTexts);
        require(Fixed42CriticalQueryGroupPolicy.isSettledAbsent(
                        emptyProgress, emptyTerminal, 0),
                "fresh all-absent post-Cancel sample must settle");
        require(!Fixed42CriticalQueryGroupPolicy.isSettledAbsent(
                        progress, emptyTerminal, 0),
                "visible progress must reset settling");
        System.out.println("fixed42-critical-query-group-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-query-group-policy-"));
  const sourceFile = path.join(directory, "Fixed42CriticalQueryGroupPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 grouped-query policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42CriticalQueryGroupPolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 grouped-query policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-critical-query-group-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  need(seed, 'clickFreshFixed42AppearanceStyle(\n                AUTOMATIC_APPEARANCE,', "appearance selection is not freshly guarded");
  need(seed, "waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY)", "appearance summary is not observed");
  need(verify, "waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY)", "appearance persistence summary is not mandatory");
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
  const selectorSearch = seed.indexOf("clickFreshFixed42AppearanceStyle(");
  assert.ok(capture >= 0 && capture < selectorSearch,
    "fixed42 Appearance anchor observation must precede the unproven widget search");
}

function fixedAppearanceFirstScrollObservationContract(java) {
  const seed = methodBody(java, "seedFixed42MeaningfulLocalState");
  need(seed, "clickFreshFixed42AppearanceStyle(",
    "fixed42 Appearance did not request the bounded first-scroll observation");
  need(seed, '"fixed42-appearance-after-first-scroll"',
    "fixed42 Appearance first-scroll observation label is missing");
  assert.equal(
    (java.match(/"fixed42-appearance-after-first-scroll"/g) ?? []).length,
    1,
    "fixed42 Appearance first-scroll observation may be requested only once",
  );

  const helper = methodBody(java, "clickFreshFixed42AppearanceStyle");
  need(helper, "for (int attempt = 0; attempt < 12; attempt++)",
    "bounded exact-product search changed its scroll-attempt cap");
  assert.equal((helper.match(/scrollable\.scroll\(Direction\.DOWN, 0\.75f\)/g) ?? []).length, 1,
    "observation helper must retain one normal scroll operation per attempt");
  assert.equal(helper.includes("device.swipe("), false,
    "observation helper added a non-normal scroll input");
  assert.equal((helper.match(/\.click\(\)/g) ?? []).length, 1,
    "fixed42 observation and selection helper must click exactly once");
  const scroll = helper.indexOf("scrollable.scroll(Direction.DOWN, 0.75f)");
  const settled = helper.indexOf("device.waitForIdle(750)", scroll);
  const cap = helper.indexOf("if (attempt == 0 && firstScrollCaptureLabel != null)", settled);
  const capture = helper.indexOf("captureFixed42Appearance(firstScrollCaptureLabel)", cap);
  assert.ok(scroll >= 0 && scroll < settled && settled < cap && cap < capture,
    "first-scroll observation must follow the first normal settled scroll");
  assert.equal((helper.match(/captureFixed42Appearance\(firstScrollCaptureLabel\)/g) ?? []).length, 1,
    "first-scroll observation helper has more than one capture site");

  assert.equal(java.includes("scrollUntilVisibleExactProductWithFirstScrollObservation"), false,
    "fixed42 observation must not leave a generic diagnostic selector path");
}

function fixedAppearanceSelectionContract(java) {
  const helper = methodBody(java, "clickFreshFixed42AppearanceStyle");
  const candidates = methodBody(java, "findExactFixed42AppearanceStyleControls");
  const summary = methodBody(java, "waitForFixed42AppearanceSummary");
  const navigation = methodBody(java, "fixed42BottomNavigationTop");
  for (const token of [
    "isFixed42AutomaticMode()",
    "instrumentation.getUiAutomation().clearCache()",
    "assertNoBindingTerms()",
    "findExactFixed42AppearanceStyleControls(exactButtonText)",
    "Fixed42AppearancePolicy.hasUniqueCandidate(fresh.size())",
    "fresh.get(0).click()",
  ]) need(helper, token, `fixed42 exact Appearance selection lost ${token}`);
  assert.equal((helper.match(/fresh\.get\(0\)\.click\(\)/g) ?? []).length, 1,
    "fixed42 Appearance style must click exactly once");
  for (const token of [
    "By.text(exactButtonText)",
    '.clazz("android.widget.ToggleButton")',
    ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    ".clickable(true)",
    ".enabled(true)",
    "Fixed42AppearancePolicy.isExactStyleControl(",
    "candidateBounds.left",
    "fixed42BottomNavigationTop()",
  ]) need(candidates, token, `fixed42 exact Appearance candidate lost ${token}`);
  assert.equal(candidates.includes("By.desc("), false,
    "fixed42 Appearance selection must not assume a description mapping");
  assert.equal(candidates.includes("checkable("), false,
    "fixed42 Appearance selection must not admit checkable state");
  assert.equal(candidates.includes("device.click("), false,
    "fixed42 Appearance selection must not use coordinates");

  for (const token of [
    "long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS",
    "attempt < 12 && SystemClock.uptimeMillis() < deadline",
    "By.text(exactStyle)",
    '.clazz("android.widget.TextView")',
    ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    "Fixed42AppearancePolicy.isExactSummary(",
    "clickableAncestor",
    "scrollable.scroll(Direction.UP, 0.75f)",
    "configureSettingsScrollGesture(scrollable)",
  ]) need(summary, token, `fixed42 selected summary lost ${token}`);
  assert.equal(summary.includes("By.desc("), false,
    "fixed42 selected summary must use exact source-observed text");
  for (const token of [
    'By.text("Primary")',
    '.clazz("android.view.View")',
    ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    ".clickable(false)",
    "1, navigationMatches.size()",
    "return navigationBounds.top",
  ]) need(navigation, token, `fixed42 bottom navigation fact lost ${token}`);
  assert.equal(navigation.includes("By.desc("), false,
    "fixed42 bottom navigation must use the source-observed text fact");
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

function fixedProfileClosureObservationContract(java) {
  const close = methodBody(java, "closeFixed42ProfileDialog");
  assert.equal((close.match(/clickFreshFixed42Button\("Close", SHORT_WAIT_MS\)/g) ?? []).length, 1,
    "fixed42 Profile closure must select Close exactly once");
  need(close, 'waitForFreshFixed42DialogGone("Profile", SHORT_WAIT_MS)',
    "fixed42 Profile closure does not use the bounded fresh observer");
  assert.equal(close.includes("waitForUniqueExactProductDialogGone("), false,
    "fixed42 Profile closure still uses the stale legacy observer");

  const wait = methodBody(java, "waitForFreshFixed42DialogGone");
  for (const token of [
    "isFixed42AutomaticMode()",
    "Fixed42DialogClosurePolicy.waitForGone(",
    "timeoutMs",
    "observeFreshFixed42Dialog(exactIdentity)",
    "SystemClock.uptimeMillis()",
    "SystemClock.sleep(millis)",
  ]) need(wait, token, `fixed42 Profile closure wait lost ${token}`);
  for (const forbidden of [".click()", "device.swipe(", ".scroll(", "device.press", ".setText("]) {
    assert.equal(wait.includes(forbidden), false,
      `fixed42 Profile closure wait added input ${forbidden}`);
  }

  const observe = methodBody(java, "observeFreshFixed42Dialog");
  for (const token of [
    "Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE",
    "instrumentation.getUiAutomation().clearCache()",
    "By.clazz(DETAIL_DIALOG_CLASS).pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    "dialog.getApplicationPackage()",
    "dialog.getClassName()",
    "dialog.getText()",
    "dialog.getContentDescription()",
    "AutomaticOtaDriverChecks.uniqueExactDialogIndex(",
    "OtaFlowPolicy.PRODUCT_PACKAGE",
    "DETAIL_DIALOG_CLASS",
    "exactIdentity",
    "AutomaticOtaDriverChecks.AMBIGUOUS_DIALOG_INDEX",
    "return Fixed42DialogClosurePolicy.AMBIGUOUS",
    "AutomaticOtaDriverChecks.NO_DIALOG_INDEX",
    "catch (StaleObjectException stale)",
    "return Fixed42DialogClosurePolicy.STALE",
  ]) need(observe, token, `fresh fixed42 dialog observation lost ${token}`);
  const refresh = observe.indexOf("instrumentation.getUiAutomation().clearCache()");
  const query = observe.indexOf("device.findObjects(", refresh);
  const classify = observe.indexOf("AutomaticOtaDriverChecks.uniqueExactDialogIndex(", query);
  assert.ok(refresh >= 0 && refresh < query && query < classify,
    "fixed42 dialog observation is not a complete post-refresh snapshot");
  const staleCatch = observe.slice(observe.indexOf("catch (StaleObjectException stale)"));
  assert.equal(staleCatch.includes("Fixed42DialogClosurePolicy.ABSENT"), false,
    "a stale fixed42 snapshot was treated as absence");
  for (const forbidden of [".click()", "device.swipe(", ".scroll(", "device.press", ".setText("]) {
    assert.equal(observe.includes(forbidden), false,
      `fresh fixed42 dialog observation added input ${forbidden}`);
  }

  const policy = nestedClassDeclaration(java, "Fixed42DialogClosurePolicy");
  for (const token of [
    "static final int STALE = 0",
    "static final int PRESENT = 1",
    "static final int ABSENT = 2",
    "static final int AMBIGUOUS = 3",
    "long deadline = timeoutMs > Long.MAX_VALUE - startedAt",
    "while (clock.uptimeMillis() < deadline)",
    "if (observation == AMBIGUOUS)",
    "throw new AssertionError",
    "if (completedAt >= deadline) return false",
    "if (observation == ABSENT) return true",
    "observation != STALE && observation != PRESENT",
    "Math.min(RETRY_MS, deadline - completedAt)",
  ]) need(policy, token, `fixed42 dialog closure policy lost ${token}`);
  assert.equal((policy.match(/long deadline\s*=/g) ?? []).length, 1,
    "fixed42 dialog closure policy reset its original deadline");
}

function runFixed42DialogClosurePolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42DialogClosurePolicy");
  const harness = `
public final class Fixed42DialogClosurePolicyHarness {
${policy}

    private static final class FakeClock implements Fixed42DialogClosurePolicy.Clock {
        long now;
        long maxObserved;
        int sleeps;

        FakeClock(long start) {
            now = start;
            maxObserved = start;
        }

        @Override
        public long uptimeMillis() {
            maxObserved = Math.max(maxObserved, now);
            return now;
        }

        @Override
        public void sleep(long millis) {
            require(millis > 0L, "sleep must be positive");
            now += millis;
            maxObserved = Math.max(maxObserved, now);
            sleeps++;
        }
    }

    private static final class Sequence implements Fixed42DialogClosurePolicy.ObservationSource {
        final int[] observations;
        int calls;

        Sequence(int... observations) {
            this.observations = observations;
        }

        @Override
        public int observe() {
            int index = Math.min(calls, observations.length - 1);
            calls++;
            return observations[index];
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        FakeClock stalePresentClock = new FakeClock(1_000L);
        Sequence stalePresent = new Sequence(
                Fixed42DialogClosurePolicy.STALE,
                Fixed42DialogClosurePolicy.PRESENT);
        require(!Fixed42DialogClosurePolicy.waitForGone(
                        450L, stalePresent, stalePresentClock),
                "stale then present must not prove gone");
        require(stalePresent.calls >= 2, "stale snapshot was not retried");

        FakeClock staleOnlyClock = new FakeClock(2_000L);
        Sequence staleOnly = new Sequence(Fixed42DialogClosurePolicy.STALE);
        require(!Fixed42DialogClosurePolicy.waitForGone(450L, staleOnly, staleOnlyClock),
                "stale-only observations must time out");
        require(staleOnly.calls >= 2, "stale-only observations were not retried");

        FakeClock absentClock = new FakeClock(3_000L);
        Sequence absent = new Sequence(Fixed42DialogClosurePolicy.ABSENT);
        require(Fixed42DialogClosurePolicy.waitForGone(450L, absent, absentClock),
                "fresh absence must prove gone");
        require(absent.calls == 1, "fresh absence was not immediately conclusive");

        boolean ambiguityRejected = false;
        try {
            Fixed42DialogClosurePolicy.waitForGone(
                    450L,
                    new Sequence(Fixed42DialogClosurePolicy.AMBIGUOUS),
                    new FakeClock(4_000L));
        } catch (AssertionError expected) {
            ambiguityRejected = true;
        }
        require(ambiguityRejected, "ambiguous dialogs must fail closed");

        FakeClock expiryClock = new FakeClock(5_000L);
        Sequence present = new Sequence(Fixed42DialogClosurePolicy.PRESENT);
        require(!Fixed42DialogClosurePolicy.waitForGone(450L, present, expiryClock),
                "present dialog must expire as not gone");
        require(expiryClock.now == 5_450L, "retry sleeps changed the original deadline");
        require(expiryClock.maxObserved <= 5_450L, "retry slept beyond the original deadline");
        require(expiryClock.sleeps == 3, "bounded retry cadence changed");

        System.out.println("fixed42-dialog-closure-policy-ok");
    }
}

`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-dialog-policy-"));
  const sourceFile = path.join(directory, "Fixed42DialogClosurePolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42DialogClosurePolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-dialog-closure-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runFixed42AppearancePolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42AppearancePolicy");
  const harness = `
public final class Fixed42AppearancePolicyHarness {
${policy}

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String text = "Apply Quiet focus style";
        String product = "com.tgk30.debridstreamer";
        require(Fixed42AppearancePolicy.isExactStyleControl(
                text, "", "android.widget.ToggleButton", product,
                true, true, 63, 1199, 989, 1456, 1080, 1920, 1669,
                text, product), "sanitized XML style control must pass");
        require(!Fixed42AppearancePolicy.isExactStyleControl(
                "Quiet focus", "", "android.widget.ToggleButton", product,
                true, true, 63, 1199, 989, 1456, 1080, 1920, 1669,
                text, product), "wrong text must fail");
        require(!Fixed42AppearancePolicy.isExactStyleControl(
                text, "described", "android.widget.ToggleButton", product,
                true, true, 63, 1199, 989, 1456, 1080, 1920, 1669,
                text, product), "wrong description must fail");
        require(!Fixed42AppearancePolicy.isExactStyleControl(
                text, "", "android.widget.Button", product,
                true, true, 63, 1199, 989, 1456, 1080, 1920, 1669,
                text, product), "wrong role must fail");
        require(!Fixed42AppearancePolicy.isExactStyleControl(
                text, "", "android.widget.ToggleButton", "other.package",
                true, true, 63, 1199, 989, 1456, 1080, 1920, 1669,
                text, product), "wrong package must fail");
        require(!Fixed42AppearancePolicy.isExactStyleControl(
                text, "", "android.widget.ToggleButton", product,
                true, true, 63, 1199, 989, 1700, 1080, 1920, 1669,
                text, product), "covered bounds must fail");
        require(Fixed42AppearancePolicy.hasUniqueCandidate(1), "one candidate must pass");
        require(!Fixed42AppearancePolicy.hasUniqueCandidate(2), "duplicates must fail");

        require(Fixed42AppearancePolicy.isExactSummary(
                "Quiet focus", "", "android.widget.TextView", product,
                false, true, 63, 918, 286, 958, 1080, 1920, 1669,
                false, "Quiet focus", product),
                "sanitized XML selected header must pass");
        require(!Fixed42AppearancePolicy.isExactSummary(
                "Quiet focus", "", "android.view.View", product,
                false, true, 354, 1254, 931, 1302, 1080, 1920, 1669,
                true, "Quiet focus", product),
                "card label must not pass as selected header");
        require(!Fixed42AppearancePolicy.isExactSummary(
                "Quiet focus", "described", "android.widget.TextView", product,
                false, true, 63, 918, 286, 958, 1080, 1920, 1669,
                false, "Quiet focus", product),
                "described summary must fail");
        require(!Fixed42AppearancePolicy.isExactSummary(
                "Quiet focus", "", "android.widget.TextView", product,
                false, true, 63, 1660, 286, 1700, 1080, 1920, 1669,
                false, "Quiet focus", product),
                "covered summary must fail");
        require(!Fixed42AppearancePolicy.isExactSummary(
                "Quiet focus", "", "android.widget.TextView", product,
                false, true, 63, 918, 286, 958, 1080, 1920, 1669,
                true, "Quiet focus", product),
                "clickable ancestor must fail");
        System.out.println("fixed42-appearance-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-appearance-policy-"));
  const sourceFile = path.join(directory, "Fixed42AppearancePolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 Appearance policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42AppearancePolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 Appearance policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-appearance-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("fixed42 critical observer uses exact grouped progress and terminal queries before fresh Cancel", () => {
  fixed42CriticalQueryGroupContract(source);

  const splitTerminalQuery = source.replace(
    "BySelector terminalSelector = nativeDialogTextGroup(terminalTexts);",
    'BySelector terminalSelector = nativeDialogText("YAWF Stream is up to date");',
  );
  assert.notEqual(splitTerminalQuery, source, "split terminal-query mutant anchor was absent");
  assert.throws(() => fixed42CriticalQueryGroupContract(splitTerminalQuery));

  const skippedFreshTerminal = source.replace(
    "            assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(freshTerminalCounts);",
    "",
  );
  assert.notEqual(skippedFreshTerminal, source, "fresh terminal-exclusion mutant anchor was absent");
  assert.throws(() => fixed42CriticalQueryGroupContract(skippedFreshTerminal));

  const cachedCancel = source.replace(
    "            freshCancels.get(0).click();",
    "            cancels.get(0).click();",
  );
  assert.notEqual(cachedCancel, source, "cached Cancel mutant anchor was absent");
  assert.throws(() => fixed42CriticalQueryGroupContract(cachedCancel));
});

test("fixed42 grouped query policy executes exact scope and unfavorable phase counterexamples", () => {
  runFixed42CriticalQueryGroupPolicyHarness(source);

  const unquotedPattern = source.replace(
    "pattern.append(Pattern.quote(exactTexts[index]));",
    "pattern.append(exactTexts[index]);",
  );
  assert.notEqual(unquotedPattern, source, "unquoted union mutant anchor was absent");
  assert.throws(() => runFixed42CriticalQueryGroupPolicyHarness(unquotedPattern));

  const terminalAllowed = source.replace(
    "if (terminalCounts.total() != 0) {",
    "if (terminalCounts.total() < 0) {",
  );
  assert.notEqual(terminalAllowed, source, "terminal-admission mutant anchor was absent");
  assert.throws(() => runFixed42CriticalQueryGroupPolicyHarness(terminalAllowed));

  const missingCancelAllowed = source.replace(
    "if (cancelCount != 1) {",
    "if (cancelCount > 1) {",
  );
  assert.notEqual(missingCancelAllowed, source, "missing-Cancel mutant anchor was absent");
  assert.throws(() => runFixed42CriticalQueryGroupPolicyHarness(missingCancelAllowed));

  const packageScopeRemoved = source.replace(
    "|| !expectedPackage.equals(candidate.packageName)\n                        || !expectedClass.equals(candidate.className)",
    "|| !expectedClass.equals(candidate.className)",
  );
  assert.notEqual(packageScopeRemoved, source, "package-scope mutant anchor was absent");
  assert.throws(() => runFixed42CriticalQueryGroupPolicyHarness(packageScopeRemoved));

  const duplicatesAllowed = source.replace(
    "if (counts.count(index) > 1) {",
    "if (counts.count(index) < 0) {",
  );
  assert.notEqual(duplicatesAllowed, source, "duplicate-admission mutant anchor was absent");
  assert.throws(() => runFixed42CriticalQueryGroupPolicyHarness(duplicatesAllowed));
});

test("fixed42 grouped query timings stay bounded monotonic sanitized and receipt-visible", () => {
  fixed42CriticalTimingContract(source);

  const unbounded = source.replace(
    "            initialEnableQueryGroupTimings.remove(0);",
    "",
  );
  assert.notEqual(unbounded, source, "unbounded timing-buffer mutant anchor was absent");
  assert.throws(() => fixed42CriticalTimingContract(unbounded));

  const rawTextLeak = source.replace(
    '.append(" counts=");',
    '.append(" selector=").append(selector).append(" counts=");',
  );
  assert.notEqual(rawTextLeak, source, "raw observer-data mutant anchor was absent");
  assert.throws(() => fixed42CriticalTimingContract(rawTextLeak));

  const missingReceipt = source.replace(
    '                receipt.put("initialEnableQueryGroupTimings", initialEnableTimingJson);',
    "",
  );
  assert.notEqual(missingReceipt, source, "timing-receipt mutant anchor was absent");
  assert.throws(() => fixed42CriticalTimingContract(missingReceipt));
});

test("fixed baseline42 source-derived selector candidates fail closed and remain read-only after install", () => {
  fixedDataContract(source);
  const mutated = source.replace(
    'By.text(exactButtonText)\n                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)\n                        .clazz("android.widget.ToggleButton")',
    'By.text(exactButtonText)\n                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)\n                        .clazz("android.widget.Button")',
  );
  assert.notEqual(mutated, source, "fixed42 Appearance role mutation anchor was absent");
  assert.throws(() => fixedAppearanceSelectionContract(mutated));
  const invalidProfile = source.replace(
    "UiObject2 initialName = waitForFixed42ProfileNameField(\"initial profile name\");",
    'UiObject2 initialName = waitFor(By.desc("Your name"), SHORT_WAIT_MS, "initial profile name");',
  );
  assert.throws(() => fixedDataContract(invalidProfile));
  const receipt = methodBody(source, "writeReceipt");
  need(receipt, 'receipt.put("profileNamePostInstallSetTextActions",', "receipt omits postinstall write count");
});

test("fixed42 selects the source-observed Appearance text once and requires the real summary header", () => {
  fixedAppearanceSelectionContract(source);
  runFixed42AppearancePolicyHarness(source);
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
    "device.waitForIdle(750);\n            scrollable.scroll(Direction.DOWN, 0.75f);\n            if (attempt == 0 && firstScrollCaptureLabel != null)",
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

test("fixed42 Profile closure uses one input and complete fresh observations within one deadline", () => {
  fixedProfileClosureObservationContract(source);

  const staleAsAbsent = source.replace(
    "return Fixed42DialogClosurePolicy.STALE;",
    "return Fixed42DialogClosurePolicy.ABSENT;",
  );
  assert.notEqual(staleAsAbsent, source, "stale-as-absence mutant anchor was absent");
  assert.throws(() => fixedProfileClosureObservationContract(staleAsAbsent));

  const ambiguityAsAbsent = source.replace(
    "return Fixed42DialogClosurePolicy.AMBIGUOUS;",
    "return Fixed42DialogClosurePolicy.ABSENT;",
  );
  assert.notEqual(ambiguityAsAbsent, source, "ambiguity-as-absence mutant anchor was absent");
  assert.throws(() => fixedProfileClosureObservationContract(ambiguityAsAbsent));

  const repeatedClose = source.replace(
    '        clickFreshFixed42Button("Close", SHORT_WAIT_MS);',
    '        clickFreshFixed42Button("Close", SHORT_WAIT_MS);\n        clickFreshFixed42Button("Close", SHORT_WAIT_MS);',
  );
  assert.notEqual(repeatedClose, source, "repeated Close mutant anchor was absent");
  assert.throws(() => fixedProfileClosureObservationContract(repeatedClose));

  const resetDeadline = source.replace(
    "            while (clock.uptimeMillis() < deadline) {",
    "            while (clock.uptimeMillis() < deadline) {\n                long deadline = clock.uptimeMillis() + timeoutMs;",
  );
  assert.notEqual(resetDeadline, source, "deadline-reset mutant anchor was absent");
  assert.throws(() => fixedProfileClosureObservationContract(resetDeadline));

  const broadSelector = source.replaceAll(
    "By.clazz(DETAIL_DIALOG_CLASS).pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
    "By.clazz(DETAIL_DIALOG_CLASS)",
  );
  assert.notEqual(broadSelector, source, "broad dialog selector mutant anchor was absent");
  assert.throws(() => fixedProfileClosureObservationContract(broadSelector));
});

test("fixed42 Profile closure policy executes stale, present, absent, ambiguous and expiry cases", () => {
  runFixed42DialogClosurePolicyHarness(source);

  const presentAsGone = source.replace(
    "if (observation == ABSENT) return true;",
    "if (observation == ABSENT || observation == PRESENT) return true;",
  );
  assert.notEqual(presentAsGone, source, "present-as-gone mutant anchor was absent");
  assert.throws(() => runFixed42DialogClosurePolicyHarness(presentAsGone));

  const unboundedSleep = source.replace(
    "Math.min(RETRY_MS, deadline - completedAt)",
    "RETRY_MS",
  );
  assert.notEqual(unboundedSleep, source, "unbounded retry sleep mutant anchor was absent");
  assert.throws(() => runFixed42DialogClosurePolicyHarness(unboundedSleep));
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

function fixed42TwoAxisSeedContract(java) {
  const fixedSeed = methodBody(java, "seedFixed42MeaningfulLocalState");
  const legacySeed = methodBody(java, "seedMeaningfulLocalState");
  const drive = methodBody(java, "clickFixed42SampleThroughDiscoverRails");
  const scroll = methodBody(java, "performFixed42SeedScroll");
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const click = methodBody(java, "clickFreshFixed42Blade");
  const freshCandidates = methodBody(java, "fixed42FreshSemanticCandidates");

  need(fixedSeed, "clickFixed42SampleThroughDiscoverRails()",
    "fixed42 seed lost its scoped two-axis helper");
  assert.equal(fixedSeed.includes("scrollUntilVisibleProductSemanticOnAnyRoute"), false,
    "fixed42 restored the ambiguous any-route scroll helper");
  assert.equal(legacySeed.includes("clickFixed42SampleThroughDiscoverRails"), false,
    "legacy flow called the fixed42 raw accessibility helper");
  assert.equal((java.match(/clickFixed42SampleThroughDiscoverRails\s*\(/g) ?? []).length, 2,
    "fixed42 helper must have one declaration and one fixed-profile call");

  for (const token of [
    "isFixed42AutomaticMode()",
    "assertNoBindingTerms();",
    "observeFixed42SeedSnapshot()",
    "Fixed42SeedPolicy.didAdvance(",
    "Fixed42SeedPolicy.mayScroll(",
    "clickFreshFixed42Blade(ready, startedAt)",
  ]) need(drive, token, `two-axis driver lost ${token}`);
  assert.equal((drive.match(/assertNoBindingTerms\(\);/g) ?? []).length, 2,
    "scroll and click actions do not each have a fresh terms guard");
  assert.ok(drive.indexOf("assertNoBindingTerms();") < drive.indexOf("observeFixed42SeedSnapshot()"),
    "scroll snapshot preceded its all-window guard");

  need(java, "private static final int FIXED42_SEED_SCROLL_ACTION_LIMIT = 16;",
    "shared 16-action cap changed");
  need(java, "private static final long FIXED42_SEED_SCROLL_BOUND_MS = 45_000L;",
    "overall seed deadline changed");
  need(scroll, "isFixed42AutomaticMode()", "raw scroll lost its fixed42 profile gate");
  need(scroll, "ACTION_SCROLL_FORWARD", "raw scroll lost forward action admission");
  need(scroll, "ACTION_SCROLL_RIGHT", "raw scroll lost right action admission");
  need(scroll, "node.performAction(actionId)", "raw scroll lost its public action call");
  assert.equal((java.match(/ACTION_SCROLL_RIGHT/g) ?? []).length, 3,
    "right scroll must appear only in selection, fallback test, and admission");
  assert.equal((java.match(/ACTION_SCROLL_FORWARD/g) ?? []).length, 3,
    "forward scroll must appear only in vertical selection, fallback, and admission");
  assert.equal((java.match(/\.performAction\(/g) ?? []).length, 1,
    "raw accessibility action must have one fixed42 scroll-only call site");
  assert.equal(java.includes("ACTION_CLICK"), false,
    "raw accessibility click is never admitted");
  assert.equal(/\bACTION_(?!SCROLL_FORWARD|SCROLL_RIGHT)\w+/.test(`${drive}\n${scroll}`), false,
    "fixed42 raw action helper admitted a non-scroll action");

  for (const token of [
    "instrumentation.getUiAutomation().clearCache()",
    "getRootInActiveWindow()",
    'fixed42UniqueResource(nodes, "main-content")',
    'fixed42UniqueSemantic(nodes, "Discover page", true)',
    'fixed42UniqueSemantic(nodes, "Primary", true)',
    'fixed42UniqueSemantic(nodes, "Popular Movies", false)',
    "fixed42UniqueScrollableDescendant(",
    "fixed42IsDescendant(nodes, bladeIndex, railIndex)",
    "section.bounds.contains(rail.bounds)",
    "discover.bounds.contains(rail.bounds)",
    "main.bounds.contains(rail.bounds)",
    'assertNotNull("Fixed42 seed snapshot returned a null child", child)',
  ]) need(observe, token, `fresh scoped observation lost ${token}`);
  need(java, "visible = info.isVisibleToUser();", "raw nodes lost public visibility state");
  need(java, "&& visible", "raw identity no longer rejects invisible nodes");

  for (const token of [
    "instrumentation.getUiAutomation().clearCache()",
    "fixed42FreshSemanticCandidates(",
    '"android.widget.Button"',
    "proof.bladeBounds, visibleBlade",
    "proof.railBounds.contains(visibleBlade)",
    "visibleBlade.bottom <= proof.navigationTop",
    "ancestor.isScrollable()",
    "proof.railBounds.equals(ancestor.getVisibleBounds())",
    '"main-content".equals(ancestor.getResourceName())',
    '"Discover page"',
    "1, matchingRailAncestors",
    'freshSection, "Popular Movies", "android.widget.TextView", false',
    'null, "Primary", "android.view.View", false',
    "proof.bladeBounds, blade.getVisibleBounds()",
    "blade.click()",
  ]) need(click, token, `fresh ordinary Blade click lost ${token}`);
  need(freshCandidates, "productTextOrDescriptionSelectors(",
    "fresh query lost exact text-or-description selectors");
  assert.equal((click.match(/blade\.click\(\)/g) ?? []).length, 1,
    "fresh Blade control must be clicked exactly once");

  const scoped = `${drive}\n${scroll}\n${observe}\n${click}`;
  assert.doesNotMatch(scoped,
    /device\.(?:click|swipe)|executeShellCommand|startActivity|\.scroll\(|scrollUntilVisibleProductSemanticOnAnyRoute/,
    "fixed42 seed gained a coordinate, shell, route, or UiObject2 scroll fallback");
  assert.doesNotMatch(java, /UiObject2\.getAccessibilityNodeInfo/,
    "driver invented a non-public UiObject2 node accessor");
}

function fixed42MainProofDiagnosticContract(java) {
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const mainStart = observe.indexOf('int mainIndex = fixed42UniqueResource(nodes, "main-content");');
  const discoverStart = observe.indexOf(
    'int discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);',
    mainStart,
  );
  assert.ok(mainStart >= 0 && discoverStart > mainStart,
    "fixed42 main-content proof block is not bounded before Discover observation");
  const block = observe.slice(mainStart, discoverStart);

  for (const token of [
    "boolean packageMatch = product.equals(main.packageName);",
    'boolean classMatch = "android.view.View".equals(main.className);',
    "boolean visible = main.visible;",
    "boolean scrollable = main.scrollable;",
    "boolean clickable = main.clickable;",
    "boolean enabled = main.enabled;",
    "Rect expectedMainBounds = new Rect(0, 0, width, height);",
    "boolean boundsMatch = main.bounds.equals(expectedMainBounds);",
    `boolean mainIdentityMatches = packageMatch
                    && classMatch
                    && visible
                    && scrollable
                    && !clickable
                    && enabled;`,
    "if (!(mainIdentityMatches && boundsMatch)) {",
    'log("Fixed42 main-content proof failed"',
    '" packageMatch=" + packageMatch',
    '" classMatch=" + classMatch',
    '" visible=" + visible',
    '" scrollable=" + scrollable',
    '" clickable=" + clickable',
    '" enabled=" + enabled',
    '" boundsMatch=" + boundsMatch',
    '" rawLeft=" + main.bounds.left',
    '" rawTop=" + main.bounds.top',
    '" rawRight=" + main.bounds.right',
    '" rawBottom=" + main.bounds.bottom',
    '" expectedWidth=" + width',
    '" expectedHeight=" + height',
    `assertTrue("Fixed42 main-content identity changed",
                    mainIdentityMatches && boundsMatch);`,
  ]) need(block, token, `fixed42 main proof diagnostic lost ${token}`);

  assert.equal((block.match(/\blog\(/g) ?? []).length, 1,
    "fixed42 main proof must emit exactly one failure-only diagnostic");
  const failure = block.indexOf("if (!(mainIdentityMatches && boundsMatch)) {");
  const diagnostic = block.indexOf('log("Fixed42 main-content proof failed"', failure);
  const assertion = block.indexOf('assertTrue("Fixed42 main-content identity changed"', diagnostic);
  assert.ok(failure >= 0 && failure < diagnostic && diagnostic < assertion,
    "fixed42 main proof diagnostic is not failure-only and before the unchanged assertion");
  const logStatement = block.slice(diagnostic, block.indexOf(");", diagnostic) + 2);
  assert.doesNotMatch(logStatement, /main\.(?:packageName|className)|text|description/i,
    "fixed42 main proof diagnostic leaked raw accessibility identity or text");
  assert.doesNotMatch(block,
    /getRootInActiveWindow|clearCache|device\.(?:click|swipe|waitForIdle)|performAction|\.click\(|SystemClock\.sleep/,
    "fixed42 main proof diagnostic added an accessibility query, input, wait, or action");
}

function fixed42FinalClickDeadlineContract(java) {
  assert.match(
    java,
    /private void clickFreshFixed42Blade\(Fixed42ReadyProof proof, long startedAt\)/,
    "fresh Blade helper did not receive the original fixed42 start time",
  );
  const drive = methodBody(java, "clickFixed42SampleThroughDiscoverRails");
  const click = methodBody(java, "clickFreshFixed42Blade");
  need(drive, "clickFreshFixed42Blade(ready, startedAt)",
    "caller reset or omitted the original fixed42 start time");
  assert.equal(click.includes("startedAt ="), false,
    "fresh Blade helper reset the original deadline");
  need(click, `assertEquals("Fresh Blade Runner bounds changed immediately before click",
                proof.bladeBounds, blade.getVisibleBounds());
        assertTrue("Fixed42 seed deadline elapsed during fresh Blade queries",
                Fixed42SeedPolicy.withinDeadline(
                        startedAt, SystemClock.uptimeMillis()));
        blade.click();`,
  "deadline gate is not immediately after final proof and before the sole click");
  assert.equal((click.match(/Fixed42SeedPolicy\.withinDeadline\(/g) ?? []).length, 1,
    "fresh Blade helper must make exactly one final deadline decision");
  assert.equal((click.match(/blade\.click\(\)/g) ?? []).length, 1,
    "fresh Blade helper must retain exactly one ordinary click");
}

function runFixed42TwoAxisSeedPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42SeedPolicy");
  const harness = `
public final class Fixed42SeedPolicyHarness {
    private static final int FIXED42_SEED_SCROLL_ACTION_LIMIT = 16;
    private static final long FIXED42_SEED_SCROLL_BOUND_MS = 45_000L;
    ${policy}

    private static Fixed42SeedPolicy.Observation observation(
            boolean route, int main, int discover, int heading, int rail, int blade,
            boolean section, boolean railValid, boolean railReady,
            boolean bladeInRail, boolean bladeReady, int[] vertical, int[] cards) {
        return new Fixed42SeedPolicy.Observation(
                route, main, discover, heading, rail, blade,
                section, railValid, railReady, bladeInRail, bladeReady,
                vertical, cards);
    }

    private static int[] positions(int a, int b, int c, int d) {
        return new int[] {a, b, c, d};
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void reject(Runnable operation, String message) {
        try {
            operation.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError(message);
    }

    public static void main(String[] ignored) {
        int absent = Fixed42SeedPolicy.ABSENT;
        Fixed42SeedPolicy.Observation vertical = observation(
                true, 1, 1, 0, 0, 0, false, false, false, false, false,
                positions(934, 1386, absent, absent),
                positions(absent, absent, absent, absent));
        Fixed42SeedPolicy.Observation verticalMoved = observation(
                true, 1, 1, 0, 0, 0, false, false, false, false, false,
                positions(334, 786, absent, absent),
                positions(absent, absent, absent, absent));
        Fixed42SeedPolicy.Observation horizontal = observation(
                true, 1, 1, 1, 1, 0, true, true, true, false, false,
                positions(absent, absent, absent, 100),
                positions(28, 300, 572, absent));
        Fixed42SeedPolicy.Observation horizontalMoved = observation(
                true, 1, 1, 1, 1, 1, true, true, true, true, false,
                positions(absent, absent, absent, 100),
                positions(-244, 28, 300, 572));
        Fixed42SeedPolicy.Observation ready = observation(
                true, 1, 1, 1, 1, 1, true, true, true, true, true,
                positions(absent, absent, absent, 100),
                positions(-516, -244, 28, 300));

        require(Fixed42SeedPolicy.phase(vertical) == Fixed42SeedPolicy.PHASE_VERTICAL,
                "outer Discover root must start vertical");
        require(Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_VERTICAL, vertical, verticalMoved),
                "upward content movement must be observable");
        require(Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_VERTICAL, verticalMoved, horizontal),
                "Popular Movies viewport must transition vertical to horizontal");
        require(Fixed42SeedPolicy.phase(horizontal) == Fixed42SeedPolicy.PHASE_HORIZONTAL,
                "fully visible Popular Movies rail must scroll right");
        require(Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_HORIZONTAL, horizontal, horizontalMoved),
                "leftward card movement must be observable");
        require(Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_HORIZONTAL, horizontalMoved, ready),
                "fully visible Blade must finish horizontal progress");
        require(Fixed42SeedPolicy.phase(ready) == Fixed42SeedPolicy.PHASE_READY,
                "fresh visible Blade in the exact rail must become ready");
        require(!Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_VERTICAL, vertical, vertical),
                "no vertical progress must fail");
        require(!Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_HORIZONTAL, horizontal, horizontal),
                "no horizontal progress must fail");
        require(!Fixed42SeedPolicy.didAdvance(
                        Fixed42SeedPolicy.PHASE_HORIZONTAL,
                        observation(true, 1, 1, 1, 1, 0, true, true, true, false, false,
                                horizontal.verticalTops,
                                positions(absent, 300, 572, absent)),
                        horizontal),
                "an earlier card merely reappearing must not count as forward progress");

        reject(() -> Fixed42SeedPolicy.phase(observation(
                false, 1, 1, 0, 0, 0, false, false, false, false, false,
                vertical.verticalTops, vertical.cardLefts)), "route change must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 0, 1, 0, 0, 0, false, false, false, false, false,
                vertical.verticalTops, vertical.cardLefts)), "inner-only root must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 2, 1, 0, 0, 0, false, false, false, false, false,
                vertical.verticalTops, vertical.cardLefts)), "duplicate outer root must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 1, 1, 0, false, true, true, false, false,
                horizontal.verticalTops, horizontal.cardLefts)), "wrong section must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 1, 1, 0, true, false, true, false, false,
                horizontal.verticalTops, horizontal.cardLefts)), "wrong rail must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 1, 0, 0, true, false, false, false, false,
                horizontal.verticalTops, horizontal.cardLefts)), "missing rail must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 2, 1, 0, true, true, true, false, false,
                horizontal.verticalTops, horizontal.cardLefts)), "duplicate heading must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 1, 1, 2, true, true, true, true, true,
                ready.verticalTops, ready.cardLefts)), "ambiguous Blade must fail");
        reject(() -> Fixed42SeedPolicy.phase(observation(
                true, 1, 1, 1, 1, 1, true, true, true, false, false,
                horizontal.verticalTops, horizontal.cardLefts)), "Blade outside rail must fail");
        require(Fixed42SeedPolicy.phase(horizontalMoved)
                        == Fixed42SeedPolicy.PHASE_HORIZONTAL,
                "partially visible Blade must remain offscreen for click");
        reject(() -> Fixed42SeedPolicy.didAdvance(
                Fixed42SeedPolicy.PHASE_HORIZONTAL, horizontal, vertical),
                "horizontal to vertical route regression must fail");
        reject(() -> Fixed42SeedPolicy.didAdvance(
                Fixed42SeedPolicy.PHASE_VERTICAL, vertical,
                observation(false, 1, 1, 0, 0, 0, false, false, false, false, false,
                        verticalMoved.verticalTops, verticalMoved.cardLefts)),
                "post-action route change must fail");

        require(Fixed42SeedPolicy.mayScroll(15, 1_000L, 45_999L),
                "sixteenth shared action must remain available");
        require(!Fixed42SeedPolicy.mayScroll(16, 1_000L, 2_000L),
                "seventeenth action must fail");
        require(!Fixed42SeedPolicy.mayScroll(0, 1_000L, 46_000L),
                "overall deadline must fail");
        require(!Fixed42SeedPolicy.withinDeadline(1_000L, 46_000L),
                "click cannot occur after deadline");
        int clicks = 0;
        if (Fixed42SeedPolicy.withinDeadline(1_000L, 45_999L)) clicks++;
        if (Fixed42SeedPolicy.withinDeadline(1_000L, 46_000L)) clicks++;
        require(clicks == 1,
                "delayed fresh queries must not cross the final-action seam");
        System.out.println("fixed42-seed-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-seed-policy-"));
  const sourceFile = path.join(directory, "Fixed42SeedPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 seed policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42SeedPolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 seed policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-seed-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("fixed42 Blade seed uses one guarded public-scroll budget and one fresh ordinary click", () => {
  fixed42TwoAxisSeedContract(source);

  const mutants = [
    ["profile", source.replace(
      'assertTrue("Raw accessibility scrolling is restricted to the fixed42 profile",\n                isFixed42AutomaticMode());',
      'assertTrue("Raw accessibility scrolling is restricted to the fixed42 profile", true);',
    )],
    ["right-action", source.replace(
      "AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT",
      "AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD",
    )],
    ["null-child", source.replace(
      'assertNotNull("Fixed42 seed snapshot returned a null child", child);',
      "if (child == null) continue;",
    )],
    ["visibility", source.replace("visible = info.isVisibleToUser();", "visible = true;")],
    ["click", source.replace("blade.click();", "// blade click removed")],
    ["second-perform", source.replace(
      "node.performAction(actionId));",
      "node.performAction(actionId));\n        node.performAction(actionId);",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, "fixed42 structural mutant anchor was absent");
    assert.throws(() => fixed42TwoAxisSeedContract(mutant), `${label} mutant survived`);
  }
});

test("fixed42 main-content proof logs bounded primitive predicates only on failure", () => {
  fixed42MainProofDiagnosticContract(source);

  const mutants = [
    ["always-log", source.replace(
      "if (!(mainIdentityMatches && boundsMatch)) {",
      "if (true) {",
    )],
    ["visible-relaxed", source.replace(
      "                    && visible\n                    && scrollable",
      "                    && scrollable",
    )],
    ["clickable-inverted", source.replace("                    && !clickable", "                    && clickable")],
    ["raw-package", source.replace(
      '" packageMatch=" + packageMatch',
      '" packageMatch=" + main.packageName',
    )],
    ["bounds-relaxed", source.replace(
      "                    mainIdentityMatches && boundsMatch);",
      "                    mainIdentityMatches);",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `fixed42 main proof ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42MainProofDiagnosticContract(mutant),
      `fixed42 main proof ${label} mutant survived`,
    );
  }
});

test("fixed42 two-axis policy rejects wrong scope, no progress, offscreen Blade, and cap mutants", () => {
  runFixed42TwoAxisSeedPolicyHarness(source);
  const policy = nestedClassDeclaration(source, "Fixed42SeedPolicy");

  const mutations = [
    ["observation.headingCount > 1", "observation.headingCount > 2"],
    ["|| observation.mainCount != 1", "|| observation.mainCount < 0"],
    [
      "return observation.railReady ? PHASE_HORIZONTAL : PHASE_VERTICAL;",
      "return observation.bladeCount == 1 ? PHASE_READY : (observation.railReady ? PHASE_HORIZONTAL : PHASE_VERTICAL);",
    ],
    [
      "return lastPresent(after) > lastPresent(before);",
      "return true;",
    ],
    [
      "completedActions < FIXED42_SEED_SCROLL_ACTION_LIMIT",
      "completedActions <= FIXED42_SEED_SCROLL_ACTION_LIMIT",
    ],
  ];
  for (const [before, after] of mutations) {
    const mutantPolicy = policy.replace(before, after);
    assert.notEqual(mutantPolicy, policy, `fixed42 policy mutant anchor was absent: ${before}`);
    const mutant = source.replace(policy, mutantPolicy);
    assert.throws(
      () => runFixed42TwoAxisSeedPolicyHarness(mutant),
      `fixed42 policy mutant survived: ${before}`,
    );
  }
});

test("fixed42 final Blade click rejects delayed fresh queries at the original deadline", () => {
  fixed42FinalClickDeadlineContract(source);
  runFixed42TwoAxisSeedPolicyHarness(source);

  const resetDeadline = source.replace(
    "clickFreshFixed42Blade(ready, startedAt)",
    "clickFreshFixed42Blade(ready, SystemClock.uptimeMillis())",
  );
  assert.notEqual(resetDeadline, source, "deadline-reset mutant anchor was absent");
  assert.throws(() => fixed42FinalClickDeadlineContract(resetDeadline));

  const removedFinalGate = source.replace(
    `        assertTrue("Fixed42 seed deadline elapsed during fresh Blade queries",
                Fixed42SeedPolicy.withinDeadline(
                        startedAt, SystemClock.uptimeMillis()));
`,
    "",
  );
  assert.notEqual(removedFinalGate, source, "removed final gate mutant anchor was absent");
  assert.throws(() => fixed42FinalClickDeadlineContract(removedFinalGate));

  const lateBoundaryAllowed = source.replace(
    "now - startedAt < FIXED42_SEED_SCROLL_BOUND_MS",
    "now - startedAt <= FIXED42_SEED_SCROLL_BOUND_MS",
  );
  assert.notEqual(lateBoundaryAllowed, source, "late-boundary mutant anchor was absent");
  assert.throws(() => runFixed42TwoAxisSeedPolicyHarness(lateBoundaryAllowed));
});
