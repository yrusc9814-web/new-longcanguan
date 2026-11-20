package com.dafan.xiaoguan.security;

import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Synchronous, crash-safe file IO for small security records.
 *
 * <p>Writes go to a sibling temp file which is flushed and synced before being renamed over the
 * target, so a crash never leaves a half-written record. Renaming within one directory is atomic on
 * the filesystems used for app-private storage. Older Android versions use the native rename.</p>
 */
final class AtomicFiles {

    private static final int MAX_READ_BYTES = 64 * 1024;

    private AtomicFiles() {}

    static void writeSync(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Unable to create the parent directory");
        }

        File temp = new File(parent, target.getName() + ".tmp");
        try {
            try (FileOutputStream out = new FileOutputStream(temp, false)) {
                out.write(data);
                out.getFD().sync();
            }
            if (!temp.renameTo(target)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O || File.separatorChar == '\\') {
                    java.nio.file.Files.move(temp.toPath(), target.toPath(),
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                } else {
                    throw new IOException("Unable to commit the security record");
                }
            }
        } finally {
            deleteQuietly(temp);
        }
    }

    static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_READ_BYTES) {
                    throw new IOException("Security record is too large");
                }
            }
            return out.toByteArray();
        }
    }

    private static void deleteQuietly(File file) {
        if (file.exists() && !file.delete()) {
            // Best effort only.
        }
    }
}
