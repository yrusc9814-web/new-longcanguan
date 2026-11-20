package com.dafan.xiaoguan.security;

/**
 * Pure-Java implementation of the {@code AppSecurity} contract.
 *
 * <p>Kept free of Android and Capacitor types so the whole behaviour can be unit tested: partial gate
 * updates, process-scoped unlock, fail-closed persistence, token storage validation and token
 * erasure on wipe.</p>
 *
 * <p>A pending wipe is a revocation: the wipe marker is persisted first (atomically, synchronously)
 * and the member token is then erased, so no credential survives a revoked member. If the marker
 * cannot be persisted the call fails and the in-memory gate stays closed.</p>
 */
public final class SecurityGateService {

    private final GateStore gateStore;
    private final MemberTokenStore tokenStore;

    public SecurityGateService(GateStore gateStore, MemberTokenStore tokenStore) {
        this.gateStore = gateStore;
        this.tokenStore = tokenStore;
    }

    public GateState getGateState() {
        return gateStore.get();
    }

    /**
     * Applies a partial gate update.
     *
     * @param lockedPendingWipe {@code null} keeps the current value
     * @param pinRequired {@code null} keeps the current value
     * @param pinUnlocked {@code null} keeps the current value
     */
    public synchronized GateState setGateState(Boolean lockedPendingWipe, Boolean pinRequired, Boolean pinUnlocked)
        throws SecurityPersistenceException {
        if (Boolean.FALSE.equals(lockedPendingWipe) && gateStore.get().lockedPendingWipe()) {
            tokenStore.clear();
        }
        GateState next = gateStore.update(lockedPendingWipe, pinRequired, pinUnlocked);
        if (next.lockedPendingWipe() && Boolean.TRUE.equals(lockedPendingWipe)) {
            tokenStore.clear();
        }
        return next;
    }

    public synchronized String getMemberToken() throws SecurityPersistenceException {
        return gateStore.get().lockedPendingWipe() ? null : tokenStore.read();
    }

    public synchronized void setMemberToken(String memberToken) throws SecurityPersistenceException {
        if (gateStore.get().lockedPendingWipe()) {
            throw new SecurityPersistenceException("The device is pending wipe");
        }
        tokenStore.write(memberToken);
    }

    public synchronized void clearMemberToken() throws SecurityPersistenceException {
        tokenStore.clear();
    }
}
