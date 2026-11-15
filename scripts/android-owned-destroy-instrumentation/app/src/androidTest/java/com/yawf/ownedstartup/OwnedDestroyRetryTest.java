package com.yawf.ownedstartup;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import app.tauri.plugin.Plugin;
import app.tauri.plugin.PluginHandle;
import app.tauri.plugin.PluginManager;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.rules.TestWatcher;
import org.junit.runner.Description;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;


/** One real app launch, one qualifying injected failure, one verified native tap, no retry loop. */
@RunWith(AndroidJUnit4.class)
public final class OwnedDestroyRetryTest {
    private static final long TOTAL_DEADLINE_MS = 150_000L;
    private static final long FAILURE_UI_DEADLINE_MS = 60_000L;
    private static final long RETRY_DEADLINE_MS = 90_000L;
    private static final long POLL_MS = 100L;
    private static final long TAP_PLAN_MAX_AGE_MS = 2_000L;
    private static final String HELPER_CLASS = "com.tgk30.debridstreamer.YawfWebViewStartup";
    private static final String RETRY_LABEL = "Retry startup";

    private final Map<String, Object> evidence = new LinkedHashMap<>();
    private long startedAt;
    private String phase = "NOT_STARTED";
    private String failureCode = "";
    private int tapCount;
    private boolean qualified;
    private boolean targetPackageMatched;
    private boolean wryClearedBeforeTap;
    private boolean helperClearedBeforeTap;
    private boolean oldDetachedBeforeTap;
    private boolean noDecorWebViewBeforeTap;
    private boolean uniqueRetryButtonBeforeTap;
    private boolean sameActivityAfterRetry;
    private boolean wryOwnsNewWebView;
    private boolean activityReferencesNewWebView;
    private boolean soleDecorWebViewAfterRetry;
    private boolean retryUiGoneAfterRetry;

    @Rule
    public final TestWatcher evidenceWatcher = new TestWatcher() {
        @Override protected void failed(Throwable error, Description description) {
            // Never serialize exception text: it can contain environment-specific details.
            failureCode = phase + "_FAILED";
        }

        @Override protected void finished(Description description) {
            emitEvidence();
        }
    };

    @Test
    public void acceptedPluginLoadFailureIsDestroyedThenOneNativeRetrySucceeds() throws Exception {
        startedAt = SystemClock.elapsedRealtime();
        phase = "PREFLIGHT";
        OwnedDestroyInstrumentationRunner instrumentation =
                (OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation();
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        require(OwnedDestroyInstrumentationRunner.TARGET_PACKAGE.equals(target.getPackageName()), "TARGET_PACKAGE_MISMATCH");
        targetPackageMatched = true;
        require((target.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0,
                "TARGET_PACKAGE_IS_DEBUGGABLE");
        require(instrumentation.targetActivityCreateCount() == 0, "TARGET_APP_WAS_NOT_FRESH");

        phase = "LAUNCH_ONCE";
        Intent launch = target.getPackageManager().getLaunchIntentForPackage(OwnedDestroyInstrumentationRunner.TARGET_PACKAGE);
        require(launch != null, "TARGET_LAUNCH_INTENT_MISSING");
        require(launch.getComponent() != null &&
                OwnedDestroyInstrumentationRunner.TARGET_ACTIVITY.equals(launch.getComponent().getClassName()),
                "TARGET_LAUNCH_COMPONENT_MISMATCH");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        InstrumentationRegistry.getInstrumentation().startActivitySync(launch);
        await(instrumentation, FAILURE_UI_DEADLINE_MS, this::failureUiReady, "INJECTED_FAILURE_UI_TIMEOUT");

        phase = "PRE_RETRY_ASSERTIONS";
        Activity activity = requireTargetActivity(instrumentation);
        FaultOncePlugin fault = requireFaultPlugin(instrumentation);
        UiSnapshot before = inspectOnMain(activity);
        WebView oldView = fault.firstView();
        require(oldView != null && fault.loadCount() == 1 && fault.faultInjected(), "FIRST_FAILURE_NOT_INJECTED_ONCE");
        require(fault.firstPluginVerified(), "FAULT_NOT_FIRST");
        require(viewDetachedOnMain(oldView), "OLD_WEBVIEW_NOT_DETACHED_BEFORE_RETRY");
        require(readUniqueWryWebViewField(activity) == null, "WRY_WEBVIEW_FIELD_NOT_CLEARED_BEFORE_RETRY");
        require(readUniqueHelperAcceptedWebView(activity) == null, "HELPER_ACCEPTED_WEBVIEW_NOT_CLEARED_BEFORE_RETRY");
        require(before.decorWebViewCount == 0, "DECOR_STILL_OWNS_WEBVIEW_BEFORE_RETRY");
        require(before.retryButtonCount == 1 && before.retryButtonShownAndEnabled, "RETRY_BUTTON_NOT_UNIQUE_SHOWN_ENABLED");
        oldDetachedBeforeTap = true;
        wryClearedBeforeTap = true;
        helperClearedBeforeTap = true;
        noDecorWebViewBeforeTap = true;
        uniqueRetryButtonBeforeTap = true;

        phase = "ONE_VERIFIED_NATIVE_TAP";
        TapPlan tap = buildTapPlanOnMain(activity);
        require(SystemClock.elapsedRealtime() - tap.capturedAt <= TAP_PLAN_MAX_AGE_MS, "RETRY_TAP_PLAN_EXPIRED");
        require(tapCount == 0, "RETRY_TAP_ALREADY_USED");
        tapCount = 1;
        sendExactlyOneTap(InstrumentationRegistry.getInstrumentation(), tap);

        phase = "WAITING_FOR_SAME_ACTIVITY_RETRY";
        await(instrumentation, RETRY_DEADLINE_MS, this::successfulRetryReady, "RETRY_SUCCESS_TIMEOUT");

        phase = "FINAL_ASSERTIONS";
        require(elapsed() <= TOTAL_DEADLINE_MS, "TOTAL_DEADLINE_EXCEEDED");
        Activity current = requireTargetActivity(instrumentation);
        FaultOncePlugin currentFault = requireFaultPlugin(instrumentation);
        WebView newView = currentFault.secondView();
        UiSnapshot after = inspectOnMain(current);
        require(current == activity, "TARGET_ACTIVITY_IDENTITY_CHANGED");
        require(instrumentation.targetActivityCreateCount() == 1, "TARGET_ACTIVITY_COUNT_CHANGED");
        require(instrumentation.targetPid() == android.os.Process.myPid(), "TARGET_PROCESS_PID_CHANGED");
        require(currentFault.loadCount() == 2, "PLUGIN_LOAD_COUNT_NOT_TWO");
        require(currentFault.firstPluginVerified() && currentFault.faultInjected(), "FAULT_PROVENANCE_MISSING");
        require(newView != null && newView != oldView, "RETRY_WEBVIEW_NOT_DISTINCT");
        require(viewAttachedOnMain(newView), "RETRY_WEBVIEW_NOT_ATTACHED");
        require(viewDetachedOnMain(oldView), "OLD_WEBVIEW_REATTACHED");
        require(readUniqueWryWebViewField(current) == newView, "WRY_ACTIVITY_NOT_OWNING_NEW_WEBVIEW");
        require(readUniqueHelperAcceptedWebView(current) == null, "HELPER_RETAINS_ACCEPTED_WEBVIEW_AFTER_STORAGE");
        require(mainActivityReferencesNewView(current, newView, oldView), "ACTIVITY_DOES_NOT_REFERENCE_NEW_WEBVIEW");
        require(after.decorWebViewCount == 1 && after.onlyDecorWebView == newView, "RETRY_WEBVIEW_NOT_SOLE_DECOR_WEBVIEW");
        require(after.retryButtonCount == 0, "FAILURE_UI_NOT_GONE_AFTER_RETRY");
        require(pluginHandleLoaded(currentFault), "PLUGIN_HANDLE_NOT_LOADED_AFTER_CALLBACK_RETURN");
        sameActivityAfterRetry = true;
        wryOwnsNewWebView = true;
        activityReferencesNewWebView = true;
        soleDecorWebViewAfterRetry = true;
        retryUiGoneAfterRetry = true;
        qualified = true;
        phase = "QUALIFIED_SELECTED_STARTUP_RETRY_ONLY";
    }

    private boolean failureUiReady() {
        String refusal = ((OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation()).refusalCode();
        if (refusal != null) fail("RUNNER_REFUSED_" + refusal);
        FaultOncePlugin fault = ((OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation()).faultPlugin();
        Activity activity = ((OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation()).targetActivity();
        if (fault == null || activity == null) return false;
        if (fault.loadCount() == 0) return false;
        if (!fault.firstPluginVerified()) fail("FAULT_NOT_FIRST");
        if (!fault.faultInjected()) fail("FAULT_INJECTION_MARKER_MISSING");
        UiSnapshot snapshot = inspectOnMain(activity);
        return snapshot.retryButtonCount == 1 && snapshot.retryButtonShownAndEnabled;
    }

    private boolean successfulRetryReady() {
        OwnedDestroyInstrumentationRunner runner =
                (OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation();
        String refusal = runner.refusalCode();
        if (refusal != null) fail("RUNNER_REFUSED_" + refusal);
        Activity activity = runner.targetActivity();
        FaultOncePlugin fault = runner.faultPlugin();
        if (activity == null || fault == null || fault.loadCount() < 2 || fault.secondView() == null) return false;
        WebView newView = fault.secondView();
        if (newView == fault.firstView() || !viewAttachedOnMain(newView)) return false;
        if (readUniqueWryWebViewField(activity) != newView || readUniqueHelperAcceptedWebView(activity) != null) return false;
        UiSnapshot snapshot = inspectOnMain(activity);
        return snapshot.decorWebViewCount == 1 && snapshot.onlyDecorWebView == newView && snapshot.retryButtonCount == 0;
    }

    private boolean pluginHandleLoaded(FaultOncePlugin fault) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(pluginHandleLoadedOnMain(fault)));
        return result.get();
    }

    private boolean pluginHandleLoadedOnMain(FaultOncePlugin fault) {
        try {
            Map<?, ?> plugins = livePluginManagerMap(fault.pluginManager());
            Object handle = plugins.get(OwnedDestroyInstrumentationRunner.FAULT_PLUGIN_NAME);
            if (!(handle instanceof PluginHandle)) return false;
            PluginHandle pluginHandle = (PluginHandle) handle;
            return uniquePluginInstance(pluginHandle) == fault && uniqueLoadedFlag(pluginHandle);
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return false;
        }
    }

    private static Plugin uniquePluginInstance(PluginHandle handle) throws ReflectiveOperationException {
        List<Field> candidates = new ArrayList<>();
        for (Field field : handle.getClass().getDeclaredFields()) {
            if (Plugin.class.isAssignableFrom(field.getType())) candidates.add(field);
        }
        if (candidates.size() != 1) throw new IllegalStateException("PLUGIN_INSTANCE_FIELD_AMBIGUOUS");
        Field field = candidates.get(0);
        field.setAccessible(true);
        Object value = field.get(handle);
        if (!(value instanceof Plugin)) throw new IllegalStateException("PLUGIN_INSTANCE_FIELD_INVALID");
        return (Plugin) value;
    }

    private static boolean uniqueLoadedFlag(PluginHandle handle) throws ReflectiveOperationException {
        List<Field> candidates = new ArrayList<>();
        for (Field field : handle.getClass().getDeclaredFields()) {
            if (field.getType() == boolean.class) candidates.add(field);
        }
        if (candidates.size() != 1) throw new IllegalStateException("PLUGIN_LOADED_FIELD_AMBIGUOUS");
        Field field = candidates.get(0);
        field.setAccessible(true);
        return field.getBoolean(handle);
    }

    private static Map<?, ?> livePluginManagerMap(PluginManager pluginManager) throws ReflectiveOperationException {
        if (pluginManager == null) throw new IllegalStateException("PLUGIN_MANAGER_MISSING");
        List<Field> candidates = new ArrayList<>();
        for (Field field : pluginManager.getClass().getDeclaredFields()) {
            if (field.getType() == java.util.HashMap.class) candidates.add(field);
        }
        if (candidates.size() != 1) throw new IllegalStateException("PLUGIN_MAP_AMBIGUOUS");
        Field field = candidates.get(0);
        field.setAccessible(true);
        Object value = field.get(pluginManager);
        if (!(value instanceof Map<?, ?>)) throw new IllegalStateException("PLUGIN_MAP_INVALID");
        return (Map<?, ?>) value;
    }

    private static WebView readUniqueWryWebViewField(Activity activity) {
        AtomicReference<WebView> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(readUniqueWryWebViewFieldOnMain(activity)));
        return result.get();
    }

    private static WebView readUniqueWryWebViewFieldOnMain(Activity activity) {
        Class<?> wry = null;
        for (Class<?> cursor = activity.getClass().getSuperclass(); cursor != null; cursor = cursor.getSuperclass()) {
            if ("WryActivity".equals(cursor.getSimpleName())) {
                if (wry != null) throw new IllegalStateException("WRY_ACTIVITY_AMBIGUOUS");
                wry = cursor;
            }
        }
        if (wry == null) throw new IllegalStateException("WRY_ACTIVITY_NOT_FOUND");
        List<Field> candidates = webViewFields(wry);
        if (candidates.size() != 1) throw new IllegalStateException("WRY_WEBVIEW_FIELD_AMBIGUOUS");
        return readWebViewField(candidates.get(0), activity);
    }

    private static WebView readUniqueHelperAcceptedWebView(Activity activity) {
        AtomicReference<WebView> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> result.set(readUniqueHelperAcceptedWebViewOnMain(activity)));
        return result.get();
    }

    private static WebView readUniqueHelperAcceptedWebViewOnMain(Activity activity) {
        try {
            Class<?> helper = Class.forName(HELPER_CLASS, false, activity.getClassLoader());
            Field instanceField = helper.getDeclaredField("INSTANCE");
            instanceField.setAccessible(true);
            Object instance = instanceField.get(null);
            List<Field> candidates = webViewFields(helper);
            if (candidates.size() != 1) throw new IllegalStateException("HELPER_ACCEPTED_FIELD_AMBIGUOUS");
            return readWebViewField(candidates.get(0), instance);
        } catch (ClassNotFoundException | NoSuchFieldException | IllegalAccessException error) {
            throw new IllegalStateException("HELPER_ACCEPTED_FIELD_NOT_FOUND");
        }
    }

    private static boolean mainActivityReferencesNewView(Activity activity, WebView newView, WebView oldView) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                result.set(mainActivityReferencesNewViewOnMain(activity, newView, oldView)));
        return result.get();
    }

    private static boolean mainActivityReferencesNewViewOnMain(Activity activity, WebView newView, WebView oldView) {
        List<Field> fields = webViewFields(activity.getClass());
        if (fields.isEmpty()) return false;
        boolean pointsToNew = false;
        for (Field field : fields) {
            WebView value = readWebViewField(field, activity);
            if (value == oldView) return false;
            if (value == newView) pointsToNew = true;
        }
        return pointsToNew;
    }

    private static List<Field> webViewFields(Class<?> type) {
        List<Field> result = new ArrayList<>();
        for (Field field : type.getDeclaredFields()) {
            if (WebView.class.isAssignableFrom(field.getType())) result.add(field);
        }
        return result;
    }

    private static WebView readWebViewField(Field field, Object owner) {
        try {
            field.setAccessible(true);
            Object value = field.get(owner);
            return value == null ? null : (WebView) value;
        } catch (IllegalAccessException | RuntimeException error) {
            throw new IllegalStateException("WEBVIEW_FIELD_INACCESSIBLE");
        }
    }

    private static boolean viewDetachedOnMain(View view) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                result.set(view.getParent() == null && !view.isAttachedToWindow()));
        return result.get();
    }

    private static boolean viewAttachedOnMain(View view) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                result.set(view.getParent() != null && view.isAttachedToWindow()));
        return result.get();
    }

    private static UiSnapshot inspectOnMain(Activity activity) {
        AtomicReference<UiSnapshot> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            View decor = activity.getWindow().getDecorView();
            List<WebView> webViews = new ArrayList<>();
            List<Button> retryButtons = new ArrayList<>();
            collect(decor, webViews, retryButtons);
            boolean retryReady = retryButtons.size() == 1 && retryButtons.get(0).isShown() &&
                    retryButtons.get(0).isEnabled() && retryButtons.get(0).isClickable() &&
                    retryButtons.get(0).isAttachedToWindow();
            result.set(new UiSnapshot(webViews.size(), webViews.size() == 1 ? webViews.get(0) : null,
                    retryButtons.size(), retryReady));
        });
        UiSnapshot snapshot = result.get();
        if (snapshot == null) throw new IllegalStateException("MAIN_THREAD_INSPECTION_MISSING");
        return snapshot;
    }

    private static void collect(View view, List<WebView> webViews, List<Button> retryButtons) {
        if (view instanceof WebView) webViews.add((WebView) view);
        if (view instanceof Button && RETRY_LABEL.contentEquals(((Button) view).getText())) {
            retryButtons.add((Button) view);
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) collect(group.getChildAt(i), webViews, retryButtons);
        }
    }

    private static TapPlan buildTapPlanOnMain(Activity activity) {
        AtomicReference<TapPlan> result = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            View decor = activity.getWindow().getDecorView();
            List<WebView> webViews = new ArrayList<>();
            List<Button> matches = new ArrayList<>();
            collect(decor, webViews, matches);
            Button only = matches.size() == 1 ? matches.get(0) : null;
            if (webViews.size() != 0 || only == null || !only.isShown() || !only.isEnabled() ||
                    !only.isClickable() || !only.isAttachedToWindow()) {
                throw new IllegalStateException("RETRY_TAP_TARGET_NOT_UNIQUE_AND_VERIFIED");
            }
            Button button = only;
            Rect bounds = new Rect();
            if (!button.getGlobalVisibleRect(bounds) || bounds.isEmpty()) throw new IllegalStateException("RETRY_TAP_BOUNDS_INVALID");
            result.set(new TapPlan(button, bounds, SystemClock.elapsedRealtime()));
        });
        TapPlan plan = result.get();
        if (plan == null) throw new IllegalStateException("RETRY_TAP_PLAN_MISSING");
        return plan;
    }

    private static void sendExactlyOneTap(Instrumentation instrumentation, TapPlan tap) {
        long downTime = SystemClock.uptimeMillis();
        float x = tap.bounds.centerX();
        float y = tap.bounds.centerY();
        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        MotionEvent up = MotionEvent.obtain(downTime, downTime + 80L, MotionEvent.ACTION_UP, x, y, 0);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            instrumentation.sendPointerSync(down);
            instrumentation.sendPointerSync(up);
        } finally {
            down.recycle();
            up.recycle();
        }
    }

    private static Activity requireTargetActivity(OwnedDestroyInstrumentationRunner instrumentation) {
        Activity activity = instrumentation.targetActivity();
        require(activity != null, "TARGET_ACTIVITY_NOT_OBSERVED");
        require(OwnedDestroyInstrumentationRunner.TARGET_ACTIVITY.equals(activity.getClass().getName()),
                "TARGET_ACTIVITY_IDENTITY_MISMATCH");
        require(!activity.isFinishing() && !activity.isDestroyed(), "TARGET_ACTIVITY_NOT_LIVE");
        return activity;
    }

    private static FaultOncePlugin requireFaultPlugin(OwnedDestroyInstrumentationRunner instrumentation) {
        FaultOncePlugin fault = instrumentation.faultPlugin();
        require(fault != null && instrumentation.injected(), "FAULT_PLUGIN_NOT_REGISTERED");
        return fault;
    }

    private void await(OwnedDestroyInstrumentationRunner instrumentation, long phaseLimit, Condition condition, String timeoutCode) {
        long deadline = Math.min(startedAt + TOTAL_DEADLINE_MS, SystemClock.elapsedRealtime() + phaseLimit);
        while (SystemClock.elapsedRealtime() < deadline) {
            String refusal = instrumentation.refusalCode();
            if (refusal != null) fail("RUNNER_REFUSED_" + refusal);
            if (condition.ready()) return;
            SystemClock.sleep(POLL_MS);
        }
        fail(timeoutCode);
    }

    private long elapsed() { return SystemClock.elapsedRealtime() - startedAt; }
    private static void require(boolean condition, String code) { if (!condition) fail(code); }
    private static void fail(String code) { throw new AssertionError(code); }

    private void emitEvidence() {
        OwnedDestroyInstrumentationRunner runner = null;
        try {
            runner = (OwnedDestroyInstrumentationRunner) InstrumentationRegistry.getInstrumentation();
        } catch (RuntimeException ignored) { }
        FaultOncePlugin fault = runner == null ? null : runner.faultPlugin();
        Activity activity = runner == null ? null : runner.targetActivity();
        WebView first = fault == null ? null : fault.firstView();
        WebView second = fault == null ? null : fault.secondView();
        evidence.put("schemaVersion", 1);
        evidence.put("scope", "selected_first_plugin_load_failure_then_one_native_retry");
        evidence.put("phase", phase);
        evidence.put("qualification", qualified);
        evidence.put("failureCode", failureCode);
        evidence.put("elapsedMs", Math.max(0L, elapsed()));
        evidence.put("tapCount", tapCount);
        evidence.put("targetPackageMatched", targetPackageMatched);
        evidence.put("targetActivityCreates", runner == null ? 0 : runner.targetActivityCreateCount());
        evidence.put("targetPidMatched", runner != null && runner.targetPid() == android.os.Process.myPid());
        evidence.put("pluginLoadCount", fault == null ? 0 : fault.loadCount());
        evidence.put("firstPluginVerified", fault != null && fault.firstPluginVerified());
        evidence.put("faultInjectedOnce", fault != null && fault.faultInjected());
        evidence.put("oldDetachedBeforeTap", oldDetachedBeforeTap);
        evidence.put("wryClearedBeforeTap", wryClearedBeforeTap);
        evidence.put("helperAcceptedClearedBeforeTap", helperClearedBeforeTap);
        evidence.put("noDecorWebViewBeforeTap", noDecorWebViewBeforeTap);
        evidence.put("uniqueShownEnabledRetryBeforeTap", uniqueRetryButtonBeforeTap);
        evidence.put("oldWebViewDetached", first != null && viewDetachedOnMain(first));
        evidence.put("newWebViewDistinctAttached", first != null && second != null && first != second &&
                viewAttachedOnMain(second));
        evidence.put("sameActivityAfterRetry", sameActivityAfterRetry);
        evidence.put("wryOwnsNewWebView", wryOwnsNewWebView);
        evidence.put("activityReferencesNewWebView", activityReferencesNewWebView);
        evidence.put("soleDecorWebViewAfterRetry", soleDecorWebViewAfterRetry);
        evidence.put("retryUiGoneAfterRetry", retryUiGoneAfterRetry);
        evidence.put("retryUiGone", activity != null && safeSnapshotHasNoRetry(activity));
        evidence.put("pluginHandleLoaded", fault != null && pluginHandleLoaded(fault));
        Bundle status = new Bundle();
        status.putString("owned_destroy_evidence", new JSONObject(evidence).toString());
        InstrumentationRegistry.getInstrumentation().sendStatus(0, status);
    }

    private static boolean safeSnapshotHasNoRetry(Activity activity) {
        try { return inspectOnMain(activity).retryButtonCount == 0; }
        catch (RuntimeException ignored) { return false; }
    }

    private static final class UiSnapshot {
        final int decorWebViewCount;
        final WebView onlyDecorWebView;
        final int retryButtonCount;
        final boolean retryButtonShownAndEnabled;
        UiSnapshot(int webViews, WebView onlyWebView, int retryButtons, boolean retryReady) {
            decorWebViewCount = webViews; onlyDecorWebView = onlyWebView;
            retryButtonCount = retryButtons; retryButtonShownAndEnabled = retryReady;
        }
    }

    private static final class TapPlan {
        final Button button;
        final Rect bounds;
        final long capturedAt;
        TapPlan(Button button, Rect bounds, long capturedAt) {
            this.button = button; this.bounds = bounds; this.capturedAt = capturedAt;
        }
    }

    private interface Condition { boolean ready(); }
}
