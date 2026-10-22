import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const javaDirectory = join(
  scripts,
  "android-runtime-instrumentation/app/src/androidTest/java/com/yawf/runtimeinstrumentation",
);
const helperPath = join(javaDirectory, "RuntimeTvNativeObservation.java");
const keyHelperPath = join(javaDirectory, "RuntimeTvNativeKey.java");
const surfaceHelperPath = join(javaDirectory, "RuntimeTvNativeSurface.java");
const flowPath = join(javaDirectory, "RuntimeTvFlowTest.java");
const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/javac") : "javac";
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java") : "java";
const read = path => readFileSync(path, "utf8");

function method(source, name) {
  const signature = new RegExp(
    `^\\s*(?:private\\s+(?:static\\s+)?|static\\s+)(?:<[^>]+>\\s+)?[A-Za-z][A-Za-z0-9_.<>?\\[\\]]*\\s+${name}\\s*\\(`,
    "m",
  );
  const match = signature.exec(source);
  assert.ok(match, `missing Java method ${name}`);
  const lineStart = match.index;
  const open = source.indexOf("{", match.index + match[0].length);
  assert.ok(open > match.index, `missing Java method body ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(lineStart, index + 1);
  }
  assert.fail(`unclosed Java method ${name}`);
}

function runJavaSources(sources, mainClass) {
  const directory = mkdtempSync(join(tmpdir(), "yawf-tv-native-observation-"));
  const packageDirectory = join(directory, "com/yawf/runtimeinstrumentation");
  mkdirSync(packageDirectory, { recursive: true });
  const paths = [];
  for (const [name, source] of Object.entries(sources)) {
    const path = name.includes("/") ? join(directory, name) : join(packageDirectory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    paths.push(path);
  }
  const compile = spawnSync(javac, ["-d", directory, ...paths], { encoding: "utf8" });
  if (compile.status !== 0) return { compile, run: null };
  const run = spawnSync(java, ["-cp", directory, mainClass], { encoding: "utf8" });
  return { compile, run };
}

const helperProbeSource = `
package com.yawf.runtimeinstrumentation;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

public final class RuntimeTvNativeObservationProbe {
    private static final class Snapshot {
        final int value;
        Snapshot(int value) { this.value = value; }
    }

    private static final class Rig {
        long timeout;
        boolean clearResult = true;
        int gets;
        int sets;
        int clears;
        int queries;
        final List<String> events = new ArrayList<>();

        Rig(long timeout) { this.timeout = timeout; }

        long getTimeout() {
            gets++;
            events.add("get:" + timeout);
            return timeout;
        }

        void setTimeout(long value) {
            sets++;
            timeout = value;
            events.add("set:" + value);
        }

        boolean clearCache() {
            clears++;
            check(timeout == 0L, "cache clear did not see zero idle timeout");
            events.add("cache:" + timeout);
            return clearResult;
        }

        Snapshot snapshot(int value) {
            queries++;
            check(timeout == 0L, "query did not see zero idle timeout");
            events.add("query:" + timeout);
            return new Snapshot(value);
        }
    }

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }

    private static void expectAssertion(Runnable action, String label) {
        try {
            action.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError("Expected AssertionError: " + label);
    }

    private static void expectRuntime(Runnable action, String label) {
        try {
            action.run();
        } catch (RuntimeException expected) {
            return;
        }
        throw new AssertionError("Expected RuntimeException: " + label);
    }

    private static void successAndImmutableSnapshot() throws Exception {
        Rig rig = new Rig(7_311L);
        int[] liveValue = { 7 };
        Snapshot snapshot = RuntimeTvNativeObservation.readFresh(
                36, rig::getTimeout, rig::setTimeout, rig::clearCache,
                () -> rig.snapshot(liveValue[0]));
        check(snapshot.value == 7, "success snapshot value");
        check(rig.timeout == 7_311L, "success did not restore exact nondefault timeout");
        check(rig.gets == 1 && rig.sets == 2 && rig.clears == 1 && rig.queries == 1,
                "success call counts");
        check(rig.events.equals(List.of(
                "get:7311", "set:0", "cache:0", "query:0", "set:7311")),
                "success event order " + rig.events);
        rig.events.add("key:" + rig.timeout);
        check(rig.events.get(rig.events.size() - 1).equals("key:7311"),
                "key happened before exact restore");
        liveValue[0] = 99;
        check(snapshot.value == 7, "snapshot retained live state after restore");
        for (Field field : Snapshot.class.getDeclaredFields()) {
            check(Modifier.isFinal(field.getModifiers()), "snapshot field was mutable: " + field);
        }
    }

    private static void restoresAssertionError() {
        Rig rig = new Rig(8_123L);
        expectAssertion(() -> RuntimeTvNativeObservation.readFresh(
                36, rig::getTimeout, rig::setTimeout, rig::clearCache,
                () -> { rig.snapshot(1); throw new AssertionError("query assertion"); }),
                "query assertion");
        check(rig.timeout == 8_123L, "AssertionError did not restore exact timeout");
        check(rig.clears == 1 && rig.queries == 1, "AssertionError read path counts");
    }

    private static void restoresRuntimeException() {
        Rig rig = new Rig(9_417L);
        expectRuntime(() -> RuntimeTvNativeObservation.readFresh(
                36, rig::getTimeout, rig::setTimeout, rig::clearCache,
                () -> { rig.snapshot(1); throw new IllegalStateException("query runtime"); }),
                "query runtime");
        check(rig.timeout == 9_417L, "RuntimeException did not restore exact timeout");
        check(rig.clears == 1 && rig.queries == 1, "RuntimeException read path counts");
    }

    private static void restoresCacheFailureWithoutQuery() {
        Rig rig = new Rig(6_205L);
        rig.clearResult = false;
        expectAssertion(() -> RuntimeTvNativeObservation.readFresh(
                36, rig::getTimeout, rig::setTimeout, rig::clearCache,
                () -> rig.snapshot(1)), "cache clear false");
        check(rig.timeout == 6_205L, "cache false did not restore exact timeout");
        check(rig.clears == 1 && rig.queries == 0, "cache false reached query");
    }

    private static void rejectsOldApiWithoutAnyQuery() {
        Rig rig = new Rig(5_555L);
        expectAssertion(() -> RuntimeTvNativeObservation.readFresh(
                33, rig::getTimeout, rig::setTimeout, rig::clearCache,
                () -> rig.snapshot(1)), "API floor");
        check(rig.timeout == 5_555L, "API failure changed timeout");
        check(rig.gets == 0 && rig.sets == 0 && rig.clears == 0 && rig.queries == 0,
                "API failure performed observation work");
    }

    public static void main(String[] arguments) throws Exception {
        successAndImmutableSnapshot();
        restoresAssertionError();
        restoresRuntimeException();
        restoresCacheFailureWithoutQuery();
        rejectsOldApiWithoutAnyQuery();
    }
}
`;

function runHelperProbe(helperSource = read(helperPath)) {
  return runJavaSources({
    "RuntimeTvNativeObservation.java": helperSource,
    "RuntimeTvNativeObservationProbe.java": helperProbeSource,
  }, "com.yawf.runtimeinstrumentation.RuntimeTvNativeObservationProbe");
}

function assertProbePasses(result) {
  assert.equal(result.compile.status, 0, result.compile.stdout + result.compile.stderr);
  assert.ok(result.run, "probe did not run");
  assert.equal(result.run.status, 0, result.run.stdout + result.run.stderr);
}

function assertExecutableMutantKilled(helperSource) {
  const result = runHelperProbe(helperSource);
  assert.equal(result.compile.status, 0,
    `semantic mutant did not compile:\n${result.compile.stdout}${result.compile.stderr}`);
  assert.ok(result.run, "semantic mutant did not run");
  assert.notEqual(result.run.status, 0,
    `semantic mutant survived:\n${result.run.stdout}${result.run.stderr}`);
}

const androidKeyStubSources = {
  "android/view/InputEvent.java": `
package android.view;
public class InputEvent { }
`,
  "android/view/InputDevice.java": `
package android.view;
public final class InputDevice {
    public static final int SOURCE_KEYBOARD = 257;
    public static final int SOURCE_DPAD = 513;
}
`,
  "android/view/KeyCharacterMap.java": `
package android.view;
public final class KeyCharacterMap {
    public static final int VIRTUAL_KEYBOARD = -1;
}
`,
  "android/view/KeyEvent.java": `
package android.view;
public final class KeyEvent extends InputEvent {
    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;
    public static final int KEYCODE_DPAD_UP = 19;
    public static final int KEYCODE_DPAD_DOWN = 20;
    public static final int KEYCODE_DPAD_LEFT = 21;
    public static final int KEYCODE_DPAD_RIGHT = 22;
    public static final int KEYCODE_DPAD_CENTER = 23;

    public final long downTime;
    public final long eventTime;
    public final int action;
    public final int keyCode;
    public final int repeat;
    public final int metaState;
    public final int deviceId;
    public final int scanCode;
    public final int flags;
    public final int source;

    public KeyEvent(long downTime, long eventTime, int action, int keyCode, int repeat,
            int metaState, int deviceId, int scanCode, int flags, int source) {
        this.downTime = downTime;
        this.eventTime = eventTime;
        this.action = action;
        this.keyCode = keyCode;
        this.repeat = repeat;
        this.metaState = metaState;
        this.deviceId = deviceId;
        this.scanCode = scanCode;
        this.flags = flags;
        this.source = source;
    }
}
`,
  "android/os/Build.java": `
package android.os;
public final class Build {
    public static final class VERSION {
        public static int SDK_INT = 36;
    }
}
`,
  "android/os/SystemClock.java": `
package android.os;
public final class SystemClock {
    public static long now;
    public static int reads;
    public static long uptimeMillis() { reads++; return now; }
    public static void advance(long duration) { now += duration; }
    public static void reset(long value) { now = value; reads = 0; }
}
`,
  "android/app/UiAutomation.java": `
package android.app;
import android.view.InputEvent;
public class UiAutomation {
    public interface Injector { boolean inject(InputEvent event, boolean sync); }
    private final Injector injector;
    public UiAutomation(Injector injector) { this.injector = injector; }
    public boolean injectInputEvent(InputEvent event, boolean sync) {
        return injector.inject(event, sync);
    }
}
`,
  "android/app/Instrumentation.java": `
package android.app;
public class Instrumentation {
    private final UiAutomation automation;
    public Instrumentation(UiAutomation automation) { this.automation = automation; }
    public UiAutomation getUiAutomation() { return automation; }
}
`,
  "androidx/test/uiautomator/Configurator.java": `
package androidx.test.uiautomator;
public final class Configurator {
    private static final Configurator INSTANCE = new Configurator();
    private long timeout;
    public static Configurator getInstance() { return INSTANCE; }
    public long getWaitForIdleTimeout() { return timeout; }
    public Configurator setWaitForIdleTimeout(long value) { timeout = value; return this; }
}
`,
  "androidx/test/uiautomator/UiDevice.java": `
package androidx.test.uiautomator;
import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
public final class UiDevice {
    private final UiAutomation automation;
    public UiDevice(UiAutomation automation) { this.automation = automation; }
    public boolean pressKeyCode(int keyCode) {
        SystemClock.advance(Configurator.getInstance().getWaitForIdleTimeout());
        long eventTime = SystemClock.uptimeMillis();
        KeyEvent down = new KeyEvent(eventTime, eventTime, KeyEvent.ACTION_DOWN, keyCode,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        if (!automation.injectInputEvent(down, true)) return false;
        KeyEvent up = new KeyEvent(eventTime, eventTime, KeyEvent.ACTION_UP, keyCode,
                0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        return automation.injectInputEvent(up, true);
    }
}
`,
};

const nativeKeyProbeSource = `
package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.Build;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;

import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.UiDevice;

import java.util.ArrayList;
import java.util.List;

public final class RuntimeTvNativeKeyProbe {
    private static final long RESTORED_IDLE_TIMEOUT = 6_085L;
    private static final long CONTROLS_AUTO_HIDE = 5_000L;

    private static final class Snapshot {
        final boolean controlsVisible;
        Snapshot(boolean controlsVisible) { this.controlsVisible = controlsVisible; }
    }

    private static final class Rig {
        final List<KeyEvent> events = new ArrayList<>();
        final List<Boolean> syncValues = new ArrayList<>();
        final UiAutomation automation = new UiAutomation(this::inject);
        int clearCalls;
        int queryCalls;
        int failAt = -1;
        int throwAt = -1;

        boolean inject(InputEvent input, boolean sync) {
            KeyEvent event = (KeyEvent) input;
            events.add(event);
            syncValues.add(sync);
            int call = events.size();
            if (call == throwAt) throw new IllegalStateException("injection failure");
            if (call == failAt) return false;
            return event.eventTime <= CONTROLS_AUTO_HIDE;
        }

        Snapshot observeFreshControls() {
            return RuntimeTvNativeObservation.readFresh(
                    36,
                    () -> Configurator.getInstance().getWaitForIdleTimeout(),
                    value -> Configurator.getInstance().setWaitForIdleTimeout(value),
                    () -> {
                        clearCalls++;
                        check(Configurator.getInstance().getWaitForIdleTimeout() == 0L,
                                "cache clear did not see zero timeout");
                        return true;
                    },
                    () -> {
                        queryCalls++;
                        check(Configurator.getInstance().getWaitForIdleTimeout() == 0L,
                                "snapshot did not see zero timeout");
                        return new Snapshot(SystemClock.now <= CONTROLS_AUTO_HIDE);
                    });
        }

        void resetEvents() {
            events.clear();
            syncValues.clear();
            failAt = -1;
            throwAt = -1;
        }
    }

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }

    private static void expectAssertion(Runnable action, String label) {
        try {
            action.run();
        } catch (AssertionError expected) {
            return;
        }
        throw new AssertionError("Expected AssertionError: " + label);
    }

    private static void expectRuntime(Runnable action, String label) {
        try {
            action.run();
        } catch (RuntimeException expected) {
            return;
        }
        throw new AssertionError("Expected RuntimeException: " + label);
    }

    private static void checkOrdinaryDpadPair(
            Rig rig, int keyCode, long eventTime, String label) {
        check(rig.events.size() == 2, label + " event count " + rig.events.size());
        KeyEvent down = rig.events.get(0);
        KeyEvent up = rig.events.get(1);
        check(down.action == KeyEvent.ACTION_DOWN, label + " missing DOWN");
        check(up.action == KeyEvent.ACTION_UP, label + " missing UP");
        for (KeyEvent event : rig.events) {
            check(event.keyCode == keyCode, label + " key code");
            check(event.downTime == eventTime && event.eventTime == eventTime,
                    label + " event time");
            check(event.repeat == 0, label + " repeat");
            check(event.metaState == 0, label + " meta state");
            check(event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD, label + " device id");
            check(event.scanCode == 0, label + " scan code");
            check(event.flags == 0, label + " flags");
            check(event.source == InputDevice.SOURCE_KEYBOARD, label + " source");
        }
        check(rig.syncValues.equals(List.of(true, true)), label + " synchronous injection");
    }

    private static void exactAllowedDpadEvents() {
        int[] allowed = {
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_DPAD_CENTER
        };
        Rig rig = new Rig();
        Configurator.getInstance().setWaitForIdleTimeout(RESTORED_IDLE_TIMEOUT);
        for (int keyCode : allowed) {
            rig.resetEvents();
            long eventTime = 1_000L + keyCode;
            SystemClock.reset(eventTime);
            RuntimeTvNativeKey.send(rig.automation, keyCode);
            checkOrdinaryDpadPair(rig, keyCode, eventTime, "allowed " + keyCode);
            check(Configurator.getInstance().getWaitForIdleTimeout() == RESTORED_IDLE_TIMEOUT,
                    "native adapter changed Configurator timeout");
            check(SystemClock.now == eventTime, "native adapter advanced time");
            check(SystemClock.reads == 1, "native adapter did not use one event timestamp");
        }
    }

    private static void freshSnapshotThenNativeKeyBeatsAutoHide() {
        Rig rig = new Rig();
        Configurator.getInstance().setWaitForIdleTimeout(RESTORED_IDLE_TIMEOUT);
        SystemClock.reset(0L);
        Snapshot snapshot = rig.observeFreshControls();
        check(snapshot.controlsVisible, "fresh controls snapshot was not visible");
        check(rig.clearCalls == 1 && rig.queryCalls == 1, "fresh observation counts");
        check(Configurator.getInstance().getWaitForIdleTimeout() == RESTORED_IDLE_TIMEOUT,
                "idle timeout was not restored before native key");
        RuntimeTvNativeKey.send(rig.automation, KeyEvent.KEYCODE_DPAD_DOWN);
        checkOrdinaryDpadPair(rig, KeyEvent.KEYCODE_DPAD_DOWN, 0L, "fresh native key");
        check(Configurator.getInstance().getWaitForIdleTimeout() == RESTORED_IDLE_TIMEOUT,
                "native adapter changed restored timeout");
    }

    private static void delayedUiDeviceNegativeControl() {
        Rig rig = new Rig();
        Configurator.getInstance().setWaitForIdleTimeout(RESTORED_IDLE_TIMEOUT);
        SystemClock.reset(0L);
        Snapshot snapshot = rig.observeFreshControls();
        check(snapshot.controlsVisible, "negative control lacked fresh visible snapshot");
        check(Configurator.getInstance().getWaitForIdleTimeout() == RESTORED_IDLE_TIMEOUT,
                "negative control timeout was not restored");
        boolean delivered = new UiDevice(rig.automation)
                .pressKeyCode(KeyEvent.KEYCODE_DPAD_DOWN);
        check(!delivered, "delayed UiDevice negative control unexpectedly delivered");
        check(SystemClock.now == RESTORED_IDLE_TIMEOUT,
                "negative control did not model the installed idle delay");
        check(rig.events.size() == 1
                        && rig.events.get(0).action == KeyEvent.ACTION_DOWN
                        && rig.events.get(0).eventTime > CONTROLS_AUTO_HIDE,
                "negative control did not miss auto-hide before its first event");
    }

    private static void rejectsUnsupportedApiAndArbitraryKeysWithoutInjection() {
        Rig rig = new Rig();
        SystemClock.reset(250L);
        Build.VERSION.SDK_INT = 17;
        expectAssertion(() -> RuntimeTvNativeKey.send(
                rig.automation, KeyEvent.KEYCODE_DPAD_DOWN), "unsupported API");
        check(rig.events.isEmpty() && SystemClock.reads == 0,
                "unsupported API performed key work");
        Build.VERSION.SDK_INT = 36;
        for (int forbidden : new int[] { 4, 24, 82 }) {
            expectAssertion(() -> RuntimeTvNativeKey.send(rig.automation, forbidden),
                    "forbidden key " + forbidden);
        }
        check(rig.events.isEmpty() && SystemClock.reads == 0,
                "forbidden key performed key work");
    }

    private static void injectionFailuresFailClosed() {
        Rig rig = new Rig();
        SystemClock.reset(100L);
        rig.failAt = 1;
        expectAssertion(() -> RuntimeTvNativeKey.send(
                rig.automation, KeyEvent.KEYCODE_DPAD_CENTER), "false DOWN injection");
        check(rig.events.size() == 1 && rig.events.get(0).action == KeyEvent.ACTION_DOWN,
                "false DOWN injection continued");

        rig.resetEvents();
        rig.failAt = 2;
        expectAssertion(() -> RuntimeTvNativeKey.send(
                rig.automation, KeyEvent.KEYCODE_DPAD_CENTER), "false UP injection");
        check(rig.events.size() == 2 && rig.events.get(1).action == KeyEvent.ACTION_UP,
                "false UP injection path");

        rig.resetEvents();
        rig.throwAt = 1;
        expectRuntime(() -> RuntimeTvNativeKey.send(
                rig.automation, KeyEvent.KEYCODE_DPAD_CENTER), "throwing injection API");
        check(rig.events.size() == 1, "throwing injection API continued");
    }

    public static void main(String[] arguments) {
        Build.VERSION.SDK_INT = 36;
        exactAllowedDpadEvents();
        freshSnapshotThenNativeKeyBeatsAutoHide();
        delayedUiDeviceNegativeControl();
        rejectsUnsupportedApiAndArbitraryKeysWithoutInjection();
        injectionFailuresFailClosed();
    }
}
`;

function runNativeKeyProbe(keySource = read(keyHelperPath)) {
  return runJavaSources({
    ...androidKeyStubSources,
    "RuntimeTvNativeObservation.java": read(helperPath),
    "RuntimeTvNativeKey.java": keySource,
    "RuntimeTvNativeKeyProbe.java": nativeKeyProbeSource,
  }, "com.yawf.runtimeinstrumentation.RuntimeTvNativeKeyProbe");
}

function assertNativeKeyMutantKilled(keySource) {
  const result = runNativeKeyProbe(keySource);
  assert.equal(result.compile.status, 0,
    `native key mutant did not compile:\n${result.compile.stdout}${result.compile.stderr}`);
  assert.ok(result.run, "native key mutant did not run");
  assert.notEqual(result.run.status, 0,
    `native key mutant survived:\n${result.run.stdout}${result.run.stderr}`);
}

function runNativeKeyCallsiteProbe(flowSource) {
  const sendMethod = method(flowSource, "sendNativeDpadKey");
  const probe = `
package com.yawf.runtimeinstrumentation;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Build;
import android.os.SystemClock;
import android.view.InputEvent;
import android.view.KeyEvent;

import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.UiDevice;

import java.util.ArrayList;
import java.util.List;

public final class RuntimeTvNativeKeyCallsiteProbe {
    private Instrumentation instrumentation;
    private UiDevice device;

${sendMethod}

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }

    public static void main(String[] arguments) {
        Build.VERSION.SDK_INT = 36;
        SystemClock.reset(0L);
        Configurator configurator = Configurator.getInstance();
        configurator.setWaitForIdleTimeout(6_085L);
        List<KeyEvent> events = new ArrayList<>();
        UiAutomation automation = new UiAutomation((InputEvent input, boolean sync) -> {
            KeyEvent event = (KeyEvent) input;
            events.add(event);
            return sync && event.eventTime <= 5_000L;
        });
        RuntimeTvNativeObservation.readFresh(
                36,
                configurator::getWaitForIdleTimeout,
                configurator::setWaitForIdleTimeout,
                () -> configurator.getWaitForIdleTimeout() == 0L,
                () -> {
                    check(configurator.getWaitForIdleTimeout() == 0L,
                            "callsite snapshot did not see zero timeout");
                    return Boolean.TRUE;
                });
        check(configurator.getWaitForIdleTimeout() == 6_085L,
                "callsite observation did not restore before key");

        RuntimeTvNativeKeyCallsiteProbe probe = new RuntimeTvNativeKeyCallsiteProbe();
        probe.instrumentation = new Instrumentation(automation);
        probe.device = new UiDevice(automation);
        probe.sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);

        check(configurator.getWaitForIdleTimeout() == 6_085L,
                "actual send callsite changed Configurator");
        check(SystemClock.now == 0L, "actual send callsite waited for UiDevice idle");
        check(events.size() == 2, "actual send callsite did not deliver one DOWN and one UP");
        check(events.get(0).action == KeyEvent.ACTION_DOWN
                        && events.get(1).action == KeyEvent.ACTION_UP,
                "actual send callsite event order");
    }
}
`;
  return runJavaSources({
    ...androidKeyStubSources,
    "RuntimeTvNativeObservation.java": read(helperPath),
    "RuntimeTvNativeKey.java": read(keyHelperPath),
    "RuntimeTvNativeKeyCallsiteProbe.java": probe,
  }, "com.yawf.runtimeinstrumentation.RuntimeTvNativeKeyCallsiteProbe");
}

function runPositionCallsiteProbe(flowSource) {
  const positionMethod = method(flowSource, "readPositionSeconds");
  const probe = `
package com.yawf.runtimeinstrumentation;

import java.util.function.Supplier;

public final class RuntimeTvPositionCallsiteProbe {
    private long timeout = 4_207L;
    private int clears;
    private int reads;

    private long readPositionSecondsSnapshot() {
        reads++;
        if (timeout != 0L) throw new AssertionError("native callsite bypassed fresh observer");
        return 42L;
    }

    private <T> T observeFreshNative(Supplier<T> reader) {
        return RuntimeTvNativeObservation.readFresh(
                36,
                () -> timeout,
                value -> timeout = value,
                () -> { clears++; return true; },
                reader);
    }

${positionMethod}

    public static void main(String[] arguments) {
        RuntimeTvPositionCallsiteProbe probe = new RuntimeTvPositionCallsiteProbe();
        if (probe.readPositionSeconds() != 42L) throw new AssertionError("wrong clock snapshot");
        if (probe.timeout != 4_207L) throw new AssertionError("callsite did not restore timeout");
        if (probe.clears != 1 || probe.reads != 1) throw new AssertionError("callsite counts");
    }
}
`;
  return runJavaSources({
    "RuntimeTvNativeObservation.java": read(helperPath),
    "RuntimeTvPositionCallsiteProbe.java": probe,
  }, "com.yawf.runtimeinstrumentation.RuntimeTvPositionCallsiteProbe");
}

function assertNativeReadSourceContract(source, surfaceSource = read(surfaceHelperPath)) {
  const surfaceWaiter = method(source, "waitForNativePlayerSurface");
  const surfaceReader = method(source, "readNativePlayerSurfaceSnapshot");
  const surfaceCandidateReader = method(source, "readNativePlayerSurfaceCandidate");
  const reveal = method(source, "revealControls");
  const audio = method(source, "selectAudioTrack");
  const nativeFocus = method(source, "focusNativeTarget");
  const focusReader = method(source, "readNativeFocusSnapshot");
  const focusedRight = method(source, "pressNativeFocusedRight");
  const nativeWait = method(source, "waitForNativePresence");
  const clock = method(source, "readPositionSeconds");
  const clockReader = method(source, "readPositionSecondsSnapshot");
  const flow = method(source, "runFlow");

  assert.match(surfaceWaiter,
    /observeFreshNative\(\s*\(\) -> readNativePlayerSurfaceSnapshot\(label\)\)/s);
  assert.match(surfaceReader, /device\.findObjects\(nativePlayerSurfaceRootSelector\(\)\)/);
  assert.match(surfaceReader,
    /RuntimeTvNativeSurface\.Candidate candidate = readNativePlayerSurfaceCandidate\(root\);/);
  assert.match(surfaceReader, /RuntimeTvNativeSurface\.admits\(candidate\)/);
  assert.match(surfaceReader, /if \(admitted > 1\)/);
  assert.match(surfaceReader, /device\.findObject\(By\.focused\(true\)\)/);
  assert.match(surfaceReader, /currentFocus\.getVisibleBounds\(\)/);
  assert.match(surfaceReader, /root\.isFocused\(\)/);
  assert.match(surfaceReader, /root\.getVisibleBounds\(\)/);
  assert.match(surfaceCandidateReader,
    /root\.findObjects\(nativePlayerControllerSelector\(\)\)/);
  assert.match(surfaceCandidateReader,
    /controller\.findObjects\(nativePlayerStateSelector\(\)\)/);
  assert.match(surfaceCandidateReader,
    /root\.findObjects\(nativeContentFrameSelector\(\)\)/);
  assert.match(surfaceCandidateReader,
    /contentFrame\.findObjects\(\s*nativeVideoSurfaceSelector\(\)\)/s);
  for (const getter of [
    "root.getApplicationPackage()",
    "root.getClassName()",
    "root.getContentDescription()",
    "root.isClickable()",
    "root.isEnabled()",
    "root.isFocusable()",
    "root.getVisibleBounds()",
    "controller.getVisibleBounds()",
    "state.isClickable()",
    "state.isEnabled()",
    "state.isFocusable()",
    "state.getVisibleBounds()",
    "contentFrame.getVisibleBounds()",
    "videoSurfaces.get(0).getVisibleBounds()",
  ]) assert.ok(surfaceCandidateReader.includes(getter), `uncovered surface getter: ${getter}`);

  assert.equal((reveal.match(/sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_DOWN\)/g) ?? []).length, 1);
  assert.match(reveal,
    /observeFreshNative\(\s*\(\) -> readNativePlayerSurfaceSnapshot\("native PlayerView before control reveal"\)\)/s);
  assert.ok(reveal.indexOf("surface.complete")
    < reveal.indexOf("sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN)"));
  assert.match(reveal, /assertNotNull\([\s\S]*surface\.focus\);/);
  assert.doesNotMatch(reveal,
    /device\.find|UiObject2|\.getVisibleBounds\(|\.isFocused\(|\.isFocusable\(|\.getParent\(/);
  assert.match(reveal,
    /waitForNativePresence\(playPauseSelector\(\), 5_000\)/);
  assert.doesNotMatch(reveal, /\bfor\s*\(|\bwhile\s*\(|device\.press|KEYCODE_DPAD_CENTER/);

  for (const state of ["Pause", "Play"]) {
    assert.match(flow, new RegExp(`waitForNative\\(playPauseSelector\\("${state}"\\), 5_000`));
  }
  assert.equal((flow.match(/waitForNative\(playPauseSelector\(/g) ?? []).length, 4);

  assert.match(nativeFocus, /observeFreshNative\(\(\) -> readNativeFocusSnapshot\(selector\)\)/);
  assert.match(focusReader, /device\.findObject\(selector\)/);
  assert.match(focusReader, /activation\.getParent\(\)/);
  assert.match(focusReader, /activation\.isFocusable\(\)/);
  assert.match(focusReader, /activation\.isFocused\(\)/);
  assert.match(focusReader, /activation\.getVisibleBounds\(\)/);
  assert.match(focusReader, /device\.findObject\(By\.focused\(true\)\)/);
  assert.match(focusReader, /currentFocus\.getVisibleBounds\(\)/);
  assert.match(focusedRight, /observeFreshNative\(\(\) -> readNativeFocusSnapshot\(selector\)\)/);
  assert.ok(focusedRight.indexOf("observeFreshNative")
    < focusedRight.indexOf("sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_RIGHT)"));
  assert.equal((flow.match(/pressNativeFocusedRight\(timeline, "timeline"\);/g) ?? []).length, 3);

  for (const marker of [
    'focusNativeAndActivate(By.res(PRODUCT_PACKAGE, "exo_settings"), "Media3 settings", 18);',
    'waitForNative(By.text("Audio"), 10_000, "Audio settings row");',
    'focusNativeAndActivate(By.text("Audio"), "Audio settings", 12);',
    'waitForNative(english, 10_000, "English audio track");',
    'waitForNative(french, 10_000, "French audio track");',
    'focusNativeAndActivate(audioLabel(language), language + " audio", 12);',
  ]) assert.ok(audio.includes(marker), `missing fresh native audio observation: ${marker}`);

  assert.match(nativeWait,
    /boolean present = observeFreshNative\(\(\) -> device\.findObject\(selector\) != null\);/);
  assert.match(clock, /return observeFreshNative\(this::readPositionSecondsSnapshot\);/);
  assert.match(clockReader, /device\.findObjects\(positionTimeBarSelector\(\)\)/);
  assert.match(clockReader, /timeBar -> !timeBar\.getVisibleBounds\(\)\.isEmpty\(\)/);
  assert.match(clockReader, /UiObject2::getContentDescription/);
  assert.match(clockReader, /RuntimeTvClock\.readUniqueVisibleTimeBar\(/);

  for (const reader of [surfaceReader, surfaceCandidateReader, focusReader, clockReader]) {
    assert.doesNotMatch(reader,
      /press(?:DPad|KeyCode|Back)|sendNativeDpadKey|\.click\s*\(|setText\(|capture\(|centerFrameHash\(|log\(|SystemClock\.sleep/);
  }
  assert.doesNotMatch(nativeWait,
    /press(?:DPad|KeyCode|Back)|sendNativeDpadKey|\.click\s*\(|setText\(|capture\(|centerFrameHash\(|log\(/);

  const observationAdapter = method(source, "observeFreshNative");
  assert.match(observationAdapter,
    /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE/);
  assert.ok(observationAdapter.indexOf("Build.VERSION.SDK_INT >=")
    < observationAdapter.indexOf("Configurator.getInstance()"));
  assert.match(observationAdapter,
    /\(\) -> instrumentation\.getUiAutomation\(\)\.clearCache\(\)/);
  assert.doesNotMatch(observationAdapter,
    /press(?:DPad|KeyCode|Back)|\.click\s*\(|setText\(|capture\(|centerFrameHash\(|log\(|SystemClock\.sleep/);
  assert.equal((source.match(/Configurator\.getInstance\(\)/g) ?? []).length, 1);
  assert.equal((source.match(/configurator::setWaitForIdleTimeout/g) ?? []).length, 1);
  assert.doesNotMatch(source, /setWaitForIdleTimeout\s*\(/);

  for (const className of ["NativeSurfaceSnapshot", "BoundsSnapshot", "NativeFocusSnapshot"]) {
    const start = source.indexOf(`private static final class ${className}`);
    assert.notEqual(start, -1, `missing immutable ${className}`);
    const end = source.indexOf("\n    }", start);
    const body = source.slice(start, end);
    assert.doesNotMatch(body, /UiObject2/);
    assert.doesNotMatch(body, /\bfinal\s+Rect\b/);
    for (const field of body.matchAll(
      /^\s{8}(?:final\s+)?(?:boolean|int|long|String|BoundsSnapshot|NativeFocusSnapshot)\s+[A-Za-z][A-Za-z0-9_]*;$/gm,
    )) {
      assert.match(field[0], /\bfinal\b/, `mutable snapshot field: ${field[0]}`);
    }
  }
  assert.doesNotMatch(surfaceSource, /UiObject2|android\.graphics\.Rect/);
  assert.match(surfaceSource, /static final class Candidate/);
  for (const field of surfaceSource.matchAll(
    /^\s{8}final (?:boolean|int|String) [A-Za-z][A-Za-z0-9_]*;$/gm,
  )) assert.match(field[0], /\bfinal\b/);
  assert.doesNotMatch(surfaceSource,
    /press(?:DPad|KeyCode|Back)|sendNativeDpadKey|\.click\s*\(|setText\(|capture\(|SystemClock\.sleep/);

  assert.equal((flow.match(/revealControls\(\);/g) ?? []).length, 6);
  assert.equal((audio.match(/revealControls\(\);/g) ?? []).length, 1);
  for (const timer of ["SystemClock.sleep(2_500);", "SystemClock.sleep(3_000);",
    "SystemClock.sleep(1_000);"]) {
    assert.ok(flow.includes(timer), `changed runtime timer: ${timer}`);
  }
  assert.match(source, /private static final long UI_WAIT = 60_000;/);
  assert.match(source, /private static final long MEDIA_WAIT = 45_000;/);

  for (const unchanged of [
    'waitFor(By.text("Connect this TV"), UI_WAIT, "native setup title");',
    'waitFor(By.text("YAWF TV native bridge runtime fixture"), UI_WAIT, "fixture heading");',
    'focusAndActivate(By.text("Play 4:3 HLS fixture"), "Play fixture", 10);',
    'waitFor(closedStatus(), UI_WAIT, "closed event status");',
    'webView.isFocused() || webView.findObject(By.focused(true)) != null',
    'waitFor(closedStatus(), UI_WAIT, "second close event");',
    'waitFor(closedStatus(), UI_WAIT, "recovery close event");',
    'assertTrue("Playback position did not advance", second >= first + 1);',
    'assertTrue("Decoded center frame did not change while playback advanced",',
    'assertTrue("Position advanced materially while paused", Math.abs(pausedEnd - pausedStart) <= 1);',
    'assertEquals("Decoded content changed while paused", pausedFrame, pausedFrameAfter);',
    'assertTrue("D-pad seek did not move by a meaningful delta", afterSeek >= beforeSeek + 10);',
    'checks.put("englishAudioSelected", true);',
    'checks.put("frenchAudioSelected", true);',
    'assertTrue("Playback did not resume after track selection", resumed > afterSeek);',
  ]) assert.ok(flow.includes(unchanged), `web/Back contract changed: ${unchanged}`);
}

function assertNativeKeySourceContract(flowSource, keySource) {
  const reveal = method(flowSource, "revealControls");
  const activate = method(flowSource, "focusNativeAndActivate");
  const focus = method(flowSource, "focusNativeTarget");
  const focusedRight = method(flowSource, "pressNativeFocusedRight");
  const adapter = method(flowSource, "sendNativeDpadKey");

  assert.match(adapter,
    /RuntimeTvNativeKey\.send\(instrumentation\.getUiAutomation\(\), keyCode\);/);
  assert.doesNotMatch(adapter, /Configurator|device\.|pressKeyCode|pressDPad|sleep|waitForIdle/);
  assert.equal((flowSource.match(/RuntimeTvNativeKey\.send\(/g) ?? []).length, 1);

  assert.match(reveal, /sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_DOWN\);/);
  assert.match(activate, /sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_CENTER\);/);
  assert.match(focus, /sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_DOWN\);/);
  assert.match(focus,
    /sendNativeDpadKey\(vertical >= 0\s*\? KeyEvent\.KEYCODE_DPAD_DOWN : KeyEvent\.KEYCODE_DPAD_UP\);/s);
  assert.match(focus,
    /sendNativeDpadKey\(horizontal >= 0\s*\? KeyEvent\.KEYCODE_DPAD_RIGHT : KeyEvent\.KEYCODE_DPAD_LEFT\);/s);
  assert.match(focusedRight, /sendNativeDpadKey\(KeyEvent\.KEYCODE_DPAD_RIGHT\);/);
  for (const nativeAction of [reveal, activate, focus, focusedRight]) {
    assert.doesNotMatch(nativeAction, /device\.press(?:DPad|KeyCode)/);
  }
  assert.ok(reveal.indexOf("observeFreshNative") < reveal.indexOf("sendNativeDpadKey"));
  assert.ok(activate.indexOf("focused.activationFocused") < activate.indexOf("sendNativeDpadKey"));
  assert.ok(focusedRight.indexOf("snapshot.activationFocused")
    < focusedRight.indexOf("sendNativeDpadKey"));

  assert.match(keySource, /import android\.app\.UiAutomation;/);
  assert.match(keySource, /Build\.VERSION\.SDK_INT < MINIMUM_INPUT_INJECTION_API/);
  assert.match(keySource, /private static final int MINIMUM_INPUT_INJECTION_API = 18;/);
  assert.equal((keySource.match(/automation\.injectInputEvent\(/g) ?? []).length, 2);
  assert.equal((keySource.match(/injectInputEvent\([^;]+, true\)/g) ?? []).length, 2);
  assert.match(keySource,
    /new KeyEvent\(\s*eventTime,\s*eventTime,\s*action,\s*keyCode,\s*0,\s*0,\s*KeyCharacterMap\.VIRTUAL_KEYBOARD,\s*0,\s*0,\s*InputDevice\.SOURCE_KEYBOARD\)/s);
  assert.doesNotMatch(keySource,
    /Configurator|UiDevice|Instrumentation|waitForIdle|SystemClock\.sleep|Thread\.sleep|sendKeyDownUpSync|executeShellCommand/);
  const namedKeyCodes = new Set(
    [...keySource.matchAll(/KeyEvent\.(KEYCODE_[A-Z0-9_]+)/g)].map(match => match[1]),
  );
  assert.deepEqual([...namedKeyCodes].sort(), [
    "KEYCODE_DPAD_CENTER",
    "KEYCODE_DPAD_DOWN",
    "KEYCODE_DPAD_LEFT",
    "KEYCODE_DPAD_RIGHT",
    "KEYCODE_DPAD_UP",
  ]);
}

test("fresh native helper executes zero-cache-query-restore and immutable snapshot contract", () => {
  assertProbePasses(runHelperProbe());
});

test("helper probe kills omitted zero-timeout write", () => {
  const source = read(helperPath);
  const mutant = source.replace("            idleTimeoutWriter.accept(0L);\n", "");
  assert.notEqual(mutant, source);
  assertExecutableMutantKilled(mutant);
});

test("helper probe kills ignored cache-clear result", () => {
  const source = read(helperPath);
  const mutant = source.replace(
    "if (!cacheClearer.getAsBoolean()) {",
    "if (false && !cacheClearer.getAsBoolean()) {",
  );
  assert.notEqual(mutant, source);
  assertExecutableMutantKilled(mutant);
});

test("helper probe kills restoration moved out of finally", () => {
  const source = read(helperPath);
  const original = [
    "            return reader.get();",
    "        } finally {",
    "            idleTimeoutWriter.accept(savedIdleTimeout);",
    "        }",
  ].join("\n");
  const replacement = [
    "            T result = reader.get();",
    "            idleTimeoutWriter.accept(savedIdleTimeout);",
    "            return result;",
    "        } catch (RuntimeException | Error failure) {",
    "            throw failure;",
    "        }",
  ].join("\n");
  const mutant = source.replace(original, replacement);
  assert.notEqual(mutant, source);
  assertExecutableMutantKilled(mutant);
});

test("helper probe kills wrong zero timeout restore", () => {
  const source = read(helperPath);
  const mutant = source.replace(
    "idleTimeoutWriter.accept(savedIdleTimeout);",
    "idleTimeoutWriter.accept(0L);",
  );
  assert.notEqual(mutant, source);
  assertExecutableMutantKilled(mutant);
});

test("native key helper executes fresh-before-key, delayed UiDevice control, allowlist, event, API, and injection contracts", () => {
  assertProbePasses(runNativeKeyProbe());
});

test("native key probe kills an omitted API floor", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (Build.VERSION.SDK_INT < MINIMUM_INPUT_INJECTION_API) {",
    "if (false && Build.VERSION.SDK_INT < MINIMUM_INPUT_INJECTION_API) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills an arbitrary-key allowlist bypass", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (!isAllowedDpadKey(keyCode)) {",
    "if (false && !isAllowedDpadKey(keyCode)) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills an omitted DOWN event", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (!automation.injectInputEvent(down, true)) {",
    "if (false) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills an omitted UP event", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (!automation.injectInputEvent(up, true)) {",
    "if (false) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills an ignored false DOWN result", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (!automation.injectInputEvent(down, true)) {",
    "if (!automation.injectInputEvent(down, true) && false) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills an ignored false UP result", () => {
  const source = read(keyHelperPath);
  const mutant = source.replace(
    "if (!automation.injectInputEvent(up, true)) {",
    "if (!automation.injectInputEvent(up, true) && false) {",
  );
  assert.notEqual(mutant, source);
  assertNativeKeyMutantKilled(mutant);
});

test("native key probe kills nonzero repeat, meta, and wrong source event mutants", () => {
  const source = read(keyHelperPath);
  const repeatMutant = source.replace(
    "                keyCode,\n                0,\n                0,",
    "                keyCode,\n                1,\n                0,",
  );
  const metaMutant = source.replace(
    "                keyCode,\n                0,\n                0,",
    "                keyCode,\n                0,\n                1,",
  );
  const sourceMutant = source.replace(
    "InputDevice.SOURCE_KEYBOARD);",
    "InputDevice.SOURCE_DPAD);",
  );
  for (const mutant of [repeatMutant, metaMutant, sourceMutant]) {
    assert.notEqual(mutant, source);
    assertNativeKeyMutantKilled(mutant);
  }
});

test("actual native key callsite executes without the restored UiDevice idle timeout", () => {
  assertProbePasses(runNativeKeyCallsiteProbe(read(flowPath)));
});

test("behavioral predecessor probe kills actual native callsite bypass through UiDevice", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "RuntimeTvNativeKey.send(instrumentation.getUiAutomation(), keyCode);",
    "device.pressKeyCode(keyCode);",
  );
  assert.notEqual(mutant, source);
  const result = runNativeKeyCallsiteProbe(mutant);
  assert.equal(result.compile.status, 0, result.compile.stdout + result.compile.stderr);
  assert.ok(result.run, "native callsite predecessor probe did not run");
  assert.notEqual(result.run.status, 0,
    `legacy UiDevice callsite survived behavioral probe:\n${result.run.stdout}${result.run.stderr}`);
});

test("actual clock callsite executes the fresh observer", () => {
  assertProbePasses(runPositionCallsiteProbe(read(flowPath)));
});

test("executable actual clock callsite probe kills observation bypass", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "return observeFreshNative(this::readPositionSecondsSnapshot);",
    "return readPositionSecondsSnapshot();",
  );
  assert.notEqual(mutant, source);
  const result = runPositionCallsiteProbe(mutant);
  assert.equal(result.compile.status, 0, result.compile.stdout + result.compile.stderr);
  assert.ok(result.run);
  assert.notEqual(result.run.status, 0,
    `actual callsite bypass survived:\n${result.run.stdout}${result.run.stderr}`);
});

test("TV native readers are fresh, bounded, immutable, and input-free", () => {
  const source = read(flowPath);
  assertNativeReadSourceContract(source);
  assertNativeKeySourceContract(source, read(keyHelperPath));
});

test("source guard kills key input inside a native supplier", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "        List<UiObject2> controllers = root.findObjects(nativePlayerControllerSelector());",
    "        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_CENTER);\n        List<UiObject2> controllers = root.findObjects(nativePlayerControllerSelector());",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills semantic click input inside a native supplier", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "        List<UiObject2> controllers = root.findObjects(nativePlayerControllerSelector());",
    "        List<UiObject2> controllers = root.findObjects(nativePlayerControllerSelector());\n        controllers.get(0).click();",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills a live native getter after reveal observation restore", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);",
    "        device.findObject(nativePlayerSurfaceRootSelector()).getVisibleBounds();\n        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills a phase-wide Configurator override", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "        launchProduct();",
    "        Configurator.getInstance().setWaitForIdleTimeout(0L);\n        launchProduct();",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills an extra control reveal retry", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "        long first = waitForPositionAtLeast(2, MEDIA_WAIT);",
    "        revealControls();\n        long first = waitForPositionAtLeast(2, MEDIA_WAIT);",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills a repeated D-pad reveal input", () => {
  const source = read(flowPath);
  const reveal = method(source, "revealControls");
  const mutantReveal = reveal.replace(
    "        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);",
    "        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);\n        sendNativeDpadKey(KeyEvent.KEYCODE_DPAD_DOWN);",
  );
  const mutant = source.replace(reveal, mutantReveal);
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills native reveal deadline changes", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    "waitForNativePresence(playPauseSelector(), 5_000)",
    "waitForNativePresence(playPauseSelector(), 6_000)",
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills paused observation timer changes", () => {
  const source = read(flowPath);
  const mutant = source.replace("SystemClock.sleep(3_000);", "SystemClock.sleep(2_000);");
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});

test("source guard kills an uncovered semantic Play getter", () => {
  const source = read(flowPath);
  const mutant = source.replace(
    'waitForNative(playPauseSelector("Play"), 5_000, "semantic Play state before resuming");',
    'waitFor(playPauseSelector("Play"), 5_000, "semantic Play state before resuming");',
  );
  assert.notEqual(mutant, source);
  assert.throws(() => assertNativeReadSourceContract(mutant));
});
