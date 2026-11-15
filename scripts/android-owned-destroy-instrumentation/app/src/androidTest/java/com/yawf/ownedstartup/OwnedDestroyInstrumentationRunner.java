package com.yawf.ownedstartup;

import android.app.Activity;
import android.os.Bundle;

import androidx.test.runner.AndroidJUnitRunner;

import app.tauri.plugin.PluginManager;

/** Injects only after the real target Activity completed onCreate, before first resume/draw. */
public final class OwnedDestroyInstrumentationRunner extends AndroidJUnitRunner {
    public static final String TARGET_PACKAGE = "com.tgk30.debridstreamer";
    public static final String TARGET_ACTIVITY = "com.tgk30.debridstreamer.MainActivity";
    public static final String FAULT_PLUGIN_NAME = "";

    private Activity targetActivity;
    private FaultOncePlugin faultPlugin;
    private PluginManager targetPluginManager;
    private int targetActivityCreateCount;
    private int targetPid;
    private String refusalCode;
    private boolean injected;

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
