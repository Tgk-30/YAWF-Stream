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
import android.os.Bundle;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;

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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Black-box startup guidance check for a stock unsupported Android WebView provider. */
@RunWith(AndroidJUnit4.class)
public final class RuntimeWebViewCompatibilityTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String EVIDENCE_SUBDIR = "persistent-webview-compatibility-flow";
    private static final String DEFAULT_PROVIDER_PACKAGE = "com.google.android.webview";
    private static final String DEFAULT_PROVIDER_VERSION = "83.0.4103.106";
    private static final String DEFAULT_PROVIDER_LABEL = "Android System WebView";
    private static final int MINIMUM_WEBVIEW_MAJOR = 90;
    private static final String WARNING_TITLE = "Update Android System WebView";
    private static final String APP_INFO_BUTTON = "Open provider App info";
    private static final String CLOSE_BUTTON = "Close YAWF";
    private static final long SHORT_WAIT_MS = 15_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final int MAX_CAPTURES = 8;
    private static final int MAX_ACTION_LINES = 96;
    private static final int MAX_PHASES = 20;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern SAFE_PACKAGE = Pattern.compile(
            "[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*){1,20}");
    private static final Pattern STRICT_VERSION = Pattern.compile(
            "([0-9]{1,10})(?:\\.[0-9A-Za-z][0-9A-Za-z._-]{0,96})?");
    private static final Pattern SAFE_LABEL = Pattern.compile("[\\p{L}\\p{N} ._+&()'/-]{1,80}");
    private static final Pattern BINDING_TERMS = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private static final Pattern URL = Pattern.compile("(?i)https?://[^\\s\\\"'<>]+");
    private static final Pattern SENSITIVE = Pattern.compile(
            "(?i)(authorization|cookie|session|csrf|bearer|password)[^\\s\\\"'<>]*");

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private final List<String> phases = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private int captureIndex;
    private long startedAtMs;
    private String phase = "not-started";
    private String expectedProviderPackage;
    private String expectedProviderVersion;
    private String expectedProviderLabel;

    @Test
    public void unsupportedStockWebViewShowsNativeRecoveryOnly() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        startedAtMs = SystemClock.uptimeMillis();
        Bundle arguments = InstrumentationRegistry.getArguments();

        String evidenceSubdir = fixedArgument(
                arguments, "evidenceSubdir", EVIDENCE_SUBDIR, SAFE_SUBDIR);
        assertEquals("Unexpected evidence subdirectory", EVIDENCE_SUBDIR, evidenceSubdir);
        expectedProviderPackage = fixedArgument(
                arguments, "expectedWebViewPackage", DEFAULT_PROVIDER_PACKAGE, SAFE_PACKAGE);
        expectedProviderVersion = fixedArgument(
                arguments, "expectedWebViewVersion", DEFAULT_PROVIDER_VERSION, STRICT_VERSION);
        expectedProviderLabel = fixedArgument(
                arguments, "expectedWebViewLabel", DEFAULT_PROVIDER_LABEL, SAFE_LABEL);
        assertEquals("This flow is pinned to the stock API 30 Google provider",
                DEFAULT_PROVIDER_PACKAGE, expectedProviderPackage);
        assertEquals("This flow is pinned to the stock API 30 provider label",
                DEFAULT_PROVIDER_LABEL, expectedProviderLabel);
        Matcher version = STRICT_VERSION.matcher(expectedProviderVersion);
        assertTrue("Expected WebView version did not match after validation", version.matches());
        int expectedMajor = Integer.parseInt(version.group(1));
        assertTrue("Expected WebView must exercise the unsupported side of the literal 90 boundary",
                expectedMajor < MINIMUM_WEBVIEW_MAJOR);

        Context targetContext = instrumentation.getTargetContext();
        evidenceDir = new File(targetContext.getFilesDir(), evidenceSubdir);
        assertTrue("Could not create evidence directory",
                evidenceDir.mkdirs() || evidenceDir.isDirectory());
        checks.put("scope", "unsupported-webview-startup-guidance-only");
        checks.put("normalLaunchViaExplicitLauncherIntent", false);
        checks.put("webContentExposed", false);
        checks.put("onboardingObserved", false);
        checks.put("updaterObserved", false);
        checks.put("settingsLaunchedDirectly", false);
        checks.put("permissionGrantUsed", false);
        checks.put("providerInstalledOrUpdated", false);
        checks.put("playbackTested", false);
        checks.put("otaTested", false);
        checks.put("taskRemovalClaimed", false);
        checks.put("hostTaskRemovalCheckRequired", true);

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
            writeActions();
            writeReceipt(outcome, failure);
        }
    }

    private void runFlow() throws Exception {
        transition("launching-product-normally");
        device.wakeUp();
        launchProductNormally();

        transition("initial-warning-visible");
        UiObject2 appInfo = assertExactCompatibilityWarning();
        assertNoOtherProductSurface();
        capture("initial-native-warning");
        checks.put("exactInitialWarningObserved", true);
        checks.put("webContentExposed", false);

        assertNoBindingTerms();
        appInfo.click();
        log("Clicked the exact native provider App info button once");
        transition("provider-app-info-visible");
        waitForForegroundPackage(SETTINGS_PACKAGE, UI_WAIT_MS);
        waitForExactTextOrDescription(
                expectedProviderLabel, SETTINGS_PACKAGE, UI_WAIT_MS, "exact provider App info label");
        capture("provider-app-info");
        checks.put("settingsReachedOnlyThroughProductButton", true);
        checks.put("exactProviderAppLabelObserved", true);

        device.pressBack();
        log("Pressed Back once from the observed provider App info surface");
        waitForForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS);
        transition("warning-visible-after-settings-return");
        UiObject2 close = assertExactCompatibilityWarning();
        assertNoOtherProductSurface();
        capture("native-warning-after-return");
        checks.put("warningReshownAfterSettingsReturn", true);

        assertNoBindingTerms();
        close.click();
        log("Clicked the exact native Close YAWF button once");
        waitForNotForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS);
        transition("product-not-foreground-after-close");
        capture("after-close-not-foreground");
        checks.put("productNotForegroundAfterClose", true);
        log("Startup guidance flow complete; host-side task removal remains required");
    }

    private void launchProductNormally() {
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        waitForForegroundPackage(PRODUCT_PACKAGE, UI_WAIT_MS);
        checks.put("normalLaunchViaExplicitLauncherIntent", true);
        log("Started the product through its exact normal launcher activity");
    }

    private UiObject2 assertExactCompatibilityWarning() {
        waitFor(By.text(WARNING_TITLE).pkg(PRODUCT_PACKAGE), UI_WAIT_MS, "native WebView warning title");
        List<UiObject2> titles = device.findObjects(By.text(WARNING_TITLE).pkg(PRODUCT_PACKAGE));
        assertEquals("Expected exactly one native WebView warning title", 1, titles.size());
        waitFor(By.text(expectedWarningMessage()).pkg(PRODUCT_PACKAGE),
                SHORT_WAIT_MS, "exact native WebView warning message");
        UiObject2 appInfo = singleNativeButton("button1", APP_INFO_BUTTON);
        UiObject2 close = singleNativeButton("button2", CLOSE_BUTTON);
        assertTrue("App info button was disabled", appInfo.isEnabled());
        assertTrue("Close YAWF button was disabled", close.isEnabled());
        checks.put("literalMinimumWebViewMajor", MINIMUM_WEBVIEW_MAJOR);
        checks.put("expectedProviderPackage", expectedProviderPackage);
        checks.put("expectedProviderVersion", expectedProviderVersion);
        return phase.equals("initial-warning-visible") ? appInfo : close;
    }

    private String expectedWarningMessage() {
        return "YAWF needs Android System WebView version 90 or newer. Selected provider: "
                + expectedProviderPackage + ", version " + expectedProviderVersion
                + ". Open that exact provider's App info and update or enable it. "
                + "Then close and reopen YAWF.";
    }

    private UiObject2 singleNativeButton(String resourceId, String label) {
        BySelector selector = By.res("android", resourceId)
                .pkg(PRODUCT_PACKAGE)
                .text(exactCaseInsensitiveLabel(label))
                .clickable(true)
                .enabled(true);
        List<UiObject2> matches = device.findObjects(selector);
        assertEquals("Expected one exact enabled native button for " + label, 1, matches.size());
        return matches.get(0);
    }

    private void assertNoOtherProductSurface() {
        assertFalse("Unsupported startup exposed a product WebView",
                device.hasObject(By.clazz("android.webkit.WebView").pkg(PRODUCT_PACKAGE)));
        for (String forbidden : new String[] {
                "Enable Android update checks?",
                "Check for Android updates?",
                "Update available",
                "Downloading update",
                "Update ready to install",
                "Welcome to YAWF Stream",
                "How do you want to use YAWF Stream?",
                "Discover",
                "Connect to a server"
        }) {
            assertFalse("Unexpected onboarding, updater, or web content was visible: " + forbidden,
                    device.hasObject(By.text(forbidden).pkg(PRODUCT_PACKAGE))
                            || device.hasObject(By.desc(forbidden).pkg(PRODUCT_PACKAGE)));
        }
    }

    private void waitForExactTextOrDescription(
            String label, String packageName, long timeoutMs, String description) {
        Pattern exact = exactLabel(label);
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 text = device.findObject(By.text(exact).pkg(packageName));
            UiObject2 descriptionNode = device.findObject(By.desc(exact).pkg(packageName));
            if (text != null || descriptionNode != null) return;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
    }

    private UiObject2 waitFor(BySelector selector, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
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
            if (expected.equals(currentPackage())) return;
            SystemClock.sleep(250);
        }
        fail("Expected foreground package was not observed: " + expected);
    }

    private void waitForNotForegroundPackage(String rejected, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            if (!rejected.equals(currentPackage())) return;
            SystemClock.sleep(250);
        }
        fail("Product remained foreground after Close YAWF");
    }

    private String currentPackage() {
        String value = device.getCurrentPackageName();
        return value == null ? "" : value;
    }

    private void assertNoBindingTerms() {
        assertFalse("Refusing to act while a binding legal phrase is visible",
                device.hasObject(By.text(BINDING_TERMS)) || device.hasObject(By.desc(BINDING_TERMS)));
    }

    private static Pattern exactLabel(String label) {
        return Pattern.compile("\\A" + Pattern.quote(label) + "\\z");
    }

    private static Pattern exactCaseInsensitiveLabel(String label) {
        return Pattern.compile(
                "\\A" + Pattern.quote(label) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private static String fixedArgument(
            Bundle arguments, String name, String defaultValue, Pattern allowed) {
        String value = arguments.getString(name, defaultValue);
        assertNotNull("Missing instrumentation argument: " + name, value);
        assertEquals("Instrumentation argument must already be trimmed: " + name,
                value.trim(), value);
        assertTrue("Unsafe instrumentation argument: " + name, allowed.matcher(value).matches());
        return value;
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
        receipt.put("scope", "unsupported-webview-startup-guidance-only");
        receipt.put("finalPhase", phase);
        receipt.put("failure", failure == null ? JSONObject.NULL : safe(failure));
        receipt.put("productPackage", PRODUCT_PACKAGE);
        receipt.put("expectedProviderPackage", expectedProviderPackage);
        receipt.put("expectedProviderVersion", expectedProviderVersion);
        receipt.put("expectedProviderLabel", expectedProviderLabel);
        receipt.put("minimumWebViewMajor", MINIMUM_WEBVIEW_MAJOR);
        receipt.put("persistentUiAutomationSession", true);
        receipt.put("captures", captureIndex);
        receipt.put("phases", new JSONArray(phases));
        receipt.put("checks", new JSONObject(checks));
        receipt.put("startupGuidanceOnly", true);
        receipt.put("playbackTested", false);
        receipt.put("otaTested", false);
        receipt.put("providerInstalledOrUpdated", false);
        receipt.put("taskRemovalClaimed", false);
        receipt.put("hostTaskRemovalCheckRequired", true);
        writeBounded(
                new File(evidenceDir, "instrumentation-webview-compatibility-receipt.json"),
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
