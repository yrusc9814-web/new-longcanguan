package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

/**
 * Unit tests for the private safety backup tree.
 *
 * <p>Two invariants matter: the tree is separate from {@code uploads/} (an uploads restore swap must
 * never delete or replace a backup) and names are validated (the WebView never supplies a path).</p>
 */
public class SafetyBackupStoreTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File filesDir;
    private SafetyBackupStore store;

    @Before
    public void setUp() throws IOException {
        filesDir = folder.newFolder("files");
        store = new SafetyBackupStore(new File(filesDir, SafetyBackupStore.DIRECTORY));
    }

    @Test
    public void writesIntoItsOwnDirectoryUnderFilesDir() throws IOException {
        byte[] data = "zip-bytes".getBytes(StandardCharsets.UTF_8);

        File written = store.write("dafan-epoch-1-to-2.zip", data);

        assertEquals(
            new File(filesDir, "safety-backups/dafan-epoch-1-to-2.zip").getPath(),
            written.getPath()
        );
        assertArrayEquals(data, Files.readAllBytes(written.toPath()));
        assertFalse(new File(filesDir, "uploads").exists());
        assertEquals(Arrays.asList("dafan-epoch-1-to-2.zip"), store.list());
    }

    @Test
    public void rejectsPathsAndForeignNames() {
        byte[] data = {1};
        for (String name : new String[] {"../escape.zip", "nested/dir.zip", "no-extension", "", "a\\b.zip"}) {
            try {
                store.write(name, data);
                assertTrue("should have rejected: " + name, false);
            } catch (IOException expected) {
                // expected
            }
        }
    }

    @Test
    public void rejectsEmptyOrOversizedContent() {
        try {
            store.write("empty.zip", new byte[0]);
            assertTrue(false);
        } catch (IOException expected) {
            // expected
        }
    }

    @Test
    public void overwritesTheSameNameAndListsSorted() throws IOException {
        store.write("b.zip", new byte[] {2});
        store.write("a.zip", new byte[] {1});
        store.write("b.zip", new byte[] {3});

        assertEquals(Arrays.asList("a.zip", "b.zip"), store.list());
        assertArrayEquals(new byte[] {3}, Files.readAllBytes(new File(store.directory(), "b.zip").toPath()));
    }

    @Test
    public void deletingEverythingLeavesNoDirectory() throws IOException {
        store.write("a.zip", new byte[] {1});

        store.deleteAll();

        assertFalse(store.directory().exists());
        assertTrue(store.list().isEmpty());
    }
}
