package com.yawf.stream.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PlaybackHeadersTest {
    @Test
    public void forwardsOnlyCloudflareAccessCookiesInStableOrder() {
        assertEquals(
            "CF_Authorization=auth-token; CF_Session=session-token; CF_AppSession=app-token",
            PlaybackHeaders.cloudflareCookieHeader(
                "ds_session=private; CF_AppSession=app-token; unrelated=value; " +
                    "CF_Authorization=auth-token; CF_Session=session-token"
            )
        );
    }

    @Test
    public void neverForwardsTheApplicationSessionCookie() {
        assertNull(
            PlaybackHeaders.cloudflareCookieHeader(
                "ds_session=private; theme=dark"
            )
        );
    }

    @Test
    public void rejectsInjectedAndOversizedCookieValues() {
        String oversized = "a".repeat(4_097);
        assertEquals(
            "CF_Session=safe",
            PlaybackHeaders.cloudflareCookieHeader(
                "CF_Authorization=bad\r\nInjected:value; " +
                    "CF_Session=safe; CF_AppSession=" +
                    oversized
            )
        );
    }

    @Test
    public void keepsTheCombinedHeaderWithinItsBound() {
        String value = "a".repeat(4_096);
        String result = PlaybackHeaders.cloudflareCookieHeader(
            "CF_Authorization=" +
                value +
                "; CF_Session=" +
                value +
                "; CF_AppSession=small"
        );

        assertTrue(result.length() <= 8_192);
        assertTrue(result.startsWith("CF_Authorization=" + value));
        assertTrue(result.endsWith("CF_AppSession=small"));
        assertFalse(result.contains("CF_Session="));
    }
}
