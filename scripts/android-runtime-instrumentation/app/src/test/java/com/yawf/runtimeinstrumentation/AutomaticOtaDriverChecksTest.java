package com.yawf.runtimeinstrumentation;

import org.junit.Test;

public final class AutomaticOtaDriverChecksTest {
    @Test
    public void detailDialogResolverRequiresOneExactProductIdentity() {
        AutomaticOtaDriverChecksAssertions.detailDialogResolverRequiresOneExactProductIdentity();
    }

    @Test
    public void sameForegroundBypassIsRejected() {
        AutomaticOtaDriverChecksAssertions.sameForegroundBypassIsRejected();
    }

    @Test
    public void profileComparisonUsesObservedBeforeAndAfterValues() {
        AutomaticOtaDriverChecksAssertions.profileComparisonUsesObservedBeforeAndAfterValues();
    }

    @Test
    public void detailMustCloseBeforePrimaryNavigation() {
        AutomaticOtaDriverChecksAssertions.detailMustCloseBeforePrimaryNavigation();
    }

    @Test
    public void recentsDismissalRequiresSwipeAndBothIdentitiesGone() {
        AutomaticOtaDriverChecksAssertions.recentsDismissalRequiresSwipeAndBothIdentitiesGone();
    }

    @Test
    public void permissionRevocationRequiresOneToggleAndFinalOffState() {
        AutomaticOtaDriverChecksAssertions.permissionRevocationRequiresOneToggleAndFinalOffState();
    }

    @Test
    public void cleanupStillRunsAfterCoreTransactionFailure() {
        AutomaticOtaDriverChecksAssertions.cleanupStillRunsAfterCoreTransactionFailure();
    }
}
