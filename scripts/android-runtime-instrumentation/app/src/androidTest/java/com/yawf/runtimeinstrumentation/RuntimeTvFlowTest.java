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
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.Configurator;
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
import java.util.function.BooleanSupplier;
import java.util.function.LongConsumer;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
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
    private static final int MAX_NATIVE_ACTIVATION_DEPTH = 4;
    private static final int MAX_NATIVE_OWNERSHIP_DEPTH = 16;
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
        focusConnectWithFirstDpadDownAndActivate();

        waitFor(By.text("YAWF TV native bridge runtime fixture"), UI_WAIT, "fixture heading");
        waitFor(By.text("Play 4:3 HLS fixture"), UI_WAIT, "fixture play control");
        capture("fixture-ready");
        checks.put("normalConnectFlowReachedFixture", true);
        focusAndActivate(By.text("Play 4:3 HLS fixture"), "Play fixture", 10);

        waitForNativePlayerSurface("native PlayerView");
        capture("native-player");
        checks.put("nativePlayerOpened", true);
        revealControls();
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
        waitForNative(playPauseSelector("Pause"), 5_000, "semantic Pause state before pausing");
        focusNativeAndActivate(playPauseSelector("Pause"), "Pause", 14);
        waitForNative(playPauseSelector("Play"), 5_000, "semantic Play state after pausing");
        long pausedStart = readPositionSeconds();
        String pausedFrame = centerFrameHash("pause-hash-before", pausedStart);
        SystemClock.sleep(3_000);
        long pausedEnd = readPositionSeconds();
        String pausedFrameAfter = centerFrameHash("pause-hash-after", pausedEnd);
        assertTrue("Position advanced materially while paused", Math.abs(pausedEnd - pausedStart) <= 1);
        assertEquals("Decoded content changed while paused", pausedFrame, pausedFrameAfter);
        checks.put("pauseStable", true);
        capture("paused");

        revealControls();
        BySelector timeline = By.res(PRODUCT_PACKAGE, "exo_progress");
        focusNativeTarget(timeline, "timeline", 18);
        long beforeSeek = readPositionSeconds();
        pressNativeFocusedRight(timeline, "timeline");
        pressNativeFocusedRight(timeline, "timeline");
        pressNativeFocusedRight(timeline, "timeline");
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
        waitForNative(playPauseSelector("Play"), 5_000, "semantic Play state before resuming");
        focusNativeAndActivate(playPauseSelector("Play"), "Resume", 14);
        waitForNative(playPauseSelector("Pause"), 5_000, "semantic Pause state after resuming");
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
        waitForNativePlayerSurface("reentered native PlayerView");
        revealControls();
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
        waitForNativePlayerSurface("recovery PlayerView");
        revealControls();
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

    private void focusConnectWithFirstDpadDownAndActivate() {
        waitFor(By.clazz("android.widget.EditText").focused(true), UI_WAIT,
                "focused server address input after IME dismissal");
        BySelector focusedConnect = By.clazz("android.widget.Button")
                .text("Connect")
                .focused(true);
        device.pressDPadDown();
        waitFor(focusedConnect, UI_WAIT, "Connect focused by first D-pad Down");
        device.pressDPadCenter();
        log("Focused Connect with first DPAD_DOWN and activated it with DPAD_CENTER");
        SystemClock.sleep(350);
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

    private BySelector positionTimeBarSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_progress")
                .pkg(PRODUCT_PACKAGE)
                .clazz("android.widget.SeekBar")
                .enabled(true);
    }

    private BySelector nativePlayerSurfaceRootSelector() {
        return By.clazz("android.widget.FrameLayout")
                .pkg(PRODUCT_PACKAGE)
                .clickable(true)
                .enabled(true)
                .focusable(true);
    }

    private BySelector nativePlayerControllerSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_controller")
                .pkg(PRODUCT_PACKAGE)
                .clazz("android.widget.FrameLayout");
    }

    private BySelector nativePlayerStateSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_play_pause")
                .pkg(PRODUCT_PACKAGE)
                .clazz("android.widget.ImageButton")
                .desc(Pattern.compile("^(?:Play|Pause)$"));
    }

    private BySelector nativeContentFrameSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_content_frame")
                .pkg(PRODUCT_PACKAGE)
                .clazz("android.widget.FrameLayout");
    }

    private BySelector nativeVideoSurfaceSelector() {
        return By.clazz("android.view.SurfaceView").pkg(PRODUCT_PACKAGE);
    }

    private BySelector nativeSettingsListSelector() {
        return By.res(PRODUCT_PACKAGE, "exo_settings_listview")
                .pkg(PRODUCT_PACKAGE)
                .clazz(RuntimeTvNativeFocus.SETTINGS_LIST_CLASS)
                .enabled(true);
    }

    private void waitForNativePlayerSurface(String label) {
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT;
        String incomplete = "no exact product-scoped Media3 control surface";
        while (SystemClock.uptimeMillis() < deadline) {
            NativeSurfaceSnapshot snapshot = observeFreshNative(
                    () -> readNativePlayerSurfaceSnapshot(label));
            if (snapshot.complete) {
                log("Observed unique product-scoped Media3 control, content, and video surfaces");
                return;
            }
            incomplete = snapshot.incomplete;
            SystemClock.sleep(100);
        }
        fail("Timed out waiting for " + label + ": " + incomplete);
    }

    private NativeSurfaceSnapshot readNativePlayerSurfaceSnapshot(String label) {
        List<UiObject2> roots = device.findObjects(nativePlayerSurfaceRootSelector());
        int admitted = 0;
        NativeFocusSnapshot admittedFocus = null;
        for (UiObject2 root : roots) {
            RuntimeTvNativeSurface.Candidate candidate = readNativePlayerSurfaceCandidate(root);
            if (RuntimeTvNativeSurface.admits(candidate)) {
                admitted++;
                RuntimeTvNativeFocus.Selection currentFocus =
                        readCurrentNativeFocus(root, 1);
                BoundsSnapshot currentFocusBounds = currentFocus.present
                        ? BoundsSnapshot.from(currentFocus.bounds)
                        : null;
                admittedFocus = NativeFocusSnapshot.present(
                        root.isFocused(),
                        BoundsSnapshot.from(root.getVisibleBounds()),
                        currentFocus.present,
                        currentFocusBounds);
            }
        }
        if (admitted > 1) {
            fail("Multiple exact product-scoped Media3 player surfaces appeared for " + label);
        }
        if (admitted == 1) return NativeSurfaceSnapshot.complete(admittedFocus);
        return NativeSurfaceSnapshot.incomplete(
                "no exact product-scoped Media3 player surface matched a supported control state");
    }

    private RuntimeTvNativeSurface.Candidate readNativePlayerSurfaceCandidate(UiObject2 root) {
        List<UiObject2> controllers = root.findObjects(nativePlayerControllerSelector());
        boolean controllerVisible = false;
        int playPauseCount = 0;
        boolean playPauseClickable = false;
        boolean playPauseEnabled = false;
        boolean playPauseFocusable = false;
        boolean playPauseVisible = false;
        if (controllers.size() == 1) {
            UiObject2 controller = controllers.get(0);
            controllerVisible = !controller.getVisibleBounds().isEmpty();
            List<UiObject2> playPause = controller.findObjects(nativePlayerStateSelector());
            playPauseCount = playPause.size();
            if (playPauseCount == 1) {
                UiObject2 state = playPause.get(0);
                playPauseClickable = state.isClickable();
                playPauseEnabled = state.isEnabled();
                playPauseFocusable = state.isFocusable();
                playPauseVisible = !state.getVisibleBounds().isEmpty();
            }
        }

        List<UiObject2> contentFrames = root.findObjects(nativeContentFrameSelector());
        boolean contentFrameVisible = false;
        int videoSurfaceCount = 0;
        boolean videoSurfaceVisible = false;
        if (contentFrames.size() == 1) {
            UiObject2 contentFrame = contentFrames.get(0);
            contentFrameVisible = !contentFrame.getVisibleBounds().isEmpty();
            List<UiObject2> videoSurfaces = contentFrame.findObjects(
                    nativeVideoSurfaceSelector());
            videoSurfaceCount = videoSurfaces.size();
            if (videoSurfaceCount == 1) {
                videoSurfaceVisible = !videoSurfaces.get(0).getVisibleBounds().isEmpty();
            }
        }

        return new RuntimeTvNativeSurface.Candidate(
                root.getApplicationPackage(),
                root.getClassName(),
                root.getContentDescription(),
                root.isClickable(),
                root.isEnabled(),
                root.isFocusable(),
                !root.getVisibleBounds().isEmpty(),
                controllers.size(),
                controllerVisible,
                playPauseCount,
                playPauseClickable,
                playPauseEnabled,
                playPauseFocusable,
                playPauseVisible,
                contentFrames.size(),
                contentFrameVisible,
                videoSurfaceCount,
                videoSurfaceVisible);
    }

    private void revealControls() {
        NativeSurfaceSnapshot surface = observeFreshNative(
                () -> readNativePlayerSurfaceSnapshot("native PlayerView before control reveal"));
        assertTrue("Native player surface disappeared before control reveal: "
                + surface.incomplete, surface.complete);
        assertNotNull("Native player focus snapshot was missing before control reveal",
                surface.focus);
        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);
        assertTrue("Media3 controls did not become visible",
                waitForNativePresence(playPauseSelector(), 5_000));
    }

    private void selectAudioTrack(String language) {
        revealControls();
        focusNativeAndActivate(By.res(PRODUCT_PACKAGE, "exo_settings"), "Media3 settings", 18);
        waitForNative(By.text("Audio"), 10_000, "Audio settings row");
        focusNativeAndActivate(By.text("Audio"), "Audio settings", 12);
        BySelector english = audioLabel("English");
        BySelector french = audioLabel("French");
        waitForNative(english, 10_000, "English audio track");
        waitForNative(french, 10_000, "French audio track");
        focusNativeAndActivate(audioLabel(language), language + " audio", 12);
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

    private void focusNativeAndActivate(BySelector selector, String label, int steps) {
        NativeFocusSnapshot focused = focusNativeTarget(selector, label, steps);
        assertTrue("Could not focus target with bounded D-pad navigation: " + label,
                focused.activationFocused);
        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_CENTER);
        log("Activated " + label + " with DPAD_CENTER");
        SystemClock.sleep(350);
    }

    private NativeFocusSnapshot focusNativeTarget(
            BySelector selector,
            String label,
            int maxSteps) {
        NativeFocusSnapshot snapshot = waitForNativeFocusSnapshot(selector, UI_WAIT, label);
        if (snapshot.activationFocused) return snapshot;
        for (int index = 0; index < maxSteps; index++) {
            snapshot = observeFreshNative(() -> readNativeFocusSnapshot(selector));
            if (snapshot.activationFocused) {
                log("Focused " + label + " using D-pad navigation");
                return snapshot;
            }
            if (!snapshot.targetPresent || !snapshot.currentFocusPresent) {
                sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);
            } else {
                int keyCode;
                switch (RuntimeTvNativeFocus.direction(
                        snapshot.activationBounds.toNativeFocusBounds(),
                        snapshot.currentFocusBounds.toNativeFocusBounds())) {
                    case DOWN:
                        keyCode = KeyEvent.KEYCODE_DPAD_DOWN;
                        break;
                    case UP:
                        keyCode = KeyEvent.KEYCODE_DPAD_UP;
                        break;
                    case LEFT:
                        keyCode = KeyEvent.KEYCODE_DPAD_LEFT;
                        break;
                    case RIGHT:
                        keyCode = KeyEvent.KEYCODE_DPAD_RIGHT;
                        break;
                    default:
                        throw new AssertionError("Unknown native focus direction");
                }
                sendNativeDpadKey(keyCode);
            }
            SystemClock.sleep(180);
        }
        snapshot = observeFreshNative(() -> readNativeFocusSnapshot(selector));
        assertTrue("Target disappeared while focusing: " + label, snapshot.targetPresent);
        assertTrue("Could not focus target with bounded D-pad navigation: " + label,
                snapshot.activationFocused);
        return snapshot;
    }

    private void pressNativeFocusedRight(BySelector selector, String label) {
        NativeFocusSnapshot snapshot = observeFreshNative(() -> readNativeFocusSnapshot(selector));
        assertTrue("Target disappeared before native key input: " + label,
                snapshot.targetPresent);
        assertTrue("Native target was not focused before key input: " + label,
                snapshot.activationFocused);
        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_RIGHT);
    }

    private void sendNativeDpadKey(int keyCode) {
        RuntimeTvNativeKey.send(instrumentation.getUiAutomation(), keyCode);
    }

    private NativeFocusSnapshot waitForNativeFocusSnapshot(
            BySelector selector,
            long timeout,
            String label) {
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) {
            NativeFocusSnapshot snapshot = observeFreshNative(
                    () -> readNativeFocusSnapshot(selector));
            if (snapshot.targetPresent) return snapshot;
            SystemClock.sleep(100);
        }
        fail("Timed out waiting for " + label);
        return null;
    }

    private NativeFocusSnapshot readNativeFocusSnapshot(BySelector selector) {
        String foregroundPackage = device.getCurrentPackageName();

        List<UiObject2> targets = device.findObjects(selector);
        List<RuntimeTvNativeFocus.TargetNode> targetSnapshots = new ArrayList<>();
        for (UiObject2 target : targets) {
            Rect bounds = target.getVisibleBounds();
            targetSnapshots.add(new RuntimeTvNativeFocus.TargetNode(
                    target.getApplicationPackage(),
                    target.isEnabled(),
                    new RuntimeTvNativeFocus.Bounds(
                            bounds.left, bounds.top, bounds.right, bounds.bottom)));
        }

        List<RuntimeTvNativeFocus.ScopeNode> admittedRootSnapshots = new ArrayList<>();
        List<UiObject2> roots = device.findObjects(nativePlayerSurfaceRootSelector());
        for (UiObject2 root : roots) {
            RuntimeTvNativeSurface.Candidate candidate = readNativePlayerSurfaceCandidate(root);
            if (RuntimeTvNativeSurface.admits(candidate)) {
                Rect bounds = root.getVisibleBounds();
                admittedRootSnapshots.add(RuntimeTvNativeFocus.ScopeNode.playerView(
                        root.getApplicationPackage(),
                        root.isEnabled(),
                        new RuntimeTvNativeFocus.Bounds(
                                bounds.left, bounds.top, bounds.right, bounds.bottom)));
            }
        }

        List<UiObject2> settingsLists = device.findObjects(nativeSettingsListSelector());
        List<RuntimeTvNativeFocus.ScopeNode> settingsListSnapshots = new ArrayList<>();
        for (UiObject2 settingsList : settingsLists) {
            Rect bounds = settingsList.getVisibleBounds();
            settingsListSnapshots.add(RuntimeTvNativeFocus.ScopeNode.settingsList(
                    settingsList.getApplicationPackage(),
                    settingsList.getResourceName(),
                    settingsList.getClassName(),
                    settingsList.isEnabled(),
                    new RuntimeTvNativeFocus.Bounds(
                            bounds.left, bounds.top, bounds.right, bounds.bottom)));
        }

        List<UiObject2> ownershipScopes = new ArrayList<>();
        List<UiObject2> activationTargets = new ArrayList<>();
        List<RuntimeTvNativeFocus.ScopeNode> ownershipSnapshots = new ArrayList<>();
        if (targets.size() == 1) {
            UiObject2 current = targets.get(0);
            UiObject2 activation = null;
            for (int depth = 0;
                    depth < MAX_NATIVE_OWNERSHIP_DEPTH && current != null;
                    depth++) {
                if (depth <= MAX_NATIVE_ACTIVATION_DEPTH
                        && activation == null
                        && current.isFocusable()) {
                    activation = current;
                }
                String resourceName = current.getResourceName();
                if (RuntimeTvNativeFocus.SETTINGS_LIST_RESOURCE.equals(resourceName)) {
                    Rect bounds = current.getVisibleBounds();
                    ownershipScopes.add(current);
                    activationTargets.add(activation);
                    ownershipSnapshots.add(RuntimeTvNativeFocus.ScopeNode.settingsList(
                            current.getApplicationPackage(),
                            resourceName,
                            current.getClassName(),
                            current.isEnabled(),
                            new RuntimeTvNativeFocus.Bounds(
                                    bounds.left, bounds.top, bounds.right, bounds.bottom)));
                    break;
                }
                RuntimeTvNativeSurface.Candidate candidate =
                        readNativePlayerSurfaceCandidate(current);
                if (RuntimeTvNativeSurface.admits(candidate)) {
                    Rect bounds = current.getVisibleBounds();
                    ownershipScopes.add(current);
                    activationTargets.add(activation);
                    ownershipSnapshots.add(RuntimeTvNativeFocus.ScopeNode.playerView(
                            current.getApplicationPackage(),
                            current.isEnabled(),
                            new RuntimeTvNativeFocus.Bounds(
                                    bounds.left, bounds.top, bounds.right, bounds.bottom)));
                    break;
                }
                current = current.getParent();
            }
        }

        RuntimeTvNativeFocus.Ownership ownership = RuntimeTvNativeFocus.selectOwnership(
                foregroundPackage,
                targetSnapshots,
                admittedRootSnapshots,
                settingsListSnapshots,
                ownershipSnapshots);
        if (!ownership.targetPresent) {
            return NativeFocusSnapshot.missingTarget(false, null);
        }
        UiObject2 focusScope = ownershipScopes.get(ownership.ancestorIndex);
        UiObject2 activation = activationTargets.get(ownership.ancestorIndex);
        assertNotNull("Labeled semantic node had no focusable activation ancestor", activation);
        assertTrue("Semantic activation ancestor was not focusable", activation.isFocusable());
        assertEquals("Semantic activation ancestor had the wrong package",
                PRODUCT_PACKAGE, activation.getApplicationPackage());
        boolean activationFocused = activation.isFocused();
        Rect activationRect = activation.getVisibleBounds();
        assertTrue("Semantic activation ancestor had empty bounds", !activationRect.isEmpty());
        BoundsSnapshot activationBounds = BoundsSnapshot.from(activationRect);
        RuntimeTvNativeFocus.Selection currentFocus =
                readTargetOwnedNativeFocus(focusScope, ownership);
        BoundsSnapshot currentFocusBounds = currentFocus.present
                ? BoundsSnapshot.from(currentFocus.bounds)
                : null;
        if (!currentFocus.present) {
            return NativeFocusSnapshot.present(
                    activationFocused, activationBounds, false, null);
        }
        return NativeFocusSnapshot.present(
                activationFocused, activationBounds, true, currentFocusBounds);
    }

    private RuntimeTvNativeFocus.Selection readTargetOwnedNativeFocus(
            UiObject2 focusScope,
            RuntimeTvNativeFocus.Ownership ownership) {
        List<RuntimeTvNativeFocus.FocusedNode> focusedSnapshots = new ArrayList<>();
        List<UiObject2> focusedDescendants = focusScope.findObjects(By.focused(true));
        for (UiObject2 focused : focusedDescendants) {
            Rect bounds = focused.getVisibleBounds();
            focusedSnapshots.add(new RuntimeTvNativeFocus.FocusedNode(
                    ownership.scopeKind,
                    focused.getApplicationPackage(),
                    new RuntimeTvNativeFocus.Bounds(
                            bounds.left, bounds.top, bounds.right, bounds.bottom)));
        }
        return RuntimeTvNativeFocus.selectFocused(ownership, focusedSnapshots);
    }

    private RuntimeTvNativeFocus.Selection readCurrentNativeFocus(
            UiObject2 playerRoot,
            int admittedRootCount) {
        String rootPackage = null;
        List<RuntimeTvNativeFocus.FocusedNode> focusedSnapshots = new ArrayList<>();
        if (playerRoot != null) {
            rootPackage = playerRoot.getApplicationPackage();
            List<UiObject2> focusedDescendants = playerRoot.findObjects(By.focused(true));
            for (UiObject2 focused : focusedDescendants) {
                Rect bounds = focused.getVisibleBounds();
                focusedSnapshots.add(new RuntimeTvNativeFocus.FocusedNode(
                        focused.getApplicationPackage(),
                        new RuntimeTvNativeFocus.Bounds(
                                bounds.left, bounds.top, bounds.right, bounds.bottom)));
            }
        }
        return RuntimeTvNativeFocus.select(
                admittedRootCount, rootPackage, focusedSnapshots);
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

    private void waitForNative(BySelector selector, long timeout, String label) {
        assertTrue("Timed out waiting for " + label,
                waitForNativePresence(selector, timeout));
    }

    private boolean waitForNativePresence(BySelector selector, long timeout) {
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) {
            boolean present = observeFreshNative(() -> device.findObject(selector) != null);
            if (present) return true;
            SystemClock.sleep(100);
        }
        return false;
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
        return observeFreshNative(this::readPositionSecondsSnapshot);
    }

    private long readPositionSecondsSnapshot() {
        List<UiObject2> timeBars = device.findObjects(positionTimeBarSelector());
        return RuntimeTvClock.readUniqueVisibleTimeBar(
                timeBars,
                timeBar -> !timeBar.getVisibleBounds().isEmpty(),
                UiObject2::getContentDescription);
    }

    private <T> T observeFreshNative(Supplier<T> reader) {
        assertTrue("Fresh native accessibility observation requires Android API 34+",
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        Configurator configurator = Configurator.getInstance();
        return observeFreshNative(
                Build.VERSION.SDK_INT,
                configurator::getWaitForIdleTimeout,
                configurator::setWaitForIdleTimeout,
                () -> instrumentation.getUiAutomation().clearCache(),
                reader);
    }

    static <T> T observeFreshNative(
            int apiLevel,
            LongSupplier idleTimeoutReader,
            LongConsumer idleTimeoutWriter,
            BooleanSupplier cacheClearer,
            Supplier<T> reader) {
        return RuntimeTvNativeObservation.readFresh(
                apiLevel,
                idleTimeoutReader,
                idleTimeoutWriter,
                cacheClearer,
                reader);
    }

    private static final class NativeSurfaceSnapshot {
        final boolean complete;
        final String incomplete;
        final NativeFocusSnapshot focus;

        private NativeSurfaceSnapshot(
                boolean complete,
                String incomplete,
                NativeFocusSnapshot focus) {
            this.complete = complete;
            this.incomplete = incomplete;
            this.focus = focus;
        }

        static NativeSurfaceSnapshot complete(NativeFocusSnapshot focus) {
            return new NativeSurfaceSnapshot(true, "", focus);
        }

        static NativeSurfaceSnapshot incomplete(String reason) {
            return new NativeSurfaceSnapshot(false, reason, null);
        }
    }

    private static final class BoundsSnapshot {
        final int left;
        final int top;
        final int right;
        final int bottom;

        private BoundsSnapshot(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        static BoundsSnapshot from(Rect bounds) {
            return new BoundsSnapshot(bounds.left, bounds.top, bounds.right, bounds.bottom);
        }

        static BoundsSnapshot from(RuntimeTvNativeFocus.Bounds bounds) {
            return new BoundsSnapshot(bounds.left, bounds.top, bounds.right, bounds.bottom);
        }

        RuntimeTvNativeFocus.Bounds toNativeFocusBounds() {
            return new RuntimeTvNativeFocus.Bounds(left, top, right, bottom);
        }
    }

    private static final class NativeFocusSnapshot {
        final boolean targetPresent;
        final boolean activationFocused;
        final BoundsSnapshot activationBounds;
        final boolean currentFocusPresent;
        final BoundsSnapshot currentFocusBounds;

        private NativeFocusSnapshot(
                boolean targetPresent,
                boolean activationFocused,
                BoundsSnapshot activationBounds,
                boolean currentFocusPresent,
                BoundsSnapshot currentFocusBounds) {
            this.targetPresent = targetPresent;
            this.activationFocused = activationFocused;
            this.activationBounds = activationBounds;
            this.currentFocusPresent = currentFocusPresent;
            this.currentFocusBounds = currentFocusBounds;
        }

        static NativeFocusSnapshot missingTarget(
                boolean currentFocusPresent,
                BoundsSnapshot currentFocusBounds) {
            return new NativeFocusSnapshot(
                    false, false, null, currentFocusPresent, currentFocusBounds);
        }

        static NativeFocusSnapshot present(
                boolean activationFocused,
                BoundsSnapshot activationBounds,
                boolean currentFocusPresent,
                BoundsSnapshot currentFocusBounds) {
            return new NativeFocusSnapshot(
                    true,
                    activationFocused,
                    activationBounds,
                    currentFocusPresent,
                    currentFocusBounds);
        }
    }

    private String centerFrameHash() throws Exception {
        return centerFrameHash(null, -1);
    }

    private String centerFrameHash(String evidenceLabel, long observedPositionSeconds) throws Exception {
        long screenshotStartedAt = SystemClock.uptimeMillis();
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        long screenshotCompletedAt = SystemClock.uptimeMillis();
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
        String hash = hex(digest.digest(bytes.array()));
        if (evidenceLabel != null) {
            assertTrue("Unexpected frame evidence label",
                    "pause-hash-before".equals(evidenceLabel) || "pause-hash-after".equals(evidenceLabel));
            try (FileOutputStream stream = new FileOutputStream(new File(evidenceDir, evidenceLabel + ".png"))) {
                assertTrue("Frame PNG encoding failed", image.compress(Bitmap.CompressFormat.PNG, 100, stream));
            }
            JSONObject sample = new JSONObject();
            sample.put("screenshotStartedAtUptimeMillis", screenshotStartedAt);
            sample.put("screenshotCompletedAtUptimeMillis", screenshotCompletedAt);
            sample.put("precedingNativePositionSeconds", observedPositionSeconds);
            sample.put("centerArgbSha256", hash);
            sample.put("cropLeft", left);
            sample.put("cropTop", top);
            sample.put("cropWidth", width);
            sample.put("cropHeight", height);
            sample.put("stateObservationScope", "Exact native Play required before first sample; sampler performs no additional UI reads");
            writeText(evidenceLabel + ".json", sample.toString(2) + "\n");
        }
        return hash;
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
