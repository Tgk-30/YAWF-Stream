package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Configurator;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Native UiAutomator flow for the product-hosted shared Android touch player. */
@RunWith(AndroidJUnit4.class)
public final class RuntimeTouchPlayerFlowTest {
    private static final String PRODUCT_PACKAGE = "com.tgk30.debridstreamer";
    private static final String PRODUCT_ACTIVITY = PRODUCT_PACKAGE + ".MainActivity";
    private static final String EVIDENCE_SUBDIR = "touch-player-flow";
    private static final String FIXTURE_URL = "http://127.0.0.1:43120";
    private static final String MOVIE_TITLE = "Synthetic Fixture Movie";
    private static final String CONNECT_SERVER_LABEL =
            "Connect to a server Already have a server or an invite link? Paste the address and sign in.";
    private static final String SOURCE_CONTROL_LABEL =
            "1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown";
    private static final String ENGLISH = "English";
    private static final String JAPANESE = "Japanese";
    private static final String USERNAME = "fixture-owner";
    private static final String PASSWORD = "fixture-owner-password";
    private static final long SHORT_WAIT_MS = 15_000;
    private static final long UI_WAIT_MS = 90_000;
    private static final long MEDIA_WAIT_MS = 120_000;
    private static final int MAX_CAPTURES = 28;
    private static final int MAX_ACTION_LINES = 220;
    private static final int MAX_PHASES = 48;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern BINDING_TERMS = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private static final Pattern URL = Pattern.compile("(?i)https?://[^\\s\\\"'<>]+");
    private static final Pattern CAPABILITY = Pattern.compile("(?i)/api/(?:external-)?stream/[^\\s\\\"'<>]+");
    private static final Pattern SENSITIVE = Pattern.compile(
            "(?i)(authorization|cookie|ds_session|ds_csrf|bearer)[^\\s\\\"'<>]*");
    private static final Pattern PLAYBACK_CLOCK = Pattern.compile(
            "(?i).*?(\\d{1,2}):(\\d{2})(?:\\s*(?:of|/)\\s*0:30).*?");

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private final List<String> phases = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private int captureIndex;
    private long startedAtMs;
    private String phase = "not-started";

    @Test
    public void productionHostCompletesSharedTouchPlayerFlow() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        Configurator.getInstance().setWaitForIdleTimeout(0);
        device = UiDevice.getInstance(instrumentation);
        refreshObservation();
        startedAtMs = SystemClock.uptimeMillis();
        Bundle arguments = InstrumentationRegistry.getArguments();
        String subdir = arguments.getString("evidenceSubdir", EVIDENCE_SUBDIR);
        assertTrue("Unsafe evidence subdirectory", SAFE_SUBDIR.matcher(subdir).matches());
        assertEquals("Unexpected evidence subdirectory", EVIDENCE_SUBDIR, subdir);
        evidenceDir = new File(instrumentation.getTargetContext().getFilesDir(), subdir);
        assertTrue("Could not create evidence directory", evidenceDir.mkdirs() || evidenceDir.isDirectory());
        checks.put("nativeUiAutomationOnly", true);
        checks.put("webViewInjectionUsed", false);
        checks.put("privatePreferencesUsed", false);
        checks.put("permissionGrantUsed", false);
        checks.put("syntheticCredentialsOnly", true);
        String outcome = "failed";
        String failure = null;
        try {
            runFlow();
            outcome = "passed";
        } catch (Throwable caught) {
            failure = caught.getClass().getSimpleName() + ": " + safe(caught.getMessage());
            try { capture("failure"); } catch (Throwable ignored) { log("Failure capture unavailable"); }
            throw caught;
        } finally {
            try { device.setOrientationNatural(); } catch (Throwable ignored) { log("Natural orientation cleanup unavailable"); }
            try { device.unfreezeRotation(); } catch (Throwable ignored) { log("Rotation cleanup unavailable"); }
            writeActions();
            writeReceipt(outcome, failure);
        }
    }

    private void runFlow() throws Exception {
        transition("launching-product");
        device.wakeUp();
        device.setOrientationNatural();
        waitForPortrait();
        int initialPortraitWidth = device.getDisplayWidth();
        int initialPortraitHeight = device.getDisplayHeight();
        assertTrue("Natural orientation was not portrait before initial layout",
                initialPortraitHeight > initialPortraitWidth);
        checks.put("initialPortraitWidthPx", initialPortraitWidth);
        checks.put("initialPortraitHeightPx", initialPortraitHeight);
        launchProduct();
        reachFirstRun();
        capture("first-run");

        clickLabeled(CONNECT_SERVER_LABEL, "combined Connect to a server card", UI_WAIT_MS);
        waitFor(By.text("Server address"), UI_WAIT_MS, "Server address label");
        UiObject2 address = singleEditableField("server address", 1, 0);
        address.setText(FIXTURE_URL);
        dismissObservedIme();
        clickLabeled("Open server", "Open server", SHORT_WAIT_MS);
        waitFor(By.text("Sign in"), UI_WAIT_MS, "synthetic server sign-in");
        List<UiObject2> fields = waitForEditableFields(3, UI_WAIT_MS, "server sign-in fields");
        fields.get(0).setText(USERNAME);
        fields.get(1).setText(PASSWORD);
        dismissObservedIme();
        clickLabeled("Sign in", "Sign in", SHORT_WAIT_MS);

        transition("signed-in");
        waitForTextOrDescription("Watchlist", UI_WAIT_MS, "Watchlist navigation");
        dismissOrdinaryTourIfPresent();
        clickLabeled("Watchlist", "Watchlist navigation", UI_WAIT_MS);
        waitFor(By.text("Watchlist"), UI_WAIT_MS, "Watchlist heading");
        guardedClick(waitForLabeledClickable(MOVIE_TITLE, UI_WAIT_MS, "synthetic movie card"), "synthetic movie card");
        waitFor(By.text(MOVIE_TITLE), UI_WAIT_MS, "synthetic movie detail");
        UiObject2 source = scrollUntilLabeledClickable(SOURCE_CONTROL_LABEL, "synthetic source");
        capture("source-visible");
        guardedClick(source, "synthetic source");

        transition("first-decode");
        waitForLabeledClickable("Pause", MEDIA_WAIT_MS, "playing touch-player control");
        int first = waitForPlaybackPositionAtLeast(0, MEDIA_WAIT_MS);
        capture("playing-clock-initial");
        int advanced = waitForPlaybackPositionAtLeast(first + 1, MEDIA_WAIT_MS);
        assertTrue("Playback clock did not advance after the player exposed Pause", advanced > first);
        checks.put("firstDecodeClockAdvanced", true);
        capture("playing-clock-advanced");
        assertCoreLayout("portrait-playing", "Pause");

        transition("central-pause-resume");
        clickLabeled("Pause", "central Pause", SHORT_WAIT_MS);
        waitForLabeledClickable("Play", SHORT_WAIT_MS, "central Play after pause");
        int paused = waitForPlaybackPositionAtLeast(advanced, SHORT_WAIT_MS);
        SystemClock.sleep(1_500);
        assertTrue("Playback advanced while central control reported paused",
                Math.abs(readPlaybackPosition() - paused) <= 1);
        clickLabeled("Play", "central Play", SHORT_WAIT_MS);
        waitForLabeledClickable("Pause", SHORT_WAIT_MS, "central Pause after resume");
        waitForPlaybackPositionAtLeast(paused + 1, MEDIA_WAIT_MS);
        clickLabeled("Pause", "central Pause before seek checks", SHORT_WAIT_MS);
        waitForLabeledClickable("Play", SHORT_WAIT_MS, "paused central Play");
        checks.put("centralPauseResume", true);

        transition("paused-transport-and-scrub");
        int beforeForward = readPlaybackPosition();
        clickLabeled("Forward 10 seconds", "paused Forward 10", SHORT_WAIT_MS);
        int afterForward = waitForPlaybackPositionAtLeast(Math.min(29, beforeForward + 8), MEDIA_WAIT_MS);
        clickLabeled("Back 10 seconds", "paused Back 10", SHORT_WAIT_MS);
        int afterBack = waitForPlaybackPositionAtMost(Math.max(0, afterForward - 8), MEDIA_WAIT_MS);
        assertTrue("Back 10 did not reverse the prior paused seek", afterBack < afterForward);
        assertNotNull("Paused Play control disappeared during transport seeks", findLabeledClickable("Play"));
        checks.put("pausedBackForward", true);

        UiObject2 seek = waitFor(By.clazz("android.widget.SeekBar").pkg(PRODUCT_PACKAGE),
                SHORT_WAIT_MS, "semantic touch scrub slider");
        Rect seekBounds = seek.getVisibleBounds();
        assertTrue("Touch scrub target was narrower than 44 px", seekBounds.width() >= 44);
        int beforeScrub = readPlaybackPosition();
        device.swipe(seekBounds.left + seekBounds.width() / 4, seekBounds.centerY(),
                seekBounds.left + seekBounds.width() * 2 / 3, seekBounds.centerY(), 24);
        int afterScrub = waitForPlaybackPositionAtLeast(Math.max(beforeScrub + 3, 18), MEDIA_WAIT_MS);
        assertTrue("Touch scrub produced no measured forward delta", afterScrub > beforeScrub);
        assertNotNull("Scrub unexpectedly resumed playback", findLabeledClickable("Play"));
        checks.put("touchScrubDeltaSeconds", afterScrub - beforeScrub);
        capture("paused-after-scrub");

        transition("two-track-audio-handoff");
        int preAudioSwitchPosition = readPlaybackPosition();
        assertTrue("Audio switch started at an unbounded or zero absolute clock",
                preAudioSwitchPosition > 0 && preAudioSwitchPosition <= 30);
        checks.put("preAudioSwitchAbsolutePositionSeconds", preAudioSwitchPosition);
        openCurrentAudioSheet("Audio tracks", "Audio track, " + ENGLISH);
        waitForLabeledClickable(ENGLISH, MEDIA_WAIT_MS, "English audio track");
        guardedClick(waitForLabeledClickable(JAPANESE, MEDIA_WAIT_MS, "Japanese audio track"),
                "Japanese audio track");
        // The product remounts the source after an audio choice, which closes this sheet.
        waitForLabeledClickable("Audio track, " + JAPANESE, MEDIA_WAIT_MS,
                "Japanese Audio action after source handoff");
        assertTrue("Audio sheet remained open after source handoff",
                !hasTextOrDescription("Close audio tracks"));
        assertNotNull("Audio handoff changed paused state", findLabeledClickable("Play"));
        int postHandoffPosition = waitForPlaybackPositionAtLeast(
                Math.max(1, preAudioSwitchPosition - 1), MEDIA_WAIT_MS);
        assertTrue("Audio handoff restarted or moved the absolute clock",
                postHandoffPosition > 0 && Math.abs(postHandoffPosition - preAudioSwitchPosition) <= 1);
        checks.put("postHandoffAbsolutePositionSeconds", postHandoffPosition);
        assertAbsoluteThirtySecondTimeline();
        openCurrentAudioSheet("Audio track, " + JAPANESE);
        waitForLabeledClickable(ENGLISH, MEDIA_WAIT_MS, "English audio track after handoff");
        waitForLabeledClickable(JAPANESE, MEDIA_WAIT_MS, "Japanese audio track after handoff");
        capture("japanese-persisted-sheet-reopened");
        clickLabeled("Close audio tracks", "close persisted audio tracks", SHORT_WAIT_MS);
        waitForLabeledClickable("Audio track, " + JAPANESE, MEDIA_WAIT_MS,
                "persisted Japanese Audio action after closing sheet");
        checks.put("twoRealAudioTracksObserved", true);
        checks.put("japaneseSelectionPersistedAfterHandoff", true);

        transition("paused-side-double-tap-after-hls");
        int beforePositioning = readPlaybackPosition();
        clickLabeled("Back 10 seconds", "paused Back 10 before side double tap", SHORT_WAIT_MS);
        int beforeDoubleTap = waitForPlaybackPositionAtMost(beforePositioning - 8, MEDIA_WAIT_MS);
        assertTrue("Back 10 did not place the paused clock in the non-clamped double-tap window",
                beforeDoubleTap >= 8 && beforeDoubleTap <= 12);
        int x = device.getDisplayWidth() * 84 / 100;
        int y = device.getDisplayHeight() * 35 / 100;
        device.click(x, y);
        SystemClock.sleep(180);
        device.click(x, y);
        int afterDoubleTap = waitForPlaybackPositionAtLeast(beforeDoubleTap + 9, MEDIA_WAIT_MS);
        int doubleTapDelta = afterDoubleTap - beforeDoubleTap;
        assertTrue("Side double tap did not seek forward exactly once", doubleTapDelta >= 9);
        assertTrue("Side double tap sought more than one ten-second step", doubleTapDelta <= 11);
        assertNotNull("Side double tap changed paused playback state", findLabeledClickable("Play"));
        checks.put("pausedSideDoubleTapSingleSeek", true);
        checks.put("pausedSideDoubleTapDeltaSeconds", doubleTapDelta);
        capture("after-side-double-tap");

        transition("orientation-round-trip");
        waitForPortrait();
        int portraitWidth = device.getDisplayWidth();
        int portraitHeight = device.getDisplayHeight();
        assertTrue("Pre-rotation display was not portrait", portraitHeight > portraitWidth);
        checks.put("portraitBeforeOrientationWidthPx", portraitWidth);
        checks.put("portraitBeforeOrientationHeightPx", portraitHeight);
        device.setOrientationLeft();
        waitForLandscape();
        int landscapeWidth = device.getDisplayWidth();
        int landscapeHeight = device.getDisplayHeight();
        assertTrue("Rotated display was not landscape", landscapeWidth > landscapeHeight);
        checks.put("landscapeWidthPx", landscapeWidth);
        checks.put("landscapeHeightPx", landscapeHeight);
        assertCoreLayout("landscape", "Play");
        capture("landscape-controls");
        device.setOrientationNatural();
        waitForPortrait();
        int portraitReturnWidth = device.getDisplayWidth();
        int portraitReturnHeight = device.getDisplayHeight();
        assertEquals("Portrait width did not return after rotation", portraitWidth, portraitReturnWidth);
        assertEquals("Portrait height did not return after rotation", portraitHeight, portraitReturnHeight);
        checks.put("portraitReturnWidthPx", portraitReturnWidth);
        checks.put("portraitReturnHeightPx", portraitReturnHeight);
        assertCoreLayout("portrait-return", "Play");
        waitForLabeledClickable("Audio track, " + JAPANESE, SHORT_WAIT_MS,
                "Japanese Audio action after orientation round trip");
        checks.put("portraitLandscapePortrait", true);
        checks.put("audioSelectionPersistedAcrossOrientation", true);
        capture("portrait-return-controls");
        transition("complete");
    }

    private void openCurrentAudioSheet(String... acceptedActionLabels) {
        UiObject2 action = null;
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline && action == null) {
            refreshObservation();
            for (String label : acceptedActionLabels) {
                action = findLabeledClickable(label);
                if (action != null) break;
            }
            if (action == null) SystemClock.sleep(250);
        }
        assertNotNull("No expected current Audio action was exposed", action);
        guardedClick(action, "current Audio action");
        waitForTextOrDescription("Audio tracks", SHORT_WAIT_MS, "Audio tracks dialog");
    }

    private boolean hasTextOrDescription(String label) {
        refreshObservation();
        return device.hasObject(By.text(exactLabel(label)).pkg(PRODUCT_PACKAGE))
                || device.hasObject(By.desc(exactLabel(label)).pkg(PRODUCT_PACKAGE));
    }

    private void assertAbsoluteThirtySecondTimeline() {
        float[] range = readNativeSeekRange();
        assertNotNull("HLS audio handoff removed the native SeekBar range", range);
        assertTrue("HLS audio handoff changed the absolute 30 second timeline",
                range[1] >= 29f && range[1] <= 31f);
        checks.put("absoluteTimelineAfterHlsSeconds", Math.round(range[1]));
        checks.put("normalHlsMetadataReady", true);
    }

    private void assertCoreLayout(String label, String expectedPlayPauseLabel) {
        UiObject2 back = waitForLabeledClickable("Back 10 seconds", SHORT_WAIT_MS, label + " Back 10");
        UiObject2 playPause = waitForLabeledClickable(
                expectedPlayPauseLabel, SHORT_WAIT_MS, label + " " + expectedPlayPauseLabel);
        UiObject2 forward = waitForLabeledClickable("Forward 10 seconds", SHORT_WAIT_MS, label + " Forward 10");
        UiObject2 seek = waitFor(By.clazz("android.widget.SeekBar").pkg(PRODUCT_PACKAGE), SHORT_WAIT_MS, label + " Seek");
        UiObject2 close = waitForLabeledClickable("Close player", SHORT_WAIT_MS, label + " Close");
        for (UiObject2 object : new UiObject2[] { back, playPause, forward, seek, close }) {
            Rect bounds = object.getVisibleBounds();
            assertTrue(label + " control was outside display width", bounds.left >= 0 && bounds.right <= device.getDisplayWidth());
            assertTrue(label + " control was outside display height", bounds.top >= 0 && bounds.bottom <= device.getDisplayHeight());
            assertTrue(label + " control had empty bounds", bounds.width() > 0 && bounds.height() > 0);
        }
        assertTrue(label + " transport controls overlapped", !back.getVisibleBounds().intersect(playPause.getVisibleBounds())
                && !playPause.getVisibleBounds().intersect(forward.getVisibleBounds()));
        log("Verified bounded non-overlapping transport, seek, and close controls: " + label);
    }

    private int waitForPlaybackPositionAtLeast(int minimum, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int last = -1;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            last = readPlaybackPosition();
            if (last >= minimum) return last;
            SystemClock.sleep(250);
        }
        fail("Playback position did not reach " + minimum + "; last=" + last);
        return -1;
    }

    private int waitForPlaybackPositionAtMost(int maximum, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int last = Integer.MAX_VALUE;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            last = readPlaybackPosition();
            if (last <= maximum) return last;
            SystemClock.sleep(250);
        }
        fail("Playback position did not fall to " + maximum + "; last=" + last);
        return -1;
    }

    private int readPlaybackPosition() {
        int rangePosition = readNativeSeekRangePosition();
        if (rangePosition >= 0) return rangePosition;
        List<UiObject2> nodes = new ArrayList<>();
        nodes.addAll(device.findObjects(By.text(PLAYBACK_CLOCK).pkg(PRODUCT_PACKAGE)));
        nodes.addAll(device.findObjects(By.desc(PLAYBACK_CLOCK).pkg(PRODUCT_PACKAGE)));
        int best = -1;
        for (UiObject2 node : nodes) {
            best = Math.max(best, parsePlaybackPosition(node.getText()));
            best = Math.max(best, parsePlaybackPosition(node.getContentDescription()));
        }
        if (best < 0) fail("No bounded 0:30 playback clock was exposed through native accessibility");
        return best;
    }

    private int readNativeSeekRangePosition() {
        float[] range = readNativeSeekRange();
        return range == null ? -1 : Math.round(range[0]);
    }

    private float[] readNativeSeekRange() {
        refreshObservation();
        AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
        if (root == null) return null;
        List<AccessibilityNodeInfo> pending = new ArrayList<>();
        pending.add(root);
        int visited = 0;
        try {
            while (!pending.isEmpty() && visited < 2_048) {
                AccessibilityNodeInfo node = pending.remove(pending.size() - 1);
                visited++;
                try {
                    CharSequence packageName = node.getPackageName();
                    CharSequence className = node.getClassName();
                    CharSequence description = node.getContentDescription();
                    AccessibilityNodeInfo.RangeInfo range = node.getRangeInfo();
                    if (PRODUCT_PACKAGE.contentEquals(packageName)
                            && "android.widget.SeekBar".contentEquals(className)
                            && description != null
                            && description.toString().startsWith("Seek")
                            && range != null
                            && range.getMin() == 0f
                            && range.getMax() >= 29f
                            && range.getMax() <= 31f) {
                        float current = range.getCurrent();
                        return Float.isFinite(current) ? new float[] { current, range.getMax() } : null;
                    }
                    for (int index = 0; index < node.getChildCount(); index++) {
                        AccessibilityNodeInfo child = node.getChild(index);
                        if (child != null) pending.add(child);
                    }
                } finally {
                    if (node != root) node.recycle();
                }
            }
        } finally {
            for (AccessibilityNodeInfo node : pending) node.recycle();
            root.recycle();
        }
        return null;
    }

    private void refreshObservation() {
        instrumentation.getUiAutomation().clearCache();
    }

    static int parsePlaybackPosition(String value) {
        if (value == null) return -1;
        Matcher matcher = PLAYBACK_CLOCK.matcher(value);
        if (!matcher.matches()) return -1;
        int minutes = Integer.parseInt(matcher.group(1));
        int seconds = Integer.parseInt(matcher.group(2));
        if (minutes > 59 || seconds > 59) return -1;
        return minutes * 60 + seconds;
    }

    private void waitForLandscape() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (device.getDisplayWidth() > device.getDisplayHeight()) return;
            SystemClock.sleep(250);
        }
        fail("Emulator did not reach landscape");
    }

    private void waitForPortrait() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (device.getDisplayHeight() > device.getDisplayWidth()) return;
            SystemClock.sleep(250);
        }
        fail("Emulator did not return to portrait");
    }

    private void launchProduct() {
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT_PACKAGE, PRODUCT_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(intent);
        assertTrue("Product package did not become visible",
                device.wait(Until.hasObject(By.pkg(PRODUCT_PACKAGE)), UI_WAIT_MS));
        log("Started the exact immutable production host through its launcher activity");
    }

    private void reachFirstRun() throws Exception {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            if (device.hasObject(By.text("How do you want to use YAWF Stream?"))) return;
            if (device.hasObject(By.text("Enable Android update checks?"))) {
                capture("initial-update-consent");
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
            UiObject2 skip = findLabeledClickable("Skip the tour");
            if (skip == null) skip = findLabeledClickable("Skip tour");
            if (skip != null) { capture("ordinary-tour"); guardedClick(skip, "ordinary tour Skip"); return; }
            SystemClock.sleep(250);
        }
    }

    private void dismissObservedIme() {
        BySelector ime = By.pkg(Pattern.compile(".*inputmethod.*"));
        if (!device.hasObject(ime)) return;
        device.pressBack();
        assertTrue("Observed input method did not dismiss", device.wait(Until.gone(ime), SHORT_WAIT_MS));
    }

    private UiObject2 singleEditableField(String label, int exactCount, int index) {
        List<UiObject2> fields = device.findObjects(By.clazz("android.widget.EditText").pkg(PRODUCT_PACKAGE));
        assertEquals("Unexpected editable field count for " + label, exactCount, fields.size());
        return fields.get(index);
    }

    private List<UiObject2> waitForEditableFields(int minimum, long timeoutMs, String label) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> fields = device.findObjects(By.clazz("android.widget.EditText").pkg(PRODUCT_PACKAGE));
            if (fields.size() >= minimum) return fields;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + label);
        return new ArrayList<>();
    }

    private UiObject2 scrollUntilLabeledClickable(String label, String description) {
        for (int attempt = 0; attempt < 12; attempt++) {
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
        refreshObservation();
        Pattern pattern = exactLabel(label);
        List<UiObject2> candidates = new ArrayList<>();
        collectClickableAncestors(candidates, device.findObjects(By.text(pattern).pkg(PRODUCT_PACKAGE)));
        collectClickableAncestors(candidates, device.findObjects(By.desc(pattern).pkg(PRODUCT_PACKAGE)));
        if (candidates.size() > 1) fail("Ambiguous controls for exact label: " + label);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private void collectClickableAncestors(List<UiObject2> candidates, List<UiObject2> matches) {
        for (UiObject2 match : matches) {
            UiObject2 current = match;
            for (int depth = 0; depth < 6 && current != null; depth++) {
                if (current.isClickable() && current.isEnabled()) break;
                current = current.getParent();
            }
            if (current == null) continue;
            boolean duplicate = false;
            for (UiObject2 existing : candidates) {
                if (existing.getVisibleBounds().equals(current.getVisibleBounds())) duplicate = true;
            }
            if (!duplicate) candidates.add(current);
        }
    }

    private static Pattern exactLabel(String label) {
        return Pattern.compile("\\A" + Pattern.quote(label) + "\\z");
    }

    private static Pattern exactCaseInsensitiveLabel(String label) {
        return Pattern.compile("\\A" + Pattern.quote(label) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private void clickLabeled(String label, String description, long timeoutMs) {
        guardedClick(waitForLabeledClickable(label, timeoutMs, description), description);
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
            refreshObservation();
            UiObject2 object = device.findObject(By.text(exactLabel(label)).pkg(PRODUCT_PACKAGE));
            if (object == null) object = device.findObject(By.desc(exactLabel(label)).pkg(PRODUCT_PACKAGE));
            if (object != null) return object;
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description);
        return null;
    }

    private UiObject2 waitFor(BySelector selector, long timeoutMs, String description) {
        UiObject2 object = device.wait(Until.findObject(selector), timeoutMs);
        assertNotNull("Timed out waiting for " + description, object);
        return object;
    }

    private void assertNoOutOfScopeApproval() {
        if (device.hasObject(By.text(BINDING_TERMS)) || device.hasObject(By.desc(BINDING_TERMS))) {
            fail("Refusing to act while a binding legal phrase is visible");
        }
        String foreground = device.getCurrentPackageName();
        if ("com.android.permissioncontroller".equals(foreground)
                || "com.google.android.permissioncontroller".equals(foreground)
                || "com.android.settings".equals(foreground)
                || "com.google.android.packageinstaller".equals(foreground)
                || "com.android.packageinstaller".equals(foreground)) {
            fail("Refusing to approve an out-of-scope permission, settings, or install surface");
        }
    }

    private void transition(String next) {
        phase = next;
        if (phases.size() >= MAX_PHASES) fail("Phase receipt exceeded bound");
        phases.add(String.format(Locale.ROOT, "%d %s",
                SystemClock.uptimeMillis() - startedAtMs, safe(next)));
        log("Phase: " + next);
    }

    private void capture(String label) throws IOException {
        refreshObservation();
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
        receipt.put("fixture", "exact-multiaudio-real-server-transcoder-proxy");
        receipt.put("persistentUiAutomationSession", true);
        receipt.put("captures", captureIndex);
        receipt.put("phases", new JSONArray(phases));
        receipt.put("checks", new JSONObject(checks));
        receipt.put("evidenceStatus", "provisional");
        receipt.put("decodedPlaybackClaimed", false);
        receipt.put("manualDecodedPlaybackReviewRequired", true);
        receipt.put("manualDecodedPlaybackReviewCaptureLabels",
                new JSONArray().put("playing-clock-initial").put("playing-clock-advanced"));
        receipt.put("decodeBasis", "Automated accessibility clocks and server receipts are provisional; retained before/after PNG pixels require root manual review before any decoded-playback claim");
        writeBounded(new File(evidenceDir, "instrumentation-touch-player-receipt.json"),
                receipt.toString(2) + "\n", 32 * 1024);
    }

    private static void writeBounded(File file, String value, int maxBytes) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) throw new IOException("Evidence text exceeded bound for " + file.getName());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }
}
