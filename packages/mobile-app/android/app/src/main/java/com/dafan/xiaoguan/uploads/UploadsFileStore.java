package com.dafan.xiaoguan.uploads;

import android.os.Build;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * Crash-safe file IO over {@code SecurityRuntime.uploadsDirectory()}.
 *
 * <p>This is the same directory the WebView image interceptor serves from, so anything written
 * here is immediately readable through {@code /uploads/<name>} (subject to the gate).</p>
 *
 * <p>Atomic boundary: bytes land in a sibling {@code .tmp} file which is flushed and fsynced
 * before an atomic rename over the target. A crash can leave the tmp file behind but never a
 * half-written final file. All paths are relative names inside the uploads root; traversal
 * (absolute paths, {@code \}, {@code ..}) is rejected before any filesystem call.</p>
 */
public final class UploadsFileStore {

    private static final int MAX_FILE_BYTES = 20 * 1024 * 1024;
    private static final int MAX_TOTAL_BYTES = 128 * 1024 * 1024;

    private final File root;

    public UploadsFileStore(File root) {
        this.root = root;
    }

    /** Validates a relative path and returns its file inside the uploads root, or null. */
    File resolve(String relative) {
        if (relative == null || relative.isEmpty() || relative.length() > 200) return null;
        if (relative.startsWith("/") || relative.indexOf('\\') >= 0) return null;
        String[] segments = relative.split("/", -1);
        File current = root;
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) return null;
            for (int i = 0; i < segment.length(); i++) {
                char ch = segment.charAt(i);
                boolean allowed =
                    (ch >= 'a' && ch <= 'z') ||
                    (ch >= 'A' && ch <= 'Z') ||
                    (ch >= '0' && ch <= '9') ||
                    ch == '.' || ch == '_' || ch == '-';
                if (!allowed) return null;
            }
            current = new File(current, segment);
        }
        try {
            File canonicalRoot = root.getCanonicalFile();
            File candidate = current.getCanonicalFile();
            String prefix = canonicalRoot.getPath() + File.separator;
            if (!candidate.getPath().startsWith(prefix)) return null;
            return candidate;
        } catch (IOException ex) {
            return null;
        }
    }

    /** Writes bytes atomically (temp + fsync + rename). Creates parent directories. */
    public void write(String relative, byte[] data) throws IOException {
        if (data == null || data.length == 0) {
            throw new IOException("Upload file content must not be empty");
        }
        if (data.length > MAX_FILE_BYTES) {
            throw new IOException("Upload file exceeds the per-file size limit");
        }
        File target = resolve(relative);
        if (target == null) {
            throw new IOException("Illegal uploads path: " + relative);
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Unable to create the uploads directory");
        }
        File temp = new File(parent, target.getName() + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(temp, false)) {
                out.write(data);
                out.getFD().sync();
            }
            if (!temp.renameTo(target)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O || File.separatorChar == '\\') {
                    Files.move(temp.toPath(), target.toPath(),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } else {
                    throw new IOException("Unable to commit the upload file");
                }
            }
        } finally {
            if (temp.exists() && !temp.delete()) {
                // Best effort: a leftover tmp never becomes a readable uploads file.
            }
        }
    }

    /** Reads the whole file; returns null when it does not exist. */
    public byte[] read(String relative) throws IOException {
        File file = resolve(relative);
        if (file == null || !file.isFile()) return null;
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
            long size = file.length();
            if (size > MAX_FILE_BYTES) throw new IOException("Upload file exceeds the per-file size limit");
            byte[] data = new byte[(int) size];
            input.readFully(data);
            if (input.read() != -1) throw new IOException("The upload changed while being read");
            return data;
        }
    }

    /** Recursively lists regular files under the root as relative '/'-separated paths. */
    public List<String> list() throws IOException {
        TreeSet<String> names = new TreeSet<>();
        collect(root, "", names);
        return new ArrayList<>(names);
    }

    private static void collect(File dir, String prefix, TreeSet<String> out) {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            String name = prefix.isEmpty() ? entry.getName() : prefix + "/" + entry.getName();
            if (entry.isDirectory()) collect(entry, name, out);
            else if (entry.isFile()) out.add(name);
        }
    }

    /** Existence, size and SHA-256 in one call. */
    public Stat stat(String relative) throws IOException {
        byte[] data = read(relative);
        if (data == null) return Stat.missing();
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException ex) {
            throw new IOException("SHA-256 unavailable", ex);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte b : digest.digest(data)) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return new Stat(true, data.length, hex.toString());
    }

    /** Deletes each file; a missing file counts as deleted. Returns the paths actually removed. */
    public List<String> deleteAll(List<String> relatives) throws IOException {
        List<String> deleted = new ArrayList<>();
        for (String relative : relatives) {
            File file = resolve(relative);
            if (file == null) {
                throw new IOException("Illegal uploads path: " + relative);
            }
            if (!file.exists() || file.delete()) deleted.add(relative);
        }
        return deleted;
    }

    /** True when the total uploads payload stays within the process budget. */
    public boolean withinBudget() throws IOException {
        long total = 0;
        for (String name : list()) {
            File file = resolve(name);
            if (file == null) return false;
            total += file.length();
            if (total > MAX_TOTAL_BYTES) return false;
        }
        return true;
    }

    /** Immutable stat snapshot. */
    public static final class Stat {
        private final boolean exists;
        private final long size;
        private final String sha256;

        Stat(boolean exists, long size, String sha256) {
            this.exists = exists;
            this.size = size;
            this.sha256 = sha256;
        }

        static Stat missing() {
            return new Stat(false, 0, "");
        }

        public boolean exists() {
            return exists;
        }

        public long size() {
            return size;
        }

        public String sha256() {
            return sha256;
        }
    }
}
