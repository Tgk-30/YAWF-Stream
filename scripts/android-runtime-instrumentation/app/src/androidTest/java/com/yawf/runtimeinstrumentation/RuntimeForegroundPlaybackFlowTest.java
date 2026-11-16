package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Black-box foreground playback observation for the unchanged signed phone APK.
 *
 * <p>The transaction uses only ordinary product UI. Once the read-only player
 * details panel is open, the measured interval performs no input. Screenshots,
 * accessibility reads, and package/ownership checks are passive observations.
 * A passing JUnit result is deliberately not a playback qualification. The
 * companion validator currently marks the Stage 2 sealed server-observer ABI
 * as unintegrated, and full mode remains subject to manual review of the
 * burned-in media clock.</p>
 */
@RunWith(AndroidJUnit4.class)
public final class RuntimeForegroundPlaybackFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    private static final String EVIDENCE_SUBDIR = "foreground-playback-flow";
    private static final String FIXTURE_URL = "http://127.0.0.1:43120";
    private static final String MOVIE_TITLE = "Synthetic Fixture Movie";
    private static final String PLAYER_DIALOG_LABEL = "Playing Synthetic Fixture Movie (2026)";
    private static final String PLAYBACK_SETTINGS_LABEL = "Playback settings";
    private static final String DETAILS_LABEL = "Player details and shortcuts";
    private static final String CONNECT_SERVER_LABEL =
            "Connect to a server Already have a server or an invite link? Paste the address and sign in.";
    private static final String SOURCE_CONTROL_LABEL =
            "1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown";
    private static final String USERNAME = "fixture-owner";
    private static final String PASSWORD = "fixture-owner-password";
    private static final String MKV_FILE = "Synthetic.Fixture.Movie.2026.1080p.WEB-DL.x264.mkv";
    private static final String DIRECT_ENGINE = "Webview direct";
    private static final String HLS_ENGINE = "Webview HLS transcode";

    private static final long SHORT_WAIT_MS = 15_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final long MEDIA_WAIT_MS = 60_000;
    private static final long ADMISSION_WINDOW_MS = 15_000;
    private static final long FULL_WINDOW_MS = 480_000;
    private static final int MAX_ANCHORS = 5;
    private static final int MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern BINDING_TERMS = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private static final Pattern INTEGER = Pattern.compile("\\A[0-9]{1,12}\\z");
    private static final Pattern BUFFER = Pattern.compile("\\A([0-9]{1,6}(?:\\.[0-9])?) s\\z");
    private static final Pattern SAFE_FAILURE_CLASS = Pattern.compile(
            "\\A[A-Za-z_$][A-Za-z0-9_$]{0,79}\\z");
    private static final int MAX_REFUSAL_SITE_FRAMES = 16;

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private String mode;
    private String playbackCase;
    private String presentation;
    private FrameSample normalPreWindow;
    private boolean normalDetailsClosed;
    private boolean normalPlayingControl;
    private long windowMs;
    private long testStartedMs;
    private long windowStartedMs = -1;
    private long windowEndedMs = -1;
    private String phase = "not-started";
    private boolean sourceSelected;
    private boolean qualitySelected;
    private boolean detailsOpened;
    private boolean noInputWindowStarted;
    private final List<JSONObject> anchors = new ArrayList<>();
    private final List<JSONObject> samples = new ArrayList<>();

    @Test
    public void productionApkCompletesForegroundPlaybackObservation() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        testStartedMs = SystemClock.uptimeMillis();
        Bundle arguments = InstrumentationRegistry.getArguments();
        mode = arguments.getString("playbackMode", "admission").trim();
        playbackCase = arguments.getString("playbackCase", "direct").trim();
        presentation = arguments.getString("presentation", "details").trim();
        assertTrue("Unsupported presentation", presentation.equals("details") || presentation.equals("normal-diagnostic") || presentation.equals("passive-normal-diagnostic"));
        assertTrue("Normal diagnostic requires full mode", !presentation.equals("normal-diagnostic") || mode.equals("full"));
        assertTrue("Unsupported playbackMode", mode.equals("admission") || mode.equals("full"));
        assertTrue("Unsupported playbackCase", playbackCase.equals("direct") || playbackCase.equals("hls") || playbackCase.equals("auto-mkv"));
        assertTrue("Auto MKV requires full normal diagnostic", !playbackCase.equals("auto-mkv") || (mode.equals("full") && (presentation.equals("normal-diagnostic") || presentation.equals("passive-normal-diagnostic"))));
        assertTrue("Passive diagnostic requires full auto MKV", !presentation.equals("passive-normal-diagnostic") || (mode.equals("full") && playbackCase.equals("auto-mkv")));
        windowMs = mode.equals("full") ? FULL_WINDOW_MS : ADMISSION_WINDOW_MS;

        String evidenceSubdir = arguments.getString("evidenceSubdir", EVIDENCE_SUBDIR);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(evidenceSubdir).matches());
        assertEquals("Unexpected evidence subdirectory", EVIDENCE_SUBDIR, evidenceSubdir);
        Context target = instrumentation.getTargetContext();
        evidenceDir = new File(target.getFilesDir(), evidenceSubdir);
        assertTrue("Could not create evidence directory",
                evidenceDir.mkdirs() || evidenceDir.isDirectory());

        String outcome = "failed";
        String failureClass = null;
        try {
            runFlow();
            outcome = (presentation.equals("normal-diagnostic") || presentation.equals("passive-normal-diagnostic")) ? "normal-viewing-capture-collected" : "native-window-observed";
        } catch (Throwable caught) {
            failureClass = caught.getClass().getSimpleName();
            sendRefusalDiagnostic(caught);
            throw caught;
        } finally {
            writeReceipt(outcome, failureClass);
        }
    }

    private void sendRefusalDiagnostic(Throwable caught) {
        Bundle diagnostic = new Bundle();
        diagnostic.putString("yawfForegroundRefusalPhase", refusalPhase());
        String simpleName = caught.getClass().getSimpleName();
        diagnostic.putString(
                "yawfForegroundRefusalClass",
                SAFE_FAILURE_CLASS.matcher(simpleName).matches() ? simpleName : "OtherThrowable");
        String site = "unknown";
        int siteLine = 0;
        StackTraceElement[] frames = caught.getStackTrace();
        int frameCount = Math.min(MAX_REFUSAL_SITE_FRAMES, frames.length);
        String flowClass = RuntimeForegroundPlaybackFlowTest.class.getName();
        String settingsClass = RuntimeExternalSettingsTransaction.class.getName();
        for (int index = 0; index < frameCount; index++) {
            StackTraceElement frame = frames[index];
            int line = frame.getLineNumber();
            if (line < 1 || line > 2000) continue;
            if (flowClass.equals(frame.getClassName())) {
                site = "native-flow";
                siteLine = line;
                break;
            }
            if (settingsClass.equals(frame.getClassName())) {
                site = "settings-transaction";
                siteLine = line;
                break;
            }
        }
        diagnostic.putString("yawfForegroundRefusalSite", site);
        diagnostic.putInt("yawfForegroundRefusalLine", siteLine);
        instrumentation.sendStatus(2, diagnostic);
    }

    private String refusalPhase() {
        switch (phase) {
            case "not-started":
            case "launching-product":
            case "server-login":
            case "source-selection":
            case "selecting-480p":
            case "opening-read-only-details":
            case "measured-no-input-window":
            case "native-observation-complete":
                return phase;
            default:
                return "unrecognized";
        }
    }

    private void runPassiveNormalDiagnostic() throws Exception {
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;
        boolean ownedReady = false;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                assertTrue("Accessibility cache refresh failed before passive window", instrumentation.getUiAutomation().clearCache());
                assertPassiveOwnership();
                ownedReady = true;
                break;
            } catch (StaleObjectException stale) {
                // Read-only reacquisition; no input is issued.
            }
            SystemClock.sleep(250);
        }
        assertTrue("Owned player unavailable before passive window", ownedReady);
        phase = "measured-no-input-window";
        noInputWindowStarted = true;
        windowStartedMs = SystemClock.uptimeMillis();
        captureNormalAnchor(1, 0);
        assertTrue("Accessibility cache refresh failed after passive baseline screenshot", instrumentation.getUiAutomation().clearCache());
        assertPassiveOwnership();
        for (int index = 1; index < 5; index++) {
            sleepUntil(windowStartedMs + (FULL_WINDOW_MS * index) / 4);
            assertTrue("Accessibility cache refresh failed during passive observation", instrumentation.getUiAutomation().clearCache());
            assertPassiveOwnership();
            long elapsedMs = SystemClock.uptimeMillis() - windowStartedMs;
            captureNormalAnchor(index + 1, elapsedMs);
            assertTrue("Accessibility cache refresh failed after passive screenshot", instrumentation.getUiAutomation().clearCache());
            assertPassiveOwnership();
        }
        windowEndedMs = SystemClock.uptimeMillis();
        assertTrue("Passive diagnostic window too short", windowEndedMs - windowStartedMs >= FULL_WINDOW_MS);
        phase = "native-observation-complete";
    }

    private void assertPassiveOwnership() {
        assertEquals("Product package lost foreground ownership", PRODUCT_PACKAGE, device.getCurrentPackageName());
        assertNoOutOfScopeApproval();
        assertNull("Details panel remained visible", findUniqueExactProductDialog(DETAILS_LABEL));
        requireUniqueExactProductDialog(PLAYER_DIALOG_LABEL, "player");
    }

    private void runNormalDiagnostic(UiObject2 details, FrameSample readyStats) throws Exception {
        normalPreWindow = readyStats;
        UiObject2 close = findLabeledClickableWithin(details, "Close playback information", "close playback information");
        assertNotNull("Exact details close control unavailable", close);
        assertTrue("Details close control not visible", hasVisibleBounds(close));
        guardedClick(close, "close playback information");
        assertTrue("Accessibility cache refresh failed after closing details", instrumentation.getUiAutomation().clearCache());
        assertNormalOwnership();
        normalDetailsClosed = true;
        UiObject2 player = requireUniqueExactProductDialog(PLAYER_DIALOG_LABEL, "player");
        UiObject2 pause = findLabeledClickableWithin(player, "Pause", "pause control");
        assertNotNull("Visible Pause control unavailable before normal window", pause);
        assertTrue("Pause control was not visible", hasVisibleBounds(pause));
        normalPlayingControl = true;
        phase = "measured-no-input-window";
        noInputWindowStarted = true;
        windowStartedMs = SystemClock.uptimeMillis();
        captureNormalAnchor(1, 0);
        assertTrue("Accessibility cache refresh failed after normal baseline screenshot", instrumentation.getUiAutomation().clearCache());
        assertNormalOwnership();
        for (int index = 1; index < 5; index++) {
            sleepUntil(windowStartedMs + (FULL_WINDOW_MS * index) / 4);
            assertTrue("Accessibility cache refresh failed during normal observation", instrumentation.getUiAutomation().clearCache());
            assertNormalOwnership();
            long elapsedMs = SystemClock.uptimeMillis() - windowStartedMs;
            captureNormalAnchor(index + 1, elapsedMs);
            assertTrue("Accessibility cache refresh failed after normal screenshot", instrumentation.getUiAutomation().clearCache());
            assertNormalOwnership();
        }
        windowEndedMs = SystemClock.uptimeMillis();
        assertTrue("Normal diagnostic window too short", windowEndedMs - windowStartedMs >= FULL_WINDOW_MS);
        phase = "native-observation-complete";
    }

    private void assertNormalOwnership() {
        assertEquals("Product package lost foreground ownership", PRODUCT_PACKAGE, device.getCurrentPackageName());
        assertNoOutOfScopeApproval();
        assertNull("Details panel remained visible", findUniqueExactProductDialog(DETAILS_LABEL));
        UiObject2 player = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);
        assertNotNull("Owned player dialog missing", player);
        assertTrue("Owned player dialog not visible", hasVisibleBounds(player));
        for (UiObject2 play : player.findObjects(By.desc(exactLabel("Play")))) {
            assertTrue("Visible Play control indicates paused playback", !hasVisibleBounds(play));
        }
        for (UiObject2 play : player.findObjects(By.text(exactLabel("Play")))) {
            assertTrue("Visible Play control indicates paused playback", !hasVisibleBounds(play));
        }
    }

    private void captureNormalAnchor(int ordinal, long elapsedMs) throws Exception {
        assertTrue("Normal anchor count exceeded", anchors.size() < MAX_ANCHORS);
        File file = new File(evidenceDir, String.format(Locale.ROOT, "normal-anchor-%02d-%s.png", ordinal, playbackCase));
        assertTrue("Normal anchor screenshot failed", device.takeScreenshot(file));
        assertTrue("Normal anchor screenshot invalid", file.length() > 0 && file.length() <= MAX_SCREENSHOT_BYTES);
        JSONObject anchor = new JSONObject();
        anchor.put("ordinal", ordinal);
        anchor.put("elapsedMs", elapsedMs);
        anchor.put("file", file.getName());
        anchor.put("sha256", sha256(file));
        anchor.put("playerOwned", true);
        anchor.put("detailsAbsent", true);
        anchors.add(anchor);
    }

    private void runFlow() throws Exception {
        phase = "launching-product";
        device.wakeUp();
        launchProduct();
        reachFirstRun();

        clickLabeled(CONNECT_SERVER_LABEL, "Connect to a server card", UI_WAIT_MS);
        waitFor(By.text("Server address"), UI_WAIT_MS, "Server address label");
        UiObject2 address = singleEditableField("server address", 1, 0);
        address.setText(FIXTURE_URL);
        dismissObservedIme();
        clickLabeled("Open server", "Open server", SHORT_WAIT_MS);

        phase = "server-login";
        waitFor(By.text("Sign in"), UI_WAIT_MS, "synthetic server sign-in");
        List<UiObject2> loginFields = waitForEditableFields(3, UI_WAIT_MS, "server sign-in fields");
        loginFields.get(0).setText(USERNAME);
        loginFields.get(1).setText(PASSWORD);
        dismissObservedIme();
        clickLabeled("Sign in", "Sign in", SHORT_WAIT_MS);

        phase = "source-selection";
        waitForTextOrDescription("Watchlist", UI_WAIT_MS, "Watchlist navigation");
        dismissOrdinaryTourIfPresent();
        clickLabeled("Watchlist", "Watchlist navigation", UI_WAIT_MS);
        waitFor(By.text("Watchlist"), UI_WAIT_MS, "Watchlist heading");
        guardedClick(waitForLabeledClickable(MOVIE_TITLE, UI_WAIT_MS, "synthetic movie card"),
                "synthetic movie card");
        waitFor(By.text(MOVIE_TITLE), UI_WAIT_MS, "synthetic movie detail");
        UiObject2 source = scrollUntilLabeledClickable(SOURCE_CONTROL_LABEL, "synthetic source");
        guardedClick(source, "synthetic source");
        sourceSelected = true;
        waitForUniquePlayerDialog(MEDIA_WAIT_MS);
        if (presentation.equals("passive-normal-diagnostic")) {
            runPassiveNormalDiagnostic();
            return;
        }

        if (playbackCase.equals("hls")) {
            phase = "selecting-480p";
            openPlaybackSettingsTransaction();
            UiObject2 quality = scrollPlaybackSettingsUntilLabeledClickable("480p", "480p quality");
            guardedClick(quality, "480p quality");
            qualitySelected = true;
            waitForUniquePlayerDialog(MEDIA_WAIT_MS);
        }

        phase = "opening-read-only-details";
        openDetailsOnce();
        UiObject2 details = waitForUniqueDetailsDialog(SHORT_WAIT_MS);
        String expectedEngine = playbackCase.equals("direct") ? DIRECT_ENGINE : HLS_ENGINE;
        waitForExactTextWithin(details, expectedEngine, MEDIA_WAIT_MS, "expected playback engine");
        if (playbackCase.equals("auto-mkv")) {
            waitForExactMkvFile(MEDIA_WAIT_MS);
            assertTrue("Auto MKV must not select quality manually", !qualitySelected);
        }
        FrameSample readyStats = waitForReadableStats(details, MEDIA_WAIT_MS);
        if (presentation.equals("normal-diagnostic")) {
            details = waitForUniqueDetailsDialog(SHORT_WAIT_MS);
            runNormalDiagnostic(details, readyStats);
            return;
        }

        phase = "measured-no-input-window";
        detailsOpened = true;
        noInputWindowStarted = true;
        int anchorCount = mode.equals("full") ? 5 : 2;

        // Seal the passive owner/stat baseline before the timed interval, then
        // capture its screenshot immediately after starting the clock.
        assertTrue("Accessibility cache refresh failed during baseline observation",
                instrumentation.getUiAutomation().clearCache());
        assertForegroundOwnership();
        details = requireUniqueDetailsDialog();
        FrameSample first = readStats(details);
        windowStartedMs = SystemClock.uptimeMillis();
        appendSample(first, 0);
        captureAnchor(1, 0);

        FrameSample last = first;
        for (int index = 1; index < anchorCount; index++) {
            long targetOffset = (windowMs * index) / (anchorCount - 1);
            sleepUntil(windowStartedMs + targetOffset);
            assertTrue("Accessibility cache refresh failed during passive observation",
                    instrumentation.getUiAutomation().clearCache());
            assertForegroundOwnership();
            details = requireUniqueDetailsDialog();
            FrameSample sample = readStats(details);
            long observedAtMs = SystemClock.uptimeMillis() - windowStartedMs;
            appendSample(sample, observedAtMs);
            captureAnchor(index + 1, observedAtMs);
            last = sample;
        }
        windowEndedMs = SystemClock.uptimeMillis();
        assertTrue("Decoded frame counter moved backwards", last.decodedFrames >= first.decodedFrames);
        long minimumFrameDelta = mode.equals("full") ? 60 : 5;
        assertTrue("Decoded frame counter did not establish playback progress",
                last.decodedFrames - first.decodedFrames >= minimumFrameDelta);
        assertTrue("Measured interval ended before its required real-time duration",
                windowEndedMs - windowStartedMs >= windowMs);
        phase = "native-observation-complete";
    }

    private void launchProduct() {
        assertNoOutOfScopeApproval();
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        assertTrue("Product package did not become visible",
                device.wait(androidx.test.uiautomator.Until.hasObject(By.pkg(PRODUCT_PACKAGE)), UI_WAIT_MS));
    }

    private void reachFirstRun() throws Exception {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            if (device.hasObject(By.text("How do you want to use YAWF Stream?"))) return;
            if (device.hasObject(By.text("Enable Android update checks?"))) {
                UiObject2 notNow = waitFor(
                        By.res("android", "button2").pkg(PRODUCT_PACKAGE)
                                .text(exactCaseInsensitiveLabel("Not now")).clickable(true).enabled(true),
                        SHORT_WAIT_MS, "nonbinding Not now update choice");
                guardedClick(notNow, "nonbinding Not now update choice");
                continue;
            }
            if (device.hasObject(By.text("Welcome to YAWF Stream")) && device.hasObject(By.text("Skip"))) {
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
                guardedClick(skip, "ordinary nonbinding tour Skip");
                return;
            }
            SystemClock.sleep(250);
        }
    }

    private void dismissObservedIme() {
        BySelector inputMethod = By.pkg(Pattern.compile(".*inputmethod.*"));
        if (!device.hasObject(inputMethod)) return;
        device.pressBack();
        assertTrue("Observed input method did not dismiss",
                device.wait(androidx.test.uiautomator.Until.gone(inputMethod), SHORT_WAIT_MS));
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
            List<UiObject2> fields = device.findObjects(By.clazz("android.widget.EditText").pkg(PRODUCT_PACKAGE));
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
            UiObject2 scrollable = device.findObject(By.scrollable(true).pkg(PRODUCT_PACKAGE));
            assertNotNull("No semantic scrollable container while seeking " + description, scrollable);
            scrollable.scroll(Direction.DOWN, 0.70f);
            SystemClock.sleep(500);
        }
        fail("Could not scroll to " + description);
        return null;
    }

    private void openPlaybackSettingsTransaction() {
        RuntimeExternalSettingsTransaction.open(
                new RuntimeExternalSettingsTransaction.Environment() {
                    @Override public boolean clearAccessibilityCache() {
                        return instrumentation.getUiAutomation().clearCache();
                    }
                    @Override public void assertNoOutOfScopeApproval() {
                        RuntimeForegroundPlaybackFlowTest.this.assertNoOutOfScopeApproval();
                    }
                    @Override public RuntimeExternalSettingsTransaction.Observation observePlaybackSettings() {
                        UiObject2 player = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);
                        if (player == null || !hasVisibleBounds(player)) {
                            return RuntimeExternalSettingsTransaction.Observation.waiting();
                        }
                        UiObject2 settings = findLabeledClickableWithin(
                                player, PLAYBACK_SETTINGS_LABEL, PLAYBACK_SETTINGS_LABEL);
                        if (settings != null && hasVisibleBounds(settings)) {
                            return RuntimeExternalSettingsTransaction.Observation.settings(settings::click);
                        }
                        return RuntimeExternalSettingsTransaction.Observation.waiting();
                    }
                    @Override public void recordTiming(String stage, long startedAtMs,
                            long finishedAtMs, long idleBeforeMs, long idleAfterMs, boolean returned) { }
                    @Override public void recordSettingsClickTiming(long dispatchedAtMs,
                            long finishedAtMs, long idleBeforeMs, long idleAfterMs, boolean returned) { }
                    @Override public void log(String message) { }
                },
                MEDIA_WAIT_MS);
    }

    private UiObject2 scrollPlaybackSettingsUntilLabeledClickable(String label, String description) {
        for (int attempt = 0; attempt < 12; attempt++) {
            assertTrue("Accessibility cache refresh failed", instrumentation.getUiAutomation().clearCache());
            assertNoOutOfScopeApproval();
            UiObject2 dialog = requireUniqueExactProductDialog(PLAYBACK_SETTINGS_LABEL, "Playback settings dialog");
            UiObject2 found = findLabeledClickableWithin(dialog, label, description);
            if (found != null && hasVisibleBounds(found)) return found;
            List<UiObject2> scrollables = dialog.findObjects(By.scrollable(true).pkg(PRODUCT_PACKAGE));
            assertEquals("Expected one Playback settings scrollable", 1, scrollables.size());
            scrollables.get(0).scroll(Direction.DOWN, 0.70f);
            SystemClock.sleep(500);
        }
        fail("Could not scroll Playback settings to " + description);
        return null;
    }

    private void openDetailsOnce() {
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 details;
            try {
                assertTrue("Accessibility cache refresh failed while opening player details",
                    instrumentation.getUiAutomation().clearCache());
                assertNoOutOfScopeApproval();
                assertEquals("Product package lost foreground ownership while opening player details",
                    PRODUCT_PACKAGE, device.getCurrentPackageName());
                UiObject2 player = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);
                if (player == null || !hasVisibleBounds(player)) {
                    SystemClock.sleep(250);
                    continue;
                }
                details = findLabeledClickableWithin(player, DETAILS_LABEL, DETAILS_LABEL);
                if (!(details != null && hasVisibleBounds(details) && details.isEnabled())) {
                    SystemClock.sleep(250);
                    continue;
                }
                assertTrue("Input attempted after measured no-input window began", !noInputWindowStarted);
                assertNoOutOfScopeApproval();
                assertNotNull("read-only player details disappeared", details);
                assertTrue("read-only player details was disabled", details.isEnabled());
            } catch (StaleObjectException stale) {
                // No input has been attempted. Refresh and reacquire on the next iteration.
                SystemClock.sleep(250);
                continue;
            }
            // A click can have uncertain delivery. Never retry after attempting it.
            details.click();
            SystemClock.sleep(500);
            return;
        }
        fail("Timed out opening read-only player details");
    }

    private UiObject2 waitForUniquePlayerDialog(long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 dialog = findUniqueExactProductDialog(PLAYER_DIALOG_LABEL);
            if (dialog != null && hasVisibleBounds(dialog)) return dialog;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for the unique player dialog");
        return null;
    }

    private UiObject2 waitForUniqueDetailsDialog(long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertTrue("Accessibility cache refresh failed while waiting for player details",
                    instrumentation.getUiAutomation().clearCache());
            assertNoOutOfScopeApproval();
            assertEquals("Product package lost foreground ownership while waiting for player details",
                    PRODUCT_PACKAGE, device.getCurrentPackageName());
            UiObject2 dialog = findUniqueExactProductDialog(DETAILS_LABEL);
            if (dialog != null && hasVisibleBounds(dialog)) return dialog;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for the unique read-only details dialog");
        return null;
    }

    private UiObject2 requireUniqueDetailsDialog() {
        UiObject2 dialog = findUniqueExactProductDialog(DETAILS_LABEL);
        assertNotNull("Read-only player details closed during the no-input window", dialog);
        assertTrue("Read-only player details lost visible bounds", hasVisibleBounds(dialog));
        return dialog;
    }

    private void waitForExactTextWithin(UiObject2 boundary, String value, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> matches = boundary.findObjects(By.text(exactLabel(value)));
            if (matches.size() == 1 && hasVisibleBounds(matches.get(0))) return;
            if (matches.size() > 1) fail("Ambiguous text for " + description);
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
    }

    private void waitForExactMkvFile(long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                assertTrue("Accessibility cache refresh failed while reading MKV file", instrumentation.getUiAutomation().clearCache());
                assertNoOutOfScopeApproval();
                assertEquals("Product package lost foreground ownership while reading MKV file", PRODUCT_PACKAGE, device.getCurrentPackageName());
                UiObject2 details = requireUniqueDetailsDialog();
                assertEquals("Expected selected MKV file in player details", MKV_FILE,
                        readDefinitionValue(details, "File", exactLabel(MKV_FILE)));
                return;
            } catch (StaleObjectException stale) {
                // Retry only a retired accessibility node, never a semantic refusal.
            }
            SystemClock.sleep(250);
        }
        fail("Timed out reading exact MKV file from player details");
    }

    private FrameSample waitForReadableStats(UiObject2 details, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        AssertionError last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                assertTrue("Accessibility cache refresh failed while waiting for statistics",
                        instrumentation.getUiAutomation().clearCache());
                details = requireUniqueDetailsDialog();
                FrameSample sample = readStats(details);
                if (sample.decodedFrames > 0) return sample;
            } catch (AssertionError caught) {
                last = caught;
            } catch (StaleObjectException stale) {
                // The next iteration refreshes the cache and reacquires the dialog.
            }
            SystemClock.sleep(500);
        }
        if (last != null) throw last;
        fail("Timed out waiting for visible decoded-frame and buffer-health statistics");
        return null;
    }

    private FrameSample readStats(UiObject2 details) {
        String decoded = readDefinitionValue(details, "Decoded frames", INTEGER);
        String buffer = readDefinitionValue(details, "Buffer health", BUFFER);
        Matcher bufferMatcher = BUFFER.matcher(buffer);
        assertTrue("Visible buffer-health value was malformed", bufferMatcher.matches());
        return new FrameSample(Long.parseLong(decoded), Double.parseDouble(bufferMatcher.group(1)));
    }

    private String readDefinitionValue(UiObject2 details, String label, Pattern valuePattern) {
        List<UiObject2> labels = details.findObjects(By.text(exactLabel(label)));
        assertEquals("Expected one visible details label for " + label, 1, labels.size());
        UiObject2 parent = labels.get(0).getParent();
        assertNotNull("Details label had no accessibility parent for " + label, parent);
        List<String> values = new ArrayList<>();
        for (UiObject2 child : parent.getChildren()) {
            String text = child.getText();
            if (text != null && valuePattern.matcher(text).matches()) values.add(text);
        }
        if (values.size() == 1) return values.get(0);

        // WebView accessibility may flatten a CSS display:contents wrapper.
        // In that representation, retain DOM accessibility order and accept
        // only the first adjacent value before any later definition label.
        List<UiObject2> ordered = new ArrayList<>();
        collectBoundedDescendants(details, ordered, 0);
        int labelIndex = -1;
        for (int index = 0; index < ordered.size(); index++) {
            if (label.equals(ordered.get(index).getText())) {
                assertEquals("Details label appeared twice in accessibility order", -1, labelIndex);
                labelIndex = index;
            }
        }
        assertTrue("Details label was absent from accessibility order", labelIndex >= 0);
        for (int index = labelIndex + 1; index < ordered.size() && index <= labelIndex + 3; index++) {
            String text = ordered.get(index).getText();
            if (text != null && valuePattern.matcher(text).matches()) return text;
        }
        fail("Expected one visible value paired with " + label);
        return "";
    }

    private void collectBoundedDescendants(UiObject2 node, List<UiObject2> output, int depth) {
        assertTrue("Player details accessibility tree exceeded depth bound", depth <= 12);
        assertTrue("Player details accessibility tree exceeded node bound", output.size() <= 256);
        output.add(node);
        for (UiObject2 child : node.getChildren()) {
            collectBoundedDescendants(child, output, depth + 1);
        }
    }

    private void appendSample(FrameSample sample, long elapsedMs) throws Exception {
        assertTrue("Sample count exceeded anchor bound", samples.size() < MAX_ANCHORS);
        JSONObject value = new JSONObject();
        value.put("elapsedMs", elapsedMs);
        value.put("decodedFrames", sample.decodedFrames);
        value.put("bufferHealthSeconds", sample.bufferHealthSeconds);
        value.put("playerOwned", true);
        value.put("detailsVisible", true);
        samples.add(value);
    }

    private void captureAnchor(int ordinal, long elapsedMs) throws Exception {
        assertTrue("Anchor count exceeded", anchors.size() < MAX_ANCHORS);
        File file = new File(evidenceDir, String.format(Locale.ROOT,
                "anchor-%02d-%s-%s.png", ordinal, mode, playbackCase));
        assertTrue("Passive anchor screenshot failed", device.takeScreenshot(file));
        assertTrue("Passive anchor screenshot was empty", file.length() > 0);
        assertTrue("Passive anchor screenshot exceeded bound", file.length() <= MAX_SCREENSHOT_BYTES);
        JSONObject anchor = new JSONObject();
        anchor.put("ordinal", ordinal);
        anchor.put("elapsedMs", elapsedMs);
        anchor.put("file", file.getName());
        anchor.put("sha256", sha256(file));
        anchors.add(anchor);
    }

    private void assertForegroundOwnership() {
        assertEquals("Product package lost foreground ownership during measured window",
                PRODUCT_PACKAGE, device.getCurrentPackageName());
        assertNoOutOfScopeApproval();
        UiObject2 details = requireUniqueDetailsDialog();
        String expectedEngine = playbackCase.equals("hls") ? HLS_ENGINE : DIRECT_ENGINE;
        List<UiObject2> engines = details.findObjects(By.text(exactLabel(expectedEngine)));
        assertEquals("Owned player engine identity changed during measured window", 1, engines.size());
        assertTrue("Owned player engine identity lost visible bounds", hasVisibleBounds(engines.get(0)));
    }

    private void sleepUntil(long targetMs) {
        while (true) {
            long remaining = targetMs - SystemClock.uptimeMillis();
            if (remaining <= 0) return;
            SystemClock.sleep(Math.min(remaining, 1_000));
        }
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
        Pattern pattern = exactLabel(label);
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestors(candidates, device.findObjects(By.text(pattern)));
        collectClickableAncestors(candidates, device.findObjects(By.desc(pattern)));
        if (candidates.size() > 1) fail("Ambiguous enabled clickable exact label: " + label);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findLabeledClickableWithin(UiObject2 boundary, String label, String description) {
        Pattern pattern = exactLabel(label);
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestorsWithin(candidates, boundary.findObjects(By.text(pattern)), boundary);
        collectClickableAncestorsWithin(candidates, boundary.findObjects(By.desc(pattern)), boundary);
        if (candidates.size() > 1) fail("Ambiguous enabled control inside dialog: " + description);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private void collectClickableAncestors(List<UiObject2> candidates, List<UiObject2> matches) {
        for (UiObject2 match : matches) addUnique(candidates, clickableAncestor(match, null));
    }

    private void collectClickableAncestorsWithin(
            List<UiObject2> candidates, List<UiObject2> matches, UiObject2 boundary) {
        for (UiObject2 match : matches) addUnique(candidates, clickableAncestor(match, boundary));
    }

    private UiObject2 clickableAncestor(UiObject2 object, UiObject2 boundary) {
        UiObject2 current = object;
        for (int depth = 0; depth < 6 && current != null; depth++) {
            if (boundary != null && sameSemanticNode(current, boundary)) return null;
            if (current.isClickable() && current.isEnabled()) return current;
            current = current.getParent();
        }
        return null;
    }

    private void addUnique(List<UiObject2> candidates, UiObject2 candidate) {
        if (candidate == null) return;
        for (UiObject2 existing : candidates) {
            if (sameSemanticNode(existing, candidate)) return;
        }
        candidates.add(candidate);
    }

    private boolean sameSemanticNode(UiObject2 left, UiObject2 right) {
        return left.getVisibleBounds().equals(right.getVisibleBounds())
                && sameNullable(left.getClassName(), right.getClassName())
                && sameNullable(left.getApplicationPackage(), right.getApplicationPackage())
                && sameNullable(left.getText(), right.getText())
                && sameNullable(left.getContentDescription(), right.getContentDescription());
    }

    private static boolean sameNullable(Object left, Object right) {
        return left == null ? right == null : left.equals(right);
    }

    private UiObject2 findUniqueExactProductDialog(String label) {
        List<UiObject2> dialogs = device.findObjects(
                By.clazz("android.app.Dialog").pkg(PRODUCT_PACKAGE).text(exactLabel(label)));
        if (dialogs.size() > 1) fail("Ambiguous product dialogs for exact label: " + label);
        return dialogs.isEmpty() ? null : dialogs.get(0);
    }

    private UiObject2 requireUniqueExactProductDialog(String label, String description) {
        UiObject2 dialog = findUniqueExactProductDialog(label);
        assertNotNull("Missing exact product-owned " + description, dialog);
        assertTrue(description + " had no visible bounds", hasVisibleBounds(dialog));
        return dialog;
    }

    private boolean hasVisibleBounds(UiObject2 object) {
        Rect bounds = object.getVisibleBounds();
        return bounds.width() > 0 && bounds.height() > 0;
    }

    private void clickLabeled(String label, String description, long timeoutMs) {
        guardedClick(waitForLabeledClickable(label, timeoutMs, description), description);
    }

    private void guardedClick(UiObject2 object, String description) {
        assertTrue("Input attempted after measured no-input window began", !noInputWindowStarted);
        assertNoOutOfScopeApproval();
        assertNotNull(description + " disappeared", object);
        assertTrue(description + " was disabled", object.isEnabled());
        object.click();
        SystemClock.sleep(500);
    }

    private UiObject2 waitForTextOrDescription(String label, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 object = device.findObject(By.text(exactLabel(label)));
            if (object == null) object = device.findObject(By.desc(exactLabel(label)));
            if (object != null) return object;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
        return null;
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

    private void assertNoOutOfScopeApproval() {
        if (device.findObject(By.text(BINDING_TERMS)) != null
                || device.findObject(By.desc(BINDING_TERMS)) != null) {
            fail("Refusing to act while a binding legal phrase is visible");
        }
        String foreground = device.getCurrentPackageName();
        if (foreground == null) foreground = "";
        if (foreground.equals("com.android.permissioncontroller")
                || foreground.equals("com.google.android.permissioncontroller")
                || foreground.equals("com.android.settings")
                || foreground.equals("com.google.android.packageinstaller")
                || foreground.equals("com.android.packageinstaller")) {
            fail("Refusing an out-of-scope permission, settings, or install surface");
        }
    }

    private static Pattern exactLabel(String value) {
        return Pattern.compile("\\A" + Pattern.quote(value) + "\\z");
    }

    private static Pattern exactCaseInsensitiveLabel(String value) {
        return Pattern.compile("\\A" + Pattern.quote(value) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            for (int count; (count = input.read(buffer)) >= 0; ) {
                if (count > 0) digest.update(buffer, 0, count);
            }
        }
        StringBuilder value = new StringBuilder();
        for (byte part : digest.digest()) value.append(String.format(Locale.ROOT, "%02x", part & 0xff));
        return value.toString();
    }

    private void writeReceipt(String outcome, String failureClass) throws Exception {
        if ("passive-normal-diagnostic".equals(presentation)) {
            JSONObject passive = new JSONObject();
            passive.put("schemaVersion", 1);
            passive.put("scope", "android-passive-normal-viewing-diagnostic-only");
            passive.put("outcome", outcome);
            passive.put("playbackCase", playbackCase);
            passive.put("evidence", "owned-player-only");
            passive.put("engineVerified", false);
            passive.put("fileVerified", false);
            passive.put("decodedFrameBaselineVerified", false);
            passive.put("windowRequiredMs", FULL_WINDOW_MS);
            passive.put("windowObservedMs", windowStartedMs >= 0 && windowEndedMs >= windowStartedMs ? windowEndedMs - windowStartedMs : 0);
            passive.put("preWindowPlayingControlVerified", false);
            passive.put("windowStartUptimeMs", windowStartedMs);
            passive.put("noInputDuringWindow", noInputWindowStarted);
            passive.put("hostedAdmission", false);
            passive.put("fullQualification", false);
            passive.put("productionCauseEstablished", false);
            passive.put("observerAbiIntegrated", false);
            passive.put("manualBurnedClockReviewRequired", true);
            passive.put("anchors", new JSONArray(anchors));
            writeBounded(new File(evidenceDir, "instrumentation-normal-diagnostic-receipt.json"), passive.toString(2) + "\n", 64 * 1024);
            return;
        }
        if ("normal-diagnostic".equals(presentation)) {
            JSONObject normal = new JSONObject();
            normal.put("schemaVersion", 1);
            normal.put("scope", "android-normal-viewing-diagnostic-only");
            normal.put("outcome", outcome);
            normal.put("playbackCase", playbackCase);
            normal.put("windowRequiredMs", FULL_WINDOW_MS);
            normal.put("windowObservedMs", windowStartedMs >= 0 && windowEndedMs >= windowStartedMs ? windowEndedMs - windowStartedMs : 0);
            normal.put("preWindowEngine", playbackCase.equals("direct") ? DIRECT_ENGINE : HLS_ENGINE);
            if (playbackCase.equals("auto-mkv")) {
                normal.put("preWindowFile", MKV_FILE);
                normal.put("manualQualitySelected", qualitySelected);
            }
            normal.put("preWindowDecodedFrames", normalPreWindow == null ? JSONObject.NULL : normalPreWindow.decodedFrames);
            normal.put("detailsClosedBeforeWindow", normalDetailsClosed);
            normal.put("preWindowPlayingControlVerified", normalPlayingControl);
            normal.put("windowStartUptimeMs", windowStartedMs);
            normal.put("noInputDuringWindow", noInputWindowStarted);
            normal.put("hostedAdmission", false);
            normal.put("fullQualification", false);
            normal.put("productionCauseEstablished", false);
            normal.put("observerAbiIntegrated", false);
            normal.put("manualBurnedClockReviewRequired", true);
            normal.put("anchors", new JSONArray(anchors));
            writeBounded(new File(evidenceDir, "instrumentation-normal-diagnostic-receipt.json"), normal.toString(2) + "\n", 64 * 1024);
            return;
        }
        JSONObject receipt = new JSONObject();
        receipt.put("schemaVersion", 1);
        receipt.put("scope", "ordinary-android-phone-foreground-playback");
        receipt.put("outcome", outcome);
        receipt.put("failureClass", failureClass == null ? JSONObject.NULL : failureClass);
        receipt.put("finalPhase", phase);
        receipt.put("mode", mode == null ? JSONObject.NULL : mode);
        receipt.put("playbackCase", playbackCase == null ? JSONObject.NULL : playbackCase);
        receipt.put("productPackage", PRODUCT_PACKAGE);
        receipt.put("fixture", "bounded-loopback-server-mode");
        receipt.put("windowRequiredMs", windowMs);
        receipt.put("windowObservedMs",
                windowStartedMs >= 0 && windowEndedMs >= windowStartedMs
                        ? windowEndedMs - windowStartedMs : 0);
        receipt.put("testObservedMs", SystemClock.uptimeMillis() - testStartedMs);
        receipt.put("sourceSelectedThroughOrdinaryUi", sourceSelected);
        receipt.put("quality480SelectedThroughOrdinaryUi", qualitySelected);
        receipt.put("readOnlyDetailsOpenedBeforeWindow", detailsOpened);
        receipt.put("noPlaybackStateInputDuringWindow", noInputWindowStarted);
        receipt.put("externalPlayerUsed", false);
        receipt.put("instrumentationWebViewAccessUsed", false);
        receipt.put("serverPassiveObserverUsed", true);
        receipt.put("privateStateRead", false);
        receipt.put("stage2ObserverAbiIntegrated", false);
        receipt.put("manualBurnedClockReviewRequired", true);
        receipt.put("fullQualification", false);
        receipt.put("anchors", new JSONArray(anchors));
        receipt.put("samples", new JSONArray(samples));
        writeBounded(new File(evidenceDir, "instrumentation-foreground-playback-receipt.json"),
                receipt.toString(2) + "\n", 64 * 1024);
    }

    private static void writeBounded(File file, String value, int maxBytes) throws Exception {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) throw new IllegalStateException("Evidence receipt exceeded bound");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
        }
    }

    private static final class FrameSample {
        final long decodedFrames;
        final double bufferHealthSeconds;

        FrameSample(long decodedFrames, double bufferHealthSeconds) {
            this.decodedFrames = decodedFrames;
            this.bufferHealthSeconds = bufferHealthSeconds;
        }
    }
}
