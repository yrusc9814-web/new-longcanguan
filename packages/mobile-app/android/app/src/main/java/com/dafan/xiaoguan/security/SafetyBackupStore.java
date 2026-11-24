package com.dafan.xiaoguan.security;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Private store for the epoch safety backups.
 *
 * <p>Backups deliberately live outside {@code FilesDir/uploads/} and outside
 * {@code FilesDir/uploads-restore/}: a whole-database restore (which swaps the uploads tree) must
 * never be able to delete or overwrite them. They stay inside {@code FilesDir/safety-backups/} so
 * the revocation purge can erase them together with the rest of the local business data.</p>
 *
 * <p>Names are validated against a fixed shape ({@code [A-Za-z0-9._-]+.zip}), so the WebView can
 * never steer a write outside the directory. Bytes are committed through {@link AtomicFiles}.</p>
 */
public final class SafetyBackupStore {

    /** Relative directory name used by the JS contract. */
    public static final String DIRECTORY = "safety-backups";

    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9._-]{1,120}\\.zip");
    private static final long MAX_BACKUP_BYTES = 64L * 1024 * 1024;

    private final File root;

    public SafetyBackupStore(File root) {
        this.root = root;
    }

    public File directory() {
        return root;
    }

    /** @return the file that was written */
    public File write(String name, byte[] data) throws IOException {
        if (name == null || !NAME.matcher(name).matches()) {
            throw new IOException("Illegal safety backup name");
        }
        if (data == null || data.length == 0 || data.length > MAX_BACKUP_BYTES) {
            throw new IOException("Illegal safety backup content");
        }
        File target = new File(root, name);
        AtomicFiles.writeSync(target, data);
        return target;
    }

    /** @return names of the backups currently stored, sorted, never a path */
    public List<String> list() {
        List<String> names = new ArrayList<>();
        String[] entries = root.list();
        if (entries == null) return names;
        for (String entry : entries) {
            if (NAME.matcher(entry).matches() && new File(root, entry).isFile()) names.add(entry);
        }
        java.util.Collections.sort(names);
        return names;
    }

    /** Removes every backup (used when the whole safety backup tree must be dropped). */
    public void deleteAll() throws IOException {
        File[] entries = root.listFiles();
        if (entries != null) {
            for (File entry : entries) {
                if (!entry.delete()) throw new IOException("Unable to delete a safety backup");
            }
        }
        if (root.exists() && !root.delete()) throw new IOException("Unable to delete the safety backups");
    }
}
