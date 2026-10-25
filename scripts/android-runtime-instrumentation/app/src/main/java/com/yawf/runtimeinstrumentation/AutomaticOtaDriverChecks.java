package com.yawf.runtimeinstrumentation;

/** Pure fail-closed checks for the automatic public OTA UI driver. */
public final class AutomaticOtaDriverChecks {
    static final int NO_DIALOG_INDEX = -1;
    static final int AMBIGUOUS_DIALOG_INDEX = -2;

    private AutomaticOtaDriverChecks() {}

    public static final class DialogCandidate {
        final String packageName;
        final String className;
        final String text;
        final String description;

        public DialogCandidate(
                String packageName, String className, String text, String description) {
            this.packageName = valueOrEmpty(packageName);
            this.className = valueOrEmpty(className);
            this.text = valueOrEmpty(text);
            this.description = valueOrEmpty(description);
        }

        private static String valueOrEmpty(String value) {
            return value == null ? "" : value;
        }
    }

    public static int uniqueExactDialogIndex(
            String productPackage,
            String dialogClass,
            String exactIdentity,
            DialogCandidate[] candidates) {
        int selected = NO_DIALOG_INDEX;
        for (int index = 0; index < candidates.length; index++) {
            DialogCandidate candidate = candidates[index];
            boolean packageMatches = productPackage.equals(candidate.packageName);
            boolean classMatches = dialogClass.equals(candidate.className);
            boolean textMatches = exactIdentity.equals(candidate.text);
            boolean descriptionMatches = exactIdentity.equals(candidate.description);
            boolean identityMatches = (textMatches || descriptionMatches)
                    && (candidate.text.isEmpty() || textMatches)
                    && (candidate.description.isEmpty() || descriptionMatches);
            if (!packageMatches
                    || !classMatches
                    || !identityMatches) {
                continue;
            }
            if (selected != NO_DIALOG_INDEX) return AMBIGUOUS_DIALOG_INDEX;
            selected = index;
        }
        return selected;
    }

    public static boolean deferredOfferIsFromLaterReturn(
            int triggerReturnOrdinal,
            int offerReturnOrdinal,
            boolean sameForegroundOfferAbsent,
            boolean manualFallbackUsed) {
        return triggerReturnOrdinal > 0
                && offerReturnOrdinal > triggerReturnOrdinal
                && sameForegroundOfferAbsent
                && !manualFallbackUsed;
    }

    public static boolean exactValueWasPreserved(String before, String after) {
        return before != null
                && !before.isBlank()
                && before.equals(after);
    }

    public static boolean detailClosedBeforePrimaryNavigation(
            int dialogWatchlistClickOrdinal,
            int backOrdinal,
            int dialogGoneOrdinal,
            int primaryNavigationOrdinal) {
        return dialogWatchlistClickOrdinal > 0
                && backOrdinal > dialogWatchlistClickOrdinal
                && dialogGoneOrdinal > backOrdinal
                && primaryNavigationOrdinal > dialogGoneOrdinal;
    }

    public static boolean visibleTaskDismissalCompleted(
            int swipeCount,
            boolean exactTextAbsent,
            boolean exactDescriptionAbsent) {
        return swipeCount == 1 && exactTextAbsent && exactDescriptionAbsent;
    }

    public static boolean permissionRevocationCompleted(
            boolean initiallyChecked,
            int toggleCount,
            boolean finallyChecked) {
        return initiallyChecked && toggleCount == 1 && !finallyChecked;
    }

    public static boolean permissionCleanupMustRun(
            boolean permissionEnabledByTest, boolean coreTransactionPassed) {
        return permissionEnabledByTest;
    }
}
