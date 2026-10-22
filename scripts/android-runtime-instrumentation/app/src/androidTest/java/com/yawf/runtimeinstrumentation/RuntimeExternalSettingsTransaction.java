package com.yawf.runtimeinstrumentation;

import android.os.Build;
import android.os.SystemClock;

import androidx.test.uiautomator.Configurator;

/** Bounded zero-idle transaction for opening the external-player settings panel. */
final class RuntimeExternalSettingsTransaction {
    private static final long TRANSACTION_IDLE_TIMEOUT_MS = 0L;
    private static final long POLL_INTERVAL_MS = 250L;

    interface ClickTarget {
        void click();
    }

    interface Environment {
        boolean clearAccessibilityCache();

        void assertNoOutOfScopeApproval();

        Observation observePlaybackSettings();

        void log(String message);
    }

    static final class Observation {
        private final ClickTarget revealTarget;
        private final ClickTarget settingsTarget;

        private Observation(ClickTarget revealTarget, ClickTarget settingsTarget) {
            if (revealTarget != null && settingsTarget != null) {
                throw new AssertionError("A settings observation cannot expose two click targets");
            }
            this.revealTarget = revealTarget;
            this.settingsTarget = settingsTarget;
        }

        static Observation waiting() {
            return new Observation(null, null);
        }

        static Observation reveal(ClickTarget target) {
            if (target == null) {
                throw new AssertionError("The reveal target was missing");
            }
            return new Observation(target, null);
        }

        static Observation settings(ClickTarget target) {
            if (target == null) {
                throw new AssertionError("The Playback settings target was missing");
            }
            return new Observation(null, target);
        }
    }

    private RuntimeExternalSettingsTransaction() {}

    static void open(Environment environment, long timeoutMs) {
        if (environment == null) {
            throw new AssertionError("The settings transaction environment was missing");
        }
        if (timeoutMs <= 0) {
            throw new AssertionError("The settings transaction timeout must be positive");
        }

        Configurator configurator = Configurator.getInstance();
        long previousIdleTimeoutMs = configurator.getWaitForIdleTimeout();
        try {
            configurator.setWaitForIdleTimeout(TRANSACTION_IDLE_TIMEOUT_MS);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                throw new AssertionError(
                        "Accessibility cache refresh requires Android API 34 or newer");
            }

            long deadline = SystemClock.uptimeMillis() + timeoutMs;
            boolean revealTapPerformed = false;
            while (SystemClock.uptimeMillis() < deadline) {
                if (!environment.clearAccessibilityCache()) {
                    throw new AssertionError("Accessibility cache refresh failed");
                }
                environment.assertNoOutOfScopeApproval();
                Observation observation = environment.observePlaybackSettings();
                if (observation == null) {
                    throw new AssertionError("The settings observation was missing");
                }

                if (observation.settingsTarget != null) {
                    observation.settingsTarget.click();
                    environment.log("Clicked freshly observed semantic control: Playback settings");
                    return;
                }
                if (observation.revealTarget != null && !revealTapPerformed) {
                    revealTapPerformed = true;
                    observation.revealTarget.click();
                    environment.log(
                            "Tapped the exact observed playing dialog surface once to reveal controls");
                }
                SystemClock.sleep(POLL_INTERVAL_MS);
            }
            throw new AssertionError("Timed out waiting for Playback settings");
        } finally {
            configurator.setWaitForIdleTimeout(previousIdleTimeoutMs);
        }
    }
}
