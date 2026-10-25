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

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

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
        BySelector enableSelector = By.res("android", "button1")
                .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                .clazz("android.widget.Button")
                .text(Pattern.compile("\\AEnable\\z", Pattern.CASE_INSENSITIVE))
                .clickable(true)
                .enabled(true);
        BySelector titleSelector = nativeDialogText(progressTitle);
        BySelector messageSelector = nativeDialogText(progressMessage);
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
                assertNoInitialEnableResultVisibleAtCurrentIdlePolicy();
                List<UiObject2> titles = cacheCleared
                        ? device.findObjects(titleSelector) : new ArrayList<>();
                List<UiObject2> messages = cacheCleared
                        ? device.findObjects(messageSelector) : new ArrayList<>();
                List<UiObject2> cancels = cacheCleared
                        ? device.findObjects(cancelSelector) : new ArrayList<>();
                assertTrue("Initial Enable CHECKING title was ambiguous", titles.size() <= 1);
                assertTrue("Initial Enable CHECKING message was ambiguous", messages.size() <= 1);
                assertTrue("Initial Enable Cancel was ambiguous", cancels.size() <= 1);
                if (titles.size() == 1 && messages.size() == 1 && cancels.size() == 1) {
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
            assertNoInitialEnableResultVisibleAtCurrentIdlePolicy();
            List<UiObject2> freshCancels = device.findObjects(cancelSelector);
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
                assertNoInitialEnableResultVisibleAtCurrentIdlePolicy();
                boolean progressGone = cacheCleared
                        && device.findObjects(titleSelector).isEmpty()
                        && device.findObjects(messageSelector).isEmpty()
                        && device.findObjects(cancelSelector).isEmpty();
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

    private void assertNoInitialEnableResultVisibleAtCurrentIdlePolicy() {
        assertFalse("Initial Enable check returned up-to-date before Cancel",
                device.hasObject(nativeDialogText("YAWF Stream is up to date")));
        assertFalse("Initial Enable check returned failure before Cancel",
                device.hasObject(nativeDialogText("Update check unavailable")));
        assertFalse("Initial Enable check returned target offer before Cancel",
                device.hasObject(nativeDialogText(
                        "YAWF Stream " + admittedTargetVersion + " is available")));
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
        waitForFixed42AppearanceSummary("Midnight Studio");
        UiObject2 quiet = scrollUntilVisibleExactProduct(
                By.desc(AUTOMATIC_APPEARANCE)
                        .pkg(OtaFlowPolicy.PRODUCT_PACKAGE)
                        .clazz("android.widget.ToggleButton")
                        .clickable(true)
                        .enabled(true),
                "exact Quiet focus ToggleButton",
                Direction.DOWN);
        assertNoBindingTerms();
        quiet.click();
        waitForFixed42AppearanceSummary(FIXED42_APPEARANCE_SUMMARY);
        navigateProductRoute("Discover");

        waitFor(By.text("Sample catalog"), UI_WAIT_MS, "Sample catalog classification");
        UiObject2 title = scrollUntilVisibleProductSemanticOnAnyRoute(
                AUTOMATIC_SAMPLE_TITLE, "android.widget.Button", true, Direction.DOWN);
        title.click();
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
                waitForUniqueExactProductDialogGone("Profile", SHORT_WAIT_MS));
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

    private UiObject2 waitForFixed42AppearanceSummary(String exactStyle) {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
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
                if (!clickableAncestor && !match.getVisibleBounds().isEmpty()) summaries.add(match);
            }
            assertTrue("Fixed42 selected appearance summary was ambiguous", summaries.size() <= 1);
            if (summaries.size() == 1) return summaries.get(0);
            SystemClock.sleep(150);
        }
        fail("Timed out waiting for exact selected appearance summary " + exactStyle);
        return null;
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
        launchVisibleAppFromLauncher("YAWF Stream", OtaFlowPolicy.PRODUCT_PACKAGE, phase);
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
            BySelector selector, String label, Direction direction) {
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
