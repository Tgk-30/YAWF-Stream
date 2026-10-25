package com.yawf.stream.tv;

import androidx.media3.common.MimeTypes;

final class PlaybackContentType {
    private PlaybackContentType() {}

    static String normalize(String value) {
        if (value == null || value.isEmpty()) return null;
        String trimmed = value.trim();
        if (
            trimmed.length() > 120 ||
            !trimmed.matches("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")
        ) {
            throw new IllegalArgumentException("Invalid playback content type.");
        }
        if (
            MimeTypes.APPLICATION_M3U8.equalsIgnoreCase(trimmed) ||
            "application/vnd.apple.mpegurl".equalsIgnoreCase(trimmed)
        ) {
            return MimeTypes.APPLICATION_M3U8;
        }
        return trimmed;
    }
}
