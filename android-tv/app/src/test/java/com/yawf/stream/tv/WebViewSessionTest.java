package com.yawf.stream.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WebViewSessionTest {
    @Test
    public void replacementRejectsCallbacksFromTheClosedWebView() {
        WebViewSession sessions = new WebViewSession();
        long first = sessions.open();
        assertTrue(sessions.isActive(first));

        sessions.close(first);
        long replacement = sessions.open();

        assertNotEquals(first, replacement);
        assertFalse(sessions.isActive(first));
        assertTrue(sessions.isActive(replacement));
    }

    @Test
    public void staleCloseCannotInvalidateTheReplacement() {
        WebViewSession sessions = new WebViewSession();
        long first = sessions.open();
        long replacement = sessions.open();

        sessions.close(first);

        assertFalse(sessions.isActive(first));
        assertTrue(sessions.isActive(replacement));
    }

    @Test
    public void closingTheCurrentSessionRejectsAllLateCallbacks() {
        WebViewSession sessions = new WebViewSession();
        long current = sessions.open();

        sessions.close(current);

        assertFalse(sessions.isActive(current));
        assertFalse(sessions.isActive(0));
    }
}
