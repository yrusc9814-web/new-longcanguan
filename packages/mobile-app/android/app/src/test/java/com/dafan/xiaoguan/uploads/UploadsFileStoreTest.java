package com.dafan.xiaoguan.uploads;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Unit tests for the crash-safe uploads file store (temp+fsync+rename, path hardening). */
public class UploadsFileStoreTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File root;
    private UploadsFileStore store;

    @Before
    public void setUp() throws IOException {
        root = folder.newFolder("uploads");
        store = new UploadsFileStore(root);
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void writeThenReadRoundTripsBytes() throws IOException {
        byte[] payload = bytes("hello webp");
        store.write("main-abc.webp", payload);
        assertArrayEquals(payload, store.read("main-abc.webp"));
        UploadsFileStore.Stat stat = store.stat("main-abc.webp");
        assertTrue(stat.exists());
        assertEquals(payload.length, stat.size());
        assertEquals(sha256Hex(payload), stat.sha256());
    }

    @Test
    public void writeIsAtomicReplaceOfExistingContent() throws IOException {
        store.write("thumb-x.webp", bytes("v1"));
        store.write("thumb-x.webp", bytes("second-version"));
        assertArrayEquals(bytes("second-version"), store.read("thumb-x.webp"));
        // No leftover tmp files after successful writes.
        File[] entries = root.listFiles();
        assertEquals(1, entries.length);
        assertEquals("thumb-x.webp", entries[0].getName());
    }

    @Test
    public void readMissingFileReturnsNull() throws IOException {
        assertNull(store.read("absent.webp"));
        assertFalse(store.stat("absent.webp").exists());
    }

    @Test
    public void traversalPathsAreRejected() throws IOException {
        List<String> illegal = Arrays.asList(
            "../escape.webp",
            "sub/../escape.webp",
            "/absolute.webp",
            "back\\slash.webp",
            "with space.webp",
            "",
            null
        );
        for (String path : illegal) {
            assertThrows(IOException.class, () -> store.write(path, bytes("x")));
            assertNull(store.read(path));
        }
    }

    @Test
    public void emptyContentIsRejected() {
        assertThrows(IOException.class, () -> store.write("empty.webp", new byte[0]));
        assertThrows(IOException.class, () -> store.write("empty.webp", null));
    }

    @Test
    public void listReturnsRelativeSortedPaths() throws IOException {
        store.write("b-second.webp", bytes("2"));
        store.write("a-first/inner.webp", bytes("3"));
        store.write("a-first/aa-first.webp", bytes("1"));
        assertEquals(
            Arrays.asList("a-first/aa-first.webp", "a-first/inner.webp", "b-second.webp"),
            store.list());
        assertTrue(store.withinBudget());
    }

    @Test
    public void deleteRemovesOnlyNamedFiles() throws IOException {
        store.write("keep.webp", bytes("k"));
        store.write("drop.webp", bytes("d"));
        List<String> deleted = store.deleteAll(Collections.singletonList("drop.webp"));
        assertEquals(Collections.singletonList("drop.webp"), deleted);
        assertNull(store.read("drop.webp"));
        assertArrayEquals(bytes("k"), store.read("keep.webp"));
        // Deleting a missing path is idempotent.
        assertEquals(Collections.singletonList("drop.webp"), store.deleteAll(Collections.singletonList("drop.webp")));
    }

    @Test
    public void crashDuringWriteNeverExposesPartialTarget() throws Exception {
        // Simulate a crash between temp creation and rename: only the tmp file exists.
        File target = new File(root, "crash.webp");
        File temp = new File(root, "crash.webp.tmp");
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            out.write(bytes("half-written"));
        }
        assertNull(store.read("crash.webp"));
        assertFalse(target.exists());
        assertTrue(temp.exists());
        // A later successful write cleans the scene: rename overwrites and the tmp is gone.
        store.write("crash.webp", bytes("recovered"));
        assertArrayEquals(bytes("recovered"), store.read("crash.webp"));
        File[] entries = root.listFiles();
        assertEquals(1, entries.length);
    }

    @Test
    public void fsyncedTempSurvivesAndRenamesAtomically() throws Exception {
        byte[] payload = bytes("durable");
        File target = new File(root, "durable.webp");
        // Directly exercise the documented boundary: write temp, fsync, rename.
        File temp = new File(root, "durable.webp.tmp");
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            out.write(payload);
            out.getFD().sync();
        }
        Files.move(temp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        assertArrayEquals(payload, store.read("durable.webp"));
        assertEquals(sha256Hex(payload), store.stat("durable.webp").sha256());
    }

    @Test
    public void interruptedSwapUsesSqliteCommitMarkerOnRestart() throws IOException {
        store.write("same.webp", bytes("old"));
        store.write("stale.webp", bytes("stale"));
        UploadsRestore restore = new UploadsRestore(root);
        restore.prepare();
        restore.write("same.webp", bytes("uncommitted"));
        restore.activate(7);
        assertTrue(restore.isReplacing());

        new UploadsRestore(root).recover(6);
        assertArrayEquals(bytes("old"), store.read("same.webp"));
        assertArrayEquals(bytes("stale"), store.read("stale.webp"));
        assertFalse(restore.isReplacing());

        restore.prepare();
        restore.write("same.webp", bytes("committed"));
        restore.activate(7);
        new UploadsRestore(root).recover(7);
        new UploadsRestore(root).recover(7);
        assertArrayEquals(bytes("committed"), store.read("same.webp"));
        assertNull(store.read("stale.webp"));
        assertFalse(restore.isReplacing());
    }

    private static String sha256Hex(byte[] data) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            StringBuilder hex = new StringBuilder(data.length * 2);
            for (byte b : digest.digest(data)) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
