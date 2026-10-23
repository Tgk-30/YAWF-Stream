package com.yawf.runtimeinstrumentation;

import java.util.LinkedHashMap;
import java.util.Map;

public final class AutomaticOtaDriverChecksAssertions {
    private AutomaticOtaDriverChecksAssertions() {}

    public static void detailDialogResolverRequiresOneExactProductIdentity() {
        String productPackage = "com.tgk30.debridstreamer";
        String dialogClass = "android.app.Dialog";
        String identity = "Blade Runner 2049 details";
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, identity, "")
                }) == 0);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, "", identity)
                }) == 0);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, identity, identity)
                }) == 0);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, identity, ""),
                        dialog(productPackage, dialogClass, "", identity)
                }) == AutomaticOtaDriverChecks.AMBIGUOUS_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, "Another title details", "")
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, "", "")
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, identity, "Another title details")
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, dialogClass, "Another title details", identity)
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog("com.example.other", dialogClass, identity, "")
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
        require(AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                productPackage,
                dialogClass,
                identity,
                new AutomaticOtaDriverChecks.DialogCandidate[] {
                        dialog(productPackage, "android.view.View", identity, "")
                }) == AutomaticOtaDriverChecks.NO_DIALOG_INDEX);
    }

    public static void sameForegroundBypassIsRejected() {
        require(AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(1, 2, true, false));
        require(!AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(1, 1, true, false));
        require(!AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(1, 2, false, false));
        require(!AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(1, 2, true, true));
    }

    public static void profileComparisonUsesObservedBeforeAndAfterValues() {
        require(AutomaticOtaDriverChecks.exactValueWasPreserved(
                "Auto OTA Profile", "Auto OTA Profile"));
        require(!AutomaticOtaDriverChecks.exactValueWasPreserved(
                "Auto OTA Profile", "Changed after update"));
        require(!AutomaticOtaDriverChecks.exactValueWasPreserved(null, "Auto OTA Profile"));
    }

    public static void detailMustCloseBeforePrimaryNavigation() {
        require(AutomaticOtaDriverChecks.detailClosedBeforePrimaryNavigation(1, 2, 3, 4));
        require(!AutomaticOtaDriverChecks.detailClosedBeforePrimaryNavigation(1, 1, 2, 3));
        require(!AutomaticOtaDriverChecks.detailClosedBeforePrimaryNavigation(1, 2, 2, 3));
        require(!AutomaticOtaDriverChecks.detailClosedBeforePrimaryNavigation(1, 2, 3, 3));
    }

    public static void recentsDismissalRequiresSwipeAndBothIdentitiesGone() {
        require(AutomaticOtaDriverChecks.visibleTaskDismissalCompleted(1, true, true));
        require(!AutomaticOtaDriverChecks.visibleTaskDismissalCompleted(0, true, true));
        require(!AutomaticOtaDriverChecks.visibleTaskDismissalCompleted(1, false, true));
        require(!AutomaticOtaDriverChecks.visibleTaskDismissalCompleted(1, true, false));
    }

    public static void permissionRevocationRequiresOneToggleAndFinalOffState() {
        require(AutomaticOtaDriverChecks.permissionRevocationCompleted(true, 1, false));
        require(!AutomaticOtaDriverChecks.permissionRevocationCompleted(true, 0, false));
        require(!AutomaticOtaDriverChecks.permissionRevocationCompleted(true, 1, true));
        require(!AutomaticOtaDriverChecks.permissionRevocationCompleted(false, 1, false));
    }

    public static void cleanupStillRunsAfterCoreTransactionFailure() {
        require(AutomaticOtaDriverChecks.permissionCleanupMustRun(true, true));
        require(AutomaticOtaDriverChecks.permissionCleanupMustRun(true, false));
        require(!AutomaticOtaDriverChecks.permissionCleanupMustRun(false, true));
        require(!AutomaticOtaDriverChecks.permissionCleanupMustRun(false, false));
    }

    public static void main(String[] args) {
        Map<String, Runnable> tests = new LinkedHashMap<>();
        tests.put("detailDialogResolver",
                AutomaticOtaDriverChecksAssertions::detailDialogResolverRequiresOneExactProductIdentity);
        tests.put("sameForegroundBypass", AutomaticOtaDriverChecksAssertions::sameForegroundBypassIsRejected);
        tests.put("profileComparison", AutomaticOtaDriverChecksAssertions::profileComparisonUsesObservedBeforeAndAfterValues);
        tests.put("detailDismissal", AutomaticOtaDriverChecksAssertions::detailMustCloseBeforePrimaryNavigation);
        tests.put("recentsSwipe", AutomaticOtaDriverChecksAssertions::recentsDismissalRequiresSwipeAndBothIdentitiesGone);
        tests.put("permissionToggle", AutomaticOtaDriverChecksAssertions::permissionRevocationRequiresOneToggleAndFinalOffState);
        tests.put("cleanupAfterFailure", AutomaticOtaDriverChecksAssertions::cleanupStillRunsAfterCoreTransactionFailure);
        if (args.length != 1 || !tests.containsKey(args[0])) {
            throw new IllegalArgumentException("Expected one named automatic OTA driver check");
        }
        tests.get(args[0]).run();
        System.out.println("PASS " + args[0]);
    }

    private static void require(boolean value) {
        if (!value) throw new AssertionError("automatic OTA driver check failed");
    }

    private static AutomaticOtaDriverChecks.DialogCandidate dialog(
            String packageName, String className, String text, String description) {
        return new AutomaticOtaDriverChecks.DialogCandidate(
                packageName, className, text, description);
    }
}
