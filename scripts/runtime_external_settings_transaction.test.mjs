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
const driverPath = new URL(
  './android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java',
  import.meta.url,
);
const helper = readFileSync(helperPath, 'utf8');
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

function validateIntegration(source, helperSource) {
  const failures = [];
  const runFlow = methodBody(source, 'private void runFlow()');
  const transaction = methodBody(source, 'private void openPlaybackSettingsTransaction()');
  const observation = methodBody(
    source,
    'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()',
  );
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
    'RuntimeExternalSettingsTransaction.open(',
    'return instrumentation.getUiAutomation().clearCache();',
    'RuntimeExternalPlayerFlowTest.this.assertNoOutOfScopeApproval();',
    'return observePlaybackSettingsTransaction();',
    'RuntimeExternalPlayerFlowTest.this.log(message);',
    'MEDIA_WAIT_MS',
  ];
  for (const fragment of requiredTransactionFragments) {
    if (!transaction.includes(fragment)) {
      failures.push(`transaction callsite lost: ${fragment}`);
    }
  }

  const requiredObservationFragments = [
    'findUniqueExactProductDialog(PLAYER_DIALOG_LABEL)',
    'playerDialog == null || !hasVisibleBounds(playerDialog)',
    'findLabeledClickableWithin(',
    'playerDialog, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL',
    'settings != null && hasVisibleBounds(settings)',
    'assertVisibleBounds(settings, PLAYBACK_SETTINGS_LABEL)',
    'Observation.settings(settings::click)',
    'assertVisibleBounds(playerDialog, "playing movie dialog")',
    'Observation.reveal(playerDialog::click)',
  ];
  for (const fragment of requiredObservationFragments) {
    if (!observation.includes(fragment)) {
      failures.push(`transaction observation lost: ${fragment}`);
    }
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
  if (/Open player|openPlayerClicks|resolveExternalDestination|EXTERNAL_PLAYER_LABEL/.test(helperSource)) {
    failures.push('settings helper gained external-handoff authority');
  }
  return failures;
}

function validateHelperShape(source) {
  const failures = [];
  const body = methodBody(source, 'static void open(Environment environment, long timeoutMs)');
  const zero = body.indexOf('configurator.setWaitForIdleTimeout(TRANSACTION_IDLE_TIMEOUT_MS)');
  const api = body.indexOf('Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
  const cache = body.indexOf('environment.clearAccessibilityCache()');
  const guard = body.indexOf('environment.assertNoOutOfScopeApproval()');
  const observe = body.indexOf('environment.observePlaybackSettings()');
  const settingsClick = body.indexOf('observation.settingsTarget.click()');
  const revealClick = body.indexOf('observation.revealTarget.click()');
  const restore = body.indexOf('configurator.setWaitForIdleTimeout(previousIdleTimeoutMs)');
  if (!(zero >= 0 && zero < api && api < cache && cache < guard && guard < observe)) {
    failures.push('API/cache/guard/acquire sequence is not zero-idle and fail-closed');
  }
  if (!(observe < settingsClick && observe < revealClick)) {
    failures.push('helper clicks before the fresh semantic observation');
  }
  if ((body.match(/observation\.settingsTarget\.click\(\)/g) ?? []).length !== 1
      || (body.match(/observation\.revealTarget\.click\(\)/g) ?? []).length !== 1
      || !/observation\.revealTarget != null && !revealTapPerformed/.test(body)) {
    failures.push('helper does not cap settings and conditional reveal input to one each');
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

const harnessSource = `package com.yawf.runtimeinstrumentation;

import android.os.Build;
import android.os.SystemClock;
import androidx.test.uiautomator.Configurator;

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
        int settingsAttempts;
        int logs;
        boolean cacheResult = true;

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
    }

    private static void chromeExpiryRegressionAndSuccessRestore() {
        long original = 7_311L;
        reset(36, original);
        CountingEnvironment environment = new CountingEnvironment() {
            @Override
            public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                requireZeroIdle("fresh observation");
                observeCalls++;
                long implicitIdle = Configurator.getInstance().getWaitForIdleTimeout();
                if (implicitIdle > 0L) SystemClock.advance(implicitIdle);
                return RuntimeExternalSettingsTransaction.Observation.settings(() -> {
                    settingsAttempts++;
                    if (SystemClock.uptimeMillis() >= 3_200L) {
                        throw new RuntimeException("player chrome expired during implicit idle");
                    }
                });
            }
        };
        RuntimeExternalSettingsTransaction.open(environment, 60_000L);
        check(environment.clearCalls == 1, "success cache refresh count changed");
        check(environment.guardCalls == 1, "success guard count changed");
        check(environment.observeCalls == 1, "success observation count changed");
        check(environment.settingsAttempts == 1, "success settings click count changed");
        check(environment.revealAttempts == 0, "success unexpectedly revealed controls");
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
        RuntimeExternalSettingsTransaction.open(environment, 60_000L);
        check(environment.revealAttempts == 1, "reveal was not single-use");
        check(environment.settingsAttempts == 1, "settings was not single-use");
        check(environment.clearCalls == 4 && environment.guardCalls == 4
                        && environment.observeCalls == 4,
                "each retry did not repeat cache, guard, and fresh acquisition");
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

function executeHelper(source) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-settings-'));
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
        harnessSource,
      ),
    ];
    const classes = join(root, 'classes');
    mkdirSync(classes);
    const javac = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', 'javac')
      : 'javac';
    const java = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', 'java')
      : 'java';
    const compiled = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, ...sources], {
      encoding: 'utf8',
    });
    if (compiled.status !== 0) return compiled;
    return spawnSync(java, ['-cp', classes, 'com.yawf.runtimeinstrumentation.RuntimeExternalSettingsTransactionHarness'], {
      encoding: 'utf8',
    });
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

function adapterProbeSource(source) {
  const callsite = settingsCallsiteBlock(source);
  const openTransaction = methodBody(source, 'private void openPlaybackSettingsTransaction()');
  const observeTransaction = methodBody(
    source,
    'private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction()',
  );
  const findDialog = methodBody(source, 'private UiObject2 findUniqueExactProductDialog(String label)');
  const findScopedLabel = methodBody(source, 'private UiObject2 findLabeledClickableWithin(');
  const collectScoped = methodBody(source, 'private void collectClickableAncestorsWithin(');
  const clickableScoped = methodBody(source, 'private UiObject2 clickableAncestorWithin(');
  const sameNode = methodBody(source, 'private boolean sameSemanticNode(');
  const sameNullable = methodBody(source, 'private static boolean sameNullable(');
  const exactLabel = methodBody(source, 'private static Pattern exactLabel(');
  const assertVisible = methodBody(source, 'private void assertVisibleBounds(');
  const hasVisible = methodBody(source, 'private boolean hasVisibleBounds(');

  return `package com.yawf.runtimeinstrumentation;

import android.os.Build;
import android.os.SystemClock;
import androidx.test.uiautomator.Configurator;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

final class RuntimeExternalPlayerFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PLAYER_DIALOG_LABEL = "Playing Synthetic Fixture Movie (2026)";
    private static final String PLAYBACK_SETTINGS_LABEL = "Playback settings";
    private static final long MEDIA_WAIT_MS = 60_000L;

    private final FakeInstrumentation instrumentation = new FakeInstrumentation();
    private final UiDevice device = new UiDevice();
    private int guardCalls;
    private int logCalls;
    private int revealAttempts;
    private int settingsAttempts;
    private int nextNode;

    private void executeSettingsCallsite() {
        ${callsite}
    }

    private void openPlaybackSettingsTransaction() {${openTransaction}}

    private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction() {${observeTransaction}}

    private UiObject2 findUniqueExactProductDialog(String label) {${findDialog}}

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

    private void assertNoOutOfScopeApproval() {
        requireZeroIdle("actual driver policy guard");
        guardCalls++;
    }

    private void log(String message) {
        requireZeroIdle("actual driver log");
        logCalls++;
    }

    private UiObject2 waitForRefreshedPlaybackSettings() {
        UiObject2 dialog = device.roots.get(0);
        if (dialog.children.isEmpty()) addSettings(dialog, true, 0);
        UiObject2 settings = dialog.children.get(0);
        long implicitIdle = Configurator.getInstance().getWaitForIdleTimeout();
        if (implicitIdle > 0L) SystemClock.advance(implicitIdle);
        return settings;
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
            if (SystemClock.uptimeMillis() >= 3_200L) {
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

    private static void assertTrue(String message, boolean value) {
        if (!value) throw new AssertionError(message);
    }

    private static void fail(String message) {
        throw new AssertionError(message);
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void requireZeroIdle(String phase) {
        check(Configurator.getInstance().getWaitForIdleTimeout() == 0L,
                phase + " did not run with zero idle timeout");
    }

    private static Throwable expectFailure(Class<?> type, Runnable action, String label) {
        try {
            action.run();
        } catch (Throwable failure) {
            check(type.isInstance(failure), label + " threw " + failure.getClass().getName());
            return failure;
        }
        throw new AssertionError(label + " did not fail");
    }

    private static RuntimeExternalPlayerFlowTest reset(long idleTimeout) {
        Build.VERSION.SDK_INT = 36;
        Configurator.reset(idleTimeout);
        SystemClock.reset(0L);
        return new RuntimeExternalPlayerFlowTest();
    }

    private static void normalAdapterUsesActualHelper() {
        long original = 8_411L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        flow.device.roots.add(flow.makeDialog(PRODUCT_PACKAGE, true, true));
        flow.executeSettingsCallsite();
        check(flow.instrumentation.automation.clearCalls == 2,
                "actual adapter did not delegate both cache refreshes");
        check(flow.guardCalls == 2, "actual adapter did not delegate both guards");
        check(flow.revealAttempts == 1, "actual adapter reveal count changed");
        check(flow.settingsAttempts == 1, "actual adapter settings count changed");
        check(flow.logCalls == 2, "actual adapter log count changed");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "actual adapter did not restore the exact timeout");
    }

    private static void duplicateDialogsFailClosed() {
        long original = 8_422L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        flow.device.roots.add(flow.makeDialog(PRODUCT_PACKAGE, true, false));
        flow.device.roots.add(flow.makeDialog(PRODUCT_PACKAGE, true, false));
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "duplicate dialogs");
        check(flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                "duplicate dialogs allowed a click");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "duplicate dialog failure did not restore idle timeout");
    }

    private static void dialogPackageScopeFailsClosed() {
        long original = 8_433L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        flow.device.roots.add(flow.makeDialog("com.example.other", true, true));
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "dialog package scope");
        check(flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                "wrong-package dialog allowed a click");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "scope failure did not restore idle timeout");
    }

    private static void invisibleDialogFailsClosed() {
        long original = 8_444L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        flow.device.roots.add(flow.makeDialog(PRODUCT_PACKAGE, false, true));
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "invisible dialog");
        check(flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                "invisible dialog allowed a click");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "invisible dialog failure did not restore idle timeout");
    }

    private static void duplicateSettingsFailClosed() {
        long original = 8_455L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
        flow.addSettings(dialog, true, 0);
        flow.addSettings(dialog, true, 120);
        flow.device.roots.add(dialog);
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "duplicate settings");
        check(flow.revealAttempts == 0 && flow.settingsAttempts == 0,
                "duplicate settings allowed a click");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "duplicate settings failure did not restore idle timeout");
    }

    private static void settingsScopeFailsClosed() {
        long original = 8_466L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
        UiObject2 outside = new UiObject2(
                "outside-root", "android.view.View", PRODUCT_PACKAGE, null, null,
                false, true, true, new Rect(0, 0, 400, 400));
        flow.addSettings(outside, true, 0);
        flow.device.roots.add(dialog);
        flow.device.roots.add(outside);
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "settings scope");
        check(flow.settingsAttempts == 0, "out-of-dialog settings control was clicked");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "settings scope failure did not restore idle timeout");
    }

    private static void settingsBoundsFailClosed() {
        long original = 8_477L;
        RuntimeExternalPlayerFlowTest flow = reset(original);
        UiObject2 dialog = flow.makeDialog(PRODUCT_PACKAGE, true, false);
        flow.addSettings(dialog, false, 0);
        flow.device.roots.add(dialog);
        expectFailure(AssertionError.class, flow::executeSettingsCallsite, "settings bounds");
        check(flow.settingsAttempts == 0, "invisible settings control was clicked");
        check(Configurator.getInstance().getWaitForIdleTimeout() == original,
                "settings bounds failure did not restore idle timeout");
    }

    static void runProbe() {
        normalAdapterUsesActualHelper();
        duplicateDialogsFailClosed();
        dialogPackageScopeFailsClosed();
        invisibleDialogFailsClosed();
        duplicateSettingsFailClosed();
        settingsScopeFailsClosed();
        settingsBoundsFailClosed();
    }

    private static final class FakeInstrumentation {
        final FakeUiAutomation automation = new FakeUiAutomation();
        FakeUiAutomation getUiAutomation() { return automation; }
    }

    private static final class FakeUiAutomation {
        int clearCalls;
        boolean clearCache() {
            requireZeroIdle("actual adapter cache refresh");
            clearCalls++;
            return true;
        }
    }

    private static final class UiDevice {
        final List<UiObject2> roots = new ArrayList<>();
        List<UiObject2> findObjects(BySelector selector) {
            List<UiObject2> found = new ArrayList<>();
            for (UiObject2 root : roots) root.collect(selector, found, true);
            return found;
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

        void add(UiObject2 child) {
            child.parent = this;
            children.add(child);
        }

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
        BySelector clazz(String value) { clazz = value; return this; }
        BySelector pkg(String value) { pkg = value; return this; }
        BySelector text(Pattern value) { text = value; return this; }
        BySelector desc(Pattern value) { desc = value; return this; }
        boolean matches(UiObject2 object) {
            return (clazz == null || clazz.equals(object.className))
                    && (pkg == null || pkg.equals(object.applicationPackage))
                    && (text == null || object.text != null && text.matcher(object.text).matches())
                    && (desc == null || object.contentDescription != null
                            && desc.matcher(object.contentDescription).matches());
        }
    }

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

function executeDriverAdapter(source, helperSource = helper) {
  const root = mkdtempSync(join(tmpdir(), 'yawf-external-settings-adapter-'));
  try {
    const sources = [
      writeSource(root, 'android/os/Build.java', buildStub),
      writeSource(root, 'android/os/SystemClock.java', clockStub),
      writeSource(root, 'androidx/test/uiautomator/Configurator.java', configuratorStub),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsTransaction.java',
        helperSource,
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalPlayerFlowTest.java',
        adapterProbeSource(source),
      ),
      writeSource(
        root,
        'com/yawf/runtimeinstrumentation/RuntimeExternalSettingsDriverAdapterHarness.java',
        adapterHarnessSource,
      ),
    ];
    const classes = join(root, 'classes');
    mkdirSync(classes);
    const javac = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', 'javac')
      : 'javac';
    const java = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, 'bin', 'java')
      : 'java';
    const compiled = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, ...sources], {
      encoding: 'utf8',
    });
    if (compiled.status !== 0) return compiled;
    return spawnSync(
      java,
      ['-cp', classes, 'com.yawf.runtimeinstrumentation.RuntimeExternalSettingsDriverAdapterHarness'],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('actual helper survives expiring chrome and restores nondefault idle state on every exit', () => {
  assert.deepEqual(validateHelperShape(helper), []);
  const result = executeHelper(helper);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^OK checks=\d+\s*$/);
});

test('actual driver callsite retains fresh guards, exact scope, bounds, and separate handoff authority', () => {
  assert.deepEqual(validateIntegration(driver, helper), []);
  const result = executeDriverAdapter(driver);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^ADAPTER_OK\s*$/);
});

test('executable actual callsite rejects the predecessor split acquire and click path', () => {
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
]) {
  test(`executable actual adapter rejects ${name}`, () => {
    const mutated = mutate(driver);
    const result = executeDriverAdapter(mutated);
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
    source => replaceUnique(
      source,
      '                if (!environment.clearAccessibilityCache()) {\n                    throw new AssertionError("Accessibility cache refresh failed");\n                }',
      '                environment.clearAccessibilityCache();\n                if (false) {\n                    throw new AssertionError("Accessibility cache refresh failed");\n                }',
    ),
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
      'observation.revealTarget != null && !revealTapPerformed',
      'observation.revealTarget != null',
    ),
  ],
  [
    'duplicated the settings click',
    source => replaceUnique(
      source,
      '                    observation.settingsTarget.click();\n',
      '                    observation.settingsTarget.click();\n                    observation.settingsTarget.click();\n',
    ),
  ],
]) {
  test(`executable helper rejects ${name}`, () => {
    const mutated = mutate(helper);
    assert.notEqual(mutated, helper);
    const result = executeHelper(mutated);
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
]) {
  test(`integration guard scan rejects ${name}`, () => {
    const mutated = mutate(driver);
    assert.notEqual(mutated, driver);
    assert.notDeepEqual(validateIntegration(mutated, helper), []);
  });
}
