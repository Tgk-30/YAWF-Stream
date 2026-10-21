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

/** One persistent semantic UI session for a real public 2.3.25 to 2.3.26 OTA. */
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

    @Test
    public void updateOfficialPublicBaselineThroughNativeUi() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        Bundle arguments = InstrumentationRegistry.getArguments();
        String subdir = arguments.getString("evidenceSubdir", EVIDENCE_SUBDIR);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(subdir).matches());
        assertEquals("Unexpected evidence subdirectory", EVIDENCE_SUBDIR, subdir);
        assertTrue(
                "Fixed OTA arguments do not match the reviewed release",
                OtaFlowPolicy.matchesVersionPins(
                        arguments.getString("baselineVersion", ""),
                        arguments.getString("targetVersion", ""),
                        parseLongArgument(arguments, "targetVersionCode"),
                        arguments.getString("targetSha256", ""),
                        parseLongArgument(arguments, "targetSize"),
                        arguments.getString("signerSha256", "")));

        Context targetContext = instrumentation.getTargetContext();
        File internalFiles = targetContext.getFilesDir();
        assertNotNull("Internal files directory unavailable", internalFiles);
        evidenceDir = new File(internalFiles, subdir);
        assertTrue("Could not create evidence directory", evidenceDir.mkdirs() || evidenceDir.isDirectory());

        Throwable primary = null;
        try {
            runFlow();
        } catch (Throwable caught) {
            primary = caught;
            try {
                capture("failure");
            } catch (Throwable captureFailure) {
                log("Failure capture unavailable: " + captureFailure.getClass().getSimpleName());
            }
        }

        try {
            cleanupUnknownSourcePermission();
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

    private void runFlow() throws Exception {
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
        log("Returned from the product-opened unknown-source Settings page");
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
        click(
                By.res("android", "button1").pkg(installerPackage).text(OPEN_TEXT),
                "system Open",
                SHORT_WAIT_MS,
                true);
        installerOpenObserved = true;
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
        receipt.put("baselineVersion", OtaFlowPolicy.BASELINE_VERSION);
        receipt.put("targetVersion", OtaFlowPolicy.TARGET_VERSION);
        receipt.put("targetSha256", OtaFlowPolicy.TARGET_SHA256);
        receipt.put("productPermissionPageObserved", productPermissionPageObserved);
        receipt.put("permissionEnabledByTest", permissionEnabledByTest);
        receipt.put("installerSuccessObserved", installerSuccessObserved);
        receipt.put("installerOpenObserved", installerOpenObserved);
        receipt.put("updatedProductObserved", updatedProductObserved);
        receipt.put("permissionCleanupObserved", permissionCleanupObserved);
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
