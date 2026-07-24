package com.yawf.stream.tv;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class ServerAddress {
    private ServerAddress() {}

    static String normalize(String input) {
        if (input == null) return null;
        String value = input.trim();
        if (value.isEmpty()) return null;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (
                scheme == null ||
                !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) ||
                uri.getHost() == null ||
                uri.getUserInfo() != null ||
                uri.getQuery() != null ||
                uri.getFragment() != null
            ) {
                return null;
            }
            String path = uri.getPath() == null ? "" : uri.getPath();
            while (path.endsWith("/") && !path.isEmpty()) {
                path = path.substring(0, path.length() - 1);
            }
            return new URI(
                scheme.toLowerCase(Locale.ROOT),
                null,
                uri.getHost().toLowerCase(Locale.ROOT),
                uri.getPort(),
                path,
                null,
                null
            ).toString();
        } catch (URISyntaxException error) {
            return null;
        }
    }

    static boolean sameOrigin(String base, String candidate) {
        try {
            URI left = new URI(base);
            URI right = new URI(candidate);
            return left.getScheme().equalsIgnoreCase(right.getScheme()) &&
                left.getHost().equalsIgnoreCase(right.getHost()) &&
                effectivePort(left) == effectivePort(right);
        } catch (RuntimeException | URISyntaxException error) {
            return false;
        }
    }

    static boolean isHttpOrHttps(String candidate) {
        try {
            URI uri = new URI(candidate);
            String scheme = uri.getScheme();
            return scheme != null &&
                (scheme.equalsIgnoreCase("http") ||
                    scheme.equalsIgnoreCase("https")) &&
                uri.getHost() != null;
        } catch (RuntimeException | URISyntaxException error) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return uri.getScheme().equalsIgnoreCase("https") ? 443 : 80;
    }
}
