package com.dafan.xiaoguan.uploads;

import java.util.Locale;

/**
 * Pure-Java validation of {@code /uploads/*} paths coming from the WebView.
 *
 * <p>The encoded path is decoded exactly once by this class. The caller must also pass the decoded
 * path reported by {@link android.net.Uri#getPath()}; if the two disagree the request is rejected,
 * which removes the double-decoding ambiguity that lets {@code %252e} style payloads through one
 * layer but not another.</p>
 *
 * <p>Rejected outright: traversal segments, backslashes, empty segments (including {@code //}),
 * dot segments, non image extensions, control characters and non-ASCII bytes.</p>
 */
public final class UploadsPathPolicy {

    public static final String PREFIX = "/uploads/";

    private static final String[] ALLOWED_EXTENSIONS = { ".jpg", ".jpeg", ".png", ".webp" };

    private UploadsPathPolicy() {}

    /** True when the encoded path is inside the uploads scope. Cheap pre-filter. */
    public static boolean isUploadsPath(String encodedPath) {
        return encodedPath != null && encodedPath.startsWith(PREFIX);
    }

    /**
     * Broader scope check used before validation.
     *
     * <p>Anything opening with the {@code uploads} path segment is in scope, including malformed
     * variants such as {@code /uploads\..\a.png} or {@code /uploads%5ca.png}. Those must be rejected
     * rather than delegated, otherwise a backslash form could reach another handler.</p>
     */
    public static boolean isUploadsScope(String path) {
        if (path == null || path.length() <= "/uploads".length() || !path.startsWith("/uploads")) {
            return false;
        }
        char next = path.charAt("/uploads".length());
        return next == '/' || next == '\\' || next == '%';
    }

    /**
     * Validates the request path and returns the relative path under the uploads root.
     *
     * @param encodedPath the raw path as sent by the WebView ({@code Uri.getEncodedPath()})
     * @param uriDecodedPath the decoded path reported by {@code Uri.getPath()}
     * @return relative path, or {@code null} when the request must be rejected
     */
    public static String toRelativePath(String encodedPath, String uriDecodedPath) {
        if (!isUploadsPath(encodedPath)) {
            return null;
        }

        String decoded = strictDecode(encodedPath);
        if (decoded == null || !decoded.startsWith(PREFIX)) {
            return null;
        }
        // Any disagreement between our single decode and the platform decode is ambiguous.
        if (uriDecodedPath == null || !decoded.equals(uriDecodedPath)) {
            return null;
        }

        String relative = decoded.substring(PREFIX.length());
        if (relative.isEmpty() || relative.indexOf('\\') >= 0 || relative.indexOf("..") >= 0) {
            return null;
        }

        String[] segments = relative.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                return null;
            }
            if (!isAllowedSegment(segment)) {
                return null;
            }
        }

        String fileName = segments[segments.length - 1];
        if (!hasAllowedImageExtension(fileName)) {
            return null;
        }
        return relative;
    }

    /**
     * Strict single-pass percent decoding.
     *
     * <p>Escapes are only accepted when they decode to an ordinary filename character. Structural
     * characters ({@code . / \\ %}) and non-ASCII bytes must appear literally or not at all: that
     * removes every way an encoded segment could become a separator, a dot segment or a second
     * decoding step.</p>
     *
     * @return decoded text, or {@code null} for malformed or structural escapes
     */
    static String strictDecode(String encoded) {
        StringBuilder out = new StringBuilder(encoded.length());
        for (int i = 0; i < encoded.length(); i++) {
            char ch = encoded.charAt(i);
            if (ch == '%') {
                if (i + 2 >= encoded.length()) return null;
                int high = hexValue(encoded.charAt(i + 1));
                int low = hexValue(encoded.charAt(i + 2));
                if (high < 0 || low < 0) return null;
                ch = (char) ((high << 4) | low);
                i += 2;
                if (!isPlainNameChar(ch)) return null;
            }
            if (ch == '\\' || ch <= 0x1F || ch >= 0x7F) return null;
            out.append(ch);
        }
        return out.toString();
    }

    private static boolean isPlainNameChar(char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    }

    private static int hexValue(char ch) {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
        if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
        return -1;
    }

    private static boolean isAllowedSegment(String segment) {
        for (int i = 0; i < segment.length(); i++) {
            char ch = segment.charAt(i);
            boolean allowed =
                (ch >= 'a' && ch <= 'z') ||
                (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') ||
                ch == '.' ||
                ch == '_' ||
                ch == '-';
            if (!allowed) return false;
        }
        return true;
    }

    private static boolean hasAllowedImageExtension(String fileName) {
        String lower = fileName.toLowerCase(Locale.ROOT);
        for (String extension : ALLOWED_EXTENSIONS) {
            if (lower.endsWith(extension) && lower.length() > extension.length()) {
                return true;
            }
        }
        return false;
    }
}
