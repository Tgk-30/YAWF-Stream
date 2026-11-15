package com.yawf.ownedstartup;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;

import app.tauri.plugin.Plugin;
import app.tauri.plugin.PluginHandle;
import app.tauri.plugin.PluginManager;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TestWatcher;
import org.junit.runner.Description;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;


/** One real app launch, one qualifying injected failure, one verified native tap, no retry loop. */
public final class OwnedDestroyRetryTest {
    private static final long TOTAL_DEADLINE_MS = 150_000L;
    private static final long FAILURE_UI_DEADLINE_MS = 60_000L;
    private static final long RETRY_DEADLINE_MS = 90_000L;
    private static final long POLL_MS = 100L;
    private static final long TAP_PLAN_MAX_AGE_MS = 2_000L;
    private static final long TAP_FRAME_MS = 17L;
    private static final long TAP_HOLD_MAX_MS = 200L;
    private static final long RETRY_BUTTON_DETACH_DEADLINE_MS = 2_000L;
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
    private boolean retryDownPressed;
    private boolean retryOriginalButtonDetachedAfterUp;
    private Long retryDownCallElapsedMs;
    private PressedObservationOutcome retryPressedObservationOutcome = PressedObservationOutcome.NOT_ATTEMPTED;
    private TapAdmissionState retryAdmissionState;
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
                OwnedDestroyInstrumentationRunner.currentRunner();
        Context target = instrumentation.getTargetContext();
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
        instrumentation.startActivitySync(launch);
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
        require(before.retryButtonCount == 1 && before.retryButtonShownAndEnabled && before.onlyRetryButton != null,
                "RETRY_BUTTON_NOT_UNIQUE_SHOWN_ENABLED");
        oldDetachedBeforeTap = true;
        wryClearedBeforeTap = true;
        helperClearedBeforeTap = true;
        noDecorWebViewBeforeTap = true;
        uniqueRetryButtonBeforeTap = true;

        phase = "ONE_VERIFIED_NATIVE_TAP";
        TapPlan tap = awaitStableTapPlan(activity, before.onlyRetryButton, fault, oldView);
        require(SystemClock.elapsedRealtime() - tap.capturedAt <= TAP_PLAN_MAX_AGE_MS, "RETRY_TAP_PLAN_EXPIRED");
        require(tapCount == 0, "RETRY_TAP_ALREADY_USED");
        sendExactlyOneTap(instrumentation, tap);

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
        String refusal = OwnedDestroyInstrumentationRunner.currentRunner().refusalCode();
        if (refusal != null) fail("RUNNER_REFUSED_" + refusal);
        FaultOncePlugin fault = OwnedDestroyInstrumentationRunner.currentRunner().faultPlugin();
        Activity activity = OwnedDestroyInstrumentationRunner.currentRunner().targetActivity();
        if (fault == null || activity == null) return false;
        if (fault.loadCount() == 0) return false;
        if (!fault.firstPluginVerified()) fail("FAULT_NOT_FIRST");
        if (!fault.faultInjected()) fail("FAULT_INJECTION_MARKER_MISSING");
        UiSnapshot snapshot = inspectOnMain(activity);
        return snapshot.retryButtonCount == 1 && snapshot.retryButtonShownAndEnabled;
    }

    private boolean successfulRetryReady() {
        OwnedDestroyInstrumentationRunner runner =
                OwnedDestroyInstrumentationRunner.currentRunner();
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
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() -> result.set(pluginHandleLoadedOnMain(fault)));
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
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() -> result.set(readUniqueWryWebViewFieldOnMain(activity)));
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
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() -> result.set(readUniqueHelperAcceptedWebViewOnMain(activity)));
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
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() ->
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
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() ->
                result.set(view.getParent() == null && !view.isAttachedToWindow()));
        return result.get();
    }

    private static boolean viewAttachedOnMain(View view) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() ->
                result.set(view.getParent() != null && view.isAttachedToWindow()));
        return result.get();
    }

    private static UiSnapshot inspectOnMain(Activity activity) {
        AtomicReference<UiSnapshot> result = new AtomicReference<>();
        OwnedDestroyInstrumentationRunner.currentRunner().runOnMainSync(() -> {
            View decor = activity.getWindow().getDecorView();
            List<WebView> webViews = new ArrayList<>();
            List<Button> retryButtons = new ArrayList<>();
            collect(decor, webViews, retryButtons);
            boolean retryReady = retryButtons.size() == 1 && retryButtons.get(0).isShown() &&
                    retryButtons.get(0).isEnabled() && retryButtons.get(0).isClickable() &&
                    retryButtons.get(0).isAttachedToWindow();
            result.set(new UiSnapshot(webViews.size(), webViews.size() == 1 ? webViews.get(0) : null,
                    retryButtons.size(), retryReady, retryButtons.size() == 1 ? retryButtons.get(0) : null));
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

    private TapPlan awaitStableTapPlan(Activity activity, Button originalButton, FaultOncePlugin fault, WebView oldView) {
        long now = SystemClock.elapsedRealtime();
        TapAdmissionState state = new TapAdmissionState(activity, originalButton, now,
                Math.min(startedAt + TOTAL_DEADLINE_MS, now + TapAdmissionState.MAX_ELAPSED_MS));
        retryAdmissionState = state;
        while (!state.refused) {
            TapAdmissionSample sample = readAdmissionSample(activity, originalButton, fault, oldView, state.deadline);
            if (state.observe(SystemClock.elapsedRealtime(), sample) && state.readyAt(SystemClock.elapsedRealtime())) {
                int[] bounds = state.copiedBounds();
                return new TapPlan(activity, originalButton, new Rect(bounds[0], bounds[1], bounds[2], bounds[3]), state.admittedAt);
            }
            if (state.refused) break;
            long remaining = state.deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) {
                state.expire(SystemClock.elapsedRealtime());
                break;
            }
            SystemClock.sleep(Math.min(TapAdmissionState.MIN_INTERVAL_MS, remaining));
        }
        throw new IllegalStateException("RETRY_TAP_ADMISSION_REFUSED");
    }

    private static TapAdmissionSample admissionSample(Object owner, Object button, TapAdmissionReason reason, Rect bounds) {
        return new TapAdmissionSample(owner, button, reason,
                bounds == null ? null : new int[] { bounds.left, bounds.top, bounds.right, bounds.bottom },
                SystemClock.elapsedRealtime());
    }

    private static TapAdmissionSample readAdmissionSample(Activity activity, Button button, FaultOncePlugin fault,
            WebView oldView, long deadline) {
        TapAdmissionSample closed = admissionSample(activity, button, TapAdmissionReason.OBSERVATION_TIMEOUT, null);
        AtomicReference<TapAdmissionSample> result = new AtomicReference<>();
        CountDownLatch observed = new CountDownLatch(1);
        try {
            activity.runOnUiThread(() -> {
                try {
                    if (SystemClock.elapsedRealtime() < deadline) {
                        TapAdmissionSample value = inspectAdmissionOnMain(activity, button, fault, oldView);
                        if (SystemClock.elapsedRealtime() < deadline) result.compareAndSet(null, value);
                    }
                } catch (Throwable ignored) {
                    if (SystemClock.elapsedRealtime() < deadline) {
                        result.compareAndSet(null, admissionSample(activity, button, TapAdmissionReason.OBSERVATION_ERROR, null));
                    }
                } finally {
                    observed.countDown();
                }
            });
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0 || !observed.await(remaining, TimeUnit.MILLISECONDS) ||
                    SystemClock.elapsedRealtime() >= deadline) return closed;
            TapAdmissionSample value = result.getAndSet(closed);
            return value == null ? closed : value;
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException | LinkageError ignored) {
            // Return only a fixed diagnostic reason, never exception text.
        } finally {
            result.set(closed);
        }
        return admissionSample(activity, button, TapAdmissionReason.OBSERVATION_ERROR, null);
    }

    private static TapAdmissionSample inspectAdmissionOnMain(Activity activity, Button button, FaultOncePlugin fault, WebView oldView) {
        OwnedDestroyInstrumentationRunner runner = OwnedDestroyInstrumentationRunner.currentRunner();
        Activity owner = runner.targetActivity();
        if (owner != activity || runner.targetActivityCreateCount() != 1 || runner.targetPid() != android.os.Process.myPid() ||
                !OwnedDestroyInstrumentationRunner.TARGET_PACKAGE.equals(activity.getPackageName()) ||
                !OwnedDestroyInstrumentationRunner.TARGET_ACTIVITY.equals(activity.getClass().getName())) {
            return admissionSample(owner, button, TapAdmissionReason.OWNER, null);
        }
        if (activity.isFinishing() || activity.isDestroyed()) return admissionSample(owner, button, TapAdmissionReason.LIVENESS, null);
        if (runner.refusalCode() != null || runner.faultPlugin() != fault || fault.firstView() != oldView ||
                fault.loadCount() != 1 || !fault.firstPluginVerified() || !fault.faultInjected()) {
            return admissionSample(owner, button, TapAdmissionReason.FAULT, null);
        }
        View decor = activity.getWindow().getDecorView();
        List<WebView> webViews = new ArrayList<>();
        List<Button> matches = new ArrayList<>();
        collect(decor, webViews, matches);
        if (matches.size() > 1 || (matches.size() == 1 && matches.get(0) != button) ||
                (matches.isEmpty() && button.isAttachedToWindow())) {
            return admissionSample(owner, matches.size() == 1 ? matches.get(0) : null, TapAdmissionReason.IDENTITY, null);
        }
        if (oldView.getParent() != null || oldView.isAttachedToWindow() || webViews.size() != 0 ||
                readUniqueWryWebViewFieldOnMain(activity) != null || readUniqueHelperAcceptedWebViewOnMain(activity) != null) {
            return admissionSample(owner, button, TapAdmissionReason.CLEANUP, null);
        }
        if (!activity.hasWindowFocus() || !decor.hasWindowFocus()) {
            PowerManager power = (PowerManager) activity.getSystemService(Context.POWER_SERVICE);
            KeyguardManager keyguard = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
            if (power == null || keyguard == null) return admissionSample(owner, button, TapAdmissionReason.OBSERVATION_ERROR, null);
            if (!power.isInteractive()) return admissionSample(owner, button, TapAdmissionReason.SCREEN_ASLEEP, null);
            if (keyguard.isKeyguardLocked()) return admissionSample(owner, button, TapAdmissionReason.KEYGUARD_LOCKED, null);
            return admissionSample(owner, button, TapAdmissionReason.FOCUS, null);
        }
        if (!decor.isAttachedToWindow() || !button.isAttachedToWindow()) return admissionSample(owner, button, TapAdmissionReason.ATTACHMENT, null);
        if (!button.isShown() || !button.isEnabled() || !button.isClickable()) return admissionSample(owner, button, TapAdmissionReason.INTERACTION, null);
        if (!button.hasOnClickListeners()) return admissionSample(owner, button, TapAdmissionReason.LISTENER, null);
        if (button.getWidth() <= 0 || button.getHeight() <= 0) return admissionSample(owner, button, TapAdmissionReason.DIMENSIONS, null);
        if (button.getRootView() != decor.getRootView()) return admissionSample(owner, button, TapAdmissionReason.ROOT, null);
        Rect bounds = verifiedRetryScreenBoundsOnMain(activity, button);
        if (bounds != null) return admissionSample(owner, button, TapAdmissionReason.NONE, bounds);
        Rect visible = new Rect();
        if (!button.getGlobalVisibleRect(visible) || visible.isEmpty()) return admissionSample(owner, button, TapAdmissionReason.VISIBLE_BOUNDS, null);
        int[] rootOffset = new int[2];
        button.getRootView().getLocationOnScreen(rootOffset);
        visible.offset(rootOffset[0], rootOffset[1]);
        int[] location = new int[2];
        button.getLocationOnScreen(location);
        if (!visible.intersect(new Rect(location[0], location[1], location[0] + button.getWidth(), location[1] + button.getHeight()))) {
            return admissionSample(owner, button, TapAdmissionReason.INTERSECTION, null);
        }
        return admissionSample(owner, button, TapAdmissionReason.OBSERVATION_ERROR, null);
    }

    private static boolean ownedFocusedActivityOnMain(Activity activity) {
        OwnedDestroyInstrumentationRunner runner = OwnedDestroyInstrumentationRunner.currentRunner();
        return runner.targetActivity() == activity && runner.targetActivityCreateCount() == 1 &&
                runner.targetPid() == android.os.Process.myPid() &&
                OwnedDestroyInstrumentationRunner.TARGET_PACKAGE.equals(activity.getPackageName()) &&
                OwnedDestroyInstrumentationRunner.TARGET_ACTIVITY.equals(activity.getClass().getName()) &&
                !activity.isFinishing() && !activity.isDestroyed() && activity.hasWindowFocus();
    }

    private static Rect verifiedRetryScreenBoundsOnMain(Activity activity, Button button) {
        if (!ownedFocusedActivityOnMain(activity)) return null;
        View decor = activity.getWindow().getDecorView();
        List<WebView> webViews = new ArrayList<>();
        List<Button> matches = new ArrayList<>();
        collect(decor, webViews, matches);
        if (webViews.size() != 0 || matches.size() != 1 || matches.get(0) != button ||
                !decor.isAttachedToWindow() || !decor.hasWindowFocus() || !button.isAttachedToWindow() ||
                !button.isShown() || !button.isEnabled() || !button.isClickable() || !button.hasOnClickListeners() ||
                button.getWidth() <= 0 || button.getHeight() <= 0) return null;
        View root = button.getRootView();
        if (root != decor.getRootView()) return null;
        Rect screenBounds = new Rect();
        if (!button.getGlobalVisibleRect(screenBounds) || screenBounds.isEmpty()) return null;
        int[] rootScreenOffset = new int[2];
        root.getLocationOnScreen(rootScreenOffset);
        screenBounds.offset(rootScreenOffset[0], rootScreenOffset[1]);
        int[] buttonScreenLocation = new int[2];
        button.getLocationOnScreen(buttonScreenLocation);
        Rect buttonScreenBounds = new Rect(buttonScreenLocation[0], buttonScreenLocation[1],
                buttonScreenLocation[0] + button.getWidth(), buttonScreenLocation[1] + button.getHeight());
        if (!screenBounds.intersect(buttonScreenBounds) || screenBounds.isEmpty()) return null;
        return screenBounds;
    }

    private void sendExactlyOneTap(Instrumentation instrumentation, TapPlan tap) {
        long holdMillis = ViewConfiguration.getTapTimeout() + TAP_FRAME_MS;
        long longPressMillis = ViewConfiguration.getLongPressTimeout();
        require(holdMillis > 0 && holdMillis + TAP_FRAME_MS <= TAP_HOLD_MAX_MS &&
                holdMillis + TAP_FRAME_MS < longPressMillis,
                "RETRY_TAP_HOLD_CONFIGURATION_UNSAFE");
        long downTime = SystemClock.uptimeMillis();
        float x = tap.screenBounds.exactCenterX();
        float y = tap.screenBounds.exactCenterY();
        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        boolean heldWithinBounds = false;
        long observationDeadline = downTime + Math.min(TAP_HOLD_MAX_MS, longPressMillis - 1L) - TAP_FRAME_MS;
        tapCount = 1;
        try {
            long downCallStartedAt = SystemClock.uptimeMillis();
            try {
                instrumentation.sendPointerSync(down);
            } finally {
                // A capped diagnostic span, never an extension of the gesture budget.
                retryDownCallElapsedMs = Math.min(TOTAL_DEADLINE_MS,
                        Math.max(0L, SystemClock.uptimeMillis() - downCallStartedAt));
            }
            if (SystemClock.uptimeMillis() + holdMillis <= observationDeadline) {
                SystemClock.sleep(holdMillis);
                retryPressedObservationOutcome = retryPressedOnMain(tap, observationDeadline);
                retryDownPressed = retryPressedObservationOutcome == PressedObservationOutcome.PRESSED;
            } else {
                retryPressedObservationOutcome = PressedObservationOutcome.BUDGET_SKIPPED;
            }
        } finally {
            long upTime = SystemClock.uptimeMillis();
            long heldMillis = upTime - downTime;
            heldWithinBounds = heldMillis >= holdMillis && heldMillis <= TAP_HOLD_MAX_MS && heldMillis < longPressMillis;
            MotionEvent up = null;
            try {
                up = MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0);
                up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
                instrumentation.sendPointerSync(up);
            } finally {
                down.recycle();
                if (up != null) up.recycle();
            }
        }
        retryOriginalButtonDetachedAfterUp = awaitOriginalButtonDetachedAfterUp(tap);
        require(heldWithinBounds, "RETRY_TAP_HOLD_OUT_OF_BOUNDS");
        require(retryDownPressed, "RETRY_DOWN_NOT_OBSERVED_PRESSED");
        require(retryOriginalButtonDetachedAfterUp, "RETRY_ORIGINAL_BUTTON_NOT_DETACHED_AFTER_UP");
        require(retryPressedObservationOutcome == PressedObservationOutcome.PRESSED && retryDownCallElapsedMs != null,
                "RETRY_INPUT_DIAGNOSTICS_INCONSISTENT");
    }

    private static boolean observeOnMainWithin(Activity activity, long deadlineUptime, Condition condition) {
        AtomicReference<Boolean> result = new AtomicReference<>(false);
        CountDownLatch observed = new CountDownLatch(1);
        try {
            activity.runOnUiThread(() -> {
                try {
                    if (SystemClock.uptimeMillis() <= deadlineUptime) {
                        boolean value = condition.ready();
                        if (SystemClock.uptimeMillis() <= deadlineUptime) result.set(value);
                    }
                } catch (Throwable ignored) {
                    // A failed or late observation is not positive input proof.
                } finally {
                    observed.countDown();
                }
            });
            long remaining = deadlineUptime - SystemClock.uptimeMillis();
            return remaining > 0 && observed.await(remaining, TimeUnit.MILLISECONDS) &&
                    SystemClock.uptimeMillis() <= deadlineUptime && result.get();
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException | LinkageError ignored) { }
        return false;
    }

    private static PressedObservationOutcome retryPressedOnMain(TapPlan tap, long deadlineUptime) {
        AtomicReference<PressedObservationOutcome> result = new AtomicReference<>();
        CountDownLatch observed = new CountDownLatch(1);
        try {
            tap.activity.runOnUiThread(() -> {
                try {
                    if (SystemClock.uptimeMillis() <= deadlineUptime) {
                        Rect currentBounds = verifiedRetryScreenBoundsOnMain(tap.activity, tap.button);
                        PressedObservationOutcome value = currentBounds == null || !currentBounds.equals(tap.screenBounds)
                                ? PressedObservationOutcome.STATE_MISMATCH
                                : tap.button.isPressed() ? PressedObservationOutcome.PRESSED : PressedObservationOutcome.UNPRESSED;
                        if (SystemClock.uptimeMillis() <= deadlineUptime) result.set(value);
                    }
                } catch (Throwable ignored) {
                    if (SystemClock.uptimeMillis() <= deadlineUptime) result.set(PressedObservationOutcome.OBSERVATION_ERROR);
                } finally {
                    observed.countDown();
                }
            });
            long remaining = deadlineUptime - SystemClock.uptimeMillis();
            if (remaining <= 0 || !observed.await(remaining, TimeUnit.MILLISECONDS) ||
                    SystemClock.uptimeMillis() > deadlineUptime) return PressedObservationOutcome.OBSERVATION_TIMEOUT;
            PressedObservationOutcome value = result.get();
            return value == null ? PressedObservationOutcome.OBSERVATION_TIMEOUT : value;
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException | LinkageError ignored) { }
        return PressedObservationOutcome.OBSERVATION_ERROR;
    }

    private boolean awaitOriginalButtonDetachedAfterUp(TapPlan tap) {
        long deadline = Math.min(startedAt + TOTAL_DEADLINE_MS,
                SystemClock.elapsedRealtime() + RETRY_BUTTON_DETACH_DEADLINE_MS);
        while (SystemClock.elapsedRealtime() < deadline) {
            long observationDeadline = SystemClock.uptimeMillis() + deadline - SystemClock.elapsedRealtime();
            boolean detached = observeOnMainWithin(tap.activity, observationDeadline, () ->
                    ownedFocusedActivityOnMain(tap.activity) && !tap.button.isAttachedToWindow());
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining < 0) return false;
            if (detached) return true;
            if (remaining == 0) return false;
            SystemClock.sleep(Math.min(TAP_FRAME_MS, remaining));
        }
        return false;
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
            runner = OwnedDestroyInstrumentationRunner.currentRunner();
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
        evidence.put("retryDownPressed", retryDownPressed);
        evidence.put("retryOriginalButtonDetachedAfterUp", retryOriginalButtonDetachedAfterUp);
        evidence.put("retryDownCallElapsedMs", retryDownCallElapsedMs == null ? JSONObject.NULL : retryDownCallElapsedMs);
        evidence.put("retryPressedObservationOutcome", retryPressedObservationOutcome.wireValue);
        evidence.put("retryAdmissionAdmitted", retryAdmissionState != null && retryAdmissionState.admitted && !retryAdmissionState.refused);
        evidence.put("retryAdmissionFirstBlockingReason", retryAdmissionState == null ? "not-started" : retryAdmissionState.firstBlocking.wireValue);
        evidence.put("retryAdmissionLastBlockingReason", retryAdmissionState == null ? "not-started" : retryAdmissionState.lastBlocking.wireValue);
        evidence.put("retryAdmissionElapsedMs", retryAdmissionState == null ? 0L : retryAdmissionState.elapsedMs);
        evidence.put("retryAdmissionSampleCount", retryAdmissionState == null ? 0 : retryAdmissionState.sampleCount);
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
        OwnedDestroyInstrumentationRunner.currentRunner().sendStatus(0, status);
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
        final Button onlyRetryButton;
        UiSnapshot(int webViews, WebView onlyWebView, int retryButtons, boolean retryReady, Button onlyRetryButton) {
            decorWebViewCount = webViews; onlyDecorWebView = onlyWebView;
            retryButtonCount = retryButtons; retryButtonShownAndEnabled = retryReady;
            this.onlyRetryButton = onlyRetryButton;
        }
    }

    // BEGIN PURE TAP ADMISSION POLICY
    private enum TapAdmissionReason {
        NOT_STARTED("not-started", true), NONE("none", false), OWNER("owner", true), LIVENESS("liveness", true),
        IDENTITY("identity", true), FAULT("fault", true), CLEANUP("cleanup", true), FOCUS("focus", false),
        SCREEN_ASLEEP("screen-asleep", false), KEYGUARD_LOCKED("keyguard-locked", false),
        ATTACHMENT("attachment", false), INTERACTION("interaction", false), LISTENER("listener", false),
        DIMENSIONS("dimensions", false), ROOT("root", false), VISIBLE_BOUNDS("visible-bounds", false),
        INTERSECTION("intersection", false), UNSTABLE_GEOMETRY("unstable-geometry", false),
        OBSERVATION_TIMEOUT("observation-timeout", true), OBSERVATION_ERROR("observation-error", true),
        DEADLINE("deadline", true), SAMPLE_LIMIT("sample-limit", true), SAMPLE_INTERVAL("sample-interval", true);

        final String wireValue;
        final boolean terminal;
        TapAdmissionReason(String wireValue, boolean terminal) { this.wireValue = wireValue; this.terminal = terminal; }
    }

    private static final class TapAdmissionSample {
        final Object owner;
        final Object button;
        final TapAdmissionReason reason;
        final int[] bounds;
        final long observedAt;
        TapAdmissionSample(Object owner, Object button, TapAdmissionReason reason, int[] bounds, long observedAt) {
            this.owner = owner; this.button = button; this.reason = reason;
            this.bounds = bounds == null ? null : bounds.clone(); this.observedAt = observedAt;
        }
    }

    private static final class TapAdmissionState {
        static final long MAX_ELAPSED_MS = 2_000L;
        static final long MIN_INTERVAL_MS = 17L;
        static final int MAX_SAMPLES = 128;
        final Object owner;
        final Object button;
        final long startedAt;
        final long deadline;
        TapAdmissionReason firstBlocking = TapAdmissionReason.NONE;
        TapAdmissionReason lastBlocking = TapAdmissionReason.NONE;
        long elapsedMs;
        int sampleCount;
        boolean refused;
        boolean admitted;
        long admittedAt;
        private long previousAt;
        private int[] previousBounds;
        private int[] admittedBounds;

        TapAdmissionState(Object owner, Object button, long startedAt, long totalDeadline) {
            this.owner = owner; this.button = button; this.startedAt = startedAt;
            this.deadline = Math.min(totalDeadline, startedAt + MAX_ELAPSED_MS);
            if (owner == null) block(TapAdmissionReason.OWNER);
            else if (button == null) block(TapAdmissionReason.IDENTITY);
            else if (deadline <= startedAt) expire(startedAt);
        }

        private boolean withinDeadline(long now) { return now >= startedAt && now < deadline; }
        private void clock(long now) { elapsedMs = Math.min(MAX_ELAPSED_MS, Math.max(0L, now - startedAt)); }
        private void block(TapAdmissionReason reason) {
            if (firstBlocking == TapAdmissionReason.NONE) firstBlocking = reason;
            lastBlocking = reason;
            previousBounds = null;
            if (reason.terminal) { refused = true; admitted = false; admittedBounds = null; }
        }

        void expire(long now) { clock(now); block(TapAdmissionReason.DEADLINE); }
        boolean readyAt(long now) {
            clock(now);
            if (!withinDeadline(now)) expire(now);
            return admitted && !refused;
        }

        boolean observe(long now, TapAdmissionSample sample) {
            if (refused || admitted) return readyAt(now);
            clock(now);
            if (sampleCount >= MAX_SAMPLES) { block(TapAdmissionReason.SAMPLE_LIMIT); return false; }
            sampleCount++;
            if (sample == null || sample.reason == null) { block(TapAdmissionReason.OBSERVATION_ERROR); return false; }
            if (sample.owner != owner) { block(TapAdmissionReason.OWNER); return false; }
            if (sample.button != button) { block(TapAdmissionReason.IDENTITY); return false; }
            if (sample.reason.terminal) { block(sample.reason); return false; }
            if (!withinDeadline(now) || sample.observedAt >= deadline) { expire(now); return false; }
            if (sample.observedAt < startedAt || sample.observedAt > now) { block(TapAdmissionReason.OBSERVATION_ERROR); return false; }
            if (sample.reason != TapAdmissionReason.NONE) { block(sample.reason); return false; }
            if (sample.bounds == null || sample.bounds.length != 4 || sample.bounds[0] >= sample.bounds[2] || sample.bounds[1] >= sample.bounds[3]) {
                block(TapAdmissionReason.VISIBLE_BOUNDS); return false;
            }
            if (previousBounds != null && sample.observedAt - previousAt < MIN_INTERVAL_MS) {
                block(TapAdmissionReason.SAMPLE_INTERVAL); return false;
            }
            if (previousBounds != null && java.util.Arrays.equals(previousBounds, sample.bounds)) {
                admittedBounds = sample.bounds.clone(); admittedAt = sample.observedAt; admitted = true;
                return true;
            }
            if (previousBounds != null) block(TapAdmissionReason.UNSTABLE_GEOMETRY);
            previousBounds = sample.bounds.clone(); previousAt = sample.observedAt;
            return false;
        }

        int[] copiedBounds() { return admittedBounds == null ? null : admittedBounds.clone(); }
    }
    // END PURE TAP ADMISSION POLICY

    private enum PressedObservationOutcome {
        NOT_ATTEMPTED("not-attempted"),
        BUDGET_SKIPPED("budget-skipped"),
        OBSERVATION_TIMEOUT("observation-timeout"),
        STATE_MISMATCH("state-mismatch"),
        UNPRESSED("unpressed"),
        PRESSED("pressed"),
        OBSERVATION_ERROR("observation-error");

        final String wireValue;
        PressedObservationOutcome(String wireValue) { this.wireValue = wireValue; }
    }

    private static final class TapPlan {
        final Activity activity;
        final Button button;
        final Rect screenBounds;
        final long capturedAt;
        TapPlan(Activity activity, Button button, Rect screenBounds, long capturedAt) {
            this.activity = activity; this.button = button;
            this.screenBounds = new Rect(screenBounds); this.capturedAt = capturedAt;
        }
    }

    private interface Condition { boolean ready(); }
}
