package com.yawf.runtimeinstrumentation;

import android.app.UiAutomation;
import android.os.Build;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;

/** Sends one ordinary native-player D-pad press without UiAutomator's implicit idle wait. */
final class RuntimeTvNativeKey {
    private static final int MINIMUM_INPUT_INJECTION_API = 18;

    private RuntimeTvNativeKey() { }

    static void send(UiAutomation automation, int keyCode) {
        if (Build.VERSION.SDK_INT < MINIMUM_INPUT_INJECTION_API) {
            throw new AssertionError("Native D-pad injection requires Android API 18+");
        }
        if (!isAllowedDpadKey(keyCode)) {
            throw new AssertionError("Native key is outside the D-pad allowlist: " + keyCode);
        }

        long eventTime = SystemClock.uptimeMillis();
        KeyEvent down = keyEvent(eventTime, KeyEvent.ACTION_DOWN, keyCode);
        if (!automation.injectInputEvent(down, true)) {
            throw new AssertionError("Native D-pad key down injection failed: " + keyCode);
        }
        KeyEvent up = keyEvent(eventTime, KeyEvent.ACTION_UP, keyCode);
        if (!automation.injectInputEvent(up, true)) {
            throw new AssertionError("Native D-pad key up injection failed: " + keyCode);
        }
    }

    private static boolean isAllowedDpadKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                || keyCode == KeyEvent.KEYCODE_DPAD_UP
                || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
                || keyCode == KeyEvent.KEYCODE_DPAD_CENTER;
    }

    private static KeyEvent keyEvent(long eventTime, int action, int keyCode) {
        return new KeyEvent(
                eventTime,
                eventTime,
                action,
                keyCode,
                0,
                0,
                KeyCharacterMap.VIRTUAL_KEYBOARD,
                0,
                0,
                InputDevice.SOURCE_KEYBOARD);
    }
}
