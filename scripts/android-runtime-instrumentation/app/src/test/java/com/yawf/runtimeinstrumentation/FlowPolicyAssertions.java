package com.yawf.runtimeinstrumentation;

final class FlowPolicyAssertions {
    private FlowPolicyAssertions() {}

    static void firstRunWinsWhenBothWebClassifiersMatch() {
        check(
                FlowPolicy.classifyOnboarding(false, true, true, true, true)
                        == FlowPolicy.OnboardingEntry.FIRST_RUN,
                "The unique FirstRun question must beat the shared tier heading");
    }

    static void tierRequiresCompleteControls() {
        check(
                FlowPolicy.classifyOnboarding(false, false, true, true, false)
                        == FlowPolicy.OnboardingEntry.WAIT,
                "A partial tier mount must not be actionable");
        check(
                FlowPolicy.classifyOnboarding(false, false, true, true, true)
                        == FlowPolicy.OnboardingEntry.TIER_WELCOME,
                "A complete tier welcome must be actionable");
    }

    static void nativeConsentWinsWhenVisible() {
        check(
                FlowPolicy.classifyOnboarding(true, true, true, true, true)
                        == FlowPolicy.OnboardingEntry.UPDATE_CONSENT,
                "The native consent dialog must be handled before covered web content");
    }

    static void nativeButtonLabelsAcceptUppercaseAndMixedCase() {
        check(FlowPolicy.NOT_NOW_BUTTON.matches("button2", "NOT NOW"),
                "The themed uppercase negative button label must match");
        check(FlowPolicy.NOT_NOW_BUTTON.matches("button2", "nOt NoW"),
                "A mixed-case negative button label must match");
        check(FlowPolicy.CHECK_NOW_BUTTON.matches("button1", "CHECK NOW"),
                "The themed uppercase positive button label must match");
    }

    static void nativeButtonLabelsRejectAffixesAndNewlines() {
        check(!FlowPolicy.NOT_NOW_BUTTON.matches("button2", "Not now please"),
                "A suffixed negative label must not match");
        check(!FlowPolicy.NOT_NOW_BUTTON.matches("button2", "Please Not now"),
                "A prefixed negative label must not match");
        check(!FlowPolicy.NOT_NOW_BUTTON.matches("button2", "Not now\n"),
                "A newline-suffixed negative label must not match");
        check(!FlowPolicy.CHECK_NOW_BUTTON.matches("button1", "Check now\n"),
                "A newline-suffixed positive label must not match");
    }

    static void nativeButtonResourceIdentityIsExact() {
        check(!FlowPolicy.NOT_NOW_BUTTON.matches("button1", "Not now"),
                "The negative label on another native button must not match");
        check(!FlowPolicy.CHECK_NOW_BUTTON.matches("button2", "Check now"),
                "The positive label on another native button must not match");
    }

    static void bindingTermsAreRejectedButPrivacyNoticeIsAllowed() {
        check(FlowPolicy.containsBindingTerms("Accept the Terms of Service"),
                "Binding terms must be rejected");
        check(!FlowPolicy.containsBindingTerms(
                        "I understand the privacy, reliability, catalog, and playback limits"),
                "The explicit nonbinding privacy acknowledgement must remain allowed");
    }

    static void nativeResultRequiresExactTitleAndMessage() {
        check(FlowPolicy.isExactUpToDateResult(
                        FlowPolicy.UP_TO_DATE_TITLE, FlowPolicy.UP_TO_DATE_MESSAGE),
                "The exact no-newer result must pass");
        check(!FlowPolicy.isExactUpToDateResult(
                        FlowPolicy.UP_TO_DATE_TITLE, "Update available"),
                "A title-only match must not pass");
    }

    static void channelVersionsArePinned() {
        check(FlowPolicy.isExpectedVersionPair("2.3.23", "2.3.21"),
                "The exact candidate and public channel versions must pass");
        check(!FlowPolicy.isExpectedVersionPair("2.3.23", "2.3.22"),
                "A changed public channel version must fail closed");
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
