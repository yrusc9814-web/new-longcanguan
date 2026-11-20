package com.dafan.xiaoguan.security;

import java.util.Objects;

/**
 * Immutable snapshot of the local security gate.
 *
 * <p>The state is deliberately small: whether the member was revoked and a wipe is pending, whether
 * a local PIN is required, and whether the current process has unlocked that PIN. The unlocked flag
 * is never persisted; a process restart always restores a locked gate.</p>
 */
public final class GateState {

    private final boolean lockedPendingWipe;
    private final boolean pinRequired;
    private final boolean pinUnlocked;

    public GateState(boolean lockedPendingWipe, boolean pinRequired, boolean pinUnlocked) {
        this.lockedPendingWipe = lockedPendingWipe;
        this.pinRequired = pinRequired;
        this.pinUnlocked = pinUnlocked;
    }

    /**
     * Applies the gate invariants:
     * <ul>
     *     <li>a pending wipe always locks the gate;</li>
     *     <li>without PIN protection the gate can never be "unlocked" in a meaningful way.</li>
     * </ul>
     */
    public static GateState normalized(boolean lockedPendingWipe, boolean pinRequired, boolean pinUnlocked) {
        boolean unlocked = pinUnlocked && pinRequired && !lockedPendingWipe;
        return new GateState(lockedPendingWipe, pinRequired, unlocked);
    }

    public boolean lockedPendingWipe() {
        return lockedPendingWipe;
    }

    public boolean pinRequired() {
        return pinRequired;
    }

    public boolean pinUnlocked() {
        return pinUnlocked;
    }

    /** State used when persisted security data cannot be read: deny access instead of downgrading. */
    public static GateState failClosed() {
        return new GateState(true, true, false);
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof GateState)) return false;
        GateState that = (GateState) other;
        return lockedPendingWipe == that.lockedPendingWipe
            && pinRequired == that.pinRequired
            && pinUnlocked == that.pinUnlocked;
    }

    @Override
    public int hashCode() {
        return Objects.hash(lockedPendingWipe, pinRequired, pinUnlocked);
    }

    @Override
    public String toString() {
        return "GateState{lockedPendingWipe=" + lockedPendingWipe + ", pinRequired=" + pinRequired + ", pinUnlocked=" + pinUnlocked + '}';
    }
}
