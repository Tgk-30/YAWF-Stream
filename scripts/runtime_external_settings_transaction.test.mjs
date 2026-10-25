import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const helperPath = new URL(
  './android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransaction.java',
  import.meta.url,
);
const legalPath = new URL(
  './android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalLegalSnapshot.java',
  import.meta.url,
);
const driverPath = new URL(
  './android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java',
  import.meta.url,
);
const helper = readFileSync(helperPath, 'utf8');
const legal = readFileSync(legalPath, 'utf8');
const driver = readFileSync(driverPath, 'utf8');

function methodBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.ok(signatureIndex >= 0, `Missing method signature: ${signature}`);
  const open = source.indexOf('{', signatureIndex + signature.length);
  assert.ok(open >= 0, `Missing method body: ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`Unclosed method body: ${signature}`);
}

function replaceUnique(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Expected one mutation site: ${before}`);
  return source.replace(before, after);
}

function replaceUniqueInMethod(source, signature, before, after) {
  const body = methodBody(source, signature);
  const mutatedBody = replaceUnique(body, before, after);
  return replaceUnique(source, body, mutatedBody);
}

function bindingPatternLiteral(source) {
  const match = source.match(
    /private static final Pattern BINDING_TERMS = Pattern\.compile\(\s*("(?:\\.|[^"\\])*")\s*\);/,
  );
  assert.ok(match, 'Missing BINDING_TERMS Pattern literal');
  return match[1];
}

function validateIntegration(source, helperSource, legalSource) {
  const failures = [];
  const testEntry = methodBody(
    source,
    'public void productionApkCompletesServerModeExternalPlayerFlow() throws Throwable',
  );
  const runFlow = methodBody(source, 'private void runFlow()');
  const transaction = methodBody(source, 'private void openPlaybackSettingsTransaction()');
  const observation = methodBody(
    source,
    'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()',
  );
  const transactionGuard = methodBody(
    source,
    'private void assertNoOutOfScopeApprovalForSettingsTransaction()',
  );
  const ordinaryGuard = methodBody(source, 'private void assertNoOutOfScopeApproval()');
  const dialogFinder = methodBody(source, 'private UiObject2 findUniqueExactProductDialog(String label)');
  const scopedLabel = methodBody(source, 'private UiObject2 findLabeledClickableWithin(');

  if ((runFlow.match(/openPlaybackSettingsTransaction\(\);/g) ?? []).length !== 1) {
    failures.push('runFlow must invoke exactly one settings transaction');
  }
  const playerCapture = runFlow.indexOf('capture("production-player")');
  const open = runFlow.indexOf('openPlaybackSettingsTransaction()');
  const panel = runFlow.indexOf('waitForUniquePlaybackSettingsDialog()');
  const origin = runFlow.indexOf('transition("origin-confirmation-visible")');
  if (!(playerCapture >= 0 && playerCapture < open && open < panel && panel < origin)) {
    failures.push('settings transaction is not in the original pre-handoff position');
  }
  if (/waitForRefreshedPlaybackSettings|clickObservedControlImmediately/.test(runFlow)) {
    failures.push('runFlow retains the split acquire/click path');
  }

  const requiredTransactionFragments = [
    'RuntimeExternalSettingsTransaction.Result result = RuntimeExternalSettingsTransaction.open(',
    'return instrumentation.getUiAutomation().clearCache();',
    '.assertNoOutOfScopeApprovalForSettingsTransaction();',
    'return observePlaybackSettingsTransaction();',
    'recordSettingsTransactionTiming(',
    'recordSettingsClickTiming(',
    'recordSettingsRailObservation(',
    'checks.put("playbackActionsRailPanAttempts", result.railPanAttempts)',
    'RuntimeExternalPlayerFlowTest.this.log(message);',
    'MEDIA_WAIT_MS',
  ];
  for (const fragment of requiredTransactionFragments) {
    if (!transaction.includes(fragment)) failures.push(`transaction callsite lost: ${fragment}`);
  }

  if (!transactionGuard.includes(
    'RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(\n                instrumentation.getUiAutomation(), BINDING_TERMS)',
  )) failures.push('transaction legal guard does not use the fresh accessibility snapshot');
  const forbiddenPackages = [
    'com.android.permissioncontroller',
    'com.google.android.permissioncontroller',
    'com.android.settings',
    'com.google.android.packageinstaller',
    'com.android.packageinstaller',
  ];
  for (const packageName of forbiddenPackages) {
    if (!transactionGuard.includes(`foreground.equals("${packageName}")`)) {
      failures.push(`transaction guard lost forbidden package: ${packageName}`);
    }
  }
  if (!transactionGuard.includes('String foreground = currentPackage();')) {
    failures.push('transaction guard lost the current foreground package check');
  }
  if (!ordinaryGuard.includes('device.findObject(By.text(BINDING_TERMS))')
      || !ordinaryGuard.includes('device.findObject(By.desc(BINDING_TERMS))')) {
    failures.push('ordinary flow legal guard changed');
  }
  if (!source.includes('receipt.put("settingsTransactionTimings"')
      || !source.includes('"settingsTransactionTimingEventsOmitted"')
      || !source.includes('receipt.put("settingsClickTiming", settingsClickTiming)')
      || !source.includes('"externalLegalSnapshotFailureDiagnostics"')
      || !source.includes('new JSONArray(externalLegalSnapshotFailureDiagnostics)')
      || !source.includes('"externalLegalSnapshotFailureDiagnosticsOmitted"')) {
    failures.push('bounded settings timing receipt changed');
  }
  const legalDiagnosticRecorder = methodBody(
    source,
    'private void recordExternalLegalSnapshotFailureDiagnostics(Throwable failure)',
  );
  if (!source.includes('MAX_EXTERNAL_LEGAL_SNAPSHOT_FAILURE_DIAGNOSTICS = 8')
      || !legalDiagnosticRecorder.includes(
        'RuntimeExternalLegalSnapshot.failureDiagnostics(failure)',
      )
      || !legalDiagnosticRecorder.includes(
        'externalLegalSnapshotFailureDiagnostics.add(safe(diagnostics))',
      )) {
    failures.push('legal snapshot failure diagnostics are not sanitized and bounded');
  }
  const diagnosticRecord = testEntry.indexOf(
    'recordExternalLegalSnapshotFailureDiagnostics(caught);',
  );
  const originalRethrow = testEntry.indexOf('throw caught;');
  if (!(diagnosticRecord >= 0 && diagnosticRecord < originalRethrow)
      || !testEntry.includes('caught.addSuppressed(diagnosticsFailure);')) {
    failures.push('legal snapshot diagnostics can mask or miss the original failure');
  }

  const requiredObservationFragments = [
    'findUniqueExactProductDialog(PLAYER_DIALOG_LABEL)',
    'playerDialog == null || !hasVisibleBounds(playerDialog)',
    'findLabeledClickableWithin(',
    'playerDialog, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL',
    'settings != null && hasVisibleBounds(settings)',
    'assertVisibleBounds(settings, PLAYBACK_SETTINGS_LABEL)',
    'Observation.settings(settings::click)',
    'findUniquePlaybackActionsRailWithin(playerDialog)',
    'Observation.railPan(',
    'rail.scroll(Direction.RIGHT, 0.72f)',
    'assertVisibleBounds(playerDialog, "playing movie dialog")',
    'Observation.reveal(playerDialog::click)',
  ];
  for (const fragment of requiredObservationFragments) {
    if (!observation.includes(fragment)) failures.push(`transaction observation lost: ${fragment}`);
  }
  if (/\.click\s*\(|device\.click/.test(observation)) {
    failures.push('observation performs input instead of returning one fresh target');
  }
  if (!/By\.clazz\("android\.app\.Dialog"\)[\s\S]*?\.pkg\(PRODUCT_PACKAGE\)[\s\S]*?\.text\(exactLabel\(label\)\)/.test(dialogFinder)
      || !/dialogs\.size\(\) > 1/.test(dialogFinder)) {
    failures.push('playing/settings dialog is not exact, product-scoped, and duplicate-failing');
  }
  if (!/boundary\.findObjects\(By\.text\(labelPattern\)\)/.test(scopedLabel)
      || !/boundary\.findObjects\(By\.desc\(labelPattern\)\)/.test(scopedLabel)
      || !/candidates\.size\(\) > 1/.test(scopedLabel)) {
    failures.push('Playback settings label is not exact, dialog-scoped, and duplicate-failing');
  }

  if ((source.match(/openPlayer\.click\(\);/g) ?? []).length !== 1
      || !/assertEquals\("Open player must not have been clicked before confirmation", 0, openPlayerClicks\)/.test(runFlow)
      || !/openPlayerClicks\+\+;[\s\S]*?assertEquals\("Native Open player was clicked more than once", 1, openPlayerClicks\)/.test(runFlow)) {
    failures.push('the separate origin-scoped Open player authority changed');
  }
  if (/Open player|openPlayerClicks|resolveExternalDestination|EXTERNAL_PLAYER_LABEL/.test(helperSource + legalSource)) {
    failures.push('settings helpers gained external-handoff authority');
  }
  return failures;
}

function validateHelperShape(source) {
  const failures = [];
  const body = methodBody(source, 'static Result open(Environment environment, long timeoutMs)');
  const policy = methodBody(source, 'private static String chooseNextSettingsAction(');
  const freshGuard = methodBody(source, 'private static void runFreshLegalGuard(');
  const zero = body.indexOf('configurator.setWaitForIdleTimeout(TRANSACTION_IDLE_TIMEOUT_MS)');
  const api = body.indexOf('Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
  const cache = body.indexOf('environment.clearAccessibilityCache()');
  const guard = body.indexOf('runFreshLegalGuard(environment, configurator, "fresh-legal-guard")');
  const observe = body.indexOf('environment.observePlaybackSettings()');
  const settingsClick = body.indexOf('observation.settingsTarget.click()');
  const railPan = body.indexOf('observation.railPanTarget.click()');
  const revealClick = body.indexOf('observation.revealTarget.click()');
  const restore = body.indexOf('configurator.setWaitForIdleTimeout(previousIdleTimeoutMs)');
  if (!(zero >= 0 && zero < api && api < cache && cache < guard && guard < observe)) {
    failures.push('API/cache/guard/acquire sequence is not zero-idle and fail-closed');
  }
  if (!(observe < settingsClick && observe < railPan && observe < revealClick)) {
    failures.push('helper clicks before the fresh semantic observation');
  }
  if ((body.match(/observation\.settingsTarget\.click\(\)/g) ?? []).length !== 1
      || (body.match(/observation\.railPanTarget\.click\(\)/g) ?? []).length !== 1
      || (body.match(/observation\.revealTarget\.click\(\)/g) ?? []).length !== 1
      || !/revealVisible && !revealTapPerformed/.test(policy)
      || !/railPanAttempts >= MAX_PLAYBACK_ACTIONS_RAIL_PANS/.test(policy)) {
    failures.push('helper does not bound settings, rail, and conditional reveal input');
  }
  if (!freshGuard.includes('environment.assertNoOutOfScopeApproval()')
      || !freshGuard.includes('environment.recordTiming(')
      || !freshGuard.includes('stage')) {
    failures.push('fresh legal guard no longer records its exact guarded call');
  }
  if ((body.match(/runFreshLegalGuard\(/g) ?? []).length !== 4) {
    failures.push('each possible input no longer has its own fresh legal guard');
  }
  for (const stage of ['cache', 'fresh-legal-guard', 'fresh-input-legal-guard',
    'settings-acquisition', 'playback-actions-rail-pan-', 'reveal-click']) {
    if (!body.includes(`"${stage}"`)) failures.push(`missing bounded timing stage: ${stage}`);
  }
  if (!body.includes('environment.recordSettingsClickTiming(')) {
    failures.push('actual settings click timing is missing');
  }
  if (!/finally\s*\{[\s\S]*configurator\.setWaitForIdleTimeout\(previousIdleTimeoutMs\)/.test(body)
      || restore < 0) {
    failures.push('helper does not restore the exact prior idle timeout in finally');
  }
  if (!/while \(SystemClock\.uptimeMillis\(\) < deadline\)/.test(body)
      || !/SystemClock\.sleep\(POLL_INTERVAL_MS\)/.test(body)
      || !/POLL_INTERVAL_MS = 250L/.test(source)) {
    failures.push('helper changed the bounded 250 ms observation loop');
  }
  if (!body.includes('environment.recordRailObservation(observation.state, railPanAttempts)')
      || !body.includes('return new Result(')) {
    failures.push('helper lost the bounded rail receipt or typed result');
  }
  return failures;
}

function validateLegalShape(source) {
  const failures = [];
  const body = methodBody(
    source,
    'static void assertNoBindingTermsVisible(UiAutomation automation, Pattern bindingTerms)',
  );
  const roots = methodBody(source, 'private static Set<AccessibilityNodeInfo> freshRoots(');
  if (!body.includes('node.isVisibleToUser()')
      || !body.includes('node.getText()')
      || !body.includes('node.getContentDescription()')) {
    failures.push('one-pass guard lost visibility, text, or description checks');
  }
  if (!body.includes('node.getChild(childIndex, PREFETCHING_STRATEGY)')
      || !body.includes('visited.add(child)')
      || !body.includes('enforceSizeBound(visited.size())')
      || !body.includes('enforceTimeBound(startedAtMs)')) {
    failures.push('one-pass guard lost graph or bound checks');
  }
  if (!roots.includes('automation.getRootInActiveWindow()')
      || !roots.includes('automation.getWindowsOnAllDisplays()')
      || !roots.includes('window.getRoot(PREFETCHING_STRATEGY)')) {
    failures.push('fresh guard does not cover the UiAutomator root/window scope');
  }
  if (/androidx\.test\.uiautomator\.(?:By|UiDevice)|findObject|findObjects|runWatchers/.test(source)) {
    failures.push('fresh guard reintroduced ByMatcher or watcher traversal');
  }
  if (!source.includes('MAX_NODES = 4_096') || !source.includes('MAX_TRAVERSAL_MS = 1_000L')) {
    failures.push('fresh guard bounds changed');
  }
  if (!source.includes(
    'AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST',
  ) || source.includes('FLAG_PREFETCH_UNINTERRUPTIBLE')) {
    failures.push('fresh guard lost its public interruptible breadth-first prefetch strategy');
  }
  if (!source.includes('static String failureDiagnostics(Throwable failure)')
      || !source.includes('failure.addSuppressed(new DiagnosticsAttachment(')
      || !source.includes('maxPublicCallMs')
      || !source.includes('activeRootMs')
      || !source.includes('inventoryMs')
      || !source.includes('windowRootMs')
      || !source.includes('traversalMs')) {
    failures.push('fresh guard lost bounded failure diagnostics');
  }
  if (/getWindowId\(\)|window\.getId\(\)/.test(source)) {
    failures.push('fresh guard elides a later root by window identity');
  }
  return failures;
}

const buildStub = `package android.os;
public final class Build {
    public static final class VERSION { public static int SDK_INT = 36; }
    public static final class VERSION_CODES { public static final int UPSIDE_DOWN_CAKE = 34; }
}
`;

const clockStub = `package android.os;
public final class SystemClock {
    private static long now;
    public static long uptimeMillis() { return now; }
    public static void sleep(long millis) { now += millis; }
    public static void reset(long value) { now = value; }
    public static void advance(long millis) { now += millis; }
}
`;

const configuratorStub = `package androidx.test.uiautomator;
public final class Configurator {
    private static final Configurator INSTANCE = new Configurator();
    private long waitForIdleTimeout;
    private Configurator() {}
    public static Configurator getInstance() { return INSTANCE; }
    public long getWaitForIdleTimeout() { return waitForIdleTimeout; }
    public Configurator setWaitForIdleTimeout(long value) {
        waitForIdleTimeout = value;
        return this;
    }
    public static void reset(long value) { INSTANCE.waitForIdleTimeout = value; }
}
`;

const sparseArrayStub = `package android.util;
import java.util.ArrayList;
import java.util.List;
public final class SparseArray<T> {
    private final List<Integer> keys = new ArrayList<>();
    private final List<T> values = new ArrayList<>();
    public void put(int key, T value) {
        int existing = keys.indexOf(key);
        if (existing >= 0) values.set(existing, value);
        else { keys.add(key); values.add(value); }
    }
    public int size() { return values.size(); }
    public int keyAt(int index) { return keys.get(index); }
    public T valueAt(int index) { return values.get(index); }
}
`;

const accessibilityNodeStub = `package android.view.accessibility;
import android.os.SystemClock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
public class AccessibilityNodeInfo {
    public static final int FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST = 16;
    private static final int MAX_PREFETCHED_NODES = 50;
    public static int plainChildCalls;
    public static int prefetchedChildCalls;
    public final String id;
    public int windowId;
    public boolean visible = true;
    public CharSequence text;
    public CharSequence description;
    public long accessCostMs;
    public long coldChildCostMs;
    public long prefetchCostMs;
    public boolean prefetched;
    public String failureOperation;
    public final List<AccessibilityNodeInfo> children = new ArrayList<>();
    private final Map<Integer, Integer> childReads = new HashMap<>();
    public AccessibilityNodeInfo(String id) { this.id = id; }
    private void before(String operation) {
        SystemClock.advance(accessCostMs);
        if (operation.equals(failureOperation)) {
            throw new IllegalStateException("RAW_UI_SENTINEL");
        }
    }
    public boolean isVisibleToUser() { before("visible"); return visible; }
    public CharSequence getText() { before("text"); return text; }
    public CharSequence getContentDescription() { before("description"); return description; }
    public int getChildCount() { before("childCount"); return children.size(); }
    public AccessibilityNodeInfo getChild(int index) {
        before("child");
        plainChildCalls++;
        childReads.put(index, childReads.getOrDefault(index, 0) + 1);
        AccessibilityNodeInfo child = children.get(index);
        if (child != null && !child.prefetched) SystemClock.advance(coldChildCostMs);
        return child;
    }
    public AccessibilityNodeInfo getChild(int index, int strategy) {
        before("child");
        if (strategy != FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST) {
            throw new IllegalArgumentException("unexpected prefetch strategy");
        }
        prefetchedChildCalls++;
        childReads.put(index, childReads.getOrDefault(index, 0) + 1);
        AccessibilityNodeInfo child = children.get(index);
        if (child != null && !child.prefetched) {
            SystemClock.advance(prefetchCostMs);
            prefetchBreadthFirst(child);
        }
        return child;
    }
    public int childReads(int index) { return childReads.getOrDefault(index, 0); }
    public int getWindowId() { return windowId; }
    public static void resetPrefetchMetrics() {
        plainChildCalls = 0;
        prefetchedChildCalls = 0;
    }
    public static void prefetchBreadthFirst(AccessibilityNodeInfo root) {
        if (root == null) return;
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.addLast(root);
        int prefetchedCount = 0;
        while (!pending.isEmpty() && prefetchedCount < MAX_PREFETCHED_NODES) {
            AccessibilityNodeInfo current = pending.removeFirst();
            if (current.prefetched) continue;
            current.prefetched = true;
            prefetchedCount++;
            for (AccessibilityNodeInfo child : current.children) {
                if (child != null && !child.prefetched) pending.addLast(child);
            }
        }
    }
    @Override public boolean equals(Object other) {
        return other instanceof AccessibilityNodeInfo
                && Objects.equals(id, ((AccessibilityNodeInfo) other).id);
    }
    @Override public int hashCode() { return Objects.hashCode(id); }
}
`;

const accessibilityWindowStub = `package android.view.accessibility;
import android.os.SystemClock;
public class AccessibilityWindowInfo {
    public static int plainRootCalls;
    public static int prefetchedRootCalls;
    public AccessibilityNodeInfo root;
    public int id;
    public long accessCostMs;
    public boolean fail;
    public AccessibilityWindowInfo(AccessibilityNodeInfo root) {
        this.root = root;
        this.id = root == null ? 0 : root.windowId;
    }
    public int getId() { return id; }
    public AccessibilityNodeInfo getRoot() {
        SystemClock.advance(accessCostMs);
        plainRootCalls++;
        if (fail) throw new IllegalStateException("RAW_UI_SENTINEL");
        return root;
    }
    public AccessibilityNodeInfo getRoot(int strategy) {
        SystemClock.advance(accessCostMs);
        if (strategy != AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST) {
            throw new IllegalArgumentException("unexpected prefetch strategy");
        }
        prefetchedRootCalls++;
        if (fail) throw new IllegalStateException("RAW_UI_SENTINEL");
        if (root != null && !root.prefetched) {
            SystemClock.advance(root.prefetchCostMs);
            AccessibilityNodeInfo.prefetchBreadthFirst(root);
        }
        return root;
    }
    public static void resetPrefetchMetrics() {
        plainRootCalls = 0;
        prefetchedRootCalls = 0;
    }
}
`;

const uiAutomationStub = `package android.app;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.uiautomator.Configurator;
import java.util.List;
public class UiAutomation {
    public AccessibilityNodeInfo activeRoot;
    public SparseArray<List<AccessibilityWindowInfo>> windows = new SparseArray<>();
    public long accessCostMs;
    public String failureOperation;
    public int activeRootCalls;
    public int windowsCalls;
    public int clearCalls;
    public boolean clearResult = true;
    public boolean clearCache() {
        if (Configurator.getInstance().getWaitForIdleTimeout() != 0L) {
            throw new AssertionError("cache refresh did not run at zero idle");
        }
        clearCalls++;
        return clearResult;
    }
    public AccessibilityNodeInfo getRootInActiveWindow() {
        SystemClock.advance(accessCostMs);
        activeRootCalls++;
        if ("activeRoot".equals(failureOperation)) {
            throw new IllegalStateException("RAW_UI_SENTINEL");
        }
        return activeRoot;
    }
    public SparseArray<List<AccessibilityWindowInfo>> getWindowsOnAllDisplays() {
        SystemClock.advance(accessCostMs);
        windowsCalls++;
        if ("windows".equals(failureOperation)) {
            throw new IllegalStateException("RAW_UI_SENTINEL");
        }
        return windows;
    }
}
`;

const transactionHarnessSource = `package com.yawf.runtimeinstrumentation;

import android.os.Build;
import android.os.SystemClock;
import androidx.test.uiautomator.Configurator;
import java.util.ArrayList;
import java.util.List;

public final class RuntimeExternalSettingsTransactionHarness {
    private static int checks;
    private interface Action { void run(); }

    private static void check(boolean value, String message) {
        checks++;
        if (!value) throw new AssertionError(message);
    }

    private static void reset(int api, long idleTimeout) {
        Build.VERSION.SDK_INT = api;
        Configurator.reset(idleTimeout);
        SystemClock.reset(0L);
    }

    private static void requireZeroIdle(String phase) {
        check(Configurator.getInstance().getWaitForIdleTimeout() == 0L,
                phase + " did not execute with zero idle timeout");
    }

    private static Throwable expectFailure(Class<?> type, Action action, String label) {
        try {
            action.run();
        } catch (Throwable failure) {
            check(type.isInstance(failure), label + " threw " + failure.getClass().getName());
            return failure;
        }
        throw new AssertionError(label + " did not fail");
    }

    private static abstract class CountingEnvironment
            implements RuntimeExternalSettingsTransaction.Environment {
        int clearCalls;
        int guardCalls;
        int observeCalls;
        int revealAttempts;
        int railPanAttempts;
        int settingsAttempts;
        int logs;
        int settingsClickTimings;
        int railObservationCalls;
        boolean settingsClickReturned;
        boolean cacheResult = true;
        long guardCostMs;
        final List<String> timingStages = new ArrayList<>();
        final List<Boolean> timingReturned = new ArrayList<>();
        final List<String> railObservationStates = new ArrayList<>();
        final List<Integer> railObservationPans = new ArrayList<>();

        @Override
        public boolean clearAccessibilityCache() {
            requireZeroIdle("cache refresh");
            clearCalls++;
            return cacheResult;
        }

        @Override
        public void assertNoOutOfScopeApproval() {
            requireZeroIdle("policy guard");
            guardCalls++;
            SystemClock.advance(guardCostMs);
        }

        @Override
        public void recordTiming(
                String stage,
                long startedAtMs,
                long finishedAtMs,
                long idleBeforeMs,
                long idleAfterMs,
                boolean returned) {
            requireZeroIdle("transaction timing");
            check(finishedAtMs >= startedAtMs, "timing was not monotonic");
            check(idleBeforeMs == 0L && idleAfterMs == 0L, "timing did not record zero idle");
            timingStages.add(stage);
            timingReturned.add(returned);
        }

        @Override
        public void recordSettingsClickTiming(
                long dispatchedAtMs,
                long finishedAtMs,
                long idleBeforeMs,
                long idleAfterMs,
                boolean returned) {
            requireZeroIdle("settings click timing");
            check(finishedAtMs >= dispatchedAtMs, "settings click timing was not monotonic");
            check(idleBeforeMs == 0L && idleAfterMs == 0L,
                    "settings click timing did not record zero idle");
            settingsClickTimings++;
            settingsClickReturned = returned;
        }

        @Override
        public void recordRailObservation(String state, int completedPanAttempts) {
            requireZeroIdle("rail observation");
            railObservationCalls++;
            railObservationStates.add(state);
            railObservationPans.add(completedPanAttempts);
        }

        @Override
        public void log(String message) {
            requireZeroIdle("transaction log");
            logs++;
        }

        RuntimeExternalSettingsTransaction.ClickTarget revealTarget() {
            return () -> {
                requireZeroIdle("reveal click");
                revealAttempts++;
            };
        }

        RuntimeExternalSettingsTransaction.ClickTarget settingsTarget() {
            return () -> {
                requireZeroIdle("settings click");
                settingsAttempts++;
            };
        }

        RuntimeExternalSettingsTransaction.ClickTarget railPanTarget() {
            return () -> {
                requireZeroIdle("rail pan");
                railPanAttempts++;
            };
        }
    }

    private static void chromeExpiryRegressionAndSuccessRestore() {
        long original = 7_311L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                requireZeroIdle("fresh observation");
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.settings(() -> {
                    settingsAttempts++;
                    if (SystemClock.uptimeMillis() >= 3_200L) {
                        throw new RuntimeException("player chrome expired during implicit idle");
                    }
                });
            }
        };
        environment.guardCostMs = 300L;
        RuntimeExternalSettingsTransaction.Result result =
                RuntimeExternalSettingsTransaction.open(environment, 60_000L);
        check(environment.clearCalls == 1, "success cache refresh count changed");
        check(environment.guardCalls == 2, "success guard count changed");
        check(environment.observeCalls == 1, "success observation count changed");
        check(environment.settingsAttempts == 1, "success settings click count changed");
        check(environment.revealAttempts == 0, "success unexpectedly revealed controls");
        check(environment.timingStages.equals(List.of(
                        "cache", "fresh-legal-guard", "settings-acquisition",
                        "fresh-input-legal-guard")),
                "success timing stages changed");
        check(environment.railObservationCalls == 1
                        && environment.railObservationStates.equals(
                                List.of("playback-settings-visible"))
                        && environment.railObservationPans.equals(List.of(0)),
                "success rail observation receipt changed");
        check(result.railObservationCount == 0 && result.railPanAttempts == 0
                        && !result.revealTapPerformed && result.settingsClickCount == 1,
                "success typed result changed");
        check(environment.settingsClickTimings == 1 && environment.settingsClickReturned,
                "success actual click timing changed");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "success did not restore the exact nondefault timeout");
    }

    private static void conditionalRevealAndSettingsAreSingleUse() {
        long original = 8_123L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                requireZeroIdle("reveal observation");
                observeCalls++;
                if (observeCalls <= 3) {
                    return RuntimeExternalSettingsTransaction.Observation.reveal(revealTarget());
                }
                return RuntimeExternalSettingsTransaction.Observation.settings(settingsTarget());
            }
        };
        RuntimeExternalSettingsTransaction.Result result =
                RuntimeExternalSettingsTransaction.open(environment, 60_000L);
        check(environment.revealAttempts == 1, "reveal was not single-use");
        check(environment.settingsAttempts == 1, "settings was not single-use");
        check(environment.clearCalls == 4 && environment.guardCalls == 6
                        && environment.observeCalls == 4,
                "each retry did not repeat cache, guard, and fresh acquisition");
        check(environment.timingStages.size() == 15
                        && environment.timingStages.contains("reveal-click"),
                "reveal timing stages changed");
        check(environment.railObservationCalls == 2
                        && environment.railObservationStates.equals(List.of(
                                "player-dialog-visible-controls-hidden",
                                "playback-settings-visible"))
                        && environment.railObservationPans.equals(List.of(0, 0)),
                "reveal rail observation receipt changed");
        check(result.railObservationCount == 0 && result.railPanAttempts == 0
                        && result.revealTapPerformed && result.settingsClickCount == 1,
                "reveal typed result changed");
        check(environment.settingsClickTimings == 1 && environment.settingsClickReturned,
                "reveal flow lost final click timing");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "reveal success did not restore the exact timeout");
    }

    private static void apiGuardFailsBeforeCacheQueryOrClick() {
        long original = 9_901L;
        reset(33, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.settings(settingsTarget());
            }
        };
        expectFailure(AssertionError.class,
                () -> RuntimeExternalSettingsTransaction.open(environment, 60_000L),
                "API guard");
        check(environment.clearCalls == 0 && environment.guardCalls == 0
                        && environment.observeCalls == 0 && environment.settingsAttempts == 0,
                "API guard allowed cache/query/click activity");
        check(environment.timingStages.isEmpty() && environment.settingsClickTimings == 0,
                "API guard recorded action timing");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "API guard failure did not restore the exact timeout");
    }

    private static void cacheFalseFailsBeforeGuardQueryOrClick() {
        long original = 6_707L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            { cacheResult = false; }
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.settings(settingsTarget());
            }
        };
        expectFailure(AssertionError.class,
                () -> RuntimeExternalSettingsTransaction.open(environment, 60_000L),
                "cache false");
        check(environment.clearCalls == 1 && environment.guardCalls == 0
                        && environment.observeCalls == 0 && environment.settingsAttempts == 0,
                "cache failure allowed guard/query/click activity");
        check(environment.timingStages.equals(List.of("cache")),
                "cache failure timing changed");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "cache failure did not restore the exact timeout");
    }

    private static void guardAssertionRestoresExactly() {
        long original = 5_509L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public void assertNoOutOfScopeApproval() {
                super.assertNoOutOfScopeApproval();
                throw new AssertionError("out of scope");
            }
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.settings(settingsTarget());
            }
        };
        expectFailure(AssertionError.class,
                () -> RuntimeExternalSettingsTransaction.open(environment, 60_000L),
                "policy guard");
        check(environment.clearCalls == 1 && environment.guardCalls == 1
                        && environment.observeCalls == 0 && environment.settingsAttempts == 0,
                "failed guard allowed query/click activity");
        check(environment.timingStages.equals(List.of("cache", "fresh-legal-guard"))
                        && !environment.timingReturned.get(1),
                "failed guard timing changed");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "AssertionError did not restore the exact timeout");
    }

    private static void observationFailuresAreFailClosed() {
        String[] failures = {"duplicate", "scope", "bounds"};
        for (int index = 0; index < failures.length; index++) {
            long original = 4_101L + index;
            reset(36, original);
            String label = failures[index];
            CountingEnvironment environment = new CountingEnvironment() {
                @Override
                public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                    requireZeroIdle(label + " observation");
                    observeCalls++;
                    throw new AssertionError(label);
                }
            };
            expectFailure(AssertionError.class,
                    () -> RuntimeExternalSettingsTransaction.open(environment, 60_000L),
                    label + " admission");
            check(environment.clearCalls == 1 && environment.guardCalls == 1
                            && environment.observeCalls == 1
                            && environment.revealAttempts == 0 && environment.settingsAttempts == 0,
                    label + " failure allowed a click");
            check(environment.timingStages.equals(List.of(
                            "cache", "fresh-legal-guard", "settings-acquisition"))
                            && !environment.timingReturned.get(2),
                    label + " acquisition timing changed");
            check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                    label + " failure did not restore the exact timeout");
        }
    }

    private static void staleClickRuntimeExceptionIsNotRetried() {
        long original = 3_303L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                requireZeroIdle("stale observation");
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.settings(() -> {
                    requireZeroIdle("stale click");
                    settingsAttempts++;
                    throw new RuntimeException("stale target");
                });
            }
        };
        expectFailure(RuntimeException.class,
                () -> RuntimeExternalSettingsTransaction.open(environment, 60_000L),
                "stale click");
        check(environment.observeCalls == 1 && environment.settingsAttempts == 1,
                "stale target was queried or clicked again");
        check(environment.settingsClickTimings == 1 && !environment.settingsClickReturned,
                "failed actual click did not retain final timing");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "RuntimeException did not restore the exact timeout");
    }

    private static void timeoutAssertionRestoresExactly() {
        long original = 2_207L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                requireZeroIdle("waiting observation");
                observeCalls++;
                return RuntimeExternalSettingsTransaction.Observation.waiting();
            }
        };
        expectFailure(AssertionError.class,
                () -> RuntimeExternalSettingsTransaction.open(environment, 500L),
                "bounded timeout");
        check(environment.observeCalls == 2 && environment.settingsAttempts == 0
                        && environment.revealAttempts == 0,
                "bounded timeout changed polling or clicked");
        check(environment.timingStages.size() == 6 && environment.settingsClickTimings == 0,
                "bounded timeout timing count changed");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "timeout AssertionError did not restore the exact timeout");
    }

    public static void main(String[] args) {
        chromeExpiryRegressionAndSuccessRestore();
        conditionalRevealAndSettingsAreSingleUse();
        apiGuardFailsBeforeCacheQueryOrClick();
        cacheFalseFailsBeforeGuardQueryOrClick();
        guardAssertionRestoresExactly();
        observationFailuresAreFailClosed();
        staleClickRuntimeExceptionIsNotRetried();
        timeoutAssertionRestoresExactly();
        System.out.println("OK checks=" + checks);
    }
}
`;

function writeSource(root, relative, source) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function javaCommands(root, sources, mainClass) {
  const classes = join(root, 'classes');
  mkdirSync(classes);
  const javaHome = process.env.JAVA_HOME
    || '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
  const javac = join(javaHome, 'bin', 'javac');
  const java = join(javaHome, 'bin', 'java');
  const compiled = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, ...sources], {
    encoding: 'utf8',
  });
  if (compiled.status !== 0) return compiled;
  return spawnSync(java, ['-cp', classes, mainClass], { encoding: 'utf8' });
}

function executeTransaction(source) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-settings-transaction-'));
  try {
    const sources = [
      writeSource(root, 'android/os/Build.java', buildStub),
      writeSource(root, 'android/os/SystemClock.java', clockStub),
      writeSource(root, 'androidx/test/uiautomator/Configurator.java', configuratorStub),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransaction.java',
        source,
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransactionHarness.java',
        transactionHarnessSource,
      ),
    ];
    return javaCommands(
      root,
      sources,
      'com.yawf.runtimeinstrumentation.RuntimeExternalSettingsTransactionHarness',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function androidAccessibilityStubs(root) {
  return [
    writeSource(root, 'android/os/SystemClock.java', clockStub),
    writeSource(root, 'android/util/SparseArray.java', sparseArrayStub),
    writeSource(root, 'android/view/accessibility/AccessibilityNodeInfo.java', accessibilityNodeStub),
    writeSource(root, 'android/view/accessibility/AccessibilityWindowInfo.java', accessibilityWindowStub),
    writeSource(root, 'android/app/UiAutomation.java', uiAutomationStub),
    writeSource(root, 'androidx/test/uiautomator/Configurator.java', configuratorStub),
  ];
}

function legalHarnessSource(patternLiteral) {
  return `package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class RuntimeExternalLegalSnapshotHarness {
    private static final Pattern BINDING_TERMS = Pattern.compile(${patternLiteral});
    private static int checks;
    private interface Action { void run(); }

    private static void check(boolean value, String message) {
        checks++;
        if (!value) throw new AssertionError(message);
    }

    private static Throwable expectFailure(Class<?> type, Action action, String label) {
        try {
            action.run();
        } catch (Throwable failure) {
            check(type.isInstance(failure), label + " threw " + failure.getClass().getName());
            return failure;
        }
        throw new AssertionError(label + " did not fail");
    }

    private static AccessibilityNodeInfo node(String id) {
        return new AccessibilityNodeInfo(id);
    }

    private static UiAutomation automation(
            AccessibilityNodeInfo activeRoot, AccessibilityNodeInfo... windowRoots) {
        UiAutomation automation = new UiAutomation();
        automation.activeRoot = activeRoot;
        List<AccessibilityWindowInfo> windows = new ArrayList<>();
        for (AccessibilityNodeInfo root : windowRoots) {
            windows.add(new AccessibilityWindowInfo(root));
        }
        automation.windows.put(0, windows);
        return automation;
    }

    private static void reset() {
        SystemClock.reset(0L);
        AccessibilityNodeInfo.resetPrefetchMetrics();
        AccessibilityWindowInfo.resetPrefetchMetrics();
    }

    private static void originalPatternCoversTextDescriptionAndVisibility() {
        String[] phrases = {
                "terms of service",
                "license agreement",
                "user agreement",
                "binding terms"
        };
        for (String phrase : phrases) {
            reset();
            AccessibilityNodeInfo text = node("text-" + phrase);
            text.text = "Prefix " + phrase.toUpperCase() + " suffix";
            expectFailure(AssertionError.class,
                    () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                            automation(text, text), BINDING_TERMS),
                    "visible text " + phrase);

            reset();
            AccessibilityNodeInfo description = node("description-" + phrase);
            description.description = "Prefix\\n" + phrase + " suffix";
            expectFailure(AssertionError.class,
                    () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                            automation(description, description), BINDING_TERMS),
                    "visible description " + phrase);

            reset();
            AccessibilityNodeInfo root = node("hidden-root-" + phrase);
            AccessibilityNodeInfo hidden = node("hidden-" + phrase);
            hidden.visible = false;
            hidden.text = phrase;
            hidden.description = phrase;
            AccessibilityNodeInfo unreachable = node("unreachable-" + phrase);
            unreachable.text = phrase;
            hidden.children.add(unreachable);
            root.children.add(hidden);
            RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                    automation(root, root), BINDING_TERMS);
            check(hidden.childReads(0) == 0,
                    "hidden subtree was traversed for " + phrase);
        }

        String[] adversarialNonmatches = {
                "terms of services",
                "license agreements",
                "user agreementish",
                "nonbinding terms"
        };
        for (int index = 0; index < adversarialNonmatches.length; index++) {
            reset();
            AccessibilityNodeInfo root = node("nonmatch-" + index);
            root.text = adversarialNonmatches[index];
            root.description = adversarialNonmatches[index];
            RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                    automation(root, root), BINDING_TERMS);
        }
    }

    private static void multipleRootsAndDisplaysAreCovered() {
        reset();
        AccessibilityNodeInfo active = node("active-safe");
        AccessibilityNodeInfo otherWindow = node("other-window");
        otherWindow.description = "binding terms";
        UiAutomation automation = automation(active, active, otherWindow);
        List<AccessibilityWindowInfo> displayOne = new ArrayList<>();
        displayOne.add(new AccessibilityWindowInfo(node("display-one-safe")));
        automation.windows.put(1, displayOne);
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation, BINDING_TERMS),
                "second visible window root");
        check(automation.activeRootCalls == 1 && automation.windowsCalls == 1,
                "fresh root acquisition count changed");
    }

    private static void missingRootsAndUnexpectedErrorsFailClosed() {
        reset();
        AccessibilityNodeInfo valid = node("valid-window-root");
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(null, valid), BINDING_TERMS),
                "missing active root");

        reset();
        UiAutomation noDisplays = new UiAutomation();
        noDisplays.activeRoot = node("active-only");
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        noDisplays, BINDING_TERMS),
                "missing display windows");

        reset();
        UiAutomation emptyDisplay = new UiAutomation();
        emptyDisplay.activeRoot = node("active-empty-display");
        emptyDisplay.windows.put(0, new ArrayList<>());
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        emptyDisplay, BINDING_TERMS),
                "empty display windows");

        reset();
        UiAutomation nullWindow = new UiAutomation();
        nullWindow.activeRoot = node("active-null-window");
        List<AccessibilityWindowInfo> nullWindows = new ArrayList<>();
        nullWindows.add(null);
        nullWindow.windows.put(0, nullWindows);
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        nullWindow, BINDING_TERMS),
                "missing window");

        reset();
        UiAutomation nullWindowRoot = automation(node("active-null-root"), (AccessibilityNodeInfo) null);
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        nullWindowRoot, BINDING_TERMS),
                "missing window root");

        reset();
        AccessibilityNodeInfo missingChild = node("missing-child-root");
        missingChild.children.add(null);
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(missingChild, missingChild), BINDING_TERMS),
                "missing child");

        reset();
        AccessibilityNodeInfo throwing = node("throwing");
        throwing.failureOperation = "text";
        Throwable failure = expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(throwing, throwing), BINDING_TERMS),
                "unexpected node error");
        check(!failure.getMessage().contains("RAW_UI_SENTINEL"),
                "raw UI diagnostic escaped the guard");

        reset();
        UiAutomation throwingAutomation = automation(node("safe"), node("safe"));
        throwingAutomation.failureOperation = "windows";
        Throwable automationFailure = expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        throwingAutomation, BINDING_TERMS),
                "unexpected root error");
        check(!automationFailure.getMessage().contains("RAW_UI_SENTINEL"),
                "raw automation diagnostic escaped the guard");
    }

    private static String requireDiagnostics(Throwable failure, String label) {
        String diagnostics = RuntimeExternalLegalSnapshot.failureDiagnostics(failure);
        check(diagnostics != null && diagnostics.length() > 0,
                label + " did not retain snapshot diagnostics");
        return diagnostics;
    }

    private static UiAutomation oneWindowAutomation(
            AccessibilityNodeInfo activeRoot, AccessibilityWindowInfo window) {
        UiAutomation automation = new UiAutomation();
        automation.activeRoot = activeRoot;
        List<AccessibilityWindowInfo> windows = new ArrayList<>();
        windows.add(window);
        automation.windows.put(0, windows);
        return automation;
    }

    private static void sameWindowIdentityNeverElidesTheLaterRoot() {
        reset();
        AccessibilityNodeInfo active = node("RAW_ACTIVE_NODE_ID");
        active.windowId = 7;
        AccessibilityNodeInfo later = node("RAW_LATER_NODE_ID");
        later.windowId = 7;
        later.description = "binding terms https://private.invalid/token";
        AccessibilityWindowInfo legalWindow = new AccessibilityWindowInfo(later);
        legalWindow.id = 7;
        legalWindow.accessCostMs = 80L;
        UiAutomation legalAutomation = oneWindowAutomation(active, legalWindow);
        legalAutomation.accessCostMs = 20L;
        Throwable legalFailure = expectFailure(
                AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        legalAutomation, BINDING_TERMS),
                "same-window later legal root");
        check("Refusing to act while a binding legal phrase is visible"
                        .equals(legalFailure.getMessage()),
                "snapshot diagnostics masked the legal failure");
        String legalDiagnostics = requireDiagnostics(
                legalFailure, "same-window later legal root");
        check(legalDiagnostics.equals(
                        "currentPhase=traversal-description totalMs=120 activeRootMs=20 "
                                + "inventoryMs=20 windowRootMs=80 traversalMs=0 "
                                + "maxPublicCallMs=80 displays=1 windows=1 roots=2 "
                                + "visited=2 visible=2 skipped=0 childFetches=0"),
                "same-window diagnostics were incomplete: " + legalDiagnostics);
        check(!legalDiagnostics.contains("RAW_ACTIVE_NODE_ID")
                        && !legalDiagnostics.contains("RAW_LATER_NODE_ID")
                        && !legalDiagnostics.contains("binding terms")
                        && !legalDiagnostics.contains("https://"),
                "raw accessibility content escaped the snapshot diagnostics");
        check(AccessibilityWindowInfo.prefetchedRootCalls == 1,
                "same-window legal root was not fetched exactly once");

        reset();
        AccessibilityNodeInfo nullActive = node("same-window-null-active");
        nullActive.windowId = 7;
        AccessibilityWindowInfo nullWindow = new AccessibilityWindowInfo(null);
        nullWindow.id = 7;
        Throwable nullFailure = expectFailure(
                AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        oneWindowAutomation(nullActive, nullWindow), BINDING_TERMS),
                "same-window null root");
        check("A fresh legal snapshot window root was missing".equals(nullFailure.getMessage()),
                "snapshot diagnostics masked the null-root failure");
        check(requireDiagnostics(nullFailure, "same-window null root")
                        .contains("currentPhase=window-root"),
                "null-root diagnostics lost the current phase");
        check(AccessibilityWindowInfo.prefetchedRootCalls == 1,
                "same-window null root was not fetched exactly once");

        reset();
        AccessibilityNodeInfo throwingActive = node("same-window-throw-active");
        throwingActive.windowId = 7;
        AccessibilityNodeInfo throwingRoot = node("RAW_THROWING_ROOT_ID");
        throwingRoot.windowId = 7;
        AccessibilityWindowInfo throwingWindow = new AccessibilityWindowInfo(throwingRoot);
        throwingWindow.id = 7;
        throwingWindow.fail = true;
        Throwable throwingFailure = expectFailure(
                AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        oneWindowAutomation(throwingActive, throwingWindow), BINDING_TERMS),
                "same-window throwing root");
        check("The fresh legal snapshot could not be verified: IllegalStateException"
                        .equals(throwingFailure.getMessage()),
                "snapshot diagnostics masked the root exception");
        String throwingDiagnostics = requireDiagnostics(
                throwingFailure, "same-window throwing root");
        check(throwingDiagnostics.contains("currentPhase=window-root")
                        && !throwingDiagnostics.contains("RAW_THROWING_ROOT_ID")
                        && !throwingDiagnostics.contains("RAW_UI_SENTINEL"),
                "throwing-root diagnostics were unsafe or incomplete");
        check(AccessibilityWindowInfo.prefetchedRootCalls == 1,
                "same-window throwing root was not fetched exactly once");
    }

    private static void traversalDiagnosticsCountVisibilityAndChildFetches() {
        reset();
        AccessibilityNodeInfo root = node("counter-root");
        AccessibilityNodeInfo hidden = node("counter-hidden");
        hidden.visible = false;
        AccessibilityNodeInfo legal = node("counter-legal");
        legal.description = "license agreement";
        root.children.add(hidden);
        root.children.add(legal);
        Throwable failure = expectFailure(
                AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(root, root), BINDING_TERMS),
                "visibility and child counters");
        String diagnostics = requireDiagnostics(failure, "visibility and child counters");
        check(diagnostics.contains("visited=3 visible=2 skipped=1 childFetches=2"),
                "traversal counters were incomplete: " + diagnostics);
        check(hidden.childReads(0) == 0,
                "diagnostic observation traversed an invisible subtree");
    }

    private static void graphSizeAndTimeBoundsFailClosed() {
        reset();
        AccessibilityNodeInfo cycle = node("cycle");
        cycle.children.add(cycle);
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(cycle, cycle), BINDING_TERMS),
                "cycle");

        reset();
        AccessibilityNodeInfo oversized = node("oversized");
        for (int index = 0; index < 4_096; index++) {
            oversized.children.add(node("oversized-child-" + index));
        }
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(oversized, oversized), BINDING_TERMS),
                "node bound");

        reset();
        AccessibilityNodeInfo slow = node("slow");
        slow.accessCostMs = 260L;
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        automation(slow, slow), BINDING_TERMS),
                "time bound");
    }

    private static void everyAccessibleChildIsReadOnceWithoutLegacyMatcher() {
        reset();
        LegacyMatcher.calls = 0;
        AccessibilityNodeInfo root = node("once-root");
        AccessibilityNodeInfo first = node("once-first");
        AccessibilityNodeInfo second = node("once-second");
        AccessibilityNodeInfo grandchild = node("once-grandchild");
        root.children.add(first);
        root.children.add(second);
        first.children.add(grandchild);
        RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                automation(root, root), BINDING_TERMS);
        check(root.childReads(0) == 1 && root.childReads(1) == 1
                        && first.childReads(0) == 1,
                "an accessible child was read more than once");
        check(LegacyMatcher.calls == 0,
                "one-pass guard invoked a ByMatcher watcher scan");
    }

    private static List<AccessibilityNodeInfo> coldTree(
            String prefix, int count, long childCostMs, long prefetchCostMs) {
        List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            AccessibilityNodeInfo node = node(prefix + "-" + index);
            node.coldChildCostMs = childCostMs;
            node.prefetchCostMs = prefetchCostMs;
            nodes.add(node);
            if (index > 0) nodes.get((index - 1) / 4).children.add(node);
        }
        return nodes;
    }

    private static UiAutomation coldNinetySevenNodeAutomation(
            List<AccessibilityNodeInfo> active,
            List<AccessibilityNodeInfo> otherDisplay) {
        UiAutomation automation = automation(active.get(0), active.get(0));
        List<AccessibilityWindowInfo> displayOne = new ArrayList<>();
        displayOne.add(new AccessibilityWindowInfo(otherDisplay.get(0)));
        automation.windows.put(1, displayOne);
        return automation;
    }

    private static void coldNinetySevenNodeSnapshotUsesPublicPrefetchWithoutNarrowingScope() {
        reset();
        List<AccessibilityNodeInfo> active = coldTree("cold-active", 70, 25L, 25L);
        List<AccessibilityNodeInfo> otherDisplay =
                coldTree("cold-other-display", 27, 25L, 25L);
        RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                coldNinetySevenNodeAutomation(active, otherDisplay), BINDING_TERMS);
        check(SystemClock.uptimeMillis() <= 1_000L,
                "97-node cold snapshot exceeded the unchanged time bound");
        check(AccessibilityWindowInfo.prefetchedRootCalls == 2
                        && AccessibilityWindowInfo.plainRootCalls == 0,
                "a cold all-display window root bypassed public prefetch");
        check(AccessibilityNodeInfo.prefetchedChildCalls == 95
                        && AccessibilityNodeInfo.plainChildCalls == 0,
                "a cold accessible child bypassed public prefetch");
        check(active.get(69).prefetched && otherDisplay.get(26).prefetched,
                "public prefetch did not cover the complete bounded graph");

        reset();
        active = coldTree("legal-active", 70, 25L, 25L);
        otherDisplay = coldTree("legal-other-display", 27, 25L, 25L);
        otherDisplay.get(26).description = "Prefix binding terms suffix";
        final List<AccessibilityNodeInfo> legalActive = active;
        final List<AccessibilityNodeInfo> legalOtherDisplay = otherDisplay;
        expectFailure(AssertionError.class,
                () -> RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                        coldNinetySevenNodeAutomation(
                                legalActive, legalOtherDisplay), BINDING_TERMS),
                "last node on another display");
    }

    public static void main(String[] args) {
        originalPatternCoversTextDescriptionAndVisibility();
        multipleRootsAndDisplaysAreCovered();
        missingRootsAndUnexpectedErrorsFailClosed();
        sameWindowIdentityNeverElidesTheLaterRoot();
        traversalDiagnosticsCountVisibilityAndChildFetches();
        graphSizeAndTimeBoundsFailClosed();
        everyAccessibleChildIsReadOnceWithoutLegacyMatcher();
        coldNinetySevenNodeSnapshotUsesPublicPrefetchWithoutNarrowingScope();
        System.out.println("LEGAL_OK checks=" + checks);
    }

    private static final class LegacyMatcher { static int calls; }
}
`;
}

function executeLegal(source, driverSource = driver) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-settings-legal-'));
  try {
    const sources = [
      ...androidAccessibilityStubs(root),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalLegalSnapshot.java',
        source,
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalLegalSnapshotHarness.java',
        legalHarnessSource(bindingPatternLiteral(driverSource)),
      ),
    ];
    return javaCommands(
      root,
      sources,
      'com.yawf.runtimeinstrumentation.RuntimeExternalLegalSnapshotHarness',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function settingsCallsiteBlock(source) {
  const runFlow = methodBody(source, 'private void runFlow()');
  const after = 'capture("production-player");';
  const before = 'waitForUniquePlaybackSettingsDialog();';
  const start = runFlow.indexOf(after);
  const end = runFlow.indexOf(before, start + after.length);
  assert.ok(start >= 0 && end > start, 'Missing bounded pre-handoff settings callsite');
  return runFlow.slice(start + after.length, end).trim();
}

function driverAdapterSource(source) {
  const callsite = settingsCallsiteBlock(source);
  const openTransaction = methodBody(source, 'private void openPlaybackSettingsTransaction()');
  const observeTransaction = methodBody(
    source,
    'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()',
  );
  const transactionGuard = methodBody(
    source,
    'private void assertNoOutOfScopeApprovalForSettingsTransaction()',
  );
  const currentPackage = methodBody(source, 'private String currentPackage()');
  const recordTiming = methodBody(source, 'private void recordSettingsTransactionTiming(');
  const recordLegalFailureDiagnostics = methodBody(
    source,
    'private void recordExternalLegalSnapshotFailureDiagnostics(Throwable failure)',
  );
  const recordClickTiming = methodBody(source, 'private void recordSettingsClickTiming(');
  const recordRailObservation = methodBody(source, 'private void recordSettingsRailObservation(');
  const findDialog = methodBody(source, 'private UiObject2 findUniqueExactProductDialog(String label)');
  const findRail = methodBody(source, 'private UiObject2 findUniquePlaybackActionsRailWithin(');
  const findScopedLabel = methodBody(source, 'private UiObject2 findLabeledClickableWithin(');
  const collectScoped = methodBody(source, 'private void collectClickableAncestorsWithin(');
  const clickableScoped = methodBody(source, 'private UiObject2 clickableAncestorWithin(');
  const sameNode = methodBody(source, 'private boolean sameSemanticNode(');
  const sameNullable = methodBody(source, 'private static boolean sameNullable(');
  const exactLabel = methodBody(source, 'private static Pattern exactLabel(');
  const assertVisible = methodBody(source, 'private void assertVisibleBounds(');
  const hasVisible = methodBody(source, 'private boolean hasVisibleBounds(');

  return `package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.Build;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.uiautomator.Configurator;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

final class RuntimeExternalPlayerFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PLAYER_DIALOG_LABEL = "Playing Synthetic Fixture Movie (2026)";
    private static final String PLAYBACK_SETTINGS_LABEL = "Playback settings";
    private static final String PLAYBACK_ACTIONS_LABEL = "Playback actions";
    private static final long MEDIA_WAIT_MS = 60_000L;
    private static final int MAX_SETTINGS_TRANSACTION_TIMING_EVENTS = 64;
    private static final int MAX_SETTINGS_RAIL_OBSERVATIONS = 16;
    private static final int MAX_EXTERNAL_LEGAL_SNAPSHOT_FAILURE_DIAGNOSTICS = 8;
    private static final Pattern BINDING_TERMS = Pattern.compile(${bindingPatternLiteral(source)});

    private final FakeInstrumentation instrumentation = new FakeInstrumentation();
    private final UiDevice device = new UiDevice();
    private final List<String> settingsTransactionTimings = new ArrayList<>();
    private final List<String> settingsRailObservations = new ArrayList<>();
    private final List<String> externalLegalSnapshotFailureDiagnostics = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private int settingsTransactionTimingEventsOmitted;
    private int settingsRailObservationEventsOmitted;
    private int externalLegalSnapshotFailureDiagnosticsOmitted;
    private long settingsClickDispatchedAtMs = -1L;
    private long settingsClickFinishedAtMs = -1L;
    private long settingsClickIdleBeforeMs = -1L;
    private long settingsClickIdleAfterMs = -1L;
    private boolean settingsClickReturned;
    private int logCalls;
    private int revealAttempts;
    private int settingsAttempts;
    private int nextNode;
    private long revealedAtMs = -1L;
    private boolean enforceChromeExpiry = true;

    private void executeSettingsCallsite() { ${callsite} }
    private void openPlaybackSettingsTransaction() {${openTransaction}}
    private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction() {${observeTransaction}}
    private void assertNoOutOfScopeApprovalForSettingsTransaction() {${transactionGuard}}
    private String currentPackage() {${currentPackage}}
    private void recordSettingsTransactionTiming(
            String stage,
            long startedAtMs,
            long finishedAtMs,
            long idleBeforeMs,
            long idleAfterMs,
            boolean returned) {${recordTiming}}
    private void recordExternalLegalSnapshotFailureDiagnostics(
            Throwable failure) {${recordLegalFailureDiagnostics}}
    private void recordSettingsClickTiming(
            long dispatchedAtMs,
            long finishedAtMs,
            long idleBeforeMs,
            long idleAfterMs,
            boolean returned) {${recordClickTiming}}
    private void recordSettingsRailObservation(
            String state, int completedPanAttempts) {${recordRailObservation}}
    private UiObject2 findUniqueExactProductDialog(String label) {${findDialog}}
    private UiObject2 findUniquePlaybackActionsRailWithin(UiObject2 dialog) {${findRail}}
    private UiObject2 findLabeledClickableWithin(
            UiObject2 boundary, String label, String description) {${findScopedLabel}}
    private void collectClickableAncestorsWithin(
            List<UiObject2> candidates, List<UiObject2> matches, UiObject2 boundary) {${collectScoped}}
    private UiObject2 clickableAncestorWithin(UiObject2 object, UiObject2 boundary) {${clickableScoped}}
    private boolean sameSemanticNode(UiObject2 left, UiObject2 right) {${sameNode}}
    private static boolean sameNullable(Object left, Object right) {${sameNullable}}
    private static Pattern exactLabel(String label) {${exactLabel}}
    private void assertVisibleBounds(UiObject2 object, String description) {${assertVisible}}
    private boolean hasVisibleBounds(UiObject2 object) {${hasVisible}}

    private static String safe(String value) { return value == null ? "" : value; }

    private void log(String message) {
        requireZeroIdle("actual driver log");
        logCalls++;
    }

    private UiObject2 waitForRefreshedPlaybackSettings() {
        UiObject2 dialog = device.roots.get(0);
        if (dialog.children.isEmpty()) {
            dialog.click();
            addSettings(dialog, true, 0);
        }
        SystemClock.advance(3_250L);
        device.legacyMatcherRuns += 2;
        return dialog.children.get(0);
    }

    private void clickObservedControlImmediately(UiObject2 object, String description) {
        object.click();
    }

    private UiObject2 makeDialog(String packageName, boolean visible, boolean attachOnReveal) {
        UiObject2 dialog = new UiObject2(
                "dialog-" + nextNode++,
                "android.app.Dialog",
                packageName,
                PLAYER_DIALOG_LABEL,
                null,
                true,
                true,
                visible,
                new Rect(0, 0, 500, 500));
        dialog.onClick = () -> {
            revealAttempts++;
            revealedAtMs = SystemClock.uptimeMillis();
            if (attachOnReveal && dialog.children.isEmpty()) addSettings(dialog, true, 0);
        };
        return dialog;
    }

    private UiObject2 addSettings(UiObject2 parent, boolean visible, int offset) {
        UiObject2 button = new UiObject2(
                "settings-button-" + nextNode++,
                "android.widget.Button",
                PRODUCT_PACKAGE,
                null,
                null,
                true,
                true,
                visible,
                new Rect(10, 20 + offset, 300, 90 + offset));
        button.onClick = () -> {
            settingsAttempts++;
            if (enforceChromeExpiry && revealedAtMs >= 0L
                    && SystemClock.uptimeMillis() - revealedAtMs >= 3_200L) {
                throw new RuntimeException("Playback settings chrome expired");
            }
        };
        UiObject2 label = new UiObject2(
                "settings-label-" + nextNode++,
                "android.widget.TextView",
                PRODUCT_PACKAGE,
                PLAYBACK_SETTINGS_LABEL,
                null,
                false,
                true,
                visible,
                new Rect(20, 30 + offset, 280, 80 + offset));
        button.add(label);
        parent.add(button);
        return button;
    }

    private void installSafeLegalTree(long accessCostMs) {
        AccessibilityNodeInfo root = new AccessibilityNodeInfo("legal-root-" + nextNode++);
        root.accessCostMs = accessCostMs;
        installLegalRoot(root);
        instrumentation.automation.accessCostMs = accessCostMs;
    }

    private void installLegalRoot(AccessibilityNodeInfo root) {
        instrumentation.automation.activeRoot = root;
        List<AccessibilityWindowInfo> windows = new ArrayList<>();
        AccessibilityWindowInfo window = new AccessibilityWindowInfo(root);
        window.accessCostMs = root == null ? 0L : root.accessCostMs;
        windows.add(window);
        instrumentation.automation.windows.put(0, windows);
    }

    private void installBindingPhrase(String phrase, boolean description) {
        AccessibilityNodeInfo root = new AccessibilityNodeInfo("binding-root-" + nextNode++);
        if (description) root.description = phrase;
        else root.text = phrase;
        instrumentation.automation.activeRoot = root;
        List<AccessibilityWindowInfo> windows = new ArrayList<>();
        windows.add(new AccessibilityWindowInfo(root));
        instrumentation.automation.windows.put(0, windows);
    }

    private static void assertTrue(String message, boolean value) {
        if (!value) throw new AssertionError(message);
    }
    private static void fail(String message) { throw new AssertionError(message); }
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static void requireZeroIdle(String phase) {
        check(Configurator.getInstance().getWaitForIdleTimeout() == 0L,
                phase + " did not run with zero idle timeout");
    }
    private static Throwable expectFailure(Class<?> type, Runnable action, String label) {
        try { action.run(); }
        catch (Throwable failure) {
            check(type.isInstance(failure), label + " threw " + failure.getClass().getName());
            return failure;
        }
        throw new AssertionError(label + " did not fail");
    }

    private static RuntimeExternalPlayerFlowTest reset(long idleTimeout) {
        Build.VERSION.SDK_INT = 36;
        Configurator.reset(idleTimeout);
        SystemClock.reset(0L);
        RuntimeExternalPlayerFlowTest flow = new RuntimeExternalPlayerFlowTest();
        flow.installSafeLegalTree(35L);
        flow.device.currentPackage = PRODUCT_PACKAGE;
        return flow;
    }

    private static void actualOnePassGuardBeatsThePredecessorModel() {
        long original = 8_411L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, true);
        flow.device.roots.add(dialog);
        flow.device.queryCostMs = 120L;
        flow.executeSettingsCallsite();
        check(flow.instrumentation.automation.clearCalls == 2,
                "actual adapter did not delegate both cache refreshes");
        check(flow.instrumentation.automation.activeRootCalls == 4
                        && flow.instrumentation.automation.windowsCalls == 4,
                "actual adapter did not acquire a fresh root snapshot before every input");
        check(flow.device.currentPackageCalls == 4,
                "actual adapter did not preserve every foreground check");
        check(flow.device.legacyMatcherRuns == 0,
                "fresh legal guard reran ByMatcher watchers");
        check(flow.revealAttempts == 1 && flow.settingsAttempts == 1,
                "actual adapter input counts changed");
        check(flow.settingsClickDispatchedAtMs - flow.revealedAtMs < 3_200L,
                "one-pass legal guard missed the unchanged chrome timer");
        check(flow.settingsClickReturned,
                "actual adapter did not retain the settings click return timing");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "actual adapter did not restore the exact timeout");

        RuntimeExternalPlayerFlowTest predecessor = reset(original);
        UiObject2 predecessorDialog = predecessor.makeDialog(PRODUCT_PACKAGE, true, false);
        predecessor.device.roots.add(predecessorDialog);
        expectFailure(RuntimeException.class, () -> {
            UiObject2 settings = predecessor.waitForRefreshedPlaybackSettings();
            predecessor.clickObservedControlImmediately(settings, PLAYBACK_SETTINGS_LABEL);
        }, "predecessor matcher model");
        check(predecessor.device.legacyMatcherRuns == 2,
                "predecessor model did not include both unsuccessful matcher scans");
    }

    private static void legalAndForegroundFailuresPrecedeSelectionAndInput() {
        String[] forbidden = {
                "com.android.permissioncontroller",
                "com.google.android.permissioncontroller",
                "com.android.settings",
                "com.google.android.packageinstaller",
                "com.android.packageinstaller"
        };
        for (String packageName : forbidden) {
            RuntimeExternalPlayerFlowTest flow = reset(7_000L);
            UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
            flow.addSettings(dialog, true, 0);
            flow.device.roots.add(dialog);
            flow.device.currentPackage = packageName;
            expectFailure(AssertionError.class, flow::executeSettingsCallsite,
                    "forbidden package " + packageName);
            check(flow.device.selectionQueries == 0
                            && flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                    "forbidden package allowed query or click: " + packageName);
        }

        String[] phrases = {
                "terms of service", "license agreement", "user agreement", "binding terms"
        };
        for (String phrase : phrases) {
            for (boolean description : new boolean[] {false, true}) {
                RuntimeExternalPlayerFlowTest flow = reset(7_100L);
                UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
                flow.addSettings(dialog, true, 0);
                flow.device.roots.add(dialog);
                flow.installBindingPhrase(phrase, description);
                expectFailure(AssertionError.class, flow::executeSettingsCallsite,
                        "binding phrase " + phrase);
                check(flow.device.selectionQueries == 0
                                && flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                        "binding phrase allowed query or click: " + phrase);
            }
        }
    }

    private static void snapshotSafetyFailuresPrecedeSelectionAndInput() {
        RuntimeExternalPlayerFlowTest missingRoot = armedFlow(7_200L);
        missingRoot.instrumentation.automation.activeRoot = null;
        assertGuardFailureBeforeSelection(missingRoot, "missing active root");

        RuntimeExternalPlayerFlowTest error = armedFlow(7_201L);
        error.instrumentation.automation.activeRoot.failureOperation = "text";
        assertGuardFailureBeforeSelection(error, "unexpected snapshot error");

        RuntimeExternalPlayerFlowTest cycle = armedFlow(7_202L);
        AccessibilityNodeInfo cycleRoot = new AccessibilityNodeInfo("adapter-cycle");
        cycleRoot.children.add(cycleRoot);
        cycle.installLegalRoot(cycleRoot);
        assertGuardFailureBeforeSelection(cycle, "snapshot cycle");

        RuntimeExternalPlayerFlowTest oversized = armedFlow(7_203L);
        AccessibilityNodeInfo oversizedRoot = new AccessibilityNodeInfo("adapter-oversized");
        for (int index = 0; index < 4_096; index++) {
            oversizedRoot.children.add(new AccessibilityNodeInfo("adapter-child-" + index));
        }
        oversized.installLegalRoot(oversizedRoot);
        assertGuardFailureBeforeSelection(oversized, "snapshot size bound");

        RuntimeExternalPlayerFlowTest slow = armedFlow(7_204L);
        AccessibilityNodeInfo slowRoot = new AccessibilityNodeInfo("adapter-slow");
        slowRoot.accessCostMs = 260L;
        slow.installLegalRoot(slowRoot);
        assertGuardFailureBeforeSelection(slow, "snapshot time bound");
    }

    private static RuntimeExternalPlayerFlowTest armedFlow(long idleTimeout) {
        RuntimeExternalPlayerFlowTest flow = reset(idleTimeout);
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
        flow.addSettings(dialog, true, 0);
        flow.device.roots.add(dialog);
        return flow;
    }

    private static void assertGuardFailureBeforeSelection(
            RuntimeExternalPlayerFlowTest flow, String label) {
        Throwable failure = expectFailure(
                AssertionError.class, flow::executeSettingsCallsite, label);
        flow.recordExternalLegalSnapshotFailureDiagnostics(failure);
        check(flow.device.selectionQueries == 0
                        && flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                label + " allowed a selection query or click");
        check(flow.externalLegalSnapshotFailureDiagnostics.size() == 1
                        && flow.externalLegalSnapshotFailureDiagnosticsOmitted == 0,
                label + " did not retain one bounded legal diagnostic");
    }

    private static void duplicateScopeAndBoundsRemainFailClosed() {
        RuntimeExternalPlayerFlowTest duplicateDialogs = reset(8_422L);
        duplicateDialogs.device.roots.add(
                duplicateDialogs.makeDialog(PRODUCT_PACKAGE, true, false));
        duplicateDialogs.device.roots.add(
                duplicateDialogs.makeDialog(PRODUCT_PACKAGE, true, false));
        expectFailure(AssertionError.class, duplicateDialogs::executeSettingsCallsite,
                "duplicate dialogs");
        check(duplicateDialogs.revealAttempts == 0 && duplicateDialogs.settingsAttempts == 0,
                "duplicate dialogs allowed a click");

        RuntimeExternalPlayerFlowTest wrongPackage = reset(8_433L);
        wrongPackage.device.roots.add(
                wrongPackage.makeDialog("com.example.other", true, true));
        expectFailure(AssertionError.class, wrongPackage::executeSettingsCallsite,
                "dialog package scope");
        check(wrongPackage.revealAttempts == 0 && wrongPackage.settingsAttempts == 0,
                "wrong-package dialog allowed a click");

        RuntimeExternalPlayerFlowTest invisibleDialog = reset(8_444L);
        invisibleDialog.device.roots.add(
                invisibleDialog.makeDialog(PRODUCT_PACKAGE, false, true));
        expectFailure(AssertionError.class, invisibleDialog::executeSettingsCallsite,
                "invisible dialog");
        check(invisibleDialog.revealAttempts == 0 && invisibleDialog.settingsAttempts == 0,
                "invisible dialog allowed a click");

        RuntimeExternalPlayerFlowTest duplicateSettings = reset(8_455L);
        UiObject2 duplicateDialog = duplicateSettings.makeDialog(PRODUCT_PACKAGE, true, false);
        duplicateSettings.addSettings(duplicateDialog, true, 0);
        duplicateSettings.addSettings(duplicateDialog, true, 120);
        duplicateSettings.device.roots.add(duplicateDialog);
        expectFailure(AssertionError.class, duplicateSettings::executeSettingsCallsite,
                "duplicate settings");
        check(duplicateSettings.settingsAttempts == 0,
                "duplicate settings allowed a click");

        RuntimeExternalPlayerFlowTest settingsScope = reset(8_466L);
        UiObject2 scopedDialog = settingsScope.makeDialog(PRODUCT_PACKAGE, true, false);
        UiObject2 outside = new UiObject2(
                "outside-root", "android.view.View", PRODUCT_PACKAGE, null, null,
                false, true, true, new Rect(0, 0, 400, 400));
        settingsScope.addSettings(outside, true, 0);
        settingsScope.device.roots.add(scopedDialog);
        settingsScope.device.roots.add(outside);
        expectFailure(AssertionError.class, settingsScope::executeSettingsCallsite,
                "settings scope");
        check(settingsScope.settingsAttempts == 0,
                "out-of-dialog settings control was clicked");

        RuntimeExternalPlayerFlowTest bounds = reset(8_477L);
        UiObject2 boundsDialog = bounds.makeDialog(PRODUCT_PACKAGE, true, false);
        bounds.addSettings(boundsDialog, false, 0);
        bounds.device.roots.add(boundsDialog);
        expectFailure(AssertionError.class, bounds::executeSettingsCallsite,
                "settings bounds");
        check(bounds.settingsAttempts == 0,
                "invisible settings control was clicked");
    }

    private static void boundedDiagnosticsRetainTheFinalClickTiming() {
        RuntimeExternalPlayerFlowTest flow = reset(9_000L);
        flow.installSafeLegalTree(0L);
        flow.enforceChromeExpiry = false;
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
        flow.device.roots.add(dialog);
        flow.device.beforeGlobalQuery = () -> {
            if (flow.device.selectionQueries == 22 && dialog.children.isEmpty()) {
                flow.addSettings(dialog, true, 0);
            }
        };
        flow.executeSettingsCallsite();
        check(flow.settingsTransactionTimings.size() == 64,
                "diagnostic event cap changed");
        check(flow.settingsTransactionTimingEventsOmitted > 0,
                "diagnostic overflow was not counted");
        check(flow.settingsClickDispatchedAtMs >= 0L
                        && flow.settingsClickFinishedAtMs >= flow.settingsClickDispatchedAtMs
                        && flow.settingsClickReturned,
                "final actual click timing was lost after the poll cap");
    }

    private static void legalFailureDiagnosticsAreBoundedWithoutMaskingFailure() {
        RuntimeExternalPlayerFlowTest flow = armedFlow(9_100L);
        AccessibilityNodeInfo slowRoot = new AccessibilityNodeInfo("bounded-diagnostic-root");
        slowRoot.accessCostMs = 260L;
        flow.installLegalRoot(slowRoot);
        Throwable failure = expectFailure(
                AssertionError.class, flow::executeSettingsCallsite, "bounded diagnostic failure");
        String originalMessage = failure.getMessage();
        for (int index = 0; index < 9; index++) {
            flow.recordExternalLegalSnapshotFailureDiagnostics(failure);
        }
        check(flow.externalLegalSnapshotFailureDiagnostics.size() == 8
                        && flow.externalLegalSnapshotFailureDiagnosticsOmitted == 1,
                "legal failure diagnostic cap changed");
        check(originalMessage.equals(failure.getMessage()),
                "recording diagnostics masked the original failure");
        String diagnostics = flow.externalLegalSnapshotFailureDiagnostics.get(0);
        check(diagnostics.contains("currentPhase=traversal-")
                        && diagnostics.contains("maxPublicCallMs=260")
                        && diagnostics.length() < 500,
                "legal failure diagnostics were unbounded or incomplete");
    }

    static void runProbe() {
        actualOnePassGuardBeatsThePredecessorModel();
        legalAndForegroundFailuresPrecedeSelectionAndInput();
        snapshotSafetyFailuresPrecedeSelectionAndInput();
        duplicateScopeAndBoundsRemainFailClosed();
        boundedDiagnosticsRetainTheFinalClickTiming();
        legalFailureDiagnosticsAreBoundedWithoutMaskingFailure();
    }

    private static final class FakeInstrumentation {
        final UiAutomation automation = new UiAutomation();
        UiAutomation getUiAutomation() { return automation; }
    }

    private static final class UiDevice {
        final List<UiObject2> roots = new ArrayList<>();
        String currentPackage = PRODUCT_PACKAGE;
        long queryCostMs;
        int selectionQueries;
        int currentPackageCalls;
        int legacyMatcherRuns;
        Runnable beforeGlobalQuery = () -> {};
        List<UiObject2> findObjects(BySelector selector) {
            selectionQueries++;
            beforeGlobalQuery.run();
            SystemClock.advance(queryCostMs);
            List<UiObject2> found = new ArrayList<>();
            for (UiObject2 root : roots) root.collect(selector, found, true);
            return found;
        }
        String getCurrentPackageName() {
            currentPackageCalls++;
            return currentPackage;
        }
    }

    private static final class UiObject2 {
        final String resourceName;
        final String className;
        final String applicationPackage;
        final String text;
        final String contentDescription;
        final boolean clickable;
        final boolean enabled;
        final boolean visible;
        final Rect bounds;
        boolean scrollable;
        final List<UiObject2> children = new ArrayList<>();
        UiObject2 parent;
        Runnable onClick = () -> {};
        UiObject2(
                String resourceName,
                String className,
                String applicationPackage,
                String text,
                String contentDescription,
                boolean clickable,
                boolean enabled,
                boolean visible,
                Rect bounds) {
            this.resourceName = resourceName;
            this.className = className;
            this.applicationPackage = applicationPackage;
            this.text = text;
            this.contentDescription = contentDescription;
            this.clickable = clickable;
            this.enabled = enabled;
            this.visible = visible;
            this.bounds = bounds;
        }
        void add(UiObject2 child) { child.parent = this; children.add(child); }
        List<UiObject2> findObjects(BySelector selector) {
            List<UiObject2> found = new ArrayList<>();
            for (UiObject2 child : children) child.collect(selector, found, true);
            return found;
        }
        void collect(BySelector selector, List<UiObject2> found, boolean includeSelf) {
            if (includeSelf && selector.matches(this)) found.add(this);
            for (UiObject2 child : children) child.collect(selector, found, true);
        }
        void click() { onClick.run(); }
        void scroll(Direction direction, float fraction) {
            check(direction == Direction.RIGHT && fraction == 0.72f,
                    "unexpected Playback actions rail gesture");
            onClick.run();
        }
        boolean isClickable() { return clickable; }
        boolean isEnabled() { return enabled; }
        UiObject2 getParent() { return parent; }
        Rect getVisibleBounds() { return visible ? bounds : new Rect(0, 0, 0, 0); }
        String getResourceName() { return resourceName; }
        String getClassName() { return className; }
        String getApplicationPackage() { return applicationPackage; }
        String getText() { return text; }
        String getContentDescription() { return contentDescription; }
    }

    private static final class By {
        static BySelector clazz(String value) { return new BySelector().clazz(value); }
        static BySelector text(Pattern value) { return new BySelector().text(value); }
        static BySelector desc(Pattern value) { return new BySelector().desc(value); }
    }

    private static final class BySelector {
        String clazz;
        String pkg;
        Pattern text;
        Pattern desc;
        Boolean scrollable;
        BySelector clazz(String value) { clazz = value; return this; }
        BySelector pkg(String value) { pkg = value; return this; }
        BySelector text(Pattern value) { text = value; return this; }
        BySelector desc(Pattern value) { desc = value; return this; }
        BySelector scrollable(boolean value) { scrollable = value; return this; }
        boolean matches(UiObject2 object) {
            return (clazz == null || clazz.equals(object.className))
                    && (pkg == null || pkg.equals(object.applicationPackage))
                    && (text == null || object.text != null && text.matcher(object.text).matches())
                    && (desc == null || object.contentDescription != null
                            && desc.matcher(object.contentDescription).matches())
                    && (scrollable == null || scrollable == object.scrollable);
        }
    }

    private enum Direction { RIGHT }

    private static final class Rect {
        final int left;
        final int top;
        final int right;
        final int bottom;
        Rect(int left, int top, int right, int bottom) {
            this.left = left; this.top = top; this.right = right; this.bottom = bottom;
        }
        int width() { return right - left; }
        int height() { return bottom - top; }
        @Override public boolean equals(Object other) {
            if (!(other instanceof Rect)) return false;
            Rect rect = (Rect) other;
            return left == rect.left && top == rect.top
                    && right == rect.right && bottom == rect.bottom;
        }
        @Override public int hashCode() { return Objects.hash(left, top, right, bottom); }
    }
}
`;
}

const adapterHarnessSource = `package com.yawf.runtimeinstrumentation;
public final class RuntimeExternalSettingsDriverAdapterHarness {
    public static void main(String[] args) {
        RuntimeExternalPlayerFlowTest.runProbe();
        System.out.println("ADAPTER_OK");
    }
}
`;

function executeDriverAdapter(source, helperSource = helper, legalSource = legal) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-settings-adapter-'));
  try {
    const sources = [
      writeSource(root, 'android/os/Build.java', buildStub),
      ...androidAccessibilityStubs(root),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransaction.java',
        helperSource,
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalLegalSnapshot.java',
        legalSource,
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java',
        driverAdapterSource(source),
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsDriverAdapterHarness.java',
        adapterHarnessSource,
      ),
    ];
    return javaCommands(
      root,
      sources,
      'com.yawf.runtimeinstrumentation.RuntimeExternalSettingsDriverAdapterHarness',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('actual transaction helper keeps zero-idle ordering, bounded input, timings, and exact restoration', () => {
  assert.deepEqual(validateHelperShape(helper), []);
  const result = executeTransaction(helper);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^OK checks=\d+\s*$/);
});

test('actual fresh legal helper preserves full scope and the 1s bound on a 97-node cold model', () => {
  assert.deepEqual(validateLegalShape(legal), []);
  const result = executeLegal(legal);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^LEGAL_OK checks=\d+\s*$/);
});

test('actual driver adapter uses the real helpers and keeps selection, package, timing, and input gates', () => {
  assert.deepEqual(validateIntegration(driver, helper, legal), []);
  const result = executeDriverAdapter(driver);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^ADAPTER_OK\s*$/);
});

test('executable actual callsite rejects the predecessor split matcher and click path', () => {
  const bypassed = replaceUnique(
    driver,
    '        openPlaybackSettingsTransaction();',
    '        UiObject2 playbackSettings = waitForRefreshedPlaybackSettings();\n'
      + '        clickObservedControlImmediately(playbackSettings, PLAYBACK_SETTINGS_LABEL);',
  );
  const result = executeDriverAdapter(bypassed);
  assert.notEqual(result.status, 0, `predecessor callsite unexpectedly passed\n${result.stdout}`);
});

for (const [name, mutate] of [
  [
    'plain window-root fetch mutation',
    source => replaceUnique(
      source,
      'window.getRoot(PREFETCHING_STRATEGY)',
      'window.getRoot()',
    ),
  ],
  [
    'plain child fetch mutation',
    source => replaceUnique(
      source,
      'node.getChild(childIndex, PREFETCHING_STRATEGY)',
      'node.getChild(childIndex)',
    ),
  ],
  [
    'plain root-and-child cold predecessor',
    source => replaceUnique(
      replaceUnique(
        source,
        'window.getRoot(PREFETCHING_STRATEGY)',
        'window.getRoot()',
      ),
      'node.getChild(childIndex, PREFETCHING_STRATEGY)',
      'node.getChild(childIndex)',
    ),
  ],
  [
    'same-window root-fetch elision',
    source => replaceUnique(
      source,
      'root = window.getRoot(PREFETCHING_STRATEGY);',
      'root = window.getId() == activeRoot.getWindowId()\n'
        + '                            ? activeRoot\n'
        + '                            : window.getRoot(PREFETCHING_STRATEGY);',
    ),
  ],
  [
    'AssertionError diagnostics omission',
    source => replaceUnique(
      source,
      '            attachDiagnostics(failure, diagnostics);\n',
      '',
    ),
  ],
  [
    'window diagnostic counter omission',
    source => replaceUnique(source, '                diagnostics.windowCount++;\n', ''),
  ],
  [
    'visible text omission',
    source => replaceUnique(
      source,
      'if (matches(bindingTerms, text)) {',
      'if (false && matches(bindingTerms, text)) {',
    ),
  ],
  [
    'visible content-description omission',
    source => replaceUnique(
      source,
      'if (matches(bindingTerms, description)) {',
      'if (false && matches(bindingTerms, description)) {',
    ),
  ],
  [
    'visibility omission',
    source => replaceUnique(source, 'if (!visible) {', 'if (false) {'),
  ],
  [
    'all-window scope omission',
    source => replaceUnique(
      source,
      'displayIndex < windowsByDisplay.size()',
      'displayIndex < 0',
    ),
  ],
  [
    'missing-active-root safety removal',
    source => replaceUnique(
      source,
      'if (activeRoot == null) {\n            throw new AssertionError("The fresh legal snapshot active root was missing");\n        }',
      'if (activeRoot == null) {\n            return roots;\n        }',
    ),
  ],
  [
    'cycle safety removal',
    source => replaceUnique(
      source,
      'throw new AssertionError("The fresh legal snapshot graph was cyclic");',
      'continue;',
    ),
  ],
  [
    'node bound safety removal',
    source => replaceUnique(source, 'if (size > MAX_NODES) {', 'if (false) {'),
  ],
  [
    'time bound safety removal',
    source => replaceUnique(
      source,
      'if (elapsedMs < 0 || elapsedMs > MAX_TRAVERSAL_MS) {',
      'if (false) {',
    ),
  ],
  [
    'unexpected-error fail-closed conversion removal',
    source => replaceUnique(
      source,
      '} catch (RuntimeException failure) {\n'
        + '            diagnostics.finish();\n'
        + '            AssertionError converted = new AssertionError(\n'
        + '                    "The fresh legal snapshot could not be verified: "\n'
        + '                            + failure.getClass().getSimpleName());\n'
        + '            attachDiagnostics(converted, diagnostics);\n'
        + '            throw converted;\n'
        + '        }',
      '} catch (RuntimeException failure) {\n            throw failure;\n        }',
    ),
  ],
]) {
  test(`executable legal helper rejects ${name}`, () => {
    const mutated = mutate(legal);
    const result = executeLegal(mutated);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed\n${result.stdout}`);
  });
}

for (const [name, mutate] of [
  [
    'omitted zero-idle override',
    source => replaceUnique(
      source,
      '            configurator.setWaitForIdleTimeout(TRANSACTION_IDLE_TIMEOUT_MS);\n',
      '',
    ),
  ],
  [
    'ignored cache failure',
    source => replaceUnique(source, 'if (!cacheCleared) {', 'if (false) {'),
  ],
  [
    'omitted finally restoration',
    source => replaceUnique(
      source,
      '        } finally {\n            configurator.setWaitForIdleTimeout(previousIdleTimeoutMs);\n        }',
      '        } catch (RuntimeException failure) {\n            throw failure;\n        }',
    ),
  ],
  [
    'restored the wrong timeout',
    source => replaceUnique(
      source,
      'configurator.setWaitForIdleTimeout(previousIdleTimeoutMs);',
      'configurator.setWaitForIdleTimeout(TRANSACTION_IDLE_TIMEOUT_MS);',
    ),
  ],
  [
    'removed the API guard',
    source => replaceUnique(
      source,
      'if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE)',
      'if (false)',
    ),
  ],
  [
    'repeated the conditional reveal',
    source => replaceUnique(
      source,
      'revealVisible && !revealTapPerformed',
      'revealVisible',
    ),
  ],
  [
    'duplicated the settings click',
    source => replaceUnique(
      source,
      '                        observation.settingsTarget.click();\n',
      '                        observation.settingsTarget.click();\n'
        + '                        observation.settingsTarget.click();\n',
    ),
  ],
  [
    'fresh guard timing omission',
    source => replaceUnique(
      source,
      '            environment.recordTiming(\n                    stage,',
      '            if (false) environment.recordTiming(\n                    stage,',
    ),
  ],
  [
    'final actual click timing omission',
    source => replaceUnique(
      source,
      '                        environment.recordSettingsClickTiming(',
      '                        if (false) environment.recordSettingsClickTiming(',
    ),
  ],
]) {
  test(`executable transaction helper rejects ${name}`, () => {
    const mutated = mutate(helper);
    const result = executeTransaction(mutated);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed\n${result.stdout}`);
  });
}

for (const [name, mutate] of [
  [
    'actual helper callsite bypass',
    source => replaceUnique(
      source,
      '        openPlaybackSettingsTransaction();',
      '        waitForLabeledClickable(PLAYBACK_SETTINGS_LABEL, MEDIA_WAIT_MS, PLAYBACK_SETTINGS_LABEL).click();',
    ),
  ],
  [
    'fresh transaction legal guard bypass',
    source => replaceUnique(
      source,
      '                        RuntimeExternalPlayerFlowTest.this\n                                .assertNoOutOfScopeApprovalForSettingsTransaction();',
      '                        return;',
    ),
  ],
  [
    'forbidden foreground package removal',
    source => replaceUniqueInMethod(
      source,
      'private void assertNoOutOfScopeApprovalForSettingsTransaction()',
      '                || foreground.equals("com.android.settings")',
      '',
    ),
  ],
  [
    'product dialog package scope removal',
    source => replaceUnique(
      source,
      'By.clazz("android.app.Dialog")\n                        .pkg(PRODUCT_PACKAGE)\n                        .text(exactLabel(label))',
      'By.clazz("android.app.Dialog")\n                        .text(exactLabel(label))',
    ),
  ],
  [
    'duplicate dialog admission',
    source => replaceUnique(source, 'if (dialogs.size() > 1)', 'if (dialogs.size() > 2)'),
  ],
  [
    'settings visible-bounds admission removal',
    source => replaceUnique(
      source,
      'if (settings != null && hasVisibleBounds(settings)) {\n            assertVisibleBounds(settings, PLAYBACK_SETTINGS_LABEL);',
      'if (settings != null) {',
    ),
  ],
  [
    'dialog-scoped label bypass',
    source => replaceUnique(
      source,
      'candidates, boundary.findObjects(By.text(labelPattern)), boundary',
      'candidates, device.findObjects(By.text(labelPattern)), boundary',
    ),
  ],
  [
    'bounded diagnostic cap removal',
    source => replaceUnique(
      source,
      'if (settingsTransactionTimings.size() >= MAX_SETTINGS_TRANSACTION_TIMING_EVENTS) {',
      'if (false) {',
    ),
  ],
  [
    'dedicated final click timing storage omission',
    source => replaceUnique(
      source,
      '        settingsClickDispatchedAtMs = dispatchedAtMs;',
      '        return;',
    ),
  ],
  [
    'legal failure diagnostic recorder omission',
    source => replaceUnique(
      source,
      '        String diagnostics = RuntimeExternalLegalSnapshot.failureDiagnostics(failure);',
      '        String diagnostics = null;',
    ),
  ],
  [
    'legal failure diagnostic cap removal',
    source => replaceUnique(
      source,
      'if (externalLegalSnapshotFailureDiagnostics.size()\n'
        + '                >= MAX_EXTERNAL_LEGAL_SNAPSHOT_FAILURE_DIAGNOSTICS) {',
      'if (false) {',
    ),
  ],
]) {
  test(`executable actual adapter rejects ${name}`, () => {
    const mutated = mutate(driver);
    const result = executeDriverAdapter(mutated);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed\n${result.stdout}`);
  });
}

for (const [name, mutate] of [
  [
    'actual callsite bypass',
    source => replaceUnique(
      source,
      '        openPlaybackSettingsTransaction();',
      '        waitForLabeledClickable(PLAYBACK_SETTINGS_LABEL, MEDIA_WAIT_MS, PLAYBACK_SETTINGS_LABEL).click();',
    ),
  ],
  [
    'ordinary guard substituted into settings transaction',
    source => replaceUnique(
      source,
      '.assertNoOutOfScopeApprovalForSettingsTransaction();',
      '.assertNoOutOfScopeApproval();',
    ),
  ],
  [
    'product dialog scope removal',
    source => replaceUnique(
      source,
      'By.clazz("android.app.Dialog")\n                        .pkg(PRODUCT_PACKAGE)\n                        .text(exactLabel(label))',
      'By.clazz("android.app.Dialog")\n                        .text(exactLabel(label))',
    ),
  ],
  [
    'duplicate dialog admission',
    source => replaceUnique(source, 'if (dialogs.size() > 1)', 'if (dialogs.size() > 2)'),
  ],
  [
    'settings bounds omission',
    source => replaceUnique(
      source,
      'if (settings != null && hasVisibleBounds(settings))',
      'if (settings != null)',
    ),
  ],
  [
    'dialog-scoped label bypass',
    source => replaceUnique(
      source,
      'candidates, boundary.findObjects(By.text(labelPattern)), boundary',
      'candidates, device.findObjects(By.text(labelPattern)), boundary',
    ),
  ],
  [
    'final click timing receipt omission',
    source => replaceUnique(
      source,
      '            receipt.put("settingsClickTiming", settingsClickTiming);',
      '            receipt.put("settingsClickTiming", JSONObject.NULL);',
    ),
  ],
  [
    'legal failure diagnostic catch omission',
    source => replaceUnique(
      source,
      '                recordExternalLegalSnapshotFailureDiagnostics(caught);',
      '                return;',
    ),
  ],
  [
    'legal failure diagnostic receipt omission',
    source => replaceUnique(
      source,
      '                "externalLegalSnapshotFailureDiagnostics",\n'
        + '                new JSONArray(externalLegalSnapshotFailureDiagnostics));',
      '                "externalLegalSnapshotFailureDiagnostics", JSONObject.NULL);',
    ),
  ],
]) {
  test(`integration guard scan rejects ${name}`, () => {
    const mutated = mutate(driver);
    assert.notDeepEqual(validateIntegration(mutated, helper, legal), []);
  });
}
