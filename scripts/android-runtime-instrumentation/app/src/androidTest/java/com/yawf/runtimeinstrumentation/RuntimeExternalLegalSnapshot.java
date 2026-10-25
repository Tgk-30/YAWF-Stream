package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** One fresh, bounded accessibility traversal for the external settings legal guard. */
final class RuntimeExternalLegalSnapshot {
    private static final int MAX_NODES = 4_096;
    private static final long MAX_TRAVERSAL_MS = 1_000L;
    private static final int PREFETCHING_STRATEGY =
            AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST;

    private RuntimeExternalLegalSnapshot() {}

    static void assertNoBindingTermsVisible(UiAutomation automation, Pattern bindingTerms) {
        long startedAtMs = SystemClock.uptimeMillis();
        Diagnostics diagnostics = new Diagnostics(startedAtMs);
        try {
            if (automation == null || bindingTerms == null) {
                throw new AssertionError("The fresh legal snapshot inputs were missing");
            }

            Set<AccessibilityNodeInfo> roots = freshRoots(
                    automation, startedAtMs, diagnostics);
            diagnostics.startTraversal();
            ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
            Set<AccessibilityNodeInfo> visited = new HashSet<>();
            for (AccessibilityNodeInfo root : roots) {
                if (!visited.add(root)) {
                    throw new AssertionError("The fresh legal snapshot roots were cyclic");
                }
                diagnostics.visitedNodes = visited.size();
                enforceSizeBound(visited.size());
                pending.addLast(root);
            }

            while (!pending.isEmpty()) {
                enforceTimeBound(startedAtMs);
                AccessibilityNodeInfo node = pending.removeFirst();

                long callStartedAtMs = diagnostics.beginPublicCall("traversal-visible");
                boolean visible;
                try {
                    visible = node.isVisibleToUser();
                } finally {
                    diagnostics.finishPublicCall(callStartedAtMs);
                }
                enforceTimeBound(startedAtMs);
                if (!visible) {
                    diagnostics.skippedNodes++;
                    continue;
                }
                diagnostics.visibleNodes++;

                callStartedAtMs = diagnostics.beginPublicCall("traversal-text");
                CharSequence text;
                try {
                    text = node.getText();
                } finally {
                    diagnostics.finishPublicCall(callStartedAtMs);
                }
                enforceTimeBound(startedAtMs);
                if (matches(bindingTerms, text)) {
                    throw new AssertionError(
                            "Refusing to act while a binding legal phrase is visible");
                }

                callStartedAtMs = diagnostics.beginPublicCall("traversal-description");
                CharSequence description;
                try {
                    description = node.getContentDescription();
                } finally {
                    diagnostics.finishPublicCall(callStartedAtMs);
                }
                enforceTimeBound(startedAtMs);
                if (matches(bindingTerms, description)) {
                    throw new AssertionError(
                            "Refusing to act while a binding legal phrase is visible");
                }

                callStartedAtMs = diagnostics.beginPublicCall("traversal-child-count");
                int childCount;
                try {
                    childCount = node.getChildCount();
                } finally {
                    diagnostics.finishPublicCall(callStartedAtMs);
                }
                enforceTimeBound(startedAtMs);
                if (childCount < 0 || childCount > MAX_NODES) {
                    throw new AssertionError("The fresh legal snapshot child count was invalid");
                }
                for (int childIndex = 0; childIndex < childCount; childIndex++) {
                    enforceTimeBound(startedAtMs);
                    diagnostics.childFetches++;
                    callStartedAtMs = diagnostics.beginPublicCall("traversal-child-fetch");
                    AccessibilityNodeInfo child;
                    try {
                        child = node.getChild(childIndex, PREFETCHING_STRATEGY);
                    } finally {
                        diagnostics.finishPublicCall(callStartedAtMs);
                    }
                    enforceTimeBound(startedAtMs);
                    if (child == null) {
                        throw new AssertionError(
                                "The fresh legal snapshot contained a missing child");
                    }
                    if (!visited.add(child)) {
                        throw new AssertionError("The fresh legal snapshot graph was cyclic");
                    }
                    diagnostics.visitedNodes = visited.size();
                    enforceSizeBound(visited.size());
                    pending.addLast(child);
                }
            }
            enforceTimeBound(startedAtMs);
            diagnostics.currentPhase = "complete";
        } catch (AssertionError failure) {
            diagnostics.finish();
            attachDiagnostics(failure, diagnostics);
            throw failure;
        } catch (RuntimeException failure) {
            diagnostics.finish();
            AssertionError converted = new AssertionError(
                    "The fresh legal snapshot could not be verified: "
                            + failure.getClass().getSimpleName());
            attachDiagnostics(converted, diagnostics);
            throw converted;
        } finally {
            diagnostics.finish();
        }
    }

    static String failureDiagnostics(Throwable failure) {
        if (failure == null) return null;
        for (Throwable suppressed : failure.getSuppressed()) {
            if (suppressed instanceof DiagnosticsAttachment) {
                return ((DiagnosticsAttachment) suppressed).summary;
            }
        }
        return null;
    }

    private static Set<AccessibilityNodeInfo> freshRoots(
            UiAutomation automation, long startedAtMs, Diagnostics diagnostics) {
        Set<AccessibilityNodeInfo> roots = new LinkedHashSet<>();
        long callStartedAtMs = diagnostics.beginPublicCall("active-root");
        AccessibilityNodeInfo activeRoot;
        try {
            activeRoot = automation.getRootInActiveWindow();
        } finally {
            diagnostics.finishActiveRootCall(callStartedAtMs);
        }
        enforceTimeBound(startedAtMs);
        if (activeRoot == null) {
            throw new AssertionError("The fresh legal snapshot active root was missing");
        }
        roots.add(activeRoot);
        diagnostics.rootCount = roots.size();

        callStartedAtMs = diagnostics.beginPublicCall("window-inventory");
        SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay;
        try {
            windowsByDisplay = automation.getWindowsOnAllDisplays();
        } finally {
            diagnostics.finishInventoryCall(callStartedAtMs);
        }
        enforceTimeBound(startedAtMs);
        if (windowsByDisplay == null || windowsByDisplay.size() == 0) {
            throw new AssertionError("The fresh legal snapshot window list was missing");
        }
        diagnostics.displayCount = windowsByDisplay.size();
        for (int displayIndex = 0; displayIndex < windowsByDisplay.size(); displayIndex++) {
            List<AccessibilityWindowInfo> windows = windowsByDisplay.valueAt(displayIndex);
            if (windows == null || windows.isEmpty()) {
                throw new AssertionError("A fresh legal snapshot display had no windows");
            }
            for (AccessibilityWindowInfo window : windows) {
                diagnostics.windowCount++;
                enforceTimeBound(startedAtMs);
                if (window == null) {
                    throw new AssertionError("The fresh legal snapshot contained a missing window");
                }

                callStartedAtMs = diagnostics.beginPublicCall("window-root");
                AccessibilityNodeInfo root;
                try {
                    root = window.getRoot(PREFETCHING_STRATEGY);
                } finally {
                    diagnostics.finishWindowRootCall(callStartedAtMs);
                }
                enforceTimeBound(startedAtMs);
                if (root == null) {
                    throw new AssertionError("A fresh legal snapshot window root was missing");
                }
                roots.add(root);
                diagnostics.rootCount = roots.size();
                enforceSizeBound(roots.size());
            }
        }
        if (roots.isEmpty()) {
            throw new AssertionError("The fresh legal snapshot had no roots");
        }
        return roots;
    }

    private static void attachDiagnostics(AssertionError failure, Diagnostics diagnostics) {
        failure.addSuppressed(new DiagnosticsAttachment(diagnostics.receiptSummary()));
    }

    private static boolean matches(Pattern bindingTerms, CharSequence value) {
        return value != null && bindingTerms.matcher(value).matches();
    }

    private static void enforceSizeBound(int size) {
        if (size > MAX_NODES) {
            throw new AssertionError("The fresh legal snapshot exceeded its node bound");
        }
    }

    private static void enforceTimeBound(long startedAtMs) {
        long elapsedMs = SystemClock.uptimeMillis() - startedAtMs;
        if (elapsedMs < 0 || elapsedMs > MAX_TRAVERSAL_MS) {
            throw new AssertionError("The fresh legal snapshot exceeded its time bound");
        }
    }

    private static final class Diagnostics {
        private final long startedAtMs;
        private long finishedAtMs;
        private long traversalStartedAtMs = -1L;
        private long activeRootMs;
        private long inventoryMs;
        private long windowRootMs;
        private long maxPublicCallMs;
        private String currentPhase = "inputs";
        private int displayCount;
        private int windowCount;
        private int rootCount;
        private int visitedNodes;
        private int visibleNodes;
        private int skippedNodes;
        private int childFetches;
        private boolean finished;

        Diagnostics(long startedAtMs) {
            this.startedAtMs = startedAtMs;
            this.finishedAtMs = startedAtMs;
        }

        long beginPublicCall(String phase) {
            currentPhase = phase;
            return SystemClock.uptimeMillis();
        }

        void finishPublicCall(long callStartedAtMs) {
            recordPublicCall(callStartedAtMs, SystemClock.uptimeMillis());
        }

        void finishActiveRootCall(long callStartedAtMs) {
            long callFinishedAtMs = SystemClock.uptimeMillis();
            activeRootMs += callFinishedAtMs - callStartedAtMs;
            recordPublicCall(callStartedAtMs, callFinishedAtMs);
        }

        void finishInventoryCall(long callStartedAtMs) {
            long callFinishedAtMs = SystemClock.uptimeMillis();
            inventoryMs += callFinishedAtMs - callStartedAtMs;
            recordPublicCall(callStartedAtMs, callFinishedAtMs);
        }

        void finishWindowRootCall(long callStartedAtMs) {
            long callFinishedAtMs = SystemClock.uptimeMillis();
            windowRootMs += callFinishedAtMs - callStartedAtMs;
            recordPublicCall(callStartedAtMs, callFinishedAtMs);
        }

        void startTraversal() {
            traversalStartedAtMs = SystemClock.uptimeMillis();
            currentPhase = "traversal";
        }

        void finish() {
            if (finished) return;
            finishedAtMs = SystemClock.uptimeMillis();
            finished = true;
        }

        String receiptSummary() {
            long traversalMs = traversalStartedAtMs < 0L
                    ? 0L
                    : finishedAtMs - traversalStartedAtMs;
            return String.format(
                    Locale.ROOT,
                    "currentPhase=%s totalMs=%d activeRootMs=%d inventoryMs=%d "
                            + "windowRootMs=%d traversalMs=%d maxPublicCallMs=%d "
                            + "displays=%d windows=%d roots=%d visited=%d visible=%d "
                            + "skipped=%d childFetches=%d",
                    currentPhase,
                    finishedAtMs - startedAtMs,
                    activeRootMs,
                    inventoryMs,
                    windowRootMs,
                    traversalMs,
                    maxPublicCallMs,
                    displayCount,
                    windowCount,
                    rootCount,
                    visitedNodes,
                    visibleNodes,
                    skippedNodes,
                    childFetches);
        }

        private void recordPublicCall(long callStartedAtMs, long callFinishedAtMs) {
            long elapsedMs = callFinishedAtMs - callStartedAtMs;
            if (elapsedMs > maxPublicCallMs) maxPublicCallMs = elapsedMs;
        }
    }

    private static final class DiagnosticsAttachment extends Throwable {
        final String summary;

        DiagnosticsAttachment(String summary) {
            super("Fresh legal snapshot diagnostics", null, false, false);
            this.summary = summary;
        }
    }
}
