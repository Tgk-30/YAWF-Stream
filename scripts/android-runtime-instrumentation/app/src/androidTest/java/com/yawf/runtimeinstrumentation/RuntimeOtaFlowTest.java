package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** One persistent semantic UI session for an admitted real public Android OTA. */
@RunWith(AndroidJUnit4.class)
public final class RuntimeOtaFlowTest {
    private static final long SHORT_WAIT_MS = 20_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final long DOWNLOAD_WAIT_MS = 8L * 60L * 1000L;
    private static final long NEGATIVE_IDLE_TIMEOUT_MS = 100L;
    private static final String EVIDENCE_SUBDIR = "persistent-ota-flow";
    private static final int MAX_CAPTURES = 40;
    private static final int MAX_ACTION_LINES = 260;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final int WELCOME_STAGE_SETTLED_SAMPLES = 2;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern URL = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern UPDATE_TEXT = Pattern.compile("\\AUpdate\\z", Pattern.CASE_INSENSITIVE);
    private static final Pattern OPEN_TEXT = Pattern.compile("\\AOpen\\z", Pattern.CASE_INSENSITIVE);
    private static final Pattern LOWER_SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern LOWER_REVISION = Pattern.compile("[0-9a-f]{40}");
    private static final Pattern VERSION = Pattern.compile("\\d+\\.\\d+\\.\\d+");
    private static final String AUTOMATIC_OTA_MODE = "automatic-initial-cancel-due-resume";
    private static final String AUTOMATIC_EVIDENCE_SUBDIR = "automatic-public-ota-flow";
    private static final String FIXED42_AUTOMATIC_OTA_PROFILE =
            "public-fixed42-to59-initial-cancel-due-resume-v1";
    private static final String FIXED42_EVIDENCE_SUBDIR = "fixed42-automatic-public-ota-flow";
    private static final String FIXED42_BASELINE_VERSION = "2.3.42";
    private static final long FIXED42_BASELINE_VERSION_CODE = 2_003_042L;
    private static final String FIXED42_BASELINE_SHA256 =
            "3e1f72c2d1214b491fb505b5ea85ccc507d2478288066ff9cf846c5924d1805c";
    private static final long FIXED42_BASELINE_SIZE = 88_583_041L;
    private static final String FIXED42_BASELINE_SOURCE =
            "ae9b35f8513c9f7e203508f2c95f1f99d77ddcf5";
    private static final String FIXED42_BASELINE_MANIFEST_SHA256 =
            "26fedf40c35011ecf3edaa29462c18f04301dafae7dd9e3808e1ea1e2a3001a8";
    private static final String FIXED42_BASELINE_VERIFICATION_SHA256 =
            "a87360645d7700f7c2ff9a99629d714b7d126fbe5d66a9a2e44a10baad42c4dc";
    private static final long FIXED42_BASELINE_BUILD_RUN = 40_025_606_020L;
    private static final String FIXED42_TARGET_VERSION = "2.3.59";
    private static final long FIXED42_TARGET_VERSION_CODE = 2_003_059L;
    private static final String FIXED42_TARGET_SHA256 =
            "5fe550e66658f3c9ae172c087c656d69e126af2892df05ca15e7e021594dae47";
    private static final long FIXED42_TARGET_SIZE = 88_644_481L;
    private static final String FIXED42_TARGET_SOURCE =
            "ac885bb98b2672614beb801b5aea11eb2f98ab40";
    private static final String FIXED42_TARGET_MANIFEST_SHA256 =
            "8d0f680abc7d52cd467ef79b3fd860e18c7e1dd15a7c5fd765a9d3941c974af6";
    private static final String FIXED42_TARGET_VERIFICATION_SHA256 =
            "28ccb986f613b68917a907b5dd9632c02e98185413ce9d09bc745eb564541294";
    private static final long FIXED42_TARGET_BUILD_RUN = 40_169_716_770L;
    private static final String FIXED42_UPDATER_SHA256 =
            "129df15e095ed5ce8933d17ab9a0329da79244e14ac046df18c3fad32e01163d";
    private static final String AUTOMATIC_BASELINE_VERSION = "2.3.27";
    private static final long AUTOMATIC_BASELINE_VERSION_CODE = 2_003_027L;
    private static final String AUTOMATIC_BASELINE_SHA256 =
            "f3e983929db9fb32ed42b9779d94f2f8492c1cf4fae3e0cd29eee91a9492e0eb";
    private static final long AUTOMATIC_BASELINE_SIZE = 88_558_465L;
    private static final long MINIMUM_AUTOMATIC_TARGET_VERSION_CODE = 2_003_031L;
    private static final String AUTOMATIC_PROFILE_NAME = "Auto OTA Profile";
    private static final String FIXED42_PROFILE_NAME = "Fixed42OTA59Marker";
    private static final String FIXED42_APPEARANCE_SUMMARY = "Quiet focus";
    private static final String AUTOMATIC_APPEARANCE = "Apply Quiet focus style";
    private static final String AUTOMATIC_SAMPLE_TITLE = "Blade Runner 2049";
    private static final String AUTOMATIC_FOLDER_NAME = "Automatic OTA public upgrade";
    private static final String DETAIL_DIALOG_CLASS = "android.app.Dialog";
    private static final long AUTOMATIC_CHECK_BOUND_MS = 55_000L;
    private static final int ABSENT_SETTLED_SAMPLES = 3;
    private static final int MAX_INITIAL_ENABLE_QUERY_TIMINGS = 32;
    private static final int FIXED42_SEED_SCROLL_ACTION_LIMIT = 16;
    private static final long FIXED42_SEED_SCROLL_BOUND_MS = 45_000L;
    private static final long FIXED42_SEED_SCROLL_SETTLE_MS = 600L;
    private static final int FIXED42_SEED_AX_NODE_LIMIT = 512;
    private static final int FIXED42_SEED_AX_CHILD_LIMIT = 128;
    private static final int FIXED42_LAUNCHER_ANCESTOR_LIMIT = 16;
    private static final int FIXED42_LAUNCHER_NODE_LIMIT = 256;
    private static final int FIXED42_LAUNCHER_CHILD_LIMIT = 128;
    private static final String QUICK_SETUP_ACKNOWLEDGEMENT =
            "I understand the privacy, reliability, catalog, and playback limits and want to use Quick setup.";

    private static final String[] TIER_TITLES = {
            "Welcome to YAWF Stream", "Bring your own keys", "You're set"
    };
    private static final String[] WELCOME_TITLES = {
            "Welcome to YAWF Stream",
            "How it works",
            "A one-time setup",
            "Find something to watch",
            "Move fast",
            "Keep your place",
            "You're all set"
    };
    private static final String[] FIXED42_VERTICAL_SEED_ANCHORS = {
            "Sample catalog", "Top 10 Movies", "Top 10 TV Shows", "Popular Movies"
    };
    private static final String[] FIXED42_POPULAR_SEED_CARDS = {
            "Avengers: Infinity War", "The Avengers", "Mad Max: Fury Road",
            "Blade Runner 2049"
    };

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private int captureIndex;
    private boolean productPermissionPageObserved;
    private boolean permissionEnabledByTest;
    private boolean installerSuccessObserved;
    private boolean installerOpenObserved;
    private boolean updatedProductObserved;
    private boolean permissionCleanupObserved;
    private boolean permissionBackReturnObserved;
    private String otaMode;
    private boolean legacyManualReconsentUsed;
    private String admittedBaselineVersion;
    private String admittedTargetVersion;
    private String admittedTargetSha256;
    private long admittedTargetVersionCode;
    private long admittedTargetSize;
    private String admittedTargetSourceRevision;
    private String admittedTargetManifestSha256;
    private String admittedTargetVerificationSha256;
    private long admittedTargetBuildRun;
    private boolean targetIdentityAdmitted;
    private boolean initialManualProgressObserved;
    private boolean initialManualCancelWon;
    private boolean initialEnableCheckingTitleObserved;
    private boolean initialEnableCheckingMessageObserved;
    private boolean initialEnableCancelObserved;
    private boolean initialEnableTerminalResultExcludedBeforeCancel;
    private int initialEnableCancelSelections;
    private boolean initialEnableCancelWon;
    private int initialEnableSettledResultExclusionSamples;
    private final List<String> initialEnableQueryGroupTimings = new ArrayList<>();
    private int initialEnableQueryGroupTimingDrops;
    private long initialEnableLastQueryTimingUptimeMs = -1L;
    private int initialEnableQueryTimingSequence;
    private int preOfferManualDiscoveries;
    private boolean weeklyOnAtDeferredOffer;
    private boolean automaticOfferAbsentSameForeground;
    private boolean deferredAutomaticOfferObserved;
    private boolean automaticDiscoveryObserved;
    private boolean sampleCatalogFixtureUsed;
    private boolean profilePersistedWarm;
    private boolean appearancePersistedWarm;
    private boolean watchlistPersistedWarm;
    private boolean folderPersistedWarm;
    private boolean profilePersistedAfterTaskRelaunch;
    private boolean appearancePersistedAfterTaskRelaunch;
    private boolean watchlistPersistedAfterTaskRelaunch;
    private boolean folderPersistedAfterTaskRelaunch;
    private boolean visibleTaskDismissalObserved;
    private int visibleTaskDismissalSwipes;
    private int visibleLauncherReturnOrdinal;
    private int automaticTriggerReturnOrdinal;
    private int deferredOfferReturnOrdinal;
    private int automaticOfferOrdinal;
    private int postInstallInspectionOrdinal;
    private int postInstallManualInspectionChecks;
    private boolean postInstallExactUpToDate59Observed;
    private boolean weeklyOnAfterUpdate;
    private int postInstallNativeOkClosures;
    private int postInstallNativeCancelClosures;
    private int productUpdateSelections;
    private boolean profileNameInitialDistinct;
    private int profileNameSetTextActions;
    private boolean profileNameImmediateExact;
    private boolean profileNameCloseReopenExact;
    private int profileNamePostInstallSetTextActions;
    private String admittedBaselineSourceRevision;
    private String admittedBaselineManifestSha256;
    private String admittedBaselineVerificationSha256;
    private long admittedBaselineBuildRun;
    private String admittedUpdaterSourceSha256;
    private String profileNameBeforeUpdate;
    private int permissionCleanupToggleSelections;
    private int productInstallSelections;
    private int systemUpdateSelections;
    private int systemOpenSelections;

    @Test
    public void updateOfficialPublicBaselineThroughNativeUi() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        Bundle arguments = InstrumentationRegistry.getArguments();
        otaMode = arguments.getString("otaMode", "strict");
        String expectedSubdir = isFixed42AutomaticMode()
                ? FIXED42_EVIDENCE_SUBDIR
                : (isAutomaticMode() ? AUTOMATIC_EVIDENCE_SUBDIR : EVIDENCE_SUBDIR);
        String subdir = arguments.getString("evidenceSubdir", expectedSubdir);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(subdir).matches());
        assertEquals("Unexpected evidence subdirectory", expectedSubdir, subdir);
        if (isAutomaticMode()) {
            admitAutomaticTargetIdentity(arguments);
        } else {
            assertTrue(
                    "Fixed OTA arguments do not match the reviewed release",
                    OtaFlowPolicy.matchesVersionPins(
                            arguments.getString("baselineVersion", ""),
                            arguments.getString("targetVersion", ""),
                            parseLongArgument(arguments, "targetVersionCode"),
                            arguments.getString("targetSha256", ""),
                            parseLongArgument(arguments, "targetSize"),
                            arguments.getString("signerSha256", "")));
            assertTrue(
                    "OTA mode must be strict or explicitly legacy-manual-reconsent",
                    "strict".equals(otaMode) || "legacy-manual-reconsent".equals(otaMode));
            admittedBaselineVersion = OtaFlowPolicy.BASELINE_VERSION;
            admittedTargetVersion = OtaFlowPolicy.TARGET_VERSION;
            admittedTargetVersionCode = OtaFlowPolicy.TARGET_VERSION_CODE;
            admittedTargetSha256 = OtaFlowPolicy.TARGET_SHA256;
            admittedTargetSize = OtaFlowPolicy.TARGET_SIZE;
            targetIdentityAdmitted = true;
        }

        Context targetContext = instrumentation.getTargetContext();
        File internalFiles = targetContext.getFilesDir();
        assertNotNull("Internal files directory unavailable", internalFiles);
        evidenceDir = new File(internalFiles, subdir);
        assertTrue("Could not create evidence directory", evidenceDir.mkdirs() || evidenceDir.isDirectory());

        Throwable primary = null;
        try {
            if (isAutomaticMode()) {
                runAutomaticFlow();
            } else {
                runHistoricalFlow();
            }
        } catch (Throwable caught) {
            primary = caught;
            try {
                capture("failure");
            } catch (Throwable captureFailure) {
                log("Failure capture unavailable: " + captureFailure.getClass().getSimpleName());
            }
        }

        try {
            if (isAutomaticMode()) {
                cleanupUnknownSourcePermissionThroughVisibleSettings();
            } else {
                cleanupUnknownSourcePermission();
            }
        } catch (Throwable cleanupFailure) {
            log("Permission cleanup failed: " + safe(cleanupFailure.getMessage()));
            if (primary == null) {
                primary = cleanupFailure;
            }
        }

        String outcome = primary == null && permissionCleanupObserved ? "passed" : "failed";
        writeActionLog();
        writeReceipt(outcome, primary);
        if (primary != null) {
            throw primary;
        }
        assertTrue("YAWF unknown-source permission was not visibly cleaned up", permissionCleanupObserved);
    }

    private boolean isAutomaticMode() {
        return AUTOMATIC_OTA_MODE.equals(otaMode) || isFixed42AutomaticMode();
    }

    private boolean isFixed42AutomaticMode() {
        return FIXED42_AUTOMATIC_OTA_PROFILE.equals(otaMode);
    }

    private void admitAutomaticTargetIdentity(Bundle arguments) {
        admittedBaselineVersion = arguments.getString("baselineVersion", "");
        admittedTargetVersion = arguments.getString("targetVersion", "");
        admittedTargetVersionCode = parseLongArgument(arguments, "targetVersionCode");
        admittedTargetSha256 = arguments.getString("targetSha256", "");
        admittedTargetSize = parseLongArgument(arguments, "targetSize");
        admittedTargetSourceRevision = arguments.getString("targetSourceRevision", "");
        admittedTargetManifestSha256 = arguments.getString("targetManifestSha256", "");
        admittedTargetVerificationSha256 = arguments.getString("targetVerificationSha256", "");
        admittedTargetBuildRun = parseLongArgument(arguments, "targetBuildRun");

        if (isFixed42AutomaticMode()) {
            admittedBaselineSourceRevision = arguments.getString("baselineSourceRevision", "");
            admittedBaselineManifestSha256 = arguments.getString("baselineManifestSha256", "");
            admittedBaselineVerificationSha256 =
                    arguments.getString("baselineVerificationSha256", "");
            admittedBaselineBuildRun = parseLongArgument(arguments, "baselineBuildRun");
            admittedUpdaterSourceSha256 = arguments.getString("updaterSourceSha256", "");
            assertEquals("Fixed42 runtime profile mismatch", FIXED42_AUTOMATIC_OTA_PROFILE,
                    arguments.getString("runtimeProfile", ""));
            assertEquals("Fixed42 baseline version mismatch",
                    FIXED42_BASELINE_VERSION, admittedBaselineVersion);
            assertEquals("Fixed42 baseline versionCode mismatch",
                    FIXED42_BASELINE_VERSION_CODE,
                    parseLongArgument(arguments, "baselineVersionCode"));
            assertEquals("Fixed42 baseline APK digest mismatch",
                    FIXED42_BASELINE_SHA256, arguments.getString("baselineSha256", ""));
            assertEquals("Fixed42 baseline APK size mismatch",
                    FIXED42_BASELINE_SIZE, parseLongArgument(arguments, "baselineSize"));
            assertEquals("Fixed42 baseline source mismatch",
                    FIXED42_BASELINE_SOURCE, admittedBaselineSourceRevision);
            assertEquals("Fixed42 baseline manifest digest mismatch",
                    FIXED42_BASELINE_MANIFEST_SHA256, admittedBaselineManifestSha256);
            assertEquals("Fixed42 baseline verification digest mismatch",
                    FIXED42_BASELINE_VERIFICATION_SHA256, admittedBaselineVerificationSha256);
            assertEquals("Fixed42 baseline build run mismatch",
                    FIXED42_BASELINE_BUILD_RUN, admittedBaselineBuildRun);
            assertEquals("Fixed42 target version mismatch",
                    FIXED42_TARGET_VERSION, admittedTargetVersion);
            assertEquals("Fixed42 target versionCode mismatch",
                    FIXED42_TARGET_VERSION_CODE, admittedTargetVersionCode);
            assertEquals("Fixed42 target APK name mismatch",
                    "YAWF.Stream_Android_2.3.59.apk",
                    arguments.getString("targetApkName", ""));
            assertEquals("Fixed42 target APK digest mismatch",
                    FIXED42_TARGET_SHA256, admittedTargetSha256);
            assertEquals("Fixed42 target APK size mismatch",
                    FIXED42_TARGET_SIZE, admittedTargetSize);
            assertEquals("Fixed42 target source mismatch",
                    FIXED42_TARGET_SOURCE, admittedTargetSourceRevision);
            assertEquals("Fixed42 target manifest digest mismatch",
                    FIXED42_TARGET_MANIFEST_SHA256, admittedTargetManifestSha256);
            assertEquals("Fixed42 target verification digest mismatch",
                    FIXED42_TARGET_VERIFICATION_SHA256, admittedTargetVerificationSha256);
            assertEquals("Fixed42 target build run mismatch",
                    FIXED42_TARGET_BUILD_RUN, admittedTargetBuildRun);
            assertEquals("Fixed42 updater source digest mismatch",
                    FIXED42_UPDATER_SHA256, admittedUpdaterSourceSha256);
            assertEquals("Fixed42 signer continuity mismatch",
                    OtaFlowPolicy.SIGNER_SHA256, arguments.getString("signerSha256", ""));
            assertEquals("Fixed42 public release admission was not explicit",
                    "true", arguments.getString("targetPublicRelease", ""));
            targetIdentityAdmitted = true;
            return;
        }

        assertEquals("Automatic baseline version mismatch",
                AUTOMATIC_BASELINE_VERSION, admittedBaselineVersion);
        assertEquals("Automatic baseline versionCode mismatch",
                AUTOMATIC_BASELINE_VERSION_CODE,
                parseLongArgument(arguments, "baselineVersionCode"));
        assertEquals("Automatic baseline APK digest mismatch",
                AUTOMATIC_BASELINE_SHA256, arguments.getString("baselineSha256", ""));
        assertEquals("Automatic baseline APK size mismatch",
                AUTOMATIC_BASELINE_SIZE, parseLongArgument(arguments, "baselineSize"));
        assertTrue("Automatic target version was not independently supplied",
                VERSION.matcher(admittedTargetVersion).matches());
        assertTrue("Automatic target versionCode does not follow immutable 2.3.30",
                admittedTargetVersionCode >= MINIMUM_AUTOMATIC_TARGET_VERSION_CODE);
        assertEquals("Automatic target versionCode mapping mismatch",
                versionCodeFor(admittedTargetVersion), admittedTargetVersionCode);
        assertEquals("Automatic target APK name mismatch",
                "YAWF.Stream_Android_" + admittedTargetVersion + ".apk",
                arguments.getString("targetApkName", ""));
        assertTrue("Automatic target APK digest was not independently supplied",
                LOWER_SHA256.matcher(admittedTargetSha256).matches()
                        && !AUTOMATIC_BASELINE_SHA256.equals(admittedTargetSha256));
        assertTrue("Automatic target APK size was not independently supplied", admittedTargetSize > 0L);
        assertEquals("Automatic target signer continuity mismatch",
                OtaFlowPolicy.SIGNER_SHA256, arguments.getString("signerSha256", ""));
        assertTrue("Automatic target source revision was not independently supplied",
                LOWER_REVISION.matcher(admittedTargetSourceRevision).matches());
        assertTrue("Automatic target manifest asset digest was not independently supplied",
                LOWER_SHA256.matcher(admittedTargetManifestSha256).matches());
        assertTrue("Automatic target verification asset digest was not independently supplied",
                LOWER_SHA256.matcher(admittedTargetVerificationSha256).matches());
        assertTrue("Automatic target build run was not independently supplied",
                admittedTargetBuildRun > 0L);
        assertEquals("Automatic public release admission was not explicit",
                "true", arguments.getString("targetPublicRelease", ""));
        targetIdentityAdmitted = true;
    }

    private void runAutomaticFlow() throws Exception {
        assertNoBindingTerms();
        device.wakeUp();
        launchProductFromVisibleLauncher("public " + admittedBaselineVersion + " baseline");

        waitFor(By.text("Enable Android update checks?"), UI_WAIT_MS,
                "initial native update consent");
        capture("automatic-initial-consent");
        if (isFixed42AutomaticMode()) {
            enableAndCancelInitialFixed42CheckNoIdle();
        } else {
            click(
                    By.res("android", "button1")
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                            .text(Pattern.compile("\\AEnable\\z", Pattern.CASE_INSENSITIVE)),
                    "Enable",
                    SHORT_WAIT_MS,
                    true);
            cancelInitialManualCheckBeforeResult();
        }

        completeNormalSetupExact();
        if (isFixed42AutomaticMode()) {
            seedFixed42MeaningfulLocalState();
            assertFixed42MeaningfulLocalState("before-update", false);
        } else {
            seedMeaningfulLocalState();
            assertMeaningfulLocalState("before-update", false);
        }

        automaticTriggerReturnOrdinal =
                returnToProductThroughVisibleLauncher("automatic-check-trigger");
        assertAutomaticOfferAbsentForBoundedCheck();
        deferredOfferReturnOrdinal =
                returnToProductThroughVisibleLauncher("deferred-offer-return");

        String offerTitle = "YAWF Stream " + admittedTargetVersion + " is available";
        String offerMessage =
                "Download the signed Android update now? Android will ask again before installing it.";
        waitFor(By.text(offerTitle), UI_WAIT_MS, "deferred exact public target offer");
        waitFor(By.text(offerMessage), SHORT_WAIT_MS, "deferred exact offer message");
        deferredAutomaticOfferObserved = true;
        if (isFixed42AutomaticMode()) {
            automaticDiscoveryObserved = initialEnableCancelWon
                    && automaticOfferAbsentSameForeground
                    && deferredAutomaticOfferObserved
                    && AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(
                            automaticTriggerReturnOrdinal,
                            deferredOfferReturnOrdinal,
                            automaticOfferAbsentSameForeground,
                            false);
        } else {
            automaticDiscoveryObserved = initialManualCancelWon
                    && automaticOfferAbsentSameForeground
                    && deferredAutomaticOfferObserved
                    && AutomaticOtaDriverChecks.deferredOfferIsFromLaterReturn(
                            automaticTriggerReturnOrdinal,
                            deferredOfferReturnOrdinal,
                            automaticOfferAbsentSameForeground,
                            false);
        }
        UiObject2 weekly = waitFor(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"),
                SHORT_WAIT_MS,
                "retained weekly checkbox on deferred offer");
        assertTrue("Initial Enable did not retain automatic checks", weekly.isChecked());
        if (isFixed42AutomaticMode()) {
            weeklyOnAtDeferredOffer = true;
            automaticOfferOrdinal = deferredOfferReturnOrdinal;
            assertEquals("Fixed42 automatic profile forbids pre-offer manual discovery",
                    0, preOfferManualDiscoveries);
        }
        capture("automatic-deferred-target-offer");
        productUpdateSelections++;
        assertEquals("Product Update must be selected exactly once", 1, productUpdateSelections);
        click(nativeProductButton(OtaFlowPolicy.UPDATE), "Update", SHORT_WAIT_MS, true);

        waitFor(By.text("Downloading update"), UI_WAIT_MS, "DownloadManager progress dialog");
        waitFor(By.textContains("Android is downloading the signed APK."),
                SHORT_WAIT_MS, "signed APK progress");
        capture("automatic-downloading");

        String readyMessage = "YAWF Stream " + admittedTargetVersion
                + " passed all checks. Android will show the system installer.";
        waitFor(By.text("Update ready to install"), DOWNLOAD_WAIT_MS,
                "verified automatic update ready dialog");
        waitFor(By.text(readyMessage), SHORT_WAIT_MS, "verified automatic update ready message");
        capture("automatic-ready-to-install");
        productInstallSelections++;
        assertEquals("Product Install must be selected exactly once", 1, productInstallSelections);
        click(nativeProductButton(OtaFlowPolicy.INSTALL), "Install", SHORT_WAIT_MS, true);

        enterUnknownSourcePermission();
        assertFalse("Automatic mode forbids legacy manual reconsent", legacyManualReconsentUsed);
        assertEquals("Permission Back must not require another product Install",
                1, productInstallSelections);
        confirmSystemInstaller();

        waitFor(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE), UI_WAIT_MS,
                "updated product after system Open");
        waitFor(By.text("Discover"), UI_WAIT_MS, "updated Discover");
        updatedProductObserved = true;
        capture("automatic-updated-product-open");
        if (isFixed42AutomaticMode()) {
            assertFixed42MeaningfulLocalState("warm-after-update", true);
        } else {
            assertMeaningfulLocalState("warm-after-update", true);
        }

        dismissVisibleRecentTaskAndRelaunchThroughLauncher();
        if (isFixed42AutomaticMode()) {
            assertFixed42MeaningfulLocalState("after-task-relaunch", true);
        } else {
            assertMeaningfulLocalState("after-task-relaunch", true);
        }
        assertFalse("FirstRun returned after automatic OTA",
                hasAnyWithoutIdleDelay(By.text("How do you want to use YAWF Stream?")));
        assertFalse("Setup reminder returned after automatic OTA", hasSetupReminder());
        assertTrue("Automatic discovery evidence was incomplete", automaticDiscoveryObserved);
        assertTrue("Bundled Sample catalog classification was not retained", sampleCatalogFixtureUsed);
        assertTrue("Warm local persistence evidence was incomplete",
                profilePersistedWarm && appearancePersistedWarm
                        && watchlistPersistedWarm && folderPersistedWarm);
        assertTrue("Task-relaunch local persistence evidence was incomplete",
                visibleTaskDismissalObserved
                        && profilePersistedAfterTaskRelaunch
                        && appearancePersistedAfterTaskRelaunch
                        && watchlistPersistedAfterTaskRelaunch
                        && folderPersistedAfterTaskRelaunch);
        if (isFixed42AutomaticMode()) {
            inspectFixed42PostInstallAutomaticRetention();
        }
    }

    private void cancelInitialManualCheckBeforeResult() throws IOException {
        String progressTitle = "Checking for updates";
        String progressMessage = "Checking the official YAWF Stream Android release channel.";
        waitFor(By.text(progressTitle), SHORT_WAIT_MS, "initial manual progress title");
        waitFor(By.text(progressMessage), SHORT_WAIT_MS, "initial manual progress message");
        initialManualProgressObserved = true;
        assertNoInitialManualResultVisible();
        capture("automatic-initial-manual-check");
        click(
                By.res("android", "button2")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .text(Pattern.compile("\\ACancel\\z", Pattern.CASE_INSENSITIVE)),
                "Cancel initial manual check",
                SHORT_WAIT_MS,
                true);
        assertTrue("Initial manual progress dialog did not close after Cancel",
                device.wait(Until.gone(By.text(progressTitle)), SHORT_WAIT_MS));
        int absent = 0;
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoInitialManualResultVisible();
            if (++absent >= ABSENT_SETTLED_SAMPLES) {
                initialManualCancelWon = true;
                log("Initial Enable manual check was visibly cancelled before any result");
                return;
            }
            SystemClock.sleep(250);
        }
        fail("Initial manual cancellation did not settle");
    }

    private void enableAndCancelInitialFixed42CheckNoIdle() throws IOException {
        String progressTitle = "Checking for updates";
        String progressMessage = "Checking the official YAWF Stream Android release channel.";
        String[] progressTexts = {progressTitle, progressMessage};
        String[] terminalTexts = {
                "YAWF Stream is up to date",
                "Update check unavailable",
                "YAWF Stream " + admittedTargetVersion + " is available"
        };
        BySelector enableSelector = By.res("android", "button1")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.Button")
                .text(Pattern.compile("\\AEnable\\z", Pattern.CASE_INSENSITIVE))
                .clickable(true)
                .enabled(true);
        BySelector progressSelector = nativeDialogTextGroup(progressTexts);
        BySelector terminalSelector = nativeDialogTextGroup(terminalTexts);
        BySelector cancelSelector = By.res("android", "button2")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.Button")
                .text(Pattern.compile("\\ACancel\\z", Pattern.CASE_INSENSITIVE))
                .clickable(true)
                .enabled(true);
        Configurator configurator = Configurator.getInstance();
        long previousIdleTimeout = configurator.getWaitForIdleTimeout();
        long enableClickUptimeMs = -1L;
        long checkingObservedUptimeMs = -1L;
        long cancelSelectedUptimeMs = -1L;
        long cancelSettledUptimeMs = -1L;
        boolean cancellationSettled = false;
        configurator.setWaitForIdleTimeout(0L);
        try {
            assertTrue("Initial Enable cache could not be refreshed before safety guard",
                    instrumentation.getUiAutomation().clearCache());
            List<UiObject2> enables = device.findObjects(enableSelector);
            assertEquals("Initial Enable was absent or ambiguous before safety guard",
                    1, enables.size());
            assertNoBindingTermsAtCurrentIdlePolicy();
            assertTrue("Initial Enable cache could not be refreshed after safety guard",
                    instrumentation.getUiAutomation().clearCache());
            List<UiObject2> freshEnables = device.findObjects(enableSelector);
            assertEquals("Initial Enable disappeared or became ambiguous after safety guard",
                    1, freshEnables.size());
            enableClickUptimeMs = SystemClock.uptimeMillis();
            freshEnables.get(0).click();
            log("Selected one exact native Enable with UiAutomator idle waiting disabled");

            long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
            while (SystemClock.uptimeMillis() < deadline) {
                boolean cacheCleared = instrumentation.getUiAutomation().clearCache();
                if (!cacheCleared) {
                    SystemClock.sleep(100);
                    continue;
                }
                Fixed42CriticalQueryGroupPolicy.Counts terminalCounts =
                        queryFixed42CriticalTextGroup(
                                terminalSelector, terminalTexts, "checking-terminal");
                assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(terminalCounts);
                Fixed42CriticalQueryGroupPolicy.Counts progressCounts =
                        queryFixed42CriticalTextGroup(
                                progressSelector, progressTexts, "checking-progress");
                List<UiObject2> cancels = queryFixed42CriticalCancelGroup(
                        cancelSelector, "checking-cancel");
                assertTrue("Initial Enable CHECKING title was ambiguous",
                        progressCounts.count(0) <= 1);
                assertTrue("Initial Enable CHECKING message was ambiguous",
                        progressCounts.count(1) <= 1);
                assertTrue("Initial Enable Cancel was ambiguous", cancels.size() <= 1);
                if (Fixed42CriticalQueryGroupPolicy.isInitialCheckingReady(
                        progressCounts, terminalCounts, cancels.size())) {
                    UiObject2 cancel = cancels.get(0);
                    assertTrue("Initial Enable Cancel was disabled", cancel.isEnabled());
                    assertTrue("Initial Enable Cancel was not clickable", cancel.isClickable());
                    initialEnableCheckingTitleObserved = true;
                    initialEnableCheckingMessageObserved = true;
                    initialEnableCancelObserved = true;
                    initialEnableTerminalResultExcludedBeforeCancel = true;
                    checkingObservedUptimeMs = SystemClock.uptimeMillis();
                    break;
                }
                SystemClock.sleep(100);
            }
            assertTrue("Initial Enable did not expose exact CHECKING title",
                    initialEnableCheckingTitleObserved);
            assertTrue("Initial Enable did not expose exact CHECKING message",
                    initialEnableCheckingMessageObserved);
            assertTrue("Initial Enable did not expose one native Cancel",
                    initialEnableCancelObserved);

            assertTrue("Initial Enable cache could not be refreshed before Cancel",
                    instrumentation.getUiAutomation().clearCache());
            Fixed42CriticalQueryGroupPolicy.Counts freshTerminalCounts =
                    queryFixed42CriticalTextGroup(
                            terminalSelector, terminalTexts, "fresh-terminal");
            assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(freshTerminalCounts);
            List<UiObject2> freshCancels = queryFixed42CriticalCancelGroup(
                    cancelSelector, "fresh-cancel");
            Fixed42CriticalQueryGroupPolicy.assertFreshCancelReady(
                    freshTerminalCounts, freshCancels.size());
            assertEquals("Initial Enable Cancel disappeared or became ambiguous before selection",
                    1, freshCancels.size());
            initialEnableCancelSelections++;
            assertEquals("Initial Enable Cancel must be selected exactly once",
                    1, initialEnableCancelSelections);
            freshCancels.get(0).click();
            cancelSelectedUptimeMs = SystemClock.uptimeMillis();
            log("Selected one exact native Cancel during the fresh initial Enable check");

            deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
            int settled = 0;
            while (SystemClock.uptimeMillis() < deadline) {
                boolean cacheCleared = instrumentation.getUiAutomation().clearCache();
                if (!cacheCleared) {
                    settled = 0;
                    SystemClock.sleep(100);
                    continue;
                }
                Fixed42CriticalQueryGroupPolicy.Counts terminalCounts =
                        queryFixed42CriticalTextGroup(
                                terminalSelector, terminalTexts, "settled-terminal");
                assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(terminalCounts);
                Fixed42CriticalQueryGroupPolicy.Counts progressCounts =
                        queryFixed42CriticalTextGroup(
                                progressSelector, progressTexts, "settled-progress");
                List<UiObject2> cancels = queryFixed42CriticalCancelGroup(
                        cancelSelector, "settled-cancel");
                boolean progressGone = Fixed42CriticalQueryGroupPolicy.isSettledAbsent(
                        progressCounts, terminalCounts, cancels.size());
                if (progressGone) {
                    settled++;
                    if (settled >= ABSENT_SETTLED_SAMPLES) {
                        initialEnableSettledResultExclusionSamples = settled;
                        initialEnableCancelWon = true;
                        cancelSettledUptimeMs = SystemClock.uptimeMillis();
                        cancellationSettled = true;
                        break;
                    }
                } else {
                    settled = 0;
                }
                SystemClock.sleep(100);
            }
        } finally {
            configurator.setWaitForIdleTimeout(previousIdleTimeout);
        }
        assertTrue("Initial Enable cancellation did not settle before a terminal result",
                cancellationSettled);
        assertTrue("Initial Enable timing observations were incomplete",
                enableClickUptimeMs >= 0L
                        && checkingObservedUptimeMs >= enableClickUptimeMs
                        && cancelSelectedUptimeMs >= checkingObservedUptimeMs
                        && cancelSettledUptimeMs >= cancelSelectedUptimeMs);
        log("Initial Enable no-idle timing checkingMs="
                + (checkingObservedUptimeMs - enableClickUptimeMs)
                + " cancelMs=" + (cancelSelectedUptimeMs - enableClickUptimeMs)
                + " settledMs=" + (cancelSettledUptimeMs - enableClickUptimeMs));
        capture("fixed42-initial-enable-cancel-settled");
        log("Initial Enable check cancellation settled before any terminal result");
    }

    private void assertNoInitialManualResultVisible() {
        assertFalse("Initial manual check returned up-to-date before Cancel",
                hasAnyWithoutIdleDelay(By.text("YAWF Stream is up to date")));
        assertFalse("Initial manual check returned failure before Cancel",
                hasAnyWithoutIdleDelay(By.text("Update check unavailable")));
        assertFalse("Initial manual check returned target offer before Cancel",
                hasAnyWithoutIdleDelay(By.text(
                        "YAWF Stream " + admittedTargetVersion + " is available")));
    }

    private void assertNoInitialEnableResultVisibleAtCurrentIdlePolicy(
            Fixed42CriticalQueryGroupPolicy.Counts terminalCounts) {
        assertEquals("Initial Enable check returned up-to-date before Cancel",
                0, terminalCounts.count(0));
        assertEquals("Initial Enable check returned failure before Cancel",
                0, terminalCounts.count(1));
        assertEquals("Initial Enable check returned target offer before Cancel",
                0, terminalCounts.count(2));
    }

    private void completeNormalSetupExact() throws IOException {
        advanceFixedTour(TIER_TITLES, "automatic-tier");
        waitFor(By.text("How do you want to use YAWF Stream?"), UI_WAIT_MS,
                "automatic FirstRun question");
        capture("automatic-first-run");
        clickWebButton(OtaFlowPolicy.QUICK_SETUP, "Quick setup", SHORT_WAIT_MS);
        waitFor(By.text("Continue without adding credentials"), UI_WAIT_MS,
                "automatic Quick setup notice");
        capture("automatic-quick-setup-notice");
        click(By.text(QUICK_SETUP_ACKNOWLEDGEMENT),
                "exact nonbinding Quick setup acknowledgement", SHORT_WAIT_MS, false);
        clickWebButton(OtaFlowPolicy.CONTINUE_QUICK_SETUP,
                "Continue with Quick setup", SHORT_WAIT_MS);
        waitFor(By.text("Discover"), UI_WAIT_MS, "Discover after automatic setup");
        advanceFixedTour(WELCOME_TITLES, "automatic-welcome");
        dismissSetupReminder();
        waitFor(By.text("Sample catalog"), UI_WAIT_MS, "clearly labelled bundled Sample catalog");
        sampleCatalogFixtureUsed = true;
        capture("automatic-sample-catalog");
    }

    private void assertAutomaticOfferAbsentForBoundedCheck() throws IOException {
        String offerTitle = "YAWF Stream " + admittedTargetVersion + " is available";
        long deadline = SystemClock.uptimeMillis() + AUTOMATIC_CHECK_BOUND_MS;
        int absent = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            if (hasAnyWithoutIdleDelay(By.text(offerTitle))) {
                fail("Automatic offer appeared in the triggering foreground instead of being deferred");
            }
            absent++;
            SystemClock.sleep(500);
        }
        assertTrue("Automatic same-foreground absence did not receive settled samples",
                absent >= ABSENT_SETTLED_SAMPLES);
        automaticOfferAbsentSameForeground = true;
        capture("automatic-offer-absent-trigger-foreground");
        log("Automatic offer remained absent for the bounded official check in its trigger foreground");
    }

    private void runHistoricalFlow() throws Exception {
        assertNoBindingTerms();
        device.wakeUp();
        launchProduct();

        waitFor(By.text("Enable Android update checks?"), UI_WAIT_MS, "initial native update consent");
        capture("initial-update-consent");
        click(nativeProductButton(OtaFlowPolicy.NOT_NOW), "Not now", SHORT_WAIT_MS, true);

        advanceFixedTour(TIER_TITLES, "tier");
        waitFor(By.text("How do you want to use YAWF Stream?"), UI_WAIT_MS, "FirstRun question");
        capture("first-run");
        clickWebButton(OtaFlowPolicy.QUICK_SETUP, "Quick setup", SHORT_WAIT_MS);
        waitFor(By.text("Continue without adding credentials"), UI_WAIT_MS, "Quick setup notice");
        capture("quick-setup-notice");
        click(
                By.textContains("I understand the privacy, reliability, catalog, and playback limits"),
                "nonbinding privacy acknowledgement",
                SHORT_WAIT_MS,
                false);
        clickWebButton(OtaFlowPolicy.CONTINUE_QUICK_SETUP, "Continue with Quick setup", SHORT_WAIT_MS);

        waitFor(By.text("Discover"), UI_WAIT_MS, "Discover after setup");
        advanceFixedTour(WELCOME_TITLES, "welcome");
        dismissSetupReminder();
        capture("discover-before-update");

        openSettingsAndAssertSimple("before-update");
        openHelpAndUpdates();
        tapVisibleAndroidUpdateCheckCard("android-update-card");

        waitFor(By.text("Check for Android updates?"), SHORT_WAIT_MS, "manual update consent");
        UiObject2 weekly = waitFor(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"),
                SHORT_WAIT_MS,
                "weekly automatic-check checkbox");
        assertFalse("Weekly checks unexpectedly started enabled", weekly.isChecked());
        capture("manual-update-consent");
        assertNoBindingTerms();
        weekly.click();
        waitForCheckedState(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"),
                true,
                "weekly automatic-check checkbox");
        click(nativeProductButton(OtaFlowPolicy.CHECK_NOW), "Check now", SHORT_WAIT_MS, true);

        String offerTitle = "YAWF Stream " + OtaFlowPolicy.TARGET_VERSION + " is available";
        String offerMessage =
                "Download the signed Android update now? Android will ask again before installing it.";
        waitFor(By.text(offerTitle), UI_WAIT_MS, "exact 2.3.26 offer");
        waitFor(By.text(offerMessage), SHORT_WAIT_MS, "exact signed-update offer message");
        assertTrue("Offer policy mismatch", OtaFlowPolicy.isExactOffer(offerTitle, offerMessage));
        weekly = waitFor(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"),
                SHORT_WAIT_MS,
                "retained weekly checkbox on offer");
        assertTrue("Weekly checks were not retained on the offer", weekly.isChecked());
        capture("target-offer");
        click(nativeProductButton(OtaFlowPolicy.UPDATE), "Update", SHORT_WAIT_MS, true);

        waitFor(By.text("Downloading update"), UI_WAIT_MS, "DownloadManager progress dialog");
        waitFor(By.textContains("Android is downloading the signed APK."), SHORT_WAIT_MS, "signed APK progress");
        capture("downloading");

        String readyMessage = "YAWF Stream " + OtaFlowPolicy.TARGET_VERSION
                + " passed all checks. Android will show the system installer.";
        waitFor(By.text("Update ready to install"), DOWNLOAD_WAIT_MS, "verified update ready dialog");
        waitFor(By.text(readyMessage), SHORT_WAIT_MS, "verified update ready message");
        assertTrue("Ready policy mismatch", OtaFlowPolicy.isExactReady("Update ready to install", readyMessage));
        capture("ready-to-install");
        click(nativeProductButton(OtaFlowPolicy.INSTALL), "Install", SHORT_WAIT_MS, true);

        enterUnknownSourcePermission();
        maybeLegacyManualReconsent();
        confirmSystemInstaller();

        waitFor(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE), UI_WAIT_MS, "updated product after system Open");
        waitFor(By.text("Discover"), UI_WAIT_MS, "updated Discover");
        updatedProductObserved = true;
        capture("updated-product-open");

        openSettingsAndAssertSimple("after-update");
        scrollUntilVisibleProductSemantic(
                "YAWF Stream v" + OtaFlowPolicy.TARGET_VERSION,
                "android.widget.TextView",
                false,
                Direction.DOWN);
        assertFalse(
                "FirstRun returned after OTA",
                hasAnyWithoutIdleDelay(By.text("How do you want to use YAWF Stream?")));
        assertFalse("Setup reminder returned after OTA", hasSetupReminder());
        openHelpAndUpdates();
        tapVisibleAndroidUpdateCheckCard(null);

        waitFor(By.text("YAWF Stream is up to date"), UI_WAIT_MS, "post-update no-newer title");
        String postMessage = "No newer signed Android phone release is available.";
        waitFor(By.text(postMessage), SHORT_WAIT_MS, "post-update no-newer message");
        assertTrue(
                "Post-update result policy mismatch",
                OtaFlowPolicy.isExactPostUpdateResult("YAWF Stream is up to date", postMessage));
        weekly = waitFor(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"),
                SHORT_WAIT_MS,
                "post-update retained weekly checkbox");
        assertTrue("Weekly automatic checks did not survive OTA", weekly.isChecked());
        capture("post-update-up-to-date");
        click(nativeProductButton(OtaFlowPolicy.OK), "OK", SHORT_WAIT_MS, true);
    }

    private void seedFixed42MeaningfulLocalState() throws IOException {
        openFixed42ProfileDialog();
        UiObject2 initialName = waitForFixed42ProfileNameField("initial profile name");
        String initialValue = initialName.getText();
        profileNameInitialDistinct = initialValue != null
                && !FIXED42_PROFILE_NAME.equals(initialValue);
        assertTrue("Fixed42 profile marker must differ from the observed initial value",
                profileNameInitialDistinct);
        profileNameSetTextActions++;
        assertEquals("Fixed42 profile marker admits exactly one setText action",
                1, profileNameSetTextActions);
        initialName.setText(FIXED42_PROFILE_NAME);
        UiObject2 immediateName = waitForFixed42ProfileNameField("immediate profile name read");
        profileNameImmediateExact = FIXED42_PROFILE_NAME.equals(immediateName.getText());
        assertTrue("Fixed42 profile marker was not immediately exact", profileNameImmediateExact);
        capture("fixed42-profile-name-immediate-exact");
        closeFixed42ProfileDialog("after the initial write");

        openFixed42ProfileDialog();
        UiObject2 reopenedName = waitForFixed42ProfileNameField("close-reopen profile name read");
        profileNameCloseReopenExact = FIXED42_PROFILE_NAME.equals(reopenedName.getText());
        assertTrue("Fixed42 profile marker was not exact after close and reopen",
                profileNameCloseReopenExact);
        capture("fixed42-profile-name-close-reopen-exact");
        closeFixed42ProfileDialog("after close-reopen verification");

        openSettingsFromProductNavigation();
        selectFixed42SettingsCategory("Appearance", "Choose a style");
        captureFixed42Appearance("fixed42-appearance-anchor");
        waitForFixed42AppearanceSummary("Midnight Studio");
        clickFreshFixed42AppearanceStyle(
                AUTOMATIC_APPEARANCE,
                "fixed42-appearance-after-first-scroll");
        waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY);
        navigateProductRoute("Discover");

        waitFor(By.text("Sample catalog"), UI_WAIT_MS, "Sample catalog classification");
        clickFixed42SampleThroughDiscoverRails();
        String detailDialogIdentity = AUTOMATIC_SAMPLE_TITLE + " details";
        waitForUniqueExactProductDialog(detailDialogIdentity, SHORT_WAIT_MS);
        UiObject2 watchlist = waitForFixed42DialogSemantic(
                detailDialogIdentity, "Watchlist", true, "Watchlist action");
        watchlist.click();
        waitForFixed42DialogSemantic(
                detailDialogIdentity, "In watchlist", true, "In watchlist state");
        device.pressBack();
        assertTrue("Fixed42 exact sample detail did not close",
                waitForUniqueExactProductDialogGone(detailDialogIdentity, SHORT_WAIT_MS));

        navigateProductRoute("Watchlist");
        waitForFixed42Semantic(AUTOMATIC_SAMPLE_TITLE, true, "watchlisted sample title");
        UiObject2 newFolder = waitForFixed42Semantic("+ New folder", true, "new folder action");
        newFolder.click();
        UiObject2 folderName = waitForFixed42Semantic(
                "New watchlist folder name", true, "new folder name field");
        assertEquals("Fixed42 folder-name field class mismatch",
                "android.widget.EditText", folderName.getClassName());
        folderName.setText(AUTOMATIC_FOLDER_NAME);
        waitForExactTextValue(folderName, AUTOMATIC_FOLDER_NAME, "seeded folder name");
        waitForFixed42Semantic("Save", true, "folder Save").click();
        waitForFixed42Semantic(AUTOMATIC_FOLDER_NAME, true, "saved custom folder");

        String moveLabel = "Move " + AUTOMATIC_SAMPLE_TITLE + " to folder";
        UiObject2 folderSelect = waitForFixed42FolderSelect(moveLabel, "All");
        folderSelect.click();
        click(
                By.text(AUTOMATIC_FOLDER_NAME)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckedTextView")
                        .enabled(true),
                AUTOMATIC_FOLDER_NAME,
                SHORT_WAIT_MS,
                true);
        waitForFixed42FolderSelect(moveLabel, AUTOMATIC_FOLDER_NAME);
        capture("fixed42-local-data-seeded");
    }

    private void clickFixed42SampleThroughDiscoverRails() {
        assertTrue("Two-axis sample seeding is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        assertTrue("Two-axis sample seeding requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        long startedAt = SystemClock.uptimeMillis();
        int completedActions = 0;
        int priorActionPhase = -1;
        Fixed42SeedPolicy.Observation beforeAction = null;

        while (Fixed42SeedPolicy.withinDeadline(startedAt, SystemClock.uptimeMillis())) {
            assertNoBindingTerms();
            Fixed42ReadyProof ready = null;
            try (Fixed42SeedSnapshot snapshot = observeFixed42SeedSnapshot()) {
                int phase = Fixed42SeedPolicy.phase(snapshot.observation);
                if (beforeAction != null) {
                    assertTrue("Fixed42 seed action made no fresh observable progress",
                            Fixed42SeedPolicy.didAdvance(
                                    priorActionPhase, beforeAction, snapshot.observation));
                    beforeAction = null;
                    priorActionPhase = -1;
                }
                log("Fixed42 seed observation action=" + completedActions
                        + " phase=" + Fixed42SeedPolicy.phaseName(phase)
                        + " main=" + fixed42Bounds(snapshot.mainBounds)
                        + " rail=" + fixed42Bounds(snapshot.railBounds)
                        + " navTop=" + snapshot.navigationTop);
                assertTrue("Fixed42 seed deadline elapsed before action",
                        Fixed42SeedPolicy.withinDeadline(
                                startedAt, SystemClock.uptimeMillis()));

                if (phase == Fixed42SeedPolicy.PHASE_READY) {
                    ready = new Fixed42ReadyProof(
                            snapshot.bladeBounds,
                            snapshot.railBounds,
                            snapshot.navigationTop);
                } else {
                    assertTrue("Fixed42 seed exceeded its shared action or time bound",
                            Fixed42SeedPolicy.mayScroll(
                                    completedActions,
                                    startedAt,
                                    SystemClock.uptimeMillis()));
                    AccessibilityNodeInfo node;
                    AccessibilityNodeInfo.AccessibilityAction action;
                    if (phase == Fixed42SeedPolicy.PHASE_VERTICAL) {
                        node = snapshot.mainContent;
                        action = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD;
                    } else {
                        assertEquals("Fixed42 horizontal seed action occurred out of order",
                                Fixed42SeedPolicy.PHASE_HORIZONTAL, phase);
                        node = snapshot.popularRail;
                        assertNotNull("Fresh Popular Movies rail was unavailable", node);
                        action = fixed42SupportsAction(
                                node,
                                AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT)
                                ? AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
                                : AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD;
                    }
                    performFixed42SeedScroll(node, action);
                    completedActions++;
                    priorActionPhase = phase;
                    beforeAction = snapshot.observation;
                    log("Performed fixed42 seed scroll action=" + completedActions
                            + " phase=" + Fixed42SeedPolicy.phaseName(phase));
                }
            }

            if (ready != null) {
                assertNoBindingTerms();
                assertTrue("Fixed42 seed deadline elapsed before fresh Blade click",
                        Fixed42SeedPolicy.withinDeadline(
                                startedAt, SystemClock.uptimeMillis()));
                clickFreshFixed42Blade(ready, startedAt);
                return;
            }
            device.waitForIdle(FIXED42_SEED_SCROLL_SETTLE_MS);
        }
        fail("Timed out within the fixed42 two-axis seed bound");
    }

    private void performFixed42SeedScroll(
            AccessibilityNodeInfo node,
            AccessibilityNodeInfo.AccessibilityAction action) {
        assertTrue("Raw accessibility scrolling is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        assertNotNull("Fixed42 seed scroll node was unavailable", node);
        int actionId = action.getId();
        assertTrue("Fixed42 seed admitted a non-scroll accessibility action",
                actionId
                                == AccessibilityNodeInfo.AccessibilityAction
                                        .ACTION_SCROLL_FORWARD.getId()
                        || actionId
                                == AccessibilityNodeInfo.AccessibilityAction
                                        .ACTION_SCROLL_RIGHT.getId());
        assertTrue("Fixed42 seed node did not expose the required scroll action",
                fixed42SupportsAction(node, action));
        assertTrue("Fixed42 seed public scroll action was rejected",
                node.performAction(actionId));
    }

    private Fixed42SeedSnapshot observeFixed42SeedSnapshot() {
        assertTrue("Fixed42 seed cache refresh requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fixed42 seed accessibility cache refresh failed",
                instrumentation.getUiAutomation().clearCache());
        AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
        assertNotNull("Fixed42 seed active accessibility root was unavailable", root);

        List<AccessibilityNodeInfo> owned = new ArrayList<>();
        List<Integer> parents = new ArrayList<>();
        boolean transferred = false;
        try {
            owned.add(root);
            parents.add(-1);
            for (int cursor = 0; cursor < owned.size(); cursor++) {
                AccessibilityNodeInfo node = owned.get(cursor);
                int childCount = node.getChildCount();
                assertTrue("Fixed42 seed node exceeded its child bound",
                        childCount >= 0 && childCount <= FIXED42_SEED_AX_CHILD_LIMIT);
                for (int childIndex = 0; childIndex < childCount; childIndex++) {
                    AccessibilityNodeInfo child = node.getChild(childIndex);
                    assertNotNull("Fixed42 seed snapshot returned a null child", child);
                    assertTrue("Fixed42 seed traversal exceeded its node bound",
                            owned.size() < FIXED42_SEED_AX_NODE_LIMIT);
                    for (AccessibilityNodeInfo existing : owned) {
                        if (existing.equals(child)) {
                            child.recycle();
                            fail("Fixed42 seed snapshot returned a duplicate node");
                        }
                    }
                    owned.add(child);
                    parents.add(cursor);
                }
            }

            List<Fixed42AxNode> nodes = new ArrayList<>();
            for (int index = 0; index < owned.size(); index++) {
                nodes.add(new Fixed42AxNode(owned.get(index), parents.get(index)));
            }
            int width = device.getDisplayWidth();
            int height = device.getDisplayHeight();
            String product = OtaFlowPolicy.PRODUCT_PACKAGE;

            int mainIndex = fixed42UniqueResource(nodes, "main-content");
            Fixed42AxNode main = nodes.get(mainIndex);
            boolean packageMatch = product.equals(main.packageName);
            boolean classMatch = "android.view.View".equals(main.className);
            boolean visible = main.visible;
            boolean scrollable = main.scrollable;
            boolean clickable = main.clickable;
            boolean enabled = main.enabled;
            Rect expectedMainBounds = new Rect(0, 0, width, height);
            boolean boundsMatch = main.bounds.equals(expectedMainBounds);
            boolean mainIdentityMatches = packageMatch
                    && classMatch
                    && visible
                    && scrollable
                    && !clickable
                    && enabled;
            if (!(mainIdentityMatches && boundsMatch)) {
                log("Fixed42 main-content proof failed"
                        + " packageMatch=" + packageMatch
                        + " classMatch=" + classMatch
                        + " visible=" + visible
                        + " scrollable=" + scrollable
                        + " clickable=" + clickable
                        + " enabled=" + enabled
                        + " boundsMatch=" + boundsMatch
                        + " rawLeft=" + main.bounds.left
                        + " rawTop=" + main.bounds.top
                        + " rawRight=" + main.bounds.right
                        + " rawBottom=" + main.bounds.bottom
                        + " expectedWidth=" + width
                        + " expectedHeight=" + height);
            }
            assertTrue("Fixed42 main-content identity changed",
                    mainIdentityMatches && boundsMatch);

            int discoverIndex = fixed42UniqueSemantic(nodes, "Discover page", true);
            Fixed42AxNode discover = nodes.get(discoverIndex);
            assertTrue("Fixed42 Discover page identity changed",
                    discover.matches(product, "android.view.View", false, false)
                            && fixed42IsDescendant(nodes, discoverIndex, mainIndex));

            int primaryIndex = fixed42UniqueSemantic(nodes, "Primary", true);
            Fixed42AxNode primary = nodes.get(primaryIndex);
            assertTrue("Fixed42 Primary navigation identity changed",
                    primary.matches(product, "android.view.View", false, false)
                            && fixed42FullBounds(primary.bounds, width, height));
            int navigationTop = primary.bounds.top;

            int headingIndex = fixed42UniqueSemantic(nodes, "Popular Movies", false);
            int popularSectionIndex = -1;
            int railIndex = -1;
            boolean railReady = false;
            if (headingIndex >= 0) {
                Fixed42AxNode heading = nodes.get(headingIndex);
                assertTrue("Fixed42 Popular Movies heading identity changed",
                        heading.matches(product, "android.widget.TextView", false, false));
                popularSectionIndex = heading.parentIndex;
                assertTrue("Popular Movies heading lacked its section parent",
                        popularSectionIndex >= 0);
                Fixed42AxNode section = nodes.get(popularSectionIndex);
                assertTrue("Popular Movies section identity changed",
                        section.matches(product, "android.view.View", false, false)
                                && fixed42IsDescendant(
                                        nodes, popularSectionIndex, discoverIndex));
                railIndex = fixed42UniqueScrollableDescendant(
                        nodes, popularSectionIndex, product);
                Fixed42AxNode rail = nodes.get(railIndex);
                assertTrue("Popular Movies rail escaped its visible section viewport",
                        section.bounds.contains(rail.bounds)
                                && discover.bounds.contains(rail.bounds)
                                && main.bounds.contains(rail.bounds));
                railReady = fixed42VisibleAboveNavigation(
                        heading.bounds, width, height, navigationTop)
                        && fixed42VisibleAboveNavigation(
                                rail.bounds, width, height, navigationTop);
            }

            int bladeIndex = fixed42UniqueSemantic(nodes, AUTOMATIC_SAMPLE_TITLE, false);
            boolean bladeInRail = false;
            boolean bladeReady = false;
            Rect bladeBounds = null;
            if (bladeIndex >= 0) {
                Fixed42AxNode blade = nodes.get(bladeIndex);
                assertTrue("Fixed42 Blade Runner identity changed",
                        blade.matches(product, "android.widget.Button", false, true));
                bladeInRail = railIndex >= 0
                        && fixed42IsDescendant(nodes, bladeIndex, railIndex);
                assertTrue("Fixed42 Blade Runner escaped the Popular Movies rail",
                        bladeInRail);
                bladeBounds = new Rect(blade.bounds);
                bladeReady = railReady
                        && fixed42VisibleAboveNavigation(
                                blade.bounds, width, height, navigationTop)
                        && nodes.get(railIndex).bounds.contains(blade.bounds);
            }

            int[] verticalTops = fixed42SemanticPositions(
                    nodes, FIXED42_VERTICAL_SEED_ANCHORS, true, -1, product);
            int[] cardLefts = fixed42SemanticPositions(
                    nodes, FIXED42_POPULAR_SEED_CARDS, false, railIndex, product);
            Fixed42SeedPolicy.Observation observation = new Fixed42SeedPolicy.Observation(
                    true,
                    1,
                    1,
                    headingIndex < 0 ? 0 : 1,
                    railIndex < 0 ? 0 : 1,
                    bladeIndex < 0 ? 0 : 1,
                    headingIndex < 0 || popularSectionIndex >= 0,
                    railIndex < 0 || nodes.get(railIndex).matches(
                            product, "android.view.View", true, false),
                    railReady,
                    bladeInRail,
                    bladeReady,
                    verticalTops,
                    cardLefts);
            Fixed42SeedPolicy.phase(observation);
            Fixed42SeedSnapshot snapshot = new Fixed42SeedSnapshot(
                    owned,
                    main.info,
                    railIndex < 0 ? null : nodes.get(railIndex).info,
                    main.bounds,
                    railIndex < 0 ? null : nodes.get(railIndex).bounds,
                    bladeBounds,
                    navigationTop,
                    observation);
            transferred = true;
            return snapshot;
        } finally {
            if (!transferred) fixed42RecycleNodes(owned);
        }
    }

    private void clickFreshFixed42Blade(Fixed42ReadyProof proof, long startedAt) {
        assertTrue("Fresh fixed42 Blade query requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fresh fixed42 Blade cache refresh failed",
                instrumentation.getUiAutomation().clearCache());
        List<UiObject2> candidates = fixed42FreshSemanticCandidates(
                null, AUTOMATIC_SAMPLE_TITLE, "android.widget.Button", true);
        assertEquals("Fresh exact Blade Runner button was absent or ambiguous",
                1, candidates.size());
        UiObject2 blade = candidates.get(0);
        assertTrue("Fresh Blade Runner button identity changed",
                OtaFlowPolicy.PRODUCT_PACKAGE.equals(blade.getApplicationPackage())
                        && "android.widget.Button".equals(blade.getClassName())
                        && fixed42SemanticEquals(
                                blade.getText(), blade.getContentDescription(),
                                AUTOMATIC_SAMPLE_TITLE)
                        && blade.isClickable()
                        && blade.isEnabled());
        Rect visibleBlade = blade.getVisibleBounds();
        assertEquals("Fresh Blade Runner bounds changed after guarded snapshot",
                proof.bladeBounds, visibleBlade);
        assertTrue("Fresh Blade Runner was clipped by its rail or navigation",
                proof.railBounds.contains(visibleBlade)
                        && visibleBlade.bottom <= proof.navigationTop);

        int matchingMainAncestors = 0;
        int matchingDiscoverAncestors = 0;
        int matchingRailAncestors = 0;
        UiObject2 freshRail = null;
        UiObject2 ancestor = blade.getParent();
        for (int depth = 0; ancestor != null && depth < 32; depth++) {
            if ("main-content".equals(ancestor.getResourceName())
                    && OtaFlowPolicy.PRODUCT_PACKAGE.equals(
                            ancestor.getApplicationPackage())
                    && "android.view.View".equals(ancestor.getClassName())
                    && ancestor.isScrollable()
                    && !ancestor.isClickable()
                    && ancestor.isEnabled()
                    && ancestor.getVisibleBounds().equals(
                            new Rect(0, 0, device.getDisplayWidth(), device.getDisplayHeight()))) {
                matchingMainAncestors++;
            }
            if (fixed42SemanticEquals(
                            ancestor.getText(), ancestor.getContentDescription(),
                            "Discover page")
                    && OtaFlowPolicy.PRODUCT_PACKAGE.equals(
                            ancestor.getApplicationPackage())
                    && "android.view.View".equals(ancestor.getClassName())
                    && !ancestor.isScrollable()
                    && !ancestor.isClickable()
                    && ancestor.isEnabled()
                    && fixed42FullBounds(
                            ancestor.getVisibleBounds(),
                            device.getDisplayWidth(),
                            device.getDisplayHeight())) {
                matchingDiscoverAncestors++;
            }
            if (OtaFlowPolicy.PRODUCT_PACKAGE.equals(ancestor.getApplicationPackage())
                    && "android.view.View".equals(ancestor.getClassName())
                    && ancestor.isScrollable()
                    && !ancestor.isClickable()
                    && ancestor.isEnabled()
                    && proof.railBounds.equals(ancestor.getVisibleBounds())) {
                matchingRailAncestors++;
                freshRail = ancestor;
            }
            ancestor = ancestor.getParent();
        }
        assertTrue("Fresh Blade Runner ancestry exceeded its bound", ancestor == null);
        assertEquals("Fresh Blade Runner left the unique main-content root",
                1, matchingMainAncestors);
        assertEquals("Fresh Blade Runner left the exact Discover page",
                1, matchingDiscoverAncestors);
        assertEquals("Fresh Blade Runner was not in the unique proven Popular Movies rail",
                1, matchingRailAncestors);
        assertNotNull("Fresh Popular Movies rail was unavailable", freshRail);
        UiObject2 freshSection = freshRail.getParent();
        assertNotNull("Fresh Popular Movies rail lost its section", freshSection);
        assertTrue("Fresh Popular Movies section identity changed",
                OtaFlowPolicy.PRODUCT_PACKAGE.equals(freshSection.getApplicationPackage())
                        && "android.view.View".equals(freshSection.getClassName())
                        && !freshSection.isScrollable()
                        && !freshSection.isClickable()
                        && freshSection.isEnabled()
                        && fixed42FullBounds(
                                freshSection.getVisibleBounds(),
                                device.getDisplayWidth(),
                                device.getDisplayHeight()));
        List<UiObject2> headings = fixed42FreshSemanticCandidates(
                freshSection, "Popular Movies", "android.widget.TextView", false);
        assertEquals("Fresh Popular Movies heading was absent or ambiguous",
                1, headings.size());
        assertTrue("Fresh Popular Movies heading was clipped by navigation",
                fixed42VisibleAboveNavigation(
                        headings.get(0).getVisibleBounds(),
                        device.getDisplayWidth(),
                        device.getDisplayHeight(),
                        proof.navigationTop));

        List<UiObject2> primaries = fixed42FreshSemanticCandidates(
                null, "Primary", "android.view.View", false);
        assertEquals("Fresh Primary navigation was absent or ambiguous", 1, primaries.size());
        assertTrue("Fresh Primary navigation bounds were invalid",
                fixed42FullBounds(
                        primaries.get(0).getVisibleBounds(),
                        device.getDisplayWidth(),
                        device.getDisplayHeight()));
        assertEquals("Fresh Primary navigation moved after guarded snapshot",
                proof.navigationTop, primaries.get(0).getVisibleBounds().top);
        assertEquals("Fresh Blade Runner bounds changed immediately before click",
                proof.bladeBounds, blade.getVisibleBounds());
        assertTrue("Fixed42 seed deadline elapsed during fresh Blade queries",
                Fixed42SeedPolicy.withinDeadline(
                        startedAt, SystemClock.uptimeMillis()));
        blade.click();
        log("Clicked one fresh exact Blade Runner button in Popular Movies");
    }

    private List<UiObject2> fixed42FreshSemanticCandidates(
            UiObject2 scope, String exact, String className, boolean clickable) {
        List<UiObject2> candidates = new ArrayList<>();
        for (BySelector selector : productTextOrDescriptionSelectors(
                exact, className, clickable)) {
            List<UiObject2> matches = scope == null
                    ? device.findObjects(selector)
                    : scope.findObjects(selector);
            for (UiObject2 candidate : matches) {
                if (!candidates.contains(candidate)) candidates.add(candidate);
            }
        }
        return candidates;
    }

    private static int fixed42UniqueResource(List<Fixed42AxNode> nodes, String resourceName) {
        int found = -1;
        for (int index = 0; index < nodes.size(); index++) {
            if (!resourceName.equals(nodes.get(index).resourceName)) continue;
            assertTrue("Fixed42 resource identity was ambiguous", found < 0);
            found = index;
        }
        assertTrue("Fixed42 resource identity was absent", found >= 0);
        return found;
    }

    private static int fixed42UniqueSemantic(
            List<Fixed42AxNode> nodes, String exact, boolean required) {
        int found = -1;
        for (int index = 0; index < nodes.size(); index++) {
            if (!nodes.get(index).semanticEquals(exact)) continue;
            assertTrue("Fixed42 semantic identity was ambiguous for " + exact, found < 0);
            found = index;
        }
        if (required) assertTrue("Fixed42 semantic identity was absent for " + exact, found >= 0);
        return found;
    }

    private static int fixed42UniqueScrollableDescendant(
            List<Fixed42AxNode> nodes, int ancestorIndex, String productPackage) {
        int found = -1;
        for (int index = 0; index < nodes.size(); index++) {
            Fixed42AxNode node = nodes.get(index);
            if (!node.scrollable || !fixed42IsDescendant(nodes, index, ancestorIndex)) continue;
            assertTrue("Popular Movies rail identity changed",
                    node.matches(productPackage, "android.view.View", true, false));
            assertTrue("Popular Movies owned ambiguous scrollable rails", found < 0);
            found = index;
        }
        assertTrue("Popular Movies rail was absent", found >= 0);
        return found;
    }

    private static int[] fixed42SemanticPositions(
            List<Fixed42AxNode> nodes,
            String[] labels,
            boolean useTop,
            int requiredAncestor,
            String productPackage) {
        int[] positions = new int[labels.length];
        for (int labelIndex = 0; labelIndex < labels.length; labelIndex++) {
            positions[labelIndex] = Fixed42SeedPolicy.ABSENT;
            int matches = 0;
            for (Fixed42AxNode node : nodes) {
                if (!node.semanticEquals(labels[labelIndex])) continue;
                matches++;
                assertEquals("Fixed42 progress marker package changed",
                        productPackage, node.packageName);
                assertTrue("Fixed42 progress marker became hidden or disabled",
                        node.visible && node.enabled);
                if (useTop) {
                    assertEquals("Fixed42 vertical progress marker role changed",
                            labelIndex == 0 ? "android.view.View" : "android.widget.TextView",
                            node.className);
                    assertFalse("Fixed42 vertical progress marker became clickable",
                            node.clickable);
                } else {
                    assertEquals("Fixed42 rail progress marker role changed",
                            "android.widget.Button", node.className);
                    assertTrue("Fixed42 rail progress marker became non-clickable",
                            node.clickable);
                    assertTrue("Fixed42 rail progress marker escaped Popular Movies",
                            requiredAncestor >= 0
                                    && fixed42IsDescendant(
                                            nodes, nodes.indexOf(node), requiredAncestor));
                }
                if (!node.bounds.isEmpty()) {
                    positions[labelIndex] = useTop ? node.bounds.top : node.bounds.left;
                }
            }
            assertTrue("Fixed42 progress marker was ambiguous", matches <= 1);
        }
        return positions;
    }

    private static boolean fixed42IsDescendant(
            List<Fixed42AxNode> nodes, int childIndex, int ancestorIndex) {
        int cursor = childIndex;
        for (int depth = 0; cursor >= 0 && depth <= nodes.size(); depth++) {
            if (cursor == ancestorIndex) return true;
            cursor = nodes.get(cursor).parentIndex;
        }
        if (cursor >= 0) throw new AssertionError("Fixed42 seed ancestry was cyclic");
        return false;
    }

    private static boolean fixed42SupportsAction(
            AccessibilityNodeInfo node,
            AccessibilityNodeInfo.AccessibilityAction expected) {
        for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) {
            if (action.getId() == expected.getId()) return true;
        }
        return false;
    }

    private static boolean fixed42FullBounds(Rect bounds, int width, int height) {
        return bounds.left >= 0
                && bounds.top >= 0
                && bounds.right > bounds.left
                && bounds.bottom > bounds.top
                && bounds.right <= width
                && bounds.bottom <= height;
    }

    private static boolean fixed42VisibleAboveNavigation(
            Rect bounds, int width, int height, int navigationTop) {
        return fixed42FullBounds(bounds, width, height) && bounds.bottom <= navigationTop;
    }

    private static boolean fixed42SemanticEquals(
            String text, String description, String exact) {
        return exact.equals(text) || exact.equals(description);
    }

    private static String fixed42NodeString(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static String fixed42Bounds(Rect bounds) {
        if (bounds == null) return "absent";
        return "[" + bounds.left + "," + bounds.top + ","
                + bounds.right + "," + bounds.bottom + "]";
    }

    private static void fixed42RecycleNodes(List<AccessibilityNodeInfo> nodes) {
        for (int index = nodes.size() - 1; index >= 0; index--) {
            nodes.get(index).recycle();
        }
        nodes.clear();
    }

    private void assertFixed42MeaningfulLocalState(String phase, boolean afterUpdate)
            throws IOException {
        navigateProductRoute("Discover");
        openFixed42ProfileDialog();
        UiObject2 name = waitForFixed42ProfileNameField(phase + " profile marker read");
        assertEquals(phase + " fixed42 profile marker mismatch",
                FIXED42_PROFILE_NAME, name.getText());
        closeFixed42ProfileDialog("during " + phase);

        openSettingsFromProductNavigation();
        selectFixed42SettingsCategory("Appearance", "Choose a style");
        waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY);

        navigateProductRoute("Watchlist");
        waitForFixed42Semantic(AUTOMATIC_SAMPLE_TITLE, true, phase + " watchlist marker");
        waitForFixed42Semantic(AUTOMATIC_FOLDER_NAME, true, phase + " folder marker");
        waitForFixed42FolderSelect(
                "Move " + AUTOMATIC_SAMPLE_TITLE + " to folder", AUTOMATIC_FOLDER_NAME);
        capture("fixed42-state-" + phase);

        if (afterUpdate && phase.startsWith("warm")) {
            profilePersistedWarm = true;
            appearancePersistedWarm = true;
            watchlistPersistedWarm = true;
            folderPersistedWarm = true;
        } else if (afterUpdate && phase.startsWith("after-task-relaunch")) {
            profilePersistedAfterTaskRelaunch = true;
            appearancePersistedAfterTaskRelaunch = true;
            watchlistPersistedAfterTaskRelaunch = true;
            folderPersistedAfterTaskRelaunch = true;
        }
    }

    private void inspectFixed42PostInstallAutomaticRetention() throws IOException {
        assertTrue("Postinstall inspection cannot precede the automatic offer",
                automaticOfferOrdinal >= 1);
        assertEquals("Postinstall inspection cannot establish pre-offer automatic discovery",
                0, preOfferManualDiscoveries);
        openSettingsAndAssertSimple("fixed42-post-install-automatic-retention");
        selectFixed42SettingsCategory("Help & updates", "Android APK updates");
        postInstallManualInspectionChecks++;
        assertEquals("Fixed42 postinstall Settings inspection must run exactly once",
                1, postInstallManualInspectionChecks);
        tapVisibleAndroidUpdateCheckCard("fixed42-post-install-update-inspection");

        String resultTitle = "YAWF Stream is up to date";
        String resultMessage = "No newer signed Android phone release is available.";
        waitFor(nativeDialogText(resultTitle), UI_WAIT_MS,
                "fixed42 exact postinstall up-to-date title");
        waitFor(nativeDialogText(resultMessage), SHORT_WAIT_MS,
                "fixed42 exact postinstall up-to-date message");
        postInstallExactUpToDate59Observed = true;
        List<UiObject2> weeklyMatches = device.findObjects(
                By.text("Check automatically each week")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.CheckBox"));
        assertEquals("Fixed42 postinstall weekly checkbox was absent or ambiguous",
                1, weeklyMatches.size());
        UiObject2 weekly = weeklyMatches.get(0);
        assertTrue("Fixed42 postinstall weekly checkbox was disabled", weekly.isEnabled());
        assertTrue("Fixed42 postinstall weekly checkbox was not checkable", weekly.isCheckable());
        assertTrue("Fixed42 postinstall weekly automatic checks were not retained",
                weekly.isChecked());
        weeklyOnAfterUpdate = true;
        postInstallInspectionOrdinal = automaticOfferOrdinal + 1;
        capture("fixed42-post-install-up-to-date-weekly-on");
        postInstallNativeOkClosures++;
        assertEquals("Fixed42 postinstall result must close through one native OK",
                1, postInstallNativeOkClosures);
        click(nativeProductButton(OtaFlowPolicy.OK),
                "fixed42 postinstall native OK", SHORT_WAIT_MS, true);
        assertTrue("Fixed42 postinstall up-to-date result did not close",
                device.wait(Until.gone(nativeDialogText(resultTitle)), SHORT_WAIT_MS));
        assertEquals("Fixed42 postinstall inspection must not use native Cancel",
                0, postInstallNativeCancelClosures);
        log("Completed one bounded postinstall manual inspection after automatic discovery proof");
    }

    private UiObject2 waitForFixed42ProfileNameField(String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            instrumentation.getUiAutomation().clearCache();
            UiObject2 dialog = findUniqueExactProductDialog("Profile");
            if (dialog != null) {
                Rect dialogBounds = dialog.getVisibleBounds();
                List<UiObject2> candidates = dialog.findObjects(
                        By.clazz("android.widget.EditText")
                                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                                .enabled(true));
                List<UiObject2> valid = new ArrayList<>();
                for (UiObject2 candidate : candidates) {
                    Rect bounds = candidate.getVisibleBounds();
                    if (!bounds.isEmpty()
                            && dialogBounds.contains(bounds)
                            && bounds.left >= 0
                            && bounds.top >= 0
                            && bounds.right <= device.getDisplayWidth()
                            && bounds.bottom <= device.getDisplayHeight()) {
                        valid.add(candidate);
                    }
                }
                assertTrue("Fixed42 Profile exposed ambiguous visible enabled EditText fields",
                        valid.size() <= 1);
                if (valid.size() == 1) {
                    log("Reacquired one exact Profile EditText for " + label);
                    return valid.get(0);
                }
            }
            SystemClock.sleep(150);
        }
        fail("Timed out waiting for one exact visible Profile EditText: " + label);
        return null;
    }

    private UiObject2 findUniqueFreshFixed42Button(String label) {
        List<UiObject2> matches = new ArrayList<>();
        addDistinctUiObjects(matches, device.findObjects(
                By.text(label)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.Button")
                        .clickable(true)
                        .enabled(true)));
        addDistinctUiObjects(matches, device.findObjects(
                By.desc(label)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.Button")
                        .clickable(true)
                        .enabled(true)));
        List<UiObject2> visible = new ArrayList<>();
        for (UiObject2 match : matches) {
            Rect bounds = match.getVisibleBounds();
            if (!bounds.isEmpty()
                    && bounds.left >= 0
                    && bounds.top >= 0
                    && bounds.right <= device.getDisplayWidth()
                    && bounds.bottom <= device.getDisplayHeight()) {
                visible.add(match);
            }
        }
        assertTrue("Fixed42 exact product button was ambiguous: " + label, visible.size() <= 1);
        return visible.size() == 1 ? visible.get(0) : null;
    }

    private UiObject2 clickFreshFixed42Button(String label, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            instrumentation.getUiAutomation().clearCache();
            if (findUniqueFreshFixed42Button(label) == null) {
                SystemClock.sleep(150);
                continue;
            }
            assertNoBindingTerms();
            instrumentation.getUiAutomation().clearCache();
            UiObject2 fresh = findUniqueFreshFixed42Button(label);
            assertNotNull("Fixed42 exact product button disappeared after safety guard: " + label,
                    fresh);
            fresh.click();
            log("Clicked one fresh exact fixed42 product button: " + label);
            return fresh;
        }
        fail("Timed out waiting for one fresh exact fixed42 product button: " + label);
        return null;
    }

    private void openFixed42ProfileDialog() {
        clickFreshFixed42Button("Your profile", UI_WAIT_MS);
        waitForUniqueExactProductDialog("Profile", SHORT_WAIT_MS);
        log("Opened exact fixed42 Profile dialog from a fresh guarded control");
    }

    private void closeFixed42ProfileDialog(String phase) {
        clickFreshFixed42Button("Close", SHORT_WAIT_MS);
        assertTrue("Fixed42 Profile dialog did not close " + phase,
                waitForFreshFixed42DialogGone("Profile", SHORT_WAIT_MS));
    }

    private void selectFixed42SettingsCategory(String target, String contentAnchor) {
        String[] categories = {
                "Appearance", "Language & region", "Playback", "Privacy", "Install & setup",
                "Help & updates"
        };
        UiObject2 collapsed = null;
        for (int attempt = 0; attempt < 8 && collapsed == null; attempt++) {
            List<UiObject2> matches = new ArrayList<>();
            for (String category : categories) {
                addDistinctUiObjects(matches, device.findObjects(
                        By.text(category)
                                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                                .clazz("android.view.View")
                                .clickable(true)
                                .enabled(true)));
            }
            List<UiObject2> visible = new ArrayList<>();
            for (UiObject2 match : matches) {
                if (isVisibleAboveBottomNavigation(match)) visible.add(match);
            }
            assertTrue("Fixed42 Settings category selector was ambiguous", visible.size() <= 1);
            if (visible.size() == 1) {
                collapsed = visible.get(0);
                break;
            }
            int width = device.getDisplayWidth();
            int height = device.getDisplayHeight();
            device.swipe(width / 2, height / 3, width / 2, (height * 3) / 4, 25);
            device.waitForIdle(500);
        }
        assertNotNull("Fixed42 Settings category selector was unavailable", collapsed);
        assertNoBindingTerms();
        collapsed.click();
        BySelector targetRow = By.text(target)
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.CheckedTextView")
                .enabled(true);
        List<UiObject2> rows = device.wait(Until.findObjects(targetRow), SHORT_WAIT_MS);
        assertNotNull("Fixed42 native Settings picker did not expose " + target, rows);
        assertEquals("Fixed42 native Settings picker target was ambiguous", 1, rows.size());
        rows.get(0).click();
        assertTrue("Fixed42 native Settings picker did not close",
                device.wait(Until.gone(By.clazz("android.widget.ListView")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)), SHORT_WAIT_MS));
        waitFor(
                By.text(contentAnchor)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.TextView"),
                SHORT_WAIT_MS,
                target + " content anchor");
        log("Selected exact fixed42 Settings category " + target);
    }

    private List<UiObject2> findExactFixed42AppearanceStyleControls(String exactButtonText) {
        List<UiObject2> matches = device.findObjects(
                By.text(exactButtonText)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.ToggleButton")
                        .clickable(true)
                        .enabled(true));
        List<UiObject2> valid = new ArrayList<>();
        for (UiObject2 candidate : matches) {
            Rect candidateBounds = candidate.getVisibleBounds();
            if (Fixed42AppearancePolicy.isExactStyleControl(
                    candidate.getText(),
                    candidate.getContentDescription(),
                    candidate.getClassName(),
                    candidate.getApplicationPackage(),
                    candidate.isClickable(),
                    candidate.isEnabled(),
                    candidateBounds.left,
                    candidateBounds.top,
                    candidateBounds.right,
                    candidateBounds.bottom,
                    device.getDisplayWidth(),
                    device.getDisplayHeight(),
                    fixed42BottomNavigationTop(),
                    exactButtonText,
                    OtaFlowPolicy.PRODUCT_PACKAGE)) {
                valid.add(candidate);
            }
        }
        return valid;
    }

    private void clickFreshFixed42AppearanceStyle(
            String exactButtonText, String firstScrollCaptureLabel) throws IOException {
        assertTrue("Appearance style selection is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        for (int attempt = 0; attempt < 12; attempt++) {
            assertTrue("Fixed42 Appearance style cache refresh failed",
                    instrumentation.getUiAutomation().clearCache());
            List<UiObject2> candidates =
                    findExactFixed42AppearanceStyleControls(exactButtonText);
            assertTrue("Fixed42 exact Appearance style control was ambiguous",
                    candidates.size() <= 1);
            if (candidates.size() == 1) {
                assertNoBindingTerms();
                assertTrue("Fixed42 Appearance style guarded cache refresh failed",
                        instrumentation.getUiAutomation().clearCache());
                List<UiObject2> fresh =
                        findExactFixed42AppearanceStyleControls(exactButtonText);
                assertTrue("Fixed42 exact Appearance style control disappeared or duplicated",
                        Fixed42AppearancePolicy.hasUniqueCandidate(fresh.size()));
                fresh.get(0).click();
                device.waitForIdle(750);
                log("Clicked one fresh exact fixed42 Appearance style control: "
                        + exactButtonText);
                return;
            }
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking fixed42 Appearance style",
                    scrollable);
            assertNoBindingTerms();
            scrollable = device.findObject(By.scrollable(true));
            assertNotNull("Scrollable container disappeared while seeking fixed42 Appearance style",
                    scrollable);
            configureSettingsScrollGesture(scrollable);
            boolean canStillScroll = scrollable.scroll(Direction.DOWN, 0.75f);
            log("Performed bounded Settings scroll gesture while seeking exact "
                    + exactButtonText + "; canStillScroll=" + canStillScroll);
            device.waitForIdle(750);
            if (attempt == 0 && firstScrollCaptureLabel != null) {
                captureFixed42Appearance(firstScrollCaptureLabel);
            }
        }
        fail("Could not place exact fixed42 Appearance style above bottom navigation: "
                + exactButtonText);
    }

    private UiObject2 waitForFixed42AppearanceSummary(String exactStyle) {
        assertTrue("Appearance summary observation is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        for (int attempt = 0;
                attempt < 12 && SystemClock.uptimeMillis() < deadline;
                attempt++) {
            assertTrue("Fixed42 Appearance summary cache refresh failed",
                    instrumentation.getUiAutomation().clearCache());
            List<UiObject2> matches = device.findObjects(
                    By.text(exactStyle)
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                            .clazz("android.widget.TextView"));
            List<UiObject2> summaries = new ArrayList<>();
            for (UiObject2 match : matches) {
                boolean clickableAncestor = false;
                UiObject2 parent = match.getParent();
                for (int depth = 0; depth < 6 && parent != null; depth++) {
                    if (parent.isClickable()) {
                        clickableAncestor = true;
                        break;
                    }
                    parent = parent.getParent();
                }
                Rect summaryBounds = match.getVisibleBounds();
                if (Fixed42AppearancePolicy.isExactSummary(
                        match.getText(),
                        match.getContentDescription(),
                        match.getClassName(),
                        match.getApplicationPackage(),
                        match.isClickable(),
                        match.isEnabled(),
                        summaryBounds.left,
                        summaryBounds.top,
                        summaryBounds.right,
                        summaryBounds.bottom,
                        device.getDisplayWidth(),
                        device.getDisplayHeight(),
                        fixed42BottomNavigationTop(),
                        clickableAncestor,
                        exactStyle,
                        OtaFlowPolicy.PRODUCT_PACKAGE)) {
                    summaries.add(match);
                }
            }
            assertTrue("Fixed42 selected appearance summary was ambiguous", summaries.size() <= 1);
            if (summaries.size() == 1) return summaries.get(0);
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking fixed42 Appearance summary",
                    scrollable);
            assertNoBindingTerms();
            scrollable = device.findObject(By.scrollable(true));
            assertNotNull("Scrollable container disappeared while seeking fixed42 Appearance summary",
                    scrollable);
            configureSettingsScrollGesture(scrollable);
            boolean canStillScroll = scrollable.scroll(Direction.UP, 0.75f);
            log("Performed bounded Settings scroll gesture while seeking exact selected summary "
                    + exactStyle + "; canStillScroll=" + canStillScroll);
            device.waitForIdle(750);
        }
        fail("Timed out waiting for exact selected appearance summary " + exactStyle);
        return null;
    }

    private int fixed42BottomNavigationTop() {
        List<UiObject2> navigationMatches = device.findObjects(
                By.text("Primary")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.view.View")
                        .clickable(false)
                        .enabled(true));
        assertEquals("Exact bottom navigation container was absent or ambiguous",
                1, navigationMatches.size());
        UiObject2 navigation = navigationMatches.get(0);
        Rect navigationBounds = navigation.getVisibleBounds();
        assertFalse("Exact bottom navigation bounds were empty", navigationBounds.isEmpty());
        return navigationBounds.top;
    }

    private UiObject2 waitForFixed42Semantic(String identity, boolean clickable, String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> matches = new ArrayList<>();
            addDistinctUiObjects(matches, device.findObjects(
                    By.text(identity).pkg(OtaFlowPolicy.PRODUCT_PACKAGE).enabled(true)));
            addDistinctUiObjects(matches, device.findObjects(
                    By.desc(identity).pkg(OtaFlowPolicy.PRODUCT_PACKAGE).enabled(true)));
            List<UiObject2> visible = new ArrayList<>();
            for (UiObject2 match : matches) {
                if ((!clickable || match.isClickable()) && isVisibleAboveBottomNavigation(match)) {
                    visible.add(match);
                }
            }
            assertTrue("Fixed42 semantic control was ambiguous: " + label, visible.size() <= 1);
            if (visible.size() == 1) return visible.get(0);
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            if (scrollable != null) {
                configureSettingsScrollGesture(scrollable);
                scrollable.scroll(Direction.DOWN, 0.75f);
                device.waitForIdle(500);
            } else {
                SystemClock.sleep(150);
            }
        }
        fail("Timed out waiting for fixed42 semantic control: " + label);
        return null;
    }

    private UiObject2 waitForFixed42DialogSemantic(
            String dialogIdentity, String identity, boolean clickable, String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 dialog = findUniqueExactProductDialog(dialogIdentity);
            if (dialog != null) {
                List<UiObject2> matches = new ArrayList<>();
                addDistinctUiObjects(matches, dialog.findObjects(
                        By.text(identity).pkg(OtaFlowPolicy.PRODUCT_PACKAGE).enabled(true)));
                addDistinctUiObjects(matches, dialog.findObjects(
                        By.desc(identity).pkg(OtaFlowPolicy.PRODUCT_PACKAGE).enabled(true)));
                List<UiObject2> valid = new ArrayList<>();
                for (UiObject2 match : matches) {
                    if (!clickable || match.isClickable()) valid.add(match);
                }
                assertTrue("Fixed42 dialog semantic was ambiguous: " + label, valid.size() <= 1);
                if (valid.size() == 1) return valid.get(0);
                UiObject2 scrollable = dialog.findObject(By.scrollable(true));
                if (scrollable != null) scrollable.scroll(Direction.DOWN, 0.75f);
            }
            SystemClock.sleep(150);
        }
        fail("Timed out waiting for fixed42 dialog semantic: " + label);
        return null;
    }

    private UiObject2 waitForFixed42FolderSelect(String moveLabel, String expectedValue) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> values = device.findObjects(
                    By.text(expectedValue)
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                            .clazz("android.view.View")
                            .clickable(true)
                            .enabled(true));
            List<UiObject2> exact = new ArrayList<>();
            for (UiObject2 value : values) {
                UiObject2 parent = value.getParent();
                if (parent == null || !isVisibleAboveBottomNavigation(value)) continue;
                boolean hasMove = parent.findObjects(
                        By.text("Move ")
                                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                                .clazz("android.widget.TextView")).size() == 1;
                boolean hasTitle = parent.findObjects(
                        By.text(AUTOMATIC_SAMPLE_TITLE)
                                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                                .clazz("android.widget.TextView")).size() == 1;
                boolean hasSuffix = parent.findObjects(
                        By.text(" to folder")
                                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                                .clazz("android.widget.TextView")).size() == 1;
                if (hasMove && hasTitle && hasSuffix) exact.add(value);
            }
            assertTrue("Fixed42 exact folder select was ambiguous for " + moveLabel,
                    exact.size() <= 1);
            if (exact.size() == 1) return exact.get(0);
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking fixed42 folder select",
                    scrollable);
            configureSettingsScrollGesture(scrollable);
            scrollable.scroll(Direction.DOWN, 0.75f);
            device.waitForIdle(500);
        }
        fail("Timed out waiting for exact fixed42 folder select " + moveLabel
                + " with value " + expectedValue);
        return null;
    }

    private void seedMeaningfulLocalState() throws IOException {
        openProfileDialog();
        UiObject2 name = waitFor(
                By.desc("Your name")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.EditText")
                        .enabled(true),
                SHORT_WAIT_MS,
                "Your name input");
        name.setText(AUTOMATIC_PROFILE_NAME);
        waitForExactTextValue(name, AUTOMATIC_PROFILE_NAME, "seeded profile name");
        clickProductExact("Close", "android.widget.Button", SHORT_WAIT_MS);

        openSettingsFromProductNavigation();
        UiObject2 appearance = scrollUntilVisibleProductSemantic(
                "Appearance", "android.widget.Button", true, Direction.DOWN);
        appearance.click();
        log("Opened exact Appearance settings category");
        device.waitForIdle(750);
        UiObject2 quiet = scrollUntilVisibleProductSemantic(
                AUTOMATIC_APPEARANCE, "android.widget.Button", true, Direction.DOWN);
        quiet.click();
        waitForCheckedState(
                By.desc(AUTOMATIC_APPEARANCE)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.Button"),
                true,
                "Quiet focus pressed state");
        navigateProductRoute("Discover");

        waitFor(By.text("Sample catalog"), UI_WAIT_MS, "Sample catalog classification");
        UiObject2 title = scrollUntilVisibleProductSemanticOnAnyRoute(
                AUTOMATIC_SAMPLE_TITLE, "android.widget.Button", true, Direction.DOWN);
        title.click();
        log("Opened complete bundled sample title: " + AUTOMATIC_SAMPLE_TITLE);
        device.waitForIdle(750);
        waitFor(By.text(AUTOMATIC_SAMPLE_TITLE), UI_WAIT_MS, "complete detail title");
        String detailDialogIdentity = AUTOMATIC_SAMPLE_TITLE + " details";
        waitForUniqueExactProductDialog(detailDialogIdentity, SHORT_WAIT_MS);
        UiObject2 watchlist = scrollUntilVisibleInExactDialog(
                detailDialogIdentity, "Watchlist", "android.widget.Button", Direction.DOWN);
        int detailEventOrdinal = 0;
        int dialogWatchlistClickOrdinal = ++detailEventOrdinal;
        watchlist.click();
        waitForCheckedState(
                By.text("In watchlist")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.Button"),
                true,
                "In watchlist pressed state");

        int backOrdinal = ++detailEventOrdinal;
        device.pressBack();
        assertTrue("Exact sample detail dialog did not close after Back",
                waitForUniqueExactProductDialogGone(detailDialogIdentity, SHORT_WAIT_MS));
        int dialogGoneOrdinal = ++detailEventOrdinal;
        waitForAny(SHORT_WAIT_MS, productTextOrDescriptionSelectors(
                "Primary", "android.view.View", false));
        int primaryNavigationOrdinal = ++detailEventOrdinal;
        assertTrue("Detail dialog transition did not precede primary navigation",
                AutomaticOtaDriverChecks.detailClosedBeforePrimaryNavigation(
                        dialogWatchlistClickOrdinal,
                        backOrdinal,
                        dialogGoneOrdinal,
                        primaryNavigationOrdinal));
        log("Closed the exact sample detail dialog before using primary navigation");
        navigateProductRoute("Watchlist");
        waitForAny(UI_WAIT_MS, productTextOrDescriptionSelectors(
                AUTOMATIC_SAMPLE_TITLE, "android.widget.Button", true));
        clickProductExact("+ New folder", "android.widget.Button", SHORT_WAIT_MS);
        UiObject2 folderName = waitFor(
                By.desc("New watchlist folder name")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.EditText")
                        .enabled(true),
                SHORT_WAIT_MS,
                "new watchlist folder name input");
        folderName.setText(AUTOMATIC_FOLDER_NAME);
        waitForExactTextValue(folderName, AUTOMATIC_FOLDER_NAME, "seeded folder name");
        clickProductExact("Save", "android.widget.Button", SHORT_WAIT_MS);
        waitForAny(SHORT_WAIT_MS, productTextOrDescriptionSelectors(
                AUTOMATIC_FOLDER_NAME, "android.widget.Button", true));

        String moveLabel = "Move " + AUTOMATIC_SAMPLE_TITLE + " to folder";
        UiObject2 folderSelect = scrollUntilVisibleProductSemanticOnAnyRoute(
                moveLabel, "android.widget.Spinner", true, Direction.DOWN);
        folderSelect.click();
        click(By.text(AUTOMATIC_FOLDER_NAME), AUTOMATIC_FOLDER_NAME, SHORT_WAIT_MS, true);
        waitForSelectedFolder(moveLabel, AUTOMATIC_FOLDER_NAME);
        capture("automatic-local-data-seeded");
    }

    private void assertMeaningfulLocalState(String phase, boolean afterUpdate) throws IOException {
        navigateProductRoute("Discover");
        openProfileDialog();
        UiObject2 name = waitFor(
                By.desc("Your name")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.EditText")
                        .enabled(true),
                SHORT_WAIT_MS,
                phase + " profile name");
        String observedProfileName = name.getText();
        if (!afterUpdate) {
            assertEquals(phase + " profile seed mismatch",
                    AUTOMATIC_PROFILE_NAME, observedProfileName);
            profileNameBeforeUpdate = observedProfileName;
        } else {
            assertTrue(phase + " profile value was not preserved from the observed baseline",
                    AutomaticOtaDriverChecks.exactValueWasPreserved(
                            profileNameBeforeUpdate, observedProfileName));
        }
        clickProductExact("Close", "android.widget.Button", SHORT_WAIT_MS);

        openSettingsFromProductNavigation();
        UiObject2 appearance = scrollUntilVisibleProductSemantic(
                "Appearance", "android.widget.Button", true, Direction.DOWN);
        appearance.click();
        UiObject2 quiet = scrollUntilVisibleProductSemantic(
                AUTOMATIC_APPEARANCE, "android.widget.Button", true, Direction.DOWN);
        assertTrue(phase + " Quiet focus was not pressed", quiet.isChecked());

        navigateProductRoute("Watchlist");
        waitForAny(UI_WAIT_MS, productTextOrDescriptionSelectors(
                AUTOMATIC_SAMPLE_TITLE, "android.widget.Button", true));
        waitForAny(UI_WAIT_MS, productTextOrDescriptionSelectors(
                AUTOMATIC_FOLDER_NAME, "android.widget.Button", true));
        String moveLabel = "Move " + AUTOMATIC_SAMPLE_TITLE + " to folder";
        waitForSelectedFolder(moveLabel, AUTOMATIC_FOLDER_NAME);
        capture("automatic-state-" + phase);

        if (afterUpdate && phase.startsWith("warm")) {
            profilePersistedWarm = true;
            appearancePersistedWarm = true;
            watchlistPersistedWarm = true;
            folderPersistedWarm = true;
        } else if (afterUpdate && phase.startsWith("after-task-relaunch")) {
            profilePersistedAfterTaskRelaunch = true;
            appearancePersistedAfterTaskRelaunch = true;
            watchlistPersistedAfterTaskRelaunch = true;
            folderPersistedAfterTaskRelaunch = true;
        }
    }

    private void openProfileDialog() {
        UiObject2 profile = waitForAny(
                UI_WAIT_MS,
                productTextOrDescriptionSelectors("Your profile", "android.widget.Button", true));
        assertNoBindingTerms();
        profile.click();
        waitForAny(
                SHORT_WAIT_MS,
                By.desc("Profile").pkg(OtaFlowPolicy.PRODUCT_PACKAGE),
                By.text("Profile").pkg(OtaFlowPolicy.PRODUCT_PACKAGE));
        log("Opened exact Your profile dialog");
    }

    private void openSettingsFromProductNavigation() {
        clickWebButton(OtaFlowPolicy.MORE_NAVIGATION, "More navigation", UI_WAIT_MS);
        waitFor(By.res("mobile-nav-more"), SHORT_WAIT_MS, "More dialog");
        click(By.text("Settings"), "Settings", SHORT_WAIT_MS, false);
        waitForSettingsRoute();
    }

    private void navigateProductRoute(String label) {
        UiObject2 route = waitForAny(
                UI_WAIT_MS,
                productTextOrDescriptionSelectors(label, "android.widget.Button", true));
        assertNoBindingTerms();
        route.click();
        log("Opened exact product route: " + label);
        device.waitForIdle(750);
    }

    private UiObject2 clickProductExact(String label, String className, long timeoutMs) {
        UiObject2 object = waitForAny(
                timeoutMs, productTextOrDescriptionSelectors(label, className, true));
        assertNoBindingTerms();
        object.click();
        log("Clicked exact product control: " + label);
        device.waitForIdle(750);
        return object;
    }

    private void waitForExactTextValue(UiObject2 object, String expected, String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (expected.equals(object.getText())) return;
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for exact " + label);
    }

    private void waitForSelectedFolder(String moveLabel, String expectedFolder) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 select = findAnyNow(productTextOrDescriptionSelectors(
                    moveLabel, "android.widget.Spinner", true));
            if (select != null && expectedFolder.equals(select.getText())) return;
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for exact folder membership: " + expectedFolder);
    }

    private int returnToProductThroughVisibleLauncher(String phase) {
        device.pressHome();
        assertTrue("Home did not hide product before " + phase,
                device.wait(Until.gone(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE)), SHORT_WAIT_MS));
        launchProductFromVisibleLauncher(phase);
        visibleLauncherReturnOrdinal++;
        return visibleLauncherReturnOrdinal;
    }

    private void launchProductFromVisibleLauncher(String phase) {
        if (isFixed42AutomaticMode()) {
            launchFixed42ProductFromVisibleLauncher(phase);
            return;
        }
        launchVisibleAppFromLauncher("YAWF Stream", OtaFlowPolicy.PRODUCT_PACKAGE, phase);
    }

    private void launchFixed42ProductFromVisibleLauncher(String phase) {
        String appLabel = "YAWF Stream";
        long startedAt = SystemClock.uptimeMillis();
        String launcherPackage = device.getLauncherPackageName();
        assertNotNull("Default launcher package was unavailable for " + appLabel,
                launcherPackage);
        assertFalse("Product package was registered as the default launcher",
                OtaFlowPolicy.PRODUCT_PACKAGE.equals(launcherPackage));
        device.pressHome();

        boolean drawerGestureSent = false;
        Fixed42LauncherObservation ready = null;
        Fixed42LauncherDiagnostics diagnostics = new Fixed42LauncherDiagnostics();
        while (Fixed42LauncherReadinessPolicy.withinDeadline(
                startedAt, SystemClock.uptimeMillis())) {
            long observationStartedAt = SystemClock.uptimeMillis();
            Fixed42LauncherObservation observation = observeFixed42LauncherReadiness(
                    appLabel, launcherPackage);
            diagnostics.record(observation.state, observation.diagnostic,
                    Fixed42LauncherDiagnostics.durationMs(
                            observationStartedAt, SystemClock.uptimeMillis()));
            if (observation.state == Fixed42LauncherReadinessPolicy.READY) {
                ready = observation;
                break;
            }
            if (observation.state == Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON
                    && !drawerGestureSent) {
                assertNoBindingTerms();
                observationStartedAt = SystemClock.uptimeMillis();
                Fixed42LauncherObservation beforeDrawer = observeFixed42LauncherReadiness(
                        appLabel, launcherPackage);
                diagnostics.record(beforeDrawer.state, beforeDrawer.diagnostic,
                        Fixed42LauncherDiagnostics.durationMs(
                                observationStartedAt, SystemClock.uptimeMillis()));
                if (beforeDrawer.state == Fixed42LauncherReadinessPolicy.READY) {
                    ready = beforeDrawer;
                    break;
                }
                assertEquals("Fixed42 drawer gesture lost its exact launcher surface",
                        Fixed42LauncherReadinessPolicy.WAITING_FOR_ICON,
                        beforeDrawer.state);
                assertTrue("Fixed42 launcher deadline elapsed before its drawer gesture",
                        Fixed42LauncherReadinessPolicy.withinDeadline(
                                startedAt, SystemClock.uptimeMillis()));
                int width = device.getDisplayWidth();
                int height = device.getDisplayHeight();
                assertTrue("Fixed42 launcher drawer gesture was not accepted",
                        device.swipe(width / 2, height - 2, width / 2, height / 4, 30));
                drawerGestureSent = true;
            } else {
                SystemClock.sleep(150);
            }
        }
        if (ready == null) {
            log(diagnostics.timeoutLine(
                    drawerGestureSent,
                    Fixed42LauncherDiagnostics.durationMs(
                            startedAt, SystemClock.uptimeMillis())));
        }
        assertNotNull("Timed out waiting for exact fixed42 launcher readiness", ready);

        assertNoBindingTerms();
        assertTrue("Fixed42 launcher deadline elapsed before its fresh icon proof",
                Fixed42LauncherReadinessPolicy.withinDeadline(
                        startedAt, SystemClock.uptimeMillis()));
        Fixed42LauncherObservation fresh = observeFixed42LauncherReadiness(
                appLabel, launcherPackage);
        assertEquals("Fixed42 launcher icon was not freshly ready before click",
                Fixed42LauncherReadinessPolicy.READY, fresh.state);
        assertEquals("Fixed42 launcher icon bounds changed before click",
                ready.iconBounds, fresh.iconBounds);
        UiObject2 freshIcon = findFreshFixed42LauncherIcon(
                appLabel, launcherPackage, fresh.iconBounds);
        assertTrue("Fixed42 launcher deadline elapsed before its icon click",
                Fixed42LauncherReadinessPolicy.withinDeadline(
                        startedAt, SystemClock.uptimeMillis()));
        freshIcon.click();
        assertTrue(appLabel + " package did not become visible for " + phase,
                device.wait(Until.hasObject(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE)), UI_WAIT_MS));
        device.waitForIdle(2_000);
        log("Opened " + appLabel
                + " through its exact visible fixed42 launcher icon for " + phase);
    }

    private Fixed42LauncherObservation observeFixed42LauncherReadiness(
            String appLabel, String launcherPackage) {
        boolean launcherForeground = launcherPackage.equals(device.getCurrentPackageName());
        if (!launcherForeground) {
            int state = Fixed42LauncherReadinessPolicy.classify(
                    false, 0, false, 0, false, false, false);
            return new Fixed42LauncherObservation(
                    state, null,
                    fixed42LauncherPrimitiveDiagnostic(
                            "foreground", false, false, "unknown",
                            0, false,
                            0, false, false,
                            0, false, false,
                            "not-evaluated", 0, false));
        }
        List<AccessibilityNodeInfo> owned = new ArrayList<>();
        List<Integer> parents = new ArrayList<>();
        try {
            assertTrue("Fixed42 launcher cache refresh requires API 34 or newer",
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
            assertTrue("Fixed42 launcher accessibility cache refresh failed",
                    instrumentation.getUiAutomation().clearCache());
            int width = device.getDisplayWidth();
            int height = device.getDisplayHeight();
            String launcherResource = launcherPackage + ":id/launcher";
            AccessibilityNodeInfo root = instrumentation.getUiAutomation()
                    .getRootInActiveWindow();
            if (root == null) {
                int state = Fixed42LauncherReadinessPolicy.classify(
                        launcherForeground, 0, false,
                        0, false, false, false);
                return new Fixed42LauncherObservation(
                        state, null,
                        fixed42LauncherPrimitiveDiagnostic(
                                "root-unavailable", launcherForeground,
                                false, "unknown", 0, false,
                                0, false, false,
                                0, false, false,
                                "not-evaluated", 0, false));
            }
            owned.add(root);
            parents.add(-1);
            boolean stale = false;
            launcherTraversal:
            for (int cursor = 0; cursor < owned.size(); cursor++) {
                AccessibilityNodeInfo node = owned.get(cursor);
                int childCount = node.getChildCount();
                assertTrue("Fixed42 launcher child count exceeded its bound",
                        childCount >= 0 && childCount <= FIXED42_LAUNCHER_CHILD_LIMIT);
                for (int childIndex = 0; childIndex < childCount; childIndex++) {
                    AccessibilityNodeInfo child = node.getChild(childIndex);
                    if (child == null) {
                        stale = true;
                        break launcherTraversal;
                    }
                    assertTrue("Fixed42 launcher traversal exceeded its node bound",
                            owned.size() < FIXED42_LAUNCHER_NODE_LIMIT);
                    for (AccessibilityNodeInfo existing : owned) {
                        if (existing.equals(child)) {
                            child.recycle();
                            throw new AssertionError(
                                    "Fixed42 launcher snapshot returned a duplicate node");
                        }
                    }
                    owned.add(child);
                    parents.add(cursor);
                }
            }
            if (stale) {
                int state = Fixed42LauncherReadinessPolicy.classify(
                        launcherForeground, 0, false, 0, false, false, true);
                return new Fixed42LauncherObservation(
                        state, null,
                        fixed42LauncherPrimitiveDiagnostic(
                                "stale-child", launcherForeground,
                                true, "unknown", owned.size(), true,
                                0, false, false,
                                0, false, false,
                                "not-evaluated", 0, false));
            }

            List<Fixed42AxNode> nodes = new ArrayList<>();
            for (int index = 0; index < owned.size(); index++) {
                nodes.add(new Fixed42AxNode(owned.get(index), parents.get(index)));
            }
            int rootCount = 0;
            int rootIndex = -1;
            int iconCount = 0;
            int iconIndex = -1;
            for (int index = 0; index < nodes.size(); index++) {
                Fixed42AxNode node = nodes.get(index);
                if (launcherResource.equals(node.resourceName)) {
                    rootCount++;
                    rootIndex = index;
                }
                if (node.semanticEquals(appLabel)) {
                    iconCount++;
                    iconIndex = index;
                }
            }
            Fixed42AxNode launcherRoot = rootCount == 1 ? nodes.get(rootIndex) : null;
            boolean rootExact = launcherRoot != null
                    && launcherRoot.matches(
                            launcherPackage, "android.widget.FrameLayout", false, false)
                    && launcherRoot.bounds.equals(new Rect(0, 0, width, height));
            Fixed42AxNode icon = iconCount == 1 ? nodes.get(iconIndex) : null;
            boolean iconExact = false;
            boolean iconFullyVisible = false;
            Rect iconBounds = null;
            if (icon != null) {
                iconBounds = new Rect(icon.bounds);
                iconExact = icon.matches(
                        launcherPackage, "android.widget.TextView", false, true);
                iconFullyVisible = fixed42LauncherIconFullyVisible(
                        nodes, iconIndex, rootIndex, launcherPackage, width, height);
            }
            int state = Fixed42LauncherReadinessPolicy.classify(
                    launcherForeground, rootCount, rootExact,
                    iconCount, iconExact, iconFullyVisible, false);
            boolean rootBoundsMatch = launcherRoot != null
                    && launcherRoot.bounds.equals(new Rect(0, 0, width, height));
            Fixed42LauncherIconDiagnostic iconDiagnostic = icon == null
                    ? Fixed42LauncherIconDiagnostic.notEvaluated()
                    : iconFullyVisible
                            ? Fixed42LauncherIconDiagnostic.visible()
                            : fixed42LauncherIconDiagnostic(
                                    nodes, iconIndex, rootIndex,
                                    launcherPackage, width, height);
            String rejectionReason;
            if (state == Fixed42LauncherReadinessPolicy.READY) {
                rejectionReason = "ready";
            } else if (rootCount == 0) {
                rejectionReason = "root-absent";
            } else if (iconCount == 0) {
                rejectionReason = "icon-absent";
            } else {
                rejectionReason = "icon-clipped";
            }
            boolean activeRootPackageMatch = !nodes.isEmpty()
                    && launcherPackage.equals(nodes.get(0).packageName);
            return new Fixed42LauncherObservation(
                    state, iconBounds,
                    fixed42LauncherPrimitiveDiagnostic(
                            rejectionReason, launcherForeground,
                            true, activeRootPackageMatch ? "match" : "mismatch",
                            nodes.size(), false,
                            rootCount, rootExact, rootBoundsMatch,
                            iconCount, iconExact, iconFullyVisible,
                            iconDiagnostic.reason, iconDiagnostic.ancestryDepth,
                            iconDiagnostic.reachedRoot));
        } finally {
            fixed42RecycleNodes(owned);
        }
    }

    private boolean fixed42LauncherIconFullyVisible(
            List<Fixed42AxNode> nodes,
            int iconIndex,
            int rootIndex,
            String launcherPackage,
            int width,
            int height) {
        if (iconIndex < 0 || rootIndex < 0) return false;
        Rect iconBounds = nodes.get(iconIndex).bounds;
        if (!fixed42FullBounds(iconBounds, width, height)) return false;
        int cursor = iconIndex;
        for (int depth = 0;
                cursor >= 0 && depth < FIXED42_LAUNCHER_ANCESTOR_LIMIT;
                depth++) {
            Fixed42AxNode ancestor = nodes.get(cursor);
            if (!ancestor.visible
                    || !launcherPackage.equals(ancestor.packageName)
                    || !fixed42FullBounds(ancestor.bounds, width, height)
                    || !ancestor.bounds.contains(iconBounds)) {
                return false;
            }
            if (cursor == rootIndex) return true;
            cursor = ancestor.parentIndex;
        }
        return false;
    }

    private Fixed42LauncherIconDiagnostic fixed42LauncherIconDiagnostic(
            List<Fixed42AxNode> nodes,
            int iconIndex,
            int rootIndex,
            String launcherPackage,
            int width,
            int height) {
        if (iconIndex < 0 || rootIndex < 0) {
            return Fixed42LauncherIconDiagnostic.rejected(
                    "disconnected", 0);
        }
        Rect iconBounds = nodes.get(iconIndex).bounds;
        if (!fixed42FullBounds(iconBounds, width, height)) {
            return Fixed42LauncherIconDiagnostic.rejected(
                    "bounds", 0);
        }
        int cursor = iconIndex;
        for (int depth = 0;
                cursor >= 0 && depth < FIXED42_LAUNCHER_ANCESTOR_LIMIT;
                depth++) {
            Fixed42AxNode ancestor = nodes.get(cursor);
            int observedDepth = depth + 1;
            if (!ancestor.visible) {
                return Fixed42LauncherIconDiagnostic.rejected(
                        "ancestor-hidden",
                        observedDepth);
            }
            if (!launcherPackage.equals(ancestor.packageName)) {
                return Fixed42LauncherIconDiagnostic.rejected(
                        "ancestor-package",
                        observedDepth);
            }
            if (!fixed42FullBounds(ancestor.bounds, width, height)) {
                return Fixed42LauncherIconDiagnostic.rejected(
                        "ancestor-bounds",
                        observedDepth);
            }
            if (!ancestor.bounds.contains(iconBounds)) {
                return Fixed42LauncherIconDiagnostic.rejected(
                        "ancestor-containment",
                        observedDepth);
            }
            if (cursor == rootIndex) {
                return new Fixed42LauncherIconDiagnostic(
                        "visible",
                        observedDepth, true);
            }
            cursor = ancestor.parentIndex;
        }
        return Fixed42LauncherIconDiagnostic.rejected(
                "disconnected",
                FIXED42_LAUNCHER_ANCESTOR_LIMIT);
    }

    private static String fixed42LauncherPrimitiveDiagnostic(
            String rejectionReason,
            boolean launcherForeground,
            boolean activeRootPresent,
            String activeRootPackageMatch,
            int nodeCount,
            boolean nullChildObserved,
            int rootCount,
            boolean rootExact,
            boolean rootBoundsMatch,
            int iconCount,
            boolean iconExact,
            boolean iconFullyVisible,
            String iconRejectionReason,
            int iconAncestryDepth,
            boolean iconReachedRoot) {
        return new StringBuilder("reject=").append(rejectionReason)
                .append(" foreground=").append(launcherForeground)
                .append(" activeRoot=").append(activeRootPresent)
                .append(" activePkg=").append(activeRootPackageMatch)
                .append(" nodes=").append(nodeCount)
                .append(" nullChild=").append(nullChildObserved)
                .append(" root=").append(rootCount).append('/')
                .append(rootExact).append('/').append(rootBoundsMatch)
                .append(" icon=").append(iconCount).append('/')
                .append(iconExact).append('/').append(iconFullyVisible)
                .append(" iconReject=").append(iconRejectionReason)
                .append(" ancestry=").append(iconAncestryDepth).append('/')
                .append(iconReachedRoot)
                .toString();
    }

    private UiObject2 findFreshFixed42LauncherIcon(
            String appLabel, String launcherPackage, Rect expectedBounds) {
        assertEquals("Fixed42 launcher package left the foreground before click",
                launcherPackage, device.getCurrentPackageName());
        List<UiObject2> matches = new ArrayList<>();
        addDistinctUiObjects(matches,
                device.findObjects(By.text(appLabel).pkg(launcherPackage)));
        addDistinctUiObjects(matches,
                device.findObjects(By.desc(appLabel).pkg(launcherPackage)));
        assertEquals("Expected one fresh exact fixed42 launcher icon", 1, matches.size());
        UiObject2 icon = matches.get(0);
        assertEquals("Fresh fixed42 launcher icon package changed",
                launcherPackage, icon.getApplicationPackage());
        assertEquals("Fresh fixed42 launcher icon class changed",
                "android.widget.TextView", icon.getClassName());
        assertTrue("Fresh fixed42 launcher icon identity changed",
                appLabel.equals(icon.getText())
                        || appLabel.equals(icon.getContentDescription()));
        assertTrue("Fresh fixed42 launcher icon was not actionable",
                icon.isClickable() && icon.isEnabled());
        assertEquals("Fresh fixed42 launcher icon was clipped or moved",
                expectedBounds, icon.getVisibleBounds());
        return icon;
    }

    private void launchVisibleAppFromLauncher(String appLabel, String expectedPackage, String phase) {
        device.pressHome();
        device.waitForIdle(1_000);
        String launcherPackage = device.getCurrentPackageName();
        assertNotNull("Launcher package was unavailable for " + appLabel, launcherPackage);
        assertFalse("Product remained foreground while seeking launcher icon",
                OtaFlowPolicy.PRODUCT_PACKAGE.equals(launcherPackage));
        UiObject2 icon = findUniqueLauncherObject(appLabel, launcherPackage, true);
        if (icon == null) {
            int width = device.getDisplayWidth();
            int height = device.getDisplayHeight();
            device.swipe(width / 2, height - 2, width / 2, height / 4, 30);
            device.waitForIdle(1_000);
            launcherPackage = device.getCurrentPackageName();
            icon = findUniqueLauncherObject(appLabel, launcherPackage, true);
        }
        assertNotNull("Visible launcher icon was unavailable for " + appLabel, icon);
        assertNoBindingTerms();
        icon.click();
        assertTrue(appLabel + " package did not become visible for " + phase,
                device.wait(Until.hasObject(By.pkg(expectedPackage)), UI_WAIT_MS));
        device.waitForIdle(2_000);
        log("Opened " + appLabel + " through its exact visible launcher icon for " + phase);
    }

    private UiObject2 findUniqueLauncherObject(
            String appLabel, String launcherPackage, boolean clickable) {
        BySelector text = By.text(appLabel).pkg(launcherPackage);
        BySelector description = By.desc(appLabel).pkg(launcherPackage);
        if (clickable) {
            text = text.clickable(true);
            description = description.clickable(true);
        }
        List<UiObject2> matches = new ArrayList<>();
        addDistinctUiObjects(matches, device.findObjects(text));
        addDistinctUiObjects(matches, device.findObjects(description));
        if (matches.isEmpty()) return null;
        assertEquals("Expected one exact launcher object for " + appLabel, 1, matches.size());
        return matches.get(0);
    }

    private void addDistinctUiObjects(List<UiObject2> destination, List<UiObject2> candidates) {
        for (UiObject2 candidate : candidates) {
            boolean duplicate = false;
            for (UiObject2 existing : destination) {
                if (sameUiIdentity(existing, candidate)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) destination.add(candidate);
        }
    }

    private boolean sameUiIdentity(UiObject2 first, UiObject2 second) {
        return first.getVisibleBounds().equals(second.getVisibleBounds())
                && String.valueOf(first.getApplicationPackage())
                        .equals(String.valueOf(second.getApplicationPackage()))
                && String.valueOf(first.getClassName())
                        .equals(String.valueOf(second.getClassName()))
                && String.valueOf(first.getResourceName())
                        .equals(String.valueOf(second.getResourceName()));
    }

    private void dismissVisibleRecentTaskAndRelaunchThroughLauncher() throws Exception {
        device.pressRecentApps();
        device.waitForIdle(1_000);
        String launcherPackage = device.getCurrentPackageName();
        assertNotNull("Launcher package was unavailable in recents", launcherPackage);
        assertFalse("Product package remained foreground in recents",
                OtaFlowPolicy.PRODUCT_PACKAGE.equals(launcherPackage));
        UiObject2 title = null;
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (title == null && SystemClock.uptimeMillis() < deadline) {
            title = findUniqueLauncherObject("YAWF Stream", launcherPackage, false);
            if (title == null) SystemClock.sleep(250);
        }
        assertNotNull("Unique visible YAWF Stream recents card was unavailable", title);
        Rect card = title.getVisibleBounds();
        UiObject2 parent = title.getParent();
        for (int depth = 0; depth < 4 && parent != null; depth++) {
            Rect parentBounds = parent.getVisibleBounds();
            if (parentBounds.height() > card.height()) card = parentBounds;
            parent = parent.getParent();
        }
        assertFalse("Visible YAWF Stream recents card bounds were empty", card.isEmpty());
        capture("automatic-recents-before-task-dismissal");
        visibleTaskDismissalSwipes++;
        device.swipe(card.centerX(), card.centerY(), card.centerX(), 0, 35);
        boolean exactTextAbsent = device.wait(
                Until.gone(By.text("YAWF Stream").pkg(launcherPackage)), SHORT_WAIT_MS);
        boolean exactDescriptionAbsent = device.wait(
                Until.gone(By.desc("YAWF Stream").pkg(launcherPackage)), SHORT_WAIT_MS);
        assertTrue("YAWF Stream recents card did not visibly dismiss by both identities",
                AutomaticOtaDriverChecks.visibleTaskDismissalCompleted(
                        visibleTaskDismissalSwipes,
                        exactTextAbsent,
                        exactDescriptionAbsent));
        visibleTaskDismissalObserved = true;
        launchProductFromVisibleLauncher("task-relaunch persistence check");
        waitFor(By.text("Discover"), UI_WAIT_MS, "task-relaunch Discover");
    }

    private void advanceFixedTour(String[] titles, String capturePrefix) throws IOException {
        for (int step = 0; step < titles.length; step++) {
            String title = titles[step];
            waitFor(By.text(title), UI_WAIT_MS, capturePrefix + " title " + (step + 1));
            String label = OtaFlowPolicy.forwardLabel(step, titles.length);
            OtaFlowPolicy.WebButtonSpec button = "Next".equals(label)
                    ? OtaFlowPolicy.NEXT
                    : OtaFlowPolicy.GET_STARTED;
            waitForAny(SHORT_WAIT_MS, webButtonSelectors(button));
            capture(capturePrefix + "-" + (step + 1));
            clickWebButton(button, capturePrefix + " " + label, SHORT_WAIT_MS);
            if (step + 1 < titles.length) {
                if (titles == WELCOME_TITLES) {
                    waitForRefreshedWelcomeStage(
                            titles[step + 1], step + 2, capturePrefix + " next stage");
                } else {
                    waitFor(By.text(titles[step + 1]), UI_WAIT_MS, capturePrefix + " next stage");
                }
            } else {
                if (titles == WELCOME_TITLES) {
                    waitForRefreshedWelcomeClosed(capturePrefix);
                } else {
                    assertTrue(
                            capturePrefix + " did not close after its final action",
                            device.wait(Until.gone(By.text(title)), UI_WAIT_MS));
                }
            }
        }
    }

    private void waitForRefreshedWelcomeStage(
            String expectedTitle, int oneBasedStep, String label) {
        assertTrue(
                "Accessibility cache refresh requires Android API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        BySelector dialogSelector = By.text("Welcome tour")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.app.Dialog");
        BySelector titleSelector = By.text(expectedTitle)
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.TextView");
        BySelector counterSelector = By.text(String.valueOf(oneBasedStep))
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.TextView");
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        int settled = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            boolean cacheCleared = instrumentation.getUiAutomation().clearCache();
            UiObject2 dialog = cacheCleared ? device.findObject(dialogSelector) : null;
            boolean exactStage = dialog != null
                    && dialog.findObject(titleSelector) != null
                    && dialog.findObject(counterSelector) != null;
            if (exactStage) {
                settled++;
                if (settled >= WELCOME_STAGE_SETTLED_SAMPLES) {
                    log("Observed refreshed exact Welcome title and counter for " + label);
                    return;
                }
            } else {
                settled = 0;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for refreshed exact Welcome title and counter for " + label);
    }

    private void waitForRefreshedWelcomeClosed(String label) {
        BySelector dialogSelector = By.text("Welcome tour")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.app.Dialog");
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        int settled = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            boolean cacheCleared = instrumentation.getUiAutomation().clearCache();
            boolean dialogGone = cacheCleared && device.findObject(dialogSelector) == null;
            if (dialogGone && ++settled >= WELCOME_STAGE_SETTLED_SAMPLES) {
                log("Observed refreshed Welcome dialog closure for " + label);
                return;
            }
            if (!dialogGone) {
                settled = 0;
            }
            SystemClock.sleep(250);
        }
        fail(label + " did not settle closed after its final action");
    }

    private void dismissSetupReminder() throws IOException {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline && !hasSetupReminder()) {
            assertNoBindingTerms();
            SystemClock.sleep(250);
        }
        assertTrue("Streaming setup reminder did not mount", hasSetupReminder());
        capture("setup-reminder");
        clickWebButton(OtaFlowPolicy.DISMISS_SETUP_REMINDER, "Dismiss setup reminder", SHORT_WAIT_MS);
        int absent = 0;
        deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            if (hasSetupReminder()) {
                absent = 0;
            } else if (OtaFlowPolicy.isSettledAbsent(++absent)) {
                log("Setup reminder remained absent for the settled interval");
                return;
            }
            SystemClock.sleep(250);
        }
        fail("Streaming setup reminder did not settle closed");
    }

    private boolean hasSetupReminder() {
        return hasAnyWithoutIdleDelay(
                By.desc("Streaming setup reminder"), By.text("Streaming setup reminder"));
    }

    private void openSettingsAndAssertSimple(String phase) throws IOException {
        clickWebButton(OtaFlowPolicy.MORE_NAVIGATION, "More navigation", UI_WAIT_MS);
        waitFor(By.res("mobile-nav-more"), SHORT_WAIT_MS, "More dialog");
        assertFalse("Simple navigation exposed Assistant", hasAnyWithoutIdleDelay(By.text("Assistant")));
        assertFalse("Simple navigation exposed Calendar", hasAnyWithoutIdleDelay(By.text("Calendar")));
        assertFalse("Simple navigation exposed Debrid", hasAnyWithoutIdleDelay(By.text("Debrid")));
        click(By.text("Settings"), "Settings", SHORT_WAIT_MS, false);
        waitForSettingsRoute();
        UiObject2 simple = scrollUntilVisibleProductSemantic(
                "Simple", "android.widget.RadioButton", true, Direction.DOWN);
        waitForAny(
                UI_WAIT_MS,
                productTextOrDescriptionSelectors(
                        "Experience tier", "android.widget.RadioGroup", false));
        assertTrue("Simple experience option was disabled", simple.isEnabled());
        log("Observed the exact visible Simple option; API 36 WebView accessibility did not expose "
                + "its selected state, so the screenshot retains the visual selection evidence");
        capture("settings-" + phase);
    }

    private void waitForSettingsRoute() {
        BySelector[] anchors = {
                By.text("Help & updates"),
                By.text("Install & setup"),
                By.text("Appearance"),
                By.desc("Settings category")
        };
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            if (hasAnyWithoutIdleDelay(By.text("How do you want to use YAWF Stream?"))) {
                fail("FirstRunWizard opened instead of Settings");
            }
            if (!hasAnyWithoutIdleDelay(By.res("mobile-nav-more")) && findAnyNow(anchors) != null) {
                return;
            }
            SystemClock.sleep(250);
        }
        fail("Settings did not replace More with a Settings-only anchor");
    }

    private void openHelpAndUpdates() {
        BySelector[] directSelectors = productTextOrDescriptionSelectors(
                "Help & updates", "android.widget.Button", true);
        UiObject2 direct = findAnyNow(directSelectors);
        if (direct != null && isVisibleAboveBottomNavigation(direct)) {
            clickProductSemantic("Help & updates", "android.widget.Button", SHORT_WAIT_MS);
            return;
        }
        UiObject2 category = scrollUntilVisibleProductSemantic(
                "Install & setup", "android.view.View", true, Direction.UP);
        assertNoBindingTerms();
        category = findAnyNow(productTextOrDescriptionSelectors(
                "Install & setup", "android.view.View", true));
        assertNotNull("Install & setup category disappeared after policy guard", category);
        category.click();
        log("Opened semantic Settings category selector");
        device.waitForIdle(1_000);
        click(By.text("Help & updates"), "Help & updates", SHORT_WAIT_MS, true);
    }

    private void tapVisibleAndroidUpdateCheckCard(String captureLabel) throws IOException {
        BySelector title = By.text("Android APK updates")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.TextView")
                .enabled(true);
        scrollUntilVisibleExactProduct(title, "Android APK updates title", Direction.DOWN);
        BySelector check = By.text("Check for Android updates")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.Button")
                .clickable(true)
                .enabled(true);
        UiObject2 button = scrollUntilVisibleExactProduct(
                check, "Check for Android updates button", Direction.DOWN);
        if (captureLabel != null) {
            capture(captureLabel);
        }
        assertNoBindingTerms();
        button = device.findObject(check);
        assertNotNull("Exact Check for Android updates button disappeared before tap", button);
        assertTrue(
                "Exact Check for Android updates button was not safely visible above bottom navigation",
                isVisibleAboveBottomNavigation(button));
        button.click();
        log("Tapped the exact visible Android APK updates card Check for Android updates button");
        device.waitForIdle(750);
    }

    private UiObject2 scrollUntilVisibleExactProduct(
            BySelector selector, String label, Direction direction) throws IOException {
        for (int attempt = 0; attempt < 12; attempt++) {
            UiObject2 found = device.findObject(selector);
            if (found != null && isVisibleAboveBottomNavigation(found)) {
                return found;
            }
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking " + label, scrollable);
            assertNoBindingTerms();
            scrollable = device.findObject(By.scrollable(true));
            assertNotNull("Scrollable container disappeared while seeking " + label, scrollable);
            configureSettingsScrollGesture(scrollable);
            boolean canStillScroll = scrollable.scroll(direction, 0.75f);
            log("Performed bounded Settings scroll gesture while seeking exact " + label
                    + "; canStillScroll=" + canStillScroll);
            device.waitForIdle(750);
        }
        fail("Could not place exact " + label + " above bottom navigation");
        return null;
    }

    private UiObject2 scrollUntilVisibleProductSemantic(
            String text, String className, boolean clickable, Direction direction) {
        BySelector[] selectors = productTextOrDescriptionSelectors(text, className, clickable);
        for (int attempt = 0; attempt < 12; attempt++) {
            UiObject2 found = findAnyNow(selectors);
            if (found != null && isVisibleAboveBottomNavigation(found)) {
                return found;
            }
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking " + text, scrollable);
            assertNoBindingTerms();
            scrollable = device.findObject(By.scrollable(true));
            assertNotNull("Scrollable container disappeared while seeking " + text, scrollable);
            configureSettingsScrollGesture(scrollable);
            boolean canStillScroll = scrollable.scroll(direction, 0.75f);
            log("Performed bounded semantic Settings scroll gesture while seeking " + text
                    + "; canStillScroll=" + canStillScroll);
            device.waitForIdle(750);
        }
        fail("Could not place exact " + text + " control above bottom navigation");
        return null;
    }

    private UiObject2 findUniqueExactProductDialog(String exactIdentity) {
        List<UiObject2> dialogs = device.findObjects(
                By.clazz(DETAIL_DIALOG_CLASS).pkg(OtaFlowPolicy.PRODUCT_PACKAGE));
        AutomaticOtaDriverChecks.DialogCandidate[] candidates =
                new AutomaticOtaDriverChecks.DialogCandidate[dialogs.size()];
        for (int index = 0; index < dialogs.size(); index++) {
            UiObject2 dialog = dialogs.get(index);
            candidates[index] = new AutomaticOtaDriverChecks.DialogCandidate(
                    dialog.getApplicationPackage(),
                    dialog.getClassName(),
                    dialog.getText(),
                    dialog.getContentDescription());
        }
        int selected = AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                OtaFlowPolicy.PRODUCT_PACKAGE,
                DETAIL_DIALOG_CLASS,
                exactIdentity,
                candidates);
        assertFalse("Expected at most one exact product detail dialog for " + exactIdentity,
                selected == AutomaticOtaDriverChecks.AMBIGUOUS_DIALOG_INDEX);
        return selected == AutomaticOtaDriverChecks.NO_DIALOG_INDEX
                ? null
                : dialogs.get(selected);
    }

    private UiObject2 waitForUniqueExactProductDialog(String exactIdentity, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            UiObject2 dialog = findUniqueExactProductDialog(exactIdentity);
            if (dialog != null) return dialog;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for exact product detail dialog " + exactIdentity);
        return null;
    }

    private boolean waitForUniqueExactProductDialogGone(String exactIdentity, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            if (findUniqueExactProductDialog(exactIdentity) == null) return true;
            SystemClock.sleep(200);
        }
        return false;
    }

    private boolean waitForFreshFixed42DialogGone(String exactIdentity, long timeoutMs) {
        assertTrue("Fresh dialog closure observation is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        return Fixed42DialogClosurePolicy.waitForGone(
                timeoutMs,
                new Fixed42DialogClosurePolicy.ObservationSource() {
                    @Override
                    public int observe() {
                        return observeFreshFixed42Dialog(exactIdentity);
                    }
                },
                new Fixed42DialogClosurePolicy.Clock() {
                    @Override
                    public long uptimeMillis() {
                        return SystemClock.uptimeMillis();
                    }

                    @Override
                    public void sleep(long millis) {
                        SystemClock.sleep(millis);
                    }
                });
    }

    private int observeFreshFixed42Dialog(String exactIdentity) {
        assertTrue("Fixed42 dialog cache refresh requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fixed42 dialog accessibility cache refresh failed",
                instrumentation.getUiAutomation().clearCache());
        try {
            List<UiObject2> dialogs = device.findObjects(
                    By.clazz(DETAIL_DIALOG_CLASS).pkg(OtaFlowPolicy.PRODUCT_PACKAGE));
            AutomaticOtaDriverChecks.DialogCandidate[] candidates =
                    new AutomaticOtaDriverChecks.DialogCandidate[dialogs.size()];
            for (int index = 0; index < dialogs.size(); index++) {
                UiObject2 dialog = dialogs.get(index);
                candidates[index] = new AutomaticOtaDriverChecks.DialogCandidate(
                        dialog.getApplicationPackage(),
                        dialog.getClassName(),
                        dialog.getText(),
                        dialog.getContentDescription());
            }
            int selected = AutomaticOtaDriverChecks.uniqueExactDialogIndex(
                    OtaFlowPolicy.PRODUCT_PACKAGE,
                    DETAIL_DIALOG_CLASS,
                    exactIdentity,
                    candidates);
            if (selected == AutomaticOtaDriverChecks.AMBIGUOUS_DIALOG_INDEX) {
                return Fixed42DialogClosurePolicy.AMBIGUOUS;
            }
            return selected == AutomaticOtaDriverChecks.NO_DIALOG_INDEX
                    ? Fixed42DialogClosurePolicy.ABSENT
                    : Fixed42DialogClosurePolicy.PRESENT;
        } catch (StaleObjectException stale) {
            return Fixed42DialogClosurePolicy.STALE;
        }
    }

    private static final class Fixed42CriticalQueryGroupPolicy {
        static final String TEXT_VIEW_CLASS = "android.widget.TextView";

        private static final class Candidate {
            final String packageName;
            final String className;
            final String text;

            Candidate(String packageName, String className, String text) {
                this.packageName = packageName;
                this.className = className;
                this.text = text;
            }
        }

        private static final class Counts {
            private final int[] counts;

            Counts(int[] counts) {
                this.counts = counts.clone();
            }

            int count(int index) {
                if (index < 0 || index >= counts.length) {
                    throw new AssertionError("Fixed42 query count index was out of bounds");
                }
                return counts[index];
            }

            int size() {
                return counts.length;
            }

            int total() {
                int total = 0;
                for (int count : counts) total += count;
                return total;
            }

            int[] values() {
                return counts.clone();
            }
        }

        static Pattern exactTextPattern(String... exactTexts) {
            validateExactTexts(exactTexts);
            StringBuilder pattern = new StringBuilder("\\A(?:");
            for (int index = 0; index < exactTexts.length; index++) {
                if (index > 0) pattern.append('|');
                pattern.append(Pattern.quote(exactTexts[index]));
            }
            return Pattern.compile(pattern.append(")\\z").toString());
        }

        static Counts classify(
                String expectedPackage,
                String expectedClass,
                String[] exactTexts,
                Candidate... candidates) {
            validateExactTexts(exactTexts);
            if (expectedPackage == null || expectedClass == null || candidates == null) {
                throw new AssertionError("Fixed42 query group inputs were incomplete");
            }
            int[] counts = new int[exactTexts.length];
            for (Candidate candidate : candidates) {
                if (candidate == null
                        || !expectedPackage.equals(candidate.packageName)
                        || !expectedClass.equals(candidate.className)) {
                    throw new AssertionError("Fixed42 query group escaped its package or class scope");
                }
                int selected = -1;
                for (int index = 0; index < exactTexts.length; index++) {
                    if (exactTexts[index].equals(candidate.text)) {
                        selected = index;
                        break;
                    }
                }
                if (selected < 0) {
                    throw new AssertionError("Fixed42 query group returned an inexact name");
                }
                counts[selected]++;
            }
            return new Counts(counts);
        }

        static boolean isInitialCheckingReady(
                Counts progressCounts, Counts terminalCounts, int cancelCount) {
            requireCountShape(progressCounts, 2);
            requireCountShape(terminalCounts, 3);
            requireAtMostOneEach(progressCounts);
            requireTerminalAbsent(terminalCounts);
            requireAtMostOneCancel(cancelCount);
            return progressCounts.count(0) == 1
                    && progressCounts.count(1) == 1
                    && cancelCount == 1;
        }

        static void assertFreshCancelReady(Counts terminalCounts, int cancelCount) {
            requireCountShape(terminalCounts, 3);
            requireTerminalAbsent(terminalCounts);
            if (cancelCount != 1) {
                throw new AssertionError("Fixed42 fresh Cancel was absent or ambiguous");
            }
        }

        static boolean isSettledAbsent(
                Counts progressCounts, Counts terminalCounts, int cancelCount) {
            requireCountShape(progressCounts, 2);
            requireCountShape(terminalCounts, 3);
            requireAtMostOneEach(progressCounts);
            requireTerminalAbsent(terminalCounts);
            requireAtMostOneCancel(cancelCount);
            return progressCounts.total() == 0 && cancelCount == 0;
        }

        private static void validateExactTexts(String[] exactTexts) {
            if (exactTexts == null || exactTexts.length == 0) {
                throw new AssertionError("Fixed42 query group had no exact names");
            }
            for (int index = 0; index < exactTexts.length; index++) {
                if (exactTexts[index] == null || exactTexts[index].isEmpty()) {
                    throw new AssertionError("Fixed42 query group had an empty exact name");
                }
                for (int prior = 0; prior < index; prior++) {
                    if (exactTexts[index].equals(exactTexts[prior])) {
                        throw new AssertionError("Fixed42 query group had duplicate exact names");
                    }
                }
            }
        }

        private static void requireCountShape(Counts counts, int expectedSize) {
            if (counts == null || counts.size() != expectedSize) {
                throw new AssertionError("Fixed42 query group count shape changed");
            }
        }

        private static void requireAtMostOneEach(Counts counts) {
            for (int index = 0; index < counts.size(); index++) {
                if (counts.count(index) > 1) {
                    throw new AssertionError("Fixed42 query group was ambiguous");
                }
            }
        }

        private static void requireTerminalAbsent(Counts terminalCounts) {
            if (terminalCounts.total() != 0) {
                throw new AssertionError("Fixed42 terminal result won before cancellation");
            }
        }

        private static void requireAtMostOneCancel(int cancelCount) {
            if (cancelCount < 0 || cancelCount > 1) {
                throw new AssertionError("Fixed42 Cancel query was ambiguous");
            }
        }
    }

    private static final class Fixed42AppearancePolicy {
        private static boolean empty(String value) {
            return value == null || value.isEmpty();
        }

        static boolean isExactStyleControl(
                String text,
                String description,
                String className,
                String packageName,
                boolean clickable,
                boolean enabled,
                int left,
                int top,
                int right,
                int bottom,
                int displayWidth,
                int displayHeight,
                int navigationTop,
                String expectedText,
                String expectedPackage) {
            return expectedText.equals(text)
                    && empty(description)
                    && "android.widget.ToggleButton".equals(className)
                    && expectedPackage.equals(packageName)
                    && clickable
                    && enabled
                    && visibleAboveNavigation(
                            left, top, right, bottom,
                            displayWidth, displayHeight, navigationTop);
        }

        static boolean isExactSummary(
                String text,
                String description,
                String className,
                String packageName,
                boolean clickable,
                boolean enabled,
                int left,
                int top,
                int right,
                int bottom,
                int displayWidth,
                int displayHeight,
                int navigationTop,
                boolean clickableAncestor,
                String expectedText,
                String expectedPackage) {
            return expectedText.equals(text)
                    && empty(description)
                    && "android.widget.TextView".equals(className)
                    && expectedPackage.equals(packageName)
                    && !clickable
                    && enabled
                    && visibleAboveNavigation(
                            left, top, right, bottom,
                            displayWidth, displayHeight, navigationTop)
                    && !clickableAncestor;
        }

        private static boolean visibleAboveNavigation(
                int left,
                int top,
                int right,
                int bottom,
                int displayWidth,
                int displayHeight,
                int navigationTop) {
            return left >= 0
                    && top >= 0
                    && right > left
                    && bottom > top
                    && right <= displayWidth
                    && bottom <= displayHeight
                    && bottom <= navigationTop;
        }

        static boolean hasUniqueCandidate(int count) {
            return count == 1;
        }
    }

    private static final class Fixed42LauncherReadinessPolicy {
        static final int WAITING_FOR_LAUNCHER = 0;
        static final int WAITING_FOR_ICON = 1;
        static final int STALE = 2;
        static final int READY = 3;

        static int classify(
                boolean launcherForeground,
                int rootCount,
                boolean rootExact,
                int iconCount,
                boolean iconExact,
                boolean iconFullyVisible,
                boolean stale) {
            if (stale) return STALE;
            if (rootCount < 0 || iconCount < 0) {
                throw new AssertionError("Fixed42 launcher counts were invalid");
            }
            if (rootCount > 1 || iconCount > 1) {
                throw new AssertionError("Fixed42 launcher observation was ambiguous");
            }
            if (!launcherForeground) return WAITING_FOR_LAUNCHER;
            if (rootCount == 0) {
                if (iconCount != 0) {
                    throw new AssertionError("Fixed42 launcher icon had no exact root");
                }
                return WAITING_FOR_LAUNCHER;
            }
            if (!rootExact) {
                throw new AssertionError("Fixed42 launcher root identity changed");
            }
            if (iconCount == 0) return WAITING_FOR_ICON;
            if (!iconExact) {
                throw new AssertionError("Fixed42 launcher icon identity changed");
            }
            if (!iconFullyVisible) return WAITING_FOR_ICON;
            return READY;
        }

        static boolean withinDeadline(long startedAt, long now) {
            return now >= startedAt && now - startedAt < SHORT_WAIT_MS;
        }
    }

    private static final class Fixed42SeedPolicy {
        static final int ABSENT = Integer.MIN_VALUE;
        static final int PHASE_VERTICAL = 0;
        static final int PHASE_HORIZONTAL = 1;
        static final int PHASE_READY = 2;

        static final class Observation {
            final boolean routeValid;
            final int mainCount;
            final int discoverCount;
            final int headingCount;
            final int railCount;
            final int bladeCount;
            final boolean sectionValid;
            final boolean railValid;
            final boolean railReady;
            final boolean bladeInRail;
            final boolean bladeReady;
            final int[] verticalTops;
            final int[] cardLefts;

            Observation(
                    boolean routeValid,
                    int mainCount,
                    int discoverCount,
                    int headingCount,
                    int railCount,
                    int bladeCount,
                    boolean sectionValid,
                    boolean railValid,
                    boolean railReady,
                    boolean bladeInRail,
                    boolean bladeReady,
                    int[] verticalTops,
                    int[] cardLefts) {
                this.routeValid = routeValid;
                this.mainCount = mainCount;
                this.discoverCount = discoverCount;
                this.headingCount = headingCount;
                this.railCount = railCount;
                this.bladeCount = bladeCount;
                this.sectionValid = sectionValid;
                this.railValid = railValid;
                this.railReady = railReady;
                this.bladeInRail = bladeInRail;
                this.bladeReady = bladeReady;
                this.verticalTops = verticalTops.clone();
                this.cardLefts = cardLefts.clone();
            }
        }

        static int phase(Observation observation) {
            if (!observation.routeValid
                    || observation.mainCount != 1
                    || observation.discoverCount != 1) {
                throw new AssertionError("Fixed42 Discover route identity was not unique");
            }
            if (observation.headingCount < 0
                    || observation.headingCount > 1
                    || observation.railCount < 0
                    || observation.railCount > 1
                    || observation.bladeCount < 0
                    || observation.bladeCount > 1) {
                throw new AssertionError("Fixed42 seed identity was ambiguous");
            }
            if (observation.headingCount == 0) {
                if (observation.railCount != 0 || observation.bladeCount != 0) {
                    throw new AssertionError("Fixed42 seed escaped Popular Movies");
                }
                return PHASE_VERTICAL;
            }
            if (!observation.sectionValid
                    || observation.railCount != 1
                    || !observation.railValid) {
                throw new AssertionError("Popular Movies section or rail identity changed");
            }
            if (observation.bladeCount == 1 && !observation.bladeInRail) {
                throw new AssertionError("Blade Runner escaped the Popular Movies rail");
            }
            if (observation.bladeReady) {
                if (!observation.railReady || observation.bladeCount != 1) {
                    throw new AssertionError("Blade Runner readiness was inconsistent");
                }
                return PHASE_READY;
            }
            return observation.railReady ? PHASE_HORIZONTAL : PHASE_VERTICAL;
        }

        static boolean didAdvance(int actionPhase, Observation before, Observation after) {
            int beforePhase = phase(before);
            int afterPhase = phase(after);
            if (actionPhase != beforePhase || actionPhase == PHASE_READY) {
                throw new AssertionError("Fixed42 seed action did not match its observed phase");
            }
            if (afterPhase < beforePhase) {
                throw new AssertionError("Fixed42 seed route regressed after an action");
            }
            if (afterPhase > beforePhase) return true;
            return actionPhase == PHASE_VERTICAL
                    ? movedTowardStart(before.verticalTops, after.verticalTops)
                    : movedTowardStart(before.cardLefts, after.cardLefts);
        }

        static boolean mayScroll(int completedActions, long startedAt, long now) {
            return completedActions >= 0
                    && completedActions < FIXED42_SEED_SCROLL_ACTION_LIMIT
                    && withinDeadline(startedAt, now);
        }

        static boolean withinDeadline(long startedAt, long now) {
            return now >= startedAt && now - startedAt < FIXED42_SEED_SCROLL_BOUND_MS;
        }

        static String phaseName(int phase) {
            if (phase == PHASE_VERTICAL) return "vertical";
            if (phase == PHASE_HORIZONTAL) return "horizontal";
            if (phase == PHASE_READY) return "ready";
            throw new AssertionError("Unknown fixed42 seed phase");
        }

        private static boolean movedTowardStart(int[] before, int[] after) {
            if (before.length != after.length) {
                throw new AssertionError("Fixed42 seed progress vector shape changed");
            }
            for (int index = 0; index < before.length; index++) {
                if (before[index] != ABSENT
                        && after[index] != ABSENT
                        && after[index] < before[index]) {
                    return true;
                }
            }
            return lastPresent(after) > lastPresent(before);
        }

        private static int lastPresent(int[] values) {
            for (int index = values.length - 1; index >= 0; index--) {
                if (values[index] != ABSENT) return index;
            }
            return -1;
        }
    }

    private static final class Fixed42LauncherObservation {
        final int state;
        final Rect iconBounds;
        final String diagnostic;

        Fixed42LauncherObservation(int state, Rect iconBounds, String diagnostic) {
            this.state = state;
            this.iconBounds = iconBounds == null ? null : new Rect(iconBounds);
            this.diagnostic = diagnostic;
        }
    }

    private static final class Fixed42LauncherIconDiagnostic {
        final String reason;
        final int ancestryDepth;
        final boolean reachedRoot;

        Fixed42LauncherIconDiagnostic(String reason, int ancestryDepth, boolean reachedRoot) {
            this.reason = reason;
            this.ancestryDepth = ancestryDepth;
            this.reachedRoot = reachedRoot;
        }

        static Fixed42LauncherIconDiagnostic notEvaluated() {
            return new Fixed42LauncherIconDiagnostic("not-evaluated", 0, false);
        }

        static Fixed42LauncherIconDiagnostic visible() {
            return new Fixed42LauncherIconDiagnostic("visible", 0, true);
        }

        static Fixed42LauncherIconDiagnostic rejected(String reason, int ancestryDepth) {
            return new Fixed42LauncherIconDiagnostic(reason, ancestryDepth, false);
        }
    }

    private static final class Fixed42LauncherDiagnostics {
        private static final String EMPTY_PRIMITIVES =
                "reject=none foreground=false activeRoot=false activePkg=unknown"
                        + " nodes=0 nullChild=false root=0/false/false"
                        + " icon=0/false/false iconReject=not-evaluated ancestry=0/false";
        private final int[] stateCounts = new int[4];
        private int samples;
        private int lastState = -1;
        private long lastObservationMs = -1L;
        private long maxObservationMs = -1L;
        private String lastPrimitives = EMPTY_PRIMITIVES;

        void record(int state, String primitives, long observationMs) {
            if (samples < Integer.MAX_VALUE) samples++;
            if (state >= 0
                    && state < stateCounts.length
                    && stateCounts[state] < Integer.MAX_VALUE) {
                stateCounts[state]++;
            }
            lastState = state;
            lastPrimitives = primitives;
            lastObservationMs = observationMs;
            if (observationMs > maxObservationMs) maxObservationMs = observationMs;
        }

        String timeoutLine(boolean drawerGestureSent, long elapsedMs) {
            return new StringBuilder("Fixed42 launcher readiness timeout")
                    .append(" samples=").append(samples)
                    .append(" states=").append(joinCounts(stateCounts))
                    .append(" lastState=").append(lastState)
                    .append(" drawer=").append(drawerGestureSent)
                    .append(" elapsedMs=").append(elapsedMs)
                    .append(" observeMs=").append(lastObservationMs).append('/').append(maxObservationMs)
                    .append(' ').append(lastPrimitives)
                    .toString();
        }

        static long durationMs(long startedAt, long finishedAt) {
            return finishedAt >= startedAt ? finishedAt - startedAt : -1L;
        }

        private static String joinCounts(int[] counts) {
            return counts[0] + "/" + counts[1] + "/" + counts[2] + "/" + counts[3];
        }
    }

    private static final class Fixed42AxNode {
        final AccessibilityNodeInfo info;
        final int parentIndex;
        final String text;
        final String description;
        final String packageName;
        final String className;
        final String resourceName;
        final boolean visible;
        final boolean scrollable;
        final boolean clickable;
        final boolean enabled;
        final Rect bounds;

        Fixed42AxNode(AccessibilityNodeInfo info, int parentIndex) {
            this.info = info;
            this.parentIndex = parentIndex;
            text = fixed42NodeString(info.getText());
            description = fixed42NodeString(info.getContentDescription());
            packageName = fixed42NodeString(info.getPackageName());
            className = fixed42NodeString(info.getClassName());
            resourceName = fixed42NodeString(info.getViewIdResourceName());
            visible = info.isVisibleToUser();
            scrollable = info.isScrollable();
            clickable = info.isClickable();
            enabled = info.isEnabled();
            bounds = new Rect();
            info.getBoundsInScreen(bounds);
        }

        boolean semanticEquals(String exact) {
            return fixed42SemanticEquals(text, description, exact);
        }

        boolean matches(
                String expectedPackage,
                String expectedClass,
                boolean expectedScrollable,
                boolean expectedClickable) {
            return expectedPackage.equals(packageName)
                    && expectedClass.equals(className)
                    && visible
                    && scrollable == expectedScrollable
                    && clickable == expectedClickable
                    && enabled;
        }
    }

    private static final class Fixed42SeedSnapshot implements AutoCloseable {
        final List<AccessibilityNodeInfo> ownedNodes;
        final AccessibilityNodeInfo mainContent;
        final AccessibilityNodeInfo popularRail;
        final Rect mainBounds;
        final Rect railBounds;
        final Rect bladeBounds;
        final int navigationTop;
        final Fixed42SeedPolicy.Observation observation;

        Fixed42SeedSnapshot(
                List<AccessibilityNodeInfo> ownedNodes,
                AccessibilityNodeInfo mainContent,
                AccessibilityNodeInfo popularRail,
                Rect mainBounds,
                Rect railBounds,
                Rect bladeBounds,
                int navigationTop,
                Fixed42SeedPolicy.Observation observation) {
            this.ownedNodes = ownedNodes;
            this.mainContent = mainContent;
            this.popularRail = popularRail;
            this.mainBounds = new Rect(mainBounds);
            this.railBounds = railBounds == null ? null : new Rect(railBounds);
            this.bladeBounds = bladeBounds == null ? null : new Rect(bladeBounds);
            this.navigationTop = navigationTop;
            this.observation = observation;
        }

        @Override
        public void close() {
            fixed42RecycleNodes(ownedNodes);
        }
    }

    private static final class Fixed42ReadyProof {
        final Rect bladeBounds;
        final Rect railBounds;
        final int navigationTop;

        Fixed42ReadyProof(Rect bladeBounds, Rect railBounds, int navigationTop) {
            if (bladeBounds == null || railBounds == null) {
                throw new AssertionError("Fixed42 ready proof lacked bounds");
            }
            this.bladeBounds = new Rect(bladeBounds);
            this.railBounds = new Rect(railBounds);
            this.navigationTop = navigationTop;
        }
    }

    private static final class Fixed42DialogClosurePolicy {
        static final int STALE = 0;
        static final int PRESENT = 1;
        static final int ABSENT = 2;
        static final int AMBIGUOUS = 3;
        private static final long RETRY_MS = 200L;

        interface ObservationSource {
            int observe();
        }

        interface Clock {
            long uptimeMillis();

            void sleep(long millis);
        }

        static boolean waitForGone(
                long timeoutMs, ObservationSource source, Clock clock) {
            if (timeoutMs <= 0L) return false;
            long startedAt = clock.uptimeMillis();
            long deadline = timeoutMs > Long.MAX_VALUE - startedAt
                    ? Long.MAX_VALUE
                    : startedAt + timeoutMs;
            while (clock.uptimeMillis() < deadline) {
                int observation = source.observe();
                long completedAt = clock.uptimeMillis();
                if (observation == AMBIGUOUS) {
                    throw new AssertionError("Fixed42 exact product dialog was ambiguous");
                }
                if (completedAt >= deadline) return false;
                if (observation == ABSENT) return true;
                if (observation != STALE && observation != PRESENT) {
                    throw new AssertionError("Unknown fixed42 dialog observation state");
                }
                long sleepMs = Math.min(RETRY_MS, deadline - completedAt);
                if (sleepMs <= 0L) return false;
                clock.sleep(sleepMs);
            }
            return false;
        }
    }

    private UiObject2 scrollUntilVisibleInExactDialog(
            String dialogIdentity, String text, String className, Direction direction) {
        for (int attempt = 0; attempt < 16; attempt++) {
            UiObject2 dialog = findUniqueExactProductDialog(dialogIdentity);
            assertNotNull("Exact detail dialog was unavailable while seeking " + text, dialog);
            BySelector[] selectors = productTextOrDescriptionSelectors(text, className, true);
            UiObject2 textMatch = dialog.findObject(selectors[0]);
            UiObject2 descriptionMatch = dialog.findObject(selectors[1]);
            if (textMatch != null && descriptionMatch != null) {
                assertTrue("Detail dialog exposed conflicting exact " + text + " controls",
                        sameUiIdentity(textMatch, descriptionMatch));
            }
            UiObject2 found = textMatch != null ? textMatch : descriptionMatch;
            if (found != null && dialog.getVisibleBounds().contains(found.getVisibleBounds())) {
                return found;
            }
            UiObject2 scrollable = dialog.findObject(By.scrollable(true));
            assertNotNull("No exact detail dialog scroll container while seeking " + text, scrollable);
            assertNoBindingTerms();
            scrollable.scroll(direction, 0.75f);
            device.waitForIdle(600);
        }
        fail("Could not find exact " + text + " inside the exact detail dialog");
        return null;
    }

    private UiObject2 scrollUntilVisibleProductSemanticOnAnyRoute(
            String text, String className, boolean clickable, Direction direction) {
        BySelector[] selectors = productTextOrDescriptionSelectors(text, className, clickable);
        for (int attempt = 0; attempt < 16; attempt++) {
            UiObject2 found = findAnyNow(selectors);
            if (found != null && isVisibleAboveBottomNavigation(found)) return found;
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No product scroll container while seeking " + text, scrollable);
            UiObject2 navigation = findAnyNow(productTextOrDescriptionSelectors(
                    "Primary", "android.view.View", false));
            assertNotNull("Exact bottom navigation was unavailable while seeking " + text, navigation);
            Rect scrollBounds = scrollable.getVisibleBounds();
            Rect navigationBounds = navigation.getVisibleBounds();
            assertFalse("Product scroll bounds were empty while seeking " + text, scrollBounds.isEmpty());
            assertFalse("Bottom navigation bounds were empty while seeking " + text,
                    navigationBounds.isEmpty());
            int leftMargin = 0;
            int topMargin = 0;
            int rightMargin = 0;
            int bottomMargin = Math.max(0, scrollBounds.bottom - navigationBounds.top
                    + navigationBounds.height());
            scrollable.setGestureMargins(leftMargin, topMargin, rightMargin, bottomMargin);
            assertNoBindingTerms();
            scrollable.scroll(direction, 0.75f);
            device.waitForIdle(600);
        }
        fail("Could not place exact " + text + " above bottom navigation on product route");
        return null;
    }

    private void configureSettingsScrollGesture(UiObject2 scrollable) {
        UiObject2 settingsPage = findAnyNow(productTextOrDescriptionSelectors(
                "Settings page", "android.view.View", false));
        assertNotNull("Exact Settings page was unavailable for scroll bounds", settingsPage);
        UiObject2 navigation = findAnyNow(productTextOrDescriptionSelectors(
                "Primary", "android.view.View", false));
        assertNotNull("Exact bottom navigation container was unavailable for scroll bounds", navigation);

        Rect scrollBounds = scrollable.getVisibleBounds();
        Rect settingsBounds = settingsPage.getVisibleBounds();
        Rect navigationBounds = navigation.getVisibleBounds();
        assertFalse("Scrollable Settings bounds were empty", scrollBounds.isEmpty());
        assertFalse("Exact Settings page bounds were empty", settingsBounds.isEmpty());
        assertFalse("Exact bottom navigation bounds were empty", navigationBounds.isEmpty());

        Rect gestureBounds = new Rect(scrollBounds);
        assertTrue("Scrollable container did not intersect the exact Settings page",
                gestureBounds.intersect(settingsBounds));
        int navigationClearance = navigationBounds.height();
        gestureBounds.top = gestureBounds.top + navigationClearance;
        gestureBounds.bottom = Math.min(
                gestureBounds.bottom, navigationBounds.top - navigationClearance);
        assertFalse("No Settings gesture region remained above bottom navigation",
                gestureBounds.isEmpty());

        int leftMargin = gestureBounds.left - scrollBounds.left;
        int topMargin = gestureBounds.top - scrollBounds.top;
        int rightMargin = scrollBounds.right - gestureBounds.right;
        int bottomMargin = scrollBounds.bottom - gestureBounds.bottom;
        scrollable.setGestureMargins(leftMargin, topMargin, rightMargin, bottomMargin);
    }

    private boolean isVisibleAboveBottomNavigation(UiObject2 object) {
        UiObject2 navigation = findAnyNow(productTextOrDescriptionSelectors(
                "Primary", "android.view.View", false));
        assertNotNull("Exact bottom navigation container was unavailable", navigation);
        Rect objectBounds = object.getVisibleBounds();
        Rect navigationBounds = navigation.getVisibleBounds();
        return !objectBounds.isEmpty()
                && !navigationBounds.isEmpty()
                && objectBounds.bottom <= navigationBounds.top;
    }

    private UiObject2 clickProductSemantic(String text, String className, long timeoutMs) {
        BySelector[] selectors = productTextOrDescriptionSelectors(text, className, true);
        waitForAny(timeoutMs, selectors);
        assertNoBindingTerms();
        UiObject2 object = findAnyNow(selectors);
        assertNotNull(text + " disappeared after policy guard", object);
        assertTrue(text + " was not safely visible above bottom navigation",
                isVisibleAboveBottomNavigation(object));
        object.click();
        log("Clicked exact text-or-description product control: " + text);
        device.waitForIdle(750);
        return object;
    }

    private BySelector[] productTextOrDescriptionSelectors(
            String text, String className, boolean clickable) {
        BySelector byText = By.text(text)
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz(className)
                .enabled(true);
        BySelector byDescription = By.desc(text)
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz(className)
                .enabled(true);
        if (clickable) {
            byText = byText.clickable(true);
            byDescription = byDescription.clickable(true);
        }
        return new BySelector[] {byText, byDescription};
    }

    private void enterUnknownSourcePermission() throws IOException {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            String current = device.getCurrentPackageName();
            if (OtaFlowPolicy.isSettingsPackage(current)
                    && device.hasObject(By.text("Allow from this source"))
                    && device.hasObject(By.text("YAWF Stream"))) {
                productPermissionPageObserved = true;
                break;
            }
            SystemClock.sleep(250);
        }
        assertTrue("Product did not open its scoped unknown-source Settings page", productPermissionPageObserved);
        UiObject2 toggle = findUnknownSourceSwitch();
        assertNotNull("Unknown-source switch resource was not reviewed", toggle);
        assertFalse("Fresh emulator unexpectedly already allowed YAWF installs", toggle.isChecked());
        capture("unknown-source-before");
        assertNoBindingTerms();
        toggle.click();
        waitForUnknownSourceSwitchState(true, "unknown-source switch on");
        permissionEnabledByTest = true;
        capture("unknown-source-after");
        device.pressBack();
        waitForPermissionBackReturn();
        permissionBackReturnObserved = true;
        log("Returned from the product-opened unknown-source Settings page and observed settled product state");
    }

    private void waitForPermissionBackReturn() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            String current = device.getCurrentPackageName();
            boolean settingsGone = !OtaFlowPolicy.isSettingsPackage(current);
            boolean productOrInstaller = OtaFlowPolicy.PRODUCT_PACKAGE.equals(current)
                    || OtaFlowPolicy.isInstallerPackage(current);
            if (settingsGone && productOrInstaller) return;
            SystemClock.sleep(250);
        }
        fail("Unknown-source Settings Back did not settle to product or installer");
    }

    private UiObject2 findUnknownSourceSwitch() {
        String[] resources = {"android:id/switch_widget", "com.android.settings:id/switch_widget"};
        for (String resource : resources) {
            if (!OtaFlowPolicy.isUnknownSourceSwitchResource(resource)) {
                continue;
            }
            UiObject2 object = device.findObject(By.res(resource));
            if (object != null) {
                return object;
            }
        }
        List<UiObject2> labels = device.findObjects(
                By.text(OtaFlowPolicy.UNKNOWN_SOURCE_LABEL)
                        .pkg(OtaFlowPolicy.SETTINGS_PACKAGE)
                        .clazz(OtaFlowPolicy.UNKNOWN_SOURCE_LABEL_CLASS)
                        .enabled(true));
        if (labels.size() != 1) {
            return null;
        }
        UiObject2 label = labels.get(0);
        UiObject2 toggle = label.getParent();
        if (toggle != null
                && OtaFlowPolicy.isUnknownSourceSemanticToggle(
                        toggle.getApplicationPackage(),
                        toggle.getClassName(),
                        toggle.getResourceName(),
                        toggle.isEnabled(),
                        toggle.isClickable(),
                        toggle.isCheckable(),
                        label.getApplicationPackage(),
                        label.getClassName(),
                        label.getText(),
                        label.isEnabled())) {
            return toggle;
        }
        return null;
    }

    private UiObject2 waitForUnknownSourceSwitchState(boolean expected, String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 toggle = findUnknownSourceSwitch();
            if (toggle != null && toggle.isChecked() == expected) {
                return toggle;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + label);
        return null;
    }

    private void confirmSystemInstaller() throws IOException {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        String installerPackage = null;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            String current = device.getCurrentPackageName();
            if (OtaFlowPolicy.isInstallerPackage(current)
                    && device.hasObject(By.text("Do you want to update this app?"))
                    && device.hasObject(By.text("YAWF Stream"))) {
                installerPackage = current;
                break;
            }
            SystemClock.sleep(250);
        }
        assertNotNull("Product-originated OS update installer did not appear", installerPackage);
        UiObject2 question = device.findObject(By.text("Do you want to update this app?").pkg(installerPackage));
        assertNotNull("Exact installer update question disappeared", question);
        assertTrue(
                "Installer question resource was not the update resource",
                question.getResourceName() != null
                        && question.getResourceName().endsWith(":id/install_confirm_question_update"));
        capture("installer-confirm");
        systemUpdateSelections++;
        assertEquals("System Update must be selected exactly once", 1, systemUpdateSelections);
        click(
                By.res("android", "button1").pkg(installerPackage).text(UPDATE_TEXT),
                "system Update",
                SHORT_WAIT_MS,
                true);

        UiObject2 success = waitFor(
                By.text("App installed.").pkg(installerPackage),
                UI_WAIT_MS,
                "Package Installer success");
        assertTrue(
                "Installer success resource was not exact",
                success.getResourceName() != null && success.getResourceName().endsWith(":id/install_success"));
        installerSuccessObserved = true;
        capture("installer-success");
        systemOpenSelections++;
        assertEquals("System Open must be selected exactly once", 1, systemOpenSelections);
        click(
                By.res("android", "button1").pkg(installerPackage).text(OPEN_TEXT),
                "system Open",
                SHORT_WAIT_MS,
                true);
        installerOpenObserved = true;
    }

    private void maybeLegacyManualReconsent() throws IOException {
        if (!"legacy-manual-reconsent".equals(otaMode)) {
            return;
        }
        assertTrue("Legacy reconsent requires the product permission page", productPermissionPageObserved);
        assertTrue("Legacy reconsent requires the test-enabled permission", permissionEnabledByTest);
        assertTrue("Legacy reconsent requires a settled Settings Back return", permissionBackReturnObserved);
        assertEquals(
                "Legacy manual reconsent mode is fixed to the reviewed baseline and target",
                "2.3.26",
                OtaFlowPolicy.TARGET_VERSION);
        assertEquals(
                "Legacy manual reconsent mode is fixed to the reviewed baseline",
                "2.3.25",
                OtaFlowPolicy.BASELINE_VERSION);
        if (!waitForLegacyReadyOrInstaller()
                || !OtaFlowPolicy.PRODUCT_PACKAGE.equals(device.getCurrentPackageName())
                || device.hasObject(By.pkg(OtaFlowPolicy.SETTINGS_PACKAGE))
                || device.hasObject(By.pkg("com.google.android.packageinstaller"))
                || device.hasObject(By.pkg("com.android.packageinstaller"))) {
            return;
        }
        UiObject2 title = device.findObject(
                By.text("Update ready to install").pkg(OtaFlowPolicy.PRODUCT_PACKAGE));
        UiObject2 message = device.findObject(
                By.text("YAWF Stream 2.3.26 passed all checks. Android will show the system installer.")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE));
        UiObject2 install = device.findObject(
                By.res("android", "button1")
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .text(OtaFlowPolicy.INSTALL.textPattern()));
        if (title == null || message == null || install == null || !install.isEnabled()
                || !install.isClickable()) {
            return;
        }
        assertNoBindingTerms();
        capture("legacy-manual-reconsent-ready");
        install.click();
        legacyManualReconsentUsed = true;
        log("Used exactly one legacy-manual-reconsent product Install tap after permission Back");
        device.waitForIdle(750);
    }

    private boolean waitForLegacyReadyOrInstaller() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            String current = device.getCurrentPackageName();
            if (OtaFlowPolicy.isInstallerPackage(current)) return true;
            if (OtaFlowPolicy.PRODUCT_PACKAGE.equals(current)
                    && device.hasObject(By.text("Update ready to install")
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE))
                    && device.hasObject(By.text(
                            "YAWF Stream 2.3.26 passed all checks. Android will show the system installer.")
                            .pkg(OtaFlowPolicy.PRODUCT_PACKAGE))) return true;
            SystemClock.sleep(250);
        }
        return false;
    }

    private void cleanupUnknownSourcePermissionThroughVisibleSettings() throws Exception {
        boolean coreTransactionPassed = updatedProductObserved
                && installerSuccessObserved
                && installerOpenObserved
                && systemUpdateSelections == 1
                && systemOpenSelections == 1;
        if (!AutomaticOtaDriverChecks.permissionCleanupMustRun(
                permissionEnabledByTest, coreTransactionPassed)) {
            permissionCleanupObserved = true;
            log("Unknown-source permission was never enabled by this test");
            return;
        }
        launchVisibleAppFromLauncher("Settings", OtaFlowPolicy.SETTINGS_PACKAGE,
                "visible unknown-source cleanup");
        clickSystemText("Apps", UI_WAIT_MS);
        scrollUntilVisibleSystemText("Special app access", Direction.DOWN).click();
        device.waitForIdle(750);
        scrollUntilVisibleSystemText("Install unknown apps", Direction.DOWN).click();
        device.waitForIdle(750);
        scrollUntilVisibleSystemText("YAWF Stream", Direction.DOWN).click();
        waitFor(By.text("Allow from this source"), SHORT_WAIT_MS,
                "visible cleanup unknown-source title");
        waitFor(By.text("YAWF Stream"), SHORT_WAIT_MS, "visible cleanup YAWF label");
        UiObject2 toggle = findUnknownSourceSwitch();
        assertNotNull("Visible cleanup switch was unavailable", toggle);
        assertTrue("Unknown-source permission was already off before visible cleanup", toggle.isChecked());
        assertNoBindingTerms();
        permissionCleanupToggleSelections++;
        toggle.click();
        UiObject2 revoked = waitForUnknownSourceSwitchState(
                false, "visible unknown-source switch off");
        assertTrue("Visible permission revocation was incomplete",
                AutomaticOtaDriverChecks.permissionRevocationCompleted(
                        true, permissionCleanupToggleSelections, revoked.isChecked()));
        capture("automatic-permission-cleanup-off");
        permissionCleanupObserved = true;
        log("Revoked YAWF unknown-source access through launcher-opened visible Android Settings");
    }

    private UiObject2 scrollUntilVisibleSystemText(String text, Direction direction) {
        for (int attempt = 0; attempt < 16; attempt++) {
            UiObject2 found = device.findObject(By.text(text).pkg(OtaFlowPolicy.SETTINGS_PACKAGE));
            if (found != null && found.isEnabled()) return found;
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No visible system Settings scroll container while seeking " + text, scrollable);
            assertNoBindingTerms();
            scrollable.scroll(direction, 0.75f);
            device.waitForIdle(600);
        }
        fail("Could not find exact visible system Settings text: " + text);
        return null;
    }

    private void clickSystemText(String text, long timeoutMs) {
        UiObject2 object = waitFor(
                By.text(text).pkg(OtaFlowPolicy.SETTINGS_PACKAGE).enabled(true),
                timeoutMs,
                "system Settings " + text);
        assertNoBindingTerms();
        object.click();
        log("Clicked exact visible system Settings control: " + text);
        device.waitForIdle(750);
    }

    private void cleanupUnknownSourcePermission() throws Exception {
        if (!permissionEnabledByTest) {
            permissionCleanupObserved = true;
            log("Unknown-source permission was never enabled by this test");
            return;
        }
        assertTrue("Cleanup refused because the product permission page was not observed", productPermissionPageObserved);
        if (updatedProductObserved) {
            assertTrue(
                    "Successful-flow cleanup ordering is incomplete",
                    OtaFlowPolicy.cleanupMayOpenSettings(
                            installerSuccessObserved, installerOpenObserved, updatedProductObserved));
        }
        assertNoBindingTerms();
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + OtaFlowPolicy.PRODUCT_PACKAGE))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        waitFor(By.pkg("com.android.settings"), UI_WAIT_MS, "cleanup Settings package");
        waitFor(By.text("Allow from this source"), SHORT_WAIT_MS, "cleanup unknown-source title");
        waitFor(By.text("YAWF Stream"), SHORT_WAIT_MS, "cleanup YAWF label");
        UiObject2 toggle = findUnknownSourceSwitch();
        assertNotNull("Cleanup switch was unavailable", toggle);
        if (toggle.isChecked()) {
            assertNoBindingTerms();
            toggle.click();
            waitForUnknownSourceSwitchState(false, "unknown-source switch off");
        }
        capture("permission-cleanup-off");
        permissionCleanupObserved = true;
        log("Revoked YAWF unknown-source access through visible Android Settings UI");
    }

    private void launchProduct() {
        assertNoBindingTerms();
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(OtaFlowPolicy.PRODUCT_PACKAGE, OtaFlowPolicy.PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        assertTrue(
                "Product package did not become visible",
                device.wait(Until.hasObject(By.pkg(OtaFlowPolicy.PRODUCT_PACKAGE)), UI_WAIT_MS));
        device.waitForIdle(2_000);
        log("Started the official public baseline product");
    }

    private static long parseLongArgument(Bundle arguments, String name) {
        String value = arguments.getString(name, "");
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ignored) {
            return -1L;
        }
    }

    private static long versionCodeFor(String version) {
        String[] parts = version.split("\\.", -1);
        if (parts.length != 3) return -1L;
        try {
            long major = Long.parseLong(parts[0]);
            long minor = Long.parseLong(parts[1]);
            long patch = Long.parseLong(parts[2]);
            if (major < 0L || major > 999L
                    || minor < 0L || minor > 999L
                    || patch < 0L || patch > 999L) return -1L;
            return major * 1_000_000L + minor * 1_000L + patch;
        } catch (NumberFormatException ignored) {
            return -1L;
        }
    }

    private UiObject2 click(BySelector selector, String label, long timeoutMs, boolean requireEnabled) {
        waitFor(selector, timeoutMs, label);
        assertNoBindingTerms();
        UiObject2 object = device.findObject(selector);
        assertNotNull(label + " disappeared after policy guard", object);
        if (requireEnabled) {
            assertTrue(label + " was disabled", object.isEnabled());
        }
        object.click();
        log("Clicked semantic control: " + label);
        device.waitForIdle(750);
        return object;
    }

    private UiObject2 clickWebButton(OtaFlowPolicy.WebButtonSpec button, String label, long timeoutMs) {
        BySelector[] selectors = webButtonSelectors(button);
        waitForAny(timeoutMs, selectors);
        assertNoBindingTerms();
        UiObject2 object = findAnyNow(selectors);
        assertNotNull(label + " disappeared after policy guard", object);
        assertTrue(label + " was disabled", object.isEnabled());
        object.click();
        log("Clicked exact text-or-description WebView button: " + label);
        device.waitForIdle(750);
        return object;
    }

    private BySelector[] webButtonSelectors(OtaFlowPolicy.WebButtonSpec button) {
        return new BySelector[] {
                By.text(button.label())
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz(OtaFlowPolicy.WEB_BUTTON_CLASS)
                        .clickable(true)
                        .enabled(true),
                By.desc(button.label())
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz(OtaFlowPolicy.WEB_BUTTON_CLASS)
                        .clickable(true)
                        .enabled(true)
        };
    }

    private BySelector nativeProductButton(OtaFlowPolicy.NativeButtonSpec button) {
        return By.res("android", button.resourceName())
                .pkg(button.packageName())
                .text(button.textPattern());
    }

    private BySelector nativeDialogText(String text) {
        return By.text(text)
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.TextView");
    }

    private BySelector nativeDialogTextGroup(String... exactTexts) {
        return By.text(Fixed42CriticalQueryGroupPolicy.exactTextPattern(exactTexts))
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz(Fixed42CriticalQueryGroupPolicy.TEXT_VIEW_CLASS);
    }

    private Fixed42CriticalQueryGroupPolicy.Counts queryFixed42CriticalTextGroup(
            BySelector selector, String[] exactTexts, String phase) {
        long startedAt = SystemClock.uptimeMillis();
        Fixed42CriticalQueryGroupPolicy.Counts counts;
        try {
            List<UiObject2> matches = device.findObjects(selector);
            if (matches.size() > exactTexts.length) {
                throw new AssertionError("Fixed42 query group exceeded its exact-name bound");
            }
            Fixed42CriticalQueryGroupPolicy.Candidate[] candidates =
                    new Fixed42CriticalQueryGroupPolicy.Candidate[matches.size()];
            for (int index = 0; index < matches.size(); index++) {
                UiObject2 match = matches.get(index);
                CharSequence text = match.getText();
                candidates[index] = new Fixed42CriticalQueryGroupPolicy.Candidate(
                        match.getApplicationPackage(),
                        match.getClassName(),
                        text == null ? null : text.toString());
            }
            counts = Fixed42CriticalQueryGroupPolicy.classify(
                    OtaFlowPolicy.PRODUCT_PACKAGE,
                    Fixed42CriticalQueryGroupPolicy.TEXT_VIEW_CLASS,
                    exactTexts,
                    candidates);
        } catch (RuntimeException | AssertionError failure) {
            recordInitialEnableQueryGroupTiming(
                    phase, startedAt, SystemClock.uptimeMillis(), new int[] {-1});
            throw failure;
        }
        recordInitialEnableQueryGroupTiming(
                phase, startedAt, SystemClock.uptimeMillis(), counts.values());
        return counts;
    }

    private List<UiObject2> queryFixed42CriticalCancelGroup(
            BySelector selector, String phase) {
        long startedAt = SystemClock.uptimeMillis();
        List<UiObject2> matches;
        try {
            matches = device.findObjects(selector);
        } catch (RuntimeException | AssertionError failure) {
            recordInitialEnableQueryGroupTiming(
                    phase, startedAt, SystemClock.uptimeMillis(), new int[] {-1});
            throw failure;
        }
        recordInitialEnableQueryGroupTiming(
                phase, startedAt, SystemClock.uptimeMillis(),
                new int[] {matches.size()});
        return matches;
    }

    private void recordInitialEnableQueryGroupTiming(
            String phase, long startedAt, long finishedAt, int[] counts) {
        if (startedAt < 0L
                || finishedAt < startedAt
                || (initialEnableLastQueryTimingUptimeMs >= 0L
                        && startedAt < initialEnableLastQueryTimingUptimeMs)) {
            throw new AssertionError("Initial Enable query timing was not monotonic");
        }
        initialEnableLastQueryTimingUptimeMs = finishedAt;
        initialEnableQueryTimingSequence++;
        StringBuilder entry = new StringBuilder()
                .append("sequence=").append(initialEnableQueryTimingSequence)
                .append(" phase=").append(phase)
                .append(" startUptimeMs=").append(startedAt)
                .append(" finishUptimeMs=").append(finishedAt)
                .append(" counts=");
        for (int index = 0; index < counts.length; index++) {
            if (index > 0) entry.append(',');
            entry.append(counts[index]);
        }
        if (initialEnableQueryGroupTimings.size() >= MAX_INITIAL_ENABLE_QUERY_TIMINGS) {
            initialEnableQueryGroupTimings.remove(0);
            initialEnableQueryGroupTimingDrops++;
        }
        initialEnableQueryGroupTimings.add(entry.toString());
    }

    private UiObject2 waitFor(BySelector selector, long timeoutMs, String label) {
        UiObject2 object = device.wait(Until.findObject(selector), timeoutMs);
        assertNotNull("Timed out waiting for " + label, object);
        return object;
    }

    private void waitForCheckedState(BySelector selector, boolean checked, String label) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 object = device.findObject(selector);
            if (object != null && object.isChecked() == checked) {
                return;
            }
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for " + label + " checked=" + checked);
    }

    private UiObject2 waitForAny(long timeoutMs, BySelector... selectors) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            UiObject2 object = findAnyNow(selectors);
            if (object != null) {
                return object;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for one of the exact semantic controls");
        return null;
    }

    private UiObject2 findAnyNow(BySelector... selectors) {
        for (BySelector selector : selectors) {
            UiObject2 object = device.findObject(selector);
            if (object != null) {
                return object;
            }
        }
        return null;
    }

    private void assertNoBindingTerms() {
        if (hasAnyWithoutIdleDelay(
                By.text(OtaFlowPolicy.BINDING_TERMS_PATTERN),
                By.desc(OtaFlowPolicy.BINDING_TERMS_PATTERN))) {
            fail("Refusing to act while a binding-terms phrase is visible");
        }
    }

    private void assertNoBindingTermsAtCurrentIdlePolicy() {
        if (device.hasObject(By.text(OtaFlowPolicy.BINDING_TERMS_PATTERN))
                || device.hasObject(By.desc(OtaFlowPolicy.BINDING_TERMS_PATTERN))) {
            fail("Refusing to act while a binding-terms phrase is visible");
        }
    }

    private boolean hasAnyWithoutIdleDelay(BySelector... selectors) {
        Configurator configurator = Configurator.getInstance();
        long previous = configurator.getWaitForIdleTimeout();
        configurator.setWaitForIdleTimeout(NEGATIVE_IDLE_TIMEOUT_MS);
        try {
            for (BySelector selector : selectors) {
                if (device.hasObject(selector)) {
                    return true;
                }
            }
            return false;
        } finally {
            configurator.setWaitForIdleTimeout(previous);
        }
    }

    private void captureFixed42Appearance(String label) throws IOException {
        assertTrue("Appearance observation is restricted to the fixed42 profile",
                isFixed42AutomaticMode());
        assertTrue("Fixed42 Appearance cache refresh requires API 34 or newer",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        assertTrue("Fixed42 Appearance accessibility cache refresh failed",
                instrumentation.getUiAutomation().clearCache());
        capture(label);
    }

    private void capture(String label) throws IOException {
        assertNoBindingTerms();
        assertTrue("Capture count exceeded", captureIndex < MAX_CAPTURES);
        captureIndex++;
        String prefix = String.format(Locale.ROOT, "%02d-%s", captureIndex, label);
        File screenshot = new File(evidenceDir, prefix + ".png");
        assertTrue("Screenshot failed for " + label, device.takeScreenshot(screenshot));
        assertTrue("Screenshot exceeded bound", screenshot.length() <= MAX_SCREENSHOT_BYTES);
        File hierarchy = new File(evidenceDir, prefix + ".xml");
        device.dumpWindowHierarchy(hierarchy);
        assertTrue("Hierarchy was empty", hierarchy.length() > 0);
        assertTrue("Hierarchy exceeded bound", hierarchy.length() <= MAX_HIERARCHY_BYTES);
        log("Captured " + label);
    }

    private void log(String value) {
        if (actions.size() >= MAX_ACTION_LINES) {
            fail("Action log exceeded bound");
        }
        actions.add(safe(value));
    }

    private static String safe(String value) {
        if (value == null) {
            return "";
        }
        String redacted = URL.matcher(value).replaceAll("<redacted-url>");
        redacted = redacted.replace('\n', ' ').replace('\r', ' ');
        return redacted.length() <= 500 ? redacted : redacted.substring(0, 500);
    }

    private void writeActionLog() throws IOException {
        StringBuilder output = new StringBuilder();
        for (int index = 0; index < actions.size(); index++) {
            output.append(index + 1).append(' ').append(actions.get(index)).append('\n');
        }
        writeBounded(new File(evidenceDir, "actions.txt"), output.toString(), 64 * 1024);
    }

    private void writeReceipt(String outcome, Throwable failure) throws Exception {
        JSONObject receipt = new JSONObject();
        receipt.put("outcome", outcome);
        receipt.put("persistentUiAutomationSession", true);
        receipt.put("productPackage", OtaFlowPolicy.PRODUCT_PACKAGE);
        receipt.put("baselineVersion", admittedBaselineVersion);
        receipt.put("targetVersion", admittedTargetVersion);
        receipt.put("targetVersionCode", admittedTargetVersionCode);
        receipt.put("targetSha256", admittedTargetSha256);
        receipt.put("targetSize", admittedTargetSize);
        receipt.put("targetIdentityAdmitted", targetIdentityAdmitted);
        receipt.put("productPermissionPageObserved", productPermissionPageObserved);
        receipt.put("permissionEnabledByTest", permissionEnabledByTest);
        receipt.put("installerSuccessObserved", installerSuccessObserved);
        receipt.put("installerOpenObserved", installerOpenObserved);
        receipt.put("updatedProductObserved", updatedProductObserved);
        receipt.put("permissionCleanupObserved", permissionCleanupObserved);
        receipt.put("permissionBackReturnObserved", permissionBackReturnObserved);
        receipt.put("otaMode", otaMode == null ? "strict" : otaMode);
        receipt.put("legacyManualReconsentUsed", legacyManualReconsentUsed);
        receipt.put("productUpdateSelections", productUpdateSelections);
        receipt.put("productInstallSelections", productInstallSelections);
        receipt.put("systemUpdateSelections", systemUpdateSelections);
        receipt.put("systemOpenSelections", systemOpenSelections);
        if (isAutomaticMode()) {
            receipt.put("targetSourceRevision", admittedTargetSourceRevision);
            receipt.put("targetManifestSha256", admittedTargetManifestSha256);
            receipt.put("targetVerificationSha256", admittedTargetVerificationSha256);
            receipt.put("targetBuildRun", admittedTargetBuildRun);
            receipt.put("initialManualProgressObserved", initialManualProgressObserved);
            receipt.put("initialManualCancelWon", initialManualCancelWon);
            receipt.put("automaticOfferAbsentSameForeground", automaticOfferAbsentSameForeground);
            receipt.put("deferredAutomaticOfferObserved", deferredAutomaticOfferObserved);
            receipt.put("automaticDiscoveryObserved", automaticDiscoveryObserved);
            receipt.put("weeklyElapsedSchedulingProven", false);
            receipt.put("sampleCatalogFixtureUsed", sampleCatalogFixtureUsed);
            receipt.put("liveCatalogProviderProof", false);
            receipt.put("profilePersistedWarm", profilePersistedWarm);
            receipt.put("appearancePersistedWarm", appearancePersistedWarm);
            receipt.put("watchlistPersistedWarm", watchlistPersistedWarm);
            receipt.put("folderPersistedWarm", folderPersistedWarm);
            receipt.put("visibleTaskDismissalObserved", visibleTaskDismissalObserved);
            receipt.put("visibleTaskDismissalSwipes", visibleTaskDismissalSwipes);
            receipt.put("independentColdProcessProof", false);
            receipt.put("profilePersistedAfterTaskRelaunch", profilePersistedAfterTaskRelaunch);
            receipt.put("appearancePersistedAfterTaskRelaunch", appearancePersistedAfterTaskRelaunch);
            receipt.put("watchlistPersistedAfterTaskRelaunch", watchlistPersistedAfterTaskRelaunch);
            receipt.put("folderPersistedAfterTaskRelaunch", folderPersistedAfterTaskRelaunch);
            receipt.put("permissionCleanupToggleSelections", permissionCleanupToggleSelections);
            if (isFixed42AutomaticMode()) {
                receipt.put("runtimeProfile", FIXED42_AUTOMATIC_OTA_PROFILE);
                receipt.put("baselineSourceRevision", admittedBaselineSourceRevision);
                receipt.put("baselineManifestSha256", admittedBaselineManifestSha256);
                receipt.put("baselineVerificationSha256", admittedBaselineVerificationSha256);
                receipt.put("baselineBuildRun", admittedBaselineBuildRun);
                receipt.put("updaterSourceSha256", admittedUpdaterSourceSha256);
                receipt.put("initialEnableCheckingTitleObserved",
                        initialEnableCheckingTitleObserved);
                receipt.put("initialEnableCheckingMessageObserved",
                        initialEnableCheckingMessageObserved);
                receipt.put("initialEnableCancelObserved", initialEnableCancelObserved);
                receipt.put("initialEnableTerminalResultExcludedBeforeCancel",
                        initialEnableTerminalResultExcludedBeforeCancel);
                receipt.put("initialEnableCancelSelections", initialEnableCancelSelections);
                receipt.put("initialEnableCancelWon", initialEnableCancelWon);
                receipt.put("initialEnableSettledResultExclusionSamples",
                        initialEnableSettledResultExclusionSamples);
                JSONArray initialEnableTimingJson = new JSONArray();
                for (String timing : initialEnableQueryGroupTimings) {
                    initialEnableTimingJson.put(timing);
                }
                receipt.put("initialEnableQueryGroupTimings", initialEnableTimingJson);
                receipt.put("initialEnableQueryGroupTimingDrops",
                        initialEnableQueryGroupTimingDrops);
                receipt.put("initialEnableQueryGroupTimingLimit",
                        MAX_INITIAL_ENABLE_QUERY_TIMINGS);
                receipt.put("preOfferManualDiscoveries", preOfferManualDiscoveries);
                receipt.put("weeklyOnAtDeferredOffer", weeklyOnAtDeferredOffer);
                receipt.put("automaticTriggerReturnOrdinal", automaticTriggerReturnOrdinal);
                receipt.put("deferredOfferReturnOrdinal", deferredOfferReturnOrdinal);
                receipt.put("automaticOfferOrdinal", automaticOfferOrdinal);
                receipt.put("postInstallInspectionOrdinal", postInstallInspectionOrdinal);
                receipt.put("postInstallManualInspectionChecks",
                        postInstallManualInspectionChecks);
                receipt.put("postInstallExactUpToDate59Observed",
                        postInstallExactUpToDate59Observed);
                receipt.put("weeklyOnAfterUpdate", weeklyOnAfterUpdate);
                receipt.put("postInstallNativeOkClosures", postInstallNativeOkClosures);
                receipt.put("postInstallNativeCancelClosures",
                        postInstallNativeCancelClosures);
                receipt.put("automaticDiscoveryProofIncludesPostInstallInspection", false);
                receipt.put("profileNameMarker", FIXED42_PROFILE_NAME);
                receipt.put("profileNameInitialDistinct", profileNameInitialDistinct);
                receipt.put("profileNameSetTextActions", profileNameSetTextActions);
                receipt.put("profileNameImmediateExact", profileNameImmediateExact);
                receipt.put("profileNameCloseReopenExact", profileNameCloseReopenExact);
                receipt.put("profileNamePostInstallSetTextActions",
                        profileNamePostInstallSetTextActions);
            }
        }
        receipt.put("captures", captureIndex);
        receipt.put(
                "failure",
                failure == null
                        ? JSONObject.NULL
                        : failure.getClass().getSimpleName() + ": " + safe(failure.getMessage()));
        writeBounded(
                new File(evidenceDir, "instrumentation-receipt.json"),
                receipt.toString(2) + "\n",
                16 * 1024);
    }

    private static void writeBounded(File file, String value, int maxBytes) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) {
            throw new IOException("Evidence exceeded bound for " + file.getName());
        }
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
        }
    }
}
