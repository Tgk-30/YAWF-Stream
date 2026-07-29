package com.yawf.stream.tv;

/**
 * Decides whether a WebView load failure should replace the app UI with the
 * recovery screen.
 *
 * A TV has no address bar, so a saved server address that stops resolving used
 * to leave the app on the WebView's own error page with no way back to setup:
 * Back exited the app, and the next launch reloaded the same dead address.
 * Recovery has to be driven from these callbacks.
 */
final class ConnectionFailure {
    private ConnectionFailure() {}

    /**
     * The WebView reports a failure for every subresource, so a single missing
     * poster image must not throw the user back to setup. Only a main-frame
     * failure on the configured server origin means the app cannot continue.
     */
    static boolean blocksApp(boolean isForMainFrame, String serverBase, String failingUrl) {
        if (!isForMainFrame) return false;
        if (serverBase == null || failingUrl == null) return false;
        return ServerAddress.sameOrigin(serverBase, failingUrl);
    }

    /**
     * The server answered, so the address is reachable but not serving the app.
     * A wrong port on a host that runs something else is the common case, and it
     * is just as unusable as a connection refusal.
     */
    static boolean isFatalHttpStatus(int statusCode) {
        return statusCode >= 400;
    }
}
