package com.dafan.xiaoguan.uploads;

import java.io.InputStream;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Framework-free description of an intercepted response.
 *
 * <p>Keeping this plain Java lets the unit tests assert status codes, headers and stream contents
 * without an Android WebView. Credentials never appear in bodies or headers here.</p>
 */
public final class UploadsResponse {

    private final int statusCode;
    private final String reasonPhrase;
    private final String mimeType;
    private final String encoding;
    private final Map<String, String> headers;
    private final InputStream body;

    UploadsResponse(int statusCode, String reasonPhrase, String mimeType, String encoding, Map<String, String> headers, InputStream body) {
        this.statusCode = statusCode;
        this.reasonPhrase = reasonPhrase;
        this.mimeType = mimeType;
        this.encoding = encoding;
        this.headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
        this.body = body;
    }

    public int statusCode() {
        return statusCode;
    }

    public String reasonPhrase() {
        return reasonPhrase;
    }

    public String mimeType() {
        return mimeType;
    }

    public String encoding() {
        return encoding;
    }

    public Map<String, String> headers() {
        return headers;
    }

    public InputStream body() {
        return body;
    }

    @Override
    public String toString() {
        return "UploadsResponse{" + statusCode + ' ' + reasonPhrase + ", mimeType=" + mimeType + '}';
    }
}
