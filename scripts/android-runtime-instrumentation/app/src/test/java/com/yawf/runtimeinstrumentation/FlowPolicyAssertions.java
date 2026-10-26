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

    static void actualWebViewTextButtonsMatchExactObservedNodes() {
        check(FlowPolicy.MORE_NAVIGATION_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "More navigation", ""),
                "The actual API 30 More navigation text node must match");
        check(FlowPolicy.SKIP_THE_TOUR_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "Skip the tour", ""),
                "The actual API 30 tour Skip text node must match");
    }

    static void legacyWebViewDescriptionButtonsRemainSupported() {
        check(FlowPolicy.MORE_NAVIGATION_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "", "More navigation"),
                "A WebView exposing aria-label as content description must match");
        check(FlowPolicy.SKIP_THE_TOUR_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "", "Skip the tour"),
                "The tour control description variant must match");
    }

    static void labeledWebButtonsRejectWrongIdentityShapeAndAffixes() {
        check(!FlowPolicy.MORE_NAVIGATION_BUTTON.matches(
                        "other.package", "android.widget.Button", "More navigation", ""),
                "Another package must not match");
        check(!FlowPolicy.MORE_NAVIGATION_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.view.View", "More navigation", ""),
                "A nonbutton node must not match");
        check(!FlowPolicy.MORE_NAVIGATION_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "More navigation now", ""),
                "A suffixed label must not match");
        check(!FlowPolicy.SKIP_THE_TOUR_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "Skip the tour\n", ""),
                "A newline-suffixed label must not match");
    }

    static void tourDismissalRequiresThreeConsecutiveAbsentSamples() {
        check(FlowPolicy.WELCOME_TOUR_DIALOG.matches(
                        "com.tgk30.debridstreamer", "android.app.Dialog", "Welcome tour", ""),
                "The exact API 30 and API 36 Welcome tour dialog must match");
        check(!FlowPolicy.WELCOME_TOUR_DIALOG.matches(
                        "com.tgk30.debridstreamer", "android.app.Dialog", "", "Welcome tour"),
                "An unverified dialog description representation must not match");
        check(!FlowPolicy.WELCOME_TOUR_DIALOG.matches(
                        "com.tgk30.debridstreamer", "android.app.Dialog", "Welcome tour now", ""),
                "An affixed Welcome tour label must not match");
        check(!FlowPolicy.WELCOME_TOUR_DIALOG.matches(
                        "other.package", "android.app.Dialog", "Welcome tour", ""),
                "A Welcome tour dialog from another package must not match");
        check(!FlowPolicy.WELCOME_TOUR_DIALOG.matches(
                        "com.tgk30.debridstreamer", "android.view.View", "Welcome tour", ""),
                "A Welcome tour label on the wrong node class must not match");
        check(FlowPolicy.DISCOVER_BUTTON.matches(
                        "com.tgk30.debridstreamer", "android.widget.Button", "Discover", ""),
                "The exact visible Discover anchor must match");
        check(FlowPolicy.STREAMING_SETUP_REMINDER.matches(
                        "com.tgk30.debridstreamer", "android.view.View",
                        "Streaming setup reminder", ""),
                "The exact visible setup reminder anchor must match");

        int samples = FlowPolicy.nextTourDismissalAbsentSamples(0, true, false, true, true);
        check(samples == 1, "One complete post-dismissal observation must count once");
        samples = FlowPolicy.nextTourDismissalAbsentSamples(samples, true, false, true, true);
        check(samples == 2, "Two consecutive complete observations must remain unsettled");
        samples = FlowPolicy.nextTourDismissalAbsentSamples(samples, true, false, true, true);
        check(samples == 3, "Three consecutive complete observations must settle");
        check(FlowPolicy.nextTourDismissalAbsentSamples(samples, false, false, true, true) == 0,
                "A stale or otherwise unknown observation must reset settlement");
        check(FlowPolicy.nextTourDismissalAbsentSamples(samples, true, true, true, true) == 0,
                "A visible Welcome tour dialog must reset settlement");
        check(FlowPolicy.nextTourDismissalAbsentSamples(samples, true, false, false, true) == 0,
                "A missing visible Discover anchor must reset settlement");
        check(FlowPolicy.nextTourDismissalAbsentSamples(samples, true, false, true, false) == 0,
                "A missing visible setup reminder must reset settlement");

        check(!FlowPolicy.isTourDismissalSettled(0),
                "No absent observation must not count as settled");
        check(!FlowPolicy.isTourDismissalSettled(1),
                "One transient absent observation must not count as settled");
        check(!FlowPolicy.isTourDismissalSettled(2),
                "Two transient absent observations must not count as settled");
        check(FlowPolicy.isTourDismissalSettled(3),
                "Three consecutive absent observations must count as settled");
        check(FlowPolicy.isTourDismissalSettled(4),
                "Additional absent observations must remain settled");
    }

    static void settingsNavigationRequiresClosedDrawerAndSettingsOnlyAnchor() {
        check(
                FlowPolicy.classifySettingsNavigation(false, true, true)
                        == FlowPolicy.SettingsNavigationState.WAIT,
                "A Settings anchor behind the open More dialog must not pass");
        check(
                FlowPolicy.classifySettingsNavigation(false, false, false)
                        == FlowPolicy.SettingsNavigationState.WAIT,
                "A closed drawer without a Settings-only anchor must not pass");
        check(
                FlowPolicy.classifySettingsNavigation(false, false, true)
                        == FlowPolicy.SettingsNavigationState.READY,
                "Only a closed drawer plus a Settings-only anchor may pass");
    }

    static void settingsNavigationFailsClosedWhenFirstRunReopens() {
        check(
                FlowPolicy.classifySettingsNavigation(true, false, true)
                        == FlowPolicy.SettingsNavigationState.BLOCKED_FIRST_RUN,
                "FirstRunWizard must block Settings admission even when other signals look ready");
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
        check(FlowPolicy.isExpectedVersionPair("2.3.26", "2.3.25"),
                "The exact candidate and public channel versions must pass");
        check(FlowPolicy.isExpectedVersionPair("2.3.27", "2.3.26"),
                "The exact current candidate and public channel versions must pass");
        check(FlowPolicy.isExpectedVersionPair("2.3.31", "2.3.27"),
                "The independently pinned next candidate and stable versions must pass");
        check(FlowPolicy.isExpectedVersionPair("2.3.61", "2.3.61"),
                "The exact current public candidate and channel versions must pass");
        check(!FlowPolicy.isExpectedVersionPair("2.3.25", "2.3.25"),
                "A changed candidate version must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.26", "2.3.21"),
                "A changed public channel version must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.27", "2.3.25"),
                "A mixed current and legacy channel must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.28", "2.3.27"),
                "Unknown future versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.29", "2.3.27"),
                "The replaced next candidate must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.31", "2.3.26"),
                "The next candidate paired with the prior stable must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.27", "2.3.27"),
                "Equal current and stable versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.31", "2.3.28"),
                "The unreviewed 28 intermediate stable must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.60", "2.3.61"),
                "The prior candidate with the current public channel must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.61", "2.3.60"),
                "The current public candidate with the prior channel must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.62", "2.3.61"),
                "An unreviewed future candidate must fail closed");
        check(!FlowPolicy.isExpectedVersionPair(null, "2.3.26"),
                "Null candidate versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.27", null),
                "Null published versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair(null, "2.3.27"),
                "Null next candidate versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.31", null),
                "Null next published versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("unknown", "2.3.27"),
                "Unknown candidate versions must fail closed");
        check(!FlowPolicy.isExpectedVersionPair("2.3.31", "unknown"),
                "Unknown published versions must fail closed");
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
