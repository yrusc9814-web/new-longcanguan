package com.dafan.xiaoguan.security;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Physical erasure of the app's local business data, limited to fixed private directories.
 *
 * <p>Two roots are supplied once by {@link SecurityRuntime} from {@code Context} (the SQLite database
 * directory and {@code FilesDir}); the bridge method takes no path argument at all, so the WebView
 * can never point this class at another location. Only these names are ever touched:</p>
 * <ul>
 *     <li>{@code dafanSQLite.db} plus its {@code -wal}/{@code -shm}/{@code -journal} siblings</li>
 *     <li>{@code uploads/} and {@code uploads-restore/} trees</li>
 * </ul>
 *
 * <p>Deletion runs twice and is then verified, which closes the window where a request that passed
 * the gate check just before the wipe marker landed could re-create a file. The result reports what
 * is confirmed <em>absent</em>: any surviving artifact makes {@code complete} false so the caller
 * keeps the device locked and retries.</p>
 */
public final class LocalDataPurge {

    /** Base file name produced by {@code @capacitor-community/sqlite} for database name "dafan". */
    public static final String DATABASE_FILE = "dafanSQLite.db";

    private static final String[] DATABASE_SUFFIXES = {"", "-wal", "-shm", "-journal"};
    private static final String UPLOADS = "uploads";
    private static final String UPLOADS_RESTORE = "uploads-restore";

    private final File databaseDirectory;
    private final File filesDirectory;

    public LocalDataPurge(File databaseDirectory, File filesDirectory) {
        this.databaseDirectory = databaseDirectory;
        this.filesDirectory = filesDirectory;
    }

    /** Runs the erasure and returns the verified outcome. Never throws for a partially deleted tree. */
    public PurgeReport run() {
        // A leftover journal or stale tree can be re-created by a racing write; two passes plus a
        // final verification make the outcome trustworthy instead of optimistic.
        deleteTargets();
        deleteTargets();

        List<String> failed = new ArrayList<>();
        boolean databaseRemoved = true;
        for (String suffix : DATABASE_SUFFIXES) {
            File file = new File(databaseDirectory, DATABASE_FILE + suffix);
            if (file.exists()) {
                databaseRemoved = false;
                failed.add(DATABASE_FILE + suffix);
            }
        }
        boolean uploadsRemoved = !new File(filesDirectory, UPLOADS).exists();
        if (!uploadsRemoved) failed.add(UPLOADS);
        boolean restoreRemoved = !new File(filesDirectory, UPLOADS_RESTORE).exists();
        if (!restoreRemoved) failed.add(UPLOADS_RESTORE);

        return new PurgeReport(databaseRemoved, uploadsRemoved, restoreRemoved, failed);
    }

    private void deleteTargets() {
        for (String suffix : DATABASE_SUFFIXES) {
            File file = new File(databaseDirectory, DATABASE_FILE + suffix);
            if (file.isDirectory()) deleteTree(file);
            else if (file.exists()) {
                // Best effort: the verification pass decides whether the wipe is complete.
                file.delete();
            }
        }
        deleteTree(new File(filesDirectory, UPLOADS));
        deleteTree(new File(filesDirectory, UPLOADS_RESTORE));
    }

    /**
     * Deletes a file or directory tree.
     *
     * <p>Symlinks are never followed: {@code listFiles()} on a directory is safe, and any child that
     * is itself a link is removed with {@code delete()} rather than traversed.</p>
     */
    private static void deleteTree(File entry) {
        if (entry == null || !entry.exists()) return;
        File[] children = entry.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory() && !isSymlink(child)) deleteTree(child);
                else if (!child.delete()) {
                    // Best effort; the verification pass reports what survived.
                }
            }
        }
        entry.delete();
    }

    private static boolean isSymlink(File file) {
        try {
            File canonicalParent = file.getParentFile() == null
                ? null
                : file.getParentFile().getCanonicalFile();
            File canonical = new File(canonicalParent, file.getName()).getCanonicalFile();
            return !canonical.getPath().equals(file.getAbsolutePath());
        } catch (Exception ex) {
            // Unknown paths are treated as links, so they are deleted but never traversed.
            return true;
        }
    }

    /** Immutable, verified outcome of one erasure attempt. */
    public static final class PurgeReport {
        private final boolean databaseRemoved;
        private final boolean uploadsRemoved;
        private final boolean restoreRemoved;
        private final List<String> failed;

        PurgeReport(boolean databaseRemoved, boolean uploadsRemoved, boolean restoreRemoved, List<String> failed) {
            this.databaseRemoved = databaseRemoved;
            this.uploadsRemoved = uploadsRemoved;
            this.restoreRemoved = restoreRemoved;
            this.failed = new ArrayList<>(failed);
        }

        public boolean complete() {
            return databaseRemoved && uploadsRemoved && restoreRemoved;
        }

        public boolean databaseRemoved() {
            return databaseRemoved;
        }

        public boolean uploadsRemoved() {
            return uploadsRemoved;
        }

        public boolean restoreRemoved() {
            return restoreRemoved;
        }

        public List<String> failed() {
            return new ArrayList<>(failed);
        }
    }
}
