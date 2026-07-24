package com.yawf.stream.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerAddressTest {
    @Test
    public void normalizesServerAddressesWithoutLosingMountedPaths() {
        assertEquals(
            "https://stream.example.com/yawf",
            ServerAddress.normalize(" HTTPS://Stream.Example.com/yawf/// ")
        );
        assertEquals(
            "http://192.168.1.20:43110",
            ServerAddress.normalize("http://192.168.1.20:43110/")
        );
    }

    @Test
    public void rejectsCredentialsQueriesFragmentsAndUnsupportedSchemes() {
        assertNull(ServerAddress.normalize("https://user:pass@example.com"));
        assertNull(ServerAddress.normalize("https://example.com?token=value"));
        assertNull(ServerAddress.normalize("https://example.com/#fragment"));
        assertNull(ServerAddress.normalize("file:///tmp/server"));
    }

    @Test
    public void comparesDefaultAndExplicitOriginPorts() {
        assertTrue(
            ServerAddress.sameOrigin(
                "https://stream.example.com",
                "https://stream.example.com:443/api/stream/1"
            )
        );
        assertFalse(
            ServerAddress.sameOrigin(
                "https://stream.example.com",
                "https://other.example.com/api/stream/1"
            )
        );
    }

    @Test
    public void recognizesOnlyHttpAndHttpsNavigationTargets() {
        assertTrue(ServerAddress.isHttpOrHttps("https://yawf.example/help"));
        assertTrue(ServerAddress.isHttpOrHttps("http://192.168.1.20:43110"));
        assertFalse(ServerAddress.isHttpOrHttps("intent://open/player"));
        assertFalse(ServerAddress.isHttpOrHttps("javascript:alert(1)"));
        assertFalse(ServerAddress.isHttpOrHttps("not a URL"));
    }
}
