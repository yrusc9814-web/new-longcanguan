package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Before;
import org.junit.Test;

public class MemberTokenStoreTest {

    private FakeStorage storage;
    private MemberTokenStore store;

    @Before
    public void setUp() {
        storage = new FakeStorage();
        store = new MemberTokenStore(storage);
    }

    @Test
    public void roundTripsToken() throws Exception {
        store.write("member-token-abc");

        assertEquals("member-token-abc", store.read());
        assertTrue(storage.exists());
    }

    @Test
    public void readsNullWhenNothingStored() throws Exception {
        assertNull(store.read());
    }

    @Test
    public void rejectsBlankOrOversizedTokensBeforeWriting() throws Exception {
        for (String candidate : new String[] { null, "", "   ", "line\nbreak" }) {
            try {
                store.write(candidate);
                fail("expected rejection for " + candidate);
            } catch (IllegalArgumentException expected) {
                assertFalse("storage must stay untouched", storage.exists());
            }
        }

        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 5000; i++) huge.append('a');
        try {
            store.write(huge.toString());
            fail("oversized token must be rejected");
        } catch (IllegalArgumentException expected) {
            assertFalse(storage.exists());
        }
    }

    @Test
    public void clearRemovesTheRecord() throws Exception {
        store.write("member-token-abc");
        store.clear();

        assertNull(store.read());
        assertFalse(storage.exists());
    }

    @Test
    public void clearReportsFailureWhenRecordSurvives() throws Exception {
        store.write("member-token-abc");
        storage.stubborn = true;

        try {
            store.clear();
            fail("a surviving record must not be reported as cleared");
        } catch (SecurityPersistenceException expected) {
            assertTrue(storage.exists());
        }
    }

    @Test
    public void writeFailureIsReported() {
        storage.failWrites = true;

        try {
            store.write("member-token-abc");
            fail("write failure must surface");
        } catch (SecurityPersistenceException expected) {
            assertFalse(storage.exists());
        }
    }

    @Test
    public void readFailureIsReported() {
        storage.failReads = true;

        try {
            store.read();
            fail("read failure must surface");
        } catch (SecurityPersistenceException expected) {
            assertNull(storage.value);
        }
    }

    private static final class FakeStorage implements MemberTokenStorage {
        private String value;
        private boolean failWrites;
        private boolean failReads;
        private boolean stubborn;

        @Override
        public String read() throws Exception {
            if (failReads) throw new IllegalStateException("read failure");
            return value;
        }

        @Override
        public void write(String token) throws Exception {
            if (failWrites) throw new IllegalStateException("write failure");
            value = token;
        }

        @Override
        public void clear() {
            if (!stubborn) value = null;
        }

        @Override
        public boolean exists() {
            return value != null;
        }
    }
}
