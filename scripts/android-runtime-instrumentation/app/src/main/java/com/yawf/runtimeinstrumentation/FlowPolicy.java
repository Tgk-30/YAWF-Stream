package com.yawf.runtimeinstrumentation;

import java.util.regex.Pattern;

/** Pure policy shared by the host self-tests and the persistent device flow. */
public final class FlowPolicy {
    public static final String EXPECTED_CANDIDATE_VERSION = "2.3.23";
    public static final String EXPECTED_PUBLISHED_VERSION = "2.3.21";
    public static final String UP_TO_DATE_TITLE = "YAWF Stream is up to date";
    public static final String UP_TO_DATE_MESSAGE =
            "No newer signed Android phone release is available.";
    public static final Pattern BINDING_TERMS_PATTERN = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");

    public enum OnboardingEntry {
        UPDATE_CONSENT,
        FIRST_RUN,
        TIER_WELCOME,
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

    public static boolean containsBindingTerms(String value) {
        return BINDING_TERMS_PATTERN.matcher(value == null ? "" : value).matches();
    }

    public static boolean isExactUpToDateResult(String title, String message) {
        return UP_TO_DATE_TITLE.equals(title) && UP_TO_DATE_MESSAGE.equals(message);
    }

    public static boolean isExpectedVersionPair(String candidateVersion, String publishedVersion) {
        return EXPECTED_CANDIDATE_VERSION.equals(candidateVersion)
                && EXPECTED_PUBLISHED_VERSION.equals(publishedVersion);
    }
}
