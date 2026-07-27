package com.yawf.stream.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ConnectionFailureTest {
    private static final String SERVER = "http://192.168.1.20:43110";

    @Test
    public void mainFrameFailureOnTheConfiguredServerBlocksTheApp() {
        assertTrue(ConnectionFailure.blocksApp(true, SERVER, SERVER + "/tv"));
        assertTrue(
            ConnectionFailure.blocksApp(
                true,
                "https://stream.example.com",
                "https://stream.example.com/tv"
            )
        );
    }

    @Test
    public void subresourceFailuresNeverBlockTheApp() {
        // A missing poster or a failed analytics beacon must not send the user
        // back to setup while the app itself is working.
        assertFalse(ConnectionFailure.blocksApp(false, SERVER, SERVER + "/poster-01.jpg"));
    }

    @Test
    public void failuresOutsideTheConfiguredServerNeverBlockTheApp() {
        assertFalse(ConnectionFailure.blocksApp(true, SERVER, "https://fonts.googleapis.com/css"));
        assertFalse(ConnectionFailure.blocksApp(true, SERVER, "http://192.168.1.20:9696/tv"));
    }

    @Test
    public void missingAddressesAreNotTreatedAsServerFailures() {
        assertFalse(ConnectionFailure.blocksApp(true, null, SERVER + "/tv"));
        assertFalse(ConnectionFailure.blocksApp(true, SERVER, null));
    }

    @Test
    public void clientAndServerErrorStatusesAreFatal() {
        assertTrue(ConnectionFailure.isFatalHttpStatus(404));
        assertTrue(ConnectionFailure.isFatalHttpStatus(401));
        assertTrue(ConnectionFailure.isFatalHttpStatus(500));
        assertTrue(ConnectionFailure.isFatalHttpStatus(502));
    }

    @Test
    public void successAndRedirectStatusesAreNotFatal() {
        assertFalse(ConnectionFailure.isFatalHttpStatus(200));
        assertFalse(ConnectionFailure.isFatalHttpStatus(204));
        assertFalse(ConnectionFailure.isFatalHttpStatus(304));
    }
}
