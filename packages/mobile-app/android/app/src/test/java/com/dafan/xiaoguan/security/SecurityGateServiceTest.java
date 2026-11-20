package com.dafan.xiaoguan.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Before;
import org.junit.Test;

public class SecurityGateServiceTest {

    private FakeGatePersistence gatePersistence;
    private FakeTokenStorage tokenStorage;
    private SecurityGateService service;

    @Before
    public void setUp() {
        gatePersistence = new FakeGatePersistence();
        tokenStorage = new FakeTokenStorage();
        service = new SecurityGateService(
            new GateStore(gatePersistence),
            new MemberTokenStore(tokenStorage)
        );
    }

    @Test
    public void getGateStateReturnsTheNormalizedState() {
        assertEquals(new GateState(false, false, false), service.getGateState());
    }

    @Test
    public void setGateStateAppliesPartialUpdates() throws Exception {
        service.setGateState(null, true, null);
        GateState state = service.setGateState(null, null, true);

        assertTrue(state.pinRequired());
        assertTrue(state.pinUnlocked());
        assertFalse(state.lockedPendingWipe());
    }

    @Test
    public void pendingWipeForcesTheGateClosed() throws Exception {
        service.setGateState(null, true, true);

        GateState state = service.setGateState(true, null, null);

        assertTrue(state.lockedPendingWipe());
        assertFalse(state.pinUnlocked());
    }

    @Test
    public void unlockWithoutPinRequirementIsIgnored() throws Exception {
        GateState state = service.setGateState(null, false, true);

        assertFalse(state.pinUnlocked());
    }

    @Test
    public void pendingWipeErasesTheStoredToken() throws Exception {
        service.setMemberToken("member-token-abc");
        assertEquals("member-token-abc", service.getMemberToken());

        service.setGateState(true, true, null);

        assertNull(service.getMemberToken());
        assertFalse(tokenStorage.exists());
    }

    @Test
    public void tokenRoundTripAndClear() throws Exception {
        assertNull(service.getMemberToken());

        service.setMemberToken("member-token-abc");
        assertEquals("member-token-abc", service.getMemberToken());

        service.clearMemberToken();
        assertNull(service.getMemberToken());
    }

    @Test
    public void blankTokenIsRejected() {
        try {
            service.setMemberToken("  ");
            fail("blank token must be rejected");
        } catch (SecurityPersistenceException ex) {
            // Wrapping the validation failure is acceptable; storage must stay empty.
        } catch (IllegalArgumentException ex) {
            // Preferred: validation happens before any storage write.
        }
        assertFalse(tokenStorage.exists());
    }

    @Test
    public void failedWipeMarkerKeepsTheGateClosedAndKeepsTheToken() throws Exception {
        service.setMemberToken("member-token-abc");
        gatePersistence.failWrites = true;

        try {
            service.setGateState(true, true, null);
            fail("unsaved wipe must surface");
        } catch (SecurityPersistenceException expected) {
            assertTrue(service.getGateState().lockedPendingWipe());
            assertFalse(service.getGateState().pinUnlocked());
            assertNull(service.getMemberToken());
            assertTrue(tokenStorage.exists());
        }
    }

    @Test
    public void pendingWipeRejectsNewTokensUntilTheGateIsCleared() throws Exception {
        service.setGateState(true, null, null);
        try {
            service.setMemberToken("member-token-abc");
            fail("revoked member must not store a token");
        } catch (SecurityPersistenceException expected) {
            assertFalse(tokenStorage.exists());
        }
        service.setGateState(false, null, null);
        service.setMemberToken("member-token-abc");
        assertEquals("member-token-abc", service.getMemberToken());
    }

    @Test
    public void restartRestoresALockedGate() throws Exception {
        service.setGateState(null, true, true);

        SecurityGateService restarted = new SecurityGateService(
            new GateStore(gatePersistence),
            new MemberTokenStore(tokenStorage)
        );

        assertTrue(restarted.getGateState().pinRequired());
        assertFalse(restarted.getGateState().pinUnlocked());
    }

    private static final class FakeGatePersistence implements GateStore.Persistence {
        private GateState state;
        private boolean failWrites;

        @Override
        public GateState read() {
            return state;
        }

        @Override
        public void write(GateState state) {
            if (failWrites) throw new IllegalStateException("disk failure");
            this.state = state;
        }
    }

    private static final class FakeTokenStorage implements MemberTokenStorage {
        private String value;

        @Override
        public String read() {
            return value;
        }

        @Override
        public void write(String token) {
            value = token;
        }

        @Override
        public void clear() {
            value = null;
        }

        @Override
        public boolean exists() {
            return value != null;
        }
    }
}
