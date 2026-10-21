package com.yawf.runtimeinstrumentation;

import java.util.Set;
import java.util.regex.Pattern;

/** Pure, fixed-channel policy for the isolated public Android OTA runtime gate. */
public final class OtaFlowPolicy {
    public static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    public static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    public static final String BASELINE_VERSION = "2.3.25";
    public static final String TARGET_VERSION = "2.3.26";
    public static final long TARGET_VERSION_CODE = 2_003_026L;
    public static final String TARGET_SHA256 =
            "2ad11054cdbb2805a75e06d8d59961e2f43c00c0c2532d02ade3e197ef5e9a3c";
    public static final long TARGET_SIZE = 88_562_561L;
    public static final String SIGNER_SHA256 =
            "233ff9e26de50c5a560417e2c33956845422ea262168bffffadf4758301fc72a";
    public static final int TIER_STEPS = 3;
    public static final int WELCOME_STEPS = 7;
    public static final int SETTLED_ABSENT_SAMPLES = 3;
    public static final String WEB_BUTTON_CLASS = "android.widget.Button";
    public static final String SETTINGS_PACKAGE = "com.android.settings";
    public static final String UNKNOWN_SOURCE_LABEL = "Allow from this source";
    public static final String UNKNOWN_SOURCE_LABEL_CLASS = "android.widget.TextView";
    public static final String UNKNOWN_SOURCE_TOGGLE_CLASS = "android.view.View";
    public static final Pattern BINDING_TERMS_PATTERN = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");

    public static final WebButtonSpec NEXT = new WebButtonSpec("Next");
    public static final WebButtonSpec GET_STARTED = new WebButtonSpec("Get started");
    public static final WebButtonSpec QUICK_SETUP = new WebButtonSpec(
            "Quick setup NOT RECOMMENDED Start with public sources without adding your own keys now. "
                    + "Catalog and playback limits are explained before continuing.");
    public static final WebButtonSpec CONTINUE_QUICK_SETUP =
            new WebButtonSpec("Continue with Quick setup");
    public static final WebButtonSpec DISMISS_SETUP_REMINDER =
            new WebButtonSpec("Dismiss setup reminder");
    public static final WebButtonSpec MORE_NAVIGATION = new WebButtonSpec("More navigation");

    public static final NativeButtonSpec NOT_NOW =
            new NativeButtonSpec(PRODUCT_PACKAGE, "button2", "Not now");
    public static final NativeButtonSpec CHECK_NOW =
            new NativeButtonSpec(PRODUCT_PACKAGE, "button1", "Check now");
    public static final NativeButtonSpec UPDATE =
            new NativeButtonSpec(PRODUCT_PACKAGE, "button1", "Update");
    public static final NativeButtonSpec INSTALL =
            new NativeButtonSpec(PRODUCT_PACKAGE, "button1", "Install");
    public static final NativeButtonSpec OK =
            new NativeButtonSpec(PRODUCT_PACKAGE, "button1", "OK");

    private static final Set<String> SETTINGS_PACKAGES = Set.of(SETTINGS_PACKAGE);
    private static final Set<String> INSTALLER_PACKAGES = Set.of(
            "com.google.android.packageinstaller",
            "com.android.packageinstaller",
            "com.google.android.permissioncontroller",
            "com.android.permissioncontroller");
    private static final Set<String> UNKNOWN_SOURCE_SWITCH_RESOURCES = Set.of(
            "android:id/switch_widget",
            "com.android.settings:id/switch_widget");

    private OtaFlowPolicy() {}

    public static final class WebButtonSpec {
        private final String label;

        private WebButtonSpec(String label) {
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

    public static final class NativeButtonSpec {
        private final String packageName;
        private final String resourceName;
        private final Pattern textPattern;

        private NativeButtonSpec(String packageName, String resourceName, String label) {
            this.packageName = packageName;
            this.resourceName = resourceName;
            this.textPattern = Pattern.compile(
                    "\\A" + Pattern.quote(label) + "\\z",
                    Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
        }

        public String packageName() {
            return packageName;
        }

        public String resourceName() {
            return resourceName;
        }

        public Pattern textPattern() {
            return textPattern;
        }

        public boolean matches(String observedPackage, String observedResource, String text) {
            return packageName.equals(observedPackage)
                    && resourceName.equals(observedResource)
                    && textPattern.matcher(text == null ? "" : text).matches();
        }
    }

    public static boolean matchesVersionPins(
            String baselineVersion,
            String targetVersion,
            long targetVersionCode,
            String targetSha256,
            long targetSize,
            String signerSha256) {
        return BASELINE_VERSION.equals(baselineVersion)
                && TARGET_VERSION.equals(targetVersion)
                && TARGET_VERSION_CODE == targetVersionCode
                && TARGET_SHA256.equals(targetSha256)
                && TARGET_SIZE == targetSize
                && SIGNER_SHA256.equals(signerSha256);
    }

    public static boolean isBindingTerms(String value) {
        return BINDING_TERMS_PATTERN.matcher(value == null ? "" : value).matches();
    }

    public static String forwardLabel(int zeroBasedStep, int totalSteps) {
        if (zeroBasedStep < 0 || totalSteps < 1 || zeroBasedStep >= totalSteps) {
            throw new IllegalArgumentException("Invalid tour step");
        }
        return zeroBasedStep == totalSteps - 1 ? GET_STARTED.label() : NEXT.label();
    }

    public static boolean isSettledAbsent(int samples) {
        return samples >= SETTLED_ABSENT_SAMPLES;
    }

    public static boolean isSettingsPackage(String packageName) {
        return SETTINGS_PACKAGES.contains(packageName);
    }

    public static boolean isInstallerPackage(String packageName) {
        return INSTALLER_PACKAGES.contains(packageName);
    }

    public static boolean isUnknownSourceSwitchResource(String resourceId) {
        return UNKNOWN_SOURCE_SWITCH_RESOURCES.contains(resourceId);
    }

    public static boolean isUnknownSourceSemanticToggle(
            String togglePackage,
            String toggleClass,
            String toggleResource,
            boolean toggleEnabled,
            boolean toggleClickable,
            boolean toggleCheckable,
            String labelPackage,
            String labelClass,
            String labelText,
            boolean labelEnabled) {
        return SETTINGS_PACKAGE.equals(togglePackage)
                && UNKNOWN_SOURCE_TOGGLE_CLASS.equals(toggleClass)
                && (toggleResource == null || toggleResource.isEmpty())
                && toggleEnabled
                && toggleClickable
                && toggleCheckable
                && SETTINGS_PACKAGE.equals(labelPackage)
                && UNKNOWN_SOURCE_LABEL_CLASS.equals(labelClass)
                && UNKNOWN_SOURCE_LABEL.equals(labelText)
                && labelEnabled;
    }

    public static boolean cleanupMayOpenSettings(
            boolean installerSuccessObserved,
            boolean installerOpenObserved,
            boolean updatedProductObserved) {
        return installerSuccessObserved && installerOpenObserved && updatedProductObserved;
    }

    public static boolean isExactOffer(String title, String message) {
        return ("YAWF Stream " + TARGET_VERSION + " is available").equals(title)
                && "Download the signed Android update now? Android will ask again before installing it."
                        .equals(message);
    }

    public static boolean isExactReady(String title, String message) {
        return "Update ready to install".equals(title)
                && ("YAWF Stream " + TARGET_VERSION
                        + " passed all checks. Android will show the system installer.")
                        .equals(message);
    }

    public static boolean isExactPostUpdateResult(String title, String message) {
        return "YAWF Stream is up to date".equals(title)
                && "No newer signed Android phone release is available.".equals(message);
    }
}
