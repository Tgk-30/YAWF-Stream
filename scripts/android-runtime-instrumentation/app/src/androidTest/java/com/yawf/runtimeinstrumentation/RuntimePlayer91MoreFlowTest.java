package com.yawf.runtimeinstrumentation;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Build;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/** One black-box hosted More transaction. No WebView evaluation or application-state writes. */
@RunWith(AndroidJUnit4.class)
public final class RuntimePlayer91MoreFlowTest {
    private static final String PRODUCT = "com.tgk30.debridstreamer";
    private static final String FOLDER = "player91-more";
    private static final String ORIGIN = "http://127.0.0.1:43120";
    private static final String USER = "fixture-owner";
    private static final String PASSWORD = "fixture-owner-password";
    private static final String TITLE = "Synthetic Fixture Movie";
    private static final String PLAYER = "Playing Synthetic Fixture Movie (2026)";
    private static final String CONNECT = "Connect to a server Already have a server or an invite link? Paste the address and sign in.";
    private static final String SOURCE = "1080p Synthetic Fixture Movie 2026 1080p WEB-DL x264 Synthetic Fixture Movie 2026 1080p WEB-DL x264 1080p · H.264 · WEB-DL · - · 0 seeders · Synthetic Fixture Cache unknown";
    private static final Pattern TERMS = Pattern.compile("(?is).*\\b(?:terms of service|license agreement|user agreement|binding terms)\\b.*");
    private final JSONArray phases = new JSONArray();
    private final JSONArray inputs = new JSONArray();
    private Instrumentation instrumentation;
    private UiAutomation automation;
    private UiDevice device;
    private File folder;
    private long started;
    private String phase = "initializing";
    private int captures;
    private int initialClockObservationCount;
    private int sourceClicks;
    private int clockBefore = -1;
    private int clockAfter = -1;
    private boolean menuHeading;
    private boolean uniqueMenu;
    private boolean terminalInputFailure;
    private Rect menuBounds;
    private boolean chromeRevealPerformed;
    private final Set<String> chromeRevealEpochs = new HashSet<>();
    private long chromeRevealUp = -1;
    private final JSONArray chromeAbsenceObservations = new JSONArray();
    private long moreAcquisitionStarted = -1, moreAcquired = -1, moreDownAttempt = -1;
    private JSONObject moreAcquisitionProof;
    private int usernameFocusClicks, passwordFocusClicks, usernameTextSends, passwordTextSends;
    private boolean usernameCommittedBeforePassword, usernameCommittedAfterPassword, passwordTextSendReturned;

    @Test
    public void production91OpensMoreMenuOnlyWithNativeFinger() throws Throwable { runCase(true); }

    private void runCase(boolean menuOnly) throws Throwable {
        assertTrue("Only the versioned menu-only gate is admitted", menuOnly);
        instrumentation = InstrumentationRegistry.getInstrumentation();
        automation = instrumentation.getUiAutomation();
        device = UiDevice.getInstance(instrumentation);
        started = SystemClock.uptimeMillis();
        assertEquals("Only the fixed evidence profile is admitted", FOLDER,
                InstrumentationRegistry.getArguments().getString("evidenceSubdir", FOLDER));
        folder = new File(instrumentation.getTargetContext().getFilesDir(), FOLDER);
        assertTrue("Evidence directory must be new", folder.mkdir());
        long oldIdle = Configurator.getInstance().getWaitForIdleTimeout();
        String outcome = "FAIL";
        try {
            assertEquals(36, Build.VERSION.SDK_INT);
            assertEquals("x86_64", Build.SUPPORTED_ABIS[0]);
            assertEquals("ranchu", Build.HARDWARE);
            // A single UiAutomation owner is kept for setup, observations and SDK input.
            Configurator.getInstance().setWaitForIdleTimeout(0);
            if (menuOnly) flowMenuOnly(); else flow();
            outcome = "PASS";
        } catch (Throwable failure) {
            try { capture("failure"); } catch (Throwable unavailable) { /* The host also captures failure before cleanup. */ }
            throw failure;
        } finally {
            Configurator.getInstance().setWaitForIdleTimeout(oldIdle);
            JSONObject receipt = new JSONObject();
            receipt.put("schemaVersion", 1).put("profile", menuOnly ? "private91-hosted-menu-only" : "private91-hosted-more")
                    .put("outcome", outcome).put("phase", phase).put("durationMs", SystemClock.uptimeMillis() - started)
                    .put("sourceClicks", sourceClicks).put("explicitSourceRow", sourceClicks == 1)
                    .put("menuOnlyQualified", menuOnly && outcome.equals("PASS"))
                    .put("clockProgressQualified", !menuOnly && outcome.equals("PASS"))
                    .put("playbackContinuityQualified", false).put("initialClockObservationCount", initialClockObservationCount)
                    .put("clockBeforeSeconds", clockBefore).put("clockAfterSeconds", clockAfter)
                    .put("menuHeading", menuHeading).put("uniqueMenu", uniqueMenu)
                    .put("menuBounds", menuBounds == null ? JSONObject.NULL : rect(menuBounds))
                    .put("chromeRevealPerformed", chromeRevealPerformed).put("chromeRevealUpUptimeMs", chromeRevealUp)
                    .put("chromeRevealCount", chromeRevealEpochs.size())
                    .put("chromeAbsenceObservations", chromeAbsenceObservations)
                    .put("moreAcquisitionStartedUptimeMs", moreAcquisitionStarted).put("moreAcquiredUptimeMs", moreAcquired)
                    .put("moreDownAttemptUptimeMs", moreDownAttempt).put("moreWindowLimitMs", 1_200)
                    .put("moreAcquisition", moreAcquisitionProof)
                    .put("inputs", inputs).put("phases", phases).put("captures", captures)
                    .put("textEntryMethod", "UiObject2.click+Instrumentation.sendStringSync")
                    .put("usernameFocusClicks", usernameFocusClicks).put("passwordFocusClicks", passwordFocusClicks)
                    .put("usernameTextSends", usernameTextSends).put("passwordTextSends", passwordTextSends)
                    .put("usernameCommittedBeforePassword", usernameCommittedBeforePassword)
                    .put("usernameCommittedAfterPassword", usernameCommittedAfterPassword)
                    .put("passwordTextSendReturned", passwordTextSendReturned)
                    .put("decodedImageReviewRequired", true).put("bundledPlaybackClaimed", false)
                    .put("externalPlayerClaimed", false).put("singleUiAutomationOwner", true);
            write("receipt.json", receipt.toString(2));
        }
    }

    private void ordinarySetupAndSource() throws Exception {
        step("launch");
        instrumentation.getTargetContext().startActivity(new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(PRODUCT, PRODUCT + ".MainActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        long deadline = now() + 60_000;
        while (now() < deadline) {
            fresh();
            guard();
            if (text("How do you want to use YAWF Stream?") != null) break;
            if (text("Enable Android update checks?") != null) {
                click("NOT NOW", 3_000);
            } else if (text("Welcome to YAWF Stream") != null && clickable("Skip") != null) {
                click("Skip", 3_000);
            }
            SystemClock.sleep(200);
        }
        requireText("How do you want to use YAWF Stream?", 1_000);
        capture("onboarding");
        click(CONNECT, 10_000);
        requireText("Server address", 10_000);
        fields(1).get(0).setText(ORIGIN);
        dismissIme();
        click("Open server", 10_000);
        requireText("Sign in", 20_000);
        focusLoginField(0);
        usernameTextSends++;
        instrumentation.sendStringSync(USER);
        usernameCommittedBeforePassword = waitForUsernameCommit();
        assertTrue("Synthetic username did not commit before password entry", usernameCommittedBeforePassword);
        focusLoginField(1);
        passwordTextSends++;
        instrumentation.sendStringSync(PASSWORD);
        passwordTextSendReturned = true;
        usernameCommittedAfterPassword = waitForUsernameCommit();
        assertTrue("Synthetic username changed during password entry", usernameCommittedAfterPassword);
        dismissIme();
        click("Sign in", 5_000);
        step("hosted-signed-in");
        requireText("Watchlist", 20_000);
        long tourDeadline = now() + 3_000;
        while (now() < tourDeadline) {
            fresh(); guard();
            String skip = clickable("Skip the tour") != null ? "Skip the tour" : "Skip tour";
            if (clickable(skip) != null) { click(skip, 500); break; }
            SystemClock.sleep(150);
        }
        capture("signed-in");
        click("Watchlist", 8_000);
        click(TITLE, 8_000);
        requireText(TITLE, 8_000);
        UiObject2 source = null;
        for (int attempt = 0; attempt < 8; attempt++) {
            fresh(); guard();
            source = clickable(SOURCE);
            if (source != null) break;
            List<UiObject2> scrolls = device.findObjects(By.pkg(PRODUCT).scrollable(true));
            assertEquals("Expected one owned Detail scroll container", 1, scrolls.size());
            scrolls.get(0).scroll(Direction.DOWN, 0.65f);
        }
        assertNotNull("Missing unique explicit stream row; hero Play is not admitted", source);
        step("explicit-source");
        capture("explicit-source");
        sourceClicks++;
        tapObject(source, "explicit-source");
        waitPlayer(15_000);
    }

    private void flow() throws Exception {
        ordinarySetupAndSource();
        step("playing");
        fresh(); guard();
        revealChromeForObservation("clock-before");
        long clockDeadline = now() + 10_000;
        while (now() < clockDeadline) {
            fresh(); guard();
            clockBefore = clock();
            if (clockBefore > 0 && clockBefore < 25) break;
            SystemClock.sleep(200);
        }
        assertTrue("A nonzero initial media clock was not observed", clockBefore > 0 && clockBefore < 25);
        capture("clock-before", false);
        SystemClock.sleep(2_200);
        fresh(); guard();
        revealChromeForObservation("clock-after");
        clockAfter = clock();
        assertTrue("Rendered playback clock did not advance", clockAfter >= clockBefore + 1 && clockAfter < 30);
        capture("clock-after", false);
        step("more-transaction");
        // No reveal is admitted here: the two clock epochs have already finished.
        fresh(); guard();
        UiObject2 more = clickable("Playback settings");
        assertNotNull("More is no longer freshly visible after clock observation; no third reveal is admitted", more);
        if (chromeRevealPerformed) assertTrue("More acquisition exceeded the auto-hide window", now() - chromeRevealUp < 3_200);
        tapObject(more, "more");
        long menuDeadline = now() + 3_000;
        while (now() < menuDeadline) {
            fresh(); guard();
            UiObject2 menu = dialog("Playback settings");
            if (menu != null) {
                menuBounds = menu.getVisibleBounds();
                List<UiObject2> headings = menu.findObjects(By.text(exact("Playback settings")));
                assertEquals("More requires its actual unique heading", 1, headings.size());
                assertVisible(headings.get(0));
                uniqueMenu = true; menuHeading = true;
                break;
            }
            SystemClock.sleep(100);
        }
        assertTrue("The native More activation did not open the Playback settings dialog", uniqueMenu && menuHeading);
        capture("more-open");
        step("complete");
    }

    private void flowMenuOnly() throws Exception {
        ordinarySetupAndSource();
        step("menu-only-player");
        fresh(); guardMenuOnlyPlayer();
        observeInitialClockAX();
        Rect bounds = waitForTwoFreshChromeAbsentObservations();
        assertFalse("Exactly one menu-only reveal is admitted", chromeRevealPerformed);
        step("more-transaction");
        chromeRevealPerformed = true;
        chromeRevealEpochs.add("menu-only");
        int screenWidth = device.getDisplayWidth(), screenHeight = device.getDisplayHeight();
        finger(bounds.left + bounds.width() * 0.5f, bounds.top + bounds.height() * 0.32f, "reveal", bounds, "menu-only");
        chromeRevealUp = inputs.getJSONObject(inputs.length() - 1).getJSONArray("eventUptimeMs").getLong(2);
        // One shared post-reveal/pre-More root, then copied data only until DOWN.
        moreAcquisitionStarted = now();
        AcquiredMore more = acquireMoreOnce(screenWidth, screenHeight);
        moreAcquired = now();
        JSONObject reveal = inputs.getJSONObject(inputs.length() - 1);
        assertTrue("Shared root must follow the actual reveal UP", moreAcquired >= chromeRevealUp);
        assertTrue("Shared foreground root must contain the acknowledged reveal point",
                more.root.contains((int) reveal.getDouble("x"), (int) reveal.getDouble("y")));
        assertTrue("Reveal requires acknowledged DOWN and UP before shared proof", reveal.getBoolean("downAcknowledged") && reveal.getBoolean("upAcknowledged"));
        more.admit(more.target.exactCenterX(), more.target.exactCenterY());
        moreAcquisitionProof = more.proof();
        reveal.put("foregroundTargetAfter", true).put("ok", true).put("foregroundAfterUptimeMs", moreAcquired);
        assertTrue("Diagnostic geometry captured; More DOWN intentionally not admitted", false);
        finger(more.target.exactCenterX(), more.target.exactCenterY(), "more", more.target, null, more);
        long deadline = now() + 3_000;
        while (now() < deadline) {
            fresh(); guard();
            UiObject2 menu = dialog("Playback settings");
            if (menu != null) {
                menuBounds = menu.getVisibleBounds();
                List<UiObject2> headings = menu.findObjects(By.text(exact("Playback settings")));
                assertEquals("More requires its actual unique heading", 1, headings.size());
                assertVisible(headings.get(0));
                uniqueMenu = true; menuHeading = true; break;
            }
            SystemClock.sleep(100);
        }
        assertTrue("The native More activation did not open the Playback settings dialog", uniqueMenu && menuHeading);
        capture("more-open");
        step("complete");
    }

    private Rect waitForTwoFreshChromeAbsentObservations() throws Exception {
        long deadline = now() + 10_000;
        int consecutive = 0;
        do {
            fresh(); guardMenuOnlyPlayer();
            boolean visible = playerChromeVisible();
            chromeAbsenceObservations.put(new JSONObject().put("uptimeMs", now()).put("visible", visible).put("cacheRefreshed", true));
            consecutive = visible ? 0 : consecutive + 1;
            if (consecutive == 2) return player().getVisibleBounds();
            SystemClock.sleep(200);
        } while (now() < deadline);
        throw new AssertionError("Two consecutive fresh chrome-absent AX observations were not established; no reveal admitted");
    }

    static final class AcquisitionPolicy {
        int nodes, deepest;
        void visit(int depth) {
            if (depth < 0 || depth > 32 || ++nodes > 512) throw new IllegalStateException("Acquisition traversal bound exceeded");
            deepest = Math.max(deepest, depth);
        }
        static void owner(String pkg, boolean visible, int window) {
            if (!PRODUCT.equals(pkg) || !visible || window < 0) throw new IllegalStateException("Acquisition owner unavailable");
        }
        static boolean player(String pkg, String clazz, String text) {
            return PRODUCT.equals(pkg) && "android.app.Dialog".equals(clazz) && PLAYER.equals(text);
        }
        static boolean more(String pkg, String text, String description) {
            return PRODUCT.equals(pkg) && ("Playback settings".equals(text) || "Playback settings".equals(description));
        }
        static void windows(int root, int player, int target) {
            if (root < 0 || player != root || target != root) throw new IllegalStateException("Acquisition window changed");
        }
        static void ancestor(int distance, boolean inside) {
            if (distance < 0 || distance > 6 || !inside) throw new IllegalStateException("More ancestor escaped player");
        }
        static void unique(int players, int targets) {
            if (players != 1 || targets != 1) throw new IllegalStateException("Missing or ambiguous player/More");
        }
    }

    private static final class AcquiredMore {
        final Rect root, player, target;
        final int window, playerWindow, targetWindow, width, height, nodes, depth, ancestor, identity;
        AcquiredMore(Rect root, Rect player, Rect target, int window, int width, int height,
                     int nodes, int depth, int ancestor, int identity, int playerWindow, int targetWindow) {
            this.root = new Rect(root); this.player = new Rect(player); this.target = new Rect(target);
            this.window = window; this.playerWindow = playerWindow; this.targetWindow = targetWindow; this.width = width; this.height = height;
            this.nodes = nodes; this.depth = depth; this.ancestor = ancestor; this.identity = identity;
        }
        void admit(float x, float y) {
            AcquisitionPolicy.windows(window, playerWindow, targetWindow);
            assertTrue("Copied root/player/More bounds invalid", width > 0 && height > 0 &&
                    !root.isEmpty() && root.left >= 0 && root.top >= 0 && root.right <= width && root.bottom <= height &&
                    !player.isEmpty() && root.contains(player) && !target.isEmpty() && player.contains(target) &&
                    x >= target.left && x < target.right && y >= target.top && y < target.bottom);
        }
        JSONObject proof() throws Exception {
            return new JSONObject().put("rootPackageMatches", true).put("playerPackageMatches", true).put("targetPackageMatches", true)
                    .put("rootWindowId", window).put("playerWindowId", playerWindow).put("targetWindowId", targetWindow)
                    .put("rootBounds", rect(root)).put("playerBounds", rect(player)).put("targetBounds", rect(target))
                    .put("screenWidth", width).put("screenHeight", height).put("nodesVisited", nodes).put("maxDepth", depth)
                    .put("ancestorDistance", ancestor).put("targetIdentity", identity).put("playerCount", 1).put("targetCount", 1)
                    .put("clearCacheCount", 1).put("activeRootCount", 1);
        }
    }
    private static final class MoreScan {
        final AcquisitionPolicy policy = new AcquisitionPolicy();
        final Rect root;
        final int window, width, height;
        int players, targets, ancestor, playerWindow = -1, targetWindow = -1;
        Rect player, target;
        AccessibilityNodeInfo identity;
        MoreScan(Rect root, int window, int width, int height) { this.root = root; this.window = window; this.width = width; this.height = height; }
    }
    // Diagnostic evidence uses only this already acquired snapshot, never another SDK query.
    private void persistRawMoreGeometry(MoreScan scan, String stage) throws Exception {
        persistRawMoreGeometry(scan, stage, scan.target, scan.targetWindow);
    }
    private void persistRawMoreGeometry(MoreScan scan, String stage, Rect target, int targetWindow) throws Exception {
        JSONObject raw = new JSONObject().put("schemaVersion", 1).put("diagnosticOnly", true)
                .put("productQualified", false).put("stage", stage).put("uptimeMs", now())
                .put("rootBounds", rect(scan.root)).put("rootWindowId", scan.window)
                .put("playerBounds", scan.player == null ? JSONObject.NULL : rect(scan.player)).put("playerWindowId", scan.playerWindow)
                .put("moreBounds", target == null ? JSONObject.NULL : rect(target)).put("moreWindowId", targetWindow)
                .put("displayWidth", scan.width).put("displayHeight", scan.height)
                .put("screenBounds", new JSONArray().put(0).put(0).put(scan.width).put(scan.height))
                .put("nodesVisited", scan.policy.nodes).put("maxDepth", scan.policy.deepest)
                .put("playerCount", scan.players).put("targetCount", scan.targets)
                .put("moreDownAttemptUptimeMs", moreDownAttempt).put("additionalSDKQueries", 0);
        write("more-acquisition-raw.json", raw.toString(2));
    }
    private AcquiredMore acquireMoreOnce(int width, int height) throws Exception {
        assertTrue("Public API36 cache refresh failed", automation.clearCache());
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        assertNotNull("The owned active root is unavailable", root);
        MoreScan scan = null;
        try {
            AcquisitionPolicy.owner(String.valueOf(root.getPackageName()), root.isVisibleToUser(), root.getWindowId());
            Rect bounds = new Rect(); root.getBoundsInScreen(bounds);
            scan = new MoreScan(bounds, root.getWindowId(), width, height);
            persistRawMoreGeometry(scan, "root-before-containment");
            assertTrue("Invalid active root bounds", !bounds.isEmpty() && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width && bounds.bottom <= height);
            scanMore(root, new ArrayList<>(), -1, null, scan);
            AcquisitionPolicy.unique(scan.players, scan.targets);
            return new AcquiredMore(bounds, scan.player, scan.target, scan.window, width, height,
                    scan.policy.nodes, scan.policy.deepest, scan.ancestor, scan.identity.hashCode(), scan.playerWindow, scan.targetWindow);
        } finally {
            if (scan != null && scan.identity != null) scan.identity.recycle();
            root.recycle();
        }
    }
    private void scanMore(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> path, int playerIndex, Rect playerBounds, MoreScan scan) throws Exception {
        scan.policy.visit(path.size());
        path.add(node);
        try {
            String pkg = String.valueOf(node.getPackageName()), clazz = String.valueOf(node.getClassName());
            String text = node.getText() == null ? null : node.getText().toString();
            String description = node.getContentDescription() == null ? null : node.getContentDescription().toString();
            if ("android.app.Dialog".equals(clazz) && PLAYER.equals(text)) {
                assertTrue("Wrong player package or identity", AcquisitionPolicy.player(pkg, clazz, text));
                AcquisitionPolicy.owner(pkg, node.isVisibleToUser(), node.getWindowId());
                assertEquals("Player escaped active window", scan.window, node.getWindowId());
                assertEquals("Ambiguous exact player", 1, ++scan.players);
                playerBounds = new Rect(); node.getBoundsInScreen(playerBounds);
                scan.player = new Rect(playerBounds); scan.playerWindow = node.getWindowId();
                persistRawMoreGeometry(scan, "player-before-containment");
                assertTrue("Player escaped active root", !playerBounds.isEmpty() && scan.root.contains(playerBounds));
                playerIndex = path.size() - 1;
            }
            if (playerIndex >= 0 && ("Playback settings".equals(text) || "Playback settings".equals(description))) {
                assertTrue("Wrong More package or identity", AcquisitionPolicy.more(pkg, text, description));
                AcquisitionPolicy.owner(pkg, node.isVisibleToUser(), node.getWindowId());
                boolean found = false;
                for (int index = path.size() - 1, distance = 0; index >= playerIndex && distance <= 6; index--, distance++) {
                    AccessibilityNodeInfo candidate = path.get(index);
                    if (!candidate.isEnabled() || !candidate.isClickable()) continue;
                    AcquisitionPolicy.ancestor(distance, index >= playerIndex);
                    int targetWindow = candidate.getWindowId();
                    AcquisitionPolicy.owner(String.valueOf(candidate.getPackageName()), candidate.isVisibleToUser(), targetWindow);
                    AcquisitionPolicy.windows(scan.window, node.getWindowId(), targetWindow);
                    Rect target = new Rect(); candidate.getBoundsInScreen(target);
                    persistRawMoreGeometry(scan, "more-before-containment", target, targetWindow);
                    assertTrue("More escaped player", !target.isEmpty() && playerBounds.contains(target));
                    if (scan.identity == null) {
                        scan.identity = AccessibilityNodeInfo.obtain(candidate); scan.target = target;
                        scan.targets = 1; scan.ancestor = distance; scan.targetWindow = targetWindow;
                    } else assertTrue("Ambiguous More target", scan.identity.equals(candidate));
                    found = true; break;
                }
                assertTrue("No enabled clickable More ancestor within player", found);
            }
            int children = node.getChildCount();
            assertTrue("Child count exceeds the bounded snapshot", children >= 0 && children <= 512);
            for (int index = 0; index < children; index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                assertNotNull("Snapshot child became unavailable", child);
                try { scanMore(child, path, playerIndex, playerBounds, scan); }
                finally { child.recycle(); }
            }
        } finally { path.remove(path.size() - 1); }
    }

    private UiObject2 menuOnlyMore() {
        UiObject2 current = player();
        List<UiObject2> labels = new ArrayList<>(current.findObjects(By.text(exact("Playback settings"))));
        for (UiObject2 node : current.findObjects(By.desc(exact("Playback settings")))) if (!labels.contains(node)) labels.add(node);
        List<UiObject2> candidates = new ArrayList<>();
        for (UiObject2 node : labels) {
            Rect bounds = node.getVisibleBounds();
            if (node.isEnabled() && node.isClickable() && !bounds.isEmpty() && current.getVisibleBounds().contains(bounds)) candidates.add(node);
        }
        assertTrue("Ambiguous actual player More control", candidates.size() <= 1);
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private void guardMenuOnlyPlayer() {
        guard();
        UiObject2 current = player();
        Rect bounds = current.getVisibleBounds();
        foreground(bounds.left + bounds.width() * 0.5f, bounds.top + bounds.height() * 0.32f);
        for (String label : new String[]{"Playback interrupted", "Playback stopped because of an error", "Playback ended before the original media completed.", "0:36 of 0:36, Seek", "00:36 of 00:36, Seek"}) {
            assertTrue("An explicit error or fixture EOF is not a menu-only pass", current.findObjects(By.text(exact(label))).isEmpty());
        }
        long sourceUp = -1;
        for (int index = 0; index < inputs.length(); index++) {
            JSONObject input = inputs.optJSONObject(index);
            if (input != null && input.optString("role").equals("explicit-source")) sourceUp = input.optJSONArray("eventUptimeMs").optLong(2, -1);
        }
        assertTrue("Menu-only must remain before the known36-second fixture completion window", sourceUp >= 0 && now() - sourceUp < 30_000);
    }

    private void observeInitialClockAX() throws Exception {
        assertEquals("At most one initial clock AX observation", 0, initialClockObservationCount++);
        UiObject2 current = player();
        List<UiObject2> bars = current.findObjects(By.clazz("android.widget.SeekBar"));
        JSONArray candidates = new JSONArray();
        for (int index = 0; index < Math.min(4, bars.size()); index++) {
            UiObject2 bar = bars.get(index);
            Rect bounds = bar.getVisibleBounds();
            candidates.put(new JSONObject().put("timestampUptimeMs", now())
                    .put("className", boundedClockAX(bar.getClassName())).put("packageName", boundedClockAX(bar.getApplicationPackage()))
                    .put("text", boundedClockAX(bar.getText())).put("contentDescription", boundedClockAX(bar.getContentDescription()))
                    .put("visible", !bounds.isEmpty()).put("enabled", bar.isEnabled()).put("clickable", bar.isClickable())
                    .put("bounds", rect(bounds)).put("withinPlayer", current.getVisibleBounds().contains(bounds)));
        }
        write("initial-clock-ax.json", new JSONObject().put("schemaVersion", 1).put("scope", "INITIAL_PLAYER_AX_OBSERVATION_ONLY_NO_CLOCK_PARSING")
                .put("timestampUptimeMs", now()).put("playerBounds", rect(current.getVisibleBounds())).put("totalSeekBars", bars.size())
                .put("maximumCandidates", 4).put("visibleDefinition", "nonempty-native-visible-bounds").put("candidates", candidates).toString(2));
    }

    private static String boundedClockAX(String value) {
        if (value == null) return "";
        String redacted = sanitize(value);
        return redacted.substring(0, Math.min(256, redacted.length()));
    }

    private boolean playerChromeVisible() {
        UiObject2 current = player();
        if (!current.findObjects(By.pkg(PRODUCT).clazz("android.widget.SeekBar")).isEmpty()) return true;
        for (String label : new String[]{"Playback settings", "Play", "Pause"}) {
            if (!current.findObjects(By.text(exact(label))).isEmpty()
                    || !current.findObjects(By.desc(exact(label))).isEmpty()) return true;
        }
        return false;
    }

    private void revealChromeForObservation(String observationEpoch) throws Exception {
        assertTrue("Unknown clock observation epoch", observationEpoch.equals("clock-before") || observationEpoch.equals("clock-after"));
        fresh(); guard();
        if (playerChromeVisible()) return;
        assertFalse("A clock epoch may reveal only once", chromeRevealEpochs.contains(observationEpoch));
        assertTrue("Only two distinct clock observation reveals are admitted", chromeRevealEpochs.size() < 2);
        chromeRevealEpochs.add(observationEpoch);
        Rect bounds = player().getVisibleBounds();
        chromeRevealPerformed = true;
        finger(bounds.left + bounds.width() * 0.5f, bounds.top + bounds.height() * 0.32f, "reveal", bounds, observationEpoch);
        chromeRevealUp = inputs.getJSONObject(inputs.length() - 1).getJSONArray("eventUptimeMs").getLong(2);
    }

    private void fresh() {
        assertTrue("Public API36 cache refresh failed", automation.clearCache());
    }

    private void guard() {
        assertTrue("The one-case time bound expired", now() - started < 360_000);
        assertFalse("A previous injected stream failed", terminalInputFailure);
        assertNull("Binding terms are outside this test", device.findObject(By.text(TERMS)));
        assertNull("Binding terms description is outside this test", device.findObject(By.desc(TERMS)));
        String current = device.getCurrentPackageName();
        assertFalse("An unapproved OS/security surface is visible", current != null &&
                (current.contains("permissioncontroller") || current.contains("packageinstaller") || current.equals("com.android.settings")));
    }

    private UiObject2 text(String label) {
        List<UiObject2> matches = new ArrayList<>(device.findObjects(By.pkg(PRODUCT).text(exact(label))));
        for (UiObject2 node : device.findObjects(By.pkg(PRODUCT).desc(exact(label)))) {
            boolean duplicate = false;
            for (UiObject2 seen : matches) if (seen.equals(node)) duplicate = true;
            if (!duplicate) matches.add(node);
        }
        return matches.isEmpty() ? null : matches.get(0);
    }

    private UiObject2 clickable(String label) {
        List<UiObject2> matches = new ArrayList<>();
        List<UiObject2> labels = new ArrayList<>(device.findObjects(By.pkg(PRODUCT).text(exact(label))));
        labels.addAll(device.findObjects(By.pkg(PRODUCT).desc(exact(label))));
        for (UiObject2 node : labels) {
            for (int depth = 0; node != null && depth < 6; depth++, node = node.getParent()) {
                if (node.isEnabled() && node.isClickable()) {
                    assertEquals(PRODUCT, node.getApplicationPackage());
                    Rect bounds = node.getVisibleBounds();
                    boolean duplicate = false;
                    for (UiObject2 seen : matches) if (seen.getVisibleBounds().equals(bounds) && seen.getClassName().equals(node.getClassName())) duplicate = true;
                    if (!duplicate && !bounds.isEmpty()) matches.add(node);
                    break;
                }
            }
        }
        assertTrue("Ambiguous clickable label", matches.size() <= 1);
        return matches.isEmpty() ? null : matches.get(0);
    }

    private UiObject2 requireText(String label, long timeout) {
        long deadline = now() + timeout;
        do {
            fresh(); guard();
            UiObject2 value = text(label);
            if (value != null) return value;
            SystemClock.sleep(150);
        } while (now() < deadline);
        throw new AssertionError("Expected ordinary UI label did not appear");
    }

    private void click(String label, long timeout) throws Exception {
        long deadline = now() + timeout;
        do {
            fresh(); guard();
            UiObject2 target = clickable(label);
            if (target != null) { tapObject(target, "setup"); return; }
            SystemClock.sleep(150);
        } while (now() < deadline);
        throw new AssertionError("Expected unique clickable UI control did not appear");
    }

    private List<UiObject2> fields(int count) {
        fresh(); guard();
        List<UiObject2> values = device.findObjects(By.pkg(PRODUCT).clazz("android.widget.EditText"));
        assertEquals("Editable fields must match the ordinary form exactly", count, values.size());
        return values;
    }

    private void focusLoginField(int index) {
        UiObject2 target = fields(3).get(index);
        assertVisible(target);
        if (index == 0) { assertEquals(0, usernameFocusClicks++); }
        else { assertEquals(1, index); assertEquals(0, passwordFocusClicks++); }
        // Ordinary public focus, not a FINGER proof. The IME may legitimately become active.
        target.click();
        long deadline = now() + 3_000;
        do {
            if (fields(3).get(index).isFocused()) return;
            SystemClock.sleep(100);
        } while (now() < deadline);
        throw new AssertionError("The ordinary login field focus did not settle");
    }

    private boolean waitForUsernameCommit() {
        long deadline = now() + 5_000;
        do {
            if (USER.equals(fields(3).get(0).getText())) return true;
            SystemClock.sleep(100);
        } while (now() < deadline);
        return false;
    }

    private void dismissIme() {
        if (device.hasObject(By.pkg(Pattern.compile(".*inputmethod.*")))) {
            assertTrue(device.pressBack());
            SystemClock.sleep(200);
        }
    }

    private UiObject2 dialog(String label) {
        List<UiObject2> dialogs = device.findObjects(By.pkg(PRODUCT).clazz("android.app.Dialog").text(exact(label)));
        assertTrue("Ambiguous dialog identity", dialogs.size() <= 1);
        if (dialogs.isEmpty()) return null;
        assertVisible(dialogs.get(0));
        return dialogs.get(0);
    }

    private UiObject2 player() { UiObject2 value = dialog(PLAYER); assertNotNull("Missing actual movie player dialog", value); return value; }
    private void waitPlayer(long timeout) {
        long deadline = now() + timeout;
        do { fresh(); guard(); if (dialog(PLAYER) != null) return; SystemClock.sleep(150); } while (now() < deadline);
        throw new AssertionError("No movie player after the explicit stream row");
    }

    static int parseSeekClock(String label) {
        if (label == null || label.length() > 64) return -1;
        java.util.regex.Matcher match = Pattern.compile("\\A(\\d{1,2}):([0-5]\\d) of (\\d{1,2}):([0-5]\\d), Seek\\z").matcher(label);
        if (!match.matches()) return -1;
        int current = Integer.parseInt(match.group(1)) * 60 + Integer.parseInt(match.group(2));
        int duration = Integer.parseInt(match.group(3)) * 60 + Integer.parseInt(match.group(4));
        return duration == 36 && current >= 0 && current <= 35 ? current : -1;
    }

    private int clock() {
        UiObject2 current = player();
        List<UiObject2> bars = current.findObjects(By.pkg(PRODUCT).clazz("android.widget.SeekBar"));
        assertTrue("Ambiguous native player SeekBar", bars.size() <= 1);
        if (bars.isEmpty()) return -1;
        UiObject2 bar = bars.get(0);
        assertVisible(bar);
        assertTrue("Native SeekBar escaped the current player", current.getVisibleBounds().contains(bar.getVisibleBounds()));
        return parseSeekClock(bar.getText());
    }

    private void tapObject(UiObject2 target, String role) throws Exception {
        assertVisible(target);
        Rect bounds = target.getVisibleBounds();
        finger(bounds.exactCenterX(), bounds.exactCenterY(), role, bounds);
    }

    private Rect foreground(float x, float y) {
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        assertNotNull("The owned foreground root is unavailable", root);
        try {
            assertEquals(PRODUCT, String.valueOf(root.getPackageName()));
            assertTrue("Foreground root is not visible", root.isVisibleToUser());
            Rect bounds = new Rect(); root.getBoundsInScreen(bounds);
            assertTrue("Invalid native screen/root bounds", !bounds.isEmpty() && bounds.left >= 0 && bounds.top >= 0
                    && bounds.right <= device.getDisplayWidth() && bounds.bottom <= device.getDisplayHeight());
            assertTrue("Native target escaped the actual foreground", x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom);
            return bounds;
        } finally { root.recycle(); }
    }

    private void finger(float x, float y, String role, Rect targetBounds) throws Exception {
        finger(x, y, role, targetBounds, null);
    }

    static final class FingerState {
        boolean downAdmitted, downInjectionAttempted, downAcknowledged, streamActive, upAcknowledged, cancelAcknowledged;
        void admit() { downAdmitted = true; }
        void attemptingDown() {
            if (!downAdmitted || downInjectionAttempted) throw new IllegalStateException("DOWN is not admitted");
            downInjectionAttempted = true;
        }
        void downAck(boolean acknowledged) { if (!downInjectionAttempted) throw new IllegalStateException("DOWN was not attempted"); downAcknowledged = acknowledged; streamActive = acknowledged; }
        void upAck(boolean acknowledged) { if (!streamActive) throw new IllegalStateException("No acknowledged stream for UP"); if (acknowledged) { upAcknowledged = true; streamActive = false; } }
        void cancelAck(boolean acknowledged) { if (!streamActive) throw new IllegalStateException("No acknowledged stream for CANCEL"); if (acknowledged) { cancelAcknowledged = true; streamActive = false; } }
    }
    private void finger(float x, float y, String role, Rect targetBounds, String observationEpoch) throws Exception {
        finger(x, y, role, targetBounds, observationEpoch, null);
    }
    private void finger(float x, float y, String role, Rect targetBounds, String observationEpoch, AcquiredMore acquired) throws Exception {
        FingerState state = new FingerState();
        boolean deferredRevealProof = role.equals("reveal") && "menu-only".equals(observationEpoch);
        JSONArray times = new JSONArray();
        JSONObject proof = new JSONObject().put("role", role).put("tool", "finger").put("toolType", 1)
                .put("durationMs", 100).put("steps", 2).put("x", x).put("y", y).put("ok", false)
                .put("foregroundTargetBefore", false).put("foregroundTargetAfter", false).put("downUptimeMs", -1)
                .put("targetBounds", rect(targetBounds));
        if (observationEpoch != null) proof.put("observationEpoch", observationEpoch);
        long down = -1;
        try {
            Rect before;
            if (role.equals("more")) {
                assertFalse("A previous injected stream failed", terminalInputFailure);
                assertNotNull("More requires its single acquired root", acquired);
                acquired.admit(x, y); before = acquired.root;
                assertTrue("Fresh acquisition must follow the captured reveal UP", chromeRevealUp >= 0 && moreAcquisitionStarted >= chromeRevealUp && moreAcquired >= moreAcquisitionStarted);
            } else { guard(); before = foreground(x, y); }
            proof.put("foregroundTargetBefore", true).put("foregroundBounds", rect(before));
            down = now();
            if (role.equals("more")) {
                moreDownAttempt = down;
                assertTrue("Actual More DOWN missed the1200ms reveal-UP window", down >= moreAcquired && down - chromeRevealUp <= 1_200);
            }
            state.admit();
            inject(down, down, MotionEvent.ACTION_DOWN, x, y, times, state);
            for (int step = 1; step <= 2; step++) {
                SystemClock.sleep(Math.max(0, down + 100L * step / 2 - now()));
                assertTrue("Native input deadline exceeded", now() - down < 2_000);
                inject(down, now(), step == 2 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE, x, y, times, state);
            }
            if (!deferredRevealProof) {
                assertEquals("Foreground changed during native input", before, foreground(x, y));
                proof.put("foregroundTargetAfter", true).put("ok", true);
            }
        } catch (Exception | AssertionError failure) {
            terminalInputFailure = true;
            throw failure;
        } finally {
            if (state.streamActive) {
                try { inject(down, now(), MotionEvent.ACTION_CANCEL, x, y, times, state); }
                catch (Throwable ignored) { terminalInputFailure = true; }
            }
            proof.put("downUptimeMs", down).put("downAdmitted", state.downAdmitted).put("downInjectionAttempted", state.downInjectionAttempted)
                    .put("downAcknowledged", state.downAcknowledged).put("upAcknowledged", state.upAcknowledged)
                    .put("cancelAcknowledged", state.cancelAcknowledged).put("streamMayRemain", state.streamActive)
                    .put("eventUptimeMs", times).put("finishedUptimeMs", now());
            inputs.put(proof);
        }
    }
    private void inject(long down, long at, int action, float x, float y, JSONArray times, FingerState state) {
        MotionEvent.PointerProperties property = new MotionEvent.PointerProperties();
        property.id = 0; property.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coordinate = new MotionEvent.PointerCoords();
        coordinate.x = x; coordinate.y = y; coordinate.pressure = 1; coordinate.size = 1;
        MotionEvent event = MotionEvent.obtain(down, at, action, 1,
                new MotionEvent.PointerProperties[]{property}, new MotionEvent.PointerCoords[]{coordinate},
                0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        try {
            if (action == MotionEvent.ACTION_DOWN) state.attemptingDown();
            times.put(at);
            boolean acknowledged = automation.injectInputEvent(event, true);
            if (action == MotionEvent.ACTION_DOWN) state.downAck(acknowledged);
            else if (action == MotionEvent.ACTION_UP) state.upAck(acknowledged);
            else if (action == MotionEvent.ACTION_CANCEL) state.cancelAck(acknowledged);
            assertTrue("SDK input injection was not acknowledged", acknowledged);
        } finally { event.recycle(); }
    }

    private void assertVisible(UiObject2 node) {
        Rect value = node.getVisibleBounds();
        assertTrue("The actual native bounds were not visible", !value.isEmpty() && value.left >= 0 && value.top >= 0
                && value.right <= device.getDisplayWidth() && value.bottom <= device.getDisplayHeight());
    }

    private void capture(String name) throws Exception { capture(name, true); }

    private void capture(String name, boolean includeHierarchy) throws Exception {
        assertTrue("Evidence capture bound exceeded", captures < 10);
        String prefix = String.format(java.util.Locale.ROOT, "%02d-%s", captures++, name);
        File png = new File(folder, prefix + ".png");
        assertTrue("Native screenshot failed", device.takeScreenshot(png));
        assertTrue("PNG exceeded bound", png.length() > 0 && png.length() <= 8L * 1024 * 1024);
        if (!includeHierarchy) return;
        File raw = new File(folder, prefix + ".raw");
        try {
            device.dumpWindowHierarchy(raw);
            assertTrue("Hierarchy exceeded bound", raw.length() <= 1024 * 1024);
            write(prefix + ".xml", sanitize(new String(Files.readAllBytes(raw.toPath()), StandardCharsets.UTF_8)));
        } finally { Files.deleteIfExists(raw.toPath()); }
    }

    private void step(String next) throws Exception { phase = next; phases.put(new JSONObject().put("phase", next).put("uptimeMs", now())); }
    private static long now() { return SystemClock.uptimeMillis(); }
    private static Pattern exact(String label) { return Pattern.compile("\\A" + Pattern.quote(label) + "\\z"); }
    private static JSONArray rect(Rect value) { return new JSONArray().put(value.left).put(value.top).put(value.right).put(value.bottom); }
    private static String sanitize(String value) {
        return value.replace(PASSWORD, "[redacted]").replace(USER, "[synthetic-user]")
                .replaceAll("(?i)(?:authorization|proxy-authorization|cookie|set-cookie)\\s*[:=]\\s*[^\\r\\n]*", "[redacted-header]")
                .replaceAll("(?i)\\bBearer\\s+[A-Za-z0-9._~+/-]+=*", "[redacted-bearer]")
                .replaceAll("(?i)https?://[^\\s\\\"'<>]+", "[redacted-url]")
                .replaceAll("(?i)(?:authorization|cookie|ds_session|ds_csrf|bearer|/api/(?:external-)?stream/)[^\\s\\\"'<>]*", "[redacted-sensitive]");
    }
    private void write(String name, String content) throws Exception { Files.write(new File(folder, name).toPath(), content.getBytes(StandardCharsets.UTF_8)); }
}
