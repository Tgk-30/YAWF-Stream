package com.yawf.ownedstartup;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.Looper;

import app.tauri.plugin.PluginManager;

import org.junit.internal.TextListener;
import org.junit.runner.Description;
import org.junit.runner.JUnitCore;
import org.junit.runner.Request;
import org.junit.runner.Result;
import org.junit.runner.notification.Failure;
import org.junit.runner.notification.RunListener;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

/** Injects only after the real target Activity completed onCreate, before first resume/draw. */
public final class OwnedDestroyInstrumentationRunner extends Instrumentation {
    public static final String TARGET_PACKAGE = "com.tgk30.debridstreamer";
    public static final String TARGET_ACTIVITY = "com.tgk30.debridstreamer.MainActivity";
    public static final String FAULT_PLUGIN_NAME = "";
    private static final String TEST_CLASS = "com.yawf.ownedstartup.OwnedDestroyRetryTest";
    private static final String TEST_METHOD = "acceptedPluginLoadFailureIsDestroyedThenOneNativeRetrySucceeds";
    private static volatile OwnedDestroyInstrumentationRunner current;

    private boolean bootstrapRefused;
    private volatile boolean junitRunning;

    private Activity targetActivity;
    private FaultOncePlugin faultPlugin;
    private PluginManager targetPluginManager;
    private int targetActivityCreateCount;
    private int targetPid;
    private String refusalCode;
    private boolean injected;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        synchronized (OwnedDestroyInstrumentationRunner.class) {
            bootstrapRefused = current != null || arguments == null ||
                    !(TEST_CLASS + "#" + TEST_METHOD).equals(arguments.getString("class"));
            if (!bootstrapRefused) current = this;
        }
        start();
    }

    static OwnedDestroyInstrumentationRunner currentRunner() {
        OwnedDestroyInstrumentationRunner runner = current;
        if (runner == null || runner.getClass() != OwnedDestroyInstrumentationRunner.class || !runner.junitRunning) {
            throw new IllegalStateException("OWNED_JUNIT_RUNNER_NOT_ACTIVE");
        }
        return runner;
    }

    @Override
    public void onStart() {
        Bundle results = new Bundle();
        BoundedJUnitOutput output = new BoundedJUnitOutput();
        boolean success = false;
        try (PrintStream text = new PrintStream(output, true, StandardCharsets.UTF_8.name())) {
            if (bootstrapRefused || current != this || Looper.myLooper() == Looper.getMainLooper()) {
                throw new IllegalStateException("OWNED_JUNIT_BOOTSTRAP_REFUSED");
            }
            junitRunning = true;
            ActualRunListener observed = new ActualRunListener();
            JUnitCore junit = new JUnitCore();
            junit.addListener(observed);
            junit.addListener(new TextListener(text));
            Result result = junit.run(Request.method(OwnedDestroyRetryTest.class, TEST_METHOD));
            text.flush();
            success = observed.singleSuccessfulTest(result) && !output.truncated() && !text.checkError();
            results.putString("stream", output.text());
        } catch (Throwable failure) {
            success = false;
            // Bootstrap/linkage failures are never converted to test evidence or
            // a synthetic JUnit result. Exception messages remain private.
            results.putString("stream", "OWNED_JUNIT_BOOTSTRAP_FAILED\n");
        } finally {
            junitRunning = false;
            synchronized (OwnedDestroyInstrumentationRunner.class) {
                if (current == this) current = null;
            }
            finish(success ? Activity.RESULT_OK : Activity.RESULT_CANCELED, results);
        }
    }

    private final class ActualRunListener extends RunListener {
        private int runStarts;
        private int runFinishes;
        private int starts;
        private int finishes;
        private int failures;
        private int ignored;
        private int assumptions;
        private boolean identityMatched = true;

        @Override public void testRunStarted(Description description) {
            runStarts++;
            identityMatched &= description.testCount() == 1;
        }

        @Override public void testStarted(Description description) {
            starts++;
            publish(1, description);
        }

        @Override public void testFinished(Description description) {
            finishes++;
            publish(failures == 0 && assumptions == 0 ? 0 : -2, description);
        }

        @Override public void testFailure(Failure failure) {
            failures++;
            identityMatched &= matches(failure.getDescription());
        }

        @Override public void testIgnored(Description description) {
            ignored++;
            identityMatched &= matches(description);
        }

        @Override public void testAssumptionFailure(Failure failure) {
            assumptions++;
            identityMatched &= matches(failure.getDescription());
        }

        @Override public void testRunFinished(Result result) { runFinishes++; }

        private boolean matches(Description description) {
            return description.isTest() && TEST_CLASS.equals(description.getClassName()) &&
                    TEST_METHOD.equals(description.getMethodName());
        }

        private void publish(int code, Description description) {
            if (!matches(description)) {
                identityMatched = false;
                return;
            }
            Bundle status = new Bundle();
            status.putString("class", description.getClassName());
            status.putString("test", description.getMethodName());
            status.putInt("numtests", 1);
            sendStatus(code, status);
        }

        private boolean singleSuccessfulTest(Result result) {
            return identityMatched && runStarts == 1 && runFinishes == 1 && starts == 1 && finishes == 1 &&
                    failures == 0 && ignored == 0 && assumptions == 0 && result.wasSuccessful() &&
                    result.getRunCount() == 1 && result.getFailureCount() == 0 &&
                    result.getIgnoreCount() == 0 && result.getAssumptionFailureCount() == 0;
        }
    }

    private static final class BoundedJUnitOutput extends OutputStream {
        private static final int MAX_BYTES = 16_384;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream(MAX_BYTES);
        private boolean truncated;

        @Override public synchronized void write(int value) {
            if (bytes.size() < MAX_BYTES) bytes.write(value);
            else truncated = true;
        }

        @Override public synchronized void write(byte[] values, int offset, int length) {
            int accepted = Math.min(length, MAX_BYTES - bytes.size());
            bytes.write(values, offset, accepted);
            if (accepted != length) truncated = true;
        }

        synchronized boolean truncated() { return truncated; }
        synchronized String text() { return new String(bytes.toByteArray(), StandardCharsets.UTF_8); }
    }

    @Override
    public void callActivityOnCreate(Activity activity, Bundle state) {
        super.callActivityOnCreate(activity, state);
        if (!TARGET_PACKAGE.equals(activity.getPackageName())) return;
        synchronized (this) {
            targetActivityCreateCount++;
            if (!TARGET_ACTIVITY.equals(activity.getClass().getName())) {
                refusalCode = "TARGET_ACTIVITY_IDENTITY_MISMATCH";
                return;
            }
            if (targetActivityCreateCount != 1 || targetActivity != null || injected) {
                refusalCode = "TARGET_ACTIVITY_CREATED_MORE_THAN_ONCE";
                return;
            }
            targetActivity = activity;
            targetPid = android.os.Process.myPid();
            targetPluginManager = pluginManagerFromKeptActivityAccessor(activity);
            if (targetPluginManager == null) {
                refusalCode = "KEPT_PLUGIN_MANAGER_ACCESSOR_UNAVAILABLE";
                return;
            }
            faultPlugin = new FaultOncePlugin(activity, this, targetPluginManager);
            if (!faultPlugin.registrationKeyAvailable()) {
                refusalCode = "FAULT_PLUGIN_KEY_ALREADY_EXISTS_OR_MANAGER_AMBIGUOUS";
                return;
            }
            try {
                // Null WebView registers the plugin only. Its later invocation comes
                // from the ordinary production Wry -> Tauri PluginManager callback.
                targetPluginManager.load(null, FAULT_PLUGIN_NAME, faultPlugin, "{}");
                injected = true;
            } catch (RuntimeException | LinkageError ignored) {
                refusalCode = "PLUGIN_REGISTRATION_FAILED";
            }
        }
    }

    synchronized Activity targetActivity() { return targetActivity; }
    synchronized FaultOncePlugin faultPlugin() { return faultPlugin; }
    synchronized PluginManager targetPluginManager() { return targetPluginManager; }
    synchronized int targetActivityCreateCount() { return targetActivityCreateCount; }
    synchronized int targetPid() { return targetPid; }
    synchronized String refusalCode() { return refusalCode; }
    synchronized boolean injected() { return injected; }

    synchronized void refuse(String code) {
        if (refusalCode == null) refusalCode = code;
    }

    synchronized void recordTargetFaultLoad() {
        // The plugin itself checks the live HashMap iteration order at this call.
    }

    private static PluginManager pluginManagerFromKeptActivityAccessor(Activity activity) {
        try {
            Object value = activity.getClass().getMethod("getPluginManager").invoke(activity);
            return value instanceof PluginManager ? (PluginManager) value : null;
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return null;
        }
    }
}
