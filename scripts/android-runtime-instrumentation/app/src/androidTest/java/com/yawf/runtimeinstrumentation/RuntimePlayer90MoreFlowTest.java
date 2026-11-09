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
import java.util.regex.Pattern;

/** One black-box hosted More transaction. No WebView evaluation or application-state writes. */
@RunWith(AndroidJUnit4.class)
public final class RuntimePlayer90MoreFlowTest {
    private static final String PRODUCT = "com.tgk30.debridstreamer";
    private static final String FOLDER = "player90-more";
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
    private int sourceClicks;
    private int clockBefore = -1;
    private int clockAfter = -1;
    private boolean menuHeading;
    private boolean uniqueMenu;
    private boolean terminalInputFailure;
    private Rect menuBounds;

    @Test
    public void production90OpensMoreWithNativeFinger() throws Throwable {
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
            flow();
            outcome = "PASS";
        } catch (Throwable failure) {
            try { capture("failure"); } catch (Throwable unavailable) { /* The host also captures failure before cleanup. */ }
            throw failure;
        } finally {
            Configurator.getInstance().setWaitForIdleTimeout(oldIdle);
            JSONObject receipt = new JSONObject();
            receipt.put("schemaVersion", 1).put("profile", "private90-hosted-more")
                    .put("outcome", outcome).put("phase", phase).put("durationMs", SystemClock.uptimeMillis() - started)
                    .put("sourceClicks", sourceClicks).put("explicitSourceRow", sourceClicks == 1)
                    .put("clockBeforeSeconds", clockBefore).put("clockAfterSeconds", clockAfter)
                    .put("menuHeading", menuHeading).put("uniqueMenu", uniqueMenu)
                    .put("menuBounds", menuBounds == null ? JSONObject.NULL : rect(menuBounds))
                    .put("inputs", inputs).put("phases", phases).put("captures", captures)
                    .put("decodedImageReviewRequired", true).put("bundledPlaybackClaimed", false)
                    .put("externalPlayerClaimed", false).put("singleUiAutomationOwner", true);
            write("receipt.json", receipt.toString(2));
        }
    }

    private void flow() throws Exception {
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
        List<UiObject2> login = fields(3);
        login.get(0).setText(USER);
        login.get(1).setText(PASSWORD);
        assertEquals("Synthetic username was not entered completely", USER, login.get(0).getText());
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
        step("playing");
        long clockDeadline = now() + 10_000;
        while (now() < clockDeadline) {
            fresh(); guard();
            clockBefore = clock();
            if (clockBefore > 0 && clockBefore < 25) break;
            SystemClock.sleep(200);
        }
        assertTrue("A nonzero initial media clock was not observed", clockBefore > 0 && clockBefore < 25);
        capture("clock-before");
        SystemClock.sleep(2_200);
        fresh(); guard();
        clockAfter = clock();
        assertTrue("Rendered playback clock did not advance", clockAfter >= clockBefore + 1 && clockAfter < 30);
        capture("clock-after");
        step("more-transaction");
        // At most one reveal and one More activation, using measured native bounds.
        fresh(); guard();
        UiObject2 more = clickable("Playback settings");
        long revealedAt = -1;
        if (more == null) {
            Rect player = player().getVisibleBounds();
            finger(player.left + player.width() * 0.85f, player.top + player.height() * 0.30f, "reveal", player);
            revealedAt = now();
            long visibleDeadline = revealedAt + 1_200;
            do {
                fresh(); guard(); more = clickable("Playback settings");
                if (more != null) break;
                SystemClock.sleep(100);
            } while (now() < visibleDeadline);
        }
        assertNotNull("More was not freshly visible after the single reveal", more);
        if (revealedAt >= 0) assertTrue("More acquisition exceeded the auto-hide window", now() - revealedAt < 2_500);
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

    private int clock() {
        List<Integer> values = new ArrayList<>();
        for (UiObject2 node : player().findObjects(By.text(Pattern.compile("\\A\\d{1,2}:\\d{2}(?::\\d{2})?(?: / \\d{1,2}:\\d{2}(?::\\d{2})?)?\\z")))) {
            String[] parts = node.getText().split(" / ")[0].split(":");
            int seconds = 0;
            for (String part : parts) seconds = seconds * 60 + Integer.parseInt(part);
            if (seconds < 35 && !values.contains(seconds)) values.add(seconds);
        }
        assertTrue("Ambiguous elapsed clock", values.size() <= 1);
        return values.isEmpty() ? -1 : values.get(0);
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
        guard();
        Rect before = foreground(x, y);
        long down = now();
        boolean stream = true;
        boolean up = false;
        boolean cancel = false;
        JSONArray times = new JSONArray();
        JSONObject proof = new JSONObject().put("role", role).put("tool", "finger").put("toolType", 1)
                .put("durationMs", 100).put("steps", 2).put("x", x).put("y", y)
                .put("foregroundTargetBefore", true).put("downUptimeMs", down)
                .put("targetBounds", rect(targetBounds)).put("foregroundBounds", rect(before));
        try {
            inject(down, MotionEvent.ACTION_DOWN, x, y, times);
            for (int step = 1; step <= 2; step++) {
                SystemClock.sleep(Math.max(0, down + 100L * step / 2 - now()));
                assertTrue("Native input deadline exceeded", now() - down < 2_000);
                inject(down, step == 2 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE, x, y, times);
                if (step == 2) { up = true; stream = false; }
            }
            assertEquals("Foreground changed during native input", before, foreground(x, y));
            proof.put("foregroundTargetAfter", true).put("ok", true);
        } catch (Exception | AssertionError failure) {
            terminalInputFailure = true;
            proof.put("ok", false);
            throw failure;
        } finally {
            if (stream) {
                try { inject(down, MotionEvent.ACTION_CANCEL, x, y, times); stream = false; cancel = true; }
                catch (Throwable ignored) { terminalInputFailure = true; }
            }
            proof.put("upAcknowledged", up).put("cancelAcknowledged", cancel).put("streamMayRemain", stream)
                    .put("eventUptimeMs", times).put("finishedUptimeMs", now());
            inputs.put(proof);
        }
    }

    private void inject(long down, int action, float x, float y, JSONArray times) {
        MotionEvent.PointerProperties property = new MotionEvent.PointerProperties();
        property.id = 0; property.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coordinate = new MotionEvent.PointerCoords();
        coordinate.x = x; coordinate.y = y; coordinate.pressure = 1; coordinate.size = 1;
        long at = now(); times.put(at);
        MotionEvent event = MotionEvent.obtain(down, at, action, 1,
                new MotionEvent.PointerProperties[]{property}, new MotionEvent.PointerCoords[]{coordinate},
                0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        try { assertTrue("SDK input injection was not acknowledged", automation.injectInputEvent(event, true)); }
        finally { event.recycle(); }
    }

    private void assertVisible(UiObject2 node) {
        Rect value = node.getVisibleBounds();
        assertTrue("The actual native bounds were not visible", !value.isEmpty() && value.left >= 0 && value.top >= 0
                && value.right <= device.getDisplayWidth() && value.bottom <= device.getDisplayHeight());
    }

    private void capture(String name) throws Exception {
        assertTrue("Evidence capture bound exceeded", captures < 10);
        String prefix = String.format(java.util.Locale.ROOT, "%02d-%s", captures++, name);
        File png = new File(folder, prefix + ".png");
        assertTrue("Native screenshot failed", device.takeScreenshot(png));
        assertTrue("PNG exceeded bound", png.length() > 0 && png.length() <= 8L * 1024 * 1024);
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
