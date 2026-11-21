package com.dafan.xiaoguan.security;

/**
 * Process-wide, thread-safe holder of {@link GateState}.
 *
 * <p>Only {@code lockedPendingWipe} and {@code pinRequired} are durable. The unlocked flag lives in
 * memory only, so a process restart (including a WebView process restart) always comes back locked.
 * Writes are synchronous and atomic through {@link Persistence}; a failed write never turns a closed
 * gate into an open one.</p>
 */
public final class GateStore {

    /** Durable backing store. Implementations must be atomic and synchronous. */
    public interface Persistence {
        /** Returns the persisted state, or {@code null} when nothing was stored yet. */
        GateState read() throws Exception;

        void write(GateState state) throws Exception;
    }

    private final Persistence persistence;
    private final Object lock = new Object();

    private GateState state;
    private GateState persistedState;
    private boolean needsPersist;
    private long pinExpiresAt;

    public GateStore(Persistence persistence) {
        this.persistence = persistence;
        GateState loaded = null;
        boolean loadFailed = false;
        try {
            loaded = persistence.read();
        } catch (Exception ex) {
            loadFailed = true;
        }

        if (loadFailed) {
            // Corrupt or unreadable security data must never downgrade the gate.
            this.state = GateState.failClosed();
            this.persistedState = null;
            this.needsPersist = true;
            return;
        }
        if (loaded == null) {
            loaded = new GateState(false, false, false);
        }
        // A process restart always restores a locked gate.
        this.state = GateState.normalized(loaded.lockedPendingWipe(), loaded.pinRequired(), false);
        this.persistedState = loaded;
        this.needsPersist = false;
    }

    public GateState get() {
        synchronized (lock) {
            expireUnlock();
            return state;
        }
    }

    private void expireUnlock() {
        if (state.pinUnlocked() && pinExpiresAt > 0 && System.currentTimeMillis() >= pinExpiresAt) {
            state = GateState.normalized(state.lockedPendingWipe(), state.pinRequired(), false);
            pinExpiresAt = 0;
        }
    }

    /**
     * Applies a partial update and returns the resulting state.
     *
     * <p>A {@code null} argument keeps the current value. When a wipe marker is requested but cannot
     * be persisted, the in-memory gate is still forced closed before the exception propagates.</p>
     */
    public GateState update(Boolean lockedPendingWipe, Boolean pinRequired, Boolean pinUnlocked)
        throws SecurityPersistenceException {
        return update(lockedPendingWipe, pinRequired, pinUnlocked, null);
    }

    public GateState update(Boolean lockedPendingWipe, Boolean pinRequired, Boolean pinUnlocked, Long expiresAt)
        throws SecurityPersistenceException {
        synchronized (lock) {
            expireUnlock();
            GateState next = GateState.normalized(
                lockedPendingWipe == null ? state.lockedPendingWipe() : lockedPendingWipe.booleanValue(),
                pinRequired == null ? state.pinRequired() : pinRequired.booleanValue(),
                pinUnlocked == null ? state.pinUnlocked() : pinUnlocked.booleanValue()
            );

            if (needsPersist || next.lockedPendingWipe() != state.lockedPendingWipe() || next.pinRequired() != state.pinRequired()) {
                try {
                    persistence.write(next);
                } catch (Exception ex) {
                    if (next.lockedPendingWipe() || next.pinRequired()) {
                        state = GateState.normalized(state.lockedPendingWipe() || next.lockedPendingWipe(), next.pinRequired(), false);
                        pinExpiresAt = 0;
                        needsPersist = true;
                    }
                    throw new SecurityPersistenceException("Unable to persist the local security gate", ex);
                }
                persistedState = next;
                needsPersist = false;
            }

            state = next;
            if (expiresAt != null) pinExpiresAt = expiresAt;
            if (!state.pinUnlocked()) pinExpiresAt = 0;
            expireUnlock();
            return state;
        }
    }

    boolean isPersistedStateCurrent() {
        synchronized (lock) {
            // Only the durable flags are compared: the unlock flag is never persisted.
            return !needsPersist
                && persistedState != null
                && persistedState.lockedPendingWipe() == state.lockedPendingWipe()
                && persistedState.pinRequired() == state.pinRequired();
        }
    }

    /**
     * Drops the process-scoped unlock without touching storage.
     *
     * <p>On a page reload a fresh document must re-prove the PIN even though the process (and the
     * Keystore key) is still alive. No write is needed: the unlocked flag is never durable.</p>
     */
    public GateState lock() {
        synchronized (lock) {
            state = GateState.normalized(state.lockedPendingWipe(), state.pinRequired(), false);
            pinExpiresAt = 0;
            return state;
        }
    }
}
