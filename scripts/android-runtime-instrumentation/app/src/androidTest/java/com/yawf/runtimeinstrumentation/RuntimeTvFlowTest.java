package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Persistent, remote-only UI transaction for the signed Android TV package. */
@RunWith(AndroidJUnit4.class)
public final class RuntimeTvFlowTest {
    private static final String PRODUCT_PACKAGE = "com.yawf.stream.tv";
    private static final String PINNED_TV_IME = "com.google.android.inputmethod.latin";
    private static final String HARNESS_SUBDIR = "persistent-tv-flow";
    private static final String FIXTURE_URL = "http://127.0.0.1:4190";
    private static final long UI_WAIT = 60_000;
    private static final long MEDIA_WAIT = 45_000;
    private static final int MAX_CAPTURES = 32;
    private static final Pattern CLOCK = Pattern.compile("(?:(\\d+):)?(\\d{1,2}):(\\d{2})");

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private int captureIndex;

    @Test
    public void signedTvPackageCompletesNativePlaybackTransaction() throws Throwable {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        Bundle arguments = InstrumentationRegistry.getArguments();
        assertEquals("Unexpected evidence subdirectory", HARNESS_SUBDIR,
                arguments.getString("evidenceSubdir", HARNESS_SUBDIR));
        assertEquals("Fixture URL must stay fixed and loopback-only", FIXTURE_URL,
                arguments.getString("fixtureUrl", FIXTURE_URL));
        Context target = instrumentation.getTargetContext();
        evidenceDir = new File(target.getFilesDir(), HARNESS_SUBDIR);
        assertTrue("Could not create internal evidence directory",
                evidenceDir.mkdirs() || evidenceDir.isDirectory());
        String outcome = "failed";
        String failure = null;
        try {
            runFlow();
            outcome = "passed";
        } catch (Throwable caught) {
            failure = caught.getClass().getSimpleName() + ": " + safe(caught.getMessage());
            try { capture("failure"); } catch (Throwable ignored) { }
            throw caught;
        } finally {
            writeActions();
            writeReceipt(outcome, failure);
        }
    }

    private void runFlow() throws Exception {
        launchProduct();
        waitFor(By.text("Connect this TV"), UI_WAIT, "native setup title");
        capture("setup");
        UiObject2 address = waitFor(By.clazz("android.widget.EditText"), UI_WAIT, "server address input");
        address.setText(FIXTURE_URL);
        assertEquals("Server address was not entered through the visible UI", FIXTURE_URL, address.getText());
        checks.put("serverAddressEnteredThroughUi", true);
        dismissVisiblePinnedTvIme();
        focusAndActivate(By.text("Connect"), "Connect", 6);

        waitFor(By.text("YAWF TV native bridge runtime fixture"), UI_WAIT, "fixture heading");
        waitFor(By.text("Play 4:3 HLS fixture"), UI_WAIT, "fixture play control");
        capture("fixture-ready");
        checks.put("normalConnectFlowReachedFixture", true);
        focusAndActivate(By.text("Play 4:3 HLS fixture"), "Play fixture", 10);

        waitFor(By.desc("YAWF Android TV 4:3 runtime fixture"), MEDIA_WAIT, "native PlayerView");
        capture("native-player");
        checks.put("nativePlayerOpened", true);
        long first = waitForPositionAtLeast(2, MEDIA_WAIT);
        String firstFrame = centerFrameHash();
        SystemClock.sleep(2_500);
        long second = readPositionSeconds();
        String secondFrame = centerFrameHash();
        assertTrue("Playback position did not advance", second >= first + 1);
        assertTrue("Decoded center frame did not change while playback advanced",
                !firstFrame.equals(secondFrame));
        checks.put("playingPositionAdvanced", true);
        checks.put("decodedFrameChanged", true);
        capture("playing-advanced");

        revealControls();
        waitFor(playPauseSelector("Pause"), 5_000, "semantic Pause state before pausing");
        focusAndActivate(playPauseSelector("Pause"), "Pause", 14);
        waitFor(playPauseSelector("Play"), 5_000, "semantic Play state after pausing");
        long pausedStart = readPositionSeconds();
        String pausedFrame = centerFrameHash();
        SystemClock.sleep(3_000);
        long pausedEnd = readPositionSeconds();
        String pausedFrameAfter = centerFrameHash();
        assertTrue("Position advanced materially while paused", Math.abs(pausedEnd - pausedStart) <= 1);
        assertEquals("Decoded content changed while paused", pausedFrame, pausedFrameAfter);
        checks.put("pauseStable", true);
        capture("paused");

        revealControls();
        focusTarget(By.res(PRODUCT_PACKAGE, "exo_progress"), "timeline", 18);
        long beforeSeek = readPositionSeconds();
        device.pressDPadRight();
        device.pressDPadRight();
        device.pressDPadRight();
        SystemClock.sleep(1_000);
        long afterSeek = readPositionSeconds();
        assertTrue("D-pad seek did not move by a meaningful delta", afterSeek >= beforeSeek + 10);
        checks.put("seekDeltaSeconds", afterSeek - beforeSeek);
        capture("seeked");

        selectAudioTrack("English");
        checks.put("englishAudioSelected", true);
        capture("audio-english");
        selectAudioTrack("French");
        checks.put("frenchAudioSelected", true);
        capture("audio-french");

        revealControls();
        waitFor(playPauseSelector("Play"), 5_000, "semantic Play state before resuming");
        focusAndActivate(playPauseSelector("Play"), "Resume", 14);
        waitFor(playPauseSelector("Pause"), 5_000, "semantic Pause state after resuming");
        long resumed = waitForPositionAtLeast(afterSeek + 1, MEDIA_WAIT);
        assertTrue("Playback did not resume after track selection", resumed > afterSeek);
        checks.put("resumedAfterTrackSelection", true);

        device.pressBack();
        waitFor(closedStatus(), UI_WAIT, "closed event status");
        UiObject2 webView = waitFor(By.clazz("android.webkit.WebView"), UI_WAIT, "WebView after Back");
        assertTrue("Back did not restore focus to the WebView or one of its descendants",
                webView.isFocused() || webView.findObject(By.focused(true)) != null);
        checks.put("backRestoredWebFocus", true);
        capture("back-to-fixture");

        focusAndActivate(By.text("Play 4:3 HLS fixture"), "second Play fixture", 10);
        waitFor(By.desc("YAWF Android TV 4:3 runtime fixture"), MEDIA_WAIT, "reentered native PlayerView");
        waitForPositionAtLeast(2, MEDIA_WAIT);
        checks.put("nativePlayerReentered", true);
        capture("reentered-player");
        device.pressBack();
        waitFor(closedStatus(), UI_WAIT, "second close event");

        focusAndActivate(By.text("Play missing HLS fixture"), "missing fixture", 12);
        waitFor(By.text("Native playback error received"), MEDIA_WAIT, "native error event");
        checks.put("nativeErrorSurfaced", true);
        capture("error-surfaced");
        focusAndActivate(By.text("Play 4:3 HLS fixture"), "recovery fixture", 12);
        waitFor(By.desc("YAWF Android TV 4:3 runtime fixture"), MEDIA_WAIT, "recovery PlayerView");
        waitForPositionAtLeast(2, MEDIA_WAIT);
        checks.put("playbackRecoveredAfterError", true);
        capture("recovered-player");
        device.pressBack();
        waitFor(closedStatus(), UI_WAIT, "recovery close event");

        device.pressKeyCode(KeyEvent.KEYCODE_MENU);
        waitFor(By.text("Connect this TV"), UI_WAIT, "Menu setup route");
        checks.put("menuOpenedSetupOutsidePlayer", true);
        capture("menu-setup");

        checks.put("sourceAspectRatio", "4:3");
        checks.put("non16By9SourcePlayed", true);
        checks.put("fitSelectorSupported", false);
        checks.put("fitGeometryVerified", false);
        checks.put("fitLimitation", "PlayerView exposes no Fit/Fill/Stretch selector; no geometry pass claimed");
    }

    private void dismissVisiblePinnedTvIme() {
        BySelector imeSelector = By.pkg(PINNED_TV_IME);
        UiObject2 ime = waitFor(imeSelector, UI_WAIT, "visible pinned TV input method");
        assertTrue("Pinned TV input method had empty visible bounds",
                !ime.getVisibleBounds().isEmpty());
        device.pressBack();
        assertTrue("Pinned TV input method did not dismiss after one remote Back",
                device.wait(Until.gone(imeSelector), UI_WAIT));
        log("Dismissed the visible pinned TV input method with one remote Back");
    }

    private void launchProduct() {
        Intent launch = instrumentation.getTargetContext().getPackageManager()
                .getLeanbackLaunchIntentForPackage(PRODUCT_PACKAGE);
        assertNotNull("TV package has no Leanback launch intent", launch);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        instrumentation.getTargetContext().startActivity(launch);
        assertTrue("TV product never became visible",
                device.wait(Until.hasObject(By.pkg(PRODUCT_PACKAGE)), UI_WAIT));
        log("Launched exact TV package through its Leanback launcher activity");
    }

    private BySelector playPauseSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_play_pause");
    }

    private BySelector playPauseSelector(String semanticState) {
        return By.res(PRODUCT_PACKAGE, "exo_play_pause").desc(semanticState);
    }

    private void revealControls() {
        device.pressDPadDown();
        assertTrue("Media3 controls did not become visible",
                device.wait(Until.hasObject(playPauseSelector()), 5_000));
    }

    private void selectAudioTrack(String language) {
        revealControls();
        focusAndActivate(By.res(PRODUCT_PACKAGE, "exo_settings"), "Media3 settings", 18);
        waitFor(By.text("Audio"), 10_000, "Audio settings row");
        focusAndActivate(By.text("Audio"), "Audio settings", 12);
        BySelector english = audioLabel("English");
        BySelector french = audioLabel("French");
        waitFor(english, 10_000, "English audio track");
        waitFor(french, 10_000, "French audio track");
        focusAndActivate(audioLabel(language), language + " audio", 12);
        SystemClock.sleep(1_000);
        log("Selected exact native audio label " + language);
    }

    private BySelector audioLabel(String language) {
        return By.text(Pattern.compile("^" + Pattern.quote(language) + "(?:, Stereo)?$"));
    }

    private BySelector closedStatus() {
        return By.text(Pattern.compile("^Native player closed at [0-9]+(?:\\.[0-9]+)? seconds$"));
    }

    private void focusAndActivate(BySelector selector, String label, int steps) {
        focusTarget(selector, label, steps);
        device.pressDPadCenter();
        log("Activated " + label + " with DPAD_CENTER");
        SystemClock.sleep(350);
    }

    private void focusTarget(BySelector selector, String label, int maxSteps) {
        UiObject2 target = waitFor(selector, UI_WAIT, label);
        UiObject2 activation = activationTarget(target);
        if (activation.isFocused()) return;
        for (int index = 0; index < maxSteps; index++) {
            target = device.findObject(selector);
            activation = target == null ? null : activationTarget(target);
            if (activation != null && activation.isFocused()) {
                log("Focused " + label + " using D-pad navigation");
                return;
            }
            UiObject2 focused = device.findObject(By.focused(true));
            if (activation == null || focused == null) {
                device.pressDPadDown();
            } else {
                Rect targetBounds = activation.getVisibleBounds();
                Rect focusedBounds = focused.getVisibleBounds();
                int horizontal = targetBounds.centerX() - focusedBounds.centerX();
                int vertical = targetBounds.centerY() - focusedBounds.centerY();
                if (Math.abs(vertical) >= Math.abs(horizontal)) {
                    device.pressKeyCode(vertical >= 0
                            ? KeyEvent.KEYCODE_DPAD_DOWN : KeyEvent.KEYCODE_DPAD_UP);
                } else {
                    device.pressKeyCode(horizontal >= 0
                            ? KeyEvent.KEYCODE_DPAD_RIGHT : KeyEvent.KEYCODE_DPAD_LEFT);
                }
            }
            SystemClock.sleep(180);
        }
        target = device.findObject(selector);
        assertNotNull("Target disappeared while focusing: " + label, target);
        activation = activationTarget(target);
        assertTrue("Could not focus target with bounded D-pad navigation: " + label,
                activation.isFocused());
    }

    private UiObject2 activationTarget(UiObject2 labeledNode) {
        UiObject2 current = labeledNode;
        for (int depth = 0; depth < 4 && current != null && !current.isFocusable(); depth++) {
            current = current.getParent();
        }
        assertNotNull("Labeled semantic node had no focusable activation ancestor", current);
        assertTrue("Semantic activation ancestor was not focusable", current.isFocusable());
        return current;
    }

    private UiObject2 waitFor(BySelector selector, long timeout, String label) {
        UiObject2 object = device.wait(Until.findObject(selector), timeout);
        assertNotNull("Timed out waiting for " + label, object);
        return object;
    }

    private long waitForPositionAtLeast(long minimum, long timeout) {
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                long value = readPositionSeconds();
                if (value >= minimum) return value;
            } catch (AssertionError ignored) { }
            SystemClock.sleep(500);
        }
        fail("Playback position did not reach " + minimum + " seconds");
        return -1;
    }

    private long readPositionSeconds() {
        UiObject2 position = waitFor(By.res(PRODUCT_PACKAGE, "exo_position"), 5_000, "Media3 position");
        Matcher matcher = CLOCK.matcher(position.getText() == null ? "" : position.getText());
        assertTrue("Media3 position was not a clock", matcher.find());
        long hours = matcher.group(1) == null ? 0 : Long.parseLong(matcher.group(1));
        return hours * 3600 + Long.parseLong(matcher.group(2)) * 60 + Long.parseLong(matcher.group(3));
    }

    private String centerFrameHash() throws Exception {
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull("UiAutomation screenshot unavailable", image);
        int left = image.getWidth() / 4;
        int top = image.getHeight() / 4;
        int width = image.getWidth() / 2;
        int height = image.getHeight() / 2;
        int[] pixels = new int[width * height];
        image.getPixels(pixels, 0, width, left, top, width, height);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        ByteBuffer bytes = ByteBuffer.allocate(pixels.length * 4);
        for (int pixel : pixels) bytes.putInt(pixel);
        return hex(digest.digest(bytes.array()));
    }

    private void capture(String label) throws Exception {
        assertTrue("Capture count exceeded", captureIndex < MAX_CAPTURES);
        captureIndex++;
        String prefix = String.format(Locale.ROOT, "%02d-%s", captureIndex, label);
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull("Screenshot unavailable", image);
        try (FileOutputStream stream = new FileOutputStream(new File(evidenceDir, prefix + ".png"))) {
            assertTrue("PNG encoding failed", image.compress(Bitmap.CompressFormat.PNG, 100, stream));
        }
        device.dumpWindowHierarchy(new File(evidenceDir, prefix + ".xml"));
        log("Captured " + prefix);
    }

    private void writeActions() throws Exception {
        writeText("actions.txt", String.join("\n", actions) + "\n");
    }

    private void writeReceipt(String outcome, String failure) throws Exception {
        JSONObject receipt = new JSONObject();
        receipt.put("schemaVersion", 1);
        receipt.put("outcome", outcome);
        receipt.put("failure", failure == null ? JSONObject.NULL : failure);
        receipt.put("productPackage", PRODUCT_PACKAGE);
        receipt.put("fixtureUrl", "<loopback-fixture>");
        receipt.put("inputMethod", "semantic UiDevice selectors and D-pad key events");
        receipt.put("nativeBridgeFixture", true);
        receipt.put("productionEmbeddedPlayerRoute", false);
        receipt.put("checks", new JSONObject(checks));
        writeText("instrumentation-tv-receipt.json", receipt.toString(2) + "\n");
    }

    private void writeText(String name, String value) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(new File(evidenceDir, name))) {
            stream.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private void log(String value) {
        actions.add(String.format(Locale.ROOT, "%d %s", SystemClock.uptimeMillis(), safe(value)));
    }

    private static String safe(String value) {
        if (value == null) return "";
        return value.replaceAll("https?://\\S+", "<redacted-url>").replace('\n', ' ').replace('\r', ' ');
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
