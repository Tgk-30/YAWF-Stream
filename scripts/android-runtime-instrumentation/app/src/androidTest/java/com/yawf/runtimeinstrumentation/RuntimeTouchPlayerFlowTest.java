package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

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
    private static final String PLAYER_DIALOG_TITLE = "Playing Synthetic Fixture Movie (2026)";
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
    private static final int MAX_NATIVE_POLL_SNAPSHOTS = 72;
    private static final int MAX_AX_DISPLAYS = 8;
    private static final int MAX_AX_WINDOWS = 64;
    private static final int MAX_AX_ROOTS = 64;
    private static final int MAX_AX_TOTAL_NODES = 2_048;
    private static final int MAX_SURFACE_REVEALS = 1;
    private static final long MIN_SETTLED_GEOMETRY_GAP_MS = 500;
    private static final long DOUBLE_TAP_HOLD_MS = 40;
    private static final long DOUBLE_TAP_INTER_GAP_MS = 100;
    private static final long DOUBLE_TAP_MAX_UP_TO_UP_MS = 320;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024L * 1024L;
    private static final long MAX_HIERARCHY_BYTES = 1024L * 1024L;
    private static final Pattern SAFE_SUBDIR = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final Pattern BINDING_TERMS = Pattern.compile(
            "(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private static final Pattern URL = Pattern.compile("(?i)https?://[^\\s\\\"'<>]+");
    private static final Pattern CAPABILITY = Pattern.compile("(?i)/api/(?:external-)?stream/[^\\s\\\"'<>]+");
    private static final Pattern SENSITIVE = Pattern.compile(
            "(?i)(authorization|cookie|ds_session|ds_csrf|bearer)[^\\s\\\"'<>]*");
    private static final Pattern SEEK_VALUE_ONLY = Pattern.compile(
            "^(\\d{1,2}):(\\d{2}) of (\\d{1,2}):(\\d{2})$");
    private static final Pattern SEEK_VALUE_WITH_NAME = Pattern.compile(
            "^(\\d{1,2}):(\\d{2}) of (\\d{1,2}):(\\d{2}), Seek$");

    private Instrumentation instrumentation;
    private UiDevice device;
    private File evidenceDir;
    private final List<String> actions = new ArrayList<>();
    private final List<String> phases = new ArrayList<>();
    private final List<String> nativePollDiagnostics = new ArrayList<>();
    private final Map<String, Object> checks = new LinkedHashMap<>();
    private boolean nativePollDiagnosticsTruncated;
    private int surfaceRevealCount;
    private int captureIndex;
    private long startedAtMs;
    private String phase = "not-started";
    private boolean strictSeekSemanticObserved;
    private boolean nativeSeekRangeObserved;

    private static final class PlayerAxSnapshot {
        int activeDialogs;
        int nestedDialogs;
        int pauseControls;
        int playControls;
        int seekBars;
        int focusedPauseControls;
        int focusablePauseControls;
        int clockPositionSeconds = -1;
        int clockTotalSeconds = -1;
        float[] nativeRange;
        Rect backBounds;
        Rect playPauseBounds;
        Rect forwardBounds;
        Rect seekBounds;
        Rect closeBounds;
        Rect playerDialogBounds;
        final List<Rect> actionableBounds = new ArrayList<>();
        boolean pauseFocusActionAttempted;
        boolean pauseFocusActionSucceeded;
        boolean safetyGuardComplete;
        int scannedDisplays;
        int scannedWindows;
        int scannedRoots;
        int deduplicatedRoots;
        int visitedWindowNodes;
        long foregroundGuardMs;
        long readDurationMs;

        int playbackPositionSeconds() {
            return clockPositionSeconds;
        }

        float[] copyNativeRange() {
            return nativeRange == null ? null : new float[] { nativeRange[0], nativeRange[1] };
        }
    }

    static boolean matchesBindingLegalPhrase(String text, String description) {
        return (text != null && BINDING_TERMS.matcher(text).matches())
                || (description != null && BINDING_TERMS.matcher(description).matches());
    }

    static boolean isBlockedApprovalPackage(String packageName) {
        return "com.android.permissioncontroller".equals(packageName)
                || "com.google.android.permissioncontroller".equals(packageName)
                || "com.android.settings".equals(packageName)
                || "com.google.android.packageinstaller".equals(packageName)
                || "com.android.packageinstaller".equals(packageName);
    }

    private static final class AxSafetyGuard {
        private boolean blockedApprovalPackageVisible;
        private boolean bindingLegalPhraseVisible;

        AxSafetyGuard(String foregroundPackage) {
            observeForegroundPackage(foregroundPackage);
        }

        void observeForegroundPackage(String packageName) {
            if (isBlockedApprovalPackage(packageName)) {
                blockedApprovalPackageVisible = true;
            }
        }

        void observe(String text, String description) {
            if (matchesBindingLegalPhrase(text, description)) {
                bindingLegalPhraseVisible = true;
            }
        }

        String rejection() {
            if (blockedApprovalPackageVisible) {
                return "Refusing to approve an out-of-scope permission, settings, or install surface";
            }
            if (bindingLegalPhraseVisible) {
                return "Refusing to act while a binding legal phrase is visible";
            }
            return null;
        }
    }

    private interface AxNodeReader<N> {
        String packageName(N node);
        String className(N node);
        String text(N node);
        String description(N node);
        int childCount(N node);
        N childAt(N node, int index);
        void recycle(N node);
    }

    private interface AxActiveNodeObserver<N> {
        void observe(
                N node, String packageName, String className, String text, String description,
                boolean isPlayerDialog, boolean insidePlayer);
    }

    private static final class AxScanRoot<N> {
        final N node;
        boolean active;

        AxScanRoot(N node, boolean active) {
            this.node = node;
            this.active = active;
        }
    }

    private static final class AxPendingNode<N> {
        final N node;
        final boolean activeTree;
        final boolean parentInsidePlayer;
        final boolean rootNode;
        final boolean ownedByTraversal;

        AxPendingNode(
                N node, boolean activeTree, boolean parentInsidePlayer,
                boolean rootNode, boolean ownedByTraversal) {
            this.node = node;
            this.activeTree = activeTree;
            this.parentInsidePlayer = parentInsidePlayer;
            this.rootNode = rootNode;
            this.ownedByTraversal = ownedByTraversal;
        }
    }

    private static final class AxWindowScanResult {
        boolean allRootsVerified;
        int activeDialogs;
        int nestedDialogs;
        int rootCount;
        int deduplicatedRoots;
        int visitedNodes;
    }

    private static final class AxWindowRootGraph<N> {
        private final int maximumRoots;
        private final int maximumNodes;
        private final String productPackage;
        private final String playerDialogTitle;
        private final Map<N, AxScanRoot<N>> rootsByFrameworkIdentity = new LinkedHashMap<>();
        private int deduplicatedRoots;
        private boolean scanned;

        AxWindowRootGraph(
                int displayCount, long windowCount,
                int maximumDisplays, int maximumWindows, int maximumRoots, int maximumNodes,
                String productPackage, String playerDialogTitle) {
            if (displayCount < 0 || displayCount > maximumDisplays) {
                throw new IllegalStateException("Accessibility display inventory exceeded its bound");
            }
            if (windowCount < 0 || windowCount > maximumWindows) {
                throw new IllegalStateException("Accessibility window inventory exceeded its bound");
            }
            if (maximumDisplays < 1 || maximumWindows < 1
                    || maximumRoots < 1 || maximumNodes < 1) {
                throw new IllegalArgumentException("Invalid accessibility traversal bounds");
            }
            this.maximumRoots = maximumRoots;
            this.maximumNodes = maximumNodes;
            this.productPackage = productPackage;
            this.playerDialogTitle = playerDialogTitle;
        }

        void addRoot(N root, boolean active) {
            if (root == null) return;
            if (scanned) throw new IllegalStateException("Accessibility root added after traversal");
            AxScanRoot<N> existing = rootsByFrameworkIdentity.get(root);
            if (existing != null) {
                existing.active = existing.active || active;
                deduplicatedRoots++;
                return;
            }
            if (rootsByFrameworkIdentity.size() >= maximumRoots) {
                throw new IllegalStateException("Accessibility root inventory exceeded its bound");
            }
            rootsByFrameworkIdentity.put(root, new AxScanRoot<>(root, active));
        }

        AxWindowScanResult scan(
                AxNodeReader<N> reader, AxActiveNodeObserver<N> activeObserver,
                AxSafetyGuard safetyGuard) {
            if (scanned) throw new IllegalStateException("Accessibility roots traversed more than once");
            scanned = true;
            AxWindowScanResult result = new AxWindowScanResult();
            result.rootCount = rootsByFrameworkIdentity.size();
            result.deduplicatedRoots = deduplicatedRoots;
            List<AxPendingNode<N>> pending = new ArrayList<>();
            for (AxScanRoot<N> root : rootsByFrameworkIdentity.values()) {
                pending.add(new AxPendingNode<>(root.node, root.active, false, true, false));
            }
            try {
                while (!pending.isEmpty()) {
                    if (result.visitedNodes >= maximumNodes) {
                        throw new IllegalStateException(
                                "Accessibility trees exceeded the bounded total node scan");
                    }
                    AxPendingNode<N> current = pending.remove(pending.size() - 1);
                    result.visitedNodes++;
                    try {
                        String packageName = reader.packageName(current.node);
                        String className = reader.className(current.node);
                        String text = reader.text(current.node);
                        String description = reader.description(current.node);
                        safetyGuard.observe(text, description);
                        if (current.rootNode) safetyGuard.observeForegroundPackage(packageName);

                        boolean isPlayerDialog = current.activeTree
                                && productPackage.equals(packageName)
                                && "android.app.Dialog".equals(className)
                                && playerDialogTitle.equals(text);
                        if (isPlayerDialog) result.activeDialogs++;
                        boolean insidePlayer = current.activeTree
                                && (current.parentInsidePlayer || isPlayerDialog);
                        if (insidePlayer && !isPlayerDialog
                                && productPackage.equals(packageName)
                                && "android.app.Dialog".equals(className)) {
                            result.nestedDialogs++;
                        }
                        if (current.activeTree) {
                            activeObserver.observe(
                                    current.node, packageName, className, text, description,
                                    isPlayerDialog, insidePlayer);
                        }

                        int childCount = reader.childCount(current.node);
                        if (childCount < 0) {
                            throw new IllegalStateException("Accessibility node returned a negative child count");
                        }
                        for (int index = 0; index < childCount; index++) {
                            N child = reader.childAt(current.node, index);
                            if (child == null) continue;
                            if (result.visitedNodes + pending.size() >= maximumNodes) {
                                reader.recycle(child);
                                throw new IllegalStateException(
                                        "Accessibility trees exceeded the bounded total node scan");
                            }
                            pending.add(new AxPendingNode<>(
                                    child, current.activeTree, insidePlayer, false, true));
                        }
                    } finally {
                        if (current.ownedByTraversal) reader.recycle(current.node);
                    }
                }
                if (result.activeDialogs > 1) {
                    throw new IllegalStateException(
                            "Multiple exact active player dialogs were exposed");
                }
                if (safetyGuard.rejection() != null) {
                    throw new IllegalStateException(safetyGuard.rejection());
                }
                result.allRootsVerified = true;
                return result;
            } finally {
                for (AxPendingNode<N> node : pending) {
                    if (node.ownedByTraversal) reader.recycle(node.node);
                }
            }
        }
    }

    static boolean canPerformPauseFocus(
            AxWindowScanResult scanResult, AxSafetyGuard safetyGuard,
            int activeDialogs, int nestedDialogs,
            int pauseControls, int playControls, int focusedPauseControls) {
        return scanResult != null && scanResult.allRootsVerified
                && safetyGuard != null && safetyGuard.rejection() == null
                && activeDialogs == 1 && nestedDialogs == 0
                && pauseControls == 1 && playControls == 0
                && focusedPauseControls == 0;
    }

    private static final class CoreGeometryStabilityObservation {
        final long firstUptimeMs;
        final long secondUptimeMs;
        final int firstClockSeconds;
        final int secondClockSeconds;
        final int displayWidth;
        final int displayHeight;
        final String geometrySignature;
        final int observedSamples;

        CoreGeometryStabilityObservation(
                long firstUptimeMs, long secondUptimeMs,
                int firstClockSeconds, int secondClockSeconds,
                int displayWidth, int displayHeight, String geometrySignature,
                int observedSamples) {
            this.firstUptimeMs = firstUptimeMs;
            this.secondUptimeMs = secondUptimeMs;
            this.firstClockSeconds = firstClockSeconds;
            this.secondClockSeconds = secondClockSeconds;
            this.displayWidth = displayWidth;
            this.displayHeight = displayHeight;
            this.geometrySignature = geometrySignature;
            this.observedSamples = observedSamples;
        }

        long sampleGapMs() {
            return secondUptimeMs - firstUptimeMs;
        }
    }

    private static final class CoreGeometryStabilityGate {
        private final long minimumGapMs;
        private final int expectedDisplayWidth;
        private final int expectedDisplayHeight;
        private final int expectedClockPosition;
        private long lastElapsedMs = -1;
        private long firstElapsedMs = -1;
        private int firstClockSeconds = -1;
        private String firstGeometrySignature;
        private int observedSamples;
        private CoreGeometryStabilityObservation observation;

        CoreGeometryStabilityGate(
                long minimumGapMs, int expectedDisplayWidth,
                int expectedDisplayHeight, int expectedClockPosition) {
            if (minimumGapMs < 1 || expectedDisplayWidth < 1 || expectedDisplayHeight < 1
                    || expectedClockPosition < 0 || expectedClockPosition > 30) {
                throw new IllegalArgumentException("Invalid settled core-geometry gate");
            }
            this.minimumGapMs = minimumGapMs;
            this.expectedDisplayWidth = expectedDisplayWidth;
            this.expectedDisplayHeight = expectedDisplayHeight;
            this.expectedClockPosition = expectedClockPosition;
        }

        boolean observe(
                long elapsedMs, int displayWidth, int displayHeight,
                boolean exactPausedSnapshot, int clockPosition,
                boolean japaneseSelectionObserved, String geometrySignature) {
            if (elapsedMs < 0 || (lastElapsedMs >= 0 && elapsedMs < lastElapsedMs)) {
                throw new IllegalArgumentException("Settled geometry observations were not monotonic");
            }
            if (observation != null) {
                throw new IllegalStateException("Settled geometry gate was observed after completion");
            }
            lastElapsedMs = elapsedMs;
            observedSamples++;
            boolean admissible = exactPausedSnapshot
                    && japaneseSelectionObserved
                    && displayWidth == expectedDisplayWidth
                    && displayHeight == expectedDisplayHeight
                    && Math.abs(clockPosition - expectedClockPosition) <= 1
                    && geometrySignature != null && !geometrySignature.isEmpty();
            if (!admissible) {
                clearCandidate();
                return false;
            }
            if (firstElapsedMs < 0
                    || !geometrySignature.equals(firstGeometrySignature)
                    || Math.abs(clockPosition - firstClockSeconds) > 1) {
                firstElapsedMs = elapsedMs;
                firstClockSeconds = clockPosition;
                firstGeometrySignature = geometrySignature;
                return false;
            }
            if (elapsedMs - firstElapsedMs < minimumGapMs) return false;
            observation = new CoreGeometryStabilityObservation(
                    firstElapsedMs, elapsedMs,
                    firstClockSeconds, clockPosition,
                    displayWidth, displayHeight, geometrySignature, observedSamples);
            return true;
        }

        CoreGeometryStabilityObservation observation() {
            if (observation == null) {
                throw new IllegalStateException("Settled geometry was not complete");
            }
            return observation;
        }

        private void clearCandidate() {
            firstElapsedMs = -1;
            firstClockSeconds = -1;
            firstGeometrySignature = null;
        }
    }

    private static final class StablePausedPositionGate {
        private final int minimum;
        private final int maximum;
        private final int requiredObservations;
        private int candidatePosition = -1;
        private int consistentObservationCount;

        StablePausedPositionGate(int minimum, int maximum, int requiredObservations) {
            if (minimum < 0 || maximum < minimum || requiredObservations < 2) {
                throw new IllegalArgumentException("Invalid stable paused-position gate");
            }
            this.minimum = minimum;
            this.maximum = maximum;
            this.requiredObservations = requiredObservations;
        }

        int observe(
                int position, int activeDialogs, int nestedDialogs,
                int pauseControls, int playControls, int seekBars) {
            boolean exactPausedPosition = activeDialogs == 1 && nestedDialogs == 0
                    && pauseControls == 0 && playControls == 1 && seekBars == 1
                    && position >= minimum && position <= maximum;
            if (!exactPausedPosition) {
                candidatePosition = -1;
                consistentObservationCount = 0;
                return -1;
            }
            if (position == candidatePosition) {
                consistentObservationCount++;
            } else {
                candidatePosition = position;
                consistentObservationCount = 1;
            }
            return consistentObservationCount >= requiredObservations ? candidatePosition : -1;
        }

        int candidatePosition() {
            return candidatePosition;
        }

        int consistentObservationCount() {
            return consistentObservationCount;
        }
    }

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
            try { recordFailureNativeSnapshot(); } catch (Throwable ignored) { log("Failure AX snapshot unavailable"); }
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
        PlayerAxSnapshot initialPlaying = waitForInitialPlayingTransport();
        assertCoreLayoutSnapshot("portrait-playing", initialPlaying, "Pause");
        int first = initialPlaying.playbackPositionSeconds();
        assertTrue("Initial playing snapshot did not contain a strict Seek clock", first >= 0);
        capture("playing-clock-initial");
        int advanced = waitForPlaybackPositionAtLeast(first + 1, MEDIA_WAIT_MS);
        assertTrue("Playback clock did not advance after the player exposed Pause", advanced > first);
        checks.put("firstDecodeClockAdvanced", true);
        capture("playing-clock-advanced");

        transition("central-pause-resume");
        clickPlayerTransport("Pause", "central Pause", SHORT_WAIT_MS);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "central Play after pause");
        int paused = waitForPlaybackPositionAtLeast(advanced, SHORT_WAIT_MS);
        SystemClock.sleep(1_500);
        int pausedAfterHold = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock after central control hold");
        assertTrue("Playback advanced while central control reported paused",
                Math.abs(pausedAfterHold - paused) <= 1);
        int lowPaused = positionPausedClockAtMostFive();
        assertTrue("Paused clock was not placed in the low non-clamped window", lowPaused <= 5);
        checks.put("pausedClockBeforeResumeSeconds", lowPaused);
        clickPlayerTransport("Play", "central Play", SHORT_WAIT_MS);
        waitForPlayerTransport("Pause", SHORT_WAIT_MS, "central Pause after resume");
        waitForPlaybackPositionAtLeast(lowPaused + 1, MEDIA_WAIT_MS);
        clickPlayerTransport("Pause", "central Pause before seek checks", SHORT_WAIT_MS);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused central Play");
        checks.put("centralPauseResume", true);

        transition("paused-transport-and-scrub");
        int beforeForward = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before Forward 10");
        clickPlayerLabeled("Forward 10 seconds", "paused Forward 10", SHORT_WAIT_MS);
        int afterForward = waitForPlaybackPositionAtLeast(Math.min(29, beforeForward + 8), MEDIA_WAIT_MS);
        clickPlayerLabeled("Back 10 seconds", "paused Back 10", SHORT_WAIT_MS);
        int afterBack = waitForPlaybackPositionAtMost(Math.max(0, afterForward - 8), MEDIA_WAIT_MS);
        assertTrue("Back 10 did not reverse the prior paused seek", afterBack < afterForward);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play after transport seeks");
        checks.put("pausedBackForward", true);

        UiObject2 seek = waitForPlayerSeekBar(SHORT_WAIT_MS, "semantic touch scrub slider");
        Rect seekBounds = seek.getVisibleBounds();
        assertTrue("Touch scrub target was narrower than 44 px", seekBounds.width() >= 44);
        int beforeScrub = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before scrub");
        device.swipe(seekBounds.left + seekBounds.width() / 4, seekBounds.centerY(),
                seekBounds.left + seekBounds.width() * 2 / 3, seekBounds.centerY(), 24);
        int afterScrub = waitForPlaybackPositionAtLeast(Math.max(beforeScrub + 3, 18), MEDIA_WAIT_MS);
        assertTrue("Touch scrub produced no measured forward delta", afterScrub > beforeScrub);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play after scrub");
        checks.put("touchScrubDeltaSeconds", afterScrub - beforeScrub);
        capture("paused-after-scrub");

        transition("two-track-audio-handoff");
        int preAudioSwitchPosition = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before audio switch");
        assertTrue("Audio switch started at an unbounded or zero absolute clock",
                preAudioSwitchPosition > 0 && preAudioSwitchPosition <= 30);
        checks.put("preAudioSwitchAbsolutePositionSeconds", preAudioSwitchPosition);
        openCurrentAudioSheet("Audio tracks", "Audio track, " + ENGLISH);
        waitForPlayerLabeledClickable(ENGLISH, MEDIA_WAIT_MS, "English audio track");
        guardedClick(waitForPlayerLabeledClickable(JAPANESE, MEDIA_WAIT_MS, "Japanese audio track"),
                "Japanese audio track");
        // The product remounts the source after an audio choice, which closes this sheet.
        waitForPlayerLabeledClickable("Audio track, " + JAPANESE, MEDIA_WAIT_MS,
                "Japanese Audio action after source handoff");
        assertTrue("Audio sheet remained open after source handoff",
                !hasPlayerTextOrDescription("Close audio tracks"));
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play after audio handoff");
        int postHandoffPosition = waitForPlaybackPositionAtLeast(
                Math.max(1, preAudioSwitchPosition - 1), MEDIA_WAIT_MS);
        assertTrue("Audio handoff restarted or moved the absolute clock",
                postHandoffPosition > 0 && Math.abs(postHandoffPosition - preAudioSwitchPosition) <= 1);
        checks.put("postHandoffAbsolutePositionSeconds", postHandoffPosition);
        assertAbsoluteThirtySecondTimeline();
        openCurrentAudioSheet("Audio track, " + JAPANESE);
        waitForPlayerLabeledClickable(ENGLISH, MEDIA_WAIT_MS, "English audio track after handoff");
        waitForPlayerLabeledClickable(JAPANESE, MEDIA_WAIT_MS, "Japanese audio track after handoff");
        capture("japanese-persisted-sheet-reopened");
        clickPlayerLabeled("Close audio tracks", "close persisted audio tracks", SHORT_WAIT_MS);
        waitForPlayerLabeledClickable("Audio track, " + JAPANESE, MEDIA_WAIT_MS,
                "persisted Japanese Audio action after closing sheet");
        checks.put("twoRealAudioTracksObserved", true);
        checks.put("japaneseSelectionPersistedAfterHandoff", true);

        transition("orientation-round-trip");
        waitForPortrait();
        int portraitWidth = device.getDisplayWidth();
        int portraitHeight = device.getDisplayHeight();
        assertTrue("Pre-rotation display was not portrait", portraitHeight > portraitWidth);
        checks.put("portraitBeforeOrientationWidthPx", portraitWidth);
        checks.put("portraitBeforeOrientationHeightPx", portraitHeight);
        int preRotationPosition = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused absolute clock before orientation round trip");
        device.setOrientationLeft();
        waitForLandscape();
        int landscapeWidth = device.getDisplayWidth();
        int landscapeHeight = device.getDisplayHeight();
        assertTrue("Rotated display was not landscape", landscapeWidth > landscapeHeight);
        checks.put("landscapeWidthPx", landscapeWidth);
        checks.put("landscapeHeightPx", landscapeHeight);
        assertCoreLayout("landscape", "Play");
        checks.put("landscapeImmediateCaptureStartedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        capture("landscape-controls");
        checks.put("landscapeImmediateCaptureFinishedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        CoreGeometryStabilityObservation landscapeSettledOne =
                waitForStablePausedCoreGeometry(
                        "landscape-settled-1", landscapeWidth, landscapeHeight,
                        preRotationPosition);
        recordSettledCoreGeometry("landscapeSettledOne", landscapeSettledOne);
        checks.put("landscapeSettledOneCaptureStartedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        capture("landscape-controls-settled-1");
        checks.put("landscapeSettledOneCaptureFinishedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        CoreGeometryStabilityObservation landscapeSettledTwo =
                waitForStablePausedCoreGeometry(
                        "landscape-settled-2", landscapeWidth, landscapeHeight,
                        preRotationPosition);
        recordSettledCoreGeometry("landscapeSettledTwo", landscapeSettledTwo);
        checks.put("landscapeSettledTwoCaptureStartedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        capture("landscape-controls-settled-2");
        checks.put("landscapeSettledTwoCaptureFinishedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        device.setOrientationNatural();
        waitForPortrait();
        int portraitReturnWidth = device.getDisplayWidth();
        int portraitReturnHeight = device.getDisplayHeight();
        assertEquals("Portrait width did not return after rotation", portraitWidth, portraitReturnWidth);
        assertEquals("Portrait height did not return after rotation", portraitHeight, portraitReturnHeight);
        checks.put("portraitReturnWidthPx", portraitReturnWidth);
        checks.put("portraitReturnHeightPx", portraitReturnHeight);
        assertCoreLayout("portrait-return", "Play");
        waitForPlayerLabeledClickable("Audio track, " + JAPANESE, SHORT_WAIT_MS,
                "Japanese Audio action after orientation round trip");
        int postRotationPosition = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused absolute clock after orientation round trip");
        assertTrue("Orientation round trip changed the paused absolute clock",
                Math.abs(postRotationPosition - preRotationPosition) <= 1);
        checks.put("preRotationAbsolutePositionSeconds", preRotationPosition);
        checks.put("postRotationAbsolutePositionSeconds", postRotationPosition);
        checks.put("portraitLandscapePortrait", true);
        checks.put("audioSelectionPersistedAcrossOrientation", true);
        checks.put("portraitReturnImmediateCaptureStartedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        capture("portrait-return-controls");
        checks.put("portraitReturnImmediateCaptureFinishedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        CoreGeometryStabilityObservation portraitReturnSettled =
                waitForStablePausedCoreGeometry(
                        "portrait-return-settled", portraitReturnWidth, portraitReturnHeight,
                        preRotationPosition);
        recordSettledCoreGeometry("portraitReturnSettled", portraitReturnSettled);
        checks.put("portraitReturnSettledCaptureStartedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);
        capture("portrait-return-controls-settled");
        checks.put("portraitReturnSettledCaptureFinishedElapsedMs",
                SystemClock.uptimeMillis() - startedAtMs);

        transition("touch-action-rail-and-settings");
        verifyScrollablePlaybackActionsAndSettings();

        transition("paused-side-double-tap-after-hls");
        int beforePositioning = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before double-tap positioning");
        clickPlayerLabeled("Back 10 seconds", "paused Back 10 before side double tap", SHORT_WAIT_MS);
        int beforeDoubleTap = waitForStablePausedPlaybackPositionInRange(
                8, 12, MEDIA_WAIT_MS,
                "paused double-tap clock after Back 10 from " + beforePositioning);
        assertTrue("Back 10 did not place the paused clock in the non-clamped double-tap window",
                beforeDoubleTap >= 8 && beforeDoubleTap <= 12);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play before side double tap");
        capture("before-side-double-tap");
        PlayerAxSnapshot gestureSnapshot = waitForPausedGestureSafetySnapshot();
        int x = device.getDisplayWidth() * 84 / 100;
        int y = device.getDisplayHeight() * 35 / 100;
        long[] eventTimes = injectNativePausedDoubleTap(gestureSnapshot, x, y);
        checks.put("doubleTapFirstDownUptimeMs", eventTimes[0]);
        checks.put("doubleTapFirstUpUptimeMs", eventTimes[1]);
        checks.put("doubleTapSecondDownUptimeMs", eventTimes[2]);
        checks.put("doubleTapSecondUpUptimeMs", eventTimes[3]);
        checks.put("doubleTapUpToUpGapMs", eventTimes[3] - eventTimes[1]);
        checks.put("doubleTapPointXPx", x);
        checks.put("doubleTapPointYPx", y);
        checks.put("nativeDoubleTapInjectionUsed", true);
        checks.put("doubleTapGestureTimingValid", true);
        checks.put("doubleTapPlayerSafetyVerified", true);
        checks.put("doubleTapPointOutsideActionableControls", true);
        checks.put("doubleTapObservationBasis",
                "uiautomation-motion-event-source-touchscreen-uptime");
        int afterDoubleTap = waitForPlaybackPositionAtLeast(beforeDoubleTap + 9, MEDIA_WAIT_MS);
        int doubleTapDelta = afterDoubleTap - beforeDoubleTap;
        assertTrue("Side double tap did not seek forward exactly once", doubleTapDelta >= 9);
        assertTrue("Side double tap sought more than one ten-second step", doubleTapDelta <= 11);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play after side double tap");
        checks.put("pausedSideDoubleTapSingleSeek", true);
        checks.put("pausedSideDoubleTapDeltaSeconds", doubleTapDelta);
        capture("after-side-double-tap");

        transition("complete");
    }

    private PlayerAxSnapshot waitForPausedGestureSafetySnapshot() {
        long deadline = SystemClock.uptimeMillis() + SHORT_WAIT_MS;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            if (snapshot.activeDialogs == 1 && snapshot.nestedDialogs == 0
                    && snapshot.playControls == 1 && snapshot.pauseControls == 0
                    && hasCompleteCoreSnapshot(snapshot)
                    && snapshot.actionableBounds.size() >= 5) {
                return snapshot;
            }
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(
                    reveals, "fresh paused gesture safety snapshot", snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                // Keep a prior chrome-reveal click outside the product's 320 ms gesture window.
                SystemClock.sleep(100);
                continue;
            }
            SystemClock.sleep(200);
        }
        fail("Invalid harness gesture: no fresh exact paused player snapshot with bounded controls");
        return null;
    }

    private void verifyScrollablePlaybackActionsAndSettings() {
        int beforeSettings = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before playback settings reachability");
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play before action-rail pan");
        UiObject2 more = null;
        int horizontalPans = 0;
        for (int attempt = 0; attempt < 4 && more == null; attempt++) {
            UiObject2 rail = findPlaybackActionsRail();
            assertNotNull("Exact Playback actions toolbar was not visible and scrollable", rail);
            rail.scroll(Direction.RIGHT, 0.72f);
            horizontalPans++;
            SystemClock.sleep(350);
            more = findPlayerLabeledClickable("Playback settings");
        }
        assertTrue("Playback settings remained unreachable after bounded horizontal toolbar pans",
                horizontalPans > 0 && more != null);
        checks.put("playbackActionsRailScrolled", true);
        checks.put("playbackActionsRailPanAttempts", horizontalPans);
        guardedClick(more, "Playback settings after horizontal action-rail pan");
        waitForExactNestedPlayerDialog("Playback settings", SHORT_WAIT_MS);
        checks.put("playbackSettingsOpened", true);

        UiObject2 external = findPlayerLabeledClickableAny(
                "Open in external player",
                "Open in external player Choose VLC or another installed video app");
        int verticalPans = 0;
        while (external == null && verticalPans < 4) {
            UiObject2 settingsScroller = findScrollableInsideExactDialog("Playback settings");
            assertNotNull("Playback settings overflowed without an exact vertical scroller",
                    settingsScroller);
            settingsScroller.scroll(Direction.DOWN, 0.70f);
            verticalPans++;
            SystemClock.sleep(350);
            external = findPlayerLabeledClickableAny(
                    "Open in external player",
                    "Open in external player Choose VLC or another installed video app");
        }
        assertNotNull("Open in external player was not visibly reachable in Playback settings",
                external);
        assertTrue("Open in external player was not enabled or clickable",
                external.isEnabled() && external.isClickable());
        checks.put("playbackSettingsVerticalPanAttempts", verticalPans);
        checks.put("externalPlayerActionReachable", true);
        checks.put("externalPlayerActionLaunched", false);

        UiObject2 close = findPlayerLabeledClickable("Close playback settings");
        int upwardPans = 0;
        while (close == null && upwardPans < 4) {
            UiObject2 settingsScroller = findScrollableInsideExactDialog("Playback settings");
            assertNotNull("Playback settings Close was unreachable without a vertical scroller",
                    settingsScroller);
            settingsScroller.scroll(Direction.UP, 0.70f);
            upwardPans++;
            SystemClock.sleep(350);
            close = findPlayerLabeledClickable("Close playback settings");
        }
        assertNotNull("Close playback settings was not visibly reachable", close);
        guardedClick(close, "Close playback settings after reachability proof");
        waitForExactNestedPlayerDialogGone("Playback settings", SHORT_WAIT_MS);
        waitForPlayerTransport("Play", SHORT_WAIT_MS, "paused Play after playback settings");
        UiObject2 japaneseAudio = findPlayerLabeledClickable("Audio track, " + JAPANESE);
        int returnPans = 0;
        while (japaneseAudio == null && returnPans < 4) {
            UiObject2 rail = findPlaybackActionsRail();
            assertNotNull("Playback actions toolbar was unavailable while returning to Audio", rail);
            rail.scroll(Direction.LEFT, 0.72f);
            returnPans++;
            SystemClock.sleep(350);
            japaneseAudio = findPlayerLabeledClickable("Audio track, " + JAPANESE);
        }
        assertNotNull("Japanese Audio action was not reachable after returning the action rail",
                japaneseAudio);
        int afterSettings = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock after playback settings");
        assertTrue("Playback settings reachability changed the paused absolute clock",
                Math.abs(afterSettings - beforeSettings) <= 1);
        checks.put("playbackSettingsUpwardPanAttempts", upwardPans);
        checks.put("playbackActionsRailReturnPanAttempts", returnPans);
        checks.put("playbackSettingsCloseUsed", true);
        checks.put("pausedJapanesePreservedAfterPlaybackSettings", true);
    }

    private UiObject2 findPlaybackActionsRail() {
        refreshObservation();
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 candidate : device.findObjects(By.clazz("android.view.View")
                .pkg(PRODUCT_PACKAGE).text(exactLabel("Playback actions")).scrollable(true))) {
            if (!isInsideActivePlayerDialog(candidate)) continue;
            if (!isBoundedVisibleTarget(candidate.getVisibleBounds(), 44, 44)) continue;
            candidates.add(candidate);
        }
        if (candidates.size() > 1) fail("Ambiguous exact Playback actions toolbars");
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findScrollableInsideExactDialog(String title) {
        refreshObservation();
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 candidate : device.findObjects(
                By.scrollable(true).pkg(PRODUCT_PACKAGE))) {
            if (!isInsideExactDialog(candidate, title)) continue;
            if (!isBoundedVisibleTarget(candidate.getVisibleBounds(), 44, 44)) continue;
            candidates.add(candidate);
        }
        if (candidates.size() > 1) fail("Ambiguous scrollables inside exact dialog: " + title);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private boolean isInsideExactDialog(UiObject2 node, String title) {
        UiObject2 current = node;
        for (int depth = 0; depth < 20 && current != null; depth++) {
            if (PRODUCT_PACKAGE.equals(current.getApplicationPackage())
                    && "android.app.Dialog".equals(current.getClassName())
                    && title.equals(current.getText())) return true;
            current = current.getParent();
        }
        return false;
    }

    private void waitForExactNestedPlayerDialog(String title, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            refreshObservation();
            for (UiObject2 candidate : device.findObjects(By.clazz("android.app.Dialog")
                    .pkg(PRODUCT_PACKAGE).text(exactLabel(title)))) {
                if (isInsideActivePlayerDialog(candidate)) return;
            }
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for exact nested player dialog: " + title);
    }

    private void waitForExactNestedPlayerDialogGone(String title, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            refreshObservation();
            boolean present = false;
            for (UiObject2 candidate : device.findObjects(By.clazz("android.app.Dialog")
                    .pkg(PRODUCT_PACKAGE).text(exactLabel(title)))) {
                if (isInsideActivePlayerDialog(candidate)) present = true;
            }
            if (!present) return;
            SystemClock.sleep(200);
        }
        fail("Exact nested player dialog did not close: " + title);
    }

    private long[] injectNativePausedDoubleTap(PlayerAxSnapshot snapshot, int x, int y) {
        assertTrue("Invalid harness gesture: product was not the foreground package",
                PRODUCT_PACKAGE.equals(device.getCurrentPackageName()));
        assertTrue("Invalid harness gesture: exact player dialog was unavailable or nested",
                snapshot.activeDialogs == 1 && snapshot.nestedDialogs == 0
                        && snapshot.playerDialogBounds != null);
        assertTrue("Invalid harness gesture: fresh player snapshot omitted a core control",
                hasCompleteCoreSnapshot(snapshot) && snapshot.actionableBounds.size() >= 5);
        assertTrue("Invalid harness gesture: player was not in the exact paused Play state",
                snapshot.playControls == 1 && snapshot.pauseControls == 0);
        assertTrue("Invalid harness gesture: target point was outside the exact player dialog",
                snapshot.playerDialogBounds.contains(x, y));
        for (Rect actionable : snapshot.actionableBounds) {
            assertTrue("Invalid harness gesture: target point intersected an actionable control",
                    !actionable.contains(x, y));
        }

        long firstDown = injectNativeTouchEvent(MotionEvent.ACTION_DOWN, 0L, x, y, "first DOWN");
        SystemClock.sleep(DOUBLE_TAP_HOLD_MS);
        long firstUp = injectNativeTouchEvent(MotionEvent.ACTION_UP, firstDown, x, y, "first UP");
        SystemClock.sleep(DOUBLE_TAP_INTER_GAP_MS);
        long secondDown = injectNativeTouchEvent(MotionEvent.ACTION_DOWN, 0L, x, y, "second DOWN");
        SystemClock.sleep(DOUBLE_TAP_HOLD_MS);
        long secondUp = injectNativeTouchEvent(MotionEvent.ACTION_UP, secondDown, x, y, "second UP");
        long observedAfterSequence = SystemClock.uptimeMillis();
        assertTrue("Invalid harness gesture: injected event times were not a real bounded double tap",
                isValidNativeDoubleTapTiming(firstDown, firstUp, secondDown, secondUp));
        assertTrue("Invalid harness gesture: injected event time was in the future",
                secondUp <= observedAfterSequence);
        log(String.format(Locale.ROOT,
                "Injected native touchscreen double tap at %d,%d with actual uptime events %d/%d/%d/%d",
                x, y, firstDown, firstUp, secondDown, secondUp));
        return new long[] { firstDown, firstUp, secondDown, secondUp };
    }

    private long injectNativeTouchEvent(
            int action, long gestureDownTime, int x, int y, String label) {
        long eventTime = SystemClock.uptimeMillis();
        long downTime = action == MotionEvent.ACTION_DOWN ? eventTime : gestureDownTime;
        MotionEvent event = MotionEvent.obtain(
                downTime, eventTime, action, (float) x, (float) y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        boolean injected;
        try {
            injected = instrumentation.getUiAutomation().injectInputEvent(event, false);
        } finally {
            event.recycle();
        }
        assertTrue("Invalid harness gesture: native injection failed for " + label, injected);
        return eventTime;
    }

    static boolean isValidNativeDoubleTapTiming(
            long firstDown, long firstUp, long secondDown, long secondUp) {
        return firstDown >= 0L
                && firstDown < firstUp && firstUp < secondDown && secondDown < secondUp
                && firstUp - firstDown <= 100L
                && secondUp - secondDown <= 100L
                && secondDown - firstUp <= 200L
                && secondUp - firstUp <= DOUBLE_TAP_MAX_UP_TO_UP_MS;
    }

    private int positionPausedClockAtMostFive() {
        int position = waitForPlaybackPositionAvailable(
                SHORT_WAIT_MS, "paused clock before bounded rewind");
        for (int attempt = 0; attempt < 3 && position > 5; attempt++) {
            clickPlayerLabeled("Back 10 seconds", "bounded paused Back 10", SHORT_WAIT_MS);
            position = waitForPlaybackPositionAtMost(Math.max(0, position - 8), MEDIA_WAIT_MS);
        }
        assertTrue("Three ordinary Back 10 taps did not lower the actual paused clock to five seconds",
                position >= 0 && position <= 5);
        return position;
    }

    private void openCurrentAudioSheet(String... acceptedActionLabels) {
        UiObject2 action = null;
        long deadline = SystemClock.uptimeMillis() + MEDIA_WAIT_MS;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline && action == null) {
            refreshObservation();
            for (String label : acceptedActionLabels) {
                action = findPlayerLabeledClickable(label);
                if (action != null) break;
            }
            if (action == null) {
                int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, "current Audio action");
                if (updatedReveals != reveals) {
                    reveals = updatedReveals;
                    continue;
                }
                SystemClock.sleep(250);
            }
        }
        assertNotNull("No expected current Audio action was exposed", action);
        guardedClick(action, "current Audio action");
        waitForTextOrDescription("Audio tracks", SHORT_WAIT_MS, "Audio tracks dialog");
    }

    private boolean hasPlayerTextOrDescription(String label) {
        refreshObservation();
        for (UiObject2 node : device.findObjects(By.text(exactLabel(label)).pkg(PRODUCT_PACKAGE))) {
            if (isInsideActivePlayerDialog(node)) return true;
        }
        for (UiObject2 node : device.findObjects(By.desc(exactLabel(label)).pkg(PRODUCT_PACKAGE))) {
            if (isInsideActivePlayerDialog(node)) return true;
        }
        return false;
    }

    private void assertAbsoluteThirtySecondTimeline() {
        int total = waitForStrictTimelineTotal(
                SHORT_WAIT_MS, "strict SeekBar timeline after HLS audio handoff");
        assertEquals("HLS audio handoff changed the absolute 30 second timeline", 30, total);
        checks.put("absoluteTimelineAfterHlsSeconds", total);
        checks.put("normalHlsMetadataReady", true);
    }

    private void assertCoreLayoutSnapshot(
            String label, PlayerAxSnapshot snapshot, String expectedPlayPauseLabel) {
        assertEquals(label + " did not expose the exact active player", 1, snapshot.activeDialogs);
        assertEquals(label + " exposed a nested player dialog", 0, snapshot.nestedDialogs);
        if ("Pause".equals(expectedPlayPauseLabel)) {
            assertEquals(label + " did not expose Pause", 1, snapshot.pauseControls);
            assertEquals(label + " also exposed Play", 0, snapshot.playControls);
        } else {
            assertEquals(label + " did not expose Play", 1, snapshot.playControls);
            assertEquals(label + " also exposed Pause", 0, snapshot.pauseControls);
        }
        Rect[] bounds = new Rect[] { snapshot.backBounds, snapshot.playPauseBounds,
                snapshot.forwardBounds, snapshot.seekBounds, snapshot.closeBounds };
        for (Rect bound : bounds) {
            assertNotNull(label + " omitted a core control from its native snapshot", bound);
            assertTrue(label + " control was outside display width",
                    bound.left >= 0 && bound.right <= device.getDisplayWidth());
            assertTrue(label + " control was outside display height",
                    bound.top >= 0 && bound.bottom <= device.getDisplayHeight());
            assertTrue(label + " control had empty bounds", bound.width() > 0 && bound.height() > 0);
        }
        assertTrue(label + " transport controls overlapped",
                !Rect.intersects(snapshot.backBounds, snapshot.playPauseBounds)
                        && !Rect.intersects(snapshot.playPauseBounds, snapshot.forwardBounds));
        log("Verified one-snapshot bounded non-overlapping controls: " + label);
    }

    private CoreGeometryStabilityObservation waitForStablePausedCoreGeometry(
            String label, int expectedDisplayWidth,
            int expectedDisplayHeight, int expectedClockPosition) {
        long started = SystemClock.uptimeMillis();
        long deadline = started + SHORT_WAIT_MS;
        CoreGeometryStabilityGate gate = new CoreGeometryStabilityGate(
                MIN_SETTLED_GEOMETRY_GAP_MS,
                expectedDisplayWidth, expectedDisplayHeight, expectedClockPosition);
        while (SystemClock.uptimeMillis() < deadline) {
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            boolean japaneseSelectionObserved =
                    findPlayerLabeledClickable("Audio track, " + JAPANESE) != null;
            int displayWidth = device.getDisplayWidth();
            int displayHeight = device.getDisplayHeight();
            long observedAtMs = SystemClock.uptimeMillis();
            if (observedAtMs > deadline) break;
            boolean exactPausedSnapshot = hasCompleteCoreSnapshot(snapshot)
                    && snapshot.playerDialogBounds != null
                    && snapshot.playControls == 1 && snapshot.pauseControls == 0;
            String geometrySignature = coreGeometrySignature(snapshot);
            if (gate.observe(
                    observedAtMs, displayWidth, displayHeight,
                    exactPausedSnapshot, snapshot.clockPositionSeconds,
                    japaneseSelectionObserved, geometrySignature)) {
                CoreGeometryStabilityObservation observation = gate.observation();
                assertCoreLayoutSnapshot(label, snapshot, "Play");
                log(String.format(Locale.ROOT,
                        "Observed stable paused native core geometry: %s gapMs=%d samples=%d",
                        label, observation.sampleGapMs(), observation.observedSamples));
                return observation;
            }
            SystemClock.sleep(100);
        }
        fail("Timed out waiting for two fresh, guarded, paused " + label
                + " core-geometry snapshots at least "
                + MIN_SETTLED_GEOMETRY_GAP_MS + " ms apart without new input");
        return null;
    }

    private static String coreGeometrySignature(PlayerAxSnapshot snapshot) {
        if (snapshot == null || snapshot.playerDialogBounds == null
                || snapshot.backBounds == null || snapshot.playPauseBounds == null
                || snapshot.forwardBounds == null || snapshot.seekBounds == null
                || snapshot.closeBounds == null) {
            return null;
        }
        return rectSignature(snapshot.playerDialogBounds)
                + "|" + rectSignature(snapshot.backBounds)
                + "|" + rectSignature(snapshot.playPauseBounds)
                + "|" + rectSignature(snapshot.forwardBounds)
                + "|" + rectSignature(snapshot.seekBounds)
                + "|" + rectSignature(snapshot.closeBounds);
    }

    private static String rectSignature(Rect bounds) {
        return bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom;
    }

    private void recordSettledCoreGeometry(
            String prefix, CoreGeometryStabilityObservation observation) {
        assertNotNull("Missing settled core-geometry observation for " + prefix, observation);
        assertTrue("Settled core-geometry samples were too close for " + prefix,
                observation.sampleGapMs() >= MIN_SETTLED_GEOMETRY_GAP_MS);
        checks.put(prefix + "NativeAxGeometryStableObserved", true);
        checks.put(prefix + "FirstSampleElapsedMs", observation.firstUptimeMs - startedAtMs);
        checks.put(prefix + "SecondSampleElapsedMs", observation.secondUptimeMs - startedAtMs);
        checks.put(prefix + "SampleGapMs", observation.sampleGapMs());
        checks.put(prefix + "ObservedSamples", observation.observedSamples);
        checks.put(prefix + "FirstClockSeconds", observation.firstClockSeconds);
        checks.put(prefix + "SecondClockSeconds", observation.secondClockSeconds);
        checks.put(prefix + "DisplayWidthPx", observation.displayWidth);
        checks.put(prefix + "DisplayHeightPx", observation.displayHeight);
        checks.put(prefix + "CoreBoundsSignature", observation.geometrySignature);
        checks.put(prefix + "JapaneseActionObserved", true);
    }

    private void assertCoreLayout(String label, String expectedPlayPauseLabel) {
        UiObject2 back = waitForPlayerLabeledClickable("Back 10 seconds", SHORT_WAIT_MS, label + " Back 10");
        UiObject2 playPause = waitForPlayerTransport(
                expectedPlayPauseLabel, SHORT_WAIT_MS, label + " " + expectedPlayPauseLabel);
        UiObject2 forward = waitForPlayerLabeledClickable("Forward 10 seconds", SHORT_WAIT_MS, label + " Forward 10");
        UiObject2 seek = waitForPlayerSeekBar(SHORT_WAIT_MS, label + " Seek");
        UiObject2 close = waitForPlayerLabeledClickable("Close player", SHORT_WAIT_MS, label + " Close");
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

    private PlayerAxSnapshot waitForInitialPlayingTransport() {
        long started = SystemClock.uptimeMillis();
        long deadline = started + MEDIA_WAIT_MS;
        long nextSnapshot = started;
        long revealEligibleAt = started + 250;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(true);
            long now = SystemClock.uptimeMillis();
            if (now >= nextSnapshot) {
                recordNativePollSnapshot("first-decode", snapshot, reveals);
                nextSnapshot = now + 2_000;
            }
            if (snapshot.pauseControls == 1 && hasCompleteCoreSnapshot(snapshot)) {
                assertTrue("Playing Pause was exposed together with Play", snapshot.playControls == 0);
                boolean focusActionUsed = snapshot.pauseFocusActionAttempted;
                checks.put("initialPlayingControlFocusActionUsed", focusActionUsed);
                if (focusActionUsed) {
                    checks.put("initialPlayingControlFocusActionSucceeded",
                            snapshot.pauseFocusActionSucceeded);
                }
                assertTrue("Native focus action on playing Pause failed",
                        !focusActionUsed || snapshot.pauseFocusActionSucceeded);
                PlayerAxSnapshot focused = snapshot;
                if (focusActionUsed) {
                    SystemClock.sleep(100);
                    focused = readPlayerAxSnapshot(false);
                }
                assertTrue("Focused playing control left the exact active player dialog",
                        focused.activeDialogs == 1 && focused.nestedDialogs == 0);
                assertTrue("Focusing playing Pause changed the transport state",
                        focused.pauseControls == 1 && focused.playControls == 0);
                assertTrue("Fresh playing Pause was not keyboard-focused",
                        focused.focusedPauseControls == 1);
                assertTrue("Fresh focused playing snapshot omitted a core control",
                        hasCompleteCoreSnapshot(focused));
                recordNativePollSnapshot("pause-focused", focused, reveals);
                checks.put("initialSurfaceRevealUsed", reveals == 1);
                checks.put("initialPlayingControlFocusVerified", true);
                checks.put("initialPlayingStatePreservedAcrossFocus", true);
                return focused;
            }
            if (now - started >= 2_000 && snapshot.playControls == 1) {
                recordNativePollSnapshot("play-observed-before-pause", snapshot, reveals);
                fail("Player exposed Play before a playing Pause state was observed");
            }
            int updatedReveals = now >= revealEligibleAt
                    ? revealPlayerSurfaceOnceIfHidden(
                            reveals, "initial playing transport", snapshot)
                    : reveals;
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(200);
        }
        PlayerAxSnapshot timeout = readPlayerAxSnapshot(false);
        recordNativePollSnapshot("pause-timeout", timeout, reveals);
        fail("Timed out waiting for playing touch-player control after " + reveals + " bounded surface reveals");
        return null;
    }

    private boolean hasCompleteCoreSnapshot(PlayerAxSnapshot snapshot) {
        return snapshot.safetyGuardComplete
                && snapshot.activeDialogs == 1 && snapshot.nestedDialogs == 0
                && snapshot.clockPositionSeconds >= 0 && snapshot.clockTotalSeconds == 30
                && snapshot.backBounds != null && snapshot.playPauseBounds != null
                && snapshot.forwardBounds != null && snapshot.seekBounds != null
                && snapshot.closeBounds != null;
    }

    static boolean shouldRevealPlayerSurface(
            int activeDialogs, int pauseControls, int playControls, int reveals) {
        return activeDialogs == 1 && pauseControls == 0 && playControls == 0
                && reveals < MAX_SURFACE_REVEALS;
    }

    private int revealPlayerSurfaceOnceIfHidden(int reveals, String waitingFor) {
        return revealPlayerSurfaceOnceIfHidden(
                reveals, waitingFor, readPlayerAxSnapshot(false));
    }

    private int revealPlayerSurfaceOnceIfHidden(
            int reveals, String waitingFor, PlayerAxSnapshot snapshot) {
        if (reveals >= MAX_SURFACE_REVEALS) return reveals;
        if (snapshot.nestedDialogs > 0
                || !shouldRevealPlayerSurface(snapshot.activeDialogs,
                        snapshot.pauseControls, snapshot.playControls, reveals)) {
            return reveals;
        }
        int x = device.getDisplayWidth() / 2;
        int y = device.getDisplayHeight() * 45 / 100;
        assertTrue("Native player surface reveal tap failed", device.click(x, y));
        int updatedReveals = reveals + 1;
        surfaceRevealCount++;
        log("Tapped the active player surface once while waiting for " + waitingFor);
        recordNativePollSnapshot("surface-reveal", snapshot, surfaceRevealCount);
        SystemClock.sleep(250);
        return updatedReveals;
    }

    private void recordFailureNativeSnapshot() {
        PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
        recordNativePollSnapshot("failure", snapshot, surfaceRevealCount);
        recordNativeRangeSnapshot(snapshot);
    }

    private void recordNativeRangeSnapshot(PlayerAxSnapshot snapshot) {
        if (nativePollDiagnostics.size() >= MAX_NATIVE_POLL_SNAPSHOTS) {
            nativePollDiagnosticsTruncated = true;
            return;
        }
        float[] range = snapshot.copyNativeRange();
        int currentMillis = range == null ? -1 : Math.round(range[0] * 1_000f);
        int maximumMillis = range == null ? -1 : Math.round(range[1] * 1_000f);
        nativePollDiagnostics.add(String.format(Locale.ROOT,
                "elapsedMs=%d stage=failure-range nativeRangePresent=%d currentMillis=%d maximumMillis=%d semanticClockSeconds=%d focusedPause=%d",
                SystemClock.uptimeMillis() - startedAtMs, range == null ? 0 : 1,
                currentMillis, maximumMillis, snapshot.clockPositionSeconds,
                snapshot.focusedPauseControls));
    }

    private void recordNativePollSnapshot(String stage, PlayerAxSnapshot snapshot, int reveals) {
        if (nativePollDiagnostics.size() >= MAX_NATIVE_POLL_SNAPSHOTS) {
            nativePollDiagnosticsTruncated = true;
            return;
        }
        nativePollDiagnostics.add(String.format(Locale.ROOT,
                "elapsedMs=%d stage=%s activePlayerDialogs=%d pauseToggles=%d playToggles=%d "
                        + "playerSeekBars=%d reveals=%d guardComplete=%d visitedWindowNodes=%d "
                        + "axDisplays=%d axWindows=%d axRoots=%d deduplicatedRoots=%d "
                        + "foregroundGuardMs=%d axReadMs=%d display=%dx%d",
                SystemClock.uptimeMillis() - startedAtMs, safe(stage), snapshot.activeDialogs,
                snapshot.pauseControls, snapshot.playControls, snapshot.seekBars, reveals,
                snapshot.safetyGuardComplete ? 1 : 0, snapshot.visitedWindowNodes,
                snapshot.scannedDisplays, snapshot.scannedWindows,
                snapshot.scannedRoots, snapshot.deduplicatedRoots,
                snapshot.foregroundGuardMs, snapshot.readDurationMs,
                device.getDisplayWidth(), device.getDisplayHeight()));
    }

    private int waitForPlaybackPositionAtLeast(int minimum, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int last = -1;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            last = snapshot.playbackPositionSeconds();
            if (last >= minimum) return last;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(
                    reveals, "playback clock at least " + minimum, snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Native SeekBar position did not reach " + minimum + "; last=" + last);
        return -1;
    }

    private int waitForPlaybackPositionAtMost(int maximum, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int last = -1;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            last = snapshot.playbackPositionSeconds();
            if (last >= 0 && last <= maximum) return last;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(
                    reveals, "playback clock at most " + maximum, snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Native SeekBar position did not fall to " + maximum + "; last=" + last);
        return -1;
    }

    private int waitForStablePausedPlaybackPositionInRange(
            int minimum, int maximum, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        StablePausedPositionGate gate = new StablePausedPositionGate(minimum, maximum, 2);
        int reveals = 0;
        int lastPosition = -1;
        int lastActiveDialogs = 0;
        int lastNestedDialogs = 0;
        int lastPauseControls = 0;
        int lastPlayControls = 0;
        int lastSeekBars = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            lastPosition = snapshot.playbackPositionSeconds();
            lastActiveDialogs = snapshot.activeDialogs;
            lastNestedDialogs = snapshot.nestedDialogs;
            lastPauseControls = snapshot.pauseControls;
            lastPlayControls = snapshot.playControls;
            lastSeekBars = snapshot.seekBars;
            int stablePosition = gate.observe(
                    lastPosition, lastActiveDialogs, lastNestedDialogs,
                    lastPauseControls, lastPlayControls, lastSeekBars);
            if (stablePosition >= 0) return stablePosition;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(
                    reveals, description, snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail(String.format(Locale.ROOT,
                "Timed out waiting for %s in inclusive range [%d,%d] with two stable exact paused observations; "
                        + "lastPosition=%d activeDialogs=%d nestedDialogs=%d pauseControls=%d "
                        + "playControls=%d seekBars=%d candidate=%d consistentObservations=%d",
                description, minimum, maximum, lastPosition, lastActiveDialogs, lastNestedDialogs,
                lastPauseControls, lastPlayControls, lastSeekBars,
                gate.candidatePosition(), gate.consistentObservationCount()));
        return -1;
    }

    private int waitForPlaybackPositionAvailable(long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            int position = snapshot.playbackPositionSeconds();
            if (position >= 0) return position;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, description, snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description + " through the strict native SeekBar semantic value");
        return -1;
    }

    private int waitForStrictTimelineTotal(long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int reveals = 0;
        int lastTotal = -1;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            PlayerAxSnapshot snapshot = readPlayerAxSnapshot(false);
            lastTotal = snapshot.clockTotalSeconds;
            if (lastTotal == 30) return lastTotal;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, description, snapshot);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(250);
        }
        fail("Timed out waiting for " + description + "; last strict semantic total=" + lastTotal);
        return -1;
    }

    private PlayerAxSnapshot readPlayerAxSnapshot(boolean requestPlayingPauseFocus) {
        long readStarted = SystemClock.uptimeMillis();
        PlayerAxSnapshot snapshot = new PlayerAxSnapshot();
        long foregroundStarted = SystemClock.uptimeMillis();
        AxSafetyGuard safetyGuard = new AxSafetyGuard(device.getCurrentPackageName());
        snapshot.foregroundGuardMs = SystemClock.uptimeMillis() - foregroundStarted;
        if (safetyGuard.rejection() != null) fail(safetyGuard.rejection());

        refreshObservation();
        UiAutomation automation = instrumentation.getUiAutomation();
        List<AccessibilityWindowInfo> ownedWindows = new ArrayList<>();
        List<AccessibilityNodeInfo> ownedRoots = new ArrayList<>();
        List<AccessibilityNodeInfo> pauseFocusCandidates = new ArrayList<>();
        try {
            AccessibilityNodeInfo activeRoot = automation.getRootInActiveWindow();
            rememberOwnedReference(ownedRoots, activeRoot);

            SparseArray<List<AccessibilityWindowInfo>> windowsByDisplay =
                    automation.getWindowsOnAllDisplays();
            int displayCount = windowsByDisplay == null ? -1 : windowsByDisplay.size();
            long windowCount = 0;
            boolean malformedWindowInventory = windowsByDisplay == null;
            if (windowsByDisplay != null) {
                for (int displayIndex = 0; displayIndex < windowsByDisplay.size(); displayIndex++) {
                    List<AccessibilityWindowInfo> displayWindows =
                            windowsByDisplay.valueAt(displayIndex);
                    if (displayWindows == null) {
                        malformedWindowInventory = true;
                        continue;
                    }
                    windowCount += displayWindows.size();
                    for (AccessibilityWindowInfo window : displayWindows) {
                        if (window == null) {
                            malformedWindowInventory = true;
                        } else {
                            rememberOwnedReference(ownedWindows, window);
                        }
                    }
                }
            }
            if (malformedWindowInventory) {
                throw new IllegalStateException(
                        "Accessibility all-display window inventory was unavailable or malformed");
            }

            AxWindowRootGraph<AccessibilityNodeInfo> rootGraph =
                    new AxWindowRootGraph<>(
                            displayCount, windowCount,
                            MAX_AX_DISPLAYS, MAX_AX_WINDOWS, MAX_AX_ROOTS, MAX_AX_TOTAL_NODES,
                            PRODUCT_PACKAGE, PLAYER_DIALOG_TITLE);
            rootGraph.addRoot(activeRoot, true);
            for (AccessibilityWindowInfo window : ownedWindows) {
                AccessibilityNodeInfo windowRoot = window.getRoot();
                if (windowRoot == null) continue;
                rememberOwnedReference(ownedRoots, windowRoot);
                rootGraph.addRoot(windowRoot, false);
            }

            int displayWidth = device.getDisplayWidth();
            int displayHeight = device.getDisplayHeight();
            AxNodeReader<AccessibilityNodeInfo> nodeReader =
                    new AxNodeReader<AccessibilityNodeInfo>() {
                @Override
                public String packageName(AccessibilityNodeInfo node) {
                    CharSequence value = node.getPackageName();
                    return value == null ? null : value.toString();
                }

                @Override
                public String className(AccessibilityNodeInfo node) {
                    CharSequence value = node.getClassName();
                    return value == null ? null : value.toString();
                }

                @Override
                public String text(AccessibilityNodeInfo node) {
                    CharSequence value = node.getText();
                    return value == null ? null : value.toString();
                }

                @Override
                public String description(AccessibilityNodeInfo node) {
                    CharSequence value = node.getContentDescription();
                    return value == null ? null : value.toString();
                }

                @Override
                public int childCount(AccessibilityNodeInfo node) {
                    return node.getChildCount();
                }

                @Override
                public AccessibilityNodeInfo childAt(AccessibilityNodeInfo node, int index) {
                    return node.getChild(index);
                }

                @Override
                public void recycle(AccessibilityNodeInfo node) {
                    node.recycle();
                }
            };
            AxActiveNodeObserver<AccessibilityNodeInfo> activeObserver =
                    new AxActiveNodeObserver<AccessibilityNodeInfo>() {
                @Override
                public void observe(
                        AccessibilityNodeInfo node, String packageName, String className,
                        String text, String description,
                        boolean isPlayerDialog, boolean insidePlayer) {
                    boolean exactPackage = PRODUCT_PACKAGE.equals(packageName);
                    if (insidePlayer && exactPackage) {
                        Rect bounds = new Rect();
                        node.getBoundsInScreen(bounds);
                        if (isPlayerDialog) snapshot.playerDialogBounds = new Rect(bounds);
                        String label = text == null ? "" : text;
                        if (label.isEmpty() && description != null) label = description;
                        boolean visible = node.isVisibleToUser();
                        boolean enabled = node.isEnabled();
                        boolean clickable = node.isClickable();
                        if (isNativeActionableClass(className)
                                && isBoundedNativeControl(bounds, visible, enabled, clickable,
                                        displayWidth, displayHeight, 1, 1)) {
                            snapshot.actionableBounds.add(new Rect(bounds));
                        }
                        boolean boundedButton = isBoundedNativeControl(
                                bounds, visible, enabled, clickable,
                                displayWidth, displayHeight, 44, 44);
                        boolean boundedTransport = boundedButton
                                && "android.widget.ToggleButton".equals(className);
                        if (boundedTransport && "Pause".equals(label)) {
                            snapshot.pauseControls++;
                            snapshot.playPauseBounds = uniqueBounds(
                                    snapshot.playPauseBounds, bounds, "Pause");
                            if (node.isFocused()) snapshot.focusedPauseControls++;
                            if (node.isFocusable()) snapshot.focusablePauseControls++;
                            if (requestPlayingPauseFocus && !node.isFocused()) {
                                pauseFocusCandidates.add(AccessibilityNodeInfo.obtain(node));
                            }
                        } else if (boundedTransport && "Play".equals(label)) {
                            snapshot.playControls++;
                            snapshot.playPauseBounds = uniqueBounds(
                                    snapshot.playPauseBounds, bounds, "Play");
                        }
                        if (boundedButton && "Back 10 seconds".equals(label)) {
                            snapshot.backBounds = uniqueBounds(snapshot.backBounds, bounds, label);
                        } else if (boundedButton && "Forward 10 seconds".equals(label)) {
                            snapshot.forwardBounds = uniqueBounds(snapshot.forwardBounds, bounds, label);
                        } else if (boundedButton && "Close player".equals(label)) {
                            snapshot.closeBounds = uniqueBounds(snapshot.closeBounds, bounds, label);
                        }
                        if ("android.widget.SeekBar".equals(className)
                                && isBoundedNativeControl(bounds, visible, enabled, clickable,
                                        displayWidth, displayHeight, 44, 1)) {
                            snapshot.seekBars++;
                            if (snapshot.seekBars > 1) {
                                fail("Multiple strict semantic SeekBars were exposed inside the active player");
                            }
                            int[] semantic = parseStrictSeekSemantic(text, description);
                            if (semantic != null) {
                                snapshot.clockPositionSeconds = semantic[0];
                                snapshot.clockTotalSeconds = semantic[1];
                                snapshot.seekBounds = new Rect(bounds);
                                AccessibilityNodeInfo.RangeInfo range = node.getRangeInfo();
                                if (range != null) {
                                    assertTrue("Native SeekBar range was not finite, bounded, zero-based, and 30 seconds",
                                            isBoundedNativeSeekRange(range, bounds, visible, enabled, clickable,
                                                    displayWidth, displayHeight));
                                    assertTrue("SeekBar aria-valuetext disagreed with its native range",
                                            Math.abs(semantic[0] - range.getCurrent()) <= 1f
                                                    && Math.abs(semantic[1] - range.getMax()) <= 1f);
                                    snapshot.nativeRange = new float[] {
                                            range.getCurrent(), range.getMax() };
                                }
                            }
                        }
                    }
                }
            };

            AxWindowScanResult scanResult =
                    rootGraph.scan(nodeReader, activeObserver, safetyGuard);
            snapshot.activeDialogs = scanResult.activeDialogs;
            snapshot.nestedDialogs = scanResult.nestedDialogs;
            snapshot.scannedDisplays = displayCount;
            snapshot.scannedWindows = (int) windowCount;
            snapshot.scannedRoots = scanResult.rootCount;
            snapshot.deduplicatedRoots = scanResult.deduplicatedRoots;
            snapshot.visitedWindowNodes = scanResult.visitedNodes;
            foregroundStarted = SystemClock.uptimeMillis();
            safetyGuard.observeForegroundPackage(device.getCurrentPackageName());
            snapshot.foregroundGuardMs += SystemClock.uptimeMillis() - foregroundStarted;
            if (safetyGuard.rejection() != null) fail(safetyGuard.rejection());
            assertTrue("Multiple exact active player dialogs were exposed", snapshot.activeDialogs <= 1);
            assertTrue("Multiple exact Pause controls were exposed inside the active player",
                    snapshot.pauseControls <= 1);
            assertTrue("Multiple exact Play controls were exposed inside the active player",
                    snapshot.playControls <= 1);
            assertTrue("Multiple SeekBars were exposed inside the active player", snapshot.seekBars <= 1);
            assertTrue("Active player exposed both Play and Pause",
                    snapshot.pauseControls == 0 || snapshot.playControls == 0);
            if (snapshot.activeDialogs != 1 || snapshot.nestedDialogs != 0) {
                snapshot.clockPositionSeconds = -1;
                snapshot.clockTotalSeconds = -1;
                snapshot.nativeRange = null;
                snapshot.seekBounds = null;
            } else if (snapshot.clockPositionSeconds >= 0) {
                strictSeekSemanticObserved = true;
                if (snapshot.nativeRange != null) nativeSeekRangeObserved = true;
            }
            snapshot.safetyGuardComplete = scanResult.allRootsVerified;
            if (requestPlayingPauseFocus
                    && canPerformPauseFocus(
                            scanResult, safetyGuard,
                            snapshot.activeDialogs, snapshot.nestedDialogs,
                            snapshot.pauseControls, snapshot.playControls,
                            snapshot.focusedPauseControls)) {
                assertTrue("Exact playing Pause was not keyboard-focusable",
                        snapshot.focusablePauseControls == 1 && pauseFocusCandidates.size() == 1);
                snapshot.pauseFocusActionAttempted = true;
                snapshot.pauseFocusActionSucceeded = pauseFocusCandidates.get(0)
                        .performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            }
            snapshot.readDurationMs = SystemClock.uptimeMillis() - readStarted;
            return snapshot;
        } finally {
            for (AccessibilityNodeInfo node : pauseFocusCandidates) node.recycle();
            for (AccessibilityNodeInfo node : ownedRoots) node.recycle();
            for (AccessibilityWindowInfo window : ownedWindows) window.recycle();
        }
    }

    private static <T> void rememberOwnedReference(List<T> owned, T candidate) {
        if (candidate == null) return;
        for (T existing : owned) {
            if (existing == candidate) return;
        }
        owned.add(candidate);
    }

    private Rect uniqueBounds(Rect existing, Rect observed, String label) {
        if (existing != null) fail("Multiple bounded controls exposed for exact label: " + label);
        return new Rect(observed);
    }

    private static boolean isNativeActionableClass(String className) {
        return "android.widget.Button".equals(className)
                || "android.widget.ImageButton".equals(className)
                || "android.widget.ToggleButton".equals(className)
                || "android.widget.SeekBar".equals(className);
    }

    static int[] parseStrictSeekSemantic(String text, String description) {
        String exactText = text == null ? "" : text;
        String exactDescription = description == null ? "" : description;
        Matcher matcher;
        if (exactDescription.isEmpty()) {
            matcher = SEEK_VALUE_WITH_NAME.matcher(exactText);
        } else if ("Seek".equals(exactDescription)) {
            matcher = SEEK_VALUE_ONLY.matcher(exactText);
        } else {
            return null;
        }
        if (!matcher.matches()) return null;
        int currentMinutes = Integer.parseInt(matcher.group(1));
        int currentRemainder = Integer.parseInt(matcher.group(2));
        int totalMinutes = Integer.parseInt(matcher.group(3));
        int totalRemainder = Integer.parseInt(matcher.group(4));
        if (currentRemainder > 59 || totalRemainder > 59) return null;
        int current = currentMinutes * 60 + currentRemainder;
        int total = totalMinutes * 60 + totalRemainder;
        if (total != 30 || current < 0 || current > total) return null;
        return new int[] { current, total };
    }

    static boolean isBoundedNativeSeekRange(
            AccessibilityNodeInfo.RangeInfo range, Rect bounds, boolean visible, boolean enabled,
            boolean clickable, int displayWidth, int displayHeight) {
        if (range == null || !isBoundedNativeControl(bounds, visible, enabled, clickable,
                displayWidth, displayHeight, 44, 1)) return false;
        return isBoundedNativeSeekRangeValues(
                range.getMin(), range.getCurrent(), range.getMax(),
                bounds.left, bounds.top, bounds.right, bounds.bottom,
                displayWidth, displayHeight);
    }

    static boolean isBoundedNativeSeekRangeValues(
            float minimum, float current, float maximum,
            int left, int top, int right, int bottom, int displayWidth, int displayHeight) {
        return Float.isFinite(minimum) && Float.isFinite(current) && Float.isFinite(maximum)
                && minimum == 0f && maximum == 30f
                && current >= minimum && current <= maximum
                && left >= 0 && top >= 0 && right <= displayWidth && bottom <= displayHeight
                && right - left >= 44 && bottom - top > 0;
    }

    static boolean isBoundedNativeControl(
            Rect bounds, boolean visible, boolean enabled, boolean clickable,
            int displayWidth, int displayHeight, int minimumWidth, int minimumHeight) {
        return bounds != null && visible && enabled && clickable
                && bounds.left >= 0 && bounds.top >= 0
                && bounds.right <= displayWidth && bounds.bottom <= displayHeight
                && bounds.width() >= minimumWidth && bounds.height() >= minimumHeight;
    }

    private void refreshObservation() {
        instrumentation.getUiAutomation().clearCache();
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

    private int activePlayerDialogCount() {
        int count = 0;
        for (UiObject2 candidate : device.findObjects(
                By.clazz("android.app.Dialog").pkg(PRODUCT_PACKAGE))) {
            if (isActivePlayerDialog(candidate)) count++;
        }
        return count;
    }

    private boolean isActivePlayerDialog(UiObject2 candidate) {
        return candidate != null
                && PRODUCT_PACKAGE.equals(candidate.getApplicationPackage())
                && "android.app.Dialog".equals(candidate.getClassName())
                && PLAYER_DIALOG_TITLE.equals(candidate.getText());
    }

    private boolean isInsideActivePlayerDialog(UiObject2 node) {
        UiObject2 current = node;
        for (int depth = 0; depth < 20 && current != null; depth++) {
            if (isActivePlayerDialog(current)) return true;
            current = current.getParent();
        }
        return false;
    }

    private List<UiObject2> playerTransportCandidates(String label) {
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 candidate : device.findObjects(
                By.clazz("android.widget.ToggleButton").pkg(PRODUCT_PACKAGE))) {
            if (!label.equals(candidate.getText()) && !label.equals(candidate.getContentDescription())) continue;
            if (!candidate.isClickable() || !candidate.isEnabled()) continue;
            if (!isInsideActivePlayerDialog(candidate)) continue;
            Rect bounds = candidate.getVisibleBounds();
            if (!isBoundedVisibleTarget(bounds, 44, 44)) continue;
            candidates.add(candidate);
        }
        return candidates;
    }

    private UiObject2 findPlayerTransport(String label) {
        refreshObservation();
        assertTrue("Ambiguous active player dialogs", activePlayerDialogCount() <= 1);
        List<UiObject2> candidates = playerTransportCandidates(label);
        if (candidates.size() > 1) fail("Ambiguous active-player transport controls for exact label: " + label);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 waitForPlayerTransport(String label, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 found = findPlayerTransport(label);
            if (found != null) return found;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, description);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for active-player " + description);
        return null;
    }

    private void clickPlayerTransport(String label, String description, long timeoutMs) {
        guardedClick(waitForPlayerTransport(label, timeoutMs, description), description);
    }

    private UiObject2 findPlayerLabeledClickable(String label) {
        refreshObservation();
        Pattern pattern = exactLabel(label);
        List<UiObject2> labeled = new ArrayList<>();
        collectClickableAncestors(labeled, device.findObjects(By.text(pattern).pkg(PRODUCT_PACKAGE)));
        collectClickableAncestors(labeled, device.findObjects(By.desc(pattern).pkg(PRODUCT_PACKAGE)));
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 candidate : labeled) {
            if (!isInsideActivePlayerDialog(candidate)) continue;
            Rect bounds = candidate.getVisibleBounds();
            if (!isBoundedVisibleTarget(bounds, 1, 1)) continue;
            candidates.add(candidate);
        }
        if (candidates.size() > 1) fail("Ambiguous active-player controls for exact label: " + label);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 findPlayerLabeledClickableAny(String... labels) {
        List<UiObject2> candidates = new ArrayList<>();
        for (String label : labels) {
            UiObject2 candidate = findPlayerLabeledClickable(label);
            if (candidate == null) continue;
            boolean duplicate = false;
            for (UiObject2 existing : candidates) {
                if (existing.getVisibleBounds().equals(candidate.getVisibleBounds())) duplicate = true;
            }
            if (!duplicate) candidates.add(candidate);
        }
        if (candidates.size() > 1) fail("Ambiguous active-player controls for accepted labels");
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private UiObject2 waitForPlayerLabeledClickable(String label, long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            UiObject2 found = findPlayerLabeledClickable(label);
            if (found != null) return found;
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, description);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for active-player " + description);
        return null;
    }

    private void clickPlayerLabeled(String label, String description, long timeoutMs) {
        guardedClick(waitForPlayerLabeledClickable(label, timeoutMs, description), description);
    }

    private List<UiObject2> playerSeekBarCandidates() {
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 candidate : device.findObjects(
                By.clazz("android.widget.SeekBar").pkg(PRODUCT_PACKAGE))) {
            if (!candidate.isClickable() || !candidate.isEnabled()) continue;
            if (!isInsideActivePlayerDialog(candidate)) continue;
            Rect bounds = candidate.getVisibleBounds();
            if (!isBoundedVisibleTarget(bounds, 44, 1)) continue;
            candidates.add(candidate);
        }
        return candidates;
    }

    private UiObject2 waitForPlayerSeekBar(long timeoutMs, String description) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        int reveals = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            assertNoOutOfScopeApproval();
            refreshObservation();
            assertTrue("Ambiguous active player dialogs", activePlayerDialogCount() <= 1);
            List<UiObject2> candidates = playerSeekBarCandidates();
            if (candidates.size() > 1) fail("Ambiguous SeekBars inside the active player");
            if (candidates.size() == 1) return candidates.get(0);
            int updatedReveals = revealPlayerSurfaceOnceIfHidden(reveals, description);
            if (updatedReveals != reveals) {
                reveals = updatedReveals;
                continue;
            }
            SystemClock.sleep(200);
        }
        fail("Timed out waiting for active-player " + description);
        return null;
    }

    private boolean isBoundedVisibleTarget(Rect bounds, int minimumWidth, int minimumHeight) {
        return bounds != null
                && bounds.left >= 0 && bounds.top >= 0
                && bounds.right <= device.getDisplayWidth()
                && bounds.bottom <= device.getDisplayHeight()
                && bounds.width() >= minimumWidth && bounds.height() >= minimumHeight;
    }

    private void collectClickableAncestors(List<UiObject2> candidates, List<UiObject2> matches) {
        for (UiObject2 match : matches) {
            UiObject2 current = match;
            for (int depth = 0; depth < 6 && current != null; depth++) {
                if (current.isClickable() && current.isEnabled()) break;
                current = current.getParent();
            }
            if (current == null || !current.isClickable() || !current.isEnabled()) continue;
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
        if (isBlockedApprovalPackage(foreground)) {
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
        String observationBasis = !strictSeekSemanticObserved
                ? "none"
                : nativeSeekRangeObserved
                        ? "native-seekbar-range-plus-aria-valuetext"
                        : "native-seekbar-aria-valuetext";
        checks.put("strictSeekSemanticObserved", strictSeekSemanticObserved);
        checks.put("nativeSeekRangeObserved", nativeSeekRangeObserved);
        checks.put("playbackClockObservationBasis", observationBasis);
        boolean nativeDoubleTapInjectionUsed =
                Boolean.TRUE.equals(checks.get("nativeDoubleTapInjectionUsed"));
        String doubleTapObservationBasis = nativeDoubleTapInjectionUsed
                ? "uiautomation-motion-event-source-touchscreen-uptime"
                : "none";
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
        receipt.put("strictSeekSemanticObserved", strictSeekSemanticObserved);
        receipt.put("nativeSeekRangeObserved", nativeSeekRangeObserved);
        receipt.put("playbackClockObservationBasis", observationBasis);
        receipt.put("nativeDoubleTapInjectionUsed", nativeDoubleTapInjectionUsed);
        receipt.put("doubleTapObservationBasis", doubleTapObservationBasis);
        receipt.put("evidenceStatus", "provisional");
        receipt.put("decodedPlaybackClaimed", false);
        receipt.put("manualDecodedPlaybackReviewRequired", true);
        receipt.put("manualDecodedPlaybackReviewCaptureLabels",
                new JSONArray().put("playing-clock-initial").put("playing-clock-advanced"));
        receipt.put("manualGestureReviewRequired", true);
        receipt.put("manualGestureReviewCaptureLabels",
                new JSONArray().put("before-side-double-tap").put("after-side-double-tap"));
        receipt.put("manualRotationPixelReviewRequired", true);
        receipt.put("manualRotationPixelReviewCaptureLabels", new JSONArray()
                .put("landscape-controls")
                .put("landscape-controls-settled-1")
                .put("landscape-controls-settled-2")
                .put("portrait-return-controls")
                .put("portrait-return-controls-settled"));
        receipt.put("rotationPixelLayoutClaimed", false);
        receipt.put("rotationGeometryObservationBasis",
                "two-fresh-guarded-paused-native-AX-snapshots-with-matching-core-bounds-and-display-at-least-500ms-apart");
        receipt.put("decodeBasis", "Automated accessibility clocks and server receipts are provisional; retained before/after PNG pixels require root manual review before any decoded-playback claim");
        if (failure != null) {
            receipt.put("failureNativePollDiagnostics", new JSONArray(nativePollDiagnostics));
            receipt.put("nativePollDiagnosticsTruncated", nativePollDiagnosticsTruncated);
        }
        writeBounded(new File(evidenceDir, "instrumentation-touch-player-receipt.json"),
                receipt.toString(2) + "\n", 32 * 1024);
    }

    private static void writeBounded(File file, String value, int maxBytes) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) throw new IOException("Evidence text exceeded bound for " + file.getName());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }
}
