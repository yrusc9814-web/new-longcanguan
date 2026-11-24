package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Unit tests for the fixed-root physical erasure used by {@code LOCKED_PENDING_WIPE}.
 *
 * <p>Only the two roots handed in by the constructor are touched; every assertion is about what is
 * confirmed absent afterwards, because that is what decides whether the gate may be released.</p>
 */
public class LocalDataPurgeTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File databaseDir;
    private File filesDir;
    private LocalDataPurge purge;

    @Before
    public void setUp() throws IOException {
        databaseDir = folder.newFolder("databases");
        filesDir = folder.newFolder("files");
        purge = new LocalDataPurge(databaseDir, filesDir);
    }

    private static void write(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    private void createFullLayout() throws IOException {
        write(new File(databaseDir, "dafanSQLite.db"), "db");
        write(new File(databaseDir, "dafanSQLite.db-wal"), "wal");
        write(new File(databaseDir, "dafanSQLite.db-shm"), "shm");
        write(new File(filesDir, "uploads/main/a.webp"), "main");
        write(new File(filesDir, "uploads/thumb/a.webp"), "thumb");
        write(new File(filesDir, "uploads-restore/staged/b.webp"), "staged");
        write(new File(filesDir, "uploads-restore/marker"), "1");
        write(new File(filesDir, "safety-backups/dafan-epoch-1-to-2.zip"), "zip");
        // Unrelated private data must survive: the purge is not a factory reset.
        write(new File(filesDir, "unrelated.txt"), "keep");
        write(new File(databaseDir, "another.db"), "keep");
        write(new File(filesDir, "security/gate-state.txt"), "keep");
    }

    @Test
    public void removesDatabaseFilesAndBothUploadTrees() throws IOException {
        createFullLayout();

        LocalDataPurge.PurgeReport report = purge.run();

        assertTrue(report.complete());
        assertTrue(report.databaseRemoved());
        assertTrue(report.uploadsRemoved());
        assertTrue(report.restoreRemoved());
        assertTrue(report.safetyBackupsRemoved());
        assertTrue(report.failed().isEmpty());
        assertFalse(new File(databaseDir, "dafanSQLite.db").exists());
        assertFalse(new File(databaseDir, "dafanSQLite.db-wal").exists());
        assertFalse(new File(databaseDir, "dafanSQLite.db-shm").exists());
        assertFalse(new File(filesDir, "uploads").exists());
        assertFalse(new File(filesDir, "uploads-restore").exists());
        assertFalse(new File(filesDir, "safety-backups").exists());
    }

    @Test
    public void keepsTheDurableRemovalNoticeOutsideThePurgeTargets() throws IOException {
        createFullLayout();
        File notice = new File(filesDir.getParentFile(), "no_backup/security/member-removed-notice.json");
        write(notice, "{\"version\":1,\"wipedAt\":\"2026-03-04T05:06:07.000Z\"}");

        purge.run();

        // The notice lives in no_backup/, not FilesDir: a complete purge must not erase it.
        assertTrue(notice.isFile());
    }

    @Test
    public void keepsUnrelatedFilesOutsideTheFixedTargets() throws IOException {
        createFullLayout();

        purge.run();

        assertTrue(new File(filesDir, "unrelated.txt").isFile());
        assertTrue(new File(databaseDir, "another.db").isFile());
        assertTrue(new File(filesDir, "security/gate-state.txt").isFile());
    }

    @Test
    public void isIdempotentWhenNothingIsLeft() {
        LocalDataPurge.PurgeReport report = purge.run();

        assertTrue(report.complete());
        assertTrue(report.failed().isEmpty());
        assertTrue(purge.run().complete());
    }

    @Test
    public void deletesJournalSiblingOfTheDatabase() throws IOException {
        write(new File(databaseDir, "dafanSQLite.db-journal"), "journal");

        assertTrue(purge.run().databaseRemoved());
        assertFalse(new File(databaseDir, "dafanSQLite.db-journal").exists());
    }

    @Test
    public void nestedEmptyDirectoriesAreRemovedRecursively() throws IOException {
        File deep = new File(filesDir, "uploads/a/b/c/d");
        assertTrue(deep.mkdirs());
        write(new File(deep, "x.webp"), "x");

        assertTrue(purge.run().complete());
        assertFalse(new File(filesDir, "uploads").exists());
    }

    @Test
    public void clearsOnlyWebViewProfileAndCacheOnColdStart() throws IOException {
        File data = folder.newFolder("app-data");
        File cache = new File(data, "cache");
        File local = new File(data, "app_webview/Default/Local Storage/leveldb/000003.log");
        File session = new File(data, "app_webview/Default/Session Storage/000003.log");
        File cached = new File(cache, "WebView/Default/cache-entry");
        File gate = new File(data, "no_backup/security/gate-state.txt");
        File unrelated = new File(cache, "unrelated");
        for (File file : new File[] { local, session, cached, gate, unrelated }) write(file, "test");

        assertTrue(LocalDataPurge.purgeWebViewProfile(data, cache));
        assertFalse(new File(data, "app_webview").exists());
        assertFalse(new File(cache, "WebView").exists());
        assertTrue(gate.isFile());
        assertTrue(unrelated.isFile());
        assertTrue(LocalDataPurge.purgeWebViewProfile(data, cache));
    }

    @Test
    public void completenessRequiresEveryTargetToBeAbsent() {
        // The report is the only signal the JS side trusts before unlocking the gate.
        assertTrue(new LocalDataPurge.PurgeReport(true, true, true, true, java.util.Collections.emptyList()).complete());
        assertFalse(new LocalDataPurge.PurgeReport(false, true, true, true, java.util.Arrays.asList("dafanSQLite.db")).complete());
        assertFalse(new LocalDataPurge.PurgeReport(true, false, true, true, java.util.Arrays.asList("uploads")).complete());
        assertFalse(new LocalDataPurge.PurgeReport(true, true, false, true, java.util.Arrays.asList("uploads-restore")).complete());
        assertFalse(new LocalDataPurge.PurgeReport(true, true, true, false, java.util.Arrays.asList("safety-backups")).complete());
    }
}
