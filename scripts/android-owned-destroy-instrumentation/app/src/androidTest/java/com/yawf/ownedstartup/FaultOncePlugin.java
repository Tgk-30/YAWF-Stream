package com.yawf.ownedstartup;

import android.app.Activity;
import android.webkit.WebView;

import app.tauri.plugin.Plugin;
import app.tauri.plugin.PluginHandle;
import app.tauri.plugin.PluginManager;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Test-APK-only, one-shot failure at the production plugin load callback. */
final class FaultOncePlugin extends Plugin {
    static final String FAULT_MARKER = "INJECTED_PLUGIN_LOAD_FAILURE_ONCE";

    private final OwnedDestroyInstrumentationRunner runner;
    private final PluginManager pluginManager;
    private final AtomicInteger loadCount = new AtomicInteger();
    private volatile WebView firstView;
    private volatile WebView secondView;
    private volatile boolean firstPluginVerified;
    private volatile boolean faultInjected;

    FaultOncePlugin(Activity activity, OwnedDestroyInstrumentationRunner runner, PluginManager pluginManager) {
        super(activity);
        this.runner = runner;
        this.pluginManager = pluginManager;
    }

    @Override
    public void load(WebView webView) {
        int ordinal = loadCount.incrementAndGet();
        if (ordinal == 1) {
            if (!isFirstPluginInLiveManagerMap()) {
                runner.refuse("FAULT_NOT_FIRST");
                throw new IllegalStateException("FAULT_NOT_FIRST");
            }
            firstPluginVerified = true;
            firstView = webView;
            faultInjected = true;
            runner.recordTargetFaultLoad();
            throw new IllegalStateException(FAULT_MARKER);
        }
        if (ordinal == 2) {
            secondView = webView;
            if (webView == null || webView == firstView) {
                runner.refuse("RETRY_DID_NOT_CREATE_DISTINCT_WEBVIEW");
                throw new IllegalStateException("RETRY_DID_NOT_CREATE_DISTINCT_WEBVIEW");
            }
            return;
        }
        runner.refuse("PLUGIN_LOAD_COUNT_EXCEEDED");
        throw new IllegalStateException("PLUGIN_LOAD_COUNT_EXCEEDED");
    }

    int loadCount() { return loadCount.get(); }
    WebView firstView() { return firstView; }
    WebView secondView() { return secondView; }
    boolean firstPluginVerified() { return firstPluginVerified; }
    boolean faultInjected() { return faultInjected; }
    PluginManager pluginManager() { return pluginManager; }

    boolean registrationKeyAvailable() {
        try {
            Map<?, ?> plugins = livePluginManagerMap(pluginManager);
            return plugins != null && !plugins.containsKey(OwnedDestroyInstrumentationRunner.FAULT_PLUGIN_NAME);
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return false;
        }
    }

    private boolean isFirstPluginInLiveManagerMap() {
        try {
            Map<?, ?> plugins = livePluginManagerMap(pluginManager);
            if (plugins == null) return false;
            Object first = plugins.entrySet().stream().findFirst().orElse(null);
            if (!(first instanceof Map.Entry<?, ?>)) return false;
            Map.Entry<?, ?> entry = (Map.Entry<?, ?>) first;
            Object handle = entry.getValue();
            return OwnedDestroyInstrumentationRunner.FAULT_PLUGIN_NAME.equals(entry.getKey()) &&
                    handle instanceof PluginHandle && uniquePluginInstance((PluginHandle) handle) == this;
        } catch (ReflectiveOperationException | RuntimeException ignored) {
            return false;
        }
    }

    private static Plugin uniquePluginInstance(PluginHandle handle) throws ReflectiveOperationException {
        List<Field> candidates = new ArrayList<>();
        for (Field field : handle.getClass().getDeclaredFields()) {
            if (Plugin.class.isAssignableFrom(field.getType())) candidates.add(field);
        }
        if (candidates.size() != 1) return null;
        Field field = candidates.get(0);
        field.setAccessible(true);
        Object value = field.get(handle);
        return value instanceof Plugin ? (Plugin) value : null;
    }

    private static Map<?, ?> livePluginManagerMap(PluginManager pluginManager) throws ReflectiveOperationException {
        if (pluginManager == null) return null;
        List<Field> candidates = new ArrayList<>();
        for (Field field : pluginManager.getClass().getDeclaredFields()) {
            if (field.getType() == HashMap.class) candidates.add(field);
        }
        if (candidates.size() != 1) return null;
        Field field = candidates.get(0);
        field.setAccessible(true);
        Object value = field.get(pluginManager);
        return value instanceof Map<?, ?> ? (Map<?, ?>) value : null;
    }
}
