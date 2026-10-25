package com.yawf.stream.tv;

/**
 * Tracks ownership of one replaceable WebView without retaining the Android
 * view itself. Callbacks capture their session id and are ignored once that
 * view is closed or replaced.
 */
final class WebViewSession {
    private long nextId;
    private long activeId;

    synchronized long open() {
        activeId = ++nextId;
        return activeId;
    }

    synchronized boolean isActive(long sessionId) {
        return sessionId != 0 && sessionId == activeId;
    }

    synchronized void close(long sessionId) {
        if (sessionId != 0 && sessionId == activeId) {
            activeId = 0;
        }
    }
}
