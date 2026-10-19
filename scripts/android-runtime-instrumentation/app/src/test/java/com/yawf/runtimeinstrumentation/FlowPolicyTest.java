package com.yawf.runtimeinstrumentation;

import org.junit.Test;

public final class FlowPolicyTest {
    @Test
    public void firstRunWinsWhenBothWebClassifiersMatch() {
        FlowPolicyAssertions.firstRunWinsWhenBothWebClassifiersMatch();
    }

    @Test
    public void tierRequiresCompleteControls() {
        FlowPolicyAssertions.tierRequiresCompleteControls();
    }

    @Test
    public void nativeConsentWinsWhenVisible() {
        FlowPolicyAssertions.nativeConsentWinsWhenVisible();
    }

    @Test
    public void bindingTermsAreRejectedButPrivacyNoticeIsAllowed() {
        FlowPolicyAssertions.bindingTermsAreRejectedButPrivacyNoticeIsAllowed();
    }

    @Test
    public void nativeResultRequiresExactTitleAndMessage() {
        FlowPolicyAssertions.nativeResultRequiresExactTitleAndMessage();
    }

    @Test
    public void channelVersionsArePinned() {
        FlowPolicyAssertions.channelVersionsArePinned();
    }
}
