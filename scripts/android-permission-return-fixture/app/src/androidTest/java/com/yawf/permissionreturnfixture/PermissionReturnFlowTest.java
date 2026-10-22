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
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

@RunWith(AndroidJUnit4.class)
public final class PermissionReturnFlowTest {
    private static final long UI_WAIT_MS = 30_000L;
    private static final long VERIFY_WAIT_MS = 15_000L;
    private static final long SETTLE_SAMPLE_MS = 250L;
    private static final int MAX_CAPTURES = 8;
    private static final int ZIP_EOCD_MIN_BYTES = 22;
    private static final int ZIP_MAX_COMMENT_BYTES = 65_535;
    private static final int ZIP_EOCD_SIGNATURE = 0x06054b50;
    private static final int APK_SIGNING_BLOCK_PADDING_ID = 0x42726577;
    private static final int MAX_SIGNING_PADDING_BYTES = 64 * 1024;
    private static final byte[] APK_SIGNING_BLOCK_MAGIC =
            "APK Sig Block 42".getBytes(StandardCharsets.US_ASCII);

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
    private boolean identityBeforeTamperValidated;
    private boolean identityAfterTamperValidated;
    private String originalDigest;
    private String tamperedDigest;
    private String retryMessage;
    private long tamperedPaddingOffset = -1L;
    private int signingPaddingBytes;
    private PackageIdentity installedIdentity;
    private PackageIdentity originalArchiveIdentity;

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
        assertTrue(
                "Target APK digest pin was not finalized",
                BuildConfig.TAMPER_TARGET_SHA256.matches("[0-9a-f]{64}"));
        assertTrue("Target APK size pin was not finalized", BuildConfig.TAMPER_TARGET_SIZE > 0L);

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
        try (InputStream input = targetContext.getAssets().open(FixturePolicy.TARGET_ASSET_NAME);
                FileOutputStream output = new FileOutputStream(stagedFile)) {
            byte[] buffer = new byte[8192];
            long total = 0L;
            int count;
            while ((count = input.read(buffer)) >= 0) {
                total += count;
                assertTrue("Target asset exceeded its size pin", total <= BuildConfig.TAMPER_TARGET_SIZE);
                output.write(buffer, 0, count);
            }
            output.getFD().sync();
        }
        assertEquals(BuildConfig.TAMPER_TARGET_SIZE, stagedFile.length());
        originalDigest = sha256(stagedFile);
        assertEquals(
                "Target asset digest did not match its build pin",
                BuildConfig.TAMPER_TARGET_SHA256,
                originalDigest);

        installedIdentity = installedIdentity();
        originalArchiveIdentity = archiveIdentity(stagedFile);
        assertTrue("Target APK was not newer than the installed fixture",
                FixturePolicy.TEST_VERSION_CODE > installedIdentity.versionCode);
        assertTargetArchiveIdentity(originalArchiveIdentity);
        assertFalse("Installed current signer set was empty", installedIdentity.signers.isEmpty());
        assertEquals(
                "Target current signer set did not match the installed fixture",
                installedIdentity.signers,
                originalArchiveIdentity.signers);
        identityBeforeTamperValidated = true;

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
        tamperedPaddingOffset = requireZeroPaddingEntryOffset(stagedFile);
        try (RandomAccessFile file = new RandomAccessFile(stagedFile, "rw")) {
            file.seek(tamperedPaddingOffset);
            assertEquals("Signing-block padding byte was not zero", 0, file.read());
            file.seek(tamperedPaddingOffset);
            file.write(1);
            file.getFD().sync();
        }
        assertEquals("Tamper changed the staged length", before, stagedFile.length());
        assertOnlyAssetPaddingByteChanged();
        tamperedDigest = sha256(stagedFile);
        assertNotEquals("Tamper did not change the staged digest", originalDigest, tamperedDigest);

        PackageIdentity tamperedArchiveIdentity = archiveIdentity(stagedFile);
        assertTargetArchiveIdentity(tamperedArchiveIdentity);
        assertEquals(
                "Tamper changed the parsed target package",
                originalArchiveIdentity.packageName,
                tamperedArchiveIdentity.packageName);
        assertEquals(
                "Tamper changed the parsed target version name",
                originalArchiveIdentity.versionName,
                tamperedArchiveIdentity.versionName);
        assertEquals(
                "Tamper changed the parsed target version code",
                originalArchiveIdentity.versionCode,
                tamperedArchiveIdentity.versionCode);
        assertEquals(
                "Tamper changed the target current signer set",
                originalArchiveIdentity.signers,
                tamperedArchiveIdentity.signers);
        assertEquals(
                "Tampered target current signer set did not match the installed fixture",
                installedIdentity.signers,
                tamperedArchiveIdentity.signers);
        identityAfterTamperValidated = true;
    }

    private void waitForTamperFailureWithoutInstaller() {
        long deadline = SystemClock.uptimeMillis() + VERIFY_WAIT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            observeInstallerSurfaces();
            UiObject2 changedMessage = findChangedRetryMessage();
            UiObject2 retry = findUniqueNativeDialogButton("button1", "Retry");
            UiObject2 cancel = findUniqueNativeDialogButton("button2", "Cancel update");
            if (device.hasObject(By.text(FixturePolicy.RETRY_TITLE))
                    && changedMessage != null
                    && retry != null
                    && cancel != null) {
                retryMessage = String.valueOf(changedMessage.getText());
                assertEquals(
                        "Retry message was not the exact changed-stage failure",
                        FixturePolicy.CHANGED_MESSAGE,
                        retryMessage);
                int settled = 0;
                while (settled < FixturePolicy.SETTLED_SAMPLES) {
                    observeInstallerSurfaces();
                    assertTrue(
                            "Tamper failure dialog did not remain settled",
                            device.hasObject(By.text(FixturePolicy.RETRY_TITLE))
                                    && findChangedRetryMessage() != null
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

    private UiObject2 findChangedRetryMessage() {
        UiObject2 object = device.findObject(
                By.text(FixturePolicy.CHANGED_MESSAGE).pkg(FixturePolicy.FIXTURE_PACKAGE));
        return object != null
                        && FixturePolicy.isChangedRetryMessage(String.valueOf(object.getText()))
                ? object
                : null;
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
        receipt.put("originalSha256", originalDigest == null ? JSONObject.NULL : originalDigest);
        receipt.put("tamperedSha256", tamperedDigest == null ? JSONObject.NULL : tamperedDigest);
        receipt.put("retryMessage", retryMessage == null ? JSONObject.NULL : retryMessage);
        receipt.put("identityBeforeTamperValidated", identityBeforeTamperValidated);
        receipt.put("identityAfterTamperValidated", identityAfterTamperValidated);
        receipt.put("signingPaddingBytes", signingPaddingBytes);
        receipt.put("tamperedPaddingOffset", tamperedPaddingOffset);
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

    private PackageIdentity installedIdentity() throws Exception {
        PackageInfo info = targetContext.getPackageManager().getPackageInfo(
                FixturePolicy.FIXTURE_PACKAGE,
                PackageManager.GET_SIGNING_CERTIFICATES);
        return identityFromPackageInfo(info);
    }

    private PackageIdentity archiveIdentity(File apk) throws Exception {
        PackageInfo info = targetContext.getPackageManager().getPackageArchiveInfo(
                apk.getAbsolutePath(),
                PackageManager.GET_SIGNING_CERTIFICATES);
        assertNotNull("PackageManager could not parse the target APK", info);
        return identityFromPackageInfo(info);
    }

    private static PackageIdentity identityFromPackageInfo(PackageInfo info) throws Exception {
        assertNotNull("SigningInfo was unavailable", info.signingInfo);
        android.content.pm.Signature[] currentSigners = info.signingInfo.getApkContentsSigners();
        assertNotNull("Current APK signer set was unavailable", currentSigners);
        Set<String> signers = new TreeSet<>();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (android.content.pm.Signature signer : currentSigners) {
            signers.add(toHex(digest.digest(signer.toByteArray())));
        }
        return new PackageIdentity(
                info.packageName,
                info.versionName == null ? "" : info.versionName,
                info.getLongVersionCode(),
                signers);
    }

    private static void assertTargetArchiveIdentity(PackageIdentity identity) {
        assertEquals(
                "Target APK package name was not the fixture package",
                FixturePolicy.FIXTURE_PACKAGE,
                identity.packageName);
        assertEquals(
                "Target APK version name was not the seeded candidate version",
                FixturePolicy.TEST_VERSION,
                identity.versionName);
        assertEquals(
                "Target APK version code was not the seeded candidate version",
                FixturePolicy.TEST_VERSION_CODE,
                identity.versionCode);
        assertFalse("Target APK current signer set was empty", identity.signers.isEmpty());
    }

    private long requireZeroPaddingEntryOffset(File apk) throws Exception {
        try (RandomAccessFile file = new RandomAccessFile(apk, "r")) {
            long eocdOffset = requireEocdOffset(file);
            byte[] eocd = readExactly(file, eocdOffset, ZIP_EOCD_MIN_BYTES);
            ByteBuffer end = ByteBuffer.wrap(eocd).order(ByteOrder.LITTLE_ENDIAN);
            assertEquals("EOCD signature changed", ZIP_EOCD_SIGNATURE, end.getInt(0));
            assertEquals("Multi-disk APK is unsupported", 0, Short.toUnsignedInt(end.getShort(4)));
            assertEquals("Multi-disk central directory is unsupported", 0, Short.toUnsignedInt(end.getShort(6)));
            assertEquals(
                    "Split central directory entry counts are unsupported",
                    Short.toUnsignedInt(end.getShort(8)),
                    Short.toUnsignedInt(end.getShort(10)));
            long centralDirectorySize = Integer.toUnsignedLong(end.getInt(12));
            long centralDirectoryOffset = Integer.toUnsignedLong(end.getInt(16));
            assertNotEquals("ZIP64 central-directory size is unsupported", 0xffff_ffffL, centralDirectorySize);
            assertNotEquals("ZIP64 central-directory offset is unsupported", 0xffff_ffffL, centralDirectoryOffset);
            assertEquals(
                    "Central directory did not end at the EOCD",
                    eocdOffset,
                    Math.addExact(centralDirectoryOffset, centralDirectorySize));
            assertTrue("APK signing block footer was unavailable", centralDirectoryOffset >= 24L);

            long footerOffset = centralDirectoryOffset - 24L;
            byte[] footer = readExactly(file, footerOffset, 24);
            ByteBuffer footerBuffer = ByteBuffer.wrap(footer).order(ByteOrder.LITTLE_ENDIAN);
            long blockSize = footerBuffer.getLong();
            byte[] magic = new byte[APK_SIGNING_BLOCK_MAGIC.length];
            footerBuffer.get(magic);
            assertTrue("APK signing block size was invalid", blockSize >= 24L);
            assertTrue("APK signing block size exceeded the file", blockSize <= centralDirectoryOffset - 8L);
            assertTrue(
                    "APK signing block magic was missing",
                    Arrays.equals(APK_SIGNING_BLOCK_MAGIC, magic));

            long blockStart = centralDirectoryOffset - Math.addExact(blockSize, 8L);
            assertTrue("APK signing block start was invalid", blockStart >= 0L);
            assertEquals(
                    "APK signing block header and footer sizes differed",
                    blockSize,
                    readLongLittleEndian(file, blockStart));

            long cursor = blockStart + 8L;
            long paddingOffset = -1L;
            int paddingLength = -1;
            while (cursor < footerOffset) {
                long remaining = footerOffset - cursor;
                assertTrue("APK signing block pair header was truncated", remaining >= 12L);
                long pairSize = readLongLittleEndian(file, cursor);
                assertTrue("APK signing block pair size was invalid", pairSize >= 4L);
                assertTrue("APK signing block pair exceeded its block", pairSize <= remaining - 8L);
                int pairId = readIntLittleEndian(file, cursor + 8L);
                long valueOffset = cursor + 12L;
                long valueSize = pairSize - 4L;
                long pairEnd = Math.addExact(valueOffset, valueSize);
                assertTrue("APK signing block pair boundary was invalid", pairEnd <= footerOffset);
                if (pairId == APK_SIGNING_BLOCK_PADDING_ID) {
                    assertEquals("APK signing block contained duplicate padding entries", -1L, paddingOffset);
                    assertTrue(
                            "APK signing block padding length was outside the fixture bound",
                            valueSize >= 1L && valueSize <= MAX_SIGNING_PADDING_BYTES);
                    byte[] padding = readExactly(file, valueOffset, Math.toIntExact(valueSize));
                    for (byte item : padding) {
                        assertEquals("APK signing block padding was not zero-filled", 0, item);
                    }
                    paddingLength = padding.length;
                    paddingOffset = valueOffset + (padding.length / 2L);
                }
                cursor = pairEnd;
            }
            assertEquals("APK signing block pair table did not end at its footer", footerOffset, cursor);
            assertTrue("APK signing block padding entry was absent", paddingOffset >= 0L);
            signingPaddingBytes = paddingLength;
            return paddingOffset;
        }
    }

    private static long requireEocdOffset(RandomAccessFile file) throws Exception {
        long fileLength = file.length();
        assertTrue("APK was too short for a ZIP EOCD", fileLength >= ZIP_EOCD_MIN_BYTES);
        int tailLength = (int) Math.min(
                fileLength,
                ZIP_EOCD_MIN_BYTES + (long) ZIP_MAX_COMMENT_BYTES);
        long tailOffset = fileLength - tailLength;
        byte[] tail = readExactly(file, tailOffset, tailLength);
        long eocdOffset = -1L;
        for (int index = tail.length - ZIP_EOCD_MIN_BYTES; index >= 0; index--) {
            if (littleEndianInt(tail, index) != ZIP_EOCD_SIGNATURE) continue;
            int commentLength = littleEndianUnsignedShort(tail, index + 20);
            if (index + ZIP_EOCD_MIN_BYTES + commentLength != tail.length) continue;
            assertEquals("APK contained ambiguous terminal ZIP EOCD records", -1L, eocdOffset);
            eocdOffset = tailOffset + index;
        }
        assertTrue("APK ZIP EOCD was absent or malformed", eocdOffset >= 0L);
        return eocdOffset;
    }

    private void assertOnlyAssetPaddingByteChanged() throws Exception {
        int mismatches = 0;
        long mismatchOffset = -1L;
        long cursor = 0L;
        try (InputStream original = targetContext.getAssets().open(FixturePolicy.TARGET_ASSET_NAME);
                RandomAccessFile changed = new RandomAccessFile(stagedFile, "r")) {
            byte[] originalBytes = new byte[8192];
            byte[] changedBytes = new byte[8192];
            int count;
            while ((count = original.read(originalBytes)) >= 0) {
                if (count == 0) continue;
                changed.readFully(changedBytes, 0, count);
                for (int index = 0; index < count; index++) {
                    if (originalBytes[index] != changedBytes[index]) {
                        mismatches++;
                        mismatchOffset = cursor + index;
                        assertEquals("Original padding byte was not zero", 0, originalBytes[index]);
                        assertEquals("Changed padding byte was not one", 1, changedBytes[index]);
                    }
                }
                cursor += count;
            }
            assertEquals("Changed APK length exceeded the target asset", -1, changed.read());
        }
        assertEquals("Tamper changed more or fewer than one APK byte", 1, mismatches);
        assertEquals("Tamper changed a byte outside the parsed padding entry", tamperedPaddingOffset, mismatchOffset);
    }

    private static byte[] readExactly(RandomAccessFile file, long offset, int size) throws IOException {
        byte[] bytes = new byte[size];
        file.seek(offset);
        file.readFully(bytes);
        return bytes;
    }

    private static long readLongLittleEndian(RandomAccessFile file, long offset) throws IOException {
        return ByteBuffer.wrap(readExactly(file, offset, Long.BYTES))
                .order(ByteOrder.LITTLE_ENDIAN)
                .getLong();
    }

    private static int readIntLittleEndian(RandomAccessFile file, long offset) throws IOException {
        return ByteBuffer.wrap(readExactly(file, offset, Integer.BYTES))
                .order(ByteOrder.LITTLE_ENDIAN)
                .getInt();
    }

    private static int littleEndianInt(byte[] bytes, int offset) {
        return ByteBuffer.wrap(bytes, offset, Integer.BYTES)
                .order(ByteOrder.LITTLE_ENDIAN)
                .getInt();
    }

    private static int littleEndianUnsignedShort(byte[] bytes, int offset) {
        return Short.toUnsignedInt(
                ByteBuffer.wrap(bytes, offset, Short.BYTES)
                        .order(ByteOrder.LITTLE_ENDIAN)
                        .getShort());
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

    private static String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        }
        return value.toString();
    }

    private static final class PackageIdentity {
        final String packageName;
        final String versionName;
        final long versionCode;
        final Set<String> signers;

        PackageIdentity(String packageName, String versionName, long versionCode, Set<String> signers) {
            this.packageName = packageName;
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.signers = signers;
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
