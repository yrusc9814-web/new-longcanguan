package com.dafan.xiaoguan.uploads;

import java.io.File;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** Coordinates directory swaps with the restore marker committed in the SQLite header. */
public final class UploadsRestore {
    private final File live;
    private final File work;
    private final File staged;
    private final File previous;
    private final File marker;

    public UploadsRestore(File live) {
        this.live = live;
        this.work = new File(live.getParentFile(), "uploads-restore");
        this.staged = new File(work, "staged");
        this.previous = new File(work, "previous");
        this.marker = new File(work, "marker");
    }

    public boolean isReplacing() {
        return marker.isFile();
    }

    public void prepare() throws IOException {
        if (isReplacing() || previous.exists()) throw new IOException("An earlier restore needs recovery");
        ensureDirectory(work);
        deleteTree(staged);
        ensureDirectory(staged);
    }

    public void write(String path, byte[] bytes) throws IOException {
        if (isReplacing() || !staged.isDirectory()) throw new IOException("No writable restore stage");
        new UploadsFileStore(staged).write(path, bytes);
    }

    public void activate(int restoreId) throws IOException {
        if (restoreId <= 0 || isReplacing() || !staged.isDirectory() || previous.exists()) {
            throw new IOException("No prepared restore stage");
        }
        ensureDirectory(live);
        File tmp = new File(work, "marker.tmp");
        try (FileOutputStream stream = new FileOutputStream(tmp)) {
            new DataOutputStream(stream).writeInt(restoreId);
            stream.getFD().sync();
        }
        move(tmp, marker);
        move(live, previous);
        move(staged, live);
    }

    public void recover(int committedId) throws IOException {
        if (isReplacing()) {
            int restoreId;
            try (DataInputStream in = new DataInputStream(new FileInputStream(marker))) {
                restoreId = in.readInt();
            }
            if (restoreId == committedId) {
                if (!live.isDirectory() && staged.isDirectory()) move(staged, live);
                if (!live.isDirectory()) throw new IOException("Committed uploads directory is missing");
                deleteTree(previous);
            } else if (previous.isDirectory()) {
                deleteTree(live);
                move(previous, live);
            }
            deleteTree(marker);
        }
        deleteTree(staged);
        deleteTree(new File(work, "marker.tmp"));
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Unable to create uploads restore directory");
        }
    }

    private static void move(File from, File to) throws IOException {
        if (!from.renameTo(to)) throw new IOException("Unable to rename uploads restore entry");
    }

    private static void deleteTree(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (file.exists() && !file.delete()) throw new IOException("Unable to clean up uploads restore entry");
    }
}
