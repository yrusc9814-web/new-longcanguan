package com.dafan.xiaoguan.uploads;

import java.util.Locale;

/** Origin triple used to decide whether a WebView request belongs to the app itself. */
public final class AppOrigin {

    private final String scheme;
    private final String host;
    private final int port;

    public AppOrigin(String scheme, String host, int port) {
        String normalizedScheme = scheme == null ? "" : scheme.toLowerCase(Locale.ROOT);
        this.scheme = normalizedScheme;
        this.host = host == null ? "" : host.toLowerCase(Locale.ROOT);
        this.port = normalizePort(normalizedScheme, port);
    }

    public String scheme() {
        return scheme;
    }

    public String host() {
        return host;
    }

    public int port() {
        return port;
    }

    public boolean matches(String candidateScheme, String candidateHost, int candidatePort) {
        if (candidateScheme == null || candidateHost == null) return false;
        String normalizedScheme = candidateScheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals(normalizedScheme)) return false;
        if (!host.equals(candidateHost.toLowerCase(Locale.ROOT))) return false;
        return port == normalizePort(normalizedScheme, candidatePort);
    }

    private static int normalizePort(String scheme, int port) {
        if (port > 0) return port;
        if ("http".equals(scheme)) return 80;
        if ("https".equals(scheme)) return 443;
        return -1;
    }
}
