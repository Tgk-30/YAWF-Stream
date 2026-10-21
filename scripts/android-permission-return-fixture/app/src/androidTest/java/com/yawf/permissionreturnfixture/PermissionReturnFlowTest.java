package com.yawf.permissionreturnfixture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

@RunWith(AndroidJUnit4.class)
public final class PermissionReturnFlowTest {
    private static final long UI_WAIT_MS = 30_000L;
    private static final long VERIFY_WAIT_MS = 15_000L;
    private static final long SETTLE_SAMPLE_MS = 250L;
    private static final int MAX_CAPTURES = 8;
    private static final int STAGED_BYTES = 4 * 1024 * 1024;

    private Instrumentation instrumentation;
    private Context targetContext;
    private UiDevice device;
    private File evidenceDir;
    private File stagedFile;
    private SharedPreferences preferences;
    private int captureCount;
    private boolean permissionEnabled;
    private boolean installerObserved;
    private boolean controlReachedTamper;
    private boolean verifierRecoveryObserved;
    private String originalDigest;
    private String tamperedDigest;

    @Test
    public void permissionReturnReverifiesTamperedStageAndNeverOpensInstaller() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        targetContext = instrumentation.getTargetContext();
        device = UiDevice.getInstance(instrumentation);
        assertEquals("This fixture is pinned to API 36", 36, Build.VERSION.SDK_INT);
        assertEquals(FixturePolicy.FIXTURE_PACKAGE, targetContext.getPackageName());
        assertTrue(
                "Updater source pin was not finalized",
                BuildConfig.UPDATER_SOURCE_SHA256.matches("[0-9a-f]{64}"));

        evidenceDir = new File(targetContext.getFilesDir(), "permission-return-evidence");
        deleteTree(evidenceDir);
        assertTrue("Could not create evidence directory", evidenceDir.mkdirs());

        Throwable primary = null;
        try {
            prepareStagedCandidate();
            assertFalse(
                    "Fresh fixture unexpectedly already has unknown-source permission",
                    targetContext.getPackageManager().canRequestPackageInstalls());
            launchFixture();

            waitFor(By.text(FixturePolicy.READY_TITLE), UI_WAIT_MS, "ready title");
            capture("ready-to-install");
            clickNativeDialogButton("button1", "Install");

            waitForUnknownSourcePage();
            UiObject2 toggle = findUnknownSourceSwitch();
            assertNotNull("Exact unknown-source toggle is unavailable", toggle);
            assertFalse("Fresh fixture permission is unexpectedly enabled", toggle.isChecked());
            capture("unknown-source-before");

            tamperStagedBytesWithoutChangingLength();
            toggle.click();
            waitForUnknownSourceState(true, "unknown-source permission enabled");
            permissionEnabled = true;
            controlReachedTamper = true;
            capture("unknown-source-after");

            device.pressBack();
            if (BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME) {
                assertReturnResumeOmissionBlocksVerifierRecovery();
                capture("negative-control-recovery-blocked");
            } else {
                waitForTamperFailureWithoutInstaller();
                capture("tamper-rejected");
                assertFalse("Tampered staged file was retained", stagedFile.exists());
                assertEquals(
                        "Failure did not move the persisted retry back to preparing",
                        FixturePolicy.PHASE_PREPARING,
                        preferences.getInt(FixturePolicy.KEY_UPDATE_PHASE, -1));
                assertFalse(
                        "Permission return marker survived failed verification",
                        preferences.getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false));
                assertTrue(
                        "Retry candidate identity was unexpectedly discarded",
                        preferences.contains(FixturePolicy.KEY_DOWNLOAD_CANDIDATE));
                verifierRecoveryObserved = true;
            }
            assertFalse("A package installer surface was observed", installerObserved);
        } catch (Throwable caught) {
            primary = caught;
            try {
                capture("failure-before-cleanup");
            } catch (Throwable captureFailure) {
                primary.addSuppressed(captureFailure);
            }
        } finally {
            writeReceipt(primary);
        }

        if (primary != null) {
            if (primary instanceof Exception) {
                throw (Exception) primary;
            }
            throw (Error) primary;
        }
    }

    private void prepareStagedCandidate() throws Exception {
        targetContext.getSharedPreferences(FixturePolicy.PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit().clear().commit();
        preferences = targetContext.getSharedPreferences(
                FixturePolicy.PREFERENCES_NAME,
                Context.MODE_PRIVATE);

        File updates = new File(targetContext.getFilesDir(), "updates");
        deleteTree(updates);
        assertTrue("Could not create private update directory", updates.mkdirs());
        stagedFile = new File(updates, FixturePolicy.TEST_APK_NAME);
        byte[] block = "fixture-stage-v1\n".getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(stagedFile)) {
            int remaining = STAGED_BYTES;
            while (remaining > 0) {
                int count = Math.min(remaining, block.length);
                output.write(block, 0, count);
                remaining -= count;
            }
            output.getFD().sync();
        }
        assertEquals(STAGED_BYTES, stagedFile.length());
        originalDigest = sha256(stagedFile);

        JSONObject candidate = new JSONObject();
        candidate.put("tag", FixturePolicy.TEST_TAG);
        candidate.put("version", FixturePolicy.TEST_VERSION);
        candidate.put("versionCode", FixturePolicy.TEST_VERSION_CODE);
        candidate.put("packageName", FixturePolicy.FIXTURE_PACKAGE);
        candidate.put("apkName", FixturePolicy.TEST_APK_NAME);
        candidate.put("sha256", originalDigest);
        candidate.put("size", stagedFile.length());
        candidate.put(
                "browserDownloadUrl",
                "https://github.com/Tgk-30/YAWF-Stream/releases/download/"
                        + FixturePolicy.TEST_TAG + "/" + FixturePolicy.TEST_APK_NAME);

        assertTrue(
                "Could not seed the updater parser input",
                preferences.edit()
                        .putString(FixturePolicy.KEY_DOWNLOAD_CANDIDATE, candidate.toString())
                        .putInt(FixturePolicy.KEY_UPDATE_PHASE, FixturePolicy.PHASE_STAGED)
                        .putLong(FixturePolicy.KEY_PHASE_NOT_BEFORE_GENERATION, 0L)
                        .putBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false)
                        .commit());
    }

    private void launchFixture() {
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(
                        FixturePolicy.FIXTURE_PACKAGE,
                        FixturePolicy.FIXTURE_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        targetContext.startActivity(intent);
        assertTrue(
                "Fixture did not become visible",
                device.wait(Until.hasObject(By.pkg(FixturePolicy.FIXTURE_PACKAGE)), UI_WAIT_MS));
    }

    private void waitForUnknownSourcePage() {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            observeInstallerSurfaces();
            if (FixturePolicy.SETTINGS_PACKAGE.equals(device.getCurrentPackageName())
                    && device.hasObject(By.text(FixturePolicy.UNKNOWN_SOURCE_LABEL))
                    && device.hasObject(By.text(FixturePolicy.FIXTURE_LABEL))) {
                return;
            }
            SystemClock.sleep(100L);
        }
        fail("Fixture-scoped unknown-source Settings page did not appear");
    }

    private void tamperStagedBytesWithoutChangingLength() throws Exception {
        long before = stagedFile.length();
        try (RandomAccessFile file = new RandomAccessFile(stagedFile, "rw")) {
            int first = file.read();
            assertTrue("Staged file was empty", first >= 0);
            file.seek(0L);
            file.write(first ^ 0xff);
            file.getFD().sync();
        }
        assertEquals("Tamper changed the staged length", before, stagedFile.length());
        tamperedDigest = sha256(stagedFile);
        assertNotEquals("Tamper did not change the staged digest", originalDigest, tamperedDigest);
    }

    private void waitForTamperFailureWithoutInstaller() {
        long deadline = SystemClock.uptimeMillis() + VERIFY_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            observeInstallerSurfaces();
            UiObject2 reviewedMessage = findReviewedRetryMessage();
            UiObject2 retry = findUniqueNativeDialogButton("button1", "Retry");
            UiObject2 cancel = findUniqueNativeDialogButton("button2", "Cancel update");
            if (device.hasObject(By.text(FixturePolicy.RETRY_TITLE))
                    && reviewedMessage != null
                    && retry != null
                    && cancel != null) {
                assertTrue(
                        "Retry message was outside the reviewed failure set",
                        FixturePolicy.isReviewedRetryMessage(String.valueOf(reviewedMessage.getText())));
                int settled = 0;
                while (settled < FixturePolicy.SETTLED_SAMPLES) {
                    observeInstallerSurfaces();
                    assertTrue(
                            "Tamper failure dialog did not remain settled",
                            device.hasObject(By.text(FixturePolicy.RETRY_TITLE))
                                    && findReviewedRetryMessage() != null
                                    && findUniqueNativeDialogButton("button1", "Retry") != null
                                    && findUniqueNativeDialogButton("button2", "Cancel update") != null);
                    settled++;
                    SystemClock.sleep(SETTLE_SAMPLE_MS);
                }
                assertFalse("A package installer surface appeared", installerObserved);
                return;
            }
            SystemClock.sleep(100L);
        }
        fail("Automatic permission return did not settle on the tamper rejection UI");
    }

    private UiObject2 findReviewedRetryMessage() {
        for (String message : new String[] {
                FixturePolicy.CHANGED_MESSAGE,
                FixturePolicy.INTERRUPTED_MESSAGE,
        }) {
            UiObject2 object = device.findObject(By.text(message).pkg(FixturePolicy.FIXTURE_PACKAGE));
            if (object != null && FixturePolicy.isReviewedRetryMessage(String.valueOf(object.getText()))) {
                return object;
            }
        }
        return null;
    }

    private void assertReturnResumeOmissionBlocksVerifierRecovery() throws Exception {
        long deadline = SystemClock.uptimeMillis() + 3_000L;
        while (SystemClock.uptimeMillis() < deadline) {
            observeInstallerSurfaces();
            assertFalse("Negative control unexpectedly reached retry UI", device.hasObject(By.text(FixturePolicy.RETRY_TITLE)));
            SystemClock.sleep(100L);
        }
        assertTrue("Negative control did not reach the tamper point", controlReachedTamper);
        assertTrue("Negative control unexpectedly removed staged bytes", stagedFile.isFile());
        assertEquals("Negative-control tamper changed again", tamperedDigest, sha256(stagedFile));
        assertEquals(
                "Negative control unexpectedly advanced the staged phase",
                FixturePolicy.PHASE_STAGED,
                preferences.getInt(FixturePolicy.KEY_UPDATE_PHASE, -1));
        assertTrue(
                "Negative control lost its permission-return marker",
                preferences.getBoolean(FixturePolicy.KEY_AWAITING_INSTALL_PERMISSION, false));
        assertFalse("Negative control exposed a package installer", installerObserved);
        verifierRecoveryObserved = false;
    }

    private void observeInstallerSurfaces() {
        String current = device.getCurrentPackageName();
        if (FixturePolicy.isInstallerPackage(current)) {
            installerObserved = true;
        }
        for (String installerPackage : FixturePolicy.installerPackages()) {
            if (device.hasObject(By.pkg(installerPackage))) {
                installerObserved = true;
            }
        }
    }

    private UiObject2 findUnknownSourceSwitch() {
        for (String resource : new String[] {
                "android:id/switch_widget",
                "com.android.settings:id/switch_widget",
        }) {
            UiObject2 object = device.findObject(By.res(resource));
            if (object != null) {
                return object;
            }
        }
        List<UiObject2> labels = device.findObjects(
                By.text(FixturePolicy.UNKNOWN_SOURCE_LABEL)
                        .pkg(FixturePolicy.SETTINGS_PACKAGE)
                        .clazz(FixturePolicy.UNKNOWN_SOURCE_LABEL_CLASS)
                        .enabled(true));
        if (labels.size() != 1) {
            return null;
        }
        UiObject2 label = labels.get(0);
        UiObject2 toggle = label.getParent();
        if (toggle != null
                && FixturePolicy.isUnknownSourceSemanticToggle(
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

    private void waitForUnknownSourceState(boolean expected, String label) {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 toggle = findUnknownSourceSwitch();
            if (toggle != null && toggle.isChecked() == expected) {
                return;
            }
            SystemClock.sleep(100L);
        }
        fail("Timed out waiting for " + label);
    }

    private UiObject2 waitFor(androidx.test.uiautomator.BySelector selector, long timeout, String label) {
        UiObject2 object = device.wait(Until.findObject(selector), timeout);
        assertNotNull("Timed out waiting for " + label, object);
        return object;
    }

    private UiObject2 findUniqueNativeDialogButton(String resource, String text) {
        List<UiObject2> matches = device.findObjects(
                By.res("android", resource)
                        .pkg(FixturePolicy.FIXTURE_PACKAGE)
                        .text(exactCaseInsensitiveLabel(text))
                        .clazz("android.widget.Button")
                        .enabled(true)
                        .clickable(true));
        if (matches.size() > 1) {
            fail("Native dialog action was ambiguous: " + text);
        }
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private void clickNativeDialogButton(String resource, String text) {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        UiObject2 button = null;
        while (SystemClock.uptimeMillis() < deadline) {
            button = findUniqueNativeDialogButton(resource, text);
            if (button != null) {
                break;
            }
            SystemClock.sleep(100L);
        }
        assertNotNull("Timed out waiting for exact native dialog action: " + text, button);
        button.click();
    }

    private static Pattern exactCaseInsensitiveLabel(String text) {
        return Pattern.compile(
                "\\A" + Pattern.quote(text) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private void capture(String label) throws IOException {
        assertTrue("Capture count exceeded", captureCount < MAX_CAPTURES);
        captureCount++;
        String prefix = String.format(Locale.ROOT, "%02d-%s", captureCount, label);
        File screenshot = new File(evidenceDir, prefix + ".png");
        assertTrue("Screenshot failed", device.takeScreenshot(screenshot));
        File hierarchy = new File(evidenceDir, prefix + ".xml");
        device.dumpWindowHierarchy(hierarchy);
        assertTrue("Hierarchy was empty", hierarchy.length() > 0L);
    }

    private void writeReceipt(Throwable failure) throws Exception {
        JSONObject receipt = new JSONObject();
        receipt.put("outcome", failure == null ? "passed" : "failed");
        receipt.put(
                "classification",
                BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME
                        ? "fixture-negative-control-return-resume-omitted-core-only"
                        : "fixture-lifecycle-and-tamper-rejection-core-only");
        receipt.put("updaterSourceSha256", BuildConfig.UPDATER_SOURCE_SHA256);
        receipt.put("candidateParsedByUpdater", captureCount >= 1);
        receipt.put("sameLengthTamper", originalDigest != null && tamperedDigest != null);
        receipt.put("negativeControl", BuildConfig.OMIT_PERMISSION_RETURN_ON_RESUME);
        receipt.put("controlReachedTamper", controlReachedTamper);
        receipt.put("verifierRecoveryObserved", verifierRecoveryObserved);
        receipt.put("installerObserved", installerObserved);
        receipt.put("stagedFileCleared", stagedFile != null && !stagedFile.exists());
        receipt.put("permissionEnabledByTest", permissionEnabled);
        receipt.put("corePassed", failure == null);
        receipt.put("externalPermissionCleanupRequired", permissionEnabled);
        receipt.put("permissionCleanupPerformedByCore", false);
        receipt.put("publicOtaProof", false);
        receipt.put("installProof", false);
        receipt.put("dataPreservationProof", false);
        receipt.put("failure", failure == null ? JSONObject.NULL : failure.getClass().getSimpleName());
        try (FileOutputStream output = new FileOutputStream(new File(evidenceDir, "receipt.json"))) {
            output.write((receipt.toString(2) + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (java.io.FileInputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, count);
            }
        }
        StringBuilder value = new StringBuilder(64);
        for (byte item : digest.digest()) {
            value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return value.toString();
    }

    private static void deleteTree(File root) {
        if (!root.exists()) {
            return;
        }
        File[] children = root.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        assertTrue("Could not remove " + root.getName(), root.delete());
    }
}
