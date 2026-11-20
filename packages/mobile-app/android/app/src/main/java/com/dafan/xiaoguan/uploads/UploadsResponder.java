package com.dafan.xiaoguan.uploads;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Turns an {@link UploadsDecision} into an {@link UploadsResponse}.
 *
 * <p>Success responses open a {@link FileInputStream} and stream it; nothing is read into memory.
 * Error responses are fixed small bodies with no-store caching and no credential material.</p>
 */
public final class UploadsResponder {

    private static final String NO_STORE = "no-store";

    private UploadsResponder() {}

    public static UploadsResponse respond(UploadsDecision decision) {
        switch (decision.kind()) {
            case FORBIDDEN:
                return error(403, "Forbidden", "forbidden");
            case UNAUTHORIZED:
                return error(401, "Unauthorized", "unauthorized");
            case NOT_FOUND:
                return error(404, "Not Found", "not found");
            case FILE:
                return file(decision);
            case DELEGATE:
            default:
                throw new IllegalArgumentException("Delegate decisions are not responses");
        }
    }

    private static UploadsResponse file(UploadsDecision decision) {
        File file = decision.file();
        InputStream body;
        try {
            body = new FileInputStream(file);
        } catch (FileNotFoundException ex) {
            // The file vanished between the gate check and the open: still a fast local 404.
            return error(404, "Not Found", "not found");
        }

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Cache-Control", NO_STORE);
        headers.put("X-Content-Type-Options", "nosniff");
        return new UploadsResponse(200, "OK", decision.mimeType(), null, headers, body);
    }

    private static UploadsResponse error(int status, String reason, String message) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Cache-Control", NO_STORE);
        headers.put("X-Content-Type-Options", "nosniff");
        byte[] body = message.getBytes(StandardCharsets.UTF_8);
        return new UploadsResponse(status, reason, "text/plain", "utf-8", headers, new ByteArrayInputStream(body));
    }
}
