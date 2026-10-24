package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.Build;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** One fresh, bounded accessibility traversal for the external settings legal guard. */
final class RuntimeExternalLegalSnapshot {
    private static final int MAX_NODES = 4_096;
    private static final long MAX_TRAVERSAL_MS = 1_000L;
    private static final int ROOT_PREFETCH_FLAGS =
            AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_BREADTH_FIRST
                    | AccessibilityNodeInfo.FLAG_PREFETCH_UNINTERRUPTIBLE;
    private static final int CHILD_PREFETCH_FLAGS =
            ROOT_PREFETCH_FLAGS | AccessibilityNodeInfo.FLAG_PREFETCH_SIBLINGS;

    static final class Diagnostics {
        private final long totalDurationMs;
        private final long activeRootDurationMs;
        private final int activeRootCompletedOperations;
        private final long windowEnumerationDurationMs;
        private final int windowEnumerationCompletedOperations;
        private final long windowRootsDurationMs;
        private final int windowRootsCompletedOperations;
        private final long childRetrievalDurationMs;
        private final int childRetrievalCompletedOperations;
        private final String lastOperation;
        private final long lastOperationDurationMs;
        private final boolean lastOperationCompleted;
        private final int visitedNodes;
        private final boolean traversalComplete;

        private Diagnostics(State state, boolean traversalComplete) {
            totalDurationMs = SystemClock.uptimeMillis() - state.startedAtMs;
            activeRootDurationMs = state.activeRootDurationMs;
            activeRootCompletedOperations = state.activeRootCompletedOperations;
            windowEnumerationDurationMs = state.windowEnumerationDurationMs;
            windowEnumerationCompletedOperations = state.windowEnumerationCompletedOperations;
            windowRootsDurationMs = state.windowRootsDurationMs;
            windowRootsCompletedOperations = state.windowRootsCompletedOperations;
            childRetrievalDurationMs = state.childRetrievalDurationMs;
            childRetrievalCompletedOperations = state.childRetrievalCompletedOperations;
            lastOperation = state.lastOperation;
            lastOperationDurationMs = state.lastOperationDurationMs;
            lastOperationCompleted = state.lastOperationCompleted;
            visitedNodes = state.visitedNodes;
            this.traversalComplete = traversalComplete;
        }

        long totalDurationMs() { return totalDurationMs; }
        long activeRootDurationMs() { return activeRootDurationMs; }
        int activeRootCompletedOperations() { return activeRootCompletedOperations; }
        long windowEnumerationDurationMs() { return windowEnumerationDurationMs; }
        int windowEnumerationCompletedOperations() {
            return windowEnumerationCompletedOperations;
        }
        long windowRootsDurationMs() { return windowRootsDurationMs; }
        int windowRootsCompletedOperations() { return windowRootsCompletedOperations; }
        long childRetrievalDurationMs() { return childRetrievalDurationMs; }
        int childRetrievalCompletedOperations() { return childRetrievalCompletedOperations; }
        String lastOperation() { return lastOperation; }
        long lastOperationDurationMs() { return lastOperationDurationMs; }
        boolean lastOperationCompleted() { return lastOperationCompleted; }
        int visitedNodes() { return visitedNodes; }
        boolean traversalComplete() { return traversalComplete; }
    }

    static final class Failure extends AssertionError {
        private final Diagnostics diagnostics;

        private Failure(String message, Diagnostics diagnostics) {
            super(message);
            this.diagnostics = diagnostics;
        }

        Diagnostics diagnostics() { return diagnostics; }
    }

    private enum Stage {
        ACTIVE_ROOT,
        WINDOW_ENUMERATION,
        WINDOW_ROOT,
        CHILD_RETRIEVAL,
        OTHER
    }

    private interface Operation<T> {
        T run();
    }

    private static final class State {
        private final long startedAtMs;
        private long activeRootDurationMs;
        private int activeRootCompletedOperations;
        private long windowEnumerationDurationMs;
        private int windowEnumerationCompletedOperations;
        private long windowRootsDurationMs;
        private int windowRootsCompletedOperations;
        private long childRetrievalDurationMs;
        private int childRetrievalCompletedOperations;
        private String lastOperation = "none";
        private long lastOperationDurationMs;
        private boolean lastOperationCompleted;
        private int visitedNodes;

        private State(long startedAtMs) {
            this.startedAtMs = startedAtMs;
        }

        private Failure failure(String message) {
            return new Failure(message, new Diagnostics(this, false));
        }
    }

    private RuntimeExternalLegalSnapshot() {}

    static void assertNoBindingTermsVisible(UiAutomation automation, Pattern bindingTerms) {
        if (automation == null || bindingTerms == null) {
            throw new AssertionError("The fresh legal snapshot inputs were missing");
        }

        State state = new State(SystemClock.uptimeMillis());
        try {
            Set<AccessibilityNodeInfo> roots = freshRoots(automation, state);
            ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
            Set<AccessibilityNodeInfo> visited = new HashSet<>();
            for (AccessibilityNodeInfo root : roots) {
                if (!visited.add(root)) {
                    throw state.failure("The fresh legal snapshot roots were cyclic");
                }
                state.visitedNodes = visited.size();
                enforceSizeBound(state, visited.size());
                pending.addLast(root);
            }

            while (!pending.isEmpty()) {
                enforceTimeBound(state);
                AccessibilityNodeInfo node = pending.removeFirst();
                boolean visible = perform(
                        state, "node-visible", Stage.OTHER, () -> node.isVisibleToUser());
                enforceTimeBound(state);
                if (!visible) {
                    continue;
                }

                CharSequence text = perform(
                        state, "node-text", Stage.OTHER, () -> node.getText());
                enforceTimeBound(state);
                if (matches(bindingTerms, text)) {
                    throw state.failure(
                            "Refusing to act while a binding legal phrase is visible");
                }
                CharSequence description = perform(
                        state,
                        "node-content-description",
                        Stage.OTHER,
                        () -> node.getContentDescription());
                enforceTimeBound(state);
                if (matches(bindingTerms, description)) {
                    throw state.failure(
                            "Refusing to act while a binding legal phrase is visible");
                }

                int childCount = perform(
                        state, "node-child-count", Stage.OTHER, () -> node.getChildCount());
                enforceTimeBound(state);
                if (childCount < 0 || childCount > MAX_NODES) {
                    throw state.failure("The fresh legal snapshot child count was invalid");
                }
                for (int childIndex = 0; childIndex < childCount; childIndex++) {
                    enforceTimeBound(state);
                    int currentChildIndex = childIndex;
                    AccessibilityNodeInfo child = perform(
                            state,
                            "child-retrieval",
                            Stage.CHILD_RETRIEVAL,
                            () -> freshChild(node, currentChildIndex));
                    enforceTimeBound(state);
                    if (child == null) {
                        throw state.failure(
                                "The fresh legal snapshot contained a missing child");
                    }
                    if (!visited.add(child)) {
                        throw state.failure("The fresh legal snapshot graph was cyclic");
                    }
                    state.visitedNodes = visited.size();
                    enforceSizeBound(state, visited.size());
                    pending.addLast(child);
                }
            }
            enforceTimeBound(state);
        } catch (Failure failure) {
            throw failure;
        } catch (RuntimeException failure) {
            throw state.failure(
                    "The fresh legal snapshot could not be verified: "
                            + failure.getClass().getSimpleName());
        }
    }

    private static Set<AccessibilityNodeInfo> freshRoots(
            UiAutomation automation, State state) {
        Set<AccessibilityNodeInfo> roots = new LinkedHashSet<>();
        AccessibilityNodeInfo activeRoot = perform(
                state,
                "active-root",
                Stage.ACTIVE_ROOT,
                () -> automation.getRootInActiveWindow());
        enforceTimeBound(state);
        if (activeRoot == null) {
            throw state.failure("The fresh legal snapshot active root was missing");
        }

        SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay = perform(
                state,
                "window-enumeration",
                Stage.WINDOW_ENUMERATION,
                () -> automation.getWindowsOnAllDisplays());
        enforceTimeBound(state);
        if (windowsByDisplay == null || windowsByDisplay.size() == 0) {
            throw state.failure("The fresh legal snapshot window list was missing");
        }
        for (int displayIndex = 0; displayIndex < windowsByDisplay.size(); displayIndex++) {
            List<AccessibilityWindowInfo> windows = windowsByDisplay.valueAt(displayIndex);
            if (windows == null || windows.isEmpty()) {
                throw state.failure("A fresh legal snapshot display had no windows");
            }
            for (AccessibilityWindowInfo window : windows) {
                enforceTimeBound(state);
                if (window == null) {
                    throw state.failure(
                            "The fresh legal snapshot contained a missing window");
                }
                AccessibilityNodeInfo root = perform(
                        state,
                        "window-root",
                        Stage.WINDOW_ROOT,
                        () -> freshWindowRoot(window));
                enforceTimeBound(state);
                if (root == null) {
                    throw state.failure("A fresh legal snapshot window root was missing");
                }
                roots.add(root);
                enforceSizeBound(state, roots.size());
            }
        }
        roots.add(activeRoot);
        enforceSizeBound(state, roots.size());
        if (roots.isEmpty()) {
            throw state.failure("The fresh legal snapshot had no roots");
        }
        return roots;
    }

    private static AccessibilityNodeInfo freshWindowRoot(AccessibilityWindowInfo window) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return window.getRoot(ROOT_PREFETCH_FLAGS);
        }
        return window.getRoot();
    }

    private static AccessibilityNodeInfo freshChild(
            AccessibilityNodeInfo node, int childIndex) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return node.getChild(childIndex, CHILD_PREFETCH_FLAGS);
        }
        return node.getChild(childIndex);
    }

    private static boolean matches(Pattern bindingTerms, CharSequence value) {
        return value != null && bindingTerms.matcher(value).matches();
    }

    private static <T> T perform(
            State state, String operation, Stage stage, Operation<T> action) {
        long operationStartedAtMs = SystemClock.uptimeMillis();
        state.lastOperation = operation;
        state.lastOperationDurationMs = 0L;
        state.lastOperationCompleted = false;
        try {
            T result = action.run();
            state.lastOperationCompleted = true;
            incrementCompletedOperations(state, stage);
            return result;
        } finally {
            long durationMs = SystemClock.uptimeMillis() - operationStartedAtMs;
            state.lastOperationDurationMs = durationMs;
            addDuration(state, stage, durationMs);
        }
    }

    private static void incrementCompletedOperations(State state, Stage stage) {
        switch (stage) {
            case ACTIVE_ROOT:
                state.activeRootCompletedOperations++;
                break;
            case WINDOW_ENUMERATION:
                state.windowEnumerationCompletedOperations++;
                break;
            case WINDOW_ROOT:
                state.windowRootsCompletedOperations++;
                break;
            case CHILD_RETRIEVAL:
                state.childRetrievalCompletedOperations++;
                break;
            case OTHER:
                break;
        }
    }

    private static void addDuration(State state, Stage stage, long durationMs) {
        switch (stage) {
            case ACTIVE_ROOT:
                state.activeRootDurationMs += durationMs;
                break;
            case WINDOW_ENUMERATION:
                state.windowEnumerationDurationMs += durationMs;
                break;
            case WINDOW_ROOT:
                state.windowRootsDurationMs += durationMs;
                break;
            case CHILD_RETRIEVAL:
                state.childRetrievalDurationMs += durationMs;
                break;
            case OTHER:
                break;
        }
    }

    private static void enforceSizeBound(State state, int size) {
        if (size > MAX_NODES) {
            throw state.failure("The fresh legal snapshot exceeded its node bound");
        }
    }

    private static void enforceTimeBound(State state) {
        long elapsedMs = SystemClock.uptimeMillis() - state.startedAtMs;
        if (elapsedMs < 0 || elapsedMs > MAX_TRAVERSAL_MS) {
            throw state.failure("The fresh legal snapshot exceeded its time bound");
        }
    }
}
