package com.yawf.stream.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import androidx.media3.common.MimeTypes;

import org.junit.Test;

public final class PlaybackContentTypeTest {
    @Test
    public void normalizesAppleAndCanonicalHlsMimeTypesForMedia3() {
        assertEquals(
            MimeTypes.APPLICATION_M3U8,
            PlaybackContentType.normalize("application/vnd.apple.mpegurl")
        );
        assertEquals(
            MimeTypes.APPLICATION_M3U8,
            PlaybackContentType.normalize(MimeTypes.APPLICATION_M3U8)
        );
        assertEquals(
            MimeTypes.APPLICATION_M3U8,
            PlaybackContentType.normalize("APPLICATION/VND.APPLE.MPEGURL")
        );
        assertEquals(
            MimeTypes.APPLICATION_M3U8,
            PlaybackContentType.normalize("APPLICATION/X-MPEGURL")
        );
    }

    @Test
    public void preservesNullEmptyAndNonHlsMimeTypes() {
        assertNull(PlaybackContentType.normalize(null));
        assertNull(PlaybackContentType.normalize(""));
        assertEquals("video/mp4", PlaybackContentType.normalize("video/mp4"));
        assertEquals("Video/MP4", PlaybackContentType.normalize("  Video/MP4  "));
    }

    @Test
    public void keepsStrictLengthSyntaxAndCrlfValidation() {
        for (String invalid : new String[] {
            " ",
            "not-a-mime",
            "video/mp4; charset=utf-8",
            "video/mp4\r\nAuthorization: Bearer injected",
            "application/" + "a".repeat(109)
        }) {
            assertThrows(
                IllegalArgumentException.class,
                () -> PlaybackContentType.normalize(invalid)
            );
        }
    }
}
