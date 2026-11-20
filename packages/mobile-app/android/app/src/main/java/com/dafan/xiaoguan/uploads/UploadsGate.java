package com.dafan.xiaoguan.uploads;

import com.dafan.xiaoguan.security.GateState;
import com.dafan.xiaoguan.security.GateStore;

import java.io.File;
import java.io.IOException;
import java.util.Locale;

/**
 * Pure-Java gate for {@code /uploads/*} reads.
 *
 * <p>Order of checks: path shape (403), pending wipe (403), locked PIN (401), then a local
 * filesystem lookup that yields 200 (streamed later) or a fast 404. No network call happens here, so
 * a missing file can never block on connectivity.</p>
 *
 * <p>When it is not an uploads request at all the decision is {@code DELEGATE} and Capacitor keeps
 * handling the request. A {@code null} origin means the app origin could not be resolved; uploads
 * requests then fail closed instead of being served.</p>
 */
public final class UploadsGate {

    private final GateStore gateStore;
    private final File uploadsRoot;
    private final AppOrigin appOrigin;

    public UploadsGate(GateStore gateStore, File uploadsRoot, AppOrigin appOrigin) {
        this.gateStore = gateStore;
        this.uploadsRoot = uploadsRoot;
        this.appOrigin = appOrigin;
    }

    /**
     * @param scheme request scheme
     * @param host request host
     * @param port request port, or -1 when absent
     * @param encodedPath raw path ({@code Uri.getEncodedPath()})
     * @param decodedPath path decoded once by the platform ({@code Uri.getPath()})
     */
    public UploadsDecision decide(String scheme, String host, int port, String encodedPath, String decodedPath) {
        boolean uploadsPath = UploadsPathPolicy.isUploadsScope(encodedPath) || UploadsPathPolicy.isUploadsScope(decodedPath);
        if (!uploadsPath) {
            return UploadsDecision.delegate();
        }
        if (appOrigin == null || !appOrigin.matches(scheme, host, port)) {
            // An uploads path from an unknown or foreign origin is never served.
            return UploadsDecision.forbidden();
        }

        String relative = UploadsPathPolicy.toRelativePath(encodedPath, decodedPath);
        if (relative == null) {
            return UploadsDecision.forbidden();
        }

        GateState state = gateStore.get();
        if (state.lockedPendingWipe()) {
            return UploadsDecision.forbidden();
        }
        if (state.pinRequired() && !state.pinUnlocked()) {
            return UploadsDecision.unauthorized();
        }

        File file = resolve(relative);
        if (file == null) {
            return UploadsDecision.notFound();
        }
        return UploadsDecision.file(file, mimeTypeFor(relative));
    }

    /**
     * Resolves a validated relative path inside the uploads root.
     *
     * @return the readable regular file, or {@code null} when it does not exist or escapes the root
     */
    public File resolve(String relativePath) {
        if (relativePath == null || relativePath.isEmpty()) return null;
        try {
            File root = uploadsRoot.getCanonicalFile();
            File candidate = new File(root, relativePath).getCanonicalFile();
            String rootPath = root.getPath();
            String candidatePath = candidate.getPath();
            String separator = File.separator;
            String prefix = rootPath.endsWith(separator) ? rootPath : rootPath + separator;
            if (!candidatePath.startsWith(prefix)) {
                return null;
            }
            if (!candidate.isFile() || !candidate.canRead()) return null;
            return candidate;
        } catch (IOException | SecurityException ex) {
            return null;
        }
    }

    public static String mimeTypeFor(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }
}
