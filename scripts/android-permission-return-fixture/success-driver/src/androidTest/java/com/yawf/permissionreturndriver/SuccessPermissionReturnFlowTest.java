package com.yawf.permissionreturndriver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

@RunWith(AndroidJUnit4.class)
public final class SuccessPermissionReturnFlowTest {
    private static final String FIXTURE_PACKAGE = "com.yawf.permissionreturnfixture";
    private static final String FIXTURE_ACTIVITY = FIXTURE_PACKAGE + ".SuccessFixtureActivity";
    private static final String FIXTURE_LABEL = "YAWF permission success fixture";
    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String UNKNOWN_SOURCE_LABEL = "Allow from this source";
    private static final String BASELINE_VERSION = "90.0.1";
    private static final long BASELINE_VERSION_CODE = 90_000_001L;
    private static final String TARGET_VERSION = "90.0.2";
    private static final long TARGET_VERSION_CODE = 90_000_002L;
    private static final String SUCCESS_RECEIPT =
            "Fixture update verified\nCanary preserved\nStaged update cleared\n"
                    + "Permission return marker cleared\nUpdater state cleared";
    private static final long UI_WAIT_MS = 30_000L;
    private static final long INSTALL_WAIT_MS = 60_000L;
    private static final int MAX_CAPTURES = 9;
    private static final List<String> INSTALLER_PACKAGES = List.of(
            "com.google.android.packageinstaller",
            "com.android.packageinstaller",
            "com.google.android.permissioncontroller",
            "com.android.permissioncontroller");

    private Instrumentation instrumentation;
    private Context driverContext;
    private UiDevice device;
    private File evidenceDir;
    private int captureCount;
    private boolean permissionEnabled;
    private boolean permissionRevoked;
    private boolean installerObserved;

    @Test
    public void permissionReturnCompletesPinnedFixtureUpgradeAndPreservesIdentity() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        driverContext = instrumentation.getTargetContext();
        device = UiDevice.getInstance(instrumentation);
        assertEquals("This fixture is pinned to API 36", 36, Build.VERSION.SDK_INT);
        assertEquals("Driver must remain outside the updated package", "com.yawf.permissionreturndriver", driverContext.getPackageName());

        evidenceDir = new File(driverContext.getFilesDir(), "permission-return-success-evidence");
        deleteTree(evidenceDir);
        assertTrue("Could not create driver evidence directory", evidenceDir.mkdirs());

        PackageInfo before = packageInfo();
        assertEquals(BASELINE_VERSION, before.versionName);
        assertEquals(BASELINE_VERSION_CODE, before.getLongVersionCode());
        int uidBefore = before.applicationInfo.uid;
        long firstInstallBefore = before.firstInstallTime;
        List<String> signersBefore = signerDigests(before);
        assertFalse("Baseline signer identity was empty", signersBefore.isEmpty());

        Throwable primary = null;
        try {
            launchFixture();
            waitFor(By.text("Update ready to install").pkg(FIXTURE_PACKAGE), UI_WAIT_MS, "ready title");
            capture("ready-to-install");
            waitForUniqueNativeButton(FIXTURE_PACKAGE, "button1", "Install", UI_WAIT_MS).click();

            waitForUnknownSourcePage();
            UiObject2 toggle = findUnknownSourceSwitch();
            assertNotNull("Exact fixture unknown-source toggle is unavailable", toggle);
            assertFalse("Fresh fixture permission is unexpectedly enabled", toggle.isChecked());
            capture("unknown-source-before");
            toggle.click();
            waitForUnknownSourceState(true, "unknown-source permission enabled");
            permissionEnabled = true;
            capture("unknown-source-after");

            device.pressBack();
            UiObject2 update = waitForUniqueInstallerButton("Update", INSTALL_WAIT_MS);
            installerObserved = true;
            capture("installer-update-ready");
            update.click();

            UiObject2 open = waitForUniqueInstallerButton("Open", INSTALL_WAIT_MS);
            capture("installer-update-complete");
            open.click();
            waitFor(By.text(SUCCESS_RECEIPT).pkg(FIXTURE_PACKAGE), UI_WAIT_MS, "target cleanup receipt");
            capture("target-cleanup-receipt");

            PackageInfo after = packageInfo();
            assertEquals(TARGET_VERSION, after.versionName);
            assertEquals(TARGET_VERSION_CODE, after.getLongVersionCode());
            assertEquals("Fixture UID changed across the update", uidBefore, after.applicationInfo.uid);
            assertEquals("Fixture first-install time changed", firstInstallBefore, after.firstInstallTime);
            assertEquals("Fixture signer set changed", signersBefore, signerDigests(after));
            assertTrue("The OS installer was not observed", installerObserved);
        } catch (Throwable caught) {
            primary = caught;
            try {
                capture("failure-before-cleanup");
            } catch (Throwable captureFailure) {
                primary.addSuppressed(captureFailure);
            }
        } finally {
            try {
                revokeUnknownSourcePermissionVisibly();
            } catch (Throwable cleanupFailure) {
                if (primary == null) primary = cleanupFailure;
                else primary.addSuppressed(cleanupFailure);
            }
            writeReceipt(primary);
        }

        if (primary != null) {
            if (primary instanceof Exception) throw (Exception) primary;
            throw (Error) primary;
        }
        assertTrue("Unknown-source permission was not visibly revoked", permissionRevoked);
    }

    private void launchFixture() {
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(FIXTURE_PACKAGE, FIXTURE_ACTIVITY))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        driverContext.startActivity(intent);
        assertTrue("Fixture did not become visible", device.wait(Until.hasObject(By.pkg(FIXTURE_PACKAGE)), UI_WAIT_MS));
    }

    private PackageInfo packageInfo() throws Exception {
        return driverContext.getPackageManager().getPackageInfo(
                FIXTURE_PACKAGE,
                PackageManager.GET_SIGNING_CERTIFICATES);
    }

    private List<String> signerDigests(PackageInfo info) throws Exception {
        assertNotNull("SigningInfo was unavailable", info.signingInfo);
        android.content.pm.Signature[] signatures = info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
        List<String> values = new ArrayList<>();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (android.content.pm.Signature signature : signatures) {
            values.add(toHex(digest.digest(signature.toByteArray())));
        }
        Collections.sort(values);
        return values;
    }

    private void waitForUnknownSourcePage() {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (SETTINGS_PACKAGE.equals(device.getCurrentPackageName())
                    && device.hasObject(By.text(UNKNOWN_SOURCE_LABEL).pkg(SETTINGS_PACKAGE))
                    && device.hasObject(By.text(FIXTURE_LABEL).pkg(SETTINGS_PACKAGE))) {
                return;
            }
            SystemClock.sleep(100L);
        }
        fail("Fixture-scoped unknown-source Settings page did not appear");
    }

    private UiObject2 findUnknownSourceSwitch() {
        for (String resource : new String[] {
                "android:id/switch_widget",
                "com.android.settings:id/switch_widget",
        }) {
            List<UiObject2> matches = device.findObjects(By.res(resource).pkg(SETTINGS_PACKAGE));
            if (matches.size() == 1) return matches.get(0);
        }
        List<UiObject2> labels = device.findObjects(
                By.text(UNKNOWN_SOURCE_LABEL)
                        .pkg(SETTINGS_PACKAGE)
                        .clazz("android.widget.TextView")
                        .enabled(true));
        if (labels.size() != 1) return null;
        UiObject2 toggle = labels.get(0).getParent();
        if (toggle != null
                && SETTINGS_PACKAGE.equals(toggle.getApplicationPackage())
                && "android.view.View".equals(toggle.getClassName())
                && toggle.getResourceName() == null
                && toggle.isEnabled()
                && toggle.isClickable()
                && toggle.isCheckable()) {
            return toggle;
        }
        return null;
    }

    private void waitForUnknownSourceState(boolean expected, String label) {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 toggle = findUnknownSourceSwitch();
            if (toggle != null && toggle.isChecked() == expected) return;
            SystemClock.sleep(100L);
        }
        fail("Timed out waiting for " + label);
    }

    private UiObject2 waitForUniqueInstallerButton(String text, long timeout) {
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> matches = new ArrayList<>();
            for (String packageName : INSTALLER_PACKAGES) {
                matches.addAll(device.findObjects(
                        By.res("android", "button1")
                                .pkg(packageName)
                                .text(exactCaseInsensitiveLabel(text))
                                .clazz("android.widget.Button")
                                .enabled(true)
                                .clickable(true)));
            }
            if (matches.size() == 1) return matches.get(0);
            if (matches.size() > 1) fail("Installer action was ambiguous: " + text);
            SystemClock.sleep(100L);
        }
        fail("Timed out waiting for exact installer action: " + text);
        return null;
    }

    private UiObject2 waitForUniqueNativeButton(
            String packageName,
            String resource,
            String text,
            long timeout) {
        androidx.test.uiautomator.BySelector selector = By.res("android", resource)
                .pkg(packageName)
                .text(exactCaseInsensitiveLabel(text))
                .clazz("android.widget.Button")
                .enabled(true)
                .clickable(true);
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) {
            List<UiObject2> matches = device.findObjects(selector);
            if (matches.size() == 1) return matches.get(0);
            if (matches.size() > 1) fail("Native dialog action was ambiguous: " + text);
            SystemClock.sleep(100L);
        }
        fail("Timed out waiting for exact native dialog action: " + text);
        return null;
    }

    private UiObject2 waitFor(androidx.test.uiautomator.BySelector selector, long timeout, String label) {
        UiObject2 object = device.wait(Until.findObject(selector), timeout);
        assertNotNull("Timed out waiting for " + label, object);
        return object;
    }

    private static Pattern exactCaseInsensitiveLabel(String text) {
        return Pattern.compile(
                "\\A" + Pattern.quote(text) + "\\z",
                Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private void revokeUnknownSourcePermissionVisibly() throws Exception {
        if (!permissionEnabled) {
            permissionRevoked = true;
            return;
        }
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + FIXTURE_PACKAGE))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        driverContext.startActivity(intent);
        waitForUnknownSourcePage();
        UiObject2 toggle = findUnknownSourceSwitch();
        assertNotNull("Cleanup unknown-source toggle is unavailable", toggle);
        if (toggle.isChecked()) {
            toggle.click();
            waitForUnknownSourceState(false, "unknown-source permission revoked");
        }
        capture("permission-cleanup-off");
        assertFalse("Fixture permission remained visibly enabled", toggle.isChecked());
        permissionRevoked = true;
    }

    private void capture(String label) throws Exception {
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
        receipt.put("classification", "seeded-fixture-permission-return-install-lifecycle-only");
        receipt.put("separateDriverPackage", driverContext != null && !FIXTURE_PACKAGE.equals(driverContext.getPackageName()));
        receipt.put("installerObserved", installerObserved);
        receipt.put("permissionEnabledByTest", permissionEnabled);
        receipt.put("permissionVisiblyRevoked", permissionRevoked);
        receipt.put("publicDiscoveryProof", false);
        receipt.put("productionOtaProof", false);
        receipt.put("productionPresentationProof", false);
        receipt.put("failure", failure == null ? JSONObject.NULL : failure.getClass().getSimpleName());
        try (FileOutputStream output = new FileOutputStream(new File(evidenceDir, "receipt.json"))) {
            output.write((receipt.toString(2) + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return value.toString();
    }

    private static void deleteTree(File root) {
        if (!root.exists()) return;
        File[] children = root.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        assertTrue("Could not remove " + root.getName(), root.delete());
    }
}
