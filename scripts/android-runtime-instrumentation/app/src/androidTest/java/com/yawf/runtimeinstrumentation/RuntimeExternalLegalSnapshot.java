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

    private RuntimeExternalLegalSnapshot() {}

    static void assertNoBindingTermsVisible(UiAutomation automation, Pattern bindingTerms) {
        if (automation == null || bindingTerms == null) {
            throw new AssertionError("The fresh legal snapshot inputs were missing");
        }

        long startedAtMs = SystemClock.uptimeMillis();
        try {
            Set<AccessibilityNodeInfo> roots = freshRoots(automation, startedAtMs);
            ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
            Set<AccessibilityNodeInfo> visited = new HashSet<>();
            for (AccessibilityNodeInfo root : roots) {
                if (!visited.add(root)) {
                    throw new AssertionError("The fresh legal snapshot roots were cyclic");
                }
                enforceSizeBound(visited.size());
                pending.addLast(root);
            }

            while (!pending.isEmpty()) {
                enforceTimeBound(startedAtMs);
                AccessibilityNodeInfo node = pending.removeFirst();
                boolean visible = node.isVisibleToUser();
                enforceTimeBound(startedAtMs);
                if (!visible) {
                    continue;
                }

                CharSequence text = node.getText();
                enforceTimeBound(startedAtMs);
                if (matches(bindingTerms, text)) {
                    throw new AssertionError(
                            "Refusing to act while a binding legal phrase is visible");
                }
                CharSequence description = node.getContentDescription();
                enforceTimeBound(startedAtMs);
                if (matches(bindingTerms, description)) {
                    throw new AssertionError(
                            "Refusing to act while a binding legal phrase is visible");
                }

                int childCount = node.getChildCount();
                enforceTimeBound(startedAtMs);
                if (childCount < 0 || childCount > MAX_NODES) {
                    throw new AssertionError("The fresh legal snapshot child count was invalid");
                }
                for (int childIndex = 0; childIndex < childCount; childIndex++) {
                    enforceTimeBound(startedAtMs);
                    AccessibilityNodeInfo child = freshChild(node, childIndex);
                    enforceTimeBound(startedAtMs);
                    if (child == null) {
                        throw new AssertionError("The fresh legal snapshot contained a missing child");
                    }
                    if (!visited.add(child)) {
                        throw new AssertionError("The fresh legal snapshot graph was cyclic");
                    }
                    enforceSizeBound(visited.size());
                    pending.addLast(child);
                }
            }
            enforceTimeBound(startedAtMs);
        } catch (AssertionError failure) {
            throw failure;
        } catch (RuntimeException failure) {
            throw new AssertionError(
                    "The fresh legal snapshot could not be verified: "
                            + failure.getClass().getSimpleName());
        }
    }

    private static Set<AccessibilityNodeInfo> freshRoots(
            UiAutomation automation, long startedAtMs) {
        Set<AccessibilityNodeInfo> roots = new LinkedHashSet<>();
        AccessibilityNodeInfo activeRoot = automation.getRootInActiveWindow();
        enforceTimeBound(startedAtMs);
        if (activeRoot == null) {
            throw new AssertionError("The fresh legal snapshot active root was missing");
        }

        SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay =
                automation.getWindowsOnAllDisplays();
        enforceTimeBound(startedAtMs);
        if (windowsByDisplay == null || windowsByDisplay.size() == 0) {
            throw new AssertionError("The fresh legal snapshot window list was missing");
        }
        for (int displayIndex = 0; displayIndex < windowsByDisplay.size(); displayIndex++) {
            List<AccessibilityWindowInfo> windows = windowsByDisplay.valueAt(displayIndex);
            if (windows == null || windows.isEmpty()) {
                throw new AssertionError("A fresh legal snapshot display had no windows");
            }
            for (AccessibilityWindowInfo window : windows) {
                enforceTimeBound(startedAtMs);
                if (window == null) {
                    throw new AssertionError("The fresh legal snapshot contained a missing window");
                }
                AccessibilityNodeInfo root = freshWindowRoot(window);
                enforceTimeBound(startedAtMs);
                if (root == null) {
                    throw new AssertionError("A fresh legal snapshot window root was missing");
                }
                roots.add(root);
                enforceSizeBound(roots.size());
            }
        }
        roots.add(activeRoot);
        enforceSizeBound(roots.size());
        if (roots.isEmpty()) {
            throw new AssertionError("The fresh legal snapshot had no roots");
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
}
