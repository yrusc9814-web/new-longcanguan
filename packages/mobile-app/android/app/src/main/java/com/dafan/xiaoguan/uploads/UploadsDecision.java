package com.dafan.xiaoguan.uploads;

import java.io.File;

/** Immutable decision for a single WebView request handled by the uploads gate. */
public final class UploadsDecision {

    public enum Kind {
        /** Not an app-origin uploads request; hand it back to Capacitor. */
        DELEGATE,
        /** Malformed path or a wipe is pending. */
        FORBIDDEN,
        /** PIN required and not unlocked in this process. */
        UNAUTHORIZED,
        /** Path is well formed but the file does not exist. */
        NOT_FOUND,
        /** Resolved file, stream it without buffering it in memory. */
        FILE
    }

    private final Kind kind;
    private final File file;
    private final String mimeType;

    private UploadsDecision(Kind kind, File file, String mimeType) {
        this.kind = kind;
        this.file = file;
        this.mimeType = mimeType;
    }

    static UploadsDecision delegate() {
        return new UploadsDecision(Kind.DELEGATE, null, null);
    }

    static UploadsDecision forbidden() {
        return new UploadsDecision(Kind.FORBIDDEN, null, null);
    }

    static UploadsDecision unauthorized() {
        return new UploadsDecision(Kind.UNAUTHORIZED, null, null);
    }

    static UploadsDecision notFound() {
        return new UploadsDecision(Kind.NOT_FOUND, null, null);
    }

    static UploadsDecision file(File file, String mimeType) {
        return new UploadsDecision(Kind.FILE, file, mimeType);
    }

    public Kind kind() {
        return kind;
    }

    public File file() {
        return file;
    }

    public String mimeType() {
        return mimeType;
    }

    public int statusCode() {
        switch (kind) {
            case FORBIDDEN:
                return 403;
            case UNAUTHORIZED:
                return 401;
            case NOT_FOUND:
                return 404;
            case FILE:
                return 200;
            default:
                return 0;
        }
    }

    public boolean isUploadsRequest() {
        return kind != Kind.DELEGATE;
    }

    @Override
    public String toString() {
        return "UploadsDecision{" + kind + '}';
    }
}
