package com.yawf.permissionreturndriver;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
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

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

@RunWith(AndroidJUnit4.class)
public final class FixturePermissionCleanupTest {
    private static final String DRIVER_PACKAGE = "com.yawf.permissionreturndriver";
    private static final String FIXTURE_PACKAGE = "com.yawf.permissionreturnfixture";
    private static final String FIXTURE_LABEL = "YAWF permission return fixture";
    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String UNKNOWN_SOURCE_LABEL = "Allow from this source";
    private static final String TEXT_VIEW_CLASS = "android.widget.TextView";
    private static final String SEMANTIC_TOGGLE_CLASS = "android.view.View";
    private static final long UI_WAIT_MS = 30_000L;
    private static final long SETTLE_SAMPLE_MS = 250L;
    private static final int SETTLED_SAMPLES = 3;
    private static final int MAX_CAPTURES = 2;

    private Instrumentation instrumentation;
    private Context driverContext;
    private UiDevice device;
    private File evidenceDir;
    private int captureCount;
    private int settledOffSamples;
    private boolean fixtureIdentityObserved;
    private boolean scopedSettingsObserved;
    private boolean permissionInitiallyEnabled;
    private boolean cleanupClicked;
    private boolean permissionVisiblyOff;

    @Test
    public void visiblyRevokesOnlyTheFixtureUnknownSourcePermission() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        driverContext = instrumentation.getTargetContext();
        device = UiDevice.getInstance(instrumentation);
        assertEquals("This fixture is pinned to API 36", 36, Build.VERSION.SDK_INT);
        assertEquals("Cleanup must run outside the fixture UID", DRIVER_PACKAGE, driverContext.getPackageName());

        evidenceDir = new File(driverContext.getFilesDir(), "permission-return-cleanup-evidence");
        deleteTree(evidenceDir);
        assertTrue("Could not create cleanup evidence directory", evidenceDir.mkdirs());

        Throwable primary = null;
        try {
            assertFixtureIdentityIsVisible();
            openFixtureScopedUnknownSourceSettings();
            waitForFixtureScopedUnknownSourcePage();
            scopedSettingsObserved = true;

            UiObject2 toggle = requireExactUnknownSourceToggle();
            permissionInitiallyEnabled = toggle.isChecked();
            if (permissionInitiallyEnabled) {
                toggle.click();
                cleanupClicked = true;
            }
            waitForUnknownSourceState(false, "fixture unknown-source permission visibly off");
            while (settledOffSamples < SETTLED_SAMPLES) {
                assertFixtureScopedUnknownSourcePage();
                assertFalse(
                        "Fixture unknown-source permission did not remain visibly off",
                        requireExactUnknownSourceToggle().isChecked());
                settledOffSamples++;
                SystemClock.sleep(SETTLE_SAMPLE_MS);
            }
            permissionVisiblyOff = true;
            capture("permission-cleanup-off");
        } catch (Throwable caught) {
            primary = caught;
            try {
                capture("cleanup-failure");
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
        assertTrue("Visible fixture permission cleanup did not complete", permissionVisiblyOff);
    }

    private void assertFixtureIdentityIsVisible() throws Exception {
        PackageManager packageManager = driverContext.getPackageManager();
        PackageInfo fixture = packageManager.getPackageInfo(FIXTURE_PACKAGE, 0);
        assertEquals("Unexpected fixture package", FIXTURE_PACKAGE, fixture.packageName);
        assertNotNull("Fixture application metadata was unavailable", fixture.applicationInfo);
        assertEquals(
                "Unexpected fixture label",
                FIXTURE_LABEL,
                String.valueOf(packageManager.getApplicationLabel(fixture.applicationInfo)));
        fixtureIdentityObserved = true;
    }

    private void openFixtureScopedUnknownSourceSettings() {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + FIXTURE_PACKAGE))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        driverContext.startActivity(intent);
    }

    private void waitForFixtureScopedUnknownSourcePage() {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (isExactFixtureScopedUnknownSourcePage()) {
                return;
            }
            SystemClock.sleep(100L);
        }
        fail("Exact fixture-scoped unknown-source Settings page did not appear");
    }

    private void assertFixtureScopedUnknownSourcePage() {
        assertTrue(
                "Cleanup left the exact fixture-scoped unknown-source Settings page",
                isExactFixtureScopedUnknownSourcePage());
    }

    private boolean isExactFixtureScopedUnknownSourcePage() {
        return SETTINGS_PACKAGE.equals(device.getCurrentPackageName())
                && exactSettingsText(FIXTURE_LABEL).size() == 1
                && exactSettingsText(UNKNOWN_SOURCE_LABEL).size() == 1;
    }

    private List<UiObject2> exactSettingsText(String text) {
        return device.findObjects(
                By.text(text)
                        .pkg(SETTINGS_PACKAGE)
                        .clazz(TEXT_VIEW_CLASS)
                        .enabled(true));
    }

    private UiObject2 requireExactUnknownSourceToggle() {
        List<UiObject2> labels = exactSettingsText(UNKNOWN_SOURCE_LABEL);
        assertEquals("Unknown-source label was not unique", 1, labels.size());
        UiObject2 toggle = labels.get(0).getParent();
        assertNotNull("Unknown-source semantic toggle was unavailable", toggle);
        assertEquals("Unexpected toggle package", SETTINGS_PACKAGE, toggle.getApplicationPackage());
        assertEquals("Unexpected toggle class", SEMANTIC_TOGGLE_CLASS, toggle.getClassName());
        String resourceName = toggle.getResourceName();
        assertTrue(
                "Semantic toggle unexpectedly acquired a resource id",
                resourceName == null || resourceName.isEmpty());
        assertTrue("Unknown-source toggle was disabled", toggle.isEnabled());
        assertTrue("Unknown-source toggle was not clickable", toggle.isClickable());
        assertTrue("Unknown-source toggle was not checkable", toggle.isCheckable());
        return toggle;
    }

    private void waitForUnknownSourceState(boolean expected, String label) {
        long deadline = SystemClock.uptimeMillis() + UI_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            if (isExactFixtureScopedUnknownSourcePage()) {
                UiObject2 toggle = requireExactUnknownSourceToggle();
                if (toggle.isChecked() == expected) {
                    return;
                }
            }
            SystemClock.sleep(100L);
        }
        fail("Timed out waiting for " + label);
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
        receipt.put("classification", "fixture-external-permission-cleanup-only");
        receipt.put("separateDriverPackage", driverContext != null && DRIVER_PACKAGE.equals(driverContext.getPackageName()));
        receipt.put("fixturePackage", FIXTURE_PACKAGE);
        receipt.put("fixtureLabel", FIXTURE_LABEL);
        receipt.put("fixtureIdentityObserved", fixtureIdentityObserved);
        receipt.put("scopedSettingsObserved", scopedSettingsObserved);
        receipt.put("permissionInitiallyEnabled", permissionInitiallyEnabled);
        receipt.put("cleanupClicked", cleanupClicked);
        receipt.put("settledOffSamples", settledOffSamples);
        receipt.put("permissionVisiblyOff", permissionVisiblyOff);
        receipt.put("directPermissionMutationUsed", false);
        receipt.put("coreFlowProof", false);
        receipt.put("publicOtaProof", false);
        receipt.put("installProof", false);
        receipt.put("failure", failure == null ? JSONObject.NULL : failure.getClass().getSimpleName());
        try (FileOutputStream output = new FileOutputStream(new File(evidenceDir, "receipt.json"))) {
            output.write((receipt.toString(2) + "\n").getBytes(StandardCharsets.UTF_8));
        }
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
