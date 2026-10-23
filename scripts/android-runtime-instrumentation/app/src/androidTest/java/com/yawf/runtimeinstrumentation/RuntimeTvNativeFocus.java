package com.yawf.runtimeinstrumentation;

import java.util.List;

/** Selects one product-scoped native focus snapshot and its bounded D-pad direction. */
final class RuntimeTvNativeFocus {
    static final String SETTINGS_LIST_RESOURCE =
            "com.yawf.stream.tv:id/exo_settings_listview";
    static final String SETTINGS_LIST_CLASS = "androidx.recyclerview.widget.RecyclerView";
    private static final String PRODUCT_PACKAGE = "com.yawf.stream.tv";

    private RuntimeTvNativeFocus() { }

    static PopupObservationTransaction beginSettingsPopupTransaction(
            boolean targetPresent,
            boolean activationFocused,
            ScopeKind activationScope) {
        if (!targetPresent
                || !activationFocused
                || activationScope != ScopeKind.PLAYER_VIEW) {
            throw new AssertionError(
                    "Settings popup transaction requires a focused admitted PlayerView target");
        }
        return new PopupObservationTransaction();
    }

    static Ownership selectOwnership(
            String foregroundPackage,
            List<TargetNode> targets,
            List<ScopeNode> admittedPlayerRoots,
            List<ScopeNode> settingsLists,
            List<ScopeNode> targetAncestors,
            PopupObservationTransaction popupTransaction) {
        if (!PRODUCT_PACKAGE.equals(foregroundPackage)) {
            throw new AssertionError("TV product was not the foreground package");
        }
        requireList(targets, "Native focus target snapshots were missing");
        requireList(admittedPlayerRoots, "Admitted native PlayerView snapshots were missing");
        requireList(settingsLists, "Media3 settings-list snapshots were missing");
        requireList(targetAncestors, "Target ownership ancestor snapshots were missing");

        if (admittedPlayerRoots.size() > 1) {
            throw new AssertionError(
                    "Multiple admitted native PlayerView roots appeared: "
                            + admittedPlayerRoots.size());
        }
        for (ScopeNode playerRoot : admittedPlayerRoots) {
            validateScope(playerRoot, ScopeKind.PLAYER_VIEW);
        }

        if (settingsLists.size() > 1) {
            throw new AssertionError(
                    "Multiple visible product Media3 settings lists appeared: "
                            + settingsLists.size());
        }
        for (ScopeNode settingsList : settingsLists) {
            validateScope(settingsList, ScopeKind.SETTINGS_LIST);
        }

        boolean popupOwned = popupTransaction != null && popupTransaction.isActive();
        if (targets.isEmpty()) {
            if (popupOwned) {
                if (settingsLists.size() != 1) {
                    throw new AssertionError(
                            "Owned settings popup was not the unique current observation root");
                }
            } else {
                requireUniquePlayerRoot(admittedPlayerRoots);
                if (!settingsLists.isEmpty()) {
                    throw new AssertionError(
                            "Settings popup appeared without an owned activation transition");
                }
            }
            return Ownership.missingTarget();
        }
        if (targets.size() != 1) {
            throw new AssertionError(
                    "Expected exactly one visible exact product target, found " + targets.size());
        }
        TargetNode target = targets.get(0);
        if (!PRODUCT_PACKAGE.equals(target.packageName)) {
            throw new AssertionError("Native focus target had the wrong package");
        }
        if (!target.enabled) {
            throw new AssertionError("Native focus target was disabled");
        }
        if (target.bounds == null || target.bounds.isEmpty()) {
            throw new AssertionError("Native focus target had empty bounds");
        }

        if (targetAncestors.size() != 1) {
            throw new AssertionError(
                    "Expected one bounded native ownership ancestor, found "
                            + targetAncestors.size());
        }
        ScopeNode owner = targetAncestors.get(0);
        validateScope(owner, owner.kind);
        if (owner.kind == ScopeKind.PLAYER_VIEW) {
            if (popupOwned) {
                throw new AssertionError(
                        "Owned popup transaction cannot observe a main-control target");
            }
            ScopeNode playerRoot = requireUniquePlayerRoot(admittedPlayerRoots);
            if (!settingsLists.isEmpty()) {
                throw new AssertionError(
                        "A main-control target was selected while a settings popup was visible");
            }
            if (!sameScope(owner, playerRoot)) {
                throw new AssertionError(
                        "Main-control target did not belong to the admitted PlayerView");
            }
        } else if (owner.kind == ScopeKind.SETTINGS_LIST) {
            if (!popupOwned) {
                throw new AssertionError(
                        "Settings popup appeared without an owned activation transition");
            }
            if (settingsLists.size() != 1 || !sameScope(owner, settingsLists.get(0))) {
                throw new AssertionError(
                        "Popup target did not belong to the unique visible Media3 settings list");
            }
        } else {
            throw new AssertionError("Unsupported native focus ownership scope");
        }
        return Ownership.present(owner.kind, 0, 0);
    }

    static Selection selectFocused(
            Ownership ownership,
            List<FocusedNode> focusedDescendants) {
        if (ownership == null || !ownership.targetPresent) {
            throw new AssertionError("Cannot select focus without a target-owned scope");
        }
        requireList(focusedDescendants, "Focused native descendant snapshots were missing");
        if (focusedDescendants.size() > 1) {
            throw new AssertionError(
                    "Multiple focused target-scope descendants appeared: "
                            + focusedDescendants.size());
        }
        if (focusedDescendants.isEmpty()) return Selection.none();

        FocusedNode focused = focusedDescendants.get(0);
        if (focused.scopeKind != ownership.scopeKind) {
            throw new AssertionError("Focused native node was outside the target-owned scope");
        }
        validateFocused(focused);
        return Selection.present(focused.bounds);
    }

    static Selection select(
            int admittedRootCount,
            String rootPackage,
            List<FocusedNode> focusedDescendants) {
        if (admittedRootCount != 1) {
            throw new AssertionError(
                    "Expected exactly one admitted native PlayerView root, found "
                            + admittedRootCount);
        }
        if (!PRODUCT_PACKAGE.equals(rootPackage)) {
            throw new AssertionError("Admitted native PlayerView root had the wrong package");
        }
        requireList(focusedDescendants, "Focused native descendant snapshots were missing");
        if (focusedDescendants.size() > 1) {
            throw new AssertionError(
                    "Multiple focused native PlayerView descendants appeared: "
                            + focusedDescendants.size());
        }
        if (focusedDescendants.isEmpty()) return Selection.none();

        FocusedNode focused = focusedDescendants.get(0);
        if (focused.scopeKind != ScopeKind.PLAYER_VIEW) {
            throw new AssertionError("PlayerView focus snapshot had the wrong scope");
        }
        validateFocused(focused);
        return Selection.present(focused.bounds);
    }

    static Direction direction(Bounds target, Bounds current) {
        if (target == null || target.isEmpty()) {
            throw new AssertionError("Native focus target had empty bounds");
        }
        if (current == null || current.isEmpty()) {
            throw new AssertionError("Current native focus had empty bounds");
        }
        long horizontal = target.centerX() - current.centerX();
        long vertical = target.centerY() - current.centerY();
        if (Math.abs(vertical) >= Math.abs(horizontal)) {
            return vertical >= 0 ? Direction.DOWN : Direction.UP;
        }
        return horizontal >= 0 ? Direction.RIGHT : Direction.LEFT;
    }

    private static void validateScope(ScopeNode scope, ScopeKind expectedKind) {
        if (scope == null || scope.kind != expectedKind) {
            throw new AssertionError("Native ownership scope had the wrong kind");
        }
        if (!PRODUCT_PACKAGE.equals(scope.packageName)) {
            throw new AssertionError("Native ownership scope had the wrong package");
        }
        if (!scope.enabled) {
            throw new AssertionError("Native ownership scope was disabled");
        }
        if (scope.bounds == null || scope.bounds.isEmpty()) {
            throw new AssertionError("Native ownership scope had empty bounds");
        }
        if (expectedKind == ScopeKind.SETTINGS_LIST
                && !SETTINGS_LIST_RESOURCE.equals(scope.resourceName)) {
            throw new AssertionError("Settings popup had the wrong ownership resource");
        }
        if (expectedKind == ScopeKind.SETTINGS_LIST
                && !SETTINGS_LIST_CLASS.equals(scope.className)) {
            throw new AssertionError("Settings popup had the wrong native widget class");
        }
    }

    private static void validateFocused(FocusedNode focused) {
        if (!PRODUCT_PACKAGE.equals(focused.packageName)) {
            throw new AssertionError("Focused native descendant had the wrong package");
        }
        if (focused.bounds == null || focused.bounds.isEmpty()) {
            throw new AssertionError("Focused native descendant had empty bounds");
        }
    }

    private static boolean sameScope(ScopeNode left, ScopeNode right) {
        if (left.kind != right.kind
                || !left.packageName.equals(right.packageName)
                || left.enabled != right.enabled
                || !left.bounds.sameAs(right.bounds)) {
            return false;
        }
        if (left.resourceName == null) return right.resourceName == null;
        return left.resourceName.equals(right.resourceName);
    }

    private static ScopeNode requireUniquePlayerRoot(List<ScopeNode> admittedPlayerRoots) {
        if (admittedPlayerRoots.size() != 1) {
            throw new AssertionError(
                    "Expected exactly one admitted native PlayerView root, found "
                            + admittedPlayerRoots.size());
        }
        return admittedPlayerRoots.get(0);
    }

    private static void requireList(List<?> snapshots, String message) {
        if (snapshots == null) throw new AssertionError(message);
    }

    enum ScopeKind {
        PLAYER_VIEW,
        SETTINGS_LIST
    }

    enum Direction {
        DOWN,
        UP,
        LEFT,
        RIGHT
    }

    static final class PopupObservationTransaction implements AutoCloseable {
        private boolean active = true;

        private PopupObservationTransaction() { }

        boolean isActive() {
            return active;
        }

        @Override
        public void close() {
            active = false;
        }
    }

    static final class Bounds {
        final int left;
        final int top;
        final int right;
        final int bottom;

        Bounds(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        boolean isEmpty() {
            return left >= right || top >= bottom;
        }

        boolean sameAs(Bounds other) {
            return other != null
                    && left == other.left
                    && top == other.top
                    && right == other.right
                    && bottom == other.bottom;
        }

        private long centerX() {
            return (long) left + ((long) right - left) / 2L;
        }

        private long centerY() {
            return (long) top + ((long) bottom - top) / 2L;
        }
    }

    static final class TargetNode {
        final String packageName;
        final boolean enabled;
        final Bounds bounds;

        TargetNode(String packageName, boolean enabled, Bounds bounds) {
            this.packageName = packageName;
            this.enabled = enabled;
            this.bounds = bounds;
        }
    }

    static final class ScopeNode {
        final ScopeKind kind;
        final String packageName;
        final String resourceName;
        final String className;
        final boolean enabled;
        final Bounds bounds;

        private ScopeNode(
                ScopeKind kind,
                String packageName,
                String resourceName,
                String className,
                boolean enabled,
                Bounds bounds) {
            this.kind = kind;
            this.packageName = packageName;
            this.resourceName = resourceName;
            this.className = className;
            this.enabled = enabled;
            this.bounds = bounds;
        }

        static ScopeNode playerView(String packageName, boolean enabled, Bounds bounds) {
            return new ScopeNode(ScopeKind.PLAYER_VIEW, packageName, null, null, enabled, bounds);
        }

        static ScopeNode settingsList(
                String packageName,
                String resourceName,
                String className,
                boolean enabled,
                Bounds bounds) {
            return new ScopeNode(
                    ScopeKind.SETTINGS_LIST, packageName, resourceName, className, enabled, bounds);
        }
    }

    static final class FocusedNode {
        final ScopeKind scopeKind;
        final String packageName;
        final Bounds bounds;

        FocusedNode(String packageName, Bounds bounds) {
            this(ScopeKind.PLAYER_VIEW, packageName, bounds);
        }

        FocusedNode(ScopeKind scopeKind, String packageName, Bounds bounds) {
            this.scopeKind = scopeKind;
            this.packageName = packageName;
            this.bounds = bounds;
        }
    }

    static final class Ownership {
        final boolean targetPresent;
        final ScopeKind scopeKind;
        final int targetIndex;
        final int ancestorIndex;

        private Ownership(
                boolean targetPresent,
                ScopeKind scopeKind,
                int targetIndex,
                int ancestorIndex) {
            this.targetPresent = targetPresent;
            this.scopeKind = scopeKind;
            this.targetIndex = targetIndex;
            this.ancestorIndex = ancestorIndex;
        }

        static Ownership missingTarget() {
            return new Ownership(false, null, -1, -1);
        }

        static Ownership present(
                ScopeKind scopeKind,
                int targetIndex,
                int ancestorIndex) {
            return new Ownership(true, scopeKind, targetIndex, ancestorIndex);
        }
    }

    static final class Selection {
        final boolean present;
        final Bounds bounds;

        private Selection(boolean present, Bounds bounds) {
            this.present = present;
            this.bounds = bounds;
        }

        static Selection none() {
            return new Selection(false, null);
        }

        static Selection present(Bounds bounds) {
            return new Selection(true, new Bounds(
                    bounds.left, bounds.top, bounds.right, bounds.bottom));
        }
    }
}
