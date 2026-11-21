package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class GateStoreTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private FileGatePersistence persistence() throws IOException {
        return new FileGatePersistence(new File(folder.newFolder("security"), "gate-state.txt"));
    }

    @Test
    public void defaultsToClosedStateWithoutPersistedRecord() throws Exception {
        GateState state = new GateStore(persistence()).get();

        assertEquals(new GateState(false, false, false), state);
    }

    @Test
    public void persistsOnlyWipeAndPinFlags() throws Exception {
        FileGatePersistence persistence = persistence();
        GateStore store = new GateStore(persistence);

        store.update(null, true, true);

        GateState reloaded = new GateStore(persistence).get();
        assertFalse(reloaded.lockedPendingWipe());
        assertTrue(reloaded.pinRequired());
        // Unlocked is process-scoped: a restart is locked again.
        assertFalse(reloaded.pinUnlocked());
    }

    @Test
    public void expiredPinSessionLocksNativeReads() throws Exception {
        GateStore store = new GateStore(persistence());
        assertTrue(store.update(null, true, true, Long.MAX_VALUE).pinUnlocked());
        store.update(null, true, true, 1L);
        assertTrue(store.get().pinRequired());
        assertFalse(store.get().pinUnlocked());
    }

    @Test
    public void pendingWipeSurvivesReloadAndLocksGate() throws Exception {
        FileGatePersistence persistence = persistence();
        GateStore store = new GateStore(persistence);
        store.update(null, true, true);

        GateState wiped = store.update(true, null, null);
        assertTrue(wiped.lockedPendingWipe());
        assertFalse(wiped.pinUnlocked());

        GateStore reloaded = new GateStore(persistence);
        assertTrue(reloaded.get().lockedPendingWipe());
        assertFalse(reloaded.get().pinUnlocked());
    }

    @Test
    public void unlockIsRejectedWhilePinIsNotRequired() throws Exception {
        GateStore store = new GateStore(persistence());

        GateState state = store.update(null, false, true);

        assertFalse(state.pinUnlocked());
    }

    @Test
    public void unlockIsRejectedWhenWipeIsPending() throws Exception {
        GateStore store = new GateStore(persistence());
        store.update(null, true, false);

        GateState state = store.update(true, null, true);

        assertTrue(state.lockedPendingWipe());
        assertFalse(state.pinUnlocked());
    }

    @Test
    public void failedPersistenceNeverOpensTheGate() throws Exception {
        GateStore.Persistence broken = new GateStore.Persistence() {
            @Override
            public GateState read() {
                return null;
            }

            @Override
            public void write(GateState state) {
                throw new IllegalStateException("disk full");
            }
        };
        GateStore store = new GateStore(broken);

        try {
            store.update(true, true, false);
            fail("write failure must surface");
        } catch (SecurityPersistenceException expected) {
            // expected
        }

        assertTrue(store.get().lockedPendingWipe());
        assertFalse(store.get().pinUnlocked());
        assertFalse(store.isPersistedStateCurrent());
    }

    @Test
    public void corruptPersistedRecordFailsClosed() throws Exception {
        File dir = folder.newFolder("security");
        File record = new File(dir, "gate-state.txt");
        try (FileOutputStream out = new FileOutputStream(record)) {
            out.write("garbage".getBytes(StandardCharsets.UTF_8));
        }

        GateState state = new GateStore(new FileGatePersistence(record)).get();

        assertTrue(state.lockedPendingWipe());
        assertTrue(state.pinRequired());
        assertFalse(state.pinUnlocked());
    }

    @Test
    public void lockDropsTheUnlockWithoutTouchingDurableFlags() throws Exception {
        FileGatePersistence persistence = persistence();
        GateStore store = new GateStore(persistence);
        store.update(null, true, true);
        assertTrue(store.get().pinUnlocked());

        GateState locked = store.lock();

        assertFalse(locked.pinUnlocked());
        assertTrue(locked.pinRequired());
        assertFalse(locked.lockedPendingWipe());
        // No disk write is involved: a reload still only sees the durable flags.
        GateState reloaded = new GateStore(persistence).get();
        assertTrue(reloaded.pinRequired());
        assertFalse(reloaded.pinUnlocked());
        assertFalse(reloaded.lockedPendingWipe());
    }

    @Test
    public void concurrentUpdatesLeaveAReadableRecord() throws Exception {
        FileGatePersistence persistence = persistence();
        final GateStore store = new GateStore(persistence);
        final int threads = 8;
        Thread[] workers = new Thread[threads];
        for (int i = 0; i < threads; i++) {
            final boolean pinRequired = i % 2 == 0;
            workers[i] = new Thread(() -> {
                try {
                    store.update(null, pinRequired, null);
                } catch (SecurityPersistenceException ex) {
                    throw new IllegalStateException(ex);
                }
            });
        }
        for (Thread worker : workers) worker.start();
        for (Thread worker : workers) worker.join();

        // The last writer wins, but the record itself must always be a complete, parseable state.
        GateState reloaded = new GateStore(persistence).get();
        assertEquals(store.get().pinRequired(), reloaded.pinRequired());
        assertFalse(reloaded.pinUnlocked());
    }
}
