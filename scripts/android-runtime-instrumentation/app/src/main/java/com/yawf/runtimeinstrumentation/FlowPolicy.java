package com.yawf.runtimeinstrumentation;

import java.util.regex.Pattern;

/** Pure policy shared by the host self-tests and the persistent device flow. */
public final class FlowPolicy {
    public static final String EXPECTED_CANDIDATE_VERSION = "2.3.26";
    public static final String LEGACY_CANDIDATE_VERSION = "2.3.26";
    public static final String LEGACY_PUBLISHED_VERSION = "2.3.25";
    public static final String CURRENT_CANDIDATE_VERSION = "2.3.27";
    public static final String CURRENT_PUBLISHED_VERSION = "2.3.26";
    public static final String NEXT_CANDIDATE_VERSION = "2.3.31";
    public static final String NEXT_PUBLISHED_VERSION = "2.3.27";
    public static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    public static final String WEB_BUTTON_CLASS = "android.widget.Button";
    public static final ExactTextWebNodeSpec WELCOME_TOUR_DIALOG =
            new ExactTextWebNodeSpec("Welcome tour", "android.app.Dialog");
    public static final ExactTextWebNodeSpec DISCOVER_BUTTON =
            new ExactTextWebNodeSpec("Discover", WEB_BUTTON_CLASS);
    public static final ExactTextWebNodeSpec STREAMING_SETUP_REMINDER =
            new ExactTextWebNodeSpec("Streaming setup reminder", "android.view.View");
    public static final LabeledWebButtonSpec MORE_NAVIGATION_BUTTON =
            new LabeledWebButtonSpec("More navigation");
    public static final LabeledWebButtonSpec SKIP_THE_TOUR_BUTTON =
            new LabeledWebButtonSpec("Skip the tour");
    public static final LabeledWebButtonSpec SKIP_TOUR_BUTTON =
            new LabeledWebButtonSpec("Skip tour");
    private static final int TOUR_SETTLED_ABSENT_SAMPLES = 3;
    public static final String EXPECTED_PUBLISHED_VERSION = "2.3.25";
    public static final String UP_TO_DATE_TITLE = "YAWF Stream is up to date";
    public static final String UP_TO_DATE_MESSAGE =
            "No newer signed Android phone release is available.";
    public static final Pattern BINDING_TERMS_PATTERN = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    public static final NativeButtonSpec NOT_NOW_BUTTON =
            new NativeButtonSpec("button2", "Not now");
    public static final NativeButtonSpec CHECK_NOW_BUTTON =
            new NativeButtonSpec("button1", "Check now");

    public static final class NativeButtonSpec {
        private final String resourceName;
        private final Pattern textPattern;

        private NativeButtonSpec(String resourceName, String expectedLabel) {
            this.resourceName = resourceName;
            this.textPattern = Pattern.compile(
                    "\\A" + Pattern.quote(expectedLabel) + "\\z",
                    Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
        }

        public String resourceName() {
            return resourceName;
        }

        public Pattern textPattern() {
            return textPattern;
        }

        public boolean matches(String observedResourceName, String observedText) {
            return resourceName.equals(observedResourceName)
                    && textPattern.matcher(observedText == null ? "" : observedText).matches();
        }
    }

    public static final class LabeledWebButtonSpec {
        private final String label;

        private LabeledWebButtonSpec(String label) {
            this.label = label;
        }

        public String label() {
            return label;
        }

        public boolean matches(
                String observedPackage,
                String observedClass,
                String observedText,
                String observedDescription) {
            return PRODUCT_PACKAGE.equals(observedPackage)
                    && WEB_BUTTON_CLASS.equals(observedClass)
                    && (label.equals(observedText) || label.equals(observedDescription));
        }
    }

    /** Exact text identity observed in both the API 30 and API 36 WebView hierarchies. */
    public static final class ExactTextWebNodeSpec {
        private final String label;
        private final String className;

        private ExactTextWebNodeSpec(String label, String className) {
            this.label = label;
            this.className = className;
        }

        public String label() {
            return label;
        }

        public String className() {
            return className;
        }

        public boolean matches(
                String observedPackage,
                String observedClass,
                String observedText,
                String observedDescription) {
            return PRODUCT_PACKAGE.equals(observedPackage)
                    && className.equals(observedClass)
                    && label.equals(observedText);
        }
    }

    public enum OnboardingEntry {
        UPDATE_CONSENT,
        FIRST_RUN,
        TIER_WELCOME,
        WAIT
    }

    public enum SettingsNavigationState {
        BLOCKED_FIRST_RUN,
        READY,
        WAIT
    }

    private FlowPolicy() {}

    public static OnboardingEntry classifyOnboarding(
            boolean updateConsent,
            boolean firstRunQuestion,
            boolean tierHeading,
            boolean tierSkip,
            boolean tierNext) {
        if (updateConsent) {
            return OnboardingEntry.UPDATE_CONSENT;
        }
        if (firstRunQuestion) {
            return OnboardingEntry.FIRST_RUN;
        }
        if (tierHeading && tierSkip && tierNext) {
            return OnboardingEntry.TIER_WELCOME;
        }
        return OnboardingEntry.WAIT;
    }

    public static SettingsNavigationState classifySettingsNavigation(
            boolean firstRunVisible,
            boolean moreDialogVisible,
            boolean settingsAnchorVisible) {
        if (firstRunVisible) {
            return SettingsNavigationState.BLOCKED_FIRST_RUN;
        }
        if (!moreDialogVisible && settingsAnchorVisible) {
            return SettingsNavigationState.READY;
        }
        return SettingsNavigationState.WAIT;
    }

    public static boolean containsBindingTerms(String value) {
        return BINDING_TERMS_PATTERN.matcher(value == null ? "" : value).matches();
    }

    public static boolean isTourDismissalSettled(int consecutiveAbsentSamples) {
        return consecutiveAbsentSamples >= TOUR_SETTLED_ABSENT_SAMPLES;
    }

    public static int nextTourDismissalAbsentSamples(
            int consecutiveAbsentSamples,
            boolean observationKnown,
            boolean welcomeTourDialogPresent,
            boolean discoverVisible,
            boolean setupReminderVisible) {
        if (!observationKnown
                || welcomeTourDialogPresent
                || !discoverVisible
                || !setupReminderVisible) {
            return 0;
        }
        return consecutiveAbsentSamples + 1;
    }

    public static boolean isExactUpToDateResult(String title, String message) {
        return UP_TO_DATE_TITLE.equals(title) && UP_TO_DATE_MESSAGE.equals(message);
    }

    public static boolean isExpectedVersionPair(String candidateVersion, String publishedVersion) {
        return (LEGACY_CANDIDATE_VERSION.equals(candidateVersion)
                        && LEGACY_PUBLISHED_VERSION.equals(publishedVersion))
                || (CURRENT_CANDIDATE_VERSION.equals(candidateVersion)
                        && CURRENT_PUBLISHED_VERSION.equals(publishedVersion))
                || (NEXT_CANDIDATE_VERSION.equals(candidateVersion)
                        && NEXT_PUBLISHED_VERSION.equals(publishedVersion));
    }
}
