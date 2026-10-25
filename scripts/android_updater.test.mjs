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

function sourceSection(subject, start, end) {
  const from = subject.indexOf(start);
  const to = subject.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return subject.slice(from, to);
}

function permissionReturnFailures(subject) {
  const failures = [];
  const readinessRunner = sourceSection(subject, "private val resumeReadiness", "private val pollDownload");
  const onResume = sourceSection(subject, "fun onResume()", "/** Forward Activity.onPause()");
  const teardown = sourceSection(
    subject,
    "private fun dismissRetainedPermissionDialogOnResume()",
    "private fun handleForegroundReadiness()",
  );
  const foreground = sourceSection(
    subject,
    "private fun handleForegroundReadiness()",
    "private fun resumePersistedUpdate",
  );
  const permission = sourceSection(
    subject,
    "private fun resumePermissionFlow()",
    "private fun showPermissionDialog",
  );
  const guidance = sourceSection(subject, "private fun showPermissionDialog", "private fun launchInstaller");

  const stopped = readinessRunner.indexOf("if (destroyed || !foreground) return");
  const teardownCall = readinessRunner.indexOf("dismissRetainedPermissionDialogOnResume()");
  const activityReady = readinessRunner.indexOf("if (activityReady()) {");
  if (!(stopped >= 0 && stopped < teardownCall && teardownCall < activityReady)) {
    failures.push("owned retained dialog teardown is not before the outer activityReady focus gate");
  }
  if (!/permissionResumeTeardownPending\s*=\s*\n\s*preferences\.getBoolean\(KEY_AWAITING_INSTALL_PERMISSION, false\)/.test(onResume)) {
    failures.push("permission return teardown is not armed on the resume edge");
  }
  const teardownRequirements = [
    "!permissionResumeTeardownPending",
    "destroyed",
    "!foreground",
    "activity.isFinishing",
    "activity.isDestroyed",
    "activity.window?.decorView?.isAttachedToWindow != true",
    "operation != null",
    "!preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)",
    "dialog == null",
    "dialogState != DialogState.READY_TO_INSTALL && dialogState != DialogState.AWAITING_PERMISSION",
  ];
  for (const requirement of teardownRequirements) {
    if (!teardown.includes(requirement)) failures.push(`retained dialog teardown lacks guard: ${requirement}`);
  }
  const consume = teardown.indexOf("permissionResumeTeardownPending = false");
  const dismiss = teardown.indexOf("dismissDialog()");
  if (!(consume >= 0 && consume < dismiss)) {
    failures.push("resume-edge teardown is not consumed before dismissing the owned dialog");
  }

  const ready = foreground.indexOf("if (!activityReady()) return");
  const operation = foreground.indexOf("if (operation != null) {");
  const awaiting = foreground.indexOf(
    "if (preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)) {",
  );
  const genericDialog = foreground.indexOf("if (dialog != null) return");
  if (!(ready >= 0 && ready < operation && operation < awaiting && awaiting < genericDialog)) {
    failures.push("foreground permission recovery and generic dialog guards are misordered");
  }
  const awaitingBranch = foreground.slice(awaiting, genericDialog);
  if (!/dialogState == DialogState\.AWAITING_PERMISSION[\s\S]*!activity\.packageManager\.canRequestPackageInstalls\(\)[\s\S]*return/.test(awaitingBranch)) {
    failures.push("newly rendered denied-permission guidance is not retained");
  }
  if (!/permissionResumeTeardownPending = false[\s\S]*if \(dialog != null\) dismissDialog\(\)[\s\S]*resumePermissionFlow\(\)/.test(awaitingBranch)) {
    failures.push("ready permission recovery does not consume, dismiss, and resume in order");
  }
  if (!/else \{\s*showPermissionDialog\(candidate, settingsAlreadyOpened = true\)\s*\}/.test(permission)) {
    failures.push("denied permission no longer renders native guidance");
  }
  if (!/putBoolean\(KEY_AWAITING_INSTALL_PERMISSION, false\)[\s\S]*deferPhaseUntilNextForeground\(\)[\s\S]*dismissDialog\(\)/.test(guidance)) {
    failures.push("Later no longer clears awaiting permission and defers the staged update");
  }
  return failures;
}

function manualConsentFocusFailures(subject) {
  const failures = [];
  const fields = sourceSection(subject, "private var destroyed", "private val resumeReadiness");
  const onResume = sourceSection(subject, "fun onResume()", "/** Forward Activity.onPause()");
  const onPause = sourceSection(subject, "fun onPause()", "/** Forward Activity.onWindowFocusChanged()");
  const check = sourceSection(subject, "fun checkManually()", "private fun scheduleReadiness");
  const foreground = sourceSection(subject, "private fun handleForegroundReadiness()", "private fun resumePersistedUpdate");
  const request = sourceSection(subject, "private fun requestManualCheckAfterConsent()", "/** Forward Activity.onDestroy()");
  const destroy = sourceSection(subject, "fun onDestroy()", "private fun startCheck");
  const start = sourceSection(subject, "private fun startCheck", "private fun showInitialConsentDialog");
  const initialConsent = sourceSection(subject, "private fun showInitialConsentDialog", "private fun showManualConsentDialog");
  const manualConsent = sourceSection(subject, "private fun showManualConsentDialog", "private fun discoverCandidate");
  const progress = sourceSection(subject, "private fun showProgressDialog", "private fun showUpdaterDialog");
  const dialog = sourceSection(subject, "private fun showUpdaterDialog", "private fun automaticChecksView");
  const submit = sourceSection(subject, "private fun <T> submit", "private fun cancelOperation");
  const cancel = sourceSection(subject, "private fun cancelOperation()", "private fun cancelOperationAndDismiss");
  const cancelAndDismiss = sourceSection(subject, "private fun cancelOperationAndDismiss()", "private fun dismissDialog");
  const pendingFailure = subject.includes("private fun holdPendingManualUntilNextReadinessEdge()")
    ? sourceSection(subject, "private fun holdPendingManualUntilNextReadinessEdge()", "private fun activityReady")
    : "";

  if (!fields.includes("private var manualCheckPending = false")) {
    failures.push("manual check pending owner state is missing");
  }
  if (!/!preferences\.getBoolean\(KEY_AWAITING_INSTALL_PERMISSION, false\) &&\s*!manualCheckPending &&\s*automaticChecksEnabled\(\)/.test(onResume)) {
    failures.push("automatic discovery can overtake an explicit pending manual check");
  }
  if (!/manualCheckPending = true[\s\S]*?if \(!activityReady\(\)\) \{[\s\S]*?scheduleReadiness\(resetAttempts = true\)[\s\S]*?return@runOnMain[\s\S]*?requestManualCheckAfterConsent\(\)/.test(check)) {
    failures.push("manual requests are not owned and readiness-queued before any work");
  }
  if (!/if \(operation != null\) \{[\s\S]*?manualCheckPending && operation == Operation\.CHECK_AUTOMATIC[\s\S]*?cancelOperation\(\)[\s\S]*?else \{\s*return\s*\}/.test(foreground)) {
    failures.push("pending manual work does not cancel only automatic discovery or wait for other work");
  }
  const dialogGuard = foreground.indexOf("if (dialog != null) return");
  const pendingDrain = foreground.indexOf("if (manualCheckPending) {");
  if (!(dialogGuard >= 0 && pendingDrain > dialogGuard && foreground.indexOf("requestManualCheckAfterConsent()", pendingDrain) > pendingDrain)) {
    failures.push("pending manual work can replace an owned dialog or is not drained through readiness");
  }
  const requestRequirements = [
    "if (!manualCheckPending) return",
    "if (!activityReady()) {",
    "scheduleReadiness(resetAttempts = true)",
    "if (showManualConsentDialog()) manualCheckPending = false",
    "manualCheckPending = false",
    "if (operation == Operation.CHECK_AUTOMATIC) cancelOperation()",
    "if (operation != null)",
    "startCheck(manual = true)",
  ];
  for (const requirement of requestRequirements) {
    if (!request.includes(requirement)) failures.push(`manual pending drain lacks: ${requirement}`);
  }
  const requestReadyReturn = request.indexOf("return\n    }", request.indexOf("if (!activityReady()) {"));
  const requestDialogGuard = request.indexOf("if (dialog != null) return");
  const requestConsent = request.indexOf("if (!hasNetworkConsent()) {");
  if (!(requestReadyReturn >= 0 && requestDialogGuard > requestReadyReturn && requestConsent > requestDialogGuard)) {
    failures.push("ready manual fast path can replace an owned dialog before its focus handoff");
  }
  if (!/val progressPresented = showProgressDialog\([\s\S]*?DialogState\.CHECKING[\s\S]*?cancelLabel = "Cancel"[\s\S]*?if \(!progressPresented\) \{[\s\S]*?holdPendingManualUntilNextReadinessEdge\(\)[\s\S]*?return[\s\S]*?manualCheckPending = false[\s\S]*?submit\(/.test(start)) {
    failures.push("manual worker can start before a visible CHECKING dialog with Cancel");
  }
  for (const [label, consent] of [["initial", initialConsent], ["manual", manualConsent]]) {
    if (/startCheck\s*\(/.test(consent)) failures.push(`${label} consent callback starts work before dismissal`);
    if (!/putInt\(KEY_NETWORK_CONSENT, CONSENT_GRANTED\)[\s\S]*?manualCheckPending = true[\s\S]*?dismissDialog\(\)[\s\S]*?scheduleReadiness\(resetAttempts = true\)/.test(consent)) {
      failures.push(`${label} consent does not persist, queue, dismiss, and schedule in order`);
    }
    if (!/putInt\(KEY_NETWORK_CONSENT, CONSENT_DECLINED\)[\s\S]*?manualCheckPending = false[\s\S]*?dismissDialog\(\)/.test(consent)) {
      failures.push(`${label} consent cancellation does not invalidate pending work`);
    }
  }
  if (!/private fun showProgressDialog\([\s\S]*?\): Boolean =\s*showUpdaterDialog\(/.test(progress)) {
    failures.push("progress presentation does not report success");
  }
  if (!/\): Boolean \{[\s\S]*?if \(!activityReady\(\)\) return false[\s\S]*?created\.show\(\)[\s\S]*?val presented = dialog === created && dialogState == state && created\.isShowing[\s\S]*?if \(!presented\) holdPendingManualUntilNextReadinessEdge\(\)[\s\S]*?catch \(_:\s*Exception\)[\s\S]*?holdPendingManualUntilNextReadinessEdge\(\)[\s\S]*?return false/.test(dialog)) {
    failures.push("dialog presentation success is not focus-, attachment-, and isShowing-gated");
  }
  if (!/if \(manualCheckPending\) main\.removeCallbacks\(resumeReadiness\)/.test(pendingFailure)) {
    failures.push("failed manual presentation does not remove its already queued readiness callback");
  }
  if (!onPause.includes("main.removeCallbacks(resumeReadiness)")) {
    failures.push("background transition retains readiness callbacks");
  }
  if (!destroy.includes("manualCheckPending = false") || !destroy.includes("main.removeCallbacksAndMessages(null)")) {
    failures.push("destroy does not invalidate pending manual readiness");
  }
  if (!/if \(destroyed \|\| serial != operationSerial\) return@post/.test(submit)
      || !/operationSerial \+= 1[\s\S]*?operationFuture\?\.cancel\(true\)/.test(cancel)) {
    failures.push("Cancel no longer invalidates delayed worker completion");
  }
  if (!/manualCheckPending = false[\s\S]*?cancelOperation\(\)[\s\S]*?dismissDialog\(\)/.test(cancelAndDismiss)) {
    failures.push("explicit Cancel does not invalidate a manual intent queued behind the owned dialog");
  }
  return failures;
}

function pendingInstallerLifecycleFailures(subject) {
  const failures = [];
  const fields = sourceSection(subject, "private var destroyed", "private val resumeReadiness");
  const foreground = sourceSection(
    subject,
    "private fun handleForegroundReadiness()",
    "private fun resumePersistedUpdate",
  );
  const verify = sourceSection(subject, "private fun verifyStagedForInstall", "private fun verifyStagedPackage");
  const arm = sourceSection(subject, "private fun armPendingInstallerLaunch", "private fun launchPendingVerifiedInstallerIfReady");
  const consume = sourceSection(subject, "private fun launchPendingVerifiedInstallerIfReady", "private fun pendingInstallerMayLaunch");
  const policy = sourceSection(subject, "private fun pendingInstallerMayLaunch", "private fun clearPendingInstallerLaunch");
  const pendingData = sourceSection(subject, "private data class PendingInstallerLaunch", "private data class InstalledIdentity");
  const onResume = sourceSection(subject, "fun onResume()", "/** Forward Activity.onPause()");
  const onPause = sourceSection(subject, "fun onPause()", "/** Forward Activity.onWindowFocusChanged()");
  const onDestroy = sourceSection(subject, "fun onDestroy()", "private fun startCheck");
  const cancel = sourceSection(subject, "private fun cancelOperation()", "private fun cancelOperationAndDismiss");
  const cleanup = sourceSection(subject, "private fun cleanupAfterUpgrade()", "private fun automaticCheckIsDue()");
  const persistPhase = sourceSection(subject, "private fun persistUpdatePhase", "private fun persistDownload");
  const persistDownload = sourceSection(subject, "private fun persistDownload", "private fun persistStaged");
  const persistStaged = sourceSection(subject, "private fun persistStaged", "private fun persistedUpdatePhase");
  const deferPhase = sourceSection(subject, "private fun deferPhaseUntilNextForeground", "private fun persistedDownloadId");
  const clearPersisted = sourceSection(subject, "private fun clearPersistedDownload", "private fun removePersistedDownloadManagerEntry");

  if (!fields.includes("private var pendingInstallerLaunch: PendingInstallerLaunch? = null")) {
    failures.push("transient pending installer candidate is missing");
  }
  if (!pendingData.includes("val resumeNumber: Long")) {
    failures.push("pending installer candidate is not bound to its foreground resume");
  }
  if (!onResume.includes("resumeNumber += 1")) {
    failures.push("foreground resume identity is not advanced on resume");
  }
  const capture = verify.indexOf("val verificationResumeNumber = resumeNumber");
  const submit = verify.indexOf("submit(", capture);
  const armGuard = verify.indexOf("if (foreground && resumeNumber == verificationResumeNumber) {", submit);
  const armCall = verify.indexOf(
    "armPendingInstallerLaunch(candidate, staged, verificationResumeNumber)",
    armGuard,
  );
  const dismiss = verify.indexOf("dismissDialog()", armCall);
  const schedule = verify.indexOf("scheduleReadiness(resetAttempts = true)", dismiss);
  if (!(capture >= 0 && capture < submit && submit < armGuard && armGuard < armCall && armCall < dismiss && dismiss < schedule)) {
    failures.push("verified current-resume result is not armed before dismissal and readiness scheduling");
  }
  if (subject.match(/pendingInstallerLaunch\s*=\s*PendingInstallerLaunch/g)?.length !== 1) {
    failures.push("pending installer candidate is assigned outside the single verifier-success arm path");
  }
  const pendingBeforeDialog = foreground.indexOf("if (launchPendingVerifiedInstallerIfReady()) return");
  const genericDialog = foreground.indexOf("if (dialog != null) return");
  if (!(pendingBeforeDialog >= 0 && pendingBeforeDialog < genericDialog)) {
    failures.push("verified installer launch is not resumed before the generic dialog guard");
  }

  const policyConditions = [
    "isForeground &&",
    "isActivityReady &&",
    "!hasOperation &&",
    "resumeMatches &&",
    "phase == PHASE_STAGED &&",
    "candidateMatches &&",
    "fileMatches &&",
    "fileMatches &&\n      upgradeStillValid",
  ];
  for (const condition of policyConditions) {
    if (!policy.includes(condition)) failures.push(`pending installer policy lacks: ${condition}`);
  }
  const consumeRequirements = [
    "persisted == pending.candidate",
    "canonical.path == pending.canonicalPath",
    "canonical.isFile",
    "canonical.length() == pending.length",
    "canonical.length() == pending.candidate.size",
    "canonical.lastModified() == pending.lastModified",
    "resumeMatches = pending.resumeNumber == resumeNumber",
    "candidateStillNewer(pending.candidate)",
  ];
  for (const requirement of consumeRequirements) {
    if (!consume.includes(requirement)) failures.push(`pending installer identity check lacks: ${requirement}`);
  }
  const clear = consume.indexOf("clearPendingInstallerLaunch()");
  const launch = consume.indexOf("launchInstaller(pending.candidate)");
  if (!(clear >= 0 && clear < launch)) failures.push("pending installer is not consumed before launch");
  if (consume.includes("verifyStagedForInstall(")) {
    failures.push("focus recovery re-enters verification instead of consuming its verified result");
  }
  const armRequirements = [
    "!foreground ||",
    "destroyed ||",
    "resumeNumber != verificationResumeNumber",
    "activity.isFinishing",
    "activity.isDestroyed",
    "activity.window?.decorView?.isAttachedToWindow != true",
    "verified != expected",
    "!verified.isFile",
    "verified.length() != candidate.size",
    "verified.lastModified() <= 0L",
  ];
  for (const requirement of armRequirements) {
    if (!arm.includes(requirement)) failures.push(`verifier-success arm lacks: ${requirement}`);
  }
  if (arm.includes("windowHasFocus") || arm.includes("activity.hasWindowFocus()")) {
    failures.push("verifier-success arm incorrectly requires focus instead of waiting for readiness");
  }

  const clearScopes = [
    [onPause, "pause"],
    [onDestroy, "destroy"],
    [cancel, "cancel"],
    [cleanup, "upgrade cleanup"],
    [persistPhase, "generic phase change"],
    [persistDownload, "download phase change"],
    [persistStaged, "staged phase change"],
    [deferPhase, "phase deferral"],
    [clearPersisted, "persisted download cleanup"],
  ];
  for (const [scope, label] of clearScopes) {
    if (!scope.includes("clearPendingInstallerLaunch()")) {
      failures.push(`pending installer is not cleared on ${label}`);
    }
  }
  return failures;
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

test("manual consent dismisses before focus readiness and CHECKING presentation gates worker start", () => {
  assert.deepEqual(manualConsentFocusFailures(source), []);
  const mutants = {
    "automatic discovery overtakes pending manual intent": source.replace(
      "        !manualCheckPending &&\n        automaticChecksEnabled()",
      "        automaticChecksEnabled()",
      1,
    ),
    "initial consent starts worker in framework callback": source.replace(
      `        manualCheckPending = true
        dismissDialog()
        scheduleReadiness(resetAttempts = true)`,
      "        startCheck(manual = true)",
      1,
    ),
    "progress failure still starts worker": source.replace(
      `      if (!progressPresented) {
        holdPendingManualUntilNextReadinessEdge()
        return
      }`,
      "      if (!progressPresented) return",
      1,
    ),
    "progress presentation failure spins an immediate readiness retry": source.replace(
      "        holdPendingManualUntilNextReadinessEdge()\n        return",
      "        scheduleReadiness(resetAttempts = true)\n        return",
      1,
    ),
    "dialog show result ignored": source.replace(
      "      val presented = dialog === created && dialogState == state && created.isShowing",
      "      val presented = true",
      1,
    ),
    "ready manual fast path replaces an owned dialog": source.replace(
      "    if (dialog != null) return\n    if (!hasNetworkConsent()) {",
      "    if (!hasNetworkConsent()) {",
      1,
    ),
    "background readiness callback retained": source.replace(
      "      main.removeCallbacks(resumeReadiness)\n      main.removeCallbacks(pollDownload)",
      "      main.removeCallbacks(pollDownload)",
      1,
    ),
    "destroy retains pending manual intent": source.replace(
      "      operation = null\n      manualCheckPending = false",
      "      operation = null",
      1,
    ),
    "Cancel permits delayed completion": source.replace(
      "    operationSerial += 1\n    operationFuture?.cancel(true)",
      "    operationFuture?.cancel(true)",
      1,
    ),
    "explicit Cancel restarts a manual request queued behind CHECKING": source.replace(
      `  private fun cancelOperationAndDismiss() {
    manualCheckPending = false`,
      `  private fun cancelOperationAndDismiss() {`,
      1,
    ),
    "failed presentation retains the readiness callback queued by dialog dismissal": source.replace(
      "    if (manualCheckPending) main.removeCallbacks(resumeReadiness)",
      "    if (manualCheckPending) scheduleReadiness(resetAttempts = true)",
      1,
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, source, `${name} mutation site must exist`);
    assert.notDeepEqual(manualConsentFocusFailures(mutant), [], name);
  }
});

test("permission return tears down only the owned retained dialog before the focus gate", () => {
  assert.deepEqual(permissionReturnFailures(source), []);

  const exactBase = source
    .replace("      dismissRetainedPermissionDialogOnResume()\n", "", 1)
    .replace(
      `  private fun handleForegroundReadiness() {
    if (!activityReady()) return
    if (operation != null) return
    if (preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)) {
      if (
        dialogState == DialogState.AWAITING_PERMISSION &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        return
      }
      permissionResumeTeardownPending = false
      if (dialog != null) dismissDialog()
      resumePermissionFlow()
      return
    }
    if (dialog != null) return`,
      `  private fun handleForegroundReadiness() {
    if (!activityReady() || dialog != null) return
    if (operation != null) return
    if (preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)) {
      resumePermissionFlow()
      return
    }`,
      1,
    );
  const mutants = {
    "exact focus-gated base": exactBase,
    "teardown moved behind focus gate": source.replace(
      "      dismissRetainedPermissionDialogOnResume()\n      if (activityReady()) {",
      "      if (activityReady()) {\n        dismissRetainedPermissionDialogOnResume()",
      1,
    ),
    "resume edge not armed": source.replace(
      "      permissionResumeTeardownPending =\n        preferences.getBoolean(KEY_AWAITING_INSTALL_PERMISSION, false)\n",
      "",
      1,
    ),
    "destroyed activity allowed": source.replace("      destroyed ||\n", "", 1),
    "finishing activity allowed": source.replace("      activity.isFinishing ||\n", "", 1),
    "active operation interrupted": source.replace("      operation != null ||\n", "", 1),
    "unrelated updater dialog dismissed": source.replace(
      "      (dialogState != DialogState.READY_TO_INSTALL && dialogState != DialogState.AWAITING_PERMISSION)\n",
      "      false\n",
      1,
    ),
    "resume edge not consumed": source.replace(
      "    permissionResumeTeardownPending = false\n    dismissDialog()",
      "    dismissDialog()",
      1,
    ),
    "denied guidance repeatedly dismissed": source.replace(
      `      if (
        dialogState == DialogState.AWAITING_PERMISSION &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !activity.packageManager.canRequestPackageInstalls()
      ) {
        return
      }
`,
      "",
      1,
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, source, `${name} mutation site must exist`);
    assert.notDeepEqual(permissionReturnFailures(mutant), [], name);
  }
});

test("pending verified installer policy waits for focus and rejects lifecycle or identity mismatches", () => {
  assert.deepEqual(pendingInstallerLifecycleFailures(source), []);
  const mutants = {
    "background allowed": source.replace("    isForeground &&\n", "    true &&\n", 1),
    "missing focus allowed": source.replace("      isActivityReady &&\n", "      true &&\n", 1),
    "active operation allowed": source.replace("      !hasOperation &&\n", "      true &&\n", 1),
    "prior resume allowed": source.replace("      resumeMatches &&\n", "      true &&\n", 1),
    "non-staged phase allowed": source.replace("      phase == PHASE_STAGED &&\n", "      true &&\n", 1),
    "candidate mismatch allowed": source.replace("      candidateMatches &&\n", "      true &&\n", 1),
    "file mismatch allowed": source.replace("      fileMatches &&\n", "      true &&\n", 1),
    "obsolete candidate allowed": source.replace(
      "      fileMatches &&\n      upgradeStillValid",
      "      fileMatches &&\n      true",
      1,
    ),
    "pending resume identity ignored": source.replace(
      "        resumeMatches = pending.resumeNumber == resumeNumber,\n",
      "        resumeMatches = true,\n",
      1,
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, source, `${name} mutation site must exist`);
    assert.notDeepEqual(pendingInstallerLifecycleFailures(mutant), [], name);
  }
});

test("verifier success arms only for the live foreground resume and schedules after dismissing verification", () => {
  assert.deepEqual(pendingInstallerLifecycleFailures(source), []);
  const verifiedSuccess = `      if (foreground && resumeNumber == verificationResumeNumber) {
        armPendingInstallerLaunch(candidate, staged, verificationResumeNumber)
      }
      dismissDialog()
      if (foreground) {
        scheduleReadiness(resetAttempts = true)
      }`;
  const exactBase = `      dismissDialog()
      if (activityReady()) launchInstaller(candidate)`;
  const mutants = {
    "exact single activityReady base": source.replace(verifiedSuccess, exactBase, 1),
    "resumed callback arms installer": source.replace(
      "      if (foreground && resumeNumber == verificationResumeNumber) {",
      "      if (foreground) {",
      1,
    ),
    "resume identity is not advanced": source.replace("      resumeNumber += 1\n", "      resumeNumber += 0\n", 1),
    "arm accepts mismatched resume": source.replace(
      "      resumeNumber != verificationResumeNumber ||\n",
      "",
      1,
    ),
    "finishing owner can arm": source.replace(
      `      resumeNumber != verificationResumeNumber ||
      activity.isFinishing ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed) ||`,
      `      resumeNumber != verificationResumeNumber ||
      false ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && activity.isDestroyed) ||`,
      1,
    ),
    "detached owner can arm": source.replace(
      "      activity.window?.decorView?.isAttachedToWindow != true\n",
      "      false\n",
      1,
    ),
    "readiness scheduled before verification dialog dismissal": source.replace(
      verifiedSuccess,
      `      if (foreground && resumeNumber == verificationResumeNumber) {
        armPendingInstallerLaunch(candidate, staged, verificationResumeNumber)
      }
      if (foreground) {
        scheduleReadiness(resetAttempts = true)
      }
      dismissDialog()`,
      1,
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, source, `${name} mutation site must exist`);
    assert.notDeepEqual(pendingInstallerLifecycleFailures(mutant), [], name);
  }
});

test("pending installer is one shot and cleared by pause, cancellation, cleanup, and phase changes", () => {
  assert.deepEqual(pendingInstallerLifecycleFailures(source), []);
  const mutants = {
    "launch before consume": source.replace(
      "    clearPendingInstallerLaunch()\n    if (!mayLaunch) return false\n    launchInstaller(pending.candidate)",
      "    if (!mayLaunch) return false\n    launchInstaller(pending.candidate)\n    clearPendingInstallerLaunch()",
      1,
    ),
    "pause retains armed installer": source.replace(
      "      windowHasFocus = false\n      clearPendingInstallerLaunch()",
      "      windowHasFocus = false",
      1,
    ),
    "cancel retains armed installer": source.replace(
      "  private fun cancelOperation() {\n    clearPendingInstallerLaunch()",
      "  private fun cancelOperation() {",
      1,
    ),
    "upgrade cleanup retains armed installer": source.replace(
      "  private fun cleanupAfterUpgrade() {\n    clearPendingInstallerLaunch()",
      "  private fun cleanupAfterUpgrade() {",
      1,
    ),
    "phase transition retains armed installer": source.replace(
      "  private fun persistUpdatePhase(\n    phase: Int,\n    candidate: Candidate,\n    resolvedUrlHash: String?,\n  ): Boolean {\n    clearPendingInstallerLaunch()",
      "  private fun persistUpdatePhase(\n    phase: Int,\n    candidate: Candidate,\n    resolvedUrlHash: String?,\n  ): Boolean {",
      1,
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, source, `${name} mutation site must exist`);
    assert.notDeepEqual(pendingInstallerLifecycleFailures(mutant), [], name);
  }
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
  const enqueueDownload = section("private fun enqueueDownload", "private fun reconcileDownload");
  assert.match(enqueueDownload, /DownloadManager\.Request\(Uri\.parse\(resolvedUrl\)\)/);
  assert.match(
    enqueueDownload,
    /setNotificationVisibility\(DownloadManager\.Request\.VISIBILITY_VISIBLE\)/,
  );
  assert.doesNotMatch(enqueueDownload, /VISIBILITY_VISIBLE_NOTIFY_COMPLETED/);
  assert.doesNotMatch(enqueueDownload, /VISIBILITY_VISIBLE_NOTIFY_ONLY_COMPLETION/);
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
  const onResume = section("fun onResume()", "/** Forward Activity.onPause()");
  const startCheck = section("private fun startCheck", "private fun showInitialConsentDialog");
  assert.doesNotMatch(source, /startupCheckConsidered/);
  assert.match(onResume, /persistedDownloadId\(\) == NO_DOWNLOAD_ID/);
  assert.match(onResume, /persistedUpdatePhase\(\) == PHASE_NONE/);
  assert.match(onResume, /!preferences\.getBoolean\(KEY_AWAITING_INSTALL_PERMISSION, false\)/);
  assert.match(onResume, /automaticChecksEnabled\(\)/);
  assert.match(onResume, /automaticCheckIsDue\(\)/);
  assert.match(onResume, /startCheck\(manual = false\)/);
  assert.match(startCheck, /destroyed \|\| operation != null \|\| !hasNetworkConsent\(\)/);
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
    assert.match(run.stdout, /YawfAndroidUpdater behavior assertions passed: 92/);
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
