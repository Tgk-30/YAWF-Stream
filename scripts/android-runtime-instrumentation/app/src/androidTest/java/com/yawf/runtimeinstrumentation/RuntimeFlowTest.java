package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;

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

@RunWith(AndroidJUnit4.class)
public final class RuntimeFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    private static final long SHORT_WAIT_MS = 15_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final long UPDATE_WAIT_MS = 120_000;
    private static final long TOUR_MOUNT_WAIT_MS = 5_000;
    private static final long TOUR_OBSERVATION_IDLE_TIMEOUT_MS = 250;
    private static final String EVIDENCE_SUBDIR = "persistent-flow";
    private static final int MAX_CAPTURES = 20;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final int MAX_ACTION_LINES = 160;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern URL = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private int captureIndex;
    private String candidateVersion;
    private String publishedVersion;

    @Test
    public void completeSetupAndNativeUpdateFlowInOneSession() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        Bundle arguments = InstrumentationRegistry.getArguments();
        String evidenceSubdir = arguments.getString("evidenceSubdir", EVIDENCE_SUBDIR);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(evidenceSubdir).matches());
        assertTrue("Unexpected evidence subdirectory", EVIDENCE_SUBDIR.equals(evidenceSubdir));
        Context targetContext = instrumentation.getTargetContext();
        File internalFiles = targetContext.getFilesDir();
        assertNotNull("Internal files directory unavailable", internalFiles);
        evidenceDir = new File(internalFiles, evidenceSubdir);
        assertTrue("Could not create evidence directory", evidenceDir.mkdirs() || evidenceDir.isDirectory());

        candidateVersion = arguments.getString("candidateVersion", "");
        publishedVersion = arguments.getString("publishedVersion", "");
        assertTrue(
                "Instrumentation version pins do not match the fixed release gate",
                FlowPolicy.isExpectedVersionPair(candidateVersion, publishedVersion));

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
            writeActionLog();
            writeReceipt(outcome, failure);
        }
    }

    private void runFlow() throws Exception {
        assertNoBindingTerms();
        device.wakeUp();
        launchProduct();
        reachFirstRun();

        capture("first-run");
        click(By.textContains("Start with public sources"), "Quick setup", UI_WAIT_MS, false);
        waitFor(By.text("Continue without adding credentials"), UI_WAIT_MS, "quick setup notice");
        capture("quick-setup-notice");
        click(
                By.textContains("I understand the privacy, reliability, catalog, and playback limits"),
                "nonbinding privacy acknowledgement",
                SHORT_WAIT_MS,
                false);
        click(By.text("Continue with Quick setup"), "Continue with Quick setup", SHORT_WAIT_MS, true);

        waitFor(By.text("Discover"), UI_WAIT_MS, "Discover after setup");
        dismissOrdinaryTours();
        capture("discover-after-setup");

        clickWebButton(FlowPolicy.MORE_NAVIGATION_BUTTON, "More navigation", UI_WAIT_MS);
        click(By.text("Settings"), "Settings", SHORT_WAIT_MS, false);
        waitForSettingsRoute();
        capture("settings");
        openHelpAndUpdates();
        scrollUntil(By.text("Android APK updates"), "Android APK updates");
        scrollUntil(By.text("Check for Android updates"), "Check for Android updates");
        capture("android-update-card");
        click(By.text("Check for Android updates"), "Check for Android updates", SHORT_WAIT_MS, true);

        waitFor(By.text("Check for Android updates?"), SHORT_WAIT_MS, "native manual-check confirmation");
        capture("manual-update-consent");
        click(nativeButton(FlowPolicy.CHECK_NOW_BUTTON), "Check now", SHORT_WAIT_MS, true);

        UiObject2 title = waitFor(
                By.text(FlowPolicy.UP_TO_DATE_TITLE), UPDATE_WAIT_MS, "native up-to-date title");
        UiObject2 message = waitFor(
                By.text(FlowPolicy.UP_TO_DATE_MESSAGE), SHORT_WAIT_MS, "native up-to-date message");
        assertTrue(
                "Native updater result was not the exact expected no-newer result",
                FlowPolicy.isExactUpToDateResult(title.getText(), message.getText()));
        capture("manual-update-result");
        log("PASS native updater result for candidate " + candidateVersion
                + " with public channel " + publishedVersion);
    }

    private void launchProduct() {
        assertNoBindingTerms();
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        assertTrue(
                "Product package did not become visible",
                device.wait(Until.hasObject(By.pkg(PRODUCT_PACKAGE)), UI_WAIT_MS));
        device.waitForIdle(2_000);
        log("Started the product through an explicit Android activity intent");
    }

    private void reachFirstRun() throws IOException {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            boolean consent = device.hasObject(By.text("Enable Android update checks?"));
            boolean question = device.hasObject(By.text("How do you want to use YAWF Stream?"));
            boolean tierHeading = device.hasObject(By.text("Welcome to YAWF Stream"));
            boolean tierSkip = device.hasObject(By.text("Skip"));
            boolean tierNext = device.hasObject(By.text("Next"));
            FlowPolicy.OnboardingEntry entry = FlowPolicy.classifyOnboarding(
                    consent, question, tierHeading, tierSkip, tierNext);
            switch (entry) {
                case UPDATE_CONSENT:
                    capture("initial-update-consent");
                    click(nativeButton(FlowPolicy.NOT_NOW_BUTTON), "Not now", SHORT_WAIT_MS, true);
                    break;
                case TIER_WELCOME:
                    capture("tier-welcome");
                    click(By.text("Skip"), "ordinary tier welcome Skip", SHORT_WAIT_MS, true);
                    break;
                case FIRST_RUN:
                    log("Reached FirstRunWizard in the same UiAutomation session");
                    return;
                case WAIT:
                    SystemClock.sleep(250);
                    break;
            }
        }
        fail("Timed out reaching the FirstRunWizard through native consent and tier welcome");
    }

    private void dismissOrdinaryTours() throws IOException {
        FlowPolicy.LabeledWebButtonSpec[] controls = new FlowPolicy.LabeledWebButtonSpec[] {
                FlowPolicy.SKIP_THE_TOUR_BUTTON,
                FlowPolicy.SKIP_TOUR_BUTTON
        };
        long mountDeadline = SystemClock.uptimeMillis() + TOUR_MOUNT_WAIT_MS;
        UiObject2 object = null;
        while (SystemClock.uptimeMillis() < mountDeadline && object == null) {
            assertNoBindingTerms();
            object = findWebButtonNow(controls);
            if (object == null) {
                SystemClock.sleep(250);
            }
        }
        if (object == null) {
            log("No ordinary tour appeared during the bounded mount wait");
            return;
        }
        capture("tour-ready");
        assertNoBindingTerms();
        object = findWebButtonNow(controls);
        assertNotNull("Tour Skip button disappeared after policy guard", object);
        object.click();
        log("Clicked one exact labeled ordinary tour Skip button");

        Configurator configurator = Configurator.getInstance();
        long previousIdleTimeout = configurator.getWaitForIdleTimeout();
        configurator.setWaitForIdleTimeout(TOUR_OBSERVATION_IDLE_TIMEOUT_MS);
        try {
            observeOrdinaryTourDismissal();
        } finally {
            configurator.setWaitForIdleTimeout(previousIdleTimeout);
        }
    }

    private void observeOrdinaryTourDismissal() {
        long dismissalStarted = SystemClock.uptimeMillis();
        long dismissalDeadline = dismissalStarted + TOUR_MOUNT_WAIT_MS;
        int completedSamples = 0;
        int consecutiveAbsentSamples = 0;
        while (SystemClock.uptimeMillis() < dismissalDeadline) {
            long sampleStarted = SystemClock.uptimeMillis();
            TimedNodeQuery dialog = queryExactTourNode(
                    "welcome-dialog", FlowPolicy.WELCOME_TOUR_DIALOG);
            TimedNodeQuery discover = queryExactTourNode(
                    "discover", FlowPolicy.DISCOVER_BUTTON);
            TimedNodeQuery reminder = queryExactTourNode(
                    "setup-reminder", FlowPolicy.STREAMING_SETUP_REMINDER);
            completedSamples++;
            consecutiveAbsentSamples = FlowPolicy.nextTourDismissalAbsentSamples(
                    consecutiveAbsentSamples,
                    dialog.present,
                    discover.visible,
                    reminder.visible);
            log("Tour observation sample=" + completedSamples
                    + " elapsedMs=" + (SystemClock.uptimeMillis() - sampleStarted)
                    + " dialogPresent=" + dialog.present
                    + " discoverVisible=" + discover.visible
                    + " reminderVisible=" + reminder.visible
                    + " consecutiveAbsent=" + consecutiveAbsentSamples);
            if (FlowPolicy.isTourDismissalSettled(consecutiveAbsentSamples)) {
                log("Observed the exact Welcome tour dialog absent with Discover and setup reminder"
                        + " visible for a settled bounded interval");
                return;
            }
            long remainingMs = dismissalDeadline - SystemClock.uptimeMillis();
            if (remainingMs > 0) {
                SystemClock.sleep(Math.min(250, remainingMs));
            }
        }
        fail("Ordinary tour did not settle after one guarded Skip action within "
                + TOUR_MOUNT_WAIT_MS + "ms; completedSamples=" + completedSamples
                + ", consecutiveAbsent=" + consecutiveAbsentSamples
                + ", actualElapsedMs=" + (SystemClock.uptimeMillis() - dismissalStarted));
    }

    private TimedNodeQuery queryExactTourNode(
            String queryName, FlowPolicy.ExactTextWebNodeSpec spec) {
        long queryStarted = SystemClock.uptimeMillis();
        UiObject2 object = device.findObject(
                By.text(spec.label())
                        .pkg(FlowPolicy.PRODUCT_PACKAGE)
                        .clazz(spec.className()));
        long elapsedMs = SystemClock.uptimeMillis() - queryStarted;
        boolean present = object != null;
        boolean visible = present && !object.getVisibleBounds().isEmpty();
        log("Tour observation query=" + queryName
                + " elapsedMs=" + elapsedMs
                + " present=" + present
                + " visible=" + visible);
        return new TimedNodeQuery(present, visible);
    }

    private static final class TimedNodeQuery {
        private final boolean present;
        private final boolean visible;

        private TimedNodeQuery(boolean present, boolean visible) {
            this.present = present;
            this.visible = visible;
        }
    }

    private void waitForSettingsRoute() {
        BySelector[] settingsAnchors = new BySelector[] {
                By.text("Help & updates"),
                By.text("Install & setup"),
                By.text("Appearance"),
                By.desc("Settings category")
        };
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            FlowPolicy.SettingsNavigationState state = FlowPolicy.classifySettingsNavigation(
                    device.hasObject(By.text("How do you want to use YAWF Stream?")),
                    device.hasObject(By.res("mobile-nav-more")),
                    findAnyNow(settingsAnchors) != null);
            if (state == FlowPolicy.SettingsNavigationState.BLOCKED_FIRST_RUN) {
                fail("FirstRunWizard opened instead of the Settings route");
            }
            if (state == FlowPolicy.SettingsNavigationState.READY) {
                log("Observed the More dialog gone and a Settings-only semantic anchor");
                return;
            }
            SystemClock.sleep(250);
        }
        fail("Settings route did not replace the More dialog with a Settings-only anchor");
    }

    private void openHelpAndUpdates() {
        UiObject2 direct = device.wait(Until.findObject(By.text("Help & updates")), 2_000);
        if (direct != null) {
            click(By.text("Help & updates"), "Help & updates", SHORT_WAIT_MS, true);
            return;
        }
        BySelector[] categorySelectors = new BySelector[] {
                By.text("Install & setup"), By.text("Appearance"), By.desc("Settings category")
        };
        UiObject2 category = waitForAny(SHORT_WAIT_MS, categorySelectors);
        assertNoBindingTerms();
        category = findAnyNow(categorySelectors);
        assertNotNull("Settings category selector disappeared after policy guard", category);
        category.click();
        log("Opened the semantic Settings category selector");
        device.waitForIdle(1_000);
        click(By.text("Help & updates"), "Help & updates", SHORT_WAIT_MS, true);
    }

    private void scrollUntil(BySelector target, String label) {
        for (int attempt = 0; attempt < 8; attempt++) {
            UiObject2 found = device.findObject(target);
            if (found != null) {
                return;
            }
            UiObject2 scrollable = device.findObject(By.scrollable(true));
            assertNotNull("No scrollable container while seeking " + label, scrollable);
            assertNoBindingTerms();
            scrollable = device.findObject(By.scrollable(true));
            assertNotNull("Scrollable container disappeared after policy guard", scrollable);
            scrollable.scroll(Direction.DOWN, 0.75f);
            log("Scrolled semantic Settings container while seeking " + label);
            device.waitForIdle(1_000);
        }
        fail("Could not scroll to " + label);
    }

    private UiObject2 click(
            BySelector selector,
            String label,
            long timeoutMs,
            boolean requireEnabled) {
        waitFor(selector, timeoutMs, label);
        assertNoBindingTerms();
        UiObject2 object = device.findObject(selector);
        assertNotNull(label + " disappeared after policy guard", object);
        if (requireEnabled) {
            assertTrue(label + " was disabled", object.isEnabled());
        }
        object.click();
        log("Clicked semantic control: " + label);
        device.waitForIdle(1_000);
        return object;
    }

    private UiObject2 clickWebButton(
            FlowPolicy.LabeledWebButtonSpec button,
            String label,
            long timeoutMs) {
        BySelector[] selectors = webButtonSelectors(button);
        waitForAny(timeoutMs, selectors);
        assertNoBindingTerms();
        UiObject2 object = findAnyNow(selectors);
        assertNotNull(label + " disappeared after policy guard", object);
        assertTrue(label + " was disabled", object.isEnabled());
        object.click();
        log("Clicked exact text-or-description WebView button: " + label);
        device.waitForIdle(1_000);
        return object;
    }

    private UiObject2 findWebButtonNow(FlowPolicy.LabeledWebButtonSpec... buttons) {
        for (FlowPolicy.LabeledWebButtonSpec button : buttons) {
            UiObject2 object = findAnyNow(webButtonSelectors(button));
            if (object != null) {
                return object;
            }
        }
        return null;
    }

    private BySelector[] webButtonSelectors(FlowPolicy.LabeledWebButtonSpec button) {
        return new BySelector[] {
                By.text(button.label())
                        .pkg(FlowPolicy.PRODUCT_PACKAGE)
                        .clazz(FlowPolicy.WEB_BUTTON_CLASS)
                        .clickable(true)
                        .enabled(true),
                By.desc(button.label())
                        .pkg(FlowPolicy.PRODUCT_PACKAGE)
                        .clazz(FlowPolicy.WEB_BUTTON_CLASS)
                        .clickable(true)
                        .enabled(true)
        };
    }

    private BySelector nativeButton(FlowPolicy.NativeButtonSpec button) {
        return By.res("android", button.resourceName())
                .pkg(PRODUCT_PACKAGE)
                .text(button.textPattern());
    }

    private UiObject2 waitFor(BySelector selector, long timeoutMs, String label) {
        UiObject2 object = device.wait(Until.findObject(selector), timeoutMs);
        assertNotNull("Timed out waiting for " + label, object);
        return object;
    }

    private UiObject2 waitForAny(long timeoutMs, BySelector... selectors) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoBindingTerms();
            UiObject2 found = findAnyNow(selectors);
            if (found != null) {
                return found;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for one of the expected semantic controls");
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
        UiObject2 text = device.findObject(By.text(FlowPolicy.BINDING_TERMS_PATTERN));
        UiObject2 description = device.findObject(By.desc(FlowPolicy.BINDING_TERMS_PATTERN));
        if (text != null || description != null) {
            fail("Refusing to act while a binding-terms phrase is visible");
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
        StringBuilder content = new StringBuilder();
        for (int index = 0; index < actions.size(); index++) {
            content.append(index + 1).append(' ').append(actions.get(index)).append('\n');
        }
        writeBounded(new File(evidenceDir, "actions.txt"), content.toString(), 64 * 1024);
    }

    private void writeReceipt(String outcome, String failure) throws Exception {
        JSONObject receipt = new JSONObject();
        receipt.put("outcome", outcome);
        receipt.put("persistentUiAutomationSession", true);
        receipt.put("productPackage", PRODUCT_PACKAGE);
        receipt.put("candidateVersion", candidateVersion);
        receipt.put("publishedChannelVersion", publishedVersion);
        receipt.put("captures", captureIndex);
        receipt.put("failure", failure == null ? JSONObject.NULL : failure);
        writeBounded(
                new File(evidenceDir, "instrumentation-receipt.json"),
                receipt.toString(2) + "\n",
                16 * 1024);
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
