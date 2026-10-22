package com.yawf.permissionreturnfixture;

import java.util.Set;

public final class FixturePolicy {
    public static final String FIXTURE_PACKAGE = "com.yawf.permissionreturnfixture";
    public static final String FIXTURE_ACTIVITY = FIXTURE_PACKAGE + ".FixtureActivity";
    public static final String FIXTURE_LABEL = "YAWF permission return fixture";
    public static final String SETTINGS_PACKAGE = "com.android.settings";
    public static final String UNKNOWN_SOURCE_LABEL = "Allow from this source";
    public static final String UNKNOWN_SOURCE_LABEL_CLASS = "android.widget.TextView";
    public static final String UNKNOWN_SOURCE_TOGGLE_CLASS = "android.view.View";
    public static final String READY_TITLE = "Update ready to install";
    public static final String RETRY_TITLE = "Update needs attention";
    public static final String CHANGED_MESSAGE =
            "The verified update changed or became unavailable.";
    public static final String TEST_VERSION = "90.0.2";
    public static final long TEST_VERSION_CODE = 90_000_002L;
    public static final String TEST_APK_NAME = "YAWF.Stream_Android_90.0.2.apk";
    public static final String TEST_TAG = "android-v90.0.2";
    public static final String TARGET_ASSET_NAME = "success-target.apk";
    public static final int PHASE_PREPARING = 1;
    public static final int PHASE_STAGED = 3;
    public static final String PREFERENCES_NAME = "yawf_android_updater_v1";
    public static final String KEY_DOWNLOAD_CANDIDATE = "download_candidate";
    public static final String KEY_UPDATE_PHASE = "update_phase";
    public static final String KEY_PHASE_NOT_BEFORE_GENERATION = "phase_not_before_generation";
    public static final String KEY_AWAITING_INSTALL_PERMISSION = "awaiting_install_permission";
    public static final String KEY_AUTOMATIC_CHECKS = "automatic_checks";
    public static final String KEY_NETWORK_CONSENT = "network_consent";
    public static final int CONSENT_DECLINED = 2;
    public static final int PHASE_NONE = 0;
    public static final int SETTLED_SAMPLES = 3;

    private static final Set<String> INSTALLER_PACKAGES = Set.of(
            "com.google.android.packageinstaller",
            "com.android.packageinstaller",
            "com.google.android.permissioncontroller",
            "com.android.permissioncontroller");

    private FixturePolicy() {}

    public static boolean isInstallerPackage(String packageName) {
        return INSTALLER_PACKAGES.contains(packageName);
    }

    public static boolean isChangedRetryMessage(String message) {
        return CHANGED_MESSAGE.equals(message);
    }

    public static Set<String> installerPackages() {
        return INSTALLER_PACKAGES;
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
}
