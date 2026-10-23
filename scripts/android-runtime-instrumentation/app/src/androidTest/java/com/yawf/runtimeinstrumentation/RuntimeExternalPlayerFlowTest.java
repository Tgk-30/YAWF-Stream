package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.Direction;
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
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Black-box UiAutomation flow for the unchanged production Android phone APK. */
@RunWith(AndroidJUnit4.class)
public final class RuntimeExternalPlayerFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    private static final String EVIDENCE_SUBDIR = "persistent-external-player-flow";
    private static final String FIXTURE_URL = "http://127.0.0.1:43120";
    private static final String FIXTURE_ORIGIN_MESSAGE =
            "Allow http://127.0.0.1:43120 to open this stream in an external video player?";
    private static final String MOVIE_TITLE = "Synthetic Fixture Movie";
    private static final String PLAYER_DIALOG_LABEL =
            "Playing Synthetic Fixture Movie (2026)";
    private static final String PLAYBACK_SETTINGS_LABEL = "Playback settings";
    private static final String EXTERNAL_PLAYER_LABEL =
            "Open in external player Choose VLC or another installed video app";
    private static final String SYSTEM_UI_PACKAGE = "com.android.systemui";
    private static final String FULLSCREEN_TIP_TITLE = "Viewing full screen";
    private static final String FULLSCREEN_TIP_DESCRIPTION =
            "To exit, swipe down from the top of your screen";
    private static final String FULLSCREEN_TIP_BUTTON = "Got it";
    private static final String VLC_PACKAGE = "org.videolan.vlc";
    private static final String VLC_INTENT_ACTIVITY = "org.videolan.vlc.StartActivity";
    private static final String VLC_PLAYBACK_ACTIVITY =
            "org.videolan.vlc.gui.video.VideoPlayerActivity";
    private static final String VLC_WELCOME_TITLE = "Welcome to VLC!";
    private static final String VLC_START = "Start VLC";
    private static final String VLC_PERMISSION_TITLE = "Permission";
    private static final String VLC_NO_FILE_ACCESS = "No file access";
    private static final String VLC_THEME_TITLE = "Make yourself at home";
    private static final String VLC_NOTIFICATION_TITLE = "Notification permission";
    private static final String VLC_ALL_SET_TITLE = "VLC is all set!";
    private static final String CONNECT_SERVER_LABEL =
            "Connect to a server Already have a server or an invite link? Paste the address and sign in.";
    private static final String SOURCE_CONTROL_LABEL =
            "1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown";
    private static final String USERNAME = "fixture-owner";
    private static final String PASSWORD = "fixture-owner-password";
    private static final String WEB_BUTTON_CLASS = "android.widget.Button";
    private static final long SHORT_WAIT_MS = 15_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final long MEDIA_WAIT_MS = 60_000;
    private static final int MAX_CAPTURES = 30;
    private static final int MAX_ACTION_LINES = 220;
    private static final int MAX_PHASES = 48;
    private static final int MAX_SETTINGS_TRANSACTION_TIMING_EVENTS = 64;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern SAFE_PACKAGE = Pattern.compile(
            "[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*){1,20}");
    private static final Pattern SAFE_LABEL = Pattern.compile("[\\p{L}\\p{N} ._+&()'/-]{1,80}");
    private static final Pattern BINDING_TERMS = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private static final Pattern URL = Pattern.compile("(?i)https?://[^\\s\\\"'<>]+");
    private static final Pattern CAPABILITY = Pattern.compile(
            "(?i)/api/external-stream/[^\\s\\\"'<>]+");
    private static final Pattern SENSITIVE = Pattern.compile(
            "(?i)(authorization|cookie|ds_session|ds_csrf|bearer)[^\\s\\\"'<>]*");

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private final List<String> phases = new ArrayList<>();
    private final List<String> settingsTransactionTimings = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private int captureIndex;
    private int openPlayerClicks;
    private int settingsTransactionTimingEventsOmitted;
    private long settingsClickDispatchedAtMs = -1L;
    private long settingsClickFinishedAtMs = -1L;
    private long settingsClickIdleBeforeMs = -1L;
    private long settingsClickIdleAfterMs = -1L;
    private boolean settingsClickReturned;
    private long startedAtMs;
    private String phase = "not-started";
    private String handlerLabel = "";
    private String handlerPackage = "";
    private String handlerActivity = "";
    private String handlerPlaybackActivity = "";
    private int handlerActivityCount;
    private boolean realAndroidChooserObserved;
    private boolean soleHandlerDirectLaunchObserved;

    @Test
    public void productionApkCompletesServerModeExternalPlayerFlow() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        startedAtMs = SystemClock.uptimeMillis();
        Bundle arguments = InstrumentationRegistry.getArguments();
        String evidenceSubdir = arguments.getString("evidenceSubdir", EVIDENCE_SUBDIR);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(evidenceSubdir).matches());
        assertEquals("Unexpected evidence subdirectory", EVIDENCE_SUBDIR, evidenceSubdir);

        handlerLabel = arguments.getString("externalHandlerLabel", "").trim();
        handlerPackage = arguments.getString("externalHandlerPackage", "").trim();
        handlerActivity = arguments.getString("externalHandlerActivity", "").trim();
        handlerPlaybackActivity = arguments.getString("externalHandlerPlaybackActivity", "").trim();
        String handlerActivityCountValue =
                arguments.getString("externalHandlerActivityCount", "").trim();
        assertTrue("Handler label and package must be supplied together",
                handlerLabel.isEmpty() == handlerPackage.isEmpty());
        assertTrue("All external handler metadata fields must be supplied together",
                hasCompleteHandlerMetadata(
                        handlerLabel,
                        handlerPackage,
                        handlerActivity,
                        handlerPlaybackActivity,
                        handlerActivityCountValue));
        if (!handlerLabel.isEmpty()) {
            assertTrue("Unsafe external handler label", SAFE_LABEL.matcher(handlerLabel).matches());
            assertTrue("Unsafe external handler package", SAFE_PACKAGE.matcher(handlerPackage).matches());
            assertTrue("Unsafe external handler activity", SAFE_PACKAGE.matcher(handlerActivity).matches());
            assertTrue("Unsafe external playback activity", SAFE_PACKAGE.matcher(handlerPlaybackActivity).matches());
            assertTrue("Unsafe external handler activity count",
                    handlerActivityCountValue.matches("[1-9][0-9]?") && handlerActivityCountValue.length() <= 2);
            handlerActivityCount = Integer.parseInt(handlerActivityCountValue);
        }

        Context targetContext = instrumentation.getTargetContext();
        evidenceDir = new File(targetContext.getFilesDir(), evidenceSubdir);
        assertTrue("Could not create evidence directory",
                evidenceDir.mkdirs() || evidenceDir.isDirectory());
        checks.put("originalProductionApkDrivenExternally", true);
        checks.put("webViewInjectionUsed", false);
        checks.put("privatePreferencesUsed", false);
        checks.put("permissionGrantUsed", false);
        checks.put("decodedPlaybackClaimed", false);
        checks.put("manualDecodedPlaybackReviewRequired", true);
        checks.put("realAndroidChooserObserved", false);
        checks.put("soleHandlerDirectLaunchObserved", false);
        checks.put("nonbindingFullscreenTipDismissed", false);
        checks.put("vlcOnboardingObserved", false);
        checks.put("vlcStorageAccessDenied", false);
        checks.put("vlcOptionalPermissionDenied", false);

        String outcome = "failed";
        String failure = null;
        try {
            runFlow();
            outcome = "passed";
        } catch (Throwable caught) {
            failure = caught.getClass().getSimpleName() + ": " + safe(caught.getMessage());
            try {
                capture("failure");
            } catch (Throwable ignored) {
                log("Failure capture unavailable: " + ignored.getClass().getSimpleName());
            }
            throw caught;
        } finally {
            checks.put("openPlayerClicks", openPlayerClicks);
            checks.put("decodedPlaybackClaimed", false);
            writeActions();
            writeReceipt(outcome, failure);
        }
    }

    private void runFlow() throws Exception {
        transition("launching-product");
        device.wakeUp();
        launchProduct();
        reachFirstRun();
        capture("first-run");

        clickLabeled(CONNECT_SERVER_LABEL, "combined Connect to a server card", UI_WAIT_MS);
        waitFor(By.text("Server address"), UI_WAIT_MS, "Server address label");
        UiObject2 address = singleEditableField("server address", 1, 0);
        address.setText(FIXTURE_URL);
        dismissObservedIme();
        clickLabeled("Open server", "Open server", SHORT_WAIT_MS);
        transition("server-login-visible");
        waitFor(By.text("Sign in"), UI_WAIT_MS, "synthetic server sign-in");
        capture("server-sign-in");

        List<UiObject2> loginFields = waitForEditableFields(3, UI_WAIT_MS, "server sign-in fields");
        loginFields.get(0).setText(USERNAME);
        loginFields.get(1).setText(PASSWORD);
        log("Entered documented synthetic username and password without logging their values");
        dismissObservedIme();
        clickLabeled("Sign in", "Sign in", SHORT_WAIT_MS);

        transition("signed-in");
        waitForTextOrDescription("Watchlist", UI_WAIT_MS, "Watchlist navigation");
        dismissOrdinaryTourIfPresent();
        capture("signed-in");
        clickLabeled("Watchlist", "Watchlist navigation", UI_WAIT_MS);
        transition("watchlist-visible");
        waitFor(By.text("Watchlist"), UI_WAIT_MS, "Watchlist heading");
        UiObject2 movie = waitForLabeledClickable(MOVIE_TITLE, UI_WAIT_MS, "synthetic movie card");
        guardedClick(movie, "synthetic movie card");

        transition("movie-detail-visible");
        waitFor(By.text(MOVIE_TITLE), UI_WAIT_MS, "synthetic movie detail");
        UiObject2 source = scrollUntilLabeledClickable(SOURCE_CONTROL_LABEL, "synthetic source");
        capture("source-visible");
        guardedClick(source, "synthetic source");

        transition("production-player-visible");
        capture("production-player");
        openPlaybackSettingsTransaction();
        waitForUniquePlaybackSettingsDialog();
        capture("playback-settings-panel");
        UiObject2 external = scrollPlaybackSettingsUntilLabeledClickable(
                EXTERNAL_PLAYER_LABEL, EXTERNAL_PLAYER_LABEL);
        capture("external-control-visible");
        guardedClick(external, EXTERNAL_PLAYER_LABEL);

        transition("origin-confirmation-visible");
        waitFor(By.text("Open external player?"), SHORT_WAIT_MS, "native external-player title");
        waitFor(By.text(FIXTURE_ORIGIN_MESSAGE), SHORT_WAIT_MS, "origin-named confirmation message");
        checks.put("originNamedNativeConfirmationObserved", true);
        capture("origin-confirmation");
        assertEquals("Open player must not have been clicked before confirmation", 0, openPlayerClicks);
        UiObject2 openPlayer = waitFor(
                By.res("android", "button1")
                        .pkg(PRODUCT_PACKAGE)
                        .text(exactCaseInsensitiveLabel("Open player"))
                        .clickable(true)
                        .enabled(true),
                SHORT_WAIT_MS,
                "one native Open player button");
        assertNoOutOfScopeApproval();
        openPlayer.click();
        openPlayerClicks++;
        log("Clicked the one origin-scoped native Open player confirmation");
        assertEquals("Native Open player was clicked more than once", 1, openPlayerClicks);

        transition("external-destination-resolving");
        resolveExternalDestination();
        assertTrue(
                "The admitted VLC path requires the real Android chooser and forbids a direct-launch receipt",
                realAndroidChooserObserved && !soleHandlerDirectLaunchObserved);

        transition("vlc-first-run-settling");
        settleVlcFirstRunAndReachPlayer();

        transition("handler-visible");
        waitForForegroundPackage(handlerPackage, MEDIA_WAIT_MS);
        assertNoOutOfScopeApproval();
        checks.put("expectedHandlerForegroundObserved", true);
        capture("handler-playback-t1");
        SystemClock.sleep(4_000);
        assertNoOutOfScopeApproval();
        capture("handler-playback-t2");
        checks.put("manualMovingElapsedTimeCapturePair", true);

        device.click(device.getDisplayWidth() / 2, device.getDisplayHeight() / 2);
        log("Tapped the visible handler surface once to reveal native playback controls");
        UiObject2 seek = device.wait(
                Until.findObject(By.clazz("android.widget.SeekBar").pkg(handlerPackage)),
                SHORT_WAIT_MS);
        assertNotNull("The admitted handler exposed no semantic SeekBar; no seek pass is claimed", seek);
        Rect bounds = seek.getVisibleBounds();
        assertTrue("Handler SeekBar bounds were too small for a bounded gesture", bounds.width() >= 100);
        device.swipe(
                bounds.left + bounds.width() / 4,
                bounds.centerY(),
                bounds.left + (bounds.width() * 3) / 4,
                bounds.centerY(),
                20);
        log("Performed one bounded forward gesture on the admitted handler's semantic SeekBar");
        checks.put("semanticSeekGesturePerformed", true);
        SystemClock.sleep(2_000);
        capture("handler-after-seek");

        transition("returning-to-product");
        device.pressBack();
        waitForForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS);
        checks.put("singleBackReturnedToProduct", true);
        capture("returned-to-product");
        transition("complete-manual-review-required");
        log("Flow complete. Decode remains unclaimed pending manual elapsed-time screenshots and live 200/206 receipt review");
    }

    private void resolveExternalDestination() throws Exception {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();

            UiObject2 chooser = findTextOrDescription("Open external player");
            if (chooser != null) {
                if (!realAndroidChooserObserved) {
                    realAndroidChooserObserved = true;
                    checks.put("realAndroidChooserObserved", true);
                    capture("chooser");
                }
                requireHandlerAdmission();
            }
            UiObject2 handler = chooser == null ? null : findLabeledClickable(handlerLabel);
            String action = chooseExternalDestinationAction(
                    chooser != null,
                    handler != null);

            if ("select-chooser-handler".equals(action)) {
                capture("chooser-handler-observed");
                guardedClick(handler, "admitted external handler");

                long remaining = deadline - SystemClock.uptimeMillis();
                if (remaining > 0) {
                    UiObject2 justOnce = waitForOptionalLabeledClickable(
                            exactCaseInsensitiveLabel("Just once"),
                            Math.min(2_000, remaining),
                            "single-use chooser choice");
                    if (justOnce != null && !handlerPackage.equals(currentPackage())) {
                        guardedClick(justOnce, "single-use chooser choice");
                        checks.put("singleUseChooserChoice", true);
                    }
                }
                return;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for the exact Android chooser and admitted VLC destination");
    }

    private static String chooseExternalDestinationAction(
            boolean chooserVisible,
            boolean chooserHandlerVisible) {
        if (chooserVisible && chooserHandlerVisible) return "select-chooser-handler";
        return "wait";
    }

    private static boolean hasCompleteHandlerMetadata(
            String label, String packageName, String activity,
            String playbackActivity, String activityCount) {
        boolean noneProvided = label.isEmpty()
                && packageName.isEmpty()
                && activity.isEmpty()
                && playbackActivity.isEmpty()
                && activityCount.isEmpty();
        boolean allProvided = !label.isEmpty()
                && !packageName.isEmpty()
                && !activity.isEmpty()
                && !playbackActivity.isEmpty()
                && !activityCount.isEmpty();
        return noneProvided || allProvided;
    }

    private void requireHandlerAdmission() {
        if (handlerLabel.isEmpty()) {
            checks.put("handlerAdmissionProvided", false);
            fail("No exact external handler metadata was admitted. "
                    + "The chooser was retained for honest inspection.");
        }
        assertEquals("Unexpected admitted external handler label", "VLC", handlerLabel);
        assertEquals("Unexpected admitted external handler package", VLC_PACKAGE, handlerPackage);
        assertEquals("Unexpected admitted external intent activity", VLC_INTENT_ACTIVITY, handlerActivity);
        assertEquals("Unexpected manifest-derived VLC playback activity",
                VLC_PLAYBACK_ACTIVITY, handlerPlaybackActivity);
        assertTrue("VLC was not independently admitted alongside another handler",
                handlerActivityCount >= 2);
        checks.put("handlerAdmissionProvided", true);
    }

    private void settleVlcFirstRunAndReachPlayer() throws Exception {
        requireHandlerAdmission();
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;
        boolean fullscreenTipDismissed = false;
        boolean welcomeAdvanced = false;
        boolean noFileAccessSelected = false;
        boolean noFileAccessAdvanced = false;
        boolean themeAdvanced = false;
        boolean notificationSkipped = false;
        boolean allSetStarted = false;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 fullscreenTip = findExactFullscreenTipButton();
            if (fullscreenTip != null) {
                assertTrue("The exact fullscreen tip reappeared after its one allowed dismissal",
                        !fullscreenTipDismissed);
                capture("nonbinding-fullscreen-tip");
                fullscreenTip.click();
                fullscreenTipDismissed = true;
                checks.put("nonbindingFullscreenTipDismissed", true);
                log("Dismissed the exact nonbinding SystemUI fullscreen tip once");
                SystemClock.sleep(250);
                continue;
            }
            if (hasAnyFullscreenTipResource()) {
                SystemClock.sleep(250);
                continue;
            }
            if (denyExactOptionalVlcPermissionIfPresent()) {
                checks.put("vlcOptionalPermissionDenied", true);
                SystemClock.sleep(250);
                continue;
            }
            assertNoOutOfScopeApproval();
            if (!VLC_PACKAGE.equals(currentPackage())) {
                SystemClock.sleep(250);
                continue;
            }
            if (device.hasObject(By.res(VLC_PACKAGE, "player_root").pkg(VLC_PACKAGE))) {
                checks.put("vlcPlayerSurfaceObserved", true);
                return;
            }
            if (device.hasObject(By.text(exactLabel(VLC_WELCOME_TITLE)))) {
                assertTrue("VLC welcome page repeated", !welcomeAdvanced);
                checks.put("vlcOnboardingObserved", true);
                capture("vlc-onboarding-welcome");
                clickVlcOnboardingControl("Next", "VLC welcome Next");
                welcomeAdvanced = true;
                continue;
            }
            if (device.hasObject(By.text(exactLabel(VLC_PERMISSION_TITLE)))) {
                checks.put("vlcOnboardingObserved", true);
                if (!noFileAccessSelected) {
                    capture("vlc-onboarding-permission");
                    clickVlcOnboardingControl(VLC_NO_FILE_ACCESS, "VLC No file access option");
                    noFileAccessSelected = true;
                    checks.put("vlcStorageAccessDenied", true);
                } else {
                    assertTrue("VLC permission page repeated after denial", !noFileAccessAdvanced);
                    clickVlcOnboardingControl("Next", "VLC permission Next after No file access");
                    noFileAccessAdvanced = true;
                }
                continue;
            }
            if (device.hasObject(By.text(exactLabel(VLC_NO_FILE_ACCESS)))) {
                assertTrue("VLC no-file-access explanation repeated", !noFileAccessAdvanced);
                capture("vlc-onboarding-no-file-access");
                clickVlcOnboardingControl("Next", "VLC no-file-access Next");
                noFileAccessAdvanced = true;
                checks.put("vlcStorageAccessDenied", true);
                continue;
            }
            if (device.hasObject(By.text(exactLabel(VLC_THEME_TITLE)))) {
                assertTrue("VLC theme page repeated", !themeAdvanced);
                capture("vlc-onboarding-theme");
                clickVlcOnboardingControl("Next", "VLC nonbinding theme Next");
                themeAdvanced = true;
                continue;
            }
            if (device.hasObject(By.text(exactLabel(VLC_NOTIFICATION_TITLE)))) {
                assertTrue("VLC notification page repeated", !notificationSkipped);
                capture("vlc-onboarding-notification");
                clickVlcOnboardingControl("Skip", "VLC optional notification Skip");
                notificationSkipped = true;
                checks.put("vlcOptionalPermissionDenied", true);
                continue;
            }
            if (device.hasObject(By.text(exactLabel(VLC_ALL_SET_TITLE)))) {
                assertTrue("VLC all-set page repeated", !allSetStarted);
                capture("vlc-onboarding-all-set");
                clickVlcOnboardingControl(VLC_START, "VLC onboarding Start VLC");
                allSetStarted = true;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for VLC's manifest-derived video player surface");
    }

    private void clickVlcOnboardingControl(String label, String description) {
        UiObject2 control = findLabeledClickableInPackage(label, VLC_PACKAGE, description);
        assertNotNull("Missing exact " + description, control);
        assertNoOutOfScopeApproval();
        control.click();
        log("Clicked semantic nonbinding control: " + description);
        SystemClock.sleep(500);
    }

    private boolean denyExactOptionalVlcPermissionIfPresent() throws IOException {
        String foreground = currentPackage();
        if (!foreground.equals("com.android.permissioncontroller")
                && !foreground.equals("com.google.android.permissioncontroller")) {
            return false;
        }
        String[] allowedMessages = {
                "Allow VLC to send you notifications?",
                "Allow VLC to access photos and videos on this device?",
                "Allow VLC to access music and audio on this device?"
        };
        boolean exactAllowedMessage = false;
        for (String message : allowedMessages) {
            if (device.hasObject(By.text(exactLabel(message)))) {
                exactAllowedMessage = true;
                break;
            }
        }
        assertTrue("Refusing an unexpected permission-controller surface", exactAllowedMessage);
        List<UiObject2> denyButtons = device.findObjects(
                By.res(foreground, "permission_deny_button")
                        .pkg(foreground)
                        .clickable(true)
                        .enabled(true));
        assertEquals("Expected one exact permission denial button", 1, denyButtons.size());
        capture("vlc-optional-permission-denial");
        denyButtons.get(0).click();
        log("Denied one exact optional VLC permission without granting access");
        return true;
    }

    private UiObject2 findExactFullscreenTipButton() {
        List<UiObject2> titles = device.findObjects(
                By.res(SYSTEM_UI_PACKAGE, "immersive_cling_title")
                        .pkg(SYSTEM_UI_PACKAGE)
                        .text(exactLabel(FULLSCREEN_TIP_TITLE)));
        List<UiObject2> descriptions = device.findObjects(
                By.res(SYSTEM_UI_PACKAGE, "immersive_cling_description")
                        .pkg(SYSTEM_UI_PACKAGE)
                        .text(exactLabel(FULLSCREEN_TIP_DESCRIPTION)));
        List<UiObject2> buttons = device.findObjects(
                By.res(SYSTEM_UI_PACKAGE, "ok")
                        .pkg(SYSTEM_UI_PACKAGE)
                        .text(exactLabel(FULLSCREEN_TIP_BUTTON))
                        .clazz("android.widget.Button")
                        .clickable(true)
                        .enabled(true));
        if (titles.isEmpty() || descriptions.isEmpty() || buttons.isEmpty()) return null;
        assertEquals("Expected one exact fullscreen tip title", 1, titles.size());
        assertEquals("Expected one exact fullscreen tip description", 1, descriptions.size());
        assertEquals("Expected one exact fullscreen tip button", 1, buttons.size());
        UiObject2 button = buttons.get(0);
        assertVisibleBounds(titles.get(0), "fullscreen tip title");
        assertVisibleBounds(descriptions.get(0), "fullscreen tip description");
        assertVisibleBounds(button, "fullscreen tip button");
        return button;
    }

    private boolean hasAnyFullscreenTipResource() {
        return device.hasObject(By.res(SYSTEM_UI_PACKAGE, "immersive_cling_title"))
                || device.hasObject(By.res(SYSTEM_UI_PACKAGE, "immersive_cling_description"))
                || device.hasObject(By.res(SYSTEM_UI_PACKAGE, "ok"));
    }

    private void launchProduct() {
        assertNoOutOfScopeApproval();
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        assertTrue("Product package did not become visible",
                device.wait(Until.hasObject(By.pkg(PRODUCT_PACKAGE)), UI_WAIT_MS));
        log("Started the unchanged production package through its explicit launcher activity");
    }

    private void reachFirstRun() throws Exception {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            if (device.hasObject(By.text("How do you want to use YAWF Stream?"))) {
                transition("first-run-visible");
                return;
            }
            if (device.hasObject(By.text("Enable Android update checks?"))) {
                capture("initial-update-consent");
                UiObject2 notNow = waitFor(
                        By.res("android", "button2")
                                .pkg(PRODUCT_PACKAGE)
                                .text(exactCaseInsensitiveLabel("Not now"))
                                .clickable(true)
                                .enabled(true),
                        SHORT_WAIT_MS,
                        "nonbinding Not now update choice");
                guardedClick(notNow, "nonbinding Not now update choice");
                continue;
            }
            if (device.hasObject(By.text("Welcome to YAWF Stream"))
                    && device.hasObject(By.text("Skip"))) {
                capture("tier-welcome");
                clickLabeled("Skip", "ordinary tier welcome Skip", SHORT_WAIT_MS);
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out reaching the normal FirstRunWizard");
    }

    private void dismissOrdinaryTourIfPresent() throws Exception {
        long deadline = SystemClock.uptimeMillis() + 5_000;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 skip = findLabeledClickable("Skip the tour");
            if (skip == null) skip = findLabeledClickable("Skip tour");
            if (skip != null) {
                capture("ordinary-tour");
                guardedClick(skip, "ordinary nonbinding tour Skip");
                return;
            }
            SystemClock.sleep(250);
        }
        log("No ordinary tour appeared during the bounded observation interval");
    }

    private void dismissObservedIme() {
        BySelector inputMethod = By.pkg(Pattern.compile(".*inputmethod.*"));
        if (!device.hasObject(inputMethod)) return;
        device.pressBack();
        assertTrue("Observed input method did not dismiss after one Back",
                device.wait(Until.gone(inputMethod), SHORT_WAIT_MS));
        log("Dismissed the observed input method with one Back before the next semantic action");
    }

    private UiObject2 singleEditableField(String label, int exactCount, int index) {
        List<UiObject2> fields = device.findObjects(By.clazz("android.widget.EditText").pkg(PRODUCT_PACKAGE));
        assertEquals("Unexpected editable field count for " + label, exactCount, fields.size());
        return fields.get(index);
    }

    private List<UiObject2> waitForEditableFields(int minimum, long timeoutMs, String label) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            List<UiObject2> fields = device.findObjects(
                    By.clazz("android.widget.EditText").pkg(PRODUCT_PACKAGE));
            if (fields.size() >= minimum) return fields;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + label);
        return new ArrayList<>();
    }

    private UiObject2 scrollUntilLabeledClickable(String label, String description) {
        for (int attempt = 0; attempt < 12; attempt++) {
            assertNoOutOfScopeApproval();
            UiObject2 found = findLabeledClickable(label);
            if (found != null) return found;
            UiObject2 scrollable = device.findObject(
                    By.scrollable(true).pkg(PRODUCT_PACKAGE));
            assertNotNull("No semantic scrollable container while seeking " + description, scrollable);
            scrollable.scroll(Direction.DOWN, 0.70f);
            log("Scrolled the production WebView while seeking " + description);
            SystemClock.sleep(500);
        }
        fail("Could not scroll to " + description);
        return null;
    }

    private void openPlaybackSettingsTransaction() {
        RuntimeExternalSettingsTransaction.open(
                new RuntimeExternalSettingsTransaction.Environment() {
                    @Override
                    public boolean clearAccessibilityCache() {
                        return instrumentation.getUiAutomation().clearCache();
                    }

                    @Override
                    public void assertNoOutOfScopeApproval() {
                        RuntimeExternalPlayerFlowTest.this
                                .assertNoOutOfScopeApprovalForSettingsTransaction();
                    }

                    @Override
                    public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                        return observePlaybackSettingsTransaction();
                    }

                    @Override
                    public void recordTiming(
                            String stage,
                            long startedAtMs,
                            long finishedAtMs,
                            long idleBeforeMs,
                            long idleAfterMs,
                            boolean returned) {
                        RuntimeExternalPlayerFlowTest.this.recordSettingsTransactionTiming(
                                stage,
                                startedAtMs,
                                finishedAtMs,
                                idleBeforeMs,
                                idleAfterMs,
                                returned);
                    }

                    @Override
                    public void recordSettingsClickTiming(
                            long dispatchedAtMs,
                            long finishedAtMs,
                            long idleBeforeMs,
                            long idleAfterMs,
                            boolean returned) {
                        RuntimeExternalPlayerFlowTest.this.recordSettingsClickTiming(
                                dispatchedAtMs,
                                finishedAtMs,
                                idleBeforeMs,
                                idleAfterMs,
                                returned);
                    }

                    @Override
                    public void log(String message) {
                        RuntimeExternalPlayerFlowTest.this.log(message);
                    }
                },
                MEDIA_WAIT_MS);
    }

    private RuntimeExternalSettingsTransaction.Observation observePlaybackSettingsTransaction() {
        UiObject2 playerDialog = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);
        if (playerDialog == null || !hasVisibleBounds(playerDialog)) {
            return RuntimeExternalSettingsTransaction.Observation.waiting();
        }
        UiObject2 settings = findLabeledClickableWithin(
                playerDialog, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL);
        if (settings != null && hasVisibleBounds(settings)) {
            assertVisibleBounds(settings, PLAYBACK_SETTINGS_LABEL);
            return RuntimeExternalSettingsTransaction.Observation.settings(settings::click);
        }
        assertVisibleBounds(playerDialog, "playing movie dialog");
        return RuntimeExternalSettingsTransaction.Observation.reveal(playerDialog::click);
    }

    private UiObject2 waitForUniquePlaybackSettingsDialog() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertTrue(
                    "Accessibility cache refresh failed",
                    instrumentation.getUiAutomation().clearCache());
            assertNoOutOfScopeApproval();
            UiObject2 dialog = findUniqueExactProductDialog(PLAYBACK_SETTINGS_LABEL);
            if (dialog != null) {
                assertVisibleBounds(dialog, "Playback settings dialog");
                return dialog;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for the unique Playback settings dialog");
        return null;
    }

    private UiObject2 scrollPlaybackSettingsUntilLabeledClickable(
            String label, String description) {
        for (int attempt = 0; attempt < 12; attempt++) {
            assertTrue(
                    "Accessibility cache refresh failed",
                    instrumentation.getUiAutomation().clearCache());
            assertNoOutOfScopeApproval();
            UiObject2 dialog = requireUniqueExactProductDialog(
                    PLAYBACK_SETTINGS_LABEL, "Playback settings dialog");
            UiObject2 found = findLabeledClickableWithin(dialog, label, description);
            if (found != null && hasVisibleBounds(found)) {
                assertVisibleBounds(found, description);
                return found;
            }
            UiObject2 scrollable = findUniqueScrollableWithin(dialog, description);
            scrollable.scroll(Direction.DOWN, 0.70f);
            log("Scrolled only the Playback settings dialog while seeking " + description);
            SystemClock.sleep(500);
        }
        fail("Could not scroll the Playback settings dialog to " + description);
        return null;
    }

    private UiObject2 findUniqueScrollableWithin(UiObject2 dialog, String description) {
        List<UiObject2> candidates = new ArrayList<>();
        if (dialog.isScrollable()) candidates.add(dialog);
        for (UiObject2 descendant : dialog.findObjects(
                By.scrollable(true).pkg(PRODUCT_PACKAGE))) {
            boolean duplicate = false;
            for (UiObject2 existing : candidates) {
                if (sameSemanticNode(existing, descendant)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) candidates.add(descendant);
        }
        assertEquals(
                "Expected one Playback settings scrollable while seeking " + description,
                1,
                candidates.size());
        UiObject2 scrollable = candidates.get(0);
        assertVisibleBounds(scrollable, "Playback settings scrollable");
        return scrollable;
    }

    private UiObject2 waitForLabeledClickable(String label, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 found = findLabeledClickable(label);
            if (found != null) return found;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
        return null;
    }

    private UiObject2 findLabeledClickable(String label) {
        return findLabeledClickable(exactLabel(label), label);
    }

    private UiObject2 findLabeledClickable(Pattern labelPattern, String description) {
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestors(candidates, device.findObjects(By.text(labelPattern)));
        collectClickableAncestors(candidates, device.findObjects(By.desc(labelPattern)));
        if (candidates.size() > 1) {
            fail("Ambiguous enabled clickable controls for exact label: " + description);
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findLabeledClickableInPackage(
            String label, String packageName, String description) {
        Pattern labelPattern = exactLabel(label);
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestors(
                candidates, device.findObjects(By.text(labelPattern).pkg(packageName)));
        collectClickableAncestors(
                candidates, device.findObjects(By.desc(labelPattern).pkg(packageName)));
        for (UiObject2 candidate : candidates) {
            assertEquals(description + " escaped the expected package",
                    packageName, candidate.getApplicationPackage());
        }
        if (candidates.size() > 1) {
            fail("Ambiguous enabled clickable controls for exact package-owned label: " + description);
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findLabeledClickableWithin(
            UiObject2 boundary, String label, String description) {
        Pattern labelPattern = exactLabel(label);
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestorsWithin(
                candidates, boundary.findObjects(By.text(labelPattern)), boundary);
        collectClickableAncestorsWithin(
                candidates, boundary.findObjects(By.desc(labelPattern)), boundary);
        if (candidates.size() > 1) {
            fail("Ambiguous enabled clickable controls inside the exact dialog for: " + description);
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findUniqueExactProductDialog(String label) {
        List<UiObject2> dialogs = device.findObjects(
                By.clazz("android.app.Dialog")
                        .pkg(PRODUCT_PACKAGE)
                        .text(exactLabel(label)));
        if (dialogs.size() > 1) {
            fail("Ambiguous product dialogs for exact label: " + label);
        }
        return dialogs.isEmpty() ? null : dialogs.get(0);
    }

    private UiObject2 requireUniqueExactProductDialog(String label, String description) {
        UiObject2 dialog = findUniqueExactProductDialog(label);
        assertNotNull("Missing exact product-owned " + description, dialog);
        assertVisibleBounds(dialog, description);
        return dialog;
    }

    private UiObject2 waitForOptionalLabeledClickable(
            Pattern labelPattern, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 found = findLabeledClickable(labelPattern, description);
            if (found != null) return found;
            SystemClock.sleep(250);
        }
        return null;
    }

    private void collectClickableAncestors(List<UiObject2> candidates, List<UiObject2> matches) {
        for (UiObject2 match : matches) {
            UiObject2 candidate = clickableAncestor(match);
            if (candidate == null) continue;
            boolean duplicate = false;
            for (UiObject2 existing : candidates) {
                if (sameSemanticNode(existing, candidate)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) candidates.add(candidate);
        }
    }

    private void collectClickableAncestorsWithin(
            List<UiObject2> candidates, List<UiObject2> matches, UiObject2 boundary) {
        for (UiObject2 match : matches) {
            UiObject2 candidate = clickableAncestorWithin(match, boundary);
            if (candidate == null) continue;
            boolean duplicate = false;
            for (UiObject2 existing : candidates) {
                if (sameSemanticNode(existing, candidate)) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) candidates.add(candidate);
        }
    }

    private boolean sameSemanticNode(UiObject2 left, UiObject2 right) {
        return left.getVisibleBounds().equals(right.getVisibleBounds())
                && sameNullable(left.getResourceName(), right.getResourceName())
                && sameNullable(left.getClassName(), right.getClassName())
                && sameNullable(left.getApplicationPackage(), right.getApplicationPackage())
                && sameNullable(left.getText(), right.getText())
                && sameNullable(left.getContentDescription(), right.getContentDescription());
    }

    private static boolean sameNullable(Object left, Object right) {
        return left == null ? right == null : left.equals(right);
    }

    private static Pattern exactLabel(String label) {
        return Pattern.compile("\\A" + Pattern.quote(label) + "\\z");
    }

    private static Pattern exactCaseInsensitiveLabel(String label) {
        return Pattern.compile(
                "\\A" + Pattern.quote(label) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private UiObject2 clickableAncestor(UiObject2 object) {
        UiObject2 current = object;
        for (int depth = 0; depth < 6 && current != null; depth++) {
            if (current.isClickable() && current.isEnabled()) return current;
            current = current.getParent();
        }
        return null;
    }

    private UiObject2 clickableAncestorWithin(UiObject2 object, UiObject2 boundary) {
        UiObject2 current = object;
        for (int depth = 0; depth < 6 && current != null; depth++) {
            if (sameSemanticNode(current, boundary)) return null;
            if (current.isClickable() && current.isEnabled()) return current;
            current = current.getParent();
        }
        return null;
    }

    private void assertVisibleBounds(UiObject2 object, String description) {
        assertTrue(description + " had no visible bounds", hasVisibleBounds(object));
    }

    private boolean hasVisibleBounds(UiObject2 object) {
        Rect bounds = object.getVisibleBounds();
        return bounds.width() > 0 && bounds.height() > 0;
    }

    private void clickLabeled(String label, String description, long timeoutMs) {
        UiObject2 object = waitForLabeledClickable(label, timeoutMs, description);
        guardedClick(object, description);
    }

    private void guardedClick(UiObject2 object, String description) {
        assertNoOutOfScopeApproval();
        assertNotNull(description + " disappeared", object);
        assertTrue(description + " was disabled", object.isEnabled());
        object.click();
        log("Clicked semantic control: " + description);
        SystemClock.sleep(500);
    }

    private UiObject2 waitForTextOrDescription(String label, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 object = findTextOrDescription(label);
            if (object != null) return object;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
        return null;
    }

    private UiObject2 findTextOrDescription(String label) {
        UiObject2 object = device.findObject(By.text(exactLabel(label)));
        if (object == null) object = device.findObject(By.desc(exactLabel(label)));
        return object;
    }

    private UiObject2 waitFor(BySelector selector, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 object = device.findObject(selector);
            if (object != null) return object;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
        return null;
    }

    private void waitForForegroundPackage(String expected, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            if (expected.equals(currentPackage())) return;
            SystemClock.sleep(250);
        }
        fail("Expected foreground package was not observed: " + expected);
    }

    private String currentPackage() {
        String value = device.getCurrentPackageName();
        return value == null ? "" : value;
    }

    private void assertNoOutOfScopeApproval() {
        UiObject2 text = device.findObject(By.text(BINDING_TERMS));
        UiObject2 description = device.findObject(By.desc(BINDING_TERMS));
        if (text != null || description != null) {
            fail("Refusing to act while a binding legal phrase is visible");
        }
        String foreground = currentPackage();
        if (foreground.equals("com.android.permissioncontroller")
                || foreground.equals("com.google.android.permissioncontroller")
                || foreground.equals("com.android.settings")
                || foreground.equals("com.google.android.packageinstaller")
                || foreground.equals("com.android.packageinstaller")) {
            fail("Refusing to approve an out-of-scope permission, security, settings, or install surface");
        }
    }

    private void assertNoOutOfScopeApprovalForSettingsTransaction() {
        RuntimeExternalLegalSnapshot.assertNoBindingTermsVisible(
                instrumentation.getUiAutomation(), BINDING_TERMS);
        String foreground = currentPackage();
        if (foreground.equals("com.android.permissioncontroller")
                || foreground.equals("com.google.android.permissioncontroller")
                || foreground.equals("com.android.settings")
                || foreground.equals("com.google.android.packageinstaller")
                || foreground.equals("com.android.packageinstaller")) {
            fail("Refusing to approve an out-of-scope permission, security, settings, or install surface");
        }
    }

    private void recordSettingsTransactionTiming(
            String stage,
            long startedAtMs,
            long finishedAtMs,
            long idleBeforeMs,
            long idleAfterMs,
            boolean returned) {
        if (settingsTransactionTimings.size() >= MAX_SETTINGS_TRANSACTION_TIMING_EVENTS) {
            settingsTransactionTimingEventsOmitted++;
            return;
        }
        settingsTransactionTimings.add(String.format(
                Locale.ROOT,
                "%s startUptimeMs=%d finishUptimeMs=%d idleBeforeMs=%d idleAfterMs=%d returned=%s",
                safe(stage),
                startedAtMs,
                finishedAtMs,
                idleBeforeMs,
                idleAfterMs,
                returned));
    }

    private void recordSettingsClickTiming(
            long dispatchedAtMs,
            long finishedAtMs,
            long idleBeforeMs,
            long idleAfterMs,
            boolean returned) {
        if (settingsClickDispatchedAtMs >= 0L) {
            fail("Playback settings click timing was recorded more than once");
        }
        settingsClickDispatchedAtMs = dispatchedAtMs;
        settingsClickFinishedAtMs = finishedAtMs;
        settingsClickIdleBeforeMs = idleBeforeMs;
        settingsClickIdleAfterMs = idleAfterMs;
        settingsClickReturned = returned;
    }

    private void transition(String next) {
        phase = next;
        if (phases.size() >= MAX_PHASES) fail("Phase receipt exceeded bound");
        phases.add(String.format(Locale.ROOT, "%d %s",
                SystemClock.uptimeMillis() - startedAtMs, safe(next)));
        log("Phase: " + next);
    }

    private void capture(String label) throws IOException {
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
        String redacted = new String(Files.readAllBytes(hierarchy.toPath()), StandardCharsets.UTF_8);
        redacted = URL.matcher(redacted).replaceAll("[redacted-url]");
        redacted = CAPABILITY.matcher(redacted).replaceAll("[redacted-capability]");
        redacted = SENSITIVE.matcher(redacted).replaceAll("[redacted-sensitive]");
        writeBounded(hierarchy, redacted, (int) MAX_HIERARCHY_BYTES);
        log("Captured bounded screenshot and redacted hierarchy: " + label);
    }

    private void log(String value) {
        if (actions.size() >= MAX_ACTION_LINES) fail("Action log exceeded bound");
        actions.add(safe(value));
    }

    private static String safe(String value) {
        if (value == null) return "";
        String redacted = URL.matcher(value).replaceAll("[redacted-url]");
        redacted = CAPABILITY.matcher(redacted).replaceAll("[redacted-capability]");
        redacted = SENSITIVE.matcher(redacted).replaceAll("[redacted-sensitive]");
        redacted = redacted.replace('\n', ' ').replace('\r', ' ');
        return redacted.length() <= 500 ? redacted : redacted.substring(0, 500);
    }

    private void writeActions() throws IOException {
        StringBuilder content = new StringBuilder();
        for (int index = 0; index < actions.size(); index++) {
            content.append(index + 1).append(' ').append(actions.get(index)).append('\n');
        }
        writeBounded(new File(evidenceDir, "actions.txt"), content.toString(), 64 * 1024);
    }

    private void writeReceipt(String outcome, String failure) throws Exception {
        JSONObject receipt = new JSONObject();
        receipt.put("schemaVersion", 1);
        receipt.put("outcome", outcome);
        receipt.put("finalPhase", phase);
        receipt.put("failure", failure == null ? JSONObject.NULL : safe(failure));
        receipt.put("productPackage", PRODUCT_PACKAGE);
        receipt.put("fixture", "bounded-loopback-server-mode");
        receipt.put("persistentUiAutomationSession", true);
        receipt.put("captures", captureIndex);
        receipt.put("expectedHandlerLabel", handlerLabel.isEmpty() ? JSONObject.NULL : handlerLabel);
        receipt.put("expectedHandlerPackage", handlerPackage.isEmpty() ? JSONObject.NULL : handlerPackage);
        receipt.put("expectedHandlerActivity", handlerActivity.isEmpty() ? JSONObject.NULL : handlerActivity);
        receipt.put("manifestDeclaredPlaybackActivity",
                handlerPlaybackActivity.isEmpty() ? JSONObject.NULL : handlerPlaybackActivity);
        receipt.put("externalHandlerActivityCount", handlerActivityCount);
        receipt.put("phases", new JSONArray(phases));
        receipt.put("settingsTransactionTimings", new JSONArray(settingsTransactionTimings));
        receipt.put(
                "settingsTransactionTimingEventsOmitted",
                settingsTransactionTimingEventsOmitted);
        if (settingsClickDispatchedAtMs >= 0L) {
            JSONObject settingsClickTiming = new JSONObject();
            settingsClickTiming.put("dispatchUptimeMs", settingsClickDispatchedAtMs);
            settingsClickTiming.put("finishUptimeMs", settingsClickFinishedAtMs);
            settingsClickTiming.put("idleBeforeMs", settingsClickIdleBeforeMs);
            settingsClickTiming.put("idleAfterMs", settingsClickIdleAfterMs);
            settingsClickTiming.put("returned", settingsClickReturned);
            receipt.put("settingsClickTiming", settingsClickTiming);
        } else {
            receipt.put("settingsClickTiming", JSONObject.NULL);
        }
        receipt.put("checks", new JSONObject(checks));
        receipt.put("decodedPlaybackClaimed", false);
        receipt.put("decodeClaimRequiresManualScreenshotAndLiveReceiptReview", true);
        writeBounded(
                new File(evidenceDir, "instrumentation-external-player-receipt.json"),
                receipt.toString(2) + "\n",
                32 * 1024);
    }

    private static void writeBounded(File file, String value, int maxBytes) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) {
            throw new IOException("Evidence text exceeded bound for " + file.getName());
        }
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
        }
    }
}
