package com.yawf.runtimeinstrumentation;

import android.os.Build;
import android.os.SystemClock;

import androidx.test.uiautomator.Configurator;

/** Bounded zero-idle transaction for opening the external-player settings panel. */
final class RuntimeExternalSettingsTransaction {
    private static final long TRANSACTION_IDLE_TIMEOUT_MS = 0L;
    private static final long POLL_INTERVAL_MS = 250L;
    private static final int MAX_PLAYBACK_ACTIONS_RAIL_PANS = 3;

    interface ClickTarget {
        void click();
    }

    interface Environment {
        boolean clearAccessibilityCache();

        void assertNoOutOfScopeApproval();

        Observation observePlaybackSettings();

        void recordTiming(
                String stage,
                long startedAtMs,
                long finishedAtMs,
                long idleBeforeMs,
                long idleAfterMs,
                boolean returned);

        void recordSettingsClickTiming(
                long dispatchedAtMs,
                long finishedAtMs,
                long idleBeforeMs,
                long idleAfterMs,
                boolean returned);

        void recordRailObservation(String state, int completedPanAttempts);

        void log(String message);
    }

    static final class Observation {
        private final ClickTarget revealTarget;
        private final ClickTarget railPanTarget;
        private final ClickTarget settingsTarget;
        private final String state;

        private Observation(
                ClickTarget revealTarget,
                ClickTarget railPanTarget,
                ClickTarget settingsTarget,
                String state) {
            int targetCount = (revealTarget == null ? 0 : 1)
                    + (railPanTarget == null ? 0 : 1)
                    + (settingsTarget == null ? 0 : 1);
            if (targetCount > 1) {
                throw new AssertionError("A settings observation cannot expose multiple input targets");
            }
            this.revealTarget = revealTarget;
            this.railPanTarget = railPanTarget;
            this.settingsTarget = settingsTarget;
            this.state = state;
        }

        static Observation waiting() {
            return new Observation(null, null, null, "player-dialog-unavailable");
        }

        static Observation reveal(ClickTarget target) {
            if (target == null) {
                throw new AssertionError("The reveal target was missing");
            }
            return new Observation(
                    target, null, null, "player-dialog-visible-controls-hidden");
        }

        static Observation railPan(ClickTarget target) {
            if (target == null) {
                throw new AssertionError("The Playback actions rail pan target was missing");
            }
            return new Observation(
                    null, target, null, "exact-playback-actions-rail-visible");
        }

        static Observation settings(ClickTarget target) {
            if (target == null) {
                throw new AssertionError("The Playback settings target was missing");
            }
            return new Observation(null, null, target, "playback-settings-visible");
        }
    }

    static final class Result {
        final int railObservationCount;
        final int railPanAttempts;
        final boolean revealTapPerformed;
        final int settingsClickCount;

        Result(
                int railObservationCount,
                int railPanAttempts,
                boolean revealTapPerformed,
                int settingsClickCount) {
            if (railObservationCount < 0
                    || railPanAttempts < 0
                    || railPanAttempts > MAX_PLAYBACK_ACTIONS_RAIL_PANS
                    || (railPanAttempts == 0 && railObservationCount != 0)
                    || (railPanAttempts > 0 && railObservationCount < railPanAttempts)
                    || settingsClickCount != 1) {
                throw new AssertionError("The settings rail transaction result was incomplete");
            }
            this.railObservationCount = railObservationCount;
            this.railPanAttempts = railPanAttempts;
            this.revealTapPerformed = revealTapPerformed;
            this.settingsClickCount = settingsClickCount;
        }
    }

    private RuntimeExternalSettingsTransaction() {}

    private static String chooseNextSettingsAction(
            boolean settingsVisible,
            boolean railVisible,
            boolean revealVisible,
            boolean revealTapPerformed,
            int railPanAttempts) {
        if (railPanAttempts < 0 || railPanAttempts > MAX_PLAYBACK_ACTIONS_RAIL_PANS) {
            throw new AssertionError("Playback actions rail pan count escaped its fixed bound");
        }
        if (settingsVisible) {
            return "click-settings";
        }
        if (railVisible) {
            if (railPanAttempts >= MAX_PLAYBACK_ACTIONS_RAIL_PANS) {
                throw new AssertionError("Playback settings remained hidden after three rail pans");
            }
            return "pan-rail";
        }
        if (revealVisible && !revealTapPerformed) return "reveal";
        return "wait";
    }

    private static void runFreshLegalGuard(
            Environment environment,
            Configurator configurator,
            String stage) {
        long startedAtMs = SystemClock.uptimeMillis();
        long idleBeforeMs = configurator.getWaitForIdleTimeout();
        boolean returned = false;
        try {
            environment.assertNoOutOfScopeApproval();
            returned = true;
        } finally {
            environment.recordTiming(
                    stage,
                    startedAtMs,
                    SystemClock.uptimeMillis(),
                    idleBeforeMs,
                    configurator.getWaitForIdleTimeout(),
                    returned);
        }
    }

    static Result open(Environment environment, long timeoutMs) {
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
            int railObservationCount = 0;
            int railPanAttempts = 0;
            String lastRailObservation = null;
            while (SystemClock.uptimeMillis() < deadline) {
                long cacheStartedAtMs = SystemClock.uptimeMillis();
                long cacheIdleBeforeMs = configurator.getWaitForIdleTimeout();
                boolean cacheReturned = false;
                boolean cacheCleared;
                try {
                    cacheCleared = environment.clearAccessibilityCache();
                    cacheReturned = true;
                } finally {
                    environment.recordTiming(
                            "cache",
                            cacheStartedAtMs,
                            SystemClock.uptimeMillis(),
                            cacheIdleBeforeMs,
                            configurator.getWaitForIdleTimeout(),
                            cacheReturned);
                }
                if (!cacheCleared) {
                    throw new AssertionError("Accessibility cache refresh failed");
                }

                runFreshLegalGuard(environment, configurator, "fresh-legal-guard");

                long acquisitionStartedAtMs = SystemClock.uptimeMillis();
                long acquisitionIdleBeforeMs = configurator.getWaitForIdleTimeout();
                boolean acquisitionReturned = false;
                Observation observation;
                try {
                    observation = environment.observePlaybackSettings();
                    acquisitionReturned = true;
                } finally {
                    environment.recordTiming(
                            "settings-acquisition",
                            acquisitionStartedAtMs,
                            SystemClock.uptimeMillis(),
                            acquisitionIdleBeforeMs,
                            configurator.getWaitForIdleTimeout(),
                            acquisitionReturned);
                }
                if (observation == null) {
                    throw new AssertionError("The settings observation was missing");
                }

                String railObservation = observation.state
                        + " pansCompleted=" + railPanAttempts;
                if (!railObservation.equals(lastRailObservation)) {
                    environment.recordRailObservation(observation.state, railPanAttempts);
                    if (observation.railPanTarget != null) railObservationCount++;
                    lastRailObservation = railObservation;
                }

                String nextAction = chooseNextSettingsAction(
                        observation.settingsTarget != null,
                        observation.railPanTarget != null,
                        observation.revealTarget != null,
                        revealTapPerformed,
                        railPanAttempts);
                if ("click-settings".equals(nextAction)) {
                    runFreshLegalGuard(
                            environment, configurator, "fresh-input-legal-guard");
                    long clickDispatchedAtMs = SystemClock.uptimeMillis();
                    long clickIdleBeforeMs = configurator.getWaitForIdleTimeout();
                    boolean clickReturned = false;
                    try {
                        observation.settingsTarget.click();
                        clickReturned = true;
                    } finally {
                        environment.recordSettingsClickTiming(
                                clickDispatchedAtMs,
                                SystemClock.uptimeMillis(),
                                clickIdleBeforeMs,
                                configurator.getWaitForIdleTimeout(),
                                clickReturned);
                    }
                    environment.log("Clicked freshly observed semantic control: Playback settings");
                    return new Result(
                            railObservationCount,
                            railPanAttempts,
                            revealTapPerformed,
                            1);
                }
                if ("pan-rail".equals(nextAction)) {
                    runFreshLegalGuard(
                            environment, configurator, "fresh-input-legal-guard");
                    railPanAttempts++;
                    long panStartedAtMs = SystemClock.uptimeMillis();
                    long panIdleBeforeMs = configurator.getWaitForIdleTimeout();
                    boolean panReturned = false;
                    try {
                        observation.railPanTarget.click();
                        panReturned = true;
                    } finally {
                        environment.recordTiming(
                                "playback-actions-rail-pan-" + railPanAttempts,
                                panStartedAtMs,
                                SystemClock.uptimeMillis(),
                                panIdleBeforeMs,
                                configurator.getWaitForIdleTimeout(),
                                panReturned);
                    }
                    environment.log("Panned the exact observed Playback actions rail to the right");
                } else if ("reveal".equals(nextAction)) {
                    runFreshLegalGuard(
                            environment, configurator, "fresh-input-legal-guard");
                    revealTapPerformed = true;
                    long revealStartedAtMs = SystemClock.uptimeMillis();
                    long revealIdleBeforeMs = configurator.getWaitForIdleTimeout();
                    boolean revealReturned = false;
                    try {
                        observation.revealTarget.click();
                        revealReturned = true;
                    } finally {
                        environment.recordTiming(
                                "reveal-click",
                                revealStartedAtMs,
                                SystemClock.uptimeMillis(),
                                revealIdleBeforeMs,
                                configurator.getWaitForIdleTimeout(),
                                revealReturned);
                    }
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
