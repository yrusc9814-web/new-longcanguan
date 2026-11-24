package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Unit tests for the durable, one-shot removal notice.
 *
 * <p>The record must survive the {@code localStorage}/uploads purge and must never be produced from
 * corrupt content, because the UI treats it as proof of a completed revocation.</p>
 */
public class MemberRemovedNoticeStoreTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private File securityDir;
    private MemberRemovedNoticeStore store;

    @Before
    public void setUp() throws IOException {
        securityDir = folder.newFolder("no_backup", "security");
        store = new MemberRemovedNoticeStore(new File(securityDir, "member-removed-notice.json"));
    }

    @Test
    public void roundTripsIdentityAndWipedAt() throws IOException {
        store.write("hh-1", "m-1", "2026-03-04T05:06:07.000Z");

        Map<String, Object> notice = store.read();

        assertEquals(1, ((Double) notice.get("version")).intValue());
        assertEquals("hh-1", notice.get("householdId"));
        assertEquals("m-1", notice.get("memberId"));
        assertEquals("2026-03-04T05:06:07.000Z", notice.get("wipedAt"));
    }

    @Test
    public void nullIdentityIsKeptAsNull() throws IOException {
        store.write(null, null, "2026-03-04T05:06:07.000Z");

        Map<String, Object> notice = store.read();

        assertTrue(notice.containsKey("householdId"));
        assertNull(notice.get("householdId"));
        assertNull(notice.get("memberId"));
    }

    @Test
    public void consumeDeletesSoTheNoticeOnlyAppearsOnce() throws IOException {
        store.write("hh", "m", "2026-03-04T05:06:07.000Z");

        assertEquals("hh", store.consume().get("householdId"));
        assertNull(store.consume());
        assertNull(store.read());
    }

    @Test
    public void missingFileReadsAsNoNotice() {
        assertNull(store.read());
        assertNull(store.consume());
    }

    @Test
    public void corruptOrForeignContentReadsAsNoNotice() throws IOException {
        File file = new File(securityDir, "member-removed-notice.json");
        write(file, "{not json");
        assertNull(store.read());

        write(file, "{\"version\":0,\"wipedAt\":\"x\"}");
        assertNull(store.read());

        write(file, "{\"version\":1}");
        assertNull(store.read());

        write(file, "{\"version\":1,\"wipedAt\":\"\"}");
        assertNull(store.read());

        write(file, "[1,2,3]");
        assertNull(store.read());

        write(file, "{\"version\":1,\"wipedAt\":\"ok\",\"extra\":{\"nested\":1}}");
        assertNull(store.read());
    }

    @Test
    public void escapesQuotesAndControlCharacters() {
        assertEquals("\"a\\\"b\"", MemberRemovedNoticeStore.quote("a\"b"));
        assertEquals("\"a\\\\b\"", MemberRemovedNoticeStore.quote("a\\b"));
        assertEquals("null", MemberRemovedNoticeStore.quote(null));
    }

    private static void write(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }
}
