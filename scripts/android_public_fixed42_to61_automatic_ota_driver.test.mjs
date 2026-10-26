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
const sourcePath = process.env.FIXED42_TO61_JAVA_SOURCE == null
  ? defaultJava
  : path.resolve(process.env.FIXED42_TO61_JAVA_SOURCE);
const source = fs.readFileSync(sourcePath, "utf8");
const defaultAppManifest = path.join(
  root,
  "scripts/android-runtime-instrumentation/app/src/main/AndroidManifest.xml",
);
const appManifestPath = process.env.FIXED42_TO61_APP_MANIFEST_SOURCE == null
  ? defaultAppManifest
  : path.resolve(process.env.FIXED42_TO61_APP_MANIFEST_SOURCE);
const appManifest = fs.readFileSync(appManifestPath, "utf8");

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

function runFixed42LauncherPackagePolicyHarness(java) {
  const assertion = methodBody(java, "assertFixed42ExpectedLauncherPackage");
  const harness = `
public final class Fixed42LauncherPackagePolicyHarness {
    private static final String NEXUS_LAUNCHER_PACKAGE =
            "com.google.android.apps.nexuslauncher";
    private static final String HARNESS_APP_PACKAGE = "com.yawf.runtimeinstrumentation";
    private static final String HARNESS_TEST_PACKAGE = "com.yawf.runtimeinstrumentation.test";
    private static final class OtaFlowPolicy {
        private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    }
    private static void assertFalse(String message, boolean value) {
        if (value) throw new AssertionError(message);
    }
    private static void assertFixed42ExpectedLauncherPackage(String launcherPackage) {
${assertion}
    }
    private static void expectRejected(String value) {
        boolean rejected = false;
        try {
            assertFixed42ExpectedLauncherPackage(value);
        } catch (AssertionError expected) {
            rejected = true;
        }
        if (!rejected) throw new AssertionError("unsafe launcher resolver survived");
    }
    public static void main(String[] args) {
        assertFixed42ExpectedLauncherPackage(NEXUS_LAUNCHER_PACKAGE);
        expectRejected("android");
        expectRejected(OtaFlowPolicy.PRODUCT_PACKAGE);
        expectRejected(HARNESS_APP_PACKAGE);
        expectRejected(HARNESS_TEST_PACKAGE);
        System.out.println("fixed42-launcher-package-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-launcher-package-policy-"));
  const sourceFile = path.join(directory, "Fixed42LauncherPackagePolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 launcher package policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42LauncherPackagePolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 launcher package policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-launcher-package-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42To61LauncherContract(java) {
  const route = methodBody(java, "returnToProductThroughVisibleLauncher");
  need(route, "if (!isFixed42To61AutomaticMode())", "old profiles lost their existing preliminary Home path");
  const launch = methodBody(java, "launchFixed42ProductFromVisibleLauncher");
  const resolve = launch.indexOf("device.getLauncherPackageName()");
  const nonNull = launch.indexOf('assertNotNull("Default launcher package was unavailable');
  const profileGate = launch.indexOf("if (isFixed42To61AutomaticMode())");
  const packageProof = launch.indexOf("assertFixed42ExpectedLauncherPackage(launcherPackage)");
  const home = launch.indexOf("device.pressHome()");
  assert.ok(resolve >= 0 && resolve < nonNull && nonNull < profileGate
    && profileGate < packageProof && packageProof < home,
  "fixed42-to61 launcher must resolve and reject unsafe packages before its sole Home input");
  assert.equal((launch.match(/device\.getLauncherPackageName\(\)/g) ?? []).length, 1,
    "fixed42-to61 launcher must resolve its expected launcher exactly once");
  assert.equal((launch.match(/device\.pressHome\(\)/g) ?? []).length, 1,
    "fixed42 launcher path must contain exactly one Home input");
  const observe = methodBody(java, "observeFixed42LauncherReadiness");
  const falseForeground = observe.indexOf("if (!launcherForeground)");
  const to61Diagnostic = observe.indexOf("if (isFixed42To61AutomaticMode())", falseForeground);
  const diagnostic = observe.indexOf("fixed42LauncherPackageDiagnostic(", falseForeground);
  assert.ok(falseForeground >= 0 && to61Diagnostic > falseForeground && diagnostic > to61Diagnostic,
    "package classification must remain fixed42-to61 failure-only diagnostics");
}

function exactMainHomeIntent(xml) {
  const intents = [...xml.matchAll(/<intent>([\s\S]*?)<\/intent>/g)].map((match) => match[1]);
  return intents.filter((body) => {
    const actions = [...body.matchAll(/<action\s+android:name="([^"]+)"\s*\/>/g)]
      .map((match) => match[1]);
    const categories = [...body.matchAll(/<category\s+android:name="([^"]+)"\s*\/>/g)]
      .map((match) => match[1]);
    const children = [...body.matchAll(/<(?:action|category)\b/g)].length;
    return actions.length === 1
      && categories.length === 1
      && children === 2
      && actions[0] === "android.intent.action.MAIN"
      && categories[0] === "android.intent.category.HOME";
  }).length;
}

function need(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

function rejectMutation(body, original, replacement, contract) {
  need(body, original, `mutation anchor is missing: ${original}`);
  assert.throws(() => contract(body.replace(original, replacement)));
}

function replaceLast(body, original, replacement) {
  const index = body.lastIndexOf(original);
  assert.notEqual(index, -1, `mutation anchor is missing: ${original}`);
  return body.slice(0, index) + replacement + body.slice(index + original.length);
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
    "cancelCount == 1",
    "cancelCount > 1",
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

function fixed42To61FusedCancelObserverContract(java) {
  const run = methodBody(java, "runAutomaticFlow");
  const to61Branch = run.indexOf("if (isFixed42To61AutomaticMode()) {");
  const to61Call = run.indexOf("enableAndCancelInitialFixed42To61CheckNoIdle()", to61Branch);
  const legacyBranch = run.indexOf("} else if (isFixed42AutomaticMode()) {", to61Call);
  const legacyCall = run.indexOf("enableAndCancelInitialFixed42CheckNoIdle()", legacyBranch);
  const genericBranch = run.indexOf("} else {", legacyCall);
  assert.ok(to61Branch >= 0 && to61Branch < to61Call && to61Call < legacyBranch
    && legacyBranch < legacyCall && legacyCall < genericBranch,
  "fixed42-to61 fused observer is not isolated from the frozen fixed42-to59 path");

  const critical = methodBody(java, "enableAndCancelInitialFixed42To61CheckNoIdle");
  const selector = methodBody(java, "fixed42To61InitialCancelSnapshotSelector");
  const query = methodBody(java, "queryFixed42To61InitialCancelSnapshot");
  const timing = methodBody(java, "recordFixed42To61InitialObserverTiming");
  const noResultAfter = methodBody(java, "assertNoInitialEnableResultVisibleAfterCancel");
  const policy = nestedClassDeclaration(java, "Fixed42To61CancelSnapshotPolicy");

  for (const token of [
    "isFixed42To61AutomaticMode()",
    "Configurator.getInstance()",
    "configurator.setWaitForIdleTimeout(0L)",
    'By.res("android", "button1")',
    'Pattern.compile("\\\\AEnable\\\\z", Pattern.CASE_INSENSITIVE)',
    "assertNoBindingTermsAtCurrentIdlePolicy()",
    "freshEnables.get(0).click()",
    "long cancelDeadline = enableClickFinishedUptimeMs + SHORT_WAIT_MS",
    "instrumentation.getUiAutomation().clearCache()",
    "queryFixed42To61InitialCancelSnapshot(",
    "snapshot.assertNoTerminalBeforeCancel()",
    "snapshot.isReadyToCancel()",
    "Fixed42To61CancelSnapshotPolicy.assertWithinDeadline(",
    "initialEnableCancelSelections++",
    'assertEquals("Initial Enable Cancel must be selected exactly once"',
    "snapshot.cancel.click()",
    "catch (StaleObjectException stale)",
    '"Initial Enable Cancel became stale during its sole selection", stale)',
    "assertNoInitialEnableResultVisibleAfterCancel(terminalCounts)",
    "initialEnableSettledResultExclusionSamples = settled",
    "initialEnableCancelWon = true",
    "recordFixed42To61InitialObserverTiming(",
    "configurator.setWaitForIdleTimeout(previousIdleTimeout)",
    'capture("fixed42-initial-enable-cancel-settled")',
  ]) need(critical, token, `fixed42-to61 fused observer lost ${token}`);
  assert.equal((critical.match(/snapshot\.cancel\.click\(\)/g) ?? []).length, 1,
    "fixed42-to61 must issue exactly one Cancel input");
  assert.equal((critical.match(/queryFixed42To61InitialCancelSnapshot\(/g) ?? []).length, 1,
    "fixed42-to61 pre-action loop must use one coherent snapshot call site");
  const zeroIdle = critical.indexOf("configurator.setWaitForIdleTimeout(0L)");
  const enable = critical.indexOf("freshEnables.get(0).click()");
  const clear = critical.indexOf("instrumentation.getUiAutomation().clearCache()", enable);
  const observe = critical.indexOf("queryFixed42To61InitialCancelSnapshot(", clear);
  const terminal = critical.indexOf("snapshot.assertNoTerminalBeforeCancel()", observe);
  const ready = critical.indexOf("snapshot.isReadyToCancel()", terminal);
  const deadline = critical.indexOf("Fixed42To61CancelSnapshotPolicy.assertWithinDeadline(", ready);
  const select = critical.indexOf("initialEnableCancelSelections++", deadline);
  const click = critical.indexOf("snapshot.cancel.click()", select);
  const staleObservation = critical.indexOf("catch (StaleObjectException stale)", observe);
  const staleObservationContinue = critical.indexOf("continue;", staleObservation);
  const clickStale = critical.indexOf("catch (StaleObjectException stale)", click);
  const clickStaleFailure = critical.indexOf(
    '"Initial Enable Cancel became stale during its sole selection", stale)', clickStale,
  );
  assert.ok(zeroIdle >= 0 && zeroIdle < enable && enable < clear && clear < observe
    && observe < terminal && terminal < ready && ready < deadline && deadline < select
    && select < click,
  "fixed42-to61 did not prove one fresh snapshot and its original deadline before its sole click");
  assert.ok(staleObservation > observe && staleObservationContinue > staleObservation
    && staleObservationContinue < terminal,
  "stale pre-action snapshots are not wholly discarded within the observation loop");
  assert.ok(clickStale > click && clickStaleFailure > clickStale,
    "a stale sole click does not fail closed");
  assert.equal(critical.slice(clickStale, clickStaleFailure).includes("continue;"), false,
    "a stale Cancel click was retried");
  const beforeClick = critical.slice(enable, click);
  assert.equal(beforeClick.includes("capture("), false,
    "fixed42-to61 captured during the critical Enable-to-Cancel interval");
  assert.equal(beforeClick.includes("device.waitForIdle("), false,
    "fixed42-to61 waited for idle during the critical Enable-to-Cancel interval");
  assert.equal(beforeClick.includes("queryFixed42CriticalTextGroup("), false,
    "fixed42-to61 restored an independently expensive pre-click text query");
  assert.equal(beforeClick.includes("queryFixed42CriticalCancelGroup("), false,
    "fixed42-to61 restored an independently expensive pre-click Cancel query");
  const observerLoop = critical.slice(critical.indexOf("while (", enable),
    critical.indexOf("assertTrue(\"Initial Enable did not expose", enable));
  assert.equal((observerLoop.match(/clearCache\(\)/g) ?? []).length, 1,
    "fixed42-to61 observation attempt must use exactly one cache refresh");
  assert.equal((observerLoop.match(/queryFixed42To61InitialCancelSnapshot\(/g) ?? []).length, 1,
    "fixed42-to61 observation attempt must use exactly one all-root snapshot");

  for (const token of [
    "Fixed42To61CancelSnapshotPolicy.exactObservationPattern(",
    "progressTexts, terminalTexts)",
    ".pkg(OtaFlowPolicy.PRODUCT_PACKAGE)",
  ]) need(selector, token, `fixed42-to61 all-root selector lost ${token}`);
  assert.equal(selector.includes(".clazz("), false,
    "combined snapshot selector must admit both exact TextView and Button roles for classification");
  assert.equal((query.match(/device\.findObjects\(selector\)/g) ?? []).length, 1,
    "one fixed42-to61 snapshot must perform exactly one public all-root UiDevice query");
  assert.equal(query.includes("scope.findObjects"), false,
    "fixed42-to61 snapshot was narrowed below UiDevice all-root scope");
  for (const token of [
    "Fixed42To61CancelSnapshotPolicy.assertCandidateCount(matches.size())",
    "match.getApplicationPackage()",
    "match.getClassName()",
    "match.getResourceName()",
    "match.getText()",
    "match.isEnabled()",
    "match.isClickable()",
    "Fixed42To61CancelSnapshotPolicy.classify(",
    "int cancelIndex = classified.cancelIndex()",
    "matches.get(cancelIndex)",
  ]) need(query, token, `fixed42-to61 snapshot classification lost ${token}`);

  for (const token of [
    'static final String TEXT_VIEW_CLASS = "android.widget.TextView"',
    'static final String BUTTON_CLASS = "android.widget.Button"',
    'static final String CANCEL_RESOURCE = "android:id/button2"',
    "static final int MAX_CANDIDATES = 6",
    "Pattern.quote(progressTexts[index])",
    "Pattern.quote(terminalTexts[index])",
    'append("(?i:")',
    ".append(Pattern.quote(CANCEL_TEXT)).append(\")\")",
    "expectedPackage.equals(candidate.packageName)",
    "TEXT_VIEW_CLASS.equals(candidate.className)",
    "BUTTON_CLASS.equals(candidate.className)",
    "CANCEL_RESOURCE.equals(candidate.resourceName)",
    "candidate.enabled",
    "candidate.clickable",
    "terminalTotal() != 0",
    "cancelCount == 1",
    "cancelCount > 1",
    "nowUptimeMs >= deadlineUptimeMs",
  ]) need(policy, token, `fixed42-to61 fused policy lost ${token}`);
  need(noResultAfter, "after Cancel selection", "post-click terminal error remained temporally misleading");

  for (const token of [
    '"Fixed42-to61 initial observer timing enableStartUptimeMs="',
    '" enableFinishUptimeMs="',
    '" snapshotStartUptimeMs="',
    '" snapshotFinishUptimeMs="',
    '" cancelClickStartUptimeMs="',
    '" cancelClickFinishUptimeMs="',
    '" snapshotAttempts="',
    '" staleSnapshots="',
  ]) need(timing, token, `fixed42-to61 failure timing lost ${token}`);
  for (const forbidden of [
    "getText", "getContentDescription", "selector", "admittedTarget", "http", "failure",
  ]) assert.equal(timing.includes(forbidden), false,
    `fixed42-to61 timing diagnostic leaked dynamic observer data through ${forbidden}`);
  const restore = critical.indexOf("configurator.setWaitForIdleTimeout(previousIdleTimeout)");
  const timingCall = critical.lastIndexOf("recordFixed42To61InitialObserverTiming(");
  const capture = critical.indexOf('capture("fixed42-initial-enable-cancel-settled")');
  assert.ok(restore > click && timingCall > restore && capture > timingCall,
    "fixed42-to61 timing is not retained from the failure-safe finally block");
}

function runFixed42To61CancelSnapshotPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42To61CancelSnapshotPolicy");
  const harness = `
import java.util.regex.Pattern;

public final class Fixed42To61CancelSnapshotPolicyHarness {
${policy}

    private static final String PRODUCT = "com.tgk30.debridstreamer";
    private static final String TEXT = "android.widget.TextView";
    private static final String BUTTON = "android.widget.Button";
    private static final String CANCEL_RES = "android:id/button2";
    private static final String[] PROGRESS = {
            "Checking for updates",
            "Checking the official YAWF Stream Android release channel."
    };
    private static final String[] TERMINAL = {
            "YAWF Stream is up to date",
            "Update check unavailable",
            "YAWF Stream 2.3.61 is available"
    };

    private static Fixed42To61CancelSnapshotPolicy.Candidate candidate(
            String packageName, String className, String resourceName, String text,
            boolean enabled, boolean clickable) {
        return new Fixed42To61CancelSnapshotPolicy.Candidate(
                packageName, className, resourceName, text, enabled, clickable);
    }

    private static Fixed42To61CancelSnapshotPolicy.Candidate title() {
        return candidate(PRODUCT, TEXT, "android:id/alertTitle", PROGRESS[0], true, false);
    }

    private static Fixed42To61CancelSnapshotPolicy.Candidate message() {
        return candidate(PRODUCT, TEXT, "android:id/message", PROGRESS[1], true, false);
    }

    private static Fixed42To61CancelSnapshotPolicy.Candidate cancel() {
        return candidate(PRODUCT, BUTTON, CANCEL_RES, "CANCEL", true, true);
    }

    private static Fixed42To61CancelSnapshotPolicy.Snapshot classify(
            Fixed42To61CancelSnapshotPolicy.Candidate... candidates) {
        return Fixed42To61CancelSnapshotPolicy.classify(
                PRODUCT, PROGRESS, TERMINAL, candidates);
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
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
        Pattern exact = Fixed42To61CancelSnapshotPolicy.exactObservationPattern(
                PROGRESS, TERMINAL);
        for (String value : PROGRESS) require(exact.matcher(value).matches(), "progress missed");
        for (String value : TERMINAL) require(exact.matcher(value).matches(), "terminal missed");
        require(exact.matcher("Cancel").matches(), "Cancel missed");
        require(exact.matcher("CANCEL").matches(), "case-normalized Cancel missed");
        require(!exact.matcher("checking for updates").matches(), "progress became case-insensitive");
        require(!exact.matcher("Cancel update").matches(), "Cancel prefix admitted");

        Fixed42To61CancelSnapshotPolicy.Snapshot ready = classify(title(), message(), cancel());
        require(ready.isReadyToCancel(), "exact coherent snapshot was not ready");
        require(ready.cancelIndex() == 2, "exact Cancel index changed");
        ready.assertNoTerminalBeforeCancel();
        Fixed42To61CancelSnapshotPolicy.assertWithinDeadline(100L, 99L);
        expectAssertion(
                () -> Fixed42To61CancelSnapshotPolicy.assertWithinDeadline(100L, 100L),
                "deadline equality admitted a late click");
        expectAssertion(
                () -> Fixed42To61CancelSnapshotPolicy.assertCandidateCount(7),
                "candidate total bound was not enforced");

        for (int index = 0; index < TERMINAL.length; index++) {
            final int selected = index;
            Fixed42To61CancelSnapshotPolicy.Snapshot result = classify(
                    title(), message(), cancel(),
                    candidate(PRODUCT, TEXT, "android:id/alertTitle",
                            TERMINAL[selected], true, false));
            expectAssertion(result::assertNoTerminalBeforeCancel,
                    "terminal variant " + selected + " did not win");
        }
        Fixed42To61CancelSnapshotPolicy.Snapshot laterTerminal = classify(
                candidate(PRODUCT, TEXT, "android:id/alertTitle", TERMINAL[2], true, false));
        expectAssertion(laterTerminal::assertNoTerminalBeforeCancel,
                "earlier readiness incorrectly authorized a later terminal state");

        require(!classify(title(), message()).isReadyToCancel(), "missing Cancel admitted");
        require(!classify(title(), cancel()).isReadyToCancel(), "missing message admitted");
        expectAssertion(() -> classify(title(), title(), message(), cancel()),
                "duplicate title admitted");
        expectAssertion(() -> classify(title(), message(), cancel(), cancel()),
                "duplicate or other-window Cancel admitted");
        expectAssertion(() -> classify(
                candidate("other.package", TEXT, "android:id/alertTitle", PROGRESS[0], true, false),
                message(), cancel()), "wrong package admitted");
        expectAssertion(() -> classify(
                candidate(PRODUCT, BUTTON, "android:id/alertTitle", PROGRESS[0], true, false),
                message(), cancel()), "wrong progress class admitted");
        expectAssertion(() -> classify(title(), message(),
                candidate(PRODUCT, TEXT, CANCEL_RES, "Cancel", true, true)),
                "wrong Cancel class admitted");
        expectAssertion(() -> classify(title(), message(),
                candidate(PRODUCT, BUTTON, "android:id/button1", "Cancel", true, true)),
                "wrong Cancel resource admitted");
        expectAssertion(() -> classify(title(), message(),
                candidate(PRODUCT, BUTTON, CANCEL_RES, "Cancel", false, true)),
                "disabled Cancel admitted");
        expectAssertion(() -> classify(title(), message(),
                candidate(PRODUCT, BUTTON, CANCEL_RES, "Cancel", true, false)),
                "unclickable Cancel admitted");
        System.out.println("fixed42-to61-cancel-snapshot-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-to61-cancel-policy-"));
  const sourceFile = path.join(directory, "Fixed42To61CancelSnapshotPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42-to61 snapshot policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42To61CancelSnapshotPolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42-to61 snapshot policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-to61-cancel-snapshot-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
                "YAWF Stream 2.3.61 is available"
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
        require(!terminalPattern.matcher("YAWF Stream 2x3x61 is available").matches(),
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

test("fixed42-to61 profile routes through its isolated fused initial Cancel observer", () => {
  need(source, '"public-fixed42-to61-initial-cancel-due-resume-v1"', "profile name is missing");
  fixed42To61FusedCancelObserverContract(source);

  const genericIdle = source.replace(
    "configurator.setWaitForIdleTimeout(0L);\n        try {",
    "configurator.setWaitForIdleTimeout(10_000L);\n        try {",
  );
  assert.notEqual(genericIdle, source, "zero-idle mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(genericIdle));

  const legacyRoute = source.replace(
    "if (isFixed42To61AutomaticMode()) {\n            enableAndCancelInitialFixed42To61CheckNoIdle();",
    "if (isFixed42To61AutomaticMode()) {\n            enableAndCancelInitialFixed42CheckNoIdle();",
  );
  assert.notEqual(legacyRoute, source, "legacy-route mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(legacyRoute));
});

test("fixed42-to61 critical interval performs one all-root query and one immediate action", () => {
  fixed42To61FusedCancelObserverContract(source);

  const extraQuery = source.replace(
    "List<UiObject2> matches = device.findObjects(selector);",
    "List<UiObject2> matches = device.findObjects(selector);\n            device.findObjects(selector);",
  );
  assert.notEqual(extraQuery, source, "extra-query mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(extraQuery));

  const removedTerminalGate = source.replace(
    "                snapshot.assertNoTerminalBeforeCancel();\n",
    "",
  );
  assert.notEqual(removedTerminalGate, source, "terminal-gate mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(removedTerminalGate));

  const cachedCancel = source.replace(
    "                    snapshot.cancel.click();",
    "                    device.findObject(snapshotSelector).click();",
  );
  assert.notEqual(cachedCancel, source, "fresh-object mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(cachedCancel));

  const lateAction = source.replace(
    "                Fixed42To61CancelSnapshotPolicy.assertWithinDeadline(\n                        cancelDeadline, cancelClickStartedUptimeMs);\n",
    "",
  );
  assert.notEqual(lateAction, source, "deadline mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(lateAction));

  const preCancelCapture = source.replace(
    "                initialEnableCancelSelections++;",
    '                capture("mutant-before-cancel");\n                initialEnableCancelSelections++;',
  );
  assert.notEqual(preCancelCapture, source, "pre-Cancel capture mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(preCancelCapture));

  const legalGuardRemoved = source.replace(
    "            assertNoBindingTermsAtCurrentIdlePolicy();\n",
    "",
  );
  assert.notEqual(legalGuardRemoved, source, "legal-guard mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(legalGuardRemoved));

  const staleSnapshotRetained = source.replace(
    "                    if (remaining > 0L) SystemClock.sleep(Math.min(100L, remaining));\n                    continue;\n                } catch (RuntimeException | AssertionError failure)",
    "                    if (remaining > 0L) SystemClock.sleep(Math.min(100L, remaining));\n                    break;\n                } catch (RuntimeException | AssertionError failure)",
  );
  assert.notEqual(staleSnapshotRetained, source, "stale-snapshot mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(staleSnapshotRetained));

  const clickRetry = source.replace(
    '                    throw new AssertionError(\n                            "Initial Enable Cancel became stale during its sole selection", stale);',
    "                    snapshot.cancel.click();",
  );
  assert.notEqual(clickRetry, source, "click-retry mutant anchor was absent");
  assert.throws(() => fixed42To61FusedCancelObserverContract(clickRetry));
});

test("fixed42-to61 fused policy executes scope, terminal, ambiguity and deadline counterexamples", () => {
  runFixed42To61CancelSnapshotPolicyHarness(source);

  const terminalAllowed = source.replace(
    "if (terminalTotal() != 0) {",
    "if (terminalTotal() < 0) {",
  );
  assert.notEqual(terminalAllowed, source, "terminal-admission mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(terminalAllowed));

  const unbounded = source.replace(
    "if (count < 0 || count > MAX_CANDIDATES) {",
    "if (count < 0) {",
  );
  assert.notEqual(unbounded, source, "candidate-bound mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(unbounded));

  const packageScopeRemoved = source.replace(
    "if (candidate == null || !expectedPackage.equals(candidate.packageName)) {",
    "if (candidate == null) {",
  );
  assert.notEqual(packageScopeRemoved, source, "package-scope mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(packageScopeRemoved));

  const resourceScopeRemoved = source.replace(
    "|| !CANCEL_RESOURCE.equals(candidate.resourceName)",
    "",
  );
  assert.notEqual(resourceScopeRemoved, source, "Cancel-resource mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(resourceScopeRemoved));

  const stateScopeRemoved = source.replace(
    "|| !candidate.enabled\n                            || !candidate.clickable",
    "",
  );
  assert.notEqual(stateScopeRemoved, source, "Cancel-state mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(stateScopeRemoved));

  const lateDeadlineAllowed = source.replace(
    "nowUptimeMs >= deadlineUptimeMs",
    "nowUptimeMs > deadlineUptimeMs",
  );
  assert.notEqual(lateDeadlineAllowed, source, "deadline-equality mutant anchor was absent");
  assert.throws(() => runFixed42To61CancelSnapshotPolicyHarness(lateDeadlineAllowed));
});

test("fixed42 critical observer uses exact grouped progress and terminal queries before fresh Cancel", () => {
  fixed42CriticalQueryGroupContract(source);

  const splitTerminalQuery = replaceLast(
    source,
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

function fixed42LauncherReadinessContract(java) {
  const dispatch = methodBody(java, "launchProductFromVisibleLauncher");
  const fixed = methodBody(java, "launchFixed42ProductFromVisibleLauncher");
  const observe = methodBody(java, "observeFixed42LauncherReadiness");
  const clipping = methodBody(java, "fixed42LauncherIconFullyVisible");
  const fresh = methodBody(java, "findFreshFixed42LauncherIcon");
  const legacy = methodBody(java, "launchVisibleAppFromLauncher");
  const policy = nestedClassDeclaration(java, "Fixed42LauncherReadinessPolicy");

  for (const token of [
    "if (isFixed42AutomaticMode())",
    "launchFixed42ProductFromVisibleLauncher(phase)",
    'launchVisibleAppFromLauncher("YAWF Stream", OtaFlowPolicy.PRODUCT_PACKAGE, phase)',
  ]) need(dispatch, token, `fixed42 launcher dispatch lost ${token}`);
  assert.equal(legacy.includes("launchFixed42ProductFromVisibleLauncher"), false,
    "legacy launcher helper entered the fixed42 readiness observer");
  assert.equal((java.match(/launchFixed42ProductFromVisibleLauncher\s*\(/g) ?? []).length, 2,
    "fixed42 launcher helper must have one declaration and one profile-gated call");

  for (const token of [
    "long startedAt = SystemClock.uptimeMillis();",
    "device.getLauncherPackageName()",
    "device.pressHome()",
    "Fixed42LauncherReadinessPolicy.withinDeadline(",
    "observeFixed42LauncherReadiness(",
    "Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON",
    "&& !drawerGestureSent",
    "assertNoBindingTerms();",
    "device.swipe(width / 2, height - 2, width / 2, height / 4, 30)",
    "drawerGestureSent = true;",
    'assertNotNull("Timed out waiting for exact fixed42 launcher readiness", ready)',
    'assertEquals("Fixed42 launcher icon bounds changed before click"',
    "findFreshFixed42LauncherIcon(",
    "freshIcon.click()",
    "device.wait(Until.hasObject(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE)), UI_WAIT_MS)",
  ]) need(fixed, token, `fixed42 launcher readiness flow lost ${token}`);
  assert.equal((fixed.match(/startedAt\s*=/g) ?? []).length, 1,
    "fixed42 launcher readiness reset its original monotonic deadline");
  assert.equal((fixed.match(/device\.pressHome\(\)/g) ?? []).length, 1,
    "fixed42 launcher readiness must issue one Home input");
  assert.equal((fixed.match(/device\.swipe\(/g) ?? []).length, 1,
    "fixed42 launcher readiness must have one drawer gesture site");
  assert.equal((fixed.match(/drawerGestureSent = true;/g) ?? []).length, 1,
    "fixed42 launcher readiness must permanently consume its one drawer gesture");
  assert.equal((fixed.match(/freshIcon\.click\(\)/g) ?? []).length, 1,
    "fixed42 launcher readiness must have one fresh icon click site");
  assert.ok(fixed.indexOf("long startedAt = SystemClock.uptimeMillis();")
      < fixed.indexOf("device.getLauncherPackageName()")
      && fixed.indexOf("device.getLauncherPackageName()") < fixed.indexOf("device.pressHome()"),
  "fixed42 original deadline must cover launcher discovery and Home transition");
  const finalBounds = fixed.indexOf('assertEquals("Fixed42 launcher icon bounds changed before click"');
  const finalDeadline = fixed.lastIndexOf("Fixed42LauncherReadinessPolicy.withinDeadline(");
  const click = fixed.indexOf("freshIcon.click()");
  assert.ok(finalBounds >= 0 && finalBounds < finalDeadline && finalDeadline < click,
    "fresh bounds and original deadline do not immediately guard the sole icon click");
  assert.doesNotMatch(fixed,
    /startActivity|executeShellCommand|ComponentName|findUniqueLauncherObject|device\.click\(/,
    "fixed42 launcher readiness added a shortcut, shell, generic selector or coordinate click");

  for (const token of [
    "if (!launcherForeground)",
    "false, 0, false, 0, false, false, false",
    "Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE",
    "instrumentation.getUiAutomation().clearCache()",
    "instrumentation.getUiAutomation()",
    ".getRootInActiveWindow()",
    "childCount <= FIXED42_LAUNCHER_CHILD_LIMIT",
    "owned.size() < FIXED42_LAUNCHER_NODE_LIMIT",
    "if (child == null)",
    "stale = true",
    "fixed42RecycleNodes(owned)",
    "new Fixed42AxNode(owned.get(index), parents.get(index))",
    "launcherResource.equals(node.resourceName)",
    "node.semanticEquals(appLabel)",
    'launcherPackage, "android.widget.FrameLayout", false, false',
    'launcherPackage, "android.widget.TextView", false, true',
    "launcherRoot.bounds.equals(new Rect(0, 0, width, height))",
    "fixed42LauncherIconFullyVisible(",
    "false, false, true",
  ]) need(observe, token, `fixed42 launcher observation lost ${token}`);
  fixed42LauncherCacheOrderingContract(java);
  for (const token of [
    "!fixed42FullBounds(iconBounds, width, height)",
    "cursor >= 0 && depth < FIXED42_LAUNCHER_ANCESTOR_LIMIT",
    "!ancestor.visible",
    "!launcherPackage.equals(ancestor.packageName)",
    "!fixed42FullBounds(ancestor.bounds, width, height)",
    "!ancestor.bounds.contains(iconBounds)",
    "if (cursor == rootIndex) return true;",
  ]) need(clipping, token, `fixed42 launcher clipping proof lost ${token}`);
  for (const token of [
    "launcherPackage, device.getCurrentPackageName()",
    "By.text(appLabel).pkg(launcherPackage)",
    "By.desc(appLabel).pkg(launcherPackage)",
    'assertEquals("Expected one fresh exact fixed42 launcher icon", 1, matches.size())',
    '"android.widget.TextView", icon.getClassName()',
    "icon.isClickable() && icon.isEnabled()",
    "expectedBounds, icon.getVisibleBounds()",
  ]) need(fresh, token, `fresh fixed42 launcher icon proof lost ${token}`);
  for (const token of [
    "if (stale) return STALE;",
    "if (rootCount > 1 || iconCount > 1)",
    "if (!launcherForeground) return WAITING_FOR_LAUNCHER;",
    "if (!rootExact)",
    "if (iconCount == 0) return WAITING_FOR_ICON;",
    "if (!iconExact)",
    "if (!iconFullyVisible) return WAITING_FOR_ICON;",
    "return READY;",
    "now >= startedAt && now - startedAt < SHORT_WAIT_MS",
  ]) need(policy, token, `fixed42 launcher policy lost ${token}`);
}

function fixed42LauncherCacheOrderingContract(java) {
  const observe = methodBody(java, "observeFixed42LauncherReadiness");
  const apiGate = observe.indexOf(
    "Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE",
  );
  const cacheRefresh = observe.indexOf(
    "instrumentation.getUiAutomation().clearCache()",
  );
  const foregroundRead = observe.indexOf("device.getCurrentPackageName()");
  const foregroundReject = observe.indexOf("if (!launcherForeground)");

  assert.equal((observe.match(/clearCache\(\)/g) ?? []).length, 1,
    "fixed42 launcher observation must clear the accessibility cache exactly once");
  assert.ok(apiGate >= 0
      && apiGate < cacheRefresh
      && cacheRefresh < foregroundRead
      && foregroundRead < foregroundReject,
  "fixed42 launcher must fail closed on API 34 cache refresh before reading foreground");

  const traversal = observe.indexOf("List<AccessibilityNodeInfo> owned");
  assert.ok(foregroundReject < traversal,
    "fixed42 non-launcher foreground must return before tree traversal");
  const falseForeground = observe.slice(foregroundReject, traversal);
  need(falseForeground, "false, 0, false, 0, false, false, false",
    "fixed42 false foreground no longer classifies as waiting");
  need(falseForeground, "return new Fixed42LauncherObservation(",
    "fixed42 false foreground no longer returns before traversal");
}

function runFixed42LauncherReadinessPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42LauncherReadinessPolicy");
  const harness = `
public final class Fixed42LauncherReadinessPolicyHarness {
    private static final long SHORT_WAIT_MS = 20_000L;
    ${policy}

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
        int nonLauncher = Fixed42LauncherReadinessPolicy.classify(
                false, 0, false, 0, false, false, false);
        require(nonLauncher == Fixed42LauncherReadinessPolicy.WAITING_FOR_LAUNCHER,
                "non-launcher foreground must never become ready");
        int rootPending = Fixed42LauncherReadinessPolicy.classify(
                true, 0, false, 0, false, false, false);
        require(rootPending == Fixed42LauncherReadinessPolicy.WAITING_FOR_LAUNCHER,
                "missing launcher root must remain pending");
        int iconPending = Fixed42LauncherReadinessPolicy.classify(
                true, 1, true, 0, false, false, false);
        require(iconPending == Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                "exact launcher without its icon must wait before input");
        int stale = Fixed42LauncherReadinessPolicy.classify(
                true, 0, false, 0, false, false, true);
        require(stale == Fixed42LauncherReadinessPolicy.STALE,
                "stale snapshot must not mean absent or ready");
        int ready = Fixed42LauncherReadinessPolicy.classify(
                true, 1, true, 1, true, true, false);
        require(ready == Fixed42LauncherReadinessPolicy.READY,
                "fresh exact visible icon must become ready");

        reject(() -> Fixed42LauncherReadinessPolicy.classify(
                true, 2, true, 0, false, false, false),
                "duplicate launcher roots must fail closed");
        reject(() -> Fixed42LauncherReadinessPolicy.classify(
                true, 1, true, 2, true, true, false),
                "ambiguous exact icons must fail closed");
        reject(() -> Fixed42LauncherReadinessPolicy.classify(
                true, 1, false, 0, false, false, false),
                "wrong launcher identity must fail closed");
        int clipped = Fixed42LauncherReadinessPolicy.classify(
                true, 1, true, 1, true, false, false);
        require(clipped == Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                "clipped transition icon must remain non-actionable");
        reject(() -> Fixed42LauncherReadinessPolicy.classify(
                true, 1, true, 1, false, true, false),
                "wrong icon identity must fail closed");

        require(Fixed42LauncherReadinessPolicy.withinDeadline(1_000L, 20_999L),
                "readiness must retain the last bounded millisecond");
        require(!Fixed42LauncherReadinessPolicy.withinDeadline(1_000L, 21_000L),
                "readiness timeout must fail at its exact boundary");
        require(!Fixed42LauncherReadinessPolicy.withinDeadline(2_000L, 1_999L),
                "non-monotonic time must fail closed");

        int clicks = 0;
        int[] transition = new int[] {stale, nonLauncher, rootPending, iconPending, ready};
        for (int state : transition) {
            if (state == Fixed42LauncherReadinessPolicy.READY) clicks++;
        }
        require(clicks == 1, "stale launcher transition must admit one fresh click only");
        int timedOutClicks = 0;
        int[] timedOut = new int[] {stale, nonLauncher, rootPending, iconPending, clipped};
        for (int state : timedOut) {
            if (state == Fixed42LauncherReadinessPolicy.READY) timedOutClicks++;
        }
        require(timedOutClicks == 0, "timeout path must not manufacture readiness");
        System.out.println("fixed42-launcher-readiness-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-launcher-readiness-"));
  const sourceFile = path.join(directory, "Fixed42LauncherReadinessPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 launcher policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42LauncherReadinessPolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 launcher policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-launcher-readiness-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42LauncherDiagnosticsContract(java) {
  const launch = methodBody(java, "launchFixed42ProductFromVisibleLauncher");
  const observe = methodBody(java, "observeFixed42LauncherReadiness");
  const iconReason = methodBody(java, "fixed42LauncherIconDiagnostic");
  const primitives = methodBody(java, "fixed42LauncherPrimitiveDiagnostic");
  const diagnostics = nestedClassDeclaration(java, "Fixed42LauncherDiagnostics");

  for (const token of [
    "Fixed42LauncherDiagnostics diagnostics = new Fixed42LauncherDiagnostics();",
    "diagnostics.record(observation.state, observation.diagnostic,",
    "diagnostics.record(beforeDrawer.state, beforeDrawer.diagnostic,",
    "Fixed42LauncherDiagnostics.durationMs(",
    "if (ready == null) {",
    "log(diagnostics.timeoutLine(",
    'assertNotNull("Timed out waiting for exact fixed42 launcher readiness", ready)',
  ]) need(launch, token, `fixed42 launcher timeout diagnostic lost ${token}`);
  assert.equal((launch.match(/diagnostics\.record\(/g) ?? []).length, 2,
    "every existing bounded readiness observation must be recorded once");
  assert.equal((launch.match(/log\(diagnostics\.timeoutLine\(/g) ?? []).length, 1,
    "fixed42 launcher timeout must emit one diagnostic line");

  const failureGuard = launch.indexOf("if (ready == null) {");
  const failureLog = launch.indexOf("log(diagnostics.timeoutLine(", failureGuard);
  const timeout = launch.indexOf(
    'assertNotNull("Timed out waiting for exact fixed42 launcher readiness", ready)',
    failureLog,
  );
  assert.ok(failureGuard >= 0 && failureGuard < failureLog && failureLog < timeout,
    "launcher diagnostic is not failure-only and immediately before the unchanged timeout");
  const failureBlock = launch.slice(failureGuard, timeout);
  assert.doesNotMatch(failureBlock,
    /observeFixed42LauncherReadiness|device\.|\.click\(|\.swipe\(|SystemClock\.sleep/,
    "launcher timeout diagnostic added a query, wait, or input");
  assert.doesNotMatch(failureBlock, /appLabel|launcherPackage/,
    "launcher timeout diagnostic leaked raw label or package values");

  for (const token of [
    '"foreground"',
    '"root-unavailable"',
    '"stale-child"',
    "boolean rootBoundsMatch = launcherRoot != null",
    'rejectionReason = "root-absent"',
    'rejectionReason = "icon-absent"',
    'rejectionReason = "icon-clipped"',
    "activeRootPackageMatch",
    "iconDiagnostic.reason",
    "iconDiagnostic.ancestryDepth",
    "iconDiagnostic.reachedRoot",
  ]) need(observe, token, `fixed42 launcher primitive observation lost ${token}`);
  const classify = observe.lastIndexOf("Fixed42LauncherReadinessPolicy.classify(");
  const rootBoundsDiagnostic = observe.indexOf("boolean rootBoundsMatch = launcherRoot != null");
  const iconDiagnostic = observe.indexOf("fixed42LauncherIconDiagnostic(");
  assert.ok(classify >= 0 && classify < rootBoundsDiagnostic
      && rootBoundsDiagnostic < iconDiagnostic,
  "diagnostic primitive work must follow the unchanged acceptance predicate");

  for (const token of [
    '"bounds"',
    '"ancestor-hidden"',
    '"ancestor-package"',
    '"ancestor-bounds"',
    '"ancestor-containment"',
    '"disconnected"',
    "observedDepth",
  ]) need(iconReason, token, `fixed42 launcher icon rejection diagnostic lost ${token}`);
  assert.doesNotMatch(iconReason,
    /getChild|getPackageName|getClassName|getText|getContentDescription|getBoundsInScreen|isVisibleToUser/,
    "icon rejection diagnostic added an accessibility property or tree query");

  for (const token of [
    'new StringBuilder("reject=").append(rejectionReason)',
    '.append(" foreground=")',
    '.append(" activeRoot=")',
    '.append(" activePkg=")',
    '.append(" nodes=")',
    '.append(" nullChild=")',
    '.append(" root=")',
    '.append(" icon=")',
    '.append(" iconReject=")',
    '.append(" ancestry=")',
  ]) need(primitives, token, `fixed42 launcher primitive diagnostic lost ${token}`);
  assert.doesNotMatch(primitives,
    /appLabel|launcherPackage|packageName|className|contentDescription|\.text\b|\.description\b/,
    "launcher primitive diagnostic references raw accessibility identity values");

  for (const token of [
    "private final int[] stateCounts = new int[4]",
    "if (samples < Integer.MAX_VALUE) samples++",
    "stateCounts[state]++",
    "lastState = state",
    "lastPrimitives = primitives",
    "lastObservationMs = observationMs",
    "if (observationMs > maxObservationMs)",
    'new StringBuilder("Fixed42 launcher readiness timeout")',
    '.append(" samples=").append(samples)',
    '.append(" states=").append(joinCounts(stateCounts))',
    '.append(" lastState=").append(lastState)',
    '.append(" drawer=")',
    '.append(" elapsedMs=")',
    '.append(" observeMs=")',
    ".append(' ').append(lastPrimitives)",
    "finishedAt >= startedAt ? finishedAt - startedAt : -1L",
  ]) need(diagnostics, token, `fixed42 launcher diagnostic binding lost ${token}`);
  assert.doesNotMatch(diagnostics,
    /appLabel|launcherPackage|packageName|className|contentDescription|\.text\b|\.description\b/,
    "bounded launcher diagnostics reference raw accessibility identity values");
}

function runFixed42LauncherDiagnosticsHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42LauncherReadinessPolicy");
  const diagnostics = nestedClassDeclaration(java, "Fixed42LauncherDiagnostics");
  const harness = `
public final class Fixed42LauncherDiagnosticsHarness {
    private static final long SHORT_WAIT_MS = 20_000L;
    ${policy}
    ${diagnostics}

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] ignored) {
        Fixed42LauncherDiagnostics values = new Fixed42LauncherDiagnostics();
        values.record(Fixed42LauncherReadinessPolicy.WAITING_FOR_LAUNCHER,
                "reject=foreground foreground=false activeRoot=false activePkg=unknown"
                        + " nodes=0 nullChild=false root=0/false/false"
                        + " icon=0/false/false iconReject=not-evaluated ancestry=0/false",
                2L);
        values.record(Fixed42LauncherReadinessPolicy.STALE,
                "reject=stale-child foreground=true activeRoot=true activePkg=unknown"
                        + " nodes=7 nullChild=true root=0/false/false"
                        + " icon=0/false/false iconReject=not-evaluated ancestry=0/false",
                5L);
        values.record(Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                "reject=icon-clipped foreground=true activeRoot=true activePkg=match"
                        + " nodes=57 nullChild=false root=1/true/true"
                        + " icon=1/true/false iconReject=ancestor-bounds ancestry=3/false",
                9L);
        String line = values.timeoutLine(true, 20_003L);
        for (String token : new String[] {
                "samples=3", "states=1/1/1/0", "lastState=1",
                "reject=icon-clipped", "drawer=true", "elapsedMs=20003",
                "observeMs=9/9", "foreground=true", "activeRoot=true",
                "activePkg=match", "nodes=57", "nullChild=false",
                "root=1/true/true", "icon=1/true/false",
                "iconReject=ancestor-bounds", "ancestry=3/false"
        }) require(line.contains(token), "missing diagnostic token: " + token);
        require(!line.contains("YAWF") && !line.contains("com.")
                        && !line.contains("android.widget"),
                "diagnostic leaked a raw accessibility identity");
        require(line.length() <= 500 && line.indexOf('\\n') < 0,
                "diagnostic must remain one bounded line");
        require(Fixed42LauncherDiagnostics.durationMs(100L, 150L) == 50L,
                "duration must retain monotonic elapsed time");
        require(Fixed42LauncherDiagnostics.durationMs(150L, 100L) == -1L,
                "duration must mark a non-monotonic sample");
        System.out.println("fixed42-launcher-diagnostics-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-launcher-diagnostics-"));
  const sourceFile = path.join(directory, "Fixed42LauncherDiagnosticsHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 launcher diagnostic javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42LauncherDiagnosticsHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 launcher diagnostic harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-launcher-diagnostics-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42FreshLauncherFailureDiagnosticContract(java) {
  const launch = methodBody(java, "launchFixed42ProductFromVisibleLauncher");
  const retention = methodBody(java, "logFixed42To61FreshLauncherFailure");
  const formatter = nestedClassDeclaration(java, "Fixed42FreshLauncherFailureDiagnostic");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");

  const freshObservation = launch.indexOf(
    "Fixed42LauncherObservation fresh = observeFixed42LauncherReadiness(",
  );
  const profileGate = launch.indexOf("if (isFixed42To61AutomaticMode()", freshObservation);
  const failedState = launch.indexOf(
    "&& fresh.state != Fixed42LauncherReadinessPolicy.READY",
    profileGate,
  );
  const diagnosticCall = launch.indexOf(
    "logFixed42To61FreshLauncherFailure(ready, fresh);",
    failedState,
  );
  const unchangedAssertion = launch.indexOf(
    'assertEquals("Fixed42 launcher icon was not freshly ready before click",\n'
      + "                Fixed42LauncherReadinessPolicy.READY, fresh.state);",
    diagnosticCall,
  );
  assert.ok(freshObservation >= 0 && profileGate > freshObservation
      && failedState > profileGate && diagnosticCall > failedState
      && unchangedAssertion > diagnosticCall,
  "fresh launcher diagnostic must be to61-only, failure-only, and before the unchanged rejection");
  assert.equal((java.match(/logFixed42To61FreshLauncherFailure\s*\(/g) ?? []).length, 2,
    "fresh launcher diagnostic must have one declaration and one call site");
  const failureBlock = launch.slice(profileGate, unchangedAssertion);
  assert.doesNotMatch(failureBlock,
    /observeFixed42LauncherReadiness|clearCache|getRootInActiveWindow|device\.|SystemClock|\.click\(|\.swipe\(/,
    "fresh launcher diagnostic added a query, wait, or input");
  assert.doesNotMatch(failureBlock, /appLabel|launcherPackage/,
    "fresh launcher diagnostic added raw launcher identity");

  for (const token of [
    'assertTrue("Fresh launcher failure diagnostic is restricted to fixed42-to61"',
    "isFixed42To61AutomaticMode()",
    'assertNotNull("Prior fixed42-to61 READY bounds were unavailable", ready.iconBounds)',
    "Fixed42FreshLauncherFailureDiagnostic.line(",
    "ready.state,",
    "ready.iconBounds.left,",
    "ready.iconBounds.top,",
    "ready.iconBounds.right,",
    "ready.iconBounds.bottom,",
    "fresh.state,",
    "fresh.diagnostic",
    'assertTrue("Fixed42-to61 fresh launcher diagnostic reached the action-log limit"',
    "value.length() < 500",
    'assertEquals("Fixed42-to61 fresh launcher diagnostic changed under action-log retention"',
    "value, safe(value)",
    "log(value)",
  ]) need(retention, token, `fresh launcher retention lost ${token}`);
  assert.doesNotMatch(retention,
    /observeFixed42LauncherReadiness|clearCache|getRootInActiveWindow|device\.|SystemClock|\.click\(|\.swipe\(/,
    "fresh launcher retention added a query, wait, or input");
  const exactRetention = retention.indexOf("value, safe(value)");
  const retainedLog = retention.indexOf("log(value)", exactRetention);
  assert.ok(exactRetention >= 0 && retainedLog > exactRetention,
    "fresh launcher diagnostic logged before exact retention proof");

  for (const token of [
    "priorState != Fixed42LauncherReadinessPolicy.READY",
    "priorLeft < 0",
    "priorTop < 0",
    "priorRight <= priorLeft",
    "priorBottom <= priorTop",
    "freshState < Fixed42LauncherReadinessPolicy.WAITING_FOR_LAUNCHER",
    "freshState >= Fixed42LauncherReadinessPolicy.READY",
    "freshDiagnostic == null",
    "freshDiagnostic.isEmpty()",
    'new StringBuilder("Fixed42-to61 fresh launcher failure")',
    '.append(" priorState=").append(priorState)',
    '.append(" priorBounds=").append(priorLeft).append(\',\').append(priorTop)',
    ".append(',').append(priorRight).append(',').append(priorBottom)",
    '.append(" freshState=").append(freshState)',
    ".append(' ').append(freshDiagnostic)",
  ]) need(formatter, token, `fresh launcher formatter lost ${token}`);
  assert.doesNotMatch(formatter,
    /appLabel|launcherPackage|packageName|className|contentDescription|https?:|credential|token|cookie/i,
    "fresh launcher formatter accepts raw identity or credential-bearing values");
  need(safe, "redacted.length() <= 500 ? redacted : redacted.substring(0, 500)",
    "actual action sanitizer lost its 500-character bound");
  need(log, "actions.add(safe(value));",
    "fresh launcher diagnostic no longer passes through the production action logger");
}

function runFixed42FreshLauncherFailureRetentionHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42LauncherReadinessPolicy");
  const formatter = nestedClassDeclaration(java, "Fixed42FreshLauncherFailureDiagnostic");
  const primitive = methodBody(java, "fixed42LauncherPrimitiveDiagnostic");
  const retention = methodBody(java, "logFixed42To61FreshLauncherFailure");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");
  const harness = `
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class Fixed42FreshLauncherFailureRetentionHarness {
    private static final long SHORT_WAIT_MS = 20_000L;
    private static final int MAX_ACTION_LINES = 260;
    private static final Pattern URL = Pattern.compile("https?://\\\\S+", Pattern.CASE_INSENSITIVE);
    private static final List<String> actions = new ArrayList<>();
    ${policy}
    ${formatter}

    private static final class Rect {
        final int left;
        final int top;
        final int right;
        final int bottom;
        Rect(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }
    }
    private static final class Fixed42LauncherObservation {
        final int state;
        final Rect iconBounds;
        final String diagnostic;
        Fixed42LauncherObservation(int state, Rect iconBounds, String diagnostic) {
            this.state = state;
            this.iconBounds = iconBounds;
            this.diagnostic = diagnostic;
        }
    }
    private static boolean isFixed42To61AutomaticMode() { return true; }
    private static void assertTrue(String message, boolean value) {
        if (!value) throw new AssertionError(message);
    }
    private static void assertNotNull(String message, Object value) {
        if (value == null) throw new AssertionError(message);
    }
    private static void assertEquals(String message, Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + ": " + expected + " != " + actual);
        }
    }
    private static void fail(String message) { throw new AssertionError(message); }
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
    private static String fixed42LauncherPrimitiveDiagnostic(
            String rejectionReason,
            boolean launcherForeground,
            boolean activeRootPresent,
            String activeRootPackageMatch,
            int nodeCount,
            boolean nullChildObserved,
            int rootCount,
            boolean rootExact,
            boolean rootBoundsMatch,
            int iconCount,
            boolean iconExact,
            boolean iconFullyVisible,
            String iconRejectionReason,
            int iconAncestryDepth,
            boolean iconReachedRoot) {
${primitive}
    }
    private static String safe(String value) {
${safe}
    }
    private static void log(String value) {
${log}
    }
    private static void logFixed42To61FreshLauncherFailure(
            Fixed42LauncherObservation ready,
            Fixed42LauncherObservation fresh) {
${retention}
    }

    public static void main(String[] ignored) {
        Rect priorBounds = new Rect(472, 1461, 609, 1616);
        Fixed42LauncherObservation ready = new Fixed42LauncherObservation(
                Fixed42LauncherReadinessPolicy.READY, priorBounds, "ready");
        String absent = fixed42LauncherPrimitiveDiagnostic(
                "icon-absent", true, true, "match", 56, false,
                1, true, true, 0, false, false,
                "not-evaluated", 0, false);
        String clipped = fixed42LauncherPrimitiveDiagnostic(
                "icon-clipped", true, true, "match", 57, false,
                1, true, true, 1, true, false,
                "ancestor-bounds", 3, false);
        logFixed42To61FreshLauncherFailure(ready,
                new Fixed42LauncherObservation(
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON, null, absent));
        logFixed42To61FreshLauncherFailure(ready,
                new Fixed42LauncherObservation(
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON, priorBounds, clipped));
        require(actions.size() == 2, "absent and clipped failures were not retained separately");
        String absentLine = actions.get(0);
        String clippedLine = actions.get(1);
        String prior = "priorState=3 priorBounds=472,1461,609,1616 freshState=1";
        require(absentLine.contains(prior) && clippedLine.contains(prior),
                "prior READY numeric state or bounds were not retained");
        require(absentLine.contains("reject=icon-absent")
                        && absentLine.contains("nodes=56")
                        && absentLine.contains("icon=0/false/false")
                        && absentLine.contains("iconReject=not-evaluated")
                        && absentLine.contains("ancestry=0/false"),
                "absent icon primitives were not retained losslessly");
        require(clippedLine.contains("reject=icon-clipped")
                        && clippedLine.contains("nodes=57")
                        && clippedLine.contains("icon=1/true/false")
                        && clippedLine.contains("iconReject=ancestor-bounds")
                        && clippedLine.contains("ancestry=3/false"),
                "clipped icon primitives were not retained losslessly");
        require(!absentLine.equals(clippedLine),
                "absent and clipped observations became indistinguishable");
        for (String line : actions) {
            require(line.length() < 500, "fresh launcher diagnostic reached the safe limit");
            require(safe(line).equals(line), "production action retention changed a diagnostic");
        }
        reject(() -> Fixed42FreshLauncherFailureDiagnostic.line(
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                        472, 1461, 609, 1616,
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON, absent),
                "non-READY prior observation survived");
        reject(() -> Fixed42FreshLauncherFailureDiagnostic.line(
                        Fixed42LauncherReadinessPolicy.READY,
                        472, 1461, 609, 1616,
                        Fixed42LauncherReadinessPolicy.READY, absent),
                "fresh READY observation entered the failure formatter");
        reject(() -> Fixed42FreshLauncherFailureDiagnostic.line(
                        Fixed42LauncherReadinessPolicy.READY,
                        472, 1461, 472, 1616,
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON, absent),
                "empty prior bounds survived");
        reject(() -> logFixed42To61FreshLauncherFailure(ready,
                        new Fixed42LauncherObservation(
                                Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                                null, "https://sensitive.invalid/value")),
                "sanitizer-changing diagnostic reached the production action log");
        require(actions.size() == 2, "rejected diagnostics changed the action log");
        System.out.println("fixed42-fresh-launcher-failure-retention-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-fresh-launcher-failure-"));
  const sourceFile = path.join(directory, "Fixed42FreshLauncherFailureRetentionHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0,
      `fixed42 fresh launcher retention javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand,
      ["-cp", directory, "Fixed42FreshLauncherFailureRetentionHarness"],
      { encoding: "utf8" });
    assert.equal(run.status, 0,
      `fixed42 fresh launcher retention harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-fresh-launcher-failure-retention-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42MainProofDiagnosticContract(java) {
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const mainStart = observe.indexOf('int mainIndex = fixed42UniqueResource(nodes, "main-content");');
  const discoverStart = observe.indexOf(
    'discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);',
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

function fixed42MainGeometryReacquisitionContract(java) {
  const drive = methodBody(java, "clickFixed42SampleThroughDiscoverRails");
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const capture = methodBody(java, "captureFixed42MainGeometryDiagnostic");
  const policy = nestedClassDeclaration(java, "Fixed42MainGeometryPolicy");
  const diagnostic = nestedClassDeclaration(java, "Fixed42MainGeometryDiagnostic");

  for (const token of [
    "private static final int FIXED42_TO61_MAIN_GEOMETRY_SAMPLE_LIMIT = 3;",
    "private static final long FIXED42_TO61_MAIN_GEOMETRY_RETRY_MS = 200L;",
  ]) need(java, token, `fixed42-to61 geometry bound lost ${token}`);

  for (const token of [
    "int mainGeometryMismatchSamples = 0",
    "assertNoBindingTerms();",
    "observeFixed42SeedSnapshot()",
    "catch (Fixed42MainGeometryMismatch mismatch)",
    "isFixed42To61AutomaticMode()",
    "mainGeometryMismatchSamples++",
    "mismatch.diagnostic.line(",
    "Fixed42MainGeometryPolicy.mayReacquire(",
    "startedAt",
    "FIXED42_SEED_SCROLL_BOUND_MS",
    "Fixed42MainGeometryPolicy.remainingMs(",
    "SystemClock.sleep(Math.min(",
    "continue;",
  ]) need(drive, token, `fixed42-to61 geometry reacquisition lost ${token}`);
  const guard = drive.indexOf("assertNoBindingTerms();");
  const observeCall = drive.indexOf("observeFixed42SeedSnapshot()", guard);
  const catchStart = drive.indexOf("catch (Fixed42MainGeometryMismatch mismatch)", observeCall);
  const retry = drive.indexOf("continue;", catchStart);
  const action = drive.indexOf("performFixed42SeedScroll(", observeCall);
  assert.ok(guard >= 0 && guard < observeCall && observeCall < catchStart && catchStart < retry,
    "geometry reacquisition escaped the guarded full-snapshot loop");
  const catchBody = drive.slice(catchStart, retry);
  assert.doesNotMatch(drive,
    /catch \((?:AssertionError|RuntimeException|Exception|Throwable)\b/,
    "identity, ambiguity, traversal, or terms failures entered the geometry retry path");
  assert.equal(catchBody.includes("completedActions++"), false,
    "geometry mismatch consumed the 16-action budget");
  assert.doesNotMatch(catchBody,
    /performFixed42SeedScroll|\.click\(|device\.(?:click|swipe|press)|ACTION_SCROLL/,
    "geometry mismatch emitted input before exact proof");
  assert.ok(action >= 0 && action < catchStart,
    "normal scroll action moved outside the exact-snapshot path");
  assert.equal((drive.match(/long startedAt = SystemClock\.uptimeMillis\(\)/g) ?? []).length, 1,
    "geometry retry reset the original seed deadline");
  need(drive, `Fixed42MainGeometryPolicy.mayReacquire(
                                mainGeometryMismatchSamples,
                                startedAt,
                                observedAt,
                                FIXED42_SEED_SCROLL_BOUND_MS)`,
  "geometry retry did not retain the original seed start time");

  const nullChild = observe.indexOf("assertNotNull(\"Fixed42 seed snapshot returned a null child\", child)");
  const childCap = observe.indexOf("childCount >= 0 && childCount <= FIXED42_SEED_AX_CHILD_LIMIT");
  const nodeCap = observe.indexOf("owned.size() < FIXED42_SEED_AX_NODE_LIMIT");
  const duplicate = observe.indexOf("Fixed42 seed snapshot returned a duplicate node");
  const main = observe.indexOf('fixed42UniqueResource(nodes, "main-content")');
  const discover = observe.indexOf('fixed42UniqueSemantic(nodes, "Discover page", true)', main);
  const primary = observe.indexOf('fixed42UniqueSemantic(nodes, "Primary", true)', discover);
  const heading = observe.indexOf('fixed42UniqueSemantic(nodes, "Popular Movies", false)', primary);
  const semanticPositions = observe.indexOf("fixed42SemanticPositions(", heading);
  const phase = observe.indexOf("Fixed42SeedPolicy.phase(observation)", semanticPositions);
  const mismatchThrow = observe.indexOf("throw new Fixed42MainGeometryMismatch");
  const transfer = observe.indexOf("transferred = true", mismatchThrow);
  const recycle = observe.indexOf("if (!transferred) fixed42RecycleNodes(owned)", transfer);
  assert.ok(childCap >= 0 && childCap < nullChild && nullChild < nodeCap
    && nodeCap < duplicate && duplicate < main && main < discover
    && discover < primary && primary < heading && heading < semanticPositions
    && semanticPositions < phase && phase < mismatchThrow && mismatchThrow < transfer
    && transfer < recycle,
  "geometry-only retry occurs before a full guarded snapshot or after ownership transfer");
  for (const token of [
    "Rect expectedMainBounds = new Rect(0, 0, width, height);",
    "boolean boundsMatch = main.bounds.equals(expectedMainBounds);",
    "if (!isFixed42To61AutomaticMode()) {",
    "if (!(mainIdentityMatches && boundsMatch)) {",
    `assertTrue("Fixed42 main-content identity changed",
                    mainIdentityMatches && boundsMatch);`,
    `assertTrue("Fixed42-to61 main-content identity changed",
                        mainIdentityMatches);`,
    `assertEquals("Fixed42-to61 raw bounds policies diverged",
                        boundsMatch,`,
    "Fixed42MainGeometryPolicy.isExactRawBounds(",
  ]) need(observe, token, `fixed42 profile-scoped raw geometry proof lost ${token}`);
  assert.equal(`${observe}\n${capture}`.includes("getVisibleBounds"), false,
    "raw snapshot eligibility was replaced with clipped visible bounds");

  for (const token of [
    "root.getBoundsInWindow(rootWindowBounds)",
    "main.getBoundsInWindow(mainWindowBounds)",
    "main.getWindow()",
    "window.getDisplayId()",
    "window.getId()",
    "window.getBoundsInScreen(accessibilityWindowBounds)",
    "window.recycle()",
    "root.getWindowId()",
    "main.getWindowId()",
  ]) need(capture, token, `same-snapshot primitive diagnostic lost ${token}`);
  for (const forbidden of ["getText", "getContentDescription", "getPackageName", "getClassName"])
    assert.equal(capture.includes(forbidden), false,
      `geometry diagnostic leaked dynamic accessibility identity through ${forbidden}`);
  for (const token of [
    '" display=" + displayWidth + \',\' + displayHeight',
    '" rootScreen=" + rect(rootScreenBounds)',
    '" rootWindow=" + rect(rootWindowBounds)',
    '" mainScreen=" + rect(mainScreenBounds)',
    '" mainWindow=" + rect(mainWindowBounds)',
    '" axWindow=" + accessibilityWindowPresent',
    '" nodeWindowIds=" + rootWindowId + \',\' + mainWindowId',
  ]) need(diagnostic, token, `bounded numeric geometry diagnostic lost ${token}`);
  assert.doesNotMatch(diagnostic,
    /getText|getContentDescription|getPackageName|getClassName|https?:|admittedTarget/,
    "geometry diagnostic contains dynamic text, identity, or URL data");

  for (const token of [
    "left == 0",
    "top == 0",
    "right == displayWidth",
    "bottom == displayHeight",
    "mismatchSamples < FIXED42_TO61_MAIN_GEOMETRY_SAMPLE_LIMIT",
    "now - startedAt < boundMs",
  ]) need(policy, token, `raw exact retry policy lost ${token}`);
  assert.doesNotMatch(policy, /Math\.(?:abs|min|max)|intersect|getVisibleBounds|[<>]=?\s*2\b/,
    "geometry policy added clipping or a 2px tolerance");
}

function fixed42DiscoverRouteClassifierContract(java) {
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const adapter = methodBody(java, "fixed42UniqueTo61DiscoverRoute");
  const generic = methodBody(java, "fixed42UniqueSemantic");
  const policy = nestedClassDeclaration(java, "Fixed42DiscoverRoutePolicy");
  const drive = methodBody(java, "clickFixed42SampleThroughDiscoverRails");

  const profileGate = observe.indexOf("if (isFixed42To61AutomaticMode()) {");
  const diagnostic = observe.indexOf("logFixed42To61DiscoverAmbiguityIfPresent(", profileGate);
  const classified = observe.indexOf(
    "discoverIndex = fixed42UniqueTo61DiscoverRoute(nodes, mainIndex);",
    diagnostic,
  );
  const legacyElse = observe.indexOf("} else {", classified);
  const genericCall = observe.indexOf(
    'discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);',
    legacyElse,
  );
  const routeProof = observe.indexOf(
    'assertTrue("Fixed42 Discover page identity changed"',
    genericCall,
  );
  assert.ok(profileGate >= 0 && diagnostic > profileGate && classified > diagnostic
      && legacyElse > classified && genericCall > legacyElse && routeProof > genericCall,
  "source-backed Discover classifier escaped its exact-to61 branch or existing route proof");
  assert.equal((java.match(/fixed42UniqueTo61DiscoverRoute\s*\(/g) ?? []).length, 2,
    "source-backed Discover classifier must have one declaration and one call site");

  const expectedGeneric = `int found = -1;
        for (int index = 0; index < nodes.size(); index++) {
            if (!nodes.get(index).semanticEquals(exact)) continue;
            assertTrue("Fixed42 semantic identity was ambiguous for " + exact, found < 0);
            found = index;
        }
        if (required) assertTrue("Fixed42 semantic identity was absent for " + exact, found >= 0);
        return found;`;
  assert.equal(generic.trim(), expectedGeneric,
    "generic and old59 semantic uniqueness changed");

  for (const token of [
    'assertTrue("Discover route classification is restricted to fixed42-to61"',
    "isFixed42To61AutomaticMode()",
    "nodes.get(0).info.getWindowId()",
    "nodes.get(mainIndex).info.getWindowId()",
    "new ArrayList<>()",
    "for (int index = 0; index < nodes.size(); index++)",
    'if (!candidate.semanticEquals("Discover page")) continue;',
    "new Fixed42DiscoverRoutePolicy.Candidate(",
    "candidate.parentIndex",
    "candidate.info.getWindowId()",
    '"Discover page".equals(candidate.text)',
    '"Discover page".equals(candidate.description)',
    "OtaFlowPolicy.PRODUCT_PACKAGE.equals(candidate.packageName)",
    '"android.view.View".equals(candidate.className)',
    "candidate.visible",
    "candidate.enabled",
    "candidate.scrollable",
    "candidate.clickable",
    "candidate.info.isFocusable()",
    "candidate.info.isFocused()",
    "candidate.info.isAccessibilityFocused()",
    "candidate.info.getLiveRegion()",
    "android.view.View.ACCESSIBILITY_LIVE_REGION_NONE",
    "fixed42IsDescendant(nodes, index, mainIndex)",
    "candidate.bounds.left",
    "candidate.bounds.top",
    "candidate.bounds.right",
    "candidate.bounds.bottom",
    "Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(",
    "matches, rootWindowId, mainWindowId",
  ]) need(adapter, token, `Discover route adapter lost ${token}`);
  assert.doesNotMatch(adapter,
    /clearCache|getRootInActiveWindow|SystemClock|waitForIdle|\.click\(|performAction|device\.(?:click|swipe|press)/,
    "Discover route adapter added a query, wait, retry, deadline, or input");

  for (const token of [
    "(textExact || descriptionExact)",
    "&& productPackage",
    "&& viewClass",
    "&& visible",
    "&& enabled",
    "&& !scrollable",
    "&& !clickable",
    "&& inMain",
    "&& windowId == rootWindowId",
    "textExact",
    "&& !descriptionExact",
    "&& !visible",
    "&& !focusable",
    "&& !focused",
    "&& !accessibilityFocused",
    "&& !liveRegion",
    "&& left == 0",
    "&& top == 0",
    "&& right == 0",
    "&& bottom == 0",
    "&& parentIndex == route.parentIndex",
    "&& windowId == route.windowId",
    "rootWindowId == mainWindowId",
    "routeRecord < 0",
    "routeRecord >= 0",
    "isKnownHiddenAnnouncement(route, rootWindowId)",
    "hiddenAnnouncements <= 1",
    "return route.nodeIndex",
  ]) need(policy, token, `Discover route policy lost ${token}`);
  assert.doesNotMatch(policy, /\b(?:21|24|14|1055|1922)\b/,
    "Discover route policy encoded one observed candidate index, parent, or extent");
  assert.doesNotMatch(policy,
    /clearCache|getRootInActiveWindow|SystemClock|waitForIdle|Thread\.sleep|\.click\(|performAction|device\./,
    "Discover route policy added an observation, retry, deadline reset, or input");
  assert.equal((drive.match(/long startedAt = SystemClock\.uptimeMillis\(\)/g) ?? []).length, 1,
    "Discover route classification reset the original 45-second deadline");
  assert.doesNotMatch(drive,
    /catch \((?:AssertionError|RuntimeException|Exception|Throwable)\b/,
    "Discover route classification entered a favorable-order retry path");
}

function runFixed42DiscoverRoutePolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42DiscoverRoutePolicy");
  const harness = `
import java.util.List;

public final class Fixed42DiscoverRoutePolicyHarness {
${policy}

    private static Fixed42DiscoverRoutePolicy.Candidate candidate(
            int nodeIndex, int parentIndex, int windowId,
            boolean textExact, boolean descriptionExact,
            boolean productPackage, boolean viewClass,
            boolean visible, boolean enabled, boolean scrollable, boolean clickable,
            boolean focusable, boolean focused, boolean accessibilityFocused,
            boolean liveRegion, boolean inMain,
            int left, int top, int right, int bottom) {
        return new Fixed42DiscoverRoutePolicy.Candidate(
                nodeIndex, parentIndex, windowId,
                textExact, descriptionExact, productPackage, viewClass,
                visible, enabled, scrollable, clickable,
                focusable, focused, accessibilityFocused, liveRegion, inMain,
                left, top, right, bottom);
    }

    private static Fixed42DiscoverRoutePolicy.Candidate route(
            int nodeIndex, int parentIndex, int windowId) {
        return candidate(nodeIndex, parentIndex, windowId,
                true, false, true, true,
                true, true, false, false,
                true, true, false, false, true,
                0, 60, 1055, 1922);
    }

    private static Fixed42DiscoverRoutePolicy.Candidate mirror(
            int nodeIndex, int parentIndex, int windowId) {
        return candidate(nodeIndex, parentIndex, windowId,
                true, false, true, true,
                false, true, false, false,
                false, false, false, false, true,
                0, 0, 0, 0);
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void reject(List<Fixed42DiscoverRoutePolicy.Candidate> matches,
            int rootWindowId, int mainWindowId, String message) {
        boolean rejected = false;
        try {
            Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(
                    matches, rootWindowId, mainWindowId);
        } catch (AssertionError expected) {
            rejected = true;
        }
        require(rejected, message);
    }

    public static void main(String[] args) {
        Fixed42DiscoverRoutePolicy.Candidate hidden = mirror(21, 14, 10);
        Fixed42DiscoverRoutePolicy.Candidate visible = route(24, 14, 10);
        require(Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(
                        List.of(hidden, visible), 10, 10) == 24,
                "actual failed graph primitives did not select the visible route");
        require(Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(
                        List.of(visible, hidden), 10, 10) == 24,
                "classifier encoded candidate ordering");
        require(Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(
                        List.of(visible), 10, 10) == 24,
                "zero-mirror graph was not admitted");
        Fixed42DiscoverRoutePolicy.Candidate describedRoute = candidate(
                31, 14, 10, false, true, true, true,
                true, true, false, false, false, false, false, false, true,
                0, 60, 1055, 1920);
        require(Fixed42DiscoverRoutePolicy.selectRouteNodeIndex(
                        List.of(describedRoute), 10, 10) == 31,
                "existing exact-description semantics were narrowed");

        reject(List.of(), 10, 10, "absent route survived");
        reject(List.of(hidden), 10, 10, "hidden announcement qualified as route");
        reject(List.of(visible, route(25, 14, 10)), 10, 10,
                "duplicate visible routes survived");
        reject(List.of(hidden, mirror(22, 14, 10), visible), 10, 10,
                "duplicate hidden announcements survived");
        reject(List.of(visible), 10, 11, "root/main window divergence survived");
        reject(List.of(route(24, 14, 11)), 10, 10, "foreign-window route survived");

        reject(List.of(candidate(24, 14, 10, true, false, false, true,
                true, true, false, false, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "wrong route package survived");
        reject(List.of(candidate(24, 14, 10, true, false, true, false,
                true, true, false, false, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "wrong route class survived");
        reject(List.of(candidate(24, 14, 10, true, false, true, true,
                true, true, false, false, true, true, false, false, false,
                0, 60, 1055, 1922)), 10, 10, "route outside main survived");
        reject(List.of(candidate(24, 14, 10, true, false, true, true,
                true, false, false, false, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "disabled route survived");
        reject(List.of(candidate(24, 14, 10, false, false, true, true,
                true, true, false, false, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "nonsemantic route survived");
        reject(List.of(candidate(24, 14, 10, true, false, true, true,
                true, true, true, false, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "scrollable route survived");
        reject(List.of(candidate(24, 14, 10, true, false, true, true,
                true, true, false, true, true, true, false, false, true,
                0, 60, 1055, 1922)), 10, 10, "clickable route survived");

        reject(List.of(candidate(21, 15, 10, true, false, true, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "wrong-parent mirror survived");
        reject(List.of(candidate(21, 14, 11, true, false, true, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "wrong-window mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, false, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "wrong-package mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, false,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "wrong-class mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, false, false, false, false, false,
                0, 0, 0, 0), visible), 10, 10, "mirror outside main survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                true, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "visible mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, false, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "disabled mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, true, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "scrollable mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, true, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "clickable mirror survived");
        reject(List.of(candidate(21, 14, 10, true, true, true, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "description-exact mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, true, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "focusable mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, false, true, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "focused mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, false, false, true, false, true,
                0, 0, 0, 0), visible), 10, 10, "accessibility-focused mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, false, false, false, true, true,
                0, 0, 0, 0), visible), 10, 10, "Android live-region mirror survived");
        reject(List.of(candidate(21, 14, 10, true, false, true, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 1, 0), visible), 10, 10, "nonzero mirror bounds survived");
        reject(List.of(candidate(21, 14, 10, false, true, true, true,
                false, true, false, false, false, false, false, false, true,
                0, 0, 0, 0), visible), 10, 10, "description-only hidden match survived");

        System.out.println("fixed42-discover-route-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-discover-route-policy-"));
  const sourceFile = path.join(directory, "Fixed42DiscoverRoutePolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0,
      `fixed42 Discover route policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand,
      ["-cp", directory, "Fixed42DiscoverRoutePolicyHarness"],
      { encoding: "utf8" });
    assert.equal(run.status, 0,
      `fixed42 Discover route policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-discover-route-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42DiscoverAmbiguityDiagnosticContract(java) {
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const diagnostic = methodBody(java, "logFixed42To61DiscoverAmbiguityIfPresent");
  const retention = methodBody(java, "logFixed42To61DiscoverDiagnosticLine");
  const unique = methodBody(java, "fixed42UniqueSemantic");
  const capture = methodBody(java, "captureFixed42MainGeometryDiagnostic");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");
  const policy = nestedClassDeclaration(java, "Fixed42DiscoverAmbiguityPolicy");

  need(java, "private static final int FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT = 4;",
    "Discover ambiguity diagnostic lost its four-record bound");
  need(java, "private static final int FIXED42_SEED_SCROLL_ACTION_LIMIT = 16;",
    "Discover diagnostics changed the shared 16-action bound");
  need(java, "private static final long FIXED42_SEED_SCROLL_BOUND_MS = 45_000L;",
    "Discover diagnostics changed the shared 45-second deadline");
  const mainGeometry = observe.indexOf(
    "Fixed42MainGeometryDiagnostic mainGeometryDiagnostic = boundsMatch",
  );
  const profileGate = observe.indexOf("if (isFixed42To61AutomaticMode()) {", mainGeometry);
  const diagnosticCall = observe.indexOf(
    "logFixed42To61DiscoverAmbiguityIfPresent(",
    profileGate,
  );
  const routeClassifier = observe.indexOf(
    "discoverIndex = fixed42UniqueTo61DiscoverRoute(nodes, mainIndex);",
    diagnosticCall,
  );
  const legacyElse = observe.indexOf("} else {", routeClassifier);
  const unchangedGenericRejection = observe.indexOf(
    'discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);',
    legacyElse,
  );
  assert.ok(mainGeometry >= 0 && profileGate > mainGeometry
      && diagnosticCall > profileGate && routeClassifier > diagnosticCall
      && legacyElse > routeClassifier && unchangedGenericRejection > legacyElse,
  "Discover diagnostics and route classifier escaped the to61-only branch");
  assert.equal((observe.match(/logFixed42To61DiscoverAmbiguityIfPresent\(/g) ?? []).length, 1,
    "Discover diagnostic must have exactly one seed-snapshot call site");
  for (const token of [
    "nodes,",
    "mainIndex,",
    "root,",
    "main.info,",
    "nodes.get(0).bounds,",
    "main.bounds,",
    "width,",
    "height,",
    "mainGeometryDiagnostic",
  ]) need(observe.slice(diagnosticCall, routeClassifier), token,
    `Discover diagnostic call lost same-graph primitive ${token}`);
  assert.equal((observe.match(/getRootInActiveWindow\(\)/g) ?? []).length, 1,
    "Discover diagnostics added another active-root query");
  assert.equal((observe.match(/clearCache\(\)/g) ?? []).length, 1,
    "Discover diagnostics added another cache refresh");

  const expectedUniqueBody = `int found = -1;
        for (int index = 0; index < nodes.size(); index++) {
            if (!nodes.get(index).semanticEquals(exact)) continue;
            assertTrue("Fixed42 semantic identity was ambiguous for " + exact, found < 0);
            found = index;
        }
        if (required) assertTrue("Fixed42 semantic identity was absent for " + exact, found >= 0);
        return found;`;
  assert.equal(unique.trim(), expectedUniqueBody,
    "generic semantic uniqueness and its ambiguity rejection changed");

  for (const token of [
    "int matchCount = 0",
    "new int[FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT]",
    "for (int index = 0; index < nodes.size(); index++)",
    'nodes.get(index).semanticEquals("Discover page")',
    "if (matchCount <= 1) return;",
    'assertTrue("Discover ambiguity diagnostic is restricted to fixed42-to61"',
    "isFixed42To61AutomaticMode()",
    "Fixed42DiscoverAmbiguityPolicy.recordCount(matchCount)",
    "existingGeometry != null",
    "captureFixed42MainGeometryDiagnostic(",
    "Fixed42DiscoverAmbiguityPolicy.correlation(",
    "nodes.size(), geometry.rootWindowId, geometry.mainWindowId",
    "Fixed42DiscoverAmbiguityPolicy.headerLine(",
    "matchCount,",
    "recordCount,",
    "correlation,",
    "geometry.primitiveLine()",
    "for (int recordIndex = 0; recordIndex < recordCount; recordIndex++)",
    "Fixed42DiscoverAmbiguityPolicy.flags(",
    "candidate.parentIndex",
    "candidate.info.getWindowId()",
    "Fixed42MainGeometryDiagnostic.rect(candidate.bounds)",
    '"Discover page".equals(candidate.text)',
    '"Discover page".equals(candidate.description)',
    "OtaFlowPolicy.PRODUCT_PACKAGE.equals(candidate.packageName)",
    '"android.view.View".equals(candidate.className)',
    '"android.widget.TextView".equals(candidate.className)',
    "candidate.visible",
    "candidate.enabled",
    "candidate.scrollable",
    "candidate.clickable",
    "candidate.info.isFocusable()",
    "candidate.info.isFocused()",
    "candidate.info.isAccessibilityFocused()",
    "candidate.info.getLiveRegion()",
    "android.view.View.ACCESSIBILITY_LIVE_REGION_NONE",
    "fixed42IsDescendant(nodes, nodeIndex, mainIndex)",
    "inMain && !candidate.scrollable",
    "Fixed42DiscoverAmbiguityPolicy.candidateLine(",
    "logFixed42To61DiscoverDiagnosticLine(",
  ]) need(diagnostic, token, `Discover ambiguity diagnostic lost ${token}`);
  assert.equal((diagnostic.match(/logFixed42To61DiscoverDiagnosticLine\(/g) ?? []).length, 2,
    "Discover ambiguity diagnostic must have one header and one per-record logging site");
  assert.equal((diagnostic.match(/\blog\(/g) ?? []).length, 0,
    "Discover ambiguity diagnostic bypassed its retention assertion");
  assert.doesNotMatch(diagnostic,
    /candidateLine\([\s\S]*?candidate\.(?:text|description|packageName|className|resourceName)\b/,
    "Discover candidate formatter received raw accessibility identity");
  assert.doesNotMatch(diagnostic,
    /candidate\.info\.(?:getText|getContentDescription|getPackageName|getClassName|getViewIdResourceName)/,
    "Discover diagnostic re-read raw accessibility identity");
  assert.doesNotMatch(diagnostic,
    /https?:|admittedTarget|credential|token|cookie|authorization/i,
    "Discover diagnostic contains URL or credential-bearing data");
  assert.doesNotMatch(`${diagnostic}\n${retention}`,
    /clearCache|getRootInActiveWindow|SystemClock|waitForIdle|\.click\(|performAction|device\.(?:click|swipe|press)/,
    "Discover diagnostic added a cache change, root query, wait, or input");

  for (const token of [
    'assertTrue("Fixed42-to61 Discover diagnostic reached the action-log limit"',
    "value.length() < 500",
    'assertEquals("Fixed42-to61 Discover diagnostic was changed by action-log retention"',
    "value, safe(value)",
    "log(value)",
  ]) need(retention, token, `Discover action-log retention proof lost ${token}`);
  const sanitize = retention.indexOf("safe(value)");
  const retainedLog = retention.indexOf("log(value)", sanitize);
  assert.ok(sanitize >= 0 && retainedLog > sanitize,
    "Discover diagnostic logged before proving exact retention");
  need(safe, "redacted.length() <= 500 ? redacted : redacted.substring(0, 500)",
    "actual action sanitizer lost its 500-character retention bound");
  need(log, "actions.add(safe(value));",
    "Discover diagnostic no longer passes through the actual action logger");

  for (const token of [
    '"tx,dx,pkg,v,tv,vis,en,scr,clk,foc,fd,af,live,main,nsm"',
    '"Fixed42-to61 semantic ambiguity header"',
    '" matches=" + matchCount',
    '" records=" + recordCount',
    '" truncated=" + (matchCount > recordCount)',
    '" nodes=" + nodeCount',
    '" correlation=" + correlation',
    '" flagMap=" + FLAG_MAP',
    'new StringBuilder(15)',
    ".append(bit(textExact))",
    ".append(bit(descriptionExact))",
    ".append(bit(productPackage))",
    ".append(bit(view))",
    ".append(bit(textView))",
    ".append(bit(visible))",
    ".append(bit(enabled))",
    ".append(bit(scrollable))",
    ".append(bit(clickable))",
    ".append(bit(focusable))",
    ".append(bit(focused))",
    ".append(bit(accessibilityFocused))",
    ".append(bit(liveRegion))",
    ".append(bit(mainAncestor))",
    ".append(bit(nonScrollMain))",
    '"Fixed42-to61 semantic ambiguity candidate"',
    '" record=" + recordIndex',
    '" index=" + nodeIndex',
    '" parent=" + parentIndex',
    '" window=" + windowId',
    '" bounds=" + bounds',
    '" flags=" + flags',
    "recordIndex >= FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT",
    "flags.length() != 15",
  ]) need(policy, token, `Discover compact retention policy lost ${token}`);
  assert.doesNotMatch(policy,
    /textValue|descriptionValue|packageValue|classValue|resourceValue|https?:|credential|token|cookie/i,
    "Discover formatter accepts raw identity or credential-bearing values");

  for (const token of [
    "root.getBoundsInWindow(rootWindowBounds)",
    "main.getBoundsInWindow(mainWindowBounds)",
    "main.getWindow()",
    "window.getDisplayId()",
    "window.getId()",
    "window.getBoundsInScreen(accessibilityWindowBounds)",
    "window.recycle()",
    "root.getWindowId()",
    "main.getWindowId()",
  ]) need(capture, token, `Discover same-graph geometry lost ${token}`);
  need(observe, "if (!transferred) fixed42RecycleNodes(owned);",
    "Discover ambiguity rejection no longer recycles the full graph");

  const drive = methodBody(java, "clickFixed42SampleThroughDiscoverRails");
  assert.equal((drive.match(/long startedAt = SystemClock\.uptimeMillis\(\)/g) ?? []).length, 1,
    "Discover diagnostics reset the original 45-second deadline");
  assert.doesNotMatch(drive,
    /catch \((?:AssertionError|RuntimeException|Exception|Throwable)\b/,
    "Discover ambiguity entered a retry path instead of the unchanged rejection");
}

function runFixed42DiscoverAmbiguityRetentionHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42DiscoverAmbiguityPolicy");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");
  const retention = methodBody(java, "logFixed42To61DiscoverDiagnosticLine");
  const harness = `
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class Fixed42DiscoverAmbiguityRetentionHarness {
    private static final int FIXED42_SEED_AX_NODE_LIMIT = 512;
    private static final int FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT = 4;
    private static final int MAX_ACTION_LINES = 260;
    private static final Pattern URL = Pattern.compile("https?://\\\\S+", Pattern.CASE_INSENSITIVE);
    private static final List<String> actions = new ArrayList<>();
    ${policy}

    private static void assertEquals(String message, Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(message + ": " + expected + " != " + actual);
        }
    }
    private static void assertTrue(String message, boolean value) {
        if (!value) throw new AssertionError(message);
    }
    private static void fail(String message) { throw new AssertionError(message); }
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
    private static String safe(String value) {
${safe}
    }
    private static void log(String value) {
${log}
    }
    private static void logFixed42To61DiscoverDiagnosticLine(String value) {
${retention}
    }

    public static void main(String[] ignored) {
        String correlation = Fixed42DiscoverAmbiguityPolicy.correlation(114, 10, 10);
        String geometry = " display=1080,1920 rootScreen=0,0,1080,1920"
                + " rootWindow=0,0,1080,1920 mainScreen=0,0,1082,1922"
                + " mainWindow=0,0,0,0 axWindow=1,0,10,0,0,1080,1920"
                + " nodeWindowIds=10,10";
        String header = Fixed42DiscoverAmbiguityPolicy.headerLine(
                2, 2, 114, correlation, geometry);
        String flags0 = Fixed42DiscoverAmbiguityPolicy.flags(
                true, false, true, true, false,
                false, true, false, false, false,
                false, false, true, true, true);
        String flags1 = Fixed42DiscoverAmbiguityPolicy.flags(
                false, true, true, true, false,
                true, true, false, false, true,
                true, true, false, true, true);
        require(flags0.equals("101100100000111"), "candidate0 flag mapping changed");
        require(flags1.equals("011101100111011"), "candidate1 flag mapping changed");
        String candidate0 = Fixed42DiscoverAmbiguityPolicy.candidateLine(
                0, correlation, 21, 14, 10, "0,0,0,0", flags0);
        String candidate1 = Fixed42DiscoverAmbiguityPolicy.candidateLine(
                1, correlation, 45, 14, 10, "0,0,1080,1920", flags1);

        logFixed42To61DiscoverDiagnosticLine(header);
        logFixed42To61DiscoverDiagnosticLine(candidate0);
        logFixed42To61DiscoverDiagnosticLine(candidate1);
        require(actions.size() == 3, "header and both candidates were not retained separately");
        require(actions.get(0).equals(header)
                        && actions.get(1).equals(candidate0)
                        && actions.get(2).equals(candidate1),
                "actual action pipeline changed a diagnostic line");
        for (String line : actions) {
            require(line.length() < 500, "diagnostic line did not stay below safe limit");
            require(safe(line).equals(line), "diagnostic line was clipped or redacted");
        }
        require(header.contains("matches=2 records=2 truncated=false nodes=114")
                        && header.contains("correlation=" + correlation)
                        && header.contains("mainScreen=0,0,1082,1922")
                        && header.contains("flagMap=tx,dx,pkg,v,tv,vis,en,scr,clk,foc,fd,af,live,main,nsm"),
                "header lost count, geometry, correlation, or public flag map");
        require(candidate0.contains("record=0 correlation=" + correlation)
                        && candidate0.contains("index=21 parent=14 window=10 bounds=0,0,0,0")
                        && candidate0.contains("flags=" + flags0),
                "candidate0 fields did not survive");
        require(candidate1.contains("record=1 correlation=" + correlation)
                        && candidate1.contains("index=45 parent=14 window=10 bounds=0,0,1080,1920")
                        && candidate1.contains("flags=" + flags1),
                "candidate1 fields did not survive");

        String predecessor = header + " " + candidate0 + " " + candidate1;
        require(predecessor.length() > 500 && safe(predecessor).length() == 500
                        && !safe(predecessor).equals(predecessor),
                "predecessor one-line clipping control did not reproduce");
        reject(() -> logFixed42To61DiscoverDiagnosticLine("https://sensitive.invalid/value"),
                "sanitizer-changing raw value reached the action log");
        reject(() -> logFixed42To61DiscoverDiagnosticLine("x".repeat(500)),
                "limit-sized diagnostic reached the action log instead of staying below it");
        require(actions.size() == 3, "rejected retention inputs changed the action log");
        reject(() -> Fixed42DiscoverAmbiguityPolicy.candidateLine(
                        4, correlation, 1, 0, 10, "0,0,1,1", flags0),
                "fifth candidate record survived");
        System.out.println("fixed42-discover-retention-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-discover-retention-"));
  const sourceFile = path.join(directory, "Fixed42DiscoverAmbiguityRetentionHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0,
      `fixed42 Discover retention javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand,
      ["-cp", directory, "Fixed42DiscoverAmbiguityRetentionHarness"],
      { encoding: "utf8" });
    assert.equal(run.status, 0,
      `fixed42 Discover retention harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-discover-retention-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runFixed42DiscoverAmbiguityPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42DiscoverAmbiguityPolicy");
  const harness = `
public final class Fixed42DiscoverAmbiguityPolicyHarness {
    private static final int FIXED42_SEED_AX_NODE_LIMIT = 512;
    private static final int FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT = 4;
    ${policy}

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void reject(int matchCount) {
        boolean rejected = false;
        try {
            Fixed42DiscoverAmbiguityPolicy.recordCount(matchCount);
        } catch (AssertionError expected) {
            rejected = true;
        }
        require(rejected, "invalid match count survived: " + matchCount);
    }

    public static void main(String[] ignored) {
        require(Fixed42DiscoverAmbiguityPolicy.recordCount(2) == 2,
                "two candidates must retain two records");
        require(Fixed42DiscoverAmbiguityPolicy.recordCount(4) == 4,
                "four candidates must retain four records");
        require(Fixed42DiscoverAmbiguityPolicy.recordCount(5) == 4,
                "five candidates must truncate to four records");
        require(Fixed42DiscoverAmbiguityPolicy.recordCount(512) == 4,
                "the traversal cap must retain only four records");
        reject(-1);
        reject(0);
        reject(1);
        reject(513);
        System.out.println("fixed42-discover-ambiguity-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-discover-diagnostic-"));
  const sourceFile = path.join(directory, "Fixed42DiscoverAmbiguityPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0,
      `fixed42 Discover diagnostic policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand,
      ["-cp", directory, "Fixed42DiscoverAmbiguityPolicyHarness"],
      { encoding: "utf8" });
    assert.equal(run.status, 0,
      `fixed42 Discover diagnostic policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-discover-ambiguity-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function fixed42SeedFailureDiagnosticContract(java) {
  const observe = methodBody(java, "observeFixed42SeedSnapshot");
  const diagnostic = methodBody(java, "logFixed42To61SeedHeadingFailure");
  const retention = methodBody(java, "retainFixed42To61SeedFailureDiagnosticLines");
  const policy = nestedClassDeclaration(java, "Fixed42SeedFailureDiagnosticPolicy");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");

  need(java,
    "private static final int FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT = 12;",
    "seed-failure diagnostics lost their twelve-record bound");
  need(java, "private static final int FIXED42_SEED_SCROLL_ACTION_LIMIT = 16;",
    "seed-failure diagnostics changed the shared action cap");
  need(java, "private static final long FIXED42_SEED_SCROLL_BOUND_MS = 45_000L;",
    "seed-failure diagnostics changed the original deadline");

  const headingLookup = observe.indexOf(
    'int headingIndex = fixed42UniqueSemantic(nodes, "Popular Movies", false);',
  );
  const match = observe.indexOf("boolean headingMatches = heading.matches(", headingLookup);
  const failureGate = observe.indexOf(
    "if (isFixed42To61AutomaticMode() && !headingMatches) {",
    match,
  );
  const diagnosticCall = observe.indexOf(
    "logFixed42To61SeedHeadingFailure(", failureGate,
  );
  const unchangedAssertion = observe.indexOf(
    'assertTrue("Fixed42 Popular Movies heading identity changed",',
    diagnosticCall,
  );
  const sectionParent = observe.indexOf(
    "popularSectionIndex = heading.parentIndex;",
    unchangedAssertion,
  );
  assert.ok(headingLookup >= 0 && match > headingLookup && failureGate > match
      && diagnosticCall > failureGate && unchangedAssertion > diagnosticCall
      && sectionParent > unchangedAssertion,
  "seed-failure diagnostics are not exact-to61-only, failure-only, and before the unchanged guard");
  need(observe.slice(match, sectionParent), "heading.matches(",
    "heading failure no longer uses the original identity predicate");
  need(observe.slice(match, sectionParent),
    'product, "android.widget.TextView", false, false);',
    "heading failure no longer uses every original identity field");
  need(observe.slice(unchangedAssertion, sectionParent), "headingMatches",
    "unchanged heading rejection no longer consumes the original predicate result");
  assert.equal((observe.match(/logFixed42To61SeedHeadingFailure\(/g) ?? []).length, 1,
    "seed-failure diagnostic must have one call site");
  for (const token of [
    "nodes,", "mainIndex,", "discoverIndex,", "headingIndex,",
    "width,", "height,", "boundsMatch",
  ]) need(observe.slice(diagnosticCall, unchangedAssertion), token,
    `seed-failure call lost cached same-graph input ${token}`);
  assert.equal((observe.match(/getRootInActiveWindow\(\)/g) ?? []).length, 1,
    "seed-failure diagnostics added another root query");
  assert.equal((observe.match(/clearCache\(\)/g) ?? []).length, 1,
    "seed-failure diagnostics added another cache refresh");

  for (const token of [
    'if (!isFixed42To61AutomaticMode()) return;',
    "new int[FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT]",
    "Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING",
    "Fixed42SeedFailureDiagnosticPolicy.ROLE_PARENT",
    "Fixed42SeedFailureDiagnosticPolicy.ROLE_ANCESTOR",
    "Fixed42SeedFailureDiagnosticPolicy.ROLE_ROUTE",
    "Fixed42SeedFailureDiagnosticPolicy.ROLE_MAIN",
    "heading.parentIndex",
    "nodes.get(cursor).parentIndex",
    "Fixed42SeedFailureDiagnosticPolicy.correlation(",
    "Fixed42SeedFailureDiagnosticPolicy.headerLine(",
    "Fixed42SeedFailureDiagnosticPolicy.flags(",
    "Fixed42SeedFailureDiagnosticPolicy.recordLine(",
    '"Popular Movies".equals(candidate.text)',
    '"Popular Movies".equals(candidate.description)',
    '"Discover page".equals(candidate.text)',
    '"Discover page".equals(candidate.description)',
    "OtaFlowPolicy.PRODUCT_PACKAGE.equals(candidate.packageName)",
    '"android.view.View".equals(candidate.className)',
    '"android.widget.TextView".equals(candidate.className)',
    "candidate.visible",
    "candidate.enabled",
    "candidate.scrollable",
    "candidate.clickable",
    "candidate.info.isFocusable()",
    "candidate.info.isFocused()",
    "candidate.info.isAccessibilityFocused()",
    "candidate.info.getLiveRegion()",
    "fixed42IsDescendant(nodes, nodeIndex, mainIndex)",
    "fixed42IsDescendant(nodes, nodeIndex, discoverIndex)",
    '"main-content".equals(candidate.resourceName)',
    "retainFixed42To61SeedFailureDiagnosticLines(lines)",
    "catch (RuntimeException | AssertionError ignored)",
  ]) need(diagnostic, token, `seed-failure diagnostic lost ${token}`);
  need(diagnostic, `        } catch (RuntimeException | AssertionError ignored) {
            // Diagnostic retention must never replace the original heading assertion.
        }`, "seed-failure diagnostic can mask the unchanged heading rejection");
  assert.doesNotMatch(diagnostic,
    /getRootInActiveWindow|clearCache|waitForIdle|SystemClock|\.click\(|performAction|device\.(?:click|swipe|press)/,
    "seed-failure diagnostics added a query, wait, clock, or input");
  assert.doesNotMatch(diagnostic,
    /lines\.add\([^\n]*(?:candidate\.(?:text|description|packageName|className|resourceName)|getText|getContentDescription|getPackageName|getClassName)/,
    "seed-failure formatter received a raw accessibility identity");

  for (const token of [
    "if (values == null",
    "actions.size() + values.size() > MAX_ACTION_LINES",
    "value == null || value.length() >= 500",
    "!value.equals(safe(value))",
    "for (String value : values) log(value);",
  ]) need(retention, token, `seed-failure retention lost ${token}`);
  assert.doesNotMatch(retention,
    /assert|fail\(|throw|getRootInActiveWindow|clearCache|waitForIdle|\.click\(|performAction/,
    "seed-failure retention can mask the original rejection or perform observation/input");
  need(safe, "redacted.length() <= 500 ? redacted : redacted.substring(0, 500)",
    "production sanitizer lost its 500-character cap");
  need(log, "actions.add(safe(value));",
    "seed-failure diagnostic no longer uses the production action logger");

  for (const token of [
    'private static final String ROLE_MAP = "0:h,1:p,2:a,3:r,4:m";',
    'private static final String FLAG_MAP =',
    '"tx,dx,pkg,v,tv,vis,en,scr,clk,foc,fd,af,live,main,route,rm";',
    "static final int ROLE_HEADING = 0;",
    "static final int ROLE_PARENT = 1;",
    "static final int ROLE_ANCESTOR = 2;",
    "static final int ROLE_ROUTE = 3;",
    "static final int ROLE_MAIN = 4;",
    '"Fixed42-to61 seed failure header"',
    '" records=" + recordCount',
    '" total=" + totalRecords',
    '" truncated=" + (totalRecords > recordCount)',
    '" correlation=" + correlation',
    '" heading=" + headingIndex',
    '" parent=" + parentIndex',
    '" route=" + routeIndex',
    '" main=" + mainIndex',
    '" display=" + displayWidth + "," + displayHeight',
    '" rootBounds=" + numericBounds(',
    '" mainBounds=" + numericBounds(',
    '" mainRawExact=" + mainRawExact',
    '" roleMap=" + ROLE_MAP',
    '" flagMap=" + FLAG_MAP',
    "new StringBuilder(16)",
    ".append(bit(textExact))",
    ".append(bit(descriptionExact))",
    ".append(bit(productPackage))",
    ".append(bit(view))",
    ".append(bit(textView))",
    ".append(bit(visible))",
    ".append(bit(enabled))",
    ".append(bit(scrollable))",
    ".append(bit(clickable))",
    ".append(bit(focusable))",
    ".append(bit(focused))",
    ".append(bit(accessibilityFocused))",
    ".append(bit(liveRegion))",
    ".append(bit(mainAncestor))",
    ".append(bit(routeAncestor))",
    ".append(bit(mainResource))",
    '"Fixed42-to61 seed failure record"',
    '" role=" + role',
    '" index=" + nodeIndex',
    '" parent=" + parentIndex',
    '" window=" + windowId',
    '" bounds=" + numericBounds(',
    '" flags=" + flags',
    "< FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT",
    "flags.length() == 16",
    "validCorrelation(correlation)",
    "validFlags(flags)",
  ]) need(policy, token, `seed-failure compact policy lost ${token}`);
  assert.doesNotMatch(policy,
    /textValue|descriptionValue|packageValue|classValue|resourceValue|https?:|credential|token|cookie|authorization/i,
    "seed-failure policy accepts raw identity or credential-bearing values");

  const phase = observe.indexOf("Fixed42SeedPolicy.phase(observation)", sectionParent);
  const geometryThrow = observe.indexOf("throw new Fixed42MainGeometryMismatch", phase);
  assert.ok(phase > sectionParent && geometryThrow > phase,
    "seed-failure logging changed the geometry mismatch type or ordering");
}

function runFixed42SeedFailureDiagnosticHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42SeedFailureDiagnosticPolicy");
  const safe = methodBody(java, "safe");
  const log = methodBody(java, "log");
  const retention = methodBody(java, "retainFixed42To61SeedFailureDiagnosticLines");
  const harness = `
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class Fixed42SeedFailureDiagnosticHarness {
    private static final int FIXED42_SEED_AX_NODE_LIMIT = 512;
    private static final int FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT = 12;
    private static final int MAX_ACTION_LINES = 260;
    private static final Pattern URL = Pattern.compile("https?://\\\\S+", Pattern.CASE_INSENSITIVE);
    private static final List<String> actions = new ArrayList<>();
    ${policy}

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static void fail(String message) { throw new AssertionError(message); }
    private static void reject(Runnable operation, String message) {
        try {
            operation.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError(message);
    }
    private static String safe(String value) {
${safe}
    }
    private static void log(String value) {
${log}
    }
    private static void retainFixed42To61SeedFailureDiagnosticLines(List<String> values) {
${retention}
    }

    public static void main(String[] ignored) {
        String correlation = Fixed42SeedFailureDiagnosticPolicy.correlation(
                113, 10, 10, 52, 24);
        String header = Fixed42SeedFailureDiagnosticPolicy.headerLine(
                5, 5, 113, correlation, 52, 40, 24, 14,
                1080, 1920, 0, 0, 1080, 1920,
                0, 0, 1082, 1922, false);
        String headingFlags = Fixed42SeedFailureDiagnosticPolicy.flags(
                true, false, true, false, true, false, true, false,
                false, false, false, false, false, true, true, false);
        String parentFlags = Fixed42SeedFailureDiagnosticPolicy.flags(
                false, false, true, true, false, false, true, false,
                false, false, false, false, false, true, true, false);
        String routeFlags = Fixed42SeedFailureDiagnosticPolicy.flags(
                true, false, true, true, false, true, true, false,
                false, true, true, false, false, true, true, false);
        String mainFlags = Fixed42SeedFailureDiagnosticPolicy.flags(
                false, false, true, true, false, true, true, true,
                false, false, false, false, false, true, false, true);
        require(headingFlags.equals("1010101000000110"), "heading flag mapping changed");
        require(parentFlags.equals("0011001000000110"), "parent flag mapping changed");
        require(routeFlags.equals("1011011001100110"), "route flag mapping changed");
        require(mainFlags.equals("0011011100000101"), "main flag mapping changed");

        List<String> lines = new ArrayList<>();
        lines.add(header);
        lines.add(Fixed42SeedFailureDiagnosticPolicy.recordLine(
                0, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING,
                52, 40, 10, 0, 1900, 1082, 1950, headingFlags));
        lines.add(Fixed42SeedFailureDiagnosticPolicy.recordLine(
                1, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_PARENT,
                40, 24, 10, 0, 1850, 1082, 2050, parentFlags));
        lines.add(Fixed42SeedFailureDiagnosticPolicy.recordLine(
                2, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_ANCESTOR,
                32, 24, 10, 0, 60, 1055, 1922, parentFlags));
        lines.add(Fixed42SeedFailureDiagnosticPolicy.recordLine(
                3, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_ROUTE,
                24, 14, 10, 0, 60, 1055, 1922, routeFlags));
        lines.add(Fixed42SeedFailureDiagnosticPolicy.recordLine(
                4, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_MAIN,
                14, 4, 10, 0, 0, 1082, 1922, mainFlags));
        retainFixed42To61SeedFailureDiagnosticLines(lines);
        require(actions.equals(lines), "formatter-to-safe-to-log pipeline changed a record");
        for (String line : actions) {
            require(line.length() < 500, "seed diagnostic reached the safe limit");
            require(safe(line).equals(line), "seed diagnostic was clipped or redacted");
            require(!line.contains("textValue")
                            && !line.contains("descriptionValue")
                            && !line.contains("packageValue")
                            && !line.contains("classValue")
                            && !line.contains("resourceValue"),
                    "seed diagnostic leaked a raw identity field");
        }
        require(header.contains("records=5 total=5 truncated=false nodes=113")
                        && header.contains("correlation=" + correlation)
                        && header.contains("heading=52 parent=40 route=24 main=14")
                        && header.contains("display=1080,1920")
                        && header.contains("rootBounds=0,0,1080,1920")
                        && header.contains("mainBounds=0,0,1082,1922")
                        && header.contains("mainRawExact=false")
                        && header.contains("roleMap=0:h,1:p,2:a,3:r,4:m")
                        && header.contains("flagMap=tx,dx,pkg,v,tv,vis,en,scr,clk,foc,fd,af,live,main,route,rm"),
                "header lost same-graph identity, geometry, maps, or counts");
        require(actions.get(1).contains("role=0 index=52 parent=40 window=10")
                        && actions.get(1).contains("bounds=0,1900,1082,1950")
                        && actions.get(1).contains("flags=" + headingFlags),
                "heading fields did not survive retention");
        require(actions.get(5).contains("role=4 index=14 parent=4 window=10")
                        && actions.get(5).contains("flags=" + mainFlags),
                "main identity fields did not survive retention");

        String extremeCorrelation = Fixed42SeedFailureDiagnosticPolicy.correlation(
                512, Integer.MIN_VALUE, Integer.MAX_VALUE,
                Integer.MIN_VALUE, Integer.MAX_VALUE);
        String extremeHeader = Fixed42SeedFailureDiagnosticPolicy.headerLine(
                12, 515, 512, extremeCorrelation, 511, 510, 509, 508,
                Integer.MAX_VALUE, Integer.MAX_VALUE,
                Integer.MIN_VALUE, Integer.MIN_VALUE,
                Integer.MAX_VALUE, Integer.MAX_VALUE,
                Integer.MIN_VALUE, Integer.MIN_VALUE,
                Integer.MAX_VALUE, Integer.MAX_VALUE, false);
        String extremeRecord = Fixed42SeedFailureDiagnosticPolicy.recordLine(
                11, extremeCorrelation, Fixed42SeedFailureDiagnosticPolicy.ROLE_ANCESTOR,
                511, -1, Integer.MIN_VALUE,
                Integer.MIN_VALUE, Integer.MIN_VALUE,
                Integer.MAX_VALUE, Integer.MAX_VALUE, headingFlags);
        retainFixed42To61SeedFailureDiagnosticLines(List.of(extremeHeader, extremeRecord));
        require(extremeHeader.length() < 500 && extremeRecord.length() < 500,
                "maximum-width numeric formatter exceeded its retention bound");
        require(actions.get(actions.size() - 2).equals(extremeHeader)
                        && actions.get(actions.size() - 1).equals(extremeRecord),
                "maximum-width numeric records changed through safe and log");

        reject(() -> Fixed42SeedFailureDiagnosticPolicy.headerLine(
                        6, 5, 113, correlation, 52, 40, 24, 14,
                        1080, 1920, 0, 0, 1080, 1920,
                        0, 0, 1082, 1922, false),
                "record count mismatch survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.headerLine(
                        13, 13, 113, correlation, 52, 40, 24, 14,
                        1080, 1920, 0, 0, 1080, 1920,
                        0, 0, 1082, 1922, false),
                "diagnostic record cap overflow survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.recordLine(
                        12, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING,
                        52, 40, 10, 0, 0, 1, 1, headingFlags),
                "thirteenth record survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.recordLine(
                        0, "113,10", Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING,
                        52, 40, 10, 0, 0, 1, 1, headingFlags),
                "malformed correlation survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.recordLine(
                        0, correlation, 9, 52, 40, 10, 0, 0, 1, 1, headingFlags),
                "unknown role survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.recordLine(
                        0, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING,
                        52, 40, 10, 0, 0, 1, 1, headingFlags.substring(1)),
                "missing flag survived");
        reject(() -> Fixed42SeedFailureDiagnosticPolicy.recordLine(
                        0, correlation, Fixed42SeedFailureDiagnosticPolicy.ROLE_HEADING,
                        52, 40, 10, 0, 0, 1, 1, "x" + headingFlags.substring(1)),
                "nonbinary flag survived");

        int retained = actions.size();
        retainFixed42To61SeedFailureDiagnosticLines(List.of("https://sensitive.invalid/value"));
        retainFixed42To61SeedFailureDiagnosticLines(List.of("x".repeat(500)));
        require(actions.size() == retained, "unsafe or clipped diagnostic reached log");
        String predecessorPacked = String.join(" ", lines);
        require(predecessorPacked.length() > 500
                        && safe(predecessorPacked).length() == 500
                        && !safe(predecessorPacked).equals(predecessorPacked),
                "predecessor packed-line clipping control did not reproduce");
        System.out.println("fixed42-seed-failure-diagnostic-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-seed-failure-diagnostic-"));
  const sourceFile = path.join(directory, "Fixed42SeedFailureDiagnosticHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0,
      `fixed42 seed-failure diagnostic javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand,
      ["-cp", directory, "Fixed42SeedFailureDiagnosticHarness"],
      { encoding: "utf8" });
    assert.equal(run.status, 0,
      `fixed42 seed-failure diagnostic harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-seed-failure-diagnostic-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runFixed42MainGeometryPolicyHarness(java) {
  const policy = nestedClassDeclaration(java, "Fixed42MainGeometryPolicy");
  const harness = `
public final class Fixed42MainGeometryPolicyHarness {
    private static final int FIXED42_TO61_MAIN_GEOMETRY_SAMPLE_LIMIT = 3;
    ${policy}

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

    private static int drive(int[][] samples, long[] finishedAt) {
        long startedAt = 1_000L;
        int mismatches = 0;
        int inputs = 0;
        int recycled = 0;
        for (int index = 0; index < samples.length; index++) {
            int[] bounds = samples[index];
            try {
                if (Fixed42MainGeometryPolicy.isExactRawBounds(
                        bounds[0], bounds[1], bounds[2], bounds[3], 1080, 1920)) {
                    require(inputs == 0, "input preceded exact geometry");
                    return recycled + 1;
                }
                mismatches++;
                if (!Fixed42MainGeometryPolicy.mayReacquire(
                        mismatches, startedAt, finishedAt[index], 45_000L)) {
                    throw new AssertionError("persistent geometry mismatch");
                }
            } finally {
                recycled++;
            }
        }
        throw new AssertionError("sequence ended without exact geometry");
    }

    public static void main(String[] ignored) {
        require(Fixed42MainGeometryPolicy.isExactRawBounds(0, 0, 1080, 1920, 1080, 1920),
                "exact raw display bounds were rejected");
        require(!Fixed42MainGeometryPolicy.isExactRawBounds(0, 0, 1082, 1922, 1080, 1920),
                "+2 raw overflow was tolerated");
        require(!Fixed42MainGeometryPolicy.isExactRawBounds(0, 0, 1082, 1920, 1080, 1920),
                "+2 raw width overflow was tolerated");
        require(!Fixed42MainGeometryPolicy.isExactRawBounds(0, 0, 1080, 1922, 1080, 1920),
                "+2 raw height overflow was tolerated");
        require(drive(
                new int[][] {{0, 0, 1082, 1922}, {0, 0, 1080, 1920}},
                new long[] {2_000L, 2_200L}) == 2,
                "+2 then exact did not recycle and reacquire without input");
        reject(() -> drive(
                new int[][] {
                        {0, 0, 1082, 1922},
                        {0, 0, 1082, 1922},
                        {0, 0, 1082, 1922}},
                new long[] {2_000L, 2_200L, 2_400L}),
                "persistent +2 geometry did not fail at the sample cap");
        require(!Fixed42MainGeometryPolicy.mayReacquire(3, 1_000L, 2_400L, 45_000L),
                "third mismatch sample admitted another reacquisition");
        require(!Fixed42MainGeometryPolicy.mayReacquire(1, 1_000L, 46_000L, 45_000L),
                "deadline equality admitted another observation");
        require(Fixed42MainGeometryPolicy.remainingMs(1_000L, 2_000L, 45_000L) == 44_000L,
                "remaining time reset from the original start");
        require(Fixed42MainGeometryPolicy.elapsedMs(2_000L, 1_000L) == -1L,
                "non-monotonic time was not rejected diagnostically");
        reject(() -> Fixed42MainGeometryPolicy.mayReacquire(0, 1_000L, 2_000L, 45_000L),
                "zero mismatch samples were admitted");
        reject(() -> Fixed42MainGeometryPolicy.mayReacquire(4, 1_000L, 2_000L, 45_000L),
                "unbounded mismatch samples were admitted");
        System.out.println("fixed42-main-geometry-policy-ok");
    }
}
`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed42-main-geometry-policy-"));
  const sourceFile = path.join(directory, "Fixed42MainGeometryPolicyHarness.java");
  fs.writeFileSync(sourceFile, harness);
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome == null ? "javac" : path.join(javaHome, "bin", "javac");
  const javaCommand = javaHome == null ? "java" : path.join(javaHome, "bin", "java");
  try {
    const compile = spawnSync(javac, [sourceFile], { encoding: "utf8" });
    assert.equal(compile.status, 0, `fixed42 main geometry policy javac failed: ${compile.stderr}`);
    const run = spawnSync(javaCommand, ["-cp", directory, "Fixed42MainGeometryPolicyHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `fixed42 main geometry policy harness failed: ${run.stderr}`);
    assert.equal(run.stdout.trim(), "fixed42-main-geometry-policy-ok");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("fixed42 launcher clears the API 34 cache before a false foreground decision", () => {
  fixed42LauncherCacheOrderingContract(source);

  const earlyForegroundRead = source.replace(
    `        assertTrue("Fixed42 launcher cache refresh requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fixed42 launcher accessibility cache refresh failed",
                instrumentation.getUiAutomation().clearCache());
        boolean launcherForeground = launcherPackage.equals(device.getCurrentPackageName());`,
    `        boolean launcherForeground = launcherPackage.equals(device.getCurrentPackageName());
        assertTrue("Fixed42 launcher cache refresh requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fixed42 launcher accessibility cache refresh failed",
                instrumentation.getUiAutomation().clearCache());`,
  );
  assert.notEqual(earlyForegroundRead, source,
    "fixed42 early-foreground mutant anchor was absent");
  assert.throws(
    () => fixed42LauncherCacheOrderingContract(earlyForegroundRead),
    "fixed42 foreground read before cache refresh survived",
  );
});

test("fixed42 launcher waits through one bounded public transition before one fresh icon click", () => {
  fixed42LauncherReadinessContract(source);
  runFixed42LauncherReadinessPolicyHarness(source);

  const structuralMutants = [
    ["profile-gate", source.replace(
      "if (isFixed42AutomaticMode()) {\n            launchFixed42ProductFromVisibleLauncher(phase);",
      "if (false) {\n            launchFixed42ProductFromVisibleLauncher(phase);",
    )],
    ["deadline-reset", source.replace(
      `Fixed42LauncherObservation fresh = observeFixed42LauncherReadiness(
                appLabel, launcherPackage);`,
      `Fixed42LauncherObservation fresh = observeFixed42LauncherReadiness(
                appLabel, launcherPackage);
        startedAt = SystemClock.uptimeMillis();`,
    )],
    ["second-drawer", source.replace(
      "drawerGestureSent = true;",
      "device.swipe(width / 2, height - 2, width / 2, height / 4, 30);\n                drawerGestureSent = true;",
    )],
    ["drawer-repeat", source.replace(
      "                    && !drawerGestureSent) {",
      "                    && true) {",
    )],
    ["second-click", source.replace(
      "freshIcon.click();",
      "freshIcon.click();\n        freshIcon.click();",
    )],
    ["current-package", source.replace(
      "device.getLauncherPackageName()",
      "device.getCurrentPackageName()",
    )],
    ["broad-icon-class", source.replace(
      'launcherPackage, "android.widget.TextView", false, true',
      'launcherPackage, "android.view.View", false, true',
    )],
    ["clipping-removed", source.replace(
      "!fixed42FullBounds(iconBounds, width, height)",
      "false",
    )],
  ];
  for (const [label, mutant] of structuralMutants) {
    assert.notEqual(mutant, source, `fixed42 launcher ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42LauncherReadinessContract(mutant),
      `fixed42 launcher ${label} mutant survived`,
    );
  }

  const policy = nestedClassDeclaration(source, "Fixed42LauncherReadinessPolicy");
  const policyMutations = [
    ["if (stale) return STALE;", "if (stale) return READY;"],
    ["if (rootCount > 1 || iconCount > 1)", "if (rootCount > 2 || iconCount > 2)"],
    [
      "if (!launcherForeground) return WAITING_FOR_LAUNCHER;",
      "if (!launcherForeground) return READY;",
    ],
    ["if (!iconExact)", "if (false)"],
    [
      "if (!iconFullyVisible) return WAITING_FOR_ICON;",
      "if (!iconFullyVisible) return READY;",
    ],
    ["now - startedAt < SHORT_WAIT_MS", "now - startedAt <= SHORT_WAIT_MS"],
  ];
  for (const [before, after] of policyMutations) {
    const mutantPolicy = policy.replace(before, after);
    assert.notEqual(mutantPolicy, policy, `fixed42 launcher policy mutant anchor was absent: ${before}`);
    const mutant = source.replace(policy, mutantPolicy);
    assert.throws(
      () => runFixed42LauncherReadinessPolicyHarness(mutant),
      `fixed42 launcher policy mutant survived: ${before}`,
    );
  }
});

test("fixed42 launcher timeout emits one failure-only primitive diagnostic", () => {
  fixed42LauncherDiagnosticsContract(source);
  runFixed42LauncherDiagnosticsHarness(source);

  const structuralMutants = [
    ["success-log", source.replace("if (ready == null) {", "if (true) {")],
    ["raw-label", source.replace(
      "log(diagnostics.timeoutLine(",
      "log(appLabel + diagnostics.timeoutLine(",
    )],
    ["extra-query", source.replace(
      "            log(diagnostics.timeoutLine(",
      "            observeFixed42LauncherReadiness(appLabel, launcherPackage);\n"
        + "            log(diagnostics.timeoutLine(",
    )],
    ["unrecorded-fresh-drawer", source.replace(
      "                diagnostics.record(beforeDrawer.state, beforeDrawer.diagnostic,",
      "                diagnostics.record(observation.state, observation.diagnostic,",
    )],
    ["icon-reason-query", source.replace(
      `                    "disconnected", 0);
        }
        Rect iconBounds = nodes.get(iconIndex).bounds;`,
      `                    "disconnected", 0);
        }
        nodes.get(iconIndex).info.getBoundsInScreen(new Rect());
        Rect iconBounds = nodes.get(iconIndex).bounds;`,
    )],
  ];
  for (const [label, mutant] of structuralMutants) {
    assert.notEqual(mutant, source, `fixed42 launcher diagnostic ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42LauncherDiagnosticsContract(mutant),
      `fixed42 launcher diagnostic ${label} mutant survived`,
    );
  }

  const executableMutants = [
    source.replace(
      "stateCounts[state]++;",
      "stateCounts[0]++;",
    ),
    source.replace(
      ".append(' ').append(lastPrimitives)",
      '.append(" reject=none")',
    ),
    source.replace(
      "lastState = state;",
      "lastState = -1;",
    ),
    source.replace(
      "if (observationMs > maxObservationMs)",
      "if (observationMs < maxObservationMs)",
    ),
  ];
  for (const mutant of executableMutants) {
    assert.notEqual(mutant, source, "fixed42 launcher diagnostic executable mutant anchor was absent");
    assert.throws(
      () => runFixed42LauncherDiagnosticsHarness(mutant),
      "fixed42 launcher diagnostic executable mutant survived",
    );
  }
});

test("fixed42-to61 fresh launcher failure retains absent and clipped observations exactly", () => {
  fixed42FreshLauncherFailureDiagnosticContract(source);
  runFixed42FreshLauncherFailureRetentionHarness(source);

  const structuralMutants = [
    ["wrong-profile", source.replace(
      `        if (isFixed42To61AutomaticMode()
                && fresh.state != Fixed42LauncherReadinessPolicy.READY) {
            logFixed42To61FreshLauncherFailure(ready, fresh);
        }`,
      `        if (isFixed42AutomaticMode()
                && fresh.state != Fixed42LauncherReadinessPolicy.READY) {
            logFixed42To61FreshLauncherFailure(ready, fresh);
        }`,
    )],
    ["success-log", source.replace(
      "&& fresh.state != Fixed42LauncherReadinessPolicy.READY",
      "&& true",
    )],
    ["retention-bypass", source.replace(
      `        assertEquals("Fixed42-to61 fresh launcher diagnostic changed under action-log retention",
                value, safe(value));`,
      `        assertEquals("Fixed42-to61 fresh launcher diagnostic changed under action-log retention",
                value, value);`,
    )],
    ["limit-boundary", source.replace(
      `        assertTrue("Fixed42-to61 fresh launcher diagnostic reached the action-log limit",
                value.length() < 500);`,
      `        assertTrue("Fixed42-to61 fresh launcher diagnostic reached the action-log limit",
                value.length() <= 500);`,
    )],
    ["extra-query", source.replace(
      "            logFixed42To61FreshLauncherFailure(ready, fresh);",
      "            observeFixed42LauncherReadiness(appLabel, launcherPackage);\n"
        + "            logFixed42To61FreshLauncherFailure(ready, fresh);",
    )],
  ];
  for (const [label, mutant] of structuralMutants) {
    assert.notEqual(mutant, source, `fresh launcher ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42FreshLauncherFailureDiagnosticContract(mutant),
      `fresh launcher ${label} mutant survived`,
    );
  }

  const executableMutants = [
    ["drop-prior-right", source.replace(
      ".append(',').append(priorRight).append(',').append(priorBottom)",
      ".append(',').append(priorBottom)",
    )],
    ["drop-fresh-diagnostic", source.replace(
      ".append(' ').append(freshDiagnostic)",
      ".append(' ')",
    )],
    ["collapse-absent-count", source.replace(
      ".append(\" icon=\").append(iconCount).append('/')",
      ".append(\" icon=\").append(1).append('/')",
    )],
    ["collapse-clipped-visibility", source.replace(
      ".append(iconExact).append('/').append(iconFullyVisible)",
      ".append(iconExact).append('/').append(true)",
    )],
  ];
  for (const [label, mutant] of executableMutants) {
    assert.notEqual(mutant, source, `fresh launcher ${label} executable anchor was absent`);
    assert.throws(
      () => runFixed42FreshLauncherFailureRetentionHarness(mutant),
      `fresh launcher ${label} executable mutant survived`,
    );
  }
});

test("fixed42-to61 classifies the exact failed Discover graph without favorable-order retry", () => {
  fixed42DiscoverRouteClassifierContract(source);
  runFixed42DiscoverRoutePolicyHarness(source);

  const policy = nestedClassDeclaration(source, "Fixed42DiscoverRoutePolicy");
  const policyMutations = [
    ["semantic", "(textExact || descriptionExact)", "true"],
    ["route-package", "&& productPackage\n                        && viewClass",
      "&& true\n                        && viewClass"],
    ["route-class", "&& viewClass\n                        && visible",
      "&& true\n                        && visible"],
    ["route-visible", "&& visible\n                        && enabled",
      "&& true\n                        && enabled"],
    ["route-enabled", "&& enabled\n                        && !scrollable",
      "&& true\n                        && !scrollable"],
    ["route-scroll", "&& !scrollable\n                        && !clickable",
      "&& true\n                        && !clickable"],
    ["route-click", "&& !clickable\n                        && inMain",
      "&& true\n                        && inMain"],
    ["route-ancestry", "&& inMain\n                        && windowId == rootWindowId;",
      "&& true\n                        && windowId == rootWindowId;"],
    ["route-window", "&& windowId == rootWindowId;",
      "&& true;"],
    ["mirror-description", "&& !descriptionExact\n                        && productPackage",
      "&& true\n                        && productPackage"],
    ["mirror-focusable", "&& !focusable\n                        && !focused",
      "&& true\n                        && !focused"],
    ["mirror-focused", "&& !focused\n                        && !accessibilityFocused",
      "&& true\n                        && !accessibilityFocused"],
    ["mirror-accessibility-focus", "&& !accessibilityFocused\n                        && !liveRegion",
      "&& true\n                        && !liveRegion"],
    ["mirror-live", "&& !liveRegion\n                        && inMain",
      "&& true\n                        && inMain"],
    ["mirror-bounds", "&& right == 0\n                        && bottom == 0",
      "&& true\n                        && bottom == 0"],
    ["mirror-parent", "&& parentIndex == route.parentIndex",
      "&& true"],
    ["mirror-window", "&& windowId == route.windowId;",
      "&& true;"],
    ["root-main-window", "rootWindowId == mainWindowId",
      "true"],
    ["mirror-count", "hiddenAnnouncements <= 1",
      "true"],
  ];
  for (const [label, before, after] of policyMutations) {
    const changedPolicy = policy.replace(before, after);
    assert.notEqual(changedPolicy, policy,
      `Discover classifier ${label} mutant anchor was absent`);
    const mutant = source.replace(policy, changedPolicy);
    assert.throws(() => runFixed42DiscoverRoutePolicyHarness(mutant),
      `Discover classifier ${label} mutant survived`);
  }

  const wrongProfile = source.replace(
    `            if (isFixed42To61AutomaticMode()) {
                logFixed42To61DiscoverAmbiguityIfPresent(`,
    `            if (isFixed42AutomaticMode()) {
                logFixed42To61DiscoverAmbiguityIfPresent(`,
  );
  assert.notEqual(wrongProfile, source, "Discover classifier profile mutant anchor was absent");
  assert.throws(() => fixed42DiscoverRouteClassifierContract(wrongProfile),
    "old fixed42 profile admitted the source-backed classifier");

  const legacyBranch = source.replace(
    'discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);',
    "discoverIndex = fixed42UniqueTo61DiscoverRoute(nodes, mainIndex);",
  );
  assert.notEqual(legacyBranch, source, "Discover old59 branch mutant anchor was absent");
  assert.throws(() => fixed42DiscoverRouteClassifierContract(legacyBranch),
    "old59 branch admitted the exact-to61 classifier");

  const addedWait = source.replace(
    `        int rootWindowId = nodes.get(0).info.getWindowId();`,
    `        SystemClock.sleep(1L);
        int rootWindowId = nodes.get(0).info.getWindowId();`,
  );
  assert.notEqual(addedWait, source, "Discover wait mutant anchor was absent");
  assert.throws(() => fixed42DiscoverRouteClassifierContract(addedWait),
    "Discover classifier admitted a new wait");

  const resetDeadline = source.replace(
    "        int mainGeometryMismatchSamples = 0;",
    `        int mainGeometryMismatchSamples = 0;
        long startedAt = SystemClock.uptimeMillis();`,
  );
  assert.notEqual(resetDeadline, source, "Discover deadline-reset mutant anchor was absent");
  assert.throws(() => fixed42DiscoverRouteClassifierContract(resetDeadline),
    "Discover classifier admitted a second deadline origin");
});

test("fixed42-to61 retains bounded ambiguity diagnostics before route classification", () => {
  fixed42DiscoverAmbiguityDiagnosticContract(source);

  const wrongProfile = source.replace(
    `            if (isFixed42To61AutomaticMode()) {
                logFixed42To61DiscoverAmbiguityIfPresent(`,
    `            if (isFixed42AutomaticMode()) {
                logFixed42To61DiscoverAmbiguityIfPresent(`,
  );
  assert.notEqual(wrongProfile, source, "Discover profile-scope mutant anchor was absent");
  assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(wrongProfile),
    "old fixed42 profile admitted the new diagnostic");

  const wrongSemantic = source.replace(
    'nodes.get(index).semanticEquals("Discover page")',
    'nodes.get(index).semanticEquals("Primary")',
  );
  assert.notEqual(wrongSemantic, source, "Discover semantic-scope mutant anchor was absent");
  assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(wrongSemantic),
    "a non-Discover semantic admitted the diagnostic");

  const weakenedRejection = source.replace(
    'assertTrue("Fixed42 semantic identity was ambiguous for " + exact, found < 0);',
    'assertTrue("Fixed42 semantic identity was ambiguous for " + exact, found <= 0);',
  );
  assert.notEqual(weakenedRejection, source, "uniqueness-rejection mutant anchor was absent");
  assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(weakenedRejection),
    "generic semantic uniqueness changed under the to61 classifier");
});

test("fixed42-to61 Discover diagnostic keeps full counts and at most four records", () => {
  fixed42DiscoverAmbiguityDiagnosticContract(source);
  runFixed42DiscoverAmbiguityPolicyHarness(source);
  const policy = nestedClassDeclaration(source, "Fixed42DiscoverAmbiguityPolicy");
  const mutations = [
    [
      "return Math.min(matchCount, FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT);",
      "return matchCount;",
    ],
    ["matchCount < 2", "matchCount < 1"],
    ["matchCount > FIXED42_SEED_AX_NODE_LIMIT", "false"],
  ];
  for (const [before, after] of mutations) {
    const changedPolicy = policy.replace(before, after);
    assert.notEqual(changedPolicy, policy, `Discover policy mutant anchor was absent: ${before}`);
    const mutant = source.replace(policy, changedPolicy);
    assert.throws(() => runFixed42DiscoverAmbiguityPolicyHarness(mutant),
      `Discover bounded-record policy mutant survived: ${before}`);
  }

  const raisedRecordLimit = source.replace(
    "private static final int FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT = 4;",
    "private static final int FIXED42_TO61_DISCOVER_DIAGNOSTIC_RECORD_LIMIT = 5;",
  );
  assert.notEqual(raisedRecordLimit, source, "Discover record-limit mutant anchor was absent");
  assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(raisedRecordLimit),
    "Discover diagnostic admitted more than four candidate records");
});

test("fixed42-to61 Discover records survive the actual 500-character action pipeline", () => {
  fixed42DiscoverAmbiguityDiagnosticContract(source);
  runFixed42DiscoverAmbiguityRetentionHarness(source);
  const policy = nestedClassDeclaration(source, "Fixed42DiscoverAmbiguityPolicy");

  const overlongPolicy = policy.replace(
    '+ " flags=" + flags;',
    `+ " flags=" + flags + "${"x".repeat(400)}";`,
  );
  assert.notEqual(overlongPolicy, policy, "overlong formatter mutant anchor was absent");
  assert.throws(
    () => runFixed42DiscoverAmbiguityRetentionHarness(source.replace(policy, overlongPolicy)),
    "overlong formatter survived the actual action adapter",
  );

  const droppedFlagPolicy = policy.replace(".append(bit(liveRegion))", "");
  assert.notEqual(droppedFlagPolicy, policy, "dropped-flag mutant anchor was absent");
  assert.throws(
    () => runFixed42DiscoverAmbiguityRetentionHarness(source.replace(policy, droppedFlagPolicy)),
    "formatter that dropped one boolean field survived",
  );

  const missingCorrelationPolicy = policy.replace(
    '+ " correlation=" + correlation\n                    + " index=" + nodeIndex',
    '+ " index=" + nodeIndex',
  );
  assert.notEqual(missingCorrelationPolicy, policy,
    "candidate-correlation mutant anchor was absent");
  assert.throws(
    () => runFixed42DiscoverAmbiguityRetentionHarness(
      source.replace(policy, missingCorrelationPolicy),
    ),
    "candidate without same-observation correlation survived",
  );

  const bypassedRetention = source.replace(
    "                value, safe(value));",
    "                value, value);",
  );
  assert.notEqual(bypassedRetention, source, "retention-bypass mutant anchor was absent");
  assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(bypassedRetention),
    "action logger no longer asserted exact retention");
});

test("fixed42-to61 Discover diagnostic is sanitized observation-only and recycles the graph", () => {
  fixed42DiscoverAmbiguityDiagnosticContract(source);
  const diagnosticBody = methodBody(source, "logFixed42To61DiscoverAmbiguityIfPresent");

  const mutants = [
    ["raw-text", source.replace(
      "Fixed42MainGeometryDiagnostic.rect(candidate.bounds),",
      "candidate.text,",
    )],
    ["new-root", source.replace(
      "        int matchCount = 0;",
      "        instrumentation.getUiAutomation().getRootInActiveWindow();\n        int matchCount = 0;",
    )],
    ["input", source.replace(
      "        log(value);",
      "        device.click(1, 1);\n        log(value);",
    )],
    ["node-recycle", source.replace(
      "if (!transferred) fixed42RecycleNodes(owned);",
      "if (!transferred) owned.clear();",
    )],
    ["window-recycle", source.replace(
      "                window.recycle();",
      "                accessibilityWindowPresent = 1;",
    )],
    ["geometry", source.replace(
      "geometry.primitiveLine()));",
      '""));',
    )],
    ["focus", source.replace(diagnosticBody, diagnosticBody.replace(
      "candidate.info.isFocused(),", "false,",
    ))],
    ["ancestry", source.replace(
      "boolean inMain = fixed42IsDescendant(nodes, nodeIndex, mainIndex);",
      "boolean inMain = true;",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `Discover observation mutant anchor was absent: ${label}`);
    assert.throws(() => fixed42DiscoverAmbiguityDiagnosticContract(mutant),
      `Discover observation mutant survived: ${label}`);
  }
});

test("fixed42-to61 heading failure retains only the cached same-graph seed identities", () => {
  fixed42SeedFailureDiagnosticContract(source);

  const mutants = [
    ["profile", source.replace(
      "if (isFixed42To61AutomaticMode() && !headingMatches) {",
      "if (isFixed42AutomaticMode() && !headingMatches) {",
    )],
    ["success-log", source.replace(
      "if (isFixed42To61AutomaticMode() && !headingMatches) {",
      "if (isFixed42To61AutomaticMode()) {",
    )],
    ["removed-call", source.replace(
      "                    logFixed42To61SeedHeadingFailure(",
      "                    retainFixed42To61SeedFailureDiagnosticLines(",
    )],
    ["new-root", source.replace(
      "        if (!isFixed42To61AutomaticMode()) return;",
      "        instrumentation.getUiAutomation().getRootInActiveWindow();\n"
        + "        if (!isFixed42To61AutomaticMode()) return;",
    )],
    ["input", source.replace(
      "            retainFixed42To61SeedFailureDiagnosticLines(lines);",
      "            device.click(1, 1);\n            retainFixed42To61SeedFailureDiagnosticLines(lines);",
    )],
    ["mask-original", source.replace(
      "        } catch (RuntimeException | AssertionError ignored) {",
      "        } catch (RuntimeException | AssertionError ignored) { throw ignored;",
    )],
    ["direct-log", source.replace(
      "            retainFixed42To61SeedFailureDiagnosticLines(lines);",
      "            for (String value : lines) log(value);",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `seed-failure ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42SeedFailureDiagnosticContract(mutant),
      `seed-failure ${label} mutant survived`,
    );
  }
});

test("fixed42-to61 seed failure formatter preserves all fields through safe and log", () => {
  fixed42SeedFailureDiagnosticContract(source);
  runFixed42SeedFailureDiagnosticHarness(source);
  const policy = nestedClassDeclaration(source, "Fixed42SeedFailureDiagnosticPolicy");

  const mutants = [
    ["record-cap", source.replace(
      "private static final int FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT = 12;",
      "private static final int FIXED42_TO61_SEED_FAILURE_DIAGNOSTIC_RECORD_LIMIT = 13;",
    )],
    ["missing-visible", source.replace(policy, policy.replace(
      ".append(bit(visible))",
      "",
    ))],
    ["missing-correlation", source.replace(policy, policy.replace(
      '+ " correlation=" + correlation\n                    + " heading=" + headingIndex',
      '+ " heading=" + headingIndex',
    ))],
    ["malformed-admitted", source.replace(policy, policy.replaceAll(
      "&& validCorrelation(correlation)",
      "&& true",
    ))],
    ["raw-identity", source.replace(policy, policy.replace(
      '+ " flags=" + flags;',
      '+ " flags=" + flags + " classValue";',
    ))],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `seed-failure formatter ${label} mutant anchor was absent`);
    assert.throws(
      () => label === "record-cap"
        ? fixed42SeedFailureDiagnosticContract(mutant)
        : runFixed42SeedFailureDiagnosticHarness(mutant),
      `seed-failure formatter ${label} mutant survived`,
    );
  }

  const overlongPolicy = policy.replace(
    '+ " flags=" + flags;',
    `+ " flags=" + flags + "${"x".repeat(400)}";`,
  );
  assert.notEqual(overlongPolicy, policy, "seed-failure overlong formatter anchor was absent");
  assert.throws(
    () => runFixed42SeedFailureDiagnosticHarness(source.replace(policy, overlongPolicy)),
    "overlong seed-failure record survived the actual action pipeline",
  );
});

test("fixed42-to61 geometry-only mismatch reacquires raw exact bounds without input", () => {
  fixed42MainProofDiagnosticContract(source);
  fixed42MainGeometryReacquisitionContract(source);

  const mutants = [
    ["identity-retry", source.replace(
      `assertTrue("Fixed42-to61 main-content identity changed",
                        mainIdentityMatches);`,
      `assertTrue("Fixed42-to61 main-content identity changed",
                        true);`,
    )],
    ["old59-retry", source.replace(
      "if (!isFixed42To61AutomaticMode()) {",
      "if (false) {",
    )],
    ["action-on-mismatch", source.replace(
      "                mainGeometryMismatchSamples++;",
      "                completedActions++;\n                mainGeometryMismatchSamples++;",
    )],
    ["clipped-eligibility", source.replace(
      "boolean boundsMatch = main.bounds.equals(expectedMainBounds);",
      "boolean boundsMatch = main.getVisibleBounds().equals(expectedMainBounds);",
    )],
    ["clamped-eligibility", source.replace(
      "boolean boundsMatch = main.bounds.equals(expectedMainBounds);",
      `boolean boundsMatch = main.bounds.left == 0 && main.bounds.top == 0
                    && Math.min(main.bounds.right, width) == width
                    && Math.min(main.bounds.bottom, height) == height;`,
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `fixed42 geometry ${label} mutant anchor was absent`);
    assert.throws(
      () => fixed42MainGeometryReacquisitionContract(mutant),
      `fixed42 geometry ${label} mutant survived`,
    );
  }
});

test("fixed42-to61 raw geometry policy executes transient persistent and deadline cases", () => {
  runFixed42MainGeometryPolicyHarness(source);
  const geometryPolicy = nestedClassDeclaration(source, "Fixed42MainGeometryPolicy");
  const mutateGeometryPolicy = (from, to) => {
    const changedPolicy = geometryPolicy.replace(from, to);
    assert.notEqual(changedPolicy, geometryPolicy, "fixed42 geometry policy mutant anchor was absent");
    return source.replace(geometryPolicy, changedPolicy);
  };

  const mutants = [
    ["two-pixel-tolerance", mutateGeometryPolicy(
      `&& right == displayWidth
                    && bottom == displayHeight`,
      `&& right <= displayWidth + 2
                    && bottom == displayHeight`,
    )],
    ["two-pixel-height-tolerance", mutateGeometryPolicy(
      "&& bottom == displayHeight",
      "&& bottom <= displayHeight + 2",
    )],
    ["sample-cap", mutateGeometryPolicy(
      "mismatchSamples < FIXED42_TO61_MAIN_GEOMETRY_SAMPLE_LIMIT",
      "mismatchSamples <= FIXED42_TO61_MAIN_GEOMETRY_SAMPLE_LIMIT",
    )],
    ["deadline-equality", mutateGeometryPolicy(
      "now - startedAt < boundMs",
      "now - startedAt <= boundMs",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `fixed42 geometry policy ${label} anchor was absent`);
    assert.throws(
      () => runFixed42MainGeometryPolicyHarness(mutant),
      `fixed42 geometry policy ${label} mutant survived`,
    );
  }
});

test("fixed42-to61 geometry retries retain full guards recycling and numeric diagnostics", () => {
  fixed42MainGeometryReacquisitionContract(source);

  const mutants = [
    ["recycle", source.replace(
      "if (!transferred) fixed42RecycleNodes(owned);",
      "if (!transferred) owned.clear();",
    )],
    ["early-retry", source.replace(
      `            Fixed42SeedPolicy.phase(observation);
            if (mainGeometryDiagnostic != null) {`,
      `            if (mainGeometryDiagnostic != null) {
                throw new Fixed42MainGeometryMismatch(mainGeometryDiagnostic);
            }
            Fixed42SeedPolicy.phase(observation);
            if (false) {`,
    )],
    ["terms", source.replace(
      "            assertNoBindingTerms();\n            Fixed42ReadyProof ready = null;",
      "            Fixed42ReadyProof ready = null;",
    )],
    ["null-child", source.replace(
      'assertNotNull("Fixed42 seed snapshot returned a null child", child);',
      "if (child == null) continue;",
    )],
    ["child-cap", source.replace(
      "childCount >= 0 && childCount <= FIXED42_SEED_AX_CHILD_LIMIT",
      "childCount >= 0",
    )],
    ["node-cap", source.replace(
      "owned.size() < FIXED42_SEED_AX_NODE_LIMIT",
      "true",
    )],
    ["main-ambiguity", source.replace(
      'int mainIndex = fixed42UniqueResource(nodes, "main-content");',
      "int mainIndex = 0;",
    )],
    ["deadline-reset", source.replace(
      `                                mainGeometryMismatchSamples,
                                startedAt,
                                observedAt,`,
      `                                mainGeometryMismatchSamples,
                                observedAt,
                                observedAt,`,
    )],
    ["visible-bounds", source.replace(
      "main.getBoundsInWindow(mainWindowBounds);",
      "main.getBoundsInWindow(mainWindowBounds);\n        main.getVisibleBounds();",
    )],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, source, `fixed42 geometry guard ${label} anchor was absent`);
    assert.throws(
      () => fixed42MainGeometryReacquisitionContract(mutant),
      `fixed42 geometry guard ${label} mutant survived`,
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

test("fixed42-to61 is an exact separate pin and receipt profile", () => {
  for (const token of [
    '"public-fixed42-to61-initial-cancel-due-resume-v1"',
    '"fixed42-to61-automatic-public-ota-flow"',
    'private static final String FIXED42_TO61_TARGET_VERSION = "2.3.61";',
    "private static final long FIXED42_TO61_TARGET_VERSION_CODE = 2_003_061L;",
    '"a4696ab0533cdc99e3f5e373031d89e58a6cd8f6742a9107085220765bb5b247"',
    "private static final long FIXED42_TO61_TARGET_SIZE = 88_640_385L;",
    '"e2dee689276610ffb1685a6f47ac37f183f35a7e"',
    '"8828c76dd0696c7b70d548fcfdbb4657076825c5b40e5fa81b2ce1dd23be9815"',
    '"25afa6bca5261b02a0372eb0fc88934573ae2bce0091bd526007f963fe5b26b2"',
    "private static final long FIXED42_TO61_TARGET_BUILD_RUN = 40_238_512_551L;",
    '"Fixed42OTA61Marker"',
  ]) need(source, token, `fixed42-to61 Java pin lost ${token}`);
  const admission = methodBody(source, "admitAutomaticTargetIdentity");
  need(admission, "boolean fixed42To61 = isFixed42To61AutomaticMode()",
    "fixed42-to61 admission is not explicitly selected");
  need(admission, "if (fixed42To61)", "fixed42-to61 target pins are not a distinct branch");
  const receipt = methodBody(source, "writeReceipt");
  need(receipt, 'receipt.put("postInstallExactUpToDate61Observed"',
    "fixed42-to61 exact up-to-date observation is absent");
  need(receipt, 'receipt.put("postInstallExactUpToDate59Observed"',
    "fixed42-to59 receipt compatibility was removed");

  const mixedProfile = source.replace(
    "boolean fixed42To61 = isFixed42To61AutomaticMode();",
    "boolean fixed42To61 = isFixed42To59AutomaticMode();",
  );
  assert.notEqual(mixedProfile, source, "mixed-profile mutant anchor was absent");
  assert.throws(() => {
    const changedAdmission = methodBody(mixedProfile, "admitAutomaticTargetIdentity");
    need(changedAdmission, "boolean fixed42To61 = isFixed42To61AutomaticMode()",
      "mixed fixed42 target pin dispatch survived");
  });
});

test("fixed42-to61 resolves one safe launcher before its sole Home and hashes failure diagnostics", () => {
  fixed42To61LauncherContract(source);
  runFixed42LauncherPackagePolicyHarness(source);
  const diagnostic = methodBody(source, "fixed42LauncherPackageDiagnostic");
  for (const token of [
    'append(" expectedNexus=")',
    'append(" currentNexus=")',
    'append(" expectedAndroid=")',
    'append(" currentAndroid=")',
    'append(" expectedProduct=")',
    'append(" currentProduct=")',
    'append(" expectedHarness=")',
    'append(" currentHarness=")',
    'append(" expectedSha256=")',
    'append(" currentSha256=")',
  ]) need(diagnostic, token, `launcher package diagnostic lost ${token}`);
  for (const forbidden of ["launcherPackage=", "currentPackage=", "packageName="]) {
    assert.equal(diagnostic.includes(forbidden), false,
      `launcher diagnostic leaked a raw package through ${forbidden}`);
  }

  const equalityBypass = source.replace(
    '"android".equals(launcherPackage)',
    "false",
  );
  assert.notEqual(equalityBypass, source, "launcher equality-bypass mutant anchor was absent");
  assert.throws(() => runFixed42LauncherPackagePolicyHarness(equalityBypass),
    "launcher equality bypass survived the executable policy control");

  const earlyHome = source.replace(
    `        if (isFixed42To61AutomaticMode()) {
            assertFixed42ExpectedLauncherPackage(launcherPackage);
        } else {`,
    `        device.pressHome();
        if (isFixed42To61AutomaticMode()) {
            assertFixed42ExpectedLauncherPackage(launcherPackage);
        } else {`,
  );
  assert.notEqual(earlyHome, source, "early-Home mutant anchor was absent");
  assert.throws(() => fixed42To61LauncherContract(earlyHome),
    "Home input before launcher package proof survived");
});

test("instrumentation app alone declares one exact public MAIN HOME visibility query", () => {
  assert.equal(exactMainHomeIntent(appManifest), 1,
    "instrumentation app must declare one exact MAIN HOME query");
  const missing = appManifest.replace(
    '<category android:name="android.intent.category.HOME" />',
    '<category android:name="android.intent.category.DEFAULT" />',
  );
  assert.equal(exactMainHomeIntent(missing), 0,
    "wrong launcher-query category mutant was admitted");
  const duplicate = appManifest.replace("</queries>", `${appManifest.match(/<intent>[\s\S]*?<\/intent>/)[0]}\n    </queries>`);
  assert.equal(exactMainHomeIntent(duplicate), 2,
    "duplicate launcher-query mutant was not observable");
  const queryOnlyInTestManifest = appManifest.replace(/\s*<intent>[\s\S]*?<\/intent>/, "");
  assert.equal(exactMainHomeIntent(queryOnlyInTestManifest), 0,
    "query-only-test-manifest mutant left the app query intact");
  assert.equal(exactMainHomeIntent(appManifest), 1,
    "query-only-test-manifest control must keep the query in the app manifest");
});
