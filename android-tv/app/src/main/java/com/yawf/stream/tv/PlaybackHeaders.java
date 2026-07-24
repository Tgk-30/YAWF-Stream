package com.yawf.stream.tv;

import java.util.LinkedHashMap;
import java.util.Map;

final class PlaybackHeaders {
    private static final int MAX_COOKIE_VALUE_LENGTH = 4_096;
    private static final int MAX_COOKIE_HEADER_LENGTH = 8_192;
    private static final String[] ALLOWED_COOKIE_NAMES = {
        "CF_Authorization",
        "CF_Session",
        "CF_AppSession",
    };

    private PlaybackHeaders() {}

    static String cloudflareCookieHeader(String rawCookieHeader) {
        if (rawCookieHeader == null || rawCookieHeader.isEmpty()) return null;

        Map<String, String> allowedValues = new LinkedHashMap<>();
        for (String segment : rawCookieHeader.split(";")) {
            int separator = segment.indexOf('=');
            if (separator <= 0) continue;

            String name = segment.substring(0, separator).trim();
            String value = segment.substring(separator + 1).trim();
            if (
                !isAllowedCookieName(name) ||
                allowedValues.containsKey(name) ||
                !isSafeCookieValue(value)
            ) {
                continue;
            }
            allowedValues.put(name, value);
        }

        StringBuilder result = new StringBuilder();
        for (String name : ALLOWED_COOKIE_NAMES) {
            String value = allowedValues.get(name);
            if (value == null) continue;

            String cookie = name + "=" + value;
            int nextLength = result.length() +
                (result.length() == 0 ? 0 : 2) +
                cookie.length();
            if (nextLength > MAX_COOKIE_HEADER_LENGTH) continue;
            if (result.length() > 0) result.append("; ");
            result.append(cookie);
        }
        return result.length() == 0 ? null : result.toString();
    }

    private static boolean isAllowedCookieName(String name) {
        for (String allowed : ALLOWED_COOKIE_NAMES) {
            if (allowed.equals(name)) return true;
        }
        return false;
    }

    private static boolean isSafeCookieValue(String value) {
        if (
            value.isEmpty() ||
            value.length() > MAX_COOKIE_VALUE_LENGTH
        ) {
            return false;
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (
                character < 0x21 ||
                character > 0x7e ||
                character == '"' ||
                character == ',' ||
                character == ';' ||
                character == '\\'
            ) {
                return false;
            }
        }
        return true;
    }
}
