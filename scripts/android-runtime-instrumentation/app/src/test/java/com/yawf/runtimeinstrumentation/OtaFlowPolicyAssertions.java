package com.yawf.runtimeinstrumentation;

import java.util.LinkedHashMap;
import java.util.Map;

/** Dependency-free policy assertions, runnable one at a time by the mutation gate. */
public final class OtaFlowPolicyAssertions {
    private static final Map<String, Runnable> TESTS = new LinkedHashMap<>();

    static {
        TESTS.put("pins", OtaFlowPolicyAssertions::pins);
        TESTS.put("webButtonIdentity", OtaFlowPolicyAssertions::webButtonIdentity);
        TESTS.put("quickSetupCardIdentity", OtaFlowPolicyAssertions::quickSetupCardIdentity);
        TESTS.put("nativeButtonIdentity", OtaFlowPolicyAssertions::nativeButtonIdentity);
        TESTS.put("bindingTerms", OtaFlowPolicyAssertions::bindingTerms);
        TESTS.put("tourCounts", OtaFlowPolicyAssertions::tourCounts);
        TESTS.put("settledAbsence", OtaFlowPolicyAssertions::settledAbsence);
        TESTS.put("systemPackages", OtaFlowPolicyAssertions::systemPackages);
        TESTS.put("switchResources", OtaFlowPolicyAssertions::switchResources);
        TESTS.put("cleanupSequence", OtaFlowPolicyAssertions::cleanupSequence);
        TESTS.put("exactDialogs", OtaFlowPolicyAssertions::exactDialogs);
    }

    private OtaFlowPolicyAssertions() {}

    public static void main(String[] args) {
        if (args.length != 1 || !TESTS.containsKey(args[0])) {
            throw new IllegalArgumentException("Pass one known policy assertion name");
        }
        TESTS.get(args[0]).run();
        System.out.println("PASS " + args[0]);
    }

    private static void pins() {
        check(OtaFlowPolicy.expectedArguments(
                        "2.3.21", "2.3.25", 2_003_025L,
                        "4f8cb6defe54e128f01790fafd84b6f3fd545d7c6734458d24543edcfa4bc58b",
                        88_533_889L),
                "exact fixed-channel arguments must pass");
        check(!OtaFlowPolicy.expectedArguments(
                        "2.3.21", "2.3.26", 2_003_025L,
                        OtaFlowPolicy.TARGET_SHA256, OtaFlowPolicy.TARGET_SIZE),
                "changed target version must fail");
    }

    private static void webButtonIdentity() {
        check(OtaFlowPolicy.NEXT.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.widget.Button", "Next", ""),
                "actual WebView text button must match");
        check(OtaFlowPolicy.DISMISS_SETUP_REMINDER.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.widget.Button", "", "Dismiss setup reminder"),
                "aria-label exposed as description must match");
        check(!OtaFlowPolicy.NEXT.matches(
                        "other.package", "android.widget.Button", "Next", ""),
                "wrong package must fail");
        check(!OtaFlowPolicy.NEXT.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.view.View", "Next", ""),
                "wrong class must fail");
        check(!OtaFlowPolicy.NEXT.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.widget.Button", "Next now", ""),
                "label affix must fail");
    }

    private static void quickSetupCardIdentity() {
        String actualCard =
                "Quick setup NOT RECOMMENDED Start with public sources without adding your own keys now. "
                        + "Catalog and playback limits are explained before continuing.";
        check(OtaFlowPolicy.QUICK_SETUP.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.widget.Button", actualCard, ""),
                "actual API 36 Quick setup card text must match exactly");
        check(!OtaFlowPolicy.QUICK_SETUP.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.widget.Button", "Quick setup", ""),
                "short heading alone must fail");
        check(!OtaFlowPolicy.QUICK_SETUP.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE,
                        "android.widget.Button",
                        actualCard.replace("NOT RECOMMENDED", "RECOMMENDED"),
                        ""),
                "nearby wrong setup card must fail");
        check(!OtaFlowPolicy.QUICK_SETUP.matches(
                        "other.package", "android.widget.Button", actualCard, ""),
                "wrong Quick setup package must fail");
        check(!OtaFlowPolicy.QUICK_SETUP.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "android.view.View", actualCard, ""),
                "wrong Quick setup class must fail");
    }

    private static void nativeButtonIdentity() {
        check(OtaFlowPolicy.NOT_NOW.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "button2", "NOT NOW"),
                "uppercase themed native label must match");
        check(OtaFlowPolicy.CHECK_NOW.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "button1", "cHeCk NoW"),
                "mixed-case native label must match");
        check(!OtaFlowPolicy.CHECK_NOW.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "button2", "Check now"),
                "wrong native resource must fail");
        check(!OtaFlowPolicy.CHECK_NOW.matches(
                        "android", "button1", "Check now"),
                "wrong native package must fail");
        check(!OtaFlowPolicy.CHECK_NOW.matches(
                        OtaFlowPolicy.PRODUCT_PACKAGE, "button1", "Check now\n"),
                "newline affix must fail");
    }

    private static void bindingTerms() {
        check(OtaFlowPolicy.isBindingTerms("Accept the Terms of Service"),
                "binding terms must be refused");
        check(!OtaFlowPolicy.isBindingTerms(
                        "I understand the privacy, reliability, catalog, and playback limits"),
                "ordinary nonbinding privacy acknowledgement must remain allowed");
    }

    private static void tourCounts() {
        check("Next".equals(OtaFlowPolicy.forwardLabel(0, OtaFlowPolicy.TIER_STEPS)),
                "first tier step must advance");
        check("Get started".equals(OtaFlowPolicy.forwardLabel(2, OtaFlowPolicy.TIER_STEPS)),
                "third tier step must finish");
        check("Next".equals(OtaFlowPolicy.forwardLabel(5, OtaFlowPolicy.WELCOME_STEPS)),
                "sixth welcome step must advance");
        check("Get started".equals(OtaFlowPolicy.forwardLabel(6, OtaFlowPolicy.WELCOME_STEPS)),
                "seventh welcome step must finish");
        boolean rejected = false;
        try {
            OtaFlowPolicy.forwardLabel(7, OtaFlowPolicy.WELCOME_STEPS);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        check(rejected, "out-of-range tour step must fail");
    }

    private static void settledAbsence() {
        check(!OtaFlowPolicy.isSettledAbsent(2), "two absent samples are transient");
        check(OtaFlowPolicy.isSettledAbsent(3), "three absent samples are settled");
    }

    private static void systemPackages() {
        check(OtaFlowPolicy.isSettingsPackage("com.android.settings"),
                "fixed Android Settings package must pass");
        check(!OtaFlowPolicy.isSettingsPackage(OtaFlowPolicy.PRODUCT_PACKAGE),
                "product package is not Settings");
        check(OtaFlowPolicy.isInstallerPackage("com.google.android.packageinstaller"),
                "Google package installer must pass");
        check(OtaFlowPolicy.isInstallerPackage("com.android.permissioncontroller"),
                "AOSP permission-controller installer surface must pass");
        check(!OtaFlowPolicy.isInstallerPackage("com.example.installer"),
                "unreviewed installer package must fail");
    }

    private static void switchResources() {
        check(OtaFlowPolicy.isUnknownSourceSwitchResource("android:id/switch_widget"),
                "framework switch resource must pass");
        check(OtaFlowPolicy.isUnknownSourceSwitchResource("com.android.settings:id/switch_widget"),
                "Settings switch resource must pass");
        check(!OtaFlowPolicy.isUnknownSourceSwitchResource("android:id/button1"),
                "generic button must fail");
    }

    private static void cleanupSequence() {
        check(!OtaFlowPolicy.cleanupMayOpenSettings(false, true, true),
                "cleanup must not run before installer success");
        check(!OtaFlowPolicy.cleanupMayOpenSettings(true, false, true),
                "cleanup must not run before installer Open");
        check(!OtaFlowPolicy.cleanupMayOpenSettings(true, true, false),
                "cleanup must not run before updated product is observed");
        check(OtaFlowPolicy.cleanupMayOpenSettings(true, true, true),
                "cleanup may run only after the full transaction");
    }

    private static void exactDialogs() {
        check(OtaFlowPolicy.isExactOffer(
                        "YAWF Stream 2.3.25 is available",
                        "Download the signed Android update now? Android will ask again before installing it."),
                "exact offer must pass");
        check(!OtaFlowPolicy.isExactOffer(
                        "YAWF Stream 2.3.26 is available",
                        "Download the signed Android update now? Android will ask again before installing it."),
                "other candidate must fail");
        check(OtaFlowPolicy.isExactReady(
                        "Update ready to install",
                        "YAWF Stream 2.3.25 passed all checks. Android will show the system installer."),
                "exact ready dialog must pass");
        check(OtaFlowPolicy.isExactPostUpdateResult(
                        "YAWF Stream is up to date",
                        "No newer signed Android phone release is available."),
                "exact post-update result must pass");
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
