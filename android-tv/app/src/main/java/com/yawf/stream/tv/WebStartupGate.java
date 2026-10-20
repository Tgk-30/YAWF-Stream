package com.yawf.stream.tv;

import java.util.concurrent.ExecutorService;

/**
 * Pure state machine that keeps asynchronous WebView startup separate from the
 * Activity presentation. Startup callbacks can arrive after the user changes
 * screens, after a retry, or after the Activity closes.
 */
final class WebStartupGate {
    enum Presentation {
        NONE,
        LOADING,
        WEB_APP,
        ERROR
    }

    static final class Decision {
        private static final Decision NONE = new Decision(false, 0, Presentation.NONE);

        final boolean startStartup;
        final long startupId;
        final Presentation presentation;

        private Decision(
            boolean startStartup,
            long startupId,
            Presentation presentation
        ) {
            this.startStartup = startStartup;
            this.startupId = startupId;
            this.presentation = presentation;
        }
    }

    private enum State {
        IDLE,
        STARTING,
        READY,
        FAILED,
        CLOSED
    }

    private State state = State.IDLE;
    private long nextStartupId;
    private long activeStartupId;
    private boolean webAppRequested;

    synchronized Decision beginStartup() {
        if (state == State.IDLE || state == State.FAILED) {
            return start(Presentation.NONE);
        }
        return Decision.NONE;
    }

    synchronized Decision requestWebApp() {
        if (state == State.CLOSED) return Decision.NONE;
        webAppRequested = true;
        if (state == State.READY) {
            return new Decision(false, activeStartupId, Presentation.WEB_APP);
        }
        if (state == State.STARTING) {
            return new Decision(false, activeStartupId, Presentation.LOADING);
        }
        return start(Presentation.LOADING);
    }

    synchronized void cancelWebApp() {
        webAppRequested = false;
    }

    synchronized Decision startupReady(long startupId) {
        if (state != State.STARTING || startupId != activeStartupId) {
            return Decision.NONE;
        }
        state = State.READY;
        return new Decision(
            false,
            startupId,
            webAppRequested ? Presentation.WEB_APP : Presentation.NONE
        );
    }

    synchronized Decision startupFailed(long startupId) {
        if (state != State.STARTING || startupId != activeStartupId) {
            return Decision.NONE;
        }
        state = State.FAILED;
        return new Decision(
            false,
            startupId,
            webAppRequested ? Presentation.ERROR : Presentation.NONE
        );
    }

    synchronized boolean isReady() {
        return state == State.READY;
    }

    synchronized void close() {
        state = State.CLOSED;
        webAppRequested = false;
    }

    void closeAndShutdown(ExecutorService executor) {
        close();
        // Provider initialization is process-global and has no cancellation
        // contract. Let admitted startup finish; its closed gate ignores it.
        executor.shutdown();
    }

    private Decision start(Presentation presentation) {
        state = State.STARTING;
        activeStartupId = ++nextStartupId;
        return new Decision(true, activeStartupId, presentation);
    }
}
